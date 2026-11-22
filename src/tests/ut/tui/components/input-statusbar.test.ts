import { jest } from '@jest/globals';
import chalk from 'chalk';
import { TUI, visibleWidth, type Terminal } from '@earendil-works/pi-tui';
import { AgentInputArea, TaskStatusBar } from '../../../../main/tui/components/input';
import { setRuntimeLocale } from '../../../../locale/index';
import { Setting } from '../../../../main/utils/setting';

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
        Setting.updateInstanceData({});
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

    test('does not show switch hints when no mode or output level is set', () => {
        const statusBar = new TaskStatusBar();

        const line = stripAnsi(statusBar.render(120).join('\n'));

        expect(line).not.toContain('Ctrl+O');
        expect(line).not.toContain('Ctrl+K');
    });

    test.each([
        ['minimal', 'Minimal display'],
        ['verbose', 'Detailed']
    ] as const)('shows the current %s output level with its switch hint', (level, expected) => {
        const statusBar = new TaskStatusBar();
        statusBar.update({ outputDisplayLevel: level });

        const line = stripAnsi(statusBar.render(120).join('\n'));

        expect(line).toContain(`${expected}   [Ctrl+O]`);
        expect(line).not.toContain('Display:');
    });

    test('localizes the output level shown in the task status bar', () => {
        setRuntimeLocale('zh-CN');
        const statusBar = new TaskStatusBar();
        statusBar.update({ outputDisplayLevel: 'minimal' });

        expect(stripAnsi(statusBar.render(120).join('\n'))).toContain('极简显示');

        statusBar.update({ outputDisplayLevel: 'verbose' });

        expect(stripAnsi(statusBar.render(120).join('\n'))).toContain('详细显示');
    });

    test('localizes the shell command mode label and follows a locale switch', () => {
        const statusBar = new TaskStatusBar();
        statusBar.update({ shellMode: true });

        expect(stripAnsi(statusBar.render(120).join('\n'))).toContain('Shell command mode');

        // 语言切换后由 TUI 调用 invalidate()，状态栏标签按新语言重绘
        setRuntimeLocale('zh-CN');
        statusBar.invalidate();

        expect(stripAnsi(statusBar.render(120).join('\n'))).toContain('Shell 命令模式');
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

    test('shows the mode switch shortcut right after the mode name', () => {
        Setting.updateInstanceData({ cli_config: { shortcuts: { switch_mode: 'ctrl+u' } } });
        const statusBar = new TaskStatusBar();
        statusBar.update({ modeDisplay: '⚡ Efficiency', outputDisplayLevel: 'minimal' });

        // 120 宽时留白 3 个空格；提示紧贴分隔线（只有一个空格），输出显示的快捷键跟在显示级别后面
        expect(stripAnsi(statusBar.render(120).join('\n'))).toContain(
            '⚡ Efficiency   [Ctrl+U] │ Minimal display   [Ctrl+O]'
        );
    });

    test('narrows the hint gap as the terminal narrows', () => {
        const statusBar = new TaskStatusBar();
        statusBar.update({ modeDisplay: '⚡ Efficiency' });

        expect(stripAnsi(statusBar.render(200).join('\n'))).toContain('⚡ Efficiency    [Ctrl+K]');
        expect(stripAnsi(statusBar.render(120).join('\n'))).toContain('⚡ Efficiency   [Ctrl+K]');
        expect(stripAnsi(statusBar.render(96).join('\n'))).toContain('⚡ Efficiency  [Ctrl+K]');
        expect(stripAnsi(statusBar.render(80).join('\n'))).toContain('⚡ Efficiency [Ctrl+K]');
    });

    test('re-reads the shortcut configuration after being invalidated', () => {
        const statusBar = new TaskStatusBar();
        statusBar.update({ modeDisplay: '⚡ Efficiency' });

        expect(stripAnsi(statusBar.render(120).join('\n'))).toContain('[Ctrl+K]');

        // 宽度与 data 都不变，只有快捷键配置变了：设置提交后由 TUI 调用 invalidate() 触发重绘
        Setting.updateInstanceData({ cli_config: { shortcuts: { switch_mode: 'ctrl+u' } } });
        statusBar.invalidate();

        expect(stripAnsi(statusBar.render(120).join('\n'))).toContain('[Ctrl+U]');
    });

    test('hides the hint when its shortcut is configured as an empty string', () => {
        Setting.updateInstanceData({ cli_config: { shortcuts: { switch_mode: '' } } });
        const statusBar = new TaskStatusBar();
        statusBar.update({ modeDisplay: '⚡ Efficiency' });

        const line = stripAnsi(statusBar.render(120).join('\n'));

        expect(line).toContain('⚡ Efficiency');
        expect(line).not.toContain('[]');
        expect(line).not.toContain('[Ctrl+K]');
    });

    test('drops the switch hints when the row is too narrow to fit them', () => {
        const statusBar = new TaskStatusBar();
        statusBar.update({
            modeDisplay: '⚡ Efficiency',
            outputDisplayLevel: 'minimal',
            modelName: 'deepseek-v4-pro',
            workspace: '/storage/Users/currentUser/very-long-workspace-name',
            taskName: 'Ollama hinter 端侧推理'
        });

        const line = stripAnsi(statusBar.render(60).join('\n'));

        expect(line).not.toContain('[Ctrl+K]');
        expect(line).not.toContain('[Ctrl+O]');
    });

    test('keeps the first hint and drops the second when only one fits', () => {
        const statusBar = new TaskStatusBar();
        statusBar.update({ modeDisplay: '⚡ Efficiency', outputDisplayLevel: 'minimal' });

        // 50 宽只够放下模式提示：两个提示都应该完整展示，而不是截断成半个括号
        const line = stripAnsi(statusBar.render(50).join('\n'));

        expect(line).toContain('⚡ Efficiency [Ctrl+K]');
        expect(line).not.toContain('[Ctrl+O]');
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
