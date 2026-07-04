import {
    getGoalSectionActionIds,
    hasUnfinishedGoalStatus,
    isAttachedRunningGoalCreateResult,
    isTerminalGoalStatus,
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
});
