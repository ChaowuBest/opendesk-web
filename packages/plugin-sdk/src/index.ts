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

export const OPENDESK_PLUGIN_CAPABILITIES = ['hook', 'tool', 'skill', 'mcp', 'command', 'event'] as const;

export type PluginCapability = (typeof OPENDESK_PLUGIN_CAPABILITIES)[number];

export type PluginFailureMode = 'open' | 'closed';

export interface PluginChatHeadersInput {
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

export interface PluginCommandDefinition {
    name: string;
    description: string;
    execute(args: string, context: PluginCommandContext): PluginCommandResult | Promise<PluginCommandResult>;
}

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

export interface PluginStaticContributions {
    skills?: PluginSkillDefinition[];
    mcpServers?: PluginMcpServerDefinition[];
}

export interface PluginHookMap {
    'chat.headers': {
        input: PluginChatHeadersInput;
        output: PluginChatHeadersOutput;
    };
    'chat.params': {
        input: PluginChatHeadersInput;
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
    'tool.execute.before': {
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

export type PluginHookName = keyof PluginHookMap;

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
    readonly commands: {
        register(definition: PluginCommandDefinition): PluginRegistration;
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
    displayName?: string;
    version?: string;
    apiVersion?: number;
    capabilities?: PluginCapability[];
    minOpenDeskVersion?: string;
    maxOpenDeskVersion?: string;
    configSchema?: z.ZodType;
    failureMode?: PluginFailureMode;
    setup(context: PluginContext): Promise<PluginSetupResult> | PluginSetupResult;
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
