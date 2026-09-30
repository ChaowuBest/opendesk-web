import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SlashCommandRegistry } from '../../../../main/tui/commands/base.js';
import { Setting, setCustomOpendeskDirectory } from '../../../../main/utils/setting.js';
import { setRuntimeLocale } from '../../../../locale/index.js';

const overlayShows: Array<{ title?: string; message?: string }> = [];

jest.unstable_mockModule('../../../../main/tui/components/notice.js', () => ({
    InfoOverlay: class {
        private options: { title?: string; message?: string };

        constructor(_tui: unknown, options: { title?: string; message?: string }) {
            this.options = options;
        }

        show(onClose?: () => void): void {
            overlayShows.push(this.options);
            onClose?.();
        }
    }
}));

describe('/reason display compatibility command', () => {
    let tempRoot: string;
    let registerReasonCommand: typeof import('../../../../main/tui/commands/reason.js').registerReasonCommand;

    beforeEach(async () => {
        setRuntimeLocale('en-US');
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-reason-command-'));
        setCustomOpendeskDirectory(tempRoot);
        Setting.clearCache();
        Setting.updateInstanceData({
            default_model: 'test-model',
            models: [{ alias: 'test-model', model_type: 'chat', reasoning_effort: 'medium' }],
            cli_config: {
                output_display: 'verbose',
                show_all_reasoning: false,
                reason_display: 'partial'
            }
        });
        overlayShows.length = 0;
        ({ registerReasonCommand } = await import('../../../../main/tui/commands/reason.js'));
    });

    afterEach(() => {
        setRuntimeLocale(null);
        Setting.clearCache();
        setCustomOpendeskDirectory(undefined);
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    function createCommand(options: { activeTaskId?: string; outputDisplayLevel?: 'minimal' | 'verbose' } = {}) {
        const registry = new SlashCommandRegistry();
        const tui = {
            activeTaskId: options.activeTaskId,
            commandRegistry: registry,
            taskView: {
                invalidate: jest.fn(),
                getOutputDisplayLevel: jest.fn(() => options.outputDisplayLevel ?? 'verbose')
            },
            tui: { requestRender: jest.fn() }
        } as any;
        registerReasonCommand(tui);
        return { command: registry.get('reason')!, tui };
    }

    test('keeps display mode completions', () => {
        const { command } = createCommand();

        expect(command.getArgumentCompletions?.('')?.map((item) => item.value)).toEqual(
            expect.arrayContaining(['effort', 'display'])
        );
        expect(command.getArgumentCompletions?.('display ')?.map((item) => item.value)).toEqual([
            'display full',
            'display partial'
        ]);
    });

    test('persists display mode and refreshes the current task', async () => {
        const { command, tui } = createCommand();

        await command.execute('display full');

        expect(Setting.getInstance().getData().cli_config?.reason_display).toBe('full');
        expect(Setting.getInstance().getData().cli_config?.show_all_reasoning).toBe(true);
        expect(tui.taskView.invalidate).toHaveBeenCalledTimes(1);
        expect(tui.tui.requestRender).toHaveBeenCalledTimes(1);
        expect(overlayShows.at(-1)?.message).toContain('Full Display');

        await command.execute('display partial');

        expect(Setting.getInstance().getData().cli_config?.reason_display).toBe('partial');
        expect(Setting.getInstance().getData().cli_config?.show_all_reasoning).toBe(false);
    });

    test('persists the full reasoning preference without changing the configured output mode', async () => {
        Setting.updateInstanceData({
            cli_config: {
                output_display: 'minimal',
                show_all_reasoning: false,
                reason_display: 'partial'
            }
        });
        const { command } = createCommand();

        await command.execute('display full');

        expect(Setting.getInstance().getData().cli_config?.reason_display).toBe('full');
        expect(Setting.getInstance().getData().cli_config?.show_all_reasoning).toBe(true);
        expect(Setting.getInstance().getData().cli_config?.output_display).toBe('minimal');
    });

    test('rejects full reasoning in a minimal current task without changing the setting', async () => {
        Setting.updateInstanceData({
            cli_config: {
                output_display: 'minimal',
                show_all_reasoning: false,
                reason_display: 'partial',
                shortcuts: {
                    output_display: 'ctrl+u'
                }
            }
        });
        const { command, tui } = createCommand({ activeTaskId: 'task_1', outputDisplayLevel: 'minimal' });

        await command.execute('display full');

        expect(Setting.getInstance().getData().cli_config?.reason_display).toBe('partial');
        expect(Setting.getInstance().getData().cli_config?.show_all_reasoning).toBe(false);
        expect(tui.taskView.invalidate).not.toHaveBeenCalled();
        expect(tui.tui.requestRender).not.toHaveBeenCalled();
        expect(overlayShows.at(-1)?.message).toContain('minimal output');
        expect(overlayShows.at(-1)?.message).toContain('Ctrl+U');
        expect(overlayShows.at(-1)?.message).not.toContain('Ctrl+O');
    });

    test('allows full reasoning after the current task is temporarily switched to verbose output', async () => {
        Setting.updateInstanceData({
            cli_config: {
                output_display: 'minimal',
                show_all_reasoning: false,
                reason_display: 'partial'
            }
        });
        const { command } = createCommand({ activeTaskId: 'task_1', outputDisplayLevel: 'verbose' });

        await command.execute('display full');

        expect(Setting.getInstance().getData().cli_config?.reason_display).toBe('full');
        expect(Setting.getInstance().getData().cli_config?.show_all_reasoning).toBe(true);
    });
});
