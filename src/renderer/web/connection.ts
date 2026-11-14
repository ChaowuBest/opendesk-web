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
 * 浏览器侧 IPC 连接：一个页面一条 WebSocket。
 *
 * 断线后服务端已销毁该连接对应的 sender，页面上通过 IPC 建立的订阅全部失效，
 * 因此重连成功后直接整页刷新，而不是尝试恢复订阅状态。
 */

import { decodeIpcValue, encodeIpcValue } from '../../common/web/ipc-codec.js';
import { WEB_WS_PATH, type ClientMessage, type ServerMessage, type WebRequestKind } from '../../common/web/protocol.js';
import { showConnectionBanner } from './ui.js';

type EventHandler = (channel: string, args: unknown[]) => void;
type RequestHandler = (kind: WebRequestKind, payload: unknown) => Promise<unknown>;

interface Pending {
    channel: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
}

export class WebIpcConnection {
    private ws: WebSocket | null = null;
    private readonly queue: string[] = [];
    private readonly pending = new Map<number, Pending>();
    private nextId = 1;
    private everConnected = false;
    private retryDelay = 500;
    /** 上传中的文件：invoke 前等待它们落盘，保证 agent 按路径读取时文件已存在 */
    private readonly uploads = new Set<Promise<unknown>>();

    constructor(
        private readonly onEvent: EventHandler,
        private readonly onRequest: RequestHandler,
        private readonly onOpenUrl: (url: string) => void,
        private readonly onAlert: (title: string, message: string) => void
    ) {
        this.connect();
    }

    private connect(): void {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${protocol}//${location.host}${WEB_WS_PATH}?page=${encodeURIComponent(location.href)}`;
        const ws = new WebSocket(url);
        this.ws = ws;

        ws.onopen = () => {
            if (this.everConnected) {
                // 重连：服务端状态已丢失，整页重建
                location.reload();
                return;
            }
            this.everConnected = true;
            this.retryDelay = 500;
            showConnectionBanner(null);
            for (const data of this.queue.splice(0)) ws.send(data);
        };
        ws.onmessage = (event) => this.handleMessage(String(event.data));
        ws.onclose = () => {
            this.ws = null;
            for (const [id, pending] of this.pending) {
                pending.reject(new Error(`Error invoking remote method '${pending.channel}': connection lost`));
                this.pending.delete(id);
            }
            showConnectionBanner(this.everConnected ? 'reconnecting' : 'connecting');
            setTimeout(() => this.connect(), this.retryDelay);
            this.retryDelay = Math.min(this.retryDelay * 2, 10_000);
        };
    }

    private transmit(message: ClientMessage): void {
        const data = JSON.stringify(message);
        if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
        else this.queue.push(data);
    }

    private handleMessage(raw: string): void {
        let message: ServerMessage;
        try {
            message = JSON.parse(raw) as ServerMessage;
        } catch {
            return;
        }
        switch (message.t) {
            case 'res': {
                const pending = this.pending.get(message.id);
                if (!pending) return;
                this.pending.delete(message.id);
                if (message.ok) pending.resolve(decodeIpcValue(message.v));
                else pending.reject(new Error(`Error invoking remote method '${pending.channel}': ${message.e}`));
                return;
            }
            case 'evt':
                this.onEvent(message.ch, decodeIpcValue(message.a) as unknown[]);
                return;
            case 'req': {
                const { id } = message;
                this.onRequest(message.kind, decodeIpcValue(message.p))
                    .catch((error) => {
                        console.error('[web] request handler failed', error);
                        return undefined;
                    })
                    .then((value) => this.transmit({ t: 'reply', id, v: encodeIpcValue(value) }));
                return;
            }
            case 'open':
                this.onOpenUrl(message.url);
                return;
            case 'alert':
                this.onAlert(message.title, message.message);
                return;
        }
    }

    trackUpload(upload: Promise<unknown>): void {
        this.uploads.add(upload);
        void upload.finally(() => this.uploads.delete(upload));
    }

    async invoke(channel: string, args: unknown[]): Promise<unknown> {
        if (this.uploads.size > 0) await Promise.allSettled([...this.uploads]);
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { channel, resolve, reject });
            this.transmit({ t: 'invoke', id, ch: channel, a: encodeIpcValue(args) });
        });
    }

    send(channel: string, args: unknown[]): void {
        const message: ClientMessage = { t: 'send', ch: channel, a: encodeIpcValue(args) };
        if (this.uploads.size === 0) {
            this.transmit(message);
            return;
        }
        void Promise.allSettled([...this.uploads]).then(() => this.transmit(message));
    }
}
