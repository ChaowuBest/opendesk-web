import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { createRendererTranslator } from '../../../renderer/locale.ts';

// 回归背景（历史 bug 1）：#tab-models 内的第一个 section 曾经是条件渲染的"软件更新"区块
// （renderUpdateSection 在 updateState.status === 'unsupported' 时返回空字符串），
// 局部刷新函数如果按固定索引取 section，就会在软件更新区块存在时替换错目标，
// 导致页面上出现两组"模型提供方"/"模型列表"/"默认模型"。
//
// 回归背景（历史 bug 2）：软件更新区块后来挪进了通用设置，而 refreshGeneralSection
// 曾按 "清空 #tab-general 里所有 section" 的方式重建内容，会把同一个 Tab 里的软件更新
// 区块一起删掉，自动更新入口直接消失。

describe('setting-panel section refresh', () => {
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
            applications: {},
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

    // 与主渲染 render() 中 #tab-models 的结构保持一致（软件更新区块不在这里）
    function renderTabModels(panel: any) {
        panel.innerHTML = `
            <div id="tab-models" class="space-y-5">
                ${panel.renderProvidersSection()}
                ${panel.renderModelsSection()}
                ${panel.renderDefaultModelsSection()}
            </div>`;
    }

    // 与主渲染 render() 中 #tab-general 的结构保持一致：软件更新区块是独立兄弟节点
    function renderTabGeneral(panel: any) {
        panel.innerHTML = `
            <div id="tab-general" class="space-y-5">
                ${panel.renderUpdateSection()}
                <div id="general-sections">${panel.renderGeneralSection()}</div>
            </div>`;
    }

    function countSections(root: any, titleText: string): number {
        return Array.from(root.querySelectorAll('h2.sp-section-title')).filter((h: any) =>
            (h.textContent || '').includes(titleText)
        ).length;
    }

    test('update section is not part of tab-models anymore', () => {
        const panel = createPanel({ status: 'idle' });
        renderTabModels(panel);

        expect(panel.querySelector('#tab-models #software-update-section')).toBeNull();
        expect(countSections(panel.querySelector('#tab-models'), '模型提供方')).toBe(1);
        expect(countSections(panel.querySelector('#tab-models'), '模型配置')).toBe(1);
    });

    test('refreshProvidersSection keeps a single providers section', () => {
        const panel = createPanel({ status: 'idle' });
        renderTabModels(panel);

        panel.refreshProvidersSection();

        expect(countSections(panel, '模型提供方')).toBe(1);
        // 模型配置/默认模型区块不受影响
        expect(countSections(panel, '模型配置')).toBe(1);
        expect(countSections(panel, '默认模型')).toBe(1);
    });

    test('refreshModelsSection keeps a single models section', () => {
        const panel = createPanel({ status: 'idle' });
        renderTabModels(panel);

        panel.refreshModelsSection();

        expect(countSections(panel, '模型提供方')).toBe(1);
        expect(countSections(panel, '模型配置')).toBe(1);
    });

    test('refreshDefaultModelsSection keeps a single default-models section', () => {
        const panel = createPanel({ status: 'idle' });
        renderTabModels(panel);

        panel.refreshDefaultModelsSection();

        expect(countSections(panel, '默认模型')).toBe(1);
        expect(countSections(panel, '模型配置')).toBe(1);
    });

    test('update section omitted when unsupported', () => {
        const panel = createPanel({ status: 'unsupported' });
        renderTabGeneral(panel);

        expect(panel.querySelector('#software-update-section')).toBeNull();
        expect(panel.querySelectorAll('#general-sections section').length).toBeGreaterThan(0);
    });

    test('refreshUpdateSection inserts the update section into the general tab only', () => {
        // 初始渲染时 updateState 为 unsupported（无软件更新区块），
        // 之后 onStateChanged 推送新状态，refreshUpdateSection 应该把它补到通用设置最前面
        const panel = createPanel({ status: 'unsupported' });
        renderTabModels(panel);
        const tabGeneral = document.createElement('div');
        tabGeneral.id = 'tab-general';
        tabGeneral.innerHTML = '<div id="general-sections"></div>';
        panel.appendChild(tabGeneral);

        panel.updateState = { status: 'idle' };
        panel.refreshUpdateSection();

        expect(panel.querySelector('#tab-general > #software-update-section')).toBeTruthy();
        expect(panel.querySelector('#tab-models #software-update-section')).toBeNull();
        // 只补一次，重复通知不会叠出第二个区块
        panel.refreshUpdateSection();
        expect(panel.querySelectorAll('#software-update-section')).toHaveLength(1);
    });

    test('refreshGeneralSection keeps the update section alive', () => {
        const panel = createPanel({ status: 'idle' });
        renderTabGeneral(panel);
        expect(panel.querySelector('#software-update-section')).toBeTruthy();

        panel.refreshGeneralSection();

        // 通用设置区块被重建，但同一个 Tab 里的软件更新区块必须还在
        expect(panel.querySelector('#software-update-section')).toBeTruthy();
        expect(panel.querySelectorAll('#software-update-section')).toHaveLength(1);
        expect(panel.querySelector('#general-sections h2.sp-section-title')).toBeTruthy();
    });

    test('default-models section omits the unsupported reranker model setting', () => {
        const panel = createPanel({ status: 'idle' });
        renderTabModels(panel);

        const section = panel.querySelector('#default-models-section');
        expect(section.textContent).not.toContain('重排序模型');
        expect(panel.querySelector('#default-reranker-model-select')).toBeNull();
        // 其余默认模型选择框仍保留
        expect(panel.querySelector('#default-model-select')).toBeTruthy();
        expect(panel.querySelector('#default-embedding-model-select')).toBeTruthy();
        expect(panel.querySelector('#default-vision-model-select')).toBeTruthy();
    });

    test('a model referenced only as default reranker can still be deleted', () => {
        // 默认模型页已无 reranker 选择器，若仍把该引用纳入删除保护，
        // 用户会陷入“删不掉、也没地方改”的死锁；引用应由主进程保存时清理。
        const panel = createPanel({ status: 'idle' });
        renderTabModels(panel);
        panel.scheduleSave = () => undefined;
        const sendNotification = jest.fn();
        window.notificationAPI = { sendNotification };
        panel.currentData.default_reranker_model = 'gpt';

        panel.deleteModel(0);

        expect(sendNotification).not.toHaveBeenCalled();
        expect(panel.currentData.models).toHaveLength(0);
    });

    test('a model referenced as a visible default model is still protected from deletion', () => {
        // 对照断言：删除保护本身仍然生效，避免上一条用例因为保护逻辑整体失效而恒真
        const panel = createPanel({ status: 'idle' });
        renderTabModels(panel);
        panel.scheduleSave = () => undefined;
        const sendNotification = jest.fn();
        window.notificationAPI = { sendNotification };
        panel.currentData.default_model = 'gpt';

        panel.deleteModel(0);

        expect(sendNotification).toHaveBeenCalledTimes(1);
        expect(panel.currentData.models).toHaveLength(1);
    });
});
