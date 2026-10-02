import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import { LLM } from '../../../main/aikernel/llm.js';
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
import {
    BaseTaskUpdateSubscriber,
    TaskManagerState,
    TaskState,
    type TaskUpdateChunk,
    type TaskUpdateRetryChunk
} from '../../../main/aikernel/states/tasks.js';
import { Setting, setCustomOpendeskDirectory } from '../../../main/utils/setting.js';
import { ModelRequestError } from '../../../main/utils/model-request-error.js';
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

function configureSetting(): void {
    Setting.updateInstanceData({
        ...Setting.getInstance().getData(),
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
                context_length: 70000,
                max_output_tokens: 4096
            }
        ],
        task_config: {
            auto_retry: true,
            generate_taskname: true,
            termination_check: true,
            evidence_card: false
        }
    });
}

function createRunningTask(): { task: TaskState; chunks: TaskUpdateChunk[] } {
    configureSetting();

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

async function waitForCondition(predicate: () => boolean, attempts = 200): Promise<void> {
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

describe('task LLM request tail via onTailcardGenerate', () => {
    let tempDir: string;

    beforeEach(() => {
        registerDeadloopHarness();
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-task-llm-tailcards-'));
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

    function seedUsageHistory(task: TaskState): AssistantMessage {
        const assistant = task.chat_context.lastMessage() as AssistantMessage;
        for (const [index, tokens] of [10000, 20000, 30000, 45000].entries()) {
            assistant.beginCompletionRound(false);
            assistant.appendText(`completed work ${index} ` + 'history '.repeat(5500));
            const part = new ToolCallMessagePart();
            const call = new ToolCall(index, `saved-${index}`, 'readImage', '{}');
            part.push(call);
            assistant.appendToolCallPart(part);
            assistant.usage = new Usage(tokens - 100, 100, tokens);
            assistant.recordCompletionUsage('mock-model');
            call.status = 'success';
            call.result = `saved result ${index}`;
        }
        return assistant;
    }

    test('provider context overflow compacts and rebuilds the request without rerunning tools', async () => {
        const { task } = createRunningTask();
        const assistant = seedUsageHistory(task);
        const asks = jest
            .spyOn(LLM, 'askWithMetadata')
            .mockResolvedValue({ text: 'saved history', reasoningLength: 0 });
        let requests = 0;
        const seen: string[] = [];
        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* (context) {
            seen.push(JSON.stringify(context.messages));
            if (++requests === 1) throw new Error('maximum context length exceeded');
            yield textResponse('recovered', 'stop');
        });
        await task.processCompletion();
        expect(requests).toBe(2);
        expect(asks).toHaveBeenCalledTimes(1);
        expect(seen[1]).toContain('saved history');
        expect(seen[1]).toContain('saved result 3');
        expect(assistant.content.some((part) => part.type === 'text' && part.text === 'recovered')).toBe(true);
        expect(task.task_status).toBe('running');
    });

    test.each(['context_length_exceeded', 'prompt_too_long'])(
        'normalized %s responses recover through compaction before non-retryable handling',
        async (code) => {
            const { task, chunks } = createRunningTask();
            const assistant = seedUsageHistory(task);
            const asks = jest
                .spyOn(LLM, 'askWithMetadata')
                .mockResolvedValue({ text: 'saved history', reasoningLength: 0 });
            let requests = 0;
            const seen: string[] = [];
            jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* (context) {
                seen.push(JSON.stringify(context.messages));
                if (++requests === 1) {
                    const response = AssistantResponse.error('Request rejected');
                    response.request_error = new ModelRequestError({
                        provider: 'openai',
                        status: 400,
                        code,
                        type: 'invalid_request_error',
                        message: 'Request rejected'
                    });
                    yield response;
                    return;
                }
                yield textResponse('recovered', 'stop');
            });

            await task.processCompletion();

            expect(requests).toBe(2);
            expect(asks).toHaveBeenCalledTimes(1);
            expect(seen[1]).toContain('saved history');
            expect(seen[1]).toContain('saved result 3');
            expect(assistant.content.some((part) => part.type === 'text' && part.text === 'recovered')).toBe(true);
            expect(retryChunks(chunks)).toEqual([]);
            expect(task.task_status).toBe('running');
        }
    );

    test('successful usage at 80 percent waits until the next request to compact', async () => {
        const { task } = createRunningTask();
        seedUsageHistory(task);
        const asks = jest
            .spyOn(LLM, 'askWithMetadata')
            .mockResolvedValue({ text: 'saved history', reasoningLength: 0 });
        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* () {
            const response = textResponse('large successful response', 'stop');
            response.usage = new Usage(55000, 1000, 56000);
            yield response;
        });
        await task.processCompletion();
        expect(asks).not.toHaveBeenCalled();
        expect(task.chat_context.findCompactBoundary()).toBeUndefined();
        await task.processCompletion();
        expect(asks).toHaveBeenCalledTimes(1);
        expect(task.chat_context.findCompactBoundary()).toBeDefined();
        expect(task.task_status).toBe('running');
    });

    test('repeated business context errors share a three-attempt recovery budget', async () => {
        const { task } = createRunningTask();
        seedUsageHistory(task);
        const asks = jest
            .spyOn(LLM, 'askWithMetadata')
            .mockResolvedValue({ text: 'saved history', reasoningLength: 0 });
        const stream = jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* () {
            yield await Promise.reject(new Error('context_length_exceeded'));
        });
        await task.processCompletion();
        expect(asks).toHaveBeenCalledTimes(3);
        expect(stream).toHaveBeenCalledTimes(4);
        expect(task.task_status).toBe('stopped');
    });

    test('estimated input above 100 percent compacts before the first business request', async () => {
        const { task } = createRunningTask();
        const assistant = seedUsageHistory(task);
        const part = assistant.content.at(-1)!;
        if (part.type !== 'tool_call') throw new Error('missing tool call');
        part.toolcalls[0].result_object = {
            type: 'image',
            images: Array.from({ length: 22 }, () => ({ image_url: 'data:image/png;base64,AAAA' }))
        };
        // Summarize the earlier prefix; do not discard the latest large image result.
        const events: string[] = [];
        jest.spyOn(LLM, 'askWithMetadata').mockImplementation(async () => {
            events.push('summary');
            return { text: 'saved history', reasoningLength: 0 };
        });
        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* (context) {
            events.push('business');
            expect(JSON.stringify(context.messages)).toContain('data:image/png;base64,AAAA');
            yield textResponse('recovered', 'stop');
        });
        await task.processCompletion();
        expect(events).toEqual(['summary', 'business']);
        expect(task.task_status).toBe('running');
    });

    test('mixed summary and business overflow cannot reset the recovery attempt counter', async () => {
        const { task } = createRunningTask();
        seedUsageHistory(task);
        let count = 0;
        const summary = jest.spyOn(LLM, 'askWithMetadata').mockImplementation(async () => {
            if (++count < 3) throw new Error('prompt is too long');
            return { text: 'saved history', reasoningLength: 0 };
        });
        const stream = jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* () {
            yield await Promise.reject(new Error('context_length_exceeded'));
        });
        await task.processCompletion();
        expect(summary).toHaveBeenCalledTimes(3);
        expect(stream).toHaveBeenCalledTimes(2);
        expect(task.task_status).toBe('stopped');
    });

    test('builds the active main-task tail once and reuses it across provider retries', async () => {
        const { task, chunks } = createRunningTask();
        let tailBuildCount = 0;
        const requestTails: Array<string | undefined> = [];
        task.hooks.onTailcardGenerate(() => ({ id: 'retry-tail', content: `tail snapshot ${++tailBuildCount}` }));
        let requestCount = 0;
        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* (_chatContext, _model, options) {
            requestTails.push(options?.requestTailText);
            requestCount++;
            if (requestCount === 1) {
                throw new Error('retry once');
            }
            yield textResponse('final answer', 'stop');
        });

        const completion = task.processCompletion();
        await waitForCondition(() =>
            retryChunks(chunks).some((chunk) => chunk.status === 'scheduled' && chunk.attempt === 1)
        );
        await jest.advanceTimersByTimeAsync(10_000);
        await completion;

        expect(tailBuildCount).toBe(1);
        expect(requestTails).toHaveLength(2);
        expect(requestTails[0]).toBe(requestTails[1]);
        expect(requestTails[0]).toContain('## Section: retry-tail');
        expect(requestTails[0]).toContain('tail snapshot 1');
    });

    test('does not add requestTailText for inactive callbacks and injects tails for child and internal tasks', async () => {
        const inactive = createRunningTask().task;
        inactive.hooks.onTailcardGenerate(() => undefined);

        const child = createRunningTask().task;
        child.parent_id = 'parent-task';
        let childCallbackCount = 0;
        child.hooks.onTailcardGenerate(() => {
            childCallbackCount++;
            return { id: 'child-tail', content: 'child tail content' };
        });

        const internal = createRunningTask().task;
        internal.internal = true;
        let internalCallbackCount = 0;
        internal.hooks.onTailcardGenerate(() => {
            internalCallbackCount++;
            return { id: 'internal-tail', content: 'internal tail content' };
        });

        const requestTails: Array<string | undefined> = [];
        const hasRequestTailOption: boolean[] = [];
        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* (_chatContext, _model, options) {
            requestTails.push(options?.requestTailText);
            hasRequestTailOption.push(Object.prototype.hasOwnProperty.call(options ?? {}, 'requestTailText'));
            yield textResponse('done', 'stop');
        });

        await inactive.processCompletion();
        await child.processCompletion();
        await internal.processCompletion();

        expect(requestTails[0]).toBeUndefined();
        expect(requestTails[1]).toContain('## Section: child-tail');
        expect(requestTails[1]).toContain('child tail content');
        expect(requestTails[2]).toContain('## Section: internal-tail');
        expect(requestTails[2]).toContain('internal tail content');
        expect(hasRequestTailOption).toEqual([false, true, true]);
        expect(childCallbackCount).toBe(1);
        expect(internalCallbackCount).toBe(1);
    });

    test('does not inject requestTailText when EvidenceCard feature is disabled, and injects when enabled', async () => {
        const { task } = createRunningTask();
        const requestTails: Array<string | undefined> = [];
        const hasRequestTailOption: boolean[] = [];
        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* (_chatContext, _model, options) {
            requestTails.push(options?.requestTailText);
            hasRequestTailOption.push(Object.prototype.hasOwnProperty.call(options ?? {}, 'requestTailText'));
            yield textResponse('done', 'stop');
        });

        // EvidenceCard 关闭时：不注入任何内容，requestTailText 字段不出现
        Setting.updateInstanceData({
            ...Setting.getInstance().getData(),
            task_config: {
                auto_retry: true,
                generate_taskname: true,
                termination_check: true,
                evidence_card: false
            }
        });
        await task.processCompletion();

        expect(requestTails).toEqual([undefined]);
        expect(hasRequestTailOption).toEqual([false]);

        // EvidenceCard 开启时：注入包含 EvidenceCard section 的 TailCards
        Setting.updateInstanceData({
            ...Setting.getInstance().getData(),
            task_config: {
                auto_retry: true,
                generate_taskname: true,
                termination_check: true,
                evidence_card: true
            }
        });
        requestTails.length = 0;
        hasRequestTailOption.length = 0;
        // 重新创建 assistant message 以触发新的 processCompletion
        task.chat_context.appendMessage(new AssistantMessage());
        await task.processCompletion();

        expect(requestTails).toHaveLength(1);
        expect(requestTails[0]).toContain('[OpenDesk Internal Request Tail]');
        expect(requestTails[0]).toContain('## Section: evidence-card');
        expect(hasRequestTailOption).toEqual([true]);
    });

    test('injects EvidenceCard into child and internal task requests when enabled', async () => {
        const child = createRunningTask().task;
        child.parent_id = 'parent-task';
        const internal = createRunningTask().task;
        internal.internal = true;
        Setting.updateInstanceData({
            ...Setting.getInstance().getData(),
            task_config: {
                auto_retry: true,
                generate_taskname: true,
                termination_check: true,
                evidence_card: true
            }
        });
        const requestTails: Array<string | undefined> = [];
        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* (_chatContext, _model, options) {
            requestTails.push(options?.requestTailText);
            yield textResponse('done', 'stop');
        });

        await child.processCompletion();
        await internal.processCompletion();

        expect(requestTails).toHaveLength(2);
        expect(requestTails[0]).toContain('## Section: evidence-card');
        expect(requestTails[1]).toContain('## Section: evidence-card');
    });

    test('pauses without sending raw history or generating tailcards when preparation fails', async () => {
        const { task } = createRunningTask();
        const deduplicateSpy = jest
            .spyOn(task.chat_context, 'deduplicateCompactBoundaries')
            .mockImplementationOnce(() => {
                throw new Error('context preparation failed');
            });
        let callbackContext:
            | {
                  activeContext: unknown;
                  chatContext: Pick<ChatContext, 'messages'>;
              }
            | undefined;
        task.hooks.onTailcardGenerate((ctx) => {
            callbackContext = ctx;
            return { id: 'fallback-tail', content: 'fallback tail content' };
        });
        const requestTails: Array<string | undefined> = [];
        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* (_chatContext, _model, options) {
            requestTails.push(options?.requestTailText);
            yield textResponse('done', 'stop');
        });

        await task.processCompletion();

        expect(deduplicateSpy).toHaveBeenCalledTimes(1);
        expect(callbackContext?.activeContext).toBeUndefined();
        expect(callbackContext).toBeUndefined();
        expect(requestTails).toHaveLength(0);
        expect(task.task_status).toBe('stopped');
    });
});
