import { describe, expect, test } from '@jest/globals';
import { classifyErrorText } from '../../../utils/error-beautify.js';

/* 底层错误文本的归类：展示层据此选择本地化的标题与建议 */
describe('error text classification', () => {
    test('DNS / 连接类底层错误识别为网络错误', () => {
        expect(classifyErrorText('fetch failed: getaddrinfo ENOTFOUND api.skillhub.tencent.com')).toBe('network');
        expect(classifyErrorText('getaddrinfo EAI_AGAIN registry.example.com')).toBe('network');
        expect(classifyErrorText('connect ECONNREFUSED 127.0.0.1:443')).toBe('network');
        expect(classifyErrorText('read ECONNRESET')).toBe('network');
        expect(classifyErrorText('connect ETIMEDOUT 1.2.3.4:443')).toBe('network');
        expect(classifyErrorText('Failed to fetch')).toBe('network');
        expect(classifyErrorText('NetworkError when attempting to fetch resource.')).toBe('network');
        expect(classifyErrorText('net::ERR_INTERNET_DISCONNECTED')).toBe('network');
        expect(classifyErrorText('net::ERR_NAME_NOT_RESOLVED')).toBe('network');
    });

    test('主动超时 / 中止识别为超时', () => {
        expect(classifyErrorText('The operation was aborted due to timeout')).toBe('timeout');
        expect(classifyErrorText('TimeoutError: The operation was aborted due to timeout')).toBe('timeout');
        expect(classifyErrorText('搜索超时，请检查网络或稍后重试')).toBe('timeout');
        expect(classifyErrorText('Search timed out; check your network and try again')).toBe('timeout');
    });

    test('其余错误归为 generic（HTTP 状态、未知 ID 等）', () => {
        expect(classifyErrorText('SkillHub API 请求失败: 500')).toBe('generic');
        expect(classifyErrorText('未知 Registry: skillhub')).toBe('generic');
        expect(classifyErrorText('')).toBe('generic');
    });
});
