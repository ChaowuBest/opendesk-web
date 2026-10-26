import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAgentGateFloatingApi } from '../../../renderer/agentGateFloatingApi.js';
import { FakeIpcRenderer } from './fixtures/fakeIpcRenderer.js';

/**
 * Issue #116：删除任一 TaskView 会移除其他任务的 AgentGate 归因 listener。
 * 修复要求：每个订阅拿到只退订自己的 unsubscribe，清理路径不得使用 removeAllListeners。
 */

const preloadSource = readFileSync(new URL('../../../renderer/preload.js', import.meta.url), 'utf8');
const taskViewSource = readFileSync(new URL('../../../renderer/components/taskview.js', import.meta.url), 'utf8');
const floatingSource = readFileSync(
    new URL('../../../renderer/components/agentgate-floating-window.js', import.meta.url),
    'utf8'
);

test('删除一个 TaskView 后，其他 TaskView 仍能收到归因事件', () => {
    const ipc = new FakeIpcRenderer();
    const api = createAgentGateFloatingApi(ipc);

    // 两个缓存的 TaskView，各自注册 start/end
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    const offStartA = api.onAttributionStart((data) => seenA.push(['start', data]));
    const offEndA = api.onAttributionEnd((data) => seenA.push(['end', data]));
    api.onAttributionStart((data) => seenB.push(['start', data]));
    api.onAttributionEnd((data) => seenB.push(['end', data]));

    // 任务 A 被删除：只退订它自己的两个订阅
    offStartA();
    offEndA();

    ipc.emit('agentgate:attributionStart', { taskId: 'task-b' });
    ipc.emit('agentgate:attributionEnd', { taskId: 'task-b' });

    assert.deepEqual(seenA, [], '已删除的 TaskView 不应再收到归因事件');
    assert.deepEqual(
        seenB,
        [
            ['start', { taskId: 'task-b' }],
            ['end', { taskId: 'task-b' }]
        ],
        '仍在缓存的 TaskView 必须继续收到归因事件'
    );
    assert.deepEqual(ipc.removeAllListenersCalls, [], '退订不得使用 removeAllListeners');
    assert.equal(ipc.listenerCount('agentgate:attributionStart'), 1, '两个消费者共用一个 IPC listener');
});

test('onEventsUpdate 的退订只移除自己的订阅', () => {
    const ipc = new FakeIpcRenderer();
    const api = createAgentGateFloatingApi(ipc);

    const seenFloating: unknown[] = [];
    const seenOther: unknown[] = [];
    const offFloating = api.onEventsUpdate((events, counts) => seenFloating.push([events, counts]));
    api.onEventsUpdate((events) => seenOther.push(events));

    offFloating();
    ipc.emit('agentgate:eventsUpdate', { events: ['e1'], counts: { totalCount: 1 } });

    assert.deepEqual(seenFloating, [], '已退订的 consumer 不应再收到事件');
    assert.deepEqual(seenOther, [['e1']], '其他 consumer 必须继续收到事件');
    assert.deepEqual(ipc.removeAllListenersCalls, [], '退订不得使用 removeAllListeners');
});

test('preload 与组件的接线不再走粗粒度 listener 清理', () => {
    assert.match(
        preloadSource,
        /safeExposeInMainWorld\('agentGateFloatingAPI', createAgentGateFloatingApi\(ipcRenderer\)\)/,
        'preload 应通过 createAgentGateFloatingApi 接线'
    );
    assert.ok(
        !/removeAllListeners\('agentgate:/.test(preloadSource),
        'preload 不应以 removeAllListeners 清理 agentgate 通道'
    );
    assert.ok(
        !/removeAttributionListeners/.test(taskViewSource),
        'taskview.js 不应调用 removeAttributionListeners（会清掉其他 TaskView 的 listener）'
    );
    assert.ok(
        !/removeEventsUpdateListener/.test(floatingSource),
        'agentgate-floating-window.js 不应调用 removeEventsUpdateListener'
    );
});
