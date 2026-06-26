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
            reason_display: 'partial'
        });
    });

    afterEach(() => {
        setRuntimeLocale(null);
        Setting.clearCache();
        setCustomOpendeskDirectory(undefined);
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    test('renders reasoning display options from shared reason_display setting', () => {
        const page = new DisplayConfigPage(createTuiMock(), jest.fn());

        const text = page.render(80).join('\n');

        expect(text).toContain('Display Settings');
        expect(text).toContain('Reasoning Display');
        expect(text).toContain('Latest portion only (partial)');
    });

    test('saves full reasoning display mode', () => {
        const onBack = jest.fn();
        const onConfigChange = jest.fn();
        const page = new DisplayConfigPage(createTuiMock(), onBack, onConfigChange);

        (page as unknown as { save: (values: Record<string, unknown>) => void }).save({ reason_display: 'full' });

        expect(Setting.getInstance().getData().reason_display).toBe('full');
        expect(onConfigChange).toHaveBeenCalledTimes(1);
        expect(onBack).toHaveBeenCalledTimes(1);
    });
});
