import { jest } from '@jest/globals';
import { ConfigRoutes } from '../../../main/server/opencode/routes/config.js';
import { GlobalRoutes } from '../../../main/server/opencode/routes/global.js';
import { ProviderRoutes } from '../../../main/server/opencode/routes/provider.js';
import { InstanceRoutes } from '../../../main/server/opencode/routes/instance.js';
import { EventBus } from '../../../main/server/opencode/event-bus.js';
import { ApplicationRegistry } from '../../../main/applications/registry.js';
import { Setting, type SettingData } from '../../../main/utils/setting.js';
import { GlobalState } from '../../../main/aikernel/states/global.js';
import type { ConfigPermissionRuntime } from '../../../main/server/opencode/config-permission-runtime.js';

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function baseSettingData(): SettingData {
    return {
        locale: 'auto',
        default_model: 'old',
        default_intent_parsing_model: '',
        default_embedding_model: '',
        default_reranker_model: '',
        default_vision_model: '',
        default_workspace: '',
        providers: [
            {
                name: 'openai',
                base_url: 'https://old.example/v1',
                api_key: 'old-key',
                no_proxy: false
            }
        ],
        models: [
            {
                alias: 'old',
                provider_name: 'openai',
                model_name: 'old-model',
                reasoning_effort: ''
            },
            {
                alias: 'gpt4o',
                provider_name: 'openai',
                model_name: 'gpt-4o',
                reasoning_effort: 'medium',
                context_length: 128000
            }
        ],
        gui_config: {
            scale_factor: 1,
            font_preset: 'default',
            ctrl_enter_send: false,
            recent_workspaces: [],
            gui_reason_display: 'inline'
        },
        cli_config: {
            use_isolated_python: true,
            inherit_venv: true,
            reason_display: 'full',
            shortcuts: {
                switch_mode: 'ctrl+k',
                switch_model: 'f2',
                clear_input: 'ctrl+c',
                endline: 'ctrl+j',
                show_help: 'ctrl+h',
                list_tasks: 'ctrl+l'
            }
        },
        applications: {
            browser: {
                defaultHomepage: 'about:blank',
                keepExisting: true
            }
        } as any
    };
}

function mockSetting(initial = baseSettingData()) {
    let data = clone(initial);
    const setting = {
        getData: jest.fn(() => data),
        setData: jest.fn((nextData: SettingData) => {
            data = clone(nextData);
        }),
        save: jest.fn()
    };
    jest.spyOn(Setting, 'getInstance').mockReturnValue(setting as unknown as Setting);
    return setting;
}

/**
 * 模拟带回执的全局 Worker：postMessage 里立刻 resolve 对应 requestId，
 * 等价于真实 Worker 处理完 `__updateGlobalSetting` 后的响应。
 * 若只 mock 一个不回复的 postMessage，notifyWorkerSettingUpdate 内部会留下
 * 10s 超时定时器；该定时器往往在本测试文件结束（Jest 环境已 tear down）之后
 * 才 reject，进而在通知失败的 catch 里触发 logger.warn，
 * 表现为 "trying to require a file after the Jest environment has been torn down"。
 */
function mockGlobalWorkerWithAck() {
    const postMessage = jest.fn((message: { requestId?: string }) => {
        const requestId = message?.requestId;
        if (requestId) {
            ApplicationRegistry.pendingRequests.get(requestId)?.resolve(undefined);
        }
    });
    jest.spyOn(ApplicationRegistry, 'hasGlobalWorker').mockReturnValue(true);
    jest.spyOn(ApplicationRegistry, 'getGlobalWorker').mockReturnValue({ postMessage } as any);
    return postMessage;
}

describe('opencode config routes', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('PATCH /config applies opencode config update through Setting.setData', async () => {
        const setting = mockSetting();
        const postMessage = mockGlobalWorkerWithAck();

        const response = await ConfigRoutes().request('/', {
            method: 'PATCH',
            body: JSON.stringify({
                model: 'openai/gpt-4o',
                provider: {
                    openai: {
                        options: {
                            apiKey: 'new-key',
                            baseURL: 'https://new.example/v1',
                            noProxy: true
                        }
                    }
                },
                applications: {
                    browser: {
                        defaultHomepage: 'https://example.com'
                    }
                }
            }),
            headers: { 'content-type': 'application/json' }
        });

        expect(response.status).toBe(200);
        expect(setting.setData).toHaveBeenCalledTimes(1);
        expect(setting.save).not.toHaveBeenCalled();
        expect(postMessage).toHaveBeenCalledTimes(1);

        const nextData = setting.setData.mock.calls[0][0] as SettingData;
        expect(postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                bundleName: '__system',
                methodName: '__updateGlobalSetting',
                args: [expect.objectContaining({ default_model: 'gpt4o' })]
            })
        );
        expect(nextData.default_model).toBe('gpt4o');
        expect(nextData.providers[0]).toMatchObject({
            name: 'openai',
            base_url: 'https://new.example/v1',
            api_key: 'new-key',
            no_proxy: true
        });
        expect((nextData.applications as any).browser).toEqual({
            defaultHomepage: 'https://example.com',
            keepExisting: true
        });

        expect(await response.json()).toMatchObject({
            model: 'openai/gpt4o',
            provider: {
                openai: {
                    options: {
                        apiKey: 'new-key',
                        baseURL: 'https://new.example/v1',
                        noProxy: true
                    }
                }
            }
        });
    });

    test('PATCH /global/config uses the same hot-reload path', async () => {
        const setting = mockSetting();
        const permissionRuntime = {
            reload: jest.fn(() => ({ status: 'active' }))
        } as unknown as ConfigPermissionRuntime;

        const response = await GlobalRoutes(permissionRuntime).request('/config', {
            method: 'PATCH',
            body: JSON.stringify({
                default_model: 'gpt4o',
                permission: {
                    '*': 'allow',
                    bash: { 'rm *': 'ask' }
                }
            }),
            headers: { 'content-type': 'application/json' }
        });

        expect(response.status).toBe(200);
        expect(setting.setData).toHaveBeenCalledTimes(1);
        expect((setting.setData.mock.calls[0][0] as SettingData).default_model).toBe('gpt4o');
        expect((setting.setData.mock.calls[0][0] as SettingData).permission).toEqual({
            '*': 'allow',
            bash: { 'rm *': 'ask' }
        });
        expect(permissionRuntime.reload).toHaveBeenCalledWith({
            '*': 'allow',
            bash: { 'rm *': 'ask' }
        });
        expect(await response.json()).toMatchObject({
            permission: {
                '*': 'allow',
                bash: { 'rm *': 'ask' }
            }
        });
    });

    test('PATCH /global/config removes configured permissions with null without reloading on unrelated patches', async () => {
        const setting = mockSetting({
            ...baseSettingData(),
            permission: { '*': 'deny' }
        });
        const permissionRuntime = {
            reload: jest.fn(() => ({ status: 'missing' }))
        } as unknown as ConfigPermissionRuntime;
        const routes = GlobalRoutes(permissionRuntime);

        const unrelatedResponse = await routes.request('/config', {
            method: 'PATCH',
            body: JSON.stringify({ default_model: 'gpt4o' }),
            headers: { 'content-type': 'application/json' }
        });
        expect(unrelatedResponse.status).toBe(200);
        expect(permissionRuntime.reload).not.toHaveBeenCalled();

        const removeResponse = await routes.request('/config', {
            method: 'PATCH',
            body: JSON.stringify({ permission: null }),
            headers: { 'content-type': 'application/json' }
        });
        expect(removeResponse.status).toBe(200);
        expect(permissionRuntime.reload).toHaveBeenCalledWith(undefined);
        expect(await removeResponse.json()).not.toHaveProperty('permission');
    });

    test('POST /global/dispose and POST /instance/dispose reload config from disk and announce the directory', async () => {
        const setting = mockSetting();
        const postMessage = mockGlobalWorkerWithAck();
        jest.spyOn(Setting, 'load').mockReturnValue({
            getData: () => ({ ...baseSettingData(), default_model: 'gpt4o' })
        } as unknown as Setting);
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(undefined);
        jest.spyOn(GlobalState, 'getInstance').mockReturnValue({ taskManagerState: { tasks: [] } } as any);
        const publish = jest.spyOn(EventBus, 'publish').mockImplementation(() => undefined);
        const permissionRuntime = {
            reload: jest.fn(() => ({ status: 'disabled' }))
        } as unknown as ConfigPermissionRuntime;
        const directory = '/tmp/opendesk-dispose-test';

        const globalResponse = await GlobalRoutes(permissionRuntime).request(
            `/dispose?directory=${encodeURIComponent(directory)}`,
            { method: 'POST' }
        );
        const instanceResponse = await InstanceRoutes(permissionRuntime).request(
            `/instance/dispose?directory=${encodeURIComponent(directory)}`,
            { method: 'POST' }
        );

        for (const response of [globalResponse, instanceResponse]) {
            expect(response.status).toBe(200);
            await expect(response.json()).resolves.toBe(true);
        }
        expect(Setting.load).toHaveBeenCalledTimes(2);
        expect(setting.setData).toHaveBeenCalledWith(expect.objectContaining({ default_model: 'gpt4o' }));
        expect(permissionRuntime.reload).toHaveBeenCalledTimes(2);
        expect(postMessage).toHaveBeenCalled();
        const disposed = publish.mock.calls.filter(([event]) => event.type === 'server.instance.disposed');
        expect(disposed.map(([event]) => event)).toEqual([
            { type: 'server.instance.disposed', directory, properties: { directory } },
            { type: 'server.instance.disposed', directory, properties: { directory } }
        ]);
    });

    test('opencode provider responses honor provider enabled flags', async () => {
        mockSetting({
            ...baseSettingData(),
            default_model: 'anthropic-sonnet',
            providers: [
                {
                    name: 'openai',
                    base_url: 'https://openai.example/v1',
                    api_key: 'openai-key',
                    no_proxy: false,
                    enabled: true
                },
                {
                    name: 'anthropic',
                    base_url: 'https://anthropic.example/v1',
                    api_key: 'anthropic-key',
                    no_proxy: false,
                    enabled: false
                },
                {
                    name: 'openrouter',
                    base_url: 'https://openrouter.example/v1',
                    api_key: 'openrouter-key',
                    no_proxy: false,
                    enabled: false
                }
            ],
            models: [
                {
                    alias: 'gpt4o',
                    provider_name: 'openai',
                    model_name: 'gpt-4o',
                    reasoning_effort: ''
                },
                {
                    alias: 'anthropic-sonnet',
                    provider_name: 'anthropic',
                    model_name: 'claude-sonnet',
                    reasoning_effort: ''
                },
                {
                    alias: 'openrouter-flash',
                    provider_name: 'openrouter',
                    model_name: 'google/gemini-flash',
                    reasoning_effort: ''
                }
            ]
        });

        const configResponse = await ConfigRoutes().request('/');
        const config = (await configResponse.json()) as any;
        expect(Object.keys(config.provider)).toEqual(['openai']);
        expect(config.model).toBeUndefined();

        const providersResponse = await ConfigRoutes().request('/providers');
        const providers = (await providersResponse.json()) as any;
        expect(providers.providers.map((provider: any) => provider.id)).toEqual(['openai']);
        expect(providers.default).toEqual({});

        const providerResponse = await ProviderRoutes().request('/');
        const providerData = (await providerResponse.json()) as any;
        expect(providerData.all.map((provider: any) => provider.id)).toEqual(['openai']);
        expect(providerData.connected).toEqual(['openai']);
        expect(providerData.default).toEqual({});

        const authResponse = await ProviderRoutes().request('/auth');
        await expect(authResponse.json()).resolves.toEqual({ openai: [{ type: 'api', label: 'API key' }] });
    });

    test('PATCH /global/config with empty sdk config reloads providers, mcp config and skills from disk', async () => {
        const setting = mockSetting({
            ...baseSettingData(),
            applications: {
                mcpmgr: {
                    servers: [
                        {
                            id: 'mcp_old',
                            name: 'old',
                            transport: 'stdio',
                            enabled: true,
                            command: 'old',
                            args: [],
                            env: {},
                            headers: {}
                        }
                    ]
                },
                skillmgr: {
                    enabled: true
                }
            } as any
        });
        const diskData = {
            ...baseSettingData(),
            default_model: 'gpt4o',
            permission: {
                '*': 'allow',
                bash: { 'rm *': 'deny' }
            },
            providers: [
                {
                    name: 'openai',
                    base_url: 'https://disk.example/v1',
                    api_key: 'disk-key',
                    no_proxy: true
                }
            ],
            applications: {
                mcpmgr: {
                    servers: [
                        {
                            id: 'mcp_new',
                            name: 'new',
                            transport: 'stdio',
                            enabled: false,
                            command: 'new',
                            args: ['--flag'],
                            env: {},
                            headers: {}
                        }
                    ]
                },
                skillmgr: {
                    enabled: true
                }
            } as any
        };
        const postMessage = mockGlobalWorkerWithAck();
        const refresh = jest.fn(() => ({ count: 1, errors: [] }));
        const attachToolsets = jest.fn();
        let task: any;
        task = {
            parent_id: null,
            activeModeId: 'standard',
            _fullyLoaded: true,
            chat_context: {
                system_prompt: {
                    content: 'before <available_skills><skill>old</skill></available_skills> after'
                },
                attachToolsets
            },
            buildToolsets: jest.fn(async () => [{ name: 'skill', tools: new Map() }]),
            setSystemPrompt: jest.fn((prompt: string) => {
                task.chat_context.system_prompt.content = prompt;
            }),
            rebuildSystemPrompt: jest.fn(async () => {
                task.setSystemPrompt('rebuilt prompt');
            }),
            persistLater: jest.fn()
        };
        jest.spyOn(Setting, 'load').mockReturnValue({
            getData: () => clone(diskData)
        } as unknown as Setting);
        jest.spyOn(ApplicationRegistry, 'getApplication').mockImplementation((bundleName) =>
            bundleName === 'skillmgr' ? ({ refresh } as any) : undefined
        );
        jest.spyOn(GlobalState, 'getInstance').mockReturnValue({
            taskManagerState: {
                tasks: [task]
            }
        } as any);
        const permissionRuntime = {
            reload: jest.fn(() => ({ status: 'active' }))
        } as unknown as ConfigPermissionRuntime;
        const response = await GlobalRoutes(permissionRuntime).request('/config', {
            method: 'PATCH',
            body: JSON.stringify({ config: {} }),
            headers: { 'content-type': 'application/json' }
        });

        expect(response.status).toBe(200);
        expect(Setting.load).toHaveBeenCalledTimes(1);
        expect(setting.setData).toHaveBeenCalledTimes(1);
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(task.buildToolsets).toHaveBeenCalledTimes(1);
        expect(attachToolsets).toHaveBeenCalledWith(expect.objectContaining({ name: 'skill' }));
        expect(task.setSystemPrompt).toHaveBeenCalledWith('rebuilt prompt');
        expect(task.persistLater).not.toHaveBeenCalled();
        expect(postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                bundleName: '__system',
                methodName: '__updateGlobalSetting',
                args: [expect.objectContaining({ default_model: 'gpt4o' })]
            })
        );

        const nextData = setting.setData.mock.calls[0][0] as SettingData;
        expect(nextData.providers[0]).toMatchObject({
            base_url: 'https://disk.example/v1',
            api_key: 'disk-key',
            no_proxy: true
        });
        expect((nextData.applications as any).mcpmgr.servers).toEqual((diskData.applications as any).mcpmgr.servers);
        expect(permissionRuntime.reload).toHaveBeenCalledWith(diskData.permission);
    });
});
