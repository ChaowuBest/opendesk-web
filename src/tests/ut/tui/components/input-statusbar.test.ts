import { jest } from '@jest/globals';
import { TUI, type Terminal } from '@mariozechner/pi-tui';
import { AgentInputArea, TaskStatusBar } from '../../../../main/tui/components/input';
import { setRuntimeLocale } from '../../../../locale/index';

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
    });

    afterEach(() => {
        setRuntimeLocale(null);
    });

    test('does not render the removed Ctrl+G shortcut hint', () => {
        const statusBar = new TaskStatusBar();

        const line = statusBar.render(120).join('\n');

        expect(line).not.toContain('Ctrl+G');
        expect(line).not.toContain('previous message');
    });

    test('rejects ordinary queued messages while an active goal is running', async () => {
        const tui = new TUI(new TestTerminal());
        const inputArea = new AgentInputArea({
            tui,
            workspace: process.cwd(),
            isInputBlocked: () => false,
            isModelNotConfiguredMode: () => false,
            isActiveGoalRunningForInput: () => true
        } as any);
        const submit = jest.fn();
        inputArea.onSubmit(submit);
        inputArea.setStatus('running');

        inputArea.input.onSubmit?.('ordinary follow-up');
        await Promise.resolve();

        expect(submit).not.toHaveBeenCalled();
        expect(inputArea.hasQueuedMessages()).toBe(false);
        expect(inputArea.input.getText()).toBe('');
    });
});
