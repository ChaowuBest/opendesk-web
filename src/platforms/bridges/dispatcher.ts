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

import type { NativeBridge, StartupKit, SpeechKit, DatabaseKit } from './common.js';

// Only NativeBridge capabilities are routed here; host GUI and business channels stay outside this dispatcher.
const nativeBridgeCalls = {
    getPlatform: (bridge: NativeBridge) => bridge.getPlatform(),
    getVariant: (bridge: NativeBridge) => bridge.getVariant(),
    'startupKit:getState': (bridge: NativeBridge) => bridge.getStartupKit().then((kit) => kit.getState()),
    'startupKit:delegateSetting': (bridge: NativeBridge, ...args: Parameters<StartupKit['delegateSetting']>) =>
        bridge.getStartupKit().then((kit) => kit.delegateSetting(args[0])),
    'speechKit:available': (bridge: NativeBridge) => bridge.getSpeechKit().then((kit) => kit.available()),
    'speechKit:initialize': (bridge: NativeBridge, ...args: Parameters<SpeechKit['initialize']>) =>
        bridge.getSpeechKit().then((kit) => kit.initialize(typeof args[0] === 'string' ? args[0] : null)),
    'speechKit:start': (bridge: NativeBridge) => bridge.getSpeechKit().then((kit) => kit.start()),
    'speechKit:peek': (bridge: NativeBridge) => bridge.getSpeechKit().then((kit) => kit.peek()),
    'speechKit:stop': (bridge: NativeBridge) => bridge.getSpeechKit().then((kit) => kit.stop()),
    'speechKit:release': (bridge: NativeBridge) => bridge.getSpeechKit().then((kit) => kit.release()),
    'databaseKit:available': (bridge: NativeBridge) => bridge.getDatabaseKit().then((kit) => kit.available()),
    'databaseKit:execSql': (bridge: NativeBridge, ...args: Parameters<DatabaseKit['execSql']>) =>
        bridge.getDatabaseKit().then((kit) => kit.execSql(args[0], args[1])),
    'databaseKit:execSqlParams': (bridge: NativeBridge, ...args: Parameters<DatabaseKit['execSqlParams']>) =>
        bridge.getDatabaseKit().then((kit) => kit.execSqlParams(args[0], args[1], args[2])),
    'databaseKit:querySqlShort': (bridge: NativeBridge, ...args: Parameters<DatabaseKit['querySqlShort']>) =>
        bridge.getDatabaseKit().then((kit) => kit.querySqlShort(args[0], args[1])),
    'databaseKit:deleteStore': (bridge: NativeBridge, ...args: Parameters<DatabaseKit['deleteStore']>) =>
        bridge.getDatabaseKit().then((kit) => kit.deleteStore(args[0], args[1])),
    'databaseKit:openStore': (bridge: NativeBridge, ...args: Parameters<DatabaseKit['openStore']>) =>
        bridge.getDatabaseKit().then((kit) => kit.openStore(args[0], args[1])),
    'databaseKit:closeStore': (bridge: NativeBridge, ...args: Parameters<DatabaseKit['closeStore']>) =>
        bridge.getDatabaseKit().then((kit) => kit.closeStore(args[0], args[1])),
    'databaseKit:executePrepared': (bridge: NativeBridge, ...args: Parameters<DatabaseKit['executePrepared']>) =>
        bridge.getDatabaseKit().then((kit) => kit.executePrepared(args[0], args[1], args[2], args[3])),
    'databaseKit:executePreparedMany': (
        bridge: NativeBridge,
        ...args: Parameters<DatabaseKit['executePreparedMany']>
    ) => bridge.getDatabaseKit().then((kit) => kit.executePreparedMany(args[0], args[1], args[2], args[3])),
    'databaseKit:executePreparedManyBatched': (
        bridge: NativeBridge,
        ...args: Parameters<DatabaseKit['executePreparedManyBatched']>
    ) => bridge.getDatabaseKit().then((kit) => kit.executePreparedManyBatched(args[0], args[1], args[2], args[3])),
    'databaseKit:queryPrepared': (bridge: NativeBridge, ...args: Parameters<DatabaseKit['queryPrepared']>) =>
        bridge.getDatabaseKit().then((kit) => kit.queryPrepared(args[0], args[1], args[2], args[3])),
    'databaseKit:beginTransaction': (bridge: NativeBridge, ...args: Parameters<DatabaseKit['beginTransaction']>) =>
        bridge.getDatabaseKit().then((kit) => kit.beginTransaction(args[0])),
    'databaseKit:commitTransaction': (bridge: NativeBridge, ...args: Parameters<DatabaseKit['commitTransaction']>) =>
        bridge.getDatabaseKit().then((kit) => kit.commitTransaction(args[0], args[1])),
    'databaseKit:rollbackTransaction': (
        bridge: NativeBridge,
        ...args: Parameters<DatabaseKit['rollbackTransaction']>
    ) => bridge.getDatabaseKit().then((kit) => kit.rollbackTransaction(args[0], args[1])),
    'quickCaptureKit:getState': (bridge: NativeBridge) => bridge.getQuickCaptureKit().then((kit) => kit.getState()),
    'quickCaptureKit:setEnabled': (bridge: NativeBridge, enabled: unknown) =>
        bridge.getQuickCaptureKit().then((kit) => kit.setEnabled(enabled === true)),
    'quickCaptureKit:takePendingCapture': (bridge: NativeBridge) =>
        bridge.getQuickCaptureKit().then((kit) => kit.takePendingCapture()),
    'accountKit:available': (bridge: NativeBridge) => bridge.getHuaweiAccountKit().then((kit) => kit.available()),
    'accountKit:startLogin': (bridge: NativeBridge) => bridge.getHuaweiAccountKit().then((kit) => kit.startLogin()),
    'accountKit:peekLogin': (bridge: NativeBridge) => bridge.getHuaweiAccountKit().then((kit) => kit.peekLogin()),
    'accountKit:closeLogin': (bridge: NativeBridge) => bridge.getHuaweiAccountKit().then((kit) => kit.closeLogin())
};

export type NativeBridgeMethod = keyof typeof nativeBridgeCalls;
export type NativeBridgeCallArguments<Method extends NativeBridgeMethod> =
    Parameters<(typeof nativeBridgeCalls)[Method]> extends [NativeBridge, ...infer Arguments] ? Arguments : never;
export const NATIVE_BRIDGE_METHODS: readonly NativeBridgeMethod[] = Object.freeze(
    Object.keys(nativeBridgeCalls) as NativeBridgeMethod[]
);

export type NativeBridgeCallResult = { status: 'ok'; data: unknown } | { status: 'error'; message: string };

/** Dispatch the shared native:call contract while leaving registration and error transport to the host. */
export async function dispatchNativeBridgeCall(
    bridge: NativeBridge,
    method: string,
    args: readonly unknown[] = []
): Promise<NativeBridgeCallResult> {
    if (!Object.hasOwn(nativeBridgeCalls, method)) {
        return { status: 'error', message: `Method not found: ${method}` };
    }
    const handler = nativeBridgeCalls[method as NativeBridgeMethod];
    const data: unknown = await Reflect.apply(handler, undefined, [bridge, ...args]);
    return { status: 'ok', data };
}
