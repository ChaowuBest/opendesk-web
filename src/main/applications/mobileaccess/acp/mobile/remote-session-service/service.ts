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

import fs from 'node:fs/promises';
import path from 'node:path';
import {
    collectPublicSessionIdentifierCandidates,
    isNonEmptyString,
    projectPublicSessionLoadedInfo,
    projectPublicSessionInfo,
    projectPublicSessionState,
    projectTaskChunk,
    selectProductVisibleRoots,
    type LoadedPublicSessionTask,
    type RemoteCompletionStatus,
    type RemoteSessionDiagnostic,
    type RemoteSessionTaskEntry,
    type RemoteTaskStatus
} from './session-projector.js';
import { createPublicSessionSync, type PublicSessionSyncHandle } from './public-session-sync.js';
import { PublicSessionProjectionError, type PublicSessionState } from './public-session.js';
import type { InteractionSessionScopeResolver } from '../../../../../aikernel/interaction/delivery.js';
import { deriveRunToken, isRunToken, type PublicSessionIdentifierPlanFactory } from './public-session-identifiers.js';
import {
    HostSessionModelConfigurationError,
    type HostModelEffortSelection,
    type HostSessionConfigurableTask,
    type HostSessionModelConfiguration,
    type RemoteSessionConfigurationHostBinding,
    type RemoteSessionHostBinding,
    type RemoteSessionReadHostBinding
} from './host-binding.js';

export interface RemoteSessionDirectoryEntry {
    sessionId: string;
    cwd: string;
    title: string | null;
    updatedAt: string;
    taskStatus: RemoteTaskStatus;
    completionStatus: RemoteCompletionStatus;
}

export interface RemoteSessionDirectoryQuery {
    cwd?: string;
}

export interface RemoteSessionServiceOptions {
    resolveInteractionSessionScope: InteractionSessionScopeResolver;
    diagnose?: (
        event: RemoteSessionDiagnostic | { code: 'session_configuration_unavailable'; sessionId: string }
    ) => void;
}

export interface BegunSessionLoad {
    snapshot: PublicSessionState;
    sync: PublicSessionSyncHandle;
    configuration?: HostSessionModelConfiguration;
}

export type RemoteSessionConfigurationErrorCode = 'session_unavailable' | 'selection_unavailable' | 'host_failure';

export class RemoteSessionConfigurationError extends Error {
    constructor(
        readonly code: RemoteSessionConfigurationErrorCode,
        options?: ErrorOptions
    ) {
        super(code, options);
        this.name = 'RemoteSessionConfigurationError';
    }
}

export interface RemoteSessionConfigurationService {
    setSessionModelConfiguration(sessionId: string, selection: HostModelEffortSelection): HostSessionModelConfiguration;
}

export type RemoteSessionStopRefusalReason = 'unavailable_or_unauthorized' | 'not_running' | 'stale_run';

export class RemoteSessionStopError extends Error {
    constructor(
        readonly reason: RemoteSessionStopRefusalReason,
        options?: ErrorOptions
    ) {
        super(reason, options);
        this.name = 'RemoteSessionStopError';
    }
}

export type RemotePromptErrorCode =
    | 'session_unavailable'
    | 'task_busy'
    | 'goal_not_supported'
    | 'prompt_rejected'
    | 'prompt_failed';

export interface RemotePromptCompletion {
    stoppedByUser: boolean;
}

export type RemotePromptStart =
    | {
          kind: 'started';
          userMessageId: string;
          completion: Promise<RemotePromptCompletion>;
      }
    | { kind: 'recorded_not_started'; userMessageId: string };

export interface RemoteSessionService extends RemoteSessionConfigurationService {
    listSessions(query: RemoteSessionDirectoryQuery): Promise<RemoteSessionDirectoryEntry[]>;
    stopCurrentRun(sessionId: string, runToken: string): void;
    beginSessionLoad(sessionId: string, identityPlanFactory: PublicSessionIdentifierPlanFactory): BegunSessionLoad;
    startPrompt(sessionId: string, text: string, interactive?: boolean): Promise<RemotePromptStart>;
}

export interface RemoteSessionCreationInput {
    workspace: string;
}

export interface RemoteSessionCreated {
    kind: 'created';
    sessionId: string;
    workspace: string;
}

export type RemoteSessionCreateErrorCode =
    | 'default_workspace_unavailable'
    | 'workspace_unavailable'
    | 'session_not_created';

export class RemoteSessionCreateError extends Error {
    constructor(
        readonly code: RemoteSessionCreateErrorCode,
        options?: ErrorOptions
    ) {
        super(code, options);
        this.name = 'RemoteSessionCreateError';
    }
}

export interface RemoteSessionCreationService {
    resolveDefaultWorkspace(): Promise<{ workspace: string }>;
    createSession(input: RemoteSessionCreationInput): Promise<RemoteSessionCreated>;
}

export type CreationCapableRemoteSessionService = RemoteSessionService & RemoteSessionCreationService;

export function isCreationCapableRemoteSessionService(
    value: RemoteSessionService
): value is CreationCapableRemoteSessionService {
    const candidate = value as RemoteSessionService & Partial<RemoteSessionCreationService>;
    return typeof candidate.resolveDefaultWorkspace === 'function' && typeof candidate.createSession === 'function';
}

export interface RemoteInteractionAnswerAuthorizer {
    authorizeInteractionAnswer(sourceTaskId: string, expectedPublicSessionId: string): void;
}

export type RemoteInteractionAuthorizationErrorCode = 'interaction_invalid' | 'loaded_session_invalidated';

export class RemoteInteractionAuthorizationError extends Error {
    constructor(
        readonly code: RemoteInteractionAuthorizationErrorCode,
        options?: ErrorOptions
    ) {
        super(code, options);
        this.name = 'RemoteInteractionAuthorizationError';
    }
}

export type InteractionCapableRemoteSessionService = RemoteSessionService &
    RemoteInteractionAnswerAuthorizer &
    Partial<RemoteSessionCreationService>;

export class RemotePromptDomainError extends Error {
    constructor(
        readonly code: RemotePromptErrorCode,
        options?: ErrorOptions
    ) {
        super(code, options);
        this.name = 'RemotePromptDomainError';
    }
}

export class RemotePromptContractError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'RemotePromptContractError';
    }
}

export class RemoteSessionContractError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RemoteSessionContractError';
    }
}

async function normalizeExistingWorkspace(raw: unknown): Promise<string | undefined> {
    if (typeof raw !== 'string') return undefined;
    const trimmed = raw.trim();
    if (!trimmed || !path.isAbsolute(trimmed)) return undefined;
    const normalized = path.resolve(trimmed);
    try {
        const stat = await fs.stat(normalized);
        return stat.isDirectory() ? normalized : undefined;
    } catch {
        return undefined;
    }
}

export function createRemoteSessionService(
    binding: RemoteSessionReadHostBinding &
        RemoteSessionConfigurationHostBinding &
        Partial<Pick<RemoteSessionHostBinding, 'createSessionTask'>>,
    options: RemoteSessionServiceOptions
): InteractionCapableRemoteSessionService {
    const rootDependencies = {
        getDefaultWorkspace: binding.getDefaultWorkspace,
        diagnose: options.diagnose
    };

    const currentVisibleRoot = (sessionId: string): RemoteSessionTaskEntry | undefined =>
        selectProductVisibleRoots(binding.getTaskList()).find((task) => task.task_id === sessionId);

    const authorizeInteractionAnswer = (sourceTaskId: string, expectedPublicSessionId: string): void => {
        if (!currentVisibleRoot(expectedPublicSessionId)) {
            throw new RemoteInteractionAuthorizationError('loaded_session_invalidated');
        }
        const resolved = options.resolveInteractionSessionScope(sourceTaskId);
        if (!currentVisibleRoot(expectedPublicSessionId)) {
            throw new RemoteInteractionAuthorizationError('loaded_session_invalidated');
        }
        if (resolved !== expectedPublicSessionId) {
            throw new RemoteInteractionAuthorizationError('interaction_invalid');
        }
    };

    const authorizeAndLoadTarget = (sessionId: string): HostSessionConfigurableTask => {
        const authorizedCandidate = currentVisibleRoot(sessionId);
        if (!authorizedCandidate) {
            throw new PublicSessionProjectionError('session_unavailable', 'session is unavailable');
        }
        const loaded = binding.getTaskLoadResult(sessionId);
        if (loaded.corrupted || !loaded.task) {
            throw new PublicSessionProjectionError('session_load_failed', 'session could not be loaded');
        }
        const task = loaded.task;
        const authorizedParent = isNonEmptyString(authorizedCandidate.parent_id)
            ? authorizedCandidate.parent_id
            : undefined;
        const loadedParent = isNonEmptyString(task.parent_id) ? task.parent_id : undefined;
        if (task.task_id !== sessionId || task.internal === true || loadedParent !== authorizedParent) {
            throw new PublicSessionProjectionError('session_load_failed', 'loaded session identity is invalid');
        }
        return task;
    };

    const stopRefused = (reason: RemoteSessionStopRefusalReason, cause?: unknown): RemoteSessionStopError =>
        new RemoteSessionStopError(reason, cause === undefined ? undefined : { cause });

    const assertStopTargetStillAuthorized = (sessionId: string, task: LoadedPublicSessionTask): void => {
        const refreshed = currentVisibleRoot(sessionId);
        const refreshedParent = refreshed && isNonEmptyString(refreshed.parent_id) ? refreshed.parent_id : undefined;
        const loadedParent = isNonEmptyString(task.parent_id) ? task.parent_id : undefined;
        if (
            !refreshed ||
            refreshed.internal === true ||
            task.task_id !== sessionId ||
            task.internal === true ||
            loadedParent !== refreshedParent
        ) {
            throw new PublicSessionProjectionError('session_unavailable', 'stop target is unavailable');
        }
    };

    const authorizePromptTarget = (sessionId: string): LoadedPublicSessionTask => {
        try {
            return authorizeAndLoadTarget(sessionId);
        } catch (error) {
            throw new RemotePromptDomainError('session_unavailable', { cause: error });
        }
    };

    const currentAuthorizedWorkspaces = async (): Promise<Set<string>> => {
        const candidates: unknown[] = [binding.getDefaultWorkspace()];
        for (const task of selectProductVisibleRoots(binding.getTaskList())) {
            candidates.push(projectPublicSessionInfo(task, rootDependencies).cwd);
        }
        const normalized = await Promise.all(candidates.map((candidate) => normalizeExistingWorkspace(candidate)));
        return new Set(normalized.filter((value): value is string => value !== undefined));
    };

    const authorizeWorkspace = async (raw: unknown): Promise<string> => {
        const requested = await normalizeExistingWorkspace(raw);
        if (!requested) throw new RemoteSessionCreateError('workspace_unavailable');
        let allowed: Set<string>;
        try {
            allowed = await currentAuthorizedWorkspaces();
        } catch (cause) {
            throw new RemoteSessionCreateError('workspace_unavailable', { cause });
        }
        if (!allowed.has(requested)) {
            throw new RemoteSessionCreateError('workspace_unavailable');
        }
        return requested;
    };

    const resolveDefaultWorkspace = async (): Promise<{ workspace: string }> => {
        let workspace: string | undefined;
        try {
            workspace = await normalizeExistingWorkspace(binding.getDefaultWorkspace());
            if (!workspace || !(await currentAuthorizedWorkspaces()).has(workspace)) {
                throw new Error('default workspace is unavailable');
            }
        } catch (cause) {
            throw new RemoteSessionCreateError('default_workspace_unavailable', { cause });
        }
        return { workspace };
    };

    const createSessionTask = binding.createSessionTask?.bind(binding);
    const creation = createSessionTask
        ? {
              resolveDefaultWorkspace,
              async createSession(input: RemoteSessionCreationInput): Promise<RemoteSessionCreated> {
                  const workspace = await authorizeWorkspace(input.workspace);
                  const result = await createSessionTask({ workspace });
                  if (result.status === 'not_created') {
                      throw new RemoteSessionCreateError('session_not_created');
                  }
                  if (!result.taskId.trim() || result.workspace !== workspace) {
                      throw new RemoteSessionContractError('invalid host session creation result');
                  }
                  return { kind: 'created', sessionId: result.taskId, workspace };
              }
          }
        : undefined;

    return {
        authorizeInteractionAnswer,
        ...(creation ?? {}),
        setSessionModelConfiguration(sessionId, selection) {
            let task: HostSessionConfigurableTask;
            try {
                task = authorizeAndLoadTarget(sessionId);
            } catch (cause) {
                throw new RemoteSessionConfigurationError('session_unavailable', { cause });
            }
            try {
                return binding.setSessionModelConfiguration(task, selection);
            } catch (cause) {
                if (cause instanceof HostSessionModelConfigurationError) {
                    throw new RemoteSessionConfigurationError('selection_unavailable', { cause });
                }
                throw new RemoteSessionConfigurationError('host_failure', { cause });
            }
        },
        async listSessions(query) {
            const selected = selectProductVisibleRoots(binding.getTaskList());
            const seen = new Set<string>();
            for (const task of selected) {
                if (!isNonEmptyString(task.task_id)) {
                    throw new RemoteSessionContractError('Selected task is missing task_id');
                }
                if (seen.has(task.task_id)) {
                    throw new RemoteSessionContractError('Duplicate selected task_id');
                }
                seen.add(task.task_id);
            }
            let defaultWorkspace: string | undefined;
            const entries = selected.map((task) =>
                projectPublicSessionInfo(task, {
                    getDefaultWorkspace: () => (defaultWorkspace ??= binding.getDefaultWorkspace()),
                    diagnose: options.diagnose
                })
            );
            return entries
                .filter((entry) => query.cwd === undefined || entry.cwd === query.cwd)
                .sort((left, right) => {
                    const byTime = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
                    return byTime || (left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0);
                });
        },

        stopCurrentRun(sessionId, runToken) {
            let task: LoadedPublicSessionTask;
            try {
                task = authorizeAndLoadTarget(sessionId);
                assertStopTargetStillAuthorized(sessionId, task);
            } catch (error) {
                throw stopRefused('unavailable_or_unauthorized', error);
            }
            if (task.task_status !== 'running') {
                throw stopRefused('not_running');
            }
            if (!isRunToken(runToken)) {
                throw stopRefused('stale_run');
            }
            let currentToken: string;
            try {
                currentToken = deriveRunToken(task.task_id, task.getTurnGeneration());
            } catch (error) {
                throw stopRefused('unavailable_or_unauthorized', error);
            }
            if (currentToken !== runToken) {
                throw stopRefused('stale_run');
            }
            try {
                task.stop('user');
            } catch (error) {
                throw stopRefused('unavailable_or_unauthorized', error);
            }
        },

        beginSessionLoad(sessionId, identityPlanFactory) {
            const task = authorizeAndLoadTarget(sessionId);
            let configuration: HostSessionModelConfiguration | undefined;
            try {
                configuration = binding.readSessionModelConfiguration(task);
            } catch {
                options.diagnose?.({ code: 'session_configuration_unavailable', sessionId });
            }
            let setup: ReturnType<typeof createPublicSessionSync> | undefined;
            try {
                setup = createPublicSessionSync(sessionId, {
                    subscribeTask: (subscriber) => binding.subscribeTaskUpdates(task, subscriber),
                    subscribeTaskManager: binding.subscribeTaskManagerUpdates,
                    projectChunk: (chunk, identity) => projectTaskChunk(task, chunk, identity),
                    projectInfo: () => projectPublicSessionLoadedInfo(task, rootDependencies),
                    assertStillAuthorized: () => {
                        const row = currentVisibleRoot(sessionId);
                        if (!row || row.internal === true) {
                            throw new PublicSessionProjectionError('session_load_failed', 'live authorization changed');
                        }
                    },
                    projectAuthoritativeState: (identity) => projectPublicSessionState(task, identity, rootDependencies)
                });
                const candidates = collectPublicSessionIdentifierCandidates(task.chat_context.messages);
                const identity = identityPlanFactory(sessionId, candidates);
                const snapshot = projectPublicSessionState(task, identity, rootDependencies);
                setup.initializeT0(snapshot, identity);
                return { snapshot, sync: setup.handle, ...(configuration ? { configuration } : {}) };
            } catch (error) {
                setup?.handle.stop(error instanceof Error ? error : new Error(String(error)));
                throw error;
            }
        },

        async startPrompt(sessionId, text, interactive = false) {
            const task = authorizePromptTarget(sessionId);

            const goalStatus = task.goal_state?.status;
            if (goalStatus === 'active' || goalStatus === 'paused' || goalStatus === 'blocked') {
                throw new RemotePromptDomainError('goal_not_supported');
            }
            if (goalStatus !== undefined && goalStatus !== 'complete' && goalStatus !== 'cleared') {
                throw new RemotePromptDomainError('goal_not_supported');
            }
            if (task.task_status === 'running') {
                throw new RemotePromptDomainError('task_busy');
            }
            if (!['waiting', 'stopped', 'failed'].includes(String(task.task_status))) {
                throw new RemotePromptDomainError('prompt_rejected');
            }

            let userMessageId: string | undefined;
            let result;
            try {
                result = await task.submitUserMessage(text, {
                    interactive,
                    onUserMessageCommitted(messageId) {
                        userMessageId = messageId;
                    }
                });
            } catch (error) {
                if (userMessageId) {
                    return { kind: 'recorded_not_started', userMessageId };
                }
                throw new RemotePromptDomainError('prompt_failed', { cause: error });
            }

            if (result.status !== 'ok' || result.supplementId !== undefined) {
                if (userMessageId) return { kind: 'recorded_not_started', userMessageId };
                throw new RemotePromptDomainError('prompt_rejected');
            }
            if (!userMessageId) {
                throw new RemotePromptContractError('ordinary submit succeeded without a committed user message id');
            }

            const completion = task.waitUntilFinished(undefined, true).then(() => ({
                stoppedByUser: task.stop_requested_by_user === true
            }));
            return { kind: 'started', userMessageId, completion };
        }
    };
}
