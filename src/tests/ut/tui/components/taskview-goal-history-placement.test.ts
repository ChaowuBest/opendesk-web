import { GoalStates, type GoalFinalSnapshot } from '../../../../main/aikernel/goal/state';
import { AssistantMessage, TextMessagePart, UserMessage } from '../../../../main/aikernel/messages';
import {
    getGoalTerminalTimestamp,
    getGoalPanelDataFromFinalSnapshot,
    shouldInsertFinalSnapshotAfterMessage,
    shouldInsertGoalSnapshotBeforeMessage
} from '../../../../main/tui/components/taskview-goal/history-placement';

function createSnapshot(): GoalFinalSnapshot {
    return {
        id: 'goal-final:goal-1',
        taskId: 'task-1',
        goalId: 'goal-1',
        goalRevision: 3,
        objective: 'ship fix',
        status: 'complete',
        totalTokens: 42,
        elapsedMs: 5_000,
        createdAt: '2026-01-01T00:00:00.000Z',
        finalizedAt: '2026-01-01T00:00:05.000Z',
        completedAt: '2026-01-01T00:00:05.000Z'
    };
}

describe('TaskView goal history placement', () => {
    test('converts a final snapshot without losing terminal display data', () => {
        const snapshot = createSnapshot();
        const data = getGoalPanelDataFromFinalSnapshot(snapshot);

        expect(data).toMatchObject({ totalTokens: 42, elapsedMs: 5_000, evaluating: false });
        expect(data.goalState).toMatchObject({
            id: 'goal-1',
            taskId: 'task-1',
            objective: 'ship fix',
            status: 'complete',
            revision: 3,
            completedAt: '2026-01-01T00:00:05.000Z'
        });
    });

    test('uses message id and message index anchors before timestamp fallback', () => {
        const first = new AssistantMessage([new TextMessagePart('first')]);
        const second = new AssistantMessage([new TextMessagePart('second')]);
        first.timestamp = Date.parse('2026-01-01T00:00:01.000Z');
        second.timestamp = Date.parse('2026-01-01T00:00:02.000Z');

        const idAnchored = { ...createSnapshot(), anchorMessageId: second.message_id };
        expect(shouldInsertFinalSnapshotAfterMessage(first, 0, second, idAnchored)).toBe(false);
        expect(shouldInsertFinalSnapshotAfterMessage(second, 1, undefined, idAnchored)).toBe(true);

        const indexAnchored = { ...createSnapshot(), anchorMessageIndex: 0 };
        expect(shouldInsertFinalSnapshotAfterMessage(first, 0, second, indexAnchored)).toBe(true);
        expect(shouldInsertFinalSnapshotAfterMessage(second, 1, undefined, indexAnchored)).toBe(false);
    });

    test('does not fall back to timestamps when an explicit anchor is missing', () => {
        const message = new AssistantMessage([new TextMessagePart('before finalization')]);
        message.timestamp = Date.parse('2026-01-01T00:00:01.000Z');
        const snapshot = { ...createSnapshot(), anchorMessageId: 'missing-message' };

        expect(shouldInsertFinalSnapshotAfterMessage(message, 0, undefined, snapshot)).toBe(false);
    });

    test('uses terminal timestamps only for later external user messages', () => {
        const goal = GoalStates.create('task-1', { objective: 'ship fix' });
        goal.status = 'complete';
        goal.completedAt = '2026-01-01T00:00:05.000Z';
        const terminalAt = getGoalTerminalTimestamp(goal);

        const external = new UserMessage('after goal');
        external.timestamp = Date.parse('2026-01-01T00:00:06.000Z');
        const internal = new UserMessage('internal');
        internal.internal = true;
        internal.timestamp = external.timestamp;

        expect(shouldInsertGoalSnapshotBeforeMessage(external, terminalAt)).toBe(true);
        expect(shouldInsertGoalSnapshotBeforeMessage(internal, terminalAt)).toBe(false);
        expect(getGoalTerminalTimestamp({ ...goal, completedAt: 'invalid' })).toBeUndefined();
    });
});
