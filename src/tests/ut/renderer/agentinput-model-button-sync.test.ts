import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { confirmModalMockShim } from '../../confirmModalMock.js';

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

        await jest.unstable_mockModule('../../../renderer/components/confirmModal.ts', () =>
            confirmModalMockShim({
                showConfirmModal
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

    /**
     * 回归测试：切换模型后模型按钮的视觉能力图标不跟着变。
     *
     * 修复前：模型面板点击推理档位只更新按钮文字和推理图标，不更新视觉图标；
     * _updateModelButton() 也只改 .agent-icon-tile 的样式类而不换 SVG 图形，
     * 导致从对话模型切到视觉模型后按钮仍显示对话气泡图标。
     */
    test('通过模型面板切换模型后，按钮的视觉能力图标同步更新', async () => {
        const input = document.createElement('agent-input') as HTMLElement & {
            availableModels: { alias: string; model_name: string }[];
            visionMap: Record<string, boolean>;
            defaultModelAlias: string;
            selectedModel: string;
            render: () => void;
            showEffortSubmenu: (alias: string, trigger: Element | null) => void;
        };

        input.availableModels = [
            { alias: 'deepseek', model_name: 'DeepSeek' },
            { alias: 'qwen-vl', model_name: 'Qwen-VL' }
        ];
        input.visionMap = { deepseek: false, 'qwen-vl': true };
        input.defaultModelAlias = 'deepseek';
        input.selectedModel = 'deepseek';
        input.render();

        expect(input.querySelector('#agent-input-model-btn .agent-icon-tile.model-chat')).not.toBeNull();

        // 面板中 hover 模型项展开推理档位子菜单，点击档位才真正切换模型
        input.showEffortSubmenu('qwen-vl', input.querySelector('[data-model-alias="qwen-vl"]'));
        (input.querySelector('#agent-input-effort-submenu-list [data-effort-value=""]') as HTMLElement).click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(input.selectedModel).toBe('qwen-vl');
        const tile = input.querySelector('#agent-input-model-btn .agent-icon-tile');
        expect(tile?.className).toContain('model-vision');
        // 图标图形也必须换掉（眼睛），而不是只改配色
        expect(tile?.innerHTML).toContain('<circle');
        expect(input.querySelector('#agent-input-model-btn > span:last-child')?.textContent).toBe('qwen-vl');
    });

    test('setModel 切换模型后刷新图标图形，双向都生效', () => {
        const input = document.createElement('agent-input') as HTMLElement & {
            availableModels: { alias: string; model_name: string }[];
            visionMap: Record<string, boolean>;
            defaultModelAlias: string;
            selectedModel: string;
            render: () => void;
            setModel: (alias: string) => void;
        };

        input.availableModels = [
            { alias: 'deepseek', model_name: 'DeepSeek' },
            { alias: 'qwen-vl', model_name: 'Qwen-VL' }
        ];
        input.visionMap = { deepseek: false, 'qwen-vl': true };
        input.defaultModelAlias = 'deepseek';
        input.selectedModel = 'deepseek';
        input.render();

        input.setModel('qwen-vl');
        let tile = input.querySelector('#agent-input-model-btn .agent-icon-tile');
        expect(tile?.className).toContain('model-vision');
        expect(tile?.innerHTML).toContain('<circle');

        input.setModel('deepseek');
        tile = input.querySelector('#agent-input-model-btn .agent-icon-tile');
        expect(tile?.className).toContain('model-chat');
        expect(tile?.innerHTML).not.toContain('<circle');
    });

    /**
     * 回归测试：模型 alias 会被拼进 innerHTML（按钮文本、面板项的 data-* 属性、档位子菜单）。
     * 修复前未转义，含引号/尖括号的别名会截断该属性并破坏 DOM 结构，
     * 使面板项与子菜单项拿不到正确的 data-model-alias，点击后切换模型失效。
     */
    test('模型 alias 含 HTML 特殊字符时不破坏按钮与面板 DOM', () => {
        const input = document.createElement('agent-input') as HTMLElement & {
            availableModels: { alias: string; model_name: string }[];
            visionMap: Record<string, boolean>;
            defaultModelAlias: string;
            selectedModel: string;
            render: () => void;
            renderModelList: (filter?: string) => void;
            showEffortSubmenu: (alias: string, trigger: Element | null) => void;
        };

        const alias = 'q"w<v>&x';
        input.availableModels = [{ alias, model_name: 'Qwen' }];
        input.visionMap = {};
        input.defaultModelAlias = alias;
        input.selectedModel = alias;
        input.render();

        expect(input.querySelector('#agent-input-model-btn')?.textContent?.trim()).toBe(alias);

        const item = input.querySelector('#agent-input-model-list .ctx-item') as HTMLElement | null;
        expect(item?.getAttribute('data-model-alias')).toBe(alias);
        expect(item?.querySelector('.ctx-label')?.textContent).toBe(alias);

        input.showEffortSubmenu(alias, item);
        const effortItem = input.querySelector('#agent-input-effort-submenu-list .ctx-item');
        expect(effortItem?.getAttribute('data-model-alias')).toBe(alias);

        // 搜索过滤会走 renderModelList 的另一条渲染分支，同样不能被别名破坏
        input.renderModelList('q');
        const filteredItem = input.querySelector('#agent-input-model-list .ctx-item');
        expect(filteredItem?.getAttribute('data-model-alias')).toBe(alias);
    });
});
