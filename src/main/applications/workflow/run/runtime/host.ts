/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * 职责：承载隔离的 Workflow 执行，并桥接最小 Runtime 调用。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import vm from 'node:vm';

import type { WorkflowJSONValue } from '../../../../aikernel/workflow.js';
import { t } from '../../../../../locale/index.js';
import type { WorkflowAgentRequest, WorkflowAgentResult } from '../../agent/contract.js';
import { collectDisallowedWorkflowAgentTools } from '../../agent/policy.js';

const WORKER_START_TIMEOUT_MS = 5_000;
const WORKFLOW_WALL_TIMEOUT_MS = 30 * 60 * 1_000;

export interface WorkflowRuntimeHost {
    phase(name: string): Promise<void>;
    agent(request: WorkflowAgentRequest): Promise<WorkflowAgentResult>;
    report(value: WorkflowJSONValue): Promise<WorkflowJSONValue>;
}

export interface WorkflowRuntimeStartInput {
    runId: string;
    script: string;
    input: WorkflowJSONValue;
    host: WorkflowRuntimeHost;
}

export interface WorkflowRuntimeExecution {
    completion: Promise<WorkflowJSONValue>;
    stop(): Promise<void>;
}

export interface WorkflowRuntimeEngine {
    validateSource(source: string): void;
    start(input: WorkflowRuntimeStartInput): Promise<WorkflowRuntimeExecution>;
}

export interface WorkflowWorker {
    postMessage(value: WorkflowRuntimeWorkerInbound): void;
    on(event: 'message', listener: (value: WorkflowRuntimeWorkerOutbound) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: 'exit', listener: (code: number) => void): this;
    terminate(): Promise<number>;
}

export interface WorkflowRuntimeOptions {
    workerPath?: string;
    workerFactory?: (filename: string, options: WorkerOptions) => WorkflowWorker;
    startTimeoutMs?: number;
    wallTimeoutMs?: number;
}

export class WorkflowRuntime implements WorkflowRuntimeEngine {
    private readonly workerPath?: string;
    private readonly workerFactory: NonNullable<WorkflowRuntimeOptions['workerFactory']>;
    private readonly startTimeoutMs: number;
    private readonly wallTimeoutMs: number;

    constructor(options: WorkflowRuntimeOptions = {}) {
        this.workerPath = options.workerPath;
        this.workerFactory =
            options.workerFactory ??
            ((filename, workerOptions) => new Worker(filename, workerOptions) as WorkflowWorker);
        this.startTimeoutMs = options.startTimeoutMs ?? WORKER_START_TIMEOUT_MS;
        this.wallTimeoutMs = options.wallTimeoutMs ?? WORKFLOW_WALL_TIMEOUT_MS;
    }

    validateSource(source: string): void {
        if (!source.trim()) {
            throw new Error(t('workflow.error.scriptEmpty'));
        }
        if (/(^|\s)(?:import|export)\s/m.test(source)) {
            throw new Error(t('workflow.error.scriptModuleSyntax'));
        }
        new vm.Script(['(async function workflowMain() {', '"use strict";', source, '})'].join('\n'), {
            filename: 'workflow.validation.js'
        });
    }

    async start(input: WorkflowRuntimeStartInput): Promise<WorkflowRuntimeExecution> {
        this.validateSource(input.script);
        const worker = this.workerFactory(this.workerPath ?? resolveWorkflowRuntimeWorkerPath(), {
            resourceLimits: {
                maxOldGenerationSizeMb: 128,
                maxYoungGenerationSizeMb: 32,
                stackSizeMb: 4
            }
        });
        let accepted = false;
        let settled = false;
        let reported = false;
        let termination: Promise<number> | undefined;
        let resolveAccepted!: () => void;
        let rejectAccepted!: (reason: Error) => void;
        let resolveCompletion!: (value: WorkflowJSONValue) => void;
        let rejectCompletion!: (reason: Error) => void;
        const acceptedPromise = new Promise<void>((resolve, reject) => {
            resolveAccepted = resolve;
            rejectAccepted = reject;
        });
        const completion = new Promise<WorkflowJSONValue>((resolve, reject) => {
            resolveCompletion = resolve;
            rejectCompletion = reject;
        });
        const startTimer = setTimeout(() => {
            fail(new Error(t('workflow.error.runtimeStartTimeout', { timeout: this.startTimeoutMs })));
        }, this.startTimeoutMs);
        let wallTimer: ReturnType<typeof setTimeout> | undefined;

        const terminateWorker = (): Promise<number> => {
            termination ??= worker.terminate();
            return termination;
        };
        const cleanup = (): void => {
            clearTimeout(startTimer);
            if (wallTimer) {
                clearTimeout(wallTimer);
            }
            void terminateWorker().catch(() => undefined);
        };
        const fail = (error: Error): void => {
            if (settled) {
                return;
            }
            settled = true;
            if (!accepted) {
                rejectAccepted(error);
            } else {
                rejectCompletion(error);
            }
            cleanup();
        };
        const complete = (value: WorkflowJSONValue): void => {
            if (settled) {
                return;
            }
            settled = true;
            resolveCompletion(value);
            cleanup();
        };

        worker.on('message', (message) => {
            if (message.type === 'ready') {
                worker.postMessage({
                    type: 'start',
                    runId: input.runId,
                    script: input.script,
                    input: input.input
                });
                return;
            }
            if (message.type === 'accepted' && message.runId === input.runId) {
                accepted = true;
                clearTimeout(startTimer);
                wallTimer = setTimeout(() => {
                    fail(new Error(t('workflow.error.runTimeout', { timeout: this.wallTimeoutMs })));
                }, this.wallTimeoutMs);
                resolveAccepted();
                return;
            }
            if (message.type === 'host_request') {
                void this.handleHostRequest(input, worker, message, () => {
                    reported = true;
                });
                return;
            }
            if (message.type === 'completed' && message.runId === input.runId) {
                if (!reported) {
                    fail(new Error(t('workflow.error.reportRequired')));
                    return;
                }
                complete(message.output);
                return;
            }
            if (message.type === 'failed' && message.runId === input.runId) {
                fail(new Error(message.error));
            }
        });
        worker.on('error', fail);
        worker.on('exit', (code) => {
            if (!settled) {
                fail(new Error(t('workflow.error.runtimeExited', { code })));
            }
        });

        await acceptedPromise;
        return {
            completion,
            stop: async () => {
                if (settled) {
                    await termination?.catch(() => undefined);
                    return;
                }
                settled = true;
                clearTimeout(startTimer);
                if (wallTimer) {
                    clearTimeout(wallTimer);
                }
                rejectCompletion(new Error(t('workflow.error.stopped')));
                await terminateWorker().catch(() => undefined);
            }
        };
    }

    private async handleHostRequest(
        input: WorkflowRuntimeStartInput,
        worker: WorkflowWorker,
        message: Extract<WorkflowRuntimeWorkerOutbound, { type: 'host_request' }>,
        onReport: () => void
    ): Promise<void> {
        try {
            let value: WorkflowJSONValue = null;
            if (message.method === 'phase') {
                await input.host.phase(String(message.value));
            } else if (message.method === 'agent') {
                value = (await input.host.agent(
                    parseWorkflowAgentRequest(message.value)
                )) as unknown as WorkflowJSONValue;
            } else {
                value = await input.host.report(message.value);
                onReport();
            }
            worker.postMessage({ type: 'host_response', requestId: message.requestId, ok: true, value });
        } catch (err) {
            worker.postMessage({
                type: 'host_response',
                requestId: message.requestId,
                ok: false,
                error: err instanceof Error ? err.message : String(err)
            });
        }
    }
}

function parseWorkflowAgentRequest(value: WorkflowJSONValue): WorkflowAgentRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.prompt !== 'string') {
        throw new Error(t('workflow.error.agentRequestPrompt'));
    }
    const allowedTools = value.allowedTools;
    if (
        allowedTools !== undefined &&
        (!Array.isArray(allowedTools) || !allowedTools.every((toolName) => typeof toolName === 'string'))
    ) {
        throw new Error(t('workflow.error.agentRequestAllowedTools'));
    }
    const disallowedTools = collectDisallowedWorkflowAgentTools(allowedTools ?? []);
    if (disallowedTools.length > 0) {
        throw new Error(
            t('workflow.error.agentToolNotAllowed', {
                tools: disallowedTools.join(', ')
            })
        );
    }
    const reasoningEffort = value.reasoningEffort;
    if (
        reasoningEffort !== undefined &&
        reasoningEffort !== 'low' &&
        reasoningEffort !== 'medium' &&
        reasoningEffort !== 'high'
    ) {
        throw new Error(t('workflow.error.agentRequestReasoningEffort'));
    }
    const outputSchema = value.outputSchema;
    if (
        outputSchema !== undefined &&
        (!outputSchema || typeof outputSchema !== 'object' || Array.isArray(outputSchema))
    ) {
        throw new Error(t('workflow.error.agentRequestOutputSchema'));
    }
    return {
        prompt: value.prompt,
        ...(typeof value.title === 'string' ? { title: value.title } : {}),
        ...(allowedTools === undefined ? {} : { allowedTools: [...allowedTools] }),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        ...(typeof value.model === 'string' ? { model: value.model } : {}),
        ...(outputSchema === undefined ? {} : { outputSchema: structuredClone(outputSchema) })
    };
}

export function resolveWorkflowRuntimeWorkerPath(baseUrl: string | URL = import.meta.url): string {
    const moduleDirectory = path.dirname(fileURLToPath(baseUrl));
    const candidates = [
        path.join(moduleDirectory, 'workflow-runtime-worker.js'),
        path.join(moduleDirectory, '..', 'workflow-runtime-worker.js'),
        path.join(moduleDirectory, 'runtime', 'workflow-runtime-worker.js')
    ];
    const resolved = candidates.find((candidate) => existsSync(candidate));
    if (!resolved) {
        throw new Error(t('workflow.error.runtimeArtifactMissing', { path: moduleDirectory }));
    }
    return resolved;
}

export type WorkflowRuntimeHostMethod = 'phase' | 'agent' | 'report';

export type WorkflowRuntimeWorkerInbound =
    | {
          type: 'start';
          runId: string;
          script: string;
          input: WorkflowJSONValue;
      }
    | {
          type: 'host_response';
          requestId: string;
          ok: true;
          value: WorkflowJSONValue;
      }
    | {
          type: 'host_response';
          requestId: string;
          ok: false;
          error: string;
      };

export type WorkflowRuntimeWorkerOutbound =
    | { type: 'ready' }
    | { type: 'accepted'; runId: string }
    | {
          type: 'host_request';
          requestId: string;
          method: WorkflowRuntimeHostMethod;
          value: WorkflowJSONValue;
      }
    | { type: 'completed'; runId: string; output: WorkflowJSONValue }
    | { type: 'failed'; runId: string; error: string };
