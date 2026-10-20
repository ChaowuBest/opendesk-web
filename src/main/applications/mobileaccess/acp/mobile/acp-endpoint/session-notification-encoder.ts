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

import * as acp from '@agentclientprotocol/sdk';
import {
    PUBLIC_SESSION_PROFILE_VERSION,
    PublicSessionProjectionError,
    canUpdateToolName,
    type PublicAssistantMessage,
    type PublicAssistantPart,
    type PublicMessage,
    type PublicSessionLoadedInfo,
    type PublicSessionState,
    type PublicSessionUpdate,
    type PublicToolCall,
    type PublicUserMessage,
    type PublicUserPart
} from '../remote-session-service/public-session.js';
import { sessionNotificationWireBytes } from './session-message-mapper.js';

export const toolStatus = (status: PublicToolCall['status']): acp.ToolCallStatus =>
    ({ pending: 'pending', running: 'in_progress', success: 'completed', error: 'failed' })[
        status
    ] as acp.ToolCallStatus;

const TERMINAL_TOOLS = new Set(['executeBash', 'executeZsh', 'executePowerShell', 'checkShellStatus']);
const READ_TOOLS = new Set(['readFile', 'extractText']);
const SEARCH_TOOLS = new Set(['globFiles', 'grepFiles', 'semanticSearch', 'WebSearch']);
const EDIT_TOOLS = new Set(['writeFile', 'editFile', 'searchReplace', 'applyPatch']);

export function toolKind(name: string): acp.ToolKind {
    if (TERMINAL_TOOLS.has(name)) return 'execute';
    if (READ_TOOLS.has(name)) return 'read';
    if (name === 'webFetch') return 'fetch';
    if (SEARCH_TOOLS.has(name)) return 'search';
    if (EDIT_TOOLS.has(name)) return 'edit';
    return 'other';
}

export function toolContent(resultText: string | undefined): acp.ToolCallContent[] | undefined {
    return resultText === undefined ? undefined : [{ type: 'content', content: { type: 'text', text: resultText } }];
}

function partMeta(partIndex: number, timestamp: number | undefined, extra: Record<string, unknown> = {}) {
    return {
        opendesk: {
            schemaVersion: PUBLIC_SESSION_PROFILE_VERSION,
            partIndex,
            ...(timestamp === undefined ? {} : { timestamp }),
            ...extra
        }
    };
}

function userPartUpdate(
    message: PublicUserMessage,
    part: PublicUserPart,
    partIndex: number,
    timestamp: number | undefined
): acp.SessionUpdate {
    if (part.type === 'text') {
        return {
            sessionUpdate: 'user_message_chunk',
            messageId: message.messageId,
            content: { type: 'text', text: part.text },
            _meta: partMeta(partIndex, timestamp)
        };
    }
    return {
        sessionUpdate: 'user_message_chunk',
        messageId: message.messageId,
        content: { type: 'text', text: '' },
        _meta: partMeta(partIndex, timestamp, {
            eventType: 'unavailable_attachment',
            attachmentKind: part.attachmentKind
        })
    };
}

function assistantPartUpdates(
    message: PublicAssistantMessage,
    part: PublicAssistantPart,
    partIndex: number,
    timestamp: number | undefined
): acp.SessionUpdate[] {
    if (part.type === 'text') {
        return [
            {
                sessionUpdate: 'agent_message_chunk',
                messageId: message.messageId,
                content: { type: 'text', text: part.text },
                _meta: partMeta(partIndex, timestamp)
            }
        ];
    }
    if (part.type === 'reasoning') {
        return [
            {
                sessionUpdate: 'agent_thought_chunk',
                messageId: message.messageId,
                content: { type: 'text', text: part.content },
                _meta: partMeta(
                    partIndex,
                    timestamp,
                    part.elapsedSeconds === undefined ? {} : { elapsedSeconds: part.elapsedSeconds }
                )
            }
        ];
    }
    if (part.type === 'error') {
        return [
            {
                sessionUpdate: 'agent_message_chunk',
                messageId: message.messageId,
                content: { type: 'text', text: `${part.title}\n\n${part.message}` },
                _meta: partMeta(partIndex, timestamp, {
                    eventType: 'error',
                    title: part.title,
                    message: part.message
                })
            }
        ];
    }
    return part.toolCalls.map((call, callIndex): acp.SessionUpdate => {
        const content = toolContent(call.resultText);
        return {
            sessionUpdate: 'tool_call',
            toolCallId: call.toolCallId,
            title: call.toolName,
            kind: toolKind(call.toolName),
            status: toolStatus(call.status),
            ...(content === undefined ? {} : { content }),
            _meta: {
                opendesk: {
                    schemaVersion: PUBLIC_SESSION_PROFILE_VERSION,
                    messageId: message.messageId,
                    partIndex,
                    callIndex,
                    ...(callIndex === 0 && timestamp !== undefined ? { timestamp } : {})
                }
            }
        };
    });
}

export function encodePublicMessage(message: PublicMessage): acp.SessionUpdate[] {
    if (message.role === 'compact_boundary') {
        return [
            {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: '' },
                _meta: {
                    opendesk: {
                        schemaVersion: PUBLIC_SESSION_PROFILE_VERSION,
                        eventType: 'compact_boundary'
                    }
                }
            }
        ];
    }
    if (message.parts.length === 0) {
        return [
            {
                sessionUpdate: 'agent_message_chunk',
                messageId: message.messageId,
                content: { type: 'text', text: '' },
                _meta: {
                    opendesk: {
                        schemaVersion: PUBLIC_SESSION_PROFILE_VERSION,
                        eventType: 'empty_message',
                        ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp })
                    }
                }
            }
        ];
    }
    let first = true;
    const updates: acp.SessionUpdate[] = [];
    message.parts.forEach((part, partIndex) => {
        const timestamp = first ? message.timestamp : undefined;
        const current =
            message.role === 'user'
                ? [userPartUpdate(message, part as PublicUserPart, partIndex, timestamp)]
                : assistantPartUpdates(message, part as PublicAssistantPart, partIndex, timestamp);
        updates.push(...current);
        if (current.length > 0) first = false;
    });
    return updates;
}

export function sessionInfoUpdate(info: PublicSessionLoadedInfo & { sessionId: string }): acp.SessionUpdate {
    return {
        sessionUpdate: 'session_info_update',
        title: info.title,
        updatedAt: info.updatedAt,
        _meta: {
            opendesk: {
                schemaVersion: PUBLIC_SESSION_PROFILE_VERSION,
                cwd: info.cwd,
                taskStatus: info.taskStatus,
                completionStatus: info.completionStatus,
                runToken: info.runToken
            }
        }
    };
}

export function encodeSessionSnapshot(state: PublicSessionState): {
    notifications: acp.SessionNotification[];
    wireBytes: number;
} {
    const updates = [sessionInfoUpdate(state), ...state.history.messages.flatMap(encodePublicMessage)];
    const notifications = updates.map((update): acp.SessionNotification => ({ sessionId: state.sessionId, update }));
    return {
        notifications,
        wireBytes: notifications.reduce((total, notification) => total + sessionNotificationWireBytes(notification), 0)
    };
}

export function encodeToolCall(
    call: PublicToolCall,
    messageId: string,
    partIndex: number,
    callIndex: number,
    timestamp?: number
): acp.SessionUpdate {
    const content = toolContent(call.resultText);
    return {
        sessionUpdate: 'tool_call',
        toolCallId: call.toolCallId,
        title: call.toolName,
        kind: toolKind(call.toolName),
        status: toolStatus(call.status),
        ...(content === undefined ? {} : { content }),
        _meta: {
            opendesk: {
                schemaVersion: PUBLIC_SESSION_PROFILE_VERSION,
                messageId,
                partIndex,
                callIndex,
                ...(timestamp === undefined ? {} : { timestamp })
            }
        }
    };
}

export function encodePublicPartState(
    role: 'user' | 'assistant',
    messageId: string,
    partIndex: number,
    part: PublicUserPart | PublicAssistantPart,
    messageTimestamp?: number
): acp.SessionUpdate[] {
    if (role === 'user') {
        const message: PublicUserMessage = {
            role,
            messageId,
            timestamp: messageTimestamp!,
            parts: [part as PublicUserPart]
        };
        return [userPartUpdate(message, part as PublicUserPart, partIndex, messageTimestamp)];
    }
    const message: PublicAssistantMessage =
        messageTimestamp === undefined
            ? { role, messageId, parts: [part as PublicAssistantPart] }
            : { role, messageId, timestamp: messageTimestamp, parts: [part as PublicAssistantPart] };
    return assistantPartUpdates(message, part as PublicAssistantPart, partIndex, messageTimestamp);
}

function assistantTimestampUpdate(messageId: string, timestamp: number): acp.SessionUpdate {
    return {
        sessionUpdate: 'agent_message_chunk',
        messageId,
        content: { type: 'text', text: '' },
        _meta: {
            opendesk: {
                schemaVersion: PUBLIC_SESSION_PROFILE_VERSION,
                eventType: 'assistant_timestamp_state',
                timestamp
            }
        }
    };
}

interface SentToolState {
    messageId: string;
    partIndex: number;
    callIndex: number;
    toolName: string;
    status: PublicToolCall['status'];
    resultText?: string;
}

export interface EncodedPublicUpdate {
    notifications: acp.SessionNotification[];
    commit(): void;
}

function replacementMeta(update: acp.SessionUpdate): Record<string, unknown> {
    if (!update._meta || typeof update._meta !== 'object') {
        throw new PublicSessionProjectionError('session_load_failed', 'replacement nested meta is missing');
    }
    const value = (update._meta as Record<string, unknown>).opendesk;
    if (
        !value ||
        typeof value !== 'object' ||
        (value as Record<string, unknown>).schemaVersion !== PUBLIC_SESSION_PROFILE_VERSION
    ) {
        throw new PublicSessionProjectionError('session_load_failed', 'replacement nested profile is invalid');
    }
    return value as Record<string, unknown>;
}

function assertReplacementUpdates(
    message: PublicUserMessage | PublicAssistantMessage,
    updates: readonly acp.SessionUpdate[]
): void {
    if (message.role === 'user' && updates.length === 0) {
        throw new PublicSessionProjectionError('session_load_failed', 'user replacement is empty');
    }
    let lastPart = -1;
    let lastCall = -1;
    for (const update of updates) {
        if (
            update.sessionUpdate === 'session_info_update' ||
            update.sessionUpdate === 'tool_call_update' ||
            update.sessionUpdate === 'plan' ||
            update.sessionUpdate === 'available_commands_update' ||
            update.sessionUpdate === 'current_mode_update' ||
            update.sessionUpdate === 'config_option_update' ||
            update.sessionUpdate === 'usage_update'
        ) {
            throw new PublicSessionProjectionError('session_load_failed', 'replacement contains forbidden update');
        }
        const meta = replacementMeta(update);
        if (meta.eventType === 'message_replace' || meta.eventType === 'compact_boundary') {
            throw new PublicSessionProjectionError(
                'session_load_failed',
                'replacement nesting is recursive or compact'
            );
        }
        if (update.sessionUpdate === 'tool_call') {
            if (
                meta.messageId !== message.messageId ||
                !Number.isSafeInteger(meta.partIndex) ||
                !Number.isSafeInteger(meta.callIndex)
            ) {
                throw new PublicSessionProjectionError('session_load_failed', 'replacement tool identity is invalid');
            }
            const partIndex = meta.partIndex as number;
            const callIndex = meta.callIndex as number;
            if (
                (partIndex === lastPart && callIndex !== lastCall + 1) ||
                (partIndex === lastPart + 1 && callIndex !== 0) ||
                (partIndex !== lastPart && partIndex !== lastPart + 1)
            ) {
                throw new PublicSessionProjectionError('session_load_failed', 'replacement call order is invalid');
            }
            if (partIndex === lastPart + 1) {
                lastPart = partIndex;
                lastCall = -1;
            }
            lastCall = callIndex;
            continue;
        }
        const expected =
            message.role === 'user'
                ? 'user_message_chunk'
                : update.sessionUpdate === 'agent_thought_chunk'
                  ? 'agent_thought_chunk'
                  : 'agent_message_chunk';
        if (update.sessionUpdate !== expected || update.messageId !== message.messageId) {
            throw new PublicSessionProjectionError('session_load_failed', 'replacement role/message changed');
        }
        if (meta.eventType === 'empty_message') {
            if (message.role !== 'assistant' || updates.length !== 1) {
                throw new PublicSessionProjectionError('session_load_failed', 'invalid empty replacement');
            }
            continue;
        }
        if (!Number.isSafeInteger(meta.partIndex) || (meta.partIndex as number) !== lastPart + 1) {
            throw new PublicSessionProjectionError('session_load_failed', 'replacement part order is invalid');
        }
        lastPart = meta.partIndex as number;
        lastCall = -1;
    }
}

export class SessionNotificationEncoder {
    private sentTools = new Map<string, SentToolState>();
    private disposed = false;

    constructor(
        private readonly sessionId: string,
        snapshot: PublicSessionState
    ) {
        snapshot.history.messages.forEach((message) => {
            if (message.role !== 'assistant') return;
            message.parts.forEach((part, partIndex) => {
                if (part.type !== 'tool_call') return;
                part.toolCalls.forEach((call, callIndex) =>
                    this.sentTools.set(call.toolCallId, {
                        messageId: message.messageId,
                        partIndex,
                        callIndex,
                        toolName: call.toolName,
                        status: call.status,
                        ...(call.resultText === undefined ? {} : { resultText: call.resultText })
                    })
                );
            });
        });
    }

    encode(update: PublicSessionUpdate): EncodedPublicUpdate {
        if (this.disposed) {
            throw new PublicSessionProjectionError('session_load_failed', 'session notification encoder is disposed');
        }
        if (update.type === 'session_info_replace') {
            return this.wrap([sessionInfoUpdate({ sessionId: this.sessionId, ...update.info })], () => undefined);
        }
        if (update.type === 'assistant_timestamp_state') {
            return this.wrap([assistantTimestampUpdate(update.messageId, update.timestamp)], () => undefined);
        }
        if (update.type === 'message_replace') return this.messageReplace(update.message);
        if (update.part.type !== 'tool_call') {
            return this.wrap(
                encodePublicPartState(
                    update.role,
                    update.messageId,
                    update.partIndex,
                    update.part,
                    update.messageTimestamp
                ),
                () => undefined
            );
        }
        if (update.role !== 'assistant') {
            throw new PublicSessionProjectionError('session_load_failed', 'tool part role is invalid');
        }
        const nextStates: SentToolState[] = [];
        const updates: acp.SessionUpdate[] = [];
        update.part.toolCalls.forEach((call, callIndex) => {
            const next: SentToolState = {
                messageId: update.messageId,
                partIndex: update.partIndex,
                callIndex,
                toolName: call.toolName,
                status: call.status,
                ...(call.resultText === undefined ? {} : { resultText: call.resultText })
            };
            const previous = this.sentTools.get(call.toolCallId);
            if (!previous) {
                updates.push(
                    encodeToolCall(
                        call,
                        update.messageId,
                        update.partIndex,
                        callIndex,
                        callIndex === 0 ? update.messageTimestamp : undefined
                    )
                );
            } else {
                if (
                    previous.messageId !== next.messageId ||
                    previous.partIndex !== next.partIndex ||
                    previous.callIndex !== next.callIndex ||
                    !canUpdateToolName(previous.toolName, next.toolName)
                ) {
                    throw new PublicSessionProjectionError('session_load_failed', 'normal tool identity changed');
                }
                if (JSON.stringify(previous) !== JSON.stringify(next)) {
                    updates.push({
                        sessionUpdate: 'tool_call_update',
                        toolCallId: call.toolCallId,
                        title: call.toolName,
                        kind: toolKind(call.toolName),
                        status: toolStatus(call.status),
                        content: toolContent(call.resultText) ?? null,
                        _meta: {
                            opendesk: {
                                schemaVersion: PUBLIC_SESSION_PROFILE_VERSION,
                                messageId: update.messageId,
                                partIndex: update.partIndex,
                                callIndex
                            }
                        }
                    });
                }
            }
            nextStates.push(next);
        });
        return this.wrap(updates, () => {
            if (update.part.type !== 'tool_call') return;
            update.part.toolCalls.forEach((call, index) => {
                this.sentTools.set(call.toolCallId, nextStates[index]);
            });
        });
    }

    private messageReplace(message: PublicUserMessage | PublicAssistantMessage): EncodedPublicUpdate {
        const nested = encodePublicMessage(message);
        assertReplacementUpdates(message, nested);
        const update: acp.SessionUpdate = {
            sessionUpdate: message.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
            messageId: message.messageId,
            content: { type: 'text', text: '' },
            _meta: {
                opendesk: {
                    schemaVersion: PUBLIC_SESSION_PROFILE_VERSION,
                    eventType: 'message_replace',
                    replacementUpdates: nested
                }
            }
        };
        return this.wrap([update], () => {
            for (const [id, value] of this.sentTools) {
                if (value.messageId === message.messageId) this.sentTools.delete(id);
            }
            if (message.role !== 'assistant') return;
            message.parts.forEach((part, partIndex) => {
                if (part.type !== 'tool_call') return;
                part.toolCalls.forEach((call, callIndex) =>
                    this.sentTools.set(call.toolCallId, {
                        messageId: message.messageId,
                        partIndex,
                        callIndex,
                        toolName: call.toolName,
                        status: call.status,
                        ...(call.resultText === undefined ? {} : { resultText: call.resultText })
                    })
                );
            });
        });
    }

    private wrap(updates: acp.SessionUpdate[], commit: () => void): EncodedPublicUpdate {
        return {
            notifications: updates.map((update) => ({ sessionId: this.sessionId, update })),
            commit
        };
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.sentTools.clear();
    }
}
