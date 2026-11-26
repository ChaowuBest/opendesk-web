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

import { AuthenticationError, OpenDeskClient } from '@bitclub.ai/opendesk-server-sdk';

/** 个人账号官方服务地址：由插件自身声明，宿主不再内置默认值。 */
const DEFAULT_PERSONAL_BASE_URL = 'http://101.133.143.192/api/v1';

function toUser(user) {
    return {
        id: user.id,
        username: user.username,
        email: user.email ?? undefined,
        display_name: user.display_name ?? undefined,
        avatar_url: user.avatar_url ?? undefined
    };
}

function passwordLoginMethod() {
    return {
        id: 'password',
        type: 'form',
        displayName: { en: 'Password', zh: '密码登录' },
        fields: [
            {
                id: 'username',
                type: 'text',
                label: { en: 'Username', zh: '用户名' },
                autocomplete: 'username',
                required: true
            },
            {
                id: 'password',
                type: 'password',
                label: { en: 'Password', zh: '密码' },
                autocomplete: 'current-password',
                required: true
            }
        ]
    };
}

export class OpenDeskAccountBackend {
    id = 'opendesk';
    kinds = ['personal', 'enterprise'];
    session = null;
    client = null;

    constructor(host, clientFactory = (baseUrl) => new OpenDeskClient({ baseUrl, fetch: host.network.fetch })) {
        this.host = host;
        this.clientFactory = clientFactory;
    }

    getDefaultBaseUrl(kind) {
        return kind === 'personal' ? DEFAULT_PERSONAL_BASE_URL : undefined;
    }

    initialize() {
        if (this.session && this.client) return;
        const saved = this.host.secrets.load();
        if (!saved || saved.version !== 1 || !saved.accessToken || !saved.baseUrl || !saved.kind) return;
        this.session = saved;
        this.client = this.createClient(saved.baseUrl);
        this.client.setToken(saved.accessToken);
    }

    getSession() {
        return this.session ? this.toPublicSession(this.session) : null;
    }

    /**
     * 向宿主提供当前凭据（含 access token）。
     * 只在主进程内使用，不进入 getSession() 的公开会话，也不经 IPC 下发 renderer。
     */
    getCredential() {
        if (!this.session) return null;
        return {
            ...this.toPublicSession(this.session),
            accessToken: this.session.accessToken,
            tokenType: this.session.tokenType
        };
    }

    /** 从服务端读取登录方式：第三方 Provider + 可选的密码登录。 */
    async fetchAuthMethods(baseUrl) {
        try {
            const client = this.createClient(baseUrl);
            const data = await client.auth.getAuthMethods();
            return data && typeof data === 'object' ? data : null;
        } catch {
            // 服务端不可用或旧版本无该接口：无法确定登录方式，返回 null 交由上层处理
            return null;
        }
    }

    async getLoginMethods(context) {
        const authMethods = await this.fetchAuthMethods(context.baseUrl);
        if (!authMethods) return [];

        const methods = [];
        // 是否开放密码登录完全以服务端 /auth/methods 为准，不在插件中按账号类型写死；
        // 密码登录排在前面，第三方 Provider 按服务端返回顺序依次追加
        if (authMethods.password_login === true) methods.push(passwordLoginMethod());
        for (const provider of authMethods.providers ?? []) {
            const id = typeof provider?.name === 'string' ? provider.name.trim() : '';
            if (!id) continue;
            methods.push({
                id,
                type: 'browser',
                displayName: provider.display_name || id
            });
        }
        return methods;
    }

    async createLoginFlow(request) {
        if (request.methodId === 'password') return this.createPasswordLoginFlow(request);
        return this.createSocialLoginFlow(request);
    }

    createPasswordLoginFlow(request) {
        let state = { status: 'ready' };
        return {
            getState: () => state,
            submit: async (values) => {
                const username = values.username?.trim();
                const password = values.password;
                if (!username || !password) {
                    state = { status: 'failed', errorCode: 'account:credentials_required' };
                    return state;
                }
                const client = this.createClient(request.baseUrl);
                const token = await client.auth.login({ username, password });
                const user = toUser(await client.auth.getMe());
                const modelApi = await this.fetchModelApi(client);
                this.client = client;
                this.session = {
                    version: 1,
                    kind: request.kind,
                    baseUrl: request.baseUrl,
                    accessToken: token.access_token,
                    tokenType: token.token_type,
                    user,
                    modelApi
                };
                this.persist();
                state = { status: 'completed', session: this.toPublicSession(this.session) };
                return state;
            },
            cancel: async () => {
                state = { status: 'failed', errorCode: 'account:login_cancelled' };
            }
        };
    }

    /**
     * 第三方（如 GitCode）浏览器登录：委托 SDK 的 `auth.startDesktopLogin()` 高阶流程
     * 请求授权链接、打开系统浏览器并轮询桌面会话；插件把它桥接为宿主需要的
     * start（打开浏览器）/ poll（查询进度）/ cancel（中止）三段式状态机。
     */
    createSocialLoginFlow(request) {
        const provider = request.methodId;
        const client = this.createClient(request.baseUrl);
        let state = { status: 'ready' };
        let controller = null;
        let completion = null;

        const establishSession = async (token) => {
            client.setToken(token.access_token);
            const user = toUser(await client.auth.getMe());
            const modelApi = await this.fetchModelApi(client);
            this.client = client;
            this.session = {
                version: 1,
                kind: request.kind,
                baseUrl: request.baseUrl,
                accessToken: token.access_token,
                tokenType: token.token_type || 'Bearer',
                user,
                modelApi
            };
            this.persist();
            return this.toPublicSession(this.session);
        };

        return {
            getState: () => state,
            start: async () => {
                controller = new AbortController();
                let markOpened;
                const opened = new Promise((resolve) => {
                    markOpened = resolve;
                });
                completion = client.auth
                    .startDesktopLogin({
                        provider,
                        openUrl: async (url) => {
                            markOpened(url);
                            await this.host.auth.openExternal(url);
                        },
                        signal: controller.signal
                    })
                    .then(
                        async (token) => {
                            try {
                                state = { status: 'completed', session: await establishSession(token) };
                            } catch {
                                state = { status: 'failed', errorCode: 'account:social_login_failed' };
                            }
                        },
                        () => {
                            // 取消与失败都收敛为 failed，由宿主统一展示
                            state = {
                                status: 'failed',
                                errorCode: controller.signal.aborted
                                    ? 'account:login_cancelled'
                                    : 'account:social_login_failed'
                            };
                        }
                    );
                // SDK 一定先 await openUrl 再轮询，因此拿到 URL 即视为浏览器已打开
                const url = await Promise.race([opened, completion]);
                if (state.status === 'ready') state = { status: 'opening-browser', url };
                return state;
            },
            poll: async () => {
                // 后台高阶流程持续更新 state；轮询只读取当前进度，由宿主控制节奏
                return state;
            },
            cancel: async () => {
                controller?.abort();
                state = { status: 'failed', errorCode: 'account:login_cancelled' };
            }
        };
    }

    async getUserInfo() {
        if (!this.client) return null;
        try {
            return toUser(await this.client.auth.getMe());
        } catch (error) {
            if (error instanceof AuthenticationError) return null;
            throw error;
        }
    }

    async updateDisplayName(displayName) {
        this.requireSession();
        const user = toUser(await this.client.auth.updateMe({ display_name: displayName }));
        this.session.user = user;
        this.persist();
        return user;
    }

    async refreshToken() {
        this.requireSession();
        const token = await this.client.auth.refresh();
        this.client.setToken(token.access_token);
        this.session.accessToken = token.access_token;
        this.session.tokenType = token.token_type;
        this.session.modelApi = await this.fetchModelApi(this.client);
        this.persist();
        return this.toPublicSession(this.session);
    }

    async logout() {
        if (this.client) {
            try {
                await this.client.auth.logout();
            } catch {
                // Local credentials must still be cleared when remote logout fails.
            }
        }
        this.client = null;
        this.session = null;
        this.host.secrets.clear();
    }

    /**
     * 内置模型的接入信息：relay 的 base_url + 虚拟 key（`sk-od-...`）。
     * 账号登录 token 只用于换取 relay 凭据；真正的模型调用凭据是 `credential`。
     */
    async fetchModelApi(client) {
        try {
            const info = await client.relay.getInfo();
            const baseUrl = typeof info?.base_url === 'string' ? info.base_url.trim().replace(/\/+$/, '') : '';
            // 账号登录后 relay 默认已有凭据；客户端只读取，禁止调用 createCredential 新建
            const credential = await client.relay.getCredential();
            const token = typeof credential?.credential === 'string' ? credential.credential.trim() : '';
            if (!baseUrl || !token) return null;
            return { baseUrl, token };
        } catch {
            // relay 未启用或凭据读取失败：登录仍然有效，只是内置模型暂不可用
            return null;
        }
    }

    getModelApi() {
        if (!this.session) return null;
        const api = this.session.modelApi;
        if (!api || !api.baseUrl || !api.token) return null;
        return { baseUrl: api.baseUrl, token: api.token };
    }

    createClient(baseUrl) {
        return this.clientFactory(baseUrl);
    }

    persist() {
        this.host.secrets.save(this.session);
    }

    requireSession() {
        if (!this.client || !this.session) throw new Error('account:not_logged_in');
    }

    toPublicSession(session) {
        return {
            backendId: this.id,
            kind: session.kind,
            baseUrl: session.baseUrl,
            user: session.user
        };
    }
}
