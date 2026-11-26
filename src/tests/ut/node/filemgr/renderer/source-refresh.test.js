import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { createRendererTranslator } from '../../../../../renderer/locale.ts';
import { createSources } from '../../../../../main/applications/filemgr/renderer/sources.js';
import * as state from '../../../../../main/applications/filemgr/renderer/state.js';

const entry = (root) => ({ root });
const source = (root, extra = {}) => ({ root, state: 'completed', total_files: 4, ...extra });
const snapshot = (sources, extra = {}) => ({ status: 'running', mode: 'full', sources, ...extra });
const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
};

function fixture(t, initial = [source('/a'), source('/b')], options = {}) {
    state.__resetForTesting();
    state.setEntries(initial.map(({ root }) => entry(root)));
    state.setSnapshot(snapshot(initial));
    const { document, window } = parseHTML('<html><head></head><body></body></html>');
    // Linkedom has no focus manager. Keep the DOM focus boundary explicit;
    // real keyboard focus and native blur behavior are also checked in Electron.
    Object.defineProperty(document, 'activeElement', { value: document.body, configurable: true });
    t.mock.method(window.HTMLElement.prototype, 'focus', function () {
        Object.defineProperty(document, 'activeElement', { value: this, configurable: true });
    });
    const view = createSources({ document, t: createRendererTranslator('zh-CN'), ...options });
    document.body.append(view.element);
    const card = (root) =>
        [...document.querySelectorAll('[data-source-id]')].find((el) => el.dataset.sourceId === root);
    const open = (root, keyboard = false) => {
        const trigger = card(root).querySelector('.source-menu-trigger');
        const menu = card(root).querySelector('.filemgr-source-menu-portal');
        if (keyboard) {
            trigger.focus();
            const event = new window.Event('keydown', { bubbles: true, cancelable: true });
            event.key = 'ArrowDown';
            trigger.dispatchEvent(event);
        } else trigger.click();
        return { trigger, menu };
    };
    t.after(() => {
        view.destroy();
        state.__resetForTesting();
    });
    return { document, window, view, card, open };
}

test('status refresh retains the open menu, focused action and unaffected card; identical data makes no DOM writes', async (t) => {
    const f = fixture(t, [source('/a', { state: 'scanning', total_files: 10, embedded_count: 2 }), source('/b')]);
    const a = f.card('/a');
    const b = f.card('/b');
    const { trigger, menu } = f.open('/a', true);
    const action = menu.querySelector('.source-control-btn');
    assert.ok(f.document.activeElement === action);
    const ring = a.querySelector('.fill');
    const records = [];
    const observer = new f.window.MutationObserver((changes) => records.push(...changes));
    observer.observe(f.view.element, { childList: true, subtree: true, attributes: true, characterData: true });
    observer.observe(menu, { childList: true, subtree: true, attributes: true, characterData: true });
    t.after(() => observer.disconnect());
    state.setSnapshot(
        snapshot([source('/a', { state: 'scanning', total_files: 10, embedded_count: 2 }), source('/b')])
    );
    await flush();
    assert.equal(trigger.getAttribute('aria-expanded'), 'true', 'ordinary refresh must not close the menu');
    assert.equal(records.length, 0, 'equivalent visible data must not mutate the DOM');
    state.setSnapshot(
        snapshot([source('/a', { state: 'scanning', total_files: 10, embedded_count: 7 }), source('/b')])
    );
    await flush();
    assert.ok(f.card('/a') === a);
    assert.ok(f.card('/b') === b);
    assert.ok(a.querySelector('.fill') === ring);
    assert.equal(a.querySelector('.status-text').textContent, '语义索引 · 7/10');
    assert.equal(a.dataset.progress, '70');
    assert.equal(ring.style.strokeDashoffset, String(37.7 * (1 - 70 / 100)));
    assert.ok(menu.parentElement === f.document.body);
    assert.equal(menu.hidden, false);
    assert.ok(f.document.activeElement === action);
    assert.equal(action.isConnected, true);
    assert.ok(
        records.every(({ target }) => !b.contains(target)),
        'unaffected sibling must not be touched'
    );
});

test('retained actions use current backend data, protect workspace and reject removed or destroyed sources', (t) => {
    const deleted = [],
        protectedRequests = [];
    const f = fixture(t, undefined, {
        onRequestDeleteRoot: (raw, normalized) => deleted.push({ raw, normalized }),
        onProtectedWorkspaceDelete: (payload) => protectedRequests.push(payload)
    });
    const a = f.card('/a');
    const remove = a.querySelector('.source-menu-remove');
    const latest = source('/a', { total_files: 9, marker: 'latest' });
    state.setSnapshot(snapshot([latest, source('/b')]));
    remove.click();
    assert.equal(deleted.length, 1);
    assert.equal(deleted[0].raw, latest);
    assert.equal(deleted[0].normalized.totalFiles, 9);
    const { trigger, menu } = f.open('/a', true);
    state.setDefaultWorkspace('/a');
    assert.equal(menu.hidden, true);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.ok(f.document.activeElement === trigger);
    remove.click();
    assert.equal(deleted.length, 1);
    assert.equal(protectedRequests[0].root, '/a');
    state.setEntries([entry('/b')]);
    remove.click();
    assert.equal(protectedRequests.length, 1, 'detached stale action must not fire');
    const oldTrigger = f.card('/b').querySelector('.source-menu-trigger');
    const oldRemove = f.card('/b').querySelector('.source-menu-remove');
    f.view.destroy();
    oldTrigger.click();
    oldRemove.click();
    assert.equal(f.document.querySelector('body > .filemgr-source-menu-portal'), null);
    assert.equal(deleted.length, 1);
});

test('pause transitions update retained controls and guard pending, backend loss and worker capability', async (t) => {
    let settle;
    const calls = [];
    const f = fixture(t, undefined, {
        onSetSourcePaused: (request) => {
            calls.push(request);
            return new Promise((resolve) => {
                settle = resolve;
            });
        }
    });
    const a = f.card('/a');
    const control = a.querySelector('.source-control-btn');
    let opened = f.open('/a', true);
    state.setSnapshot(snapshot([source('/a', { paused: true }), source('/b')]));
    assert.equal(opened.menu.hidden, true);
    assert.ok(f.document.activeElement === opened.trigger);
    assert.ok(a.querySelector('.row3 .source-control-btn') === control);
    assert.equal(control.dataset.action, 'resume');
    assert.equal(control.textContent, '继续扫描');
    control.click();
    control.click();
    assert.deepEqual(calls, [{ root: '/a', paused: false }]);
    assert.equal(control.disabled, true);
    assert.ok(control.querySelector('.source-control-spinner'));
    assert.equal(a.querySelector('.source-menu-remove').disabled, true);
    assert.equal(f.card('/b').querySelector('.source-control-btn').disabled, false);
    settle();
    await flush();
    assert.equal(control.disabled, false);
    state.setSnapshot(snapshot([source('/a'), source('/b')]));
    opened = f.open('/a', true);
    state.setSnapshot(snapshot([source('/a'), source('/b')], { status: 'readonly' }));
    assert.equal(opened.menu.hidden, true);
    assert.equal(control.disabled, true);
    control.dispatchEvent(new f.window.Event('click', { bubbles: true }));
    assert.equal(calls.length, 1);
    state.setSnapshot(snapshot([source('/b')]));
    assert.ok(f.card('/a') === a);
    assert.equal(a.querySelector('.source-control-btn'), null);
    control.dispatchEvent(new f.window.Event('click', { bubbles: true }));
    assert.equal(calls.length, 1);
    assert.equal(a.querySelector('.status-text').textContent, '等待扫描');
});

test('raw roots retain identity across additions, workspace reorder, parent merge and placeholder promotion', (t) => {
    const f = fixture(t, [source('D:'), source('D:/'), source('/parent/child')]);
    const drive = f.card('D:');
    const slash = f.card('D:/');
    const { trigger, menu } = f.open('D:', true);
    state.setEntries([entry('D:'), entry('D:/'), entry('/parent/child'), entry('/new')]);
    assert.ok(f.card('D:') === drive);
    assert.ok(f.card('D:/') === slash);
    assert.equal(menu.hidden, false);
    const placeholder = f.card('/new');
    assert.equal(placeholder.querySelector('.source-control-btn'), null);
    state.setSnapshot(snapshot([source('D:'), source('D:/'), source('/parent/child'), source('/new')]));
    assert.ok(f.card('/new') === placeholder);
    assert.ok(placeholder.querySelector('.source-control-btn'));
    state.setDefaultWorkspace('D:/');
    assert.deepEqual(
        [...f.document.querySelectorAll('[data-source-id]')].map((el) => el.dataset.sourceId),
        ['D:', 'D:/', '/parent/child', '/new']
    );
    assert.ok(f.card('D:') === drive);
    assert.equal(
        trigger.getAttribute('aria-expanded'),
        'false',
        'drive aliases retain existing workspace matching semantics'
    );
    state.setDefaultWorkspace('/new');
    assert.equal(f.document.querySelector('[data-source-id]').dataset.sourceId, '/new');
    f.open('/parent/child');
    state.setEntries([entry('D:'), entry('D:/'), entry('/parent'), entry('/new')]);
    assert.equal(f.card('/parent/child'), undefined);
    assert.equal(f.document.querySelector('body > .filemgr-source-menu-portal'), null);
    assert.ok(f.card('/new') === placeholder);
    assert.equal(f.document.querySelectorAll('[data-source-id]').length, 4);
});

test('in-place updates preserve visible state, alert, time, locale, mode and retryable errors', async (t) => {
    const f = fixture(t, [source('/a')], {
        onSetSourcePaused: async () => {
            throw Object.assign(new Error('isolated failure'), { code: 'persistence_failed' });
        }
    });
    const a = f.card('/a');
    const recent = Date.now();
    state.setSnapshot(
        snapshot([source('/a', { state: 'scanning', embedded_count: 2, failed_count: 1, last_scan_at: recent })])
    );
    assert.equal(a.querySelector('.fs-file-alert').textContent, '1');
    assert.equal(a.querySelector('.time-tag').textContent, '刚刚');
    state.setSnapshot(snapshot([source('/a', { state: 'unavailable', last_count: 8, failed_count: 2 })]));
    assert.equal(a.dataset.state, 'unavailable');
    assert.equal(a.querySelector('.status-text').textContent, '路径不可访问 · 上次 8 文件');
    assert.ok(a.querySelector('.warning-corner'));
    assert.ok(a.querySelector('.fs-warning-icon'));
    assert.equal(a.querySelector('.fs-mini-ring'), null);
    assert.equal(a.querySelector('.time-tag'), null);
    state.setSnapshot(snapshot([source('/a', { total_files: 0, metadata_write_pending: true })]));
    assert.equal(a.dataset.progress, undefined);
    assert.match(a.querySelector('.status-text').textContent, /此前部分文件的扫描结果保存失败/);
    assert.equal(a.querySelector('.warning-corner'), null);
    assert.equal(a.querySelector('.fs-file-alert'), null);
    state.setSnapshot(snapshot([source('/a', { total_files: 0 })], { mode: 'base-only' }));
    assert.ok(a.classList.contains('base-only'));
    assert.equal(a.querySelector('.status-text').textContent, '未发现可扫描文件');
    f.open('/a');
    f.document.querySelector('body > .filemgr-source-menu-portal .source-control-btn').click();
    await flush();
    assert.ok(a.querySelector('.fs-source-control-error'));
    assert.equal(a.querySelector('.source-control-spinner'), null);
    f.view.setTranslator(createRendererTranslator('en-US'));
    assert.match(a.querySelector('.fs-source-control-error').textContent, /could not be saved/);
    assert.equal(a.querySelector('.source-menu-trigger').title, 'More actions');
    state.setSnapshot(snapshot([source('/a', { total_files: 3 })]));
    assert.equal(a.querySelector('.status-text').textContent, 'Index complete · 3 files');
    assert.equal(a.querySelector('.fs-source-control-error'), null);
    assert.ok(f.card('/a') === a);
});

test('keyboard escape, outside pointer and action clicks close normally; removed source and teardown release portal listeners', async (t) => {
    const f = fixture(t);
    const { menu, trigger } = f.open('/a', true);
    const escape = new f.window.Event('keydown', { bubbles: true, cancelable: true });
    escape.key = 'Escape';
    menu.dispatchEvent(escape);
    assert.equal(menu.hidden, true);
    assert.ok(f.document.activeElement === trigger);
    f.open('/a');
    f.document.body.dispatchEvent(new f.window.Event('pointerdown', { bubbles: true }));
    assert.equal(menu.hidden, true);
    f.open('/a');
    menu.querySelector('.source-menu-remove').click();
    assert.equal(menu.hidden, true);
    f.open('/a', true);
    state.setEntries([entry('/b')]);
    assert.equal(menu.hidden, true);
    assert.equal(menu.isConnected, false);
    const removed = [];
    const removeEventListener = f.document.removeEventListener.bind(f.document);
    t.mock.method(f.document, 'removeEventListener', (...args) => {
        removed.push(args[0]);
        removeEventListener(...args);
    });
    const b = f.open('/b', true);
    b.menu.dispatchEvent(new f.window.Event('focusout', { bubbles: true }));
    f.view.destroy();
    assert.equal(b.menu.isConnected, false);
    assert.ok(removed.includes('pointerdown'));
    await flush();
    state.setSnapshot(snapshot([source('/b', { total_files: 100 })]));
    assert.equal(f.document.querySelector('.fs-upper'), null);
});

test('null snapshot skeleton and empty state are stable across equivalent refreshes and transition to selected cards', (t) => {
    const f = fixture(t, []);
    state.setSnapshot(null);
    const skeleton = f.document.querySelector('.skeleton');
    assert.equal(f.document.querySelectorAll('.skeleton').length, 3);
    state.setSnapshot(null);
    assert.ok(f.document.querySelector('.skeleton') === skeleton);
    state.setSnapshot(snapshot([]));
    const empty = f.document.querySelector('.empty');
    state.setSnapshot(snapshot([]));
    assert.ok(f.document.querySelector('.empty') === empty);
    state.setEntries([entry('/new')]);
    assert.equal(f.document.querySelector('.empty'), null);
    assert.equal(f.card('/new').querySelector('.status-text').textContent, '等待扫描');
});
