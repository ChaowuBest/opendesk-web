import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerDisplayCommand } from '../../../../main/tui/commands/display';
import { Setting, setCustomOpendeskDirectory } from '../../../../main/utils/setting';
import { setRuntimeLocale } from '../../../../locale/index';
import { persistOutputDisplayLevel } from '../../../../main/tui/display';

describe('/display command', () => {
    let tempRoot: string;

    beforeEach(() => {
        setRuntimeLocale('en-US');
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-display-command-'));
        setCustomOpendeskDirectory(tempRoot);
        Setting.clearCache();
        Setting.updateInstanceData({
            cli_config: {
                output_display: 'minimal',
                show_all_reasoning: false
            }
        });
    });

    afterEach(() => {
        setRuntimeLocale(null);
        Setting.clearCache();
        setCustomOpendeskDirectory(undefined);
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    test.each([
        ['minimal', 'minimal'],
        ['detailed', 'verbose'],
        ['verbose', 'verbose']
    ] as const)('persists and immediately applies %s', async (commandLevel, outputLevel) => {
        let handler: any;
        const tui = {
            commandRegistry: {
                register: jest.fn((registered) => {
                    handler = registered;
                    return true;
                })
            },
            setOutputDisplayLevel: jest.fn((nextLevel) => persistOutputDisplayLevel(nextLevel))
        } as any;
        registerDisplayCommand(tui);

        await handler.execute(commandLevel);

        expect(tui.setOutputDisplayLevel).toHaveBeenCalledWith(outputLevel, { persist: true });
        expect(Setting.getInstance().getData().cli_config?.output_display).toBe(outputLevel);
    });

    test('offers minimal and detailed completions while keeping verbose as a compatibility alias', () => {
        let handler: any;
        const tui = {
            commandRegistry: {
                register: (registered: any) => {
                    handler = registered;
                    return true;
                }
            }
        } as any;
        registerDisplayCommand(tui);

        expect(handler.getArgumentCompletions('')).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ value: 'minimal' }),
                expect.objectContaining({ value: 'detailed' })
            ])
        );
        expect(handler.getArgumentCompletions('')).toHaveLength(2);
        expect(handler.getArgumentCompletions('')).not.toEqual(
            expect.arrayContaining([expect.objectContaining({ value: 'verbose' })])
        );
    });

    test('rejects the legacy full command name', async () => {
        let handler: any;
        const showTextPage = jest.fn();
        const tui = {
            commandRegistry: {
                register: (registered: any) => {
                    handler = registered;
                    return true;
                }
            },
            setOutputDisplayLevel: jest.fn(),
            showTextPage
        } as any;
        registerDisplayCommand(tui);

        await handler.execute('full');

        expect(tui.setOutputDisplayLevel).not.toHaveBeenCalled();
        expect(showTextPage).toHaveBeenCalledTimes(1);
        expect(handler.getArgumentCompletions('f')).toEqual([]);
    });
});
