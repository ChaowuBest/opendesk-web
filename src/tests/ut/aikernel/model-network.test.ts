import { jest } from '@jest/globals';
import { LLM } from '../../../main/aikernel/llm.js';
import { ChatContext, UserMessage } from '../../../main/aikernel/messages.js';
import { fetchVisionSupportFromAPI } from '../../../main/utils/model-context.js';
import { Setting } from '../../../main/utils/setting.js';
import { AbstractPlatform, setPlatform, type PlatformFetchOptions } from '../../../platforms/base.js';

type FetchRecord = {
    url: string;
    body: any;
    options?: PlatformFetchOptions;
};

class RecordingPlatform extends AbstractPlatform {
    readonly records: FetchRecord[] = [];

    getName(): string {
        return 'test';
    }

    getEffectiveWorkspace(): string {
        return process.cwd();
    }

    async initPlatformHarness(): Promise<void> {}

    async fetch(input: string | URL, init?: RequestInit, options?: PlatformFetchOptions): Promise<Response> {
        const url = input instanceof URL ? input.href : input;
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        this.records.push({ url, body, options });

        if (url.includes('/models/')) {
            return jsonResponse({
                id: decodeURIComponent(url.split('/models/')[1] ?? 'mock-model'),
                capabilities: { vision: true },
                context_length: 8192
            });
        }

        if (url.endsWith('/models')) {
            return jsonResponse({
                data: [{ id: 'mock-unknown-vision', capabilities: { vision: true }, context_length: 8192 }]
            });
        }

        if (url.endsWith('/embeddings')) {
            const inputs = Array.isArray(body.input) ? body.input : [body.input];
            return jsonResponse({
                data: inputs.map((_input: string, index: number) => ({
                    index,
                    embedding: [index + 0.1, index + 0.2, index + 0.3]
                }))
            });
        }

        if (url.endsWith('/rerank')) {
            return jsonResponse({
                results: body.documents.map((_document: string, index: number) => ({
                    index,
                    relevance_score: 1
                }))
            });
        }

        if (url.endsWith('/messages')) {
            if (body?.stream) {
                return streamResponse([
                    {
                        type: 'content_block_delta',
                        delta: { type: 'text_delta', text: 'anthropic-streamed' }
                    },
                    {
                        type: 'message_delta',
                        delta: { stop_reason: 'end_turn' },
                        usage: { input_tokens: 1, output_tokens: 1 }
                    }
                ]);
            }

            return jsonResponse({
                content: [{ type: 'text', text: 'anthropic-complete' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 1, output_tokens: 1 }
            });
        }

        if (body?.stream) {
            return streamResponse([
                { choices: [{ delta: { content: 'streamed' }, finish_reason: null }] },
                { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
            ]);
        }

        return jsonResponse({
            choices: [{ message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }]
        });
    }
}

function jsonResponse(body: object): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
    });
}

function streamResponse(chunks: object[]): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
        }
    });
    return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
    });
}

function configureSettings(
    noProxy: boolean,
    noSSL: boolean,
    providerType: 'openai' | 'anthropic' = 'openai',
    baseUrl = 'https://model.local/v1',
    chatModelName = 'gpt-4o'
): void {
    Setting.updateInstanceData({
        default_model: 'chat',
        default_embedding_model: 'embedding',
        default_reranker_model: 'rerank',
        providers: [
            {
                name: 'mock-provider',
                provider_type: providerType,
                base_url: baseUrl,
                api_key: 'test-key',
                no_proxy: noProxy,
                no_ssl: noSSL
            }
        ],
        models: [
            {
                alias: 'chat',
                provider_name: 'mock-provider',
                model_name: chatModelName,
                model_type: 'chat',
                reasoning_effort: ''
            },
            {
                alias: 'embedding',
                provider_name: 'mock-provider',
                model_name: 'text-embedding-3-small',
                model_type: 'embedding'
            },
            {
                alias: 'rerank',
                provider_name: 'mock-provider',
                model_name: 'mock-rerank',
                model_type: 'chat',
                reasoning_effort: ''
            }
        ]
    });
}

function userContext(): ChatContext {
    const context = new ChatContext();
    context.appendMessage(new UserMessage('hello'));
    return context;
}

function restoreEnv(name: 'NO_PROXY' | 'NODE_TLS_REJECT_UNAUTHORIZED', value: string | undefined): void {
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}

describe('model network configuration', () => {
    let originalNoProxy: string | undefined;
    let originalNodeTlsRejectUnauthorized: string | undefined;

    beforeEach(() => {
        originalNoProxy = process.env.NO_PROXY;
        originalNodeTlsRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        process.env.NO_PROXY = 'existing.local';
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        Setting.clearCache();
        LLM.clearAdapterCache();
    });

    afterEach(() => {
        restoreEnv('NO_PROXY', originalNoProxy);
        restoreEnv('NODE_TLS_REJECT_UNAUTHORIZED', originalNodeTlsRejectUnauthorized);
        Setting.clearCache();
        LLM.clearAdapterCache();
        jest.restoreAllMocks();
    });

    test('chat, streaming chat, embedding, rerank, and verification use provider network flags', async () => {
        const platform = new RecordingPlatform();
        setPlatform(platform);
        configureSettings(true, true);

        await LLM.ask('hello', 'chat');
        await LLM.askForObject(new UserMessage('json'), 'chat');
        await LLM.complete(userContext(), 'chat');
        for await (const _chunk of LLM.streamComplete(userContext(), 'chat')) {
            // Drain stream.
        }
        await LLM.embed('query');
        await LLM.batchEmbed(['a', 'b'], 1);
        await LLM.rerank('query', [{ text: 'a' }, { text: 'b' }], (item) => item.text, 'rerank');
        await LLM.verifyModel(Setting.getInstance().getModelInstance('chat', 'chat')!);
        await LLM.verifyEmbeddingModel(Setting.getInstance().getModelInstance('embedding', 'embedding')!);

        expect(platform.records.length).toBeGreaterThanOrEqual(9);
        for (const record of platform.records) {
            expect(record.options).toEqual({
                forceEnvironmentProxy: true,
                bypassProxy: true,
                skipTlsVerification: true
            });
        }
        expect(process.env.NO_PROXY).toBe('existing.local');
        expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe('0');
    });

    test('adapter cache separates otherwise-identical providers with different network flags', async () => {
        const platform = new RecordingPlatform();
        setPlatform(platform);

        configureSettings(false, false);
        await LLM.ask('first', 'chat');

        configureSettings(true, true);
        await LLM.ask('second', 'chat');

        expect(platform.records).toHaveLength(2);
        expect(platform.records[0].options).toEqual({
            forceEnvironmentProxy: true,
            bypassProxy: false,
            skipTlsVerification: false
        });
        expect(platform.records[1].options).toEqual({
            forceEnvironmentProxy: true,
            bypassProxy: true,
            skipTlsVerification: true
        });
    });

    test('anthropic non-streaming and streaming chat use provider network flags', async () => {
        const platform = new RecordingPlatform();
        setPlatform(platform);
        configureSettings(true, true, 'anthropic', 'https://anthropic.local', 'claude-3-5-sonnet');

        await LLM.complete(userContext(), 'chat');
        for await (const _chunk of LLM.streamComplete(userContext(), 'chat')) {
            // Drain stream.
        }

        const messageRecords = platform.records.filter((record) => record.url.endsWith('/v1/messages'));
        expect(messageRecords).toHaveLength(2);
        expect(messageRecords[0].body.stream).toBeUndefined();
        expect(messageRecords[1].body.stream).toBe(true);
        for (const record of messageRecords) {
            expect(record.options).toEqual({
                forceEnvironmentProxy: true,
                bypassProxy: true,
                skipTlsVerification: true
            });
        }
        expect(process.env.NO_PROXY).toBe('existing.local');
        expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe('0');
    });

    test('model metadata API uses the same network flags as model completions', async () => {
        const platform = new RecordingPlatform();
        setPlatform(platform);

        const supportsVision = await fetchVisionSupportFromAPI({
            base_url: 'https://metadata.local/v1',
            api_key: 'test-key',
            model_name: 'mock-unknown-vision',
            no_proxy: true,
            no_ssl: true
        });

        expect(supportsVision).toBe(true);
        expect(platform.records).toHaveLength(1);
        expect(platform.records[0].url).toBe('https://metadata.local/v1/models/mock-unknown-vision');
        expect(platform.records[0].options).toEqual({
            forceEnvironmentProxy: true,
            bypassProxy: true,
            skipTlsVerification: true
        });
        expect(process.env.NO_PROXY).toBe('existing.local');
    });
});
