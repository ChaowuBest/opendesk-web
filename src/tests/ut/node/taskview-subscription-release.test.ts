import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAgentGateFloatingApi } from '../../../renderer/agentGateFloatingApi.js';
import { FakeIpcRenderer } from './fixtures/fakeIpcRenderer.js';
import { extractMethodBody } from './fixtures/sourceText.js';

/**
 * TaskView 自己的订阅/退订行为（issue #116 的消费端）。
 *
 * 这里执行 taskview.js 里的真实方法体，只把 `this` 换成一个最小替身，
 * 断言的是行为而不是源码文本：删掉一个视图的订阅后，另一个视图必须照常收到事件。
 * 旧实现里清理走 removeAllListeners，第二个视图会静默失聪。
 */

const taskViewSource = readFileSync(new URL('../../../renderer/components/taskview.js', import.meta.url), 'utf8');

function compileMethod(source: string, methodName: string, stubWindow: unknown, isAsync = false) {
    const body = extractMethodBody(source, methodName);
    assert.ok(body !== null, `taskview.js 未找到 ${methodName}`);
    const declared = isAsync ? `async function () {${body}}` : `function () {${body}}`;
    return (new Function('window', `return ${declared}`) as (win: unknown) => (this: unknown) => unknown)(stubWindow);
}

function createView(taskId: string, stubWindow: unknown) {
    const view = {
        task_id: taskId,
        isConnected: true,
        _browserEventUnsubscribes: null as Array<() => void> | null,
        _attributionUnsubscribes: null as Array<() => void> | null,
        historyLookups: 0,
        getHistoryContainer() {
            this.historyLookups += 1;
            return null;
        },
        _subscribeAttributionStatus: null as unknown as () => void,
        _unsubscribeAttributionStatus: null as unknown as () => void,
        _subscribeBrowserEvents: null as unknown as () => Promise<void>,
        _unsubscribeBrowserEvents: null as unknown as () => void
    };
    view._subscribeAttributionStatus = compileMethod(
        taskViewSource,
        '_subscribeAttributionStatus',
        stubWindow
    ) as never;
    view._unsubscribeAttributionStatus = compileMethod(
        taskViewSource,
        '_unsubscribeAttributionStatus',
        stubWindow
    ) as never;
    view._subscribeBrowserEvents = compileMethod(taskViewSource, '_subscribeBrowserEvents', stubWindow, true) as never;
    view._unsubscribeBrowserEvents = compileMethod(taskViewSource, '_unsubscribeBrowserEvents', stubWindow) as never;
    return view;
}

test('删除一个 TaskView 的归因订阅后，另一个 TaskView 仍能收到事件', () => {
    const ipc = new FakeIpcRenderer();
    const stubWindow = { agentGateFloatingAPI: createAgentGateFloatingApi(ipc) };
    const viewA = createView('task-a', stubWindow);
    const viewB = createView('task-b', stubWindow);

    viewA._subscribeAttributionStatus();
    viewB._subscribeAttributionStatus();

    ipc.emit('agentgate:attributionStart', { taskId: 'task-a' });
    ipc.emit('agentgate:attributionStart', { taskId: 'task-b' });
    assert.equal(viewA.historyLookups, 1);
    assert.equal(viewB.historyLookups, 1);

    // 任务 A 的视图被删除
    viewA._unsubscribeAttributionStatus();

    ipc.emit('agentgate:attributionStart', { taskId: 'task-a' });
    ipc.emit('agentgate:attributionStart', { taskId: 'task-b' });
    ipc.emit('agentgate:attributionEnd', { taskId: 'task-b' });

    assert.equal(viewA.historyLookups, 1, '已删除的视图不应再收到归因事件');
    assert.equal(viewB.historyLookups, 3, '仍在缓存的视图必须继续收到 start/end（end 也会查一次容器）');
});

test('重复调用 _subscribeAttributionStatus 不会堆叠 handler', () => {
    const ipc = new FakeIpcRenderer();
    const stubWindow = { agentGateFloatingAPI: createAgentGateFloatingApi(ipc) };
    const view = createView('task-a', stubWindow);

    view._subscribeAttributionStatus();
    view._subscribeAttributionStatus();

    ipc.emit('agentgate:attributionStart', { taskId: 'task-a' });

    assert.equal(view.historyLookups, 1, '一次事件只能被处理一次（重连不堆叠）');
});

test('_subscribeBrowserEvents 重入时不丢上一批句柄，且退订只影响自己', async () => {
    const registrations = new Map<string, Array<(taskId: string) => void>>();
    const stubWindow = {
        applicationRegistryAPI: {
            subscribeEvent: async (_bundle: string, eventName: string, callback: (taskId: string) => void) => {
                const list = registrations.get(eventName) ?? [];
                list.push(callback);
                registrations.set(eventName, list);
                return () => {
                    const index = list.indexOf(callback);
                    if (index >= 0) list.splice(index, 1);
                };
            }
        }
    };
    const viewA = createView('task-a', stubWindow);
    const viewB = createView('task-b', stubWindow);

    await viewA._subscribeBrowserEvents();
    await viewA._subscribeBrowserEvents();

    for (const handlers of registrations.values()) {
        assert.equal(handlers.length, 1, '重入时必须先退订上一批句柄');
    }

    await viewB._subscribeBrowserEvents();
    viewA._unsubscribeBrowserEvents();

    for (const handlers of registrations.values()) {
        assert.equal(handlers.length, 1, '退订 viewA 不能连带清掉 viewB 的订阅');
    }

    viewB._unsubscribeBrowserEvents();
    for (const handlers of registrations.values()) {
        assert.equal(handlers.length, 0);
    }
});
