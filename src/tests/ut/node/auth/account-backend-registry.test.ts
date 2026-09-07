import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginAccountBackend } from '../../../../../packages/plugin-sdk/src/index.js';
import { AccountBackendRegistry } from '../../../../main/applications/account/backend-registry.js';

function backend(id: string, kinds: Array<'personal' | 'enterprise'>): PluginAccountBackend {
    return {
        id,
        kinds,
        initialize() {},
        getSession: () => null,
        getUserInfo: async () => null,
        getLoginMethods: async () => [],
        createLoginFlow: async () => ({
            getState: () => ({ status: 'ready' }),
            cancel: async () => undefined
        }),
        updateDisplayName: async () => {
            throw new Error('not used');
        },
        refreshToken: async () => {
            throw new Error('not used');
        },
        logout: async () => undefined
    };
}

test('resolves a backend for personal and enterprise accounts', () => {
    const registry = new AccountBackendRegistry();
    registry.register('plugin', backend('opendesk', ['personal', 'enterprise']));

    assert.equal(registry.resolve('personal')?.id, 'opendesk');
    assert.equal(registry.resolve('enterprise')?.id, 'opendesk');
});

test('disposing a backend registration removes it', () => {
    const registry = new AccountBackendRegistry();
    const dispose = registry.register('plugin', backend('opendesk', ['personal', 'enterprise']));

    dispose();

    assert.equal(registry.get('opendesk'), undefined);
});

test('rejects invalid backend ids and kinds with the unified error prefix', () => {
    const registry = new AccountBackendRegistry();

    assert.throws(() => registry.register('plugin', backend('bad id', ['personal'])), {
        message: 'account:backend_invalid_id:bad id'
    });
    assert.throws(() => registry.register('plugin', backend('valid', [])), {
        message: 'account:backend_invalid_kinds:valid'
    });
});

test('the sole backend answers kind-less and typed resolution', () => {
    const registry = new AccountBackendRegistry();
    registry.register('builtin', backend('opendesk', ['personal', 'enterprise']));

    assert.equal(registry.getDefault()?.id, 'opendesk');
    assert.equal(registry.resolve('personal')?.id, 'opendesk');
    assert.equal(registry.resolve('enterprise')?.id, 'opendesk');
});

test('a second backend registration is rejected', () => {
    const registry = new AccountBackendRegistry();
    registry.register('first', backend('a', ['personal']));

    assert.throws(() => registry.register('second', backend('b', ['personal'])), {
        message: 'account:backend_already_registered:a'
    });
    assert.equal(registry.getDefault()?.id, 'a');
});

test('disposing the backend clears all resolution paths', () => {
    const registry = new AccountBackendRegistry();
    const dispose = registry.register('builtin', backend('opendesk', ['personal', 'enterprise']));

    dispose();

    assert.equal(registry.getDefault(), undefined);
    assert.equal(registry.resolve('personal'), undefined);
});

test('backendsChanged listeners observe registration and disposal', () => {
    const registry = new AccountBackendRegistry();
    const events: string[] = [];
    registry.onBackendsChanged(() => events.push('changed'));

    const dispose = registry.register('plugin', backend('opendesk', ['personal']));
    assert.deepEqual(events, ['changed']);

    dispose();
    assert.deepEqual(events, ['changed', 'changed']);
});

test('listener failures do not break backend registration', () => {
    const registry = new AccountBackendRegistry();
    registry.onBackendsChanged(() => {
        throw new Error('listener boom');
    });

    const dispose = registry.register('plugin', backend('opendesk', ['personal']));
    assert.equal(registry.get('opendesk')?.id, 'opendesk');
    dispose();
    assert.equal(registry.get('opendesk'), undefined);
});
