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
import PQueue from 'p-queue';

// ── Code constants (not in config schema) ──────────────────────────
const CHUNK_LEVEL = 'structured';
const INDEX_CONCURRENCY = 4;
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
class EmbeddingNotConfiguredError extends Error {
    constructor() {
        super('default embedding model not configured');
        this.name = 'EmbeddingNotConfiguredError';
    }
}

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
 * @returns {import('../../services/storage/abstract-storage.js').ColumnSchema}
 */
function makeSchema(dim) {
    return {
        columns: {
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
            root_refs: { type: 'TEXT', nullable: false }
        },
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
        chunk_level: null,
        roots: {}
    };
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
        this._indexQueue = new PQueue({ concurrency: INDEX_CONCURRENCY });
        this._stateWriteChain = Promise.resolve();

        this.scannerState = defaultScannerState();
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
                if (state.chunk_level !== null && typeof state.chunk_level !== 'string') {
                    throw new Error('invalid chunk_level field');
                }
                // Validate each root entry has all required numeric fields (spec §3.2)
                for (const [key, val] of Object.entries(state.roots)) {
                    if (
                        !val ||
                        typeof val !== 'object' ||
                        typeof val.last_full_scan !== 'number' ||
                        typeof val.total_files !== 'number' ||
                        typeof val.last_failed_count !== 'number'
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
            return this._handleCorruptState();
        }

        const state = this.scannerState;

        // chunk_level check — must precede probe (spec §13.5 Step 1)
        if (state.vec_dim !== null && state.chunk_level !== CHUNK_LEVEL) {
            logger.warn(`[filemgr] chunk_level mismatch: stored=${state.chunk_level}, current=${CHUNK_LEVEL}`);
            return this.rebuildAll(
                `chunk_level changed: ${state.chunk_level} -> ${CHUNK_LEVEL}`,
                state.vec_dim,
                state.embedding_model
            );
        }

        // Probe embedding dim+model (spec §13.5 Step 2)
        const { dim: probedDim, model: probedModel } = await this._tryProbe();

        if (state.vec_dim !== null) {
            if (probedDim !== null && (probedDim !== state.vec_dim || probedModel !== state.embedding_model)) {
                return this.rebuildAll(
                    `dim/model changed: ${state.vec_dim}/${state.embedding_model} -> ${probedDim}/${probedModel}`,
                    probedDim,
                    probedModel
                );
            }
            await this._initBaseStorage(state.vec_dim);
        } else if (probedDim !== null) {
            await this._initBaseStorage(probedDim);
            state.vec_dim = probedDim;
            state.embedding_model = probedModel;
            state.chunk_level = CHUNK_LEVEL;
            await this.saveScannerState();
        } else {
            logger.warn('[filemgr] deferred init: no stored vec_dim and probe unavailable');
        }
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

    /** @returns {Promise<void>} */
    async _handleCorruptState() {
        this._stateCorrupt = false;
        logger.warn('[filemgr] scanner_state corrupt (Type 1)');
        let probe;
        try {
            probe = await this._probeEmbedding();
        } catch (err) {
            logger.warn(`[filemgr] probe failed during corruption recovery: ${err.message}`);
            // Persist the in-memory default state so the corrupt JSON on disk
            // is overwritten — otherwise next startup re-enters this path.
            await this.saveScannerState();
            return; // deferred per spec §9.1 — state reset to vec_dim=null
        }
        await this.rebuildAll('scanner_state.json corrupt', probe.dim, probe.model_name);
    }

    /** @returns {Promise<{dim: number|null, model: string|null}>} */
    async _tryProbe() {
        try {
            // Refresh Setting cache — main thread may have written setting.json
            // (e.g. user just configured embedding model in TUI) without notifying
            // this worker thread. Without this, deferred recovery sees stale cache.
            this.refreshLatestSetting();
            Setting.getInstance().getDefaultEmbeddingModelInstance();
        } catch {
            return { dim: null, model: null };
        }
        try {
            const probe = await this._probeEmbedding();
            return { dim: probe.dim, model: probe.model_name };
        } catch (err) {
            logger.warn(`[filemgr] probe failed: ${err.message}`);
            return { dim: null, model: null };
        }
    }

    /**
     * Create and initialize BaseStorage. On failure, wipe and recreate.
     * @param {number} dim
     */
    async _initBaseStorage(dim) {
        try {
            this.storage = new BaseStorage('filemgr', makeSchema(dim), this._storageDir);
            await this.storage.initialize();
        } catch (err) {
            // Init failed (DimMismatchError, SQLite corruption, etc.)
            // Reset to null, then rebuild with known dim + stored model (no probe needed)
            this.storage = null;
            logger.warn(`[filemgr] BaseStorage init failed: ${err.message}, rebuilding`);
            await this.rebuildAll(`init failed: ${err.message}`, dim, this.scannerState.embedding_model);
        }
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
            this.scannerState.roots[root].last_failed_count = 0;
        }
        this.scannerState.vec_dim = newDim;
        this.scannerState.embedding_model = newModel;
        this.scannerState.chunk_level = CHUNK_LEVEL;
        await this.saveScannerState();

        logger.info(`[filemgr] rebuildAll complete: dim=${newDim}, model=${newModel}`);
    }

    // ── Per-file indexing pipeline ──────────────────────────────────

    /**
     * @param {z.infer<typeof FileEntrySchema>} fileEntry
     * @param {{ wasInDb: boolean, existingItem: object|undefined, scannerRoot: string }} opts
     */
    async indexFile(fileEntry, { wasInDb, existingItem, scannerRoot }) {
        // 1. Check embedding config
        try {
            Setting.getInstance().getDefaultEmbeddingModelInstance();
        } catch {
            throw new EmbeddingNotConfiguredError();
        }

        // 2. Parse + chunk
        // parseAndChunk(filePath, options, embedFn) — embedFn only needed for 'semantic' level
        const { chunks, chunk_type } = await parseAndChunk(fileEntry.path, { level: CHUNK_LEVEL });

        // 3. Determine if usable content chunks exist
        const hasUsableChunks = chunk_type !== 'filename' && Array.isArray(chunks) && chunks.length > 0;

        // 4. Build texts to embed: filename always, content chunks conditionally
        const texts = [fileEntry.filename];
        if (hasUsableChunks) {
            texts.push(...chunks.map((c) => c.text));
        }

        // 5. Batch embed with retry
        const embeddings = await this._embedWithRetry(texts);

        // 6. Merge root_refs
        let rootRefs;
        if (wasInDb && existingItem) {
            const existingRefs = this._parseRootRefs(existingItem.root_refs);
            rootRefs = existingRefs.includes(scannerRoot) ? existingRefs : [...existingRefs, scannerRoot];
        } else {
            rootRefs = [scannerRoot];
        }

        // 7. Build indexer_columns
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

        // 8. Build item
        const newItem = {
            item_id: fileEntry.path,
            item_type: 'file',
            filename: fileEntry.filename,
            ext: this._getFileExtension(fileEntry.filename),
            size: fileEntry.size,
            modified: fileEntry.modified,
            created: fileEntry.created,
            accessed: fileEntry.accessed,
            type: fileEntry.type,
            chunk_text: null,
            root_refs: JSON.stringify(rootRefs),
            indexer_columns
        };

        // 9. Write: clear stale chunks if transitioning to no-chunks
        if (wasInDb && !hasUsableChunks) {
            await this.storage.clearIndexerForItem(fileEntry.path, 'ChunkIndexer');
        }
        await this.storage.upsert([newItem]);
    }

    // ── Batch save ──────────────────────────────────────────────────

    /**
     * 假设外层 BaseWorker.taskQueue (concurrency=1) 串行化调用——内部
     * `_indexQueue` 的 drain 逻辑（pause/clear/start）不容忍并发 saveFiles。
     * 详见 worker.js 头部并发不变式说明。
     *
     * @param {z.infer<typeof FileEntrySchema>[]} files
     * @param {string} scannerRoot
     * @returns {Promise<{saved: number, failed: number, failures: Array<{path: string, error: string}>}>}
     */
    async saveFiles(files, scannerRoot) {
        if (files.length === 0) return { saved: 0, failed: 0, failures: [] };

        // 1. Batch query existing records
        const paths = files.map((f) => f.path);
        const existing = await this.storage.search([
            { indexer: 'BaseIndexer', field: 'item_id', operator: 'in', value: paths }
        ]);
        const existingMap = new Map(existing.items.map((it) => [it.item.item_id, it.item]));

        // 2. Three-branch filter
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

            if (modifiedChanged) {
                toFullProcess.push(f);
            } else if (needsRefAdd) {
                toRefUpdateOnly.push({ file: f, existingRefs });
            }
        }

        // 3. Full process path: submit to _indexQueue
        let saved = 0,
            failed = 0;
        /** @type {Array<{path: string, error: string}>} */
        const failures = [];

        const tasks = toFullProcess.map((f) => async () => {
            try {
                await this.indexFile(f, {
                    wasInDb: existingMap.has(f.path),
                    existingItem: existingMap.get(f.path),
                    scannerRoot
                });
                saved++;
            } catch (err) {
                if (err instanceof EmbeddingNotConfiguredError) throw err;
                logger.warn(`[filemgr] failed to index ${f.path}: ${err.message}`);
                failed++;
                failures.push({ path: f.path, error: err.message });
            }
        });
        try {
            await Promise.all(tasks.map((task) => this._indexQueue.add(task)));
        } catch (err) {
            // EmbeddingNotConfiguredError: drain inner queue fully so no
            // in-flight tasks continue writing after outer scan aborts.
            // clear() removes pending tasks; onIdle() waits for running ones.
            this._indexQueue.pause();
            this._indexQueue.clear();
            await this._indexQueue.onIdle();
            this._indexQueue.start();
            throw err;
        }

        // 4. Lightweight root_refs update
        if (toRefUpdateOnly.length > 0) {
            const updates = toRefUpdateOnly.map(({ file, existingRefs }) => {
                const newRefs = [...existingRefs, scannerRoot];
                return {
                    item_id: file.path,
                    item_type: 'file',
                    root_refs: JSON.stringify(newRefs)
                };
            });
            await this.storage.update(updates);
            saved += toRefUpdateOnly.length;
        }

        return { saved, failed, failures };
    }

    // ── Search APIs ─────────────────────────────────────────────────

    /**
     * @param {string} query
     * @param {{ topK?: number }} [opts]
     */
    async searchFileByName(query, { topK = 20 } = {}) {
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
            }
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
            { indexer: 'BaseIndexer', field: 'type', operator: '=', value: 'file' }
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
        const all = await this.storage.search([
            { indexer: 'BaseIndexer', field: 'item_type', operator: '=', value: 'file' }
        ]);

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

    // ── Status ───────────────────────────────────────────────────────

    async getStatus() {
        if (!this.storage) {
            return null;
        }
        const status = await this.storage.getStatus();
        return {
            db_size: status.BaseIndexer?.size ?? 0,
            vecdb_size: status.VectorIndexer?.size ?? 0,
            chunk_size: status.ChunkIndexer?.size ?? 0
        };
    }
}

export { FileEntrySchema, FSStorage, EmbeddingNotConfiguredError, RebuildRequiredError, SCAN_INTERVAL_MS, WARNINGS };
