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

export class ArkdataMetricUnsupported extends Error {
    constructor(metric: string) {
        super(`ArkData IndexDB does not support metric: ${metric}`);
        this.name = 'ArkdataMetricUnsupported';
    }
}

export function pickArkdataVectorOperator(metric: string): '<=>' | '<->' {
    switch (metric) {
        case 'cosine':
            return '<=>';
        case 'euclidean':
            return '<->';
        case 'manhattan':
        case 'dot_product':
            throw new ArkdataMetricUnsupported(metric);
        default:
            return '<=>';
    }
}

export function simFromArkdataDistance(distance: number, metric: string, source: string): number {
    if (!Number.isFinite(distance)) {
        throw new Error(
            `${source}: non-finite distance from adapter (got ${distance}); ` +
                `likely SDK ORDER-BY-alias bug or NULL in vector column`
        );
    }
    switch (metric) {
        case 'cosine':
            return Math.max(0, Math.min(1, 1 - distance / 2));
        case 'euclidean':
            return 1 / (1 + distance);
        case 'manhattan':
        case 'dot_product':
            throw new ArkdataMetricUnsupported(metric);
        default:
            return Math.max(0, Math.min(1, 1 - distance / 2));
    }
}

export function arkdataVectorValueDim(value: unknown, source: string): number | null {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) return value.length;
    if (ArrayBuffer.isView(value)) return vectorBytesToDim(value.byteLength, source);
    if (value instanceof ArrayBuffer) return vectorBytesToDim(value.byteLength, source);
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            if (Array.isArray(parsed)) return parsed.length;
        } catch {
            // Fall through to the fail-loud error below.
        }
    }
    throw new Error(`${source}: unsupported stored vector representation ${Object.prototype.toString.call(value)}`);
}

function vectorBytesToDim(byteLength: number, source: string): number {
    if (byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
        throw new Error(`${source}: stored vector byte length ${byteLength} is not aligned to Float32`);
    }
    return byteLength / Float32Array.BYTES_PER_ELEMENT;
}
