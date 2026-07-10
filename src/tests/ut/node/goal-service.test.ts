import test from 'node:test';
import assert from 'node:assert/strict';
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
