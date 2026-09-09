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
 */
export function updateStreamingText(container: HTMLElement, html: string): void {
    const previous = renderedText.get(container);
    const children = [...container.childNodes];
    const valid =
        previous &&
        previous.blocks.length === children.length &&
        previous.blocks.every((block, index) => block.node === children[index]);
    if (valid && previous.html === html) return;

    const template = document.createElement('template');
    template.innerHTML = html;
    const blocks: RenderedBlock[] = [];
    const incoming = [...template.content.childNodes];
    for (let index = 0; index < incoming.length; index++) {
        const node = incoming[index];
        const source = node.nodeType === Node.ELEMENT_NODE ? (node as Element).outerHTML : node.textContent || '';
        const old = valid ? previous.blocks[index] : undefined;
        if (old && old.type === node.nodeType && old.source === source) {
            blocks.push(old);
        } else {
            if (children[index]) {
                children[index].replaceWith(node);
            } else {
                container.appendChild(node);
            }
            blocks.push({ source, type: node.nodeType, node });
        }
    }
    for (let index = incoming.length; index < children.length; index++) {
        children[index].remove();
    }
    // Weak keys release snapshots with their message part after history replacement.
    renderedText.set(container, { html, blocks });
}
