import { GoalStates } from '../../../../main/aikernel/goal/state';
import { GoalPanel } from '../../../../main/tui/components/goalpanel';
import { setRuntimeLocale } from '../../../../locale/index';
import { getGoalElapsedMs } from '../../../../common/goal/format.js';

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

    test('renders cleared goals when used as a history snapshot', () => {
        const goal = GoalStates.create('task-1', { objective: 'ship fix' });
        goal.status = 'cleared';
        goal.clearedAt = '2026-01-01T00:00:05.000Z';
        const panel = new GoalPanel({ showTerminal: true, showCleared: true });

        panel.update({ goalState: goal, totalTokens: 0, elapsedMs: 5_000 });
        const output = stripAnsi(panel.render(100).join('\n'));

        expect(panel.isVisible()).toBe(true);
        expect(output).toContain('🎯 Follow-up Goal');
        expect(output).toContain('✕ Cleared(00:05)');
        expect(output).toContain('Objective: ship fix');
    });

    test('renders header metrics and streamlined body before evaluation', () => {
        const goal = GoalStates.create('task-1', { objective: 'ship fix' });
        const panel = new GoalPanel();

        panel.update({ goalState: goal, totalTokens: 800, elapsedMs: 5_000 });
        const output = stripAnsi(panel.render(100).join('\n'));

        expect(output).toContain('🎯 Follow-up Goal');
        expect(output).toContain('◉ Active(00:05)');
        expect(output).toContain('Objective: ship fix');
        expect(output).toContain('Tokens: 800');
        expect(output).not.toContain('Status:');
        expect(output).not.toContain('Elapsed:');
        expect(output).not.toContain('Evaluation:');
        expect(output).not.toContain('Waiting for first evaluation');
    });

    test('renders an active goal awaiting context as waiting to run', () => {
        const goal = GoalStates.create('task-1', { objective: 'ship fix' });
        goal.awaitingContextEntry = true;
        const panel = new GoalPanel();
        const now = Date.parse(goal.createdAt) + 5_000;

        panel.update({ goalState: goal, totalTokens: 0, elapsedMs: getGoalElapsedMs(goal, { now }) });
        const output = stripAnsi(panel.render(100).join('\n'));

        expect(output).toContain('◉ Waiting to run(00:00)');
        expect(output).not.toContain('◉ Waiting to run(00:05)');
        expect(output).not.toContain('◉ Active(00:05)');
    });

    test('keeps lifecycle status precedence over the awaiting-context marker', () => {
        const goal = GoalStates.create('task-1', { objective: 'ship fix' });
        goal.awaitingContextEntry = true;
        goal.status = 'blocked';
        const panel = new GoalPanel();

        panel.update({ goalState: goal, totalTokens: 0, elapsedMs: 5_000 });
        const output = stripAnsi(panel.render(100).join('\n'));

        expect(output).toContain('Blocked(00:05)');
        expect(output).not.toContain('Waiting to run');
    });

    test('renders evaluating state without a separate evaluation detail', () => {
        const goal = GoalStates.create('task-1', { objective: 'ship fix' });
        const panel = new GoalPanel();

        panel.update({ goalState: goal, totalTokens: 8_200, elapsedMs: 155_000, evaluating: true });
        const output = stripAnsi(panel.render(120).join('\n'));

        expect(output).toContain('◉ Active(02:35)');
        expect(output).toContain('Evaluating goal progress…');
        expect(output).toContain('Tokens: 8.2K');
        expect(output).not.toContain('Evaluation:');
    });

    test('renders stored evaluation summary after evaluator runs', () => {
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

        expect(output).toContain('◉ Active(02:35)');
        expect(output).toContain('Tokens: 8.2K');
        expect(output).not.toContain('Evaluation:');
        expect(output).toContain('Latest evaluation: Not met - database connection still fails');
    });

    test('renders localized compact header for completed goals', () => {
        setRuntimeLocale('zh-CN');
        const goal = GoalStates.create('task-1', { objective: '实现用户登录功能' });
        goal.status = 'complete';
        goal.attempts = 2;
        goal.lastEvaluation = {
            goalId: goal.id,
            goalRevision: goal.revision,
            status: 'met',
            reason: '目标已达成',
            evidence: [],
            evaluatedAt: '2026-01-01T00:00:05.000Z'
        };
        const panel = new GoalPanel({ showTerminal: true });

        panel.update({ goalState: goal, totalTokens: 25_800, elapsedMs: 312_000 });
        const output = stripAnsi(panel.render(120).join('\n'));

        expect(output).toContain('🎯 跟进目标');
        expect(output).toContain('✓ 已完成(05:12)');
        expect(output).toContain('目标: 实现用户登录功能');
        expect(output).toContain('最近评估: 已达成 - 目标已达成');
        expect(output).toContain('Token: 25.8K');
    });
});
