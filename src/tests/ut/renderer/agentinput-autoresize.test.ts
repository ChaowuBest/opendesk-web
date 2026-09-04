import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

describe('agent-input auto-resize', () => {
    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            Event: window.Event,
            CustomEvent: window.CustomEvent,
            customElements: window.customElements,
            MutationObserver: window.MutationObserver,
            Node: window.Node,
            requestAnimationFrame: (callback: FrameRequestCallback) => {
                callback(0);
                return 0;
            },
            cancelAnimationFrame: () => undefined,
            ResizeObserver: class {
                observe() {}
                disconnect() {}
            }
        });
        Object.defineProperty(globalThis, 'navigator', {
            value: { languages: ['zh-CN'], language: 'zh-CN' },
            configurable: true
        });

        await jest.unstable_mockModule('../../../renderer/components/confirmModal.ts', () => ({
            showConfirmModal: jest.fn()
        }));
        await jest.unstable_mockModule('../../../renderer/components/imageLightbox.js', () => ({
            showImageLightbox: jest.fn()
        }));
        await jest.unstable_mockModule('../../../platforms/bridges/renderer.ts', () => ({
            NativeBridgeProxy: class {
                async getSpeechKit() {
                    return { available: async () => false };
                }
            }
        }));
        await jest.unstable_mockModule('../../../renderer/components/slash-command.ts', () => ({
            getSlashCommands: jest.fn(() => []),
            filterSlashCommands: jest.fn(() => []),
            executeSlashCommand: jest.fn(),
            refreshPluginSlashCommands: jest.fn(async () => {})
        }));

        await import('../../../renderer/components/agentinput.js');
    });

    beforeEach(() => {
        document.body.innerHTML = '';
        window.taskManagerAPI = {
            getAttachmentFileSupport: jest.fn(async () => ({
                supportedExtensions: ['doc', 'pdf'],
                knownUnsupportedExtensions: ['ppt']
            }))
        };
    });

    function setupInput() {
        const input = document.createElement('agent-input') as HTMLElement & {
            render: () => void;
            setText: (text: string) => void;
            autoResizeTextarea: (textarea: HTMLTextAreaElement) => void;
        };
        input.render();
        const textarea = input.querySelector('#agent-input-textarea') as HTMLTextAreaElement;
        textarea.setRangeText = jest.fn();
        textarea.focus = jest.fn();
        return { input, textarea };
    }

    test('当内容高度未超过上限时，按 scrollHeight 自适应高度', () => {
        const { input, textarea } = setupInput();
        Object.defineProperty(textarea, 'scrollHeight', { value: 84, configurable: true });
        input.autoResizeTextarea(textarea);
        expect(textarea.style.height).toBe('84px');
    });

    test('当内容高度超过上限时，封顶为 240px', () => {
        const { input, textarea } = setupInput();
        Object.defineProperty(textarea, 'scrollHeight', { value: 400, configurable: true });
        input.autoResizeTextarea(textarea);
        expect(textarea.style.height).toBe('240px');
    });

    test('setText 会触发高度自适应', () => {
        const { input, textarea } = setupInput();
        Object.defineProperty(textarea, 'scrollHeight', { value: 120, configurable: true });
        input.setText('多行内容');
        expect(textarea.style.height).toBe('120px');
    });

    test('input 事件触发高度自适应且随内容变化收缩或增高', () => {
        const { input, textarea } = setupInput();
        Object.defineProperty(textarea, 'scrollHeight', { value: 100, configurable: true });
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        expect(textarea.style.height).toBe('100px');

        Object.defineProperty(textarea, 'scrollHeight', { value: 30, configurable: true });
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        expect(textarea.style.height).toBe('30px');
    });

    function mockDialogHeight(input: HTMLElement, height: number) {
        (input as unknown as { closest: () => unknown }).closest = jest.fn(() => ({
            querySelector: () => ({ clientHeight: height })
        }));
    }

    test('对话框高度很小时，上限按比例缩小但保底最小高度', () => {
        const { input, textarea } = setupInput();
        // 对话框 100px，比例 0.5 → 50px，低于最小高度 56px，故保底 56px
        mockDialogHeight(input, 100);
        Object.defineProperty(textarea, 'scrollHeight', { value: 400, configurable: true });
        input.autoResizeTextarea(textarea);
        expect(textarea.style.height).toBe('56px');
    });

    test('对话框高度正常时，上限为对话框高度的 50%', () => {
        const { input, textarea } = setupInput();
        // 对话框 400px，比例 0.5 → 上限 200px
        mockDialogHeight(input, 400);
        Object.defineProperty(textarea, 'scrollHeight', { value: 400, configurable: true });
        input.autoResizeTextarea(textarea);
        expect(textarea.style.height).toBe('200px');
    });

    test('对话框高度很大时，封顶为绝对上限 240px', () => {
        const { input, textarea } = setupInput();
        // 对话框 1000px，比例 0.5 → 500px，超过绝对上限 240px，故封顶 240px
        mockDialogHeight(input, 1000);
        Object.defineProperty(textarea, 'scrollHeight', { value: 400, configurable: true });
        input.autoResizeTextarea(textarea);
        expect(textarea.style.height).toBe('240px');
    });
});
