import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
    parseNetworkFrame,
    parseDataDescription,
    validateTurn,
    equalTicket,
    remoteNetworkWsUrl,
    captureTurn,
    selectTurn
} from '../../../../main/applications/mobileaccess/remote-access/network-protocol.js';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/remote-network-v1.json', import.meta.url), 'utf8'));

test('wire v1 fixture and strict extra fields match the server authority', () => {
    for (const { initial, value } of fixture.invalid_frames) assert.throws(() => parseNetworkFrame(value, initial));
    for (const { initial, value } of fixture.frames) {
        assert.deepEqual(parseNetworkFrame(value, initial), value);
        assert.throws(() => parseNetworkFrame({ ...value, unexpected: 1 }, initial));
        assert.throws(() => parseNetworkFrame({ ...value, payload: { ...value.payload, unexpected: 1 } }, initial));
    }
});

test('same bytes bind fingerprint case variants and reject unsupported descriptions', () => {
    const valid = fixture.sdp.valid.map((sdp: string) => parseDataDescription(sdp));
    assert.deepEqual(valid[0].digest, valid[1].digest);
    assert.equal(valid[0].mid, 'data');
    assert.equal(valid[0].ufrag, 'abcd');
    for (const sdp of fixture.sdp.invalid) assert.throws(() => parseDataDescription(sdp));
});

test('TURN uses the same strict union as the server', () => {
    for (const turn of fixture.turn.valid) assert.deepEqual(validateTurn(turn), turn);
    for (const turn of fixture.turn.invalid) assert.throws(() => validateTurn(turn));
});

test('Ticket comparison checks canonical 32 bytes before constant-time equality', () => {
    const secret = fixture.ticket.secret;
    assert.equal(equalTicket(secret, secret), true);
    assert.equal(equalTicket(secret, secret + '='), false);
    assert.equal(equalTicket(secret, secret.slice(0, -1) + '9'), false);
    assert.equal(equalTicket(secret, 'A'.repeat(43)), false);
});

test('plaintext signaling requires an explicit loopback-only opt-in', () => {
    assert.equal(remoteNetworkWsUrl('https://desk.example/api/v1'), 'wss://desk.example/api/v1/remote-network/ws');
    assert.throws(() => remoteNetworkWsUrl('http://127.0.0.1:8000/api/v1'));
    assert.equal(
        remoteNetworkWsUrl('http://127.0.0.1:8000/api/v1', true),
        'ws://127.0.0.1:8000/api/v1/remote-network/ws'
    );
    assert.throws(() => remoteNetworkWsUrl('http://desk.example/api/v1', true));
});

test('TURN lifetime is captured once and processing time never extends it', () => {
    const available = fixture.turn.valid.find((turn: { status: string }) => turn.status === 'available');
    const captured = captureTurn({ ...available, expires_at: 1100, valid_for_ms: 60000 }, 100, 1000000);
    assert.equal(selectTurn(captured, 100, 60000).iceServers.length, 1);
    assert.equal(selectTurn(captured, 10100, 55000).reason, 'insufficient_lifetime');
    assert.equal(selectTurn(captured, 60100, 1).reason, 'expired');
});
