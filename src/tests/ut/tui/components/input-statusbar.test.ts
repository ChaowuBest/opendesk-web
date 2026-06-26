import { TUI, type Terminal } from '@mariozechner/pi-tui';
import { AgentInputArea, TaskStatusBar } from '../../../../main/tui/components/input';
import { setRuntimeLocale } from '../../../../locale/index';

class TestTerminal implements Terminal {
    get columns(): number {
        return 120;
    }

    get rows(): number {
        return 40;
    }

    get kittyProtocolActive(): boolean {
        return false;
    }

    start(): void {}

    stop(): void {}

    drainInput(): Promise<void> {
        return Promise.resolve();
    }

    write(): void {}

    moveBy(): void {}

    hideCursor(): void {}

    showCursor(): void {}

    clearLine(): void {}

    clearFromCursor(): void {}

    clearScreen(): void {}

    setTitle(): void {}
}

describe('TaskStatusBar', () => {
    beforeEach(() => {
        setRuntimeLocale('en-US');
    });

    afterEach(() => {
        setRuntimeLocale(null);
    });

    test('renders Ctrl+G recall hint in the right status area', () => {
        const statusBar = new TaskStatusBar();

        const line = statusBar.render(120).join('\n');

        expect(line).toContain('Ctrl+G');
        expect(line).toContain('recall last');
    });
});

describe('AgentInputArea', () => {
    test('recalls previous message when editor receives Ctrl+G', () => {
        const tui = new TUI(new TestTerminal());
        const inputArea = new AgentInputArea({
            tui,
            workspace: process.cwd(),
            isInputBlocked: () => false,
            isModelNotConfiguredMode: () => false
        } as any);
        inputArea.setRecallPreviousMessageHandler(() => 'previous prompt');

        inputArea.input.setText('draft');
        inputArea.input.handleInput('\x07');

        expect(inputArea.input.getText()).toBe('previous prompt');
    });
});
