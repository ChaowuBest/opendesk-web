/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 *
 * 原生桥主进程侧：按系统平台解析出 NativeBridge 实现，并注册到渲染进程的 IPC。
 *
 * 架构：
 *   渲染进程(speech.js) --window.opendeskNative--> preload(expose.ts)
 *     --ipc opendesk:*--> 主进程(本文件) --> 当前平台 NativeBridge 实现 --> 系统原生能力
 *
 * 接入新平台：实现一个 NativeBridge 并在 resolveNativeBridge() 中按 process.platform 返回。
 * 本文件依赖 electron 主进程 API（ipcMain / systemPreferences），仅可在主进程导入；
 * 渲染进程请用 ./speech.js，preload 请用 ./expose.js。
 */

import { ipcMain, systemPreferences } from 'electron';
import { logger } from '../../main/utils/logger.js';
import { IpcChannels, type NativeBridge, type NativeSpeechProvider } from './constants.js';

const LOG_TAG = '[platforms/native]';

// ============================================================
// OpenHarmony：经 ArkTS JsBinding（systemPreferences.callArkTSFunction）调用
// ============================================================

type ArkTSReturnType = 'void' | 'string' | 'number' | 'boolean' | 'string[]' | 'number[]';

/** ArkTS EtsBridge 绑定名（与 web_engine JsBinding 一致） */
const EtsBridgeMethods = {
    PING: 'EtsBridge.OpenDeskPing',
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

async function callArkTS<T>(name: string, returnType: ArkTSReturnType, params: unknown[] = []): Promise<T> {
    const prefs = systemPreferences as typeof systemPreferences & {
        callArkTSFunction?: (funcName: string, retType: string, args: unknown[]) => Promise<unknown>;
    };
    if (typeof prefs.callArkTSFunction !== 'function') {
        throw new Error('systemPreferences.callArkTSFunction is not available');
    }
    return unwrapArkTSValue<T>(await prefs.callArkTSFunction(name, returnType, params));
}

const openHarmonySpeech: NativeSpeechProvider = {
    init: () => callArkTS<void>(EtsBridgeMethods.SPEECH_INIT, 'void'),
    start: () => callArkTS<void>(EtsBridgeMethods.SPEECH_START, 'void'),
    peek: () => callArkTS<string>(EtsBridgeMethods.SPEECH_PEEK, 'string'),
    stop: () => callArkTS<string>(EtsBridgeMethods.SPEECH_STOP, 'string'),
    release: () => callArkTS<void>(EtsBridgeMethods.SPEECH_RELEASE, 'void')
};

const openHarmonyBridge: NativeBridge = {
    platform: 'openharmony',
    ping: (message: string) => callArkTS<string>(EtsBridgeMethods.PING, 'string', [message ?? '']),
    speech: openHarmonySpeech
};

// ============================================================
// 其他系统平台预留（Windows / macOS / Linux ...）
// 实现各自的 NativeBridge 后，在 resolveNativeBridge() 中按 process.platform 返回即可。
// 示例：
//   const windowsBridge: NativeBridge = {
//       platform: 'win32',
//       ping: async (message) => message,
//       speech: null // 或基于系统 API 的实现
//   };
// ============================================================

// ============================================================
// 当前平台原生桥解析（单例）
// ============================================================

let cachedBridge: NativeBridge | null | undefined;

/** 解析当前系统平台的原生桥实现；不支持的平台返回 null。 */
export function resolveNativeBridge(): NativeBridge | null {
    if (cachedBridge !== undefined) {
        return cachedBridge;
    }
    switch (process.platform) {
        case 'openharmony':
            cachedBridge = openHarmonyBridge;
            break;
        // case 'win32': cachedBridge = windowsBridge; break;
        // case 'darwin': cachedBridge = macBridge; break;
        // case 'linux': cachedBridge = linuxBridge; break;
        default:
            cachedBridge = null;
    }
    return cachedBridge;
}

// ============================================================
// 主进程：注册原生桥 IPC（仅当前平台支持原生桥时生效）
// ============================================================

export function registerNativeBridge(): void {
    const bridge = resolveNativeBridge();
    if (!bridge) {
        return;
    }

    const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {
        [IpcChannels.PING]: async (message?: unknown) => bridge.ping(typeof message === 'string' ? message : '')
    };

    if (bridge.speech) {
        const speech = bridge.speech;
        handlers[IpcChannels.SPEECH_INIT] = () => speech.init();
        handlers[IpcChannels.SPEECH_START] = () => speech.start();
        handlers[IpcChannels.SPEECH_PEEK] = () => speech.peek();
        handlers[IpcChannels.SPEECH_STOP] = () => speech.stop();
        handlers[IpcChannels.SPEECH_RELEASE] = () => speech.release();
    }

    for (const [channel, handler] of Object.entries(handlers)) {
        ipcMain.handle(channel, async (_event, ...args) => {
            try {
                return await handler(...args);
            } catch (err) {
                logger.error(`${LOG_TAG} ${channel} failed: ${err}`);
                throw err;
            }
        });
    }

    logger.info(
        `${LOG_TAG} native bridge registered for platform '${bridge.platform}': ${Object.keys(handlers).join(', ')}`
    );
}
