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
import type {
    BaseAssistantMessage,
    AssistantMessagePart,
    ChatContextSnapshot,
    ChatMessage,
    BaseChatToolCall,
    CompactBoundaryMetadata,
    CompactBoundaryStrategy,
    CompactBoundaryTrigger,
    BaseCompactSeparatorMessage,
    CompactSummarizedRange,
    BaseErrorMessagePart,
    BaseFileMessagePart,
    BaseImageMessagePart,
    BaseReasoningMessagePart,
    RuntimeMetadata,
    BaseSystemMessage,
    BaseTextMessagePart,
    BaseToolCallMessagePart,
    ToolCallMicrocompactMetadata,
    ToolResultStorageMetadata,
    BaseUsage,
    BaseUserMessage,
    UserMessagePart,
    PermissionAction,
    PermissionEffect,
    PermissionRequest,
    PermissionResourceType,
    PermissionRule,
    AgentDefinition,
    ReasoningEffort,
    ToolDefinition,
    ToolExecutionContext,
    ToolExecutionResult,
    ToolRenderContent,
    ToolRenderContext,
    ToolRenderers,
    ToolResultWriter
} from '../../../src/main/aikernel/types/index.js';

export type {
    BaseAssistantMessage,
    AssistantMessagePart,
    ChatContextSnapshot,
    ChatMessage,
    BaseChatToolCall,
    CompactBoundaryMetadata,
    CompactBoundaryStrategy,
    CompactBoundaryTrigger,
    BaseCompactSeparatorMessage,
    CompactSummarizedRange,
    BaseErrorMessagePart,
    BaseFileMessagePart,
    BaseImageMessagePart,
    BaseReasoningMessagePart,
    RuntimeMetadata,
    BaseSystemMessage,
    BaseTextMessagePart,
    BaseToolCallMessagePart,
    ToolCallMicrocompactMetadata,
    ToolResultStorageMetadata,
    BaseUsage,
    BaseUserMessage,
    UserMessagePart,
    PermissionAction,
    PermissionEffect,
    PermissionRequest,
    PermissionResourceType,
    PermissionRule,
    AgentDefinition,
    ReasoningEffort,
    ToolDefinition,
    ToolExecutionContext,
    ToolExecutionResult,
    ToolRenderContent,
    ToolRenderContext,
    ToolRenderers,
    ToolResultWriter
};

export const OPENDESK_PLUGIN_API_VERSION = 1;

export const OPENDESK_PLUGIN_CAPABILITIES = [
    'hook',
    'tool',
    'skill',
    'mcp',
    'command',
    'event',
    'agent',
    'browser',
    'channel',
    'account',
    'appearance',
    'registry'
] as const;

export type PluginCapability = (typeof OPENDESK_PLUGIN_CAPABILITIES)[number];

export const OPENDESK_PLUGIN_PLATFORMS = ['win32', 'darwin', 'linux', 'android', 'openharmony'] as const;

export type PluginPlatform = (typeof OPENDESK_PLUGIN_PLATFORMS)[number];

export type PluginFailureMode = 'open' | 'closed';

export type PluginShellType = 'bash' | 'zsh' | 'powershell';

/** 模型协议类型（provider 侧） */
export type PluginModelType = 'chat' | 'embedding';

/** 模型信息，供插件按模型维度做决策 */
export interface PluginModelInfo {
    /** 模型在本地配置中的别名 */
    modelAlias?: string;
    /** 模型在 provider 侧的名称 */
    modelName?: string;
    /** 模型类型 */
    modelType?: PluginModelType;
    /** 模型所属的服务商信息 */
    provider?: PluginProviderInfo;
}

/** 模型服务商信息，供插件按网关维度做决策 */
export interface PluginProviderInfo {
    /** 服务商 API 端点（即模型配置的 base_url） */
    baseUrl?: string;
    /** 服务商协议类型 */
    providerType?: 'openai' | 'anthropic';
    /** 服务商名称（如 "openrouter"、"deepseek"，用于展示） */
    providerName?: string;
}

export interface PluginChatRequestInput {
    taskId?: string;
    workspace?: string;
    /** 本次请求使用的模型信息（含所属服务商） */
    model?: PluginModelInfo;
}

export interface PluginChatHeadersOutput {
    headers: Record<string, string>;
}

export interface PluginChatParams {
    reasoningEffort?: ReasoningEffort;
    maxCompletionTokens?: number;
}

export interface PluginTaskReviewMessage {
    readonly role: 'user' | 'assistant';
    readonly content: string;
}

export interface PluginTaskReviewInput {
    readonly taskId: string;
    readonly messages: readonly PluginTaskReviewMessage[];
}

export interface PluginSkillLoadContext {
    bundleName: string;
    skillName: string;
    skillDirectory?: string;
    source?: 'installed' | 'config' | 'mounted' | 'builtin' | 'plugin';
    frontmatter: Record<string, unknown>;
}

export type PluginSkillListSource = 'installed' | 'config' | 'mounted';

export interface PluginSkillListItem {
    readonly name: string;
    readonly directory: string;
    readonly source: PluginSkillListSource;
    readonly enabled: boolean;
}

export interface PluginSkillListAfterInput {
    readonly skills: readonly PluginSkillListItem[];
}

export type PluginSkillLoadBeforeOutput = {
    operation: 'allow' | 'deny';
    message?: string;
    metadata?: Record<string, unknown>;
};

export interface PluginSkillInstallContext {
    source: 'directory' | 'zip' | 'url' | 'registry';
    path?: string;
    url?: string;
    skillRelPath?: string;
    force?: boolean;
    customName?: string;
}

export type PluginSkillInstallBeforeOutput = {
    operation: 'allow' | 'deny';
    message?: string;
    metadata?: Record<string, unknown>;
};

export interface PluginSkillInstallAfterContext extends PluginSkillInstallContext {
    skillName: string;
}

export interface PluginHookRegistrationOptions {
    failureMode?: PluginFailureMode;
}

export interface PluginRegistration {
    dispose(): Promise<void>;
}

export type PluginAccountKind = 'personal' | 'enterprise';

export interface PluginAccountUser {
    id: string;
    username: string;
    email?: string;
    display_name?: string;
    avatar_url?: string;
}

export interface PluginAccountSession {
    backendId: string;
    kind: PluginAccountKind;
    baseUrl: string;
    user: PluginAccountUser;
}

export interface PluginAccountLoginContext {
    kind: PluginAccountKind;
    baseUrl: string;
}

export type PluginAccountLoginFieldType = 'text' | 'password' | 'email';

export interface PluginAccountLoginField {
    id: string;
    type: PluginAccountLoginFieldType;
    label: PluginDisplayName;
    placeholder?: PluginDisplayName;
    autocomplete?: string;
    required?: boolean;
}

export interface PluginAccountFormLoginMethod {
    id: string;
    type: 'form';
    displayName: PluginDisplayName;
    fields: readonly PluginAccountLoginField[];
}

export interface PluginAccountBrowserLoginMethod {
    id: string;
    type: 'browser';
    displayName: PluginDisplayName;
}

export interface PluginAccountDeviceCodeLoginMethod {
    id: string;
    type: 'device-code';
    displayName: PluginDisplayName;
}

export type PluginAccountLoginMethod =
    PluginAccountFormLoginMethod | PluginAccountBrowserLoginMethod | PluginAccountDeviceCodeLoginMethod;

export interface PluginAccountLoginFlowRequest extends PluginAccountLoginContext {
    methodId: string;
}

export type PluginAccountLoginFlowState =
    | { status: 'ready' }
    | { status: 'opening-browser'; url: string }
    | { status: 'waiting'; message?: PluginDisplayName }
    | { status: 'device-code'; code: string; verificationUrl: string }
    | { status: 'completed'; session: PluginAccountSession }
    | { status: 'failed'; errorCode: string };

export interface PluginAccountLoginFlow {
    getState(): PluginAccountLoginFlowState;
    start?(): Promise<PluginAccountLoginFlowState>;
    submit?(values: Readonly<Record<string, string>>): Promise<PluginAccountLoginFlowState>;
    poll?(): Promise<PluginAccountLoginFlowState>;
    cancel(): Promise<void>;
}

export interface PluginAccountBackend {
    readonly id: string;
    readonly kinds: readonly PluginAccountKind[];
    /**
     * 该账号类型在宿主/用户未配置 baseUrl 时由插件提供的默认地址。
     * 未实现或返回 undefined 表示该类型必须由宿主/用户显式提供地址。
     */
    getDefaultBaseUrl?(kind: PluginAccountKind): string | undefined;
    initialize(): void;
    getSession(): PluginAccountSession | null;
    getUserInfo(): Promise<PluginAccountUser | null>;
    getLoginMethods(context: PluginAccountLoginContext): Promise<readonly PluginAccountLoginMethod[]>;
    createLoginFlow(request: PluginAccountLoginFlowRequest): Promise<PluginAccountLoginFlow>;
    updateDisplayName(displayName: string): Promise<PluginAccountUser>;
    refreshToken(): Promise<PluginAccountSession>;
    logout(): Promise<void>;
}

export interface PluginAccountSecretStore {
    load(): unknown;
    save(value: unknown): void;
    clear(): void;
}

export type PluginSetupResult = void | PluginRegistration | (() => void | Promise<void>);

export interface PluginCommandContext {
    taskId?: string;
    workspace?: string;
    abort: AbortSignal;
}

export type PluginCommandResult =
    | void
    | string
    | {
          title?: string;
          output: string;
      };

export type PluginCommandArgumentValueType = 'string' | 'number';

export interface PluginCommandValueOptions<Value extends string | number | boolean = string | number | boolean> {
    choices?: readonly Extract<Value, string | number>[];
    defaultValue?: Value | readonly Exclude<Value, boolean>[];
}

export interface PluginCommandArgumentOptions extends PluginCommandValueOptions<string | number> {
    type?: PluginCommandArgumentValueType;
}

export interface PluginCommandOptionOptions extends PluginCommandValueOptions {
    type?: PluginCommandArgumentValueType | 'boolean';
}

export interface PluginCommandArgsBuilder {
    argument(flags: string, description?: string, options?: PluginCommandArgumentOptions): this;
    option(flags: string, description?: string, options?: PluginCommandOptionOptions): this;
    requiredOption(flags: string, description?: string, options?: PluginCommandOptionOptions): this;
}

export type PluginParsedCommandArgs = Record<string, unknown>;

export interface PluginTextCommandDefinition {
    name: string;
    description: string;
    args?: undefined;
    execute(args: string, context: PluginCommandContext): PluginCommandResult | Promise<PluginCommandResult>;
}

export interface PluginStructuredCommandDefinition<Args extends PluginParsedCommandArgs = PluginParsedCommandArgs> {
    name: string;
    description: string;
    args(builder: PluginCommandArgsBuilder): void;
    execute(args: Args, context: PluginCommandContext): PluginCommandResult | Promise<PluginCommandResult>;
}

export type PluginCommandDefinition = PluginTextCommandDefinition | PluginStructuredCommandDefinition;

export interface PluginApplicationEvent {
    application: string;
    event: string;
    args: unknown[];
}

export interface PluginApplicationEventFilter {
    application?: string;
    event?: string;
}

export type PluginApplicationEventCallback = (event: PluginApplicationEvent) => void | Promise<void>;

export interface PluginSkillDefinition {
    name: string;
    description: string;
    body: string;
    directory?: string;
    frontmatter?: Record<string, unknown>;
    userInvocable?: boolean;
    modelInvocable?: boolean;
}

interface PluginMcpServerBase {
    name: string;
}

export interface PluginMcpStdioServerDefinition extends PluginMcpServerBase {
    transport: 'stdio';
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
}

export interface PluginMcpRemoteServerDefinition extends PluginMcpServerBase {
    transport: 'sse' | 'streamableHttp';
    url: string;
    headers?: Record<string, string>;
}

export type PluginMcpServerDefinition = PluginMcpStdioServerDefinition | PluginMcpRemoteServerDefinition;

/**
 * 插件在 manifest 中声明的静态资源。
 *
 * 这些资源无需执行 setup() 即可由宿主直接从插件目录加载并注册。
 */
export interface PluginStaticResources {
    skills?: PluginSkillDefinition[];
    mcpServers?: PluginMcpServerDefinition[];
    agents?: AgentDefinition[];
}

// ---------------------------------------------------------------------------
// browser capability — 页面级 hint 注册
// ---------------------------------------------------------------------------

/**
 * 浏览器页面上下文，作为 hint 生成器的唯一入参。
 *
 * 由宿主在生成页面快照时构造，插件侧只读。
 */
export interface BrowserContext {
    /** 完整地址，含协议，如 https://www.bing.com/search?q=x */
    readonly url: string;
    /** 域名，如 www.bing.com */
    readonly domain: string;
    /** 去掉协议与 `//` 后的地址，如 www.bing.com/search?q=x；hint 的地址匹配 pattern 即作用于此字段 */
    readonly address: string;
    /** 页面标题 */
    readonly title: string;
    /**
     * 读取页面原始 DOM 树（documentElement.outerHTML）。
     *
     * 按需拉取：大多数 hint 只依赖 URL，不调用则不产生任何页面通信开销。
     */
    dom(): Promise<string>;
}

/** 文本提示：直接作为一段说明附加到快照上，用于约束或提示模型的页面操作方式 */
export interface TextHint {
    readonly kind: 'text';
    readonly content: string;
}

/**
 * 动作提示：向模型暴露一个页面内可执行的动作。
 *
 * 模型通过 browser 的 `trigger` 工具调用；宿主会在页面中 eval `functionStr`
 * 得到函数对象后以 `fn(args)` 形式调用。
 */
export interface ActionHint {
    readonly kind: 'action';
    readonly name: string;
    readonly description: string;
    /** 参数名 → 参数说明；模型据此构造 trigger 的 args */
    readonly args: Readonly<Record<string, string>>;
    /** 页面内可 eval 为函数的 JS 源码，如 `(args) => { ... }` */
    readonly functionStr: string;
}

export type BrowserHint = TextHint | ActionHint;

export type BrowserHintGenerator = (context: BrowserContext) => BrowserHint[] | Promise<BrowserHint[]>;

/** 构造文本提示 */
export function textHint(content: string): TextHint {
    return { kind: 'text', content };
}

/** 构造动作提示 */
export function actionHint(
    name: string,
    description: string,
    args: Record<string, string>,
    functionStr: string
): ActionHint {
    return { kind: 'action', name, description, args: { ...args }, functionStr };
}

export interface PluginHookMap {
    'chat.headers': {
        input: PluginChatRequestInput;
        output: PluginChatHeadersOutput;
    };
    'chat.params': {
        input: PluginChatRequestInput;
        output: PluginChatParams;
    };
    'task.review': {
        input: PluginTaskReviewInput;
        output: Record<string, never>;
    };
    'skill.load.before': {
        input: PluginSkillLoadContext;
        output: PluginSkillLoadBeforeOutput;
    };
    'skill.load.after': {
        input: PluginSkillLoadContext;
        output: Record<string, never>;
    };
    'skill.list.after': {
        input: PluginSkillListAfterInput;
        output: Record<string, never>;
    };
    'skill.install.before': {
        input: PluginSkillInstallContext;
        output: PluginSkillInstallBeforeOutput;
    };
    'skill.install.after': {
        input: PluginSkillInstallAfterContext;
        output: Record<string, never>;
    };
    'permission.ask': {
        input: {
            taskId: string;
            workspace?: string;
            tool: string;
            callId?: string;
            requests: PermissionRequest[];
        };
        output: {
            decision: 'ask' | 'allow' | 'deny';
        };
    };
    'shell.env': {
        input: {
            taskId?: string;
            workspace?: string;
            shell: string;
            shellType: PluginShellType;
            command: string;
        };
        output: {
            env: Record<string, string | undefined>;
        };
    };
    'shell.execute.before': {
        input: {
            tool: string;
            taskId: string;
            callId: string;
            workspace?: string;
            shellType: PluginShellType;
        };
        output: {
            args: unknown;
            deny?: {
                message?: string;
                metadata?: Record<string, unknown>;
            };
        };
    };
    'shell.execute.after': {
        input: {
            tool: string;
            taskId: string;
            callId: string;
            workspace?: string;
            args: unknown;
            shellType: PluginShellType;
            returnCode: number | null;
        };
        output: {
            status: 'success' | 'error';
            result: string;
            resultObject?: object;
        };
    };
    'tool.definition': {
        input: {
            tool: string;
            pluginId?: string;
            taskId?: string;
            workspace?: string;
        };
        output: {
            description: string;
            parameters: z.ZodType;
        };
    };
    'tool.validate.before': {
        input: {
            tool: string;
            taskId: string;
            callId: string;
            workspace?: string;
        };
        output: {
            args: unknown;
            deny?: {
                message?: string;
                metadata?: Record<string, unknown>;
            };
        };
    };
    'tool.execute.before': {
        input: {
            tool: string;
            taskId: string;
            callId: string;
            workspace?: string;
        };
        output: {
            deny?: {
                message?: string;
                metadata?: Record<string, unknown>;
            };
        };
    };
    'tool.execute.after': {
        input: {
            tool: string;
            taskId: string;
            callId: string;
            workspace?: string;
            args: unknown;
        };
        output: {
            status: 'success' | 'error';
            result: string;
            resultObject?: object;
        };
    };
}

export const OPENDESK_PLUGIN_HOOK_NAMES = [
    'chat.headers',
    'chat.params',
    'task.review',
    'skill.load.before',
    'skill.load.after',
    'skill.list.after',
    'skill.install.before',
    'skill.install.after',
    'permission.ask',
    'shell.env',
    'shell.execute.before',
    'shell.execute.after',
    'tool.definition',
    'tool.validate.before',
    'tool.execute.before',
    'tool.execute.after'
] as const satisfies readonly (keyof PluginHookMap)[];

export type PluginHookName = (typeof OPENDESK_PLUGIN_HOOK_NAMES)[number];

export type PluginHookCallback<Name extends PluginHookName> = (
    input: PluginHookMap[Name]['input'],
    output: PluginHookMap[Name]['output']
) => Promise<void> | void;

/**
 * 当前插件已生效的应用外观覆盖。未设置的字段为 undefined，表示沿用默认外观。
 */
export interface PluginAppearanceState {
    /** 自定义应用标题，已按当前界面语言解析（当前作用于 GUI 左上角侧边栏品牌区） */
    readonly appTitle?: string;
    /** 自定义应用描述，已按当前界面语言解析（当前作用于 GUI 左上角标题下方文案） */
    readonly appDescription?: string;
    /** 自定义应用 Logo 的 data URL（单图形式，不区分主题） */
    readonly appLogoUrl?: string;
    /** 暗色主题下的自定义 Logo data URL（主题变体形式） */
    readonly appLogoDarkUrl?: string;
    /** 亮色主题下的自定义 Logo data URL（主题变体形式） */
    readonly appLogoLightUrl?: string;
}

/**
 * 主题变体 Logo 输入：dark/light 至少提供其一，均相对插件根目录；
 * 缺省一侧复用另一侧的图，避免某个主题下回退到默认 Logo 造成跳变。
 */
export interface PluginAppLogoThemeVariants {
    /** 暗色主题（data-theme="dark"）使用的 Logo 路径 */
    dark?: string;
    /** 亮色主题使用的 Logo 路径 */
    light?: string;
}

/**
 * 外观能力：插件自定义应用外观。
 *
 * 当前逐步开放中，暂提供 setAppTitle / setAppDescription / setAppLogo；
 * 后续会开放更多自定义项。每个字段按「后设置者生效」，
 * 释放返回的 PluginRegistration 后回退到默认外观。
 */
export interface AppearanceCapability {
    /**
     * 修改应用标题（当前作用于 GUI 左上角侧边栏品牌区，替换 "OpenDesk" 文案）。
     *
     * 支持两种形式：
     * - 字符串：所有语言显示同一文案；
     * - 本地化映射（如 `{ zh: "我的桌面", en: "MyDesk" }`）：键为 BCP 47 语言标签
     *   （解析时取主语言标签匹配），界面语言切换后按新语言即时生效。
     *
     * @param title 非空文案；字符串形式去除首尾空白后长度不超过 64，映射形式每个值同样受限。
     */
    setAppTitle(title: string | PluginLocalizedText): PluginRegistration;
    /**
     * 修改应用描述（当前作用于 GUI 左上角标题下方的描述文案，替换默认标语）。
     *
     * 形式与语言解析规则与 setAppTitle 一致。
     *
     * @param description 非空文案；字符串形式去除首尾空白后长度不超过 64，映射形式每个值同样受限。
     */
    setAppDescription(description: string | PluginLocalizedText): PluginRegistration;
    /**
     * 修改应用 Logo（当前作用于 GUI 左上角侧边栏品牌区）。
     *
     * 支持两种形式：
     * - 相对路径字符串：所有主题使用同一 Logo；
     * - 主题变体对象 `{ dark, light }`：按当前主题选用，缺省一侧复用另一侧。
     *
     * @param logoPath 相对插件根目录（manifest 所在目录）的图片路径，
     *   支持 png/jpg/jpeg/svg/webp/gif/ico，文件不超过 2MB。
     */
    setAppLogo(logoPath: string | PluginAppLogoThemeVariants): PluginRegistration;
}

export interface PluginContext {
    readonly pluginId: string;
    readonly pluginDir: string;
    readonly configDir: string;
    /**
     * 插件私有数据目录（`<opendesk>/plugins/.pluginmgr/data/<pluginId>/`），宿主会在插件
     * 激活前创建它（创建失败不会阻断插件加载，写入时才会报错）。
     *
     * 用于存放插件自己的状态、缓存、账号文件等。该目录与插件代码目录分离：
     * 卸载插件时默认保留（用户可在确认弹窗中选择一并删除），因此重新安装同一
     * 插件 id 后可以继续读取原有数据。
     */
    readonly dataDir: string;
    readonly options: Readonly<Record<string, unknown>>;
    readonly hooks: {
        on<Name extends PluginHookName>(
            name: Name,
            callback: PluginHookCallback<Name>,
            options?: PluginHookRegistrationOptions
        ): PluginRegistration;
    };
    readonly tools: {
        register<T extends z.ZodType>(definition: ToolDefinition<T>): PluginRegistration;
    };
    readonly skills: {
        register(definition: PluginSkillDefinition): PluginRegistration;
    };
    readonly mcps: {
        registerServer(definition: PluginMcpServerDefinition): PluginRegistration;
    };
    readonly agents: {
        register(definition: AgentDefinition): PluginRegistration;
        /**
         * 扫描插件目录下的 agent 目录并批量注册。
         *
         * @param relativePath 相对插件根目录（manifest 所在目录）的路径。
         *   该路径自身包含 agents.md 时按单个 agent 处理；
         *   否则扫描其一级子目录，注册其中包含 agents.md 的目录。
         * @returns 统一的 PluginRegistration，释放时会移除本次注册的全部 agent。
         */
        registerDirectory(relativePath: string): PluginRegistration;
    };
    readonly commands: {
        register(definition: PluginTextCommandDefinition): PluginRegistration;
        register<Args extends PluginParsedCommandArgs>(
            definition: PluginStructuredCommandDefinition<Args>
        ): PluginRegistration;
    };
    readonly browser: {
        readonly hint: {
            /**
             * 为匹配的页面注册 hint 生成器。
             *
             * @param pattern 页面地址匹配模式，不含协议部分（匹配对象为去协议后的
             *   完整地址，如 `www.bing.com/search?q=x`）：
             *   - 字符串不含 `*`：按前缀匹配，前缀需结束在 `/`、`?`、`#` 或地址末尾的边界上；
             *   - 字符串含 `*`：按通配符整体匹配路径，`*` 匹配单段（不含 `/`），`**`
             *     跨段，query 与 hash 不参与匹配；
             *   - RegExp：对去协议后的完整地址做正则匹配。
             * @param generator 生成器函数，接收 BrowserContext 返回 hint 列表。
             */
            register(pattern: string | RegExp, generator: BrowserHintGenerator): PluginRegistration;
        };
    };
    readonly accounts: {
        readonly network: {
            fetch(input: string | URL, init?: RequestInit): Promise<Response>;
        };
        readonly auth: {
            openExternal(url: string): Promise<void>;
        };
        readonly secrets: PluginAccountSecretStore;
        registerBackend(backend: PluginAccountBackend): PluginRegistration;
    };
    readonly events: {
        onApplication(
            filter: PluginApplicationEventFilter,
            callback: PluginApplicationEventCallback
        ): PluginRegistration;
    };
    /**
     * 消息渠道能力：插件通过 `ctx.channels.register(channel)` 注册一个 Channel 实例。
     * 注册的 channel 由 host 收集，供 channelmgr 启动/登录/收发消息。
     */
    readonly channels: ChannelsCapability;
    /** 外观能力：插件自定义应用外观（逐步开放中） */
    readonly appearance: AppearanceCapability;
    /** 注册表能力：插件向技能市场 / MCP 管理器贡献注册表（marketplace） */
    readonly registry: RegistryCapability;
}

export interface OpenDeskPlugin {
    id: string;
    displayName?: PluginDisplayName;
    description?: PluginLocalizedText;
    version?: string;
    /** 插件分类标签：插件市场按它归类显示，未声明表示未分类 */
    category?: string[];
    /** 插件作者信息：仅用于界面展示 */
    author?: PluginAuthor;
    /** 插件自身的站点地址（作者主页是 author.homepage） */
    homepage?: string;
    apiVersion?: number;
    capabilities?: PluginCapability[];
    platforms?: PluginPlatform[];
    minOpenDeskVersion?: string;
    maxOpenDeskVersion?: string;
    configSchema?: z.ZodType;
    failureMode?: PluginFailureMode;
    setup(context: PluginContext): Promise<PluginSetupResult> | PluginSetupResult;
}

/** 本地化文本映射：语言主标签到文本的映射，如 { "en": "...", "zh": "..." } */
export type PluginLocalizedTextMap = Record<string, string>;

/**
 * 插件本地化文本（displayName / description 通用）：
 * 支持简单字符串或按语言声明的对象。
 * 对象键使用 BCP 47 语言标签（如 en、zh、zh-CN），解析时取主语言标签匹配。
 */
export type PluginLocalizedText = string | PluginLocalizedTextMap;

/** 本地化显示名称：语言主标签到名称的映射，如 { "en": "...", "zh": "..." } */
export type PluginDisplayNameMap = PluginLocalizedTextMap;

/**
 * 插件显示名称：支持简单字符串或按语言声明的对象。
 * 对象键使用 BCP 47 语言标签（如 en、zh、zh-CN），解析时取主语言标签匹配。
 */
export type PluginDisplayName = PluginLocalizedText;

/**
 * 插件作者信息（可选）。
 *
 * 只用于展示：插件中心详情与插件市场卡片会显示它，不参与加载与权限判定。
 * `name` / `institution` 与 displayName 一样支持简单字符串或按语言声明的对象；
 * `homepage` 是作者或机构的站点地址（插件自身地址用元数据的 `homepage`）。
 */
export interface PluginAuthor {
    name: PluginDisplayName;
    institution?: PluginLocalizedText;
    homepage?: string;
}

/** 取语言标签的主子标签（如 zh-CN -> zh），用于本地化文本匹配 */
export function localePrimaryTag(value: string): string {
    return value.trim().toLowerCase().replace(/_/g, '-').split('-')[0] ?? '';
}

/**
 * 按目标语言解析插件本地化文本（displayName / description 通用）。
 * 字符串形式原样返回；对象形式优先匹配与目标语言同主语言的条目，
 * 无匹配时回退到第一个可用翻译。
 */
export function resolvePluginLocalizedText(value: PluginLocalizedText | undefined, locale: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'object') {
        const trimmed = value.trim();
        return trimmed || undefined;
    }
    const entries = Object.entries(value)
        .map(([key, entry]): readonly [string, string] => [
            localePrimaryTag(key),
            typeof entry === 'string' ? entry.trim() : ''
        ])
        .filter(([tag, text]) => tag.length > 0 && text.length > 0);
    if (entries.length === 0) return undefined;
    const preferred = localePrimaryTag(locale ?? '');
    return entries.find(([tag]) => tag === preferred)?.[1] ?? entries[0][1];
}

/**
 * 按目标语言解析插件显示名称。
 * 字符串形式原样返回；对象形式优先匹配与目标语言同主语言的条目，
 * 无匹配时回退到第一个可用翻译。
 */
export function resolvePluginDisplayName(
    displayName: PluginDisplayName | undefined,
    locale: string
): string | undefined {
    return resolvePluginLocalizedText(displayName, locale);
}

export function definePlugin(plugin: OpenDeskPlugin): OpenDeskPlugin {
    return plugin;
}

export function tool<Shape extends z.ZodRawShape>(
    input: Omit<ToolDefinition<z.ZodObject<Shape>>, 'parameters'> & { args: Shape }
): ToolDefinition<z.ZodObject<Shape>> {
    const { args, ...definition } = input;
    return {
        ...definition,
        parameters: z.object(args)
    };
}

tool.schema = z;

// ── Channel Capability（消息渠道）────────────────────────────────────────────
// 插件实现 class XxxChannel implements Channel，通过 ctx.channels.register 注册。
// 职责边界：channel 只负责「收原始消息 → ctx.dispatch」与「接收出站 → 发送」；
// 配对/allowlist/群组策略等消息处理管线由 OpenDesk（channelmgr）统一处理。

export type ChannelChatType = 'direct' | 'group';

/** Channel 元数据：id 全局唯一，label 支持本地化映射 { en, zh } */
export interface ChannelMeta {
    id: string;
    label: string | PluginDisplayNameMap;
    description?: string;
    aliases?: string[];
    icon?: string;
}

export interface ChannelCapabilities {
    chatTypes: ChannelChatType[];
    /** 是否支持媒体收发；缺省 false */
    media?: boolean;
    /** 是否支持主题回复（thread） */
    threading?: boolean;
    /**
     * 是否支持结构化用户交互（交互卡片、按钮回调等）。
     * 为 true 时 OpenDesk 会把权限审批与 askUser 提问透传到用户侧（如飞书确认卡片）；
     * 为 false/缺省时 OpenDesk 不向模型挂载相关交互工具，权限请求自动拒绝。
     */
    interactive?: boolean;
}

/**
 * 媒体附件。
 * 入站：channel 负责将远端媒体下载到本地后填 path，OpenDesk 读取该文件交给 agent。
 * 出站：OpenDesk 提供 path（本地文件）或 url（远程地址），channel 负责上传/转换。
 */
export interface ChannelMediaAttachment {
    path?: string;
    url?: string;
    contentType?: string;
    fileName?: string;
}

export interface ChannelMessage {
    text: string;
    media?: ChannelMediaAttachment[];
}

/** 入站消息：channel 收到原始消息后原样 dispatch，不做任何策略过滤 */
export interface ChannelInboundMessage {
    /** 平台消息 id，OpenDesk 侧用于去重；无唯一 id 的平台可不填 */
    messageId?: string;
    /** 消息所属账号（channel 自己管理账号，dispatch 时须显式声明） */
    accountId?: string;
    chatType: ChannelChatType;
    /** 发送者；group 场景下为群内发消息的用户 */
    sender: { id: string; name?: string };
    /** chatType === 'group' 时必填 */
    group?: { id: string; name?: string };
    text: string;
    media?: ChannelMediaAttachment[];
    /** 引用回复的源消息 id */
    replyToMessageId?: string;
    threadId?: string;
    timestamp?: number;
    /** 平台原始事件对象，透传调试用 */
    raw?: unknown;
}

/** 出站目标：direct 时 recipientId 为用户 id，group 时 recipientId 为群 id */
export interface ChannelOutboundTarget {
    chatType: ChannelChatType;
    recipientId: string;
    groupId?: string;
}

export interface ChannelOutboundMessage {
    to: ChannelOutboundTarget;
    /** 使用哪个账号发送（对应 listAccounts 返回的 accountId） */
    accountId: string;
    message: ChannelMessage;
}

export interface ChannelSendResult {
    /** 平台侧发送成功后的消息 id */
    messageId?: string;
}

// ---------------------------------------------------------------------------
// 用户交互（权限审批 / askUser）能力
// ---------------------------------------------------------------------------
// Channel 若声明 capabilities.interactive === true，则必须实现 sendInteraction：
// OpenDesk 把「权限审批」与「向用户提问」的结构化请求发到渠道侧渲染成交互 UI
// （如飞书确认卡片），用户在渠道侧点击后经 ctx.dispatchInteraction 回传结果。
// 渠道不支持交互时，OpenDesk 不挂载 askUser 等交互工具，权限请求自动拒绝。

/** 交互类型：approval=权限审批，askUser=向用户提问，selection=单选列表（如 /list 会话切换） */
export type ChannelInteractionKind = 'approval' | 'askUser' | 'selection';

export interface ChannelInteractionOption {
    label: string;
    description: string;
}

export interface ChannelAskUserQuestion {
    question: string;
    /** 简短标签（最多 30 字符），展示为标题 */
    header: string;
    options: ChannelInteractionOption[];
    /** 是否允许多选；缺省 false。飞书等按钮渠道对多选按逐个选择处理 */
    multiple?: boolean;
}

export interface ChannelAskUserRequestPayload {
    questions: ChannelAskUserQuestion[];
}

export interface ChannelApprovalRequest {
    /** 展示给用户的审批说明（markdown 文本） */
    prompt: string;
    /** 触发审批的工具名（可选，用于展示上下文） */
    tool?: string;
    /** 被请求授权的权限请求列表 */
    requests: PermissionRequest[];
    confirmLabel?: string;
    cancelLabel?: string;
}

/** selection 请求的对外形态：单选列表（渠道按能力渲染为卡片按钮或编号文本） */
export interface ChannelSelectionRequestPayload {
    /** 列表标题 */
    header: string;
    /** 选项列表；value 为回传标识（如 taskId），label 为展示文本 */
    options: { label: string; value: string }[];
    /** 列表末尾的提示文案（如分页语法说明），可选；渠道渲染在选项之后 */
    hint?: string;
}

/** 出站交互请求：OpenDesk 构造，channel 渲染为用户可见的交互 UI */
export interface ChannelInteractionRequest {
    /** 唯一交互 ID，回调通过它关联回 pending 的请求 */
    interactionId: string;
    kind: ChannelInteractionKind;
    to: ChannelOutboundTarget;
    accountId: string;
    /** 过期时间（epoch ms）。到期未响应的交互应视为取消 */
    expiresAt?: number;
    payload: ChannelApprovalRequest | ChannelAskUserRequestPayload | ChannelSelectionRequestPayload;
}

/** 入站交互事件：用户在渠道侧点击了交互 UI 的按钮/选项 */
export interface ChannelInteractionEvent {
    kind: ChannelInteractionKind;
    interactionId: string;
    /** 事件所属账号（channel 自己管理账号，dispatch 时须显式声明） */
    accountId?: string;
    /** 操作用户 */
    operator: { id: string; name?: string };
    /** approval 事件：用户选择 allow / deny */
    decision?: 'allow' | 'deny';
    /** askUser 事件：question index → 选中的 option label 数组 */
    answers?: Record<number, string[]>;
    /** selection 事件：用户选中的选项 value */
    selected?: string;
    /** 用户取消（如点击取消按钮、卡片超时） */
    cancelled?: boolean;
    /** 平台原始事件对象，透传调试用 */
    raw?: unknown;
}

/** 账号句柄。敏感凭证由 channel 内部持久化，此对象只携带标识信息 */
export interface ChannelAccount {
    accountId: string;
    accountName?: string;
}

export interface ChannelAccountStatus {
    ok: boolean;
    message?: string;
}

export interface ChannelQrLoginSession {
    /** base64 编码的图像或指向二维码图片的网页地址 */
    qrUrl: string;
    sessionKey: string;
    expiresAt?: number;
}

/** 参数登录的表单字段描述，OpenDesk 据此渲染登录 UI */
export interface ChannelAccountLoginParam {
    name: string;
    displayName: string;
    required: boolean;
    /** password 时 UI 用掩码输入框 */
    type?: 'text' | 'password';
}

export interface ChannelLogger {
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
    debug: (...args: any[]) => void;
}

/** 运行时上下文：OpenDesk 创建并通过 setChannelRuntimeContext 注入 Channel */
export interface ChannelRuntimeContext {
    readonly channelId: string;
    /** 注入该上下文时对应的账号（channel 可据此区分多账号） */
    readonly accountId?: string;
    /** OpenDesk 侧维护的非敏感配置（对应 Channel.configSchema，存于 settings.json） */
    readonly config: Readonly<Record<string, unknown>>;
    /** channel 专属数据目录（<opendesk>/channels/<channelId>/），凭证持久化用 */
    readonly dataDir: string;
    /** 将相对路径解析到 dataDir 内 */
    resolvePath(input: string): string;
    /** 入站消息投递：OpenDesk 内部执行配对/allowlist/群组策略后决定是否路由到 agent */
    dispatch(message: ChannelInboundMessage): Promise<void>;
    /** 入站交互事件投递：用户点击了权限审批/askUser 交互 UI，OpenDesk 据此结算 pending 请求 */
    dispatchInteraction(event: ChannelInteractionEvent): Promise<void>;
    /**
     * 连接状态上报（连接/断开/错误）。
     * 多账号场景下 channel 持有的是最后一次注入的 ctx，上报时应显式传入
     * 所属 accountId，避免状态串线到其他账号；不传则使用注入该 ctx 时的账号。
     */
    setStatus(status: { online: boolean; statusText?: string; error?: string }, accountId?: string): void;
    /**
     * 向 OpenDesk 发送扩展事件（如扫码过期、需要重新授权）。
     * 多账号场景下建议显式传入 accountId（理由同 setStatus）。
     */
    emit(event: string, payload?: unknown, accountId?: string): void;
    /** 系统级 fetch，继承 OpenDesk 代理配置 */
    fetch(input: string | URL, init?: RequestInit): Promise<Response>;
    logger: ChannelLogger;
}

/**
 * 消息渠道接口。插件实现子类（如 `class WechatChannel implements Channel`）。
 * 生命周期：define → setChannelRuntimeContext → listAccounts → 逐个 start(account)；
 * 登录新账号 → start(newAccount)；登出 → stop(accountId)。
 */
export interface Channel<TAccount extends ChannelAccount = ChannelAccount> {
    readonly meta: ChannelMeta;
    readonly capabilities: ChannelCapabilities;
    /** 非敏感配置的 JSON Schema，OpenDesk 据此渲染配置 UI */
    readonly configSchema?: unknown;

    /** OpenDesk 调用，注入运行时上下文；实现者自行保留该 ctx，后续操作不再传入 */
    setChannelRuntimeContext(ctx: ChannelRuntimeContext): void;

    /** 列出当前已登录/已配置的账号（channel 从自己的持久化存储读取） */
    listAccounts(): Promise<TAccount[]> | TAccount[];
    /** 是否支持扫码登录；为 true 时必须实现 getAccountLoginQr / loginAccountWithQrWait */
    supportLoginWithQr: boolean;
    getAccountLoginQr?(): Promise<ChannelQrLoginSession>;
    /** 轮询等待扫码结果；成功返回账号（channel 内部持久化凭证），失败抛错 */
    loginAccountWithQrWait?(session: ChannelQrLoginSession, onProgress?: (message: string) => void): Promise<TAccount>;

    /** 参数登录的表单描述（如飞书 appId/appSecret），OpenDesk 据此渲染表单 */
    getAccountLoginParams(): ChannelAccountLoginParam[];
    /** 用表单值登录，成功返回账号并持久化，失败抛错 */
    loginAccountWithParams(values: Record<string, string>): Promise<TAccount>;

    /** 主动检查某账号连接是否正常（如 token 是否过期） */
    checkAccountStatus(accountId: string): Promise<ChannelAccountStatus>;
    /** 登出并清理该账号的持久化凭证 */
    logoutAccount(accountId: string): Promise<void> | void;

    /** 启动某账号的长连接（WebSocket/轮询/Webhook 订阅）；连接异常退出时 reject */
    start(account: TAccount): Promise<void>;
    /** 停止某账号的连接并清理资源 */
    stop(accountId: string): Promise<void>;
    /** 可选：OpenDesk 配置变更时的热更新入口；未实现则 OpenDesk 执行 stop + start */
    reload?(config: Record<string, unknown>): Promise<void> | void;

    /** 发送消息到目标；返回平台消息 id 作为回执 */
    sendOutboundMessage(message: ChannelOutboundMessage): Promise<ChannelSendResult>;

    /**
     * 发送结构化交互请求（权限审批卡片 / askUser 提问卡片）到目标用户。
     * 仅当 capabilities.interactive === true 时必须实现；否则 OpenDesk 不会调用。
     * 用户在渠道侧的选择通过 ChannelRuntimeContext.dispatchInteraction 回传。
     */
    sendInteraction?(request: ChannelInteractionRequest): Promise<ChannelSendResult>;
}

/** ctx.channels 能力：register 注册一个 channel，返回可 dispose 的 PluginRegistration */
export interface ChannelsCapability {
    register<TAccount extends ChannelAccount>(channel: Channel<TAccount>): PluginRegistration;
}

// ── Registry Capability（技能 / MCP 注册表市场）──────────────────────────────
// 插件通过 ctx.registry.registerSkillRegistry / registerMcpRegistry 向
// 技能市场与 MCP 管理器贡献一个「注册表」（marketplace）。
// 注册的 registry 由 host 收集，skillmgr / mcpmgr 按与内置注册表完全相同的
// 路径消费：市场 tab 展示、search 搜索、（MCP）getDetail 安装详情、
// installUrl（`<registryId>:<entry>`）路由安装。

/** 注册源声明的筛选器定义，前端据此渲染开关式过滤 UI */
export interface PluginRegistryFilterDef {
    /** 筛选器唯一标识 */
    id: string;
    /** 开关打开时的标签文本 */
    labelOn: string;
    /** 开关关闭时的标签文本 */
    labelOff: string;
    /** 传回 search(options.categoryFilter) 的值 */
    categoryValue: string;
    /** 传给服务端过滤的 tagIds（可选） */
    apiTagIds?: string[];
    /**
     * 仅在这些平台向 GUI 下发该筛选器；缺省（或空数组）表示所有平台可用。
     * 用于平台专属筛选（如「鸿蒙PC兼容技能」只在 openharmony 展示）。
     */
    platforms?: PluginPlatform[];
}

export interface PluginRegistrySearchOptions {
    query?: string;
    page?: number;
    limit?: number;
    /** 部分注册源需要的访问凭证（如 SkillsMP 的 API Key），由宿主按配置注入 */
    apiKey?: string;
    /** 游标分页：上一页结果返回的 nextCursor */
    cursor?: string;
    /** 分类过滤：非空时仅返回匹配该分类的条目 */
    categoryFilter?: string;
}

/** 技能市场条目（与 skillmgr 的 RegistrySkill 结构一致） */
export interface PluginRegistrySkill {
    id: string;
    name: string;
    description: string;
    author?: string;
    source: string;
    installUrl: string;
    stars?: number;
    score?: number;
    downloads?: number;
    canInstall: boolean;
    /** 技能所属分类列表，用于前端分类过滤 */
    categories?: string[];
}

export interface PluginSkillRegistrySearchResult {
    skills: PluginRegistrySkill[];
    total?: number;
    hasMore?: boolean;
    message?: string;
    nextCursor?: string;
}

/** MCP 市场条目（与 mcpmgr 的 RegistryMcp 结构一致） */
export interface PluginRegistryMcp {
    id: string;
    name: string;
    displayName?: string;
    description: string;
    author?: string;
    source: string;
    installUrl: string;
    /** 安装用 JSON 配置（mcpServers 形式），install 时由宿主解析 */
    configuration?: string;
    repository?: string;
    logo?: string;
    deployType?: string;
    serverType?: string;
    downloads?: number;
    stars?: number;
    views?: number;
    updateTime?: string;
    tags?: string[];
    categories?: string[];
    canInstall: boolean;
}

export interface PluginMcpRegistrySearchResult {
    mcps: PluginRegistryMcp[];
    total?: number;
    hasMore?: boolean;
    message?: string;
    nextCursor?: string;
}

/** 注册源展示元数据：市场 tab 与 TUI 共用 */
export interface PluginRegistryMeta {
    /** 注册表唯一标识；同时是 installUrl 前缀（`<id>:`），全局唯一 */
    readonly id: string;
    /** 展示名称（如 "Matrix Skill"、"ModelScope"） */
    readonly label: string;
    /** GUI 中使用的 emoji 图标 */
    readonly icon?: string;
    /** GUI 中 r-icon 的 CSS 类名 */
    readonly iconClass?: string;
    /** 热门条目页面的标语；缺省时宿主使用默认标语 */
    readonly slogan?: string;
    /**
     * 在 GUI 市场中隐藏 tab（仍对 agent 工具与 TUI 可见）。
     * 用于仅面向自动化场景、需要 API Key 或实验性的注册源。
     */
    readonly guiHidden?: boolean;
}

/**
 * 技能注册表定义。search 的结果必须是可结构化克隆的纯数据。
 * 网络请求请使用 ctx.registry.fetch（继承宿主代理配置）。
 */
export interface PluginSkillRegistryDefinition extends PluginRegistryMeta {
    /** 声明筛选器后，GUI 会在该注册表的搜索区渲染开关式过滤 UI */
    readonly filters?: PluginRegistryFilterDef[];
    search(options?: PluginRegistrySearchOptions): Promise<PluginSkillRegistrySearchResult>;
    /**
     * 解析本注册表 installUrl（`<id>:<slug>[@<version>]`）的安装计划。
     * 未声明时宿主按内置规则处理（内置注册表 / GitHub / zip 启发式）。
     */
    resolveInstall?(installUrl: string, parsed: { slug: string; version?: string }): Promise<{ downloadUrl: string }>;
}

/**
 * MCP 注册表定义。search/getDetail 的结果必须是可结构化克隆的纯数据。
 */
export interface PluginMcpRegistryDefinition extends PluginRegistryMeta {
    search(options?: PluginRegistrySearchOptions): Promise<PluginMcpRegistrySearchResult>;
    /** 按 id 获取条目详情；安装流程（installFromRegistry）依赖此方法取 configuration */
    getDetail(id: string): Promise<PluginRegistryMcp | null>;
}

/** ctx.registry 能力：注册技能 / MCP 注册表市场 */
export interface RegistryCapability {
    /** 继承 OpenDesk 代理配置的 fetch；registry 实现内的网络请求应使用它 */
    readonly fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
    registerSkillRegistry(definition: PluginSkillRegistryDefinition): PluginRegistration;
    registerMcpRegistry(definition: PluginMcpRegistryDefinition): PluginRegistration;
}
