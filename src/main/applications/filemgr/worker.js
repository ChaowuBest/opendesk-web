/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

/**
 * 关键并发不变式（Concurrency invariant）
 * ---------------------------------------
 * 所有"大粒度操作"——scan、applicationConfigChanged、_rebuildAndRestart、
 * _restartScanners、initialize、finalize、resetFileSystemStorage——都必须通过
 * `runSequentially`（即 BaseWorker.taskQueue, concurrency=1）排队。
 *
 * 这是模块内多个看似 fragile 的设计能成立的唯一原因：
 *
 * 1. `scanner.stop()` 只设 `_stopped` 标志位，**不 drain 在跑的 scan**。
 *    rebuild 删旧 storage 时不会撞上 in-flight scan 写数据，是因为 rebuild
 *    本身排在 scan 任务之后进队列，必然等 scan 任务交还队列槽位才轮到。
 *
 * 2. `storage.saveFiles` 只写 BaseIndexer，不并发调 embedding API；
 *    两个 scanner 永远不会并发跑 saveFiles，靠的是外层 taskQueue 串行化。
 *
 * 直接调 `scanner.scan()`、`storage.saveFiles()`、`scanner.stop()` 会绕过
 * 这层串行化保护——仅在测试场景下、明确无并发干扰时使用。
 */

import { CODES, FileEntrySchema, FSStorage, RebuildRequiredError, SCAN_INTERVAL_MS, WARNINGS } from './storage.js';
import { logger } from '../../utils/logger.js';
import { BaseWorker } from '../base';
import fastGlob from 'fast-glob';
import lockfile from 'proper-lockfile';
import path from 'path';
import fs from 'fs';

const MAX_RECENT_FAILURES = 20;

const FILEMGR_SCANNING_ENABLED = true;
const UNAVAILABLE_THRESHOLD = 50;

function normalizeSearchArgs(query, topK) {
    return {
        query: typeof query === 'string' ? query : '',
        topK: Math.max(1, Math.min(Number(topK) || 20, 100))
    };
}

class FSScanner {
    /**
     * @param {object} entry - FSEntry config
     * @param {FSStorage} storage
     * @param {string} root
     * @param {object} state - reference to scannerState.roots[root]
     * @param {{ onRebuildRequired?: (reason: string) => void, workerRef?: object }} [callbacks]
     */
    constructor(entry, storage, root, state, { onRebuildRequired, workerRef } = {}) {
        this.entry = entry;
        this.root = root;
        this.storage = storage;
        this.state = state;
        this._stopped = true;
        this._scheduledTimeout = null;
        this._counter = 0;
        this._onRebuildRequired = onRebuildRequired;
        this._workerRef = workerRef ?? null;
        /** @type {Array<{path: string, error: string}>} */
        this._recentFailures = [];
    }

    isRunning() {
        return !this._stopped;
    }

    async start(taskQueue) {
        if (!this._stopped || this._scheduledTimeout !== null) {
            await this.stop();
        }

        this._stopped = false;
        this._counter = 0;

        const scanTask = async () => {
            if (this._stopped) return;

            // Clear the pending flag now that the scan task is running
            if (this._workerRef) this._workerRef._scanPending = false;

            try {
                await this.scan();
            } catch (err) {
                if (err instanceof RebuildRequiredError && this._onRebuildRequired) {
                    // Don't await — _rebuildAndRestart queues on the same taskQueue
                    // (concurrency=1), awaiting would deadlock
                    this._onRebuildRequired(err.reason);
                    return;
                }
                logger.error(`[filemgr] scan error for ${this.root}: ${err.message}`, err);
            }

            if (this._stopped) return;

            this._counter++;
            this._scheduledTimeout = setTimeout(() => {
                if (!this._stopped) {
                    if (this._workerRef) this._workerRef._scanPending = true;
                    taskQueue.add(scanTask);
                }
            }, SCAN_INTERVAL_MS);
        };

        taskQueue.add(scanTask);
    }

    async stop() {
        this._stopped = true;
        if (this._scheduledTimeout) {
            clearTimeout(this._scheduledTimeout);
            this._scheduledTimeout = null;
        }
    }

    _getScanDepth() {
        if (this.storage.scannerState.unavailable_roots?.[this.root]) {
            return undefined;
        }
        if (this.state.last_full_scan === 0) {
            return undefined;
        }
        const counter = this._counter;
        if (counter % 32 === 0) return undefined;
        if (counter % 16 === 0) return 10;
        if (counter % 8 === 0) return 8;
        if (counter % 4 === 0) return 6;
        return 4;
    }

    /**
     * @param {import('fast-glob').Entry} file
     * @returns {import('zod').infer<typeof FileEntrySchema>}
     */
    _convertToFileEntry(file) {
        return FileEntrySchema.parse({
            path: file.path,
            filename: file.name,
            size: file.stats.size,
            modified: file.stats.mtimeMs,
            created: file.stats.birthtimeMs,
            accessed: file.stats.atimeMs,
            type: file.stats.isDirectory() ? 'directory' : 'file'
        });
    }

    _isFileUpdated(file, lastScanningTime) {
        return file.stats.mtimeMs > lastScanningTime;
    }

    async scan() {
        // 1. Check deferred state
        if (this.storage.isDeferred()) {
            await this.storage.initialize();
            if (this.storage.isDeferred()) return;
        }

        // 2. Sync embedding mode (handles model changes, additions, removals)
        await this.storage.syncEmbeddingMode('scan');

        // 3. Main scan loop
        const deep = this._getScanDepth();
        const isFullScan = deep === undefined;
        const lastScanningTime = this.state.last_full_scan;

        const stream = fastGlob.stream(this.entry.include_patterns, {
            cwd: this.root,
            deep: deep,
            dot: false,
            stats: true,
            objectMode: true,
            suppressErrors: true,
            followSymbolicLinks: false,
            absolute: true,
            caseSensitiveMatch: false,
            ignore: this.entry.exclude_patterns
        });

        let batch = [];
        let totalFiles = 0;
        let savedCount = 0;
        let failedCount = 0;
        const BATCH_SIZE = 500;
        const scannedPaths = isFullScan ? new Set() : null;

        // Clear recent failures at start of every scan, not just full scans (spec §11.3)
        this._recentFailures = [];

        for await (const entry of stream) {
            if (this._stopped) break;
            totalFiles++;
            if (scannedPaths) scannedPaths.add(entry.path);
            if (isFullScan || this._isFileUpdated(entry, lastScanningTime)) {
                batch.push(this._convertToFileEntry(entry));
            }
            if (batch.length >= BATCH_SIZE) {
                const result = await this.storage.saveFiles(batch, this.root);
                savedCount += result.saved;
                failedCount += result.failed;
                this._collectFailures(result.failures);
                batch = [];
            }
        }
        if (batch.length > 0) {
            const result = await this.storage.saveFiles(batch, this.root);
            savedCount += result.saved;
            failedCount += result.failed;
            this._collectFailures(result.failures);
        }

        // 5. Full scan: delete detection
        if (isFullScan && scannedPaths) {
            if (scannedPaths.size === 0) {
                const lastCount = this.state.last_file_count ?? 0;
                if (lastCount > UNAVAILABLE_THRESHOLD) {
                    this.storage.scannerState.unavailable_roots[this.root] = {
                        since: Date.now(),
                        last_count: lastCount
                    };
                    await this.storage.saveScannerState();
                    this.storage.onStateChanged?.();
                    return;
                }
            }
            delete this.storage.scannerState.unavailable_roots[this.root];
            await this.storage.removeDeletedFiles(this.root, scannedPaths);
        }

        // 6. Full scan: unconditional checkpoint
        if (isFullScan) {
            this.state.last_full_scan = Date.now();
            this.state.total_files = totalFiles;
            this.state.last_file_count = scannedPaths.size;
            await this.storage.saveScannerState();
        }

        logger.info(
            `[filemgr] scan ${this.root}: depth=${deep ?? 'full'}, ` +
                `total=${totalFiles}, saved=${savedCount}, failed=${failedCount}`
        );

        this._workerRef?.taskQueue.add(() => this.storage.processEmbeddingQueue(() => this._workerRef._scanPending));
    }

    /**
     * @param {Array<{path: string, error: string}>} failures
     */

    // embedding-stage failures surface via /fs-status pending_count + last_embedding_task_at.
    _collectFailures(failures) {
        if (!failures || failures.length === 0) return;
        this._recentFailures.push(...failures);
        if (this._recentFailures.length > MAX_RECENT_FAILURES) {
            this._recentFailures = this._recentFailures.slice(-MAX_RECENT_FAILURES);
        }
    }
}

class FileManagerWorker extends BaseWorker {
    constructor(bundleName, appDataDirectory) {
        super(bundleName, appDataDirectory);
        this.status = 'idle';
        /** @type {Map<string, FSScanner>} */
        this.scanners = new Map();
        /** @type {FSStorage | null} */
        this.storage = null;
        /** @type {boolean} */
        this._initializing = false;
        /** @type {object | null} */
        this._lastConfig = null;
        /** @type {boolean} */
        this._rebuildQueued = false;
        /** @type {Promise | null} */
        this._currentRebuildPromise = null;
        /** @type {boolean} — true when a scan task has been queued but not yet started */
        this._scanPending = false;
        this._readonlyMode = false;
        this._releaseScanLock = null;
    }

    async _acquireScanLock() {
        fs.mkdirSync(this.appDataDirectory, { recursive: true });
        const lockPath = path.join(this.appDataDirectory, 'scan.lock');
        fs.writeFileSync(lockPath, '', { flag: 'a' });
        try {
            this._releaseScanLock = await lockfile.lock(lockPath, { retries: 0 });
            return true;
        } catch (error) {
            logger.warn(`[filemgr] scan lock unavailable, entering query mode: ${error.message}`);
            return false;
        }
    }

    async _stopScanners() {
        for (const scanner of this.scanners.values()) {
            await scanner.stop().catch((err) => {
                logger.error(`[filemgr] stop scanner failed: ${err.message}`);
            });
        }
        this.scanners.clear();
    }

    _closeStorage() {
        try {
            this.storage?.storage?.close?.();
        } catch (error) {
            logger.warn(`[filemgr] close storage failed: ${error.message}`);
        } finally {
            this.storage = null;
        }
    }

    async _releaseScanLockIfHeld(context) {
        if (!this._releaseScanLock) return;
        const releaseScanLock = this._releaseScanLock;
        this._releaseScanLock = null;
        await releaseScanLock().catch((error) => {
            logger.warn(`[filemgr] release scan lock ${context} failed: ${error.message}`);
        });
    }

    async _teardownRuntime(context) {
        await this._stopScanners();
        this._closeStorage();
        await this._releaseScanLockIfHeld(context);
        this._readonlyMode = false;
        this.status = 'idle';
    }

    async initialize() {
        this._initializing = true;
        return this.runSequentially(async () => {
            try {
                if (this.storage || this._releaseScanLock || this.scanners.size > 0) {
                    logger.warn('[filemgr] initialize called while worker is active; recycling previous runtime state');
                    await this._teardownRuntime('before reinitialize');
                }

                this.storage = new FSStorage(this.appDataDirectory);
                this.storage.onStateChanged = () => this.callApp('noticeTUIStatusUpdate');

                if (!(await this._acquireScanLock())) {
                    this._readonlyMode = true;
                    await this.storage.initializeReadonly();
                    return;
                }

                this._readonlyMode = false;
                await this.storage.initialize();

                const filesystems = this.config?.entries;
                if (!filesystems || filesystems.length === 0) {
                    this.status = 'idle';
                    this._lastConfig = this.config;
                    return;
                }

                // Ensure scanner state roots exist for all configured entries
                for (const fsEntry of filesystems) {
                    if (!this.storage.scannerState.roots[fsEntry.root]) {
                        this.storage.scannerState.roots[fsEntry.root] = {
                            last_full_scan: 0,
                            total_files: 0,
                            last_file_count: 0
                        };
                    }
                }
                await this.storage.saveScannerState();

                await this._startScanners(filesystems);
                this.status = 'running';
                this._lastConfig = this.config;
            } finally {
                this._initializing = false;
            }
        }).catch(async (error) => {
            this._initializing = false;
            await this._teardownRuntime('after initialize error');
            logger.error(`[filemgr] initialize error: ${error.message}`, error);
            this.status = 'error';
        });
    }

    async finalize() {
        await this.runSequentially(async () => {
            await this._teardownRuntime('on finalize');
        }).catch((error) => {
            logger.error(`[filemgr] finalize error: ${error.message}`, error);
        });
    }

    /**
     * @param {object[]} filesystems
     */
    async _startScanners(filesystems) {
        if (!FILEMGR_SCANNING_ENABLED) {
            logger.info('[filemgr] scanning disabled — skip starting scanners');
            return;
        }
        const seen = new Set();
        const deduped = filesystems.filter((e) => {
            if (seen.has(e.root)) {
                logger.warn(`[filemgr] duplicate root ignored: ${e.root}`);
                return false;
            }
            seen.add(e.root);
            return true;
        });
        for (const fsEntry of deduped) {
            const root = fsEntry.root;
            const state = this.storage.scannerState.roots[root];

            const scanner = new FSScanner(fsEntry, this.storage, root, state, {
                onRebuildRequired: (reason) => this._rebuildAndRestart(reason),
                workerRef: this
            });
            this.scanners.set(root, scanner);
            await scanner.start(this.taskQueue);
        }
    }

    async _restartScanners() {
        for (const scanner of this.scanners.values()) {
            await scanner.stop().catch((err) => {
                logger.error(`[filemgr] stop scanner failed: ${err.message}`);
            });
        }
        this.scanners.clear();

        const filesystems = this.config?.entries;
        if (!filesystems || filesystems.length === 0) {
            this.status = 'idle';
            return;
        }

        await this._startScanners(filesystems);
        this.status = 'running';
    }

    /**
     * Returns a Promise (from runSequentially) so callers can optionally await.
     * - onRebuildRequired callback: does NOT await (fire-and-forget, avoids PQueue deadlock)
     * - resetFileSystemStorage: DOES await (entry.js needs to wait for completion)
     *
     * Dedup: _rebuildQueued flag stays true for the ENTIRE rebuild execution,
     * preventing overlapping triggers from multiple scanners.
     */
    _rebuildAndRestart(reason) {
        if (this._readonlyMode) {
            logger.warn(`[filemgr] readonly mode, skip rebuild: ${reason}`);
            return Promise.resolve();
        }
        if (this._rebuildQueued) {
            logger.info(`[filemgr] rebuild already queued, skipping: ${reason}`);
            return this._currentRebuildPromise ?? Promise.resolve();
        }
        this._rebuildQueued = true;

        this._currentRebuildPromise = this.runSequentially(async () => {
            try {
                logger.warn(`[filemgr] _rebuildAndRestart: ${reason}`);

                // 1. Stop all scanners
                for (const scanner of this.scanners.values()) {
                    await scanner.stop().catch((err) => {
                        logger.error(`[filemgr] stop scanner failed: ${err.message}`);
                    });
                }
                this.scanners.clear();

                // 2. Rebuild storage (build-then-swap)
                let rebuildOk = true;
                try {
                    await this.storage.rebuildAll(reason);
                } catch (err) {
                    rebuildOk = false;
                    if (err._postSwap) {
                        // Catastrophic: old storage already deleted, new init failed.
                        // storage is null. Scanners will see deferred state.
                        logger.error(`[filemgr] rebuild post-swap failure (storage lost): ${err.message}`);
                    } else {
                        // Pre-swap failure (probe or build): old storage preserved.
                        logger.warn(`[filemgr] rebuild failed (old storage preserved): ${err.message}`);
                    }
                }

                // 3. Restart scanners regardless — step 1 already stopped them
                await this._restartScanners();

                if (rebuildOk) {
                    logger.info(`[filemgr] rebuild succeeded, scanners restarted`);
                } else if (!this.storage.isDeferred()) {
                    logger.warn(`[filemgr] scanners restarted with old storage; ` + `next scan may re-trigger rebuild`);
                } else {
                    logger.error(`[filemgr] scanners restarted in deferred state; ` + `will retry on next scan cycle`);
                }
            } finally {
                this._rebuildQueued = false;
                this._currentRebuildPromise = null;
            }
        });
        return this._currentRebuildPromise;
    }

    async applicationConfigChanged(config) {
        await super.applicationConfigChanged(config);

        const oldConfig = this._lastConfig;
        this._lastConfig = config;

        if (this._readonlyMode) return;
        if (this._initializing) return;
        if (!this.storage || this.status === 'error') return;

        await this.runSequentially(async () => {
            // 1. Detach removed roots
            const oldRoots = new Set((oldConfig?.entries ?? []).map((e) => e.root));
            const newRoots = new Set((config?.entries ?? []).map((e) => e.root));

            for (const removed of oldRoots) {
                if (!newRoots.has(removed)) {
                    await this.storage._detachRoot(removed);
                }
            }

            // 2. Add new roots to scanner state
            for (const added of newRoots) {
                if (!oldRoots.has(added)) {
                    this.storage.scannerState.roots[added] = {
                        last_full_scan: 0,
                        total_files: 0,
                        last_file_count: 0
                    };
                }
            }
            await this.storage.saveScannerState();

            // 3. Restart scanners
            await this._restartScanners();

            // 4. Sync embedding mode (reads full Setting — may also pick up global model changes)
            await this.storage.syncEmbeddingMode('filemgr config changed');

            // 5. Always enqueue an embedding task (no-op in base-only)
            this.taskQueue.add(() => this.storage.processEmbeddingQueue(() => this._scanPending));
        });
    }

    // ── Worker API methods ──────────────────────────────────────────

    async getFileSystemStatus() {
        if (!this.storage) {
            return { status: 'idle' };
        }

        const storageStatus = await this.storage.getStatus();
        const scannerList = [...this.scanners.values()].map((scanner) => ({
            entry: scanner.entry,
            root: scanner.root,
            lastFullScan: scanner.state.last_full_scan,
            totalFiles: scanner.state.total_files,
            isRunning: scanner.isRunning(),
            recentFailures: scanner._recentFailures ?? []
        }));

        let status = this.status;

        if (this._readonlyMode) {
            status = 'readonly';
        }

        return {
            status,
            scanners: scannerList,
            storage: storageStatus,
            isDeferred: this.storage.isDeferred(),
            deferredReason: this.storage.deferredReason ?? null,
            probe_permanent_error: this.storage.scannerState.probe_permanent_error,
            last_rebuild_event: this.storage.scannerState.last_rebuild_event,
            unavailable_roots: this.storage.scannerState.unavailable_roots,
            readonly: this._readonlyMode ?? false
        };
    }

    async getStatus() {
        return { status: 'ok', data: await this.getFileSystemStatus() };
    }

    async searchFilesByKeyword(keyword) {
        if (!this.storage || this.storage.isDeferred()) {
            return [];
        }
        return await this.storage.searchFilesByKeyword(keyword);
    }

    /**
     * 在指定路径范围内搜索文件名包含关键词的文件
     * 用于 @ 文件补全，只搜索当前工作空间
     * @param {string} keyword - 搜索关键词
     * @param {string} basePath - 基准路径，只返回此路径下的文件
     * @returns {Promise<Array<{path: string, filename: string, modified: number, size: number}>}
     */
    async searchFilesByKeywordInPath(keyword, basePath) {
        if (!keyword || !basePath) return [];

        try {
            // 使用 fast-glob 搜索，配置优化以提高性能
            const files = await fastGlob(`**/*${keyword}*`, {
                cwd: basePath,
                onlyFiles: true,
                // 正确的 ignore 模式（不带 **/ 前缀）
                ignore: [
                    'node_modules',
                    '.git',
                    'dist',
                    'build',
                    'out',
                    'target',
                    '.cache',
                    '*.lock',
                    'package-lock.json',
                    'yarn.lock',
                    'pnpm-lock.yaml'
                ],
                caseSensitiveMatch: false,
                suppressErrors: true,
                // 限制搜索深度以提高性能
                deep: 6,
                // 使用对象类型返回，避免额外 stat 调用
                objectMode: true
            });

            return files.slice(0, 30).map((entry) => ({
                path: path.join(basePath, entry.path),
                filename: entry.name,
                modified: entry.stats?.mtimeMs || 0,
                size: entry.stats?.size || 0
            }));
        } catch {
            return [];
        }
    }

    async searchFileByName(query, topK) {
        if (!this.storage) {
            return { query, results: [], totalHits: 0, warning: WARNINGS.DEFERRED, code: CODES.INDEX_NOT_READY };
        }
        const { query: q, topK: k } = normalizeSearchArgs(query, topK);
        if (!q.trim()) return { query: q, results: [], totalHits: 0 };
        return await this.storage.searchFileByName(q, { topK: k });
    }

    async searchFileByContent(query, topK) {
        if (!this.storage) {
            return { query, results: [], totalHits: 0, warning: WARNINGS.DEFERRED, code: CODES.INDEX_NOT_READY };
        }
        const { query: q, topK: k } = normalizeSearchArgs(query, topK);
        if (!q.trim()) return { query: q, results: [], totalHits: 0 };
        return await this.storage.searchFileByContent(q, { topK: k });
    }

    /**
     * Compat shim — fileview.js:39 + preload.js:171 call this.
     * Delegates to searchFileByName, maps result back to flat FileEntry-like array
     * (fileview.js reads .path for dedup and rendering).
     */
    async searchFilesByNameSimilarity(query, topK = 20) {
        if (!this.storage || this.storage.isDeferred()) {
            return [];
        }
        const result = await this.storage.searchFileByName(query, { topK });
        return result.results;
    }

    async resetFileSystemStorage() {
        if (this._readonlyMode) {
            return { status: 'error', warning: WARNINGS.READONLY_MODE, message: '查询模式不支持重置索引' };
        }
        if (!this.storage) {
            return { status: 'error', message: 'storage not initialized' };
        }
        try {
            await this._rebuildAndRestart('manual_reset');
            return { status: 'ok' };
        } catch (error) {
            logger.error(`[filemgr] resetStorage error: ${error.message}`, error);
            return { status: 'error', message: error.message };
        }
    }
}

export default FileManagerWorker;
