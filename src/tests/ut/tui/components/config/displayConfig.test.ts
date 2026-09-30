import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Setting, setCustomOpendeskDirectory } from '../../../../../main/utils/setting';
import { DisplayConfigPage } from '../../../../../main/tui/components/config/displayConfig';
import { setRuntimeLocale } from '../../../../../locale/index';

function createTuiMock() {
    return {
        addInputListener: jest.fn(() => jest.fn()),
        setFocus: jest.fn(),
        requestRender: jest.fn()
    } as any;
}

describe('DisplayConfigPage', () => {
    let tempRoot: string;

    beforeEach(() => {
        setRuntimeLocale('en-US');
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-display-config-'));
        setCustomOpendeskDirectory(tempRoot);
        Setting.clearCache();
        Setting.updateInstanceData({
            cli_config: {
                output_display: 'minimal',
                show_all_reasoning: false,
                shortcuts: {},
                use_isolated_python: true,
                inherit_venv: true
            }
        });
    });

    afterEach(() => {
        setRuntimeLocale(null);
        Setting.clearCache();
        setCustomOpendeskDirectory(undefined);
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    test('renders output display and disables full reasoning in minimal mode', () => {
        const page = new DisplayConfigPage(createTuiMock(), jest.fn());

        const text = page.render(80).join('\n');

        expect(text).toContain('Display Settings');
        expect(text).toContain('Output Display');
        expect(text).toContain('Minimal mode');
        expect(text).not.toContain('(minimal)');
        expect(text).toContain('Reasoning Display');
        expect(text).toContain('Partial reasoning content (partial)');
        expect(text).toContain('Unavailable in minimal mode');
    });

    test('saves detailed output and unlocks explicit full reasoning', () => {
        const onBack = jest.fn();
        const onConfigChange = jest.fn();
        const page = new DisplayConfigPage(createTuiMock(), onBack, onConfigChange);

        (page as unknown as { save: (values: Record<string, unknown>) => void }).save({
            output_display: 'verbose',
            reason_display: 'full'
        });

        expect(Setting.getInstance().getData().cli_config?.output_display).toBe('verbose');
        expect(Setting.getInstance().getData().cli_config?.show_all_reasoning).toBe(true);
        expect(Setting.getInstance().getData().cli_config?.reason_display).toBe('full');
        expect(onConfigChange).toHaveBeenCalledTimes(1);
        expect(onBack).toHaveBeenCalledTimes(1);
    });

    test('saving minimal output forces full reasoning off', () => {
        const page = new DisplayConfigPage(createTuiMock(), jest.fn());

        (page as unknown as { save: (values: Record<string, unknown>) => void }).save({
            output_display: 'minimal',
            reason_display: 'full'
        });

        expect(Setting.getInstance().getData().cli_config?.output_display).toBe('minimal');
        expect(Setting.getInstance().getData().cli_config?.show_all_reasoning).toBe(false);
    });
});
