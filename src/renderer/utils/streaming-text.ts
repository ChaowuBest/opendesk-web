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

interface RenderedBlock {
    source: string;
    type: number;
    node: ChildNode;
}

interface RenderedText {
    html: string;
    blocks: RenderedBlock[];
}

const renderedText = new WeakMap<HTMLElement, RenderedText>();

/**
 * Keep unchanged top-level Markdown blocks, including their copy/preview controls.
 * Compare against the source HTML rather than the enhanced live DOM. Parse the
 * complete snapshot so later Markdown (e.g. reference links) can revise any block.
 * Only changed blocks enter the live document; templates remain inert.
 *
 * 头部冻结：流式快照通常只在尾部增长，与已渲染块序列化结果逐字节一致的前缀
 * 无需重新解析——直接复用已挂载的节点，只解析并比对剩余尾部。逐字节前缀相等
 * 蕴含解析结果一致，因此跳过解析不会改变渲染输出；前缀比较失败时退回全量解析
 * （例如后到的 Markdown 语法修订了前面的块），正确性不受影响。每次更新的解析
 * 成本由此从 O(整份快照) 降为 O(变更尾部)。
 */
export function updateStreamingText(container: HTMLElement, html: string): void {
    const previous = renderedText.get(container);
    const children = [...container.childNodes];
    const valid =
        previous &&
        previous.blocks.length === children.length &&
        previous.blocks.every((block, index) => block.node === children[index]);
    if (valid && previous.html === html) return;

    let stableCount = 0;
    let prefixLength = 0;
    if (valid) {
        for (; stableCount < previous.blocks.length; stableCount++) {
            const source = previous.blocks[stableCount].source;
            if (!html.startsWith(source, prefixLength)) break;
            prefixLength += source.length;
        }
    }

    const template = document.createElement('template');
    template.innerHTML = stableCount > 0 ? html.slice(prefixLength) : html;
    const blocks: RenderedBlock[] = valid ? previous.blocks.slice(0, stableCount) : [];
    const incoming = [...template.content.childNodes];
    for (let index = 0; index < incoming.length; index++) {
        const node = incoming[index];
        const source = node.nodeType === Node.ELEMENT_NODE ? (node as Element).outerHTML : node.textContent || '';
        const blockIndex = stableCount + index;
        const old = valid ? previous.blocks[blockIndex] : undefined;
        if (old && old.type === node.nodeType && old.source === source) {
            blocks.push(old);
        } else {
            if (children[blockIndex]) {
                children[blockIndex].replaceWith(node);
            } else {
                container.appendChild(node);
            }
            blocks.push({ source, type: node.nodeType, node });
        }
    }
    for (let index = incoming.length + stableCount; index < children.length; index++) {
        children[index].remove();
    }
    // Weak keys release snapshots with their message part after history replacement.
    renderedText.set(container, { html, blocks });
}
