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

import type {
    AskUserRequest,
    AskUserResponse,
    ExitPlanModeResponse,
    InteractionTerminalStatus,
    PermissionUserResponse
} from './contracts.js';

export type InteractionSessionScopeResolver = (sourceTaskId: string) => string | undefined;

export interface InteractionDeliveryRuntime {
    scopeResolver: InteractionSessionScopeResolver;
    deliveryChannel: InteractionDeliveryChannel;
}

export function createInteractionDeliveryRuntime(
    resolveSessionScope: InteractionSessionScopeResolver
): InteractionDeliveryRuntime {
    return {
        scopeResolver: resolveSessionScope,
        deliveryChannel: new InteractionDeliveryChannel(resolveSessionScope)
    };
}

export interface InteractionDeliveryContext {
    requestId: string;
    sourceTaskId: string;
    taskName?: string;
    expiresAt?: number;
}

export interface AskUserDeliveryRequest extends InteractionDeliveryContext {
    type: 'askUser';
    request: AskUserRequest;
}

export interface ExitPlanModeDeliveryRequest extends InteractionDeliveryContext {
    type: 'exitPlanMode';
    planContent: string;
    planRelativePath: string;
}

export interface PermissionDeliveryOption {
    optionId: string;
    kind: 'allowOnce' | 'allowAlwaysPrefix' | 'allowAlwaysType' | 'rejectOnce';
    label: string;
    prefix?: string;
    response: PermissionUserResponse;
}

export interface PermissionDeliveryRequest extends InteractionDeliveryContext {
    type: 'permission';
    toolName: string;
    resources: readonly string[];
    options: readonly PermissionDeliveryOption[];
}

export interface InteractionDeliveryHandle {
    readonly delivered: true;
    close(status: InteractionTerminalStatus): void;
}

/**
 * Lets a Provider postpone work that must not run while the remote exit is still occupied by the
 * request being answered. Without it a queue that advances inside the answer callback publishes the
 * next item into a busy endpoint and loses it. Endpoints that cannot occupy an exit omit it, and the
 * Provider then continues immediately as before.
 */
export interface InteractionRemoteSettlement {
    afterRemoteClose(resume: () => void): void;
}

export type InteractionAnswerCallback<TAnswer> = (answer: TAnswer, settlement?: InteractionRemoteSettlement) => boolean;

export interface InteractionDeliveryEndpoint {
    readonly sessionId: string;
    tryDeliverAskUser(
        request: AskUserDeliveryRequest,
        answer: InteractionAnswerCallback<AskUserResponse>
    ): InteractionDeliveryHandle | undefined;
    tryDeliverExitPlanMode(
        request: ExitPlanModeDeliveryRequest,
        answer: InteractionAnswerCallback<ExitPlanModeResponse>
    ): InteractionDeliveryHandle | undefined;
    tryDeliverPermission(
        request: PermissionDeliveryRequest,
        answer: InteractionAnswerCallback<PermissionUserResponse>
    ): InteractionDeliveryHandle | undefined;
}

export class InteractionDeliveryChannel {
    private registration?: {
        generation: number;
        endpoint: InteractionDeliveryEndpoint;
    };
    private generation = 0;
    private readonly readyListeners = new Set<(generation: number) => void>();

    constructor(private readonly resolveSessionScope: InteractionSessionScopeResolver) {}

    /** Identifies the currently registered endpoint so a Provider can tell a re-offer from a repeat. */
    get endpointGeneration(): number | undefined {
        return this.registration?.generation;
    }

    /**
     * Providers subscribe to re-offer a request they are still waiting on to a newly ready endpoint.
     * The channel keeps no business pending of its own; each Provider stays the only authority.
     */
    subscribeEndpointReady(listener: (generation: number) => void): () => void {
        this.readyListeners.add(listener);
        return () => {
            this.readyListeners.delete(listener);
        };
    }

    /** Called once a loaded Session committed its endpoint, never during registration. */
    notifyEndpointReady(): void {
        const generation = this.registration?.generation;
        if (generation === undefined) return;
        for (const listener of [...this.readyListeners]) {
            if (this.registration?.generation !== generation) return;
            try {
                listener(generation);
            } catch {
                // A Provider's re-offer must never hide the endpoint from the other Providers, and
                // never fail the session load that announces readiness right after committing.
            }
        }
    }

    registerEndpoint(endpoint: InteractionDeliveryEndpoint): () => void {
        const generation = ++this.generation;
        this.registration = { generation, endpoint };
        return () => {
            if (this.registration?.generation === generation) {
                this.registration = undefined;
            }
        };
    }

    publishAskUser(
        request: AskUserDeliveryRequest,
        answer: InteractionAnswerCallback<AskUserResponse>
    ): InteractionDeliveryHandle | undefined {
        return this.publish(request.sourceTaskId, (endpoint) => endpoint.tryDeliverAskUser(request, answer));
    }

    publishExitPlanMode(
        request: ExitPlanModeDeliveryRequest,
        answer: InteractionAnswerCallback<ExitPlanModeResponse>
    ): InteractionDeliveryHandle | undefined {
        return this.publish(request.sourceTaskId, (endpoint) => endpoint.tryDeliverExitPlanMode(request, answer));
    }

    publishPermission(
        request: PermissionDeliveryRequest,
        answer: InteractionAnswerCallback<PermissionUserResponse>
    ): InteractionDeliveryHandle | undefined {
        return this.publish(request.sourceTaskId, (endpoint) => endpoint.tryDeliverPermission(request, answer));
    }

    private publish<T>(
        sourceTaskId: string,
        deliver: (endpoint: InteractionDeliveryEndpoint) => T | undefined
    ): T | undefined {
        const sessionId = this.resolveSessionScope(sourceTaskId);
        const registration = this.registration;
        if (!sessionId || !registration || registration.endpoint.sessionId !== sessionId) {
            return undefined;
        }
        return deliver(registration.endpoint);
    }
}
