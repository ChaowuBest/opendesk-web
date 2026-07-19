import test from 'node:test';
import assert from 'node:assert/strict';
import { unwrapAgentOfficeCallResult } from '../../../../main/applications/agentoffice/common.js';

test('worker result unwrapping returns data and preserves plain values', () => {
    assert.deepEqual(unwrapAgentOfficeCallResult({ status: 'ok', data: ['Ada'] }, 'failed'), ['Ada']);
    assert.deepEqual(unwrapAgentOfficeCallResult({ name: 'Ada' }, 'failed'), { name: 'Ada' });
});

test('worker result unwrapping surfaces worker and fallback errors', () => {
    assert.throws(() => unwrapAgentOfficeCallResult({ status: 'error', message: 'worker failed' }, 'failed'), {
        message: 'worker failed'
    });
    assert.throws(() => unwrapAgentOfficeCallResult({ status: 'error' }, 'fallback failed'), {
        message: 'fallback failed'
    });
});
