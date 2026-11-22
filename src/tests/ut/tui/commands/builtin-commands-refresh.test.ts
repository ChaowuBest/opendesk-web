import { jest } from '@jest/globals';
import { SlashCommandRegistry, refreshBuiltinCommands, registerAllCommands } from '../../../../main/tui/commands/index';
import { setRuntimeLocale } from '../../../../locale/index';

describe('refreshBuiltinCommands', () => {
    afterEach(() => {
        setRuntimeLocale(null);
    });

    test('re-registers built-in commands so descriptions follow the new language', () => {
        setRuntimeLocale('en-US');
        const tui = { commandRegistry: new SlashCommandRegistry() } as any;
        registerAllCommands(tui);

        const before = tui.commandRegistry.get('display').description;
        const countBefore = tui.commandRegistry.getAll().length;

        setRuntimeLocale('zh-CN');
        refreshBuiltinCommands(tui);

        expect(before).toBe('Set TUI output display for the current task');
        expect(tui.commandRegistry.get('display').description).toBe('设置当前任务的 TUI 输出显示');
        expect(tui.commandRegistry.getAll()).toHaveLength(countBefore);
        expect(tui.commandRegistry.has('language')).toBe(true);
    });

    test('leaves non built-in commands untouched', () => {
        setRuntimeLocale('en-US');
        const tui = { commandRegistry: new SlashCommandRegistry() } as any;
        registerAllCommands(tui);
        tui.commandRegistry.register({
            name: 'plugin-cmd',
            description: 'plugin supplied',
            source: 'demo-plugin',
            execute: () => {}
        });

        setRuntimeLocale('zh-CN');
        refreshBuiltinCommands(tui);

        expect(tui.commandRegistry.get('plugin-cmd')?.description).toBe('plugin supplied');
    });

    test('refreshing repeatedly does not emit duplicate-registration warnings', () => {
        setRuntimeLocale('en-US');
        const tui = { commandRegistry: new SlashCommandRegistry() } as any;
        registerAllCommands(tui);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        try {
            // 若注销不完整，重新注册会走 base.ts 的重复注册告警分支
            refreshBuiltinCommands(tui);
            refreshBuiltinCommands(tui);
            expect(warn).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    test('keeps the original registry order so /help does not reshuffle', () => {
        setRuntimeLocale('en-US');
        const tui = { commandRegistry: new SlashCommandRegistry() } as any;
        registerAllCommands(tui);
        tui.commandRegistry.register({
            name: 'plugin-cmd',
            description: 'plugin supplied',
            source: 'demo-plugin',
            execute: () => {}
        });
        const orderBefore = tui.commandRegistry.getAll().map((cmd) => cmd.name);

        setRuntimeLocale('zh-CN');
        refreshBuiltinCommands(tui);

        expect(tui.commandRegistry.getAll().map((cmd) => cmd.name)).toEqual(orderBefore);
    });

    test('does not take back a built-in command that a plugin overrode', () => {
        setRuntimeLocale('en-US');
        const tui = { commandRegistry: new SlashCommandRegistry() } as any;
        registerAllCommands(tui);

        const pluginHandler = {
            name: 'display',
            description: 'plugin supplied display',
            source: 'demo-plugin',
            execute: () => {}
        };
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            tui.commandRegistry.registerOverride(pluginHandler);

            setRuntimeLocale('zh-CN');
            refreshBuiltinCommands(tui);

            // 一次语言切换不能把插件的覆盖顶掉
            expect(tui.commandRegistry.get('display')).toBe(pluginHandler);
            // 其它内置命令照常按新语言重新注册
            expect(tui.commandRegistry.get('language').description).toBe('切换界面语言');
        } finally {
            warn.mockRestore();
        }
    });
});
