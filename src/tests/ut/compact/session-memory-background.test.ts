import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import {
    SessionMemoryStates,
    readTaskSessionMemory,
    type SessionMemoryUpdateRequest
} from '../../../main/aikernel/compaction/session-memory-compact';
import { HookRegistry } from '../../../main/aikernel/hooks';
import { AssistantMessage, ChatContext, Usage, UserMessage } from '../../../main/aikernel/messages';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks';
import { setCustomAppDirectory } from '../../../main/utils/setting';

let tempRootDir: string | undefined;

function createTempAppDirectory(): string {
    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-session-memory-background-'));
    setCustomAppDirectory(tempRootDir);
    fs.mkdirSync(path.join(tempRootDir, 'tasks'), { recursive: true });
    return tempRootDir;
}

function cleanupTempAppDirectory(): void {
    if (tempRootDir && fs.existsSync(tempRootDir)) {
        fs.rmSync(tempRootDir, { recursive: true, force: true });
    }
    tempRootDir = undefined;
}

function resetHookRegistry(): void {
    HookRegistry.beforeFinishTurnCallbacks = [];
    HookRegistry.afterFinishTurnCallbacks = [];
    HookRegistry.beforeToolCallCallbacks = [];
    HookRegistry.afterToolCallCallbacks = [];
}

function validSessionMemory(content = 'Background session memory updated.'): string {
    return `# Session Title
_A short and distinctive 5-10 word descriptive title for the session._
OpenDesk background session memory

# Current State
_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._
${content}

# Task Specification
_What did the user ask to build? Any constraints or design decisions?_
Step 8F updates task-local session memory after safe completion points.

# Files and Functions
_Important files, functions, and why they matter._
src/main/aikernel/states/tasks.ts

# Workflow
_Commands usually run and how to interpret them._
npm test -- --runTestsByPath src/tests/ut/compact/session-memory-background.test.ts

# Errors & Corrections
_Errors encountered, corrections, and approaches to avoid._
Do not update while streaming or while tool calls are pending.

# Key Results
_Exact results or important outputs._
The update loop is mockable and persists session_memory_state.

# Worklog
_Terse chronological worklog._
- Added background update scheduling.
`;
}

function createTaskWithConversation(promptTokens: number): {
    manager: TaskManagerState;
    task: TaskState;
    assistant: AssistantMessage;
} {
    const manager = new TaskManagerState();
    const task = new TaskState(manager, null);
    task.task_id = 'task-session-memory-background';
    task.task_name = 'session-memory-background';
    task.model = 'demo-model';
    task.chat_context = new ChatContext();
    task.chat_context.appendMessage(new UserMessage('Continue Step 8F implementation.'));

    const assistant = new AssistantMessage();
    assistant.appendText('Implemented a safe background session memory update path.');
    assistant.usage = new Usage(promptTokens, 10, promptTokens + 10);
    task.chat_context.appendMessage(assistant);

    manager.tasks.push(task);
    return { manager, task, assistant };
}

describe('session memory background update', () => {
    beforeEach(() => {
        resetHookRegistry();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        resetHookRegistry();
        cleanupTempAppDirectory();
    });

    test('低于阈值时不抽取，也不创建 session memory 文件', async () => {
        createTempAppDirectory();
        const { manager, task } = createTaskWithConversation(500);
        const saveSpy = jest.spyOn(manager, 'save');
        const generateMemory = jest.fn(
            async (_request: SessionMemoryUpdateRequest): Promise<string> => validSessionMemory('Should not be called.')
        );

        const result = await task.maybeUpdateSessionMemoryAfterCompletion({
            minimumMessageTokensToInit: 1_000,
            generateMemory
        });

        expect(result.skipped).toBe(true);
        expect(result.updated).toBe(false);
        expect(result.decision.reason).toBe('below_initialization_threshold');
        expect(generateMemory).not.toHaveBeenCalled();
        expect(saveSpy).not.toHaveBeenCalled();
        expect(await readTaskSessionMemory(task.task_id)).toBeUndefined();
        expect(task.getSessionMemoryState()).toEqual(SessionMemoryStates.create());
    });

    test('达到阈值后后台更新会写入文件并持久化状态', async () => {
        createTempAppDirectory();
        const { manager, task, assistant } = createTaskWithConversation(12_000);
        const saveSpy = jest.spyOn(manager, 'save');
        const generateMemory = jest.fn(async (request: SessionMemoryUpdateRequest): Promise<string> => {
            expect(request.prompt).toContain('Continue Step 8F implementation.');
            return validSessionMemory('Mocked background update completed.');
        });

        const result = await task.maybeUpdateSessionMemoryAfterCompletion({
            minimumMessageTokensToInit: 100,
            now: new Date('2026-04-23T02:00:00.000Z'),
            generateMemory
        });

        expect(result.updated).toBe(true);
        expect(result.skipped).toBe(false);
        expect(generateMemory).toHaveBeenCalledTimes(1);
        expect(saveSpy).toHaveBeenCalledTimes(1);
        expect(await readTaskSessionMemory(task.task_id)).toContain('Mocked background update completed.');
        expect(task.getSessionMemoryState()).toMatchObject({
            initialized: true,
            lastExtractedAt: '2026-04-23T02:00:00.000Z',
            lastSummarizedMessageId: assistant.message_id,
            preferredLanguage: 'en-US',
            tokensAtLastExtraction: 12_010,
            extractionInProgress: false
        });
    });

    test('中文任务输入会把 preferredLanguage 持久化成 zh-CN', async () => {
        createTempAppDirectory();
        const manager = new TaskManagerState();
        const task = new TaskState(manager, null);
        task.task_id = 'task-session-memory-background-zh';
        task.task_name = 'session-memory-background-zh';
        task.model = 'demo-model';
        task.chat_context = new ChatContext();
        task.chat_context.appendMessage(new UserMessage('请把 Step 8F 的 session memory 改成中文。'));

        const assistant = new AssistantMessage();
        assistant.appendText('已完成 session memory 更新。');
        assistant.usage = new Usage(12_000, 10, 12_010);
        task.chat_context.appendMessage(assistant);
        manager.tasks.push(task);

        const generateMemory = jest.fn(async ({ preferredLanguage }: SessionMemoryUpdateRequest) => {
            expect(preferredLanguage).toBe('zh-CN');
            return validSessionMemory('已用中文更新 session memory。');
        });

        const result = await task.maybeUpdateSessionMemoryAfterCompletion({
            minimumMessageTokensToInit: 100,
            generateMemory
        });

        expect(result.updated).toBe(true);
        expect(task.getSessionMemoryState().preferredLanguage).toBe('zh-CN');
        expect(await readTaskSessionMemory(task.task_id)).toContain('已用中文更新 session memory。');
    });

    test('并发触发会复用同一个 task-local 更新 promise', async () => {
        createTempAppDirectory();
        const { task } = createTaskWithConversation(12_000);
        let resolveMemory!: (content: string) => void;
        let notifyGeneratorStarted!: () => void;
        const generatorStarted = new Promise<void>((resolve) => {
            notifyGeneratorStarted = resolve;
        });
        const generateMemory = jest.fn(
            (_request: SessionMemoryUpdateRequest): Promise<string> =>
                new Promise<string>((resolve) => {
                    resolveMemory = resolve;
                    notifyGeneratorStarted();
                })
        );

        const first = task.maybeUpdateSessionMemoryAfterCompletion({
            minimumMessageTokensToInit: 100,
            generateMemory
        });
        const second = task.maybeUpdateSessionMemoryAfterCompletion({
            minimumMessageTokensToInit: 100,
            generateMemory
        });

        expect(second).toBe(first);
        await generatorStarted;
        expect(generateMemory).toHaveBeenCalledTimes(1);

        resolveMemory(validSessionMemory('Concurrent update resolved.'));
        const [firstResult, secondResult] = await Promise.all([first, second]);

        expect(firstResult.updated).toBe(true);
        expect(secondResult).toBe(firstResult);
        expect(await readTaskSessionMemory(task.task_id)).toContain('Concurrent update resolved.');
    });

    test('processTaskTurn 自然结束后会调度更新，但不等待后台 promise', async () => {
        createTempAppDirectory();
        const manager = new TaskManagerState();
        const task = new TaskState(manager, null);
        task.task_id = 'task-turn-scheduler';
        task.task_status = 'running';
        manager.tasks.push(task);
        task.hooks.beforeFinishTurn(async () => ({ operation: 'finish' }));

        jest.spyOn(task, 'processCompletion').mockResolvedValue(undefined);
        jest.spyOn(task, 'processToolCalls').mockResolvedValue(false);
        const updateSpy = jest
            .spyOn(task, 'maybeUpdateSessionMemoryAfterCompletion')
            .mockImplementation(() => new Promise<never>(() => {}));

        await task.processTaskTurn();

        expect(updateSpy).toHaveBeenCalledTimes(1);
        expect(task.task_status).toBe('stopped');
    });
});
