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
 * fetch 请求直接在 Worker 中通过 undici（Node.js 原生 fetch）执行，
 * 支持流式响应（SSE 等长连接），并根据网络配置自动处理代理和 SSL 设置。
 */

import { AbstractPlatform, type PlatformFetchOptions } from './base.js';
import { Setting } from '../main/utils/setting.js';
import type { TaskState } from '../main/aikernel/states/tasks.js';
import { parentPort, workerData } from 'worker_threads';
import { fetchWithResolvedProxy } from './proxy-fetch.js';
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
import { initAgentGateHook } from '../main/agentgate/hook.js';

// Ensure hook is registered in the worker chunk (same bundle as tool execution)
initAgentGateHook();

let shellRequestCounter = 0;

interface WorkerNetworkConfig {
    no_ssl: boolean;
    use_proxy: 'system' | 'custom' | 'none';
    custom_proxy_addr: string;
    no_proxy: string;
}

export class WorkerPlatform extends AbstractPlatform {
    private networkConfig: WorkerNetworkConfig;
    private _onNetworkConfigMessage: ((msg: any) => void) | null = null;

    constructor() {
        super();
        const setting = (workerData as any)?.setting;
        const nc = setting?.network_config;
        this.networkConfig = {
            no_ssl: nc?.no_ssl ?? false,
            use_proxy: nc?.use_proxy ?? 'none',
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
        if (parentPort) {
            parentPort.on('message', this._onNetworkConfigMessage);
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
    getName(): string {
        return 'worker';
    }

    getInjectedEnviron(): Map<string, string> {
        const env = super.getInjectedEnviron();
        if ((process.platform as string) === 'openharmony') {
            env.set('NODE_OPTIONS', '--jitless');
        }
        return env;
    }

    getEffectiveWorkspace(): string {
        return Setting.getInstance().getEffectiveWorkspace();
    }

    async initPlatformHarness(_task: TaskState): Promise<void> {
        throw new Error('Worker platform does not support initPlatformHarness');
    }

    async fetch(input: string | URL, init?: RequestInit, options?: PlatformFetchOptions): Promise<Response> {
        const url = input instanceof URL ? input.href : input;
        const bypassProxy = !!options?.bypassProxy;
        const skipTlsVerification = !!options?.skipTlsVerification;
        const forceEnvironmentProxy = !!options?.forceEnvironmentProxy;

        // 根据网络配置决定代理行为
        const useProxy = !bypassProxy && this.networkConfig.use_proxy !== 'none';
        const proxyUrl =
            useProxy && this.networkConfig.use_proxy === 'custom' ? this.networkConfig.custom_proxy_addr : undefined;
        const useEnvironmentProxy = useProxy && this.networkConfig.use_proxy === 'system';
        const noSsl = skipTlsVerification || this.networkConfig.no_ssl;

        return fetchWithResolvedProxy(url, init, {
            proxyUrl: proxyUrl || undefined,
            useEnvironmentProxy: forceEnvironmentProxy || useEnvironmentProxy,
            bypassProxy,
            skipTlsVerification: noSsl
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
            AppMgrApplication,
            McpMgrApplication,
            TodoMgrApplication,
            ChannelMgrApplication,
            KnowledgeBaseApplication,
            DeviceMgrApplication,
            BuiltinApplication,
            AgentGateApplication
        ];
    }
}
