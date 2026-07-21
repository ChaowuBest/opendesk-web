/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { StartInternalTurnOptions } from '../../../../main/aikernel/states/tasks.js';
import {
    deliverWorkflowRun,
    type WorkflowDeliveryTaskManager
} from '../../../../main/applications/workflow/run/delivery.js';
import type { WorkflowRun } from '../../../../main/aikernel/workflow.js';

const RUN: WorkflowRun = {
    id: 'run-1',
    definition: {
        id: 'workflow-1',
        revision: 'revision-1',
        name: 'daily-brief',
        description: 'Create a daily brief',
        script: 'return args;',
        inputSchema: { type: 'object' },
        phases: [],
        createdAt: '2026-07-19T00:00:00.000Z',
        updatedAt: '2026-07-19T00:00:00.000Z'
    },
    hostTaskId: 'task-host',
    status: 'succeeded',
    input: {},
    phases: [],
    agents: [],
    reports: [],
    startedAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:01:00.000Z',
    completedAt: '2026-07-19T00:01:00.000Z',
    output: { summary: 'done' }
};

test('Workflow completion waits for the active turn and returns after handing off one internal turn', async () => {
    const order: string[] = [];
    const turns: StartInternalTurnOptions[] = [];
    const task = {
        task_status: 'running' as const,
        async waitUntilFinished() {
            order.push('wait');
            this.task_status = 'stopped' as never;
        },
        async startInternalTurn(options: StartInternalTurnOptions) {
            order.push('start');
            turns.push(options);
            this.task_status = 'running' as never;
        }
    };
    const manager: WorkflowDeliveryTaskManager = {
        getTask: () => task
    };

    await deliverWorkflowRun(manager, RUN);

    assert.deepEqual(order, ['wait', 'start']);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].source, 'application');
    assert.equal(turns[0].metadata?.origin?.reason, 'workflow_completed');
    assert.match(turns[0].prompt, /"summary": "done"/);
    assert.match(turns[0].prompt, /交付本次 Workflow 的终态结果/);
    assert.match(turns[0].prompt, /忠实汇报结果、置信度、局限和可选下一步/);
    assert.match(turns[0].prompt, /然后结束本回合/);
});

test('Workflow completion is retained without delivery when the host Task no longer exists', async () => {
    const manager: WorkflowDeliveryTaskManager = {
        getTask: () => undefined
    };

    await assert.doesNotReject(() => deliverWorkflowRun(manager, RUN));
});

test('Workflow completion also queues behind a waiting Task turn', async () => {
    const order: string[] = [];
    const task = {
        task_status: 'waiting' as const,
        async waitUntilFinished() {
            order.push('wait');
            this.task_status = 'stopped' as never;
        },
        async startInternalTurn() {
            order.push('start');
            this.task_status = 'running' as never;
        }
    };

    await deliverWorkflowRun({ getTask: () => task }, RUN);

    assert.deepEqual(order, ['wait', 'start']);
});

test('Workflow failure delivery returns complete failure context without governing the parent Task', async () => {
    const turns: StartInternalTurnOptions[] = [];
    const failedRun: WorkflowRun = {
        ...RUN,
        status: 'failed',
        output: undefined,
        error: 'Workflow agent ended before submitting completion.',
        failure: {
            code: 'agent_failed',
            message: 'Workflow agent ended before submitting completion.',
            phaseId: 'phase-research',
            phaseName: 'Research',
            agentId: 'agent-sources',
            agentTitle: 'Find sources'
        }
    };
    const task = {
        task_status: 'stopped' as const,
        async waitUntilFinished() {
            this.task_status = 'stopped' as never;
        },
        async startInternalTurn(options: StartInternalTurnOptions) {
            turns.push(options);
            this.task_status = 'running' as never;
        }
    };

    await deliverWorkflowRun({ getTask: () => task }, failedRun);

    assert.equal(turns.length, 1);
    assert.match(turns[0].prompt, /"code": "agent_failed"/);
    assert.match(turns[0].prompt, /"phaseName": "Research"/);
    assert.match(turns[0].prompt, /"agentTitle": "Find sources"/);
    assert.match(turns[0].prompt, /交付本次 Workflow 的终态结果/);
});
