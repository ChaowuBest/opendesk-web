import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getGoalSupplementIds,
    getGoalSupplementDisplayText,
    shouldRenderGoalUserMessage as shouldRenderTuiUserMessage
} from '../../../../common/goal/user-message-display.js';

test('TUI goal supplement display uses user-facing rawText', () => {
    const message = {
        rawText: 'visible supplement',
        metadata: {
            scope: 'goal',
            origin: { source: 'internal', reason: 'goal_supplement' }
        },
        internal: true
    } as const;

    assert.equal(getGoalSupplementDisplayText(message), 'visible supplement');
    assert.equal(shouldRenderTuiUserMessage(message), true);
    assert.deepEqual(
        getGoalSupplementIds({
            ...message,
            metadata: {
                ...message.metadata,
                execution: { supplementIds: ['supp-1', 'supp-2'] }
            }
        }),
        ['supp-1', 'supp-2']
    );
});

test('TUI keeps ordinary internal user messages hidden outside debug rendering', () => {
    assert.equal(shouldRenderTuiUserMessage({ internal: true }), false);
    assert.equal(shouldRenderTuiUserMessage({ internal: false }), true);
    assert.equal(shouldRenderTuiUserMessage({}), true);
});

test('goal supplement helpers only expose whitelisted user-facing rawText', () => {
    assert.equal(getGoalSupplementDisplayText({ internal: true, rawText: '  supplement text  ' }), undefined);
    assert.equal(
        getGoalSupplementDisplayText({
            internal: true,
            rawText: '  blocked resume reply  ',
            metadata: { origin: { source: 'scheduler', reason: 'goal_blocked_resume_display' } }
        }),
        'blocked resume reply'
    );
    assert.equal(
        getGoalSupplementDisplayText({
            internal: true,
            rawText: '<system-reminder>hidden</system-reminder>',
            metadata: { origin: { source: 'internal', reason: 'goal_edit' } }
        }),
        undefined
    );
    assert.equal(getGoalSupplementDisplayText({ internal: false, rawText: 'visible' }), undefined);
    assert.deepEqual(
        getGoalSupplementIds({
            internal: true,
            metadata: {
                origin: { source: 'internal', reason: 'goal_supplement' },
                execution: { supplementIds: ['valid', '', 1 as unknown as string] }
            }
        }),
        ['valid']
    );
});
