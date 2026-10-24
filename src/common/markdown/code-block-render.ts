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
 * 共享的代码块 HTML 渲染（taskview 与笔记编辑器共用的外观契约）。
 *
 * 输出结构与 taskview 的 messages.ts marked renderer 完全一致：
 * `.code-block-wrapper > .code-block-header / .code-block-body > pre.code-block-pre > code.code-lines > span.code-line`
 * 外观 CSS 位于 src/renderer/styles/custom.css（`.markdown-body .code-block-*`），
 * 行号由 CSS counter 在 `.code-line::before` 上生成。
 */

import { escapeHtml } from '../utils/escape.js';

export interface CodeBlockOptions {
    /** 围栏语言标识（如 `c`、`ts`），可为空 */
    lang?: string;
    /** 是否输出语言 header（taskview 恒有；笔记在无语言时省略） */
    withHeader?: boolean;
    /** taskview 实时预览：可预览语言集合与原始代码 */
    preview?: { langs: ReadonlySet<string>; rawCode: string };
}

/** 围栏语言标识 -> header 显示名，与 taskview messages.ts 保持同源 */
export const LANG_DISPLAY_NAMES: Record<string, string> = {
    js: 'JavaScript',
    javascript: 'JavaScript',
    ts: 'TypeScript',
    typescript: 'TypeScript',
    py: 'Python',
    python: 'Python',
    rb: 'Ruby',
    ruby: 'Ruby',
    java: 'Java',
    cpp: 'C++',
    c: 'C',
    cs: 'C#',
    csharp: 'C#',
    go: 'Go',
    rust: 'Rust',
    rs: 'Rust',
    swift: 'Swift',
    kt: 'Kotlin',
    kotlin: 'Kotlin',
    php: 'PHP',
    sql: 'SQL',
    html: 'HTML',
    css: 'CSS',
    scss: 'SCSS',
    less: 'LESS',
    json: 'JSON',
    yaml: 'YAML',
    yml: 'YAML',
    xml: 'XML',
    toml: 'TOML',
    sh: 'Shell',
    bash: 'Bash',
    zsh: 'Zsh',
    powershell: 'PowerShell',
    ps1: 'PowerShell',
    md: 'Markdown',
    markdown: 'Markdown',
    tex: 'LaTeX',
    latex: 'LaTeX',
    dockerfile: 'Dockerfile',
    makefile: 'Makefile',
    cmake: 'CMake',
    r: 'R',
    lua: 'Lua',
    perl: 'Perl',
    scala: 'Scala',
    elixir: 'Elixir',
    dart: 'Dart',
    vue: 'Vue',
    svelte: 'Svelte',
    jsx: 'JSX',
    tsx: 'TSX',
    graphql: 'GraphQL',
    proto: 'Protobuf',
    ini: 'INI',
    plaintext: 'Text',
    svg: 'SVG',
    htm: 'HTML'
};

/**
 * 当高亮 span 跨越换行时，保持每个代码行结构独立：
 * 在行边界闭合所有打开的 span，并在下一行重新打开。
 */
export function splitHighlightedLines(highlighted: string): string[] {
    const lines = [''];
    const openSpans: string[] = [];
    const tokenPattern = /<span\b[^>]*>|<\/span>|\r\n|\r|\n/g;
    let cursor = 0;

    for (const match of highlighted.matchAll(tokenPattern)) {
        const token = match[0];
        const tokenIndex = match.index;
        lines[lines.length - 1] += highlighted.slice(cursor, tokenIndex);

        if (token === '\n' || token === '\r' || token === '\r\n') {
            lines[lines.length - 1] += '</span>'.repeat(openSpans.length);
            lines.push(openSpans.join(''));
        } else if (token === '</span>') {
            lines[lines.length - 1] += token;
            openSpans.pop();
        } else {
            lines[lines.length - 1] += token;
            openSpans.push(token);
        }

        cursor = tokenIndex + token.length;
    }

    lines[lines.length - 1] += highlighted.slice(cursor);
    return lines;
}

/**
 * 渲染单行代码的内部 HTML（高亮结果的行内标记；空行渲染为占位空格）。
 */
export function renderCodeLineInnerHtml(lineHtml: string): string {
    const hasText = lineHtml.replace(/<\/?span\b[^>]*>/g, '') !== '';
    return hasText ? lineHtml : ' ';
}

/**
 * 渲染单行代码的 HTML（高亮结果的行内标记，不含外壳与行号）。
 * 行号与外观由 CSS（.code-line / .code-line::before）负责。
 */
export function renderCodeLineHtml(lineHtml: string): string {
    return `<span class="code-line font-mono">${renderCodeLineInnerHtml(lineHtml)}</span>`;
}

/**
 * 渲染与 taskview 外观契约一致的代码块 HTML。
 *
 * @param highlighted 已经过 hljs.highlight() 的高亮 HTML
 */
export function renderCodeBlockHtml(highlighted: string, options: CodeBlockOptions = {}): string {
    const lang = options.lang || '';
    const langLower = lang.toLowerCase();
    const langClass = lang ? `hljs language-${escapeHtml(lang)}` : 'hljs';
    const displayLang = lang ? LANG_DISPLAY_NAMES[langLower] || lang.charAt(0).toUpperCase() + lang.slice(1) : '';
    // taskview 行为：header 恒输出（无语言时为空标签）；withHeader === false 时不输出，
    // 默认仅在识别到语言时输出（笔记场景：裸 ``` 不显示 header）
    const headerHtml =
        options.withHeader === false || (!displayLang && options.withHeader !== true)
            ? ''
            : `<div class="code-block-header"><span class="code-block-lang">${escapeHtml(displayLang)}</span></div>`;
    const lines = splitHighlightedLines(highlighted);
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

    const codeLines = lines.map(renderCodeLineHtml).join('');

    let previewAttrs = '';
    if (options.preview?.langs.has(langLower)) {
        const bytes = new TextEncoder().encode(options.preview.rawCode);
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        const rawCode = btoa(binary);
        previewAttrs = ` data-previewable="true" data-preview-lang="${escapeHtml(langLower)}" data-raw-code="${rawCode}"`;
    }

    return `<div class="code-block-wrapper"${previewAttrs}>${headerHtml}<div class="code-block-body ${langClass}"><pre class="code-block-pre font-mono"><code class="code-lines">${codeLines}</code></pre></div></div>`;
}
