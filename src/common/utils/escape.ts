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
 * HTML 转义 — 将外部可控文本转为 HTML 实体，防止 XSS。这是 HTML 场景的默认选择。
 *
 * 使用场景：文本被拼进 HTML 文本节点或属性值，最终由 innerHTML / 响应体解析。
 *   el.innerHTML = `<span title="${escapeHtml(name)}">${escapeHtml(text)}</span>`
 * 覆盖 & < > " ' 五个字符，同时覆盖文本上下文与双引号属性上下文。
 *
 * 不适用：文本会被当作 JS 源码解析时（写进模板字面量）改用 escapeHtmlInsideJsTemplate()；
 * 文本要交给 Markdown 渲染器时改用 escapeHtmlForMarkdown()。
 */
export function escapeHtml(content: string | undefined | null): string {
    if (content === null || content === undefined) {
        return '';
    }
    const map: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return String(content).replace(/[&<>"']/g, function (m: string) {
        return map[m];
    });
}

/**
 * JS 模板字面量内的 HTML 转义 — 文本被写进 JS 源码的模板字面量（`...${x}...`）时使用。
 *
 * 使用场景：生成 .js 文件或内联 <script> 时，把外部可控文本内插进模板字面量。
 *   fs.writeFileSync('main.js', 'this.innerHTML = `' + escapeHtmlInsideJsTemplate(name) + '`;')
 * 除 HTML 五件套外必须消解 ` $ \ 这三个模板字面量语义字符，否则文本可逃逸出字面量：
 *   - ` 提前终止模板字面量，其后内容变成 JS 源码
 *   - ${ 触发模板插值求值，等价于任意 JS 执行
 *   - \ 与后续字符组成转义序列：\` 吃掉闭合反引号导致整个脚本语法错误，
 *     \x41 / \u0020 被求值成别的字符，结尾的孤立 \ 同样让脚本无法解析
 * 三者都编码为 HTML 实体（&#96; / &#36; / &#92;）：在 JS 源码里只是普通字符。
 *
 * 隐含契约：输出必须最终由 HTML 解析器还原，才能显示回原始的 ` $ \ 且不露实体字面量。
 * 也就是说调用点的结果是 innerHTML / document.write / HTML 文件里的内容。
 * 若结果要写进 textContent、纯文本文件或非 HTML 上下文，用户会看到 &#96; 之类的实体，
 * 那种场景不能用本函数。
 */
export function escapeHtmlInsideJsTemplate(content: string | undefined | null): string {
    return escapeHtml(content).replace(/\\/g, '&#92;').replace(/`/g, '&#96;').replace(/\$/g, '&#36;');
}

/**
 * Markdown 预处理转义 — 把外部纯文本安全地交给 Markdown 渲染器之前使用。
 *
 * 使用场景：工具输出、日志等不可信纯文本先经本函数转义，再交给 parseMarkdownSafe() 渲染，
 * 阻止原文中的 <div>、<script> 被当作 HTML 注入。
 *   parseMarkdownSafe(escapeHtmlForMarkdown(toolResult))
 * 只转 & < >：引号在 Markdown 文本里没有特殊含义，转成实体会让正文露出 &#039; 字面量，
 * 因此这里故意不转 " 与 '，不要"顺手补全"。
 *
 * 代码 span 与代码块（反引号包围的区域）内部一律原样保留，不转义：
 * 那里 Markdown 渲染器自己会把内容转义成字面量，不存在注入风险；而实体在代码里不会被
 * 还原，一旦转了就会在界面上露出 &amp; / &lt; 字面量——
 * 典型例子是 `a&b.ts` 这种文件名，转了会显示成 a&amp;b.ts。
 */
export function escapeHtmlForMarkdown(content: string | undefined | null): string {
    if (content === null || content === undefined) {
        return '';
    }
    const text = String(content);
    let out = '';
    let offset = 0;
    while (offset < text.length) {
        const open = findBacktickRun(text, offset);
        if (!open) {
            out += escapeMarkdownText(text.slice(offset));
            break;
        }
        out += escapeMarkdownText(text.slice(offset, open.start));
        const close = findBacktickRun(text, open.end, open.length);
        if (!close) {
            // 没有等长的闭合反引号：按 CommonMark 语义这只是一段普通文本，整段转义。
            out += escapeMarkdownText(text.slice(open.start));
            break;
        }
        out += text.slice(open.start, close.end);
        offset = close.end;
    }
    return out;
}

/** 查找从 from 开始的反引号串；指定 length 时只匹配等长的串（CommonMark 的代码 span 闭合规则）。 */
function findBacktickRun(
    text: string,
    from: number,
    length?: number
): { start: number; end: number; length: number } | null {
    let index = text.indexOf('`', from);
    while (index !== -1) {
        let end = index;
        while (text[end] === '`') end++;
        const runLength = end - index;
        if (length === undefined || runLength === length) {
            return { start: index, end, length: runLength };
        }
        index = text.indexOf('`', end);
    }
    return null;
}

function escapeMarkdownText(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 正则表达式转义 — 转义字符串中所有正则特殊字符。
 * 用于将用户输入安全地嵌入 RegExp 构造。
 */
export function escapeRegExp(s: string): string {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * SQL 字符串转义 — 将单引号转义为 SQL 标准的两个单引号。
 * 用于将值安全地嵌入到 SQL 字符串字面量中（仅限必须内联的简单场景）。
 * 优先使用参数化查询。
 */
export function escapeSqlStr(s: string): string {
    return s.replace(/'/g, "''");
}
