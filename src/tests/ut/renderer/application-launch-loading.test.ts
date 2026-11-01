// 回归：首次打开应用（典型如插件中心）要先等主进程加载该应用的延迟资源、再等 iframe
// 冷启动，这期间界面不能毫无反应。打开前必须先挂加载占位（复用 content-loading-view），
// 并等应用首屏真正挂载后再撤掉，而不是刚创建 iframe 就撤。
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const rendererHtml = readFileSync(new URL('../../../renderer/index.html', import.meta.url), 'utf8');
const applicationHostSource = readFileSync(
    new URL('../../../renderer/scripts/application-host.ts', import.meta.url),
    'utf8'
);
const immersiveDesktopSource = readFileSync(
    new URL('../../../renderer/components/desktop/immersiveDesktop.ts', import.meta.url),
    'utf8'
);
const applicationWindowSource = readFileSync(
    new URL('../../../renderer/application_window.html', import.meta.url),
    'utf8'
);
const sidebarSource = readFileSync(new URL('../../../renderer/components/sidebar.js', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../../../main/main.ts', import.meta.url), 'utf8');
const zhCnSource = readFileSync(new URL('../../../locale/zh-cn.ts', import.meta.url), 'utf8');
const enUsSource = readFileSync(new URL('../../../locale/en-us.ts', import.meta.url), 'utf8');

/** 与 index.html 的 appLaunchLoadingTimeoutMs 对应 */
const APP_LAUNCH_TIMEOUT_MS = 15000;

function sourceBetween(source: string, start: string, end: string): string {
    const startIndex = source.indexOf(start);
    const endIndex = source.indexOf(end, startIndex);
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeGreaterThan(startIndex);
    return source.slice(startIndex, endIndex);
}

describe('应用启动加载占位', () => {
    const openApplicationSource = sourceBetween(
        rendererHtml,
        'openApplication: async function (bundleName, options)',
        '// 监听应用列表变更'
    );

    test('打开应用时先挂占位，再去等应用延迟资源', () => {
        expect(openApplicationSource.indexOf('startAppLaunchLoading(bundleName)')).toBeGreaterThanOrEqual(0);
        expect(openApplicationSource.indexOf('startAppLaunchLoading(bundleName)')).toBeLessThan(
            openApplicationSource.indexOf('await ensureApplicationReady(bundleName)')
        );
        // 首屏已就绪的驻留 iframe 切回来是瞬时的，不该闪占位；仍在冷启动的仍要给反馈
        expect(openApplicationSource).toContain(
            "bundleName !== 'browser' && !isAppFrameReady(appFrameCache[bundleName])"
        );
    });

    test('占位复用 content-loading-view，文案走本地化键', () => {
        const startSource = sourceBetween(
            rendererHtml,
            'function startAppLaunchLoading(bundleName) {',
            'function finishAppLaunchLoading(bundleName) {'
        );
        expect(startSource).toContain("document.createElement('content-loading-view')");
        expect(startSource).toContain("window.__odT('renderer.application.loading')");
        expect(zhCnSource).toContain("'renderer.application.loading'");
        expect(enUsSource).toContain("'renderer.application.loading'");
    });

    test('三个宿主的占位共用同一条文案键', () => {
        // 主窗口 / 桌面浮窗 / 独立窗口的加载文案必须是同一个键同一句话
        expect(applicationWindowSource).toContain("currentTranslator('renderer.application.loading')");
        expect(immersiveDesktopSource).toContain("this.t('renderer.application.loading')");
        expect(rendererHtml).toContain("window.__odT('renderer.application.loading')");
        expect(zhCnSource).toContain("'renderer.application.loading': '正在加载应用…'");
        expect(enUsSource).toContain("'renderer.application.loading': 'Loading application…'");
        // 旧的桌面专用文案键已合并，不能再出现第二份重复文案
        expect(zhCnSource).not.toContain("'renderer.desktop.app.loading'");
        expect(enUsSource).not.toContain("'renderer.desktop.app.loading'");
        expect(zhCnSource).not.toContain("'renderer.application.launching'");
    });

    test('占位覆盖内容区并有超时兜底', () => {
        const startSource = sourceBetween(
            rendererHtml,
            'function startAppLaunchLoading(bundleName) {',
            'function finishAppLaunchLoading(bundleName) {'
        );
        expect(startSource).toContain('position:absolute');
        expect(startSource).toContain('nonAppSlot.parentElement');
        expect(startSource).toContain('appLaunchLoadingTimeoutMs');
        expect(rendererHtml).toContain('appLaunchLoadingTimeoutMs = 15000');
    });

    test('撤占位时同步撤销超时定时器，避免它误杀同一应用的下一次占位', () => {
        const finishSource = sourceBetween(
            rendererHtml,
            'function finishAppLaunchLoading(bundleName) {',
            'function hideAllNonAppChildren()'
        );
        expect(finishSource).toContain('clearTimeout(appLaunchLoadingTimer)');
        expect(finishSource.indexOf('clearTimeout(appLaunchLoadingTimer)')).toBeLessThan(
            finishSource.indexOf('appLaunchLoadingEl = null')
        );
    });

    test('应用首屏挂载后才撤掉占位', () => {
        // 应用页在挂载 entry widget 后回传 APPLICATION_READY
        expect(applicationHostSource).toContain("type: 'APPLICATION_READY'");
        expect(applicationHostSource).toContain('notifyHostApplicationReady(applicationBundleName)');
        // 宿主侧收到消息后撤占位，而不是创建 iframe 就撤
        const listenerSource = sourceBetween(
            rendererHtml,
            "window.addEventListener('message', function (event) {",
            '// 监听 setting locale 变化'
        );
        expect(listenerSource).toContain("event.data.type === 'APPLICATION_READY'");
        expect(listenerSource).toContain('finishAppLaunchLoading(readyBundle)');
        // 就绪标记打在 iframe 上：首次启动交给就绪信号收尾，切回已就绪的驻留 iframe 立即撤
        expect(listenerSource).toContain('event.source === readyFrame.contentWindow');
        expect(listenerSource).toContain('Object.prototype.hasOwnProperty.call(appFrameCache, readyBundle)');
        expect(openApplicationSource).toContain(
            'if (isAppFrameReady(appFrameCache[bundleName])) finishAppLaunchLoading(bundleName);'
        );
        // 外部（用户安装）应用不会回传就绪信号，按 iframe load 兜底
        expect(openApplicationSource).toContain("iframe.setAttribute('data-external-app', '1')");
        // 中途切回任务/主页时，占位不能继续盖着新视图
        expect(sourceBetween(rendererHtml, 'function showNonApp()', 'function showAppFrames()')).toContain(
            'finishAppLaunchLoading()'
        );
    });

    test('启动失败时也要撤掉占位，避免盖住错误提示', () => {
        expect(applicationHostSource).toContain('showBootstrapError(');
        const catchSource = sourceBetween(
            applicationHostSource,
            "console.error('[application-host] bootstrap failed', err)",
            '})();'
        );
        expect(catchSource).toContain('showBootstrapError(');
        expect(catchSource).toContain('notifyHostApplicationReady(bundleName)');
    });

    test('沉浸桌面浮窗保留加载占位直到应用就绪', () => {
        const mountSource = sourceBetween(
            immersiveDesktopSource,
            'private async mountApplicationContent(',
            'private async resolveApplicationFrameSrc('
        );
        expect(mountSource).toContain("querySelector('.od-window-loading')");
        expect(mountSource).toContain("data.type !== 'APPLICATION_READY'");
        expect(mountSource).toContain('setTimeout(() => stopWaiting(), APP_FRAME_READY_TIMEOUT_MS)');
        expect(immersiveDesktopSource).toContain('const APP_FRAME_READY_TIMEOUT_MS = 15_000;');
        // 占位元素要在挂载 iframe 之前取到，否则会被清空/覆盖掉
        expect(mountSource.indexOf("querySelector('.od-window-loading')")).toBeLessThan(
            mountSource.indexOf('const { src, external }')
        );
        // 只认本浮窗 iframe 发来的就绪信号：主窗口应用视图可能同时打开同一个应用
        expect(mountSource).toContain('if (event.source !== frame.contentWindow) return;');
    });

    test('沉浸桌面打开应用同样先等该应用自身的延迟资源', () => {
        const openSource = sourceBetween(
            immersiveDesktopSource,
            'private async openApplicationWindow(',
            'private async mountApplicationContent('
        );
        expect(openSource).toContain('ensureApplicationLoaded?.(bundleName)');
        expect(openSource.indexOf('ensureApplicationLoaded?.(bundleName)')).toBeLessThan(
            openSource.indexOf('mountApplicationContent(desktopWindow')
        );
    });

    test('三个应用宿主（主窗口 / 桌面浮窗 / 独立窗口）都先等该应用自身的延迟资源', () => {
        expect(openApplicationSource).toContain('await ensureApplicationReady(bundleName)');
        expect(immersiveDesktopSource).toContain('ensureApplicationLoaded?.(bundleName)');
        // 独立应用窗口同样不能在资源加载完成前就启动应用页
        expect(applicationWindowSource).toContain('.ensureApplicationLoaded(bundleName)');
        expect(applicationWindowSource.indexOf('.ensureApplicationLoaded(bundleName)')).toBeLessThan(
            applicationWindowSource.indexOf('iframe.src = isExternalApp')
        );
    });

    test('独立应用窗口也有启动占位，并同样用就绪信号/超时收尾', () => {
        expect(applicationWindowSource).toContain('<content-loading-view id="app-window-loading" data-type="tb">');
        // 文案在本地化就绪后写进组件的 data-message
        expect(applicationWindowSource).toContain(
            "loadingEl.setAttribute('data-message', currentTranslator('renderer.application.loading'))"
        );
        expect(applicationWindowSource).toContain('var APP_READY_TIMEOUT_MS = 15000;');
        expect(applicationWindowSource).toContain('readyTimer = setTimeout(finishLoading, APP_READY_TIMEOUT_MS)');
        // 只认本窗口 iframe 发来的就绪信号
        expect(applicationWindowSource).toContain('if (event.source !== iframe.contentWindow) return;');
        // 外部（用户安装）应用没有就绪信号，按 iframe load 兜底
        expect(applicationWindowSource).toContain('if (!frameSrcAssigned || !isExternalApp) return;');
        // 没有 bundleName 时不会加载应用页，占位必须立即撤掉
        const noBundleSource = sourceBetween(
            applicationWindowSource,
            '// 没有 bundleName 就不会加载应用页',
            '</script>'
        );
        expect(noBundleSource).toContain('finishLoading();');
    });

    test('浏览器应用不提供"在新窗口中打开"（webview 在 iframe 内不可用）', () => {
        // 独立窗口里只能挂 iframe，浏览器应用必须内联挂载在主窗口，
        // 否则用户会看到 15s 的"正在加载应用…"后接一个坏掉的页面
        expect(sidebarSource).toContain("if (bundleName !== 'browser') {");
        // 菜单项缺失时 querySelector 返回 null，绑定必须容忍
        expect(sidebarSource).toContain('menu.querySelector(\'[data-action="new-window"]\')?.addEventListener(');
        // IPC 侧也拒绝，避免插件 / 应用代理等其它调用方开出坏窗口
        expect(mainSource).toContain("if (bundleName === 'browser') {");
        expect(mainSource).toContain('browser application does not support separate window');
    });

    test('三个宿主的启动占位统一使用 content-loading-view 组件', () => {
        // 主窗口
        expect(rendererHtml).toContain("document.createElement('content-loading-view')");
        // 桌面浮窗
        expect(immersiveDesktopSource).toContain('<content-loading-view class="od-window-loading"');
        // 独立窗口
        expect(applicationWindowSource).toContain('<content-loading-view id="app-window-loading"');
        // 旧的圆形 spinner 占位已随本次统一删除，避免再出现第二套加载动画
        expect(immersiveDesktopSource).not.toContain('od-spinner');
        expect(applicationWindowSource).not.toContain('app-window-spinner');
    });

    test('独立应用窗口的占位只认本窗口 iframe 的就绪信号，并清理监听与定时器', () => {
        jest.useFakeTimers();
        const { context, state } = loadAppWindowLoadingContext();
        // 抽出的代码块包含占位兜底注册：默认已挂监听并武装了超时
        expect(state.windowListeners).toBe(1);
        expect(state.frameListeners).toBe(1);

        // 别的窗口发来的就绪信号不算数
        vm.runInContext("onReadyMessage({ data: { type: 'APPLICATION_READY' }, source: { other: 1 } })", context);
        expect(state.hidden).toBe(false);

        // 本窗口 iframe 的首屏就绪信号才撤占位
        vm.runInContext(
            "onReadyMessage({ data: { type: 'APPLICATION_READY' }, source: iframe.contentWindow })",
            context
        );
        expect(state.hidden).toBe(true);
        expect(state.windowListeners).toBe(0);
        expect(state.frameListeners).toBe(0);
        expect(vm.runInContext('readyTimer', context)).toBe(null);

        // 淡出动画结束后才真正移除；重复调用是安全的
        vm.runInContext('finishLoading()', context);
        jest.advanceTimersByTime(300);
        expect(state.removed).toBe(true);
    });

    test('独立应用窗口迟迟不就绪时由超时兜底撤掉占位', () => {
        jest.useFakeTimers();
        const { context, state } = loadAppWindowLoadingContext();
        jest.advanceTimersByTime(APP_LAUNCH_TIMEOUT_MS);
        expect(state.hidden).toBe(true);
        expect(vm.runInContext('readyTimer', context)).toBe(null);
    });

    test('独立应用窗口不会把 iframe 初始 about:blank 的 load 当成应用就绪', () => {
        jest.useFakeTimers();
        const { context, state } = loadAppWindowLoadingContext();
        vm.runInContext('isExternalApp = true', context);

        // 还没指向应用页时的 load 必须忽略，否则占位会提前消失、露出空白
        vm.runInContext('onFrameLoad()', context);
        expect(state.hidden).toBe(false);

        // 真正指向应用页之后的那次 load 才收尾
        vm.runInContext('frameSrcAssigned = true', context);
        vm.runInContext('onFrameLoad()', context);
        expect(state.hidden).toBe(true);
    });
});

/**
 * 抽出 application_window.html 的占位收尾逻辑跑一遍：只认本窗口 iframe 的就绪信号，
 * 撤占位时清掉监听与定时器。
 */
function loadAppWindowLoadingContext(): {
    context: vm.Context;
    state: { hidden: boolean; removed: boolean; windowListeners: number; frameListeners: number };
} {
    const state = { hidden: false, removed: false, windowListeners: 0, frameListeners: 0 };
    const context = vm.createContext({
        window: {
            addEventListener: () => {
                state.windowListeners += 1;
            },
            removeEventListener: () => {
                state.windowListeners -= 1;
            }
        },
        iframe: {
            contentWindow: { appFrame: true },
            addEventListener: () => {
                state.frameListeners += 1;
            },
            removeEventListener: () => {
                state.frameListeners -= 1;
            }
        },
        loadingEl: {
            classList: {
                add: (name: string) => {
                    if (name === 'is-hidden') state.hidden = true;
                }
            },
            remove: () => {
                state.removed = true;
            }
        },
        readyTimer: null,
        isExternalApp: false,
        frameSrcAssigned: false,
        setTimeout,
        clearTimeout
    });
    vm.runInContext('var APP_READY_TIMEOUT_MS = 15000;', context);
    vm.runInContext(sourceBetween(applicationWindowSource, 'function finishLoading() {', '// 窗口控制按钮'), context);
    return { context, state };
}

/**
 * 抽出 index.html 里的占位逻辑跑一遍：确保真的创建了 content-loading-view、
 * 带上本地化文案、并且按 bundleName 精确撤回。
 */
function loadLaunchLoadingContext(): {
    context: vm.Context;
    created: any[];
    appended: any[];
} {
    const created: any[] = [];
    const appended: any[] = [];
    const context = vm.createContext({
        document: {
            createElement: (tag: string) => {
                const el: any = {
                    tagName: tag,
                    attributes: {} as Record<string, string>,
                    style: {} as Record<string, string>,
                    removed: false,
                    listeners: {} as Record<string, Array<() => void>>,
                    setAttribute(name: string, value: string) {
                        this.attributes[name] = value;
                    },
                    addEventListener(name: string, fn: () => void) {
                        (this.listeners[name] ||= []).push(fn);
                    },
                    remove() {
                        this.removed = true;
                    }
                };
                created.push(el);
                return el;
            }
        },
        window: { __odT: (key: string) => `t:${key}` },
        nonAppSlot: { parentElement: { appendChild: (el: unknown) => appended.push(el) } },
        ensureSlots: () => undefined,
        setTimeout,
        clearTimeout
    });
    vm.runInContext(
        sourceBetween(rendererHtml, 'var appLaunchLoadingTimeoutMs = 15000;', 'function hideAllNonAppChildren()'),
        context
    );
    return { context, created, appended };
}

describe('应用启动占位行为', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    test('挂载 content-loading-view 并带本地化文案', () => {
        jest.useFakeTimers();
        const { context, created, appended } = loadLaunchLoadingContext();

        vm.runInContext("startAppLaunchLoading('pluginmgr')", context);

        expect(created).toHaveLength(1);
        expect(created[0].tagName).toBe('content-loading-view');
        expect(created[0].attributes['data-message']).toBe('t:renderer.application.loading');
        expect(created[0].style.cssText).toContain('position:absolute');
        expect(appended).toEqual([created[0]]);
    });

    test('只撤回对应应用的占位，撤不掉当次最新的那个', () => {
        jest.useFakeTimers();
        const { context, created } = loadLaunchLoadingContext();

        vm.runInContext("startAppLaunchLoading('pluginmgr')", context);
        const first = created[0];
        // 换成另一个应用：旧占位开始淡出，只保留新的
        vm.runInContext("startAppLaunchLoading('skillmgr')", context);
        expect(first.style.opacity).toBe('0');
        // 淡出期间不能继续拦截点击，否则应用刚出现时的第一次点击会被吞掉
        expect(first.style.pointerEvents).toBe('none');
        first.listeners.transitionend[0]();
        expect(first.removed).toBe(true);

        const second = created[1];
        vm.runInContext("finishAppLaunchLoading('pluginmgr')", context);
        expect(second.removed).toBe(false);

        vm.runInContext("finishAppLaunchLoading('skillmgr')", context);
        // 淡出动画结束后才真正移除
        second.listeners.transitionend[0]();
        expect(second.removed).toBe(true);
    });

    test('应用迟迟不就绪时由超时兜底撤掉占位', () => {
        jest.useFakeTimers();
        const { context, created } = loadLaunchLoadingContext();

        vm.runInContext("startAppLaunchLoading('pluginmgr')", context);
        jest.advanceTimersByTime(APP_LAUNCH_TIMEOUT_MS);
        created[0].listeners.transitionend[0]();
        expect(created[0].removed).toBe(true);
    });

    test('撤掉占位会撤销超时定时器，不会误杀同一应用的下一次占位', () => {
        jest.useFakeTimers();
        const { context, created } = loadLaunchLoadingContext();

        vm.runInContext("startAppLaunchLoading('pluginmgr')", context);
        const first = created[0];
        vm.runInContext("finishAppLaunchLoading('pluginmgr')", context);
        first.listeners.transitionend[0]();
        expect(first.removed).toBe(true);

        // 同一应用过一会儿再次打开（如版本更新后重建 iframe）
        jest.advanceTimersByTime(5000);
        vm.runInContext("startAppLaunchLoading('pluginmgr')", context);
        const second = created[1];

        // 走到上一次占位的兜底时刻：它应已被撤销，不能撤掉新占位
        jest.advanceTimersByTime(APP_LAUNCH_TIMEOUT_MS - 5000 + 1);
        expect(second.style.opacity).not.toBe('0');

        // 新占位自己的兜底时刻仍然生效
        jest.advanceTimersByTime(5000);
        expect(second.style.opacity).toBe('0');
    });
});
