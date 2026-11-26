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

import fs from 'node:fs';
import type { EmbeddingChunk, Item, RetrievalAccess, RetrievalHost, BuildStepResult } from '../contract.js';
import { logger } from '../../../../utils/logger.js';
import { LLM } from '../../../../aikernel/llm.js';
import { parseAndChunk } from '../../parser/index.js';
import { classifyEmbeddingError, setProbeError } from './state.js';
import { getSemanticWriteState, publishProducts, demoteToBaseOnly, markFileFailed } from './products.js';

export const CHUNK_LEVEL = 'structured';
export const CONTENT_EMBED_MAX_TOTAL_CHARS_PER_FILE = 64 * 1024;
export const CONTENT_EMBED_MAX_CHUNKS_PER_FILE = 64;
export const CONTENT_EMBED_MAX_CHARS_PER_CHUNK = 2048;
export const EMBED_API_BATCH_SIZE = 32;
const EMBED_API_MAX_RETRIES = 8;
const EMBED_API_RETRY_INITIAL_DELAY_MS = 2000;
const EMBED_API_RETRY_MAX_DELAY_MS = 120 * 1000;

function findSafeSplitIndex(text: string, limit: number) {
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

function splitSafeEmbeddingChunk(chunk: EmbeddingChunk, maxChars = CONTENT_EMBED_MAX_CHARS_PER_CHUNK) {
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

export function planEmbeddingInputs(
    chunks: unknown,
    {
        maxTotalChars = CONTENT_EMBED_MAX_TOTAL_CHARS_PER_FILE,
        maxChunks = CONTENT_EMBED_MAX_CHUNKS_PER_FILE,
        maxChunkChars = CONTENT_EMBED_MAX_CHARS_PER_CHUNK
    } = {}
) {
    const inputChunks: EmbeddingChunk[] = Array.isArray(chunks) ? chunks : [];
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

export function limitChunksForEmbedding(chunks: unknown) {
    return planEmbeddingInputs(chunks).selectedChunks;
}

function getEmbedRetryDelayMs(currentDelayMs: number) {
    const jitter = 0.5 + Math.random();
    return Math.max(500, Math.min(Math.round(currentDelayMs * jitter), EMBED_API_RETRY_MAX_DELAY_MS));
}

function sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
export async function embedWithRetry(access: Pick<RetrievalAccess, 'readState'>, texts: string[]) {
    let attempt = 0;
    let currentDelayMs = EMBED_API_RETRY_INITIAL_DELAY_MS;

    while (true) {
        try {
            return await LLM.batchEmbed(
                texts,
                EMBED_API_BATCH_SIZE,
                access.readState().embedding_request_dim ?? undefined
            );
        } catch (value) {
            const err = value as Error;
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

// ── Embedding ───────────────────────────────────────────────────

/**
 * Embed a single file: parse+chunk, embed, write to vector/chunk indexers, mark embedded=1.
 * Returns undefined on success, or {status: 'skipped_drift'} if file changed mid-flight.
 * Unreadable or missing input is left for the scanner to reconcile.
 * @param {object} baseRow - row from BaseIndexer (item_id, filename, etc.)
 * @returns {Promise<{status: 'skipped_drift'} | undefined>}
 */
export async function buildWholeFile(access: RetrievalAccess, baseRow: Item) {
    const filePath = baseRow.item_id;

    const stat = await fs.promises.stat(filePath).catch((error: NodeJS.ErrnoException) => {
        logger.info(`[filemgr] embed: pre-build stat failed, skip: ${filePath}: ${error.code ?? error.message}`);
        return null;
    });
    if (!stat) {
        return { status: 'skipped_drift' };
    }

    const semanticWriteState = await getSemanticWriteState(access);
    if (semanticWriteState.vector.acceptingWrites === false) {
        return { status: 'semantic_write_limited', target: 'vector' };
    }

    const { chunks, chunk_type } = (await parseAndChunk(filePath, { level: CHUNK_LEVEL })) as {
        chunks: EmbeddingChunk[] | null;
        chunk_type: 'filename' | 'chunk' | 'abstract' | null;
    };
    const hasUsableChunks = chunk_type !== 'filename' && Array.isArray(chunks) && chunks.length > 0;

    const plan = hasUsableChunks ? planEmbeddingInputs(chunks) : planEmbeddingInputs([]);
    const selectedChunks = plan.selectedChunks;
    if (selectedChunks.length > 0 && semanticWriteState.chunk.acceptingWrites === false) {
        return { status: 'semantic_write_limited', target: 'chunk' };
    }
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
    const embeddings = await embedWithRetry(access, texts);

    const statAfter = await fs.promises.stat(filePath).catch((error: NodeJS.ErrnoException) => {
        logger.info(`[filemgr] embed: post-build stat failed, skip: ${filePath}: ${error.code ?? error.message}`);
        return null;
    });
    if (!statAfter || statAfter.mtimeMs !== stat.mtimeMs || statAfter.size !== stat.size) {
        logger.info(`[filemgr] embed: file changed during parse/embed, skip: ${filePath}`);
        return { status: 'skipped_drift' };
    }

    await publishProducts(access, baseRow, statAfter, selectedChunks, embeddings);
}

export async function recordBuildFailure(access: RetrievalHost, file: Item, error: unknown): Promise<BuildStepResult> {
    const failure = classifyEmbeddingError(error);
    const message = (error as any)?.message ?? '';
    if (failure.kind === 'config' || failure.kind === 'quota') {
        await setProbeError(access, 'embedding_config_error');
        await demoteToBaseOnly(access, `embedding queue: ${failure.code}`);
        logger.warn(`[filemgr] embed permanent API error for ${file.item_id}: ${message}`);
        return { kind: 'unavailable', reason: failure.code };
    }
    if (failure.kind === 'file') {
        await markFileFailed(access, file, -2);
        logger.warn(
            `[filemgr] embed permanent file error, disabling content embedding for ${file.item_id}: ${message}`
        );
        return { kind: 'failed', error, failure, consecutiveFailure: false };
    }
    await markFileFailed(access, file);
    return { kind: 'failed', error, failure, consecutiveFailure: true };
}
