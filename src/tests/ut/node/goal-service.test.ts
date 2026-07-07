import test from 'node:test';
import assert from 'node:assert/strict';
import { GoalController } from '../../../main/aikernel/goal/controller.js';
import { GoalService } from '../../../main/aikernel/goal/service.js';
import { GoalStates, type GoalEventLogStorage } from '../../../main/aikernel/goal/state.js';
import type { StartInternalTurnOptions, TaskState } from '../../../main/aikernel/states/tasks.js';

function createBlockedGoalTask(): TaskState {
    const goal = GoalStates.create('task-1', { objective: 'old objective' });
    goal.status = 'blocked';
    goal.blockedReason = 'needs_user_input';

    const task = {
        task_id: 'task-1',
        task_status: 'stopped',
        goal_state: goal,
        goal_event_log: { mode: 'inline', events: [] } as GoalEventLogStorage,
        persisted: 0,
        startedTurns: [] as StartInternalTurnOptions[],
        chat_context: {
            messages: [],
            appendMessage(msg: unknown) {
                this.messages.push(msg);
            }
        },
        sendSubscriptionFeedback() {},
        task_manager_state: {
            publishTaskListUpdate() {}
        },
        persistLater() {
            this.persisted += 1;
        },
        async startInternalTurn(options: StartInternalTurnOptions) {
            this.startedTurns.push(options);
            this.task_status = 'running';
        }
    };

    return task as unknown as TaskState;
}

function createGoalTaskWithStatus(status: 'active' | 'paused' | 'complete' | 'cleared'): TaskState {
    const goal = GoalStates.create('task-1', { objective: 'test objective' });
    goal.status = status;
    if (status === 'complete') {
        goal.completedAt = new Date().toISOString();
    }
    if (status === 'cleared') {
        goal.clearedAt = new Date().toISOString();
    }

    const task = {
        task_id: 'task-1',
        task_status: 'stopped',
        goal_state: goal,
        goal_event_log: { mode: 'inline', events: [] } as GoalEventLogStorage,
        persisted: 0,
        startedTurns: [] as StartInternalTurnOptions[],
        chat_context: {
            messages: [],
            appendMessage(msg: unknown) {
                this.messages.push(msg);
            }
        },
        sendSubscriptionFeedback() {},
        task_manager_state: {
            publishTaskListUpdate() {}
        },
        persistLater() {
            this.persisted += 1;
        },
        async startInternalTurn(options: StartInternalTurnOptions) {
            this.startedTurns.push(options);
            this.task_status = 'running';
        }
    };

    return task as unknown as TaskState;
}

test('editing a blocked goal resumes scheduler execution with the new objective', async () => {
    const task = createBlockedGoalTask();

    const result = await GoalService.edit(task, 'new objective', 'tui');

    assert.equal(result.ok, true);
    assert.equal(result.startedScheduler, true);
    assert.equal(task.goal_state?.status, 'active');
    assert.equal(task.goal_state?.objective, 'new objective');
    assert.equal(task.goal_state?.blockedReason, undefined);
    assert.equal(task.task_status, 'running');
    assert.equal((task as unknown as { startedTurns: StartInternalTurnOptions[] }).startedTurns.length, 1);
    assert.equal(
        (task as unknown as { startedTurns: StartInternalTurnOptions[] }).startedTurns[0].source,
        'goal_resume'
    );
});

// ── maybeResumeGoalFromUserMessage: blocked goal ──────────────────────────────

test('blocked goal triggers resume_with_message for ordinary user messages', () => {
    const task = createBlockedGoalTask();

    const result = GoalController.maybeResumeGoalFromUserMessage(task, '这里是补充信息，请继续执行');

    assert.deepEqual(result, { action: 'resume_with_message', userMessage: '这里是补充信息，请继续执行' });
    // maybeResumeGoalFromUserMessage is a pure decision function, no side effects
    assert.equal(task.goal_state?.status, 'blocked');
});

test('blocked goal triggers resume_with_message for short resume-like messages', () => {
    const task = createBlockedGoalTask();

    const result = GoalController.maybeResumeGoalFromUserMessage(task, '继续');

    assert.deepEqual(result, { action: 'resume_with_message', userMessage: '继续' });
});

test('blocked goal with empty message does not auto-resume', () => {
    const task = createBlockedGoalTask();

    assert.deepEqual(GoalController.maybeResumeGoalFromUserMessage(task, ''), { action: 'none' });
    assert.deepEqual(GoalController.maybeResumeGoalFromUserMessage(task, '   '), { action: 'none' });
});

// ── maybeResumeGoalFromUserMessage: non-blocked goals ─────────────────────────

test('paused goal does not auto-resume from user message', () => {
    const task = createGoalTaskWithStatus('paused');

    const result = GoalController.maybeResumeGoalFromUserMessage(task, 'some user reply');

    assert.deepEqual(result, { action: 'none' });
});

test('active goal does not auto-resume from user message', () => {
    const task = createGoalTaskWithStatus('active');

    const result = GoalController.maybeResumeGoalFromUserMessage(task, 'some user reply');

    assert.deepEqual(result, { action: 'none' });
});

test('complete goal does not auto-resume from user message', () => {
    const task = createGoalTaskWithStatus('complete');

    const result = GoalController.maybeResumeGoalFromUserMessage(task, 'some user reply');

    assert.deepEqual(result, { action: 'none' });
});

test('no goal does not auto-resume', () => {
    const task = {
        task_id: 'task-1',
        task_status: 'stopped',
        goal_state: undefined,
        goal_event_log: undefined
    } as unknown as TaskState;

    const result = GoalController.maybeResumeGoalFromUserMessage(task, 'some user reply');

    assert.deepEqual(result, { action: 'none' });
});

// ── GoalService.resumeWithUserMessage ─────────────────────────────────────────

test('resumeWithUserMessage transitions blocked goal to active and starts scheduler', async () => {
    const task = createBlockedGoalTask();

    const result = await GoalService.resumeWithUserMessage(task, '用户回复内容', 'user_message');

    assert.equal(result.ok, true);
    assert.equal(result.startedScheduler, true);
    assert.equal(task.goal_state?.status, 'active');
    assert.equal(task.goal_state?.blockedReason, undefined);
    assert.equal(task.task_status, 'running');
    const startedTurns = (task as unknown as { startedTurns: StartInternalTurnOptions[] }).startedTurns;
    assert.equal(startedTurns.length, 1);
    assert.equal(startedTurns[0].source, 'goal_resume');
    // promptOverride should contain the user message
    assert.ok(startedTurns[0].prompt.includes('用户回复内容'), 'prompt should contain user message');
    // promptOverride should contain the goal objective
    assert.ok(startedTurns[0].prompt.includes('old objective'), 'prompt should contain goal objective');
});

test('resumeWithUserMessage returns not_applicable for non-blocked goal', async () => {
    const task = createGoalTaskWithStatus('active');

    const result = await GoalService.resumeWithUserMessage(task, 'some message', 'user_message');

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'not_applicable');
});

test('resumeWithUserMessage returns not_applicable when no goal exists', async () => {
    const task = {
        task_id: 'task-1',
        task_status: 'stopped',
        goal_state: undefined,
        goal_event_log: undefined
    } as unknown as TaskState;

    const result = await GoalService.resumeWithUserMessage(task, 'some message', 'user_message');

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'not_applicable');
});
