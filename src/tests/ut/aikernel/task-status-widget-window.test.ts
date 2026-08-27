import { jest } from '@jest/globals';

/**
 * 浮窗窗口创建行为的回归测试：
 * 浮窗外壳尺寸固定（340×215），必须与主窗口的页面缩放完全隔离，
 * 否则用户放大界面（设置 scale_factor / Ctrl+{+,-}）会让浮窗内容溢出出现滚动条。
 */

interface CapturedWindow {
    options: any;
    webContents: {
        setVisualZoomLevelLimits: jest.Mock;
        setZoomFactor: jest.Mock;
        isLoading: () => boolean;
        on: jest.Mock;
        once: jest.Mock;
    };
}

const createdWindows: CapturedWindow[] = [];

class FakeBrowserWindow {
    options: any;
    webContents: CapturedWindow['webContents'];

    constructor(options: any) {
        this.options = options;
        this.webContents = {
            setVisualZoomLevelLimits: jest.fn(),
            setZoomFactor: jest.fn(),
            isLoading: () => false,
            on: jest.fn(),
            once: jest.fn()
        };
        createdWindows.push(this as unknown as CapturedWindow);
    }

    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setMenu() {}
    setBounds() {}
    getBounds() {
        return { x: 0, y: 0, width: 340, height: 215 };
    }
    on() {}
    once() {}
    isDestroyed() {
        return false;
    }
    isVisible() {
        return false;
    }
    showInactive() {}
    hide() {}
}

jest.unstable_mockModule('electron', () => ({
    app: { focus: jest.fn() },
    BrowserWindow: FakeBrowserWindow,
    ipcMain: { handle: jest.fn(), on: jest.fn() },
    screen: {
        getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
        getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
    }
}));

const { initTaskStatusWidget, setMainWindowHidden } =
    await import('../../../main/windows/task-status-widget-window.js');

beforeAll(() => {
    initTaskStatusWidget({
        getPreloadPath: () => '/tmp/preload.js',
        getMainWindow: () => null,
        getTaskList: () => [{ task_id: 't1', task_name: 'Task', task_status: 'running' }],
        addTaskListSubscriber: () => 'sub-1',
        loadWidgetPage: () => {},
        getFloatingWindowMode: () => 'card'
    });
    // 主窗口隐藏触发浮窗创建。
    setMainWindowHidden(true);
});

describe('任务状态浮窗窗口', () => {
    test('使用独立 session partition，使页面缩放与主窗口隔离', () => {
        expect(createdWindows).toHaveLength(1);
        expect(createdWindows[0].options.webPreferences.partition).toBeTruthy();
    });

    test('禁止捏合缩放，锁定 100%', () => {
        expect(createdWindows[0].webContents.setVisualZoomLevelLimits).toHaveBeenCalledWith(1, 1);
    });
});
