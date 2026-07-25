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
 * 职责：在宿主 Task 的访问边界内运行 Workflow 内部 Agent。
 */

import { z } from 'zod';

import { normalizeWorkflowJSONValue } from '../../../aikernel/workflow.js';
import type { ModeDecl } from '../../../aikernel/agents/common.js';
import { MainAgentDecl } from '../../../aikernel/agents/main/agent.js';
import type { ToolCall } from '../../../aikernel/messages.js';
import type {
    PermissionEnforcer,
    PermissionPromptContext,
    PermissionPromptProvider,
    PermissionRequest,
    PermissionTaskInfo,
    PermissionUserResponse
} from '../../../aikernel/security/permission.js';
import type { TaskState, TaskUpdateChunk, TaskUpdateRetryChunk } from '../../../aikernel/states/tasks.js';
import { BaseTool, BaseToolset, type ToolResult } from '../../../aikernel/tool.js';
import { WorkflowAgentExecutionError, type WorkflowAgentRequest, type WorkflowAgentResult } from './contract.js';
import { isWorkflowAgentToolAllowed } from './policy.js';

const CompleteWorkflowAgentSchema = z.object({
    status: z.enum(['success', 'fail']).describe('当前 Workflow agent 步骤的完成状态。'),
    summary: z.string().describe('面向后续流程的简短执行摘要。'),
    output: z.unknown().optional().describe('当前步骤产生的结构化结果。')
});
export const WORKFLOW_AGENT_COMPLETION_TOOL_NAME = 'workflow-agent-CompleteWorkflowAgent';

export function createWorkflowAgentCompletionSchema(outputSchema?: Record<string, unknown>): z.ZodType {
    if (outputSchema === undefined) {
        return CompleteWorkflowAgentSchema;
    }
    const structuredOutput = z.fromJSONSchema(outputSchema as Parameters<typeof z.fromJSONSchema>[0]);
    return z
        .object({
            status: z.enum(['success', 'fail']).describe('当前 Workflow agent 步骤的完成状态。'),
            summary: z.string().describe('面向后续流程的简短执行摘要。'),
            output: structuredOutput.optional().describe('符合当前步骤 outputSchema 的结构化结果。')
        })
        .superRefine((value, context) => {
            if (value.status === 'success' && value.output === undefined) {
                context.addIssue({
                    code: 'custom',
                    path: ['output'],
                    message: 'output is required when status is success'
                });
            }
        });
}

class CompleteWorkflowAgentTool extends BaseTool<z.ZodType> {
    constructor(
        outputSchema: Record<string, unknown> | undefined,
        onCompletion: (completion: WorkflowAgentResult, result: ToolResult, task: TaskState) => Promise<void> | void
    ) {
        super(
            'CompleteWorkflowAgent',
            '完成当前 Workflow agent 步骤，并向 Workflow 脚本返回状态、摘要和结构化结果。',
            createWorkflowAgentCompletionSchema(outputSchema)
        );
        this.setUniversalExecutor(async (rawArgs, result, task) => {
            if (!task) {
                throw new Error('CompleteWorkflowAgent requires a Task context');
            }
            await onCompletion(parseWorkflowAgentCompletion(rawArgs, outputSchema), result, task);
        });
    }
}

export interface WorkflowAgentRunOptions {
    executionId?: string;
    configureTask?: (task: TaskState, completion: WorkflowAgentCompletionControl) => void;
    /** 仅观察底层 Task 的模型请求重试状态，不负责发起或配置重试。 */
    onTaskRequestRetry?: (update: TaskUpdateRetryChunk) => void | Promise<void>;
}

export interface WorkflowAgentCompletionControl {
    toolName: string;
    parse(toolCall: ToolCall): WorkflowAgentResult;
    accept(task: TaskState, toolCall: ToolCall, completion: WorkflowAgentResult): void;
    fail(task: TaskState, error: Error): void;
}

interface WorkflowAgentTaskContext {
    agent: MainAgentDecl;
    mode: ModeDecl;
}

interface WorkflowAgentCompletionController {
    toolset: BaseToolset;
    control: WorkflowAgentCompletionControl;
    resolve(): WorkflowAgentResult;
}

class WorkflowAgentPermissionPrompt implements PermissionPromptProvider {
    constructor(
        private readonly delegate: PermissionPromptProvider,
        private readonly hostTask: TaskState,
        private readonly agentTask: TaskState
    ) {}

    prompt(
        requests: PermissionRequest[],
        toolName: string,
        prefixOptions: { label: string; pattern: string }[],
        _taskInfo?: PermissionTaskInfo,
        context?: PermissionPromptContext
    ): Promise<PermissionUserResponse> {
        return this.delegate.prompt(
            requests,
            toolName,
            prefixOptions,
            {
                taskId: this.hostTask.task_id,
                taskName: this.hostTask.task_name,
                workspace: this.hostTask.getWorkspace(),
                sourceTaskId: this.agentTask.task_id,
                sourceTaskName: this.agentTask.task_name,
                parentTaskId: this.hostTask.task_id
            },
            context
        );
    }

    notifyPermissionRulesChanged(enforcer: PermissionEnforcer): Promise<void> | void {
        return this.delegate.notifyPermissionRulesChanged?.(enforcer);
    }

    cancelTaskPrompts(taskIds: string[]): void {
        this.delegate.cancelTaskPrompts?.(taskIds);
    }
}

export function bindWorkflowAgentAccess(
    agentTask: TaskState,
    hostTask: TaskState,
    requestedTools: string[] | undefined
): void {
    agentTask.harnessContext.permission = hostTask.harnessContext.permission;
    agentTask.harnessContext.permissionPrompt = hostTask.harnessContext.permissionPrompt
        ? new WorkflowAgentPermissionPrompt(hostTask.harnessContext.permissionPrompt, hostTask, agentTask)
        : null;

    const hostAllowedTools =
        hostTask.allowedTools && hostTask.allowedTools.length > 0 ? new Set(hostTask.allowedTools) : undefined;
    const allowedTools = (requestedTools ?? []).filter(
        (toolName) =>
            isWorkflowAgentToolAllowed(toolName) && (hostAllowedTools === undefined || hostAllowedTools.has(toolName))
    );
    agentTask.allowedTools = [...new Set([...allowedTools, 'CompleteWorkflowAgent'])];
    agentTask.disabledTools = [
        ...new Set([...(agentTask.disabledTools ?? []), ...(hostTask.disabledTools ?? [])])
    ].filter((toolName) => toolName !== 'CompleteWorkflowAgent');
}

export class WorkflowAgentRunner {
    private readonly activeTasks = new Map<string, Set<TaskState>>();

    async run(
        hostTask: TaskState,
        request: WorkflowAgentRequest,
        options: WorkflowAgentRunOptions = {}
    ): Promise<WorkflowAgentResult> {
        const task = this.createInternalTask(hostTask, request);
        this.trackExecution(options.executionId, task);

        try {
            const context = await this.prepareTask(task, hostTask, request);
            const completion = this.attachCompletionProtocol(task, request, options);

            await this.executeTask(task, context, request, options);

            return completion.resolve();
        } finally {
            this.cleanupExecution(options.executionId, task, hostTask);
        }
    }

    private createInternalTask(hostTask: TaskState, request: WorkflowAgentRequest): TaskState {
        return hostTask.task_manager_state.createTask(hostTask.model, {
            internal: true,
            taskName: request.title ?? 'Workflow agent'
        });
    }

    private async prepareTask(
        task: TaskState,
        hostTask: TaskState,
        request: WorkflowAgentRequest
    ): Promise<WorkflowAgentTaskContext> {
        const agent = new MainAgentDecl();
        const modes = agent.supportedModes();
        const modeId = hostTask.activeModeId ?? agent.defaultModeId();
        const mode = modes.find((candidate) => candidate.id === modeId) ?? modes[0];
        const workspace = hostTask.getWorkspace();
        if (!mode || !workspace) {
            throw new Error('Workflow agent requires the host Task mode and workspace');
        }

        await hostTask.task_manager_state.initHarness(task, workspace, mode);
        task.harnessContext.executionHost = hostTask.getExecutionHost();
        task.reasoningEffort = request.reasoningEffort;
        bindWorkflowAgentAccess(task, hostTask, request.allowedTools);
        return { agent, mode };
    }

    private attachCompletionProtocol(
        task: TaskState,
        request: WorkflowAgentRequest,
        options: WorkflowAgentRunOptions
    ): WorkflowAgentCompletionController {
        const completion = createWorkflowAgentCompletionController(
            request.outputSchema,
            options.configureTask !== undefined
        );
        task.interactionToolset = completion.toolset;
        options.configureTask?.(task, completion.control);
        return completion;
    }

    private async executeTask(
        task: TaskState,
        context: WorkflowAgentTaskContext,
        request: WorkflowAgentRequest,
        options: WorkflowAgentRunOptions
    ): Promise<void> {
        const basePrompt = await context.agent.createSystemPrompt(context.mode, task);
        task.setSystemPrompt(buildWorkflowAgentSystemPrompt(basePrompt, request));

        const submit = await task.submitUserMessage(buildWorkflowAgentUserMessage(request));
        if (submit.status === 'error') {
            throw new Error(submit.messageKey);
        }

        await task.waitUntilFinished(createTaskRequestRetryObserver(options.onTaskRequestRetry), true);
    }

    private trackExecution(executionId: string | undefined, task: TaskState): void {
        if (!executionId) {
            return;
        }
        const tasks = this.activeTasks.get(executionId) ?? new Set<TaskState>();
        tasks.add(task);
        this.activeTasks.set(executionId, tasks);
    }

    private cleanupExecution(executionId: string | undefined, task: TaskState, hostTask: TaskState): void {
        if (executionId) {
            const tasks = this.activeTasks.get(executionId);
            tasks?.delete(task);
            if (tasks?.size === 0) {
                this.activeTasks.delete(executionId);
            }
        }
        if (hostTask.task_manager_state.getTask(task.task_id)) {
            hostTask.task_manager_state.removeTask(task.task_id);
        }
    }

    async stopExecution(executionId: string): Promise<void> {
        const tasks = [...(this.activeTasks.get(executionId) ?? [])];
        for (const task of tasks) {
            task.stop('system');
        }
        await Promise.all(tasks.map((task) => task.waitUntilFinished(undefined, true)));
    }
}

function createWorkflowAgentCompletionController(
    outputSchema: Record<string, unknown> | undefined,
    usesCustomCompletionHook: boolean
): WorkflowAgentCompletionController {
    let acceptedCompletion: WorkflowAgentResult | undefined;
    let terminalError: Error | undefined;
    const toolset = new BaseToolset('workflow-agent');
    toolset.addTool(
        new CompleteWorkflowAgentTool(outputSchema, (completion, result, activeTask) => {
            if (usesCustomCompletionHook) {
                result.updateResultObject({ submitted: true, ...completion });
                result.updateResult(JSON.stringify({ submitted: true, status: completion.status }));
                return;
            }
            acceptedCompletion = completion;
            result.updateResultObject({ accepted: true, ...completion });
            result.updateResult(JSON.stringify({ accepted: true, status: completion.status }));
            activeTask.stop('system');
        })
    );

    return {
        toolset,
        control: {
            toolName: WORKFLOW_AGENT_COMPLETION_TOOL_NAME,
            parse: (toolCall) => parseWorkflowAgentCompletion(toolCall.args_object, outputSchema),
            accept: (activeTask, toolCall, completion) => {
                acceptedCompletion = completion;
                toolCall.status = 'success';
                toolCall.result_object = { accepted: true, ...completion };
                toolCall.result = JSON.stringify({ accepted: true, status: completion.status });
                activeTask.stop('system');
            },
            fail: (activeTask, error) => {
                terminalError = error;
                activeTask.stop('system');
            }
        },
        resolve: () => {
            if (acceptedCompletion) {
                return acceptedCompletion;
            }
            if (terminalError) {
                throw terminalError;
            }
            throw new WorkflowAgentExecutionError({
                code: 'completion_not_submitted',
                message:
                    'Workflow agent ended before submitting an accepted workflow-agent-CompleteWorkflowAgent result.'
            });
        }
    };
}

function buildWorkflowAgentSystemPrompt(basePrompt: string, request: WorkflowAgentRequest): string {
    return [
        basePrompt,
        '# Workflow agent 职责',
        '你是可执行 JavaScript Workflow 中一个职责明确的工作单元。',
        '使用当前步骤提供的工具完成指定的检索、判断或内容生成任务，并返回可供 Workflow 脚本继续处理的结构化结果。',
        '涉及 workspace 文件时，使用当前步骤提供的文件工具完成读写，并在 output 中返回 workspace 相对路径。',
        '# 完成协议',
        '最终操作是调用 workflow-agent-CompleteWorkflowAgent，提交 status、summary 和 output。',
        '机器可读数据以对象或数组形式直接放入 output。',
        '步骤产出可用结果时使用 status="success"；步骤无法产出结果时使用 status="fail" 并在 summary 中说明原因。',
        ...(request.outputSchema
            ? ['status="success" 对应的 output 使用以下 JSON Schema：', JSON.stringify(request.outputSchema)]
            : [])
    ].join('\n\n');
}

function createTaskRequestRetryObserver(
    onTaskRequestRetry: WorkflowAgentRunOptions['onTaskRequestRetry']
): (update: TaskUpdateChunk) => void | Promise<void> {
    let lastFingerprint = '';
    return (update) => {
        if (update.type !== 'retry' || !onTaskRequestRetry) {
            return;
        }
        const fingerprint = [update.status, update.attempt, update.delay_ms, update.error_message].join('\n');
        if (fingerprint === lastFingerprint) {
            return;
        }
        lastFingerprint = fingerprint;
        return onTaskRequestRetry(update);
    };
}

function buildWorkflowAgentUserMessage(request: WorkflowAgentRequest): string {
    return [
        request.prompt,
        '',
        '# 完成目标',
        request.title ?? '完成当前 Workflow 步骤。',
        request.outputSchema
            ? '将符合 system prompt 中 JSON Schema 的结果放入 output。'
            : '将当前步骤请求的结果放入 output。',
        '以一次真实的 workflow-agent-CompleteWorkflowAgent 工具调用作为最终操作。'
    ].join('\n');
}

export function parseWorkflowAgentCompletion(
    value: unknown,
    outputSchema?: Record<string, unknown>
): WorkflowAgentResult {
    if (
        outputSchema &&
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        (outputSchema.type === 'object' || outputSchema.type === 'array') &&
        typeof (value as { output?: unknown }).output === 'string'
    ) {
        throw new Error('CompleteWorkflowAgent.output 当前是 JSON 字符串；请将对应的结构化对象或数组直接放入 output。');
    }
    const parsed = createWorkflowAgentCompletionSchema(outputSchema).safeParse(value);
    if (!parsed.success) {
        const issues = parsed.error.issues
            .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '<root>'}: ${issue.message}`)
            .join('; ');
        throw new Error(`CompleteWorkflowAgent 提交内容需要符合结构化协议：${issues}`);
    }
    return {
        status: parsed.data.status,
        summary: parsed.data.summary,
        ...(parsed.data.output === undefined ? {} : { output: normalizeWorkflowJSONValue(parsed.data.output) })
    };
}
