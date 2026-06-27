import { GoalStates } from '../../../../main/aikernel/goal/state';
import { GoalPanel } from '../../../../main/tui/components/goalpanel';
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

    test('renders localized status labels and supplied elapsed time', () => {
        const goal = GoalStates.create('task-1', { objective: 'ship fix' });
        const panel = new GoalPanel();

        panel.update({ goalState: goal, totalTokens: 0, elapsedMs: 5_000 });
        const output = stripAnsi(panel.render(100).join('\n'));

        expect(output).toContain('Objective: ship fix');
        expect(output).toContain('Status:');
        expect(output).toContain('Active');
        expect(output).toContain('Elapsed: 00:05');
    });
});
