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

import { hasArkTSAdapter, EtsBridgeMethods, callArkTS } from './arkts.js';

export interface HarmonyOSSystemProxy {
    host: string;
    port: number;
    exclusionList: string[];
    pacUrl?: string;
}

const PROXY_CACHE_TTL_MS = 30_000;
const POLL_INITIAL_MS = 50;
const POLL_MAX_MS = 500;
const POLL_TIMEOUT_MS = 5_000;

let cachedProxy: HarmonyOSSystemProxy | null | undefined = undefined;
let cachedAt = 0;

/**
 * 通过 ArkTS 桥接获取鸿蒙系统 HTTP 代理配置。
 * 鸿蒙 Chromium 不读取 OS 代理，需通过 connection.getDefaultHttpProxy() 获取。
 *
 * 由于 AKI 的 JSFunction::Invoke<string> 要求同步返回，而
 * getDefaultHttpProxy() 是 Promise 异步方法，ArkTS 侧采用 start/peek 轮询模式：
 *   1. start: 异步触发 getDefaultHttpProxy()，立即返回
 *   2. peek:  轮询读取结果，pending 时返回 '{"pending":true}'
 *
 * 结果带 30s TTL 缓存，避免每次请求都走 ArkTS 桥接。
 *
 * @returns 系统代理配置，无代理或桥接不可用时返回 null
 */
export async function getHarmonyOSSystemProxy(): Promise<HarmonyOSSystemProxy | null> {
    if (!hasArkTSAdapter()) {
        return null;
    }

    const now = Date.now();
    if (cachedProxy !== undefined && now - cachedAt < PROXY_CACHE_TTL_MS) {
        return cachedProxy;
    }

    try {
        await callArkTS<void>(EtsBridgeMethods.GET_SYSTEM_HTTP_PROXY_START, 'void');
        const raw = await pollProxyPeek();
        const parsed = JSON.parse(raw) as HarmonyOSSystemProxy;
        cachedProxy = parsed.host && parsed.port > 0 ? parsed : null;
        cachedAt = now;
    } catch {
        cachedProxy = null;
        cachedAt = now;
    }

    return cachedProxy;
}

async function pollProxyPeek(): Promise<string> {
    let delay = POLL_INITIAL_MS;
    const startedAt = Date.now();
    for (;;) {
        const raw = await callArkTS<string>(EtsBridgeMethods.GET_SYSTEM_HTTP_PROXY_PEEK, 'string');
        let parsed: { pending?: boolean } & Partial<HarmonyOSSystemProxy>;
        try {
            parsed = JSON.parse(raw);
        } catch {
            parsed = {};
        }
        if (!parsed.pending) {
            return raw;
        }
        if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
            throw new Error(`ArkTS proxy peek timed out after ${POLL_TIMEOUT_MS}ms`);
        }
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, POLL_MAX_MS);
    }
}

/** 清除缓存的系统代理配置，下次调用将重新走 ArkTS 桥接获取。 */
export function invalidateHarmonyOSSystemProxyCache(): void {
    cachedProxy = undefined;
    cachedAt = 0;
}
