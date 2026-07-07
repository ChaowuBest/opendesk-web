import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getGoalSupplementDisplayText,
    isGoalSupplementRawTextConsumed,
    shouldRenderTuiUserMessage
} from '../../../../main/tui/utils/user-message-display.js';

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
            rawText: '<system-reminder>hidden</system-reminder>',
            metadata: { origin: { source: 'internal', reason: 'goal_edit' } }
        }),
        undefined
    );
    assert.equal(getGoalSupplementDisplayText({ internal: false, rawText: 'visible' }), undefined);
    assert.equal(isGoalSupplementRawTextConsumed('first\n\nsecond', 'first'), true);
    assert.equal(isGoalSupplementRawTextConsumed('first\n\nsecond', 'missing'), false);
});
