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

import type {
    PluginAccountBackend,
    PluginAccountLoginFlow,
    PluginAccountLoginFlowState,
    PluginAccountLoginMethod
} from '../../../../packages/plugin-sdk/src/index.js';
import type { AccountKind, AccountSession, AccountUser } from './types.js';
import {
    normalizeAccountLoginFlowState,
    normalizeAccountLoginMethods,
    normalizeAccountSession,
    normalizeAccountUser
} from './contracts.js';

export interface AccountServiceDependencies {
    getBaseUrl(kind: AccountKind): string;
    getBackend(kind?: AccountKind): PluginAccountBackend | undefined;
}

export class AccountService {
    private backend: PluginAccountBackend | null = null;
    private loginFlow: { id: string; backend: PluginAccountBackend; flow: PluginAccountLoginFlow } | null = null;
    private nextLoginFlowId = 0;

    constructor(private readonly deps: AccountServiceDependencies) {}

    /**
     * 确保当前后端可用并完成初始化（恢复持久化会话）。
     * 后端身份每次都从注册表解析：插件被停用/重载时旧后端不会继续生效，
     * 后端初始化只在其身份发生变化时执行一次。
     */
    init(): boolean {
        return this.resolveBackend() !== undefined;
    }

    getSession(): AccountSession | null {
        const backend = this.requireBackend();
        const session = backend.getSession();
        return session ? normalizeAccountSession(session, backend) : null;
    }

    async getLoginMethods(kind: AccountKind): Promise<readonly PluginAccountLoginMethod[]> {
        const backend = this.selectBackend(kind);
        return normalizeAccountLoginMethods(
            await backend.getLoginMethods({ kind, baseUrl: this.resolveBaseUrl(kind, backend) })
        );
    }

    async startLogin(
        kind: AccountKind,
        methodId: string
    ): Promise<{ flowId: string; state: PluginAccountLoginFlowState }> {
        await this.cancelActiveLogin();
        const backend = this.selectBackend(kind);
        const flow = await backend.createLoginFlow({
            kind,
            baseUrl: this.resolveBaseUrl(kind, backend),
            methodId
        });
        const flowId = `account-flow-${++this.nextLoginFlowId}`;
        this.loginFlow = { id: flowId, backend, flow };
        try {
            const state = normalizeAccountLoginFlowState(flow.start ? await flow.start() : flow.getState(), backend);
            this.clearTerminalFlow(flowId, state);
            return { flowId, state };
        } catch (error) {
            if (this.loginFlow?.id === flowId) this.loginFlow = null;
            try {
                await flow.cancel();
            } catch {
                // Preserve the startup or validation error when cleanup fails.
            }
            throw error;
        }
    }

    async submitLogin(flowId: string, values: Readonly<Record<string, string>>): Promise<PluginAccountLoginFlowState> {
        const active = this.requireLoginFlow(flowId);
        if (!active.flow.submit) throw new Error('account:login_flow_not_submittable');
        const state = normalizeAccountLoginFlowState(await active.flow.submit(values), active.backend);
        this.clearTerminalFlow(flowId, state);
        return state;
    }

    async pollLogin(flowId: string): Promise<PluginAccountLoginFlowState> {
        const active = this.requireLoginFlow(flowId);
        if (!active.flow.poll) throw new Error('account:login_flow_not_pollable');
        const state = normalizeAccountLoginFlowState(await active.flow.poll(), active.backend);
        this.clearTerminalFlow(flowId, state);
        return state;
    }

    async cancelLogin(flowId: string): Promise<void> {
        const active = this.requireLoginFlow(flowId);
        this.loginFlow = null;
        await active.flow.cancel();
    }

    getUserInfo(): Promise<AccountUser | null> {
        const backend = this.requireBackend();
        return backend.getUserInfo().then((user) => (user ? normalizeAccountUser(user) : null));
    }

    updateDisplayName(displayName: string): Promise<AccountUser> {
        return this.requireBackend().updateDisplayName(displayName).then(normalizeAccountUser);
    }

    refreshToken(): Promise<AccountSession> {
        const backend = this.requireBackend();
        return backend.refreshToken().then((session) => normalizeAccountSession(session, backend));
    }

    async logout(): Promise<void> {
        await this.cancelActiveLogin();
        await this.requireBackend().logout();
    }

    private requireBackend(): PluginAccountBackend {
        const backend = this.resolveBackend();
        if (!backend) throw new Error('account:backend_unavailable');
        return backend;
    }

    private requireLoginFlow(flowId: string): NonNullable<AccountService['loginFlow']> {
        if (!this.loginFlow || this.loginFlow.id !== flowId) throw new Error('account:login_flow_not_found');
        return this.loginFlow;
    }

    private clearTerminalFlow(flowId: string, state: PluginAccountLoginFlowState): void {
        if ((state.status === 'completed' || state.status === 'failed') && this.loginFlow?.id === flowId) {
            this.loginFlow = null;
        }
    }

    private async cancelActiveLogin(): Promise<void> {
        const active = this.loginFlow;
        this.loginFlow = null;
        if (active) await active.flow.cancel();
    }

    /**
     * 生效地址 = 用户/宿主配置值，否则回退到插件声明的默认地址。
     * 个人模式的官方地址由插件提供，宿主不再内置默认值。
     */
    private resolveBaseUrl(kind: AccountKind, backend: PluginAccountBackend): string {
        const configured = this.deps.getBaseUrl(kind).trim();
        if (configured) return configured;
        return backend.getDefaultBaseUrl?.(kind)?.trim() ?? '';
    }

    private selectBackend(kind: AccountKind): PluginAccountBackend {
        const backend = this.deps.getBackend(kind);
        if (!backend) throw new Error(`account:backend_unavailable:${kind}`);
        if (this.backend !== backend) {
            backend.initialize();
            this.backend = backend;
        }
        return backend;
    }

    private resolveBackend(): PluginAccountBackend | undefined {
        const backend = this.deps.getBackend();
        if (!backend) {
            this.backend = null;
            return undefined;
        }
        if (this.backend !== backend) {
            backend.initialize();
            this.backend = backend;
        }
        return backend;
    }
}
