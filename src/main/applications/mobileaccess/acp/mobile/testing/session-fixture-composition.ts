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
import type { MobileHostCapabilities, WrapMobileConnectionService } from '../host-composition.js';
import type {
    HostSessionConfigurableTask,
    HostSessionModelSource,
    HostSessionTaskCreationInput,
    HostSessionTaskCreationResult
} from '../remote-session-service/host-binding.js';
import { isCreationCapableRemoteSessionService } from '../remote-session-service/service.js';
import type { LoadedPublicSessionTask, RemoteSessionTaskEntry } from '../remote-session-service/session-projector.js';
import type {
    RemoteTaskManagerSubscriber,
    RemoteTaskUpdateSubscriber
} from '../remote-session-service/public-session-sync.js';
import { createIsolatedSessionFixture, type IsolatedSessionFixtureName } from './isolated-session-fixture.js';
import { observePublicSessionTrace } from './public-session-trace.js';
import { createPromptFixtureService, type PromptFaultPlan } from './prompt-fixture.js';
import { observePromptTrace } from './prompt-trace.js';
import { createSessionCreationFixtureService } from './session-creation-fixture.js';
import { SessionCreationFixtureController } from './session-creation-trace.js';
import { createRecoveryFixtureService, RecoveryFixtureController } from './recovery-fixture.js';

/**
 * Per-connection context the fixture wrappers read. It carries only fixture controls; the transport that
 * delivers the channel is the caller's concern, so nothing here names a socket, port or address.
 */
export interface RemoteSessionFixtureContext {
    readonly transport: 'in-memory-fixture';
    readonly connectionId: string;
    readonly isActive: () => boolean;
    readonly getPromptFaultPlan: () => Readonly<PromptFaultPlan>;
    readonly getOutboundOrdinal: () => number;
    readonly sessionCreation: SessionCreationFixtureController;
    readonly recovery?: RecoveryFixtureController;
}

export interface SessionFixtureCompositionOptions {
    /** When set, the Host publishes one isolated fixture Session instead of the real Task list. */
    fixture?: IsolatedSessionFixtureName;
    getTaskList(): readonly RemoteSessionTaskEntry[];
    getTaskLoadResult(sessionId: string): {
        task: HostSessionConfigurableTask | undefined;
        corrupted: boolean;
    };
    sessionModelSource: HostSessionModelSource;
    getDefaultWorkspace(): string;
    createSessionTask(input: HostSessionTaskCreationInput): Promise<HostSessionTaskCreationResult>;
    subscribeTaskUpdates(task: LoadedPublicSessionTask, subscriber: RemoteTaskUpdateSubscriber): () => void;
    subscribeTaskManagerUpdates(subscriber: RemoteTaskManagerSubscriber): () => void;
    emitTrace?: (channel: 'prompt' | 'public-session', snapshot: unknown) => void;
}

export interface SessionFixtureCompositionInput {
    hostCapabilities: MobileHostCapabilities;
    wrapConnectionService: WrapMobileConnectionService<RemoteSessionFixtureContext>;
}

/** An isolated fixture publishes no model catalog, so configuration reads and writes stay unavailable. */
const unavailableSessionModelSource: HostSessionModelSource = {
    listConfiguredModelAliases: () => [],
    resolveChatModel: () => undefined,
    resolveEffectiveDefaultModel: () => ({ kind: 'none' })
};

/**
 * Prepares the two inputs the public composition needs: the Host capabilities and the per-connection
 * service wrapper chain. It constructs no Remote Session Service, Host or Adapter — those stay the
 * responsibility of `startMobileHostComposition`, so a test exercises the same assembly as production.
 */
export function prepareSessionFixtureComposition(
    options: SessionFixtureCompositionOptions
): SessionFixtureCompositionInput {
    const fallbackRecovery = new RecoveryFixtureController();
    const fixture = options.fixture ? createIsolatedSessionFixture(options.fixture) : undefined;
    const emit =
        options.emitTrace ??
        ((channel: 'prompt' | 'public-session', snapshot: unknown) =>
            console.info(`[MobileSessionFixture][${channel}]`, JSON.stringify(snapshot)));

    const hostCapabilities: MobileHostCapabilities = fixture
        ? {
              getTaskList: () => [fixture],
              getTaskLoadResult: (sessionId) => ({
                  task: sessionId === fixture.task_id ? fixture : undefined,
                  corrupted: false
              }),
              getDefaultWorkspace: options.getDefaultWorkspace,
              subscribeTaskUpdates: () => () => undefined,
              subscribeTaskManagerUpdates: () => () => undefined,
              sessionModelSource: unavailableSessionModelSource
          }
        : {
              getTaskList: options.getTaskList,
              getTaskLoadResult: options.getTaskLoadResult,
              getDefaultWorkspace: options.getDefaultWorkspace,
              createSessionTask: options.createSessionTask,
              subscribeTaskUpdates: options.subscribeTaskUpdates,
              subscribeTaskManagerUpdates: options.subscribeTaskManagerUpdates,
              sessionModelSource: options.sessionModelSource
          };

    const wrapConnectionService: WrapMobileConnectionService<RemoteSessionFixtureContext> = (baseService, context) => {
        const recoveryService = createRecoveryFixtureService(
            baseService,
            context.recovery ?? fallbackRecovery,
            context.connectionId
        );
        const creationService = isCreationCapableRemoteSessionService(recoveryService)
            ? createSessionCreationFixtureService(recoveryService, context.sessionCreation)
            : recoveryService;
        const promptFixtureService = createPromptFixtureService(creationService, {
            getPlan: () => context.getPromptFaultPlan()
        });
        const promptTraceService = observePromptTrace(promptFixtureService, {
            connectionId: () => context.connectionId,
            outboundOrdinal: () => context.getOutboundOrdinal(),
            fixture: () => {
                const mode = context.getPromptFaultPlan().promptMode;
                return mode === 'reject_before_commit' || mode === 'recorded_not_started';
            },
            emit: (snapshot) => emit('prompt', snapshot)
        });
        const observedService = observePublicSessionTrace(promptTraceService, (snapshot) =>
            emit('public-session', snapshot)
        );
        // The isolated fixture never installs mobile interactions, so the view drops the inherited authorizer.
        return fixture ? { ...observedService, authorizeInteractionAnswer: undefined } : observedService;
    };

    return { hostCapabilities, wrapConnectionService };
}
