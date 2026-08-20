import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenDeskTUI } from '../../../../main/tui/entry.js';
import { Setting, getEnvDefaultModelInstance, ENV_DEFAULT_MODEL_NAME } from '../../../../main/utils/setting.js';

/**
 * 临时设置一组环境变量，测试结束后恢复原值；值为 undefined 表示删除该变量。
 * 复用 setting-env-model.test.ts 的约定。
 */
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

/** 构造一个仅包含 default_model 配置、models 为空的 Setting 实例 */
function createSettingWithDefaultModel(defaultModel: string): Setting {
    const setting = Object.create(Setting.prototype) as Setting;
    setting.data = Setting.getSettingSchema().parse({
        default_model: defaultModel,
        providers: [],
        models: []
    });
    return setting;
}

function createTui(setting: Setting, overrides: Record<string, unknown> = {}): OpenDeskTUI {
    const originalGetInstance = Setting.getInstance;
    Setting.getInstance = (() => setting) as typeof Setting.getInstance;
    const tui = Object.assign(Object.create(OpenDeskTUI.prototype), {
        getActiveTask: () => undefined,
        isTaskStarted: () => false,
        model: undefined,
        ...overrides
    }) as OpenDeskTUI;
    (tui as unknown as { __restoreSetting: () => void }).__restoreSetting = () => {
        Setting.getInstance = originalGetInstance;
    };
    return tui;
}

test('OPENDESK_MODEL_NAME 生效时状态栏模型名优先显示环境变量模型', () => {
    withEnv(
        {
            [ENV_DEFAULT_MODEL_NAME]: 'env-model',
            OPENDESK_MODEL_CONTEXT_LENGTH: undefined,
            OPENDESK_PROVIDER_BASE_URL: undefined,
            OPENDESK_PROVIDER_TYPE: undefined,
            OPENDESK_PROVIDER_API_KEY: undefined
        },
        () => {
            const tui = createTui(createSettingWithDefaultModel('cfg-model'));
            try {
                assert.equal(getEnvDefaultModelInstance()?.model_name, 'env-model');
                assert.equal(tui.getCurrentModelAlias(), 'env-model');
            } finally {
                (tui as unknown as { __restoreSetting: () => void }).__restoreSetting();
            }
        }
    );
});

test('未设置 OPENDESK_MODEL_NAME 时回退到系统设置默认模型', () => {
    withEnv(
        {
            [ENV_DEFAULT_MODEL_NAME]: undefined,
            OPENDESK_MODEL_CONTEXT_LENGTH: undefined,
            OPENDESK_PROVIDER_BASE_URL: undefined,
            OPENDESK_PROVIDER_TYPE: undefined,
            OPENDESK_PROVIDER_API_KEY: undefined
        },
        () => {
            const tui = createTui(createSettingWithDefaultModel('cfg-model'));
            try {
                assert.equal(getEnvDefaultModelInstance(), null);
                assert.equal(tui.getCurrentModelAlias(), 'cfg-model');
            } finally {
                (tui as unknown as { __restoreSetting: () => void }).__restoreSetting();
            }
        }
    );
});

test('已启动任务显式指定模型时优先于环境变量模型', () => {
    withEnv(
        {
            [ENV_DEFAULT_MODEL_NAME]: 'env-model',
            OPENDESK_MODEL_CONTEXT_LENGTH: undefined,
            OPENDESK_PROVIDER_BASE_URL: undefined,
            OPENDESK_PROVIDER_TYPE: undefined,
            OPENDESK_PROVIDER_API_KEY: undefined
        },
        () => {
            const task = { model: 'task-model', ensureValidModelOrFallback: () => {} };
            const tui = createTui(createSettingWithDefaultModel('cfg-model'), {
                getActiveTask: () => task,
                isTaskStarted: () => true
            });
            try {
                assert.equal(tui.getCurrentModelAlias(), 'task-model');
            } finally {
                (tui as unknown as { __restoreSetting: () => void }).__restoreSetting();
            }
        }
    );
});

test('已启动任务未指定模型时回退到环境变量模型而非系统默认', () => {
    withEnv(
        {
            [ENV_DEFAULT_MODEL_NAME]: 'env-model',
            OPENDESK_MODEL_CONTEXT_LENGTH: undefined,
            OPENDESK_PROVIDER_BASE_URL: undefined,
            OPENDESK_PROVIDER_TYPE: undefined,
            OPENDESK_PROVIDER_API_KEY: undefined
        },
        () => {
            const task = { model: undefined, ensureValidModelOrFallback: () => {} };
            const tui = createTui(createSettingWithDefaultModel('cfg-model'), {
                getActiveTask: () => task,
                isTaskStarted: () => true
            });
            try {
                assert.equal(tui.getCurrentModelAlias(), 'env-model');
            } finally {
                (tui as unknown as { __restoreSetting: () => void }).__restoreSetting();
            }
        }
    );
});

test('测试结束后清理环境变量，避免影响其他用例', () => {
    assert.equal(process.env[ENV_DEFAULT_MODEL_NAME], undefined);
});
