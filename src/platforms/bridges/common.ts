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

export interface PeekResult {
    content: string;
    finished: boolean;
}

export interface SpeechKit {
    available(): Promise<boolean>;
    initialize(): Promise<void>;
    start(): Promise<void>;
    peek(): Promise<PeekResult>;
    stop(): Promise<string>;
    release(): Promise<void>;
}

export interface OcrKit {
    available(): Promise<boolean>;
}

/**
 * 原生平台功能桥接的接口定义。这个桥接设计用于封装不同操作系统和硬件平台的差异。
 */
export interface NativeBridge {
    /**
     * 当前原生平台的系统平台标识，该表示应该始终与 Node.js 的 process.platform 保持一致，以便于平台特定的逻辑分支处理
     */
    getPlatform(): Promise<string>;

    /**
     * 当前原生平台的变体标识，用于区分同一系统平台下的不同设备类型或系统版本。
     * 例如鸿蒙PC等官方系统支持原生的语音识别等端侧模型能力，但第三方的OpenHarmony开发板则未必
     * 支持，我们通过 variant 来区分不同的设备类型或系统版本。
     */
    getVariant(): Promise<string>;

    getSpeechKit(): Promise<SpeechKit>;
    getOcrKit(): Promise<OcrKit>;
}

export class NaiveSpeechKit implements SpeechKit {
    async available(): Promise<boolean> {
        return false;
    }

    async initialize(): Promise<void> {
        throw new Error('NaiveSpeechKit does not support initialize');
    }

    async start(): Promise<void> {
        throw new Error('NaiveSpeechKit does not support start');
    }

    async peek(): Promise<PeekResult> {
        throw new Error('NaiveSpeechKit does not support peek');
    }

    async stop(): Promise<string> {
        throw new Error('NaiveSpeechKit does not support stop');
    }

    async release(): Promise<void> {
        throw new Error('NaiveSpeechKit does not support release');
    }
}

export class NaiveOcrKit implements OcrKit {
    async available(): Promise<boolean> {
        return false;
    }
}

export class NaiveNativeBridge implements NativeBridge {
    _speechKit: SpeechKit = new NaiveSpeechKit();
    _ocrKit: OcrKit = new NaiveOcrKit();

    async getPlatform(): Promise<string> {
        return process.platform;
    }

    async getVariant(): Promise<string> {
        return 'naive';
    }

    async getSpeechKit(): Promise<SpeechKit> {
        return this._speechKit;
    }

    async getOcrKit(): Promise<OcrKit> {
        return this._ocrKit;
    }
}
