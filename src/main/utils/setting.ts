/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { z } from 'zod';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { workerData, isMainThread } from 'worker_threads';
import type { BaseApplication } from '../applications/base.js';
import { REASONING_EFFORT_VALUES, type ReasoningEffort } from '../aikernel/types/reasoning.js';
import { parseTokenCount, DEFAULT_MODEL_TIMEOUT_SECONDS } from '../../utils/model.js';
import { OUTPUT_DISPLAY_LEVELS } from '../../common/output-display.js';
import { getHostRuntime } from '../../platforms/runtime.js';
import {
    getHarmonyHomeDirectory,
    getHarmonyRuntimeEnvironment,
    getHarmonyWorkspaceDirectory
} from '../../platforms/bridges/harmonyos/runtime.js';

/**
 * 是否以 debug 模式运行（由 npm run start-debug 设置 OPENDESK_DEBUG_MODE=1）。
 * debug 模式使用独立的配置目录（默认目录追加 -debug 后缀），
 * 从而与主版本隔离单例锁、设置、日志与数据文件。
 */
function isOpendeskDebugMode(): boolean {
    const value = process.env.OPENDESK_DEBUG_MODE;
    return value === '1' || value === 'true';
}

/**
 * 解析可写的应用数据根目录（与主进程、Worker 通过 workerData 传入的路径一致）
 *
 * HarmonyOS 始终使用 ArkTS 注入的应用沙箱 filesDir。PC 用户家目录只用于用户文件，
 * 不能作为设置、日志或数据库等应用数据的存储根目录。
 */
function resolveWritableUserDataRoot(): string {
    const harmonyRuntime = getHarmonyRuntimeEnvironment();
    if (harmonyRuntime) {
        return harmonyRuntime.appDataDir;
    }
    if (customOpendeskDirectory) {
        return customOpendeskDirectory;
    }
    const cliConfigDirectory = getCliConfigDirectory();
    if (cliConfigDirectory) {
        return cliConfigDirectory;
    }
    // 环境变量优先级高于平台默认路径，用于 GUI 模式下绕过 npm/run-script-os 参数传递限制。
    // 兼容曾短暂发布过的 OPENDDESK 拼写，避免已有启动脚本失效。
    const envConfigDirectory = process.env.OPENDESK_CONFIG_DIRECTORY ?? process.env.OPENDDESK_CONFIG_DIRECTORY;
    if (envConfigDirectory) {
        return path.resolve(envConfigDirectory);
    }
    // debug 模式在平台默认路径上追加 -debug 后缀，确保与主版本的数据完全隔离
    const directorySuffix = isOpendeskDebugMode() ? '-debug' : '';
    if (process.env.APPDATA) {
        return path.join(process.env.APPDATA, `opendesk${directorySuffix}`);
    }
    if (process.env.HOME) {
        return path.join(process.env.HOME, `.opendesk${directorySuffix}`);
    }
    // 最终回退使用临时目录，避免依赖当前工作目录（cwd 可能指向无权限路径）
    return path.join(os.tmpdir(), `.opendesk${directorySuffix}`);
}

const ProviderSchema = z.object({
    name: z.string().default('openrouter').describe('模型提供商名称'),
    provider_type: z
        .preprocess(
            (value) => (value === '' || value === undefined || value === null ? 'openai' : value),
            z.enum(['openai', 'anthropic'])
        )
        .default('openai')
        .describe('模型提供商协议类型，旧配置留空时按 OpenAI 兼容格式处理'),
    base_url: z.string().default('https://openrouter.ai/api/v1').describe('模型提供商的 API 地址'),
    api_key: z.string().default('').describe('模型提供商的 API 密钥'),
    no_proxy: z.boolean().default(false).describe('是否禁用代理'),
    no_ssl: z.boolean().default(false).describe('是否跳过SSL证书校验'),
    enabled: z.boolean().optional().describe('是否启用该模型提供商；未配置时视为启用')
});

const ModelTypeSchema = z.preprocess(
    (value) => {
        if (value === '' || value === undefined || value === null) return 'chat';
        if (value === 'embed') return 'embedding';
        return value;
    },
    z.enum(['chat', 'embedding'])
);

const ReasoningEffortSchema = z
    .enum(REASONING_EFFORT_VALUES)
    .default('')
    .describe('模型默认推理模式(空字符串表示默认)');

const ModelBaseSchema = z.object({
    alias: z.string().default('model_alias').describe('模型别名(在本地配置中使用的名称)'),
    provider_name: z.string().default('openrouter').describe('模型提供商'),
    model_name: z.string().default('google/gemini-2.5-flash').describe('模型名称(在提供商一侧的名称)'),
    auto_parse_think_tags: z
        .boolean()
        .default(false)
        .describe('自动解析流式响应中的 <think> 标签（包括隐式闭合标签），将其分离为推理内容和可见回答'),
    custom_headers: z
        .record(z.string(), z.string())
        .optional()
        .describe('自定义 HTTP 请求头，在向模型服务器发送请求时携带'),
    timeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('模型请求超时时间(秒，不填则默认 300 秒)，超时后进入自动重试流程')
});

const ChatModelSchema = ModelBaseSchema.extend({
    model_type: z.literal('chat').describe('模型类型：对话模型'),
    reasoning_effort: ReasoningEffortSchema,
    context_length: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('模型上下文长度(token 数，0 或不填则由系统自动估算)'),
    max_output_tokens: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('模型最大输出 token 数(0 或不填则由系统自动估算)'),
    vision: z.boolean().optional().describe('是否支持视觉/图像输入；不填(undefined)则由系统自动识别')
});

const EmbeddingModelSchema = ModelBaseSchema.extend({
    model_type: z.literal('embedding').describe('模型类型：向量嵌入模型')
});

const ModelSchema = z.preprocess(
    (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return value;
        }
        const input = value as Record<string, unknown>;
        return {
            ...input,
            model_type: ModelTypeSchema.parse(input.model_type)
        };
    },
    z.discriminatedUnion('model_type', [ChatModelSchema, EmbeddingModelSchema])
);

type ModelType = z.infer<typeof ModelTypeSchema>;
export type ChatModel = z.infer<typeof ChatModelSchema>;
export type EmbeddingModel = z.infer<typeof EmbeddingModelSchema>;
type ProviderType = 'openai' | 'anthropic';
type NormalizedProviderType = ProviderType;

function normalizeProviderType(providerType: ProviderType | '' | undefined): NormalizedProviderType {
    return providerType === 'anthropic' ? 'anthropic' : 'openai';
}

function normalizeModelType(modelType: ModelType | 'embed' | '' | undefined): ModelType {
    return modelType === 'embedding' || modelType === 'embed' ? 'embedding' : 'chat';
}

function isChatModel(model: { model_type?: ModelType | '' | undefined }): model is ChatModel {
    return normalizeModelType(model.model_type) === 'chat';
}

function isEmbeddingModel(model: { model_type?: ModelType | '' | undefined }): model is EmbeddingModel {
    return normalizeModelType(model.model_type) === 'embedding';
}

const WindowBoundsSchema = z
    .object({
        x: z.number(),
        y: z.number(),
        width: z.number().min(400),
        height: z.number().min(300),
        is_maximized: z.boolean().optional().describe('上次退出时窗口是否处于最大化状态，缺省表示非最大化')
    })
    .nullable()
    .describe('上次退出时保存的窗口尺寸与位置， 表示从未保存');

const OutputDisplaySchema = z.preprocess(
    (value: unknown) => (value === 'full' || value === 'detailed' ? 'verbose' : value),
    z.enum(OUTPUT_DISPLAY_LEVELS).default('minimal')
);

const GUIConfigSchema = z.object({
    theme_preference: z
        .enum(['system', 'light', 'dark'])
        .optional()
        .default('system')
        .describe('界面主题: system=跟随系统, light=浅色, dark=深色'),
    scale_factor: z.number().min(0.5).max(2.0).optional().default(1).describe('GUI 缩放系数 (0.5 ~ 2.0)'),
    font_preset: z
        .enum(['default', 'lxgwwenkai'])
        .optional()
        .default('default')
        .describe('字体预设: default=系统默认, lxgwwenkai=霞鹜文楷'),
    ctrl_enter_send: z
        .boolean()
        .optional()
        .default(false)
        .describe('是否使用 Ctrl+Enter 发送消息（false 时按 Enter 发送）'),
    quick_capture_enabled: z
        .boolean()
        .optional()
        .describe('快速截图开关（HarmonyOS / Windows 的 Alt+Space 全局热键截图）: false=关闭, 未设置时视为开启'),
    recent_workspaces: z
        .array(z.string())
        .optional()
        .default([])
        .describe('最近使用的工作空间路径列表（最新在前，最多保留 20 个）'),
    window_bounds: WindowBoundsSchema.optional()
        .default(null)
        .describe('上次退出时保存的窗口尺寸与位置， 表示从未保存'),
    floating_window_position: z
        .enum(['top-left', 'top-right', 'bottom-left', 'bottom-right'])
        .optional()
        .default('bottom-right')
        .describe(
            '任务状态浮窗（card/pill）显示位置: top-left=左上角, top-right=右上角, bottom-left=左下角, bottom-right=右下角'
        ),
    sidebar_width: z.number().min(200).max(800).optional().default(320).describe('侧边栏宽度 (px)'),
    gui_reason_display: z
        .enum(['inline', 'bubble'])
        .optional()
        .default('inline')
        .describe('思考内容显示模式: inline=内联式, bubble=气泡式'),
    output_mode: OutputDisplaySchema.describe('GUI 输出模式: minimal=极简, verbose=详细'),
    memory_enabled: z
        .boolean()
        .optional()
        .default(true)
        .describe('长期记忆开关: false 时以 user-setting 身份禁用 memory 特性, 未设置时视为开启'),
    on_mainwindow_close: z
        .enum(['quit', 'minimize'])
        .optional()
        .describe('关闭主窗口时的行为: quit=退出应用, minimize=最小化, 未设置时每次询问'),
    floating_window_mode: z
        .enum(['pill', 'card', 'off'])
        .default('card')
        .describe('悬浮窗显示模式: pill=单行胶囊, card=完整卡片, off=关闭')
});

export const DEFAULT_SHORTCUTS = {
    switch_mode: 'ctrl+k',
    output_display: 'ctrl+o',
    switch_model: 'f2',
    clear_input: 'ctrl+c',
    endline: 'ctrl+j',
    show_help: 'ctrl+h',
    list_tasks: 'ctrl+l'
} as const;

const ShortcutsSchema = z.object({
    switch_mode: z.string().default(DEFAULT_SHORTCUTS.switch_mode).describe('模式切换'),
    output_display: z.string().default(DEFAULT_SHORTCUTS.output_display).describe('输出显示切换'),
    switch_model: z.string().default(DEFAULT_SHORTCUTS.switch_model).describe('模型切换'),
    endline: z.string().default(DEFAULT_SHORTCUTS.endline).describe('回车换行'),
    show_help: z.string().default(DEFAULT_SHORTCUTS.show_help).describe('打开帮助'),
    clear_input: z.string().default(DEFAULT_SHORTCUTS.clear_input).describe('删除输入内容'),
    list_tasks: z.string().default(DEFAULT_SHORTCUTS.list_tasks).describe('显示任务列表')
});

const LegacyReasonDisplaySchema = z.preprocess(
    (value: unknown) => {
        if (value === 'on') return 'full';
        if (value === 'off') return 'partial';
        return value;
    },
    z.enum(['full', 'partial']).default('partial')
);

const TerminalCliSchema = z.object({
    shortcuts: ShortcutsSchema.default({
        switch_mode: DEFAULT_SHORTCUTS.switch_mode,
        output_display: DEFAULT_SHORTCUTS.output_display,
        switch_model: DEFAULT_SHORTCUTS.switch_model,
        endline: DEFAULT_SHORTCUTS.endline,
        show_help: DEFAULT_SHORTCUTS.show_help,
        clear_input: DEFAULT_SHORTCUTS.clear_input,
        list_tasks: DEFAULT_SHORTCUTS.list_tasks
    }).describe('快捷键配置'),
    use_isolated_python: z.boolean().default(true).describe('是否在终端命令中使用 OpenDesk 隔离 Python 环境'),
    inherit_venv: z.boolean().default(true).describe('是否自动继承启动 OpenDesk 时的 Python 虚拟环境'),
    output_display: OutputDisplaySchema.describe('TUI 输出显示: minimal=聚合过程, verbose=详细时间线'),
    show_all_reasoning: z.boolean().default(false).describe('是否在 verbose 输出显示下展示全部 Reason 内容'),
    reason_display: LegacyReasonDisplaySchema.describe(
        'TUI Reason 显示配置，兼容旧版配置并参与 verbose 输出显示判断'
    ).default('partial')
});

const TaskSettingSchema = z.object({
    auto_retry: z.boolean().default(true).describe('LLM 请求失败时是否自动重试'),
    generate_taskname: z.boolean().default(true).describe('创建任务时是否自动生成任务名称'),
    termination_check: z.boolean().default(true).describe('是否自动检测并恢复异常中断的任务'),
    evidence_card: z.boolean().default(false).describe('是否启用 EvidenceCard 节省 Token 功能'),
    shell_path: z.string().default(''),
    shell_sandboxed: z.boolean().default(false),
    // Windows 仅 PowerShell 提供沙箱；Linux 上 bash/zsh 提供（LD_PRELOAD 版 dynobox）。
    // 删除送回收站在所有平台沙箱生效（Windows Detours / Linux LD_PRELOAD /
    // OH dynobox / macOS DYLD），统一回收站目录 <opendesk>/trash/<taskId>
    // 由宿主每次拉起传入。
    shell_sandbox_del_to_trash: z.boolean().default(false)
});

const NetworkConfigSchema = z.object({
    no_ssl: z.boolean().default(false).describe('跳过 SSL 证书校验（全局生效，优先级高于 Provider 级别的 no_ssl）'),
    use_proxy: z
        .enum(['system', 'custom', 'none'])
        .default('system')
        .describe('代理模式：system=系统代理, custom=自定义代理, none=无代理'),
    custom_proxy_addr: z.string().default('').describe('自定义代理地址（仅 use_proxy=custom 时生效）'),
    no_proxy: z.string().default('').describe('不走代理的地址列表，格式与标准 NO_PROXY 一致')
});

type Provider = z.infer<typeof ProviderSchema>;
export type Model = z.infer<typeof ModelSchema>;

const ExperimentalApplicationsSchema = z.preprocess(
    (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
    z
        .object({
            appmgr: z.boolean().default(false).describe('是否启用应用工坊'),
            agentoffice: z.boolean().default(false).describe('是否启用办公室')
        })
        .describe('实验性应用开关')
);

const ExperimentalFeaturesSchema = z
    .object({
        applications: ExperimentalApplicationsSchema,
        account: z.boolean().default(false).describe('是否启用账号功能'),
        immersive_desktop: z.boolean().default(false).describe('是否启用沉浸桌面'),
        builtin_terminal: z.boolean().default(false).describe('是否启用内置终端')
    })
    .describe('实验性功能开关');

const DebugModeSchema = z.object({
    developer_mode: z.boolean().default(false).describe('是否启用开发与调试'),
    experimental_features: ExperimentalFeaturesSchema.optional(),
    log_raw_llm_request: z
        .boolean()
        .default(false)
        .describe('仅当前运行记录原始模型响应（排除 embedding），重启后关闭'),
    debug_log: z.boolean().default(false).describe('是否开启调试日志（logger.debug 级别写入日志文件）')
});

function removeLegacyExperimentalFeature(settingRawObject: any): void {
    const debug = settingRawObject?.debug;
    if (!debug || typeof debug !== 'object') return;
    delete debug.experimental_feature;
}

const TelemetryEndpointSchema = z.object({
    name: z.string().default('').describe('端点名称，用于标识'),
    url: z.string().describe('OTLP HTTP 端点地址，如 http://localhost:4318/v1/traces'),
    protocol: z.enum(['opentelemetry']).default('opentelemetry').describe('遥测协议，当前仅支持 OpenTelemetry'),
    enabled: z.boolean().default(false).describe('是否启用此端点')
});

// 旧格式 string 端点不再兼容，在数组层面直接过滤掉
const TelemetryEndpointCompatSchema = z.preprocess((val) => {
    if (typeof val === 'object' && val !== null && !('protocol' in val)) {
        return { ...val, protocol: 'opentelemetry' };
    }
    return val;
}, TelemetryEndpointSchema);

const DEFAULT_OPENTELEMETRY_CONFIG = {
    endpoints: []
};

const OpenTelemetryConfigSchema = z
    .object({
        endpoints: z
            .preprocess(
                (val) => (Array.isArray(val) ? val.filter((ep: unknown) => typeof ep !== 'string') : val),
                z.array(TelemetryEndpointCompatSchema)
            )
            .default([])
            .describe('OTLP HTTP 端点列表')
    })
    .describe('OpenTelemetry 配置')
    .default(DEFAULT_OPENTELEMETRY_CONFIG);

const LangfuseEndpointSchema = z
    .object({
        name: z.string().default('').describe('端点名称，用于标识'),
        protocol: z.literal('langfuse').default('langfuse').describe('遥测协议'),
        enabled: z.boolean().default(false).describe('是否启用此 Langfuse 端点'),
        base_url: z.string().trim().default('').describe('Langfuse 服务地址，为空时使用官方云服务地址'),
        public_key: z.string().default('').describe('Langfuse 项目公钥'),
        secret_key: z.string().default('').describe('Langfuse 项目私钥'),
        export_mode: z.enum(['immediate', 'batched']).default('batched').describe('Langfuse span 导出模式'),
        flush_at: z.number().int().positive().default(50).describe('批量发送前最多累计的 span 数量'),
        flush_interval_seconds: z.number().int().positive().default(5).describe('批量发送的最长等待秒数')
    })
    .describe('Langfuse 端点配置');

const DEFAULT_LANGFUSE_CONFIG = {
    endpoints: [],
    environment: 'development',
    max_payload_chars: 20_000
};

const LangfuseConfigSchema = z
    .object({
        endpoints: z.array(LangfuseEndpointSchema).default([]).describe('Langfuse 端点列表'),
        environment: z.string().trim().min(1).default('development').describe('Langfuse 运行环境标识'),
        max_payload_chars: z.number().int().positive().default(20_000).describe('单个遥测字符串字段的最大字符数')
    })
    .describe('Langfuse 配置')
    .default(DEFAULT_LANGFUSE_CONFIG);

const TelemetrySchema = z
    .object({
        opentelemetry: OpenTelemetryConfigSchema,
        langfuse: LangfuseConfigSchema
    })
    .describe('遥测设置')
    .default({
        opentelemetry: DEFAULT_OPENTELEMETRY_CONFIG,
        langfuse: DEFAULT_LANGFUSE_CONFIG
    });

type TelemetryConfig = z.infer<typeof TelemetrySchema>;
type OpenTelemetryConfig = z.infer<typeof OpenTelemetryConfigSchema>;
type LangfuseConfig = z.infer<typeof LangfuseConfigSchema>;

const AccountConfigSchema = z
    .object({
        mode: z
            .enum(['personal', 'enterprise', 'nologin'])
            .default('nologin')
            .describe('账号登录方式: personal=个人账号, enterprise=企业账号, nologin=无账号登录'),
        default_base_url: z.string().default('').describe('个人账号默认后端地址(来自配置文件)'),
        enterprise_base_url: z.string().default('').describe('企业账号私有化部署后端地址(用户输入, 可留空)')
    })
    .default({
        mode: 'nologin',
        default_base_url: '',
        enterprise_base_url: ''
    });

export type AccountConfig = z.infer<typeof AccountConfigSchema>;

// Settings are loaded and may be saved before every application has registered its schema.
// Retain those sections until registration can validate them, including apps unavailable on this host.
let ApplicationConfigSchema = z.object({}).catchall(z.unknown());

function getSettingSchema() {
    return z.object({
        // 语言设置：auto 或 BCP-47 语言 tag（含插件语言包注册的语言，如 tr-TR）。
        // schema 只做格式校验，可用性由 locale/index.ts 的 resolveLocaleSetting 在运行时
        // 按语言包动态集合判定（语言包被卸载后残留值自动回退系统语言），避免把枚举写死。
        locale: z
            .union([z.literal('auto'), z.string().regex(/^[A-Za-z]{2,8}([-_][A-Za-z0-9]{2,8})*$/, 'BCP-47 tag')])
            .default('auto')
            .describe('语言设置: auto=跟随系统, 或 BCP-47 语言 tag（zh-CN/en-US 及语言包注册的语言）'),
        default_model: z.string().describe('在对话等场景中使用的默认模型').default(''),
        default_quick_model: z
            .string()
            .describe('在探索子任务、终止性判断、对话命名等轻量场景中使用的快速模型')
            .default(''),
        default_intent_parsing_model: z.string().describe('在意图解析中使用的多模态模型').default(''),
        default_embedding_model: z.string().describe('知识库，检索使用的中使用的向量嵌入模型').default(''),
        default_reranker_model: z.string().describe('在检索结果重排序中使用的模型').default(''),
        default_vision_model: z.string().describe('在图片记忆提取中使用的多模态模型').default(''),
        default_workspace: z.string().describe('默认工作空间目录路径(为空时使用临时工作空间)').default(''),
        debug: DebugModeSchema.describe('开发与调试设置').default({
            developer_mode: false,
            log_raw_llm_request: false,
            debug_log: false
        }),
        telemetry: TelemetrySchema,
        providers: z.array(ProviderSchema).describe('可用AI模型提供商').default([]),
        models: z.array(ModelSchema).describe('可用AI模型').default([]),
        builtin_models: z.array(ModelSchema).describe('内置虚拟模型（账号等，登录后拉取）').default([]),
        gui_config: GUIConfigSchema.describe('桌面 GUI 设置').default({
            theme_preference: 'system',
            scale_factor: 1,
            font_preset: 'default',
            ctrl_enter_send: false,
            recent_workspaces: [],
            window_bounds: null,
            floating_window_position: 'bottom-right',
            sidebar_width: 320,
            gui_reason_display: 'inline',
            output_mode: 'minimal',
            memory_enabled: true,
            floating_window_mode: 'card'
        }),
        cli_config: TerminalCliSchema.describe('终端 CLI 设置').default({
            shortcuts: {
                switch_mode: DEFAULT_SHORTCUTS.switch_mode,
                output_display: DEFAULT_SHORTCUTS.output_display,
                switch_model: DEFAULT_SHORTCUTS.switch_model,
                endline: DEFAULT_SHORTCUTS.endline,
                show_help: DEFAULT_SHORTCUTS.show_help,
                clear_input: DEFAULT_SHORTCUTS.clear_input,
                list_tasks: DEFAULT_SHORTCUTS.list_tasks
            },
            use_isolated_python: true,
            inherit_venv: true,
            output_display: 'minimal',
            show_all_reasoning: false,
            reason_display: 'partial'
        }),
        task_config: TaskSettingSchema.describe('任务设置').default({
            auto_retry: true,
            generate_taskname: true,
            termination_check: true,
            evidence_card: false,
            shell_path: '',
            shell_sandboxed: false,
            shell_sandbox_del_to_trash: false
        }),
        network_config: NetworkConfigSchema.describe('网络设置').default({
            no_ssl: false,
            use_proxy: 'system',
            custom_proxy_addr: '',
            no_proxy: ''
        }),
        environ: z
            .record(z.string(), z.string())
            .optional()
            .describe('全局环境变量，所有 shell 命令执行时共享')
            .default({}),
        // 权限配置独立校验，避免局部配置错误导致整个 setting.json 无法加载。
        permission: z.unknown().optional(),
        account_config: AccountConfigSchema.describe('账号接入配置'),
        applications: ApplicationConfigSchema.describe('OpenDesk应用相关配置').default({})
    });
}

export type SettingData = z.infer<ReturnType<typeof getSettingSchema>>;

export type DebugModeConfig = z.infer<typeof DebugModeSchema>;

export type BuiltinModelFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface BuiltinModelProvider {
    readonly providerName: string;
    resolveInstance(model: Model, expectedType?: ModelType): ModelInstance | null;
    refreshModels(fetchImpl?: BuiltinModelFetch): Promise<Model[]>;
}

function migrateLegacyTuiOutputDisplay(settingRawObject: unknown): boolean {
    if (!settingRawObject || typeof settingRawObject !== 'object' || Array.isArray(settingRawObject)) return false;
    const cliConfig = (settingRawObject as Record<string, unknown>).cli_config;
    if (!cliConfig || typeof cliConfig !== 'object' || Array.isArray(cliConfig)) return false;

    const rawCliConfig = cliConfig as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(rawCliConfig, 'output_display')) return false;
    const usedFullReasoning =
        rawCliConfig.reason_display === 'full' ||
        rawCliConfig.reason_display === 'on' ||
        rawCliConfig.show_all_reasoning === true;
    if (!usedFullReasoning) return false;

    rawCliConfig.output_display = 'verbose';
    return true;
}

export class ModelInstance {
    model_name: string;
    base_url: string;
    api_key: string;
    no_proxy: boolean;
    no_ssl: boolean;
    reasoning_effort: ReasoningEffort;
    context_length?: number;
    max_output_tokens?: number;
    vision?: boolean;
    auto_parse_think_tags: boolean;
    custom_headers?: Record<string, string>;
    provider_type: ProviderType;
    model_type: ModelType;
    provider_name: string;
    /** 模型请求超时时间（秒）；undefined 表示使用系统默认超时 */
    timeout?: number;

    /**
     * @param model_name 模型名称
     * @param base_url API 地址
     * @param api_key API 密钥
     * @param no_proxy 是否禁用代理
     * @param no_ssl 是否跳过SSL证书校验
     * @param reasoning_effort 模型默认推理模式
     * @param context_length 用户配置的上下文长度（>0 时覆盖系统估算）
     * @param max_output_tokens 用户配置的最大输出 token 数（>0 时覆盖系统估算）
     * @param vision 用户手动配置的视觉支持（undefined 表示由系统自动识别）
     * @param auto_parse_think_tags 是否自动解析流式响应中的 think 标签
     * @param custom_headers 自定义 HTTP 请求头
     * @param provider_type 提供商协议类型，空字符串表示 OpenAI 兼容格式
     * @param model_type 模型类型，旧配置留空时按对话模型处理
     * @param provider_name 提供商名称（如 "openrouter", "deepseek"），用于展示
     * @param timeout 用户配置的请求超时时间（秒，>0 时覆盖系统默认 300 秒）
     */
    constructor(
        model_name: string,
        base_url: string,
        api_key: string,
        no_proxy: boolean,
        no_ssl: boolean = false,
        reasoning_effort: ReasoningEffort = '',
        context_length?: number,
        max_output_tokens?: number,
        vision?: boolean,
        auto_parse_think_tags: boolean = false,
        custom_headers?: Record<string, string>,
        provider_type: ProviderType | '' | undefined = 'openai',
        model_type: ModelType | 'embed' | '' | undefined = 'chat',
        provider_name: string = '',
        timeout?: number
    ) {
        this.model_name = model_name;
        this.base_url = base_url;
        this.api_key = api_key;
        this.no_proxy = no_proxy;
        this.no_ssl = no_ssl;
        this.reasoning_effort = reasoning_effort;
        this.context_length = context_length && context_length > 0 ? context_length : undefined;
        this.max_output_tokens = max_output_tokens && max_output_tokens > 0 ? max_output_tokens : undefined;
        this.vision = vision;
        this.auto_parse_think_tags = auto_parse_think_tags;
        this.custom_headers = custom_headers;
        this.provider_type = normalizeProviderType(provider_type);
        this.model_type = normalizeModelType(model_type);
        this.provider_name = provider_name;
        this.timeout = timeout && timeout > 0 ? timeout : undefined;
    }

    /** 模型请求空闲超时时间（毫秒）；未配置时返回系统默认值 */
    getTimeoutMs(): number {
        return this.timeout && this.timeout > 0 ? this.timeout * 1000 : DEFAULT_MODEL_TIMEOUT_SECONDS * 1000;
    }

    getProviderType(): NormalizedProviderType {
        return normalizeProviderType(this.provider_type);
    }

    getProviderName(): string {
        return this.provider_name;
    }

    getModelType(): ModelType {
        return normalizeModelType(this.model_type);
    }
}

/** 通过环境变量覆盖默认对话模型时使用的环境变量名 */
export const ENV_DEFAULT_MODEL_NAME = 'OPENDESK_MODEL_NAME';
export const ENV_DEFAULT_MODEL_CONTEXT_LENGTH = 'OPENDESK_MODEL_CONTEXT_LENGTH';
export const ENV_DEFAULT_PROVIDER_BASE_URL = 'OPENDESK_PROVIDER_BASE_URL';
export const ENV_DEFAULT_PROVIDER_TYPE = 'OPENDESK_PROVIDER_TYPE';
export const ENV_DEFAULT_PROVIDER_API_KEY = 'OPENDESK_PROVIDER_API_KEY';

/**
 * 通过环境变量构造默认对话模型实例。
 * 仅当 OPENDESK_MODEL_NAME 存在时启用覆盖；其余变量可选，缺省使用空值/默认值。
 * 上下文长度留空或非法时返回 undefined，由系统自动估算。
 */
export function getEnvDefaultModelInstance(): ModelInstance | null {
    const modelName = process.env[ENV_DEFAULT_MODEL_NAME]?.trim();
    if (!modelName) {
        return null;
    }
    const providerType = process.env[ENV_DEFAULT_PROVIDER_TYPE]?.trim() === 'anthropic' ? 'anthropic' : 'openai';
    return new ModelInstance(
        modelName,
        process.env[ENV_DEFAULT_PROVIDER_BASE_URL]?.trim() ?? '',
        process.env[ENV_DEFAULT_PROVIDER_API_KEY]?.trim() ?? '',
        false,
        false,
        '',
        parseTokenCount(process.env[ENV_DEFAULT_MODEL_CONTEXT_LENGTH]),
        undefined,
        undefined,
        false,
        undefined,
        providerType,
        'chat',
        'env'
    );
}

/** 读取已有配置文件的权限位；文件不存在或不可读时返回 undefined */
function readExistingFileMode(filePath: string): number | undefined {
    try {
        return fs.statSync(filePath).mode & 0o777;
    } catch {
        return undefined;
    }
}

/** 新建 setting.json 时的权限位：配置含模型 API Key，不依赖 umask 的默认放宽 */
const SETTING_FILE_MODE = 0o600;

/** 临时文件残留阈值：保存本身是毫秒级，超过该时长必然是进程异常退出遗留 */
const STALE_SETTING_TEMPORARY_FILE_MS = 60 * 60 * 1000;

/**
 * 清理上次进程异常退出时残留的 setting.json 临时文件。
 * 只删除超过阈值的文件，避免误删并发进程（如同时运行的 CLI）正在写入的临时文件。
 */
function cleanupStaleSettingTemporaryFiles(settingDirectory: string): void {
    let entries: string[];
    try {
        entries = fs.readdirSync(settingDirectory);
    } catch {
        return;
    }
    for (const entry of entries) {
        if (!entry.startsWith('setting.json.') || !entry.endsWith('.tmp')) {
            continue;
        }
        const temporaryFile = path.join(settingDirectory, entry);
        try {
            if (Date.now() - fs.statSync(temporaryFile).mtimeMs > STALE_SETTING_TEMPORARY_FILE_MS) {
                fs.rmSync(temporaryFile, { force: true });
            }
        } catch {
            /* 并发进程可能已删除同名文件，忽略 */
        }
    }
}

export class Setting {
    static instance: Setting | null = null;
    static applicationConfigChangedCallbacks = new Map<string, () => void>();
    /** 全局回调：每次 setData 成功后调用，用于响应跨应用设置变更。 */
    static afterSetDataCallbacks: Array<(previousData: SettingData, nextData: SettingData) => void | Promise<void>> =
        [];
    /**
     * 记录设置加载时的错误消息。如果设置文件损坏或解析失败，会记录错误信息。
     * 应用启动后应检查此变量并通过模态弹窗提醒用户。
     */
    static _loadError: string | null = null;

    static builtinModelProvider: BuiltinModelProvider | null = null;

    data: SettingData;

    constructor() {
        this.data = getSettingSchema().parse({}) as SettingData;
    }

    getData(): SettingData {
        return this.data;
    }

    getApplicationConfig(applicationName: string): unknown {
        return this.data.applications[applicationName as keyof typeof this.data.applications];
    }

    setData(data: unknown): void {
        removeLegacyExperimentalFeature(data);
        const newSettingData = getSettingSchema().parse(data) as SettingData;
        const previousSettingData = this.data;
        const settingChangedApplications: string[] = [];

        if (ApplicationConfigSchema && 'shape' in ApplicationConfigSchema && ApplicationConfigSchema.shape) {
            const applicationNames = Object.keys(ApplicationConfigSchema.shape);
            for (const applicationName of applicationNames) {
                const newConfig = (newSettingData.applications as Record<string, unknown>)[applicationName];
                const oldConfig = (this.data.applications as Record<string, unknown>)[applicationName];
                const isEqual = JSON.stringify(newConfig) === JSON.stringify(oldConfig);
                if (!isEqual) {
                    settingChangedApplications.push(applicationName);
                }
            }
        }

        // 先规范化候选配置（清除失效的 default_*_model 引用），再落盘；
        // 只有写盘成功后才提交 this.data 并触发回调，避免保存失败时内存配置与磁盘状态分裂。
        this.normalizeDefaultModelReferences(newSettingData);
        this.save(newSettingData);

        this.data = newSettingData;

        // 全局回调：广播 setting:changed 到 renderer 等
        Setting.notifyDataCommitted(previousSettingData, this.data);

        if (settingChangedApplications.length > 0) {
            for (const applicationName of settingChangedApplications) {
                const callback = Setting.applicationConfigChangedCallbacks.get(applicationName);
                if (callback !== undefined) {
                    callback();
                }
            }
        }
    }

    /**
     * 通知全局订阅者（renderer 广播、Worker 网络配置同步、浮窗刷新）配置已提交。
     *
     * setData 与 updateAndSave 共用：两条写配置的路径都必须让订阅者看到新状态，
     * 否则会出现「配置已落盘，但界面和 Worker 仍在用旧值」的分裂。
     * 应用级回调（applicationConfigChangedCallbacks）需要新旧配置逐项对比，仍只在 setData 中触发。
     */
    private static notifyDataCommitted(previousData: SettingData, nextData: SettingData): void {
        for (const cb of Setting.afterSetDataCallbacks) {
            try {
                const result = cb(previousData, nextData);
                if (result && typeof result.catch === 'function') {
                    void result.catch(() => undefined);
                }
            } catch {
                /* best-effort */
            }
        }
    }

    /**
     * 事务式修改并保存配置：在内存副本上执行 mutator，落盘成功后才提交到 this.data。
     *
     * 与 setData 的区别：改动直接落在现有配置的 JSON 副本上，不用 schema 的规范化结果替换它
     * （不会 strip 未注册应用的配置、不会清理失效的 default_*_model 引用、不会填充默认值），
     * 也不触发需要新旧差异对比的应用级回调。落盘前只做一次 schema 校验，拒绝写出下次启动
     * 无法解析的配置。提交后与 setData 一样通知全局订阅者（renderer 广播等），避免
     * 「配置已落盘、界面却还在用旧值」。写盘失败时抛错，内存配置保持旧值。
     */
    updateAndSave(mutator: (draft: SettingData) => void): void {
        // 按 JSON 形状克隆；save 会排除仅当前运行有效的原始响应日志开关。
        const draft = JSON.parse(JSON.stringify(this.data)) as SettingData;
        mutator(draft);
        // 落盘前按 schema 校验一次（结果丢弃）：磁盘上的 setting.json 必须能被下次启动解析，
        // 否则会走 Setting._loadError 回落默认配置，用户整份设置丢失。
        // 特意不用 parse 结果替换 draft —— schema 只包含当前进程已注册的应用配置，
        // 拿它当提交值会 strip 掉未注册应用（如 TUI/CLI 进程里的其他应用）的配置。
        getSettingSchema().parse(draft);
        const previousData = this.data;
        this.save(draft);
        this.data = draft;
        Setting.notifyDataCommitted(previousData, this.data);
    }

    /**
     * Get the unique setting instance
     */
    static getInstance(): Setting {
        if (Setting.instance === null) {
            Setting.instance = Setting.load();
            if (Setting.instance === null) {
                // 加载失败，创建空设置实例
                Setting.instance = new Setting();
            }
        }
        return Setting.instance;
    }

    /**
     * 获取设置加载时的错误消息。如果有错误，应用启动后应提醒用户。
     * @returns 错误消息字符串，若无错误则返回 null
     */
    static getLoadError(): string | null {
        return Setting._loadError;
    }

    /**
     * 清除加载错误消息（通常在用户确认错误提示后调用）
     */
    static clearLoadError(): void {
        Setting._loadError = null;
    }

    static clearCache(): void {
        Setting.instance = null;
    }

    /**
     * Update the setting data directly (used by worker thread to sync settings from main thread)
     * @param data - The new setting data
     */
    static updateInstanceData(data: unknown): void {
        if (Setting.instance === null) {
            Setting.instance = new Setting();
        }
        removeLegacyExperimentalFeature(data);
        Setting.instance.data = getSettingSchema().parse(data) as SettingData;
        // Worker 不落盘，只就地规范化内存副本
        Setting.instance.normalizeDefaultModelReferences(Setting.instance.data);
    }

    /**
     * Register the application settings so that they can be managed and
     * edited from the system setting editor.
     * @param application - 应用实例
     * @param configChangedCallback - 配置变更时的回调
     */
    static registerApplicationSettings(application: BaseApplication, configChangedCallback: () => void): void {
        const applicationConfigSchema = (
            Object.getPrototypeOf(application).constructor as typeof BaseApplication
        ).getConfigSchema();
        ApplicationConfigSchema = ApplicationConfigSchema.extend({
            [application.bundleName]: applicationConfigSchema.optional()
        });
        Setting.applicationConfigChangedCallbacks.set(application.bundleName, configChangedCallback);
    }

    /**
     * Load the setting from the file system
     * @returns Setting 实例，若文件不存在或解析失败则返回 null
     */
    static load(): Setting | null {
        const settingDirectory = getOpendeskDirectory();
        const settingFile = path.join(settingDirectory, 'setting.json');
        // 启动时回收上次进程异常退出遗留的原子写临时文件
        cleanupStaleSettingTemporaryFiles(settingDirectory);
        if (!fs.existsSync(settingFile)) {
            return null;
        }

        let settingRawObject: unknown;
        try {
            const content = fs.readFileSync(settingFile, 'utf8');
            // 检查空文件
            if (!content || content.trim() === '') {
                Setting._loadError = 'Settings file is empty. Using default settings.';
                return null;
            }
            settingRawObject = JSON.parse(content);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            Setting._loadError = `Failed to parse settings file: ${message}. Using default settings.`;
            return null;
        }

        // Migration: rename legacy 'display' field to 'gui_config'
        if ((settingRawObject as any)?.display && !(settingRawObject as any)?.gui_config) {
            (settingRawObject as any).gui_config = (settingRawObject as any).display;
            delete (settingRawObject as any).display;
        }

        // Migration: move legacy top-level 'developer_mode' to 'debug.developer_mode'
        if (typeof (settingRawObject as any)?.developer_mode === 'boolean' && !(settingRawObject as any)?.debug) {
            const legacyDevMode = (settingRawObject as any).developer_mode;
            (settingRawObject as any).debug = { developer_mode: legacyDevMode };
            delete (settingRawObject as any).developer_mode;
        }

        removeLegacyExperimentalFeature(settingRawObject);
        // Migration: preserve full TUI output for users whose legacy reasoning setting showed full content.
        const migratedLegacyTuiOutputDisplay = migrateLegacyTuiOutputDisplay(settingRawObject);

        const setting = new Setting();
        try {
            setting.data = getSettingSchema().parse(settingRawObject) as SettingData;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            Setting._loadError = `Settings validation failed: ${message}. Using default settings.`;
            return null;
        }

        // 该开关是进程级调试状态：历史配置即使曾被写入，也不能在重启后重新启用。
        setting.data.debug.log_raw_llm_request = false;
        // 规范化默认模型引用（清除已不存在的模型别名），与遗留字段迁移合并成一次落盘
        const normalizedDefaultModels = setting.normalizeDefaultModelReferences(setting.data);
        if (normalizedDefaultModels || migratedLegacyTuiOutputDisplay) {
            setting.save();
        }
        return setting;
    }

    /**
     * Save the setting to the file system
     *
     * 使用「同目录临时文件 + fsync + rename」原子替换 setting.json：
     * 写入中途失败或进程崩溃时旧文件保持完整，不会留下半截配置。
     * @param data - 要持久化的配置数据，默认持久化当前内存数据
     */
    save(data: SettingData = this.data): void {
        const settingDirectory = getOpendeskDirectory();
        const settingFile = path.join(settingDirectory, 'setting.json');
        const temporaryFile = `${settingFile}.${process.pid}.${Date.now()}.tmp`;
        // 原始 LLM 响应日志只在当前进程有效，磁盘中始终保留关闭状态。
        const persistedData: SettingData = {
            ...data,
            debug: {
                ...data.debug,
                log_raw_llm_request: false
            }
        };
        // setting.json 含模型 API Key：替换时沿用原文件权限；首次创建也固定为 0600，
        // 不依赖 umask，避免含密钥的配置被创建成 0644
        const targetMode = readExistingFileMode(settingFile) ?? SETTING_FILE_MODE;
        try {
            fs.writeFileSync(temporaryFile, JSON.stringify(persistedData, null, 4), {
                encoding: 'utf8',
                flush: true,
                mode: targetMode
            });
            fs.renameSync(temporaryFile, settingFile);
        } catch (error) {
            try {
                fs.rmSync(temporaryFile, { force: true });
            } catch {
                /* 清理临时文件失败不掩盖原始错误 */
            }
            throw error;
        }
    }

    /**
     * Get the model instance by the model alias
     * @param model_alias - 模型别名
     * @returns ModelInstance 或 null
     */
    getModelInstance(model_alias: string, expectedType?: ModelType): ModelInstance | null {
        const modelRef = this.data.models.find((model: Model) => model.alias === model_alias);
        if (modelRef === undefined) {
            const builtinModel = this.data.builtin_models.find((model: Model) => model.alias === model_alias);
            return builtinModel
                ? (Setting.builtinModelProvider?.resolveInstance(builtinModel, expectedType) ?? null)
                : null;
        }
        if (expectedType !== undefined && modelRef.model_type !== expectedType) {
            return null;
        }
        const provider = this.data.providers.find((p: Provider) => p.name === modelRef.provider_name);
        if (provider === undefined) {
            return null;
        }
        return new ModelInstance(
            modelRef.model_name,
            provider.base_url,
            provider.api_key,
            provider.no_proxy,
            provider.no_ssl,
            isChatModel(modelRef) ? modelRef.reasoning_effort : '',
            isChatModel(modelRef) ? modelRef.context_length : undefined,
            isChatModel(modelRef) ? modelRef.max_output_tokens : undefined,
            isChatModel(modelRef) ? modelRef.vision : undefined,
            modelRef.auto_parse_think_tags ?? false,
            modelRef.custom_headers,
            provider.provider_type,
            modelRef.model_type,
            provider.name,
            modelRef.timeout
        );
    }

    /**
     * Get the default model instance, or null if not configured or not found.
     * 若配置了 OPENDESK_MODEL_NAME 等环境变量，则优先使用环境变量指定的默认对话模型。
     */
    getDefaultModelInstance(): ModelInstance | null {
        const envModel = getEnvDefaultModelInstance();
        if (envModel !== null) {
            return envModel;
        }
        if (!this.data.default_model) {
            return null;
        }
        return this.getModelInstance(this.data.default_model, 'chat');
    }

    /**
     * Get the default quick model instance (for lightweight tasks like explore, termination check, task naming).
     * Returns null if not configured or not found.
     */
    getDefaultQuickModelInstance(): ModelInstance | null {
        if (!this.data.default_quick_model) {
            return null;
        }
        return this.getModelInstance(this.data.default_quick_model, 'chat');
    }

    getDefaultEmbeddingModelInstance(): ModelInstance | null {
        if (!this.data.default_embedding_model) {
            return null;
        }
        return this.getModelInstance(this.data.default_embedding_model, 'embedding');
    }

    getDefaultRerankerModelInstance(): ModelInstance | null {
        if (!this.data.default_reranker_model) {
            return null;
        }
        return this.getModelInstance(this.data.default_reranker_model);
    }

    /**
     * Get the default intent parsing model instance, or null if not configured or not found
     */
    getDefaultIntentParsingModelInstance(): ModelInstance | null {
        if (!this.data.default_intent_parsing_model) {
            return null;
        }
        return this.getModelInstance(this.data.default_intent_parsing_model, 'chat');
    }

    static getSettingSchema(): ReturnType<typeof getSettingSchema> {
        return getSettingSchema();
    }

    static getSettingJSONSchema() {
        // Editors submit configuration input; ACP and plugin schemas may transform
        // that input into runtime values which JSON Schema cannot describe.
        return z.toJSONSchema(getSettingSchema(), { io: 'input' });
    }

    getDefaultVisionModelInstance(): ModelInstance | null {
        if (!this.data.default_vision_model) {
            return null;
        }
        return this.getModelInstance(this.data.default_vision_model, 'chat');
    }

    /**
     * 就地规范化传入配置里的 default_*_model 引用：
     * 把指向不存在的模型（或类型不匹配）的引用清空成空字符串，避免启动时因找不到默认模型而崩溃。
     *
     * 这是「规范化」而非只读校验——它会修改 target。落盘由调用方决定，本函数不写文件。
     * @param target - 要规范化的配置数据（可以是尚未提交的候选配置）
     * @returns 是否发生了改动
     */
    private normalizeDefaultModelReferences(target: SettingData): boolean {
        const modelTypes = new Map(target.models.map((m) => [m.alias, m.model_type] as const));
        const defaultModelFields = [
            { field: 'default_model', expectedType: 'chat' },
            { field: 'default_quick_model', expectedType: 'chat' },
            { field: 'default_embedding_model', expectedType: 'embedding' },
            { field: 'default_reranker_model', expectedType: undefined },
            { field: 'default_intent_parsing_model', expectedType: 'chat' },
            { field: 'default_vision_model', expectedType: 'chat' }
        ] as const;

        let changed = false;
        for (const { field, expectedType } of defaultModelFields) {
            const alias = target[field] as string;
            const providerName = Setting.builtinModelProvider?.providerName;
            // 内置虚拟模型（如账号内置模型）不在 models 列表中，不因缺失而清除引用；
            // 未登录时由解析层返回 null 做优雅降级。
            // 同时兼顾启动时序：provider 尚未注册（providerName 为空）时，只要该别名
            // 已持久化在 builtin_models 中，也应予以保留，避免默认模型引用被过早清除。
            const isBuiltinAlias =
                (providerName !== undefined && alias.startsWith(`${providerName}/`)) ||
                target.builtin_models.some((model) => model.alias === alias);
            if (alias && isBuiltinAlias) {
                continue;
            }
            const actualType = modelTypes.get(alias);
            if (alias && (!actualType || (expectedType !== undefined && actualType !== expectedType))) {
                (target as Record<string, unknown>)[field] = '';
                changed = true;
            }
        }

        return changed;
    }

    /**
     * 将工作空间路径添加到最近使用列表的头部（去重，上限 20）。
     */
    addRecentWorkspace(workspacePath: string): void {
        const MAX_RECENT = 20;
        const currentData = this.getData() as Record<string, unknown>;
        const guiConfig = (currentData.gui_config ?? {}) as Record<string, unknown>;
        let recent = Array.isArray(guiConfig.recent_workspaces) ? ([...guiConfig.recent_workspaces] as string[]) : [];
        recent = recent.filter((p) => p !== workspacePath);
        recent.unshift(workspacePath);
        if (recent.length > MAX_RECENT) recent = recent.slice(0, MAX_RECENT);
        guiConfig.recent_workspaces = recent;
        this.setData({ ...currentData, gui_config: guiConfig });
    }

    /**
     * 从最近使用列表中移除指定的工作空间路径。
     */
    removeRecentWorkspace(workspacePath: string): void {
        const currentData = this.getData() as Record<string, unknown>;
        const guiConfig = (currentData.gui_config ?? {}) as Record<string, unknown>;
        let recent = Array.isArray(guiConfig.recent_workspaces) ? ([...guiConfig.recent_workspaces] as string[]) : [];
        recent = recent.filter((p) => p !== workspacePath);
        guiConfig.recent_workspaces = recent;
        this.setData({ ...currentData, gui_config: guiConfig });
    }

    /**
     * 获取最近使用的工作空间路径列表。
     */
    getRecentWorkspaces(): string[] {
        const currentData = this.getData() as Record<string, unknown>;
        const guiConfig = (currentData.gui_config ?? {}) as Record<string, unknown>;
        return Array.isArray(guiConfig.recent_workspaces) ? (guiConfig.recent_workspaces as string[]) : [];
    }

    /**
     * 获取当前有效的工作空间路径。
     * 如果默认工作空间为空或目录不存在，则使用临时工作空间。
     */
    getEffectiveWorkspace(): string {
        const configuredPath = this.data.default_workspace as string;
        if (configuredPath && fs.existsSync(configuredPath)) {
            try {
                const stat = fs.statSync(configuredPath);
                if (stat.isDirectory()) {
                    return configuredPath;
                }
            } catch {
                // fall through to temp workspace
            }
        }
        return getTempWorkspaceDirectory();
    }
}

/** 用户通过 --config-directory 指定的自定义配置目录（主线程生效） */
let customOpendeskDirectory: string | undefined;

function getCliConfigDirectory(): string | undefined {
    const args = process.argv;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--config-directory') {
            const value = args[i + 1];
            return value ? path.resolve(value) : undefined;
        }
        if (arg.startsWith('--config-directory=')) {
            const value = arg.slice('--config-directory='.length);
            return value ? path.resolve(value) : undefined;
        }
    }
    return undefined;
}

/**
 * 设置自定义应用数据目录（由 CLI --config-directory 选项调用）
 */
function setCustomOpendeskDirectory(dir: string | undefined): void {
    customOpendeskDirectory = dir ? path.resolve(dir) : undefined;
}

/**
 * 获取默认的应用数据目录路径（不创建目录），供 CLI help 提示使用
 */
function getDefaultOpendeskDirectory(): string {
    const harmonyRuntime = getHarmonyRuntimeEnvironment();
    if (harmonyRuntime) {
        return harmonyRuntime.appDataDir;
    } else if (process.env.APPDATA) {
        return path.join(process.env.APPDATA, 'opendesk' + (isOpendeskDebugMode() ? '-debug' : ''));
    } else if (process.env.HOME) {
        return path.join(process.env.HOME, '.opendesk' + (isOpendeskDebugMode() ? '-debug' : ''));
    } else {
        return '<unknown>';
    }
}

/**
 * 获取应用数据目录
 */
function getOpendeskDirectory(): string {
    if (!isMainThread) {
        return (workerData as { paths: { opendeskDirectory: string } }).paths.opendeskDirectory;
    }

    const userDataPath = resolveWritableUserDataRoot();

    if (fs.existsSync(userDataPath)) {
        return userDataPath;
    } else {
        fs.mkdirSync(userDataPath, { recursive: true });
        return userDataPath;
    }
}

/**
 * 只读解析应用数据目录：与 getOpendeskDirectory 一致但不创建目录，目录不存在时
 * 返回 undefined。供序列化等「本应纯读」的判定路径使用，避免 toJSON 触发建目录副作用。
 */
function resolveOpendeskDirectoryReadOnly(): string | undefined {
    if (!isMainThread) {
        return (workerData as { paths: { opendeskDirectory: string } }).paths.opendeskDirectory;
    }

    const userDataPath = resolveWritableUserDataRoot();
    return fs.existsSync(userDataPath) ? userDataPath : undefined;
}

/**
 * 获取应用日志目录
 */
const _ensuredDirCache = new Set<string>();
function ensureDirectoryExists(directory: string): string {
    if (!_ensuredDirCache.has(directory)) {
        fs.mkdirSync(directory, { recursive: true });
        _ensuredDirCache.add(directory);
    }
    return directory;
}

/**
 * 获取临时工作空间目录。
 * - 宿主注入 defaultWorkspace 时优先使用；创建失败直接报错，不回退到其他存储。
 * - HarmonyOS PC: userHomeDir/Documents/OpenDesk（权限不足时回退到 userHomeDir/OpenDesk）
 * - HarmonyOS tablet: appDataDir/workspace
 * - Windows: $USERPROFILE/opendesk
 * - 类 Unix: $HOME/.opendesk/workspace
 */
function getTempWorkspaceDirectory(): string {
    const hostWorkspace = getHostRuntime().defaultWorkspace?.();
    if (hostWorkspace !== undefined) return ensureDirectoryExists(hostWorkspace);
    let workspacePath: string;
    const harmonyRuntime = getHarmonyRuntimeEnvironment();
    if (harmonyRuntime) {
        workspacePath = getHarmonyWorkspaceDirectory(harmonyRuntime);
        if (harmonyRuntime.userHomeDir) {
            try {
                return ensureDirectoryExists(workspacePath);
            } catch {
                workspacePath = path.posix.join(harmonyRuntime.userHomeDir, 'OpenDesk');
            }
        }
    } else if (process.platform === 'win32') {
        const userProfile = process.env.USERPROFILE || process.env.HOME || '';
        workspacePath = path.join(userProfile, 'opendesk');
    } else {
        workspacePath = path.join(getOpendeskDirectory(), 'workspace');
    }
    return ensureDirectoryExists(workspacePath);
}

function resolveArtifactDirectory(): string {
    return path.join(getOpendeskDirectory(), 'artifacts');
}

function getLogDirectory(): string {
    return ensureDirectoryExists(path.join(getOpendeskDirectory(), 'logs'));
}

/**
 * 获取应用任务目录
 */
function getTaskDirectory(): string {
    return ensureDirectoryExists(path.join(getOpendeskDirectory(), 'tasks'));
}

/**
 * 获取应用产物目录
 */
function getArtifactDirectory(): string {
    return ensureDirectoryExists(resolveArtifactDirectory());
}

/**
 * 获取任务级产物目录。
 * 默认在访问时创建 `artifacts/<taskId>/`，清理等仅读场景可显式关闭创建。
 */
function getTaskArtifactDirectory(taskId: string, ensureExists: boolean = true): string {
    const artifactDirectory = resolveArtifactDirectory();
    const taskArtifactDirectory = path.join(artifactDirectory, taskId);

    if (ensureExists) {
        ensureDirectoryExists(artifactDirectory);
        ensureDirectoryExists(taskArtifactDirectory);
    }

    return taskArtifactDirectory;
}

/**
 * 获取任务级工具结果目录 `artifacts/<taskId>/tool-results/`。
 * 默认在访问时创建目录，仅读场景可显式关闭创建。
 */
function getTaskToolResultDirectory(taskId: string, ensureExists: boolean = true): string {
    const taskArtifactDirectory = getTaskArtifactDirectory(taskId, ensureExists);
    const toolResultDirectory = path.join(taskArtifactDirectory, 'tool-results');

    if (ensureExists) {
        ensureDirectoryExists(toolResultDirectory);
    }

    return toolResultDirectory;
}

/**
 * 获取任务级 session memory 目录 `artifacts/<taskId>/session-memory/`。
 * 默认在访问时创建目录，仅读场景可显式关闭创建。
 */
function getTaskSessionMemoryDirectory(taskId: string, ensureExists: boolean = true): string {
    const taskArtifactDirectory = getTaskArtifactDirectory(taskId, ensureExists);
    const sessionMemoryDirectory = path.join(taskArtifactDirectory, 'session-memory');

    if (ensureExists) {
        ensureDirectoryExists(sessionMemoryDirectory);
    }

    return sessionMemoryDirectory;
}

/**
 * 获取任务级 session memory 文件路径 `artifacts/<taskId>/session-memory/session-memory.md`。
 */
function getTaskSessionMemoryPath(taskId: string, ensureExists: boolean = true): string {
    return path.join(getTaskSessionMemoryDirectory(taskId, ensureExists), 'session-memory.md');
}

/**
 * 统一回收站根目录的平台判定（纯逻辑，无 IO，便于单元测试）：
 * - 其他平台：`<opendeskDir>/trash/`（与用户文件通常同设备，rename 移动成立）；
 * - OpenHarmony：`<userHomeDir>/.opendesk-trash`（应用数据目录与用户文件分布在
 *   不同文件系统上，回收站若放 `<opendeskDir>/trash` 会因跨设备 rename（EXDEV）
 *   导致沙箱删除全部失败——见 BUG-031：任务级回收站跨设备）。
 * `opendeskDir` 为应用数据目录（OH 上即 appDataDir）；`home` 为用户家目录。
 */
export function resolveTrashRootDirectory(opendeskDir: string, home: string | undefined): string {
    // 分隔符按目标平台显式选择（win32 反斜杠、其余 POSIX 正斜杠），不随运行
    // 宿主的 path 模块漂移：同一输入在任何宿主上产出一致，单测可 mock 平台
    // 跨宿主断言（真实宿主上与 path.join 的结果逐字节相同）。
    if ((process.platform as string) === 'openharmony') {
        if (home) return path.posix.join(home, '.opendesk-trash');
    }
    if (process.platform === 'win32') {
        return path.win32.join(opendeskDir, 'trash');
    }
    return path.posix.join(opendeskDir, 'trash');
}

/**
 * 获取统一回收站根目录（平台判定见 resolveTrashRootDirectory）。
 * 各平台沙箱的删除回收统一落在这里（访问时创建，应用启动时也会显式创建）。
 */
function getTrashRootDirectory(): string {
    const runtime = getHarmonyRuntimeEnvironment();
    const home = runtime ? getHarmonyHomeDirectory(runtime) : process.env.HOME;
    return ensureDirectoryExists(resolveTrashRootDirectory(getOpendeskDirectory(), home));
}

/** 任务 ID 的合法性约束与 TaskManagerState 导入校验保持一致（防路径穿越）。 */
const TRASH_TASK_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * 获取任务级回收站目录（根目录见 getTrashRootDirectory，各平台取不同根）。
 * 沙箱删除的文件以 `<uuid>.back` + `summary.json` 的形式组织在该目录下，
 * 目录名即任务 ID（形如 task_xxx）。默认在访问时创建，仅读场景（清理扫描）
 * 可显式关闭创建。
 */
function getTaskTrashDirectory(taskId: string, ensureExists: boolean = true): string {
    if (!TRASH_TASK_ID_PATTERN.test(taskId)) {
        throw new Error(`invalid task id for trash directory: ${taskId}`);
    }
    const trashRoot = getTrashRootDirectory();
    const taskTrashDirectory = path.join(trashRoot, taskId);

    if (ensureExists) {
        ensureDirectoryExists(trashRoot);
        ensureDirectoryExists(taskTrashDirectory);
    }

    return taskTrashDirectory;
}

export type ShortcutsConfig = z.infer<typeof ShortcutsSchema>;

/**
 * 获取当前已配置的快捷键（带默认值回退）
 */
function getShortcuts(): ShortcutsConfig {
    const data = Setting.getInstance().getData();
    return (data as any).cli_config?.shortcuts ?? ShortcutsSchema.parse({});
}

function isDeveloperModeEnabled(): boolean {
    return !!Setting.getInstance().getData().debug?.developer_mode;
}

function isLogRawLlmRequestEnabled(): boolean {
    try {
        return !!Setting.getInstance().getData().debug?.log_raw_llm_request;
    } catch {
        return false;
    }
}

function setDeveloperModeEnabled(enabled: boolean): void {
    const setting = Setting.getInstance();
    const data = setting.getData();
    setting.setData({
        ...data,
        debug: {
            ...data.debug,
            developer_mode: enabled
        }
    });
}

function isDebugLogEnabled(): boolean {
    return !!Setting.getInstance().getData().debug?.debug_log;
}

function setDebugLogEnabled(enabled: boolean): void {
    const setting = Setting.getInstance();
    const data = setting.getData();
    setting.setData({
        ...data,
        debug: {
            ...data.debug,
            debug_log: enabled
        }
    });
}

export {
    getOpendeskDirectory,
    resolveOpendeskDirectoryReadOnly,
    getDefaultOpendeskDirectory,
    setCustomOpendeskDirectory,
    isOpendeskDebugMode,
    getLogDirectory,
    getTaskDirectory,
    getArtifactDirectory,
    getTaskArtifactDirectory,
    getTaskToolResultDirectory,
    getTaskSessionMemoryDirectory,
    getTaskSessionMemoryPath,
    getTrashRootDirectory,
    getTaskTrashDirectory,
    getTempWorkspaceDirectory,
    getSettingSchema,
    getShortcuts,
    isDeveloperModeEnabled,
    setDeveloperModeEnabled,
    isDebugLogEnabled,
    setDebugLogEnabled,
    isLogRawLlmRequestEnabled,
    TelemetrySchema,
    type TelemetryConfig,
    OpenTelemetryConfigSchema,
    type OpenTelemetryConfig,
    LangfuseConfigSchema,
    type LangfuseConfig,
    normalizeProviderType,
    normalizeModelType,
    isChatModel,
    isEmbeddingModel,
    ExperimentalFeaturesSchema,
    DebugModeSchema,
    type ReasoningEffort,
    type ModelType,
    type ProviderType,
    type NormalizedProviderType
};
