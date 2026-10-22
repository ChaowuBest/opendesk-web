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

import {
    NativeBridge,
    SpeechKit,
    NaiveNativeBridge,
    guardStartupKit,
    NaiveOcrKit,
    NaiveHuaweiAccountKit
} from '../common.js';
import type { HuaweiAccountKit } from '../common.js';
import { DarwinSpeechKit } from './speech.js';
import { DarwinStartupKit } from './startup.js';
import { app } from 'electron';

class DarwinNativeBridge extends NaiveNativeBridge {
    constructor() {
        super(guardStartupKit(new DarwinStartupKit(app), 'toggle'));
    }

    _speechKit = new DarwinSpeechKit();
    _ocrKit = new NaiveOcrKit();
    _huaweiAccountKit = new NaiveHuaweiAccountKit();

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

    async getHuaweiAccountKit(): Promise<HuaweiAccountKit> {
        return this._huaweiAccountKit;
    }
}

export function getNativeBridge(): NativeBridge | null {
    if (process.platform === 'darwin') {
        return new DarwinNativeBridge();
    }
    return null;
}
