/**
 * 复现「主窗口处于后台/最小化/隐藏状态时关闭，关闭确认弹窗在用户看不到的地方弹出，
 * 应用表现为卡死无响应」的问题：
 *
 * 原实现（src/main/main.ts 内联 close 处理器）在发送 closeWindow:request 前没有把
 * 主窗口带到前台。用户在任务栏右键关闭窗口、或窗口被其他应用遮挡时，应用内模态弹窗
 * 虽然弹出了，但窗口仍在后台，用户看不到任何反馈，误以为应用卡住。
 *
 * 期望行为：配置未设置关闭动作时，发送弹窗请求前必须先 restore/show/moveTop/focus
 * 主窗口；quit/minimize 配置不触发弹窗；应用退出中直接放行关闭并保存窗口 bounds。
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

import {
    createMainWindowCloseHandler,
    bringMainWindowToForeground,
    CLOSE_DIALOG_REQUEST_CHANNEL,
    CLOSE_DIALOG_RESPONSE_CHANNEL
} from '../../../main/utils/window-close.js';
import type { MainWindowLike, MainWindowCloseHandlerDeps } from '../../../main/utils/window-close.js';

type CloseEvent = { preventDefault(): void };

const realPlatform = process.platform;

/** 把 process.platform 临时伪装成指定平台：前台锁规避只在 Windows 生效 */
function stubPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

// 置顶撤销走 setTimeout，统一用假定时器，避免跨用例残留的定时器打到下一个用例的 mock 上
beforeEach(() => {
    jest.useFakeTimers();
    // 默认固定成非 Windows 平台，让用例断言不随宿主机平台漂移；平台相关用例自己覆盖
    stubPlatform('darwin');
});

afterEach(() => {
    jest.useRealTimers();
    stubPlatform(realPlatform);
});

function makeWindow(overrides: Record<string, unknown> = {}): MainWindowLike {
    const win = {
        webContents: { send: jest.fn() },
        isDestroyed: () => false,
        isMinimized: jest.fn(() => false),
        isVisible: jest.fn(() => true),
        isMaximized: jest.fn(() => false),
        getNormalBounds: jest.fn(() => ({ x: 10, y: 20, width: 300, height: 200 })),
        restore: jest.fn(),
        show: jest.fn(),
        hide: jest.fn(),
        moveTop: jest.fn(),
        setAlwaysOnTop: jest.fn(),
        focus: jest.fn()
    };
    return { ...win, ...overrides } as unknown as MainWindowLike;
}

interface DepsOverrides {
    data?: Record<string, unknown>;
    window?: MainWindowLike;
    isAppQuitting?: () => boolean;
}

function makeDeps(overrides: DepsOverrides = {}) {
    const data = overrides.data ?? ({ gui_config: {} } as Record<string, unknown>);
    const deps = {
        isAppQuitting: overrides.isAppQuitting ?? (() => false),
        window: overrides.window ?? makeWindow(),
        getSettingData: () => data,
        saveSettingData: jest.fn(),
        ipcMain: { on: jest.fn(), removeListener: jest.fn() },
        quit: jest.fn(),
        sendToRenderer: jest.fn(() => true),
        now: () => 123456
    } as unknown as MainWindowCloseHandlerDeps;
    return { deps, data };
}

/** 取出注册在 ipcMain 上的弹窗响应回调 */
function takeResponseHandler(
    deps: MainWindowCloseHandlerDeps
): (event: unknown, requestId: unknown, response: unknown) => void {
    const ipcMain = deps.ipcMain as { on: jest.Mock; removeListener: jest.Mock };
    const call = ipcMain.on.mock.calls.find(([channel]) => channel === CLOSE_DIALOG_RESPONSE_CHANNEL);
    return call?.[1] as (event: unknown, requestId: unknown, response: unknown) => void;
}

describe('bringMainWindowToForeground', () => {
    it('最小化窗口：先 restore，再补 show，最后 moveTop + focus', () => {
        const win = makeWindow({ isMinimized: () => true, isVisible: () => false });
        bringMainWindowToForeground(win);
        expect(win.restore).toHaveBeenCalledTimes(1);
        expect(win.show).toHaveBeenCalledTimes(1);
        expect(win.moveTop).toHaveBeenCalledTimes(1);
        expect(win.focus).toHaveBeenCalledTimes(1);
    });

    it('隐藏窗口：show + moveTop + focus', () => {
        const win = makeWindow({ isVisible: () => false });
        bringMainWindowToForeground(win);
        expect(win.restore).not.toHaveBeenCalled();
        expect(win.show).toHaveBeenCalledTimes(1);
        expect(win.moveTop).toHaveBeenCalledTimes(1);
        expect(win.focus).toHaveBeenCalledTimes(1);
    });

    it('可见但处于后台的窗口：不 restore/show，只 moveTop + focus', () => {
        const win = makeWindow();
        bringMainWindowToForeground(win);
        expect(win.restore).not.toHaveBeenCalled();
        expect(win.show).not.toHaveBeenCalled();
        expect(win.moveTop).toHaveBeenCalledTimes(1);
        expect(win.focus).toHaveBeenCalledTimes(1);
    });

    it('窗口已销毁时直接返回，不做任何窗口操作', () => {
        // 托盘/第二实例可能还持有已销毁的旧窗口引用
        const win = makeWindow({ isDestroyed: () => true });
        bringMainWindowToForeground(win);

        expect(win.restore).not.toHaveBeenCalled();
        expect(win.show).not.toHaveBeenCalled();
        expect(win.moveTop).not.toHaveBeenCalled();
        expect(win.focus).not.toHaveBeenCalled();
    });

    it('Windows 上用临时置顶绕过前台锁，聚焦后再撤销置顶', () => {
        // 复现：Windows 前台锁让后台进程的 focus() 只闪任务栏，窗口仍被盖住
        const setAlwaysOnTop = jest.fn();
        const win = makeWindow({ isVisible: () => false, setAlwaysOnTop });
        stubPlatform('win32');

        bringMainWindowToForeground(win);

        expect(win.show).toHaveBeenCalledTimes(1);
        expect(win.focus).toHaveBeenCalledTimes(1);
        // 置顶必须先于 focus 生效，且不能在同一个 tick 里撤销：
        // SetForegroundWindow 在目标窗口线程上异步生效，抢在它之前撤顶会让前台锁重新生效
        expect(setAlwaysOnTop.mock.calls).toEqual([[true]]);

        jest.advanceTimersByTime(50);
        expect(setAlwaysOnTop.mock.calls).toEqual([[true], [false]]);
    });

    it('窗口在撤顶前已销毁时不再操作窗口', () => {
        const setAlwaysOnTop = jest.fn();
        let destroyed = false;
        const win = makeWindow({ isVisible: () => false, setAlwaysOnTop, isDestroyed: () => destroyed });
        stubPlatform('win32');

        bringMainWindowToForeground(win);
        destroyed = true;
        jest.advanceTimersByTime(50);

        expect(setAlwaysOnTop.mock.calls).toEqual([[true]]);
    });

    it('非 Windows 平台不做置顶切换', () => {
        const setAlwaysOnTop = jest.fn();
        const win = makeWindow({ isVisible: () => false, setAlwaysOnTop });
        stubPlatform('linux');

        bringMainWindowToForeground(win);

        expect(setAlwaysOnTop).not.toHaveBeenCalled();
        expect(win.focus).toHaveBeenCalledTimes(1);
    });
});

describe('createMainWindowCloseHandler 关闭确认弹窗', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('bug 复现：窗口最小化时关闭，先把窗口恢复并带到前台，再发送弹窗请求', () => {
        const win = makeWindow({ isMinimized: () => true, isVisible: () => false });
        const { deps } = makeDeps({ window: win });
        const handler = createMainWindowCloseHandler(deps);
        const preventDefault = jest.fn();

        handler({ preventDefault } as CloseEvent);

        expect(preventDefault).toHaveBeenCalledTimes(1);
        // 前台化必须在发送弹窗请求前完成
        expect(win.restore).toHaveBeenCalledTimes(1);
        expect(win.show).toHaveBeenCalledTimes(1);
        expect(win.moveTop).toHaveBeenCalledTimes(1);
        expect(win.focus).toHaveBeenCalledTimes(1);
        expect(deps.sendToRenderer).toHaveBeenCalledWith(CLOSE_DIALOG_REQUEST_CHANNEL, 'close-123456');
    });

    it('bug 复现：窗口在后台（可见但未获焦）时关闭，moveTop + focus 带到前台', () => {
        const win = makeWindow();
        const { deps } = makeDeps({ window: win });
        const handler = createMainWindowCloseHandler(deps);

        handler({ preventDefault: jest.fn() } as CloseEvent);

        expect(win.restore).not.toHaveBeenCalled();
        expect(win.show).not.toHaveBeenCalled();
        expect(win.moveTop).toHaveBeenCalledTimes(1);
        expect(win.focus).toHaveBeenCalledTimes(1);
        expect(deps.sendToRenderer).toHaveBeenCalledWith(CLOSE_DIALOG_REQUEST_CHANNEL, 'close-123456');
    });

    it('bug 复现：窗口隐藏时关闭，show 到前台后发送弹窗请求', () => {
        const win = makeWindow({ isVisible: () => false });
        const { deps } = makeDeps({ window: win });
        const handler = createMainWindowCloseHandler(deps);

        handler({ preventDefault: jest.fn() } as CloseEvent);

        expect(win.show).toHaveBeenCalledTimes(1);
        expect(win.moveTop).toHaveBeenCalledTimes(1);
        expect(win.focus).toHaveBeenCalledTimes(1);
        expect(deps.sendToRenderer).toHaveBeenCalledWith(CLOSE_DIALOG_REQUEST_CHANNEL, 'close-123456');
    });

    it('配置为 quit：直接退出，不弹窗也不前台化', () => {
        const { deps } = makeDeps({ data: { gui_config: { on_mainwindow_close: 'quit' } } });
        const handler = createMainWindowCloseHandler(deps);

        handler({ preventDefault: jest.fn() } as CloseEvent);

        expect(deps.quit).toHaveBeenCalledTimes(1);
        expect(deps.sendToRenderer).not.toHaveBeenCalled();
        expect(deps.window.restore).not.toHaveBeenCalled();
        expect(deps.window.focus).not.toHaveBeenCalled();
    });

    it('配置为 minimize：直接隐藏窗口，不弹窗', () => {
        const { deps } = makeDeps({ data: { gui_config: { on_mainwindow_close: 'minimize' } } });
        const handler = createMainWindowCloseHandler(deps);

        handler({ preventDefault: jest.fn() } as CloseEvent);

        expect(deps.window.hide).toHaveBeenCalledTimes(1);
        expect(deps.sendToRenderer).not.toHaveBeenCalled();
    });

    it('应用退出中：放行关闭（不 preventDefault），保存窗口 bounds', () => {
        const { deps } = makeDeps({ isAppQuitting: () => true });
        const handler = createMainWindowCloseHandler(deps);
        const preventDefault = jest.fn();

        handler({ preventDefault } as CloseEvent);

        expect(preventDefault).not.toHaveBeenCalled();
        expect(deps.sendToRenderer).not.toHaveBeenCalled();
        expect(deps.saveSettingData).toHaveBeenCalledWith({
            gui_config: { window_bounds: { x: 10, y: 20, width: 300, height: 200 } }
        });
    });

    it('Linux 阴影窗口退出：normalizeSaveBounds 收缩窗口 bounds 后保存视觉 bounds', () => {
        // 窗口矩形 = 视觉矩形 + 四周阴影边距；getNormalBounds 返回的是窗口矩形，
        // 保存到 gui_config.window_bounds 的必须是视觉矩形（与其他平台/历史数据语义一致）
        const win = makeWindow({
            getNormalBounds: jest.fn(() => ({ x: 80, y: 30, width: 840, height: 640 }))
        });
        const { deps } = makeDeps({ window: win, isAppQuitting: () => true });
        deps.normalizeSaveBounds = (bounds) => {
            const margin = 20;
            return {
                x: bounds.x + margin,
                y: bounds.y + margin,
                width: bounds.width - margin * 2,
                height: bounds.height - margin * 2
            };
        };
        const handler = createMainWindowCloseHandler(deps);

        handler({ preventDefault: jest.fn() } as CloseEvent);

        expect(deps.saveSettingData).toHaveBeenCalledWith({
            gui_config: { window_bounds: { x: 100, y: 50, width: 800, height: 600 } }
        });
    });

    it('非最大化退出：window_bounds 不携带 is_maximized 字段', () => {
        const win = makeWindow({ isMaximized: jest.fn(() => false) });
        const { deps } = makeDeps({ window: win, isAppQuitting: () => true });
        const handler = createMainWindowCloseHandler(deps);

        handler({ preventDefault: jest.fn() } as CloseEvent);

        const saved = (deps.saveSettingData as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
        expect(saved.gui_config).toEqual({
            window_bounds: { x: 10, y: 20, width: 300, height: 200 }
        });
    });

    it('最大化状态退出：保存 is_maximized 且 bounds 取可信 normal bounds（bug 复现）', () => {
        // bug 复现：Linux 透明无边框窗口最大化后 getNormalBounds() 可能返回
        // 最大化尺寸（restored bounds 缓存被污染）。若把坏值当 normal bounds
        // 持久化，下次启动 setBounds 还原出"假最大化"窗口。
        const badMaximizedBounds = { x: 0, y: 0, width: 1920, height: 1080 };
        const realNormalBounds = { x: 100, y: 80, width: 1200, height: 800 };
        const win = makeWindow({
            isMaximized: jest.fn(() => true),
            getNormalBounds: jest.fn(() => badMaximizedBounds)
        });
        const { deps } = makeDeps({ window: win, isAppQuitting: () => true });
        deps.getTrustedNormalBounds = () => realNormalBounds;
        const handler = createMainWindowCloseHandler(deps);

        handler({ preventDefault: jest.fn() } as CloseEvent);

        expect(deps.saveSettingData).toHaveBeenCalledWith({
            gui_config: {
                window_bounds: { ...realNormalBounds, is_maximized: true }
            }
        });
    });

    it('最大化状态退出且未注入可信 bounds 时：回退 getNormalBounds() 并保存 is_maximized', () => {
        const badMaximizedBounds = { x: 0, y: 0, width: 1920, height: 1080 };
        const win = makeWindow({
            isMaximized: jest.fn(() => true),
            getNormalBounds: jest.fn(() => badMaximizedBounds)
        });
        const { deps } = makeDeps({ window: win, isAppQuitting: () => true });
        const handler = createMainWindowCloseHandler(deps);

        handler({ preventDefault: jest.fn() } as CloseEvent);

        expect(deps.saveSettingData).toHaveBeenCalledWith({
            gui_config: {
                window_bounds: { ...badMaximizedBounds, is_maximized: true }
            }
        });
    });

    it('用户选择退出：调用 quit 并移除响应监听', () => {
        const { deps } = makeDeps();
        const handler = createMainWindowCloseHandler(deps);

        handler({ preventDefault: jest.fn() } as CloseEvent);
        takeResponseHandler(deps)(null, 'close-123456', { action: 'quit', dontAsk: false });

        expect(deps.quit).toHaveBeenCalledTimes(1);
        expect(deps.window.hide).not.toHaveBeenCalled();
        expect(deps.ipcMain.removeListener).toHaveBeenCalledWith(CLOSE_DIALOG_RESPONSE_CHANNEL, expect.any(Function));
    });

    it('用户选择最小化：隐藏窗口', () => {
        const { deps } = makeDeps();
        const handler = createMainWindowCloseHandler(deps);

        handler({ preventDefault: jest.fn() } as CloseEvent);
        takeResponseHandler(deps)(null, 'close-123456', { action: 'minimize', dontAsk: false });

        expect(deps.window.hide).toHaveBeenCalledTimes(1);
        expect(deps.quit).not.toHaveBeenCalled();
    });

    it('用户取消：既不退出也不隐藏，且可以再次触发弹窗', () => {
        const { deps } = makeDeps();
        const handler = createMainWindowCloseHandler(deps);

        handler({ preventDefault: jest.fn() } as CloseEvent);
        takeResponseHandler(deps)(null, 'close-123456', { action: 'cancel', dontAsk: false });
        expect(deps.quit).not.toHaveBeenCalled();
        expect(deps.window.hide).not.toHaveBeenCalled();

        // 取消后再次关闭应重新弹窗
        handler({ preventDefault: jest.fn() } as CloseEvent);
        expect(deps.sendToRenderer).toHaveBeenCalledTimes(2);
    });

    it('勾选不再询问并选择退出：持久化配置为 quit 后退出', () => {
        const { deps, data } = makeDeps();
        const handler = createMainWindowCloseHandler(deps);

        handler({ preventDefault: jest.fn() } as CloseEvent);
        takeResponseHandler(deps)(null, 'close-123456', { action: 'quit', dontAsk: true });

        expect(deps.saveSettingData).toHaveBeenCalledTimes(1);
        expect((data.gui_config as Record<string, unknown>).on_mainwindow_close).toBe('quit');
        expect(deps.quit).toHaveBeenCalledTimes(1);
    });

    it('弹窗已展示期间重复关闭：不重复发送请求', () => {
        const win = makeWindow({ isMinimized: () => true, isVisible: () => false });
        const { deps } = makeDeps({ window: win });
        const handler = createMainWindowCloseHandler(deps);

        handler({ preventDefault: jest.fn() } as CloseEvent);
        handler({ preventDefault: jest.fn() } as CloseEvent);

        expect(deps.sendToRenderer).toHaveBeenCalledTimes(1);
        // 前台化只在第一次关闭时执行
        expect(win.restore).toHaveBeenCalledTimes(1);
        expect(win.focus).toHaveBeenCalledTimes(1);
    });

    it('响应 requestId 不匹配时忽略，匹配后才移除监听', () => {
        const { deps } = makeDeps();
        const handler = createMainWindowCloseHandler(deps);

        handler({ preventDefault: jest.fn() } as CloseEvent);
        const respond = takeResponseHandler(deps);

        respond(null, 'close-other-id', { action: 'quit', dontAsk: false });
        expect(deps.quit).not.toHaveBeenCalled();
        expect(deps.ipcMain.removeListener).not.toHaveBeenCalled();

        respond(null, 'close-123456', { action: 'quit', dontAsk: false });
        expect(deps.quit).toHaveBeenCalledTimes(1);
        expect(deps.ipcMain.removeListener).toHaveBeenCalledWith(CLOSE_DIALOG_RESPONSE_CHANNEL, expect.any(Function));
    });
});
