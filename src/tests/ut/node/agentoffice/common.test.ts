import test from 'node:test';
import assert from 'node:assert/strict';
import {
    generateStaffServiceToken,
    normalizeStaffLocalService,
    STAFF_SERVICE_TOKEN_LENGTH,
    unwrapAgentOfficeCallResult
} from '../../../../main/applications/agentoffice/common.js';

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

test('local service config normalization fills token and privacy defaults', () => {
    assert.deepEqual(normalizeStaffLocalService(undefined), {
        enabled: false,
        host: '127.0.0.1',
        port: 9050,
        https: false,
        allow_iframe_embedding: false,
        user_token: '',
        manage_token: '',
        hide_staff_info: false
    });
    const config = normalizeStaffLocalService({
        enabled: true,
        host: '192.168.1.8',
        port: 9051,
        https: true,
        allow_iframe_embedding: true,
        user_token: ' user-token ',
        manage_token: 'manage-token',
        hide_staff_info: true
    });
    assert.equal(config.user_token, 'user-token');
    assert.equal(config.manage_token, 'manage-token');
    assert.equal(config.https, true);
    assert.equal(config.allow_iframe_embedding, true);
    assert.equal(config.hide_staff_info, true);
});

test('service token generator produces 16-character alphanumeric tokens', () => {
    for (let i = 0; i < 50; i++) {
        const token = generateStaffServiceToken();
        assert.equal(token.length, STAFF_SERVICE_TOKEN_LENGTH);
        assert.match(token, /^[a-zA-Z0-9]+$/);
    }
    assert.notEqual(generateStaffServiceToken(), generateStaffServiceToken());
    assert.equal(generateStaffServiceToken(8).length, 8);
});
