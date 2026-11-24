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
import type { AgentSideConnection, LoadSessionRequest, LoadSessionResponse } from '@agentclientprotocol/sdk';
import path from 'node:path';
import {
    PublicSessionProjectionError,
    type PublicSessionFailureCode
} from '../remote-session-service/public-session.js';
import {
    assertLoadParams,
    assertNewSessionParams,
    decodeModelEffortValue,
    mapRemotePromptDomainError,
    mapSessionDirectoryEntries,
    mapSessionModelConfigurationOptions,
    mobileLoadError,
    mobilePromptError,
    OPENDESK_MODEL_EFFORT_CONFIG_ID,
    SESSION_INVALIDATION_CAPABILITY,
    encodeSessionInvalidation,
    parseOpenDeskCancelProfile,
    parseAdvertisedSessionInvalidationCapability,
    parseMobilePromptText,
    type OpenDeskCancelIntent
} from './session-message-mapper.js';
import { SessionNotificationEncoder, encodeSessionSnapshot } from './session-notification-encoder.js';
import { createPublicSessionIdentifierPlan } from '../remote-session-service/public-session-identifiers.js';
import {
    RemotePromptDomainError,
    RemoteSessionConfigurationError,
    RemoteSessionCreateError,
    RemoteSessionStopError,
    isCreationCapableRemoteSessionService,
    type RemotePromptCompletion,
    type RemotePromptStart,
    type RemoteInteractionAnswerAuthorizer,
    type RemoteSessionCreated,
    type RemoteSessionCreateErrorCode,
    type RemoteSessionService
} from '../remote-session-service/service.js';
import type { InteractionDeliveryChannel } from '../../../../../aikernel/interaction/delivery.js';
import {
    INTERACTION_FAILED_TERMINAL_CAPABILITY,
    parseAdvertisedInteractionCapability,
    parseAdvertisedInteractionFailedTerminalCapability,
    type OpenDeskInteractionCapabilityV1
} from '../interaction/message-mapper.js';
import {
    MobileInteractionDeliveryEndpoint,
    type MobileInteractionFailureBoundary
} from '../interaction/delivery-endpoint.js';
import type { PublicSessionSyncHandle } from '../remote-session-service/public-session-sync.js';
import { PromptUpdateGate } from './prompt-update-gate.js';

const PC_SESSION_LOAD_DEADLINE_MS = 30_000;

function connectionAbortReason(signal: AbortSignal): Error {
    return signal.reason instanceof Error ? signal.reason : new Error('ACP connection is no longer active');
}

export type MobileAcpDiagnosticEvent =
    | { code: 'session_list_failed'; error: unknown }
    | { code: 'session_load_failed'; error: unknown }
    | { code: 'session_prompt_failed'; error: unknown }
    | { code: 'session_configuration_failed'; error: unknown }
    | { code: 'session_creation_failed'; error: unknown }
    | {
          code: 'session_cancel_ignored';
          reason: 'invalid_profile' | 'unavailable_or_unauthorized' | 'not_running' | 'stale_run';
          error?: never;
      }
    | { code: 'interaction_closed_notification_failed'; errorName: string; error?: never };

export type MobileAcpDiagnosticSink = (event: MobileAcpDiagnosticEvent) => void;

export interface MobileInteractionAgentServices {
    deliveryChannel: InteractionDeliveryChannel;
    answerAuthorizer: RemoteInteractionAnswerAuthorizer;
}

interface ActiveLoadAttempt {
    token: object;
    sessionId: string;
    abort: AbortController;
    failed: boolean;
    committed: boolean;
    disposed: boolean;
    timeout?: ReturnType<typeof setTimeout>;
    sync?: PublicSessionSyncHandle;
    encoder?: SessionNotificationEncoder;
    gate?: PromptUpdateGate;
}

interface LoadedSession {
    sessionId: string;
    sync: PublicSessionSyncHandle;
    encoder: SessionNotificationEncoder;
    gate: PromptUpdateGate;
    endpoint?: MobileInteractionDeliveryEndpoint;
    unregisterEndpoint?: () => void;
    invalidating: boolean;
    disposed: boolean;
}

export class MobileAcpSendError extends Error {
    constructor(cause: unknown) {
        super('mobile ACP send failed', {
            cause: cause instanceof Error ? cause : new Error(String(cause))
        });
        this.name = 'MobileAcpSendError';
    }
}

const LOAD_CODES = new Set<PublicSessionFailureCode>([
    'session_unavailable',
    'session_too_large',
    'session_load_failed'
]);

const SESSION_CREATION_CAPABILITY = Object.freeze({
    schemaVersion: 1 as const,
    defaultWorkspace: 1 as const
});

function creationErrorData(code: RemoteSessionCreateErrorCode): Record<string, unknown> {
    return {
        opendesk: {
            sessionCreation: {
                schemaVersion: 1,
                code,
                creationState: 'not_created'
            }
        }
    };
}

function mapCreationDomainError(error: RemoteSessionCreateError): acp.RequestError {
    return acp.RequestError.internalError(
        creationErrorData(error.code),
        error.code === 'default_workspace_unavailable' ? 'Default workspace is unavailable' : 'Unable to create session'
    );
}

function mapCreationSuccess(created: RemoteSessionCreated): acp.NewSessionResponse {
    return {
        sessionId: created.sessionId,
        _meta: {
            opendesk: {
                sessionCreation: {
                    schemaVersion: 1,
                    workspace: created.workspace
                }
            }
        }
    };
}

function settleInConnectionScope<T>(
    operation: Promise<T>,
    signal: AbortSignal,
    isCurrent: () => boolean,
    unavailable: () => Error
): Promise<T> {
    if (signal.aborted || !isCurrent()) return Promise.reject(unavailable());
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void): void => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            callback();
        };
        const onAbort = (): void => finish(() => reject(unavailable()));
        signal.addEventListener('abort', onAbort, { once: true });
        operation.then(
            (value) =>
                finish(() => {
                    if (signal.aborted || !isCurrent()) reject(unavailable());
                    else resolve(value);
                }),
            (error) => finish(() => reject(error))
        );
    });
}

export class MobileAcpAgentAdapter implements acp.Agent {
    private activeLoadAttempt?: ActiveLoadAttempt;
    private loadedSession?: LoadedSession;
    private promptInFlight = false;
    private negotiatedInteractionCapability?: OpenDeskInteractionCapabilityV1;
    private negotiatedInteractionFailedTerminalCapability = false;
    private negotiatedSessionInvalidationCapability = false;

    constructor(
        private readonly connection: AgentSideConnection,
        private readonly signal: AbortSignal,
        private readonly remoteSessionService: RemoteSessionService,
        private readonly diagnose: MobileAcpDiagnosticSink,
        private readonly failClosed: () => void,
        registerCleanup: (callback: () => void) => void,
        private readonly agentVersion = process.env.npm_package_version || 'unknown',
        private readonly loadDeadlineMs = PC_SESSION_LOAD_DEADLINE_MS,
        private readonly mobileInteractions?: MobileInteractionAgentServices
    ) {
        registerCleanup(() => this.disposeConnectionState(connectionAbortReason(this.signal)));
    }

    async initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
        this.negotiatedInteractionCapability = this.mobileInteractions
            ? parseAdvertisedInteractionCapability(params.clientCapabilities?._meta)
            : undefined;
        this.negotiatedInteractionFailedTerminalCapability = Boolean(
            this.mobileInteractions &&
            parseAdvertisedInteractionFailedTerminalCapability(params.clientCapabilities?._meta)
        );
        this.negotiatedSessionInvalidationCapability = Boolean(
            parseAdvertisedSessionInvalidationCapability(params.clientCapabilities?._meta)
        );
        const creation = isCreationCapableRemoteSessionService(this.remoteSessionService);
        const opendeskMeta = {
            ...(this.negotiatedInteractionCapability ? { interaction: this.negotiatedInteractionCapability } : {}),
            ...(this.negotiatedInteractionFailedTerminalCapability
                ? { interactionFailedTerminal: INTERACTION_FAILED_TERMINAL_CAPABILITY }
                : {}),
            ...(this.negotiatedSessionInvalidationCapability
                ? { sessionInvalidation: SESSION_INVALIDATION_CAPABILITY }
                : {}),
            ...(creation ? { sessionCreation: SESSION_CREATION_CAPABILITY } : {})
        };
        return {
            protocolVersion: acp.PROTOCOL_VERSION,
            agentInfo: {
                name: 'opendesk',
                title: 'OpenDesk',
                version: this.agentVersion
            },
            agentCapabilities: {
                loadSession: true,
                sessionCapabilities: {
                    list: {}
                },
                ...(Object.keys(opendeskMeta).length > 0 ? { _meta: { opendesk: opendeskMeta } } : {})
            },
            authMethods: []
        };
    }

    async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
        throw acp.RequestError.methodNotFound('authenticate');
    }

    async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
        this.assertConnectionActive();
        assertNewSessionParams(params);
        if (!isCreationCapableRemoteSessionService(this.remoteSessionService)) {
            throw acp.RequestError.methodNotFound('session/new');
        }
        try {
            const created = await settleInConnectionScope(
                this.remoteSessionService.createSession({ workspace: params.cwd }),
                this.signal,
                () => !this.signal.aborted,
                () => acp.RequestError.authRequired(undefined, 'connection is no longer active')
            );
            this.assertConnectionActive();
            return mapCreationSuccess(created);
        } catch (error) {
            if (error instanceof acp.RequestError) throw error;
            if (
                error instanceof RemoteSessionCreateError &&
                (error.code === 'workspace_unavailable' || error.code === 'session_not_created')
            ) {
                throw mapCreationDomainError(error);
            }
            if (this.signal.aborted) {
                throw acp.RequestError.authRequired(undefined, 'connection is no longer active');
            }
            try {
                this.diagnose({ code: 'session_creation_failed', error });
            } catch {}
            throw acp.RequestError.internalError(undefined, 'Unable to create session');
        }
    }

    async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
        let ownsPromptGate = false;

        try {
            this.assertConnectionActive();
            if (this.promptInFlight) throw mobilePromptError('prompt_in_flight');
            const text = parseMobilePromptText(params.prompt);
            const { loaded, gate } = this.requireLivePromptGate(params.sessionId);
            const window = gate.beginPrompt();
            this.promptInFlight = true;
            ownsPromptGate = true;

            let started: RemotePromptStart;
            try {
                started = await settleInConnectionScope(
                    this.remoteSessionService.startPrompt(
                        params.sessionId,
                        text,
                        this.negotiatedInteractionCapability !== undefined
                    ),
                    this.signal,
                    () => this.loadedSession === loaded && !loaded.disposed,
                    () => acp.RequestError.authRequired(undefined, 'prompt result is unavailable')
                );
            } catch (error) {
                if (error instanceof RemotePromptDomainError) {
                    await window.releaseUnmarked();
                    throw mapRemotePromptDomainError(error);
                }
                if (error instanceof acp.RequestError) {
                    window.abort(error);
                    throw error;
                }
                window.abort(error instanceof Error ? error : new Error(String(error)));
                this.reportPromptFailure(error);
                this.failClosed();
                throw acp.RequestError.authRequired(undefined, 'connection is no longer active');
            }

            if (started.kind === 'recorded_not_started') {
                try {
                    await window.markAndDrain(started.userMessageId, 'recorded_not_started');
                } catch {
                    throw acp.RequestError.authRequired(undefined, 'prompt result is unavailable');
                }
                throw mobilePromptError('prompt_recorded_not_started');
            }

            let markerDelivered = false;
            try {
                await window.markAndDrain(started.userMessageId, 'accepted');
                markerDelivered = true;
            } catch {
                // A normal Session switch can stop the bound feed while the Task keeps running.
            }

            let completion: RemotePromptCompletion;
            try {
                completion = await settleInConnectionScope(
                    started.completion,
                    this.signal,
                    () => !this.signal.aborted,
                    () => acp.RequestError.authRequired(undefined, 'connection is no longer active')
                );
            } catch (error) {
                if (error instanceof acp.RequestError) throw error;
                this.reportPromptFailure(error);
                this.failClosed();
                throw acp.RequestError.authRequired(undefined, 'connection is no longer active');
            }
            this.assertConnectionActive();
            void markerDelivered;
            return { stopReason: completion.stoppedByUser ? 'cancelled' : 'end_turn' };
        } catch (error) {
            if (error instanceof acp.RequestError) throw error;
            this.reportPromptFailure(error);
            this.failClosed();
            throw acp.RequestError.authRequired(undefined, 'connection is no longer active');
        } finally {
            if (ownsPromptGate) this.promptInFlight = false;
        }
    }

    async cancel(params: acp.CancelNotification): Promise<void> {
        if (this.signal.aborted) return;
        let intent: OpenDeskCancelIntent;
        try {
            intent = parseOpenDeskCancelProfile(params);
        } catch {
            this.reportCancelIgnored('invalid_profile');
            return;
        }
        try {
            this.assertConnectionActive();
            this.remoteSessionService.stopCurrentRun(intent.sessionId, intent.runToken);
        } catch (error) {
            this.reportCancelIgnored(
                error instanceof RemoteSessionStopError ? error.reason : 'unavailable_or_unauthorized'
            );
        }
    }

    async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
        this.assertConnectionActive();

        if (typeof params.cursor === 'string' && params.cursor.length > 0) {
            throw acp.RequestError.invalidParams(undefined, 'cursor is not supported');
        }
        const cwd = params.cwd ?? undefined;
        if (cwd !== undefined && !path.isAbsolute(cwd)) {
            throw acp.RequestError.invalidParams(undefined, 'cwd must be an absolute path');
        }

        try {
            const entries = await settleInConnectionScope(
                this.remoteSessionService.listSessions(cwd === undefined ? {} : { cwd }),
                this.signal,
                () => !this.signal.aborted,
                () => acp.RequestError.authRequired(undefined, 'connection is no longer active')
            );
            this.assertConnectionActive();
            const sessions = mapSessionDirectoryEntries(entries);
            this.assertConnectionActive();
            return { sessions };
        } catch (error) {
            if (error instanceof acp.RequestError) throw error;
            if (this.signal.aborted) {
                throw acp.RequestError.authRequired(undefined, 'connection is no longer active');
            }
            try {
                this.diagnose({ code: 'session_list_failed', error });
            } catch {
                // Diagnostic sinks must never change the sanitized protocol result.
            }
            throw acp.RequestError.internalError(undefined, 'Unable to list sessions');
        }
    }

    async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
        this.assertConnectionActive();
        assertLoadParams(params);
        if (this.activeLoadAttempt) throw mobileLoadError('session_load_failed');

        const previous = this.loadedSession;
        if (previous) {
            this.disposeLoadedSession(previous, new Error('session load replaced'));
            this.assertConnectionActive();
        }

        const attempt: ActiveLoadAttempt = {
            token: {},
            sessionId: params.sessionId,
            abort: new AbortController(),
            failed: false,
            committed: false,
            disposed: false
        };
        this.activeLoadAttempt = attempt;

        const operation = (async (): Promise<LoadSessionResponse> => {
            const begun = this.remoteSessionService.beginSessionLoad(
                params.sessionId,
                createPublicSessionIdentifierPlan
            );
            attempt.sync = begun.sync;
            attempt.encoder = new SessionNotificationEncoder(params.sessionId, begun.snapshot);
            const sync = attempt.sync;
            const encoder = attempt.encoder;
            sync.installFatalSink((error) => {
                try {
                    this.onSyncFatal(sync, error);
                } catch {
                    this.failClosed();
                }
            });

            const { notifications } = encodeSessionSnapshot(begun.snapshot);
            for (const notification of notifications) {
                this.assertLoadAttemptCurrent(attempt);
                await this.sendSessionUpdate(notification);
                this.assertLoadAttemptCurrent(attempt);
            }

            const gate = new PromptUpdateGate({
                sessionId: params.sessionId,
                send: (notification) => this.sendSessionUpdate(notification),
                onFatal: (error) => this.onSyncFatal(sync, error)
            });
            attempt.gate = gate;
            const frozen = sync.activate(async (update) => {
                this.assertSyncDeliveryCurrent(attempt, sync);
                await gate.consume(encoder.encode(update));
                this.assertSyncDeliveryCurrent(attempt, sync);
            });
            await frozen;
            this.assertLoadAttemptCurrent(attempt);

            let endpoint: MobileInteractionDeliveryEndpoint | undefined;
            let unregisterEndpoint: (() => void) | undefined;
            try {
                endpoint = this.createInteractionEndpoint(params.sessionId);
                unregisterEndpoint = endpoint
                    ? this.mobileInteractions!.deliveryChannel.registerEndpoint(endpoint)
                    : undefined;
            } catch (error) {
                unregisterEndpoint?.();
                endpoint?.dispose();
                throw error;
            }

            const loaded: LoadedSession = {
                sessionId: params.sessionId,
                sync,
                encoder,
                gate,
                ...(endpoint ? { endpoint } : {}),
                ...(unregisterEndpoint ? { unregisterEndpoint } : {}),
                invalidating: false,
                disposed: false
            };
            if (attempt.timeout) clearTimeout(attempt.timeout);
            attempt.timeout = undefined;
            attempt.committed = true;
            attempt.sync = undefined;
            attempt.encoder = undefined;
            attempt.gate = undefined;
            this.activeLoadAttempt = undefined;
            this.loadedSession = loaded;
            // Only after the load committed may a Provider re-offer the request it is still waiting on:
            // registration alone happens before this assignment, and the re-offer must never block the load.
            if (endpoint) this.mobileInteractions!.deliveryChannel.notifyEndpointReady();
            return begun.configuration
                ? { configOptions: mapSessionModelConfigurationOptions(begun.configuration) }
                : {};
        })();

        try {
            return await this.withLoadDeadline(attempt, operation);
        } catch (error) {
            this.disposeLoadAttempt(attempt, error instanceof Error ? error : new Error(String(error)));
            throw sanitizeSessionLoadError(error, this.signal, this.diagnose);
        } finally {
            void operation.catch(() => undefined);
        }
    }

    async setSessionConfigOption(
        params: acp.SetSessionConfigOptionRequest
    ): Promise<acp.SetSessionConfigOptionResponse> {
        this.assertConnectionActive();
        const loaded = this.loadedSession;
        if (
            this.activeLoadAttempt ||
            !loaded ||
            loaded.disposed ||
            loaded.sessionId !== params.sessionId ||
            loaded.sync.phase !== 'live' ||
            loaded.gate.phase === 'stopped'
        ) {
            throw acp.RequestError.invalidParams(undefined, 'session is not the active loaded session');
        }
        if (params.configId !== OPENDESK_MODEL_EFFORT_CONFIG_ID || typeof params.value !== 'string') {
            throw acp.RequestError.invalidParams(undefined, 'unsupported session configuration option');
        }
        let selection;
        try {
            selection = decodeModelEffortValue(params.value);
        } catch {
            throw acp.RequestError.invalidParams(undefined, 'invalid session configuration value');
        }

        try {
            const configuration = await settleInConnectionScope(
                Promise.resolve().then(() =>
                    this.remoteSessionService.setSessionModelConfiguration(params.sessionId, selection)
                ),
                this.signal,
                () =>
                    this.loadedSession === loaded &&
                    !loaded.disposed &&
                    loaded.sync.phase === 'live' &&
                    loaded.gate.phase !== 'stopped',
                () => acp.RequestError.authRequired(undefined, 'connection is no longer active')
            );
            return { configOptions: mapSessionModelConfigurationOptions(configuration) };
        } catch (error) {
            if (error instanceof acp.RequestError) throw error;
            const code = error instanceof RemoteSessionConfigurationError ? error.code : 'host_failure';
            if (!(error instanceof RemoteSessionConfigurationError)) {
                try {
                    this.diagnose({ code: 'session_configuration_failed', error });
                } catch {}
            }
            throw acp.RequestError.internalError(
                { opendesk: { sessionConfiguration: { schemaVersion: 1, code } } },
                'Unable to set session configuration'
            );
        }
    }

    async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
        if (method !== '_opendesk/session/default-workspace') {
            throw acp.RequestError.methodNotFound(method);
        }
        if (params === null || Object.getPrototypeOf(params) !== Object.prototype || Object.keys(params).length !== 0) {
            throw acp.RequestError.invalidParams(undefined, 'request must be an empty object');
        }
        if (!isCreationCapableRemoteSessionService(this.remoteSessionService)) {
            throw acp.RequestError.methodNotFound(method);
        }
        this.assertConnectionActive();
        try {
            const result = await settleInConnectionScope(
                this.remoteSessionService.resolveDefaultWorkspace(),
                this.signal,
                () => !this.signal.aborted,
                () => acp.RequestError.authRequired(undefined, 'connection is no longer active')
            );
            this.assertConnectionActive();
            return result;
        } catch (error) {
            if (error instanceof acp.RequestError) throw error;
            if (error instanceof RemoteSessionCreateError && error.code === 'default_workspace_unavailable') {
                throw mapCreationDomainError(error);
            }
            if (this.signal.aborted) {
                throw acp.RequestError.authRequired(undefined, 'connection is no longer active');
            }
            try {
                this.diagnose({ code: 'session_creation_failed', error });
            } catch {}
            throw acp.RequestError.internalError(undefined, 'Unable to resolve default workspace');
        }
    }

    async extNotification(method: string, params: Record<string, unknown>): Promise<void> {
        if (method !== '_opendesk/session/unsubscribe') {
            try {
                this.diagnose({ code: 'session_load_failed', error: new Error('unknown extension notification') });
            } catch {}
            return;
        }
        const keys = Object.keys(params);
        if (keys.length !== 1 || keys[0] !== 'sessionId' || typeof params.sessionId !== 'string' || !params.sessionId) {
            try {
                this.diagnose({ code: 'session_load_failed', error: new Error('invalid unsubscribe params') });
            } catch {}
            return;
        }
        const loaded = this.loadedSession;
        if (!loaded || loaded.sessionId !== params.sessionId) return;
        this.disposeLoadedSession(loaded, new Error('public session unsubscribed'));
    }

    private disposeLoadAttempt(attempt: ActiveLoadAttempt, reason: Error): void {
        if (attempt.disposed || attempt.committed) return;
        attempt.disposed = true;
        if (attempt.timeout) clearTimeout(attempt.timeout);
        attempt.timeout = undefined;
        if (!attempt.abort.signal.aborted) attempt.abort.abort(reason);
        attempt.sync?.stop(reason);
        attempt.gate?.stop(reason);
        attempt.encoder?.dispose();
        attempt.sync = undefined;
        attempt.gate = undefined;
        attempt.encoder = undefined;
        if (this.activeLoadAttempt === attempt) this.activeLoadAttempt = undefined;
    }

    private detachLoadedSessionForCleanup(loaded: LoadedSession, mode: 'dispose' | 'invalidate'): boolean {
        if (loaded.disposed || loaded.invalidating) return false;
        if (mode === 'invalidate') loaded.invalidating = true;
        loaded.disposed = true;
        if (this.loadedSession === loaded) this.loadedSession = undefined;
        return true;
    }

    private cleanupDetachedLoadedSession(
        loaded: LoadedSession,
        reason: Error,
        preserveCurrentEndpoint = false
    ): unknown {
        let firstFailure: unknown;
        const attempt = (cleanup: () => void): void => {
            try {
                cleanup();
            } catch (error) {
                firstFailure ??= error;
            }
        };

        const endpoint = preserveCurrentEndpoint ? undefined : loaded.endpoint;
        if (!preserveCurrentEndpoint) loaded.endpoint = undefined;
        const unregisterEndpoint = loaded.unregisterEndpoint;
        loaded.unregisterEndpoint = undefined;
        attempt(() => unregisterEndpoint?.());
        if (!preserveCurrentEndpoint && !this.signal.aborted) {
            attempt(() => endpoint?.dispose());
        }
        attempt(() => loaded.sync.stop(reason));
        attempt(() => loaded.gate.stop(reason));
        attempt(() => loaded.encoder.dispose());
        return firstFailure;
    }

    private disposeLoadedSession(loaded: LoadedSession, reason: Error): void {
        if (!this.detachLoadedSessionForCleanup(loaded, 'dispose')) return;
        if (this.cleanupDetachedLoadedSession(loaded, reason)) this.failClosed();
    }

    private async invalidateLoadedSession(loaded: LoadedSession): Promise<void> {
        if (!this.detachLoadedSessionForCleanup(loaded, 'invalidate')) return;
        const cleanupFailure = this.cleanupDetachedLoadedSession(loaded, new Error('loaded session invalidated'));
        if (cleanupFailure || this.signal.aborted) {
            this.failClosed();
            return;
        }
        if (!this.negotiatedSessionInvalidationCapability) {
            this.failClosed();
            return;
        }
        try {
            await this.sendSessionInvalidation(loaded.sessionId);
        } catch {
            this.failClosed();
        }
    }

    private async closeInteractionFailed(send: () => Promise<void>): Promise<void> {
        if (!this.negotiatedInteractionFailedTerminalCapability) {
            this.failClosed();
            return;
        }
        await send();
    }

    private async invalidateLoadedSessionForInteraction(
        sessionId: string,
        endpoint: MobileInteractionDeliveryEndpoint,
        sendFailed: () => Promise<void>
    ): Promise<void> {
        const loaded = this.loadedSession;
        if (
            !loaded ||
            loaded.sessionId !== sessionId ||
            loaded.endpoint !== endpoint ||
            loaded.disposed ||
            loaded.invalidating
        ) {
            this.failClosed();
            return;
        }
        if (!this.negotiatedInteractionFailedTerminalCapability) {
            this.failClosed();
            return;
        }
        if (!this.detachLoadedSessionForCleanup(loaded, 'invalidate')) {
            this.failClosed();
            return;
        }
        const cleanupFailure = this.cleanupDetachedLoadedSession(
            loaded,
            new Error('loaded session invalidated by interaction authorization'),
            true
        );
        if (cleanupFailure || this.signal.aborted) {
            this.disposePreservedInteractionEndpoint(loaded, endpoint);
            this.failClosed();
            return;
        }
        try {
            await sendFailed();
        } catch {
            this.disposePreservedInteractionEndpoint(loaded, endpoint);
            this.failClosed();
            return;
        }
        this.disposePreservedInteractionEndpoint(loaded, endpoint);
        if (!this.negotiatedSessionInvalidationCapability) {
            this.failClosed();
            return;
        }
        try {
            await this.sendSessionInvalidation(loaded.sessionId);
        } catch {
            this.failClosed();
        }
    }

    private disposePreservedInteractionEndpoint(
        loaded: LoadedSession,
        endpoint: MobileInteractionDeliveryEndpoint
    ): void {
        if (loaded.endpoint !== endpoint) return;
        loaded.endpoint = undefined;
        if (!this.signal.aborted) endpoint.dispose();
    }

    private disposeConnectionState(reason: Error): void {
        const attempt = this.activeLoadAttempt;
        const loaded = this.loadedSession;
        if (attempt) this.disposeLoadAttempt(attempt, reason);
        if (loaded) this.disposeLoadedSession(loaded, reason);
    }

    private assertLoadAttemptCurrent(attempt: ActiveLoadAttempt): void {
        this.assertConnectionActive();
        if (
            this.activeLoadAttempt !== attempt ||
            attempt.abort.signal.aborted ||
            attempt.disposed ||
            attempt.failed ||
            attempt.committed
        ) {
            throw mobileLoadError('session_load_failed');
        }
    }

    private assertSyncDeliveryCurrent(attempt: ActiveLoadAttempt, sync: PublicSessionSyncHandle): void {
        if (!attempt.committed) {
            this.assertLoadAttemptCurrent(attempt);
            return;
        }
        this.assertConnectionActive();
        const loaded = this.loadedSession;
        if (!loaded || loaded.disposed || loaded.sync !== sync) {
            throw mobileLoadError('session_load_failed');
        }
    }

    private withLoadDeadline<T>(attempt: ActiveLoadAttempt, operation: Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            let settled = false;
            const finish = (callback: () => void): void => {
                if (settled) return;
                settled = true;
                if (attempt.timeout) clearTimeout(attempt.timeout);
                attempt.timeout = undefined;
                callback();
            };
            attempt.timeout = setTimeout(() => {
                const error = mobileLoadError('session_load_failed');
                this.disposeLoadAttempt(attempt, error);
                finish(() => reject(error));
            }, this.loadDeadlineMs);
            operation.then(
                (value) => finish(() => resolve(value)),
                (error) => finish(() => reject(error))
            );
        });
    }

    private onSyncFatal(sync: PublicSessionSyncHandle, error: Error): void {
        const attempt = this.activeLoadAttempt;
        if (attempt?.sync === sync) {
            attempt.failed = true;
            this.disposeLoadAttempt(attempt, error);
            if (this.isConnectionFailure(error)) this.failClosed();
            return;
        }
        const loaded = this.loadedSession;
        if (loaded?.sync !== sync) return;
        if (this.isConnectionFailure(error)) {
            this.disposeLoadedSession(loaded, error);
            this.failClosed();
            return;
        }
        void this.invalidateLoadedSession(loaded);
    }

    private async sendSessionUpdate(notification: acp.SessionNotification): Promise<void> {
        try {
            await this.connection.sessionUpdate(notification);
        } catch (cause) {
            const error = new MobileAcpSendError(cause);
            this.failClosed();
            throw error;
        }
    }

    private async sendSessionInvalidation(sessionId: string): Promise<void> {
        const notification = encodeSessionInvalidation(sessionId);
        try {
            await this.connection.extNotification(notification.method, notification.params);
        } catch (cause) {
            const error = new MobileAcpSendError(cause);
            this.failClosed();
            throw error;
        }
    }

    private isConnectionFailure(error: unknown): boolean {
        if (this.signal.aborted) return true;
        const seen = new Set<unknown>();
        let cursor = error;
        while (cursor instanceof Error && !seen.has(cursor)) {
            if (cursor instanceof MobileAcpSendError) return true;
            seen.add(cursor);
            cursor = cursor.cause;
        }
        return false;
    }

    private createInteractionEndpoint(sessionId: string): MobileInteractionDeliveryEndpoint | undefined {
        const services = this.mobileInteractions;
        if (!services || !this.negotiatedInteractionCapability) return undefined;
        const boundary: MobileInteractionFailureBoundary = {
            sendFailed: (send) => this.closeInteractionFailed(send),
            invalidateLoadedSession: (targetSessionId, endpoint, sendFailed) =>
                this.invalidateLoadedSessionForInteraction(targetSessionId, endpoint, sendFailed),
            failConnection: () => this.failClosed()
        };
        return new MobileInteractionDeliveryEndpoint(
            sessionId,
            this.connection,
            this.signal,
            services.answerAuthorizer,
            boundary,
            (event) => this.diagnose({ code: event.type, errorName: event.errorName })
        );
    }

    private requireLivePromptGate(sessionId: string): { loaded: LoadedSession; gate: PromptUpdateGate } {
        this.assertConnectionActive();
        const loaded = this.loadedSession;
        if (
            this.activeLoadAttempt ||
            !loaded ||
            loaded.disposed ||
            loaded.sessionId !== sessionId ||
            loaded.sync.phase !== 'live' ||
            loaded.gate.phase === 'stopped'
        ) {
            throw mobilePromptError('session_not_live');
        }
        return { loaded, gate: loaded.gate };
    }

    private reportPromptFailure(error: unknown): void {
        try {
            this.diagnose({ code: 'session_prompt_failed', error });
        } catch {
            // Diagnostic sinks must never change the sanitized protocol result.
        }
    }

    private reportCancelIgnored(
        reason: Extract<MobileAcpDiagnosticEvent, { code: 'session_cancel_ignored' }>['reason']
    ): void {
        try {
            this.diagnose({ code: 'session_cancel_ignored', reason });
        } catch {
            // Diagnostics never affect notification, connection or feed lifetime.
        }
    }

    private assertConnectionActive(): void {
        if (this.signal.aborted) {
            throw acp.RequestError.authRequired(undefined, 'connection is no longer active');
        }
    }
}

function sanitizeSessionLoadError(
    error: unknown,
    signal: AbortSignal,
    diagnose: MobileAcpDiagnosticSink
): acp.RequestError {
    if (error instanceof acp.RequestError) return error;
    if (signal.aborted) {
        return acp.RequestError.authRequired(undefined, 'connection is no longer active');
    }
    if (error instanceof PublicSessionProjectionError && LOAD_CODES.has(error.code)) {
        return mobileLoadError(error.code);
    }
    try {
        diagnose({ code: 'session_load_failed', error });
    } catch {}
    return mobileLoadError('session_load_failed');
}
