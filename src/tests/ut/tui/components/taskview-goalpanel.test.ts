import { jest } from '@jest/globals';
import { GoalStates, type GoalFinalSnapshot, type GoalState } from '../../../../main/aikernel/goal/state';
import { AssistantMessage, TextMessagePart, UserMessage } from '../../../../main/aikernel/messages';
import { TaskView } from '../../../../main/tui/components/taskview';
import { setRuntimeLocale } from '../../../../locale/index';

function stripAnsi(value: string): string {
    return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function createCompletedGoal(): GoalState {
    const goal = GoalStates.create('task-1', { objective: 'ship fix' });
    goal.createdAt = '2026-01-01T00:00:00.000Z';
    goal.status = 'complete';
    goal.completedAt = '2026-01-01T00:00:05.000Z';
    return goal;
}

function createFinalSnapshot(goal: GoalState): GoalFinalSnapshot {
    return {
        id: `goal-final:${goal.id}`,
        taskId: goal.taskId,
        goalId: goal.id,
        goalRevision: goal.revision,
        objective: goal.objective,
        status: 'complete',
        totalTokens: 0,
        elapsedMs: 5_000,
        createdAt: goal.createdAt,
        finalizedAt: goal.completedAt!,
        completedAt: goal.completedAt
    };
}

describe('TaskView goal panel history placement', () => {
    beforeEach(() => {
        setRuntimeLocale('en-US');
    });

    afterEach(() => {
        setRuntimeLocale(null);
    });

    test('keeps a terminal goal snapshot above subsequently appended user messages', async () => {
        const goal = createCompletedGoal();
        const taskView = new TaskView({ requestRender: jest.fn() } as any);

        taskView.syncGoalPanel({ goalState: goal, totalTokens: 0, elapsedMs: 5_000 });
        await taskView.handleChunkUpdate({
            type: 'user',
            task_id: 'task-1',
            message_id: 'message-after-goal',
            last_part_index: 0,
            last_part: new TextMessagePart('message after goal')
        });

        const output = stripAnsi(taskView.render(120).join('\n'));
        const goalIndex = output.indexOf('Follow-up Goal');
        const userIndex = output.indexOf('message after goal');

        expect(goalIndex).toBeGreaterThanOrEqual(0);
        expect(userIndex).toBeGreaterThanOrEqual(0);
        expect(goalIndex).toBeLessThan(userIndex);
    });

    test('keeps an active goal panel below newly appended messages', async () => {
        const goal = createCompletedGoal();
        goal.status = 'active';
        delete goal.completedAt;
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.taskState = {
            task_id: 'task-1',
            goal_state: goal,
            chat_context: { messages: [] }
        } as any;

        taskView.syncGoalPanel({ goalState: goal, totalTokens: 0, elapsedMs: 1_000 });
        await taskView.handleChunkUpdate({
            type: 'user',
            task_id: 'task-1',
            message_id: 'message-during-goal',
            last_part_index: 0,
            last_part: new TextMessagePart('message during goal')
        });

        const output = stripAnsi(taskView.render(120).join('\n'));
        expect(output.indexOf('message during goal')).toBeLessThan(output.indexOf('Follow-up Goal'));
    });

    test('inserts a terminal goal snapshot before the next streamed user message', async () => {
        const goal = createCompletedGoal();
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.taskState = {
            task_id: 'task-1',
            goal_state: goal,
            chat_context: {
                messages: []
            }
        } as any;

        await taskView.handleChunkUpdate({
            type: 'user',
            task_id: 'task-1',
            message_id: 'message-after-goal',
            last_part_index: 0,
            last_part: new TextMessagePart('message after goal')
        });

        const output = stripAnsi(taskView.render(120).join('\n'));
        const goalIndex = output.indexOf('Follow-up Goal');
        const userIndex = output.indexOf('message after goal');

        expect(goalIndex).toBeGreaterThanOrEqual(0);
        expect(userIndex).toBeGreaterThanOrEqual(0);
        expect(goalIndex).toBeLessThan(userIndex);
    });

    test('rebuilds terminal goal snapshot before the first later external user message', () => {
        const goal = createCompletedGoal();
        const startMessage = new UserMessage('start goal work');
        startMessage.timestamp = Date.parse('2026-01-01T00:00:00.000Z');
        const assistantMessage = new AssistantMessage([new TextMessagePart('assistant finished goal')]);
        const afterGoalMessage = new UserMessage('message after goal');
        afterGoalMessage.timestamp = Date.parse('2026-01-01T00:00:06.000Z');
        const messages = [startMessage, assistantMessage, afterGoalMessage];
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.taskState = {
            task_id: 'task-1',
            goal_state: goal,
            chat_context: {
                messages,
                lastMessage: () => messages[messages.length - 1]
            }
        } as any;

        taskView.rebuildFromHistory();
        const output = stripAnsi(taskView.render(120).join('\n'));
        const assistantIndex = output.indexOf('assistant finished goal');
        const goalIndex = output.indexOf('Follow-up Goal');
        const laterUserIndex = output.indexOf('message after goal');

        expect(assistantIndex).toBeGreaterThanOrEqual(0);
        expect(goalIndex).toBeGreaterThanOrEqual(0);
        expect(laterUserIndex).toBeGreaterThanOrEqual(0);
        expect(assistantIndex).toBeLessThan(goalIndex);
        expect(goalIndex).toBeLessThan(laterUserIndex);
    });

    test('rebuilds persisted final goal snapshot without current goal fallback', () => {
        const goal = createCompletedGoal();
        const snapshot = createFinalSnapshot(goal);
        const startMessage = new UserMessage('start goal work');
        startMessage.timestamp = Date.parse('2026-01-01T00:00:00.000Z');
        const assistantMessage = new AssistantMessage([new TextMessagePart('assistant finished goal')]);
        assistantMessage.metadata = {
            execution: {
                startAt: Date.parse('2026-01-01T00:00:00.000Z'),
                finishAt: Date.parse('2026-01-01T00:00:05.000Z')
            }
        };
        snapshot.anchorMessageId = assistantMessage.message_id;
        const afterGoalMessage = new UserMessage('message after goal');
        afterGoalMessage.timestamp = Date.parse('2026-01-01T00:00:06.000Z');
        const messages = [startMessage, assistantMessage, afterGoalMessage];
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.taskState = {
            task_id: 'task-1',
            goal_state: undefined,
            goal_final_snapshots: [snapshot],
            chat_context: {
                messages,
                lastMessage: () => messages[messages.length - 1]
            }
        } as any;

        taskView.rebuildFromHistory();
        const output = stripAnsi(taskView.render(120).join('\n'));
        const assistantIndex = output.indexOf('assistant finished goal');
        const goalIndex = output.indexOf('Follow-up Goal');
        const laterUserIndex = output.indexOf('message after goal');

        expect(assistantIndex).toBeGreaterThanOrEqual(0);
        expect(goalIndex).toBeGreaterThanOrEqual(0);
        expect(laterUserIndex).toBeGreaterThanOrEqual(0);
        expect(assistantIndex).toBeLessThan(goalIndex);
        expect(goalIndex).toBeLessThan(laterUserIndex);
    });

    test('converts live terminal panel to persisted final snapshot panel', () => {
        const goal = createCompletedGoal();
        const snapshot = createFinalSnapshot(goal);
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.taskState = {
            task_id: 'task-1',
            goal_state: goal,
            goal_final_snapshots: [snapshot],
            chat_context: {
                messages: [],
                lastMessage: () => undefined
            }
        } as any;

        goal.status = 'active';
        taskView.syncGoalPanel({ goalState: goal, totalTokens: 0, elapsedMs: 1_000 });
        expect((taskView as any).goalPanelViews.has(`goal:${goal.id}`)).toBe(true);

        goal.status = 'complete';
        taskView.syncGoalPanel({ goalState: goal, totalTokens: 0, elapsedMs: 5_000 });

        expect((taskView as any).goalPanelViews.has(`goal:${goal.id}`)).toBe(false);
        expect((taskView as any).goalPanelViews.has(`goal-final:${goal.id}`)).toBe(true);
    });

    test('removes live and final snapshot panels when goal is cleared', () => {
        const goal = createCompletedGoal();
        goal.status = 'active';
        delete goal.completedAt;
        const snapshot = createFinalSnapshot(goal);
        snapshot.status = 'cleared';
        snapshot.clearedAt = '2026-01-01T00:00:05.000Z';
        delete (snapshot as any).completedAt;
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.taskState = {
            task_id: 'task-1',
            goal_state: goal,
            goal_final_snapshots: [snapshot],
            chat_context: {
                messages: [],
                lastMessage: () => undefined
            }
        } as any;

        taskView.syncGoalPanel({ goalState: goal, totalTokens: 0, elapsedMs: 1_000 });
        expect((taskView as any).goalPanelViews.has(`goal:${goal.id}`)).toBe(true);

        goal.status = 'cleared';
        goal.clearedAt = '2026-01-01T00:00:05.000Z';
        taskView.syncGoalPanel({ goalState: goal, totalTokens: 0, elapsedMs: 1_000 });

        expect((taskView as any).goalPanelViews.has(`goal:${goal.id}`)).toBe(false);
        expect((taskView as any).goalPanelViews.has(`goal-final:${goal.id}`)).toBe(false);
    });

    test('keeps a late final snapshot above user messages sent after completion', async () => {
        const goal = createCompletedGoal();
        const snapshot = createFinalSnapshot(goal);
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.taskState = {
            task_id: 'task-1',
            goal_state: { ...goal, status: 'active' },
            goal_final_snapshots: [],
            chat_context: {
                messages: [],
                lastMessage: () => undefined
            }
        } as any;

        taskView.syncGoalPanel({ goalState: goal, totalTokens: 0, elapsedMs: 5_000 });
        await taskView.handleChunkUpdate({
            type: 'user',
            task_id: 'task-1',
            message_id: 'message-after-goal',
            last_part_index: 0,
            last_part: new TextMessagePart('message after goal')
        });
        taskView.syncFinalGoalSnapshot(snapshot);

        const output = stripAnsi(taskView.render(120).join('\n'));
        const goalIndex = output.indexOf('Follow-up Goal');
        const userIndex = output.indexOf('message after goal');

        expect(goalIndex).toBeGreaterThanOrEqual(0);
        expect(userIndex).toBeGreaterThanOrEqual(0);
        expect(goalIndex).toBeLessThan(userIndex);
    });

    test('does not move a final snapshot when task goal state is stale and active', async () => {
        const goal = createCompletedGoal();
        const snapshot = createFinalSnapshot(goal);
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.taskState = {
            task_id: 'task-1',
            goal_state: { ...goal, status: 'active' },
            goal_final_snapshots: [snapshot],
            chat_context: {
                messages: [],
                lastMessage: () => undefined
            }
        } as any;

        taskView.syncFinalGoalSnapshot(snapshot);
        await taskView.handleChunkUpdate({
            type: 'user',
            task_id: 'task-1',
            message_id: 'message-after-goal',
            last_part_index: 0,
            last_part: new TextMessagePart('message after goal')
        });

        const output = stripAnsi(taskView.render(120).join('\n'));
        expect(output.indexOf('Follow-up Goal')).toBeLessThan(output.indexOf('message after goal'));
    });
});
