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

import { getAppDirectory, Setting } from '../../utils/setting.js';
import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import { LLM } from '../../aikernel/llm.js';
import { BaseStorage } from '../../services/storage/abstract-storage.js';
import { withRateLimitRetry } from '../../utils/rate-limit-retry.js';
import { parseAndChunk } from './parser/index.js';
import path from 'path';
import fs from 'fs';
// ── Code constants (not in config schema) ──────────────────────────
const CHUNK_LEVEL = 'structured';
const SCAN_INTERVAL_MS = 10 * 60 * 1000;

// ── User-facing warning strings ────────────────────────────────────
const WARNINGS = {
    NO_EMBEDDING_MODEL: '未配置向量嵌入模型，语义搜索不可用。请运行 /config 配置"向量嵌入模型"。',
    NO_ROOTS: '未配置扫描目录，没有任何文件被索引。请运行 /config 添加文件扫描路径。',
    INITIAL_SCAN: '首次扫描进行中，索引数据可能不完整。如结果为空或不理想，请稍后重试。',
    EMBED_API_DOWN: 'embedding API 暂时不可用，请稍后重试。',
    DEFERRED: '文件索引尚未就绪，请稍后重试。'
};

// ── Search result shape ────────────────────────────────────────────
/**
 * 三个 search 方法（searchFileByName / searchFileByContent /
 * searchFilesByKeyword）都返回 SearchResultItem[] —— 业务字段，永远不
 * 暴露内部存储字段（item_id/item_type/ext/chunk_text/root_refs）。
 *
 * 注意：FSStorage 的 search 方法假设 this.storage 已 initialize。deferred
 * 状态检查由 worker 层负责（worker.js searchFileByName/Content），不要绕
 * 过 worker 直接调 FSStorage 的 search 方法。
 *
 * @typedef {object} SearchResultItem
 * @property {string} path        文件绝对路径（= item_id）
 * @property {string} filename    文件名
 * @property {number} modified    最近修改时间戳（毫秒）
 * @property {number} size        文件大小（字节）
 * @property {string | null} snippet  命中的内容片段；仅 searchFileByContent 有值，其他方法为 null
 */

// ── Zod schema (kept for compat with fileview.js) ──────────────────
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
        root_refs: { type: 'TEXT', nullable: false },
        embedded: { type: 'INTEGER', nullable: false, defaultValue: 0 }
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
function defaultScannerState() {
    return {
        version: 1,
        vec_dim: null,
        embedding_model: null,
        last_embedding_task_at: null,
        chunk_level: null,
        embedded_migrated: false,
        roots: {}
    };
}

// ── Embedding helpers ──────────────────────────────────────────────
/**
 * Returns true for errors that will not resolve with retries (auth, not-found, misconfiguration).
 * @param {any} e
 * @returns {boolean}
 */
function isObviouslyPermanent(e) {
    const msg = String(e?.message || '');
    const status = e?.status || e?.response?.status;
    return status === 401 || status === 403 || status === 404 || msg.includes('not configured');
}

class FSStorage {
    /**
     * @param {string} appDataDirectory
     */
    constructor(appDataDirectory) {
        /** @type {BaseStorage | null} */
        this.storage = null;
        this._appDataDirectory = appDataDirectory;
        this._storageDir = path.join(appDataDirectory, 'storage');
        this._stateWriteChain = Promise.resolve();

        this.scannerState = defaultScannerState();
        this.mode = 'base-only'; // 'base-only' | 'full' — switched by initialize() / syncEmbeddingMode()
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
            this.scannerState = defaultScannerState();
            return;
        }

        try {
            const raw = fs.readFileSync(this._scannerStatePath, 'utf-8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                const state = { ...defaultScannerState(), ...parsed };
                // Validate critical fields to catch structurally invalid data
                // roots must be a plain object (spec §3.2)
                if (typeof state.roots !== 'object' || state.roots === null || Array.isArray(state.roots)) {
                    throw new Error('invalid roots field');
                }
                if (state.vec_dim !== null && typeof state.vec_dim !== 'number') {
                    throw new Error('invalid vec_dim field');
                }
                if (state.embedding_model !== null && typeof state.embedding_model !== 'string') {
                    throw new Error('invalid embedding_model field');
                }
                if (state.last_embedding_task_at !== null && typeof state.last_embedding_task_at !== 'number') {
                    throw new Error('invalid last_embedding_task_at field');
                }
                if (state.chunk_level !== null && typeof state.chunk_level !== 'string') {
                    throw new Error('invalid chunk_level field');
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
                }
                this.scannerState = state;
                return;
            }
        } catch {
            /* fall through to corruption path */
        }

        logger.warn('[filemgr] scanner_state.json exists but corrupt');
        this.scannerState = defaultScannerState();
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

    // ── Helpers ─────────────────────────────────────────────────────

    isDeferred() {
        return this.storage === null;
    }

    refreshLatestSetting() {
        Setting.clearCache();
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

    /**
     * @param {string[]} texts
     * @returns {Promise<number[][]>}
     */
    async _embedWithRetry(texts) {
        return await withRateLimitRetry(() => LLM.batchEmbed(texts), {
            maxRetries: 8,
            onRetry: (attempt, delayMs, err) => {
                logger.warn(`[filemgr] embed retry ${attempt}, waiting ${delayMs}ms: ${err.message}`);
            }
        });
    }

    /**
     * Probe embedding dimension.
     *
     * Probe is the first outbound API call after cli starts — cold DNS / TLS /
     * connection-pool state on first-time setup (especially HM PC) makes
     * `terminated` and similar transient transport errors common. We add a
     * short transient retry on top of withRateLimitRetry so first-time setup
     * doesn't fall into deferred state for an avoidable network blip.
     *
     * Permanent errors (401/403/model-not-found) skip transient retry and
     * surface immediately — no point burning seconds on a misconfig.
     *
     * @returns {Promise<{dim: number, model_name: string}>}
     */
    async _probeEmbedding() {
        const TRANSIENT_PATTERN = /terminated|socket hang up|ECONNRESET|ETIMEDOUT|fetch failed/i;
        let lastErr;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const vec = await withRateLimitRetry(() => LLM.embed('__filemgr_dim_probe__'), { maxRetries: 3 });
                const model = Setting.getInstance().getDefaultEmbeddingModelInstance();
                return { dim: vec.length, model_name: model.model_name };
            } catch (err) {
                lastErr = err;
                const msg = (err && err.message) ?? '';
                if (!TRANSIENT_PATTERN.test(msg)) throw err;
                if (attempt < 2) {
                    logger.warn(`[filemgr] probe transient error (attempt ${attempt + 1}/3): ${msg}, retrying...`);
                    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
                }
            }
        }
        throw lastErr;
    }

    /**
     * @param {string} query
     * @param {object[]} results
     * @param {number} totalHits
     * @returns {object}
     */
    _wrapResult(query, results, totalHits, explicitWarning = null) {
        const warning = explicitWarning ?? this._computeWarning();
        return {
            query,
            results,
            totalHits,
            ...(warning && { warning })
        };
    }

    _computeWarning() {
        try {
            Setting.getInstance().getDefaultEmbeddingModelInstance();
        } catch {
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

    async initialize() {
        fs.mkdirSync(this._appDataDirectory, { recursive: true });
        this._cleanupLegacyFiles();
        this._loadScannerState();

        if (this._stateCorrupt) {
            this.scannerState = defaultScannerState();
            this._stateCorrupt = false;
            logger.warn('[filemgr] scanner_state corrupt — reset to default, DB files preserved');
            await this.saveScannerState();
        }

        const dim = this.scannerState.vec_dim ?? 1024;
        try {
            this.storage = new BaseStorage('filemgr', makeSchema(dim, { mode: 'base-only' }), this._storageDir);
            await this.storage.initialize();
            this.mode = 'base-only';
        } catch (err) {
            logger.warn(`[filemgr] base storage init failed: ${err.message}`);
            try {
                this.storage?.close?.();
            } catch {}
            this.storage = null;
            await this.rebuildAll(`base-index init failed: ${err.message}`, dim, this.scannerState.embedding_model);
            return;
        }

        await this.syncEmbeddingMode('initialize');
    }

    // ── Embedding mode sync ─────────────────────────────────────────

    /**
     * Unified entry point for synchronising storage mode with the current
     * embedding configuration.  Called from initialize(), scan start, and
     * applicationConfigChanged().
     *
     * Decision tree:
     *  1. No embedding model configured  → _demoteToBaseOnly (preserve vectors)
     *  2. mode=full + state matches setting + chunk_level  → no-op (skip probe)
     *  3. Probe
     *     a. Probe fails           → _demoteToBaseOnly (preserve vectors)
     *     b. State consistent      → _openFull (reuse vectors); fallback: _resetVectorChunk
     *     c. State missing         → record state, _openFull; fallback: _resetVectorChunk
     *     d. State inconsistent    → update state, _resetVectorChunk (vectors invalid)
     * @param {string} reason
     */
    async syncEmbeddingMode(reason) {
        this.refreshLatestSetting();

        // Step 1: no embedding model configured
        let currentModelName;
        try {
            currentModelName = Setting.getInstance().getDefaultEmbeddingModelInstance().model_name;
        } catch {
            await this._demoteToBaseOnly(`${reason}: no embedding model configured`);
            return;
        }

        // Step 2: fast no-op — already full and state matches current setting
        if (
            this.mode === 'full' &&
            this.scannerState.embedding_model === currentModelName &&
            this.scannerState.vec_dim !== null &&
            this.scannerState.chunk_level === CHUNK_LEVEL
        ) {
            return;
        }

        // Step 3: probe
        let probe;
        try {
            probe = await this._probeEmbedding();
        } catch (err) {
            logger.warn(`[filemgr] syncEmbeddingMode probe failed: ${err.message}`);
            await this._demoteToBaseOnly(`${reason}: probe failed`);
            return;
        }

        const stateHasInfo =
            this.scannerState.vec_dim !== null &&
            this.scannerState.embedding_model !== null &&
            this.scannerState.chunk_level !== null;

        const stateConsistent =
            stateHasInfo &&
            this.scannerState.embedding_model === probe.model_name &&
            this.scannerState.vec_dim === probe.dim &&
            this.scannerState.chunk_level === CHUNK_LEVEL;

        if (stateConsistent) {
            // 3b: state matches probe — try to reuse existing vector/chunk data
            try {
                await this._openFull(probe.dim);
            } catch (err) {
                logger.warn(`[filemgr] syncEmbeddingMode: open full failed (${err.message}), resetting`);
                await this._resetVectorChunk(`${reason}: open full failed`, { dim: probe.dim, mode: 'full' });
            }
        } else if (!stateHasInfo) {
            // 3c: state missing — record probe info first, then try to reuse
            logger.info(
                `[filemgr] syncEmbeddingMode: state missing, recording probe (dim=${probe.dim}, model=${probe.model_name})`
            );
            this.scannerState.vec_dim = probe.dim;
            this.scannerState.embedding_model = probe.model_name;
            this.scannerState.chunk_level = CHUNK_LEVEL;
            await this.saveScannerState();
            try {
                await this._openFull(probe.dim);
            } catch (err) {
                logger.warn(
                    `[filemgr] syncEmbeddingMode: open full failed after state missing (${err.message}), resetting`
                );
                await this._resetVectorChunk(`${reason}: open full failed (state missing)`, {
                    dim: probe.dim,
                    mode: 'full'
                });
            }
        } else {
            // 3d: state inconsistent — model/dim/chunk_level changed, existing vectors invalid
            logger.info(
                `[filemgr] syncEmbeddingMode: state inconsistent (stored: dim=${this.scannerState.vec_dim}, model=${this.scannerState.embedding_model}; probe: dim=${probe.dim}, model=${probe.model_name}), resetting`
            );
            this.scannerState.vec_dim = probe.dim;
            this.scannerState.embedding_model = probe.model_name;
            this.scannerState.chunk_level = CHUNK_LEVEL;
            await this.saveScannerState();
            await this._resetVectorChunk(`${reason}: model/dim/chunk_level changed`, { dim: probe.dim, mode: 'full' });
        }

        if (this.mode === 'full' && !this.scannerState.embedded_migrated) {
            await this._migrateEmbeddedFlag();
        }
    }

    /**
     * Demote to base-only mode: close current storage and reopen with base-only
     * schema. Preserves vector/chunk DB files and base.embedded values.
     * vec_dim / embedding_model are intentionally kept in scannerState so that
     * when the model is restored with the same dim, vectors can be reused.
     * @param {string} reason
     */
    async _demoteToBaseOnly(reason) {
        if (this.mode === 'base-only') return;

        logger.info(`[filemgr] _demoteToBaseOnly: ${reason}`);
        const dim = this.scannerState.vec_dim ?? 1024;
        try {
            this.storage?.close?.();
        } catch {}

        this.storage = new BaseStorage('filemgr', makeSchema(dim, { mode: 'base-only' }), this._storageDir);
        await this.storage.initialize();
        this.mode = 'base-only';
    }

    /**
     * Open (or re-open) storage in full mode without resetting vector/chunk data.
     * No-op if already full.  Throws if BaseStorage.initialize() fails — caller
     * is responsible for fallback to _resetVectorChunk.
     * @param {number} dim
     */
    async _openFull(dim) {
        if (this.mode === 'full') return;

        logger.info(`[filemgr] _openFull: dim=${dim}`);
        const newStorage = new BaseStorage('filemgr', makeSchema(dim, { mode: 'full' }), this._storageDir);
        await newStorage.initialize();

        const old = this.storage;
        this.storage = newStorage;
        try {
            old?.close?.();
        } catch {}
        this.mode = 'full';
    }

    _cleanupLegacyFiles() {
        const legacyPaths = [
            path.join(getAppDirectory(), 'fs_storage.db'),
            path.join(getAppDirectory(), 'vec_storage.db'),
            path.join(getAppDirectory(), 'vec_cache.jsonl')
        ];
        for (const p of legacyPaths) {
            if (fs.existsSync(p)) {
                fs.rmSync(p, { recursive: true, force: true });
                logger.info(`[filemgr] removed legacy storage: ${p}`);
            }
        }
    }

    /**
     * Back-fill embedded=1 for files that already have vector records.
     * Runs once on first startup after the `embedded` column is introduced.
     */
    async _migrateEmbeddedFlag() {
        const vectored = await this.storage.searchVectorMeta([]);
        if (vectored.length > 0) {
            const CHUNK = 500;
            let total = 0;
            for (let i = 0; i < vectored.length; i += CHUNK) {
                const chunk = vectored.slice(i, i + CHUNK);
                await this.storage.update(
                    chunk.map((r) => ({ item_id: r.item_id, item_type: 'file', embedded: 1 })),
                    { indexers: ['BaseIndexer'] }
                );
                total += chunk.length;
            }
            logger.info(`[filemgr] migration: backfilled embedded=1 for ${total} files`);
        }
        this.scannerState.embedded_migrated = true;
        await this.saveScannerState();
    }

    // ── Rebuild ─────────────────────────────────────────────────────

    /**
     * Probe-first, build-then-swap rebuild. See spec §9.2 for full semantics:
     * Phase 1 (probe) + Phase 2 (build in temp dir): failure = no-op.
     * Phase 3 (swap): point of no return, see spec §9.2 atomicity note.
     *
     * @param {string} reason
     * @param {number} [dim]
     * @param {string} [model]
     */
    async rebuildAll(reason, dim, model) {
        logger.warn(`[filemgr] rebuildAll: ${reason}`);

        // 1. Probe phase (before any destructive ops)
        let newDim = dim;
        let newModel = model;

        if (newDim == null || newModel == null) {
            const probe = await this._probeEmbedding(); // throws → no-op, old storage untouched
            newDim = newDim ?? probe.dim;
            newModel = newModel ?? probe.model_name;
        }

        // 2. Build new empty storage in temp dir to verify it works.
        //    If this fails, old storage is completely untouched.
        const rebuildDir = this._storageDir + '.rebuild';
        if (fs.existsSync(rebuildDir)) {
            fs.rmSync(rebuildDir, { recursive: true, force: true });
        }
        let testStorage;
        try {
            testStorage = new BaseStorage('filemgr', makeSchema(newDim), rebuildDir);
            await testStorage.initialize();
        } catch (err) {
            try {
                testStorage?.close();
            } catch {}
            if (fs.existsSync(rebuildDir)) {
                fs.rmSync(rebuildDir, { recursive: true, force: true });
            }
            throw err; // old storage untouched
        }
        testStorage.close();

        // 3. Build verified — swap.
        //    POINT OF NO RETURN: after close+rm, old storage is gone.
        //    renameSync + re-open should always succeed (same-filesystem rename
        //    + opening just-verified SQLite files). If it somehow fails, this is
        //    catastrophic (OS-level issue); rebuildAll throws, _rebuildAndRestart
        //    handles it as a post-swap failure (see its catch block).
        const oldStorage = this.storage;
        if (oldStorage) {
            try {
                oldStorage.close();
            } catch {}
        }
        if (fs.existsSync(this._storageDir)) {
            fs.rmSync(this._storageDir, { recursive: true, force: true });
        }
        fs.renameSync(rebuildDir, this._storageDir);

        // 4. Re-open at final location
        try {
            this.storage = new BaseStorage('filemgr', makeSchema(newDim), this._storageDir);
            await this.storage.initialize();
        } catch (err) {
            // Post-swap catastrophic failure. Reset storage AND state so the
            // deferred invariant holds (all deferred states share vec_dim=null,
            // see spec §9.6). Persist to disk so next initialize() reads null,
            // not the pre-failure value.
            this.storage = null;
            this.scannerState.vec_dim = null;
            this.scannerState.embedding_model = null;
            await this.saveScannerState().catch(() => {});
            err._postSwap = true;
            throw err;
        }

        // 5. Reset scanner state (preserve root entries, reset progress)
        for (const root of Object.keys(this.scannerState.roots)) {
            this.scannerState.roots[root].last_full_scan = 0;
        }
        this.scannerState.vec_dim = newDim;
        this.scannerState.embedding_model = newModel;
        this.scannerState.chunk_level = CHUNK_LEVEL;
        await this.saveScannerState();

        logger.info(`[filemgr] rebuildAll complete: dim=${newDim}, model=${newModel}`);
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
            const modifiedChanged = ex.modified !== f.modified;
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
                const rootRefs = existingRefs.includes(scannerRoot) ? existingRefs : [...existingRefs, scannerRoot];
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
                    root_refs: JSON.stringify(rootRefs),
                    embedded: 0
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
            const updates = toRefUpdateOnly.map(({ file, existingRefs }) => ({
                item_id: file.path,
                item_type: 'file',
                root_refs: JSON.stringify([...existingRefs, scannerRoot])
                // intentionally omit `embedded` — preserves prior value
            }));
            await this.storage.update(updates, { indexers: ['BaseIndexer'] });
            saved += updates.length;
        }

        return { saved, failed, failures };
    }

    // ── Embedding ───────────────────────────────────────────────────

    /**
     * Embed a single file: parse+chunk, embed, write to vector/chunk indexers, mark embedded=1.
     * Returns undefined on success, or {status: 'skipped_drift'} if file changed mid-flight.
     * Deletes item from storage if file is gone.
     * @param {object} baseRow - row from BaseIndexer (item_id, filename, etc.)
     * @returns {Promise<{status: 'skipped_drift'} | undefined>}
     */
    async embedSingleFile(baseRow) {
        const filePath = baseRow.item_id;

        const stat = await fs.promises.stat(filePath).catch(() => null);
        if (!stat) {
            logger.info(`[filemgr] embed: file gone, deleting item: ${filePath}`);
            await this.storage.delete([baseRow.item_id]);
            return;
        }

        const { chunks, chunk_type } = await parseAndChunk(filePath, { level: CHUNK_LEVEL });
        const hasUsableChunks = chunk_type !== 'filename' && Array.isArray(chunks) && chunks.length > 0;

        const texts = [baseRow.filename];
        if (hasUsableChunks) texts.push(...chunks.map((c) => c.text));
        const embeddings = await this._embedWithRetry(texts);

        const statAfter = await fs.promises.stat(filePath).catch(() => null);
        if (!statAfter || statAfter.mtimeMs !== stat.mtimeMs || statAfter.size !== stat.size) {
            logger.info(`[filemgr] embed: file changed during parse/embed, skip: ${filePath}`);
            return { status: 'skipped_drift' };
        }

        const indexer_columns = {
            VectorIndexer: [{ column: 'filename', content: embeddings[0] }]
        };
        if (hasUsableChunks) {
            indexer_columns.ChunkIndexer = chunks.map((c, i) => ({
                column: 'chunk_text',
                id: c.id,
                text: c.text,
                content: embeddings[i + 1]
            }));
        }

        if (!hasUsableChunks) {
            await this.storage.clearIndexerForItem(baseRow.item_id, 'ChunkIndexer');
        }
        const targets = hasUsableChunks ? ['VectorIndexer', 'ChunkIndexer'] : ['VectorIndexer'];
        await this.storage.upsert(
            [
                {
                    item_id: baseRow.item_id,
                    item_type: 'file',
                    filename: baseRow.filename,
                    chunk_text: null,
                    indexer_columns
                }
            ],
            { indexers: targets }
        );

        await this.storage.update(
            [
                {
                    item_id: baseRow.item_id,
                    item_type: 'file',
                    modified: statAfter.mtimeMs,
                    size: statAfter.size,
                    accessed: statAfter.atimeMs,
                    embedded: 1
                }
            ],
            { indexers: ['BaseIndexer'] }
        );
    }

    /**
     * Drain the embedding queue: process all files with embedded=0 until queue is empty or
     * isScanPending() returns true (yielding to a queued scan).
     *
     * Only runs when this.mode === 'full'. Returns count of successfully embedded files.
     * @param {() => boolean} isScanPending
     * @returns {Promise<number>}
     */
    async processEmbeddingQueue(isScanPending) {
        if (this.mode !== 'full') return 0;

        const QUERY_LIMIT = 50;
        let totalProcessed = 0;
        let consecutiveFailures = 0;
        const skippedDrift = new Set();

        while (true) {
            if (isScanPending()) break;

            const { items: pendingItems } = await this.storage.search([
                { indexer: 'BaseIndexer', field: 'embedded', operator: '=', value: 0 },
                { indexer: 'BaseIndexer', field: 'type', operator: '=', value: 'file' }
            ]);
            const fresh = pendingItems
                .map((r) => r.item)
                .filter((r) => !skippedDrift.has(r.item_id))
                .slice(0, QUERY_LIMIT);
            if (fresh.length === 0) break;

            let permanentExit = false;
            for (const file of fresh) {
                if (isScanPending()) break;
                try {
                    const result = await this.embedSingleFile(file);
                    if (result?.status === 'skipped_drift') {
                        skippedDrift.add(file.item_id);
                        continue;
                    }
                    totalProcessed++;
                    consecutiveFailures = 0;
                } catch (e) {
                    if (isObviouslyPermanent(e)) {
                        logger.warn(`[filemgr] embedding permanent error, exiting task: ${e.message}`);
                        permanentExit = true;
                        break;
                    }
                    consecutiveFailures++;
                    logger.warn(`[filemgr] embed failed (${consecutiveFailures}/3) for ${file.item_id}: ${e.message}`);
                    if (consecutiveFailures >= 3) break;
                }
            }
            if (permanentExit || consecutiveFailures >= 3 || isScanPending()) break;
        }

        this.scannerState.last_embedding_task_at = Date.now();
        await this.saveScannerState();
        return totalProcessed;
    }

    // ── Search APIs ─────────────────────────────────────────────────

    /**
     * @param {string} query
     * @param {{ topK?: number }} [opts]
     */
    async searchFileByName(query, { topK = 20 } = {}) {
        if (this.mode === 'base-only') {
            const hasEmbeddingConfig = !!Setting.getInstance().data?.default_embedding_model;
            return {
                query,
                results: [],
                totalHits: 0,
                warning: hasEmbeddingConfig ? WARNINGS.EMBED_API_DOWN : WARNINGS.NO_EMBEDDING_MODEL,
                code: 'EMBED_UNAVAILABLE'
            };
        }
        this.refreshLatestSetting();

        let queryEmbedding;
        try {
            // Short retry for transient 429s; user-waiting path so cap small.
            queryEmbedding = await withRateLimitRetry(() => LLM.embed(query), { maxRetries: 2 });
        } catch (err) {
            logger.warn(`[filemgr] searchFileByName embed failed: ${err.message}`);
            return this._wrapResult(query, [], 0, WARNINGS.EMBED_API_DOWN);
        }

        const result = await this.storage.search([
            {
                indexer: 'VectorIndexer',
                field: 'filename',
                operator: 'vector_near',
                value: queryEmbedding,
                vectorQuery: { topK, metric: 'cosine' }
            },
            { indexer: 'BaseIndexer', field: 'embedded', operator: '=', value: 1 }
        ]);

        let items = result.items.map((it) => ({
            path: it.item.item_id,
            filename: it.item.filename,
            modified: it.item.modified,
            size: it.item.size,
            snippet: null
        }));

        try {
            items = await LLM.rerank(query, items, (item) => item.filename);
        } catch (err) {
            logger.warn(`[filemgr] searchFileByName rerank failed: ${err.message}`);
        }

        return this._wrapResult(query, items, result.totalCount);
    }

    /**
     * @param {string} query
     * @param {{ topK?: number }} [opts]
     */
    async searchFileByContent(query, { topK = 20 } = {}) {
        if (this.mode === 'base-only') {
            const hasEmbeddingConfig = !!Setting.getInstance().data?.default_embedding_model;
            return {
                query,
                results: [],
                totalHits: 0,
                warning: hasEmbeddingConfig ? WARNINGS.EMBED_API_DOWN : WARNINGS.NO_EMBEDDING_MODEL,
                code: 'EMBED_UNAVAILABLE'
            };
        }
        this.refreshLatestSetting();

        let queryEmbedding;
        try {
            // Short retry for transient 429s; user-waiting path so cap small.
            queryEmbedding = await withRateLimitRetry(() => LLM.embed(query), { maxRetries: 2 });
        } catch (err) {
            logger.warn(`[filemgr] searchFileByContent embed failed: ${err.message}`);
            return this._wrapResult(query, [], 0, WARNINGS.EMBED_API_DOWN);
        }

        const chunkTopK = topK * 3;
        const result = await this.storage.search([
            {
                indexer: 'ChunkIndexer',
                field: 'chunk_text',
                operator: 'vector_near',
                value: queryEmbedding,
                vectorQuery: { topK: chunkTopK, metric: 'cosine' }
            },
            { indexer: 'BaseIndexer', field: 'type', operator: '=', value: 'file' },
            { indexer: 'BaseIndexer', field: 'embedded', operator: '=', value: 1 }
        ]);

        // Aggregate to file-level, keep best chunk per file. _score is
        // internal — used for sort/topK only, stripped before return.
        const fileMap = new Map();
        for (const it of result.items) {
            const filePath = it.item.item_id;
            const score = it.ChunkScore ?? 0;
            if (!fileMap.has(filePath) || fileMap.get(filePath)._score < score) {
                fileMap.set(filePath, {
                    path: filePath,
                    filename: it.item.filename,
                    modified: it.item.modified,
                    size: it.item.size,
                    snippet: it.chunk_text,
                    _score: score
                });
            }
        }

        let aggregated = Array.from(fileMap.values());
        aggregated.sort((a, b) => b._score - a._score);
        aggregated = aggregated.slice(0, topK);

        // Strip internal _score to produce SearchResultItem shape
        let items = aggregated.map(({ _score, ...rest }) => rest);

        try {
            items = await LLM.rerank(query, items, (item) => item.snippet);
        } catch (err) {
            logger.warn(`[filemgr] searchFileByContent rerank failed: ${err.message}`);
        }

        return this._wrapResult(query, items, result.totalCount);
    }

    /**
     * Legacy keyword search — kept for Electron UI compat (fileview.js reads .path).
     * Returns SearchResultItem[] (snippet always null — keyword search doesn't produce snippets).
     * @param {string} keyword
     * @returns {Promise<SearchResultItem[]>}
     */
    async searchFilesByKeyword(keyword) {
        const result = await this.storage.search([
            { indexer: 'BaseIndexer', field: 'filename', operator: 'like', value: `%${keyword}%` }
        ]);
        return result.items.map((it) => ({
            path: it.item.item_id,
            filename: it.item.filename,
            modified: it.item.modified,
            size: it.item.size,
            snippet: null
        }));
    }

    // ── Delete detection ────────────────────────────────────────────

    /**
     * Remove root from root_refs for items matching the predicate.
     * Items whose root_refs become empty are deleted; others are updated.
     * @param {string} root
     * @param {(itemId: string) => boolean} [shouldRemove] - defaults to always true
     * @returns {Promise<{deleted: number, detached: number}>}
     */
    async _removeRootFromItems(root, shouldRemove = () => true) {
        const all = await this.storage.search([]);

        const toUpdate = [];
        const toDelete = [];

        for (const it of all.items) {
            const item = it.item;
            const rootRefs = this._parseRootRefs(item.root_refs);
            if (!rootRefs.includes(root)) continue;
            if (!shouldRemove(item.item_id)) continue;

            const newRefs = rootRefs.filter((r) => r !== root);
            if (newRefs.length === 0) {
                toDelete.push(item.item_id);
            } else {
                toUpdate.push({
                    item_id: item.item_id,
                    item_type: 'file',
                    root_refs: JSON.stringify(newRefs)
                });
            }
        }

        if (toDelete.length > 0) await this.storage.delete(toDelete);
        if (toUpdate.length > 0) await this.storage.update(toUpdate);

        return { deleted: toDelete.length, detached: toUpdate.length };
    }

    /**
     * @param {string} scannerRoot
     * @param {Set<string>} scannedPaths
     */
    async removeDeletedFiles(scannerRoot, scannedPaths) {
        const { deleted, detached } = await this._removeRootFromItems(
            scannerRoot,
            (itemId) => !scannedPaths.has(itemId)
        );
        logger.info(`[filemgr] root ${scannerRoot}: delete=${deleted}, detach=${detached}`);
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

    // ── Soft reset ───────────────────────────────────────────────────

    /**
     * Soft reset: wipes vector/chunk indexers + WAL/SHM sidecars, preserves base-index.db,
     * sets all base file rows embedded=0 (decision #17). Used by chunk_level / embedding_model /
     * vec_dim changes (decision #2) and vector/chunk file corruption.
     *
     * Caller MUST update scannerState (vec_dim / embedding_model / chunk_level) BEFORE calling
     * if those are changing, since this method does not touch scannerState. dim/mode are passed
     * explicitly to avoid relying on stale state mid-transition.
     */
    async _resetVectorChunk(reason, { dim, mode }) {
        if (typeof dim !== 'number' || (mode !== 'full' && mode !== 'base-only')) {
            throw new Error(`_resetVectorChunk: dim and mode are required (got dim=${dim}, mode=${mode})`);
        }
        logger.warn(`[filemgr] _resetVectorChunk: ${reason} (dim=${dim}, mode=${mode})`);
        try {
            this.storage?.close?.();
        } catch {}
        // Vector/Chunk DBs use SQLite WAL — must also remove -wal / -shm sidecars,
        // otherwise the next open may replay stale state.
        const filesToRemove = [
            'vector-index.db',
            'vector-index.db-wal',
            'vector-index.db-shm',
            'chunk-index.db',
            'chunk-index.db-wal',
            'chunk-index.db-shm'
        ];
        for (const f of filesToRemove) {
            const p = path.join(this._storageDir, f);
            if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
        }
        this.storage = new BaseStorage('filemgr', makeSchema(dim, { mode }), this._storageDir);
        await this.storage.initialize();

        const { items: fileItems } = await this.storage.search([
            { indexer: 'BaseIndexer', field: 'type', operator: '=', value: 'file' }
        ]);
        await this.storage.upsert(
            fileItems.map((r) => ({ ...r.item, embedded: 0 })),
            { indexers: ['BaseIndexer'] }
        );
        this.mode = mode;
    }

    // ── Status ───────────────────────────────────────────────────────

    async getStatus() {
        if (!this.storage) return null;
        const status = await this.storage.getStatus();

        const { totalCount: total } = await this.storage.search([
            { indexer: 'BaseIndexer', field: 'type', operator: '=', value: 'file' }
        ]);
        const { totalCount: embedded } = await this.storage.search([
            { indexer: 'BaseIndexer', field: 'type', operator: '=', value: 'file' },
            { indexer: 'BaseIndexer', field: 'embedded', operator: '=', value: 1 }
        ]);

        return {
            mode: this.mode,
            total_files: total,
            embedded_count: embedded,
            pending_count: total - embedded,
            last_embedding_task_at: this.scannerState.last_embedding_task_at,
            db_size: status.BaseIndexer?.size ?? 0,
            vecdb_size: status.VectorIndexer?.size ?? 0,
            chunk_size: status.ChunkIndexer?.size ?? 0
        };
    }
}

export { FileEntrySchema, FSStorage, RebuildRequiredError, SCAN_INTERVAL_MS, WARNINGS, makeSchema };
