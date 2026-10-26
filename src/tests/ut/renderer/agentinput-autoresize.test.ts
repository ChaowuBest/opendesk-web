import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { confirmModalMockShim } from '../../confirmModalMock.js';

describe('agent-input auto-resize', () => {
    const resizeObserverCallbacks = new Map<Element, ResizeObserverCallback>();

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
                private readonly callback: ResizeObserverCallback;

                constructor(callback: ResizeObserverCallback) {
                    this.callback = callback;
                }

                observe(target: Element) {
                    resizeObserverCallbacks.set(target, this.callback);
                }
                disconnect() {}
            }
        });
        Object.defineProperty(globalThis, 'navigator', {
            value: { languages: ['zh-CN'], language: 'zh-CN' },
            configurable: true
        });

        await jest.unstable_mockModule('../../../renderer/components/confirmModal.ts', () =>
            confirmModalMockShim({
                showConfirmModal: jest.fn()
            })
        );
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
        resizeObserverCallbacks.clear();
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

    test('读取 scrollHeight 测量期间输入容器已冻结高度，测量后恢复', () => {
        const { input, textarea } = setupInput();
        const container = input.querySelector('#agent-input-container') as HTMLElement;
        // 记录 scrollHeight 被读取（即 height='auto' 塌缩后强制布局）那一刻的容器状态
        const observations: { containerMinHeight: string; textareaHeight: string }[] = [];
        Object.defineProperty(textarea, 'scrollHeight', {
            get() {
                observations.push({
                    containerMinHeight: container.style.minHeight,
                    textareaHeight: textarea.style.height
                });
                return 120;
            },
            configurable: true
        });
        input.autoResizeTextarea(textarea);
        // 测量时 textarea 已塌缩为 auto，此刻容器必须带非空 min-height 冻结，
        // 否则宿主页面里 flex 布局会让消息历史区瞬时变高、
        // 已钉底的 scrollTop 被浏览器钳制回退（底部消息不可见的根因）
        expect(observations.length).toBeGreaterThan(0);
        for (const obs of observations) {
            expect(obs.textareaHeight).toBe('auto');
            expect(typeof obs.containerMinHeight).toBe('string');
            expect(obs.containerMinHeight.length).toBeGreaterThan(0);
        }
        // 测量结束后容器高度冻结必须恢复，避免残留 min-height 影响后续布局
        expect(container.style.minHeight).toBe('');
        expect(textarea.style.height).toBe('120px');
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

    function setupInputWithHeightBudget(initialHeight: number, hostSelector = 'task-view') {
        let heightBudget = initialHeight;
        const heightReference = document.createElement('div');
        Object.defineProperty(heightReference, 'clientHeight', {
            get: () => heightBudget,
            configurable: true
        });
        const input = document.createElement('agent-input') as HTMLElement & {
            render: () => void;
            autoResizeTextarea: (textarea: HTMLTextAreaElement) => void;
            addImage: (dataUrl: string, name?: string) => void;
            removeImage: (index: number) => void;
        };
        (input as unknown as { closest: (selector: string) => unknown }).closest = jest.fn((selector: string) => {
            if (selector === '[data-agent-input-height-reference]') return heightReference;
            if (selector !== hostSelector) return null;
            return {
                querySelector: (childSelector: string) =>
                    childSelector === '[data-agent-input-height-reference]' ? heightReference : null
            };
        });
        input.render();
        const textarea = input.querySelector('#agent-input-textarea') as HTMLTextAreaElement;
        Object.defineProperty(textarea, 'offsetHeight', {
            get: () => parseFloat(textarea.style.height) || 56,
            configurable: true
        });
        Object.defineProperty(input, 'offsetHeight', {
            get: () => {
                const previews = input.querySelector('#agent-input-image-previews');
                const previewHeight = previews?.style.display === 'none' ? 0 : 80;
                return textarea.offsetHeight + 64 + previewHeight;
            },
            configurable: true
        });
        Object.defineProperty(textarea, 'scrollHeight', { value: 400, configurable: true });

        return {
            input,
            textarea,
            resizeTo(nextHeight: number) {
                heightBudget = nextHeight;
                const callback = resizeObserverCallbacks.get(heightReference);
                expect(callback).toBeDefined();
                callback?.([], {} as ResizeObserver);
            }
        };
    }

    test('可用高度很小时优先保证 textarea 最小高度', () => {
        const { input, textarea } = setupInputWithHeightBudget(100);
        input.autoResizeTextarea(textarea);
        expect(textarea.style.height).toBe('56px');
        expect(input.offsetHeight).toBe(120);
    });

    test('整个输入组件不超过任务内容区高度的 50%', () => {
        const { input, textarea } = setupInputWithHeightBudget(400);
        input.autoResizeTextarea(textarea);
        expect(textarea.style.height).toBe('136px');
        expect(input.offsetHeight).toBe(200);
    });

    test('可用高度很大时，textarea 仍封顶为绝对上限 240px', () => {
        const { input, textarea } = setupInputWithHeightBudget(1000);
        input.autoResizeTextarea(textarea);
        expect(textarea.style.height).toBe('240px');
        expect(input.offsetHeight).toBe(304);
    });

    test('父容器从高变矮时，textarea 被压缩到新的稳定高度', () => {
        const { input, textarea, resizeTo } = setupInputWithHeightBudget(600);
        resizeTo(600);
        expect(textarea.style.height).toBe('236px');
        expect(input.offsetHeight).toBe(300);

        resizeTo(300);
        expect(textarea.style.height).toBe('86px');
        expect(input.offsetHeight).toBe(150);
    });

    test('父容器从矮恢复高时，textarea 根据原有 scrollHeight 恢复', () => {
        const { input, textarea, resizeTo } = setupInputWithHeightBudget(300);
        resizeTo(300);
        expect(textarea.style.height).toBe('86px');
        expect(input.offsetHeight).toBe(150);

        resizeTo(600);
        expect(textarea.style.height).toBe('236px');
        expect(input.offsetHeight).toBe(300);
    });

    test('首页输入组件也不超过页面可用高度的 50%', () => {
        const { input, textarea, resizeTo } = setupInputWithHeightBudget(300, 'home-page');
        input.autoResizeTextarea(textarea);
        expect(textarea.style.height).toBe('86px');
        expect(input.offsetHeight).toBe(150);

        resizeTo(600);
        expect(textarea.style.height).toBe('236px');
        expect(input.offsetHeight).toBe(300);
    });

    test('图片预览区变化时重新分配整个输入组件的高度额度', () => {
        const { input, textarea } = setupInputWithHeightBudget(400);
        input.autoResizeTextarea(textarea);
        expect(textarea.style.height).toBe('136px');

        input.addImage('data:image/png;base64,AA==', 'preview.png');
        expect(textarea.style.height).toBe('56px');
        expect(input.offsetHeight).toBe(200);

        input.removeImage(0);
        expect(textarea.style.height).toBe('136px');
        expect(input.offsetHeight).toBe(200);
    });
});
