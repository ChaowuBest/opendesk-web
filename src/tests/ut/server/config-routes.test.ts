import { jest } from '@jest/globals';
import { ConfigRoutes } from '../../../main/server/opencode/routes/config.js';
import { GlobalRoutes } from '../../../main/server/opencode/routes/global.js';
import { ProviderRoutes } from '../../../main/server/opencode/routes/provider.js';
import { ApplicationRegistry } from '../../../main/applications/registry.js';
import { Setting, type SettingData } from '../../../main/utils/setting.js';
import { GlobalState } from '../../../main/aikernel/states/global.js';
import { SkillRegistry } from '../../../main/aikernel/skill.js';

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
        reason_display: 'full',
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
            recent_workspaces: []
        },
        cli_config: {
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

describe('opencode config routes', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('PATCH /config applies opencode config update through Setting.setData', async () => {
        const setting = mockSetting();
        const postMessage = jest.fn();
        jest.spyOn(ApplicationRegistry, 'hasGlobalWorker').mockReturnValue(true);
        jest.spyOn(ApplicationRegistry, 'getGlobalWorker').mockReturnValue({ postMessage } as any);

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

        const response = await GlobalRoutes().request('/config', {
            method: 'PATCH',
            body: JSON.stringify({ default_model: 'gpt4o' }),
            headers: { 'content-type': 'application/json' }
        });

        expect(response.status).toBe(200);
        expect(setting.setData).toHaveBeenCalledTimes(1);
        expect((setting.setData.mock.calls[0][0] as SettingData).default_model).toBe('gpt4o');
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
        const postMessage = jest.fn();
        const refresh = jest.fn(() => ({ count: 1, errors: [] }));
        const attachToolsets = jest.fn();
        let task: any;
        task = {
            parent_id: null,
            activeModeId: 'standard',
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
            persistLater: jest.fn()
        };
        jest.spyOn(Setting, 'load').mockReturnValue({
            getData: () => clone(diskData)
        } as unknown as Setting);
        jest.spyOn(ApplicationRegistry, 'hasGlobalWorker').mockReturnValue(true);
        jest.spyOn(ApplicationRegistry, 'getGlobalWorker').mockReturnValue({ postMessage } as any);
        jest.spyOn(ApplicationRegistry, 'getApplication').mockImplementation((bundleName) =>
            bundleName === 'skillmgr' ? ({ refresh } as any) : undefined
        );
        jest.spyOn(GlobalState, 'getInstance').mockReturnValue({
            taskManagerState: {
                tasks: [task]
            }
        } as any);
        jest.spyOn(SkillRegistry, 'getInstance').mockReturnValue({
            getSkillFrontmatterXml: jest.fn(async () => '<available_skills><skill>new</skill></available_skills>')
        } as any);

        const response = await GlobalRoutes().request('/config', {
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
        expect(task.setSystemPrompt).toHaveBeenCalledWith(
            'before <available_skills><skill>new</skill></available_skills> after'
        );
        expect(task.persistLater).toHaveBeenCalledTimes(1);
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
    });
});
