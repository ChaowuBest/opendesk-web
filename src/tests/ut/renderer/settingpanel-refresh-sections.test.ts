import { beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { createRendererTranslator } from '../../../renderer/locale.ts';

// 回归背景：#tab-models 内的第一个 section 是条件渲染的"软件更新"区块
// （renderUpdateSection 在 updateState.status === 'unsupported' 时返回空字符串），
// 局部刷新函数如果按固定索引取 section，就会在软件更新区块存在时替换错目标，
// 导致页面上出现两组"模型提供方"/"模型列表"/"默认模型"。

describe('setting-panel tab-models section refresh', () => {
    let window: any;
    let document: any;

    beforeAll(async () => {
        const parsed = parseHTML('<!doctype html><html><body></body></html>');
        window = parsed.window;
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            CustomEvent: window.CustomEvent,
            Event: window.Event,
            customElements: window.customElements,
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

        // linkedom 的 HTMLSelectElement.value 只有 getter，补一个可写实现，
        // 避免刷新默认模型区块时 updateDefaultModelSelects 赋值抛错
        const selectProto = (window.HTMLSelectElement as any).prototype;
        if (selectProto && !Object.getOwnPropertyDescriptor(selectProto, 'value')?.set) {
            Object.defineProperty(selectProto, 'value', {
                get() {
                    return this._value ?? '';
                },
                set(v) {
                    this._value = v;
                },
                configurable: true
            });
        }

        await import('../../../renderer/components/settingpanel.js');
    });

    beforeEach(() => {
        document = window.document;
        document.body.innerHTML = '';
    });

    function createPanel(updateState: any) {
        const panel = document.createElement('setting-panel') as any;
        panel.currentData = {
            locale: 'zh-CN',
            resolved_locale: 'zh-CN',
            gui_config: {},
            providers: [
                {
                    name: 'openai',
                    provider_type: 'openai',
                    base_url: 'https://api.openai.com/v1',
                    api_key: 'sk-test'
                }
            ],
            models: [
                {
                    alias: 'gpt',
                    provider_name: 'openai',
                    model_name: 'gpt-4',
                    model_type: 'chat'
                }
            ]
        };
        panel.appVersion = '0.3.7';
        panel.updateState = updateState;
        panel._t = createRendererTranslator(panel.currentData);
        return panel;
    }

    // 与主渲染 render() 中 #tab-models 的结构保持一致
    function renderTabModels(panel: any) {
        panel.innerHTML = `
            <div id="tab-models" class="space-y-5">
                ${panel.renderUpdateSection()}
                ${panel.renderProvidersSection()}
                ${panel.renderModelsSection()}
                ${panel.renderDefaultModelsSection()}
            </div>`;
    }

    function countSections(panel: any, titleText: string): number {
        return Array.from(panel.querySelectorAll('#tab-models h2.sp-section-title')).filter((h: any) =>
            (h.textContent || '').includes(titleText)
        ).length;
    }

    test('refreshProvidersSection keeps a single providers section when the update section exists', () => {
        const panel = createPanel({ status: 'idle' });
        renderTabModels(panel);
        expect(panel.querySelector('#software-update-section')).toBeTruthy();
        expect(countSections(panel, '模型提供方')).toBe(1);

        panel.refreshProvidersSection();

        expect(countSections(panel, '模型提供方')).toBe(1);
        expect(panel.querySelector('#software-update-section')).toBeTruthy();
    });

    test('refreshModelsSection keeps a single models section when the update section exists', () => {
        const panel = createPanel({ status: 'idle' });
        renderTabModels(panel);

        panel.refreshModelsSection();

        expect(countSections(panel, '模型提供方')).toBe(1);
        expect(countSections(panel, '模型配置')).toBe(1);
    });

    test('refreshDefaultModelsSection keeps a single default-models section when the update section exists', () => {
        const panel = createPanel({ status: 'idle' });
        renderTabModels(panel);

        panel.refreshDefaultModelsSection();

        expect(countSections(panel, '默认模型')).toBe(1);
        expect(countSections(panel, '模型配置')).toBe(1);
    });

    test('refresh functions still work without the update section (unsupported)', () => {
        const panel = createPanel({ status: 'unsupported' });
        renderTabModels(panel);
        expect(panel.querySelector('#software-update-section')).toBeNull();

        panel.refreshProvidersSection();
        panel.refreshModelsSection();
        panel.refreshDefaultModelsSection();

        expect(countSections(panel, '模型提供方')).toBe(1);
        expect(countSections(panel, '模型配置')).toBe(1);
        expect(countSections(panel, '默认模型')).toBe(1);
    });

    test('no duplicated sections after the update section is inserted at runtime', () => {
        // 初始渲染时 updateState 为 unsupported（无软件更新区块），
        // 之后 onStateChanged 推送新状态，refreshUpdateSection 会把区块插到 tab-models 开头
        const panel = createPanel({ status: 'unsupported' });
        renderTabModels(panel);

        panel.updateState = { status: 'idle' };
        panel.refreshUpdateSection();
        expect(panel.querySelector('#software-update-section')).toBeTruthy();

        panel.refreshProvidersSection();

        expect(countSections(panel, '模型提供方')).toBe(1);
        expect(panel.querySelector('#software-update-section')).toBeTruthy();
    });
});
