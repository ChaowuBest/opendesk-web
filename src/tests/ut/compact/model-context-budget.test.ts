import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { createAutoCompactDecision } from '../../../main/aikernel/compaction/auto-compact.js';
import {
    ContextPreparationBlockedError,
    extractContextWindowFromError
} from '../../../main/aikernel/compaction/compact-error.js';
import { ModelContextBudgets } from '../../../main/aikernel/compaction/model-context-budget.js';
import { calculateCompactionBudget } from '../../../main/aikernel/compaction/request-budget.js';
import { ModelRequestError } from '../../../main/utils/model-request-error.js';
import { ModelInstance } from '../../../main/utils/setting.js';
import { OpenAIAdapter } from '../../../main/aikernel/adapters/openai.js';
import { AnthropicAdapter } from '../../../main/aikernel/adapters/anthropic.js';

function model(name = 'local-model', url = 'https://local.invalid/v1'): ModelInstance {
    return new ModelInstance(name, url, 'test-key', true);
}

function overflow(message = 'Request rejected'): ModelRequestError {
    return new ModelRequestError({ code: 'context_length_exceeded', message });
}

beforeEach(() => ModelContextBudgets.clear());
afterEach(() => ModelContextBudgets.clear());

describe('runtime model context evidence', () => {
    test('the last successful request stays separate from the learned window', () => {
        const instance = model();
        ModelContextBudgets.recordSuccess(instance, {
            prompt_tokens: 29900,
            completion_tokens: 100,
            total_tokens: 30000
        });
        expect(ModelContextBudgets.getLearnedWindow(instance)).toBeUndefined();
        expect(ModelContextBudgets.learnFromOverflow(instance, overflow())).toBe(30000);
        expect(calculateCompactionBudget(30000)).toEqual({
            contextWindow: 30000,
            triggerTokens: 24000,
            summaryOutputTokens: 4500,
            bufferTokens: 1500
        });
        ModelContextBudgets.recordSuccess(instance, { total_tokens: 10000 });
        expect(ModelContextBudgets.getLearnedWindow(instance)).toBe(30000);
    });

    test('uses the latest success rather than accumulated or maximum task usage', () => {
        const instance = model();
        ModelContextBudgets.recordSuccess(instance, { total_tokens: 20000 });
        ModelContextBudgets.recordSuccess(instance, { total_tokens: 15000 });
        expect(ModelContextBudgets.learnFromOverflow(instance, overflow())).toBe(15000);
    });

    test('expanded cache usage includes the full input rather than just uncached input', () => {
        const instance = model();
        ModelContextBudgets.recordSuccess(instance, {
            input_tokens: 1000,
            cache_read_input_tokens: 28000,
            cache_creation_input_tokens: 500,
            output_tokens: 500
        });
        expect(ModelContextBudgets.learnFromOverflow(instance, overflow())).toBe(30000);
    });

    test('normalized OpenAI usage includes completion tokens alongside expanded cache fields', () => {
        const instance = model();
        ModelContextBudgets.recordSuccess(
            instance,
            OpenAIAdapter.parseUsage({
                prompt_tokens: 29900,
                completion_tokens: 100,
                total_tokens: 30000,
                prompt_tokens_details: { cached_tokens: 20000 }
            })
        );
        expect(ModelContextBudgets.learnFromOverflow(instance, overflow())).toBe(30000);
    });

    test('normalized Anthropic usage includes cache input even when total_tokens excludes it', () => {
        const instance = model();
        ModelContextBudgets.recordSuccess(
            instance,
            AnthropicAdapter.parseUsage({
                input_tokens: 1000,
                cache_read_input_tokens: 28000,
                output_tokens: 1000
            })
        );
        expect(ModelContextBudgets.learnFromOverflow(instance, overflow())).toBe(30000);
    });

    test('total-only responses remain usable when the adapter fills zero cache fields', () => {
        const instance = model();
        ModelContextBudgets.recordSuccess(instance, OpenAIAdapter.parseUsage({ total_tokens: 30000 }));
        expect(ModelContextBudgets.learnFromOverflow(instance, overflow())).toBe(30000);
    });

    test.each([
        OpenAIAdapter.parseUsage({ completion_tokens: 100 }),
        AnthropicAdapter.parseUsage({ output_tokens: 100 })
    ])('adapter-generated totals from output-only usage are not capacity evidence', (usage) => {
        const instance = model();
        ModelContextBudgets.recordSuccess(instance, usage);
        expect(ModelContextBudgets.learnFromOverflow(instance, overflow())).toBeUndefined();
    });

    test.each([
        undefined,
        { total_tokens: 0 },
        { total_tokens: NaN },
        { total_tokens: Infinity },
        { total_tokens: -10 },
        { output_tokens: 100 },
        { completion_tokens: 100 }
    ])('does not learn from incomplete or invalid usage %j', (usage) => {
        const instance = model();
        ModelContextBudgets.recordSuccess(instance, usage);
        expect(ModelContextBudgets.learnFromOverflow(instance, overflow())).toBeUndefined();
    });

    test('an explicit provider limit takes priority over previous usage', () => {
        const instance = model();
        ModelContextBudgets.recordSuccess(instance, { total_tokens: 25000 });
        expect(
            ModelContextBudgets.learnFromOverflow(
                instance,
                overflow('maximum context length is 32,768 tokens; requested 35000 tokens')
            )
        ).toBe(32768);
    });

    test('learns a local provider context size without a structured error code', () => {
        const instance = model();
        ModelContextBudgets.recordSuccess(instance, { total_tokens: 59897 });
        const error = new ModelRequestError({
            status: 400,
            message: 'request (65583 tokens) exceeds the available context size (65536 tokens), try increasing it'
        });

        expect(ModelContextBudgets.learnFromOverflow(instance, error)).toBe(65536);
    });

    test('changing the endpoint, model, provider or credentials isolates evidence', () => {
        const instance = model();
        ModelContextBudgets.recordSuccess(instance, { total_tokens: 30000 });
        ModelContextBudgets.learnFromOverflow(instance, overflow());
        expect(ModelContextBudgets.getLearnedWindow(model())).toBe(30000);
        expect(ModelContextBudgets.getLearnedWindow(model('other-model'))).toBeUndefined();
        expect(
            ModelContextBudgets.getLearnedWindow(model('local-model', 'https://another.invalid/v1'))
        ).toBeUndefined();
        const otherProvider = model();
        otherProvider.provider_type = 'anthropic';
        expect(ModelContextBudgets.getLearnedWindow(otherProvider)).toBeUndefined();
        const otherKey = model();
        otherKey.api_key = 'other-key';
        expect(ModelContextBudgets.getLearnedWindow(otherKey)).toBeUndefined();
    });

    test('user configured windows cannot be overwritten by runtime learning', () => {
        const instance = model();
        instance.context_length = 32768;
        ModelContextBudgets.recordSuccess(instance, { total_tokens: 20000 });
        expect(ModelContextBudgets.learnFromOverflow(instance, overflow())).toBeUndefined();
    });

    test.each([
        new Error('request timeout'),
        new Error('rate limit exceeded'),
        new ContextPreparationBlockedError('context_limit')
    ])('ignores errors without new server capacity evidence', (error) => {
        const instance = model();
        ModelContextBudgets.recordSuccess(instance, { total_tokens: 20000 });
        expect(ModelContextBudgets.learnFromOverflow(instance, error)).toBeUndefined();
    });

    test('learning remains bounded on repeated overflows', () => {
        const instance = model();
        expect(ModelContextBudgets.learnFromOverflow(instance, overflow('maximum context length is 32768'))).toBe(
            32768
        );
        expect(ModelContextBudgets.learnFromOverflow(instance, overflow('maximum context length is 16384'))).toBe(
            16384
        );
        expect(ModelContextBudgets.learnFromOverflow(instance, overflow('maximum context length is 65536'))).toBe(
            16384
        );
        expect(createAutoCompactDecision({ contextWindow: 16384, estimatedContextTokens: 14000 }).shouldCompact).toBe(
            true
        );
    });
});

describe('provider context limits', () => {
    test.each([
        new Error('400 request (65583 tokens) exceeds the available context size (65536 tokens), try increasing it'),
        new ModelRequestError(
            {
                status: 400,
                message: 'request (65,583 tokens) exceeds the available context size (65,536 tokens), try increasing it'
            },
            { displayMessage: 'Model service rejected the request' }
        )
    ])('extracts the available context size rather than the rejected request size: %s', (error) => {
        expect(extractContextWindowFromError(error)).toBe(65536);
    });

    test.each([
        ["This model's maximum context length is 32768 tokens. However, you requested 40000 tokens.", 32768],
        ['maximum context length is 32,768 tokens', 32768],
        ['prompt is too long: 35000 tokens > 32768 maximum', 32768],
        ['context length exceeded; max_model_len: 32768', 32768],
        ['context length exceeded; prompt contains 40000 tokens', undefined],
        ['request (65583 tokens) exceeds the available context size', undefined],
        ['request (65583 tokens) exceeds the available context size (0 tokens)', undefined],
        ['maximum context length exceeded', undefined],
        ['maximum context length is 0 tokens', undefined],
        ['maximum context length is 99999999999999999999999999999 tokens', undefined]
    ])('extracts capacity only from explicit limits: %s', (message, expected) => {
        expect(extractContextWindowFromError(overflow(message))).toBe(expected);
    });
});
