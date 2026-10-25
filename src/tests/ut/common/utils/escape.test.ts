import vm from 'vm';
import { escapeHtmlInsideJsTemplate, escapeHtml, escapeHtmlForMarkdown } from '../../../../common/utils/escape.js';

/**
 * 把转义结果放进 JS 模板字面量真实求值，用于验证逃逸是否被消解。
 * 若转义不完整，payload 会在沙箱里执行 alert 或抛出语法错误。
 */
function evaluateInTemplateLiteral(escaped: string): { value: string; alerts: unknown[] } {
    const alerts: unknown[] = [];
    const sandbox: Record<string, unknown> = { alert: (message: unknown) => alerts.push(message), out: '' };
    vm.createContext(sandbox);
    vm.runInContext(`out = \`${escaped}\`;`, sandbox);
    return { value: sandbox.out as string, alerts };
}

/** 模拟浏览器解析 HTML 实体，用于验证转义后显示内容无损 */
function decodeHtmlEntities(value: string): string {
    return value
        .replace(/&#0?92;/g, '\\')
        .replace(/&#0?36;/g, '$')
        .replace(/&#96;/g, '`')
        .replace(/&#0?39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

describe('escapeHtml', () => {
    test('escapes the five HTML significant characters', () => {
        expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#039;');
    });

    test('maps null and undefined to empty string', () => {
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(undefined)).toBe('');
    });

    test('stringifies falsy non-nullish values instead of dropping them', () => {
        // .js 调用点不受 TS 签名约束，运行时可能传入数字或布尔。
        // 契约：只有 null / undefined 折叠成空串，其余一律 String() 化，
        // 避免调用点从"显示 0"退化成"显示空白"这类静默差异。
        expect(escapeHtml(0 as unknown as string)).toBe('0');
        expect(escapeHtml(false as unknown as string)).toBe('false');
        expect(escapeHtml('')).toBe('');
    });
});

describe('escapeHtmlInsideJsTemplate', () => {
    test('neutralizes template literal interpolation payloads', () => {
        const payload = 'X${alert(1)}Y';
        const escaped = escapeHtmlInsideJsTemplate(payload);

        expect(escaped).not.toContain('${');

        const { value, alerts } = evaluateInTemplateLiteral(escaped);
        expect(alerts).toEqual([]);
        expect(decodeHtmlEntities(value)).toBe(payload);
    });

    test('neutralizes backtick escaping payloads', () => {
        const payload = 'A`</h1><img src=x onerror=alert(1)>';
        const escaped = escapeHtmlInsideJsTemplate(payload);

        expect(escaped).not.toContain('`');

        const { value, alerts } = evaluateInTemplateLiteral(escaped);
        expect(alerts).toEqual([]);
        expect(decodeHtmlEntities(value)).toBe(payload);
    });

    test.each([
        ['C:\\Users\\x', '路径中的 \\x 会被当成十六进制转义序列'],
        ['我的\\应用', '\\应 不是合法转义序列，会吞掉反斜杠'],
        ['path\\', '结尾孤立 \\ 会吃掉闭合反引号'],
        ['a\\u0020b', '\\u 会被求值成别的字符'],
        ['tab\\there', '\\t 会被求值成制表符']
    ])('neutralizes backslash escape payloads: %s', (payload) => {
        const escaped = escapeHtmlInsideJsTemplate(payload);

        expect(escaped).not.toContain('\\');

        const { value, alerts } = evaluateInTemplateLiteral(escaped);
        expect(alerts).toEqual([]);
        expect(decodeHtmlEntities(value)).toBe(payload);
    });

    test('keeps ordinary text readable after entity decoding', () => {
        const payload = 'Tom\'s app <beta> & "v2" $5 `draft` C:\\temp';
        expect(decodeHtmlEntities(escapeHtmlInsideJsTemplate(payload))).toBe(payload);
    });

    test('maps null and undefined to empty string', () => {
        expect(escapeHtmlInsideJsTemplate(null)).toBe('');
        expect(escapeHtmlInsideJsTemplate(undefined)).toBe('');
    });
});

describe('escapeHtmlForMarkdown', () => {
    test('escapes angle brackets and ampersand only', () => {
        expect(escapeHtmlForMarkdown(`<script>alert("x")</script>`)).toBe('&lt;script&gt;alert("x")&lt;/script&gt;');
    });

    test('leaves quotes untouched so markdown text stays readable', () => {
        const payload = `It's a "quoted" value`;
        expect(escapeHtmlForMarkdown(payload)).toBe(payload);
    });

    test('maps null and undefined to empty string', () => {
        expect(escapeHtmlForMarkdown(null)).toBe('');
        expect(escapeHtmlForMarkdown(undefined)).toBe('');
    });

    test('keeps inline code spans verbatim so entities do not leak into code', () => {
        // 文件名/代码片段在 markdown 里是代码 span，实体不会被还原，转义会显示成 &amp;
        expect(escapeHtmlForMarkdown('- `a&b.ts` 与 `x < y`')).toBe('- `a&b.ts` 与 `x < y`');
    });

    test('keeps fenced code blocks verbatim', () => {
        const src = '```html\n<div onclick="x">a & b</div>\n```';
        expect(escapeHtmlForMarkdown(src)).toBe(src);
    });

    test('still escapes text outside code spans', () => {
        expect(escapeHtmlForMarkdown('a < b `code` <script>alert(1)</script>')).toBe(
            'a &lt; b `code` &lt;script&gt;alert(1)&lt;/script&gt;'
        );
    });

    test('treats an unclosed backtick run as plain text and escapes it', () => {
        expect(escapeHtmlForMarkdown('<b>a `unclosed <i>')).toBe('&lt;b&gt;a `unclosed &lt;i&gt;');
    });

    test('only closes a code span with an equal-length backtick run', () => {
        // 3 个反引号不能被 1 个闭合，CommonMark 语义下整段都是代码
        const src = '```a ` b```';
        expect(escapeHtmlForMarkdown(src)).toBe(src);
    });
});
