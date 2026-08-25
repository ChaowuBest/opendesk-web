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

interface PromptWaiter {
    resolve(stopReason: string): void;
    reject(error: unknown): void;
}

function textContent(blocks: acpV2.ContentBlock[] | null | undefined): string {
    return (blocks ?? [])
        .filter((block): block is acpV2.TextContent & { type: 'text' } => block.type === 'text')
        .map((block) => block.text)
        .join('');
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
                          options: option.options.map((entry) =>
                              'groupId' in entry ? { ...entry, group: entry.groupId } : entry
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

    const finishPrompt = (sessionId: string, stopReason: string): void => {
        const queue = promptWaiters.get(sessionId);
        const waiter = queue?.shift();
        if (queue?.length === 0) promptWaiters.delete(sessionId);
        waiter?.resolve(stopReason);
    };

    const normalizeUpdate = (params: acpV2.UpdateSessionNotification): SessionNotification | undefined => {
        const update = params.update;
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
            case 'tool_call_update':
                return params as unknown as SessionNotification;
            case 'plan_update':
                if (update.plan.type !== 'items') return params as unknown as SessionNotification;
                return {
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: 'plan',
                        entries: update.plan.entries.map((entry) => ({
                            content: entry.content,
                            priority: ['low', 'medium', 'high'].includes(entry.priority)
                                ? (entry.priority as 'low' | 'medium' | 'high')
                                : 'medium',
                            status: ['pending', 'in_progress', 'completed'].includes(entry.status)
                                ? (entry.status as 'pending' | 'in_progress' | 'completed')
                                : 'pending'
                        }))
                    }
                };
            case 'state_update':
                if (update.state === 'idle') finishPrompt(params.sessionId, update.stopReason ?? 'end_turn');
                return undefined;
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

    const mcpServers = (servers: McpServer[]): acpV2.McpServer[] => {
        if (!capabilities?.session) throw new Error(t('acpmgr.error.v2SessionUnsupported'));
        const direct = servers.map(directMcpServer);
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
            } as unknown as Awaited<ReturnType<AcpClientConnection['setSessionMode']>>;
        },
        setSessionConfigOption: async (params) => {
            const result = await agent.request(acpV2.methods.agent.session.setConfigOption, {
                sessionId: params.sessionId,
                configId: params.configId,
                type: params.type === 'boolean' ? 'boolean' : 'id',
                value: params.value
            } as acpV2.SetSessionConfigOptionRequest);
            return {
                configOptions: normalizeConfigOptions(result.configOptions) ?? []
            } as unknown as Awaited<ReturnType<AcpClientConnection['setSessionConfigOption']>>;
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
