import assert from 'node:assert/strict';
import test from 'node:test';
import { registerAccountAPIHandlers } from '../../../../main/applications/account/ipc.js';
import type { AccountRuntime } from '../../../../main/applications/account/runtime.js';

test('account IPC delegates configuration and session events without Electron dependencies', async () => {
    const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>();
    const published: unknown[] = [];
    const session = {
        backendId: 'opendesk',
        kind: 'personal' as const,
        baseUrl: 'https://personal.example.com/api/v1',
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
            getLoginMethods: async () => [{ id: 'password', type: 'form', displayName: 'Password', fields: [] }],
            startLogin: async () => ({ flowId: 'flow-1', state: { status: 'ready' } }),
            submitLogin: async () => ({ status: 'completed', session }),
            pollLogin: async () => ({ status: 'waiting' }),
            cancelLogin: async () => undefined,
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

    assert.deepEqual(await handlers.get('account:getLoginMethods')?.({}, 'personal'), {
        status: 'ok',
        data: [{ id: 'password', type: 'form', displayName: 'Password', fields: [] }]
    });
    assert.deepEqual(await handlers.get('account:startLogin')?.({}, 'personal', 'password'), {
        status: 'ok',
        data: { flowId: 'flow-1', state: { status: 'ready' } }
    });
    assert.deepEqual(
        await handlers.get('account:submitLogin')?.({}, 'flow-1', { username: 'alice', password: 'secret' }),
        {
            status: 'ok',
            data: { status: 'completed', session }
        }
    );
    assert.deepEqual(published, [session]);
});

test('account IPC returns a uniform error shape instead of rejecting when the backend is missing', async () => {
    const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>();
    // 账号后端（插件）尚未注册：启动窗口期内所有 handler 都必须返回 {status:'error'}
    const runtime = {
        config: {
            get: () => ({ mode: 'personal', default_base_url: '', enterprise_base_url: '' }),
            configure: () => ({}),
            isSetupComplete: () => false,
            isAvailable: () => false
        },
        getService: () => ({
            getSession: () => {
                throw new Error('account:backend_unavailable');
            },
            getUserInfo: async () => {
                throw new Error('account:backend_unavailable');
            },
            getLoginMethods: async () => {
                throw new Error('account:backend_unavailable:personal');
            }
        })
    } as unknown as AccountRuntime;

    registerAccountAPIHandlers({
        ipc: {
            handle(channel, handler) {
                handlers.set(channel, handler);
            }
        },
        runtime,
        publishSessionChanged() {}
    });

    assert.deepEqual(await handlers.get('account:getSession')?.({}), {
        status: 'error',
        message: 'account:backend_unavailable'
    });
    assert.deepEqual(await handlers.get('account:getUserInfo')?.({}), {
        status: 'error',
        message: 'account:backend_unavailable'
    });
    assert.deepEqual(await handlers.get('account:getLoginMethods')?.({}, 'personal'), {
        status: 'error',
        message: 'account:backend_unavailable:personal'
    });
});
