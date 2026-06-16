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

import {
    CODES,
    FileEntrySchema,
    FSStorage,
    NORMAL_SCAN_INTERVAL_MS,
    RebuildRequiredError,
    WARNINGS,
    WORKSPACE_SCAN_INTERVAL_MS,
    WORKSPACE_SCAN_INTERVAL_WHILE_EMBEDDING_MS,
    toStorageTimestamp
} from './storage.js';
import { setArkdataDatabaseKit } from '../../services/storage/arkdata-bridge.js';
import { logger } from '../../utils/logger.js';
import { Setting } from '../../utils/setting.js';
import { BaseWorker } from '../base';
import { WorkerDatabaseKitProxy } from '../../../platforms/bridges/worker.js';
import fastGlob from 'fast-glob';
import lockfile from 'proper-lockfile';
import path from 'path';
import fs from 'fs';
import os from 'os';
import {
    filterIndexedResults,
    mergeSearchRoutes,
    normalizeSearchTopK,
    rankSearchResults,
    toIndexedFileSearchResult
} from './search-indexed.js';

const MAX_RECENT_FAILURES = 20;

const FILEMGR_SCANNING_ENABLED = true;
const UNAVAILABLE_THRESHOLD = 50;

const SEARCH_ROUTE_ALIASES = {
    keyword: 'keyword',
    name: 'name_semantic',
    name_semantic: 'name_semantic',
    content: 'content_semantic',
    content_semantic: 'content_semantic'
};

function normalizeIndexedSearchRoutes(options = {}) {
    const requested = Array.isArray(options?.routes)
        ? options.routes.map((route) => SEARCH_ROUTE_ALIASES[String(route)]).filter(Boolean)
        : null;
    const routes = new Set(requested?.length ? requested : ['keyword', 'name_semantic', 'content_semantic']);
    if (options?.includeContentSemantic === false) {
        routes.delete('content_semantic');
    }
    return {
        keyword: routes.has('keyword'),
        nameSemantic: routes.has('name_semantic'),
        contentSemantic: routes.has('content_semantic'),
        needsSemantic: routes.has('name_semantic') || routes.has('content_semantic')
    };
}

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
     * @param {{ onRebuildRequired?: (reason: string) => void, workerRef?: object, getActiveRoots?: () => string[], getScanInterval?: (root: string) => number }} [callbacks]
     */
    constructor(entry, storage, root, state, { onRebuildRequired, workerRef, getActiveRoots, getScanInterval } = {}) {
        this.entry = entry;
        this.root = root;
        this.storage = storage;
        this.state = state;
        this._stopped = true;
        this._scheduledTimeout = null;
        this._counter = 0;
        this._onRebuildRequired = onRebuildRequired;
        this._workerRef = workerRef ?? null;
        this._getActiveRoots = getActiveRoots ?? (() => [this.root]);
        this._getScanInterval = getScanInterval ?? (() => NORMAL_SCAN_INTERVAL_MS);
        this._taskQueue = null;
        this._scanTask = null;
        this._scanQueued = false;
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
        this._taskQueue = taskQueue;

        const queueScanTask = () => {
            if (this._scanQueued) return;
            this._scanQueued = true;
            taskQueue.add(this._scanTask);
        };

        this._scanTask = async () => {
            this._scanQueued = false;
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
                this._scheduledTimeout = null;
                if (!this._stopped) {
                    if (this._workerRef) this._workerRef._scanPending = true;
                    queueScanTask();
                }
            }, this._getScanInterval(this.root));
        };

        queueScanTask();
    }

    requestImmediateScan(taskQueue = this._taskQueue) {
        if (this._stopped) return;
        if (!taskQueue || !this._scanTask) return;
        if (this._scheduledTimeout) {
            clearTimeout(this._scheduledTimeout);
            this._scheduledTimeout = null;
        }
        if (this._workerRef) this._workerRef._scanPending = true;
        if (this._scanQueued) return;
        this._scanQueued = true;
        taskQueue.add(this._scanTask);
    }

    async stop() {
        this._stopped = true;
        this._scanQueued = false;
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
            modified: toStorageTimestamp(file.stats.mtimeMs),
            created: toStorageTimestamp(file.stats.birthtimeMs),
            accessed: toStorageTimestamp(file.stats.atimeMs),
            type: file.stats.isDirectory() ? 'directory' : 'file'
        });
    }

    _isFileUpdated(file, lastScanningTime) {
        return toStorageTimestamp(file.stats.mtimeMs) > lastScanningTime;
    }

    async scan() {
        // 1. Check deferred state
        if (this.storage.isDeferred()) {
            await this.storage.initialize();
            if (this.storage.isDeferred()) return;
        }

        // 2. Sync embedding mode (handles model changes, additions, removals)
        const previousMode = this.storage.mode;
        await this.storage.syncEmbeddingMode('scan', { probeTimeoutMs: 10_000 });
        if (this.storage.mode !== previousMode) {
            void this._workerRef?._emitStatusChanged('mode');
        }

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
            await this.storage.removeDeletedFiles(this.root, scannedPaths, {
                activeRoots: this._getActiveRoots()
            });
        }

        // 6. Full scan: unconditional checkpoint
        const scanCompletedAt = Date.now();
        this.state.last_scan_at = scanCompletedAt;
        if (isFullScan) {
            this.state.last_full_scan = scanCompletedAt;
            this.state.total_files = totalFiles;
            this.state.last_file_count = scannedPaths.size;
        }
        await this.storage.saveScannerState();

        logger.info(
            `[filemgr] scan ${this.root}: depth=${deep ?? 'full'}, ` +
                `total=${totalFiles}, saved=${savedCount}, failed=${failedCount}`
        );

        this._workerRef?._enqueueEmbeddingQueue();
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
        this._initError = null;
        this._statusPushHooksAttached = false;
        this._statusTickHandle = null;
        this._pendingConfigChange = null;
        this._initSeq = 0;
        this._probeContinuationSeq = null;
        this._currentWorkspace = Setting.getInstance().getData()?.default_workspace ?? null;
        this._embeddingQueueActive = false;
        this._embeddingQueueScheduled = false;
    }

    _nextInitSeq() {
        this._initSeq += 1;
        return this._initSeq;
    }

    _getActiveRoots() {
        return (this._lastConfig?.entries ?? this.config?.entries ?? []).map((entry) => entry.root);
    }

    _isEmbeddingBusy() {
        if (this.storage?.mode !== 'full') return false;
        return this._embeddingQueueActive || this._embeddingQueueScheduled;
    }

    _getScanIntervalForRoot(root) {
        if (root !== this._currentWorkspace) return NORMAL_SCAN_INTERVAL_MS;
        return this._isEmbeddingBusy() ? WORKSPACE_SCAN_INTERVAL_WHILE_EMBEDDING_MS : WORKSPACE_SCAN_INTERVAL_MS;
    }

    _shouldYieldEmbeddingQueue() {
        return this._scanPending || this._pendingConfigChange !== null;
    }

    _enqueueEmbeddingQueue() {
        const storage = this.storage;
        if (!storage || storage.mode !== 'full') return;
        if (this._embeddingQueueScheduled || this._embeddingQueueActive) return;
        this._embeddingQueueScheduled = true;
        this.taskQueue.add(async () => {
            if (this.storage !== storage) {
                this._embeddingQueueScheduled = false;
                return 0;
            }
            this._embeddingQueueScheduled = false;
            this._embeddingQueueActive = true;
            try {
                if (this.storage !== storage) return 0;
                return await storage.processEmbeddingQueue(() => this._shouldYieldEmbeddingQueue(), {
                    activeRoots: this._getActiveRoots(),
                    currentWorkspace: this._currentWorkspace
                });
            } finally {
                this._embeddingQueueActive = false;
            }
        });
    }

    _setStatus(next, reason = next) {
        if (this.status === next) return;
        const prev = this.status;
        this.status = next;
        logger.info(`[filemgr] status: ${prev} -> ${next} (${reason})`);
        void this._emitStatusChanged(`status:${next}`);
    }

    async _emitStatusChanged(reason) {
        try {
            const snapshot = await this.getFileSystemStatus();
            this.callApp('publishStatusChanged', { reason, snapshot });
        } catch (error) {
            logger.warn(`[filemgr] emit status changed failed (${reason}): ${error.message}`);
        }
    }

    _ensureStatusPushHooks() {
        if (this._statusPushHooksAttached) return;
        this._statusPushHooksAttached = true;
        this.taskQueue.on('completed', () => {
            void this._emitStatusChanged('task-done');
        });
        this.taskQueue.on('error', () => {
            void this._emitStatusChanged('task-error');
        });
    }

    _startStatusTick(intervalMs = 30_000) {
        if (this._statusTickHandle) return;
        this._statusTickHandle = setInterval(() => {
            if (!this.storage) return;
            void this._emitStatusChanged('tick');
        }, intervalMs);
        this._statusTickHandle.unref?.();
    }

    _clearStatusTick() {
        if (!this._statusTickHandle) return;
        clearInterval(this._statusTickHandle);
        this._statusTickHandle = null;
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
        this._setStatus('idle', context);
    }

    _scheduleInitializeContinuation(seq, reason) {
        void this.runSequentially(async () => {
            await this._continueInitializeAfterProbe(seq, reason);
        }).catch((error) => {
            if (seq !== this._initSeq) return;
            this._initializing = false;
            this._initError = error;
            logger.error(`[filemgr] initialize continuation queue error: ${error.message}`, error);
            this._setStatus('error', 'init-continuation-failed');
        });
    }

    async _continueInitializeAfterProbe(seq, reason) {
        if (this._probeContinuationSeq !== null && this._probeContinuationSeq !== seq) {
            logger.info(
                `[filemgr] replacing probe continuation oldSeq=${this._probeContinuationSeq}, newSeq=${seq}, reason=${reason}`
            );
        }
        this._probeContinuationSeq = seq;
        try {
            const storage = this.storage;
            if (!storage || seq !== this._initSeq || this._readonlyMode) return;
            this._pendingConfigChange = null;

            const previousMode = storage.mode;
            await storage.syncEmbeddingModeForStartup(reason);
            if (!this.storage || this.storage !== storage || seq !== this._initSeq || this._readonlyMode) return;
            if (storage.mode !== previousMode) {
                void this._emitStatusChanged('mode');
            }

            const filesystems = this.config?.entries;
            await this._detachRemovedRoots(this._lastConfig, this.config);
            if (seq !== this._initSeq) return;

            await this._reconcileScannerStateRoots(filesystems ?? []);
            if (seq !== this._initSeq) return;

            if (!filesystems || filesystems.length === 0) {
                this._setStatus('idle', 'no-roots');
                this._lastConfig = this.config;
                return;
            }

            for (const fsEntry of filesystems) {
                if (!storage.scannerState.roots[fsEntry.root]) {
                    storage.scannerState.roots[fsEntry.root] = {
                        last_full_scan: 0,
                        last_scan_at: null,
                        total_files: 0,
                        last_file_count: 0
                    };
                }
            }
            await storage.saveScannerState();
            if (seq !== this._initSeq) return;

            await this._startScanners(filesystems);
            if (seq !== this._initSeq) return;

            this._setStatus('running', 'initialized');
            this._lastConfig = this.config;
        } catch (error) {
            if (seq !== this._initSeq) return;
            this._initError = error;
            logger.error(`[filemgr] initialize continuation error: ${error.message}`, error);
            this._setStatus('error', 'init-continuation-failed');
        } finally {
            if (seq === this._initSeq) {
                this._initializing = false;
            }
            if (this._probeContinuationSeq === seq) {
                this._probeContinuationSeq = null;
            }
        }
    }

    async initialize() {
        this._ensureStatusPushHooks();
        this._startStatusTick();
        this._initializing = true;
        this._initError = null;
        this._setStatus('initializing', 'initialize');
        let continuationScheduled = false;
        return this.runSequentially(async () => {
            try {
                if (this.storage || this._releaseScanLock || this.scanners.size > 0) {
                    logger.warn('[filemgr] initialize called while worker is active; recycling previous runtime state');
                    await this._teardownRuntime('before reinitialize');
                }

                setArkdataDatabaseKit(new WorkerDatabaseKitProxy(this));
                this.storage = new FSStorage(this.appDataDirectory);
                this.storage.onStateChanged = (reason = 'storage-state') => {
                    void this._emitStatusChanged(reason);
                };

                if (!(await this._acquireScanLock())) {
                    this._readonlyMode = true;
                    await this.storage.initializeReadonly();
                    this._lastConfig = this.config;
                    this._setStatus('readonly', 'scan-lock-unavailable');
                    return;
                }

                this._readonlyMode = false;
                const seq = this._nextInitSeq();
                await this.storage.initialize({ syncEmbedding: false });
                this._lastConfig = this.config;
                void this._emitStatusChanged('storage-initialized');

                continuationScheduled = true;
                this._scheduleInitializeContinuation(seq, 'initialize');
            } finally {
                if (!continuationScheduled) {
                    this._initializing = false;
                }
            }
        }).catch(async (error) => {
            this._initializing = false;
            await this._teardownRuntime('after initialize error');
            this._initError = error;
            logger.error(`[filemgr] initialize error: ${error.message}`, error);
            this._setStatus('error', 'init-failed');
        });
    }

    async finalize() {
        await this.runSequentially(async () => {
            this._clearStatusTick();
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
                workerRef: this,
                getActiveRoots: () => (this._lastConfig?.entries ?? deduped).map((entry) => entry.root),
                getScanInterval: (root) => this._getScanIntervalForRoot(root)
            });
            this.scanners.set(root, scanner);
            await scanner.start(this.taskQueue);
        }
    }

    async _restartScanners() {
        this._setStatus('initializing', 'restart-scanners');
        for (const scanner of this.scanners.values()) {
            await scanner.stop().catch((err) => {
                logger.error(`[filemgr] stop scanner failed: ${err.message}`);
            });
        }
        this.scanners.clear();

        const filesystems = this.config?.entries;
        if (!filesystems || filesystems.length === 0) {
            await this.storage.removeOrphanedItems();
            this._setStatus('idle', 'no-roots');
            return;
        }

        await this._startScanners(filesystems);
        this._setStatus('running', 'scanners-restarted');
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

        this._currentWorkspace = Setting.getInstance().getData()?.default_workspace ?? null;
        if (this._readonlyMode) return;

        const seq = this._nextInitSeq();
        const myConfig = config;
        this._pendingConfigChange = myConfig;

        if (this._initializing) {
            this._scheduleInitializeContinuation(seq, 'config-changed');
            return;
        }

        if (!this.storage || this.status === 'error') return;

        await this.runSequentially(async () => {
            if (seq !== this._initSeq || this._pendingConfigChange !== myConfig) return;
            this._pendingConfigChange = null;

            const storage = this.storage;
            if (!storage) return;

            const previousMode = storage.mode;
            await storage.syncEmbeddingModeForStartup('filemgr config changed');
            if (seq !== this._initSeq || this.storage !== storage) return;
            if (storage.mode !== previousMode) {
                void this._emitStatusChanged('mode');
            }

            const oldConfig = this._lastConfig;
            const oldRoots = await this._detachRemovedRoots(oldConfig, config);
            if (seq !== this._initSeq || this.storage !== storage) return;

            const newRoots = new Set((config?.entries ?? []).map((e) => e.root));

            for (const added of newRoots) {
                if (!oldRoots.has(added)) {
                    storage.scannerState.roots[added] = {
                        last_full_scan: 0,
                        last_scan_at: null,
                        total_files: 0,
                        last_file_count: 0
                    };
                }
            }
            await storage.saveScannerState();
            if (seq !== this._initSeq || this.storage !== storage) return;

            await this._restartScanners();
            if (seq !== this._initSeq || this.storage !== storage) return;

            this._enqueueEmbeddingQueue();
            this._lastConfig = config;
        });
    }

    async embeddingConfigChanged() {
        this._currentWorkspace = Setting.getInstance().getData()?.default_workspace ?? null;
        if (this._readonlyMode) return { status: 'ok', data: await this.getFileSystemStatus() };

        const seq = this._nextInitSeq();
        if (this._initializing) {
            this._scheduleInitializeContinuation(seq, 'embedding config changed');
            return { status: 'ok', data: await this.getFileSystemStatus() };
        }

        if (!this.storage || this.status === 'error') {
            return { status: 'ok', data: await this.getFileSystemStatus() };
        }

        await this.runSequentially(async () => {
            if (seq !== this._initSeq) return;
            const storage = this.storage;
            if (!storage) return;

            const previousMode = storage.mode;
            await storage.syncEmbeddingModeForStartup('embedding config changed');
            if (seq !== this._initSeq || this.storage !== storage) return;
            if (storage.mode !== previousMode) {
                void this._emitStatusChanged('mode');
            }

            for (const scanner of this.scanners.values()) {
                scanner.requestImmediateScan?.(this.taskQueue);
            }
        });

        return { status: 'ok', data: await this.getFileSystemStatus() };
    }

    async _detachRemovedRoots(oldConfig, config) {
        const oldRoots = new Set((oldConfig?.entries ?? []).map((e) => e.root));
        const newRoots = new Set((config?.entries ?? []).map((e) => e.root));

        for (const removed of oldRoots) {
            if (!newRoots.has(removed)) {
                await this.storage.detachRootForConfigChange(removed, config?.entries ?? []);
            }
        }

        return oldRoots;
    }

    async _reconcileScannerStateRoots(entries) {
        const activeRoots = new Set((entries ?? []).map((entry) => entry.root));
        const stateRoots = Object.keys(this.storage?.scannerState?.roots ?? {});

        for (const root of stateRoots) {
            if (!activeRoots.has(root)) {
                await this.storage.detachRootForConfigChange(root, entries ?? []);
            }
        }
    }

    // ── Worker API methods ──────────────────────────────────────────

    _getEffectiveStatus() {
        return this._readonlyMode ? 'readonly' : this.status;
    }

    _computeMode(status = this._getEffectiveStatus()) {
        if (status !== 'running' && status !== 'readonly') return null;
        return this.storage?.mode ?? null;
    }

    _buildAlerts(status = this._getEffectiveStatus(), mode = this._computeMode(status), storageStatus = null) {
        if (status === 'error') {
            return [
                {
                    code: 'worker_init_failed',
                    data: { reason: this._initError?.message ?? 'unknown error' }
                }
            ];
        }

        const entries = this._lastConfig?.entries ?? this.config?.entries ?? [];
        if (status === 'idle') {
            return entries.length === 0 ? [{ code: 'no_roots' }] : [];
        }

        if (status === 'initializing') return [];

        if ((status === 'running' || status === 'readonly') && mode === 'base-only') {
            const probeError = this.storage?.scannerState.probe_permanent_error;
            if (probeError) {
                return [{ code: 'embedding_unavailable', data: probeError }];
            }
            return Setting.getInstance().getDefaultEmbeddingModelInstance()
                ? [{ code: 'embedding_pending' }]
                : [{ code: 'embed_model_missing' }];
        }

        if (
            (status === 'running' || status === 'readonly') &&
            mode === 'full' &&
            storageStatus?.semantic_write_state?.vector?.acceptingWrites === false
        ) {
            return [{ code: 'semantic_capacity_limited' }];
        }

        return [];
    }

    _deriveSourceState(root, counts, mode) {
        if (this.storage?.scannerState.unavailable_roots?.[root]) return 'unavailable';
        if (counts.total_files === 0) return 'pending';
        if (mode === 'full') return counts.pending_count > 0 ? 'scanning' : 'completed';
        if (mode === 'base-only') return counts.last_scan_at === null ? 'pending' : 'completed';
        return 'pending';
    }

    _getDefaultWorkspace() {
        try {
            return Setting.getInstance().getData().default_workspace ?? null;
        } catch {
            return null;
        }
    }

    async getFileSystemStatus() {
        const status = this._getEffectiveStatus();
        const mode = this._computeMode(status);

        const platform = process.platform;
        const isOpenHarmony = platform === 'openharmony';
        const homePath =
            (() => {
                try {
                    return os.homedir?.() ?? '';
                } catch {
                    return '';
                }
            })() ||
            process.env.HOME ||
            process.env.USERPROFILE ||
            '';

        if (!this.storage) {
            return {
                status,
                mode: null,
                alerts: this._buildAlerts(status, null),
                sources: [],
                totals: null,
                storage_stats: null,
                last_rebuild_event: null,
                platform,
                is_openharmony: isOpenHarmony,
                home_path: homePath
            };
        }

        const storageStatus = await this.storage.getStatus();
        const entries = this._lastConfig?.entries ?? this.config?.entries ?? [];
        const roots = entries.map((entry) => entry.root);
        const perRootCounts = await this.storage.getPerRootCounts(roots);
        const defaultWorkspace = this._getDefaultWorkspace();
        const scannerList = [...this.scanners.values()].map((scanner) => ({
            entry: scanner.entry,
            root: scanner.root,
            lastFullScan: scanner.state.last_full_scan,
            totalFiles: scanner.state.total_files,
            isRunning: scanner.isRunning(),
            recentFailures: scanner._recentFailures ?? []
        }));

        const sources = entries.map((entry) => {
            const counts = perRootCounts.get(entry.root) ?? {
                total_files: 0,
                embedded_count: 0,
                pending_count: 0,
                failed_count: 0,
                last_scan_at: null
            };
            return {
                root: entry.root,
                entry,
                state: this._deriveSourceState(entry.root, counts, mode),
                last_scan_at: counts.last_scan_at,
                total_files: counts.total_files,
                embedded_count: counts.embedded_count,
                pending_count: counts.pending_count,
                failed_count: counts.failed_count ?? 0,
                is_workspace: entry.root === defaultWorkspace
            };
        });

        const totals =
            mode === null
                ? null
                : {
                      total_files: sources.reduce((sum, source) => sum + source.total_files, 0),
                      embedded_count: sources.reduce((sum, source) => sum + source.embedded_count, 0),
                      pending_count: sources.reduce((sum, source) => sum + source.pending_count, 0),
                      last_embedding_task_at: this.storage.scannerState.last_embedding_task_at
                  };
        const storageStats =
            mode === null
                ? null
                : {
                      db_size: storageStatus.db_size,
                      vecdb_size: storageStatus.vecdb_size,
                      chunk_size: storageStatus.chunk_size
                  };

        return {
            status,
            mode,
            default_workspace: defaultWorkspace,
            alerts: this._buildAlerts(status, mode, storageStatus),
            sources,
            totals,
            storage_stats: storageStats,
            last_rebuild_event: this.storage.scannerState.last_rebuild_event,
            scanners: scannerList,
            storage: storageStatus,
            isDeferred: this.storage.isDeferred(),
            deferredReason: this.storage.deferredReason ?? null,
            probe_permanent_error: this.storage.scannerState.probe_permanent_error,
            unavailable_roots: this.storage.scannerState.unavailable_roots,
            readonly: this._readonlyMode ?? false,
            platform,
            is_openharmony: isOpenHarmony,
            home_path: homePath
        };
    }

    async getStatus() {
        return { status: 'ok', data: await this.getFileSystemStatus() };
    }

    async workspaceChanged(defaultWorkspace) {
        if (typeof defaultWorkspace === 'string') {
            await this.runSequentially(async () => {
                this._currentWorkspace = defaultWorkspace;
                try {
                    const data = Setting.getInstance().getData();
                    Setting.updateInstanceData({ ...data, default_workspace: defaultWorkspace });
                } catch (error) {
                    logger.warn(`[filemgr] failed to update default workspace marker: ${error?.message ?? error}`);
                }

                if (this.storage?.scannerState?.roots) {
                    if (!this.storage.scannerState.roots[defaultWorkspace]) {
                        this.storage.scannerState.roots[defaultWorkspace] = {
                            last_full_scan: 0,
                            last_scan_at: null,
                            total_files: 0,
                            last_file_count: 0
                        };
                    } else {
                        this.storage.scannerState.roots[defaultWorkspace].last_full_scan = 0;
                    }
                    await this.storage.saveScannerState?.();
                    this.scanners.get(defaultWorkspace)?.requestImmediateScan?.(this.taskQueue);
                }
            });
        }

        await this._emitStatusChanged('workspace');
        return { status: 'ok', data: await this.getFileSystemStatus() };
    }

    async searchFilesByKeyword(keyword) {
        if (!this.storage || this.storage.isDeferred()) {
            return [];
        }
        return await this.storage.searchFilesByKeyword(keyword);
    }

    async _statFileForSearch(filePath) {
        const stat = await fs.promises.stat(filePath).catch(() => null);
        return stat?.isFile?.() ? stat : null;
    }

    async searchIndexedFiles(query, options = {}) {
        const normalizedQuery = typeof query === 'string' ? query.trim() : '';
        const topK = normalizeSearchTopK(options?.topK);
        const routes = normalizeIndexedSearchRoutes(options);

        if (!this.storage || this.storage.isDeferred()) {
            return toIndexedFileSearchResult(normalizedQuery, [], 0, WARNINGS.DEFERRED, CODES.INDEX_NOT_READY);
        }

        if (!normalizedQuery) {
            return toIndexedFileSearchResult(normalizedQuery, [], 0);
        }

        let keyword = [];
        if (routes.keyword) {
            try {
                const keywordSearch = this.storage.searchIndexedFilesByKeyword ?? this.storage.searchFilesByKeyword;
                keyword = await keywordSearch.call(this.storage, normalizedQuery, { limit: topK * 3 });
            } catch (error) {
                logger.warn(`[filemgr] searchIndexedFiles keyword failed: ${error.message}`);
                return toIndexedFileSearchResult(
                    normalizedQuery,
                    [],
                    0,
                    '文件搜索暂不可用，请稍后重试',
                    CODES.SEARCH_FAILED
                );
            }
        }

        let name = { results: [] };
        let content = { results: [] };
        let warning;
        let code;

        if (routes.needsSemantic) {
            if (this.storage.mode === 'full') {
                if (routes.nameSemantic) {
                    try {
                        name = await this.storage.searchFileByName(normalizedQuery, { topK: topK * 2 });
                        if (name?.code) code = CODES.SEMANTIC_PARTIAL;
                    } catch (error) {
                        logger.warn(`[filemgr] searchIndexedFiles name semantic failed: ${error.message}`);
                        code = CODES.SEMANTIC_PARTIAL;
                    }
                }

                if (routes.contentSemantic) {
                    try {
                        content = await this.storage.searchFileByContent(normalizedQuery, { topK: topK * 2 });
                        if (content?.code) code = CODES.SEMANTIC_PARTIAL;
                    } catch (error) {
                        logger.warn(`[filemgr] searchIndexedFiles content semantic failed: ${error.message}`);
                        code = CODES.SEMANTIC_PARTIAL;
                    }
                }

                if (code === CODES.SEMANTIC_PARTIAL) {
                    warning = WARNINGS.SEMANTIC_PARTIAL;
                }
            } else {
                warning = WARNINGS.NO_EMBEDDING_MODEL;
                code = CODES.EMBED_UNAVAILABLE;
            }
        }

        const merged = mergeSearchRoutes({
            keyword,
            nameSemantic: name?.results ?? [],
            contentSemantic: content?.results ?? []
        });
        const filtered = await filterIndexedResults(merged, {
            entries: this._lastConfig?.entries ?? this.config?.entries ?? [],
            unavailableRoots: this.storage.scannerState?.unavailable_roots ?? {},
            currentWorkspace: this._currentWorkspace,
            statFile: (filePath) => this._statFileForSearch(filePath),
            concurrency: 16
        });
        const ranked = rankSearchResults(filtered, { currentWorkspace: this._currentWorkspace }).slice(0, topK);
        return toIndexedFileSearchResult(normalizedQuery, ranked, filtered.length, warning, code);
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
