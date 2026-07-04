import test from 'node:test';
import assert from 'node:assert/strict';
import { GoalEvents, GoalStates } from '../../../main/aikernel/goal/state.js';

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

test('goal event deserialization normalizes unknown event types', () => {
    const events = GoalEvents.deserializeEvents([
        {
            id: 'event-unknown',
            goalId: 'goal-1',
            taskId: 'task-1',
            type: 'not_a_real_goal_event',
            revision: 3,
            timestamp: '2026-06-25T00:00:00.000Z',
            source: 'api'
        }
    ]);

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'created');
    assert.equal(events[0].source, 'api');
});
