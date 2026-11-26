import { describe, expect, test } from '@jest/globals';
import { ErrorMessagePart } from '../../../main/aikernel/messages.js';

describe('ErrorMessagePart 渲染转义', () => {
    test('title 与 message 中的 HTML 会被转义', async () => {
        const part = new ErrorMessagePart('<img src=x onerror=alert(1)>', '<script>alert(2)</script>\nsecond line');

        const html = await part.render();

        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(html).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
        expect(html).not.toContain('<img src=x');
        expect(html).not.toContain('<script>');
        // 换行仍保留（外层 whitespace-pre-wrap 负责显示）
        expect(html).toContain('second line');
    });

    test('普通错误文本保持原样', async () => {
        const part = new ErrorMessagePart('Stream Completion Failed', 'HTTP 500: upstream error');

        const html = await part.render();

        expect(html).toContain('Stream Completion Failed');
        expect(html).toContain('HTTP 500: upstream error');
    });
});
