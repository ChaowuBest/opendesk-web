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
 * Merge adjacent text fragments, collapse runs of whitespace, then drop a
 * single text child that merely repeats the node's accessible name.
 */
export const normalizeStringsPass: AriaPass = (node: AriaNode): AriaNode => {
    const merged: Array<AriaNode | string> = [];
    let buffer = '';
    const flush = (): void => {
        if (!buffer) return;
        const text = buffer.replace(/[\s ]+/g, ' ').trim();
        if (text) merged.push(text);
        buffer = '';
    };
    for (const child of node.children) {
        if (typeof child === 'string') buffer += child;
        else {
            flush();
            merged.push(child);
        }
    }
    flush();
    let children = merged;
    // Drop any text child that repeats the accessible name (whitespace-agnostic:
    // e.g. link name "…¥ 12.9" vs child text "…¥12.9" are the same content).
    if (node.name) {
        const normName = node.name.replace(/\s+/g, '');
        children = children.filter((c) => typeof c !== 'string' || c.replace(/\s+/g, '') !== normName);
    }
    if (children.length === 1 && typeof children[0] === 'string' && children[0] === node.name) {
        children = [];
    }
    return { ...node, children };
};
