import { describe, expect, test } from '@jest/globals';
import { resolvePluginDisplayName } from '../../../../packages/plugin-sdk/src/index.js';

describe('resolvePluginDisplayName', () => {
    test('字符串形式原样返回', () => {
        expect(resolvePluginDisplayName('Review Helper', 'zh-CN')).toBe('Review Helper');
    });

    test('未声明或空白字符串返回 undefined', () => {
        expect(resolvePluginDisplayName(undefined, 'zh-CN')).toBeUndefined();
        expect(resolvePluginDisplayName('   ', 'zh-CN')).toBeUndefined();
    });

    test('对象形式按请求语言精确匹配', () => {
        const displayName = { en: 'Hello Plugin', zh: '你好插件' };
        expect(resolvePluginDisplayName(displayName, 'zh-CN')).toBe('你好插件');
        expect(resolvePluginDisplayName(displayName, 'en-US')).toBe('Hello Plugin');
    });

    test('完整语言标签按主语言匹配', () => {
        const displayName = { 'en-US': 'Hello', 'zh-CN': '你好' };
        expect(resolvePluginDisplayName(displayName, 'en-US')).toBe('Hello');
        expect(resolvePluginDisplayName(displayName, 'zh-CN')).toBe('你好');
        expect(resolvePluginDisplayName(displayName, 'zh-TW')).toBe('你好');
    });

    test('无匹配语言时回退到第一个可用翻译', () => {
        expect(resolvePluginDisplayName({ fr: 'Bonjour' }, 'en-US')).toBe('Bonjour');
    });

    test('对象中的空白值被视为缺失', () => {
        expect(resolvePluginDisplayName({ en: '  ', zh: '你好' }, 'en-US')).toBe('你好');
    });

    test('全部值为空或空对象时返回 undefined', () => {
        expect(resolvePluginDisplayName({}, 'zh-CN')).toBeUndefined();
        expect(resolvePluginDisplayName({ en: '', zh: '' }, 'zh-CN')).toBeUndefined();
    });
});
