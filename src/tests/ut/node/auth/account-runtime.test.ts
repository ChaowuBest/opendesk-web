import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginAccountBackend } from '../../../../../packages/plugin-sdk/src/index.js';
import { AccountService } from '../../../../main/applications/account/service.js';
import { AccountRuntime } from '../../../../main/applications/account/runtime.js';

function backend(id: string): PluginAccountBackend & { initializeCalls: number } {
    const session = {
        backendId: id,
        kind: 'personal' as const,
        baseUrl: 'https://personal.example.com/api/v1',
        user: { id: 'u-1', username: 'alice' }
    };
    return {
        id,
        kinds: ['personal', 'enterprise'],
        initializeCalls: 0,
        initialize() {
            this.initializeCalls++;
        },
        getSession: () => session,
        getUserInfo: async () => session.user,
        getLoginMethods: async () => [],
        createLoginFlow: async () => ({
            getState: () => ({ status: 'ready' }),
            cancel: async () => undefined
        }),
        updateDisplayName: async () => session.user,
        refreshToken: async () => session,
        logout: async () => undefined
    };
}

test('getService returns the shared service and initializes the backend once', () => {
    const serviceBackend = backend('opendesk');
    const available = true;
    const service = new AccountService({
        getBaseUrl: () => '',
        getBackend: () => (available ? serviceBackend : undefined)
    });
    const runtime = new AccountRuntime(service, {} as never);

    assert.equal(runtime.getService(), service);
    assert.equal(runtime.getService(), service);
    assert.equal(serviceBackend.initializeCalls, 1);
});

test('account runtime retries initialization until the backend becomes available', () => {
    const serviceBackend = backend('opendesk');
    let available = false;
    const service = new AccountService({
        getBaseUrl: () => '',
        getBackend: () => (available ? serviceBackend : undefined)
    });
    const runtime = new AccountRuntime(service, {} as never);

    runtime.getService();
    runtime.getService();
    available = true;
    runtime.getService();

    assert.equal(serviceBackend.initializeCalls, 1);
});
