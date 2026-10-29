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

/** Harmony native capabilities are registered by the shared bridges/main entrypoint. */

import { NativeBridge, SpeechKit, NaiveNativeBridge, guardStartupKit, NaiveOcrKit } from '../common.js';
import type { DatabaseKit, HuaweiAccountKit, QuickCaptureKit } from '../common.js';
import { hasArkTSAdapter } from './arkts.js';
import { HarmonyOSDatabaseKit } from './database.js';
import { HarmonyOSSpeechKit } from './speech.js';
import { HarmonyOSHuaweiAccountKit } from './account.js';
import { HarmonyOSStartupKit } from './startup.js';
import { HarmonyOSQuickCaptureKit } from './quickcapture.js';

class HarmonyOSNativeBridge extends NaiveNativeBridge {
    constructor() {
        super(guardStartupKit(new HarmonyOSStartupKit(), 'system-settings'));
    }

    _speechKit = new HarmonyOSSpeechKit();
    _ocrKit = new NaiveOcrKit();
    _databaseKit = new HarmonyOSDatabaseKit();
    _huaweiAccountKit = new HarmonyOSHuaweiAccountKit();
    _quickCaptureKit = new HarmonyOSQuickCaptureKit();

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

    async getDatabaseKit(): Promise<DatabaseKit> {
        return this._databaseKit;
    }

    async getHuaweiAccountKit(): Promise<HuaweiAccountKit> {
        return this._huaweiAccountKit;
    }

    async getQuickCaptureKit(): Promise<QuickCaptureKit> {
        return this._quickCaptureKit;
    }
}

export function getNativeBridge(): NativeBridge | null {
    if (hasArkTSAdapter()) {
        return new HarmonyOSNativeBridge();
    }
    return null;
}
