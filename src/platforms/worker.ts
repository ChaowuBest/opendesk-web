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
 * 工作线程专用的 Platform 实现。
 *
 * fetch 请求通过 IPC (parentPort.postMessage) 转发到主进程执行，
 * 主进程使用 Electron 的 Chromium 网络栈处理请求并逐 chunk 回传 body，
 * 支持流式响应（SSE 等长连接）。
 */

import { AbstractPlatform, type PlatformFetchOptions, type PlatformNetworkConfig } from './base.js';
import { Setting } from '../main/utils/setting.js';
import type { TaskState } from '../main/aikernel/states/tasks.js';
import { parentPort, workerData } from 'worker_threads';
import { BaseApplication } from '../main/applications/base';
import { MailboxApplication } from '../main/applications/mailbox/app.js';
import { FileMgrApplication } from '../main/applications/filemgr/app.js';
import { CalendarApplication } from '../main/applications/calendar/app.js';
import { BrowserApplication } from '../main/applications/browser/app.js';
import { SearchApplication } from '../main/applications/search/app.js';
import { TerminalApplication } from '../main/applications/terminal/app.js';
import { SkillMgrApplication } from '../main/applications/skillmgr/app.js';
import { McpMgrApplication } from '../main/applications/mcpmgr/app.js';
import { TodoMgrApplication } from '../main/applications/todomgr/app.js';
import { ChannelMgrApplication } from '../main/applications/channelmgr/app.js';
import { KnowledgeBaseApplication } from '../main/applications/knowledgebase/app.js';
import { DeviceMgrApplication } from '../main/applications/devicemgr/app.js';
import { BuiltinApplication } from '../main/applications/builtin/app.js';
import { NotesApplication } from '../main/applications/notes/app.js';
import { AppMgrApplication } from '../main/applications/appmgr/app.js';
import { AgentGateApplication } from '../main/applications/agentgate/app.js';
import { AdminConsoleApplication } from '../main/applications/adminconsole/app.js';
import { AgentOfficeApplication } from '../main/applications/agentoffice/app.js';
import { AcpMgrApplication } from '../main/applications/acpmgr/app.js';
import { initAgentGateHook } from '../main/applications/agentgate/hook.js';
import { WorkflowMgrApplication } from '../main/applications/workflowMgr/app.js';
import { PluginMgrApplication } from '../main/applications/pluginmgr/app.js';

// Ensure hook is registered in the worker chunk (same bundle as tool execution)
initAgentGateHook();

let shellRequestCounter = 0;

type WorkerNetworkConfig = PlatformNetworkConfig;

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
    if (!headers) return {};
    if (headers instanceof Headers) {
        return Object.fromEntries(headers.entries());
    }
    if (Array.isArray(headers)) {
        return Object.fromEntries(headers);
    }
    return { ...headers };
}

export class WorkerPlatform extends AbstractPlatform {
    private networkConfig: WorkerNetworkConfig;
    private _onNetworkConfigMessage: ((msg: any) => void) | null = null;
    private _onFetchMessage: ((msg: any) => void) | null = null;
    private _fetchStreamHandlers: Map<string, (msg: any) => void> = new Map();
    private _fetchRequestCounter = 0;

    constructor() {
        super();
        const setting = (workerData as any)?.setting;
        const nc = setting?.network_config;
        this.networkConfig = {
            no_ssl: nc?.no_ssl ?? false,
            use_proxy: nc?.use_proxy ?? 'system',
            custom_proxy_addr: nc?.custom_proxy_addr ?? '',
            no_proxy: nc?.no_proxy ?? ''
        };
        // 将 no_proxy 设置同步到环境变量，供 isHostInNoProxy 使用
        if (this.networkConfig.no_proxy) {
            process.env.NO_PROXY = this.networkConfig.no_proxy;
            process.env.no_proxy = this.networkConfig.no_proxy;
        }
        // 监听主进程下发的网络配置更新
        this._onNetworkConfigMessage = (msg: any) => {
            if (msg?.type === '__network_config_updated') {
                this.updateNetworkConfig(msg.config);
            }
        };
        // 监听主进程回传的 fetch 流式消息
        this._onFetchMessage = (msg: any) => {
            const handler = this._fetchStreamHandlers.get(msg.id);
            if (handler) {
                handler(msg);
            }
        };
        if (parentPort) {
            parentPort.on('message', this._onNetworkConfigMessage);
            parentPort.on('message', this._onFetchMessage);
        }
    }

    updateNetworkConfig(config: WorkerNetworkConfig): void {
        this.networkConfig = { ...config };
        if (config.no_proxy) {
            process.env.NO_PROXY = config.no_proxy;
            process.env.no_proxy = config.no_proxy;
        } else {
            delete process.env.NO_PROXY;
            delete process.env.no_proxy;
        }
    }

    /** 返回当前线程内的网络代理配置快照（随主进程下发实时更新）。 */
    getNetworkConfig(): PlatformNetworkConfig {
        return { ...this.networkConfig };
    }

    getName(): string {
        return 'worker';
    }

    getEffectiveWorkspace(): string {
        return Setting.getInstance().getEffectiveWorkspace();
    }

    async initPlatformHarness(_task: TaskState): Promise<void> {
        throw new Error('Worker platform does not support initPlatformHarness');
    }

    async fetch(input: string | URL, init?: RequestInit, options?: PlatformFetchOptions): Promise<Response> {
        const url = input instanceof URL ? input.href : input;

        // 退化路径：无 parentPort 时（测试环境等）直接使用全局 fetch
        if (!parentPort) {
            return globalThis.fetch(url, init ?? {});
        }

        const requestId = `__fetch_${++this._fetchRequestCounter}_${Date.now()}`;

        // 序列化 init 为可通过 IPC 传递的格式
        const fetchInit: Record<string, any> = {};
        if (init) {
            if (init.method) fetchInit.method = init.method;
            if (init.headers) fetchInit.headers = headersToRecord(init.headers);
            if (init.body !== undefined && init.body !== null) {
                if (typeof init.body === 'string') {
                    fetchInit.body = init.body;
                } else if (init.body instanceof ArrayBuffer) {
                    fetchInit.bodyBuffer = Buffer.from(init.body).toString('base64');
                } else if (ArrayBuffer.isView(init.body)) {
                    fetchInit.bodyBuffer = Buffer.from(
                        init.body.buffer,
                        init.body.byteOffset,
                        init.body.byteLength
                    ).toString('base64');
                } else {
                    fetchInit.body = String(init.body);
                }
            }
            if (init.redirect) fetchInit.redirect = init.redirect;
        }

        return new Promise<Response>((resolve, reject) => {
            let settled = false;

            const handler = (msg: any) => {
                if (msg.id !== requestId) return;

                // 忽略 chunk/end 消息（它们在 headers 阶段之后由 streamHandler 处理）
                if (msg.type === '__fetch_response_chunk' || msg.type === '__fetch_response_end') {
                    return;
                }

                if (msg.type === '__fetch_response_headers') {
                    if (msg.status === 'error') {
                        settled = true;
                        this._fetchStreamHandlers.delete(requestId);
                        reject(new Error(msg.message || 'Fetch failed in main process'));
                        return;
                    }

                    const responseHeaders = new Headers(msg.headers);

                    // 构建 ReadableStream，body 由 IPC 回传的 chunk 消息驱动
                    const pendingChunks: Uint8Array[] = [];
                    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
                    let streamClosed = false;
                    let streamError: Error | null = null;

                    const bodyStream = new ReadableStream<Uint8Array>({
                        start(controller) {
                            streamController = controller;
                            // 排空在 start() 之前到达的 chunks
                            for (const chunk of pendingChunks) {
                                controller.enqueue(chunk);
                            }
                            pendingChunks.length = 0;
                            if (streamClosed) {
                                if (streamError) {
                                    controller.error(streamError);
                                } else {
                                    controller.close();
                                }
                            }
                        },
                        cancel: (_reason) => {
                            this._fetchStreamHandlers.delete(requestId);
                            parentPort!.postMessage({
                                type: '__fetch_abort',
                                id: requestId
                            });
                        }
                    });

                    // 切换到流阶段 handler
                    const streamHandler = (streamMsg: any) => {
                        if (streamMsg.id !== requestId) return;

                        if (streamMsg.type === '__fetch_response_chunk') {
                            const data = Buffer.from(streamMsg.chunk, 'base64');
                            if (streamController) {
                                try {
                                    streamController.enqueue(data);
                                } catch (_e) {
                                    // stream 可能已被关闭
                                }
                            } else {
                                pendingChunks.push(data);
                            }
                        } else if (streamMsg.type === '__fetch_response_end') {
                            this._fetchStreamHandlers.delete(requestId);
                            streamClosed = true;
                            if (streamMsg.error) {
                                streamError = new Error(streamMsg.error);
                            }
                            if (streamController) {
                                if (streamError) {
                                    try {
                                        streamController.error(streamError);
                                    } catch (_e) {
                                        // ignore
                                    }
                                } else {
                                    try {
                                        streamController.close();
                                    } catch (_e) {
                                        // ignore
                                    }
                                }
                            }
                        }
                    };

                    this._fetchStreamHandlers.set(requestId, streamHandler);
                    settled = true;
                    resolve(
                        new Response(bodyStream, {
                            status: msg.statusCode,
                            statusText: msg.statusText,
                            headers: responseHeaders
                        })
                    );
                }
            };

            this._fetchStreamHandlers.set(requestId, handler);

            // 处理 AbortSignal
            if (init?.signal) {
                const signal = init.signal;
                const onAbort = () => {
                    if (!settled) {
                        settled = true;
                        this._fetchStreamHandlers.delete(requestId);
                        reject(new DOMException('The operation was aborted', 'AbortError'));
                        parentPort!.postMessage({
                            type: '__fetch_abort',
                            id: requestId
                        });
                    }
                };
                if (signal.aborted) {
                    onAbort();
                    return;
                }
                signal.addEventListener('abort', onAbort, { once: true });
            }

            // 发起 IPC 请求
            parentPort!.postMessage({
                type: '__fetch_request',
                id: requestId,
                url,
                init: fetchInit,
                options: options
                    ? {
                          forceEnvironmentProxy: !!options.forceEnvironmentProxy,
                          bypassProxy: !!options.bypassProxy,
                          skipTlsVerification: !!options.skipTlsVerification
                      }
                    : undefined
            });
        });
    }

    private async _shellRequest(method: string, filePath: string): Promise<void> {
        if (!parentPort) {
            throw new Error('WorkerPlatform: parentPort is not available');
        }

        const requestId = `__shell_${++shellRequestCounter}_${Date.now()}`;

        return new Promise<void>((resolve, reject) => {
            const handler = (msg: any) => {
                if (msg.type !== '__shell_response' || msg.id !== requestId) return;
                parentPort!.off('message', handler);

                if (msg.status === 'error') {
                    reject(new Error(msg.message || 'Shell operation failed in main process'));
                    return;
                }
                resolve();
            };

            parentPort!.on('message', handler);
            parentPort!.postMessage({
                type: '__shell_request',
                id: requestId,
                method,
                filePath
            });
        });
    }

    async openPath(filePath: string): Promise<void> {
        await this._shellRequest('openPath', filePath);
    }

    async openExternal(url: string): Promise<void> {
        await this._shellRequest('openExternal', url);
    }

    async trashItem(filePath: string): Promise<void> {
        await this._shellRequest('trashItem', filePath);
    }

    async showItemInFolder(filePath: string): Promise<void> {
        await this._shellRequest('showItemInFolder', filePath);
    }

    getApplicationClasses(): (typeof BaseApplication)[] {
        return [
            MailboxApplication,
            FileMgrApplication,
            CalendarApplication,
            NotesApplication,
            BrowserApplication,
            SearchApplication,
            TerminalApplication,
            SkillMgrApplication,
            PluginMgrApplication,
            AppMgrApplication,
            McpMgrApplication,
            AcpMgrApplication,
            TodoMgrApplication,
            ChannelMgrApplication,
            KnowledgeBaseApplication,
            DeviceMgrApplication,
            BuiltinApplication,
            AgentGateApplication,
            AdminConsoleApplication,
            AgentOfficeApplication,
            WorkflowMgrApplication
        ];
    }
}
