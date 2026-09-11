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

function toUser(user) {
    return {
        id: user.id,
        username: user.username,
        email: user.email ?? undefined,
        display_name: user.display_name ?? undefined,
        avatar_url: user.avatar_url ?? undefined
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

    async getLoginMethods() {
        return [
            {
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
            }
        ];
    }

    async createLoginFlow(request) {
        if (request.methodId !== 'password') throw new Error(`account:login_method_unavailable:${request.methodId}`);
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
                this.client = client;
                this.session = {
                    version: 1,
                    kind: request.kind,
                    baseUrl: request.baseUrl,
                    accessToken: token.access_token,
                    tokenType: token.token_type,
                    user
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
