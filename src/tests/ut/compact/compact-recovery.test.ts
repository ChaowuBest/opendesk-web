import { describe, expect, test } from '@jest/globals';
import { calculateCompactionBudget, checkRequestBudget } from '../../../main/aikernel/compaction/request-budget.js';
import {
    CompactError,
    isContextLimitError,
    validateCompactSummary
} from '../../../main/aikernel/compaction/compact-error.js';
import { ModelRequestError } from '../../../main/utils/model-request-error.js';

describe('compact request safety', () => {
    test.each([
        [70000, 56000, 10500, 3500],
        [200000, 160000, 16384, 10000]
    ])('window %i uses proportional budgets', (window, trigger, summary, buffer) => {
        expect(calculateCompactionBudget(window)).toEqual({
            contextWindow: window,
            triggerTokens: trigger,
            summaryOutputTokens: summary,
            bufferTokens: buffer
        });
    });

    test('budget equality is allowed; overflow and invalid estimates fail closed', () => {
        const budget = calculateCompactionBudget(70000);
        expect(checkRequestBudget({ budget, estimatedInputTokens: 64452, requestedOutputTokens: 2048 }).allowed).toBe(
            true
        );
        expect(checkRequestBudget({ budget, estimatedInputTokens: 64453, requestedOutputTokens: 2048 }).allowed).toBe(
            false
        );
        expect(() => checkRequestBudget({ budget, estimatedInputTokens: NaN, requestedOutputTokens: 2048 })).toThrow();
        expect(() => calculateCompactionBudget(0)).toThrow();
    });

    test.each([
        [{ text: '', reasoningLength: 0, choicesCount: 0 }, 'empty_choices'],
        [{ text: '', reasoningLength: 10 }, 'reasoning_only'],
        [{ text: '   ', reasoningLength: 0 }, 'empty_content'],
        [{ text: 'partial summary', reasoningLength: 0, finishReason: 'length' }, 'output_truncated'],
        [{ text: 'partial summary', reasoningLength: 0, protocolError: 'invalid content' }, 'protocol_error']
    ])('invalid summary is rejected without using reasoning', (result, code) => {
        try {
            validateCompactSummary(result);
            throw new Error('unexpected success');
        } catch (error) {
            expect(error).toBeInstanceOf(CompactError);
            expect((error as CompactError).code).toBe(code);
        }
    });

    test('usage may be absent on a valid summary', () => {
        expect(validateCompactSummary({ text: ' summary ', reasoningLength: 0, finishReason: 'stop' })).toBe('summary');
    });

    test.each([
        { code: 'context_length_exceeded', message: 'Request rejected' },
        { code: 'prompt_too_long', message: 'Request rejected' },
        { detailsCode: 'prompt_too_long', message: 'Request rejected' },
        { message: 'maximum context length exceeded' }
    ])('recognizes normalized context errors even with a generic display message: %j', (metadata) => {
        const error = new ModelRequestError(metadata, { displayMessage: 'Model service rejected the request' });
        expect(isContextLimitError(error)).toBe(true);
    });

    test('does not compact for unrelated invalid-request errors', () => {
        const error = new ModelRequestError({
            status: 400,
            code: 'invalid_api_key',
            type: 'invalid_request_error',
            message: 'Request rejected'
        });
        expect(isContextLimitError(error)).toBe(false);
    });
});
