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

import type { ModeDecl } from '../../../../../aikernel/agents/common.js';
import type { ExecutionHost, ExecutionNodeSummary } from '../../../../../aikernel/security/harness.js';
import { REASONING_EFFORT_VALUES, type ReasoningEffort } from '../../../../../aikernel/types/reasoning.js';
import { resolveModelReasoningEfforts } from '../../../../../utils/model-context.js';
import type { RemoteTaskManagerSubscriber, RemoteTaskUpdateSubscriber } from './public-session-sync.js';
import type { LoadedPublicSessionTask, RemoteSessionTaskEntry } from './session-projector.js';

export interface HostModelEffortSelection {
    modelAlias: string;
    reasoningEffort: ReasoningEffort;
}

export interface HostModelEffortCandidate {
    modelAlias: string;
    reasoningEfforts: readonly ReasoningEffort[];
}

export interface HostSessionModelConfiguration {
    current: HostModelEffortSelection;
    candidates: readonly HostModelEffortCandidate[];
}

export interface HostSessionConfigurableTask extends LoadedPublicSessionTask {
    model?: string;
    reasoningEffort?: ReasoningEffort;
    persistLater(): void;
}

export interface HostResolvedChatModel {
    alias: string;
    modelName: string;
}

export type HostEffectiveDefaultModel =
    { kind: 'configured_alias'; alias: string } | { kind: 'unrepresentable' } | { kind: 'none' };

export interface HostSessionModelSource {
    listConfiguredModelAliases(): readonly string[];
    resolveChatModel(alias: string): HostResolvedChatModel | undefined;
    resolveEffectiveDefaultModel(): HostEffectiveDefaultModel;
}

export type HostSessionModelConfigurationErrorCode = 'configuration_unavailable' | 'invalid_selection';

export class HostSessionModelConfigurationError extends Error {
    constructor(readonly code: HostSessionModelConfigurationErrorCode) {
        super(code);
        this.name = 'HostSessionModelConfigurationError';
    }
}

export interface RemoteSessionConfigurationHostBinding {
    readSessionModelConfiguration(task: HostSessionConfigurableTask): HostSessionModelConfiguration | undefined;
    setSessionModelConfiguration(
        task: HostSessionConfigurableTask,
        selection: HostModelEffortSelection
    ): HostSessionModelConfiguration;
}

function buildHostSessionModelCatalog(source: HostSessionModelSource): readonly HostModelEffortCandidate[] | undefined {
    try {
        const candidates: HostModelEffortCandidate[] = [];
        const validAliases = new Set<string>();
        for (const alias of source.listConfiguredModelAliases()) {
            if (!alias) continue;
            const model = source.resolveChatModel(alias);
            if (!model) continue;
            if (model.alias !== alias || !model.modelName) return undefined;
            if (validAliases.has(alias)) return undefined;

            const reasoningEfforts = resolveModelReasoningEfforts({ model_name: model.modelName });
            const seenEfforts = new Set<ReasoningEffort>();
            if (!reasoningEfforts.includes('')) return undefined;
            for (const effort of reasoningEfforts) {
                if (!REASONING_EFFORT_VALUES.includes(effort) || seenEfforts.has(effort)) return undefined;
                seenEfforts.add(effort);
            }
            validAliases.add(alias);
            candidates.push({ modelAlias: alias, reasoningEfforts: [...reasoningEfforts] });
        }
        return candidates.length > 0 ? candidates : undefined;
    } catch {
        return undefined;
    }
}

function configurationFromCatalog(
    task: HostSessionConfigurableTask,
    source: HostSessionModelSource,
    candidates: readonly HostModelEffortCandidate[]
): HostSessionModelConfiguration | undefined {
    try {
        let modelAlias = task.model;
        if (!modelAlias || !candidates.some((candidate) => candidate.modelAlias === modelAlias)) {
            const defaultModel = source.resolveEffectiveDefaultModel();
            if (
                defaultModel.kind !== 'configured_alias' ||
                !candidates.some((candidate) => candidate.modelAlias === defaultModel.alias)
            ) {
                return undefined;
            }
            modelAlias = defaultModel.alias;
        }
        const candidate = candidates.find((value) => value.modelAlias === modelAlias);
        const reasoningEffort = task.reasoningEffort ?? '';
        if (!candidate || !candidate.reasoningEfforts.includes(reasoningEffort)) return undefined;
        return {
            current: { modelAlias, reasoningEffort },
            candidates
        };
    } catch {
        return undefined;
    }
}

export function readHostSessionModelConfiguration(
    task: HostSessionConfigurableTask,
    source: HostSessionModelSource
): HostSessionModelConfiguration | undefined {
    const candidates = buildHostSessionModelCatalog(source);
    return candidates ? configurationFromCatalog(task, source, candidates) : undefined;
}

export function setHostSessionModelConfiguration(
    task: HostSessionConfigurableTask,
    source: HostSessionModelSource,
    selection: HostModelEffortSelection,
    onChanged?: () => void
): HostSessionModelConfiguration {
    const candidates = buildHostSessionModelCatalog(source);
    if (!candidates) throw new HostSessionModelConfigurationError('configuration_unavailable');
    const candidate = candidates.find((value) => value.modelAlias === selection.modelAlias);
    if (
        !candidate ||
        !REASONING_EFFORT_VALUES.includes(selection.reasoningEffort) ||
        !candidate.reasoningEfforts.includes(selection.reasoningEffort)
    ) {
        throw new HostSessionModelConfigurationError('invalid_selection');
    }

    const nextReasoningEffort = selection.reasoningEffort || undefined;
    const changed = task.model !== selection.modelAlias || task.reasoningEffort !== nextReasoningEffort;
    task.model = selection.modelAlias;
    task.reasoningEffort = nextReasoningEffort;
    if (changed) {
        task.persistLater();
        onChanged?.();
    }
    return { current: { ...selection }, candidates };
}

export interface RemoteSessionReadHostBinding {
    getTaskList(): readonly RemoteSessionTaskEntry[];
    getTaskLoadResult(sessionId: string): { task: HostSessionConfigurableTask | undefined; corrupted: boolean };
    getDefaultWorkspace(): string;
    subscribeTaskUpdates(task: LoadedPublicSessionTask, subscriber: RemoteTaskUpdateSubscriber): () => void;
    subscribeTaskManagerUpdates(subscriber: RemoteTaskManagerSubscriber): () => void;
}

export interface HostSessionTaskCreationInput {
    workspace: string;
}

export interface HostCreatedTask {
    task_id: string;
    getAgentMode(): ModeDecl;
    setExecutionHost(host: ExecutionHost): Promise<void>;
    rebuildSystemPrompt(): Promise<void>;
}

export interface HostTaskManager {
    tasks: readonly HostCreatedTask[];
    createTask(): HostCreatedTask;
    initHarness(task: HostCreatedTask, workspace: string, mode: ModeDecl): Promise<void>;
    publishTaskListUpdate(): void;
}

export type HostSessionTaskCreationDiagnostic =
    | { code: 'execution_node_unavailable' }
    | {
          code: 'task_assembly_failed';
          step: 'init_harness' | 'set_execution_host' | 'rebuild_system_prompt' | 'publish_task_list';
      };

export interface HostSessionTaskCreationDependencies {
    taskManager: HostTaskManager;
    getDefaultExecutionNodeId(): string;
    getExecutionNode(nodeId: string): ExecutionNodeSummary | null;
    diagnose(event: HostSessionTaskCreationDiagnostic): void;
}

export type HostSessionTaskCreationResult =
    { status: 'created'; taskId: string; workspace: string } | { status: 'not_created' };

export interface RemoteSessionHostBinding extends RemoteSessionReadHostBinding, RemoteSessionConfigurationHostBinding {
    createSessionTask(input: HostSessionTaskCreationInput): Promise<HostSessionTaskCreationResult>;
}

function report(dependencies: HostSessionTaskCreationDependencies, event: HostSessionTaskCreationDiagnostic): void {
    try {
        dependencies.diagnose(event);
    } catch {}
}

function stillOwned(manager: HostTaskManager, task: HostCreatedTask): boolean {
    return manager.tasks.includes(task);
}

async function bestEffort(
    dependencies: HostSessionTaskCreationDependencies,
    task: HostCreatedTask,
    step: Extract<HostSessionTaskCreationDiagnostic, { code: 'task_assembly_failed' }>['step'],
    operation: () => void | Promise<void>
): Promise<boolean> {
    if (!stillOwned(dependencies.taskManager, task)) return false;
    try {
        await operation();
    } catch {
        report(dependencies, { code: 'task_assembly_failed', step });
    }
    return stillOwned(dependencies.taskManager, task);
}

export async function createHostSessionTask(
    input: HostSessionTaskCreationInput,
    dependencies: HostSessionTaskCreationDependencies
): Promise<HostSessionTaskCreationResult> {
    const configuredNodeId = dependencies.getDefaultExecutionNodeId().trim();
    let executionHost: ExecutionHost = { type: 'local' };
    if (configuredNodeId) {
        const node = dependencies.getExecutionNode(configuredNodeId);
        if (!node) {
            report(dependencies, { code: 'execution_node_unavailable' });
            return { status: 'not_created' };
        }
        executionHost = {
            type: 'node',
            nodeId: node.nodeId,
            ...(node.displayName ? { nodeLabel: node.displayName } : {}),
            capabilities: node
        };
    }

    const task = dependencies.taskManager.createTask();
    if (
        !(await bestEffort(dependencies, task, 'init_harness', () =>
            dependencies.taskManager.initHarness(task, input.workspace, task.getAgentMode())
        ))
    ) {
        return { status: 'created', taskId: task.task_id, workspace: input.workspace };
    }
    if (!(await bestEffort(dependencies, task, 'set_execution_host', () => task.setExecutionHost(executionHost)))) {
        return { status: 'created', taskId: task.task_id, workspace: input.workspace };
    }
    if (!(await bestEffort(dependencies, task, 'rebuild_system_prompt', () => task.rebuildSystemPrompt()))) {
        return { status: 'created', taskId: task.task_id, workspace: input.workspace };
    }
    await bestEffort(dependencies, task, 'publish_task_list', () => dependencies.taskManager.publishTaskListUpdate());
    return { status: 'created', taskId: task.task_id, workspace: input.workspace };
}
