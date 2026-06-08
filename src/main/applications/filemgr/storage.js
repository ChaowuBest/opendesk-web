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

import { getOpendeskDirectory, Setting } from '../../utils/setting.js';
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
const NORMAL_SCAN_INTERVAL_MS = 5 * 60 * 1000;
const WORKSPACE_SCAN_INTERVAL_MS = 60 * 1000;
const WORKSPACE_SCAN_INTERVAL_WHILE_EMBEDDING_MS = 180 * 1000;
const QUERY_LIMIT = 50;
const WORKSPACE_EMBEDDING_PRIORITY_WEIGHT = 2;
const CONTENT_EMBED_MAX_TOTAL_CHARS_PER_FILE = 64 * 1024;
const CONTENT_EMBED_MAX_CHUNKS_PER_FILE = 64;
const CONTENT_EMBED_MAX_CHARS_PER_CHUNK = 2048;
const EMBED_API_BATCH_SIZE = 32;
const EMBED_API_MAX_RETRIES = 8;
const EMBED_API_RETRY_INITIAL_DELAY_MS = 2000;
const EMBED_API_RETRY_MAX_DELAY_MS = 120 * 1000;
const ACCEPTING_SEMANTIC_WRITE_STATE = Object.freeze({
    vector: Object.freeze({ acceptingWrites: true }),
    chunk: Object.freeze({ acceptingWrites: true })
});

// ── User-facing warning strings ────────────────────────────────────
const WARNINGS = {
    NO_EMBEDDING_MODEL: '未配置向量嵌入模型，语义搜索不可用。请运行 /config 配置"向量嵌入模型"。',
    NO_ROOTS: '未配置扫描目录，没有任何文件被索引。请运行 /config 添加文件扫描路径。',
    INITIAL_SCAN: '首次扫描进行中，索引数据可能不完整。如结果为空或不理想，请稍后重试。',
    EMBED_API_DOWN: 'embedding API 暂时不可用，请稍后重试。',
    DEFERRED: '文件索引尚未就绪，请稍后重试。',
    READONLY_MODE: 'READONLY_MODE',
    SEMANTIC_PARTIAL: '部分智能内容搜索暂不可用，已显示可用结果'
};

const CODES = {
    EMBED_UNAVAILABLE: 'EMBED_UNAVAILABLE',
    EMBED_API_DOWN: 'EMBED_API_DOWN',
    INDEX_NOT_READY: 'INDEX_NOT_READY',
    SEMANTIC_PARTIAL: 'SEMANTIC_PARTIAL',
    SEARCH_FAILED: 'SEARCH_FAILED'
};

function normalizeRootPath(value) {
    if (value === '/') return value;
    return String(value).replace(/\/+$/, '');
}

function isSameOrAncestor(ancestor, itemPath) {
    const normalizedAncestor = normalizeRootPath(ancestor);
    const normalizedItem = normalizeRootPath(itemPath);
    if (normalizedAncestor === '/') return normalizedItem.startsWith('/');
    return normalizedItem === normalizedAncestor || normalizedItem.startsWith(`${normalizedAncestor}/`);
}

function nextLexicographicPrefix(value) {
    if (!value) return '\uffff';
    const lastIndex = value.length - 1;
    const lastCode = value.charCodeAt(lastIndex);
    if (lastCode >= 0xffff) return `${value}\u0000`;
    return `${value.slice(0, lastIndex)}${String.fromCharCode(lastCode + 1)}`;
}

function findSafeSplitIndex(text, limit) {
    const windowStart = Math.max(1, Math.floor(limit * 0.6));
    const slice = text.slice(0, limit);
    const boundaryPatterns = [/\n\s*\n/g, /\n/g, /[。！？.!?；;，,]\s*/g, /\s+/g];

    for (const pattern of boundaryPatterns) {
        let best = -1;
        let match;
        while ((match = pattern.exec(slice)) !== null) {
            const index = match.index + match[0].length;
            if (index >= windowStart && index <= limit) best = index;
        }
        if (best > 0) return best;
    }

    return limit;
}

function splitSafeEmbeddingChunk(chunk, maxChars = CONTENT_EMBED_MAX_CHARS_PER_CHUNK) {
    const text = typeof chunk?.text === 'string' ? chunk.text : '';
    if (!text) return [];
    if (text.length <= maxChars) {
        return [{ id: chunk.id, text }];
    }

    const parts = [];
    let rest = text;
    let partIndex = 0;
    while (rest.length > maxChars) {
        const splitIndex = findSafeSplitIndex(rest, maxChars);
        const part = rest.slice(0, splitIndex).trim();
        if (part) {
            parts.push({ id: `${chunk.id}.part${partIndex}`, text: part });
            partIndex += 1;
        }
        rest = rest.slice(splitIndex).trimStart();
    }
    if (rest.trim()) {
        parts.push({ id: `${chunk.id}.part${partIndex}`, text: rest.trim() });
    }
    return parts;
}

function normalizeSemanticWriteState(state) {
    const normalize = (availability) => ({
        ...availability,
        acceptingWrites: availability?.acceptingWrites !== false
    });
    return {
        vector: normalize(state?.vector),
        chunk: normalize(state?.chunk)
    };
}

function planEmbeddingInputs(
    chunks,
    {
        maxTotalChars = CONTENT_EMBED_MAX_TOTAL_CHARS_PER_FILE,
        maxChunks = CONTENT_EMBED_MAX_CHUNKS_PER_FILE,
        maxChunkChars = CONTENT_EMBED_MAX_CHARS_PER_CHUNK
    } = {}
) {
    const inputChunks = Array.isArray(chunks) ? chunks : [];
    const safeChunks = inputChunks.flatMap((chunk) => splitSafeEmbeddingChunk(chunk, maxChunkChars));
    const selectedChunks = [];
    let selectedChars = 0;

    for (const chunk of safeChunks) {
        if (selectedChunks.length >= maxChunks) break;
        if (selectedChars + chunk.text.length > maxTotalChars) break;
        selectedChunks.push(chunk);
        selectedChars += chunk.text.length;
    }

    return {
        selectedChunks,
        selectedChars,
        originalChunkCount: inputChunks.length,
        safeChunkCount: safeChunks.length,
        truncated: selectedChunks.length < safeChunks.length
    };
}

function limitChunksForEmbedding(chunks) {
    return planEmbeddingInputs(chunks).selectedChunks;
}

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
        root_refs: { type: 'TEXT', nullable: false },
        ref_count: { type: 'INTEGER', nullable: false, defaultValue: 0 },
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
        _migratedRefCount: false,
        roots: {},
        probe_permanent_error: null,
        last_rebuild_event: null,
        unavailable_roots: {}
    };
}

// ── Embedding helpers ──────────────────────────────────────────────
function safeStringify(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function normalizeEmbeddingError(err) {
    const status = Number(
        err?.status ?? err?.statusCode ?? err?.response?.status ?? err?.cause?.status ?? err?.error?.status
    );
    const normalizedStatus = Number.isFinite(status) ? status : null;
    const messageParts = [
        err?.message,
        err?.name,
        err?.code,
        err?.type,
        err?.error?.message,
        err?.error?.code,
        err?.error?.type,
        err?.response?.data?.error?.message,
        err?.response?.data?.error?.code,
        err?.response?.data?.error?.type,
        err?.body?.error?.message,
        err?.body?.error?.code,
        err?.body?.error?.type,
        safeStringify(err?.response?.data),
        safeStringify(err?.body)
    ].filter(Boolean);
    const message = messageParts.join(' ');
    return {
        status: normalizedStatus,
        message,
        haystack: `${normalizedStatus ?? ''} ${message}`.toLowerCase()
    };
}

const EMBEDDING_ERROR_RULES = [
    {
        kind: 'quota',
        code: 'quota_exceeded',
        match: 'pattern',
        patterns: [
            /quota/i,
            /monthly limit/i,
            /key limit/i,
            /limit exceeded/i,
            /insufficient balance/i,
            /insufficient credit/i,
            /billing/i,
            /余额/,
            /额度/,
            /欠费/
        ]
    },
    { kind: 'quota', code: 'quota_exceeded', match: 'status', statuses: [402] },
    { kind: 'config', code: 'invalid_api_key', match: 'status', statuses: [401] },
    {
        kind: 'config',
        code: 'invalid_api_key',
        match: 'pattern',
        patterns: [/invalid api key/i, /unauthorized/i, /authentication/i, /invalid token/i]
    },
    { kind: 'config', code: 'model_not_found', match: 'status', statuses: [404] },
    {
        kind: 'config',
        code: 'invalid_model',
        match: 'status+pattern',
        statuses: [400],
        patterns: [
            /invalid model/i,
            /unsupported model/i,
            /model not found/i,
            /model does not exist/i,
            /unknown model/i,
            /invalid provider/i
        ]
    },
    { kind: 'file', code: 'payload_too_large', match: 'status', statuses: [413, 422] },
    {
        kind: 'file',
        code: 'payload_too_large',
        match: 'status+pattern',
        statuses: [400],
        patterns: [
            /payload too large/i,
            /request too large/i,
            /input too long/i,
            /maximum context/i,
            /context length/i,
            /too many tokens/i,
            /token limit/i,
            /invalid input/i,
            /empty input/i
        ]
    },
    {
        kind: 'transient',
        code: 'rate_limited',
        match: 'status',
        statuses: [408, 409, 425, 429, 500, 502, 503, 504]
    },
    {
        kind: 'transient',
        code: 'network_error',
        match: 'pattern',
        patterns: [
            /rate limit/i,
            /too many requests/i,
            /timeout/i,
            /temporarily unavailable/i,
            /overloaded/i,
            /server error/i,
            /econnreset/i,
            /etimedout/i,
            /enotfound/i,
            /econnrefused/i,
            /fetch failed/i,
            /network/i,
            /terminated/i
        ]
    }
];

function embeddingErrorRuleMatches(rule, evidence) {
    const statusMatches = Array.isArray(rule.statuses) && rule.statuses.includes(evidence.status);
    const patternMatches =
        Array.isArray(rule.patterns) && rule.patterns.some((pattern) => pattern.test(evidence.haystack));
    if (rule.match === 'status') return statusMatches;
    if (rule.match === 'pattern') return patternMatches;
    if (rule.match === 'status+pattern') return statusMatches && patternMatches;
    return false;
}

function classifyEmbeddingError(err) {
    const evidence = normalizeEmbeddingError(err);
    const rule = EMBEDDING_ERROR_RULES.find((candidate) => embeddingErrorRuleMatches(candidate, evidence));
    const kind = rule?.kind ?? 'unknown';
    return {
        kind,
        code: rule?.code ?? 'unknown',
        retryable: kind === 'transient' || kind === 'unknown',
        scope: kind === 'file' ? 'file' : 'global',
        status: evidence.status,
        message: err?.message ?? evidence.message ?? ''
    };
}

function getEmbedRetryDelayMs(currentDelayMs) {
    const jitter = 0.5 + Math.random();
    return Math.max(500, Math.min(Math.round(currentDelayMs * jitter), EMBED_API_RETRY_MAX_DELAY_MS));
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatProbeError(code, rawMessage) {
    switch (code) {
        case '401':
        case 'invalid_api_key':
            return 'API Key 无效或已过期';
        case '403':
            return 'API Key 权限不足，无法访问该模型';
        case 'quota_exceeded':
            return `API Key 额度不足或已达到限制（${rawMessage}）`;
        case '404':
        case 'model_not_found':
            return `模型或接口地址不存在（${rawMessage}）`;
        case '400':
        case 'invalid_model':
            return `请求格式错误，可能将非 embedding 模型用于向量化（${rawMessage}）`;
        case 'payload_too_large':
            return `嵌入模型无法处理测试输入（${rawMessage}）`;
        default:
            return rawMessage ?? '嵌入 API 请求失败';
    }
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
        this.onStateChanged = null;
        this.deferredReason = null;
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
                    val.last_file_count ??= val.total_files ?? 0;
                    if (val.last_scan_at === undefined) {
                        val.last_scan_at = val.last_full_scan === 0 ? null : val.last_full_scan;
                    }
                    if (val.last_scan_at !== null && typeof val.last_scan_at !== 'number') {
                        throw new Error(`invalid root last_scan_at: ${key}`);
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
     * @param {string[]} texts
     * @returns {Promise<number[][]>}
     */
    async _embedWithRetry(texts) {
        let attempt = 0;
        let currentDelayMs = EMBED_API_RETRY_INITIAL_DELAY_MS;

        while (true) {
            try {
                return await LLM.batchEmbed(texts, EMBED_API_BATCH_SIZE);
            } catch (err) {
                const classification = classifyEmbeddingError(err);
                if (classification.kind !== 'transient') {
                    throw err;
                }

                attempt++;
                if (attempt > EMBED_API_MAX_RETRIES) {
                    throw err;
                }

                const delayMs = getEmbedRetryDelayMs(currentDelayMs);
                currentDelayMs = Math.min(currentDelayMs * 2, EMBED_API_RETRY_MAX_DELAY_MS);
                logger.warn(`[filemgr] embed retry ${attempt}, waiting ${delayMs}ms: ${err.message}`);
                await sleep(delayMs);
            }
        }
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

    _wrapBaseOnlySemanticResult(query) {
        if (this.scannerState.probe_permanent_error) {
            return this._wrapResult(query, [], 0, WARNINGS.EMBED_API_DOWN, CODES.EMBED_API_DOWN);
        }

        return this._wrapResult(query, [], 0, WARNINGS.NO_EMBEDDING_MODEL, CODES.EMBED_UNAVAILABLE);
    }

    _computeWarning() {
        if (!Setting.getInstance().getDefaultEmbeddingModelInstance()) {
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

    async _setPermanentError(code, rawMessage) {
        const error = { code, message: formatProbeError(code, rawMessage), ts: Date.now() };
        const prev = this.scannerState.probe_permanent_error;
        if (prev && prev.code === error.code && prev.message === error.message) return;
        this.scannerState.probe_permanent_error = error;
        await this.saveScannerState();
        this.onStateChanged?.();
    }

    async _clearPermanentError() {
        if (this.scannerState.probe_permanent_error === null) return;
        this.scannerState.probe_permanent_error = null;
        await this.saveScannerState();
        this.onStateChanged?.();
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
            await this.rebuildAll('base_init_failed');
            return;
        }

        await this._migrateRefCount();
        await this.syncEmbeddingMode('initialize');
    }

    async initializeReadonly() {
        this._loadScannerState();
        this.deferredReason = null;

        if (!fs.existsSync(path.join(this._storageDir, 'base-index.db'))) {
            this.storage = null;
            this.deferredReason = 'missing_base_index';
            return;
        }

        const dim = this.scannerState.vec_dim ?? 1024;
        const hasEmbeddingState = Boolean(this.scannerState.embedding_model && this.scannerState.vec_dim);
        const hasVectorFiles =
            fs.existsSync(path.join(this._storageDir, 'vector-index.db')) &&
            fs.existsSync(path.join(this._storageDir, 'chunk-index.db'));
        const mode = hasEmbeddingState && hasVectorFiles ? 'full' : 'base-only';

        try {
            this.storage = new BaseStorage('filemgr', makeSchema(dim, { mode }), this._storageDir);
            await this.storage.initialize();
            this.mode = mode;
        } catch {
            this.storage = null;
            this.deferredReason = 'open_failed';
        }
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
            await this._clearPermanentError();
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
            await this._clearPermanentError();
        } catch (err) {
            const classification = classifyEmbeddingError(err);
            if (['config', 'quota', 'file'].includes(classification.kind)) {
                await this._setPermanentError(classification.code, classification.message);
                logger.warn(`[filemgr] syncEmbeddingMode probe permanent error: ${err.message}`);
            } else {
                logger.warn(
                    `[filemgr] syncEmbeddingMode probe transient error (${classification.kind}): ${err.message}`
                );
            }
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
                await this._resetVectorChunk('open_full_failed', { dim: probe.dim, mode: 'full' });
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
                await this._resetVectorChunk('open_full_failed', {
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
            await this._resetVectorChunk('embedding_config_changed', { dim: probe.dim, mode: 'full' });
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
     * syncEmbeddingMode decides whether vectors can be enabled afterwards.
     *
     * @param {string} reason
     */
    async rebuildAll(reason) {
        logger.warn(`[filemgr] rebuildAll: ${reason}`);
        let failure = null;
        try {
            const rebuildDir = this._storageDir + '.rebuild';
            if (fs.existsSync(rebuildDir)) {
                fs.rmSync(rebuildDir, { recursive: true, force: true });
            }

            let rebuildStorage;
            try {
                rebuildStorage = new BaseStorage('filemgr', makeSchema(1024, { mode: 'base-only' }), rebuildDir);
                await rebuildStorage.initialize();
            } finally {
                try {
                    rebuildStorage?.close();
                } catch {}
            }

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

            try {
                this.storage = new BaseStorage('filemgr', makeSchema(1024, { mode: 'base-only' }), this._storageDir);
                await this.storage.initialize();
            } catch (err) {
                this.storage = null;
                this.scannerState.vec_dim = null;
                this.scannerState.embedding_model = null;
                await this.saveScannerState().catch(() => {});
                err._postSwap = true;
                throw err;
            }

            for (const root of Object.keys(this.scannerState.roots)) {
                this.scannerState.roots[root].last_full_scan = 0;
            }
            this.scannerState.vec_dim = null;
            this.scannerState.embedding_model = null;
            this.scannerState.chunk_level = null;
            this.scannerState.embedded_migrated = false;
            this.mode = 'base-only';
            await this.saveScannerState();
            await this.syncEmbeddingMode(reason);
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

        const semanticWriteState = await this._getSemanticWriteState();
        if (semanticWriteState.vector.acceptingWrites === false) {
            await this._markFileEmbedded(baseRow, stat);
            return { status: 'semantic_write_limited', target: 'vector' };
        }

        const { chunks, chunk_type } = await parseAndChunk(filePath, { level: CHUNK_LEVEL });
        const hasUsableChunks = chunk_type !== 'filename' && Array.isArray(chunks) && chunks.length > 0;

        const plan = hasUsableChunks ? planEmbeddingInputs(chunks) : planEmbeddingInputs([]);
        const selectedChunks =
            semanticWriteState.chunk.acceptingWrites === false || !semanticWriteState.vector.acceptingWrites
                ? []
                : plan.selectedChunks;
        if (chunk_type !== 'filename' && chunks === null) {
            logger.warn(`[filemgr] embed: content skipped, filename-only embedding: ${filePath}`);
        }
        if (hasUsableChunks && semanticWriteState.chunk.acceptingWrites !== false && plan.truncated) {
            logger.warn(
                `[filemgr] embed: truncated chunks for large file: ${filePath} ` +
                    `(${selectedChunks.length} / ${plan.safeChunkCount} safe chunks, ` +
                    `${plan.selectedChars} / ${CONTENT_EMBED_MAX_TOTAL_CHARS_PER_FILE} chars)`
            );
        }

        const texts = [baseRow.filename];
        if (selectedChunks.length > 0) texts.push(...selectedChunks.map((c) => c.text));
        const embeddings = await this._embedWithRetry(texts);

        const statAfter = await fs.promises.stat(filePath).catch(() => null);
        if (!statAfter || statAfter.mtimeMs !== stat.mtimeMs || statAfter.size !== stat.size) {
            logger.info(`[filemgr] embed: file changed during parse/embed, skip: ${filePath}`);
            return { status: 'skipped_drift' };
        }

        const indexer_columns = {
            VectorIndexer: [{ column: 'filename', content: embeddings[0] }]
        };
        if (selectedChunks.length > 0) {
            indexer_columns.ChunkIndexer = selectedChunks.map((c, i) => ({
                column: 'chunk_text',
                id: c.id,
                text: c.text,
                content: embeddings[i + 1]
            }));
        }

        const targets = selectedChunks.length > 0 ? ['VectorIndexer', 'ChunkIndexer'] : ['VectorIndexer'];
        if (selectedChunks.length > 0) {
            await this.storage.clearIndexerForItem(baseRow.item_id, 'ChunkIndexer');
        }
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

        await this._markFileEmbedded(baseRow, statAfter);
    }

    async _getSemanticWriteState() {
        if (this.mode !== 'full') return ACCEPTING_SEMANTIC_WRITE_STATE;
        return normalizeSemanticWriteState(await this.storage?.getSemanticWriteState?.());
    }

    async _markFileEmbedded(baseRow, stat) {
        await this.storage.update(
            [
                {
                    item_id: baseRow.item_id,
                    item_type: 'file',
                    modified: stat.mtimeMs,
                    size: stat.size,
                    accessed: stat.atimeMs,
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
     * @param {{ activeRoots?: string[], currentWorkspace?: string | null, limit?: number }} [options]
     * @returns {Promise<number>}
     */
    async processEmbeddingQueue(
        isScanPending,
        { activeRoots = [], currentWorkspace = null, limit = QUERY_LIMIT } = {}
    ) {
        if (this.mode !== 'full') return 0;

        let totalProcessed = 0;
        let consecutiveFailures = 0;
        const skippedFiles = new Set();
        const searchPendingItems = async (embeddedState) => {
            const { items } = await this.storage.search([
                { indexer: 'BaseIndexer', field: 'embedded', operator: '=', value: embeddedState },
                { indexer: 'BaseIndexer', field: 'type', operator: '=', value: 'file' },
                { indexer: 'BaseIndexer', field: 'ref_count', operator: '>', value: 0 }
            ]);
            return items.map((r) => r.item).filter((r) => !skippedFiles.has(r.item_id));
        };
        const markEmbeddingFailed = async (file, embeddedState = -1) => {
            await this.storage.update([{ item_id: file.item_id, item_type: 'file', embedded: embeddedState }], {
                indexers: ['BaseIndexer']
            });
        };

        while (true) {
            if (isScanPending()) break;

            let fresh = await searchPendingItems(0);
            if (fresh.length === 0) {
                fresh = await searchPendingItems(-1);
            }
            const candidates = this._selectPendingEmbeddingCandidates(fresh, {
                activeRoots,
                currentWorkspace,
                limit
            });
            if (candidates.length === 0) break;

            for (const file of candidates) {
                if (isScanPending()) break;
                try {
                    const result = await this.embedSingleFile(file);
                    if (result?.status === 'skipped_drift') {
                        skippedFiles.add(file.item_id);
                        consecutiveFailures = 0;
                        continue;
                    }
                    totalProcessed++;
                    consecutiveFailures = 0;
                } catch (e) {
                    const classification = classifyEmbeddingError(e);
                    const msg = e?.message ?? '';

                    if (classification.kind === 'config' || classification.kind === 'quota') {
                        await this._setPermanentError(classification.code, classification.message);
                        await this._demoteToBaseOnly(`embedding queue: ${classification.code}`);
                        consecutiveFailures = 3;
                        logger.warn(`[filemgr] embed permanent API error for ${file.item_id}: ${msg}`);
                        break;
                    } else if (classification.kind === 'file') {
                        await markEmbeddingFailed(file, -2);
                        logger.warn(
                            `[filemgr] embed permanent file error, disabling content embedding for ${file.item_id}: ${msg}`
                        );
                        skippedFiles.add(file.item_id);
                        consecutiveFailures = 0;
                    } else {
                        await markEmbeddingFailed(file);
                        skippedFiles.add(file.item_id);
                        consecutiveFailures++;
                        logger.warn(`[filemgr] embed API error (${consecutiveFailures}/3) for ${file.item_id}: ${msg}`);
                        if (consecutiveFailures >= 3) break;
                    }
                }
            }
            if (consecutiveFailures >= 3 || isScanPending()) break;
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
        if (!query?.trim()) {
            return this._wrapResult(query, [], 0, null);
        }

        if (this.isDeferred()) {
            return this._wrapResult(query, [], 0, WARNINGS.DEFERRED, CODES.INDEX_NOT_READY);
        }

        if (this.mode === 'base-only') {
            return this._wrapBaseOnlySemanticResult(query);
        }

        let queryEmbedding;
        try {
            // Short retry for transient 429s; user-waiting path so cap small.
            queryEmbedding = await withRateLimitRetry(() => LLM.embed(query), { maxRetries: 2 });
        } catch (err) {
            logger.warn(`[filemgr] searchFileByName embed failed: ${err.message}`);
            return this._wrapResult(query, [], 0, WARNINGS.EMBED_API_DOWN, CODES.EMBED_API_DOWN);
        }

        const result = await this.storage.search([
            {
                indexer: 'VectorIndexer',
                field: 'filename',
                operator: 'vector_near',
                value: queryEmbedding,
                vectorQuery: { topK, metric: 'cosine' }
            },
            { indexer: 'BaseIndexer', field: 'embedded', operator: '=', value: 1 },
            { indexer: 'BaseIndexer', field: 'ref_count', operator: '>', value: 0 }
        ]);

        let items = result.items.map((it) => ({
            path: it.item.item_id,
            filename: it.item.filename,
            modified: it.item.modified,
            size: it.item.size,
            snippet: null,
            semanticScore: it.VecScore ?? 0
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
        if (!query?.trim()) {
            return this._wrapResult(query, [], 0, null);
        }

        if (this.isDeferred()) {
            return this._wrapResult(query, [], 0, WARNINGS.DEFERRED, CODES.INDEX_NOT_READY);
        }

        if (this.mode === 'base-only') {
            return this._wrapBaseOnlySemanticResult(query);
        }

        let queryEmbedding;
        try {
            // Short retry for transient 429s; user-waiting path so cap small.
            queryEmbedding = await withRateLimitRetry(() => LLM.embed(query), { maxRetries: 2 });
        } catch (err) {
            logger.warn(`[filemgr] searchFileByContent embed failed: ${err.message}`);
            return this._wrapResult(query, [], 0, WARNINGS.EMBED_API_DOWN, CODES.EMBED_API_DOWN);
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
            { indexer: 'BaseIndexer', field: 'embedded', operator: '=', value: 1 },
            { indexer: 'BaseIndexer', field: 'ref_count', operator: '>', value: 0 }
        ]);

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
                    semanticScore: score,
                    _score: score
                });
            }
        }

        let aggregated = Array.from(fileMap.values());
        aggregated.sort((a, b) => b._score - a._score);
        aggregated = aggregated.slice(0, topK);

        let items = aggregated.map(({ _score, ...rest }) => rest);

        try {
            items = await LLM.rerank(query, items, (item) => item.snippet);
        } catch (err) {
            logger.warn(`[filemgr] searchFileByContent rerank failed: ${err.message}`);
        }

        return this._wrapResult(query, items, result.totalCount);
    }

    /**
     * Internal keyword route for aggregated indexed search. Includes storage metadata
     * needed by worker-side final filtering; do not expose directly to renderer callers.
     */
    async searchIndexedFilesByKeyword(keyword, { limit = 150 } = {}) {
        const result = await this.storage.search(
            [
                { indexer: 'BaseIndexer', field: 'filename', operator: 'like', value: `%${keyword}%` },
                { indexer: 'BaseIndexer', field: 'ref_count', operator: '>', value: 0 }
            ],
            { limit, orderBy: { field: 'modified', direction: 'DESC' } }
        );
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
        const { deleted, detached } = await this._removeRootFromItems(removedRoot, undefined, {
            deleteEmptyRefs: true,
            keepEmptyRefsIf: (itemPath) => newRoots.some((root) => isSameOrAncestor(root, itemPath))
        });
        delete this.scannerState.roots[removedRoot];
        await this.saveScannerState();
        logger.info(`[filemgr] detachRootForConfigChange ${removedRoot}: delete=${deleted}, detach=${detached}`);
        return { deleted, detached };
    }

    /**
     * @param {string} scannerRoot
     * @param {Set<string>} scannedPaths
     * @param {{ activeRoots?: string[] }} [options]
     */
    async removeDeletedFiles(scannerRoot, scannedPaths, { activeRoots = [] } = {}) {
        const otherRoots = activeRoots.filter((root) => root !== scannerRoot);
        const { deleted, detached } = await this._removeRootFromItems(
            scannerRoot,
            (itemId) => !scannedPaths.has(itemId),
            {
                deleteEmptyRefs: true,
                keepEmptyRefsIf: (itemPath) => otherRoots.some((root) => isSameOrAncestor(root, itemPath))
            }
        );
        logger.info(`[filemgr] root ${scannerRoot}: delete=${deleted}, detach=${detached}`);
    }

    async removeOrphanedItems() {
        if (this.isDeferred()) return { deleted: 0 };

        const result = await this.storage.search([
            { indexer: 'BaseIndexer', field: 'type', operator: '=', value: 'file' }
        ]);
        const toDelete = result.items
            .filter((it) => this._parseRootRefs(it.item.root_refs).length === 0 || it.item.ref_count === 0)
            .map((it) => it.item.item_id);

        if (toDelete.length > 0) await this.storage.delete(toDelete);
        logger.info(`[filemgr] removeOrphanedItems: delete=${toDelete.length}`);
        return { deleted: toDelete.length };
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

            const result = await this._searchItemsUnderRoot(root);
            let totalFiles = 0;
            let embeddedCount = 0;
            let failedCount = 0;

            for (const it of result.items) {
                const item = it.item;
                if ((item.ref_count ?? this._parseRootRefs(item.root_refs).length) <= 0) continue;
                totalFiles++;
                if (this.mode !== 'base-only' && (item.embedded === 1 || item.embedded === true)) {
                    embeddedCount++;
                } else if (this.mode !== 'base-only' && item.embedded === -2) {
                    failedCount++;
                }
            }

            counts.set(root, {
                total_files: totalFiles,
                embedded_count: embeddedCount,
                pending_count: Math.max(0, totalFiles - embeddedCount - failedCount),
                failed_count: failedCount,
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
        let failure = null;
        try {
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
        } catch (err) {
            failure = err;
            throw err;
        } finally {
            this.scannerState.last_rebuild_event = {
                type: 'vector',
                reason,
                status: failure ? 'failed' : 'completed',
                ts: Date.now(),
                ...(failure && { message: failure.message })
            };
            await this._persistRebuildEvent(failure);
        }
    }

    // ── Status ───────────────────────────────────────────────────────

    async getStatus() {
        if (!this.storage) return null;
        const status = await this.storage.getStatus();
        const semanticWriteState = this.mode === 'full' ? await this._getSemanticWriteState() : null;

        const { totalCount: total } = await this.storage.search([
            { indexer: 'BaseIndexer', field: 'type', operator: '=', value: 'file' },
            { indexer: 'BaseIndexer', field: 'ref_count', operator: '>', value: 0 }
        ]);
        const { totalCount: embedded } = await this.storage.search([
            { indexer: 'BaseIndexer', field: 'type', operator: '=', value: 'file' },
            { indexer: 'BaseIndexer', field: 'embedded', operator: '=', value: 1 },
            { indexer: 'BaseIndexer', field: 'ref_count', operator: '>', value: 0 }
        ]);

        return {
            mode: this.mode,
            total_files: total,
            embedded_count: embedded,
            pending_count: total - embedded,
            last_embedding_task_at: this.scannerState.last_embedding_task_at,
            db_size: status.BaseIndexer?.size ?? 0,
            vecdb_size: status.VectorIndexer?.size ?? 0,
            chunk_size: status.ChunkIndexer?.size ?? 0,
            semantic_write_state: semanticWriteState
        };
    }
}

export {
    CODES,
    CONTENT_EMBED_MAX_CHARS_PER_CHUNK,
    CONTENT_EMBED_MAX_CHUNKS_PER_FILE,
    CONTENT_EMBED_MAX_TOTAL_CHARS_PER_FILE,
    EMBED_API_BATCH_SIZE,
    FileEntrySchema,
    FSStorage,
    NORMAL_SCAN_INTERVAL_MS,
    RebuildRequiredError,
    WARNINGS,
    WORKSPACE_SCAN_INTERVAL_MS,
    WORKSPACE_SCAN_INTERVAL_WHILE_EMBEDDING_MS,
    classifyEmbeddingError,
    limitChunksForEmbedding,
    makeSchema,
    planEmbeddingInputs
};
