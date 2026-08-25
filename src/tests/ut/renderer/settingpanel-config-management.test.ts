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

    test('tests ACP agents through the main-world application API', async () => {
        const panel = createPanel();
        const profile = {
            id: '11111111-1111-4111-8111-111111111111',
            name: 'OpenDesk ACP',
            transport: {
                type: 'stdio',
                command: 'node',
                args: ['D:/OpenDesk/dist/cli/opendesk-debug', 'serve', '--mode', 'acp']
            }
        };
        panel.innerHTML = '<div id="acp-agent-test-result" hidden></div>';
        panel._readAcpAgentForm = jest.fn(() => profile);
        const call = jest.fn(async () => {
            throw new Error('worker acpmgr not found');
        });
        const callMainWorld = jest.fn(async () => ({ agentInfo: { name: 'OpenDesk' } }));
        window.applicationRegistryAPI = { call, callMainWorld };

        await panel._testAcpAgent(profile.id);

        expect(callMainWorld).toHaveBeenCalledWith('acpmgr', 'testAgent', profile);
        expect(call).not.toHaveBeenCalled();
        expect(panel.querySelector('#acp-agent-test-result')?.classList.contains('od-sp-verify-success')).toBe(true);
    });

    test('constrains long ACP command summaries without hiding card actions', () => {
        const panel = createPanel();
        const endpoint =
            'C:/Program Files/nodejs/node.exe --no-warnings D:/ai/oh-robot/tmp_patch/OpenDesk/dist/cli/opendesk serve --mode acp --config-directory C:/Users/85481/AppData/Roaming/opendesk';
        panel.currentData.applications = {
            acpmgr: {
                agents: [
                    {
                        name: 'OpenDesk ACP Server',
                        enabled: true,
                        dispatchable: true,
                        transport: {
                            type: 'stdio',
                            command: 'C:/Program Files/nodejs/node.exe',
                            args: [
                                '--no-warnings',
                                'D:/ai/oh-robot/tmp_patch/OpenDesk/dist/cli/opendesk',
                                'serve',
                                '--mode',
                                'acp',
                                '--config-directory',
                                'C:/Users/85481/AppData/Roaming/opendesk'
                            ]
                        }
                    }
                ]
            }
        };

        panel.innerHTML = panel.renderAcpAgentsSection();

        const summary = panel.querySelector('.sp-acp-agent-summary') as HTMLElement;
        expect(summary).not.toBeNull();
        expect(summary.title).toBe(endpoint);
        expect(panel.querySelector('.edit-acp-agent-btn')).not.toBeNull();
        expect(panel.querySelector('.delete-acp-agent-btn')).not.toBeNull();
    });

    test('shows and edits the execution host for a remote ACP agent', () => {
        const panel = createPanel();
        const profile = {
            id: '11111111-1111-4111-8111-111111111111',
            name: 'Remote ACP',
            enabled: true,
            transport: {
                type: 'streamableHttp',
                url: 'https://agent.example.com/acp',
                headers: {},
                cookies: 'include'
            },
            execution: {
                location: 'agent',
                workspace: { strategy: 'fixed', path: '/workspace/project', platform: 'posix' }
            },
            session: { configOptions: {}, mcpBindings: [] },
            reconnect: { enabled: true, maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 5000 }
        };
        panel.currentData.applications = { acpmgr: { agents: [profile] } };
        panel.innerHTML = panel.renderAcpAgentsSection();

        expect(panel.querySelector('.sp-acp-agent-card')?.textContent).toContain('Agent 主机');

        panel.showAcpAgentEditModal(0);
        expect((panel.querySelector('#acp-agent-execution-location') as HTMLSelectElement).value).toBe('agent');
        expect((panel.querySelector('#acp-agent-remote-cwd') as HTMLInputElement).value).toBe('/workspace/project');
        const next = panel._readAcpAgentForm(profile.id);
        expect(next.execution).toEqual(profile.execution);
    });

    test('discovers ACP session options and writes a selected model to the profile JSON', async () => {
        const panel = createPanel();
        const profile = {
            id: '11111111-1111-4111-8111-111111111111',
            name: 'OpenDesk ACP',
            session: { configOptions: {} },
            transport: { type: 'stdio', command: 'node', args: [] }
        };
        panel.innerHTML = `
            <textarea id="acp-agent-config-options">{}</textarea>
            <div id="acp-agent-discovered-config" hidden><div id="acp-agent-discovered-config-controls"></div></div>
            <div id="acp-agent-test-result" hidden></div>`;
        panel._readAcpAgentForm = jest.fn(() => profile);
        window.applicationRegistryAPI = {
            callMainWorld: jest.fn(async () => ({
                agentInfo: { name: 'OpenCode' },
                configOptions: [
                    {
                        id: 'model',
                        name: 'Model',
                        type: 'select',
                        category: 'model',
                        currentValue: 'opencode/big-pickle',
                        options: [
                            { value: 'opencode/big-pickle', name: 'Big Pickle' },
                            { value: 'opencode/deepseek-v4-flash-free', name: 'DeepSeek Free' }
                        ]
                    }
                ],
                authMethods: [{ id: 'login', name: 'Login', description: 'Run login in a terminal' }]
            }))
        };

        await panel._testAcpAgent(profile.id);

        const select = panel.querySelector('[data-acp-config-option-id="model"]') as HTMLSelectElement;
        expect(select).not.toBeNull();
        Object.defineProperty(select, 'value', {
            configurable: true,
            value: 'opencode/deepseek-v4-flash-free'
        });
        select.dispatchEvent(new Event('change'));
        expect(JSON.parse((panel.querySelector('#acp-agent-config-options') as HTMLTextAreaElement).value)).toEqual({
            model: 'opencode/deepseek-v4-flash-free'
        });
        expect(panel.querySelector('#acp-agent-test-result')?.textContent).toContain('OpenCode');
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

        // 校验失败不再弹 notification，而是在输入框下方红字提示
        expect(window.notificationAPI.sendNotification).not.toHaveBeenCalled();
        const group = panel.querySelector('#model-max-output-tokens-input')?.closest('.od-sp-fg');
        expect(group?.querySelector('.od-sp-field-error')?.textContent).toBe('最大补全长度必须为非负整数');
        expect(panel.querySelector('#model-max-output-tokens-input')?.classList.contains('od-sp-fi-error')).toBe(true);
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

    test('saving model stores the timeout in seconds and omits it when empty', async () => {
        const panel = createPanel();
        panel.currentData.providers = [{ name: 'p1', base_url: 'https://example.com/v1', api_key: '' }];
        panel.render();
        panel.closeModal = jest.fn();
        panel.refreshVisionSupport = jest.fn(async () => undefined);
        panel.refreshModelsSection = jest.fn();
        panel.refreshDefaultModelsSection = jest.fn();
        panel.scheduleSave = jest.fn();

        panel.showModelEditModal(-1);
        (panel.querySelector('#model-alias-input') as HTMLInputElement).value = 'timeout-model';
        (panel.querySelector('#model-name-input') as HTMLInputElement).value = 'gpt-4o';
        (panel.querySelector('#model-timeout-input') as HTMLInputElement).value = '120';
        await panel.saveModel();

        panel.showModelEditModal(-1);
        (panel.querySelector('#model-alias-input') as HTMLInputElement).value = 'default-timeout-model';
        (panel.querySelector('#model-name-input') as HTMLInputElement).value = 'gpt-4o';
        (panel.querySelector('#model-timeout-input') as HTMLInputElement).value = '';
        await panel.saveModel();

        expect(panel.currentData.models[0].timeout).toBe(120);
        expect(panel.currentData.models[1].timeout).toBeUndefined();
    });

    test.each(['0', '-5', '1.5', '60s'])('rejects invalid timeout %s with an inline error', async (value) => {
        const panel = createPanel();
        panel.render();
        panel.showModelEditModal(-1);
        (panel.querySelector('#model-alias-input') as HTMLInputElement).value = 'timeout-model';
        (panel.querySelector('#model-name-input') as HTMLInputElement).value = 'gpt-4o';
        (panel.querySelector('#model-timeout-input') as HTMLInputElement).value = value;

        await panel.saveModel();

        expect(window.notificationAPI.sendNotification).not.toHaveBeenCalled();
        const group = panel.querySelector('#model-timeout-input')?.closest('.od-sp-fg');
        expect(group?.querySelector('.od-sp-field-error')?.textContent).toBe('请求超时必须为正整数（单位：秒）');
        expect(panel.currentData.models).toHaveLength(0);
    });

    test('rejects invalid k-format context length', async () => {
        const panel = createPanel();
        panel.render();
        panel.showModelEditModal(-1);
        (panel.querySelector('#model-alias-input') as HTMLInputElement).value = 'my-model';
        (panel.querySelector('#model-name-input') as HTMLInputElement).value = 'gpt-4o';
        (panel.querySelector('#model-context-length-input') as HTMLInputElement).value = '12x';

        await panel.saveModel();

        // 校验失败不再弹 notification，而是在输入框下方红字提示
        expect(window.notificationAPI.sendNotification).not.toHaveBeenCalled();
        const group = panel.querySelector('#model-context-length-input')?.closest('.od-sp-fg');
        expect(group?.querySelector('.od-sp-field-error')?.textContent).toBe('上下文长度必须为非负整数');
        expect(panel.querySelector('#model-context-length-input')?.classList.contains('od-sp-fi-error')).toBe(true);
        expect(panel.currentData.models).toHaveLength(0);
    });

    test('model alias required shows inline error instead of notification', async () => {
        const panel = createPanel();
        panel.render();
        panel.showModelEditModal(-1);

        await panel.saveModel();

        expect(window.notificationAPI.sendNotification).not.toHaveBeenCalled();
        const group = panel.querySelector('#model-alias-input')?.closest('.od-sp-fg');
        expect(group?.querySelector('.od-sp-field-error')?.textContent).toBe('请输入模型别名');
        expect(panel.querySelector('#model-alias-input')?.classList.contains('od-sp-fi-error')).toBe(true);
        expect(panel.currentData.models).toHaveLength(0);
    });

    test('verify and save requires provider selection with inline error', async () => {
        const panel = createPanel();
        panel.render();
        panel.showModelEditModal(-1);
        (panel.querySelector('#model-alias-input') as HTMLInputElement).value = 'my-model';
        (panel.querySelector('#model-name-input') as HTMLInputElement).value = 'gpt-4o';

        await panel.verifyAndSaveModel();

        expect(window.notificationAPI.sendNotification).not.toHaveBeenCalled();
        const group = panel.querySelector('#model-provider-input')?.closest('.od-sp-fg');
        expect(group?.querySelector('.od-sp-field-error')?.textContent).toBe('请选择提供方');
        expect(panel.querySelector('#model-provider-input')?.classList.contains('od-sp-fi-error')).toBe(true);
    });

    test('provider name required shows inline error instead of notification', () => {
        const panel = createPanel();
        panel.render();
        panel.showProviderEditModal(-1);

        panel.saveProvider();

        expect(window.notificationAPI.sendNotification).not.toHaveBeenCalled();
        const group = panel.querySelector('#provider-name-input')?.closest('.od-sp-fg');
        expect(group?.querySelector('.od-sp-field-error')?.textContent).toBe('请输入提供方名称');
        expect(panel.querySelector('#provider-name-input')?.classList.contains('od-sp-fi-error')).toBe(true);
    });

    test('telemetry endpoint url required shows inline error instead of notification', () => {
        const panel = createPanel();
        panel.render();
        panel.showTelemetryEditModal(-1, 'opentelemetry');

        panel.saveTelemetryEndpoint();

        expect(window.notificationAPI.sendNotification).not.toHaveBeenCalled();
        const group = panel.querySelector('#telemetry-url-input')?.closest('.od-sp-fg');
        expect(group?.querySelector('.od-sp-field-error')?.textContent).toBe('OpenTelemetry 端点 URL 不能为空。');
        expect(panel.querySelector('#telemetry-url-input')?.classList.contains('od-sp-fi-error')).toBe(true);
    });

    test('inline field error clears when user edits the input', async () => {
        const panel = createPanel();
        panel.render();
        panel.showModelEditModal(-1);
        (panel.querySelector('#model-name-input') as HTMLInputElement).value = 'gpt-4o';

        await panel.saveModel();
        expect(panel.querySelector('.od-sp-field-error')).not.toBeNull();

        const aliasInput = panel.querySelector('#model-alias-input') as HTMLInputElement;
        aliasInput.value = 'fixed-alias';
        aliasInput.dispatchEvent(new Event('input'));

        expect(panel.querySelector('.od-sp-field-error')).toBeNull();
        expect(aliasInput.classList.contains('od-sp-fi-error')).toBe(false);
    });

    test('saving valid model clears previous inline errors', async () => {
        const panel = createPanel();
        panel.currentData.providers = [{ name: 'p1', base_url: 'https://example.com/v1', api_key: '' }];
        panel.render();
        panel.showModelEditModal(-1);

        // 第一次保存触发 alias 必填错误
        await panel.saveModel();
        expect(panel.querySelector('.od-sp-field-error')).not.toBeNull();

        // 补全字段后再次保存应清除错误并成功
        (panel.querySelector('#model-alias-input') as HTMLInputElement).value = 'my-model';
        (panel.querySelector('#model-name-input') as HTMLInputElement).value = 'gpt-4o';
        panel.closeModal = jest.fn();
        panel.refreshVisionSupport = jest.fn(async () => undefined);
        panel.refreshModelsSection = jest.fn();
        panel.refreshDefaultModelsSection = jest.fn();
        panel.scheduleSave = jest.fn();

        await panel.saveModel();

        expect(panel.querySelector('.od-sp-field-error')).toBeNull();
        expect(panel.currentData.models).toHaveLength(1);
        expect(panel.scheduleSave).toHaveBeenCalledTimes(1);
    });
});
