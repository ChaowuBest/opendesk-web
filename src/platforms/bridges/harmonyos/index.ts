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

/**
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

import { NativeBridge, SpeechKit, NaiveOcrKit } from '../common.js';
import { hasArkTSAdapter } from './arkts.js';
import { HarmonyOSSpeechKit } from './speech.js';

class HarmonyOSNativeBridge implements NativeBridge {
    _speechKit = new HarmonyOSSpeechKit();
    _ocrKit = new NaiveOcrKit();

    async getPlatform(): Promise<string> {
        return 'openharmony';
    }

    async getVariant(): Promise<string> {
        return 'default';
    }

    async getSpeechKit(): Promise<SpeechKit> {
        return this._speechKit;
    }

    async getOcrKit() {
        return this._ocrKit;
    }
}

export function getNativeBridge(): NativeBridge | null {
    if (hasArkTSAdapter()) {
        return new HarmonyOSNativeBridge();
    }
    return null;
}
