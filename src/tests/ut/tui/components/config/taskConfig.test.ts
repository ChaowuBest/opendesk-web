import { jest } from '@jest/globals';
import { Key } from '@earendil-works/pi-tui';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Setting, setCustomOpendeskDirectory } from '../../../../../main/utils/setting';
import { selectSupportedShell } from '../../../../../common/shells.js';
import { setRuntimeLocale } from '../../../../../locale/index';

const shells = [
    { kind: 'powershell', path: 'C:/Windows/powershell.exe', sandboxed: false },
    { kind: 'powershell', path: 'C:/Windows/powershell.exe', sandboxed: true },
    { kind: 'bash', path: 'C:/Git/bash.exe', sandboxed: false }
];
jest.unstable_mockModule('../../../../../main/applications/terminal/scan.js', () => ({
    scanSupportedShells: () => shells,
    selectSupportedShell
}));
const { TaskConfigPage } = await import('../../../../../main/tui/components/config/taskConfig.js');

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

    test('task schema defaults shell selection and persists only the new shell fields', () => {
        const schema = Setting.getSettingSchema().shape.task_config;
        expect(schema.parse({})).toMatchObject({ shell_path: '', shell_sandboxed: false });
        const config = schema.parse({ shell_path: 'C:/tools/pwsh.exe', shell_sandboxed: true, dynamic_sandbox: true });
        expect(config).toMatchObject({ shell_path: 'C:/tools/pwsh.exe', shell_sandboxed: true });
        expect(config).not.toHaveProperty('dynamic_sandbox');
    });

    test('shows sandbox for pwsh, hides it for bash and normalizes the saved selection', () => {
        const page = new TaskConfigPage(createTuiMock(), jest.fn());
        const form = (page as any).form;
        expect(stripAnsi(page.render(120).join('\n'))).toContain('Enable sandbox');
        for (let i = 0; i < 4; i++) form.handleKeyInput(Key.down);
        form.handleKeyInput(Key.right);
        expect(stripAnsi(page.render(120).join('\n'))).not.toContain('Enable sandbox');
        (page as any).save({ ...form.getValues(), shell_sandboxed: true });
        expect(Setting.getInstance().getData().task_config).toMatchObject({
            shell_path: 'C:/Git/bash.exe',
            shell_sandboxed: false
        });
    });

    test('saves the selected pwsh path and sandbox flag', () => {
        const page = new TaskConfigPage(createTuiMock(), jest.fn());
        (page as any).save({ shell_path: shells[0].path, shell_sandboxed: true });
        expect(Setting.getInstance().getData().task_config).toMatchObject({
            shell_path: shells[0].path,
            shell_sandboxed: true
        });
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
