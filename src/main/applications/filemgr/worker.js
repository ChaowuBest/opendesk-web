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
import { getHomeDir } from '../../utils/temp.js';
import {
    createIndexedSearchContext,
    filterIndexedResults,
    filterIndexedResultsByPolicy,
    groupIndexedChunksByFile,
    mergeSearchRoutes,
    InvalidFilemgrSearchScopeError,
    rankSearchResults,
    resolveFilemgrSearchScopeForEntries,
    toIndexedFileSearchResult
} from './search/indexed.js';
import { extractText as extractFileTextFromParser } from './parser/extract.js';
import { FSEntrySchema } from './setting.js';
import { resolveDriveRootPath } from './utils.js';

export const FILE_ATTRIBUTE_CONCURRENCY = 64;
export const DIRECTORY_READ_CONCURRENCY = 8;
export const SCAN_READ_AHEAD_LIMIT = 256;

const EXPECTED_READ_ERRORS = new Set([
    'EACCES',
    'EPERM',
    'ENOENT',
    'ENOTDIR',
    'EIO',
    'EBUSY',
    'ESTALE',
    'EMFILE',
    'ENFILE',
    'ELOOP',
    'ENODEV',
    'ENAMETOOLONG'
]);

// Limits apply across all glob tasks in this scan. A readdir batch, fast-glob's
// traversal state and the scanner's scannedPaths still have their own memory cost.
export function createFileScan(
    patterns,
    options,
    { shouldStop = () => false, onReadError = () => {}, filesystem = fs } = {}
) {
    let closed = false;
    let fatalError = null;
    let activeDirectories = 0;
    const waitingDirectories = new Set();
    const directoryTasks = new Set();
    const pending = [];
    let currentAttributeTask = null;
    const cancelled = Object.assign(new Error('FileMgr enumeration stopped'), { code: 'ECANCELED' });

    function close() {
        if (closed) return;
        closed = true;
        // Waking on close is required even when the consumer never resumes.
        for (const start of [...waitingDirectories]) start();
        stream?.destroy();
    }

    function interrupted() {
        if (shouldStop()) close();
        return closed;
    }

    function report(error, operation, target) {
        if (!EXPECTED_READ_ERRORS.has(error?.code)) {
            fatalError ??= error;
            close();
            return;
        }
        try {
            onReadError({ operation, path: String(target), code: error.code });
        } catch (error) {
            fatalError ??= error;
            close();
        }
    }

    function wakeReaders() {
        if (waitingDirectories.size === 0 || activeDirectories >= DIRECTORY_READ_CONCURRENCY) return;
        if (interrupted()) return;
        if ((stream?.readableLength ?? 0) >= SCAN_READ_AHEAD_LIMIT) return;
        for (const start of waitingDirectories) {
            if (activeDirectories >= DIRECTORY_READ_CONCURRENCY) break;
            start();
        }
    }

    function readdir(directory, settings, callback) {
        let settle;
        const task = new Promise((resolve) => {
            settle = resolve;
        });
        directoryTasks.add(task);
        const complete = (error, entries) => {
            try {
                if (!interrupted() && error) report(error, 'readdir', directory);
                // error.path can name an unknown-type child. The attempted directory
                // is the only safe protection boundary for a failed Dirent batch.
                callback(closed ? cancelled : error, closed ? undefined : entries);
            } catch (error) {
                fatalError ??= error;
                close();
            } finally {
                directoryTasks.delete(task);
                settle();
                wakeReaders();
            }
        };
        const start = () => {
            if (
                !closed &&
                (activeDirectories >= DIRECTORY_READ_CONCURRENCY ||
                    (stream?.readableLength ?? 0) >= SCAN_READ_AHEAD_LIMIT)
            )
                return;
            waitingDirectories.delete(start);
            if (interrupted()) {
                // fast-glob releases the next queued directory inside this callback.
                // Keep cancellation asynchronous, like real readdir, and tracked by drain.
                queueMicrotask(() => complete(cancelled));
                return;
            }
            activeDirectories++;
            const done = (error, entries) => {
                activeDirectories--;
                complete(error, entries);
            };
            try {
                filesystem.readdir(directory, settings, done);
            } catch (error) {
                done(error);
            }
        };
        waitingDirectories.add(start);
        start();
    }

    const stream = fastGlob.stream(patterns, {
        ...options,
        stats: false,
        objectMode: true,
        concurrency: DIRECTORY_READ_CONCURRENCY,
        fs: { readdir }
    });
    // A stream error can arrive while the consumer is writing a batch.
    stream.on('error', (error) => {
        fatalError ??= error;
        close();
    });

    function readAttributes(entry) {
        return new Promise((resolve) => {
            const done = (error, stats) => {
                if (error && !closed) report(error, 'lstat', entry.path);
                entry.stats = error ? null : stats;
                resolve(entry);
            };
            try {
                filesystem.lstat(entry.path, done);
            } catch (error) {
                done(error);
            }
        });
    }

    async function drain() {
        await Promise.allSettled([currentAttributeTask, ...pending]);
        // Completing a directory may expose another queued cancellation. A single
        // snapshot would return before those callbacks have settled.
        while (directoryTasks.size > 0) await Promise.allSettled([...directoryTasks]);
    }

    async function* files() {
        try {
            for await (const entry of stream) {
                if (fatalError) throw fatalError;
                if (interrupted()) break;
                pending.push(readAttributes(entry));
                if (pending.length >= FILE_ATTRIBUTE_CONCURRENCY) {
                    // Yield the task directly: the async generator awaits it once.
                    currentAttributeTask = pending.shift();
                    yield currentAttributeTask;
                    currentAttributeTask = null;
                    wakeReaders();
                }
            }
            while (pending.length > 0 && !interrupted() && !fatalError) {
                currentAttributeTask = pending.shift();
                yield currentAttributeTask;
                currentAttributeTask = null;
            }
            if (fatalError) throw fatalError;
        } catch (error) {
            if (fatalError) throw fatalError;
            if (!shouldStop()) throw error;
        } finally {
            close();
            await drain();
        }
    }

    return { files: files(), close, drain };
}

const MAX_RECENT_FAILURES = 20;

const FILEMGR_SCANNING_ENABLED = true;
const UNAVAILABLE_THRESHOLD = 50;

function normalizeSearchArgs(query, topK) {
    return {
        query: typeof query === 'string' ? query : '',
        topK: Math.max(1, Math.min(Number(topK) || 20, 100))
    };
}

function invalidIndexedSearchScopeResult(query) {
    const normalizedQuery = typeof query === 'string' ? query.trim() : '';
    return toIndexedFileSearchResult(normalizedQuery, [], 0, WARNINGS.INVALID_SCOPE, CODES.INVALID_SCOPE);
}

class FSScanner {
    /**
     * @param {object} entry - FSEntry config
     * @param {FSStorage} storage
     * @param {string} root
     * @param {object} state - reference to scannerState.roots[root]
     * @param {{ onRebuildRequired?: (reason: string) => void, workerRef?: object, getActiveRoots?: () => string[], getScanInterval?: (root: string) => number, shouldYield?: () => boolean }} [callbacks]
     */
    constructor(
        entry,
        storage,
        root,
        state,
        { onRebuildRequired, workerRef, getActiveRoots, getScanInterval, shouldYield } = {}
    ) {
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
        this._shouldYield = shouldYield ?? (() => false);
        this._taskQueue = null;
        this._scanTask = null;
        this._scanReader = null;
        this._scanQueued = false;
        /** @type {Array<{path: string, error: string}>} */
        this._recentFailures = [];
    }

    isRunning() {
        return !this._stopped;
    }

    _queueScanTask(taskQueue, { allowPendingControl = false } = {}) {
        if (!taskQueue || !this._scanTask || (!allowPendingControl && this._shouldYield())) {
            if (this._workerRef)
                this._workerRef._scanPending = [...(this._workerRef.scanners?.values() ?? [])].some(
                    (scanner) => scanner._scanQueued
                );
            return false;
        }
        if (this._scanQueued) return true;
        this._scanQueued = true;
        if (this._workerRef) this._workerRef._scanPending = true;
        const queued = taskQueue.add(this._scanTask);
        queued?.catch?.((err) => {
            this._scanQueued = false;
            logger.error(`[filemgr] queued scan task failed for ${this.root}: ${err?.message ?? err}`, err);
        });
        return true;
    }

    async start(taskQueue, { allowPendingControl = false } = {}) {
        if (!this._stopped || this._scheduledTimeout !== null) {
            await this.stop();
        }

        this._stopped = false;
        this._counter = 0;
        this._taskQueue = taskQueue;

        this._scanTask = async () => {
            this._scanQueued = false;
            if (this._workerRef)
                this._workerRef._scanPending = [...(this._workerRef.scanners?.values() ?? [])].some(
                    (scanner) => scanner._scanQueued
                );
            if (this._stopped) return;
            if (this._scheduledTimeout !== null) {
                clearTimeout(this._scheduledTimeout);
                this._scheduledTimeout = null;
            }

            // The pending flag now describes only scans still waiting for this serial slot.

            let completed = false;
            try {
                completed = (await this.scan()) === true;
            } catch (err) {
                if (err instanceof RebuildRequiredError && this._onRebuildRequired) {
                    // Don't await — _rebuildAndRestart queues on the same taskQueue
                    // (concurrency=1), awaiting would deadlock
                    const rebuildPromise = this._onRebuildRequired(err.reason);
                    rebuildPromise?.catch?.((error) => {
                        logger.error(
                            `[filemgr] rebuild task failed after scanner request for ${this.root}: ${error?.message ?? error}`,
                            error
                        );
                    });
                    return;
                }
                logger.error(`[filemgr] scan error for ${this.root}: ${err.message}`, err);
            }

            if (this._stopped) return;

            if (this._counter !== 0 || completed) this._counter++;
            this._scheduledTimeout = setTimeout(() => {
                this._scheduledTimeout = null;
                if (!this._stopped) {
                    this._queueScanTask(taskQueue);
                }
            }, this._getScanInterval(this.root));
        };

        return this._queueScanTask(taskQueue, { allowPendingControl });
    }

    requestImmediateScan(taskQueue = this._taskQueue, { allowPendingControl = false } = {}) {
        if (this._stopped || !taskQueue || !this._scanTask) return false;
        if (this._scheduledTimeout) {
            clearTimeout(this._scheduledTimeout);
            this._scheduledTimeout = null;
        }
        const queued = this._queueScanTask(taskQueue, { allowPendingControl });
        return queued;
    }

    async stop() {
        this._stopped = true;
        try {
            this._scanReader?.close();
        } finally {
            this._scanQueued = false;
            if (this._workerRef)
                this._workerRef._scanPending = [...(this._workerRef.scanners?.values() ?? [])].some(
                    (scanner) => scanner._scanQueued
                );
            if (this._scheduledTimeout) {
                clearTimeout(this._scheduledTimeout);
                this._scheduledTimeout = null;
            }
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
        const changedAt = Math.max(file.stats.mtimeMs, file.stats.ctimeMs);
        return toStorageTimestamp(changedAt) > lastScanningTime;
    }

    async scan() {
        if (this._stopped || this._shouldYield()) return;

        // 1. Check deferred state
        if (this.storage.isDeferred()) {
            await this.storage.initialize();
            if (this._stopped || this._shouldYield()) return;
            if (this.storage.isDeferred()) return;
        }
        if (this._stopped || this._shouldYield()) return;

        // 2. Sync embedding mode (handles model changes, additions, removals)
        const previousMode = this.storage.mode;
        await this.storage.syncEmbeddingMode('scan');
        if (this._stopped || this._shouldYield()) return;
        if (this.storage.mode !== previousMode) {
            void this._workerRef?._emitStatusChanged('mode');
        }

        // Reinitialization reloads scanner_state for all roots. Rebind before
        // every scan so another scanner's recovery cannot leave this checkpoint stale.
        this.state = this.storage.scannerState.roots[this.root] ?? this.state;

        // 3. Main scan loop
        const deep = this._getScanDepth();
        const isFullScan = deep === undefined;
        const lastScanningTime = this.state.last_full_scan;

        const failedDirectories = new Set();
        const readErrors = { readdir: 0, lstat: 0 };
        let errorSamples = 0;
        const reader = createFileScan(
            this.entry.include_patterns,
            {
                cwd: resolveDriveRootPath(this.root, process.platform),
                deep: deep,
                dot: false,
                objectMode: true,
                suppressErrors: true,
                followSymbolicLinks: false,
                absolute: true,
                caseSensitiveMatch: false,
                ignore: this.entry.exclude_patterns
            },
            {
                shouldStop: () => this._stopped || this._shouldYield(),
                onReadError: ({ operation, path, code }) => {
                    readErrors[operation]++;
                    if (operation === 'readdir') failedDirectories.add(path);
                    if (errorSamples++ < MAX_RECENT_FAILURES) {
                        logger.warn(`[filemgr] ${operation} ${path}: ${code}`);
                    }
                }
            }
        );
        this._scanReader = reader;

        let batch = [];
        let totalFiles = 0;
        let savedCount = 0;
        let failedCount = 0;
        const BATCH_SIZE = 500;
        const scannedPaths = isFullScan ? new Set() : null;
        let metadataWriteFailed = false;
        let diagnosticAttempted = false;
        let scanError = null;
        const saveBatch = async (files) => {
            try {
                const result = await this.storage.saveFiles(files, this.root);
                if (result.failed > 0) {
                    metadataWriteFailed = true;
                    this.state.metadata_write_pending = true;
                }
                return result;
            } catch (error) {
                metadataWriteFailed = true;
                this.state.metadata_write_pending = true;
                throw error;
            }
        };

        const cleanupReader = async () => {
            let cleanupError = null;
            try {
                reader.close();
            } catch (error) {
                cleanupError = error;
            }
            // Drain every in-flight read even when another cleanup step rejects.
            try {
                await reader.files.return();
            } catch (error) {
                cleanupError ??= error;
            }
            try {
                await reader.drain();
            } catch (error) {
                cleanupError ??= error;
            }
            if (this._scanReader === reader) this._scanReader = null;
            if (metadataWriteFailed && !diagnosticAttempted) {
                diagnosticAttempted = true;
                await this.storage.saveScannerState().catch((error) => {
                    logger.warn(`[filemgr] metadata failure diagnostic ${this.root}: ${error.message}`, error);
                });
            }
            if (errorSamples > 0) {
                logger.warn(
                    `[filemgr] read errors ${this.root}: readdir=${readErrors.readdir}, lstat=${readErrors.lstat}, omitted=${Math.max(0, errorSamples - MAX_RECENT_FAILURES)}`
                );
            }
            if (cleanupError) {
                if (scanError)
                    logger.warn(`[filemgr] scan cleanup ${this.root}: ${cleanupError.message}`, cleanupError);
                else throw cleanupError;
            }
        };

        // Clear recent failures at start of every scan, not just full scans (spec §11.3)
        this._recentFailures = [];

        try {
            for await (const entry of reader.files) {
                if (this._stopped || this._shouldYield()) return;
                totalFiles++;
                if (scannedPaths) scannedPaths.add(entry.path);
                if (entry.stats?.isFile() && (isFullScan || this._isFileUpdated(entry, lastScanningTime))) {
                    batch.push(this._convertToFileEntry(entry));
                }
                if (batch.length >= BATCH_SIZE) {
                    const result = await saveBatch(batch);
                    savedCount += result.saved;
                    failedCount += result.failed;
                    this._collectFailures(result.failures);
                    batch = [];
                    if (this._stopped || this._shouldYield()) {
                        logger.info(`[filemgr] scan ${this.root}: yielding after batch`);
                        return;
                    }
                }
            }
            if (this._stopped || this._shouldYield()) return;
            if (batch.length > 0) {
                const result = await saveBatch(batch);
                savedCount += result.saved;
                failedCount += result.failed;
                this._collectFailures(result.failures);
                if (this._stopped || this._shouldYield()) {
                    logger.info(`[filemgr] scan ${this.root}: yielding after final batch`);
                    return;
                }
            }
            if (this._stopped || this._shouldYield()) return;

            // A failed source root is unavailable, even below the empty-scan threshold.
            // Compare I/O paths without changing the root used by state and references.
            const rootPath = resolveDriveRootPath(this.root, process.platform);
            let rootReadFailed = [...failedDirectories].some((directory) => path.relative(rootPath, directory) === '');
            if (
                !rootReadFailed &&
                totalFiles === 0 &&
                (failedDirectories.size > 0 || this.storage.scannerState.unavailable_roots[this.root])
            ) {
                // Glob bases can start below root. Probe only this ambiguous failure case,
                // so a missing child is not confused with an offline source.
                try {
                    await fs.promises.readdir(rootPath);
                } catch (error) {
                    if (!EXPECTED_READ_ERRORS.has(error.code)) throw error;
                    rootReadFailed = true;
                }
                if (this._stopped || this._shouldYield()) return;
            }
            if (rootReadFailed) {
                this.storage.scannerState.unavailable_roots[this.root] ??= {
                    since: Date.now(),
                    last_count: this.state.last_file_count ?? 0
                };
                await this.storage.saveScannerState();
                this.storage.onStateChanged?.();
                return true;
            }

            // 5. Full scan: delete detection
            if (isFullScan && scannedPaths) {
                if (scannedPaths.size === 0 && failedDirectories.size === 0) {
                    const lastCount = this.state.last_file_count ?? 0;
                    if (lastCount > UNAVAILABLE_THRESHOLD) {
                        this.storage.scannerState.unavailable_roots[this.root] = {
                            since: Date.now(),
                            last_count: lastCount
                        };
                        await this.storage.saveScannerState();
                        this.storage.onStateChanged?.();
                        return true;
                    }
                }
                await this.storage.removeDeletedFiles(this.root, scannedPaths, {
                    activeRoots: this._getActiveRoots(),
                    failedDirectories
                });
            }
            if (this._stopped || this._shouldYield()) return;

            // Commit a completed attempt atomically; failed metadata writes retain its full baseline.
            const scanCompletedAt = Date.now();
            const changes = { last_scan_at: scanCompletedAt };
            if (isFullScan) {
                if (!metadataWriteFailed) changes.last_full_scan = scanCompletedAt;
                if (!metadataWriteFailed && readErrors.readdir === 0 && readErrors.lstat === 0)
                    changes.metadata_write_pending = false;
                if (failedDirectories.size === 0) {
                    changes.total_files = totalFiles;
                    changes.last_file_count = scannedPaths.size;
                }
            }
            diagnosticAttempted = metadataWriteFailed;
            await this.storage.commitRootScanState(this.root, changes, { clearUnavailable: isFullScan });

            logger.info(
                `[filemgr] scan ${this.root}: depth=${deep ?? 'full'}, ` +
                    `total=${totalFiles}, saved=${savedCount}, failed=${failedCount}`
            );

            this._workerRef?._enqueueEmbeddingQueue();
            return true;
        } catch (error) {
            scanError = error;
            throw error;
        } finally {
            await cleanupReader();
        }
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
        this._configChangeOperation = null;
        this._pendingWorkspaceChange = null;
        this._pendingEmbeddingConfigChange = false;
        this._pendingEmbeddingConfigChangeToken = 0;
        this._initSeq = 0;
        this._probeContinuationSeq = null;
        this._currentWorkspace = Setting.getInstance().getData()?.default_workspace ?? null;
        this._embeddingQueueActive = false;
        this._embeddingQueueScheduled = false;
        this._pendingSourceControls = new Set();
        this._sourceControlSequence = 0;
    }

    _nextInitSeq() {
        this._initSeq += 1;
        return this._initSeq;
    }

    _normalizeConfig(config) {
        const rawConfig = config && typeof config === 'object' ? config : {};
        const entries = Array.isArray(rawConfig.entries) ? rawConfig.entries : [];
        return {
            ...rawConfig,
            entries: entries.map((entry) => FSEntrySchema.parse(entry))
        };
    }

    _isSameConfig(left, right) {
        if (left === right) return true;
        if (!left || !right) return false;
        return JSON.stringify(this._normalizeConfig(left)) === JSON.stringify(this._normalizeConfig(right));
    }

    _getActiveRoots() {
        return (this._lastConfig?.entries ?? this.config?.entries ?? []).map((entry) => entry.root);
    }

    _registerSourceControlIntent() {
        const token = ++this._sourceControlSequence;
        this._pendingSourceControls.add(token);
        return token;
    }

    _consumeSourceControlIntent(token) {
        this._pendingSourceControls.delete(token);
    }

    _getRunnableRoots() {
        return this._getActiveRoots().filter((root) => this.storage?.scannerState?.roots?.[root]?.paused !== true);
    }

    _hasPendingControlChange() {
        return (
            this._pendingConfigChange !== null ||
            this._pendingWorkspaceChange !== null ||
            this._pendingEmbeddingConfigChange ||
            this._pendingSourceControls.size > 0
        );
    }

    _getVisibleConfigEntries() {
        if (this._readonlyMode) return this.config?.entries ?? [];
        return this._pendingConfigChange?.entries ?? this._lastConfig?.entries ?? this.config?.entries ?? [];
    }

    _findWorkspaceRoot(workspace, roots = this._getActiveRoots()) {
        if (roots.includes(workspace)) return workspace;
        if (typeof workspace !== 'string') return null;
        const workspacePath = resolveDriveRootPath(workspace, process.platform);
        return roots.find((root) => resolveDriveRootPath(root, process.platform) === workspacePath) ?? null;
    }

    _isEmbeddingBusy() {
        if (this.storage?.mode !== 'full') return false;
        return this._embeddingQueueActive || this._embeddingQueueScheduled;
    }

    _getScanIntervalForRoot(root) {
        if (root !== this._findWorkspaceRoot(this._currentWorkspace)) return NORMAL_SCAN_INTERVAL_MS;
        return this._isEmbeddingBusy() ? WORKSPACE_SCAN_INTERVAL_WHILE_EMBEDDING_MS : WORKSPACE_SCAN_INTERVAL_MS;
    }

    _shouldYieldEmbeddingQueue() {
        return this._scanPending || this._hasPendingControlChange();
    }

    _enqueueEmbeddingQueue({ allowPendingControl = false } = {}) {
        const storage = this.storage;
        if (!storage || storage.mode !== 'full') return;
        if (this._getRunnableRoots().length === 0) return;
        if (!allowPendingControl && this._hasPendingControlChange()) return;
        if (this._embeddingQueueScheduled || this._embeddingQueueActive) return;
        this._embeddingQueueScheduled = true;
        this.taskQueue
            .add(async () => {
                if (this.storage !== storage) {
                    this._embeddingQueueScheduled = false;
                    return 0;
                }
                this._embeddingQueueScheduled = false;
                this._embeddingQueueActive = true;
                try {
                    const runnableRoots = this._getRunnableRoots();
                    if (this.storage !== storage || runnableRoots.length === 0) return 0;
                    return await storage.processEmbeddingQueue(() => this._shouldYieldEmbeddingQueue(), {
                        activeRoots: runnableRoots,
                        currentWorkspace: this._findWorkspaceRoot(this._currentWorkspace, runnableRoots)
                    });
                } finally {
                    this._embeddingQueueActive = false;
                }
            })
            .catch((error) => {
                this._embeddingQueueScheduled = false;
                this._embeddingQueueActive = false;
                logger.warn(`[filemgr] embedding queue failed: ${error?.message ?? error}`, error);
                void this._emitStatusChanged('embedding-queue-error');
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

        // On OpenHarmony, files are sandboxed and there is no risk of
        // multiple processes competing for the lock. Skip the file lock
        // entirely and just clean up any leftover from a previous run.
        if (process.platform === 'openharmony') {
            await lockfile.unlock(lockPath).catch(() => {});
            try {
                fs.unlinkSync(lockPath);
            } catch {}
            try {
                fs.rmSync(lockPath + '.lock', { recursive: true, force: true });
            } catch {}
            this._releaseScanLock = async () => {};
            return true;
        }

        const MAX_RETRIES = 10;
        const RETRY_DELAY = 1500;

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                // realpath:false: the mutex is the scan.lock.lock dir; scan.lock itself is
                // never pre-created and every instance uses the same absolute path, so
                // proper-lockfile's default realpath (which requires the file to exist) only
                // caused ENOENT. Stale recovery is left to proper-lockfile's built-in stale/update.
                this._releaseScanLock = await lockfile.lock(lockPath, { retries: 0, realpath: false });
                if (attempt > 0) {
                    logger.info(`[filemgr] scan lock acquired after ${attempt} retries`);
                }
                return true;
            } catch (error) {
                if (attempt === MAX_RETRIES) {
                    logger.warn(
                        `[filemgr] scan lock unavailable after ${MAX_RETRIES} retries, entering query mode: ${error.message}`
                    );
                    return false;
                }

                logger.info(
                    `[filemgr] scan lock held by another instance, retrying in ${RETRY_DELAY}ms (attempt ${attempt + 1}/${MAX_RETRIES})`
                );
                await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
            }
        }

        return false;
    }

    async _stopScanners() {
        for (const scanner of this.scanners.values()) {
            await scanner.stop().catch((err) => {
                logger.error(`[filemgr] stop scanner failed: ${err.message}`);
            });
        }
        this.scanners.clear();
    }

    async _closeStorage() {
        // FSStorage owns current and failed temporary holders. Await their release
        // before discarding it or releasing the scan lock; failure keeps it retryable.
        if (this.storage?.close) await this.storage.close();
        else await this.storage?.storage?.close?.();
        this.storage = null;
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
        await this._closeStorage();
        await this._releaseScanLockIfHeld(context);
        this._readonlyMode = false;
        this._setStatus('idle', context);
    }

    _scheduleInitializeContinuation(seq, reason, pendingControl = {}) {
        const configOperation = this._configChangeOperation;
        const completion = this.runSequentially(async () => {
            await this._continueInitializeAfterProbe(seq, reason, pendingControl);
        });
        void completion.catch((error) => {
            if (seq !== this._initSeq) return;
            this._initializing = false;
            this._initError = error;
            logger.error(`[filemgr] initialize continuation queue error: ${error.message}`, error);
            this._setStatus('error', 'init-continuation-failed');
        });
        if (seq === this._initSeq && configOperation && configOperation.config === this.config)
            this._trackConfigChange(configOperation.config, completion);
    }

    async _continueInitializeAfterProbe(seq, reason, pendingControl = {}) {
        if (this._probeContinuationSeq !== null && this._probeContinuationSeq !== seq) {
            logger.info(
                `[filemgr] replacing probe continuation oldSeq=${this._probeContinuationSeq}, newSeq=${seq}, reason=${reason}`
            );
        }
        this._probeContinuationSeq = seq;
        try {
            if (!this.storage || seq !== this._initSeq || this._readonlyMode) return;
            await this._finishConfigChange(seq, reason);
        } catch (error) {
            if (seq !== this._initSeq) return;
            logger.error(`[filemgr] initialize continuation error: ${error.message}`, error);
            if (this.status === 'initializing') {
                this._initError = error;
                this._setStatus('error', 'init-continuation-failed');
            }
        } finally {
            if (seq === this._initSeq) {
                this._initializing = false;
                if (pendingControl.embeddingConfigToken === this._pendingEmbeddingConfigChangeToken)
                    this._pendingEmbeddingConfigChange = false;
            }
            if (this._probeContinuationSeq === seq) this._probeContinuationSeq = null;
        }
    }

    async initialize() {
        this.config = this._normalizeConfig(this.config);
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
                this._lastConfig = null;
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
            await this._teardownRuntime('after initialize error').catch((cleanupError) => {
                logger.warn(`[filemgr] initialize cleanup failed: ${cleanupError.message}`);
            });
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
            throw error;
        });
    }

    /**
     * @param {object[]} filesystems
     */
    async _startScanners(filesystems, { isCurrent = () => true } = {}) {
        if (!FILEMGR_SCANNING_ENABLED) {
            logger.info('[filemgr] scanning disabled — skip starting scanners');
            return;
        }
        const seen = new Set();
        const deduped = filesystems.filter((entry) => {
            if (seen.has(entry.root)) {
                logger.warn(`[filemgr] duplicate root ignored: ${entry.root}`);
                return false;
            }
            seen.add(entry.root);
            return true;
        });
        for (const fsEntry of deduped) {
            if (!isCurrent()) return;
            await this._startScanner(fsEntry, deduped, { allowPendingControl: true });
        }
    }

    async _startScanner(fsEntry, filesystems, { allowPaused = false, allowPendingControl = false } = {}) {
        const root = fsEntry.root;
        const state = this.storage?.scannerState?.roots?.[root];
        const existing = this.scanners.get(root);
        if (!state || (state.paused && !allowPaused)) {
            if (existing) {
                await existing.stop().catch(() => {});
                if (this.scanners.get(root) === existing) this.scanners.delete(root);
            }
            return null;
        }
        if (existing?.isRunning()) {
            if (!existing.requestImmediateScan(this.taskQueue, { allowPendingControl }))
                throw new Error(`scanner did not accept work for ${root}`);
            return existing;
        }
        if (existing) {
            await existing.stop().catch(() => {});
            if (this.scanners.get(root) === existing) this.scanners.delete(root);
        }
        const scanner = new FSScanner(fsEntry, this.storage, root, state, {
            onRebuildRequired: (reason) => this._rebuildAndRestart(reason),
            workerRef: this,
            getActiveRoots: () => this._getActiveRoots(),
            getScanInterval: (scannerRoot) => this._getScanIntervalForRoot(scannerRoot),
            shouldYield: () => this._hasPendingControlChange()
        });
        this.scanners.set(root, scanner);
        try {
            if (!(await scanner.start(this.taskQueue, { allowPendingControl })))
                throw new Error(`scanner did not accept work for ${root}`);
            return scanner;
        } catch (error) {
            await scanner.stop().catch(() => {});
            if (this.scanners.get(root) === scanner) this.scanners.delete(root);
            throw error;
        }
    }

    _scheduleRunnableWork({ allowPendingControl = false } = {}) {
        const runnableRoots = new Set(this._getRunnableRoots());
        for (const [root, scanner] of this.scanners) {
            if (runnableRoots.has(root)) {
                scanner.requestImmediateScan(this.taskQueue, { allowPendingControl });
            }
        }
        this._enqueueEmbeddingQueue({ allowPendingControl });
    }

    async _restartScanners({ isCurrent = () => true } = {}) {
        this._setStatus('initializing', 'restart-scanners');
        for (const scanner of this.scanners.values()) {
            await scanner.stop().catch((err) => {
                logger.error(`[filemgr] stop scanner failed: ${err.message}`);
            });
            if (!isCurrent()) return;
        }
        this.scanners.clear();

        const filesystems = this.config?.entries;
        if (!filesystems || filesystems.length === 0) {
            await this.storage.removeOrphanedItems();
            this._setStatus('idle', 'no-roots');
            return;
        }

        await this._startScanners(filesystems, { isCurrent });
        if (!isCurrent()) return;
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
                let rebuildError = null;
                try {
                    await this.storage.rebuildAll(reason);
                } catch (err) {
                    rebuildError = err;
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
                try {
                    await this._restartScanners();
                } catch (recoveryError) {
                    if (rebuildError) {
                        logger.error(
                            `[filemgr] scanner recovery after rebuild failed: ${recoveryError.message}`,
                            recoveryError
                        );
                    }
                    throw rebuildError ?? recoveryError;
                }

                if (!rebuildError) {
                    logger.info(`[filemgr] rebuild succeeded, scanners restarted`);
                } else if (!this.storage.isDeferred()) {
                    logger.warn(`[filemgr] scanners restarted with old storage; ` + `next scan may re-trigger rebuild`);
                } else {
                    logger.error(`[filemgr] scanners restarted in deferred state; ` + `will retry on next scan cycle`);
                }
                if (rebuildError) throw rebuildError;
            } finally {
                if (this.status === 'initializing')
                    this._setStatus(
                        [...this.scanners.values()].some((scanner) => scanner.isRunning()) ? 'running' : 'idle',
                        'rebuild-settled'
                    );
                this._rebuildQueued = false;
                this._currentRebuildPromise = null;
            }
        });
        return this._currentRebuildPromise;
    }

    _trackConfigChange(config, promise) {
        const operation = { config, promise };
        this._configChangeOperation = operation;
        const release = () => {
            if (this._configChangeOperation === operation) this._configChangeOperation = null;
        };
        void promise.then(release, release);
        return operation;
    }

    async applicationConfigChanged(config) {
        const normalizedConfig = this._normalizeConfig(config);
        return this._trackConfigChange(normalizedConfig, this._applyConfigChange(normalizedConfig)).promise;
    }

    async _applyConfigChange(normalizedConfig) {
        await super.applicationConfigChanged(normalizedConfig);

        this._currentWorkspace = Setting.getInstance().getData()?.default_workspace ?? null;
        if (this._readonlyMode) return;

        const seq = this._nextInitSeq();
        const myConfig = normalizedConfig;
        this._pendingConfigChange = myConfig;

        if (this._initializing) {
            this._scheduleInitializeContinuation(seq, 'config-changed');
            return;
        }

        if (!this.storage || this.status === 'error') {
            if (this._pendingConfigChange === myConfig) {
                this._pendingConfigChange = null;
            }
            return;
        }

        await this.runSequentially(async () => {
            if (seq !== this._initSeq || this._pendingConfigChange !== myConfig) return;
            await this._finishConfigChange(seq, 'filemgr config changed');
        });
    }

    async _finishConfigChange(seq, reason) {
        const storage = this.storage;
        const currentConfig = this.config;
        const target = this._normalizeConfig(currentConfig);
        const pendingConfig = this._pendingConfigChange;
        const embeddingToken = this._pendingEmbeddingConfigChange ? this._pendingEmbeddingConfigChangeToken : null;
        const isCurrent = () =>
            seq === this._initSeq && this.storage === storage && this.config === currentConfig && !this._readonlyMode;
        const release = () => {
            if (!isCurrent()) return;
            if (this._pendingConfigChange === pendingConfig) this._pendingConfigChange = null;
            if (embeddingToken !== null && embeddingToken === this._pendingEmbeddingConfigChangeToken)
                this._pendingEmbeddingConfigChange = false;
        };
        if (!storage || !isCurrent()) return;
        const previousConfig = this._lastConfig;
        const oldRoots = new Set([
            ...(previousConfig?.entries ?? []).map((entry) => entry.root),
            ...this.scanners.keys(),
            ...Object.keys(storage.scannerState.roots)
        ]);
        const allowed = new Map(target.entries.map((entry) => [entry.root, entry]));
        const healthy = [];
        this._lastConfig = null;
        let modeReady = false;
        try {
            for (const [root, scanner] of this.scanners) {
                if (allowed.has(root) && JSON.stringify(scanner.entry) === JSON.stringify(allowed.get(root))) {
                    if (scanner.isRunning()) healthy.push(root);
                    continue;
                }
                await scanner
                    .stop()
                    .catch((error) => logger.error(`[filemgr] stop scanner ${root}: ${error.message}`, error));
                if (this.scanners.get(root) === scanner) this.scanners.delete(root);
                if (!isCurrent()) return;
            }
            const previousMode = storage.mode;
            await storage.syncEmbeddingModeForStartup(reason);
            if (!isCurrent()) return;
            modeReady = true;
            // Startup has no running scanners yet; persisted configured roots still provide recovery ownership.
            if (this._initializing)
                for (const root of allowed.keys())
                    if (storage.scannerState.roots[root] && !healthy.includes(root)) healthy.push(root);
            if (storage.mode !== previousMode) void this._emitStatusChanged('mode');
            await this._detachRemovedRoots(previousConfig, target, { storage, isCurrent, roots: oldRoots });
            if (!isCurrent()) return;
            const missing = {};
            for (const root of allowed.keys())
                if (!storage.scannerState.roots[root])
                    missing[root] = {
                        last_full_scan: 0,
                        last_scan_at: null,
                        total_files: 0,
                        last_file_count: 0,
                        paused: false
                    };
            if (Object.keys(missing).length > 0) {
                await storage._writeScannerStateSnapshot(
                    { ...storage.scannerState, roots: { ...storage.scannerState.roots, ...missing } },
                    () => {
                        Object.assign(storage.scannerState.roots, missing);
                    }
                );
                if (!isCurrent()) return;
            }
            await storage.pruneUnownedUnavailableRoots(target.entries);
            if (!isCurrent()) return;
            release();
            await this._restartScanners({ isCurrent });
            if (!isCurrent()) return;
            this._lastConfig = target;
            this._enqueueEmbeddingQueue();
        } catch (error) {
            if (isCurrent()) {
                release();
                for (const root of healthy) {
                    if (!isCurrent()) break;
                    if (!storage.scannerState.roots[root]?.paused) {
                        try {
                            await this._startScanner(allowed.get(root), target.entries, { allowPendingControl: true });
                        } catch (recoveryError) {
                            logger.error(
                                `[filemgr] healthy scanner recovery ${root}: ${recoveryError.message}`,
                                recoveryError
                            );
                        }
                    }
                }
                if (isCurrent() && modeReady)
                    this._setStatus(
                        [...this.scanners.values()].some((scanner) => scanner.isRunning()) ? 'running' : 'idle',
                        'config-failed'
                    );
            }
            throw error;
        } finally {
            release();
        }
    }

    async reconcileConfig(config) {
        const latestConfig = this._normalizeConfig(config);
        let operation = this._configChangeOperation;
        let reconciled = false;
        if (!operation || operation.config !== this.config || !this._isSameConfig(operation.config, latestConfig)) {
            if (
                !operation &&
                !this._pendingConfigChange &&
                this._isSameConfig(this._lastConfig, latestConfig) &&
                this._isSameConfig(this.config, latestConfig)
            ) {
                return { status: 'ok', reconciled: false };
            }
            operation = this._trackConfigChange(latestConfig, this._applyConfigChange(latestConfig));
            reconciled = true;
        }

        const requestedConfig = operation.config;
        // Observe outside the serial queue. Initialization/embedding may take over the
        // same config object; an equal but newer config (including ABA) is a different operation.
        for (;;) {
            let failure;
            try {
                await operation.promise;
            } catch (error) {
                failure = error;
            }
            const successor = this._configChangeOperation;
            if (successor && successor !== operation && successor.config === requestedConfig) {
                operation = successor;
                continue;
            }
            if (failure) throw failure;
            if (
                this.config !== requestedConfig ||
                (!this._readonlyMode && !this._isSameConfig(this._lastConfig, requestedConfig))
            ) {
                return { status: 'error', message: 'FileMgr configuration was superseded or could not be applied.' };
            }
            return { status: 'ok', reconciled };
        }
    }

    async embeddingConfigChanged() {
        this._currentWorkspace = Setting.getInstance().getData()?.default_workspace ?? null;
        if (this._readonlyMode) return { status: 'ok', data: await this.getFileSystemStatus() };

        const seq = this._nextInitSeq();
        const configOperation = this._configChangeOperation;
        const token = ++this._pendingEmbeddingConfigChangeToken;
        this._pendingEmbeddingConfigChange = true;
        const clearPendingEmbeddingConfig = () => {
            if (token === this._pendingEmbeddingConfigChangeToken) {
                this._pendingEmbeddingConfigChange = false;
            }
        };

        if (this._initializing) {
            this._scheduleInitializeContinuation(seq, 'embedding config changed', { embeddingConfigToken: token });
            return { status: 'ok', data: await this.getFileSystemStatus() };
        }

        if (!this.storage || this.status === 'error') {
            clearPendingEmbeddingConfig();
            return { status: 'ok', data: await this.getFileSystemStatus() };
        }

        const completion = this.runSequentially(async () => {
            if (seq !== this._initSeq || token !== this._pendingEmbeddingConfigChangeToken) return;
            try {
                const target = this.config;
                if (this._pendingConfigChange || !this._isSameConfig(this._lastConfig, target)) {
                    await this._finishConfigChange(seq, 'embedding config changed');
                    return;
                }
                const storage = this.storage;
                if (!storage) return;
                const previousMode = storage.mode;
                await storage.syncEmbeddingModeForStartup('embedding config changed');
                if (seq !== this._initSeq || this.storage !== storage) return;
                if (storage.mode !== previousMode) void this._emitStatusChanged('mode');
                clearPendingEmbeddingConfig();
                for (const scanner of this.scanners.values())
                    scanner.requestImmediateScan?.(this.taskQueue, { allowPendingControl: true });
            } finally {
                if (seq === this._initSeq) clearPendingEmbeddingConfig();
            }
        });
        if (configOperation && configOperation.config === this.config)
            this._trackConfigChange(configOperation.config, completion);
        await completion;

        return { status: 'ok', data: await this.getFileSystemStatus() };
    }

    async _detachRemovedRoots(oldConfig, config, { storage = this.storage, isCurrent = () => true, roots } = {}) {
        const oldRoots =
            roots ??
            new Set([
                ...(oldConfig?.entries ?? []).map((entry) => entry.root),
                ...this.scanners.keys(),
                ...Object.keys(storage?.scannerState?.roots ?? {})
            ]);
        const newRoots = new Set((config?.entries ?? []).map((entry) => entry.root));
        for (const removed of oldRoots) {
            if (!isCurrent()) return oldRoots;
            if (!newRoots.has(removed)) await storage.detachRootForConfigChange(removed, config?.entries ?? []);
            if (!isCurrent()) return oldRoots;
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

        const entries = this._getVisibleConfigEntries();
        if (status === 'idle') {
            return entries.length === 0 ? [{ code: 'no_roots' }] : [];
        }

        if (status === 'initializing') return [];

        if ((status === 'running' || status === 'readonly') && mode === 'base-only') {
            const probeError = this.storage?.scannerState.probe_error;
            if (probeError) {
                return [{ code: probeError.code === 'dim_unsupported' ? 'dim_unsupported' : 'embedding_unavailable' }];
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

    _getEffectiveUnavailableRoots() {
        const unavailable = this.storage?.scannerState?.unavailable_roots ?? {};
        if (!this._readonlyMode) return unavailable;
        const configured = new Set(this._getVisibleConfigEntries().map((entry) => entry.root));
        return Object.fromEntries(
            Object.entries(unavailable).filter(
                ([root]) => configured.has(root) || this.storage?.scannerState?.roots?.[root]
            )
        );
    }

    _deriveSourceState(root, counts, mode) {
        if (this.storage?.scannerState?.roots?.[root]?.paused === true) return 'paused';
        if (this._getEffectiveUnavailableRoots()[root]) return 'unavailable';
        if (this.storage?.scannerState?.roots?.[root]?.metadata_write_pending === true) return 'pending';
        if (counts.total_files === 0) return counts.last_scan_at === null ? 'pending' : 'completed';
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

    _buildLightweightStatusSnapshot({ status, platform, isOpenHarmony, homePath }) {
        const entries = this._getVisibleConfigEntries();
        const defaultWorkspace = this._getDefaultWorkspace();
        const workspaceRoot = this._findWorkspaceRoot(
            defaultWorkspace,
            entries.map((entry) => entry.root)
        );
        const sources = entries.map((entry) => {
            const rootState = this.storage?.scannerState?.roots?.[entry.root];
            const paused = rootState?.paused === true;
            return {
                root: entry.root,
                entry,
                paused,
                metadata_write_pending: rootState?.metadata_write_pending === true,
                state: paused ? 'paused' : this._getEffectiveUnavailableRoots()[entry.root] ? 'unavailable' : 'pending',
                last_scan_at: rootState?.last_scan_at ?? null,
                total_files: rootState?.total_files ?? 0,
                embedded_count: 0,
                pending_count: 0,
                failed_count: rootState?.last_failed_count ?? 0,
                is_workspace: entry.root === workspaceRoot
            };
        });

        return {
            status,
            mode: null,
            default_workspace: defaultWorkspace,
            alerts: this._buildAlerts(status, null),
            sources,
            totals: null,
            storage_stats: null,
            last_rebuild_event: this.storage?.scannerState?.last_rebuild_event ?? null,
            scanners: [],
            storage: null,
            isDeferred: this.storage?.isDeferred?.() ?? false,
            deferredReason: this.storage?.deferredReason ?? null,
            probe_error: this.storage?.scannerState?.probe_error ?? null,
            unavailable_roots: this._getEffectiveUnavailableRoots(),
            readonly: this._readonlyMode ?? false,
            platform,
            is_openharmony: isOpenHarmony,
            home_path: homePath
        };
    }

    async getFileSystemStatus() {
        const status = this._getEffectiveStatus();
        const mode = this._computeMode(status);

        const platform = process.platform;
        const isOpenHarmony = platform === 'openharmony';
        const homePath = getHomeDir();

        if (status !== 'running' && status !== 'readonly') {
            return this._buildLightweightStatusSnapshot({ status, platform, isOpenHarmony, homePath });
        }

        const storageStatus = this.storage ? await this.storage.getStatus() : null;

        // Degraded snapshot when the store is unavailable: this.storage null (pre-init), or
        // readonly-deferred (open_failed / missing_base_index) where FSStorage exists but its
        // inner store is null so getStatus() returns null. Without this guard, building
        // storage_stats below dereferences null ("Cannot read properties of null (db_size)").
        if (!this.storage || !storageStatus) {
            return this._buildLightweightStatusSnapshot({ status, platform, isOpenHarmony, homePath });
        }
        const entries = this._getVisibleConfigEntries();
        const roots = entries.map((entry) => entry.root);
        const perRootCounts = await this.storage.getPerRootCounts(roots);
        const defaultWorkspace = this._getDefaultWorkspace();
        const workspaceRoot = this._findWorkspaceRoot(
            defaultWorkspace,
            entries.map((entry) => entry.root)
        );
        const scannerList = [...this.scanners.values()].map((scanner) => ({
            entry: scanner.entry,
            root: scanner.root,
            lastFullScan: scanner.state.last_full_scan,
            totalFiles: scanner.state.total_files,
            isRunning: scanner.isRunning(),
            recentFailures: scanner._recentFailures ?? []
        }));

        const sources = entries.map((entry) => {
            const rootState = this.storage?.scannerState?.roots?.[entry.root];
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
                paused: rootState?.paused === true,
                metadata_write_pending: rootState?.metadata_write_pending === true,
                state: this._deriveSourceState(entry.root, counts, mode),
                last_scan_at: counts.last_scan_at,
                total_files: counts.total_files,
                embedded_count: counts.embedded_count,
                pending_count: counts.pending_count,
                failed_count: counts.failed_count ?? 0,
                is_workspace: entry.root === workspaceRoot
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
            probe_error: this.storage.scannerState.probe_error,
            unavailable_roots: this._getEffectiveUnavailableRoots(),
            readonly: this._readonlyMode ?? false,
            platform,
            is_openharmony: isOpenHarmony,
            home_path: homePath
        };
    }

    async _getSourceControlSnapshot() {
        try {
            return await this.getFileSystemStatus();
        } catch (error) {
            logger.warn(`[filemgr] source control snapshot degraded: ${error?.message ?? error}`);
            const platform = process.platform;
            let homePath = '';
            try {
                homePath = os.homedir?.() ?? '';
            } catch {}
            return this._buildLightweightStatusSnapshot({
                status: this._getEffectiveStatus(),
                platform,
                isOpenHarmony: platform === 'openharmony',
                homePath: homePath || process.env.HOME || process.env.USERPROFILE || ''
            });
        }
    }

    async _sourceControlError(code) {
        return { status: 'error', code, data: await this._getSourceControlSnapshot() };
    }

    async setSourcePaused(request) {
        const root = request?.root;
        const paused = request?.paused;
        if (typeof root !== 'string' || root.length === 0 || typeof paused !== 'boolean') {
            return this._sourceControlError('invalid_request');
        }
        if (this._readonlyMode) return this._sourceControlError('readonly');
        if (!this.storage || this.status === 'error' || this.status === 'initializing') {
            return this._sourceControlError('not_ready');
        }
        if (!this._getVisibleConfigEntries().some((entry) => entry.root === root)) {
            return this._sourceControlError('unknown_root');
        }

        const token = this._registerSourceControlIntent();
        let result;
        let started = false;
        try {
            await this.runSequentially(async () => {
                started = true;
                this._consumeSourceControlIntent(token);
                const entries = this._getVisibleConfigEntries();
                const entry = entries.find((candidate) => candidate.root === root);
                const rootState = this.storage?.scannerState?.roots?.[root];
                if (!entry) {
                    result = await this._sourceControlError('unknown_root');
                    return;
                }
                if (!rootState) {
                    result = await this._sourceControlError('not_ready');
                    return;
                }

                if (paused) {
                    const scanner = this.scanners.get(root) ?? null;
                    if (scanner) {
                        await scanner.stop();
                        this.scanners.delete(root);
                    }
                    try {
                        if (rootState.paused !== true) await this.storage.setRootPaused(root, true);
                    } catch (error) {
                        logger.warn(`[filemgr] pause persistence failed for ${root}: ${error?.message ?? error}`);
                        if (scanner) {
                            await this._startScanner(entry, entries, {
                                allowPaused: true,
                                allowPendingControl: true
                            });
                        }
                        result = await this._sourceControlError('persistence_failed');
                        return;
                    }
                } else {
                    if (!FILEMGR_SCANNING_ENABLED) {
                        result = await this._sourceControlError('runtime_failed');
                        return;
                    }
                    let scanner;
                    try {
                        scanner = await this._startScanner(entry, entries, {
                            allowPaused: true,
                            allowPendingControl: true
                        });
                        if (!scanner?.isRunning()) {
                            result = await this._sourceControlError('runtime_failed');
                            return;
                        }
                    } catch (error) {
                        logger.warn(`[filemgr] resume runtime failed for ${root}: ${error?.message ?? error}`);
                        result = await this._sourceControlError('runtime_failed');
                        return;
                    }
                    try {
                        if (rootState.paused !== false) await this.storage.setRootPaused(root, false);
                    } catch (error) {
                        logger.warn(`[filemgr] resume persistence failed for ${root}: ${error?.message ?? error}`);
                        await scanner?.stop().catch(() => {});
                        this.scanners.delete(root);
                        result = await this._sourceControlError('persistence_failed');
                        return;
                    }
                }

                this._scheduleRunnableWork({ allowPendingControl: true });
                result = { status: 'ok', data: await this._getSourceControlSnapshot() };
            });
        } catch (error) {
            logger.warn(`[filemgr] source control failed for ${root}: ${error?.message ?? error}`);
            result = await this._sourceControlError('runtime_failed');
        } finally {
            if (!started) this._consumeSourceControlIntent(token);
        }
        return result;
    }

    async getStatus() {
        return { status: 'ok', data: await this.getFileSystemStatus() };
    }

    async forceRefreshScan() {
        if (this._readonlyMode) {
            return { status: 'error', warning: WARNINGS.READONLY_MODE, message: '查询模式不支持手动刷新' };
        }
        if (!this.storage || this.status === 'error') {
            return { status: 'error', message: '文件系统尚未就绪' };
        }

        await this.runSequentially(async () => {
            for (const scanner of this.scanners.values()) {
                scanner.requestImmediateScan?.(this.taskQueue);
            }
        });

        return { status: 'ok', data: await this.getFileSystemStatus() };
    }

    async workspaceChanged(defaultWorkspace) {
        if (typeof defaultWorkspace === 'string') {
            const pendingWorkspace = { workspace: defaultWorkspace };
            this._pendingWorkspaceChange = pendingWorkspace;
            await this.runSequentially(async () => {
                if (this._pendingWorkspaceChange !== pendingWorkspace) return;
                try {
                    this._currentWorkspace = defaultWorkspace;
                    try {
                        const data = Setting.getInstance().getData();
                        Setting.updateInstanceData({ ...data, default_workspace: defaultWorkspace });
                    } catch (error) {
                        logger.warn(`[filemgr] failed to update default workspace marker: ${error?.message ?? error}`);
                    }

                    const workspaceRoot = this._findWorkspaceRoot(defaultWorkspace) ?? defaultWorkspace;
                    if (!this._readonlyMode && this.storage?.scannerState?.roots) {
                        if (!this.storage.scannerState.roots[workspaceRoot]) {
                            this.storage.scannerState.roots[workspaceRoot] = {
                                last_full_scan: 0,
                                last_scan_at: null,
                                total_files: 0,
                                last_file_count: 0,
                                paused: false
                            };
                        } else {
                            this.storage.scannerState.roots[workspaceRoot].last_full_scan = 0;
                        }
                        await this.storage.saveScannerState?.();
                        if (this._pendingWorkspaceChange !== pendingWorkspace) return;
                        this._pendingWorkspaceChange = null;
                        this.scanners
                            .get(workspaceRoot)
                            ?.requestImmediateScan?.(this.taskQueue, { allowPendingControl: true });
                    }
                } finally {
                    if (this._pendingWorkspaceChange === pendingWorkspace) {
                        this._pendingWorkspaceChange = null;
                    }
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

    _checkIndexedSearchPreconditions(context) {
        if (!this.storage || this.storage.isDeferred()) {
            return toIndexedFileSearchResult(context.query, [], 0, WARNINGS.DEFERRED, CODES.INDEX_NOT_READY);
        }
        if (!context.query) return toIndexedFileSearchResult(context.query, [], 0);
        return null;
    }

    async _runKeywordRoute(context) {
        try {
            const search = this.storage.searchIndexedFilesByKeyword ?? this.storage.searchFilesByKeyword;
            const results = await search.call(this.storage, context.query, {
                limit: context.topK * 3,
                terms: context.keywordTerms,
                scope: context.scope
            });
            return { route: 'keyword', success: true, results };
        } catch (error) {
            logger.warn(`[filemgr] searchIndexedFiles keyword failed: ${error.message}`);
            return { route: 'keyword', success: false, results: [], error };
        }
    }

    async _runNameSemanticRoute(context) {
        try {
            const owner = context.semanticOwner ?? this.storage;
            if (!owner || owner.isDeferred()) return { route: 'name_semantic', success: false, results: [] };
            const result = await owner.searchFileByName(context.query, {
                topK: Math.min(context.topK * 2, 200),
                scope: context.scope
            });
            return { route: 'name_semantic', success: !result?.code, results: result?.results ?? [] };
        } catch (error) {
            logger.warn(`[filemgr] searchIndexedFiles name semantic failed: ${error.message}`);
            return { route: 'name_semantic', success: false, results: [], error };
        }
    }

    async _runContentSemanticRoute(context) {
        try {
            const owner = context.semanticOwner ?? this.storage;
            if (!owner || owner.isDeferred()) return { route: 'content_semantic', success: false, results: [] };
            const result = await owner.searchIndexedChunks(context.query, {
                topK: Math.min(context.topK * 3, 5000),
                scope: context.scope
            });
            return {
                route: 'content_semantic',
                success: !result?.code,
                results: result?.code
                    ? []
                    : groupIndexedChunksByFile(result?.results ?? [], Math.min(context.topK * 2, 200))
            };
        } catch (error) {
            logger.warn(`[filemgr] searchIndexedFiles content semantic failed: ${error.message}`);
            return { route: 'content_semantic', success: false, results: [], error };
        }
    }

    async _finalizeIndexedSearch(context, outcomes, initialWarning, initialCode) {
        const currentOutcomes = () =>
            outcomes.map((outcome) => {
                if (outcome.route === 'keyword') return outcome;
                if (
                    this.storage &&
                    this.storage === context.semanticOwner &&
                    !this.storage.isDeferred() &&
                    (!context.semanticGuarded || this.storage.isSemanticSearchContextCurrent(context.semanticContext))
                )
                    return outcome;
                return { ...outcome, success: false, results: [] };
            });
        const merge = (routes) => {
            const byRoute = Object.fromEntries(routes.map((outcome) => [outcome.route, outcome.results]));
            return mergeSearchRoutes({
                keyword: byRoute.keyword ?? [],
                nameSemantic: byRoute.name_semantic ?? [],
                contentSemantic: byRoute.content_semantic ?? []
            });
        };
        // Finalize may clear the owner during any search await. Plain metadata
        // captured before release remains usable for keyword policy checks.
        const unavailableRoots = () =>
            this.storage && !this.storage.isDeferred()
                ? this._getEffectiveUnavailableRoots()
                : (context.unavailableRoots ?? {});
        const merged = merge(currentOutcomes());
        const filtered = await filterIndexedResults(merged, {
            entries: this._getVisibleConfigEntries(),
            unavailableRoots: unavailableRoots(),
            scope: context.requestedScope,
            currentWorkspace: this._currentWorkspace,
            statFile: (filePath) => this._statFileForSearch(filePath),
            concurrency: 16
        });
        // A reset can also finish during final filesystem checks. Re-merge only
        // current routes so stale snippets/scores disappear from keyword matches.
        outcomes = currentOutcomes();
        const keptPaths = new Set(filtered.map((item) => item.path));
        const currentFiltered = merge(outcomes).filter((item) => keptPaths.has(item.path));
        const failed = outcomes.filter((outcome) => !outcome.success);
        const succeeded = outcomes.filter((outcome) => outcome.success);
        if (failed.length > 0 && succeeded.length === 0) {
            return toIndexedFileSearchResult(context.query, [], 0, WARNINGS.SEARCH_FAILED, CODES.SEARCH_FAILED);
        }
        let warning = initialWarning;
        let code = initialCode;
        if (failed.length > 0) {
            const keywordFailed = failed.some((outcome) => outcome.route === 'keyword');
            warning = keywordFailed ? WARNINGS.SEARCH_PARTIAL : WARNINGS.SEMANTIC_PARTIAL;
            code = keywordFailed ? CODES.SEARCH_PARTIAL : CODES.SEMANTIC_PARTIAL;
        }
        const latestEntries = this._getVisibleConfigEntries();
        const latestUnavailableRoots = unavailableRoots();
        try {
            resolveFilemgrSearchScopeForEntries(context.requestedScope, {
                entries: latestEntries,
                unavailableRoots: latestUnavailableRoots
            });
        } catch (error) {
            if (error instanceof InvalidFilemgrSearchScopeError) {
                return invalidIndexedSearchScopeResult(context.query);
            }
            throw error;
        }
        const finalFiltered = filterIndexedResultsByPolicy(currentFiltered, {
            entries: latestEntries,
            unavailableRoots: latestUnavailableRoots,
            scope: context.requestedScope
        });
        const ranked = rankSearchResults(finalFiltered, { currentWorkspace: this._currentWorkspace }).slice(
            0,
            context.topK
        );
        return toIndexedFileSearchResult(context.query, ranked, finalFiltered.length, warning, code);
    }

    async searchIndexedFiles(query, options = {}) {
        let context;
        try {
            context = createIndexedSearchContext(query, options);
        } catch (error) {
            if (error instanceof InvalidFilemgrSearchScopeError) {
                return invalidIndexedSearchScopeResult(query);
            }
            throw error;
        }

        try {
            const resolution = resolveFilemgrSearchScopeForEntries(context.scope, {
                entries: this._getVisibleConfigEntries(),
                unavailableRoots: this._getEffectiveUnavailableRoots()
            });
            context = {
                ...context,
                requestedScope: resolution.requestedScope,
                scope: resolution.effectiveScope,
                coversAllSources: resolution.coversAllSources
            };
        } catch (error) {
            if (error instanceof InvalidFilemgrSearchScopeError) {
                return invalidIndexedSearchScopeResult(query);
            }
            throw error;
        }

        const earlyResult = this._checkIndexedSearchPreconditions(context);
        if (earlyResult) return earlyResult;

        context = { ...context, unavailableRoots: { ...this._getEffectiveUnavailableRoots() } };
        const outcomes = [];
        if (context.routes.keyword) outcomes.push(await this._runKeywordRoute(context));
        // Keyword awaits may promote base-only storage. Fix the model context
        // at the first semantic route, then keep it through all routes/stat checks.
        context = {
            ...context,
            semanticOwner: this.storage,
            semanticGuarded: typeof this.storage?.getSemanticSearchContext === 'function',
            semanticContext: this.storage?.getSemanticSearchContext?.()
        };
        let warning;
        let code;
        if (context.routes.needsSemantic) {
            if (this.storage?.mode === 'full') {
                if (context.routes.nameSemantic) outcomes.push(await this._runNameSemanticRoute(context));
                if (context.routes.contentSemantic) outcomes.push(await this._runContentSemanticRoute(context));
            } else {
                warning = this.storage ? WARNINGS.NO_EMBEDDING_MODEL : WARNINGS.DEFERRED;
                code = this.storage ? CODES.EMBED_UNAVAILABLE : CODES.INDEX_NOT_READY;
            }
        }

        try {
            resolveFilemgrSearchScopeForEntries(context.requestedScope, {
                entries: this._getVisibleConfigEntries(),
                unavailableRoots: this._getEffectiveUnavailableRoots()
            });
        } catch (error) {
            if (error instanceof InvalidFilemgrSearchScopeError) {
                return invalidIndexedSearchScopeResult(query);
            }
            throw error;
        }

        return this._finalizeIndexedSearch(context, outcomes, warning, code);
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
     * 在 Worker 线程中提取文件文本，避免 CPU 密集型解析阻塞主线程。
     * @param {string} filePath
     * @returns {Promise<string | null>}
     */
    async extractFileText(filePath) {
        return await extractFileTextFromParser(filePath);
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
