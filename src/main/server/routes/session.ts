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

import { Hono } from 'hono';
import crypto from 'crypto';
import { GlobalState } from '../../aikernel/states/global.js';
import type { TaskUpdateChunk } from '../../aikernel/states/tasks.js';
import { MainAgentDecl } from '../../aikernel/agents/main/agent.js';
import { getPlatform } from '../../../platforms/base.js';
import { EventBus } from '../event-bus.js';

/**
 * OpenCode Session ID ↔ OpenDesk Task ID 的映射。
 * OpenCode 使用 ses_ 前缀的 session ID，OpenDesk 使用 task_ 前缀的 task ID。
 * 为了兼容两种格式，统一将 opencode 风格的 ses_ ID 映射为内部 task ID。
 */
function toInternalId(sessionId: string): string {
    if (sessionId.startsWith('ses_')) {
        return sessionId.replace('ses_', 'task_');
    }
    return sessionId;
}

function toExternalId(taskId: string): string {
    if (taskId.startsWith('task_')) {
        return taskId.replace('task_', 'ses_');
    }
    return taskId;
}

function getWorkspaceDirectory(): string {
    try {
        return getPlatform().getEffectiveWorkspace();
    } catch {
        return process.cwd();
    }
}

let _ascendingCounter = 0;

/**
 * 生成单调递增的 ID（基于 ULID 思路：时间戳前缀 + 递增计数器 + 随机后缀）。
 * TUI 使用 binary search 按 id 排序，因此 id 必须字典序递增。
 */
function ascendingId(prefix: string): string {
    const ts = Date.now().toString(36).padStart(9, '0');
    const seq = (++_ascendingCounter).toString(36).padStart(4, '0');
    const rand = crypto.randomBytes(3).toString('hex');
    return `${prefix}_${ts}${seq}${rand}`;
}

/**
 * 将内部 task_status 映射为 opencode SessionStatus 格式。
 */
function toSessionStatus(taskStatus: string): Record<string, unknown> {
    if (taskStatus === 'running' || taskStatus === 'waiting') {
        return { type: 'busy' };
    }
    return { type: 'idle' };
}

/**
 * 将 OpenDesk task 转换为 opencode Session 格式。
 */
function taskToSessionInfo(task: any) {
    const sessionId = toExternalId(task.task_id);
    const dir = getWorkspaceDirectory();
    const dirName = dir.split('/').pop() || 'unknown';
    const parentID = task.parent_id ? toExternalId(task.parent_id) : undefined;
    return {
        id: sessionId,
        slug: sessionId.replace('ses_', ''),
        projectID: `proj_${dirName}`,
        directory: dir,
        title: task.task_name || '',
        ...(parentID ? { parentID } : {}),
        version: '1',
        agent: 'explore',
        time: {
            created: task.started_at ? new Date(task.started_at).getTime() : Date.now(),
            updated: task.updated_at ? new Date(task.updated_at).getTime() : Date.now()
        },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0
    };
}

function makeAssistantMessageInfo(
    msgId: string,
    sessionID: string,
    parentID: string,
    opts: { completed?: number } = {}
): Record<string, unknown> {
    const dir = getWorkspaceDirectory();
    return {
        id: msgId,
        sessionID,
        role: 'assistant',
        time: {
            created: Date.now(),
            ...(opts.completed ? { completed: opts.completed } : {})
        },
        parentID,
        modelID: '',
        providerID: '',
        mode: 'default',
        agent: 'explore',
        path: { cwd: dir, root: dir },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    };
}

function makeUserMessageInfo(msgId: string, sessionID: string): Record<string, unknown> {
    const dir = getWorkspaceDirectory();
    return {
        id: msgId,
        sessionID,
        role: 'user',
        time: {
            created: Date.now()
        },
        agent: 'explore',
        model: { providerID: '', modelID: '', id: '' },
        path: { cwd: dir, root: dir }
    };
}

/**
 * 将 OpenDesk 消息 part 转换为 opencode Part 格式。
 * opencode Part 需要 id, sessionID, messageID 字段。
 */
function partToMessagePart(
    part: UserMessagePart | AssistantMessagePart,
    sessionID: string = '',
    messageID: string = ''
): Record<string, unknown> {
    if (!part) return { type: 'text', id: ascendingId('prt'), sessionID, messageID, text: '' };
    const p = part as any;
    const partId = p.part_id || ascendingId('prt');
    const base = { id: partId, sessionID, messageID };

    if (p.type === 'text') {
        return { ...base, type: 'text', text: p.text ?? '' };
    }
    if (p.type === 'tool_call') {
        // ToolCallMessagePart has a `toolcalls` array; pick the last one for streaming
        const tc = p.toolcalls?.length > 0 ? p.toolcalls[p.toolcalls.length - 1] : p;
        const callID = tc.id || tc.call_id || partId;
        const toolName = tc.name || tc.tool_name || p.tool_name || '';
        const input = tc.args_string ? tryParseJson(tc.args_string) : tc.arguments ? tryParseJson(tc.arguments) : {};
        const status = tc.status || p.status;
        const output = tc.result ?? p.result ?? '';
        return {
            ...base,
            type: 'tool',
            callID,
            tool: toolName,
            state: mapToolState(status),
            input,
            output,
            time: { start: Date.now() }
        };
    }
    if (p.type === 'reasoning') {
        return { ...base, type: 'reasoning', text: p.content ?? p.text ?? '', time: { start: Date.now() } };
    }
    if (p.type === 'image') {
        return { ...base, type: 'file', mediaType: 'image', url: p.image_url ?? '' };
    }
    if (p.type === 'file') {
        return { ...base, type: 'file', file: p.filePath ?? '' };
    }
    if (p.type === 'error') {
        return { ...base, type: 'text', text: `Error: ${p.error ?? ''}` };
    }
    return { ...base, type: 'text', text: '' };
}

function mapToolState(status: string | undefined): Record<string, unknown> {
    if (status === 'pending') return { status: 'pending' };
    if (status === 'running') return { status: 'running' };
    if (status === 'success' || status === 'result')
        return { status: 'completed', time: { start: Date.now(), end: Date.now() } };
    if (status === 'error' || status === 'failed')
        return { status: 'error', time: { start: Date.now(), end: Date.now() } };
    return { status: 'completed', time: { start: Date.now(), end: Date.now() } };
}

function tryParseJson(str: string): unknown {
    try {
        return JSON.parse(str);
    } catch {
        return str;
    }
}

function messageToApiFormat(msg: any, index: number, sessionID: string = '') {
    const msgId = msg.message_id || `msg_${index}`;
    const parts = (msg.content || msg.parts || []).map((p: any) => partToMessagePart(p, sessionID, msgId));
    const dir = getWorkspaceDirectory();

    if (msg.role === 'assistant') {
        return {
            info: {
                id: msgId,
                sessionID,
                role: 'assistant',
                time: {
                    created: msg.timestamp || Date.now(),
                    completed: msg.completed_at || Date.now()
                },
                parentID: '',
                modelID: '',
                providerID: '',
                mode: 'default',
                agent: 'explore',
                path: { cwd: dir, root: dir },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
            },
            parts
        };
    }

    return {
        info: {
            id: msgId,
            sessionID,
            role: msg.role || 'user',
            time: {
                created: msg.timestamp || Date.now()
            },
            agent: 'explore',
            model: { providerID: '', modelID: '', id: '' },
            path: { cwd: dir, root: dir }
        },
        parts
    };
}

/**
 * 跟踪每个消息中各 part 类型的稳定 ID，确保流式更新中 ID 不变。
 * key: `${messageID}:${partType}:${partIndex}` → partId
 */
const _stablePartIds = new Map<string, string>();

/**
 * 获取或创建稳定的 part ID。对于同一消息中的同类型 part 使用固定 ID。
 */
function getStablePartId(messageID: string, partKey: string): string {
    const key = `${messageID}:${partKey}`;
    let id = _stablePartIds.get(key);
    if (!id) {
        id = ascendingId('prt');
        _stablePartIds.set(key, id);
    }
    return id;
}

/**
 * 将 TaskUpdateChunk 转换为 opencode SSE 事件并发布到 EventBus。
 * 用于实时流式更新 TUI 界面。
 *
 * 使用稳定的 part ID，这样 TUI 的 binary search 能正确匹配并更新已有 part，
 * 而不是不断创建新的 part 条目。
 */
function publishChunkEvents(sessionID: string, chunk: TaskUpdateChunk, assistantMsgId: string, userMsgId: string) {
    if (chunk.type === 'assistant') {
        const lastPart = chunk.last_part as any;
        if (!lastPart) return;

        // 根据 part 类型和 call_id 构建唯一键，用于稳定 ID
        let partKey: string;
        if (lastPart.type === 'tool_call') {
            partKey = `tool:${lastPart.call_id || 'default'}`;
        } else {
            partKey = `${lastPart.type || 'text'}:0`;
        }

        const stablePartId = getStablePartId(assistantMsgId, partKey);
        const part = partToMessagePart(lastPart, sessionID, assistantMsgId);
        // 覆盖为稳定 ID
        (part as any).id = stablePartId;

        // 发布 message.part.updated 事件（TUI 用此渲染流式内容）
        EventBus.publish({
            type: 'message.part.updated',
            properties: {
                sessionID,
                part,
                time: Date.now()
            }
        });

        // 发布 message.updated 事件（无 completed 表示仍在生成中）
        EventBus.publish({
            type: 'message.updated',
            properties: {
                sessionID,
                info: makeAssistantMessageInfo(assistantMsgId, sessionID, userMsgId)
            }
        });
    }
}

/**
 * Session 路由。
 * 对应 opencode 的 /session/* 端点。
 * 内部使用 OpenDesk 的 TaskManagerState 和 TaskState。
 */
export function SessionRoutes() {
    const app = new Hono();

    // GET /session - 列出所有会话
    app.get('/', (c) => {
        const tms = GlobalState.getInstance().taskManagerState;
        const search = c.req.query('search');
        const limitStr = c.req.query('limit');
        const rootsOnly = c.req.query('roots') === 'true';

        let tasks = tms.tasks.filter((t) => !t.parent_id || !rootsOnly);
        if (rootsOnly) {
            tasks = tms.tasks.filter((t) => !t.parent_id);
        }

        if (search) {
            const lowerSearch = search.toLowerCase();
            tasks = tasks.filter((t) => (t.task_name || '').toLowerCase().includes(lowerSearch));
        }

        if (limitStr) {
            const limit = parseInt(limitStr, 10);
            if (!isNaN(limit) && limit > 0) {
                tasks = tasks.slice(-limit);
            }
        }

        return c.json(tasks.map(taskToSessionInfo));
    });

    // GET /session/status - 获取所有会话状态（opencode 格式：{ [sessionID]: SessionStatus }）
    app.get('/status', (c) => {
        const tms = GlobalState.getInstance().taskManagerState;
        const statuses: Record<string, Record<string, unknown>> = {};
        for (const task of tms.tasks) {
            statuses[toExternalId(task.task_id)] = toSessionStatus(task.task_status);
        }
        return c.json(statuses);
    });

    // POST /session - 创建新会话
    app.post('/', async (c) => {
        const body = await c.req.json().catch(() => ({}));
        const tms = GlobalState.getInstance().taskManagerState;
        const task = tms.createTask();

        if (body.title) {
            task.task_name = body.title;
        }

        // 初始化 harness 和 system prompt
        const agentDecl = new MainAgentDecl();
        const modes = agentDecl.supportedModes();
        const defaultMode = modes.find((m) => m.id === agentDecl.defaultModeId()) ?? modes[0];
        let workspace: string;
        try {
            workspace = getPlatform().getEffectiveWorkspace();
        } catch {
            workspace = process.cwd();
        }

        await tms.initHarness(task, workspace, defaultMode);
        const systemPrompt = await agentDecl.createSystemPrompt(defaultMode, task);
        task.setSystemPrompt(systemPrompt);

        EventBus.publish({
            type: 'session.created',
            properties: { sessionID: toExternalId(task.task_id) }
        });

        return c.json(taskToSessionInfo(task));
    });

    // GET /session/:sessionID - 获取会话详情
    app.get('/:sessionID', (c) => {
        const sessionID = c.req.param('sessionID');
        const taskId = toInternalId(sessionID);
        const tms = GlobalState.getInstance().taskManagerState;
        const task = tms.getTask(taskId);

        if (!task) {
            return c.json({ error: 'Session not found' }, 404);
        }

        return c.json(taskToSessionInfo(task));
    });

    // PATCH /session/:sessionID - 更新会话
    app.patch('/:sessionID', async (c) => {
        const sessionID = c.req.param('sessionID');
        const taskId = toInternalId(sessionID);
        const tms = GlobalState.getInstance().taskManagerState;
        const task = tms.getTask(taskId);

        if (!task) {
            return c.json({ error: 'Session not found' }, 404);
        }

        const body = await c.req.json().catch(() => ({}));
        if (body.title !== undefined) {
            task.task_name = body.title;
        }

        tms.save();
        return c.json(taskToSessionInfo(task));
    });

    // DELETE /session/:sessionID - 删除会话
    app.delete('/:sessionID', (c) => {
        const sessionID = c.req.param('sessionID');
        const taskId = toInternalId(sessionID);
        const tms = GlobalState.getInstance().taskManagerState;
        const task = tms.getTask(taskId);

        if (!task) {
            return c.json({ error: 'Session not found' }, 404);
        }

        tms.removeTask(taskId);

        EventBus.publish({
            type: 'session.deleted',
            properties: { sessionID }
        });

        return c.json(true);
    });

    // GET /session/:sessionID/children - 获取子会话
    app.get('/:sessionID/children', (c) => {
        const sessionID = c.req.param('sessionID');
        const taskId = toInternalId(sessionID);
        const tms = GlobalState.getInstance().taskManagerState;

        const children = tms.tasks.filter((t) => t.parent_id === taskId);
        return c.json(children.map(taskToSessionInfo));
    });

    // GET /session/:sessionID/message - 获取会话消息列表
    app.get('/:sessionID/message', (c) => {
        const sessionID = c.req.param('sessionID');
        const taskId = toInternalId(sessionID);
        const tms = GlobalState.getInstance().taskManagerState;
        const task = tms.getTask(taskId);

        if (!task) {
            return c.json({ error: 'Session not found' }, 404);
        }

        const limitStr = c.req.query('limit');
        const before = c.req.query('before');

        const messages = task.chat_context.messages.map((msg, idx) => {
            const m = msg as any;
            return messageToApiFormat(m, idx, sessionID);
        });

        let result = messages;

        if (before) {
            const beforeIdx = messages.findIndex((m) => m.info.id === before);
            if (beforeIdx > 0) {
                result = messages.slice(0, beforeIdx);
            }
        }

        if (limitStr) {
            const limit = parseInt(limitStr, 10);
            if (!isNaN(limit) && limit > 0 && result.length > limit) {
                const cursor = result[result.length - limit].info.id;
                c.header('X-Next-Cursor', cursor);
                c.header('Link', `<${c.req.url}&before=${encodeURIComponent(cursor)}>; rel="next"`);
                result = result.slice(-limit);
            }
        }

        return c.json(result);
    });

    // GET /session/:sessionID/message/:messageID - 获取单条消息
    app.get('/:sessionID/message/:messageID', (c) => {
        const sessionID = c.req.param('sessionID');
        const messageID = c.req.param('messageID');
        const taskId = toInternalId(sessionID);
        const tms = GlobalState.getInstance().taskManagerState;
        const task = tms.getTask(taskId);

        if (!task) {
            return c.json({ error: 'Session not found' }, 404);
        }

        const messages = task.chat_context.messages;
        const msgIndex = messages.findIndex((m: any) => m.message_id === messageID);
        if (msgIndex === -1) {
            return c.json({ error: 'Message not found' }, 404);
        }

        const formatted = messageToApiFormat(messages[msgIndex] as any, msgIndex, sessionID);
        return c.json(formatted);
    });

    // POST /session/:sessionID/message - 发送消息（同步等待响应）
    app.post('/:sessionID/message', async (c) => {
        const sessionID = c.req.param('sessionID');
        const taskId = toInternalId(sessionID);
        const tms = GlobalState.getInstance().taskManagerState;
        const task = tms.getTask(taskId);

        if (!task) {
            return c.json({ error: 'Session not found' }, 404);
        }

        const body = await c.req.json();
        const text = extractTextFromParts(body.parts || body.prompt || body.message);

        if (!text) {
            return c.json({ error: 'No message content' }, 400);
        }

        // 如果正在运行，先等上一轮完成
        if (task.task_status === 'running') {
            await task.waitUntilFinished();
        }

        const userMsgId = body.messageID || ascendingId('msg');
        const assistantMsgId = ascendingId('msg');

        // 发布 session busy 状态
        EventBus.publish({
            type: 'session.status',
            properties: { sessionID, status: { type: 'busy' } }
        });

        // 发布 user message.updated（TUI 需要看到用户消息出现）
        EventBus.publish({
            type: 'message.updated',
            properties: {
                sessionID,
                info: makeUserMessageInfo(userMsgId, sessionID)
            }
        });

        // 发布 user 消息的 text part
        const userPartId = ascendingId('prt');
        EventBus.publish({
            type: 'message.part.updated',
            properties: {
                sessionID,
                part: {
                    id: userPartId,
                    sessionID,
                    messageID: userMsgId,
                    type: 'text',
                    text
                },
                time: Date.now()
            }
        });

        // 发送消息并等待完成
        await task.submitUserMessage(text);
        await task.waitUntilFinished((chunk) => {
            publishChunkEvents(sessionID, chunk, assistantMsgId, userMsgId);
        });

        // 取最后一条 assistant 消息
        const lastMessage = task.chat_context.messages[task.chat_context.messages.length - 1] as any;
        if (lastMessage && lastMessage.role === 'assistant') {
            const formatted = messageToApiFormat(lastMessage, task.chat_context.messages.length - 1, sessionID);
            // 覆盖 id 保持一致
            formatted.info.id = assistantMsgId;
            (formatted.info as any).time = { created: Date.now(), completed: Date.now() };

            // 发布最终 message.updated（带 completed 标记完成）
            EventBus.publish({
                type: 'message.updated',
                properties: {
                    sessionID,
                    info: formatted.info
                }
            });

            // 发布 session idle 状态
            EventBus.publish({
                type: 'session.status',
                properties: { sessionID, status: { type: 'idle' } }
            });

            return c.json(formatted);
        }

        // 发布 session idle 状态
        EventBus.publish({
            type: 'session.status',
            properties: { sessionID, status: { type: 'idle' } }
        });

        return c.json({ info: { id: '', sessionID, role: 'assistant' }, parts: [] });
    });

    // POST /session/:sessionID/prompt_async - 发送消息（异步，立即返回 204）
    app.post('/:sessionID/prompt_async', async (c) => {
        const sessionID = c.req.param('sessionID');
        const taskId = toInternalId(sessionID);
        const tms = GlobalState.getInstance().taskManagerState;
        const task = tms.getTask(taskId);

        if (!task) {
            return c.json({ error: 'Session not found' }, 404);
        }

        const body = await c.req.json();
        const text = extractTextFromParts(body.parts || body.prompt || body.message);

        if (!text) {
            return c.json({ error: 'No message content' }, 400);
        }

        // 异步提交，不等待完成
        if (task.task_status === 'running') {
            await task.waitUntilFinished();
        }

        const userMsgId = body.messageID || ascendingId('msg');
        const assistantMsgId = ascendingId('msg');

        // 发布 session busy 状态
        EventBus.publish({
            type: 'session.status',
            properties: { sessionID, status: { type: 'busy' } }
        });

        // 发布 user message.updated
        EventBus.publish({
            type: 'message.updated',
            properties: {
                sessionID,
                info: makeUserMessageInfo(userMsgId, sessionID)
            }
        });

        // 发布 user 消息的 text part
        const userPartId = ascendingId('prt');
        EventBus.publish({
            type: 'message.part.updated',
            properties: {
                sessionID,
                part: {
                    id: userPartId,
                    sessionID,
                    messageID: userMsgId,
                    type: 'text',
                    text
                },
                time: Date.now()
            }
        });

        task.submitUserMessage(text).then(() => {
            task.waitUntilFinished((chunk) => {
                publishChunkEvents(sessionID, chunk, assistantMsgId, userMsgId);
            }).then(() => {
                // 发布最终 message.updated（带 completed）和 session idle
                const lastMessage = task.chat_context.messages[task.chat_context.messages.length - 1] as any;
                if (lastMessage && lastMessage.role === 'assistant') {
                    const formatted = messageToApiFormat(lastMessage, task.chat_context.messages.length - 1, sessionID);
                    formatted.info.id = assistantMsgId;
                    (formatted.info as any).time = { created: Date.now(), completed: Date.now() };
                    EventBus.publish({
                        type: 'message.updated',
                        properties: { sessionID, info: formatted.info }
                    });
                }
                EventBus.publish({
                    type: 'session.status',
                    properties: { sessionID, status: { type: 'idle' } }
                });
            });
        });

        return c.body(null, 204);
    });

    // POST /session/:sessionID/abort - 中止运行中的会话
    app.post('/:sessionID/abort', (c) => {
        const sessionID = c.req.param('sessionID');
        const taskId = toInternalId(sessionID);
        const tms = GlobalState.getInstance().taskManagerState;
        const task = tms.getTask(taskId);

        if (!task) {
            return c.json({ error: 'Session not found' }, 404);
        }

        task.stop('user');

        EventBus.publish({
            type: 'session.aborted',
            properties: { sessionID }
        });

        return c.json(true);
    });

    // POST /session/:sessionID/fork - Fork 会话
    app.post('/:sessionID/fork', (c) => {
        const sessionID = c.req.param('sessionID');
        const taskId = toInternalId(sessionID);
        const tms = GlobalState.getInstance().taskManagerState;
        const task = tms.getTask(taskId);

        if (!task) {
            return c.json({ error: 'Session not found' }, 404);
        }

        const forked = task.fork();
        return c.json(taskToSessionInfo(forked));
    });

    // GET /session/:sessionID/todo - 获取会话 todo 列表（opencode TUI sync 需要）
    app.get('/:sessionID/todo', (c) => {
        return c.json([]);
    });

    // GET /session/:sessionID/diff - 获取会话 diff 信息（opencode TUI sync 需要）
    app.get('/:sessionID/diff', (c) => {
        return c.json([]);
    });

    // DELETE /session/:sessionID/message/:messageID - 删除消息
    app.delete('/:sessionID/message/:messageID', (c) => {
        const sessionID = c.req.param('sessionID');
        const taskId = toInternalId(sessionID);
        const tms = GlobalState.getInstance().taskManagerState;
        const task = tms.getTask(taskId);

        if (!task) {
            return c.json({ error: 'Session not found' }, 404);
        }

        const messageID = c.req.param('messageID');
        const messages = task.chat_context.messages;
        const idx = messages.findIndex((m: any) => m.message_id === messageID);
        if (idx === -1) {
            return c.json({ error: 'Message not found' }, 404);
        }

        messages.splice(idx, 1);
        tms.save();

        return c.json(true);
    });

    return app;
}

/**
 * 从 opencode 格式的 parts 或字符串中提取文本。
 */
function extractTextFromParts(input: unknown): string | null {
    if (typeof input === 'string') return input;
    if (Array.isArray(input)) {
        const texts: string[] = [];
        for (const part of input) {
            if (typeof part === 'string') {
                texts.push(part);
            } else if (part && typeof part === 'object') {
                if (part.type === 'text' && part.text) {
                    texts.push(part.text);
                }
            }
        }
        return texts.join('\n') || null;
    }
    return null;
}
