/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { NativeBridge, SpeechKit, NaiveOcrKit } from '../common.js';
import { DarwinSpeechKit } from './speech.js';

class DarwinNativeBridge implements NativeBridge {
    _speechKit = new DarwinSpeechKit();
    _ocrKit = new NaiveOcrKit();

    async getPlatform(): Promise<string> {
        return 'darwin';
    }

    async getVariant(): Promise<string> {
        return process.arch;
    }

    async getSpeechKit(): Promise<SpeechKit> {
        return this._speechKit;
    }

    async getOcrKit() {
        return this._ocrKit;
    }
}

export function getNativeBridge(): NativeBridge | null {
    if (process.platform === 'darwin') {
        return new DarwinNativeBridge();
    }
    return null;
}
