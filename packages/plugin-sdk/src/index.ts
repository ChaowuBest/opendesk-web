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
    'browser'
] as const;

export type PluginCapability = (typeof OPENDESK_PLUGIN_CAPABILITIES)[number];

export const OPENDESK_PLUGIN_PLATFORMS = ['win32', 'darwin', 'linux', 'android', 'openharmony'] as const;

export type PluginPlatform = (typeof OPENDESK_PLUGIN_PLATFORMS)[number];

export type PluginFailureMode = 'open' | 'closed';

export type PluginShellType = 'bash' | 'zsh' | 'powershell';

export interface PluginChatRequestInput {
    taskId?: string;
    workspace?: string;
    modelAlias?: string;
}

export interface PluginChatHeadersOutput {
    headers: Record<string, string>;
}

export interface PluginChatParams {
    reasoningEffort?: ReasoningEffort;
    maxCompletionTokens?: number;
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
    /** 去掉协议与 `//` 后的地址，如 www.bing.com/search?q=x；urlPrefix 即与此字段做前缀匹配 */
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

export interface PluginContext {
    readonly pluginId: string;
    readonly pluginDir: string;
    readonly configDir: string;
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
             * @param urlPrefix 页面地址前缀，不含协议部分（如 `www.bing.com/search`）。
             * @param generator 生成器函数，接收 BrowserContext 返回 hint 列表。
             */
            register(urlPrefix: string, generator: BrowserHintGenerator): PluginRegistration;
        };
    };
    readonly events: {
        onApplication(
            filter: PluginApplicationEventFilter,
            callback: PluginApplicationEventCallback
        ): PluginRegistration;
    };
}

export interface OpenDeskPlugin {
    id: string;
    displayName?: PluginDisplayName;
    version?: string;
    apiVersion?: number;
    capabilities?: PluginCapability[];
    platforms?: PluginPlatform[];
    minOpenDeskVersion?: string;
    maxOpenDeskVersion?: string;
    configSchema?: z.ZodType;
    failureMode?: PluginFailureMode;
    setup(context: PluginContext): Promise<PluginSetupResult> | PluginSetupResult;
}

/** 本地化显示名称：语言主标签到名称的映射，如 { "en": "...", "zh": "..." } */
export type PluginDisplayNameMap = Record<string, string>;

/**
 * 插件显示名称：支持简单字符串或按语言声明的对象。
 * 对象键使用 BCP 47 语言标签（如 en、zh、zh-CN），解析时取主语言标签匹配。
 */
export type PluginDisplayName = string | PluginDisplayNameMap;

/** 取语言标签的主子标签（如 zh-CN -> zh），用于本地化名称匹配 */
export function localePrimaryTag(value: string): string {
    return value.trim().toLowerCase().replace(/_/g, '-').split('-')[0] ?? '';
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
    if (displayName === undefined) return undefined;
    if (typeof displayName !== 'object') {
        const trimmed = displayName.trim();
        return trimmed || undefined;
    }
    const entries = Object.entries(displayName)
        .map(([key, value]): readonly [string, string] => [
            localePrimaryTag(key),
            typeof value === 'string' ? value.trim() : ''
        ])
        .filter(([tag, value]) => tag.length > 0 && value.length > 0);
    if (entries.length === 0) return undefined;
    const preferred = localePrimaryTag(locale ?? '');
    return entries.find(([tag]) => tag === preferred)?.[1] ?? entries[0][1];
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
