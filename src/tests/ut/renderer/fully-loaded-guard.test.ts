import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const preloadSource = readFileSync(new URL('../../../renderer/preload.js', import.meta.url), 'utf8');
const registryElectronSource = readFileSync(
    new URL('../../../main/applications/registry_electron.ts', import.meta.url),
    'utf8'
);
const rendererHtml = readFileSync(new URL('../../../renderer/index.html', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../../../main/main.ts', import.meta.url), 'utf8');

function sourceBetween(source: string, start: string, end: string): string {
    const startIndex = source.indexOf(start);
    const endIndex = source.indexOf(end, startIndex);
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeGreaterThan(startIndex);
    return source.slice(startIndex, endIndex);
}

describe('renderer fully-loaded guards', () => {
    test('starts the renderer immediately while exposing an early full-loading barrier', () => {
        expect(rendererHtml).toContain('src="./scripts/index.js"');
        expect(rendererHtml).not.toContain('bootstrap.ts');
        expect(registryElectronSource).toContain("ipcMain.handle('applicationRegistry:ensureFullyLoaded'");
        expect(preloadSource).toContain('ensureFullyLoaded: async () =>');

        const startupSource = mainSource.slice(mainSource.indexOf('async function startApplication'));
        expect(
            startupSource.indexOf('registerApplicationRegistryHandlers(ipcMain, ensureElectronFullyLoaded)')
        ).toBeLessThan(startupSource.indexOf('createWindow();'));
    });

    test('defers browser session initialization until the main window is shown', () => {
        const startupSource = mainSource.slice(mainSource.indexOf('async function startApplication'));
        expect(startupSource).toContain("globalMainWindow.once('ready-to-show', triggerBrowserInitialization)");
        const fullLoadingBarrier = sourceBetween(
            startupSource,
            'const ensureElectronFullyLoaded',
            '// 先注册 renderer 首屏会调用的无状态 IPC'
        );
        expect(fullLoadingBarrier).toContain('ApplicationRegistry.ensureFullyLoaded()');
        expect(fullLoadingBarrier).toContain('ensureBrowserReady()');
        expect(fullLoadingBarrier).toContain('registryWorkerReady');
        expect(startupSource).not.toContain('await Promise.all([agentsReady, browserReady])');
    });

    test('starts loading the main window before restoring global task state', () => {
        const startupSource = mainSource.slice(mainSource.indexOf('app.whenReady().then'));
        const createWindowIndex = startupSource.indexOf('createWindow();');
        const initializeGlobalStateIndex = startupSource.indexOf('GlobalState.initialize();');
        const registerTaskHandlersIndex = startupSource.indexOf('registerTaskManagerAPIHandlers();');

        expect(createWindowIndex).toBeGreaterThanOrEqual(0);
        expect(createWindowIndex).toBeLessThan(initializeGlobalStateIndex);
        expect(initializeGlobalStateIndex).toBeLessThan(registerTaskHandlersIndex);
    });

    test('has a fallback to show the main window after did-finish-load', () => {
        const createWindowSource = mainSource.slice(mainSource.indexOf('const createWindow = () =>'));
        const readyToShowIndex = createWindowSource.indexOf("mainWindow.once('ready-to-show'");
        const finishLoadIndex = createWindowSource.indexOf("mainWindow.webContents.once('did-finish-load'");
        const showIndex = createWindowSource.indexOf('mainWindow.show();');

        expect(readyToShowIndex).toBeGreaterThanOrEqual(0);
        expect(finishLoadIndex).toBeGreaterThan(readyToShowIndex);
        expect(createWindowSource).toContain('MAIN_WINDOW_SHOW_FALLBACK_DELAY_MS');
        expect(createWindowSource).toContain('ready-to-show 未触发，使用 did-finish-load 兜底显示主窗口');
        expect(showIndex).toBeGreaterThanOrEqual(0);
    });

    test('waits only when opening task and application resources', () => {
        const openTaskSource = sourceBetween(
            rendererHtml,
            'async function openTask(taskId)',
            'async function needsWizard'
        );
        expect(openTaskSource).toContain('if (taskId !== null)');
        expect(openTaskSource.indexOf('await window.applicationRegistryAPI.ensureFullyLoaded()')).toBeLessThan(
            openTaskSource.indexOf("document.createElement('task-view')")
        );

        const backgroundTaskSource = sourceBetween(
            rendererHtml,
            'async function ensureTaskViewExists(taskId)',
            'window.globalControlAPI ='
        );
        expect(backgroundTaskSource).toContain('await window.applicationRegistryAPI.ensureFullyLoaded()');

        const openApplicationSource = sourceBetween(
            rendererHtml,
            'openApplication: async function (bundleName, options)',
            '// 监听应用列表变更'
        );
        expect(openApplicationSource.indexOf('await window.applicationRegistryAPI.ensureFullyLoaded()')).toBeLessThan(
            openApplicationSource.indexOf('getApplicationGUIConfig(bundleName)')
        );
    });
});
