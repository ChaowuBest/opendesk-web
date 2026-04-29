import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import {
    DEFAULT_SESSION_MEMORY_TEMPLATE,
    SessionMemoryStates,
    buildSessionMemoryUpdatePrompt,
    countToolCallsSinceMessage,
    ensureTaskSessionMemoryFile,
    estimateChatContextTokensForSessionMemory,
    getTaskSessionMemoryRelativePath,
    hasRunningOrPendingToolCallInLastAssistant,
    readTaskSessionMemory,
    serializeActiveContextForSessionMemory,
    shouldExtractSessionMemory,
    updateSessionMemoryFromChatContext,
    validateSessionMemoryMarkdown,
    writeTaskSessionMemory
} from '../../../main/aikernel/compaction/session-memory-compact';
import { buildActiveContextView } from '../../../main/aikernel/compaction/context-view';
import { getTaskSessionMemoryPath, setCustomAppDirectory } from '../../../main/utils/setting';
import {
    AssistantMessage,
    ChatContext,
    ToolCall,
    ToolCallMessagePart,
    Usage,
    UserMessage
} from '../../../main/aikernel/messages';

let tempRootDir: string | undefined;

function createTempAppDirectory(): string {
    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-session-memory-'));
    setCustomAppDirectory(tempRootDir);
    return tempRootDir;
}

function cleanupTempAppDirectory(): void {
    if (tempRootDir && fs.existsSync(tempRootDir)) {
        fs.rmSync(tempRootDir, { recursive: true, force: true });
    }
    tempRootDir = undefined;
}

function createChatContext(): ChatContext {
    return new ChatContext();
}

function assistantWithText(text: string, promptTokens?: number): AssistantMessage {
    const message = new AssistantMessage();
    message.appendText(text);
    if (promptTokens !== undefined) {
        message.usage = new Usage(promptTokens, 10, promptTokens + 10);
    }
    return message;
}

function assistantWithToolCall(
    status: 'pending' | 'running' | 'success' | 'error' = 'success',
    promptTokens?: number
): AssistantMessage {
    const message = new AssistantMessage();
    const part = new ToolCallMessagePart();
    const toolCall = new ToolCall(0, `tool-${crypto.randomUUID()}`, 'demo_tool', '{"query":"demo"}');
    toolCall.status = status;
    toolCall.result = status === 'success' ? 'tool result' : undefined;
    part.push(toolCall);
    message.appendToolCallPart(part);
    if (promptTokens !== undefined) {
        message.usage = new Usage(promptTokens, 10, promptTokens + 10);
    }
    return message;
}

function validSessionMemory(content = 'Updated current state.'): string {
    return `# Session Title
_A short and distinctive 5-10 word descriptive title for the session._
OpenDesk compact session memory

# Current State
_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._
${content}

# Task Specification
_What did the user ask to build? Any constraints or design decisions?_
Port Step 8A-8C only.

# Files and Functions
_Important files, functions, and why they matter._
src/main/aikernel/compaction/session-memory.ts

# Workflow
_Commands usually run and how to interpret them._
npm test -- --runTestsByPath src/tests/ut/compact/session-memory.test.ts

# Errors & Corrections
_Errors encountered, corrections, and approaches to avoid._
None.

# Key Results
_Exact results or important outputs._
Session memory updated.

# Worklog
_Terse chronological worklog._
- Added task-local session memory.
`;
}

describe('session memory state and storage', () => {
    afterEach(() => {
        cleanupTempAppDirectory();
    });

    test('state serialize/deserialize 往返稳定，并兼容 snake_case 字段', () => {
        const state = SessionMemoryStates.deserialize({
            version: 1,
            initialized: true,
            relative_path: 'artifacts/task-a/session-memory/session-memory.md',
            last_extracted_at: '2026-04-23T10:00:00+08:00',
            last_summarized_message_id: 'message-1',
            tokens_at_last_extraction: 12345.9,
            extraction_in_progress: true,
            last_error: '  previous failure  '
        });

        expect(state).toEqual({
            version: 1,
            initialized: true,
            relativePath: 'artifacts/task-a/session-memory/session-memory.md',
            lastExtractedAt: '2026-04-23T02:00:00.000Z',
            lastSummarizedMessageId: 'message-1',
            tokensAtLastExtraction: 12345,
            extractionInProgress: true,
            lastError: 'previous failure'
        });
        expect(SessionMemoryStates.deserialize(SessionMemoryStates.serialize(state))).toEqual(state);
    });

    test('memory 文件按 UTF-8 创建、读取和原子写入', () => {
        createTempAppDirectory();
        const taskId = 'task-memory';

        const file = ensureTaskSessionMemoryFile(taskId);
        expect(file.relativePath).toBe(getTaskSessionMemoryRelativePath(taskId));
        expect(file.content).toBe(DEFAULT_SESSION_MEMORY_TEMPLATE);
        expect(fs.existsSync(getTaskSessionMemoryPath(taskId))).toBe(true);

        writeTaskSessionMemory(taskId, `${validSessionMemory('包含中文 UTF-8 内容。')}\n`);

        const readBack = readTaskSessionMemory(taskId);
        expect(readBack).toContain('包含中文 UTF-8 内容。');
    });

    test('validateSessionMemoryMarkdown 接受完整 markdown，并拒绝缺少核心标题的输出', () => {
        expect(validateSessionMemoryMarkdown(validSessionMemory()).valid).toBe(true);

        const invalid = validateSessionMemoryMarkdown('# Session Title\nOnly one section');
        expect(invalid.valid).toBe(false);
        expect(invalid.missingHeadings).toContain('# Current State');
    });
});

describe('session memory extraction decision', () => {
    test('优先使用最近 assistant usage.prompt_tokens 估算上下文大小', () => {
        const chatContext = createChatContext();
        chatContext.appendMessage(new UserMessage('hello'));
        chatContext.appendMessage(assistantWithText('short answer', 1234));

        expect(estimateChatContextTokensForSessionMemory(chatContext)).toBe(1234);
    });

    test('未达到初始化阈值时不抽取，达到后允许第一次抽取', () => {
        const chatContext = createChatContext();
        chatContext.appendMessage(new UserMessage('start'));
        chatContext.appendMessage(assistantWithText('ready', 100));

        const below = shouldExtractSessionMemory(chatContext, SessionMemoryStates.create(), {
            minimumMessageTokensToInit: 200
        });
        expect(below.shouldExtract).toBe(false);
        expect(below.reason).toBe('below_initialization_threshold');

        const reached = shouldExtractSessionMemory(chatContext, SessionMemoryStates.create(), {
            minimumMessageTokensToInit: 100
        });
        expect(reached.shouldExtract).toBe(true);
        expect(reached.reason).toBe('initialization_threshold_met');
    });

    test('增量不足时不重复抽取', () => {
        const chatContext = createChatContext();
        chatContext.appendMessage(new UserMessage('start'));
        chatContext.appendMessage(assistantWithText('ready', 1200));
        const state = SessionMemoryStates.deserialize({
            initialized: true,
            tokens_at_last_extraction: 1000
        });

        const decision = shouldExtractSessionMemory(chatContext, state, {
            minimumTokensBetweenUpdate: 500
        });

        expect(decision.shouldExtract).toBe(false);
        expect(decision.reason).toBe('below_update_threshold');
        expect(decision.tokensSinceLastExtraction).toBe(200);
    });

    test('最近 assistant 有 pending/running tool call 时不抽取', () => {
        const chatContext = createChatContext();
        chatContext.appendMessage(new UserMessage('start'));
        chatContext.appendMessage(assistantWithToolCall('pending', 2000));

        expect(hasRunningOrPendingToolCallInLastAssistant(chatContext)).toBe(true);

        const decision = shouldExtractSessionMemory(chatContext, SessionMemoryStates.create(), {
            minimumMessageTokensToInit: 100
        });

        expect(decision.shouldExtract).toBe(false);
        expect(decision.reason).toBe('unsafe_last_assistant_tool_call');
    });

    test('工具调用数达到阈值或自然断点满足时抽取', () => {
        const toolContext = createChatContext();
        const firstUser = new UserMessage('start');
        toolContext.appendMessage(firstUser);
        toolContext.appendMessage(assistantWithToolCall('success', 2000));
        toolContext.appendMessage(assistantWithToolCall('success'));
        const state = SessionMemoryStates.deserialize({
            initialized: true,
            last_summarized_message_id: firstUser.message_id,
            tokens_at_last_extraction: 100
        });

        expect(countToolCallsSinceMessage(toolContext, firstUser.message_id)).toBe(2);
        const toolDecision = shouldExtractSessionMemory(toolContext, state, {
            minimumTokensBetweenUpdate: 100,
            toolCallsBetweenUpdates: 2
        });
        expect(toolDecision.shouldExtract).toBe(true);
        expect(toolDecision.reason).toBe('tool_call_threshold_met');

        const naturalBreakContext = createChatContext();
        naturalBreakContext.appendMessage(new UserMessage('start'));
        naturalBreakContext.appendMessage(assistantWithText('no tool calls here', 2000));
        const naturalDecision = shouldExtractSessionMemory(naturalBreakContext, state, {
            minimumTokensBetweenUpdate: 100,
            toolCallsBetweenUpdates: 3
        });
        expect(naturalDecision.shouldExtract).toBe(true);
        expect(naturalDecision.reason).toBe('natural_break');
    });
});

describe('session memory prompt and update loop', () => {
    afterEach(() => {
        cleanupTempAppDirectory();
    });

    test('prompt 构造会包含 active context，但排除 reasoning 原文', () => {
        const chatContext = createChatContext();
        const assistant = new AssistantMessage();
        assistant.appendReasoningContent('private chain of thought');
        assistant.appendText('visible implementation details');
        chatContext.appendMessage(new UserMessage('please continue'));
        chatContext.appendMessage(assistant);

        const activeContext = buildActiveContextView(chatContext);
        const transcript = serializeActiveContextForSessionMemory(activeContext);
        expect(transcript).toContain('visible implementation details');
        expect(transcript).toContain('[Reasoning omitted]');
        expect(transcript).not.toContain('private chain of thought');

        const prompt = buildSessionMemoryUpdatePrompt(
            DEFAULT_SESSION_MEMORY_TEMPLATE,
            activeContext,
            SessionMemoryStates.create()
        );
        expect(prompt).toContain('<current_memory>');
        expect(prompt).toContain('<active_context>');
        expect(prompt).not.toContain('private chain of thought');
    });

    test('updateSessionMemoryFromChatContext 可通过 mock generator 更新文件和状态', async () => {
        createTempAppDirectory();
        const chatContext = createChatContext();
        const user = new UserMessage('Port Step 8A to 8C.');
        const assistant = assistantWithText('Implemented session memory storage and update loop.', 12000);
        chatContext.appendMessage(user);
        chatContext.appendMessage(assistant);

        const generateMemory = jest.fn(async ({ prompt }) => {
            expect(prompt).toContain('Port Step 8A to 8C.');
            return validSessionMemory('Mock updated current state.');
        });

        const result = await updateSessionMemoryFromChatContext(
            chatContext,
            'task-update',
            'demo-model',
            SessionMemoryStates.create(),
            {
                minimumMessageTokensToInit: 100,
                now: new Date('2026-04-23T02:00:00.000Z'),
                generateMemory
            }
        );

        expect(result.updated).toBe(true);
        expect(result.state.initialized).toBe(true);
        expect(result.state.relativePath).toBe(getTaskSessionMemoryRelativePath('task-update'));
        expect(result.state.lastExtractedAt).toBe('2026-04-23T02:00:00.000Z');
        expect(result.state.lastSummarizedMessageId).toBe(assistant.message_id);
        expect(result.state.tokensAtLastExtraction).toBe(12000);
        expect(generateMemory).toHaveBeenCalledTimes(1);
        expect(readTaskSessionMemory('task-update')).toContain('Mock updated current state.');
    });

    test('generator 抛错时不覆盖旧 memory 文件，并记录失败状态', async () => {
        createTempAppDirectory();
        const oldMemory = validSessionMemory('Old memory content.');
        writeTaskSessionMemory('task-failure', oldMemory);

        const chatContext = createChatContext();
        chatContext.appendMessage(new UserMessage('continue'));
        chatContext.appendMessage(assistantWithText('new content', 2000));
        const state = SessionMemoryStates.deserialize({
            initialized: true,
            tokens_at_last_extraction: 100
        });

        const result = await updateSessionMemoryFromChatContext(chatContext, 'task-failure', undefined, state, {
            minimumTokensBetweenUpdate: 100,
            generateMemory: async () => {
                throw new Error('mock llm failed');
            }
        });

        expect(result.updated).toBe(false);
        expect(result.skipped).toBe(false);
        expect(result.error).toBe('mock llm failed');
        expect(result.state.extractionInProgress).toBe(false);
        expect(result.state.lastError).toBe('mock llm failed');
        expect(readTaskSessionMemory('task-failure')).toBe(oldMemory);
    });

    test('generator 返回非法 markdown 时不覆盖旧 memory 文件', async () => {
        createTempAppDirectory();
        const oldMemory = validSessionMemory('Old memory content.');
        writeTaskSessionMemory('task-invalid', oldMemory);

        const chatContext = createChatContext();
        chatContext.appendMessage(new UserMessage('continue'));
        chatContext.appendMessage(assistantWithText('new content', 2000));
        const state = SessionMemoryStates.deserialize({
            initialized: true,
            tokens_at_last_extraction: 100
        });

        const result = await updateSessionMemoryFromChatContext(chatContext, 'task-invalid', undefined, state, {
            minimumTokensBetweenUpdate: 100,
            generateMemory: async () => '# Session Title\nIncomplete'
        });

        expect(result.updated).toBe(false);
        expect(result.error).toContain('invalid session memory markdown');
        expect(readTaskSessionMemory('task-invalid')).toBe(oldMemory);
    });
});
