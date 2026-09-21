import { extractErrorMessage } from '../../../main/aikernel/adapters/http-error.js';
import { OpenAIAdapter } from '../../../main/aikernel/adapters/openai.js';
import { AnthropicAdapter } from '../../../main/aikernel/adapters/anthropic.js';
import { AssistantResponse, ChatContext, ErrorMessagePart, UserMessage } from '../../../main/aikernel/messages.js';
import { ModelInstance } from '../../../main/utils/setting.js';
import { AbstractPlatform, setPlatform } from '../../../platforms/base.js';

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
});
