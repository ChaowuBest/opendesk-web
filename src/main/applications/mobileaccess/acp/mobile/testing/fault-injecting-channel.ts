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

import { AcpConnectionClosedError, type AcpMessageChannel } from '../transport/acp-message-stream.js';
/** 按序号注入发送延迟、拒绝与断开的故障配置。 */
export interface ChannelFaultConfig {
    delaySendMs: number;
    rejectSendAtOrdinal?: number;
    disconnectAtOrdinal?: number;
}

export interface FaultInjectingChannelDiagnostic {
    type: 'send';
    ordinal: number;
    bytes: number;
    outcome: 'sent' | 'rejected' | 'disconnected';
}

export class FaultInjectingChannel implements AcpMessageChannel {
    private sendOrdinal = 0;

    constructor(
        private readonly inner: AcpMessageChannel,
        private readonly faults: ChannelFaultConfig,
        private readonly diagnose: (event: FaultInjectingChannelDiagnostic) => void
    ) {}

    async send(message: string): Promise<void> {
        const ordinal = ++this.sendOrdinal;
        const bytes = Buffer.byteLength(message, 'utf8');
        // Ordinal 1 is initialize; keeping it ungated lets diagnostics reach the
        // formal load path before exercising the 30s/35s snapshot deadlines.
        if (this.faults.delaySendMs > 0 && ordinal > 1) {
            await new Promise<void>((resolve) => setTimeout(resolve, this.faults.delaySendMs));
        }
        if (this.faults.disconnectAtOrdinal === ordinal) {
            this.diagnose({ type: 'send', ordinal, bytes, outcome: 'disconnected' });
            this.inner.close();
            throw new AcpConnectionClosedError('Injected transport disconnect');
        }
        if (this.faults.rejectSendAtOrdinal === ordinal) {
            this.diagnose({ type: 'send', ordinal, bytes, outcome: 'rejected' });
            throw new Error('Injected transport send rejection');
        }
        await this.inner.send(message);
        this.diagnose({ type: 'send', ordinal, bytes, outcome: 'sent' });
    }

    onMessage(listener: Parameters<AcpMessageChannel['onMessage']>[0]): () => void {
        return this.inner.onMessage(listener);
    }

    onClose(listener: Parameters<AcpMessageChannel['onClose']>[0]): () => void {
        return this.inner.onClose(listener);
    }

    close(): void {
        this.inner.close();
    }
}
