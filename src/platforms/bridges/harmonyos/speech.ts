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

import { SpeechKit, PeekResult } from '../common';
import { hasArkTSAdapter, EtsBridgeMethods, callArkTS } from './arkts';
import { logger } from '../../../main/utils/logger';

export class HarmonyOSSpeechKit implements SpeechKit {
    engineReady = false;
    recording = false;

    async available(): Promise<boolean> {
        return hasArkTSAdapter();
    }

    async initialize(): Promise<void> {
        if (this.engineReady) {
            return;
        }
        await callArkTS<void>(EtsBridgeMethods.SPEECH_INIT, 'void');
        await new Promise((r) => setTimeout(r, 1200));
        this.engineReady = true;
    }

    async start(): Promise<void> {
        await this.initialize();
        if (this.recording) {
            throw new Error('Speech recognition is already recording');
        }
        this.recording = true;

        logger.info('Starting speech recognition');
        await callArkTS<void>(EtsBridgeMethods.SPEECH_START, 'void');
    }

    async peek(): Promise<PeekResult> {
        if (!this.recording) {
            throw new Error('Speech recognition is not recording');
        }
        const text = await callArkTS<string>(EtsBridgeMethods.SPEECH_PEEK, 'string');
        const result = JSON.parse(text) as PeekResult;
        return result;
    }

    async stop(): Promise<string> {
        if (!this.recording) {
            throw new Error('Speech recognition is not recording');
        }
        try {
            await callArkTS<void>(EtsBridgeMethods.SPEECH_STOP, 'void');
            await new Promise((r) => setTimeout(r, 1200));
            const text = await callArkTS<string>(EtsBridgeMethods.SPEECH_PEEK, 'string');
            const finalResult = JSON.parse(text) as PeekResult;
            return finalResult.content;
        } finally {
            this.recording = false;
        }
    }

    async release(): Promise<void> {
        if (this.recording) {
            await this.stop();
        }
        if (this.engineReady) {
            await callArkTS<void>(EtsBridgeMethods.SPEECH_RELEASE, 'void');
            this.engineReady = false;
        }
    }
}
