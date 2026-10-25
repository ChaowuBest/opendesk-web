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
 * Markdown 渲染结果的安全中和 — 保留良性 HTML 的显示效果，只剥掉可执行能力。
 *
 * 使用场景：marked 的 postprocess 钩子。marked 默认放行原始 HTML，内容原样进入 DOM，
 * 仅按标签名黑名单过滤挡不住属性级注入：
 *   <img src=x onerror=alert(1)>        —— 事件处理器执行任意 JS
 *   <a href="javascript:alert(1)">      —— 危险协议
 * 两者都不在标签黑名单里，因此必须额外处理属性。
 *
 * 处理分两层，顺序无关：
 *   1. 开始标签内：丢弃 on* 事件属性、丢弃危险协议的 URL 属性；
 *   2. 危险标签名整体转义（沿用既有黑名单语义）。
 *
 * 为什么手工扫描标签边界而不用正则：真实标签内部可以出现 <（如 <img src=x onerror=1 <y>），
 * 用 [^>]* 之类的字符类会把标签提前截断，攻击者可用一个多余的 < 让 onerror 逃过清洗；
 * 而放宽字符类又会带来 <a<a<a... 这类病态输入的平方级回溯（工具输出长度不可控）。
 * 逐字符走一遍引号状态既正确又是严格线性。
 */

/** 整体中和的危险标签名（含结束标签）。标签名后必须是非单词字符，与 HTML 词法一致。 */
const DANGEROUS_TAG_RE = /<\s*\/?\s*(style|script|link|meta|iframe|object|embed|applet|form|base)\b[^>]*>/gi;

/** 开始标签的标签名部分。结束标签（</x>）与自闭合标签只保留名称，不含可清洗属性。 */
const TAG_HEAD_RE = /^<[a-z][a-z0-9-]*/i;

/**
 * 标签内的单个属性：属性名 + 可选 =值（捕获组 2 含等号，便于原样拼回）。
 * 值可以是双引号、单引号或裸值；一次匹配吃掉整个带引号的值，
 * 因此引号内的 " onclick=" 之类文本不会被误认为属性。
 */
const ATTRIBUTE_RE = /([^\s"'=<>/]+)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

/** 承载 URL 的属性名（小写）。 */
const URL_ATTRIBUTES = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'poster', 'background']);

/** 危险协议：可执行 JS 或旧式 VBScript。 */
const DANGEROUS_PROTOCOL_RE = /^(?:javascript|vbscript)\s*:/i;

/** data: 里只有常见位图是安全的内联资源；data:text/html、data:image/svg+xml 都能执行脚本。 */
const SAFE_DATA_URL_RE = /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif)[;,]?/i;

/**
 * 解码 URL 属性值里的实体。浏览器先解码实体再按 URL 解析，
 * 因此 jav&#x61;script: 与 javascript&colon; 都是可执行的危险协议。
 */
function decodeUrlEntities(value: string): string {
    return value
        .replace(/&#x([0-9a-f]+);?/gi, (_match, hex: string) => codePointToString(parseInt(hex, 16)))
        .replace(/&#([0-9]+);?/g, (_match, dec: string) => codePointToString(parseInt(dec, 10)))
        .replace(/&colon;/gi, ':')
        .replace(/&tab;/gi, '\t')
        .replace(/&newline;/gi, '\n');
}

function codePointToString(codePoint: number): string {
    if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return '';
    return String.fromCodePoint(codePoint);
}

/** 属性值是否指向危险协议。value 形如 ="..."，先剥掉等号与引号。 */
function isDangerousUrlAttribute(value: string): boolean {
    const raw = value.replace(/^\s*=\s*/, '').trim();
    const unquoted = raw.replace(/^["']/, '').replace(/["']$/, '');
    // 浏览器忽略 URL 中的空白与控制字符（java\nscript: 仍会执行），判定前一并去掉
    // eslint-disable-next-line no-control-regex
    const url = decodeUrlEntities(unquoted).replace(/[\s\u0000-\u001f]/g, '');
    if (!url) return false;
    if (SAFE_DATA_URL_RE.test(url)) return false;
    if (DANGEROUS_PROTOCOL_RE.test(url)) return true;
    return /^data:/i.test(url);
}

/** 逐个属性重写一个开始标签：丢掉 on* 与危险 URL，其余原样拼回。 */
function neutralizeTag(tag: string): string {
    const head = TAG_HEAD_RE.exec(tag);
    if (!head) return tag;

    const body = tag.slice(head[0].length);
    let out = head[0];
    let cursor = 0;
    let match: RegExpExecArray | null;
    ATTRIBUTE_RE.lastIndex = 0;
    while ((match = ATTRIBUTE_RE.exec(body)) !== null) {
        // 属性之间的空白；丢弃属性时连同这段空白一起丢掉，避免留下 "<img src >" 这种双空格
        const gap = body.slice(cursor, match.index);
        cursor = ATTRIBUTE_RE.lastIndex;

        const attributeName = match[1];
        const value = match[2] ?? '';
        const lowerName = attributeName.toLowerCase();
        if (lowerName.startsWith('on')) continue;
        if (URL_ATTRIBUTES.has(lowerName) && isDangerousUrlAttribute(value)) continue;
        out += gap + attributeName + value;
    }
    return out + body.slice(cursor);
}

/**
 * 从 start 处的 < 找到标签结束的 >，跳过引号内的 >。返回右边界下标，未闭合返回 -1。
 *
 * 引号语义必须与 HTML 词法一致：只有紧跟 = 的 " 或 ' 才开启带引号的值。
 * 未加引号的值（src=x"y）里的引号是普通字符，若把它当引号起点，
 * src=x"y onerror=alert(1) 这类标签会因"引号未闭合"被判成整段文本、
 * 而浏览器照样解析出 onerror 事件属性——净化就白做了。
 */
function findTagEnd(html: string, start: number): number {
    let quote = '';
    // 上一个非空白字符是 =，即下一个引号才是值边界
    let inValueStart = false;
    for (let i = start + 1; i < html.length; i++) {
        const char = html[i];
        if (quote) {
            if (char === quote) quote = '';
            continue;
        }
        if (inValueStart && (char === '"' || char === "'")) {
            quote = char;
            inValueStart = false;
            continue;
        }
        if (char === '>') return i + 1;
        if (char === '=') {
            inValueStart = true;
        } else if (!/\s/.test(char)) {
            inValueStart = false;
        }
    }
    return -1;
}

/** 逐字符扫描并重写所有开始标签；代码块里的 < 早被 markdown 转义成 &lt;，不会被当成标签。 */
function neutralizeStartTags(html: string): string {
    // 最后一个 > 的位置：越过它之后再也不可能有标签闭合，无需再逐段重扫
    const lastTagEnd = html.lastIndexOf('>');
    let out = '';
    let cursor = 0;
    let index = html.indexOf('<');
    while (index !== -1) {
        const next = html[index + 1];
        if (!next || !/[a-z]/i.test(next)) {
            index = html.indexOf('<', index + 1);
            continue;
        }
        const end = findTagEnd(html, index);
        if (end === -1) {
            // 后面再没有 >：这段无论怎么解析都闭合不了标签，原样保留（也避免重复扫到末尾）
            if (index > lastTagEnd) break;
            // 否则不能原样放行：它后面还有 >，浏览器仍可能把这段解析成带 onerror 的真实标签
            // （扫描器与浏览器引号语义不一致时就会这样）。转义这个 < 让它退化为文本，
            // 再从下一个 < 继续处理后续标签。
            out += `${html.slice(cursor, index)}&lt;`;
            cursor = index + 1;
            index = html.indexOf('<', cursor);
            continue;
        }
        out += html.slice(cursor, index) + neutralizeTag(html.slice(index, end));
        cursor = end;
        index = html.indexOf('<', end);
    }
    return out + html.slice(cursor);
}

/**
 * 中和 markdown 渲染结果里的可执行 HTML，良性标签与属性保持原样。
 * 幂等，可以直接放进 postprocess 链。
 */
export function neutralizeMarkdownHtml(html: string): string {
    return neutralizeStartTags(html).replace(DANGEROUS_TAG_RE, (match) =>
        match.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    );
}
