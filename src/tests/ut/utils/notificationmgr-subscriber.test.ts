import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { NotificationManager } from '../../../main/utils/notificationmgr.js';

/**
 * 回归背景（内置浏览器触发的 "TypeError: Object has been destroyed" 崩溃）：
 * renderer 通过 notification:subscribeNotification 把 WebContents 注册进
 * NotificationManager.subscribers，但订阅者只增不删。窗口（如内置浏览器宿主）
 * 销毁后，任何 Worker 推送通知都会对已销毁的 WebContents 调用 send()，
 * 同步抛出 TypeError 并升级为 uncaughtException 导致整个应用退出。
 */

class MockSubscriber {
    id: string;
    send: jest.Mock;
    isDestroyed: jest.Mock;
    once: jest.Mock;
    private destroyedHandlers: Array<() => void> = [];

    constructor(id: string, destroyed = false) {
        this.id = id;
        this.send = jest.fn();
        this.isDestroyed = jest.fn(() => destroyed);
        this.once = jest.fn((_event: string, handler: () => void) => {
            this.destroyedHandlers.push(handler);
            return this;
        });
    }

    emitDestroyed(): void {
        for (const handler of this.destroyedHandlers.splice(0)) {
            handler();
        }
    }
}

function asSubscriber(subscriber: MockSubscriber): Electron.WebContents {
    return subscriber as unknown as Electron.WebContents;
}

describe('NotificationManager 订阅者生命周期', () => {
    let manager: NotificationManager;

    beforeEach(() => {
        NotificationManager.instance = null;
        manager = NotificationManager.getInstance();
    });

    test('sendNotification 跳过已销毁的订阅者且不抛错', () => {
        const destroyed = new MockSubscriber('destroyed', true);
        manager.addSubscriber(asSubscriber(destroyed));

        expect(() => manager.sendNotification('info', 'test', 'title', 'message')).not.toThrow();
        expect(destroyed.send).not.toHaveBeenCalled();
    });

    test('已销毁的订阅者不影响其他订阅者接收通知', () => {
        const alive1 = new MockSubscriber('alive1');
        const destroyed = new MockSubscriber('destroyed', true);
        const alive2 = new MockSubscriber('alive2');
        manager.addSubscriber(asSubscriber(alive1));
        manager.addSubscriber(asSubscriber(destroyed));
        manager.addSubscriber(asSubscriber(alive2));

        manager.sendNotification('warning', '日历', '提醒', '会议即将开始');

        expect(alive1.send).toHaveBeenCalledWith(
            'notification:notificationReceived',
            'warning',
            '日历',
            '提醒',
            '会议即将开始'
        );
        expect(alive2.send).toHaveBeenCalledWith(
            'notification:notificationReceived',
            'warning',
            '日历',
            '提醒',
            '会议即将开始'
        );
        expect(destroyed.send).not.toHaveBeenCalled();
    });

    test('sendNotification 后清理已销毁的订阅者，避免泄漏', () => {
        const alive = new MockSubscriber('alive');
        const destroyed = new MockSubscriber('destroyed', true);
        manager.addSubscriber(asSubscriber(alive));
        manager.addSubscriber(asSubscriber(destroyed));

        manager.sendNotification('info', 'test', 'title', 'message');

        expect(manager.subscribers).toEqual([alive]);
    });

    test('订阅时挂载 destroyed 监听，窗口销毁即摘除订阅者', () => {
        const subscriber = new MockSubscriber('webcontents');
        manager.addSubscriber(asSubscriber(subscriber));

        expect(subscriber.once).toHaveBeenCalledWith('destroyed', expect.any(Function));

        // 不发通知也能摘除：长期不发通知的场景下死引用不会常驻
        subscriber.emitDestroyed();

        expect(manager.subscribers).toEqual([]);
    });

    test('活跃订阅者 send 抛错不中断广播，其余订阅者仍收到通知', () => {
        const broken = new MockSubscriber('broken');
        broken.send.mockImplementation(() => {
            throw new TypeError('Object has been destroyed');
        });
        const alive = new MockSubscriber('alive');
        manager.addSubscriber(asSubscriber(broken));
        manager.addSubscriber(asSubscriber(alive));

        expect(() => manager.sendNotification('info', 'test', 'title', 'message')).not.toThrow();
        expect(alive.send).toHaveBeenCalledTimes(1);
    });

    test('send 抛错但订阅者并未销毁时保留订阅者（真实 bug 不应被静默摘除）', () => {
        const broken = new MockSubscriber('broken');
        broken.send.mockImplementation(() => {
            throw new TypeError('An object could not be cloned.');
        });
        manager.addSubscriber(asSubscriber(broken));

        manager.sendNotification('info', 'test', 'title', 'message');

        expect(manager.subscribers).toEqual([broken]);
    });

    test('isDestroyed 自身抛错的订阅者按已销毁处理并摘除', () => {
        const weird = new MockSubscriber('weird');
        weird.isDestroyed.mockImplementation(() => {
            throw new TypeError('Object has been destroyed');
        });
        manager.addSubscriber(asSubscriber(weird));

        expect(() => manager.sendNotification('info', 'test', 'title', 'message')).not.toThrow();
        expect(manager.subscribers).toEqual([]);
    });

    test('removeDestroyedSubscribers 清理已销毁订阅者', () => {
        const alive = new MockSubscriber('alive');
        const destroyed1 = new MockSubscriber('destroyed1', true);
        const destroyed2 = new MockSubscriber('destroyed2', true);
        manager.addSubscriber(asSubscriber(destroyed1));
        manager.addSubscriber(asSubscriber(alive));
        manager.addSubscriber(asSubscriber(destroyed2));

        manager.removeDestroyedSubscribers();

        expect(manager.subscribers).toEqual([alive]);
    });

    test('拒绝空订阅者，避免广播时抛 "Cannot read properties of null"', () => {
        expect(() => manager.addSubscriber(null as unknown as Electron.WebContents)).not.toThrow();
        expect(manager.subscribers).toEqual([]);
    });

    test('destroyed 回调中读取订阅者标识失败也不会抛错', () => {
        const subscriber = new MockSubscriber('unreadable');
        manager.addSubscriber(asSubscriber(subscriber));
        // 对象销毁后连 id 属性都可能读不了：日志不能成为新的崩溃点
        Object.defineProperty(subscriber, 'id', {
            get() {
                throw new TypeError('Object has been destroyed');
            }
        });

        expect(() => subscriber.emitDestroyed()).not.toThrow();
        expect(manager.subscribers).toEqual([]);
    });

    test('日志取标识失败不影响通知投递', () => {
        const subscriber = new MockSubscriber('unreadable');
        manager.addSubscriber(asSubscriber(subscriber));
        Object.defineProperty(subscriber, 'id', {
            get() {
                throw new TypeError('Object has been destroyed');
            }
        });

        expect(() => manager.sendNotification('info', 'test', 'title', 'message')).not.toThrow();
        expect(subscriber.send).toHaveBeenCalledTimes(1);
    });

    test('没有 isDestroyed/once 方法的订阅者按普通对象处理，正常接收', () => {
        const plain = { id: 'plain', send: jest.fn() };
        manager.addSubscriber(plain as unknown as Electron.WebContents);

        expect(() => manager.sendNotification('info', 'test', 'title', 'message')).not.toThrow();
        expect(plain.send).toHaveBeenCalledTimes(1);
    });

    test('重复订阅已存在订阅者仍被跳过', () => {
        const subscriber = new MockSubscriber('dup');
        manager.addSubscriber(asSubscriber(subscriber));
        manager.addSubscriber(asSubscriber(subscriber));

        expect(manager.subscribers).toEqual([subscriber]);
        // 去重同时也要防止在同一个 WebContents 上重复挂 destroyed 监听
        expect(subscriber.once).toHaveBeenCalledTimes(1);
    });
});
