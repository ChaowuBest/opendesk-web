import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import { LLM, type LLMRequestOptions } from '../../../main/aikernel/llm.js';
import {
    AssistantMessage,
    AssistantResponse,
    ChatContext,
    ToolCall,
    ToolCallMessagePart,
    Usage,
    UserMessage
} from '../../../main/aikernel/messages.js';
import { registerDeadloopHarness } from '../../../main/aikernel/harnesses/chat/deadloop.js';
import { waitForLLMRetryDelayForTask } from '../../../main/aikernel/task/completion.js';
import {
    BaseTaskUpdateSubscriber,
    TaskManagerState,
    TaskState,
    type TaskUpdateChunk,
    type TaskUpdateRetryChunk
} from '../../../main/aikernel/states/tasks.js';
import { Setting, setCustomOpendeskDirectory } from '../../../main/utils/setting.js';
import { AbstractPlatform, setPlatform } from '../../../platforms/base.js';

class TestPlatform extends AbstractPlatform {
    getName(): string {
        return 'test';
    }

    getEffectiveWorkspace(): string {
        return process.cwd();
    }

    async initPlatformHarness(_task: TaskState): Promise<void> {}

    async fetch(_input: string | URL, _init?: RequestInit): Promise<Response> {
        return new Response('{}', { status: 200 });
    }
}

class CollectingSubscriber extends BaseTaskUpdateSubscriber {
    constructor(private readonly chunks: TaskUpdateChunk[]) {
        super();
    }

    send(chunkUpdate: TaskUpdateChunk): void {
        this.chunks.push(chunkUpdate);
    }
}

function textResponse(text: string, finishReason: 'stop' | 'tool_calls' | null = null): AssistantResponse {
    const message = new AssistantMessage();
    message.appendText(text);
    const response = new AssistantResponse(message, finishReason);
    response.usage = new Usage(10, text.length, 10 + text.length);
    return response;
}

function toolCallResponse(index: number, prefix = 'request'): AssistantResponse {
    const message = new AssistantMessage();
    const part = new ToolCallMessagePart();
    part.push(new ToolCall(index, `${prefix}-call-${index}`, `${prefix}-tool-${index}`, '{}'));
    message.appendToolCallPart(part);
    return new AssistantResponse(message, 'tool_calls');
}

function configureSetting(autoRetry: boolean): void {
    Setting.updateInstanceData({
        default_model: 'mock-model',
        providers: [
            {
                name: 'mock-provider',
                provider_type: 'openai',
                base_url: 'https://mock.local/v1',
                api_key: 'test-key',
                no_proxy: true
            }
        ],
        models: [
            {
                alias: 'mock-model',
                provider_name: 'mock-provider',
                model_name: 'mock/model',
                context_length: 8192
            },
            {
                alias: 'next-model',
                provider_name: 'mock-provider',
                model_name: 'mock/next',
                context_length: 8192
            }
        ],
        task_config: {
            auto_retry: autoRetry
        }
    });
}

function createRunningTask(autoRetry: boolean): { task: TaskState; chunks: TaskUpdateChunk[] } {
    configureSetting(autoRetry);

    const manager = new TaskManagerState();
    manager.save = jest.fn();
    manager.publishTaskListUpdate = jest.fn();

    const task = new TaskState(manager);
    task.task_status = 'running';
    task.model = 'mock-model';
    task.chat_context = new ChatContext();
    task.chat_context.appendMessage(new UserMessage('hello'));
    task.chat_context.appendMessage(new AssistantMessage());

    const chunks: TaskUpdateChunk[] = [];
    task.addSubscriber(new CollectingSubscriber(chunks));
    return { task, chunks };
}

async function waitForCondition(predicate: () => boolean, attempts = 80): Promise<void> {
    for (let i = 0; i < attempts; i++) {
        if (predicate()) return;
        await jest.advanceTimersByTimeAsync(0);
        await Promise.resolve();
    }
    throw new Error('condition not met');
}

function retryChunks(chunks: TaskUpdateChunk[]): TaskUpdateRetryChunk[] {
    return chunks.filter((chunk): chunk is TaskUpdateRetryChunk => chunk.type === 'retry');
}

describe('task LLM auto retry', () => {
    let tempDir: string;

    beforeEach(() => {
        registerDeadloopHarness();
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-task-llm-retry-'));
        setCustomOpendeskDirectory(tempDir);
        Setting.clearCache();
        setPlatform(new TestPlatform());
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-06-10T10:00:00.000Z'));
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
        Setting.clearCache();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('retries all LLM request errors with exponential backoff and clears partial output', async () => {
        const { task, chunks } = createRunningTask(true);
        const requestOptionsSeen: Array<LLMRequestOptions | undefined> = [];
        let requestCount = 0;

        jest.spyOn(LLM, 'streamComplete').mockImplementation(
            async function* (_chatContext, _model, _options, requestOptions) {
                requestOptionsSeen.push(requestOptions);
                requestCount++;
                if (requestCount === 1) {
                    throw new Error('network is down');
                }
                if (requestCount === 2) {
                    yield textResponse('partial draft that must be removed');
                    yield AssistantResponse.richError('Stream Completion Failed', 'provider returned 500');
                    return;
                }
                yield textResponse('final answer', 'stop');
            }
        );

        const completion = task.processCompletion();

        await waitForCondition(() =>
            retryChunks(chunks).some((chunk) => chunk.status === 'scheduled' && chunk.attempt === 1)
        );
        expect(retryChunks(chunks).find((chunk) => chunk.attempt === 1)?.delay_ms).toBe(10_000);

        await jest.advanceTimersByTimeAsync(10_000);
        await waitForCondition(() => {
            return retryChunks(chunks).some((chunk) => chunk.status === 'scheduled' && chunk.attempt === 2);
        });
        expect(retryChunks(chunks).find((chunk) => chunk.attempt === 2)?.delay_ms).toBe(20_000);

        await jest.advanceTimersByTimeAsync(20_000);
        await completion;

        expect(requestCount).toBe(3);
        expect(requestOptionsSeen.every((options) => options?.disableInternalRetry === true)).toBe(true);
        expect(retryChunks(chunks).some((chunk) => chunk.status === 'cleared' && chunk.attempt === 2)).toBe(true);
        expect(chunks.some((chunk) => chunk.type === 'assistant_replace' && chunk.parts.length === 0)).toBe(true);

        const assistant = task.chat_context.lastMessage() as AssistantMessage;
        expect(assistant.content.map((part) => (part.type === 'text' ? part.text : '')).join('')).toBe('final answer');
        expect(assistant.content.some((part) => part.type === 'error')).toBe(false);
    });

    test('appends one error when auto retry is disabled', async () => {
        const { task, chunks } = createRunningTask(false);

        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* () {
            yield* [] as AssistantResponse[];
            throw new Error('bad gateway');
        });

        await task.processCompletion();

        expect(retryChunks(chunks)).toHaveLength(0);
        const assistant = task.chat_context.lastMessage() as AssistantMessage;
        expect(assistant.content.filter((part) => part.type === 'error')).toHaveLength(1);
        expect(chunks.some((chunk) => chunk.type === 'assistant' && chunk.last_part.type === 'error')).toBe(true);
    });

    test('does not count tool calls completed before the current completion request', async () => {
        const { task } = createRunningTask(false);
        const assistant = task.chat_context.lastMessage() as AssistantMessage;
        const previousPart = new ToolCallMessagePart();
        for (let index = 0; index < 10; index++) {
            const toolCall = new ToolCall(index, `previous-call-${index}`, `previous-tool-${index}`, '{}');
            toolCall.status = 'success';
            toolCall.result = '{}';
            previousPart.push(toolCall);
        }
        assistant.appendToolCallPart(previousPart);

        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* () {
            yield toolCallResponse(0);
        });

        await expect(task.processCompletion()).resolves.toBe(false);

        const toolCalls = assistant.content.flatMap((part) => (part.type === 'tool_call' ? part.toolcalls : []));
        expect(toolCalls).toHaveLength(11);
        expect(toolCalls[10].id).toBe('request-call-0');
        expect(toolCalls[10].status).toBe('pending');
    });

    test('marks a stream stopped by the per-request tool call cap as an internal hook interruption', async () => {
        const { task } = createRunningTask(false);

        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* () {
            for (let index = 0; index < 11; index++) {
                yield toolCallResponse(index);
            }
        });

        await expect(task.processCompletion()).resolves.toBe(true);

        const assistant = task.chat_context.lastMessage() as AssistantMessage;
        const toolCalls = assistant.content.flatMap((part) => (part.type === 'tool_call' ? part.toolcalls : []));
        expect(toolCalls).toHaveLength(10);
        expect(toolCalls.every((toolCall) => toolCall.status === 'pending')).toBe(true);
        expect(toolCalls.some((toolCall) => toolCall.id === 'request-call-10')).toBe(false);
    });

    test('executes the accepted tool batch and continues after the tool call cap stops a stream', async () => {
        const { task } = createRunningTask(false);
        task.parent_id = 'parent-task';
        const processCompletionSpy = jest
            .spyOn(task, 'processCompletion')
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false);
        const processToolCallsSpy = jest
            .spyOn(task, 'processToolCalls')
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false);
        const beforeFinishSpy = jest.fn(async () => ({ operation: 'finish' as const }));
        task.hooks.beforeFinishTurn(beforeFinishSpy);

        await task.processTaskTurn();

        expect(processCompletionSpy).toHaveBeenCalledTimes(2);
        expect(processToolCallsSpy).toHaveBeenCalledTimes(2);
        expect(beforeFinishSpy).toHaveBeenCalledTimes(1);
    });

    test('uses the latest task model when retrying after a model switch', async () => {
        const { task, chunks } = createRunningTask(true);
        const modelsSeen: Array<string | undefined> = [];
        let requestCount = 0;

        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* (_chatContext, model) {
            modelsSeen.push(typeof model === 'string' ? model : undefined);
            requestCount++;
            if (requestCount === 1) {
                throw new Error('temporary outage');
            }
            yield textResponse('answer from switched model', 'stop');
        });

        const completion = task.processCompletion();

        await waitForCondition(() => {
            return retryChunks(chunks).some((chunk) => chunk.status === 'scheduled' && chunk.attempt === 1);
        });

        task.model = 'next-model';
        expect(task.isLLMRetryDelayPending()).toBe(true);
        expect(task.skipRetryDelay()).toBe(true);

        await completion;

        expect(modelsSeen).toEqual(['mock-model', 'next-model']);
        expect(task.isLLMRetryDelayPending()).toBe(false);
        const assistant = task.chat_context.lastMessage() as AssistantMessage;
        expect(assistant.content.map((part) => (part.type === 'text' ? part.text : '')).join('')).toBe(
            'answer from switched model'
        );
    });

    test('caps exponential backoff at ten minutes', async () => {
        const { task, chunks } = createRunningTask(true);
        const expectedDelays = [10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 600_000, 600_000];
        let requestCount = 0;

        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* () {
            requestCount++;
            yield* [] as AssistantResponse[];
            throw new Error(`failure ${requestCount}`);
        });

        const completion = task.processCompletion();

        for (let attempt = 1; attempt <= expectedDelays.length; attempt++) {
            await waitForCondition(() =>
                retryChunks(chunks).some((chunk) => chunk.status === 'scheduled' && chunk.attempt === attempt)
            );
            const scheduled = retryChunks(chunks).find(
                (chunk) => chunk.status === 'scheduled' && chunk.attempt === attempt
            );
            expect(scheduled?.delay_ms).toBe(expectedDelays[attempt - 1]);
            if (attempt < expectedDelays.length) {
                await jest.advanceTimersByTimeAsync(expectedDelays[attempt - 1]);
            }
        }

        task.task_status = 'stopped';
        await jest.advanceTimersByTimeAsync(1000);
        await completion;

        expect(requestCount).toBe(expectedDelays.length);
    });

    test('processCompletion stops processing chunks when turn generation changes', async () => {
        // When submitUserMessage increments _turnGeneration (and sets task_status back to 'running'),
        // the old turn's processCompletion should detect the generation mismatch and stop processing
        // LLM chunks, instead of continuing to merge content into the stale assistant message.
        const { task } = createRunningTask(false);
        task.onTextPartComplete = jest.fn();
        task.profiler = {
            beginLLM: jest.fn(),
            endLLM: jest.fn()
        } as any;

        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* () {
            yield textResponse('first chunk');
            // Simulate submitUserMessage incrementing generation while task_status is 'running'
            (task as any)._turnGeneration++;
            yield textResponse('second chunk');
        });

        await task.processCompletion();

        const lastMessage = task.chat_context.lastMessage() as AssistantMessage;
        const fullText = lastMessage.content
            .filter((p) => p.type === 'text')
            .map((p) => (p as { text: string }).text)
            .join('');

        expect(fullText).toContain('first chunk');
        expect(fullText).not.toContain('second chunk');
        expect(task.onTextPartComplete).not.toHaveBeenCalled();
        expect(task.profiler.endLLM).not.toHaveBeenCalled();
    });

    test('processCompletion does not merge a chunk when generation changes during an async hook', async () => {
        const { task } = createRunningTask(false);
        task.hooks.beforeToolcallCreated(async () => {
            (task as any)._turnGeneration++;
            return { operation: 'accept' };
        });

        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* () {
            yield textResponse('stale chunk');
        });

        await task.processCompletion();

        const lastMessage = task.chat_context.lastMessage() as AssistantMessage;
        const fullText = lastMessage.content
            .filter((part) => part.type === 'text')
            .map((part) => (part as { text: string }).text)
            .join('');

        expect(fullText).toBe('');
    });

    test('deprecated turn leaves retry delay without starting another request', async () => {
        const { task, chunks } = createRunningTask(true);
        let requestCount = 0;
        let finished = false;

        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* () {
            requestCount++;
            yield* [] as AssistantResponse[];
            throw new Error('temporary failure');
        });

        const completion = task.processCompletion().then(() => {
            finished = true;
        });
        await waitForCondition(() => retryChunks(chunks).some((chunk) => chunk.status === 'scheduled'));

        (task as any)._turnGeneration++;
        await jest.advanceTimersByTimeAsync(1000);
        await completion;

        expect(finished).toBe(true);
        expect(requestCount).toBe(1);
        expect(task._retryDelayPending).toBe(false);
    });

    test('deprecated retry wait does not clear the active turn retry state', async () => {
        const { task } = createRunningTask(true);
        const firstGeneration = task.getTurnGeneration();
        const firstWait = waitForLLMRetryDelayForTask(task, 1, 10_000, new Error('first failure'), firstGeneration);

        (task as any)._turnGeneration++;
        const secondWait = waitForLLMRetryDelayForTask(
            task,
            1,
            10_000,
            new Error('second failure'),
            task.getTurnGeneration()
        );
        await Promise.resolve();
        await expect(firstWait).resolves.toBe(false);

        expect(task._retryDelayPending).toBe(true);
        expect(task.skipRetryDelay()).toBe(true);
        await expect(secondWait).resolves.toBe(true);
        expect(task._retryDelayPending).toBe(false);
    });
});
