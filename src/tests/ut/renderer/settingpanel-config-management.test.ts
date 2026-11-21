import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { choose, mockModelAPI, settle } from './helpers/model-form.js';

/** 插件特性状态夹具：settings 面板按 telemetry 特性决定是否渲染遥测设置块 */
let featuresState = {
    disabledFeatures: [] as string[],
    disabledApplications: [] as string[],
    hiddenApplications: [] as string[],
    features: []
};
const featuresPushListeners = new Set<(state: unknown) => void>();

function pushFeatureState(): void {
    for (const listener of featuresPushListeners) listener(featuresState);
}

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
        window.featuresAPI = {
            getState: async () => featuresState,
            onChanged: (listener: (state: unknown) => void) => {
                featuresPushListeners.add(listener);
                return () => featuresPushListeners.delete(listener);
            }
        } as any;

        await import('../../../renderer/components/settingpanel.js');
    });

    beforeEach(async () => {
        document.body.innerHTML = '';
        delete window.showSaveFilePicker;
        window.settingAPI = mockModelAPI() as any;
        window.notificationAPI = {
            sendNotification: jest.fn(async () => undefined)
        };
        featuresState = { disabledFeatures: [], disabledApplications: [], hiddenApplications: [], features: [] };
        pushFeatureState();
        await settle();
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

    async function selectModel(panel: any) {
        const provider = panel.querySelector('#model-provider-input');
        choose(provider, Array.from(provider.options).find((option: any) => option.value)!.value);
        await settle();
        choose(panel.querySelector('#model-name-input'), 'gpt-4o');
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

    test('renders development and debugging after telemetry as the final general section', () => {
        const panel = createPanel();
        panel.innerHTML = panel.renderGeneralSection();

        const sections = Array.from(panel.children).filter((element: Element) => element.tagName === 'SECTION');
        const telemetryIndex = sections.findIndex((section: Element) => section.id === 'telemetry-section');
        const debugIndex = sections.findIndex((section: Element) => section.id === 'debug-mode-section');

        expect(telemetryIndex).toBeGreaterThanOrEqual(0);
        expect(debugIndex).toBe(telemetryIndex + 1);
        expect(debugIndex).toBe(sections.length - 1);
    });

    test('遥测特性被插件禁用时不渲染遥测设置块，恢复后按原位置插回', async () => {
        const panel = createPanel();
        panel.currentData.telemetry = {
            opentelemetry: { endpoints: [{ name: 'local', url: 'http://localhost:4318/v1/traces', enabled: true }] },
            langfuse: { endpoints: [], environment: 'development', max_payload_chars: 20_000 }
        };
        panel.innerHTML = panel.renderGeneralSection();
        expect(panel.querySelector('#telemetry-section')).not.toBeNull();

        // 插件启用 test-disable-telemetry 之类的门控：整块设置入口消失，用户无法再改端点
        featuresState = { ...featuresState, disabledFeatures: ['telemetry'] };
        pushFeatureState();
        await settle();
        panel.refreshTelemetrySection();
        expect(panel.querySelector('#telemetry-section')).toBeNull();
        expect(panel.querySelector('#telemetry-add-btn')).toBeNull();
        // 配置本身不动：数据仍在面板副本里
        expect(panel.currentData.telemetry.opentelemetry.endpoints).toHaveLength(1);

        // 插件停用后入口恢复，且仍排在「开发与调试」之前
        featuresState = { ...featuresState, disabledFeatures: [] };
        pushFeatureState();
        await settle();
        panel.refreshTelemetrySection();
        const telemetrySection = panel.querySelector('#telemetry-section');
        expect(telemetrySection).not.toBeNull();
        expect(telemetrySection?.nextElementSibling?.id).toBe('debug-mode-section');
    });

    test('renders development and debugging as a gated panel with independent experimental features', () => {
        const panel = createPanel();
        panel.currentData.debug = {
            developer_mode: true,
            debug_log: true,
            experimental_features: {
                applications: { appmgr: true, agentoffice: false },
                account: false,
                immersive_desktop: true
            }
        };
        panel.innerHTML = panel.renderDebugModeSection();

        expect(panel.querySelector('h2')?.textContent).toContain('开发与调试');
        expect(panel.querySelector('#debug-mode-settings')?.getAttribute('style')).toBe('');
        expect(panel.querySelector('#debug-mode-settings #debug-mode-toggle-hidden')).toBeNull();
        const experimentalSection = panel.querySelector('#experimental-features-section');
        expect(experimentalSection?.textContent).toContain('实验性功能');
        expect(experimentalSection?.querySelector('h4')).toBeNull();
        expect(experimentalSection?.getAttribute('style')).not.toContain('border-top');
        expect(panel.querySelector('#experimental-appmgr-toggle-hidden')?.hasAttribute('checked')).toBe(true);
        expect(panel.querySelector('#experimental-agentoffice-toggle-hidden')?.hasAttribute('checked')).toBe(false);
        expect(panel.querySelector('#experimental-account-toggle-hidden')?.hasAttribute('checked')).toBe(false);
        expect(panel.querySelector('#experimental-immersive-desktop-toggle-hidden')?.hasAttribute('checked')).toBe(
            true
        );
        expect(panel.querySelector('#experimental-agentgate-toggle-hidden')).toBeNull();
        expect(panel.querySelector('#experimental-feature-toggle-hidden')).toBeNull();

        panel.currentData.debug.developer_mode = false;
        panel.innerHTML = panel.renderDebugModeSection();
        expect((panel.querySelector('#debug-mode-settings') as HTMLElement).style.display).toBe('none');
    });

    test('stores experimental application switches by bundle name', () => {
        const panel = createPanel();
        panel.currentData.debug = {
            experimental_features: {
                applications: { appmgr: true, agentoffice: true },
                account: false
            }
        };
        panel.innerHTML = panel.renderDebugModeSection();
        panel.saveImmediately = jest.fn(async () => undefined);
        panel._bindDebugModeEvents();

        const toggle = panel.querySelector('#experimental-appmgr-toggle-hidden') as HTMLInputElement;
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change'));

        expect(panel.currentData.debug.experimental_features).toEqual({
            applications: { appmgr: false, agentoffice: true },
            account: false
        });
        expect(panel.saveImmediately).toHaveBeenCalled();
    });

    test('development and debugging master switch toggles the child panel', () => {
        const panel = createPanel();
        panel.currentData.debug = { developer_mode: false };
        panel.innerHTML = panel.renderDebugModeSection();
        panel.saveImmediately = jest.fn(async () => undefined);
        panel._bindDebugModeEvents();

        const toggle = panel.querySelector('#debug-mode-toggle-hidden') as HTMLInputElement;
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));

        expect(panel.currentData.debug.developer_mode).toBe(true);
        expect((panel.querySelector('#debug-mode-settings') as HTMLElement).style.display).toBe('');
        expect(panel.saveImmediately).toHaveBeenCalled();
    });

    test('uses canonical minimal and verbose output mode values without removing reasoning display', () => {
        const panel = createPanel();
        panel.innerHTML = panel.renderGeneralSection();

        const outputMode = panel.querySelector('#gui-output-mode-select');
        const values = Array.from(outputMode?.querySelectorAll('option') || []).map((option: Element) =>
            option.getAttribute('value')
        );

        expect(outputMode).not.toBeNull();
        expect(values).toEqual(['minimal', 'verbose']);
        expect(panel.querySelector('#gui-reason-display-select')).not.toBeNull();
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

    test('preserves stdio when selecting experimental ACP v2 in the Agent settings form', () => {
        const panel = createPanel();
        const profile = {
            id: '11111111-1111-4111-8111-111111111111',
            name: 'Local ACP v2',
            enabled: true,
            protocolVersion: 2,
            transport: {
                type: 'stdio',
                command: 'agent',
                args: [],
                cwd: 'workspace',
                env: {},
                inheritEnv: true
            },
            execution: {
                location: 'client',
                workspace: { strategy: 'task' },
                compatibility: 'required'
            },
            session: { configOptions: {}, mcpBindings: [] },
            reconnect: { enabled: true, maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 5000 }
        };
        panel.currentData.applications = { acpmgr: { agents: [profile] } };

        panel.showAcpAgentEditModal(0);

        const protocol = panel.querySelector('#acp-agent-protocol-version') as HTMLSelectElement;
        const transport = panel.querySelector('#acp-agent-transport') as HTMLSelectElement;
        Array.from(protocol.options).forEach((option) => (option.selected = option.value === '1'));
        protocol.dispatchEvent(new Event('change'));
        Array.from(protocol.options).forEach((option) => (option.selected = option.value === '2'));
        protocol.dispatchEvent(new Event('change'));

        expect(transport.value).toBe('stdio');
        expect(panel._readAcpAgentForm(profile.id).protocolVersion).toBe(2);
        expect(panel._readAcpAgentForm(profile.id).transport.type).toBe('stdio');
        expect(panel._readAcpAgentForm(profile.id).execution.agentSessionCwd).toBeUndefined();
    });

    test('distinguishes stdio launch cwd, session workspace, external MCP, and automatic MCP-over-ACP', () => {
        const panel = createPanel();
        const profile = {
            id: '11111111-1111-4111-8111-111111111111',
            name: 'Local ACP v2',
            enabled: true,
            protocolVersion: 2,
            transport: {
                type: 'stdio',
                command: 'agent',
                args: [],
                cwd: 'workspace',
                env: {},
                inheritEnv: true
            },
            execution: {
                location: 'client',
                workspace: { strategy: 'task' },
                compatibility: 'required'
            },
            session: { configOptions: {}, mcpBindings: [] },
            reconnect: { enabled: true, maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 5000 }
        };
        panel.currentData.applications = { acpmgr: { agents: [profile] } };

        panel.showAcpAgentEditModal(0);

        expect(panel.querySelector('#acp-agent-cwd')?.closest('.od-sp-fg')?.textContent).toContain(
            'Agent 进程启动目录'
        );
        expect(
            panel.querySelector('#acp-agent-client-workspace-strategy')?.closest('.od-sp-fg')?.textContent
        ).toContain('工作区');
        expect(
            panel.querySelector('#acp-agent-client-workspace-strategy')?.closest('.od-sp-fg')?.textContent
        ).not.toContain('Client 工作区');
        expect(panel.querySelector('#acp-agent-mcp-policy')?.closest('.od-sp-fg')?.textContent).toContain(
            '外部 MCP 策略'
        );
        expect((panel.querySelector('#acp-agent-mcp-policy') as HTMLSelectElement).value).toBe('none');
        expect((panel.querySelector('#acp-agent-custom-mcp-fields') as HTMLElement).hidden).toBe(true);
        expect(panel.querySelector('#acp-agent-v2-client-mcp-status')?.textContent).toContain(
            'MCP-over-ACP（自动提供）'
        );
    });

    test('keeps transport and execution independent and exposes friendly ACP runtime controls', () => {
        const panel = createPanel();
        const profile = {
            id: '11111111-1111-4111-8111-111111111111',
            name: 'Configured ACP',
            enabled: true,
            protocolVersion: 1,
            transport: {
                type: 'stdio',
                command: 'agent',
                args: [],
                cwd: 'workspace',
                env: {},
                inheritEnv: true
            },
            execution: { location: 'client', workspace: { strategy: 'task' }, compatibility: 'preferred' },
            session: {
                authMethodId: 'agent-login',
                mcpPolicy: 'custom',
                configOptions: {},
                mcpBindings: [{ serverId: 'filesystem', location: 'agent' }]
            },
            timeouts: { connectMs: 15000, promptMs: 600000 },
            reconnect: { enabled: true, maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 5000 }
        };
        panel.currentData.applications = {
            acpmgr: { agents: [profile] },
            mcpmgr: {
                servers: [
                    { id: 'filesystem', name: 'Filesystem', enabled: true },
                    { id: 'browser', name: 'Browser', enabled: true }
                ]
            }
        };

        panel.showAcpAgentEditModal(0);

        expect(panel.querySelector('#acp-agent-client-runtime-warning')?.textContent).toContain(
            'Client-hosted 运行模式依赖'
        );
        expect((panel.querySelector('#acp-agent-client-runtime-warning') as HTMLElement).hidden).toBe(false);
        expect((panel.querySelector('#acp-agent-auth-method') as HTMLSelectElement).value).toBe('agent-login');
        expect((panel.querySelector('#acp-agent-connect-timeout') as HTMLInputElement).value).toBe('15000');
        expect((panel.querySelector('#acp-agent-prompt-timeout') as HTMLInputElement).value).toBe('600000');
        const selectedMcp = panel.querySelector('[data-acp-mcp-server-id="filesystem"]') as HTMLInputElement;
        expect(selectedMcp.hasAttribute('checked')).toBe(true);
        expect(panel.querySelector('[data-acp-mcp-server-id="browser"]')?.hasAttribute('checked')).toBe(false);

        const transport = panel.querySelector('#acp-agent-transport') as HTMLSelectElement;
        Array.from(transport.options).forEach((option) => (option.selected = option.value === 'streamableHttp'));
        transport.dispatchEvent(new Event('change'));
        expect((panel.querySelector('#acp-agent-execution-location') as HTMLSelectElement).value).toBe('client');

        const executionLocation = panel.querySelector('#acp-agent-execution-location') as HTMLSelectElement;
        Object.defineProperty(executionLocation, 'value', { configurable: true, value: 'agent' });
        executionLocation.dispatchEvent(new Event('change'));
        expect((panel.querySelector('#acp-agent-client-runtime-warning') as HTMLElement).hidden).toBe(true);

        Object.defineProperty(executionLocation, 'value', { configurable: true, value: 'client' });
        executionLocation.dispatchEvent(new Event('change'));
        expect((panel.querySelector('#acp-agent-client-runtime-warning') as HTMLElement).hidden).toBe(false);

        Array.from(transport.options).forEach((option) => (option.selected = option.value === 'stdio'));
        const next = panel._readAcpAgentForm(profile.id);
        expect(next.session.authMethodId).toBe('agent-login');
        expect(next.session.mcpBindings).toEqual([{ serverId: 'filesystem', location: 'agent' }]);
        expect(next.session.mcpPolicy).toBe('custom');
        expect(next.timeouts).toEqual({ connectMs: 15000, promptMs: 600000 });
    });

    test('defaults external MCP forwarding to none and only shows server choices for custom policy', () => {
        const panel = createPanel();
        panel.currentData.applications = {
            acpmgr: { agents: [] },
            mcpmgr: { servers: [{ id: 'filesystem', name: 'Filesystem', enabled: true }] }
        };

        panel.showAcpAgentEditModal(-1);

        const policy = panel.querySelector('#acp-agent-mcp-policy') as HTMLSelectElement;
        const customFields = panel.querySelector('#acp-agent-custom-mcp-fields') as HTMLElement;
        expect(policy.value).toBe('none');
        expect(customFields.hidden).toBe(true);

        Array.from(policy.options).forEach((option) => (option.selected = option.value === 'enabled'));
        policy.dispatchEvent(new Event('change'));
        expect(customFields.hidden).toBe(true);

        Array.from(policy.options).forEach((option) => (option.selected = option.value === 'custom'));
        policy.dispatchEvent(new Event('change'));
        expect(customFields.hidden).toBe(false);
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
            <select id="acp-agent-auth-method"><option value="">None</option></select>
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
                authMethods: [
                    { id: 'login', type: 'agent', name: 'Login', description: 'Agent login' },
                    { id: 'terminal-login', type: 'terminal', name: 'Terminal login' }
                ]
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
        const authOptions = Array.from((panel.querySelector('#acp-agent-auth-method') as HTMLSelectElement).options);
        expect(authOptions.find((option) => option.value === 'login')?.hasAttribute('disabled')).toBe(false);
        expect(authOptions.find((option) => option.value === 'terminal-login')?.hasAttribute('disabled')).toBe(true);
    });

    test.each(['1.5', '9007199254740992'])('rejects non-integer max output tokens %s', async (value) => {
        const panel = createPanel();
        panel.render();
        panel.showModelEditModal(-1);
        (panel.querySelector('#model-alias-input') as HTMLInputElement).value = 'my-model';
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
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(panel.querySelector('#model-name-input').value).toBe('gpt-4o');
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
        await selectModel(panel);
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
        await selectModel(panel);
        (panel.querySelector('#model-timeout-input') as HTMLInputElement).value = '120';
        await panel.saveModel();

        panel.showModelEditModal(-1);
        (panel.querySelector('#model-alias-input') as HTMLInputElement).value = 'default-timeout-model';
        await selectModel(panel);
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

    test('provider name duplicate shows inline error instead of saving', () => {
        const panel = createPanel();
        panel.currentData.providers = [
            {
                name: 'openai',
                provider_type: 'openai',
                base_url: 'https://api.openai.com/v1',
                api_key: '',
                no_proxy: false,
                no_ssl: false
            },
            {
                name: 'anthropic',
                provider_type: 'anthropic',
                base_url: 'https://api.anthropic.com',
                api_key: '',
                no_proxy: false,
                no_ssl: false
            }
        ];
        panel.render();
        panel.showProviderEditModal(-1);
        (panel.querySelector('#provider-name-input') as HTMLInputElement).value = 'openai';

        panel.saveProvider();

        const group = panel.querySelector('#provider-name-input')?.closest('.od-sp-fg');
        expect(group?.querySelector('.od-sp-field-error')?.textContent).toBe('提供方名称已存在');
        expect(panel.querySelector('#provider-name-input')?.classList.contains('od-sp-fi-error')).toBe(true);
        expect(panel.currentData.providers).toHaveLength(2);
    });

    test('editing provider name to same value does not trigger duplicate error', () => {
        const panel = createPanel();
        panel.currentData.providers = [
            {
                name: 'openai',
                provider_type: 'openai',
                base_url: 'https://api.openai.com/v1',
                api_key: 'sk-1',
                no_proxy: false,
                no_ssl: false
            }
        ];
        panel.render();
        panel.showProviderEditModal(0);
        (panel.querySelector('#provider-name-input') as HTMLInputElement).value = 'openai';
        (panel.querySelector('#provider-url-input') as HTMLInputElement).value = 'https://api.openai.com/v1/new';
        panel.closeModal = jest.fn();
        panel.refreshProvidersSection = jest.fn();
        panel.scheduleSave = jest.fn();

        panel.saveProvider();

        expect(panel.querySelector('.od-sp-field-error')).toBeNull();
        expect(panel.currentData.providers[0].base_url).toBe('https://api.openai.com/v1/new');
        expect(panel.scheduleSave).toHaveBeenCalledTimes(1);
    });

    test('renaming provider updates provider_name in all associated models', () => {
        const panel = createPanel();
        panel.currentData.providers = [
            {
                name: 'openai',
                provider_type: 'openai',
                base_url: 'https://api.openai.com/v1',
                api_key: '',
                no_proxy: false,
                no_ssl: false
            }
        ];
        panel.currentData.models = [
            { alias: 'gpt4o', provider_name: 'openai', model_name: 'gpt-4o', model_type: 'chat' },
            { alias: 'embed3', provider_name: 'openai', model_name: 'text-embedding-3-small', model_type: 'embedding' },
            { alias: 'other', provider_name: 'deepseek', model_name: 'deepseek-chat', model_type: 'chat' }
        ];
        panel.render();
        panel.showProviderEditModal(0);
        (panel.querySelector('#provider-name-input') as HTMLInputElement).value = 'openai-pro';
        panel.closeModal = jest.fn();
        panel.refreshProvidersSection = jest.fn();
        panel.refreshModelsSection = jest.fn();
        panel.refreshDefaultModelsSection = jest.fn();
        panel.scheduleSave = jest.fn();

        panel.saveProvider();

        expect(panel.currentData.providers[0].name).toBe('openai-pro');
        expect(panel.currentData.models[0].provider_name).toBe('openai-pro');
        expect(panel.currentData.models[1].provider_name).toBe('openai-pro');
        expect(panel.currentData.models[2].provider_name).toBe('deepseek');
        expect(panel.refreshModelsSection).toHaveBeenCalledTimes(1);
        expect(panel.refreshDefaultModelsSection).toHaveBeenCalledTimes(1);
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
        await selectModel(panel);
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

    function panelForm(index = -1) {
        const panel = createPanel();
        panel.currentData.providers = [
            { name: 'a', base_url: 'https://a.test/v1', api_key: 'a-key' },
            { name: 'b', base_url: 'https://b.test/v1', api_key: 'b-key', provider_type: 'anthropic', no_ssl: true }
        ];
        panel.currentData.models = [{ alias: 'saved', model_name: 'saved-name', provider_name: 'a' }];
        panel.render();
        panel.showModelEditModal(index);
        return panel;
    }

    test('settings requires a provider and automatically loads models on provider changes', async () => {
        const panel = panelForm();
        const select = panel.querySelector('#model-name-input');
        expect(select.disabled).toBe(true);
        expect((window as any).settingAPI.fetchProviderModels).not.toHaveBeenCalled();
        choose(panel.querySelector('#model-provider-input'), 'a');
        await settle();
        expect(select.disabled).toBe(false);
        choose(select, 'gpt-4o-mini');
        await settle();
        expect((window as any).settingAPI.estimateMaxOutputTokens).toHaveBeenCalledWith('gpt-4o-mini');
        choose(panel.querySelector('#model-provider-input'), 'b');
        expect(select.value).not.toBe('gpt-4o-mini');
        await settle();
        expect((window as any).settingAPI.fetchProviderModels).toHaveBeenLastCalledWith(
            expect.objectContaining({
                api_key: 'b-key',
                provider_type: 'anthropic',
                no_ssl: true
            })
        );
        choose(select, 'gpt-4o');
        const escape = new Event('keydown', { cancelable: true });
        Object.assign(escape, { key: 'Escape' });
        const modalEscape = { key: 'Escape', target: select, preventDefault: jest.fn(), stopPropagation: jest.fn() };
        panel._modalEscHandler(modalEscape);
        expect(panel._modalOverlay).not.toBeNull();
        select.dispatchEvent(escape);
        expect(panel.querySelector('#model-name-suggestions').hidden).toBe(true);
        panel._modalEscHandler(modalEscape);
        expect(panel._modalOverlay).toBeNull();
    });

    test('save requires a provider and a name but accepts manual names after discovery fails', async () => {
        const panel = panelForm();
        panel.querySelector('#model-alias-input').value = 'new-model';
        panel.scheduleSave = jest.fn();
        await panel.saveModel();
        (window as any).settingAPI.fetchProviderModels.mockRejectedValueOnce(new Error('timeout'));
        choose(panel.querySelector('#model-provider-input'), 'a');
        await panel.saveModel();
        await settle();
        await panel.saveModel();
        expect(panel.scheduleSave).not.toHaveBeenCalled();
        expect(panel.currentData.models).toHaveLength(1);
        expect(panel.querySelector('#model-name-error').hidden).toBe(false);
        expect(panel.querySelector('#model-name-input').disabled).toBe(false);
        choose(panel.querySelector('#model-name-input'), 'manual-model');
        panel.closeModal = jest.fn();
        panel.refreshVisionSupport = jest.fn(async () => undefined);
        panel.refreshModelsSection = jest.fn();
        panel.refreshDefaultModelsSection = jest.fn();
        await panel.saveModel();
        expect(panel.scheduleSave).toHaveBeenCalledTimes(1);
        expect(panel.currentData.models).toContainEqual(expect.objectContaining({ model_name: 'manual-model' }));
    });

    test('editing preserves the configured name on failed discovery but clears it when switching providers', async () => {
        (window as any).settingAPI.fetchProviderModels.mockRejectedValueOnce(new Error('timeout'));
        const panel = panelForm(0);
        await settle();
        expect(panel.querySelector('#model-name-input').value).toBe('saved-name');
        expect(panel.querySelector('#model-name-error').hidden).toBe(false);
        choose(panel.querySelector('#model-provider-input'), 'b');
        await settle();
        expect(panel.querySelector('#model-name-input').value).toBe('');
        expect(panel.querySelector('#model-name-error').hidden).toBe(true);
    });
});
