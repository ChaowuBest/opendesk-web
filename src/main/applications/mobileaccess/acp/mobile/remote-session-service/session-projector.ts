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

import path from 'node:path';
import type { InteractionSessionScopeResolver } from '../../../../../aikernel/interaction/delivery.js';
import {
    assertPublicSessionLimits,
    PublicSessionProjectionError,
    type PublicAssistantPart,
    type PublicCompletionStatus,
    type PublicMessage,
    type PublicSessionInfo,
    type PublicSessionLoadedInfo,
    type PublicSessionState,
    type PublicSessionUpdate,
    type PublicTaskStatus,
    type PublicToolCall,
    type PublicUserPart
} from './public-session.js';
import {
    deriveRunToken,
    type PublicSessionIdentifierCandidate,
    type PublicSessionIdentifierPlan
} from './public-session-identifiers.js';

export type RemoteTaskStatus = 'waiting' | 'running' | 'stopped' | 'failed';
export type RemoteCompletionStatus = 'success' | 'fail' | 'ask' | null;

export interface RemoteSessionTaskEntry {
    task_id?: unknown;
    parent_id?: unknown;
    task_name?: unknown;
    task_status?: unknown;
    completion_status?: unknown;
    workspace?: unknown;
    created_at?: unknown;
    updated_at?: unknown;
    finished_at?: unknown;
    internal?: unknown;
    name_pending?: unknown;
}

export interface RemoteSessionDiagnostic {
    code: 'workspace_fallback' | 'invalid_activity_time' | 'unknown_task_status' | 'unknown_completion_status';
    taskId?: string;
}

const TASK_STATUSES = new Set<PublicTaskStatus>(['waiting', 'running', 'stopped', 'failed']);
const COMPLETION_STATUSES = new Set<Exclude<PublicCompletionStatus, null>>(['success', 'fail', 'ask']);
const EPOCH = new Date(0).toISOString();

export interface SourceToolCall {
    id: unknown;
    tool_name: unknown;
    status: unknown;
    result?: unknown;
    result_object?: unknown;
}

export type UserMessagePart =
    | { type: 'text'; text: unknown }
    | { type: 'image_url'; image_url?: unknown }
    | { type: 'file'; path?: unknown };

export type AssistantMessagePart =
    | { type: 'text'; text: unknown }
    | { type: 'reasoning'; content: unknown; elapsedSeconds?: unknown }
    | { type: 'error'; title: unknown; message: unknown }
    | { type: 'tool_call'; toolcalls: SourceToolCall[] };

export type SourceChatMessage =
    | { role: 'user'; message_id: unknown; timestamp?: unknown; internal?: unknown; content: UserMessagePart[] }
    | { role: 'assistant'; message_id: unknown; timestamp?: unknown; content: AssistantMessagePart[] }
    | { role: 'compact_separator'; message_id?: unknown; timestamp?: unknown; content?: never[] };

export type RemoteGoalStatus = 'active' | 'paused' | 'blocked' | 'complete' | 'cleared';

export type RemoteTaskSubmitResult =
    | { status: 'ok'; supplementId?: string }
    | { status: 'error'; messageKey: string; messageArgs?: Record<string, unknown> };

export interface RemoteTaskSubmitOptions {
    interactive: boolean;
    onUserMessageCommitted(messageId: string): void;
}

export interface LoadedPublicSessionTask extends RemoteSessionTaskEntry {
    task_id: string;
    chat_context: { messages: SourceChatMessage[] };
    goal_state?: { status?: unknown };
    readonly stop_requested_by_user?: boolean;
    getTurnGeneration(): number;
    stop(reason: 'user' | 'system'): void;
    submitUserMessage(message: string, options: RemoteTaskSubmitOptions): Promise<RemoteTaskSubmitResult>;
    waitUntilFinished(
        callback?: (update: TaskUpdateChunk) => void | Promise<void>,
        resolveOnStop?: boolean
    ): Promise<void>;
}

export interface RootProjectionDependencies {
    getDefaultWorkspace(): string;
    diagnose?: (event: RemoteSessionDiagnostic) => void;
}

export interface TaskUpdateUserChunk {
    type: 'user';
    task_id: string;
    message_id: string;
    last_part_index: number;
    last_part: UserMessagePart;
}

export interface TaskUpdateAssistantChunk {
    type: 'assistant';
    task_id: string;
    message_id: string;
    last_part_index: number;
    last_part: AssistantMessagePart;
}

export interface TaskUpdateUserReplaceChunk {
    type: 'user_replace';
    task_id: string;
    message_id: string;
    parts: UserMessagePart[];
}

export interface TaskUpdateAssistantReplaceChunk {
    type: 'assistant_replace';
    task_id: string;
    message_id: string;
    parts: AssistantMessagePart[];
}

export type TaskUpdateChunk =
    | TaskUpdateUserChunk
    | TaskUpdateAssistantChunk
    | TaskUpdateUserReplaceChunk
    | TaskUpdateAssistantReplaceChunk
    | { type: 'retry' | 'goal_eval' | 'compact'; task_id: string };

export function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function finite(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function taskIdForDiagnostic(task: RemoteSessionTaskEntry): string | undefined {
    return isNonEmptyString(task.task_id) ? task.task_id : undefined;
}

function activityTime(task: RemoteSessionTaskEntry, diagnose?: (event: RemoteSessionDiagnostic) => void): string {
    const parsed = [task.created_at, task.updated_at, task.finished_at]
        .filter((value): value is string => typeof value === 'string')
        .map((value) => Date.parse(value))
        .filter(Number.isFinite);
    if (parsed.length === 0) {
        diagnose?.({ code: 'invalid_activity_time', taskId: taskIdForDiagnostic(task) });
        return EPOCH;
    }
    return new Date(Math.max(...parsed)).toISOString();
}

function taskStatus(
    task: RemoteSessionTaskEntry,
    diagnose?: (event: RemoteSessionDiagnostic) => void
): PublicTaskStatus {
    if (typeof task.task_status === 'string' && TASK_STATUSES.has(task.task_status as PublicTaskStatus)) {
        return task.task_status as PublicTaskStatus;
    }
    diagnose?.({ code: 'unknown_task_status', taskId: taskIdForDiagnostic(task) });
    return 'stopped';
}

function completionStatus(
    task: RemoteSessionTaskEntry,
    diagnose?: (event: RemoteSessionDiagnostic) => void
): PublicCompletionStatus {
    if (task.completion_status === null || task.completion_status === undefined) return null;
    if (
        typeof task.completion_status === 'string' &&
        COMPLETION_STATUSES.has(task.completion_status as Exclude<PublicCompletionStatus, null>)
    ) {
        return task.completion_status as Exclude<PublicCompletionStatus, null>;
    }
    diagnose?.({ code: 'unknown_completion_status', taskId: taskIdForDiagnostic(task) });
    return null;
}

function workspace(task: RemoteSessionTaskEntry, dependencies: RootProjectionDependencies): string {
    if (isNonEmptyString(task.workspace) && path.isAbsolute(task.workspace.trim())) {
        return task.workspace.trim();
    }
    dependencies.diagnose?.({ code: 'workspace_fallback', taskId: taskIdForDiagnostic(task) });
    const fallback = dependencies.getDefaultWorkspace();
    if (!isNonEmptyString(fallback) || !path.isAbsolute(fallback.trim())) {
        throw new PublicSessionProjectionError('session_load_failed', 'default workspace is not absolute');
    }
    return fallback.trim();
}

export function projectPublicSessionInfo(
    task: RemoteSessionTaskEntry,
    dependencies: RootProjectionDependencies
): PublicSessionInfo {
    if (!isNonEmptyString(task.task_id)) {
        throw new PublicSessionProjectionError('session_load_failed', 'task id is missing');
    }
    return {
        sessionId: task.task_id,
        title: isNonEmptyString(task.task_name) ? task.task_name.trim() : null,
        cwd: workspace(task, dependencies),
        updatedAt: activityTime(task, dependencies.diagnose),
        taskStatus: taskStatus(task, dependencies.diagnose),
        completionStatus: completionStatus(task, dependencies.diagnose)
    };
}

function projectRunToken(task: LoadedPublicSessionTask, status: PublicTaskStatus): string | null {
    return status === 'running' ? deriveRunToken(task.task_id, task.getTurnGeneration()) : null;
}

export function projectPublicSessionLoadedInfo(
    task: LoadedPublicSessionTask,
    dependencies: RootProjectionDependencies
): PublicSessionLoadedInfo {
    const info = projectPublicSessionInfo(task, dependencies);
    return {
        title: info.title,
        cwd: info.cwd,
        updatedAt: info.updatedAt,
        taskStatus: info.taskStatus,
        completionStatus: info.completionStatus,
        runToken: projectRunToken(task, info.taskStatus)
    };
}

export function selectProductVisibleRoots(tasks: readonly RemoteSessionTaskEntry[]): RemoteSessionTaskEntry[] {
    const visible = tasks.filter((task) => isNonEmptyString(task.task_name) || task.name_pending === true);
    const visibleIds = new Set(visible.flatMap((task) => (isNonEmptyString(task.task_id) ? [task.task_id] : [])));
    return visible
        .filter((task) => {
            const parentId = isNonEmptyString(task.parent_id) ? task.parent_id : undefined;
            return !parentId || !visibleIds.has(parentId);
        })
        .filter((task) => task.internal !== true);
}

export function collectPublicSessionIdentifierCandidates(
    messages: readonly SourceChatMessage[]
): PublicSessionIdentifierCandidate[] {
    const result: PublicSessionIdentifierCandidate[] = [];
    messages.forEach((message, sourceMessageIndex) => {
        if (message.role === 'compact_separator') return;
        if (message.role === 'user' && message.internal === true) return;
        const toolCalls: PublicSessionIdentifierCandidate['toolCalls'] = [];
        if (message.role === 'assistant') {
            message.content.forEach((part, partIndex) => {
                if (part.type !== 'tool_call') return;
                part.toolcalls.forEach((call, callIndex) => {
                    toolCalls.push({ partIndex, callIndex, sourceToolCallId: call.id });
                });
            });
        }
        result.push({ sourceMessageIndex, sourceMessageId: message.message_id, toolCalls });
    });
    return result;
}

function toolResultText(call: SourceToolCall): string | undefined {
    if (typeof call.result === 'string' && call.result.length > 0) return call.result;
    if (call.result_object === undefined) return undefined;
    try {
        const serialized = JSON.stringify(call.result_object);
        return typeof serialized === 'string' ? serialized : String(call.result_object);
    } catch {
        return String(call.result_object);
    }
}

function projectToolCall(call: SourceToolCall, toolCallId: string): PublicToolCall {
    const toolName = isNonEmptyString(call.tool_name) ? call.tool_name : '';
    if (
        call.status !== 'pending' &&
        call.status !== 'running' &&
        call.status !== 'success' &&
        call.status !== 'error'
    ) {
        throw new PublicSessionProjectionError('session_load_failed', 'tool status is invalid');
    }
    const resultText = toolResultText(call);
    return resultText === undefined
        ? { toolCallId, toolName, status: call.status }
        : { toolCallId, toolName, status: call.status, resultText };
}

function projectUserPart(part: UserMessagePart): PublicUserPart {
    if (part.type === 'text') {
        if (typeof part.text !== 'string') {
            throw new PublicSessionProjectionError('session_load_failed', 'user text is invalid');
        }
        return { type: 'text', text: part.text };
    }
    if (part.type === 'image_url') return { type: 'unavailable_attachment', attachmentKind: 'image' };
    if (part.type === 'file') return { type: 'unavailable_attachment', attachmentKind: 'file' };
    throw new PublicSessionProjectionError('session_load_failed', 'user part is invalid');
}

function projectAssistantPart(
    part: AssistantMessagePart,
    sourceMessageIndex: number,
    partIndex: number,
    identity: PublicSessionIdentifierPlan
): PublicAssistantPart {
    if (part.type === 'text') {
        if (typeof part.text !== 'string') {
            throw new PublicSessionProjectionError('session_load_failed', 'text is invalid');
        }
        return { type: 'text', text: part.text };
    }
    if (part.type === 'reasoning') {
        if (typeof part.content !== 'string') {
            throw new PublicSessionProjectionError('session_load_failed', 'reasoning is invalid');
        }
        return !finite(part.elapsedSeconds) || part.elapsedSeconds < 0
            ? { type: 'reasoning', content: part.content }
            : { type: 'reasoning', content: part.content, elapsedSeconds: part.elapsedSeconds };
    }
    if (part.type === 'error') {
        if (typeof part.message !== 'string') {
            throw new PublicSessionProjectionError('session_load_failed', 'error part is invalid');
        }
        return { type: 'error', title: typeof part.title === 'string' ? part.title : '', message: part.message };
    }
    if (part.type !== 'tool_call' || part.toolcalls.length === 0) {
        throw new PublicSessionProjectionError('session_load_failed', 'tool call part is invalid');
    }
    return {
        type: 'tool_call',
        toolCalls: part.toolcalls.map((call, callIndex) =>
            projectToolCall(call, identity.toolCallId(sourceMessageIndex, partIndex, callIndex))
        )
    };
}

function projectMessage(
    message: SourceChatMessage,
    sourceMessageIndex: number,
    identity: PublicSessionIdentifierPlan
): PublicMessage | undefined {
    if (message.role === 'compact_separator') return { role: 'compact_boundary' };
    if (message.role === 'user') {
        if (message.internal === true) return undefined;
        if (!finite(message.timestamp)) {
            throw new PublicSessionProjectionError('session_load_failed', 'user timestamp is invalid');
        }
        const parts = message.content.map((part) => projectUserPart(part));
        if (parts.length === 0) {
            throw new PublicSessionProjectionError('session_load_failed', 'user message is empty');
        }
        return {
            role: 'user',
            messageId: identity.messageId(sourceMessageIndex),
            timestamp: message.timestamp,
            parts
        };
    }
    if (message.role !== 'assistant') {
        throw new PublicSessionProjectionError('session_load_failed', 'message role is invalid');
    }
    const projected = {
        role: 'assistant' as const,
        messageId: identity.messageId(sourceMessageIndex),
        parts: message.content.map((part, partIndex) =>
            projectAssistantPart(part, sourceMessageIndex, partIndex, identity)
        )
    };
    return finite(message.timestamp) ? { ...projected, timestamp: message.timestamp } : projected;
}

export function projectPublicSessionState(
    task: LoadedPublicSessionTask,
    identity: PublicSessionIdentifierPlan,
    dependencies: RootProjectionDependencies
): PublicSessionState {
    const messages: PublicMessage[] = [];
    task.chat_context.messages.forEach((message, sourceMessageIndex) => {
        const projected = projectMessage(message, sourceMessageIndex, identity);
        if (projected !== undefined) messages.push(projected);
    });
    const state: PublicSessionState = {
        sessionId: task.task_id,
        ...projectPublicSessionLoadedInfo(task, dependencies),
        history: { messages }
    };
    assertPublicSessionLimits(state);
    return state;
}

function locateNormalSourceIndex(
    task: LoadedPublicSessionTask,
    chunk: TaskUpdateUserChunk | TaskUpdateAssistantChunk
): number {
    const matches: number[] = [];
    task.chat_context.messages.forEach((message, index) => {
        if (
            message.role === chunk.type &&
            message.message_id === chunk.message_id &&
            message.content[chunk.last_part_index] === chunk.last_part
        ) {
            matches.push(index);
        }
    });
    if (matches.length !== 1) {
        throw new PublicSessionProjectionError('session_load_failed', 'normal update source is ambiguous');
    }
    return matches[0];
}

function locateReplacementSourceIndex(
    task: LoadedPublicSessionTask,
    chunk: TaskUpdateUserReplaceChunk | TaskUpdateAssistantReplaceChunk
): number {
    const role = chunk.type === 'user_replace' ? 'user' : 'assistant';
    const matches: number[] = [];
    task.chat_context.messages.forEach((message, index) => {
        if (
            message.role === role &&
            message.message_id === chunk.message_id &&
            message.content.length === chunk.parts.length &&
            message.content.every((part, partIndex) => part === chunk.parts[partIndex])
        ) {
            matches.push(index);
        }
    });
    if (matches.length !== 1) {
        throw new PublicSessionProjectionError('session_load_failed', 'replacement source is ambiguous');
    }
    return matches[0];
}

function publicToolCandidates(
    message: Extract<LoadedPublicSessionTask['chat_context']['messages'][number], { role: 'assistant' }>
): Array<{ partIndex: number; callIndex: number; sourceToolCallId: unknown }> {
    const result: Array<{ partIndex: number; callIndex: number; sourceToolCallId: unknown }> = [];
    message.content.forEach((part, partIndex) => {
        if (part.type !== 'tool_call') return;
        part.toolcalls.forEach((call, callIndex) => {
            result.push({ partIndex, callIndex, sourceToolCallId: call.id });
        });
    });
    return result;
}

function ensureNormalIdentity(
    message: LoadedPublicSessionTask['chat_context']['messages'][number],
    sourceMessageIndex: number,
    identity: PublicSessionIdentifierPlan
): { messageId: string; isNewMessage: boolean } {
    const isNewMessage = !identity.hasMessage(sourceMessageIndex);
    if (isNewMessage) {
        identity.registerMessage({ sourceMessageIndex, sourceMessageId: message.message_id, toolCalls: [] });
    }
    return { messageId: identity.messageId(sourceMessageIndex), isNewMessage };
}

export function projectPublicPartState(
    task: LoadedPublicSessionTask,
    chunk: TaskUpdateUserChunk | TaskUpdateAssistantChunk,
    identity: PublicSessionIdentifierPlan
): Extract<PublicSessionUpdate, { type: 'part_state' }> | undefined {
    const sourceMessageIndex = locateNormalSourceIndex(task, chunk);
    const source = task.chat_context.messages[sourceMessageIndex];
    if (source.role === 'user' && source.internal === true) return undefined;
    if (source.role !== chunk.type) {
        throw new PublicSessionProjectionError('session_load_failed', 'normal source role changed');
    }
    const { messageId, isNewMessage } = ensureNormalIdentity(source, sourceMessageIndex, identity);
    if (!Number.isSafeInteger(chunk.last_part_index) || chunk.last_part_index < 0) {
        throw new PublicSessionProjectionError('session_load_failed', 'normal source part index is invalid');
    }
    if (source.role === 'user' && source.timestamp !== undefined && !finite(source.timestamp)) {
        throw new PublicSessionProjectionError('session_load_failed', 'normal source timestamp is invalid');
    }
    if (isNewMessage && source.role === 'user' && source.timestamp === undefined) {
        throw new PublicSessionProjectionError('session_load_failed', 'new user timestamp is missing');
    }
    let part: PublicUserPart | PublicAssistantPart;
    if (source.role === 'user') {
        part = projectUserPart(chunk.last_part as UserMessagePart);
    } else {
        const sourcePart = chunk.last_part as AssistantMessagePart;
        if (sourcePart.type === 'tool_call') {
            sourcePart.toolcalls.forEach((call, callIndex) => {
                if (!identity.hasToolCall(sourceMessageIndex, chunk.last_part_index, callIndex)) {
                    identity.registerToolCall(sourceMessageIndex, chunk.last_part_index, callIndex, call.id);
                }
            });
        }
        part = projectAssistantPart(sourcePart, sourceMessageIndex, chunk.last_part_index, identity);
    }
    return {
        type: 'part_state',
        messageId,
        role: source.role,
        partIndex: chunk.last_part_index,
        part,
        ...(isNewMessage && finite(source.timestamp) ? { messageTimestamp: source.timestamp } : {})
    };
}

export function projectPublicMessageReplacement(
    task: LoadedPublicSessionTask,
    chunk: TaskUpdateUserReplaceChunk | TaskUpdateAssistantReplaceChunk,
    identity: PublicSessionIdentifierPlan
): Extract<PublicSessionUpdate, { type: 'message_replace' }> | undefined {
    const sourceMessageIndex = locateReplacementSourceIndex(task, chunk);
    const source = task.chat_context.messages[sourceMessageIndex];
    if (source.role === 'user' && source.internal === true) return undefined;
    if (!identity.hasMessage(sourceMessageIndex)) {
        throw new PublicSessionProjectionError('session_load_failed', 'replacement target was never published');
    }
    identity.rebindMessageToolCalls(
        sourceMessageIndex,
        source.role === 'assistant' ? publicToolCandidates(source) : []
    );
    const message = projectMessage(source, sourceMessageIndex, identity);
    if (!message || message.role === 'compact_boundary') {
        throw new PublicSessionProjectionError('session_load_failed', 'replacement did not produce a public message');
    }
    if (message.messageId !== identity.messageId(sourceMessageIndex)) {
        throw new PublicSessionProjectionError('session_load_failed', 'replacement message identity changed');
    }
    return { type: 'message_replace', message };
}

export function projectTaskChunk(
    task: LoadedPublicSessionTask,
    chunk: TaskUpdateChunk,
    identity: PublicSessionIdentifierPlan
): PublicSessionUpdate | undefined {
    switch (chunk.type) {
        case 'user':
        case 'assistant':
            return projectPublicPartState(task, chunk, identity);
        case 'user_replace':
        case 'assistant_replace':
            return projectPublicMessageReplacement(task, chunk, identity);
        case 'retry':
        case 'goal_eval':
        case 'compact':
            return undefined;
    }
}

export function createInteractionSessionScopeResolver(
    getTaskList: () => readonly RemoteSessionTaskEntry[]
): InteractionSessionScopeResolver {
    return (sourceTaskId) => {
        const tasks = getTaskList();
        const byId = new Map<string, RemoteSessionTaskEntry>();
        for (const task of tasks) {
            if (!isNonEmptyString(task.task_id)) continue;
            if (byId.has(task.task_id)) return undefined;
            byId.set(task.task_id, task);
        }
        const roots = new Set(
            selectProductVisibleRoots(tasks)
                .map((task) => task.task_id)
                .filter(isNonEmptyString)
        );
        const seen = new Set<string>();
        let cursor = sourceTaskId;
        while (true) {
            if (seen.has(cursor)) return undefined;
            seen.add(cursor);
            const task = byId.get(cursor);
            if (!task) return undefined;
            if (roots.has(cursor)) return cursor;
            if (!isNonEmptyString(task.parent_id)) return undefined;
            cursor = task.parent_id;
        }
    };
}
