import { jest } from '@jest/globals';
import {
    withStreamIdleTimeout,
    readWithIdleTimeout,
    StreamIdleTimeoutError,
    STREAM_IDLE_TIMEOUT_MS
} from '../../../main/utils/stream-timeout.js';
import { OpenAIAdapter } from '../../../main/aikernel/adapters/openai.js';
import { AnthropicAdapter } from '../../../main/aikernel/adapters/anthropic.js';
import { AssistantResponse, ChatContext, ErrorMessagePart, UserMessage } from '../../../main/aikernel/messages.js';
import { ModelInstance, Setting } from '../../../main/utils/setting.js';
import { AbstractPlatform, setPlatform, type PlatformFetchOptions } from '../../../platforms/base.js';
import { setRuntimeLocale } from '../../../locale/index.js';

beforeEach(() => {
    setRuntimeLocale('en-US');
});

afterEach(() => {
    setRuntimeLocale(null);
});

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function createChatContext(): ChatContext {
    const chatContext = new ChatContext();
    chatContext.appendMessage(new UserMessage('hello'));
    return chatContext;
}

/* ------------------------------------------------------------------ */
/* Utility function tests (real timers, short timeouts)                */
/* ------------------------------------------------------------------ */

describe('withStreamIdleTimeout', () => {
    test('passes through values when they arrive in time', async () => {
        async function* source() {
            yield 1;
            yield 2;
            yield 3;
        }

        const results: number[] = [];
        for await (const value of withStreamIdleTimeout(source(), 5000)) {
            results.push(value);
        }
        expect(results).toEqual([1, 2, 3]);
    });

    test('throws StreamIdleTimeoutError on first-token hang', async () => {
        async function* hangingSource() {
            await new Promise<never>(() => {});
            yield 'unreachable';
        }

        const cancel = jest.fn();
        const iter = withStreamIdleTimeout(hangingSource(), 50, cancel);
        await expect(iter.next()).rejects.toBeInstanceOf(StreamIdleTimeoutError);
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    test('throws StreamIdleTimeoutError on mid-stream hang', async () => {
        async function* hangingMidStream() {
            yield 'first';
            await new Promise<never>(() => {});
        }

        const iter = withStreamIdleTimeout(hangingMidStream(), 50);
        const first = await iter.next();
        expect(first.value).toBe('first');
        await expect(iter.next()).rejects.toBeInstanceOf(StreamIdleTimeoutError);
    });

    test('resets timeout on each value', async () => {
        async function* slowSource() {
            yield 'a';
            await delay(30);
            yield 'b';
            await delay(30);
            yield 'c';
        }

        const results: string[] = [];
        for await (const value of withStreamIdleTimeout(slowSource(), 80)) {
            results.push(value);
        }
        expect(results).toEqual(['a', 'b', 'c']);
    });

    test('closes the underlying iterator when consumption stops early', async () => {
        let returnCalls = 0;
        const source: AsyncIterable<number> = {
            [Symbol.asyncIterator]() {
                return {
                    next: async () => ({ done: false, value: 1 }),
                    return: async () => {
                        returnCalls++;
                        return { done: true, value: undefined };
                    }
                };
            }
        };

        for await (const _value of withStreamIdleTimeout(source, 5000)) {
            break;
        }

        expect(returnCalls).toBe(1);
    });

    test('preserves iterator errors when return() completes synchronously', async () => {
        const sourceError = new Error('source failed');
        const source = {
            [Symbol.asyncIterator]() {
                return {
                    next: () => Promise.reject(sourceError),
                    return: () => ({ done: true, value: undefined })
                };
            }
        } as AsyncIterable<number>;

        const iterator = withStreamIdleTimeout(source, 5000)[Symbol.asyncIterator]();
        await expect(iterator.next()).rejects.toBe(sourceError);
    });
});

describe('readWithIdleTimeout', () => {
    test('passes through data when available', async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode('hello'));
                controller.close();
            }
        });
        const reader = stream.getReader();

        const result = await readWithIdleTimeout(reader, 5000);
        expect(result.done).toBe(false);
        expect(new TextDecoder().decode(result.value)).toBe('hello');
    });

    test('throws StreamIdleTimeoutError when reader never produces data', async () => {
        const stream = new ReadableStream({
            start() {
                // Never enqueue or close
            }
        });
        const reader = stream.getReader();

        await expect(readWithIdleTimeout(reader, 50)).rejects.toBeInstanceOf(StreamIdleTimeoutError);
    });

    test('calls reader.cancel() on timeout', async () => {
        let cancelled = false;
        const stream = new ReadableStream({
            start() {},
            cancel() {
                cancelled = true;
            }
        });
        const reader = stream.getReader();

        await expect(readWithIdleTimeout(reader, 50)).rejects.toBeInstanceOf(StreamIdleTimeoutError);
        await delay(10);
        expect(cancelled).toBe(true);
    });
});

/* ------------------------------------------------------------------ */
/* OpenAI adapter integration test (fake timers, default 60s timeout)  */
/* ------------------------------------------------------------------ */

function createHangingAsyncIterable(): AsyncIterable<any> {
    return {
        [Symbol.asyncIterator]() {
            return {
                next: () => new Promise<IteratorResult<any>>(() => {}),
                return: () => Promise.resolve({ done: true, value: undefined as any })
            };
        }
    };
}

function createOpenAIAdapterWithStream(stream: unknown): OpenAIAdapter {
    const adapter = new OpenAIAdapter(new ModelInstance('demo-model', 'http://127.0.0.1/v1', 'test-key', true));
    (adapter as any).client = {
        chat: {
            completions: {
                create: jest.fn(async () => stream)
            }
        }
    };
    return adapter;
}

describe('OpenAI adapter stream idle timeout', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('yields richError when stream hangs (first-token hang)', async () => {
        const adapter = createOpenAIAdapterWithStream(createHangingAsyncIterable());

        const chunks: AssistantResponse[] = [];
        const consumePromise = (async () => {
            for await (const chunk of adapter.streamComplete(createChatContext(), false)) {
                chunks.push(chunk);
            }
        })();

        await jest.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1000);
        await consumePromise;

        expect(chunks).toHaveLength(1);
        expect(chunks[0].finish_reason).toBe('error');
        const errorPart = chunks[0].content.content.find((p): p is ErrorMessagePart => p.type === 'error');
        expect(errorPart).toBeDefined();
        expect(errorPart!.message).toBe(
            `Model stream idle timeout: no data was received for ${STREAM_IDLE_TIMEOUT_MS} ms`
        );
    });
});

/* ------------------------------------------------------------------ */
/* Anthropic adapter integration test (fake timers, default 60s timeout) */
/* ------------------------------------------------------------------ */

class HangingStreamPlatform extends AbstractPlatform {
    getName(): string {
        return 'test';
    }

    getEffectiveWorkspace(): string {
        return process.cwd();
    }

    async initPlatformHarness(): Promise<void> {}

    async fetch(_input: string | URL, _init?: RequestInit, _options?: PlatformFetchOptions): Promise<Response> {
        const body = new ReadableStream<Uint8Array>({
            start() {
                // Never enqueue or close — simulates a hung API response
            }
        });
        return new Response(body, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' }
        });
    }
}

describe('Anthropic adapter stream idle timeout', () => {
    beforeEach(() => {
        Setting.clearCache();
        setPlatform(new HangingStreamPlatform());
        jest.useFakeTimers();
    });

    afterEach(() => {
        Setting.clearCache();
        jest.useRealTimers();
    });

    test('yields richError when stream hangs (first-token hang)', async () => {
        const adapter = new AnthropicAdapter(new ModelInstance('demo-model', 'http://127.0.0.1/v1', 'test-key', true));

        const chunks: AssistantResponse[] = [];
        const consumePromise = (async () => {
            for await (const chunk of adapter.streamComplete(createChatContext(), false)) {
                chunks.push(chunk);
            }
        })();

        await jest.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1000);
        await consumePromise;

        expect(chunks).toHaveLength(1);
        expect(chunks[0].finish_reason).toBe('error');
        const errorPart = chunks[0].content.content.find((p): p is ErrorMessagePart => p.type === 'error');
        expect(errorPart).toBeDefined();
        expect(errorPart!.message).toBe(
            `Model stream idle timeout: no data was received for ${STREAM_IDLE_TIMEOUT_MS} ms`
        );
    });
});

/* ------------------------------------------------------------------ */
/* Per-model timeout configuration                                     */
/* ------------------------------------------------------------------ */

function createModelInstanceWithTimeout(timeout?: number): ModelInstance {
    return new ModelInstance(
        'demo-model',
        'http://127.0.0.1/v1',
        'test-key',
        true,
        false,
        '',
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        'openai',
        'chat',
        'demo-provider',
        timeout
    );
}

describe('ModelInstance timeout', () => {
    test('falls back to the default timeout when unset or non-positive', () => {
        expect(createModelInstanceWithTimeout(undefined).getTimeoutMs()).toBe(STREAM_IDLE_TIMEOUT_MS);
        expect(createModelInstanceWithTimeout(0).getTimeoutMs()).toBe(STREAM_IDLE_TIMEOUT_MS);
        expect(createModelInstanceWithTimeout(0).timeout).toBeUndefined();
    });

    test('converts the configured seconds into milliseconds', () => {
        expect(createModelInstanceWithTimeout(15).getTimeoutMs()).toBe(15_000);
    });
});

describe('adapters honour the per-model timeout', () => {
    beforeEach(() => {
        Setting.clearCache();
        jest.useFakeTimers();
    });

    afterEach(() => {
        Setting.clearCache();
        jest.useRealTimers();
    });

    test('OpenAI adapter times out at the configured timeout instead of the default', async () => {
        const adapter = new OpenAIAdapter(createModelInstanceWithTimeout(5));
        (adapter as any).client = {
            chat: { completions: { create: jest.fn(async () => createHangingAsyncIterable()) } }
        };

        const chunks: AssistantResponse[] = [];
        const consumePromise = (async () => {
            for await (const chunk of adapter.streamComplete(createChatContext(), false)) {
                chunks.push(chunk);
            }
        })();

        await jest.advanceTimersByTimeAsync(6_000);
        await consumePromise;

        const errorPart = chunks[0]?.content.content.find((p): p is ErrorMessagePart => p.type === 'error');
        expect(errorPart?.message).toBe('Model stream idle timeout: no data was received for 5000 ms');
    });

    test('Anthropic adapter times out at the configured timeout instead of the default', async () => {
        setPlatform(new HangingStreamPlatform());
        const adapter = new AnthropicAdapter(createModelInstanceWithTimeout(5));

        const chunks: AssistantResponse[] = [];
        const consumePromise = (async () => {
            for await (const chunk of adapter.streamComplete(createChatContext(), false)) {
                chunks.push(chunk);
            }
        })();

        await jest.advanceTimersByTimeAsync(6_000);
        await consumePromise;

        const errorPart = chunks[0]?.content.content.find((p): p is ErrorMessagePart => p.type === 'error');
        expect(errorPart?.message).toBe('Model stream idle timeout: no data was received for 5000 ms');
    });
});
