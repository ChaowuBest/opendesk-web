import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

/**
 * 回归测试：AgentInput 启动时必须先加载模型列表，再加载各模型支持的推理档位映射。
 *
 * 修复前的 bug：connectedCallback 中 loadReasoningEffortSupport() 与 loadSettings()
 * 并发执行，前者检查 availableModels 时列表尚未填充而提前退出，导致 modelEffortsMap
 * 始终为空，主页模型菜单里能选择到模型不支持的全部推理档位；
 * 只有后续触发 onSettingChanged（例如先选一次推理档位）才会重新加载映射。
 */
describe('AgentInput reasoning effort support loading', () => {
    let AgentInput: any;
    let checkReasoningEfforts: jest.Mock;

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            CustomEvent: window.CustomEvent,
            customElements: window.customElements,
            Node: window.Node,
            MutationObserver: window.MutationObserver
        });
        Object.defineProperty(globalThis, 'navigator', {
            value: { languages: ['zh-CN'], language: 'zh-CN' },
            configurable: true
        });
        (globalThis as any).ResizeObserver = class {
            observe() {}
            unobserve() {}
            disconnect() {}
        };

        // 模拟 Chromium 行为：以 `>` 开头的相对选择器在 querySelector 中抛 SyntaxError
        // （真实 Chromium 中 `el.querySelector('> span')` 会抛错，linkedom 则静默返回 null）
        const origQuerySelector = window.Element.prototype.querySelector;
        window.Element.prototype.querySelector = function (this: Element, selectors: string) {
            if (typeof selectors === 'string' && selectors.startsWith('>')) {
                throw new window.DOMException(
                    `Failed to execute 'querySelector' on 'Element': '${selectors}' is not a valid selector.`,
                    'SyntaxError'
                );
            }
            return origQuerySelector.call(this, selectors);
        };

        checkReasoningEfforts = jest.fn(async (models: Array<{ alias: string; model_name: string }>) => {
            const result: Record<string, string[]> = {};
            for (const m of models) {
                // gpt-5 在 model-context 中限制为 none/low/medium/high（无 max）
                if (m.model_name === 'gpt-5') {
                    result[m.alias] = ['', 'none', 'low', 'medium', 'high'];
                }
            }
            return result;
        });

        window.settingAPI = {
            loadSettingObject: jest.fn(async () => ({
                models: [
                    {
                        alias: 'gpt5',
                        provider_name: 'p',
                        model_name: 'gpt-5',
                        model_type: 'chat',
                        reasoning_effort: ''
                    },
                    {
                        alias: 'deepseek',
                        provider_name: 'p',
                        model_name: 'deepseek-chat',
                        model_type: 'chat',
                        reasoning_effort: ''
                    }
                ],
                default_model: 'gpt5',
                gui_config: {}
            })),
            checkVisionSupport: jest.fn(async () => ({})),
            checkReasoningEfforts
        };

        await jest.unstable_mockModule('../../../renderer/components/imageLightbox.js', () => ({
            showImageLightbox: jest.fn()
        }));

        await import('../../../renderer/components/agentinput.js');
        AgentInput = window.customElements.get('agent-input');
        expect(AgentInput).toBeDefined();
    });

    test('loadSettings 之后推理档位映射已就绪，菜单只显示模型支持的档位', async () => {
        const input = new AgentInput();
        await input.loadSettings();

        // 修复点：启动路径（loadSettings）必须加载推理档位映射
        expect(checkReasoningEfforts).toHaveBeenCalled();

        // gpt-5 仅支持 none/low/medium/high，不含 max
        expect(input.modelEffortsMap.gpt5).toEqual(['', 'none', 'low', 'medium', 'high']);
        expect(input.getSupportedEffortValues('gpt5')).toEqual(['', 'none', 'low', 'medium', 'high']);
        expect(input.getSupportedEffortValues('gpt5')).not.toContain('max');

        // 未匹配 model-context 的模型回退到系统全部档位
        expect(input.getSupportedEffortValues('deepseek')).toEqual(['', 'none', 'low', 'medium', 'high', 'max']);
        // 未知模型同样回退系统全部档位
        expect(input.getSupportedEffortValues('not-exist')).toEqual(['', 'none', 'low', 'medium', 'high', 'max']);
    });

    test('并发加载场景下 map 为空时仍回退到系统全部档位（不崩溃）', async () => {
        const input = new AgentInput();
        // 模拟映射尚未加载完成（并发早期）
        input.availableModels = [{ alias: 'gpt5', provider_name: 'p', model_name: 'gpt-5', model_type: 'chat' }];
        input.modelEffortsMap = {};

        expect(input.getSupportedEffortValues('gpt5')).toEqual(['', 'none', 'low', 'medium', 'high', 'max']);
    });

    test('选中非默认推理档位后，模型按钮能插入推理档位图标（Chromium 选择器兼容）', async () => {
        const input = new AgentInput();
        input.selectedModel = 'gpt5';
        input.selectedReasoningEffort = '';
        input.availableModels = [{ alias: 'gpt5', provider_name: 'p', model_name: 'gpt-5', model_type: 'chat' }];
        input.render();
        // 初始为默认档位，按钮上无推理图标
        expect(input.querySelector('#agent-input-model-btn .agent-effort-icon')).toBeNull();

        // 选中非默认档位 low → _updateEffortIcon 必须能插入图标
        // （修复前使用裸的 `> span:last-child` 选择器，在真实 Chromium 中抛
        //   SyntaxError 导致图标永远无法插入）
        input.selectedReasoningEffort = 'low';
        expect(() => input._updateEffortIcon()).not.toThrow();
        const icon = input.querySelector('#agent-input-model-btn .agent-effort-icon');
        expect(icon).not.toBeNull();
        // low = 1 格绿色 + 3 格灰色
        expect((icon.innerHTML.match(/<rect/g) || []).length).toBe(4);
        expect((icon.innerHTML.match(/fill="#1F9D66"/g) || []).length).toBe(1);

        // 切换到 max 档位 → 4 格全绿
        input.selectedReasoningEffort = 'max';
        input._updateEffortIcon();
        const maxIcon = input.querySelector('#agent-input-model-btn .agent-effort-icon');
        expect(maxIcon).not.toBeNull();
        expect((maxIcon.innerHTML.match(/fill="#1F9D66"/g) || []).length).toBe(4);
    });
});
