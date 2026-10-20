import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createPublicSessionIdentifierPlan,
    uuidV5,
    type PublicSessionIdentifierCandidate
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-identifiers.js';

const V = '550e8400-e29b-41d4-a716-446655440000';

test('locks UUID namespace, tuple encoding, reuse and duplicate fallback', () => {
    assert.equal(uuidV5(JSON.stringify(['message', 's1', 0])), 'f2680a64-b743-51ee-aa05-d52a2521b016');
    const candidates: PublicSessionIdentifierCandidate[] = [
        {
            sourceMessageIndex: 0,
            sourceMessageId: V,
            toolCalls: [{ partIndex: 0, callIndex: 0, sourceToolCallId: 'tool' }]
        },
        {
            sourceMessageIndex: 1,
            sourceMessageId: 'duplicate',
            toolCalls: [{ partIndex: 0, callIndex: 0, sourceToolCallId: 'tool' }]
        },
        { sourceMessageIndex: 2, sourceMessageId: 'duplicate', toolCalls: [] }
    ];
    const first = createPublicSessionIdentifierPlan('s1', candidates);
    const second = createPublicSessionIdentifierPlan('s1', candidates);
    assert.equal(first.messageId(0), V);
    assert.match(first.messageId(1), /^[0-9a-f-]{36}$/);
    assert.notEqual(first.messageId(1), first.messageId(2));
    assert.notEqual(first.toolCallId(0, 0, 0), 'tool');
    assert.equal(first.messageId(1), second.messageId(1));
    assert.notEqual(first.messageId(1), createPublicSessionIdentifierPlan('other', candidates).messageId(1));
});

test('exposes explicit live identity lookup and atomically rebinds replacement tools', () => {
    const plan = createPublicSessionIdentifierPlan('s1', [
        {
            sourceMessageIndex: 0,
            sourceMessageId: V,
            toolCalls: [
                { partIndex: 0, callIndex: 0, sourceToolCallId: 'tool-a' },
                { partIndex: 1, callIndex: 0, sourceToolCallId: 'tool-b' }
            ]
        }
    ]);
    assert.equal(plan.hasMessage(0), true);
    assert.equal(plan.hasMessage(1), false);
    assert.equal(plan.hasToolCall(0, 1, 0), true);
    assert.deepEqual(
        plan.rebindMessageToolCalls(0, [
            { partIndex: 0, callIndex: 0, sourceToolCallId: 'tool-b' },
            { partIndex: 0, callIndex: 1, sourceToolCallId: 'tool-new' }
        ]),
        [
            { partIndex: 0, callIndex: 0, toolCallId: 'tool-b' },
            { partIndex: 0, callIndex: 1, toolCallId: 'tool-new' }
        ]
    );
    assert.equal(plan.toolCallId(0, 0, 0), 'tool-b');
    assert.equal(plan.hasToolCall(0, 1, 0), false);
    assert.throws(() => plan.toolCallId(0, 1, 0));
    assert.equal(
        plan.registerMessage({ sourceMessageIndex: 2, sourceMessageId: 'bad', toolCalls: [] }),
        uuidV5(JSON.stringify(['message', 's1', 2]))
    );
    assert.throws(() => plan.registerMessage({ sourceMessageIndex: 1, sourceMessageId: 'late', toolCalls: [] }));
    assert.throws(() => plan.registerToolCall(0, 1, 0, 'tool-new'));
});
