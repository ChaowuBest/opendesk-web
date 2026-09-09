import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

const showConfirmModal = jest.fn(async () => true);
const executeSlashCommand = jest.fn();

describe('agent-input toolbar horizontal scroll', () => {
    let AgentInput: any;

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
                unobserve() {}
                disconnect() {}
            }
        });
        Object.defineProperty(globalThis, 'navigator', {
            value: { languages: ['zh-CN'], language: 'zh-CN' },
            configurable: true
        });

        await jest.unstable_mockModule('../../../renderer/components/confirmModal.ts', () => ({
            showConfirmModal
        }));
        await jest.unstable_mockModule('../../../renderer/components/imageLightbox.js', () => ({
            showImageLightbox: jest.fn()
        }));
        await jest.unstable_mockModule('../../../platforms/bridges/renderer.ts', () => ({
            NativeBridgeProxy: class {
                async getSpeechKit() {
                    return {
                        available: async () => false
                    };
                }
            }
        }));
        await jest.unstable_mockModule('../../../renderer/components/slash-command.ts', () => ({
            getSlashCommands: jest.fn(() => []),
            filterSlashCommands: jest.fn(() => []),
            executeSlashCommand,
            refreshPluginSlashCommands: jest.fn(async () => {})
        }));

        await import('../../../renderer/components/agentinput.js');
        AgentInput = window.customElements.get('agent-input');
        expect(AgentInput).toBeDefined();
    });

    beforeEach(() => {
        document.body.innerHTML = '';
    });

    function createInput() {
        const input = new AgentInput();
        input.availableModels = [{ alias: 'deepseek', model_name: 'DeepSeek' }];
        input.availableModes = [
            { id: 'standard', name: '标准' },
            { id: 'plan', name: '规划' }
        ];
        input.availableNodes = [{ id: 'local', label: 'Local' }];
        input.selectedModel = 'deepseek';
        input.selectedModeId = 'standard';
        input.selectedExecutionNodeLabel = 'Local';
        input.visionMap = {};
        input.defaultModelAlias = 'deepseek';
        input.render();
        return input;
    }

    test('宽度不足时不再隐藏工具栏项，全部按钮保持可点击', () => {
        const input = createInput();
        const toolbar = input.querySelector('.agent-input-toolbar-left') as HTMLElement;
        const items = Array.from(toolbar.querySelectorAll('.agent-input-toolbar-item'));
        expect(items.length).toBeGreaterThan(0);
        for (const item of items) {
            expect((item as HTMLElement).style.display).not.toBe('none');
        }
    });

    test('工具栏溢出时鼠标滚轮纵向滚动会转换为横向滚动', () => {
        const input = createInput();
        const toolbar = input.querySelector('.agent-input-toolbar-left') as HTMLElement;
        Object.defineProperty(toolbar, 'scrollWidth', { configurable: true, value: 300 });
        Object.defineProperty(toolbar, 'clientWidth', { configurable: true, value: 120 });
        toolbar.scrollLeft = 0;

        const wheel = new window.Event('wheel', { cancelable: true, bubbles: true });
        Object.defineProperty(wheel, 'deltaY', { value: 80 });
        Object.defineProperty(wheel, 'deltaX', { value: 0 });
        toolbar.dispatchEvent(wheel);

        expect(toolbar.scrollLeft).toBe(80);
    });
});
