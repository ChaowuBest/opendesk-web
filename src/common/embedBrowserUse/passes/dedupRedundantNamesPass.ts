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
 * De-duplicate redundant nested names. When a child node repeats its parent's
 * accessible name it carries no new information of its own — lift any unique
 * props/ref and non-text children up into the parent, then drop the child.
 *
 * Example: `<td><a><span>same text</span></a></td>` collapses from three
 * identically-named levels into a single node, while a nested sub-link (e.g. a
 * PR reference) and the parent's `/url` prop are preserved.
 */
export const dedupRedundantNamesPass: AriaPass = (node: AriaNode): AriaNode => {
    if (!node.name) return node;
    const retained: Array<AriaNode | string> = [];
    const lifted: Array<AriaNode | string> = [];
    let props = node.props;
    let ref = node.ref;
    for (const child of node.children) {
        if (typeof child === 'string') {
            retained.push(child);
            continue;
        }
        if (child.name && child.name === node.name) {
            for (const key of Object.keys(child.props)) {
                if (props[key] === undefined) {
                    if (props === node.props) props = { ...props };
                    props[key] = child.props[key];
                }
            }
            if (!ref && child.ref) ref = child.ref;
            for (const grand of child.children) lifted.push(grand);
        } else {
            retained.push(child);
        }
    }
    return { ...node, children: [...retained, ...lifted], props, ref };
};
