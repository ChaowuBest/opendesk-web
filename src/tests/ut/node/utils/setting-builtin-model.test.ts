import assert from 'node:assert/strict';
import test from 'node:test';
import { Setting, getSettingSchema, type BuiltinModelFetch } from '../../../../main/utils/setting.js';
import {
    AccountBuiltinModelProvider,
    OPENDESK_BUILTIN_PROVIDER_NAME,
    refreshBuiltinModels
} from '../../../../main/applications/account/model-provider.js';

const BUILTIN_MODEL_ALIAS = 'opendesk/auto';
const ACCOUNT_API_BASE_URL = 'https://ent.example.com/api/v1';
const RELAY_CREDENTIAL = 'sk-od-test-credential';

function modelsFetch(models: string[]): BuiltinModelFetch {
    return async () =>
        new Response(JSON.stringify({ data: models }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
        });
}

function createSetting(data: Record<string, unknown> = {}): Setting {
    const setting = Object.create(Setting.prototype) as Setting;
    setting.data = getSettingSchema().parse(data);
    return setting;
}

function installProvider(api: { baseUrl: string; token: string } | null): void {
    Setting.builtinModelProvider = new AccountBuiltinModelProvider(() => api);
}

async function withApi<T>(
    api: { baseUrl: string; token: string } | null,
    fn: () => void | Promise<void>
): Promise<void> {
    const previous = Setting.builtinModelProvider;
    try {
        installProvider(api);
        await fn();
    } finally {
        Setting.builtinModelProvider = previous;
    }
}

async function seedBuiltinModels(setting: Setting): Promise<void> {
    const models = (await Setting.builtinModelProvider?.refreshModels(modelsFetch([BUILTIN_MODEL_ALIAS]))) ?? [];
    setting.data.builtin_models = models;
}

test('getModelInstance 解析内置模型：base_url 为 relay 地址，api_key 为 relay 凭据', async () => {
    const api = {
        baseUrl: `${ACCOUNT_API_BASE_URL}/relay/v1`,
        token: RELAY_CREDENTIAL
    };
    await withApi(api, async () => {
        const setting = createSetting();
        await seedBuiltinModels(setting);
        const instance = setting.getModelInstance(BUILTIN_MODEL_ALIAS, 'chat');
        assert.ok(instance);
        assert.equal(instance.model_name, BUILTIN_MODEL_ALIAS);
        assert.equal(instance.base_url, `${ACCOUNT_API_BASE_URL}/relay/v1`);
        assert.equal(instance.provider_name, OPENDESK_BUILTIN_PROVIDER_NAME);
        assert.equal(instance.provider_type, 'openai');
        assert.equal(instance.model_type, 'chat');
        assert.equal(instance.api_key, RELAY_CREDENTIAL);
    });
});

test('getModelInstance 未登录时内置模型不可解析', async () => {
    await withApi(null, async () => {
        const setting = createSetting();
        await seedBuiltinModels(setting);
        assert.equal(setting.getModelInstance(BUILTIN_MODEL_ALIAS, 'chat'), null);
    });
});

test('getModelInstance 内置模型不作为 embedding 模型解析', async () => {
    const api = {
        baseUrl: `${ACCOUNT_API_BASE_URL}/relay/v1`,
        token: RELAY_CREDENTIAL
    };
    await withApi(api, async () => {
        const setting = createSetting();
        await seedBuiltinModels(setting);
        assert.equal(setting.getModelInstance(BUILTIN_MODEL_ALIAS, 'embedding'), null);
    });
});

test('用户配置的同名模型优先于内置模型', async () => {
    const api = {
        baseUrl: `${ACCOUNT_API_BASE_URL}/relay/v1`,
        token: RELAY_CREDENTIAL
    };
    await withApi(api, async () => {
        const setting = createSetting({
            providers: [
                { name: 'p1', provider_type: 'openai', base_url: 'https://cfg.example.com', api_key: 'cfg-key' }
            ],
            models: [{ alias: BUILTIN_MODEL_ALIAS, provider_name: 'p1', model_name: 'user-model', model_type: 'chat' }]
        });
        await seedBuiltinModels(setting);
        const instance = setting.getModelInstance(BUILTIN_MODEL_ALIAS, 'chat');
        assert.ok(instance);
        assert.equal(instance.model_name, 'user-model');
        assert.equal(instance.base_url, 'https://cfg.example.com');
        assert.equal(instance.api_key, 'cfg-key');
    });
});

test('validateDefaultModels 保留指向内置模型的默认模型引用', async () => {
    await withApi(null, async () => {
        const setting = createSetting({ default_model: BUILTIN_MODEL_ALIAS });
        (setting as unknown as { validateDefaultModels(saveChanges?: boolean): void }).validateDefaultModels(false);
        assert.equal(setting.getData().default_model, BUILTIN_MODEL_ALIAS);
    });
});

test('validateDefaultModels 在 provider 尚未注册时仍保留已持久化的内置模型引用', () => {
    const previous = Setting.builtinModelProvider;
    Setting.builtinModelProvider = null;
    try {
        const setting = createSetting({
            default_model: BUILTIN_MODEL_ALIAS,
            builtin_models: [
                {
                    alias: BUILTIN_MODEL_ALIAS,
                    provider_name: OPENDESK_BUILTIN_PROVIDER_NAME,
                    model_name: 'auto',
                    model_type: 'chat'
                }
            ]
        });
        (setting as unknown as { validateDefaultModels(saveChanges?: boolean): void }).validateDefaultModels(false);
        assert.equal(setting.getData().default_model, BUILTIN_MODEL_ALIAS);
    } finally {
        Setting.builtinModelProvider = previous;
    }
});

test('validateDefaultModels 仍然清除指向未知模型的默认模型引用', async () => {
    await withApi(null, async () => {
        const setting = createSetting({ default_model: 'no-such-model' });
        (setting as unknown as { validateDefaultModels(saveChanges?: boolean): void }).validateDefaultModels(false);
        assert.equal(setting.getData().default_model, '');
    });
});

test('已登录且已拉取时返回描述，未登录返回空', async () => {
    const api = {
        baseUrl: `${ACCOUNT_API_BASE_URL}/relay/v1`,
        token: RELAY_CREDENTIAL
    };
    await withApi(api, async () => {
        const setting = createSetting();
        await seedBuiltinModels(setting);
        const descriptors = setting.data.builtin_models;
        assert.equal(descriptors.length, 1);
        assert.equal(descriptors[0].alias, BUILTIN_MODEL_ALIAS);
        assert.equal(descriptors[0].model_type, 'chat');
    });
    await withApi(null, async () => {
        const setting = createSetting();
        await seedBuiltinModels(setting);
        assert.deepEqual(setting.data.builtin_models, []);
    });
});

const REFRESH_API = { baseUrl: `${ACCOUNT_API_BASE_URL}/relay/v1`, token: RELAY_CREDENTIAL };

function jsonModelsResponse(models: string[]): Response {
    return new Response(JSON.stringify({ data: models }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
    });
}

async function withRefreshHarness(
    data: Record<string, unknown>,
    api: { baseUrl: string; token: string } | null,
    fetchImpl: typeof fetch,
    fn: (setting: Setting) => void
): Promise<void> {
    const setting = createSetting(data);
    setting.save = () => undefined;
    const previousInstance = Setting.instance;
    const previousProvider = Setting.builtinModelProvider;
    const previousFetch = globalThis.fetch;
    Setting.instance = setting;
    Setting.builtinModelProvider = api ? new AccountBuiltinModelProvider(() => api) : null;
    globalThis.fetch = fetchImpl;
    try {
        await refreshBuiltinModels();
        fn(setting);
    } finally {
        Setting.instance = previousInstance;
        Setting.builtinModelProvider = previousProvider;
        globalThis.fetch = previousFetch;
    }
}

test('refreshBuiltinModels 在 default_model 为空时自动选中账号自带模型', async () => {
    await withRefreshHarness(
        {},
        REFRESH_API,
        async () => jsonModelsResponse(['vendor/x', BUILTIN_MODEL_ALIAS]),
        (setting) => {
            assert.equal(setting.getData().default_model, BUILTIN_MODEL_ALIAS);
            assert.equal(setting.getData().builtin_models.length, 2);
        }
    );
});

test('refreshBuiltinModels 不覆盖仍有效的用户默认模型', async () => {
    await withRefreshHarness(
        {
            default_model: 'user-model',
            models: [{ alias: 'user-model', provider_name: 'p1', model_name: 'user-model', model_type: 'chat' }]
        },
        REFRESH_API,
        async () => jsonModelsResponse([BUILTIN_MODEL_ALIAS]),
        (setting) => {
            assert.equal(setting.getData().default_model, 'user-model');
        }
    );
});

test('refreshBuiltinModels 替换已失效的默认模型引用', async () => {
    await withRefreshHarness(
        { default_model: 'opendesk/stale' },
        REFRESH_API,
        async () => jsonModelsResponse([BUILTIN_MODEL_ALIAS]),
        (setting) => {
            assert.equal(setting.getData().default_model, BUILTIN_MODEL_ALIAS);
        }
    );
});

test('refreshBuiltinModels 登出（空结果）时保留 default_model', async () => {
    await withRefreshHarness(
        { default_model: BUILTIN_MODEL_ALIAS },
        null,
        async () => jsonModelsResponse([]),
        (setting) => {
            assert.equal(setting.getData().default_model, BUILTIN_MODEL_ALIAS);
            assert.deepEqual(setting.getData().builtin_models, []);
        }
    );
});
