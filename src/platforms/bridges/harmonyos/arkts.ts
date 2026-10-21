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
    STARTUP_STATUS_START: 'EtsBridge.OpenDeskStartupStatusStart',
    STARTUP_SETTINGS_START: 'EtsBridge.OpenDeskStartupSettingsStart',
    STARTUP_RESULT_PEEK: 'EtsBridge.OpenDeskStartupResultPeek',
    GET_SYSTEM_DARK_MODE: 'EtsBridge.OpenDeskGetSystemDarkMode',
    GET_SYSTEM_LANGUAGE: 'EtsBridge.OpenDeskGetSystemLanguage',
    SPEECH_INIT: 'EtsBridge.OpenDeskSpeechInit',
    SPEECH_START: 'EtsBridge.OpenDeskSpeechStart',
    SPEECH_PEEK: 'EtsBridge.OpenDeskSpeechPeek',
    SPEECH_STOP: 'EtsBridge.OpenDeskSpeechStop',
    SPEECH_RELEASE: 'EtsBridge.OpenDeskSpeechRelease',
    LOGIN_INIT: 'EtsBridge.OpenDeskLoginInit',
    LOGIN_RESTORE: 'EtsBridge.OpenDeskLoginRestore',
    LOGIN_PEEK: 'EtsBridge.OpenDeskLoginPeek',
    LOGIN_CLOSE: 'EtsBridge.OpenDeskLoginClose',
    GET_SYSTEM_HTTP_PROXY_START: 'EtsBridge.OpenDeskGetSystemHttpProxyStart',
    GET_SYSTEM_HTTP_PROXY_PEEK: 'EtsBridge.OpenDeskGetSystemHttpProxyPeek',
    ARKDATA_PING: 'ArkData.Ping',
    ARKDATA_EXEC_SQL: 'ArkData.ExecSql',
    ARKDATA_EXEC_SQL_PARAMS: 'ArkData.ExecSqlParams',
    ARKDATA_QUERY_SQL_SHORT: 'ArkData.QuerySql',
    ARKDATA_OPEN_STORE_START: 'ArkData.OpenStoreStart',
    ARKDATA_OPEN_STORE_READY: 'ArkData.OpenStoreReady',
    ARKDATA_CLOSE_STORE_START: 'ArkData.CloseStoreStart',
    ARKDATA_CLOSE_STORE_READY: 'ArkData.CloseStoreReady',
    ARKDATA_CLOSE_STORE_FORCE_START: 'ArkData.CloseStoreForceStart',
    ARKDATA_CLOSE_STORE_FORCE_READY: 'ArkData.CloseStoreForceReady',
    ARKDATA_BEGIN_PREPARED: 'ArkData.BeginPrepared',
    ARKDATA_BIND_PARAMS: 'ArkData.BindParams',
    ARKDATA_BIND_PARAMS_MANY: 'ArkData.BindParamsMany',
    ARKDATA_EXECUTE_PREPARED_START: 'ArkData.ExecutePreparedStart',
    ARKDATA_EXECUTE_PREPARED_READY: 'ArkData.ExecutePreparedReady',
    ARKDATA_EXECUTE_PREPARED_MANY_START: 'ArkData.ExecutePreparedManyStart',
    ARKDATA_EXECUTE_PREPARED_MANY_READY: 'ArkData.ExecutePreparedManyReady',
    ARKDATA_CLOSE_PREPARED: 'ArkData.ClosePrepared',
    ARKDATA_BEGIN_TRANS_START: 'ArkData.BeginTransStart',
    ARKDATA_BEGIN_TRANS_READY: 'ArkData.BeginTransReady',
    ARKDATA_COMMIT_TRANS_START: 'ArkData.CommitTransStart',
    ARKDATA_COMMIT_TRANS_READY: 'ArkData.CommitTransReady',
    ARKDATA_ROLLBACK_TRANS_START: 'ArkData.RollbackTransStart',
    ARKDATA_ROLLBACK_TRANS_READY: 'ArkData.RollbackTransReady'
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

/** Get HarmonyOS system preferred language (EtsBridge business API). */
export async function getSystemLanguage(): Promise<string> {
    return callArkTS<string>(EtsBridgeMethods.GET_SYSTEM_LANGUAGE, 'string');
}
