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

import type { InteractionDeliveryRuntime } from '../../../../aikernel/interaction/delivery.js';
import { MobileAcpAgentAdapter } from './acp-endpoint/agent-adapter.js';
import { MobileAcpConnectionHost, type HostedAcpConnection } from './acp-endpoint/connection-host.js';
import {
    readHostSessionModelConfiguration,
    setHostSessionModelConfiguration,
    type HostSessionConfigurableTask,
    type HostSessionModelSource,
    type HostSessionTaskCreationInput,
    type HostSessionTaskCreationResult
} from './remote-session-service/host-binding.js';
import type {
    RemoteTaskManagerSubscriber,
    RemoteTaskUpdateSubscriber
} from './remote-session-service/public-session-sync.js';
import type { LoadedPublicSessionTask, RemoteSessionTaskEntry } from './remote-session-service/session-projector.js';
import {
    createRemoteSessionService,
    type InteractionCapableRemoteSessionService,
    type RemoteInteractionAnswerAuthorizer,
    type RemoteSessionCreationService,
    type RemoteSessionService
} from './remote-session-service/service.js';
import { AcpConnectionClosedError, type AcpMessageChannel } from './transport/acp-message-stream.js';

/** Lifecycle scopes the composition reports under; the network provider owns its own diagnostics. */
export type MobileHostCompositionDiagnosticScope = 'rss' | 'adapter' | 'composition';

/**
 * Host-agnostic capabilities the composition binds into one base Remote Session Service.
 * `createSessionTask` is optional so a read-only directory can be hosted; a real host must provide it.
 */
export interface MobileHostCapabilities {
    getTaskList(): readonly RemoteSessionTaskEntry[];
    getTaskLoadResult(sessionId: string): { task: HostSessionConfigurableTask | undefined; corrupted: boolean };
    getDefaultWorkspace(): string;
    createSessionTask?(input: HostSessionTaskCreationInput): Promise<HostSessionTaskCreationResult>;
    subscribeTaskUpdates(task: LoadedPublicSessionTask, subscriber: RemoteTaskUpdateSubscriber): () => void;
    subscribeTaskManagerUpdates(subscriber: RemoteTaskManagerSubscriber): () => void;
    sessionModelSource: HostSessionModelSource;
    publishTaskListUpdate?(): void;
}

export interface MobileHostNetworkHandle {
    close(): Promise<void>;
}

/**
 * Pre-configured network start capability. The provider owns transport addresses, eligibility and health;
 * it delivers already established channels plus their trusted context through `openConnection`.
 */
export type StartMobileNetwork<TTrustedContext extends object> = (input: {
    signal: AbortSignal;
    openConnection(channel: AcpMessageChannel, trustedContext: TTrustedContext): HostedAcpConnection;
}) => Promise<MobileHostNetworkHandle>;

/** Per-connection service view; optional capabilities declare what that view supports. */
export type MobileConnectionServiceView = RemoteSessionService &
    Partial<RemoteSessionCreationService> &
    Partial<RemoteInteractionAnswerAuthorizer>;

export type WrapMobileConnectionService<TTrustedContext extends object> = (
    baseService: InteractionCapableRemoteSessionService,
    trustedContext: TTrustedContext
) => MobileConnectionServiceView;

export interface MobileHostCompositionOptions<TTrustedContext extends object> {
    hostCapabilities: MobileHostCapabilities;
    interactionRuntime: InteractionDeliveryRuntime;
    startNetwork: StartMobileNetwork<TTrustedContext>;
    signal: AbortSignal;
    diagnose(scope: MobileHostCompositionDiagnosticScope, event: unknown): void;
    wrapConnectionService?: WrapMobileConnectionService<TTrustedContext>;
}

export interface MobileHostCompositionHandle {
    close(): Promise<void>;
}

export type MobileHostCompositionDiagnostic =
    | { code: 'network_start_failed'; error: unknown }
    | { code: 'composition_cleanup_failed'; target: 'host' | 'network'; error: unknown }
    | { code: 'composition_stop_failed'; error: unknown }
    | { code: 'rejected_connection_close_failed'; error: unknown };

function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new AcpConnectionClosedError('mobile host composition aborted');
}

export async function startMobileHostComposition<TTrustedContext extends object>(
    options: MobileHostCompositionOptions<TTrustedContext>
): Promise<MobileHostCompositionHandle> {
    const report = (scope: MobileHostCompositionDiagnosticScope, event: unknown): void => {
        try {
            options.diagnose(scope, event);
        } catch {}
    };
    const diagnose = (event: MobileHostCompositionDiagnostic): void => report('composition', event);

    if (options.signal.aborted) throw abortReason(options.signal);

    const capabilities = options.hostCapabilities;
    const baseService = createRemoteSessionService(
        {
            getTaskList: capabilities.getTaskList,
            getTaskLoadResult: capabilities.getTaskLoadResult,
            getDefaultWorkspace: capabilities.getDefaultWorkspace,
            subscribeTaskUpdates: capabilities.subscribeTaskUpdates,
            subscribeTaskManagerUpdates: capabilities.subscribeTaskManagerUpdates,
            readSessionModelConfiguration: (task) =>
                readHostSessionModelConfiguration(task, capabilities.sessionModelSource),
            setSessionModelConfiguration: (task, selection) =>
                setHostSessionModelConfiguration(task, capabilities.sessionModelSource, selection, () =>
                    capabilities.publishTaskListUpdate?.()
                ),
            ...(capabilities.createSessionTask ? { createSessionTask: capabilities.createSessionTask } : {})
        },
        {
            resolveInteractionSessionScope: options.interactionRuntime.scopeResolver,
            diagnose: (event) => report('rss', event)
        }
    );

    const wrapConnectionService = options.wrapConnectionService;
    const host = new MobileAcpConnectionHost<TTrustedContext>({
        remoteSessionService: baseService,
        diagnose: (event) => report('adapter', event),
        ...(wrapConnectionService
            ? {
                  adapterFactory: (args) => {
                      const view = wrapConnectionService(baseService, args.trustedContext);
                      const mobileInteractions =
                          typeof view.authorizeInteractionAnswer === 'function'
                              ? {
                                    deliveryChannel: options.interactionRuntime.deliveryChannel,
                                    answerAuthorizer: view as RemoteInteractionAnswerAuthorizer
                                }
                              : undefined;
                      return new MobileAcpAgentAdapter(
                          args.connection,
                          args.signal,
                          view,
                          (event) => report('adapter', event),
                          args.failClosed,
                          args.registerCleanup,
                          undefined,
                          undefined,
                          mobileInteractions
                      );
                  }
              }
            : {
                  mobileInteractions: {
                      deliveryChannel: options.interactionRuntime.deliveryChannel,
                      answerAuthorizer: baseService
                  }
              })
    });

    // The gate is permanent: once the composition stops it never accepts another delivery.
    let accepting = true;
    const networkLifetime = new AbortController();
    let stopPromise: Promise<void> | undefined;
    let networkStarted: Promise<{ ok: true; handle: MobileHostNetworkHandle } | { ok: false; error: unknown }>;

    const openConnection = (channel: AcpMessageChannel, trustedContext: TTrustedContext): HostedAcpConnection => {
        if (!accepting) {
            try {
                channel.close();
            } catch (error) {
                diagnose({ code: 'rejected_connection_close_failed', error });
            }
            throw new AcpConnectionClosedError('mobile host composition stopped');
        }
        return host.open(channel, trustedContext);
    };

    const stop = (): Promise<void> => {
        if (stopPromise) return stopPromise;
        accepting = false;
        options.signal.removeEventListener('abort', onHostAbort);
        if (!networkLifetime.signal.aborted) {
            networkLifetime.abort(new AcpConnectionClosedError('mobile host composition stopped'));
        }
        // Both sides are started here so neither a rejection nor a hang on one can skip the other.
        const hostClosing = (async () => host.close())();
        const networkClosing = (async () => {
            const result = await networkStarted;
            if (result.ok) await result.handle.close();
        })();
        stopPromise = (async () => {
            const outcomes = await Promise.allSettled([hostClosing, networkClosing]);
            const targets = ['host', 'network'] as const;
            const failures: unknown[] = [];
            outcomes.forEach((outcome, index) => {
                if (outcome.status !== 'rejected') return;
                failures.push(outcome.reason);
                diagnose({ code: 'composition_cleanup_failed', target: targets[index], error: outcome.reason });
            });
            if (failures.length > 0) throw failures[0];
        })();
        return stopPromise;
    };

    const onHostAbort = (): void => {
        void stop().catch((error) => diagnose({ code: 'composition_stop_failed', error }));
    };

    try {
        const pending = options.startNetwork({ signal: networkLifetime.signal, openConnection });
        networkStarted = Promise.resolve(pending).then(
            (handle) => ({ ok: true as const, handle }),
            (error: unknown) => ({ ok: false as const, error })
        );
    } catch (error) {
        networkStarted = Promise.resolve({ ok: false as const, error });
    }
    options.signal.addEventListener('abort', onHostAbort, { once: true });
    if (options.signal.aborted) onHostAbort();

    const result = await networkStarted;
    if (!result.ok) {
        // A cancellation that surfaces as the network's rejection is not reported as a start fault.
        if (!(options.signal.aborted && result.error === options.signal.reason)) {
            diagnose({ code: 'network_start_failed', error: result.error });
        }
        await stop().catch(() => undefined);
        throw result.error;
    }
    if (!accepting) {
        await stop().catch(() => undefined);
        throw abortReason(options.signal);
    }
    return { close: stop };
}
