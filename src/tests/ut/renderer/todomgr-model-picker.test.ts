import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

describe('automation task cascading model picker', () => {
    let WidgetClass: CustomElementConstructor;
    const widgets: any[] = [];

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><head></head><body></body></html>');
        Object.assign(window, { innerWidth: 1440, innerHeight: 900 });
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            Element: window.Element,
            HTMLInputElement: window.HTMLInputElement,
            HTMLTextAreaElement: window.HTMLTextAreaElement,
            HTMLSelectElement: window.HTMLSelectElement,
            Event: window.Event,
            customElements: window.customElements,
            requestAnimationFrame: (callback: FrameRequestCallback) => {
                callback(0);
                return 0;
            },
            cancelAnimationFrame: () => undefined
        });
        jest.unstable_mockModule('../../../main/applications/widget_utils.js', () => ({
            AgentOperableHTMLElement: class extends window.HTMLElement {}
        }));
        jest.unstable_mockModule('../../../renderer/components/workspacePicker.js', () => ({
            showWorkspacePicker: jest.fn()
        }));
        await import('../../../main/applications/todomgr/renderer/entry.js');
        WidgetClass = window.customElements.get('todomgr-entry-widget')!;
    });

    beforeEach(() => {
        delete (window as any).applicationAPI;
        delete (window as any).settingAPI;
    });

    afterEach(() => {
        for (const widget of widgets.splice(0)) {
            widget.disconnectedCallback();
            widget.remove();
        }
        Object.assign(window, { innerWidth: 1440, innerHeight: 900 });
    });

    function widgetFor(model = 'deepseek', reasoningEffort = 'high'): any {
        const widget = new WidgetClass() as any;
        widget._applyLocaleSetting({ locale: 'zh-CN' });
        widget._chatModels = [
            {
                alias: 'deepseek',
                provider_name: 'DeepSeek',
                model_name: 'deepseek-chat',
                vision: false,
                reasoningEfforts: ['', 'none', 'low', 'high']
            },
            {
                alias: 'fast-model',
                provider_name: 'OpenAI',
                model_name: 'gpt-fast',
                vision: false,
                reasoningEfforts: ['', 'none', 'low']
            },
            {
                alias: 'all-efforts',
                provider_name: 'OpenAI',
                model_name: 'gpt-reasoning',
                vision: false,
                reasoningEfforts: ['', 'none', 'low', 'medium', 'high', 'max']
            }
        ];
        widget._defaultModelAlias = 'fast-model';
        const plan = { model, reasoningEffort };
        widget.innerHTML = `${widget._renderModelPicker(plan)}<button id="outside-picker">Outside</button>`;
        widget._bindModelPicker(plan);
        widget.connectedCallback = () => undefined;
        document.body.append(widget);
        widgets.push(widget);
        return widget;
    }

    function element(widget: any, selector: string): any {
        const found = widget.querySelector(selector);
        expect(found).not.toBeNull();
        return found;
    }

    function open(widget: any) {
        element(widget, '#tm-edit-model-trigger').click();
        expect(element(widget, '#tm-edit-model-popover').hidden).toBe(false);
    }

    function preview(widget: any, alias: string, event = 'mouseenter') {
        element(widget, `[data-model-alias="${alias}"]`).dispatchEvent(new Event(event));
    }

    function effortValues(widget: any): string[] {
        return Array.from(widget.querySelectorAll('#tm-edit-model-effort-list [data-effort-value]')).map(
            (option: any) => option.dataset.effortValue
        );
    }

    function visibleModelAliases(widget: any): string[] {
        return Array.from(widget.querySelectorAll('[data-model-alias]'))
            .filter((option: any) => !option.hidden)
            .map((option: any) => option.dataset.modelAlias);
    }

    function renderPicker(widget: any, model = '', reasoningEffort = '') {
        const plan = { model, reasoningEffort };
        widget.innerHTML = `${widget._renderModelPicker(plan)}<button id="outside-picker">Outside</button>`;
        widget._bindModelPicker(plan);
    }

    test('one model catalog request provides default-model vision and supported efforts', async () => {
        const widget = widgetFor('', '');
        const catalog = {
            default_model: 'catalog-model',
            models: [
                {
                    alias: 'catalog-model',
                    provider_name: 'Catalog Provider',
                    model_name: 'catalog-reasoning',
                    vision: true,
                    reasoningEfforts: ['', 'low']
                }
            ]
        };
        const callMainWorld = jest.fn(async () => catalog);
        const loadSettingObject = jest.fn(async () => ({}));
        const checkReasoningEfforts = jest.fn(async () => ({}));
        const checkVisionSupport = jest.fn(async () => ({}));
        (window as any).applicationAPI = { callMainWorld };
        (window as any).settingAPI = { loadSettingObject, checkReasoningEfforts, checkVisionSupport };

        await widget._loadChatModels();
        renderPicker(widget);
        open(widget);
        preview(widget, '', 'click');

        expect(effortValues(widget)).toEqual(['', 'low']);
        expect(element(widget, '#tm-edit-model-summary .agent-icon-tile.model-vision')).not.toBeNull();
        expect(element(widget, '[data-model-alias="catalog-model"] .model-vision')).not.toBeNull();
        expect(callMainWorld).toHaveBeenCalledTimes(1);
        expect(callMainWorld).toHaveBeenCalledWith('getChatModelsForUI');
        expect(loadSettingObject).not.toHaveBeenCalled();
        expect(checkReasoningEfforts).not.toHaveBeenCalled();
        expect(checkVisionSupport).not.toHaveBeenCalled();
    });

    test('catalog failure clears stale models and never falls back to full settings or capability requests', async () => {
        const widget = widgetFor();
        widget._chatModels.find((model: any) => model.alias === 'fast-model').vision = true;
        const callMainWorld = jest.fn(async () => {
            throw new Error('Catalog unavailable');
        });
        const loadSettingObject = jest.fn(async () => ({
            default_model: 'fallback-model',
            models: [{ alias: 'fallback-model', provider_name: 'Fallback', model_name: 'fallback-chat' }]
        }));
        const checkReasoningEfforts = jest.fn(async () => ({}));
        const checkVisionSupport = jest.fn(async () => ({}));
        (window as any).applicationAPI = { callMainWorld };
        (window as any).settingAPI = { loadSettingObject, checkReasoningEfforts, checkVisionSupport };

        await widget._loadChatModels();
        renderPicker(widget);
        open(widget);

        expect(visibleModelAliases(widget)).toEqual(['']);
        expect(element(widget, '#tm-edit-model-summary .tm-model-trigger-name').textContent).toBe('全局默认模型');
        expect(widget._getModelDetail('')).toBe('当前未配置默认模型');
        expect(widget.querySelector('#tm-edit-model-summary .model-vision')).toBeNull();
        expect(callMainWorld).toHaveBeenCalledTimes(1);
        expect(loadSettingObject).not.toHaveBeenCalled();
        expect(checkReasoningEfforts).not.toHaveBeenCalled();
        expect(checkVisionSupport).not.toHaveBeenCalled();
    });

    test('search filters model aliases and underlying model names case-insensitively', () => {
        const widget = widgetFor();
        open(widget);
        const search = element(widget, 'input[type="search"], [role="searchbox"]');
        search.value = 'GPT-FAST';
        search.dispatchEvent(new Event('input', { bubbles: true }));

        expect(visibleModelAliases(widget).filter(Boolean)).toEqual(['fast-model']);

        search.value = '';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        expect(visibleModelAliases(widget)).toEqual(['', 'deepseek', 'fast-model', 'all-efforts']);
    });

    test('choosing an effort commits the previewed model and effort together and closes the menu', () => {
        const widget = widgetFor();
        open(widget);
        preview(widget, 'fast-model', 'click');
        element(widget, '#tm-edit-model-effort-list [data-effort-value="low"]').click();

        const picker = element(widget, '#tm-edit-model-picker');
        expect(picker.dataset.selectedModel).toBe('fast-model');
        expect(picker.dataset.selectedEffort).toBe('low');
        expect(element(widget, '#tm-edit-model-popover').hidden).toBe(true);
        expect(element(widget, '#tm-edit-model-trigger').getAttribute('aria-expanded')).toBe('false');
        expect(element(widget, '.tm-model-trigger-summary').textContent.trim()).toBe('fast-model');
        expect(element(widget, '.tm-model-trigger-summary .agent-effort-icon svg')).not.toBeNull();
        expect(widget.querySelector('#tm-edit-model-done')).toBeNull();
    });

    test('global default keeps an empty model alias and filters against the current default model', () => {
        const widget = widgetFor();
        open(widget);
        expect(element(widget, '[data-model-alias=""] .ctx-label').textContent).toBe('全局默认模型（fast-model）');
        preview(widget, '');
        expect(effortValues(widget)).toEqual(['', 'none', 'low']);
        element(widget, '#tm-edit-model-effort-list [data-effort-value=""]').click();

        const picker = element(widget, '#tm-edit-model-picker');
        expect(picker.dataset.selectedModel).toBe('');
        expect(picker.dataset.selectedEffort).toBe('');
        expect(element(widget, '#tm-edit-model-summary .tm-model-trigger-name').textContent).toBe(
            '全局默认模型（fast-model）'
        );
        expect(element(widget, '#tm-edit-model-popover').hidden).toBe(true);
    });
});
