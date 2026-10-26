import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractMethodBody } from './fixtures/sourceText.js';

/**
 * notes 应用的订阅行为：
 * 1) _bindCoreDom 会在重渲染/locale 切换时被再次调用，重复订阅必须被前置退订吃掉
 *    —— 否则同一事件会堆多个 handler，刷新回调被执行多次；
 * 2) connectedCallback 在 `if (!this.isConnected) return` 之后到订阅之间不能有 await，
 *    否则存在「等待期间元素被销毁、订阅却在销毁后完成」的窗口。
 */

const source = readFileSync(new URL('../../../main/applications/notes/renderer/entry.js', import.meta.url), 'utf8');

interface FakeApplicationApi {
    subscribe(eventName: string, callback: () => void): Promise<() => void>;
    unsubscribe(eventName: string): Promise<void>;
    activeHandlers(eventName: string): number;
    subscribeCalls: Array<{ eventName: string }>;
}

function createFakeApplicationApi(): FakeApplicationApi {
    const handlers = new Map<string, Set<() => void>>();
    const subscribeCalls: Array<{ eventName: string }> = [];
    return {
        subscribeCalls,
        subscribe(eventName, callback) {
            subscribeCalls.push({ eventName });
            let set = handlers.get(eventName);
            if (set === undefined) {
                set = new Set();
                handlers.set(eventName, set);
            }
            set.add(callback);
            return Promise.resolve(() => {
                handlers.get(eventName)?.delete(callback);
            });
        },
        unsubscribe(eventName) {
            handlers.delete(eventName);
            return Promise.resolve();
        },
        activeHandlers(eventName) {
            return handlers.get(eventName)?.size ?? 0;
        }
    };
}

function createFakeWidget(api: FakeApplicationApi) {
    const calls: string[] = [];
    return {
        calls,
        window: { applicationAPI: api },
        // _subscribeEvents 只依赖这几个刷新方法与 handler 字段
        _refreshNotes: () => void calls.push('refreshNotes'),
        _refreshTags: () => void calls.push('refreshTags'),
        _refreshDeletedNotes: () => void calls.push('refreshDeletedNotes'),
        _bindCoreDom: () => void calls.push('bindCoreDom'),
        _subscribeEvents: () => void calls.push('subscribeEvents')
    };
}

function compileMethod(body: string, fakeWindow: unknown) {
    // 用真实方法体执行，只是把它挂到 fake widget 上
    const factory = new Function('window', `return function () {${body}}`) as (win: unknown) => (this: unknown) => void;
    return factory(fakeWindow);
}

const events = ['notesChanged', 'tagsChanged', 'deletedNotesChanged'];

test('_subscribeEvents 重复调用不会堆积 handler（locale/主题切换重渲染路径）', () => {
    const api = createFakeApplicationApi();
    const widget = createFakeWidget(api);
    const subscribeEvents = compileMethod(extractMethodBody(source, '_subscribeEvents'), widget.window);

    // 模拟 connectedCallback 的首次订阅 + locale 切换导致 _bindCoreDom 再次调用
    subscribeEvents.call(widget);
    subscribeEvents.call(widget);

    for (const event of events) {
        assert.equal(api.activeHandlers(event), 1, `${event} 不应堆积多个 handler`);
    }
    assert.equal(api.subscribeCalls.length, 6, '两次订阅调用各注册 3 个事件（共 6 次 subscribe）');
});

test('_bindCore 不会额外再订阅一次（订阅只发生在 _bindCoreDom 内部）', () => {
    const api = createFakeApplicationApi();
    const widget = createFakeWidget(api);
    const bindCore = compileMethod(extractMethodBody(source, '_bindCore'), widget.window);

    bindCore.call(widget);

    assert.deepEqual(widget.calls, ['bindCoreDom'], '_bindCore 只应调用 _bindCoreDom');
});

test('connectedCallback 在 isConnected 检查与订阅之间没有 await（无断开竞态窗口）', () => {
    const body = extractMethodBody(source, 'connectedCallback');
    const guardIndex = body.indexOf('!this.isConnected');
    const subscribeIndex = body.indexOf('this._bindCore()');
    assert.ok(guardIndex >= 0, 'connectedCallback 缺少 isConnected 检查');
    assert.ok(subscribeIndex > guardIndex, '订阅应在 isConnected 检查之后');

    const between = body.slice(guardIndex, subscribeIndex);
    assert.ok(!between.includes('await '), '检查与订阅之间不能有 await，否则存在销毁后订阅的窗口');
});

test('disconnectedCallback 先退订三个事件，再执行可抛错的清理', () => {
    const body = extractMethodBody(source, 'disconnectedCallback');
    const firstUnsubscribe = body.search(/unsubscribe\('notesChanged'\)/);
    assert.ok(firstUnsubscribe >= 0, '未退订 notesChanged');

    for (const risky of ['this._dismissEditorContextMenu()', 'this._dismissNoteContextMenu()', 'tinymce.remove(']) {
        const index = body.indexOf(risky);
        if (index < 0) continue;
        assert.ok(firstUnsubscribe < index, `退订必须早于 ${risky}`);
    }

    for (const event of events) {
        assert.ok(body.includes(`unsubscribe('${event}')`), `未退订 ${event}`);
    }
});
