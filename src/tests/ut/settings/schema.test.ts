/**
 * Settings schema unit tests.
 */

import { Setting, setCustomOpendeskDirectory } from '../../../main/utils/setting';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('设置 schema', () => {
    test('JSON Schema describes editor input defaults rather than transformed runtime output', () => {
        const schema = Setting.getSettingJSONSchema() as {
            type: string;
            properties: {
                default_model: { type: string; default: string };
                models: { type: string };
            };
        };

        expect(schema.type).toBe('object');
        expect(schema.properties.default_model).toMatchObject({ type: 'string', default: '' });
        expect(schema.properties.models.type).toBe('array');
    });

    test('开发者模式默认关闭', () => {
        const setting = Setting.getSettingSchema().parse({});

        expect(setting.debug.developer_mode).toBe(false);
    });

    test('window_bounds 保留 is_maximized 字段（最大化状态持久化）', () => {
        const setting = Setting.getSettingSchema().parse({
            gui_config: {
                window_bounds: { x: 0, y: 0, width: 1920, height: 1080, is_maximized: true }
            }
        }) as { gui_config: { window_bounds: { is_maximized?: boolean } | null } };

        // zod object 默认 strip 未知字段，未声明时保存→读取链路会静默丢失该标志
        expect(setting.gui_config.window_bounds?.is_maximized).toBe(true);
    });

    test('window_bounds 缺省 is_maximized 时不注入默认值（历史配置兼容）', () => {
        const setting = Setting.getSettingSchema().parse({
            gui_config: {
                window_bounds: { x: 10, y: 20, width: 1200, height: 800 }
            }
        }) as { gui_config: { window_bounds: { is_maximized?: boolean } | null } };

        expect(setting.gui_config.window_bounds).toEqual({ x: 10, y: 20, width: 1200, height: 800 });
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
            log_raw_llm_request: false,
            debug_log: false
        });
    });

    test('实验性功能支持独立开关并补齐默认值', () => {
        const setting = Setting.getSettingSchema().parse({
            debug: {
                experimental_features: {
                    account: true
                }
            }
        });

        expect(setting.debug.experimental_features).toEqual({
            applications: {
                appmgr: false,
                agentoffice: false
            },
            account: true,
            immersive_desktop: false,
            builtin_terminal: false
        });
    });

    test('旧版实验性应用布尔值会被重置为关闭对象但不会导致载入失败', () => {
        const setting = Setting.getSettingSchema().parse({
            debug: {
                experimental_features: {
                    applications: true
                }
            }
        });

        expect(setting.debug.experimental_features?.applications).toEqual({ appmgr: false, agentoffice: false });
    });

    test('旧版试验性功能总开关会被丢弃且不影响新开关', () => {
        Setting.clearCache();
        Setting.updateInstanceData({
            debug: {
                developer_mode: false,
                experimental_feature: true
            }
        });

        expect(Setting.getInstance().getData().debug.experimental_features).toBeUndefined();
        expect((Setting.getInstance().getData().debug as any).experimental_feature).toBeUndefined();
    });

    test('终端 CLI 默认使用隔离 Python 环境', () => {
        const setting = Setting.getSettingSchema().parse({});

        expect(setting.cli_config.use_isolated_python).toBe(true);
        expect(setting.cli_config.inherit_venv).toBe(true);
        expect(setting.cli_config.output_display).toBe('minimal');
        expect(setting.cli_config.show_all_reasoning).toBe(false);
        expect(setting.cli_config.shortcuts.output_display).toBe('ctrl+o');
    });

    test('终端输出显示快捷键可以自定义', () => {
        const setting = Setting.getSettingSchema().parse({
            cli_config: {
                shortcuts: {
                    output_display: 'ctrl+u'
                }
            }
        });

        expect(setting.cli_config.shortcuts.output_display).toBe('ctrl+u');
    });

    test('终端输出显示统一使用 verbose 并迁移旧 full 配置', () => {
        const verboseSetting = Setting.getSettingSchema().parse({
            cli_config: { output_display: 'verbose' }
        });
        const legacySetting = Setting.getSettingSchema().parse({
            cli_config: { output_display: 'full' }
        });

        expect(verboseSetting.cli_config.output_display).toBe('verbose');
        expect(legacySetting.cli_config.output_display).toBe('verbose');
    });

    test('GUI 输出模式统一使用 verbose 并迁移旧 detailed/full 配置', () => {
        const defaultSetting = Setting.getSettingSchema().parse({});
        const verboseSetting = Setting.getSettingSchema().parse({
            gui_config: { output_mode: 'verbose' }
        });
        const legacyDetailedSetting = Setting.getSettingSchema().parse({
            gui_config: { output_mode: 'detailed' }
        });
        const legacyFullSetting = Setting.getSettingSchema().parse({
            gui_config: { output_mode: 'full' }
        });

        expect(defaultSetting.gui_config.output_mode).toBe('minimal');
        expect(verboseSetting.gui_config.output_mode).toBe('verbose');
        expect(legacyDetailedSetting.gui_config.output_mode).toBe('verbose');
        expect(legacyFullSetting.gui_config.output_mode).toBe('verbose');
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

    test('TUI 配置迁移 detailed 术语并接受 canonical verbose 值', () => {
        const detailed = Setting.getSettingSchema().parse({ cli_config: { output_display: 'detailed' } });
        const verbose = Setting.getSettingSchema().parse({ cli_config: { output_display: 'verbose' } });

        expect(detailed.cli_config.output_display).toBe('verbose');
        expect(verbose.cli_config.output_display).toBe('verbose');
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

    test('模型 timeout 缺省时为 undefined（按默认 300 秒处理）', () => {
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

describe('TUI 输出配置迁移', () => {
    let settingDirectory: string;

    beforeEach(() => {
        settingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-setting-migration-'));
        setCustomOpendeskDirectory(settingDirectory);
        Setting.clearCache();
    });

    afterEach(() => {
        Setting.clearCache();
        setCustomOpendeskDirectory(undefined);
        fs.rmSync(settingDirectory, { recursive: true, force: true });
    });

    function writeSetting(cliConfig: Record<string, unknown>): void {
        fs.writeFileSync(
            path.join(settingDirectory, 'setting.json'),
            JSON.stringify({ cli_config: cliConfig }),
            'utf8'
        );
    }

    test('旧 reason_display=full 在缺少 output_display 时迁移为 verbose 并写回配置', () => {
        writeSetting({ reason_display: 'full' });

        const setting = Setting.load();
        const persisted = JSON.parse(fs.readFileSync(path.join(settingDirectory, 'setting.json'), 'utf8'));

        expect(setting?.data.cli_config.output_display).toBe('verbose');
        expect(persisted.cli_config.output_display).toBe('verbose');
    });

    test('显式配置 minimal 时不受旧 reason_display=full 影响', () => {
        writeSetting({ reason_display: 'full', output_display: 'minimal' });

        expect(Setting.load()?.data.cli_config.output_display).toBe('minimal');
    });

    test('旧 reason_display=partial 在缺少 output_display 时使用 minimal 默认值', () => {
        writeSetting({ reason_display: 'partial' });

        expect(Setting.load()?.data.cli_config.output_display).toBe('minimal');
    });

    test.each([
        ['reason_display=on', { reason_display: 'on' }],
        ['show_all_reasoning=true', { show_all_reasoning: true }]
    ])('更早的完整 reasoning 配置 %s 也迁移为 verbose', (_label, cliConfig) => {
        writeSetting(cliConfig);

        expect(Setting.load()?.data.cli_config.output_display).toBe('verbose');
    });
});
