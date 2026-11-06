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
 * embedBrowserUse — Main process browser controller and manager.
 *
 * BrowserController: per-instance controller with CDP automation logic.
 * BrowserManager: singleton that manages controllers and IPC bindings.
 */

import { Channels } from './protocol';
import type { BrowserState, TabInfo, PageSnapshot, IPCResponse, SnapshotExportResult } from './protocol';
import { CDPSession, CDPSessionManager, getCDPLogger, setCDPLogger, type JavaScriptDialogInfo } from './cdp/session';
import { captureSnapshot, resolveTargetCoords, type CapturedSnapshot } from './cdp/snapshot';
import {
    isNestedRef,
    parseRef,
    resolveNestedRefCoords,
    navigateToFrame,
    navigateIntoFrame,
    findNodeByRef,
    renderAriaTreeToYaml,
    diffTrees,
    shouldFallbackToFullDiff,
    buildRefMissNote,
    type AriaNode
} from './cdp/aria';
import { resolveKey, modifiersBitmask, sleep, withRetry, describeRuntimeException, describeRefMiss } from './cdp/utils';
import { OD_REF_QUERY_HELPER, OD_COMPOSED_ANCESTOR_HELPER, OD_VISIBLE_TEXT_HELPER } from './cdp/refQueryScript';
import type { CDPLogger } from './cdp/session';
import fs from 'node:fs/promises';
import path from 'node:path';

export type { CDPSession } from './cdp/session';
export { CDPSessionManager } from './cdp/session';
export { captureSnapshot, resolveTargetCoords } from './cdp/snapshot';
export {
    isNestedRef,
    parseRef,
    resolveNestedRefCoords,
    navigateToFrame,
    navigateIntoFrame,
    renderAriaTreeToYaml,
    mergeFrameTrees
} from './cdp/aria';
export type { AriaImageInfo, AriaNode, FrameAriaResult } from './cdp/aria';
export { resolveKey, modifiersBitmask, sleep, withRetry } from './cdp/utils';

// Re-export setCDPLogger so consumers can wire in their project logger
export { setCDPLogger };
export type { CDPLogger };

// ---------------------------------------------------------------------------
// Script generators interface for renderer bridge
// ---------------------------------------------------------------------------

/**
 * 脚本生成器接口。
 *
 * embedBrowserUse 是通用的 CDP 浏览器自动化库。与特定 UI 框架绑定的逻辑
 * 通过此接口注入。`beforeCallRenderer` 列表中的每个 hook 在调用 renderer
 * 桥接之前依次执行（如展开侧边栏、激活浏览器标签等）。
 */
export interface BrowserScriptGenerators {
    /** 调用 renderer 桥接之前执行的脚本生成器列表，按注册顺序执行 */
    beforeCallRenderer: Array<(id: string) => string>;
}

// ---------------------------------------------------------------------------
// Snapshot text rendering
// ---------------------------------------------------------------------------

/** 在页面中求值一段 JS 表达式并取回其值 */
export type BrowserPageEvaluator = (expression: string) => Promise<unknown>;

/**
 * 快照前缀段落提供者。
 *
 * embedBrowserUse 不感知宿主的扩展体系（如 OpenDesk 的插件系统）。宿主通过
 * `setSnapshotPrefixProvider` 注入本回调，即可在快照正文前追加自定义段落，
 * 库本身只负责把页面信息与求值能力传进来。
 */
export type SnapshotPrefixProvider = (
    snapshot: PageSnapshot,
    evaluate: BrowserPageEvaluator
) => Promise<string[]> | string[];

let _snapshotPrefixProvider: SnapshotPrefixProvider | undefined;

/** 注入快照前缀段落提供者；传入 undefined 可移除。 */
export function setSnapshotPrefixProvider(provider?: SnapshotPrefixProvider): void {
    _snapshotPrefixProvider = provider;
}

/**
 * 导出快照保存对话框的文案。
 *
 * embedBrowserUse 不依赖宿主的 i18n 体系：原生对话框的标题与文件类型过滤器
 * 由宿主按当前语言提供，库内只保留英文兜底。
 */
export interface SnapshotDialogTexts {
    /** 对话框标题。 */
    title: string;
    /** .txt 过滤器名称。 */
    textFiles: string;
    /** 所有文件过滤器名称。 */
    allFiles: string;
}

/**
 * 导出快照对话框文案提供者。
 *
 * 用 provider 而不是一次性注入字符串：宿主语言可在运行时切换（``t()`` 每次按
 * 当前设置解析），静态注入会在切换后变成旧语言的文案。
 */
export type SnapshotDialogTextsProvider = () => Partial<SnapshotDialogTexts>;

const DEFAULT_SNAPSHOT_DIALOG_TEXTS: SnapshotDialogTexts = {
    title: 'Save Snapshot',
    textFiles: 'Text Files',
    allFiles: 'All Files'
};

let _snapshotDialogTextsProvider: SnapshotDialogTextsProvider | undefined;

/** 注入导出快照对话框文案提供者；传入 undefined 回落到英文默认文案。 */
export function setSnapshotDialogTextsProvider(provider?: SnapshotDialogTextsProvider): void {
    _snapshotDialogTextsProvider = provider;
}

/** 解析当前要用的对话框文案：提供者缺失或抛错时回落到英文默认文案。 */
function resolveSnapshotDialogTexts(): SnapshotDialogTexts {
    try {
        return { ...DEFAULT_SNAPSHOT_DIALOG_TEXTS, ...(_snapshotDialogTextsProvider?.() ?? {}) };
    } catch {
        return { ...DEFAULT_SNAPSHOT_DIALOG_TEXTS };
    }
}

/** 以 CDP 会话为后端构造页面求值器。 */
export function makeSessionEvaluator(session: CDPSession): BrowserPageEvaluator {
    return async (expression: string) => {
        const result = await session.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true
        });
        if (result.exceptionDetails) {
            // description（含 message + stack）优先于 text（只是 "Uncaught" 前缀）
            throw new Error(describeRuntimeException(result.exceptionDetails));
        }
        return result.result.value;
    };
}

/**
 * 运行已注入的前缀提供者，返回要置于快照正文前的段落。
 * 提供者缺失或抛错时返回空数组：前缀属于附加信息，不应影响快照本身。
 */
export async function collectSnapshotPrefix(snapshot: PageSnapshot, session: CDPSession): Promise<string[]> {
    if (!_snapshotPrefixProvider) return [];
    try {
        return await _snapshotPrefixProvider(snapshot, makeSessionEvaluator(session));
    } catch {
        return [];
    }
}

/**
 * 导出快照到文件：抓取 → 保存对话框 → 写入磁盘。
 *
 * 任务浏览器标签（IPC handler）与浏览器应用（应用方法）共用这一份流程，避免
 * 两条路径各自维护一遍「一次性会话 + 对话框 + 写文件」而逐渐漂移。对话框文案
 * 由调用方按当前语言传入（见 `SnapshotDialogTexts`）。
 */
export async function exportSnapshotToFile(
    webContents: Electron.WebContents,
    texts: SnapshotDialogTexts
): Promise<SnapshotExportResult> {
    const { BrowserWindow, dialog } = await import('electron');

    // 一次性会话：抓完内容立刻释放，保存对话框的停留时间不占着 CDP 连接。
    // 若这条 attach 属于别的会话（导出时 debugger 已被浏览器控制器占用），
    // dispose 不会 detach，避免打断正在进行的自动化操作。
    const session = await CDPSession.create(webContents);
    let content: string;
    try {
        const snapshot: PageSnapshot = await captureSnapshot(session);
        content = renderSnapshotText(snapshot, {
            prefixLines: await collectSnapshotPrefix(snapshot, session)
        });
    } finally {
        session.dispose();
    }

    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dialogOptions = {
        title: texts.title,
        defaultPath: `snapshot-${timestamp}.txt`,
        filters: [
            { name: texts.textFiles, extensions: ['txt'] },
            { name: texts.allFiles, extensions: ['*'] }
        ]
    };
    const saveResult = win
        ? await dialog.showSaveDialog(win, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);

    if (saveResult.canceled || !saveResult.filePath) {
        return { canceled: true, filePath: null };
    }

    const fs = await import('node:fs/promises');
    await fs.writeFile(saveResult.filePath, content, 'utf8');
    return { canceled: false, filePath: saveResult.filePath };
}

/**
 * 将快照渲染为统一的文本文档：可选前缀段落 → 页面信息 → ARIA 正文。
 *
 * snapshot 工具、任务浏览器标签导出与浏览器应用导出共用该格式，
 * 避免同一份文本结构在多处各自拼装而逐渐漂移。
 */
export function renderSnapshotText(
    snapshot: PageSnapshot,
    options: { prefixLines?: readonly string[]; infoLines?: readonly string[] } = {}
): string {
    const lines: string[] = [...(options.prefixLines ?? [])];
    lines.push(`- Page URL: ${snapshot.url}`);
    if (snapshot.title) lines.push(`- Page Title: ${snapshot.title}`);
    lines.push(`- Viewport: ${snapshot.viewport.width}x${snapshot.viewport.height}`);
    if (snapshot.scroll.x || snapshot.scroll.y) lines.push(`- Scroll: ${snapshot.scroll.x},${snapshot.scroll.y}`);
    lines.push(...(options.infoLines ?? []));
    lines.push('');
    lines.push(ACCESSIBILITY_SNAPSHOT_HEADING);
    lines.push(snapshot.ariaSnapshot);
    return lines.join('\n');
}

/** ARIA 正文的段落标题，快照文本与操作后追加快照共用。 */
export const ACCESSIBILITY_SNAPSHOT_HEADING = '[Accessibility Snapshot]';

export interface BrowserUploadFileResult {
    target: string;
    tag: string;
    text: string;
    inputRef?: string;
    accept: string;
    multiple: boolean;
    files: Array<{ path: string; name: string; size: number }>;
    page?: Record<string, any> | null;
    dialog?: string;
    warning?: string;
}

interface ResolvedFileInput {
    tag: string;
    text: string;
    inputRef?: string;
    accept: string;
    multiple: boolean;
    strategy: string;
    error?: string;
}

interface BrowserUploadFilePayload {
    name: string;
    mimeType: string;
    lastModified: number;
    base64: string;
}

const SYNTHETIC_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.csv': 'text/csv',
    '.gif': 'image/gif',
    '.htm': 'text/html',
    '.html': 'text/html',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.json': 'application/json',
    '.md': 'text/markdown',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain',
    '.webp': 'image/webp',
    '.xml': 'application/xml',
    '.zip': 'application/zip'
};

// ---------------------------------------------------------------------------
// Generic renderer bridge scripts (no UI framework assumptions)
// ---------------------------------------------------------------------------

/**
 * 生成在 renderer 中调用浏览器元素方法的 IIFE 脚本。
 * 不包含 UI 布局逻辑（如展开侧边栏），由调用方显式处理。
 */
export function makeCallBrowserScript(id: string, method: string, args: unknown[]): string {
    const safeId = id.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const safeMethod = method.replace(/[^a-zA-Z0-9_]/g, '');
    const argsStr = args.map((a) => JSON.stringify(a)).join(',');
    return `(() => {
        var el = document.getElementById('task-${safeId}-artifacts');
        if (!el) return { error: 'Browser not available for task ${safeId}' };
        if (typeof el.${safeMethod} !== 'function') return { error: 'Method ${safeMethod} not available' };
        try {
            var r = el.${safeMethod}(${argsStr});
            return Promise.resolve(r)
                .then(function(result) {
                    el._suppressBrowserAutoSwitch = false;
                    return { result: result };
                })
                .catch(function(error) {
                    el._suppressBrowserAutoSwitch = false;
                    return { error: error && error.message ? error.message : String(error) };
                });
        } catch (error) {
            el._suppressBrowserAutoSwitch = false;
            return { error: error && error.message ? error.message : String(error) };
        }
    })()`;
}

/**
 * 生成在 renderer 中对 webview 执行异步脚本的 IIFE。
 * 不包含 UI 布局逻辑，由调用方显式处理。
 */
export function makeExecuteScriptOnBrowser(id: string, script: string): string {
    const safeId = id.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `(() => {
        var el = document.getElementById('task-${safeId}-artifacts');
        if (!el) return { error: 'Browser not available' };
        if (typeof el.browserExecuteScript !== 'function') return { error: 'Browser not initialized' };
        var p = el.browserExecuteScript(${JSON.stringify(script)});
        el._suppressBrowserAutoSwitch = false;
        return p
            .then(r => ({ result: r }))
            .catch(e => ({ error: e.message || String(e) }));
    })()`;
}

/**
 * Move focus for plain Tab/Shift+Tab inside a guest browser document. Sending a
 * native Tab through Electron can let focus escape from <webview> back into the
 * embedder UI, so this emulates the browser default focus step in page script
 * after giving page handlers a cancellable keydown event.
 */
export function makePressTabInDocumentScript(reverse: boolean): string {
    return `(() => {
        const reverse = ${reverse ? 'true' : 'false'};

        function makeTabEvent(type) {
            const ev = new KeyboardEvent(type, {
                key: 'Tab',
                code: 'Tab',
                bubbles: true,
                cancelable: true,
                shiftKey: reverse
            });
            try {
                Object.defineProperty(ev, 'keyCode', { get: function() { return 9; } });
                Object.defineProperty(ev, 'which', { get: function() { return 9; } });
            } catch {
                /* ignore */
            }
            return ev;
        }

        function deepestActive(root) {
            let active = root.activeElement || document.activeElement;
            while (active && active.shadowRoot && active.shadowRoot.activeElement) {
                active = active.shadowRoot.activeElement;
            }
            return active || document.body || document.documentElement;
        }

        function isElement(el) {
            return !!el && el.nodeType === Node.ELEMENT_NODE;
        }

        function isVisible(el) {
            if (!isElement(el)) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            if (el.closest('[hidden]')) return false;
            const rects = el.getClientRects();
            return rects.length > 0 || el === document.body || el === document.documentElement;
        }

        function isFocusable(el) {
            if (!isElement(el) || !isVisible(el)) return false;
            const tag = el.tagName.toLowerCase();
            if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
            if (tag === 'input' && String(el.type || '').toLowerCase() === 'hidden') return false;
            if (el.tabIndex < 0) return false;
            if (el.isContentEditable) return true;
            if (el.hasAttribute('tabindex')) return true;
            if ((tag === 'a' || tag === 'area') && el.hasAttribute('href')) return true;
            return ['button', 'input', 'select', 'textarea', 'iframe', 'object', 'embed', 'summary'].includes(tag);
        }

        function collectFocusable(root, out) {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
            let node = walker.nextNode();
            while (node) {
                if (isFocusable(node)) out.push(node);
                if (node.shadowRoot) collectFocusable(node.shadowRoot, out);
                node = walker.nextNode();
            }
        }

        function orderedFocusableElements() {
            const out = [];
            collectFocusable(document.body || document.documentElement, out);
            return out
                .map(function(el, index) {
                    return { el: el, index: index, tabIndex: el.tabIndex || 0 };
                })
                .sort(function(a, b) {
                    const aPositive = a.tabIndex > 0;
                    const bPositive = b.tabIndex > 0;
                    if (aPositive && bPositive && a.tabIndex !== b.tabIndex) return a.tabIndex - b.tabIndex;
                    if (aPositive !== bPositive) return aPositive ? -1 : 1;
                    return a.index - b.index;
                })
                .map(function(item) { return item.el; });
        }

        function describeElement(el) {
            if (!isElement(el)) return {};
            const tag = el.tagName ? el.tagName.toLowerCase() : '';
            const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '')
                .trim()
                .slice(0, 80);
            return { focusedTag: tag, focusedText: text };
        }

        const before = deepestActive(document);
        const eventTarget = before && before.dispatchEvent ? before : document.body || document.documentElement;
        const defaultAllowed = eventTarget.dispatchEvent(makeTabEvent('keydown'));
        let moved = false;

        if (defaultAllowed) {
            const focusables = orderedFocusableElements();
            if (focusables.length > 0) {
                let index = focusables.indexOf(before);
                if (index < 0) {
                    index = focusables.findIndex(function(el) {
                        return before && (el === before || el.contains(before));
                    });
                }
                const nextIndex = reverse
                    ? index <= 0 ? focusables.length - 1 : index - 1
                    : index < 0 || index >= focusables.length - 1 ? 0 : index + 1;
                const next = focusables[nextIndex];
                try {
                    next.focus({ preventScroll: false });
                } catch {
                    next.focus();
                }
                moved = true;
            }
        }

        const after = deepestActive(document);
        const keyupTarget = after && after.dispatchEvent ? after : eventTarget;
        keyupTarget.dispatchEvent(makeTabEvent('keyup'));

        return Object.assign({ handled: true, moved: moved }, describeElement(after));
    })()`;
}

// ---------------------------------------------------------------------------
// BrowserController — per-instance controller
// ---------------------------------------------------------------------------

/** 把自动处理的 JS 对话框信息格式化为操作结果中的一行回显。 */
function describeDialog(dialog: JavaScriptDialogInfo): string {
    const message = dialog.message.length > 120 ? dialog.message.slice(0, 120) + '…' : dialog.message;
    return `页面弹出 ${dialog.type} 对话框（已自动接受）: ${message}`;
}

/** evaluate 返回值不可序列化等 CDP/Electron 原始报错的统一转译（BUG-17）。 */
function translateEvaluateFailure(err: unknown): Error {
    const raw = err instanceof Error ? err.message : String(err);
    const serializationMarkers = [
        'object reference chain is too long',
        'object could not be serialized',
        'could not be cloned',
        'no js object handle',
        'circular'
    ];
    if (serializationMarkers.some((m) => raw.toLowerCase().includes(m))) {
        return new Error(
            `返回值无法序列化（原始错误: ${raw}）。请让表达式返回 JSON 字符串（如 JSON.stringify(...)）或仅提取需要的字段`
        );
    }
    // Electron 的 JS dialog manager 不支持 window.prompt()：页面调用直接抛
    // "prompt() is not supported."，既不会弹输入框，也不会有 dialog 回显。
    // 原样透出会让 agent 误以为是自己写的表达式有问题（压测发现）。
    if (raw.toLowerCase().includes('prompt() is not supported')) {
        return new Error(
            'Electron 不支持 window.prompt()：页面调用会直接抛错，不会弹出输入框，也不会产生 dialog 回显。' +
                '如需按指定值继续，请直接 type 到页面对应输入框，或用 evaluate 读取页面已渲染的元素值'
        );
    }
    return err instanceof Error ? err : new Error(raw);
}

/** Info about a tab that was opened by the action and is now active. */
export interface ActionNewTab {
    id?: number;
    title: string;
    url: string;
}

/**
 * What actually happened after an interactive action (click / type+submit):
 * whether a same-tab navigation occurred and/or a new tab was opened.
 * Lets callers report reality instead of silently returning stale state.
 */
export interface ActionOutcome {
    navigated: boolean;
    newTab: ActionNewTab | null;
}

/** Element actually sitting under the click point right before dispatch. */
export interface ClickHitElement {
    tag: string;
    text: string;
}

/**
 * Renderer 桥接调用超时。webContents.executeJavaScript 在 renderer 主线程
 * 忙/导航中/等待 beforeunload 时可能永久挂起（无响应即不 resolve），
 * 必须限时失败；否则一次挂起的调用会卡住独占锁队列，导致该任务后续
 * 所有浏览器操作（含 tabs）全部排队等死。
 */
export const RENDERER_CALL_TIMEOUT_MS = 15000;

/**
 * requireCDP 的就绪等待总预算。覆盖"webview 创建 → attach → 首个执行上下文"
 * 的首帧链路：事件驱动（did-attach-webview）+ 250ms 兜底轮询，真实站点慢首帧
 * 不再表现为"首次 snapshot 偶发需要重试"；真正不可用（DevTools 占用 debugger、
 * 页面崩溃）时按此预算快速失败，不会拖到独占锁看门狗。
 */
export const CDP_READY_BUDGET_MS = 10000;

/**
 * 独占锁看门狗超时。作为底层原语（CDP send / renderer 调用）超时之上的
 * 兜底保险：任何被忽略的挂起点（如 frame.executeJavaScript）都不会让
 * controller 队列永久阻塞，超时后自动释放锁并重置 CDP 会话自愈。
 * 取较大值以避免误杀 waitFor 等用户可配时长的合法长操作。
 */
export const LOCK_OP_TIMEOUT_MS = 180000;

/** Image format requested from a browser host's capture port. */
export interface BrowserScreenshotOptions {
    format: 'png' | 'jpeg';
    /** JPEG quality from 0 to 100; ignored for PNG. */
    quality?: number;
}

export interface BrowserRendererHost {
    isDestroyed(): boolean;
    webContents: {
        executeJavaScript(script: string): Promise<any>;
        send(channel: string, ...args: unknown[]): void;
        // webview 首帧等待依赖宿主窗口的 attach 事件，外部宿主必须透传这两个方法。
        on(event: 'did-attach-webview', listener: () => void): unknown;
        removeListener(event: 'did-attach-webview', listener: () => void): unknown;
    };
    /** Return a data URI in the requested format; empty results and errors never fall back to Electron. */
    captureBrowserScreenshot?(webContentsId: number, options: BrowserScreenshotOptions): Promise<string | null>;
}

export type BrowserSessionManager = Pick<CDPSessionManager, 'getSession' | 'dispose' | 'disposeAll'>;

/**
 * Use the host capture port when present, or native capturePage without attaching a CDP debugger.
 * A missing native WebContents returns null so each caller preserves its existing error envelope.
 */
async function captureBrowserScreenshot(
    host: BrowserRendererHost | null,
    webContentsId: number,
    options: BrowserScreenshotOptions
): Promise<string | null> {
    if (host?.captureBrowserScreenshot) {
        const captured = await host.captureBrowserScreenshot(webContentsId, options);
        if (!captured) throw new Error('Empty capture');
        return captured;
    }

    const { webContents } = await import('electron');
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) return null;
    // 首帧尚未渲染时 capturePage 可能返回空图，保留有限次数的退避重试。
    const image = await withRetry(
        async () => {
            const captured = await wc.capturePage();
            if (captured.isEmpty()) throw new Error('Empty capture');
            return captured;
        },
        { delays: [300, 600] }
    );
    const data = options.format === 'jpeg' ? image.toJPEG(options.quality ?? 70) : image.toPNG();
    return `data:image/${options.format};base64,${data.toString('base64')}`;
}

/**
 * Per-instance browser controller that encapsulates all CDP-based automation
 * operations. Each controller is associated with a unique instance ID
 * (typically a taskId) and a main BrowserWindow for renderer communication.
 */
export class BrowserController {
    public readonly id: string;
    private _mainWindow: BrowserRendererHost | null;
    private _cdpManager: BrowserSessionManager;
    private _beforeCallRendererHooks: BrowserScriptGenerators | undefined;

    // Serialize all browser actions to prevent concurrent CDP conflicts
    // (e.g. two type() calls interleaving keystrokes into wrong elements)
    private _actionQueue: Promise<any> = Promise.resolve();

    // New-tab / navigation detection window after an interactive action.
    // target=_blank links often activate their new tab a few hundred ms after
    // the click, so detection must poll instead of checking once.
    private _actionPollIntervalMs = 150;
    private _actionDetectWindowMs = 1000;

    constructor(
        id: string,
        mainWindow: BrowserRendererHost | null,
        beforeCallRendererHooks?: BrowserScriptGenerators,
        sessionManager: BrowserSessionManager = new CDPSessionManager()
    ) {
        this.id = id;
        this._mainWindow = mainWindow;
        this._cdpManager = sessionManager;
        this._beforeCallRendererHooks = beforeCallRendererHooks;
    }

    /**
     * Acquire an exclusive lock before executing `fn`.  All public action
     * methods are wrapped with this so that at most one CDP interaction
     * runs at a time per controller instance.
     *
     * A watchdog bounds each operation: if any inner primitive ever wedges
     * (e.g. an unguarded frame.executeJavaScript), the slot times out, the
     * stalled CDP sessions are reset (`_recoverAfterStall`) and the lock is
     * released, so one hung call can never permanently block the queue and
     * turn into a "必现" deadlock for the whole task.
     */
    private _withExclusiveLock<T>(fn: () => Promise<T>, timeoutMs: number = LOCK_OP_TIMEOUT_MS): Promise<T> {
        let releaseLock!: () => void;
        const nextSlot = new Promise<void>((resolve) => {
            releaseLock = resolve;
        });
        const waiting = this._actionQueue;
        this._actionQueue = nextSlot;
        return waiting.then(async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                if (timeoutMs > 0) {
                    return await Promise.race([
                        fn(),
                        new Promise<never>((_, reject) => {
                            timer = setTimeout(() => {
                                this._recoverAfterStall();
                                reject(
                                    new Error(
                                        `浏览器操作卡死超过 ${timeoutMs}ms，已自动解除阻塞并重置浏览器会话，请重试`
                                    )
                                );
                            }, timeoutMs);
                        })
                    ]);
                }
                return await fn();
            } finally {
                if (timer !== undefined) clearTimeout(timer);
                releaseLock();
            }
        });
    }

    /**
     * Self-heal after a stalled locked operation: dispose all CDP sessions so
     * orphaned in-flight commands fail fast and the next operation re-attaches
     * a fresh debugger instead of reusing the wedged connection.
     */
    private _recoverAfterStall(): void {
        try {
            this._cdpManager.disposeAll();
        } catch (err) {
            console.error(`Failed to reset CDP sessions after stall: ${err}`);
            return;
        }
        console.warn(`[browser:${this.id}] recovered from stalled operation; CDP sessions reset`);
    }

    setMainWindow(win: BrowserRendererHost | null): void {
        this._mainWindow = win;
    }

    // ---- CDP Session Access ----

    /**
     * Obtain a CDP session for this instance's active webview.
     * Flow: renderer → webContentsId → main process CDP attach.
     */
    async getCDPSession(): Promise<CDPSession | null> {
        try {
            const wcId = await this.callRendererBrowser('browserGetWebContentsId');
            if (wcId == null) return null;
            return await this._cdpManager.getSession(wcId);
        } catch {
            return null;
        }
    }

    /**
     * Get a healthy CDP session with retry + health check.
     *
     * 就绪等待是事件驱动的（BUG-29）：webview 尚未 attach 时，监听宿主窗口的
     * `did-attach-webview`，事件到达立即重试（250ms 兜底轮询防竞态），而不是
     * 盲等固定退避窗口——真实站点首帧慢（attach + 首个执行上下文建立可能远超
     * 数秒）时不会再"首次调用需要重试"。总预算有界（CDP_READY_BUDGET_MS），
     * 真正不可用（如 DevTools 占用 debugger）时按原样快速失败。
     */
    async requireCDP(): Promise<CDPSession> {
        let lastError: Error | undefined;
        const deadline = Date.now() + CDP_READY_BUDGET_MS;

        for (;;) {
            try {
                const session = await this.getCDPSession();
                if (!session) throw new Error('CDP session not available — browser may not be ready');
                const healthy = await session.isHealthy();
                if (!healthy) throw new Error('CDP session unhealthy — will retry');
                return session;
            } catch (err: any) {
                lastError = err instanceof Error ? err : new Error(String(err));
            }

            // 无宿主窗口（控制器已卸载）时没有可等待的就绪事件，立即失败
            if (!this._mainWindow || this._mainWindow.isDestroyed()) {
                throw lastError ?? new Error('CDP session not available — no main window');
            }
            if (Date.now() >= deadline) {
                throw lastError ?? new Error('CDP session not available — browser may not be ready');
            }

            // 事件驱动等待 attach：事件最多等 2s（期间到达则立即重试），
            // 未等到则短轮询兜底（attach 可能早于监听注册已发生）。
            const attached = await this._waitForWebviewAttach(Math.min(2000, deadline - Date.now()));
            if (!attached) await sleep(250);
        }
    }

    /**
     * 等待宿主窗口出现新的 webview attach 事件，最多 timeoutMs。
     * 返回是否等到事件（超时/窗口不可用返回 false，由调用方决定重试或失败）。
     */
    private _waitForWebviewAttach(timeoutMs: number): Promise<boolean> {
        if (timeoutMs <= 0) return Promise.resolve(false);
        const wc = this._mainWindow?.webContents;
        if (!wc || this._mainWindow!.isDestroyed()) return Promise.resolve(false);
        return new Promise<boolean>((resolve) => {
            const cleanup = () => {
                clearTimeout(timer);
                try {
                    wc.removeListener('did-attach-webview', onAttach);
                } catch {
                    /* window 已销毁 */
                }
            };
            const timer = setTimeout(() => {
                cleanup();
                resolve(false);
            }, timeoutMs);
            const onAttach = () => {
                cleanup();
                resolve(true);
            };
            try {
                wc.on('did-attach-webview', onAttach);
            } catch {
                cleanup();
                resolve(false);
            }
        });
    }

    /**
     * Native CDP input is safe only when the user already focused this webview.
     * Merely dispatching a mouse/key event to an unfocused guest can make
     * Chromium transfer focus away from the OpenDesk control the user is using.
     */
    private async _hasActiveWebviewFocus(): Promise<boolean> {
        try {
            return (await this.callRendererBrowser('browserHasActiveWebviewFocus')) === true;
        } catch {
            return false;
        }
    }

    private _makeDispatchKeyInDocumentScript(keyDesc: ReturnType<typeof resolveKey>, modMask: number): string {
        const ctrlKey = (modMask & 2) !== 0;
        const altKey = (modMask & 1) !== 0;
        const shiftKey = (modMask & 8) !== 0;
        const metaKey = (modMask & 4) !== 0;
        // 组合键（Ctrl/Cmd+A 这类）在合成事件里没有浏览器默认行为：绝不能再按
        // keyDesc.text 插入字符——此前 Ctrl+A 会往输入框里塞一个 'a'，既没选中
        // 又污染了用户数据。这里只补偿最常见的全选，其余组合键由调用方给警告。
        const isSelectAll = (ctrlKey || metaKey) && !altKey && String(keyDesc.key).toLowerCase() === 'a';
        return `(() => {
            var el = document.activeElement || document.body;
            var opts = {
                key: ${JSON.stringify(keyDesc.key)},
                code: ${JSON.stringify(keyDesc.code)},
                keyCode: ${keyDesc.keyCode},
                which: ${keyDesc.keyCode},
                bubbles: true, cancelable: true, view: window,
                ctrlKey: ${ctrlKey}, altKey: ${altKey},
                shiftKey: ${shiftKey}, metaKey: ${metaKey}
            };
            var allowed = el.dispatchEvent(new KeyboardEvent('keydown', opts));
            if (allowed && ${keyDesc.keyCode} === 13) {
                if (el.tagName === 'BUTTON' || (el.tagName === 'INPUT' && /^(submit|button)$/i.test(el.type || ''))) {
                    el.click();
                } else {
                    var form = el.closest && el.closest('form');
                    if (form) {
                        if (typeof form.requestSubmit === 'function') form.requestSubmit();
                        else form.submit();
                    }
                }
            } else if (allowed && ${modMask} !== 0) {
                if (${isSelectAll}) {
                    try {
                        if (typeof el.select === 'function') el.select();
                        else if (el.isContentEditable && document.execCommand) document.execCommand('selectAll');
                    } catch (e) { /* ignore */ }
                }
            } else if (allowed && ${JSON.stringify(keyDesc.text || '')}) {
                var text = ${JSON.stringify(keyDesc.text || '')};
                if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                    var start = typeof el.selectionStart === 'number' ? el.selectionStart : (el.value || '').length;
                    var end = typeof el.selectionEnd === 'number' ? el.selectionEnd : start;
                    var value = el.value || '';
                    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
                    if (setter) setter.call(el, value.slice(0, start) + text + value.slice(end));
                    el.selectionStart = el.selectionEnd = start + text.length;
                    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
                } else if (el.isContentEditable) {
                    el.textContent = (el.textContent || '') + text;
                    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
                }
            }
            el.dispatchEvent(new KeyboardEvent('keyup', opts));
        })()`;
    }

    /**
     * Move focus for plain Tab/Shift+Tab inside the guest document. Sending a
     * native Tab through Electron can let focus escape from <webview> back into
     * the embedder UI, so this path emulates the browser default focus step in
     * page script after giving page handlers a cancellable keydown event.
     */
    private _makePressTabInDocumentScript(reverse: boolean): string {
        return makePressTabInDocumentScript(reverse);
    }

    // ---- Renderer Bridge Methods ----

    /**
     * Call a method on the task's <task-artifacts> element.
     * Both synchronous return values and Promises are supported.
     */
    async callRendererBrowser(method: string, ...args: any[]): Promise<any> {
        if (!this._mainWindow || this._mainWindow.isDestroyed()) {
            throw new Error('No main window available');
        }

        // Run registered host hooks (e.g. prepare a renderable embedded browser).
        await this._beforeCallRenderer();

        const result = await this._executeInRendererWithTimeout(
            makeCallBrowserScript(this.id, method, args),
            RENDERER_CALL_TIMEOUT_MS,
            `renderer call ${method}`
        );

        if (result?.__e) throw new Error(result.__e);
        if (result?.error) throw new Error(result.error);
        return result?.__d ?? result?.result ?? result;
    }

    /**
     * Execute a script in the active webview and return the result.
     * Does NOT run beforeCallRenderer hooks — callers should handle that
     * explicitly if needed (e.g. via callRendererBrowser which does).
     */
    async runOnActiveWebview(script: string, timeoutMs: number = 12000): Promise<any> {
        if (!this._mainWindow || this._mainWindow.isDestroyed()) {
            throw new Error('No main window available');
        }

        const jsPromise = this._mainWindow.webContents.executeJavaScript(makeExecuteScriptOnBrowser(this.id, script));

        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            const result = await Promise.race([
                jsPromise,
                new Promise<never>((_, reject) => {
                    timeout = setTimeout(
                        () => reject(new Error(`webview script timed out after ${timeoutMs}ms`)),
                        timeoutMs
                    );
                })
            ]);

            if (result?.error) throw new Error(result.error);
            return result?.result;
        } finally {
            if (timeout !== undefined) clearTimeout(timeout);
        }
    }

    /**
     * Execute all registered beforeCallRenderer hooks.
     * Each hook generates a JS snippet that is injected into the renderer
     * to prepare the host browser runtime and apply any host-owned presentation policy.
     */
    private async _beforeCallRenderer(): Promise<void> {
        if (!this._mainWindow || this._mainWindow.isDestroyed()) return;
        if (!this._beforeCallRendererHooks) return;
        for (const hook of this._beforeCallRendererHooks.beforeCallRenderer) {
            await this._executeInRendererWithTimeout(
                `(() => { ${hook(this.id)} })()`,
                RENDERER_CALL_TIMEOUT_MS,
                'beforeCallRenderer hook'
            );
        }
    }

    /**
     * Run a script in the OpenDesk renderer, bounded by a timeout.
     * webContents.executeJavaScript can hang indefinitely when the renderer is
     * busy / navigating / waiting on beforeunload; without this guard a single
     * wedged renderer call would permanently block the controller's exclusive
     * lock queue (and thus every subsequent browser tool in the same task).
     */
    private async _executeInRendererWithTimeout(script: string, timeoutMs: number, label: string): Promise<any> {
        if (!this._mainWindow || this._mainWindow.isDestroyed()) {
            throw new Error('No main window available');
        }
        const jsPromise = this._mainWindow.webContents.executeJavaScript(script);

        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                jsPromise,
                new Promise<never>((_, reject) => {
                    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
                })
            ]);
        } finally {
            if (timeout !== undefined) clearTimeout(timeout);
        }
    }

    // ---- Page Info Helpers ----

    /**
     * Detect Chromium error pages (chrome-error://chromewebdata/) and extract the
     * underlying error code + details. Returns null when the page is not an error
     * page or the check itself fails (page in transition / execution context gone).
     *
     * @param timeoutMs Optional CDP command timeout. Polling callers (waitFor)
     *                  pass a short timeout so a wedged CDP connection cannot
     *                  stall the whole wait far beyond its deadline.
     */
    private async detectChromeError(session: CDPSession, timeoutMs?: number): Promise<string | null> {
        try {
            const result = await session.send(
                'Runtime.evaluate',
                {
                    expression: `(() => {
                    var href = location.href || '';
                    if (href.indexOf('chrome-error://') !== 0) return '';
                    var diag = document.getElementById('sub-frame-error-details') || document.getElementById('main-message');
                    var details = diag ? diag.innerText.trim() : '';
                    var heading = document.querySelector('.error-code') || document.querySelector('h1');
                    var code = heading ? heading.innerText.trim() : '';
                    return JSON.stringify({ code: code, details: details });
                })()`,
                    returnByValue: true
                },
                timeoutMs
            );
            const raw = result?.result?.value;
            if (typeof raw !== 'string' || raw === '') return null;
            const errInfo = JSON.parse(raw);
            return [errInfo.code, errInfo.details].filter(Boolean).join(': ') || 'Page failed to load';
        } catch {
            return null; // page may be reloading — let the caller decide
        }
    }

    /**
     * Read current page URL + title from a CDP session.
     */
    async readPageInfo(session: CDPSession): Promise<{ url: string; title: string; error?: string }> {
        const result = await session.send('Runtime.evaluate', {
            expression: `JSON.stringify({ url: location.href, title: document.title })`,
            returnByValue: true
        });
        const info = JSON.parse(result.result.value);

        // Detect Chromium error pages (chrome-error://chromewebdata/)
        if (typeof info.url === 'string' && info.url.startsWith('chrome-error://')) {
            const error = (await this.detectChromeError(session)) ?? 'Page failed to load (chrome-error)';
            return { url: info.url, title: info.title, error };
        }

        return info;
    }

    /**
     * Read compact page state after an action.
     */
    async readPageState(session: CDPSession): Promise<Record<string, any> | null> {
        try {
            const result = await session.send('Runtime.evaluate', {
                expression: `JSON.stringify({
                    url: location.href,
                    title: document.title,
                    scrollY: Math.round(window.scrollY),
                    scrollHeight: document.documentElement.scrollHeight,
                    viewportHeight: window.innerHeight,
                })`,
                returnByValue: true
            });
            return JSON.parse(result.result.value);
        } catch {
            return null;
        }
    }

    /**
     * Wait for click side-effects (navigation, new tab, DOM mutations) to settle.
     *
     * Strategy (in order):
     * 1. Poll within a short window: a click that opens a new tab (target=_blank)
     *    or triggers same-tab navigation is detected as soon as it happens.
     *    New tabs often activate several hundred ms after the click, so a single
     *    post-click check would miss them and keep reporting the OLD page.
     * 2. Otherwise (SPA interaction) → wait for DOM to stabilize via MutationObserver
     * 3. Hard timeout fallback → fixed 500ms delay
     *
     * Returns an ActionOutcome so callers can report what actually happened
     * (new tab info / navigation) instead of silently returning stale state.
     */
    async waitForClickCompletion(session: CDPSession, callback: () => Promise<void>): Promise<ActionOutcome> {
        // Record pre-action state
        let urlBefore: string | null = null;
        let wcIdBefore: number | null = null;
        try {
            const r = await session.send('Runtime.evaluate', {
                expression: 'location.href',
                returnByValue: true
            });
            urlBefore = r.result.value;
            wcIdBefore = session.webContentsId;
        } catch {
            /* page may be in transition */
        }

        await callback();

        // Poll for side-effects inside a short window (new-tab activation and
        // same-tab navigation are both checked each round).
        const deadline = Date.now() + this._actionDetectWindowMs;
        for (;;) {
            await sleep(this._actionPollIntervalMs);

            // 1) New tab opened & activated?
            if (wcIdBefore != null) {
                try {
                    const wcIdAfter = await this.callRendererBrowser('browserGetWebContentsId');
                    if (wcIdAfter != null && wcIdAfter !== wcIdBefore) {
                        const newTab = await this._describeActiveTab();
                        const newSession = await this.getCDPSession();
                        if (newSession) {
                            await newSession.waitForPageReady(8000);
                        }
                        return { navigated: false, newTab };
                    }
                } catch {
                    // Tab detection failed — fall through to URL check
                }
            }

            // 2) Same-tab navigation? A failed URL read also indicates a transition.
            try {
                const r = await session.send('Runtime.evaluate', {
                    expression: 'location.href',
                    returnByValue: true
                });
                const urlAfter = r.result.value;
                if (urlAfter !== urlBefore) {
                    await session.waitForPageReady(8000);
                    return { navigated: true, newTab: null };
                }
            } catch {
                await session.waitForPageReady(8000);
                return { navigated: true, newTab: null };
            }

            if (Date.now() >= deadline) break;
        }

        // 3) SPA interaction — wait for DOM (menu, dialog, lazy content, animations) to settle
        try {
            await session.waitForDOMStable(5000, 500);
        } catch {
            // MutationObserver couldn't be injected — fallback to fixed delay
            await sleep(500);
        }
        return { navigated: false, newTab: null };
    }

    /** Describe the currently active tab via the renderer bridge. */
    private async _describeActiveTab(): Promise<ActionNewTab | null> {
        try {
            const tabs = await this.callRendererBrowser('browserListTabs');
            if (!Array.isArray(tabs)) return null;
            const active = tabs.find((t: any) => t && t.active) ?? tabs[tabs.length - 1];
            if (!active || typeof active !== 'object') return null;
            return {
                id: active.id,
                title: String(active.title ?? ''),
                url: String(active.url ?? '')
            };
        } catch {
            return null;
        }
    }

    private _makeUploadTargetExpression(target: string): string {
        if (/^e\d+/.test(target)) {
            return `__odFindRef('${target}')`;
        }
        return `document.querySelector(${JSON.stringify(target)})`;
    }

    private _makeResolveFileInputScript(targetExpression: string, token: string): string {
        return `(async () => {
            ${OD_REF_QUERY_HELPER}
            ${OD_VISIBLE_TEXT_HELPER}
            var token = ${JSON.stringify(token)};
            var target = ${targetExpression};
            if (!target) return JSON.stringify({ error: 'Upload target not found. Call snapshot to refresh refs.' });

            function isFileInput(el) {
                return !!el && el.tagName === 'INPUT' && String(el.type || '').toLowerCase() === 'file';
            }
            function textOf(el) {
                return ((__odVisibleText(el) || el.value || '') + '').replace(/[\\s\\u00A0]+/g, ' ').trim().slice(0, 120);
            }
            function byId(id) {
                if (!id) return null;
                try {
                    return document.getElementById(id);
                } catch(e) {
                    return null;
                }
            }
            function firstFileInput(root) {
                if (!root || !root.querySelector) return null;
                try {
                    return root.querySelector('input[type="file"]');
                } catch(e) {
                    return null;
                }
            }
            function fromIdRefs(value) {
                if (!value) return null;
                var ids = String(value).split(/\\s+/).filter(Boolean);
                for (var i = 0; i < ids.length; i++) {
                    var el = byId(ids[i]);
                    if (isFileInput(el)) return { input: el, strategy: 'idref' };
                    var nested = firstFileInput(el);
                    if (nested) return { input: nested, strategy: 'idref-descendant' };
                }
                return null;
            }
            function fromLabel(label) {
                if (!label || label.tagName !== 'LABEL') return null;
                var forId = label.getAttribute('for');
                var byFor = byId(forId);
                if (isFileInput(byFor)) return { input: byFor, strategy: 'label-for' };
                var nested = firstFileInput(label);
                if (nested) return { input: nested, strategy: 'label-descendant' };
                return null;
            }
            function nearbyFileInput(el) {
                if (isFileInput(el)) return { input: el, strategy: 'target' };

                var labelResult = fromLabel(el);
                if (labelResult) return labelResult;

                if (el.closest) {
                    var closestLabel = el.closest('label');
                    labelResult = fromLabel(closestLabel);
                    if (labelResult) return labelResult;
                }

                var nested = firstFileInput(el);
                if (nested) return { input: nested, strategy: 'descendant' };

                var attrNames = ['aria-controls', 'data-controls', 'data-target', 'data-input', 'for'];
                for (var i = 0; i < attrNames.length; i++) {
                    var idResult = fromIdRefs(el.getAttribute && el.getAttribute(attrNames[i]));
                    if (idResult) return idResult;
                }

                var node = el.parentElement;
                var depth = 0;
                while (node && depth < 6) {
                    nested = firstFileInput(node);
                    if (nested) return { input: nested, strategy: 'ancestor-descendant' };
                    node = node.parentElement;
                    depth++;
                }

                var form = el.closest ? el.closest('form') : null;
                if (form) {
                    var formInputs = form.querySelectorAll('input[type="file"]');
                    if (formInputs.length === 1) return { input: formInputs[0], strategy: 'single-form-input' };
                }

                var allInputs = document.querySelectorAll('input[type="file"]');
                if (allInputs.length === 1) return { input: allInputs[0], strategy: 'single-page-input' };

                return null;
            }
            async function captureProgrammaticFileClick(el) {
                var captured = null;
                var clickError = '';
                var originalClick = HTMLInputElement.prototype.click;
                var originalShowPicker = HTMLInputElement.prototype.showPicker;

                HTMLInputElement.prototype.click = function() {
                    if (isFileInput(this)) {
                        captured = this;
                        return;
                    }
                    return originalClick.apply(this, arguments);
                };
                if (originalShowPicker) {
                    HTMLInputElement.prototype.showPicker = function() {
                        if (isFileInput(this)) {
                            captured = this;
                            return;
                        }
                        return originalShowPicker.apply(this, arguments);
                    };
                }

                try {
                    if (typeof el.click === 'function') el.click();
                    await new Promise(function(resolve) { setTimeout(resolve, 350); });
                } catch(e) {
                    clickError = e && e.message ? e.message : String(e);
                } finally {
                    HTMLInputElement.prototype.click = originalClick;
                    if (originalShowPicker) HTMLInputElement.prototype.showPicker = originalShowPicker;
                }

                if (captured) return { input: captured, strategy: 'captured-click' };
                var afterClick = nearbyFileInput(el);
                if (afterClick) return afterClick;
                if (clickError) return { error: clickError };
                return null;
            }

            var resolved = nearbyFileInput(target);
            if (!resolved) resolved = await captureProgrammaticFileClick(target);
            if (resolved && resolved.error) return JSON.stringify({ error: resolved.error });
            if (!resolved || !resolved.input) {
                return JSON.stringify({
                    error: 'No associated input[type=file] found for this target. Use the file input ref, its label ref, or the upload button ref from a fresh snapshot.'
                });
            }

            var input = resolved.input;
            if (input.disabled) return JSON.stringify({ error: 'The resolved file input is disabled.' });

            input.setAttribute('data-od-upload-token', token);
            return JSON.stringify({
                tag: target.tagName.toLowerCase(),
                text: textOf(target),
                inputRef: input.getAttribute('data-od-ref') || undefined,
                accept: input.getAttribute('accept') || '',
                multiple: !!input.multiple,
                strategy: resolved.strategy
            });
        })()`;
    }

    private _makeDispatchFileInputEventsScript(token: string): string {
        return `(() => {
            var input = document.querySelector('[data-od-upload-token="${token}"]');
            if (!input) return JSON.stringify({ fileCount: null, detachedBeforeEvents: true });
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            var files = Array.prototype.slice.call(input.files || []).map(function(file) {
                return { name: file.name, size: file.size, type: file.type };
            });
            input.removeAttribute('data-od-upload-token');
            return JSON.stringify({ fileCount: files.length, files: files });
        })()`;
    }

    private _makeSyntheticUploadScript(token: string, payloads: BrowserUploadFilePayload[]): string {
        return `(() => {
            var input = document.querySelector('[data-od-upload-token="${token}"]');
            if (!input) return JSON.stringify({ error: 'Resolved file input disappeared before files could be assigned.' });
            if (typeof DataTransfer !== 'function') return JSON.stringify({ error: 'DataTransfer API is not available in this frame.' });
            var payloads = ${JSON.stringify(payloads)};
            var dt = new DataTransfer();
            function base64ToBytes(base64) {
                var binary = atob(base64);
                var bytes = new Uint8Array(binary.length);
                for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                return bytes;
            }
            for (var i = 0; i < payloads.length; i++) {
                var payload = payloads[i];
                var file = new File([base64ToBytes(payload.base64)], payload.name, {
                    type: payload.mimeType,
                    lastModified: payload.lastModified
                });
                dt.items.add(file);
            }
            input.files = dt.files;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            var files = Array.prototype.slice.call(input.files || []).map(function(file) {
                return { name: file.name, size: file.size, type: file.type };
            });
            input.removeAttribute('data-od-upload-token');
            return JSON.stringify({ fileCount: files.length, files: files });
        })()`;
    }

    private _parseResolvedFileInput(raw: unknown): ResolvedFileInput {
        const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!info || typeof info !== 'object') {
            throw new Error('Failed to resolve upload target: empty result');
        }
        const resolved = info as ResolvedFileInput;
        if (resolved.error) throw new Error(resolved.error);
        return resolved;
    }

    private async _resolveUploadInput(
        session: CDPSession,
        target: string,
        token: string
    ): Promise<{ frame: Electron.WebFrameMain | null; input: ResolvedFileInput }> {
        if (/^e\d+/.test(target) && isNestedRef(target)) {
            const { frame, elementRef } = await navigateToFrame(
                session.webContents.mainFrame,
                target,
                this._buildFrameUrlIndex()
            );
            const script = this._makeResolveFileInputScript(`__odFindRef('${elementRef}')`, token);
            const raw = await frame.executeJavaScript(script);
            const input = this._parseResolvedFileInput(raw);
            // 帧内 DOM 上的 data-od-ref 是帧内局部 ref（如 "e7"），嵌套 ref 的
            // 完整形式是 "e8-e7"（前缀只存在于宿主侧合并树中）。原样返回会让
            // agent 拿主页面命名空间的 ref 去定位（BUG-12），这里补全前缀。
            if (input.inputRef && elementRef) {
                input.inputRef =
                    input.inputRef === elementRef
                        ? target
                        : target.slice(0, target.length - elementRef.length) + input.inputRef;
            }
            return { frame, input };
        }

        const script = this._makeResolveFileInputScript(this._makeUploadTargetExpression(target), token);
        const result = await session.send('Runtime.evaluate', {
            expression: script,
            awaitPromise: true,
            returnByValue: true
        });
        if (result.exceptionDetails) {
            throw new Error(describeRuntimeException(result.exceptionDetails));
        }
        return { frame: null, input: this._parseResolvedFileInput(result.result.value) };
    }

    private async _dispatchUploadEventsInMainFrame(session: CDPSession, token: string): Promise<void> {
        const result = await session.send('Runtime.evaluate', {
            expression: this._makeDispatchFileInputEventsScript(token),
            returnByValue: true
        });
        if (result.exceptionDetails) {
            throw new Error(describeRuntimeException(result.exceptionDetails));
        }
        const info = JSON.parse(result.result.value);
        if (info.error) throw new Error(info.error);
    }

    private async _setFilesViaCDP(session: CDPSession, token: string, filePaths: string[]): Promise<void> {
        const doc = await session.send('DOM.getDocument', { depth: -1, pierce: true });
        const node = await session.send('DOM.querySelector', {
            nodeId: doc.root.nodeId,
            selector: `[data-od-upload-token="${token}"]`
        });
        if (!node.nodeId) {
            throw new Error('Resolved file input disappeared before files could be assigned.');
        }
        await session.send('DOM.setFileInputFiles', {
            nodeId: node.nodeId,
            files: filePaths
        });
        await this._dispatchUploadEventsInMainFrame(session, token);
    }

    private _guessMimeType(filePath: string): string {
        return MIME_TYPES_BY_EXTENSION[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    }

    private async _createSyntheticFilePayloads(filePaths: string[]): Promise<BrowserUploadFilePayload[]> {
        const stats = await Promise.all(filePaths.map((filePath) => fs.stat(filePath)));
        const totalBytes = stats.reduce((sum, stat) => sum + stat.size, 0);
        if (totalBytes > SYNTHETIC_UPLOAD_MAX_BYTES) {
            throw new Error(
                `Cannot upload ${Math.round(totalBytes / 1024 / 1024)} MB through an iframe fallback; target the file input in the main frame or use files under ${Math.round(SYNTHETIC_UPLOAD_MAX_BYTES / 1024 / 1024)} MB.`
            );
        }

        const payloads: BrowserUploadFilePayload[] = [];
        for (let i = 0; i < filePaths.length; i++) {
            const filePath = filePaths[i];
            const buffer = await fs.readFile(filePath);
            payloads.push({
                name: path.basename(filePath),
                mimeType: this._guessMimeType(filePath),
                lastModified: Math.round(stats[i].mtimeMs),
                base64: buffer.toString('base64')
            });
        }
        return payloads;
    }

    private async _setFilesViaSyntheticFrame(
        frame: Electron.WebFrameMain,
        token: string,
        filePaths: string[]
    ): Promise<void> {
        const payloads = await this._createSyntheticFilePayloads(filePaths);
        const raw = await frame.executeJavaScript(this._makeSyntheticUploadScript(token, payloads));
        const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (info?.error) throw new Error(info.error);
    }

    private async _clearUploadToken(
        session: CDPSession,
        frame: Electron.WebFrameMain | null,
        token: string
    ): Promise<void> {
        const script = `(() => {
            var input = document.querySelector('[data-od-upload-token="${token}"]');
            if (input) input.removeAttribute('data-od-upload-token');
        })()`;
        try {
            if (frame) {
                await frame.executeJavaScript(script);
            } else {
                await session.send('Runtime.evaluate', { expression: script });
            }
        } catch {
            /* best effort cleanup */
        }
    }

    private async _describeUploadFiles(
        filePaths: string[]
    ): Promise<Array<{ path: string; name: string; size: number }>> {
        const files: Array<{ path: string; name: string; size: number }> = [];
        for (const filePath of filePaths) {
            const stat = await fs.stat(filePath);
            files.push({
                path: filePath,
                name: path.basename(filePath),
                size: stat.size
            });
        }
        return files;
    }

    // ---- High-Level Operations (used by agent tools) ----

    async navigate(
        url: string,
        newTab: boolean = false
    ): Promise<{ url: string; title: string; error?: string; dialog?: string; note?: string }> {
        return this._withExclusiveLock(async () => {
            // 导航前的页面 URL：用于识别"根本没能导航"的情况（下载资源等）
            let urlBefore: string | undefined;
            if (!newTab) {
                try {
                    const beforeSession = await this.getCDPSession();
                    if (beforeSession) urlBefore = (await this.readPageInfo(beforeSession)).url;
                } catch {
                    urlBefore = undefined;
                }
            }
            // Normalize URL
            try {
                new URL(url);
            } catch {
                if (url.startsWith('localhost') || /^\d+\.\d+\.\d+\.\d+/.test(url)) url = 'http://' + url;
                else if (!url.includes('://')) url = 'https://' + url;
            }

            const NAVIGATE_TIMEOUT = 20000;

            const navigateAndWait = async (): Promise<{ url: string; title: string; error?: string }> => {
                if (newTab) {
                    await this.callRendererBrowser('browserAddTab', url);
                } else {
                    await this.callRendererBrowser('browserNavigate', url);
                }

                await sleep(400);

                const session = await this.getCDPSession();
                if (session) {
                    // Leave room for the DOM-stable wait below so the combined
                    // budget stays under NAVIGATE_TIMEOUT.
                    await session.waitForPageReady(NAVIGATE_TIMEOUT - 5000);
                    // SPA pages render their content asynchronously after the
                    // JS context is ready; without this wait an auto-snapshot
                    // taken right after navigation captures a mostly empty page.
                    await session.waitForDOMStable(3000, 500);
                    await sleep(200);
                    const info = await this.readPageInfo(session);
                    if (info.error) {
                        return { url, title: '', error: `页面加载失败: ${info.error} (请求地址: ${url})` };
                    }
                    if (info.url && info.url !== 'about:blank') {
                        return { url: info.url, title: info.title };
                    }
                }

                return { url, title: '(页面加载中)' };
            };

            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
                const result = await Promise.race([
                    navigateAndWait(),
                    new Promise<never>((_, reject) => {
                        timeout = setTimeout(
                            () =>
                                reject(
                                    new Error(
                                        `导航超时（${NAVIGATE_TIMEOUT / 1000}秒）：无法加载 ${url}，网址可能不可用或网络连接异常`
                                    )
                                ),
                            NAVIGATE_TIMEOUT
                        );
                    })
                ]);
                // 跨页导航后旧快照树整体失效：diff 模式若仍以旧树为基准，会输出
                // 上一页的 removed 集合与个别残留节点（观察为导航后自动快照
                // 返回垃圾 diff）。清空缓存强制下一次快照走 full。
                this.invalidateSnapshotBaseline();
                const merged = this._mergeNavDialog(result, await this.getCDPSession());
                const note = this._buildNavNoopNote(urlBefore, merged.url, url, newTab, merged.error);
                return note ? { ...merged, note } : merged;
            } finally {
                if (timeout !== undefined) clearTimeout(timeout);
            }
        });
    }

    /** Cache of the last full ARIA tree, used by explore() and diff mode. */
    private _lastTree?: AriaNode;

    /** URL of the last snapshot, used to detect cross-page navigation on ref miss. */
    private _lastUrl?: string;

    /**
     * 快照基线世代号：每次写入/丢弃基线自增。
     *
     * diff 快照的"上一棵树"是共享状态，并发（或与 explore/导航/切标签交错）时
     * 后到的请求会以别人刚写入的树为基准，输出被吞掉一部分的 diff（甚至
     * "(no changes)"），看起来自相矛盾。请求进入排队时先记下世代号，锁内若发现
     * 基线已被推进，就退回完整快照，宁可多几行也不给出失真的 diff。
     */
    private _baselineSeq = 0;

    /** 丢弃快照基线（跨页导航、切换/关闭标签页后旧树属于另一个页面）。 */
    invalidateSnapshotBaseline(): void {
        this._lastTree = undefined;
        this._lastUrl = undefined;
        this._baselineSeq += 1;
    }

    async snapshot(opts: { mode?: 'full' | 'diff'; viewportOnly?: boolean; ref?: string } = {}): Promise<PageSnapshot> {
        // 在等锁之前记下基线世代（见 _baselineSeq 说明）
        const requestedSeq = this._baselineSeq;
        return this._withExclusiveLock(async () => {
            const session = await this.requireCDP();
            const captured: CapturedSnapshot = await captureSnapshot(session, { viewportOnly: opts.viewportOnly });
            const baselineIntact = requestedSeq === this._baselineSeq;
            const prev = baselineIntact ? this._lastTree : undefined;
            const prevUrl = baselineIntact ? this._lastUrl : undefined;
            this._lastTree = captured.tree;
            this._lastUrl = captured.url;
            this._baselineSeq += 1;

            // 指定 ref 时只渲染该节点的完整子树（实时抓取，不依赖折叠状态）。
            // 用于大快照被截断时按需取某个区域（如商品价格区），无需 evaluate 兜底。
            if (opts.ref) {
                const node = findNodeByRef(captured.tree, opts.ref);
                if (!node) {
                    // 自动降级：ref 失效时返回完整折叠快照并说明原因，让 agent
                    // 无需额外调用即可基于新 ref 继续，而不是收到一句泛化的报错。
                    const note = buildRefMissNote(opts.ref, prevUrl, captured.url);
                    return { ...captured, ariaSnapshot: note + '\n' + captured.ariaSnapshot };
                }
                const yaml = renderAriaTreeToYaml({ role: 'fragment', name: '', children: [node], props: {} }, false);
                return { ...captured, ariaSnapshot: yaml };
            }

            if (opts.mode === 'diff' && prev) {
                // 跨页守卫：缓存的上一棵树来自不同 URL（如页面 JS 自发起的顶层
                // 跳转绕过了 navigate() 记账）时，diff 会以旧页为基准输出跨页
                // 垃圾，此时强制回退完整快照。
                if (prevUrl !== undefined && prevUrl !== captured.url) return captured;
                const diff = diffTrees(prev, captured.tree);
                // 变化过大（如跨页导航整树替换）时 diff 反而比 full 大，回退折叠版完整快照
                if (shouldFallbackToFullDiff(diff)) return captured;
                return { ...captured, ariaSnapshot: diff.yaml || '(no changes)' };
            }
            return captured;
        });
    }

    /** URL of the most recent snapshot, or undefined if none taken yet. */
    getLastUrl(): string | undefined {
        return this._lastUrl;
    }

    /**
     * 导航动作（navigate/goBack/goForward/reload）的对话框回显：导航是
     * beforeunload 对话框的主要触发源，但这类动作不经过 click/type 的
     * takeLastDialog 消费点——不在这里取出的话，对话框信息会滞留在会话上，
     * 错挂到下一个无关操作的结果里。
     */
    private _mergeNavDialog<T extends Record<string, any>>(info: T, session: CDPSession | null): T {
        const dialog = session?.takeLastDialog();
        return dialog ? { ...info, dialog: describeDialog(dialog) } : info;
    }

    /**
     * navigate 到"会触发下载的资源"（Content-Disposition / 二进制响应）时，
     * Chromium 只发起下载、不做页面导航：调用方此前只看到"URL 还是旧页面"，
     * 既没有 error 也没有任何提示，于是会反复重试（每次都多下载一份文件）。
     * 这里把"导航未发生"明确说出来，并指出可能的下载原因。
     */
    private _buildNavNoopNote(
        urlBefore: string | undefined,
        urlAfter: string,
        target: string,
        newTab: boolean,
        error?: string
    ): string | undefined {
        if (error || newTab || !urlBefore) return undefined;
        if (urlAfter !== urlBefore) return undefined;
        const norm = (value: string): string => {
            try {
                return new URL(value).href;
            } catch {
                return value;
            }
        };
        // 同址导航（等价于 reload）不算异常
        if (norm(target) === norm(urlBefore)) return undefined;
        return (
            `导航未发生：页面仍停留在 ${urlAfter}。` +
            '目标地址可能触发了文件下载、被页面策略拦截，或加载后被重定向回原页面'
        );
    }

    /** 读取 frame 的当前 URL；frame 已销毁/不可访问时返回 null。 */
    private _safeFrameUrl(frame: Electron.WebFrameMain | null): string | null {
        if (!frame) return null;
        try {
            return frame.url;
        } catch {
            return null;
        }
    }

    /**
     * 从缓存快照树收集 iframe 节点在快照时的真实内容 URL（frameUrl）。
     *
     * iframe 元素的 src 属性在 JS 导航后不会更新（el.src 是陈旧的），操作端
     * 按 src 匹配子 frame 会错配或静默命中旧 frame。快照合并时已把每个子
     * frame 的真实 URL 记录到 iframe 节点（frameUrl），操作端据此校验：
     * frame 当前 URL 与快照时不一致 ⇒ 该 iframe 已导航，旧 ref 全部失效。
     */
    private _buildFrameUrlIndex(): Map<string, string> {
        const map = new Map<string, string>();
        const walk = (node: AriaNode): void => {
            if (node.role === 'iframe' && node.ref && node.frameUrl) {
                map.set(node.ref, node.frameUrl);
            }
            for (const child of node.children) {
                if (typeof child !== 'string') walk(child);
            }
            if (node.collapsedSiblings) for (const sib of node.collapsedSiblings) walk(sib);
        };
        if (this._lastTree) walk(this._lastTree);
        return map;
    }

    /**
     * 探测焦点所在的 iframe 链（BUG-05）。
     *
     * 从主 frame 开始逐层检查 activeElement：是带 data-od-ref 的 IFRAME 时
     * 进入其内容文档继续探测，直到焦点落在普通元素上。返回嵌套 iframeRef
     * （如 "e8-e4"）；焦点在主文档或 iframe 无 ref（未做过 snapshot）时返回 null。
     */
    private async _resolveFocusedFrameChain(session: CDPSession): Promise<string | null> {
        // 探针只读取 activeElement 自身的 data-od-ref，无需 __odFindRef 下钻
        const probe = `(() => {
            var el = document.activeElement;
            if (el && el.tagName === 'IFRAME') {
                var ref = el.getAttribute('data-od-ref');
                if (ref) return JSON.stringify({ iframeRef: ref });
                return JSON.stringify({ iframeRef: null, unrefedIframe: true });
            }
            return JSON.stringify({ iframeRef: null });
        })()`;

        try {
            const r = await session.send('Runtime.evaluate', { expression: probe, returnByValue: true });
            const first = JSON.parse(r.result?.value ?? '{}');
            if (!first.iframeRef) return null;
            const chain: string[] = [first.iframeRef as string];
            // 逐层深入（上限 5 层防环形结构）；某层探测失败即停，用已知的链路由
            for (let depth = 0; depth < 5; depth++) {
                let frame: Electron.WebFrameMain;
                try {
                    frame = await navigateIntoFrame(session.webContents.mainFrame, chain.join('-'));
                } catch {
                    break;
                }
                try {
                    const raw = (await frame.executeJavaScript(probe)) as string;
                    const next = JSON.parse(raw);
                    if (next.iframeRef) chain.push(next.iframeRef as string);
                    else break;
                } catch {
                    break;
                }
            }
            return chain.join('-');
        } catch {
            return null;
        }
    }

    /** Read the active page's URL and title without capturing a snapshot. */
    async getPageInfo(): Promise<{ url: string; title: string }> {
        return this._withExclusiveLock(async () => {
            const session = await this.requireCDP();
            const info = await this.readPageInfo(session);
            return { url: info.url, title: info.title };
        });
    }

    /**
     * Expand a single ref into its full (uncollapsed) ARIA subtree.
     *
     * The default snapshot collapses noisy regions (iframes, footers, deep
     * decoration) into one-line summaries. explore(ref) reveals the complete
     * content behind any ref so the agent can drill into a region on demand
     * without bloating every snapshot.
     */
    async explore(ref: string): Promise<{ ariaSnapshot: string }> {
        return this._withExclusiveLock(async () => {
            // 每次实时抓取而不是读缓存：缓存的树可能是 iframe 被移除/页面变化前
            // 的陈旧内容（此前 explore 会把已删除 iframe 的旧子树原样返回）。
            // ref 印在 DOM 的 data-od-ref 上，重复抓取不会改变已有 ref。
            const session = await this.requireCDP();
            const captured = await captureSnapshot(session);
            this._lastTree = captured.tree;
            this._lastUrl = captured.url;
            this._baselineSeq += 1;
            const node = findNodeByRef(captured.tree, ref);
            if (!node) {
                // 未命中按失败返回（此前返回 success:true + 提示文本，语义矛盾）
                throw new Error(describeRefMiss(ref));
            }
            const yaml = renderAriaTreeToYaml({ role: 'fragment', name: '', children: [node], props: {} }, false);
            return { ariaSnapshot: yaml };
        });
    }

    async click(
        target: string,
        options: { button?: 'left' | 'right' | 'middle'; doubleClick?: boolean; modifiers?: string[] } = {}
    ): Promise<{
        target: string;
        tag: string;
        text: string;
        page?: Record<string, any> | null;
        newTab: ActionNewTab | null;
        hitElement?: ClickHitElement;
        dialog?: string;
        warning?: string;
    }> {
        return this._withExclusiveLock(async () => {
            const session = await this.requireCDP();
            // 页面可能在点击后弹出 confirm()/alert()：先启用对话框接管，
            // 否则对话框会把在途的 frame.executeJavaScript 挂到看门狗超时。
            await session.ensureDialogHandling();
            const modMask = modifiersBitmask(options.modifiers);
            const clickCount = options.doubleClick ? 2 : 1;
            const button = options.button || 'left';
            const isRef = /^e\d+/.test(target);
            const isNested = isRef && isNestedRef(target);
            // 嵌套 ref（iframe 内元素）同样可以走原生输入：CDP Input 事件按视口
            // 坐标由 compositor 命中测试路由到正确的 frame（含 OOPIF）——这让
            // 修饰键点击（Ctrl+点击新标签页）与受控编辑器的真实按键在 iframe 内
            // 也生效，而不是被合成事件静默降级（BUG-31/32）。焦点安全门槛不变。
            const useNativeInput = await this._hasActiveWebviewFocus();
            // 遮挡元素在下方 waitForClickCompletion 的回调里异步写入：用一个 holder 承载，
            // 否则 TS 的控制流分析看不到闭包内的赋值，会把 `let x = null` 一直收窄成 null。
            const hitElementRef: { current: ClickHitElement | null } = { current: null };
            let targetInfo: { tag: string; text: string };
            let warning: string | undefined;

            if (!useNativeInput) {
                let targetFrame: Electron.WebFrameMain | null = null;
                let targetExpr: string;
                if (isNested) {
                    const nav = await navigateToFrame(
                        session.webContents.mainFrame,
                        target,
                        this._buildFrameUrlIndex()
                    );
                    targetFrame = nav.frame;
                    targetExpr = `__odFindRef('${nav.elementRef}')`;
                } else {
                    targetExpr = isRef
                        ? `__odFindRef('${target}')`
                        : `document.querySelector(${JSON.stringify(target)})`;
                }
                const isolatedClickScript = `(() => {
                    ${OD_REF_QUERY_HELPER}
                    ${OD_COMPOSED_ANCESTOR_HELPER}
                    ${OD_VISIBLE_TEXT_HELPER}
                    var el = ${targetExpr};
                    if (!el) return JSON.stringify({ error: ${
                        isRef
                            ? JSON.stringify(describeRefMiss(target))
                            : JSON.stringify(
                                  `Element not found for selector ${JSON.stringify(target)}. CSS 选择器只匹配主文档，iframe 内的元素请使用 snapshot 返回的 ref 定位。`
                              )
                    } });
                    // Synthetic (isTrusted=false) mouse events never trigger the
                    // browser's default focus-on-mousedown behavior, so clicking
                    // a text-entry control would leave document.activeElement on
                    // <body> and later focus-dependent input would land nowhere.
                    // Focus in-page first: el.focus() only moves
                    // document.activeElement inside the guest, it never steals OS
                    // focus from the user, so this stays safe for background tasks.
                    if (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
                        try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
                    }
                    // 遮挡校验（与 native 输入路径同一语义）：命中点元素与目标
                    // 不一致时仍执行点击（保证自动化成功率），但把 hitElement
                    // 带回给调用方生成 warning，让 agent 知道"真实用户点不到"。
                    // elementFromPoint 对 shadow 内元素 retarget 成宿主，组合树
                    // 祖先关系（跨越 shadow 边界）不算遮挡。
                    var hitElement = null;
                    try {
                        var rect = el.getBoundingClientRect();
                        var cx = Math.round(rect.left + rect.width / 2);
                        var cy = Math.round(rect.top + rect.height / 2);
                        var hit = cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight
                            ? document.elementFromPoint(cx, cy)
                            : null;
                        if (hit && hit !== el && !isComposedAncestor(el, hit) && !isComposedAncestor(hit, el)) {
                            hitElement = {
                                tag: hit.tagName.toLowerCase(),
                                text: (__odVisibleText(hit) + '').trim().slice(0, 80)
                            };
                        }
                    } catch (e) { /* best-effort */ }
                    var opts = {
                        bubbles: true, cancelable: true, view: window,
                        button: ${button === 'right' ? 2 : button === 'middle' ? 1 : 0},
                        buttons: 0,
                        ctrlKey: ${(modMask & 2) !== 0}, altKey: ${(modMask & 1) !== 0},
                        shiftKey: ${(modMask & 8) !== 0}, metaKey: ${(modMask & 4) !== 0}
                    };
                    el.dispatchEvent(new MouseEvent('mousedown', { ...opts, buttons: 1 }));
                    el.dispatchEvent(new MouseEvent('mouseup', opts));
                    if (${JSON.stringify(button)} === 'right') {
                        el.dispatchEvent(new MouseEvent('contextmenu', opts));
                    } else if (${JSON.stringify(button)} === 'middle') {
                        el.dispatchEvent(new MouseEvent('auxclick', opts));
                    } else if (${clickCount} === 2) {
                        el.click();
                        el.click();
                        el.dispatchEvent(new MouseEvent('dblclick', { ...opts, detail: 2 }));
                    } else if (${modMask} === 0) {
                        el.click();
                    } else {
                        el.dispatchEvent(new MouseEvent('click', { ...opts, detail: 1 }));
                    }
                    return JSON.stringify({
                        tag: el.tagName.toLowerCase(),
                        text: __odVisibleText(el).trim().slice(0, 80),
                        hitElement: hitElement
                    });
                })()`;
                let isolatedResult: string;
                const outcome = await this.waitForClickCompletion(session, async () => {
                    if (targetFrame) {
                        isolatedResult = (await targetFrame.executeJavaScript(isolatedClickScript)) as string;
                    } else {
                        const result = await session.send('Runtime.evaluate', {
                            expression: isolatedClickScript,
                            returnByValue: true
                        });
                        isolatedResult = result.result?.value as string;
                    }
                });
                const info = JSON.parse(isolatedResult!);
                if (info.error) throw new Error(info.error);
                targetInfo = info;
                const pageState = await this.readPageState(session);
                const warnings: string[] = [];
                if (info.hitElement) {
                    hitElementRef.current = info.hitElement as ClickHitElement;
                    warnings.push(
                        `点击坐标当前被其他元素遮挡（<${info.hitElement.tag}> "${info.hitElement.text}"），实际点击可能落在了遮挡元素上`
                    );
                }
                if (modMask !== 0) {
                    warnings.push(
                        '合成事件点击不会触发浏览器默认行为：Ctrl/Meta+点击不会打开新标签页，Shift+点击不会打开新窗口'
                    );
                }
                const dialog = session.takeLastDialog();
                return {
                    target,
                    tag: targetInfo.tag,
                    text: targetInfo.text,
                    ...(pageState && { page: pageState }),
                    newTab: outcome.newTab,
                    ...(hitElementRef.current && { hitElement: hitElementRef.current }),
                    ...(dialog && { dialog: describeDialog(dialog) }),
                    ...(warnings.length && { warning: warnings.join('\n') })
                };
            }

            const coords = await resolveTargetCoords(session, target, this._buildFrameUrlIndex());
            targetInfo = { tag: coords.tag, text: coords.text };
            const outcome = await this.waitForClickCompletion(session, async () => {
                // Pre-dispatch hit verification: record what actually sits under
                // the click point right before the events go out. A floating
                // overlay that appeared after the snapshot (TOCTOU — observed on
                // ifeng where a sidebar news item opened an ad instead) is then
                // reported to the agent instead of silently hijacking the click.
                // 嵌套 ref 跳过：elementFromPoint 在主文档只会命中 <iframe> 元素
                // 本身，记录它反而会产生误导性的 hitElement。
                if (!isNested) {
                    try {
                        const hitResult = await session.send('Runtime.evaluate', {
                            expression: `(() => {
                                var el = document.elementFromPoint(${coords.x}, ${coords.y});
                                return el ? JSON.stringify({ tag: el.tagName.toLowerCase(), text: (el.innerText || '').trim().slice(0, 80) }) : '';
                            })()`,
                            returnByValue: true
                        });
                        const v = hitResult?.result?.value;
                        if (v) hitElementRef.current = JSON.parse(v) as ClickHitElement;
                    } catch {
                        /* best-effort verification */
                    }
                }

                await session.send('Input.dispatchMouseEvent', {
                    type: 'mouseMoved',
                    x: coords.x,
                    y: coords.y,
                    modifiers: modMask
                });
                await session.send('Input.dispatchMouseEvent', {
                    type: 'mousePressed',
                    x: coords.x,
                    y: coords.y,
                    button,
                    clickCount,
                    modifiers: modMask
                });
                await session.send('Input.dispatchMouseEvent', {
                    type: 'mouseReleased',
                    x: coords.x,
                    y: coords.y,
                    button,
                    clickCount,
                    modifiers: modMask
                });

                if (button === 'right') {
                    await session
                        .send('Runtime.evaluate', {
                            expression: `(() => {
                        var el = document.elementFromPoint(${coords.x}, ${coords.y});
                        if (el) el.dispatchEvent(new MouseEvent('contextmenu', {
                            bubbles: true, cancelable: true, view: window,
                            clientX: ${coords.x}, clientY: ${coords.y}, button: 2
                        }));
                    })()`,
                            returnByValue: true
                        })
                        .catch(() => {});
                }

                if ((coords as any).obscured && button === 'left') {
                    const targetExpr = isRef
                        ? `__odFindRef('${target}')`
                        : `document.querySelector(${JSON.stringify(target)})`;
                    await session
                        .send('Runtime.evaluate', {
                            expression: `(() => {
                                ${isRef ? OD_REF_QUERY_HELPER : ''}
                                var el = ${targetExpr}; if (el) el.click();
                            })()`,
                            returnByValue: true
                        })
                        .catch(() => {});
                }
            });
            const pageState = await this.readPageState(session);
            const hitElement = hitElementRef.current;
            const dialog = session.takeLastDialog();

            // Surface a hijack warning when the click point was covered by
            // another element (the CDP events went to the overlay, and the
            // degraded el.click() may still be intercepted by the page).
            if ((coords as any).obscured) {
                warning = hitElement
                    ? `点击坐标当前被其他元素遮挡（<${hitElement.tag}> "${hitElement.text}"），实际点击可能落在了遮挡元素上`
                    : '点击坐标被其他元素遮挡，实际点击可能落在遮挡元素上';
            }

            return {
                target,
                tag: targetInfo.tag,
                text: targetInfo.text,
                ...(pageState && { page: pageState }),
                newTab: outcome.newTab,
                ...(hitElement && { hitElement }),
                ...(dialog && { dialog: describeDialog(dialog) }),
                ...(warning && { warning })
            };
        });
    }

    async type(
        target: string,
        text: string,
        options: { clearFirst?: boolean; submit?: boolean; slowly?: boolean } = {}
    ): Promise<{
        target: string;
        typed: number;
        page?: Record<string, any> | null;
        newTab: ActionNewTab | null;
        dialog?: string;
        warning?: string;
    }> {
        return this._withExclusiveLock(async () => {
            const { clearFirst = true, submit = false, slowly = false } = options;
            const session = await this.requireCDP();
            // 提交可能触发 confirm()（如离开确认）：先启用对话框接管
            await session.ensureDialogHandling();
            const isRef = /^e\d+/.test(target);
            const isNested = isRef && isNestedRef(target);
            // 嵌套 ref（iframe 内元素）同样可以走原生输入：CDP Input 事件按视口
            // 坐标由 compositor 命中测试路由到正确的 frame（含 OOPIF）——这让
            // 修饰键点击（Ctrl+点击新标签页）与受控编辑器的真实按键在 iframe 内
            // 也生效，而不是被合成事件静默降级（BUG-31/32）。焦点安全门槛不变。
            const useNativeInput = await this._hasActiveWebviewFocus();
            // 坐标被遮挡（obscured）时按键焦点可能落在其它控件上：全选 + 替换会
            // 清掉无辜元素的既有内容（见下方原生全选处的说明），先记下标记。
            let coordsObscured = false;

            if (useNativeInput) {
                const coords = await resolveTargetCoords(session, target, this._buildFrameUrlIndex());
                coordsObscured = !!(coords as any).obscured;
                await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: coords.x, y: coords.y });
                await session.send('Input.dispatchMouseEvent', {
                    type: 'mousePressed',
                    x: coords.x,
                    y: coords.y,
                    button: 'left',
                    clickCount: 1
                });
                await session.send('Input.dispatchMouseEvent', {
                    type: 'mouseReleased',
                    x: coords.x,
                    y: coords.y,
                    button: 'left',
                    clickCount: 1
                });
                await sleep(50);
            }

            // Resolve target frame for JS execution (clear / read value)
            let targetFrame: Electron.WebFrameMain | null = null;
            let elementRefForFrame: string | null = null;
            if (isNested) {
                const nav = await navigateToFrame(session.webContents.mainFrame, target, this._buildFrameUrlIndex());
                targetFrame = nav.frame;
                elementRefForFrame = nav.elementRef;
            }
            const targetExpr = targetFrame
                ? `__odFindRef('${elementRefForFrame}')`
                : isRef
                  ? `__odFindRef('${target}')`
                  : `document.querySelector(${JSON.stringify(target)})`;
            const executeTargetScript = async (script: string): Promise<any> => {
                if (targetFrame) return targetFrame.executeJavaScript(script);
                const result = await session.send('Runtime.evaluate', {
                    expression: script,
                    returnByValue: true
                });
                return result.result?.value;
            };

            // 目标预检（BUG-06/21）：元素不存在或 disabled/readonly 时立即失败，
            // 不再静默走完整个"清空 + 写入 + 回读"流程后谎报 typed: N。
            // 真实用户无法向 disabled/readonly 输入框输入，自动化也不应绕过。
            const precheckExpr = `(() => {
                ${OD_REF_QUERY_HELPER}
                var el = ${targetExpr};
                if (!el) return 'no-element';
                if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && (el.disabled || el.readOnly)) {
                    return 'element-locked';
                }
                return 'ok';
            })()`;
            const precheck = (await executeTargetScript(precheckExpr)) as string;
            if (precheck === 'no-element') {
                throw new Error(
                    isRef
                        ? describeRefMiss(target)
                        : `Element not found for selector ${JSON.stringify(target)}. CSS 选择器只匹配主文档，iframe 内的元素请使用 snapshot 返回的 ref 定位。`
                );
            }
            if (precheck === 'element-locked') {
                throw new Error('目标元素为 disabled 或 readonly，真实用户无法输入，已阻止绕过写入');
            }

            const warnings: string[] = [];

            // Prepare text to input
            let textToInsert = text;

            // In append mode, get current value and concatenate
            if (!clearFirst && text) {
                await sleep(50);
                const readExpr = `(() => {
                    ${OD_REF_QUERY_HELPER}
                    var el = ${targetExpr};
                    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return el.value || '';
                    if (el && el.isContentEditable) return el.innerText || el.textContent || '';
                    return '';
                })()`;
                const currentValue = ((await executeTargetScript(readExpr)) as string) || '';
                textToInsert = currentValue + text;
            }

            // Clear existing text
            // React 受控组件对原生 el.value 直接赋值无感知（内部 state 不同步），
            // 需通过 prototype 上的 value setter 赋值 + 派发 input 事件才能让
            // React 更新 state。否则后续 insertText/Enter 提交读到的是旧值。
            const setValueExpr = (refExpr: string, value: string): string => {
                const escaped = JSON.stringify(value);
                return `(() => {
                    ${OD_REF_QUERY_HELPER}
                    var el = ${refExpr};
                    if (!el) return;
                    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                        var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                        var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
                        if (setter) setter.call(el, ${escaped});
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                    } else if (el.isContentEditable) {
                        if (${escaped} === '') {
                            // contentEditable 清空走真实编辑事件流（beforeinput/
                            // input）：textContent 直写会绕过受控编辑器（CodeMirror
                            // 类）的内部模型，造成"DOM 看似清空、编辑器状态未变"
                            // 的静默失联。
                            try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
                            var cleared = false;
                            try {
                                document.execCommand('selectAll', false);
                                cleared = document.execCommand('delete', false);
                            } catch (e2) { cleared = false; }
                            if (!cleared) el.textContent = '';
                        } else {
                            el.textContent = ${escaped};
                        }
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                })()`;
            };
            const clearExpr = setValueExpr(targetExpr, '');
            await executeTargetScript(clearExpr);
            await sleep(30);

            // 原生全选（Ctrl/Meta+A，BUG-32）：受控编辑器（CodeMirror 类）的内部
            // 模型只响应真实按键——合成的 value 直写只改 DOM，模型保持旧内容，
            // 随后输入会与旧内容叠加。原生路径先真实全选，输入的第一个字符即可
            // 整体替换选区（普通输入框：清空后全选无副作用）。焦点安全门槛不变：
            // 该路径仅在 webview 已持有时触达。
            // 坐标被遮挡（obscured）时跳过全选：此刻按键焦点可能落在遮挡元素或
            // 其它控件上，全选 + 替换会清掉无辜元素的既有内容——退回历史行为
            // （焦点处插入，不破坏已有文本）。
            if (useNativeInput && clearFirst && textToInsert && !coordsObscured) {
                const selectAllMod = process.platform === 'darwin' ? 4 : 2;
                await session.send('Input.dispatchKeyEvent', {
                    type: 'keyDown',
                    key: 'a',
                    code: 'KeyA',
                    windowsVirtualKeyCode: 65,
                    modifiers: selectAllMod
                });
                await session.send('Input.dispatchKeyEvent', {
                    type: 'keyUp',
                    key: 'a',
                    code: 'KeyA',
                    windowsVirtualKeyCode: 65,
                    modifiers: selectAllMod
                });
                await sleep(30);
            }

            if (textToInsert) {
                if (!useNativeInput) {
                    // Isolated input never steals OS focus from the guest
                    // webview — required for background tasks and for a
                    // foreground task while the user is typing in another
                    // OpenDesk control. The contenteditable branch below still
                    // focuses the editor *in-page* (document.activeElement) so
                    // execCommand inserts into the right element.
                    const escapedText = JSON.stringify(textToInsert);
                    if (slowly) {
                        for (const ch of textToInsert) {
                            const chEscaped = JSON.stringify(ch);
                            const kd = resolveKey(ch);
                            const codeEscaped = JSON.stringify(kd.code);
                            await executeTargetScript(
                                `(() => {
                                    ${OD_REF_QUERY_HELPER}
                                    var el = ${targetExpr};
                                    if (!el) return;
                                    var ch = ${chEscaped};
                                    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                                        var start = el.selectionStart || 0;
                                        var v = el.value || '';
                                        var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                                        var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
                                        if (setter) setter.call(el, v.slice(0, start) + ch + v.slice(el.selectionEnd || start));
                                        el.selectionStart = el.selectionEnd = start + ch.length;
                                    } else if (el.isContentEditable) {
                                        // execCommand inserts into the focused
                                        // element — make sure the editor has
                                        // in-page focus first, otherwise the
                                        // text lands on <body> and vanishes.
                                        try {
                                            if (document.activeElement !== el) el.focus({ preventScroll: true });
                                        } catch (e2) {
                                            if (document.activeElement !== el) el.focus();
                                        }
                                        document.execCommand('insertText', false, ch);
                                    }
                                    el.dispatchEvent(new KeyboardEvent('keydown', {
                                        key: ch, code: ${codeEscaped}, keyCode: ${kd.keyCode},
                                        shiftKey: ${kd.shiftKey || false},
                                        bubbles: true, cancelable: true
                                    }));
                                    el.dispatchEvent(new KeyboardEvent('keyup', {
                                        key: ch, code: ${codeEscaped}, keyCode: ${kd.keyCode},
                                        shiftKey: ${kd.shiftKey || false},
                                        bubbles: true, cancelable: true
                                    }));
                                    el.dispatchEvent(new Event('input', { bubbles: true }));
                                })()`
                            );
                            await sleep(30);
                        }
                    } else {
                        const insertOutcome = (await executeTargetScript(
                            `(() => {
                                ${OD_REF_QUERY_HELPER}
                                var el = ${targetExpr};
                                if (!el) return 'no-element';
                                var text = ${escapedText};
                                if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                                    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                                    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
                                    if (setter) setter.call(el, text);
                                    el.dispatchEvent(new Event('input', { bubbles: true }));
                                    el.dispatchEvent(new Event('change', { bubbles: true }));
                                    return 'value';
                                }
                                if (el.isContentEditable) {
                                    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
                                    // Route through execCommand so the page sees a
                                    // real editing event stream (beforeinput/input).
                                    // A direct textContent assignment bypasses
                                    // controlled editors — taobao IM wipes the
                                    // injected text right back out.
                                    var ok = false;
                                    try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
                                    if (ok) return 'insertText';
                                    el.textContent = text;
                                    el.dispatchEvent(new Event('input', { bubbles: true }));
                                    el.dispatchEvent(new Event('change', { bubbles: true }));
                                    return 'textContent';
                                }
                                return 'unsupported';
                            })()`
                        )) as string;
                        // 'unsupported'（目标既非 input/textarea 也非 contenteditable）
                        // 不能静默吞掉——调用方会看到 typed: N 以为写入成功
                        if (insertOutcome === 'no-element') {
                            throw new Error(
                                isRef
                                    ? describeRefMiss(target)
                                    : `Element not found for selector ${JSON.stringify(target)}.`
                            );
                        }
                        if (insertOutcome === 'unsupported') {
                            warnings.push('目标元素不是可输入控件（非 input/textarea/contenteditable），文本未写入');
                        }
                    }
                } else if (slowly) {
                    for (const ch of textToInsert) {
                        const desc = resolveKey(ch);
                        const baseEvent = {
                            key: desc.key,
                            code: desc.code,
                            windowsVirtualKeyCode: desc.keyCode
                        };
                        const modifiersVal = desc.shiftKey ? 8 : 0;
                        await session.send('Input.dispatchKeyEvent', {
                            type: 'keyDown',
                            ...baseEvent,
                            modifiers: modifiersVal,
                            text: desc.text || ''
                        });
                        await session.send('Input.dispatchKeyEvent', {
                            type: 'keyUp',
                            ...baseEvent,
                            modifiers: modifiersVal
                        });
                        await sleep(30);
                    }
                } else {
                    await session.send('Input.insertText', { text: textToInsert });
                }
            }

            // Verify the typed text actually landed in the element. React
            // controlled components can keep a stale internal state while the
            // DOM value looks right (observed on taobao home: Enter then
            // submitted the OLD keyword instead of what was typed here).
            if (textToInsert) {
                await sleep(50);
                try {
                    const readBackExpr = `(() => {
                        ${OD_REF_QUERY_HELPER}
                        var el = ${targetExpr};
                        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return el.value || '';
                        if (el && el.isContentEditable) return ((el.innerText || el.textContent || '') + '').trim();
                        return '';
                    })()`;
                    const readBack = ((await executeTargetScript(readBackExpr)) as string) || '';
                    if (readBack !== textToInsert) {
                        warnings.push(
                            `输入验证失败：预期 "${textToInsert.slice(0, 40)}" 但页面读回 "${readBack.slice(0, 40)}"，页面框架可能未同步本次输入，提交前请先 snapshot 确认`
                        );
                    }
                } catch {
                    /* best-effort verification */
                }
            }

            let submitOutcome: ActionOutcome | null = null;
            let frameUrlBefore: string | null = null;
            if (submit) {
                await sleep(50);
                // iframe 内提交只导航 iframe 本身，waitForClickCompletion 只监控
                // 主 frame URL 与新标签页，看不到 iframe 内导航 —— 此前必然误报
                // "提交可能未生效"。记录提交前 iframe 的真实 URL，提交后比对。
                frameUrlBefore = this._safeFrameUrl(targetFrame);
                if (!useNativeInput) {
                    submitOutcome = await this.waitForClickCompletion(session, async () => {
                        await executeTargetScript(
                            `(() => {
                                ${OD_REF_QUERY_HELPER}
                                var el = ${targetExpr};
                                if (!el) return;
                            var allowed = el.dispatchEvent(new KeyboardEvent('keydown', {
                                key: 'Enter', code: 'Enter', keyCode: 13,
                                bubbles: true, cancelable: true
                            }));
                            el.dispatchEvent(new KeyboardEvent('keyup', {
                                key: 'Enter', code: 'Enter', keyCode: 13,
                                bubbles: true, cancelable: true
                            }));
                            var form = el.closest('form');
                            if (allowed && form) {
                                if (typeof form.requestSubmit === 'function') form.requestSubmit();
                                else form.submit();
                            }
                        })()`
                        );
                    });
                } else {
                    submitOutcome = await this.waitForClickCompletion(session, async () => {
                        await session.send('Input.dispatchKeyEvent', {
                            type: 'keyDown',
                            key: 'Enter',
                            code: 'Enter',
                            windowsVirtualKeyCode: 13
                        });
                        // 补发 char（keypress）事件：原生 <form> 的隐式提交（回车
                        // 提交）由 keypress 默认行为触发，缺了它 bilibili 这类
                        // 表单搜索框按回车不会跳转。
                        await session.send('Input.dispatchKeyEvent', {
                            type: 'char',
                            key: 'Enter',
                            code: 'Enter',
                            windowsVirtualKeyCode: 13,
                            text: '\r',
                            unmodifiedText: '\r'
                        });
                        await session.send('Input.dispatchKeyEvent', {
                            type: 'keyUp',
                            key: 'Enter',
                            code: 'Enter',
                            windowsVirtualKeyCode: 13
                        });
                    });
                }
            }

            // Report what the submit actually did instead of returning silently.
            // iframe 内提交：主 frame URL 不变是预期的，比对 iframe 内容 frame 的
            // 真实 URL 判断提交是否生效，避免误报。
            let frameSubmitNavigated = false;
            if (submit && submitOutcome && !submitOutcome.navigated && !submitOutcome.newTab && targetFrame) {
                for (let i = 0; i < 8; i++) {
                    await sleep(150);
                    const urlNow = this._safeFrameUrl(targetFrame);
                    if (urlNow === null || urlNow !== frameUrlBefore) {
                        // 读不到（frame 已销毁/换进程）也视为已发生导航，
                        // 不输出误导性的"提交可能未生效"
                        frameSubmitNavigated = true;
                        break;
                    }
                }
            }
            if (submit && submitOutcome && !submitOutcome.navigated && !submitOutcome.newTab && !frameSubmitNavigated) {
                warnings.push(
                    'Enter 提交后未检测到页面导航或新标签页，提交可能未生效。可尝试点击搜索/提交按钮，或直接 navigate 到目标 URL'
                );
            }

            const pageState = await this.readPageState(session);
            const dialog = session.takeLastDialog();
            return {
                target,
                typed: text.length,
                ...(pageState && { page: pageState }),
                newTab: submitOutcome?.newTab ?? null,
                ...(dialog && { dialog: describeDialog(dialog) }),
                ...(warnings.length && { warning: warnings.join('\n') })
            };
        });
    }

    async hover(target: string): Promise<{ target: string; tag: string; text: string; dialog?: string }> {
        return this._withExclusiveLock(async () => {
            const session = await this.requireCDP();
            // mouseover 处理器可能触发对话框：与 click 一致先启用接管（BUG-02 同族）
            await session.ensureDialogHandling();
            // 与 click/type 一致：嵌套 ref 的坐标解析带帧 URL 校验
            const coords = await resolveTargetCoords(session, target, this._buildFrameUrlIndex());
            await session.send('Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                x: coords.x,
                y: coords.y
            });
            const dialog = session.takeLastDialog();
            return {
                target,
                tag: coords.tag,
                text: coords.text,
                ...(dialog && { dialog: describeDialog(dialog) })
            };
        });
    }

    async pressKey(
        key: string,
        modifiers?: string[],
        iframeRef?: string
    ): Promise<{ key: string; routedFrame?: string }> {
        return this._withExclusiveLock(async () => {
            const session = await this.requireCDP();
            // Enter 等按键可能触发表单提交/确认对话框，先启用对话框接管
            await session.ensureDialogHandling();
            const keyDesc = resolveKey(key);
            // 未知键名（多字符且不在键位表里）不会产生任何真实按键事件，
            // 静默返回 success 会让 agent 以为按键已生效（BUG-22）
            if (keyDesc.recognized === false) {
                throw new Error(`未知按键名: "${key}" — 请使用标准键名（Enter/Tab/ArrowDown/a/1/@ 等）`);
            }
            const modMask = modifiersBitmask(modifiers);
            const isPlainTab = keyDesc.key === 'Tab' && (modMask & 7) === 0;
            const useNativeInput = await this._hasActiveWebviewFocus();
            // 合成按键没有浏览器默认行为：带修饰键时除 Ctrl/Cmd+A（页面内全选）
            // 外基本无效，明确告知 agent，避免它以为快捷键已生效。
            const syntheticNote =
                modMask !== 0 && !useNativeInput && !isPlainTab
                    ? '合成按键不会触发浏览器级快捷键（Ctrl+C/V/X 等）；Ctrl+A 已用页面内全选代替'
                    : undefined;

            // BUG-05：焦点在 iframe 内而未指定 iframeRef 时，主文档的合成按键
            // 事件只会落在 <iframe> 元素本身上，按键静默丢失。这里探测焦点
            // 所在的 iframe 链并自动路由（native 路径由 Chromium 路由到真实
            // 焦点 frame，无需探测）。
            let routedFrameRef: string | undefined;
            if (!iframeRef && !useNativeInput) {
                routedFrameRef = (await this._resolveFocusedFrameChain(session)) ?? undefined;
                if (routedFrameRef) iframeRef = routedFrameRef;
            }

            if (iframeRef) {
                const frame = await navigateIntoFrame(
                    session.webContents.mainFrame,
                    iframeRef,
                    this._buildFrameUrlIndex()
                );
                if (isPlainTab) {
                    await frame.executeJavaScript(this._makePressTabInDocumentScript((modMask & 8) !== 0));
                } else {
                    await frame.executeJavaScript(this._makeDispatchKeyInDocumentScript(keyDesc, modMask));
                }
                return {
                    key,
                    ...(routedFrameRef && { routedFrame: routedFrameRef }),
                    ...(syntheticNote && { warning: syntheticNote })
                };
            }
            if (isPlainTab) {
                await session.send('Runtime.evaluate', {
                    expression: this._makePressTabInDocumentScript((modMask & 8) !== 0),
                    returnByValue: true
                });
            } else if (!useNativeInput) {
                await session.send('Runtime.evaluate', {
                    expression: this._makeDispatchKeyInDocumentScript(keyDesc, modMask),
                    returnByValue: true
                });
            } else {
                const text = (modMask & 7) === 0 ? keyDesc.text || '' : '';
                const keyDownType = text ? 'keyDown' : 'rawKeyDown';
                await session.send('Input.dispatchKeyEvent', {
                    type: keyDownType,
                    key: keyDesc.key,
                    code: keyDesc.code,
                    windowsVirtualKeyCode: keyDesc.keyCode,
                    nativeVirtualKeyCode: keyDesc.keyCode,
                    text,
                    modifiers: modMask
                });
                // Enter 需要补发 char（keypress）事件，否则原生 <form> 的隐式提交
                // （回车提交）不会触发——光有 rawKeyDown + keyUp 不够。
                if (keyDesc.keyCode === 13) {
                    await session.send('Input.dispatchKeyEvent', {
                        type: 'char',
                        key: 'Enter',
                        code: 'Enter',
                        windowsVirtualKeyCode: 13,
                        nativeVirtualKeyCode: 13,
                        text: '\r',
                        unmodifiedText: '\r',
                        modifiers: modMask
                    });
                }
                await session.send('Input.dispatchKeyEvent', {
                    type: 'keyUp',
                    key: keyDesc.key,
                    code: keyDesc.code,
                    windowsVirtualKeyCode: keyDesc.keyCode,
                    nativeVirtualKeyCode: keyDesc.keyCode,
                    modifiers: modMask
                });
            }

            return { key, ...(syntheticNote && { warning: syntheticNote }) };
        });
    }

    async selectOption(target: string, values: string[]): Promise<{ selected: string[]; warning?: string }> {
        return this._withExclusiveLock(async () => {
            const session = await this.requireCDP();
            // change 事件处理器可能弹对话框，先启用对话框接管
            await session.ensureDialogHandling();
            const valuesJSON = JSON.stringify(values);

            const isRef = /^e\d+/.test(target);

            // 脚本返回真实选中状态（actual）与全部可用选项（available），
            // 不再回显请求值谎报成功（BUG-19）。
            // 全部未命中时先判定、再动手：单选 select 把所有 option 置为
            // selected=false 会被浏览器强制回落到第一项，等于静默把页面改成
            // 用户没要求的选项（BUG-19 补充）。
            const selectLogic = `
                    var values = ${valuesJSON};
                    var available = [];
                    for (var j = 0; j < el.options.length; j++) available.push(el.options[j].value);
                    var matched = [];
                    for (var m = 0; m < values.length; m++) {
                        if (available.indexOf(values[m]) !== -1) matched.push(values[m]);
                    }
                    if (values.length > 0 && matched.length === 0) {
                        return JSON.stringify({ unmatchedAll: true, matched: matched, available: available });
                    }
                    for (var i = 0; i < el.options.length; i++) {
                        el.options[i].selected = matched.indexOf(el.options[i].value) !== -1;
                    }
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    var actual = [];
                    for (var k = 0; k < el.options.length; k++) {
                        if (el.options[k].selected) actual.push(el.options[k].value);
                    }
                    return JSON.stringify({ matched: matched, actual: actual, available: available });`;

            let resultValue: string;

            if (isRef && isNestedRef(target)) {
                const { frame, elementRef } = await navigateToFrame(
                    session.webContents.mainFrame,
                    target,
                    this._buildFrameUrlIndex()
                );
                const targetSelectJS = `(() => {
                    ${OD_REF_QUERY_HELPER}
                    var el = __odFindRef('${elementRef}');
                    if (!el) return JSON.stringify({ error: ${JSON.stringify(describeRefMiss(target))} });
                    if (el.tagName.toLowerCase() !== 'select') return JSON.stringify({ error: 'Element is not a <select>' });
                    ${selectLogic}
                })()`;
                resultValue = (await frame.executeJavaScript(targetSelectJS)) as string;
            } else {
                const selectorExpr = isRef
                    ? `__odFindRef('${target}')`
                    : `document.querySelector(${JSON.stringify(target)})`;
                const selectJS = `(() => {
                    ${OD_REF_QUERY_HELPER}
                    var el = ${selectorExpr};
                    if (!el) return JSON.stringify({ error: ${
                        isRef
                            ? JSON.stringify(describeRefMiss(target))
                            : JSON.stringify(
                                  `Element not found for selector ${JSON.stringify(target)}. CSS 选择器只匹配主文档，iframe 内的元素请使用 snapshot 返回的 ref 定位。`
                              )
                    } });
                    if (el.tagName.toLowerCase() !== 'select') return JSON.stringify({ error: 'Element is not a <select>' });
                    ${selectLogic}
                })()`;
                const result = await session.send('Runtime.evaluate', {
                    expression: selectJS,
                    returnByValue: true
                });
                resultValue = result.result.value;
            }

            const info = JSON.parse(resultValue);
            if (info.error) throw new Error(info.error);

            const available: string[] = Array.isArray(info.available) ? info.available : [];
            const actual: string[] = Array.isArray(info.actual) ? info.actual : [];
            if (info.unmatchedAll) {
                // 一个都没匹配上：脚本已在改动任何 option 之前返回，页面保持原状
                throw new Error(
                    `选项未命中: ${JSON.stringify(values)}，页面未做任何修改。可用选项: ${available.join(', ')}`
                );
            }
            const unmatched = values.filter((v) => !actual.includes(v));
            if (unmatched.length > 0) {
                return {
                    selected: actual,
                    warning: `部分选项未命中: ${JSON.stringify(unmatched)}（可用选项: ${available.join(', ')}）`
                };
            }
            return { selected: actual };
        });
    }

    async uploadFile(target: string, filePaths: string[]): Promise<BrowserUploadFileResult> {
        if (filePaths.length === 0) {
            throw new Error('No files specified for upload.');
        }

        return this._withExclusiveLock(async () => {
            const session = await this.requireCDP();
            await session.ensureDialogHandling();
            const token = `od-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const { frame, input } = await this._resolveUploadInput(session, target, token);

            // 降级策略提示（BUG-20）：single-form-input / single-page-input /
            // ancestor-descendant 意味着目标本身不是上传控件，是"就近猜测"——
            // 文件可能被塞进与用户意图无关的上传控件，必须让 agent 知情。
            const looseStrategies = new Set(['single-form-input', 'single-page-input', 'ancestor-descendant']);
            const uploadWarning =
                input.strategy && looseStrategies.has(input.strategy)
                    ? `目标元素不是文件上传控件，已按 "${input.strategy}" 策略就近解析到页面中的 file input — 请确认这是期望的上传目标`
                    : undefined;

            try {
                if (!input.multiple && filePaths.length > 1) {
                    throw new Error('The resolved file input does not allow multiple files.');
                }

                if (frame) {
                    await this._setFilesViaSyntheticFrame(frame, token, filePaths);
                } else {
                    await this._setFilesViaCDP(session, token, filePaths);
                }

                await sleep(250);
                const pageState = await this.readPageState(session);
                const dialog = session.takeLastDialog();
                return {
                    target,
                    tag: input.tag,
                    text: input.text,
                    ...(input.inputRef && { inputRef: input.inputRef }),
                    accept: input.accept,
                    multiple: input.multiple,
                    files: await this._describeUploadFiles(filePaths),
                    ...(pageState && { page: pageState }),
                    ...(dialog && { dialog: describeDialog(dialog) }),
                    ...(uploadWarning && { warning: uploadWarning })
                };
            } catch (err) {
                await this._clearUploadToken(session, frame, token);
                throw err;
            }
        });
    }

    async scrollTo(
        ref: string,
        options: {
            block?: 'start' | 'center' | 'end' | 'nearest';
            inline?: 'start' | 'center' | 'end' | 'nearest';
        } = {}
    ): Promise<{
        ref: string;
        tag: string;
        text: string;
        dialog?: string;
        scroll?: {
            scrollY: number;
            scrollHeight: number;
            innerHeight: number;
            atTop: boolean;
            atBottom: boolean;
        };
        elementScroll?: { scrollHeight: number; clientHeight: number };
    }> {
        return this._withExclusiveLock(async () => {
            const session = await this.requireCDP();
            // scrollIntoView 可能触发页面的 scroll handler 弹对话框（BUG-02 同族）：
            // 在途的 Runtime.evaluate / frame.executeJavaScript 会被挂到看门狗超时
            await session.ensureDialogHandling();
            const block = options.block || 'nearest';
            const inline = options.inline || 'nearest';

            // 返回滚动位置与到顶/到底状态（与 skill 文档声明一致，BUG-11），
            // 并在元素自身是滚动容器时附带元素级滚动信息。
            const scrollReport = `
                        var scroll = {
                            scrollY: Math.round(window.scrollY),
                            scrollHeight: document.documentElement.scrollHeight,
                            innerHeight: window.innerHeight
                        };
                        scroll.atTop = scroll.scrollY <= 1;
                        scroll.atBottom = scroll.scrollY + scroll.innerHeight >= scroll.scrollHeight - 1;
                        var elementScroll = null;
                        if (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) {
                            elementScroll = { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
                        }
                        return JSON.stringify({
                            tag: el.tagName.toLowerCase(),
                            text: (el.textContent || '').trim().substring(0, 80),
                            scroll: scroll,
                            elementScroll: elementScroll
                        });`;

            // Nested ref (e.g. "e5-e3") — navigate into iframe chain
            if (isNestedRef(ref)) {
                // First reveal every outer iframe in its parent viewport. Scrolling
                // only the innermost document leaves the final click point offscreen.
                await resolveNestedRefCoords(session.webContents.mainFrame, ref, this._buildFrameUrlIndex());
                const { frame, elementRef } = await navigateToFrame(
                    session.webContents.mainFrame,
                    ref,
                    this._buildFrameUrlIndex()
                );
                const result = (await frame.executeJavaScript(`
                    (() => {
                        ${OD_REF_QUERY_HELPER}
                        var el = __odFindRef('${elementRef}');
                        if (!el) return JSON.stringify({ error: ${JSON.stringify(describeRefMiss(ref))} });
                        el.scrollIntoView({ block: '${block}', inline: '${inline}', behavior: 'instant' });
                        ${scrollReport}
                    })()
                `)) as string;
                const info = JSON.parse(result);
                if (info.error) throw new Error(info.error);
                const dialog = session.takeLastDialog();
                return {
                    ref,
                    tag: info.tag,
                    text: info.text,
                    ...(dialog && { dialog: describeDialog(dialog) }),
                    ...(info.scroll && { scroll: info.scroll }),
                    ...(info.elementScroll && { elementScroll: info.elementScroll })
                };
            }

            // Simple ref — scroll in main frame
            const result = await session.send('Runtime.evaluate', {
                expression: `(() => {
                    ${OD_REF_QUERY_HELPER}
                    var el = __odFindRef('${ref}');
                    if (!el) return JSON.stringify({ error: 'Element ref "${ref}" not found. Page may have changed — call snapshot to refresh.' });
                    el.scrollIntoView({ block: '${block}', inline: '${inline}', behavior: 'instant' });
                    ${scrollReport}
                })()`,
                returnByValue: true,
                awaitPromise: true
            });

            if (result.exceptionDetails) {
                throw new Error(describeRuntimeException(result.exceptionDetails));
            }

            const info = JSON.parse(result.result.value);
            if (info.error) throw new Error(info.error);
            const dialog = session.takeLastDialog();
            return {
                ref,
                tag: info.tag,
                text: info.text,
                ...(dialog && { dialog: describeDialog(dialog) }),
                ...(info.scroll && { scroll: info.scroll }),
                ...(info.elementScroll && { elementScroll: info.elementScroll })
            };
        });
    }

    /**
     * 历史导航没有产生任何变化时补一条 error（压测发现：goBack 在部分状态下
     * 会静默失败——工具照旧返回旧页面的 url/title，agent 完全看不出没后退）。
     *
     * 这里只给原因，不加"后退失败"之类的前缀：调用方（工具层）已经有本地化的
     * 前缀文案，两边都加会输出"后退失败: 后退失败：...".
     */
    private _withHistoryCheck<T extends { url: string }>(info: T, urlBefore: string | undefined): T {
        if (!urlBefore || info.url !== urlBefore) return info;
        return {
            ...info,
            error:
                `页面 URL 未变化（${info.url}）。` +
                '当前标签可能没有可用的历史记录，或渲染进程尚未就绪——可先 snapshot 确认页面状态'
        };
    }

    async goBack(): Promise<{ url: string; title: string; error?: string; dialog?: string }> {
        return this._withExclusiveLock(async () => {
            const session = await this.getCDPSession();
            let urlBefore: string | undefined;
            if (session) {
                try {
                    urlBefore = (await this.readPageInfo(session)).url;
                } catch {
                    urlBefore = undefined;
                }
            }
            await this.callRendererBrowser('browserGoBack');
            // 历史导航是跨页导航，旧快照树失效（见 navigate 的缓存清空说明）
            this.invalidateSnapshotBaseline();
            if (session) {
                await session.waitForPageReady(8000);
                try {
                    const info = await this.readPageInfo(session);
                    return this._mergeNavDialog(this._withHistoryCheck(info, urlBefore), session);
                } catch {
                    /* fall through */
                }
            }
            await sleep(500);
            const raw = await this.runOnActiveWebview(
                `JSON.stringify({ url: location.href, title: document.title })`,
                5000
            );
            const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return this._mergeNavDialog(
                this._withHistoryCheck({ url: info.url, title: info.title }, urlBefore),
                session
            );
        });
    }

    async goForward(): Promise<{ url: string; title: string; error?: string; dialog?: string }> {
        return this._withExclusiveLock(async () => {
            const session = await this.getCDPSession();
            let urlBefore: string | undefined;
            if (session) {
                try {
                    urlBefore = (await this.readPageInfo(session)).url;
                } catch {
                    urlBefore = undefined;
                }
            }
            await this.callRendererBrowser('browserGoForward');
            // 历史导航是跨页导航，旧快照树失效（见 navigate 的缓存清空说明）
            this.invalidateSnapshotBaseline();
            if (session) {
                await session.waitForPageReady(8000);
                try {
                    const info = await this.readPageInfo(session);
                    return this._mergeNavDialog(this._withHistoryCheck(info, urlBefore), session);
                } catch {
                    /* fall through */
                }
            }
            await sleep(500);
            const raw = await this.runOnActiveWebview(
                `JSON.stringify({ url: location.href, title: document.title })`,
                5000
            );
            const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return this._mergeNavDialog(
                this._withHistoryCheck({ url: info.url, title: info.title }, urlBefore),
                session
            );
        });
    }

    async reload(): Promise<{ url: string; title: string; error?: string; dialog?: string }> {
        return this._withExclusiveLock(async () => {
            // Use the renderer bridge (webview.reload) instead of CDP Page.reload.
            // CDP Page.reload on a <webview>'s guest webContents can cause the
            // Electron host frame to reload or navigate to about:blank.
            await this.callRendererBrowser('browserRefresh');
            // reload 后整树 ref 可能重铸，旧快照树失效（见 navigate 的缓存清空说明）
            this.invalidateSnapshotBaseline();
            const session = await this.getCDPSession();
            if (session) {
                await session.waitForPageReady(12000);
                try {
                    return this._mergeNavDialog(await this.readPageInfo(session), session);
                } catch {
                    /* fall through */
                }
            }
            await sleep(1000);
            try {
                const raw = await this.runOnActiveWebview(
                    `JSON.stringify({ url: location.href, title: document.title })`,
                    5000
                );
                const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
                return this._mergeNavDialog({ url: info.url, title: info.title }, session);
            } catch {
                /* best effort */
            }
            return this._mergeNavDialog({ url: '(reloaded)', title: '' }, session);
        });
    }

    async evaluate(expression: string, iframeRef?: string): Promise<any> {
        return this._withExclusiveLock(async () => {
            const { value } = await this._evaluateLocked(expression, iframeRef);
            return value;
        });
    }

    /**
     * evaluate 的工具层形态：额外带回表达式触发的 JS 对话框信息。
     * 对话框已被自动接受（BUG-02），click/type 都会在结果中回显 dialog 字段；
     * evaluate 是对话框的另一大触发源（confirm/prompt 常用于页面交互验证），
     * 不回显的话 agent 只能靠表达式返回值猜测"对话框被透明接管"了。
     * 注意：保持 evaluate 的裸值契约不变（hint 插件的 BrowserPageEvaluator
     * 依赖），回显只走本方法。
     */
    async evaluateWithDialog(expression: string, iframeRef?: string): Promise<{ value: any; dialog?: string }> {
        return this._withExclusiveLock(async () => {
            const { value, session } = await this._evaluateLocked(expression, iframeRef);
            const dialog = session.takeLastDialog();
            return { value, ...(dialog && { dialog: describeDialog(dialog) }) };
        });
    }

    /** evaluate 的锁内实现；返回表达式值与其使用的会话（供调用方回显对话框信息）。 */
    private async _evaluateLocked(
        expression: string,
        iframeRef?: string
    ): Promise<{ value: any; session: CDPSession }> {
        const session = await this.requireCDP();
        // 表达式本身可能触发对话框（如 confirm()）：iframe 路径的在途
        // frame.executeJavaScript 会被对话框挂起，必须先启用接管
        await session.ensureDialogHandling();

        if (iframeRef) {
            const frame = await navigateIntoFrame(session.webContents.mainFrame, iframeRef, this._buildFrameUrlIndex());
            try {
                return { value: await frame.executeJavaScript(expression), session };
            } catch (err: any) {
                // Electron 结构化克隆失败（返回值不可序列化）时给出可行动的提示，
                // 而不是抛 CDP/Electron 原始英文错误（BUG-17）
                throw translateEvaluateFailure(err);
            }
        }

        let result: any;
        try {
            result = await session.send('Runtime.evaluate', {
                expression,
                returnByValue: true,
                awaitPromise: true
            });
        } catch (err: any) {
            throw translateEvaluateFailure(err);
        }

        if (result.exceptionDetails) {
            // description（含 message + stack）优先于 text（只是 "Uncaught"
            // 前缀）——此前顶层路径只回 "Uncaught"，丢失了异常消息与堆栈，
            // 而 iframe 路径却是完整的（BUG-16）。
            // 表达式内的异常同样过一遍 translateEvaluateFailure：Electron 不支持
            // window.prompt()，只抛原始英文报错会让 agent 以为是自己的表达式写错了。
            throw translateEvaluateFailure(new Error(describeRuntimeException(result.exceptionDetails)));
        }

        return { value: result.result.value, session };
    }

    async tabs(
        action: 'list' | 'new' | 'close' | 'switch',
        tabId?: number,
        url?: string
    ): Promise<{ tabs?: TabInfo[]; tabId?: number; url?: string; closed?: number; switched?: number }> {
        return this._withExclusiveLock(async () => {
            switch (action) {
                case 'list': {
                    const tabList = await this.callRendererBrowser('browserListTabs');
                    return { tabs: tabList };
                }
                case 'new': {
                    const newUrl = url || 'about:blank';
                    const newTabId = await this.callRendererBrowser('browserAddTab', newUrl);
                    // 活动标签已变：旧快照树属于上一个页面，不能作为 diff 基准
                    this.invalidateSnapshotBaseline();
                    return { tabId: newTabId, url: newUrl };
                }
                case 'close': {
                    if (tabId === undefined) throw new Error('close 操作需要提供 tabId');
                    await this.callRendererBrowser('browserCloseTab', tabId);
                    this.invalidateSnapshotBaseline();
                    return { closed: tabId };
                }
                case 'switch': {
                    if (tabId === undefined) throw new Error('switch 操作需要提供 tabId');
                    await this.callRendererBrowser('browserSwitchTab', tabId);
                    this.invalidateSnapshotBaseline();
                    return { switched: tabId };
                }
                default:
                    throw new Error(`Unknown action: ${action}`);
            }
        });
    }

    /**
     * Capture the active tab's current viewport as a PNG data URI.
     * The host can supply capture; Electron defaults to native capturePage so
     * pages with anti-debugging checks (e.g. SSO login flows) stay unaffected.
     */
    async captureScreenshot(): Promise<string> {
        return this._withExclusiveLock(async () => {
            const wcId = await this.callRendererBrowser('browserGetWebContentsId');
            if (wcId == null) throw new Error('No active browser tab to capture');
            const captured = await captureBrowserScreenshot(this._mainWindow, wcId, { format: 'png' });
            if (!captured) throw new Error('WebContents not found or destroyed');
            return captured;
        });
    }

    async waitFor(options: {
        text?: string;
        textGone?: string;
        timeout?: number;
        iframeRef?: string;
    }): Promise<{ condition: string }> {
        return this._withExclusiveLock(async () => {
            if (!options.text && !options.textGone) {
                throw new Error('必须提供 text 或 textGone 之一');
            }

            const session = await this.requireCDP();
            const timeoutSec = options.timeout ?? 3;
            const timeoutMs = timeoutSec * 1000;
            const pollInterval = 400;
            const deadline = Date.now() + timeoutMs;

            const needle = options.text || options.textGone!;
            const wantPresent = !!options.text;

            // Resolve target frame once (iframe doesn't change during polling)
            let targetFrame: Electron.WebFrameMain | null = null;
            if (options.iframeRef) {
                targetFrame = await navigateIntoFrame(
                    session.webContents.mainFrame,
                    options.iframeRef,
                    this._buildFrameUrlIndex()
                );
            }

            const needleEscaped = JSON.stringify(needle);
            const checkExpr = `(() => {
            ${OD_VISIBLE_TEXT_HELPER}
            var needle = ${needleEscaped};
            var normalize = function(s) { return s.replace(/[\\s\\u00A0\\u3000]+/g, ' ').trim(); };
            // __odVisibleText 已包含 textContent 回退并剔除 <style>/<script> 文本：
            // 此前裸用 textContent 会让页面里的 CSS 片段被当成"文本已出现"。
            var haystack = normalize(__odVisibleText(document.body) || '');
            if (haystack.indexOf(needle) !== -1) return true;
            var nNeedle = normalize(needle);
            if (nNeedle !== needle && haystack.indexOf(nNeedle) !== -1) return true;
            return false;
        })()`;

            let consecutiveFailures = 0;
            // CDP commands inside the polling loop must never hang for the full
            // 20s default timeout — a wedged connection (navigation race, frozen
            // guest renderer) would otherwise stall waitFor far beyond its own
            // deadline. A short command timeout keeps each poll bounded.
            const cdpTimeoutMs = Math.min(1500, timeoutMs);
            // WebFrameMain.executeJavaScript has no built-in timeout — a wedged
            // iframe would hang the poll past its deadline, so bound it here.
            const runFrameScript = async (
                frame: Electron.WebFrameMain,
                code: string,
                timeoutMs: number
            ): Promise<boolean> => {
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    return (await Promise.race([
                        frame.executeJavaScript(code),
                        new Promise<never>((_, reject) => {
                            timer = setTimeout(() => reject(new Error('iframe evaluate timed out')), timeoutMs);
                        })
                    ])) as boolean;
                } finally {
                    if (timer !== undefined) clearTimeout(timer);
                }
            };
            // 未指定 iframeRef 时检测范围覆盖主文档 + 全部子 frame（BUG-28）：
            // innerText 不跨 frame 边界，只查主文档会让 iframe 内明明存在的文本
            // 判定为"未出现"，而 textGone 又判定为"已消失"，两边都错。
            // 主 frame 的失败向上抛（保留"执行环境异常"熔断语义），子 frame 的
            // 失败（导航中/销毁）跳过该 frame 继续其它 frame。
            // 预算按 poll 截止时间逐 frame 重新计算：单个 hung frame 最多消耗到
            // deadline，多 frame 累计耗时也不会突破 waitFor 的总超时。
            const checkAllFrames = async (pollDeadline: number): Promise<boolean> => {
                const frameBudget = (): number => Math.min(cdpTimeoutMs, Math.max(0, pollDeadline - Date.now()));
                const root = session.webContents.mainFrame;
                if (!root) return false;
                if (await runFrameScript(root, checkExpr, frameBudget())) return true;
                let children: Electron.WebFrameMain[] = [];
                try {
                    children = root.frames;
                } catch {
                    children = [];
                }
                const visit = async (frame: Electron.WebFrameMain): Promise<boolean> => {
                    if (frameBudget() <= 0) return false;
                    try {
                        if (await runFrameScript(frame, checkExpr, frameBudget())) return true;
                    } catch {
                        // frame 正在导航/已销毁 —— 跳过
                    }
                    let subFrames: Electron.WebFrameMain[] = [];
                    try {
                        subFrames = frame.frames;
                    } catch {
                        subFrames = [];
                    }
                    for (const child of subFrames) {
                        if (await visit(child)) return true;
                    }
                    return false;
                };
                for (const child of children) {
                    if (await visit(child)) return true;
                }
                return false;
            };
            while (Date.now() < deadline) {
                // Every command inside a poll is bounded by the REMAINING budget,
                // recomputed before each individual command — a single poll runs
                // two commands (error check + text check), so computing the
                // budget once at the top would let the first command burn the
                // whole deadline and the second one start with stale, oversized
                // budget (e.g. timeout:1s would actually take ~2s when CDP
                // wedges). Recomputing keeps total wait strictly ≤ deadline.
                const commandTimeoutMs = () => Math.min(cdpTimeoutMs, Math.max(0, deadline - Date.now()));

                // Error pages (chrome-error://) can never satisfy a text condition —
                // fail fast with the actual error code instead of waiting out the
                // whole timeout.
                const pageError = await this.detectChromeError(session, commandTimeoutMs());
                if (pageError) {
                    throw new Error(`页面加载失败：${pageError}`);
                }

                try {
                    let found: boolean;
                    if (targetFrame) {
                        found = await runFrameScript(targetFrame, checkExpr, commandTimeoutMs());
                    } else {
                        found = await checkAllFrames(deadline);
                    }
                    consecutiveFailures = 0;
                    if (wantPresent ? found : !found) {
                        return { condition: wantPresent ? 'text found' : 'text gone' };
                    }
                } catch {
                    // A failing evaluate is NORMAL while the page is navigating
                    // (the JS context is destroyed during navigation). Only count
                    // it as a real failure when the webContents is no longer
                    // loading — otherwise a slow-but-viable navigation would be
                    // mistaken for a crashed tab.
                    //
                    // The guard applies to the main frame only: for iframe
                    // checks we cannot cheaply distinguish "iframe navigating"
                    // from "iframe crashed" (webContents.isLoading() reflects
                    // the top-level page), so iframe failures fall back to the
                    // plain timeout instead of risking a false positive.
                    // isLoading() itself can throw once the webContents is
                    // destroyed — treat that as "still loading" (timeout path).
                    let canCount = false;
                    try {
                        canCount =
                            !targetFrame && !session.webContents.isDestroyed() && !session.webContents.isLoading();
                    } catch {
                        canCount = false;
                    }
                    if (canCount) {
                        consecutiveFailures++;
                        if (consecutiveFailures >= 3) {
                            throw new Error('页面执行环境异常：连续多次检查失败，页面可能已崩溃或执行环境不可用');
                        }
                    }
                }
                // Sleep is also bounded by the remaining budget: a plain
                // pollInterval sleep after the deadline would burn up to 400ms
                // of extra wait for nothing.
                const sleepMs = Math.min(pollInterval, Math.max(0, deadline - Date.now()));
                if (sleepMs > 0) await sleep(sleepMs);
            }

            // 错误信息明确写出本次检测范围，避免 agent 误判"页面没加载/内容不存在"
            const scopeNote = targetFrame
                ? `（检测范围：iframe ${options.iframeRef}）`
                : `（检测范围：主文档及全部 iframe）`;
            throw new Error(
                `等待超时（${timeoutSec}秒）：${wantPresent ? `文本 "${needle}" 未出现` : `文本 "${needle}" 未消失`}${scopeNote}`
            );
        });
    }

    dispose(): void {
        this._cdpManager.disposeAll();
        this._mainWindow = null;
    }
}

// ---------------------------------------------------------------------------
// BrowserManager — singleton controller registry + IPC binding
// ---------------------------------------------------------------------------

/**
 * Run a script in the OpenDesk renderer, bounded by a timeout.
 * Used by the IPC bridge path (BrowserManager.bind) — same hang-protection
 * rationale as BrowserController._executeInRendererWithTimeout: a wedged
 * executeJavaScript must fail instead of blocking the caller forever.
 */
async function executeInRendererWithTimeout(
    mainWindow: BrowserRendererHost,
    script: string,
    timeoutMs: number,
    label: string
): Promise<any> {
    const jsPromise = mainWindow.webContents.executeJavaScript(script);

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            jsPromise,
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
            })
        ]);
    } finally {
        if (timeout !== undefined) clearTimeout(timeout);
    }
}

export class BrowserManager {
    private static _controllers = new Map<string, BrowserController>();
    private static _mainWindow: Electron.BrowserWindow | null = null;
    private static _rendererHost: BrowserRendererHost | null = null;
    private static _sessionManagerFactory: () => BrowserSessionManager = () => new CDPSessionManager();

    /** Configure host dependencies before creating controllers; existing sessions retain their owner. */
    static setSessionManagerFactory(factory?: () => BrowserSessionManager): void {
        if (BrowserManager._controllers.size)
            throw new Error('Dispose browser controllers before replacing their host');
        BrowserManager._sessionManagerFactory = factory ?? (() => new CDPSessionManager());
    }

    static get rendererHost(): BrowserRendererHost | null {
        return BrowserManager._rendererHost;
    }

    static setRendererHost(host: BrowserRendererHost | null): void {
        BrowserManager._rendererHost = host;
        for (const ctrl of BrowserManager._controllers.values()) ctrl.setMainWindow(host);
    }

    private static _browserSession: Electron.Session | null = null;
    private static _bound = false;
    private static _beforeCallRendererHooks: BrowserScriptGenerators | undefined;

    /** Get the main window reference (for direct renderer script execution). */
    static get mainWindow(): Electron.BrowserWindow | null {
        return BrowserManager._mainWindow;
    }

    /** Set the main window reference used when creating new controllers. */
    static setMainWindow(win: Electron.BrowserWindow | null): void {
        BrowserManager._mainWindow = win;
        BrowserManager.setRendererHost(win);
    }

    /** Get or create a BrowserController for the given instance ID. */
    static getOrCreateController(id: string, mainWindow?: Electron.BrowserWindow | null): BrowserController {
        let ctrl = BrowserManager._controllers.get(id);
        if (!ctrl) {
            ctrl = new BrowserController(
                id,
                mainWindow ?? BrowserManager._rendererHost,
                BrowserManager._beforeCallRendererHooks,
                BrowserManager._sessionManagerFactory()
            );
            BrowserManager._controllers.set(id, ctrl);
        }
        return ctrl;
    }

    /** Get an existing controller (returns undefined if not found). */
    static getController(id: string): BrowserController | undefined {
        return BrowserManager._controllers.get(id);
    }

    /** Remove and dispose a controller. */
    static removeController(id: string): void {
        const ctrl = BrowserManager._controllers.get(id);
        if (ctrl) {
            ctrl.dispose();
            BrowserManager._controllers.delete(id);
        }
    }

    /** Remove and dispose all controllers (app exit / bulk cleanup). */
    static removeAllControllers(): void {
        for (const id of Array.from(BrowserManager._controllers.keys())) {
            BrowserManager.removeController(id);
        }
    }

    /** Get the shared browser session. */
    static get browserSession(): Electron.Session | null {
        return BrowserManager._browserSession;
    }

    /**
     * Initialize the shared persistent browser session.
     */
    static async initSession(partition: string = 'persist:opendesk-browser'): Promise<Electron.Session | null> {
        try {
            // Dynamic import to avoid requiring electron at module load time
            const { session } = await import('electron');
            BrowserManager._browserSession = session.fromPartition(partition);
            BrowserManager._browserSession!.setPermissionRequestHandler(
                (_webContents: any, permission: string, callback: (allowed: boolean) => void) => {
                    const allowed = [
                        'clipboard-read',
                        'clipboard-sanitized-write',
                        'media',
                        'geolocation',
                        'notifications'
                    ];
                    callback(allowed.includes(permission));
                }
            );
            return BrowserManager._browserSession;
        } catch (err) {
            console.error(`Failed to initialize browser session: ${err}`);
            return null;
        }
    }

    /**
     * 将所有 session cookies 转为持久 cookies（30 天过期），确保登录态跨重启保留。
     */
    static async persistSessionCookies(): Promise<void> {
        const ses = BrowserManager._browserSession;
        if (!ses) return;
        const allCookies = await ses.cookies.get({ session: true });
        if (allCookies.length === 0) return;

        const persistentExpiry = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
        const promises: Promise<void>[] = [];

        for (const cookie of allCookies) {
            const url = `http${cookie.secure ? 's' : ''}://${cookie.domain?.replace(/^\./, '') || 'localhost'}${cookie.path || '/'}`;
            promises.push(
                ses.cookies
                    .set({
                        url,
                        name: cookie.name,
                        value: cookie.value,
                        domain: cookie.domain,
                        path: cookie.path,
                        secure: cookie.secure,
                        httpOnly: cookie.httpOnly,
                        sameSite: cookie.sameSite as any,
                        expirationDate: persistentExpiry
                    })
                    .catch(() => {})
            );
        }

        await Promise.all(promises);
    }

    /**
     * Bind IPC handlers for all browser channels.
     * This replaces the old registerBrowserAPIHandlers() in main.ts.
     *
     * @param ipcMain Electron IPC main instance
     * @param beforeCallRendererHooks 脚本生成器，包含在调用 renderer 桥接前执行的 hook 列表
     */
    static bind(
        ipcMain: { handle: (channel: string, listener: (event: any, ...args: any[]) => any) => void },
        beforeCallRendererHooks?: BrowserScriptGenerators
    ): void {
        if (BrowserManager._bound) return;
        BrowserManager._bound = true;
        BrowserManager._beforeCallRendererHooks = beforeCallRendererHooks;

        const runBeforeCallRendererHooks = async (taskId: string): Promise<void> => {
            if (!BrowserManager._rendererHost || !BrowserManager._beforeCallRendererHooks) return;
            for (const hook of BrowserManager._beforeCallRendererHooks.beforeCallRenderer) {
                await executeInRendererWithTimeout(
                    BrowserManager._rendererHost,
                    `(() => { ${hook(taskId)} })()`,
                    RENDERER_CALL_TIMEOUT_MS,
                    'beforeCallRenderer hook'
                );
            }
        };

        const callBrowserOnTask = async (taskId: string, method: string, ...args: unknown[]): Promise<IPCResponse> => {
            if (!BrowserManager._rendererHost) {
                return { status: 'error', message: 'No main window' };
            }
            try {
                await runBeforeCallRendererHooks(taskId);
                const result = await executeInRendererWithTimeout(
                    BrowserManager._rendererHost,
                    makeCallBrowserScript(taskId, method, args),
                    RENDERER_CALL_TIMEOUT_MS,
                    `renderer call ${method}`
                );
                if (result && result.error) {
                    return { status: 'error', message: result.error };
                }
                return { status: 'ok', data: result?.result ?? result };
            } catch (err) {
                return { status: 'error', message: String(err) };
            }
        };

        ipcMain.handle(Channels.navigate, async (_event: any, taskId: string, url: string) => {
            return callBrowserOnTask(taskId, 'browserNavigate', url);
        });

        ipcMain.handle(Channels.getState, async (_event: any, taskId: string) => {
            return callBrowserOnTask(taskId, 'browserGetState');
        });

        ipcMain.handle(Channels.executeScript, async (_event: any, taskId: string, script: string) => {
            if (!BrowserManager._rendererHost) {
                return { status: 'error', message: 'No main window' };
            }
            try {
                await runBeforeCallRendererHooks(taskId);
                const result = await executeInRendererWithTimeout(
                    BrowserManager._rendererHost,
                    makeExecuteScriptOnBrowser(taskId, script),
                    RENDERER_CALL_TIMEOUT_MS,
                    'browserExecuteScript'
                );
                if (result && result.error) {
                    return { status: 'error', message: result.error };
                }
                return { status: 'ok', data: result?.result ?? result };
            } catch (err) {
                return { status: 'error', message: String(err) };
            }
        });

        ipcMain.handle(Channels.goBack, async (_event: any, taskId: string) => {
            return callBrowserOnTask(taskId, 'browserGoBack');
        });

        ipcMain.handle(Channels.goForward, async (_event: any, taskId: string) => {
            return callBrowserOnTask(taskId, 'browserGoForward');
        });

        ipcMain.handle(Channels.refresh, async (_event: any, taskId: string) => {
            return callBrowserOnTask(taskId, 'browserRefresh');
        });

        ipcMain.handle(Channels.listTabs, async (_event: any, taskId: string) => {
            return callBrowserOnTask(taskId, 'browserListTabs');
        });

        ipcMain.handle(Channels.addTab, async (_event: any, taskId: string, url: string) => {
            return callBrowserOnTask(taskId, 'browserAddTab', url);
        });

        ipcMain.handle(Channels.closeTab, async (_event: any, taskId: string, tabId: number) => {
            return callBrowserOnTask(taskId, 'browserCloseTab', tabId);
        });

        ipcMain.handle(Channels.switchTab, async (_event: any, taskId: string, tabId: number) => {
            return callBrowserOnTask(taskId, 'browserSwitchTab', tabId);
        });

        ipcMain.handle(Channels.getWebContentsId, async (_event: any, taskId: string) => {
            return callBrowserOnTask(taskId, 'browserGetWebContentsId');
        });

        ipcMain.handle(Channels.captureScreenshot, async (_event: any, webContentsId: number) => {
            try {
                const data = await captureBrowserScreenshot(BrowserManager._rendererHost, webContentsId, {
                    format: 'jpeg',
                    quality: 70
                });
                if (!data) {
                    return { status: 'error', message: 'WebContents not found or destroyed' };
                }
                return { status: 'ok', data };
            } catch (err) {
                return { status: 'error', message: String(err) };
            }
        });

        ipcMain.handle(Channels.openDevTools, async (_event: any, webContentsId: number) => {
            try {
                const { webContents } = await import('electron');
                const wc = webContents.fromId(webContentsId);
                if (!wc || wc.isDestroyed()) {
                    return { status: 'error', message: 'WebContents not found or destroyed' };
                }
                wc.openDevTools();
                return { status: 'ok' };
            } catch (err) {
                return { status: 'error', message: String(err) };
            }
        });

        ipcMain.handle(Channels.exportSnapshot, async (_event: any, webContentsId: number) => {
            try {
                const { webContents } = await import('electron');
                const wc = webContents.fromId(webContentsId);
                if (!wc || wc.isDestroyed()) {
                    return { status: 'error', message: 'WebContents not found or destroyed' };
                }
                // 打开前就确定文案：文案 provider 每次导出按当前语言解析
                const data = await exportSnapshotToFile(wc, resolveSnapshotDialogTexts());
                return { status: 'ok', data };
            } catch (err) {
                // 失败留痕：导出失败在渲染端只会得到一次提示（或历史版本里被静默吞掉），
                // 日志是排查 attach 失败（DevTools 占用）、CDP 超时、写盘失败的唯一线索。
                getCDPLogger().warn(`exportSnapshot failed (webContentsId=${webContentsId}): ${String(err)}`);
                return { status: 'error', message: String(err) };
            }
        });
    }
}
