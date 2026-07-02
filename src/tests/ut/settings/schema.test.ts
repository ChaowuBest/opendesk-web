/**
 * Settings schema unit tests.
 */

import { Setting } from '../../../main/utils/setting';

describe('设置 schema', () => {
    test('开发者模式默认关闭', () => {
        const setting = Setting.getSettingSchema().parse({});

        expect(setting.debug.developer_mode).toBe(false);
    });

    test('调试设置使用共享结构并默认关闭实验功能', () => {
        const setting = Setting.getSettingSchema().parse({
            debug: {
                developer_mode: true
            }
        });

        expect(setting.debug).toEqual({
            developer_mode: true,
            experimental_feature: false
        });
    });

    test('终端 CLI 默认使用隔离 Python 环境', () => {
        const setting = Setting.getSettingSchema().parse({});

        expect(setting.cli_config.use_isolated_python).toBe(true);
        expect(setting.cli_config.inherit_venv).toBe(true);
    });

    test('终端 CLI 可以关闭隔离 Python 环境', () => {
        const setting = Setting.getSettingSchema().parse({
            cli_config: {
                use_isolated_python: false,
                inherit_venv: false
            }
        });

        expect(setting.cli_config.use_isolated_python).toBe(false);
        expect(setting.cli_config.inherit_venv).toBe(false);
    });

    test('旧模型缺省为对话模型', () => {
        const setting = Setting.getSettingSchema().parse({
            models: [{ alias: 'legacy', provider_name: 'p', model_name: 'm' }]
        });

        expect(setting.models[0].model_type).toBe('chat');
    });

    test('空模型类型缺省为对话模型', () => {
        const setting = Setting.getSettingSchema().parse({
            models: [{ alias: 'legacy-empty', provider_name: 'p', model_name: 'm', model_type: '' }]
        });

        expect(setting.models[0].model_type).toBe('chat');
    });

    test('嵌入模型不会保留对话模型字段', () => {
        const setting = Setting.getSettingSchema().parse({
            models: [
                {
                    alias: 'embed',
                    provider_name: 'p',
                    model_name: 'm',
                    model_type: 'embedding',
                    reasoning_effort: 'high',
                    context_length: 1000
                }
            ]
        });

        expect(setting.models[0]).not.toHaveProperty('reasoning_effort');
        expect(setting.models[0]).not.toHaveProperty('context_length');
    });

    test('默认嵌入模型只接受 embedding 类型', () => {
        Setting.clearCache();
        Setting.updateInstanceData({
            default_embedding_model: 'legacy-chat',
            models: [{ alias: 'legacy-chat', provider_name: 'p', model_name: 'm' }]
        });

        expect(Setting.getInstance().getData().default_embedding_model).toBe('');

        Setting.updateInstanceData({
            default_embedding_model: 'embed',
            models: [{ alias: 'embed', provider_name: 'p', model_name: 'm', model_type: 'embedding' }]
        });

        expect(Setting.getInstance().getData().default_embedding_model).toBe('embed');
    });
});
