import {
    ModelRequestError,
    classifyModelRequestError,
    isNetworkConnectionError,
    isModelServiceResponseError,
    normalizeModelRequestError,
    parseModelErrorResponse
} from '../../../main/utils/model-request-error.js';
import { RateLimitDetector } from '../../../main/utils/rate-limit-retry.js';

describe('model request error classification', () => {
    test.each([
        { status: 408, expected: 'retryable' },
        { status: 409, expected: 'retryable' },
        { status: 500, expected: 'retryable' },
        { status: 503, expected: 'retryable' },
        { status: 529, expected: 'retryable' },
        { status: 400, expected: 'non_retryable' },
        { status: 401, expected: 'non_retryable' },
        { status: 402, expected: 'non_retryable' },
        { status: 403, expected: 'non_retryable' },
        { status: 404, expected: 'non_retryable' },
        { status: 413, expected: 'non_retryable' },
        { status: 415, expected: 'non_retryable' },
        { status: 422, expected: 'non_retryable' }
    ])('classifies HTTP $status as $expected', ({ status, expected }) => {
        expect(classifyModelRequestError(new ModelRequestError({ message: 'failed', status }))).toBe(expected);
    });

    test('distinguishes OpenAI rate limiting from exhausted credit although both use 429', () => {
        const transient = new ModelRequestError({
            provider: 'openai',
            message: 'slow down',
            status: 429,
            type: 'rate_limit_error',
            code: 'slow_down'
        });
        const exhausted = new ModelRequestError({
            provider: 'openai',
            message: 'credit balance exhausted',
            status: 429,
            type: 'insufficient_quota',
            code: 'credit_balance_exhausted'
        });

        expect(classifyModelRequestError(transient)).toBe('retryable');
        expect(classifyModelRequestError(exhausted)).toBe('non_retryable');
    });

    test('lets a known transient code override a generic invalid request type', () => {
        const error = new ModelRequestError({
            provider: 'openai',
            message: 'rate limit exceeded',
            status: 429,
            type: 'invalid_request_error',
            code: 'rate_limit_exceeded'
        });

        expect(classifyModelRequestError(error)).toBe('retryable');
    });

    test('recognizes Anthropic tier spend cap details as non-retryable', () => {
        const error = parseModelErrorResponse({
            provider: 'anthropic',
            status: 429,
            statusText: 'Too Many Requests',
            headers: new Headers(),
            rawText: JSON.stringify({
                type: 'error',
                error: {
                    type: 'rate_limit_error',
                    message: 'You have reached your API usage limits',
                    details: { error_code: 'enforced_spend_limit_reached' }
                },
                request_id: 'req_spend_cap'
            })
        });

        expect(error.metadata.detailsCode).toBe('enforced_spend_limit_reached');
        expect(error.metadata.requestId).toBe('req_spend_cap');
        expect(classifyModelRequestError(error)).toBe('non_retryable');
    });

    test('uses retry-after to recognize a temporary Anthropic 429', () => {
        const error = parseModelErrorResponse({
            provider: 'anthropic',
            status: 429,
            statusText: 'Too Many Requests',
            headers: new Headers({ 'retry-after': '12' }),
            rawText: JSON.stringify({
                type: 'error',
                error: { type: 'rate_limit_error', message: 'rate limit exceeded' }
            })
        });

        expect(error.metadata.retryAfterMs).toBe(12_000);
        expect(classifyModelRequestError(error)).toBe('retryable');
    });

    test('keeps an unstructured 429 unknown', () => {
        const error = new ModelRequestError({
            provider: 'openai',
            message: 'quota exceeded',
            status: 429
        });

        expect(classifyModelRequestError(error)).toBe('unknown');
    });

    test('distinguishes model service responses from transport failures', () => {
        const serviceResponse = parseModelErrorResponse({
            provider: 'openai',
            status: 500,
            statusText: 'Internal Server Error',
            headers: new Headers(),
            rawText: 'upstream failed'
        });
        const connectionFailure = new Error('connection reset');
        connectionFailure.name = 'APIConnectionError';
        const transportError = normalizeModelRequestError(connectionFailure, 'openai');

        expect(isModelServiceResponseError(serviceResponse)).toBe(true);
        expect(isModelServiceResponseError(transportError)).toBe(false);
    });

    test('only marks structured provider response errors as model service errors', () => {
        const providerResponse = new ModelRequestError({
            provider: 'openai',
            message: 'invalid key',
            status: 401,
            code: 'invalid_api_key'
        });
        const localAdapterError = new ModelRequestError({
            provider: 'openai',
            message: 'credit balance exhausted'
        });

        expect(isModelServiceResponseError(providerResponse)).toBe(true);
        expect(isModelServiceResponseError(localAdapterError)).toBe(false);
        expect(isModelServiceResponseError(new Error('credit balance exhausted'))).toBe(false);
    });

    test('recognizes direct and wrapped network connection errors', () => {
        const connectionError = new Error('Connection error.');
        connectionError.name = 'APIConnectionError';
        const wrapped = new ModelRequestError(
            {
                provider: 'openai',
                message: 'Connection error.'
            },
            { cause: connectionError }
        );
        const systemError = Object.assign(new Error('fetch failed'), { code: 'ENOTFOUND' });

        expect(isNetworkConnectionError(connectionError)).toBe(true);
        expect(isNetworkConnectionError(wrapped)).toBe(true);
        expect(isNetworkConnectionError(systemError)).toBe(true);
        expect(isNetworkConnectionError(new Error('local state is invalid'))).toBe(false);
        expect(classifyModelRequestError(wrapped)).toBe('retryable');
    });

    test('treats TLS certificate validation failures as non-retryable network errors', () => {
        const tlsError = Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' });
        const wrapped = normalizeModelRequestError(tlsError, 'openai');

        expect(isNetworkConnectionError(wrapped)).toBe(true);
        expect(classifyModelRequestError(wrapped)).toBe('non_retryable');
    });

    test('recognizes abort errors after adapters wrap them', () => {
        const abortError = new Error('Request was aborted.');
        abortError.name = 'APIUserAbortError';

        expect(classifyModelRequestError(normalizeModelRequestError(abortError, 'openai'))).toBe('non_retryable');
    });

    test('keeps provider metadata while exposing a localized display message', () => {
        const timeoutError = new Error('Stream idle timeout: no data received for 5000ms');
        timeoutError.name = 'StreamIdleTimeoutError';

        const normalized = normalizeModelRequestError(
            timeoutError,
            'openai',
            '模型流响应空闲超时：5000 毫秒内未收到数据'
        );

        expect(normalized.message).toBe('模型流响应空闲超时：5000 毫秒内未收到数据');
        expect(normalized.metadata.message).toBe('Stream idle timeout: no data received for 5000ms');
        expect(classifyModelRequestError(normalized)).toBe('retryable');
    });

    test('uses ModelRequestError retry metadata in the rate limit backoff', () => {
        const error = new ModelRequestError({
            provider: 'anthropic',
            status: 429,
            type: 'rate_limit_error',
            message: 'rate limit exceeded',
            retryAfterMs: 12_000
        });

        expect(RateLimitDetector.isRateLimitError(error)).toBe(true);
        expect(RateLimitDetector.extractRetryAfterSeconds(error)).toBe(12);
    });

    test('honors retry headers without overriding known permanent codes', () => {
        const forcedRetry = new ModelRequestError({
            message: 'temporary failure',
            status: 400,
            shouldRetry: true
        });
        const permanent = new ModelRequestError({
            provider: 'openai',
            message: 'no credit',
            status: 429,
            code: 'credit_balance_exhausted',
            shouldRetry: true
        });

        expect(classifyModelRequestError(forcedRetry)).toBe('retryable');
        expect(classifyModelRequestError(permanent)).toBe('non_retryable');
    });

    test('does not let the rate limit detector retry a permanent quota error', () => {
        const permanent = new ModelRequestError({
            provider: 'openai',
            message: 'quota exceeded',
            status: 429,
            code: 'insufficient_quota'
        });
        const transient = new ModelRequestError({
            provider: 'openai',
            message: 'rate limit exceeded',
            status: 429,
            code: 'rate_limit_exceeded'
        });

        expect(RateLimitDetector.isRateLimitError(permanent)).toBe(false);
        expect(RateLimitDetector.isRateLimitError(transient)).toBe(true);
    });
});
