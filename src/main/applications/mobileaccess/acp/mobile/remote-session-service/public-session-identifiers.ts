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

import { createHash } from 'node:crypto';
import { PublicSessionProjectionError } from './public-session.js';

export interface PublicSessionIdentifierCandidate {
    sourceMessageIndex: number;
    sourceMessageId: unknown;
    toolCalls: Array<{
        partIndex: number;
        callIndex: number;
        sourceToolCallId: unknown;
    }>;
}

export interface PublicSessionIdentifierPlan {
    hasMessage(sourceMessageIndex: number): boolean;
    hasToolCall(sourceMessageIndex: number, partIndex: number, callIndex: number): boolean;
    messageId(sourceMessageIndex: number): string;
    toolCallId(sourceMessageIndex: number, partIndex: number, callIndex: number): string;
    registerMessage(candidate: PublicSessionIdentifierCandidate): string;
    registerToolCall(
        sourceMessageIndex: number,
        partIndex: number,
        callIndex: number,
        sourceToolCallId: unknown
    ): string;
    rebindMessageToolCalls(
        sourceMessageIndex: number,
        candidates: readonly {
            partIndex: number;
            callIndex: number;
            sourceToolCallId: unknown;
        }[]
    ): readonly { partIndex: number; callIndex: number; toolCallId: string }[];
}

export type PublicSessionIdentifierPlanFactory = (
    sessionId: string,
    candidates: readonly PublicSessionIdentifierCandidate[]
) => PublicSessionIdentifierPlan;

const PUBLIC_ID_NAMESPACE = '616fb01b-c128-5a4c-935d-36769f777230';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuidBytes(value: string): Buffer {
    if (!UUID_RE.test(value)) {
        throw new PublicSessionProjectionError('session_load_failed', 'invalid UUID namespace');
    }
    return Buffer.from(value.replaceAll('-', ''), 'hex');
}

function formatUuid(bytes: Buffer): string {
    const value = bytes.toString('hex');
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function uuidV5(name: string, namespace = PUBLIC_ID_NAMESPACE): string {
    const digest = createHash('sha1').update(uuidBytes(namespace)).update(Buffer.from(name, 'utf8')).digest();
    const bytes = Buffer.from(digest.subarray(0, 16));
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return formatUuid(bytes);
}

const messageFallback = (sessionId: string, sourceMessageIndex: number): string =>
    uuidV5(JSON.stringify(['message', sessionId, sourceMessageIndex]));
const toolFallback = (messageId: string, partIndex: number, callIndex: number): string =>
    uuidV5(JSON.stringify(['tool_call', messageId, partIndex, callIndex]));

function stringCount(values: readonly unknown[]): Map<string, number> {
    const result = new Map<string, number>();
    for (const value of values) {
        if (typeof value !== 'string') continue;
        result.set(value, (result.get(value) ?? 0) + 1);
    }
    return result;
}

export function createPublicSessionIdentifierPlan(
    sessionId: string,
    candidates: readonly PublicSessionIdentifierCandidate[]
): PublicSessionIdentifierPlan {
    const messageCounts = stringCount(candidates.map((candidate) => candidate.sourceMessageId));
    const toolCounts = stringCount(
        candidates.flatMap((candidate) => candidate.toolCalls.map((call) => call.sourceToolCallId))
    );
    const messages = new Map<number, string>();
    let tools = new Map<string, string>();
    const usedMessages = new Set<string>();
    const usedTools = new Set<string>();
    const sourceMessageIds = new Set<string>();
    const sourceToolOwners = new Map<string, { sourceMessageIndex: number; toolCallId: string }>();
    let toolRawByPosition = new Map<string, string>();
    let maxRegisteredMessageIndex = -1;

    const putMessage = (candidate: PublicSessionIdentifierCandidate, allowExistingCollision: boolean): string => {
        if (!Number.isSafeInteger(candidate.sourceMessageIndex) || candidate.sourceMessageIndex < 0) {
            throw new PublicSessionProjectionError('session_load_failed', 'invalid source message index');
        }
        if (messages.has(candidate.sourceMessageIndex)) {
            throw new PublicSessionProjectionError('session_load_failed', 'message position already registered');
        }
        const raw = candidate.sourceMessageId;
        const reusable = typeof raw === 'string' && UUID_RE.test(raw) && messageCounts.get(raw) === 1;
        const value = reusable ? raw : messageFallback(sessionId, candidate.sourceMessageIndex);
        if (usedMessages.has(value)) {
            throw new PublicSessionProjectionError(
                'session_load_failed',
                allowExistingCollision
                    ? 'new message identity conflicts with sent history'
                    : 'final message identity collision'
            );
        }
        messages.set(candidate.sourceMessageIndex, value);
        if (typeof raw === 'string') sourceMessageIds.add(raw);
        usedMessages.add(value);
        maxRegisteredMessageIndex = Math.max(maxRegisteredMessageIndex, candidate.sourceMessageIndex);
        return value;
    };

    const putTool = (
        sourceMessageIndex: number,
        partIndex: number,
        callIndex: number,
        sourceToolCallId: unknown,
        allowExistingCollision: boolean
    ): string => {
        const messageId = messages.get(sourceMessageIndex);
        if (
            !messageId ||
            !Number.isSafeInteger(partIndex) ||
            partIndex < 0 ||
            !Number.isSafeInteger(callIndex) ||
            callIndex < 0
        ) {
            throw new PublicSessionProjectionError('session_load_failed', 'invalid tool position');
        }
        const key = `${sourceMessageIndex}:${partIndex}:${callIndex}`;
        if (tools.has(key)) {
            throw new PublicSessionProjectionError('session_load_failed', 'tool position already registered');
        }
        const reusable =
            typeof sourceToolCallId === 'string' &&
            sourceToolCallId.length > 0 &&
            toolCounts.get(sourceToolCallId) === 1;
        const value = reusable ? sourceToolCallId : toolFallback(messageId, partIndex, callIndex);
        if (usedTools.has(value)) {
            throw new PublicSessionProjectionError(
                'session_load_failed',
                allowExistingCollision
                    ? 'new tool identity conflicts with sent history'
                    : 'final tool identity collision'
            );
        }
        tools.set(key, value);
        if (typeof sourceToolCallId === 'string') toolRawByPosition.set(key, sourceToolCallId);
        usedTools.add(value);
        if (reusable) {
            sourceToolOwners.set(sourceToolCallId as string, { sourceMessageIndex, toolCallId: value });
        }
        return value;
    };

    for (const candidate of candidates) putMessage(candidate, false);
    for (const candidate of candidates) {
        for (const call of candidate.toolCalls) {
            putTool(candidate.sourceMessageIndex, call.partIndex, call.callIndex, call.sourceToolCallId, false);
        }
    }

    return {
        hasMessage: (sourceMessageIndex) => messages.has(sourceMessageIndex),
        hasToolCall: (sourceMessageIndex, partIndex, callIndex) =>
            tools.has(`${sourceMessageIndex}:${partIndex}:${callIndex}`),
        messageId(sourceMessageIndex) {
            const value = messages.get(sourceMessageIndex);
            if (!value) throw new PublicSessionProjectionError('session_load_failed', 'unknown message position');
            return value;
        },
        toolCallId(sourceMessageIndex, partIndex, callIndex) {
            const value = tools.get(`${sourceMessageIndex}:${partIndex}:${callIndex}`);
            if (!value) throw new PublicSessionProjectionError('session_load_failed', 'unknown tool position');
            return value;
        },
        registerMessage(candidate) {
            if (candidate.sourceMessageIndex <= maxRegisteredMessageIndex) {
                throw new PublicSessionProjectionError(
                    'session_load_failed',
                    'new message is not after all registered source messages'
                );
            }
            if (typeof candidate.sourceMessageId === 'string' && UUID_RE.test(candidate.sourceMessageId)) {
                if (usedMessages.has(candidate.sourceMessageId)) {
                    throw new PublicSessionProjectionError(
                        'session_load_failed',
                        'new message identity conflicts with sent history'
                    );
                }
                messageCounts.set(candidate.sourceMessageId, sourceMessageIds.has(candidate.sourceMessageId) ? 2 : 1);
            }
            return putMessage(candidate, true);
        },
        registerToolCall(sourceMessageIndex, partIndex, callIndex, sourceToolCallId) {
            if (typeof sourceToolCallId === 'string' && sourceToolCallId.length > 0) {
                if (usedTools.has(sourceToolCallId) || [...toolRawByPosition.values()].includes(sourceToolCallId)) {
                    throw new PublicSessionProjectionError(
                        'session_load_failed',
                        'new tool source/final identity conflicts with sent history'
                    );
                }
                toolCounts.set(sourceToolCallId, 1);
            }
            return putTool(sourceMessageIndex, partIndex, callIndex, sourceToolCallId, true);
        },
        rebindMessageToolCalls(sourceMessageIndex, candidatesToBind) {
            const messageId = messages.get(sourceMessageIndex);
            if (!messageId) {
                throw new PublicSessionProjectionError('session_load_failed', 'replacement message is unknown');
            }
            const positionKeys = new Set<string>();
            const nextTools = new Map(tools);
            const nextRawByPosition = new Map(toolRawByPosition);
            for (const key of nextTools.keys()) {
                if (key.startsWith(`${sourceMessageIndex}:`)) {
                    nextTools.delete(key);
                    nextRawByPosition.delete(key);
                }
            }
            const rawCounts = stringCount([
                ...nextRawByPosition.values(),
                ...candidatesToBind.map((candidate) => candidate.sourceToolCallId)
            ]);
            const nextValues = new Set<string>();
            const result: Array<{ partIndex: number; callIndex: number; toolCallId: string }> = [];
            for (const candidate of candidatesToBind) {
                if (
                    !Number.isSafeInteger(candidate.partIndex) ||
                    candidate.partIndex < 0 ||
                    !Number.isSafeInteger(candidate.callIndex) ||
                    candidate.callIndex < 0
                ) {
                    throw new PublicSessionProjectionError(
                        'session_load_failed',
                        'replacement tool position is invalid'
                    );
                }
                const key = `${sourceMessageIndex}:${candidate.partIndex}:${candidate.callIndex}`;
                if (positionKeys.has(key)) {
                    throw new PublicSessionProjectionError(
                        'session_load_failed',
                        'replacement tool position is duplicated'
                    );
                }
                positionKeys.add(key);
                const raw = candidate.sourceToolCallId;
                const owner = typeof raw === 'string' ? sourceToolOwners.get(raw) : undefined;
                let value: string;
                if (
                    typeof raw === 'string' &&
                    raw.length > 0 &&
                    rawCounts.get(raw) === 1 &&
                    owner?.sourceMessageIndex === sourceMessageIndex
                ) {
                    value = owner.toolCallId;
                } else if (typeof raw === 'string' && raw.length > 0 && rawCounts.get(raw) === 1 && !owner) {
                    if (usedTools.has(raw)) {
                        throw new PublicSessionProjectionError(
                            'session_load_failed',
                            'replacement tool identity conflicts with sent history'
                        );
                    }
                    value = raw;
                } else {
                    value = toolFallback(messageId, candidate.partIndex, candidate.callIndex);
                }
                const oldAtPosition = tools.get(key);
                if (
                    nextValues.has(value) ||
                    (usedTools.has(value) && oldAtPosition !== value && owner?.toolCallId !== value)
                ) {
                    throw new PublicSessionProjectionError(
                        'session_load_failed',
                        'replacement final tool identity collides'
                    );
                }
                nextValues.add(value);
                nextTools.set(key, value);
                if (typeof raw === 'string') nextRawByPosition.set(key, raw);
                usedTools.add(value);
                if (typeof raw === 'string' && raw.length > 0 && rawCounts.get(raw) === 1 && !owner) {
                    sourceToolOwners.set(raw, { sourceMessageIndex, toolCallId: value });
                }
                result.push({ partIndex: candidate.partIndex, callIndex: candidate.callIndex, toolCallId: value });
            }
            tools = nextTools;
            toolRawByPosition = nextRawByPosition;
            return result;
        }
    };
}

export const RUN_TOKEN_MAX_LENGTH = 64;
const RUN_TOKEN_PATTERN = /^rt1_[A-Za-z0-9_-]{43}$/;

export function isRunToken(value: unknown): value is string {
    return typeof value === 'string' && value.length <= RUN_TOKEN_MAX_LENGTH && RUN_TOKEN_PATTERN.test(value);
}

export function deriveRunToken(sessionId: string, generation: number): string {
    if (!sessionId.trim()) throw new Error('run token session id is invalid');
    if (!Number.isSafeInteger(generation) || generation < 1) {
        throw new Error('run token generation is invalid');
    }
    return `rt1_${createHash('sha256')
        .update(JSON.stringify(['opendesk-run-v1', sessionId, generation]), 'utf8')
        .digest('base64url')}`;
}
