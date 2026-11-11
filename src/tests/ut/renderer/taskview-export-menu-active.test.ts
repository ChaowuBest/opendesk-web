import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { readFileSync } from 'node:fs';

/**
 * 导出菜单打开期间，工具栏导出按钮必须保持激活态（图标 + 文字同时高亮），
 * 鼠标移到菜单项上时不能熄灭；菜单关闭后恢复常态。
 */
describe('task-view export menu button active state', () => {
    let TaskViewClass: any;

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
            sessionStorage: { getItem: () => null, removeItem: () => undefined },
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
            renderMermaidBlocks: jest.fn(),
            untrackPreviewerContainers: jest.fn(),
            prepareSearchPreviews: async () => {},
            revealSearchPreview: jest.fn()
        }));

        window.settingAPI = {
            loadSettingObject: async () => ({}),
            onSettingChanged: () => undefined
        };

        customElements.define('agent-input', class extends HTMLElement {});
        customElements.define('message-queue-panel', class extends HTMLElement {});

        await import('../../../renderer/components/taskview.js');
        TaskViewClass = customElements.get('task-view');
    });

    function createTaskViewWithExportButton() {
        const taskView = new TaskViewClass();
        taskView.task_id = 'task-export-active';
        const button = document.createElement('button');
        button.id = 'taskview-export-btn-test';
        button.className = 'toolbar-spread-btn expand-label';
        button.innerHTML = '<span class="elastic-icon-wrap"><svg></svg></span><span class="elastic-label">导出</span>';
        taskView.appendChild(button);
        return { taskView, button };
    }

    test('打开导出菜单时按钮保持激活态，关闭后复原', () => {
        const { taskView, button } = createTaskViewWithExportButton();

        taskView._openExportMenu(button);
        expect(document.getElementById('od-taskview-export-menu')).not.toBeNull();
        expect(button.classList.contains('toolbar-spread-btn-on')).toBe(true);

        taskView._dismissExportMenu();
        expect(document.getElementById('od-taskview-export-menu')).toBeNull();
        expect(button.classList.contains('toolbar-spread-btn-on')).toBe(false);
    });

    test('再次点击按钮关闭菜单时同样复原激活态', () => {
        const { taskView, button } = createTaskViewWithExportButton();

        taskView._openExportMenu(button);
        expect(button.classList.contains('toolbar-spread-btn-on')).toBe(true);

        // 菜单已存在时再次调用等价于点击按钮收起
        taskView._openExportMenu(button);
        expect(document.getElementById('od-taskview-export-menu')).toBeNull();
        expect(button.classList.contains('toolbar-spread-btn-on')).toBe(false);
    });

    test('激活态下弹性工具栏保持 label 展开（CSS 规则存在）', () => {
        const css = readFileSync(new URL('../../../renderer/components/toolbar.css', import.meta.url), 'utf8');
        const block = css.match(
            /\.toolbar-spread-btn\.expand-label\.toolbar-spread-btn-on\s+\.elastic-label\s*\{([^}]*)\}/
        );
        expect(block).not.toBeNull();
        expect(block![1]).toMatch(/max-width:\s*56px/);
        expect(block![1]).toMatch(/opacity:\s*1/);
    });
});
