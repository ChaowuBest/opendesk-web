import { jest } from '@jest/globals';
import { ReasoningMessagePartView, TaskView, ToolCallMessagePartView } from '../../../../main/tui/components/taskview';
import {
    AssistantMessage,
    ChatContext,
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

function createNamedToolPart(id: number, toolName: string): ToolCallMessagePart {
    const part = createToolPart(id, `src/${id}.ts`);
    part.toolcalls[0].tool_name = toolName;
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
        expect(output).toContain('Reading `src/main/tui/components/taskview.ts`');
        expect(output.match(/[✣✤✥✦]/g)).toHaveLength(1);
        expect(output).toContain('1 tool');
        expect(output).not.toContain('private reasoning');
        expect(output).not.toContain('CUSTOM TOOL 1');
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

        expect(stripAnsi(taskView.render(100).join('\n'))).toContain('✣ Reading `src/one.ts`');

        now.mockReturnValue(300);
        taskView.requestStreamRender();

        expect(tui.requestRender).toHaveBeenCalledTimes(1);
        expect(stripAnsi(taskView.render(100).join('\n'))).toContain('✤ Reading `src/one.ts`');
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

    test('minimal mode updates elapsed time before the first assistant event', () => {
        const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.setOutputDisplayLevel('minimal');
        taskView.startStreaming();
        now.mockReturnValue(2_500);

        const output = stripAnsi(taskView.render(100).join('\n'));
        expect(output.match(/[✣✤✥✦]/g)).toHaveLength(1);
        expect(output).toContain('1.5s');
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
        const firstSummary = output.indexOf('Deep reasoning · Used Read File and other tools');
        const firstBody = output.indexOf('First body');
        const secondSummary = output.indexOf('Deep reasoning · Used Read File and other tools', firstBody);
        const secondBody = output.indexOf('Second body');
        expect(firstSummary).toBeGreaterThanOrEqual(0);
        expect(firstSummary).toBeLessThan(firstBody);
        expect(firstBody).toBeLessThan(secondSummary);
        expect(secondSummary).toBeLessThan(secondBody);
        expect(output).not.toMatch(/[✣✤✥✦]/);

        const firstSummaryLine = renderedLines.findIndex((line) =>
            line.includes('Deep reasoning · Used Read File and other tools')
        );
        const firstBodyLine = renderedLines.findIndex((line) => line.includes('First body'));
        const secondSummaryLine = renderedLines.findIndex(
            (line, index) => index > firstBodyLine && line.includes('Deep reasoning · Used Read File and other tools')
        );
        const secondBodyLine = renderedLines.findIndex((line) => line.includes('Second body'));
        expect(renderedLines[0].trim()).toBe('');
        expect(renderedLines.at(-1)?.trim()).toBe('');
        expect(firstBodyLine - firstSummaryLine).toBe(2);
        expect(secondSummaryLine - firstBodyLine).toBe(2);
        expect(secondBodyLine - secondSummaryLine).toBe(2);
    });

    test('minimal mode keeps one gap when a body ends with markdown blank lines', async () => {
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
        const statusLine = renderedLines.findIndex((line) => line.includes('1 tool ·'));
        expect(bodyLine).toBeGreaterThanOrEqual(0);
        expect(statusLine - bodyLine).toBe(2);
    });

    test('minimal tool summary shows localized reasoning, readable tool names, and elapsed time', async () => {
        setRuntimeLocale('zh-CN');
        const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.setOutputDisplayLevel('minimal');
        taskView.startStreaming();
        const toolGroup = new ToolCallMessagePart();
        toolGroup.toolcalls.push(...createNamedToolPart(1, 'todomgr-TodoWrite').toolcalls);
        toolGroup.toolcalls.push(...createNamedToolPart(2, 'search-webSearch').toolcalls);
        toolGroup.toolcalls.push(...createNamedToolPart(3, 'filemgr-readFile').toolcalls);
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
        expect(output).toContain('💡 深度思考 · 使用了 更新任务计划、网页搜索 等工具 · 2.0s');
        expect(output).not.toContain('3个工具');
        expect(output).not.toContain('已执行工具');
        expect(rawOutput).toContain(
            `${chalk.greenBright('💡')} ${chalk.dim('深度思考 · 使用了 更新任务计划、网页搜索 等工具 · 2.0s')}`
        );
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
        expect(output).toContain('Deep reasoning · Used Read File and other tools · 6.0s');
        expect(output).toContain('Deep reasoning · Used Read File and other tools · 4.0s');

        now.mockReturnValue(30_000);
        taskView.invalidate();
        output = stripAnsi(taskView.render(100).join('\n'));
        expect(output).toContain('Deep reasoning · Used Read File and other tools · 6.0s');
        expect(output).toContain('Deep reasoning · Used Read File and other tools · 4.0s');
    });

    test('minimal completion suppresses a duplicate tool summary and dims its metadata', async () => {
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
        const rawOutput = taskView.render(100).join('\n');
        const output = stripAnsi(rawOutput);
        expect(output).not.toContain('✓ 1 tool');
        expect(output.indexOf('Complete · Deep reasoning · Used Read File and other tools · 1.5s')).toBeLessThan(
            output.indexOf('Final output')
        );
        expect(rawOutput).toContain(
            `${chalk.greenBright('●')} ${chalk.greenBright('Complete')} ${chalk.dim(
                '· Deep reasoning · Used Read File and other tools · 1.5s'
            )}`
        );
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
        expect(output).toContain('Complete · Used Read File and other tools · 9.0s');
        expect(output).not.toContain('body segment');

        now.mockReturnValue(20_000);
        taskView.invalidate();
        output = stripAnsi(taskView.render(100).join('\n'));
        expect(output).not.toContain('✓ 1 tool');
        expect(output).toContain('Complete · Used Read File and other tools · 9.0s');
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
        expect(output.match(/✓ Used Read File and other tools ·/g)).toHaveLength(3);
        expect(output).toContain('Complete · Used Read File and other tools ·');
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

    test('retry progress is hidden in minimal mode and restored in verbose mode', async () => {
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        await taskView.handleChunkUpdate({
            type: 'retry',
            task_id: 'task_1',
            task_status: 'running',
            attempt: 2,
            delay_ms: 1_000,
            next_retry_at: Date.now() + 1_000,
            error_message: 'temporary failure',
            status: 'scheduled'
        });

        taskView.setOutputDisplayLevel('minimal');
        expect(stripAnsi(taskView.render(100).join('\n'))).not.toContain('Retry');

        taskView.setOutputDisplayLevel('verbose');
        expect(stripAnsi(taskView.render(100).join('\n'))).toContain('Retry');
    });
});
