import { jest } from '@jest/globals';
import {
    AssistantMessageView,
    ReasoningMessagePartView,
    TaskView,
    ToolCallMessagePartView
} from '../../../../main/tui/components/taskview';
import {
    AssistantMessage,
    ChatContext,
    ErrorMessagePart,
    ReasoningMessagePart,
    TextMessagePart,
    ToolCall,
    ToolCallMessagePart,
    UserMessage
} from '../../../../main/aikernel/messages';
import type {
    TaskUpdateChunk,
    TaskUpdateGoalEvalChunk,
    TaskUpdateUserChunk
} from '../../../../main/aikernel/states/tasks';
import { Setting } from '../../../../main/utils/setting';
import { setRuntimeLocale } from '../../../../locale/index';
import { BaseTool } from '../../../../main/aikernel/tool';
import { z } from 'zod';
import chalk from 'chalk';
import stripAnsi from 'strip-ansi';

const initialChalkLevel = chalk.level;

function createToolPart(id: number, filePath: string, customOutput = `CUSTOM TOOL ${id}`): ToolCallMessagePart {
    const part = new ToolCallMessagePart();
    const toolCall = new ToolCall(id, `tool-${id}`, 'filemgr-readFile', JSON.stringify({ file_path: filePath }));
    toolCall.args_object = { file_path: filePath };
    toolCall.status = 'success';
    toolCall.setTool({
        renderToolCallCli: jest.fn(() => [customOutput])
    } as any);
    part.toolcalls.push(toolCall);
    return part;
}

function createRunningToolPart(id: number, filePath: string): ToolCallMessagePart {
    const part = createToolPart(id, filePath);
    part.toolcalls[0].status = 'running';
    return part;
}

function createAttentionToolPart(id: number, customOutput = 'SCAN QR CODE'): ToolCallMessagePart {
    const part = createRunningToolPart(id, `src/${id}.ts`);
    part.toolcalls[0].setTool({
        requiresUserAttention: jest.fn(() => true),
        renderToolCallCli: jest.fn(() => [customOutput])
    } as any);
    return part;
}

function createNamedToolPart(id: number, toolName: string): ToolCallMessagePart {
    const part = createToolPart(id, `src/${id}.ts`);
    part.toolcalls[0].tool_name = toolName;
    // 模拟真实注册表解析：挂上带双语显示名的 BaseTool，使 getResolvedToolDisplayName 可用
    part.toolcalls[0].setTool(
        new BaseTool(
            toolName.includes('-') ? toolName.slice(toolName.indexOf('-') + 1) : toolName,
            'test tool',
            z.object({})
        )
    );
    return part;
}

/** 为工具调用挂载带指定双语显示名的 BaseTool（模拟注册表解析后的状态）。 */
function withDisplayName(part: ToolCallMessagePart, zh: string, en: string): ToolCallMessagePart {
    const toolName = part.toolcalls[0].tool_name;
    const bareName = toolName.includes('-') ? toolName.slice(toolName.indexOf('-') + 1) : toolName;
    part.toolcalls[0].setTool(
        new BaseTool(bareName, 'test tool', z.object({}), undefined, { 'zh-CN': zh, 'en-US': en })
    );
    return part;
}

describe('TaskView chunk handling', () => {
    beforeEach(() => {
        setRuntimeLocale('en-US');
        Setting.clearCache();
        Setting.updateInstanceData({
            cli_config: {
                output_display: 'minimal',
                show_all_reasoning: false
            }
        });
    });

    afterEach(() => {
        chalk.level = initialChalkLevel;
        jest.restoreAllMocks();
        setRuntimeLocale(null);
        Setting.clearCache();
    });
    test('internal compact marker does not change assistant part indices', async () => {
        const view = new AssistantMessageView();
        await view.updateTextPart(0, { type: 'text', text: 'before' } as any);
        await view.updateTextPart(1, { type: 'text', text: 'after' } as any);
        view.setCompactBoundary(1, 'auto');
        expect(stripAnsi(view.render(80).join('\n'))).toContain('Context automatically compressed');
        expect(view.parts).toHaveLength(2);
        expect(view.box.children).toHaveLength(3);
        expect(view.box.children[0]).toBe(view.parts[0]);
        expect(view.box.children[2]).toBe(view.parts[1]);
        await view.updateTextPart(1, { type: 'text', text: 'updated' } as any);
        view.render(80);
        expect(view.box.children).toHaveLength(3);
        expect(view.box.children[2]).toBe(view.parts[1]);
    });
    test('shows one temporary compact indicator and clears it on failure', async () => {
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        const update = {
            type: 'compact' as const,
            task_id: 'task_1',
            task_status: 'running' as const,
            trigger: 'auto' as const,
            phase: 'start' as const
        };
        await taskView.handleChunkUpdate(update);
        await taskView.handleChunkUpdate(update);
        expect(taskView.messages).toHaveLength(1);
        await taskView.handleChunkUpdate({ ...update, phase: 'end', compacted: false });
        expect(taskView.messages).toHaveLength(0);
    });

    test('skips malformed user chunks without throwing', async () => {
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        const chunk = {
            type: 'user',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 3,
            last_part: undefined
        } as unknown as TaskUpdateUserChunk;

        await expect(taskView.handleChunkUpdate(chunk)).resolves.toBeUndefined();

        expect(taskView.messages).toHaveLength(0);
    });

    test('skips malformed assistant chunks without throwing', async () => {
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        const chunks = [
            {
                type: 'assistant',
                task_id: 'task_1',
                task_status: 'running',
                message_id: 'message_1',
                last_part_index: Number.MAX_SAFE_INTEGER,
                last_part: { type: 'text', text: 'hello' }
            },
            {
                type: 'assistant',
                task_id: 'task_1',
                task_status: 'running',
                message_id: 'message_1',
                last_part_index: 0,
                last_part: undefined
            },
            {
                type: 'assistant_replace',
                task_id: 'task_1',
                task_status: 'running',
                message_id: 'message_1',
                parts: undefined
            },
            {
                type: 'assistant_replace',
                task_id: 'task_1',
                task_status: 'running',
                message_id: 'message_1',
                parts: [undefined, { type: 'text', text: 'kept' }]
            },
            {
                type: 'unknown',
                task_id: 'task_1',
                task_status: 'running'
            }
        ] as unknown as TaskUpdateChunk[];

        for (const chunk of chunks) {
            await expect(taskView.handleChunkUpdate(chunk)).resolves.toBeUndefined();
        }

        expect(taskView.messages).toHaveLength(1);
    });

    test('routes goal evaluation updates to the panel without adding a message card', async () => {
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        const onGoalEvalUpdate = jest.fn();
        taskView.onGoalEvalUpdate = onGoalEvalUpdate;
        const chunk: TaskUpdateGoalEvalChunk = {
            type: 'goal_eval',
            task_id: 'task_1',
            task_status: 'running',
            phase: 'start',
            evaluationId: 'eval_1',
            startedAt: '2026-01-01T00:00:00.000Z'
        };

        await taskView.handleChunkUpdate(chunk);

        expect(onGoalEvalUpdate).toHaveBeenCalledWith(chunk);
        expect(taskView.messages).toHaveLength(0);
    });

    test('consumes only matching pending goal supplements and resets the rest on task switch', async () => {
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.appendPendingGoalSupplementMessage('first pending', 'supplement-1');
        taskView.appendPendingGoalSupplementMessage('unidentified pending');

        await taskView.handleChunkUpdate({
            type: 'user',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 0,
            last_part: { type: 'text', text: 'first pending' },
            internal: true,
            metadata: {
                origin: { source: 'internal', reason: 'goal_supplement' },
                execution: { controller: 'goal', supplementIds: ['supplement-1'] }
            }
        } as any);

        expect((taskView as any).pendingGoalSupplementViews).toHaveLength(1);
        expect(taskView.messages).toHaveLength(2);

        taskView.clearMessages();

        expect((taskView as any).pendingGoalSupplementViews).toHaveLength(0);
        expect(taskView.messages).toHaveLength(0);
    });

    test('rebuilds history while skipping malformed message parts', () => {
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        const chatContext = new ChatContext();
        const userMessage = new UserMessage();
        (userMessage as any).content = [undefined, { type: 'text', text: 'visible user' }];
        const assistantMessage = new AssistantMessage();
        (assistantMessage as any).content = [undefined, { type: 'text', text: 'visible assistant' }];
        chatContext.appendMessage(userMessage);
        chatContext.appendMessage(assistantMessage);
        taskView.taskState = {
            task_id: 'task_1',
            chat_context: chatContext
        } as any;

        expect(() => taskView.rebuildFromHistory()).not.toThrow();
        expect(taskView.messages).toHaveLength(2);
    });

    test('rebuilds completed assistant output without a duration row', () => {
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        const chatContext = new ChatContext();
        const assistantMessage = new AssistantMessage([new TextMessagePart('Finished response')]);
        chatContext.appendMessage(assistantMessage);
        taskView.taskState = {
            task_id: 'task_1',
            task_status: 'stopped',
            chat_context: chatContext
        } as any;

        taskView.rebuildFromHistory();

        expect(taskView.render(100).map((line) => stripAnsi(line).trim())).toContain('─'.repeat(100));
    });

    test('rebuilds earlier assistant messages as sealed phases and only completes the final message', () => {
        jest.spyOn(Date, 'now').mockReturnValue(100_000);
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        const chatContext = new ChatContext();
        const first = new AssistantMessage([createToolPart(1, 'src/one.ts')]);
        const second = new AssistantMessage([new TextMessagePart('Final response')]);
        chatContext.appendMessage(first);
        chatContext.appendMessage(second);
        taskView.taskState = {
            task_id: 'task_1',
            task_status: 'stopped',
            chat_context: chatContext
        } as any;

        taskView.rebuildFromHistory();

        const output = stripAnsi(taskView.render(100).join('\n'));
        expect(output).toContain('Used filemgr-rea… in 1 tool call');
        expect(output).toContain('Final response');
        expect(output.split('\n').filter((line) => /^─+$/.test(line.trim()))).toHaveLength(1);
        expect(output).not.toMatch(/[✣✤✥✦]/);
    });

    test('rebuilds the final assistant message of each user turn as terminal', () => {
        jest.spyOn(Date, 'now').mockReturnValue(100_000);
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        const chatContext = new ChatContext();
        const first = new AssistantMessage([new TextMessagePart('First turn response')]);
        const second = new AssistantMessage([new TextMessagePart('Second turn response')]);
        chatContext.appendMessage(first);
        chatContext.appendMessage(new UserMessage('Next question'));
        chatContext.appendMessage(second);
        taskView.taskState = {
            task_id: 'task_1',
            task_status: 'stopped',
            chat_context: chatContext
        } as any;

        taskView.rebuildFromHistory();

        const output = stripAnsi(taskView.render(100).join('\n'));
        expect(output).toContain('First turn response');
        expect(output).toContain('Second turn response');
        expect(output.split('\n').filter((line) => /^─+$/.test(line.trim()))).toHaveLength(2);
    });

    test('rebuilds assistant errors with a failed terminal status', () => {
        jest.spyOn(Date, 'now').mockReturnValue(100_000);
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        const chatContext = new ChatContext();
        const assistantMessage = new AssistantMessage([
            new ErrorMessagePart('Stream Completion Failed', 'connection refused')
        ]);
        chatContext.appendMessage(assistantMessage);
        taskView.taskState = {
            task_id: 'task_1',
            task_status: 'stopped',
            chat_context: chatContext
        } as any;

        taskView.rebuildFromHistory();

        const output = stripAnsi(taskView.render(100).join('\n'));
        expect(output).toContain('Failed');
        expect(output).not.toContain('Complete');
    });

    test('renders tool call parts with missing toolcalls as empty output', () => {
        const view = new ToolCallMessagePartView();

        expect(() => view.setToolcalls(undefined as any)).not.toThrow();
        expect(() => view.render(80)).not.toThrow();
    });

    test('assistant_replace can rebase an existing text part to reasoning', async () => {
        const taskView = new TaskView({ requestRender: jest.fn() } as any);

        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 0,
            provisional: 'implicit_think_close_candidate',
            last_part: { type: 'text', text: 'hidden' }
        } as any);
        await taskView.handleChunkUpdate({
            type: 'assistant_replace',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            parts: [
                { type: 'reasoning', content: 'hidden' },
                { type: 'text', text: 'visible' }
            ]
        } as any);

        const assistantView = taskView.messages[0] as any;
        expect(assistantView.parts).toHaveLength(2);
        expect(assistantView.parts[0]).toBeInstanceOf(ReasoningMessagePartView);
    });

    test('minimal mode keeps one live status line and hides reason and tool views', async () => {
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.setOutputDisplayLevel('minimal');
        taskView.startStreaming();

        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 0,
            last_part: new ReasoningMessagePart('private reasoning', 'reasoning_content')
        });
        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 1,
            last_part: createRunningToolPart(1, 'src/main/tui/components/taskview.ts')
        });

        const output = stripAnsi(taskView.render(100).join('\n'));
        expect(output).toContain('Running filemgr-readFile');
        expect(output.match(/[✣✤✥✦]/g)).toHaveLength(1);
        expect(output).not.toContain('1 tool');
        expect(output).not.toContain('private reasoning');
        expect(output).not.toContain('CUSTOM TOOL 1');
    });

    test('minimal running status uses the localized tool name', async () => {
        setRuntimeLocale('zh-CN');
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.setOutputDisplayLevel('minimal');
        taskView.startStreaming();
        const toolPart = withDisplayName(createNamedToolPart(1, 'search-webFetch'), '网页获取', 'Web Fetch');
        toolPart.toolcalls[0].status = 'running';

        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 0,
            last_part: toolPart
        });

        expect(stripAnsi(taskView.render(100).join('\n'))).toContain('正在执行 网页获取');
    });

    test('minimal mode distinguishes live reasoning from waiting for a response', async () => {
        const waitingTaskView = new TaskView({ requestRender: jest.fn() } as any);
        waitingTaskView.setOutputDisplayLevel('minimal');
        waitingTaskView.startStreaming();

        let output = stripAnsi(waitingTaskView.render(100).join('\n'));
        expect(output).toContain('Generating response…');
        expect(output).not.toContain('0 tools');

        setRuntimeLocale('zh-CN');
        const reasoningTaskView = new TaskView({ requestRender: jest.fn() } as any);
        reasoningTaskView.setOutputDisplayLevel('minimal');
        reasoningTaskView.startStreaming();
        await reasoningTaskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 0,
            last_part: new ReasoningMessagePart('private reasoning', 'reasoning_content')
        });

        output = stripAnsi(reasoningTaskView.render(100).join('\n'));
        expect(output).toContain('正在思考…');
        expect(output).not.toContain('正在生成回复…');
        expect(output).not.toContain('0 个工具');
    });

    test('minimal running tool status reports the completed tool call count', async () => {
        setRuntimeLocale('zh-CN');
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.setOutputDisplayLevel('minimal');
        taskView.startStreaming();

        const donePart = withDisplayName(createNamedToolPart(0, 'filemgr-grepFiles'), '内容搜索', 'Grep');
        donePart.toolcalls[0].status = 'success';
        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 0,
            last_part: donePart
        });

        const runningPart = withDisplayName(createNamedToolPart(1, 'filemgr-readFile'), '读取文件', 'Read File');
        runningPart.toolcalls[0].status = 'running';
        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 1,
            last_part: runningPart
        });

        const output = stripAnsi(taskView.render(100).join('\n'));
        expect(output).toContain('正在执行 读取文件 · 已调用 1 个工具');
    });

    test('minimal reasoning status lists completed tools while thinking', async () => {
        setRuntimeLocale('zh-CN');
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.setOutputDisplayLevel('minimal');
        taskView.startStreaming();

        const donePart = withDisplayName(createNamedToolPart(0, 'filemgr-grepFiles'), '内容搜索', 'Grep');
        donePart.toolcalls[0].status = 'success';
        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 0,
            last_part: donePart
        });

        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 1,
            last_part: new ReasoningMessagePart('private reasoning', 'reasoning_content')
        });

        const output = stripAnsi(taskView.render(100).join('\n'));
        expect(output).toContain('正在思考… · 已调用 内容搜索 等 1 个工具');
    });

    test('minimal running tool status counts only the current block after body text', async () => {
        setRuntimeLocale('zh-CN');
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.setOutputDisplayLevel('minimal');
        taskView.startStreaming();

        const earlierPart = withDisplayName(createNamedToolPart(0, 'filemgr-grepFiles'), '内容搜索', 'Grep');
        earlierPart.toolcalls[0].status = 'success';
        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 0,
            last_part: earlierPart
        });
        const earlierPart2 = withDisplayName(createNamedToolPart(1, 'filemgr-globFiles'), '模式匹配', 'Glob');
        earlierPart2.toolcalls[0].status = 'success';
        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 1,
            last_part: earlierPart2
        });
        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 2,
            last_part: new TextMessagePart('第一部分完成。', 'rendered')
        });

        const currentDone = withDisplayName(createNamedToolPart(3, 'filemgr-extractText'), '提取文本', 'Extract Text');
        currentDone.toolcalls[0].status = 'success';
        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 3,
            last_part: currentDone
        });
        const runningPart = withDisplayName(createNamedToolPart(4, 'filemgr-readFile'), '读取文件', 'Read File');
        runningPart.toolcalls[0].status = 'running';
        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 4,
            last_part: runningPart
        });

        const output = stripAnsi(taskView.render(100).join('\n'));
        expect(output).toContain('正在执行 读取文件 · 已调用 1 个工具');
        // 当前块只统计 1 个，不能累计上一块的 2 个
        expect(output).not.toContain('已调用 3 个工具');
        expect(output).not.toContain('正在执行 读取文件 · 已调用 2 个工具');
    });

    test('minimal mode keeps a running tool visible when it requires user attention', async () => {
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.setOutputDisplayLevel('minimal');
        taskView.startStreaming();

        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 0,
            last_part: new ReasoningMessagePart('private reasoning', 'reasoning_content')
        });
        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 1,
            last_part: createAttentionToolPart(1)
        });

        const output = stripAnsi(taskView.render(100).join('\n'));
        expect(output).toContain('SCAN QR CODE');
        expect(output).not.toContain('private reasoning');
    });

    test('minimal running status rotates its flower icon on stream refresh', async () => {
        const now = jest.spyOn(Date, 'now').mockReturnValue(0);
        const tui = { requestRender: jest.fn() } as any;
        const taskView = new TaskView(tui);
        taskView.setOutputDisplayLevel('minimal');
        taskView.startStreaming();
        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 0,
            last_part: createRunningToolPart(1, 'src/one.ts')
        });

        expect(stripAnsi(taskView.render(100).join('\n'))).toContain('✣ Running filemgr-readFile');

        now.mockReturnValue(300);
        taskView.requestStreamRender();

        expect(tui.requestRender).toHaveBeenCalledTimes(1);
        expect(stripAnsi(taskView.render(100).join('\n'))).toContain('✤ Running filemgr-readFile');
    });

    test('minimal mode renders a live assistant error with a red failed terminal status', async () => {
        const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.setOutputDisplayLevel('minimal');
        taskView.startStreaming();

        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 0,
            last_part: new ErrorMessagePart('Stream Completion Failed', 'connection refused')
        });
        now.mockReturnValue(2_500);
        taskView.clearStreamThrottle();

        chalk.level = 3;
        const rawOutput = taskView.render(100).join('\n');
        const output = stripAnsi(rawOutput);
        expect(output).toContain('Failed');
        expect(output).not.toContain('Complete');
        expect(rawOutput).toContain(`${chalk.redBright('●')} ${chalk.redBright('Failed')}`);
    });

    test('minimal mode keeps a failed terminal status when an error follows partial text', async () => {
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.setOutputDisplayLevel('minimal');

        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 0,
            last_part: new TextMessagePart('Partial response')
        });
        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 1,
            last_part: new ErrorMessagePart('Stream Completion Failed', 'connection reset')
        });
        taskView.clearStreamThrottle();

        const output = stripAnsi(taskView.render(100).join('\n'));
        expect(output).toContain('Partial response');
        expect(output).toContain('Failed ·');
        expect(output).not.toContain('Complete');
    });

    test('minimal mode keeps a successful terminal status after a recoverable tool error', async () => {
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.setOutputDisplayLevel('minimal');
        const toolPart = createToolPart(1, 'missing-file.ts');
        toolPart.toolcalls[0].status = 'error';

        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 0,
            last_part: toolPart
        });
        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 1,
            last_part: new TextMessagePart('Recovered response')
        });
        taskView.clearStreamThrottle();

        const output = stripAnsi(taskView.render(100).join('\n'));
        expect(output).toContain('Recovered response');
        expect(output.split('\n').some((line) => /^─+$/.test(line.trim()))).toBe(true);
        expect(output).not.toContain('Complete ·');
        expect(output).not.toContain('Failed');
    });

    test('minimal final output stream does not report a completed tool as running', async () => {
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.setOutputDisplayLevel('minimal');
        taskView.startStreaming();

        const parts = [createToolPart(1, 'src/final-source.ts'), new TextMessagePart('Streaming final output')];
        for (let index = 0; index < parts.length; index += 1) {
            await taskView.handleChunkUpdate({
                type: 'assistant',
                task_id: 'task_1',
                task_status: 'running',
                message_id: 'message_1',
                last_part_index: index,
                last_part: parts[index]
            } as any);
        }

        const output = stripAnsi(taskView.render(100).join('\n'));
        expect(output).toContain('Streaming final output');
        expect(output).not.toContain('Reading `src/final-source.ts`');
        expect(output).not.toMatch(/[✣✤✥✦]/);
    });

    test('minimal mode seals the previous assistant message when a new message starts', async () => {
        const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.setOutputDisplayLevel('minimal');
        taskView.startStreaming();

        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            timestamp: 1_000,
            last_part_index: 0,
            last_part: createToolPart(1, 'src/one.ts')
        });
        now.mockReturnValue(3_000);
        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_2',
            timestamp: 3_000,
            last_part_index: 0,
            last_part: new TextMessagePart('Final response')
        });
        now.mockReturnValue(5_000);
        taskView.clearStreamThrottle();

        let output = stripAnsi(taskView.render(100).join('\n'));
        expect(output).toContain('Used filemgr-rea… in 1 tool call');
        expect(output).toContain('Final response');
        expect(output.split('\n').filter((line) => /^─+$/.test(line.trim()))).toHaveLength(1);
        expect(output).not.toMatch(/[✣✤✥✦]/);

        now.mockReturnValue(20_000);
        taskView.invalidate();
        output = stripAnsi(taskView.render(100).join('\n'));
        expect(output).toContain('Used filemgr-rea… in 1 tool call');
    });

    test('minimal mode updates elapsed time before the first assistant event', () => {
        const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.setOutputDisplayLevel('minimal');
        taskView.startStreaming();
        now.mockReturnValue(2_500);

        const output = stripAnsi(taskView.render(100).join('\n'));
        expect(output.match(/[✣✤✥✦]/g)).toHaveLength(1);
        expect(output).toContain('Generating response…');

        now.mockRestore();
    });

    test('minimal mode groups consecutive tools without crossing assistant body boundaries', async () => {
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.setOutputDisplayLevel('minimal');
        taskView.startStreaming();

        const parts = [
            new ReasoningMessagePart('private reasoning', 'reasoning_content'),
            createToolPart(1, 'src/one.ts'),
            createToolPart(2, 'src/two.ts'),
            new TextMessagePart('First body'),
            createToolPart(3, 'src/three.ts'),
            new TextMessagePart('Second body')
        ];
        for (let index = 0; index < parts.length; index += 1) {
            await taskView.handleChunkUpdate({
                type: 'assistant',
                task_id: 'task_1',
                task_status: 'running',
                message_id: 'message_1',
                last_part_index: index,
                last_part: parts[index]
            } as any);
        }

        const renderedLines = taskView.render(100).map((line) => stripAnsi(line));
        const output = renderedLines.join('\n');
        const firstSummary = output.indexOf('Deep reasoning · Used filemgr-rea… in 2 tool calls');
        const firstBody = output.indexOf('First body');
        const secondSummary = output.indexOf('Deep reasoning · Used filemgr-rea… in 1 tool call', firstBody);
        const secondBody = output.indexOf('Second body');
        expect(firstSummary).toBeGreaterThanOrEqual(0);
        expect(firstSummary).toBeLessThan(firstBody);
        expect(firstBody).toBeLessThan(secondSummary);
        expect(secondSummary).toBeLessThan(secondBody);
        expect(output).not.toMatch(/[✣✤✥✦]/);

        const firstSummaryLine = renderedLines.findIndex((line) =>
            line.includes('Deep reasoning · Used filemgr-rea… in 2 tool calls')
        );
        const firstBodyLine = renderedLines.findIndex((line) => line.includes('First body'));
        const secondSummaryLine = renderedLines.findIndex(
            (line, index) => index > firstBodyLine && line.includes('Deep reasoning · Used filemgr-rea… in 1 tool call')
        );
        const secondBodyLine = renderedLines.findIndex((line) => line.includes('Second body'));
        expect(renderedLines[0].trim()).toBe('');
        expect(renderedLines.at(-1)?.trim()).toBe('');
        expect(firstBodyLine - firstSummaryLine).toBe(2);
        expect(secondSummaryLine - firstBodyLine).toBe(1);
        expect(secondBodyLine - secondSummaryLine).toBe(2);
    });

    test('minimal mode removes extra gaps when a body ends with markdown blank lines', async () => {
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.setOutputDisplayLevel('minimal');
        taskView.startStreaming();

        const parts = [new TextMessagePart('Body with trailing markdown breaks\n\n'), createToolPart(1, 'src/one.ts')];
        for (let index = 0; index < parts.length; index += 1) {
            await taskView.handleChunkUpdate({
                type: 'assistant',
                task_id: 'task_1',
                task_status: 'running',
                message_id: 'message_1',
                last_part_index: index,
                last_part: parts[index]
            } as any);
        }

        const renderedLines = taskView.render(100).map((line) => stripAnsi(line));
        const bodyLine = renderedLines.findIndex((line) => line.includes('Body with trailing markdown breaks'));
        const statusLine = renderedLines.findIndex((line) => line.includes('Generating response…'));
        expect(bodyLine).toBeGreaterThanOrEqual(0);
        expect(statusLine - bodyLine).toBe(1);
    });

    test('minimal mode removes spacing between consecutive assistant messages', () => {
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        const chatContext = new ChatContext();
        const first = new AssistantMessage([createToolPart(1, 'src/one.ts'), new TextMessagePart('First final')]);
        const second = new AssistantMessage([createToolPart(2, 'src/two.ts'), new TextMessagePart('Second final')]);
        chatContext.appendMessage(first);
        chatContext.appendMessage(second);
        taskView.taskState = {
            task_id: 'task_1',
            task_status: 'stopped',
            chat_context: chatContext
        } as any;

        taskView.rebuildFromHistory();

        const renderedLines = taskView.render(100).map((line) => stripAnsi(line));
        const firstBodyLine = renderedLines.findIndex((line) => line.includes('First final'));
        const secondDividerLine = renderedLines.findIndex(
            (line, index) => index > firstBodyLine && /^─+$/.test(line.trim())
        );
        expect(firstBodyLine).toBeGreaterThanOrEqual(0);
        expect(secondDividerLine - firstBodyLine).toBe(1);
    });

    test('verbose mode removes spacing between consecutive assistant messages', () => {
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.setOutputDisplayLevel('verbose');
        const chatContext = new ChatContext();
        chatContext.appendMessage(new AssistantMessage([new TextMessagePart('First response')]));
        chatContext.appendMessage(new AssistantMessage([new TextMessagePart('Second response')]));
        taskView.taskState = {
            task_id: 'task_1',
            task_status: 'stopped',
            chat_context: chatContext
        } as any;

        taskView.rebuildFromHistory();

        const renderedLines = taskView.render(100).map((line) => stripAnsi(line));
        const firstLine = renderedLines.findIndex((line) => line.includes('First response'));
        const secondLine = renderedLines.findIndex((line) => line.includes('Second response'));
        expect(firstLine).toBeGreaterThanOrEqual(0);
        expect(secondLine - firstLine).toBe(1);
    });

    test('minimal mode keeps user-to-assistant message spacing', () => {
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        const chatContext = new ChatContext();
        chatContext.appendMessage(new UserMessage('User prompt'));
        chatContext.appendMessage(
            new AssistantMessage([createToolPart(1, 'src/one.ts'), new TextMessagePart('Assistant final')])
        );
        taskView.taskState = {
            task_id: 'task_1',
            task_status: 'stopped',
            chat_context: chatContext
        } as any;

        taskView.rebuildFromHistory();

        const renderedLines = taskView.render(100).map((line) => stripAnsi(line));
        const userLine = renderedLines.findIndex((line) => line.includes('User prompt'));
        const assistantDividerLine = renderedLines.findIndex((line) => /^─+$/.test(line.trim()));
        expect(userLine).toBeGreaterThanOrEqual(0);
        expect(assistantDividerLine - userLine).toBe(2);
    });

    test('minimal tool summary shows localized reasoning, readable tool names, and elapsed time', async () => {
        setRuntimeLocale('zh-CN');
        const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.setOutputDisplayLevel('minimal');
        taskView.startStreaming();
        const toolGroup = new ToolCallMessagePart();
        const readFile = withDisplayName(createNamedToolPart(1, 'filemgr-readFile'), '读取文件', 'Read File')
            .toolcalls[0];
        const grepFiles = withDisplayName(createNamedToolPart(2, 'filemgr-grepFiles'), '内容搜索', 'Grep').toolcalls[0];
        const addMemory = withDisplayName(createNamedToolPart(3, 'memory-addMemory'), '添加记忆', 'Add Memory')
            .toolcalls[0];
        toolGroup.toolcalls.push(readFile, grepFiles, addMemory);
        const parts = [
            new ReasoningMessagePart('private reasoning', 'reasoning_content'),
            toolGroup,
            new TextMessagePart('正文')
        ];
        for (let index = 0; index < parts.length; index += 1) {
            if (index === 2) now.mockReturnValue(3_000);
            await taskView.handleChunkUpdate({
                type: 'assistant',
                task_id: 'task_1',
                task_status: 'running',
                message_id: 'message_1',
                last_part_index: index,
                last_part: parts[index]
            } as any);
        }

        chalk.level = 3;
        const rawOutput = taskView.render(100).join('\n');
        const output = stripAnsi(rawOutput);
        expect(output).toContain('✓ 深度思考 · 使用了 读取文件、内容搜索 等 3个工具');
        expect(output).not.toContain('4个工具');
        expect(output).not.toContain('已执行工具');
        expect(rawOutput).toContain(
            `${chalk.greenBright('✓')} ${chalk.dim('深度思考 · 使用了 读取文件、内容搜索 等 3个工具')}`
        );
    });

    test('minimal tool summary uses the mainline tool name', async () => {
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.setOutputDisplayLevel('minimal');
        taskView.startStreaming();
        const part = createNamedToolPart(1, 'plugin-opaqueOperation');
        part.toolcalls[0].setTool({
            renderToolCallCli: jest.fn(() => ['custom detail'])
        } as any);

        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 0,
            last_part: part
        });
        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 1,
            last_part: new TextMessagePart('Done')
        });
        const output = stripAnsi(taskView.render(100).join('\n'));
        expect(output).toContain('Used plugin-opaq… in 1 tool call');
    });

    test('minimal tool summaries freeze each tool group duration independently', async () => {
        const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.setOutputDisplayLevel('minimal');
        taskView.startStreaming();

        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 0,
            last_part: new ReasoningMessagePart('private reasoning', 'reasoning_content')
        });
        now.mockReturnValue(2_000);
        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 1,
            last_part: createToolPart(1, 'src/one.ts')
        });
        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 2,
            last_part: createToolPart(2, 'src/two.ts')
        });
        now.mockReturnValue(7_000);
        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 3,
            last_part: new TextMessagePart('First body')
        });
        now.mockReturnValue(8_000);
        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 4,
            last_part: createToolPart(3, 'src/three.ts')
        });
        now.mockReturnValue(11_000);
        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 5,
            last_part: new TextMessagePart('Second body')
        });

        now.mockReturnValue(20_000);
        let output = stripAnsi(taskView.render(100).join('\n'));
        expect(output).toContain('Deep reasoning · Used filemgr-rea… in 2 tool calls');
        expect(output).toContain('Deep reasoning · Used filemgr-rea… in 1 tool call');

        now.mockReturnValue(30_000);
        taskView.invalidate();
        output = stripAnsi(taskView.render(100).join('\n'));
        expect(output).toContain('Deep reasoning · Used filemgr-rea… in 2 tool calls');
        expect(output).toContain('Deep reasoning · Used filemgr-rea… in 1 tool call');
    });

    test('minimal completion uses a divider without repeating tool metadata', async () => {
        const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.setOutputDisplayLevel('minimal');
        taskView.startStreaming();
        const parts = [
            new ReasoningMessagePart('private reasoning', 'reasoning_content'),
            createToolPart(1, 'src/one.ts'),
            new TextMessagePart('Final output')
        ];
        for (let index = 0; index < parts.length; index += 1) {
            await taskView.handleChunkUpdate({
                type: 'assistant',
                task_id: 'task_1',
                task_status: 'running',
                message_id: 'message_1',
                last_part_index: index,
                last_part: parts[index]
            } as any);
        }
        now.mockReturnValue(2_500);
        taskView.clearStreamThrottle();

        chalk.level = 3;
        const renderedLines = taskView.render(100);
        const rawOutput = renderedLines.join('\n');
        const output = stripAnsi(rawOutput);
        const plainLines = renderedLines.map((line) => stripAnsi(line));
        const dividerLine = plainLines.findIndex((line) => /^─+$/.test(line.trim()));
        const finalBodyLine = plainLines.findIndex((line) => line.includes('Final output'));
        expect(output).not.toContain('✓ 1 tool');
        expect(output).not.toContain('Complete ·');
        expect(output).not.toContain('Deep reasoning · Used filemgr-rea… in 1 tool call');
        expect(dividerLine).toBeGreaterThanOrEqual(0);
        expect(finalBodyLine - dividerLine).toBe(2);
        expect(rawOutput).toContain(chalk.dim('─'.repeat(100)));
        expect(output).not.toContain('CUSTOM TOOL 1');
    });

    test('minimal completion with one body omits the phase summary and body count', async () => {
        const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.setOutputDisplayLevel('minimal');
        taskView.startStreaming();

        now.mockReturnValue(3_000);
        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 0,
            last_part: new TextMessagePart('Initial body')
        });
        now.mockReturnValue(5_000);
        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 1,
            last_part: createToolPart(1, 'src/one.ts')
        });
        now.mockReturnValue(8_000);
        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 2,
            last_part: new TextMessagePart('Final output')
        });
        now.mockReturnValue(10_000);
        taskView.clearStreamThrottle();

        let output = stripAnsi(taskView.render(100).join('\n'));
        expect(output).not.toContain('✓ 1 tool');
        expect(output).not.toContain('Complete ·');
        expect(output.split('\n').some((line) => /^─+$/.test(line.trim()))).toBe(true);
        expect(output).not.toContain('body segment');

        now.mockReturnValue(20_000);
        taskView.invalidate();
        output = stripAnsi(taskView.render(100).join('\n'));
        expect(output).not.toContain('✓ 1 tool');
        expect(output).not.toContain('Complete ·');
        expect(output.split('\n').some((line) => /^─+$/.test(line.trim()))).toBe(true);
        expect(output).not.toContain('body segment');
    });

    test('minimal completion preserves phase summaries when there are multiple bodies', async () => {
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.setOutputDisplayLevel('minimal');
        taskView.startStreaming();
        const parts = [
            createToolPart(1, 'src/one.ts'),
            new TextMessagePart('First body'),
            createToolPart(2, 'src/two.ts'),
            new TextMessagePart('Second body'),
            createToolPart(3, 'src/three.ts'),
            new TextMessagePart('Final output')
        ];
        for (let index = 0; index < parts.length; index += 1) {
            await taskView.handleChunkUpdate({
                type: 'assistant',
                task_id: 'task_1',
                task_status: 'running',
                message_id: 'message_1',
                last_part_index: index,
                last_part: parts[index]
            } as any);
        }
        taskView.clearStreamThrottle();

        const output = stripAnsi(taskView.render(100).join('\n'));
        expect(output.match(/✓ Used filemgr-rea… in 1 tool call/g)).toHaveLength(3);
        expect(output).not.toContain('Complete ·');
        expect(output.split('\n').some((line) => /^─+$/.test(line.trim()))).toBe(true);
        expect(output).not.toContain('body segment');
    });

    test('verbose mode preserves structured part order and uses existing tool and reason renderers', async () => {
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.setOutputDisplayLevel('verbose');
        const reasoning = Array.from({ length: 12 }, (_, index) => `reason-${index + 1}`).join('\n');
        const parts = [
            new ReasoningMessagePart(reasoning, 'reasoning_content'),
            createToolPart(1, 'src/one.ts'),
            new TextMessagePart('Assistant body'),
            createToolPart(2, 'src/two.ts'),
            new TextMessagePart('Final output')
        ];
        for (let index = 0; index < parts.length; index += 1) {
            await taskView.handleChunkUpdate({
                type: 'assistant',
                task_id: 'task_1',
                task_status: 'running',
                message_id: 'message_1',
                last_part_index: index,
                last_part: parts[index]
            } as any);
        }
        taskView.clearStreamThrottle();

        let output = stripAnsi(taskView.render(100).join('\n'));
        expect(output).not.toContain('reason-1\n');
        expect(output).toContain('reason-12');
        expect(output.indexOf('CUSTOM TOOL 1')).toBeLessThan(output.indexOf('Assistant body'));
        expect(output.indexOf('Assistant body')).toBeLessThan(output.indexOf('CUSTOM TOOL 2'));
        expect(output.indexOf('CUSTOM TOOL 2')).toBeLessThan(output.indexOf('Final output'));

        Setting.updateInstanceData({
            cli_config: {
                output_display: 'verbose',
                show_all_reasoning: true
            }
        });
        taskView.invalidate();
        output = stripAnsi(taskView.render(100).join('\n'));
        expect(output).toContain('reason-1');
        expect(output).toContain('reason-12');
    });

    test('legacy reason display full renders the complete reasoning card', () => {
        Setting.updateInstanceData({
            cli_config: {
                output_display: 'verbose',
                show_all_reasoning: false,
                reason_display: 'full'
            }
        });
        const view = new ReasoningMessagePartView();
        view.setContent(Array.from({ length: 12 }, (_, index) => `legacy-reason-${index + 1}`).join('\n'));
        view.setStreaming(false);

        const output = stripAnsi(view.render(100).join('\n'));
        expect(output).toContain('legacy-reason-1');
        expect(output).toContain('legacy-reason-12');
        expect(output).not.toContain('reasoning.partial.hint');
    });

    test('temporary verbose output lets legacy reason display full expand the current task', async () => {
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.startStreaming();
        taskView.setOutputDisplayLevel('verbose');
        Setting.updateInstanceData({
            cli_config: {
                output_display: 'minimal',
                show_all_reasoning: false,
                reason_display: 'full'
            }
        });

        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 0,
            last_part: new ReasoningMessagePart(
                Array.from({ length: 12 }, (_, index) => `temporary-reason-${index + 1}`).join('\n'),
                'reasoning_content'
            )
        });
        taskView.clearStreamThrottle();

        let output = stripAnsi(taskView.render(100).join('\n'));
        expect(output).toContain('temporary-reason-1');
        expect(output).toContain('temporary-reason-12');

        taskView.setOutputDisplayLevel('minimal');
        output = stripAnsi(taskView.render(100).join('\n'));
        expect(output).not.toContain('temporary-reason-1');
        expect(output).not.toContain('temporary-reason-12');
    });

    test('retry progress uses the same card in minimal and verbose modes', async () => {
        const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        const renderAtLevel = (level: 'minimal' | 'verbose', width = 100) => {
            taskView.setOutputDisplayLevel(level);
            return stripAnsi(taskView.render(width).join('\n'));
        };
        const scheduledRetry = {
            type: 'retry',
            task_id: 'task_1',
            task_status: 'running',
            attempt: 2,
            delay_ms: 10_000,
            next_retry_at: 11_000,
            error_message: 'temporary failure',
            status: 'scheduled'
        } as const;
        await taskView.handleChunkUpdate(scheduledRetry);

        let minimalOutput = renderAtLevel('minimal');
        let verboseOutput = renderAtLevel('verbose');
        expect(minimalOutput).toBe(verboseOutput);
        expect(minimalOutput).toContain('LLM Request Auto Retry');
        expect(minimalOutput).toContain('Retried 2 time(s)');
        expect(minimalOutput).toContain('(in 10s)');
        expect(minimalOutput).toContain('/retry');
        expect(minimalOutput).toContain('Last error: temporary failure');

        now.mockReturnValue(4_000);
        await taskView.handleChunkUpdate({
            ...scheduledRetry,
            error_message: 'temporary failure with a message that is too long for a narrow terminal'
        });
        minimalOutput = renderAtLevel('minimal', 24);
        verboseOutput = renderAtLevel('verbose', 24);
        expect(minimalOutput).toBe(verboseOutput);
        expect(minimalOutput).toContain('/retry');
        expect(minimalOutput.split('\n').every((line) => line.length <= 24)).toBe(true);

        await taskView.handleChunkUpdate({
            ...scheduledRetry,
            status: 'retrying'
        });
        minimalOutput = renderAtLevel('minimal');
        verboseOutput = renderAtLevel('verbose');
        expect(minimalOutput).toBe(verboseOutput);
        expect(minimalOutput).toContain('Starting retry attempt 2');
        expect(minimalOutput).not.toContain('/retry');

        await taskView.handleChunkUpdate({
            type: 'retry',
            task_id: 'task_1',
            task_status: 'running',
            attempt: 2,
            delay_ms: 10_000,
            next_retry_at: 11_000,
            error_message: 'temporary failure',
            status: 'cleared'
        });
        expect(renderAtLevel('minimal')).not.toContain('LLM Request Auto Retry');
        expect(renderAtLevel('verbose')).not.toContain('LLM Request Auto Retry');
    });
});
