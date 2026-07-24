import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Setting, setCustomOpendeskDirectory } from '../../../../../main/utils/setting';
import { TaskConfigPage } from '../../../../../main/tui/components/config/taskConfig';
import { setRuntimeLocale } from '../../../../../locale/index';

function createTuiMock() {
    return {
        addInputListener: jest.fn(() => jest.fn()),
        setFocus: jest.fn(),
        requestRender: jest.fn()
    } as any;
}

function stripAnsi(value: string): string {
    return value.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('TaskConfigPage', () => {
    let tempRoot: string;

    beforeEach(() => {
        setRuntimeLocale('en-US');
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-task-config-'));
        setCustomOpendeskDirectory(tempRoot);
        Setting.clearCache();
        Setting.updateInstanceData({
            task_config: {
                auto_retry: true,
                generate_taskname: true,
                termination_check: true,
                evidence_card: false
            },
            cli_config: {
                shortcuts: {},
                use_isolated_python: true,
                inherit_venv: true,
                reason_display: 'partial'
            }
        });
    });

    afterEach(() => {
        setRuntimeLocale(null);
        Setting.clearCache();
        setCustomOpendeskDirectory(undefined);
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    test('renders the localized EvidenceCard switch as disabled by default', () => {
        const page = new TaskConfigPage(createTuiMock(), jest.fn());

        const text = stripAnsi(page.render(80).join('\n'));

        expect(text).toContain('Use EvidenceCard to save tokens');
        expect(text).toContain('Use EvidenceCard to save tokens: No');
    });

    test('saves EvidenceCard together with existing task and CLI settings', () => {
        const onBack = jest.fn();
        const onConfigChange = jest.fn();
        const page = new TaskConfigPage(createTuiMock(), onBack, onConfigChange);

        (page as unknown as { save: (values: Record<string, unknown>) => void }).save({
            auto_retry: true,
            generate_taskname: true,
            termination_check: true,
            evidence_card: true,
            use_isolated_python: true,
            inherit_venv: true
        });

        const data = Setting.getInstance().getData();
        expect(data.task_config.evidence_card).toBe(true);
        expect(data.task_config.auto_retry).toBe(true);
        expect(data.cli_config.use_isolated_python).toBe(true);
        expect(onConfigChange).toHaveBeenCalledTimes(1);
        expect(onBack).toHaveBeenCalledTimes(1);
    });
});
