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

function countDescendants(node: AriaNode): number {
    let n = 0;
    for (const child of node.children) {
        if (typeof child === 'string') continue;
        n += 1 + countDescendants(child);
    }
    return n;
}

/**
 * P1: fold subtrees that lie entirely outside the current viewport into a
 * one-line summary so a long page shrinks to the part the agent actually sees.
 * Nodes are only marked collapsed (children are retained in the in-memory tree),
 * so `explore(ref)` can still expand a folded region on demand.
 *
 * Enabled via the `viewportOnly` snapshot option. Unlike the earlier
 * ref-gated version, offscreen subtrees are folded even when they contain
 * interactable (ref) descendants: the agent works against the visible region
 * and can re-snapshot / explore to reach the rest — that is the semantic of a
 * viewport-focused snapshot.
 *
 * Requires the injection script to attach `box.inViewport` at capture time.
 */
export const pruneOffscreenPass: AriaPass = (node: AriaNode): AriaNode => {
    if (node.box && node.box.inViewport === false && !node.collapsed) {
        return { ...node, collapsed: true, collapsedCount: countDescendants(node) };
    }
    return node;
};
