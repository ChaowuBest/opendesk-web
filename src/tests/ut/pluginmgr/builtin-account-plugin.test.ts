import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
});
