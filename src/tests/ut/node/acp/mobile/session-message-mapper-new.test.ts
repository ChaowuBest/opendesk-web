import assert from 'node:assert/strict';
import test from 'node:test';
import * as acp from '@agentclientprotocol/sdk';
import { assertNewSessionParams } from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/session-message-mapper.js';

test('new wire decoder preserves every string cwd for the RSS policy owner', () => {
    for (const cwd of ['/absolute/path', ' relative ', '   ', ' /with spaces ']) {
        assert.doesNotThrow(() => assertNewSessionParams({ cwd, mcpServers: [] }));
    }
});

test('new wire decoder rejects unsupported wire fields before RSS', () => {
    for (const params of [
        { cwd: 1, mcpServers: [] },
        { cwd: '/work', mcpServers: [{}] },
        { cwd: '/work', mcpServers: [], additionalDirectories: ['/extra'] }
    ]) {
        assert.throws(
            () => assertNewSessionParams(params as never),
            (error: unknown) => error instanceof acp.RequestError && error.code === -32602
        );
    }
});

test('new wire decoder allows omitted or empty additional directories', () => {
    assert.doesNotThrow(() => assertNewSessionParams({ cwd: '/work', mcpServers: [] }));
    assert.doesNotThrow(() => assertNewSessionParams({ cwd: '/work', mcpServers: [], additionalDirectories: [] }));
});
