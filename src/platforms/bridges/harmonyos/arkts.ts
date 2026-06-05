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

import { systemPreferences } from 'electron';

// ============================================================
// OpenHarmony：经 ArkTS JsBinding（systemPreferences.callArkTSFunction）调用
// ============================================================

type ArkTSReturnType = 'void' | 'string' | 'number' | 'boolean' | 'string[]' | 'number[]';

/** ArkTS EtsBridge 绑定名（与 web_engine JsBinding 一致） */
export const EtsBridgeMethods = {
    PING: 'EtsBridge.OpenDeskPing',
    GET_SYSTEM_DARK_MODE: 'EtsBridge.OpenDeskGetSystemDarkMode',
    SPEECH_INIT: 'EtsBridge.OpenDeskSpeechInit',
    SPEECH_START: 'EtsBridge.OpenDeskSpeechStart',
    SPEECH_PEEK: 'EtsBridge.OpenDeskSpeechPeek',
    SPEECH_STOP: 'EtsBridge.OpenDeskSpeechStop',
    SPEECH_RELEASE: 'EtsBridge.OpenDeskSpeechRelease'
} as const;

function unwrapArkTSValue<T>(res: unknown): T {
    if (res !== null && typeof res === 'object' && 'value' in (res as object)) {
        return (res as { value: T }).value;
    }
    return res as T;
}

export function hasArkTSAdapter(): boolean {
    const prefs = systemPreferences as typeof systemPreferences & {
        callArkTSFunction?: (funcName: string, retType: string, args: unknown[]) => Promise<unknown>;
    };
    return typeof prefs.callArkTSFunction === 'function';
}

export async function callArkTS<T>(name: string, returnType: ArkTSReturnType, params: unknown[] = []): Promise<T> {
    const prefs = systemPreferences as typeof systemPreferences & {
        callArkTSFunction?: (funcName: string, retType: string, args: unknown[]) => Promise<unknown>;
    };
    if (typeof prefs.callArkTSFunction !== 'function') {
        throw new Error('systemPreferences.callArkTSFunction is not available');
    }
    return unwrapArkTSValue<T>(await prefs.callArkTSFunction(name, returnType, params));
}

/** Whether HarmonyOS system is currently in dark mode (EtsBridge business API). */
export async function getSystemDarkMode(): Promise<boolean> {
    return callArkTS<boolean>(EtsBridgeMethods.GET_SYSTEM_DARK_MODE, 'boolean');
}
