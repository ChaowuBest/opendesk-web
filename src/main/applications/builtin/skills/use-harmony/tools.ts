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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { BaseTool, BaseToolset } from '../../../../aikernel/tool.js';

// ---------------------------------------------------------------------------
// hdc helpers (async)
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

async function runHdc(args: readonly string[], timeout = 15000): Promise<string> {
    const { stdout } = await execFileAsync('hdc', args, {
        encoding: 'utf-8',
        timeout,
        maxBuffer: 10 * 1024 * 1024
    });
    return stdout.trim();
}

function quoteRemoteShellArg(value: string): string {
    return "'" + value.replace(/'/g, "'\\''") + "'";
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

const TYPE_TO_ROLE: Record<string, string> = {
    button: 'button',
    Button: 'button',
    toggleButton: 'button',
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

function convertNode(node: LayoutNode, ctx: { refIdx: number }): AriaNode | string | null {
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

    if (attrs.clickable === 'true' && center) {
        ariaNode.ref = 'e' + ctx.refIdx++;
        ariaNode.center = center;
        if (bounds) {
            ariaNode.width = bounds.x2 - bounds.x1;
            ariaNode.height = bounds.y2 - bounds.y1;
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

function convertLayout(layout: LayoutNode, bundleFilter?: string): string {
    const ctx = { refIdx: 0 };
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

    return renderYamlNodes(ariaNodes);
}

async function takeSnapshot(bundleName?: string): Promise<string> {
    const layout = await dumpLayout(bundleName);
    return convertLayout(layout, bundleName);
}

/**
 * After an operation, optionally capture a snapshot and merge it into the result.
 * Waits 500ms for UI to settle, then fetches the aria tree.
 * Snapshot failure does not affect the original operation result.
 */
async function withSnapshot(doSnapshot: boolean, result: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!doSnapshot) return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
        const snapshot = await takeSnapshot();
        if (!snapshot.trim()) return result;
        return { ...result, snapshot };
    } catch {
        return result;
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

const OpenAppArgsSchema = z.object({
    bundleName: z
        .string()
        .regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/)
        .describe('要打开的应用的 bundleName，例如 com.develop.opensource.ohpcd.opendesk')
});

export class OpenAppTool extends BaseTool<typeof OpenAppArgsSchema> {
    constructor() {
        super('openApp', '通过 bundleName 打开指定应用。会自动查找应用的入口 Ability 并启动', OpenAppArgsSchema);
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof OpenAppArgsSchema>): Promise<string> {
        try {
            // Find entry ability name from bm dump output
            const dumpOutput = await runHdc(['shell', 'bm', 'dump', '-n', args.bundleName], 15000);
            const abilityMatches = [...dumpOutput.matchAll(/"name":\s*"(\w+Ability)"/g)];
            const abilityName =
                abilityMatches.find((m) => m[1] === 'EntryAbility')?.[1] || abilityMatches[0]?.[1] || 'EntryAbility';

            await runHdc(['shell', 'aa', 'start', '-a', abilityName, '-b', args.bundleName], 10000);
            return ok({ bundleName: args.bundleName, abilityName });
        } catch (err) {
            return fail(`Failed to open app ${args.bundleName}: ${err}`);
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
    bundleName: z
        .string()
        .regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/)
        .optional()
        .describe('只获取指定 bundleName 对应窗口的快照。不指定则获取所有窗口')
});

export class SnapshotTool extends BaseTool<typeof SnapshotArgsSchema> {
    constructor() {
        super(
            'snapshot',
            '获取设备当前界面的无障碍快照（aria tree），格式与 OpenDesk 浏览器快照兼容。' +
                '可交互元素会带有 [ref=eN x=<cx> y=<cy>] 标签，坐标可直接用于 click 工具',
            SnapshotArgsSchema
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof SnapshotArgsSchema>): Promise<string> {
        try {
            const yaml = await takeSnapshot(args.bundleName);

            if (!yaml.trim()) {
                return fail(
                    'No visible windows found. The device may be locked or the specified bundleName has no visible window.'
                );
            }

            return ok({ snapshot: yaml });
        } catch (err) {
            return fail(`Failed to capture snapshot: ${err}`);
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
        super('click', '在设备屏幕的指定坐标处执行点击操作', ClickArgsSchema);
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

// ========== scroll ==========

const ScrollArgsSchema = z.object({
    direction: z
        .enum(['up', 'down', 'left', 'right'])
        .describe(
            '滑动方向。up=向上滑动（查看下方内容），down=向下滑动（查看上方内容），left=向左滑动，right=向右滑动'
        ),
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取界面快照，默认 false')
});

export class ScrollTool extends BaseTool<typeof ScrollArgsSchema> {
    constructor() {
        super('scroll', '在设备屏幕上执行滑动操作，用于滚动页面内容', ScrollArgsSchema);
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof ScrollArgsSchema>): Promise<string> {
        // dircFling direction mapping: 0=left, 1=right, 2=up, 3=down
        const dirMap: Record<string, number> = { up: 2, down: 3, left: 0, right: 1 };
        const dir = dirMap[args.direction];

        try {
            await runHdc(['shell', 'uitest', 'uiInput', 'dircFling', String(dir)], 10000);
            const result = await withSnapshot(args.snapshot, { direction: args.direction });
            return ok(result);
        } catch (err) {
            return fail(`Failed to scroll ${args.direction}: ${err}`);
        }
    }
}

// HarmonyOS keycodes (from https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-keycode)
const KEYCODE_PASTE = 2622;
const KEYCODE_CTRL_LEFT = 2072;
const KEYCODE_ALT_LEFT = 2045;
const KEYCODE_SHIFT_LEFT = 2047;

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

// ========== input ==========

const InputArgsSchema = z.object({
    x: z.number().int().describe('输入框的 X 坐标'),
    y: z.number().int().describe('输入框的 Y 坐标'),
    text: z.string().describe('要输入的文本内容'),
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取界面快照，默认 false')
});

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

            // Click to focus the input
            await runHdc(['shell', 'uitest', 'uiInput', 'click', String(args.x), String(args.y)], 10000);
            await new Promise((resolve) => setTimeout(resolve, 300));

            if (hasNonAscii) {
                // uitest uiInput text doesn't support non-ASCII characters directly,
                // but it places the text into the clipboard. We then select all and
                // paste to replace everything (including the artifact char) with the
                // actual text.
                await runHdc(['shell', 'uitest', 'uiInput', 'text', quoteRemoteShellArg(args.text)], 10000);
                await runHdc(
                    ['shell', 'uitest', 'uiInput', 'keyEvent', String(KEYCODE_CTRL_LEFT), String(KEY_MAP.a)],
                    5000
                );
                await runHdc(['shell', 'uitest', 'uiInput', 'keyEvent', String(KEYCODE_PASTE)], 5000);
            } else {
                // ASCII: select all first to clear existing content, then type
                await runHdc(
                    ['shell', 'uitest', 'uiInput', 'keyEvent', String(KEYCODE_CTRL_LEFT), String(KEY_MAP.a)],
                    5000
                );
                await runHdc(['shell', 'uitest', 'uiInput', 'text', quoteRemoteShellArg(args.text)], 10000);
            }

            const result = await withSnapshot(args.snapshot, { x: args.x, y: args.y, text: args.text });
            return ok(result);
        } catch (err) {
            return fail(`Failed to input text: ${err}`);
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
                '按键名称参考 HarmonyOS 键值定义',
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

const WaitForArgsSchema = z.object({
    duration: z.number().int().min(100).max(30000).describe('等待时间（毫秒），范围 100-30000'),
    snapshot: z.boolean().default(false).describe('等待结束后是否自动获取界面快照，默认 false')
});

export class WaitForTool extends BaseTool<typeof WaitForArgsSchema> {
    constructor() {
        super('waitFor', '等待指定的时间（毫秒），用于等待页面加载、动画完成等场景', WaitForArgsSchema);
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof WaitForArgsSchema>): Promise<string> {
        await new Promise((resolve) => setTimeout(resolve, args.duration));
        const result = await withSnapshot(args.snapshot, { duration: args.duration });
        return ok(result);
    }
}

export function createUseHarmonyToolset(): BaseToolset {
    const toolset = new BaseToolset('use-harmony');
    toolset.addTool(new ListAppsTool());
    toolset.addTool(new OpenAppTool());
    toolset.addTool(new ListWindowsTool());
    toolset.addTool(new SnapshotTool());
    toolset.addTool(new ClickTool());
    toolset.addTool(new ScrollTool());
    toolset.addTool(new InputTool());
    toolset.addTool(new PressKeyTool());
    toolset.addTool(new GoBackTool());
    toolset.addTool(new GoForwardTool());
    toolset.addTool(new WaitForTool());
    return toolset;
}
