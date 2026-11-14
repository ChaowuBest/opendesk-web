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
 * Web 模式下 renderer preload 的 'electron' 模块替身（scripts/build-web-preload.mjs 打包时别名替换）。
 *
 * 原 preload.js 不做任何修改：contextBridge 直接挂到 window，ipcRenderer 走 WebSocket，
 * webUtils.getPathForFile 返回浏览器文件上传后的服务端路径。
 * 另外负责 web 环境特有的适配：file:// 与自定义协议地址改写、窗口控制与剪贴板的本地实现。
 */

import {
    WEB_FS_PATH,
    WEB_PROTO_PATH,
    WEB_UPLOAD_PATH,
    sanitizeUploadName,
    type WebBootConfig
} from '../../common/web/protocol.js';
import { WebIpcConnection } from './connection.js';
import { fileDialog, messageBox, openUrl, showAlert, type FileDialogOptions, type MessageBoxOptions } from './ui.js';

declare global {
    interface Window {
        __OPENDESK_WEB__?: WebBootConfig;
    }
}

type Listener = (event: unknown, ...args: unknown[]) => void;

const boot: WebBootConfig = window.__OPENDESK_WEB__ ?? {
    platform: 'linux',
    homePath: '/',
    schemes: [],
    uploadRoot: '/tmp'
};

// ── 上传 ─────────────────────────────────────────────────

const uploadedPaths = new WeakMap<File, string>();

function uploadFile(file: File): { path: string; done: Promise<void> } {
    const existing = uploadedPaths.get(file);
    if (existing) return { path: existing, done: Promise.resolve() };
    const id = crypto.randomUUID();
    const name = sanitizeUploadName(file.name);
    const filePath = `${boot.uploadRoot}/${id}/${name}`;
    uploadedPaths.set(file, filePath);
    const done = fetch(`${WEB_UPLOAD_PATH}?id=${id}&name=${encodeURIComponent(name)}`, {
        method: 'POST',
        body: file,
        credentials: 'same-origin'
    }).then((response) => {
        if (!response.ok) throw new Error(`upload ${file.name} failed: ${response.status}`);
    });
    done.catch((error) => console.error('[web]', error));
    connection.trackUpload(done);
    return { path: filePath, done };
}

async function uploadFiles(files: File[]): Promise<string[]> {
    const uploads = files.map(uploadFile);
    await Promise.all(uploads.map((upload) => upload.done));
    return uploads.map((upload) => upload.path);
}

// 拖放 / 粘贴 / <input type=file> 选中的文件立即开始上传，
// 之后 getPathForFile 同步返回落盘路径，后续 IPC 会等上传完成
function uploadFromList(list: FileList | null | undefined): void {
    for (const file of list ?? []) uploadFile(file);
}
window.addEventListener('drop', (event) => uploadFromList(event.dataTransfer?.files), true);
window.addEventListener('paste', (event) => uploadFromList(event.clipboardData?.files), true);
window.addEventListener(
    'change',
    (event) => {
        const target = event.target as HTMLInputElement | null;
        if (target?.tagName === 'INPUT' && target.type === 'file') uploadFromList(target.files);
    },
    true
);

// ── 服务端发起的交互 ──────────────────────────────────────

async function handleRequest(kind: string, payload: unknown): Promise<unknown> {
    if (kind === 'messageBox') return messageBox((payload ?? {}) as MessageBoxOptions);
    const options = (payload ?? {}) as FileDialogOptions;
    if (kind === 'saveDialog') return (await fileDialog('save', options, boot.homePath, uploadFiles))?.[0];
    const mode = options.properties?.includes('openDirectory') ? 'openDirectory' : 'openFile';
    return fileDialog(mode, options, boot.homePath, uploadFiles);
}

// ── ipcRenderer ──────────────────────────────────────────

const listeners = new Map<string, Listener[]>();

function emit(channel: string, args: unknown[]): void {
    const current = listeners.get(channel);
    if (!current) return;
    const event = { sender: ipcRenderer, senderId: 0, ports: [] };
    for (const listener of [...current]) {
        try {
            listener(event, ...args);
        } catch (error) {
            console.error(`[web] ipcRenderer listener for "${channel}" threw`, error);
        }
    }
}

const connection = new WebIpcConnection(emit, handleRequest, openUrl, showAlert);

let memoryClipboard = '';

function copyWithExecCommand(text: string): void {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(textarea);
    textarea.select();
    try {
        document.execCommand('copy');
    } finally {
        textarea.remove();
    }
}

const ok = () => ({ status: 'ok' });
const noop = () => undefined;

/**
 * 只能在浏览器侧完成的通道：窗口控制作用于浏览器标签而非隐藏的主窗口，
 * 剪贴板使用访问者本机剪贴板，新窗口用浏览器新标签页打开。
 */
const localInvoke: Record<string, (...args: unknown[]) => unknown> = {
    'window:close': noop,
    'window:minimize': noop,
    'window:maximize': noop,
    'window:isMaximized': () => ({ status: 'ok', data: false }),
    'setting:closeMainWindow': ok,
    'setting:minimizeMainWindow': ok,
    'setting:maximizeMainWindow': ok,
    'setting:isMaximized': () => ({ status: 'ok', data: false }),
    'app:quit': noop,
    // 主进程只能打开隐藏主窗口的 DevTools；web 模式用浏览器自带的开发者工具
    'setting:openDevTools': noop,
    'clipboard:readText': async () => {
        try {
            return (await navigator.clipboard?.readText()) ?? memoryClipboard;
        } catch {
            return memoryClipboard;
        }
    },
    'clipboard:writeText': async (text: unknown) => {
        if (typeof text !== 'string') return;
        memoryClipboard = text;
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            // 非安全上下文（http + 非 localhost）没有 Clipboard API
            copyWithExecCommand(text);
        }
    },
    'application:openInNewWindow': (bundleName: unknown) => {
        if (bundleName === 'browser') {
            return { status: 'error', message: 'browser application does not support separate window' };
        }
        openUrl(`./application_window.html?applicationBundleName=${encodeURIComponent(String(bundleName))}`);
        return { status: 'ok' };
    },
    'setting:openLogWindow': () => {
        openUrl('./logview_window.html');
        return { status: 'ok' };
    }
};

export const ipcRenderer = {
    invoke(channel: string, ...args: unknown[]): Promise<unknown> {
        const local = localInvoke[channel];
        if (local) {
            try {
                return Promise.resolve(local(...args));
            } catch (error) {
                return Promise.reject(error);
            }
        }
        return connection.invoke(channel, args);
    },
    send(channel: string, ...args: unknown[]): void {
        connection.send(channel, args);
    },
    sendSync(channel: string): undefined {
        console.warn(`[web] ipcRenderer.sendSync("${channel}") is not supported in web mode`);
        return undefined;
    },
    sendToHost(): void {},
    postMessage(channel: string, message: unknown): void {
        connection.send(channel, [message]);
    },
    on(channel: string, listener: Listener) {
        const current = listeners.get(channel);
        if (current) current.push(listener);
        else listeners.set(channel, [listener]);
        return ipcRenderer;
    },
    addListener(channel: string, listener: Listener) {
        return ipcRenderer.on(channel, listener);
    },
    once(channel: string, listener: Listener) {
        const wrapped: Listener = (event, ...args) => {
            ipcRenderer.removeListener(channel, wrapped);
            listener(event, ...args);
        };
        return ipcRenderer.on(channel, wrapped);
    },
    removeListener(channel: string, listener: Listener) {
        const current = listeners.get(channel);
        if (!current) return ipcRenderer;
        const index = current.lastIndexOf(listener);
        if (index >= 0) current.splice(index, 1);
        if (current.length === 0) listeners.delete(channel);
        return ipcRenderer;
    },
    off(channel: string, listener: Listener) {
        return ipcRenderer.removeListener(channel, listener);
    },
    removeAllListeners(channel?: string) {
        if (channel === undefined) listeners.clear();
        else listeners.delete(channel);
        return ipcRenderer;
    },
    listenerCount(channel: string): number {
        return listeners.get(channel)?.length ?? 0;
    },
    listeners(channel: string): Listener[] {
        return [...(listeners.get(channel) ?? [])];
    }
};

// ── contextBridge / webUtils ─────────────────────────────

function exposeInMainWorld(key: string, api: unknown): void {
    if (key in window) {
        throw new Error(`Cannot bind an API on top of an existing property on the window object: ${key}`);
    }
    Object.defineProperty(window, key, { value: api, enumerable: true, configurable: true, writable: true });
}

export const contextBridge = {
    exposeInMainWorld,
    exposeInIsolatedWorld: (_worldId: number, key: string, api: unknown) => exposeInMainWorld(key, api)
};

export const webUtils = {
    getPathForFile(file: File): string {
        return uploadFile(file).path;
    }
};

export default { ipcRenderer, contextBridge, webUtils };

// Electron 的 frame preload 会进入 srcdoc / about:blank 子 frame（如笔记编辑器），提供剪贴板桥；
// 这类 frame 不经过 web 服务、没有注入 preload，同源时直接补上同一个桥
document.addEventListener(
    'load',
    (event) => {
        if (!(event.target instanceof HTMLIFrameElement)) return;
        try {
            const child = event.target.contentWindow;
            if (!child || child.__OPENDESK_WEB__ || child.childFrameClipboard) return;
            child.childFrameClipboard = {
                readText: async () => String((await ipcRenderer.invoke('clipboard:readText')) ?? ''),
                writeText: async (text: string) => {
                    await ipcRenderer.invoke('clipboard:writeText', text);
                }
            };
        } catch {
            // 跨源子 frame 无法访问，与桌面端一致不提供桥
        }
    },
    true
);

// 浏览器标签页没有可最小化/最大化/关闭的窗口：隐藏各页面自绘标题栏上的窗口按钮
const hideWindowControls = document.createElement('style');
hideWindowControls.textContent = [
    '#minimize-btn',
    '#maximize-btn',
    '#close-drag-overlay-btn',
    '#app-minimize-btn',
    '#app-maximize-btn',
    '#app-close-btn',
    '#log-minimize-btn',
    '#log-maximize-btn',
    '#log-close-btn'
]
    .map((selector) => `${selector}{display:none!important}`)
    .join('');
document.documentElement.appendChild(hideWindowControls);

// ── 本机文件与自定义协议地址改写 ──────────────────────────

/** file:// 与 opendesk-app:// 等浏览器无法加载的地址 → 同源 HTTP 代理地址；无需改写时返回 null */
export function rewriteResourceUrl(value: string): string | null {
    if (!value) return null;
    if (/^file:\/\//i.test(value)) {
        try {
            const url = new URL(value);
            return `${WEB_FS_PATH}${url.pathname}${url.search}${url.hash}`;
        } catch {
            return null;
        }
    }
    const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value);
    if (match && boot.schemes.includes(match[1].toLowerCase())) {
        return `${WEB_PROTO_PATH}/${match[1].toLowerCase()}/${value.slice(match[0].length)}`;
    }
    return null;
}

const RESOURCE_ATTRIBUTES = ['src', 'poster'];

function rewriteElement(element: Element): void {
    for (const attribute of RESOURCE_ATTRIBUTES) {
        const value = element.getAttribute(attribute);
        const rewritten = value && rewriteResourceUrl(value);
        if (rewritten) element.setAttribute(attribute, rewritten);
    }
    // <link rel=stylesheet href=file://...>；<a href> 保留原值，交给页面自己的点击逻辑
    if (element.tagName === 'LINK') {
        const href = element.getAttribute('href');
        const rewritten = href && rewriteResourceUrl(href);
        if (rewritten) element.setAttribute('href', rewritten);
    }
}

function rewriteTree(node: Node): void {
    if (!(node instanceof Element)) return;
    rewriteElement(node);
    for (const child of node.querySelectorAll('[src],[poster],link[href]')) rewriteElement(child);
}

new MutationObserver((mutations) => {
    for (const mutation of mutations) {
        if (mutation.type === 'attributes') rewriteElement(mutation.target as Element);
        else mutation.addedNodes.forEach(rewriteTree);
    }
}).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'poster', 'href'] });

// 属性设置器：覆盖 new Image().src 这类不入 DOM 的加载
for (const proto of [
    HTMLImageElement.prototype,
    HTMLIFrameElement.prototype,
    HTMLMediaElement.prototype,
    HTMLSourceElement.prototype,
    HTMLEmbedElement.prototype
]) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'src');
    if (!descriptor?.set) continue;
    const setter = descriptor.set;
    Object.defineProperty(proto, 'src', {
        ...descriptor,
        set(value: string) {
            setter.call(this, rewriteResourceUrl(String(value)) ?? value);
        }
    });
}

const originalFetch = window.fetch.bind(window);
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const rewritten = rewriteResourceUrl(url);
    if (!rewritten) return originalFetch(input, init);
    return originalFetch(
        rewritten,
        input instanceof Request ? { ...init, method: input.method, headers: input.headers } : init
    );
};

// 页面没有处理的 file:// / 自定义协议链接点击：在新标签页打开代理地址
window.addEventListener('click', (event) => {
    if (event.defaultPrevented) return;
    const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    const rewritten = anchor && rewriteResourceUrl(anchor.getAttribute('href') ?? '');
    if (!rewritten) return;
    event.preventDefault();
    openUrl(rewritten);
});
