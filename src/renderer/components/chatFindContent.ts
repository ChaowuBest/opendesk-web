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

// 内容适配层：决定哪些文字可搜索，并保存“合并文本偏移 → 实际文本节点”的映射。
// 同一套规则同时用于未挂载的历史消息和页面上的实时消息。
import { MARKDOWN_DOM, PREVIEWABLE_CODE_LANGUAGES, SEARCH_PREVIEW_TEMPLATE } from '../utils/markdown.js';
import { revealSearchPreview } from './previewer.js';

/** 一次文字提取的结果；text 用于匹配，spans 用于高亮，roots 用于监听后续内容变化。 */
export interface TextSnapshot {
    text: string;
    /** 每个文本节点在合并字符串中的 [start, end) 范围。 */
    spans: { start: number; end: number; node: Text }[];
    /** 包含入口容器及遍历到的 ShadowRoot、iframe 正文、惰性模板等独立子树。 */
    roots: ParentNode[];
}

// 所有搜索临时装饰共用这个标记：提取时排除，MutationObserver 也忽略它们。
export const FIND_DECORATION = 'data-chat-find-decoration';
/** 节点本身或其父级属于搜索高亮装饰时，视为搜索自身产生的 DOM 变化。 */
export function isChatFindDecoration(node: Node): boolean {
    const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    return Boolean(element?.closest(`[${FIND_DECORATION}]`));
}
// 块级内容和 SVG 的每个 text 元素之间添加换行，避免相邻段落被直接拼成同一句。
const BLOCK = /^(P|DIV|PRE|LI|TR|TD|TH|H[1-6]|BLOCKQUOTE|SECTION|TEXT)$/;
// 源码、控件、SVG 定义/说明等内容不作为搜索正文。
const NON_CONTENT = 'script,style,button,math,annotation,defs,title,desc,[' + FIND_DECORATION + ']';
const EXCLUDED_MARKUP = [
    MARKDOWN_DOM.codeHeader,
    MARKDOWN_DOM.mermaidHeader,
    MARKDOWN_DOM.mermaidSource,
    MARKDOWN_DOM.mermaidFallback,
    // KaTeX 的无障碍 MathML 与可视 HTML 重复，只读取可视文字。
    'katex-mathml',
    // 兼容旧消息中以 DOM 节点保存的行号；当前行号由 CSS 计数器生成。
    'code-line-number',
    'line-number'
]
    .map((name) => `.${name}`)
    .join(',');

/** 将特殊内容的排除规则集中在这里，通用遍历只负责文字和 DOM 边界。 */
function isSearchSourceOrDecoration(element: Element): boolean {
    if (element.matches(NON_CONTENT) || element.matches(EXCLUDED_MARKUP)) return true;
    if (!element.classList.contains(MARKDOWN_DOM.codeBody)) return false;
    // 可切换预览的代码块只搜索显示效果；普通代码块仍搜索正文源码。
    const block = element.parentElement;
    const hasPreview = block?.dataset.previewable === 'true' || block?.dataset.previewEnhanced === 'true';
    if (hasPreview) return true;
    for (const className of element.classList) {
        if (!className.startsWith('language-')) continue;
        const language = className.slice('language-'.length);
        if (PREVIEWABLE_CODE_LANGUAGES.has(language)) return true;
    }
    return false;
}

/** 沿显示结构向上找父级：插槽 → 普通父元素 → Shadow DOM 宿主 → iframe 元素。 */
export function chatFindParent(element: Element): Element | null {
    if (element.assignedSlot) return element.assignedSlot;
    if (element.parentElement) return element.parentElement;
    const root = element.getRootNode() as ShadowRoot;
    if (root.host) return root.host;
    try {
        return element.ownerDocument.defaultView?.frameElement ?? null;
    } catch {
        return null;
    }
}

/** 跳转前逐层展开折叠区域，并将可切换模块切到显示效果；这些界面特例集中在此处。 */
export function revealChatFindContent(start: Element, boundary: Element): void {
    for (let element: Element | null = start; element && element !== boundary; element = chatFindParent(element)) {
        if (element.tagName === 'DETAILS') element.setAttribute('open', '');
        if (element.matches('.od-completed-process-detail:not(.is-open)')) {
            element.parentElement?.querySelector<HTMLButtonElement>('[data-completed-process-toggle]')?.click();
        }
        revealSearchPreview(element);
    }
}

/**
 * 按 DOM 顺序收集允许搜索的文字，同时记录原始文本节点，供匹配偏移映射回页面。
 * 不按 display 判断是否收集：预览暂时隐藏时仍搜索其显示效果，源码区域则明确排除。
 */
export function readChatFindText(root: ParentNode): TextSnapshot {
    let text = '';
    const spans: TextSnapshot['spans'] = [];
    const roots: ParentNode[] = [root];
    // 只补必要的换行，既保留段落边界，也避免多个嵌套 div 产生大量空行。
    const appendLineBreak = () => {
        if (text && !text.endsWith('\n')) text += '\n';
    };
    // 普通 DOM 遍历不会自动进入这些独立子树，同时记录它们供观察器单独订阅。
    const visitRoot = (nestedRoot: ParentNode) => {
        roots.push(nestedRoot);
        for (const child of Array.from(nestedRoot.childNodes)) visit(child);
    };
    const visit = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            const value = node.textContent || '';
            // 偏移基于合并后的 UTF-16 字符串，保留 node 才能把命中位置还原成 DOM Range。
            spans.push({ start: text.length, end: text.length + value.length, node: node as Text });
            text += value;
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const element = node as HTMLElement;
        if (isSearchSourceOrDecoration(element)) return;
        const tag = element.tagName.toUpperCase();
        const isBlock = BLOCK.test(tag) || element.classList.contains(MARKDOWN_DOM.codeLine);
        if (isBlock || tag === 'BR') appendLineBreak();
        // 只进入搜索专用的惰性模板，其内容可读取，但不挂成实际运行的预览页面。
        if (tag === 'TEMPLATE' && element.hasAttribute(SEARCH_PREVIEW_TEMPLATE)) {
            visitRoot((element as HTMLTemplateElement).content);
        } else if (tag === 'SLOT') {
            // 优先读取插槽实际分配的节点；没有分配内容时才读取插槽的默认子节点。
            const assigned = (element as HTMLSlotElement).assignedNodes?.({ flatten: true }) ?? [];
            let displayedNodes = assigned;
            if (displayedNodes.length === 0) displayedNodes = Array.from(element.childNodes);
            for (const child of displayedNodes) visit(child);
        } else if (element.shadowRoot) {
            // 优先读取 Shadow DOM，避免把宿主下未显示的普通子节点重复计入。
            visitRoot(element.shadowRoot);
        } else if (tag === 'IFRAME') {
            try {
                const body = (element as HTMLIFrameElement).contentDocument?.body;
                if (body) visitRoot(body);
            } catch {
                // 只读取可访问的同源 iframe；跨域页面无法访问时跳过。
            }
        } else {
            for (const child of Array.from(element.childNodes)) visit(child);
        }
        if (isBlock) appendLineBreak();
    };
    for (const child of Array.from(root.childNodes)) visit(child);
    return { text, spans, roots };
}

/**
 * 把文本中的一次 [start, end) 命中换成可绘制的 Range。
 * Range 不能跨文档/DOM 根；不同 SVG text 元素也分开绘制，因此一次命中可能返回多个范围。
 */
export function chatFindRanges(snapshot: TextSnapshot, start: number, end: number): Range[] {
    const ranges: Range[] = [];
    let previousRangeRoot: Node | undefined;
    // 二分查找第一个与命中相交的文本节点，避免每次都从正文开头扫描。
    let firstSpanIndex = 0;
    let searchEnd = snapshot.spans.length;
    while (firstSpanIndex < searchEnd) {
        const middle = Math.floor((firstSpanIndex + searchEnd) / 2);
        if (snapshot.spans[middle].end <= start) {
            firstSpanIndex = middle + 1;
        } else {
            searchEnd = middle;
        }
    }
    for (let index = firstSpanIndex; index < snapshot.spans.length; index++) {
        const span = snapshot.spans[index];
        if (span.start >= end) break;
        // SVG 按各个 text 元素分段，普通文本按其所属的 DOM 根分段。
        const rangeRoot = span.node.parentElement?.closest('text') ?? span.node.getRootNode();
        let range = ranges.at(-1);
        if (!range || rangeRoot !== previousRangeRoot) {
            range = span.node.ownerDocument.createRange();
            range.setStart(span.node, Math.max(0, start - span.start));
            ranges.push(range);
        }
        // 合并字符串偏移减去该节点的起始偏移，得到节点内部的字符位置。
        const endOffset = Math.min(span.end, end) - span.start;
        range.setEnd(span.node, endOffset);
        previousRangeRoot = rangeRoot;
    }
    return ranges;
}
