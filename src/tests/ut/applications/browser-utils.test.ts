import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { makeEnsureSidebarScript } from '../../../main/applications/browser/utils.js';

function installDom(html: string): Window {
    const { window } = parseHTML(html);
    Object.assign(globalThis, {
        window,
        document: window.document
    });
    (window as any).getComputedStyle = (el: HTMLElement) => ({
        display: el.style.display || ''
    });
    return window as unknown as Window;
}

async function runScript(script: string): Promise<void> {
    return new Function(script)();
}

describe('browser utils', () => {
    afterEach(() => {
        delete (globalThis as any).window;
        delete (globalThis as any).document;
    });

    test('waits for an asynchronous task view before revealing its browser', async () => {
        const window = installDom('<div id="nonAppSlot"></div>');
        const document = window.document;
        const ensureRightSidebarOpen = jest.fn();
        const consumeInitialBrowserAutoReveal = jest.fn(() => true);
        const forceBrowserActive = jest.fn();
        let finishLoading!: () => void;
        const loading = new Promise<void>((resolve) => {
            finishLoading = resolve;
        });
        const preparation = loading.then(() => {
            document.getElementById('nonAppSlot')!.innerHTML = `
                <task-view id="task-view">
                    <task-artifacts id="task-task-1-artifacts"></task-artifacts>
                </task-view>
            `;
            Object.assign(document.getElementById('task-view')!, {
                _ensureRightSidebarOpen: ensureRightSidebarOpen
            });
            Object.assign(document.getElementById('task-task-1-artifacts')!, {
                consumeInitialBrowserAutoReveal,
                forceBrowserActive
            });
        });
        const ensureTaskViewExists = jest.fn(() => preparation);
        (window as any).globalControlAPI = { ensureTaskViewExists };
        const completed = jest.fn();
        const execution = runScript(makeEnsureSidebarScript('task-1')).then(completed);

        try {
            await Promise.resolve();
            expect(ensureTaskViewExists).toHaveBeenCalledWith('task-1');
            expect(completed).not.toHaveBeenCalled();
            expect(document.getElementById('task-task-1-artifacts')).toBeNull();
            expect(consumeInitialBrowserAutoReveal).not.toHaveBeenCalled();
        } finally {
            finishLoading();
            await preparation;
            await execution;
        }

        expect(ensureRightSidebarOpen).toHaveBeenCalledTimes(1);
        expect(consumeInitialBrowserAutoReveal).toHaveBeenCalledTimes(1);
        expect(forceBrowserActive).toHaveBeenCalledTimes(1);
    });

    test('defers the reveal when the task moves to the background while its view loads', async () => {
        const window = installDom(`
            <div id="nonAppSlot">
                <task-view id="task-view">
                    <task-artifacts id="task-task-1-artifacts"></task-artifacts>
                </task-view>
            </div>
            <div id="app-frames-container" style="display:none"></div>
        `);
        const document = window.document;
        const taskView = document.getElementById('task-view')!;
        const artifacts = document.getElementById('task-task-1-artifacts')!;
        const appFramesContainer = document.getElementById('app-frames-container')!;
        const ensureRightSidebarOpen = jest.fn();
        const consumeInitialBrowserAutoReveal = jest.fn(() => true);
        const markPendingBrowserAutoReveal = jest.fn();
        const ensureBrowserReady = jest.fn();
        const forceBrowserActive = jest.fn();
        Object.assign(taskView, { _ensureRightSidebarOpen: ensureRightSidebarOpen });
        Object.assign(artifacts, {
            consumeInitialBrowserAutoReveal,
            markPendingBrowserAutoReveal,
            ensureBrowserReady,
            forceBrowserActive
        });
        let finishLoading!: () => void;
        const preparation = new Promise<void>((resolve) => {
            finishLoading = resolve;
        });
        (window as any).globalControlAPI = { ensureTaskViewExists: jest.fn(() => preparation) };

        const execution = runScript(makeEnsureSidebarScript('task-1'));
        taskView.setAttribute('data-background', '1');
        document.getElementById('nonAppSlot')!.style.display = 'none';
        appFramesContainer.style.display = 'block';
        finishLoading();
        await execution;

        expect(consumeInitialBrowserAutoReveal).toHaveBeenCalledTimes(1);
        expect(markPendingBrowserAutoReveal).toHaveBeenCalledTimes(1);
        expect(ensureRightSidebarOpen).not.toHaveBeenCalled();
        expect(forceBrowserActive).not.toHaveBeenCalled();
        expect(ensureBrowserReady).toHaveBeenCalledWith(false);
        expect(taskView.getAttribute('data-background')).toBe('1');
        expect(taskView.style.opacity).toBe('0');
        expect(appFramesContainer.style.display).toBe('block');
    });

    test('hidden task view gets offscreen rendering without activating foreground layout', async () => {
        const window = installDom(`
            <div id="nonAppSlot" style="display:none">
                <task-view id="task-view" style="display:none">
                    <task-artifacts id="task-task-1-artifacts" style="display:none"></task-artifacts>
                </task-view>
            </div>
        `);
        const document = window.document;
        const taskView = document.getElementById('task-view') as HTMLElement & {
            _forceExpandRightSidebar?: jest.Mock;
            _ensureRightSidebarOpen?: jest.Mock;
        };
        const artifacts = document.getElementById('task-task-1-artifacts') as HTMLElement & {
            _suppressBrowserAutoSwitch?: boolean;
            consumeInitialBrowserAutoReveal?: jest.Mock;
            markPendingBrowserAutoReveal?: jest.Mock;
            ensureBrowserReady?: jest.Mock;
            forceBrowserActive?: jest.Mock;
            keepBrowserPanelRenderable?: jest.Mock;
        };
        const shadow = artifacts.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
            <div class="tab-content" data-tab="browser" style="display:none">
                <div class="bw">
                    <div class="bw-webview-container">
                        <div class="bw-webview-wrap"><webview></webview></div>
                    </div>
                </div>
            </div>
        `;

        const ensureTaskViewExists = jest.fn();
        (window as any).globalControlAPI = { ensureTaskViewExists };
        taskView._forceExpandRightSidebar = jest.fn();
        taskView._ensureRightSidebarOpen = jest.fn();
        artifacts.consumeInitialBrowserAutoReveal = jest.fn(() => true);
        artifacts.markPendingBrowserAutoReveal = jest.fn();
        artifacts.ensureBrowserReady = jest.fn();
        artifacts.forceBrowserActive = jest.fn();
        artifacts.keepBrowserPanelRenderable = jest.fn();

        await runScript(makeEnsureSidebarScript('task-1'));

        expect(ensureTaskViewExists).toHaveBeenCalledWith('task-1');
        expect((document.getElementById('nonAppSlot') as HTMLElement).style.display).toBe('');
        // offscreen rendering
        expect(taskView.getAttribute('data-background')).toBe('1');
        // fixed 宿主不参与 rightPanel 的滚动范围，避免后台 1280px 视口挤动前台布局
        expect(taskView.style.position).toBe('fixed');
        expect(taskView.style.height).toBe('800px');
        expect(taskView.style.zIndex).toBe('-1');
        // task-artifacts 保持 1280x800 与 task-view offscreen 模式一致，不重置尺寸
        expect(artifacts.style.width).toBe('1280px');
        expect(artifacts.style.height).toBe('800px');
        expect(artifacts.keepBrowserPanelRenderable).toHaveBeenCalledTimes(1);
        const panel = shadow.querySelector('.tab-content[data-tab="browser"]') as HTMLElement;
        const webview = shadow.querySelector('webview') as HTMLElement;
        expect(panel.style.display).toBe('');
        expect(panel.style.minHeight).toBe('800px');
        expect(webview.style.minHeight).toBe('800px');
        // 后台任务只准备可渲染的 webview，不得激活会改变当前任务布局的侧边栏路径。
        // 首次使用按任务记录待应用的大屏预览状态，切回任务时再生效。
        expect(taskView._forceExpandRightSidebar).not.toHaveBeenCalled();
        expect(taskView._ensureRightSidebarOpen).not.toHaveBeenCalled();
        expect(artifacts.consumeInitialBrowserAutoReveal).toHaveBeenCalledTimes(1);
        expect(artifacts.markPendingBrowserAutoReveal).toHaveBeenCalledTimes(1);
        expect(artifacts.forceBrowserActive).not.toHaveBeenCalled();
        expect(artifacts._suppressBrowserAutoSwitch).toBe(true);
        expect(artifacts.ensureBrowserReady).toHaveBeenCalledWith(false);
    });

    test('data-background task view stays offscreen without activating foreground layout', async () => {
        const window = installDom(`
            <div id="nonAppSlot" style="display:none">
                <task-view id="task-view" data-background="1">
                    <task-artifacts id="task-task-1-artifacts"></task-artifacts>
                </task-view>
            </div>
        `);
        const document = window.document;
        const taskView = document.getElementById('task-view') as HTMLElement & {
            _forceExpandRightSidebar?: jest.Mock;
            _ensureRightSidebarOpen?: jest.Mock;
        };
        const artifacts = document.getElementById('task-task-1-artifacts') as HTMLElement & {
            _suppressBrowserAutoSwitch?: boolean;
            consumeInitialBrowserAutoReveal?: jest.Mock;
            markPendingBrowserAutoReveal?: jest.Mock;
            ensureBrowserReady?: jest.Mock;
            forceBrowserActive?: jest.Mock;
        };

        const ensureTaskViewExists = jest.fn();
        (window as any).globalControlAPI = { ensureTaskViewExists };
        taskView._forceExpandRightSidebar = jest.fn();
        taskView._ensureRightSidebarOpen = jest.fn();
        artifacts.consumeInitialBrowserAutoReveal = jest.fn(() => true);
        artifacts.markPendingBrowserAutoReveal = jest.fn();
        artifacts.ensureBrowserReady = jest.fn();
        artifacts.forceBrowserActive = jest.fn();

        await runScript(makeEnsureSidebarScript('task-1'));

        expect(ensureTaskViewExists).toHaveBeenCalledWith('task-1');
        expect(taskView.getAttribute('data-background')).toBe('1');
        // 已缓存的后台任务遵循相同的非激活准备路径。
        expect(taskView._forceExpandRightSidebar).not.toHaveBeenCalled();
        expect(taskView._ensureRightSidebarOpen).not.toHaveBeenCalled();
        expect(artifacts.consumeInitialBrowserAutoReveal).toHaveBeenCalledTimes(1);
        expect(artifacts.markPendingBrowserAutoReveal).toHaveBeenCalledTimes(1);
        expect(artifacts.forceBrowserActive).not.toHaveBeenCalled();
        expect(artifacts._suppressBrowserAutoSwitch).toBe(true);
        expect(artifacts.ensureBrowserReady).toHaveBeenCalledWith(false);
    });

    test('defers a background first-use reveal to the task-visible transition without repeating it', async () => {
        const window = installDom(`
            <div id="nonAppSlot">
                <task-view id="task-view" data-background="1">
                    <task-artifacts id="task-task-1-artifacts"></task-artifacts>
                </task-view>
            </div>
        `);
        const document = window.document;
        const taskView = document.getElementById('task-view') as HTMLElement & {
            _ensureRightSidebarOpen?: jest.Mock;
        };
        const artifacts = document.getElementById('task-task-1-artifacts') as HTMLElement & {
            consumeInitialBrowserAutoReveal?: jest.Mock;
            markPendingBrowserAutoReveal?: jest.Mock;
            ensureBrowserReady?: jest.Mock;
            forceBrowserActive?: jest.Mock;
            keepBrowserPanelRenderable?: jest.Mock;
        };
        let consumed = false;

        taskView._ensureRightSidebarOpen = jest.fn();
        artifacts.consumeInitialBrowserAutoReveal = jest.fn(() => {
            if (consumed) return false;
            consumed = true;
            return true;
        });
        artifacts.markPendingBrowserAutoReveal = jest.fn();
        artifacts.ensureBrowserReady = jest.fn();
        artifacts.forceBrowserActive = jest.fn();
        artifacts.keepBrowserPanelRenderable = jest.fn();
        (window as any).globalControlAPI = { ensureTaskViewExists: jest.fn() };

        // 后台首次使用：保持离屏渲染，不激活任何前台布局，仅记录待应用的预览状态。
        await runScript(makeEnsureSidebarScript('task-1'));
        expect(artifacts.markPendingBrowserAutoReveal).toHaveBeenCalledTimes(1);
        expect(taskView._ensureRightSidebarOpen).not.toHaveBeenCalled();
        expect(artifacts.forceBrowserActive).not.toHaveBeenCalled();

        // 用户切回任务后的后续浏览器调用：机会已消费，钩子本身不再触碰布局
        // （大屏预览由 syncRightSidebarState 消费 pending 状态时统一应用）。
        taskView.removeAttribute('data-background');
        taskView.style.cssText = 'width:100%;height:100%;';
        await runScript(makeEnsureSidebarScript('task-1'));

        expect(artifacts.consumeInitialBrowserAutoReveal).toHaveBeenCalledTimes(2);
        expect(artifacts.markPendingBrowserAutoReveal).toHaveBeenCalledTimes(1);
        expect(taskView._ensureRightSidebarOpen).not.toHaveBeenCalled();
        expect(artifacts.forceBrowserActive).not.toHaveBeenCalled();
        expect(artifacts.ensureBrowserReady).toHaveBeenNthCalledWith(1, false);
        expect(artifacts.ensureBrowserReady).toHaveBeenNthCalledWith(2, false);
    });

    test('clears oversized artifact styles left by previous background preparation', async () => {
        const window = installDom(`
            <div id="nonAppSlot">
                <task-view id="task-view" style="width:1280px;height:800px">
                    <task-artifacts
                        id="task-task-1-artifacts"
                        style="width:1280px;min-width:1280px;height:800px;min-height:800px"
                    ></task-artifacts>
                </task-view>
            </div>
        `);
        const document = window.document;
        const taskView = document.getElementById('task-view') as HTMLElement & {
            _ensureRightSidebarOpen?: jest.Mock;
        };
        const artifacts = document.getElementById('task-task-1-artifacts') as HTMLElement & {
            consumeInitialBrowserAutoReveal?: jest.Mock;
            ensureBrowserReady?: jest.Mock;
        };

        Object.defineProperty(taskView, 'constructor', {
            value: { rightSidebarExpanded: false, rightSidebarWidth: 420 },
            configurable: true
        });
        taskView._ensureRightSidebarOpen = jest.fn();
        artifacts.consumeInitialBrowserAutoReveal = jest.fn(() => true);
        artifacts.ensureBrowserReady = jest.fn();
        (window as any).globalControlAPI = { ensureTaskViewExists: jest.fn() };

        await runScript(makeEnsureSidebarScript('task-1'));

        expect(artifacts.style.width).toBe('420px');
        expect(artifacts.style.minWidth).toBe('');
        expect(artifacts.style.height).toBe('');
        expect(artifacts.style.minHeight).toBe('');
        expect(artifacts.ensureBrowserReady).toHaveBeenCalledWith(true);
    });

    test('keeps visible task view on the normal sidebar path', async () => {
        const window = installDom(`
            <div id="nonAppSlot">
                <task-view id="task-view" style="width:1280px;height:800px">
                    <task-artifacts id="task-task-1-artifacts"></task-artifacts>
                </task-view>
            </div>
        `);
        const document = window.document;
        const taskView = document.getElementById('task-view') as HTMLElement & {
            _ensureRightSidebarOpen?: jest.Mock;
        };
        const artifacts = document.getElementById('task-task-1-artifacts') as HTMLElement & {
            consumeInitialBrowserAutoReveal?: jest.Mock;
            markPendingBrowserAutoReveal?: jest.Mock;
            ensureBrowserReady?: jest.Mock;
        };

        Object.defineProperty(taskView, 'offsetWidth', { value: 1280, configurable: true });
        Object.defineProperty(taskView, 'offsetHeight', { value: 800, configurable: true });
        taskView.getClientRects = () => [{ width: 1280, height: 800 }] as any;

        (window as any).globalControlAPI = { ensureTaskViewExists: jest.fn() };
        taskView._ensureRightSidebarOpen = jest.fn();
        artifacts.consumeInitialBrowserAutoReveal = jest.fn(() => true);
        artifacts.markPendingBrowserAutoReveal = jest.fn();
        artifacts.ensureBrowserReady = jest.fn();

        await runScript(makeEnsureSidebarScript('task-1'));

        expect(taskView._ensureRightSidebarOpen).toHaveBeenCalledTimes(1);
        expect(artifacts.ensureBrowserReady).toHaveBeenCalledWith(true);
        // 前台首次使用立即生效，不走延迟应用路径。
        expect(artifacts.markPendingBrowserAutoReveal).not.toHaveBeenCalled();
    });

    test('keeps repeated browser use in the current task from changing the user layout', async () => {
        const window = installDom(`
            <div id="nonAppSlot">
                <task-view id="task-view" style="width:1280px;height:800px">
                    <task-artifacts id="task-task-1-artifacts"></task-artifacts>
                </task-view>
            </div>
        `);
        const document = window.document;
        const taskView = document.getElementById('task-view') as HTMLElement & {
            _ensureRightSidebarOpen?: jest.Mock;
        };
        const artifacts = document.getElementById('task-task-1-artifacts') as HTMLElement & {
            _suppressBrowserAutoSwitch?: boolean;
            consumeInitialBrowserAutoReveal?: jest.Mock;
            ensureBrowserReady?: jest.Mock;
            forceBrowserActive?: jest.Mock;
            keepBrowserPanelRenderable?: jest.Mock;
        };

        (window as any).globalControlAPI = { ensureTaskViewExists: jest.fn() };
        taskView._ensureRightSidebarOpen = jest.fn();
        artifacts.consumeInitialBrowserAutoReveal = jest.fn(() => false);
        artifacts.ensureBrowserReady = jest.fn();
        artifacts.forceBrowserActive = jest.fn();
        artifacts.keepBrowserPanelRenderable = jest.fn();

        await runScript(makeEnsureSidebarScript('task-1'));

        expect(taskView._ensureRightSidebarOpen).not.toHaveBeenCalled();
        expect(artifacts.forceBrowserActive).not.toHaveBeenCalled();
        expect(artifacts.ensureBrowserReady).toHaveBeenCalledWith(false);
        expect(artifacts.keepBrowserPanelRenderable).toHaveBeenCalledTimes(1);
        expect(artifacts._suppressBrowserAutoSwitch).toBe(true);
    });

    test('does not destroy browsers in other hidden task views before preparing a visible task browser', async () => {
        const window = installDom(`
            <div id="nonAppSlot">
                <task-view id="hidden-task" style="display:none">
                    <task-artifacts id="task-task-1-artifacts"></task-artifacts>
                </task-view>
                <task-view id="visible-task" style="width:1280px;height:800px">
                    <task-artifacts id="task-task-2-artifacts"></task-artifacts>
                </task-view>
            </div>
        `);
        const document = window.document;
        const visibleTaskView = document.getElementById('visible-task') as HTMLElement & {
            _ensureRightSidebarOpen?: jest.Mock;
        };
        const hiddenArtifacts = document.getElementById('task-task-1-artifacts') as HTMLElement & {
            isBrowserVisible?: jest.Mock;
            destroyBrowser?: jest.Mock;
        };
        const visibleArtifacts = document.getElementById('task-task-2-artifacts') as HTMLElement & {
            consumeInitialBrowserAutoReveal?: jest.Mock;
            ensureBrowserReady?: jest.Mock;
        };

        visibleTaskView._ensureRightSidebarOpen = jest.fn();
        hiddenArtifacts.isBrowserVisible = jest.fn(() => true);
        hiddenArtifacts.destroyBrowser = jest.fn();
        visibleArtifacts.consumeInitialBrowserAutoReveal = jest.fn(() => true);
        visibleArtifacts.ensureBrowserReady = jest.fn();
        (window as any).globalControlAPI = { ensureTaskViewExists: jest.fn() };

        await runScript(makeEnsureSidebarScript('task-2'));

        expect(hiddenArtifacts.destroyBrowser).not.toHaveBeenCalled();
        expect(visibleArtifacts.ensureBrowserReady).toHaveBeenCalledWith(true);
    });

    test('does not destroy other hidden browsers while preparing a hidden task browser', async () => {
        const window = installDom(`
            <div id="nonAppSlot" style="display:none">
                <task-view id="other-task" style="display:none">
                    <task-artifacts id="task-task-1-artifacts"></task-artifacts>
                </task-view>
                <task-view id="current-task" data-background="1">
                    <task-artifacts id="task-task-2-artifacts"></task-artifacts>
                </task-view>
            </div>
        `);
        const document = window.document;
        const hiddenArtifacts = document.getElementById('task-task-1-artifacts') as HTMLElement & {
            isBrowserVisible?: jest.Mock;
            destroyBrowser?: jest.Mock;
        };
        const currentArtifacts = document.getElementById('task-task-2-artifacts') as HTMLElement & {
            consumeInitialBrowserAutoReveal?: jest.Mock;
            ensureBrowserReady?: jest.Mock;
        };

        hiddenArtifacts.isBrowserVisible = jest.fn(() => true);
        hiddenArtifacts.destroyBrowser = jest.fn();
        currentArtifacts.consumeInitialBrowserAutoReveal = jest.fn(() => true);
        currentArtifacts.ensureBrowserReady = jest.fn();
        (window as any).globalControlAPI = { ensureTaskViewExists: jest.fn() };

        await runScript(makeEnsureSidebarScript('task-2'));

        expect(hiddenArtifacts.destroyBrowser).not.toHaveBeenCalled();
        expect(currentArtifacts.ensureBrowserReady).toHaveBeenCalledWith(false);
    });

    test('switches to browser tab even when the visible sidebar is already expanded', async () => {
        const window = installDom(`
            <div id="nonAppSlot">
                <task-view id="task-view" style="width:1280px;height:800px">
                    <task-artifacts id="task-task-1-artifacts"></task-artifacts>
                </task-view>
            </div>
        `);
        const document = window.document;
        const taskView = document.getElementById('task-view') as HTMLElement & {
            _ensureRightSidebarOpen?: jest.Mock;
        };
        const artifacts = document.getElementById('task-task-1-artifacts') as HTMLElement & {
            _suppressBrowserAutoSwitch?: boolean;
            consumeInitialBrowserAutoReveal?: jest.Mock;
            ensureBrowserReady?: jest.Mock;
        };

        Object.defineProperty(taskView, 'offsetWidth', { value: 1280, configurable: true });
        Object.defineProperty(taskView, 'offsetHeight', { value: 800, configurable: true });
        Object.defineProperty(taskView, 'constructor', {
            value: { rightSidebarExpanded: true },
            configurable: true
        });
        taskView.getClientRects = () => [{ width: 1280, height: 800 }] as any;

        (window as any).globalControlAPI = { ensureTaskViewExists: jest.fn() };
        taskView._ensureRightSidebarOpen = jest.fn();
        artifacts.consumeInitialBrowserAutoReveal = jest.fn(() => true);
        artifacts._suppressBrowserAutoSwitch = true;
        artifacts.ensureBrowserReady = jest.fn();

        await runScript(makeEnsureSidebarScript('task-1'));

        expect(artifacts._suppressBrowserAutoSwitch).toBe(false);
        expect(artifacts.ensureBrowserReady).toHaveBeenCalledWith(true);
    });

    test('prefers explicit browser activation when available', async () => {
        const window = installDom(`
            <div id="nonAppSlot">
                <task-view id="task-view" style="width:1280px;height:800px">
                    <task-artifacts id="task-task-1-artifacts"></task-artifacts>
                </task-view>
            </div>
        `);
        const document = window.document;
        const taskView = document.getElementById('task-view') as HTMLElement & {
            _ensureRightSidebarOpen?: jest.Mock;
        };
        const artifacts = document.getElementById('task-task-1-artifacts') as HTMLElement & {
            _suppressBrowserAutoSwitch?: boolean;
            consumeInitialBrowserAutoReveal?: jest.Mock;
            ensureBrowserReady?: jest.Mock;
            forceBrowserActive?: jest.Mock;
        };

        (window as any).globalControlAPI = { ensureTaskViewExists: jest.fn() };
        taskView._ensureRightSidebarOpen = jest.fn();
        artifacts.consumeInitialBrowserAutoReveal = jest.fn(() => true);
        artifacts._suppressBrowserAutoSwitch = true;
        artifacts.ensureBrowserReady = jest.fn();
        artifacts.forceBrowserActive = jest.fn();

        await runScript(makeEnsureSidebarScript('task-1'));

        expect(taskView._ensureRightSidebarOpen).toHaveBeenCalledTimes(1);
        expect(artifacts._suppressBrowserAutoSwitch).toBe(false);
        expect(artifacts.forceBrowserActive).toHaveBeenCalledTimes(1);
        expect(artifacts.ensureBrowserReady).not.toHaveBeenCalled();
    });
});
