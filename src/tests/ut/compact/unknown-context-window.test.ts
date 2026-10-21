import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { OpenAIAdapter } from '../../../main/aikernel/adapters/openai.js';
import {
    getAutoCompactDecision,
    resolveContextWindow,
    resolveMaxOutputTokens
} from '../../../main/aikernel/compaction/auto-compact.js';
import { LLM, type LLMRequestOptions } from '../../../main/aikernel/llm.js';
import { ModelContextBudgets } from '../../../main/aikernel/compaction/model-context-budget.js';
import { calculateCompactionBudget } from '../../../main/aikernel/compaction/request-budget.js';
import {
    AssistantMessage,
    AssistantResponse,
    ChatContext,
    Usage,
    UserMessage
} from '../../../main/aikernel/messages.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { ModelRequestError } from '../../../main/utils/model-request-error.js';
import { Setting } from '../../../main/utils/setting.js';
import { AbstractPlatform, setPlatform } from '../../../platforms/base.js';

class TestPlatform extends AbstractPlatform {
    getName(): string {
        return 'test';
    }

    getEffectiveWorkspace(): string {
        return process.cwd();
    }

    async initPlatformHarness(): Promise<void> {}

    async fetch(input: string | URL): Promise<Response> {
        return Response.json(
            String(input).endsWith('/models') ? { data: [{ id: 'self-hosted-model' }] } : { id: 'self-hosted-model' }
        );
    }
}

let deployment = 0;

function configureModel(contextLength?: number, outputLimit?: number): void {
    Setting.updateInstanceData({
        ...Setting.getInstance().getData(),
        default_model: 'local',
        providers: [
            {
                name: 'local-provider',
                provider_type: 'openai',
                base_url: `https://deployment-${deployment}.invalid/v1`,
                api_key: 'test-key'
            }
        ],
        models: [
            {
                alias: 'local',
                provider_name: 'local-provider',
                model_name: 'self-hosted-model',
                context_length: contextLength,
                max_output_tokens: outputLimit
            }
        ],
        task_config: { auto_retry: false, evidence_card: false }
    });
}

function createTask(): TaskState {
    const manager = new TaskManagerState();
    manager.save = jest.fn();
    manager.publishTaskListUpdate = jest.fn();
    const task = new TaskState(manager);
    task.model = 'local';
    task.task_status = 'running';
    task.chat_context = new ChatContext();
    task.chat_context.appendMessage(new UserMessage('hello'));
    task.chat_context.appendMessage(new AssistantMessage());
    jest.spyOn(task, 'persistLater').mockImplementation(() => undefined);
    return task;
}

function response(tokens = 30000): AssistantResponse {
    const message = new AssistantMessage();
    message.appendText('successful answer');
    const result = new AssistantResponse(message, 'stop');
    result.usage = new Usage(tokens - 100, 100, tokens);
    return result;
}

function overflow(message = 'Request rejected'): ModelRequestError {
    return new ModelRequestError({ status: 400, code: 'context_length_exceeded', message });
}

beforeEach(() => {
    ModelContextBudgets.clear();
    deployment++;
    Setting.clearCache();
    setPlatform(new TestPlatform());
    configureModel();
});

afterEach(() => {
    ModelContextBudgets.clear();
    jest.restoreAllMocks();
    Setting.clearCache();
});

describe('unknown context windows', () => {
    test('a short ordinary request reaches the adapter without a context budget', async () => {
        const task = createTask();
        const compact = jest.spyOn(task, 'compactTaskContext');
        const stream = jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* () {
            yield response();
        });

        await task.processCompletion();

        expect(stream).toHaveBeenCalledTimes(1);
        expect(stream.mock.calls[0][3]?.contextBudget).toBeUndefined();
        expect(compact).not.toHaveBeenCalled();
        expect(task.task_status).toBe('running');
        expect(await resolveContextWindow('local')).toBe(0);
        expect(await resolveMaxOutputTokens('local')).toBe(16384);
    });

    test('successful usage stays unknown until a real overflow, then enables the 80 percent threshold', async () => {
        const task = createTask();
        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* () {
            yield response();
        });
        await task.processCompletion();
        expect(await resolveContextWindow('local')).toBe(0);

        const contexts: Array<LLMRequestOptions | undefined> = [];
        const compact = jest.spyOn(task, 'compactTaskContext').mockImplementation(async () => {
            expect(await resolveContextWindow('local')).toBe(30000);
            task.chat_context = new ChatContext();
            task.chat_context.appendMessage(new UserMessage('saved history'));
            task.chat_context.appendMessage(new AssistantMessage());
            return { compacted: true };
        });
        let requests = 0;
        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* (_context, _model, _options, request) {
            contexts.push(request);
            if (++requests === 1) throw overflow();
            yield response(1000);
        });

        await task.processCompletion();

        expect(requests).toBe(2);
        expect(compact).toHaveBeenCalledTimes(1);
        expect(contexts[0]?.contextBudget).toBeUndefined();
        expect(contexts[1]?.contextBudget?.window).toBe(30000);
        const decision = await getAutoCompactDecision(
            {
                messages: [
                    Object.assign(new AssistantMessage(), {
                        usage: new Usage(24000, 0, 24000)
                    })
                ]
            },
            'local'
        );
        expect(decision.shouldCompact).toBe(true);
        expect(decision.autoCompactThreshold).toBe(24000);
    });

    test('a numeric provider limit works on the first request without prior usage', async () => {
        const task = createTask();
        let requests = 0;
        const stream = jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* () {
            if (++requests === 1) throw overflow("This model's maximum context length is 32768 tokens.");
            yield response(1000);
        });

        await task.processCompletion();

        expect(requests).toBe(2);
        expect(stream.mock.calls[1][3]?.contextBudget?.window).toBe(32768);
        expect(task.task_status).toBe('running');
    });

    test('a timeout does not learn a window or trigger compaction', async () => {
        const task = createTask();
        const compact = jest.spyOn(task, 'compactTaskContext');
        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* () {
            yield response();
        });
        await task.processCompletion();
        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* () {
            yield await Promise.reject(new Error('request timeout'));
        });

        await task.processCompletion();

        expect(await resolveContextWindow('local')).toBe(0);
        expect(compact).not.toHaveBeenCalled();
    });

    test('overflow without usage or a reported limit pauses once with a specific reason', async () => {
        const task = createTask();
        const pause = jest.spyOn(task, 'pauseForContextCompaction');
        const stream = jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* () {
            yield await Promise.reject(overflow());
        });

        await task.processCompletion();

        expect(stream).toHaveBeenCalledTimes(1);
        expect(pause).toHaveBeenCalledWith(expect.objectContaining({ code: 'unknown_context_window' }));
        expect(task.task_status).toBe('stopped');
    });

    test('the real adapter sends requests for unknown windows with the existing output fallback', async () => {
        const task = createTask();
        const send = jest.spyOn(OpenAIAdapter.prototype, 'streamComplete').mockImplementation(async function* () {
            yield response(1000);
        });
        jest.spyOn(LLM, 'supportsVision').mockResolvedValue(false);

        await task.processCompletion();

        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0][3]?.contextBudget).toBeUndefined();
    });

    test('actual summary recovery uses the learned 15 percent budget and preserves the recent user request', async () => {
        const task = createTask();
        const assistant = task.chat_context.lastMessage() as AssistantMessage;
        for (const [index, tokens] of [5000, 10000, 18000, 30000].entries()) {
            assistant.beginCompletionRound(false);
            assistant.appendText(`completed ${index} ` + 'history '.repeat(1800));
            assistant.usage = new Usage(tokens - 100, 100, tokens);
            assistant.recordCompletionUsage('local');
        }
        const instance = Setting.getInstance().getModelInstance('local', 'chat')!;
        ModelContextBudgets.recordSuccess(instance, assistant.usage);
        task.chat_context.appendMessage(new UserMessage('latest user request'));
        task.chat_context.appendMessage(new AssistantMessage());
        const ask = jest.spyOn(LLM, 'askWithMetadata').mockResolvedValue({
            text: 'saved older history',
            reasoningLength: 0,
            finishReason: 'stop'
        });
        let requests = 0;
        const stream = jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* () {
            if (++requests === 1) throw overflow();
            yield response(2000);
        });

        await task.processCompletion();

        expect(requests).toBe(2);
        expect(ask).toHaveBeenCalledTimes(1);
        expect(ask.mock.calls[0][2]?.maxCompletionTokens).toBe(4500);
        expect(ask.mock.calls[0][2]?.contextBudget?.window).toBe(30000);
        expect(task.chat_context.findCompactBoundary()?.message.summary).toBe('saved older history');
        expect(JSON.stringify(stream.mock.calls[1][0].messages)).toContain('latest user request');
        expect(task.task_status).toBe('running');
    });

    test('manual summary requests respect the configured output cap for unknown model names', async () => {
        configureModel(32768, 1024);
        const task = createTask();
        for (let index = 0; index < 5; index++) {
            task.chat_context.appendMessage(new UserMessage(`user ${index}`));
            const answer = new AssistantMessage();
            answer.appendText(`answer ${index}` + 'history '.repeat(500));
            task.chat_context.appendMessage(answer);
        }
        const ask = jest.spyOn(LLM, 'askWithMetadata').mockResolvedValue({
            text: 'saved history',
            reasoningLength: 0,
            finishReason: 'stop'
        });

        await expect(task.compactTaskContext()).resolves.toMatchObject({ compacted: true });

        expect(ask.mock.calls[0][2]?.maxCompletionTokens).toBe(1024);
        expect(calculateCompactionBudget(32768).summaryOutputTokens).toBe(4915);
    });

    test('partial output and usage from the rejected request do not replace the last successful budget', async () => {
        const task = createTask();
        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* () {
            yield response();
        });
        await task.processCompletion();
        const pause = jest.spyOn(task, 'pauseForContextCompaction');
        jest.spyOn(task, 'compactTaskContext').mockRejectedValue(new Error('stop recovery for inspection'));
        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* () {
            yield response(60000);
            throw overflow();
        });

        await task.processCompletion();

        expect(await resolveContextWindow('local')).toBe(30000);
        expect(pause).toHaveBeenCalledTimes(1);
    });

    test('manual compaction can use successful evidence without enabling automatic thresholds', async () => {
        const task = createTask();
        const instance = Setting.getInstance().getModelInstance('local', 'chat')!;
        ModelContextBudgets.recordSuccess(instance, { total_tokens: 30000 });
        for (let index = 0; index < 5; index++) {
            task.chat_context.appendMessage(new UserMessage(`user ${index}`));
            const answer = new AssistantMessage();
            answer.appendText(`answer ${index}` + 'history '.repeat(500));
            task.chat_context.appendMessage(answer);
        }
        const ask = jest.spyOn(LLM, 'askWithMetadata').mockResolvedValue({
            text: 'saved history',
            reasoningLength: 0,
            finishReason: 'stop'
        });

        await expect(task.compactTaskContext()).resolves.toMatchObject({ compacted: true });

        expect(ask.mock.calls[0][2]?.maxCompletionTokens).toBe(4500);
        expect(await resolveContextWindow('local')).toBe(0);
    });

    test('manual configuration takes priority over a learned window', async () => {
        const instance = Setting.getInstance().getModelInstance('local', 'chat')!;
        ModelContextBudgets.recordSuccess(instance, { total_tokens: 30000 });
        ModelContextBudgets.learnFromOverflow(instance, overflow());
        expect(await resolveContextWindow('local')).toBe(30000);

        configureModel(65536);

        expect(await resolveContextWindow('local')).toBe(65536);
    });
});
