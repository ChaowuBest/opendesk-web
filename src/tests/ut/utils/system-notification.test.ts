import { jest, beforeEach, afterEach, describe, expect, it } from '@jest/globals';

type ClickHandler = () => void;
type FocusHandler = (_event: unknown, win: unknown) => void;

interface NotificationRecord {
    title: string;
    body: string;
    silent: boolean;
    shown: boolean;
    clickHandler: ClickHandler | null;
    closeHandler: ClickHandler | null;
    failedHandler: ClickHandler | null;
}

const sentMessages: Array<{ channel: string; args: unknown[] }> = [];
const notifications: NotificationRecord[] = [];

let notificationSupported = true;
let focusHandler: FocusHandler | null = null;

class MockNotification {
    static isSupported(): boolean {
        return notificationSupported;
    }

    constructor(options: { title: string; body: string; silent: boolean }) {
        notifications.push({
            title: options.title,
            body: options.body,
            silent: options.silent,
            shown: false,
            clickHandler: null,
            closeHandler: null,
            failedHandler: null
        });
    }

    show(): void {
        notifications[notifications.length - 1].shown = true;
    }

    on(event: string, handler: ClickHandler): void {
        const latest = notifications[notifications.length - 1];
        if (event === 'click') {
            latest.clickHandler = handler;
        } else if (event === 'close') {
            latest.closeHandler = handler;
        } else if (event === 'failed') {
            latest.failedHandler = handler;
        }
    }
}

const mockApp = {
    focus: jest.fn(),
    on: jest.fn((event: string, handler: FocusHandler) => {
        if (event === 'browser-window-focus') {
            focusHandler = handler;
        }
    }),
    removeListener: jest.fn((event: string, handler: FocusHandler) => {
        if (event === 'browser-window-focus' && focusHandler === handler) {
            focusHandler = null;
        }
    })
};

const mainWindow = {
    isDestroyed: () => false,
    isMinimized: () => true,
    isVisible: () => false,
    restore: jest.fn(),
    show: jest.fn(),
    moveTop: jest.fn(),
    setAlwaysOnTop: jest.fn(),
    focus: jest.fn(),
    webContents: {
        send: jest.fn((channel: string, ...args: unknown[]) => {
            sentMessages.push({ channel, args });
        })
    }
};

jest.unstable_mockModule('../../../utils/electron.js', () => ({
    electron: () => ({
        Notification: MockNotification,
        app: mockApp
    })
}));

jest.unstable_mockModule('../../../main/utils/logger.js', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

const {
    showTaskNotification,
    registerNotificationMainWindowResolver,
    clearPendingOpenTasks,
    clearLiveNotifications,
    getLiveNotificationCount
} = await import('../../../main/utils/system-notification.js');

function clickLatestNotification(): void {
    const latest = notifications[notifications.length - 1];
    expect(latest.clickHandler).not.toBeNull();
    latest.clickHandler!();
}

function focusMainWindow(): void {
    expect(focusHandler).not.toBeNull();
    focusHandler!({}, mainWindow);
}

function openTaskMessages(): unknown[][] {
    return sentMessages.filter((msg) => msg.channel === 'command:openTask').map((msg) => msg.args);
}

const realPlatform = process.platform;

/** 把 process.platform 临时伪装成指定平台：前台锁规避只在 Windows 生效 */
function stubPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('system-notification', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        sentMessages.length = 0;
        notifications.length = 0;
        notificationSupported = true;
        mainWindow.restore.mockClear();
        mainWindow.show.mockClear();
        mainWindow.moveTop.mockClear();
        mainWindow.setAlwaysOnTop.mockClear();
        mainWindow.focus.mockClear();
        // 待打开任务与存活通知都是模块级状态，逐个用例之间必须清空
        clearPendingOpenTasks();
        clearLiveNotifications();
        registerNotificationMainWindowResolver(() => mainWindow as never);
    });

    afterEach(() => {
        jest.useRealTimers();
        stubPlatform(realPlatform);
    });

    it('推送通知并携带标题与正文', () => {
        showTaskNotification({ title: '权限确认', body: '请确认', taskId: 'task-1' });

        expect(notifications).toHaveLength(1);
        expect(notifications[0].title).toBe('权限确认');
        expect(notifications[0].body).toBe('请确认');
        expect(notifications[0].shown).toBe(true);
    });

    it('系统不支持通知时不创建通知', () => {
        notificationSupported = false;

        showTaskNotification({ title: '权限确认', body: '请确认', taskId: 'task-1' });

        expect(notifications).toHaveLength(0);
    });

    it('点击通知唤起主窗口并打开对应任务', () => {
        showTaskNotification({ title: '权限确认', body: '请确认', taskId: 'task-42' });
        clickLatestNotification();

        expect(mainWindow.restore).toHaveBeenCalled();
        expect(mainWindow.show).toHaveBeenCalled();
        expect(mainWindow.moveTop).toHaveBeenCalled();
        expect(mainWindow.focus).toHaveBeenCalled();

        jest.advanceTimersByTime(200);
        expect(openTaskMessages()).toEqual([['task-42']]);
    });

    it('Windows 上点击通知用临时置顶绕过前台锁，把窗口真正带到前台', () => {
        // 复现：Windows 的 SetForegroundWindow 受前台锁限制，后台进程只调 focus()
        // 通常只让任务栏图标闪一下，窗口仍被其它应用盖住，用户看到的现象就是
        // 「点了通知没有任何反应」。置顶期间 focus() 不受前台锁约束。
        stubPlatform('win32');

        showTaskNotification({ title: '权限确认', body: '请确认', taskId: 'task-win' });
        clickLatestNotification();

        // 置顶先于 focus 生效，且不能在同一个 tick 里撤销
        expect(mainWindow.setAlwaysOnTop.mock.calls).toEqual([[true]]);
        expect(mainWindow.focus).toHaveBeenCalled();

        jest.advanceTimersByTime(200);
        // 置顶必须撤销，不能把主窗口永久钉在最前面
        expect(mainWindow.setAlwaysOnTop.mock.calls).toEqual([[true], [false]]);
        expect(openTaskMessages()).toEqual([['task-win']]);
    });

    it('非 Windows 平台不做置顶切换', () => {
        stubPlatform('linux');

        showTaskNotification({ title: '权限确认', body: '请确认', taskId: 'task-linux' });
        clickLatestNotification();

        expect(mainWindow.setAlwaysOnTop).not.toHaveBeenCalled();
        expect(mainWindow.focus).toHaveBeenCalled();
    });

    it('点击通知后释放引用，避免 JS 包装残留', () => {
        showTaskNotification({ title: '权限确认', body: '请确认', taskId: 'task-gc' });
        expect(getLiveNotificationCount()).toBe(1);

        clickLatestNotification();

        expect(getLiveNotificationCount()).toBe(0);
    });

    it('通知被系统关闭或推送失败后释放引用', () => {
        showTaskNotification({ title: '权限确认', body: '请确认', taskId: 'task-a' });
        showTaskNotification({ title: '权限确认', body: '请确认', taskId: 'task-b' });
        expect(getLiveNotificationCount()).toBe(2);

        // close / failed 之后都不会再有点击，引用可以丢掉，否则只能等 TTL 惰性回收
        notifications[0].closeHandler!();
        expect(getLiveNotificationCount()).toBe(1);
        notifications[1].failedHandler!();
        expect(getLiveNotificationCount()).toBe(0);
    });

    it('通知引用存活期按小时级保留，远超待打开任务的 10 分钟', () => {
        // 待打开任务过期只意味着不再自动跳转；用户稍后点通知仍应能唤起窗口，
        // 因此通知引用不能跟待打开任务的 TTL 绑在一起，否则点了同样毫无反应。
        // 惰性回收只在推送新通知时触发，所以这里靠「30 分钟后再推一条」观察第一条是否被清掉
        showTaskNotification({ title: '权限确认', body: '请确认', taskId: 'task-late' });

        jest.advanceTimersByTime(30 * 60 * 1000);
        showTaskNotification({ title: '权限确认', body: '请确认', taskId: 'task-later' });

        expect(getLiveNotificationCount()).toBe(2);

        // 30 分钟前那条仍然可点：能唤起窗口并按自己的任务跳转
        notifications[0].clickHandler!();
        jest.advanceTimersByTime(200);

        expect(mainWindow.show).toHaveBeenCalled();
        expect(openTaskMessages()).toEqual([['task-late']]);
    });

    it('通知 click 未投递时，主窗口获得焦点仍会打开任务', () => {
        // Linux 上部分通知守护进程只激活应用、不投递 click 事件
        showTaskNotification({ title: '权限确认', body: '请确认', taskId: 'task-7' });

        focusMainWindow();
        jest.advanceTimersByTime(200);

        expect(openTaskMessages()).toEqual([['task-7']]);
    });

    it('多条并发通知未 click 时，焦点兜底不猜任务', () => {
        // AskUser 可单 turn 并发多个、ExitPlanMode 可跨任务并行；
        // 无法判断用户点的是哪条通知，宁可不动也不跳错任务
        showTaskNotification({ title: '问题 1', body: 'q1', taskId: 'task-a' });
        showTaskNotification({ title: '问题 2', body: 'q2', taskId: 'task-b' });

        focusMainWindow();
        jest.advanceTimersByTime(200);

        expect(openTaskMessages()).toEqual([]);
    });

    it('多任务通知点击时精确跳转到被点的那一条', () => {
        showTaskNotification({ title: '问题 1', body: 'q1', taskId: 'task-a' });
        showTaskNotification({ title: '问题 2', body: 'q2', taskId: 'task-b' });

        // 点第二条通知：只有它自己的闭包跳转，兜底不参与
        clickLatestNotification();
        jest.advanceTimersByTime(200);

        expect(openTaskMessages()).toEqual([['task-b']]);
    });

    it('同任务的多条通知只保留一条待打开记录', () => {
        showTaskNotification({ title: '问题', body: 'q1', taskId: 'task-a' });
        showTaskNotification({ title: '问题', body: 'q1', taskId: 'task-a' });

        focusMainWindow();
        jest.advanceTimersByTime(200);

        expect(openTaskMessages()).toEqual([['task-a']]);
    });

    it('click 已处理时焦点兜底不会重复打开同一个任务', () => {
        showTaskNotification({ title: '权限确认', body: '请确认', taskId: 'task-9' });

        clickLatestNotification();
        focusMainWindow();
        jest.advanceTimersByTime(200);

        expect(openTaskMessages()).toEqual([['task-9']]);
    });

    it('待打开任务只消费一次，后续获得焦点不再跳转', () => {
        showTaskNotification({ title: '权限确认', body: '请确认', taskId: 'task-3' });

        focusMainWindow();
        focusMainWindow();
        jest.advanceTimersByTime(200);

        expect(openTaskMessages()).toEqual([['task-3']]);
    });

    it('未携带 taskId 时只唤起窗口，不跳转任务', () => {
        showTaskNotification({ title: '权限确认', body: '请确认' });
        clickLatestNotification();

        expect(mainWindow.show).toHaveBeenCalled();
        jest.advanceTimersByTime(200);
        expect(openTaskMessages()).toEqual([]);
    });

    it('未注入主窗口时点击通知不抛错', () => {
        registerNotificationMainWindowResolver(() => null);
        showTaskNotification({ title: '权限确认', body: '请确认', taskId: 'task-1' });

        expect(() => clickLatestNotification()).not.toThrow();
        jest.advanceTimersByTime(200);
        expect(openTaskMessages()).toEqual([]);
    });

    it('请求已在应用内应答后，焦点兜底不再跳到该任务', () => {
        showTaskNotification({ title: '权限确认', body: '请确认', taskId: 'task-answered' });
        // 用户没点通知、直接在应用内应答了：provider 结算时必须清掉这条待打开记录，
        // 否则用户之后任意一次切回窗口都会被强制跳到该任务上。
        clearPendingOpenTasks('task-answered');

        focusMainWindow();
        jest.advanceTimersByTime(200);

        expect(openTaskMessages()).toEqual([]);
    });

    it('按 taskId 清理只影响指定任务，其余待打开任务保留', () => {
        showTaskNotification({ title: '权限确认', body: '请确认', taskId: 'task-x' });
        showTaskNotification({ title: '权限确认', body: '请确认', taskId: 'task-y' });

        clearPendingOpenTasks('task-x');

        focusMainWindow();
        jest.advanceTimersByTime(200);
        expect(openTaskMessages()).toEqual([['task-y']]);
    });

    it('点击某条通知后，焦点兜底不会再跳到其它待打开任务', () => {
        // AskUser 一轮多问、ExitPlanMode 跨任务并行会同时留下多条待打开任务。
        // click 已代表用户明确了目标，win.focus() 同步派发的焦点兜底不得再把另一条
        // 残留任务也跳出来——否则最终落在哪个任务取决于两个定时器的注册顺序。
        showTaskNotification({ title: '权限确认', body: '请确认', taskId: 'task-a' });
        showTaskNotification({ title: '权限确认', body: '请确认', taskId: 'task-b' });

        mainWindow.focus.mockImplementation(() => focusMainWindow());
        try {
            notifications[0].clickHandler!();
            jest.advanceTimersByTime(200);
        } finally {
            mainWindow.focus.mockImplementation(() => undefined);
        }

        expect(openTaskMessages()).toEqual([['task-a']]);
    });

    it('哨兵 taskId 不记录待打开任务', () => {
        // AskUser 在拿不到 taskState 时会下发 'unknown' 占位，跳过去只会让 renderer
        // 去打开一个不存在的任务。
        showTaskNotification({ title: '需要输入', body: '请回答', taskId: 'unknown' });

        focusMainWindow();
        clickLatestNotification();
        jest.advanceTimersByTime(200);

        expect(openTaskMessages()).toEqual([]);
    });
});
