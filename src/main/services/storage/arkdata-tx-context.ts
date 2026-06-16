/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

type ArkDataTxContext = Map<string, string>;

const arkDataTxAls = new AsyncLocalStorage<ArkDataTxContext>();

export function getArkDataTxId(storeId: string): string | null {
    return arkDataTxAls.getStore()?.get(storeId) ?? null;
}

export function hasArkDataTx(storeId: string): boolean {
    return getArkDataTxId(storeId) !== null;
}

export async function runWithArkDataTx<T>(storeId: string, txId: string, fn: () => Promise<T>): Promise<T> {
    const parent = arkDataTxAls.getStore();
    const next = new Map(parent ?? []);
    next.set(storeId, txId);
    return await arkDataTxAls.run(next, fn);
}
