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

import type * as acp from '@agentclientprotocol/sdk';
import { PUBLIC_SESSION_STATE_MAX_BYTES } from '../remote-session-service/public-session.js';
import { sessionNotificationWireBytes } from './session-message-mapper.js';
import type { EncodedPublicUpdate } from './session-notification-encoder.js';

export type SubmissionState = 'accepted' | 'recorded_not_started';
export type PromptUpdateGatePhase = 'direct' | 'buffering' | 'draining' | 'stopped';

export class PromptUpdateGateError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'PromptUpdateGateError';
    }
}

interface Deferred {
    promise: Promise<void>;
    resolve(): void;
    reject(error: Error): void;
}

interface WireBatch {
    notifications: acp.SessionNotification[];
    wireBytes: number;
}

interface MarkerExpectation extends Deferred {
    messageId: string;
    state: SubmissionState;
    located: boolean;
}

function deferred(): Deferred {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isMarkerTarget(notification: acp.SessionNotification, sessionId: string, messageId: string): boolean {
    if (
        notification.sessionId !== sessionId ||
        notification.update.sessionUpdate !== 'user_message_chunk' ||
        notification.update.messageId !== messageId
    )
        return false;
    const meta = asRecord(notification.update._meta);
    const opendesk = asRecord(meta?.opendesk);
    return opendesk?.schemaVersion === 1 && opendesk.partIndex === 0;
}

function annotate(notification: acp.SessionNotification, state: SubmissionState): void {
    const meta = asRecord(notification.update._meta);
    const opendesk = asRecord(meta?.opendesk);
    if (!meta || !opendesk) throw new PromptUpdateGateError('marker target profile is missing');
    notification.update._meta = {
        ...meta,
        opendesk: { ...opendesk, submissionState: state }
    };
}

export interface PromptAnnotationWindow {
    markAndDrain(messageId: string, state: SubmissionState): Promise<void>;
    releaseUnmarked(): Promise<void>;
    abort(reason: Error): void;
}

export class PromptUpdateGate {
    private currentPhase: PromptUpdateGatePhase = 'direct';
    private queue: WireBatch[] = [];
    private queuedBytes = 0;
    private draining = false;
    private activeToken?: object;
    private expectation?: MarkerExpectation;
    private directWaiters = new Set<Deferred>();
    private fatalNotified = false;

    constructor(
        private readonly options: {
            sessionId: string;
            send(notification: acp.SessionNotification): Promise<void>;
            onFatal(error: Error): void;
        }
    ) {}

    get phase(): PromptUpdateGatePhase {
        return this.currentPhase;
    }

    get bufferedWireBytes(): number {
        return this.queuedBytes;
    }

    beginPrompt(): PromptAnnotationWindow {
        if (this.currentPhase !== 'direct' || this.activeToken) {
            throw new PromptUpdateGateError('prompt annotation window is already active');
        }
        const token = {};
        this.activeToken = token;
        this.currentPhase = 'buffering';
        return {
            markAndDrain: (messageId, state) => this.classify(token, messageId, state),
            releaseUnmarked: () => this.release(token),
            abort: (reason) => this.abortWindow(token, reason)
        };
    }

    async consume(encoded: EncodedPublicUpdate): Promise<void> {
        if (this.currentPhase === 'stopped') throw new PromptUpdateGateError('prompt update gate is stopped');
        if (this.currentPhase === 'direct') {
            try {
                for (const notification of encoded.notifications) {
                    await this.options.send(notification);
                }
                encoded.commit();
                return;
            } catch (error) {
                throw this.fatal(error, 'direct session update send failed');
            }
        }

        const notifications = encoded.notifications.map((notification) => structuredClone(notification));
        const wireBytes = notifications.reduce(
            (total, notification) => total + sessionNotificationWireBytes(notification),
            0
        );
        if (this.queuedBytes + wireBytes > PUBLIC_SESSION_STATE_MAX_BYTES) {
            throw this.fatal(new PromptUpdateGateError('prompt annotation buffer exceeds 8 MiB'), 'buffer overflow');
        }
        const batch = { notifications, wireBytes };
        this.queue.push(batch);
        this.queuedBytes += wireBytes;
        try {
            encoded.commit();
            this.locateExpectationIn(batch);
        } catch (error) {
            throw this.fatal(error, 'buffered encoder commit failed');
        }
        if (this.currentPhase === 'draining') this.startDrain();
    }

    whenDirect(): Promise<void> {
        if (this.currentPhase === 'direct') return Promise.resolve();
        if (this.currentPhase === 'stopped') {
            return Promise.reject(new PromptUpdateGateError('prompt update gate is stopped'));
        }
        const waiter = deferred();
        this.directWaiters.add(waiter);
        return waiter.promise;
    }

    stop(reason = new PromptUpdateGateError('prompt update gate stopped')): void {
        this.stopInternal(reason, false);
    }

    private classify(token: object, messageId: string, state: SubmissionState): Promise<void> {
        this.assertWindow(token);
        if (!messageId) return Promise.reject(new PromptUpdateGateError('marker message id is empty'));
        const expectation = Object.assign(deferred(), { messageId, state, located: false });
        this.expectation = expectation;
        try {
            for (const batch of this.queue) this.locateExpectationIn(batch);
        } catch (error) {
            this.fatal(error, 'marker classification failed');
            return expectation.promise;
        }
        this.currentPhase = 'draining';
        this.startDrain();
        return expectation.promise;
    }

    private release(token: object): Promise<void> {
        this.assertWindow(token);
        if (this.expectation) {
            return Promise.reject(new PromptUpdateGateError('marker classification already started'));
        }
        this.currentPhase = 'draining';
        this.startDrain();
        return this.whenDirect();
    }

    private abortWindow(token: object, reason: Error): void {
        if (this.activeToken !== token || this.currentPhase === 'stopped') return;
        this.expectation?.reject(reason);
        this.expectation = undefined;
        this.activeToken = undefined;
        this.queue = [];
        this.queuedBytes = 0;
        this.currentPhase = 'direct';
        this.resolveDirectWaiters();
    }

    private assertWindow(token: object): void {
        if (this.activeToken !== token || this.currentPhase === 'stopped') {
            throw new PromptUpdateGateError('prompt annotation window is not active');
        }
    }

    private locateExpectationIn(batch: WireBatch): void {
        const expectation = this.expectation;
        if (!expectation) return;
        for (const notification of batch.notifications) {
            if (!isMarkerTarget(notification, this.options.sessionId, expectation.messageId)) continue;
            if (expectation.located) throw new PromptUpdateGateError('duplicate marker target');
            annotate(notification, expectation.state);
            expectation.located = true;
        }
    }

    private startDrain(): void {
        if (this.draining || this.currentPhase !== 'draining') return;
        this.draining = true;
        void this.drain().then(
            () => undefined,
            (error) => this.fatal(error, 'prompt annotation drain failed')
        );
    }

    private async drain(): Promise<void> {
        try {
            while (this.currentPhase === 'draining') {
                const batch = this.queue[0];
                if (!batch) {
                    if (this.expectation && !this.expectation.located) return;
                    this.finishWindowIfPossible();
                    return;
                }
                for (const notification of batch.notifications) {
                    await this.options.send(notification);
                    if (this.currentPhase !== 'draining') return;
                    const expectation = this.expectation;
                    if (
                        expectation?.located &&
                        isMarkerTarget(notification, this.options.sessionId, expectation.messageId)
                    ) {
                        expectation.resolve();
                        this.expectation = undefined;
                    }
                }
                this.queue.shift();
                this.queuedBytes -= batch.wireBytes;
            }
        } finally {
            this.draining = false;
            if (this.currentPhase === 'draining' && this.queue.length > 0) {
                this.startDrain();
            }
        }
    }

    private finishWindowIfPossible(): void {
        if (this.queue.length > 0 || this.expectation) return;
        this.activeToken = undefined;
        this.currentPhase = 'direct';
        this.resolveDirectWaiters();
    }

    private resolveDirectWaiters(): void {
        for (const waiter of this.directWaiters) waiter.resolve();
        this.directWaiters.clear();
    }

    private fatal(error: unknown, message: string): PromptUpdateGateError {
        const failure =
            error instanceof PromptUpdateGateError ? error : new PromptUpdateGateError(message, { cause: error });
        this.stopInternal(failure, true);
        return failure;
    }

    private stopInternal(reason: Error, notifyFatal: boolean): void {
        if (this.currentPhase === 'stopped') return;
        this.currentPhase = 'stopped';
        this.queue = [];
        this.queuedBytes = 0;
        this.activeToken = undefined;
        this.expectation?.reject(reason);
        this.expectation = undefined;
        for (const waiter of this.directWaiters) waiter.reject(reason);
        this.directWaiters.clear();
        if (!notifyFatal || this.fatalNotified) return;
        this.fatalNotified = true;
        try {
            this.options.onFatal(reason);
        } catch {}
    }
}
