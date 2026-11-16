import { jest } from '@jest/globals';
import {
    DEFAULT_STREAM_IDLE_TIMEOUT_SECONDS,
    resolveStreamIdleTimeoutMs,
    StreamIdleTimeoutError,
    STREAM_IDLE_TIMEOUT_MS,
    withStreamIdleTimeout
} from '../../../main/utils/stream-timeout.js';
import { fetchModelUrl, ModelResponseTimeoutError } from '../../../main/utils/model-network.js';
import { classifyModelRequestError } from '../../../main/utils/model-request-error.js';
import { OpenAIAdapter } from '../../../main/aikernel/adapters/openai.js';
import { AnthropicAdapter } from '../../../main/aikernel/adapters/anthropic.js';
import { AssistantResponse, ChatContext, ErrorMessagePart, UserMessage } from '../../../main/aikernel/messages.js';
import { ModelInstance, Setting } from '../../../main/utils/setting.js';
import { AbstractPlatform, setPlatform, type PlatformFetchOptions } from '../../../platforms/base.js';
import { setRuntimeLocale } from '../../../locale/index.js';

const IDLE_MS = DEFAULT_STREAM_IDLE_TIMEOUT_SECONDS * 1000;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function chatContext(): ChatContext {
    const context = new ChatContext();
    context.appendMessage(new UserMessage('hello'));
    return context;
}

function errorMessageOf(chunks: AssistantResponse[]): string | undefined {
    return chunks.at(-1)?.content.content.find((part): part is ErrorMessagePart => part.type === 'error')?.message;
}

class ScriptedPlatform extends AbstractPlatform {
    constructor(private readonly handler: (init?: RequestInit) => Promise<Response>) {
        super();
    }
    getName(): string {
        return 'test';
    }
    getEffectiveWorkspace(): string {
        return process.cwd();
    }
    async initPlatformHarness(): Promise<void> {}
    async fetch(_input: string | URL, init?: RequestInit, _options?: PlatformFetchOptions): Promise<Response> {
        return this.handler(init);
    }
}

/** 像 Electron session.fetch 一样响应 signal：一直不返回响应头，被中止时 reject */
function neverRespond(init?: RequestInit): Promise<Response> {
    return new Promise((_, reject) => {
        const signal = init?.signal;
        const fail = () => reject(signal?.reason ?? new Error('aborted'));
        if (signal?.aborted) fail();
        else signal?.addEventListener('abort', fail, { once: true });
    });
}

beforeEach(() => setRuntimeLocale('en-US'));
afterEach(() => setRuntimeLocale(null));

describe('resolveStreamIdleTimeoutMs', () => {
    test('defaults to 120 seconds and never exceeds the model timeout', () => {
        expect(resolveStreamIdleTimeoutMs(STREAM_IDLE_TIMEOUT_MS, {})).toBe(120_000);
        expect(resolveStreamIdleTimeoutMs(30_000, {})).toBe(30_000);
    });

    test('honours OPENDESK_STREAM_IDLE_TIMEOUT_SECONDS and ignores invalid values', () => {
        expect(resolveStreamIdleTimeoutMs(300_000, { OPENDESK_STREAM_IDLE_TIMEOUT_SECONDS: '45' })).toBe(45_000);
        expect(resolveStreamIdleTimeoutMs(300_000, { OPENDESK_STREAM_IDLE_TIMEOUT_SECONDS: '0' })).toBe(120_000);
        expect(resolveStreamIdleTimeoutMs(300_000, { OPENDESK_STREAM_IDLE_TIMEOUT_SECONDS: 'x' })).toBe(120_000);
        expect(resolveStreamIdleTimeoutMs(60_000, { OPENDESK_STREAM_IDLE_TIMEOUT_SECONDS: '600' })).toBe(60_000);
    });
});

describe('withStreamIdleTimeout first value vs. later values', () => {
    test('waits the longer first-value timeout, then applies the idle timeout', async () => {
        async function* source() {
            await delay(80); // 首个值来得慢（模型在思考），但在 firstValueTimeoutMs 之内
            yield 'first';
            await new Promise<never>(() => {}); // 之后中途静默
        }
        const iter = withStreamIdleTimeout(source(), 30, undefined, { firstValueTimeoutMs: 200 });
        await expect(iter.next()).resolves.toEqual({ done: false, value: 'first' });
        const started = Date.now();
        await expect(iter.next()).rejects.toMatchObject({ name: 'StreamIdleTimeoutError', timeoutMs: 30 });
        expect(Date.now() - started).toBeLessThan(150);
    });

    test('a first value that never comes times out after firstValueTimeoutMs', async () => {
        async function* hanging() {
            await new Promise<never>(() => {});
            yield 'unreachable';
        }
        const iter = withStreamIdleTimeout(hanging(), 10, undefined, { firstValueTimeoutMs: 60 });
        await expect(iter.next()).rejects.toMatchObject({ timeoutMs: 60 });
    });
});

describe('adapters give up on a stream that goes silent mid-way', () => {
    beforeEach(() => {
        Setting.clearCache();
        jest.useFakeTimers();
    });
    afterEach(() => {
        Setting.clearCache();
        jest.useRealTimers();
    });

    test('OpenAI: error after the idle timeout instead of the full model timeout', async () => {
        const stream = {
            async *[Symbol.asyncIterator]() {
                yield { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'hi' } }] };
                await new Promise<never>(() => {});
            },
            controller: { abort: jest.fn() }
        };
        const adapter = new OpenAIAdapter(new ModelInstance('m', 'http://127.0.0.1/v1', 'k', true));
        (adapter as any).client = { chat: { completions: { create: jest.fn(async () => stream) } } };

        const chunks: AssistantResponse[] = [];
        let finished = false;
        const consume = (async () => {
            for await (const chunk of adapter.streamComplete(chatContext(), false)) chunks.push(chunk);
            finished = true;
        })();

        await jest.advanceTimersByTimeAsync(IDLE_MS - 1000);
        expect(finished).toBe(false);
        await jest.advanceTimersByTimeAsync(2000);
        await consume;
        expect(chunks.at(-1)?.finish_reason).toBe('error');
        expect(errorMessageOf(chunks)).toContain(`${IDLE_MS}`);
        expect(stream.controller.abort).toHaveBeenCalled();
    });

    test('Anthropic: error after the idle timeout once events have started', async () => {
        setPlatform(
            new ScriptedPlatform(async () => {
                const body = new ReadableStream<Uint8Array>({
                    start(controller) {
                        const event =
                            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n';
                        controller.enqueue(new TextEncoder().encode(event)); // 之后不再发数据，也不关闭
                    }
                });
                return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
            })
        );
        const adapter = new AnthropicAdapter(new ModelInstance('m', 'http://127.0.0.1/v1', 'k', true));

        const chunks: AssistantResponse[] = [];
        const consume = (async () => {
            for await (const chunk of adapter.streamComplete(chatContext(), false)) chunks.push(chunk);
        })();
        await jest.advanceTimersByTimeAsync(IDLE_MS + 1000);
        await consume;
        expect(chunks.at(-1)?.finish_reason).toBe('error');
        expect(errorMessageOf(chunks)).toContain(`${IDLE_MS}`);
    });
});

describe('fetchModelUrl response header timeout', () => {
    beforeEach(() => {
        Setting.clearCache();
        jest.useFakeTimers();
    });
    afterEach(() => {
        Setting.clearCache();
        jest.useRealTimers();
    });

    test('rejects with ModelResponseTimeoutError when headers never arrive', async () => {
        setPlatform(new ScriptedPlatform(neverRespond));
        const pending = fetchModelUrl({ base_url: 'http://127.0.0.1/v1', timeout: 30 }, 'http://127.0.0.1/v1/chat');
        const outcome = pending.then(
            () => 'resolved',
            (error) => error
        );
        await jest.advanceTimersByTimeAsync(30_000 + 10);
        const error = await outcome;
        expect(error).toBeInstanceOf(ModelResponseTimeoutError);
        expect(error.timeoutMs).toBe(30_000);
        // 归类为可重试，走现有的重试逻辑
        expect(classifyModelRequestError(error)).toBe('retryable');
    });

    test('does not abort a response whose headers already arrived', async () => {
        let signal: AbortSignal | undefined;
        setPlatform(
            new ScriptedPlatform(async (init) => {
                signal = init?.signal ?? undefined;
                return new Response('ok', { status: 200 });
            })
        );
        const response = await fetchModelUrl({ base_url: 'http://127.0.0.1/v1', timeout: 1 }, 'http://127.0.0.1/v1/x');
        await jest.advanceTimersByTimeAsync(5_000);
        expect(signal?.aborted).toBe(false);
        await expect(response.text()).resolves.toBe('ok');
    });

    test('the caller signal still cancels the request', async () => {
        setPlatform(new ScriptedPlatform(neverRespond));
        const controller = new AbortController();
        const pending = fetchModelUrl({ base_url: 'http://127.0.0.1/v1' }, 'http://127.0.0.1/v1/chat', {
            signal: controller.signal
        });
        controller.abort(new Error('user stopped the task'));
        await expect(pending).rejects.toThrow('user stopped the task');
    });
});

test('StreamIdleTimeoutError stays retryable', () => {
    expect(classifyModelRequestError(new StreamIdleTimeoutError(IDLE_MS))).toBe('retryable');
});
