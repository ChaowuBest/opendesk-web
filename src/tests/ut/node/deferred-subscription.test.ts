import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adoptDeferredSubscription } from '../../../renderer/deferredSubscription.js';

/**
 * adoptDeferredSubscription：异步订阅拿到句柄前，元素可能已断开或重连。
 * 契约：只有「最后一次、且元素仍连接」的订阅会交给 onReady，其余立即退订。
 */

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('连接中完成订阅 → 句柄交给 onReady，不提前退订', async () => {
    const owner = { isConnected: true };
    let saved: (() => void) | undefined;
    let released = 0;

    adoptDeferredSubscription(
        owner,
        Promise.resolve(() => void (released += 1)),
        (unsubscribe) => {
            saved = unsubscribe;
        }
    );
    await tick();

    assert.equal(typeof saved, 'function');
    assert.equal(released, 0);
});

test('订阅完成前元素已断开 → 立即退订且不保存句柄', async () => {
    const owner = { isConnected: true };
    let saved: (() => void) | undefined;
    let released = 0;

    adoptDeferredSubscription(
        owner,
        Promise.resolve(() => void (released += 1)),
        (unsubscribe) => {
            saved = unsubscribe;
        }
    );
    owner.isConnected = false;
    await tick();

    assert.equal(saved, undefined);
    assert.equal(released, 1, '过期订阅必须自己退订');
});

test('重连后第一份过期订阅被退订，只保留最后一份', async () => {
    const owner = { isConnected: true };
    const released: string[] = [];
    const saved: string[] = [];

    adoptDeferredSubscription(
        owner,
        Promise.resolve(() => void released.push('first')),
        () => {
            saved.push('first');
        }
    );
    adoptDeferredSubscription(
        owner,
        Promise.resolve(() => void released.push('second')),
        () => {
            saved.push('second');
        }
    );
    await tick();

    assert.deepEqual(released, ['first'], '旧代订阅应被退订');
    assert.deepEqual(saved, ['second'], '只保存最后一代的句柄');
});

test('订阅 reject → 交给 onError，不产生未捕获异常', async () => {
    const owner = { isConnected: true };
    const errors: unknown[] = [];
    let saved: unknown;

    adoptDeferredSubscription(
        owner,
        Promise.reject(new Error('boom')),
        (unsubscribe) => {
            saved = unsubscribe;
        },
        (error) => {
            errors.push(error);
        }
    );
    await tick();

    assert.equal(saved, undefined);
    assert.equal(errors.length, 1);
    assert.equal((errors[0] as Error).message, 'boom');
});

test('订阅返回非函数（API 返回 undefined）→ 不保存句柄', async () => {
    const owner = { isConnected: true };
    let saved: unknown;

    adoptDeferredSubscription(owner, Promise.resolve(undefined), (unsubscribe) => {
        saved = unsubscribe;
    });
    await tick();

    assert.equal(saved, undefined);
});

test('没有订阅 Promise（API 缺失）→ 静默返回', () => {
    const owner = { isConnected: true };
    let called = false;

    adoptDeferredSubscription(owner, undefined, () => {
        called = true;
    });

    assert.equal(called, false);
});

test('同步返回值（直接给函数而非 Promise）也能被正确接管', async () => {
    const owner = { isConnected: true };
    let saved: (() => void) | undefined;

    adoptDeferredSubscription(
        owner,
        () => {},
        (unsubscribe) => {
            saved = unsubscribe;
        }
    );
    await tick();

    assert.equal(typeof saved, 'function');
});

test('过期订阅的退订函数抛错时不会变成未捕获 rejection', async () => {
    const owner = { isConnected: true };
    const errors: unknown[] = [];
    let unhandled = 0;
    const onUnhandled = () => void (unhandled += 1);
    process.on('unhandledRejection', onUnhandled);
    try {
        adoptDeferredSubscription(
            owner,
            Promise.resolve(() => {
                throw new Error('release failed');
            }),
            () => {},
            (error) => errors.push(error)
        );
        owner.isConnected = false;
        await tick();
        await tick();
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }

    assert.equal(unhandled, 0);
    assert.equal(errors.length, 1);
});

test('onReady 抛错时走 onError，不被误当订阅失败抛出', async () => {
    const owner = { isConnected: true };
    const errors: unknown[] = [];
    let unhandled = 0;
    const onUnhandled = () => void (unhandled += 1);
    process.on('unhandledRejection', onUnhandled);
    try {
        adoptDeferredSubscription(
            owner,
            Promise.resolve(() => {}),
            () => {
                throw new Error('store failed');
            },
            (error) => errors.push(error)
        );
        await tick();
        await tick();
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }

    assert.equal(unhandled, 0);
    assert.equal(errors.length, 1);
});
