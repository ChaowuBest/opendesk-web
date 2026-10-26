import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIpcChannelDispatcher } from '../../../renderer/ipcChannelDispatcher.js';
import { FakeIpcRenderer } from './fixtures/fakeIpcRenderer.js';

const CHANNEL = 'test:sharedChannel';

test('每个订阅者只退订自己，其他订阅者继续收到事件', () => {
    const ipc = new FakeIpcRenderer();
    const dispatcher = createIpcChannelDispatcher(ipc, CHANNEL);
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];

    const offA = dispatcher.subscribe((value) => seenA.push(value));
    dispatcher.subscribe((value) => seenB.push(value));

    offA();
    ipc.emit(CHANNEL, 'payload');

    assert.deepEqual(seenA, [], '已退订的订阅者不应再收到事件');
    assert.deepEqual(seenB, ['payload'], '其他订阅者必须继续收到事件');
    assert.deepEqual(ipc.removeAllListenersCalls, [], '不得使用 removeAllListeners');
});

test('重复调用同一个 unsubscribe 不会误删其他订阅者', () => {
    const ipc = new FakeIpcRenderer();
    const dispatcher = createIpcChannelDispatcher(ipc, CHANNEL);
    const seenFirst: unknown[] = [];
    const seenSecond: unknown[] = [];

    const offFirst = dispatcher.subscribe((value) => seenFirst.push(value));
    dispatcher.subscribe((value) => seenSecond.push(value));

    offFirst();
    offFirst();
    ipc.emit(CHANNEL, 'payload');

    assert.deepEqual(seenFirst, []);
    assert.deepEqual(seenSecond, ['payload']);
});

test('通道上只挂一个 IPC listener，订阅数不随 consumer 增长', () => {
    const ipc = new FakeIpcRenderer();
    const dispatcher = createIpcChannelDispatcher(ipc, CHANNEL);

    const offs = Array.from({ length: 12 }, () => dispatcher.subscribe(() => {}));

    assert.equal(ipc.listenerCount(CHANNEL), 1, '超过 EventEmitter 默认上限也不应堆叠 listener');
    assert.equal(dispatcher.size, 12);

    for (const off of offs) {
        off();
    }
    assert.equal(ipc.listenerCount(CHANNEL), 0, '最后一个订阅者退订后应摘除 IPC listener');
    assert.equal(dispatcher.size, 0);
});

test('首次订阅才挂 listener，全部退订后再订阅能重新挂上', () => {
    const ipc = new FakeIpcRenderer();
    const dispatcher = createIpcChannelDispatcher(ipc, CHANNEL);
    const seen: unknown[] = [];

    const off = dispatcher.subscribe((value) => seen.push(value));
    assert.equal(ipc.listenerCount(CHANNEL), 1);
    off();
    assert.equal(ipc.listenerCount(CHANNEL), 0);

    dispatcher.subscribe((value) => seen.push(value));
    assert.equal(ipc.listenerCount(CHANNEL), 1);
    ipc.emit(CHANNEL, 'again');
    assert.deepEqual(seen, ['again']);
});

test('分发期间退订不影响本轮遍历，也不会抛错', () => {
    const ipc = new FakeIpcRenderer();
    const dispatcher = createIpcChannelDispatcher(ipc, CHANNEL);
    const seen: string[] = [];
    let offSelf: () => void = () => {};

    offSelf = dispatcher.subscribe(() => {
        seen.push('first');
        offSelf();
    });
    dispatcher.subscribe(() => seen.push('second'));

    ipc.emit(CHANNEL, 'payload');

    assert.deepEqual(seen, ['first', 'second']);
    ipc.emit(CHANNEL, 'payload');
    assert.deepEqual(seen, ['first', 'second', 'second'], '退订在下一次分发生效');
});

test('单个 consumer 抛错不会让同通道其他 consumer 漏事件', () => {
    const ipc = new FakeIpcRenderer();
    const dispatcher = createIpcChannelDispatcher(ipc, CHANNEL);
    const seen: string[] = [];
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);

    try {
        dispatcher.subscribe(() => {
            throw new Error('consumer boom');
        });
        dispatcher.subscribe((value) => seen.push(value as string));

        // 共用同一个 IPC listener 之后，异常必须就地隔离：否则后面的 consumer 收不到事件，
        // 表现出来就是「某个 TaskView 的归因状态定住了」，非常难查
        assert.doesNotThrow(() => ipc.emit(CHANNEL, 'payload'));
        assert.deepEqual(seen, ['payload']);
        assert.equal(errors.length, 1, '失败需要留下日志');
    } finally {
        console.error = originalError;
    }
});
