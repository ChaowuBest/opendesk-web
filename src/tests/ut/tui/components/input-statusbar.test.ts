import { jest } from '@jest/globals';
import chalk from 'chalk';
import { TUI, visibleWidth, type Terminal } from '@earendil-works/pi-tui';
import { AgentInputArea, TaskStatusBar } from '../../../../main/tui/components/input';
import { setRuntimeLocale } from '../../../../locale/index';

const initialChalkLevel = chalk.level;

function stripAnsi(value: string): string {
    return value.replace(/\x1b\[[0-9;]*m/g, '');
}

class TestTerminal implements Terminal {
    columns = 120;
    rows = 30;
    kittyProtocolActive = false;

    start(_onInput: (data: string) => void, _onResize: () => void): void {}

    stop(): void {}

    async drainInput(): Promise<void> {}

    write(_data: string): void {}

    moveBy(_lines: number): void {}

    hideCursor(): void {}

    showCursor(): void {}

    clearLine(): void {}

    clearFromCursor(): void {}

    clearScreen(): void {}

    setTitle(_title: string): void {}
}

describe('TaskStatusBar', () => {
    beforeEach(() => {
        setRuntimeLocale('en-US');
        chalk.level = 3;
    });

    afterEach(() => {
        setRuntimeLocale(null);
        chalk.level = initialChalkLevel;
    });

    test('does not render the removed Ctrl+G shortcut hint', () => {
        const statusBar = new TaskStatusBar();

        const line = statusBar.render(120).join('\n');

        expect(line).not.toContain('Ctrl+G');
        expect(line).not.toContain('previous message');
    });

    test('does not show the output display shortcut in the task status bar', () => {
        const statusBar = new TaskStatusBar();

        expect(stripAnsi(statusBar.render(120).join('\n'))).not.toContain('Ctrl+O');
    });

    test.each([
        ['minimal', 'Minimal display'],
        ['verbose', 'Detailed']
    ] as const)('shows the current %s output level without a label or shortcut', (level, expected) => {
        const statusBar = new TaskStatusBar();
        statusBar.update({ outputDisplayLevel: level });

        const line = stripAnsi(statusBar.render(120).join('\n'));

        expect(line).toContain(expected);
        expect(line).not.toContain('Display:');
        expect(line).not.toContain('Ctrl+O');
    });

    test('localizes the output level shown in the task status bar', () => {
        setRuntimeLocale('zh-CN');
        const statusBar = new TaskStatusBar();
        statusBar.update({ outputDisplayLevel: 'minimal' });

        expect(stripAnsi(statusBar.render(120).join('\n'))).toContain('极简显示');

        statusBar.update({ outputDisplayLevel: 'verbose' });

        expect(stripAnsi(statusBar.render(120).join('\n'))).toContain('详细显示');
    });

    test('keeps the status bar background across the full width when the terminal is narrow', () => {
        const statusBar = new TaskStatusBar();
        statusBar.update({
            elapsedMs: 4_152_000,
            totalTokens: 476_682,
            contextSize: 1_000_000,
            modelName: 'deepseek-v4-pro',
            modeDisplay: '⚡ Efficiency',
            outputDisplayLevel: 'minimal',
            workspace: '/storage/Users/currentUser/very-long-workspace-name',
            taskName: 'Ollama hinter 端侧推理'
        });

        const width = 80;
        const lines = statusBar.render(width);

        expect(lines).toHaveLength(1);
        // truncateToWidth 会插入 \x1b[0m 硬重置，导致后半段背景色丢失
        expect(lines[0]).not.toContain('\x1b[0m');
        // 状态栏必须铺满整行，背景才能覆盖到最右侧
        expect(visibleWidth(lines[0])).toBe(width);
        expect(stripAnsi(lines[0])).toContain('端侧推理');
    });

    test('pads the status bar to the full width when the terminal is extremely narrow', () => {
        const statusBar = new TaskStatusBar();
        statusBar.update({
            elapsedMs: 4_152_000,
            totalTokens: 476_682,
            contextSize: 1_000_000,
            modelName: 'deepseek-v4-pro',
            modeDisplay: '⚡ Efficiency',
            outputDisplayLevel: 'minimal',
            workspace: '/storage/Users/currentUser',
            taskName: '一个非常非常长的任务名称'
        });

        for (const width of [12, 20, 33]) {
            const lines = statusBar.render(width);
            expect(lines[0]).not.toContain('\x1b[0m');
            expect(visibleWidth(lines[0])).toBe(width);
        }
    });

    test('does not add vertical padding around the regular editor', () => {
        const tui = new TUI(new TestTerminal());
        const inputArea = new AgentInputArea({
            tui,
            workspace: process.cwd(),
            isInputBlocked: () => false,
            isModelNotConfiguredMode: () => false,
            isActiveGoalRunningForInput: () => false,
            isGoalClearStoppingForInput: () => false
        } as any);
        inputArea.input.setText('compact input');

        const lines = inputArea.render(120).map((line) => stripAnsi(line));
        const expectedLines = ['', ...inputArea.input.render(120), ...inputArea.statusBar.render(120)].map((line) =>
            stripAnsi(line)
        );

        expect(lines).toEqual(expectedLines);
    });

    test('submits ordinary messages as supplemental context while an active goal is running', async () => {
        const tui = new TUI(new TestTerminal());
        const inputArea = new AgentInputArea({
            tui,
            workspace: process.cwd(),
            isInputBlocked: () => false,
            isModelNotConfiguredMode: () => false,
            isActiveGoalRunningForInput: () => true,
            isGoalClearStoppingForInput: () => false
        } as any);
        const submit = jest.fn();
        inputArea.onSubmit(submit);
        inputArea.setStatus('running');

        inputArea.input.onSubmit?.('ordinary follow-up');
        await Promise.resolve();

        expect(submit).toHaveBeenCalledWith('ordinary follow-up');
        expect(inputArea.hasQueuedMessages()).toBe(false);
        expect(inputArea.input.getText()).toBe('');
    });

    test('clears supplemental context hint after the supplement is consumed', async () => {
        const tui = new TUI(new TestTerminal());
        const inputArea = new AgentInputArea({
            tui,
            workspace: process.cwd(),
            isInputBlocked: () => false,
            isModelNotConfiguredMode: () => false,
            isActiveGoalRunningForInput: () => true,
            isGoalClearStoppingForInput: () => false
        } as any);
        inputArea.onSubmit(jest.fn());
        inputArea.setStatus('running');

        inputArea.input.onSubmit?.('ordinary follow-up');
        await Promise.resolve();

        expect(stripAnsi(inputArea.render(120).join('\n'))).toContain('supplemental context');

        inputArea.clearGoalSupplementQueuedHint();

        expect(stripAnsi(inputArea.render(120).join('\n'))).not.toContain('supplemental context');
    });

    test('queues ordinary messages while a goal clear is still stopping', async () => {
        const tui = new TUI(new TestTerminal());
        const inputArea = new AgentInputArea({
            tui,
            workspace: process.cwd(),
            isInputBlocked: () => false,
            isModelNotConfiguredMode: () => false,
            isActiveGoalRunningForInput: () => false,
            isGoalClearStoppingForInput: () => true
        } as any);
        const submit = jest.fn();
        inputArea.onSubmit(submit);
        inputArea.setStatus('running');

        inputArea.input.onSubmit?.('ordinary follow-up');
        await Promise.resolve();

        expect(submit).not.toHaveBeenCalled();
        expect(inputArea.hasQueuedMessages()).toBe(true);
        expect(stripAnsi(inputArea.render(120).join('\n'))).toContain('ordinary pending message');
        expect(inputArea.input.getText()).toBe('');
        expect(inputArea.dequeueMessage()).toBe('ordinary follow-up');
    });
});
