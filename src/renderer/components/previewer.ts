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
 * Code block live-preview module.
 *
 * Scans a container for code blocks whose language is previewable and enhances
 * them with a toggle switch in the header.  When toggled on (default for
 * supported languages), the highlighted source is hidden and replaced by a live
 * preview rendered inside a Shadow DOM for full style isolation.
 *
 * Detection works in two ways:
 *   1. Blocks with `data-previewable="true"` carry base64-encoded raw source in
 *      `data-raw-code` (produced by the updated messages.ts renderer).
 *   2. Legacy / cached blocks without data attributes are detected by their
 *      `language-*` CSS class on `.code-block-body` and the raw text is
 *      reconstructed from the highlighted `td.code-line` cells.
 *
 * Supported preview types: html, htm, svg.
 */

import { createRendererTranslator } from '../locale.js';
import { OPENDESK_THEME_CHANGED } from '../theme/theme-iframe-bridge.js';

let previewerT = createRendererTranslator();

/** Decode a base64 string that was encoded from UTF-8 bytes back to a JS string. */
function decodeBase64Utf8(b64: string): string {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
}

type PreviewRenderer = (shadowRoot: ShadowRoot, rawCode: string, baseDir?: string) => void;

const PREVIEW_RENDERERS: Record<string, PreviewRenderer> = {
    html: renderHtmlPreview,
    htm: renderHtmlPreview,
    svg: renderSvgPreview
};

/** Set of language identifiers that support live preview */
const PREVIEWABLE_LANGS = new Set(Object.keys(PREVIEW_RENDERERS));

function renderHtmlPreview(shadowRoot: ShadowRoot, rawCode: string, baseDir?: string): void {
    // Use an iframe instead of direct shadowRoot.innerHTML so that full HTML
    // documents (with <html>, <head>, <body>, <link>, etc.) render correctly.
    // Shadow DOM does not support <base>, treats <head>/<body> as ordinary
    // elements, and cannot resolve relative resource paths — all of which cause
    // style loss.  An iframe with srcdoc creates a proper browsing context.
    const iframe = document.createElement('iframe');
    iframe.sandbox.add('allow-same-origin');
    iframe.style.cssText = 'width:100%;border:none;display:block;background:#fff;min-height:100px;';

    let srcdoc = rawCode;
    if (baseDir) {
        const baseUrl = 'file://' + (baseDir.startsWith('/') ? '' : '/') + baseDir.replace(/\\/g, '/');
        const baseHref = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
        const hasBase = /<base\s/i.test(rawCode);
        if (!hasBase) {
            const baseTag = `<base href="${baseHref}">`;
            if (/<head[\s>]/i.test(rawCode)) {
                srcdoc = rawCode.replace(/(<head[^>]*>)/i, `$1${baseTag}`);
            } else if (/<html[\s>]/i.test(rawCode)) {
                srcdoc = rawCode.replace(/(<html[^>]*>)/i, `$1<head>${baseTag}</head>`);
            } else {
                srcdoc = `<!DOCTYPE html><html><head>${baseTag}</head><body>${rawCode}</body></html>`;
            }
        }
    }

    iframe.srcdoc = srcdoc;

    // Auto-resize iframe to fit content height
    iframe.addEventListener('load', () => {
        try {
            const doc = iframe.contentDocument;
            if (doc) {
                const height = doc.documentElement?.scrollHeight || doc.body?.scrollHeight || 0;
                if (height > 0) {
                    iframe.style.height = height + 'px';
                }
            }
        } catch {
            // cross-origin access blocked — leave default min-height
        }
    });

    shadowRoot.appendChild(iframe);
}

function renderSvgPreview(shadowRoot: ShadowRoot, rawCode: string, _baseDir?: string): void {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;align-items:center;justify-content:center;width:100%;';
    wrapper.innerHTML = rawCode;
    const svg = wrapper.querySelector('svg');
    if (svg) {
        if (!svg.hasAttribute('width') && !svg.style.width) {
            svg.style.maxWidth = '100%';
            svg.style.height = 'auto';
        }
    }
    shadowRoot.appendChild(wrapper);
}

/**
 * Detect the language from the `.code-block-body` element's class list.
 * Returns the language string (e.g. "html", "svg") or null if not found.
 */
function detectLangFromBody(codeBody: Element): string | null {
    for (const cls of codeBody.classList) {
        if (cls.startsWith('language-')) {
            return cls.slice('language-'.length).toLowerCase();
        }
    }
    return null;
}

/**
 * Extract raw source code text from highlighted table rows.
 * Each `td.code-line` contains one line of (highlighted) code;
 * we take the textContent to strip HTML tags and recover the original source.
 */
function extractRawCodeFromTable(codeBody: Element): string | null {
    const lines = codeBody.querySelectorAll('td.code-line');
    if (lines.length === 0) return null;
    const parts: string[] = [];
    for (const td of lines) {
        parts.push(td.textContent || '');
    }
    return parts.join('\n');
}

function localizePreviewToggle(toggle: HTMLLabelElement): void {
    const text = toggle.querySelector<HTMLElement>('.code-preview-toggle-label');
    if (text) text.textContent = previewerT('renderer.previewer.preview');
}

function localizePreviewControls(container: ParentNode): void {
    for (const toggle of container.querySelectorAll<HTMLLabelElement>('.code-preview-toggle')) {
        localizePreviewToggle(toggle);
    }
    for (const button of container.querySelectorAll<HTMLButtonElement>('.code-copy-btn')) {
        button.setAttribute('aria-label', previewerT('contextmenu.copy'));
    }
}

function createToggleButton(checked: boolean): HTMLLabelElement {
    const label = document.createElement('label');
    label.className = 'code-preview-toggle';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.className = 'code-preview-toggle-input';

    const slider = document.createElement('span');
    slider.className = 'code-preview-toggle-slider';

    const text = document.createElement('span');
    text.className = 'code-preview-toggle-label';

    label.appendChild(input);
    label.appendChild(slider);
    label.appendChild(text);
    localizePreviewToggle(label);
    return label;
}

const COPY_ICON_SVG =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const CHECK_ICON_SVG =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

function addCopyButton(header: Element, getCode: () => string): void {
    if (header.querySelector('.code-copy-btn')) return;

    const btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', previewerT('contextmenu.copy'));
    btn.innerHTML = COPY_ICON_SVG;

    btn.addEventListener('click', () => {
        navigator.clipboard
            .writeText(getCode())
            .then(() => {
                btn.innerHTML = CHECK_ICON_SVG;
                btn.classList.add('code-copy-btn--copied');
                setTimeout(() => {
                    btn.innerHTML = COPY_ICON_SVG;
                    btn.classList.remove('code-copy-btn--copied');
                }, 1500);
            })
            .catch(() => {});
    });

    header.appendChild(btn);
}

function enhanceBlock(block: HTMLElement): void {
    const header = block.querySelector('.code-block-header');
    const codeBody = block.querySelector<HTMLElement>('.code-block-body');
    if (!header || !codeBody) return;

    // 为所有代码块添加复制按钮
    addCopyButton(header, () => extractRawCodeFromTable(codeBody) || '');

    // --- determine language and raw source ---
    let lang: string | null = null;
    let rawCode: string | null = null;

    if (block.dataset.previewable === 'true') {
        lang = (block.dataset.previewLang || '').toLowerCase();
        const rawB64 = block.dataset.rawCode || '';
        if (rawB64) {
            try {
                rawCode = decodeBase64Utf8(rawB64);
            } catch {
                // fall through to table extraction
            }
        }
    }

    // Fallback: detect from CSS class + extract from rendered table cells
    if (!lang || !PREVIEWABLE_LANGS.has(lang)) {
        lang = detectLangFromBody(codeBody);
    }
    if (!lang || !PREVIEWABLE_LANGS.has(lang)) return;

    if (!rawCode) {
        rawCode = extractRawCodeFromTable(codeBody);
    }
    if (!rawCode) return;

    const renderer = PREVIEW_RENDERERS[lang];
    if (!renderer) return;

    block.setAttribute('data-preview-enhanced', 'true');

    // -- preview container with shadow DOM --
    const previewContainer = document.createElement('div');
    previewContainer.className = 'code-preview-container';
    if (lang === 'svg' || lang === 'html' || lang === 'htm') {
        previewContainer.classList.add('code-preview-container--auto-height');
    }
    const shadowHost = document.createElement('div');
    shadowHost.className = 'code-preview-shadow-host';
    const shadowRoot = shadowHost.attachShadow({ mode: 'open' });
    renderer(shadowRoot, rawCode);
    previewContainer.appendChild(shadowHost);
    codeBody.insertAdjacentElement('afterend', previewContainer);

    // -- toggle (defaults to preview-on) --
    const toggle = createToggleButton(true);
    header.appendChild(toggle);
    const checkbox = toggle.querySelector<HTMLInputElement>('.code-preview-toggle-input')!;

    // default state: preview visible, code hidden
    codeBody.style.display = 'none';
    previewContainer.style.display = '';

    checkbox.addEventListener('change', () => {
        const showPreview = checkbox.checked;
        codeBody.style.display = showPreview ? 'none' : '';
        previewContainer.style.display = showPreview ? '' : 'none';
    });
}

/**
 * Scan `container` for previewable code blocks and enhance them with a preview
 * toggle. Already-enhanced blocks (marked with `data-preview-enhanced`) are
 * skipped so the function is safe to call repeatedly (e.g. during streaming).
 */
export function enhanceCodeBlocks(container: HTMLElement): void {
    trackPreviewerContainer(container);
    const blocks = container.querySelectorAll<HTMLElement>('.code-block-wrapper:not([data-preview-enhanced])');
    for (const block of blocks) {
        enhanceBlock(block);
    }
}

/**
 * Scan `container` for tool-call preview cards (`.tool-preview-card[data-preview-lang]`)
 * and render live previews inside them via shadow DOM.  These are produced by
 * `renderPreviewCard` in filemgr/tools.ts for writeFile / createFile on
 * previewable file types.  Always shows the preview (no toggle).
 *
 * Tool preview cards may carry `data-base-dir` for resolving relative resource
 * paths (e.g. an HTML file referencing an SVG in the same directory).
 */
export function enhanceToolPreviewCards(container: HTMLElement): void {
    const cards = container.querySelectorAll<HTMLElement>(
        '.tool-preview-card[data-preview-lang]:not([data-preview-enhanced])'
    );
    for (const card of cards) {
        const lang = (card.dataset.previewLang || '').toLowerCase();
        const rawB64 = card.dataset.rawCode || '';
        const baseDir = card.dataset.baseDir || undefined;
        const renderer = PREVIEW_RENDERERS[lang];
        if (!renderer || !rawB64) continue;

        let rawCode: string;
        try {
            rawCode = decodeBase64Utf8(rawB64);
        } catch {
            continue;
        }

        card.setAttribute('data-preview-enhanced', 'true');

        const shadowHost = document.createElement('div');
        shadowHost.className = 'code-preview-shadow-host';
        const shadowRoot = shadowHost.attachShadow({ mode: 'open' });
        renderer(shadowRoot, rawCode, baseDir);
        card.appendChild(shadowHost);
    }
}

type MermaidTheme = 'light' | 'dark';

interface MermaidPipeline {
    render(id: string, code: string, theme: MermaidTheme): Promise<{ svg: string }>;
    sanitize(svg: string): string;
}

let mermaidPipelinePromise: Promise<MermaidPipeline> | null = null;
let mermaidSeq = 0;
const MERMAID_CACHE_LIMIT = 100;
const mermaidSvgCache = new Map<string, string>();
const mermaidRenderInFlight = new Map<string, Promise<string>>();
const previewerContainersByDocument = new WeakMap<Document, Set<HTMLElement>>();
const mermaidThemeListenerDocuments = new WeakSet<Document>();

function updatePreviewerTranslator(setting: unknown): void {
    previewerT = createRendererTranslator(setting as { locale?: string; resolved_locale?: string });
    if (typeof document === 'undefined') return;
    const containers = previewerContainersByDocument.get(document);
    if (!containers) return;
    for (const container of containers) {
        if (!container.isConnected || container.ownerDocument !== document) {
            containers.delete(container);
            continue;
        }
        localizePreviewControls(container);
    }
}

if (typeof window !== 'undefined') {
    void window.settingAPI
        ?.loadSettingObject?.()
        .then(updatePreviewerTranslator)
        .catch(() => {});
    window.settingAPI?.onSettingChanged?.(updatePreviewerTranslator);
}

/**
 * OpenDesk 设计系统调色板，与 docs/designs/modal.html 的设计 Token 同源
 * （暖灰表面 + 品牌红强调，深浅色仅做明度翻转、不加蓝）。
 * 深色模式的 rgba 浅底已按卡片底色 (#2A2826) 预合成为不透明 hex，
 * 因为 Mermaid 生成的 SVG 填充不继承页面上下文的半透明混色。
 */
interface MermaidPalette {
    page: string;
    bg: string;
    card: string;
    line: string;
    lineSoft: string;
    ink: string;
    ink2: string;
    ink3: string;
    accent: string;
    accentSoft: string;
    blue: string;
    blueSoft: string;
    green: string;
    greenSoft: string;
    amber: string;
    amberSoft: string;
    red: string;
    redSoft: string;
}

const MERMAID_PALETTES: Record<'light' | 'dark', MermaidPalette> = {
    light: {
        page: '#FBFAF8',
        bg: '#F5F4F2',
        card: '#FFFFFF',
        line: '#E7E5E2',
        lineSoft: '#EFEEEA',
        ink: '#1C1917',
        ink2: '#4A4642',
        ink3: '#8A8580',
        accent: '#DF4436',
        accentSoft: '#FDEEEC',
        blue: '#4267B2',
        blueSoft: '#EBF1FB',
        green: '#1F9D66',
        greenSoft: '#E7F5EE',
        amber: '#B87503',
        amberSoft: '#FDF3E3',
        red: '#DC2626',
        redSoft: '#FEF2F2'
    },
    dark: {
        page: '#1B1A18',
        bg: '#232120',
        card: '#2A2826',
        line: '#3B3835',
        lineSoft: '#33302D',
        ink: '#EFEDEA',
        ink2: '#D5D1CB',
        ink3: '#9B968F',
        accent: '#E8563F',
        accentSoft: '#482F2A',
        blue: '#7AA2E8',
        blueSoft: '#373B45',
        green: '#3DBF82',
        greenSoft: '#2D3F34',
        amber: '#E2A23B',
        amberSoft: '#463A29',
        red: '#E85A5A',
        redSoft: '#473030'
    }
};

/**
 * pie / timeline / journey / mindmap 使用的 12 色分类色带。
 * 全部取自 modal.html 调色盘的深浅两版语义色与跨模式变体，
 * 并按明度从高到低排序、避免相邻色块同色（mermaid 按节点层级循环取色，
 * 相邻同色会无法区分）。
 */
const MERMAID_RAMPS: Record<'light' | 'dark', string[]> = {
    light: [
        '#ED6B56',
        '#4267B2',
        '#3DBF82',
        '#E2A23B',
        '#B98AE0',
        '#E85A5A',
        '#DF4436',
        '#7AA2E8',
        '#1F9D66',
        '#B87503',
        '#7B4BAA',
        '#DC2626'
    ],
    dark: [
        '#ED6B56',
        '#7AA2E8',
        '#3DBF82',
        '#E2A23B',
        '#B98AE0',
        '#E85A5A',
        '#E8563F',
        '#4267B2',
        '#1F9D66',
        '#B87503',
        '#7B4BAA',
        '#DC2626'
    ]
};

function buildMermaidThemeVariables(darkTheme: boolean): Record<string, string | boolean> {
    const p = MERMAID_PALETTES[darkTheme ? 'dark' : 'light'];
    const ramp = MERMAID_RAMPS[darkTheme ? 'dark' : 'light'];
    const variables: Record<string, string | boolean> = {
        darkMode: darkTheme,
        background: p.page,

        /* 文字层级（ink→ink3）与连接线 */
        textColor: p.ink2,
        titleColor: p.ink,
        nodeTextColor: p.ink,
        lineColor: p.ink3,
        defaultLinkColor: p.ink3,
        edgeLabelBackground: p.page,
        clusterBkg: p.bg,
        clusterBorder: p.line,

        /* 节点三级填充：蓝(主) / 绿(次) / 琥珀(三) */
        primaryColor: p.blueSoft,
        primaryTextColor: p.ink,
        primaryBorderColor: p.blue,
        secondaryColor: p.greenSoft,
        secondaryTextColor: p.ink2,
        secondaryBorderColor: p.green,
        tertiaryColor: p.amberSoft,
        tertiaryTextColor: p.ink2,
        tertiaryBorderColor: p.amber,
        mainBkg: p.blueSoft,
        nodeBorder: p.blue,

        /* sequence 图 */
        actorBkg: p.card,
        actorBorder: p.blue,
        actorTextColor: p.ink,
        actorLineColor: p.line,
        signalColor: p.ink2,
        signalTextColor: p.ink2,
        // alt/opt 分支框是信息性分支而非警告，改用信息蓝的浅底，
        // 避免与 note（琥珀=标注/警示）的语义混淆
        labelBoxBkgColor: p.blueSoft,
        labelBoxBorderColor: p.blue,
        labelTextColor: p.blue,
        loopTextColor: p.blue,
        activationBkgColor: p.blueSoft,
        activationBorderColor: p.blue,
        // autonumber 圆点填充为 lineColor（中灰），深色文字对比度最高
        sequenceNumberColor: darkTheme ? p.page : p.ink,

        /* note / state */
        noteBkgColor: p.amberSoft,
        noteTextColor: p.ink2,
        noteBorderColor: p.amber,
        stateBkg: p.blueSoft,
        stateLabelColor: p.ink,
        labelColor: p.ink,
        altBackground: p.bg,
        compositeBackground: p.bg,
        compositeBorder: p.line,
        compositeTitleBackground: p.lineSoft,
        innerEndBackground: p.blue,
        specialStateColor: p.blue,
        transitionColor: p.ink3,
        transitionLabelColor: p.ink2,
        labelBackgroundColor: p.page,
        errorBkgColor: p.redSoft,
        errorTextColor: p.red,

        /* class / er */
        classText: p.ink,
        attributeBackgroundColorOdd: p.card,
        attributeBackgroundColorEven: p.bg,

        /* gantt：默认蓝、进行中品牌红、已完成绿、关键红 */
        sectionBkgColor: p.bg,
        sectionBkgColor2: p.lineSoft,
        altSectionBkgColor: p.page,
        gridColor: p.line,
        todayLineColor: p.accent,
        taskBkgColor: p.blueSoft,
        taskBorderColor: p.blue,
        activeTaskBkgColor: p.accentSoft,
        activeTaskBorderColor: p.accent,
        doneTaskBkgColor: p.greenSoft,
        doneTaskBorderColor: p.green,
        critBkgColor: p.redSoft,
        critBorderColor: p.red,
        taskTextColor: p.ink2,
        taskTextDarkColor: p.ink,
        taskTextOutsideColor: p.ink2,
        taskTextLightColor: p.card,
        taskTextClickableColor: p.blue,
        // mermaid 默认 vertLine 为 navy/#00BFFF、exclude 为 #eeeeee，
        // 均与暖灰色系冲突，深色模式下尤甚，这里归一到主题 token
        vertLineColor: p.ink3,
        excludeBkgColor: p.lineSoft,

        /* pie */
        pieStrokeColor: darkTheme ? p.page : p.card,
        pieOuterStrokeColor: p.line,
        pieOpacity: '0.85',
        pieTitleTextColor: p.ink,
        pieSectionTextColor: '#FFFFFF',
        pieLegendTextColor: p.ink2,

        /* journey：face 默认 #FFF8DC 硬编码，提供 faceColor 盖掉 */
        faceColor: p.amberSoft,

        /* mindmap / timeline 根节点与时间轴主线 */
        // 根节点默认取 git0（跟随 primaryColor），文字 gitBranchLabel0；
        // 时间轴主线 stroke 用 nodeBorder
        git0: p.accent,
        gitBranchLabel0: '#FFFFFF',
        arrowheadColor: p.ink3
    };

    /* 分类色带：pie1-12、cScale0-11（timeline/mindmap）、fillType0-7（journey）。
     * journey 的 section 色块与标题文字共用 .section-type-N 的 CSS fill，
     * 所以 fillType 用蓝/绿浅底交替，标题文字由 themeCSS 的
     * text.section-type-N 规则覆盖为正文色。 */
    ramp.forEach((color, i) => {
        variables[`pie${i + 1}`] = color;
        variables[`cScale${i}`] = color;
        variables[`cScaleLabel${i}`] = '#FFFFFF';
        variables[`cScalePeer${i}`] = ramp[i % 6];
        if (i < 8) variables[`fillType${i}`] = i % 2 === 0 ? p.blueSoft : p.greenSoft;
        // cScaleInv 是节点内装饰性波浪线的描边，默认由色带取补色，
        // 会跳出暖灰主题（深色模式下变成蓝青杂色），统一改为主题的柔和边线
        variables[`cScaleInv${i}`] = p.lineSoft;
    });
    return variables;
}

function buildMermaidThemeCSS(darkTheme: boolean): string {
    const p = MERMAID_PALETTES[darkTheme ? 'dark' : 'light'];
    const softFills = [
        p.blueSoft,
        p.greenSoft,
        p.amberSoft,
        p.accentSoft,
        p.redSoft,
        p.lineSoft,
        p.blueSoft,
        p.greenSoft
    ];
    // journey：色块用浅底、标题文字用正文色。
    // section 标题文字继承 .section-type-N 的 CSS fill（与色块同规则），
    // 不加 text 前缀覆盖的话会"浅底浅字"不可读。实测 themeCSS 会展开成
    // #id .section-type-N 规则追加在 mermaid 自身模板之后，优先级稳定胜出。
    const journeySection = softFills.map((fill, i) => `text.section-type-${i} { fill: ${p.ink2}; }`).join('\n');
    return [
        /* journey 笑脸与表情线默认硬编码黄脸/灰线，统一到琥珀语义色 */
        `.face { fill: ${p.amberSoft}; stroke: ${p.amber}; }`,
        `.mouth { stroke: ${p.ink3}; }`,
        /* journey 任务竖直虚线默认 #666 硬编码 */
        `line.task-line { stroke: ${p.line}; }`,
        journeySection,
        /* timeline 主轴线 stroke 取 nodeBorder（信息蓝），页面浅底上偏轻
         * 且与年份胶囊撞色，改为中性线色 */
        `.lineWrapper line { stroke: ${p.ink3}; }`,
        /* mindmap 根节点文字默认 text-anchor:start，在圆内偏右
         * （mermaid 原生缺陷），居中修正 */
        `.section-root .label text { text-anchor: middle; }`,
        ''
    ]
        .filter(Boolean)
        .join('\n');
}

export function createMermaidConfig(darkTheme: boolean): {
    startOnLoad: boolean;
    securityLevel: 'strict';
    htmlLabels: boolean;
    flowchart: { htmlLabels: boolean };
    theme: 'dark' | 'default';
    themeVariables: Record<string, string | boolean>;
    themeCSS: string;
} {
    return {
        startOnLoad: false,
        securityLevel: 'strict' as const,
        htmlLabels: false,
        flowchart: {
            htmlLabels: false
        },
        theme: darkTheme ? ('dark' as const) : ('default' as const),
        themeVariables: buildMermaidThemeVariables(darkTheme),
        themeCSS: buildMermaidThemeCSS(darkTheme)
    };
}

/**
 * DOMPurify sanitizes the SVG nodes and attributes, but CSS inside an allowed
 * SVG <style> element still needs a URL policy of its own.
 */
export function sanitizeMermaidStyleContent(svg: string): string {
    return svg.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_match, open, css, close) => {
        const withoutImports = String(css).replace(/@import\s+[^;]*(?:;|$)/gi, '');
        const safeCss = withoutImports.replace(
            /url\(\s*(['"]?)(.*?)\1\s*\)/gi,
            (urlMatch: string, _quote: string, value: string) => (value.trim().startsWith('#') ? urlMatch : 'none')
        );
        return `${open}${safeCss}${close}`;
    });
}

export function normalizeMermaidSvgSize(svg: SVGSVGElement): void {
    const viewBox = svg
        .getAttribute('viewBox')
        ?.trim()
        .split(/[\s,]+/)
        .map(Number);
    const naturalWidth = viewBox?.length === 4 && Number.isFinite(viewBox[2]) && viewBox[2] > 0 ? viewBox[2] : null;

    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.style.display = 'block';
    svg.style.width = naturalWidth === null ? '100%' : `${naturalWidth}px`;
    svg.style.maxWidth = '100%';
    svg.style.height = 'auto';
    svg.style.margin = '0 auto';
}

/** Mount each diagram in its own style boundary so TaskView sanitization cannot
 * remove Mermaid's generated theme rules or let them leak into the page. */
export function mountMermaidSvg(host: HTMLElement, sanitizedSvg: string): SVGSVGElement | null {
    const shadowRoot = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    shadowRoot.innerHTML = sanitizedSvg;
    const svg = shadowRoot.querySelector<SVGSVGElement>('svg');
    if (svg) normalizeMermaidSvgSize(svg);
    return svg;
}

function getMermaidTheme(doc: Document): MermaidTheme {
    return doc.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function getMermaidCacheKey(theme: MermaidTheme, encoded: string): string {
    return `${theme}:${encoded}`;
}

function cacheMermaidSvg(cacheKey: string, svg: string): void {
    if (mermaidSvgCache.size >= MERMAID_CACHE_LIMIT) {
        const oldestKey = mermaidSvgCache.keys().next().value;
        if (oldestKey !== undefined) mermaidSvgCache.delete(oldestKey);
    }
    mermaidSvgCache.set(cacheKey, svg);
}

/**
 * Lazily load and initialize mermaid + DOMPurify.
 * Mermaid is large, so it is only fetched via dynamic import when the first
 * mermaid block needs rendering, keeping the initial bundle size unaffected.
 */
function loadMermaidPipeline(): Promise<MermaidPipeline> {
    if (!mermaidPipelinePromise) {
        mermaidPipelinePromise = (async () => {
            const [mermaidMod, dompurifyMod] = await Promise.all([import('mermaid'), import('dompurify')]);
            const mermaid = mermaidMod.default;
            let initializedTheme: MermaidTheme | null = null;
            return {
                render: (id: string, code: string, theme: MermaidTheme) => {
                    if (initializedTheme !== theme) {
                        mermaid.initialize(createMermaidConfig(theme === 'dark'));
                        initializedTheme = theme;
                    }
                    const renderHost = document.createElement('div');
                    renderHost.setAttribute('aria-hidden', 'true');
                    renderHost.style.cssText =
                        'position:fixed;inset:0;visibility:hidden;pointer-events:none;z-index:-1;';
                    document.body.appendChild(renderHost);
                    return mermaid.render(id, code, renderHost).finally(() => renderHost.remove());
                },
                sanitize: (svg: string) =>
                    dompurifyMod.default.sanitize(svg, {
                        USE_PROFILES: { svg: true, svgFilters: true }
                    })
            };
        })();
    }
    return mermaidPipelinePromise;
}

function trackPreviewerContainer(container: HTMLElement): void {
    if (!container.isConnected) return;
    const doc = container.ownerDocument;
    let containers = previewerContainersByDocument.get(doc);
    if (!containers) {
        containers = new Set();
        previewerContainersByDocument.set(doc, containers);
    }
    containers.add(container);
}

function installMermaidThemeListener(doc: Document): void {
    if (mermaidThemeListenerDocuments.has(doc)) return;
    mermaidThemeListenerDocuments.add(doc);
    doc.addEventListener(OPENDESK_THEME_CHANGED, () => {
        const containers = previewerContainersByDocument.get(doc);
        if (!containers) return;
        const theme = getMermaidTheme(doc);
        const blocks = new Set<HTMLElement>();
        for (const container of containers) {
            if (!container.isConnected || container.ownerDocument !== doc) {
                containers.delete(container);
                continue;
            }
            for (const block of container.querySelectorAll<HTMLElement>('.mermaid-block[data-mermaid-code]')) {
                blocks.add(block);
            }
        }
        for (const block of blocks) {
            if (block.dataset.mermaidDeferred === 'true') continue;
            if (block.dataset.mermaidTheme === theme || block.dataset.mermaidRendering === theme) continue;
            void renderMermaidBlock(block, theme);
        }
    });
}

/**
 * Scan `container` for mermaid placeholders (`.mermaid-block`) produced by the
 * main-process markdown renderer and render them as SVG. Placeholders already
 * rendered are marked with `data-mermaid-rendered` and skipped, making this
 * function safe to call repeatedly (e.g. during streaming).
 */
export function renderMermaidBlocks(container: HTMLElement, options: { defer?: boolean } = {}): void {
    installMermaidThemeListener(container.ownerDocument);
    trackPreviewerContainer(container);
    const selector = options.defer
        ? '.mermaid-block[data-mermaid-code]'
        : '.mermaid-block:not([data-mermaid-rendered]):not([data-mermaid-rendering])';
    const blocks = container.querySelectorAll<HTMLElement>(selector);
    for (const block of blocks) {
        void renderMermaidBlock(block, getMermaidTheme(block.ownerDocument), options.defer === true);
    }
}

function applyMermaidRender(block: HTMLElement, source: string, sanitized: string, theme: MermaidTheme): void {
    delete block.dataset.mermaidRendering;
    const showPreview = block.querySelector<HTMLInputElement>('.code-preview-toggle-input')?.checked ?? true;
    const wrapper = document.createElement('div');
    wrapper.className = 'mermaid-rendered';
    mountMermaidSvg(wrapper, sanitized);
    wrapper.style.display = showPreview ? '' : 'none';

    // 源码视图（默认隐藏，切换开关后显示）
    const sourcePre = document.createElement('pre');
    sourcePre.className = 'mermaid-source';
    sourcePre.textContent = source;
    sourcePre.style.display = showPreview ? 'none' : '';

    // header + 预览开关（默认显示渲染结果，可切到源码）
    const header = document.createElement('div');
    header.className = 'mermaid-block-header';
    const langLabel = document.createElement('span');
    langLabel.className = 'mermaid-block-lang';
    langLabel.textContent = 'Mermaid';
    header.appendChild(langLabel);
    const toggle = createToggleButton(showPreview);
    header.appendChild(toggle);
    addCopyButton(header, () => source);
    const checkbox = toggle.querySelector<HTMLInputElement>('.code-preview-toggle-input')!;
    checkbox.addEventListener('change', () => {
        const showPreview = checkbox.checked;
        sourcePre.style.display = showPreview ? 'none' : '';
        wrapper.style.display = showPreview ? '' : 'none';
    });

    block.replaceChildren(header, sourcePre, wrapper);
    block.dataset.mermaidRendered = 'true';
    block.dataset.mermaidTheme = theme;
}

function getOrCreateMermaidSvg(encoded: string, source: string, theme: MermaidTheme): Promise<string> {
    const cacheKey = getMermaidCacheKey(theme, encoded);
    const existing = mermaidRenderInFlight.get(cacheKey);
    if (existing) return existing;

    const pending = (async () => {
        const pipeline = await loadMermaidPipeline();
        mermaidSeq += 1;
        const id = `od-mermaid-${mermaidSeq}`;
        const { svg } = await pipeline.render(id, source, theme);
        const sanitized = sanitizeMermaidStyleContent(pipeline.sanitize(svg));
        cacheMermaidSvg(cacheKey, sanitized);
        return sanitized;
    })();
    mermaidRenderInFlight.set(cacheKey, pending);
    const clearPending = () => {
        if (mermaidRenderInFlight.get(cacheKey) === pending) {
            mermaidRenderInFlight.delete(cacheKey);
        }
    };
    void pending.then(clearPending, clearPending);
    return pending;
}

async function renderMermaidBlock(block: HTMLElement, theme: MermaidTheme, defer = false): Promise<void> {
    const encoded = block.dataset.mermaidCode;
    if (!encoded) {
        block.dataset.mermaidRendered = 'error';
        return;
    }
    let source: string;
    try {
        source = decodeBase64Utf8(encoded);
    } catch {
        block.dataset.mermaidRendered = 'error';
        return;
    }
    if (defer) {
        delete block.dataset.mermaidRendering;
        delete block.dataset.mermaidRendered;
        delete block.dataset.mermaidTheme;
        block.dataset.mermaidDeferred = 'true';
        showMermaidSourceFallback(block, source);
        return;
    }
    delete block.dataset.mermaidDeferred;
    if (block.dataset.mermaidComplete === 'false') {
        showMermaidSourceFallback(block, source);
        return;
    }
    if (!source.trim()) {
        block.dataset.mermaidRendered = 'error';
        return;
    }
    const cacheKey = getMermaidCacheKey(theme, encoded);
    const cached = mermaidSvgCache.get(cacheKey);
    if (cached !== undefined) {
        applyMermaidRender(block, source, cached, theme);
        return;
    }

    if (!block.querySelector('.mermaid-rendered')) {
        showMermaidSourceFallback(block, source);
    }
    block.dataset.mermaidRendering = theme;
    try {
        const sanitized = await getOrCreateMermaidSvg(encoded, source, theme);
        const currentTheme = getMermaidTheme(block.ownerDocument);
        if (currentTheme !== theme) {
            if (block.dataset.mermaidRendering === theme) {
                delete block.dataset.mermaidRendering;
                void renderMermaidBlock(block, currentTheme);
            }
            return;
        }
        if (block.dataset.mermaidRendering !== theme) return;
        applyMermaidRender(block, source, sanitized, theme);
    } catch (err) {
        if (block.dataset.mermaidRendering !== theme) return;
        // 渲染失败：暴露真实错误便于诊断；回退显示源码避免出现空白占位。
        // 不标记 data-mermaid-rendered，流式阶段下一帧会重新尝试渲染。
        delete block.dataset.mermaidRendering;
        delete block.dataset.mermaidRendered;
        delete block.dataset.mermaidTheme;
        console.error('[mermaid] render failed:', err);
        showMermaidSourceFallback(block, source);
    }
}

function showMermaidSourceFallback(block: HTMLElement, source: string): void {
    const pre = document.createElement('pre');
    pre.className = 'mermaid-fallback';
    pre.textContent = source;
    block.replaceChildren(pre);
}
