import { jest } from '@jest/globals';
import * as http from 'http';
import * as net from 'net';
import { LLM } from '../../../main/aikernel/llm.js';
import { ChatContext, UserMessage } from '../../../main/aikernel/messages.js';
import { fetchVisionSupportFromAPI, resolveModelVisionSupport } from '../../../main/utils/model-context.js';
import { fetchModelUrl } from '../../../main/utils/model-network.js';
import { Setting, isLogRawLlmRequestEnabled, DebugModeSchema } from '../../../main/utils/setting.js';
import { logger } from '../../../main/utils/logger.js';
import { AbstractPlatform, setPlatform, type PlatformFetchOptions } from '../../../platforms/base.js';
import { CliPlatform } from '../../../platforms/cli.js';

const COMMON_PROXY_PORTS = [7890, 7897, 1080, 8080, 10808, 10809];

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

/**
 * 用于验证「无法确认视觉能力时悲观默认 false」的平台：
 * /models 端点返回不带任何视觉能力字段的模型元数据。
 */
class NoVisionPlatform extends AbstractPlatform {
    getName(): string {
        return 'no-vision-test';
    }

    getEffectiveWorkspace(): string {
        return process.cwd();
    }

    async initPlatformHarness(): Promise<void> {}

    async fetch(input: string | URL): Promise<Response> {
        const url = input instanceof URL ? input.href : input;
        if (url.includes('/models')) {
            return jsonResponse({ id: decodeURIComponent(url.split('/').pop() ?? 'unknown-model') });
        }
        return jsonResponse({});
    }
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

function restoreEnv(
    name:
        | 'HTTP_PROXY'
        | 'HTTPS_PROXY'
        | 'http_proxy'
        | 'https_proxy'
        | 'NO_PROXY'
        | 'no_proxy'
        | 'NODE_TLS_REJECT_UNAUTHORIZED',
    value: string | undefined
): void {
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}

function listenServer(server: net.Server, port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
            const address = server.address();
            if (typeof address === 'object' && address !== null) {
                resolve(address.port);
                return;
            }
            reject(new Error('HTTP server did not bind to a TCP port'));
        });
    });
}

async function closeServer(server: net.Server): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.close((error) => {
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        });
    });
}

async function listenOnFirstAvailableProxyProbePort(
    onConnection: (socket: net.Socket) => void
): Promise<{ server: net.Server; port: number }> {
    let lastError: unknown;
    for (const port of COMMON_PROXY_PORTS) {
        const server = net.createServer(onConnection);
        try {
            return { server, port: await listenServer(server, port) };
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError instanceof Error ? lastError : new Error('No common proxy probe port is available for test');
}

describe('model network configuration', () => {
    let originalHttpProxy: string | undefined;
    let originalHttpsProxy: string | undefined;
    let originalLowerHttpProxy: string | undefined;
    let originalLowerHttpsProxy: string | undefined;
    let originalNoProxy: string | undefined;
    let originalLowerNoProxy: string | undefined;
    let originalNodeTlsRejectUnauthorized: string | undefined;

    beforeEach(() => {
        originalHttpProxy = process.env.HTTP_PROXY;
        originalHttpsProxy = process.env.HTTPS_PROXY;
        originalLowerHttpProxy = process.env.http_proxy;
        originalLowerHttpsProxy = process.env.https_proxy;
        originalNoProxy = process.env.NO_PROXY;
        originalLowerNoProxy = process.env.no_proxy;
        originalNodeTlsRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        process.env.NO_PROXY = 'existing.local';
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        Setting.clearCache();
        LLM.clearAdapterCache();
    });

    afterEach(() => {
        restoreEnv('HTTP_PROXY', originalHttpProxy);
        restoreEnv('HTTPS_PROXY', originalHttpsProxy);
        restoreEnv('http_proxy', originalLowerHttpProxy);
        restoreEnv('https_proxy', originalLowerHttpsProxy);
        restoreEnv('NO_PROXY', originalNoProxy);
        restoreEnv('no_proxy', originalLowerNoProxy);
        restoreEnv('NODE_TLS_REJECT_UNAUTHORIZED', originalNodeTlsRejectUnauthorized);
        Setting.clearCache();
        LLM.clearAdapterCache();
        jest.restoreAllMocks();
    });

    test('chat, streaming chat, embedding, rerank, and verification use provider network flags', async () => {
        // rerank 命中每个文档会 console.info 记录分数，该日志路径并非本用例断言对象，静默即可
        const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
        try {
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
        } finally {
            infoSpy.mockRestore();
        }
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

    test('OpenAI-compatible fetch normalizes Request input before localhost bypass decision', async () => {
        const platform = new RecordingPlatform();
        setPlatform(platform);

        const requestUrl = 'http://localhost:3008/test/v1xxx/chat/completions';
        await fetchModelUrl(
            {
                base_url: 'http://localhost:3008/test/v1xxx',
                no_proxy: false,
                no_ssl: false
            },
            new Request(requestUrl),
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ stream: false })
            }
        );

        expect(platform.records).toHaveLength(1);
        expect(platform.records[0].url).toBe(requestUrl);
        expect(platform.records[0].body).toEqual({ stream: false });
        expect(platform.records[0].options).toEqual({
            forceEnvironmentProxy: true,
            bypassProxy: true,
            skipTlsVerification: false
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

    test('resolveModelVisionSupport prefers manual vision config over the builtin table', () => {
        expect(resolveModelVisionSupport({ model_name: 'gpt-4o', vision: false })).toBe(false);
        expect(resolveModelVisionSupport({ model_name: 'gpt-4o', vision: true })).toBe(true);
        expect(resolveModelVisionSupport({ model_name: 'gpt-4o' })).toBe(true);
        expect(resolveModelVisionSupport({ model_name: 'some-unknown-model' })).toBeUndefined();
        expect(resolveModelVisionSupport({ model_name: 'some-unknown-model', vision: true })).toBe(true);
    });

    test('supportsVision uses manually configured vision without querying the API', async () => {
        const platform = new RecordingPlatform();
        setPlatform(platform);
        configureSettings(true, true);

        const data = Setting.getInstance().getData() as any;
        data.models.find((m: any) => m.alias === 'chat').vision = false;
        Setting.updateInstanceData(data);

        const supports = await LLM.supportsVision('chat');

        expect(supports).toBe(false);
        expect(platform.records.filter((record) => record.url.includes('/models'))).toHaveLength(0);
    });

    test('supportsVision returns manual true even when the builtin table disagrees', async () => {
        const platform = new RecordingPlatform();
        setPlatform(platform);
        configureSettings(true, true);

        const data = Setting.getInstance().getData() as any;
        const chat = data.models.find((m: any) => m.alias === 'chat');
        chat.model_name = 'gpt-4';
        chat.vision = true;
        Setting.updateInstanceData(data);

        const supports = await LLM.supportsVision('chat');

        expect(supports).toBe(true);
        expect(platform.records.filter((record) => record.url.includes('/models'))).toHaveLength(0);
    });

    test('supportsVision pessimistically defaults to false when vision cannot be determined', async () => {
        const platform = new NoVisionPlatform();
        setPlatform(platform);
        configureSettings(true, true, 'openai', 'https://model.local/v1', 'some-custom-model-not-in-table');

        const supports = await LLM.supportsVision('chat');

        expect(supports).toBe(false);
    });

    test('CLI OpenAI-compatible localhost model requests do not probe an auto-discovered proxy', async () => {
        const modelHits: string[] = [];
        let proxyConnections = 0;
        const modelServer = http.createServer((req, res) => {
            modelHits.push(`${req.method} ${req.url ?? ''}`);
            let body = '';
            req.on('data', (chunk) => {
                body += chunk;
            });
            req.on('end', () => {
                res.setHeader('content-type', 'application/json');

                if (req.url?.endsWith('/models/gpt-test')) {
                    res.end(
                        JSON.stringify({
                            id: 'gpt-test',
                            capabilities: { vision: true },
                            context_length: 8192
                        })
                    );
                    return;
                }

                if (req.url?.endsWith('/chat/completions')) {
                    const parsed = JSON.parse(body || '{}');
                    if (parsed.stream) {
                        res.writeHead(200, { 'content-type': 'text/event-stream' });
                        res.write('data: {"choices":[{"delta":{"content":"stream-ok"},"finish_reason":null}]}\n\n');
                        res.write(
                            'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n'
                        );
                        res.end('data: [DONE]\n\n');
                        return;
                    }
                }

                res.statusCode = 404;
                res.end(JSON.stringify({ error: 'not found' }));
            });
        });
        const { server: proxyServer } = await listenOnFirstAvailableProxyProbePort((socket) => {
            proxyConnections++;
            socket.end();
        });

        const modelPort = await listenServer(modelServer);

        delete process.env.HTTP_PROXY;
        delete process.env.HTTPS_PROXY;
        delete process.env.http_proxy;
        delete process.env.https_proxy;
        delete process.env.NO_PROXY;
        delete process.env.no_proxy;

        try {
            setPlatform(new CliPlatform());
            configureSettings(false, false, 'openai', `http://localhost:${modelPort}/test/v1xxx`, 'gpt-test');

            const chunks: string[] = [];
            for await (const chunk of LLM.streamComplete(userContext(), 'chat')) {
                chunks.push(...chunk.content.content.map((part: any) => part.text ?? ''));
            }

            expect(chunks.join('')).toBe('stream-ok');
            expect(modelHits).toContain('GET /test/v1xxx/models/gpt-test');
            expect(modelHits).toContain('POST /test/v1xxx/chat/completions');
            expect(proxyConnections).toBe(0);
        } finally {
            await closeServer(modelServer);
            await closeServer(proxyServer);
        }
    });
});

describe('DebugModeSchema log_raw_llm_request field', () => {
    test('schema includes log_raw_llm_request with default false', () => {
        const parsed = DebugModeSchema.parse({});
        expect(parsed.log_raw_llm_request).toBe(false);
    });

    test('schema accepts log_raw_llm_request true', () => {
        const parsed = DebugModeSchema.parse({ log_raw_llm_request: true });
        expect(parsed.log_raw_llm_request).toBe(true);
    });

    test('setting default debug config includes log_raw_llm_request false', () => {
        const data = new Setting().getData();
        expect(data.debug.log_raw_llm_request).toBe(false);
    });
});

describe('isLogRawLlmRequestEnabled', () => {
    beforeEach(() => {
        Setting.clearCache();
        Setting.updateInstanceData({});
    });

    afterEach(() => {
        Setting.clearCache();
    });

    test('returns false by default', () => {
        expect(isLogRawLlmRequestEnabled()).toBe(false);
    });

    test('returns true when setting is enabled', () => {
        Setting.updateInstanceData({
            default_model: '',
            debug: {
                developer_mode: false,
                experimental_features: {
                    applications: { appmgr: false, agentoffice: false },
                    account: false
                },
                log_raw_llm_request: true
            }
        });
        expect(isLogRawLlmRequestEnabled()).toBe(true);
    });
});

describe('fetchModelUrl raw LLM logging', () => {
    let loggerInfoSpy: jest.SpyInstance;

    beforeEach(() => {
        Setting.clearCache();
        Setting.updateInstanceData({});
        LLM.clearAdapterCache();
        setPlatform(new RecordingPlatform());
        loggerInfoSpy = jest.spyOn(logger, 'info');
        loggerInfoSpy.mockImplementation(() => undefined as never);
    });

    afterEach(() => {
        Setting.clearCache();
        LLM.clearAdapterCache();
        jest.restoreAllMocks();
    });

    function enableRawLlmLogging(): void {
        const data = Setting.getInstance().getData();
        Setting.updateInstanceData({
            ...data,
            debug: { ...data.debug, log_raw_llm_request: true }
        });
    }

    function getRawLlmLogs(): string[] {
        return loggerInfoSpy.mock.calls
            .map((call: any[]) => call[0])
            .filter((msg: unknown): msg is string => typeof msg === 'string' && msg.includes('[LLM Raw'));
    }

    test('does not log when log_raw_llm_request is false (default)', async () => {
        const requestBody = { model: 'gpt-4o', messages: [] };
        const response = await fetchModelUrl(
            { base_url: 'https://model.local/v1', no_proxy: false, no_ssl: false },
            'https://model.local/v1/chat/completions',
            { method: 'POST', body: JSON.stringify(requestBody) }
        );
        await response.text();

        expect(getRawLlmLogs()).toHaveLength(0);
    });

    test('always logs LLM Request marker regardless of raw logging setting', async () => {
        const requestBody = { model: 'gpt-4o', messages: [] };
        const response = await fetchModelUrl(
            { base_url: 'https://model.local/v1', no_proxy: false, no_ssl: false },
            'https://model.local/v1/chat/completions',
            { method: 'POST', body: JSON.stringify(requestBody) }
        );
        await response.text();

        const requestMarkers = loggerInfoSpy.mock.calls
            .map((call: any[]) => call[0])
            .filter((msg: unknown): msg is string => typeof msg === 'string' && msg.startsWith('[LLM Request]'));
        expect(requestMarkers).toHaveLength(1);
        expect(requestMarkers[0]).toContain('POST');
        expect(requestMarkers[0]).toContain('/chat/completions');
    });

    test('logs non-streaming response body when log_raw_llm_request is true', async () => {
        enableRawLlmLogging();

        const response = await fetchModelUrl(
            { base_url: 'https://model.local/v1', no_proxy: false, no_ssl: false },
            'https://model.local/v1/chat/completions',
            { method: 'POST', body: JSON.stringify({ model: 'gpt-4o', messages: [] }) }
        );
        await response.text();

        const responseLogs = getRawLlmLogs().filter((msg) => msg.includes('[LLM Raw Response]'));
        expect(responseLogs.length).toBeGreaterThanOrEqual(1);
        const loggedText = responseLogs.join('');
        expect(loggedText).toContain('"choices"');
    });

    test('does not log embedding response bodies when raw logging is enabled', async () => {
        configureSettings(false, false);
        enableRawLlmLogging();

        expect(await LLM.embed('hello')).toEqual([0.1, 0.2, 0.3]);
        expect(await LLM.batchEmbed(['hello', 'world'], 1)).toHaveLength(2);
        await LLM.verifyEmbeddingModel(Setting.getInstance().getModelInstance('embedding', 'embedding')!);

        expect(getRawLlmLogs().filter((msg) => msg.includes('[LLM Raw Response]'))).toHaveLength(0);
    });

    test('logs streaming response chunks when log_raw_llm_request is true', async () => {
        enableRawLlmLogging();

        const response = await fetchModelUrl(
            { base_url: 'https://model.local/v1', no_proxy: false, no_ssl: false },
            'https://model.local/v1/chat/completions',
            { method: 'POST', body: JSON.stringify({ model: 'gpt-4o', messages: [], stream: true }) }
        );

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        const chunks: string[] = [];
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(decoder.decode(value, { stream: true }));
        }

        const responseLogs = getRawLlmLogs().filter((msg) => msg.includes('[LLM Raw Response]'));
        expect(responseLogs.length).toBeGreaterThanOrEqual(1);
        const loggedText = responseLogs.join('');
        expect(loggedText).toContain('data:');
    });

    test('streaming response body is fully consumable when logging is enabled', async () => {
        enableRawLlmLogging();

        const response = await fetchModelUrl(
            { base_url: 'https://model.local/v1', no_proxy: false, no_ssl: false },
            'https://model.local/v1/chat/completions',
            { method: 'POST', body: JSON.stringify({ model: 'gpt-4o', messages: [], stream: true }) }
        );

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let fullText = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            fullText += decoder.decode(value, { stream: true });
        }

        expect(fullText).toContain('streamed');
        expect(fullText).toContain('[DONE]');
    });

    test('non-streaming response body is fully consumable when logging is enabled', async () => {
        enableRawLlmLogging();

        const response = await fetchModelUrl(
            { base_url: 'https://model.local/v1', no_proxy: false, no_ssl: false },
            'https://model.local/v1/chat/completions',
            { method: 'POST', body: JSON.stringify({ model: 'gpt-4o', messages: [] }) }
        );
        const text = await response.text();
        const parsed = JSON.parse(text);

        expect(parsed.choices).toBeDefined();
        expect(parsed.choices[0].message.content).toBe('{"ok":true}');
    });

    test('does not log request when body is not a string', async () => {
        enableRawLlmLogging();

        const response = await fetchModelUrl(
            { base_url: 'https://model.local/v1', no_proxy: false, no_ssl: false },
            'https://model.local/v1/chat/completions',
            { method: 'POST', body: new Uint8Array([1, 2, 3]) }
        );
        await response.text();

        const requestLogs = getRawLlmLogs().filter((msg) => msg.includes('[LLM Raw Request]'));
        expect(requestLogs).toHaveLength(0);
    });
});
