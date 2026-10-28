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

import fs from 'fs';

import { type QuickCaptureKit, type QuickCapturePendingCapture, type QuickCaptureState } from '../common.js';
import { EtsBridgeMethods, callArkTS } from './arkts.js';

/** 与 ohos_hap/docs/quickcapture-adapter-reference.md 中的 envelope 契约保持一致。 */
interface QuickCaptureEnvelope {
    ok: boolean;
    enabled: boolean;
    error: { code: string; message: string } | null;
}

interface QuickCapturePendingEnvelope {
    ok: boolean;
    error: { code: string; message: string } | null;
    path: string | null;
}

export class HarmonyOSQuickCaptureKit implements QuickCaptureKit {
    async getState(): Promise<QuickCaptureState> {
        const envelope = await this.invoke(EtsBridgeMethods.QUICKCAPTURE_IS_ENABLED, []);
        return { supported: true, enabled: envelope.enabled };
    }

    async setEnabled(enabled: boolean): Promise<QuickCaptureState> {
        const envelope = await this.invoke(EtsBridgeMethods.QUICKCAPTURE_SET_ENABLED, [enabled ? 'true' : 'false']);
        return { supported: true, enabled: envelope.enabled };
    }

    async takePendingCapture(): Promise<QuickCapturePendingCapture | null> {
        const raw = await callArkTS<string>(EtsBridgeMethods.QUICKCAPTURE_TAKE_PENDING, 'string', []);
        const envelope = JSON.parse(raw) as QuickCapturePendingEnvelope;
        if (envelope === null || typeof envelope !== 'object' || typeof envelope.ok !== 'boolean') {
            throw new Error('Malformed QuickCapture pending envelope');
        }
        if (!envelope.ok) {
            throw new Error(`QuickCapture takePending failed: ${envelope.error?.code ?? 'unknown_error'}`);
        }
        if (!envelope.path) {
            return null;
        }
        let data: Buffer;
        try {
            data = fs.readFileSync(envelope.path);
        } catch (err) {
            // Take 语义：ArkTS 侧已在本调用中原子清空队列槽位，读文件失败（文件被清理/竞态/损坏）
            // 即截图永久丢失，只能降级为 null（前端输入框保持无附件），且此处不做重试，
            // 避免一条坏文件阻塞后续所有窗口激活信号。
            console.error(`[QuickCapture] failed to read pending capture ${envelope.path}:`, err);
            return null;
        }
        try {
            fs.rmSync(envelope.path, { force: true });
        } catch {
            // 读取已成功，清理失败（如文件被占用）只残留一个临时文件（ArkTS 侧槽位已清空，
            // 不会被再次取出），不应因此丢弃已读到的截图。
        }
        return { dataUrl: `data:image/jpeg;base64,${data.toString('base64')}` };
    }

    private async invoke(method: string, args: string[]): Promise<QuickCaptureEnvelope> {
        const raw = await callArkTS<string>(method, 'string', args);
        const envelope = JSON.parse(raw) as QuickCaptureEnvelope;
        if (envelope === null || typeof envelope !== 'object' || typeof envelope.enabled !== 'boolean') {
            throw new Error(`Malformed QuickCapture envelope from ${method}`);
        }
        if (!envelope.ok) {
            throw new Error(`QuickCapture bridge call failed: ${envelope.error?.code ?? 'unknown_error'}`);
        }
        return envelope;
    }
}
