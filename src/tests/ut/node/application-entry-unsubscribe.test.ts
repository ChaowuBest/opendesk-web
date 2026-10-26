import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sliceBalancedBlock } from './fixtures/sourceText.js';

/**
 * 内置应用 renderer 的订阅生命周期（结构断言）：
 * 1) disconnectedCallback 必须退订该文件订阅的每个 applicationAPI 事件；
 * 2) 重新订阅前必须先退订（否则 _bindCoreDom 这类会被多次调用的路径会重复注册）；
 * 3) 异步拿到句柄的订阅必须走 adoptDeferredSubscription（断开后完成能自动退订）。
 */

function read(relative: string): string {
    return readFileSync(new URL(`../../../${relative}`, import.meta.url), 'utf8');
}

const NOTES = read('main/applications/notes/renderer/entry.js');
const TODOMGR = read('main/applications/todomgr/renderer/entry.ts');
const APPMGR = read('main/applications/appmgr/renderer/entry.js');
const AGENTOFFICE = read('main/applications/agentoffice/renderer/entry.ts');
const MCPMGR = read('main/applications/mcpmgr/renderer/entry.ts');
const PLUGINMGR = read('main/applications/pluginmgr/renderer/entry.ts');
const SKILLMGR = read('main/applications/skillmgr/renderer/entry.js');

/** 截取 `disconnectedCallback` 的方法体（按顶层的花括号配对，跳过字符串与注释） */
function extractDisconnected(source: string): string {
    const start = source.indexOf('disconnectedCallback');
    assert.ok(start >= 0, '缺少 disconnectedCallback');
    return sliceBalancedBlock(source, source.indexOf('{', start));
}

const expectations: Array<{ name: string; source: string; markers: string[] }> = [
    { name: 'notes', source: NOTES, markers: ["'notesChanged'", "'tagsChanged'", "'deletedNotesChanged'"] },
    { name: 'todomgr', source: TODOMGR, markers: ["'globalTodosUpdated'"] },
    { name: 'appmgr', source: APPMGR, markers: ["'appUpdated'"] },
    {
        name: 'agentoffice',
        source: AGENTOFFICE,
        markers: ["'staffsChanged'", "'messagesChanged'", "'staffTaskChanged'", "'localServiceChanged'"]
    },
    { name: 'mcpmgr', source: MCPMGR, markers: ["'serversUpdated'", "'registriesChanged'"] },
    { name: 'pluginmgr', source: PLUGINMGR, markers: ["'pluginsChanged'"] },
    { name: 'skillmgr', source: SKILLMGR, markers: ['_unsubscribeSkillsChanged'] }
];

test('disconnectedCallback 退订了该应用订阅的每个事件', () => {
    for (const { name, source, markers } of expectations) {
        const disconnected = extractDisconnected(source);
        for (const marker of markers) {
            assert.ok(disconnected.includes(marker), `${name} 的 disconnectedCallback 未退订 ${marker}`);
        }
    }
});

test('notes 重复订阅已修：_bindCore 不再额外调用 _subscribeEvents，且重订阅前先退订', () => {
    const bindCoreStart = NOTES.indexOf('_bindCore() {');
    assert.ok(bindCoreStart >= 0);
    const bindCore = NOTES.slice(bindCoreStart, NOTES.indexOf('_bindCoreDom() {'));
    assert.ok(
        !bindCore.includes('this._subscribeEvents();'),
        '_bindCore 不应再次调用 _subscribeEvents（_bindCoreDom 内部已订阅）'
    );

    const subscribeStart = NOTES.indexOf('_subscribeEvents() {');
    const subscribeBody = NOTES.slice(subscribeStart, subscribeStart + 600);
    assert.ok(
        subscribeBody.indexOf("window.applicationAPI.unsubscribe('notesChanged')") <
            subscribeBody.indexOf("window.applicationAPI.subscribe('notesChanged'"),
        '_subscribeEvents 必须先退订旧订阅再重新订阅'
    );
});

test('异步拿到句柄的订阅走 adoptDeferredSubscription', () => {
    assert.match(SKILLMGR, /adoptDeferredSubscription\(\s*this,/, 'skillmgr 应走 adoptDeferredSubscription');
    assert.match(PLUGINMGR, /adoptDeferredSubscription\(\s*this,/, 'pluginmgr 应走 adoptDeferredSubscription');
});

test('pluginmgr 断开时先退订句柄，再做事件级兜底', () => {
    const disconnected = extractDisconnected(PLUGINMGR);
    const handleIndex = disconnected.indexOf('this.pluginsChangedUnsubscribe?.()');
    const fallbackIndex = disconnected.indexOf("getAPI().unsubscribe('pluginsChanged')");
    assert.ok(handleIndex >= 0, 'pluginmgr 未调用句柄退订');
    assert.ok(fallbackIndex > handleIndex, '事件级兜底应排在句柄退订之后');
});
