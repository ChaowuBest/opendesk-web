import {
    ModelRequestError,
    classifyModelRequestError,
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
