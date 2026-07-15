import {
    canSubmitAsGoalSupplement,
    getGoalSummaryFromStatusResult,
    isGoalRunningInput,
    isTextOnlyGoalSupplementDetail
} from '../../../renderer/components/taskview-goal/input.js';

describe('task view goal input helpers', () => {
    test('captures text-only running active goal input as supplemental context', () => {
        expect(isGoalRunningInput('running', 'active')).toBe(true);
        expect(
            canSubmitAsGoalSupplement('running', 'active', {
                message: 'Use packages/appsdk as the target.',
                attachedFilePaths: [],
                attachedImages: []
            })
        ).toBe(true);
    });

    test('does not treat attached files or images as supplemental context', () => {
        expect(isTextOnlyGoalSupplementDetail({ message: 'plain text' })).toBe(true);
        expect(
            canSubmitAsGoalSupplement('running', 'active', {
                message: 'See this file.',
                attachedFilePaths: ['/tmp/example.txt'],
                attachedImages: []
            })
        ).toBe(false);
        expect(
            isTextOnlyGoalSupplementDetail({
                message: 'See this file.',
                attachedFilePaths: ['/tmp/example.txt'],
                attachedImages: []
            })
        ).toBe(false);
        expect(
            canSubmitAsGoalSupplement('running', 'active', {
                message: 'See this image.',
                attachedFilePaths: [],
                attachedImages: ['data:image/png;base64,abc']
            })
        ).toBe(false);
    });

    test('only captures input while the goal is actively running', () => {
        expect(canSubmitAsGoalSupplement('stopped', 'active', { message: 'hello' })).toBe(false);
        expect(canSubmitAsGoalSupplement('running', 'paused', { message: 'hello' })).toBe(false);
        expect(canSubmitAsGoalSupplement('running', undefined, { message: 'hello' })).toBe(false);
    });

    test('extracts goal summary from direct and wrapped status results', () => {
        const summary = { status: 'active', id: 'goal-1' };

        expect(getGoalSummaryFromStatusResult({ summary })).toBe(summary);
        expect(getGoalSummaryFromStatusResult({ status: 'ok', data: { summary } })).toBe(summary);
        expect(getGoalSummaryFromStatusResult({ status: 'ok' })).toBeUndefined();
    });
});
