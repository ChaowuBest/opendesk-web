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

import { createHash, randomUUID } from 'node:crypto';
import {
    PUBLIC_SESSION_STATE_MAX_BYTES,
    PublicSessionProjectionError,
    applyPublicSessionUpdate,
    canUpdateToolName,
    utf8Bytes,
    type PublicAssistantMessage,
    type PublicAssistantPart,
    type PublicSessionLoadedInfo,
    type PublicSessionState,
    type PublicSessionUpdate,
    type PublicUserMessage,
    type PublicUserPart
} from './public-session.js';
import type { PublicSessionIdentifierPlan } from './public-session-identifiers.js';
import type { TaskUpdateChunk } from './session-projector.js';

export type PublicSessionSyncPhase = 'buffering' | 'live' | 'stopped';

export interface PublicSessionSyncHandle {
    readonly sessionId: string;
    readonly phase: PublicSessionSyncPhase;
    installFatalSink(sink: (error: Error) => void): void;
    activate(consumer: (update: PublicSessionUpdate) => Promise<void>): Promise<void>;
    stop(reason?: Error): void;
}

export interface RemoteTaskUpdateSubscriber {
    readonly subscription_id: string;
    readonly wantsHtmlRender: false;
    isAvailable(): boolean;
    send(chunk: TaskUpdateChunk): void;
}

export interface RemoteTaskManagerSubscriber {
    readonly subscription_id: string;
    isAvailable(): boolean;
    send(taskList: readonly object[]): void;
}

export interface PublicSessionSyncDependencies {
    subscribeTask(subscriber: RemoteTaskUpdateSubscriber): () => void;
    subscribeTaskManager(subscriber: RemoteTaskManagerSubscriber): () => void;
    projectChunk(chunk: TaskUpdateChunk, identity: PublicSessionIdentifierPlan): PublicSessionUpdate | undefined;
    projectInfo(): PublicSessionLoadedInfo;
    assertStillAuthorized(): void;
    projectAuthoritativeState(identity: PublicSessionIdentifierPlan): PublicSessionState;
}

export interface PublicSessionSyncSetup {
    handle: PublicSessionSyncHandle;
    initializeT0(state: PublicSessionState, identity: PublicSessionIdentifierPlan): void;
}

interface QueueItem {
    update: PublicSessionUpdate;
    bytes: number;
    frozen: boolean;
}

interface PublicToolShape {
    toolCallId: string;
    toolName: string;
    digest: string;
}

interface PublicPartShape {
    type: PublicUserPart['type'] | PublicAssistantPart['type'];
    digest: string;
    tools?: PublicToolShape[];
}

interface PublicMessageShape {
    role: 'user' | 'assistant';
    messageId: string;
    timestamp?: number;
    parts: PublicPartShape[];
}

interface PublicSessionShape {
    infoDigest: string;
    messages: Array<PublicMessageShape | { role: 'compact_boundary' }>;
}

function digest(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function digestInfo(info: PublicSessionLoadedInfo): string {
    return digest({
        title: info.title,
        cwd: info.cwd,
        updatedAt: info.updatedAt,
        taskStatus: info.taskStatus,
        completionStatus: info.completionStatus,
        runToken: info.runToken
    });
}

function shapePart(part: PublicUserPart | PublicAssistantPart): PublicPartShape {
    if (part.type !== 'tool_call') return { type: part.type, digest: digest(part) };
    return {
        type: 'tool_call',
        digest: digest(part),
        tools: part.toolCalls.map((call) => ({
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            digest: digest(call)
        }))
    };
}

function shapeMessage(message: PublicUserMessage | PublicAssistantMessage): PublicMessageShape {
    return {
        role: message.role,
        messageId: message.messageId,
        ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
        parts: message.parts.map(shapePart)
    };
}

function assertUnique(shape: PublicSessionShape): void {
    const messageIds = new Set<string>();
    const toolIds = new Set<string>();
    for (const message of shape.messages) {
        if (message.role === 'compact_boundary') continue;
        if (messageIds.has(message.messageId)) {
            throw new PublicSessionProjectionError('session_load_failed', 'duplicate live message identity');
        }
        messageIds.add(message.messageId);
        for (const part of message.parts) {
            for (const tool of part.tools ?? []) {
                if (toolIds.has(tool.toolCallId)) {
                    throw new PublicSessionProjectionError('session_load_failed', 'duplicate live tool identity');
                }
                toolIds.add(tool.toolCallId);
            }
        }
    }
}

function shapeFromState(state: PublicSessionState): PublicSessionShape {
    const shape: PublicSessionShape = {
        infoDigest: digestInfo(state),
        messages: state.history.messages.map((message) =>
            message.role === 'compact_boundary' ? { role: 'compact_boundary' } : shapeMessage(message)
        )
    };
    assertUnique(shape);
    return shape;
}

// 只服务于 settleObservation 的权威一致性校验，随该校验一并注释。
// function messagesWithoutAssistantTimestamps(messages: PublicSessionShape['messages']): PublicSessionShape['messages'] {
//     return messages.map((message) => {
//         if (message.role !== 'assistant') return message;
//         const { timestamp: _timestamp, ...withoutTimestamp } = message;
//         return withoutTimestamp;
//     });
// }

function assertToolContinuity(previous: PublicPartShape, next: PublicPartShape): void {
    if (previous.type !== 'tool_call' || next.type !== 'tool_call') return;
    const oldTools = previous.tools ?? [];
    const nextTools = next.tools ?? [];
    if (nextTools.length < oldTools.length) {
        throw new PublicSessionProjectionError('session_load_failed', 'normal live update deleted tool calls');
    }
    oldTools.forEach((oldTool, index) => {
        const nextTool = nextTools[index];
        if (
            !nextTool ||
            nextTool.toolCallId !== oldTool.toolCallId ||
            !canUpdateToolName(oldTool.toolName, nextTool.toolName)
        ) {
            throw new PublicSessionProjectionError('session_load_failed', 'normal live tool identity changed');
        }
    });
}

function applyShape(
    current: PublicSessionShape,
    update: PublicSessionUpdate
): { shape: PublicSessionShape; changed: boolean } {
    if (update.type === 'session_info_replace') {
        const infoDigest = digestInfo(update.info);
        return infoDigest === current.infoDigest
            ? { shape: current, changed: false }
            : { shape: { ...current, infoDigest }, changed: true };
    }
    if (update.type === 'assistant_timestamp_state') {
        if (!Number.isFinite(update.timestamp)) {
            throw new PublicSessionProjectionError('session_load_failed', 'assistant timestamp is invalid');
        }
        const index = current.messages.findIndex(
            (message) => message.role !== 'compact_boundary' && message.messageId === update.messageId
        );
        if (index < 0) {
            throw new PublicSessionProjectionError('session_load_failed', 'assistant timestamp target is missing');
        }
        const previous = current.messages[index];
        if (previous.role !== 'assistant') {
            throw new PublicSessionProjectionError('session_load_failed', 'assistant timestamp target role changed');
        }
        if (previous.timestamp === update.timestamp) return { shape: current, changed: false };
        const messages = [...current.messages];
        messages[index] = {
            role: 'assistant',
            messageId: previous.messageId,
            timestamp: update.timestamp,
            parts: previous.parts
        };
        return { shape: { ...current, messages }, changed: true };
    }
    if (update.type === 'message_replace') {
        const index = current.messages.findIndex(
            (message) => message.role !== 'compact_boundary' && message.messageId === update.message.messageId
        );
        if (index < 0)
            throw new PublicSessionProjectionError('session_load_failed', 'live replacement target is missing');
        const previous = current.messages[index];
        if (previous.role === 'compact_boundary' || previous.role !== update.message.role) {
            throw new PublicSessionProjectionError('session_load_failed', 'live replacement role changed');
        }
        const replacement = shapeMessage(update.message);
        if (digest(previous) === digest(replacement)) return { shape: current, changed: false };
        const messages = [...current.messages];
        messages[index] = replacement;
        const shape = { ...current, messages };
        assertUnique(shape);
        return { shape, changed: true };
    }
    const index = current.messages.findIndex(
        (message) => message.role !== 'compact_boundary' && message.messageId === update.messageId
    );
    const part = shapePart(update.part);
    if (index < 0) {
        if (update.partIndex !== 0)
            throw new PublicSessionProjectionError('session_load_failed', 'new live message has a part hole');
        if (update.role === 'user' && update.messageTimestamp === undefined) {
            throw new PublicSessionProjectionError('session_load_failed', 'new live user timestamp is missing');
        }
        const message: PublicMessageShape = {
            role: update.role,
            messageId: update.messageId,
            ...(update.messageTimestamp === undefined ? {} : { timestamp: update.messageTimestamp }),
            parts: [part]
        };
        const shape = { ...current, messages: [...current.messages, message] };
        assertUnique(shape);
        return { shape, changed: true };
    }
    const previous = current.messages[index];
    if (previous.role === 'compact_boundary' || previous.role !== update.role) {
        throw new PublicSessionProjectionError('session_load_failed', 'normal live role changed');
    }
    if (update.messageTimestamp !== undefined && update.messageTimestamp !== previous.timestamp) {
        throw new PublicSessionProjectionError('session_load_failed', 'normal live timestamp changed');
    }
    if (update.partIndex > previous.parts.length) {
        throw new PublicSessionProjectionError('session_load_failed', 'normal live part has a hole');
    }
    const parts = [...previous.parts];
    if (update.partIndex === parts.length) {
        parts.push(part);
    } else {
        const oldPart = parts[update.partIndex];
        if (oldPart.type !== part.type) {
            throw new PublicSessionProjectionError('session_load_failed', 'normal live part type changed');
        }
        assertToolContinuity(oldPart, part);
        if (oldPart.digest === part.digest) return { shape: current, changed: false };
        parts[update.partIndex] = part;
    }
    const messages = [...current.messages];
    messages[index] = { ...previous, parts };
    const shape = { ...current, messages };
    assertUnique(shape);
    return { shape, changed: true };
}

export function createPublicSessionSync(
    sessionId: string,
    dependencies: PublicSessionSyncDependencies
): PublicSessionSyncSetup {
    let phase: PublicSessionSyncPhase = 'buffering';
    let boundaryOpen = false;
    let identity: PublicSessionIdentifierPlan | undefined;
    let pending: PublicSessionUpdate[] = [];
    let pendingBytes = 0;
    let pendingState: PublicSessionState | undefined;
    let shape: PublicSessionShape | undefined;
    let consumer: ((update: PublicSessionUpdate) => Promise<void>) | undefined;
    let queue: QueueItem[] = [];
    let queuedBytes = 0;
    let pumping = false;
    let observing = false;
    let current: QueueItem | undefined;
    let frozenRemaining = 0;
    let frozenResolve: (() => void) | undefined;
    let frozenReject: ((error: Error) => void) | undefined;
    let fatalSink: ((error: Error) => void) | undefined;
    let fatalNotified = false;
    let removeTask: (() => void) | undefined;
    let removeManager: (() => void) | undefined;
    let lastInfo: PublicSessionLoadedInfo | undefined;

    const removeObservers = (): void => {
        removeTask?.();
        removeManager?.();
        removeTask = undefined;
        removeManager = undefined;
    };

    const stop = (reason = new Error('public session sync stopped')): void => {
        if (phase === 'stopped') return;
        phase = 'stopped';
        removeObservers();
        pending = [];
        pendingBytes = 0;
        pendingState = undefined;
        queue = [];
        queuedBytes = 0;
        consumer = undefined;
        identity = undefined;
        shape = undefined;
        lastInfo = undefined;
        boundaryOpen = false;
        observing = false;
        current = undefined;
        frozenReject?.(reason);
        frozenResolve = undefined;
        frozenReject = undefined;
        frozenRemaining = 0;
    };

    const fatal = (error: unknown): void => {
        if (phase === 'stopped') return;
        const failure = error instanceof Error ? error : new Error(String(error));
        const sink = fatalSink;
        fatalSink = undefined;
        stop(failure);
        if (fatalNotified) return;
        fatalNotified = true;
        try {
            sink?.(failure);
        } catch {}
    };

    const pump = (): void => {
        if (pumping || observing || phase === 'stopped' || !consumer) return;
        const item = queue.shift();
        if (!item) return;
        queuedBytes -= item.bytes;
        current = item;
        pumping = true;
        void consumer(item.update).then(
            () => {
                current = undefined;
                pumping = false;
                if (item.frozen && frozenRemaining > 0) {
                    frozenRemaining -= 1;
                    if (frozenRemaining === 0) {
                        frozenResolve?.();
                        frozenResolve = undefined;
                        frozenReject = undefined;
                    }
                }
                pump();
            },
            (error) => {
                current = undefined;
                pumping = false;
                fatal(error);
            }
        );
    };

    const queueLive = (update: PublicSessionUpdate, frozen: boolean): void => {
        const tail = queue[queue.length - 1];
        // These are complete part snapshots, not deltas. Only replace an unsent adjacent
        // text snapshot; frozen replay, message/tool boundaries and terminal info retain order.
        const previous = tail?.update;
        const replace =
            !frozen &&
            tail &&
            !tail.frozen &&
            update.type === 'part_state' &&
            update.role === 'assistant' &&
            update.part.type === 'text' &&
            previous?.type === 'part_state' &&
            previous.role === 'assistant' &&
            previous.part.type === 'text' &&
            previous.messageId === update.messageId &&
            previous.partIndex === update.partIndex;
        const next = replace
            ? {
                  ...update,
                  ...(previous.messageTimestamp === undefined ? {} : { messageTimestamp: previous.messageTimestamp })
              }
            : update;
        const bytes = utf8Bytes(JSON.stringify(next));
        const nextBytes = queuedBytes + bytes - (replace ? tail.bytes : 0);
        if (nextBytes > PUBLIC_SESSION_STATE_MAX_BYTES) {
            throw new PublicSessionProjectionError('session_load_failed', 'public session sync backlog exceeds limit');
        }
        if (replace) queue[queue.length - 1] = { update: next, bytes, frozen };
        else queue.push({ update: next, bytes, frozen });
        queuedBytes = nextBytes;
        pump();
    };

    const accept = (update: PublicSessionUpdate): void => {
        if (phase === 'stopped') return;
        if (!shape) throw new Error('feed shape is not initialized');
        const shaped = applyShape(shape, update);
        if (!shaped.changed) return;
        if (phase === 'buffering') {
            if (!boundaryOpen || !pendingState) return;
            const bytes = utf8Bytes(JSON.stringify(update));
            if (pendingBytes + bytes > PUBLIC_SESSION_STATE_MAX_BYTES) {
                throw new PublicSessionProjectionError('session_load_failed', 'pending feed backlog exceeds limit');
            }
            pendingState = applyPublicSessionUpdate(pendingState, update);
            pending.push(update);
            pendingBytes += bytes;
            shape = shaped.shape;
            return;
        }
        queueLive(update, false);
        shape = shaped.shape;
    };

    const compareInfo = (info: PublicSessionLoadedInfo): void => {
        if (!lastInfo || JSON.stringify(info) !== JSON.stringify(lastInfo)) {
            lastInfo = info;
            accept({ type: 'session_info_replace', info });
        }
    };

    // 权威一致性校验的另一半，随 settleObservation 一并注释。
    // const assertContinuity = (): void => {
    //     if (!identity || !shape) throw new Error('feed continuity state is not initialized');
    //     const authoritative = shapeFromState(dependencies.projectAuthoritativeState(identity));
    //     if (JSON.stringify(authoritative) !== JSON.stringify(shape)) {
    //         throw new PublicSessionProjectionError(
    //             'session_load_failed',
    //             'observed updates do not reproduce authoritative public state'
    //         );
    //     }
    // };

    const settleObservation = (info: PublicSessionLoadedInfo): void => {
        // 第一版先不做权威一致性校验。
        //
        // 原本在任务进入终态（stopped / failed）时，会把"增量推给手机的会话"和"权威会话快照"
        // 逐字节比对，任何一点对不上就抛错，进而作废整个已加载会话，手机上表现为"实时连接已中断"、
        // 必须点重新加载。但推送侧存在结构性盲区：空的模型消息不推（tasks.ts sendSubscriptionFeedback
        // 在 content 为空时直接返回）、compact 分隔消息不推、不是最后一条的消息被改动不推、流被打断后
        // finally 里的收尾改动之后不再推。并且"进入终态"不只是用户点停止，发新消息打断上一轮
        // （interruptForNewMessage）也会先把状态置为 stopped。因此只要一轮里发生过一次"权威改了但没推"，
        // 下一次进入终态就会作废会话。
        //
        // 期望的行为是：点停止只停止当前任务，会话保持可用、可以直接发下一条，无需重新加载。
        // 展示内容可能与电脑有细微出入且不再自动发现，重新进入会话即可对齐；任务状态、runToken、
        // 完成状态仍由下面的 compareInfo 照常推送，操作资格不受影响。
        //
        // if (info.taskStatus !== 'stopped' && info.taskStatus !== 'failed') {
        //     compareInfo(info);
        //     return;
        // }
        // if (!identity || !shape) throw new Error('feed continuity state is not initialized');
        // const authoritative = shapeFromState(dependencies.projectAuthoritativeState(identity));
        // if (
        //     JSON.stringify(messagesWithoutAssistantTimestamps(authoritative.messages)) !==
        //     JSON.stringify(messagesWithoutAssistantTimestamps(shape.messages))
        // ) {
        //     throw new PublicSessionProjectionError(
        //         'session_load_failed',
        //         'terminal public content did not converge before assistant timestamps'
        //     );
        // }
        // authoritative.messages.forEach((message, index) => {
        //     if (message.role !== 'assistant') return;
        //     const currentMessage = shape!.messages[index];
        //     if (currentMessage.role !== 'assistant' || currentMessage.timestamp === message.timestamp) return;
        //     if (message.timestamp === undefined) {
        //         throw new PublicSessionProjectionError(
        //             'session_load_failed',
        //             'authoritative assistant timestamp was removed'
        //         );
        //     }
        //     accept({
        //         type: 'assistant_timestamp_state',
        //         messageId: message.messageId,
        //         timestamp: message.timestamp
        //     });
        // });
        compareInfo(info);
        // assertContinuity();
    };

    const observe = (body: () => void): void => {
        if (observing) throw new Error('nested feed observation');
        observing = true;
        try {
            body();
            observing = false;
            pump();
        } catch (error) {
            observing = false;
            fatal(error);
        }
    };

    const taskSubscriber: RemoteTaskUpdateSubscriber = {
        subscription_id: randomUUID(),
        wantsHtmlRender: false,
        isAvailable: () => phase !== 'stopped',
        send(chunk) {
            if (phase === 'stopped' || !boundaryOpen || !identity || chunk.task_id !== sessionId) return;
            observe(() => {
                const update = dependencies.projectChunk(chunk, identity!);
                if (update) accept(update);
                settleObservation(dependencies.projectInfo());
            });
        }
    };

    const managerSubscriber: RemoteTaskManagerSubscriber = {
        subscription_id: randomUUID(),
        isAvailable: () => phase !== 'stopped',
        send() {
            if (phase === 'stopped' || !boundaryOpen) return;
            observe(() => {
                dependencies.assertStillAuthorized();
                const info = dependencies.projectInfo();
                if (info.taskStatus === 'stopped') {
                    // TaskManager only proves Session metadata changed. During an active turn,
                    // the core stop path may publish this stopped summary before the Task content
                    // channel publishes the interrupted ToolCall. Apply the authoritative info
                    // now, but leave message continuity to each subsequent Task observation,
                    // which projects its concrete chunk before performing the full comparison.
                    compareInfo(info);
                    return;
                }
                settleObservation(info);
            });
        }
    };

    removeTask = dependencies.subscribeTask(taskSubscriber);
    removeManager = dependencies.subscribeTaskManager(managerSubscriber);

    const handle: PublicSessionSyncHandle = {
        sessionId,
        get phase() {
            return phase;
        },
        installFatalSink(sink) {
            if (fatalSink) throw new Error('fatal sink already installed');
            fatalSink = sink;
        },
        activate(nextConsumer) {
            if (phase !== 'buffering' || consumer) return Promise.reject(new Error('feed cannot be activated'));
            consumer = nextConsumer;
            const frozen = pending;
            pending = [];
            pendingBytes = 0;
            pendingState = undefined;
            phase = 'live';
            frozenRemaining = frozen.length;
            const result = new Promise<void>((resolve, reject) => {
                frozenResolve = resolve;
                frozenReject = reject;
            });
            for (const update of frozen) queueLive(update, true);
            if (frozenRemaining === 0) {
                frozenResolve?.();
                frozenResolve = undefined;
                frozenReject = undefined;
            }
            pump();
            return result;
        },
        stop
    };

    return {
        handle,
        initializeT0(state, nextIdentity) {
            if (phase !== 'buffering' || boundaryOpen) throw new Error('feed T0 already initialized');
            identity = nextIdentity;
            pendingState = state;
            shape = shapeFromState(state);
            lastInfo = {
                title: state.title,
                cwd: state.cwd,
                updatedAt: state.updatedAt,
                taskStatus: state.taskStatus,
                completionStatus: state.completionStatus,
                runToken: state.runToken
            };
            boundaryOpen = true;
        }
    };
}
