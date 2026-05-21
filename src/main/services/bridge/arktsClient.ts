/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { systemPreferences } from 'electron';

export type ArkTSReturnType = 'void' | 'string' | 'number' | 'boolean' | 'string[]' | 'number[]';

export function isOpenHarmonyPlatform(): boolean {
    return process.platform === 'openharmony';
}

export function unwrapArkTSValue<T>(res: unknown): T {
    if (res !== null && typeof res === 'object' && 'value' in (res as object)) {
        return (res as { value: T }).value;
    }
    return res as T;
}

/** 调用 ArkTS JsBinding（systemPreferences.callArkTSFunction） */
export async function callArkTSFunction(
    name: string,
    returnType: ArkTSReturnType,
    params: unknown[] = []
): Promise<unknown> {
    const prefs = systemPreferences as typeof systemPreferences & {
        callArkTSFunction?: (
            funcName: string,
            retType: string,
            args: unknown[]
        ) => Promise<unknown>;
    };
    if (typeof prefs.callArkTSFunction !== 'function') {
        throw new Error('systemPreferences.callArkTSFunction is not available');
    }
    return prefs.callArkTSFunction(name, returnType, params);
}
