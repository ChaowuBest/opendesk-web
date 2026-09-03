import assert from 'node:assert/strict';
import test from 'node:test';
import { registerAccountAPIHandlers } from '../../../../main/applications/account/ipc.js';
import type { AccountRuntime } from '../../../../main/applications/account/runtime.js';

test('account IPC delegates configuration and session events without Electron dependencies', async () => {
    const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>();
    const published: unknown[] = [];
    const session = {
        kind: 'personal' as const,
        baseUrl: 'https://personal.example.com/api/v1',
        accessToken: 'token',
        tokenType: 'Bearer',
        user: { id: 'u-1', username: 'alice' }
    };
    const configured: unknown[] = [];
    const runtime = {
        config: {
            get: () => ({ mode: 'nologin', default_base_url: session.baseUrl, enterprise_base_url: '' }),
            configure: (patch: unknown) => {
                configured.push(patch);
                return patch;
            },
            isSetupComplete: () => false,
            isAvailable: () => true
        },
        getService: () => ({
            getSession: () => null,
            getUserInfo: async () => null,
            login: async () => session,
            updateDisplayName: async () => session.user,
            refreshToken: async () => session,
            logout: async () => undefined
        })
    } as unknown as AccountRuntime;

    registerAccountAPIHandlers({
        ipc: {
            handle(channel, handler) {
                handlers.set(channel, handler);
            }
        },
        runtime,
        publishSessionChanged(value) {
            published.push(value);
        }
    });

    assert.deepEqual(await handlers.get('account:configure')?.({}, { mode: 'personal' }), {
        status: 'ok',
        data: { mode: 'personal' }
    });
    assert.deepEqual(configured, [{ mode: 'personal' }]);

    assert.deepEqual(await handlers.get('account:login')?.({}, 'personal', 'alice', 'secret'), {
        status: 'ok',
        data: session
    });
    assert.deepEqual(published, [session]);
});
