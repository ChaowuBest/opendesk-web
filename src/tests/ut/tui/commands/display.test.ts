import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerDisplayCommand } from '../../../../main/tui/commands/display';
import { Setting, setCustomOpendeskDirectory } from '../../../../main/utils/setting';
import { setRuntimeLocale } from '../../../../locale/index';

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
        ['verbose', 'verbose']
    ] as const)('applies %s to the current task without changing the default', async (commandLevel, outputLevel) => {
        let handler: any;
        const tui = {
            commandRegistry: {
                register: jest.fn((registered) => {
                    handler = registered;
                    return true;
                })
            },
            setOutputDisplayLevel: jest.fn()
        } as any;
        registerDisplayCommand(tui);

        await handler.execute(commandLevel);

        expect(tui.setOutputDisplayLevel).toHaveBeenCalledWith(outputLevel);
        expect(Setting.getInstance().getData().cli_config?.output_display).toBe('minimal');
    });

    test('offers only canonical minimal and verbose completions', () => {
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
                expect.objectContaining({ value: 'verbose' })
            ])
        );
        expect(handler.getArgumentCompletions('')).toHaveLength(2);
    });

    test.each(['detailed', 'full'])('rejects the non-canonical %s command name', async (commandLevel) => {
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

        await handler.execute(commandLevel);

        expect(tui.setOutputDisplayLevel).not.toHaveBeenCalled();
        expect(showTextPage).toHaveBeenCalledTimes(1);
        expect(handler.getArgumentCompletions(commandLevel[0])).toEqual([]);
    });
});
