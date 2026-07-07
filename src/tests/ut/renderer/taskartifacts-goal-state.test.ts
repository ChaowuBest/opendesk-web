import {
    getGoalSectionActionIds,
    getTaskTodoSnapshotKey,
    hasUnfinishedGoalStatus,
    isAttachedRunningGoalCreateResult,
    isTerminalGoalStatus,
    shouldAutoCollapseTerminalGoalDetails,
    shouldShowGoalSuggestion
} from '../../../renderer/components/taskartifacts-goal-state.js';

describe('task artifacts goal state helpers', () => {
    test('cleared and complete goals are terminal and can be replaced by a new goal', () => {
        expect(isTerminalGoalStatus('cleared')).toBe(true);
        expect(isTerminalGoalStatus('complete')).toBe(true);
        expect(hasUnfinishedGoalStatus('cleared')).toBe(false);
        expect(hasUnfinishedGoalStatus('complete')).toBe(false);
    });

    test('TodoWrite suggestion is shown only when there is no goal section', () => {
        expect(
            shouldShowGoalSuggestion({
                todoCount: 2,
                goalStatus: null,
                goalCreating: false,
                dismissed: false
            })
        ).toBe(true);
        expect(
            shouldShowGoalSuggestion({
                todoCount: 2,
                goalStatus: 'cleared',
                goalCreating: false,
                dismissed: false
            })
        ).toBe(false);
        expect(
            shouldShowGoalSuggestion({
                todoCount: 2,
                goalStatus: 'complete',
                goalCreating: false,
                dismissed: false
            })
        ).toBe(false);
        expect(
            shouldShowGoalSuggestion({
                todoCount: 2,
                goalStatus: 'active',
                goalCreating: false,
                dismissed: false
            })
        ).toBe(false);
    });

    test('cleared goal section exposes creating a new goal', () => {
        expect(getGoalSectionActionIds('cleared')).toEqual(['create-new']);
        expect(getGoalSectionActionIds('complete')).toEqual(['create-new', 'clear']);
        expect(getGoalSectionActionIds('active')).toEqual(['edit-start', 'pause', 'clear']);
    });

    test('scheduler running result with active summary is treated as attached goal create success', () => {
        expect(
            isAttachedRunningGoalCreateResult({
                ok: false,
                errorCode: 'task_running',
                summary: { status: 'active' }
            })
        ).toBe(true);
        expect(
            isAttachedRunningGoalCreateResult({
                ok: false,
                errorCode: 'task_running'
            })
        ).toBe(false);
        expect(
            isAttachedRunningGoalCreateResult({
                ok: false,
                errorCode: 'goal_exists',
                summary: { status: 'active' }
            })
        ).toBe(false);
    });

    test('todo snapshot key tracks user-visible task todo changes', () => {
        const first = getTaskTodoSnapshotKey([
            {
                id: 'todo-1',
                title: 'Implement',
                status: 'pending',
                updated_at: '2026-07-08T10:00:00.000Z'
            }
        ]);
        const sameIgnoringRuntimeOnlyFields = getTaskTodoSnapshotKey([
            {
                id: 'todo-1',
                title: 'Implement',
                status: 'pending',
                updated_at: '2026-07-08T10:00:00.000Z',
                started_at: 'ignored'
            } as any
        ]);
        const changed = getTaskTodoSnapshotKey([
            {
                id: 'todo-1',
                title: 'Implement',
                status: 'completed',
                updated_at: '2026-07-08T10:01:00.000Z'
            }
        ]);

        expect(first).toBe(sameIgnoringRuntimeOnlyFields);
        expect(first).not.toBe(changed);
    });

    test('terminal goal details auto-collapse only for the first live todo change', () => {
        expect(
            shouldAutoCollapseTerminalGoalDetails({
                goalId: 'goal-1',
                goalStatus: 'complete',
                previousTodoSnapshotKey: '[]',
                nextTodoSnapshotKey: '[{"id":"todo-1"}]',
                collapseAlreadyApplied: false,
                source: 'live-update'
            })
        ).toBe(true);

        expect(
            shouldAutoCollapseTerminalGoalDetails({
                goalId: 'goal-1',
                goalStatus: 'complete',
                previousTodoSnapshotKey: '[]',
                nextTodoSnapshotKey: '[{"id":"todo-1"}]',
                collapseAlreadyApplied: true,
                source: 'live-update'
            })
        ).toBe(false);
        expect(
            shouldAutoCollapseTerminalGoalDetails({
                goalId: 'goal-1',
                goalStatus: 'active',
                previousTodoSnapshotKey: '[]',
                nextTodoSnapshotKey: '[{"id":"todo-1"}]',
                collapseAlreadyApplied: false,
                source: 'live-update'
            })
        ).toBe(false);
        expect(
            shouldAutoCollapseTerminalGoalDetails({
                goalId: 'goal-1',
                goalStatus: 'complete',
                previousTodoSnapshotKey: null,
                nextTodoSnapshotKey: '[{"id":"todo-1"}]',
                collapseAlreadyApplied: false,
                source: 'live-update'
            })
        ).toBe(false);
        expect(
            shouldAutoCollapseTerminalGoalDetails({
                goalId: 'goal-1',
                goalStatus: 'complete',
                previousTodoSnapshotKey: '[]',
                nextTodoSnapshotKey: '[{"id":"todo-1"}]',
                collapseAlreadyApplied: false,
                source: 'refresh'
            })
        ).toBe(false);
    });
});
