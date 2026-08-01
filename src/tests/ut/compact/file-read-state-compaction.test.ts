import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import { LLM } from '../../../main/aikernel/llm';
import { AssistantMessage, ChatContext, Usage, UserMessage } from '../../../main/aikernel/messages';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks';
import { writeTaskSessionMemory } from '../../../main/aikernel/compaction/session-memory-compact';
import { ModelInstance, Setting, setCustomOpendeskDirectory } from '../../../main/utils/setting';

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
}

function createTask(): TaskState {
    const task = new TaskState(new TaskManagerState(), null);
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
        chatContext.appendMessage(new UserMessage('user ' + index));
        appendAssistantMessage(chatContext, 'assistant ' + index);
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

    jest.spyOn(Setting, 'getInstance').mockReturnValue({
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
    afterEach(() => {
        jest.restoreAllMocks();
        cleanupTempAppDirectory();
    });

    test('manual full compact clears task-local file read state', async () => {
        createTempAppDirectory();
        const task = createTask();
        task.chat_context = createCompactableChatContext();
        seedReadState(task);
        jest.spyOn(LLM, 'ask').mockResolvedValue('full compact summary');

        const compacted = await task.manualCompact();

        expect(compacted).toBe(true);
        expect(task.getFileReadState().size).toBe(0);
    });

    test('task compact uses a one-shot model override and persists the compact boundary', async () => {
        createTempAppDirectory();
        const taskManager = new TaskManagerState();
        const saveSpy = jest.spyOn(taskManager, 'save').mockImplementation(() => undefined);
        const task = new TaskState(taskManager, null);
        task.model = 'conversation-model';
        task.chat_context = createCompactableChatContext();
        task._dirty = false;
        const askSpy = jest.spyOn(LLM, 'ask').mockResolvedValue('full compact summary');

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
        const askSpy = jest.spyOn(LLM, 'ask').mockReturnValue(summaryPromise);

        const first = task.compactTaskContext({ model: 'summary-model' });
        const second = task.compactTaskContext({ model: 'other-model' });
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
        const askSpy = jest.spyOn(LLM, 'ask').mockResolvedValue('unused summary');

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
        const askSpy = jest.spyOn(LLM, 'ask').mockResolvedValue('unused summary');

        const result = await task.compactTaskContext();

        expect(result.compacted).toBe(false);
        expect(askSpy).not.toHaveBeenCalled();
        expect(task.getFileReadState().get('C:/repo/read.txt')).toBeDefined();
    });

    test('session memory compact before model completion clears task-local file read state', async () => {
        createTempAppDirectory();
        mockSmallContextWindow();
        const task = createTask();
        task.chat_context = createSessionMemoryCompactableChatContext();
        const lastMessage = task.chat_context.lastMessage();
        if (lastMessage instanceof AssistantMessage) {
            lastMessage.usage = new Usage(30000, 0, 30000);
        }
        seedReadState(task);
        await writeTaskSessionMemory(task.task_id, validSessionMemory());
        const askSpy = jest.spyOn(LLM, 'ask').mockResolvedValue('full compact should not run');
        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* () {} as any);

        await task.processCompletion();

        expect(task.getFileReadState().size).toBe(0);
        expect(askSpy).not.toHaveBeenCalled();
    });
});
