import { describe, expect, test } from '@jest/globals';
import { FileMessagePart } from '../../../main/aikernel/messages.js';

describe('FileMessagePart 渲染转义', () => {
    test('恶意附件名会被 HTML 转义，不能注入标签', async () => {
        const part = new FileMessagePart('/tmp/<img src=x onerror=alert(1)>.png');

        const html = await part.render();

        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;.png');
        expect(html).not.toContain('<img src=x');
    });

    test('普通文件名保持原样', async () => {
        const part = new FileMessagePart('/tmp/report 2026.pdf', 2048);

        const html = await part.render();

        expect(html).toContain('>report 2026.pdf</span>');
        expect(html).toContain('2.0 KB');
    });
});
