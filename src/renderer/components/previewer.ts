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
    if (baseDir) {
        const baseUrl = 'file://' + (baseDir.startsWith('/') ? '' : '/') + baseDir.replace(/\\/g, '/');
        const baseHref = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
        const baseTag = `<base href="${baseHref}">`;
        shadowRoot.innerHTML = baseTag + rawCode;
    } else {
        shadowRoot.innerHTML = rawCode;
    }
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

function enhanceBlock(block: HTMLElement): void {
    const header = block.querySelector('.code-block-header');
    const codeBody = block.querySelector<HTMLElement>('.code-block-body');
    if (!header || !codeBody) return;

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
