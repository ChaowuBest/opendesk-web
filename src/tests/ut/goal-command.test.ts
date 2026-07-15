import { describe, expect, test } from '@jest/globals';
import { decideGoalObjectiveAction, parseGoalEditIfMatch } from '../../common/goal/command.js';

describe('goal command decisions', () => {
    test('creates when no unfinished goal exists', () => {
        expect(decideGoalObjectiveAction(null, 'new goal')).toEqual({ kind: 'create' });
        expect(
            decideGoalObjectiveAction(
                {
                    id: 'goal-complete',
                    revision: 1,
                    status: 'complete',
                    objective: 'finished goal'
                },
                'new goal'
            )
        ).toEqual({ kind: 'create' });
    });

    test('does nothing when the normalized objective is unchanged', () => {
        expect(
            decideGoalObjectiveAction(
                {
                    id: 'goal-1',
                    revision: 2,
                    status: 'active',
                    objective: 'same goal'
                },
                '  same goal  '
            )
        ).toEqual({ kind: 'noop' });
    });

    test.each(['active', 'paused', 'blocked'] as const)('confirms edits for an unfinished %s goal', (status) => {
        const goal = {
            id: 'goal-1',
            revision: 3,
            status,
            objective: 'current goal'
        };

        const action = decideGoalObjectiveAction(goal, 'replacement goal');
        goal.revision = 4;
        goal.objective = 'mutated after decision';

        expect(action).toEqual({
            kind: 'edit',
            currentGoal: {
                id: 'goal-1',
                revision: 3,
                status,
                objective: 'current goal'
            },
            ifMatch: {
                id: 'goal-1',
                revision: 3,
                status
            }
        });
    });
});

describe('goal edit precondition parsing', () => {
    test('accepts a complete goal edit precondition', () => {
        expect(parseGoalEditIfMatch({ id: 'goal-1', revision: 2, status: 'active' })).toEqual({
            id: 'goal-1',
            revision: 2,
            status: 'active'
        });
    });

    test.each([
        undefined,
        null,
        [],
        'goal-1',
        {},
        { id: '', revision: 1, status: 'active' },
        { id: '   ', revision: 1, status: 'active' },
        { id: 'goal-1', revision: 0, status: 'active' },
        { id: 'goal-1', revision: 1.5, status: 'active' },
        { id: 'goal-1', revision: 1, status: 'unknown' }
    ])('rejects malformed precondition %#', (value) => {
        expect(parseGoalEditIfMatch(value)).toBeUndefined();
    });
});
