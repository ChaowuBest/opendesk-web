import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import {
    loadDefaultWorkspace,
    loadEntries,
    saveEntries,
    setSourcePaused,
    subscribeStatus
} from '../../../../../main/applications/filemgr/renderer/adapter.js';
import {
    clearPendingCommit,
    getEntries,
    setDefaultWorkspace,
    setEntries,
    setSnapshot
} from '../../../../../main/applications/filemgr/renderer/state.js';

const mountedWidgets = new Set();

function resetState() {
    clearPendingCommit();
    setSnapshot(null);
    setEntries([]);
    setDefaultWorkspace('');
}

async function importEntryForTest(name) {
    return import(
        new URL(`../../../../../main/applications/filemgr/renderer/entry.js?${name}-${Date.now()}`, import.meta.url)
            .href
    );
}

test.afterEach(() => {
    for (const widget of mountedWidgets) widget.remove();
    mountedWidgets.clear();
    resetState();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.HTMLElement;
    delete globalThis.customElements;
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
    delete globalThis.CustomEvent;
    delete globalThis.Event;
    delete globalThis.ResizeObserver;
});

test('subscribeStatus unwraps proxy event payload arrays', async () => {
    let handler = null;
    globalThis.window = {
        applicationAPI: {
            subscribe: async (_eventName, cb) => {
                handler = cb;
            },
            unsubscribe: async () => {}
        }
    };
    const received = [];

    const unsubscribe = subscribeStatus((snapshot) => {
        received.push(snapshot);
    });
    await Promise.resolve();

    handler([
        {
            reason: 'tick',
            snapshot: {
                status: 'running',
                sources: [{ root: '/workspace' }]
            }
        }
    ]);

    unsubscribe();
    assert.deepEqual(received, [
        {
            status: 'running',
            sources: [{ root: '/workspace' }]
        }
    ]);
});

test('settings adapter tolerates missing filemgr settings', async () => {
    const saved = [];
    globalThis.window = {
        settingAPI: {
            loadSettingObject: async () => ({
                theme: 'dark',
                applications: {
                    other: { enabled: true }
                }
            }),
            saveSettingObject: async (next) => {
                saved.push(next);
            }
        }
    };

    assert.deepEqual(await loadEntries(), []);
    assert.equal(await loadDefaultWorkspace(), null);

    await saveEntries(undefined);
    assert.deepEqual(saved.at(-1), {
        theme: 'dark',
        applications: {
            other: { enabled: true },
            filemgr: { entries: [] }
        }
    });

    await saveEntries([{ root: '/docs' }]);
    assert.deepEqual(saved.at(-1).applications.filemgr.entries, [{ root: '/docs' }]);
    assert.deepEqual(saved.at(-1).applications.other, { enabled: true });
});

test('setSourcePaused sends one root command and returns authoritative snapshot', async () => {
    const calls = [];
    const snapshot = { status: 'running', sources: [{ root: '/docs', paused: true }] };
    globalThis.window = {
        applicationAPI: {
            call: async (...args) => {
                calls.push(args);
                return { status: 'ok', data: snapshot };
            }
        }
    };

    assert.deepEqual(await setSourcePaused({ root: '/docs', paused: true }), snapshot);
    assert.deepEqual(calls, [['setSourcePaused', { root: '/docs', paused: true }]]);
});

test('setSourcePaused preserves structured worker errors', async () => {
    const snapshot = { status: 'running', sources: [{ root: '/docs', paused: false }] };
    globalThis.window = {
        applicationAPI: {
            call: async () => ({ status: 'error', code: 'persistence_failed', data: snapshot })
        }
    };

    await assert.rejects(
        () => setSourcePaused({ root: '/docs', paused: true }),
        (error) => error.code === 'persistence_failed' && error.snapshot === snapshot
    );
});

test('filemgr entry mounts when initial status request fails', async () => {
    const { window } = parseHTML('<!doctype html><html><head></head><body></body></html>');
    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.HTMLElement = window.HTMLElement;
    globalThis.customElements = window.customElements;
    globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
    window.requestAnimationFrame = globalThis.requestAnimationFrame;
    window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
    window.applicationAPI = {
        call: async (methodName) => {
            if (methodName === 'getFileSystemStatus') {
                throw new Error('status query failed');
            }
            return null;
        },
        subscribe: async () => {},
        unsubscribe: async () => {}
    };
    window.settingAPI = {
        loadSettingObject: async () => ({
            locale: 'zh-CN',
            default_workspace: '/workspace',
            applications: {
                filemgr: {
                    entries: []
                }
            }
        })
    };
    const warn = console.warn;
    console.warn = () => {};

    try {
        await import('../../../../../main/applications/filemgr/renderer/entry.js');
        const widget = window.document.createElement('filemgr-entry-widget');
        window.document.body.appendChild(widget);
        mountedWidgets.add(widget);
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.equal(widget.querySelector('.fs-error'), null);
        assert.ok(widget.querySelector('.fs-window'));
        assert.ok(widget.textContent.includes('正在启动'));
        assert.ok(!widget.textContent.includes('未配置'));
    } finally {
        console.warn = warn;
    }
});

test('filemgr entry mounts before initial status request resolves', async () => {
    const { window } = parseHTML('<!doctype html><html><head></head><body></body></html>');
    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.HTMLElement = window.HTMLElement;
    globalThis.customElements = window.customElements;
    globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
    globalThis.ResizeObserver = class {
        observe() {}
        disconnect() {}
    };
    window.requestAnimationFrame = globalThis.requestAnimationFrame;
    window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
    window.applicationAPI = {
        call: async (methodName) => {
            if (methodName === 'getFileSystemStatus') {
                return new Promise(() => {});
            }
            return null;
        },
        subscribe: async () => {},
        unsubscribe: async () => {}
    };
    window.settingAPI = {
        loadSettingObject: async () => ({
            applications: {
                filemgr: {
                    entries: []
                }
            }
        })
    };
    window.workspaceAPI = {
        listDirectory: async () => [],
        listDrives: async () => []
    };

    await importEntryForTest('status-pending');
    const widget = window.document.createElement('filemgr-entry-widget');
    window.document.body.appendChild(widget);
    mountedWidgets.add(widget);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(widget.querySelector('.fs-error'), null);
    assert.ok(widget.querySelector('.fs-tree-wrapper'));
});

test('filemgr entry applies setSourcePaused response snapshot', async () => {
    const { window } = parseHTML('<!doctype html><html><head></head><body></body></html>');
    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.HTMLElement = window.HTMLElement;
    globalThis.customElements = window.customElements;
    globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
    globalThis.ResizeObserver = class {
        observe() {}
        disconnect() {}
    };
    window.requestAnimationFrame = globalThis.requestAnimationFrame;
    window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
    const root = '/workspace';
    const entry = { root, include_patterns: ['**/*'], exclude_patterns: [] };
    const initial = {
        status: 'running',
        mode: 'full',
        default_workspace: null,
        alerts: [],
        sources: [{ root, entry, paused: false, state: 'completed', total_files: 4, last_scan_at: 1 }],
        totals: null,
        storage_stats: null,
        storage: null,
        readonly: false
    };
    window.applicationAPI = {
        call: async (methodName, request) => {
            if (methodName === 'getFileSystemStatus') return initial;
            if (methodName === 'setSourcePaused') {
                assert.deepEqual(request, { root, paused: true });
                return {
                    status: 'ok',
                    data: {
                        ...initial,
                        sources: [{ ...initial.sources[0], paused: true, state: 'paused' }]
                    }
                };
            }
            return null;
        },
        subscribe: async () => {},
        unsubscribe: async () => {}
    };
    window.settingAPI = {
        loadSettingObject: async () => ({
            locale: 'en-US',
            default_workspace: null,
            applications: { filemgr: { entries: [entry] } }
        })
    };
    window.workspaceAPI = {
        listDirectory: async () => [],
        listDrives: async () => []
    };

    await importEntryForTest('source-pause-success');
    const widget = window.document.createElement('filemgr-entry-widget');
    window.document.body.appendChild(widget);
    mountedWidgets.add(widget);
    await new Promise((resolve) => setTimeout(resolve, 20));
    widget
        .querySelector('.source-control-btn')
        ?.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(widget.querySelector('.fs-source-card')?.dataset.state, 'paused');
    assert.equal(widget.querySelector('.source-control-btn')?.textContent, 'Continue scanning');
});

test('filemgr entry updates source controls when locale changes at runtime', async () => {
    const { window } = parseHTML('<!doctype html><html><head></head><body></body></html>');
    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.HTMLElement = window.HTMLElement;
    globalThis.customElements = window.customElements;
    globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
    globalThis.ResizeObserver = class {
        observe() {}
        disconnect() {}
    };
    window.requestAnimationFrame = globalThis.requestAnimationFrame;
    window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
    const root = '/workspace-locale-switch';
    const entry = { root, include_patterns: ['**/*'], exclude_patterns: [] };
    const initial = {
        status: 'running',
        mode: 'full',
        default_workspace: null,
        alerts: [],
        sources: [{ root, entry, paused: true, state: 'paused', total_files: 4, last_scan_at: 1 }],
        totals: null,
        storage_stats: null,
        storage: null,
        readonly: false
    };
    let localeHandler;
    let resolveControl;
    window.applicationAPI = {
        call: async (methodName) => {
            if (methodName === 'getFileSystemStatus') return initial;
            if (methodName === 'setSourcePaused') {
                return new Promise((resolve) => {
                    resolveControl = () => resolve({ status: 'error', code: 'runtime_failed', data: initial });
                });
            }
            return null;
        },
        subscribe: async () => {},
        unsubscribe: async () => {}
    };
    window.settingAPI = {
        loadSettingObject: async () => ({
            locale: 'zh-CN',
            default_workspace: null,
            applications: { filemgr: { entries: [entry] } }
        }),
        onSettingChanged: (handler) => {
            localeHandler = handler;
            return () => {};
        }
    };
    window.workspaceAPI = {
        listDirectory: async () => [],
        listDrives: async () => []
    };

    await importEntryForTest('source-control-locale-switch');
    const widget = window.document.createElement('filemgr-entry-widget');
    window.document.body.appendChild(widget);
    mountedWidgets.add(widget);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(widget.querySelector('.source-control-btn')?.textContent, '继续扫描');
    localeHandler({ locale: 'en-US' });
    assert.equal(widget.querySelector('.source-control-btn')?.textContent, 'Continue scanning');
    assert.equal(widget.querySelector('.status-text')?.textContent, 'Paused · 4 files');

    widget
        .querySelector('.source-control-btn')
        ?.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    assert.match(widget.querySelector('.status-text')?.textContent ?? '', /Resuming/);

    resolveControl();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(
        widget.querySelector('.fs-source-control-error')?.textContent,
        'The pause or resume operation failed. Retry.'
    );
});

test('filemgr entry settles transport failure and recovers from subscribed status', async () => {
    const { window } = parseHTML('<!doctype html><html><head></head><body></body></html>');
    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.HTMLElement = window.HTMLElement;
    globalThis.customElements = window.customElements;
    globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
    globalThis.ResizeObserver = class {
        observe() {}
        disconnect() {}
    };
    window.requestAnimationFrame = globalThis.requestAnimationFrame;
    window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
    const root = '/workspace-transport-recovery';
    const entry = { root, include_patterns: ['**/*'], exclude_patterns: [] };
    const initial = {
        status: 'running',
        mode: 'full',
        default_workspace: null,
        alerts: [],
        sources: [{ root, entry, paused: false, state: 'completed', total_files: 4, last_scan_at: 1 }],
        totals: null,
        storage_stats: null,
        storage: null,
        readonly: false
    };
    let rejectTransport;
    let statusHandler;
    window.applicationAPI = {
        call: async (methodName) => {
            if (methodName === 'getFileSystemStatus') return initial;
            if (methodName === 'setSourcePaused') {
                return new Promise((_resolve, reject) => {
                    rejectTransport = reject;
                });
            }
            return null;
        },
        subscribe: async (eventName, handler) => {
            if (eventName === 'onStatusChanged') statusHandler = handler;
        },
        unsubscribe: async () => {}
    };
    window.settingAPI = {
        loadSettingObject: async () => ({
            locale: 'en-US',
            default_workspace: null,
            applications: { filemgr: { entries: [entry] } }
        })
    };
    window.workspaceAPI = {
        listDirectory: async () => [],
        listDrives: async () => []
    };

    await importEntryForTest('source-pause-transport-recovery');
    const widget = window.document.createElement('filemgr-entry-widget');
    window.document.body.appendChild(widget);
    mountedWidgets.add(widget);
    await new Promise((resolve) => setTimeout(resolve, 20));
    widget
        .querySelector('.source-control-btn')
        ?.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    assert.ok(widget.querySelector('.source-control-spinner'));
    assert.equal(widget.querySelector('.fs-source-card')?.dataset.state, 'completed');

    rejectTransport(new Error('transport unavailable'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(widget.querySelector('.source-control-spinner'), null);
    assert.equal(widget.querySelector('.fs-source-card')?.dataset.state, 'completed');
    assert.ok(widget.querySelector('.fs-source-control-error'));

    statusHandler({
        reason: 'tick',
        snapshot: {
            ...initial,
            sources: [{ ...initial.sources[0], paused: true, state: 'paused' }]
        }
    });
    await Promise.resolve();
    assert.equal(widget.querySelector('.fs-source-card')?.dataset.state, 'paused');
    assert.equal(widget.querySelector('.source-control-btn')?.textContent, 'Continue scanning');
    assert.equal(widget.querySelector('.fs-source-control-error'), null);
});

test('filemgr entry falls back to snapshot-derived entries when settings load fails', async () => {
    const { window } = parseHTML('<!doctype html><html><head></head><body></body></html>');
    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.HTMLElement = window.HTMLElement;
    globalThis.customElements = window.customElements;
    globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
    window.requestAnimationFrame = globalThis.requestAnimationFrame;
    window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
    window.applicationAPI = {
        call: async (methodName) => {
            if (methodName === 'getFileSystemStatus') {
                return {
                    status: 'running',
                    default_workspace: '/workspace',
                    sources: [
                        {
                            root: '/workspace',
                            total_files: 42,
                            entry: {
                                root: '/workspace',
                                include_patterns: ['**/*'],
                                exclude_patterns: []
                            }
                        }
                    ]
                };
            }
            return null;
        },
        subscribe: async () => {},
        unsubscribe: async () => {}
    };
    let settingsCalls = 0;
    window.settingAPI = {
        loadSettingObject: async () => {
            settingsCalls++;
            if (settingsCalls === 1) {
                throw new Error('settings unavailable');
            }
            return {
                locale: 'zh-CN',
                default_workspace: '/workspace',
                applications: {
                    filemgr: {
                        entries: [{ root: '/workspace', include_patterns: ['**/*'], exclude_patterns: [] }]
                    }
                }
            };
        }
    };
    const warn = console.warn;
    console.warn = () => {};

    try {
        await importEntryForTest('settings-fail');
        const widget = window.document.createElement('filemgr-entry-widget');
        window.document.body.appendChild(widget);
        mountedWidgets.add(widget);
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.equal(widget.querySelector('.fs-error'), null);
        assert.deepEqual(
            getEntries().map((entry) => entry.root),
            ['/workspace']
        );
        assert.equal(widget.querySelector('.status-text')?.textContent, '已完成 · 42 文件');
    } finally {
        console.warn = warn;
    }
});

test('filemgr entry shows initializing label when both status and settings fail', async () => {
    const { window } = parseHTML('<!doctype html><html><head></head><body></body></html>');
    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.HTMLElement = window.HTMLElement;
    globalThis.customElements = window.customElements;
    globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
    window.requestAnimationFrame = globalThis.requestAnimationFrame;
    window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
    window.applicationAPI = {
        call: async (methodName) => {
            if (methodName === 'getFileSystemStatus') {
                throw new Error('status query failed');
            }
            return null;
        },
        subscribe: async () => {},
        unsubscribe: async () => {}
    };
    let settingsCalls = 0;
    window.settingAPI = {
        loadSettingObject: async () => {
            settingsCalls++;
            if (settingsCalls === 1) {
                throw new Error('settings unavailable');
            }
            return {
                locale: 'zh-CN',
                default_workspace: '/workspace',
                applications: {
                    filemgr: {
                        entries: []
                    }
                }
            };
        }
    };
    const warn = console.warn;
    console.warn = () => {};

    try {
        await importEntryForTest('status-and-settings-fail');
        const widget = window.document.createElement('filemgr-entry-widget');
        window.document.body.appendChild(widget);
        mountedWidgets.add(widget);
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.equal(widget.querySelector('.fs-error'), null);
        assert.ok(widget.querySelector('.fs-window'));
        assert.ok(widget.textContent.includes('正在启动'));
        assert.deepEqual(getEntries(), []);
    } finally {
        console.warn = warn;
    }
});
