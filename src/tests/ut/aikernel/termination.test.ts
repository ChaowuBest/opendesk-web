import { jest } from '@jest/globals';
import { LLM } from '../../../main/aikernel/llm.js';
import { checkTerminationFromMessages } from '../../../main/aikernel/termination.js';
import { Setting } from '../../../main/utils/setting.js';

describe('termination request options', () => {
    afterEach(() => {
        jest.restoreAllMocks();
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
});
