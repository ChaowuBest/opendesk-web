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

import { randomUUID } from 'node:crypto';
import type { PublicSessionUpdate } from '../remote-session-service/public-session.js';
import {
    RemotePromptContractError,
    RemotePromptDomainError,
    type BegunSessionLoad,
    type RemotePromptStart,
    type RemoteSessionService
} from '../remote-session-service/service.js';
import type { PublicSessionSyncHandle } from '../remote-session-service/public-session-sync.js';
/** 提示失败/延迟注入计划：原先与旧网络控制协议同文件，控制协议删除后只保留计划本身。 */
export interface PromptFaultPlan {
    promptMode?: 'normal' | 'reject_before_commit' | 'recorded_not_started';
    delayPromptCompletionMs?: number;
    disconnectBeforeAccepted?: boolean;
    disconnectAfterAccepted?: boolean;
}

type LiveConsumer = (update: PublicSessionUpdate) => Promise<void>;

function wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createPromptFixtureService<T extends RemoteSessionService>(
    delegate: T,
    options: {
        getPlan(): Readonly<PromptFaultPlan>;
        createUserMessageId?: () => string;
        now?: () => number;
        delay?: (milliseconds: number) => Promise<void>;
        onFixtureEvent?: (event: 'committed') => void;
    }
): T {
    const consumers = new Map<string, LiveConsumer>();
    const createUserMessageId = options.createUserMessageId ?? randomUUID;
    const now = options.now ?? Date.now;
    const delay = options.delay ?? wait;

    const deleteConsumer = (sessionId: string, consumer?: LiveConsumer): void => {
        if (consumer !== undefined && consumers.get(sessionId) !== consumer) return;
        consumers.delete(sessionId);
    };

    return {
        ...delegate,
        beginSessionLoad(sessionId, identityPlanFactory): BegunSessionLoad {
            const begun = delegate.beginSessionLoad(sessionId, identityPlanFactory);
            const sync: PublicSessionSyncHandle = {
                sessionId: begun.sync.sessionId,
                get phase() {
                    return begun.sync.phase;
                },
                installFatalSink: (sink) => begun.sync.installFatalSink(sink),
                async activate(consumer) {
                    consumers.set(sessionId, consumer);
                    try {
                        await begun.sync.activate(consumer);
                    } catch (error) {
                        deleteConsumer(sessionId, consumer);
                        throw error;
                    }
                },
                stop(reason) {
                    deleteConsumer(sessionId);
                    begun.sync.stop(reason);
                }
            };
            return { ...begun, sync };
        },
        async startPrompt(sessionId, text, interactive): Promise<RemotePromptStart> {
            const plan = options.getPlan();
            const mode = plan.promptMode ?? 'normal';
            if (mode === 'reject_before_commit') {
                throw new RemotePromptDomainError('prompt_failed');
            }
            if (mode === 'recorded_not_started') {
                const consumer = consumers.get(sessionId);
                if (!consumer) throw new RemotePromptDomainError('session_unavailable');
                const userMessageId = createUserMessageId();
                if (!userMessageId) {
                    throw new RemotePromptContractError('the prompt fixture created an empty user message id');
                }
                options.onFixtureEvent?.('committed');
                await consumer({
                    type: 'part_state',
                    role: 'user',
                    messageId: userMessageId,
                    partIndex: 0,
                    part: { type: 'text', text },
                    messageTimestamp: now()
                });
                return { kind: 'recorded_not_started', userMessageId };
            }

            const started = await delegate.startPrompt(sessionId, text, interactive);
            if (started.kind !== 'started' || !plan.delayPromptCompletionMs) return started;
            return {
                ...started,
                completion: started.completion.then(async (completion) => {
                    await delay(plan.delayPromptCompletionMs!);
                    return completion;
                })
            };
        }
    } as T;
}
