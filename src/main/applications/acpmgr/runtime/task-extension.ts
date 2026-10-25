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

import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import {
    registerTaskExtension,
    type TaskExtension,
    type TaskExtensionInputResult,
    type TaskExtensionLifecycleEvent,
    type TaskExtensionSubTaskCompletionResult
} from '../../../aikernel/task-extension.js';
import { AssistantMessage, type TextMessagePart } from '../../../aikernel/messages.js';
import type { PermissionAction, PermissionResourceType } from '../../../aikernel/security/permission.js';
import { escapeGlobLiteralPath } from '../../../aikernel/security/permission.js';
import type { TaskState } from '../../../aikernel/states/tasks.js';
import { truncateTaskName } from '../../../utils/task-name.js';
import { toErrorMessage } from '../../../../common/utils/error.js';
import { t } from '../../../../locale/index.js';
import { logger } from '../../../utils/logger.js';
import { AcpAgentDecl } from '../agent.js';
import { AcpMessageProjector } from './projector.js';
import type { AcpTaskRuntime } from './session.js';
import type { AcpTaskRuntimeTurnResult } from './types.js';

const ACP_TASK_EXTENSION_KEY = 'acp_runtime';

interface PersistedAcpExtensionState {
    schemaVersion: 1;
    state: Record<string, unknown>;
    lastTurnStopReason?: AcpTaskRuntimeTurnResult['stopReason'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStopReason(value: unknown): AcpTaskRuntimeTurnResult['stopReason'] | undefined {
    return value === 'completed' ||
        value === 'cancelled' ||
        value === 'max_tokens' ||
        value === 'refusal' ||
        value === 'error'
        ? value
        : undefined;
}

function permissionAccess(request: RequestPermissionRequest): {
    resourceType: PermissionResourceType;
    action: PermissionAction;
} {
    switch (request.toolCall.kind) {
        case 'read':
        case 'search':
            return { resourceType: 'file', action: 'read' };
        case 'edit':
        case 'delete':
        case 'move':
            return { resourceType: 'file', action: 'write' };
        case 'execute':
            return { resourceType: 'file', action: 'execute' };
        case 'fetch':
            return { resourceType: 'network', action: 'access' };
        default:
            return { resourceType: '*', action: '*' };
    }
}

export class AcpTaskExtension implements TaskExtension {
    readonly key = ACP_TASK_EXTENSION_KEY;
    private persistedState?: Record<string, unknown>;
    private lastTurnStopReason?: AcpTaskRuntimeTurnResult['stopReason'];
    private legacyStateMigrated = false;
    private runtimeEntry?: { agent: AcpAgentDecl; runtime: AcpTaskRuntime };
    private activeTurn?: { token: symbol; abortController: AbortController; invalidated: boolean };

    constructor(private readonly task: TaskState) {}

    restore(raw: Record<string, unknown>): void {
        const current = isRecord(raw.acp_runtime) ? raw.acp_runtime : undefined;
        const legacy = isRecord(raw.agent_runtime) && raw.agent_runtime.kind === 'acp' ? raw.agent_runtime : undefined;
        const source = current ?? legacy;
        if (!source) return;
        this.legacyStateMigrated = legacy !== undefined && current === undefined;

        const state = isRecord(source.state) ? source.state : undefined;
        if (state) this.persistedState = state;
        this.lastTurnStopReason = normalizeStopReason(source.lastTurnStopReason);
    }

    serialize(): Record<string, unknown> {
        const value: PersistedAcpExtensionState | undefined =
            this.persistedState || this.lastTurnStopReason
                ? {
                      schemaVersion: 1,
                      state: this.persistedState ?? {},
                      ...(this.lastTurnStopReason ? { lastTurnStopReason: this.lastTurnStopReason } : {})
                  }
                : undefined;
        return {
            acp_runtime: value,
            ...(this.legacyStateMigrated ? { agent_runtime: undefined } : {})
        };
    }

    async handleUserMessage(message: string, imageDataUris?: string[]): Promise<TaskExtensionInputResult | undefined> {
        const agent = this.task.getAgent();
        if (!(agent instanceof AcpAgentDecl)) return undefined;
        if (this.activeTurn) {
            return { status: 'error', messageKey: 'acpmgr.error.concurrentTurn' };
        }

        const runtime = await this.resolveRuntime(agent);
        const token = Symbol('acp-turn');
        const abortController = new AbortController();
        this.activeTurn = { token, abortController, invalidated: false };
        this.lastTurnStopReason = undefined;
        this.beginTaskTurn(message);

        const projector = new AcpMessageProjector({
            chatContext: this.task.chat_context,
            publishUserMessage: () => this.task.sendSubscriptionFeedback(),
            publishAssistantPart: (partIndex) => this.task.sendSubscriptionFeedback(partIndex)
        });
        await projector.start(message, imageDataUris);
        void this.processTurn(runtime, projector, message, imageDataUris, token, abortController);
        return { status: 'ok' };
    }

    onTaskLifecycle(event: TaskExtensionLifecycleEvent): void {
        if (event.type === 'stop') {
            this.activeTurn?.abortController.abort(event.reason);
            void this.runtimeEntry?.runtime.cancel(event.reason).catch((error) => {
                logger.warn(`task ${this.task.task_id}: failed to cancel ACP runtime: ${toErrorMessage(error)}`);
            });
            return;
        }

        if (event.type === 'agent_changed') {
            if (this.activeTurn) {
                this.activeTurn.invalidated = true;
                this.activeTurn.abortController.abort('agent-changed');
            }
            this.persistedState = undefined;
            this.lastTurnStopReason = undefined;
        } else {
            this.activeTurn?.abortController.abort('disposed');
            this.activeTurn = undefined;
        }
        const entry = this.runtimeEntry;
        this.runtimeEntry = undefined;
        void entry?.runtime.dispose().catch((error) => {
            logger.warn(`task ${this.task.task_id}: failed to dispose ACP runtime: ${toErrorMessage(error)}`);
        });
    }

    getSubTaskCompletionResult(): TaskExtensionSubTaskCompletionResult | undefined {
        if (!this.lastTurnStopReason) return undefined;
        const assistant = [...this.task.chat_context.messages]
            .reverse()
            .find((message): message is AssistantMessage => message instanceof AssistantMessage);
        if (!assistant) return undefined;

        const errorPart = assistant.content.find((part) => part.type === 'error');
        if (errorPart?.type === 'error') {
            return {
                success: false,
                result: `${errorPart.title}: ${errorPart.message}`,
                status: 'fail'
            };
        }
        const result = assistant.content
            .filter((part): part is TextMessagePart => part.type === 'text')
            .map((part) => part.text)
            .join('\n')
            .trim();
        if (!result) return undefined;

        const success = this.lastTurnStopReason === 'completed';
        return { success, result, status: success ? 'success' : 'fail' };
    }

    private async resolveRuntime(agent: AcpAgentDecl): Promise<AcpTaskRuntime> {
        if (this.runtimeEntry?.agent === agent) return this.runtimeEntry.runtime;
        const previous = this.runtimeEntry;
        this.runtimeEntry = undefined;
        if (previous) await previous.runtime.dispose();
        const runtime = agent.createAcpTaskRuntime();
        this.runtimeEntry = { agent, runtime };
        return runtime;
    }

    private beginTaskTurn(message: string): void {
        this.task.task_status = 'running';
        this.task.recordTaskInteraction();
        this.task.started_at = new Date();
        this.task.updated_at = new Date();
        this.task.stop_requested_by_user = false;
        this.task.finished_at = undefined;
        this.task.runtimeInterrupt = undefined;
        this.task.task_manager_state.moveTaskToEnd(this.task);
        if (this.task.task_name === null) {
            this.task.name_pending = false;
            this.task.task_name = truncateTaskName(message);
        }
        this.task.persistLater();
        this.task.task_manager_state.publishTaskListUpdate();
    }

    private async processTurn(
        runtime: AcpTaskRuntime,
        projector: AcpMessageProjector,
        message: string,
        imageDataUris: string[] | undefined,
        token: symbol,
        abortController: AbortController
    ): Promise<void> {
        try {
            const result = await runtime.runTurn({
                taskId: this.task.task_id,
                prompt: message,
                imageDataUris,
                workspace: this.task.getWorkspace(),
                persistedState: this.persistedState,
                signal: abortController.signal,
                onUpdate: (update) => projector.apply(update),
                checkpoint: async (state) => {
                    if (this.activeTurn?.token !== token || this.activeTurn.invalidated) return;
                    this.persistedState = state;
                    this.task.persistLater();
                },
                requestPermission: (request) => this.requestPermission(request, abortController.signal)
            });
            if (this.activeTurn?.token === token && !this.activeTurn.invalidated) {
                this.persistedState = result.state ?? this.persistedState ?? {};
                this.lastTurnStopReason = result.stopReason;
            }
        } catch (error) {
            if (this.activeTurn?.token === token && !this.activeTurn.invalidated) {
                this.lastTurnStopReason = abortController.signal.aborted ? 'cancelled' : 'error';
            }
            if (!abortController.signal.aborted) {
                await projector.apply({
                    type: 'error',
                    title: t('acpmgr.error.connectionTitle'),
                    message: toErrorMessage(error)
                });
                logger.error(`task ${this.task.task_id}: ACP runtime failed: ${toErrorMessage(error)}`);
            }
        } finally {
            await projector.ensureOutputPart();
            projector.finish();
            if (this.activeTurn?.token === token) {
                this.activeTurn = undefined;
                this.task.task_status = 'stopped';
                this.task.finished_at = new Date();
                this.task.persistLater();
                await this.task.sendSubscriptionFeedback();
                this.task.task_manager_state.publishTaskListUpdate();
            }
        }
    }

    private async requestPermission(
        request: RequestPermissionRequest,
        signal: AbortSignal
    ): Promise<RequestPermissionResponse> {
        if (signal.aborted) return { outcome: { outcome: 'cancelled' } };
        const rejectOption = request.options.find(
            (option) => option.kind === 'reject_once' || option.kind === 'reject_always'
        );
        const provider = this.task.harnessContext.permissionPrompt;
        if (!provider) {
            return rejectOption
                ? { outcome: { outcome: 'selected', optionId: rejectOption.optionId } }
                : { outcome: { outcome: 'cancelled' } };
        }

        const resourcePath = request.toolCall.locations?.[0]?.path || `acp://${request.toolCall.toolCallId}`;
        const access = permissionAccess(request);
        const rawInput = isRecord(request.toolCall.rawInput) ? request.toolCall.rawInput : undefined;
        const response = await provider.prompt(
            [{ ...access, resourcePath }],
            request.toolCall.title ?? request.toolCall.name ?? request.toolCall.toolCallId,
            [{ label: resourcePath, pattern: escapeGlobLiteralPath(resourcePath) }],
            {
                taskId: this.task.parent_id ?? this.task.task_id,
                taskName: this.task.task_name,
                workspace: this.task.getWorkspace(),
                sourceTaskId: this.task.task_id,
                sourceTaskName: this.task.task_name,
                parentTaskId: this.task.parent_id
            },
            { toolCallId: request.toolCall.toolCallId, input: rawInput }
        );
        const desiredKind =
            response.decision === 'allow'
                ? response.rememberScope === 'none'
                    ? 'allow_once'
                    : 'allow_always'
                : response.rememberScope === 'none'
                  ? 'reject_once'
                  : 'reject_always';
        const selected = request.options.find((option) => option.kind === desiredKind);
        return selected
            ? { outcome: { outcome: 'selected', optionId: selected.optionId } }
            : { outcome: { outcome: 'cancelled' } };
    }
}

registerTaskExtension(ACP_TASK_EXTENSION_KEY, (task) => new AcpTaskExtension(task));
