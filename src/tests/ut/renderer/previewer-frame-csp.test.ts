import { describe, expect, test } from '@jest/globals';
import { withPreviewHeadTags } from '../../../renderer/components/previewer.js';

const CSP_META = '<meta http-equiv="Content-Security-Policy" content="frame-src \'self\' data: blob: file: about:;">';

describe('html preview srcdoc hardening', () => {
    test('限制预览里第三方子框架的来源，避免打开任务就发起外部请求', () => {
        // 回归 task_mw0mypn8_wmny：预览的 HTML 内嵌 httpbin 表单 iframe 会被主窗口
        // 导航守卫当成用户点链接，直接把系统浏览器拉起来。
        const raw = [
            '<!DOCTYPE html>',
            '<html lang="zh-CN">',
            '<head><meta charset="utf-8"><title>跨域 iframe 测试</title></head>',
            '<body><iframe src="https://httpbin.org/forms/post"></iframe></body>',
            '</html>'
        ].join('\n');

        const srcdoc = withPreviewHeadTags(raw);

        expect(srcdoc).toContain(CSP_META);
        // CSP 必须落在 head 内才会生效
        expect(srcdoc.indexOf(CSP_META)).toBeLessThan(srcdoc.indexOf('</head>'));
        // 原始内容保持不动
        expect(srcdoc).toContain('<iframe src="https://httpbin.org/forms/post"></iframe>');
    });

    test('只有 <html> 没有 <head> 的文档自动补一个 head', () => {
        const srcdoc = withPreviewHeadTags('<html><body>hi</body></html>');

        expect(srcdoc).toBe(`<html><head>${CSP_META}</head><body>hi</body></html>`);
    });

    test('裸片段用不带 DOCTYPE 的文档包裹，保持怪异模式渲染', () => {
        const srcdoc = withPreviewHeadTags('<div>hi</div>');

        expect(srcdoc).toBe(`<html><head>${CSP_META}</head><body><div>hi</div></body></html>`);
        expect(srcdoc.startsWith('<!DOCTYPE')).toBe(false);
    });

    test('只写 DOCTYPE 没有 html/head 的文档仍保留 DOCTYPE（否则掉进怪异模式）', () => {
        // 模型生成的 HTML 常见这种写法：DOCTYPE + 一堆元素，没有 html/head 标签。
        // 若把 DOCTYPE 一起塞进 body，解析器会忽略它，文档降级成怪异模式。
        const srcdoc = withPreviewHeadTags('<!DOCTYPE html>\n<div>hi</div>');

        expect(srcdoc.startsWith('<!DOCTYPE html>')).toBe(true);
        expect(srcdoc).toBe(`<!DOCTYPE html><html><head>${CSP_META}</head><body>\n<div>hi</div></body></html>`);
    });

    test('补 base 时同时保留 CSP，且已有 base 的文档不重复注入', () => {
        const withBase = withPreviewHeadTags('<html><head></head><body></body></html>', 'C:\\tmp\\demo');

        expect(withBase).toContain('<base href="file:///C:/tmp/demo/">');
        expect(withBase.indexOf('<base href=')).toBeLessThan(withBase.indexOf(CSP_META));

        const alreadyBased = withPreviewHeadTags(
            '<html><head><base href="https://example.com/"></head><body></body></html>',
            'C:\\tmp\\demo'
        );

        expect(alreadyBased).not.toContain('C:/tmp/demo');
        expect(alreadyBased).toContain(CSP_META);
    });
});
