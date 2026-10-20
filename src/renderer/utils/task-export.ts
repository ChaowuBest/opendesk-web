/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

/**
 * Task View HTML 导出模块。
 *
 * 与旧版导出（src/main/utils/export.ts 的独立模板）不同，本模块直接复用
 * TaskView 的真实渲染产物与 renderer 文档中的实时 CSS：
 *
 * 1. 调用方（TaskView）用与 GUI 完全相同的渲染管线生成全量消息 HTML
 *    （含 goal evaluation 卡片、代码块、工具卡片等）；
 * 2. 本模块在游离 DOM 中执行与 GUI 相同的代码块/预览增强，再把预览
 *    Shadow DOM 序列化为可静态打开的 iframe，并清理交互专用节点；
 * 3. 从 document.styleSheets 中提取「实际命中导出内容」的 CSS 规则
 *    （含 @media/@layer/@keyframes/@property 与字体声明），保证导出文件
 *    在无网络、无构建产物的环境下视觉效果与 GUI 对齐；
 * 4. 字体文件不直接内联（file:// 下 renderer 无法读取），而是收集 URL
 *    交给主进程（taskManager:saveExportHtml）替换为 data URI。
 */

import { enhanceCodeBlocks, enhanceToolPreviewCards } from '../components/previewer.ts';
import { escapeHtml } from '../../common/utils/escape.js';
import { formatPercent } from './format.js';

export interface TaskExportHeaderInfo {
    /** 任务标题 */
    title: string;
    /** 任务使用的模型标识（可选） */
    model?: string;
    /** 任务开始时间（已格式化，可选） */
    startedAt?: string;
    /** 导出时间（已格式化） */
    exportedAt: string;
    /** 「任务内容由 OpenDesk ${version} 版本生成」已本地化文案（可选） */
    generatedBy?: string;
    /** 累计 token 消耗；cacheRead/cacheMiss 为缓存命中与未命中的输入 token 数（对齐个人中心口径），两者齐备时渲染命中率胶囊 */
    usage?: { total: number; input: number; output: number; cacheRead?: number; cacheMiss?: number };
    /** 已本地化的标签文案 */
    labels: {
        model: string;
        startedAt: string;
        exportedAt: string;
        totalTokens: string;
        inputTokens: string;
        outputTokens: string;
        /** cache 命中率胶囊标签（usage.cacheHitRate 存在时使用） */
        cacheHitRate?: string;
        /** 切换到浅色 / 深色模式的按钮文案 */
        toggleToLight: string;
        toggleToDark: string;
    };
}

export interface TaskExportBuildOptions {
    /** 任务名（用于页面标题） */
    taskName: string;
    /**
     * 与 GUI 同管线渲染出的全量消息 HTML（含 goal evaluation 卡片）。
     * 传入分片数组时可避免超大任务的单次巨串解析/拼接。
     */
    contentHtml: string | string[];
    /** GUI 中真实的 #taskview-chat-history 元素，用于 CSS 命中判定与祖先链提取 */
    chatHistory: Element;
    /** 当前 renderer 文档（提供 styleSheets 与 html/body 属性） */
    doc: Document;
    /** 本地化文案：思考块「收起」标签（对齐 GUI 的 toggle 行为） */
    reasoningCollapseLabel: string;
    /** 顶部 header 信息（任务标题/时间/token 消耗/模型），缺省时不渲染 header */
    header?: TaskExportHeaderInfo;
}

export interface TaskExportResult {
    html: string;
    /** 需要主进程读取并内联为 data URI 的字体 URL 列表 */
    fontUrls: string[];
}

/** 与 TaskView 的 DOM sanitizer（taskview.js DANGEROUS_TAGS）一致的剥离策略 */
const DANGEROUS_TAGS = ['STYLE', 'SCRIPT', 'LINK', 'META', 'IFRAME', 'OBJECT', 'EMBED', 'APPLET', 'BASE'];

/** 导出时需要从 DOM 中剔除的交互专用节点（悬浮操作菜单、流式光标等） */
const CLEANUP_SELECTORS = [
    '.od-msg-hover-menu',
    '.stream-cursor',
    '.usage-spinner',
    '.waiting-usage-placeholder',
    '.od-attribution-placeholder'
];

/**
 * 导出页内联脚本：复刻 GUI 中思考块的折叠/展开交互（点击 header、
 * bubble 模式的悬停显示）、「查看过程」/过程段的展开收起
 * （对应 GUI 的 _handleProcessToggleClick），为序列化出的预览 iframe
 * 自适应高度（GUI 中由 iframe load 回调完成，静态页需要自己补上），
 * 并提供深色/浅色主题切换（记忆在 localStorage，打开时恢复）。
 */
function buildExportScript(reasoningCollapseLabel: string, header?: TaskExportHeaderInfo): string {
    const collapseLabel = JSON.stringify(reasoningCollapseLabel);
    const toggleToLight = JSON.stringify(header?.labels.toggleToLight ?? '');
    const toggleToDark = JSON.stringify(header?.labels.toggleToDark ?? '');
    return `
(function () {
    var collapseLabel = ${collapseLabel};
    document.addEventListener('click', function (e) {
        var header = e.target.closest('.reasoning-block-od.reasoning-completed .reasoning-header');
        if (!header) return;
        var wrapper = header.closest('.reasoning-block-od');
        if (!wrapper) return;
        var bubble = wrapper.querySelector('.reasoning-bubble');
        if (bubble) {
            var isPinned = wrapper.classList.toggle('reasoning-bubble-pinned');
            bubble.classList.toggle('reasoning-bubble-hidden', !isPinned);
            wrapper.classList.toggle('reasoning-content-visible', isPinned);
            return;
        }
        var isExpanded = wrapper.classList.toggle('reasoning-expanded');
        wrapper.classList.toggle('reasoning-content-visible', isExpanded);
        var toggle = wrapper.querySelector('.reasoning-toggle');
        if (toggle) toggle.textContent = isExpanded ? collapseLabel : '';
    });
    document.addEventListener('click', function (e) {
        var completedToggle = e.target.closest('[data-completed-process-toggle]');
        if (completedToggle) {
            var process = completedToggle.closest('.od-completed-process');
            if (!process) return;
            var expanded = completedToggle.getAttribute('aria-expanded') !== 'true';
            completedToggle.setAttribute('aria-expanded', String(expanded));
            process.classList.toggle('is-expanded', expanded);
            var detail = process.querySelector(':scope > .od-completed-process-detail');
            if (detail) detail.classList.toggle('is-open', expanded);
            return;
        }
        var processToggle = e.target.closest('[data-process-toggle]');
        if (processToggle) {
            var segment = processToggle.closest('.od-process-segment');
            if (!segment) return;
            var segmentExpanded = processToggle.getAttribute('aria-expanded') !== 'true';
            processToggle.setAttribute('aria-expanded', String(segmentExpanded));
            segment.classList.toggle('is-expanded', segmentExpanded);
            var segmentDetail = segment.querySelector(':scope > .od-process-detail');
            if (segmentDetail) segmentDetail.classList.toggle('is-open', segmentExpanded);
        }
    });
    document.addEventListener('mouseover', function (e) {
        var header = e.target.closest('.reasoning-block-od.reasoning-completed .reasoning-header');
        if (!header) return;
        var wrapper = header.closest('.reasoning-block-od');
        if (!wrapper || wrapper.classList.contains('reasoning-bubble-pinned')) return;
        var bubble = wrapper.querySelector('.reasoning-bubble');
        if (bubble) {
            bubble.classList.remove('reasoning-bubble-hidden');
            wrapper.classList.add('reasoning-content-visible');
        }
    });
    document.addEventListener('mouseout', function (e) {
        var fromHeader = e.target.closest('.reasoning-block-od.reasoning-completed .reasoning-header');
        var fromBubble = e.target.closest('.reasoning-bubble');
        if (!fromHeader && !fromBubble) return;
        var wrapper = e.target.closest('.reasoning-block-od.reasoning-completed');
        if (!wrapper || wrapper.classList.contains('reasoning-bubble-pinned')) return;
        var bubble = wrapper.querySelector('.reasoning-bubble');
        if (bubble && !wrapper.matches(':hover')) {
            bubble.classList.add('reasoning-bubble-hidden');
            wrapper.classList.remove('reasoning-content-visible');
        }
    });
    document.querySelectorAll('iframe[data-od-preview]').forEach(function (frame) {
        var fit = function () {
            try {
                var doc = frame.contentDocument;
                if (!doc) return;
                var h = Math.max(
                    (doc.documentElement && doc.documentElement.scrollHeight) || 0,
                    (doc.body && doc.body.scrollHeight) || 0
                );
                if (h > 0) frame.style.height = h + 'px';
            } catch (err) { /* 跨源限制时保持默认高度 */ }
        };
        frame.addEventListener('load', fit);
        fit();
    });
    var toggleBtn = document.getElementById('od-export-theme-toggle');
    if (toggleBtn) {
        var toLightLabel = ${toggleToLight};
        var toDarkLabel = ${toggleToDark};
        var applyTheme = function (theme) {
            document.documentElement.setAttribute('data-theme', theme);
            var isDark = theme === 'dark';
            var label = isDark ? toLightLabel : toDarkLabel;
            toggleBtn.title = label;
            var labelEl = toggleBtn.querySelector('.od-export-toggle-label');
            if (labelEl) labelEl.textContent = label;
            var sun = toggleBtn.querySelector('.od-export-icon-sun');
            var moon = toggleBtn.querySelector('.od-export-icon-moon');
            if (sun) sun.style.display = isDark ? '' : 'none';
            if (moon) moon.style.display = isDark ? 'none' : '';
            try { localStorage.setItem('od-export-theme', theme); } catch (err) { /* file:// 下可能受限 */ }
        };
        toggleBtn.addEventListener('click', function () {
            var current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
            applyTheme(current === 'dark' ? 'light' : 'dark');
        });
        var saved = null;
        try { saved = localStorage.getItem('od-export-theme'); } catch (err) { /* ignore */ }
        if (saved === 'light' || saved === 'dark') applyTheme(saved);
        else {
            var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
            var label = isDark ? toLightLabel : toDarkLabel;
            var labelEl = toggleBtn.querySelector('.od-export-toggle-label');
            if (labelEl) labelEl.textContent = label;
            var sun = toggleBtn.querySelector('.od-export-icon-sun');
            var moon = toggleBtn.querySelector('.od-export-icon-moon');
            if (sun) sun.style.display = isDark ? '' : 'none';
            if (moon) moon.style.display = isDark ? 'none' : '';
        }
    }
})();
`.trim();
}

/**
 * 剥离消息内容中的危险标签。TaskView 的实时 DOM 由 MutationObserver sanitizer
 * 守护，而导出走游离 DOM 渲染，必须在导出侧镜像同样的剥离策略。
 * 注意：须在 serializePreviewHosts 之前调用，预览 iframe 属于导出自身的安全产物。
 */
export function removeDangerousTags(container: Element): void {
    container.querySelectorAll(DANGEROUS_TAGS.join(',')).forEach((el) => el.remove());
}

/**
 * 清理空资源引用（src=""/href=""）。空 URL 会解析成文档自身地址，
 * 在 file: 打开的导出文件中触发「file: URLs are treated as unique
 * security origins」报错刷屏。
 */
export function stripEmptyResourceRefs(container: Element): void {
    container.querySelectorAll('[src=""], [href=""]').forEach((el) => {
        if (el.getAttribute('src') === '') el.removeAttribute('src');
        if (el.getAttribute('href') === '') el.removeAttribute('href');
    });
}

/**
 * 清理导出内容中仅服务于实时会话的交互节点。
 * 时间戳、usage 胶囊文本、思考块 header 等静态信息全部保留。
 */
export function cleanExportContainer(container: Element): void {
    for (const selector of CLEANUP_SELECTORS) {
        container.querySelectorAll(selector).forEach((el) => el.remove());
    }
    // 编辑态用户气泡：textarea 无法在静态 HTML 中还原原始文本，退回普通展示态
    container.querySelectorAll('.od-user-msg-editing').forEach((el) => {
        el.classList.remove('od-user-msg-editing');
        el.querySelectorAll('.od-user-msg-editor').forEach((editor) => editor.remove());
    });
    // 预览增强产生的交互控件（复制按钮、预览开关）在导出中无意义
    container.querySelectorAll('.code-copy-btn, .code-preview-toggle').forEach((el) => el.remove());
}

/**
 * 把 GUI 中由 Shadow DOM 承载的实时代码预览（iframe / SVG）序列化为
 * 可静态打开的普通节点。Shadow DOM 不会随 outerHTML 序列化，必须显式搬运。
 */
export function serializePreviewHosts(container: Element, doc: Document): void {
    container.querySelectorAll('.code-preview-shadow-host').forEach((host) => {
        const shadowRoot = (host as HTMLElement).shadowRoot;
        if (!shadowRoot) {
            host.remove();
            return;
        }
        const iframe = shadowRoot.querySelector('iframe');
        if (iframe) {
            const staticFrame = doc.createElement('iframe');
            for (const attr of Array.from(iframe.attributes)) {
                staticFrame.setAttribute(attr.name, attr.value);
            }
            // srcdoc 内的空资源引用会解析成导出页自身 URL，触发 file: 唯一源安全报错
            const srcdoc = staticFrame.getAttribute('srcdoc');
            if (srcdoc !== null) {
                staticFrame.setAttribute('srcdoc', srcdoc.replace(/\s(src|href)=(""|'')/gi, ''));
            }
            if (!staticFrame.getAttribute('style')) {
                staticFrame.setAttribute('style', iframe.style.cssText);
            }
            staticFrame.setAttribute('sandbox', 'allow-same-origin');
            staticFrame.setAttribute('data-od-preview', '1');
            host.replaceWith(staticFrame);
            return;
        }
        // SVG 预览：shadow 内是一个普通包装 div，直接克隆进光域
        const firstChild = shadowRoot.firstElementChild;
        if (firstChild) {
            host.replaceWith(firstChild.cloneNode(true));
        } else {
            host.remove();
        }
    });
}

interface FontFaceRecord {
    cssText: string;
    family: string;
    urls: string[];
}

const FONT_URL_PATTERN = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/**
 * 相对字体 URL（构建产物中的 url(./fa-xxx.woff2) 等）按样式表地址解析为
 * 绝对 URL：主进程只认 file://、localhost http 与 / 开头的应用根相对路径，
 * 相对路径解析失败会导致字体不内联、导出页图标（FA/KaTeX）不可见。
 */
function resolveFontUrl(rawUrl: string, baseHref: string | null): string {
    if (!baseHref) return rawUrl;
    try {
        return new URL(rawUrl, baseHref).href;
    } catch {
        return rawUrl;
    }
}

function extractFontFaceRecord(rule: unknown, baseHref: string | null): FontFaceRecord | null {
    const typed = rule as { style?: CSSStyleDeclaration; cssText?: string };
    let cssText = '';
    let family = '';
    let src = '';
    const style = typed.style as (CSSStyleDeclaration & { getPropertyValue?: unknown }) | undefined;
    if (style && typeof style.getPropertyValue === 'function') {
        cssText = `@font-face { ${style.cssText} }`;
        family = style.getPropertyValue('font-family');
        src = style.getPropertyValue('src');
    } else {
        cssText = String(typed.cssText || '');
        family = /font-family\s*:\s*([^;]+)[;}]/.exec(cssText)?.[1] || '';
        src = /src\s*:\s*([^;]+)[;}]/.exec(cssText)?.[1] || '';
    }
    family = family
        .trim()
        .replace(/^(['"])(.*)\1$/, '$2')
        .trim();
    if (!family) return null;
    const urls: string[] = [];
    for (const match of src.matchAll(FONT_URL_PATTERN)) {
        if (!match[2]) continue;
        const resolved = resolveFontUrl(match[2], baseHref);
        if (!urls.includes(resolved)) urls.push(resolved);
        // 输出的 cssText 同步改写为绝对 URL，主进程才能按 URL 定位并替换为 data URI
        if (resolved !== match[2]) {
            cssText = cssText.split(match[2]).join(resolved);
        }
    }
    return { cssText, family, urls };
}

function ruleCssText(rule: unknown): string {
    const typed = rule as { cssText?: string; style?: CSSStyleDeclaration; selectorText?: string };
    if (typed.cssText) return typed.cssText;
    if (typed.style && typed.selectorText) {
        return `${typed.selectorText} { ${typed.style.cssText} }`;
    }
    return '';
}

// ── 选择器命中判定 ──────────────────────────────────────────────
//
// 全量规则 × 全量元素的暴力 matches() 在长会话下不可接受，这里采用
// 「最右复合键索引预筛 + 原生 querySelector 精查」：
// 1. 预筛：提取选择器最右侧复合块中的 class/id/tag，任一键在导出内容中
//    不存在即可整条跳过（与浏览器引擎的选择器匹配策略同思路）；
// 2. 精查：对存活选择器用 querySelector(All) 在真实 GUI 上下文与游离
//    导出树中判定，天然支持 `task-view .x`、`html[data-theme] .x` 等
//    作用域选择器，无需在导出文档中复刻祖先链再逐元素 matches。

interface SelectorKeyIndex {
    classes: Set<string>;
    ids: Set<string>;
    tags: Set<string>;
}

/** 按顶层逗号切分选择器列表（忽略字符串/括号/方括号内的逗号） */
function splitSelectorList(selectorText: string): string[] {
    const parts: string[] = [];
    let depthParen = 0;
    let depthBracket = 0;
    let inString: string | null = null;
    let current = '';
    for (let i = 0; i < selectorText.length; i++) {
        const ch = selectorText[i];
        if (inString) {
            current += ch;
            if (ch === '\\' && i + 1 < selectorText.length) {
                current += selectorText[++i];
            } else if (ch === inString) {
                inString = null;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            inString = ch;
            current += ch;
            continue;
        }
        if (ch === '\\' && i + 1 < selectorText.length) {
            current += ch + selectorText[++i];
            continue;
        }
        if (ch === '(') depthParen++;
        if (ch === ')') depthParen = Math.max(0, depthParen - 1);
        if (ch === '[') depthBracket++;
        if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);
        if (ch === ',' && depthParen === 0 && depthBracket === 0) {
            parts.push(current);
            current = '';
            continue;
        }
        current += ch;
    }
    if (current.trim()) parts.push(current);
    return parts;
}

/** 取选择器最右侧的复合块（最后一个顶层组合符之后的部分） */
function rightmostCompound(complexSelector: string): string {
    let depthParen = 0;
    let depthBracket = 0;
    let inString: string | null = null;
    let start = 0;
    for (let i = 0; i < complexSelector.length; i++) {
        const ch = complexSelector[i];
        if (inString) {
            if (ch === '\\' && i + 1 < complexSelector.length) i++;
            else if (ch === inString) inString = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            inString = ch;
            continue;
        }
        if (ch === '\\') {
            i++;
            continue;
        }
        if (ch === '(') depthParen++;
        if (ch === ')') depthParen = Math.max(0, depthParen - 1);
        if (ch === '[') depthBracket++;
        if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);
        if (depthParen === 0 && depthBracket === 0) {
            const isCombinator =
                ch === '>' || ch === '+' || ch === '~' || (ch === ' ' && i + 1 < complexSelector.length);
            if (isCombinator) start = i + 1;
        }
    }
    return complexSelector.slice(start).trim();
}

/** 从复合块中提取 class / id / tag 键（无法可靠提取的返回 null） */
function extractCompoundKeys(compound: string): { classes: string[]; ids: string[]; tag: string | null } {
    const classes: string[] = [];
    const ids: string[] = [];
    let tag: string | null = null;
    const tokenPattern = /([.#])((?:\\.|[-\w])+)|^([*a-zA-Z][-\w]*)/g;
    for (const match of compound.matchAll(tokenPattern)) {
        if (match[1] === '.') {
            classes.push(match[2].replace(/\\/g, ''));
        } else if (match[1] === '#') {
            ids.push(match[2].replace(/\\/g, ''));
        } else if (match[3] && match[3] !== '*' && tag === null) {
            tag = match[3].toLowerCase();
        }
    }
    return { classes, ids, tag };
}

function buildSelectorKeyIndex(elements: Iterable<Element>): SelectorKeyIndex {
    const index: SelectorKeyIndex = { classes: new Set(), ids: new Set(), tags: new Set() };
    for (const el of elements) {
        for (const cls of el.classList) index.classes.add(cls);
        if (el.id) index.ids.add(el.id);
        index.tags.add(el.tagName.toLowerCase());
    }
    return index;
}

/** 预筛：选择器列表中每个备选的右侧键都找不到对应元素时，整条规则可跳过 */
function selectorMayMatch(selectorText: string, index: SelectorKeyIndex): boolean {
    for (const part of splitSelectorList(selectorText)) {
        const compound = rightmostCompound(part);
        const { classes, ids, tag } = extractCompoundKeys(compound);
        if (classes.length && classes.every((c) => !index.classes.has(c))) continue;
        if (ids.length && ids.every((i) => !index.ids.has(i))) continue;
        if (tag !== null && !index.tags.has(tag)) continue;
        return true;
    }
    return false;
}

/**
 * 判定选择器是否命中导出内容：
 * - html/body 与真实 GUI 祖先链上的元素直接 matches；
 * - 真实聊天子树与游离导出树用 querySelector 判定（支持作用域选择器）；
 * - 引擎解析失败时保守保留（宁多勿缺）。
 */
/**
 * html[data-theme='dark'/'light'] / html:not([data-theme]) / 裸 [data-theme='...']
 * 前缀（含主题条件的作用域选择器）。导出文件需要支持深浅色切换，因此这类规则
 * 不能按当前主题过滤——把主题条件替换为恒真的 :root 后再判定，两套主题的规则
 * 都会保留，打开文件时由浏览器按当前 data-theme 生效其中一套。
 */
const THEME_SCOPE_PATTERN =
    /html\[data-theme(?:=(?:['"]?)?(?:light|dark)(?:['"]?)?)?\]|html:not\(\[data-theme(?:=(?:['"]?)?(?:light|dark)(?:['"]?)?)?\]\)|(^|\s)\[data-theme(?:=(?:['"]?)?(?:light|dark)(?:['"]?)?)?\]/gi;

function selectorHitsDocument(selectorText: string, ctx: SelectorMatchContext): boolean {
    if (selectorHitsRaw(selectorText, ctx)) return true;
    // 主题作用域规则：用 :root 变体做结构命中判定，保留原始选择器输出
    const themeVariant = selectorText.replace(THEME_SCOPE_PATTERN, (_match, leading: string | undefined) =>
        leading !== undefined ? `${leading}:root` : ':root'
    );
    if (themeVariant !== selectorText) {
        return selectorHitsRaw(themeVariant, ctx);
    }
    return false;
}

/** FontAwesome 字形规则选择器（.fa-xxx { --fa: "\..." }），无条件保留 */
const FA_GLYPH_SELECTOR_PATTERN = /^\.fa-[-\w]+$/i;

/** 尾部伪元素（::before / ::-webkit-scrollbar 等） */
const TRAILING_PSEUDO_ELEMENT_PATTERN = /::[-a-zA-Z]+(\([^)]*\))?$/;

/**
 * 引擎判定单个选择器：
 * 返回 true（命中）/ false（选择器可解析但不命中）/ null（引擎无法解析）。
 * 注意 Chromium 对伪元素选择器不抛异常，而是静默返回 false。
 */
function engineSelectorOutcome(selector: string, ctx: SelectorMatchContext): boolean | null {
    const matchRoots: (Element | null)[] = [ctx.doc.documentElement, ctx.doc.body, ctx.liveRoot, ctx.container];
    const queryRoots: (Element | null)[] = [ctx.liveRoot, ctx.container];
    let parsed = true;
    for (const root of matchRoots) {
        if (!root) continue;
        try {
            if (root.matches(selector)) return true;
        } catch {
            // 继续：交给其它根/游离树
        }
    }
    for (const root of queryRoots) {
        if (!root) continue;
        try {
            if (root.querySelector(selector)) return true;
        } catch {
            parsed = false;
        }
    }
    return parsed ? false : null;
}

function selectorHitsRaw(selectorText: string, ctx: SelectorMatchContext): boolean {
    let selector = selectorText.trim();
    if (!selector) return false;
    // FontAwesome 6/7 以「.fa-xxx { --fa: "\..." }」的纯自定义属性规则定义字形，
    // 图标类名可能尚未出现在任何元素上（展开态图标等），无条件保留以保证可用。
    if (FA_GLYPH_SELECTOR_PATTERN.test(selector)) return true;
    for (;;) {
        const outcome = engineSelectorOutcome(selector, ctx);
        if (outcome === true) return true;
        // 引擎能解析但不命中时，若选择器带尾部伪元素（::before/::after 等），
        // 引擎的「不命中」不代表规则无用（伪元素永远不作为元素命中）——
        // 必须剥掉伪元素后用剩余选择器再判定，否则所有伪元素规则都会被误丢
        //（FA 图标渲染规则 :is(.fas,.far,...)::before { content: var(--fa) } 就在其中）。
        if (TRAILING_PSEUDO_ELEMENT_PATTERN.test(selector)) {
            const stripped = selector.replace(TRAILING_PSEUDO_ELEMENT_PATTERN, '').trim();
            if (stripped) {
                selector = stripped;
                continue;
            }
            return true;
        }
        if (outcome === false) return false;
        // 引擎无法解析（中段伪元素等）：剥伪元素重试，仍失败则保守保留
        if (TRAILING_PSEUDO_ELEMENT_PATTERN.test(selector)) {
            const stripped = selector.replace(TRAILING_PSEUDO_ELEMENT_PATTERN, '').trim();
            if (stripped) {
                selector = stripped;
                continue;
            }
        }
        return true; // 保守保留
    }
}

interface SelectorMatchContext {
    doc: Document;
    /** GUI 中真实的 task-view 元素（含聊天历史子树） */
    liveRoot: Element | null;
    /** 游离的导出渲染树根（带 #taskview-chat-history 同款 id/class） */
    container: Element;
}

/**
 * 遍历 CSSOM 规则树，收集命中导出内容的规则文本与字体声明。
 * 分组规则（@media/@supports/@layer 块）递归处理后仅保留命中的子规则。
 * baseHref 为所在样式表的地址，用于解析字体相对 URL。
 */
function walkCssRules(
    rules: CSSRuleList | CSSRule[],
    ctx: SelectorMatchContext,
    out: string[],
    fontFaces: FontFaceRecord[],
    baseHref: string | null
): void {
    for (const rule of Array.from(rules)) {
        const typed = rule as {
            selectorText?: string;
            cssRules?: CSSRuleList;
            conditionText?: string;
            media?: unknown;
            name?: string;
            style?: CSSStyleDeclaration;
        };
        if (typed.selectorText !== undefined && typed.selectorText !== null) {
            // FA 字形规则跳过预筛（类名可能尚未出现在任何元素上）
            if (
                FA_GLYPH_SELECTOR_PATTERN.test(typed.selectorText.trim()) ||
                (selectorMayMatch(typed.selectorText, ctx.keyIndex) && selectorHitsDocument(typed.selectorText, ctx))
            ) {
                out.push(ruleCssText(rule));
            }
            continue;
        }
        if (typed.cssRules !== undefined && typed.cssRules !== null) {
            // @keyframes 等带 name 的动画分组整体保留，不做子规则过滤
            if (typed.name && looksLikeKeyframesRule(rule, typed.cssRules)) {
                out.push(ruleCssText(rule));
                continue;
            }
            const inner: string[] = [];
            walkCssRules(typed.cssRules, ctx, inner, fontFaces, baseHref);
            if (inner.length === 0) continue;
            if (typed.media !== undefined && typed.conditionText) {
                out.push(`@media ${typed.conditionText} {\n${inner.join('\n')}\n}`);
            } else if (typed.conditionText) {
                out.push(`@supports ${typed.conditionText} {\n${inner.join('\n')}\n}`);
            } else if (typed.name) {
                out.push(`@layer ${typed.name} {\n${inner.join('\n')}\n}`);
            } else {
                out.push(ruleCssText(rule));
            }
            continue;
        }
        if (typed.style && typed.selectorText === undefined && (typed as { keyText?: string }).keyText === undefined) {
            const record = extractFontFaceRecord(rule, baseHref);
            if (record) fontFaces.push(record);
            continue;
        }
        // @property、@layer 语句、@counter-style 等原样保留
        const cssText = ruleCssText(rule);
        if (!cssText) continue;
        // 无 style 属性的 @font-face 形态（测试桩/部分 CSSOM 实现）：从 cssText 提取
        if (/^@font-face\b/i.test(cssText.trim())) {
            const record = extractFontFaceRecord(rule, baseHref);
            if (record) {
                fontFaces.push(record);
                continue;
            }
        }
        out.push(cssText);
    }
}

/**
 * CSSKeyframesRule 与 CSSLayerBlockRule 都带 name 属性，
 * 用子规则的 keyText 及 cssText 前缀嗅探区分，避免把 @keyframes
 * 误重建为 @layer（会污染导出文档的 layer 顺序）。
 */
function looksLikeKeyframesRule(rule: unknown, rules: CSSRuleList | CSSRule[]): boolean {
    const first = rules[0] as { keyText?: string } | undefined;
    if (first && first.keyText !== undefined) return true;
    return /@keyframes\b/i.test(ruleCssText(rule));
}

/**
 * 从文档样式表中提取导出内容实际用到的 CSS。
 *
 * 命中判定的上下文由两部分组成：
 * - 游离的导出渲染树（覆盖尚未载入 DOM 的历史消息类名）；
 * - 真实 GUI 文档上下文（html/body/task-view 元素），使作用域选择器得以命中。
 *
 * 真实子树中仅存在于会话期的节点（悬浮菜单等）会带来少量冗余规则，无害。
 */
export function collectUsedCss(
    doc: Document,
    options: { liveRoot: Element | null; container: Element }
): { cssText: string; fontUrls: string[] } {
    const container = options.container;
    const keyElements: Element[] = [
        doc.documentElement,
        doc.body,
        container,
        ...Array.from(container.querySelectorAll('*'))
    ];
    if (options.liveRoot) {
        keyElements.push(options.liveRoot, ...Array.from(options.liveRoot.querySelectorAll('*')));
    }
    const ctx: SelectorMatchContext & { keyIndex: SelectorKeyIndex } = {
        doc,
        liveRoot: options.liveRoot,
        container,
        keyIndex: buildSelectorKeyIndex(keyElements)
    };

    const rulesOut: string[] = [];
    const fontFaces: FontFaceRecord[] = [];
    for (const sheet of Array.from(doc.styleSheets)) {
        let rules: CSSRuleList;
        try {
            rules = sheet.cssRules;
        } catch {
            continue; // 跨源样式表不可枚举，跳过
        }
        if (!rules) continue;
        // 字体相对 URL 的解析基准：优先样式表自身地址（link 加载），
        // 退回文档地址（style 注入/dev server 场景）
        const sheetHref = (sheet as CSSStyleSheet).href || null;
        const baseHref = sheetHref || doc.baseURI || null;
        walkCssRules(rules, ctx, rulesOut, fontFaces, baseHref);
    }
    const bodyCss = rulesOut.join('\n');
    // 只保留正文 CSS 真正引用到的字体族，避免把未使用的 KaTeX/LXGW 字体全部内联
    const usedFontFaces = fontFaces.filter((face) => bodyCss.includes(face.family));
    const fontUrls: string[] = [];
    for (const face of usedFontFaces) {
        for (const url of face.urls) {
            if (!fontUrls.includes(url)) fontUrls.push(url);
        }
    }
    const cssText = `${bodyCss}\n${usedFontFaces.map((f) => f.cssText).join('\n')}`;
    return { cssText, fontUrls };
}

/**
 * 组装最终导出文档。
 * 返回的 html 中字体仍以原始 URL 引用，由主进程在写盘前内联为 data URI。
 */
export function buildTaskExportHtml(options: TaskExportBuildOptions): TaskExportResult {
    const { taskName, contentHtml, chatHistory, doc, reasoningCollapseLabel, header } = options;

    // 1. 在游离 DOM 中复刻 GUI 的渲染结果：同管线渲染 + 同款代码块/预览增强
    const container = doc.createElement('div');
    container.id = 'taskview-chat-history';
    // 与导出模板中的容器类保持一致：导出为自然文档流，不再携带
    // h-full / overflow-y-auto 这类视口锁定类（否则内容被钳制在首屏高度内）
    container.className = 'w-full px-3 pt-4';
    appendContentFragments(container, contentHtml);
    enhanceCodeBlocks(container as HTMLElement);
    enhanceToolPreviewCards(container as HTMLElement);
    removeDangerousTags(container);
    serializePreviewHosts(container, doc);
    cleanExportContainer(container);
    stripEmptyResourceRefs(container);

    // 2. 提取实际用到的 CSS（真实 GUI 上下文 + 游离导出树；主题作用域规则双主题保留）
    const liveRoot = chatHistory.closest('task-view');
    const { cssText, fontUrls } = collectUsedCss(doc, { liveRoot, container });

    // 3. 复刻 html 属性与静态祖先链，保证作用域选择器在导出页同样命中。
    //    html/body 的 class 不复制：那是应用外壳的布局/状态类，带入导出页
    //    可能引入视口锁定（如 overflow-hidden）等与文档流冲突的行为。
    const htmlAttrs = copyElementAttributes(doc.documentElement, ['lang', 'data-theme', 'data-font-preset']);
    const content = container.innerHTML;
    const headerHtml = header ? buildExportHeaderHtml(header) : '';
    // 字体以内联 data URI 为主；CDN 仅作为字体解析失败时的兜底（load 后异步
    // 加载，离线打开不阻塞渲染，也不产生无谓请求——内容无 fa 图标时不注入）
    const faCdnLoader = container.querySelector('[class*="fa-"]') ? buildFaCdnLoaderScript() : '';

    const html = `<!DOCTYPE html>
<html ${htmlAttrs}>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(taskName)} - OpenDesk</title>
    <style>
html, body { margin: 0; padding: 0; }
task-view { display: block; }
${cssText}
/* GUI 外壳把 body 设为 overflow:hidden（滚动由面板自己管理），且 body 的
   overflow 会传播给视口——必须强制覆盖，否则导出页整页不可滚动、滚动条消失 */
html, body { overflow: visible !important; height: auto !important; }
#app-root, #rightPanelInner { height: auto !important; overflow: visible !important; }
${EXPORT_EXTRA_STYLES}
    </style>
</head>
<body>
<div id="app-root">
<div id="rightPanelInner" style="min-height:100vh;background:var(--od-bg-elevated) !important;">
<task-view data-task-view-cached="1" style="display:block;">
${headerHtml}
<div style="width:100%;max-width:900px;margin:0 auto;padding-bottom:32px;">
<div id="taskview-chat-history" class="w-full px-3 pt-4" style="height:auto;overflow:visible;">
${content}
</div>
</div>
</task-view>
</div>
</div>
${header ? buildThemeToggleHtml() : ''}
<script>
${buildExportScript(reasoningCollapseLabel, header)}
</script>
${faCdnLoader}
</body>
</html>`;

    return { html, fontUrls };
}

/**
 * 导出页自有样式：header（任务标题/时间/token 消耗/模型）、主题切换按钮，
 * 以及思考块/「查看过程」/过程段的展开态样式。展开态（reasoning-expanded /
 * reasoning-content-visible、is-open / is-expanded / aria-expanded）在导出时刻
 * 没有任何元素携带，对应的 custom.css 规则不会被抽取命中，这里必须随文档自带
 * （取值与 custom.css 保持一致，主题色差异由 theme-dark.css 经 #app-root
 * 作用域规则补齐）。
 */
const EXPORT_EXTRA_STYLES = `
.od-export-header {
    width: 100%;
    max-width: 900px;
    margin: 0 auto;
    padding: 20px 12px 8px;
    box-sizing: border-box;
}
.od-export-header-title {
    font-size: 18px;
    font-weight: 700;
    color: var(--chat-ink);
    line-height: 1.4;
    overflow-wrap: break-word;
}
.od-export-header-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    margin-top: 6px;
    font-size: var(--fs-sm);
    color: var(--chat-ink3);
}
.od-export-header-usage {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 10px;
}
.od-export-token {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 10px;
    border-radius: 10px;
    background: var(--chat-hover);
    font-size: var(--fs-xs);
    color: var(--chat-ink3);
}
.od-export-token .od-export-token-value {
    color: var(--chat-ink2);
    font-family: var(--font-mono);
}
#od-export-theme-toggle {
    position: fixed;
    top: 14px;
    right: 16px;
    z-index: 50;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 12px;
    border: 1px solid var(--od-border);
    border-radius: 15px;
    background: var(--od-bg-elevated);
    color: var(--od-text-muted);
    font-size: var(--fs-sm);
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;
}
#od-export-theme-toggle:hover {
    background: var(--chat-hover);
    color: var(--od-text);
}
#od-export-theme-toggle svg {
    width: 13px;
    height: 13px;
    flex-shrink: 0;
}
/* 思考块展开态（对应 custom.css 的 reasoning-expanded / reasoning-content-visible 规则） */
.reasoning-block-od.reasoning-expanded .reasoning-full-area {
    max-height: 200px;
    overflow-y: auto;
    opacity: 1;
    margin-top: 2px;
}
.reasoning-block-od.reasoning-content-visible .reasoning-header span {
    color: #d97706 !important;
}
.reasoning-block-od.reasoning-content-visible .reasoning-header i.fa-lightbulb {
    color: #f59e0b !important;
}
/* 思考块展开/收起不做过渡动画：导出文档可能有数十万像素高，
   max-height 过渡的每一帧都会触发全文档重排，导致展开时极度卡顿 */
.reasoning-block-od .reasoning-full-area,
.reasoning-block-od .reasoning-preview-area {
    transition: none !important;
}
/* 「查看过程」与过程段的展开态（对应 custom.css 的 is-open / is-expanded /
   aria-expanded 规则）：导出时刻没有任何元素携带这些状态，抽取不会命中，
   必须随文档自带（取值与 custom.css 保持一致） */
.od-completed-process.is-expanded .od-completed-process-chevron {
    transform: rotate(90deg);
}
.od-completed-process-detail.is-open {
    display: block;
    max-height: none;
    overflow: visible;
}
.od-process-summary:hover .od-process-action,
.od-process-summary:focus-visible .od-process-action {
    color: var(--chat-green);
}
[aria-expanded='true'] > .od-process-chevron {
    transform: rotate(90deg);
}
.od-process-summary[aria-expanded='true'] .od-process-chevron {
    transform: rotate(90deg);
}
.od-process-detail.is-open {
    display: block;
}`;

/**
 * Font Awesome CDN 兜底样式表地址。版本需与 package.json 中
 * @fortawesome/fontawesome-free 保持一致，避免字形集合/码点漂移。
 */
const FA_CDN_CSS_URL = 'https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@7.3.1/css/all.min.css';

/** load 后异步注入 FA CDN 样式表：不阻塞首帧渲染，离线时静默失败 */
function buildFaCdnLoaderScript(): string {
    return `<script>
window.addEventListener('load', function () {
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '${FA_CDN_CSS_URL}';
    document.head.appendChild(link);
});
</script>`;
}

const SUN_ICON_SVG =
    '<svg class="od-export-icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none;"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
const MOON_ICON_SVG =
    '<svg class="od-export-icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none;"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';

/** 顶部 header：对齐 GUI 任务视图的信息展示（标题/时间/token 消耗/模型） */
function buildExportHeaderHtml(header: TaskExportHeaderInfo): string {
    const metaParts: string[] = [];
    if (header.model) {
        metaParts.push(`<span>${escapeHtml(header.labels.model)}: ${escapeHtml(header.model)}</span>`);
    }
    if (header.startedAt) {
        metaParts.push(`<span>${escapeHtml(header.labels.startedAt)}</span>`);
    }
    metaParts.push(`<span>${escapeHtml(header.labels.exportedAt)}</span>`);
    if (header.generatedBy) {
        metaParts.push(`<span>${escapeHtml(header.generatedBy)}</span>`);
    }

    let usageHtml = '';
    if (header.usage) {
        const fmt = (value: number) => Number(value || 0).toLocaleString();
        // 整体 cache 命中率：命中 /（命中 + 未命中），口径与个人中心使用统计一致
        const { cacheRead, cacheMiss } = header.usage;
        const hasCacheBreakdown =
            typeof cacheRead === 'number' && typeof cacheMiss === 'number' && (cacheRead > 0 || cacheMiss > 0);
        const cacheRateHtml =
            hasCacheBreakdown && header.labels.cacheHitRate
                ? `<span class="od-export-token"><span>${escapeHtml(header.labels.cacheHitRate)}</span><span class="od-export-token-value">${formatPercent(cacheRead, cacheRead + cacheMiss)}</span></span>`
                : '';
        usageHtml = `
        <div class="od-export-header-usage">
            <span class="od-export-token"><span>${escapeHtml(header.labels.totalTokens)}</span><span class="od-export-token-value">${fmt(header.usage.total)}</span></span>
            <span class="od-export-token"><span>${escapeHtml(header.labels.inputTokens)}</span><span class="od-export-token-value">${fmt(header.usage.input)}</span></span>
            <span class="od-export-token"><span>${escapeHtml(header.labels.outputTokens)}</span><span class="od-export-token-value">${fmt(header.usage.output)}</span></span>${cacheRateHtml}
        </div>`;
    }

    return `
<header class="od-export-header">
    <div class="od-export-header-title">${escapeHtml(header.title)}</div>
    <div class="od-export-header-meta">${metaParts.join('')}</div>${usageHtml}
</header>`;
}

/** 右上角固定的深浅色主题切换按钮（点击行为见内联脚本） */
function buildThemeToggleHtml(): string {
    return `<button id="od-export-theme-toggle" type="button">${SUN_ICON_SVG}${MOON_ICON_SVG}<span class="od-export-toggle-label"></span></button>`;
}

/** 把内容分片逐一挂到容器上，避免超大任务单次巨串 innerHTML 解析 */
function appendContentFragments(container: Element, contentHtml: string | string[]): void {
    const fragments = Array.isArray(contentHtml) ? contentHtml : [contentHtml];
    const doc = container.ownerDocument;
    for (const fragment of fragments) {
        if (!fragment) continue;
        if (typeof container.insertAdjacentHTML === 'function') {
            container.insertAdjacentHTML('beforeend', fragment);
            continue;
        }
        const tmp = doc.createElement('div');
        tmp.innerHTML = fragment;
        while (tmp.firstChild) container.appendChild(tmp.firstChild);
    }
}

function copyElementAttributes(el: Element, names: string[]): string {
    const parts: string[] = [];
    for (const name of names) {
        const value = el.getAttribute(name);
        if (value !== null && value !== '') {
            parts.push(`${name}="${escapeHtml(value)}"`);
        }
    }
    return parts.join(' ');
}
