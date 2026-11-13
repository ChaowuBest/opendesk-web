import { jest } from '@jest/globals';
import { BaseApplication } from '../../../../packages/app-sdk/src/index.js';

class TestApplication extends BaseApplication {
    constructor() {
        super('test');
    }

    getName(): string {
        return 'Test';
    }
}

class AgentBarApplication extends TestApplication {
    needAgentBar(): boolean {
        return true;
    }
}

describe('BaseApplication event subscribers', () => {
    test('keeps same-frame event subscription until every listener unsubscribes', () => {
        const app = new TestApplication();
        const senderFrame = {
            isDestroyed: jest.fn(() => false),
            send: jest.fn()
        };

        app.addSubscriber('updated', senderFrame);
        app.addSubscriber('updated', senderFrame);
        app.removeSubscriber('updated', senderFrame);

        app.sendEventToSubscribers('updated', { value: 1 });

        expect(senderFrame.send).toHaveBeenCalledTimes(1);
        expect(senderFrame.send).toHaveBeenCalledWith('applicationRegistry:event:updated', { value: 1 });

        app.removeSubscriber('updated', senderFrame);
        app.sendEventToSubscribers('updated', { value: 2 });

        expect(senderFrame.send).toHaveBeenCalledTimes(1);
    });

    test('skips and evicts a destroyed subscriber', () => {
        const app = new TestApplication();
        const destroyed = { isDestroyed: jest.fn(() => true), send: jest.fn() };
        const alive = { isDestroyed: jest.fn(() => false), send: jest.fn() };

        app.addSubscriber('updated', destroyed);
        app.addSubscriber('updated', alive);
        // 向已销毁的帧广播不应抛错，也不应阻止存活订阅者收到事件
        expect(() => app.sendEventToSubscribers('updated', { value: 1 })).not.toThrow();

        expect(destroyed.send).not.toHaveBeenCalled();
        expect(alive.send).toHaveBeenCalledTimes(1);

        // 已销毁的帧被摘除：下一轮广播不会再检查或尝试发送
        app.sendEventToSubscribers('updated', { value: 2 });
        expect(destroyed.isDestroyed).toHaveBeenCalledTimes(1);
        expect(destroyed.send).not.toHaveBeenCalled();
        expect(alive.send).toHaveBeenCalledTimes(2);
    });

    test('drops the event bucket once every subscriber of it is gone', () => {
        const app = new TestApplication();
        const destroyed = { isDestroyed: jest.fn(() => true), send: jest.fn() };

        app.addSubscriber('updated', destroyed);
        app.sendEventToSubscribers('updated', { value: 1 });

        // 空 Map 若长期留在 eventSubscribers 里，就是每广播一次泄漏一个桶
        expect(app.eventSubscribers.has('updated')).toBe(false);
    });

    test('ignores a subscription registered without a sender frame', () => {
        const app = new TestApplication();
        const alive = { isDestroyed: jest.fn(() => false), send: jest.fn() };

        // IpcMainInvokeEvent.senderFrame 在 frame 已销毁时可能为 null
        expect(() => app.addSubscriber('updated', null)).not.toThrow();
        app.addSubscriber('updated', alive);

        expect(() => app.sendEventToSubscribers('updated', { value: 1 })).not.toThrow();
        expect(alive.send).toHaveBeenCalledTimes(1);
    });

    test('treats a subscriber whose isDestroyed throws as destroyed', () => {
        const app = new TestApplication();
        const weird = {
            isDestroyed: jest.fn(() => {
                throw new TypeError('Object has been destroyed');
            }),
            send: jest.fn()
        };
        const alive = { isDestroyed: jest.fn(() => false), send: jest.fn() };

        app.addSubscriber('updated', weird);
        app.addSubscriber('updated', alive);

        expect(() => app.sendEventToSubscribers('updated', { value: 1 })).not.toThrow();
        expect(weird.send).not.toHaveBeenCalled();
        expect(alive.send).toHaveBeenCalledTimes(1);
    });

    test('a throwing subscriber does not block the rest of the broadcast', () => {
        const app = new TestApplication();
        const broken = {
            isDestroyed: jest.fn(() => false),
            send: jest.fn(() => {
                throw new TypeError('Object has been destroyed');
            })
        };
        const alive = { isDestroyed: jest.fn(() => false), send: jest.fn() };

        app.addSubscriber('updated', broken);
        app.addSubscriber('updated', alive);
        expect(() => app.sendEventToSubscribers('updated', { value: 1 })).not.toThrow();

        expect(alive.send).toHaveBeenCalledTimes(1);
    });

    test('counting eviction: a throwing frame is dropped only after its last subscription fails', () => {
        const app = new TestApplication();
        const broken = {
            isDestroyed: jest.fn(() => false),
            send: jest.fn(() => {
                throw new TypeError('Object has been destroyed');
            })
        };

        // 同一 frame 订阅两次：与 removeSubscriber 一致，每次失败只递减一次计数
        app.addSubscriber('updated', broken);
        app.addSubscriber('updated', broken);

        app.sendEventToSubscribers('updated', { value: 1 });
        expect(broken.send).toHaveBeenCalledTimes(1);

        app.sendEventToSubscribers('updated', { value: 2 });
        expect(broken.send).toHaveBeenCalledTimes(2);

        app.sendEventToSubscribers('updated', { value: 3 });
        expect(broken.send).toHaveBeenCalledTimes(2);
    });
});

describe('BaseApplication GUI config', () => {
    test('hides the floating agent bar by default', () => {
        expect(new TestApplication().toJSON()).toMatchObject({ needAgentBar: false });
    });

    test('serializes an application agent bar opt-in', () => {
        expect(new AgentBarApplication().toJSON()).toMatchObject({ needAgentBar: true });
    });
});
