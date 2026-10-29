import { jest } from '@jest/globals';
import {
    limitSummaryOutputToModel,
    resolveMaxOutputTokens,
    resolveReservedSummaryOutput
} from '../../../main/aikernel/compaction/auto-compact.js';
import { ModelInstance, Setting } from '../../../main/utils/setting.js';

function configureModel(modelName = 'gpt-4-turbo', configuredOutput?: number): ModelInstance {
    const instance = new ModelInstance(modelName, 'https://example.com', 'test-key', false);
    // Restored/runtime configuration can bypass the constructor's normalization.
    instance.max_output_tokens = configuredOutput;
    instance.context_length = 128000;
    jest.spyOn(Setting, 'getInstance').mockReturnValue({
        getModelInstance: () => instance,
        getDefaultModelInstance: () => instance
    } as unknown as Setting);
    return instance;
}

afterEach(() => {
    jest.restoreAllMocks();
});

describe('shared model output limits', () => {
    test.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
        'ignores invalid configured output %s in normal requests and both summary stages',
        async (configuredOutput) => {
            configureModel('gpt-4-turbo', configuredOutput);

            await expect(resolveMaxOutputTokens('alias')).resolves.toBe(4096);
            await expect(resolveReservedSummaryOutput('alias')).resolves.toBe(4096);
            expect(limitSummaryOutputToModel('alias', 16384)).toBe(4096);
            expect(limitSummaryOutputToModel('alias', 1024)).toBe(1024);
        }
    );

    test.each(['alias', undefined])('a valid configured limit takes priority for model %s', async (model) => {
        configureModel('gpt-4-turbo', 2048);

        await expect(resolveMaxOutputTokens(model)).resolves.toBe(2048);
        await expect(resolveReservedSummaryOutput(model)).resolves.toBe(2048);
        expect(limitSummaryOutputToModel(model, 16384)).toBe(2048);
        expect(limitSummaryOutputToModel(model, 1000)).toBe(1000);
    });

    test('the default model also falls back to its known limit for a nonpositive configuration', async () => {
        configureModel('gpt-4-turbo', 0);

        await expect(resolveMaxOutputTokens()).resolves.toBe(4096);
        await expect(resolveReservedSummaryOutput()).resolves.toBe(4096);
        expect(limitSummaryOutputToModel(undefined, 16384)).toBe(4096);
    });

    test('a known alias remains a fallback when the configured model name is unknown', async () => {
        configureModel('custom-deployment', -1);

        await expect(resolveMaxOutputTokens('gpt-4-turbo')).resolves.toBe(4096);
        await expect(resolveReservedSummaryOutput('gpt-4-turbo')).resolves.toBe(4096);
        expect(limitSummaryOutputToModel('gpt-4-turbo', 16384)).toBe(4096);
    });

    test('a known instance name takes priority over the alias', async () => {
        configureModel('gpt-4-turbo');

        await expect(resolveMaxOutputTokens('gpt-4o')).resolves.toBe(4096);
        await expect(resolveReservedSummaryOutput('gpt-4o')).resolves.toBe(4096);
        expect(limitSummaryOutputToModel('gpt-4o', 16384)).toBe(4096);
    });

    test('unknown models retain request defaults and the calculated summary budget', async () => {
        configureModel('custom-deployment', 0);

        await expect(resolveMaxOutputTokens('alias')).resolves.toBe(16384);
        await expect(resolveReservedSummaryOutput('alias')).resolves.toBe(16384);
        expect(limitSummaryOutputToModel('alias', 30000)).toBe(30000);
        expect(limitSummaryOutputToModel('alias', 6000)).toBe(6000);
    });

    test.each([
        ['gpt-4-turbo', 4096],
        ['custom-deployment', 0],
        [undefined, 0]
    ] as const)('absent model instances preserve the known fallback for %s', async (model, limit) => {
        jest.spyOn(Setting, 'getInstance').mockReturnValue({
            getModelInstance: () => null,
            getDefaultModelInstance: () => null
        } as unknown as Setting);

        await expect(resolveMaxOutputTokens(model)).resolves.toBe(limit);
        expect(limitSummaryOutputToModel(model, 16384)).toBe(limit || 16384);
    });
});
