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
        expect(registryElectronSource).toContain("ipcMain.handle('applicationRegistry:ensureApplicationLoaded'");
        expect(preloadSource).toContain('ensureApplicationLoaded: async (bundleName) =>');

        const startupSource = mainSource.slice(mainSource.indexOf('async function startApplication'));
        expect(
            startupSource.indexOf(
                'registerApplicationRegistryHandlers(ipcMain, ensureElectronFullyLoaded, ensureElectronApplicationLoaded)'
            )
        ).toBeLessThan(startupSource.indexOf('createWindow();'));
    });

    test('opening one application only waits for that application', () => {
        const startupSource = mainSource.slice(mainSource.indexOf('async function startApplication'));
        const narrowBarrier = sourceBetween(
            startupSource,
            'const ensureElectronApplicationLoaded',
            '// 先注册 renderer 首屏会调用的无状态 IPC'
        );
        expect(narrowBarrier).toContain('ApplicationRegistry.ensureApplicationLoaded(bundleName)');
        // 打开单个应用不该被遥测 / 其它应用的延迟加载拖住
        expect(narrowBarrier).not.toContain('ensureTelemetryReady()');
        expect(narrowBarrier).not.toContain('ApplicationRegistry.ensureFullyLoaded()');
        // 插件宿主必须先于应用加载落地：应用的延迟加载会消费插件 hook（如技能列表）
        expect(narrowBarrier.indexOf('await initializePluginHost()')).toBeLessThan(
            narrowBarrier.indexOf('ApplicationRegistry.ensureApplicationLoaded(bundleName)')
        );
        // 浏览器应用是唯一依赖 browser session 的应用，其余应用不等它
        expect(narrowBarrier).toContain("if (bundleName === 'browser') tasks.push(ensureBrowserReady())");
        expect(narrowBarrier).toContain('registryWorkerReady');
    });

    test('registers renderer startup IPC before loading the main window', () => {
        const startupSource = mainSource.slice(mainSource.indexOf('async function startApplication'));
        const createWindowIndex = startupSource.indexOf('createWindow();');

        expect(startupSource.indexOf('AgentRegistry.initBuiltinAgents();')).toBeLessThan(createWindowIndex);
        expect(startupSource.indexOf('registerModeAPIHandlers();')).toBeLessThan(createWindowIndex);
        const registerNativeBridgeIndex = startupSource.indexOf('registerNativeBridge();');
        expect(registerNativeBridgeIndex).toBeGreaterThanOrEqual(0);
        expect(registerNativeBridgeIndex).toBeLessThan(createWindowIndex);
    });

    test('defers browser session initialization until the main window is shown', () => {
        const startupSource = mainSource.slice(mainSource.indexOf('async function startApplication'));
        expect(startupSource).toContain('void mainWindowShown.then(() => void ensureBrowserReady())');
        expect(startupSource).toContain('void mainWindowShown.then(() => void ensureTelemetryReady())');
        expect(startupSource).not.toContain("globalMainWindow.once('ready-to-show', triggerBrowserInitialization)");
        const fullLoadingBarrier = sourceBetween(
            startupSource,
            'const ensureElectronFullyLoaded',
            '// 先注册 renderer 首屏会调用的无状态 IPC'
        );
        expect(fullLoadingBarrier).toContain('ApplicationRegistry.ensureFullyLoaded()');
        expect(fullLoadingBarrier).toContain('initializePluginHost()');
        expect(fullLoadingBarrier).toContain('ensureBrowserReady()');
        expect(fullLoadingBarrier).toContain('registryWorkerReady');
        expect(startupSource).not.toContain('await Promise.all([agentsReady, browserReady])');
    });

    test('uses the shared main-window shown signal for delayed startup work', () => {
        const startupSource = mainSource.slice(mainSource.indexOf('async function startApplication'));

        expect(startupSource).toContain(
            'void mainWindowShown.then(() => void ApplicationRegistry.ensureFullyLoaded())'
        );
        expect(startupSource).not.toContain("globalMainWindow.once('ready-to-show', triggerTelemetryInitialization)");
        expect(startupSource).not.toContain("globalMainWindow.once('ready-to-show', triggerBrowserInitialization)");
        expect(startupSource).not.toContain("globalMainWindow.once('ready-to-show', triggerLazyLoading)");
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
        expect(createWindowSource).toContain('signalMainWindowShown();');
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
        expect(openApplicationSource.indexOf('await ensureApplicationReady(bundleName)')).toBeLessThan(
            openApplicationSource.indexOf('getApplicationGUIConfig(bundleName)')
        );
        // 打开单个应用走窄屏障：全局屏障只留给建任务等确需全量资源的路径
        expect(openApplicationSource).not.toContain('ensureFullyLoaded()');
        const readyHelperSource = sourceBetween(
            rendererHtml,
            'async function ensureApplicationReady(bundleName)',
            '/** 只广播前台视图'
        );
        expect(readyHelperSource).toContain('window.applicationRegistryAPI.ensureApplicationLoaded(bundleName)');
    });
});
