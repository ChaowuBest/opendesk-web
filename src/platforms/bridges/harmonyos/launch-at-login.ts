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

import type { LaunchAtLoginState, SystemStartupSettingsProvider } from '../../../common/launch-at-login.js';
import { callArkTS, EtsBridgeMethods, hasArkTSAdapter } from './arkts.js';

interface StartupResult {
    status: 'pending' | 'ok' | 'unsupported' | 'error';
    enabled?: boolean;
    code?: number;
}

async function runOperation(method: string): Promise<StartupResult> {
    if (!hasArkTSAdapter()) throw new Error('Harmony startup bridge is unavailable');
    const requestId = await callArkTS<number>(method, 'number');
    if (!Number.isSafeInteger(requestId) || requestId < 1) throw new Error('Invalid Harmony startup request');
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const raw = await callArkTS<string>(EtsBridgeMethods.STARTUP_RESULT_PEEK, 'string', [requestId]);
        const result = JSON.parse(raw) as StartupResult | null;
        if (result?.status === 'ok' || result?.status === 'unsupported') return result;
        if (result?.status !== 'pending')
            throw new Error(`Harmony startup request failed: ${result?.code ?? 'invalid response'}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Harmony startup request timed out');
}

export function createHarmonyLaunchAtLoginProvider(): SystemStartupSettingsProvider {
    return {
        async getState(): Promise<LaunchAtLoginState> {
            const unavailable: LaunchAtLoginState = {
                supported: false,
                enabled: false,
                reason: 'unsupported',
                mode: 'system-settings'
            };
            if (!hasArkTSAdapter()) return unavailable;
            const result = await runOperation(EtsBridgeMethods.STARTUP_STATUS_START);
            if (result.status === 'unsupported') return unavailable;
            if (typeof result.enabled !== 'boolean') throw new Error('Invalid Harmony startup status');
            return { supported: true, enabled: result.enabled, mode: 'system-settings' };
        },
        async openSettings(): Promise<void> {
            const result = await runOperation(EtsBridgeMethods.STARTUP_SETTINGS_START);
            if (result.status !== 'ok') throw new Error('Harmony startup settings are unavailable');
        }
    };
}
