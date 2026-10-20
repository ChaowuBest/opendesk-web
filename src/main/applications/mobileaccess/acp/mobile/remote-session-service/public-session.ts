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

export const PUBLIC_SESSION_PROFILE_VERSION = 1 as const;
export const PUBLIC_SESSION_STATE_MAX_BYTES = 8 * 1024 * 1024;
export const PUBLIC_TEXT_MAX_BYTES = 1024 * 1024;
export const PUBLIC_REASONING_MAX_BYTES = 1024 * 1024;
export const PUBLIC_TOOL_RESULT_MAX_BYTES = 2 * 1024 * 1024;

export type PublicTaskStatus = 'waiting' | 'running' | 'stopped' | 'failed';
export type PublicCompletionStatus = 'success' | 'fail' | 'ask' | null;

export type PublicUserPart =
    | { type: 'text'; text: string }
    | { type: 'unavailable_attachment'; attachmentKind: 'image' | 'file' };

export type PublicAssistantPart =
    | { type: 'text'; text: string }
    | { type: 'reasoning'; content: string; elapsedSeconds?: number }
    | { type: 'tool_call'; toolCalls: PublicToolCall[] }
    | { type: 'error'; title: string; message: string };

// Empty name is the explicit unknown-name representation; named calls cannot be renamed.
export function isPublicToolName(value: unknown): value is string {
    return typeof value === 'string' && (value === '' || value.trim().length > 0);
}

export function canUpdateToolName(previous: string, next: string): boolean {
    return isPublicToolName(next) && (previous === next || previous === '');
}

export interface PublicToolCall {
    toolCallId: string;
    toolName: string;
    status: 'pending' | 'running' | 'success' | 'error';
    resultText?: string;
}

export interface PublicUserMessage {
    role: 'user';
    messageId: string;
    timestamp: number;
    parts: PublicUserPart[];
}

export interface PublicAssistantMessage {
    role: 'assistant';
    messageId: string;
    timestamp?: number;
    parts: PublicAssistantPart[];
}

export interface PublicCompactBoundary {
    role: 'compact_boundary';
}

export type PublicMessage = PublicUserMessage | PublicAssistantMessage | PublicCompactBoundary;

export interface PublicSessionInfo {
    sessionId: string;
    title: string | null;
    cwd: string;
    updatedAt: string;
    taskStatus: PublicTaskStatus;
    completionStatus: PublicCompletionStatus;
}

export interface PublicSessionState extends PublicSessionInfo {
    runToken: string | null;
    history: { messages: PublicMessage[] };
}

export interface PublicSessionLoadedInfo {
    title: string | null;
    cwd: string;
    updatedAt: string;
    taskStatus: PublicTaskStatus;
    completionStatus: PublicCompletionStatus;
    runToken: string | null;
}

export type PublicSessionUpdate =
    | {
          type: 'part_state';
          messageId: string;
          role: 'user' | 'assistant';
          partIndex: number;
          part: PublicUserPart | PublicAssistantPart;
          messageTimestamp?: number;
      }
    | { type: 'assistant_timestamp_state'; messageId: string; timestamp: number }
    | { type: 'message_replace'; message: PublicUserMessage | PublicAssistantMessage }
    | { type: 'session_info_replace'; info: PublicSessionLoadedInfo };

type PublicSessionMutation =
    | { type: 'set_info'; sessionId: string; info: PublicSessionLoadedInfo }
    | { type: 'append_message'; message: PublicMessage }
    | {
          type: 'set_part';
          messageId: string;
          role: 'user' | 'assistant';
          partIndex: number;
          part: PublicUserPart | PublicAssistantPart;
          messageTimestamp?: number;
      }
    | { type: 'set_assistant_timestamp'; messageId: string; timestamp: number }
    | { type: 'replace_message'; message: PublicUserMessage | PublicAssistantMessage };

export type PublicSessionFailureCode = 'session_unavailable' | 'session_too_large' | 'session_load_failed';

export class PublicSessionProjectionError extends Error {
    constructor(
        readonly code: PublicSessionFailureCode,
        message: string,
        options?: ErrorOptions
    ) {
        super(message, options);
        this.name = 'PublicSessionProjectionError';
    }
}

export function utf8Bytes(value: string): number {
    return Buffer.byteLength(value, 'utf8');
}

export function publicStateBytes(state: PublicSessionState): number {
    return utf8Bytes(JSON.stringify(state));
}

function assertStringLimit(value: string, limit: number, label: string): void {
    if (utf8Bytes(value) > limit) {
        throw new PublicSessionProjectionError('session_too_large', `${label} exceeds its public limit`);
    }
}

export function assertPublicSessionLimits(state: PublicSessionState): void {
    for (const message of state.history.messages) {
        if (message.role === 'compact_boundary') continue;
        for (const part of message.parts) {
            if (part.type === 'text') {
                assertStringLimit(part.text, PUBLIC_TEXT_MAX_BYTES, 'text');
            } else if (part.type === 'reasoning') {
                assertStringLimit(part.content, PUBLIC_REASONING_MAX_BYTES, 'reasoning');
            } else if (part.type === 'tool_call') {
                for (const call of part.toolCalls) {
                    if (call.resultText !== undefined) {
                        assertStringLimit(call.resultText, PUBLIC_TOOL_RESULT_MAX_BYTES, 'tool result');
                    }
                }
            }
        }
    }
    if (publicStateBytes(state) > PUBLIC_SESSION_STATE_MAX_BYTES) {
        throw new PublicSessionProjectionError('session_too_large', 'public session state exceeds its limit');
    }
}

function invalid(message: string): never {
    throw new PublicSessionProjectionError('session_load_failed', message);
}

function finite(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function assertPart(part: PublicUserPart | PublicAssistantPart): void {
    if (
        part.type === 'reasoning' &&
        part.elapsedSeconds !== undefined &&
        (!finite(part.elapsedSeconds) || part.elapsedSeconds < 0)
    ) {
        invalid('invalid reasoning duration');
    }
    if (part.type !== 'tool_call') return;
    if (part.toolCalls.length === 0) invalid('empty tool call part');
    for (const call of part.toolCalls) {
        if (!call.toolCallId || !isPublicToolName(call.toolName)) invalid('invalid tool identity');
        if (!['pending', 'running', 'success', 'error'].includes(call.status)) {
            invalid('invalid tool status');
        }
    }
}

function assertMessage(message: PublicMessage): void {
    if (message.role === 'compact_boundary') return;
    if (!message.messageId) invalid('empty message id');
    if (message.role === 'user' && (!finite(message.timestamp) || message.parts.length === 0)) {
        invalid('invalid user message');
    }
    if (message.role === 'assistant' && message.timestamp !== undefined && !finite(message.timestamp)) {
        invalid('invalid assistant timestamp');
    }
    for (const part of message.parts) assertPart(part);
}

function assertUniqueState(state: PublicSessionState): void {
    const messages = new Set<string>();
    const tools = new Set<string>();
    for (const message of state.history.messages) {
        assertMessage(message);
        if (message.role === 'compact_boundary') continue;
        if (messages.has(message.messageId)) invalid('duplicate message id');
        messages.add(message.messageId);
        for (const part of message.parts) {
            if (part.type !== 'tool_call') continue;
            for (const call of part.toolCalls) {
                if (tools.has(call.toolCallId)) invalid('duplicate tool id');
                tools.add(call.toolCallId);
            }
        }
    }
    assertPublicSessionLimits(state);
}

function same(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function assertToolContinuity(oldPart: PublicAssistantPart, nextPart: PublicAssistantPart): void {
    if (oldPart.type !== 'tool_call' || nextPart.type !== 'tool_call') return;
    if (nextPart.toolCalls.length < oldPart.toolCalls.length) invalid('normal tool update deleted calls');
    oldPart.toolCalls.forEach((oldCall, index) => {
        const nextCall = nextPart.toolCalls[index];
        if (
            !nextCall ||
            nextCall.toolCallId !== oldCall.toolCallId ||
            !canUpdateToolName(oldCall.toolName, nextCall.toolName)
        ) {
            invalid('normal tool identity changed');
        }
    });
}

function reducePublicSession(state: PublicSessionState, mutation: PublicSessionMutation): PublicSessionState {
    let next: PublicSessionState;
    if (mutation.type === 'set_info') {
        if (mutation.sessionId !== state.sessionId) invalid('session id changed');
        next = { ...state, ...mutation.info };
    } else if (mutation.type === 'set_assistant_timestamp') {
        if (!finite(mutation.timestamp)) invalid('invalid assistant timestamp');
        const index = state.history.messages.findIndex(
            (message) => message.role !== 'compact_boundary' && message.messageId === mutation.messageId
        );
        if (index < 0) invalid('assistant timestamp target missing');
        const current = state.history.messages[index];
        if (current.role !== 'assistant') invalid('assistant timestamp target role changed');
        const messages = [...state.history.messages];
        messages[index] = { ...current, timestamp: mutation.timestamp };
        next = { ...state, history: { messages } };
    } else if (mutation.type === 'append_message') {
        assertMessage(mutation.message);
        next = { ...state, history: { messages: [...state.history.messages, mutation.message] } };
    } else if (mutation.type === 'replace_message') {
        const index = state.history.messages.findIndex(
            (message) => message.role !== 'compact_boundary' && message.messageId === mutation.message.messageId
        );
        if (index < 0) invalid('replacement target missing');
        const current = state.history.messages[index];
        if (current.role === 'compact_boundary' || current.role !== mutation.message.role) {
            invalid('replacement role changed');
        }
        assertMessage(mutation.message);
        const messages = [...state.history.messages];
        messages[index] = mutation.message;
        next = { ...state, history: { messages } };
    } else {
        if (!Number.isSafeInteger(mutation.partIndex) || mutation.partIndex < 0) invalid('invalid part index');
        const index = state.history.messages.findIndex(
            (message) => message.role !== 'compact_boundary' && message.messageId === mutation.messageId
        );
        if (index < 0) {
            if (mutation.partIndex !== 0) invalid('new message must start at part zero');
            if (mutation.role === 'user' && !finite(mutation.messageTimestamp)) invalid('new user timestamp missing');
            const message: PublicUserMessage | PublicAssistantMessage =
                mutation.role === 'user'
                    ? {
                          role: 'user',
                          messageId: mutation.messageId,
                          timestamp: mutation.messageTimestamp!,
                          parts: [mutation.part as PublicUserPart]
                      }
                    : mutation.messageTimestamp === undefined
                      ? {
                            role: 'assistant',
                            messageId: mutation.messageId,
                            parts: [mutation.part as PublicAssistantPart]
                        }
                      : {
                            role: 'assistant',
                            messageId: mutation.messageId,
                            timestamp: mutation.messageTimestamp,
                            parts: [mutation.part as PublicAssistantPart]
                        };
            next = { ...state, history: { messages: [...state.history.messages, message] } };
        } else {
            const current = state.history.messages[index];
            if (current.role === 'compact_boundary' || current.role !== mutation.role) invalid('normal role changed');
            if (mutation.messageTimestamp !== undefined && mutation.messageTimestamp !== current.timestamp) {
                invalid('normal timestamp changed');
            }
            if (mutation.partIndex > current.parts.length) invalid('part hole');
            const parts = [...current.parts] as Array<PublicUserPart | PublicAssistantPart>;
            if (mutation.partIndex < parts.length) {
                if (parts[mutation.partIndex].type !== mutation.part.type) invalid('normal part type changed');
                if (current.role === 'assistant') {
                    assertToolContinuity(
                        parts[mutation.partIndex] as PublicAssistantPart,
                        mutation.part as PublicAssistantPart
                    );
                }
                parts[mutation.partIndex] = mutation.part;
            } else {
                parts.push(mutation.part);
            }
            const messages = [...state.history.messages];
            messages[index] = { ...current, parts } as PublicUserMessage | PublicAssistantMessage;
            next = { ...state, history: { messages } };
        }
    }
    assertUniqueState(next);
    return same(state, next) ? state : next;
}

export function applyPublicSessionUpdate(state: PublicSessionState, update: PublicSessionUpdate): PublicSessionState {
    if (update.type === 'part_state') {
        return reducePublicSession(state, {
            type: 'set_part',
            messageId: update.messageId,
            role: update.role,
            partIndex: update.partIndex,
            part: update.part,
            messageTimestamp: update.messageTimestamp
        });
    }
    if (update.type === 'message_replace') {
        return reducePublicSession(state, { type: 'replace_message', message: update.message });
    }
    if (update.type === 'assistant_timestamp_state') {
        return reducePublicSession(state, {
            type: 'set_assistant_timestamp',
            messageId: update.messageId,
            timestamp: update.timestamp
        });
    }
    return reducePublicSession(state, { type: 'set_info', sessionId: state.sessionId, info: update.info });
}
