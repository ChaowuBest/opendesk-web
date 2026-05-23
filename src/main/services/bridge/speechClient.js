/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 *
 * 渲染进程语音识别客户端
 */

import { RENDERER_BRIDGE_GLOBAL } from './constants.js';

/** @returns {boolean} */
export function isSpeechBridgeAvailable() {
    const bridge = globalThis[RENDERER_BRIDGE_GLOBAL];
    return (
        typeof bridge?.speechInit === 'function' &&
        typeof bridge?.speechStart === 'function' &&
        typeof bridge?.speechStop === 'function'
    );
}

/**
 * 单次语音识别会话（点击开始 / 再点结束）
 */
export class OpenDeskSpeechSession {
    constructor() {
        /** @type {boolean} */
        this.engineReady = false;
        /** @type {boolean} */
        this.recording = false;
    }

    get bridge() {
        return globalThis[RENDERER_BRIDGE_GLOBAL];
    }

    async ensureEngine() {
        if (this.engineReady) {
            return;
        }
        await this.bridge.speechInit();
        // ArkTS prepare：权限 + createEngine + setListener（异步）；略大于典型耗时
        await new Promise((r) => setTimeout(r, 1200));
        this.engineReady = true;
    }

    async start() {
        await this.ensureEngine();
        try {
            await this.bridge.speechStart();
        } catch (err) {
            this.recording = false;
            throw err;
        }
        this.recording = true;
    }

    /** @returns {Promise<string>} 当前识别中间结果（录音中） */
    async peek() {
        if (!this.engineReady || typeof this.bridge.speechPeek !== 'function') {
            return '';
        }
        const text = await this.bridge.speechPeek();
        return typeof text === 'string' ? text.trim() : '';
    }

    /**
     * @returns {Promise<string>}
     */
    async stop() {
        if (!this.recording) {
            return '';
        }
        try {
            await this.bridge.speechStop();
            // finish 后 onResult 可能晚于同步 stop 返回，多等一会再 peek
            await new Promise((r) => setTimeout(r, 1200));
            let text = '';
            if (typeof this.bridge.speechPeek === 'function') {
                text = await this.peek();
            }
            text = typeof text === 'string' ? text.trim() : '';
            return text;
        } finally {
            this.recording = false;
        }
    }

    async release() {
        if (this.recording) {
            try {
                await this.stop();
            } catch {
                /* ignore */
            }
        }
        if (this.engineReady && typeof this.bridge?.speechRelease === 'function') {
            await this.bridge.speechRelease();
        }
        this.engineReady = false;
    }
}
