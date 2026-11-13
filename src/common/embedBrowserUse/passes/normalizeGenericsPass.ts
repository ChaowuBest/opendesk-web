/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import type { AriaNode, AriaPass } from '../cdp/aria.js';

/**
 * Collapse unnamed `generic` wrappers that contribute no semantics of their
 * own: a generic with no name whose only meaningful child is a single
 * ref-bearing node (or nothing at all) is lifted away, promoting its children
 * into the parent.
 *
 * Folding must never orphan a ref: an EMPTY ref-bearing generic is kept as-is
 * (folding it would silently drop its ref and the agent would lose the only
 * handle to the actual element — e.g. a `<pre contenteditable>` chat editor
 * rendered on top of a placeholder div, before such editors map to 'textbox').
 * A ref-bearing generic that DOES carry ref-bearing children still folds: the
 * children are promoted and their refs keep the subtree reachable, so keeping
 * the wrapper would only add snapshot noise on wrapper-heavy pages.
 */
export const normalizeGenericsPass: AriaPass = (node: AriaNode): AriaNode => {
    const children: Array<AriaNode | string> = [];
    for (const child of node.children) {
        if (typeof child === 'string') {
            children.push(child);
            continue;
        }
        // 交互容器不折叠（BUG-30/09）：cursor:pointer 的容器与可滚动容器是
        // 真实的交互/定位目标（hover 触发区、overflow:auto 滚动区域），折叠会
        // 连同自己的 ref 一起丢掉，让元素既无 ref 也无 CSS 定位入口。
        const interactive = child.box?.cursor === 'pointer' || child.box?.scrollable;
        const meaningful = child.children.filter((c) => typeof c !== 'string' && !!(c as AriaNode).ref);
        const hasText = child.children.some((c) => typeof c === 'string');
        // Ref-bearing: fold only when a ref-bearing child is promoted (the
        // wrapper's own ref is sacrificed but the subtree stays reachable).
        // Ref-free: fold as long as at most one ref-bearing child is promoted.
        const canCollapse =
            child.role === 'generic' &&
            !child.name &&
            !hasText &&
            !interactive &&
            (child.ref ? meaningful.length >= 1 : meaningful.length <= 1);
        if (canCollapse) {
            for (const grand of child.children) children.push(grand);
        } else {
            children.push(child);
        }
    }
    return { ...node, children };
};
