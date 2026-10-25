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
 * 职责：在隔离的 Worker 沙箱中执行 Workflow JavaScript。
 */

import vm from 'node:vm';
import { parentPort } from 'node:worker_threads';

import { normalizeWorkflowJSONValue, type WorkflowJSONValue } from '../../../../aikernel/workflow.js';
import type { WorkflowAgentRequest, WorkflowAgentResult } from '../../agent/contract.js';
import type { WorkflowRuntimeHostMethod, WorkflowRuntimeWorkerInbound, WorkflowRuntimeWorkerOutbound } from './host.js';

const SCRIPT_CPU_TIMEOUT_MS = 1_000;
const pendingHostRequests = new Map<
    string,
    { resolve: (value: WorkflowJSONValue) => void; reject: (reason: Error) => void }
>();
let nextRequestId = 1;
let started = false;

if (!parentPort) {
    throw new Error('Workflow runtime worker 需要 parentPort。');
}

function post(message: WorkflowRuntimeWorkerOutbound): void {
    parentPort!.postMessage(message);
}

function requestHost(method: WorkflowRuntimeHostMethod, value: WorkflowJSONValue): Promise<WorkflowJSONValue> {
    const requestId = `host_${nextRequestId++}`;
    return new Promise<WorkflowJSONValue>((resolve, reject) => {
        pendingHostRequests.set(requestId, { resolve, reject });
        post({ type: 'host_request', requestId, method, value });
    });
}

async function executeWorkflow(runId: string, source: string, input: WorkflowJSONValue): Promise<void> {
    try {
        const sandbox = vm.createContext(
            {
                args: structuredClone(input),
                phase: (name: unknown) => requestHost('phase', String(name)),
                agent: async (prompt: unknown, options?: unknown) => {
                    const normalizedOptions =
                        options && typeof options === 'object'
                            ? (normalizeWorkflowJSONValue(options) as Omit<WorkflowAgentRequest, 'prompt'>)
                            : {};
                    const request: WorkflowAgentRequest = {
                        ...normalizedOptions,
                        prompt: String(prompt)
                    };
                    return (await requestHost(
                        'agent',
                        normalizeWorkflowJSONValue(request)
                    )) as unknown as WorkflowAgentResult;
                },
                report: (value: unknown) => requestHost('report', normalizeWorkflowJSONValue(value)),
                console: undefined
            },
            {
                name: `workflow-${runId}`,
                codeGeneration: {
                    strings: false,
                    wasm: false
                }
            }
        );
        const script = new vm.Script(
            ['(async function workflowMain() {', '"use strict";', source, '}).call(undefined)'].join('\n'),
            { filename: `${runId}.workflow.js` }
        );
        const output = await script.runInContext(sandbox, {
            timeout: SCRIPT_CPU_TIMEOUT_MS,
            breakOnSigint: true
        });
        post({ type: 'completed', runId, output: normalizeWorkflowJSONValue(output) });
    } catch (err) {
        post({
            type: 'failed',
            runId,
            error: err instanceof Error ? err.message : String(err)
        });
    }
}

parentPort.on('message', (message: WorkflowRuntimeWorkerInbound) => {
    if (message.type === 'host_response') {
        const pending = pendingHostRequests.get(message.requestId);
        if (!pending) {
            return;
        }
        pendingHostRequests.delete(message.requestId);
        if (message.ok) {
            pending.resolve(message.value);
        } else {
            pending.reject(new Error((message as { error: string }).error));
        }
        return;
    }
    if (message.type !== 'start' || started) {
        return;
    }
    started = true;
    post({ type: 'accepted', runId: message.runId });
    void executeWorkflow(message.runId, message.script, message.input);
});

post({ type: 'ready' });
