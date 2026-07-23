/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

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

async function importRendererComponentForTest(relativePath, name) {
    return import(
        new URL(`../../../../../renderer/components/${relativePath}?${name}-${Date.now()}`, import.meta.url).href
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

test('homepage search result actions render attach/open/reveal on desktop and OpenHarmony', async () => {
    const { window } = parseHTML('<!doctype html><html><head></head><body></body></html>');
    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.HTMLElement = window.HTMLElement;
    globalThis.customElements = window.customElements;
    globalThis.CustomEvent = window.CustomEvent;
    globalThis.Event = window.Event;
    window.systemInfo = { isOpenHarmony: false };

    await importRendererComponentForTest('recommendation.ts', 'desktop-actions');
    const panel = window.document.createElement('recommendation-panel');
    window.document.body.appendChild(panel);
    panel.showSearchTab({
        query: '报告',
        results: [
            {
                path: '/Users/liumingxing/报告.pdf',
                filename: '报告.pdf',
                modified: Date.now(),
                size: 1024,
                snippet: null,
                matchTypes: ['keyword'],
                score: 1
            }
        ],
        loading: false
    });

    assert.equal(panel.querySelectorAll('.search-attach-btn').length, 1);
    assert.equal(panel.querySelectorAll('.search-open-btn').length, 1);
    assert.equal(panel.querySelectorAll('.search-reveal-btn').length, 1);

    const attachEvents = [];
    const openEvents = [];
    const revealEvents = [];
    panel.addEventListener('homepage-search-attach', (event) => attachEvents.push(event.detail?.path));
    panel.addEventListener('homepage-search-open', (event) => openEvents.push(event.detail?.path));
    panel.addEventListener('homepage-search-reveal', (event) => revealEvents.push(event.detail?.path));
    panel.querySelector('.search-attach-btn')?.dispatchEvent(new window.Event('click', { bubbles: true }));
    panel.querySelector('.search-open-btn')?.dispatchEvent(new window.Event('click', { bubbles: true }));
    panel.querySelector('.search-reveal-btn')?.dispatchEvent(new window.Event('click', { bubbles: true }));
    assert.deepEqual(attachEvents, ['/Users/liumingxing/报告.pdf']);
    assert.deepEqual(openEvents, ['/Users/liumingxing/报告.pdf']);
    assert.deepEqual(revealEvents, ['/Users/liumingxing/报告.pdf']);

    window.systemInfo = { isOpenHarmony: true };
    panel.showSearchTab({
        query: '报告',
        results: [
            {
                path: '/Users/liumingxing/报告.pdf',
                filename: '报告.pdf',
                modified: Date.now(),
                size: 1024,
                snippet: null,
                matchTypes: ['keyword'],
                score: 1
            }
        ],
        loading: false
    });

    assert.equal(panel.querySelectorAll('.search-attach-btn').length, 1);
    assert.equal(panel.querySelectorAll('.search-open-btn').length, 1);
    assert.equal(panel.querySelectorAll('.search-reveal-btn').length, 1);
    panel.querySelector('.search-open-btn')?.dispatchEvent(new window.Event('click', { bubbles: true }));
    panel.querySelector('.search-reveal-btn')?.dispatchEvent(new window.Event('click', { bubbles: true }));
    assert.deepEqual(openEvents, ['/Users/liumingxing/报告.pdf', '/Users/liumingxing/报告.pdf']);
    assert.deepEqual(revealEvents, ['/Users/liumingxing/报告.pdf', '/Users/liumingxing/报告.pdf']);
});

test('homepage search attach preserves search mode and attached files after manual exit', async () => {
    const { window } = parseHTML('<!doctype html><html><head></head><body></body></html>');
    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.HTMLElement = window.HTMLElement;
    globalThis.customElements = window.customElements;
    globalThis.CustomEvent = window.CustomEvent;
    globalThis.Event = window.Event;
    globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
    globalThis.ResizeObserver = class {
        observe() {}
        disconnect() {}
    };
    if (window.HTMLTextAreaElement?.prototype && !window.HTMLTextAreaElement.prototype.setSelectionRange) {
        window.HTMLTextAreaElement.prototype.setSelectionRange = function (start, end) {
            this.selectionStart = start;
            this.selectionEnd = end;
        };
    }
    window.requestAnimationFrame = globalThis.requestAnimationFrame;
    window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
    window.systemInfo = { isOpenHarmony: false };
    window.workspaceAPI = {
        getEffectiveWorkspace: async () => '/Users/liumingxing/FillipDesk',
        setWorkspaceDirectory: async (path) => path
    };
    window.applicationRegistryAPI = {
        subscribeEvent: async () => () => {},
        call: async () => ({})
    };
    window.fsAPI = { openPath: async () => {} };
    window.taskManagerAPI = { createTask: async () => ({}), submitMessage: async () => {} };
    window.globalControlAPI = { openHomePage: () => {}, openTask: () => {} };
    window.notificationAPI = { sendNotification: async () => {} };

    await importRendererComponentForTest('recommendation.ts', 'homepage-attach');
    await importRendererComponentForTest('agentinput.js', 'homepage-attach');
    await importRendererComponentForTest('homepage.js', 'homepage-attach');

    const page = window.document.createElement('home-page');
    window.document.body.appendChild(page);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const agentInput = page.querySelector('#agent-input-main');
    const recommendation = page.querySelector('#home-recommendation');
    const attached = [];
    agentInput.attachFilePath = (filePath) => {
        attached.push(filePath);
        agentInput.attachedFilePaths.push(filePath);
    };

    page._setSearchMode(true);
    recommendation.dispatchEvent(
        new window.CustomEvent('homepage-search-attach', {
            detail: { path: '/Users/liumingxing/报告.pdf' },
            bubbles: true
        })
    );
    recommendation.dispatchEvent(
        new window.CustomEvent('homepage-search-attach', {
            detail: { path: '/Users/liumingxing/报告.pdf' },
            bubbles: true
        })
    );

    assert.equal(agentInput.isSearchMode(), true);
    assert.deepEqual(attached, ['/Users/liumingxing/报告.pdf']);

    agentInput.querySelector('#agent-input-textarea').value = '报告';
    page._setSearchMode(false);

    assert.deepEqual(agentInput.attachedFilePaths, ['/Users/liumingxing/报告.pdf']);
    assert.equal(agentInput.querySelector('#agent-input-textarea').value, '报告');
});
