import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { setRuntimeLocale } from '../../../locale/index.js';

// ── mock 模块（unstable_mockModule 不提升，变量需先初始化） ─────────────────

const mockListVisiblePlugins = jest.fn<() => unknown[]>();
const mockIsPluginEnabledFixed = jest.fn<() => boolean>();
const mockSetPluginEnabled = jest.fn<() => boolean>();
const overlays: Array<{ title?: string; message?: string }> = [];

jest.unstable_mockModule('../../../main/applications/pluginmgr/index.js', () => ({
    listVisiblePlugins: mockListVisiblePlugins,
    isPluginEnabledFixed: mockIsPluginEnabledFixed,
    setPluginEnabled: mockSetPluginEnabled
}));

jest.unstable_mockModule('../../../main/tui/components/notice', () => ({
    InfoOverlay: class {
        constructor(_tui: unknown, options: { title?: string; message?: string }) {
            overlays.push(options);
        }
        show() {}
    }
}));

jest.unstable_mockModule('../../../main/tui/entry', () => ({ OpenDeskTUI: class {} }));
jest.unstable_mockModule('../../../main/tui/theme', () => ({ defaultSelectListTheme: {} }));

// ── 动态导入（mock 注册后执行） ─────────────────────────────────────────────

const { PluginsListOverlay } = (await import('../../../main/applications/channelmgr/plugins-tui.js')) as any;

function createTUI() {
    return {
        tui: { setFocus: jest.fn(), requestRender: jest.fn() },
        inputArea: { showPromptWidget: jest.fn() },
        hasOpenOverlay: false,
        deferInputPromptIfBlockedByMode: () => false,
        closeInputPrompt: jest.fn(() => undefined),
        focusAfterInputPromptClose: jest.fn()
    };
}

function createOverlay(tui: ReturnType<typeof createTUI>, callbacks: { onToggle?: jest.Mock } = {}) {
    const onToggle = callbacks.onToggle ?? jest.fn(async () => {});
    const overlay = new PluginsListOverlay(
        tui as any,
        onToggle,
        jest.fn(async () => {})
    );
    return { overlay, onToggle };
}

/** 选中列表里的第 index 项（默认选中第一项） */
function selectIndex(overlay: any, index: number): void {
    overlay.list.selectedIndex = index;
}

/** performToggle 是异步的：等一轮事件循环让回调跑完 */
function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
    jest.clearAllMocks();
    overlays.length = 0;
    setRuntimeLocale('en-US');
    mockIsPluginEnabledFixed.mockReturnValue(false);
    mockSetPluginEnabled.mockReturnValue(true);
    mockListVisiblePlugins.mockReturnValue([
        {
            id: 'opencodego',
            source: 'builtin',
            path: '/dist/plugins/opencodego',
            enabled: true,
            options: {},
            system: true
        },
        { id: 'feishu', source: 'builtin', path: '/dist/plugins/feishu', enabled: true, options: {}, system: false }
    ]);
});

afterEach(() => {
    setRuntimeLocale(null);
});

describe('channelmgr 插件面板（TUI）', () => {
    test('清单固定启停的插件在来源后标出「系统」，普通插件不标', () => {
        const { overlay } = createOverlay(createTUI());

        overlay.show();
        const text = overlay.render(120).join('\n');

        expect(text).toContain('opencodego');
        expect(text).toContain('System');
        // 普通内置插件只显示来源，不带「系统」标记
        const feishuLine = text.split('\n').find((line: string) => line.includes('feishu'));
        expect(feishuLine).toBeDefined();
        expect(feishuLine).not.toContain('System');
    });

    test('按切换键时固定启停的插件只提示原因，不进入确认框', () => {
        const { overlay } = createOverlay(createTUI());

        overlay.show();
        overlay.handleInput('d');

        expect(mockSetPluginEnabled).not.toHaveBeenCalled();
        expect(overlays).toHaveLength(1);
        expect(overlays[0]?.message).toContain('is fixed by OpenDesk');
    });

    test('普通插件仍可进入启停确认流程', () => {
        const { overlay } = createOverlay(createTUI());

        overlay.show();
        selectIndex(overlay, 1);
        overlay.handleInput('d');

        // 进入确认框：未直接改注册表，也没有弹出锁定提示
        expect(mockSetPluginEnabled).not.toHaveBeenCalled();
        expect(overlays).toHaveLength(0);
        expect(overlay.render(120).join('\n')).toContain('Confirm disable');
    });

    test('确认时若清单已在面板打开后被改成固定启停，按固定启停提示而不是「未找到插件」', async () => {
        const { overlay } = createOverlay(createTUI());
        overlay.show();
        selectIndex(overlay, 1);
        overlay.handleInput('d');
        expect(overlays).toHaveLength(0);

        // 模拟面板打开期间清单被改成 system: true：列表快照仍是 false，执行前需按当前清单复核
        mockIsPluginEnabledFixed.mockReturnValue(true);
        overlay.list.onSelect({ value: 'confirm' });
        await flush();

        expect(mockSetPluginEnabled).not.toHaveBeenCalled();
        expect(overlays).toHaveLength(1);
        expect(overlays[0]?.message).toContain('is fixed by OpenDesk');
    });

    test('普通插件确认后落注册表并交给调用方应用变更', async () => {
        const onToggle = jest.fn(async () => {});
        const { overlay } = createOverlay(createTUI(), { onToggle });

        overlay.show();
        selectIndex(overlay, 1);
        overlay.handleInput('d');
        overlay.list.onSelect({ value: 'confirm' });
        await flush();

        expect(mockSetPluginEnabled).toHaveBeenCalledWith('feishu', false);
        expect(onToggle).toHaveBeenCalledWith('feishu', false);
    });
});
