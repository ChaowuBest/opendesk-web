import {
    lookupKnownContextSize,
    lookupKnownMaxOutputTokens,
    lookupKnownReasoningEfforts,
    lookupKnownVisionSupport
} from '../../../main/utils/model-context.js';

describe('model-context known models', () => {
    test('识别 glm-5.3-flash 的上下文、输出、视觉和推理能力', () => {
        expect(lookupKnownContextSize('glm-5.3-flash')).toBe(1000000);
        expect(lookupKnownMaxOutputTokens('glm-5.3-flash')).toBe(128000);
        expect(lookupKnownVisionSupport('glm-5.3-flash')).toBe(true);
        expect(lookupKnownReasoningEfforts('glm-5.3-flash')).toEqual(['low', 'high', 'max']);
    });

    test('识别带厂商前缀的 glm-5.3-flash 模型名', () => {
        expect(lookupKnownVisionSupport('zai-org/GLM-5.3-Flash')).toBe(true);
    });

    test('deepseek-v4.1-flash 支持视觉输入（图像理解）', () => {
        expect(lookupKnownVisionSupport('deepseek-v4.1-flash')).toBe(true);
        expect(lookupKnownVisionSupport('DeepSeek-V4.1-Flash')).toBe(true);
    });
});
