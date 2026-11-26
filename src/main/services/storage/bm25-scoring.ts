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

export interface BM25RecordHit {
    item_id: string;
    field: string;
    subKey: string;
    score: number;
}

export function compareBM25Text(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

export function bm25Contribution(
    n: number,
    df: number,
    sumLen: number,
    len: number,
    tf: number,
    k1 = 1.2,
    b = 0.75
): number {
    for (const [name, value, min] of [
        ['n', n, 1],
        ['df', df, 0],
        ['sumLen', sumLen, 1],
        ['len', len, 1],
        ['tf', tf, 1]
    ] as const) {
        assertBM25Integer(value, min, name);
    }
    if (df > n || sumLen < n || len > sumLen || tf > len) throw new Error('Invalid BM25 statistics');
    if (!Number.isFinite(k1) || k1 < 0 || !Number.isFinite(b) || b < 0 || b > 1) {
        throw new Error('Invalid BM25 scoring parameters');
    }
    if (df === 0) return 0;
    const idf = Math.log1p((n - df + 0.5) / (df + 0.5));
    const normalization = 1 - b + (b * len) / (sumLen / n);
    // Divide before multiplying to keep every finite k1 usable, including MAX_VALUE.
    const saturation =
        k1 > 1 ? (1 + 1 / k1) / (1 / k1 + normalization / tf) : (k1 + 1) / (1 + (k1 * normalization) / tf);
    const result = idf * saturation;
    if (!Number.isFinite(result)) throw new Error('Invalid BM25 score');
    return result;
}

export function rankBM25Hits(hits: BM25RecordHit[], topK: number): BM25RecordHit[] {
    assertBM25Integer(topK, 1, 'topK');
    for (const hit of hits) {
        if (!Number.isFinite(hit.score) || hit.score < 0) throw new Error('Invalid BM25 score');
    }
    return hits
        .sort(
            (a, b) => b.score - a.score || compareBM25Text(a.item_id, b.item_id) || compareBM25Text(a.subKey, b.subKey)
        )
        .slice(0, topK);
}

export function assertBM25Integer(value: unknown, min: number, name: string): asserts value is number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
        throw new Error(`Invalid BM25 ${name}: expected a safe integer >= ${min}`);
    }
}
