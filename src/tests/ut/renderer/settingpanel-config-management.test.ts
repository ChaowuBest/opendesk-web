import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

describe('setting-panel config management', () => {
    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
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

        await import('../../../renderer/components/settingpanel.js');
    });

    beforeEach(() => {
        document.body.innerHTML = '';
        delete window.showSaveFilePicker;
        window.notificationAPI = {
            sendNotification: jest.fn(async () => undefined)
        };
    });

    function createPanel() {
        const panel = document.createElement('setting-panel') as any;
        panel.currentData = {
            locale: 'zh-CN',
            resolved_locale: 'zh-CN',
            gui_config: {},
            debug: {},
            environ: { OLD_ENV: 'old-value' },
            applications: {},
            providers: [],
            models: []
        };
        panel.gatewayHostOptions = [
            { value: 'none', label: '无（关闭监听服务）' },
            { value: '127.0.0.1', label: '127.0.0.1（仅本机）' }
        ];
        return panel;
    }

    test('renders config management directly after environment variables', () => {
        const panel = createPanel();
        panel.innerHTML = panel.renderGeneralSection();

        const sectionTitles = Array.from(panel.querySelectorAll('section'))
            .map((section: Element) => section.querySelector('h2')?.textContent?.trim())
            .filter(Boolean);
        const environIndex = sectionTitles.findIndex((t: string) => t.includes('环境变量'));

        expect(environIndex).toBeGreaterThanOrEqual(0);
        expect(sectionTitles[environIndex + 1]).toContain('配置管理');
        expect(panel.querySelector('#export-config-json-btn')?.textContent).toContain('导出配置(JSON)');
        expect(panel.querySelector('#import-config-json-btn')?.textContent).toContain('导入配置(JSON)');
        expect(panel.querySelector('#export-config-quickpass-btn')?.textContent).toContain('导出配置(口令)');
        expect(panel.querySelector('#import-config-quickpass-btn')?.textContent).toContain('导入配置(口令)');
        expect(panel.querySelector('#import-quickpass-btn')).toBeNull();
        expect(panel.querySelector('#export-quickpass-btn')).toBeNull();
    });

    test('renders unified telemetry endpoints and saves a Langfuse endpoint', async () => {
        const panel = createPanel();
        panel.currentData.telemetry = {
            opentelemetry: {
                endpoints: [
                    {
                        name: 'local',
                        url: 'http://localhost:4318/v1/traces',
                        protocol: 'opentelemetry',
                        enabled: true
                    }
                ]
            },
            langfuse: {
                endpoints: [],
                environment: 'development',
                max_payload_chars: 20_000
            }
        };
        panel.innerHTML = panel.renderTelemetrySection();
        panel.insertAdjacentHTML(
            'beforeend',
            '<div id="modal-overlay" class="hidden"><div id="modal-container" class="hidden"><div id="modal-content"></div></div></div>'
        );
        panel.saveImmediately = jest.fn(async () => undefined);
        panel.refreshTelemetrySection = jest.fn();
        panel._bindTelemetryEvents();

        expect(panel.querySelectorAll('.sp-card')).toHaveLength(1);
        expect(panel.querySelector('.sp-card')?.textContent).toContain('OpenTelemetry');
        expect(panel.querySelector('#telemetry-list')).not.toBeNull();

        panel.showTelemetryEditModal(-1, 'langfuse');
        expect((panel.querySelector('#telemetry-opentelemetry-fields') as HTMLElement).style.display).toBe('none');
        expect((panel.querySelector('#telemetry-langfuse-fields') as HTMLElement).style.display).toBe('');
        (panel.querySelector('#telemetry-name-input') as HTMLInputElement).value = 'internal';
        (panel.querySelector('#telemetry-langfuse-base-url-input') as HTMLInputElement).value =
            'https://langfuse.example.com';
        (panel.querySelector('#telemetry-langfuse-public-key-input') as HTMLInputElement).value = 'pk-test';
        (panel.querySelector('#telemetry-langfuse-secret-key-input') as HTMLInputElement).value = 'sk-test';
        panel.querySelector('#telemetry-modal-save')?.dispatchEvent(new Event('click'));
        await Promise.resolve();

        expect(panel.currentData.telemetry.langfuse).toMatchObject({
            environment: 'development',
            max_payload_chars: 20_000,
            endpoints: [
                expect.objectContaining({
                    name: 'internal',
                    protocol: 'langfuse',
                    enabled: true,
                    base_url: 'https://langfuse.example.com',
                    public_key: 'pk-test',
                    secret_key: 'sk-test',
                    export_mode: 'batched'
                })
            ]
        });
        expect(panel.saveImmediately).toHaveBeenCalledTimes(1);
    });

    test('binds config management buttons to json and quickpass actions', () => {
        const panel = createPanel();
        panel.innerHTML = panel.renderGeneralSection();
        panel.exportSettingJson = jest.fn(async () => undefined);
        panel.importSettingJson = jest.fn(async () => undefined);
        panel.showExportQuickPassModal = jest.fn();
        panel.showImportQuickPassModal = jest.fn();

        panel._bindConfigManagementEvents();
        panel.querySelector('#export-config-json-btn')?.dispatchEvent(new Event('click'));
        panel.querySelector('#import-config-json-btn')?.dispatchEvent(new Event('click'));
        panel.querySelector('#export-config-quickpass-btn')?.dispatchEvent(new Event('click'));
        panel.querySelector('#import-config-quickpass-btn')?.dispatchEvent(new Event('click'));

        expect(panel.exportSettingJson).toHaveBeenCalledTimes(1);
        expect(panel.importSettingJson).toHaveBeenCalledTimes(1);
        expect(panel.showExportQuickPassModal).toHaveBeenCalledTimes(1);
        expect(panel.showImportQuickPassModal).toHaveBeenCalledTimes(1);
    });

    test('renders model header add button without duplicate plus signs', () => {
        const panel = createPanel();
        panel.render();
        panel.showModelEditModal(-1);

        const addHeaderButton = panel.querySelector('#add-header-btn') as HTMLButtonElement;

        expect(addHeaderButton.querySelectorAll('.fa-plus')).toHaveLength(1);
        expect(addHeaderButton.textContent?.trim()).toBe('添加 Header');
        expect(addHeaderButton.textContent).not.toContain('+');
    });

    test('default vision model select only lists known vision-capable chat models', () => {
        const panel = createPanel();
        panel.currentData.models = [
            {
                alias: 'vision-model',
                model_name: 'gpt-4o',
                model_type: 'chat'
            },
            {
                alias: 'text-model',
                model_name: 'gpt-4',
                model_type: 'chat'
            },
            {
                alias: 'embedding-model',
                model_name: 'text-embedding-3-small',
                model_type: 'embedding'
            }
        ];
        panel.visionSupportMap = {
            'vision-model': true,
            'text-model': false
        };
        panel.innerHTML = panel.renderDefaultModelsSection();

        const options = Array.from(panel.querySelectorAll('#default-vision-model-select option')).map(
            (option: HTMLOptionElement) => option.value
        );
        expect(options).toEqual(['', 'vision-model']);
    });

    test.each(['1.5', '9007199254740992'])('rejects non-integer max output tokens %s', async (value) => {
        const panel = createPanel();
        panel.render();
        panel.showModelEditModal(-1);
        (panel.querySelector('#model-alias-input') as HTMLInputElement).value = 'my-model';
        (panel.querySelector('#model-name-input') as HTMLInputElement).value = 'gpt-4o';
        (panel.querySelector('#model-max-output-tokens-input') as HTMLInputElement).value = value;
        panel.saveImmediately = jest.fn(async () => undefined);

        await panel.saveModel();

        expect(window.notificationAPI.sendNotification).toHaveBeenCalledWith(
            'error',
            '系统设置',
            '最大补全长度必须为非负整数'
        );
        expect(panel.currentData.models).toHaveLength(0);
        expect(panel.saveImmediately).not.toHaveBeenCalled();
    });

    test('model edit modal renders a vision support dropdown with three options', () => {
        const panel = createPanel();
        panel.currentData.providers = [{ name: 'p1', base_url: 'https://example.com/v1', api_key: '' }];
        panel.currentData.models = [{ alias: 'm1', provider_name: 'p1', model_name: 'gpt-4o', model_type: 'chat' }];
        panel.render();
        panel.showModelEditModal(0);

        const select = panel.querySelector('#model-vision-input') as HTMLSelectElement;
        const options = Array.from(select.options).map((option: HTMLOptionElement) => option.value);

        expect(options).toEqual(['', 'true', 'false']);
        expect(select.value).toBe('');
    });

    test.each([
        ['true', true],
        ['false', false],
        ['', undefined]
    ])('saving model vision dropdown value "%s" persists %s', async (raw, expected) => {
        const panel = createPanel();
        panel.currentData.providers = [{ name: 'p1', base_url: 'https://example.com/v1', api_key: '' }];
        panel.currentData.models = [{ alias: 'm1', provider_name: 'p1', model_name: 'gpt-4o', model_type: 'chat' }];
        panel.render();
        panel.showModelEditModal(0);
        const select = panel.querySelector('#model-vision-input') as HTMLSelectElement;
        const target = Array.from(select.options).find((option) => option.value === raw) as HTMLOptionElement;
        if (target) {
            target.selected = true;
        }
        panel.closeModal = jest.fn();
        panel.refreshVisionSupport = jest.fn(async () => undefined);
        panel.refreshModelsSection = jest.fn();
        panel.refreshDefaultModelsSection = jest.fn();
        panel.scheduleSave = jest.fn();

        await panel.saveModel();

        expect((panel.currentData.models[0] as any).vision).toBe(expected);
        expect(panel.scheduleSave).toHaveBeenCalledTimes(1);
    });

    test('exports current settings as json and omits runtime locale field', async () => {
        const panel = createPanel();
        panel.innerHTML = panel.renderGeneralSection();
        (panel.querySelector('.environ-key') as HTMLInputElement).value = 'NEW_ENV';
        (panel.querySelector('.environ-value') as HTMLInputElement).value = 'new-value';

        const saveFile = jest.fn(async () => ({ canceled: false, filePath: '/tmp/setting.json' }));
        const writeTextFile = jest.fn(async () => true);
        window.fsAPI = { saveFile, writeTextFile };

        await panel.exportSettingJson();

        expect(saveFile).toHaveBeenCalledWith({
            defaultPath: 'setting.json',
            filters: [{ name: 'JSON 文件', extensions: ['json'] }]
        });
        expect(writeTextFile).toHaveBeenCalledTimes(1);
        const exported = JSON.parse(writeTextFile.mock.calls[0][1] as string);
        expect(exported.resolved_locale).toBeUndefined();
        expect(exported.environ).toEqual({ NEW_ENV: 'new-value' });
        expect(window.notificationAPI.sendNotification).toHaveBeenCalledWith(
            'info',
            '设置',
            '导出成功',
            '配置已导出为 JSON 文件'
        );
    });

    test('saving model converts k-format context length and max output tokens to integers', async () => {
        const panel = createPanel();
        panel.currentData.providers = [{ name: 'p1', base_url: 'https://example.com/v1', api_key: '' }];
        panel.render();
        panel.showModelEditModal(-1);
        (panel.querySelector('#model-alias-input') as HTMLInputElement).value = 'my-model';
        (panel.querySelector('#model-name-input') as HTMLInputElement).value = 'gpt-4o';
        (panel.querySelector('#model-context-length-input') as HTMLInputElement).value = '128k';
        (panel.querySelector('#model-max-output-tokens-input') as HTMLInputElement).value = '256K';
        panel.closeModal = jest.fn();
        panel.refreshVisionSupport = jest.fn(async () => undefined);
        panel.refreshModelsSection = jest.fn();
        panel.refreshDefaultModelsSection = jest.fn();
        panel.scheduleSave = jest.fn();

        await panel.saveModel();

        expect(panel.currentData.models[0]).toMatchObject({
            alias: 'my-model',
            context_length: 128000,
            max_output_tokens: 256000
        });
    });

    test('rejects invalid k-format context length', async () => {
        const panel = createPanel();
        panel.render();
        panel.showModelEditModal(-1);
        (panel.querySelector('#model-alias-input') as HTMLInputElement).value = 'my-model';
        (panel.querySelector('#model-name-input') as HTMLInputElement).value = 'gpt-4o';
        (panel.querySelector('#model-context-length-input') as HTMLInputElement).value = '12x';

        await panel.saveModel();

        expect(window.notificationAPI.sendNotification).toHaveBeenCalledWith(
            'error',
            '系统设置',
            '上下文长度必须为非负整数'
        );
        expect(panel.currentData.models).toHaveLength(0);
    });
});
