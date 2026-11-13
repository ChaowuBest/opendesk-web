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

import { createRetrieval } from './document-retrieval/create-retrieval.js';
import { recordStorageCleanupFailure } from '../../services/storage/platform.js';
import { assertWasmStoresUnlocked } from '../../services/storage/drop-utils.js';
import { dropBaseIndexStore } from '../../services/storage/base-index-db-factory.js';
import { dropVectorIndexStore } from '../../services/storage/vector-index-db-factory.js';
import { dropChunkIndexStore } from '../../services/storage/chunk-index-db-factory.js';
import { CODES } from './document-retrieval/contract.js';
import { resolveDriveRootPath } from './utils.js';
import { getOpendeskDirectory, Setting } from '../../utils/setting.js';
import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import { BaseStorage } from '../../services/storage/abstract-storage.js';
import path from 'path';
import fs from 'fs';
import { t } from '../../../locale/index.js';
import { buildIndexedFilePreconditions, normalizeFilemgrSearchScope } from './search/indexed.js';
// ── Code constants (not in config schema) ──────────────────────────
const NORMAL_SCAN_INTERVAL_MS = 5 * 60 * 1000;
const WORKSPACE_SCAN_INTERVAL_MS = 60 * 1000;
const WORKSPACE_SCAN_INTERVAL_WHILE_EMBEDDING_MS = 180 * 1000;
const QUERY_LIMIT = 50;
const WORKSPACE_EMBEDDING_PRIORITY_WEIGHT = 2;
const HARMONY_PER_ROOT_COUNT_CACHE_TTL_MS = 10_000;

// ── User-facing warning strings ────────────────────────────────────
const WARNINGS = {
    NO_EMBEDDING_MODEL: '未配置向量嵌入模型，语义搜索不可用。请运行 /config 配置"向量嵌入模型"。',
    NO_ROOTS: '未配置扫描目录，没有任何文件被索引。请运行 /config 添加文件扫描路径。',
    INITIAL_SCAN: '首次扫描进行中，索引数据可能不完整。如结果为空或不理想，请稍后重试。',
    EMBED_API_DOWN: 'embedding API 暂时不可用，请稍后重试。',
    DEFERRED: '文件索引尚未就绪，请稍后重试。',
    READONLY_MODE: 'READONLY_MODE',
    SEMANTIC_PARTIAL: '部分智能内容搜索暂不可用，已显示可用结果',
    get SEARCH_PARTIAL() {
        return t('filemgr.search.partial');
    },
    get SEARCH_FAILED() {
        return t('filemgr.search.failed');
    },
    get INVALID_SCOPE() {
        return t('filemgr.search.invalid_scope');
    }
};

function toStorageTimestamp(value) {
    return Math.floor(Number(value) || 0);
}

function normalizeRootPath(value) {
    value = resolveDriveRootPath(value, process.platform);
    // 统一为正斜杠：Windows 上 item_id 来自 fast-glob（正斜杠），而 root 可能来自
    // os.homedir() 等反斜杠来源，前缀区间查询必须与 item_id 同向才能命中
    const normalized = String(value).replace(/\\/g, '/').replace(/\/+/g, '/');
    if (normalized === '/') return normalized;
    return normalized.replace(/\/+$/, '');
}

function isSameOrAncestor(ancestor, itemPath) {
    const normalizedAncestor = normalizeRootPath(ancestor);
    const normalizedItem = normalizeRootPath(itemPath);
    if (normalizedAncestor === '/') return normalizedItem.startsWith('/');
    return normalizedItem === normalizedAncestor || normalizedItem.startsWith(`${normalizedAncestor}/`);
}

function failedDirectoryMatcher(directories) {
    const pathAPI = process.platform === 'win32' ? path.win32 : path.posix;
    const comparisonPath = (value) => {
        const normalized = pathAPI.normalize(resolveDriveRootPath(value, process.platform));
        if (normalized === pathAPI.parse(normalized).root) return normalized;
        return normalized.replace(process.platform === 'win32' ? /[/\\]+$/ : /\/+$/, '');
    };
    const failed = new Set([...directories].map(comparisonPath));
    return (itemPath) => {
        if (failed.size === 0) return false;
        let parent = comparisonPath(itemPath);
        while (true) {
            if (failed.has(parent)) return true;
            const next = pathAPI.dirname(parent);
            if (next === parent) return false;
            parent = next;
        }
    };
}

function nextLexicographicPrefix(value) {
    if (!value) return '\uffff';
    const lastIndex = value.length - 1;
    const lastCode = value.charCodeAt(lastIndex);
    if (lastCode >= 0xffff) return `${value}\u0000`;
    return `${value.slice(0, lastIndex)}${String.fromCharCode(lastCode + 1)}`;
}

// ── Search result shape ────────────────────────────────────────────
/**
 * 文件级 search 方法返回 SearchResultItem[] —— 业务字段，永远不
 * 暴露内部存储字段（item_id/item_type/ext/chunk_text/root_refs）。
 *
 * 注意：FSStorage 的 search 方法假设 this.storage 已 initialize。deferred
 * 状态检查由 worker 层负责，不要绕
 * 过 worker 直接调 FSStorage 的 search 方法。
 *
 * @typedef {object} SearchResultItem
 * @property {string} path        文件绝对路径（= item_id）
 * @property {string} filename    文件名
 * @property {number} modified    最近修改时间戳（毫秒）
 * @property {number} size        文件大小（字节）
 * @property {string | null} snippet  命中的内容片段
 */

// ── Zod schema ─────────────────────────────────────────────────────
const FileEntrySchema = z.object({
    path: z.string(),
    filename: z.string(),
    size: z.number(),
    modified: z.number(),
    created: z.number(),
    accessed: z.number(),
    type: z.enum(['file', 'directory'])
});

// ── Error classes ──────────────────────────────────────────────────
class RebuildRequiredError extends Error {
    constructor(reason) {
        super(`rebuild required: ${reason}`);
        this.name = 'RebuildRequiredError';
        this.reason = reason;
    }
}

// ── Schema factory ─────────────────────────────────────────────────
/**
 * @param {number} dim - embedding dimension from runtime probe
 * @param {{mode?: 'full' | 'base-only'}} [options]
 * @returns {import('../../services/storage/abstract-storage.js').ColumnSchema}
 */
function makeSchema(dim, { mode = 'full' } = {}) {
    const columns = {
        item_id: { type: 'TEXT', nullable: false },
        item_type: { type: 'TEXT', nullable: false },
        filename: { type: 'TEXT', nullable: true },
        ext: { type: 'TEXT', nullable: true },
        size: { type: 'INTEGER', nullable: true },
        modified: { type: 'INTEGER', nullable: true },
        created: { type: 'INTEGER', nullable: true },
        accessed: { type: 'INTEGER', nullable: true },
        type: { type: 'TEXT', nullable: true },
        chunk_text: { type: 'TEXT', nullable: true },
        root_refs: { type: 'TEXT', nullable: false, defaultValue: '[]' },
        ref_count: { type: 'INTEGER', nullable: false, defaultValue: 0 },
        embedded: { type: 'INTEGER', nullable: false, defaultValue: 0 },
        embedding_generation: { type: 'INTEGER', nullable: false, defaultValue: 0 }
    };

    if (mode === 'base-only') {
        return { columns, needIndexers: {} };
    }

    return {
        columns,
        needIndexers: {
            filename: [{ indexer: 'VectorIndexer', options: { dim } }],
            chunk_text: [{ indexer: 'ChunkIndexer', options: { dim } }]
        }
    };
}

// ── Default scanner state ──────────────────────────────────────────
function defaultScannerState(embeddingState) {
    return {
        version: 1,
        ...embeddingState,
        _migratedRefCount: false,
        roots: {},
        unavailable_roots: {}
    };
}

class FSStorage {
    /**
     * @param {string} appDataDirectory
     */
    constructor(appDataDirectory) {
        /** @type {BaseStorage | null} */
        this.storage = null;
        // Storage.close() may reject without releasing its connection. Keep every
        // failed holder (including temporary candidates) reachable until retry succeeds.
        this._pendingStorageClosures = new Set();
        this._appDataDirectory = appDataDirectory;
        this._storageDir = path.join(appDataDirectory, 'storage');
        this._stateWriteChain = Promise.resolve();

        this.scannerState = defaultScannerState(this.retrieval.getFileRules().defaultState());
        this.mode = 'base-only'; // 'base-only' | 'full' — published only by FSStorage resource operations
        this.onStateChanged = null;
        this.deferredReason = null;
        this._perRootCountsCache = new Map();
        this._perRootCountsCacheGeneration = 0;
    }

    get retrieval() {
        this._retrieval ??= createRetrieval(this._getRetrievalHost());
        return this._retrieval;
    }
    _getRetrievalHost() {
        return {
            ...this._getRetrievalAccess(),
            refreshSettings: () => this.refreshLatestSetting(),
            retryClosures: () => this._retryStorageClosures(),
            rebuildAllStorage: (reason) => this.rebuildAll(reason),
            replaceStorage: (request, prepare) => this._replaceRetrievalStorage(request, prepare),
            resetStorage: (request, reconcile, complete) => this._resetRetrievalStorage(request, reconcile, complete),
            persistRebuildEvent: (failure) => this._persistRebuildEvent(failure),
            openReadonly: (dim, select, compatible) => this._openReadonlyRetrievalStorage(dim, select, compatible)
        };
    }
    async _replaceRetrievalStorage({ dim, mode }, prepare) {
        const candidate = new BaseStorage('filemgr', makeSchema(dim, { mode }), this._storageDir);
        try {
            await candidate.initialize();
            const decision = await prepare?.(this._createRetrievalDataView(candidate));
            if (decision?.publish === false) {
                await this._closeBaseStorage(candidate);
                await decision.afterDiscard();
                return;
            }
            await this._closeBaseStorage(this.storage);
        } catch (error) {
            await this._closeBaseStorage(candidate).catch((cleanupError) => {
                recordStorageCleanupFailure(error, cleanupError);
                logger.warn(`[filemgr] close candidate storage failed: ${cleanupError.message}`);
            });
            throw error;
        }
        this.storage = candidate;
        this.mode = mode;
        this._clearPerRootCountsCacheForModeTransition();
    }
    async _dropFilemgrStores({ includeBase = false } = {}) {
        const stores = [
            ['vector-index.db', dropVectorIndexStore],
            ['chunk-index.db', dropChunkIndexStore]
        ];
        if (includeBase) stores.push(['base-index.db', dropBaseIndexStore]);
        assertWasmStoresUnlocked(stores.map(([file]) => path.join(this._storageDir, file)));
        for (const [file, drop] of stores) await drop(path.join(this._storageDir, file));
    }
    async _resetRetrievalStorage({ dim, mode }, reconcile, complete) {
        let nextStorage = null;
        try {
            // A published base-only holder owns none of the semantic deletion
            // targets. Keep it available until reconciliation succeeds; full
            // holders must release their target connections before raw deletion.
            if (this.mode !== 'base-only') await this._closeBaseStorage(this.storage);
            await this._dropFilemgrStores();
            nextStorage = new BaseStorage('filemgr', makeSchema(dim, { mode }), this._storageDir);
            await nextStorage.initialize();
            await reconcile(this._createRetrievalDataView(nextStorage));
            await this._closeBaseStorage(this.storage);
            await complete(this._createRetrievalDataView(nextStorage));
            this.storage = nextStorage;
            nextStorage = null;
            this.mode = mode;
            this._clearPerRootCountsCache();
        } catch (error) {
            await this._closeBaseStorage(nextStorage).catch((cleanupError) => {
                logger.warn(`[filemgr] close candidate storage failed: ${cleanupError.message}`);
            });
            throw error;
        }
    }
    async _openReadonlyRetrievalStorage(dim, select, compatible) {
        this.deferredReason = null;
        const base = new BaseStorage('filemgr', makeSchema(dim, { mode: 'base-only' }), this._storageDir);
        let full = null;
        const selection = await select(this._createRetrievalDataView(base), async () => {
            full = new BaseStorage('filemgr', makeSchema(dim, { mode: 'full' }), this._storageDir);
            return full.probeIndexers(['VectorIndexer', 'ChunkIndexer']);
        });
        if (selection.deferredReason) {
            await this._closeBaseStorage(base);
            this.storage = null;
            this.deferredReason = selection.deferredReason;
            return;
        }
        let mode = selection.mode;
        let candidate = mode === 'full' ? full : base;
        try {
            await candidate.initialize();
            if (mode === 'full' && !compatible(this._createRetrievalDataView(candidate))) {
                // Readonly retains the existing fallback/open lifecycle.
                await this._closeBaseStorage(candidate);
                candidate = new BaseStorage('filemgr', makeSchema(dim, { mode: 'base-only' }), this._storageDir);
                mode = 'base-only';
                await candidate.initialize();
            }
            this.storage = candidate;
            this.mode = mode;
            logger.info(`[filemgr] readonly initialized mode=${mode}`);
        } catch (error) {
            await this._closeBaseStorage(candidate);
            this.storage = null;
            this.deferredReason = 'open_failed';
            logger.warn(`[filemgr] readonly initialize failed mode=${mode}: ${error?.message ?? String(error)}`);
        }
    }

    _createRetrievalDataView(storage = this.storage) {
        if (!storage) return null;
        const view = { identity: storage };
        for (const method of [
            'search',
            'searchScope',
            'searchVectorMeta',
            'upsert',
            'update',
            'delete',
            'clearIndexerForItem',
            'countGrouped',
            'getStatus',
            'getSemanticBackends',
            'getSemanticWriteState',
            'probeBaseIndexStore',
            'probeIndexers'
        ]) {
            if (typeof storage[method] === 'function') view[method] = (...args) => storage[method](...args);
        }
        return view;
    }

    _getRetrievalAccess() {
        return {
            readState: () => this.scannerState,
            saveState: () => this.saveScannerState(),
            writeStateSnapshot: (patch, commit) =>
                this._writeScannerStateSnapshot({ ...this.scannerState, ...patch }, commit),
            invalidateCounts: () => this._clearPerRootCountsCache(),
            notifyStateChanged: () => this.onStateChanged?.(),
            data: (_intent) => this._createRetrievalDataView(),
            mode: () => this.mode,
            formatSearchResult: (query, results, totalHits, code) =>
                this._wrapResult(
                    query,
                    results,
                    totalHits,
                    {
                        [CODES.INDEX_NOT_READY]: WARNINGS.DEFERRED,
                        [CODES.EMBED_API_DOWN]: WARNINGS.EMBED_API_DOWN,
                        [CODES.EMBED_UNAVAILABLE]: WARNINGS.NO_EMBEDDING_MODEL
                    }[code],
                    code
                )
        };
    }

    async _closeBaseStorage(storage) {
        if (!storage) return;
        this._pendingStorageClosures.add(storage);
        // Ownership stays in the pending set; a closing holder is no longer
        // available for FileMgr queries or the already-full fast path.
        if (this.storage === storage) this.storage = null;
        // The generic storage contract requires awaiting release before discarding
        // a holder. Retry once for a transient failure; retain it on repeated failure.
        try {
            await storage.close?.();
        } catch {
            await storage.close?.();
        }
        this._pendingStorageClosures.delete(storage);
    }

    async _retryStorageClosures() {
        let failure = null;
        for (const storage of this._pendingStorageClosures) {
            try {
                await this._closeBaseStorage(storage);
            } catch (error) {
                failure ??= error;
            }
        }
        if (failure) throw failure;
    }

    async close() {
        if (this.storage) this._pendingStorageClosures.add(this.storage);
        await this._retryStorageClosures();
        await this.retrieval.dispose();
    }

    get _scannerStatePath() {
        return path.join(this._appDataDirectory, 'scanner_state.json');
    }

    // ── State persistence ──────────────────────────────────────────

    /**
     * Load scanner state. Sets this._stateCorrupt = true if file exists but
     * can't be read/parsed (spec §9.1 Type 1 → triggers rebuild in initialize).
     */
    _loadScannerState() {
        this._stateCorrupt = false;

        if (!fs.existsSync(this._scannerStatePath)) {
            this.scannerState = defaultScannerState(this.retrieval.getFileRules().defaultState());
            return;
        }

        try {
            const raw = fs.readFileSync(this._scannerStatePath, 'utf-8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                const state = { ...defaultScannerState(this.retrieval.getFileRules().defaultState()), ...parsed };
                this.retrieval.getFileRules().normalizeState(state, parsed);
                // Validate critical fields to catch structurally invalid data
                // roots must be a plain object (spec §3.2)
                if (typeof state.roots !== 'object' || state.roots === null || Array.isArray(state.roots)) {
                    throw new Error('invalid roots field');
                }
                // Validate each root entry has all required numeric fields (spec §3.2)
                for (const [key, val] of Object.entries(state.roots)) {
                    if (
                        !val ||
                        typeof val !== 'object' ||
                        typeof val.last_full_scan !== 'number' ||
                        typeof val.total_files !== 'number'
                    ) {
                        throw new Error(`invalid root entry: ${key}`);
                    }
                    val.last_file_count ??= val.total_files ?? 0;
                    if (val.last_scan_at === undefined) {
                        val.last_scan_at = val.last_full_scan === 0 ? null : val.last_full_scan;
                    }
                    if (val.last_scan_at !== null && typeof val.last_scan_at !== 'number') {
                        throw new Error(`invalid root last_scan_at: ${key}`);
                    }
                    val.paused ??= false;
                    if (typeof val.paused !== 'boolean') {
                        throw new Error(`invalid root paused: ${key}`);
                    }
                    if (val.metadata_write_pending !== undefined && typeof val.metadata_write_pending !== 'boolean') {
                        logger.warn(`[filemgr] invalid metadata_write_pending for ${key}; using false`);
                        val.metadata_write_pending = false;
                    }
                }
                this.scannerState = state;
                return;
            }
        } catch {
            /* fall through to corruption path */
        }

        logger.warn('[filemgr] scanner_state.json exists but corrupt');
        this.scannerState = defaultScannerState(this.retrieval.getFileRules().defaultState());
        this._stateCorrupt = true;
    }

    async saveScannerState() {
        const writeOp = async () => {
            const tmp = this._scannerStatePath + '.tmp';
            await fs.promises.writeFile(tmp, JSON.stringify(this.scannerState, null, 2), 'utf-8');
            await fs.promises.rename(tmp, this._scannerStatePath);
        };
        // Self-healing chain: .then(writeOp, writeOp) ensures a previous write
        // failure doesn't block the next write. Current write errors propagate
        // to the caller (not swallowed).
        this._stateWriteChain = this._stateWriteChain.then(writeOp, writeOp);
        return this._stateWriteChain;
    }

    async _writeScannerStateSnapshot(state, commit) {
        // Freeze pause state at call time, then commit memory before the write chain advances.
        const serialized = JSON.stringify(state, null, 2);
        const writeOp = async () => {
            const tmp = this._scannerStatePath + '.tmp';
            await fs.promises.writeFile(tmp, serialized, 'utf-8');
            await fs.promises.rename(tmp, this._scannerStatePath);
            commit();
        };
        this._stateWriteChain = this._stateWriteChain.then(writeOp, writeOp);
        return this._stateWriteChain;
    }

    async setRootPaused(root, paused) {
        const rootState = this.scannerState.roots[root];
        if (!rootState) throw new Error(`unknown scanner root: ${root}`);
        const nextState = {
            ...this.scannerState,
            roots: {
                ...this.scannerState.roots,
                [root]: { ...rootState, paused }
            }
        };
        await this._writeScannerStateSnapshot(nextState, () => {
            rootState.paused = paused;
        });
    }

    async commitRootScanState(root, changes, { clearUnavailable = false } = {}) {
        const rootState = this.scannerState.roots[root];
        if (!rootState) throw new Error(`unknown scanner root: ${root}`);
        const unavailable = { ...this.scannerState.unavailable_roots };
        if (clearUnavailable) delete unavailable[root];
        const snapshot = {
            ...this.scannerState,
            roots: { ...this.scannerState.roots, [root]: { ...rootState, ...changes } },
            unavailable_roots: unavailable
        };
        await this._writeScannerStateSnapshot(snapshot, () => {
            Object.assign(rootState, changes);
            if (clearUnavailable && this.scannerState.unavailable_roots)
                delete this.scannerState.unavailable_roots[root];
            this._clearPerRootCountsCache(root);
        });
    }

    // ── Helpers ─────────────────────────────────────────────────────

    isDeferred() {
        return this.storage === null;
    }

    refreshLatestSetting() {
        return Setting.getInstance();
    }

    /**
     * @param {string} filename
     * @returns {string}
     */
    _getFileExtension(filename) {
        const lastDot = filename.lastIndexOf('.');
        return lastDot !== -1 ? filename.slice(lastDot).toLowerCase() : '';
    }

    /**
     * @param {string | null | undefined} raw
     * @returns {string[]}
     */
    _parseRootRefs(raw) {
        if (!raw) return [];
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
                logger.warn(`[filemgr] root_refs not an array: ${raw}`);
                return [];
            }
            const filtered = parsed.filter((x) => typeof x === 'string');
            if (filtered.length !== parsed.length) {
                logger.warn(`[filemgr] root_refs has non-string elements: ${raw}`);
            }
            return filtered;
        } catch (err) {
            logger.warn(`[filemgr] failed to parse root_refs: ${raw}, ${err.message}`);
            return [];
        }
    }

    _canonicalRootRef(value) {
        if (typeof value !== 'string' || value.length === 0) return '';
        return normalizeRootPath(value);
    }

    _rootRefsIncludeRoot(rawRefs, root) {
        const canonicalRoot = this._canonicalRootRef(root);
        if (!canonicalRoot) return false;
        return this._parseRootRefs(rawRefs).some((ref) => this._canonicalRootRef(ref) === canonicalRoot);
    }

    _getFreshCachedPerRootCount(root) {
        const entry = this._perRootCountsCache?.get(root);
        if (!entry?.counts) return null;
        if (Date.now() - entry.computedAt > HARMONY_PER_ROOT_COUNT_CACHE_TTL_MS) return null;
        return entry.counts;
    }

    _getAnyCachedPerRootCount(root) {
        return this._perRootCountsCache?.get(root)?.counts ?? null;
    }

    _setCachedPerRootCount(root, counts) {
        if (!this._perRootCountsCache) this._perRootCountsCache = new Map();
        const existing = this._perRootCountsCache.get(root);
        this._perRootCountsCache.set(root, {
            computedAt: Date.now(),
            counts,
            inFlight: existing?.inFlight ?? null
        });
    }

    _clearPerRootCountsCache(root = null) {
        if (!this._perRootCountsCache) return;
        this._perRootCountsCacheGeneration = (this._perRootCountsCacheGeneration ?? 0) + 1;
        if (root) this._perRootCountsCache.delete(root);
        else this._perRootCountsCache.clear();
    }

    _clearPerRootCountsCacheForModeTransition() {
        this._clearPerRootCountsCache();
    }

    _scannerStatePerRootCountFallback(root) {
        const rootState = this.scannerState.roots[root] ?? {};
        const totalFiles = rootState.total_files ?? rootState.last_file_count ?? 0;
        return {
            total_files: totalFiles,
            embedded_count: 0,
            pending_count: totalFiles,
            failed_count: 0
        };
    }

    async _aggregatePerRootCounts(root) {
        const normalizedRoot = normalizeRootPath(root);
        const prefix = normalizedRoot === '/' ? '/' : `${normalizedRoot}/`;
        const groups = await this.storage.countGrouped(
            ['root_refs', 'embedded', 'embedding_generation'],
            [
                { indexer: 'BaseIndexer', field: 'type', operator: '=', value: 'file' },
                { indexer: 'BaseIndexer', field: 'item_id', operator: '>=', value: prefix },
                { indexer: 'BaseIndexer', field: 'item_id', operator: '<', value: nextLexicographicPrefix(prefix) }
            ]
        );
        // Keep the existing root-ref normalization and membership rules, but apply
        // them once per distinct group rather than materializing every file.
        let totalFiles = 0;
        let embeddedCount = 0;
        let failedCount = 0;
        const fileRules = this.retrieval.getFileRules();
        for (const { values, count } of groups) {
            if (!this._rootRefsIncludeRoot(values.root_refs, root)) continue;
            totalFiles += count;
            const contribution = fileRules.rootGroupCounts(values, count);
            embeddedCount += contribution.embedded_count;
            failedCount += contribution.failed_count;
        }
        return {
            total_files: totalFiles,
            embedded_count: embeddedCount,
            pending_count: Math.max(0, totalFiles - embeddedCount - failedCount),
            failed_count: failedCount
        };
    }

    async _getHarmonyPerRootCount(root) {
        const fresh = this._getFreshCachedPerRootCount(root);
        if (fresh) return fresh;

        if (!this._perRootCountsCache) this._perRootCountsCache = new Map();
        const existing = this._perRootCountsCache.get(root);
        const generation = this._perRootCountsCacheGeneration ?? 0;
        if (existing?.inFlight) {
            if (existing.counts) return existing.counts;
            try {
                return await existing.inFlight;
            } catch (err) {
                logger.warn(`[filemgr] harmony per-root count failed root=${root}: ${err.message}`);
                return this._scannerStatePerRootCountFallback(root);
            }
        }

        const refresh = (async () => {
            const counts = await this._aggregatePerRootCounts(root);
            if ((this._perRootCountsCacheGeneration ?? 0) === generation) {
                this._setCachedPerRootCount(root, counts);
            }
            return counts;
        })();
        const trackedRefresh = refresh.finally(() => {
            const latest = this._perRootCountsCache.get(root);
            if (latest?.inFlight === trackedRefresh) {
                this._perRootCountsCache.set(root, {
                    computedAt: latest.computedAt,
                    counts: latest.counts,
                    inFlight: null,
                    generation: latest.generation
                });
            }
        });

        this._perRootCountsCache.set(root, {
            computedAt: existing?.computedAt ?? 0,
            counts: existing?.counts ?? null,
            inFlight: trackedRefresh,
            generation
        });

        if (existing?.counts) {
            trackedRefresh.catch((err) =>
                logger.warn(`[filemgr] harmony per-root count refresh failed root=${root}: ${err.message}`)
            );
            return existing.counts;
        }

        try {
            return await trackedRefresh;
        } catch (err) {
            const stale = this._getAnyCachedPerRootCount(root);
            if (stale) return stale;
            logger.warn(`[filemgr] harmony per-root count failed root=${root}: ${err.message}`);
            return this._scannerStatePerRootCountFallback(root);
        }
    }

    _selectPendingEmbeddingCandidates(
        pendingItems,
        { activeRoots = [], currentWorkspace = null, limit = QUERY_LIMIT } = {}
    ) {
        const buckets = new Map();
        const orderedRoots = [];
        const normalizedWorkspace = currentWorkspace || null;

        for (const root of activeRoots) {
            if (root && !orderedRoots.includes(root)) orderedRoots.push(root);
        }
        if (normalizedWorkspace && orderedRoots.includes(normalizedWorkspace)) {
            orderedRoots.splice(orderedRoots.indexOf(normalizedWorkspace), 1);
            orderedRoots.unshift(normalizedWorkspace);
        }

        if (orderedRoots.length === 0) {
            return pendingItems.slice(0, limit);
        }

        for (const item of pendingItems) {
            const refs = this._parseRootRefs(item.root_refs);
            for (const root of orderedRoots) {
                if (refs.includes(root)) {
                    if (!buckets.has(root)) buckets.set(root, []);
                    buckets.get(root).push(item);
                    break;
                }
            }
        }

        const selected = [];
        const seen = new Set();
        while (selected.length < limit) {
            let progressed = false;
            for (const root of orderedRoots) {
                const weight = root === normalizedWorkspace ? WORKSPACE_EMBEDDING_PRIORITY_WEIGHT : 1;
                const bucket = buckets.get(root) ?? [];
                for (let i = 0; i < weight && selected.length < limit; i++) {
                    const next = bucket.shift();
                    if (!next) break;
                    if (seen.has(next.item_id)) continue;
                    seen.add(next.item_id);
                    selected.push(next);
                    progressed = true;
                }
            }
            if (!progressed) break;
        }
        return selected;
    }

    _serializeRootRefs(rootRefs) {
        return JSON.stringify(rootRefs);
    }

    _refCountForRootRefs(rootRefs) {
        return Array.isArray(rootRefs) ? rootRefs.length : 0;
    }

    _withRootRef(rootRefs, root) {
        return rootRefs.includes(root) ? rootRefs : [...rootRefs, root];
    }

    /**
     * @param {string} query
     * @param {object[]} results
     * @param {number} totalHits
     * @returns {object}
     */
    _wrapResult(query, results, totalHits, explicitWarning = null, code = null) {
        const warning = explicitWarning ?? this._computeWarning();
        return {
            query,
            results,
            totalHits,
            ...(warning && { warning }),
            ...(code && { code })
        };
    }

    _computeWarning() {
        if (!this.retrieval.getRuntimeState().modelConfigured) {
            return WARNINGS.NO_EMBEDDING_MODEL;
        }

        const roots = this.scannerState.roots;
        if (Object.keys(roots).length === 0) {
            return WARNINGS.NO_ROOTS;
        }

        const hasInitialScan = Object.values(roots).some((r) => r.last_full_scan === 0);
        if (hasInitialScan) {
            return WARNINGS.INITIAL_SCAN;
        }

        return null;
    }

    getScannerState() {
        return this.scannerState;
    }

    // ── Initialization ──────────────────────────────────────────────

    async initialize({ syncEmbedding = true } = {}) {
        await this._retryStorageClosures();
        fs.mkdirSync(this._appDataDirectory, { recursive: true });
        this._cleanupLegacyFiles();
        this._loadScannerState();

        if (this._stateCorrupt) {
            this.scannerState = defaultScannerState(this.retrieval.getFileRules().defaultState());
            this._stateCorrupt = false;
            logger.warn('[filemgr] scanner_state corrupt — reset to default, DB files preserved');
            await this.saveScannerState();
        }

        const { dim } = this.retrieval.getFileRules().baseAssembly();
        try {
            this.storage = new BaseStorage('filemgr', makeSchema(dim, { mode: 'base-only' }), this._storageDir);
            await this.storage.initialize();
            this.mode = 'base-only';
        } catch (err) {
            logger.warn(`[filemgr] base storage init failed: ${err.message}`);
            try {
                await this._closeBaseStorage(this.storage);
            } catch (cleanupError) {
                recordStorageCleanupFailure(err, cleanupError, 'BaseIndexer');
                throw err;
            }
            if (this.retrieval.getFileRules().initializationRecovery(err) !== 'full') throw err;
            await this.rebuildAll('base_init_failed');
            return;
        }

        try {
            // ArkData's existing lazy base acquisition can first run during these reads.
            await this._migrateRefCount();
            await this.retrieval.rebuildProducts({ kind: 'reconcile-current' });
        } catch (error) {
            if (this.retrieval.getFileRules().initializationRecovery(error) !== 'full') throw error;
            await this.rebuildAll('base_init_failed');
            return;
        }
        if (syncEmbedding) {
            await this.retrieval.prepare({
                context: { scannerState: this.scannerState, mode: this.mode },
                reason: 'initialize',
                role: 'write'
            });
        }
    }

    async initializeReadonly() {
        this._loadScannerState();
        return this.retrieval.prepare({ context: {}, reason: 'readonly initialize', role: 'read' });
    }

    _cleanupLegacyFiles() {
        const legacyPaths = [
            path.join(getOpendeskDirectory(), 'fs_storage.db'),
            path.join(getOpendeskDirectory(), 'vec_storage.db'),
            path.join(getOpendeskDirectory(), 'vec_cache.jsonl')
        ];
        for (const p of legacyPaths) {
            if (fs.existsSync(p)) {
                fs.rmSync(p, { recursive: true, force: true });
                logger.info(`[filemgr] removed legacy storage: ${p}`);
            }
        }
    }

    async _migrateRefCount() {
        if (this.scannerState._migratedRefCount) {
            return;
        }

        const { items } = await this.storage.search([
            { indexer: 'BaseIndexer', field: 'type', operator: '=', value: 'file' }
        ]);
        const updates = [];
        for (const { item } of items) {
            const rootRefs = this._parseRootRefs(item.root_refs);
            const refCount = this._refCountForRootRefs(rootRefs);
            if (item.ref_count !== refCount) {
                updates.push({
                    item_id: item.item_id,
                    item_type: 'file',
                    ref_count: refCount
                });
            }
        }

        if (updates.length > 0) {
            await this.storage.update(updates, { indexers: ['BaseIndexer'] });
            logger.info(`[filemgr] migration: backfilled ref_count for ${updates.length} files`);
        }

        if (items.length === 0) {
            return;
        }

        this.scannerState._migratedRefCount = true;
        await this.saveScannerState();
    }

    // ── Rebuild ─────────────────────────────────────────────────────

    /**
     * Build-then-swap full rebuild. The rebuilt storage starts base-only and
     * retrieval.prepare decides whether vectors can be enabled afterwards.
     *
     * @param {string} reason
     */
    async rebuildAll(reason) {
        logger.warn(`[filemgr] rebuildAll: ${reason}`);
        let failure = null;
        try {
            await this._retryStorageClosures();
            fs.mkdirSync(this._appDataDirectory, { recursive: true });
            if (!this.storage) {
                this._loadScannerState();
                this._stateCorrupt = false;
            }
            await this.retrieval.rebuildProducts({ kind: 'full-invalidation' });
            await this._closeBaseStorage(this.storage);
            await this._dropFilemgrStores({ includeBase: true });

            try {
                this.storage = new BaseStorage('filemgr', makeSchema(1024, { mode: 'base-only' }), this._storageDir);
                await this.storage.initialize();
            } catch (err) {
                await this._closeBaseStorage(this.storage).catch((cleanupError) => {
                    logger.warn(`[filemgr] close rebuilt storage failed: ${cleanupError.message}`);
                });
                Object.assign(this.scannerState, this.retrieval.getFileRules().fullResetPatch(true));
                await this.saveScannerState().catch(() => {});
                throw err;
            }

            for (const root of Object.keys(this.scannerState.roots)) {
                this.scannerState.roots[root].last_full_scan = 0;
                this.scannerState.roots[root].last_scan_at = null;
                this.scannerState.roots[root].total_files = 0;
                this.scannerState.roots[root].last_file_count = 0;
            }
            Object.assign(this.scannerState, this.retrieval.getFileRules().fullResetPatch(false));
            this.scannerState._migratedRefCount = false;
            this.mode = 'base-only';
            await this.saveScannerState();
            await this.retrieval.prepare({
                context: { scannerState: this.scannerState, mode: this.mode },
                reason,
                role: 'maintenance'
            });
            this._clearPerRootCountsCache();
            logger.info('[filemgr] rebuildAll complete');
        } catch (err) {
            failure = err;
            throw err;
        } finally {
            this.scannerState.last_rebuild_event = {
                type: 'full',
                reason,
                status: failure ? 'failed' : 'completed',
                ts: Date.now(),
                ...(failure && { message: failure.message })
            };
            await this._persistRebuildEvent(failure);
        }
    }

    async _persistRebuildEvent(originalFailure) {
        try {
            await this.saveScannerState();
            this.onStateChanged?.();
        } catch (err) {
            if (originalFailure) {
                logger.warn(
                    `[filemgr] failed to persist rebuild event after operation failed; ` +
                        `preserving original error: ${err.message}`
                );
                return;
            }
            throw err;
        }
    }

    // ── Batch save ──────────────────────────────────────────────────

    /**
     * Write file metadata to BaseIndexer only (embedded=0 for new/modified files).
     * Assumes outer BaseWorker.taskQueue (concurrency=1) serializes calls.
     *
     * @param {z.infer<typeof FileEntrySchema>[]} files
     * @param {string} scannerRoot
     * @returns {Promise<{saved: number, failed: number, failures: Array<{path: string, error: string}>}>}
     */
    async saveFiles(files, scannerRoot) {
        if (files.length === 0) return { saved: 0, failed: 0, failures: [] };

        const paths = files.map((f) => f.path);
        const existing = await this.storage.search([
            { indexer: 'BaseIndexer', field: 'item_id', operator: 'in', value: paths }
        ]);
        const existingMap = new Map(existing.items.map((it) => [it.item.item_id, it.item]));

        const toFullProcess = [];
        const toRefUpdateOnly = [];
        for (const f of files) {
            const ex = existingMap.get(f.path);
            if (!ex) {
                toFullProcess.push(f);
                continue;
            }
            const modifiedChanged = toStorageTimestamp(ex.modified) !== f.modified;
            const existingRefs = this._parseRootRefs(ex.root_refs);
            const needsRefAdd = !existingRefs.includes(scannerRoot);
            if (modifiedChanged) toFullProcess.push(f);
            else if (needsRefAdd) toRefUpdateOnly.push({ file: f, existingRefs });
        }

        let saved = 0,
            failed = 0;
        const failures = [];

        if (toFullProcess.length > 0) {
            const items = toFullProcess.map((f) => {
                const ex = existingMap.get(f.path);
                const existingRefs = ex ? this._parseRootRefs(ex.root_refs) : [];
                const rootRefs = this._withRootRef(existingRefs, scannerRoot);
                return {
                    item_id: f.path,
                    item_type: 'file',
                    filename: f.filename,
                    ext: this._getFileExtension(f.filename),
                    size: f.size,
                    modified: f.modified,
                    created: f.created,
                    accessed: f.accessed,
                    type: f.type,
                    chunk_text: null,
                    root_refs: this._serializeRootRefs(rootRefs),
                    ref_count: this._refCountForRootRefs(rootRefs),
                    ...this.retrieval.getFilePatch('content-changed')
                };
            });
            try {
                await this.storage.upsert(items, { indexers: ['BaseIndexer'] });
                saved += items.length;
            } catch (err) {
                logger.warn(`[filemgr] saveFiles base write failed: ${err.message}`);
                failed += items.length;
                for (const it of items) failures.push({ path: it.item_id, error: err.message });
            }
        }

        if (toRefUpdateOnly.length > 0) {
            const updates = toRefUpdateOnly.map(({ file, existingRefs }) => {
                const rootRefs = this._withRootRef(existingRefs, scannerRoot);
                return {
                    item_id: file.path,
                    item_type: 'file',
                    root_refs: this._serializeRootRefs(rootRefs),
                    ref_count: this._refCountForRootRefs(rootRefs)
                    // intentionally omit `embedded` — preserves prior value
                };
            });
            await this.storage.update(updates, { indexers: ['BaseIndexer'] });
            saved += updates.length;
        }

        return { saved, failed, failures };
    }

    /**
     * Drain the embedding queue: process all files with embedded=0 until queue is empty or
     * isScanPending() returns true (yielding to a queued scan).
     *
     * Only runs when this.mode === 'full'. Returns count of successfully embedded files.
     * @param {() => boolean} isScanPending
     * @param {{ activeRoots?: string[], currentWorkspace?: string | null, limit?: number }} [options]
     * @returns {Promise<number>}
     */
    async processEmbeddingQueue(
        isScanPending,
        { activeRoots = [], currentWorkspace = null, limit = QUERY_LIMIT } = {}
    ) {
        const fileRules = this.retrieval.getFileRules();
        if (!fileRules.canBuild()) return 0;

        let totalProcessed = 0;
        let consecutiveFailures = 0;
        const skippedFiles = new Set();
        const searchPendingItems = async (embeddedState) => {
            const { items } = await this.storage.search([
                ...fileRules.pendingConditions(embeddedState),
                { indexer: 'BaseIndexer', field: 'type', operator: '=', value: 'file' },
                { indexer: 'BaseIndexer', field: 'ref_count', operator: '>', value: 0 }
            ]);
            return items.map((r) => r.item).filter((r) => !skippedFiles.has(r.item_id));
        };

        while (true) {
            if (isScanPending()) break;

            const selection = {
                activeRoots,
                currentWorkspace,
                limit
            };
            let candidates = this._selectPendingEmbeddingCandidates(await searchPendingItems(0), selection);
            if (candidates.length === 0) {
                candidates = this._selectPendingEmbeddingCandidates(await searchPendingItems(-1), selection);
            }
            if (candidates.length === 0) break;

            for (const file of candidates) {
                if (isScanPending()) break;
                const result = await this.retrieval.buildStep(file);
                if (result.kind === 'skipped') {
                    skippedFiles.add(file.item_id);
                    consecutiveFailures = 0;
                    continue;
                }
                if (result.kind === 'unavailable') {
                    consecutiveFailures = 3;
                    break;
                }
                if (result.kind === 'failed') {
                    skippedFiles.add(file.item_id);
                    consecutiveFailures = result.consecutiveFailure ? consecutiveFailures + 1 : 0;
                    if (result.consecutiveFailure)
                        logger.warn(
                            `[filemgr] embed API error (${consecutiveFailures}/3) for ${file.item_id}: ${result.error?.message ?? ''}`
                        );
                    if (consecutiveFailures >= 3) break;
                    continue;
                }
                totalProcessed++;
                consecutiveFailures = 0;
            }
            if (consecutiveFailures >= 3 || isScanPending()) break;
        }

        Object.assign(this.scannerState, fileRules.taskFinishedPatch(Date.now()));
        await this.saveScannerState();
        return totalProcessed;
    }

    /**
     * Internal keyword route for aggregated indexed search. Includes storage metadata
     * needed by worker-side final filtering; do not expose directly to renderer callers.
     */
    async searchIndexedFilesByKeyword(keyword, { limit = 150, scope, terms } = {}) {
        scope = normalizeFilemgrSearchScope(scope);
        // Explicit terms belong to aggregated search; legacy callers retain LIKE matching.
        const filenameFilter = terms?.length
            ? {
                  indexer: 'BaseIndexer',
                  or: terms.map((term) => ({
                      indexer: 'BaseIndexer',
                      field: 'filename',
                      operator: 'contains_literal',
                      value: term
                  }))
              }
            : { indexer: 'BaseIndexer', field: 'filename', operator: 'like', value: `%${keyword}%` };
        const conditions = scope
            ? [...buildIndexedFilePreconditions({ scope, requireEmbedded: false }), filenameFilter]
            : [{ indexer: 'BaseIndexer', field: 'ref_count', operator: '>', value: 0 }, filenameFilter];
        const result = await this.storage.search(conditions, {
            limit,
            orderBy: { field: 'modified', direction: 'DESC' }
        });
        const rows = result.items.map((it) => ({
            path: it.item.item_id,
            filename: it.item.filename,
            modified: it.item.modified,
            size: it.item.size,
            snippet: null,
            ref_count: it.item.ref_count,
            root_refs: it.item.root_refs
        }));
        return rows;
    }

    /**
     * Keyword search over visible indexed files.
     * Returns SearchResultItem[] (snippet always null — keyword search doesn't produce snippets).
     * @param {string} keyword
     * @returns {Promise<SearchResultItem[]>}
     */
    async searchFilesByKeyword(keyword, { limit = 150 } = {}) {
        const rows = await this.searchIndexedFilesByKeyword(keyword, { limit });
        return rows.map((row) => ({
            path: row.path,
            filename: row.filename,
            modified: row.modified,
            size: row.size,
            snippet: row.snippet
        }));
    }

    // ── Delete detection ────────────────────────────────────────────

    async _searchItemsUnderRoot(root) {
        const normalizedRoot = normalizeRootPath(root);
        const prefix = normalizedRoot === '/' ? '/' : `${normalizedRoot}/`;
        const upper = nextLexicographicPrefix(prefix);

        return this.storage.search([
            { indexer: 'BaseIndexer', field: 'type', operator: '=', value: 'file' },
            { indexer: 'BaseIndexer', field: 'item_id', operator: '>=', value: prefix },
            { indexer: 'BaseIndexer', field: 'item_id', operator: '<', value: upper }
        ]);
    }

    /**
     * Remove root from root_refs for subtree items matching the predicate.
     * Items whose root_refs become empty are deleted unless the caller asks to keep them.
     * @param {string} root
     * @param {(itemId: string) => boolean} [shouldRemove] - defaults to always true
     * @param {{ deleteEmptyRefs?: boolean, keepEmptyRefsIf?: (itemPath: string) => boolean }} [options]
     * @returns {Promise<{deleted: number, detached: number}>}
     */
    async _removeRootFromItems(
        root,
        shouldRemove = () => true,
        { deleteEmptyRefs = true, keepEmptyRefsIf = () => false } = {}
    ) {
        const all = await this._searchItemsUnderRoot(root);

        const toUpdate = [];
        const toDelete = [];

        for (const it of all.items) {
            const item = it.item;
            const rootRefs = this._parseRootRefs(item.root_refs);
            if (!rootRefs.includes(root)) continue;
            if (!shouldRemove(item.item_id)) continue;

            const newRefs = rootRefs.filter((r) => r !== root);
            if (newRefs.length === 0) {
                if (deleteEmptyRefs && !keepEmptyRefsIf(item.item_id)) {
                    toDelete.push(item.item_id);
                } else {
                    toUpdate.push({
                        item_id: item.item_id,
                        item_type: 'file',
                        root_refs: JSON.stringify([]),
                        ref_count: 0
                    });
                }
            } else {
                toUpdate.push({
                    item_id: item.item_id,
                    item_type: 'file',
                    root_refs: JSON.stringify(newRefs),
                    ref_count: newRefs.length
                });
            }
        }

        if (toDelete.length > 0) await this.storage.delete(toDelete);
        if (toUpdate.length > 0) await this.storage.update(toUpdate, { indexers: ['BaseIndexer'] });

        return { deleted: toDelete.length, detached: toUpdate.length };
    }

    async detachRootForConfigChange(removedRoot, newEntries) {
        const newRoots = (newEntries ?? []).map((entry) => entry.root);
        try {
            const result = await this._removeRootFromItems(removedRoot, undefined, {
                deleteEmptyRefs: true,
                keepEmptyRefsIf: (itemPath) => newRoots.some((root) => isSameOrAncestor(root, itemPath))
            });
            const roots = { ...this.scannerState.roots };
            const unavailable = { ...this.scannerState.unavailable_roots };
            delete roots[removedRoot];
            delete unavailable[removedRoot];
            await this._writeScannerStateSnapshot(
                { ...this.scannerState, roots, unavailable_roots: unavailable },
                () => {
                    delete this.scannerState.roots[removedRoot];
                    if (this.scannerState.unavailable_roots) delete this.scannerState.unavailable_roots[removedRoot];
                }
            );
            logger.info(
                `[filemgr] detachRootForConfigChange ${removedRoot}: delete=${result.deleted}, detach=${result.detached}`
            );
            return result;
        } finally {
            this._clearPerRootCountsCache();
        }
    }

    async pruneUnownedUnavailableRoots(entries) {
        const configured = new Set(entries.map((entry) => entry.root));
        const removed = Object.keys(this.scannerState.unavailable_roots ?? {}).filter(
            (root) => !configured.has(root) && !this.scannerState.roots[root]
        );
        if (removed.length === 0) return;
        const unavailable = { ...this.scannerState.unavailable_roots };
        for (const root of removed) delete unavailable[root];
        await this._writeScannerStateSnapshot({ ...this.scannerState, unavailable_roots: unavailable }, () => {
            for (const root of removed) delete this.scannerState.unavailable_roots[root];
        });
    }

    /**
     * @param {string} scannerRoot
     * @param {Set<string>} scannedPaths
     * @param {{ activeRoots?: string[], failedDirectories?: Set<string> }} [options]
     */
    async removeDeletedFiles(scannerRoot, scannedPaths, { activeRoots = [], failedDirectories = new Set() } = {}) {
        const isProtected = failedDirectoryMatcher(failedDirectories);
        const otherRoots = activeRoots.filter((root) => root !== scannerRoot);
        try {
            const { deleted, detached } = await this._removeRootFromItems(
                scannerRoot,
                (itemId) => !scannedPaths.has(itemId) && !isProtected(itemId),
                {
                    deleteEmptyRefs: true,
                    keepEmptyRefsIf: (itemPath) => otherRoots.some((root) => isSameOrAncestor(root, itemPath))
                }
            );
            logger.info(`[filemgr] root ${scannerRoot}: delete=${deleted}, detach=${detached}`);
        } finally {
            this._clearPerRootCountsCache(scannerRoot);
        }
    }

    async removeOrphanedItems() {
        if (this.isDeferred()) return { deleted: 0 };
        try {
            const result = await this.storage.search([
                { indexer: 'BaseIndexer', field: 'type', operator: '=', value: 'file' }
            ]);
            const toDelete = result.items
                .filter((it) => this._parseRootRefs(it.item.root_refs).length === 0 || it.item.ref_count === 0)
                .map((it) => it.item.item_id);

            if (toDelete.length > 0) await this.storage.delete(toDelete);
            logger.info(`[filemgr] removeOrphanedItems: delete=${toDelete.length}`);
            return { deleted: toDelete.length };
        } finally {
            this._clearPerRootCountsCache();
        }
    }

    async getPerRootCounts(roots) {
        const counts = new Map();

        for (const root of roots) {
            const rootState = this.scannerState.roots[root];
            const lastScanAt = rootState?.last_scan_at ?? null;
            const unavailable = this.scannerState.unavailable_roots?.[root];

            if (unavailable) {
                counts.set(root, {
                    total_files: unavailable.last_count ?? 0,
                    embedded_count: 0,
                    pending_count: 0,
                    failed_count: 0,
                    last_scan_at: lastScanAt
                });
                continue;
            }

            if (process.platform === 'openharmony') {
                const rootCounts = await this._getHarmonyPerRootCount(root);
                counts.set(root, {
                    ...rootCounts,
                    last_scan_at: lastScanAt
                });
                continue;
            }

            const rootCounts = await this._aggregatePerRootCounts(root);

            counts.set(root, {
                ...rootCounts,
                last_scan_at: lastScanAt
            });
        }

        return counts;
    }

    /**
     * Detach a root: remove from root_refs, delete items with empty refs, clean state.
     * Safe to call in deferred state (just removes from scanner_state).
     * @param {string} root
     */
    async _detachRoot(root) {
        if (!this.isDeferred()) {
            const { deleted, detached } = await this._removeRootFromItems(root);
            logger.info(`[filemgr] _detachRoot ${root}: delete=${deleted}, detach=${detached}`);
        } else {
            logger.info(`[filemgr] _detachRoot ${root}: deferred, only cleaning state`);
        }

        delete this.scannerState.roots[root];
        await this.saveScannerState();
    }

    // ── Status ───────────────────────────────────────────────────────

    // Reserved for an explicit global-count consumer; normal status refreshes do not call this.
    async getGlobalFileCounts() {
        if (!this.storage) return null;
        const groups = await this.storage.countGrouped(
            ['embedded', 'embedding_generation'],
            [
                { indexer: 'BaseIndexer', field: 'type', operator: '=', value: 'file' },
                { indexer: 'BaseIndexer', field: 'ref_count', operator: '>', value: 0 }
            ]
        );
        const total = groups.reduce((sum, group) => sum + group.count, 0);
        const fileRules = this.retrieval.getFileRules();
        const embedded = groups.reduce(
            (sum, group) => sum + fileRules.globalGroupEmbedded(group.values, group.count),
            0
        );

        return { total_files: total, embedded_count: embedded, pending_count: total - embedded };
    }

    async getStatus() {
        if (!this.storage) return null;
        const status = await this.storage.getStatus();
        const semanticWriteState =
            this.mode === 'full' ? await this.retrieval.getFileRules().semanticWriteState() : null;

        return {
            mode: this.mode,
            last_embedding_task_at: this.retrieval.getRuntimeState().lastEmbeddingTaskAt,
            db_size: status.BaseIndexer?.size ?? 0,
            vecdb_size: status.VectorIndexer?.size ?? 0,
            chunk_size: status.ChunkIndexer?.size ?? 0,
            semantic_write_state: semanticWriteState
        };
    }
}

export {
    CODES,
    FileEntrySchema,
    FSStorage,
    NORMAL_SCAN_INTERVAL_MS,
    RebuildRequiredError,
    WARNINGS,
    WORKSPACE_SCAN_INTERVAL_MS,
    WORKSPACE_SCAN_INTERVAL_WHILE_EMBEDDING_MS,
    makeSchema,
    toStorageTimestamp
};
