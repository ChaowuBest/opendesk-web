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

import {
    RequestError,
    type AgentSideConnection,
    type RequestPermissionRequest,
    type RequestPermissionResponse
} from '@agentclientprotocol/sdk';
import type {
    AskUserResponse,
    ExitPlanModeResponse,
    InteractionTerminalStatus,
    InteractionType,
    PermissionUserResponse
} from '../../../../../aikernel/interaction/contracts.js';
import type {
    AskUserDeliveryRequest,
    ExitPlanModeDeliveryRequest,
    InteractionAnswerCallback,
    InteractionDeliveryEndpoint,
    InteractionDeliveryHandle,
    InteractionRemoteSettlement,
    PermissionDeliveryRequest
} from '../../../../../aikernel/interaction/delivery.js';
import {
    ASK_USER_METHOD,
    EXIT_PLAN_MODE_METHOD,
    INTERACTION_CLOSED_METHOD,
    InteractionProfileError,
    createPermissionToolCallId,
    toAcpPermissionOption,
    toAskUserWireRequest,
    toExitPlanModeWireRequest,
    validateAskUserAnswer,
    validateExitPlanModeAnswer,
    type InteractionClosedNotification
} from './message-mapper.js';
import {
    RemoteInteractionAuthorizationError,
    type RemoteInteractionAnswerAuthorizer
} from '../remote-session-service/service.js';

type DeliveryRequest = AskUserDeliveryRequest | ExitPlanModeDeliveryRequest | PermissionDeliveryRequest;

interface ActiveDelivery {
    requestId: string;
    type: InteractionType;
    sourceTaskId: string;
    terminalPrivilege: boolean;
    /** Idempotent exit release, so disposal and abort end the same waiting as a normal finish. */
    release?: () => void;
}

class InteractionTerminalSendError extends Error {
    constructor(cause: unknown) {
        super('Interaction terminal send failed', { cause });
        this.name = 'InteractionTerminalSendError';
    }
}

export interface MobileInteractionFailureBoundary {
    sendFailed(send: () => Promise<void>): Promise<void>;
    invalidateLoadedSession(
        sessionId: string,
        endpoint: MobileInteractionDeliveryEndpoint,
        sendFailed: () => Promise<void>
    ): Promise<void>;
    failConnection(): void;
}

function permissionOutcomeResponse(
    request: PermissionDeliveryRequest,
    result: RequestPermissionResponse
): PermissionUserResponse {
    if (!result || typeof result !== 'object' || !('outcome' in result) || !result.outcome) {
        throw new InteractionProfileError('interaction_invalid');
    }
    const outcome = result.outcome;
    if (outcome.outcome === 'cancelled') {
        const rejects = request.options.filter((option) => option.kind === 'rejectOnce');
        if (rejects.length !== 1) throw new InteractionProfileError('interaction_invalid');
        return rejects[0].response;
    }
    if (outcome.outcome !== 'selected' || typeof outcome.optionId !== 'string') {
        throw new InteractionProfileError('interaction_invalid');
    }
    const selected = request.options.find((option) => option.optionId === outcome.optionId);
    if (!selected) throw new InteractionProfileError('interaction_invalid');
    return selected.response;
}

function projectForMobileDelivery<T>(project: () => T): T | undefined {
    try {
        return project();
    } catch (error) {
        if (error instanceof InteractionProfileError) return undefined;
        throw error;
    }
}

export class MobileInteractionDeliveryEndpoint implements InteractionDeliveryEndpoint {
    private active?: ActiveDelivery;
    private disposed = false;
    private readonly abortListener = (): void => this.dispose();

    constructor(
        readonly sessionId: string,
        private readonly connection: AgentSideConnection,
        private readonly signal: AbortSignal,
        private readonly answerAuthorizer: RemoteInteractionAnswerAuthorizer,
        private readonly boundary: MobileInteractionFailureBoundary,
        private readonly diagnose: (event: {
            type: 'interaction_closed_notification_failed';
            errorName: string;
        }) => void
    ) {
        if (signal.aborted) this.disposed = true;
        else signal.addEventListener('abort', this.abortListener, { once: true });
    }

    tryDeliverAskUser(
        request: AskUserDeliveryRequest,
        answer: InteractionAnswerCallback<AskUserResponse>
    ): InteractionDeliveryHandle | undefined {
        const wire = projectForMobileDelivery(() => toAskUserWireRequest(this.sessionId, request));
        if (!wire) return undefined;
        return this.begin(
            request,
            () => this.connection.extMethod(ASK_USER_METHOD, wire),
            (value) => validateAskUserAnswer(wire, value),
            answer
        );
    }

    tryDeliverExitPlanMode(
        request: ExitPlanModeDeliveryRequest,
        answer: InteractionAnswerCallback<ExitPlanModeResponse>
    ): InteractionDeliveryHandle | undefined {
        const wire = projectForMobileDelivery(() => toExitPlanModeWireRequest(this.sessionId, request));
        if (!wire) return undefined;
        return this.begin(
            request,
            () => this.connection.extMethod(EXIT_PLAN_MODE_METHOD, wire),
            (value) => ({ action: validateExitPlanModeAnswer(wire, value).action }),
            answer
        );
    }

    tryDeliverPermission(
        request: PermissionDeliveryRequest,
        answer: InteractionAnswerCallback<PermissionUserResponse>
    ): InteractionDeliveryHandle | undefined {
        const safeLocations = request.resources.map((resource) => ({ path: resource }));
        const params: RequestPermissionRequest = {
            sessionId: this.sessionId,
            toolCall: {
                toolCallId: createPermissionToolCallId(this.sessionId, request.requestId),
                title: request.toolName,
                kind: 'other',
                status: 'pending',
                locations: safeLocations
            },
            options: request.options.map(toAcpPermissionOption),
            _meta: {
                opendesk: {
                    schemaVersion: 1,
                    interactionType: 'permission',
                    requestId: request.requestId,
                    taskId: request.sourceTaskId,
                    ...(request.taskName === undefined ? {} : { taskName: request.taskName })
                }
            }
        };
        return this.begin(
            request,
            () => this.connection.requestPermission(params),
            (value) => permissionOutcomeResponse(request, value as RequestPermissionResponse),
            answer
        );
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.signal.removeEventListener('abort', this.abortListener);
        const active = this.active;
        if (active) active.terminalPrivilege = false;
        this.active = undefined;
        // A Provider that already accepted an answer must not keep waiting on a terminal send that can
        // no longer complete: disposal and abort go through the same idempotent release as a normal finish.
        active?.release?.();
    }

    private begin<TWire, TAnswer>(
        request: DeliveryRequest,
        invoke: () => Promise<TWire>,
        projectAnswer: (value: TWire) => TAnswer,
        answer: InteractionAnswerCallback<TAnswer>
    ): InteractionDeliveryHandle | undefined {
        if (this.disposed || this.signal.aborted || this.active) return undefined;
        const active: ActiveDelivery = {
            requestId: request.requestId,
            type: request.type,
            sourceTaskId: request.sourceTaskId,
            terminalPrivilege: true
        };
        this.active = active;

        // Work the Provider deferred until this delivery stopped occupying the exit, so a queue that
        // advances inside the answer callback can actually publish its next item.
        const deferred: Array<() => void> = [];
        let released = false;
        const runResume = (resume: () => void): void => {
            try {
                resume();
            } catch (error) {
                this.reportSafely(error);
            }
        };
        const settlement: InteractionRemoteSettlement = {
            afterRemoteClose: (resume) => {
                // A Provider may register only after an await (TUI mode switching): once the exit is
                // already free there is nothing left to wait for, so run it now instead of queueing
                // it into an array that will never be drained again. Still exactly once per resume.
                if (released) {
                    runResume(resume);
                    return;
                }
                deferred.push(resume);
            }
        };
        const releaseExit = (): void => {
            if (released) return;
            released = true;
            if (this.active === active) this.active = undefined;
            // Failed terminals, lost connections and disposal must also release the Provider, never
            // hang its queue.
            while (deferred.length > 0) {
                runResume(deferred.shift()!);
            }
        };
        active.release = releaseExit;

        const sendTerminal = async (status: InteractionTerminalStatus): Promise<void> => {
            if (!active.terminalPrivilege || this.active !== active) return;
            active.terminalPrivilege = false;
            const payload: InteractionClosedNotification = {
                schemaVersion: 1,
                requestId: request.requestId,
                sessionId: this.sessionId,
                interactionType: request.type,
                status
            };
            try {
                await this.connection.extNotification(INTERACTION_CLOSED_METHOD, payload);
            } catch (error) {
                this.reportSafely(error);
                this.boundary.failConnection();
                throw new InteractionTerminalSendError(error);
            }
        };

        const run = async (): Promise<void> => {
            let wire: TWire;
            try {
                wire = await invoke();
            } catch (error) {
                if (this.isWithdrawn(active)) return;
                if (error instanceof RequestError && !this.signal.aborted) return;
                this.boundary.failConnection();
                return;
            }
            if (this.isWithdrawn(active)) return;

            let projected: TAnswer;
            try {
                projected = projectAnswer(wire);
            } catch (error) {
                if (error instanceof InteractionProfileError) {
                    await this.boundary.sendFailed(() => sendTerminal('failed'));
                } else {
                    this.boundary.failConnection();
                }
                return;
            }
            if (this.isWithdrawn(active)) return;

            try {
                this.answerAuthorizer.authorizeInteractionAnswer(request.sourceTaskId, this.sessionId);
            } catch (error) {
                if (error instanceof RemoteInteractionAuthorizationError) {
                    if (error.code === 'interaction_invalid') {
                        await this.boundary.sendFailed(() => sendTerminal('failed'));
                    } else {
                        await this.boundary.invalidateLoadedSession(this.sessionId, this, () => sendTerminal('failed'));
                    }
                } else {
                    this.boundary.failConnection();
                }
                return;
            }
            if (this.isWithdrawn(active)) return;

            let accepted: boolean;
            try {
                accepted = answer(projected, settlement);
            } catch (error) {
                this.reportSafely(error);
                this.boundary.failConnection();
                return;
            }
            await sendTerminal(accepted ? 'accepted' : 'superseded');
        };

        void run()
            .catch((error) => {
                if (error instanceof InteractionTerminalSendError) return;
                this.reportSafely(error);
                this.boundary.failConnection();
            })
            .finally(releaseExit);

        let deliveryClosed = false;
        return {
            delivered: true,
            close: (status) => {
                if (deliveryClosed) return;
                deliveryClosed = true;
                if (this.disposed || this.signal.aborted) return;
                if (this.active !== active) return;
                void sendTerminal(status).catch((error) => {
                    if (!(error instanceof InteractionTerminalSendError)) this.reportSafely(error);
                });
                releaseExit();
            }
        };
    }

    private isWithdrawn(active: ActiveDelivery): boolean {
        return this.disposed || this.signal.aborted || this.active !== active || !active.terminalPrivilege;
    }

    private reportSafely(error: unknown): void {
        try {
            this.diagnose({
                type: 'interaction_closed_notification_failed',
                errorName: error instanceof Error ? error.name : 'UnknownError'
            });
        } catch {
            // Diagnostic sinks never decide interaction or Connection lifetime.
        }
    }
}
