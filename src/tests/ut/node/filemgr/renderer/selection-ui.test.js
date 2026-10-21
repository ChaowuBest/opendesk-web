import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { createRendererTranslator } from '../../../../../renderer/locale.ts';
import * as state from '../../../../../main/applications/filemgr/renderer/state.js';
import { createSources } from '../../../../../main/applications/filemgr/renderer/sources.js';
import { createToast } from '../../../../../main/applications/filemgr/renderer/toast.js';
import { saveEntries } from '../../../../../main/applications/filemgr/renderer/adapter.js';

const E = (root) => ({ root, include_patterns: ['**/*'], exclude_patterns: [] });
const settings = (entries, workspace = '') => ({
    locale: 'zh-CN',
    default_workspace: workspace,
    applications: { filemgr: { enabled: true, entries } }
});
const clone = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
};
async function flush() {
    for (let i = 0; i < 40; i++) await Promise.resolve();
}
let cleanup = [];
test.afterEach(() => {
    for (const f of cleanup.reverse()) f();
    cleanup = [];
    state.__resetForTesting();
});
function dom() {
    const { window, document } = parseHTML('<!doctype html><html><head></head><body></body></html>');
    const names = [
        'window',
        'document',
        'HTMLElement',
        'customElements',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'ResizeObserver'
    ];
    const previous = new Map(names.map((name) => [name, globalThis[name]]));
    Object.assign(globalThis, {
        window,
        document,
        HTMLElement: window.HTMLElement,
        customElements: window.customElements,
        requestAnimationFrame: (cb) => {
            cb(0);
            return 1;
        },
        cancelAnimationFrame: () => {},
        ResizeObserver: class {
            observe() {}
            disconnect() {}
        }
    });
    cleanup.push(() => {
        for (const [name, value] of previous) {
            if (value === undefined) delete globalThis[name];
            else globalThis[name] = value;
        }
    });
    return { window, document };
}
async function selection(initial = []) {
    const owner = state.beginSelectionSession({ load: async () => settings(initial), save: saveEntries });
    await state.initializeSelectionSession(owner);
    return owner;
}

async function widgetFixture(overrides = {}) {
    const { window, document } = dom();
    let current = settings([E('/test/a')]);
    let settingHandler, statusHandler;
    const writes = [],
        calls = [];
    let unsubscribeCount = 0;
    window.settingAPI = {
        loadSettingObject: async () => (overrides.load ? overrides.load(current) : clone(current)),
        saveSettingObject: async (next) => {
            writes.push(clone(next));
            current = clone(next);
            return clone(current);
        },
        onSettingChanged: (cb) => {
            settingHandler = cb;
            return () => {
                unsubscribeCount++;
            };
        }
    };
    window.applicationAPI = {
        call: async (method, ...args) => {
            calls.push([method, ...args]);
            if (overrides.call) return overrides.call(method, ...args);
            if (method === 'getFileSystemStatus')
                return {
                    status: 'running',
                    mode: 'base-only',
                    platform: 'darwin',
                    is_openharmony: false,
                    home_path: '/test',
                    sources: []
                };
            return { status: 'ok' };
        },
        subscribe: async (_name, cb) => {
            statusHandler = cb;
        },
        unsubscribe: async () => {}
    };
    window.workspaceAPI = { listDirectory: async () => [], listDrives: async () => [] };
    await import(
        new URL('../../../../../main/applications/filemgr/renderer/entry.js?ui=' + Math.random(), import.meta.url)
    );
    const widget = document.createElement('filemgr-entry-widget');
    document.body.append(widget);
    cleanup.push(() => widget.remove());
    await flush();
    return {
        window,
        document,
        widget,
        writes,
        calls,
        notify(next) {
            current = next;
            settingHandler(next);
        },
        status: (next) => statusHandler(next),
        unsubscribed: () => unsubscribeCount
    };
}

test('U05 adapter reconciles the entire effective FileMgr configuration once', async () => {
    const { window } = dom();
    const calls = [];
    const effective = settings([E('/parent'), E('/parent/child')], '/parent/child');
    effective.applications.filemgr.extra = { marker: 'effective' };
    window.settingAPI = {
        loadSettingObject: async () => settings([]),
        saveSettingObject: async () => clone(effective)
    };
    window.applicationAPI = {
        call: async (...args) => {
            calls.push(args);
            return { status: 'ok' };
        }
    };
    const result = await saveEntries([E('/parent')]);
    assert.deepEqual(result.settings, effective);
    assert.deepEqual(await result.reconciliation, { ok: true });
    assert.deepEqual(calls, [['reconcileConfig', effective.applications.filemgr]]);
});

test('U10 adapter consumes reconcile rejection and marks only post-save errors as unknown', async () => {
    const { window } = dom();
    window.settingAPI = {
        loadSettingObject: async () => settings([]),
        saveSettingObject: async () => settings([E('/saved')])
    };
    window.applicationAPI = { call: () => Promise.reject(Error('reconcile rejected')) };
    const result = await saveEntries([E('/saved')]);
    assert.deepEqual(await result.reconciliation, { ok: false });
    window.settingAPI.saveSettingObject = async () => undefined;
    await assert.rejects(saveEntries([]), (error) => error.saveAttempted === true);
    window.settingAPI.loadSettingObject = async () => {
        throw Error('before write');
    };
    await assert.rejects(saveEntries([]), (error) => error.saveAttempted !== true);
});

test('U07 cards derive the whole raw-root selection, with no fabricated status or backend controls', async () => {
    const { document } = dom();
    await selection();
    const sources = createSources({ document });
    document.body.append(sources.element);
    cleanup.push(() => sources.destroy());
    const snapshot = {
        status: 'running',
        mode: 'full',
        sources: [{ root: 'D:', state: 'completed', total_files: 4, last_scan_at: 1 }]
    };
    state.setSnapshot(snapshot);
    state.editEntries([E('D:'), E('D:/'), E('/parent/child')]);
    assert.equal(document.querySelectorAll('.fs-source-card[data-source-id]').length, 3);
    const placeholder = document.querySelector('.fs-source-card[data-source-id="D:/"]');
    assert.match(placeholder.textContent, /等待扫描/);
    assert.equal(placeholder.dataset.progress, undefined);
    assert.equal(placeholder.querySelector('.fs-mini-ring'), null);
    assert.equal(placeholder.querySelector('.source-control-btn'), null);
    assert.ok(placeholder.querySelector('.source-menu-remove'));
    state.editEntries([E('/parent')], { undoable: true });
    assert.equal(document.querySelectorAll('.fs-source-card[data-source-id]').length, 1);
    assert.ok(state.rollbackUndo());
    assert.equal(document.querySelectorAll('.fs-source-card[data-source-id]').length, 3);
    state.editEntries([]);
    assert.equal(document.querySelectorAll('.fs-source-card[data-source-id]').length, 0);
    state.setSnapshot({ ...snapshot, status: 'error' });
    assert.equal(document.querySelectorAll('.fs-source-card[data-source-id]').length, 0);
    assert.equal(snapshot.sources.length, 1);
    assert.equal(snapshot.sources[0].total_files, 4);
});

test('U08 changed rules keep real scan information with missing counts omitted', async () => {
    const { document } = dom();
    await selection([E('/source')]);
    state.setSnapshot({
        status: 'running',
        mode: 'full',
        default_workspace: '/stale',
        sources: [{ root: '/source', state: 'completed' }]
    });
    const sources = createSources({ document });
    document.body.append(sources.element);
    cleanup.push(() => sources.destroy());
    state.editEntries([{ ...E('/source'), exclude_patterns: ['sub/**'] }]);
    assert.equal(document.querySelector('.status-text').textContent, '已完成');
    assert.doesNotMatch(document.querySelector('.status-text').textContent, /0|100|文件/);
    assert.equal(document.querySelector('.fs-mini-ring'), null);
    assert.equal(document.querySelector('.fs-selection-status'), null);
    state.syncStateFromSnapshot({ platform: 'darwin', sources: [{ root: '/stale' }], default_workspace: '/stale' });
    assert.equal(state.getEntries()[0].root, '/source');
    assert.equal(state.getDefaultWorkspace(), '');
});

test('selection changes preserve compact cards without submission labels on any source', async () => {
    const { document } = dom();
    await selection([E('/workspace'), E('/a')]);
    state.setDefaultWorkspace('/workspace');
    state.setSnapshot({
        status: 'running',
        mode: 'base-only',
        sources: ['/workspace', '/a'].map((root) => ({ root, state: 'completed', total_files: 1 }))
    });
    const sources = createSources({ document });
    document.body.append(sources.element);
    cleanup.push(() => sources.destroy());
    state.editEntries([E('/workspace'), E('/a'), E('/new')], { undoable: true });
    assert.equal(document.querySelectorAll('.fs-source-card[data-source-id]').length, 3);
    assert.equal(document.querySelectorAll('.fs-selection-status').length, 0);
    for (const root of ['/workspace', '/a']) {
        const card = document.querySelector(`[data-source-id="${root}"]`);
        assert.equal(card.querySelector('.status-text').textContent, '基础索引 · 1 文件');
        assert.equal(card.querySelector('.info').children.length, 2);
        assert.ok(card.querySelector('.fs-mini-ring'));
        assert.equal(card.dataset.progress, '100');
    }
    const placeholder = document.querySelector('[data-source-id="/new"]');
    assert.equal(placeholder.querySelector('.status-text').textContent, '等待扫描');
    assert.equal(placeholder.querySelector('.info').children.length, 2);
    assert.equal(placeholder.querySelector('.fs-mini-ring'), null);
    assert.doesNotMatch(sources.element.textContent, /最近扫描状态|选择待提交|正在提交选择|选择尚未保存/);
    assert.ok(state.rollbackUndo());
    assert.equal(document.querySelector('[data-source-id="/new"]'), null);
});

test('selection operation toasts retain the original user-facing wording', async () => {
    const { document } = dom();
    await selection();
    const toast = createToast({ container: document.body, t: createRendererTranslator('zh-CN') });
    cleanup.push(() => toast.destroy());
    for (const [action, text] of [
        ['add-entry', '已加入 AI 理解范围'],
        ['consolidate', '已加入 AI 理解范围'],
        ['exclude', '已忽略这个文件夹'],
        ['restore', '已重新加入 AI 理解范围'],
        ['carve-out', '已重新加入 AI 理解范围']
    ]) {
        toast.showFromPayload({ path: '/测试目录', toastAction: action, toast: 'info' });
        assert.equal(document.querySelector('.fs-toast__text').textContent, `${text}「测试目录」`);
    }
});

test('slow submission adds no card labels and a successful save adds no extra toast', async () => {
    const response = deferred();
    const h = await widgetFixture();
    h.window.settingAPI.saveSettingObject = () => response.promise;
    const pending = state.commitEntriesNow([E('/test/a'), E('/new')]);
    cleanup.push(() => response.resolve(settings([E('/test/a'), E('/new')])));
    await flush();
    assert.equal(h.widget.querySelectorAll('.fs-source-card[data-source-id]').length, 2);
    assert.equal(h.widget.querySelector('.fs-selection-status'), null);
    response.resolve(settings([E('/test/a'), E('/new')]));
    await pending;
    assert.equal(h.document.querySelector('.fs-toast.show'), null);
    assert.doesNotMatch(h.document.body.textContent, /选择已保存|选择待提交|正在提交选择/);
});

test('U03 expired toast click cannot claim an undo, even before timers get CPU time', async (t) => {
    const { document, window } = dom();
    await selection([E('/old')]);
    let now = 0;
    t.mock.method(Date, 'now', () => now);
    state.editEntries([], { undoable: true });
    const toast = createToast({ container: document.body, t: createRendererTranslator('zh-CN') });
    cleanup.push(() => toast.destroy());
    toast.showFromPayload({ path: '/old', toast: 'undo' });
    now = 3000;
    document.querySelector('.undo-btn').dispatchEvent(new window.Event('click'));
    assert.doesNotMatch(document.querySelector('.fs-toast__text').textContent, /已撤销|Undone/);
    assert.deepEqual(state.getEntries(), []);
});

test('U03 successful toast undo reports success only once and restores actual selection', async () => {
    const { document, window } = dom();
    await selection([E('/old')]);
    state.editEntries([], { undoable: true });
    const toast = createToast({ container: document.body, t: createRendererTranslator('zh-CN') });
    cleanup.push(() => toast.destroy());
    toast.showFromPayload({ path: '/old', toast: 'undo' });
    document.querySelector('.undo-btn').dispatchEvent(new window.Event('click'));
    assert.deepEqual(state.getEntries(), [E('/old')]);
    assert.equal(document.querySelector('.fs-toast__text').textContent, '已撤销');
});

test('U09 settings listener precedes initial read and null backend snapshot is never fabricated', async () => {
    const initial = deferred();
    let reads = 0;
    const h = await widgetFixture({
        load: (current) => (++reads === 1 ? initial.promise : clone(current)),
        call: async () => null
    });
    h.notify(settings([E('/latest')], '/latest'));
    initial.resolve(settings([E('/old')], '/old'));
    await flush();
    assert.equal(reads, 2);
    assert.deepEqual(state.getEntries(), [E('/latest')]);
    assert.equal(state.getDefaultWorkspace(), '/latest');
    assert.equal(state.getSnapshot(), null);
});

test('U09 actual entry accepts idle settings workspace change without a write and keeps locale updates', async () => {
    const h = await widgetFixture();
    h.notify(settings([E('/parent')], '/parent'));
    await flush();
    assert.deepEqual(state.getEntries(), [E('/parent')]);
    assert.equal(state.getDefaultWorkspace(), '/parent');
    assert.equal(h.writes.length, 0);
    h.notify({ ...settings([E('/parent')], '/parent'), locale: 'en-US' });
    await flush();
    assert.match(h.widget.textContent, /Waiting to scan/);
});

test('U12 delete confirmation calculates from current selection rather than old dialog payload', async () => {
    const h = await widgetFixture();
    const deleting = h.widget._showDeleteRootModal('/test/a', { result: { nextEntries: [] } });
    await flush();
    state.editEntries([E('/test/a'), E('/test/new')]);
    h.widget.querySelector('.od-confirm-btn-danger').dispatchEvent(new h.window.Event('click', { bubbles: true }));
    await deleting;
    assert.deepEqual(state.getEntries(), [E('/test/new')]);
    assert.equal(h.writes.length, 1);
    assert.deepEqual(h.writes[0].applications.filemgr.entries, [E('/test/new')]);
});

test('U12 delete confirmation never switches to an equivalent source after its original root disappears', async () => {
    const h = await widgetFixture();
    h.notify(settings([E('C:/workspace'), E('D:'), E('D:/')], 'C:/workspace'));
    await flush();
    const deleting = h.widget._showDeleteRootModal('D:');
    await flush();
    const remaining = [E('C:/workspace'), E('D:/')];
    h.notify(settings(remaining, 'C:/workspace'));
    await flush();
    h.widget.querySelector('.od-confirm-btn-danger').dispatchEvent(new h.window.Event('click', { bubbles: true }));
    assert.equal(await deleting, false);
    assert.deepEqual(state.getEntries(), remaining);
    assert.equal(h.writes.length, 0);
});

test('U12 a normalized tree path binds the raw source when opening the delete dialog', async () => {
    const h = await widgetFixture();
    h.notify(settings([E('C:/workspace'), E('D:')], 'C:/workspace'));
    await flush();
    const deleting = h.widget._showDeleteRootModal('D:/');
    await flush();
    h.notify(settings([E('C:/workspace'), E('D:'), E('D:/')], 'C:/workspace'));
    await flush();
    h.widget.querySelector('.od-confirm-btn-danger').dispatchEvent(new h.window.Event('click', { bubbles: true }));
    assert.equal(await deleting, true);
    const remaining = [E('C:/workspace'), E('D:/')];
    assert.deepEqual(state.getEntries(), remaining);
    assert.equal(h.writes.length, 1);
    assert.deepEqual(h.writes[0].applications.filemgr.entries, remaining);
});

test('U12 an exact raw source takes precedence over an equivalent source at dialog open', async () => {
    const h = await widgetFixture();
    h.notify(settings([E('C:/workspace'), E('D:/'), E('D:')], 'C:/workspace'));
    await flush();
    const deleting = h.widget._showDeleteRootModal('D:');
    await flush();
    h.widget.querySelector('.od-confirm-btn-danger').dispatchEvent(new h.window.Event('click', { bubbles: true }));
    await deleting;
    assert.deepEqual(h.writes[0].applications.filemgr.entries, [E('C:/workspace'), E('D:/')]);
});

test('U12 a source that becomes the workspace while confirmation is open remains protected', async () => {
    const h = await widgetFixture();
    h.notify(settings([E('C:/workspace'), E('D:')], 'C:/workspace'));
    await flush();
    let protectedNotices = 0;
    h.widget._showProtectedWorkspaceModal = async () => {
        protectedNotices++;
        return false;
    };
    const deleting = h.widget._showDeleteRootModal('D:/');
    await flush();
    const latest = settings([E('C:/workspace'), E('D:')], 'D:/');
    h.notify(latest);
    await flush();
    h.widget.querySelector('.od-confirm-btn-danger').dispatchEvent(new h.window.Event('click', { bubbles: true }));
    assert.equal(await deleting, false);
    assert.equal(protectedNotices, 1);
    assert.equal(h.writes.length, 0);
    assert.deepEqual(state.getEntries(), latest.applications.filemgr.entries);
});

test('U11 late pause reply and dialog completion after close never write into reopened page', async () => {
    const paused = deferred();
    const h = await widgetFixture({ call: async (method) => (method === 'setSourcePaused' ? paused.promise : null) });
    const pausing = h.widget._setSourcePaused({ root: '/test/a', paused: true });
    const deleting = h.widget._showDeleteRootModal('/test/a');
    await flush();
    h.widget.remove();
    await deleting;
    h.document.body.append(h.widget);
    await flush();
    paused.resolve({ status: 'ok', data: { status: 'running', sources: [{ root: '/late', paused: true }] } });
    await pausing;
    assert.equal(state.getSnapshot(), null);
    assert.deepEqual(state.getEntries(), [E('/test/a')]);
    assert.equal(h.writes.length, 0);
    assert.equal(h.unsubscribed(), 1);
});

test('U11 the same widget accepts its first unchanged real status after reconnect and still deduplicates within a page', async () => {
    const status = {
        status: 'running',
        mode: 'full',
        platform: 'darwin',
        is_openharmony: false,
        home_path: '/test',
        sources: [{ root: '/test/a', paused: true, state: 'paused', total_files: 3 }]
    };
    const h = await widgetFixture({
        call: async (method) => (method === 'getFileSystemStatus' ? clone(status) : null)
    });
    assert.deepEqual(state.getSnapshot(), status);
    assert.equal(h.widget.querySelector('.fs-tree-overlay'), null);
    assert.equal(h.widget.querySelector('.source-resume-btn')?.textContent, '继续扫描');
    const received = [];
    cleanup.push(state.subscribeSnapshot((next) => received.push(next)));

    h.status(clone(status));
    await flush();
    assert.equal(received.length, 0);
    h.widget.remove();
    h.document.body.append(h.widget);
    await flush();

    assert.deepEqual(state.getSnapshot(), status);
    assert.equal(h.widget.querySelector('.fs-tree-overlay'), null);
    assert.equal(h.widget.querySelector('.status-text')?.textContent, '已暂停 · 3 个文件');
    assert.equal(h.widget.querySelector('.source-resume-btn')?.textContent, '继续扫描');
    assert.equal(h.calls.filter(([method]) => method === 'getFileSystemStatus').length, 2);
    assert.equal(received.filter((next) => next !== null).length, 1);
    const accepted = state.getSnapshot();
    const count = received.length;
    h.status(clone(status));
    await flush();
    assert.equal(state.getSnapshot(), accepted);
    assert.equal(received.length, count);
});

test('U11 destroyed source component consumes late rejection without recreating UI', async () => {
    const { document, window } = dom();
    await selection([E('/real')]);
    const pending = deferred();
    state.setSnapshot({ status: 'running', sources: [{ root: '/real', state: 'completed', total_files: 1 }] });
    const sources = createSources({ document, onSetSourcePaused: () => pending.promise });
    document.body.append(sources.element);
    document.querySelector('.source-control-btn').dispatchEvent(new window.Event('click'));
    await flush();
    sources.destroy();
    pending.reject(Error('late failure'));
    await flush();
    assert.equal(document.querySelector('.fs-source-card'), null);
});

test('U09 a notification returning to baseline still invalidates an in-progress settings read', async () => {
    const read = deferred();
    let loads = 0;
    const h = await widgetFixture({ load: (current) => (++loads === 2 ? read.promise : clone(current)) });
    h.notify(settings([E('/external')]));
    await flush();
    h.notify(settings([E('/test/a')]));
    read.resolve(settings([E('/external')]));
    await flush();
    assert.equal(loads, 3);
    assert.deepEqual(state.getEntries(), [E('/test/a')]);
});
