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
import type { Context } from 'hono';
import crypto from 'crypto';
import path from 'path';
import { GlobalState } from '../../../aikernel/states/global.js';
import { BaseTaskUpdateSubscriber, type TaskUpdateChunk } from '../../../aikernel/states/tasks.js';
import { MainAgentDecl } from '../../../aikernel/agents/main/agent.js';
import { createAskUserToolset } from '../../../aikernel/interaction/tools.js';
import { EventBus } from '../event-bus.js';
import { modelAliasFromOpenCodeRef } from '../config-compat.js';
import { ensureMcpWorkspace } from '../mcp.js';
import { ServerPermissionBroker } from '../permission-broker.js';
import { ServerQuestionBroker } from '../question-broker.js';
import { Setting } from '../../../utils/setting.js';
import {
    getRequestOrTaskWorkspace,
    getRequestWorkspace,
    getRequestWorkspaceID,
    getTaskWorkspace
} from '../workspace.js';

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

let _ascendingCounter = 0;

const _stableMessageIds = new Map<string, string>();

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getOpenCodeRequestModelRef(body: unknown): unknown {
    if (!isRecord(body)) return undefined;
    if (body.model !== undefined) return body.model;
    if (
        body.providerID !== undefined ||
        body.providerId !== undefined ||
        body.provider !== undefined ||
        body.modelID !== undefined ||
        body.modelId !== undefined
    ) {
        return body;
    }
    return undefined;
}

function stringHeaderValue(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function getIncomingTraceHeader(c: Context): { name: 'x-tracerId' | 'x-trace-id'; value: string } | undefined {
    const tracerId = stringHeaderValue(c.req.header('x-tracerid'));
    if (tracerId) {
        return { name: 'x-tracerId', value: tracerId };
    }
    const traceId = stringHeaderValue(c.req.header('x-trace-id'));
    if (traceId) {
        return { name: 'x-trace-id', value: traceId };
    }
    return undefined;
}

function buildModelRequestOptions(c: Context): { extraHeaders: Record<string, string> } | undefined {
    const cookie = stringHeaderValue(c.req.header('cookie'));
    const traceHeader = getIncomingTraceHeader(c);

    if (!cookie || !traceHeader) {
        return undefined;
    }

    return {
        extraHeaders: {
            cookie: cookie,
            trace_id: traceHeader.value
        }
    };
}

async function submitServerUserMessage(task: any, text: string, c: Context): Promise<void> {
    const modelRequestOptions = buildModelRequestOptions(c);
    if (modelRequestOptions) {
        await task.submitUserMessage(text, undefined, modelRequestOptions);
    } else {
        await task.submitUserMessage(text);
    }
}

function applyOpenCodeRequestModel(task: any, body: unknown): void {
    const modelRef = getOpenCodeRequestModelRef(body);
    if (modelRef === undefined) return;

    const modelAlias = modelAliasFromOpenCodeRef(Setting.getInstance().getData(), modelRef);
    if (modelAlias !== undefined) {
        task.model = modelAlias;
    }
}

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

function getStableMessageId(sourceMessageID: unknown, fallbackKey: string): string {
    const key = typeof sourceMessageID === 'string' && sourceMessageID.length > 0 ? sourceMessageID : fallbackKey;
    let id = _stableMessageIds.get(key);
    if (!id) {
        id = ascendingId('msg');
        _stableMessageIds.set(key, id);
    }
    return id;
}

function getDefaultMainMode(agentDecl: MainAgentDecl) {
    const modes = agentDecl.supportedModes();
    return modes.find((m) => m.id === agentDecl.defaultModeId()) ?? modes[0];
}

async function ensureServerTaskHarness(
    tms: any,
    task: any,
    agentDecl = new MainAgentDecl(),
    workspace = getTaskWorkspace(task)
): Promise<void> {
    const workspaceChanged = task.harnessContext?.workspace !== workspace || task.workspace !== workspace;
    const needsHarness = !task.harnessContext?.permission || workspaceChanged;
    if (needsHarness) {
        await tms.initHarness(task, workspace, getDefaultMainMode(agentDecl));
    }
    task.workspace = workspace;
    task.harnessContext.permissionPrompt = ServerPermissionBroker.getInstance();
    task.interactionToolset = createAskUserToolset(ServerQuestionBroker.getInstance());
    await ensureMcpWorkspace(workspace);

    if (workspaceChanged || !task.chat_context?.system_prompt) {
        const mode = getDefaultMainMode(agentDecl);
        const systemPrompt = await agentDecl.createSystemPrompt(mode, task);
        task.setSystemPrompt(systemPrompt);
    }
    if (typeof task.persistLater === 'function') {
        task.persistLater();
    }
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

function publishSessionStatus(sessionID: string, workspace: string, status: Record<string, unknown>, task?: any): void {
    const parentID = task?.parent_id ? toExternalId(task.parent_id) : undefined;
    EventBus.publish({
        type: 'session.status',
        directory: workspace,
        properties: {
            sessionID,
            status,
            ...(parentID ? { parentID } : {})
        }
    });

    if (status.type === 'idle') {
        EventBus.publish({
            type: 'session.idle',
            directory: workspace,
            properties: {
                sessionID,
                ...(parentID ? { parentID } : {})
            }
        });
    }
}

class ServerTaskUpdateSubscriber extends BaseTaskUpdateSubscriber {
    constructor(private readonly onUpdate: (chunk: TaskUpdateChunk) => void) {
        super();
    }

    send(chunkUpdate: TaskUpdateChunk) {
        this.onUpdate(chunkUpdate);
    }
}

async function waitUntilServerTaskFinished(task: any, callback?: (chunk: TaskUpdateChunk) => void): Promise<void> {
    const activeStatuses = ['running', 'waiting'];
    if (!activeStatuses.includes(task.task_status)) {
        return;
    }

    if (typeof task.addSubscriber !== 'function' || typeof task.removeSubscriber !== 'function') {
        await task.waitUntilFinished(callback);
        return;
    }

    await new Promise<void>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setInterval> | undefined;
        let subscriptionID: string | undefined;

        const settle = () => {
            if (settled) return;
            settled = true;
            if (timer) {
                clearInterval(timer);
            }
            if (subscriptionID) {
                task.removeSubscriber(subscriptionID);
            }
            resolve();
        };

        const subscriber = new ServerTaskUpdateSubscriber((chunk) => {
            callback?.(chunk);
            if (!activeStatuses.includes(chunk.task_status)) {
                settle();
            }
        });
        subscriptionID = task.addSubscriber(subscriber);

        timer = setInterval(() => {
            if (!activeStatuses.includes(task.task_status)) {
                settle();
            }
        }, 250);
    });
}

async function submitServerUserMessageAndWait(
    task: any,
    text: string,
    c: Context,
    callback?: (chunk: TaskUpdateChunk) => void
): Promise<void> {
    const activeStatuses = ['running', 'waiting'];
    if (typeof task.addSubscriber !== 'function' || typeof task.removeSubscriber !== 'function') {
        await submitServerUserMessage(task, text, c);
        await waitUntilServerTaskFinished(task, callback);
        return;
    }

    let settled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let subscriptionID: string | undefined;
    let resolveWait: (() => void) | undefined;
    const waitPromise = new Promise<void>((resolve) => {
        resolveWait = resolve;
    });
    const settle = () => {
        if (settled) return;
        settled = true;
        if (timer) {
            clearInterval(timer);
        }
        if (subscriptionID) {
            task.removeSubscriber(subscriptionID);
        }
        resolveWait?.();
    };

    const subscriber = new ServerTaskUpdateSubscriber((chunk) => {
        callback?.(chunk);
        if (!activeStatuses.includes(chunk.task_status)) {
            settle();
        }
    });
    subscriptionID = task.addSubscriber(subscriber);

    try {
        await submitServerUserMessage(task, text, c);
        if (!activeStatuses.includes(task.task_status)) {
            settle();
        } else {
            timer = setInterval(() => {
                if (!activeStatuses.includes(task.task_status)) {
                    settle();
                }
            }, 250);
        }
        await waitPromise;
    } catch (err) {
        settle();
        throw err;
    }
}

/**
 * 将 OpenDesk task 转换为 opencode Session 格式。
 */
function taskToSessionInfo(task: any, workspace = getTaskWorkspace(task), workspaceID?: string) {
    const sessionId = toExternalId(task.task_id);
    const dir = workspace;
    const dirName = path.basename(dir) || 'unknown';
    const parentID = task.parent_id ? toExternalId(task.parent_id) : undefined;
    const sessionWorkspaceID = workspaceID || task.workspaceID;
    return {
        id: sessionId,
        slug: sessionId.replace('ses_', ''),
        projectID: `proj_${dirName}`,
        ...(sessionWorkspaceID ? { workspaceID: sessionWorkspaceID } : {}),
        directory: dir,
        path: '',
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
    opts: { created?: number; completed?: number; workspace?: string } = {}
): Record<string, unknown> {
    const dir = opts.workspace || getTaskWorkspace(undefined);
    return {
        id: msgId,
        sessionID,
        role: 'assistant',
        time: {
            created: opts.created ?? Date.now(),
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

function makeUserMessageInfo(
    msgId: string,
    sessionID: string,
    workspace = getTaskWorkspace(undefined),
    opts: { created?: number } = {}
): Record<string, unknown> {
    const dir = workspace;
    return {
        id: msgId,
        sessionID,
        role: 'user',
        time: {
            created: opts.created ?? Date.now()
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
    messageID: string = '',
    partID?: string
): Record<string, unknown> {
    if (!part) return { type: 'text', id: ascendingId('prt'), sessionID, messageID, text: '' };
    const p = part as any;
    const partId = partID || p.part_id || ascendingId('prt');
    const base = { id: partId, sessionID, messageID };

    if (p.type === 'text') {
        return { ...base, type: 'text', text: p.text ?? '' };
    }
    if (p.type === 'tool_call') {
        // ToolCallMessagePart has a `toolcalls` array; pick the last one for streaming
        const tc = p.toolcalls?.length > 0 ? p.toolcalls[p.toolcalls.length - 1] : p;
        const callID = tc.id || tc.call_id || partId;
        const toolName = tc.name || tc.tool_name || p.tool_name || '';
        const argsString = tc.args_string ?? tc.arguments ?? '';
        const { input, raw } = parseToolInput(argsString);
        const status = tc.status || p.status;
        const output = stringifyToolOutput(tc.result ?? p.result ?? tc.result_object ?? p.result_object);
        return {
            ...base,
            type: 'tool',
            callID,
            tool: toolName,
            state: mapToolState(status, callID, toolName, input, raw, output)
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
        const errorText = [p.title, p.message]
            .filter((value) => typeof value === 'string' && value.length > 0)
            .join(': ');
        return { ...base, type: 'text', text: `Error: ${errorText || p.error || ''}` };
    }
    return { ...base, type: 'text', text: '' };
}

function tryParseJson(str: string): unknown {
    try {
        return JSON.parse(str);
    } catch {
        return str;
    }
}

function messageToApiFormat(
    msg: any,
    index: number,
    sessionID: string = '',
    workspace = getTaskWorkspace(undefined),
    parentID = ''
) {
    const msgId = getStableMessageId(msg.message_id, `${sessionID}:message:${index}`);
    const parts = (msg.content || msg.parts || []).map((p: any, partIndex: number) =>
        partToMessagePart(p, sessionID, msgId, getStablePartId(msgId, partStableKey(p, partIndex)))
    );
    const dir = workspace;

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
                parentID,
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

function getParentUserMessageIdForIndex(messages: any[], assistantIndex: number, sessionID: string): string {
    for (let i = assistantIndex - 1; i >= 0; i--) {
        const message = messages[i] as any;
        if (message?.role === 'user') {
            return getStableMessageId(message.message_id, `${sessionID}:message:${i}`);
        }
    }
    return '';
}

/**
 * 跟踪每个消息中各 part 类型的稳定 ID，确保流式更新中 ID 不变。
 * key: `${messageID}:${partType}:${partIndex}` → partId
 */
const _stablePartIds = new Map<string, string>();
const _partTextSnapshots = new Map<string, string>();
const _toolPartTimes = new Map<string, { start: number; end?: number }>();

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

function partTextSnapshotKey(part: Record<string, unknown>, field: string): string {
    return `${part.messageID}:${part.id}:${field}`;
}

function getTextDeltaField(part: Record<string, unknown>): { field: string; text: string } | undefined {
    if (part.type !== 'text' && part.type !== 'reasoning') return undefined;
    if (typeof part.text !== 'string') return undefined;
    return { field: 'text', text: part.text };
}

function rememberPartTextSnapshot(part: Record<string, unknown>): void {
    const deltaField = getTextDeltaField(part);
    if (!deltaField) return;
    _partTextSnapshots.set(partTextSnapshotKey(part, deltaField.field), deltaField.text);
}

function publishMessagePartUpdated(
    sessionID: string,
    workspace: string,
    part: Record<string, unknown>,
    time = Date.now()
): void {
    EventBus.publish({
        type: 'message.part.updated',
        directory: workspace,
        properties: {
            sessionID,
            part,
            time
        }
    });
    rememberPartTextSnapshot(part);
}

function publishMessagePartDelta(
    sessionID: string,
    workspace: string,
    messageID: string,
    partID: string,
    field: string,
    delta: string
): void {
    EventBus.publish({
        type: 'message.part.delta',
        directory: workspace,
        properties: {
            sessionID,
            messageID,
            partID,
            field,
            delta
        }
    });
}

function publishStreamingMessagePart(sessionID: string, workspace: string, part: Record<string, unknown>): void {
    const deltaField = getTextDeltaField(part);
    const messageID = typeof part.messageID === 'string' ? part.messageID : undefined;
    const partID = typeof part.id === 'string' ? part.id : undefined;
    if (!deltaField || !messageID || !partID) {
        publishMessagePartUpdated(sessionID, workspace, part);
        return;
    }

    const key = partTextSnapshotKey(part, deltaField.field);
    const previous = _partTextSnapshots.get(key);
    if (previous === undefined) {
        publishMessagePartUpdated(sessionID, workspace, part);
        return;
    }

    if (deltaField.text === previous) {
        return;
    }

    if (deltaField.text.startsWith(previous)) {
        publishMessagePartDelta(
            sessionID,
            workspace,
            messageID,
            partID,
            deltaField.field,
            deltaField.text.slice(previous.length)
        );
        _partTextSnapshots.set(key, deltaField.text);
        return;
    }

    publishMessagePartUpdated(sessionID, workspace, part);
}

function partStableKey(part: UserMessagePart | AssistantMessagePart, partIndex: number): string {
    const p = part as any;
    if (p?.type === 'tool_call') {
        const tc = p.toolcalls?.length > 0 ? p.toolcalls[p.toolcalls.length - 1] : p;
        const callID = tc?.id || tc?.call_id;
        return `tool:${callID || partIndex}`;
    }
    return `${p?.type || 'text'}:${partIndex}`;
}

function parseToolInput(argsString: unknown): { input: Record<string, unknown>; raw: string } {
    const raw = typeof argsString === 'string' ? argsString : '';
    if (raw.trim().length === 0) {
        return { input: {}, raw };
    }

    const parsed = tryParseJson(raw);
    return { input: isRecord(parsed) ? parsed : {}, raw };
}

function stringifyToolOutput(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === undefined || value === null) return '';
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function toolTitle(toolName: string, input: Record<string, unknown>): string {
    for (const key of ['description', 'filePath', 'file_path', 'path', 'pattern', 'command', 'name', 'query']) {
        const value = input[key];
        if (typeof value === 'string' && value.trim().length > 0) {
            return value;
        }
    }
    return toolName;
}

function toolTiming(callID: string, completed: boolean): { start: number; end?: number } {
    let timing = _toolPartTimes.get(callID);
    if (!timing) {
        timing = { start: Date.now() };
        _toolPartTimes.set(callID, timing);
    }
    if (completed && timing.end === undefined) {
        timing.end = Date.now();
    }
    return timing;
}

function mapToolState(
    status: string | undefined,
    callID: string,
    toolName: string,
    input: Record<string, unknown>,
    rawInput: string,
    output: string
): Record<string, unknown> {
    if (status === 'pending') {
        return {
            status: 'pending',
            input,
            raw: rawInput
        };
    }

    const title = toolTitle(toolName, input);
    if (status === 'running') {
        const timing = toolTiming(callID, false);
        return {
            status: 'running',
            input,
            title,
            metadata: {},
            time: { start: timing.start }
        };
    }

    const timing = toolTiming(callID, true);
    if (status === 'error' || status === 'failed') {
        return {
            status: 'error',
            input,
            error: output,
            metadata: {},
            time: { start: timing.start, end: timing.end ?? timing.start }
        };
    }

    return {
        status: 'completed',
        input,
        output,
        title,
        metadata: {},
        time: { start: timing.start, end: timing.end ?? timing.start }
    };
}

/**
 * 将 TaskUpdateChunk 转换为 opencode SSE 事件并发布到 EventBus。
 * 用于实时流式更新 TUI 界面。
 *
 * 使用稳定的 part ID，这样 TUI 的 binary search 能正确匹配并更新已有 part，
 * 而不是不断创建新的 part 条目。
 */
function publishChunkEvents(
    sessionID: string,
    chunk: TaskUpdateChunk,
    parentUserMsgId: string,
    workspace = getTaskWorkspace(undefined)
): string | undefined {
    if (chunk.type === 'retry') {
        if (chunk.status === 'cleared') {
            publishSessionStatus(sessionID, workspace, toSessionStatus(chunk.task_status));
        } else {
            publishSessionStatus(sessionID, workspace, {
                type: 'retry',
                attempt: chunk.attempt,
                message: chunk.error_message,
                next: chunk.next_retry_at
            });
        }
        return undefined;
    }

    if (chunk.type === 'user') {
        const userMsgId = getStableMessageId(chunk.message_id, `${sessionID}:chunk:user`);
        EventBus.publish({
            type: 'message.updated',
            directory: workspace,
            properties: {
                sessionID,
                info: makeUserMessageInfo(userMsgId, sessionID, workspace, { created: chunk.timestamp })
            }
        });

        const part = partToMessagePart(
            chunk.last_part,
            sessionID,
            userMsgId,
            getStablePartId(userMsgId, partStableKey(chunk.last_part, chunk.last_part_index))
        );
        publishMessagePartUpdated(sessionID, workspace, part);
        return userMsgId;
    }

    if (chunk.type === 'user_replace') {
        const userMsgId = getStableMessageId(chunk.message_id, `${sessionID}:chunk:user`);
        EventBus.publish({
            type: 'message.updated',
            directory: workspace,
            properties: {
                sessionID,
                info: makeUserMessageInfo(userMsgId, sessionID, workspace, { created: chunk.timestamp })
            }
        });

        for (let i = 0; i < chunk.parts.length; i++) {
            const part = partToMessagePart(
                chunk.parts[i],
                sessionID,
                userMsgId,
                getStablePartId(userMsgId, partStableKey(chunk.parts[i], i))
            );
            publishMessagePartUpdated(sessionID, workspace, part);
        }
        return userMsgId;
    }

    if (chunk.type === 'assistant') {
        const assistantMsgId = getStableMessageId(chunk.message_id, `${sessionID}:chunk:assistant`);
        const lastPart = chunk.last_part as any;
        if (!lastPart) return;

        const stablePartId = getStablePartId(assistantMsgId, partStableKey(lastPart, chunk.last_part_index));
        const part = partToMessagePart(lastPart, sessionID, assistantMsgId);
        // 覆盖为稳定 ID
        (part as any).id = stablePartId;

        // 发布 message.updated 事件（无 completed 表示仍在生成中）
        EventBus.publish({
            type: 'message.updated',
            directory: workspace,
            properties: {
                sessionID,
                info: makeAssistantMessageInfo(assistantMsgId, sessionID, parentUserMsgId, { workspace })
            }
        });
        publishStreamingMessagePart(sessionID, workspace, part);
        ServerPermissionBroker.getInstance().setActiveAssistantMessage(chunk.task_id, assistantMsgId);
        return undefined;
    }

    if (chunk.type === 'assistant_replace') {
        const assistantMsgId = getStableMessageId(chunk.message_id, `${sessionID}:chunk:assistant`);
        EventBus.publish({
            type: 'message.updated',
            directory: workspace,
            properties: {
                sessionID,
                info: makeAssistantMessageInfo(assistantMsgId, sessionID, parentUserMsgId, { workspace })
            }
        });

        for (let i = 0; i < chunk.parts.length; i++) {
            const part = partToMessagePart(
                chunk.parts[i],
                sessionID,
                assistantMsgId,
                getStablePartId(assistantMsgId, partStableKey(chunk.parts[i], i))
            );
            publishMessagePartUpdated(sessionID, workspace, part);
        }
        ServerPermissionBroker.getInstance().setActiveAssistantMessage(chunk.task_id, assistantMsgId);
    }
    return undefined;
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
        const workspaceID = getRequestWorkspaceID(c);

        const directory = getRequestWorkspace(c);
        let tasks = rootsOnly ? tms.tasks.filter((t) => !t.parent_id) : tms.tasks;
        if (c.req.query('scope') !== 'project') {
            tasks = tasks.filter((t) => getTaskWorkspace(t) === directory);
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

        return c.json(tasks.map((task) => taskToSessionInfo(task, getTaskWorkspace(task), workspaceID)));
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
        const workspace = getRequestWorkspace(c);
        const workspaceID = getRequestWorkspaceID(c) || body.workspaceID;
        const tms = GlobalState.getInstance().taskManagerState;
        const task = tms.createTask();
        task.workspaceID = workspaceID;

        if (body.title) {
            task.task_name = body.title;
        }
        applyOpenCodeRequestModel(task, body);

        // 初始化 harness 和 system prompt
        const agentDecl = new MainAgentDecl();
        await ensureServerTaskHarness(tms, task, agentDecl, workspace);

        EventBus.publish({
            type: 'session.created',
            directory: workspace,
            properties: { sessionID: toExternalId(task.task_id) }
        });

        return c.json(taskToSessionInfo(task, workspace, workspaceID));
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

        return c.json(taskToSessionInfo(task, getRequestOrTaskWorkspace(c, task), getRequestWorkspaceID(c)));
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
        applyOpenCodeRequestModel(task, body);

        tms.save();
        return c.json(taskToSessionInfo(task, getRequestOrTaskWorkspace(c, task), getRequestWorkspaceID(c)));
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
            directory: getTaskWorkspace(task),
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
        return c.json(
            children.map((task) => taskToSessionInfo(task, getTaskWorkspace(task), getRequestWorkspaceID(c)))
        );
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
        const workspace = getRequestOrTaskWorkspace(c, task);

        let parentUserMessageID = '';
        const messages = task.chat_context.messages.map((msg, idx) => {
            const m = msg as any;
            if (m.role === 'user') {
                const formatted = messageToApiFormat(m, idx, sessionID, workspace);
                parentUserMessageID = formatted.info.id as string;
                return formatted;
            }
            return messageToApiFormat(m, idx, sessionID, workspace, parentUserMessageID);
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
        const msgIndex = messages.findIndex((m: any, idx: number) => {
            return (
                m.message_id === messageID ||
                getStableMessageId(m.message_id, `${sessionID}:message:${idx}`) === messageID
            );
        });
        if (msgIndex === -1) {
            return c.json({ error: 'Message not found' }, 404);
        }

        let parentUserMessageID = '';
        for (let i = 0; i < msgIndex; i++) {
            const m = messages[i] as any;
            if (m.role === 'user') {
                parentUserMessageID = getStableMessageId(m.message_id, `${sessionID}:message:${i}`);
            }
        }
        const target = messages[msgIndex] as any;
        const parentID = target.role === 'assistant' ? parentUserMessageID : '';
        const formatted = messageToApiFormat(target, msgIndex, sessionID, getRequestOrTaskWorkspace(c, task), parentID);
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

        const workspace = getRequestOrTaskWorkspace(c, task);
        await ensureServerTaskHarness(tms, task, new MainAgentDecl(), workspace);

        if (task.task_status === 'running') {
            await waitUntilServerTaskFinished(task);
        }
        applyOpenCodeRequestModel(task, body);

        // 发布 session busy 状态
        publishSessionStatus(sessionID, workspace, { type: 'busy' }, task);

        try {
            // 发送消息并等待完成
            let parentUserMsgId = '';
            await submitServerUserMessageAndWait(task, text, c, (chunk) => {
                const publishedUserMsgId = publishChunkEvents(sessionID, chunk, parentUserMsgId, workspace);
                if (publishedUserMsgId) {
                    parentUserMsgId = publishedUserMsgId;
                }
            });

            // 取最后一条 assistant 消息
            const lastMessageIndex = task.chat_context.messages.length - 1;
            const lastMessage = task.chat_context.messages[lastMessageIndex] as any;
            if (lastMessage && lastMessage.role === 'assistant') {
                const resolvedParentUserMsgId =
                    parentUserMsgId ||
                    getParentUserMessageIdForIndex(task.chat_context.messages as any[], lastMessageIndex, sessionID);
                const formatted = messageToApiFormat(
                    lastMessage,
                    lastMessageIndex,
                    sessionID,
                    workspace,
                    resolvedParentUserMsgId
                );
                (formatted.info as any).time = {
                    ...((formatted.info as any).time ?? {}),
                    completed: Date.now()
                };

                // 发布最终 message.updated（带 completed 标记完成）
                EventBus.publish({
                    type: 'message.updated',
                    directory: workspace,
                    properties: {
                        sessionID,
                        info: formatted.info
                    }
                });

                return c.json(formatted);
            }

            return c.json({ info: { id: '', sessionID, role: 'assistant' }, parts: [] });
        } catch (err) {
            EventBus.publish({
                type: 'session.error',
                directory: workspace,
                properties: {
                    sessionID,
                    error: err instanceof Error ? err.message : String(err)
                }
            });
            throw err;
        } finally {
            // 发布 session idle 状态
            publishSessionStatus(sessionID, workspace, { type: 'idle' }, task);
        }
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
        const workspace = getRequestOrTaskWorkspace(c, task);
        await ensureServerTaskHarness(tms, task, new MainAgentDecl(), workspace);

        if (task.task_status === 'running') {
            await waitUntilServerTaskFinished(task);
        }
        applyOpenCodeRequestModel(task, body);

        // 发布 session busy 状态
        publishSessionStatus(sessionID, workspace, { type: 'busy' }, task);

        void (async () => {
            try {
                let parentUserMsgId = '';
                await submitServerUserMessageAndWait(task, text, c, (chunk) => {
                    const publishedUserMsgId = publishChunkEvents(sessionID, chunk, parentUserMsgId, workspace);
                    if (publishedUserMsgId) {
                        parentUserMsgId = publishedUserMsgId;
                    }
                });
                // 发布最终 message.updated（带 completed）和 session idle
                const lastMessageIndex = task.chat_context.messages.length - 1;
                const lastMessage = task.chat_context.messages[lastMessageIndex] as any;
                if (lastMessage && lastMessage.role === 'assistant') {
                    const resolvedParentUserMsgId =
                        parentUserMsgId ||
                        getParentUserMessageIdForIndex(
                            task.chat_context.messages as any[],
                            lastMessageIndex,
                            sessionID
                        );
                    const formatted = messageToApiFormat(
                        lastMessage,
                        lastMessageIndex,
                        sessionID,
                        workspace,
                        resolvedParentUserMsgId
                    );
                    (formatted.info as any).time = {
                        ...((formatted.info as any).time ?? {}),
                        completed: Date.now()
                    };
                    EventBus.publish({
                        type: 'message.updated',
                        directory: workspace,
                        properties: { sessionID, info: formatted.info }
                    });
                }
            } catch (err) {
                EventBus.publish({
                    type: 'session.error',
                    directory: workspace,
                    properties: {
                        sessionID,
                        error: err instanceof Error ? err.message : String(err)
                    }
                });
            } finally {
                publishSessionStatus(sessionID, workspace, { type: 'idle' }, task);
            }
        })();

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
            directory: getTaskWorkspace(task),
            properties: { sessionID }
        });
        publishSessionStatus(sessionID, getTaskWorkspace(task), { type: 'idle' }, task);

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
        return c.json(taskToSessionInfo(forked, getTaskWorkspace(forked), getRequestWorkspaceID(c)));
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
