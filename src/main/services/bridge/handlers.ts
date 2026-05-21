/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { EtsBridgeMethods, IpcChannels } from './constants.js';
import { callArkTSFunction, unwrapArkTSValue } from './arktsClient.js';

export type NativeBridgeHandler = (...args: unknown[]) => Promise<unknown>;

/** IPC 通道 → ArkTS 调用的业务实现 */
export function createNativeBridgeHandlers(): Record<string, NativeBridgeHandler> {
    return {
        [IpcChannels.PING]: async (_event, message?: string) =>
            unwrapArkTSValue<string>(
                await callArkTSFunction(EtsBridgeMethods.PING, 'string', [message ?? ''])
            ),

        [IpcChannels.SPEECH_INIT]: async () => {
            await callArkTSFunction(EtsBridgeMethods.SPEECH_INIT, 'void', []);
        },

        [IpcChannels.SPEECH_START]: async () => {
            await callArkTSFunction(EtsBridgeMethods.SPEECH_START, 'void', []);
        },

        [IpcChannels.SPEECH_STOP]: async () =>
            unwrapArkTSValue<string>(await callArkTSFunction(EtsBridgeMethods.SPEECH_STOP, 'string', [])),

        [IpcChannels.SPEECH_RELEASE]: async () => {
            await callArkTSFunction(EtsBridgeMethods.SPEECH_RELEASE, 'void', []);
        }
    };
}
