import { jest } from '@jest/globals';
import { Text } from '@earendil-works/pi-tui';
import { OpenDeskTUI } from '../../../main/tui/entry.js';
import { SlashCommandRegistry, registerAllCommands } from '../../../main/tui/commands/index.js';
import { ApplicationRegistry } from '../../../main/applications/registry.js';
import { setRuntimeLocale, t } from '../../../locale/index.js';

/** 只满足 refreshLocalizedTexts 依赖的最小 TUI 形状（不跑构造函数） */
function createPrototypeTui(overrides: Record<string, any> = {}) {
    return Object.assign(Object.create(OpenDeskTUI.prototype), {
        commandRegistry: new SlashCommandRegistry(),
        container: { children: [] },
        tui: { requestRender: jest.fn() },
        inputArea: {
            refreshAutocomplete: jest.fn(),
            refreshHint: jest.fn(),
            invalidate: jest.fn(),
            statusBar: { invalidate: jest.fn(), update: jest.fn() }
        },
        _activeMode: {
            id: 'standard',
            icon: '⚡',
            color: '#ffffff',
            name: 'Standard',
            displayNameKey: 'mode.standard.name',
            description: 'Standard',
            descriptionKey: 'mode.standard.description'
        },
        todoList: { invalidate: jest.fn() },
        dashboardBar: { invalidate: jest.fn() },
        logPanel: { invalidate: jest.fn() },
        taskView: { invalidate: jest.fn() },
        applicationCommandNames: new Set<string>(),
        disabledApplicationsSnapshot: new Set<string>(),
        retryCommandRegistered: false,
        ...overrides
    }) as any;
}

describe('OpenDeskTUI.refreshLocalizedTexts', () => {
    afterEach(() => {
        setRuntimeLocale(null);
    });

    test('re-registers built-in command descriptions and drops cached renders', () => {
        setRuntimeLocale('en-US');
        const tui = createPrototypeTui();
        registerAllCommands(tui);
        expect(tui.commandRegistry.get('language').description).toBe('Switch the interface language');

        setRuntimeLocale('zh-CN');
        tui.refreshLocalizedTexts();

        expect(tui.commandRegistry.get('language').description).toBe('切换界面语言');
        expect(tui.inputArea.refreshAutocomplete).toHaveBeenCalledTimes(1);
        expect(tui.inputArea.refreshHint).toHaveBeenCalledTimes(1);
        expect(tui.inputArea.invalidate).toHaveBeenCalledTimes(1);
        expect(tui.inputArea.statusBar.invalidate).toHaveBeenCalledTimes(1);
        expect(tui.todoList.invalidate).toHaveBeenCalledTimes(1);
        expect(tui.dashboardBar.invalidate).toHaveBeenCalledTimes(1);
        expect(tui.logPanel.invalidate).toHaveBeenCalledTimes(1);
        expect(tui.taskView.invalidate).toHaveBeenCalledTimes(1);
        // 模式名启动时已本地化，切换语言后必须按翻译键重新解析
        expect(tui.inputArea.statusBar.update).toHaveBeenCalledWith(
            expect.objectContaining({ modeDisplay: expect.stringContaining('标准模式') })
        );
        expect(tui.tui.requestRender).toHaveBeenCalled();
    });

    test('rebuilds the model-not-configured notice in place', () => {
        setRuntimeLocale('en-US');
        const oldNotice = { stale: true };
        const container = { children: [{ banner: true }, oldNotice, { input: true }] };
        const tui = createPrototypeTui({ container, modelNotConfiguredNotice: oldNotice });

        setRuntimeLocale('zh-CN');
        tui.refreshLocalizedTexts();

        // 位置不变、对象换新，且新组件按新语言求值
        expect(container.children).toHaveLength(3);
        expect(container.children[0]).toEqual({ banner: true });
        expect(container.children[2]).toEqual({ input: true });
        const rebuilt = container.children[1] as Text;
        expect(rebuilt).not.toBe(oldNotice);
        expect(rebuilt.render(120).join('\n')).toContain('模型未配置');
    });

    test('re-registers the retry command so its description follows the new language', () => {
        setRuntimeLocale('en-US');
        const tui = createPrototypeTui({
            retryCommandRegistered: true,
            activeTaskId: 'task-1',
            taskManagerState: { getTask: jest.fn(() => ({ isLLMRetryDelayPending: () => true })) }
        });
        registerAllCommands(tui);
        tui.commandRegistry.register({
            name: 'retry',
            description: 'Retry the current failed LLM request immediately',
            source: 'OpenDesk TUI',
            execute: () => {}
        });
        const orderBefore = tui.commandRegistry.getAll().map((cmd) => cmd.name);

        setRuntimeLocale('zh-CN');
        tui.refreshLocalizedTexts();

        expect(tui.commandRegistry.get('retry').description).toBe('立即重试当前失败的 LLM 请求');
        // 重注册后仍留在原来的展示位置
        expect(tui.commandRegistry.getAll().map((cmd) => cmd.name)).toEqual(orderBefore);
    });

    test('re-collects application command descriptions after a language switch', () => {
        setRuntimeLocale('en-US');
        const app = {
            getName: () => 'DemoApp',
            // 应用命令描述在 getCliSlashCommands() 时求值
            getCliSlashCommands: () => [{ name: 'demo', description: t('language.description'), execute: () => {} }]
        };
        jest.spyOn(ApplicationRegistry, 'getApplicationList').mockReturnValue([{ bundleName: 'demo' }] as any);
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(app as any);

        try {
            const tui = createPrototypeTui();
            tui.registerApplicationCommandHandlers();
            expect(tui.commandRegistry.get('demo').description).toBe('Switch the interface language');

            setRuntimeLocale('zh-CN');
            tui.refreshLocalizedTexts();

            expect(tui.commandRegistry.get('demo').description).toBe('切换界面语言');
        } finally {
            jest.restoreAllMocks();
        }
    });

    test('isolates a throwing application from the other applications and built-in commands', () => {
        setRuntimeLocale('en-US');
        const broken = {
            getName: () => 'BrokenApp',
            getCliSlashCommands: () => {
                throw new Error('boom');
            }
        };
        const healthy = {
            getName: () => 'HealthyApp',
            getCliSlashCommands: () => [{ name: 'healthy', description: 'healthy cmd', execute: () => {} }]
        };
        jest.spyOn(ApplicationRegistry, 'getApplicationList').mockReturnValue([
            { bundleName: 'broken' },
            { bundleName: 'healthy' }
        ] as any);
        jest.spyOn(ApplicationRegistry, 'getApplication').mockImplementation(((bundleName: string) =>
            bundleName === 'broken' ? broken : healthy) as any);

        try {
            const tui = createPrototypeTui();
            registerAllCommands(tui);
            // 启动路径：坏应用被跳过，好应用正常注册
            tui.registerApplicationCommandHandlers();
            expect(tui.commandRegistry.has('healthy')).toBe(true);

            setRuntimeLocale('zh-CN');
            expect(() => tui.refreshLocalizedTexts()).not.toThrow();

            // 抛错的应用被跳过，其它应用与内置命令照常可用
            expect(tui.commandRegistry.has('healthy')).toBe(true);
            expect(tui.commandRegistry.has('language')).toBe(true);
            expect(tui.commandRegistry.get('language').description).toBe('切换界面语言');
        } finally {
            jest.restoreAllMocks();
        }
    });

    test('registers commands from a frozen command object without mutating or failing', () => {
        setRuntimeLocale('en-US');
        const frozenCmd = Object.freeze({
            name: 'frozen',
            description: 'frozen cmd',
            execute: () => {}
        });
        const app = {
            getName: () => 'FrozenApp',
            getCliSlashCommands: () => [frozenCmd]
        };
        jest.spyOn(ApplicationRegistry, 'getApplicationList').mockReturnValue([{ bundleName: 'frozen' }] as any);
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(app as any);

        try {
            const tui = createPrototypeTui();
            expect(() => tui.registerApplicationCommandHandlers()).not.toThrow();

            // 注册的是复制出来的对象，应用提供的 frozen 对象不被写入
            expect(tui.commandRegistry.get('frozen')?.source).toBe('FrozenApp');
            expect(Object.prototype.hasOwnProperty.call(frozenCmd, 'source')).toBe(false);
        } finally {
            jest.restoreAllMocks();
        }
    });
});
