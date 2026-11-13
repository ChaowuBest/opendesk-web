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

import type { AriaNode, AriaPass } from '../cdp/aria.js';

/**
 * Collapse runs of single-text generic leaves into a plain text child.
 *
 * E-commerce cards fragment prices/sell-points into many `<span>`-like generic
 * nodes (e.g. `¥` / `42` / `.` / `9`), each occupying one YAML line and often
 * carrying a useless ref. This pass lifts consecutive leaf-generics that hold
 * exactly one text child into a single string, so a price renders as
 * `¥42.9` instead of four lines.
 *
 * Distinguishing "fragment of a price" from "a real clickable button":
 * fragments appear as a RUN of consecutive text-leaf siblings; a button is an
 * ISOLATED single text leaf that carries a ref. So:
 *  - a run of >= 2 consecutive text leaves is always merged (drop the per-leaf
 *    refs — price/sell-point fragments are not interaction targets);
 *  - a lone text leaf with a ref is kept intact (real button, e.g. 加入购物车);
 *  - a lone ref-free text leaf is peeled to a string (decoration wrapper, lets
 *    the bottom-up pass collapse deep `generic > generic > text` chains).
 */
function isTextLeaf(node: AriaNode): boolean {
    if (node.role !== 'generic') return false;
    if (node.children.length !== 1 || typeof node.children[0] !== 'string') return false;
    if (Object.keys(node.props).length > 0) return false;
    // 交互叶不合并（BUG-30）：cursor:pointer 的纯文本 div（如 hover 触发区）
    // 是真实交互目标，合并成字符串会丢掉唯一的 ref 定位入口。
    if (node.box?.cursor === 'pointer' || node.box?.scrollable) return false;
    if (
        node.checked !== undefined ||
        node.disabled ||
        node.expanded !== undefined ||
        node.selected !== undefined ||
        node.level !== undefined ||
        node.pressed !== undefined
    ) {
        return false;
    }
    if (node.image) return false;
    return true;
}

export const simplifyTextLeafPass: AriaPass = (node: AriaNode): AriaNode => {
    const children: Array<AriaNode | string> = [];

    let i = 0;
    const items = node.children;
    while (i < items.length) {
        const child = items[i];

        if (typeof child === 'string' || !isTextLeaf(child)) {
            children.push(child);
            i++;
            continue;
        }

        // Count the run of consecutive text leaves starting at i.
        let j = i;
        while (j < items.length && typeof items[j] !== 'string' && isTextLeaf(items[j] as AriaNode)) {
            j++;
        }
        const runLen = j - i;

        if (runLen >= 2) {
            // Fragment run (e.g. ¥ 42 . 9): merge into one string, drop refs.
            let text = '';
            for (let k = i; k < j; k++) text += (items[k] as AriaNode).children[0] as string;
            children.push(text);
        } else {
            const lone = child as AriaNode;
            if (lone.ref) {
                // Isolated ref-bearing text leaf — likely a real button, keep it.
                children.push(lone);
            } else {
                // Isolated decoration leaf — peel to a string for upper layers.
                children.push(lone.children[0] as string);
            }
        }
        i = j;
    }

    return { ...node, children };
};
