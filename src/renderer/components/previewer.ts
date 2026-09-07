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

function createToggleButton(checked: boolean): HTMLLabelElement {
    const label = document.createElement('label');
    label.className = 'code-preview-toggle';
    label.title = checked ? '切换到源码' : '切换到预览';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.className = 'code-preview-toggle-input';

    const slider = document.createElement('span');
    slider.className = 'code-preview-toggle-slider';

    const text = document.createElement('span');
    text.className = 'code-preview-toggle-label';
    text.textContent = '预览';

    label.appendChild(input);
    label.appendChild(slider);
    label.appendChild(text);
    return label;
}

const COPY_ICON_SVG =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const CHECK_ICON_SVG =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

function addCopyButton(header: Element, codeBody: Element): void {
    if (header.querySelector('.code-copy-btn')) return;

    const btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.type = 'button';
    btn.title = '复制代码';
    btn.innerHTML = COPY_ICON_SVG;

    btn.addEventListener('click', () => {
        const code = extractRawCodeFromTable(codeBody) || '';
        navigator.clipboard
            .writeText(code)
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
    addCopyButton(header, codeBody);

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
        toggle.title = showPreview ? '切换到源码' : '切换到预览';
    });
}

/**
 * Scan `container` for previewable code blocks and enhance them with a preview
 * toggle. Already-enhanced blocks (marked with `data-preview-enhanced`) are
 * skipped so the function is safe to call repeatedly (e.g. during streaming).
 */
export function enhanceCodeBlocks(container: HTMLElement): void {
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

interface MermaidPipeline {
    render(id: string, code: string): Promise<{ svg: string }>;
    sanitize(svg: string): string;
}

let mermaidPipelinePromise: Promise<MermaidPipeline> | null = null;
let mermaidSeq = 0;

export function createMermaidConfig(darkTheme: boolean) {
    return {
        startOnLoad: false,
        securityLevel: 'strict' as const,
        htmlLabels: false,
        flowchart: {
            htmlLabels: false
        },
        theme: darkTheme ? ('dark' as const) : ('default' as const)
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
            mermaid.initialize(createMermaidConfig(document.documentElement.getAttribute('data-theme') === 'dark'));
            return {
                render: (id: string, code: string) => mermaid.render(id, code),
                sanitize: (svg: string) =>
                    dompurifyMod.default.sanitize(svg, {
                        USE_PROFILES: { svg: true, svgFilters: true }
                    })
            };
        })();
    }
    return mermaidPipelinePromise;
}

/**
 * Scan `container` for mermaid placeholders (`.mermaid-block`) produced by the
 * main-process markdown renderer and render them as SVG. Placeholders already
 * rendered are marked with `data-mermaid-rendered` and skipped, making this
 * function safe to call repeatedly (e.g. during streaming).
 */
export function renderMermaidBlocks(container: HTMLElement): void {
    const blocks = container.querySelectorAll<HTMLElement>('.mermaid-block:not([data-mermaid-rendered])');
    for (const block of blocks) {
        void renderMermaidBlock(block);
    }
}

async function renderMermaidBlock(block: HTMLElement): Promise<void> {
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
    if (!source.trim()) {
        block.dataset.mermaidRendered = 'error';
        return;
    }
    try {
        const pipeline = await loadMermaidPipeline();
        mermaidSeq += 1;
        const id = `od-mermaid-${mermaidSeq}`;
        const { svg } = await pipeline.render(id, source);
        const sanitized = sanitizeMermaidStyleContent(pipeline.sanitize(svg));
        const wrapper = document.createElement('div');
        wrapper.className = 'mermaid-rendered';
        mountMermaidSvg(wrapper, sanitized);

        // 源码视图（默认隐藏，切换开关后显示）
        const sourcePre = document.createElement('pre');
        sourcePre.className = 'mermaid-source';
        sourcePre.textContent = source;
        sourcePre.style.display = 'none';

        // header + 预览开关（默认显示渲染结果，可切到源码）
        const header = document.createElement('div');
        header.className = 'mermaid-block-header';
        const langLabel = document.createElement('span');
        langLabel.className = 'mermaid-block-lang';
        langLabel.textContent = 'Mermaid';
        header.appendChild(langLabel);
        const toggle = createToggleButton(true);
        header.appendChild(toggle);
        const checkbox = toggle.querySelector<HTMLInputElement>('.code-preview-toggle-input')!;
        checkbox.addEventListener('change', () => {
            const showPreview = checkbox.checked;
            sourcePre.style.display = showPreview ? 'none' : '';
            wrapper.style.display = showPreview ? '' : 'none';
            toggle.title = showPreview ? '切换到源码' : '切换到预览';
        });

        block.replaceChildren(header, sourcePre, wrapper);
        block.dataset.mermaidRendered = 'true';
    } catch (err) {
        // 渲染失败：暴露真实错误便于诊断；回退显示源码避免出现空白占位。
        // 不标记 data-mermaid-rendered，流式阶段下一帧会重新尝试渲染。
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
