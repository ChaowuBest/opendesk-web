import { neutralizeMarkdownHtml } from '../../../../common/markdown/markdown-html-safety.js';

describe('neutralizeMarkdownHtml', () => {
    test('keep benign html intact', () => {
        const html = '<p>hello <strong>world</strong> <a href="https://example.com">link</a></p>';
        expect(neutralizeMarkdownHtml(html)).toBe(html);
    });

    test('strip inline event handler attributes', () => {
        expect(neutralizeMarkdownHtml('<img src="x.png" onerror="alert(1)">')).toBe('<img src="x.png">');
        expect(neutralizeMarkdownHtml('<div onclick="alert(1)" class="c">x</div>')).toBe('<div class="c">x</div>');
        expect(neutralizeMarkdownHtml("<span onmouseover='alert(1)'>x</span>")).toBe('<span>x</span>');
        expect(neutralizeMarkdownHtml('<body onload=alert(1)>')).toBe('<body>');
    });

    test('strip multiple event handlers in one tag', () => {
        const html = '<img src="a.png" onerror="x()" onload="y()" alt="t">';
        expect(neutralizeMarkdownHtml(html)).toBe('<img src="a.png" alt="t">');
    });

    test('strip javascript and vbscript urls', () => {
        expect(neutralizeMarkdownHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
        expect(neutralizeMarkdownHtml('<a href="java\nscript:alert(1)">x</a>')).toBe('<a>x</a>');
        expect(neutralizeMarkdownHtml('<a href="VBScript:msgbox(1)">x</a>')).toBe('<a>x</a>');
        expect(neutralizeMarkdownHtml('<img src="javascript:alert(1)">')).toBe('<img>');
    });

    test('allow http, https, mailto, relative urls and data images', () => {
        const html =
            '<a href="https://a.com">a</a><a href="mailto:x@y.z">b</a><a href="#frag">c</a>' +
            '<img src="data:image/png;base64,AAA"><img src="file:///tmp/a.png">';
        expect(neutralizeMarkdownHtml(html)).toBe(html);
    });

    test('strip data:text/html and svg data urls', () => {
        expect(neutralizeMarkdownHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>')).toBe('<a>x</a>');
        expect(neutralizeMarkdownHtml('<img src="data:image/svg+xml;base64,AAA">')).toBe('<img>');
    });

    test('strip entity-encoded dangerous protocols', () => {
        // 浏览器先解码实体再解析协议，jav&#x61;script: 与 javascript: 等价
        expect(neutralizeMarkdownHtml('<a href="jav&#x61;script:alert(1)">x</a>')).toBe('<a>x</a>');
        expect(neutralizeMarkdownHtml('<a href="jav&#97;script:alert(1)">x</a>')).toBe('<a>x</a>');
        expect(neutralizeMarkdownHtml('<a href="javascript&colon;alert(1)">x</a>')).toBe('<a>x</a>');
        expect(neutralizeMarkdownHtml('<a href="&#14;javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    });

    test('strip handlers even when the tag contains a stray <', () => {
        // 多出来的 < 不能让 onerror 逃过清洗：HTML 词法里它属于标签内部
        expect(neutralizeMarkdownHtml('<img src=x onerror=alert(1) <y>')).toBe('<img src=x <y>');
        expect(neutralizeMarkdownHtml('<a href="a>b" onclick="x()">t</a>')).toBe('<a href="a>b">t</a>');
    });

    test('strip handlers when an unquoted value contains a quote', () => {
        // HTML 词法里只有紧跟 = 的引号才开启带引号的值，src=x"y 中的引号是普通字符。
        // 若把它当值边界，整个标签会被误判成"引号未闭合"，onerror 就会被原样放行。
        expect(neutralizeMarkdownHtml('<img src=x"y onerror=alert(1)>')).toBe('<img src=x"y>');
        expect(neutralizeMarkdownHtml("<img src=x'y onerror=alert(1)>")).toBe("<img src=x'y>");
        expect(neutralizeMarkdownHtml('<div><img src=x"y onerror=alert(1)></div>')).toBe('<div><img src=x"y></div>');
    });

    test('never pass through a tag whose end cannot be determined', () => {
        // 引号真的未闭合时同样不能原样放行：后面还有 > 的话浏览器仍会把这段解析成
        // 带 onerror 的真实标签，因此把 < 转义成文本
        expect(neutralizeMarkdownHtml('<div><img src="a onerror=alert(1)>')).toBe(
            '<div>&lt;img src="a onerror=alert(1)>'
        );
    });

    test('survive pathological tag-like input without blowing up', () => {
        const pathological = '<a'.repeat(30000);
        const started = Date.now();
        const result = neutralizeMarkdownHtml(pathological);
        expect(result).toBe(pathological);
        // 正则回溯版本在这里是平方级，会远超该上限
        expect(Date.now() - started).toBeLessThan(2000);
    });

    test('escape dangerous tag names as before', () => {
        expect(neutralizeMarkdownHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
        expect(neutralizeMarkdownHtml('<iframe src="a"></iframe>')).toBe('&lt;iframe src="a"&gt;&lt;/iframe&gt;');
        expect(neutralizeMarkdownHtml('<style>body{}</style>')).toBe('&lt;style&gt;body{}&lt;/style&gt;');
    });

    test('leave escaped code content untouched', () => {
        const html = '<pre><code>&lt;img src=x onerror=alert(1)&gt;</code></pre>';
        expect(neutralizeMarkdownHtml(html)).toBe(html);
    });

    test('do not treat attribute values as attributes', () => {
        const html = '<a href="https://a.com/?q=onerror" title="onclick=evil">x</a>';
        expect(neutralizeMarkdownHtml(html)).toBe(html);
    });

    test('is idempotent', () => {
        const once = neutralizeMarkdownHtml('<img src="a.png" onerror="alert(1)">');
        expect(neutralizeMarkdownHtml(once)).toBe(once);
    });
});
