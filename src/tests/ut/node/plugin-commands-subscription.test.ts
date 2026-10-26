import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subscribePluginSlashCommands } from '../../../renderer/pluginCommandsSubscription.js';

/**
 * AgentInput 的插件斜杠命令订阅：要跨 ensureFullyLoaded + subscribeEvent 两跳才拿到句柄。
 * 三种分支都必须保证句柄不丢失（断开后完成、重连时旧句柄、subscribeEvent reject）。
 */

const tick = () => new Promise((resolve) => setImmediate(resolve));

interface RegistryStub {
    ensureFullyLoaded: () => Promise<unknown>;
    subscribeEvent: (bundle: string, eventName: string, callback: () => void) => Promise<unknown>;
}

function setRegistry(registry: RegistryStub | undefined): void {
    (globalThis as unknown as Record<string, unknown>).window = { applicationRegistryAPI: registry };
}

function registryReturning(unsubscribeFactory: (call: number) => unknown): RegistryStub & { calls: number[] } {
    const calls: number[] = [];
    return {
        calls,
        ensureFullyLoaded: () => Promise.resolve(),
        subscribeEvent: () => {
            calls.push(calls.length + 1);
            return Promise.resolve(unsubscribeFactory(calls.length));
        }
    };
}

test('订阅完成后元素仍连接：句柄交给 onReady', async () => {
    const released: number[] = [];
    const registry = registryReturning((call) => () => void released.push(call));
    setRegistry(registry);

    const owner = { isConnected: true };
    let saved: (() => void) | undefined;
    subscribePluginSlashCommands(
        owner,
        () => {},
        (unsubscribe) => {
            saved = unsubscribe;
        }
    );
    await tick();

    assert.equal(typeof saved, 'function');
    assert.equal(released.length, 0);
});

test('订阅完成后元素已断开：旧句柄立即退订，不交给 onReady', async () => {
    const released: number[] = [];
    setRegistry(registryReturning((call) => () => void released.push(call)));

    const owner = { isConnected: true };
    let saved: (() => void) | undefined;
    subscribePluginSlashCommands(
        owner,
        () => {},
        (unsubscribe) => {
            saved = unsubscribe;
        }
    );
    owner.isConnected = false;
    await tick();

    assert.equal(saved, undefined, '断开后的订阅不应被保存');
    assert.deepEqual(released, [1], '过期订阅必须自行退订');
});

test('重连时旧句柄被退订，只保留最后一次订阅的句柄', async () => {
    const released: number[] = [];
    setRegistry(registryReturning((call) => () => void released.push(call)));

    const owner = { isConnected: true };
    const saved: string[] = [];
    subscribePluginSlashCommands(
        owner,
        () => {},
        () => saved.push('first')
    );
    subscribePluginSlashCommands(
        owner,
        () => {},
        () => saved.push('second')
    );
    await tick();

    assert.deepEqual(released, [1], '第一份订阅应被退订');
    assert.deepEqual(saved, ['second'], '只保留最后一代句柄');
});

test('subscribeEvent reject：交给 onError，且不产生未捕获异常', async () => {
    const errors: unknown[] = [];
    setRegistry({
        ensureFullyLoaded: () => Promise.resolve(),
        subscribeEvent: () => Promise.reject(new Error('subscribe failed'))
    });

    const owner = { isConnected: true };
    let saved: unknown;
    subscribePluginSlashCommands(
        owner,
        () => {},
        (unsubscribe) => {
            saved = unsubscribe;
        },
        (error) => errors.push(error)
    );
    await tick();

    assert.equal(saved, undefined);
    assert.equal(errors.length, 1);
    assert.equal((errors[0] as Error).message, 'subscribe failed');
});

test('ensureFullyLoaded reject：同样走 onError', async () => {
    const errors: unknown[] = [];
    setRegistry({
        ensureFullyLoaded: () => Promise.reject(new Error('load failed')),
        subscribeEvent: () => Promise.resolve(() => {})
    });

    subscribePluginSlashCommands(
        { isConnected: true },
        () => {},
        () => {},
        (error) => errors.push(error)
    );
    await tick();

    assert.equal(errors.length, 1);
    assert.equal((errors[0] as Error).message, 'load failed');
});

test('applicationRegistryAPI 缺失：不订阅也不抛错', async () => {
    setRegistry(undefined);
    let called = false;
    subscribePluginSlashCommands(
        { isConnected: true },
        () => {},
        () => {
            called = true;
        }
    );
    await tick();
    assert.equal(called, false);
});
