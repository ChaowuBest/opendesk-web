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
import { createRequire } from 'module';
import { workerData, isMainThread } from 'worker_threads';
import type { BaseApplication } from '../applications/base.js';

const require = createRequire(import.meta.url);

function tryElectronUserDataPath(): string | undefined {
    try {
        const electron = require('electron') as typeof import('electron');
        const p = electron.app?.getPath?.('userData');
        return typeof p === 'string' && p.length > 0 ? p : undefined;
    } catch {
        return undefined;
    }
}

/**
 * 解析可写的应用数据根目录（与主进程、Worker 通过 workerData 传入的路径一致）
 *
 * OpenHarmony 上 HOME / APPDATA 均不存在，优先使用 USER_DATA_PATH（由 main.js 在启动时
 * 通过 app.getPath('userData') 注入）。若该环境变量也未设置，则尝试 Electron API、
 * os.homedir()、os.tmpdir() 等作为回退。
 */
function resolveWritableUserDataRoot(): string {
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
    if ((process.platform as string) === 'openharmony' && process.env.USER_DATA_PATH) {
        return process.env.USER_DATA_PATH;
    }
    if (process.env.APPDATA) {
        return path.join(process.env.APPDATA, 'opendesk');
    }
    if (process.env.HOME) {
        return path.join(process.env.HOME, '.opendesk');
    }
    const fromElectron = tryElectronUserDataPath();
    if (fromElectron) {
        return fromElectron;
    }

    // OpenHarmony 回退：HOME/APPDATA 不存在时，尝试 os.homedir() 和 os.tmpdir()
    if ((process.platform as string) === 'openharmony') {
        try {
            const home = os.homedir();
            if (home && home !== '/' && fs.existsSync(home)) {
                return path.join(home, '.opendesk');
            }
        } catch {
            /* os.homedir() 可能在沙箱环境中不可用 */
        }
        return path.join(os.tmpdir(), '.opendesk');
    }

    // 最终回退使用临时目录，避免依赖当前工作目录（cwd 可能指向无权限路径）
    return path.join(os.tmpdir(), '.opendesk');
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
    .enum(['', 'none', 'low', 'medium', 'high', 'max'])
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
        .describe('自定义 HTTP 请求头，在向模型服务器发送请求时携带')
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

/** 控制模型推理深度，空字符串表示使用模型默认值 */
type ReasoningEffort = '' | 'none' | 'low' | 'medium' | 'high' | 'max';
type ModelType = z.infer<typeof ModelTypeSchema>;
type ChatModel = z.infer<typeof ChatModelSchema>;
type EmbeddingModel = z.infer<typeof EmbeddingModelSchema>;
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
        height: z.number().min(300)
    })
    .nullable()
    .describe('上次退出时保存的窗口尺寸与位置， 表示从未保存');

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
    recent_workspaces: z
        .array(z.string())
        .optional()
        .default([])
        .describe('最近使用的工作空间路径列表（最新在前，最多保留 20 个）'),
    window_bounds: WindowBoundsSchema.optional()
        .default(null)
        .describe('上次退出时保存的窗口尺寸与位置， 表示从未保存'),
    sidebar_width: z.number().min(200).max(800).optional().default(320).describe('侧边栏宽度 (px)'),
    gui_reason_display: z
        .enum(['inline', 'bubble'])
        .optional()
        .default('inline')
        .describe('思考内容显示模式: inline=内联式, bubble=气泡式'),
    on_mainwindow_close: z
        .enum(['quit', 'minimize'])
        .optional()
        .describe('关闭主窗口时的行为: quit=退出应用, minimize=最小化, 未设置时每次询问'),
    floating_window_mode: z
        .enum(['pill', 'card'])
        .optional()
        .describe('悬浮窗显示模式: pill=单行胶囊, card=完整卡片, 未设置=关闭')
});

export const DEFAULT_SHORTCUTS = {
    switch_mode: 'ctrl+k',
    switch_model: 'f2',
    clear_input: 'ctrl+c',
    endline: 'ctrl+j',
    show_help: 'ctrl+h',
    list_tasks: 'ctrl+l'
} as const;

const ShortcutsSchema = z.object({
    switch_mode: z.string().default(DEFAULT_SHORTCUTS.switch_mode).describe('模式切换'),
    switch_model: z.string().default(DEFAULT_SHORTCUTS.switch_model).describe('模型切换'),
    endline: z.string().default(DEFAULT_SHORTCUTS.endline).describe('回车换行'),
    show_help: z.string().default(DEFAULT_SHORTCUTS.show_help).describe('打开帮助'),
    clear_input: z.string().default(DEFAULT_SHORTCUTS.clear_input).describe('删除输入内容'),
    list_tasks: z.string().default(DEFAULT_SHORTCUTS.list_tasks).describe('显示任务列表')
});

/** 思考区显示模式；兼容旧配置 on/off */
const ReasonDisplaySchema = z.preprocess(
    (val: unknown) => {
        if (val === 'on') return 'full';
        if (val === 'off') return 'partial';
        return val;
    },
    z.enum(['full', 'partial']).default('partial')
);

const TerminalCliSchema = z.object({
    shortcuts: ShortcutsSchema.default({
        switch_mode: DEFAULT_SHORTCUTS.switch_mode,
        switch_model: DEFAULT_SHORTCUTS.switch_model,
        endline: DEFAULT_SHORTCUTS.endline,
        show_help: DEFAULT_SHORTCUTS.show_help,
        clear_input: DEFAULT_SHORTCUTS.clear_input,
        list_tasks: DEFAULT_SHORTCUTS.list_tasks
    }).describe('快捷键配置'),
    use_isolated_python: z.boolean().default(true).describe('是否在终端命令中使用 OpenDesk 隔离 Python 环境'),
    inherit_venv: z.boolean().default(true).describe('是否自动继承启动 OpenDesk 时的 Python 虚拟环境'),
    reason_display: ReasonDisplaySchema.describe(
        '思考内容显示模式: full=完整 Markdown, partial=仅显示末尾若干行(流式与结束后一致)'
    ).default('partial')
});

const TaskSettingSchema = z.object({
    auto_retry: z.boolean().default(true).describe('LLM 请求失败时是否自动重试'),
    generate_taskname: z.boolean().default(true).describe('创建任务时是否自动生成任务名称'),
    termination_check: z.boolean().default(true).describe('是否自动检测并恢复异常中断的任务'),
    evidence_card: z.boolean().default(false).describe('是否启用 EvidenceCard 节省 Token 功能')
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
type Model = z.infer<typeof ModelSchema>;

const DebugModeSchema = z.object({
    developer_mode: z.boolean().default(false).describe('是否启用开发者模式'),
    experimental_feature: z.boolean().default(false).describe('是否启用试验性功能'),
    log_raw_llm_request: z.boolean().default(false).describe('将原始LLM响应计入日志')
});

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

let ApplicationConfigSchema: z.ZodObject<z.ZodRawShape> = z.object({});

function getSettingSchema(): z.ZodObject<z.ZodRawShape> {
    return z.object({
        locale: z
            .enum(['auto', 'zh-CN', 'en-US'])
            .default('auto')
            .describe('语言设置: auto=跟随系统, zh-CN=中文, en-US=英文'),
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
        debug: DebugModeSchema.describe('调试模式设置').default({
            developer_mode: false,
            experimental_feature: false,
            log_raw_llm_request: false
        }),
        telemetry: TelemetrySchema,
        providers: z.array(ProviderSchema).describe('可用AI模型提供商').default([]),
        models: z.array(ModelSchema).describe('可用AI模型').default([]),
        gui_config: GUIConfigSchema.describe('桌面 GUI 设置').default({
            theme_preference: 'system',
            scale_factor: 1,
            font_preset: 'default',
            ctrl_enter_send: false,
            window_bounds: null,
            sidebar_width: 320,
            gui_reason_display: 'inline',
            floating_window_mode: 'card'
        }),
        cli_config: TerminalCliSchema.describe('终端 CLI 设置').default({
            shortcuts: {
                switch_mode: DEFAULT_SHORTCUTS.switch_mode,
                switch_model: DEFAULT_SHORTCUTS.switch_model,
                endline: DEFAULT_SHORTCUTS.endline,
                show_help: DEFAULT_SHORTCUTS.show_help,
                clear_input: DEFAULT_SHORTCUTS.clear_input,
                list_tasks: DEFAULT_SHORTCUTS.list_tasks
            },
            use_isolated_python: true,
            inherit_venv: true,
            reason_display: 'partial'
        }),
        task_config: TaskSettingSchema.describe('任务设置').default({
            auto_retry: true,
            generate_taskname: true,
            termination_check: true,
            evidence_card: false
        }),
        network_config: NetworkConfigSchema.describe('网络设置').default({
            no_ssl: false,
            use_proxy: 'none',
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
        applications: ApplicationConfigSchema.describe('OpenDesk应用相关配置').default({})
    });
}

export type SettingData = z.infer<ReturnType<typeof getSettingSchema>>;

export type DebugModeConfig = z.infer<typeof DebugModeSchema>;

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
        provider_name: string = ''
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

export class Setting {
    static instance: Setting | null = null;
    static applicationConfigChangedCallbacks = new Map<string, () => void>();
    /** 全局回调：每次 setData 成功后调用，用于广播 setting:changed 到 renderer */
    static afterSetDataCallbacks: (() => void)[] = [];
    /**
     * 记录设置加载时的错误消息。如果设置文件损坏或解析失败，会记录错误信息。
     * 应用启动后应检查此变量并通过模态弹窗提醒用户。
     */
    static _loadError: string | null = null;

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
        const newSettingData = getSettingSchema().parse(data) as SettingData;
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

        this.data = newSettingData;
        this.validateDefaultModels(false);
        this.save();

        // 全局回调：广播 setting:changed 到 renderer 等
        for (const cb of Setting.afterSetDataCallbacks) {
            try {
                cb();
            } catch {
                /* best-effort */
            }
        }

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
        Setting.instance.data = getSettingSchema().parse(data) as SettingData;
        Setting.instance.validateDefaultModels(false);
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
        }) as z.ZodObject<z.ZodRawShape>;
        Setting.applicationConfigChangedCallbacks.set(application.bundleName, configChangedCallback);
    }

    /**
     * Load the setting from the file system
     * @returns Setting 实例，若文件不存在或解析失败则返回 null
     */
    static load(): Setting | null {
        const settingDirectory = getOpendeskDirectory();
        const settingFile = path.join(settingDirectory, 'setting.json');
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
            (settingRawObject as any).debug = { developer_mode: legacyDevMode, experimental_feature: false };
            delete (settingRawObject as any).developer_mode;
        }

        const setting = new Setting();
        try {
            setting.data = getSettingSchema().parse(settingRawObject) as SettingData;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            Setting._loadError = `Settings validation failed: ${message}. Using default settings.`;
            return null;
        }

        // 校验默认模型引用，清除已不存在的模型别名
        setting.validateDefaultModels();
        return setting;
    }

    /**
     * Save the setting to the file system
     */
    save(): void {
        const settingDirectory = getOpendeskDirectory();
        const settingFile = path.join(settingDirectory, 'setting.json');
        fs.writeFileSync(settingFile, JSON.stringify(this.data, null, 4), { encoding: 'utf8' });
    }

    /**
     * Get the model instance by the model alias
     * @param model_alias - 模型别名
     * @returns ModelInstance 或 null
     */
    getModelInstance(model_alias: string, expectedType?: ModelType): ModelInstance | null {
        const modelRef = this.data.models.find((model: Model) => model.alias === model_alias);
        if (modelRef === undefined) {
            return null;
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
            provider.name
        );
    }

    /**
     * Get the default model instance, or null if not configured or not found
     */
    getDefaultModelInstance(): ModelInstance | null {
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

    getDefaultVisionModelInstance(): ModelInstance | null {
        if (!this.data.default_vision_model) {
            return null;
        }
        return this.getModelInstance(this.data.default_vision_model, 'chat');
    }

    /**
     * 校验所有 default_*_model 字段是否指向有效的模型别名，
     * 将无效的引用自动清除为空字符串，避免启动时因找不到默认模型而崩溃。
     */
    private validateDefaultModels(saveChanges = true): void {
        const modelTypes = new Map(this.data.models.map((m) => [m.alias, m.model_type] as const));
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
            const alias = this.data[field] as string;
            const actualType = modelTypes.get(alias);
            if (alias && (!actualType || (expectedType !== undefined && actualType !== expectedType))) {
                (this.data as Record<string, unknown>)[field] = '';
                changed = true;
            }
        }

        if (changed && saveChanges) {
            this.save();
        }
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
    if (process.env.APPDATA) {
        return path.join(process.env.APPDATA, 'opendesk');
    } else if (process.env.HOME) {
        return path.join(process.env.HOME, '.opendesk');
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
 * - OpenHarmony: /storage/Users/currentUser/Documents/OpenDesk（权限不足时回退到家目录下的 OpenDesk）
 * - Windows: $USERPROFILE/opendesk
 * - 类 Unix: $HOME/.opendesk/workspace
 */
function getTempWorkspaceDirectory(): string {
    let workspacePath: string;
    if ((process.platform as string) === 'openharmony') {
        workspacePath = '/storage/Users/currentUser/Documents/OpenDesk';
        try {
            return ensureDirectoryExists(workspacePath);
        } catch {
            // Documents 目录可能因权限不足而不可写（用户未授权），
            // 回退到家目录下的 OpenDesk 目录
            workspacePath = '/storage/Users/currentUser/OpenDesk';
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

export {
    getOpendeskDirectory,
    getDefaultOpendeskDirectory,
    setCustomOpendeskDirectory,
    getLogDirectory,
    getTaskDirectory,
    getArtifactDirectory,
    getTaskArtifactDirectory,
    getTaskToolResultDirectory,
    getTaskSessionMemoryDirectory,
    getTaskSessionMemoryPath,
    getTempWorkspaceDirectory,
    getSettingSchema,
    getShortcuts,
    isDeveloperModeEnabled,
    setDeveloperModeEnabled,
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
    DebugModeSchema,
    type ReasoningEffort,
    type ModelType,
    type Model,
    type ChatModel,
    type EmbeddingModel,
    type ProviderType,
    type NormalizedProviderType,
    type SettingData,
    type DebugModeConfig
};
