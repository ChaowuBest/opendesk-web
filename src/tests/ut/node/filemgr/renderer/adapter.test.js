import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import {
    loadDefaultWorkspace,
    loadEntries,
    saveEntries,
    subscribeStatus
} from '../../../../../main/applications/filemgr/renderer/adapter.js';
import {
    clearPendingCommit,
    getEntries,
    setDefaultWorkspace,
    setEntries,
    setSnapshot
} from '../../../../../main/applications/filemgr/renderer/state.js';

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
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(widget.querySelector('.fs-error'), null);
    assert.ok(widget.querySelector('.fs-tree-wrapper'));
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
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.equal(widget.querySelector('.fs-error'), null);
        assert.ok(widget.querySelector('.fs-window'));
        assert.ok(widget.textContent.includes('正在启动'));
        assert.deepEqual(getEntries(), []);
    } finally {
        console.warn = warn;
    }
});
