import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { createActions } from '../../../../../../main/applications/filemgr/renderer/actions.js';
import {
    __resetForTesting,
    setDefaultWorkspace,
    setIsOpenHarmony,
    setPlatform,
    setSnapshot,
    setSystemHomePath,
    syncStateFromSnapshot
} from '../../../../../../main/applications/filemgr/renderer/state.js';
import { FileTreeChecks } from '../../../../../../main/applications/filemgr/renderer/tree/fileTreeChecks.js';
import { DRIVE_ROOT_PATH, getHomeRoot } from '../../../../../../main/applications/filemgr/renderer/tree/utils.js';

function primeDesktopPlatformSnapshot(homePath = '/Users/liumingxing') {
    const data = {
        status: 'ready',
        platform: 'darwin',
        is_openharmony: false,
        home_path: homePath,
        sources: []
    };
    syncStateFromSnapshot(data);
    setSnapshot(data);
}

function primeOpenHarmonyPlatformSnapshot(homePath = '/storage/Users/currentUser') {
    const data = {
        status: 'ready',
        platform: 'openharmony',
        is_openharmony: true,
        home_path: homePath,
        sources: []
    };
    syncStateFromSnapshot(data);
    setSnapshot(data);
}

test('file tree initializes with a single home entry in the first column', async () => {
    __resetForTesting();
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
    window.settingAPI = {
        async loadSettingObject() {
            return {
                default_workspace: '/Users/liumingxing/OpenDesk',
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

    primeDesktopPlatformSnapshot('/Users/liumingxing');

    try {
        const { createFileTree } = await import('../../../../../../main/applications/filemgr/renderer/tree.js');
        const tree = createFileTree(document.querySelector('main'));
        await tree.ready;

        assert.deepEqual(listedPaths, ['/Users/liumingxing']);
        const firstColumnRows = Array.from(
            document.querySelectorAll('.fs-tree-col[data-col-idx="0"] .fs-tree-row')
        ).map((row) => row.dataset.path);
        assert.deepEqual(firstColumnRows, ['/Users/liumingxing']);
        const secondColumnRows = Array.from(
            document.querySelectorAll('.fs-tree-col[data-col-idx="1"] .fs-tree-row')
        ).map((row) => row.dataset.path);
        assert.deepEqual(secondColumnRows, ['/Users/liumingxing/Desktop', '/Users/liumingxing/Documents']);

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
    __resetForTesting();
    const { document, window } = parseHTML('<!doctype html><html><head></head><body><main></main></body></html>');
    const previousWindow = globalThis.window;
    const calls = [];

    globalThis.window = window;
    setPlatform('darwin');
    setSystemHomePath('/Users/liumingxing');
    setDefaultWorkspace('/Users/liumingxing/OpenDesk');

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
    }
});

test('workspace action expands from the home entry instead of the home parent', () => {
    __resetForTesting();
    const { document, window } = parseHTML('<!doctype html><html><head></head><body><main></main></body></html>');
    const previousWindow = globalThis.window;
    const calls = [];

    globalThis.window = window;
    setPlatform('darwin');
    setSystemHomePath('/Users/liumingxing');
    setDefaultWorkspace('/Users/liumingxing/OpenDesk');

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
                },
                setRootEntryAndExpandTo(rootPath, targetPath) {
                    calls.push(['setRootEntryAndExpandTo', rootPath, targetPath]);
                }
            }
        });

        const workspaceButton = Array.from(document.querySelectorAll('button')).find((button) =>
            button.textContent.includes('当前工作空间')
        );
        workspaceButton?.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));

        assert.deepEqual(calls, [['setRootEntryAndExpandTo', '/Users/liumingxing', '/Users/liumingxing/OpenDesk']]);

        actions.destroy();
    } finally {
        globalThis.window = previousWindow;
    }
});

test('file tree expands workspace under a virtual home root', async () => {
    __resetForTesting();
    const { document, window } = parseHTML('<!doctype html><html><head></head><body><main></main></body></html>');
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    const previousResizeObserver = globalThis.ResizeObserver;
    const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
    const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const listedPaths = [];

    globalThis.document = document;
    globalThis.window = window;
    globalThis.ResizeObserver = class {
        observe() {}
        disconnect() {}
    };
    globalThis.requestAnimationFrame = (callback) => {
        callback();
        return 1;
    };
    globalThis.cancelAnimationFrame = () => {};

    const childrenByPath = new Map([
        [
            '/Users/liumingxing',
            [
                { path: '/Users/liumingxing/Desktop', name: 'Desktop', isDirectory: true },
                { path: '/Users/liumingxing/OpenDesk', name: 'OpenDesk', isDirectory: true }
            ]
        ],
        [
            '/Users/liumingxing/OpenDesk',
            [{ path: '/Users/liumingxing/OpenDesk/project', name: 'project', isDirectory: true }]
        ],
        ['/Users/liumingxing/OpenDesk/project', []]
    ]);

    try {
        const tree = new FileTreeChecks({
            listDirectory: async (path) => {
                listedPaths.push(path);
                if (path === '/Users') {
                    return [{ path: '/Users/Shared', name: 'Shared', isDirectory: true }];
                }
                return childrenByPath.get(path) ?? [];
            },
            listDrives: async () => [],
            onSelect: () => {}
        });
        document.querySelector('main').appendChild(tree.element);

        await tree.setRootEntryAndExpandTo(
            { path: '/Users/liumingxing', name: 'liumingxing', isDirectory: true },
            '/Users/liumingxing/OpenDesk/project'
        );

        assert.equal(listedPaths.includes('/Users'), false);
        assert.deepEqual(
            tree._columns.map((column) => column.parentPath),
            ['/Users/liumingxing', '/Users/liumingxing', '/Users/liumingxing/OpenDesk']
        );
        assert.equal(tree._columns.length, 3);
        assert.deepEqual(
            tree._columns.map((column) => column.selectedPath),
            ['/Users/liumingxing', '/Users/liumingxing/OpenDesk', '/Users/liumingxing/OpenDesk/project']
        );
        assert.equal(tree.selectedPath, '/Users/liumingxing/OpenDesk/project');

        const firstColumnRows = Array.from(
            document.querySelectorAll('.fs-tree-col[data-col-idx="0"] .fs-tree-row')
        ).map((row) => row.dataset.path);
        assert.deepEqual(firstColumnRows, ['/Users/liumingxing']);
        assert.equal(document.querySelector('[data-path="/Users/Shared"]'), null);

        tree.destroy();
    } finally {
        globalThis.document = previousDocument;
        globalThis.window = previousWindow;
        globalThis.ResizeObserver = previousResizeObserver;
        globalThis.requestAnimationFrame = previousRequestAnimationFrame;
        globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
    }
});

test('getHomeRoot picks home from worker-provided platform fields', () => {
    __resetForTesting();

    setPlatform('darwin');
    setIsOpenHarmony(false);
    setSystemHomePath('/Users/liumingxing');
    assert.equal(getHomeRoot('/Volumes/External/project'), '/Users/liumingxing');

    __resetForTesting();
    setPlatform('win32');
    setIsOpenHarmony(false);
    setSystemHomePath('C:/Users/liumingxing');
    assert.equal(getHomeRoot('C:/Users/liumingxing/project'), DRIVE_ROOT_PATH);

    __resetForTesting();
    setPlatform('openharmony');
    setIsOpenHarmony(true);
    setSystemHomePath('/storage/Users/currentUser');
    assert.equal(getHomeRoot(''), '/storage/Users/currentUser');
    assert.equal(getHomeRoot('/storage/Users'), '/storage/Users/currentUser');
    assert.equal(getHomeRoot('/storage/Users/currentUser/Desktop'), '/storage/Users/currentUser');
    assert.equal(getHomeRoot('/Users/foo'), '/storage/Users/currentUser');

    __resetForTesting();
    setPlatform('openharmony');
    setIsOpenHarmony(true);
    setSystemHomePath('/data/storage/el2/base/files');
    assert.equal(getHomeRoot('/storage/Users/currentUser/Desktop'), '/data/storage/el2/base/files');
});

test('file tree renders the PC user home supplied by the Harmony runtime snapshot', async () => {
    __resetForTesting();
    const { document, window } = parseHTML('<!doctype html><html><head></head><body><main></main></body></html>');
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    const previousResizeObserver = globalThis.ResizeObserver;
    const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
    const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const listedPaths = [];

    globalThis.document = document;
    globalThis.window = window;
    globalThis.ResizeObserver = class {
        observe() {}
        disconnect() {}
    };
    globalThis.requestAnimationFrame = (callback) => {
        callback();
        return 1;
    };
    globalThis.cancelAnimationFrame = () => {};
    window.settingAPI = {
        async loadSettingObject() {
            return {
                default_workspace: '/storage/Users/currentUser/workspace',
                applications: { filemgr: { entries: [] } }
            };
        }
    };
    window.workspaceAPI = {
        async listDirectory(path) {
            listedPaths.push(path);
            return [];
        },
        async listDrives() {
            return [];
        }
    };

    primeOpenHarmonyPlatformSnapshot();

    try {
        const { createFileTree } = await import('../../../../../../main/applications/filemgr/renderer/tree.js');
        const tree = createFileTree(document.querySelector('main'));
        await tree.ready;

        assert.deepEqual(listedPaths, ['/storage/Users/currentUser']);
        tree.destroy();
    } finally {
        globalThis.document = previousDocument;
        globalThis.window = previousWindow;
        globalThis.ResizeObserver = previousResizeObserver;
        globalThis.requestAnimationFrame = previousRequestAnimationFrame;
        globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
    }
});

test('file tree uses the application sandbox as tablet home', () => {
    __resetForTesting();
    primeOpenHarmonyPlatformSnapshot('/data/storage/el2/base/files');

    assert.equal(getHomeRoot('/data/storage/el2/base/files/workspace'), '/data/storage/el2/base/files');
});

test('file tree shows overlay until worker snapshot arrives, then renders', async () => {
    __resetForTesting();
    const { document, window } = parseHTML('<!doctype html><html><head></head><body><main></main></body></html>');
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    const previousResizeObserver = globalThis.ResizeObserver;
    const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
    const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const listedPaths = [];

    globalThis.document = document;
    globalThis.window = window;
    globalThis.ResizeObserver = class {
        observe() {}
        disconnect() {}
    };
    globalThis.requestAnimationFrame = (callback) => {
        callback();
        return 1;
    };
    globalThis.cancelAnimationFrame = () => {};
    window.settingAPI = {
        async loadSettingObject() {
            return { default_workspace: '/Users/liumingxing/OpenDesk', applications: { filemgr: { entries: [] } } };
        }
    };
    window.workspaceAPI = {
        async listDirectory(path) {
            listedPaths.push(path);
            return [];
        },
        async listDrives() {
            return [];
        }
    };

    try {
        const { createFileTree } = await import('../../../../../../main/applications/filemgr/renderer/tree.js');
        const tree = createFileTree(document.querySelector('main'), { overlayTimeoutMs: 50 });

        // Allow initializeRoot to finish loadDefaultWorkspace and subscribe.
        await new Promise((resolve) => setTimeout(resolve, 0));

        const overlay = document.querySelector('.fs-tree-overlay');
        assert.ok(overlay, 'overlay should be mounted before snapshot arrives');
        assert.equal(overlay.textContent, '加载中...');
        assert.deepEqual(listedPaths, [], 'no listing should happen before platform is known');

        primeDesktopPlatformSnapshot('/Users/liumingxing');
        await tree.ready;

        assert.equal(document.querySelector('.fs-tree-overlay'), null, 'overlay should be gone after render');
        assert.deepEqual(listedPaths, ['/Users/liumingxing']);

        tree.destroy();
    } finally {
        globalThis.document = previousDocument;
        globalThis.window = previousWindow;
        globalThis.ResizeObserver = previousResizeObserver;
        globalThis.requestAnimationFrame = previousRequestAnimationFrame;
        globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
    }
});

test('overlay swaps to error text on timeout, then recovers when snapshot finally arrives', async () => {
    __resetForTesting();
    const { document, window } = parseHTML('<!doctype html><html><head></head><body><main></main></body></html>');
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    const previousResizeObserver = globalThis.ResizeObserver;
    const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
    const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const listedPaths = [];

    globalThis.document = document;
    globalThis.window = window;
    globalThis.ResizeObserver = class {
        observe() {}
        disconnect() {}
    };
    globalThis.requestAnimationFrame = (callback) => {
        callback();
        return 1;
    };
    globalThis.cancelAnimationFrame = () => {};
    window.settingAPI = {
        async loadSettingObject() {
            return { default_workspace: '/Users/liumingxing/OpenDesk', applications: { filemgr: { entries: [] } } };
        }
    };
    window.workspaceAPI = {
        async listDirectory(path) {
            listedPaths.push(path);
            return [];
        },
        async listDrives() {
            return [];
        }
    };

    try {
        const { createFileTree } = await import('../../../../../../main/applications/filemgr/renderer/tree.js');
        const tree = createFileTree(document.querySelector('main'), { overlayTimeoutMs: 20 });

        // Wait past the configured overlay timeout.
        await new Promise((resolve) => setTimeout(resolve, 40));

        const overlay = document.querySelector('.fs-tree-overlay');
        assert.ok(overlay);
        assert.equal(overlay.textContent, '文件管理服务未响应，请稍后重试');
        assert.ok(overlay.classList.contains('fs-tree-overlay-error'));

        // Late snapshot still triggers initial render.
        primeDesktopPlatformSnapshot('/Users/liumingxing');
        await tree.ready;

        assert.equal(document.querySelector('.fs-tree-overlay'), null);
        assert.deepEqual(listedPaths, ['/Users/liumingxing']);

        tree.destroy();
    } finally {
        globalThis.document = previousDocument;
        globalThis.window = previousWindow;
        globalThis.ResizeObserver = previousResizeObserver;
        globalThis.requestAnimationFrame = previousRequestAnimationFrame;
        globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
    }
});

test('late-path render error surfaces via overlay text and onError', async () => {
    __resetForTesting();
    const { document, window } = parseHTML('<!doctype html><html><head></head><body><main></main></body></html>');
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    const previousResizeObserver = globalThis.ResizeObserver;
    const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
    const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const errors = [];
    let rAFShouldThrow = false;

    globalThis.document = document;
    globalThis.window = window;
    globalThis.ResizeObserver = class {
        observe() {}
        disconnect() {}
    };
    globalThis.requestAnimationFrame = (callback) => {
        if (rAFShouldThrow) {
            throw new Error('rAF boom');
        }
        callback();
        return 1;
    };
    globalThis.cancelAnimationFrame = () => {};
    window.settingAPI = {
        async loadSettingObject() {
            return { default_workspace: '/Users/liumingxing/OpenDesk', applications: { filemgr: { entries: [] } } };
        }
    };
    window.workspaceAPI = {
        async listDirectory() {
            return [];
        },
        async listDrives() {
            return [];
        }
    };

    try {
        const { createFileTree } = await import('../../../../../../main/applications/filemgr/renderer/tree.js');
        const tree = createFileTree(document.querySelector('main'), {
            overlayTimeoutMs: 5000,
            onError: (err) => errors.push(err)
        });

        // Allow initializeRoot to subscribe before priming snapshot.
        await new Promise((resolve) => setTimeout(resolve, 0));

        rAFShouldThrow = true;
        primeDesktopPlatformSnapshot('/Users/liumingxing');

        // Let the late render attempt + .catch microtasks flush.
        for (let i = 0; i < 5; i++) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }

        const overlay = document.querySelector('.fs-tree-overlay');
        assert.ok(overlay, 'overlay should remain after render failure');
        assert.equal(overlay.textContent, '文件管理服务初始化失败，请稍后重试');
        assert.ok(overlay.classList.contains('fs-tree-overlay-error'));
        assert.equal(errors.length, 1, 'onError should be called exactly once');
        assert.match(String(errors[0]?.message ?? errors[0]), /rAF boom/);

        tree.destroy();
    } finally {
        globalThis.document = previousDocument;
        globalThis.window = previousWindow;
        globalThis.ResizeObserver = previousResizeObserver;
        globalThis.requestAnimationFrame = previousRequestAnimationFrame;
        globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
    }
});
