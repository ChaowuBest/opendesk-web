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
 * 职责：向 Authoring internal Task 注入完成校验、自查和有界返修 Hook。
 */

import type { TaskState } from '../../../aikernel/states/tasks.js';
import type { WorkflowDefinitionInput, WorkflowJSONSchema } from '../../../aikernel/workflow.js';
import { WorkflowAgentExecutionError } from '../agent/contract.js';
import type { WorkflowAgentRunOptions } from '../agent/runner.js';
import type { WorkflowAuthoringContext } from './context.js';
import {
    AUTHOR_WORKFLOW_OUTPUT_SCHEMA,
    WorkflowAuthoringValidationError,
    collectAuthoringErrors,
    parseAuthoredOutput,
    type ParsedAuthoredOutput,
    type WorkflowDefinitionValidationHost,
    type WorkflowToolCatalogEntry
} from './validation.js';

const MAX_AUTHORING_COMPLETION_REJECTIONS = 3;
const OMITTED_INVALID_AUTHORING_OUTPUT =
    '[omitted invalid CompleteWorkflowAgent output; submit the replacement as a structured object]';

export interface WorkflowAuthoringCompletionProgress {
    stage: 'validate' | 'review';
    attempt: number;
    definition?: WorkflowDefinitionInput;
    errors: string[];
}

export interface WorkflowAuthoringCompletionOptions {
    authoringContext: WorkflowAuthoringContext;
    hostTask: TaskState;
    toolCatalog: readonly WorkflowToolCatalogEntry[];
    validator: WorkflowDefinitionValidationHost;
    onProgress?: (update: WorkflowAuthoringCompletionProgress) => void;
}

export interface WorkflowAuthoringCompletion {
    configureTask: NonNullable<WorkflowAgentRunOptions['configureTask']>;
    getValidatedOutput(): ParsedAuthoredOutput | undefined;
    normalizeIncompleteError(error: unknown): unknown;
}

export function createWorkflowAuthoringCompletion(
    options: WorkflowAuthoringCompletionOptions
): WorkflowAuthoringCompletion {
    let validatedOutput: ParsedAuthoredOutput | undefined;
    let selfReviewRequested = false;
    let attempt = 0;
    let completionSubmissions = 0;
    let rejectedSubmissions = 0;
    const validationErrors: string[] = [];

    return {
        configureTask: (authoringTask, completionControl) => {
            authoringTask.hooks.afterToolCall(async ({ task: activeTask, toolCall }) => {
                if (toolCall.tool_name !== completionControl.toolName) {
                    return;
                }
                completionSubmissions += 1;
                try {
                    const completion = completionControl.parse(toolCall);
                    attempt += 1;
                    if (completion.status !== 'success' || !completion.output) {
                        const error = new Error(completion.summary || 'Workflow 创建失败。');
                        options.onProgress?.({
                            stage: 'validate',
                            attempt,
                            errors: [error.message]
                        });
                        throw error;
                    }
                    const output = parseAuthoredOutput(completion.output);
                    const errors = collectAuthoringErrors(
                        output,
                        options.toolCatalog,
                        options.hostTask,
                        options.validator
                    );
                    if (errors.length > 0) {
                        options.onProgress?.({
                            stage: 'validate',
                            attempt,
                            definition: output.definition,
                            errors
                        });
                        throw new WorkflowAuthoringValidationError(errors);
                    }
                    if (!selfReviewRequested) {
                        selfReviewRequested = true;
                        options.onProgress?.({
                            stage: 'review',
                            attempt,
                            definition: output.definition,
                            errors: []
                        });
                        const instruction = buildAuthoringSelfReviewPrompt(options.authoringContext);
                        toolCall.status = 'success';
                        toolCall.result_object = {
                            accepted: false,
                            reviewRequired: true,
                            instruction
                        };
                        toolCall.result = [
                            'Workflow Definition 已通过确定性校验，进入一次建议性语义自查。',
                            instruction,
                            '自查完成后，使用 workflow-agent-CompleteWorkflowAgent 再次提交完整 Definition；本次提交会再次经过确定性校验。'
                        ].join('\n\n');
                        return;
                    }
                    validatedOutput = output;
                    options.onProgress?.({
                        stage: 'review',
                        attempt,
                        definition: output.definition,
                        errors: []
                    });
                    completionControl.accept(activeTask, toolCall, completion);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    rejectedSubmissions += 1;
                    validationErrors.push(message);
                    const finalAttempt = rejectedSubmissions >= MAX_AUTHORING_COMPLETION_REJECTIONS;
                    compactInvalidAuthoringCompletion(toolCall, AUTHOR_WORKFLOW_OUTPUT_SCHEMA);
                    toolCall.status = 'error';
                    toolCall.result_object = {
                        accepted: false,
                        attempt: rejectedSubmissions,
                        maxAttempts: MAX_AUTHORING_COMPLETION_REJECTIONS,
                        errors: [message]
                    };
                    toolCall.result = [
                        `Workflow Definition 第 ${rejectedSubmissions}/${MAX_AUTHORING_COMPLETION_REJECTIONS} 次校验结果：`,
                        message,
                        finalAttempt
                            ? '本次创建流程已结束，以上内容是需要向宿主 Task 返回的完整校验错误。'
                            : '请一次性修复以上全部问题，并使用 workflow-agent-CompleteWorkflowAgent 提交完整的修正版 Definition。'
                    ].join('\n');
                    if (finalAttempt) {
                        completionControl.fail(
                            activeTask,
                            createAuthoringCompletionError('completion_rejected', rejectedSubmissions, validationErrors)
                        );
                    }
                }
            });
        },
        getValidatedOutput: () => validatedOutput,
        normalizeIncompleteError: (error) => {
            if (error instanceof WorkflowAgentExecutionError && error.failure.code === 'completion_not_submitted') {
                return createAuthoringCompletionError(
                    completionSubmissions === 0 ? 'completion_not_submitted' : 'completion_repair_abandoned',
                    rejectedSubmissions,
                    validationErrors
                );
            }
            return error;
        }
    };
}

function buildAuthoringSelfReviewPrompt(context: WorkflowAuthoringContext): string {
    return [
        '# Workflow Definition 自查',
        '当前 Definition 已通过确定性校验。请在最终确认前完成一次建议性语义自查。',
        '确定性校验返修次数仅统计校验失败的提交，本次自查独立执行。',
        '',
        '请从以下两组目标核对完整 Definition：',
        '',
        '## 用户需求一致性',
        '- 输入契约、执行过程和最终报告完整覆盖按时间顺序提供的用户真实原始输入及明确约束。',
        '- 后续用户输入对此前输入的补充或更正已经体现在 Definition 中。',
        '- 每项承诺能力都由脚本或职责明确的 agent prompt 实际实现。',
        '- 示例用于表达设计意图；用户明确提供的首次运行值通过 launchInput 交接。',
        '',
        '## 实现质量',
        '- 每个 agent 都获得完成职责所需的上下文、准确 allowedTools 和可供脚本消费的 outputSchema。',
        '- agent output 能完整进入后续阶段和最终 report。',
        '- 阶段职责清晰，fan-out 与实际需求规模一致。',
        '- 运行时才能确定的值由 required input 表达。',
        '',
        '发现可改进内容时，先修改 Definition；确认当前实现完整时，保持 Definition 原样。',
        '完成自查后，使用 workflow-agent-CompleteWorkflowAgent 提交完整最终 Definition，随后会再次执行确定性校验。',
        '',
        '# 用户真实原始输入（按时间顺序）',
        context.userInputs.map((input, index) => `## 用户输入 ${index + 1}\n${input}`).join('\n\n')
    ].join('\n');
}

function createAuthoringCompletionError(
    code: 'completion_not_submitted' | 'completion_repair_abandoned' | 'completion_rejected',
    attempts: number,
    validationErrors: string[]
): WorkflowAuthoringCompletionError {
    const uniqueErrors = [...new Set(validationErrors)];
    const lastError = uniqueErrors.at(-1);
    const message =
        code === 'completion_not_submitted'
            ? 'Workflow authoring agent 在提交 workflow-agent-CompleteWorkflowAgent 前结束。'
            : code === 'completion_repair_abandoned'
              ? `Workflow authoring agent 在 ${attempts}/${MAX_AUTHORING_COMPLETION_REJECTIONS} 次提交被拒后结束，未产出通过校验的 Definition。${
                    lastError ? ` 最后一次校验错误：${lastError}` : ''
                }`
              : `Workflow authoring 在 ${MAX_AUTHORING_COMPLETION_REJECTIONS} 次提交被拒后失败。${
                    lastError ? ` 最后一次校验错误：${lastError}` : ''
                }`;
    return new WorkflowAuthoringCompletionError({
        code,
        message,
        completionAttempts: attempts,
        maxCompletionAttempts: MAX_AUTHORING_COMPLETION_REJECTIONS,
        ...(uniqueErrors.length > 0 ? { validationErrors: uniqueErrors } : {})
    });
}

interface WorkflowAuthoringFailure {
    code: 'completion_not_submitted' | 'completion_repair_abandoned' | 'completion_rejected';
    message: string;
    completionAttempts: number;
    maxCompletionAttempts: number;
    validationErrors?: string[];
}

class WorkflowAuthoringCompletionError extends Error {
    constructor(readonly failure: WorkflowAuthoringFailure) {
        super(failure.message);
        this.name = 'WorkflowAuthoringCompletionError';
    }
}

function compactInvalidAuthoringCompletion(
    toolCall: { args_string: string; args_object?: unknown },
    outputSchema: WorkflowJSONSchema
): void {
    if (outputSchema.type !== 'object' && outputSchema.type !== 'array') {
        return;
    }
    const args = toolCall.args_object;
    if (
        !args ||
        typeof args !== 'object' ||
        Array.isArray(args) ||
        typeof (args as { output?: unknown }).output !== 'string'
    ) {
        return;
    }
    const summary = (args as { summary?: unknown }).summary;
    toolCall.args_string = JSON.stringify({
        status: (args as { status?: unknown }).status === 'success' ? 'success' : 'fail',
        summary: typeof summary === 'string' ? summary.slice(0, 240) : 'Invalid Workflow definition omitted.',
        output: OMITTED_INVALID_AUTHORING_OUTPUT
    });
}
