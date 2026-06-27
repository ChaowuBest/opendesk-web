import { TaskStatusBar } from '../../../../main/tui/components/input';
import { setRuntimeLocale } from '../../../../locale/index';

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
});
