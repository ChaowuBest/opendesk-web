import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

const showConfirmModal = jest.fn(async () => true);
const executeSlashCommand = jest.fn();

describe('agent-input model button sync', () => {
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
    });

    beforeEach(() => {
        showConfirmModal.mockClear();
        executeSlashCommand.mockReset();
        document.body.innerHTML = '';
    });

    test('setModel updates the model button label in the DOM', () => {
        const input = document.createElement('agent-input') as HTMLElement & {
            availableModels: { alias: string; model_name: string }[];
            selectedModel: string;
            visionMap: Record<string, boolean>;
            defaultModelAlias: string;
            render: () => void;
            setModel: (alias: string) => void;
        };

        // Set up two models
        input.availableModels = [
            { alias: 'deepseek', model_name: 'DeepSeek' },
            { alias: 'glm', model_name: 'GLM' }
        ];
        input.visionMap = {};
        input.defaultModelAlias = 'deepseek';
        input.selectedModel = 'deepseek';

        // Render: button should show "deepseek"
        input.render();
        let labelSpan = input.querySelector('#agent-input-model-btn > span:last-child');
        expect(labelSpan?.textContent).toBe('deepseek');

        // Simulate task switch: setModel('glm') without full re-render
        input.setModel('glm');

        // Button label should now show "glm" — not stale "deepseek"
        labelSpan = input.querySelector('#agent-input-model-btn > span:last-child');
        expect(labelSpan?.textContent).toBe('glm');
    });

    test('setModel updates the model button even when button was not previously rendered', () => {
        const input = document.createElement('agent-input') as HTMLElement & {
            availableModels: { alias: string; model_name: string }[];
            selectedModel: string;
            visionMap: Record<string, boolean>;
            defaultModelAlias: string;
            setModel: (alias: string) => void;
            render: () => void;
        };

        input.availableModels = [
            { alias: 'deepseek', model_name: 'DeepSeek' },
            { alias: 'glm', model_name: 'GLM' }
        ];
        input.visionMap = {};
        input.defaultModelAlias = 'deepseek';

        // Call setModel before any render — should not throw
        expect(() => input.setModel('glm')).not.toThrow();
        expect(input.selectedModel).toBe('glm');
    });
});
