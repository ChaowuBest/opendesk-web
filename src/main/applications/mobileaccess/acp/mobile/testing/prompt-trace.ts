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
import { RemotePromptDomainError, type RemoteSessionService } from '../remote-session-service/service.js';

export interface PromptTraceSnapshot {
    readonly connectionId: string;
    readonly promptOrdinal: number;
    readonly stage: 'requested' | 'committed' | 'accepted' | 'recorded_not_started' | 'completed' | 'failed';
    readonly sessionIdHash: string;
    readonly userMessageIdHash?: string;
    readonly outboundOrdinal: number;
    readonly bufferedWireBytes: number;
    readonly markerCount: number;
    readonly duplicateCount: number;
    readonly resultCode?: string;
    readonly fixture: boolean;
    readonly monotonicMs: number;
}

interface ConnectionTraceState {
    promptOrdinal: number;
    markerCount: number;
    duplicateCount: number;
    userMessageIds: Set<string>;
}

function hash(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function resultCode(error: unknown): string {
    return error instanceof RemotePromptDomainError ? error.code : 'server';
}

export function observePromptTrace<T extends RemoteSessionService>(
    delegate: T,
    options: {
        connectionId(): string;
        outboundOrdinal(): number;
        bufferedWireBytes?(): number;
        fixture(): boolean;
        monotonicMs?: () => number;
        emit(snapshot: PromptTraceSnapshot): void;
    }
): T {
    const state: ConnectionTraceState = {
        promptOrdinal: 0,
        markerCount: 0,
        duplicateCount: 0,
        userMessageIds: new Set<string>()
    };
    const monotonicMs = options.monotonicMs ?? (() => performance.now());

    return {
        ...delegate,
        async startPrompt(sessionId, text, interactive) {
            const connectionId = options.connectionId();
            state.promptOrdinal += 1;
            const promptOrdinal = state.promptOrdinal;
            const sessionIdHash = hash(sessionId);
            const fixture = options.fixture();
            const emit = (
                stage: PromptTraceSnapshot['stage'],
                fields: { userMessageId?: string; resultCode?: string } = {}
            ): void => {
                options.emit(
                    Object.freeze({
                        connectionId,
                        promptOrdinal,
                        stage,
                        sessionIdHash,
                        ...(fields.userMessageId === undefined
                            ? {}
                            : { userMessageIdHash: hash(fields.userMessageId) }),
                        outboundOrdinal: options.outboundOrdinal(),
                        bufferedWireBytes: options.bufferedWireBytes?.() ?? 0,
                        markerCount: state.markerCount,
                        duplicateCount: state.duplicateCount,
                        ...(fields.resultCode === undefined ? {} : { resultCode: fields.resultCode }),
                        fixture,
                        monotonicMs: monotonicMs()
                    })
                );
            };

            emit('requested');
            try {
                const started = await delegate.startPrompt(sessionId, text, interactive);
                const userMessageId = started.userMessageId;
                emit('committed', { userMessageId });
                if (state.userMessageIds.has(userMessageId)) state.duplicateCount += 1;
                else state.userMessageIds.add(userMessageId);
                state.markerCount += 1;
                emit(started.kind === 'started' ? 'accepted' : 'recorded_not_started', {
                    userMessageId
                });
                if (started.kind === 'recorded_not_started') return started;
                return {
                    ...started,
                    completion: started.completion.then(
                        (completion) => {
                            emit('completed', { userMessageId });
                            return completion;
                        },
                        (error) => {
                            emit('failed', { userMessageId, resultCode: resultCode(error) });
                            throw error;
                        }
                    )
                };
            } catch (error) {
                emit('failed', { resultCode: resultCode(error) });
                throw error;
            }
        }
    } as T;
}
