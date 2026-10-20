import { jest } from '@jest/globals';
import { parseHTML } from 'linkedom';
import {
    buildTaskExportHtml,
    cleanExportContainer,
    collectUsedCss,
    removeDangerousTags,
    serializePreviewHosts,
    stripEmptyResourceRefs
} from '../../../renderer/utils/task-export.js';

let document: any;

beforeAll(() => {
    const parsed = parseHTML('<!DOCTYPE html><html lang="zh-CN" data-theme="dark"><body></body></html>');
    document = parsed.document;
    Object.assign(globalThis, { document });
});

function makeHistoryContainer(html: string) {
    document.body.innerHTML = `<task-view><div id="taskview-chat-history">${html}</div></task-view>`;
    return document.querySelector('#taskview-chat-history');
}

describe('cleanExportContainer', () => {
    test('移除交互专用节点但保留时间戳与消息内容', () => {
        const container = document.createElement('div');
        container.innerHTML = `
            <div class="od-user-msg-container">
                <div class="od-user-msg">hello</div>
                <div class="od-msg-meta-row">
                    <span class="od-msg-timestamp">3 分钟前</span>
                    <div class="od-msg-hover-menu"><button data-action="copy"></button></div>
                </div>
            </div>
            <div class="od-assistant-msg-container">
                <div class="markdown-body">reply<span class="stream-cursor"></span></div>
                <span class="message-usage"><span class="usage-spinner">sp</span><span class="usage-text">1.2k</span></span>
            </div>
            <div class="waiting-usage-placeholder">thinking</div>
            <div class="od-attribution-placeholder">analyzing</div>
        `;
        cleanExportContainer(container);
        expect(container.querySelector('.od-msg-hover-menu')).toBeNull();
        expect(container.querySelector('.stream-cursor')).toBeNull();
        expect(container.querySelector('.usage-spinner')).toBeNull();
        expect(container.querySelector('.waiting-usage-placeholder')).toBeNull();
        expect(container.querySelector('.od-attribution-placeholder')).toBeNull();
        expect(container.querySelector('.od-msg-timestamp')?.textContent).toBe('3 分钟前');
        expect(container.querySelector('.usage-text')?.textContent).toBe('1.2k');
        expect(container.querySelector('.od-user-msg')?.textContent).toBe('hello');
    });

    test('编辑态气泡退回普通展示态', () => {
        const container = document.createElement('div');
        container.innerHTML = `
            <div class="od-user-msg od-user-msg-editing"><textarea class="od-user-msg-editor"></textarea></div>
        `;
        cleanExportContainer(container);
        expect(container.querySelector('.od-user-msg-editor')).toBeNull();
        expect(container.querySelector('.od-user-msg')?.classList.contains('od-user-msg-editing')).toBe(false);
    });

    test('移除代码块复制按钮与预览开关', () => {
        const container = document.createElement('div');
        container.innerHTML = `
            <div class="code-block-wrapper">
                <div class="code-block-header"><span class="code-block-lang">js</span>
                    <button class="code-copy-btn"></button>
                    <label class="code-preview-toggle"></label>
                </div>
                <div class="code-block-body"></div>
            </div>
        `;
        cleanExportContainer(container);
        expect(container.querySelector('.code-copy-btn')).toBeNull();
        expect(container.querySelector('.code-preview-toggle')).toBeNull();
        expect(container.querySelector('.code-block-lang')?.textContent).toBe('js');
    });
});

describe('removeDangerousTags', () => {
    test('剥离危险标签但保留常规内容', () => {
        const container = document.createElement('div');
        container.innerHTML = `
            <div class="markdown-body"><p>text</p><script>alert(1)</script><style>.x{}</style></div>
            <iframe src="https://evil.example"></iframe>
            <object></object><embed></embed>
        `;
        removeDangerousTags(container);
        expect(container.querySelector('script')).toBeNull();
        expect(container.querySelector('style')).toBeNull();
        expect(container.querySelector('iframe')).toBeNull();
        expect(container.querySelector('object')).toBeNull();
        expect(container.querySelector('embed')).toBeNull();
        expect(container.querySelector('p')?.textContent).toBe('text');
    });
});

describe('stripEmptyResourceRefs', () => {
    test('移除空 src/href 属性，避免 file: 唯一源安全报错', () => {
        const container = document.createElement('div');
        container.innerHTML = `
            <img src="">
            <script src="x.js"></script>
            <a href="">self link</a>
            <img src="data:image/png;base64,AAA">
        `;
        stripEmptyResourceRefs(container);
        const imgs = container.querySelectorAll('img');
        expect(imgs[0].hasAttribute('src')).toBe(false);
        expect(imgs[1].getAttribute('src')).toBe('data:image/png;base64,AAA');
        expect(container.querySelector('a')?.hasAttribute('href')).toBe(false);
        expect(container.querySelector('script')?.getAttribute('src')).toBe('x.js');
    });
});

describe('serializePreviewHosts', () => {
    test('iframe 预览：shadow host 替换为携带 srcdoc 的静态 iframe', () => {
        const container = document.createElement('div');
        container.innerHTML = '<div class="code-preview-container"><div class="code-preview-shadow-host"></div></div>';
        const host = container.querySelector('.code-preview-shadow-host') as any;
        const shadowRoot = host.attachShadow({ mode: 'open' });
        const iframe = document.createElement('iframe');
        iframe.setAttribute('srcdoc', '<img src=""><p>preview</p><link href="">');
        iframe.style.width = '100%';
        shadowRoot.appendChild(iframe);

        serializePreviewHosts(container, document);
        expect(container.querySelector('.code-preview-shadow-host')).toBeNull();
        const staticFrame = container.querySelector('iframe');
        expect(staticFrame).not.toBeNull();
        const srcdoc = staticFrame?.getAttribute('srcdoc') || '';
        expect(srcdoc).toContain('<p>preview</p>');
        expect(srcdoc).not.toContain('src=""');
        expect(srcdoc).not.toContain('href=""');
        expect(staticFrame?.getAttribute('data-od-preview')).toBe('1');
        expect(staticFrame?.getAttribute('sandbox')).toBe('allow-same-origin');
        expect(staticFrame?.getAttribute('style')).toContain('width:100%');
    });

    test('SVG 预览：shadow 内节点克隆进光域', () => {
        const container = document.createElement('div');
        container.innerHTML = '<div class="tool-preview-card"><div class="code-preview-shadow-host"></div></div>';
        const host = container.querySelector('.code-preview-shadow-host') as any;
        const shadowRoot = host.attachShadow({ mode: 'open' });
        const wrapper = document.createElement('div');
        wrapper.innerHTML = '<svg viewBox="0 0 1 1"></svg>';
        shadowRoot.appendChild(wrapper);

        serializePreviewHosts(container, document);
        expect(container.querySelector('.code-preview-shadow-host')).toBeNull();
        expect(container.querySelector('svg')).not.toBeNull();
    });

    test('空 shadow host 直接移除', () => {
        const container = document.createElement('div');
        container.innerHTML = '<div class="code-preview-shadow-host"></div>';
        serializePreviewHosts(container, document);
        expect(container.querySelector('.code-preview-shadow-host')).toBeNull();
    });
});

// ── CSSOM 桩 ──────────────────────────────────────────────────

function styleRule(selectorText: string, cssText: string) {
    return { selectorText, cssText };
}

function mediaRule(conditionText: string, rules: unknown[]) {
    return { media: {}, conditionText, cssRules: rules };
}

function fontFaceRule(family: string, url: string) {
    const declarations = `font-family: '${family}'; src: url(${url}) format('woff2');`;
    return {
        style: {
            cssText: declarations,
            getPropertyValue: (prop: string) => {
                if (prop === 'font-family') return `'${family}'`;
                if (prop === 'src') return `url(${url}) format('woff2')`;
                return '';
            }
        }
    };
}

function makeDoc(styleSheets: unknown[]) {
    return { styleSheets, documentElement: document.documentElement, body: document.body } as unknown as Document;
}

describe('collectUsedCss', () => {
    test('命中导出内容的规则保留，未命中的规则剔除', () => {
        const container = document.createElement('div');
        container.innerHTML = '<div class="od-user-msg">hi</div>';
        const { cssText } = collectUsedCss(
            makeDoc([
                {
                    cssRules: [
                        styleRule('.od-user-msg', '.od-user-msg { color: red }'),
                        styleRule('.sidebar-item', '.sidebar-item { color: blue }')
                    ]
                }
            ]),
            { liveRoot: null, container }
        );
        expect(cssText).toContain('.od-user-msg { color: red }');
        expect(cssText).not.toContain('.sidebar-item');
    });

    test('@media 仅保留命中的子规则，无命中时整体剔除', () => {
        const container = document.createElement('div');
        container.innerHTML = '<div class="od-user-msg">hi</div>';
        const { cssText } = collectUsedCss(
            makeDoc([
                {
                    cssRules: [
                        mediaRule('(prefers-color-scheme: dark)', [
                            styleRule('.od-user-msg', '.od-user-msg { color: white }'),
                            styleRule('.unrelated', '.unrelated { color: black }')
                        ]),
                        mediaRule('(max-width: 1px)', [styleRule('.never', '.never { color: black }')])
                    ]
                }
            ]),
            { liveRoot: null, container }
        );
        expect(cssText).toContain('@media (prefers-color-scheme: dark)');
        expect(cssText).toContain('.od-user-msg { color: white }');
        expect(cssText).not.toContain('.unrelated');
        expect(cssText).not.toContain('(max-width: 1px)');
    });

    test('作用域选择器通过真实 task-view 祖先链命中', () => {
        const chatHistory = makeHistoryContainer('<div class="markdown-body">md</div>');
        const liveRoot = document.querySelector('task-view');
        const { cssText } = collectUsedCss(
            makeDoc([
                { cssRules: [styleRule('task-view .markdown-body', 'task-view .markdown-body { padding: 2px }')] }
            ]),
            { liveRoot, container: document.createElement('div') }
        );
        expect(cssText).toContain('task-view .markdown-body { padding: 2px }');
        void chatHistory;
    });

    test('@layer 块重建且仅保留命中子规则，@keyframes/@property 原样保留', () => {
        const container = document.createElement('div');
        container.innerHTML = '<div class="flex items-center">hi</div>';
        const { cssText } = collectUsedCss(
            makeDoc([
                {
                    cssRules: [
                        {
                            name: 'utilities',
                            cssRules: [
                                styleRule('.flex', '.flex { display: flex }'),
                                styleRule('.grid', '.grid { display: grid }')
                            ]
                        },
                        {
                            name: 'breathe',
                            cssRules: [{ keyText: '0%', style: { cssText: 'opacity: 0' } }],
                            cssText: '@keyframes breathe { 0% { opacity: 0 } }'
                        },
                        { cssText: '@property --od-x { syntax: "*"; inherits: false; }' }
                    ]
                }
            ]),
            { liveRoot: null, container }
        );
        expect(cssText).toContain('@layer utilities');
        expect(cssText).toContain('.flex { display: flex }');
        expect(cssText).not.toContain('.grid');
        expect(cssText).toContain('@keyframes breathe');
        expect(cssText).toContain('@property --od-x');
    });

    test('字体声明仅保留被正文引用的字体族，并收集字体 URL', () => {
        const container = document.createElement('div');
        container.innerHTML = '<div class="od-user-msg">hi</div>';
        const { cssText, fontUrls } = collectUsedCss(
            makeDoc([
                {
                    cssRules: [
                        styleRule('body', "body { font-family: 'HarmonyOS Sans', sans-serif }"),
                        fontFaceRule('HarmonyOS Sans', '/fonts/harmonyos/HarmonyOS_Sans_SC_Regular.woff2'),
                        fontFaceRule('KaTeX_Main', '/fonts/katex/KaTeX_Main.woff2')
                    ]
                }
            ]),
            { liveRoot: null, container }
        );
        expect(cssText).toContain('@font-face');
        expect(fontUrls).toEqual(['/fonts/harmonyos/HarmonyOS_Sans_SC_Regular.woff2']);
        expect(cssText).not.toContain('KaTeX_Main');
    });

    test('相对字体 URL 按样式表地址解析为绝对 URL（含 @font-face 内的改写）', () => {
        // 构建产物中 FA/KaTeX 的 @font-face 是相对路径（url(./fa-xxx.woff2)），
        // 主进程无法解析相对路径导致字体不内联、导出页图标不可见
        const container = document.createElement('div');
        container.innerHTML = '<i class="fas fa-wrench"></i>';
        const { cssText, fontUrls } = collectUsedCss(
            makeDoc([
                {
                    href: 'file:///C:/app/dist/renderer/assets/common.css',
                    cssRules: [
                        fontFaceRule('Font Awesome 7 Free', './fa-solid-900.woff2'),
                        styleRule('.fas', ".fas { font-family: 'Font Awesome 7 Free' }")
                    ]
                }
            ]),
            { liveRoot: null, container }
        );
        expect(fontUrls).toEqual(['file:///C:/app/dist/renderer/assets/fa-solid-900.woff2']);
        expect(cssText).toContain('file:///C:/app/dist/renderer/assets/fa-solid-900.woff2');
        expect(cssText).not.toContain('./fa-solid-900.woff2');
    });

    test('无法解析基准地址时字体 URL 保持原样', () => {
        const container = document.createElement('div');
        container.innerHTML = '<div class="od-user-msg">hi</div>';
        const { fontUrls } = collectUsedCss(
            makeDoc([
                {
                    cssRules: [
                        styleRule('body', "body { font-family: 'HarmonyOS Sans', sans-serif }"),
                        fontFaceRule('HarmonyOS Sans', '/fonts/harmonyos/HarmonyOS_Sans_SC_Regular.woff2')
                    ]
                }
            ]),
            { liveRoot: null, container }
        );
        expect(fontUrls).toEqual(['/fonts/harmonyos/HarmonyOS_Sans_SC_Regular.woff2']);
    });

    test('伪元素选择器剥离后仍可命中', () => {
        const container = document.createElement('div');
        container.innerHTML = '<div id="taskview-chat-history"></div>';
        const { cssText } = collectUsedCss(
            makeDoc([
                {
                    cssRules: [
                        styleRule('#taskview-chat-history::after', '#taskview-chat-history::after { content: "" }')
                    ]
                }
            ]),
            { liveRoot: null, container }
        );
        expect(cssText).toContain('#taskview-chat-history::after');
    });

    test('伪元素渲染规则（FA 图标 content）可解析不命中时也按剥离后主体保留', () => {
        // Chromium 对带伪元素的选择器不抛异常而是静默返回「不命中」，
        // 规则必须按剥离伪元素后的主体判定，否则图标渲染规则全部丢失
        const container = document.createElement('div');
        container.innerHTML = '<i class="fas fa-wrench"></i>';
        const { cssText } = collectUsedCss(
            makeDoc([
                {
                    cssRules: [
                        styleRule(
                            ':is(.fas, .far, .fab, .fa-solid, .fa-regular, .fa-brands, .fa-classic, .fa)::before',
                            ':is(.fas, .far, .fab, .fa-solid, .fa-regular, .fa-brands, .fa-classic, .fa)::before { content: var(--fa) }'
                        )
                    ]
                }
            ]),
            { liveRoot: null, container }
        );
        expect(cssText).toContain('content: var(--fa)');
    });

    test('Tailwind 转义类名与变体选择器正确反解码后命中', () => {
        const container = document.createElement('div');
        container.innerHTML = `
            <div class="min-w-[240px] max-w-2xl">a</div>
            <div class="hover:text-slate-400 text-xs">b</div>
            <div class="grid-rows-[0fr]">c</div>
        `;
        const { cssText } = collectUsedCss(
            makeDoc([
                {
                    cssRules: [
                        styleRule('.min-w-\\[240px\\]', '.min-w-\\[240px\\] { min-width: 240px }'),
                        styleRule('.max-w-2xl', '.max-w-2xl { max-width: 42rem }'),
                        styleRule(
                            "html[data-theme=\\'dark\\'] .hover\\:text-slate-400:hover",
                            '.hover\\:text-slate-400:hover { color: #94a3b8 }'
                        ),
                        styleRule('.grid-rows-\\[0fr\\]', '.grid-rows-\\[0fr\\] { grid-template-rows: 0fr }'),
                        styleRule('.px-6', '.px-6 { padding: 1.5rem }')
                    ]
                }
            ]),
            { liveRoot: null, container }
        );
        expect(cssText).toContain('min-width: 240px');
        expect(cssText).toContain('max-width: 42rem');
        // :hover 为动态状态，静态导出不命中
        expect(cssText).not.toContain('#94a3b8');
        expect(cssText).toContain('grid-template-rows: 0fr');
        expect(cssText).not.toContain('padding: 1.5rem');
    });

    test('选择器列表（逗号分隔）任一备选命中即保留', () => {
        const container = document.createElement('div');
        container.innerHTML = '<div class="od-user-msg">a</div>';
        const { cssText } = collectUsedCss(
            makeDoc([
                {
                    cssRules: [
                        styleRule(
                            '.missing, .od-user-msg, .also-missing',
                            '.missing, .od-user-msg, .also-missing { color: red }'
                        )
                    ]
                }
            ]),
            { liveRoot: null, container }
        );
        expect(cssText).toContain('color: red');
    });

    test('主题作用域规则双主题保留（当前主题之外的一套也提取）', () => {
        // 全局 document 的 data-theme 为 dark：light 主题规则靠 :root 变体命中
        const container = document.createElement('div');
        container.innerHTML = '<div class="markdown-body">md</div>';
        const { cssText } = collectUsedCss(
            makeDoc([
                {
                    cssRules: [
                        styleRule(
                            "html[data-theme='dark'] .markdown-body",
                            "html[data-theme='dark'] .markdown-body { color: #eee }"
                        ),
                        styleRule(
                            "html[data-theme='light'] .markdown-body",
                            "html[data-theme='light'] .markdown-body { color: #111 }"
                        ),
                        styleRule("html[data-theme='light']", "html[data-theme='light'] { --chat-ink: #111 }"),
                        styleRule("html[data-theme='dark']", "html[data-theme='dark'] { --chat-ink: #eee }")
                    ]
                }
            ]),
            { liveRoot: null, container }
        );
        expect(cssText).toContain("html[data-theme='dark'] .markdown-body { color: #eee }");
        expect(cssText).toContain("html[data-theme='light'] .markdown-body { color: #111 }");
        expect(cssText).toContain('--chat-ink: #111');
        expect(cssText).toContain('--chat-ink: #eee');
    });

    test('与主题无关且未命中的规则仍被剔除', () => {
        const container = document.createElement('div');
        container.innerHTML = '<div class="markdown-body">md</div>';
        const { cssText } = collectUsedCss(
            makeDoc([
                {
                    cssRules: [
                        styleRule(
                            "html[data-theme='dark'] .sidebar-item",
                            "html[data-theme='dark'] .sidebar-item { color: red }"
                        )
                    ]
                }
            ]),
            { liveRoot: null, container }
        );
        expect(cssText).not.toContain('sidebar-item');
    });
});

describe('buildTaskExportHtml', () => {
    function setupExportDoc(styleSheets: unknown[]) {
        const parsed = parseHTML(
            '<!DOCTYPE html><html lang="zh-CN" data-theme="dark" data-font-preset=""><body class="app-body"></body></html>'
        );
        const doc: any = parsed.document;
        Object.defineProperty(doc, 'styleSheets', { value: styleSheets, configurable: true });
        doc.body.innerHTML =
            '<task-view><div id="taskview-chat-history"><div class="od-user-msg-container">live</div></div></task-view>';
        return doc;
    }

    const baseSheets = [
        {
            cssRules: [
                styleRule('.od-user-msg', '.od-user-msg { background: #f4f3f1 }'),
                fontFaceRule('Maple Mono', '/fonts/maplemono/MapleMono-Regular.ttf.woff2'),
                styleRule('pre', "pre { font-family: 'Maple Mono', monospace }")
            ]
        }
    ];

    test('组装对齐 GUI 的导出文档', () => {
        const doc = setupExportDoc(baseSheets);
        const chatHistory = doc.querySelector('#taskview-chat-history');
        const result = buildTaskExportHtml({
            taskName: 'My <Task>',
            contentHtml:
                '<div class="od-user-msg-container"><div class="od-user-msg">exported</div></div><pre><code>x=1</code></pre>',
            chatHistory,
            doc,
            reasoningCollapseLabel: '收起'
        });

        expect(result.html).toContain('<title>My &lt;Task&gt; - OpenDesk</title>');
        expect(result.html).toContain('data-theme="dark"');
        expect(result.html).toContain('task-view data-task-view-cached');
        // 自然文档流：容器不携带视口锁定类，页面自身滚动
        expect(result.html).toContain('class="w-full px-3 pt-4" style="height:auto;overflow:visible;"');
        // 复刻 #app-root 祖先链，theme-dark.css 的 #app-root task-view 深色适配得以生效
        expect(result.html).toContain('id="app-root"');
        // 不复制应用外壳的 html class（防视口锁定等行为泄漏）
        expect(result.html).not.toMatch(/<html[^>]*class=/);
        // GUI 外壳的 body{overflow:hidden} 会经视口传播锁死整页滚动，必须强制覆盖
        expect(result.html).toContain('html, body { overflow: visible !important; height: auto !important; }');
        // 展开不做过渡动画（超大文档全页重排会卡顿）
        expect(result.html).toContain('transition: none !important');
        expect(result.html).toContain('exported');
        expect(result.html).toContain('.od-user-msg { background: #f4f3f1 }');
        // 思考块展开态样式随文档自带（抽取时无元素携带状态类，无法命中）
        expect(result.html).toContain('.reasoning-block-od.reasoning-expanded .reasoning-full-area');
        // 与 GUI 一致的思考块折叠交互脚本
        expect(result.html).toContain('reasoning-expanded');
        expect(result.html).toContain('"收起"');
        // 被正文引用的字体 URL 交给主进程内联
        expect(result.fontUrls).toEqual(['/fonts/maplemono/MapleMono-Regular.ttf.woff2']);
    });

    test('FontAwesome 字形规则无条件保留', () => {
        const doc = setupExportDoc([
            {
                cssRules: [
                    styleRule('.fa-list-check', '.fa-list-check { --fa: "\\f0ae" }'),
                    styleRule('.fa-unused-icon', '.fa-unused-icon { --fa: "\\f111" }'),
                    styleRule('.not-an-icon', '.not-an-icon { --fa: "\\f222" }'),
                    styleRule('.od-user-msg', '.od-user-msg { color: red }')
                ]
            }
        ]);
        const chatHistory = doc.querySelector('#taskview-chat-history');
        const { html } = buildTaskExportHtml({
            taskName: 't',
            contentHtml: '<div class="od-user-msg"><i class="fas fa-list-check"></i></div>',
            chatHistory,
            doc,
            reasoningCollapseLabel: '收起'
        });
        expect(html).toContain('--fa: "\\f0ae"');
        // 未出现在内容中的 FA 字形也保留（展开态等动态图标依赖）
        expect(html).toContain('--fa: "\\f111"');
        // 非 .fa-* 规则仍按命中过滤
        expect(html).not.toContain('--fa: "\\f222"');
        expect(html).toContain('color: red');
    });

    test('内容包含 fa 图标时以 CDN 兜底引入 Font Awesome（load 后异步加载，不阻塞渲染）', () => {
        const doc = setupExportDoc([]);
        const chatHistory = doc.querySelector('#taskview-chat-history');
        const { html } = buildTaskExportHtml({
            taskName: 't',
            contentHtml: '<div class="od-user-msg"><i class="fas fa-list-check"></i></div>',
            chatHistory,
            doc,
            reasoningCollapseLabel: '收起'
        });
        expect(html).toContain('fontawesome-free');
        expect(html).toContain("addEventListener('load'");
    });

    test('内容不含 fa 图标时不引入 Font Awesome CDN', () => {
        const doc = setupExportDoc([]);
        const chatHistory = doc.querySelector('#taskview-chat-history');
        const { html } = buildTaskExportHtml({
            taskName: 't',
            contentHtml: '<div class="od-user-msg">plain</div>',
            chatHistory,
            doc,
            reasoningCollapseLabel: '收起'
        });
        expect(html).not.toContain('fontawesome-free');
    });

    test('导出内容经过交互清理', () => {
        const doc = setupExportDoc([]);
        const chatHistory = doc.querySelector('#taskview-chat-history');
        const contentHtml = `
            <div class="od-user-msg-container">
                <div class="od-user-msg">exported</div>
                <div class="od-msg-meta-row">
                    <span class="od-msg-timestamp">刚刚</span>
                    <div class="od-msg-hover-menu"><button data-action="copy"></button></div>
                </div>
            </div>
            <div class="od-assistant-msg-container">
                <span class="message-usage"><span class="usage-spinner">s</span><span class="usage-text">1.2k</span></span>
            </div>`;
        const { html } = buildTaskExportHtml({
            taskName: 't',
            contentHtml,
            chatHistory,
            doc,
            reasoningCollapseLabel: '收起'
        });
        expect(html).toContain('od-msg-timestamp');
        expect(html).toContain('1.2k');
        expect(html).not.toContain('usage-spinner');
        expect(html).not.toContain('od-msg-hover-menu');
    });

    test('渲染 header（任务标题/时间/token 消耗/模型/版本）', () => {
        const doc = setupExportDoc([]);
        const chatHistory = doc.querySelector('#taskview-chat-history');
        const { html } = buildTaskExportHtml({
            taskName: 'Header Task',
            contentHtml: '<div class="od-user-msg">x</div>',
            chatHistory,
            doc,
            reasoningCollapseLabel: '收起',
            header: {
                title: 'Header Task',
                model: 'GLM-5.3-Flash',
                startedAt: '2026-09-06 10:00',
                exportedAt: '导出于 2026-09-06 17:00',
                generatedBy: '任务内容由 OpenDesk 0.3.6 版本生成',
                usage: { total: 12345, input: 8000, output: 4345 },
                labels: {
                    model: '模型',
                    startedAt: '启动于 2026-09-06 10:00',
                    exportedAt: '导出于 2026-09-06 17:00',
                    totalTokens: '总 TOKENS',
                    inputTokens: '上行（输入）',
                    outputTokens: '下行（输出）',
                    toggleToLight: '切换到浅色模式',
                    toggleToDark: '切换到深色模式'
                }
            }
        });
        expect(html).toContain('od-export-header-title">Header Task');
        expect(html).toContain('模型: GLM-5.3-Flash');
        expect(html).toContain('启动于 2026-09-06 10:00');
        expect(html).toContain('任务内容由 OpenDesk 0.3.6 版本生成');
        expect(html).toContain('12,345');
        expect(html).toContain('8,000');
        expect(html).toContain('4,345');
        expect(html).toContain('总 TOKENS');
    });

    test('header usage 携带 cacheHitRate 时渲染整体 cache 命中率胶囊', () => {
        const doc = setupExportDoc([]);
        const chatHistory = doc.querySelector('#taskview-chat-history');
        const { html } = buildTaskExportHtml({
            taskName: 't',
            contentHtml: '<div class="od-user-msg">x</div>',
            chatHistory,
            doc,
            reasoningCollapseLabel: '收起',
            header: {
                title: 't',
                exportedAt: '导出于 x',
                usage: { total: 45507, input: 11011, output: 1352, cacheRead: 34496, cacheMiss: 11011 },
                labels: {
                    model: '模型',
                    startedAt: '',
                    exportedAt: '导出于 x',
                    totalTokens: '总 TOKENS',
                    inputTokens: '上行（输入）',
                    outputTokens: '下行（输出）',
                    cacheHitRate: 'CACHE 命中率',
                    toggleToLight: '切换到浅色模式',
                    toggleToDark: '切换到深色模式'
                }
            }
        });
        expect(html).toContain('CACHE 命中率');
        expect(html).toContain('75.8%');
    });

    test('header usage 未携带 cache 拆分时不渲染 cache 胶囊', () => {
        const doc = setupExportDoc([]);
        const chatHistory = doc.querySelector('#taskview-chat-history');
        const { html } = buildTaskExportHtml({
            taskName: 't',
            contentHtml: '<div class="od-user-msg">x</div>',
            chatHistory,
            doc,
            reasoningCollapseLabel: '收起',
            header: {
                title: 't',
                exportedAt: '导出于 x',
                usage: { total: 12345, input: 8000, output: 4345 },
                labels: {
                    model: '模型',
                    startedAt: '',
                    exportedAt: '导出于 x',
                    totalTokens: '总 TOKENS',
                    inputTokens: '上行（输入）',
                    outputTokens: '下行（输出）',
                    cacheHitRate: 'CACHE 命中率',
                    toggleToLight: '切换到浅色模式',
                    toggleToDark: '切换到深色模式'
                }
            }
        });
        expect(html).not.toContain('CACHE 命中率');
    });

    test('包含主题切换按钮与切换脚本', () => {
        const doc = setupExportDoc([]);
        const chatHistory = doc.querySelector('#taskview-chat-history');
        const { html } = buildTaskExportHtml({
            taskName: 't',
            contentHtml: '',
            chatHistory,
            doc,
            reasoningCollapseLabel: '收起',
            header: {
                title: 't',
                exportedAt: '导出于 x',
                labels: {
                    model: '模型',
                    startedAt: '',
                    exportedAt: '导出于 x',
                    totalTokens: '总 TOKENS',
                    inputTokens: '输入',
                    outputTokens: '输出',
                    toggleToLight: '切换到浅色模式',
                    toggleToDark: '切换到深色模式'
                }
            }
        });
        expect(html).toContain('id="od-export-theme-toggle"');
        expect(html).toContain('"切换到浅色模式"');
        expect(html).toContain('"切换到深色模式"');
        expect(html).toContain("setAttribute('data-theme', theme)");
        expect(html).toContain('od-export-theme-toggle');
    });

    test('包含「查看过程」/过程段的展开态 CSS 与点击委托脚本', () => {
        const doc = setupExportDoc([]);
        const chatHistory = doc.querySelector('#taskview-chat-history');
        const { html } = buildTaskExportHtml({
            taskName: 't',
            contentHtml: `
                <section class="od-completed-process">
                    <button type="button" class="od-completed-process-summary" data-completed-process-toggle aria-expanded="false"><span>查看过程</span></button>
                    <div class="od-completed-process-detail">
                        <div class="od-process-segment">
                            <button type="button" class="od-process-summary" data-process-toggle aria-expanded="false"><span class="od-process-chevron"></span></button>
                            <div class="od-process-detail"></div>
                        </div>
                    </div>
                </section>`,
            chatHistory,
            doc,
            reasoningCollapseLabel: '收起'
        });
        // 展开态规则在导出时刻不命中任何元素，抽取阶段拿不到，必须由导出模板自带
        expect(html).toContain('.od-completed-process-detail.is-open');
        expect(html).toContain('.od-process-detail.is-open');
        expect(html).toContain('.od-completed-process.is-expanded .od-completed-process-chevron');
        expect(html).toContain("[aria-expanded='true'] > .od-process-chevron");
        // 点击事件委托需覆盖 completed-process 与 process-segment 两个分支
        expect(html).toContain("closest('[data-completed-process-toggle]')");
        expect(html).toContain("closest('[data-process-toggle]')");
        expect(html).toContain("classList.toggle('is-open'");
        expect(html).toContain("classList.toggle('is-expanded'");
    });

    test('未传 header 时不渲染 header 与切换按钮', () => {
        const doc = setupExportDoc([]);
        const chatHistory = doc.querySelector('#taskview-chat-history');
        const { html } = buildTaskExportHtml({
            taskName: 't',
            contentHtml: '',
            chatHistory,
            doc,
            reasoningCollapseLabel: '收起'
        });
        expect(html).not.toContain('class="od-export-header');
        expect(html).not.toContain('id="od-export-theme-toggle"');
    });
});
