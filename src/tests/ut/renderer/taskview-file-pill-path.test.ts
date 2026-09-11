import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

/**
 * 与 taskview-message-queue.test.ts 保持一致的计时器保护：
 * 部分 Node + Jest ESM 组合下，jest.useRealTimers() 恢复后会把计时器全局变量
 * 置为 undefined，因此在模块加载时保存真实计时器引用，恢复时显式写回 globalThis。
 */
const realTimerGlobals = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setImmediate: globalThis.setImmediate,
    clearImmediate: globalThis.clearImmediate
};

function restoreRealTimerGlobals(): void {
    jest.useRealTimers();
    Object.assign(globalThis, realTimerGlobals);
}

// 历史消息的 rendered HTML 中可能存有 POSIX 风格的 "/C:/..." 盘符路径，
// 点击时必须规范化为 "C:/..." 再做存在性校验与预览，否则 Windows 上误报文件不存在。
const LEGACY_PATH = '/C:/Projects/OpenDesk-ohos/ohos_hap/build_hap.py';
const NORMALIZED_PATH = 'C:/Projects/OpenDesk-ohos/ohos_hap/build_hap.py';

describe('task-view file pill path normalization', () => {
    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            CustomEvent: window.CustomEvent,
            customElements: window.customElements,
            MutationObserver: window.MutationObserver,
            Node: window.Node,
            sessionStorage: {
                getItem: () => null,
                removeItem: () => undefined
            },
            requestAnimationFrame: (callback: FrameRequestCallback) => {
                callback(0);
                return 0;
            },
            cancelAnimationFrame: () => undefined
        });
        Object.defineProperty(globalThis, 'navigator', {
            value: { languages: ['zh-CN'], language: 'zh-CN' },
            configurable: true
        });

        await jest.unstable_mockModule('../../../renderer/components/toolbar.ts', () => ({
            ElasticToolbarWidget: class extends HTMLElement {
                setToolbarTitle() {}
                setToolbarSubtitle() {}
            }
        }));
        await jest.unstable_mockModule('../../../renderer/components/taskartifacts.ts', () => ({}));
        await jest.unstable_mockModule('../../../renderer/components/browserPip.ts', () => ({
            BrowserPip: class {
                destroy() {}
                hide() {}
                isClosed() {
                    return false;
                }
                isVisible() {
                    return false;
                }
                resetClosed() {}
                show() {}
                triggerCapture() {}
            }
        }));
        await jest.unstable_mockModule('../../../renderer/components/imageLightbox.js', () => ({
            showImageLightbox: jest.fn()
        }));
        await jest.unstable_mockModule('../../../renderer/components/previewer.ts', () => ({
            enhanceCodeBlocks: jest.fn(),
            enhanceToolPreviewCards: jest.fn(),
            renderMermaidBlocks: jest.fn()
        }));

        window.settingAPI = {
            loadSettingObject: async () => ({}),
            onSettingChanged: () => undefined
        };

        customElements.define(
            'agent-input',
            class extends HTMLElement {
                availableModels: unknown[] = [];
                setDisabled() {}
                setModel() {}
                setReasoningEffort() {}
                setStopMode() {}
                setSlashCommandContext() {}
            }
        );
        customElements.define(
            'message-queue-panel',
            class extends HTMLElement {
                setCallbacks() {}
                setQueue() {}
            }
        );

        await import('../../../renderer/components/taskview.js');
    });

    beforeEach(() => {
        window.fsAPI = {
            fileExists: jest.fn(async () => true)
        };
    });

    function createTaskView(): HTMLElement & {
        task_id: string;
        openFileInSidebar: (filePath: string, line?: number) => Promise<void>;
        _handlePreviewOpenClick: (e: {
            target: Element;
            preventDefault: () => void;
            stopPropagation: () => void;
        }) => void;
        _handleEditorOpenClick: (e: {
            target: Element;
            preventDefault: () => void;
            stopPropagation: () => void;
        }) => void;
        _openFileContextMenu: (filePath: string, x: number, y: number) => void;
        _dismissFilePillContextMenu: () => void;
    } {
        // 不插入 document：connectedCallback 的完整初始化在 linkedom 下无法运行
        // （与 taskview-message-queue.test.ts 一致，仅创建元素并设置 task_id）
        const taskView = document.createElement('task-view') as ReturnType<typeof createTaskView>;
        taskView.setAttribute('task_id', 'task-1');
        taskView.task_id = 'task-1';
        return taskView;
    }

    function appendSidebar(
        taskView: HTMLElement
    ): HTMLElement & { openFilePreview: jest.Mock; openFileInEditor: jest.Mock } {
        const sidebar = document.createElement('div') as HTMLElement & {
            openFilePreview: jest.Mock;
            openFileInEditor: jest.Mock;
        };
        // _getRightSidebarEl() 按 `#task-${task_id}-artifacts` 查找，task_id 已含 "task-" 前缀
        sidebar.id = `task-${taskView.task_id}-artifacts`;
        sidebar.openFilePreview = jest.fn();
        sidebar.openFileInEditor = jest.fn();
        taskView.appendChild(sidebar);
        return sidebar;
    }

    test('openFileInSidebar normalizes drive-root path before existence check', async () => {
        const taskView = createTaskView();
        const fileExists = jest.fn(async (p: string) => p === NORMALIZED_PATH);
        window.fsAPI = { fileExists };

        await taskView.openFileInSidebar(LEGACY_PATH);

        expect(fileExists).toHaveBeenCalledWith(NORMALIZED_PATH);
    });

    test('preview click on legacy pill checks the normalized path', async () => {
        const taskView = createTaskView();
        const fileExists = jest.fn(async (p: string) => p === NORMALIZED_PATH);
        window.fsAPI = { fileExists };

        const pill = document.createElement('a');
        pill.setAttribute('data-open-preview', LEGACY_PATH);
        pill.setAttribute('data-preview-line', '1938');
        taskView._handlePreviewOpenClick({ target: pill, preventDefault: () => {}, stopPropagation: () => {} });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(fileExists).toHaveBeenCalledWith(NORMALIZED_PATH);
    });

    test('editor open click passes the normalized path to the sidebar', () => {
        const taskView = createTaskView();
        const sidebar = appendSidebar(taskView);

        const pill = document.createElement('a');
        pill.setAttribute('data-open-editor', LEGACY_PATH);
        taskView._handleEditorOpenClick({ target: pill, preventDefault: () => {}, stopPropagation: () => {} });

        expect(sidebar.openFileInEditor).toHaveBeenCalledWith(NORMALIZED_PATH, undefined);
    });

    test('context menu preview action opens the normalized path', () => {
        const taskView = createTaskView();
        const sidebar = appendSidebar(taskView);

        taskView._openFileContextMenu(LEGACY_PATH, 10, 10);
        const menu = document.getElementById('od-file-pill-ctx');
        expect(menu).toBeTruthy();
        (menu as HTMLElement)
            .querySelector('[data-action="preview"]')
            ?.dispatchEvent(new window.CustomEvent('click', { bubbles: true }));

        expect(sidebar.openFilePreview).toHaveBeenCalledWith(NORMALIZED_PATH);
        taskView._dismissFilePillContextMenu();
    });

    test('context menu copy-path copies the normalized path', () => {
        const taskView = createTaskView();
        const writeText = jest.fn(async () => undefined);
        Object.defineProperty(globalThis, 'navigator', {
            value: { languages: ['zh-CN'], language: 'zh-CN', clipboard: { writeText } },
            configurable: true
        });

        taskView._openFileContextMenu(LEGACY_PATH, 10, 10);
        const menu = document.getElementById('od-file-pill-ctx');
        (menu as HTMLElement)
            .querySelector('[data-action="copy-path"]')
            ?.dispatchEvent(new window.CustomEvent('click', { bubbles: true }));

        expect(writeText).toHaveBeenCalledWith(NORMALIZED_PATH);
        taskView._dismissFilePillContextMenu();
    });
});

afterAll(() => {
    restoreRealTimerGlobals();
});
