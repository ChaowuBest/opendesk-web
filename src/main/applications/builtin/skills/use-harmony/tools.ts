/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

/**
 * HarmonyOS device control tools via hdc.
 *
 * Each tool wraps hdc shell commands to provide agent-friendly interfaces
 * for app management, UI interaction, and screen snapshot.
 *
 * All hdc invocations use async child processes to avoid blocking the Node.js event loop.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { BaseTool, BaseToolset } from '../../../../aikernel/tool.js';

// ---------------------------------------------------------------------------
// hdc helpers (async)
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

type Sharp = (typeof import('sharp'))['default'];

let sharpPromise: Promise<Sharp | null> | undefined;

function loadSharp(): Promise<Sharp | null> {
    sharpPromise ??= import('sharp').then((module) => module.default).catch(() => null);
    return sharpPromise;
}

async function runHdc(args: readonly string[], timeout = 15000): Promise<string> {
    const { stdout } = await execFileAsync('hdc', args, {
        encoding: 'utf-8',
        timeout,
        maxBuffer: 10 * 1024 * 1024
    });
    return stdout.trim();
}

function ok(data: Record<string, unknown>): string {
    return JSON.stringify({ success: true, ...data });
}

function fail(error: string): string {
    return JSON.stringify({ success: false, error });
}

// ---------------------------------------------------------------------------
// Device ID & listApps cache (in-memory, not persisted)
// ---------------------------------------------------------------------------

async function getDeviceId(): Promise<string> {
    const output = await runHdc(['list', 'targets'], 5000);
    const first = output
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0 && l !== '[Empty]');
    return first || 'default';
}

// Keyed by device ID; cleared on process restart.
const listAppsCache = new Map<string, { bundleName: string; label: string }[]>();

// ---------------------------------------------------------------------------
// Layout -> Aria tree conversion (ported from scripts/hdc_snapshot.js)
// ---------------------------------------------------------------------------

interface LayoutNode {
    attributes: Record<string, string>;
    children: LayoutNode[];
}

interface AriaNode {
    role: string;
    name: string;
    children: (AriaNode | string)[];
    props: Record<string, string>;
    ref?: string;
    center?: { x: number; y: number };
    width?: number;
    height?: number;
    checked?: boolean;
    disabled?: boolean;
    selected?: boolean;
}

interface SnapshotTarget {
    bounds: { x1: number; y1: number; x2: number; y2: number };
    bundleName?: string;
}

interface BuiltSnapshot {
    snapshot: string;
    fingerprint: string;
    targets: Map<string, SnapshotTarget>;
    bundleName?: string;
}

interface SnapshotCapture {
    snapshot: string;
    snapshotId: string;
    fingerprint: string;
    bundleName?: string;
}

interface PermissionActionTarget {
    action: 'allow' | 'allowOnce' | 'deny';
    label: string;
    target: SnapshotTarget;
}

interface PermissionDialog {
    title: string;
    message: string;
    actions: PermissionActionTarget[];
}

const TYPE_TO_ROLE: Record<string, string> = {
    button: 'button',
    Button: 'button',
    toggleButton: 'button',
    select: 'combobox',
    Select: 'combobox',
    comboBox: 'combobox',
    ComboBox: 'combobox',
    Toggle: 'switch',
    textField: 'textbox',
    TextInput: 'textbox',
    tab: 'tab',
    Image: 'img',
    image: 'img',
    SymbolGlyph: 'img',
    heading: 'heading',
    paragraph: 'paragraph',
    rootWebArea: 'RootWebArea',
    window: 'RootWebArea',
    List: 'list',
    ListItem: 'listitem',
    Grid: 'list',
    GridItem: 'listitem',
    Dialog: 'dialog',
    header: 'banner',
    WebView: 'iframe',
    Stack: 'generic',
    Column: 'generic',
    Row: 'generic',
    Flex: 'generic',
    RelativeContainer: 'generic',
    SideBarContainer: 'generic',
    genericContainer: 'generic',
    __Common__: 'generic',
    Scroll: 'generic',
    Badge: 'generic',
    XComponent: 'generic',
    canvas: 'generic',
    ContainerModal: 'generic',
    WindowScene: 'generic',
    root: 'generic',
    client: 'generic',
    JsView: 'generic',
    unknown: 'generic'
};

const SKIP_TYPES = new Set(['Blank', 'Divider']);
const TEXT_TYPES = new Set(['staticText', 'Text', 'paragraph']);
const ICON_TYPES = new Set(['Image', 'image', 'SymbolGlyph']);
const SCENEBOARD_BUNDLE = 'com.ohos.sceneboard';
const MAX_TEXT_LEN = 200;

function getRole(type: string): string {
    return TYPE_TO_ROLE[type] ?? 'generic';
}

function getName(attrs: Record<string, string>): string {
    return attrs.text || attrs.hint || attrs.description || attrs.originalText || '';
}

function parseBounds(str: string | undefined): { x1: number; y1: number; x2: number; y2: number } | null {
    const m = str?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!m) return null;
    return { x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4] };
}

function getCenter(b: { x1: number; y1: number; x2: number; y2: number } | null): { x: number; y: number } | null {
    if (!b) return null;
    return { x: Math.round((b.x1 + b.x2) / 2), y: Math.round((b.y1 + b.y2) / 2) };
}

function isUUID(str: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(str);
}

function convertNode(
    node: LayoutNode,
    ctx: { refIdx: number; targets: Map<string, SnapshotTarget>; bundleName?: string }
): AriaNode | string | null {
    if (!node || typeof node !== 'object') return null;

    const attrs = node.attributes || {};
    const type = attrs.type || '';

    if (attrs.visible === 'false') return null;
    if (SKIP_TYPES.has(type)) return null;
    // Skip icon-only nodes (Image/SymbolGlyph with no text/description)
    if (ICON_TYPES.has(type) && !getName(attrs)) return null;

    if (TEXT_TYPES.has(type)) {
        const text = getName(attrs);
        if (!text) return null;
        return text.length > MAX_TEXT_LEN ? text.slice(0, MAX_TEXT_LEN) + '...' : text;
    }

    const role = getRole(type);
    const name = getName(attrs);
    const bounds = parseBounds(attrs.bounds);
    const center = getCenter(bounds);

    const ariaNode: AriaNode = {
        role,
        name: name.length > MAX_TEXT_LEN ? name.slice(0, MAX_TEXT_LEN) + '...' : name,
        children: [],
        props: {}
    };

    if (attrs.checked === 'true') ariaNode.checked = true;
    if (attrs.selected === 'true') ariaNode.selected = true;
    if (attrs.enabled === 'false') ariaNode.disabled = true;

    if (attrs.hint && attrs.hint !== name) ariaNode.props.hint = attrs.hint;
    if (attrs.id && !isUUID(attrs.id) && attrs.id !== name) ariaNode.props.id = attrs.id;
    if (attrs.bundleName) ariaNode.props.bundle = attrs.bundleName;

    if ((attrs.clickable === 'true' || role === 'textbox') && center) {
        ariaNode.ref = 'e' + ctx.refIdx++;
        ariaNode.center = center;
        if (bounds) {
            ariaNode.width = bounds.x2 - bounds.x1;
            ariaNode.height = bounds.y2 - bounds.y1;
            ctx.targets.set(ariaNode.ref, {
                bounds,
                bundleName: attrs.bundleName || ctx.bundleName
            });
        }
    }

    for (const child of node.children || []) {
        const converted = convertNode(child, ctx);
        if (converted !== null) ariaNode.children.push(converted);
    }

    return ariaNode;
}

function normalizeNode(node: AriaNode | string): (AriaNode | string)[] {
    if (typeof node === 'string') return [node];
    if (!node) return [];

    const newChildren: (AriaNode | string)[] = [];
    for (const child of node.children) {
        newChildren.push(...normalizeNode(child));
    }

    // Merge adjacent string children
    const merged: (AriaNode | string)[] = [];
    let buf: string[] = [];
    for (const child of newChildren) {
        if (typeof child === 'string') {
            buf.push(child);
        } else {
            if (buf.length) {
                const text = buf
                    .join('')
                    .replace(/[\s\u00A0]+/g, ' ')
                    .trim();
                if (text) merged.push(text);
                buf = [];
            }
            merged.push(child);
        }
    }
    if (buf.length) {
        const text = buf
            .join('')
            .replace(/[\s\u00A0]+/g, ' ')
            .trim();
        if (text) merged.push(text);
    }
    node.children = merged;

    // Remove text children that duplicate the name
    if (node.name) {
        node.children = node.children.filter((c) => !(typeof c === 'string' && c === node.name));
    }

    // Unwrap generic wrappers: no name, no ref, no props
    if (node.role === 'generic' && !node.name && !node.ref && Object.keys(node.props).length === 0) {
        return node.children;
    }

    return [node];
}

function indent(d: number): string {
    return '  '.repeat(d);
}

function yamlNeedsQuotes(str: string): boolean {
    if (!str.length) return true;
    if (/^\s|\s$/.test(str)) return true;
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(str)) return true;
    if (/^-/.test(str)) return true;
    if (/[\n:]( |$)/.test(str)) return true;
    if (/\s#/.test(str)) return true;
    if (/[\n\r]/.test(str)) return true;
    if (/^[&*\\],?!>|@"'#%]/.test(str)) return true;
    if (/[{`]/.test(str)) return true;
    if (/^\[/.test(str)) return true;
    const low = str.toLowerCase();
    if (!isNaN(Number(str)) || ['y', 'n', 'yes', 'no', 'true', 'false', 'on', 'off', ''].includes(low)) return true;
    return false;
}

function yamlEscapeKey(str: string): string {
    return yamlNeedsQuotes(str) ? "'" + str.replace(/'/g, "''") + "'" : str;
}

function yamlEscapeValue(str: string): string {
    return yamlNeedsQuotes(str) ? JSON.stringify(str) : str;
}

function createKey(node: AriaNode): string {
    let key = node.role;
    if (node.name) key += ' ' + JSON.stringify(node.name);
    if (node.checked) key += ' [checked]';
    if (node.disabled) key += ' [disabled]';
    if (node.selected) key += ' [selected]';
    if (node.ref) {
        key += ` [ref=${node.ref}`;
        if (node.center) key += ` x=${node.center.x} y=${node.center.y}`;
        if (node.width && node.height) key += ` ${node.width}x${node.height}`;
        key += ']';
    }
    return key;
}

function getSingleTextChild(node: AriaNode): string | undefined {
    if (node.children.length === 1 && typeof node.children[0] === 'string' && Object.keys(node.props).length === 0)
        return node.children[0] as string;
    return undefined;
}

function renderYamlNodes(nodes: (AriaNode | string)[], depth = 0): string {
    const lines: string[] = [];

    for (const node of nodes) {
        if (typeof node === 'string') {
            const escaped = yamlEscapeValue(node);
            if (escaped) lines.push(indent(depth) + '- text: ' + escaped);
            continue;
        }

        const key = createKey(node);
        const singleText = getSingleTextChild(node);
        const hasNoChildren = !singleText && node.children.length === 0;
        const propsCount = Object.keys(node.props).length;

        if (hasNoChildren && propsCount === 0) {
            lines.push(indent(depth) + '- ' + yamlEscapeKey(key));
        } else if (singleText !== undefined) {
            lines.push(indent(depth) + '- ' + yamlEscapeKey(key) + ': ' + yamlEscapeValue(singleText));
        } else {
            lines.push(indent(depth) + '- ' + yamlEscapeKey(key) + ':');
            for (const [pk, pv] of Object.entries(node.props)) {
                lines.push(indent(depth + 1) + '- /' + pk + ': ' + yamlEscapeValue(pv));
            }
            const childYaml = renderYamlNodes(node.children, depth + 1);
            if (childYaml) lines.push(childYaml);
        }
    }

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Layout loading & snapshot helpers
// ---------------------------------------------------------------------------

async function dumpLayout(bundleName?: string): Promise<LayoutNode> {
    const args = bundleName ? ['shell', 'uitest', 'dumpLayout', '-b', bundleName] : ['shell', 'uitest', 'dumpLayout'];
    const dumpOutput = await runHdc(args, 20000);
    const match = dumpOutput.match(/saved to:(\S+)/);
    if (!match) throw new Error('Failed to get layout file path from hdc');

    const devicePath = match[1].trim();
    const localDir = mkdtempSync(join(tmpdir(), 'opendesk-hdc-layout-'));
    const localPath = join(localDir, 'layout.json');
    try {
        await runHdc(['file', 'recv', devicePath, localPath], 10000);
        return JSON.parse(readFileSync(localPath, 'utf-8'));
    } finally {
        rmSync(localDir, { recursive: true, force: true });
    }
}

const SNAPSHOT_TTL_MS = 5 * 60 * 1000;
let snapshotSequence = 0;
const snapshotCaptures = new Map<
    string,
    {
        createdAt: number;
        snapshot: string;
        fingerprint: string;
        targets: Map<string, SnapshotTarget>;
        bundleName?: string;
    }
>();

function getCurrentSnapshot(): { snapshot: string; targets: Map<string, SnapshotTarget> } | undefined {
    let current: { snapshot: string; targets: Map<string, SnapshotTarget> } | undefined;
    let latestTime = 0;
    for (const capture of snapshotCaptures.values()) {
        if (capture.createdAt > latestTime) {
            latestTime = capture.createdAt;
            current = capture;
        }
    }
    return current;
}

function pruneSnapshotCaptures(): void {
    const expiresAt = Date.now() - SNAPSHOT_TTL_MS;
    for (const [snapshotId, capture] of snapshotCaptures) {
        if (capture.createdAt < expiresAt) snapshotCaptures.delete(snapshotId);
    }
}

function createSnapshotFingerprint(snapshot: string): string {
    const normalized = snapshot
        .replace(/\[ref=e\d+/g, '[ref')
        .replace(/\s+x=\d+\s+y=\d+/g, '')
        .trim();
    return createHash('sha256').update(normalized).digest('hex');
}

function buildSnapshot(layout: LayoutNode, bundleFilter?: string): BuiltSnapshot {
    const ctx = { refIdx: 0, targets: new Map<string, SnapshotTarget>(), bundleName: bundleFilter };
    const ariaNodes: (AriaNode | string)[] = [];

    if (bundleFilter) {
        // Recursively find nodes with matching bundleName (may be nested inside WindowScene)
        const windows = findNodesByBundle(layout, bundleFilter);
        for (const win of windows) {
            const converted = convertNode(win, ctx);
            if (converted && typeof converted === 'object') {
                ariaNodes.push(...normalizeNode(converted as AriaNode));
            }
        }
    } else {
        // No filter: convert all direct children, skipping system UI (desktop/dock/statusbar)
        for (const win of layout.children || []) {
            const winBundle = win.attributes?.bundleName;
            if (winBundle === SCENEBOARD_BUNDLE) continue;
            const converted = convertNode(win, ctx);
            if (converted && typeof converted === 'object') {
                ariaNodes.push(...normalizeNode(converted as AriaNode));
            }
        }
    }

    const snapshot = renderYamlNodes(ariaNodes);
    return {
        snapshot,
        fingerprint: createSnapshotFingerprint(snapshot),
        targets: ctx.targets,
        bundleName: bundleFilter
    };
}

function registerSnapshot(built: BuiltSnapshot): SnapshotCapture {
    const snapshotId = `s${++snapshotSequence}`;
    // Refs describe a point-in-time layout. Only snapshots returned to the
    // caller are registered, so internal polling cannot invalidate live refs.
    snapshotCaptures.clear();
    snapshotCaptures.set(snapshotId, {
        createdAt: Date.now(),
        snapshot: built.snapshot,
        fingerprint: built.fingerprint,
        targets: built.targets,
        bundleName: built.bundleName
    });
    return {
        snapshot: built.snapshot,
        snapshotId,
        fingerprint: built.fingerprint,
        bundleName: built.bundleName
    };
}

function convertLayout(layout: LayoutNode, bundleFilter?: string): SnapshotCapture {
    return registerSnapshot(buildSnapshot(layout, bundleFilter));
}

async function takeSnapshot(bundleName?: string): Promise<SnapshotCapture> {
    const layout = await dumpLayout(bundleName);
    return convertLayout(layout, bundleName);
}

/**
 * After an operation, optionally capture a snapshot and merge it into the result.
 * Waits 500ms for UI to settle, then fetches the aria tree.
 * Snapshot failure does not affect the original operation result.
 */
async function withSnapshot(
    doSnapshot: boolean,
    result: Record<string, unknown>,
    bundleName?: string
): Promise<Record<string, unknown>> {
    if (!doSnapshot) return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
        const capture = await takeSnapshot(bundleName);
        if (!capture.snapshot.trim()) {
            return {
                ...result,
                snapshotError: 'Snapshot was requested but returned no visible content'
            };
        }
        return { ...result, snapshot: capture.snapshot, snapshotId: capture.snapshotId };
    } catch (err) {
        return { ...result, snapshotError: `Failed to capture snapshot: ${String(err)}` };
    }
}

function findNodesByBundle(node: LayoutNode, bundleName: string): LayoutNode[] {
    const results: LayoutNode[] = [];
    const attrs = node.attributes || {};
    if (attrs.bundleName === bundleName) {
        results.push(node);
        return results;
    }
    for (const child of node.children || []) {
        results.push(...findNodesByBundle(child, bundleName));
    }
    return results;
}

function findAllWindows(
    node: LayoutNode,
    seen = new Set<string>()
): { bundleName: string; abilityName: string; bounds: string }[] {
    const results: { bundleName: string; abilityName: string; bounds: string }[] = [];
    const attrs = node.attributes || {};
    if (attrs.bundleName || attrs.abilityName) {
        const window = {
            bundleName: attrs.bundleName || '',
            abilityName: attrs.abilityName || '',
            bounds: attrs.origBounds || attrs.bounds || ''
        };
        const key = `${window.bundleName}\0${window.abilityName}\0${window.bounds}`;
        if (!seen.has(key)) {
            seen.add(key);
            results.push(window);
        }
    }
    for (const child of node.children || []) {
        results.push(...findAllWindows(child, seen));
    }
    return results;
}

// ---------------------------------------------------------------------------
// Permission dialog detection
// ---------------------------------------------------------------------------

const PERMISSION_DIALOG_PATTERN =
    /(?:权限|授予|想要访问|请求访问|允许.{0,16}(?:访问|使用)|通知|发送通知|permission|would like to|wants to access|request(?:ing)? access|allow.{0,16}(?:access|use)|notification)/i;

const PERMISSION_ACTION_PATTERNS: Record<PermissionActionTarget['action'], RegExp> = {
    allow: /^(?:允许|允许使用|始终允许|使用期间允许|仅在使用期间允许|允许通知|Allow|Allow while using|Allow only while using|Always allow)$/i,
    allowOnce: /^(?:仅此一次|本次允许|仅这一次|Only this time|Allow once)$/i,
    deny: /^(?:拒绝|不允许|Deny|Don'?t allow)$/i
};

function getNodeText(node: LayoutNode): string {
    const attrs = node.attributes || {};
    return [attrs.text, attrs.hint, attrs.description, attrs.originalText].filter(Boolean).join(' ');
}

function collectNodeText(node: LayoutNode): string {
    return [getNodeText(node), ...(node.children || []).map(collectNodeText)].filter(Boolean).join(' ');
}

function findPermissionAction(label: string): PermissionActionTarget['action'] | undefined {
    return (Object.keys(PERMISSION_ACTION_PATTERNS) as PermissionActionTarget['action'][]).find((action) =>
        PERMISSION_ACTION_PATTERNS[action].test(label.trim())
    );
}

function collectPermissionActions(node: LayoutNode, actions: PermissionActionTarget[]): void {
    const attrs = node.attributes || {};
    const label = getName(attrs).trim();
    const action = attrs.clickable === 'true' ? findPermissionAction(label) : undefined;
    const bounds = parseBounds(attrs.bounds);
    if (action && bounds) {
        actions.push({
            action,
            label,
            target: { bounds, bundleName: attrs.bundleName }
        });
    }
    for (const child of node.children || []) collectPermissionActions(child, actions);
}

function findPermissionDialog(node: LayoutNode): PermissionDialog | undefined {
    const attrs = node.attributes || {};
    const message = collectNodeText(node).replace(/\s+/g, ' ').trim();
    const actions: PermissionActionTarget[] = [];
    collectPermissionActions(node, actions);
    const isDialog =
        /^dialog$/i.test(attrs.type || '') ||
        (attrs.bundleName || '').includes('permission') ||
        (attrs.bundleName || '').includes('notificationdialog') ||
        (attrs.bundleName || '').includes('privacycenter');

    if (isDialog && PERMISSION_DIALOG_PATTERN.test(message) && actions.length > 0) {
        return { title: getNodeText(node).trim(), message, actions };
    }

    for (const child of node.children || []) {
        const dialog = findPermissionDialog(child);
        if (dialog) return dialog;
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

// ========== listApps ==========

const ListAppsArgsSchema = z.object({});

export class ListAppsTool extends BaseTool<typeof ListAppsArgsSchema> {
    constructor() {
        super(
            'listApps',
            '获取设备上所有可从桌面/开始菜单打开的应用列表，返回每个应用的 bundleName 和显示名称。结果会按设备 ID 缓存在内存中，同一设备不会重复查询',
            ListAppsArgsSchema
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(): Promise<string> {
        try {
            const deviceId = await getDeviceId();
            const cached = listAppsCache.get(deviceId);
            if (cached) {
                return ok({ apps: cached, count: cached.length, cached: true });
            }

            // Parallel batch script: 10 concurrent bm dump calls to reduce total time
            const script = [
                '#!/bin/sh',
                'count=0',
                'bm dump -a 2>/dev/null | grep \\. | while IFS= read -r pkg; do',
                "  pkg=$(echo $pkg | tr -d ' \\t\\r')",
                '  count=$((count + 1))',
                '  (',
                '    info=$(bm dump -n $pkg 2>/dev/null)',
                '    hidden=$(echo "$info" | grep \'hideDesktopIcon\' | head -1)',
                '    case "$hidden" in',
                '      *false*) name=$(bm dump -n $pkg -l 2>/dev/null); echo "$pkg|$name" ;;',
                '    esac',
                '  ) &',
                '  if [ $((count % 10)) -eq 0 ]; then wait; fi',
                'done',
                'wait'
            ].join('\n');

            const localDir = mkdtempSync(join(tmpdir(), 'opendesk-hdc-listapps-'));
            const localScript = join(localDir, 'listapps.sh');
            let output: string;
            try {
                writeFileSync(localScript, script);
                await runHdc(['file', 'send', localScript, '/data/local/tmp/hdc_listapps.sh'], 10000);
                output = await runHdc(['shell', 'sh', '/data/local/tmp/hdc_listapps.sh'], 120000);
            } finally {
                rmSync(localDir, { recursive: true, force: true });
            }

            const apps: { bundleName: string; label: string }[] = [];
            for (const line of output.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.includes('|')) continue;
                const idx = trimmed.indexOf('|');
                const bundleName = trimmed.slice(0, idx).trim();
                const label = trimmed.slice(idx + 1).trim();
                if (bundleName && bundleName.includes('.')) {
                    apps.push({ bundleName, label });
                }
            }

            listAppsCache.set(deviceId, apps);
            return ok({ apps, count: apps.length });
        } catch (err) {
            return fail(`Failed to list apps: ${err}`);
        }
    }
}

// ========== openApp ==========

const BundleNameSchema = z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/)
    .describe('应用的 bundleName，例如 com.develop.opensource.ohpcd.opendesk');

async function resolveEntryAbility(bundleName: string): Promise<string> {
    const dumpOutput = await runHdc(['shell', 'bm', 'dump', '-n', bundleName], 15000);
    const abilityMatches = [...dumpOutput.matchAll(/"name":\s*"(\w+Ability)"/g)];
    return abilityMatches.find((match) => match[1] === 'EntryAbility')?.[1] || abilityMatches[0]?.[1] || 'EntryAbility';
}

async function startApp(bundleName: string): Promise<string> {
    const abilityName = await resolveEntryAbility(bundleName);
    await runHdc(['shell', 'aa', 'start', '-a', abilityName, '-b', bundleName], 10000);
    return abilityName;
}

const OpenAppArgsSchema = z.object({
    bundleName: BundleNameSchema
});

export class OpenAppTool extends BaseTool<typeof OpenAppArgsSchema> {
    constructor() {
        super('openApp', '通过 bundleName 打开指定应用。会自动查找应用的入口 Ability 并启动', OpenAppArgsSchema);
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof OpenAppArgsSchema>): Promise<string> {
        try {
            const abilityName = await startApp(args.bundleName);
            return ok({ bundleName: args.bundleName, abilityName });
        } catch (err) {
            return fail(`Failed to open app ${args.bundleName}: ${err}`);
        }
    }
}

// ========== appLifecycle ==========

const AppLifecycleArgsSchema = z.object({
    bundleName: BundleNameSchema,
    action: z
        .enum(['stop', 'restart', 'clearCache', 'clearData'])
        .describe('生命周期操作：停止、重启、清除缓存或清除全部应用数据'),
    confirmDestructive: z
        .boolean()
        .default(false)
        .describe('clearData 必须显式设为 true；该操作会永久删除应用本地数据、账号和配置'),
    relaunch: z.boolean().default(true).describe('clearCache/clearData 完成后是否重新启动应用，默认 true'),
    settleTime: z
        .number()
        .int()
        .min(0)
        .max(30000)
        .default(1000)
        .describe('操作完成后等待应用稳定的时间，单位毫秒，默认 1000'),
    snapshot: z.boolean().default(false).describe('应用重新启动后是否获取该应用的新快照，默认 false')
});

export class AppLifecycleTool extends BaseTool<typeof AppLifecycleArgsSchema> {
    constructor() {
        super(
            'appLifecycle',
            '控制应用测试生命周期：强制停止、冷重启、清除缓存或清除全部应用数据。' +
                'clearData 会删除应用本地数据，必须通过 confirmDestructive=true 显式确认。',
            AppLifecycleArgsSchema
        );
        this.serialExecution = true;
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof AppLifecycleArgsSchema>): Promise<string> {
        if (args.action === 'clearData' && !args.confirmDestructive) {
            return fail('clearData 会永久删除应用本地数据、账号和配置；请在确认目标后设置 confirmDestructive=true。');
        }

        try {
            await runHdc(['shell', 'aa', 'force-stop', args.bundleName], 10000);
            snapshotCaptures.clear();

            const result: Record<string, unknown> = {
                bundleName: args.bundleName,
                action: args.action,
                stopped: true
            };

            if (args.action === 'clearCache') {
                await runHdc(['shell', 'bm', 'clean', '-n', args.bundleName, '-c'], 30000);
                result.cacheCleared = true;
            } else if (args.action === 'clearData') {
                await runHdc(['shell', 'bm', 'clean', '-n', args.bundleName, '-d'], 30000);
                result.dataCleared = true;
            }

            const shouldStart =
                args.action === 'restart' ||
                ((args.action === 'clearCache' || args.action === 'clearData') && args.relaunch);
            if (shouldStart) {
                result.abilityName = await startApp(args.bundleName);
                result.started = true;
            } else if (args.action === 'clearCache' || args.action === 'clearData') {
                result.started = false;
            }

            if (args.settleTime > 0) {
                await new Promise((resolve) => setTimeout(resolve, args.settleTime));
            }

            if (args.snapshot && !shouldStart) {
                result.snapshotError = '应用当前处于停止状态，无法获取目标应用快照';
                return ok(result);
            }
            return ok(await withSnapshot(args.snapshot, result, shouldStart ? args.bundleName : undefined));
        } catch (err) {
            return fail(`应用生命周期操作失败（${args.action} ${args.bundleName}）：${err}`);
        }
    }
}

// ========== listWindows ==========

const ListWindowsArgsSchema = z.object({});

export class ListWindowsTool extends BaseTool<typeof ListWindowsArgsSchema> {
    constructor() {
        super(
            'listWindows',
            '获取设备当前所有窗口列表，返回每个窗口的 bundleName、abilityName 和边界范围',
            ListWindowsArgsSchema
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(): Promise<string> {
        try {
            const layout = await dumpLayout();
            const windows = findAllWindows(layout);
            return ok({ windows, count: windows.length });
        } catch (err) {
            return fail(`Failed to list windows: ${err}`);
        }
    }
}

// ========== snapshot ==========

const SnapshotArgsSchema = z.object({
    bundleName: BundleNameSchema.optional().describe('只获取指定 bundleName 对应窗口的快照。不指定则获取所有窗口')
});

export class SnapshotTool extends BaseTool<typeof SnapshotArgsSchema> {
    constructor() {
        super(
            'snapshot',
            '获取设备当前界面的无障碍快照（aria tree），格式与 OpenDesk 浏览器快照兼容。' +
                '可交互元素会带有 [ref=eN x=<cx> y=<cy>] 标签；每次快照都会刷新 ref，结果中的 snapshotId 可与 ref 一起用于 clickRef',
            SnapshotArgsSchema
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof SnapshotArgsSchema>): Promise<string> {
        try {
            const capture = await takeSnapshot(args.bundleName);

            if (!capture.snapshot.trim()) {
                return fail(
                    'No visible windows found. The device may be locked or the specified bundleName has no visible window.'
                );
            }

            return ok({ snapshot: capture.snapshot, snapshotId: capture.snapshotId });
        } catch (err) {
            return fail(`Failed to capture snapshot: ${err}`);
        }
    }
}

// ========== clickRef ==========

const ClickRefArgsSchema = z.object({
    snapshotId: z.string().min(1).describe('最近一次 snapshot 返回的 snapshotId；下一次成功快照后会失效'),
    ref: z
        .string()
        .regex(/^e\d+$/)
        .describe('目标元素在该快照中的 ref，例如 e3'),
    position: z
        .enum(['center', 'left-center', 'right-center'])
        .default('center')
        .describe('点击位置。发送按钮与右侧选项按钮相邻时使用 left-center'),
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取相同应用的界面快照，默认 false')
});

function pointForTarget(target: SnapshotTarget, position: z.output<typeof ClickRefArgsSchema>['position']) {
    const { x1, y1, x2, y2 } = target.bounds;
    const width = x2 - x1;
    const y = Math.round((y1 + y2) / 2);
    if (position === 'left-center') return { x: x1 + Math.max(1, Math.round(width * 0.3)), y };
    if (position === 'right-center') return { x: x2 - Math.max(1, Math.round(width * 0.3)), y };
    return { x: Math.round((x1 + x2) / 2), y };
}

export class ClickRefTool extends BaseTool<typeof ClickRefArgsSchema> {
    constructor() {
        super(
            'clickRef',
            '按最近一次 snapshot 返回的元素 ref 点击。每次成功快照都会刷新 ref，并使旧 ref 失效；发送按钮应使用 position="left-center"。',
            ClickRefArgsSchema
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof ClickRefArgsSchema>): Promise<string> {
        pruneSnapshotCaptures();
        const capture = snapshotCaptures.get(args.snapshotId);
        const target = capture?.targets.get(args.ref);
        if (!target) {
            return fail(`快照引用不存在或已失效：${args.snapshotId}/${args.ref}。请重新获取快照后再点击。`);
        }

        const point = pointForTarget(target, args.position);
        try {
            await runHdc(['shell', 'uitest', 'uiInput', 'click', String(point.x), String(point.y)], 10000);
            const result = await withSnapshot(
                args.snapshot,
                {
                    snapshotId: args.snapshotId,
                    ref: args.ref,
                    position: args.position,
                    x: point.x,
                    y: point.y
                },
                target.bundleName
            );
            return ok(result);
        } catch (err) {
            return fail(`Failed to click ${args.snapshotId}/${args.ref}: ${err}`);
        }
    }
}

const SelectOptionArgsSchema = z.object({
    trigger: z
        .object({
            role: z.string().optional().describe('下拉框触发器角色，如 combobox、button 或 generic'),
            name: z.string().min(1).describe('下拉框触发器名称，大小写不敏感的模糊匹配')
        })
        .describe('用于展开下拉框的触发器定位条件'),
    option: z.string().min(1).describe('要选择的选项文本'),
    bundleName: BundleNameSchema.optional().describe('目标应用 bundleName；不指定时使用全部可见窗口'),
    match: z.enum(['exact', 'contains']).default('exact').describe('选项文本匹配方式，默认 exact'),
    verify: z.boolean().default(true).describe('点击后是否验证选项已生效，默认 true'),
    maxAttempts: z.number().int().min(1).max(3).default(2).describe('找不到选项时的最大重试次数，默认 2')
});

function normalizeUiText(value: string): string {
    return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function optionTextMatches(value: string, option: string, match: 'exact' | 'contains'): boolean {
    const normalizedValue = normalizeUiText(value);
    const normalizedOption = normalizeUiText(option);
    return match === 'exact' ? normalizedValue === normalizedOption : normalizedValue.includes(normalizedOption);
}

function chooseOptionMatch(matches: ElementMatch[], option: string, match: 'exact' | 'contains'): ElementMatch | null {
    const exact = matches.find((item) => optionTextMatches(item.name, option, 'exact'));
    if (exact) return exact;
    if (match === 'contains') return matches.find((item) => optionTextMatches(item.name, option, 'contains')) ?? null;
    return null;
}

function isSameTargetArea(a: ElementMatch, b: ElementMatch): boolean {
    const aWidth = a.bounds.x2 - a.bounds.x1;
    const aHeight = a.bounds.y2 - a.bounds.y1;
    const bWidth = b.bounds.x2 - b.bounds.x1;
    const bHeight = b.bounds.y2 - b.bounds.y1;
    return (
        Math.abs(a.center.x - b.center.x) <= Math.max(8, Math.round(Math.max(aWidth, bWidth) * 0.25)) &&
        Math.abs(a.center.y - b.center.y) <= Math.max(8, Math.round(Math.max(aHeight, bHeight) * 0.25))
    );
}

function findSelectedOptionInSnapshot(trigger: ElementMatch, option: string, match: 'exact' | 'contains'): boolean {
    const current = getCurrentSnapshot();
    if (!current) return false;
    const elements = findElementsInSnapshot(undefined, undefined, undefined, undefined, undefined, undefined);
    if (elements.some((item) => item.selected && optionTextMatches(item.name, option, match))) return true;
    const refs = findRefsByTextContent(current.snapshot, option);
    return elements.some(
        (item) => isSameTargetArea(item, trigger) && (optionTextMatches(item.name, option, match) || refs.has(item.ref))
    );
}

interface OcrOptionMatch {
    x: number;
    y: number;
    text: string;
    confidence: number;
}

function chooseOcrOptionMatch(
    results: OcrResult[],
    option: string,
    match: 'exact' | 'contains'
): OcrOptionMatch | null {
    const words = results
        .filter((item) => item.confidence > 10 && !item.text.startsWith('(OCR failed:'))
        .sort((a, b) => a.y - b.y || a.x - b.x);
    const lines: OcrResult[][] = [];
    for (const word of words) {
        const previous = lines.at(-1);
        const previousHeight = previous?.reduce((max, item) => Math.max(max, item.height), 0) ?? 0;
        if (!previous || Math.abs(word.y - previous[0].y) > Math.max(8, previousHeight)) lines.push([word]);
        else previous.push(word);
    }
    const candidates = lines.map((line) => {
        const sorted = line.sort((a, b) => a.x - b.x);
        const x1 = Math.min(...sorted.map((item) => item.x));
        const y1 = Math.min(...sorted.map((item) => item.y));
        const x2 = Math.max(...sorted.map((item) => item.x + item.width));
        const y2 = Math.max(...sorted.map((item) => item.y + item.height));
        return {
            x: Math.round((x1 + x2) / 2),
            y: Math.round((y1 + y2) / 2),
            text: sorted.map((item) => item.text).join(' '),
            confidence: Math.round(sorted.reduce((sum, item) => sum + item.confidence, 0) / sorted.length)
        };
    });
    return candidates.find((item) => optionTextMatches(item.text, option, match)) ?? null;
}

async function chooseOptionWithOcr(trigger: ElementMatch, option: string, match: 'exact' | 'contains') {
    const screenshotPath = await captureScreenshot();
    const screenshotDir = dirname(screenshotPath);
    try {
        const sharp = await loadSharp();
        if (!sharp) return null;
        const metadata = await sharp(screenshotPath).metadata();
        if (!metadata.width || !metadata.height) return null;
        const triggerWidth = trigger.bounds.x2 - trigger.bounds.x1;
        const region = {
            x1: Math.max(0, trigger.bounds.x1 - Math.max(120, triggerWidth)),
            y1: 0,
            x2: Math.min(metadata.width, trigger.bounds.x2 + Math.max(240, triggerWidth)),
            y2: metadata.height
        };
        return chooseOcrOptionMatch(await performOcr(screenshotPath, region), option, match);
    } finally {
        rmSync(screenshotDir, { recursive: true, force: true });
    }
}

export class SelectOptionTool extends BaseTool<typeof SelectOptionArgsSchema> {
    constructor() {
        super(
            'selectOption',
            '稳定操作下拉框：重新获取快照，展开触发器，优先按无障碍文本选择选项，必要时用局部 OCR 兜底，并验证选择结果。',
            SelectOptionArgsSchema
        );
        this.serialExecution = true;
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof SelectOptionArgsSchema>): Promise<string> {
        let lastReason = '未找到下拉选项';
        try {
            for (let attempt = 1; attempt <= args.maxAttempts; attempt++) {
                const before = await takeSnapshot(args.bundleName);
                const triggers = findElementsInSnapshot(args.trigger.role, args.trigger.name);
                const trigger = triggers[0];
                if (!trigger) {
                    lastReason = `未找到下拉触发器：${args.trigger.name}`;
                    continue;
                }

                await runHdc(
                    ['shell', 'uitest', 'uiInput', 'click', String(trigger.center.x), String(trigger.center.y)],
                    10000
                );
                await new Promise((resolve) => setTimeout(resolve, 350));
                const opened = await takeSnapshot();
                const option = chooseOptionMatch(
                    findElementsInSnapshot(undefined, undefined, undefined, undefined, undefined),
                    args.option,
                    args.match
                );
                let strategy: 'accessibility' | 'ocr' = 'accessibility';
                let clickPoint: { x: number; y: number } | null = option?.center ?? null;
                if (!clickPoint) {
                    const ocrMatch = await chooseOptionWithOcr(trigger, args.option, args.match);
                    if (ocrMatch) {
                        strategy = 'ocr';
                        clickPoint = { x: ocrMatch.x, y: ocrMatch.y };
                    }
                }
                if (!clickPoint) {
                    lastReason = `下拉框已展开，但未找到选项：${args.option}`;
                    if (attempt < args.maxAttempts) {
                        await runHdc(['shell', 'uitest', 'uiInput', 'keyEvent', String(KEY_MAP.Escape)], 5000).catch(
                            () => {}
                        );
                    }
                    continue;
                }

                await runHdc(
                    ['shell', 'uitest', 'uiInput', 'click', String(clickPoint.x), String(clickPoint.y)],
                    10000
                );
                await new Promise((resolve) => setTimeout(resolve, 350));
                const after = await takeSnapshot(args.bundleName);
                const verified = !args.verify || findSelectedOptionInSnapshot(trigger, args.option, args.match);
                if (!verified) {
                    lastReason = `已点击选项“${args.option}”，但无法验证选择结果`;
                    continue;
                }
                return ok({
                    selected: true,
                    verified,
                    option: args.option,
                    strategy,
                    attempts: attempt,
                    trigger: args.trigger,
                    snapshot: after.snapshot,
                    snapshotId: after.snapshotId,
                    openedSnapshotId: opened.snapshotId,
                    initialSnapshotId: before.snapshotId
                });
            }
            return fail(lastReason);
        } catch (err) {
            return fail(`下拉选项操作失败：${err}`);
        }
    }
}

// ========== handlePermission ==========

const HandlePermissionArgsSchema = z.object({
    action: z
        .enum(['inspect', 'allow', 'allowOnce', 'deny'])
        .describe('必须明确指定权限处理方式：inspect 仅查看，allow 允许，allowOnce 仅本次允许，deny 拒绝'),
    snapshot: z.boolean().default(true).describe('完成点击后是否获取新快照，默认 true')
});

export class HandlePermissionTool extends BaseTool<typeof HandlePermissionArgsSchema> {
    constructor() {
        super(
            'handlePermission',
            '检测当前系统权限确认框，并按明确指定的方式处理。不会自动授予权限；仅识别带标准“允许/仅此一次/拒绝”按钮的权限对话框。',
            HandlePermissionArgsSchema
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof HandlePermissionArgsSchema>): Promise<string> {
        try {
            const layout = await dumpLayout();
            const capture = convertLayout(layout);
            const dialog = findPermissionDialog(layout);
            if (!dialog) {
                return fail('当前界面未检测到可安全处理的系统权限确认框。');
            }

            const availableActions = dialog.actions.map(({ action, label }) => ({ action, label }));
            if (args.action === 'inspect') {
                return ok({
                    detected: true,
                    title: dialog.title,
                    message: dialog.message,
                    actions: availableActions,
                    snapshot: capture.snapshot,
                    snapshotId: capture.snapshotId
                });
            }

            const selected = dialog.actions.find((item) => item.action === args.action);
            if (!selected) {
                return fail(
                    `权限确认框不提供请求的操作：${args.action}。可用操作：${availableActions.map((item) => item.action).join(', ')}`
                );
            }

            const point = pointForTarget(selected.target, 'center');
            await runHdc(['shell', 'uitest', 'uiInput', 'click', String(point.x), String(point.y)], 10000);
            const result = await withSnapshot(args.snapshot, {
                detected: true,
                action: selected.action,
                label: selected.label,
                x: point.x,
                y: point.y
            });
            return ok(result);
        } catch (err) {
            return fail(`处理权限确认框失败：${err}`);
        }
    }
}

// ========== click ==========

const ClickArgsSchema = z.object({
    x: z.number().int().describe('点击的 X 坐标'),
    y: z.number().int().describe('点击的 Y 坐标'),
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取界面快照，默认 false')
});

export class ClickTool extends BaseTool<typeof ClickArgsSchema> {
    constructor() {
        super(
            'click',
            '在设备屏幕的指定坐标处执行点击操作。若按钮旁边有下拉箭头/选项按钮，建议点击按钮左侧区域',
            ClickArgsSchema
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof ClickArgsSchema>): Promise<string> {
        try {
            await runHdc(['shell', 'uitest', 'uiInput', 'click', String(args.x), String(args.y)], 10000);
            const result = await withSnapshot(args.snapshot, { x: args.x, y: args.y });
            return ok(result);
        } catch (err) {
            return fail(`Failed to click (${args.x}, ${args.y}): ${err}`);
        }
    }
}

// ========== pointer gestures ==========

async function runPointerGesture(
    gesture: 'doubleClick' | 'drag' | 'longClick',
    command: string,
    commandArgs: string[],
    snapshot: boolean,
    result: Record<string, unknown>
): Promise<string> {
    try {
        await runHdc(['shell', 'uitest', 'uiInput', command, ...commandArgs], 10000);
        return ok(await withSnapshot(snapshot, { gesture, native: true, ...result }));
    } catch (err) {
        return fail(`设备不支持原生 ${gesture} 手势，或 uiInput 命令执行失败：${err}`);
    }
}

const DoubleClickArgsSchema = z.object({
    x: z.number().int().describe('双击位置的 X 坐标'),
    y: z.number().int().describe('双击位置的 Y 坐标'),
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取界面快照，默认 false')
});

export class DoubleClickTool extends BaseTool<typeof DoubleClickArgsSchema> {
    constructor() {
        super(
            'doubleClick',
            '在指定坐标执行原生双击。不支持该手势的设备会明确返回失败，不会降级为两次普通点击。',
            DoubleClickArgsSchema
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof DoubleClickArgsSchema>): Promise<string> {
        return runPointerGesture('doubleClick', 'doubleClick', [String(args.x), String(args.y)], args.snapshot, {
            x: args.x,
            y: args.y
        });
    }
}

const DragArgsSchema = z.object({
    fromX: z.number().int().describe('拖动起点的 X 坐标'),
    fromY: z.number().int().describe('拖动起点的 Y 坐标'),
    toX: z.number().int().describe('拖动终点的 X 坐标'),
    toY: z.number().int().describe('拖动终点的 Y 坐标'),
    speed: z.number().int().min(200).max(40000).default(600).describe('拖动速度，单位为像素/秒，默认 600'),
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取界面快照，默认 false')
});

export class DragTool extends BaseTool<typeof DragArgsSchema> {
    constructor() {
        super(
            'drag',
            '从起点连续拖动到终点，使用原生按下、移动、抬起手势；不会以两次点击或 fling 降级。',
            DragArgsSchema
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof DragArgsSchema>): Promise<string> {
        return runPointerGesture(
            'drag',
            'drag',
            [String(args.fromX), String(args.fromY), String(args.toX), String(args.toY), String(args.speed)],
            args.snapshot,
            { fromX: args.fromX, fromY: args.fromY, toX: args.toX, toY: args.toY, speed: args.speed }
        );
    }
}

const LongClickArgsSchema = z.object({
    x: z.number().int().describe('长按位置的 X 坐标'),
    y: z.number().int().describe('长按位置的 Y 坐标'),
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取界面快照，默认 false')
});

export class LongClickTool extends BaseTool<typeof LongClickArgsSchema> {
    constructor() {
        super(
            'longClick',
            '在指定坐标执行原生长按。部分 HarmonyOS WebView 可能将长按转换为 contextmenu；' +
                '此工具只保证发送 longClick，不声称等价于鼠标右键。',
            LongClickArgsSchema
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof LongClickArgsSchema>): Promise<string> {
        return runPointerGesture('longClick', 'longClick', [String(args.x), String(args.y)], args.snapshot, {
            x: args.x,
            y: args.y
        });
    }
}

// ========== scroll ==========

type ScrollDirection = 'up' | 'down' | 'left' | 'right';

interface ScrollRegion {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface ScrollGestureResult {
    method: 'drag' | 'dircFling';
    region?: ScrollRegion;
    distance?: number;
}

async function performScrollGesture(
    direction: ScrollDirection,
    region?: ScrollRegion,
    distance?: number
): Promise<ScrollGestureResult> {
    if (!region) {
        const dirMap: Record<ScrollDirection, number> = { up: 2, down: 3, left: 0, right: 1 };
        await runHdc(['shell', 'uitest', 'uiInput', 'dircFling', String(dirMap[direction])], 10000);
        return { method: 'dircFling' };
    }

    const offset =
        distance ?? Math.round((direction === 'up' || direction === 'down' ? region.height : region.width) * 0.6);
    let fromX = region.x;
    let fromY = region.y;
    let toX = region.x;
    let toY = region.y;

    if (direction === 'up') {
        fromY += Math.round(offset / 2);
        toY -= Math.round(offset / 2);
    } else if (direction === 'down') {
        fromY -= Math.round(offset / 2);
        toY += Math.round(offset / 2);
    } else if (direction === 'left') {
        fromX += Math.round(offset / 2);
        toX -= Math.round(offset / 2);
    } else {
        fromX -= Math.round(offset / 2);
        toX += Math.round(offset / 2);
    }

    await runHdc(
        ['shell', 'uitest', 'uiInput', 'drag', String(fromX), String(fromY), String(toX), String(toY), '600'],
        10000
    );
    return { method: 'drag', region, distance: offset };
}

const ScrollArgsSchema = z.object({
    direction: z
        .enum(['up', 'down', 'left', 'right'])
        .describe(
            '滑动方向。up=向上滑动（查看下方内容），down=向下滑动（查看上方内容），left=向左滑动，right=向右滑动'
        ),
    region: z
        .object({
            x: z.number().int().describe('滑动区域中心 X 坐标'),
            y: z.number().int().describe('滑动区域中心 Y 坐标'),
            width: z.number().int().describe('滑动区域宽度'),
            height: z.number().int().describe('滑动区域高度')
        })
        .optional()
        .describe(
            '在指定区域内滑动。不指定则使用全屏 dircFling（可能只影响当前焦点滚动容器）。' +
                '指定后会在该区域内执行 drag 手势，适用于侧边栏等独立滚动区域'
        ),
    distance: z
        .number()
        .int()
        .min(50)
        .optional()
        .describe(
            '精确滚动距离（像素）。不指定时默认为容器高度/宽度的 60%。' +
                '仅当指定 region 或 scrollByContainer 时生效，dircFling 不支持精确距离'
        ),
    scrollByContainer: z
        .object({
            role: z.string().describe('滚动容器在最新快照中的 role 类型，如 "list"、"generic"、"iframe"'),
            name: z.string().optional().describe('滚动容器的显示名称，与 role 配合定位')
        })
        .optional()
        .describe(
            '根据 role/name 从最新快照中自动定位滚动容器区域。' +
                '无需预先知道容器坐标，工具会自动获取快照并解析容器边界。' +
                '与 region 互斥——同时指定时优先使用 scrollByContainer'
        ),
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取界面快照，默认 false')
});

export class ScrollTool extends BaseTool<typeof ScrollArgsSchema> {
    constructor() {
        super('scroll', '在设备屏幕上执行滑动操作，支持全屏滚动、区域滚动和按元素定位滚动', ScrollArgsSchema);
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof ScrollArgsSchema>): Promise<string> {
        try {
            // Resolve scroll region
            let effectiveRegion: { x: number; y: number; width: number; height: number } | undefined = args.region;

            if (args.scrollByContainer) {
                const resolved = resolveContainerFromSnapshot(args.scrollByContainer.role, args.scrollByContainer.name);
                if (!resolved) {
                    // Auto-take a snapshot to resolve container
                    const capture = await takeSnapshot();
                    if (capture.snapshotId) {
                        const retry = resolveContainerFromSnapshot(
                            args.scrollByContainer.role,
                            args.scrollByContainer.name
                        );
                        if (retry) effectiveRegion = retry;
                    }
                    if (!effectiveRegion) {
                        return fail(
                            `找不到滚动容器：role="${args.scrollByContainer.role}"` +
                                (args.scrollByContainer.name ? `, name="${args.scrollByContainer.name}"` : '') +
                                '。请先执行 snapshot 确认容器元素可见'
                        );
                    }
                } else {
                    effectiveRegion = resolved;
                }
            }

            if (!effectiveRegion && args.distance !== undefined) {
                return fail('distance 参数仅对区域滚动（region 或 scrollByContainer）有效，dircFling 不支持精确距离');
            }

            const gesture = await performScrollGesture(args.direction, effectiveRegion, args.distance);
            return ok(await withSnapshot(args.snapshot, { direction: args.direction, ...gesture }));
        } catch (err) {
            return fail(`Failed to scroll ${args.direction}: ${err}`);
        }
    }
}

// ---------------------------------------------------------------------------
// Container resolution from snapshot
// ---------------------------------------------------------------------------

interface ParsedSnapshotLine {
    role: string;
    name: string;
    ref: string;
    x: number;
    y: number;
    width: number;
    height: number;
    disabled: boolean;
    checked: boolean;
    selected: boolean;
}

function parseSnapshotElements(snapshotText: string): ParsedSnapshotLine[] {
    const results: ParsedSnapshotLine[] = [];
    // Match elements with ref. Name is optional (elements can be `- button [ref=e5 ...]`).
    // State attributes like [checked], [disabled], [selected] may appear before [ref=...].
    // e.g. `- generic "显示隐藏文件" [checked] [ref=e54 x=1976 y=912 25x26]`
    const re =
        /^(\s*)- (\w+)(?:\s+"([^"]*)")?\s*((?:\[(?:checked|disabled|selected)\]\s*)*)\[ref=(e\d+)\s+x=(\d+)\s+y=(\d+)\s+(\d+)x(\d+)\]([^\n]*)$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(snapshotText)) !== null) {
        const prefix = m[4] || '';
        const suffix = m[10] || '';
        const combined = prefix + suffix;
        results.push({
            role: m[2],
            name: m[3] || '',
            ref: m[5],
            x: parseInt(m[6], 10),
            y: parseInt(m[7], 10),
            width: parseInt(m[8], 10),
            height: parseInt(m[9], 10),
            disabled: combined.includes('[disabled]'),
            checked: combined.includes('[checked]'),
            selected: combined.includes('[selected]')
        });
    }
    return results;
}

function resolveContainerFromSnapshot(
    role: string,
    name?: string
): { x: number; y: number; width: number; height: number } | null {
    const currentSnapshot = getCurrentSnapshot();
    if (!currentSnapshot) return null;

    // Parse snapshot text to find matching container
    const elements = parseSnapshotElements(currentSnapshot.snapshot);
    for (const el of elements) {
        if (el.role !== role) continue;
        if (name !== undefined && !el.name.includes(name)) continue;

        // Use the parsed bounds directly (already in device coordinates)
        return {
            x: el.x,
            y: el.y,
            width: el.width,
            height: el.height
        };
    }
    return null;
}

/**
 * Matched element from a snapshot search.
 */
interface ElementMatch {
    ref: string;
    role: string;
    name: string;
    bounds: { x1: number; y1: number; x2: number; y2: number };
    center: { x: number; y: number };
    disabled: boolean;
    checked: boolean;
    selected: boolean;
}

/**
 * Find elements in the latest snapshot matching the given criteria.
 * All filter params are optional and combined with AND logic.
 */
function findElementsInSnapshot(
    role?: string,
    name?: string,
    hint?: string,
    state?: 'disabled' | 'enabled' | 'checked' | 'selected',
    text?: string,
    ref?: string
): ElementMatch[] {
    const currentSnapshot = getCurrentSnapshot();
    if (!currentSnapshot) return [];

    const elements = parseSnapshotElements(currentSnapshot.snapshot);

    // Pre-compute text→parentRef mapping if text search is requested
    let textRefs: Set<string> | undefined;
    if (text) {
        textRefs = findRefsByTextContent(currentSnapshot.snapshot, text);
    }

    const results: ElementMatch[] = [];

    for (const el of elements) {
        if (role && el.role !== role) continue;
        if (name && !el.name.toLowerCase().includes(name.toLowerCase())) continue;
        if (ref && el.ref !== ref) continue;

        // State filter
        if (state === 'disabled' && !el.disabled) continue;
        if (state === 'enabled' && el.disabled) continue;
        if (state === 'checked' && !el.checked) continue;
        if (state === 'selected' && !el.selected) continue;

        // Hint filter
        if (hint) {
            const hintPattern = new RegExp(
                `\\[ref=${el.ref}[^\\]]*\\][\\s\\S]{0,200}/hint:\\s*${hint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
            );
            if (!hintPattern.test(currentSnapshot.snapshot)) continue;
        }

        // Text filter: element must contain a text child matching the query
        if (textRefs && !textRefs.has(el.ref)) continue;

        results.push({
            ref: el.ref,
            role: el.role,
            name: el.name,
            bounds: {
                x1: el.x - Math.round(el.width / 2),
                y1: el.y - Math.round(el.height / 2),
                x2: el.x + Math.round(el.width / 2),
                y2: el.y + Math.round(el.height / 2)
            },
            center: {
                x: el.x,
                y: el.y
            },
            disabled: el.disabled,
            checked: el.checked,
            selected: el.selected
        });
    }
    return results;
}

/**
 * Finds element refs whose text children contain the given query.
 * Scans `- text: "..."` lines in the snapshot and maps them to parent elements.
 */
function findRefsByTextContent(snapshotText: string, query: string): Set<string> {
    const refs = new Set<string>();
    const lines = snapshotText.split('\n');
    const q = query.toLowerCase();

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const textMatch = line.match(/^\s*- text:\s*(.+)$/);
        if (!textMatch) continue;
        if (!textMatch[1].toLowerCase().includes(q)) continue;

        // Find the nearest parent element with a ref (less indentation, contains [ref=e)
        const textIndent = line.search(/\S/);
        for (let j = i - 1; j >= 0; j--) {
            const parentIndent = lines[j].search(/\S/);
            if (parentIndent < textIndent && lines[j].includes('[ref=e')) {
                const refMatch = lines[j].match(/\[ref=(e\d+)/);
                if (refMatch) refs.add(refMatch[1]);
                break;
            }
        }
    }
    return refs;
}

// ========== scrollTo (scrollIntoView) ==========

const ScrollToArgsSchema = z.object({
    targetRole: z.string().describe('目标元素的 role 类型，如 "button"、"listitem"、"textbox"、"heading"'),
    targetName: z.string().optional().describe('目标元素的显示名称或包含的文本，模糊匹配'),
    targetHint: z.string().optional().describe('目标元素的 hint 提示文本'),
    containerRole: z.string().optional().describe('滚动容器的 role 类型，如不指定则使用全屏 dircFling'),
    containerName: z.string().optional().describe('滚动容器的名称'),
    direction: z.enum(['up', 'down']).optional().describe('滚动方向提示。不指定时根据目标是否在视口上方/下方自动判断'),
    maxScrolls: z.number().int().min(1).max(20).default(5).describe('最大滚动尝试次数，超过后认为目标不可达，默认 5'),
    scrollDistance: z.number().int().min(50).default(300).describe('每次滚动的距离（像素），默认 300'),
    snapshot: z.boolean().default(true).describe('滚动完成后是否获取界面快照，默认 true')
});

export class ScrollToTool extends BaseTool<typeof ScrollToArgsSchema> {
    constructor() {
        super(
            'scrollTo',
            '滚动页面直到指定元素可见（scrollIntoView 语义）。\n' +
                '从最新快照中按 role/name/hint 搜索目标元素；未找到时按指定方向滚动指定距离后重新获取快照并搜索，\n' +
                '重复直到目标出现或达到最大尝试次数。返回最终快照和滚动次数。',
            ScrollToArgsSchema
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof ScrollToArgsSchema>): Promise<string> {
        try {
            // Check if target is already visible in latest snapshot
            let found = findElementsInSnapshot(args.targetRole, args.targetName, args.targetHint);
            if (found.length > 0) {
                const withSnap = await withSnapshot(args.snapshot, {
                    scrollsUsed: 0,
                    targetFound: true,
                    elements: found.map((e) => ({
                        ref: e.ref,
                        role: e.role,
                        name: e.name,
                        bounds: e.bounds
                    }))
                });
                return ok(withSnap);
            }

            // Determine scroll direction
            let direction: 'up' | 'down';
            if (args.direction) {
                direction = args.direction;
            } else {
                // Heuristic: if targetName contains numbers/letters suggesting lower position,
                // scroll down (which maps to "up" in the scroll direction system)
                direction = 'up';
            }

            // Resolve container region if specified
            let containerRegion: { x: number; y: number; width: number; height: number } | undefined;
            if (args.containerRole) {
                const resolved = resolveContainerFromSnapshot(args.containerRole, args.containerName);
                if (!resolved) {
                    return fail(
                        `找不到滚动容器：role="${args.containerRole}"` +
                            (args.containerName ? `, name="${args.containerName}"` : '') +
                            '。请先执行 snapshot'
                    );
                }
                containerRegion = resolved;
            }

            // Iterative scroll
            for (let i = 1; i <= args.maxScrolls; i++) {
                await performScrollGesture(direction, containerRegion, args.scrollDistance);

                // Wait for scroll animation and take new snapshot
                await new Promise((resolve) => setTimeout(resolve, 500));
                await takeSnapshot();

                // Check if target is now visible
                found = findElementsInSnapshot(args.targetRole, args.targetName, args.targetHint);
                if (found.length > 0) {
                    const withSnap = await withSnapshot(args.snapshot, {
                        scrollsUsed: i,
                        targetFound: true,
                        elements: found.map((e) => ({
                            ref: e.ref,
                            role: e.role,
                            name: e.name,
                            bounds: e.bounds
                        }))
                    });
                    return ok(withSnap);
                }
            }

            // Max scrolls reached, target not found
            const withSnap = await withSnapshot(args.snapshot, {
                scrollsUsed: args.maxScrolls,
                targetFound: false,
                message:
                    `未找到目标元素 role="${args.targetRole}"` +
                    (args.targetName ? ` name≈"${args.targetName}"` : '') +
                    `，已尝试 ${args.maxScrolls} 次滚动`
            });
            return ok(withSnap);
        } catch (err) {
            return fail(`scrollTo failed: ${err}`);
        }
    }
}

// HarmonyOS keycodes (from https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-keycode)
const KEYCODE_PASTE = 2622;
const KEYCODE_CTRL_LEFT = 2072;
const KEYCODE_ALT_LEFT = 2045;
const KEYCODE_SHIFT_LEFT = 2047;
const DEFAULT_REPLACE_CLEAR_CHARS = 256;

/** Map human-readable key names to HarmonyOS keycodes. */
const KEY_MAP: Record<string, number> = {
    // Letters
    a: 2017,
    b: 2018,
    c: 2019,
    d: 2020,
    e: 2021,
    f: 2022,
    g: 2023,
    h: 2024,
    i: 2025,
    j: 2026,
    k: 2027,
    l: 2028,
    m: 2029,
    n: 2030,
    o: 2031,
    p: 2032,
    q: 2033,
    r: 2034,
    s: 2035,
    t: 2036,
    u: 2037,
    v: 2038,
    w: 2039,
    x: 2040,
    y: 2041,
    z: 2042,
    // Digits
    '0': 2000,
    '1': 2001,
    '2': 2002,
    '3': 2003,
    '4': 2004,
    '5': 2005,
    '6': 2006,
    '7': 2007,
    '8': 2008,
    '9': 2009,
    // Navigation & editing
    Enter: 2054,
    Tab: 2049,
    Escape: 2070,
    Backspace: 2055,
    Delete: 2071,
    Space: 2050,
    Home: 1,
    Back: 2,
    ArrowUp: 2012,
    ArrowDown: 2013,
    ArrowLeft: 2014,
    ArrowRight: 2015,
    PageUp: 2068,
    PageDown: 2069,
    Insert: 2083,
    // Function keys
    F1: 2090,
    F2: 2091,
    F3: 2092,
    F4: 2093,
    F5: 2094,
    F6: 2095,
    F7: 2096,
    F8: 2097,
    F9: 2098,
    F10: 2099,
    F11: 2100,
    F12: 2101,
    // Special keys
    Paste: 2622,
    Copy: 2620,
    Cut: 2624,
    Refresh: 2635,
    // Symbols
    '-': 2057,
    '=': 2058,
    '[': 2059,
    ']': 2060,
    '\\': 2061,
    ';': 2062,
    "'": 2063,
    '/': 2064,
    '@': 2065,
    '+': 2066,
    ',': 2043,
    '.': 2044,
    '`': 2056
};

const MODIFIER_MAP: Record<string, number> = {
    Ctrl: KEYCODE_CTRL_LEFT,
    Alt: KEYCODE_ALT_LEFT,
    Shift: KEYCODE_SHIFT_LEFT
};

interface KeyStroke {
    key: keyof typeof KEY_MAP;
    shift?: boolean;
}

function getAsciiKeyStroke(char: string): KeyStroke | undefined {
    if (/^[a-z0-9]$/.test(char)) return { key: char };
    if (/^[A-Z]$/.test(char)) return { key: char.toLowerCase() as keyof typeof KEY_MAP, shift: true };
    if (char === ' ') return { key: 'Space' };
    if (char === '\n') return { key: 'Enter' };
    if (char === '\t') return { key: 'Tab' };

    const directKeys: Record<string, keyof typeof KEY_MAP> = {
        '-': '-',
        '=': '=',
        '[': '[',
        ']': ']',
        '\\': '\\',
        ';': ';',
        "'": "'",
        '/': '/',
        ',': ',',
        '.': '.',
        '`': '`'
    };
    if (directKeys[char]) return { key: directKeys[char] };

    const shiftedKeys: Record<string, keyof typeof KEY_MAP> = {
        '!': '1',
        '@': '2',
        '#': '3',
        $: '4',
        '%': '5',
        '^': '6',
        '&': '7',
        '*': '8',
        '(': '9',
        ')': '0',
        _: '-',
        '+': '=',
        '{': '[',
        '}': ']',
        '|': '\\',
        ':': ';',
        '"': "'",
        '<': ',',
        '>': '.',
        '?': '/',
        '~': '`'
    };
    return shiftedKeys[char] ? { key: shiftedKeys[char], shift: true } : undefined;
}

async function typeAsciiText(text: string): Promise<boolean> {
    const strokes = [...text].map(getAsciiKeyStroke);
    if (strokes.some((stroke) => !stroke)) return false;

    for (const stroke of strokes) {
        const codes = stroke!.shift ? [KEYCODE_SHIFT_LEFT, KEY_MAP[stroke!.key]] : [KEY_MAP[stroke!.key]];
        await runHdc(['shell', 'uitest', 'uiInput', 'keyEvent', ...codes.map(String)], 5000);
    }
    return true;
}

async function pasteFocusedText(text: string): Promise<void> {
    await runHdc(['shell', 'uitest', 'uiInput', 'text', text], 10000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await clearFocusedText(3);
    await runHdc(['shell', 'uitest', 'uiInput', 'keyEvent', String(KEYCODE_PASTE)], 5000);
}

// ========== input ==========

const InputArgsSchema = z.object({
    x: z.number().int().describe('输入框的 X 坐标'),
    y: z.number().int().describe('输入框的 Y 坐标'),
    text: z.string().describe('要输入的文本内容'),
    mode: z
        .enum(['append', 'replace'])
        .default('append')
        .describe('输入模式：append 在现有光标处追加；replace 从开头删除已有文本后输入'),
    maxClearChars: z
        .number()
        .int()
        .min(1)
        .max(4096)
        .default(DEFAULT_REPLACE_CLEAR_CHARS)
        .describe('replace 模式最多删除的字符数，默认 256；内容更长时需显式增大'),
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取界面快照，默认 false')
});

async function clearFocusedText(maxClearChars: number): Promise<void> {
    // Do NOT use KEY_MAP.Home (keycode 1): it is the system Home button on
    // HarmonyOS, intercepted by the system and triggers browser / home screen
    // instead of "move cursor to beginning of line". Use Backspace to delete
    // from the end instead.
    for (let i = 0; i < maxClearChars; i++) {
        await runHdc(['shell', 'uitest', 'uiInput', 'keyEvent', String(KEY_MAP.Backspace)], 5000);
    }
}

export class InputTool extends BaseTool<typeof InputArgsSchema> {
    constructor() {
        super(
            'input',
            '在指定坐标的输入框中输入文本。会先点击坐标获取焦点，然后输入文本。' +
                '支持中文输入：对非 ASCII 文本，通过剪贴板粘贴实现',
            InputArgsSchema
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof InputArgsSchema>): Promise<string> {
        try {
            const hasNonAscii = /[^\x00-\x7F]/.test(args.text);

            // Click to focus the input.
            await runHdc(['shell', 'uitest', 'uiInput', 'click', String(args.x), String(args.y)], 10000);
            await new Promise((resolve) => setTimeout(resolve, 300));

            if (args.mode === 'replace') {
                // XComponent can treat Ctrl+A as a literal "a". Delete from the
                // beginning instead, bounded to avoid an unbounded device operation.
                await clearFocusedText(args.maxClearChars);
            }

            if (hasNonAscii) {
                // uiInput text writes the intended text to the pasteboard but leaves
                // the fixed "va'" fallback sequence in the focused field. Do not
                // use Ctrl+A here: XComponent may deliver it as a literal "a".
                await pasteFocusedText(args.text);
            } else {
                // uiInput text can prepend a fallback character in XComponent.
                // Physical key events avoid the clipboard-based text path.
                const typed = await typeAsciiText(args.text);
                if (!typed) {
                    await runHdc(['shell', 'uitest', 'uiInput', 'text', args.text], 10000);
                }
            }

            const result = await withSnapshot(args.snapshot, {
                x: args.x,
                y: args.y,
                text: args.text,
                mode: args.mode,
                ...(args.mode === 'replace' ? { maxClearChars: args.maxClearChars } : {})
            });
            return ok(result);
        } catch (err) {
            return fail(`Failed to input text: ${err}`);
        }
    }
}

// ========== test fixtures and native file picker ==========

const DeviceDirectorySchema = z
    .string()
    .min(2)
    .max(2048)
    .refine(
        (value) =>
            value.startsWith('/') &&
            !value.includes('\0') &&
            !/[\r\n]/.test(value) &&
            !/[;&|`$<>(){}[\]*?!'"\\#~]/.test(value),
        {
            message: '设备目录必须是绝对路径且不能包含 shell 元字符、换行或 NUL 字符'
        }
    )
    .refine((value) => posix.normalize(value) !== '/', {
        message: '不能把设备根目录作为 fixture 目标目录'
    });

const StageFixtureArgsSchema = z.object({
    localPath: z.string().min(1).describe('宿主机上的测试文件或目录路径'),
    deviceDirectory: DeviceDirectorySchema.describe('设备上的目标目录；应选择系统文件选择器可浏览的位置')
});

export class StageFixtureTool extends BaseTool<typeof StageFixtureArgsSchema> {
    constructor() {
        super(
            'stageFixture',
            '通过 hdc file send 将宿主机测试文件或目录下发到设备。只创建目标目录，不会清理或删除设备文件。',
            StageFixtureArgsSchema
        );
        this.serialExecution = true;
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof StageFixtureArgsSchema>): Promise<string> {
        try {
            const localPath = resolve(args.localPath);
            const stats = statSync(localPath);
            const deviceDirectory = posix.normalize(args.deviceDirectory);
            const devicePath = posix.join(deviceDirectory, basename(localPath));

            await runHdc(['shell', 'mkdir', '-p', deviceDirectory], 10000);
            await runHdc(['file', 'send', localPath, devicePath], 120000);

            return ok({
                localPath,
                devicePath,
                kind: stats.isDirectory() ? 'directory' : 'file',
                ...(!stats.isDirectory() ? { bytes: stats.size } : {})
            });
        } catch (err) {
            return fail(`下发测试 fixture 失败：${err}`);
        }
    }
}

interface PickerTarget {
    node: LayoutNode;
    label: string;
    bounds: { x1: number; y1: number; x2: number; y2: number };
    bundleName?: string;
}

function collectPickerTargets(
    node: LayoutNode,
    inheritedBundleName?: string,
    result: PickerTarget[] = []
): PickerTarget[] {
    const attrs = node.attributes || {};
    const bundleName = attrs.bundleName || inheritedBundleName;
    const bounds = parseBounds(attrs.bounds);
    const role = getRole(attrs.type || '');
    const interactive = attrs.clickable === 'true' || role === 'button' || role === 'listitem' || role === 'textbox';
    const visible = attrs.visible !== 'false' && (!bounds || (bounds.x2 > bounds.x1 && bounds.y2 > bounds.y1));

    if (interactive && visible && bounds) {
        result.push({
            node,
            label: normalizeAccessibleText(collectNodeText(node)),
            bounds,
            bundleName
        });
    }
    for (const child of node.children || []) collectPickerTargets(child, bundleName, result);
    return result;
}

function findPickerTarget(
    layout: LayoutNode,
    labels: readonly string[],
    options: { exact?: boolean; role?: string; bundleName?: string } = {}
): PickerTarget | undefined {
    const normalizedLabels = labels.map(normalizeAccessibleText).filter(Boolean);
    return collectPickerTargets(layout).find((target) => {
        if (options.bundleName && target.bundleName !== options.bundleName) return false;
        if (options.role && getRole(target.node.attributes?.type || '') !== options.role) return false;
        return normalizedLabels.some((label) =>
            options.exact === false ? target.label.includes(label) : target.label === label
        );
    });
}

function pickerBundleName(layout: LayoutNode): string | undefined {
    const windows = findAllWindows(layout);
    const namedPicker = windows.find((window) => /(?:file|picker|document|storage)/i.test(window.bundleName));
    if (namedPicker) return namedPicker.bundleName;
    return windows.find(
        (window) =>
            window.bundleName && window.bundleName !== SCENEBOARD_BUNDLE && !window.bundleName.includes('opendesk')
    )?.bundleName;
}

async function clickPickerTarget(target: PickerTarget): Promise<void> {
    const point = getCenter(target.bounds);
    if (!point) throw new Error(`文件选择器目标没有有效坐标：${target.label}`);
    await runHdc(['shell', 'uitest', 'uiInput', 'click', String(point.x), String(point.y)], 10000);
}

async function replaceTextAt(x: number, y: number, text: string): Promise<void> {
    await runHdc(['shell', 'uitest', 'uiInput', 'click', String(x), String(y)], 10000);
    await clearFocusedText(DEFAULT_REPLACE_CLEAR_CHARS);
    const typed = await typeAsciiText(text);
    if (!typed) {
        await pasteFocusedText(text);
    }
}

const ChooseFileArgsSchema = z.object({
    path: z
        .string()
        .min(1)
        .max(2048)
        .refine((value) => value.startsWith('/') && !value.includes('\0') && !/[\r\n]/.test(value), {
            message: 'path 必须是设备绝对路径且不能包含换行或 NUL 字符'
        })
        .describe('设备上的文件、目录或保存目标绝对路径'),
    mode: z.enum(['openFile', 'openDirectory', 'saveFile']).describe('选择文件、选择目录或指定保存文件名'),
    maxScrolls: z.number().int().min(0).max(20).default(6).describe('查找可见条目时最多向下滚动的次数'),
    snapshot: z.boolean().default(true).describe('确认选择后是否获取所有可见窗口的快照，默认 true')
});

const PICKER_CONFIRM_LABELS: Record<z.output<typeof ChooseFileArgsSchema>['mode'], readonly string[]> = {
    openFile: ['打开', '选择', '确定', '完成', 'Open', 'Select', 'Choose', 'OK', 'Done'],
    openDirectory: [
        '选择当前文件夹',
        '使用此文件夹',
        '选择',
        '确定',
        '完成',
        'Use this folder',
        'Select',
        'Choose',
        'OK',
        'Done'
    ],
    saveFile: ['保存', '确定', '完成', 'Save', 'OK', 'Done']
};

export class ChooseFileTool extends BaseTool<typeof ChooseFileArgsSchema> {
    constructor() {
        super(
            'chooseFile',
            '操控当前 HarmonyOS 系统文件选择器：按设备路径中的可见目录逐层导航，选择文件/目录，或填写保存文件名并确认。',
            ChooseFileArgsSchema
        );
        this.serialExecution = true;
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof ChooseFileArgsSchema>): Promise<string> {
        const normalizedPath = posix.normalize(args.path);
        const targetName = posix.basename(normalizedPath);
        const pathParts = normalizedPath.split('/').filter(Boolean);
        const parentParts = pathParts.slice(0, -1);
        const visitedDirectories = new Set<string>();
        let scrollsUsed = 0;
        let layout: LayoutNode | undefined;
        let selectedTarget: PickerTarget | undefined;
        let detectedBundleName: string | undefined;

        try {
            while (true) {
                layout = await dumpLayout();
                detectedBundleName ||= pickerBundleName(layout);

                const nextDirectory = [...parentParts].reverse().find(
                    (part) =>
                        !visitedDirectories.has(part) &&
                        findPickerTarget(layout!, [part], {
                            bundleName: detectedBundleName
                        })
                );
                if (nextDirectory) {
                    const directoryTarget = findPickerTarget(layout, [nextDirectory], {
                        bundleName: detectedBundleName
                    })!;
                    visitedDirectories.add(nextDirectory);
                    await clickPickerTarget(directoryTarget);
                    await new Promise((resolve) => setTimeout(resolve, 300));
                    continue;
                }

                if (args.mode === 'saveFile') {
                    const textBox =
                        findPickerTarget(layout, ['文件名', '名称', 'File name', 'Name'], {
                            exact: false,
                            role: 'textbox',
                            bundleName: detectedBundleName
                        }) ||
                        collectPickerTargets(layout).find(
                            (target) =>
                                getRole(target.node.attributes?.type || '') === 'textbox' &&
                                (!detectedBundleName || target.bundleName === detectedBundleName)
                        );
                    if (textBox) {
                        const point = getCenter(textBox.bounds)!;
                        await replaceTextAt(point.x, point.y, targetName);
                        selectedTarget = textBox;
                        break;
                    }
                } else {
                    selectedTarget = findPickerTarget(layout, [targetName], {
                        bundleName: detectedBundleName
                    });
                    if (selectedTarget) {
                        await clickPickerTarget(selectedTarget);
                        break;
                    }
                }

                if (scrollsUsed >= args.maxScrolls) {
                    const capture = convertLayout(layout);
                    return fail(
                        `系统文件选择器中未找到 ${args.mode === 'saveFile' ? '文件名输入框' : `目标“${targetName}”`}。` +
                            `请确认 Picker 已打开、路径可浏览且目标已通过 stageFixture 下发。最后快照：${capture.snapshot}`
                    );
                }
                await runHdc(['shell', 'uitest', 'uiInput', 'dircFling', '2'], 10000);
                scrollsUsed += 1;
                await new Promise((resolve) => setTimeout(resolve, 300));
            }

            await new Promise((resolve) => setTimeout(resolve, 300));
            layout = await dumpLayout();
            const pickerStillVisible = detectedBundleName
                ? findAllWindows(layout).some((window) => window.bundleName === detectedBundleName)
                : true;
            if (pickerStillVisible) {
                const confirmTarget = findPickerTarget(layout, PICKER_CONFIRM_LABELS[args.mode], {
                    bundleName: detectedBundleName
                });
                if (!confirmTarget) {
                    const capture = convertLayout(layout);
                    return fail(`已选中“${targetName}”，但未找到文件选择器确认按钮。最后快照：${capture.snapshot}`);
                }
                await clickPickerTarget(confirmTarget);
            }

            return ok(
                await withSnapshot(args.snapshot, {
                    path: normalizedPath,
                    mode: args.mode,
                    selected: Boolean(selectedTarget),
                    confirmed: true,
                    ...(detectedBundleName ? { pickerBundleName: detectedBundleName } : {}),
                    ...(scrollsUsed > 0 ? { scrollsUsed } : {})
                })
            );
        } catch (err) {
            return fail(`系统文件选择失败：${err}`);
        }
    }
}

const DropFixtureArgsSchema = z.object({
    localPath: z.string().min(1).describe('宿主机上的待投放文件路径'),
    bundleName: BundleNameSchema.default('com.develop.opensource.ohpcd.opendesk'),
    x: z.number().int().min(0).describe('WebView 中投放目标的 X 坐标'),
    y: z.number().int().min(0).describe('WebView 中投放目标的 Y 坐标'),
    snapshot: z.boolean().default(true).describe('投放后是否获取目标应用快照，默认 true')
});

const DROP_FIXTURE_MAX_BYTES = 20 * 1024 * 1024;
const DROP_FIXTURE_CHUNK_SIZE = 16 * 1024;

function fixtureMimeType(fileName: string): string {
    const extension = fileName.toLowerCase().split('.').pop() || '';
    const mimeTypes: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        bmp: 'image/bmp',
        json: 'application/json',
        zip: 'application/zip',
        txt: 'text/plain'
    };
    return mimeTypes[extension] || 'application/octet-stream';
}

export class DropFixtureTool extends BaseTool<typeof DropFixtureArgsSchema> {
    constructor() {
        super(
            'dropFixture',
            '读取宿主机文件并在目标 WebView 坐标派发真实 dragenter/dragover/drop 事件，适用于图片上传和附件拖放。',
            DropFixtureArgsSchema
        );
        this.serialExecution = true;
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof DropFixtureArgsSchema>): Promise<string> {
        try {
            const localPath = resolve(args.localPath);
            const stats = statSync(localPath);
            if (!stats.isFile()) return fail(`dropFixture 只接受文件：${localPath}`);
            if (stats.size > DROP_FIXTURE_MAX_BYTES) {
                return fail(`文件过大：${stats.size} bytes，dropFixture 上限为 ${DROP_FIXTURE_MAX_BYTES} bytes`);
            }

            const fileName = basename(localPath);
            const mimeType = fixtureMimeType(fileName);
            const base64 = readFileSync(localPath).toString('base64');
            const fixtureId = createHash('sha256')
                .update(localPath)
                .update(String(Date.now()))
                .digest('hex')
                .slice(0, 16);
            const chunks = base64.match(new RegExp(`.{1,${DROP_FIXTURE_CHUNK_SIZE}}`, 'g')) || [''];

            await runHdc(
                [
                    'shell',
                    'arkweb_exec_js',
                    '-b',
                    args.bundleName,
                    '-s',
                    `window.__opendeskFixtureChunks=window.__opendeskFixtureChunks||{};window.__opendeskFixtureChunks[${JSON.stringify(fixtureId)}]=[];`
                ],
                10000
            );
            for (const chunk of chunks) {
                await runHdc(
                    [
                        'shell',
                        'arkweb_exec_js',
                        '-b',
                        args.bundleName,
                        '-s',
                        `window.__opendeskFixtureChunks[${JSON.stringify(fixtureId)}].push(${JSON.stringify(chunk)});`
                    ],
                    10000
                );
            }

            const dispatchScript = `(()=>{const k=${JSON.stringify(fixtureId)};const b=window.__opendeskFixtureChunks?.[k]?.join('');if(b===undefined)throw new Error('fixture chunks missing');const a=atob(b);const u=new Uint8Array(a.length);for(let i=0;i<a.length;i++)u[i]=a.charCodeAt(i);const f=new File([u],${JSON.stringify(fileName)},{type:${JSON.stringify(mimeType)}});const d=new DataTransfer();d.items.add(f);const e=document.elementFromPoint(${args.x},${args.y});if(!e)throw new Error('drop target not found');for(const t of ['dragenter','dragover','drop'])e.dispatchEvent(new DragEvent(t,{bubbles:true,cancelable:true,clientX:${args.x},clientY:${args.y},dataTransfer:d}));delete window.__opendeskFixtureChunks[k];return 'drop-dispatched';})()`;
            const detail = await runHdc(
                ['shell', 'arkweb_exec_js', '-b', args.bundleName, '-s', dispatchScript],
                20000
            );

            return ok(
                await withSnapshot(
                    args.snapshot,
                    {
                        localPath,
                        fileName,
                        bytes: stats.size,
                        mimeType,
                        x: args.x,
                        y: args.y,
                        method: 'webview-drop',
                        ...(detail ? { detail } : {})
                    },
                    args.bundleName
                )
            );
        } catch (err) {
            return fail(`投放测试 fixture 失败：${err}`);
        }
    }
}

// ========== goBack ==========

const GoBackArgsSchema = z.object({
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取界面快照，默认 false')
});

export class GoBackTool extends BaseTool<typeof GoBackArgsSchema> {
    constructor() {
        super('goBack', '按下返回键，返回上一级页面或退出当前应用', GoBackArgsSchema);
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof GoBackArgsSchema>): Promise<string> {
        try {
            await runHdc(['shell', 'uitest', 'uiInput', 'keyEvent', 'Back'], 10000);
            const result = await withSnapshot(args.snapshot, {});
            return ok(result);
        } catch (err) {
            return fail(`Failed to go back: ${err}`);
        }
    }
}

// ========== goForward ==========

const GoForwardArgsSchema = z.object({
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取界面快照，默认 false')
});

export class GoForwardTool extends BaseTool<typeof GoForwardArgsSchema> {
    constructor() {
        super('goForward', '按下 Alt+Right 方向键，在支持前进导航的应用中向前导航', GoForwardArgsSchema);
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof GoForwardArgsSchema>): Promise<string> {
        try {
            // Alt+Right Arrow
            await runHdc(
                ['shell', 'uitest', 'uiInput', 'keyEvent', String(KEYCODE_ALT_LEFT), String(KEY_MAP.ArrowRight)],
                10000
            );
            const result = await withSnapshot(args.snapshot, {});
            return ok(result);
        } catch (err) {
            return fail(`Failed to go forward: ${err}`);
        }
    }
}

// ========== pressKey ==========

const PressKeyArgsSchema = z.object({
    key: z
        .string()
        .describe(
            '按键名称，如 Enter、Tab、Escape、Backspace、Delete、ArrowUp、ArrowDown、ArrowLeft、ArrowRight、Space、Home、Back、PageUp、PageDown、a-z、0-9、F1-F12、Paste、Copy、Cut、Refresh 等'
        ),
    modifiers: z
        .array(z.enum(['Ctrl', 'Alt', 'Shift']))
        .max(2)
        .optional()
        .describe('修饰键列表，如 ["Ctrl"] 或 ["Ctrl", "Shift"]'),
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取界面快照，默认 false')
});

export class PressKeyTool extends BaseTool<typeof PressKeyArgsSchema> {
    constructor() {
        super(
            'pressKey',
            '在当前焦点元素上按下指定按键。支持功能键、方向键、字母数字键和修饰键组合。' +
                '按键名称参考 HarmonyOS 键值定义。在输入框中输入文本后，推荐优先使用 pressKey({ key: "Enter" }) 发送消息',
            PressKeyArgsSchema
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof PressKeyArgsSchema>): Promise<string> {
        try {
            const keyCode = KEY_MAP[args.key];
            if (keyCode === undefined) {
                return fail(`Unknown key: "${args.key}". Supported keys: ${Object.keys(KEY_MAP).join(', ')}`);
            }

            const mods = args.modifiers ?? [];
            const modCodes = mods.map((m) => MODIFIER_MAP[m]).filter((c) => c !== undefined);
            // Unknown modifier would have been rejected by zod enum

            // uitest keyEvent accepts up to 3 keycodes: modifier1 modifier2 key
            const allCodes = [...modCodes, keyCode];
            await runHdc(['shell', 'uitest', 'uiInput', 'keyEvent', ...allCodes.map(String)], 10000);

            const result: Record<string, unknown> = { key: args.key };
            if (mods.length) result.modifiers = mods;
            const finalResult = await withSnapshot(args.snapshot, result);
            return ok(finalResult);
        } catch (err) {
            return fail(`Failed to press key ${args.key}: ${err}`);
        }
    }
}

// ========== waitFor ==========

const ElementLocatorSchema = z.object({
    role: z.string().min(1).optional().describe('元素角色，例如 button、textbox'),
    name: z.string().min(1).optional().describe('元素可访问名称'),
    id: z.string().min(1).optional().describe('元素稳定 ID'),
    hint: z.string().min(1).optional().describe('元素提示文本'),
    match: z.enum(['exact', 'contains']).default('exact').describe('文本字段使用精确匹配或包含匹配'),
    nth: z.number().int().min(0).optional().describe('存在多个匹配元素时选择从 0 开始的序号')
});

const WaitConditionSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('text'),
        text: z.string().min(1).describe('要等待的界面文本'),
        match: z.enum(['exact', 'contains']).default('contains'),
        state: z.enum(['visible', 'hidden']).default('visible')
    }),
    z.object({
        type: z.literal('element'),
        locator: ElementLocatorSchema,
        state: z.enum(['visible', 'hidden', 'enabled', 'disabled'])
    }),
    z.object({
        type: z.literal('snapshotChange'),
        snapshotId: z.string().min(1).describe('作为变化基线的 snapshotId')
    }),
    z.object({
        type: z.literal('window'),
        bundleName: BundleNameSchema.describe('要等待的窗口 bundleName'),
        state: z.enum(['visible', 'hidden']).default('visible')
    })
]);

const WaitForArgsSchema = z.object({
    duration: z
        .number()
        .int()
        .min(100)
        .max(30000)
        .optional()
        .describe('兼容模式：固定等待时间（毫秒），不能与 condition 同时使用'),
    condition: WaitConditionSchema.optional().describe('轮询等待的界面条件'),
    bundleName: BundleNameSchema.optional().describe('轮询无障碍树时限定的应用窗口'),
    timeout: z.number().int().min(100).max(300000).default(10000).describe('条件等待超时时间，默认 10000 毫秒'),
    interval: z.number().int().min(100).max(5000).default(500).describe('条件轮询间隔，默认 500 毫秒'),
    stableFor: z
        .number()
        .int()
        .min(0)
        .max(10000)
        .default(300)
        .describe('条件需连续成立的时间，默认 300 毫秒；snapshotChange 会在首次变化时立即返回'),
    snapshot: z.boolean().default(false).describe('固定等待结束后是否自动获取界面快照，默认 false'),
    screenshotOnTimeout: z.boolean().default(true).describe('条件超时时是否尝试附加最后屏幕的 OCR 证据，默认 true')
});

type ElementLocator = z.output<typeof ElementLocatorSchema>;
type WaitCondition = z.output<typeof WaitConditionSchema>;

interface LocatedLayoutNode {
    node: LayoutNode;
    visible: boolean;
    enabled: boolean;
    role: string;
    name: string;
}

interface WaitConditionEvaluation {
    satisfied: boolean;
    matchedCount: number;
    match?: Record<string, unknown>;
}

function normalizeAccessibleText(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

function collectLayoutNodes(
    node: LayoutNode,
    ancestorExposed = true,
    ancestorEnabled = true,
    result: LocatedLayoutNode[] = []
): LocatedLayoutNode[] {
    const attrs = node.attributes || {};
    const exposed = ancestorExposed && attrs.visible !== 'false';
    const enabled = ancestorEnabled && attrs.enabled !== 'false';
    const bounds = parseBounds(attrs.bounds);
    const visible = exposed && (!bounds || (bounds.x2 > bounds.x1 && bounds.y2 > bounds.y1));
    result.push({
        node,
        visible,
        enabled,
        role: getRole(attrs.type || ''),
        name: normalizeAccessibleText(getName(attrs))
    });
    // A zero-size wrapper may still contain visible children. Only an explicit
    // visible=false attribute hides its descendants.
    for (const child of node.children || []) collectLayoutNodes(child, exposed, enabled, result);
    return result;
}

function matchesLocatorText(actual: string, expected: string, match: ElementLocator['match']): boolean {
    const normalizedActual = normalizeAccessibleText(actual);
    const normalizedExpected = normalizeAccessibleText(expected);
    return match === 'exact' ? normalizedActual === normalizedExpected : normalizedActual.includes(normalizedExpected);
}

function findLocatedElements(layout: LayoutNode, locator: ElementLocator): LocatedLayoutNode[] {
    if (!locator.role && !locator.name && !locator.id && !locator.hint) {
        throw new Error('element locator 至少需要 role、name、id 或 hint 中的一项');
    }

    const matches = collectLayoutNodes(layout).filter((item) => {
        const attrs = item.node.attributes || {};
        if (locator.role && item.role !== locator.role) return false;
        if (locator.name && !matchesLocatorText(item.name, locator.name, locator.match)) return false;
        if (locator.id && !matchesLocatorText(attrs.id || '', locator.id, locator.match)) return false;
        if (locator.hint && !matchesLocatorText(attrs.hint || '', locator.hint, locator.match)) return false;
        return true;
    });

    if (locator.nth === undefined) return matches;
    return matches[locator.nth] ? [matches[locator.nth]] : [];
}

function describeLocatedNode(item: LocatedLayoutNode): Record<string, unknown> {
    const attrs = item.node.attributes || {};
    return {
        role: item.role,
        name: item.name,
        visible: item.visible,
        enabled: item.enabled,
        ...(attrs.id ? { id: attrs.id } : {}),
        ...(attrs.bounds ? { bounds: attrs.bounds } : {})
    };
}

function evaluateWaitCondition(
    condition: WaitCondition,
    layout: LayoutNode,
    built: BuiltSnapshot,
    baselineFingerprint?: string
): WaitConditionEvaluation {
    if (condition.type === 'snapshotChange') {
        const changed = built.fingerprint !== baselineFingerprint;
        return {
            satisfied: changed,
            matchedCount: changed ? 1 : 0,
            match: { fingerprint: built.fingerprint }
        };
    }

    if (condition.type === 'window') {
        const windows = findAllWindows(layout).filter((window) => window.bundleName === condition.bundleName);
        const visible = windows.length > 0;
        return {
            satisfied: condition.state === 'visible' ? visible : !visible,
            matchedCount: windows.length,
            ...(windows[0] ? { match: windows[0] } : {})
        };
    }

    if (condition.type === 'text') {
        const matches = collectLayoutNodes(layout).filter((item) => {
            if (!item.visible) return false;
            const text = getNodeText(item.node);
            return matchesLocatorText(text, condition.text, condition.match);
        });
        const visible = matches.length > 0;
        return {
            satisfied: condition.state === 'visible' ? visible : !visible,
            matchedCount: matches.length,
            ...(matches[0] ? { match: describeLocatedNode(matches[0]) } : {})
        };
    }

    const matches = findLocatedElements(layout, condition.locator);
    const visibleMatches = matches.filter((item) => item.visible);
    const enabledMatches = visibleMatches.filter((item) => item.enabled);
    const disabledMatches = visibleMatches.filter((item) => !item.enabled);
    const satisfied =
        condition.state === 'visible'
            ? visibleMatches.length > 0
            : condition.state === 'hidden'
              ? visibleMatches.length === 0
              : condition.state === 'enabled'
                ? enabledMatches.length > 0
                : disabledMatches.length > 0;
    const representative =
        condition.state === 'disabled' ? disabledMatches[0] : enabledMatches[0] || visibleMatches[0] || matches[0];
    return {
        satisfied,
        matchedCount: matches.length,
        ...(representative ? { match: describeLocatedNode(representative) } : {})
    };
}

async function captureTimeoutEvidence(): Promise<Record<string, unknown>> {
    let screenshotDir: string | undefined;
    try {
        const imgPath = await captureScreenshot();
        screenshotDir = dirname(imgPath);
        return {
            captured: true,
            ocr: await performOcr(imgPath)
        };
    } catch (err) {
        return {
            captured: false,
            error: String(err)
        };
    } finally {
        if (screenshotDir) rmSync(screenshotDir, { recursive: true, force: true });
    }
}

export class WaitForTool extends BaseTool<typeof WaitForArgsSchema> {
    constructor() {
        super(
            'waitFor',
            '等待固定时间，或轮询等待文本、元素状态、窗口状态或快照内容变化。条件满足或超时时都会返回最后一份可用快照。',
            WaitForArgsSchema
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof WaitForArgsSchema>): Promise<string> {
        if (args.duration !== undefined && args.condition) {
            return fail('duration 与 condition 不能同时使用');
        }
        if (args.duration === undefined && !args.condition) {
            return fail('必须提供 duration 或 condition');
        }

        if (args.duration !== undefined) {
            await new Promise((resolve) => setTimeout(resolve, args.duration));
            const result = await withSnapshot(args.snapshot, { duration: args.duration });
            return ok(result);
        }

        const condition = args.condition!;
        if (
            condition.type === 'element' &&
            !condition.locator.role &&
            !condition.locator.name &&
            !condition.locator.id &&
            !condition.locator.hint
        ) {
            return fail('element locator 至少需要 role、name、id 或 hint 中的一项');
        }
        let baselineFingerprint: string | undefined;
        if (condition.type === 'snapshotChange') {
            pruneSnapshotCaptures();
            const baseline = snapshotCaptures.get(condition.snapshotId);
            if (!baseline) {
                return fail(`快照基线不存在或已失效：${condition.snapshotId}`);
            }
            baselineFingerprint = baseline.fingerprint;
        }

        const startedAt = Date.now();
        const deadline = startedAt + args.timeout;
        const requiredStableFor = condition.type === 'snapshotChange' ? 0 : args.stableFor;
        let stableSince: number | undefined;
        let attempts = 0;
        let lastBuilt: BuiltSnapshot | undefined;
        let lastEvaluation: WaitConditionEvaluation | undefined;
        let lastCaptureError: string | undefined;

        while (Date.now() < deadline) {
            attempts++;
            try {
                // Window presence must be evaluated against the complete window
                // list; element and text waits may use the optional app filter.
                const snapshotBundleName = condition.type === 'window' ? undefined : args.bundleName;
                const layout = await dumpLayout(snapshotBundleName);
                const built = buildSnapshot(layout, snapshotBundleName);
                const evaluation = evaluateWaitCondition(condition, layout, built, baselineFingerprint);
                lastBuilt = built;
                lastEvaluation = evaluation;
                lastCaptureError = undefined;

                if (evaluation.satisfied) {
                    stableSince ??= Date.now();
                    if (Date.now() - stableSince >= requiredStableFor) {
                        const capture = registerSnapshot(built);
                        return ok({
                            matched: true,
                            timedOut: false,
                            attempts,
                            elapsed: Date.now() - startedAt,
                            condition,
                            matchedCount: evaluation.matchedCount,
                            ...(evaluation.match ? { match: evaluation.match } : {}),
                            snapshot: capture.snapshot,
                            snapshotId: capture.snapshotId
                        });
                    }
                } else {
                    stableSince = undefined;
                }
            } catch (err) {
                stableSince = undefined;
                lastCaptureError = String(err);
            }

            const remaining = deadline - Date.now();
            if (remaining <= 0) break;
            await new Promise((resolve) => setTimeout(resolve, Math.min(args.interval, remaining)));
        }

        const capture = lastBuilt ? registerSnapshot(lastBuilt) : undefined;
        const screenshot = args.screenshotOnTimeout ? await captureTimeoutEvidence() : undefined;
        return JSON.stringify({
            success: false,
            error: `等待界面条件超时（${args.timeout}ms）`,
            timedOut: true,
            attempts,
            elapsed: Date.now() - startedAt,
            condition,
            ...(lastEvaluation
                ? {
                      lastEvaluation: {
                          satisfied: lastEvaluation.satisfied,
                          matchedCount: lastEvaluation.matchedCount,
                          ...(lastEvaluation.match ? { match: lastEvaluation.match } : {})
                      }
                  }
                : {}),
            ...(capture ? { lastSnapshot: capture.snapshot, lastSnapshotId: capture.snapshotId } : {}),
            ...(lastCaptureError ? { lastCaptureError } : {}),
            ...(screenshot ? { screenshot } : {})
        });
    }
}

// ========== screenshot ==========

const ScreenshotArgsSchema = z.object({
    region: z
        .object({
            x1: z.number().int().min(0).describe('裁剪区域左上角 X 坐标'),
            y1: z.number().int().min(0).describe('裁剪区域左上角 Y 坐标'),
            x2: z.number().int().min(0).describe('裁剪区域右下角 X 坐标'),
            y2: z.number().int().min(0).describe('裁剪区域右下角 Y 坐标')
        })
        .optional()
        .describe('可选裁剪区域。不指定则返回全屏截图的分析结果'),
    ocr: z.boolean().default(true).describe('是否对截图执行 OCR 文本识别。默认 true')
});

interface OcrResult {
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
    confidence: number;
}

interface RegionAnalysis {
    y1: number;
    y2: number;
    avgBrightness: number;
    highlighted: boolean;
}

/**
 * Captures a device screenshot via `hdc shell snapshot_display`, downloads it,
 * and optionally performs OCR and pixel-level region analysis.
 *
 * This tool complements **snapshot** (which reads the accessibility tree) by
 * providing visual information that the accessibility tree does not expose —
 * for example, the option text inside a native `<select>` dropdown rendered
 * as an XComponent.
 */
export class ScreenshotTool extends BaseTool<typeof ScreenshotArgsSchema> {
    constructor() {
        super(
            'screenshot',
            '截取设备屏幕截图，可选执行 OCR 文本识别和区域亮度分析。' +
                '当 snapshot（无障碍树）无法获取界面文本时（如原生 select 弹窗、XComponent 渲染内容），' +
                '使用此工具获取屏幕上的可视文本及其坐标。' +
                '返回 OCR 文本列表（含坐标和置信度）和区域亮度分析（可识别高亮/选中行）。',
            ScreenshotArgsSchema
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof ScreenshotArgsSchema>): Promise<string> {
        let screenshotDir: string | undefined;
        try {
            const imgPath = await captureScreenshot();
            screenshotDir = dirname(imgPath);
            const result: Record<string, unknown> = {};

            if (args.region) {
                const { x1, y1, x2, y2 } = args.region;
                const regions = await analyzeRegionBrightness(imgPath, x1, y1, x2, y2);
                result.regions = regions;
                result.regionBounds = { x1, y1, x2, y2 };
            }

            if (args.ocr) {
                const ocrResults = await performOcr(imgPath, args.region);
                result.ocr = ocrResults;
            }

            return ok(result);
        } catch (err) {
            return fail(`Failed to capture screenshot: ${err}`);
        } finally {
            if (screenshotDir) {
                rmSync(screenshotDir, { recursive: true, force: true });
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Visual Assert tool
// ---------------------------------------------------------------------------

const VisualAssertArgsSchema = z.discriminatedUnion('mode', [
    z.object({
        mode: z.literal('diff'),
        baseline: z.string().describe('基线截图的本地文件路径（PNG 或 JPEG）'),
        threshold: z.number().min(0).max(1).default(0.1).describe('像素差异容差，0-1，默认 0.1'),
        outputDiff: z.boolean().default(false).describe('是否输出差异叠加图到临时文件'),
        region: z
            .object({
                x1: z.number().int().min(0).describe('对比区域左上角 X 坐标'),
                y1: z.number().int().min(0).describe('对比区域左上角 Y 坐标'),
                x2: z.number().int().min(0).describe('对比区域右下角 X 坐标'),
                y2: z.number().int().min(0).describe('对比区域右下角 Y 坐标')
            })
            .optional()
            .describe('可选，只对比指定区域')
    }),
    z.object({
        mode: z.literal('color'),
        samples: z
            .array(
                z.object({
                    x: z.number().int().min(0).describe('采样点 X 坐标'),
                    y: z.number().int().min(0).describe('采样点 Y 坐标'),
                    expected: z.string().optional().describe('期望的颜色值，如 "#1976d2"'),
                    tolerance: z.number().int().min(0).max(255).default(10).describe('RGB 通道匹配容差')
                })
            )
            .max(20)
            .describe('采样点列表，最多 20 个')
    }),
    z.object({
        mode: z.literal('theme'),
        expectedTheme: z.enum(['light', 'dark']).optional().describe('期望的主题')
    })
]);

interface DiffMetrics {
    diffPixels: number;
    totalPixels: number;
    diffPercent: number;
    passed: boolean;
    threshold: number;
    diffImagePath?: string;
}

interface ColorSample {
    x: number;
    y: number;
    r: number;
    g: number;
    b: number;
    hex: string;
    expected?: string;
    matched?: boolean;
}

export class VisualAssertTool extends BaseTool<typeof VisualAssertArgsSchema> {
    constructor() {
        super(
            'visualAssert',
            '视觉断言工具，支持三种模式：\n' +
                '- diff：截图与基线图片像素级对比，用于回归测试和布局变化检测\n' +
                '- color：采样指定坐标的 RGB 颜色值，用于验证主题色、按钮状态（disabled 灰化、active 高亮）\n' +
                '- theme：自动检测当前界面是浅色还是深色主题',
            VisualAssertArgsSchema
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof VisualAssertArgsSchema>): Promise<string> {
        let screenshotDir: string | undefined;
        try {
            const imgPath = await captureScreenshot();
            screenshotDir = dirname(imgPath);

            if (args.mode === 'diff') {
                const metrics = await performDiff(imgPath, args);
                return ok({
                    mode: 'diff',
                    ...metrics
                });
            }

            if (args.mode === 'color') {
                const results = await performColorSample(imgPath, args.samples);
                const allMatched = results.every((s) => s.matched !== false);
                return ok({
                    mode: 'color',
                    samples: results,
                    passed: allMatched
                });
            }

            // theme mode
            const themeResult = await detectTheme(imgPath);
            return ok({
                mode: 'theme',
                detected: themeResult.theme,
                overallBrightness: themeResult.overallBrightness,
                regionBrightnesses: themeResult.regionBrightnesses,
                passed: args.expectedTheme ? themeResult.theme === args.expectedTheme : undefined
            });
        } catch (err) {
            return fail(`visualAssert failed: ${err}`);
        } finally {
            if (screenshotDir) {
                rmSync(screenshotDir, { recursive: true, force: true });
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Visual Assert helpers
// ---------------------------------------------------------------------------

async function loadImageRaw(
    filePath: string,
    region?: { x1: number; y1: number; x2: number; y2: number }
): Promise<{ data: Buffer; width: number; height: number }> {
    const sharp = await loadSharp();
    if (!sharp) throw new Error('sharp is required for visualAssert. Install it with npm install sharp.');

    let pipeline = sharp(filePath).ensureAlpha();
    if (region) {
        pipeline = pipeline.extract({
            left: region.x1,
            top: region.y1,
            width: region.x2 - region.x1,
            height: region.y2 - region.y1
        });
    }
    const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
}

async function performDiff(
    screenshotPath: string,
    args: z.output<typeof VisualAssertArgsSchema> & { mode: 'diff' }
): Promise<DiffMetrics> {
    const pixelmatchModule = await import('pixelmatch').catch(() => null);
    const pixelmatch = pixelmatchModule?.default;
    if (!pixelmatch) {
        throw new Error('pixelmatch is required for visual diff. It should be a dependency of OpenDesk.');
    }

    const screenshot = await loadImageRaw(screenshotPath, args.region);
    const baseline = await loadImageRaw(args.baseline);

    // Resize baseline to match screenshot dimensions if needed
    let baselineData = baseline.data;
    if (baseline.width !== screenshot.width || baseline.height !== screenshot.height) {
        const sharp = await loadSharp();
        if (!sharp) throw new Error('sharp is required for image resizing.');

        const resized = await sharp(baselineData, {
            raw: { width: baseline.width, height: baseline.height, channels: 4 }
        })
            .resize(screenshot.width, screenshot.height, { fit: 'fill' })
            .raw()
            .toBuffer({ resolveWithObject: true });
        baselineData = resized.data;
    }

    const totalPixels = screenshot.width * screenshot.height;
    let diffImagePath: string | undefined;

    let diffOutput: Buffer | null = null;
    if (args.outputDiff) {
        diffOutput = Buffer.alloc(totalPixels * 4);
    }

    const diffPixels = pixelmatch(screenshot.data, baselineData, diffOutput, screenshot.width, screenshot.height, {
        threshold: args.threshold
    });

    if (args.outputDiff && diffOutput) {
        const tmpDir = mkdtempSync(join(tmpdir(), 'opendesk-visualdiff-'));
        diffImagePath = join(tmpDir, 'diff.png');
        const sharp = await loadSharp();
        if (sharp) {
            await sharp(diffOutput, {
                raw: { width: screenshot.width, height: screenshot.height, channels: 4 }
            })
                .png()
                .toFile(diffImagePath);
        }
    }

    const diffPercent = totalPixels > 0 ? (diffPixels / totalPixels) * 100 : 0;

    return {
        diffPixels,
        totalPixels,
        diffPercent: Math.round(diffPercent * 100) / 100,
        passed: diffPixels === 0,
        threshold: args.threshold,
        ...(diffImagePath ? { diffImagePath } : {})
    };
}

async function performColorSample(
    screenshotPath: string,
    samples: { x: number; y: number; expected?: string; tolerance: number }[]
): Promise<ColorSample[]> {
    const sharp = await loadSharp();
    if (!sharp) throw new Error('sharp is required for color sampling.');

    const { data, info } = await sharp(screenshotPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    return samples.map((sample) => {
        const idx = (sample.y * info.width + sample.x) * 4;
        const r = data[idx] ?? 0;
        const g = data[idx + 1] ?? 0;
        const b = data[idx + 2] ?? 0;
        const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;

        const result: ColorSample = { x: sample.x, y: sample.y, r, g, b, hex };

        if (sample.expected) {
            result.expected = sample.expected;
            const expHex = sample.expected.replace('#', '');
            const expR = parseInt(expHex.substring(0, 2), 16);
            const expG = parseInt(expHex.substring(2, 4), 16);
            const expB = parseInt(expHex.substring(4, 6), 16);
            result.matched =
                Math.abs(r - expR) <= sample.tolerance &&
                Math.abs(g - expG) <= sample.tolerance &&
                Math.abs(b - expB) <= sample.tolerance;
        }

        return result;
    });
}

async function detectTheme(imgPath: string): Promise<{
    theme: 'light' | 'dark';
    overallBrightness: number;
    regionBrightnesses: number[];
}> {
    const sharp = await loadSharp();
    if (!sharp) throw new Error('sharp is required for theme detection.');

    const metadata = await sharp(imgPath).metadata();
    if (!metadata.width || !metadata.height) {
        throw new Error('Unable to determine screenshot dimensions');
    }

    const { data } = await sharp(imgPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    // Sample a 3x3 grid of regions
    const cols = 3;
    const rows = 3;
    const regionW = Math.floor(metadata.width / cols);
    const regionH = Math.floor(metadata.height / rows);
    const regionBrightnesses: number[] = [];

    for (let gy = 0; gy < rows; gy++) {
        for (let gx = 0; gx < cols; gx++) {
            const startX = gx * regionW;
            const startY = gy * regionH;
            let total = 0;
            let count = 0;

            // Sample every 4th pixel within the region for performance
            for (let y = startY; y < startY + regionH && y < metadata.height; y += 4) {
                for (let x = startX; x < startX + regionW && x < metadata.width; x += 4) {
                    const idx = (y * metadata.width + x) * 4;
                    total += data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
                    count++;
                }
            }
            regionBrightnesses.push(count > 0 ? total / count : 0);
        }
    }

    const overallBrightness = regionBrightnesses.reduce((a, b) => a + b, 0) / regionBrightnesses.length;
    const theme = overallBrightness > 128 ? 'light' : 'dark';

    return {
        theme,
        overallBrightness: Math.round(overallBrightness * 10) / 10,
        regionBrightnesses: regionBrightnesses.map((b) => Math.round(b * 10) / 10)
    };
}

// ---------------------------------------------------------------------------
// Hover tool
// ---------------------------------------------------------------------------

const HoverArgsSchema = z.object({
    x: z.number().int().describe('悬停位置的 X 坐标'),
    y: z.number().int().describe('悬停位置的 Y 坐标'),
    duration: z.number().int().min(100).max(5000).default(800).describe('悬停保持时长（毫秒），默认 800ms'),
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取界面快照')
});

export class HoverTool extends BaseTool<typeof HoverArgsSchema> {
    constructor() {
        super(
            'hover',
            '在指定坐标模拟鼠标悬停（pointerenter / mouseover）。\n' +
                '采用三层降级策略：\n' +
                '1. 尝试 HDC 原生 mouseMove 命令\n' +
                '2. 降级为 WebView JavaScript 事件注入\n' +
                '3. 最后降级为 0 像素低速 drag 变通（不可靠）\n' +
                '工具返回实际生效的路径（method 字段），用于判断环境支持情况。',
            HoverArgsSchema
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof HoverArgsSchema>): Promise<string> {
        try {
            const result = await executeHover(args.x, args.y, args.duration);
            const withSnap = await withSnapshot(args.snapshot, { x: args.x, y: args.y, ...result });
            return ok(withSnap);
        } catch (err) {
            return fail(`hover(${args.x}, ${args.y}) failed: ${err}`);
        }
    }
}

async function executeHover(
    x: number,
    y: number,
    duration: number
): Promise<{ method: string; native: boolean; detail?: string }> {
    // Tier 1: HDC native mouseMove
    const mouseMoveMethods = [
        ['uitest', 'uiInput', 'mouseMove'],
        ['uitest', 'uiInput', 'touchMove'],
        ['uinput', 'mouse', 'move']
    ];

    for (const method of mouseMoveMethods) {
        try {
            await runHdc(['shell', ...method, String(x), String(y)], 5000);
            if (duration > 0) {
                await new Promise((resolve) => setTimeout(resolve, duration));
            }
            return { method: method.join(' '), native: true };
        } catch {
            // try next method
        }
    }

    // Tier 2: WebView JS injection via HDC shell
    try {
        const jsPayload = `
            (function() {
                var el = document.elementFromPoint(${x}, ${y});
                if (!el) return 'no-element';
                var opts = { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y}, pointerType: 'mouse' };
                el.dispatchEvent(new PointerEvent('pointerenter', opts));
                el.dispatchEvent(new PointerEvent('pointerover', opts));
                el.dispatchEvent(new MouseEvent('mouseenter', opts));
                el.dispatchEvent(new MouseEvent('mouseover', opts));
                return 'hover-dispatched';
            })();
        `;

        const result = await runHdc(
            ['shell', 'arkweb_exec_js', '-b', 'com.develop.opensource.ohpcd.opendesk', '-s', jsPayload],
            10000
        );
        if (duration > 0) {
            await new Promise((resolve) => setTimeout(resolve, duration));
        }
        return { method: 'webview-js-injection', native: false, detail: result };
    } catch {
        // fall through to tier 3
    }

    // Tier 3: 0-pixel drag workaround (unreliable)
    try {
        await runHdc(['shell', 'uitest', 'uiInput', 'drag', String(x), String(y), String(x), String(y), '1'], 10000);
        if (duration > 0) {
            await new Promise((resolve) => setTimeout(resolve, duration));
        }
        return {
            method: 'zero-pixel-drag',
            native: true,
            detail: 'Workaround: 0-pixel drag. May not trigger :hover CSS or mouseenter events.'
        };
    } catch (err) {
        throw new Error(`All hover methods exhausted. Last error: ${err}`);
    }
}

// ---------------------------------------------------------------------------
// Semantic element query tools
// ---------------------------------------------------------------------------

const FindElementArgsSchema = z.object({
    role: z.string().optional().describe('元素角色，如 "button"、"textbox"、"listitem"、"heading" 等'),
    name: z.string().optional().describe('元素显示名称，大小写不敏感的模糊匹配（包含即可）'),
    hint: z.string().optional().describe('元素的 hint 提示文本'),
    state: z
        .enum(['disabled', 'enabled', 'checked', 'selected'])
        .optional()
        .describe('过滤元素状态：disabled=禁用、enabled=启用、checked=已勾选、selected=已选中'),
    text: z
        .string()
        .optional()
        .describe(
            '搜索元素内的纯文本内容（- text: "..." 子节点），模糊匹配。' + '适合搜索"标题包含XX的listitem"等场景'
        ),
    ref: z.string().optional().describe('精确匹配元素的 ref 标识（如 "e5"），用于按引用查找'),
    limit: z.number().int().min(1).max(50).default(20).describe('最大返回数量，默认 20')
});

export class FindElementTool extends BaseTool<typeof FindElementArgsSchema> {
    constructor() {
        super(
            'findElement',
            '从最新快照中按条件查询元素。支持按 role、name、hint、state、text 组合过滤，' +
                '返回匹配元素的 ref、role、name、bounds、center 和状态标记。\n' +
                '所有条件是 AND 关系——只返回同时满足全部条件的元素。\n' +
                '返回的 ref 可直接用于 clickRef / getElementState 等后续操作。',
            FindElementArgsSchema
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof FindElementArgsSchema>): Promise<string> {
        try {
            const matches = findElementsInSnapshot(args.role, args.name, args.hint, args.state, args.text, args.ref);

            const limited = matches.slice(0, args.limit);

            return ok({
                count: limited.length,
                total: matches.length,
                ...(matches.length > args.limit ? { truncated: true, limit: args.limit } : {}),
                elements: limited.map((e) => ({
                    ref: e.ref,
                    role: e.role,
                    name: e.name,
                    bounds: e.bounds,
                    center: e.center,
                    disabled: e.disabled,
                    checked: e.checked,
                    selected: e.selected
                }))
            });
        } catch (err) {
            return fail(`findElement failed: ${err}`);
        }
    }
}

const GetElementStateArgsSchema = z.object({
    ref: z.string().describe('元素引用标识，如 "e5"。必须来自最新快照')
});

export class GetElementStateTool extends BaseTool<typeof GetElementStateArgsSchema> {
    constructor() {
        super(
            'getElementState',
            '获取指定 ref 元素的完整状态信息，包括 role、name、bounds、center 和 checked/disabled/selected 状态标记。\n' +
                'ref 必须来自最新快照——过期的 ref 会返回 not-found。',
            GetElementStateArgsSchema
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof GetElementStateArgsSchema>): Promise<string> {
        try {
            const matches = findElementsInSnapshot(undefined, undefined, undefined, undefined, undefined, args.ref);

            if (matches.length === 0) {
                // Check if the ref exists in any capture (not just latest)
                let existsInOlder = false;
                for (const [, capture] of snapshotCaptures) {
                    if (capture.targets.has(args.ref)) {
                        existsInOlder = true;
                        break;
                    }
                }
                if (existsInOlder) {
                    return ok({
                        found: false,
                        reason: `ref "${args.ref}" 存在于过期快照中。请重新执行 snapshot 获取最新引用。`
                    });
                }
                return ok({ found: false, reason: `ref "${args.ref}" 不在任何快照中。请先执行 snapshot。` });
            }

            const e = matches[0];
            return ok({
                found: true,
                ref: e.ref,
                role: e.role,
                name: e.name,
                bounds: e.bounds,
                center: e.center,
                disabled: e.disabled,
                checked: e.checked,
                selected: e.selected
            });
        } catch (err) {
            return fail(`getElementState failed: ${err}`);
        }
    }
}

/**
 * Takes a screenshot on the device, downloads it, and returns the local file path.
 */
async function captureScreenshot(): Promise<string> {
    const dumpOutput = await runHdc(['shell', 'snapshot_display', '/data/local/tmp/opendesk_screenshot.png'], 20000);
    const match = dumpOutput.match(/write to\s+(\S+)/);
    if (!match) throw new Error('Failed to capture screenshot: ' + dumpOutput);

    const devicePath = match[1].trim();
    const localDir = mkdtempSync(join(tmpdir(), 'opendesk-screenshot-'));
    const localPath = join(localDir, 'screenshot.jpg');
    try {
        await runHdc(['file', 'recv', devicePath, localPath], 10000);
        return localPath;
    } catch (err) {
        rmSync(localDir, { recursive: true, force: true });
        throw err;
    }
}

/**
 * Performs OCR on the screenshot image using Tesseract.
 * Returns text with bounding boxes scaled to device coordinates.
 */
async function performOcr(
    imgPath: string,
    region?: { x1: number; y1: number; x2: number; y2: number }
): Promise<OcrResult[]> {
    const sharp = await loadSharp();
    if (!sharp) {
        return [{ text: '(sharp not available)', x: 0, y: 0, width: 0, height: 0, confidence: 0 }];
    }

    const metadata = await sharp(imgPath).metadata();
    if (!metadata.width || !metadata.height) {
        throw new Error('Unable to determine screenshot dimensions');
    }

    const crop = region ?? { x1: 0, y1: 0, x2: metadata.width, y2: metadata.height };
    if (
        crop.x1 < 0 ||
        crop.y1 < 0 ||
        crop.x2 <= crop.x1 ||
        crop.y2 <= crop.y1 ||
        crop.x2 > metadata.width ||
        crop.y2 > metadata.height
    ) {
        throw new Error(
            `Invalid OCR region: [${crop.x1},${crop.y1}][${crop.x2},${crop.y2}], ` +
                `screenshot size is ${metadata.width}x${metadata.height}`
        );
    }

    const cropWidth = crop.x2 - crop.x1;
    const cropHeight = crop.y2 - crop.y1;
    const requestedScale = 2;
    let pipeline = sharp(imgPath);
    if (region) {
        pipeline = pipeline.extract({
            left: crop.x1,
            top: crop.y1,
            width: cropWidth,
            height: cropHeight
        });
    }

    // Derive coordinate scaling from the actual OCR image dimensions.
    const prepared = await pipeline
        .resize(cropWidth * requestedScale, cropHeight * requestedScale, { fit: 'fill' })
        .grayscale()
        .png()
        .toBuffer({ resolveWithObject: true });
    const scaleX = prepared.info.width / cropWidth;
    const scaleY = prepared.info.height / cropHeight;

    // Write buffer to temp file for Tesseract.
    const tmpDir = mkdtempSync(join(tmpdir(), 'opendesk-ocr-'));
    const tmpImg = join(tmpDir, 'ocr_input.png');
    const tmpOut = join(tmpDir, 'ocr_output');
    writeFileSync(tmpImg, prepared.data);

    try {
        // Try chi_sim+eng first, fall back to eng
        let lang = 'eng';
        try {
            const { stdout: langList } = await execFileAsync('tesseract', ['--list-langs'], {
                encoding: 'utf-8',
                timeout: 5000
            });
            if (langList.split(/\r?\n/).includes('chi_sim')) {
                lang = 'chi_sim+eng';
            }
        } catch {
            // tesseract not found or no chi_sim — continue with eng
        }

        await execFileAsync('tesseract', [tmpImg, tmpOut, '-l', lang, '--psm', '6', 'tsv'], {
            encoding: 'utf-8',
            timeout: 30000,
            maxBuffer: 10 * 1024 * 1024
        });

        const tsv = readFileSync(tmpOut + '.tsv', 'utf-8');
        const results: OcrResult[] = [];
        const offsetX = crop.x1;
        const offsetY = crop.y1;

        for (const line of tsv.split('\n').slice(1)) {
            const cols = line.split('\t');
            if (cols.length < 12) continue;
            const text = cols[11]?.trim();
            if (!text) continue;
            const conf = parseInt(cols[10], 10);
            if (conf <= 0) continue;
            // Map OCR-image coordinates back to absolute device coordinates.
            results.push({
                text,
                x: Math.round(parseInt(cols[6], 10) / scaleX) + offsetX,
                y: Math.round(parseInt(cols[7], 10) / scaleY) + offsetY,
                width: Math.round(parseInt(cols[8], 10) / scaleX),
                height: Math.round(parseInt(cols[9], 10) / scaleY),
                confidence: conf
            });
        }

        return results;
    } catch (err) {
        return [{ text: `(OCR failed: ${err})`, x: 0, y: 0, width: 0, height: 0, confidence: 0 }];
    } finally {
        try {
            rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            // ignore cleanup errors
        }
    }
}

/**
 * Analyzes the average brightness of horizontal strips within a region.
 * Returns a list of segments with brightness and whether they are highlighted (dark).
 * Useful for identifying selectable rows in native dropdowns.
 */
async function analyzeRegionBrightness(
    imgPath: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number
): Promise<RegionAnalysis[]> {
    const sharp = await loadSharp();
    if (!sharp) return [];

    const { data, info } = await sharp(imgPath)
        .extract({ left: x1, top: y1, width: x2 - x1, height: y2 - y1 })
        .raw()
        .toBuffer({ resolveWithObject: true });

    const channels = info.channels;
    const rowHeight = info.height;

    // Calculate average brightness per row
    const rowBrightness: number[] = [];
    for (let y = 0; y < rowHeight; y++) {
        let total = 0;
        for (let x = 0; x < info.width; x++) {
            const idx = (y * info.width + x) * channels;
            if (channels >= 3) {
                total += (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
            } else {
                total += data[idx];
            }
        }
        rowBrightness.push(total / info.width);
    }

    // Find brightness transitions to segment the region
    const BRIGHTNESS_THRESHOLD = 15;
    const segments: RegionAnalysis[] = [];
    let segStart = 0;

    for (let y = 1; y < rowBrightness.length; y++) {
        const diff = Math.abs(rowBrightness[y] - rowBrightness[y - 1]);
        if (diff > BRIGHTNESS_THRESHOLD) {
            const avg = rowBrightness.slice(segStart, y).reduce((a, b) => a + b, 0) / (y - segStart);
            // Only include segments with more than 3 rows (skip thin borders)
            if (y - segStart > 3) {
                segments.push({
                    y1: y1 + segStart,
                    y2: y1 + y - 1,
                    avgBrightness: Math.round(avg * 10) / 10,
                    highlighted: avg < 150
                });
            }
            segStart = y;
        }
    }
    // Last segment
    const avg = rowBrightness.slice(segStart).reduce((a, b) => a + b, 0) / (rowBrightness.length - segStart);
    if (rowBrightness.length - segStart > 3) {
        segments.push({
            y1: y1 + segStart,
            y2: y1 + rowBrightness.length - 1,
            avgBrightness: Math.round(avg * 10) / 10,
            highlighted: avg < 150
        });
    }

    return segments;
}

export function createUseHarmonyToolset(): BaseToolset {
    const toolset = new BaseToolset('use-harmony');
    toolset.addTool(new ListAppsTool());
    toolset.addTool(new OpenAppTool());
    toolset.addTool(new AppLifecycleTool());
    toolset.addTool(new StageFixtureTool());
    toolset.addTool(new ListWindowsTool());
    toolset.addTool(new SnapshotTool());
    toolset.addTool(new ScreenshotTool());
    toolset.addTool(new ClickRefTool());
    toolset.addTool(new SelectOptionTool());
    toolset.addTool(new HandlePermissionTool());
    toolset.addTool(new ChooseFileTool());
    toolset.addTool(new DropFixtureTool());
    toolset.addTool(new ClickTool());
    toolset.addTool(new DoubleClickTool());
    toolset.addTool(new DragTool());
    toolset.addTool(new LongClickTool());
    toolset.addTool(new ScrollTool());
    toolset.addTool(new ScrollToTool());
    toolset.addTool(new InputTool());
    toolset.addTool(new PressKeyTool());
    toolset.addTool(new GoBackTool());
    toolset.addTool(new GoForwardTool());
    toolset.addTool(new WaitForTool());
    toolset.addTool(new VisualAssertTool());
    toolset.addTool(new HoverTool());
    toolset.addTool(new FindElementTool());
    toolset.addTool(new GetElementStateTool());
    return toolset;
}
