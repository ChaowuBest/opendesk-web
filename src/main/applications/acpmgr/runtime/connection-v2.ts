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

import type {
    AuthMethod,
    InitializeRequest,
    McpServer,
    PlanEntry,
    RequestPermissionRequest,
    SessionConfigOption,
    SessionNotification,
    SessionUpdate
} from '@agentclientprotocol/sdk';
import * as acpV2 from '@agentclientprotocol/sdk/experimental/v2';
import type { AcpAgentProfile } from '../common.js';
import type { AcpClientConnection, AcpClientHandlers, AcpConnectionHandle } from './connection.js';
import { t } from '../../../../locale/index.js';

type V2Target = acpV2.Stream | acpV2.AgentApp;
const MAX_TOOL_CONTENT_ITEMS = 10_000;
const MAX_TERMINAL_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * v2 的 SessionUpdate 是开放联合（含 `{ sessionUpdate: string }` 的自定义/未来变体），
 * switch 判别收窄无法排除它，收窄后字段全部退化为 unknown。本适配层只处理已知变体，
 * 用 Extract 收成闭合联合后再分派；未知的 sessionUpdate 走文件末尾的默认透传分支。
 */
type V2KnownSessionUpdate = Extract<
    acpV2.SessionUpdate,
    {
        sessionUpdate:
            | 'user_message_chunk'
            | 'user_message'
            | 'agent_message_chunk'
            | 'agent_message'
            | 'agent_thought_chunk'
            | 'agent_thought'
            | 'tool_call_content_chunk'
            | 'tool_call_update'
            | 'terminal_update'
            | 'terminal_output_chunk'
            | 'plan_update'
            | 'plan_removed'
            | 'state_update';
    }
>;

interface PromptWaiter {
    resolve(stopReason: string): void;
    reject(error: unknown): void;
}

interface V2TerminalSnapshot {
    command?: string;
    cwd?: string;
    output: Buffer;
    exited: boolean;
}

function textContent(blocks: acpV2.ContentBlock[] | null | undefined): string {
    return (blocks ?? [])
        .filter((block): block is acpV2.TextContent & { type: 'text' } => block.type === 'text')
        .map((block) => block.text)
        .join('');
}

function appendTerminalOutput(previous: Buffer, next: Buffer): Buffer {
    const output = Buffer.concat([previous, next]);
    return output.length <= MAX_TERMINAL_OUTPUT_BYTES
        ? output
        : output.subarray(output.length - MAX_TERMINAL_OUTPUT_BYTES);
}

function directMcpServer(server: McpServer): acpV2.McpServer {
    if ('type' in server && server.type === 'http') {
        return { type: 'http', name: server.name, url: server.url, headers: server.headers };
    }
    if ('type' in server && server.type === 'sse') {
        throw new Error(t('acpmgr.error.v2McpSseUnsupported'));
    }
    if ('command' in server) {
        return { type: 'stdio', name: server.name, command: server.command, args: server.args, env: server.env };
    }
    return server as unknown as acpV2.McpServer;
}

function normalizeConfigOptions(options: acpV2.SessionConfigOption[] | undefined): SessionConfigOption[] | undefined {
    return options?.map(
        (option) =>
            ({
                ...option,
                id: option.configId,
                ...('options' in option
                    ? {
                          // 开放联合的 'options' in 收窄后仍为 unknown，按 select 变体实际形状取用
                          options: ((option as { options: Array<Record<string, unknown>> }).options ?? []).map(
                              (entry) => ('groupId' in entry ? { ...entry, group: entry.groupId } : entry)
                          )
                      }
                    : {})
            }) as unknown as SessionConfigOption
    );
}

function normalizeAuthMethods(methods: acpV2.AuthMethod[] | undefined): AuthMethod[] | undefined {
    return methods?.map(
        (method) =>
            ({
                ...method,
                id: method.methodId
            }) as unknown as AuthMethod
    );
}

/**
 * v2 若干结构是开放联合，字段退化为 string | undefined。
 * 该谓词既做运行时的取值校验（与 includes 等价），又完成类型收窄，
 * 避免用 as 把 string 硬塞给字面量联合。
 */
function isKnownValue<T extends string>(known: readonly T[], value: string | undefined): value is T {
    return value !== undefined && known.some((candidate) => candidate === value);
}

const KNOWN_PLAN_PRIORITIES = ['low', 'medium', 'high'] as const;

// PlanEntryStatus 未包含 'cancelled'，但 v2 线上形状会带该值，保持透传不被改写
const KNOWN_PLAN_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const;

function permissionRequest(params: acpV2.RequestPermissionRequest): RequestPermissionRequest {
    const subject = params.subject;
    const toolCall =
        subject?.type === 'tool_call'
            ? subject.toolCall
            : subject?.type === 'command'
              ? {
                    toolCallId: subject.toolCallId ?? subject.terminalId ?? crypto.randomUUID(),
                    title: params.title,
                    kind: 'execute' as const,
                    locations: [{ path: subject.cwd }],
                    rawInput: { command: subject.command, cwd: subject.cwd }
                }
              : {
                    toolCallId: crypto.randomUUID(),
                    title: params.title,
                    kind: 'other' as const,
                    rawInput: params.description ? { description: params.description } : undefined
                };
    return {
        sessionId: params.sessionId,
        toolCall: toolCall as RequestPermissionRequest['toolCall'],
        options: params.options
            .filter((option) => ['allow_once', 'allow_always', 'reject_once', 'reject_always'].includes(option.kind))
            .map((option) => ({ ...option, kind: option.kind as RequestPermissionRequest['options'][number]['kind'] }))
    };
}

export function createV2ConnectionHandle(
    profile: AcpAgentProfile,
    handlers: AcpClientHandlers,
    target: V2Target
): AcpConnectionHandle {
    if (profile.protocolVersion !== 2) throw new Error(t('acpmgr.error.v2ProfileRequired'));
    let capabilities: acpV2.AgentCapabilities | undefined;
    const promptWaiters = new Map<string, PromptWaiter[]>();
    const toolContent = new Map<string, acpV2.ToolCallContent[]>();
    const terminals = new Map<string, V2TerminalSnapshot>();

    const finishPrompt = (sessionId: string, stopReason: string): void => {
        const queue = promptWaiters.get(sessionId);
        const waiter = queue?.shift();
        if (queue?.length === 0) promptWaiters.delete(sessionId);
        waiter?.resolve(stopReason);
    };

    const normalizeUpdate = (params: acpV2.UpdateSessionNotification): SessionNotification | undefined => {
        const update = params.update as V2KnownSessionUpdate;
        switch (update.sessionUpdate) {
            case 'agent_message_chunk':
            case 'agent_thought_chunk':
            case 'user_message_chunk': {
                return {
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: update.sessionUpdate,
                        content: update.content,
                        _meta: {
                            ...(update._meta ?? {}),
                            'opendesk/messageId': update.messageId
                        }
                    }
                } as SessionNotification;
            }
            case 'agent_message':
            case 'agent_thought':
            case 'user_message': {
                if (update.content === undefined) return undefined;
                const next = textContent(update.content);
                const sessionUpdate =
                    update.sessionUpdate === 'agent_message'
                        ? 'agent_message_chunk'
                        : update.sessionUpdate === 'agent_thought'
                          ? 'agent_thought_chunk'
                          : 'user_message_chunk';
                return {
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate,
                        content: { type: 'text', text: next },
                        _meta: {
                            ...(update._meta ?? {}),
                            'opendesk/messageId': update.messageId,
                            'opendesk/replace': true
                        }
                    }
                } as SessionNotification;
            }
            case 'tool_call_content_chunk': {
                const content = [...(toolContent.get(update.toolCallId) ?? []), update.content].slice(
                    -MAX_TOOL_CONTENT_ITEMS
                );
                toolContent.set(update.toolCallId, content);
                return {
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: 'tool_call_update',
                        toolCallId: update.toolCallId,
                        rawOutput: content
                    }
                } as SessionNotification;
            }
            case 'tool_call_update': {
                if (update.content !== undefined) toolContent.set(update.toolCallId, update.content ?? []);
                return {
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: 'tool_call_update',
                        toolCallId: update.toolCallId,
                        ...(update.name != null ? { name: update.name } : {}),
                        ...(update.title != null ? { title: update.title } : {}),
                        ...(update.status != null ? { status: update.status } : {}),
                        ...(update.locations != null ? { locations: update.locations } : {}),
                        ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
                        ...(update.rawOutput !== undefined
                            ? { rawOutput: update.rawOutput }
                            : toolContent.has(update.toolCallId)
                              ? { rawOutput: toolContent.get(update.toolCallId) }
                              : {})
                    }
                } as SessionNotification;
            }
            case 'terminal_update': {
                const previous = terminals.get(update.terminalId) ?? { output: Buffer.alloc(0), exited: false };
                const next: V2TerminalSnapshot = {
                    command: update.command === undefined ? previous.command : (update.command ?? undefined),
                    cwd: update.cwd === undefined ? previous.cwd : (update.cwd ?? undefined),
                    output:
                        update.output === undefined
                            ? previous.output
                            : appendTerminalOutput(Buffer.alloc(0), Buffer.from(update.output?.data ?? '', 'base64')),
                    exited: update.exitStatus === undefined ? previous.exited : update.exitStatus !== null
                };
                terminals.set(update.terminalId, next);
                return {
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: 'tool_call_update',
                        toolCallId: `terminal:${update.terminalId}`,
                        title: next.command || t('acpmgr.v2.terminalTitle'),
                        status: next.exited ? 'completed' : 'in_progress',
                        rawInput: { command: next.command, cwd: next.cwd },
                        rawOutput: next.output.toString('utf8')
                    }
                } as SessionNotification;
            }
            case 'terminal_output_chunk': {
                const previous = terminals.get(update.terminalId) ?? { output: Buffer.alloc(0), exited: false };
                previous.output = appendTerminalOutput(previous.output, Buffer.from(update.data, 'base64'));
                terminals.set(update.terminalId, previous);
                return {
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: 'tool_call_update',
                        toolCallId: `terminal:${update.terminalId}`,
                        title: previous.command || t('acpmgr.v2.terminalTitle'),
                        status: previous.exited ? 'completed' : 'in_progress',
                        rawInput: { command: previous.command, cwd: previous.cwd },
                        rawOutput: previous.output.toString('utf8')
                    }
                } as SessionNotification;
            }
            case 'plan_update': {
                // v2 PlanUpdate 亦为开放联合（含 { type: string } 自定义变体），按已知形状取用
                const plan = update.plan as {
                    type: string;
                    content?: string;
                    uri?: string;
                    entries?: Array<{ content?: string; priority?: string; status?: string }>;
                };
                if (plan.type === 'markdown') {
                    return {
                        sessionId: params.sessionId,
                        update: {
                            sessionUpdate: 'plan',
                            entries: [{ content: plan.content ?? '', priority: 'medium', status: 'in_progress' }]
                        }
                    };
                }
                if (plan.type === 'file') {
                    return {
                        sessionId: params.sessionId,
                        update: {
                            sessionUpdate: 'plan',
                            entries: [{ content: plan.uri ?? '', priority: 'medium', status: 'in_progress' }]
                        }
                    };
                }
                if (plan.type !== 'items') return params as unknown as SessionNotification;
                return {
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: 'plan',
                        entries: (plan.entries ?? []).map((entry) => ({
                            content: entry.content,
                            priority: isKnownValue(KNOWN_PLAN_PRIORITIES, entry.priority) ? entry.priority : 'medium',
                            status: isKnownValue(KNOWN_PLAN_STATUSES, entry.status) ? entry.status : 'pending'
                        })) as PlanEntry[]
                    }
                };
            }
            case 'plan_removed':
                return { sessionId: params.sessionId, update: { sessionUpdate: 'plan', entries: [] } };
            case 'state_update': {
                // OpenDesk v2 对端实际发送扁平形状：state 为 'idle' 等字符串、stopReason 为
                // 兄弟字段（与 SDK StateUpdate 的嵌套类型不符），按线上形状处理，
                // 形状由 connection-v2.test.ts 的 idle 用例锁定
                const stateUpdate = update as unknown as { state?: string; stopReason?: string };
                if (stateUpdate.state === 'idle') finishPrompt(params.sessionId, stateUpdate.stopReason ?? 'end_turn');
                return undefined;
            }
            default:
                return {
                    sessionId: params.sessionId,
                    update: update as unknown as SessionUpdate
                };
        }
    };

    const client = acpV2
        .client({ name: 'OpenDesk' })
        .onRequest(acpV2.methods.client.session.requestPermission, async (context) => {
            const request = permissionRequest(context.params);
            if (request.options.length === 0) return { outcome: { outcome: 'cancelled' } };
            return handlers.requestPermission(request) as Promise<acpV2.RequestPermissionResponse>;
        })
        .onNotification(acpV2.methods.client.session.update, async (context) => {
            const normalized = normalizeUpdate(context.params);
            if (normalized) await handlers.sessionUpdate(normalized);
        })
        .onRequest(acpV2.methods.client.mcp.connect, async (context) => {
            if (!handlers.connectMcp) throw new Error(t('acpmgr.error.clientMcpUnavailable'));
            return handlers.connectMcp(context.params, {
                request: (params) => context.agent.request(acpV2.methods.agent.mcp.message, params),
                notify: (params) => context.agent.notify(acpV2.methods.agent.mcp.message, params)
            });
        })
        .onRequest(acpV2.methods.client.mcp.message, async (context) => {
            if (!handlers.messageMcp) throw new Error(t('acpmgr.error.clientMcpUnavailable'));
            return handlers.messageMcp(context.params);
        })
        .onNotification(acpV2.methods.client.mcp.message, async (context) => {
            if (!handlers.notifyMcp) throw new Error(t('acpmgr.error.clientMcpUnavailable'));
            await handlers.notifyMcp(context.params);
        })
        .onRequest(acpV2.methods.client.mcp.disconnect, async (context) => {
            if (!handlers.disconnectMcp) throw new Error(t('acpmgr.error.clientMcpUnavailable'));
            return handlers.disconnectMcp(context.params);
        });
    const connection = client.connect(target as acpV2.Stream & acpV2.AgentApp);
    const agent = connection.agent;

    // v2 的 session/resume 请求允许省略 mcpServers（SDK 类型里是可选），
    // 省略等价于「不连接任何 MCP server」，因此这里统一按空列表处理。
    const mcpServers = (servers: McpServer[] | undefined): acpV2.McpServer[] => {
        if (!capabilities?.session) throw new Error(t('acpmgr.error.v2SessionUnsupported'));
        const direct = (servers ?? []).map(directMcpServer);
        for (const server of direct) {
            if (server.type === 'stdio' && !capabilities?.session?.mcp?.stdio) {
                throw new Error(t('acpmgr.error.v2McpStdioUnsupported'));
            }
            if (server.type === 'http' && !capabilities?.session?.mcp?.http) {
                throw new Error(t('acpmgr.error.v2McpHttpUnsupported'));
            }
        }
        if (!handlers.clientMcpServer) return direct;
        if (!capabilities?.session?.mcp?.acp) throw new Error(t('acpmgr.error.v2ClientMcpUnsupported'));
        return [
            ...direct,
            { type: 'acp', name: handlers.clientMcpServer.name, serverId: handlers.clientMcpServer.serverId }
        ];
    };

    const normalized: AcpClientConnection = {
        initialize: async (params: InitializeRequest) => {
            const result = await agent.request(acpV2.methods.agent.initialize, {
                protocolVersion: 2,
                capabilities: {},
                info: {
                    name: params.clientInfo?.name ?? 'OpenDesk',
                    title: params.clientInfo?.title,
                    version: params.clientInfo?.version ?? '0.3.4'
                }
            });
            capabilities = result.capabilities;
            return {
                protocolVersion: result.protocolVersion,
                agentCapabilities: {
                    loadSession: true,
                    promptCapabilities: {
                        image: !!result.capabilities?.session?.prompt?.image,
                        audio: !!result.capabilities?.session?.prompt?.audio,
                        embeddedContext: !!result.capabilities?.session?.prompt?.embeddedContext
                    },
                    sessionCapabilities: { resume: {}, close: {}, list: {} },
                    _meta: { v2Capabilities: result.capabilities ?? {} }
                },
                agentInfo: result.info,
                authMethods: normalizeAuthMethods(result.authMethods)
            };
        },
        authenticate: async (params) => {
            await agent.request(acpV2.methods.agent.auth.login, { methodId: params.methodId });
            return {};
        },
        newSession: async (params) => {
            const result = await agent.request(acpV2.methods.agent.session.new, {
                cwd: params.cwd,
                mcpServers: mcpServers(params.mcpServers)
            });
            return {
                ...result,
                configOptions: normalizeConfigOptions(result.configOptions)
            } as unknown as Awaited<ReturnType<AcpClientConnection['newSession']>>;
        },
        loadSession: async (params) => {
            const result = await agent.request(acpV2.methods.agent.session.resume, {
                sessionId: params.sessionId,
                cwd: params.cwd,
                mcpServers: mcpServers(params.mcpServers),
                replayFrom: { type: 'start' }
            });
            return {
                ...result,
                configOptions: normalizeConfigOptions(result.configOptions)
            } as unknown as Awaited<ReturnType<NonNullable<AcpClientConnection['loadSession']>>>;
        },
        resumeSession: async (params) => {
            const result = await agent.request(acpV2.methods.agent.session.resume, {
                sessionId: params.sessionId,
                cwd: params.cwd,
                mcpServers: mcpServers(params.mcpServers)
            });
            return {
                ...result,
                configOptions: normalizeConfigOptions(result.configOptions)
            } as unknown as Awaited<ReturnType<NonNullable<AcpClientConnection['resumeSession']>>>;
        },
        setSessionMode: async (params) => {
            const result = await agent.request(acpV2.methods.agent.session.setConfigOption, {
                sessionId: params.sessionId,
                configId: 'mode',
                type: 'id',
                value: params.modeId
            });
            return {
                configOptions: normalizeConfigOptions(result.configOptions) ?? []
            } as unknown as Awaited<ReturnType<NonNullable<AcpClientConnection['setSessionMode']>>>;
        },
        setSessionConfigOption: async (params) => {
            const result = await agent.request(acpV2.methods.agent.session.setConfigOption, {
                sessionId: params.sessionId,
                configId: params.configId,
                type: 'type' in params && params.type === 'boolean' ? 'boolean' : 'id',
                value: params.value
            } as acpV2.SetSessionConfigOptionRequest);
            return {
                configOptions: normalizeConfigOptions(result.configOptions) ?? []
            } as unknown as Awaited<ReturnType<NonNullable<AcpClientConnection['setSessionConfigOption']>>>;
        },
        prompt: async (params) => {
            const completion = new Promise<string>((resolve, reject) => {
                const queue = promptWaiters.get(params.sessionId) ?? [];
                queue.push({ resolve, reject });
                promptWaiters.set(params.sessionId, queue);
            });
            try {
                await agent.request(acpV2.methods.agent.session.prompt, params as acpV2.PromptRequest);
                return { stopReason: (await completion) as 'end_turn' };
            } catch (error) {
                const queue = promptWaiters.get(params.sessionId);
                const waiter = queue?.shift();
                waiter?.reject(error);
                throw error;
            }
        },
        cancel: (params) => agent.notify(acpV2.methods.agent.session.cancel, params),
        closeSession: (params) => agent.request(acpV2.methods.agent.session.close, params)
    };

    void connection.closed.then(() => {
        const error = new Error(t('acpmgr.error.connectionClosed'));
        for (const queue of promptWaiters.values()) {
            for (const waiter of queue) waiter.reject(error);
        }
        promptWaiters.clear();
    });

    return {
        connection: normalized,
        closed: connection.closed,
        close: async () => connection.close()
    };
}
