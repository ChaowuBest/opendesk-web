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
        expect(widget._getModelDetail('')).toBe('当前未配置默认模型');
        expect(widget.querySelector('#tm-edit-model-summary .model-vision')).toBeNull();
        expect(callMainWorld).toHaveBeenCalledTimes(1);
        expect(loadSettingObject).not.toHaveBeenCalled();
        expect(checkReasoningEfforts).not.toHaveBeenCalled();
        expect(checkVisionSupport).not.toHaveBeenCalled();
    });

    test('loading reduced model capabilities preserves a saved unsupported max effort until selection changes', async () => {
        const widget = widgetFor('deepseek', 'max');
        (window as any).applicationAPI = {
            callMainWorld: jest.fn(async () => ({
                default_model: 'deepseek',
                models: [
                    {
                        alias: 'deepseek',
                        provider_name: 'DeepSeek',
                        model_name: 'deepseek-chat',
                        vision: false,
                        reasoningEfforts: ['', 'low']
                    }
                ]
            }))
        };

        await widget._loadChatModels();
        renderPicker(widget, 'deepseek', 'max');
        open(widget);
        preview(widget, 'deepseek', 'click');

        expect(effortValues(widget)).toEqual(['', 'low']);
        expect(element(widget, '#tm-edit-model-picker').dataset.selectedEffort).toBe('max');
        element(widget, '#outside-picker').click();
        expect(element(widget, '#tm-edit-model-picker').dataset.selectedEffort).toBe('max');
        expect(element(widget, '#tm-edit-model-summary .agent-effort-icon').title).toBe('推理最大化');
    });

    test.each(['deepseek', ''])('default effort only displays the model information for alias "%s"', (alias) => {
        const widget = widgetFor(alias, '');
        for (const model of widget._chatModels) model.vision = true;
        element(widget, '#tm-edit-model-summary').innerHTML = widget._renderModelSummary(alias, '');
        const summary = element(widget, '#tm-edit-model-summary');
        expect(summary.textContent.trim()).toBe(alias || '跟随全局默认模型');
        expect(summary.querySelector('.agent-effort-icon')).toBeNull();
        expect(summary.querySelectorAll('svg')).toHaveLength(1);
        expect(summary.querySelector('.agent-icon-tile.model-vision')).not.toBeNull();
    });

    test('switching to default effort removes its icon while explicit none keeps its own icon', () => {
        const widget = widgetFor();
        open(widget);
        preview(widget, 'deepseek', 'click');
        const defaultOption = element(widget, '#tm-edit-model-effort-list [data-effort-value=""]');
        expect(defaultOption.textContent).toContain('默认');
        expect(defaultOption.querySelector('svg')).not.toBeNull();
        defaultOption.click();

        const summary = element(widget, '#tm-edit-model-summary');
        expect(summary.textContent.trim()).toBe('deepseek');
        expect(summary.querySelector('.agent-effort-icon')).toBeNull();
        expect(summary.querySelectorAll('svg')).toHaveLength(1);
        expect(element(widget, '#tm-edit-model-picker').dataset.selectedEffort).toBe('');

        open(widget);
        preview(widget, 'deepseek', 'click');
        element(widget, '#tm-edit-model-effort-list [data-effort-value="none"]').click();
        expect(summary.textContent.trim()).toBe('deepseek');
        expect(summary.querySelector('.agent-effort-icon svg')).not.toBeNull();
        expect(summary.querySelectorAll('svg')).toHaveLength(2);
        expect(element(widget, '#tm-edit-model-picker').dataset.selectedEffort).toBe('none');
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

    test.each(['mouseenter', 'click', 'focus'])(
        '%s previews supported efforts without changing the saved model or effort',
        (event) => {
            const widget = widgetFor();
            open(widget);
            preview(widget, 'fast-model', event);

            expect(effortValues(widget)).toEqual(['', 'none', 'low']);
            const picker = element(widget, '#tm-edit-model-picker');
            expect(picker.dataset.selectedModel).toBe('deepseek');
            expect(picker.dataset.selectedEffort).toBe('high');
        }
    );

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
        preview(widget, '');
        expect(effortValues(widget)).toEqual(['', 'none', 'low']);
        element(widget, '#tm-edit-model-effort-list [data-effort-value=""]').click();

        const picker = element(widget, '#tm-edit-model-picker');
        expect(picker.dataset.selectedModel).toBe('');
        expect(picker.dataset.selectedEffort).toBe('');
        expect(element(widget, '.tm-model-trigger-summary').textContent).toContain('跟随全局默认');
        expect(element(widget, '#tm-edit-model-popover').hidden).toBe(true);
    });

    test('every supported effort is labeled and has the conversation picker effort icon', () => {
        const widget = widgetFor();
        open(widget);
        preview(widget, 'all-efforts');
        expect(effortValues(widget)).toEqual(['', 'none', 'low', 'medium', 'high', 'max']);

        for (const value of effortValues(widget)) {
            const option = element(widget, `#tm-edit-model-effort-list [data-effort-value="${value}"]`);
            expect(option.textContent.trim().length).toBeGreaterThan(0);
            expect(option.querySelector('svg')).not.toBeNull();
        }
    });

    test.each(['escape', 'outside'])('dismissing by %s cancels the model preview', (dismiss) => {
        const widget = widgetFor();
        open(widget);
        preview(widget, 'fast-model', 'click');
        if (dismiss === 'escape') {
            const event = new Event('keydown', { bubbles: true });
            Object.assign(event, { key: 'Escape' });
            element(widget, '#tm-edit-model-popover').dispatchEvent(event);
        } else {
            element(widget, '#outside-picker').click();
        }

        const picker = element(widget, '#tm-edit-model-picker');
        expect(picker.dataset.selectedModel).toBe('deepseek');
        expect(picker.dataset.selectedEffort).toBe('high');
        expect(element(widget, '#tm-edit-model-popover').hidden).toBe(true);
        expect(element(widget, '#tm-edit-model-trigger').getAttribute('aria-expanded')).toBe('false');
    });

    test('narrow screens open efforts only on click and allow returning before committing', () => {
        Object.assign(window, { innerWidth: 320, innerHeight: 740 });
        const widget = widgetFor();
        const menu = element(widget, '#tm-edit-model-popover');
        const submenu = element(widget, '#tm-edit-model-effort-submenu');
        jest.spyOn(element(widget, '#tm-edit-model-trigger'), 'getBoundingClientRect').mockReturnValue({
            x: 260,
            y: 120,
            left: 260,
            top: 120,
            right: 312,
            bottom: 160,
            width: 52,
            height: 40
        });
        jest.spyOn(menu, 'getBoundingClientRect').mockReturnValue({
            x: 8,
            y: 164,
            left: 8,
            top: 164,
            right: 288,
            bottom: 480,
            width: 280,
            height: 316
        });
        jest.spyOn(submenu, 'getBoundingClientRect').mockReturnValue({
            x: 8,
            y: 164,
            left: 8,
            top: 164,
            right: 288,
            bottom: 414,
            width: 280,
            height: 250
        });
        open(widget);
        const picker = element(widget, '#tm-edit-model-picker');
        for (const event of ['mouseenter', 'focus']) {
            preview(widget, 'fast-model', event);
            expect(menu.hidden).toBe(false);
            expect(submenu.hidden).toBe(true);
            expect(picker.dataset.selectedModel).toBe('deepseek');
            expect(picker.dataset.selectedEffort).toBe('high');
        }

        preview(widget, 'fast-model', 'click');
        expect(menu.hidden).toBe(true);
        expect(submenu.hidden).toBe(false);
        expect(element(widget, '#tm-edit-model-back').hidden).toBe(false);
        expect(picker.dataset.selectedModel).toBe('deepseek');
        expect(picker.dataset.selectedEffort).toBe('high');
        element(widget, '#tm-edit-model-back').click();
        expect(menu.hidden).toBe(false);
        expect(submenu.hidden).toBe(true);
        expect(picker.dataset.selectedModel).toBe('deepseek');
        expect(picker.dataset.selectedEffort).toBe('high');

        preview(widget, 'fast-model', 'click');
        element(widget, '#tm-edit-model-effort-list [data-effort-value="low"]').click();
        expect(picker.dataset.selectedModel).toBe('fast-model');
        expect(picker.dataset.selectedEffort).toBe('low');
        expect(menu.hidden).toBe(true);
        expect(submenu.hidden).toBe(true);
        expect(element(widget, '#tm-edit-model-trigger').getAttribute('aria-expanded')).toBe('false');
    });

    test.each([
        ['ArrowUp', -1],
        ['ArrowDown', 0]
    ])('the first %s from search focuses the expected model item', (key, index) => {
        const widget = widgetFor();
        open(widget);
        const items = Array.from(widget.querySelectorAll('[data-model-alias]')) as HTMLButtonElement[];
        const focus = items.map((item) => jest.spyOn(item, 'focus').mockImplementation(() => undefined));
        const event = new Event('keydown', { bubbles: true });
        Object.assign(event, { key });
        element(widget, '#tm-edit-model-search').dispatchEvent(event);

        const expectedIndex = index === -1 ? items.length - 1 : index;
        focus.forEach((spy, itemIndex) => {
            expect(spy).toHaveBeenCalledTimes(itemIndex === expectedIndex ? 1 : 0);
        });
    });

    test.each([
        ['commits the submenu selection', 'high', 'fast-model', 'low'],
        ['preserves a saved unsupported max effort', 'max', 'deepseek', 'max']
    ])('saving the editor %s', async (_description, savedEffort, expectedModel, expectedEffort) => {
        const widget = widgetFor();
        const plan = {
            id: 'model-plan',
            title: 'Morning report',
            content: 'Prepare the daily report',
            priority: 'medium',
            enabled: true,
            trigger: { type: 'cron', cronExpression: '0 9 * * *' },
            model: 'deepseek',
            reasoningEffort: savedEffort,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z'
        };
        const catalog = { models: widget._chatModels, default_model: widget._defaultModelAlias };
        const call = jest.fn(async (method: unknown) => (method === 'listGlobalTodos' ? [] : undefined));
        (window as any).applicationAPI = {
            call,
            callMainWorld: jest.fn(async (method: unknown) => (method === 'getChatModelsForUI' ? catalog : []))
        };
        (window as any).settingAPI = {
            checkReasoningEfforts: jest.fn(),
            checkVisionSupport: jest.fn()
        };
        widget._cachedEvents = [];
        widget.globalTodos = [plan];
        widget.render();
        widget._openDetail(plan);
        await widget._enterEditMode(plan);
        open(widget);
        preview(widget, 'fast-model', 'click');
        if (expectedModel === 'fast-model') {
            element(widget, '#tm-edit-model-effort-list [data-effort-value="low"]').click();
        } else {
            element(widget, '#tm-edit-model-trigger').click();
        }
        await widget._saveEdit(plan);

        expect(call).toHaveBeenCalledWith(
            'updateGlobalTodo',
            plan.id,
            expect.objectContaining({ model: expectedModel, reasoningEffort: expectedEffort, removeModel: false })
        );
        expect((window as any).settingAPI.checkReasoningEfforts).not.toHaveBeenCalled();
        expect((window as any).settingAPI.checkVisionSupport).not.toHaveBeenCalled();
    });
});
