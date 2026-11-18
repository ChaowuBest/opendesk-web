import { jest } from '@jest/globals';
import os from 'node:os';

interface CatalogSettings {
    default_model: string;
    models: Record<string, unknown>[];
    builtin_models: Record<string, unknown>[];
    providers?: Record<string, unknown>[];
}

let settings: CatalogSettings;
const getData = jest.fn(() => settings);

jest.unstable_mockModule('../../../main/utils/setting.js', () => ({
    Setting: { getInstance: () => ({ getData }) },
    getOpendeskDirectory: () => os.tmpdir()
}));
jest.unstable_mockModule('../../../main/utils/model-network.js', () => ({ fetchModelUrl: jest.fn() }));
jest.unstable_mockModule('../../../main/aikernel/states/global.js', () => ({ GlobalState: {} }));
jest.unstable_mockModule('../../../main/aikernel/agents/registry.js', () => ({ AgentRegistry: {} }));
jest.unstable_mockModule('../../../main/applications/registry.js', () => ({ ApplicationRegistry: {} }));
jest.unstable_mockModule('../../../main/utils/logger.js', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));
jest.unstable_mockModule('../../../locale/index.js', () => {
    // 包装层 t 经 translateWithDomain 走统一查找链；这里按 zh-CN 内联等价实现，保持用例断言稳定
    const translateWithDomain = (
        key: string,
        domain: Record<string, Record<string, string>>,
        params?: Record<string, string | number>
    ): string => {
        let text = domain['zh-CN']?.[key] ?? key;
        if (params) {
            for (const [name, value] of Object.entries(params)) {
                text = text.replace(new RegExp(`\\$\\{${name}\\}`, 'g'), String(value));
            }
        }
        return text;
    };
    return { getLocale: () => 'zh-CN', translateWithDomain };
});
jest.unstable_mockModule('../../../main/tui/theme.js', () => ({ getAdaptiveGreen: () => '#00ff00' }));
jest.unstable_mockModule('../../../main/aikernel/tool.js', () => ({ BaseToolset: class {} }));
jest.unstable_mockModule('../../../main/aikernel/skill.js', () => ({ Skill: class {} }));
jest.unstable_mockModule('../../../main/applications/todomgr/tools.js', () => ({
    TodoWriteTool: class {},
    AddGlobalTodoTool: class {},
    UpdateGlobalTodoTool: class {},
    ListGlobalTodoDeliverTargetsTool: class {},
    ListGlobalTodosTool: class {},
    DeleteGlobalTodoTool: class {},
    GetCurrentTimeTool: class {},
    GetSupportedEventsTool: class {}
}));

let TodoMgrApplication: typeof import('../../../main/applications/todomgr/app.js').TodoMgrApplication;

describe('TodoMgr chat model catalog', () => {
    beforeAll(async () => {
        ({ TodoMgrApplication } = await import('../../../main/applications/todomgr/app.js'));
    });

    beforeEach(() => {
        jest.clearAllMocks();
        settings = { default_model: '', models: [], builtin_models: [] };
    });

    test('keeps user aliases before builtins and omits embedding, blank and duplicate entries', () => {
        settings = {
            default_model: 'daily-model',
            models: [
                { alias: 'daily-model', provider_name: 'user-provider', model_name: 'gpt-5', model_type: 'chat' },
                { alias: 'daily-model', provider_name: 'ignored-user', model_name: 'gpt-4' },
                { alias: 'embedding-only', model_name: 'text-embedding-3-small', model_type: 'embedding' },
                { alias: 'shared-with-embedding', model_name: 'text-embedding-3-small', model_type: 'embedding' },
                { alias: '', model_name: 'gpt-4o' },
                { model_name: 'gpt-4o' }
            ],
            builtin_models: [
                { alias: 'daily-model', provider_name: 'ignored-builtin', model_name: 'gpt-4' },
                { alias: 'builtin-chat', provider_name: 'builtin-provider', model_name: 'gpt-4o' },
                { alias: 'shared-with-embedding', model_name: 'gpt-4o' },
                { alias: 'builtin-chat', provider_name: 'ignored-duplicate', model_name: 'gpt-4' }
            ]
        };

        const catalog = new TodoMgrApplication().getChatModelsForUI();

        expect(catalog.default_model).toBe('daily-model');
        expect(catalog.models.map((model) => model.alias)).toEqual([
            'daily-model',
            'builtin-chat',
            'shared-with-embedding'
        ]);
        expect(catalog.models[0]).toMatchObject({ provider_name: 'user-provider', model_name: 'gpt-5' });
        expect(catalog.models[1]).toMatchObject({ provider_name: 'builtin-provider', model_name: 'gpt-4o' });
    });

    test('resolves known capabilities by model name and gives manual vision choices precedence', () => {
        settings.models = [
            { alias: 'inferred', model_name: 'gpt-5' },
            { alias: 'gpt-5' },
            { alias: 'vision-disabled', model_name: 'gpt-4o', vision: false },
            { alias: 'vision-enabled', model_name: 'unknown-local-model', vision: true },
            { alias: 'unknown', model_name: 'another-unknown-local-model' }
        ];

        const catalog = new TodoMgrApplication().getChatModelsForUI();

        expect(catalog.models).toEqual([
            {
                alias: 'inferred',
                provider_name: '',
                model_name: 'gpt-5',
                vision: true,
                reasoningEfforts: ['', 'none', 'low', 'medium', 'high']
            },
            {
                alias: 'gpt-5',
                provider_name: '',
                model_name: 'gpt-5',
                vision: true,
                reasoningEfforts: ['', 'none', 'low', 'medium', 'high']
            },
            {
                alias: 'vision-disabled',
                provider_name: '',
                model_name: 'gpt-4o',
                vision: false,
                reasoningEfforts: ['', 'none', 'low', 'medium', 'high', 'max']
            },
            {
                alias: 'vision-enabled',
                provider_name: '',
                model_name: 'unknown-local-model',
                vision: true,
                reasoningEfforts: ['', 'none', 'low', 'medium', 'high', 'max']
            },
            {
                alias: 'unknown',
                provider_name: '',
                model_name: 'another-unknown-local-model',
                vision: false,
                reasoningEfforts: ['', 'none', 'low', 'medium', 'high', 'max']
            }
        ]);
    });

    test('returns only picker fields without provider credentials or full model configuration', () => {
        settings = {
            default_model: 'safe-alias',
            providers: [
                {
                    name: 'provider-label',
                    api_key: 'provider-secret',
                    base_url: 'https://provider.invalid',
                    custom_headers: { Authorization: 'provider-header-secret' }
                }
            ],
            models: [
                {
                    alias: 'safe-alias',
                    provider_name: 'provider-label',
                    model_name: 'gpt-5',
                    model_type: 'chat',
                    api_key: 'model-secret',
                    base_url: 'https://model.invalid',
                    custom_headers: { Authorization: 'model-header-secret' },
                    context_length: 123456,
                    max_tokens: 789,
                    no_ssl: true
                }
            ],
            builtin_models: []
        };

        const catalog = new TodoMgrApplication().getChatModelsForUI();

        expect(Object.keys(catalog).sort()).toEqual(['default_model', 'models']);
        expect(Object.keys(catalog.models[0]).sort()).toEqual([
            'alias',
            'model_name',
            'provider_name',
            'reasoningEfforts',
            'vision'
        ]);
        expect(catalog).toEqual({
            default_model: 'safe-alias',
            models: [
                {
                    alias: 'safe-alias',
                    provider_name: 'provider-label',
                    model_name: 'gpt-5',
                    vision: true,
                    reasoningEfforts: ['', 'none', 'low', 'medium', 'high']
                }
            ]
        });
    });

    test('reads fresh settings on every call and preserves the configured default alias', () => {
        const application = new TodoMgrApplication();
        settings.default_model = 'old-model';
        settings.models = [{ alias: 'old-model', model_name: 'gpt-4o' }];
        const first = application.getChatModelsForUI();

        settings = {
            default_model: 'no-longer-configured',
            models: [{ alias: 'new-model', model_name: 'gpt-5', vision: false }],
            builtin_models: []
        };
        const second = application.getChatModelsForUI();

        expect(getData).toHaveBeenCalledTimes(2);
        expect(first.default_model).toBe('old-model');
        expect(first.models.map((model) => model.alias)).toEqual(['old-model']);
        expect(second).toEqual({
            default_model: 'no-longer-configured',
            models: [
                {
                    alias: 'new-model',
                    provider_name: '',
                    model_name: 'gpt-5',
                    vision: false,
                    reasoningEfforts: ['', 'none', 'low', 'medium', 'high']
                }
            ]
        });
    });
});
