import assert from 'node:assert/strict';
import test from 'node:test';
import {
    Setting,
    getEnvDefaultModelInstance,
    ENV_DEFAULT_MODEL_NAME,
    ENV_DEFAULT_MODEL_CONTEXT_LENGTH,
    ENV_DEFAULT_PROVIDER_BASE_URL,
    ENV_DEFAULT_PROVIDER_TYPE,
    ENV_DEFAULT_PROVIDER_API_KEY
} from '../../../../main/utils/setting.js';
import { parseTokenCount, isInvalidTokenCount } from '../../../../utils/model.js';

/** 临时设置一组环境变量，测试结束后恢复原值；值为 undefined 表示删除该变量 */
function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
    const saved: Record<string, string | undefined> = {};
    for (const key of Object.keys(env)) {
        saved[key] = process.env[key];
        if (env[key] === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = env[key] as string;
        }
    }
    try {
        fn();
    } finally {
        for (const key of Object.keys(env)) {
            if (saved[key] === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = saved[key];
            }
        }
    }
}

const ALL_ENV_KEYS = [
    ENV_DEFAULT_MODEL_NAME,
    ENV_DEFAULT_MODEL_CONTEXT_LENGTH,
    ENV_DEFAULT_PROVIDER_BASE_URL,
    ENV_DEFAULT_PROVIDER_TYPE,
    ENV_DEFAULT_PROVIDER_API_KEY
];

test('parseTokenCount 支持纯数字与 k/K 后缀（按 ×1000 计算）', () => {
    assert.equal(parseTokenCount('128'), 128);
    assert.equal(parseTokenCount('128k'), 128000);
    assert.equal(parseTokenCount('128K'), 128000);
    assert.equal(parseTokenCount(' 256k '), 256000);
    assert.equal(parseTokenCount('0'), 0);
    assert.equal(parseTokenCount(''), undefined);
    assert.equal(parseTokenCount('   '), undefined);
    assert.equal(parseTokenCount(undefined), undefined);
    assert.equal(parseTokenCount(null), undefined);
    assert.equal(parseTokenCount('12.5'), undefined);
    assert.equal(parseTokenCount('abc'), undefined);
    assert.equal(parseTokenCount('12kk'), undefined);
    assert.equal(parseTokenCount('9007199254740992'), undefined);
});

test('isInvalidTokenCount 空值/空白合法，非空非法格式报错', () => {
    assert.equal(isInvalidTokenCount(undefined), false);
    assert.equal(isInvalidTokenCount(null), false);
    assert.equal(isInvalidTokenCount(''), false);
    assert.equal(isInvalidTokenCount('   '), false);
    assert.equal(isInvalidTokenCount('128'), false);
    assert.equal(isInvalidTokenCount('128k'), false);
    assert.equal(isInvalidTokenCount('0'), false);
    assert.equal(isInvalidTokenCount('12.5'), true);
    assert.equal(isInvalidTokenCount('12x'), true);
    assert.equal(isInvalidTokenCount('abc'), true);
});

test('OPENDESK_* 环境变量完整配置时构造默认对话模型', () => {
    withEnv(
        {
            [ENV_DEFAULT_MODEL_NAME]: 'gpt-4o',
            [ENV_DEFAULT_MODEL_CONTEXT_LENGTH]: '128k',
            [ENV_DEFAULT_PROVIDER_BASE_URL]: 'https://api.example.com/v1',
            [ENV_DEFAULT_PROVIDER_TYPE]: 'anthropic',
            [ENV_DEFAULT_PROVIDER_API_KEY]: 'sk-test'
        },
        () => {
            const m = getEnvDefaultModelInstance();
            assert.ok(m);
            assert.equal(m.model_name, 'gpt-4o');
            assert.equal(m.context_length, 128000);
            assert.equal(m.base_url, 'https://api.example.com/v1');
            assert.equal(m.provider_type, 'anthropic');
            assert.equal(m.api_key, 'sk-test');
            assert.equal(m.provider_name, 'env');
        }
    );
});

test('仅设置 OPENDESK_MODEL_NAME 时其余字段使用默认值', () => {
    withEnv(
        {
            [ENV_DEFAULT_MODEL_NAME]: 'deepseek-chat',
            [ENV_DEFAULT_MODEL_CONTEXT_LENGTH]: undefined,
            [ENV_DEFAULT_PROVIDER_BASE_URL]: undefined,
            [ENV_DEFAULT_PROVIDER_TYPE]: undefined,
            [ENV_DEFAULT_PROVIDER_API_KEY]: undefined
        },
        () => {
            const m = getEnvDefaultModelInstance();
            assert.ok(m);
            assert.equal(m.model_name, 'deepseek-chat');
            assert.equal(m.context_length, undefined);
            assert.equal(m.provider_type, 'openai');
            assert.equal(m.base_url, '');
            assert.equal(m.api_key, '');
        }
    );
});

test('OPENDESK_MODEL_CONTEXT_LENGTH 留空或非法时自动估算（context_length 为 undefined）', () => {
    for (const raw of [undefined, '', '12x', 'abc']) {
        withEnv(
            {
                [ENV_DEFAULT_MODEL_NAME]: 'm',
                [ENV_DEFAULT_MODEL_CONTEXT_LENGTH]: raw
            },
            () => {
                const m = getEnvDefaultModelInstance();
                assert.ok(m);
                assert.equal(m.context_length, undefined, `raw=${raw}`);
            }
        );
    }
});

test('未设置 OPENDESK_MODEL_NAME 时不启用环境变量覆盖', () => {
    withEnv(
        {
            [ENV_DEFAULT_MODEL_NAME]: undefined,
            [ENV_DEFAULT_MODEL_CONTEXT_LENGTH]: undefined,
            [ENV_DEFAULT_PROVIDER_BASE_URL]: undefined,
            [ENV_DEFAULT_PROVIDER_TYPE]: undefined,
            [ENV_DEFAULT_PROVIDER_API_KEY]: undefined
        },
        () => {
            assert.equal(getEnvDefaultModelInstance(), null);
        }
    );
});

function createSettingWithModels(): Setting {
    const setting = Object.create(Setting.prototype) as Setting;
    setting.data = Setting.getSettingSchema().parse({
        default_model: 'cfg-chat',
        default_quick_model: 'cfg-quick',
        providers: [{ name: 'p1', provider_type: 'openai', base_url: 'https://cfg.example.com', api_key: 'cfg-key' }],
        models: [
            { alias: 'cfg-chat', provider_name: 'p1', model_name: 'cfg-chat-model', model_type: 'chat' },
            { alias: 'cfg-quick', provider_name: 'p1', model_name: 'cfg-quick-model', model_type: 'chat' }
        ]
    });
    return setting;
}

test('getDefaultModelInstance 优先返回环境变量模型，快速对话模型不受影响', () => {
    const setting = createSettingWithModels();
    withEnv(
        {
            [ENV_DEFAULT_MODEL_NAME]: 'env-chat',
            [ENV_DEFAULT_MODEL_CONTEXT_LENGTH]: '64k',
            [ENV_DEFAULT_PROVIDER_BASE_URL]: 'https://env.example.com',
            [ENV_DEFAULT_PROVIDER_TYPE]: undefined,
            [ENV_DEFAULT_PROVIDER_API_KEY]: undefined
        },
        () => {
            const def = setting.getDefaultModelInstance();
            assert.equal(def?.model_name, 'env-chat');
            assert.equal(def?.context_length, 64000);
            assert.equal(def?.base_url, 'https://env.example.com');

            const quick = setting.getDefaultQuickModelInstance();
            assert.equal(quick?.model_name, 'cfg-quick-model');
            assert.equal(quick?.provider_name, 'p1');
            assert.equal(quick?.base_url, 'https://cfg.example.com');
        }
    );
});

test('未配置环境变量时 getDefaultModelInstance 回退到配置的默认模型', () => {
    const setting = createSettingWithModels();
    withEnv(
        {
            [ENV_DEFAULT_MODEL_NAME]: undefined,
            [ENV_DEFAULT_MODEL_CONTEXT_LENGTH]: undefined,
            [ENV_DEFAULT_PROVIDER_BASE_URL]: undefined,
            [ENV_DEFAULT_PROVIDER_TYPE]: undefined,
            [ENV_DEFAULT_PROVIDER_API_KEY]: undefined
        },
        () => {
            const def = setting.getDefaultModelInstance();
            assert.equal(def?.model_name, 'cfg-chat-model');
            assert.equal(def?.provider_name, 'p1');
            assert.equal(def?.base_url, 'https://cfg.example.com');
        }
    );
});

test('测试结束后清理环境变量，避免影响其他用例', () => {
    for (const key of ALL_ENV_KEYS) {
        assert.equal(process.env[key], undefined);
    }
});
