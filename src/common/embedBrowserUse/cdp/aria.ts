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
 * embedBrowserUse — ARIA tree types, merge utilities, YAML rendering,
 * and nested-iframe coordinate resolution.
 */

import type { NestedJSResult } from './session.js';

// ---------------------------------------------------------------------------
// JSON-based Aria tree types
// ---------------------------------------------------------------------------

export interface AriaProperties {
    url?: string;
    placeholder?: string;
    value?: string;
    [key: string]: string | undefined;
}

export interface AriaNode {
    role: string;
    name: string;
    children: Array<AriaNode | string>;
    props: AriaProperties;
    ref?: string;
    checked?: boolean | 'mixed';
    disabled?: boolean;
    expanded?: boolean;
    level?: number;
    pressed?: boolean | 'mixed';
    selected?: boolean;
    /** For iframe nodes: src attribute of the iframe element */
    frameSrc?: string;
    /** For iframe nodes: index among sibling iframes (used for matching) */
    frameIndex?: number;
}

/** The JSON result returned by each frame's snapshot injection script. */
export interface FrameAriaResult {
    url: string;
    title: string;
    viewport: { width: number; height: number };
    scroll: { x: number; y: number };
    root: AriaNode;
    iframeUrls: string[];
}

// ---------------------------------------------------------------------------
// Ref parsing (iframe-path aware)
// ---------------------------------------------------------------------------

/**
 * Parse a ref like "e5", "e5-e3", or "e5-e3-e1".
 * Returns the chain from outermost to innermost.
 * The last element is always the target element ref.
 */
export function parseRef(ref: string): string[] {
    return ref.split('-');
}

/**
 * Check whether a ref contains an iframe chain (multiple parts).
 */
export function isNestedRef(ref: string): boolean {
    return ref.split('-').length > 1;
}

// ---------------------------------------------------------------------------
// Tree merging — attach child frame trees under iframe nodes
// ---------------------------------------------------------------------------

/** Parse a JS result (string from JSON.stringify) into FrameAriaResult. */
function parseFrameResult(mainResult: unknown): FrameAriaResult {
    if (typeof mainResult === 'string') {
        return JSON.parse(mainResult) as FrameAriaResult;
    }
    return mainResult as FrameAriaResult;
}

/** Recursively prepend a prefix to all refs in a subtree. */
function prependRefToTree(node: AriaNode, prefix: string): void {
    if (node.ref) {
        node.ref = prefix + '-' + node.ref;
    }
    for (const child of node.children) {
        if (typeof child !== 'string') {
            prependRefToTree(child, prefix);
        }
    }
}

/**
 * Walk the aria tree and merge child frame results.
 *
 * Strategy:
 * - Find iframe nodes (role === 'iframe') in the tree
 * - Match them to child frame results by DOM order (frameIndex)
 *   — NOT by URL, because iframe.src is the initial URL and doesn't
 *   reflect internal navigations within the iframe
 * - Prepend the iframe's ref (or frameIndex fallback) to all refs in the child tree
 * - Replace the iframe node's children with the child tree's children
 * - Recursively merge nested iframes within the child tree
 */
function walkAndMerge(node: AriaNode, availableFrames: Array<[string, NestedJSResult]>): void {
    // First pass: collect all iframe nodes at this level, merge them
    for (const child of node.children) {
        if (typeof child === 'string') continue;
        if (child.role === 'iframe' && child.frameSrc && child.frameIndex !== undefined) {
            const idx = child.frameIndex;
            if (idx >= 0 && idx < availableFrames.length) {
                const [frameToken, frameResult] = availableFrames[idx];

                try {
                    const parsed = parseFrameResult(frameResult.mainResult);

                    // Prepend prefix to all child refs.
                    // Use iframe's ref if available; otherwise generate from frameIndex.
                    const prefix = child.ref || `f${child.frameIndex}`;
                    if (parsed.root) {
                        prependRefToTree(parsed.root, prefix);
                    }

                    // Attach child tree children to the iframe node
                    child.children = parsed.root.children;

                    // Recursively merge nested iframes in the child tree
                    walkAndMerge(child, Object.entries(frameResult.frameResults));
                } catch {
                    // Frame result unparseable — skip
                }
            }
        }
    }

    // Second pass: recursively walk non-iframe children too
    // (handles iframe nodes that appear deeper in generic wrappers)
    for (const child of node.children) {
        if (typeof child === 'string') continue;
        // We already walked the node above (for iframe handling),
        // but also need to recurse into non-iframe subtrees
        if (child.role !== 'iframe') {
            walkAndMerge(child, availableFrames);
        }
    }
}

/**
 * Merge all child frame ARIA trees into the main frame tree.
 *
 * @param root - The main frame's root AriaNode (typically role=fragment)
 * @param frameResults - Child frame results from executeJavaScriptOnAllFrames
 */
export function mergeFrameTrees(root: AriaNode, frameResults: Record<string, NestedJSResult>): void {
    const availableFrames = Object.entries(frameResults);
    if (availableFrames.length === 0) return;
    walkAndMerge(root, availableFrames);
}

// ---------------------------------------------------------------------------
// YAML rendering (backward-compatible with existing snapshot output)
// ---------------------------------------------------------------------------

function yamlNeedsQuotes(str: string): boolean {
    if (!str.length) return true;
    if (/^\s|\s$/.test(str)) return true;
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(str)) return true;
    if (/^-/.test(str)) return true;
    if (/[\n:]( |$)/.test(str)) return true;
    if (/\s#/.test(str)) return true;
    if (/[\n\r]/.test(str)) return true;
    if (/^[&*\\],?!>|@"'#%]/.test(str)) return true;
    if (/[{}`]/.test(str)) return true;
    if (/^\[/.test(str)) return true;
    const low = str.toLowerCase();
    if (!isNaN(Number(str)) || ['y', 'n', 'yes', 'no', 'true', 'false', 'on', 'off', ''].indexOf(low) !== -1)
        return true;
    return false;
}

function yamlEscapeKey(str: string): string {
    if (!yamlNeedsQuotes(str)) return str;
    return "'" + str.replace(/'/g, "''") + "'";
}

function yamlEscapeValue(str: string): string {
    if (!yamlNeedsQuotes(str)) return str;
    return JSON.stringify(str);
}

function hasVisibleRef(node: AriaNode): boolean {
    return !!node.ref;
}

function createKey(node: AriaNode): string {
    let key = node.role;
    if (node.name && node.name.length <= 900) key += ' ' + JSON.stringify(node.name);

    if (node.checked === 'mixed') key += ' [checked=mixed]';
    else if (node.checked === true) key += ' [checked]';
    if (node.disabled) key += ' [disabled]';
    if (node.expanded === true) key += ' [expanded]';
    if (node.level) key += ' [level=' + node.level + ']';
    if (node.pressed === 'mixed') key += ' [pressed=mixed]';
    else if (node.pressed === true) key += ' [pressed]';
    if (node.selected === true) key += ' [selected]';

    // option value attribute
    if (node.role === 'option' && node.props.value !== undefined)
        key += ' [value=' + JSON.stringify(node.props.value) + ']';

    if (node.ref) {
        key += ' [ref=' + node.ref + ']';
    }

    return key;
}

function indent(d: number): string {
    let s = '';
    for (let i = 0; i < d; i++) s += '  ';
    return s;
}

function getSingleTextChild(n: AriaNode): string | undefined {
    if (n.children.length === 1 && typeof n.children[0] === 'string' && Object.keys(n.props).length === 0)
        return n.children[0] as string;
    return undefined;
}

function renderYamlNodes(nodes: Array<AriaNode | string>): string {
    const lines: string[] = [];

    function visitText(text: string, depth: number): void {
        const escaped = yamlEscapeValue(text);
        if (escaped) lines.push(indent(depth) + '- text: ' + escaped);
    }

    function visit(node: AriaNode, depth: number): void {
        const escapedKey = indent(depth) + '- ' + yamlEscapeKey(createKey(node));
        const singleText = getSingleTextChild(node);
        const hasNoChildren = !singleText && !node.children.length;
        let propsCount = Object.keys(node.props).length;
        if (node.role === 'option' && node.props.value !== undefined) propsCount--;

        if (hasNoChildren && !propsCount) {
            lines.push(escapedKey);
        } else if (singleText !== undefined) {
            lines.push(escapedKey + ': ' + yamlEscapeValue(singleText));
        } else {
            lines.push(escapedKey + ':');
            const propKeys = Object.keys(node.props);
            for (const pk of propKeys) {
                if (node.role === 'option' && pk === 'value') continue;
                lines.push(indent(depth + 1) + '- /' + pk + ': ' + yamlEscapeValue(node.props[pk] || ''));
            }
            for (const child of node.children) {
                if (typeof child === 'string') visitText(child, depth + 1);
                else visit(child, depth + 1);
            }
        }
    }

    for (const n of nodes) {
        if (typeof n === 'string') visitText(n, 0);
        else visit(n, 0);
    }
    return lines.join('\n');
}

/**
 * Render an AriaNode tree to a YAML string (Playwright-compatible format).
 */
export function renderAriaTreeToYaml(root: AriaNode): string {
    const nodesToRender = root.role === 'fragment' ? root.children : [root];
    return renderYamlNodes(nodesToRender);
}

// ---------------------------------------------------------------------------
// Frame tree helpers
// ---------------------------------------------------------------------------

/**
 * Find the child WebFrameMain corresponding to an iframe element identified
 * by its data-od-ref in the given parent frame.
 *
 * Uses DOM order to match: the N-th <iframe> in the parent frame corresponds
 * to parentFrame.frames[N].  This works for cross-origin iframes because
 * Electron tracks all frames regardless of origin.
 */
async function findChildFrame(parentFrame: Electron.WebFrameMain, iframeRef: string): Promise<Electron.WebFrameMain> {
    // Get the iframe's index among all iframes in the parent DOM
    const indexResult = await parentFrame.executeJavaScript(
        `(() => {
            var el = document.querySelector('[data-od-ref="${iframeRef}"]');
            if (!el || el.tagName !== 'IFRAME') return -1;
            var all = document.querySelectorAll('iframe');
            for (var i = 0; i < all.length; i++) {
                if (all[i] === el) return i;
            }
            return -1;
        })()`
    );
    const iframeIndex = indexResult as number;
    if (iframeIndex < 0 || iframeIndex >= parentFrame.frames.length) {
        // Fallback: try URL-based matching
        const srcResult = await parentFrame.executeJavaScript(
            `(() => {
                var el = document.querySelector('[data-od-ref="${iframeRef}"]');
                return el ? (el.src || '') : '';
            })()`
        );
        const src = srcResult as string;
        const normalized = normalizeUrl(src);
        const match = parentFrame.frames.find((f) => normalizeUrl(f.url) === normalized);
        if (match) return match;
        throw new Error(
            `Cannot access iframe "${iframeRef}" (src: ${src}). ` +
                'The iframe may be cross-origin and not tracked by Electron.'
        );
    }
    return parentFrame.frames[iframeIndex];
}

// ---------------------------------------------------------------------------
// Nested iframe coordinate resolution
// ---------------------------------------------------------------------------

/**
 * Navigate the WebFrameMain tree to find the frame containing a nested ref.
 *
 * For ref "e5-e3-e1":
 * 1. In main frame: find iframe e5 → navigate to child frame by DOM order
 * 2. In child frame: find iframe e3 → navigate to grandchild
 * 3. Return { frame: grandchild, elementRef: "e1" }
 */
export async function navigateToFrame(
    mainFrame: Electron.WebFrameMain,
    ref: string
): Promise<{ frame: Electron.WebFrameMain; elementRef: string }> {
    const parts = ref.split('-');
    let currentFrame = mainFrame;

    for (let i = 0; i < parts.length - 1; i++) {
        currentFrame = await findChildFrame(currentFrame, parts[i]);
    }

    return { frame: currentFrame, elementRef: parts[parts.length - 1] };
}

/**
 * Navigate INTO an iframe (or nested iframe chain).
 *
 * Unlike navigateToFrame (which stops at the frame containing the element),
 * this function navigates INTO each iframe in the chain.  The final frame
 * is the content document of the last iframe.
 *
 * For iframeRef "e5": find iframe e5 in main frame → return its content frame.
 * For iframeRef "e5-e7": find iframe e5 in main frame → enter its content →
 *   find iframe e7 → return its content frame.
 */
export async function navigateIntoFrame(
    mainFrame: Electron.WebFrameMain,
    iframeRef: string
): Promise<Electron.WebFrameMain> {
    const parts = iframeRef.split('-');
    let currentFrame = mainFrame;

    for (const part of parts) {
        currentFrame = await findChildFrame(currentFrame, part);
    }

    return currentFrame;
}

/**
 * Walk the WebFrameMain tree to resolve a nested ref to absolute viewport
 * coordinates.
 *
 * For a ref like "e5-e3-e1":
 * 1. In main frame: find iframe e5 → get its top-left rect + src
 * 2. Navigate to child frame by URL match
 * 3. In child frame: find iframe e3 → get its top-left rect + src
 * 4. Navigate to grandchild frame
 * 5. In grandchild frame: find element e1 → get its center coords
 * 6. Return: sum of all offsets
 *
 * Uses WebFrameMain.executeJavaScript() which works cross-origin.
 */
export async function resolveNestedRefCoords(
    mainFrame: Electron.WebFrameMain,
    ref: string
): Promise<{ x: number; y: number; tag: string; text: string }> {
    const parts = ref.split('-');

    let currentFrame: Electron.WebFrameMain = mainFrame;
    let totalX = 0;
    let totalY = 0;

    for (let i = 0; i < parts.length; i++) {
        const isLast = i === parts.length - 1;
        const currentRef = parts[i];

        // For iframe elements: get top-left corner + src
        // For target element: get center coordinates
        const jsExpr = isLast
            ? `(async () => {
                var el = document.querySelector('[data-od-ref="${currentRef}"]');
                if (!el) return JSON.stringify({ error: 'Element ref "${currentRef}" not found. Page may have changed — call snapshot to refresh.' });
                el.scrollIntoView({ block: 'center', behavior: 'instant' });
                await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                var rect = el.getBoundingClientRect();
                var cx = Math.round(rect.left + rect.width / 2);
                var cy = Math.round(rect.top + rect.height / 2);
                return JSON.stringify({
                    x: cx, y: cy,
                    tag: el.tagName.toLowerCase(),
                    text: (el.innerText || '').trim().slice(0, 80)
                });
            })()`
            : `(() => {
                var el = document.querySelector('[data-od-ref="${currentRef}"]');
                if (!el) return JSON.stringify({ error: 'Iframe ref "${currentRef}" not found. Page may have changed — call snapshot to refresh.' });
                var rect = el.getBoundingClientRect();
                return JSON.stringify({
                    x: rect.left, y: rect.top,
                    tag: el.tagName.toLowerCase(),
                    text: '',
                    src: el.src || ''
                });
            })()`;

        const rawResult = await currentFrame.executeJavaScript(jsExpr);
        const info = JSON.parse(rawResult as string);
        if (info.error) throw new Error(info.error);

        totalX += info.x;
        totalY += info.y;

        if (!isLast) {
            // Navigate to child frame by DOM order
            currentFrame = await findChildFrame(currentFrame, currentRef);
        } else {
            return { x: totalX, y: totalY, tag: info.tag, text: info.text };
        }
    }

    throw new Error(`Unreachable: failed to resolve ref "${ref}"`);
}
