import { extractErrorMessage } from '../../../main/aikernel/adapters/http-error.js';
import { OpenAIAdapter } from '../../../main/aikernel/adapters/openai.js';
import { AnthropicAdapter } from '../../../main/aikernel/adapters/anthropic.js';
import { AssistantResponse, ChatContext, ErrorMessagePart, UserMessage } from '../../../main/aikernel/messages.js';
import { ModelInstance } from '../../../main/utils/setting.js';
import { AbstractPlatform, setPlatform } from '../../../platforms/base.js';
import { ModelRequestError, classifyModelRequestError } from '../../../main/utils/model-request-error.js';

const HTML_PAGE = '<!DOCTYPE html><html><head><title>403 Forbidden</title></head><body><p>blocked</p></body></html>';
const FLAT_JSON = JSON.stringify({ code: 'Proxy_UploadNotAllowed', message: 'blocked by a gateway or proxy' });

describe('extractErrorMessage', () => {
    const cases = [
        {
            name: '401 的 HTML 拦截页 → 网关拦截提示',
            status: 401,
            statusText: 'Unauthorized',
            body: HTML_PAGE,
            expected:
                'request was blocked by a gateway or proxy. Your API key may be missing or expired — check the provider settings.'
        },
        {
            name: '403 的 HTML 拦截页 → 网关拦截提示',
            status: 403,
            statusText: 'Forbidden',
            body: HTML_PAGE,
            expected:
                'request was blocked by a gateway or proxy. You may not have permission to access this resource — check your account and provider settings.'
        },
        {
            name: '其它状态码的 HTML 页面成因不明，按原文返回',
            status: 502,
            statusText: 'Bad Gateway',
            body: HTML_PAGE,
            expected: HTML_PAGE
        },
        {
            name: 'OpenAI 信封取 error.message',
            status: 401,
            statusText: 'Unauthorized',
            body: JSON.stringify({ error: { message: 'invalid api key' } }),
            expected: 'invalid api key'
        },
        {
            name: '平铺 body 取 message',
            status: 403,
            statusText: 'Forbidden',
            body: FLAT_JSON,
            expected: 'blocked by a gateway or proxy'
        },
        {
            name: '纯文本原样返回',
            status: 403,
            statusText: 'Forbidden',
            body: 'Request blocked by corporate proxy',
            expected: 'Request blocked by corporate proxy'
        },
        {
            name: '空正文回退到 statusText',
            status: 403,
            statusText: 'Forbidden',
            body: '',
            expected: 'Forbidden'
        }
    ];

    test.each(cases)('$name', ({ status, statusText, body, expected }) => {
        expect(extractErrorMessage(status, statusText, body)).toBe(expected);
    });
});

/* ------------------------------------------------------------------ */
/* 适配器接线：错误 body 规范化是否真的生效                              */
/* ------------------------------------------------------------------ */

class ErrorResponsePlatform extends AbstractPlatform {
    requestCount = 0;

    constructor(
        private readonly status: number,
        private readonly contentType: string,
        private readonly body: string,
        private readonly statusText: string = 'Forbidden'
    ) {
        super();
    }

    getName(): string {
        return 'test';
    }

    getEffectiveWorkspace(): string {
        return process.cwd();
    }

    async initPlatformHarness(): Promise<void> {}

    async fetch(): Promise<Response> {
        this.requestCount++;
        return new Response(this.body, {
            status: this.status,
            statusText: this.statusText,
            headers: { 'content-type': this.contentType }
        });
    }
}

function createChatContext(): ChatContext {
    const chatContext = new ChatContext();
    chatContext.appendMessage(new UserMessage('hello'));
    return chatContext;
}

function createModelInstance(): ModelInstance {
    return new ModelInstance('demo-model', 'http://127.0.0.1/v1', 'test-key', true);
}

async function firstErrorMessage(chunks: AsyncIterable<AssistantResponse>): Promise<string> {
    for await (const chunk of chunks) {
        const errorPart = chunk.content.content.find((p): p is ErrorMessagePart => p.type === 'error');
        if (errorPart) return errorPart.message;
    }
    return '';
}

async function firstErrorResponse(chunks: AsyncIterable<AssistantResponse>): Promise<AssistantResponse | undefined> {
    for await (const chunk of chunks) {
        if (chunk.finish_reason === 'error') return chunk;
    }
    return undefined;
}

describe('适配器错误文案', () => {
    test('OpenAI 适配器不再把平铺 {code, message} 丢成 status code (no body)', async () => {
        setPlatform(new ErrorResponsePlatform(403, 'application/json', FLAT_JSON));
        const adapter = new OpenAIAdapter(createModelInstance());

        const message = await firstErrorMessage(adapter.streamComplete(createChatContext(), false));

        expect(message).toContain('blocked by a gateway or proxy');
        expect(message).not.toContain('status code (no body)');
    });

    test('OpenAI 适配器把 403 的 HTML 拦截页翻译成提示', async () => {
        setPlatform(new ErrorResponsePlatform(403, 'text/html; charset=utf-8', HTML_PAGE));
        const adapter = new OpenAIAdapter(createModelInstance());

        const message = await firstErrorMessage(adapter.streamComplete(createChatContext(), false));

        expect(message).toContain('request was blocked by a gateway or proxy');
        expect(message).not.toContain('<!DOCTYPE');
    });

    test('其它状态码的 HTML 页面保留原文，且状态码可见', async () => {
        setPlatform(new ErrorResponsePlatform(502, 'text/html; charset=utf-8', HTML_PAGE, 'Bad Gateway'));
        const adapter = new OpenAIAdapter(createModelInstance());

        const message = await firstErrorMessage(adapter.streamComplete(createChatContext(), false));

        expect(message).toContain('502');
        expect(message).toContain('<!DOCTYPE');
    });

    test('Anthropic 适配器保留平铺 {code, message} 的 message', async () => {
        setPlatform(new ErrorResponsePlatform(403, 'application/json', FLAT_JSON));
        const adapter = new AnthropicAdapter(createModelInstance());

        const message = await firstErrorMessage(adapter.streamComplete(createChatContext(), false));

        expect(message).toContain('blocked by a gateway or proxy');
    });

    test('Anthropic 适配器把 403 的 HTML 拦截页翻译成提示', async () => {
        setPlatform(new ErrorResponsePlatform(403, 'text/html; charset=utf-8', HTML_PAGE));
        const adapter = new AnthropicAdapter(createModelInstance());

        const message = await firstErrorMessage(adapter.streamComplete(createChatContext(), false));

        expect(message).toContain('request was blocked by a gateway or proxy');
        expect(message).not.toContain('<!DOCTYPE');
    });

    test('OpenAI 适配器保留永久性 429 的结构化字段且阻止 SDK 内置重试', async () => {
        const platform = new ErrorResponsePlatform(
            429,
            'application/json',
            JSON.stringify({
                error: {
                    type: 'insufficient_quota',
                    code: 'credit_balance_exhausted',
                    param: 'billing',
                    message: 'credit balance exhausted'
                }
            }),
            'Too Many Requests'
        );
        setPlatform(platform);
        const adapter = new OpenAIAdapter(createModelInstance());

        const response = await firstErrorResponse(adapter.streamComplete(createChatContext(), false));

        expect(platform.requestCount).toBe(1);
        expect(response?.request_error).toBeInstanceOf(ModelRequestError);
        expect((response?.request_error as ModelRequestError).metadata).toMatchObject({
            provider: 'openai',
            status: 429,
            type: 'insufficient_quota',
            code: 'credit_balance_exhausted',
            param: 'billing'
        });
        expect(classifyModelRequestError(response?.request_error)).toBe('non_retryable');
    });

    test('Anthropic 适配器保留消费上限 details 和 request_id', async () => {
        setPlatform(
            new ErrorResponsePlatform(
                429,
                'application/json',
                JSON.stringify({
                    type: 'error',
                    error: {
                        type: 'rate_limit_error',
                        message: 'You have reached your API usage limits',
                        details: { error_code: 'enforced_spend_limit_reached' }
                    },
                    request_id: 'req_spend_cap'
                }),
                'Too Many Requests'
            )
        );
        const adapter = new AnthropicAdapter(createModelInstance());

        const response = await firstErrorResponse(adapter.streamComplete(createChatContext(), false));

        expect(response?.request_error).toBeInstanceOf(ModelRequestError);
        expect((response?.request_error as ModelRequestError).metadata).toMatchObject({
            provider: 'anthropic',
            status: 429,
            type: 'rate_limit_error',
            detailsCode: 'enforced_spend_limit_reached',
            requestId: 'req_spend_cap'
        });
        expect(classifyModelRequestError(response?.request_error)).toBe('non_retryable');
    });
});
