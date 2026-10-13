import fs from 'fs';
import os from 'os';
import path from 'path';
import { AutoCompactStates } from '../../../main/aikernel/compaction/auto-compact.js';
import { ContextPreparationBlockedError } from '../../../main/aikernel/compaction/compact-error.js';
import { jest } from '@jest/globals';
import { LLM } from '../../../main/aikernel/llm';
import { AssistantMessage, ChatContext, Usage, UserMessage } from '../../../main/aikernel/messages';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks';
import { writeTaskSessionMemory } from '../../../main/aikernel/compaction/session-memory-compact';
import { ModelInstance, Setting, setCustomOpendeskDirectory } from '../../../main/utils/setting';

const managers: TaskManagerState[] = [];

function createManager(): TaskManagerState {
    const manager = new TaskManagerState();
    managers.push(manager);
    return manager;
}

let tempRootDir: string | undefined;

function createTempAppDirectory(): string {
    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-file-read-state-compact-'));
    setCustomOpendeskDirectory(tempRootDir);
    fs.mkdirSync(path.join(tempRootDir, 'tasks'), { recursive: true });
    return tempRootDir;
}

function cleanupTempAppDirectory(): void {
    if (tempRootDir && fs.existsSync(tempRootDir)) {
        fs.rmSync(tempRootDir, { recursive: true, force: true });
    }
    tempRootDir = undefined;
    setCustomOpendeskDirectory(undefined);
}

function createTask(): TaskState {
    const task = new TaskState(createManager(), null);
    task.model = 'compact-test-model';
    return task;
}

function appendAssistantMessage(chatContext: ChatContext, text: string): void {
    const message = new AssistantMessage();
    message.appendText(text);
    chatContext.appendMessage(message);
}

function createCompactableChatContext(): ChatContext {
    const chatContext = new ChatContext();
    for (let index = 1; index <= 5; index++) {
        chatContext.appendMessage(new UserMessage(('user ' + index).repeat(5000)));
        appendAssistantMessage(chatContext, ('assistant ' + index).repeat(3000));
    }
    return chatContext;
}

function createSessionMemoryCompactableChatContext(): ChatContext {
    const chatContext = new ChatContext();
    const longText = Array.from({ length: 1200 }, (_, index) => 'context-token-' + index).join(' ');

    for (let index = 1; index <= 6; index++) {
        chatContext.appendMessage(new UserMessage('user ' + index + ' ' + longText));
        appendAssistantMessage(chatContext, 'assistant ' + index + ' ' + longText);
    }

    return chatContext;
}

function seedReadState(task: TaskState): void {
    task.getFileReadState().set('C:/repo/read.txt', {
        content: '     1\tread content',
        timestamp: 123,
        offset: 1,
        isPartialView: false
    });
}

function validSessionMemory(): string {
    return [
        '# Session Title',
        '_A short and distinctive 5-10 word descriptive title for the session._',
        'OpenDesk session memory compact',
        '',
        '# Current State',
        '_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._',
        'File read state is being invalidated after context compaction.',
        '',
        '# Task Specification',
        '_What did the user ask to build? Any constraints or design decisions?_',
        'Clear file read state after session memory compact or full compact.',
        '',
        '# Files and Functions',
        '_Important files, functions, and why they matter._',
        'src/main/aikernel/states/tasks.ts owns task-local file read state.',
        '',
        '# Open Questions',
        '_Ambiguities, decisions needed, or assumptions._',
        'None.',
        '',
        '# Recent Changes',
        '_Important recent implementation or discussion details._',
        'Added conservative invalidation after compaction.'
    ].join('\n');
}

function mockSmallContextWindow(): void {
    const model = new ModelInstance(
        'anthropic/claude-4-sonnet',
        'https://example.com',
        'test-key',
        false,
        false,
        '',
        59000
    );

    model.max_output_tokens = 2048;
    jest.spyOn(Setting, 'getInstance').mockReturnValue({
        data: { locale: 'en-US' },
        getData: () => ({
            default_model: 'compact-test-model',
            models: [
                {
                    alias: 'compact-test-model',
                    provider_name: 'mock-provider',
                    model_name: 'anthropic/claude-4-sonnet'
                }
            ]
        }),
        getModelInstance: () => model,
        getDefaultModelInstance: () => model
    } as unknown as Setting);
}

describe('file read state invalidation after context compaction', () => {
    beforeEach(() => mockSmallContextWindow());
    afterEach(async () => {
        for (const manager of managers) {
            await manager.flushAllPendingSaves();
        }
        managers.length = 0;
        jest.restoreAllMocks();
        cleanupTempAppDirectory();
    });

    test('manual full compact clears task-local file read state', async () => {
        createTempAppDirectory();
        const task = createTask();
        task.chat_context = createCompactableChatContext();
        seedReadState(task);
        jest.spyOn(LLM, 'askWithMetadata').mockResolvedValue({
            text: 'full compact summary',
            reasoningLength: 0,
            finishReason: 'stop'
        });

        const compacted = await task.manualCompact();

        expect(compacted).toBe(true);
        expect(task.getFileReadState().size).toBe(0);
    });

    test('task compact uses a one-shot model override and persists the compact boundary', async () => {
        createTempAppDirectory();
        const taskManager = createManager();
        const saveSpy = jest.spyOn(taskManager, 'save').mockImplementation(() => undefined);
        const task = new TaskState(taskManager, null);
        task.model = 'conversation-model';
        task.chat_context = createCompactableChatContext();
        task._dirty = false;
        const askSpy = jest
            .spyOn(LLM, 'askWithMetadata')
            .mockResolvedValue({ text: 'full compact summary', reasoningLength: 0, finishReason: 'stop' });

        const result = await task.compactTaskContext({ model: 'summary-model' });

        expect(result).toEqual(
            expect.objectContaining({
                compacted: true,
                summary: 'full compact summary'
            })
        );
        expect(result.boundary?.summary).toBe('full compact summary');
        expect(askSpy).toHaveBeenCalledWith(expect.any(UserMessage), 'summary-model', expect.any(Object));
        expect(task.model).toBe('conversation-model');
        expect(task._dirty).toBe(true);
        expect(saveSpy).toHaveBeenCalled();
    });

    test('concurrent task compaction requests share the in-flight compact operation', async () => {
        createTempAppDirectory();
        const task = createTask();
        task.chat_context = createCompactableChatContext();
        let resolveSummary: ((summary: string) => void) | undefined;
        const summaryPromise = new Promise<string>((resolve) => {
            resolveSummary = resolve;
        });
        const askSpy = jest
            .spyOn(LLM, 'askWithMetadata')
            .mockReturnValue(summaryPromise.then((text) => ({ text, reasoningLength: 0, finishReason: 'stop' })));

        const first = task.compactTaskContext({ model: 'summary-model' });
        const second = task.compactTaskContext({ model: 'summary-model' });
        resolveSummary?.('shared compact summary');
        const [firstResult, secondResult] = await Promise.all([first, second]);

        expect(askSpy).toHaveBeenCalledTimes(1);
        expect(firstResult).toBe(secondResult);
        expect(firstResult.summary).toBe('shared compact summary');
    });

    test('manual compact keeps a short context as a no-op', async () => {
        createTempAppDirectory();
        const task = createTask();
        task.chat_context.appendMessage(new UserMessage('single message'));
        seedReadState(task);
        const askSpy = jest
            .spyOn(LLM, 'askWithMetadata')
            .mockResolvedValue({ text: 'unused summary', reasoningLength: 0, finishReason: 'stop' });

        const compacted = await task.manualCompact();

        expect(compacted).toBe(false);
        expect(askSpy).not.toHaveBeenCalled();
        expect(task.chat_context.findCompactBoundary()).toBeUndefined();
        expect(task.getFileReadState().get('C:/repo/read.txt')).toBeDefined();
    });

    test('non-forced compact keeps the automatic short-context no-op behavior', async () => {
        createTempAppDirectory();
        const task = createTask();
        task.chat_context.appendMessage(new UserMessage('single message'));
        seedReadState(task);
        const askSpy = jest
            .spyOn(LLM, 'askWithMetadata')
            .mockResolvedValue({ text: 'unused summary', reasoningLength: 0, finishReason: 'stop' });

        const result = await task.compactTaskContext();

        expect(result.compacted).toBe(false);
        expect(askSpy).not.toHaveBeenCalled();
        expect(task.getFileReadState().get('C:/repo/read.txt')).toBeDefined();
    });

    test('usage recovery without a safe checkpoint uses an estimated summary and clears file read state', async () => {
        createTempAppDirectory();
        mockSmallContextWindow();
        const task = createTask();
        task.chat_context = createSessionMemoryCompactableChatContext();
        const lastMessage = task.chat_context.lastMessage();
        if (lastMessage instanceof AssistantMessage) {
            lastMessage.usage = new Usage(50000, 0, 50000);
        }
        seedReadState(task);
        await writeTaskSessionMemory(task.task_id, validSessionMemory());
        const askSpy = jest
            .spyOn(LLM, 'askWithMetadata')
            .mockResolvedValue({ text: 'estimated fallback summary', reasoningLength: 0, finishReason: 'stop' });
        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* () {} as any);

        await task.processCompletion();

        expect(task.getFileReadState().size).toBe(0);
        expect(task.chat_context.findCompactBoundary()?.message.summary).toBe('estimated fallback summary');
        expect(askSpy).toHaveBeenCalledTimes(1);
    });
});

describe('task compaction recovery regression', () => {
    beforeEach(() => {
        createTempAppDirectory();
        mockSmallContextWindow();
    });
    afterEach(() => {
        jest.restoreAllMocks();
        cleanupTempAppDirectory();
    });

    test('empty summaries pause before the main model, persist failures and open after three attempts', async () => {
        const task = createTask();
        task.chat_context = createCompactableChatContext();
        const last = task.chat_context.lastMessage() as AssistantMessage;
        last.usage = new Usage(50000, 0, 50000);
        (task.chat_context.messages[7] as AssistantMessage).usage = new Usage(40000, 0, 40000);
        const ask = jest.spyOn(LLM, 'askWithMetadata').mockResolvedValue({ text: '', reasoningLength: 20 });
        const stream = jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* () {});
        jest.spyOn(task, 'sendSubscriptionFeedback').mockResolvedValue(undefined);
        const save = jest.spyOn(task, 'persistLater').mockImplementation(() => undefined);
        const ids = task.chat_context.messages.map((message) => message.message_id);
        task.task_status = 'running';
        await task.processCompletion();
        expect(ask).toHaveBeenCalledTimes(2);
        expect(stream).not.toHaveBeenCalled();
        expect(task.task_status).toBe('stopped');
        expect(task.auto_compact_state.consecutiveFailures).toBe(2);
        expect(save).toHaveBeenCalled();
        expect(task.chat_context.messages.map((message) => message.message_id)).toEqual(ids);
        await expect(task.compactTaskContext()).rejects.toMatchObject({ code: 'reasoning_only' });
        expect(ask).toHaveBeenCalledTimes(3);
        expect(task.auto_compact_state.status).toBe('circuit_open');
        const restored = AutoCompactStates.deserialize(AutoCompactStates.serialize(task.auto_compact_state));
        expect(restored.status).toBe('circuit_open');
        await expect(task.compactTaskContext({ trigger: 'auto' })).rejects.toThrow('circuit_open');
        expect(ask).toHaveBeenCalledTimes(3);
        await expect(task.compactTaskContext()).rejects.toMatchObject({ code: 'reasoning_only' });
        expect(ask).toHaveBeenCalledTimes(4);
        expect(task.auto_compact_state.status).toBe('circuit_open');
        ask.mockResolvedValue({ text: 'valid recovery summary', reasoningLength: 0, finishReason: 'stop' });
        await expect(task.compactTaskContext()).resolves.toMatchObject({ compacted: true });
        expect(task.auto_compact_state.status).toBe('healthy');
        expect(task.auto_compact_state.consecutiveFailures).toBe(0);
    });

    test('manual and auto share one in-flight operation and apply one boundary', async () => {
        const task = createTask();
        const publish = jest.spyOn(task, 'publishTaskUpdate');
        task.chat_context = createCompactableChatContext();
        let resolve!: (value: { text: string; reasoningLength: number }) => void;
        const pending = new Promise<{ text: string; reasoningLength: number }>((done) => {
            resolve = done;
        });
        const ask = jest.spyOn(LLM, 'askWithMetadata').mockReturnValue(pending);
        const manual = task.compactTaskContext();
        const automatic = task.compactTaskContext({ trigger: 'auto' });
        resolve({ text: 'one summary', reasoningLength: 0 });
        const results = await Promise.all([manual, automatic]);
        expect(ask).toHaveBeenCalledTimes(1);
        expect(results[0]).toBe(results[1]);
        expect(task.chat_context.messages.filter((message) => message.role === 'compact_separator')).toHaveLength(1);
        const updates = publish.mock.calls.map(([update]) => update).filter((update) => update.type === 'compact');
        expect(updates.map((update) => update.phase)).toEqual(['start', 'end']);
        expect(updates[1]).toMatchObject({ compacted: true, trigger: 'manual' });
        expect(task.compactProgress).toBeUndefined();
    });

    test('truncation preserves the last good boundary and does not retry', async () => {
        const task = createTask();
        const publish = jest.spyOn(task, 'publishTaskUpdate');
        task.chat_context = createCompactableChatContext();
        const ask = jest.spyOn(LLM, 'askWithMetadata').mockResolvedValue({ text: 'good summary', reasoningLength: 0 });
        await task.compactTaskContext();
        const boundary = task.chat_context.findCompactBoundary()?.message;
        expect(publish).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'compact', phase: 'end', compacted: true }),
            'context compaction'
        );
        for (let i = 0; i < 5; i++) {
            task.chat_context.appendMessage(new UserMessage('more work '.repeat(4000)));
            appendAssistantMessage(task.chat_context, 'tool work completed');
        }
        ask.mockResolvedValue({ text: 'cut off summary', reasoningLength: 0, finishReason: 'length' });
        await expect(task.compactTaskContext()).rejects.toMatchObject({ code: 'output_truncated' });
        expect(ask).toHaveBeenCalledTimes(2);
        expect(task.chat_context.findCompactBoundary()?.message).toBe(boundary);
        expect(task.compactProgress).toBeUndefined();
        expect(publish).toHaveBeenLastCalledWith(
            expect.objectContaining({ type: 'compact', phase: 'end', compacted: false }),
            'context compaction'
        );
    });

    test('a final adapter budget failure ends the turn instead of entering model retry', async () => {
        const task = createTask();
        task.chat_context = new ChatContext();
        task.chat_context.appendMessage(new UserMessage('small request'));
        task.chat_context.appendMessage(new AssistantMessage());
        task.task_status = 'running';
        jest.spyOn(task, 'sendSubscriptionFeedback').mockResolvedValue(undefined);
        const stream = jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* () {
            yield await Promise.reject(new ContextPreparationBlockedError('context_limit'));
        });
        await task.processCompletion();
        expect(stream).toHaveBeenCalledTimes(1);
        expect(task.task_status).toBe('stopped');
        expect(task._retryDelayPending).toBe(false);
    });

    test('nonempty but oversized summary does not replace history or clear failure state', async () => {
        const task = createTask();
        task.chat_context = createCompactableChatContext();
        task.setAutoCompactState(
            AutoCompactStates.recordFailure(AutoCompactStates.recordFailure(AutoCompactStates.create()))
        );
        const original = task.chat_context.messages.slice();
        jest.spyOn(LLM, 'askWithMetadata').mockResolvedValue({
            text: 'x'.repeat(240000),
            reasoningLength: 0,
            finishReason: 'stop'
        });
        await expect(task.compactTaskContext()).rejects.toMatchObject({ code: 'no_progress' });
        expect(task.chat_context.messages).toEqual(original);
        expect(task.auto_compact_state.consecutiveFailures).toBe(2);
        expect(task.auto_compact_state.status).toBe('degraded');
    });

    test('a stale summary cannot overwrite changes made while it was pending', async () => {
        const task = createTask();
        task.chat_context = createCompactableChatContext();
        jest.spyOn(LLM, 'askWithMetadata').mockImplementation(async () => {
            task.chat_context.appendMessage(new UserMessage('new context while summarizing'));
            return { text: 'outdated summary', reasoningLength: 0 };
        });
        await expect(task.compactTaskContext()).rejects.toMatchObject({ code: 'cancelled' });
        expect(task.chat_context.findCompactBoundary()).toBeUndefined();
        expect(task.auto_compact_state.consecutiveFailures).toBe(0);
        expect(task.chat_context.messages).toHaveLength(11);
    });
});
