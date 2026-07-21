/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    computeWorkflowRevision,
    createWorkflowDefinition,
    updateWorkflowDefinition,
    type WorkflowDefinition,
    type WorkflowJSONValue
} from '../../../../main/aikernel/workflow.js';
import { WorkflowManager } from '../../../../main/applications/workflow/manager.js';
import type {
    WorkflowRuntimeEngine,
    WorkflowRuntimeExecution,
    WorkflowRuntimeStartInput
} from '../../../../main/applications/workflow/run/runtime/host.js';

const BUILTIN_CONTENT = {
    name: 'example',
    description: 'Example built-in Workflow',
    script: 'return args;',
    inputSchema: {
        type: 'object',
        properties: {
            value: { type: 'string' }
        },
        required: ['value'],
        additionalProperties: false
    },
    phases: [
        { name: 'First phase', description: 'Run the first step' },
        { name: 'Second phase', description: 'Run the second step' }
    ]
};

const BUILTIN: WorkflowDefinition = {
    id: 'builtin-example',
    revision: computeWorkflowRevision(BUILTIN_CONTENT),
    ...BUILTIN_CONTENT,
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z'
};

class ControlledRuntime implements WorkflowRuntimeEngine {
    input?: WorkflowRuntimeStartInput;
    stopCount = 0;
    private resolveCompletion?: (value: WorkflowJSONValue) => void;
    private rejectCompletion?: (error: Error) => void;

    validateSource(source: string): void {
        if (!source.trim()) {
            throw new Error('empty source');
        }
    }

    async start(input: WorkflowRuntimeStartInput): Promise<WorkflowRuntimeExecution> {
        this.input = input;
        return {
            completion: new Promise<WorkflowJSONValue>((resolve, reject) => {
                this.resolveCompletion = resolve;
                this.rejectCompletion = reject;
            }),
            stop: async () => {
                this.stopCount += 1;
                this.rejectCompletion?.(new Error('stopped'));
            }
        };
    }

    complete(value: WorkflowJSONValue): void {
        this.resolveCompletion?.(value);
    }
}

test('WorkflowManager persists reports in one Task-owned run and maintains a lightweight global index', async () => {
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'opendesk-workflow-manager-'));
    const runtime = new ControlledRuntime();
    try {
        const manager = createManager(dataDirectory, runtime);
        const launch = await manager.launch('example', { value: 'hello' }, 'task-host', 'Host Task');

        await runtime.input?.host.phase('First phase');
        await runtime.input?.host.agent({
            title: 'Research sources',
            prompt: 'Find sources'
        });
        await runtime.input?.host.report({ summary: 'Research complete', file: 'reports/brief.html' });
        runtime.complete({ answer: 42 });
        await waitFor(async () => {
            if (manager.getRun(launch.runId)?.status !== 'succeeded') {
                return false;
            }
            const index = JSON.parse(await readFile(path.join(dataDirectory, 'workflow-run-index.json'), 'utf8'));
            return index.runs[0]?.status === 'succeeded';
        });

        const persistedRun = JSON.parse(
            await readFile(path.join(dataDirectory, 'task-host', 'workflow-runs', launch.runId, 'run.json'), 'utf8')
        );
        assert.equal(persistedRun.definition.id, BUILTIN.id);
        assert.equal(persistedRun.definition.revision, BUILTIN.revision);
        assert.equal(persistedRun.status, 'succeeded');
        assert.deepEqual(persistedRun.reports, [{ summary: 'Research complete', file: 'reports/brief.html' }]);

        const index = JSON.parse(await readFile(path.join(dataDirectory, 'workflow-run-index.json'), 'utf8'));
        assert.deepEqual(index.runs, [
            {
                runId: launch.runId,
                workflowName: 'example',
                hostTaskId: 'task-host',
                hostTaskName: 'Host Task',
                status: 'succeeded',
                startedAt: persistedRun.startedAt,
                updatedAt: persistedRun.updatedAt
            }
        ]);

        const restored = createManager(dataDirectory, new ControlledRuntime());
        assert.equal(restored.listRuns()[0].runId, launch.runId);
        assert.equal(restored.getRun(launch.runId)?.output?.answer, 42);
    } finally {
        await rm(dataDirectory, { recursive: true, force: true });
    }
});

test('WorkflowManager stops the runtime and active Workflow agents', async () => {
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'opendesk-workflow-manager-'));
    const runtime = new ControlledRuntime();
    let releaseAgent: (() => void) | undefined;
    const stoppedAgentRuns: string[] = [];
    try {
        const manager = new WorkflowManager({
            dataDirectory,
            runRootDirectory: dataDirectory,
            runtime,
            builtins: [BUILTIN],
            runAgent: () =>
                new Promise((resolve) => {
                    releaseAgent = () => resolve({ status: 'success', summary: 'released' });
                }),
            stopRunAgents: async (runId) => {
                stoppedAgentRuns.push(runId);
                releaseAgent?.();
            }
        });
        const launch = await manager.launch('example', { value: 'hello' }, 'task-host');
        await runtime.input?.host.phase('First phase');
        const agent = runtime.input?.host.agent({
            title: 'Active agent',
            prompt: 'Keep working'
        });
        await waitFor(
            () => releaseAgent !== undefined && manager.getRun(launch.runId)?.agents[0]?.status === 'running'
        );

        const stopped = await manager.stop(launch.runId);
        await agent;

        assert.equal(stopped.status, 'cancelled');
        assert.equal(stopped.phases[0].status, 'cancelled');
        assert.equal(stopped.agents[0].status, 'cancelled');
        assert.equal(runtime.stopCount, 1);
        assert.deepEqual(stoppedAgentRuns, [launch.runId]);
    } finally {
        await rm(dataDirectory, { recursive: true, force: true });
    }
});

test('WorkflowManager reconciles a persisted running run after process restart', async () => {
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'opendesk-workflow-manager-'));
    const runtime = new ControlledRuntime();
    try {
        const manager = createManager(dataDirectory, runtime);
        const launch = await manager.launch('example', { value: 'hello' }, 'task-host');
        await runtime.input?.host.phase('First phase');

        const restarted = createManager(dataDirectory, new ControlledRuntime());
        const recovered = restarted.getRun(launch.runId);

        assert.equal(recovered?.status, 'failed');
        assert.equal(recovered?.phases[0].status, 'failed');
        assert.ok(recovered?.error);
        assert.equal(recovered?.failure?.code, 'runtime_failed');
        assert.equal(restarted.listRuns()[0].status, 'failed');
    } finally {
        await rm(dataDirectory, { recursive: true, force: true });
    }
});

test('Workflow Definition identity is stable while executable revisions are immutable', () => {
    const first = createWorkflowDefinition(
        {
            name: 'daily-brief',
            description: 'Create a daily brief',
            script: 'return args;',
            inputSchema: { type: 'object' }
        },
        {
            id: 'workflow-lineage',
            now: '2026-07-19T00:00:00.000Z',
            validateSource: () => undefined
        }
    );
    const updated = updateWorkflowDefinition(
        first,
        {
            name: 'daily-brief',
            description: 'Create a daily brief',
            script: 'return { value: args.value };',
            inputSchema: { type: 'object' }
        },
        {
            now: '2026-07-20T00:00:00.000Z',
            validateSource: () => undefined
        }
    );

    assert.equal(updated.id, first.id);
    assert.equal(updated.createdAt, first.createdAt);
    assert.equal(updated.updatedAt, '2026-07-20T00:00:00.000Z');
    assert.notEqual(updated.revision, first.revision);
    assert.equal(first.script, 'return args;');
});

function createManager(dataDirectory: string, runtime: WorkflowRuntimeEngine): WorkflowManager {
    return new WorkflowManager({
        dataDirectory,
        runRootDirectory: dataDirectory,
        runtime,
        builtins: [BUILTIN],
        runAgent: async () => ({
            status: 'success',
            summary: 'Agent completed',
            output: { sources: 3 }
        })
    });
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (await predicate()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Timed out waiting for Workflow state');
}
