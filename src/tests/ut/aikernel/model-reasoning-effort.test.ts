import {
    REASONING_EFFORT_LEVELS,
    REASONING_EFFORT_STORAGE_VALUES,
    buildSupportedEffortValues
} from '../../../common/reasoning-effort.js';
import { REASONING_EFFORT_VALUES } from '../../../main/aikernel/types/reasoning.js';
import {
    isReasoningEffortSupported,
    lookupKnownReasoningEfforts,
    resolveModelReasoningEfforts,
    resolveReasoningEffortForModel
} from '../../../main/utils/model-context.js';

describe('model-context reasoning efforts', () => {
    test('系统档位包含 none/low/medium/high/max', () => {
        expect(REASONING_EFFORT_LEVELS).toEqual(['none', 'low', 'medium', 'high', 'max']);
        expect(REASONING_EFFORT_STORAGE_VALUES).toEqual(['', 'none', 'low', 'medium', 'high', 'max']);
        expect(REASONING_EFFORT_STORAGE_VALUES).toBe(REASONING_EFFORT_VALUES);
    });

    test('内置表中配置了限制档位的模型只返回其子集', () => {
        // GPT-5 系列无 max 档位
        expect(lookupKnownReasoningEfforts('gpt-5')).toEqual(['none', 'low', 'medium', 'high']);
        expect(lookupKnownReasoningEfforts('GPT-5.2')).toEqual(['none', 'low', 'medium', 'high']);
        expect(resolveModelReasoningEfforts({ model_name: 'gpt-5' })).toEqual(['', 'none', 'low', 'medium', 'high']);
    });

    test('deepseek-v4.1-flash（flash 系列）不支持 medium', () => {
        expect(lookupKnownReasoningEfforts('deepseek-v4.1-flash')).toEqual(['none', 'low', 'high', 'max']);
        expect(resolveModelReasoningEfforts({ model_name: 'deepseek-v4.1-flash' })).toEqual([
            '',
            'none',
            'low',
            'high',
            'max'
        ]);
    });

    test('内置表未匹配到的模型沿用系统全部档位', () => {
        expect(lookupKnownReasoningEfforts('deepseek-chat')).toBeUndefined();
        expect(resolveModelReasoningEfforts({ model_name: 'deepseek-chat' })).toEqual([
            '',
            'none',
            'low',
            'medium',
            'high',
            'max'
        ]);
        expect(resolveModelReasoningEfforts({ model_name: 'totally-unknown-model' })).toEqual([
            '',
            'none',
            'low',
            'medium',
            'high',
            'max'
        ]);
        expect(resolveModelReasoningEfforts({ model_name: '' })).toEqual(['', 'none', 'low', 'medium', 'high', 'max']);
    });

    test('校验任务级推理档位时拒绝已知模型不支持的值', () => {
        expect(isReasoningEffortSupported('gpt-5', 'max')).toBe(false);
        expect(isReasoningEffortSupported('gpt-5', 'high')).toBe(true);
        expect(isReasoningEffortSupported('deepseek-v4.1-flash', 'medium')).toBe(false);
        expect(isReasoningEffortSupported('deepseek-v4.1-flash', 'max')).toBe(true);
        expect(isReasoningEffortSupported('unknown-model', 'max')).toBe(true);
        expect(isReasoningEffortSupported('gpt-5', '')).toBe(true);
    });

    test('resolveReasoningEffortForModel 将不支持的档位回退为模型默认', () => {
        expect(resolveReasoningEffortForModel('gpt-5', 'max')).toBeUndefined();
        expect(resolveReasoningEffortForModel('gpt-5', 'high')).toBe('high');
        expect(resolveReasoningEffortForModel('deepseek-v4.1-flash', 'medium')).toBeUndefined();
        expect(resolveReasoningEffortForModel('deepseek-v4.1-flash', 'max')).toBe('max');
        expect(resolveReasoningEffortForModel('unknown-model', 'max')).toBe('max');
        expect(resolveReasoningEffortForModel('gpt-5', '')).toBe('');
        expect(resolveReasoningEffortForModel('gpt-5', undefined)).toBeUndefined();
    });

    test('buildSupportedEffortValues 过滤非法值并始终以默认项开头', () => {
        expect(buildSupportedEffortValues(undefined)).toEqual(['', 'none', 'low', 'medium', 'high', 'max']);
        expect(buildSupportedEffortValues(['none', 'low', 'medium', 'high'])).toEqual([
            '',
            'none',
            'low',
            'medium',
            'high'
        ]);
        expect(buildSupportedEffortValues(['low', 'max'])).toEqual(['', 'low', 'max']);
        expect(buildSupportedEffortValues(['low', 'bogus', 'max'])).toEqual(['', 'low', 'max']);
        expect(buildSupportedEffortValues([])).toEqual(['']);
    });
});
