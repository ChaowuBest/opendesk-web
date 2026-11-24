import assert from 'node:assert/strict';
import test from 'node:test';
import * as acp from '@agentclientprotocol/sdk';
import { parseOpenDeskCancelProfile } from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/session-message-mapper.js';
import { sessionStopVectors } from './session-stop-vectors.js';

test('locks the stop cancel profile and rejects every downgrade', () => {
    assert.deepEqual(parseOpenDeskCancelProfile(sessionStopVectors.cancel), {
        sessionId: 's1',
        runToken: sessionStopVectors.cancel._meta.opendesk.runToken
    });
    for (const value of [
        { sessionId: 's1' },
        { sessionId: 's1', _meta: {} },
        { sessionId: 's1', _meta: { opendesk: { schemaVersion: 1 } } },
        { sessionId: 's1', _meta: { opendesk: { schemaVersion: 1, runToken: '' } } },
        {
            sessionId: '   ',
            _meta: { opendesk: { schemaVersion: 1, runToken: sessionStopVectors.cancel._meta.opendesk.runToken } }
        },
        {
            sessionId: 's1',
            _meta: { opendesk: { schemaVersion: 2, runToken: sessionStopVectors.cancel._meta.opendesk.runToken } }
        },
        { sessionId: 's1', _meta: { opendesk: { schemaVersion: 1, runToken: 'x'.repeat(65) } } },
        {
            sessionId: 's1',
            _meta: {
                opendesk: { schemaVersion: 1, runToken: sessionStopVectors.cancel._meta.opendesk.runToken, extra: true }
            }
        }
    ]) {
        assert.throws(() => parseOpenDeskCancelProfile(value as acp.CancelNotification));
    }
});
