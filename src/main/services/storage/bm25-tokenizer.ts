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

import { createRequire } from 'node:module';
import { ArkDataBridgeError } from '../../../platforms/bridges/common.js';
import { shouldUseWasm } from './platform.js';
import { assertBM25Integer } from './bm25-scoring.js';

const require = createRequire(import.meta.url);

export const BM25_SEGMENT_LENGTH = 1_048_576;
export interface BM25TokenStats {
    len: number;
    terms: Map<string, number>;
}
export interface BM25Tokenizer {
    readonly backend: 'native' | 'wasm' | 'harmonyos-intl';
    tokenize(text: string): BM25TokenStats | Promise<BM25TokenStats>;
    close?(): void | Promise<void>;
    stopAccepting?(): void | Promise<void>;
    assertAvailable?(): void | Promise<void>;
}
export interface BM25SyncTokenizer extends BM25Tokenizer {
    readonly backend: 'native' | 'wasm';
    tokenize(text: string): BM25TokenStats;
}
export interface BM25CutProvider {
    cut(text: string, hmm: boolean): unknown;
}
export function isBM25StorageText(value: string): boolean {
    // Unicode mode matches lone surrogates, while valid pairs remain whole code points.
    return !/[\u0000\uD800-\uDFFF]/u.test(value);
}

export function* segmentBM25Text(text: string): Generator<string> {
    if (typeof text !== 'string') throw new TypeError('BM25 text must be a string');
    for (let start = 0; start < text.length; ) {
        let end = Math.min(start + BM25_SEGMENT_LENGTH, text.length);
        if (end < text.length) {
            const lf = text.lastIndexOf('\n', end - 1);
            if (lf >= start) end = lf + 1;
            else if (
                text.charCodeAt(end - 1) >= 0xd800 &&
                text.charCodeAt(end - 1) <= 0xdbff &&
                text.charCodeAt(end) >= 0xdc00 &&
                text.charCodeAt(end) <= 0xdfff
            )
                end--;
        }
        yield text.slice(start, end);
        start = end;
    }
}
function addBM25Tokens(tokens: unknown, stats: BM25TokenStats): void {
    if (!Array.isArray(tokens)) throw new TypeError('Invalid BM25 tokenizer output');
    for (let i = 0; i < tokens.length; i++) {
        const token: unknown = tokens[i];
        if (typeof token !== 'string') throw new TypeError('Invalid BM25 tokenizer token');
        if (!/[\p{L}\p{N}]/u.test(token)) continue;
        if (!isBM25StorageText(token)) throw new TypeError('Invalid BM25 tokenizer term');
        assertBM25Integer(++stats.len, 1, 'token count');
        stats.terms.set(token, (stats.terms.get(token) ?? 0) + 1);
    }
}
export function makeBM25Tokenizer(provider: BM25CutProvider, backend: 'native' | 'wasm'): BM25SyncTokenizer {
    return {
        backend,
        tokenize(text) {
            const stats: BM25TokenStats = { len: 0, terms: new Map() };
            for (const segment of segmentBM25Text(text))
                addBM25Tokens(provider.cut(segment.normalize('NFKC').toLowerCase(), true), stats);
            return stats;
        }
    };
}

interface NativeJiebaModule {
    Jieba: { withDict(dict: unknown): BM25CutProvider };
}

// Internal dependency seams; binding options never select a backend.
export interface BM25TokenizerDependencies {
    platform?: string;
    forceWasm?: boolean;
    loadNative?: () => NativeJiebaModule | Promise<NativeJiebaModule>;
    loadDictionary?: () => unknown | Promise<unknown>;
    loadWasm?: () => BM25CutProvider | Promise<BM25CutProvider>;
}

export function isNativeJiebaUnavailable(error: unknown): boolean {
    const value = error as { code?: string; message?: string; cause?: unknown } | null;
    const message = value?.message ?? '';
    return (
        ((value?.code === 'MODULE_NOT_FOUND' || value?.code === 'ERR_DLOPEN_FAILED') &&
            /jieba|\.node/i.test(message)) ||
        /Cannot find native binding|Failed to load native binding|NODE_MODULE_VERSION/i.test(message)
    );
}

export async function createBM25Tokenizer(dependencies: BM25TokenizerDependencies = {}): Promise<BM25Tokenizer> {
    if ((dependencies.platform ?? process.platform) === 'openharmony') return createHarmonyIntlTokenizer();
    const wasm = async () => {
        const provider = await (dependencies.loadWasm ?? (() => require('jieba-wasm') as BM25CutProvider))();
        if (typeof provider?.cut !== 'function') throw new TypeError('Invalid WASM Jieba provider');
        return makeBM25Tokenizer(provider, 'wasm');
    };
    if (dependencies.forceWasm ?? shouldUseWasm()) return wasm();
    let module: NativeJiebaModule;
    try {
        module = await (dependencies.loadNative ?? (() => require('@node-rs/jieba') as NativeJiebaModule))();
    } catch (error) {
        if (isNativeJiebaUnavailable(error)) return wasm();
        throw error;
    }
    // Dictionary and provider construction failures are not missing-module fallback.
    const dictionary = await (
        dependencies.loadDictionary ?? (() => (require('@node-rs/jieba/dict') as { dict: unknown }).dict)
    )();
    const provider = module.Jieba.withDict(dictionary);
    if (typeof provider?.cut !== 'function') throw new TypeError('Invalid native Jieba provider');
    return makeBM25Tokenizer(provider, 'native');
}
function createHarmonyIntlTokenizer(): BM25Tokenizer {
    let segmenter: Intl.Segmenter;
    try {
        segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
    } catch (cause) {
        throw new ArkDataBridgeError(
            'bm25_tokenizer_unavailable',
            'required',
            'Intl tokenizer unavailable',
            {
                source: 'intl',
                reason: 'tokenizer_unavailable',
                availability: 'unsupported',
                outcome: 'not_executed'
            },
            cause
        );
    }
    return {
        backend: 'harmonyos-intl',
        tokenize(text) {
            if (typeof text !== 'string') throw new TypeError('BM25 text must be a string');
            const stats: BM25TokenStats = { len: 0, terms: new Map() };
            for (const word of segmenter.segment(text.normalize('NFKC').toLowerCase())) {
                if (word.isWordLike) addBM25Tokens([word.segment], stats);
            }
            return stats;
        }
    };
}
