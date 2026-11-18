// 回归：插件通过 ctx.features.disableApplication 禁用应用后，应用 UI 必须跟着退出：
// 1) 主窗口已挂载的 iframe 要被卸载（当前正在看的应用被禁用时回到首页）；
// 2) 沉浸式桌面要订阅应用列表变更刷新图标，并关掉已打开的该应用浮动窗口。
import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const rendererHtml = readFileSync(new URL('../../../renderer/index.html', import.meta.url), 'utf8');
const immersiveDesktopSource = readFileSync(
    new URL('../../../renderer/components/desktop/immersiveDesktop.ts', import.meta.url),
    'utf8'
);

function sourceBetween(source: string, start: string, end: string): string {
    const startIndex = source.indexOf(start);
    const endIndex = source.indexOf(end, startIndex);
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeGreaterThan(startIndex);
    return source.slice(startIndex, endIndex);
}

function makeFrame(): { removed: boolean; remove: () => void } {
    return {
        removed: false,
        remove() {
            this.removed = true;
        }
    };
}

describe('禁用应用的应用窗口退出', () => {
    const closeFramesSource = sourceBetween(
        rendererHtml,
        'function closeDisabledApplicationFrames(disabledApplications) {',
        '// 插件特性禁用状态（features:getState'
    );

    function runCloseFrames(disabledApplications: string[], currentOpenAppBundleName: string | null) {
        const context = vm.createContext({
            appFrameCache: {
                filemgr: makeFrame(),
                mailbox: makeFrame(),
                benchmark: makeFrame()
            },
            currentOpenAppBundleName,
            openHomePage: jest.fn()
        });
        vm.runInContext(closeFramesSource, context);
        vm.runInContext(`closeDisabledApplicationFrames(${JSON.stringify(disabledApplications)});`, context);
        return context;
    }

    test('卸载被禁用应用的缓存 iframe，保留其它应用', () => {
        const context = runCloseFrames(['filemgr'], 'mailbox');
        expect((context.appFrameCache as Record<string, { removed: boolean }>).filemgr).toBeUndefined();
        expect((context.appFrameCache as Record<string, unknown>).mailbox).toBeDefined();
        expect((context.appFrameCache as Record<string, unknown>).benchmark).toBeDefined();
        // 当前视图不是被禁用应用时不应跳回首页
        expect(context.openHomePage).not.toHaveBeenCalled();
    });

    test('当前正在查看的应用被禁用时回到首页', () => {
        const context = runCloseFrames(['filemgr'], 'filemgr');
        expect((context.appFrameCache as Record<string, unknown>).filemgr).toBeUndefined();
        expect(context.openHomePage).toHaveBeenCalledTimes(1);
        expect(context.openHomePage).toHaveBeenCalledWith(true);
    });

    test('未禁用任何应用时不触发 iframe 卸载', () => {
        const context = runCloseFrames([], 'filemgr');
        const cache = context.appFrameCache as Record<string, { removed: boolean }>;
        expect(Object.keys(cache)).toEqual(['filemgr', 'mailbox', 'benchmark']);
        for (const frame of Object.values(cache)) {
            expect(frame.removed).toBe(false);
        }
        expect(context.openHomePage).not.toHaveBeenCalled();
    });

    test('订阅入口存在：features 变化时清理禁用应用的窗口', () => {
        const subscriptionSource = sourceBetween(
            rendererHtml,
            '// 插件特性禁用状态（features:getState 拉取',
            '// 监听来自 iframe（应用页）的 postMessage'
        );
        expect(subscriptionSource).toContain('window.featuresAPI.onChanged(applyFeatureState)');
        expect(subscriptionSource).toContain('closeDisabledApplicationFrames');
        expect(subscriptionSource).toContain('disabledApplications');
        // 首屏拉取失败要重试，否则早期 "No handler registered" 会让门控永久失效
        expect(subscriptionSource).toContain('loadFeatureState(attempt + 1)');
    });
});

describe('记忆特性禁用后记忆面板退出', () => {
    const featureStateSource = sourceBetween(
        rendererHtml,
        'var disabledFeatureIds = Object.create(null);',
        'loadFeatureState(0);'
    );

    function runApplyFeatureState(disabledFeatures: string[], currentNonAppContent: string) {
        const context = vm.createContext({
            appFrameCache: {},
            currentOpenAppBundleName: null,
            currentNonAppContent,
            openHomePage: jest.fn(),
            // 应用窗口清理逻辑由上面一组的用例单独验证，这里只关心记忆面板
            closeDisabledApplicationFrames: jest.fn()
        });
        vm.runInContext(featureStateSource, context);
        vm.runInContext(
            `applyFeatureState(${JSON.stringify({ disabledFeatures, disabledApplications: [] })});`,
            context
        );
        return context;
    }

    test('正在查看记忆面板时被禁用：回到首页', () => {
        const context = runApplyFeatureState(['memory'], 'memory');
        expect(context.openHomePage).toHaveBeenCalledTimes(1);
        expect(context.openHomePage).toHaveBeenCalledWith(true);
    });

    test('记忆面板未打开时不动当前视图', () => {
        const context = runApplyFeatureState(['memory'], 'home');
        expect(context.openHomePage).not.toHaveBeenCalled();
    });

    test('禁用其它特性不影响记忆面板', () => {
        const context = runApplyFeatureState(['filesystem'], 'memory');
        expect(context.openHomePage).not.toHaveBeenCalled();
    });

    test('openMemory 对已禁用的记忆特性短路（挡住旁路调用）', () => {
        const openMemorySource = sourceBetween(rendererHtml, 'openMemory: function () {', 'openTask: openTask');
        expect(openMemorySource).toContain('if (disabledFeatureIds.memory)');
        expect(openMemorySource).toContain('openHomePage(true)');
    });
});

describe('沉浸式桌面跟随应用禁用刷新', () => {
    test('主进程把应用级禁用也广播到 features:changed', () => {
        const mainSource = readFileSync(new URL('../../../main/main.ts', import.meta.url), 'utf8');
        const registerSource = sourceBetween(
            mainSource,
            'const registerFeaturesAPIHandlers = () => {',
            'const registerUsageAPIHandlers'
        );
        // 应用级禁用不触发 onFeaturesChanged，只订阅特性变化会让渲染端 disabledApplications 陈旧
        expect(registerSource).toContain('onApplicationsChanged(broadcast)');
        expect(registerSource).toContain("broadcastToAllWindows('features:changed'");
    });

    test('订阅应用列表变更并清理订阅', () => {
        expect(immersiveDesktopSource).toContain('onApplicationListChanged');
        expect(immersiveDesktopSource).toContain('this._appListUnsubscribe?.();');
    });

    test('列表变化时刷新图标并关掉被禁用应用已打开的浮动窗口', () => {
        const subscriptionSource = sourceBetween(
            immersiveDesktopSource,
            '// 应用列表变更（含插件 ctx.features.disableApplication 禁用应用）时刷新桌面图标',
            'this.focus({ preventScroll: true });'
        );
        expect(subscriptionSource).toContain('loadApplications()');
        expect(subscriptionSource).toContain('closeDisabledApplicationWindows(apps)');
    });

    test('关闭逻辑按主进程列表的 showIcon=false 过滤并调用 closeWindow', () => {
        const closeSource = sourceBetween(
            immersiveDesktopSource,
            '/** 关掉桌面上已打开、但应用已被插件禁用的浮动窗口',
            'private isAppListHidden()'
        );
        expect(closeSource).toContain('app?.showIcon === false');
        expect(closeSource).toContain('disabled.has(desktopWindow.bundleName)');
        expect(closeSource).toContain('this.closeWindow(desktopWindow.id)');
    });
});
