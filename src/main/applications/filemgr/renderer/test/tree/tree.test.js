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
import { createActions } from '../../actions.js';
import { setDefaultWorkspace } from '../../state.js';

test('file tree initializes with a single home entry in the first column', async () => {
    const { document, window } = parseHTML('<!doctype html><html><head></head><body><main></main></body></html>');
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    const previousNavigator = globalThis.navigator;
    const previousResizeObserver = globalThis.ResizeObserver;
    const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
    const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const listedPaths = [];

    globalThis.document = document;
    globalThis.window = window;
    Object.defineProperty(globalThis, 'navigator', {
        value: { platform: 'MacIntel' },
        configurable: true
    });
    globalThis.ResizeObserver = class {
        observe() {}
        disconnect() {}
    };
    globalThis.requestAnimationFrame = (callback) => {
        callback();
        return 1;
    };
    globalThis.cancelAnimationFrame = () => {};
    window.systemInfo = { homePath: '/Users/liumingxing' };
    window.settingAPI = {
        async loadSettingObject() {
            return {
                default_workspace: '/Users/liumingxing/FillipDesk',
                applications: {
                    filemgr: {
                        entries: []
                    }
                }
            };
        }
    };
    window.workspaceAPI = {
        async listDirectory(path) {
            listedPaths.push(path);
            if (path === '/Users/liumingxing') {
                return [
                    { path: '/Users/liumingxing/Desktop', name: 'Desktop', isDirectory: true },
                    { path: '/Users/liumingxing/Documents', name: 'Documents', isDirectory: true }
                ];
            }
            return [];
        },
        async listDrives() {
            return [];
        }
    };

    try {
        const { createFileTree } = await import('../../tree.js');
        const tree = createFileTree(document.querySelector('main'));
        await tree.ready;

        assert.deepEqual(listedPaths, ['/Users/liumingxing']);
        const firstColumnRows = Array.from(
            document.querySelectorAll('.fs-tree-col[data-col-idx="0"] .fs-tree-row')
        ).map((row) => row.dataset.path);
        assert.deepEqual(firstColumnRows, ['/Users/liumingxing']);

        tree.destroy();
    } finally {
        globalThis.document = previousDocument;
        globalThis.window = previousWindow;
        Object.defineProperty(globalThis, 'navigator', {
            value: previousNavigator,
            configurable: true
        });
        globalThis.ResizeObserver = previousResizeObserver;
        globalThis.requestAnimationFrame = previousRequestAnimationFrame;
        globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
    }
});

test('home action navigates to a single home entry in the first column', () => {
    const { document, window } = parseHTML('<!doctype html><html><head></head><body><main></main></body></html>');
    const previousWindow = globalThis.window;
    const previousNavigator = globalThis.navigator;
    const calls = [];

    globalThis.window = window;
    Object.defineProperty(globalThis, 'navigator', {
        value: { platform: 'MacIntel' },
        configurable: true
    });
    window.systemInfo = { homePath: '/Users/liumingxing' };
    setDefaultWorkspace('/Users/liumingxing/FillipDesk');

    try {
        const actions = createActions(document.querySelector('main'), {
            document,
            tree: {
                setRoot(path) {
                    calls.push(['setRoot', path]);
                },
                setRootAndExpandTo(rootPath, targetPath) {
                    calls.push(['setRootAndExpandTo', rootPath, targetPath]);
                },
                setRootEntry(path) {
                    calls.push(['setRootEntry', path]);
                }
            }
        });

        const homeButton = Array.from(document.querySelectorAll('button')).find((button) =>
            button.textContent.includes('家目录')
        );
        homeButton?.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));

        assert.deepEqual(calls, [['setRootEntry', '/Users/liumingxing']]);

        actions.destroy();
    } finally {
        globalThis.window = previousWindow;
        Object.defineProperty(globalThis, 'navigator', {
            value: previousNavigator,
            configurable: true
        });
        setDefaultWorkspace('');
    }
});
