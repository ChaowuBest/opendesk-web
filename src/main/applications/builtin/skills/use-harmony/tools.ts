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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile as readFileAsync, stat as statAsync } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { BaseTool, BaseToolset } from '../../../../aikernel/tool.js';

// ---------------------------------------------------------------------------
// hdc helpers (async)
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

type JimpClass = (typeof import('jimp'))['Jimp'];

let jimpPromise: Promise<JimpClass | null> | undefined;

function loadJimp(): Promise<JimpClass | null> {
    jimpPromise ??= import('jimp').then((module) => module.Jimp ?? null).catch(() => null);
    return jimpPromise;
}

export async function runHdc(args: readonly string[], timeout = 15000, deviceId?: string): Promise<string> {
    const fullArgs = deviceId ? ['-t', deviceId, ...args] : args;
    try {
        const { stdout } = await execFileAsync('hdc', fullArgs, {
            encoding: 'utf-8',
            timeout,
            maxBuffer: 10 * 1024 * 1024
        });
        return stdout.trim();
    } catch (error) {
        if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error(
                'hdc not found on PATH. Install the HarmonyOS device connector and ensure `hdc list targets` works.'
            );
        }
        throw error;
    }
}

function ok(data: Record<string, unknown>): string {
    return JSON.stringify({ success: true, ...data });
}

function fail(error: string): string {
    return JSON.stringify({ success: false, error });
}

// ---------------------------------------------------------------------------
// Screen / lock state detection
// ---------------------------------------------------------------------------

export type ScreenState = 'locked' | 'on' | 'unknown';

/**
 * Queries the device screen / lock state via the PowerManagerService dump.
 * Used when no app window can be found, to tell "the device may be locked"
 * apart from "the target app has no visible window".
 *
 * The hidumper service id 3301 corresponds to PowerManagerService. Output
 * formats vary across HarmonyOS versions, so we match loosely on well-known
 * keywords and degrade to 'unknown' on any failure (command missing, device
 * unresponsive, etc.).
 */
export async function detectScreenState(deviceId?: string): Promise<{ state: ScreenState; detail?: string }> {
    let output: string;
    try {
        output = await runHdc(['shell', 'hidumper', '-s', '3301', '-a', '-a'], 10000, deviceId);
    } catch {
        return { state: 'unknown' };
    }
    // 单词边界避免误匹配 inactive / connection / office 等包含子串的无关文本
    const lockedKeywords =
        /(?:screen|display|power).{0,40}(?:\boff\b|关闭|灭|sleep|suspend)|keyguard|锁屏|已锁定|锁定时|isScreenOn\s*[:=]\s*false|screenOn\s*[:=]\s*false/i;
    const onKeywords =
        /(?:screen|display|power).{0,40}(?:\bon\b|亮|awake|wakeup)|isScreenOn\s*[:=]\s*true|screenOn\s*[:=]\s*true/i;
    if (lockedKeywords.test(output)) {
        const detail = output.match(/(?:screen|display|keyguard|isScreenOn|screenOn).{0,60}/i)?.[0]?.trim();
        return { state: 'locked', detail };
    }
    if (onKeywords.test(output)) {
        return { state: 'on' };
    }
    return { state: 'unknown' };
}

// ---------------------------------------------------------------------------
// Device ID & listApps cache (in-memory, not persisted)
// ---------------------------------------------------------------------------

export interface HdcDevice {
    id: string;
    status: string;
    type: string;
}

/** Thrown when device resolution fails (no device / unknown device id). */
export class DeviceResolutionError extends Error {}

/**
 * Queries connected devices via `hdc list targets -v`.
 *
 * Output rows look like:
 *   `127.0.0.1:5555  Connected  HarmonyOS Device`
 * Columns are whitespace separated (id / status / type). Rows without a
 * parseable id are skipped, so `[Empty]` naturally yields an empty list.
 */
export async function listDevices(): Promise<HdcDevice[]> {
    const output = await runHdc(['list', 'targets', '-v'], 5000);
    const devices: HdcDevice[] = [];
    for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === '[Empty]') continue;
        const parts = trimmed.split(/\s+/);
        const id = parts[0];
        if (!id || !/^[0-9a-zA-Z._:-]+$/.test(id)) continue;
        devices.push({
            id,
            status: parts[1] ?? 'unknown',
            type: parts.slice(2).join(' ') || 'unknown'
        });
    }
    return devices;
}

/**
 * Resolves the target device id for an hdc invocation.
 *
 * - No explicit id → exactly one Connected device, or an error when nothing is connected / more than one is connected.
 * - Explicit id → validated against the connected device list (unknown ids are rejected).
 */
export async function resolveDeviceId(explicitId?: string): Promise<string> {
    const devices = await listDevices();
    if (explicitId) {
        if (!devices.some((d) => d.id === explicitId)) {
            const available = devices.length > 0 ? devices.map((d) => d.id).join(', ') : 'none';
            throw new DeviceResolutionError(
                `Device '${explicitId}' not found or not connected. Available devices: ${available}`
            );
        }
        return explicitId;
    }
    const connected = devices.filter((d) => d.status === 'Connected');
    if (connected.length === 0) {
        throw new DeviceResolutionError('No connected device found. Run hdc list targets to check available devices.');
    }
    if (connected.length === 1) {
        return connected[0].id;
    }
    throw new DeviceResolutionError(
        `Multiple connected devices found: ${connected.map((d) => d.id).join(', ')}. ` +
            'Run listDevices and pass deviceId explicitly.'
    );
}

/**
 * Tool-body device resolution. Always resolve the active target so multi-device
 * setups fail fast unless the caller passes an explicit deviceId.
 */
async function tryResolveDeviceId(explicitId?: string): Promise<string | undefined> {
    return resolveDeviceId(explicitId);
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
    deviceId?: string;
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
const MAX_TEXT_LEN = 120;

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

    // Unwrap single-child generic passthrough: no ref, only one child (name/props are
    // rarely useful when the generic is just a wrapper around a single element).
    // This folds intermediate layout containers like Column/Row/Flex that happen
    // to carry a name but add no semantic value for the LLM.
    if (node.role === 'generic' && !node.ref && node.children.length === 1) {
        const singleChild = node.children[0];
        if (typeof singleChild !== 'string') {
            // Preserve the wrapper's name as a prefix on the child if the child has no name
            if (node.name && !singleChild.name) {
                singleChild.name = node.name;
            }
            return [singleChild];
        }
        // Single string child under a named generic — keep the wrapper as the label
        return [node];
    }

    return [node];
}

function indent(d: number): string {
    return '  '.repeat(d);
}

function yamlNeedsQuotes(str: string): boolean {
    if (!str.length) return true;
    if (/^\s|\s$/.test(str)) return true;
    // eslint-disable-next-line no-control-regex
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

async function dumpLayout(bundleName?: string, deviceId?: string): Promise<LayoutNode> {
    const args = bundleName ? ['shell', 'uitest', 'dumpLayout', '-b', bundleName] : ['shell', 'uitest', 'dumpLayout'];
    const dumpOutput = await runHdc(args, 20000, deviceId);
    const match = dumpOutput.match(/saved to:(\S+)/);
    if (!match) throw new Error('Failed to get layout file path from hdc');

    const devicePath = match[1].trim();
    const localDir = mkdtempSync(join(tmpdir(), 'opendesk-hdc-layout-'));
    const localPath = join(localDir, 'layout.json');
    try {
        await runHdc(['file', 'recv', devicePath, localPath], 10000, deviceId);
        return JSON.parse(readFileSync(localPath, 'utf-8'));
    } finally {
        rmSync(localDir, { recursive: true, force: true });
    }
}

const SNAPSHOT_TTL_MS = 5 * 60 * 1000;
let snapshotSequence = 0;
// Track the previous snapshot fingerprint per device for dedup detection.
// When a new snapshot has the same content, we return a short "unchanged"
// message instead of the full aria tree. Keyed by device so parallel devices
// never invalidate each other's dedup state.
interface PrevSnapshotState {
    fingerprint: string;
    id: string;
}
const prevSnapshotsByDevice = new Map<string, PrevSnapshotState>();
interface SnapshotCaptureEntry {
    createdAt: number;
    snapshot: string;
    fingerprint: string;
    targets: Map<string, SnapshotTarget>;
    bundleName?: string;
    deviceId?: string;
}
const snapshotCaptures = new Map<string, SnapshotCaptureEntry>();

function snapshotDeviceKey(deviceId?: string): string {
    return deviceId || 'default';
}

/** Returns the newest snapshot for the device (or the newest overall when no device is given). */
function getCurrentSnapshot(deviceId?: string): { snapshot: string; targets: Map<string, SnapshotTarget> } | undefined {
    let current: { snapshot: string; targets: Map<string, SnapshotTarget> } | undefined;
    let latestTime = 0;
    for (const capture of snapshotCaptures.values()) {
        if (deviceId && capture.deviceId !== deviceId) continue;
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

function registerSnapshot(built: BuiltSnapshot, deviceId?: string): SnapshotCapture {
    const snapshotId = `s${++snapshotSequence}`;
    // Refs describe a point-in-time layout. Only snapshots returned to the
    // caller are registered, so internal polling cannot invalidate live refs.
    // Device-isolated: concurrent devices keep their own latest capture.
    const deviceKey = snapshotDeviceKey(deviceId);
    for (const [id, capture] of snapshotCaptures) {
        if (snapshotDeviceKey(capture.deviceId) === deviceKey) snapshotCaptures.delete(id);
    }
    snapshotCaptures.set(snapshotId, {
        createdAt: Date.now(),
        snapshot: built.snapshot,
        fingerprint: built.fingerprint,
        targets: built.targets,
        bundleName: built.bundleName,
        deviceId
    });
    return {
        snapshot: built.snapshot,
        snapshotId,
        fingerprint: built.fingerprint,
        bundleName: built.bundleName,
        deviceId
    };
}

function convertLayout(layout: LayoutNode, bundleFilter?: string, deviceId?: string): SnapshotCapture {
    return registerSnapshot(buildSnapshot(layout, bundleFilter), deviceId);
}

async function takeSnapshot(bundleName?: string, deviceId?: string): Promise<SnapshotCapture> {
    const layout = await dumpLayout(bundleName, deviceId);
    return convertLayout(layout, bundleName, deviceId);
}

/**
 * After an operation, optionally capture a snapshot and merge it into the result.
 * Waits 500ms for UI to settle, then fetches the aria tree.
 * Snapshot failure does not affect the original operation result.
 */
async function withSnapshot(
    doSnapshot: boolean,
    result: Record<string, unknown>,
    bundleName?: string,
    deviceId?: string
): Promise<Record<string, unknown>> {
    if (!doSnapshot) return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
        const capture = await takeSnapshot(bundleName, deviceId);
        if (!capture.snapshot.trim()) {
            return {
                ...result,
                snapshotError: 'Snapshot was requested but returned no visible content'
            };
        }
        // Fingerprint dedup: identical content → short message (per device)
        const deviceKey = snapshotDeviceKey(deviceId);
        const prev = prevSnapshotsByDevice.get(deviceKey);
        if (prev && capture.fingerprint === prev.fingerprint) {
            return {
                ...result,
                snapshot: `（界面未变化，与 ${prev.id} 相同）`,
                snapshotId: capture.snapshotId,
                unchanged: true
            };
        }
        prevSnapshotsByDevice.set(deviceKey, { fingerprint: capture.fingerprint, id: capture.snapshotId });
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

/**
 * use-harmony 工具基类：对外暴露的参数 JSON Schema 中，带默认值的字段不应列为必填。
 *
 * zod 的 `.default(v)` 输入侧本就允许省略（省略时在运行时填充默认值），但 toJSONSchema
 * 仍会把这类字段写进 required 数组，导致 LLM 被 schema 误导为必填而补传可省略参数。
 * 这里在后处理时剔除 required 中带 default 的字段，运行时解析仍走原 schema，行为不变。
 */
class HarmonyBaseTool<T extends z.ZodType> extends BaseTool<T> {
    override toJSON() {
        const json = super.toJSON() as {
            name: string;
            description: string;
            params: { required?: string[]; properties?: Record<string, object> };
            agentIds?: readonly string[];
        };
        const { required, properties } = json.params;
        if (Array.isArray(required) && properties) {
            json.params.required = required.filter((key) => {
                const prop = properties[key];
                return !prop || !('default' in prop);
            });
        }
        return json;
    }
}

// ========== listDevices ==========

const ListDevicesArgsSchema = z.object({});

/**
 * Exposes the connected hdc devices to the agent so it can pick a target
 * device (or run against all of them) before invoking device-scoped tools.
 */
export class ListDevicesTool extends HarmonyBaseTool<typeof ListDevicesArgsSchema> {
    constructor() {
        super(
            'listDevices',
            '列出当前通过 hdc 连接的所有鸿蒙设备（设备 ID、连接状态、设备类型）。多台设备连接时先调用本工具确认目标设备，再把 deviceId 传给其他工具',
            ListDevicesArgsSchema,
            'tools.harmony.listDevices.name'
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(): Promise<string> {
        try {
            const devices = await listDevices();
            return ok({ devices, count: devices.length });
        } catch (err) {
            return fail(`Failed to list devices: ${err}`);
        }
    }
}

// ========== listApps ==========

const DeviceIdSchema = z
    .string()
    .optional()
    .describe('目标设备 ID（来自 listDevices）。多台设备连接时不传默认使用第一台 Connected 设备');

const ListAppsArgsSchema = z.object({
    deviceId: DeviceIdSchema
});

export class ListAppsTool extends HarmonyBaseTool<typeof ListAppsArgsSchema> {
    constructor() {
        super(
            'listApps',
            '获取设备上所有可从桌面/开始菜单打开的应用列表，返回每个应用的 bundleName 和显示名称。结果会按设备 ID 缓存在内存中，同一设备不会重复查询',
            ListAppsArgsSchema,
            'tools.harmony.listApps.name'
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof ListAppsArgsSchema>): Promise<string> {
        try {
            const deviceId = await tryResolveDeviceId(args.deviceId);
            // Cache key must be stable per device. tryResolveDeviceId returns
            // undefined without an explicit id, which would make every device
            // share one cache slot — fall back to a sentinel for that case.
            const cacheKey = deviceId ?? 'default';
            const cached = listAppsCache.get(cacheKey);
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
                '    # hideDesktopIcon 字段缺失（旧系统/不同 bm 输出格式）时默认展示应用，只有显式标记 hidden 才跳过',
                '      *true*) ;;',
                '      *) name=$(bm dump -n $pkg -l 2>/dev/null); echo "$pkg|$name" ;;',
                '    esac',
                '  ) &',
                '  if [ $((count % 10)) -eq 0 ]; then wait; fi',
                'done',
                'wait'
            ].join('\n');

            const localDir = mkdtempSync(join(tmpdir(), 'opendesk-hdc-listapps-'));
            const localScript = join(localDir, 'listapps.sh');
            let output: string;
            // 设备端脚本路径加 pid+ts 后缀，避免并发调用互相覆写
            const deviceScriptPath = `/data/local/tmp/hdc_listapps_${process.pid}_${Date.now()}.sh`;
            try {
                writeFileSync(localScript, script);
                await runHdc(['file', 'send', localScript, deviceScriptPath], 10000, deviceId);
                output = await runHdc(['shell', 'sh', deviceScriptPath], 120000, deviceId);
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

            listAppsCache.set(cacheKey, apps);
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
    .describe('应用的 bundleName（来自 listApps）。');

async function resolveEntryAbility(bundleName: string, deviceId?: string): Promise<string> {
    const dumpOutput = await runHdc(['shell', 'bm', 'dump', '-n', bundleName], 15000, deviceId);
    const abilityMatches = [...dumpOutput.matchAll(/"name":\s*"(\w+Ability)"/g)];
    return abilityMatches.find((match) => match[1] === 'EntryAbility')?.[1] || abilityMatches[0]?.[1] || 'EntryAbility';
}

async function startApp(bundleName: string, deviceId?: string): Promise<string> {
    const abilityName = await resolveEntryAbility(bundleName, deviceId);
    await runHdc(['shell', 'aa', 'start', '-a', abilityName, '-b', bundleName], 10000, deviceId);
    return abilityName;
}

const OpenAppArgsSchema = z.object({
    bundleName: BundleNameSchema,
    deviceId: DeviceIdSchema
});

export class OpenAppTool extends HarmonyBaseTool<typeof OpenAppArgsSchema> {
    constructor() {
        super(
            'openApp',
            '通过 bundleName 打开指定应用。会自动查找应用的入口 Ability 并启动',
            OpenAppArgsSchema,
            'tools.harmony.openApp.name'
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof OpenAppArgsSchema>): Promise<string> {
        try {
            const deviceId = await tryResolveDeviceId(args.deviceId);
            const abilityName = await startApp(args.bundleName, deviceId);
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
    snapshot: z.boolean().default(false).describe('应用重新启动后是否获取该应用的新快照，默认 false'),
    deviceId: DeviceIdSchema
});

export class AppLifecycleTool extends HarmonyBaseTool<typeof AppLifecycleArgsSchema> {
    constructor() {
        super(
            'appLifecycle',
            '控制应用测试生命周期：强制停止、冷重启、清除缓存或清除全部应用数据。' +
                'clearData 会删除应用本地数据，必须通过 confirmDestructive=true 显式确认。',
            AppLifecycleArgsSchema,
            'tools.harmony.appLifecycle.name'
        );
        this.serialExecution = true;
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof AppLifecycleArgsSchema>): Promise<string> {
        if (args.action === 'clearData' && !args.confirmDestructive) {
            return fail('clearData 会永久删除应用本地数据、账号和配置；请在确认目标后设置 confirmDestructive=true。');
        }

        try {
            const deviceId = await tryResolveDeviceId(args.deviceId);
            await runHdc(['shell', 'aa', 'force-stop', args.bundleName], 10000, deviceId);
            // Device-isolated: only drop snapshots of the affected device.
            const deviceKey = snapshotDeviceKey(deviceId);
            for (const [id, capture] of snapshotCaptures) {
                if (snapshotDeviceKey(capture.deviceId) === deviceKey) snapshotCaptures.delete(id);
            }

            const result: Record<string, unknown> = {
                bundleName: args.bundleName,
                action: args.action,
                stopped: true
            };

            if (args.action === 'clearCache') {
                await runHdc(['shell', 'bm', 'clean', '-n', args.bundleName, '-c'], 30000, deviceId);
                result.cacheCleared = true;
            } else if (args.action === 'clearData') {
                await runHdc(['shell', 'bm', 'clean', '-n', args.bundleName, '-d'], 30000, deviceId);
                result.dataCleared = true;
            }

            const shouldStart =
                args.action === 'restart' ||
                ((args.action === 'clearCache' || args.action === 'clearData') && args.relaunch);
            if (shouldStart) {
                result.abilityName = await startApp(args.bundleName, deviceId);
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
            return ok(await withSnapshot(args.snapshot, result, shouldStart ? args.bundleName : undefined, deviceId));
        } catch (err) {
            return fail(`应用生命周期操作失败（${args.action} ${args.bundleName}）：${err}`);
        }
    }
}

// ========== listWindows ==========

const ListWindowsArgsSchema = z.object({
    deviceId: DeviceIdSchema
});

export class ListWindowsTool extends HarmonyBaseTool<typeof ListWindowsArgsSchema> {
    constructor() {
        super(
            'listWindows',
            '获取设备当前所有窗口列表，返回每个窗口的 bundleName、abilityName 和边界范围',
            ListWindowsArgsSchema,
            'tools.harmony.listWindows.name'
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof ListWindowsArgsSchema>): Promise<string> {
        try {
            const deviceId = await tryResolveDeviceId(args.deviceId);
            const layout = await dumpLayout(undefined, deviceId);
            const windows = findAllWindows(layout);
            if (windows.length === 0) {
                const screen = await detectScreenState(deviceId);
                if (screen.state === 'locked') {
                    return ok({
                        windows,
                        count: 0,
                        screenLocked: true,
                        hint: '设备可能处于锁屏或熄屏状态，无可见窗口。请先点亮并解锁设备后重试。'
                    });
                }
            }
            return ok({ windows, count: windows.length });
        } catch (err) {
            return fail(`Failed to list windows: ${err}`);
        }
    }
}

// ========== snapshot ==========

const SnapshotArgsSchema = z.object({
    bundleName: BundleNameSchema.optional().describe('只获取指定 bundleName 对应窗口的快照。不指定则获取所有窗口'),
    deviceId: DeviceIdSchema
});

export class SnapshotTool extends HarmonyBaseTool<typeof SnapshotArgsSchema> {
    constructor() {
        super(
            'snapshot',
            '获取设备当前界面的无障碍快照（aria tree）。' +
                '可交互元素会带有 [ref=eN x=<cx> y=<cy>] 标签；每次快照都会刷新 ref，结果中的 snapshotId 可与 ref 一起用于 clickRef',
            SnapshotArgsSchema,
            'tools.harmony.snapshot.name'
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof SnapshotArgsSchema>): Promise<string> {
        try {
            const deviceId = await tryResolveDeviceId(args.deviceId);
            const capture = await takeSnapshot(args.bundleName, deviceId);

            if (!capture.snapshot.trim()) {
                const screen = await detectScreenState(deviceId);
                if (screen.state === 'locked') {
                    return fail(
                        `No visible windows found. The device appears to be locked or the screen is off` +
                            `（设备可能处于锁屏/熄屏状态，请先点亮并解锁设备后重试）` +
                            (screen.detail ? `; PowerManager dump: ${screen.detail}` : '') +
                            `.`
                    );
                }
                return fail(
                    'No visible windows found. The device may be locked or the specified bundleName has no visible window.'
                );
            }

            // Fingerprint dedup: if the content is identical to the previous
            // snapshot (per device), return a short "unchanged" message instead
            // of the full aria tree.  The old refs remain valid because the
            // layout is the same.
            const deviceKey = snapshotDeviceKey(deviceId);
            const prev = prevSnapshotsByDevice.get(deviceKey);
            if (prev && capture.fingerprint === prev.fingerprint) {
                return ok({
                    snapshotId: capture.snapshotId,
                    snapshot: `（界面未变化，与 ${prev.id} 相同）`,
                    unchanged: true
                });
            }
            prevSnapshotsByDevice.set(deviceKey, { fingerprint: capture.fingerprint, id: capture.snapshotId });

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
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取相同应用的界面快照，默认 false'),
    deviceId: DeviceIdSchema
});

function pointForTarget(target: SnapshotTarget, position: z.output<typeof ClickRefArgsSchema>['position']) {
    const { x1, y1, x2, y2 } = target.bounds;
    const width = x2 - x1;
    const y = Math.round((y1 + y2) / 2);
    if (position === 'left-center') return { x: x1 + Math.max(1, Math.round(width * 0.3)), y };
    if (position === 'right-center') return { x: x2 - Math.max(1, Math.round(width * 0.3)), y };
    return { x: Math.round((x1 + x2) / 2), y };
}

export class ClickRefTool extends HarmonyBaseTool<typeof ClickRefArgsSchema> {
    constructor() {
        super(
            'clickRef',
            '按最近一次 snapshot 返回的元素 ref 点击。每次成功快照都会刷新 ref，并使旧 ref 失效；发送按钮应使用 position="left-center"。',
            ClickRefArgsSchema,
            'tools.harmony.clickRef.name'
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof ClickRefArgsSchema>): Promise<string> {
        pruneSnapshotCaptures();
        const deviceId = await tryResolveDeviceId(args.deviceId);
        const capture = snapshotCaptures.get(args.snapshotId);
        // Reject refs that belong to a different device than the one targeted.
        if (
            capture &&
            deviceId &&
            capture.deviceId &&
            snapshotDeviceKey(capture.deviceId) !== snapshotDeviceKey(deviceId)
        ) {
            return fail(
                `快照 ${args.snapshotId} 属于设备 ${capture.deviceId}，与目标设备 ${deviceId} 不一致。` +
                    `请在目标设备 ${deviceId} 上重新获取快照后再点击（或指定正确的 deviceId）。`
            );
        }
        const target = capture?.targets.get(args.ref);
        if (!target) {
            return fail(`快照引用不存在或已失效：${args.snapshotId}/${args.ref}。请重新获取快照后再点击。`);
        }

        const point = pointForTarget(target, args.position);
        try {
            await runHdc(['shell', 'uitest', 'uiInput', 'click', String(point.x), String(point.y)], 10000, deviceId);
            const result = await withSnapshot(
                args.snapshot,
                {
                    snapshotId: args.snapshotId,
                    ref: args.ref,
                    position: args.position,
                    x: point.x,
                    y: point.y
                },
                target.bundleName,
                deviceId
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
    maxAttempts: z.number().int().min(1).max(3).default(2).describe('找不到选项时的最大重试次数，默认 2'),
    deviceId: DeviceIdSchema
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

function findSelectedOptionInSnapshot(
    trigger: ElementMatch,
    option: string,
    match: 'exact' | 'contains',
    deviceId?: string
): boolean {
    const current = getCurrentSnapshot(deviceId);
    if (!current) return false;
    const elements = findElementsInSnapshot(undefined, undefined, undefined, undefined, undefined, undefined, deviceId);
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

async function chooseOptionWithOcr(
    trigger: ElementMatch,
    option: string,
    match: 'exact' | 'contains',
    deviceId?: string
) {
    const screenshotPath = await captureScreenshot(deviceId);
    const screenshotDir = dirname(screenshotPath);
    try {
        const Jimp = await loadJimp();
        if (!Jimp) return null;
        const img = await Jimp.read(screenshotPath);
        const width = img.bitmap.width;
        const height = img.bitmap.height;
        if (!width || !height) return null;
        const triggerWidth = trigger.bounds.x2 - trigger.bounds.x1;
        const region = {
            x1: Math.max(0, trigger.bounds.x1 - Math.max(120, triggerWidth)),
            y1: 0,
            x2: Math.min(width, trigger.bounds.x2 + Math.max(240, triggerWidth)),
            y2: height
        };
        return chooseOcrOptionMatch(await performOcr(screenshotPath, region), option, match);
    } finally {
        rmSync(screenshotDir, { recursive: true, force: true });
    }
}

export class SelectOptionTool extends HarmonyBaseTool<typeof SelectOptionArgsSchema> {
    constructor() {
        super(
            'selectOption',
            '稳定操作下拉框：重新获取快照，展开触发器，优先按无障碍文本选择选项，必要时用局部 OCR 兜底，并验证选择结果。',
            SelectOptionArgsSchema,
            'tools.harmony.selectOption.name'
        );
        this.serialExecution = true;
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof SelectOptionArgsSchema>): Promise<string> {
        let lastReason = '未找到下拉选项';
        try {
            const deviceId = await tryResolveDeviceId(args.deviceId);
            for (let attempt = 1; attempt <= args.maxAttempts; attempt++) {
                const before = await takeSnapshot(args.bundleName, deviceId);
                const triggers = findElementsInSnapshot(
                    args.trigger.role,
                    args.trigger.name,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    deviceId
                );
                const trigger = triggers[0];
                if (!trigger) {
                    lastReason = `未找到下拉触发器：${args.trigger.name}`;
                    continue;
                }

                await runHdc(
                    ['shell', 'uitest', 'uiInput', 'click', String(trigger.center.x), String(trigger.center.y)],
                    10000,
                    deviceId
                );
                await new Promise((resolve) => setTimeout(resolve, 350));
                const opened = await takeSnapshot(undefined, deviceId);
                const option = chooseOptionMatch(
                    findElementsInSnapshot(undefined, undefined, undefined, undefined, undefined, undefined, deviceId),
                    args.option,
                    args.match
                );
                let strategy: 'accessibility' | 'ocr' = 'accessibility';
                let clickPoint: { x: number; y: number } | null = option?.center ?? null;
                if (!clickPoint) {
                    const ocrMatch = await chooseOptionWithOcr(trigger, args.option, args.match, deviceId);
                    if (ocrMatch) {
                        strategy = 'ocr';
                        clickPoint = { x: ocrMatch.x, y: ocrMatch.y };
                    }
                }
                if (!clickPoint) {
                    lastReason = `下拉框已展开，但未找到选项：${args.option}`;
                    if (attempt < args.maxAttempts) {
                        await runHdc(
                            ['shell', 'uitest', 'uiInput', 'keyEvent', String(KEY_MAP.Escape)],
                            5000,
                            deviceId
                        ).catch(() => {});
                    }
                    continue;
                }

                await runHdc(
                    ['shell', 'uitest', 'uiInput', 'click', String(clickPoint.x), String(clickPoint.y)],
                    10000,
                    deviceId
                );
                await new Promise((resolve) => setTimeout(resolve, 350));
                const after = await takeSnapshot(args.bundleName, deviceId);
                const verified =
                    !args.verify || findSelectedOptionInSnapshot(trigger, args.option, args.match, deviceId);
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
    snapshot: z.boolean().default(true).describe('完成点击后是否获取新快照，默认 true'),
    deviceId: DeviceIdSchema
});

export class HandlePermissionTool extends HarmonyBaseTool<typeof HandlePermissionArgsSchema> {
    constructor() {
        super(
            'handlePermission',
            '检测当前系统权限确认框，并按明确指定的方式处理。不会自动授予权限；仅识别带标准“允许/仅此一次/拒绝”按钮的权限对话框。',
            HandlePermissionArgsSchema,
            'tools.harmony.handlePermission.name'
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof HandlePermissionArgsSchema>): Promise<string> {
        try {
            const deviceId = await tryResolveDeviceId(args.deviceId);
            const layout = await dumpLayout(undefined, deviceId);
            const capture = convertLayout(layout, undefined, deviceId);
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
            await runHdc(['shell', 'uitest', 'uiInput', 'click', String(point.x), String(point.y)], 10000, deviceId);
            const result = await withSnapshot(
                args.snapshot,
                {
                    detected: true,
                    action: selected.action,
                    label: selected.label,
                    x: point.x,
                    y: point.y
                },
                undefined,
                deviceId
            );
            return ok(result);
        } catch (err) {
            return fail(`处理权限确认框失败：${err}`);
        }
    }
}

// ========== click ==========

const ClickArgsSchema = z.object({
    x: z.number().int().min(0).describe('点击的 X 坐标'),
    y: z.number().int().min(0).describe('点击的 Y 坐标'),
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取界面快照，默认 false'),
    deviceId: DeviceIdSchema
});

export class ClickTool extends HarmonyBaseTool<typeof ClickArgsSchema> {
    constructor() {
        super(
            'click',
            '在设备屏幕的指定坐标处执行点击操作。若按钮旁边有下拉箭头/选项按钮，建议点击按钮左侧区域',
            ClickArgsSchema,
            'tools.harmony.click.name'
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof ClickArgsSchema>): Promise<string> {
        try {
            const deviceId = await tryResolveDeviceId(args.deviceId);
            await runHdc(['shell', 'uitest', 'uiInput', 'click', String(args.x), String(args.y)], 10000, deviceId);
            const result = await withSnapshot(args.snapshot, { x: args.x, y: args.y }, undefined, deviceId);
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
    result: Record<string, unknown>,
    deviceId?: string
): Promise<string> {
    try {
        await runHdc(['shell', 'uitest', 'uiInput', command, ...commandArgs], 10000, deviceId);
        return ok(await withSnapshot(snapshot, { gesture, native: true, ...result }, undefined, deviceId));
    } catch (err) {
        return fail(`设备不支持原生 ${gesture} 手势，或 uiInput 命令执行失败：${err}`);
    }
}

const DoubleClickArgsSchema = z.object({
    x: z.number().int().min(0).describe('双击位置的 X 坐标'),
    y: z.number().int().min(0).describe('双击位置的 Y 坐标'),
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取界面快照，默认 false'),
    deviceId: DeviceIdSchema
});

export class DoubleClickTool extends HarmonyBaseTool<typeof DoubleClickArgsSchema> {
    constructor() {
        super(
            'doubleClick',
            '在指定坐标执行原生双击。不支持该手势的设备会明确返回失败，不会降级为两次普通点击。',
            DoubleClickArgsSchema,
            'tools.harmony.doubleClick.name'
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof DoubleClickArgsSchema>): Promise<string> {
        const deviceId = await tryResolveDeviceId(args.deviceId);
        return runPointerGesture(
            'doubleClick',
            'doubleClick',
            [String(args.x), String(args.y)],
            args.snapshot,
            {
                x: args.x,
                y: args.y
            },
            deviceId
        );
    }
}

const DragArgsSchema = z.object({
    fromX: z.number().int().min(0).describe('拖动起点的 X 坐标'),
    fromY: z.number().int().min(0).describe('拖动起点的 Y 坐标'),
    toX: z.number().int().min(0).describe('拖动终点的 X 坐标'),
    toY: z.number().int().min(0).describe('拖动终点的 Y 坐标'),
    speed: z.number().int().min(200).max(40000).default(600).describe('拖动速度，单位为像素/秒，默认 600'),
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取界面快照，默认 false'),
    deviceId: DeviceIdSchema
});

export class DragTool extends HarmonyBaseTool<typeof DragArgsSchema> {
    constructor() {
        super(
            'drag',
            '从起点连续拖动到终点，使用原生按下、移动、抬起手势；不会以两次点击或 fling 降级。',
            DragArgsSchema,
            'tools.harmony.drag.name'
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof DragArgsSchema>): Promise<string> {
        const deviceId = await tryResolveDeviceId(args.deviceId);
        return runPointerGesture(
            'drag',
            'drag',
            [String(args.fromX), String(args.fromY), String(args.toX), String(args.toY), String(args.speed)],
            args.snapshot,
            { fromX: args.fromX, fromY: args.fromY, toX: args.toX, toY: args.toY, speed: args.speed },
            deviceId
        );
    }
}

const LongClickArgsSchema = z.object({
    x: z.number().int().min(0).describe('长按位置的 X 坐标'),
    y: z.number().int().min(0).describe('长按位置的 Y 坐标'),
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取界面快照，默认 false'),
    deviceId: DeviceIdSchema
});

export class LongClickTool extends HarmonyBaseTool<typeof LongClickArgsSchema> {
    constructor() {
        super(
            'longClick',
            '在指定坐标执行原生长按。部分 HarmonyOS WebView 可能将长按转换为 contextmenu；' +
                '此工具只保证发送 longClick，不声称等价于鼠标右键。',
            LongClickArgsSchema,
            'tools.harmony.longClick.name'
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof LongClickArgsSchema>): Promise<string> {
        const deviceId = await tryResolveDeviceId(args.deviceId);
        return runPointerGesture(
            'longClick',
            'longClick',
            [String(args.x), String(args.y)],
            args.snapshot,
            {
                x: args.x,
                y: args.y
            },
            deviceId
        );
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
    distance?: number,
    deviceId?: string
): Promise<ScrollGestureResult> {
    if (!region) {
        const dirMap: Record<ScrollDirection, number> = { up: 2, down: 3, left: 0, right: 1 };
        await runHdc(['shell', 'uitest', 'uiInput', 'dircFling', String(dirMap[direction])], 10000, deviceId);
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
        10000,
        deviceId
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
            x: z.number().int().min(0).describe('滑动区域中心 X 坐标'),
            y: z.number().int().min(0).describe('滑动区域中心 Y 坐标'),
            width: z.number().int().min(0).describe('滑动区域宽度'),
            height: z.number().int().min(0).describe('滑动区域高度')
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
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取界面快照，默认 false'),
    deviceId: DeviceIdSchema
});

export class ScrollTool extends HarmonyBaseTool<typeof ScrollArgsSchema> {
    constructor() {
        super(
            'scroll',
            '在设备屏幕上执行滑动操作，支持全屏滚动、区域滚动和按元素定位滚动',
            ScrollArgsSchema,
            'tools.harmony.scroll.name'
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof ScrollArgsSchema>): Promise<string> {
        try {
            const deviceId = await tryResolveDeviceId(args.deviceId);
            // Resolve scroll region
            let effectiveRegion: { x: number; y: number; width: number; height: number } | undefined = args.region;

            if (args.scrollByContainer) {
                const resolved = resolveContainerFromSnapshot(
                    args.scrollByContainer.role,
                    args.scrollByContainer.name,
                    deviceId
                );
                if (!resolved) {
                    // Auto-take a snapshot to resolve container
                    const capture = await takeSnapshot(undefined, deviceId);
                    if (capture.snapshotId) {
                        const retry = resolveContainerFromSnapshot(
                            args.scrollByContainer.role,
                            args.scrollByContainer.name,
                            deviceId
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

            const gesture = await performScrollGesture(args.direction, effectiveRegion, args.distance, deviceId);
            return ok(
                await withSnapshot(args.snapshot, { direction: args.direction, ...gesture }, undefined, deviceId)
            );
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

function parseSnapshotElements(snapshotText: string, deviceId?: string): ParsedSnapshotLine[] {
    const results: ParsedSnapshotLine[] = [];
    // Match elements with ref. Name is optional (elements can be `- button [ref=e5 ...]`).
    // State attributes like [checked], [disabled], [selected] may appear before [ref=...].
    // e.g. `- generic "显示隐藏文件" [checked] [ref=e54 x=1976 y=912]`
    const re =
        /^(\s*)- (\w+)(?:\s+"([^"]*)")?\s*((?:\[(?:checked|disabled|selected)\]\s*)*)\[ref=(e\d+)\s+x=(\d+)\s+y=(\d+)\]([^\n]*)$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(snapshotText)) !== null) {
        const prefix = m[4] || '';
        const suffix = m[8] || '';
        const combined = prefix + suffix;
        const ref = m[5];
        const x = parseInt(m[6], 10);
        const y = parseInt(m[7], 10);
        // Recover width/height from the in-memory snapshot targets when available
        const currentSnapshot = getCurrentSnapshot(deviceId);
        const target = currentSnapshot?.targets.get(ref);
        const width = target ? target.bounds.x2 - target.bounds.x1 : 0;
        const height = target ? target.bounds.y2 - target.bounds.y1 : 0;
        results.push({
            role: m[2],
            name: m[3] || '',
            ref,
            x,
            y,
            width,
            height,
            disabled: combined.includes('[disabled]'),
            checked: combined.includes('[checked]'),
            selected: combined.includes('[selected]')
        });
    }
    return results;
}

function resolveContainerFromSnapshot(
    role: string,
    name?: string,
    deviceId?: string
): { x: number; y: number; width: number; height: number } | null {
    const currentSnapshot = getCurrentSnapshot(deviceId);
    if (!currentSnapshot) return null;

    // Parse snapshot text to find matching container
    const elements = parseSnapshotElements(currentSnapshot.snapshot, deviceId);
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
    ref?: string,
    deviceId?: string
): ElementMatch[] {
    const currentSnapshot = getCurrentSnapshot(deviceId);
    if (!currentSnapshot) return [];

    const elements = parseSnapshotElements(currentSnapshot.snapshot, deviceId);

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
    direction: z
        .enum(['up', 'down'])
        .optional()
        .describe('滚动方向。不指定时默认向上滑动（查看下方内容）；需要反向查找上方内容时显式传 down'),
    maxScrolls: z.number().int().min(1).max(20).default(5).describe('最大滚动尝试次数，超过后认为目标不可达，默认 5'),
    scrollDistance: z.number().int().min(50).default(300).describe('每次滚动的距离（像素），默认 300'),
    snapshot: z.boolean().default(true).describe('滚动完成后是否获取界面快照，默认 true'),
    deviceId: DeviceIdSchema
});

export class ScrollToTool extends HarmonyBaseTool<typeof ScrollToArgsSchema> {
    constructor() {
        super(
            'scrollTo',
            '滚动页面直到指定元素可见（scrollIntoView 语义）。\n' +
                '从最新快照中按 role/name/hint 搜索目标元素；未找到时按指定方向滚动指定距离后重新获取快照并搜索，\n' +
                '重复直到目标出现或达到最大尝试次数。返回最终快照和滚动次数。',
            ScrollToArgsSchema,
            'tools.harmony.scrollTo.name'
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof ScrollToArgsSchema>): Promise<string> {
        try {
            const deviceId = await tryResolveDeviceId(args.deviceId);
            // 未指定 direction 时默认向上滑动（查看下方内容）。目标不在视口时不会出现在
            // 无障碍树中，无法可靠地自动推断它在上方还是下方，因此不做虚假的"自动判断"，
            // 需要反向查找时由调用方显式传 direction。
            const direction: 'up' | 'down' = args.direction ?? 'up';
            // Check if target is already visible in latest snapshot
            let found = findElementsInSnapshot(
                args.targetRole,
                args.targetName,
                args.targetHint,
                undefined,
                undefined,
                undefined,
                deviceId
            );
            if (found.length > 0) {
                const withSnap = await withSnapshot(
                    args.snapshot,
                    {
                        direction,
                        scrollsUsed: 0,
                        targetFound: true,
                        elements: found.map((e) => ({
                            ref: e.ref,
                            role: e.role,
                            name: e.name,
                            bounds: e.bounds
                        }))
                    },
                    undefined,
                    deviceId
                );
                return ok(withSnap);
            }

            // Resolve container region if specified
            let containerRegion: { x: number; y: number; width: number; height: number } | undefined;
            if (args.containerRole) {
                const resolved = resolveContainerFromSnapshot(args.containerRole, args.containerName, deviceId);
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
                await performScrollGesture(direction, containerRegion, args.scrollDistance, deviceId);

                // Wait for scroll animation and take new snapshot
                await new Promise((resolve) => setTimeout(resolve, 500));
                await takeSnapshot(undefined, deviceId);

                // Check if target is now visible
                found = findElementsInSnapshot(
                    args.targetRole,
                    args.targetName,
                    args.targetHint,
                    undefined,
                    undefined,
                    undefined,
                    deviceId
                );
                if (found.length > 0) {
                    const withSnap = await withSnapshot(
                        args.snapshot,
                        {
                            direction,
                            scrollsUsed: i,
                            targetFound: true,
                            elements: found.map((e) => ({
                                ref: e.ref,
                                role: e.role,
                                name: e.name,
                                bounds: e.bounds
                            }))
                        },
                        undefined,
                        deviceId
                    );
                    return ok(withSnap);
                }
            }

            // Max scrolls reached, target not found
            const withSnap = await withSnapshot(
                args.snapshot,
                {
                    direction,
                    scrollsUsed: args.maxScrolls,
                    targetFound: false,
                    message:
                        `未找到目标元素 role="${args.targetRole}"` +
                        (args.targetName ? ` name≈"${args.targetName}"` : '') +
                        `，已尝试 ${args.maxScrolls} 次滚动`
                },
                undefined,
                deviceId
            );
            return ok(withSnap);
        } catch (err) {
            return fail(`scrollTo failed: ${err}`);
        }
    }
}

// ========== scrollInScrollable (virtual-scroll pickers) ==========

/**
 * Resolves the "real" screen bounds of a target inside a virtual-scroll list.
 *
 * Web time/date pickers report button bounds as content coordinates (the full
 * virtual list with scroll offset applied), which do NOT match the actual
 * rendered position. Clicking such a coordinate lands on the picker overlay and
 * closes the popup without changing the value. The reliable answer is the
 * scrolling container's viewport bounds: an item is only clickable once its
 * bounds overlap the container viewport. This helper locates the container and
 * the target, and tells whether the target is inside the viewport.
 */

interface RawBounds {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

function parseRawBounds(bounds: string | undefined): RawBounds | undefined {
    if (!bounds) return undefined;
    const m = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!m) return undefined;
    return { x1: Number(m[1]), y1: Number(m[2]), x2: Number(m[3]), y2: Number(m[4]) };
}

function walkLayoutNodes(node: LayoutNode, predicate: (node: LayoutNode) => boolean): LayoutNode[] {
    const found: LayoutNode[] = [];
    if (predicate(node)) found.push(node);
    for (const child of node.children) found.push(...walkLayoutNodes(child, predicate));
    return found;
}

const MIN_USABLE_SCROLLABLE_DIMENSION = 20;

/**
 * Picks the scroll container that should be scrolled to reveal `targetBounds`.
 * Real WebView dumps (time pickers, etc.) contain many
 * `scrollable=true` genericContainers including degenerate ones (1px-wide outer
 * wrappers) and siblings of a two-column picker (hour/minute). We filter out
 * zero-width/zero-height containers and, when the target's x is known, pick the
 * column whose center is closest to it so sibling columns with identical option
 * text (both have "00"/"09") resolve to the right list.
 */
function findScrollableContainer(
    layout: LayoutNode,
    containerRole?: string,
    containerName?: string,
    targetX?: number
): { node: LayoutNode; bounds: RawBounds } | undefined {
    const role = containerRole || 'genericContainer';
    const candidates = walkLayoutNodes(layout, (n) => n.attributes.type === role && n.attributes.scrollable === 'true');
    const usable: Array<{ node: LayoutNode; bounds: RawBounds }> = [];
    for (const node of candidates) {
        if (containerName) {
            const text = node.attributes.text || node.attributes.originalText || '';
            if (!text.includes(containerName)) continue;
        }
        const bounds = parseRawBounds(node.attributes.bounds);
        if (!bounds) continue;
        const width = bounds.x2 - bounds.x1;
        const height = bounds.y2 - bounds.y1;
        // Zero-width/height degenerate containers (e.g. 1px outer wrappers) cannot
        // host a scrollable column; skipping them avoids scrolling in thin air.
        if (width < MIN_USABLE_SCROLLABLE_DIMENSION || height < MIN_USABLE_SCROLLABLE_DIMENSION) continue;
        usable.push({ node, bounds });
    }
    if (usable.length === 0) return undefined;
    if (usable.length === 1) return usable[0];

    if (targetX !== undefined) {
        // Two-column pickers (hour/minute) share option text; pick the column
        // whose center x is closest to the target's x.
        usable.sort((a, b) => {
            const aCenterX = (a.bounds.x1 + a.bounds.x2) / 2;
            const bCenterX = (b.bounds.x1 + b.bounds.x2) / 2;
            return Math.abs(aCenterX - targetX) - Math.abs(bCenterX - targetX);
        });
        return usable[0];
    }

    // No target x: prefer a narrow, tall column (width < 400 and height >= width)
    // over whole-page containers; among columns prefer the smallest (picker
    // columns are small modal lists, not sidebars).
    usable.sort((a, b) => {
        const columnScore = (bounds: RawBounds): number => {
            const w = bounds.x2 - bounds.x1;
            const h = bounds.y2 - bounds.y1;
            return w < 400 && h >= w ? 0 : 1;
        };
        const aScore = columnScore(a.bounds);
        const bScore = columnScore(b.bounds);
        if (aScore !== bScore) return aScore - bScore;
        const area = (bounds: RawBounds): number => (bounds.x2 - bounds.x1) * (bounds.y2 - bounds.y1);
        return area(a.bounds) - area(b.bounds);
    });
    return usable[0];
}

function targetNodeText(node: LayoutNode): string {
    return node.attributes.text || node.attributes.originalText || node.attributes['content-desc'] || '';
}

function findLayoutTarget(layout: LayoutNode, targetRole: string, targetText: string): LayoutNode[] {
    const q = targetText.toLowerCase();
    return walkLayoutNodes(
        layout,
        (n) => n.attributes.type === targetRole && targetNodeText(n).toLowerCase().includes(q)
    );
}

function centerOf(bounds: RawBounds): { x: number; y: number } {
    return { x: Math.round((bounds.x1 + bounds.x2) / 2), y: Math.round((bounds.y1 + bounds.y2) / 2) };
}

/**
 * Returns true when the target bounds overlap the container viewport in both
 * axes. A virtual-scroll list only renders items inside its viewport, so this
 * is the single source of truth for "clickable right now".
 */
function isInsideViewport(target: RawBounds, viewport: RawBounds): boolean {
    const overlapY = target.y1 <= viewport.y2 && target.y2 >= viewport.y1;
    const overlapX = target.x1 <= viewport.x2 && target.x2 >= viewport.x1;
    return overlapY && overlapX;
}

const ScrollInScrollableArgsSchema = z.object({
    targetRole: z.string().describe('目标元素 role，如 "button"'),
    targetText: z
        .string()
        .min(1)
        .describe(
            '目标元素文本（如 "09"），模糊匹配。命中多列同名项时用 containerName 或返回的 targetCenter 的 x 区分'
        ),
    bundleName: z.string().optional().describe('目标应用 bundleName（dumpLayout 过滤窗口用）'),
    containerRole: z.string().default('genericContainer').describe('滚动容器 role，默认 genericContainer'),
    containerName: z.string().optional().describe('滚动容器名称，可选，精确定位'),
    direction: z.enum(['up', 'down']).optional().describe('滚动方向，不指定则根据目标相对可视区的位置自动判断'),
    maxScrolls: z.number().int().min(1).max(20).default(8).describe('最大滚动尝试次数，默认 8'),
    scrollDistance: z.number().int().min(20).optional().describe('每次滑动距离（像素），默认容器可视高度的 50%'),
    settleMs: z.number().int().min(0).max(5000).default(300).describe('每次滑动后等待界面稳定的时间，默认 300ms'),
    snapshot: z.boolean().default(true).describe('滚动完成后是否获取界面快照，默认 true'),
    deviceId: DeviceIdSchema
});

export class ScrollInScrollableTool extends HarmonyBaseTool<typeof ScrollInScrollableArgsSchema> {
    constructor() {
        super(
            'scrollInScrollable',
            '在 Web 虚拟滚动弹窗（时间/日期选择器等）的滚动容器内滑动，直到目标元素进入容器可视区，并返回其真实屏幕坐标。' +
                '虚拟滚动列表报告的按钮 bounds 是内容坐标（含滚动偏移），直接点击会落在弹窗遮罩上导致值不变；' +
                '本工具用 dumpLayout 定位滚动容器可视区，在容器内滑动直到目标 bounds 进入可视区，返回 targetCenter（真实可点击坐标）。',
            ScrollInScrollableArgsSchema,
            'tools.harmony.scrollInScrollable.name'
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof ScrollInScrollableArgsSchema>): Promise<string> {
        try {
            const deviceId = await tryResolveDeviceId(args.deviceId);
            let layout = await dumpLayout(args.bundleName, deviceId);
            // Resolve target x first so sibling columns (hour/minute with identical
            // option text) pick the right container on the very first layout.
            const initialTargets = findLayoutTarget(layout, args.targetRole, args.targetText);
            const initialTargetBounds = initialTargets[0]
                ? parseRawBounds(initialTargets[0].attributes.bounds)
                : undefined;
            const targetX = initialTargetBounds ? centerOf(initialTargetBounds).x : undefined;
            const container = findScrollableContainer(layout, args.containerRole, args.containerName, targetX);
            if (!container) {
                return fail(
                    `找不到滚动容器：role="${args.containerRole}"` +
                        (args.containerName ? `, name="${args.containerName}"` : '') +
                        '（需要 scrollable=true 的节点）。请先打开选择器再重试'
                );
            }
            const viewport = container.bounds;

            let direction = args.direction;
            let scrollsUsed = 0;

            for (let attempt = 0; attempt <= args.maxScrolls; attempt++) {
                const targets = findLayoutTarget(layout, args.targetRole, args.targetText);
                const hit = targets.find((t) => {
                    const tb = parseRawBounds(t.attributes.bounds);
                    return tb ? isInsideViewport(tb, viewport) : false;
                });
                if (hit) {
                    const tb = parseRawBounds(hit.attributes.bounds)!;
                    const center = centerOf(tb);
                    return ok(
                        await withSnapshot(
                            args.snapshot,
                            {
                                visible: true,
                                scrollsUsed,
                                targetRole: args.targetRole,
                                targetText: args.targetText,
                                targetBounds: tb,
                                targetCenter: center,
                                containerBounds: viewport,
                                hint: 'targetCenter 即真实可点击坐标，可直接用于 click'
                            },
                            undefined,
                            deviceId
                        )
                    );
                }

                if (attempt >= args.maxScrolls) break;

                // Decide direction from the first match's position relative to the viewport.
                const firstMatch = targets[0];
                if (firstMatch) {
                    const tb = parseRawBounds(firstMatch.attributes.bounds);
                    if (tb) {
                        if (tb.y2 < viewport.y1) {
                            direction = 'down'; // 目标在可视区上方 → 向下滑动（查看上方内容）
                        } else if (tb.y1 > viewport.y2) {
                            direction = 'up'; // 目标在可视区下方 → 向上滑动（查看下方内容）
                        }
                    }
                }
                if (!direction) {
                    // No target match at all and no direction hint: default to upward scrolling.
                    direction = 'up';
                }

                const region = {
                    x: Math.round((viewport.x1 + viewport.x2) / 2),
                    y: Math.round((viewport.y1 + viewport.y2) / 2),
                    width: viewport.x2 - viewport.x1,
                    height: viewport.y2 - viewport.y1
                };
                const distance = args.scrollDistance ?? Math.max(50, Math.round(region.height * 0.5));
                await performScrollGesture(direction, region, distance, deviceId);
                scrollsUsed++;

                await new Promise((resolve) => setTimeout(resolve, args.settleMs));
                layout = await dumpLayout(args.bundleName, deviceId);
            }

            // Exhausted maxScrolls without the target entering the viewport.
            const targets = findLayoutTarget(layout, args.targetRole, args.targetText);
            return ok(
                await withSnapshot(
                    args.snapshot,
                    {
                        visible: false,
                        scrollsUsed,
                        targetRole: args.targetRole,
                        targetText: args.targetText,
                        matchesFound: targets.length,
                        containerBounds: viewport,
                        message: `滚动 ${args.maxScrolls} 次后目标仍未进入可视区。可增大 maxScrolls、检查 targetText 是否匹配，或确认目标所在列与容器一致`
                    },
                    undefined,
                    deviceId
                )
            );
        } catch (err) {
            return fail(`scrollInScrollable failed: ${err}`);
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

async function typeAsciiText(text: string, deviceId?: string): Promise<boolean> {
    const strokes = [...text].map(getAsciiKeyStroke);
    if (strokes.some((stroke) => !stroke)) return false;

    for (const stroke of strokes) {
        const codes = stroke!.shift ? [KEYCODE_SHIFT_LEFT, KEY_MAP[stroke!.key]] : [KEY_MAP[stroke!.key]];
        await runHdc(['shell', 'uitest', 'uiInput', 'keyEvent', ...codes.map(String)], 5000, deviceId);
    }
    return true;
}

async function pasteFocusedText(text: string, deviceId?: string): Promise<void> {
    await runHdc(['shell', 'uitest', 'uiInput', 'text', text], 10000, deviceId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await clearFocusedText(3, deviceId);
    await runHdc(['shell', 'uitest', 'uiInput', 'keyEvent', String(KEYCODE_PASTE)], 5000, deviceId);
}

// ========== input ==========

const InputArgsSchema = z.object({
    x: z.number().int().min(0).describe('输入框的 X 坐标'),
    y: z.number().int().min(0).describe('输入框的 Y 坐标'),
    text: z.string().describe('要输入的文本内容'),
    mode: z
        .enum(['append', 'replace'])
        .default('append')
        .describe('输入模式：append 在现有光标处追加；replace 清空已有文本后输入'),
    clearMode: z
        .enum(['dragSelect', 'backspace'])
        .default('dragSelect')
        .describe(
            'replace 模式的清空方式：dragSelect=拖拽全选后输入（默认，需提供 bounds 定位拖拽范围，支持单行/多行）；backspace=设备端批量退格删除（无需 bounds，最多删 maxClearChars 个字符）'
        ),
    bounds: z
        .object({
            x1: z.number().int().min(0),
            y1: z.number().int().min(0),
            x2: z.number().int().min(0),
            y2: z.number().int().min(0)
        })
        .optional()
        .describe(
            '输入框边界（来自 snapshot/findElement）。replace + clearMode=dragSelect 时用于从文本起点拖到末尾全选'
        ),
    maxClearChars: z
        .number()
        .int()
        .min(1)
        .max(4096)
        .default(DEFAULT_REPLACE_CLEAR_CHARS)
        .describe(
            'backspace 清空（含 dragSelect 未提供 bounds 时的回退）最多删除的字符数，默认 256；内容更长时需显式增大'
        ),
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取界面快照，默认 false'),
    deviceId: DeviceIdSchema
});

async function clearFocusedText(maxClearChars: number, deviceId?: string): Promise<void> {
    // Do NOT use KEY_MAP.Home (keycode 1): it is the system Home button on
    // HarmonyOS, intercepted by the system and triggers browser / home screen
    // instead of "move cursor to beginning of line". Use Backspace to delete
    // from the end instead.
    // Run the whole Backspace sequence in a single device-side shell loop so a
    // large maxClearChars does not cost one hdc round-trip per key event.
    const script = `i=0; while [ $i -lt ${maxClearChars} ]; do uitest uiInput keyEvent ${KEY_MAP.Backspace}; i=$((i + 1)); done`;
    await runHdc(['shell', script], Math.max(10000, maxClearChars * 50), deviceId);
}

async function dragSelectAll(
    bounds: { x1: number; y1: number; x2: number; y2: number },
    deviceId?: string
): Promise<void> {
    // Drag from near the top-left of the field to near the bottom-right to
    // select the whole text. Web inputs stop the selection at the text end, so
    // dragging past shorter text still selects it fully; for multi-line fields
    // the diagonal spans every visible line. Staying inside the field bounds
    // keeps the drag from landing on a neighboring control.
    const width = bounds.x2 - bounds.x1;
    const fromX = Math.round(bounds.x1 + Math.max(4, width * 0.1));
    const toX = Math.round(bounds.x2 - Math.max(4, width * 0.1));
    const fromY = bounds.y1 + 4;
    const toY = bounds.y2 - 4;
    await runHdc(
        ['shell', 'uitest', 'uiInput', 'drag', String(fromX), String(fromY), String(toX), String(toY), '600'],
        10000,
        deviceId
    );
}

export class InputTool extends HarmonyBaseTool<typeof InputArgsSchema> {
    constructor() {
        super(
            'input',
            '在指定坐标的输入框中输入文本。会先点击坐标获取焦点，然后输入文本。' +
                '支持中文输入：对非 ASCII 文本，通过剪贴板粘贴实现',
            InputArgsSchema,
            'tools.harmony.input.name'
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof InputArgsSchema>): Promise<string> {
        try {
            const deviceId = await tryResolveDeviceId(args.deviceId);
            // eslint-disable-next-line no-control-regex
            const hasNonAscii = /[^\x00-\x7F]/.test(args.text);

            // Click to focus the input.
            await runHdc(['shell', 'uitest', 'uiInput', 'click', String(args.x), String(args.y)], 10000, deviceId);
            await new Promise((resolve) => setTimeout(resolve, 300));

            if (args.mode === 'replace') {
                if (args.clearMode === 'dragSelect' && args.bounds) {
                    await dragSelectAll(args.bounds, deviceId);
                } else {
                    // XComponent can treat Ctrl+A as a literal "a". Backspace
                    // from the end instead, bounded to avoid an unbounded
                    // device operation.
                    await clearFocusedText(args.maxClearChars, deviceId);
                }
            }

            if (hasNonAscii) {
                // uiInput text writes the intended text to the pasteboard but leaves
                // the fixed "va'" fallback sequence in the focused field. Do not
                // use Ctrl+A here: XComponent may deliver it as a literal "a".
                await pasteFocusedText(args.text, deviceId);
            } else {
                // uiInput text can prepend a fallback character in XComponent.
                // Physical key events avoid the clipboard-based text path.
                const typed = await typeAsciiText(args.text, deviceId);
                if (!typed) {
                    await runHdc(['shell', 'uitest', 'uiInput', 'text', args.text], 10000, deviceId);
                }
            }

            const result = await withSnapshot(
                args.snapshot,
                {
                    x: args.x,
                    y: args.y,
                    text: args.text,
                    mode: args.mode,
                    ...(args.mode === 'replace'
                        ? { clearMode: args.clearMode === 'dragSelect' && args.bounds ? 'dragSelect' : 'backspace' }
                        : {})
                },
                undefined,
                deviceId
            );
            return ok(result);
        } catch (err) {
            return fail(`Failed to input text: ${err}`);
        }
    }
}

// ========== native file picker ==========

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

/**
 * 解析当前前台（顶层、非系统 shell）应用的 bundleName，用于工具未显式指定目标应用时的兜底。
 * 窗口列表顺序由 dumpLayout 决定，这里取第一个可见的非系统 shell 窗口。
 */
async function resolveForegroundBundleName(deviceId?: string): Promise<string | undefined> {
    try {
        const layout = await dumpLayout(undefined, deviceId);
        return findAllWindows(layout).find((window) => window.bundleName && window.bundleName !== SCENEBOARD_BUNDLE)
            ?.bundleName;
    } catch {
        return undefined;
    }
}

function pickerBundleName(layout: LayoutNode): string | undefined {
    const windows = findAllWindows(layout);
    const namedPicker = windows.find((window) => /(?:file|picker|document|storage)/i.test(window.bundleName));
    if (namedPicker) return namedPicker.bundleName;
    return windows.find((window) => window.bundleName && window.bundleName !== SCENEBOARD_BUNDLE)?.bundleName;
}

async function clickPickerTarget(target: PickerTarget, deviceId?: string): Promise<void> {
    const point = getCenter(target.bounds);
    if (!point) throw new Error(`文件选择器目标没有有效坐标：${target.label}`);
    await runHdc(['shell', 'uitest', 'uiInput', 'click', String(point.x), String(point.y)], 10000, deviceId);
}

async function replaceTextAt(x: number, y: number, text: string, deviceId?: string): Promise<void> {
    await runHdc(['shell', 'uitest', 'uiInput', 'click', String(x), String(y)], 10000, deviceId);
    await clearFocusedText(DEFAULT_REPLACE_CLEAR_CHARS, deviceId);
    const typed = await typeAsciiText(text, deviceId);
    if (!typed) {
        await pasteFocusedText(text, deviceId);
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
    snapshot: z.boolean().default(true).describe('确认选择后是否获取所有可见窗口的快照，默认 true'),
    deviceId: DeviceIdSchema
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

export class ChooseFileTool extends HarmonyBaseTool<typeof ChooseFileArgsSchema> {
    constructor() {
        super(
            'chooseFile',
            '操控当前 HarmonyOS 系统文件选择器：按设备路径中的可见目录逐层导航，选择文件/目录，或填写保存文件名并确认。',
            ChooseFileArgsSchema,
            'tools.harmony.chooseFile.name'
        );
        this.serialExecution = true;
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof ChooseFileArgsSchema>): Promise<string> {
        const deviceId = await tryResolveDeviceId(args.deviceId);
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
                layout = await dumpLayout(undefined, deviceId);
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
                    await clickPickerTarget(directoryTarget, deviceId);
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
                        await replaceTextAt(point.x, point.y, targetName, deviceId);
                        selectedTarget = textBox;
                        break;
                    }
                } else {
                    selectedTarget = findPickerTarget(layout, [targetName], {
                        bundleName: detectedBundleName
                    });
                    if (selectedTarget) {
                        await clickPickerTarget(selectedTarget, deviceId);
                        break;
                    }
                }

                if (scrollsUsed >= args.maxScrolls) {
                    const capture = convertLayout(layout, undefined, deviceId);
                    return fail(
                        `系统文件选择器中未找到 ${args.mode === 'saveFile' ? '文件名输入框' : `目标“${targetName}”`}。` +
                            `请确认 Picker 已打开、路径可浏览且目标已下发到设备。最后快照：${capture.snapshot}`
                    );
                }
                await runHdc(['shell', 'uitest', 'uiInput', 'dircFling', '2'], 10000, deviceId);
                scrollsUsed += 1;
                await new Promise((resolve) => setTimeout(resolve, 300));
            }

            await new Promise((resolve) => setTimeout(resolve, 300));
            layout = await dumpLayout(undefined, deviceId);
            const pickerStillVisible = detectedBundleName
                ? findAllWindows(layout).some((window) => window.bundleName === detectedBundleName)
                : true;
            if (pickerStillVisible) {
                const confirmTarget = findPickerTarget(layout, PICKER_CONFIRM_LABELS[args.mode], {
                    bundleName: detectedBundleName
                });
                if (!confirmTarget) {
                    const capture = convertLayout(layout, undefined, deviceId);
                    return fail(`已选中“${targetName}”，但未找到文件选择器确认按钮。最后快照：${capture.snapshot}`);
                }
                await clickPickerTarget(confirmTarget, deviceId);
            }

            return ok(
                await withSnapshot(
                    args.snapshot,
                    {
                        path: normalizedPath,
                        mode: args.mode,
                        selected: Boolean(selectedTarget),
                        confirmed: true,
                        ...(detectedBundleName ? { pickerBundleName: detectedBundleName } : {}),
                        ...(scrollsUsed > 0 ? { scrollsUsed } : {})
                    },
                    undefined,
                    deviceId
                )
            );
        } catch (err) {
            return fail(`系统文件选择失败：${err}`);
        }
    }
}

const DropFixtureArgsSchema = z.object({
    localPath: z.string().min(1).describe('宿主机上的待投放文件路径'),
    bundleName: BundleNameSchema.optional().describe('目标 WebView 应用 bundleName；不指定则自动探测当前前台应用'),
    x: z.number().int().min(0).describe('WebView 中投放目标的 X 坐标'),
    y: z.number().int().min(0).describe('WebView 中投放目标的 Y 坐标'),
    snapshot: z.boolean().default(true).describe('投放后是否获取目标应用快照，默认 true'),
    deviceId: DeviceIdSchema
});

const DROP_FIXTURE_MAX_BYTES = 20 * 1024 * 1024;
const DROP_FIXTURE_CHUNK_SIZE = 256 * 1024;

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

export class DropFixtureTool extends HarmonyBaseTool<typeof DropFixtureArgsSchema> {
    constructor() {
        super(
            'dropFixture',
            '读取宿主机文件并在目标 WebView 坐标派发真实 dragenter/dragover/drop 事件，适用于图片上传和附件拖放。',
            DropFixtureArgsSchema,
            'tools.harmony.dropFixture.name'
        );
        this.serialExecution = true;
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof DropFixtureArgsSchema>): Promise<string> {
        // 提升变量到函数作用域：catch 需要 bundleName/fixtureId 做设备端残留清理
        let deviceId: string | undefined;
        let bundleName: string | undefined;
        let fixtureId: string | undefined;
        try {
            deviceId = await tryResolveDeviceId(args.deviceId);
            bundleName = args.bundleName ?? (await resolveForegroundBundleName(deviceId));
            if (!bundleName) {
                return fail(
                    'dropFixture 需要 bundleName 目标 WebView 应用，或探测不到当前前台应用，请显式传入 bundleName'
                );
            }
            const localPath = resolve(args.localPath);
            const stats = await statAsync(localPath);
            if (!stats.isFile()) return fail(`dropFixture 只接受文件：${localPath}`);
            if (stats.size > DROP_FIXTURE_MAX_BYTES) {
                return fail(`文件过大：${stats.size} bytes，dropFixture 上限为 ${DROP_FIXTURE_MAX_BYTES} bytes`);
            }

            const fileName = basename(localPath);
            const mimeType = fixtureMimeType(fileName);
            const base64 = (await readFileAsync(localPath)).toString('base64');
            fixtureId = createHash('sha256').update(localPath).update(String(Date.now())).digest('hex').slice(0, 16);
            const chunks = base64.match(new RegExp(`.{1,${DROP_FIXTURE_CHUNK_SIZE}}`, 'g')) || [''];

            await runHdc(
                [
                    'shell',
                    'arkweb_exec_js',
                    '-b',
                    bundleName,
                    '-s',
                    `window.__opendeskFixtureChunks=window.__opendeskFixtureChunks||{};window.__opendeskFixtureChunks[${JSON.stringify(fixtureId)}]=[];`
                ],
                10000,
                deviceId
            );
            for (const chunk of chunks) {
                await runHdc(
                    [
                        'shell',
                        'arkweb_exec_js',
                        '-b',
                        bundleName,
                        '-s',
                        `window.__opendeskFixtureChunks[${JSON.stringify(fixtureId)}].push(${JSON.stringify(chunk)});`
                    ],
                    10000,
                    deviceId
                );
            }

            const dispatchScript = `(()=>{const k=${JSON.stringify(fixtureId)};const b=window.__opendeskFixtureChunks?.[k]?.join('');if(b===undefined)throw new Error('fixture chunks missing');const a=atob(b);const u=new Uint8Array(a.length);for(let i=0;i<a.length;i++)u[i]=a.charCodeAt(i);const f=new File([u],${JSON.stringify(fileName)},{type:${JSON.stringify(mimeType)}});const d=new DataTransfer();d.items.add(f);const e=document.elementFromPoint(${args.x},${args.y});if(!e)throw new Error('drop target not found');for(const t of ['dragenter','dragover','drop'])e.dispatchEvent(new DragEvent(t,{bubbles:true,cancelable:true,clientX:${args.x},clientY:${args.y},dataTransfer:d}));delete window.__opendeskFixtureChunks[k];return 'drop-dispatched';})()`;
            const detail = await runHdc(
                ['shell', 'arkweb_exec_js', '-b', bundleName, '-s', dispatchScript],
                20000,
                deviceId
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
                    bundleName,
                    deviceId
                )
            );
        } catch (err) {
            // best-effort 清理设备端残留 chunk：chunk 已 push 但 dispatch 未成功时
            if (bundleName && fixtureId) {
                try {
                    await runHdc(
                        [
                            'shell',
                            'arkweb_exec_js',
                            '-b',
                            bundleName,
                            '-s',
                            `delete window.__opendeskFixtureChunks[${JSON.stringify(fixtureId)}];`
                        ],
                        10000,
                        deviceId
                    );
                } catch {
                    // 清理失败不影响主错误返回
                }
            }
            return fail(`投放测试 fixture 失败：${err}`);
        }
    }
}

// ========== goBack ==========

const GoBackArgsSchema = z.object({
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取界面快照，默认 false'),
    deviceId: DeviceIdSchema
});

export class GoBackTool extends HarmonyBaseTool<typeof GoBackArgsSchema> {
    constructor() {
        super('goBack', '按下返回键，返回上一级页面或退出当前应用', GoBackArgsSchema, 'tools.harmony.goBack.name');
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof GoBackArgsSchema>): Promise<string> {
        try {
            const deviceId = await tryResolveDeviceId(args.deviceId);
            await runHdc(['shell', 'uitest', 'uiInput', 'keyEvent', 'Back'], 10000, deviceId);
            const result = await withSnapshot(args.snapshot, {}, undefined, deviceId);
            return ok(result);
        } catch (err) {
            return fail(`Failed to go back: ${err}`);
        }
    }
}

// ========== goForward ==========

const GoForwardArgsSchema = z.object({
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取界面快照，默认 false'),
    deviceId: DeviceIdSchema
});

export class GoForwardTool extends HarmonyBaseTool<typeof GoForwardArgsSchema> {
    constructor() {
        super(
            'goForward',
            '按下 Alt+Right 方向键，在支持前进导航的应用中向前导航',
            GoForwardArgsSchema,
            'tools.harmony.goForward.name'
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof GoForwardArgsSchema>): Promise<string> {
        try {
            const deviceId = await tryResolveDeviceId(args.deviceId);
            // Alt+Right Arrow
            await runHdc(
                ['shell', 'uitest', 'uiInput', 'keyEvent', String(KEYCODE_ALT_LEFT), String(KEY_MAP.ArrowRight)],
                10000,
                deviceId
            );
            const result = await withSnapshot(args.snapshot, {}, undefined, deviceId);
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
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取界面快照，默认 false'),
    deviceId: DeviceIdSchema
});

export class PressKeyTool extends HarmonyBaseTool<typeof PressKeyArgsSchema> {
    constructor() {
        super(
            'pressKey',
            '在当前焦点元素上按下指定按键。支持功能键、方向键、字母数字键和修饰键组合。' +
                '按键名称参考 HarmonyOS 键值定义。在输入框中输入文本后，推荐优先使用 pressKey({ key: "Enter" }) 发送消息',
            PressKeyArgsSchema,
            'tools.harmony.pressKey.name'
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof PressKeyArgsSchema>): Promise<string> {
        try {
            const deviceId = await tryResolveDeviceId(args.deviceId);
            const keyCode = KEY_MAP[args.key];
            if (keyCode === undefined) {
                return fail(`Unknown key: "${args.key}". Supported keys: ${Object.keys(KEY_MAP).join(', ')}`);
            }

            const mods = args.modifiers ?? [];
            const modCodes = mods.map((m) => MODIFIER_MAP[m]).filter((c) => c !== undefined);
            // Unknown modifier would have been rejected by zod enum

            // uitest keyEvent accepts up to 3 keycodes: modifier1 modifier2 key
            const allCodes = [...modCodes, keyCode];
            await runHdc(['shell', 'uitest', 'uiInput', 'keyEvent', ...allCodes.map(String)], 10000, deviceId);

            const result: Record<string, unknown> = { key: args.key };
            if (mods.length) result.modifiers = mods;
            const finalResult = await withSnapshot(args.snapshot, result, undefined, deviceId);
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
    screenshotOnTimeout: z.boolean().default(true).describe('条件超时时是否尝试附加最后屏幕的 OCR 证据，默认 true'),
    deviceId: DeviceIdSchema
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

async function captureTimeoutEvidence(deviceId?: string): Promise<Record<string, unknown>> {
    let screenshotDir: string | undefined;
    try {
        const imgPath = await captureScreenshot(deviceId);
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

export class WaitForTool extends HarmonyBaseTool<typeof WaitForArgsSchema> {
    constructor() {
        super(
            'waitFor',
            '等待固定时间，或轮询等待文本、元素状态、窗口状态或快照内容变化。条件满足或超时时都会返回最后一份可用快照。',
            WaitForArgsSchema,
            'tools.harmony.waitFor.name'
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

        const deviceId = await tryResolveDeviceId(args.deviceId);

        if (args.duration !== undefined) {
            await new Promise((resolve) => setTimeout(resolve, args.duration));
            const result = await withSnapshot(args.snapshot, { duration: args.duration }, undefined, deviceId);
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
                const layout = await dumpLayout(snapshotBundleName, deviceId);
                const built = buildSnapshot(layout, snapshotBundleName);
                const evaluation = evaluateWaitCondition(condition, layout, built, baselineFingerprint);
                lastBuilt = built;
                lastEvaluation = evaluation;
                lastCaptureError = undefined;

                if (evaluation.satisfied) {
                    stableSince ??= Date.now();
                    if (Date.now() - stableSince >= requiredStableFor) {
                        const capture = registerSnapshot(built, deviceId);
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

        const capture = lastBuilt ? registerSnapshot(lastBuilt, deviceId) : undefined;
        const screenshot = args.screenshotOnTimeout ? await captureTimeoutEvidence(deviceId) : undefined;
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
    ocr: z.boolean().default(true).describe('是否对截图执行 OCR 文本识别。默认 true'),
    deviceId: DeviceIdSchema
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
export class ScreenshotTool extends HarmonyBaseTool<typeof ScreenshotArgsSchema> {
    constructor() {
        super(
            'screenshot',
            '截取设备屏幕截图，可选执行 OCR 文本识别和区域亮度分析。' +
                '当 snapshot（无障碍树）无法获取界面文本时（如原生 select 弹窗、XComponent 渲染内容），' +
                '使用此工具获取屏幕上的可视文本及其坐标。' +
                '返回 OCR 文本列表（含坐标和置信度）和区域亮度分析（可识别高亮/选中行）。',
            ScreenshotArgsSchema,
            'tools.harmony.screenshot.name'
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof ScreenshotArgsSchema>): Promise<string> {
        let screenshotDir: string | undefined;
        try {
            const deviceId = await tryResolveDeviceId(args.deviceId);
            const imgPath = await captureScreenshot(deviceId);
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
            .describe('可选，只对比指定区域'),
        deviceId: DeviceIdSchema
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
            .describe('采样点列表，最多 20 个'),
        deviceId: DeviceIdSchema
    }),
    z.object({
        mode: z.literal('theme'),
        expectedTheme: z.enum(['light', 'dark']).optional().describe('期望的主题'),
        deviceId: DeviceIdSchema
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

export class VisualAssertTool extends HarmonyBaseTool<typeof VisualAssertArgsSchema> {
    constructor() {
        super(
            'visualAssert',
            '视觉断言工具，支持三种模式：\n' +
                '- diff：截图与基线图片像素级对比，用于回归测试和布局变化检测\n' +
                '- color：采样指定坐标的 RGB 颜色值，用于验证主题色、按钮状态（disabled 灰化、active 高亮）\n' +
                '- theme：自动检测当前界面是浅色还是深色主题',
            VisualAssertArgsSchema,
            'tools.harmony.visualAssert.name'
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof VisualAssertArgsSchema>): Promise<string> {
        let screenshotDir: string | undefined;
        try {
            const deviceId = await tryResolveDeviceId((args as { deviceId?: string }).deviceId);
            const imgPath = await captureScreenshot(deviceId);
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
    const Jimp = await loadJimp();
    if (!Jimp) throw new Error('jimp is required for visualAssert. Install it with npm install jimp.');
    const img = await Jimp.read(filePath);
    if (region) {
        img.crop({
            x: region.x1,
            y: region.y1,
            w: region.x2 - region.x1,
            h: region.y2 - region.y1
        });
    }
    return { data: img.bitmap.data, width: img.bitmap.width, height: img.bitmap.height };
}

async function performDiff(
    screenshotPath: string,
    args: z.output<typeof VisualAssertArgsSchema> & { mode: 'diff' }
): Promise<DiffMetrics> {
    const pixelmatchModule = await import('pixelmatch').catch(() => null);
    const pixelmatch = pixelmatchModule?.default;
    if (!pixelmatch) {
        throw new Error(
            'pixelmatch is required for visual diff. It should be a declared dependency of the host application.'
        );
    }

    const screenshot = await loadImageRaw(screenshotPath, args.region);
    const baseline = await loadImageRaw(args.baseline);

    // Resize baseline to match screenshot dimensions if needed
    let baselineData = baseline.data;
    if (baseline.width !== screenshot.width || baseline.height !== screenshot.height) {
        const Jimp = await loadJimp();
        if (!Jimp) throw new Error('jimp is required for image resizing.');

        const resized = await Jimp.fromBitmap({ data: baselineData, width: baseline.width, height: baseline.height });
        resized.resize({ w: screenshot.width, h: screenshot.height });
        baselineData = resized.bitmap.data;
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
        const Jimp = await loadJimp();
        if (Jimp) {
            const diffImg = await Jimp.fromBitmap({
                data: diffOutput,
                width: screenshot.width,
                height: screenshot.height
            });
            await diffImg.write(diffImagePath);
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
    const Jimp = await loadJimp();
    if (!Jimp) throw new Error('jimp is required for color sampling.');

    const img = await Jimp.read(screenshotPath);
    const { data, width } = img.bitmap;

    return samples.map((sample) => {
        const idx = (sample.y * width + sample.x) * 4;
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
    const Jimp = await loadJimp();
    if (!Jimp) throw new Error('jimp is required for theme detection.');

    const img = await Jimp.read(imgPath);
    const width = img.bitmap.width;
    const height = img.bitmap.height;
    if (!width || !height) {
        throw new Error('Unable to determine screenshot dimensions');
    }

    const { data } = img.bitmap;

    // Sample a 3x3 grid of regions
    const cols = 3;
    const rows = 3;
    const regionW = Math.floor(width / cols);
    const regionH = Math.floor(height / rows);
    const regionBrightnesses: number[] = [];

    for (let gy = 0; gy < rows; gy++) {
        for (let gx = 0; gx < cols; gx++) {
            const startX = gx * regionW;
            const startY = gy * regionH;
            let total = 0;
            let count = 0;

            // Sample every 4th pixel within the region for performance
            for (let y = startY; y < startY + regionH && y < height; y += 4) {
                for (let x = startX; x < startX + regionW && x < width; x += 4) {
                    const idx = (y * width + x) * 4;
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
    x: z.number().int().min(0).describe('悬停位置的 X 坐标'),
    y: z.number().int().min(0).describe('悬停位置的 Y 坐标'),
    bundleName: BundleNameSchema.optional().describe(
        '目标 WebView 应用 bundleName；仅用于 WebView JS 注入降级路径，不指定时自动探测当前前台应用'
    ),
    duration: z.number().int().min(100).max(5000).default(800).describe('悬停保持时长（毫秒），默认 800ms'),
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取界面快照'),
    deviceId: DeviceIdSchema
});

export class HoverTool extends HarmonyBaseTool<typeof HoverArgsSchema> {
    constructor() {
        super(
            'hover',
            '在指定坐标模拟鼠标悬停（pointerenter / mouseover）。\n' +
                '采用三层降级策略：\n' +
                '1. 尝试 HDC 原生 mouseMove 命令\n' +
                '2. 降级为 WebView JavaScript 事件注入\n' +
                '3. 最后降级为 0 像素低速 drag 变通（不可靠）\n' +
                '工具返回实际生效的路径（method 字段），用于判断环境支持情况。',
            HoverArgsSchema,
            'tools.harmony.hover.name'
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof HoverArgsSchema>): Promise<string> {
        try {
            const deviceId = await tryResolveDeviceId(args.deviceId);
            const result = await executeHover(args.x, args.y, args.duration, deviceId, args.bundleName);
            const withSnap = await withSnapshot(
                args.snapshot,
                { x: args.x, y: args.y, ...result },
                args.bundleName,
                deviceId
            );
            return ok(withSnap);
        } catch (err) {
            return fail(`hover(${args.x}, ${args.y}) failed: ${err}`);
        }
    }
}

async function executeHover(
    x: number,
    y: number,
    duration: number,
    deviceId?: string,
    bundleName?: string
): Promise<{ method: string; native: boolean; detail?: string }> {
    // Tier 1: HDC native mouseMove
    const mouseMoveMethods = [
        ['uitest', 'uiInput', 'mouseMove'],
        ['uitest', 'uiInput', 'touchMove'],
        ['uinput', 'mouse', 'move']
    ];

    for (const method of mouseMoveMethods) {
        try {
            await runHdc(['shell', ...method, String(x), String(y)], 5000, deviceId);
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

        const targetBundle = bundleName ?? (await resolveForegroundBundleName(deviceId));
        if (!targetBundle) {
            // 无法确定目标 WebView 应用，无法注入 JS，落到 Tier 3
            throw new Error('cannot resolve a foreground bundleName for WebView JS injection');
        }
        const result = await runHdc(['shell', 'arkweb_exec_js', '-b', targetBundle, '-s', jsPayload], 10000, deviceId);
        if (duration > 0) {
            await new Promise((resolve) => setTimeout(resolve, duration));
        }
        return { method: 'webview-js-injection', native: false, detail: result };
    } catch {
        // fall through to tier 3
    }

    // Tier 3: 0-pixel drag workaround (unreliable)
    try {
        await runHdc(
            ['shell', 'uitest', 'uiInput', 'drag', String(x), String(y), String(x), String(y), '1'],
            10000,
            deviceId
        );
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
    limit: z.number().int().min(1).max(50).default(20).describe('最大返回数量，默认 20'),
    deviceId: DeviceIdSchema
});

export class FindElementTool extends HarmonyBaseTool<typeof FindElementArgsSchema> {
    constructor() {
        super(
            'findElement',
            '从最新快照中按条件查询元素。支持按 role、name、hint、state、text 组合过滤，' +
                '返回匹配元素的 ref、role、name、bounds、center 和状态标记。\n' +
                '所有条件是 AND 关系——只返回同时满足全部条件的元素。\n' +
                '返回的 ref 可直接用于 clickRef / getElementState 等后续操作。',
            FindElementArgsSchema,
            'tools.harmony.findElement.name'
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof FindElementArgsSchema>): Promise<string> {
        try {
            const deviceId = await tryResolveDeviceId(args.deviceId);
            const matches = findElementsInSnapshot(
                args.role,
                args.name,
                args.hint,
                args.state,
                args.text,
                args.ref,
                deviceId
            );

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
    ref: z.string().describe('元素引用标识，如 "e5"。必须来自最新快照'),
    deviceId: DeviceIdSchema
});

export class GetElementStateTool extends HarmonyBaseTool<typeof GetElementStateArgsSchema> {
    constructor() {
        super(
            'getElementState',
            '获取指定 ref 元素的完整状态信息，包括 role、name、bounds、center 和 checked/disabled/selected 状态标记。\n' +
                'ref 必须来自最新快照——过期的 ref 会返回 not-found。',
            GetElementStateArgsSchema,
            'tools.harmony.getElementState.name'
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof GetElementStateArgsSchema>): Promise<string> {
        try {
            const deviceId = await tryResolveDeviceId(args.deviceId);
            const matches = findElementsInSnapshot(
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                args.ref,
                deviceId
            );

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
async function captureScreenshot(deviceId?: string): Promise<string> {
    // 设备端截图路径加 pid+ts 后缀，避免并发调用互相覆写后误读对方截图
    const requestedPath = `/data/local/tmp/opendesk_screenshot_${process.pid}_${Date.now()}.png`;
    const dumpOutput = await runHdc(['shell', 'snapshot_display', requestedPath], 20000, deviceId);
    const match = dumpOutput.match(/write to\s+(\S+)/);
    if (!match) throw new Error('Failed to capture screenshot: ' + dumpOutput);

    const devicePath = match[1].trim();
    const localDir = mkdtempSync(join(tmpdir(), 'opendesk-screenshot-'));
    const localPath = join(localDir, 'screenshot.jpg');
    try {
        await runHdc(['file', 'recv', devicePath, localPath], 10000, deviceId);
        return localPath;
    } catch (err) {
        rmSync(localDir, { recursive: true, force: true });
        throw err;
    }
}

// 进程级缓存：tesseract --list-langs 每次 OCR 都要启动一次子进程探测语言，成本高；
// 语言包在运行期间不会变化，探测一次复用即可（首次失败按 eng 处理）。
let ocrLangCache: string | undefined;
let ocrLangChecked = false;

async function resolveOcrLang(): Promise<string> {
    if (ocrLangChecked) return ocrLangCache ?? 'eng';
    ocrLangChecked = true;
    try {
        const { stdout: langList } = await execFileAsync('tesseract', ['--list-langs'], {
            encoding: 'utf-8',
            timeout: 5000
        });
        ocrLangCache = langList.split(/\r?\n/).includes('chi_sim') ? 'chi_sim+eng' : 'eng';
    } catch {
        ocrLangCache = 'eng';
    }
    return ocrLangCache;
}

/**
 * Performs OCR on the screenshot image using Tesseract.
 * Returns text with bounding boxes scaled to device coordinates.
 */
async function performOcr(
    imgPath: string,
    region?: { x1: number; y1: number; x2: number; y2: number }
): Promise<OcrResult[]> {
    const Jimp = await loadJimp();
    if (!Jimp) {
        return [{ text: '(jimp not available)', x: 0, y: 0, width: 0, height: 0, confidence: 0 }];
    }

    const img = await Jimp.read(imgPath);
    const width = img.bitmap.width;
    const height = img.bitmap.height;
    if (!width || !height) {
        throw new Error('Unable to determine screenshot dimensions');
    }

    const crop = region ?? { x1: 0, y1: 0, x2: width, y2: height };
    if (crop.x1 < 0 || crop.y1 < 0 || crop.x2 <= crop.x1 || crop.y2 <= crop.y1 || crop.x2 > width || crop.y2 > height) {
        throw new Error(
            `Invalid OCR region: [${crop.x1},${crop.y1}][${crop.x2},${crop.y2}], ` +
                `screenshot size is ${width}x${height}`
        );
    }

    const cropWidth = crop.x2 - crop.x1;
    const cropHeight = crop.y2 - crop.y1;
    const requestedScale = 2;
    let prepared = img;
    if (region) {
        prepared = img.crop({ x: crop.x1, y: crop.y1, w: cropWidth, h: cropHeight });
    }

    // Derive coordinate scaling from the actual OCR image dimensions.
    prepared.resize({ w: cropWidth * requestedScale, h: cropHeight * requestedScale });
    prepared.greyscale();
    const scaleX = prepared.bitmap.width / cropWidth;
    const scaleY = prepared.bitmap.height / cropHeight;

    // Write to temp file for Tesseract.
    const tmpDir = mkdtempSync(join(tmpdir(), 'opendesk-ocr-'));
    const tmpImg = join(tmpDir, 'ocr_input.png');
    const tmpOut = join(tmpDir, 'ocr_output');
    const preparedBuf = await prepared.getBuffer('image/png');
    writeFileSync(tmpImg, preparedBuf);

    try {
        const lang = await resolveOcrLang();

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
    const Jimp = await loadJimp();
    if (!Jimp) return [];

    const img = await Jimp.read(imgPath);
    const cropped = img.crop({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
    const { data } = cropped.bitmap;
    const width = cropped.bitmap.width;
    const height = cropped.bitmap.height;
    const channels = 4;

    // Calculate average brightness per row
    const rowBrightness: number[] = [];
    for (let y = 0; y < height; y++) {
        let total = 0;
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * channels;
            if (channels >= 3) {
                total += (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
            } else {
                total += data[idx];
            }
        }
        rowBrightness.push(total / width);
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

// ========== systemDialog ==========

/**
 * OCRs the detected option rows of a system dialog and returns the recognized
 * text per row. The whole picker area is scanned once, then each recognized
 * word is assigned to the row band containing its vertical center. Returns an
 * empty array when OCR is unavailable (no tesseract/jimp) or nothing matches.
 */
async function ocrOptionRows(
    imgPath: string,
    segments: { y1: number; y2: number }[],
    width: number
): Promise<{ text: string; y1: number; y2: number }[]> {
    try {
        if (segments.length === 0) return [];
        const Jimp = await loadJimp();
        if (!Jimp) return [];
        const img = await Jimp.read(imgPath);
        const height = img.bitmap.height;
        if (!width || !height) return [];
        const scanY1 = Math.max(0, segments[0].y1);
        const scanY2 = Math.min(height, segments[segments.length - 1].y2);
        if (scanY1 >= scanY2) return [];

        const ocr = await performOcr(imgPath, { x1: 0, y1: scanY1, x2: width, y2: scanY2 });
        const rows = segments.map((seg) => ({ text: '', y1: seg.y1, y2: seg.y2 }));
        for (const item of ocr) {
            if (item.confidence <= 10 || item.text.startsWith('(OCR failed:')) continue;
            const centerY = item.y + item.height / 2;
            const idx = rows.findIndex((r) => centerY >= r.y1 && centerY <= r.y2);
            if (idx >= 0) rows[idx].text += (rows[idx].text ? ' ' : '') + item.text;
        }
        return rows;
    } catch {
        return [];
    }
}

const SystemDialogArgsSchema = z.object({
    action: z
        .enum(['inspect', 'select', 'dismiss'])
        .describe('inspect：仅检测弹窗。select：选择选项（按 option 文本或 optionIndex 索引）。dismiss：关闭弹窗'),
    option: z.string().optional().describe('select 模式下要选择的选项文本，模糊匹配'),
    optionIndex: z.number().int().min(0).optional().describe('select 模式下按索引选择（从0开始，与 option 二选一）'),
    triggerX: z.number().int().min(0).optional().describe('触发弹窗的 X 坐标'),
    triggerY: z.number().int().min(0).optional().describe('触发弹窗的 Y 坐标'),
    settleTime: z.number().int().min(0).default(800).describe('触发后等待弹窗稳定的时间，默认 800ms'),
    snapshot: z.boolean().default(false).describe('操作后是否获取新快照，默认 false'),
    deviceId: DeviceIdSchema
});

export class SystemDialogTool extends HarmonyBaseTool<typeof SystemDialogArgsSchema> {
    constructor() {
        super(
            'systemDialog',
            '通用系统弹窗交互工具，用于操作原生 <select> 选择器、Picker 等不在无障碍树中的系统级弹窗。\n' +
                '三种模式：inspect（仅检测） / select（按文本或索引选择） / dismiss（关闭）。\n' +
                '原理：snapshot_display 全屏截图 → 对比度扫描高亮行（系统选中态）→ 计算选项位置 → 点击。',
            SystemDialogArgsSchema,
            'tools.harmony.systemDialog.name'
        );
        this.serialExecution = true;
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof SystemDialogArgsSchema>): Promise<string> {
        try {
            const deviceId = await tryResolveDeviceId(args.deviceId);
            // 1. Trigger dialog if coordinates provided
            if (args.triggerX !== undefined && args.triggerY !== undefined) {
                await runHdc(
                    ['shell', 'uitest', 'uiInput', 'click', String(args.triggerX), String(args.triggerY)],
                    10000,
                    deviceId
                );
                await new Promise((resolve) => setTimeout(resolve, args.settleTime));
            }

            if (args.action === 'dismiss') {
                await runHdc(['shell', 'uitest', 'uiInput', 'keyEvent', String(KEY_MAP.Escape)], 5000, deviceId);
                return ok({ action: 'dismiss', dismissed: true });
            }

            // 2. Take full-screen screenshot (system dialogs visible here, not in snapshot)
            const imgPath = await captureScreenshot(deviceId);
            dirname(imgPath);
            const Jimp = await loadJimp();
            if (!Jimp) return fail('jimp is required for systemDialog');
            const img = await Jimp.read(imgPath);
            const { data } = img.bitmap;
            const width = img.bitmap.width;
            const height = img.bitmap.height;

            // 3. Detect the highlighted/selected option row (system picker selected state).
            // Instead of assuming a blue highlight (which breaks on dark themes, RTL or
            // alternative ROMs), compare each row's average brightness with its neighbors:
            // the selected row is the strip with the largest local contrast to its context.
            const rowBrightness: { y: number; brightness: number }[] = [];
            for (let y = 0; y < height; y += 2) {
                let total = 0;
                let totalPixels = 0;
                for (let x = 0; x < width; x += 8) {
                    const idx = (y * width + x) * 4;
                    total += (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
                    totalPixels++;
                }
                rowBrightness.push({ y, brightness: totalPixels > 0 ? total / totalPixels : 0 });
            }

            // Local contrast: distance between a row's brightness and the average of a
            // small window of neighbors. Selected rows pop out; plain rows stay close.
            const contrastRows: number[] = [];
            const contextRadius = 2;
            for (let i = 0; i < rowBrightness.length; i++) {
                const windowStart = Math.max(0, i - contextRadius);
                const windowEnd = Math.min(rowBrightness.length - 1, i + contextRadius);
                let ctxSum = 0;
                let ctxCount = 0;
                for (let j = windowStart; j <= windowEnd; j++) {
                    if (j !== i) {
                        ctxSum += rowBrightness[j].brightness;
                        ctxCount++;
                    }
                }
                if (ctxCount === 0) continue;
                const contrast = Math.abs(rowBrightness[i].brightness - ctxSum / ctxCount);
                if (contrast > 25) contrastRows.push(rowBrightness[i].y);
            }

            // Group consecutive contrast rows into segments (the selected strip).
            const highlightSegments: { y1: number; y2: number }[] = [];
            let segStart = 0;
            for (let i = 1; i <= contrastRows.length; i++) {
                if (i === contrastRows.length || contrastRows[i] - contrastRows[i - 1] > 12) {
                    if (i - segStart > 1) {
                        highlightSegments.push({ y1: contrastRows[segStart], y2: contrastRows[i - 1] });
                    }
                    segStart = i;
                }
            }

            const highlightedY =
                highlightSegments.length > 0
                    ? Math.round((highlightSegments[0].y1 + highlightSegments[0].y2) / 2)
                    : null;

            // 4. Count options by scanning for horizontal text lines around the picker area
            // Estimate total options: scan vertically for rows with dark text pixels
            const pickerCenterY = highlightedY ?? Math.round(height / 2);
            const scanY1 = Math.max(0, pickerCenterY - 200);
            const scanY2 = Math.min(height, pickerCenterY + 200);
            const textRows: number[] = [];

            for (let y = scanY1; y < scanY2; y += 2) {
                let darkCount = 0;
                let totalPixels = 0;
                for (let x = 0; x < width; x += 8) {
                    const idx = (y * width + x) * 4;
                    const brightness = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
                    if (brightness < 100) darkCount++;
                    totalPixels++;
                }
                if (darkCount > totalPixels * 0.02) textRows.push(y);
            }

            // Group text rows into option segments
            const optionSegments: { y1: number; y2: number }[] = [];
            segStart = 0;
            for (let i = 1; i <= textRows.length; i++) {
                if (i === textRows.length || textRows[i] - textRows[i - 1] > 6) {
                    if (i - segStart > 3) {
                        optionSegments.push({ y1: textRows[segStart], y2: textRows[i - 1] });
                    }
                    segStart = i;
                }
            }

            // Build options list
            const options = optionSegments.map((seg, i) => ({
                index: i,
                y: Math.round((seg.y1 + seg.y2) / 2),
                height: seg.y2 - seg.y1,
                highlighted: highlightedY !== null && seg.y1 <= highlightedY && seg.y2 >= highlightedY
            }));

            if (args.action === 'inspect') {
                return ok({
                    action: 'inspect',
                    dialogDetected: options.length > 0,
                    options: options.map((o) => ({ index: o.index, y: o.y, highlighted: o.highlighted })),
                    highlightedIndex: options.findIndex((o) => o.highlighted)
                });
            }

            // action === 'select'
            if (options.length === 0) {
                return fail('未检测到系统弹窗');
            }

            let targetIndex = -1;
            if (args.optionIndex !== undefined) {
                targetIndex = args.optionIndex;
            } else if (args.option) {
                // Match the requested option text against the OCR'd rows.
                // Previously this branch was a no-op that always picked the
                // highlighted row; the option argument was documented but not
                // implemented. Fall back to the highlighted row when OCR cannot
                // identify the text (tesseract unavailable / no match).
                const ocrRows = await ocrOptionRows(imgPath, optionSegments, width);
                const matchIdx = ocrRows.findIndex(
                    (row) => row.text && optionTextMatches(row.text, args.option!, 'contains')
                );
                if (matchIdx >= 0) {
                    targetIndex = matchIdx;
                } else {
                    const highlighted = options.findIndex((o) => o.highlighted);
                    if (highlighted >= 0) targetIndex = highlighted;
                }
            }

            if (targetIndex < 0 || targetIndex >= options.length) {
                return fail(`无效选项索引 ${targetIndex}，可用选项 0-${options.length - 1}`);
            }

            const target = options[targetIndex];
            await runHdc(
                ['shell', 'uitest', 'uiInput', 'click', String(Math.round(width / 2)), String(target.y)],
                10000,
                deviceId
            );
            await new Promise((resolve) => setTimeout(resolve, 350));

            return ok({
                action: 'select',
                selected: true,
                option: args.option,
                optionIndex: targetIndex,
                totalOptions: options.length,
                highlightedIndex: options.findIndex((o) => o.highlighted),
                clickPoint: { x: Math.round(width / 2), y: target.y }
            });
        } catch (err) {
            return fail(`systemDialog 操作失败：${err}`);
        }
    }
}

// ========== shell ==========

const ShellArgsSchema = z.object({
    command: z
        .string()
        .min(1)
        .describe(
            '要执行的 hdc shell 命令，如 "bm dump -a"、"ls -l /data/local/tmp"、"hidumper -s 3301"。' +
                '可直接包含管道、重定向、引号等 shell 语法，整条命令在设备端 shell 中执行'
        ),
    timeout: z
        .number()
        .int()
        .min(1000)
        .max(120000)
        .optional()
        .describe('命令执行超时时间（毫秒），默认 15000。耗时命令（如大文件操作、批量查询）可调大'),
    deviceId: DeviceIdSchema
});

export class ShellTool extends HarmonyBaseTool<typeof ShellArgsSchema> {
    constructor() {
        super(
            'shell',
            '在设备上执行任意 hdc shell 命令并返回设备端输出（stdout / stderr / 退出码）。' +
                '用于框架未覆盖的场景：查询系统信息、查看文件、执行 bm/aa/hidumper 等运维命令。' +
                '注意：命令直接在设备端执行，删除文件、修改系统配置等破坏性操作须谨慎；' +
                '已有专用工具（openApp/appLifecycle/pressKey/screenshot 等）的场景优先使用专用工具',
            ShellArgsSchema,
            'tools.harmony.shell.name'
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof ShellArgsSchema>): Promise<string> {
        try {
            const deviceId = await tryResolveDeviceId(args.deviceId);
            const output = await runHdc(['shell', args.command], args.timeout ?? 15000, deviceId);
            return ok({ output });
        } catch (err) {
            // 命令非零退出时 execFile 抛错，错误对象携带 stdout/stderr/exit code，尽量原样返回设备端输出
            const e = err as { stdout?: string; stderr?: string; code?: number };
            if (e !== null && typeof e === 'object' && (e.stdout !== undefined || e.stderr !== undefined)) {
                return ok({
                    output: e.stdout ?? '',
                    stderr: e.stderr ?? '',
                    exitCode: e.code ?? 1
                });
            }
            return fail(`Failed to run shell command: ${err}`);
        }
    }
}

// ========== getDeviceInfo ==========

const GetDeviceInfoArgsSchema = z.object({
    deviceId: DeviceIdSchema
});

/** Reads a device system property via `param get`, trimming the value; returns undefined on any failure. */
async function getDeviceParam(name: string, deviceId?: string): Promise<string | undefined> {
    try {
        const out = await runHdc(['shell', 'param', 'get', name], 8000, deviceId);
        const value = out.trim();
        return value || undefined;
    } catch {
        return undefined;
    }
}

export class GetDeviceInfoTool extends HarmonyBaseTool<typeof GetDeviceInfoArgsSchema> {
    constructor() {
        super(
            'getDeviceInfo',
            '获取设备基本信息：型号、品牌、产品名、系统版本、SDK/API 版本、屏幕分辨率、WLAN IP。' +
                '分辨率为绝对坐标类操作（click/input/scroll 等）提供坐标换算与校验基准，也能用于判断设备形态（手机/平板/PC）。' +
                '单个字段读取失败不影响整体，缺失字段返回 undefined',
            GetDeviceInfoArgsSchema,
            'tools.harmony.getDeviceInfo.name'
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof GetDeviceInfoArgsSchema>): Promise<string> {
        try {
            const deviceId = await tryResolveDeviceId(args.deviceId);
            const [model, brand, productName, sysVersion, sdkVersion, displayOut, wlanOut] = await Promise.all([
                getDeviceParam('const.product.model', deviceId),
                getDeviceParam('const.product.brand', deviceId),
                getDeviceParam('const.product.name', deviceId),
                getDeviceParam('const.product.software.version', deviceId),
                getDeviceParam('const.ohos.apiversion', deviceId),
                runHdc(['shell', 'hidumper', '-s', 'RenderService', '-a', 'screen'], 10000, deviceId).catch(() => ''),
                runHdc(['shell', 'ifconfig'], 10000, deviceId).catch(() => '')
            ]);
            const sizeMatch = displayOut ? displayOut.match(/activeMode:\s*(\d+)x(\d+)/) : null;
            const displaySize = sizeMatch ? { width: Number(sizeMatch[1]), height: Number(sizeMatch[2]) } : undefined;
            const wlanIp = wlanOut ? wlanOut.match(/inet addr:(?!127)(\d+\.\d+\.\d+\.\d+)/)?.[1] : undefined;
            return ok({
                model,
                brand,
                productName,
                sysVersion,
                sdkVersion,
                displaySize,
                wlanIp
            });
        } catch (err) {
            return fail(`Failed to get device info: ${err}`);
        }
    }
}

// ========== pushFile / pullFile ==========

const PushFileArgsSchema = z.object({
    localPath: z.string().min(1).describe('本机源文件绝对路径'),
    remotePath: z.string().min(1).describe('设备端目标路径，如 /data/local/tmp/xxx'),
    deviceId: DeviceIdSchema
});

export class PushFileTool extends HarmonyBaseTool<typeof PushFileArgsSchema> {
    constructor() {
        super(
            'pushFile',
            '将本机文件推送到设备（等价于 hdc file send）。用于导入测试数据、HAP 包、配置文件等到设备端 /data/local/tmp 等目录。返回设备端路径',
            PushFileArgsSchema,
            'tools.harmony.pushFile.name'
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof PushFileArgsSchema>): Promise<string> {
        try {
            const deviceId = await tryResolveDeviceId(args.deviceId);
            const localPath = resolve(args.localPath);
            await statAsync(localPath);
            await runHdc(['file', 'send', localPath, args.remotePath], 30000, deviceId);
            return ok({ localPath, remotePath: args.remotePath, sent: true });
        } catch (err) {
            return fail(`Failed to push file: ${err}`);
        }
    }
}

const PullFileArgsSchema = z.object({
    remotePath: z.string().min(1).describe('设备端源文件路径'),
    localPath: z.string().min(1).describe('本机保存路径，支持绝对路径或相对路径（自动解析为绝对路径）'),
    deviceId: DeviceIdSchema
});

export class PullFileTool extends HarmonyBaseTool<typeof PullFileArgsSchema> {
    constructor() {
        super(
            'pullFile',
            '将设备端文件拉取到本机（等价于 hdc file recv）。用于提取设备端日志、截图、配置文件等。返回本机保存路径',
            PullFileArgsSchema,
            'tools.harmony.pullFile.name'
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof PullFileArgsSchema>): Promise<string> {
        try {
            const deviceId = await tryResolveDeviceId(args.deviceId);
            const localPath = resolve(args.localPath);
            await runHdc(['file', 'recv', args.remotePath, localPath], 30000, deviceId);
            return ok({ remotePath: args.remotePath, localPath, pulled: true });
        } catch (err) {
            return fail(`Failed to pull file: ${err}`);
        }
    }
}

// ========== installApp / uninstallApp ==========

const InstallAppArgsSchema = z.object({
    hapPath: z.string().min(1).describe('本机 .hap 安装包绝对路径'),
    deviceId: DeviceIdSchema
});

export class InstallAppTool extends HarmonyBaseTool<typeof InstallAppArgsSchema> {
    constructor() {
        super(
            'installApp',
            '通过 hdc 安装 .hap 应用到设备（等价于 hdc install）。安装前校验本机文件存在且为 .hap 后缀。' +
                '安装成功后如需启动应用请使用 openApp',
            InstallAppArgsSchema,
            'tools.harmony.installApp.name'
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof InstallAppArgsSchema>): Promise<string> {
        try {
            const hapPath = resolve(args.hapPath);
            if (!hapPath.toLowerCase().endsWith('.hap')) {
                return fail(`Not a .hap file: ${args.hapPath}`);
            }
            const deviceId = await tryResolveDeviceId(args.deviceId);
            await statAsync(hapPath);
            await runHdc(['install', hapPath], 120000, deviceId);
            return ok({ hapPath, installed: true });
        } catch (err) {
            return fail(`Failed to install app: ${err}`);
        }
    }
}

const UninstallAppArgsSchema = z.object({
    bundleName: BundleNameSchema,
    confirmDestructive: z
        .boolean()
        .default(false)
        .describe('卸载会删除应用及其全部数据，不可恢复，必须显式设为 true 才执行'),
    deviceId: DeviceIdSchema
});

export class UninstallAppTool extends HarmonyBaseTool<typeof UninstallAppArgsSchema> {
    constructor() {
        super(
            'uninstallApp',
            '卸载设备上的应用（等价于 hdc uninstall）。卸载是破坏性操作，会删除应用及其全部数据，' +
                '须显式传入 confirmDestructive: true 才执行',
            UninstallAppArgsSchema,
            'tools.harmony.uninstallApp.name'
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    private async handleExecute(args: z.output<typeof UninstallAppArgsSchema>): Promise<string> {
        try {
            if (!args.confirmDestructive) {
                return ok({
                    success: false,
                    error: `uninstallApp 是破坏性操作，请确认后传入 confirmDestructive: true 再卸载 ${args.bundleName}`
                });
            }
            const deviceId = await tryResolveDeviceId(args.deviceId);
            await runHdc(['uninstall', args.bundleName], 120000, deviceId);
            return ok({ bundleName: args.bundleName, uninstalled: true });
        } catch (err) {
            return fail(`Failed to uninstall app: ${err}`);
        }
    }
}

export function createUseHarmonyToolset(): BaseToolset {
    const toolset = new BaseToolset('use-harmony');
    toolset.addTool(new ListDevicesTool());
    toolset.addTool(new ListAppsTool());
    toolset.addTool(new OpenAppTool());
    toolset.addTool(new AppLifecycleTool());
    toolset.addTool(new ShellTool());
    toolset.addTool(new GetDeviceInfoTool());
    toolset.addTool(new PushFileTool());
    toolset.addTool(new PullFileTool());
    toolset.addTool(new InstallAppTool());
    toolset.addTool(new UninstallAppTool());

    toolset.addTool(new ListWindowsTool());
    toolset.addTool(new SnapshotTool());
    toolset.addTool(new ScreenshotTool());
    toolset.addTool(new ClickRefTool());
    toolset.addTool(new SelectOptionTool());
    toolset.addTool(new SystemDialogTool());
    toolset.addTool(new HandlePermissionTool());
    toolset.addTool(new ChooseFileTool());
    toolset.addTool(new DropFixtureTool());
    toolset.addTool(new ClickTool());
    toolset.addTool(new DoubleClickTool());
    toolset.addTool(new DragTool());
    toolset.addTool(new LongClickTool());
    toolset.addTool(new ScrollTool());
    toolset.addTool(new ScrollToTool());
    toolset.addTool(new ScrollInScrollableTool());
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
