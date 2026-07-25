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
 * 职责：定义 Workflow Agent 在 Runner、Manager 与 Runtime 之间共享的稳定调用契约。
 */

import type { WorkflowJSONValue } from '../../../aikernel/workflow.js';

export interface WorkflowAgentRequest {
    prompt: string;
    title?: string;
    allowedTools?: string[];
    reasoningEffort?: 'low' | 'medium' | 'high';
    model?: string;
    outputSchema?: Record<string, unknown>;
}

export interface WorkflowAgentResult {
    status: 'success' | 'fail';
    summary: string;
    output?: WorkflowJSONValue;
}

export interface WorkflowAgentExecutionFailure {
    code: 'completion_not_submitted';
    message: string;
}

export class WorkflowAgentExecutionError extends Error {
    constructor(readonly failure: WorkflowAgentExecutionFailure) {
        super(failure.message);
        this.name = 'WorkflowAgentExecutionError';
    }
}
