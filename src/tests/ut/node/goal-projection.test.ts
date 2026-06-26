import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGoalContextProjection } from '../../../main/aikernel/goal/projection.js';
import {
    AssistantMessage,
    ChatContext,
    CompactSeparatorMessage,
    UserMessage
} from '../../../main/aikernel/messages.js';
import { GoalStates } from '../../../main/aikernel/goal/state.js';
import type { TaskState } from '../../../main/aikernel/states/tasks.js';

function makeTask(chatContext: ChatContext): TaskState {
    return {
        goal_state: {
            id: 'goal-current',
            status: 'active'
        },
        chat_context: chatContext
    } as unknown as TaskState;
}

test('goal projection keeps full transcript and goal-scoped history from any goal', () => {
    const context = new ChatContext();
    const currentGoalMessage = new UserMessage('current goal work');
    currentGoalMessage.metadata = {
        scope: 'goal',
        execution: { controller: 'goal', controllerId: 'goal-current' }
    };
    const previousGoalMessage = new AssistantMessage();
    previousGoalMessage.metadata = {
        scope: 'goal',
        execution: { controller: 'goal', controllerId: 'goal-previous' }
    };
    const sideMessage = new UserMessage('paused side chat');
    sideMessage.metadata = { scope: 'global' };
    const globalMessage = new UserMessage('global context');
    globalMessage.metadata = { scope: 'global' };
    context.messages = [currentGoalMessage, previousGoalMessage, sideMessage, globalMessage];

    const projected = buildGoalContextProjection(makeTask(context));

    assert.deepEqual(projected.messages, [currentGoalMessage, previousGoalMessage, sideMessage, globalMessage]);
});

test('goal projection keeps compact summary boundaries', () => {
    const context = new ChatContext();
    const segmentedBoundary = new CompactSeparatorMessage('full summary', {
        summarySegments: [
            { scope: 'goal', goalId: 'goal-current', text: 'current goal summary' },
            { scope: 'goal', goalId: 'goal-previous', text: 'previous goal summary' },
            { scope: 'global', text: 'global summary' }
        ]
    });
    const oldGoalBoundary = new CompactSeparatorMessage('old goal boundary', {
        projection: {
            projectionPolicy: 'goal_only',
            summarizedScopes: ['goal'],
            summarizedGoalIds: ['goal-previous']
        }
    });
    context.messages = [segmentedBoundary, oldGoalBoundary];

    const projected = buildGoalContextProjection(makeTask(context));

    assert.equal(projected.messages.length, 2);
    assert.equal(projected.messages[0], segmentedBoundary);
    assert.equal(projected.messages[1], oldGoalBoundary);
});

test('goal render summary exposes only safe recent event metadata', () => {
    const goal = GoalStates.create('task-1', { objective: 'finish the task' });
    const summary = GoalStates.renderSummary(goal, {
        mode: 'inline',
        events: [
            {
                id: 'event-1',
                goalId: goal.id,
                taskId: 'task-1',
                type: 'evaluated',
                revision: 1,
                timestamp: '2026-06-25T00:00:00.000Z',
                source: 'evaluator',
                payload: { rawEvidence: 'hidden' }
            }
        ]
    });

    assert.ok(summary);
    assert.deepEqual(summary.recentEvents, [
        {
            type: 'evaluated',
            revision: 1,
            timestamp: '2026-06-25T00:00:00.000Z',
            source: 'evaluator'
        }
    ]);
    // rawEvidence 等内部字段不应泄露到 summary
    assert.equal(JSON.stringify(summary).includes('rawEvidence'), false);
});

test('goal render summary exposes objective field for created/edited events', () => {
    const goal = GoalStates.create('task-1', { objective: 'finish the task' });
    const summary = GoalStates.renderSummary(goal, {
        mode: 'inline',
        events: [
            {
                id: 'event-1',
                goalId: goal.id,
                taskId: 'task-1',
                type: 'created',
                revision: 1,
                timestamp: '2026-06-25T00:00:00.000Z',
                source: 'api',
                payload: { objective: 'finish the task' }
            },
            {
                id: 'event-2',
                goalId: goal.id,
                taskId: 'task-1',
                type: 'edited',
                revision: 2,
                timestamp: '2026-06-25T00:01:00.000Z',
                source: 'gui',
                payload: { previousObjective: 'finish the task', objective: 'finish it faster' }
            }
        ]
    });

    assert.ok(summary);
    assert.equal(summary.recentEvents?.length, 2);
    assert.equal(summary.recentEvents?.[0].objective, 'finish the task');
    assert.equal(summary.recentEvents?.[0].previousObjective, undefined);
    assert.equal(summary.recentEvents?.[1].objective, 'finish it faster');
    assert.equal(summary.recentEvents?.[1].previousObjective, 'finish the task');
    // 非白名单字段仍然不应泄露
    assert.equal(JSON.stringify(summary).includes('rawEvidence'), false);
});
