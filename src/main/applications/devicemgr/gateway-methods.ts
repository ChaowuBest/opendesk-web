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

/**
 * OpenClaw 兼容方法桥接。
 * 将 openclaw 客户端发来的 RPC 方法（chat.send、sessions.list 等）
 * 桥接到 OpenDesk 内部的任务/会话系统。
 */

import { randomUUID } from 'node:crypto';
import { logger } from '../../utils/logger.js';
import type { DeviceGateway, GatewayMethodHandler, ConnectionState } from './gateway.js';
import type { TaskManagerState, TaskState, TaskUpdateChunk } from '../../aikernel/states/tasks.js';
import { BaseTaskUpdateSubscriber, isTaskVisibleForDeveloperMode } from '../../aikernel/states/tasks.js';
import { MainAgentDecl } from '../../aikernel/agents/main/agent.js';
import { HarnessContext } from '../../aikernel/security/harness.js';
import type { BaseToolset } from '../../aikernel/tool.js';
import { isDeveloperModeEnabled } from '../../utils/setting.js';

const TAG = '[devicemgr:gateway-methods]';

/**
 * 连接 chat.send 所需的上下文依赖。
 * 由外部在注册时传入，以便方法处理器可以创建和管理任务。
 */
export interface GatewayMethodContext {
    taskManagerState: TaskManagerState;
    model?: string;
    workspace: string;
    extraToolsets?: BaseToolset[];
}

/**
 * 按连接维度跟踪 chat 会话——同一连接的同一 sessionKey 复用 task。
 */
const sessionTaskMap = new Map<string, { taskId: string; lastMessageAt: number }>();

function sessionTaskKey(connId: string, sessionKey: string): string {
    return `${connId}:${sessionKey}`;
}

/**
 * 将 TaskUpdateChunk 转换为 OpenClaw chat 事件 payload。
 */
function chunkToEventPayload(runId: string, sessionKey: string, chunk: TaskUpdateChunk, seq: number): object | null {
    if (chunk.type === 'assistant') {
        const part = chunk.last_part;
        // last_part 可能不存在（如流式更新异常），跳过处理
        if (!part) return null;
        if (part.type === 'text') {
            return {
                runId,
                sessionKey,
                seq,
                state: chunk.task_status === 'running' ? 'delta' : 'final',
                message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: part.text }]
                }
            };
        }
        if (part.type === 'reasoning') {
            return {
                runId,
                sessionKey,
                seq,
                state: 'delta',
                thinking: part.content
            };
        }
        if (part.type === 'tool_call') {
            const calls = part.toolcalls.map((tc) => ({
                name: tc.tool_name,
                status: tc.status,
                args: tc.args_string,
                result: typeof tc.result === 'string' ? tc.result.slice(0, 500) : undefined
            }));
            return {
                runId,
                sessionKey,
                seq,
                state: 'delta',
                toolCalls: calls
            };
        }
        if (part.type === 'error') {
            return {
                runId,
                sessionKey,
                seq,
                state: 'error',
                errorMessage: part.message
            };
        }
    }
    return null;
}

/**
 * 为 DeviceGateway 注册所有 openclaw 兼容的 operator 方法处理器。
 * @param gateway  DeviceGateway 实例
 * @param ctx      可选的上下文，提供 taskManagerState 等依赖。若不传则 chat.send 等仍返回 stub。
 */
export function registerOpenClawMethods(gateway: DeviceGateway, ctx?: GatewayMethodContext): void {
    const handlers: Record<string, GatewayMethodHandler> = {
        health: handleHealth,
        status: handleStatus,
        'chat.send': ctx ? makeChatSendHandler(gateway, ctx) : handleChatSendStub,
        'chat.history': ctx ? makeChatHistoryHandler(ctx) : handleChatHistoryStub,
        'chat.abort': ctx ? makeChatAbortHandler(ctx) : handleChatAbortStub,
        'sessions.list': ctx ? makeSessionsListHandler(ctx) : handleSessionsListStub,
        'sessions.create': handleSessionsCreate,
        'sessions.subscribe': handleStub('sessions.subscribe'),
        'sessions.unsubscribe': handleStub('sessions.unsubscribe'),
        'sessions.send': ctx ? makeChatSendHandler(gateway, ctx) : handleChatSendStub,
        'sessions.abort': ctx ? makeChatAbortHandler(ctx) : handleChatAbortStub,
        'sessions.patch': handleStub('sessions.patch'),
        'sessions.reset': handleStub('sessions.reset'),
        'sessions.delete': handleStub('sessions.delete'),
        'sessions.preview': handleStub('sessions.preview'),
        'sessions.compact': handleStub('sessions.compact'),
        'sessions.messages.subscribe': handleStub('sessions.messages.subscribe'),
        'sessions.messages.unsubscribe': handleStub('sessions.messages.unsubscribe'),
        'models.list': handleModelsList,
        'tools.catalog': handleToolsCatalog,
        'agents.list': handleAgentsList,
        'agents.create': handleStub('agents.create'),
        'agents.update': handleStub('agents.update'),
        'agents.delete': handleStub('agents.delete'),
        'config.get': handleConfigGet,
        'config.set': handleStub('config.set'),
        'config.apply': handleStub('config.apply'),
        'config.patch': handleStub('config.patch'),
        'config.schema': handleStub('config.schema'),
        send: handleSend,
        agent: handleStub('agent'),
        'agent.identity.get': handleAgentIdentityGet,
        'gateway.identity.get': handleGatewayIdentityGet(gateway),
        'system-presence': handleSystemPresence(gateway),
        'system-event': handleStub('system-event'),
        'skills.status': handleStub('skills.status'),
        'skills.bins': handleStub('skills.bins'),
        'talk.config': handleStub('talk.config'),
        'talk.mode': handleStub('talk.mode'),
        'channels.status': handleStub('channels.status'),
        'logs.tail': handleStub('logs.tail'),
        'last-heartbeat': handleLastHeartbeat,
        'set-heartbeats': handleStub('set-heartbeats'),
        wake: handleWake
    };

    gateway.registerMethods(handlers);
    logger.info(`${TAG} 已注册 ${Object.keys(handlers).length} 个 OpenClaw 兼容方法`);
}

// ── Health / Status ──────────────────────────────────────────────────────────

const handleHealth: GatewayMethodHandler = (_conn, _frame, _params, respond) => {
    respond(true, {
        ok: true,
        version: '1.0.0',
        uptime: process.uptime()
    });
};

const handleStatus: GatewayMethodHandler = (_conn, _frame, _params, respond) => {
    respond(true, {
        version: '1.0.0',
        platform: process.platform,
        uptime: process.uptime()
    });
};

// ── Chat methods ─────────────────────────────────────────────────────────────

/**
 * 创建真正桥接到任务系统的 chat.send / sessions.send 处理器。
 * 流程与 CLI 一致：创建/复用 task → submitUserMessage → 订阅更新 → 流式推送 chat 事件。
 */
function makeChatSendHandler(gateway: DeviceGateway, ctx: GatewayMethodContext): GatewayMethodHandler {
    const agentDecl = new MainAgentDecl();

    return async (conn: ConnectionState, _frame, params, respond) => {
        const sessionKey: string = params?.sessionKey ?? 'main';
        const message: string | undefined = params?.message;
        const runId: string = params?.idempotencyKey ?? randomUUID();

        // 解析附件（与 OpenClaw Node Protocol 保持一致）
        // 附件格式: { type?: string, mimeType?: string, fileName?: string, content?: string }
        // content 为 base64 编码（不含 data:xxx;base64, 前缀，也可兼容带前缀的格式）
        const rawAttachments: any[] | undefined = params?.attachments;

        // 校验：纯文本消息必须有 message，带附件的消息允许 message 为空
        const hasMessageText = typeof message === 'string' && message.trim().length > 0;
        const hasAttachments = Array.isArray(rawAttachments) && rawAttachments.length > 0;
        if (!hasMessageText && !hasAttachments) {
            respond(false, undefined, {
                code: 'INVALID_REQUEST',
                message: 'message is required'
            });
            return;
        }

        // 立即 ACK，让客户端知道 runId
        respond(true, { runId, status: 'started' });

        try {
            const task = await resolveOrCreateTask(ctx, agentDecl, conn.connId, sessionKey);

            // 如果任务正在运行，等待它完成
            if (task.task_status === 'running') {
                await task.waitUntilFinished();
            }

            let seq = 0;

            // 订阅任务更新，流式推送到客户端
            const subscriber = new GatewayTaskSubscriber(conn.connId, (chunk: TaskUpdateChunk) => {
                seq++;
                const payload = chunkToEventPayload(runId, sessionKey, chunk, seq);
                if (payload) {
                    gateway.sendEventToConnection(conn.connId, 'chat', payload);
                }
            });
            task.addSubscriber(subscriber);

            // 解析附件中的图片，转换为 data URI（与 OpenClaw Node Protocol 兼容）
            const imageDataUris: string[] = [];
            if (hasAttachments) {
                for (const att of rawAttachments) {
                    if (!att || typeof att !== 'object') continue;
                    const attType = att.type || att.mimeType || '';
                    const mimeType = att.mimeType || 'image/png';
                    const content = att.content;

                    // 仅处理图片类型附件
                    if (typeof content !== 'string' || !content.trim()) continue;
                    if (!attType.startsWith('image/') && attType !== 'image') continue;

                    // 兼容两种格式：纯 base64 或带 data:xxx;base64, 前缀
                    let base64 = content.trim();
                    const dataUrlMatch = /^data:[^;]+;base64,(.*)$/.exec(base64);
                    if (dataUrlMatch) {
                        base64 = dataUrlMatch[1];
                    }

                    // 构造 data URI（ImageMessagePart 期望的格式）
                    const dataUri = `data:${mimeType};base64,${base64}`;
                    imageDataUris.push(dataUri);
                }
            }

            // 提交用户消息——与 CLI 完全一致
            const text = hasMessageText ? message!.trim() : '';
            await task.submitUserMessage(text, {
                imageDataUris: imageDataUris.length > 0 ? imageDataUris : undefined
            });

            // 等待任务完成
            await task.waitUntilFinished();

            // 移除订阅
            task.removeSubscriber(subscriber.subscription_id);

            // 提取最终文本发送 final 帧
            const finalText = extractFinalText(task);
            seq++;
            gateway.sendEventToConnection(conn.connId, 'chat', {
                runId,
                sessionKey,
                seq,
                state: 'final',
                message: finalText
                    ? {
                          role: 'assistant',
                          content: [{ type: 'text', text: finalText }],
                          timestamp: Date.now()
                      }
                    : undefined
            });
        } catch (err: any) {
            logger.error(`${TAG} chat.send 处理失败: ${err?.message || err}`);
            gateway.sendEventToConnection(conn.connId, 'chat', {
                runId,
                sessionKey,
                seq: 1,
                state: 'error',
                errorMessage: err?.message || String(err)
            });
        }
    };
}

/**
 * 解析或创建会话任务——与 ChannelMessageRouter.resolveSessionTask 逻辑类似。
 */
async function resolveOrCreateTask(
    ctx: GatewayMethodContext,
    agentDecl: MainAgentDecl,
    connId: string,
    sessionKey: string
): Promise<TaskState> {
    const key = sessionTaskKey(connId, sessionKey);
    const entry = sessionTaskMap.get(key);

    if (entry) {
        const existing = ctx.taskManagerState.getTask(entry.taskId);
        if (existing) {
            entry.lastMessageAt = Date.now();
            return existing;
        }
        sessionTaskMap.delete(key);
    }

    const task = ctx.taskManagerState.createTask(ctx.model);
    task.harnessContext = HarnessContext.createEmpty();
    task.harnessContext.workspace = ctx.workspace;
    const systemPrompt = await agentDecl.createSystemPrompt(undefined, task);
    await task.setSystemPrompt(systemPrompt);
    task.task_name = `Gateway: ${sessionKey}`;

    // 挂载额外的工具集（如 SendFileTool），与 channel 路径行为一致
    if (ctx.extraToolsets && ctx.extraToolsets.length > 0) {
        for (const ts of ctx.extraToolsets) {
            task.chat_context.attachToolsets(ts);
        }
    }

    sessionTaskMap.set(key, { taskId: task.task_id, lastMessageAt: Date.now() });
    return task;
}

/**
 * 从任务最后一条 AssistantMessage 中提取最终文本回复。
 */
function extractFinalText(task: TaskState): string | null {
    const messages = task.chat_context.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === 'assistant') {
            for (let j = msg.content.length - 1; j >= 0; j--) {
                const part = msg.content[j];
                if (part.type === 'text' && (part as any).text) {
                    return (part as any).text.trim();
                }
            }
        }
    }
    return null;
}

/**
 * 网关专用的任务更新订阅者，将 chunk 通过回调推送。
 * 当底层连接断开时 isAvailable() 返回 false 让任务自动清理。
 */
class GatewayTaskSubscriber extends BaseTaskUpdateSubscriber {
    private connId: string;
    private callback: (chunk: TaskUpdateChunk) => void;

    constructor(connId: string, callback: (chunk: TaskUpdateChunk) => void) {
        super();
        this.connId = connId;
        this.callback = callback;
    }

    send(chunkUpdate: TaskUpdateChunk): void {
        try {
            this.callback(chunkUpdate);
        } catch {
            // ignore errors — connection may have been closed
        }
    }
}

const handleChatSendStub: GatewayMethodHandler = (_conn, _frame, params, respond) => {
    const runId = params?.idempotencyKey ?? randomUUID();
    respond(true, { runId, status: 'started' });
};

/**
 * chat.history：返回指定 session 对应的任务历史消息。
 */
function makeChatHistoryHandler(ctx: GatewayMethodContext): GatewayMethodHandler {
    return (conn, _frame, params, respond) => {
        const sessionKey: string = params?.sessionKey ?? 'main';
        const key = sessionTaskKey(conn.connId, sessionKey);
        const entry = sessionTaskMap.get(key);
        if (!entry) {
            respond(true, { sessionKey, messages: [] });
            return;
        }
        const task = ctx.taskManagerState.getTask(entry.taskId);
        if (!task) {
            respond(true, { sessionKey, messages: [] });
            return;
        }

        const messages: object[] = [];
        for (const msg of task.chat_context.messages) {
            if (msg.role === 'user') {
                const textParts = msg.content.filter((p: any) => p.type === 'text').map((p: any) => p.text);
                if (textParts.length > 0) {
                    messages.push({
                        role: 'user',
                        content: textParts.join('\n')
                    });
                }
            } else if (msg.role === 'assistant') {
                const textParts = msg.content
                    .filter((p: any) => p.type === 'text' && (p as any).text)
                    .map((p: any) => (p as any).text);
                if (textParts.length > 0) {
                    messages.push({
                        role: 'assistant',
                        content: [{ type: 'text', text: textParts.join('\n') }]
                    });
                }
            }
        }

        respond(true, { sessionKey, messages });
    };
}

const handleChatHistoryStub: GatewayMethodHandler = (_conn, _frame, params, respond) => {
    const sessionKey = params?.sessionKey ?? 'main';
    respond(true, { sessionKey, messages: [] });
};

/**
 * chat.abort：停止指定 session 正在运行的任务。
 */
function makeChatAbortHandler(ctx: GatewayMethodContext): GatewayMethodHandler {
    return (conn, _frame, params, respond) => {
        const sessionKey: string = params?.sessionKey ?? 'main';
        const key = sessionTaskKey(conn.connId, sessionKey);
        const entry = sessionTaskMap.get(key);

        if (!entry) {
            respond(true, { ok: true, aborted: false, runIds: [] });
            return;
        }

        const task = ctx.taskManagerState.getTask(entry.taskId);
        if (!task || task.task_status !== 'running') {
            respond(true, { ok: true, aborted: false, runIds: [] });
            return;
        }

        task.stop('user');
        respond(true, { ok: true, aborted: true, runIds: [entry.taskId] });
    };
}

const handleChatAbortStub: GatewayMethodHandler = (_conn, _frame, _params, respond) => {
    respond(true, { ok: true, aborted: false, runIds: [] });
};

// ── Session methods ──────────────────────────────────────────────────────────

function makeSessionsListHandler(ctx: GatewayMethodContext): GatewayMethodHandler {
    return (_conn, _frame, _params, respond) => {
        const taskList = ctx.taskManagerState.getTaskList();
        const developerMode = isDeveloperModeEnabled();
        const sessions = taskList
            .filter((task) => isTaskVisibleForDeveloperMode(task, developerMode))
            .map((t: any) => ({
                sessionKey: t.task_id,
                sessionId: t.task_id,
                title: t.task_name || '未命名',
                createdAt: t.started_at,
                updatedAt: t.finished_at || t.started_at
            }));
        respond(true, { sessions });
    };
}

const handleSessionsListStub: GatewayMethodHandler = (_conn, _frame, _params, respond) => {
    respond(true, { sessions: [] });
};

const handleSessionsCreate: GatewayMethodHandler = (_conn, _frame, params, respond) => {
    const sessionKey = params?.sessionKey ?? `session-${randomUUID().slice(0, 8)}`;
    respond(true, {
        sessionKey,
        sessionId: randomUUID(),
        created: true
    });
};

// ── Models / Tools / Agents ──────────────────────────────────────────────────

const handleModelsList: GatewayMethodHandler = (_conn, _frame, _params, respond) => {
    respond(true, { models: [] });
};

const handleToolsCatalog: GatewayMethodHandler = (_conn, _frame, _params, respond) => {
    respond(true, { tools: [] });
};

const handleAgentsList: GatewayMethodHandler = (_conn, _frame, _params, respond) => {
    respond(true, { agents: [] });
};

// ── Config ───────────────────────────────────────────────────────────────────

const handleConfigGet: GatewayMethodHandler = (_conn, _frame, _params, respond) => {
    respond(true, { config: {} });
};

// ── Send (outbound) ──────────────────────────────────────────────────────────

const handleSend: GatewayMethodHandler = (_conn, _frame, params, respond) => {
    if (!params?.to || !params?.message) {
        respond(false, undefined, {
            code: 'INVALID_REQUEST',
            message: 'to and message are required'
        });
        return;
    }
    respond(true, {
        runId: params?.idempotencyKey ?? randomUUID(),
        status: 'sent'
    });
};

// ── Identity ─────────────────────────────────────────────────────────────────

const handleAgentIdentityGet: GatewayMethodHandler = (_conn, _frame, _params, respond) => {
    respond(true, {
        agentId: 'default',
        displayName: 'OpenDesk Agent'
    });
};

function handleGatewayIdentityGet(gateway: DeviceGateway): GatewayMethodHandler {
    return (_conn, _frame, _params, respond) => {
        const identity = gateway.getIdentity();
        respond(true, { deviceId: identity.deviceId });
    };
}

// ── Presence ─────────────────────────────────────────────────────────────────

function handleSystemPresence(gateway: DeviceGateway): GatewayMethodHandler {
    return (_conn, _frame, _params, respond) => {
        const connected = gateway.getNodeRegistry().listConnected();
        const entries = connected.map((n) => ({
            key: n.nodeId,
            host: n.displayName ?? n.nodeId,
            platform: n.platform,
            version: n.version,
            mode: 'node',
            deviceId: n.nodeId
        }));
        respond(true, { entries });
    };
}

// ── Misc ─────────────────────────────────────────────────────────────────────

const handleLastHeartbeat: GatewayMethodHandler = (_conn, _frame, _params, respond) => {
    respond(true, { ts: Date.now() });
};

const handleWake: GatewayMethodHandler = (_conn, _frame, _params, respond) => {
    respond(true, { ok: true });
};

// ── Stub handler for not-yet-implemented methods ─────────────────────────────

function handleStub(method: string): GatewayMethodHandler {
    return (_conn, _frame, _params, respond) => {
        logger.debug(`${TAG} 方法 ${method} 尚未完全实现，返回空响应`);
        respond(true, {});
    };
}
