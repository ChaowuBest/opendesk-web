/**
 * Settings schema unit tests.
 */

import { Setting } from '../../../main/utils/setting';

describe('设置 schema', () => {
    test('开发者模式默认关闭', () => {
        const setting = Setting.getSettingSchema().parse({});

        expect(setting.debug.developer_mode).toBe(false);
    });

    test('Langfuse 遥测默认关闭并提供安全的运行默认值', () => {
        const setting = Setting.getSettingSchema().parse({});

        expect(setting.telemetry.opentelemetry).toEqual({
            endpoints: []
        });
        expect(setting.telemetry.langfuse).toEqual({
            endpoints: [],
            environment: 'development',
            max_payload_chars: 20_000
        });
    });

    test('OpenTelemetry 配置通过独立 schema 校验并补齐端点默认字段', () => {
        const setting = Setting.getSettingSchema().parse({
            telemetry: {
                opentelemetry: {
                    endpoints: [
                        {
                            url: 'http://localhost:4318/v1/traces',
                            enabled: true
                        },
                        'http://legacy-endpoint'
                    ]
                }
            }
        });

        expect(setting.telemetry.opentelemetry).toEqual({
            endpoints: [
                {
                    name: '',
                    url: 'http://localhost:4318/v1/traces',
                    protocol: 'opentelemetry',
                    enabled: true
                }
            ]
        });
    });

    test('Langfuse 多端点配置补齐每个端点的默认字段', () => {
        const setting = Setting.getSettingSchema().parse({
            telemetry: {
                langfuse: {
                    endpoints: [
                        {
                            name: 'cloud',
                            enabled: true,
                            public_key: 'pk-cloud',
                            secret_key: 'sk-cloud'
                        },
                        {
                            name: 'internal',
                            enabled: false,
                            base_url: 'https://langfuse.example.com'
                        }
                    ]
                }
            }
        });

        expect(setting.telemetry.langfuse.endpoints).toEqual([
            {
                name: 'cloud',
                protocol: 'langfuse',
                enabled: true,
                base_url: '',
                public_key: 'pk-cloud',
                secret_key: 'sk-cloud',
                export_mode: 'batched',
                flush_at: 50,
                flush_interval_seconds: 5
            },
            {
                name: 'internal',
                protocol: 'langfuse',
                enabled: false,
                base_url: 'https://langfuse.example.com',
                public_key: '',
                secret_key: '',
                export_mode: 'batched',
                flush_at: 50,
                flush_interval_seconds: 5
            }
        ]);
        expect(setting.telemetry.langfuse).toMatchObject({
            environment: 'development',
            max_payload_chars: 20_000
        });
    });

    test('调试设置使用共享结构并默认关闭实验功能', () => {
        const setting = Setting.getSettingSchema().parse({
            debug: {
                developer_mode: true
            }
        });

        expect(setting.debug).toEqual({
            developer_mode: true,
            experimental_feature: false,
            log_raw_llm_request: false
        });
    });

    test('终端 CLI 默认使用隔离 Python 环境', () => {
        const setting = Setting.getSettingSchema().parse({});

        expect(setting.cli_config.use_isolated_python).toBe(true);
        expect(setting.cli_config.inherit_venv).toBe(true);
    });

    test('网络配置缺省时默认使用系统代理', () => {
        const setting = Setting.getSettingSchema().parse({});

        expect(setting.network_config.use_proxy).toBe('system');
    });

    test('悬浮窗模式缺省时为完整卡片，且支持显式关闭', () => {
        const setting = Setting.getSettingSchema().parse({});
        expect(setting.gui_config.floating_window_mode).toBe('card');

        const off = Setting.getSettingSchema().parse({
            gui_config: { floating_window_mode: 'off' }
        });
        expect(off.gui_config.floating_window_mode).toBe('off');
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

    test('EvidenceCard 在任务配置整体缺省时也默认为关闭', () => {
        const setting = Setting.getSettingSchema().parse({});

        expect(setting.task_config.evidence_card).toBe(false);
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

    test('对话模型推理档位支持 max', () => {
        const setting = Setting.getSettingSchema().parse({
            models: [
                {
                    alias: 'chat',
                    provider_name: 'p',
                    model_name: 'm',
                    model_type: 'chat',
                    reasoning_effort: 'max'
                }
            ]
        });

        expect(setting.models[0].reasoning_effort).toBe('max');
    });

    test('对话模型推理档位缺省为空字符串', () => {
        const setting = Setting.getSettingSchema().parse({
            models: [{ alias: 'chat', provider_name: 'p', model_name: 'm', model_type: 'chat' }]
        });

        expect(setting.models[0].reasoning_effort).toBe('');
    });

    test('模型 timeout 缺省时为 undefined（按默认 60 秒处理）', () => {
        const setting = Setting.getSettingSchema().parse({
            models: [{ alias: 'chat', provider_name: 'p', model_name: 'm', model_type: 'chat' }]
        });

        expect(setting.models[0].timeout).toBeUndefined();
    });

    test('模型 timeout 支持正整数秒，嵌入模型同样可配置', () => {
        const setting = Setting.getSettingSchema().parse({
            models: [
                { alias: 'chat', provider_name: 'p', model_name: 'm', model_type: 'chat', timeout: 120 },
                { alias: 'embed', provider_name: 'p', model_name: 'm', model_type: 'embedding', timeout: 30 }
            ]
        });

        expect(setting.models[0].timeout).toBe(120);
        expect(setting.models[1].timeout).toBe(30);
    });

    test('模型 timeout 非正整数时解析失败', () => {
        for (const timeout of [0, -1, 1.5]) {
            expect(() =>
                Setting.getSettingSchema().parse({
                    models: [{ alias: 'chat', provider_name: 'p', model_name: 'm', model_type: 'chat', timeout }]
                })
            ).toThrow();
        }
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
