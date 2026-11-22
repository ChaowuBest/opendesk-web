import { jest } from '@jest/globals';
import { OpenDeskTUI } from '../../../../main/tui/entry';
import { SlashCommandRegistry, registerAllCommands } from '../../../../main/tui/commands/index';
import { ApplicationRegistry } from '../../../../main/applications/registry';
import { getFeatureManager } from '../../../../common/features/manager';
import { setRuntimeLocale } from '../../../../locale/index';

const DISABLE_OWNER = 'application-command-availability-test';

function createPrototypeTui() {
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
        todoList: { invalidate: jest.fn() },
        dashboardBar: { invalidate: jest.fn(), start: jest.fn(), stop: jest.fn() },
        logPanel: { invalidate: jest.fn() },
        taskView: { invalidate: jest.fn() },
        applicationCommandNames: new Set<string>(),
        disabledApplicationsSnapshot: new Set<string>(),
        retryCommandRegistered: false
    }) as any;
}

function mockSingleApplication(app: Record<string, unknown>) {
    jest.spyOn(ApplicationRegistry, 'getApplicationList').mockReturnValue([{ bundleName: 'demo' }] as any);
    jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(app as any);
}

const demoApp = {
    getName: () => 'DemoApp',
    getCliSlashCommands: () => [{ name: 'demo', description: 'demo cmd', execute: () => {} }]
};

describe('应用命令的启用状态同步', () => {
    const createdTuis: any[] = [];

    function createTui() {
        const tui = createPrototypeTui();
        createdTuis.push(tui);
        return tui;
    }

    afterEach(() => {
        for (const tui of createdTuis.splice(0)) tui.unsubscribeApplicationFeatures?.();
        getFeatureManager().setApplicationDisabled('demo', DISABLE_OWNER, false);
        getFeatureManager().setApplicationHidden('demo', DISABLE_OWNER, false);
        jest.restoreAllMocks();
        setRuntimeLocale(null);
    });

    test('disabling an application removes its commands immediately and re-enabling restores them', () => {
        setRuntimeLocale('en-US');
        mockSingleApplication(demoApp);

        const tui = createTui();
        registerAllCommands(tui);
        tui.subscribeApplicationFeatures();
        tui.registerApplicationCommandHandlers();

        expect(tui.commandRegistry.has('demo')).toBe(true);
        const orderBefore = tui.commandRegistry.getAll().map((cmd: { name: string }) => cmd.name);

        getFeatureManager().setApplicationDisabled('demo', DISABLE_OWNER, true);

        // 命令必须立刻消失，而不是留到下次 execute 才被拦下
        expect(tui.commandRegistry.has('demo')).toBe(false);
        expect(tui.commandRegistry.getAll().map((cmd: { name: string }) => cmd.name)).toEqual(
            orderBefore.filter((name: string) => name !== 'demo')
        );
        // 内置命令不受影响
        expect(tui.commandRegistry.has('language')).toBe(true);
        expect(tui.inputArea.refreshAutocomplete).toHaveBeenCalled();

        getFeatureManager().setApplicationDisabled('demo', DISABLE_OWNER, false);

        // 重新启用后按原位置恢复
        expect(tui.commandRegistry.has('demo')).toBe(true);
        expect(tui.commandRegistry.getAll().map((cmd: { name: string }) => cmd.name)).toEqual(orderBefore);
    });

    test('hiding an application keeps its commands', () => {
        setRuntimeLocale('en-US');
        mockSingleApplication(demoApp);

        const tui = createTui();
        tui.subscribeApplicationFeatures();
        tui.registerApplicationCommandHandlers();

        getFeatureManager().setApplicationHidden('demo', DISABLE_OWNER, true);

        expect(tui.commandRegistry.has('demo')).toBe(true);
    });

    test('hiding an application does not rebuild its command handlers', () => {
        setRuntimeLocale('en-US');
        mockSingleApplication(demoApp);

        const tui = createTui();
        tui.subscribeApplicationFeatures();
        tui.registerApplicationCommandHandlers();
        const handler = tui.commandRegistry.get('demo');

        getFeatureManager().setApplicationHidden('demo', DISABLE_OWNER, true);

        // 仅隐藏入口不改变命令可用性，就不该把 handler 全部换新（引用会失效）
        expect(tui.commandRegistry.get('demo')).toBe(handler);
        expect(tui.inputArea.refreshAutocomplete).not.toHaveBeenCalled();
    });

    test('stops reacting to feature changes after unsubscribe', () => {
        setRuntimeLocale('en-US');
        mockSingleApplication(demoApp);

        const tui = createTui();
        tui.subscribeApplicationFeatures();
        tui.registerApplicationCommandHandlers();
        const unsubscribe = tui.unsubscribeApplicationFeatures;
        expect(typeof unsubscribe).toBe('function');

        unsubscribe();

        getFeatureManager().setApplicationDisabled('demo', DISABLE_OWNER, true);

        // 已退订的 TUI 不再同步（其生命周期已经结束，避免继续被回调引用）
        expect(tui.commandRegistry.has('demo')).toBe(true);
    });
});
