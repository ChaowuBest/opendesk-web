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

import type { StartupKit, StartupState } from '../common.js';
import { callArkTS, EtsBridgeMethods, hasArkTSAdapter } from './arkts.js';

interface StartupResult {
    status: 'pending' | 'ok' | 'unsupported' | 'error';
    enabled?: boolean;
    code?: number;
}

const RESULT_POLL_DELAYS_MS = [50, 100, 200, 500] as const;

async function runOperation(method: string): Promise<StartupResult> {
    if (!hasArkTSAdapter()) throw new Error('Harmony startup bridge is unavailable');
    const requestId = await callArkTS<number>(method, 'number');
    if (!Number.isSafeInteger(requestId) || requestId < 1) throw new Error('Invalid Harmony startup request');
    const deadline = Date.now() + 5_000;
    let delayIndex = 0;
    // The shell starts the OS operation once; peek only retrieves that request's pending/completed result.
    while (Date.now() < deadline) {
        const raw = await callArkTS<string>(EtsBridgeMethods.STARTUP_RESULT_PEEK, 'string', [requestId]);
        const result = JSON.parse(raw) as StartupResult | null;
        if (result?.status === 'ok' || result?.status === 'unsupported') return result;
        if (result?.status !== 'pending')
            throw new Error(`Harmony startup request failed: ${result?.code ?? 'invalid response'}`);
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const delay = Math.min(RESULT_POLL_DELAYS_MS[delayIndex], remaining);
        delayIndex = Math.min(delayIndex + 1, RESULT_POLL_DELAYS_MS.length - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
    }
    throw new Error('Harmony startup request timed out');
}

export class HarmonyOSStartupKit implements StartupKit {
    async getState(): Promise<StartupState> {
        const unavailable: StartupState = {
            supported: false,
            enabled: null,
            reason: 'unsupported',
            mode: 'system-settings'
        };
        if (!hasArkTSAdapter()) return unavailable;
        const result = await runOperation(EtsBridgeMethods.STARTUP_STATUS_START);
        if (result.status === 'unsupported') return unavailable;
        if (typeof result.enabled !== 'boolean') throw new Error('Invalid Harmony startup status');
        return { supported: true, enabled: result.enabled, mode: 'system-settings' };
    }
    async delegateSetting(enabled?: boolean): Promise<void> {
        if (enabled !== undefined) throw new TypeError('Startup is managed in system settings');
        const result = await runOperation(EtsBridgeMethods.STARTUP_SETTINGS_START);
        if (result.status !== 'ok') throw new Error('Harmony startup settings are unavailable');
    }
}
