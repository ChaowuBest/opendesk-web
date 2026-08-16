import { jest } from '@jest/globals';
import { LLM } from '../../../main/aikernel/llm.js';
import { checkTerminationFromMessages } from '../../../main/aikernel/termination.js';
import { Setting } from '../../../main/utils/setting.js';

describe('termination request options', () => {
    afterEach(() => {
        jest.restoreAllMocks();
        Setting.clearCache();
    });

    test('forwards runtime headers and disables reasoning', async () => {
        const askSpy = jest.spyOn(LLM, 'ask').mockResolvedValue('finished');
        jest.spyOn(Setting.getInstance(), 'getDefaultQuickModelInstance').mockReturnValue(null);
        const extraHeaders = {
            cookie: 'session=test',
            trace_id: 'trace-test'
        };

        const result = await checkTerminationFromMessages('完成当前任务', '任务已经处理完成。', 'test-model', {
            extraHeaders,
            reasoningEffort: 'high'
        });

        expect(result).toBe('finished');
        expect(askSpy).toHaveBeenCalledWith(expect.any(String), 'test-model', {
            extraHeaders,
            reasoningEffort: 'none'
        });
    });

    test('glm-5.3（不支持关闭思考）终止性检查使用其最低档位 low', async () => {
        const askSpy = jest.spyOn(LLM, 'ask').mockResolvedValue('finished');
        Setting.updateInstanceData({
            default_model: 'glm53',
            providers: [
                {
                    name: 'p',
                    provider_type: 'openai',
                    base_url: 'https://mock.local/v1',
                    api_key: 'test-key',
                    no_proxy: true
                }
            ],
            models: [{ alias: 'glm53', provider_name: 'p', model_name: 'glm-5.3' }]
        });

        const result = await checkTerminationFromMessages('完成当前任务', '任务已经处理完成。', 'glm53');

        expect(result).toBe('finished');
        expect(askSpy).toHaveBeenCalledWith(expect.any(String), 'glm53', { reasoningEffort: 'low' });
    });
});
