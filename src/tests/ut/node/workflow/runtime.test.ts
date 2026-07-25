import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { normalizeWorkflowJSONValue } from '../../../../main/aikernel/workflow.js';
import {
    WorkflowRuntime,
    resolveWorkflowRuntimeWorkerPath,
    type WorkflowRuntimeWorkerInbound,
    type WorkflowRuntimeWorkerOutbound,
    type WorkflowWorker
} from '../../../../main/applications/workflowMgr/run/runtime/host.js';

test('WorkflowRuntime validates the minimal JavaScript contract', () => {
    const runtime = new WorkflowRuntime();

    assert.doesNotThrow(() => runtime.validateSource('await phase("one"); return args;'));
    assert.throws(() => runtime.validateSource(''), Error);
    assert.throws(() => runtime.validateSource('import fs from "node:fs";'), Error);
    assert.throws(() => runtime.validateSource('export default 1;'), Error);
});

test('Workflow JSON normalization is shared across tools, agents, and the worker boundary', () => {
    assert.deepEqual(
        normalizeWorkflowJSONValue({
            missing: undefined,
            invalidNumber: Number.NaN,
            nested: [1, true]
        }),
        {
            missing: null,
            invalidNumber: null,
            nested: [1, true]
        }
    );
});

test('WorkflowRuntime accepts immediately and bridges only the minimal host protocol', async () => {
    const emitter = new EventEmitter();
    const outbound: WorkflowRuntimeWorkerInbound[] = [];
    let terminated = false;
    const worker = {
        postMessage(message: WorkflowRuntimeWorkerInbound): void {
            outbound.push(message);
            if (message.type === 'start') {
                queueMicrotask(() => {
                    emitter.emit('message', {
                        type: 'accepted',
                        runId: message.runId
                    } satisfies WorkflowRuntimeWorkerOutbound);
                    emitter.emit('message', {
                        type: 'host_request',
                        requestId: 'host-1',
                        method: 'phase',
                        value: 'Scope'
                    } satisfies WorkflowRuntimeWorkerOutbound);
                });
            } else if (message.type === 'host_response' && message.requestId === 'host-1') {
                queueMicrotask(() => {
                    emitter.emit('message', {
                        type: 'host_request',
                        requestId: 'host-2',
                        method: 'agent',
                        value: {
                            prompt: 'Collect evidence',
                            title: 'Research',
                            allowedTools: ['WebSearch'],
                            reasoningEffort: 'low',
                            outputSchema: { type: 'object' }
                        }
                    } satisfies WorkflowRuntimeWorkerOutbound);
                });
            } else if (message.type === 'host_response' && message.requestId === 'host-2') {
                queueMicrotask(() => {
                    emitter.emit('message', {
                        type: 'host_request',
                        requestId: 'host-3',
                        method: 'report',
                        value: { answer: 42 }
                    } satisfies WorkflowRuntimeWorkerOutbound);
                });
            } else if (message.type === 'host_response' && message.requestId === 'host-3') {
                queueMicrotask(() => {
                    emitter.emit('message', {
                        type: 'completed',
                        runId: 'run-1',
                        output: { answer: 42 }
                    } satisfies WorkflowRuntimeWorkerOutbound);
                });
            }
        },
        on(event: string, listener: (...args: unknown[]) => void) {
            emitter.on(event, listener);
            return this;
        },
        async terminate(): Promise<number> {
            terminated = true;
            return 0;
        }
    } as WorkflowWorker;
    const phases: string[] = [];
    const agentRequests: unknown[] = [];
    const reports: unknown[] = [];
    const runtime = new WorkflowRuntime({
        workerPath: '/virtual/workflow-runtime-worker.js',
        workerFactory: () => {
            queueMicrotask(() => emitter.emit('message', { type: 'ready' } satisfies WorkflowRuntimeWorkerOutbound));
            return worker;
        },
        startTimeoutMs: 100,
        wallTimeoutMs: 1_000
    });

    const execution = await runtime.start({
        runId: 'run-1',
        script: 'await phase("Scope"); await report({answer: 42}); return {answer: 42};',
        input: {},
        host: {
            phase: async (name) => {
                phases.push(name);
            },
            agent: async (request) => {
                agentRequests.push(request);
                return { status: 'success', summary: 'collected', output: { sources: 2 } };
            },
            report: async (value) => {
                reports.push(value);
                return null;
            }
        }
    });
    const output = await execution.completion;

    assert.deepEqual(output, { answer: 42 });
    assert.deepEqual(phases, ['Scope']);
    assert.deepEqual(agentRequests, [
        {
            prompt: 'Collect evidence',
            title: 'Research',
            allowedTools: ['WebSearch'],
            reasoningEffort: 'low',
            outputSchema: { type: 'object' }
        }
    ]);
    assert.deepEqual(reports, [{ answer: 42 }]);
    assert.equal(outbound[0].type, 'start');
    assert.equal(outbound[1].type, 'host_response');
    assert.equal(outbound[2].type, 'host_response');
    assert.equal(outbound[3].type, 'host_response');
    assert.equal(terminated, true);
});

test('WorkflowRuntime accepts successful completion only after a report is published', async () => {
    const emitter = new EventEmitter();
    const worker = {
        postMessage(message: WorkflowRuntimeWorkerInbound): void {
            if (message.type === 'start') {
                queueMicrotask(() => {
                    emitter.emit('message', {
                        type: 'accepted',
                        runId: message.runId
                    } satisfies WorkflowRuntimeWorkerOutbound);
                    emitter.emit('message', {
                        type: 'completed',
                        runId: message.runId,
                        output: null
                    } satisfies WorkflowRuntimeWorkerOutbound);
                });
            }
        },
        on(event: string, listener: (...args: unknown[]) => void) {
            emitter.on(event, listener);
            return this;
        },
        async terminate(): Promise<number> {
            return 0;
        }
    } as WorkflowWorker;
    const runtime = new WorkflowRuntime({
        workerPath: '/virtual/workflow-runtime-worker.js',
        workerFactory: () => {
            queueMicrotask(() => emitter.emit('message', { type: 'ready' } satisfies WorkflowRuntimeWorkerOutbound));
            return worker;
        },
        startTimeoutMs: 100,
        wallTimeoutMs: 1_000
    });

    const execution = await runtime.start({
        runId: 'run-without-report',
        script: 'return null;',
        input: {},
        host: {
            phase: async () => undefined,
            agent: async () => ({ status: 'success', summary: 'unused' }),
            report: async () => null
        }
    });

    await assert.rejects(execution.completion, /report/);
});

test('WorkflowRuntime terminates a worker that never becomes ready', async () => {
    const emitter = new EventEmitter();
    let terminated = false;
    const worker = {
        postMessage() {},
        on(event: string, listener: (...args: unknown[]) => void) {
            emitter.on(event, listener);
            return this;
        },
        async terminate(): Promise<number> {
            terminated = true;
            return 0;
        }
    } as WorkflowWorker;
    const runtime = new WorkflowRuntime({
        workerPath: '/virtual/workflow-runtime-worker.js',
        workerFactory: () => worker,
        startTimeoutMs: 5
    });

    await assert.rejects(
        () =>
            runtime.start({
                runId: 'run-timeout',
                script: 'return null;',
                input: {},
                host: {
                    phase: async () => undefined,
                    agent: async () => ({ status: 'success', summary: 'unused' }),
                    report: async () => null
                }
            }),
        Error
    );
    assert.equal(terminated, true);
});

test('WorkflowRuntime stop rejects completion and terminates the accepted worker', async () => {
    const emitter = new EventEmitter();
    let terminated = false;
    const worker = {
        postMessage(message: WorkflowRuntimeWorkerInbound): void {
            if (message.type === 'start') {
                queueMicrotask(() => {
                    emitter.emit('message', {
                        type: 'accepted',
                        runId: message.runId
                    } satisfies WorkflowRuntimeWorkerOutbound);
                });
            }
        },
        on(event: string, listener: (...args: unknown[]) => void) {
            emitter.on(event, listener);
            return this;
        },
        async terminate(): Promise<number> {
            terminated = true;
            return 0;
        }
    } as WorkflowWorker;
    const runtime = new WorkflowRuntime({
        workerPath: '/virtual/workflow-runtime-worker.js',
        workerFactory: () => {
            queueMicrotask(() => emitter.emit('message', { type: 'ready' } satisfies WorkflowRuntimeWorkerOutbound));
            return worker;
        },
        startTimeoutMs: 100
    });
    const execution = await runtime.start({
        runId: 'run-stop',
        script: 'await new Promise(() => undefined);',
        input: {},
        host: {
            phase: async () => undefined,
            agent: async () => ({ status: 'success', summary: 'unused' }),
            report: async () => null
        }
    });

    await execution.stop();

    await assert.rejects(execution.completion, Error);
    assert.equal(terminated, true);
});

test('WorkflowRuntime resolves the Electron worker artifact beside the chunks directory', async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'opendesk-workflow-runtime-'));
    const chunksDirectory = path.join(outputDirectory, 'chunks');
    const workerPath = path.join(outputDirectory, 'workflow-runtime-worker.js');
    try {
        await mkdir(chunksDirectory);
        await writeFile(workerPath, '');

        const resolved = resolveWorkflowRuntimeWorkerPath(pathToFileURL(path.join(chunksDirectory, 'main-chunk.js')));

        assert.equal(resolved, workerPath);
    } finally {
        await rm(outputDirectory, { recursive: true, force: true });
    }
});
