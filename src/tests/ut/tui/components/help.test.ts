import { jest } from '@jest/globals';
import { SkillRegistry } from '../../../../main/aikernel/skill';
import { SlashCommandRegistry } from '../../../../main/tui/commands/base';
import { HelpOverlay } from '../../../../main/tui/components/help';
import { Setting } from '../../../../main/utils/setting';
import { setRuntimeLocale } from '../../../../locale/index';
import stripAnsi from 'strip-ansi';

function createHarness(registry: SlashCommandRegistry) {
    let draft = 'existing draft';
    const tui = {
        commandRegistry: registry,
        inputArea: {
            input: {
                setText: jest.fn((text: string) => {
                    draft = text;
                })
            }
        },
        tui: {
            terminal: { rows: 32 },
            requestRender: jest.fn(),
            setFocus: jest.fn()
        },
        closeInputPrompt: jest.fn(() => null),
        focusAfterInputPromptClose: jest.fn()
    } as any;

    return { tui, getDraft: () => draft };
}

describe('HelpOverlay command selection', () => {
    beforeEach(() => {
        Setting.clearCache();
        Setting.updateInstanceData({});
        setRuntimeLocale('en-US');
        jest.spyOn(SkillRegistry, 'getInstance').mockReturnValue({
            getUserInvocableSkills: jest.fn(async () => [])
        } as any);
    });

    afterEach(() => {
        setRuntimeLocale(null);
        Setting.clearCache();
        jest.restoreAllMocks();
    });

    test('fills the selected command without executing it', () => {
        const execute = jest.fn();
        const registry = new SlashCommandRegistry();
        registry.register({ name: 'config', description: 'Configure OpenDesk', execute });
        const { tui, getDraft } = createHarness(registry);
        const overlay = new HelpOverlay(tui);

        (overlay as any).commandTable.innerList.onSelect({ value: 'config' });

        expect(getDraft()).toBe('/config ');
        expect(execute).not.toHaveBeenCalled();
        expect(tui.closeInputPrompt).toHaveBeenCalledWith(overlay);
        expect(tui.focusAfterInputPromptClose).toHaveBeenCalledWith(null);
    });

    test('does not fill input when selecting another help tab', () => {
        const registry = new SlashCommandRegistry();
        registry.register({ name: 'config', description: 'Configure OpenDesk', execute: jest.fn() });
        const { tui, getDraft } = createHarness(registry);
        const overlay = new HelpOverlay(tui);

        (overlay as any).skillTable.innerList.onSelect({ value: '_loading' });

        expect(getDraft()).toBe('existing draft');
        expect(tui.inputArea.input.setText).not.toHaveBeenCalled();
    });

    test('does not fill a command unregistered while help is open', () => {
        const registry = new SlashCommandRegistry();
        registry.register({ name: 'temporary', description: 'Temporary command', execute: jest.fn() });
        const { tui, getDraft } = createHarness(registry);
        const overlay = new HelpOverlay(tui);
        registry.unregister('temporary');

        (overlay as any).commandTable.innerList.onSelect({ value: 'temporary' });

        expect(getDraft()).toBe('existing draft');
        expect(tui.inputArea.input.setText).not.toHaveBeenCalled();
    });

    test('lists the configured output display shortcut', () => {
        Setting.updateInstanceData({
            cli_config: {
                shortcuts: {
                    output_display: 'ctrl+u'
                }
            }
        });
        const registry = new SlashCommandRegistry();
        const { tui } = createHarness(registry);
        const overlay = new HelpOverlay(tui);

        const row = (overlay as any).shortcutTable.innerRows.find((item: any) => item.value === 'output_display');

        expect(row.labels.map(stripAnsi)).toEqual(['Switch Output Display', 'Ctrl+U']);
    });
});
