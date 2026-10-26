import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * notification-panel 的订阅生命周期：connectedCallback 拿到的是 Promise，
 * 等待期间元素可能被移除或重连。这里直接加载真实组件类（最小 DOM stub），
 * 逐条验证三种分支下退订句柄是否都被调用。
 */

const defined = new Map<string, new () => Record<string, any>>();

class FakeElement {
    isConnected = true;
    innerHTML = '';
    classList = { add() {}, remove() {}, toggle() {} };
    appendChild() {}
    insertAdjacentHTML() {}
    querySelector() {
        return null;
    }
    querySelectorAll() {
        return [];
    }
    addEventListener() {}
    removeEventListener() {}
    setAttribute() {}
    getAttribute() {
        return null;
    }
}

(globalThis as unknown as Record<string, unknown>).HTMLElement = FakeElement;
(globalThis as unknown as Record<string, unknown>).customElements = {
    define: (name: string, ctor: new () => Record<string, any>) => {
        defined.set(name, ctor);
    }
};
// Node 自带 globalThis.crypto.randomUUID（只读 getter，无法替换），组件里的 uuid 无需 stub

await import('../../../renderer/components/notification.js');

const NotificationPanel = defined.get('notification-panel');
if (NotificationPanel === undefined) {
    throw new Error('notification-panel 未注册');
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function setNotificationApi(api: unknown): void {
    (globalThis as unknown as Record<string, unknown>).window = { notificationAPI: api };
}

test('正常连接：保存句柄，断开时调用退订', async () => {
    let released = 0;
    setNotificationApi({ subscribeNotification: () => Promise.resolve(() => void (released += 1)) });

    const panel = new NotificationPanel();
    panel.connectedCallback();
    await tick();
    assert.equal(typeof panel._unsubscribeNotification, 'function');

    panel.disconnectedCallback();
    assert.equal(released, 1);
    assert.equal(panel._unsubscribeNotification, null);
});

test('notificationAPI 缺失：不订阅也不抛错', async () => {
    setNotificationApi(undefined);
    const panel = new NotificationPanel();
    panel.connectedCallback();
    await tick();
    assert.equal(panel._unsubscribeNotification, undefined);
    panel.disconnectedCallback();
});

test('subscribeNotification 返回非 Promise（undefined）时不保存句柄', async () => {
    setNotificationApi({ subscribeNotification: () => undefined });
    const panel = new NotificationPanel();
    panel.connectedCallback();
    await tick();
    assert.equal(panel._unsubscribeNotification, undefined);
});

test('订阅完成前元素被移除：立即退订，不保存句柄', async () => {
    let released = 0;
    setNotificationApi({ subscribeNotification: () => Promise.resolve(() => void (released += 1)) });

    const panel = new NotificationPanel();
    panel.connectedCallback();
    panel.isConnected = false;
    panel.disconnectedCallback();
    await tick();

    assert.equal(released, 1, '断开后才完成的订阅必须自行退订');
    assert.equal(panel._unsubscribeNotification, null);
});

test('断开后重连（首份订阅仍 pending）：旧订阅退订，只保留新句柄', async () => {
    const released: string[] = [];
    let call = 0;
    setNotificationApi({
        subscribeNotification: () => {
            call += 1;
            const tag = call === 1 ? 'first' : 'second';
            return Promise.resolve(() => void released.push(tag));
        }
    });

    const panel = new NotificationPanel();
    panel.connectedCallback();
    panel.isConnected = false;
    panel.disconnectedCallback();
    panel.isConnected = true;
    panel.connectedCallback();
    await tick();

    assert.deepEqual(released, ['first'], '上一代订阅应被退订');
    assert.equal(typeof panel._unsubscribeNotification, 'function');

    panel.disconnectedCallback();
    assert.deepEqual(released, ['first', 'second']);
});

test('订阅 reject：记录错误且不抛未捕获异常', async () => {
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
        errors.push(args);
    };
    try {
        setNotificationApi({ subscribeNotification: () => Promise.reject(new Error('boom')) });
        const panel = new NotificationPanel();
        panel.connectedCallback();
        await tick();
        assert.equal(panel._unsubscribeNotification, undefined);
        assert.equal(errors.length, 1);
    } finally {
        console.error = originalError;
    }
});
