import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountRuntime } from '../../../../main/applications/account/runtime.js';

test('account runtime initializes its shared service once', () => {
    let initCalls = 0;
    const service = {
        init() {
            initCalls++;
        }
    };
    const runtime = new AccountRuntime(service as never, {} as never);

    assert.equal(runtime.getService(), service);
    assert.equal(runtime.getService(), service);
    assert.equal(initCalls, 1);
});
