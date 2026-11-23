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
import type { UserMessage } from '@opencode-ai/sdk/v2/types';
import crypto from 'crypto';
import path from 'path';
import { BlockList, isIP } from 'node:net';
import { GlobalState } from '../../../aikernel/states/global.js';
import { BaseTaskUpdateSubscriber, type TaskUpdateChunk } from '../../../aikernel/states/tasks.js';
import { BaseTaskManagerUpdateSubscriber } from '../../../aikernel/task/manager.js';
import { createAskUserToolset } from '../../../aikernel/interaction/tools.js';
import { EventBus } from '../event-bus.js';
import { modelAliasFromOpenCodeRef } from '../config-compat.js';
import { ensureMcpWorkspace } from '../mcp.js';
import { ServerPermissionBroker } from '../permission-broker.js';
import { ServerQuestionBroker } from '../question-broker.js';
import { Setting } from '../../../utils/setting.js';
import { resolveToolResultReplacement } from '../../../aikernel/tool-result-content.js';
import iconv from 'iconv-lite';
import {
    isCompactBoundaryMessage,
    type CompactSeparatorMessage,
    type UserMessagePart,
    type AssistantMessagePart
} from '../../../aikernel/messages.js';
import {
    getRequestOrTaskWorkspace,
    getRequestWorkspace,
    getRequestWorkspaceID,
    getTaskWorkspace
} from '../workspace.js';
import { getOpenCodeSessionTime } from '../session-info.js';
import { getOpenCodeSessionDiff, getTurnMessages, toOpenCodeTodos } from '../session-artifacts.js';
import { getTaskTodosForDisplay } from '../../../aikernel/todos/task-todos.js';
import type { ConfigPermissionRuntime } from '../config-permission-runtime.js';
import type { TaskTurnInstrumentationExternalContext } from '../../../telemetry/agent-execution.js';

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

function firstString(...values: unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value !== 'string') continue;
        const trimmed = value.trim();
        if (trimmed.length > 0) {
            return trimmed;
        }
    }
    return undefined;
}

function getProviderIDFromModelRef(modelRef: unknown): string | undefined {
    if (isRecord(modelRef)) {
        const providerID = firstString(modelRef.providerID, modelRef.providerId, modelRef.provider);
        if (providerID) {
            return providerID;
        }

        const id = firstString(modelRef.id, modelRef.model);
        if (id?.includes('/')) {
            return id.split('/')[0];
        }
        return undefined;
    }

    if (typeof modelRef === 'string') {
        const trimmed = modelRef.trim();
        if (trimmed.includes('/')) {
            return trimmed.split('/')[0];
        }
    }
    return undefined;
}

function getModelIDFromModelRef(modelRef: unknown): string | undefined {
    if (isRecord(modelRef)) {
        const modelID = firstString(modelRef.modelID, modelRef.modelId, modelRef.model);
        if (modelID && !modelID.includes('/')) {
            return modelID;
        }

        const id = firstString(modelRef.id, modelID);
        if (id?.includes('/')) {
            return id.split('/').slice(1).join('/');
        }
        return modelID;
    }

    if (typeof modelRef === 'string') {
        const trimmed = modelRef.trim();
        if (trimmed.includes('/')) {
            return trimmed.split('/').slice(1).join('/');
        }
        return trimmed.length > 0 ? trimmed : undefined;
    }
    return undefined;
}

interface OpenCodeModelInfo {
    providerID: string;
    modelID: string;
}

const EMPTY_OPEN_CODE_MODEL_INFO: OpenCodeModelInfo = {
    providerID: '',
    modelID: ''
};

const internalModelAddresses = new BlockList();
internalModelAddresses.addSubnet('10.0.0.0', 8);
internalModelAddresses.addSubnet('172.16.0.0', 12);
internalModelAddresses.addSubnet('192.168.0.0', 16);
internalModelAddresses.addSubnet('127.0.0.0', 8);
internalModelAddresses.addSubnet('169.254.0.0', 16);
internalModelAddresses.addSubnet('100.64.0.0', 10);
internalModelAddresses.addAddress('::1', 'ipv6');
internalModelAddresses.addSubnet('fe80::', 10, 'ipv6');
internalModelAddresses.addSubnet('fc00::', 7, 'ipv6');

export function isExternalModel(providerID: string, modelID: string, baseUrl?: string): boolean {
    if ((providerID === 'myagent' && modelID.includes('外部')) || providerID.includes('replacemodelmyagent')) {
        return true;
    }

    let hostname: string;
    try {
        const url = new URL(baseUrl ?? '');
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
        hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    } catch {
        return false;
    }

    if (hostname.startsWith('[') && hostname.endsWith(']')) {
        hostname = hostname.slice(1, -1);
    }
    const ipVersion = isIP(hostname);
    if (ipVersion !== 0) {
        return !internalModelAddresses.check(hostname, ipVersion === 4 ? 'ipv4' : 'ipv6');
    }

    return !(hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.includes('.huawei.com'));
}

function getOpenCodeModelInfo(task: any, requestModelRef?: unknown): OpenCodeModelInfo {
    const setting = Setting.getInstance() as any;
    const modelAlias = typeof task?.model === 'string' && task.model.length > 0 ? task.model : undefined;
    let modelInstance: any;
    try {
        if (modelAlias && typeof setting.getModelInstance === 'function') {
            modelInstance = setting.getModelInstance(modelAlias, 'chat');
        } else if (!modelAlias && typeof setting.getDefaultModelInstance === 'function') {
            modelInstance = setting.getDefaultModelInstance();
        }
    } catch {
        modelInstance = undefined;
    }
    const data = typeof setting.getData === 'function' ? setting.getData() : setting.data;
    const resolvedAlias = modelAlias ?? firstString(data?.default_model);
    const configuredModel = Array.isArray(data?.models)
        ? data.models.find((model: any) => model?.alias === resolvedAlias)
        : undefined;
    const providerID =
        firstString(modelInstance?.getProviderName?.(), modelInstance?.provider_name, configuredModel?.provider_name) ??
        getProviderIDFromModelRef(requestModelRef) ??
        '';
    const modelID =
        firstString(modelInstance?.model_name, configuredModel?.model_name) ??
        getModelIDFromModelRef(requestModelRef) ??
        resolvedAlias ??
        '';
    return { providerID, modelID };
}

function buildOpenCodeTelemetryMetadata(
    sessionID: string,
    route: string,
    body: unknown,
    modelInfo: OpenCodeModelInfo,
    model: unknown
): Record<string, unknown> {
    const requestModel = getOpenCodeRequestModelRef(body);
    return {
        sessionID,
        route,
        model,
        providerID: modelInfo.providerID,
        modelID: modelInfo.modelID,
        recordGenerations: modelInfo.providerID !== 'myagent',
        ...(requestModel !== undefined ? { requestModel } : {})
    };
}

function buildOpenCodeTelemetryInput(
    body: Record<string, unknown>,
    modelInfo: OpenCodeModelInfo
): Record<string, unknown> {
    const provider = Setting.getInstance()
        .getData()
        .providers.find((candidate) => candidate.name === modelInfo.providerID);
    return {
        ...body,
        modelLake: {
            modelName: modelInfo.modelID,
            providerSource: modelInfo.providerID === 'myagent' ? '体验模型' : '用户模型',
            isExternal: isExternalModel(modelInfo.providerID, modelInfo.modelID, provider?.base_url)
        }
    };
}

function buildOpenCodeTelemetryOutput(
    task: any,
    sessionID: string
): NonNullable<TaskTurnInstrumentationExternalContext['output']> {
    const agentId = typeof task.agentId === 'string' && task.agentId.length > 0 ? task.agentId : undefined;
    return {
        sessionID,
        event: 'done',
        ...(agentId
            ? {
                  mode: task.getAgentMode().id,
                  agent: agentId
              }
            : {}),
        cost: 0
    };
}

function numericToken(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function usageToOpenCodeTokens(usage: unknown): Record<string, unknown> {
    const data = isRecord(usage) ? usage : {};
    return {
        input: numericToken(data.prompt_tokens ?? data.input_tokens ?? data.inputTokens),
        output: numericToken(data.completion_tokens ?? data.output_tokens ?? data.outputTokens),
        reasoning: numericToken(data.reasoning_tokens ?? data.reasoningTokens),
        cache: {
            read: numericToken(data.cache_read_input_tokens ?? data.cacheReadInputTokens),
            write: numericToken(data.cache_creation_input_tokens ?? data.cacheCreationInputTokens)
        }
    };
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
    const extraHeaders: Record<string, string> = {};

    if (cookie) {
        extraHeaders.cookie = iconv.encode(cookie, 'latin1').toString('latin1');
    }
    if (traceHeader) {
        extraHeaders.trace_id = iconv.encode(traceHeader.value, 'latin1').toString('latin1');
    }

    return Object.keys(extraHeaders).length > 0 ? { extraHeaders } : undefined;
}

async function submitServerUserMessage(
    task: any,
    text: string,
    c: Context,
    telemetryContext?: TaskTurnInstrumentationExternalContext
): Promise<void> {
    const modelRequestOptions = buildModelRequestOptions(c);
    await task.submitUserMessage(text, {
        interactive: true,
        modelRequestOptions,
        instrumentationContext: {
            traceId: getIncomingTraceHeader(c)?.value,
            ...telemetryContext
        }
    });
}

function applyOpenCodeRequestModel(task: any, body: unknown): void {
    const modelRef = getOpenCodeRequestModelRef(body);
    if (modelRef === undefined) return;

    const modelAlias = modelAliasFromOpenCodeRef(Setting.getInstance().getData(), modelRef);
    if (modelAlias !== undefined) {
        task.model = modelAlias;
        if (Setting.getInstance().getModelInstance(modelAlias, 'chat')) {
            setServerDefaultModel(modelAlias);
        }
    }
}

function resolveConfiguredOpenCodeModelAlias(providerID: string, modelID: string): string | undefined {
    const data = Setting.getInstance().getData();
    const provider = data.providers.find((candidate) => candidate.name === providerID);
    if (!provider || provider.enabled === false) {
        return undefined;
    }

    const model = data.models.find(
        (candidate) =>
            candidate.provider_name === providerID &&
            candidate.model_type !== 'embedding' &&
            (candidate.alias === modelID || candidate.model_name === modelID)
    );
    return model?.alias;
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

async function ensureServerTaskHarness(
    tms: any,
    task: any,
    workspace = getTaskWorkspace(task),
    permissionRuntime?: ConfigPermissionRuntime
): Promise<void> {
    const previousAgentId = task.agentId;
    task.getAgent();
    const agentChanged = task.agentId !== previousAgentId;
    const persistedWorkspaceChanged = task.workspace !== workspace;
    const workspaceChanged = task.harnessContext?.workspace !== workspace || task.workspace !== workspace;
    const needsHarness = !task.harnessContext?.permission || workspaceChanged;
    if (needsHarness) {
        await tms.initHarness(task, workspace, task.getAgentMode());
    }
    task.workspace = workspace;
    permissionRuntime?.wrapTask(task);
    task.harnessContext.permissionPrompt = ServerPermissionBroker.getInstance();
    task.interactionToolset = createAskUserToolset(ServerQuestionBroker.getInstance());
    registerServerSubTaskLifecycle(task, permissionRuntime);
    await ensureMcpWorkspace(workspace);

    if (workspaceChanged) {
        await task.refreshToolsets?.();
    }

    if (agentChanged || workspaceChanged || !task.chat_context?.system_prompt) {
        await task.rebuildSystemPrompt();
    }
    if (persistedWorkspaceChanged && typeof task.persistLater === 'function') {
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

/** opencode NotFoundError 结构的 404 响应 */
function sessionNotFound(c: Context, sessionID: string) {
    return c.json({ name: 'NotFoundError' as const, data: { message: `Session not found: ${sessionID}` } }, 404);
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
        publishSessionDiff(sessionID, workspace, task);
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

/** 一轮结束时推送会话的文件变更，客户端据此刷新变更列表 */
function publishSessionDiff(sessionID: string, workspace: string, task?: any): void {
    const diffTask = task ?? GlobalState.getInstance().taskManagerState.getTask(toInternalId(sessionID));
    if (!diffTask?.chat_context) return;
    try {
        EventBus.publish({
            type: 'session.diff',
            directory: workspace,
            properties: { sessionID, diff: getOpenCodeSessionDiff(diffTask) }
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[server] failed to compute session diff for ${sessionID}: ${message}`);
    }
}

/** 上次推送给客户端的待办列表（按 sessionID），只在内容变化时发送 todo.updated */
const _publishedTodos = new Map<string, string>();

function publishTodosIfChanged(sessionID: string, workspace: string): void {
    const todos = toOpenCodeTodos(getTaskTodosForDisplay(toInternalId(sessionID)));
    const snapshot = JSON.stringify(todos);
    if ((_publishedTodos.get(sessionID) ?? '[]') === snapshot) return;
    _publishedTodos.set(sessionID, snapshot);
    EventBus.publish({ type: 'todo.updated', directory: workspace, properties: { sessionID, todos } });
}

class ServerTaskUpdateSubscriber extends BaseTaskUpdateSubscriber {
    constructor(private readonly onUpdate: (chunk: TaskUpdateChunk) => void) {
        super();
    }

    send(chunkUpdate: TaskUpdateChunk) {
        this.onUpdate(chunkUpdate);
    }
}

/**
 * 将 OpenDesk 内部的任务名称变化桥接为 opencode 协议的 session.updated 事件。
 * 所有改名路径（LLM 自动命名、rename、关闭自动命名时的截断命名、任务导入等）
 * 都会触发 publishTaskListUpdate，订阅该汇聚点并对比名称快照，即可不遗漏地感知变化。
 */
class TaskNameSyncSubscriber extends BaseTaskManagerUpdateSubscriber {
    private lastNameByTaskId = new Map<string, string | null>();

    send(taskList: object[]): void {
        const seen = new Set<string>();
        for (const entry of taskList as Array<{ task_id?: string; task_name?: string | null }>) {
            if (typeof entry?.task_id !== 'string') continue;
            seen.add(entry.task_id);
            const lastName = this.lastNameByTaskId.get(entry.task_id);
            const newName = entry.task_name ?? null;
            this.lastNameByTaskId.set(entry.task_id, newName);
            // lastName === undefined 表示首次观察到该任务（baseline），只记录不发事件
            if (lastName !== undefined && lastName !== newName) {
                this.publishSessionNameUpdated(entry.task_id);
            }
        }
        for (const taskId of [...this.lastNameByTaskId.keys()]) {
            if (!seen.has(taskId)) {
                this.lastNameByTaskId.delete(taskId);
            }
        }
    }

    private publishSessionNameUpdated(taskId: string): void {
        const task = GlobalState.getInstance().taskManagerState.getTask(taskId);
        if (!task) return;
        const workspace = getTaskWorkspace(task);
        EventBus.publish({
            type: 'session.updated',
            directory: workspace,
            properties: {
                sessionID: toExternalId(task.task_id),
                info: taskToSessionInfo(task, workspace, task.workspaceID)
            }
        });
    }
}

let taskNameSyncSubscriptionId: string | undefined;

export function registerTaskNameSyncSubscriber(): void {
    if (taskNameSyncSubscriptionId !== undefined) return;
    const tms = GlobalState.getInstance().taskManagerState;
    taskNameSyncSubscriptionId = tms.addSubscriber(new TaskNameSyncSubscriber());
}

export function disposeTaskNameSyncSubscriber(): void {
    if (taskNameSyncSubscriptionId === undefined) return;
    GlobalState.getInstance().taskManagerState.removeSubscriber(taskNameSyncSubscriptionId);
    taskNameSyncSubscriptionId = undefined;
}

const _serverSubTaskLifecycleParents = new WeakSet<object>();
const _serverSubTaskLifecycleChildren = new WeakSet<object>();

function getLastAssistantError(task: any): string | undefined {
    const lastMessage = task.chat_context?.lastMessage?.();
    if (!lastMessage || lastMessage.role !== 'assistant' || !Array.isArray(lastMessage.content)) {
        return undefined;
    }
    const errorPart = lastMessage.content.find((part: any) => part?.type === 'error');
    if (!errorPart) return undefined;
    return [errorPart.title, errorPart.message]
        .filter((value) => typeof value === 'string' && value.length > 0)
        .join(': ');
}

function publishCompletedChildMessage(
    task: any,
    sessionID: string,
    workspace: string,
    parentUserMessageID: string,
    modelInfo: OpenCodeModelInfo
): void {
    const lastMessageIndex = task.chat_context.messages.length - 1;
    const lastMessage = task.chat_context.messages[lastMessageIndex] as any;
    if (!lastMessage || lastMessage.role !== 'assistant') return;

    const resolvedParentUserMessageID =
        parentUserMessageID ||
        getParentUserMessageIdForIndex(task.chat_context.messages as any[], lastMessageIndex, sessionID);
    const formatted = messageToApiFormat(
        lastMessage,
        lastMessageIndex,
        sessionID,
        workspace,
        resolvedParentUserMessageID,
        { modelInfo }
    );
    (formatted.info as any).time = {
        ...((formatted.info as any).time ?? {}),
        completed: task.finished_at?.getTime?.() ?? Date.now()
    };
    publishCompletedAssistantMessage(sessionID, workspace, formatted);
}

function attachServerChildSession(child: any, permissionRuntime?: ConfigPermissionRuntime): void {
    if (_serverSubTaskLifecycleChildren.has(child)) return;
    _serverSubTaskLifecycleChildren.add(child);
    permissionRuntime?.wrapTask(child);
    registerServerSubTaskLifecycle(child, permissionRuntime);
    child.harnessContext.permissionPrompt = ServerPermissionBroker.getInstance();

    const sessionID = toExternalId(child.task_id);
    const workspace = getTaskWorkspace(child);
    const modelInfo = getOpenCodeModelInfo(child);
    EventBus.publish({
        type: 'session.created',
        directory: workspace,
        properties: {
            sessionID,
            info: taskToSessionInfo(child, workspace, child.workspaceID)
        }
    });
    publishSessionStatus(sessionID, workspace, { type: 'busy' }, child);

    let parentUserMessageID = '';
    let finalized = false;
    let subscriptionID: string | undefined;
    const finalize = () => {
        if (finalized) return;
        finalized = true;
        if (subscriptionID) {
            child.removeSubscriber(subscriptionID);
        }
        publishCompletedChildMessage(child, sessionID, workspace, parentUserMessageID, modelInfo);
        const error = getLastAssistantError(child);
        if (error) {
            EventBus.publish({
                type: 'session.error',
                directory: workspace,
                properties: { sessionID, error }
            });
        }
        EventBus.publish({
            type: 'session.updated',
            directory: workspace,
            properties: {
                sessionID,
                info: taskToSessionInfo(child, workspace, child.workspaceID)
            }
        });
        publishSessionStatus(sessionID, workspace, { type: 'idle' }, child);
    };

    const subscriber = new ServerTaskUpdateSubscriber((chunk) => {
        const publishedUserMessageID = publishChunkEvents(sessionID, chunk, parentUserMessageID, workspace, modelInfo);
        if (publishedUserMessageID) {
            parentUserMessageID = publishedUserMessageID;
        }
    });
    subscriptionID = child.addSubscriber(subscriber);
    void child.waitUntilFinished(undefined, false).then(finalize, (err: unknown) => {
        EventBus.publish({
            type: 'session.error',
            directory: workspace,
            properties: { sessionID, error: err instanceof Error ? err.message : String(err) }
        });
        finalize();
    });
}

export function registerServerSubTaskLifecycle(task: any, permissionRuntime?: ConfigPermissionRuntime): void {
    if (_serverSubTaskLifecycleParents.has(task) || typeof task.onSubTaskCreated !== 'function') return;
    _serverSubTaskLifecycleParents.add(task);
    task.onSubTaskCreated((child: any) => attachServerChildSession(child, permissionRuntime));
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
    telemetryContext?: TaskTurnInstrumentationExternalContext,
    callback?: (chunk: TaskUpdateChunk) => void
): Promise<void> {
    const activeStatuses = ['running', 'waiting'];
    if (typeof task.addSubscriber !== 'function' || typeof task.removeSubscriber !== 'function') {
        await submitServerUserMessage(task, text, c, telemetryContext);
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
        await submitServerUserMessage(task, text, c, telemetryContext);
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
        time: getOpenCodeSessionTime(task),
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0
    };
}

function makeAssistantMessageInfo(
    msgId: string,
    sessionID: string,
    parentID: string,
    opts: {
        created?: number;
        completed?: number;
        workspace?: string;
        modelInfo?: OpenCodeModelInfo;
        usage?: unknown;
    } = {}
): Record<string, unknown> {
    const dir = opts.workspace || getTaskWorkspace(undefined);
    const modelInfo = opts.modelInfo ?? EMPTY_OPEN_CODE_MODEL_INFO;
    return {
        id: msgId,
        sessionID,
        role: 'assistant',
        time: {
            created: opts.created ?? Date.now(),
            ...(opts.completed ? { completed: opts.completed } : {})
        },
        parentID,
        modelID: modelInfo.modelID,
        providerID: modelInfo.providerID,
        mode: 'default',
        agent: 'explore',
        path: { cwd: dir, root: dir },
        cost: 0,
        tokens: usageToOpenCodeTokens(opts.usage)
    };
}

function makeUserMessageInfo(
    msgId: string,
    sessionID: string,
    opts: { created?: number; modelInfo?: OpenCodeModelInfo } = {}
): UserMessage {
    const modelInfo = opts.modelInfo ?? EMPTY_OPEN_CODE_MODEL_INFO;
    return {
        id: msgId,
        sessionID,
        role: 'user',
        time: {
            created: opts.created ?? Date.now()
        },
        agent: 'explore',
        model: { providerID: modelInfo.providerID, modelID: modelInfo.modelID }
    } satisfies UserMessage;
}

/**
 * 将 OpenDesk 消息 part 转换为 opencode Part 格式。
 * opencode Part 需要 id, sessionID, messageID 字段。
 */
function partToMessagePart(
    part: UserMessagePart | AssistantMessagePart,
    sessionID: string = '',
    messageID: string = '',
    partID?: string,
    toolCallIndex?: number
): Record<string, unknown> {
    if (!part) return { type: 'text', id: ascendingId('prt'), sessionID, messageID, text: '' };
    const p = part as any;
    const partId = partID || p.part_id || ascendingId('prt');
    const base = { id: partId, sessionID, messageID };

    if (p.type === 'text') {
        return { ...base, type: 'text', text: p.text ?? '' };
    }
    if (p.type === 'tool_call') {
        const tc = p.toolcalls?.length > 0 ? p.toolcalls[toolCallIndex ?? Math.max(0, p.toolcalls.length - 1)] : p;
        const callID = tc.id || tc.call_id || partId;
        const toolName = tc.name || tc.tool_name || p.tool_name || '';
        const argsString = tc.args_string ?? tc.arguments ?? '';
        const { input, raw } = parseToolInput(argsString);
        const status = tc.status || p.status;
        // 已压缩工具结果重载后 result 被剥离（issue #341）：有替代文本时经 resolver
        // 接管输出，与模型可见内容保持一致；未压缩条目 resolver 返回 undefined，
        // 回退链路与原行为逐字节一致
        const replacement = resolveToolResultReplacement(tc);
        const outputValue = replacement ?? tc.result ?? p.result ?? tc.result_object ?? p.result_object;
        const resultObject = tc.result_object ?? p.result_object;
        const decodedOutput = typeof outputValue === 'string' ? tryParseJson(outputValue) : outputValue;
        const completionAccepted =
            (isRecord(decodedOutput) && decodedOutput.accepted === true) ||
            (isRecord(resultObject) && resultObject.accepted === true);
        if (
            (status === 'success' || completionAccepted) &&
            ['planning-attemptcompletion', 'attemptcompletion'].includes(toolName.toLowerCase())
        ) {
            return {
                ...base,
                type: 'text',
                text: stringInput(input, ['message', 'result']) ?? ''
            };
        }
        const output = stringifyToolOutput(outputValue);
        const mappedTool = mapOpenDeskToolForOpenCode(toolName, input, sessionID, outputValue, resultObject);
        return {
            ...base,
            type: 'tool',
            callID,
            tool: mappedTool.toolName,
            state: mapToolState(status, callID, mappedTool.toolName, mappedTool.input, raw, output, mappedTool.metadata)
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

function messagePartToApiParts(
    part: UserMessagePart | AssistantMessagePart,
    sessionID: string,
    messageID: string,
    partIndex: number
): Record<string, unknown>[] {
    const p = part as any;
    const toolCalls = p?.type === 'tool_call' && Array.isArray(p.toolcalls) ? p.toolcalls : [];
    if (toolCalls.length > 0) {
        return toolCalls.map((toolCall: any, toolCallIndex: number) => {
            const callID = toolCall?.id || toolCall?.call_id;
            const stableKey = `tool:${callID || `${partIndex}:${toolCallIndex}`}`;
            return partToMessagePart(part, sessionID, messageID, getStablePartId(messageID, stableKey), toolCallIndex);
        });
    }

    return [partToMessagePart(part, sessionID, messageID, getStablePartId(messageID, partStableKey(part, partIndex)))];
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
    parentID = '',
    opts: { modelInfo?: OpenCodeModelInfo } = {}
) {
    const msgId = getStableMessageId(msg.message_id, `${sessionID}:message:${index}`);
    const parts = (msg.content || msg.parts || []).flatMap((p: any, partIndex: number) =>
        messagePartToApiParts(p, sessionID, msgId, partIndex)
    );
    const dir = workspace;
    const modelInfo = opts.modelInfo ?? EMPTY_OPEN_CODE_MODEL_INFO;

    if (msg.role === 'assistant') {
        // assistant 消息的时间语义统一在 execution 元数据上（turn 收尾优先）；
        // 老任务的 legacy timestamp 已在反序列化边界（AssistantMessage.assign）迁移为 finishAt
        const execution = msg.metadata?.execution;
        const createdAt =
            (typeof execution?.finishAt === 'number' && execution.finishAt) ||
            (typeof execution?.startAt === 'number' && execution.startAt) ||
            Date.now();
        return {
            info: {
                id: msgId,
                sessionID,
                role: 'assistant',
                time: {
                    created: createdAt,
                    completed: msg.completed_at || Date.now()
                },
                parentID,
                modelID: modelInfo.modelID,
                providerID: modelInfo.providerID,
                mode: 'default',
                agent: 'explore',
                path: { cwd: dir, root: dir },
                cost: 0,
                tokens: usageToOpenCodeTokens(msg.usage)
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
            model: { providerID: modelInfo.providerID, modelID: modelInfo.modelID }
        },
        parts
    };
}

interface OpenCodeMessageWithParts {
    info: Record<string, unknown>;
    parts: Record<string, unknown>[];
}

function compactBoundaryTimestamp(boundary: CompactSeparatorMessage): number {
    const created = Date.parse(boundary.metadata.created_at);
    return Number.isFinite(created) ? created : Date.now();
}

function compactBoundaryToApiMessages(
    boundary: CompactSeparatorMessage,
    sessionID: string,
    workspace: string,
    modelInfo: OpenCodeModelInfo = EMPTY_OPEN_CODE_MODEL_INFO
): [OpenCodeMessageWithParts, OpenCodeMessageWithParts] {
    const boundaryID = boundary.metadata.boundary_id;
    const created = compactBoundaryTimestamp(boundary);
    const userMessageID = getStableMessageId(undefined, `${sessionID}:compaction:${boundaryID}:user`);
    const assistantMessageID = getStableMessageId(undefined, `${sessionID}:compaction:${boundaryID}:assistant`);
    const userInfo = makeUserMessageInfo(userMessageID, sessionID, { created, modelInfo });
    const compactionPart = {
        id: getStablePartId(userMessageID, 'compaction'),
        sessionID,
        messageID: userMessageID,
        type: 'compaction',
        auto: boundary.metadata.trigger === 'auto'
    };

    const assistantInfo = {
        ...makeAssistantMessageInfo(assistantMessageID, sessionID, userMessageID, {
            created,
            completed: created,
            workspace,
            modelInfo
        }),
        mode: 'compaction',
        agent: 'compaction',
        summary: true,
        finish: 'stop'
    };
    const summaryPart = {
        id: getStablePartId(assistantMessageID, 'summary'),
        sessionID,
        messageID: assistantMessageID,
        type: 'text',
        text: boundary.summary
    };

    return [
        { info: userInfo, parts: [compactionPart] },
        { info: assistantInfo, parts: [summaryPart] }
    ];
}

function messagesToApiFormat(
    messages: any[],
    sessionID: string,
    workspace: string,
    modelInfo: OpenCodeModelInfo = EMPTY_OPEN_CODE_MODEL_INFO
): OpenCodeMessageWithParts[] {
    let parentUserMessageID = '';
    return messages.flatMap((message, index): OpenCodeMessageWithParts[] => {
        // internal 用户消息（语言切换提醒、goal/workflow 内部 prompt 等）不进入协议输出；
        // 后续 assistant 消息的 parentID 由下方逻辑落到最近一条可见用户消息上。
        if (message.role === 'user' && message.internal === true) {
            return [];
        }
        if (isCompactBoundaryMessage(message)) {
            const compactMessages = compactBoundaryToApiMessages(message, sessionID, workspace, modelInfo);
            parentUserMessageID = compactMessages[0].info.id as string;
            return compactMessages;
        }

        const formatted = messageToApiFormat(
            message,
            index,
            sessionID,
            workspace,
            message.role === 'assistant' ? parentUserMessageID : '',
            { modelInfo }
        ) as OpenCodeMessageWithParts;
        if (message.role === 'user') {
            parentUserMessageID = formatted.info.id as string;
        }
        return [formatted];
    });
}

function publishCompactionMessages(
    boundary: CompactSeparatorMessage,
    sourceMessages: any[],
    sessionID: string,
    workspace: string,
    modelInfo: OpenCodeModelInfo
): void {
    // 先按物理消息顺序分配稳定 ID，保证首次通过 SSE 看到 compact 时仍满足 OpenCode 的 ID 排序约定。
    messagesToApiFormat(sourceMessages, sessionID, workspace, modelInfo);
    for (const message of compactBoundaryToApiMessages(boundary, sessionID, workspace, modelInfo)) {
        EventBus.publish({
            type: 'message.updated',
            directory: workspace,
            properties: {
                sessionID,
                info: message.info
            }
        });
        for (const part of message.parts) {
            publishMessagePartUpdated(sessionID, workspace, part);
        }
    }
}

function getParentUserMessageIdForIndex(messages: any[], assistantIndex: number, sessionID: string): string {
    for (let i = assistantIndex - 1; i >= 0; i--) {
        const message = messages[i] as any;
        // internal 用户消息不进入协议输出，不能作为对外可见的父消息
        if (message?.role === 'user' && message.internal !== true) {
            return getStableMessageId(message.message_id, `${sessionID}:message:${i}`);
        }
    }
    return '';
}

/**
 * 跟踪每个消息中各 part 的稳定 ID，确保流式更新中 ID 不变。
 * key: `${messageID}:${partKey}` → partId
 */
const _stablePartIds = new Map<string, string>();
const _partTextSnapshots = new Map<string, string>();
const _toolPartTimes = new Map<string, { start: number; end?: number }>();

/**
 * 获取或创建稳定的 part ID。
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

function publishCompletedAssistantMessage(
    sessionID: string,
    workspace: string,
    formatted: { info: Record<string, unknown>; parts?: Record<string, unknown>[] }
): void {
    const parts = Array.isArray(formatted.parts) ? formatted.parts : [];
    for (const part of parts) {
        if (part.type !== 'text' && part.type !== 'reasoning') {
            continue;
        }
        publishMessagePartUpdated(sessionID, workspace, part);
    }

    EventBus.publish({
        type: 'message.updated',
        directory: workspace,
        properties: {
            sessionID,
            info: formatted.info
        }
    });
}

function partStableKey(part: UserMessagePart | AssistantMessagePart, partIndex: number): string {
    const p = part as any;
    if (p?.type === 'tool_call') {
        const tc = p.toolcalls?.length > 0 ? p.toolcalls[p.toolcalls.length - 1] : p;
        const callID = tc?.id || tc?.call_id;
        return `tool:${callID || partIndex}`;
    }
    return `part:${partIndex}`;
}

function parseToolInput(argsString: unknown): { input: Record<string, unknown>; raw: string } {
    const raw = typeof argsString === 'string' ? argsString : '';
    if (raw.trim().length === 0) {
        return { input: {}, raw };
    }

    const parsed = tryParseJson(raw);
    return { input: isRecord(parsed) ? parsed : {}, raw };
}

function stringInput(input: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
        const value = input[key];
        if (typeof value === 'string' && value.trim().length > 0) {
            return value;
        }
    }
    return undefined;
}

function pickInputs(input: Record<string, unknown>, keys: string[]): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
        if (input[key] !== undefined) {
            result[key] = input[key];
        }
    }
    return result;
}

function openCodeToolMetadata(
    toolName: string,
    input: Record<string, unknown>,
    metadata: Record<string, unknown> = {}
): Record<string, unknown> {
    return {
        ...metadata,
        originalTool: toolName,
        originalInput: input
    };
}

function mapOpenDeskToolForOpenCode(
    toolName: string,
    input: Record<string, unknown>,
    sessionID: string,
    outputValue?: unknown,
    resultObject?: unknown
): { toolName: string; input: Record<string, unknown>; metadata: Record<string, unknown> } {
    const lowerName = toolName.toLowerCase();

    if (lowerName === 'planning-createsubtask' || lowerName === 'createsubtask') {
        const title = stringInput(input, ['title', 'description']);
        const objective = stringInput(input, ['objective', 'prompt']);
        const criteria = stringInput(input, ['criteria']);
        const agentName = stringInput(input, ['agentName', 'subagent_type']);
        const decodedOutput = typeof outputValue === 'string' ? tryParseJson(outputValue) : outputValue;
        const parsedOutput = isRecord(decodedOutput) ? decodedOutput : undefined;
        const parsedResultObject = isRecord(resultObject) ? resultObject : undefined;
        const childTaskID = firstString(parsedResultObject?.subtask_id, parsedOutput?.subtask_id);
        const childSessionID = childTaskID ? toExternalId(childTaskID) : undefined;
        const background = typeof input.isAsync === 'boolean' ? input.isAsync : false;
        const prompt = [objective, criteria].filter((value): value is string => value !== undefined).join('\n\n');
        const mappedInput: Record<string, unknown> = {
            ...(title ? { description: title } : {}),
            ...(prompt ? { prompt } : {}),
            subagent_type: agentName ?? 'general',
            background,
            ...(childSessionID ? { task_id: childSessionID } : {})
        };
        return {
            toolName: 'task',
            input: mappedInput,
            metadata: openCodeToolMetadata(toolName, input, {
                ...(sessionID ? { parentSessionId: sessionID } : {}),
                ...(childSessionID ? { sessionId: childSessionID } : {}),
                background
            })
        };
    }

    if (lowerName === 'skill-manager-loadskill' || lowerName === 'loadskill') {
        const name = stringInput(input, ['skillName', 'name']);
        const mappedInput: Record<string, unknown> = name ? { name } : {};
        return {
            toolName: 'skill',
            input: mappedInput,
            metadata: openCodeToolMetadata(toolName, input)
        };
    }

    if (lowerName === 'filemgr-readfile' || lowerName === 'readfile') {
        const filePath = stringInput(input, ['filePath', 'file_path', 'path']);
        const mappedInput = filePath ? { filePath } : {};
        return {
            toolName: 'read',
            input: mappedInput,
            metadata: openCodeToolMetadata(toolName, input)
        };
    }

    if (lowerName === 'filemgr-writefile' || lowerName === 'writefile') {
        const filePath = stringInput(input, ['filePath', 'file_path', 'path']);
        const mappedInput = {
            ...(filePath ? { filePath } : {}),
            ...pickInputs(input, ['content'])
        };
        return {
            toolName: 'write',
            input: mappedInput,
            metadata: openCodeToolMetadata(toolName, input)
        };
    }

    if (lowerName === 'filemgr-editfile' || lowerName === 'editfile') {
        const filePath = stringInput(input, ['filePath', 'file_path', 'path']);
        const mappedInput = {
            ...(filePath ? { filePath } : {}),
            ...pickInputs(input, ['oldString', 'newString', 'old_string', 'new_string', 'diff'])
        };
        return {
            toolName: 'edit',
            input: mappedInput,
            metadata: openCodeToolMetadata(toolName, input)
        };
    }

    if (lowerName === 'terminal-executebash' || lowerName === 'terminal-executezsh' || lowerName === 'bash') {
        return {
            toolName: 'bash',
            input: pickInputs(input, ['command', 'description', 'timeout', 'workdir']),
            metadata: openCodeToolMetadata(toolName, input)
        };
    }

    if (
        lowerName === 'terminal-executepwsh' ||
        lowerName === 'terminal-executepowershell' ||
        lowerName === 'terminal-executecommand'
    ) {
        const command = stringInput(input, ['command']);
        return {
            toolName: 'bash',
            input: {
                ...(command ? { command } : {}),
                ...pickInputs(input, ['description', 'timeout', 'workdir'])
            },
            metadata: openCodeToolMetadata(toolName, input, { shell: 'pwsh' })
        };
    }

    if (lowerName === 'filemgr-listfiles' || lowerName === 'listfiles') {
        const listPath = stringInput(input, ['path', 'directory', 'dir']);
        return {
            toolName: 'list',
            input: listPath ? { path: listPath } : {},
            metadata: openCodeToolMetadata(toolName, input)
        };
    }

    if (lowerName === 'filemgr-glob' || lowerName === 'glob') {
        return {
            toolName: 'glob',
            input: pickInputs(input, ['pattern', 'path']),
            metadata: openCodeToolMetadata(toolName, input)
        };
    }

    if (lowerName === 'filemgr-grep' || lowerName === 'grep') {
        return {
            toolName: 'grep',
            input: pickInputs(input, ['pattern', 'path', 'include']),
            metadata: openCodeToolMetadata(toolName, input)
        };
    }

    if (lowerName === 'webfetch' || lowerName === 'web-fetch' || lowerName === 'browser-fetch') {
        const url = stringInput(input, ['url']);
        return {
            toolName: 'webfetch',
            input: url ? { url } : {},
            metadata: openCodeToolMetadata(toolName, input)
        };
    }

    if (lowerName === 'websearch' || lowerName === 'web-search' || lowerName === 'browser-search') {
        const query = stringInput(input, ['query']);
        return {
            toolName: 'websearch',
            input: query ? { query } : {},
            metadata: openCodeToolMetadata(toolName, input)
        };
    }

    return {
        toolName,
        input,
        metadata: {}
    };
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
    output: string,
    metadata: Record<string, unknown> = {}
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
            metadata,
            time: { start: timing.start }
        };
    }

    const timing = toolTiming(callID, true);
    if (status === 'error' || status === 'failed') {
        return {
            status: 'error',
            input,
            error: output,
            metadata,
            time: { start: timing.start, end: timing.end ?? timing.start }
        };
    }

    return {
        status: 'completed',
        input,
        output,
        title,
        metadata,
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
export function publishChunkEvents(
    sessionID: string,
    chunk: TaskUpdateChunk,
    parentUserMsgId: string,
    workspace = getTaskWorkspace(undefined),
    modelInfo: OpenCodeModelInfo = EMPTY_OPEN_CODE_MODEL_INFO
): string | undefined {
    publishTodosIfChanged(sessionID, workspace);
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
                info: makeUserMessageInfo(userMsgId, sessionID, { created: chunk.timestamp, modelInfo })
            }
        });

        const parts = messagePartToApiParts(chunk.last_part, sessionID, userMsgId, chunk.last_part_index);
        for (const part of parts) {
            publishMessagePartUpdated(sessionID, workspace, part);
        }
        return userMsgId;
    }

    if (chunk.type === 'user_replace') {
        const userMsgId = getStableMessageId(chunk.message_id, `${sessionID}:chunk:user`);
        EventBus.publish({
            type: 'message.updated',
            directory: workspace,
            properties: {
                sessionID,
                info: makeUserMessageInfo(userMsgId, sessionID, { created: chunk.timestamp, modelInfo })
            }
        });

        for (let i = 0; i < chunk.parts.length; i++) {
            const parts = messagePartToApiParts(chunk.parts[i], sessionID, userMsgId, i);
            for (const part of parts) {
                publishMessagePartUpdated(sessionID, workspace, part);
            }
        }
        return userMsgId;
    }

    if (chunk.type === 'assistant') {
        const assistantMsgId = getStableMessageId(chunk.message_id, `${sessionID}:chunk:assistant`);
        const lastPart = chunk.last_part as any;
        if (!lastPart) return;

        const parts = messagePartToApiParts(lastPart, sessionID, assistantMsgId, chunk.last_part_index);

        // 发布 message.updated 事件（无 completed 表示仍在生成中）
        EventBus.publish({
            type: 'message.updated',
            directory: workspace,
            properties: {
                sessionID,
                info: makeAssistantMessageInfo(assistantMsgId, sessionID, parentUserMsgId, { workspace, modelInfo })
            }
        });
        for (const part of parts) {
            publishStreamingMessagePart(sessionID, workspace, part);
        }
        ServerPermissionBroker.getInstance().setActiveAssistantMessage(chunk.task_id, assistantMsgId);
        ServerQuestionBroker.getInstance().setActiveAssistantMessage(chunk.task_id, assistantMsgId);
        return undefined;
    }

    if (chunk.type === 'assistant_replace') {
        const assistantMsgId = getStableMessageId(chunk.message_id, `${sessionID}:chunk:assistant`);
        EventBus.publish({
            type: 'message.updated',
            directory: workspace,
            properties: {
                sessionID,
                info: makeAssistantMessageInfo(assistantMsgId, sessionID, parentUserMsgId, { workspace, modelInfo })
            }
        });

        for (let i = 0; i < chunk.parts.length; i++) {
            const parts = messagePartToApiParts(chunk.parts[i], sessionID, assistantMsgId, i);
            for (const part of parts) {
                publishMessagePartUpdated(sessionID, workspace, part);
            }
        }
        ServerPermissionBroker.getInstance().setActiveAssistantMessage(chunk.task_id, assistantMsgId);
        ServerQuestionBroker.getInstance().setActiveAssistantMessage(chunk.task_id, assistantMsgId);
    }
    return undefined;
}

let serverDefaultModel: string | undefined;

export function getServerDefaultModel(): string | undefined {
    return serverDefaultModel;
}

export function setServerDefaultModel(model: string | undefined): void {
    serverDefaultModel = model;
}

/**
 * Session 路由。
 * 对应 opencode 的 /session/* 端点。
 * 内部使用 OpenDesk 的 TaskManagerState 和 TaskState。
 */
export function SessionRoutes(permissionRuntime?: ConfigPermissionRuntime) {
    const applyRequestModel = (task: any, body: unknown): void => {
        applyOpenCodeRequestModel(task, body);
        task.model ??= getServerDefaultModel();
    };
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
        applyRequestModel(task, body);

        // 初始化 harness 和 system prompt
        await ensureServerTaskHarness(tms, task, workspace, permissionRuntime);
        const info = taskToSessionInfo(task, workspace, workspaceID);

        EventBus.publish({
            type: 'session.created',
            directory: workspace,
            properties: { sessionID: toExternalId(task.task_id), info }
        });

        return c.json(info);
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
        const previousTaskName = task.task_name;
        const previousModel = task.model;
        if (body.title !== undefined) {
            task.task_name = body.title;
        }
        applyRequestModel(task, body);
        if (task.task_name !== previousTaskName || task.model !== previousModel) {
            task.persistLater();
        }

        tms.save();
        const workspace = getRequestOrTaskWorkspace(c, task);
        const info = taskToSessionInfo(task, workspace, getRequestWorkspaceID(c));
        EventBus.publish({
            type: 'session.updated',
            directory: workspace,
            properties: { sessionID, info }
        });
        return c.json(info);
    });

    // DELETE /session/:sessionID - 删除会话
    app.delete('/:sessionID', (c) => {
        const sessionID = c.req.param('sessionID');
        const taskId = toInternalId(sessionID);
        const tms = GlobalState.getInstance().taskManagerState;
        const task = tms.tasks.find((candidate) => candidate.task_id === taskId);

        if (!task) {
            return c.json({ error: 'Session not found' }, 404);
        }

        const workspace = getTaskWorkspace(task);
        const info = taskToSessionInfo(task, workspace, task.workspaceID);
        const removedTaskIds = tms.removeTask(taskId);
        if (removedTaskIds.length === 0) {
            return c.json({ error: 'Session not found' }, 404);
        }

        EventBus.publish({
            type: 'session.deleted',
            directory: workspace,
            properties: { sessionID, info }
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

    // POST /session/:sessionID/summarize - 使用 OpenDesk 原生压缩能力总结会话
    app.post('/:sessionID/summarize', async (c) => {
        const body = await c.req.json().catch(() => undefined);
        if (!isRecord(body)) {
            return c.json({ error: 'Invalid summarize request body' }, 400);
        }

        const providerID = stringHeaderValue(body.providerID);
        const modelID = stringHeaderValue(body.modelID);
        if (!providerID || !modelID) {
            return c.json({ error: 'providerID and modelID are required' }, 400);
        }
        if (body.auto !== undefined && typeof body.auto !== 'boolean') {
            return c.json({ error: 'auto must be a boolean' }, 400);
        }
        if (body.auto === true) {
            return c.json({ error: 'auto=true is not supported yet' }, 400);
        }

        const sessionID = c.req.param('sessionID');
        const taskId = toInternalId(sessionID);
        const tms = GlobalState.getInstance().taskManagerState;
        const task = tms.getTask(taskId);
        if (!task) {
            return c.json({ error: 'Session not found' }, 404);
        }

        const modelAlias = resolveConfiguredOpenCodeModelAlias(providerID, modelID);
        if (!modelAlias) {
            return c.json({ error: `Model not found: ${providerID}/${modelID}` }, 400);
        }

        const workspace = getRequestOrTaskWorkspace(c, task);
        await ensureServerTaskHarness(tms, task, workspace, permissionRuntime);
        if (task.task_status === 'running') {
            await waitUntilServerTaskFinished(task);
        }

        publishSessionStatus(sessionID, workspace, { type: 'busy' }, task);
        try {
            const result = await task.compactTaskContext({
                model: modelAlias,
                modelRequestOptions: buildModelRequestOptions(c)
            });
            if (result.compacted && result.boundary && isCompactBoundaryMessage(result.boundary)) {
                publishCompactionMessages(result.boundary, task.chat_context.messages, sessionID, workspace, {
                    providerID,
                    modelID
                });
            }
            EventBus.publish({
                type: 'session.compacted',
                directory: workspace,
                properties: { sessionID }
            });
            return c.json(true);
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
            publishSessionStatus(sessionID, workspace, { type: 'idle' }, task);
        }
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
        const modelInfo = getOpenCodeModelInfo(task);

        const messages = messagesToApiFormat(task.chat_context.messages, sessionID, workspace, modelInfo);

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
                const cursor = String(result[result.length - limit].info.id);
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

        const sourceMessages = task.chat_context.messages;
        const messages = messagesToApiFormat(
            sourceMessages,
            sessionID,
            getRequestOrTaskWorkspace(c, task),
            getOpenCodeModelInfo(task)
        );
        let formatted = messages.find((message) => message.info.id === messageID);
        if (!formatted) {
            const sourceIndex = sourceMessages.findIndex((message: any) => message.message_id === messageID);
            if (sourceIndex !== -1) {
                const source = sourceMessages[sourceIndex] as any;
                const stableID = getStableMessageId(source.message_id, `${sessionID}:message:${sourceIndex}`);
                formatted = messages.find((message) => message.info.id === stableID);
            }
        }
        if (!formatted) {
            return c.json({ error: 'Message not found' }, 404);
        }

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
        await ensureServerTaskHarness(tms, task, workspace, permissionRuntime);

        if (task.task_status === 'running') {
            await waitUntilServerTaskFinished(task);
        }
        applyRequestModel(task, body);
        const modelInfo = getOpenCodeModelInfo(task, getOpenCodeRequestModelRef(body));
        const telemetryContext: TaskTurnInstrumentationExternalContext = {
            observationName: 'opencode.request',
            input: buildOpenCodeTelemetryInput(body, modelInfo),
            metadata: buildOpenCodeTelemetryMetadata(
                sessionID,
                'POST /session/:sessionID/message',
                body,
                modelInfo,
                task.model
            ),
            output: buildOpenCodeTelemetryOutput(task, sessionID)
        };
        // 发布 session busy 状态
        publishSessionStatus(sessionID, workspace, { type: 'busy' }, task);

        try {
            // 发送消息并等待完成
            let parentUserMsgId = '';
            await submitServerUserMessageAndWait(task, text, c, telemetryContext, (chunk) => {
                const publishedUserMsgId = publishChunkEvents(sessionID, chunk, parentUserMsgId, workspace, modelInfo);
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
                    resolvedParentUserMsgId,
                    { modelInfo }
                );
                (formatted.info as any).time = {
                    ...((formatted.info as any).time ?? {}),
                    completed: Date.now()
                };

                // 发布最终完整 part 后，再发布 completed 状态，避免前端漏 delta 后无法收敛。
                publishCompletedAssistantMessage(sessionID, workspace, formatted);

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
        await ensureServerTaskHarness(tms, task, workspace, permissionRuntime);

        if (task.task_status === 'running') {
            await waitUntilServerTaskFinished(task);
        }
        applyRequestModel(task, body);
        const modelInfo = getOpenCodeModelInfo(task, getOpenCodeRequestModelRef(body));
        const telemetryContext: TaskTurnInstrumentationExternalContext = {
            observationName: 'opencode.request',
            input: buildOpenCodeTelemetryInput(body, modelInfo),
            metadata: buildOpenCodeTelemetryMetadata(
                sessionID,
                'POST /session/:sessionID/prompt_async',
                body,
                modelInfo,
                task.model
            ),
            output: buildOpenCodeTelemetryOutput(task, sessionID)
        };
        // 发布 session busy 状态
        publishSessionStatus(sessionID, workspace, { type: 'busy' }, task);

        void (async () => {
            try {
                let parentUserMsgId = '';
                await submitServerUserMessageAndWait(task, text, c, telemetryContext, (chunk) => {
                    const publishedUserMsgId = publishChunkEvents(
                        sessionID,
                        chunk,
                        parentUserMsgId,
                        workspace,
                        modelInfo
                    );
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
                        resolvedParentUserMsgId,
                        { modelInfo }
                    );
                    (formatted.info as any).time = {
                        ...((formatted.info as any).time ?? {}),
                        completed: Date.now()
                    };
                    publishCompletedAssistantMessage(sessionID, workspace, formatted);
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

    // GET /session/:sessionID/todo - 会话的待办列表
    app.get('/:sessionID/todo', (c) => {
        const sessionID = c.req.param('sessionID');
        const task = GlobalState.getInstance().taskManagerState.getTask(toInternalId(sessionID));
        if (!task) return sessionNotFound(c, sessionID);
        return c.json(toOpenCodeTodos(getTaskTodosForDisplay(task.task_id)));
    });

    // GET /session/:sessionID/diff - 会话的文件变更；带 messageID 时只统计该用户消息这一轮
    app.get('/:sessionID/diff', (c) => {
        const sessionID = c.req.param('sessionID');
        const task = GlobalState.getInstance().taskManagerState.getTask(toInternalId(sessionID));
        if (!task) return sessionNotFound(c, sessionID);
        const messageID = c.req.query('messageID');
        if (!messageID) return c.json(getOpenCodeSessionDiff(task));
        const turn = getTurnMessages(
            task.chat_context.messages,
            (message, index) =>
                getStableMessageId((message as any).message_id, `${sessionID}:message:${index}`) === messageID
        );
        if (!turn) {
            return c.json(
                { name: 'BadRequest', data: { message: `message ${messageID} not found`, kind: 'Query' } },
                400
            );
        }
        return c.json(getOpenCodeSessionDiff(task, turn));
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
        const idx = messages.findIndex(
            (message: any, messageIndex: number) =>
                getStableMessageId(message.message_id, `${sessionID}:message:${messageIndex}`) === messageID
        );
        if (idx === -1) {
            return c.json({ error: 'Message not found' }, 404);
        }

        messages.splice(idx, 1);
        task.persistLater();
        tms.save();
        EventBus.publish({
            type: 'message.removed',
            directory: getTaskWorkspace(task),
            properties: { sessionID, messageID }
        });

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
