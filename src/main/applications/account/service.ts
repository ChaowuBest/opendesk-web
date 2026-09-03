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
    AccountClient,
    AccountKind,
    AccountSession,
    AccountSessionStore,
    AccountUser,
    AccountUserResponse
} from './types.js';

/** 账号服务的依赖注入点，便于测试与解耦。 */
export interface AccountServiceDependencies {
    store: AccountSessionStore;
    /** 根据账号来源解析后端 base_url。 */
    getBaseUrl: (kind: AccountKind) => string;
    /** 创建 OpenDeskClient 实例，允许注入自定义 fetch。 */
    clientFactory: (baseUrl: string) => AccountClient;
    isAuthenticationError: (error: unknown) => boolean;
}

function toAccountUser(user: AccountUserResponse): AccountUser {
    return {
        id: user.id,
        username: user.username,
        email: user.email ?? undefined,
        display_name: user.display_name ?? undefined,
        avatar_url: user.avatar_url ?? undefined
    };
}

/**
 * 账号服务：负责登录、会话恢复、资料更新与登出。
 *
 * 内部维护一个 OpenDeskClient 用于当前会话，会话内容持久化到 AccountTokenStore。
 * getUserInfo 在 token 失效（401）时返回 null，便于上层判定登录态。
 */
export class AccountService {
    private currentSession: AccountSession | null = null;
    private client: OpenDeskClient | null = null;

    constructor(private readonly deps: AccountServiceDependencies) {}

    /** 从持久化会话恢复登录态（应用启动时调用）。 */
    init(): void {
        const saved = this.deps.store.load();
        if (!saved) {
            return;
        }
        this.currentSession = {
            kind: saved.kind,
            baseUrl: saved.baseUrl,
            accessToken: saved.accessToken,
            tokenType: saved.tokenType,
            user: saved.user
        };
        this.client = this.deps.clientFactory(saved.baseUrl);
        this.client.setToken(saved.accessToken);
    }

    /** 当前会话，未登录为 null。 */
    getSession(): AccountSession | null {
        return this.currentSession;
    }

    /** 使用用户名/密码登录，成功后持久化会话并返回。 */
    async login(kind: AccountKind, username: string, password: string): Promise<AccountSession> {
        const baseUrl = this.deps.getBaseUrl(kind);
        const client = this.deps.clientFactory(baseUrl);
        const token = await client.auth.login({ username, password });
        const user = toAccountUser(await client.auth.getMe());

        const session: AccountSession = {
            kind,
            baseUrl,
            accessToken: token.access_token,
            tokenType: token.token_type,
            user
        };
        this.client = client;
        this.currentSession = session;
        this.deps.store.save({
            version: 1,
            kind,
            baseUrl,
            accessToken: token.access_token,
            tokenType: token.token_type,
            user
        });
        return session;
    }

    /** 获取当前用户信息；未登录或 token 失效（401）时返回 null。 */
    async getUserInfo(): Promise<AccountUser | null> {
        if (!this.client) {
            return null;
        }
        try {
            return toAccountUser(await this.client.auth.getMe());
        } catch (error) {
            if (this.deps.isAuthenticationError(error)) {
                return null;
            }
            throw error;
        }
    }

    /** 更新当前用户显示名，并同步持久化会话。 */
    async updateDisplayName(displayName: string): Promise<AccountUser> {
        if (!this.client || !this.currentSession) {
            throw new Error('account:not_logged_in');
        }
        const user = toAccountUser(await this.client.auth.updateMe({ display_name: displayName }));
        this.currentSession.user = user;
        this.deps.store.save({
            version: 1,
            kind: this.currentSession.kind,
            baseUrl: this.currentSession.baseUrl,
            accessToken: this.currentSession.accessToken,
            tokenType: this.currentSession.tokenType,
            user
        });
        return user;
    }

    /** 刷新 token 并轮换持久化会话。 */
    async refreshToken(): Promise<AccountSession> {
        if (!this.client || !this.currentSession) {
            throw new Error('account:not_logged_in');
        }
        const token = await this.client.auth.refresh();
        this.client.setToken(token.access_token);
        this.currentSession.accessToken = token.access_token;
        this.currentSession.tokenType = token.token_type;
        this.deps.store.save({
            version: 1,
            kind: this.currentSession.kind,
            baseUrl: this.currentSession.baseUrl,
            accessToken: this.currentSession.accessToken,
            tokenType: this.currentSession.tokenType,
            user: this.currentSession.user
        });
        return this.currentSession;
    }

    /** 登出：通知后端撤销 token，并清除本地会话与会话文件。 */
    async logout(): Promise<void> {
        if (this.client) {
            try {
                await this.client.auth.logout();
            } catch {
                // 忽略后端登出失败，始终清理本地会话
            }
        }
        this.client = null;
        this.currentSession = null;
        this.deps.store.clear();
    }
}
