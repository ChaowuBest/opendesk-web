import assert from 'node:assert/strict';
import test from 'node:test';
import {
    deriveRunToken,
    isRunToken,
    RUN_TOKEN_MAX_LENGTH
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-identifiers.js';

test('derives stable opaque bounded tokens from the PC session and generation', () => {
    assert.equal(deriveRunToken('s1', 7), 'rt1_Do5ydmKbAd9__DTqo7TMQB_9l-Jvs1N35aZau05ABNM');
    assert.equal(deriveRunToken('s1', 7), deriveRunToken('s1', 7));
    assert.notEqual(deriveRunToken('s1', 7), deriveRunToken('s1', 8));
    assert.notEqual(deriveRunToken('s1', 7), deriveRunToken('s2', 7));
    assert.equal(deriveRunToken('s1', 7).length, 47);
    assert.ok(deriveRunToken('s1', 7).length <= RUN_TOKEN_MAX_LENGTH);
    assert.equal(deriveRunToken('private/session/path', 9).includes('private'), false);
    assert.equal(deriveRunToken('private/session/path', 9).includes('/'), false);
});

test('accepts only the exact v1 wire format and rejects invalid inputs', () => {
    assert.equal(isRunToken(deriveRunToken('s1', 1)), true);
    for (const value of [
        undefined,
        null,
        '',
        '   ',
        'rt1_short',
        `rt1_${'a'.repeat(42)}`,
        `rt1_${'a'.repeat(44)}`,
        `rt2_${'a'.repeat(43)}`,
        `rt1_${'='.repeat(43)}`,
        'x'.repeat(RUN_TOKEN_MAX_LENGTH + 1)
    ]) {
        assert.equal(isRunToken(value), false);
    }
});

test('refuses invalid derivation inputs instead of normalizing them', () => {
    for (const [sessionId, generation] of [
        ['', 1],
        [' ', 1],
        ['s1', 0],
        ['s1', -1],
        ['s1', 1.5],
        ['s1', Number.MAX_SAFE_INTEGER + 1]
    ] as const) {
        assert.throws(() => deriveRunToken(sessionId, generation));
    }
});
