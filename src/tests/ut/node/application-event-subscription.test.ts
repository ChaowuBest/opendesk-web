import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createIpcChannelDispatcher } from '../../../renderer/ipcChannelDispatcher.js';
import { FakeIpcRenderer } from './fixtures/fakeIpcRenderer.js';
import { extractFunction } from './fixtures/sourceText.js';

/**
 * applicationAPI 订阅（子应用 iframe 用的老 API 面）与 applicationRegistryAPI.subscribeEvent
 * 共用 `applicationRegistry:event:<name>` 通道。旧实现 unsubscribe(eventName) 直接
 * removeAllListeners，会把同通道上其他 consumer 的 listener 一起清掉（issue #116 同类）。
 *
 * 这里直接执行 preload.js 里的 exposeApplicationAPI 本体（真实源码）。
 * 注意契约：精确退订只能用 subscribe() 的返回值 —— contextBridge 会重新包装跨上下文
 * 函数，按 callback 引用匹配不可靠（用 proxied() 模拟这一事实）。
 */

const preloadSource = readFileSync(new URL('../../../renderer/preload.js', import.meta.url), 'utf8');

interface ApplicationApi {
    subscribe(eventName: string, callback: (...args: unknown[]) => void): Promise<() => void>;
    unsubscribe(eventName: string): Promise<void>;
}

function loadApplicationApi(ipc: FakeIpcRenderer): ApplicationApi {
    const exposed: Record<string, unknown> = {};
    const factory = vm.runInNewContext(`(${extractFunction(preloadSource, 'exposeApplicationAPI')})`, {
        ipcRenderer: ipc,
        console,
        createIpcChannelDispatcher,
        getBundleNameFromLocation: () => 'test.app',
        safeExposeInMainWorld: (name: string, value: unknown) => {
            exposed[name] = value;
        }
    }) as () => void;
    factory();
    const api = exposed.applicationAPI as ApplicationApi | undefined;
    if (api === undefined) {
        throw new Error('exposeApplicationAPI 未暴露 applicationAPI');
    }
    return api;
}

/** 模拟 contextBridge 的跨上下文函数包装：每次传入都会得到新的引用 */
function proxied<Args extends unknown[]>(callback: (...args: Args) => void): (...args: Args) => void {
    return (...args: Args) => callback(...args);
}

test('两个组件订阅同一事件，用返回值退订其一只移除自己', async () => {
    const ipc = new FakeIpcRenderer();
    const api = loadApplicationApi(ipc);
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];

    const offA = await api.subscribe(
        'notesChanged',
        proxied((payload) => seenA.push(payload))
    );
    await api.subscribe(
        'notesChanged',
        proxied((payload) => seenB.push(payload))
    );

    assert.equal(typeof offA, 'function', 'subscribe 必须返回 unsubscribe');
    assert.equal(ipc.listenerCount('applicationRegistry:event:notesChanged'), 1, '同一事件只挂一个 IPC listener');

    offA();
    ipc.emit('applicationRegistry:event:notesChanged', 'payload');

    assert.deepEqual(seenA, [], '已退订的订阅者不应再收到事件');
    assert.deepEqual(seenB, ['payload'], '其他订阅者必须继续收到事件');
    assert.deepEqual(ipc.removeAllListenersCalls, [], '退订不得使用 removeAllListeners');
});

test('unsubscribe(eventName) 按事件名清空本 API 面订阅（不依赖 callback 引用）', async () => {
    const ipc = new FakeIpcRenderer();
    const api = loadApplicationApi(ipc);
    const seen: unknown[] = [];

    // 同一个原始回调、每次经过 contextBridge 得到不同引用
    const callback = (payload: unknown) => seen.push(payload);
    await api.subscribe('tagsChanged', proxied(callback));
    await api.subscribe('tagsChanged', proxied(callback));

    await api.unsubscribe('tagsChanged');
    ipc.emit('applicationRegistry:event:tagsChanged', 'payload');

    assert.deepEqual(seen, [], '按事件名应清掉本 API 面该事件的全部订阅');
});

test('unsubscribe(eventName) 不影响共享同通道的其他 API 面 listener', async () => {
    const ipc = new FakeIpcRenderer();
    const api = loadApplicationApi(ipc);
    const seenRegistry: unknown[] = [];

    // 其他 API 面（applicationRegistryAPI.subscribeEvent）在共享通道上的 listener
    ipc.on('applicationRegistry:event:notesChanged', (_event: unknown, ...args: unknown[]) =>
        seenRegistry.push(...args)
    );

    await api.subscribe(
        'notesChanged',
        proxied(() => {})
    );
    await api.unsubscribe('notesChanged');
    ipc.emit('applicationRegistry:event:notesChanged', 'payload');

    assert.deepEqual(seenRegistry, ['payload'], '其他 API 面的 listener 不得被连带清掉');
    assert.equal(ipc.listenerCount('applicationRegistry:event:notesChanged'), 1);
});

test('main 侧引用计数与订阅次数配对', async () => {
    const ipc = new FakeIpcRenderer();
    const api = loadApplicationApi(ipc);

    const off = await api.subscribe(
        'appUpdated',
        proxied(() => {})
    );
    await api.subscribe(
        'appUpdated',
        proxied(() => {})
    );
    assert.deepEqual(ipc.invokeChannels(), ['applicationRegistry:subscribe', 'applicationRegistry:subscribe']);

    off();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(ipc.invokeChannels(), [
        'applicationRegistry:subscribe',
        'applicationRegistry:subscribe',
        'applicationRegistry:unsubscribe'
    ]);

    await api.unsubscribe('appUpdated');
    assert.deepEqual(ipc.invokeChannels(), [
        'applicationRegistry:subscribe',
        'applicationRegistry:subscribe',
        'applicationRegistry:unsubscribe',
        'applicationRegistry:unsubscribe'
    ]);
});

test('本 frame 未登记时 unsubscribe 是 no-op：不减 main 计数、不动 renderer listener', async () => {
    const ipc = new FakeIpcRenderer();
    const api = loadApplicationApi(ipc);
    const seenOther: unknown[] = [];
    ipc.on('applicationRegistry:event:notesChanged', (...args: unknown[]) => seenOther.push(args.slice(1)));

    // 从未订阅，或已经用自己的 unsubscribe 退掉：main 侧计数不属于本 API 面，
    // 再减一次会把同 frame 里 subscribeEvent 的订阅者一起减掉（issue #116 同类）
    await api.unsubscribe('notesChanged');
    ipc.emit('applicationRegistry:event:notesChanged', 'payload');

    assert.deepEqual(seenOther, [['payload']], '其他 consumer 的 listener 必须保留');
    assert.deepEqual(ipc.invokeChannels(), [], '不应触碰 main 侧引用计数');
});

test('unsubscribe 单条 IPC 失败不影响其余条目，也不抛出（调用点是 fire-and-forget）', async () => {
    const ipc = new FakeIpcRenderer();
    const api = loadApplicationApi(ipc);
    await api.subscribe(
        'appUpdated',
        proxied(() => {})
    );
    await api.subscribe(
        'appUpdated',
        proxied(() => {})
    );

    ipc.failingInvokeChannels.add('applicationRegistry:unsubscribe');
    await api.unsubscribe('appUpdated');

    assert.deepEqual(
        ipc.invokeChannels().filter((channel) => channel === 'applicationRegistry:unsubscribe').length,
        2,
        '两条登记都要尝试与 main 配对递减'
    );
    assert.equal(ipc.listenerCount('applicationRegistry:event:appUpdated'), 0, '本地登记仍应清理干净');
});
