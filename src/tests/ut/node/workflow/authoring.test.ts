import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import { ChatContext, ToolCall, UserMessage } from '../../../../main/aikernel/messages.js';
import { TaskManagerState, TaskState } from '../../../../main/aikernel/states/tasks.js';
import { BaseTool, BaseToolset, type ToolsetProvider } from '../../../../main/aikernel/tool.js';
import type { WorkflowAgentResult } from '../../../../main/applications/workflowMgr/agent/contract.js';
import {
    WORKFLOW_AGENT_COMPLETION_TOOL_NAME,
    WorkflowAgentRunner
} from '../../../../main/applications/workflowMgr/agent/runner.js';
import {
    buildAuthoringPrompt,
    resolveWorkflowToolCatalog,
    WorkflowAuthoringCancelledError,
    WorkflowAuthoringService
} from '../../../../main/applications/workflowMgr/authoring/service.js';
import { validateAuthoredDefinition } from '../../../../main/applications/workflowMgr/authoring/validation.js';
import type { WorkflowManager } from '../../../../main/applications/workflowMgr/manager.js';

class CancellableWorkflowAgentRunner extends WorkflowAgentRunner {
    executionId?: string;
    stoppedExecutionId?: string;
    readonly started: Promise<void>;
    private markStarted!: () => void;
    private rejectRun?: (error: Error) => void;

    constructor() {
        super();
        this.started = new Promise<void>((resolve) => {
            this.markStarted = resolve;
        });
    }

    override run(...args: Parameters<WorkflowAgentRunner['run']>): ReturnType<WorkflowAgentRunner['run']> {
        this.executionId = args[2]?.executionId;
        this.markStarted();
        return new Promise((_resolve, reject) => {
            this.rejectRun = reject;
        });
    }

    override async stopExecution(executionId: string): Promise<void> {
        this.stoppedExecutionId = executionId;
        this.rejectRun?.(new Error('stopped'));
    }
}

test('Workflow authoring uses the runtime tool catalog from prompt through definition validation', async () => {
    let searchedQuery: string | undefined;
    const searchTools = new BaseToolset('search');
    const webSearch = new BaseTool(
        'WebSearch',
        'Search the web for current information.',
        z.object({ query: z.string() })
    );
    webSearch.setExecutor(async ({ query }) => {
        searchedQuery = query;
        return `Evidence for ${query}`;
    });
    searchTools.addTools(
        webSearch,
        new BaseTool('webFetch', 'Read one web page.', z.object({ url: z.string() })),
        new BaseTool('writeFile', 'Write a file in the workspace.', z.object({ path: z.string() })),
        new BaseTool('executeBash', 'Execute arbitrary shell commands.', z.object({ command: z.string() }))
    );
    const provider: ToolsetProvider = {
        listAvailableToolsets: async () => [searchTools]
    };
    const toolCatalog = await resolveWorkflowToolCatalog(provider);
    const prompt = buildAuthoringPrompt(
        {
            userInputs: ['Create a reusable stock brief', 'Use 600519 for the first run']
        },
        toolCatalog
    );
    const declaredTools = ['WebSearch', 'webFetch'];

    assert.deepEqual(new Set(toolCatalog.map((tool) => tool.name)), new Set(['WebSearch', 'webFetch', 'writeFile']));
    assert.match(prompt, /WebSearch: Search the web for current information/);
    assert.match(prompt, /webFetch: Read one web page/);
    assert.match(prompt, /工具目录用于 agent 的 allowedTools/);
    assert.match(prompt, /文件位于宿主 Task workspace，并继承宿主权限边界/);
    assert.match(prompt, /agent 负责检索、判断或开放式内容生成/);
    assert.match(prompt, /确定性转换和流程编排由 Workflow 本地 JavaScript 完成/);
    assert.match(prompt, /agent\(\) 返回 \{ status, summary, output \}/);
    assert.match(prompt, /args、phase、agent 和 report 在整个脚本中保持为宿主提供的保留绑定/);
    assert.match(prompt, /具体输入值来自用户需求/);
    assert.match(prompt, /launchInput 是本次创建到首次运行的参数交接/);
    assert.match(prompt, /必填输入会在脚本执行前完成校验，脚本直接从 args 读取/);
    assert.match(prompt, /用户提供的示例默认用于说明设计意图/);
    assert.match(prompt, /最小脚本示例（函数体直接从可执行语句开始）/);
    assert.match(prompt, /await phase\('Collect'\)/);
    assert.match(prompt, /await report\(output\)/);
    assert.match(prompt, /从 result\.output 获取领域数据/);
    assert.match(prompt, /phase 接收一个字符串参数/);
    assert.match(prompt, /# 用户真实原始输入（按时间顺序）/);
    assert.match(prompt, /## 用户输入 1\nCreate a reusable stock brief/);
    assert.match(prompt, /## 用户输入 2\nUse 600519 for the first run/);
    assert.doesNotThrow(() =>
        validateAuthoredDefinition(
            {
                name: 'stock-brief',
                description: 'Create a stock brief',
                phases: [{ name: 'Collect' }, { name: 'Publish' }],
                inputSchema: {
                    type: 'object',
                    properties: {
                        stock: { type: 'string' }
                    },
                    required: ['stock'],
                    additionalProperties: false
                },
                script: [
                    "await phase('Collect');",
                    'const result = await agent(`Research ${args.stock}`, {',
                    "    title: 'Research',",
                    `    allowedTools: ${JSON.stringify(declaredTools)}`,
                    '});',
                    "if (result.status !== 'success') throw new Error(result.summary);",
                    'const sourceData = result.output;',
                    'const grouped = [sourceData].reduce((result, item) => {',
                    '    result.push(item);',
                    '    return result;',
                    '}, []);',
                    "await phase('Publish');",
                    'await report(grouped);',
                    'return grouped;'
                ].join('\n')
            },
            toolCatalog
        )
    );
    assert.throws(
        () =>
            validateAuthoredDefinition(
                {
                    name: 'invalid-runtime-contract',
                    description: 'Uses a capability outside the Workflow host contract',
                    phases: [],
                    inputSchema: { type: 'object' },
                    script: "await publishFile({ filename: 'report.html', content: 'done' }); return null;"
                },
                toolCatalog
            ),
        /引用了不可用的标识符：publishFile/
    );
    assert.throws(
        () =>
            validateAuthoredDefinition({
                name: 'stock-brief',
                description: 'Create a stock brief',
                phases: [{ name: 'Publish' }],
                inputSchema: {
                    type: 'object',
                    properties: { stock: { type: 'string' } },
                    required: ['stock'],
                    additionalProperties: false
                },
                script: [
                    "await phase('Publish');",
                    "const stock = args.stock || 'example';",
                    'await report({ stock });',
                    'return { stock };'
                ].join('\n')
            }),
        /必填输入“stock”必须直接从 args 读取，不能使用字面量默认值/
    );
    assert.throws(
        () =>
            validateAuthoredDefinition(
                {
                    name: 'deferred-workflow',
                    description: 'Declare the workflow without starting it',
                    phases: [{ name: 'Publish' }],
                    inputSchema: { type: 'object' },
                    script: [
                        'async function execute() {',
                        "    await phase('Publish');",
                        "    await report({ status: 'done' });",
                        "    return { status: 'done' };",
                        '}'
                    ].join('\n')
                },
                toolCatalog
            ),
        /必须在 async 函数体中直接包含可执行语句/
    );

    const taskManager = new TaskManagerState();
    taskManager.toolsetProvider = provider;
    const workflowAgentTask = new TaskState(taskManager, 'host-task');
    workflowAgentTask.allowedTools = declaredTools;
    const runtimeToolsets = await workflowAgentTask.buildToolsets();
    const runtimeWebSearch = runtimeToolsets
        .flatMap((toolset) => [...toolset.tools.values()])
        .find((tool) => tool.name === 'WebSearch');

    assert.ok(runtimeWebSearch);
    const result = await runtimeWebSearch.execute({ query: '600519' }, undefined, workflowAgentTask);
    assert.equal(result.status, 'success');
    assert.equal(result.result, 'Evidence for 600519');
    assert.equal(searchedQuery, '600519');
});

test('Workflow authoring keeps raw user intent through self-review without inventing first-run input', async () => {
    class RepairingRunner extends WorkflowAgentRunner {
        override async run(...args: Parameters<WorkflowAgentRunner['run']>): ReturnType<WorkflowAgentRunner['run']> {
            assert.match(args[1].prompt, /## 用户输入 1\n创建一个输入股票名称的分析工作流/);
            assert.match(args[1].prompt, /## 用户输入 2\n请使用 Workflow 创建/);
            assert.doesNotMatch(args[1].prompt, /处理后的消息内容/);
            const definition = {
                name: 'stock-brief',
                description: 'Create a stock brief',
                whenToUse: 'When the user requests stock analysis',
                phases: [{ name: 'Publish' }],
                inputSchema: {
                    type: 'object',
                    properties: { stock: { type: 'string' } },
                    required: ['stock'],
                    additionalProperties: false
                },
                script: [
                    "await phase('Publish');",
                    'const output = { stock: args.stock };',
                    'await report(output);',
                    'return output;'
                ].join('\n')
            };
            const invented = {
                status: 'success' as const,
                summary: 'Drafted with an example',
                output: {
                    ...definition,
                    launchInput: { stock: '贵州茅台' }
                }
            };
            const repaired = {
                status: 'success' as const,
                summary: 'Drafted without invented input',
                output: definition
            };
            const task = new TaskState(new TaskManagerState(), 'authoring-agent');
            let accepted: WorkflowAgentResult | undefined;
            let terminalError: Error | undefined;
            args[2]?.configureTask?.(task, {
                toolName: WORKFLOW_AGENT_COMPLETION_TOOL_NAME,
                parse: (toolCall) => toolCall.args_object as WorkflowAgentResult,
                accept: (_activeTask, _toolCall, completion) => {
                    accepted = completion;
                },
                fail: (_activeTask, error) => {
                    terminalError = error;
                }
            });
            const submit = async (completion: WorkflowAgentResult, id: string): Promise<ToolCall> => {
                const toolCall = new ToolCall(0, id, WORKFLOW_AGENT_COMPLETION_TOOL_NAME, JSON.stringify(completion));
                toolCall.args_object = completion;
                toolCall.status = 'success';
                await task.hooks.noticeAfterToolCall({ task, toolCall });
                return toolCall;
            };

            const rejected = await submit(invented, 'invented');
            assert.equal(rejected.status, 'error');
            assert.match(rejected.result, /宿主用户未提供的值/);

            const review = await submit(repaired, 'review');
            assert.equal(review.status, 'success');
            assert.equal((review.result_object as { reviewRequired?: boolean }).reviewRequired, true);
            assert.match(review.result, /用户需求一致性/);
            assert.match(review.result, /实现质量/);
            assert.match(review.result, /## 用户输入 1\n创建一个输入股票名称的分析工作流/);
            assert.match(review.result, /## 用户输入 2\n请使用 Workflow 创建/);

            await submit(repaired, 'accepted');
            assert.equal(terminalError, undefined);
            assert.ok(accepted);
            return accepted;
        }
    }

    const manager = {
        collectDefinitionValidationErrors: () => [],
        validateInput: () => ({}),
        createDefinition: (definition: Record<string, unknown>) => ({
            id: 'workflow-stock-brief',
            revision: 'revision-stock-brief',
            ...definition,
            createdAt: '2026-07-21T00:00:00.000Z',
            updatedAt: '2026-07-21T00:00:00.000Z'
        })
    } as unknown as WorkflowManager;
    const chatContext = new ChatContext();
    const userMessage = new UserMessage('处理后的消息内容');
    userMessage.rawText = '创建一个输入股票名称的分析工作流';
    chatContext.appendMessage(userMessage);
    const internalMessage = new UserMessage('内部消息不能成为 Workflow 原始输入');
    internalMessage.internal = true;
    chatContext.appendMessage(internalMessage);
    chatContext.appendMessage(new UserMessage('请使用 Workflow 创建'));
    const hostTask = {
        task_status: 'running',
        disabledTools: [],
        chat_context: chatContext,
        task_manager_state: {
            toolsetProvider: {
                listAvailableToolsets: async () => []
            }
        },
        waitUntilFinished: async () => await new Promise<never>(() => undefined)
    } as unknown as TaskState;

    const authored = await new WorkflowAuthoringService(new RepairingRunner(), manager).author(hostTask);

    assert.equal(authored.launchReady, false);
    assert.deepEqual(authored.missingRequiredInputs, ['stock']);
    assert.deepEqual(authored.invocation, { reference: authored.reference });
});

test('Stopping the host Task cancels its active authoring execution before creating a definition', async () => {
    const runner = new CancellableWorkflowAgentRunner();
    let createDefinitionCalled = false;
    const manager = {
        createDefinition: () => {
            createDefinitionCalled = true;
            throw new Error('definition must not be created after cancellation');
        }
    } as unknown as WorkflowManager;
    const chatContext = new ChatContext();
    chatContext.appendMessage(new UserMessage('Create a daily brief'));
    let finishHostTask!: () => void;
    const hostTask = {
        task_status: 'running',
        disabledTools: [],
        chat_context: chatContext,
        task_manager_state: {
            toolsetProvider: {
                listAvailableToolsets: async () => []
            }
        },
        waitUntilFinished: async () =>
            await new Promise<void>((resolve) => {
                finishHostTask = resolve;
            })
    } as unknown as TaskState;
    const service = new WorkflowAuthoringService(runner, manager);

    const authoring = service.author(hostTask);
    await runner.started;
    hostTask.task_status = 'stopped';
    finishHostTask();

    await assert.rejects(authoring, WorkflowAuthoringCancelledError);
    assert.match(runner.executionId ?? '', /^authoring_/);
    assert.equal(runner.stoppedExecutionId, runner.executionId);
    assert.equal(createDefinitionCalled, false);
});
