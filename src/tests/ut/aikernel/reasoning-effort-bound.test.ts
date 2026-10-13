import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { OpenAIAdapter } from '../../../main/aikernel/adapters/openai.js';
import { LLM } from '../../../main/aikernel/llm.js';
import { Setting } from '../../../main/utils/setting.js';

function configureModel(alias: string, modelName: string): void {
    Setting.updateInstanceData({
        default_model: alias,
        providers: [
            {
                name: 'p',
                provider_type: 'openai',
                base_url: 'https://mock.local/v1',
                api_key: 'test-key',
                no_proxy: true
            }
        ],
        models: [{ alias, provider_name: 'p', model_name: modelName }]
    });
}

describe('LLM reasoning effort bounds', () => {
    afterEach(() => {
        jest.restoreAllMocks();
        Setting.clearCache();
    });

    test.each([
        ['glm-5.3', 'low'],
        ['gpt-5', 'none']
    ])('摘要元数据请求使用 %s 支持的最低档位 %s', async (modelName, effort) => {
        configureModel('summary-model', modelName);
        jest.spyOn(LLM, 'supportsVision').mockResolvedValue(false);
        const complete = jest.spyOn(OpenAIAdapter.prototype, 'completeTextWithMetadata').mockResolvedValue({
            text: 'valid summary',
            reasoningLength: 0,
            finishReason: 'stop'
        });
        await LLM.askWithMetadata('summarize', 'summary-model', { maxCompletionTokens: 4500 });
        expect(complete.mock.calls[0]?.[3]).toMatchObject({
            reasoningEffort: effort,
            maxCompletionTokens: 4500,
            disableInternalRetry: true
        });
    });

    test('glm-5.3 不支持关闭思考：最低档位为 low、最高为 max', () => {
        configureModel('glm53', 'glm-5.3');
        expect(LLM.getMinimalReasoningEffort('glm53')).toBe('low');
        expect(LLM.getMaximalReasoningEffort('glm53')).toBe('max');
    });

    test('gpt-5 支持 none 但不支持 max：最低为 none、最高为 high', () => {
        configureModel('gpt5', 'gpt-5');
        expect(LLM.getMinimalReasoningEffort('gpt5')).toBe('none');
        expect(LLM.getMaximalReasoningEffort('gpt5')).toBe('high');
    });

    test('未匹配 model-context 的模型沿用系统默认边界 none / max', () => {
        configureModel('unknown', 'totally-unknown-model');
        expect(LLM.getMinimalReasoningEffort('unknown')).toBe('none');
        expect(LLM.getMaximalReasoningEffort('unknown')).toBe('max');
    });

    test('未配置模型时回退到系统默认边界且不抛异常', () => {
        Setting.updateInstanceData({ models: [], providers: [], default_model: '' });
        expect(LLM.getMinimalReasoningEffort(undefined)).toBe('none');
        expect(LLM.getMaximalReasoningEffort(undefined)).toBe('max');
    });
});
