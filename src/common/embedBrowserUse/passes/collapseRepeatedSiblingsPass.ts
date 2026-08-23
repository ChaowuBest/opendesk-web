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
 * Minimum number of consecutive structurally-identical siblings that triggers
 * folding into a single representative. Large enough to leave small nav bars /
 * button groups alone. JD channel lists and product grids (30+) fold cleanly.
 */
export const REPEATED_SIBLING_THRESHOLD = 8;

/** How deep to recurse when computing a structural signature. */
const SHAPE_MAX_DEPTH = 4;

/**
 * Structural signature of a node IGNORING accessible names, text children, ref
 * distribution and link target values. Decorator `generic` wrappers (no ref, no
 * name) are transparent — only their child skeleton contributes. Two product
 * cards whose DOM skeletons line up (image + a named block + a link) but which
 * differ in badges/prices/titles produce the same key, so a grid renders as one
 * sample + a repeat marker instead of dozens of near-identical lines.
 */
function shapeKey(node: AriaNode, depth: number): string {
    if (depth >= SHAPE_MAX_DEPTH) return node.role;

    const kids: string[] = [];
    const nextDepth = depth + 1;
    for (const child of node.children) {
        if (typeof child === 'string') continue;
        kids.push(shapeKey(child, nextDepth));
    }

    // Decoration generics are transparent: skip them, only keep children.
    const transparentGeneric = node.role === 'generic' && !node.ref && !node.name && kids.length > 0;
    if (transparentGeneric) return kids.join('|');

    let key = node.role;
    // Keep the shape of props KEYS (not values) so e.g. "a link vs a plain
    // span" stay distinct, while two links to different URLs still match.
    const propKeys = Object.keys(node.props).sort().join(',');
    if (propKeys) key += '[' + propKeys + ']';
    if (kids.length) key += '(' + kids.join('|') + ')';
    return key;
}

/**
 * P0: collapse runs of structurally identical siblings (channel grids, product
 * racks) into their first element, marked with repeatCount. The representative
 * keeps its full subtree as a sample and stays explorable; the N-1 duplicates
 * are dropped from the snapshot so a 60-item grid costs one node worth of
 * tokens. Interaction is unaffected: dropped nodes keep their data-od-ref in
 * the DOM, so click/CSS-selector targeting still works.
 */
export const collapseRepeatedSiblingsPass: AriaPass = (node: AriaNode): AriaNode => {
    const children: Array<AriaNode | string> = [];
    let runStart = -1;
    let runKey = '';
    let runCount = 0;

    const flushRun = (endIndex: number): void => {
        if (runCount < REPEATED_SIBLING_THRESHOLD) {
            for (let k = runStart; k < endIndex; k++) children.push(node.children[k]);
            return;
        }
        const representative = node.children[runStart] as AriaNode;
        // 不丢弃其余兄弟：挂到代表节点的 collapsedSiblings 下，渲染时折叠、
        // 但 explore(ref)/snapshot(ref) 仍能按 ref 定位到它们。
        const collapsedSiblings: AriaNode[] = [];
        for (let k = runStart + 1; k < endIndex; k++) {
            const sib = node.children[k];
            if (typeof sib !== 'string') collapsedSiblings.push(sib);
        }
        const folded: AriaNode = { ...representative, repeatCount: runCount };
        if (collapsedSiblings.length) folded.collapsedSiblings = collapsedSiblings;
        children.push(folded);
    };

    for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        if (typeof child === 'string') {
            if (runCount) flushRun(i);
            children.push(child);
            runStart = -1;
            runCount = 0;
            continue;
        }

        const key = shapeKey(child, 0);
        if (runCount === 0) {
            runStart = i;
            runKey = key;
            runCount = 1;
        } else if (key === runKey) {
            runCount++;
        } else {
            flushRun(i);
            runStart = i;
            runKey = key;
            runCount = 1;
        }
    }
    if (runCount) flushRun(node.children.length);

    return { ...node, children };
};
