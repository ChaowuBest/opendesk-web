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
import type {
    AccountChange,
    AccountCredential,
    AccountCredentialSnapshot,
    AccountKind,
    AccountSession,
    AccountUser
} from './types.js';
import {
    normalizeAccountCredential,
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
    private readonly credentialListeners = new Set<(change: AccountChange) => void>();
    private lastCredential: AccountCredentialSnapshot | null = null;

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

    /**
     * 当前账号凭据（含 access token），仅供主进程内需要服务端鉴权的能力使用。
     *
     * 后端未注册、未登录或后端未实现 getCredential 时返回 null；调用方按“无凭据”
     * 处理，不得降级为匿名访问。凭据不经 IPC 下发 renderer。
     */
    getCredential(): AccountCredential | null {
        const credential = this.readCredential();
        this.publishCredential(credential);
        return credential;
    }

    /**
     * 订阅账号凭据变化。
     *
     * 变化由本服务在所有会改变会话的入口处派生：renderer 经 IPC、TUI/CLI 直接调用，
     * 都必须经过本服务，因此不依赖 IPC 层的 sessionChanged 通知。
     */
    subscribe(listener: (change: AccountChange) => void): () => void {
        this.credentialListeners.add(listener);
        return () => {
            this.credentialListeners.delete(listener);
        };
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
        return this.requireBackend()
            .updateDisplayName(displayName)
            .then((user) => {
                const normalized = normalizeAccountUser(user);
                this.syncCredential();
                return normalized;
            });
    }

    refreshToken(): Promise<AccountSession> {
        const backend = this.requireBackend();
        return backend.refreshToken().then((session) => {
            const normalized = normalizeAccountSession(session, backend);
            this.syncCredential();
            return normalized;
        });
    }

    async logout(): Promise<void> {
        await this.cancelActiveLogin();
        try {
            await this.requireBackend().logout();
        } finally {
            this.syncCredential();
        }
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
        if (state.status === 'completed') this.syncCredential();
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
        this.adoptBackend(backend);
        return backend;
    }

    private resolveBackend(): PluginAccountBackend | undefined {
        const backend = this.deps.getBackend();
        if (!backend) {
            if (this.backend) {
                this.backend = null;
                this.syncCredential();
            }
            return undefined;
        }
        this.adoptBackend(backend);
        return backend;
    }

    /**
     * 后端身份变化（插件注册/重载/停用）时初始化一次并重新派生凭据：
     * 启动时后端从磁盘恢复出的会话，也在这里产生一次 committed。
     */
    private adoptBackend(backend: PluginAccountBackend): void {
        if (this.backend === backend) return;
        backend.initialize();
        this.backend = backend;
        this.syncCredential();
    }

    /** 读取当前凭据；无后端、未登录或后端不支持时为 null，不抛错。 */
    private readCredential(): AccountCredential | null {
        const backend = this.backend ?? this.deps.getBackend();
        if (!backend || typeof backend.getCredential !== 'function') return null;
        const credential = backend.getCredential();
        return credential ? normalizeAccountCredential(credential, backend) : null;
    }

    /** 比较当前凭据与上次已发布值，派生并广播 stopped / committed / token-updated。 */
    private syncCredential(): void {
        let next: AccountCredential | null = null;
        try {
            next = this.readCredential();
        } catch {
            // 后端返回了不合法的凭据：按失去凭据处理，不把坏数据发给消费方。
            next = null;
        }
        this.publishCredential(next);
    }

    private publishCredential(next: AccountCredential | null): void {
        const previous = this.lastCredential;
        if (!previous && !next) return;
        if (previous && !next) {
            this.lastCredential = null;
            this.emitCredential({ kind: 'stopped', credential: previous });
            return;
        }
        if (!previous && next) {
            this.lastCredential = next;
            this.emitCredential({ kind: 'committed', credential: next });
            return;
        }
        if (!previous || !next) return;
        if (!AccountService.sameIdentity(previous, next)) {
            this.lastCredential = null;
            this.emitCredential({ kind: 'stopped', credential: previous });
            this.lastCredential = next;
            this.emitCredential({ kind: 'committed', credential: next });
            return;
        }
        this.lastCredential = next;
        if (previous.accessToken !== next.accessToken || previous.tokenType !== next.tokenType) {
            this.emitCredential({ kind: 'token-updated', credential: next });
        }
    }

    private emitCredential(change: AccountChange): void {
        for (const listener of [...this.credentialListeners]) {
            try {
                listener(change);
            } catch {
                // 观察者异常不得影响账号状态或其他观察者。
            }
        }
    }

    private static sameIdentity(left: AccountCredentialSnapshot, right: AccountCredentialSnapshot): boolean {
        return (
            left.backendId === right.backendId &&
            left.kind === right.kind &&
            left.baseUrl === right.baseUrl &&
            left.user.id === right.user.id
        );
    }
}
