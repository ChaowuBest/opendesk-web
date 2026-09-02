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

function runScript(script: string): void {
    new Function(script)();
}

describe('browser utils', () => {
    afterEach(() => {
        delete (globalThis as any).window;
        delete (globalThis as any).document;
    });

    test('hidden task view gets offscreen rendering without activating foreground layout', () => {
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
        artifacts.ensureBrowserReady = jest.fn();
        artifacts.forceBrowserActive = jest.fn();
        artifacts.keepBrowserPanelRenderable = jest.fn();

        runScript(makeEnsureSidebarScript('task-1'));

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
        expect(taskView._forceExpandRightSidebar).not.toHaveBeenCalled();
        expect(taskView._ensureRightSidebarOpen).not.toHaveBeenCalled();
        expect(artifacts.forceBrowserActive).not.toHaveBeenCalled();
        expect(artifacts._suppressBrowserAutoSwitch).toBe(true);
        expect(artifacts.ensureBrowserReady).toHaveBeenCalledWith(false);
    });

    test('data-background task view stays offscreen without activating foreground layout', () => {
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
            ensureBrowserReady?: jest.Mock;
            forceBrowserActive?: jest.Mock;
        };

        const ensureTaskViewExists = jest.fn();
        (window as any).globalControlAPI = { ensureTaskViewExists };
        taskView._forceExpandRightSidebar = jest.fn();
        taskView._ensureRightSidebarOpen = jest.fn();
        artifacts.ensureBrowserReady = jest.fn();
        artifacts.forceBrowserActive = jest.fn();

        runScript(makeEnsureSidebarScript('task-1'));

        expect(ensureTaskViewExists).toHaveBeenCalledWith('task-1');
        expect(taskView.getAttribute('data-background')).toBe('1');
        // 已缓存的后台任务遵循相同的非激活准备路径。
        expect(taskView._forceExpandRightSidebar).not.toHaveBeenCalled();
        expect(taskView._ensureRightSidebarOpen).not.toHaveBeenCalled();
        expect(artifacts.forceBrowserActive).not.toHaveBeenCalled();
        expect(artifacts._suppressBrowserAutoSwitch).toBe(true);
        expect(artifacts.ensureBrowserReady).toHaveBeenCalledWith(false);
    });

    test('clears oversized artifact styles left by previous background preparation', () => {
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
            ensureBrowserReady?: jest.Mock;
        };

        Object.defineProperty(taskView, 'constructor', {
            value: { rightSidebarExpanded: false, rightSidebarWidth: 420 },
            configurable: true
        });
        taskView._ensureRightSidebarOpen = jest.fn();
        artifacts.ensureBrowserReady = jest.fn();
        (window as any).globalControlAPI = { ensureTaskViewExists: jest.fn() };

        runScript(makeEnsureSidebarScript('task-1'));

        expect(artifacts.style.width).toBe('420px');
        expect(artifacts.style.minWidth).toBe('');
        expect(artifacts.style.height).toBe('');
        expect(artifacts.style.minHeight).toBe('');
        expect(artifacts.ensureBrowserReady).toHaveBeenCalledWith(true);
    });

    test('keeps visible task view on the normal sidebar path', () => {
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
            ensureBrowserReady?: jest.Mock;
        };

        Object.defineProperty(taskView, 'offsetWidth', { value: 1280, configurable: true });
        Object.defineProperty(taskView, 'offsetHeight', { value: 800, configurable: true });
        taskView.getClientRects = () => [{ width: 1280, height: 800 }] as any;

        (window as any).globalControlAPI = { ensureTaskViewExists: jest.fn() };
        taskView._ensureRightSidebarOpen = jest.fn();
        artifacts.ensureBrowserReady = jest.fn();

        runScript(makeEnsureSidebarScript('task-1'));

        expect(taskView._ensureRightSidebarOpen).toHaveBeenCalledTimes(1);
        expect(artifacts.ensureBrowserReady).toHaveBeenCalledWith(true);
    });

    test('does not destroy browsers in other hidden task views before preparing a visible task browser', () => {
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
            ensureBrowserReady?: jest.Mock;
        };

        visibleTaskView._ensureRightSidebarOpen = jest.fn();
        hiddenArtifacts.isBrowserVisible = jest.fn(() => true);
        hiddenArtifacts.destroyBrowser = jest.fn();
        visibleArtifacts.ensureBrowserReady = jest.fn();
        (window as any).globalControlAPI = { ensureTaskViewExists: jest.fn() };

        runScript(makeEnsureSidebarScript('task-2'));

        expect(hiddenArtifacts.destroyBrowser).not.toHaveBeenCalled();
        expect(visibleArtifacts.ensureBrowserReady).toHaveBeenCalledWith(true);
    });

    test('does not destroy other hidden browsers while preparing a hidden task browser', () => {
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
            ensureBrowserReady?: jest.Mock;
        };

        hiddenArtifacts.isBrowserVisible = jest.fn(() => true);
        hiddenArtifacts.destroyBrowser = jest.fn();
        currentArtifacts.ensureBrowserReady = jest.fn();
        (window as any).globalControlAPI = { ensureTaskViewExists: jest.fn() };

        runScript(makeEnsureSidebarScript('task-2'));

        expect(hiddenArtifacts.destroyBrowser).not.toHaveBeenCalled();
        expect(currentArtifacts.ensureBrowserReady).toHaveBeenCalledWith(false);
    });

    test('switches to browser tab even when the visible sidebar is already expanded', () => {
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
        artifacts._suppressBrowserAutoSwitch = true;
        artifacts.ensureBrowserReady = jest.fn();

        runScript(makeEnsureSidebarScript('task-1'));

        expect(artifacts._suppressBrowserAutoSwitch).toBe(false);
        expect(artifacts.ensureBrowserReady).toHaveBeenCalledWith(true);
    });

    test('prefers explicit browser activation when available', () => {
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
            ensureBrowserReady?: jest.Mock;
            forceBrowserActive?: jest.Mock;
        };

        (window as any).globalControlAPI = { ensureTaskViewExists: jest.fn() };
        taskView._ensureRightSidebarOpen = jest.fn();
        artifacts._suppressBrowserAutoSwitch = true;
        artifacts.ensureBrowserReady = jest.fn();
        artifacts.forceBrowserActive = jest.fn();

        runScript(makeEnsureSidebarScript('task-1'));

        expect(taskView._ensureRightSidebarOpen).toHaveBeenCalledTimes(1);
        expect(artifacts._suppressBrowserAutoSwitch).toBe(false);
        expect(artifacts.forceBrowserActive).toHaveBeenCalledTimes(1);
        expect(artifacts.ensureBrowserReady).not.toHaveBeenCalled();
    });
});
