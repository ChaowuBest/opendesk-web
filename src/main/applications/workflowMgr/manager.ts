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

/**
 * 职责：编排 Workflow Definition，并作为 Workflow Run 状态的唯一写入者。
 */

import crypto from 'node:crypto';

import {
    WorkflowValidationError,
    collectWorkflowDefinitionErrors,
    createWorkflowDefinition,
    validateWorkflowDefinition,
    validateWorkflowInput,
    type WorkflowAgentSnapshot,
    type WorkflowDefinition,
    type WorkflowDefinitionInput,
    type WorkflowFailure,
    type WorkflowJSONValue,
    type WorkflowRun,
    type WorkflowRunPhase
} from '../../aikernel/workflow.js';
import { t } from '../../../locale/index.js';
import { WorkflowAgentExecutionError, type WorkflowAgentRequest, type WorkflowAgentResult } from './agent/contract.js';
import type { WorkflowRuntimeEngine, WorkflowRuntimeExecution, WorkflowRuntimeHost } from './run/runtime/host.js';
import { WorkflowStorage, toWorkflowRunSummary, type WorkflowRunSummary } from './storage.js';

export interface WorkflowLaunchResult {
    runId: string;
    workflowName: string;
    status: 'started';
    message: string;
}

export type WorkflowDefinitionSource = 'builtin' | 'saved';

export interface AvailableWorkflowDefinition {
    source: WorkflowDefinitionSource;
    definition: WorkflowDefinition;
}

export interface WorkflowManagerOptions {
    dataDirectory: string;
    runRootDirectory: string;
    runtime: WorkflowRuntimeEngine;
    builtins: WorkflowDefinition[];
    runAgent: (request: WorkflowAgentRequest, run: WorkflowRun) => Promise<WorkflowAgentResult>;
    onRunUpdated?: (run: WorkflowRun) => void;
    onRunCompleted?: (run: WorkflowRun) => void;
    stopRunAgents?: (runId: string) => Promise<void>;
    clock?: () => Date;
}

export class WorkflowManager {
    private readonly runtime: WorkflowRuntimeEngine;
    private readonly storage: WorkflowStorage;
    private readonly builtins: WorkflowDefinition[];
    private readonly definitions: WorkflowDefinition[];
    private readonly runAgent: WorkflowManagerOptions['runAgent'];
    private readonly onRunUpdated?: WorkflowManagerOptions['onRunUpdated'];
    private readonly onRunCompleted?: WorkflowManagerOptions['onRunCompleted'];
    private readonly stopRunAgents?: WorkflowManagerOptions['stopRunAgents'];
    private readonly clock: () => Date;
    private readonly runIndex = new Map<string, WorkflowRunSummary>();
    private readonly runCache = new Map<string, WorkflowRun>();
    private readonly activeExecutions = new Map<string, WorkflowRuntimeExecution>();

    constructor(options: WorkflowManagerOptions) {
        this.storage = new WorkflowStorage(options.dataDirectory, options.runRootDirectory);
        this.runtime = options.runtime;
        this.builtins = options.builtins.map((definition) => structuredClone(definition));
        this.definitions = this.storage.loadDefinitions();
        this.runAgent = options.runAgent;
        this.onRunUpdated = options.onRunUpdated;
        this.onRunCompleted = options.onRunCompleted;
        this.stopRunAgents = options.stopRunAgents;
        this.clock = options.clock ?? (() => new Date());
        for (const summary of this.storage.loadRunIndex()) {
            this.runIndex.set(summary.runId, summary);
        }
        this.reconcileInterruptedRuns();
    }

    listAvailableDefinitions(): AvailableWorkflowDefinition[] {
        return [
            ...this.definitions.map((definition) => ({
                source: 'saved' as const,
                definition: structuredClone(definition)
            })),
            ...this.builtins.map((definition) => ({
                source: 'builtin' as const,
                definition: structuredClone(definition)
            }))
        ];
    }

    listRuns(): WorkflowRunSummary[] {
        return [...this.runIndex.values()]
            .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
            .map((summary) => structuredClone(summary));
    }

    getRun(runId: string): WorkflowRun | undefined {
        const cached = this.runCache.get(runId);
        if (cached) {
            return structuredClone(cached);
        }
        const summary = this.runIndex.get(runId);
        if (!summary) {
            return undefined;
        }
        const run = this.storage.loadRun(summary.hostTaskId, runId);
        if (!run) {
            return undefined;
        }
        this.runCache.set(run.id, run);
        return structuredClone(run);
    }

    collectDefinitionValidationErrors(
        input: WorkflowDefinitionInput,
        options: { allowNameCollision?: boolean } = {}
    ): string[] {
        const errors = collectWorkflowDefinitionErrors(input, this.runtime);
        const name = input.name.trim().toLowerCase();
        if (!options.allowNameCollision && this.resolveDefinition(name)) {
            errors.push(t('workflow.error.alreadyExists', { name }));
        }
        return [...new Set(errors)];
    }

    validateInput(schema: Record<string, unknown>, input: WorkflowJSONValue): WorkflowJSONValue {
        return validateWorkflowInput(schema, input);
    }

    createDefinition(
        input: WorkflowDefinitionInput,
        options: { allowNameCollision?: boolean } = {}
    ): WorkflowDefinition {
        const errors: string[] = [];
        let definition: WorkflowDefinition | undefined;
        try {
            definition = createWorkflowDefinition(input, {
                id: `workflow_${crypto.randomUUID()}`,
                now: this.clock().toISOString(),
                validateSource: (source) => this.runtime.validateSource(source)
            });
        } catch (error) {
            if (!(error instanceof WorkflowValidationError)) {
                throw error;
            }
            errors.push(...error.errors);
        }
        const name = input.name.trim().toLowerCase();
        if (!options.allowNameCollision && this.resolveDefinition(name)) {
            errors.push(t('workflow.error.alreadyExists', { name }));
        }
        if (errors.length > 0) {
            throw new WorkflowValidationError([...new Set(errors)]);
        }
        if (!definition) {
            throw new Error(t('workflow.error.authoringFailed'));
        }
        return definition;
    }

    async launch(
        target: string | WorkflowDefinition,
        requestedInput: WorkflowJSONValue | undefined,
        hostTaskId: string,
        hostTaskName?: string
    ): Promise<WorkflowLaunchResult> {
        const definition = typeof target === 'string' ? this.resolveDefinition(target) : structuredClone(target);
        if (!definition) {
            throw new Error(t('workflow.error.notFound', { reference: target }));
        }
        return await this.launchDefinition(definition, requestedInput, hostTaskId, hostTaskName);
    }

    private async launchDefinition(
        definition: WorkflowDefinition,
        requestedInput: WorkflowJSONValue | undefined,
        hostTaskId: string,
        hostTaskName?: string
    ): Promise<WorkflowLaunchResult> {
        validateWorkflowDefinition(definition, this.runtime);
        const input = validateWorkflowInput(definition.inputSchema, requestedInput ?? {});
        const startedAt = this.clock().toISOString();
        const run: WorkflowRun = {
            id: `run_${crypto.randomUUID()}`,
            definition: structuredClone(definition),
            hostTaskId,
            status: 'running',
            input,
            phases: definition.phases.map((phase) => ({
                id: `phase_${crypto.randomUUID()}`,
                name: phase.name,
                ...(phase.description ? { description: phase.description } : {}),
                status: 'pending'
            })),
            agents: [],
            reports: [],
            startedAt,
            updatedAt: startedAt
        };
        this.runCache.set(run.id, run);
        await this.persistRun(run, hostTaskName);
        this.emitRunUpdated(run);

        try {
            const execution = await this.runtime.start({
                runId: run.id,
                script: definition.script,
                input,
                host: this.createRuntimeHost(run)
            });
            this.activeExecutions.set(run.id, execution);
            void execution.completion
                .then(
                    (output) => this.finishRun(run, output),
                    (error) => this.failRun(run, error)
                )
                .finally(() => {
                    if (this.activeExecutions.get(run.id) === execution) {
                        this.activeExecutions.delete(run.id);
                    }
                });
        } catch (error) {
            await this.failRun(run, error, false);
            throw error;
        }

        return {
            runId: run.id,
            workflowName: definition.name,
            status: 'started',
            message: t('workflow.launch.started', { name: definition.name })
        };
    }

    async stop(runId: string): Promise<WorkflowRun> {
        const run = this.getMutableRun(runId);
        if (!run) {
            throw new Error(t('workflow.error.runNotFound', { runId }));
        }
        if (run.status !== 'running') {
            return structuredClone(run);
        }

        run.status = 'cancelled';
        run.completedAt = this.clock().toISOString();
        this.finishCurrentPhase(run, 'cancelled');
        this.finishActiveAgents(run, 'cancelled');
        const execution = this.activeExecutions.get(run.id);
        this.activeExecutions.delete(run.id);
        await Promise.allSettled([
            execution?.stop() ?? Promise.resolve(),
            this.stopRunAgents?.(run.id) ?? Promise.resolve()
        ]);
        await this.persistRun(run);
        this.emitRunUpdated(run);
        return structuredClone(run);
    }

    private resolveDefinition(reference: string): WorkflowDefinition | undefined {
        const normalized = reference.trim().toLowerCase();
        return [...this.builtins, ...this.definitions].find(
            (definition) => definition.id === reference || definition.name === normalized
        );
    }

    private getMutableRun(runId: string): WorkflowRun | undefined {
        const cached = this.runCache.get(runId);
        if (cached) {
            return cached;
        }
        const summary = this.runIndex.get(runId);
        if (!summary) {
            return undefined;
        }
        const run = this.storage.loadRun(summary.hostTaskId, runId);
        if (run) {
            this.runCache.set(run.id, run);
        }
        return run;
    }

    private createRuntimeHost(run: WorkflowRun): WorkflowRuntimeHost {
        return {
            phase: async (name) => {
                this.assertRunActive(run);
                const now = this.clock().toISOString();
                const current = run.phases.find((phase) => phase.status === 'running');
                if (current?.status === 'running') {
                    current.status = 'succeeded';
                    current.completedAt = now;
                }
                const phaseName = name.trim() || t('workflow.phase.untitled');
                const phase = run.phases.find(
                    (candidate) => candidate.status === 'pending' && candidate.name === phaseName
                );
                if (!phase) {
                    throw new Error(t('workflow.error.phaseNotDeclared', { name: phaseName }));
                }
                phase.status = 'running';
                phase.startedAt = now;
                await this.persistRun(run);
                this.emitRunUpdated(run);
            },
            agent: async (request) => {
                this.assertRunActive(run);
                const phase = this.ensureCurrentPhase(run);
                const snapshot: WorkflowAgentSnapshot = {
                    id: `agent_${crypto.randomUUID()}`,
                    phaseId: phase.id,
                    title: request.title?.trim() || t('workflow.agent.untitled'),
                    prompt: request.prompt,
                    status: 'running',
                    startedAt: this.clock().toISOString()
                };
                run.agents.push(snapshot);
                await this.persistRun(run);
                this.emitRunUpdated(run);
                try {
                    const result = await this.runAgent(request, structuredClone(run));
                    if (snapshot.status === 'running') {
                        snapshot.status = result.status === 'success' ? 'succeeded' : 'failed';
                        snapshot.summary = result.summary;
                        if (result.status === 'fail') {
                            snapshot.failure = attachAgentContext(
                                {
                                    code: 'agent_failed',
                                    message: result.summary
                                },
                                snapshot,
                                phase
                            );
                        }
                        if (result.output !== undefined) {
                            snapshot.output = structuredClone(result.output);
                        }
                        snapshot.completedAt = this.clock().toISOString();
                    }
                    return result;
                } catch (error) {
                    if (snapshot.status === 'running') {
                        snapshot.status = run.status === 'cancelled' ? 'cancelled' : 'failed';
                        snapshot.error = error instanceof Error ? error.message : String(error);
                        if (snapshot.status === 'failed') {
                            snapshot.failure = attachAgentContext(workflowAgentFailure(error), snapshot, phase);
                        }
                        snapshot.completedAt = this.clock().toISOString();
                    }
                    throw error;
                } finally {
                    await this.persistRun(run);
                    this.emitRunUpdated(run);
                }
            },
            report: async (value) => {
                this.assertRunActive(run);
                run.reports.push(structuredClone(value));
                await this.persistRun(run);
                this.emitRunUpdated(run);
                return null;
            }
        };
    }

    private async finishRun(run: WorkflowRun, output: WorkflowJSONValue): Promise<void> {
        if (run.status !== 'running') {
            return;
        }
        this.finishCurrentPhase(run, 'succeeded');
        run.status = 'succeeded';
        run.output = structuredClone(output);
        run.completedAt = this.clock().toISOString();
        await this.persistRun(run);
        this.emitRunUpdated(run);
        this.onRunCompleted?.(structuredClone(run));
    }

    private async failRun(run: WorkflowRun, error: unknown, notifyCompletion = true): Promise<void> {
        if (run.status !== 'running') {
            return;
        }
        this.finishCurrentPhase(run, 'failed');
        this.finishActiveAgents(run, 'failed');
        run.status = 'failed';
        const failedAgent = [...run.agents].reverse().find((agent) => agent.status === 'failed' && agent.failure);
        run.failure =
            failedAgent?.failure ??
            ({
                code: 'runtime_failed',
                message: error instanceof Error ? error.message : String(error)
            } satisfies WorkflowFailure);
        run.error = run.failure.message;
        run.completedAt = this.clock().toISOString();
        await Promise.allSettled([this.stopRunAgents?.(run.id) ?? Promise.resolve()]);
        await this.persistRun(run);
        this.emitRunUpdated(run);
        if (notifyCompletion) {
            this.onRunCompleted?.(structuredClone(run));
        }
    }

    private finishCurrentPhase(run: WorkflowRun, status: WorkflowRunPhase['status']): void {
        const current = run.phases.find((phase) => phase.status === 'running');
        if (current?.status === 'running') {
            current.status = status;
            current.completedAt = this.clock().toISOString();
        }
    }

    private finishActiveAgents(run: WorkflowRun, status: WorkflowAgentSnapshot['status']): void {
        const completedAt = this.clock().toISOString();
        for (const agent of run.agents) {
            if (agent.status === 'running') {
                agent.status = status;
                agent.completedAt = completedAt;
            }
        }
    }

    private ensureCurrentPhase(run: WorkflowRun): WorkflowRunPhase {
        const current = run.phases.find((phase) => phase.status === 'running');
        if (current?.status === 'running') {
            return current;
        }
        if (run.phases.length > 0) {
            throw new Error(t('workflow.error.agentOutsidePhase'));
        }
        const phase: WorkflowRunPhase = {
            id: `phase_${crypto.randomUUID()}`,
            name: t('workflow.phase.untitled'),
            status: 'running',
            startedAt: this.clock().toISOString()
        };
        run.phases.push(phase);
        return phase;
    }

    private assertRunActive(run: WorkflowRun): void {
        if (run.status !== 'running') {
            throw new Error(t('workflow.error.stopped'));
        }
    }

    private emitRunUpdated(run: WorkflowRun): void {
        this.onRunUpdated?.(structuredClone(run));
    }

    private reconcileInterruptedRuns(): void {
        let indexChanged = false;
        for (const summary of [...this.runIndex.values()]) {
            if (summary.status !== 'running') {
                continue;
            }
            const run = this.storage.loadRun(summary.hostTaskId, summary.runId);
            if (!run) {
                this.runIndex.delete(summary.runId);
                indexChanged = true;
                continue;
            }
            if (run.status === 'running') {
                const now = this.clock().toISOString();
                run.status = 'failed';
                run.error = t('workflow.error.interrupted');
                run.failure = {
                    code: 'runtime_failed',
                    message: run.error
                };
                run.completedAt = now;
                run.updatedAt = now;
                this.finishCurrentPhase(run, 'failed');
                this.finishActiveAgents(run, 'failed');
                this.storage.saveRunSynchronously(run);
            }
            this.runIndex.set(run.id, toWorkflowRunSummary(run, summary.hostTaskName));
            indexChanged = true;
        }
        if (indexChanged) {
            this.storage.saveRunIndexSynchronously([...this.runIndex.values()]);
        }
    }

    private async persistRun(run: WorkflowRun, hostTaskName?: string): Promise<void> {
        run.updatedAt = this.clock().toISOString();
        await this.storage.saveRun(run);
        const existingSummary = this.runIndex.get(run.id);
        this.runIndex.set(run.id, toWorkflowRunSummary(run, hostTaskName ?? existingSummary?.hostTaskName));
        await this.storage.saveRunIndex([...this.runIndex.values()]);
    }
}

function workflowAgentFailure(error: unknown): WorkflowFailure {
    if (error instanceof WorkflowAgentExecutionError) {
        return {
            code: 'agent_failed',
            message: error.failure.message
        };
    }
    return {
        code: 'agent_failed',
        message: error instanceof Error ? error.message : String(error)
    };
}

function attachAgentContext(
    failure: WorkflowFailure,
    agent: Pick<WorkflowAgentSnapshot, 'id' | 'phaseId' | 'title'>,
    phase: Pick<WorkflowRunPhase, 'id' | 'name'>
): WorkflowFailure {
    return {
        ...failure,
        phaseId: phase.id,
        phaseName: phase.name,
        agentId: agent.id,
        agentTitle: agent.title
    };
}
