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
 * 750 MB is a conservative circuit breaker for snapshots that are obviously
 * too large to JSON.parse safely, independent of the COUNT-based cap check.
 */
export const HNSW_SNAPSHOT_SIZE_CIRCUIT_BREAKER_BYTES = 750 * 1024 * 1024;
export const HNSW_SAFETY_MARGIN = 0.65;
export const HNSW_SAFE_TOTAL_BUDGET = 27_000_000 * HNSW_SAFETY_MARGIN;

export interface LoadSnapshotGuardInput {
    activeCount: number;
    pointCap: number;
    dirty: boolean;
    snapshotSizeBytes: number;
}

export function shouldSkipLoadSnapshot(input: LoadSnapshotGuardInput): boolean {
    if (input.dirty) return true;
    if (input.activeCount > input.pointCap) return true;
    if (input.snapshotSizeBytes > HNSW_SNAPSHOT_SIZE_CIRCUIT_BREAKER_BYTES) return true;
    return false;
}
