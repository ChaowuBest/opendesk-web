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

export interface AriaImageInfo {
    url: string;
    width: number;
    height: number;
}

export interface AriaNode {
    role: string;
    name: string;
    children: Array<AriaNode | string>;
    props: AriaProperties;
    /** Present for rendered <img> elements large enough to be useful as visual context. */
    image?: AriaImageInfo;
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
    /**
     * When true, the node's children are omitted from the rendered snapshot
     * (collapsed into a one-line summary) but remain present in the in-memory
     * tree so the `explore(ref)` tool can expand them on demand. This keeps the
     * default snapshot compact without losing information.
     */
    collapsed?: boolean;
    /** Total descendant count, shown in the collapsed summary line. */
    collapsedCount?: number;
    /**
     * When this node is a collapsed representative of a run of structurally
     * identical siblings, this holds the total count of siblings folded into it
     * (including this node). Used by collapseRepeatedSiblingsPass to stop
     * runaway list expansion (channel grids, product racks) with one line.
     */
    repeatCount?: number;
    /**
     * Structurally-identical siblings folded into this representative by
     * collapseRepeatedSiblingsPass. They are kept in memory — and searched by
     * findNodeByRef / collectRefs — so explore(ref) can still reach a folded
     * sibling, but they are only rendered when the snapshot is expanded
     * (collapse=false), keeping the default compact snapshot small.
     */
    collapsedSiblings?: AriaNode[];
    /**
     * Layout box of this node, computed at capture time. `inViewport` records
     * whether the element intersects the current viewport rectangle so passes
     * can prune offscreen noise (see pruneOffscreenPass). Present only for
     * elements that passed the visibility gate.
     */
    box?: { width: number; height: number; visible: boolean; inViewport: boolean; cursor?: string };
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

/**
 * 超长 URL（广告/跟踪 blob 可达数 KB，如 cm.bilibili.com 或 360 广告跳转链接）
 * 在渲染层截断显示。内存树保留完整 URL，click()/navigate() 不受影响。
 */
const URL_RENDER_MAX_LENGTH = 200;

/** Truncate an over-long URL for display in the rendered snapshot. */
export function truncateUrlForDisplay(url: string): string {
    if (url.length <= URL_RENDER_MAX_LENGTH) return url;
    return url.slice(0, URL_RENDER_MAX_LENGTH) + '...';
}

/**
 * Tracking / analytics query parameters that are safe to drop from a link URL
 * without affecting navigability. Whitelist-only: unknown parameters are always
 * kept, so new sites never lose meaningful data.
 */
const TRACKING_PARAM_NAMES = new Set([
    'scm',
    'pvid',
    'utparam',
    'spm',
    'spmTag',
    'babelChannel',
    'innerAnchor',
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
    'utm_id',
    'aplus_abtest',
    'tpp_buckets',
    'abid',
    'ab_info',
    'item_ctr',
    'item_ecpm',
    'x_object_type',
    'x_object_id',
    'pc_pvid',
    'pc_scene',
    'mix_group',
    'xxc',
    'mi_id'
]);

/** Query parameters whose presence means the URL should NOT be touched at all. */
const SENSITIVE_URL_PARAM =
    /(^|[?&])(token|sign|signature|sig|secret|auth|session|ticket|api[_-]?key|access[_-]?token|redirect|code|state)=/i;

/**
 * Strip tracking parameters from a link URL before it is rendered into the
 * snapshot, keeping the link navigable while shrinking huge e-commerce URLs
 * (e.g. taobao embeds a full analytics payload in every item link).
 *
 * Safety rules (fail-closed — never break a working link):
 *  - only http(s):// or protocol-relative (//host) URLs are touched;
 *  - URLs shorter than 80 chars are returned unchanged (no analytics payload);
 *  - URLs carrying sensitive params (token/sign/key/...) are skipped entirely;
 *  - only whitelisted tracking params are dropped, everything else is kept;
 *  - if nothing was removed, the original string is returned.
 */
export function sanitizeUrl(url: string): string {
    const trimmed = url.trim();
    if (!trimmed || trimmed.length <= 80) return url;
    if (!/^(https?:)?\/\//i.test(trimmed)) return url;
    if (SENSITIVE_URL_PARAM.test(trimmed)) return url;

    const qIndex = trimmed.indexOf('?');
    if (qIndex < 0) return url;

    const kept = trimmed
        .slice(qIndex + 1)
        .split('&')
        .filter((pair) => !TRACKING_PARAM_NAMES.has(pair.split('=')[0]));

    const cleaned = trimmed.slice(0, qIndex).concat(kept.length ? '?' + kept.join('&') : '');
    // Fail closed: if nothing was actually removed, keep the original string.
    return cleaned === trimmed ? url : cleaned;
}

function hasVisibleRef(node: AriaNode): boolean {
    return !!node.ref;
}

function createKey(node: AriaNode, compactImages: boolean): string {
    let key = node.role;
    if (node.name && node.name.length <= 900) key += ' ' + JSON.stringify(node.name);
    if (node.role === 'img' && node.image) {
        if (compactImages) {
            // P1: compact 快照（默认）不把超长 CDN URL 塞进输出，仅保留渲染尺寸。
            // explore() / diff 以 collapse=false 渲染时仍给出完整 URL。
            key += ` [img ${node.image.width}*${node.image.height}]`;
        } else {
            key += ` <${node.image.url}>, size: ${node.image.width} * ${node.image.height}`;
        }
    }

    if (node.checked === 'mixed') key += ' [checked=mixed]';
    else if (node.checked === true) key += ' [checked]';
    if (node.disabled) key += ' [disabled]';
    if (node.expanded === true) key += ' [expanded]';
    if (node.level) key += ' [level=' + node.level + ']';
    if (node.pressed === 'mixed') key += ' [pressed=mixed]';
    else if (node.pressed === true) key += ' [pressed]';
    if (node.selected === true) key += ' [selected]';

    if (node.collapsed) {
        const n = node.collapsedCount ?? countDescendants(node);
        // 折叠摘要带上子树首个文本预览，agent 无需盲猜被折叠的内容
        // （如"该不该滚动/展开"）。无文本子树（纯图片等）不追加预览。
        const preview = subtreeTextPreview(node);
        if (preview) {
            const capped =
                preview.length > COLLAPSE_PREVIEW_MAX_LENGTH
                    ? preview.slice(0, COLLAPSE_PREVIEW_MAX_LENGTH) + '...'
                    : preview;
            key += ` [collapsed, ${n} descendants, ${JSON.stringify(capped)}]`;
        } else {
            key += ` [collapsed, ${n} descendants]`;
        }
    }
    if (node.repeatCount && node.repeatCount > 1) {
        key += ` [repeated x${node.repeatCount}]`;
    }

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

/** 折叠预览的文本长度上限。 */
const COLLAPSE_PREVIEW_MAX_LENGTH = 40;

/**
 * 深度优先提取子树中第一段非空文本（name 优先于文本子节点），
 * 用作折叠节点的摘要预览。
 */
function subtreeTextPreview(node: AriaNode): string | null {
    if (node.name) return node.name;
    for (const c of node.children) {
        if (typeof c === 'string') {
            const t = c.trim();
            if (t) return t;
        } else {
            const p = subtreeTextPreview(c);
            if (p) return p;
        }
    }
    if (node.collapsedSiblings) {
        for (const sib of node.collapsedSiblings) {
            const p = subtreeTextPreview(sib);
            if (p) return p;
        }
    }
    return null;
}

function getSingleTextChild(n: AriaNode): string | undefined {
    if (n.children.length === 1 && typeof n.children[0] === 'string' && Object.keys(n.props).length === 0)
        return n.children[0] as string;
    return undefined;
}

function renderYamlNodes(nodes: Array<AriaNode | string>, collapse: boolean): string {
    const lines: string[] = [];

    function visitText(text: string, depth: number): void {
        const escaped = yamlEscapeValue(text);
        if (escaped) lines.push(indent(depth) + '- text: ' + escaped);
    }

    function visit(node: AriaNode, depth: number): void {
        // collapse=true 生成紧凑快照（默认，img URL 压缩）；collapse=false 由
        // explore()/diff 使用，展开全量内容（含完整 img URL）。
        const escapedKey = indent(depth) + '- ' + yamlEscapeKey(createKey(node, collapse));

        // A collapsed node is rendered as a single summary line; its children
        // are intentionally omitted from the output but remain in the cached
        // tree so the explore() tool can expand them on demand.
        if (collapse && node.collapsed) {
            lines.push(escapedKey);
            return;
        }

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
                // Render URL through sanitizeUrl so huge tracking payloads
                // (taobao item links) shrink in the snapshot. The in-memory
                // tree keeps the original url for explore()/click().
                const raw = node.props[pk] || '';
                const shown = pk === 'url' ? truncateUrlForDisplay(sanitizeUrl(raw)) : raw;
                lines.push(indent(depth + 1) + '- /' + pk + ': ' + yamlEscapeValue(shown));
            }
            for (const child of node.children) {
                if (typeof child === 'string') visitText(child, depth + 1);
                else visit(child, depth + 1);
            }
            // explore 模式（collapse=false）下展开被折叠的结构相同兄弟，使 agent
            // 能查看整段重复区域；默认紧凑快照（collapse=true）保持单行代表。
            if (!collapse && node.collapsedSiblings && node.collapsedSiblings.length) {
                for (const sib of node.collapsedSiblings) visit(sib, depth + 1);
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
 *
 * @param collapse when true (default), collapsed nodes are rendered as a
 *   single summary line and their descendants are omitted. When false, the
 *   full tree is rendered regardless of `collapsed` flags — used by the
 *   explore() tool to expand a previously collapsed subtree.
 */
export function renderAriaTreeToYaml(root: AriaNode, collapse = true): string {
    const nodesToRender = root.role === 'fragment' ? root.children : [root];
    return renderYamlNodes(nodesToRender, collapse);
}

// ---------------------------------------------------------------------------
// Tree optimization passes (compiler-style AriaNode -> AriaNode visitors)
//
// The raw ARIA tree captured from the page preserves the maximum amount of
// AriaNode information. Every optimization is expressed as a pure pass that
// maps one node (whose children have already been processed) to a (possibly
// new) node. Passes are composed into a pipeline and applied after capture,
// keeping the capture step free of policy.
// ---------------------------------------------------------------------------

/**
 * An optimization pass transforms a single AriaNode — whose children have
 * already been visited by the same pass — into a (possibly new) AriaNode.
 * Passes must be pure with respect to the input tree: never mutate the
 * incoming node, always return a replacement.
 */
export type AriaPass = (node: AriaNode) => AriaNode;

/**
 * Generic bottom-up visitor. Recursively applies `pass` to every node: a
 * node's children are transformed first (bottom-up), then `pass` is invoked
 * on the current node with its already-transformed children in place.
 */
export function runAriaPass(node: AriaNode, pass: AriaPass): AriaNode {
    const children = node.children.map((child) => (typeof child === 'string' ? child : runAriaPass(child, pass)));
    const rebuilt: AriaNode = { ...node, children };
    return pass(rebuilt);
}

/** Fold a sequence of passes over the tree; each pass sees the prior result. */
export function runAriaPasses(root: AriaNode, passes: AriaPass[]): AriaNode {
    return passes.reduce<AriaNode>((tree, pass) => runAriaPass(tree, pass), root);
}

// ---------------------------------------------------------------------------
// Collapse / expand helpers for compact-but-lossless snapshots
// ---------------------------------------------------------------------------

/** Count all element (non-text) descendants of a node. */
export function countDescendants(node: AriaNode): number {
    let n = 0;
    for (const child of node.children) {
        if (typeof child === 'string') continue;
        n += 1 + countDescendants(child);
    }
    return n;
}

export interface CollapseOptions {
    /** Collapse iframe subtrees by default (expandable via explore). */
    collapseIframes?: boolean;
    /** Collapse generic subtrees at or below this depth when they carry no interactable ref. */
    maxDepth?: number;
    /** Landmark roles to always collapse once large enough. */
    landmarkRoles?: string[];
    /** Minimum direct-child count for a landmark to be collapsed. */
    minLandmarkChildren?: number;
}

/**
 * Mark "noisy" subtrees as collapsed. A collapsed node keeps its full set of
 * children in memory (so explore(ref) can expand them later) but renders as a
 * single summary line. This shrinks the default snapshot dramatically without
 * discarding any information.
 *
 * Collapse targets:
 *  - iframes (optional) — heavy / ad frames
 *  - landmark regions (e.g. contentinfo footer) once large enough
 *  - deep generic-only chains (decoration wrappers) carrying no interactable ref
 *
 * A node that has an interactable descendant (a `ref` somewhere below it) is
 * never collapsed, so every clickable element stays visible in the default
 * snapshot — only pure boilerplate / decoration is folded away.
 */
export function collapseNoisySubtrees(root: AriaNode, opts: CollapseOptions = {}): AriaNode {
    const collapseIframes = opts.collapseIframes ?? true;
    const maxDepth = opts.maxDepth ?? 8;
    const landmarkRoles = opts.landmarkRoles ?? ['contentinfo', 'banner'];
    const minLandmarkChildren = opts.minLandmarkChildren ?? 6;

    function walk(node: AriaNode, depth: number): void {
        const children = node.children.filter((c) => typeof c !== 'string') as AriaNode[];

        if (node.role === 'iframe' && collapseIframes) {
            node.collapsed = true;
        } else if (landmarkRoles.includes(node.role) && children.length >= minLandmarkChildren) {
            node.collapsed = true;
        } else if (depth >= maxDepth && node.role === 'generic' && !node.ref && !subtreeHasRef(node)) {
            node.collapsed = true;
        }

        if (node.collapsed) node.collapsedCount = countDescendants(node);

        for (const child of children) walk(child, depth + 1);
    }

    walk(root, 0);
    return root;
}

function subtreeHasRef(node: AriaNode): boolean {
    if (node.ref) return true;
    for (const child of node.children) {
        if (typeof child !== 'string' && subtreeHasRef(child)) return true;
    }
    if (node.collapsedSiblings) {
        for (const sib of node.collapsedSiblings) if (subtreeHasRef(sib)) return true;
    }
    return false;
}

/**
 * Find the node carrying `ref` (e.g. "e5" or nested "e5-e3-e1") within a tree.
 *
 * Refs are globally unique full paths: a node inside an iframe is assigned its
 * complete prefixed ref (e.g. "e5-e3") at capture time, so a single recursive
 * lookup by the full ref string is sufficient — no segment descent needed.
 * Returns undefined if not found.
 */
export function findNodeByRef(root: AriaNode, ref: string): AriaNode | undefined {
    return findDirectRef(root, ref);
}

function findDirectRef(node: AriaNode, ref: string): AriaNode | undefined {
    if (node.ref === ref) return node;
    for (const child of node.children) {
        if (typeof child !== 'string') {
            const r = findDirectRef(child, ref);
            if (r) return r;
        }
    }
    // Folded repeated siblings are not dropped from the tree: explore(ref) and
    // snapshot(ref) must still reach them by ref.
    if (node.collapsedSiblings) {
        for (const sib of node.collapsedSiblings) {
            const r = findDirectRef(sib, ref);
            if (r) return r;
        }
    }
    return undefined;
}

export interface SnapshotDiff {
    /** Refs present now but not before. */
    added: string[];
    /** Refs present before but not now. */
    removed: string[];
    /** Refs present in both but whose signature changed. */
    changed: string[];
    /** Compact YAML of the changed/added subtrees (plus a removed note). */
    yaml: string;
}

/**
 * Build a per-node content fingerprint covering the node AND its whole subtree
 * (children text, prop values, image urls, ARIA state). Used by diffTrees so a
 * change anywhere under a stable ref — not just on the ref node itself — is
 * detected. Deliberately EXCLUDES fold metadata (collapsed / collapsedCount /
 * repeatCount / box) so different folding policies between snapshots never
 * produce spurious diffs.
 *
 * Results are memoized bottom-up: each node's fingerprint reuses its children's,
 * so building the whole map is O(n) instead of O(n²).
 */
function buildContentSignatures(root: AriaNode): Map<AriaNode, string> {
    const sigMap = new Map<AriaNode, string>();

    function sig(node: AriaNode): string {
        const cached = sigMap.get(node);
        if (cached !== undefined) return cached;

        const parts: string[] = [node.role, node.name ?? ''];

        // Prop VALUES matter (a link whose URL changed is a real change), but key
        // order is not stable across captures, so sort entries before hashing.
        const propEntries = Object.entries(node.props).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        parts.push(JSON.stringify(propEntries));

        if (node.image) parts.push(`img:${node.image.url}`);
        if (node.checked !== undefined) parts.push(`checked:${String(node.checked)}`);
        if (node.disabled) parts.push('disabled');
        if (node.expanded !== undefined) parts.push(`expanded:${String(node.expanded)}`);
        if (node.level !== undefined) parts.push(`level:${node.level}`);
        if (node.pressed !== undefined) parts.push(`pressed:${String(node.pressed)}`);
        if (node.selected !== undefined) parts.push(`selected:${String(node.selected)}`);
        if (node.frameSrc !== undefined) parts.push(`frameSrc:${node.frameSrc}`);
        if (node.frameIndex !== undefined) parts.push(`frameIndex:${node.frameIndex}`);

        for (const c of node.children) {
            parts.push(typeof c === 'string' ? 's:' + c : sig(c));
        }
        if (node.collapsedSiblings) {
            for (const s of node.collapsedSiblings) parts.push('~' + sig(s));
        }

        const value = parts.join('|');
        sigMap.set(node, value);
        return value;
    }

    sig(root);
    return sigMap;
}

function collectRefs(node: AriaNode, map: Map<string, AriaNode>): void {
    if (node.ref) map.set(node.ref, node);
    for (const c of node.children) if (typeof c !== 'string') collectRefs(c, map);
    // Folded siblings keep their refs reachable so diff mode can still track
    // changes inside a collapsed repeated region.
    if (node.collapsedSiblings) for (const s of node.collapsedSiblings) collectRefs(s, map);
}

/**
 * Diff two full trees by stable ref, returning only what changed between them.
 * Used by the incremental snapshot mode so that after an action the agent
 * receives just the mutated subtrees instead of the whole (large) tree.
 *
 * Reported added/changed refs are the MINIMAL COVERING SET: subtree content
 * signatures propagate changes up to every ancestor, so a single deep text
 * change would otherwise mark the whole ancestor chain "changed" and render
 * each of them (collapse=false) - duplicating the entire tree several times
 * and producing a diff larger than a full snapshot (observed on taobao SKU
 * switch). Ancestors whose change is fully explained by a changed/added
 * descendant are dropped from both the lists and the rendered YAML.
 */
export function diffTrees(before: AriaNode, after: AriaNode): SnapshotDiff {
    const beforeMap = new Map<string, AriaNode>();
    const afterMap = new Map<string, AriaNode>();
    collectRefs(before, beforeMap);
    collectRefs(after, afterMap);

    // Fingerprint both trees once (bottom-up, O(n)); a ref is "changed" when the
    // content anywhere under it differs (text / prop values / descendants).
    const beforeSigs = buildContentSignatures(before);
    const afterSigs = buildContentSignatures(after);

    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];

    for (const [ref, node] of afterMap) {
        if (!beforeMap.has(ref)) added.push(ref);
        else if (beforeSigs.get(beforeMap.get(ref)!) !== afterSigs.get(node)) changed.push(ref);
    }
    for (const ref of beforeMap.keys()) {
        if (!afterMap.has(ref)) removed.push(ref);
    }

    // Minimal covering set - two opposite rules:
    //  - added: keep the TOP-MOST added nodes; a whole newly-inserted subtree
    //    is best represented by its root (descendants are implied).
    //  - changed: keep the DEEPEST changed nodes; ancestors whose signature
    //    changed only because of a descendant are implied by that descendant.
    const addedSet = new Set(added);
    const changedSet = new Set(changed);
    const addedTop: AriaNode[] = [];
    const changedDeepest: AriaNode[] = [];
    const pick = (node: AriaNode): void => {
        if (node.ref && addedSet.has(node.ref)) {
            addedTop.push(node);
            // Do not descend: descendants of a rendered added subtree are implied.
            return;
        }
        for (const c of node.children) {
            if (typeof c !== 'string') pick(c);
        }
        if (node.collapsedSiblings) {
            for (const sib of node.collapsedSiblings) pick(sib);
        }
    };
    pick(after);
    const covered = new Set(addedTop.map((nd) => nd.ref!));
    const pickDeepest = (node: AriaNode): boolean => {
        // Returns true when the subtree already contains a rendered change node.
        let hasCovered = false;
        for (const c of node.children) {
            if (typeof c !== 'string' && pickDeepest(c)) hasCovered = true;
        }
        if (node.collapsedSiblings) {
            for (const sib of node.collapsedSiblings) if (pickDeepest(sib)) hasCovered = true;
        }
        if (hasCovered) return true;
        if (node.ref && covered.has(node.ref)) return true;
        if (node.ref && changedSet.has(node.ref)) {
            changedDeepest.push(node);
            return true;
        }
        return false;
    };
    pickDeepest(after);

    const lines: string[] = [];
    if (removed.length) lines.push(`- removed: ${removed.join(', ')}`);
    for (const node of addedTop) {
        lines.push(renderAriaTreeToYaml({ role: 'fragment', name: '', children: [node], props: {} }, false));
    }
    for (const node of changedDeepest) {
        lines.push(renderAriaTreeToYaml({ role: 'fragment', name: '', children: [node], props: {} }, false));
    }
    return {
        added: addedTop.map((nd) => nd.ref!),
        removed,
        changed: changedDeepest.map((nd) => nd.ref!),
        yaml: lines.join('\n')
    };
}

/**
 * 变化过的 ref 总数达到该阈值时，diff 输出不再有价值（典型场景：跨页导航导致
 * 整棵树几乎全部替换），此时应回退完整折叠快照，避免 diff 比 full 还大。
 */
export const DIFF_FALLBACK_CHANGE_THRESHOLD = 80;

/**
 * 判断一次 diff 是否变化过大而应回退完整快照。
 * 变化量 = 新增 + 移除 + 变更 的 ref 总数。
 */
export function shouldFallbackToFullDiff(
    diff: SnapshotDiff,
    threshold: number = DIFF_FALLBACK_CHANGE_THRESHOLD
): boolean {
    return diff.added.length + diff.removed.length + diff.changed.length > threshold;
}

/**
 * 生成 ref 未命中时的降级提示，帮助 agent 区分「跨页导航」与「同页 SPA 重渲染」：
 * - prevUrl 与 curUrl 不同 → 页面已跨页，旧 ref 全部失效；
 * - 相同 → 页面结构变化（SPA 重渲染 / 动态列表刷新）导致 ref 重排。
 */
export function buildRefMissNote(ref: string, prevUrl: string | undefined, curUrl: string): string {
    const crossPage = prevUrl !== undefined && prevUrl !== curUrl;
    return crossPage
        ? `ref "${ref}" not found — 页面已跨页导航（${prevUrl} → ${curUrl}），旧 ref 失效，已降级返回完整快照。`
        : `ref "${ref}" not found — 页面结构已变化（SPA 重渲染导致 ref 重排），已降级返回完整快照。`;
}

// ---------------------------------------------------------------------------
// Optimization passes live in ./passes — each pass is its own file and is
// composed into DEFAULT_ARIA_PASSES (see passes/index.ts).
// ---------------------------------------------------------------------------

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
