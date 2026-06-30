import { GoalStates } from '../../../../main/aikernel/goal/state';
import { buildEvalTrail, GoalPanel } from '../../../../main/tui/components/goalpanel';
import { setRuntimeLocale } from '../../../../locale/index';

function stripAnsi(value: string): string {
    return value.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('GoalPanel', () => {
    beforeEach(() => {
        setRuntimeLocale('en-US');
    });

    afterEach(() => {
        setRuntimeLocale(null);
    });

    test('hides cleared goals by default', () => {
        const goal = GoalStates.create('task-1', { objective: 'ship fix' });
        goal.status = 'cleared';
        goal.clearedAt = '2026-01-01T00:00:05.000Z';
        const panel = new GoalPanel();

        panel.update({ goalState: goal, totalTokens: 0, elapsedMs: 0 });

        expect(panel.isVisible()).toBe(false);
        expect(panel.render(100)).toEqual([]);
    });

    test('renders header metrics and streamlined body before evaluation', () => {
        const goal = GoalStates.create('task-1', { objective: 'ship fix' });
        const panel = new GoalPanel();

        panel.update({ goalState: goal, totalTokens: 800, elapsedMs: 5_000 });
        const output = stripAnsi(panel.render(100).join('\n'));

        expect(output).toContain('Active');
        expect(output).not.toContain('◉ Active');
        expect(output).toContain('00:05');
        expect(output).toContain('Objective: ship fix');
        expect(output).toContain('Tokens: 800');
        expect(output).not.toContain('Status:');
        expect(output).not.toContain('Elapsed:');
        expect(output).not.toContain('Evaluation:');
        expect(output).not.toContain('Waiting for first evaluation');
    });

    test('renders evaluation trail and latest evaluation after evaluator runs', () => {
        const goal = GoalStates.create('task-1', { objective: 'ship fix' });
        goal.attempts = 2;
        goal.lastEvaluation = {
            goalId: goal.id,
            goalRevision: goal.revision,
            status: 'not_met',
            reason: 'database connection still fails',
            evidence: [],
            evaluatedAt: '2026-01-01T00:00:05.000Z'
        };
        const panel = new GoalPanel();

        panel.update({ goalState: goal, totalTokens: 8_200, elapsedMs: 155_000 });
        const output = stripAnsi(panel.render(120).join('\n'));

        expect(output).toContain('Active');
        expect(output).toContain('⏳⏳');
        expect(output).toContain('02:35');
        expect(output).toContain('Evaluation: ⏳ database connection still fails');
        expect(output).toContain('Tokens: 8.2K');
        expect(output).not.toContain('Attempts');
    });

    test('collapses long evaluation trails', () => {
        const goal = GoalStates.create('task-1', { objective: 'ship fix' });
        goal.status = 'complete';
        goal.attempts = 7;
        goal.lastEvaluation = {
            goalId: goal.id,
            goalRevision: goal.revision,
            status: 'met',
            reason: 'goal achieved',
            evidence: [],
            evaluatedAt: '2026-01-01T00:00:05.000Z'
        };

        expect(stripAnsi(buildEvalTrail(goal))).toBe('⏳⏳…5✅');

        goal.status = 'active';
        goal.attempts = 8;
        goal.lastEvaluation.status = 'not_met';
        expect(stripAnsi(buildEvalTrail(goal))).toBe('⏳⏳…6⏳');
    });
});
