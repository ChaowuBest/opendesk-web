import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenDeskClient } from '@bitclub.ai/opendesk-server-sdk';
import { accountBackendRegistry } from '../../../main/applications/account/backend-registry.js';
import { discoverPlugins } from '../../../main/applications/pluginmgr/discovery/discovery.js';
import { loadPlugin } from '../../../main/applications/pluginmgr/discovery/loader.js';
import { PluginHost } from '../../../main/applications/pluginmgr/runtime/host.js';
import { registerSdkPackageMapping } from '../../../main/applications/pluginmgr/runtime/package-mapping.js';

function createClient() {
    const client = {
        token: null as string | null,
        setToken(token: string) {
            this.token = token;
        },
        auth: {
            getAuthMethods: async () => ({ password_login: true, registration: false, providers: [] }),
            login: async () => ({ access_token: 'secret-token', token_type: 'Bearer' }),
            getMe: async () => ({ id: 'u-1', username: 'alice', email: null }),
            updateMe: async ({ display_name }: { display_name: string }) => ({
                id: 'u-1',
                username: 'alice',
                display_name
            }),
            refresh: async () => ({ access_token: 'refreshed-token', token_type: 'Bearer' }),
            logout: async () => undefined
        }
    };
    return client;
}

describe('builtin account plugin', () => {
    test('loads the OpenDesk backend for personal and enterprise accounts', async () => {
        registerSdkPackageMapping();
        const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-account-plugin-'));
        const builtinDirectory = path.resolve('resources/plugins');
        const candidate = discoverPlugins({ configDirectory, builtinDirectory }).candidates.find(
            (plugin) => plugin.id === 'opendesk-account'
        );
        expect(candidate).toMatchObject({
            id: 'opendesk-account',
            source: 'builtin',
            enabled: true,
            spec: path.join(builtinDirectory, 'opendesk-account')
        });
        if (!candidate) throw new Error('opendesk-account builtin plugin was not discovered');
        const loaded = await loadPlugin(
            {
                ...candidate,
                origin: builtinDirectory
            },
            configDirectory,
            { requireDeclaration: true }
        );
        const host = new PluginHost();

        const entry = await host.activate(loaded.plugin, {
            origin: loaded.candidate.origin,
            pluginDir: loaded.rootDir,
            resources: loaded.resources
        });

        expect(entry.status).toBe('active');
        expect(entry.capabilities).toContain('account');
        const registered = accountBackendRegistry.get('opendesk');
        expect(registered?.kinds).toEqual(['personal', 'enterprise']);
        // 当前宿主只允许一个账号后端，无 kind 场景（会话恢复）路由到该后端
        expect(accountBackendRegistry.getDefault()?.id).toBe('opendesk');

        await host.dispose();
        fs.rmSync(configDirectory, { recursive: true, force: true });
        expect(accountBackendRegistry.get('opendesk')).toBeUndefined();
        expect(accountBackendRegistry.getDefault()).toBeUndefined();
    });

    test('owns private sessions while exposing token-free public sessions', async () => {
        registerSdkPackageMapping();
        const module = (await import('../../../../resources/plugins/opendesk-account/runtime/service.mjs')) as {
            OpenDeskAccountBackend: new (
                host: unknown,
                clientFactory: () => unknown
            ) => {
                initialize(): void;
                getDefaultBaseUrl(kind: string): string | undefined;
                getLoginMethods(request: unknown): Promise<Record<string, unknown>[]>;
                createLoginFlow(request: unknown): Promise<{
                    submit(values: Record<string, string>): Promise<Record<string, unknown>>;
                }>;
                refreshToken(): Promise<Record<string, unknown>>;
            };
        };
        let stored: unknown = null;
        const host = {
            network: { fetch: globalThis.fetch },
            secrets: {
                load: () => stored,
                save: (value: unknown) => {
                    stored = structuredClone(value);
                },
                clear: () => {
                    stored = null;
                }
            }
        };
        const client = createClient();
        const backend = new module.OpenDeskAccountBackend(host, () => client);

        expect(backend.getDefaultBaseUrl('personal')).toMatch(/^https?:\/\/\S+/);
        expect(backend.getDefaultBaseUrl('enterprise')).toBeUndefined();

        const methods = await backend.getLoginMethods({
            kind: 'enterprise',
            baseUrl: 'https://enterprise.example.com/api/v1'
        });
        expect(methods).toMatchObject([{ id: 'password', type: 'form' }]);

        const flow = await backend.createLoginFlow({
            kind: 'enterprise',
            baseUrl: 'https://enterprise.example.com/api/v1',
            methodId: 'password'
        });
        const result = await flow.submit({
            username: 'alice',
            password: 'secret'
        });
        expect(result).toMatchObject({ status: 'completed' });
        const session = result.session as Record<string, unknown>;

        expect(session).toEqual({
            backendId: 'opendesk',
            kind: 'enterprise',
            baseUrl: 'https://enterprise.example.com/api/v1',
            user: { id: 'u-1', username: 'alice', email: undefined, display_name: undefined, avatar_url: undefined }
        });
        expect(session).not.toHaveProperty('accessToken');
        expect(stored).toMatchObject({ accessToken: 'secret-token', tokenType: 'Bearer' });

        const refreshed = await backend.refreshToken();
        expect(refreshed).not.toHaveProperty('accessToken');
        expect(stored).toMatchObject({ accessToken: 'refreshed-token' });
        expect(client.token).toBe('refreshed-token');
    });

    test('exposes GitCode as a browser method and completes via desktop login flow', async () => {
        registerSdkPackageMapping();
        const module = (await import('../../../../resources/plugins/opendesk-account/runtime/service.mjs')) as {
            OpenDeskAccountBackend: new (
                host: unknown,
                clientFactory: (baseUrl: string) => unknown
            ) => {
                getLoginMethods(context: unknown): Promise<Record<string, unknown>[]>;
                createLoginFlow(request: unknown): Promise<{
                    start(): Promise<Record<string, unknown>>;
                    poll(): Promise<Record<string, unknown>>;
                }>;
            };
        };

        const requests: string[] = [];
        const jsonResponse = (data: unknown) =>
            new Response(JSON.stringify(data), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        const stubFetch: typeof fetch = async (input) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
            requests.push(url);
            if (url.endsWith('/auth/methods')) {
                return jsonResponse({
                    password_login: false,
                    registration: false,
                    providers: [{ name: 'gitcode', display_name: 'GitCode' }]
                });
            }
            if (url.includes('/auth/social/gitcode/login-url')) {
                return jsonResponse({ login_url: 'https://gitcode.com/oauth/authorize?state=st', state: 'st' });
            }
            if (url.includes('/auth/social/session/')) {
                return jsonResponse({ status: 'completed', access_token: 'social-token', token_type: 'Bearer' });
            }
            if (url.endsWith('/auth/me')) {
                return jsonResponse({ id: 'u-1', username: 'alice', email: null });
            }
            throw new Error(`unexpected url: ${url}`);
        };

        const opened: string[] = [];
        let stored: unknown = null;
        const host = {
            network: { fetch: stubFetch },
            auth: {
                openExternal: async (url: string) => {
                    opened.push(url);
                }
            },
            secrets: {
                load: () => stored,
                save: (value: unknown) => {
                    stored = structuredClone(value);
                },
                clear: () => {
                    stored = null;
                }
            }
        };
        const clients: OpenDeskClient[] = [];
        const backend = new module.OpenDeskAccountBackend(host, (baseUrl: string) => {
            const client = new OpenDeskClient({ baseUrl, fetch: stubFetch });
            clients.push(client);
            return client;
        });

        const methods = await backend.getLoginMethods({
            kind: 'personal',
            baseUrl: 'https://personal.example.com/api/v1'
        });
        expect(methods).toMatchObject([{ id: 'gitcode', type: 'browser' }]);

        const flow = await backend.createLoginFlow({
            kind: 'personal',
            baseUrl: 'https://personal.example.com/api/v1',
            methodId: 'gitcode'
        });
        const started = await flow.start();
        expect(started.status).toBe('opening-browser');
        expect(opened).toEqual(['https://gitcode.com/oauth/authorize?state=st']);

        let state = started;
        for (let attempt = 0; attempt < 20 && state.status !== 'completed' && state.status !== 'failed'; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            state = await flow.poll();
        }
        expect(state.status).toBe('completed');
        const session = state.session as Record<string, unknown>;
        expect(session).toMatchObject({
            backendId: 'opendesk',
            kind: 'personal',
            baseUrl: 'https://personal.example.com/api/v1',
            user: { id: 'u-1', username: 'alice' }
        });
        expect(session).not.toHaveProperty('accessToken');
        expect(clients.at(-1)?.token).toBe('social-token');
        expect(stored).toMatchObject({
            accessToken: 'social-token',
            kind: 'personal',
            baseUrl: 'https://personal.example.com/api/v1'
        });
        expect(requests.some((url) => url.includes('/auth/social/session/'))).toBe(true);
    });

    test('derives login methods from auth/methods without hardcoding account kind', async () => {
        registerSdkPackageMapping();
        const module = (await import('../../../../resources/plugins/opendesk-account/runtime/service.mjs')) as {
            OpenDeskAccountBackend: new (
                host: unknown,
                clientFactory: () => unknown
            ) => {
                getLoginMethods(context: unknown): Promise<Record<string, unknown>[]>;
            };
        };
        const host = { secrets: { load: () => null, save: () => undefined, clear: () => undefined } };

        const withProvider = createClient();
        withProvider.auth.getAuthMethods = async () => ({
            password_login: true,
            registration: false,
            providers: [{ name: 'gitcode', display_name: 'GitCode' }]
        });
        const personal = await new module.OpenDeskAccountBackend(host, () => withProvider).getLoginMethods({
            kind: 'personal',
            baseUrl: 'https://personal.example.com/api/v1'
        });
        expect(personal).toEqual([
            {
                id: 'password',
                type: 'form',
                displayName: { en: 'Password', zh: '密码登录' },
                fields: expect.any(Array)
            },
            { id: 'gitcode', type: 'browser', displayName: 'GitCode' }
        ]);

        const thirdPartyOnly = createClient();
        thirdPartyOnly.auth.getAuthMethods = async () => ({
            password_login: false,
            registration: false,
            providers: [{ name: 'gitcode', display_name: 'GitCode' }]
        });
        const personalThirdParty = await new module.OpenDeskAccountBackend(host, () => thirdPartyOnly).getLoginMethods({
            kind: 'personal',
            baseUrl: 'https://personal.example.com/api/v1'
        });
        expect(personalThirdParty).toEqual([{ id: 'gitcode', type: 'browser', displayName: 'GitCode' }]);

        const offline = createClient();
        offline.auth.getAuthMethods = async () => {
            throw new Error('offline');
        };
        const unavailable = await new module.OpenDeskAccountBackend(host, () => offline).getLoginMethods({
            kind: 'personal',
            baseUrl: 'https://personal.example.com/api/v1'
        });
        expect(unavailable).toEqual([]);
    });

    test('内置模型凭据来自 relay credential 而非账号登录 token', async () => {
        registerSdkPackageMapping();
        const module = (await import('../../../../resources/plugins/opendesk-account/runtime/service.mjs')) as {
            OpenDeskAccountBackend: new (
                host: unknown,
                clientFactory: () => unknown
            ) => {
                initialize(): void;
                createLoginFlow(request: unknown): Promise<{
                    submit(values: Record<string, string>): Promise<Record<string, unknown>>;
                }>;
                getModelApi(): { baseUrl: string; token: string } | null;
            };
        };
        let stored: unknown = null;
        const host = {
            secrets: {
                load: () => stored,
                save: (value: unknown) => {
                    stored = structuredClone(value);
                },
                clear: () => {
                    stored = null;
                }
            }
        };
        let getCredentialCalls = 0;
        let createCredentialCalls = 0;
        const getCredential = async () => {
            getCredentialCalls += 1;
            return { credential: 'sk-od-abc', key: 'relay-key', token_type: 'Bearer' };
        };
        const createCredential = async () => {
            createCredentialCalls += 1;
            return { credential: 'sk-od-created', key: 'relay-key', token_type: 'Bearer' };
        };
        const client = {
            token: null as string | null,
            setToken(token: string) {
                this.token = token;
            },
            auth: {
                login: async () => ({ access_token: 'login-token', token_type: 'Bearer' }),
                getMe: async () => ({ id: 'u-1', username: 'alice' })
            },
            relay: {
                getInfo: async () => ({ base_url: 'https://relay.example.com/v1/', models: [] }),
                getCredential,
                createCredential
            }
        };
        const backend = new module.OpenDeskAccountBackend(host, () => client);
        const flow = await backend.createLoginFlow({
            kind: 'personal',
            baseUrl: 'https://personal.example.com/api/v1',
            methodId: 'password'
        });
        const result = await flow.submit({ username: 'alice', password: 'secret' });

        expect(result.status).toBe('completed');
        expect(backend.getModelApi()).toEqual({ baseUrl: 'https://relay.example.com/v1', token: 'sk-od-abc' });
        expect(stored).toMatchObject({ modelApi: { baseUrl: 'https://relay.example.com/v1', token: 'sk-od-abc' } });
        // 已有凭据时不应再触发签发
        expect(getCredentialCalls).toBeGreaterThan(0);
        expect(createCredentialCalls).toBe(0);

        // 持久化会话恢复后仍使用同一 relay 凭据
        const restored = new module.OpenDeskAccountBackend(host, () => client);
        restored.initialize();
        expect(restored.getModelApi()).toEqual({ baseUrl: 'https://relay.example.com/v1', token: 'sk-od-abc' });
    });

    test('relay 无既有凭据时不调用 createCredential', async () => {
        registerSdkPackageMapping();
        const module = (await import('../../../../resources/plugins/opendesk-account/runtime/service.mjs')) as {
            OpenDeskAccountBackend: new (
                host: unknown,
                clientFactory: () => unknown
            ) => {
                createLoginFlow(request: unknown): Promise<{
                    submit(values: Record<string, string>): Promise<Record<string, unknown>>;
                }>;
                getModelApi(): { baseUrl: string; token: string } | null;
            };
        };
        let stored: unknown = null;
        const host = {
            secrets: {
                load: () => stored,
                save: (value: unknown) => {
                    stored = structuredClone(value);
                },
                clear: () => {
                    stored = null;
                }
            }
        };
        let createCredentialCalls = 0;
        const createCredential = async () => {
            createCredentialCalls += 1;
            return { credential: 'sk-od-created', key: 'relay-key', token_type: 'Bearer' };
        };
        const client = {
            token: null as string | null,
            setToken(token: string) {
                this.token = token;
            },
            auth: {
                login: async () => ({ access_token: 'login-token', token_type: 'Bearer' }),
                getMe: async () => ({ id: 'u-1', username: 'alice' })
            },
            relay: {
                getInfo: async () => ({ base_url: 'https://relay.example.com/v1', models: [] }),
                getCredential: async () => ({ credential: '', key: '', token_type: 'Bearer' }),
                createCredential
            }
        };
        const backend = new module.OpenDeskAccountBackend(host, () => client);
        const flow = await backend.createLoginFlow({
            kind: 'personal',
            baseUrl: 'https://personal.example.com/api/v1',
            methodId: 'password'
        });
        const result = await flow.submit({ username: 'alice', password: 'secret' });

        expect(result.status).toBe('completed');
        // 客户端被禁止创建凭据：缺省时应保持内置模型不可用
        expect(createCredentialCalls).toBe(0);
        expect(backend.getModelApi()).toBeNull();
    });

    test('relay 读取失败时登录仍成功，内置模型暂不可用', async () => {
        registerSdkPackageMapping();
        const module = (await import('../../../../resources/plugins/opendesk-account/runtime/service.mjs')) as {
            OpenDeskAccountBackend: new (
                host: unknown,
                clientFactory: () => unknown
            ) => {
                createLoginFlow(request: unknown): Promise<{
                    submit(values: Record<string, string>): Promise<Record<string, unknown>>;
                }>;
                getModelApi(): { baseUrl: string; token: string } | null;
            };
        };
        let stored: unknown = null;
        const host = {
            secrets: {
                load: () => stored,
                save: (value: unknown) => {
                    stored = structuredClone(value);
                },
                clear: () => {
                    stored = null;
                }
            }
        };
        let createCredentialCalls = 0;
        const client = {
            token: null as string | null,
            setToken(token: string) {
                this.token = token;
            },
            auth: {
                login: async () => ({ access_token: 'login-token', token_type: 'Bearer' }),
                getMe: async () => ({ id: 'u-1', username: 'alice' })
            },
            relay: {
                getInfo: async () => ({ base_url: 'https://relay.example.com/v1', models: [] }),
                getCredential: async () => {
                    throw new Error('relay disabled');
                },
                createCredential: async () => {
                    createCredentialCalls += 1;
                    return { credential: 'sk-od-created', key: 'relay-key', token_type: 'Bearer' };
                }
            }
        };
        const backend = new module.OpenDeskAccountBackend(host, () => client);
        const flow = await backend.createLoginFlow({
            kind: 'personal',
            baseUrl: 'https://personal.example.com/api/v1',
            methodId: 'password'
        });
        const result = await flow.submit({ username: 'alice', password: 'secret' });

        expect(result.status).toBe('completed');
        expect(createCredentialCalls).toBe(0);
        expect(backend.getModelApi()).toBeNull();
        expect(stored).toMatchObject({ accessToken: 'login-token', modelApi: null });
    });
});
