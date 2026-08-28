import { jest } from '@jest/globals';
import { ShortcutsConfigPage } from '../../../../../main/tui/components/config/shortcutsConfig';
import { Setting } from '../../../../../main/utils/setting';
import { setRuntimeLocale } from '../../../../../locale/index';
import stripAnsi from 'strip-ansi';

describe('ShortcutsConfigPage', () => {
    beforeEach(() => {
        Setting.clearCache();
        Setting.updateInstanceData({});
        setRuntimeLocale('en-US');
    });

    afterEach(() => {
        setRuntimeLocale(null);
        Setting.clearCache();
    });

    test('includes output display in configurable shortcuts', () => {
        const tui = {
            setFocus: jest.fn(),
            addInputListener: jest.fn(() => jest.fn()),
            requestRender: jest.fn()
        };
        const page = new ShortcutsConfigPage({ tui } as any, jest.fn());

        const output = stripAnsi(page.render(80).join('\n'));

        expect(output).toContain('Switch Output Display');
        expect(output).toContain('Ctrl+O');
    });
});
