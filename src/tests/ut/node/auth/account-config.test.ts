import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountConfigController, type AccountConfigRepository } from '../../../../main/applications/account/config.js';

function createRepository(): AccountConfigRepository & { writes: number } {
    let config = {
        mode: 'nologin' as const,
        default_base_url: 'https://personal.example.com/api/v1',
        enterprise_base_url: ''
    };
    return {
        writes: 0,
        get() {
            return { ...config };
        },
        update(patch) {
            this.writes++;
            config = { ...config, ...patch };
            return { ...config };
        }
    };
}

test('account config updates only the account-owned configuration slice', () => {
    const repository = createRepository();
    const controller = new AccountConfigController(repository);

    const updated = controller.configure({
        mode: 'enterprise',
        enterprise_base_url: 'https://enterprise.example.com/api/v1'
    });

    assert.equal(repository.writes, 1);
    assert.deepEqual(updated, {
        mode: 'enterprise',
        default_base_url: 'https://personal.example.com/api/v1',
        enterprise_base_url: 'https://enterprise.example.com/api/v1'
    });
});

test('account config owns account setup completion semantics', () => {
    const repository = createRepository();
    const controller = new AccountConfigController(repository);

    assert.equal(controller.isSetupComplete(), false);
    controller.configure({ mode: 'personal' });
    assert.equal(controller.isSetupComplete(), true);
    controller.configure({ mode: 'nologin' });
    assert.equal(controller.isSetupComplete(), false);
});
