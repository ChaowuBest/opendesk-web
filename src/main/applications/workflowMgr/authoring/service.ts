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
 * 职责：准备 Authoring 输入并编排临时 Workflow Definition 的创建过程。
 */

import crypto from 'node:crypto';

import type { TaskState } from '../../../aikernel/states/tasks.js';
import type { ToolsetProvider } from '../../../aikernel/tool.js';
import {
    type WorkflowDefinition,
    type WorkflowDefinitionInput,
    type WorkflowJSONValue
} from '../../../aikernel/workflow.js';
import { WorkflowAgentRunner } from '../agent/runner.js';
import { isWorkflowAgentToolAllowed } from '../agent/policy.js';
import { createWorkflowAuthoringCompletion } from './completion.js';
import { createWorkflowAuthoringContext, type WorkflowAuthoringContext } from './context.js';
import {
    AUTHOR_WORKFLOW_OUTPUT_SCHEMA,
    missingRequiredInputNames,
    parseAuthoredOutput,
    type WorkflowDefinitionValidationHost,
    type WorkflowToolCatalogEntry
} from './validation.js';

export interface WorkflowInvocation {
    reference: string;
    input?: WorkflowJSONValue;
}

export interface WorkflowAuthoringResult {
    reference: string;
    workflowName: string;
    status: 'authored';
    definition: WorkflowDefinition;
    inputSchema: Record<string, unknown>;
    launchInput?: WorkflowJSONValue;
    missingRequiredInputs: string[];
    launchReady: boolean;
    invocation: WorkflowInvocation;
    message: string;
}

export type WorkflowAuthoringStage = 'generate' | 'validate' | 'review';

export interface WorkflowAuthoringProgressUpdate {
    stage: WorkflowAuthoringStage;
    attempt?: number;
    definition?: WorkflowDefinitionInput;
    errors?: string[];
    userInputs?: string[];
    /** Authoring internal Task 的模型请求重试；与 Definition 校验返修无关。 */
    requestRetry?: WorkflowAuthoringRequestRetry;
}

export interface WorkflowAuthoringRequestRetry {
    attempt: number;
    delayMs: number;
    error: string;
    status: 'scheduled' | 'retrying';
}

export type WorkflowAuthoringProgress = (update: WorkflowAuthoringProgressUpdate) => void;

export interface WorkflowAuthoringDefinitionHost extends WorkflowDefinitionValidationHost {
    createDefinition(input: WorkflowDefinitionInput, options: { allowNameCollision: boolean }): WorkflowDefinition;
}

export class WorkflowAuthoringCancelledError extends Error {
    constructor() {
        super('Workflow 创建已停止。');
        this.name = 'WorkflowAuthoringCancelledError';
    }
}

export class WorkflowAuthoringService {
    constructor(
        private readonly agentRunner: WorkflowAgentRunner,
        private readonly definitionHost: WorkflowAuthoringDefinitionHost,
        private readonly excludedToolNames: readonly string[] = []
    ) {}

    async author(hostTask: TaskState, onProgress?: WorkflowAuthoringProgress): Promise<WorkflowAuthoringResult> {
        const authoringContext = createWorkflowAuthoringContext(hostTask);
        onProgress?.({
            stage: 'generate',
            userInputs: [...authoringContext.userInputs]
        });
        const toolCatalog = await resolveWorkflowToolCatalog(
            hostTask.task_manager_state.toolsetProvider,
            [...(hostTask.disabledTools ?? []), ...this.excludedToolNames],
            hostTask.allowedTools
        );
        const reference = `authoring_${crypto.randomUUID()}`;
        const completion = createWorkflowAuthoringCompletion({
            authoringContext,
            hostTask,
            toolCatalog,
            validator: this.definitionHost,
            onProgress: (update) => onProgress?.({ ...update, requestRetry: undefined })
        });
        const authoring = this.agentRunner.run(
            hostTask,
            {
                title: 'Author Workflow',
                reasoningEffort: 'high',
                allowedTools: [],
                prompt: buildAuthoringPrompt(authoringContext, toolCatalog),
                outputSchema: AUTHOR_WORKFLOW_OUTPUT_SCHEMA
            },
            {
                executionId: reference,
                configureTask: completion.configureTask,
                onTaskRequestRetry: (update) => {
                    if (update.status === 'cleared') {
                        onProgress?.({ stage: 'generate', requestRetry: undefined });
                        return;
                    }
                    onProgress?.({
                        stage: 'generate',
                        requestRetry: {
                            attempt: update.attempt,
                            delayMs: update.delay_ms,
                            error: update.error_message,
                            status: update.status
                        }
                    });
                }
            }
        );
        let authoringSettled = false;
        let stopAuthoring: Promise<void> | undefined;
        const stopAuthoringOnce = (): Promise<void> => {
            stopAuthoring ??= this.agentRunner.stopExecution(reference);
            return stopAuthoring;
        };
        const hostCancellation = hostTask.waitUntilFinished(undefined, true).then(async () => {
            if (!authoringSettled && hostTask.task_status === 'stopped') {
                await stopAuthoringOnce();
                throw new WorkflowAuthoringCancelledError();
            }
            return await new Promise<never>(() => undefined);
        });
        let authored: Awaited<ReturnType<WorkflowAgentRunner['run']>>;
        try {
            authored = await Promise.race([authoring, hostCancellation]);
        } catch (error) {
            if (hostTask.task_status === 'stopped') {
                await stopAuthoringOnce();
                throw new WorkflowAuthoringCancelledError();
            }
            throw completion.normalizeIncompleteError(error);
        } finally {
            authoringSettled = true;
        }
        if (authored.status !== 'success' || !authored.output) {
            throw new Error(authored.summary || 'Workflow 创建失败。');
        }
        const output = completion.getValidatedOutput() ?? parseAuthoredOutput(authored.output);
        const definition = this.definitionHost.createDefinition(output.definition, {
            allowNameCollision: true
        });
        const missingRequiredInputs = missingRequiredInputNames(definition.inputSchema, output.launchInput);
        const launchReady = missingRequiredInputs.length === 0;
        const invocation = {
            reference,
            ...(output.launchInput === undefined ? {} : { input: structuredClone(output.launchInput) })
        };
        return {
            reference,
            workflowName: definition.name,
            status: 'authored',
            definition,
            inputSchema: structuredClone(definition.inputSchema),
            ...(output.launchInput === undefined ? {} : { launchInput: structuredClone(output.launchInput) }),
            missingRequiredInputs,
            launchReady,
            invocation,
            message: launchReady
                ? `Workflow“${definition.name}”已生成并通过校验。请使用返回的 invocation 启动 reference“${reference}”。`
                : `Workflow“${definition.name}”已生成并通过校验。首次运行需要用户提供：${missingRequiredInputs.join(', ')}。收到输入后请使用同一 reference 启动。`
        };
    }
}

export async function resolveWorkflowToolCatalog(
    provider: ToolsetProvider,
    disabledTools: readonly string[] = [],
    allowedTools?: readonly string[]
): Promise<WorkflowToolCatalogEntry[]> {
    const disabled = new Set(disabledTools);
    const allowed = allowedTools && allowedTools.length > 0 ? new Set(allowedTools) : undefined;
    const entries = new Map<string, WorkflowToolCatalogEntry>();
    for (const toolset of await provider.listAvailableToolsets()) {
        for (const tool of toolset.tools.values()) {
            if (
                !disabled.has(tool.name) &&
                (allowed === undefined || allowed.has(tool.name)) &&
                isWorkflowAgentToolAllowed(tool.name) &&
                !entries.has(tool.name)
            ) {
                entries.set(tool.name, {
                    name: tool.name,
                    description: tool.description.replace(/\s+/g, ' ').trim()
                });
            }
        }
    }
    return [...entries.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function buildAuthoringPrompt(
    context: WorkflowAuthoringContext,
    toolCatalog: readonly WorkflowToolCatalogEntry[] = []
): string {
    const availableTools =
        toolCatalog.length > 0
            ? toolCatalog.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n')
            : '（当前没有可用工具，allowedTools 使用空数组）';
    const exampleAllowedTools = toolCatalog.length > 0 ? JSON.stringify([toolCatalog[0].name]) : '[]';
    return [
        '# 目标',
        '根据当前 Task 中按时间顺序保留的用户真实原始输入，创建一个最小、可执行的 OpenDesk JavaScript Workflow Definition。',
        '直接生成可执行 Definition，保留用户使用的语言和所有明确约束。用户提供的示例默认用于说明设计意图；用户明确给出的首次运行值可进入 launchInput。',
        '这些原始输入共同确定 Workflow 的目标、输入契约和交付物；后续输入用于补充或更正此前输入。',
        '',
        '# 结构化输出',
        '提交以下完整对象：',
        '{',
        '  "name": "lowercase-slash-command-name",',
        '  "description": "面向用户的简短描述",',
        '  "whenToUse": "简短适用场景",',
        '  "phases": [{"name": "阶段名称", "description": "该阶段的职责"}],',
        '  "inputSchema": {"type":"object","properties":{},"required":[],"additionalProperties":false},',
        '  "script": "JavaScript async function body"',
        '}',
        '可选顶层字段：',
        '- launchInput：用户已经提供首次运行全部必填值时，用于把这些具体值交给 RunWorkflow。',
        'launchInput 的出现条件是首次运行的全部必填值都来自用户当前需求。',
        '',
        '# 设计方式',
        '1. 选择能够交付用户结果的最小阶段结构。',
        '2. phases 与脚本中的字面量 phase(...) 调用在名称、顺序和数量上完全对应。',
        '3. 每个 agent 承担一个边界明确的职责；真正相互独立的工作可使用 Promise.all 并行。',
        '4. agent 负责检索、判断或开放式内容生成，并返回符合 outputSchema 的结构化结果。',
        '5. 确定性转换和流程编排由 Workflow 本地 JavaScript 完成。',
        '6. 文件任务由 agent 使用准确的可用文件工具完成。文件位于宿主 Task workspace，并继承宿主权限边界；agent 在结构化 output 中返回 workspace 相对路径。',
        '7. inputSchema 描述每次运行可复用的输入；具体输入值来自用户需求。',
        '8. launchInput 是本次创建到首次运行的参数交接，位于 Definition 外层。',
        '9. 必填输入会在脚本执行前完成校验，脚本直接从 args 读取。',
        '10. Definition 由阶段、职责明确的 agent、确定性转换和最终报告组成。',
        '',
        '# Runtime 契约',
        'script 是 async function 的函数体。完整的 OpenDesk host API 为 args、phase、agent 和 report；同时可使用 Object、Array、JSON、Math、Error、Promise 等标准 ECMAScript 内建对象。',
        'args、phase、agent 和 report 在整个脚本中保持为宿主提供的保留绑定。',
        "使用 await phase('准确阶段名称') 切换当前阶段；phase 接收一个字符串参数。",
        '使用 await agent(prompt, { title, allowedTools, reasoningEffort, outputSchema }) 调用 agent，prompt 是第一个位置参数。',
        '下方工具目录用于 agent 的 allowedTools。Workflow 脚本本身使用本地声明、标准 ECMAScript 内建对象和 host API。',
        'agent.allowedTools 使用数组字面量，并填写工具目录中的准确工具名称。',
        '可供 agent 使用的工具：',
        availableTools,
        'agent() 返回 { status, summary, output }。先读取 status，再从 result.output 获取领域数据。',
        '最小脚本示例（函数体直接从可执行语句开始）：',
        "await phase('Collect');",
        "const sourceResult = await agent('Collect evidence', {",
        "    title: 'Collect evidence',",
        `    allowedTools: ${exampleAllowedTools},`,
        "    outputSchema: { type: 'object', properties: { facts: { type: 'array' } }, required: ['facts'] }",
        '});',
        "if (sourceResult.status !== 'success' || !sourceResult.output) throw new Error(sourceResult.summary);",
        'const output = sourceResult.output;',
        'await report(output);',
        'return output;',
        '每个 Workflow 使用 await report(value) 发布最终 JSON-safe 结果，并 return 同一个可序列化最终值。',
        'host API 之间传递 JSON-safe 的对象、数组、字符串、有限数值、布尔值和 null。',
        '',
        '# 提交前核对',
        '确认输入来自用户需求，宿主保留标识符保持原绑定，每个 agent 结果通过 .output 进入后续流程，agent 返回结构化数据或文档内容，阶段声明与脚本一致，最终结果通过宿主 report 函数发布。',
        '',
        '# 用户真实原始输入（按时间顺序）',
        formatAuthoringUserInputs(context.userInputs)
    ].join('\n');
}

function formatAuthoringUserInputs(userInputs: readonly string[]): string {
    return userInputs.map((input, index) => `## 用户输入 ${index + 1}\n${input}`).join('\n\n');
}
