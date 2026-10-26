import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { confirmModalMockShim } from '../../confirmModalMock.js';

describe('agent-input builtin model merge', () => {
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

        await jest.unstable_mockModule('../../../renderer/components/confirmModal.ts', () =>
            confirmModalMockShim({
                showConfirmModal: jest.fn(async () => true)
            })
        );
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
            executeSlashCommand: jest.fn(),
            refreshPluginSlashCommands: jest.fn(async () => {})
        }));

        await import('../../../renderer/components/agentinput.js');
    });

    test('mergeBuiltinModels appends builtin models to configured models', async () => {
        const { mergeBuiltinModels } = await import('../../../renderer/components/agentinput.js');

        const settingObj = {
            models: [
                { alias: 'deepseek', model_name: 'DeepSeek', model_type: 'chat' },
                { alias: 'embed-1', model_name: 'Embed', model_type: 'embedding' }
            ],
            builtin_models: [
                {
                    alias: 'opendesk/auto',
                    provider_name: 'opendesk',
                    model_name: 'auto',
                    model_type: 'chat'
                }
            ]
        };

        const merged = mergeBuiltinModels(settingObj);
        expect(merged.map((m) => m.alias)).toEqual(['deepseek', 'opendesk/auto']);
    });

    test('mergeBuiltinModels tolerates missing fields', async () => {
        const { mergeBuiltinModels } = await import('../../../renderer/components/agentinput.js');

        expect(mergeBuiltinModels({})).toEqual([]);
        expect(mergeBuiltinModels({ models: [{ alias: 'a', model_type: 'chat' }] }).map((m) => m.alias)).toEqual(['a']);
        expect(
            mergeBuiltinModels({ builtin_models: [{ alias: 'b', model_type: 'chat' }] }).map((m) => m.alias)
        ).toEqual(['b']);
    });
});
