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
 * Web 模式下替代原生界面的轻量 UI：连接状态条、提示、文件/目录/保存对话框、消息框。
 * 全部挂在独立 Shadow DOM 中，不受也不影响页面样式。
 */

import { WEB_LIST_PATH, WEB_MKDIR_PATH, type DirectoryListing } from '../../common/web/protocol.js';
import { createRendererTranslator } from '../locale.js';

// 设置加载前即需显示（连接状态），按浏览器语言选择文案
const t = createRendererTranslator();
const T = {
    connecting: t('renderer.webMode.connecting'),
    reconnecting: t('renderer.webMode.reconnecting'),
    cancel: t('renderer.webMode.cancel'),
    ok: t('renderer.webMode.ok'),
    open: t('renderer.webMode.open'),
    save: t('renderer.webMode.save'),
    select: t('renderer.webMode.selectFolder'),
    up: t('renderer.webMode.up'),
    upload: t('renderer.webMode.upload'),
    newFolder: t('renderer.webMode.newFolder'),
    folderName: t('renderer.webMode.folderName'),
    fileName: t('renderer.webMode.fileName'),
    openFile: t('renderer.webMode.openFileTitle'),
    openDirectory: t('renderer.webMode.openDirectoryTitle'),
    saveFile: t('renderer.webMode.saveFileTitle'),
    popupBlocked: t('renderer.webMode.popupBlocked'),
    openLinkTitle: t('renderer.webMode.openLinkTitle'),
    openLink: t('renderer.webMode.openLink'),
    copyLink: t('renderer.webMode.copyLink'),
    close: t('renderer.webMode.close'),
    empty: t('renderer.webMode.empty')
};

const STYLE = `
:host{all:initial}
*{box-sizing:border-box;font-family:-apple-system,'PingFang SC','Microsoft YaHei UI','Segoe UI',sans-serif;font-size:13px}
.banner{position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#333;color:#fff;padding:6px 14px;border-radius:999px;box-shadow:0 2px 10px rgba(0,0,0,.25)}
.toast{position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#333;color:#fff;padding:10px 14px;border-radius:8px;max-width:420px;word-break:break-all;box-shadow:0 2px 10px rgba(0,0,0,.25)}
.toast a{color:#8ab4ff}
.mask{position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center}
.dlg{background:#fff;color:#222;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.3);width:min(640px,92vw);max-height:84vh;display:flex;flex-direction:column;overflow:hidden}
.hd{padding:14px 16px;font-weight:600;font-size:14px;border-bottom:1px solid #eee}
.bar{display:flex;gap:6px;padding:10px 16px;border-bottom:1px solid #eee}
.bar input{flex:1}
input[type=text]{padding:6px 8px;border:1px solid #ccc;border-radius:6px;outline:none;min-width:0}
input[type=text]:focus{border-color:#2f6bff}
.list{flex:1;overflow:auto;min-height:240px;padding:4px 0}
.row{padding:6px 16px;cursor:default;display:flex;gap:8px;align-items:center;user-select:none}
.row:hover{background:#f3f5f9}
.row.sel{background:#dce6ff}
.row .ic{width:16px;text-align:center;opacity:.7}
.muted{color:#999;padding:12px 16px}
.err{color:#c62828;padding:8px 16px}
.ft{display:flex;gap:8px;padding:12px 16px;border-top:1px solid #eee;align-items:center}
.ft .sp{flex:1}
button{padding:6px 14px;border-radius:6px;border:1px solid #ccc;background:#fff;color:#222;cursor:pointer}
button.primary{background:#2f6bff;border-color:#2f6bff;color:#fff}
button:disabled{opacity:.5;cursor:default}
.msg{padding:16px;white-space:pre-wrap;line-height:1.5}
.detail{padding:0 16px 12px;color:#666;white-space:pre-wrap}
.chk{padding:0 16px 12px;display:flex;gap:6px;align-items:center}
@media (prefers-color-scheme: dark){
.dlg{background:#2b2b2b;color:#e6e6e6}.hd,.bar,.ft{border-color:#3a3a3a}
.row:hover{background:#363636}.row.sel{background:#2d4170}
input[type=text]{background:#1f1f1f;color:#e6e6e6;border-color:#444}
button{background:#3a3a3a;color:#e6e6e6;border-color:#4a4a4a}.detail{color:#aaa}}
`;

let root: ShadowRoot | null = null;

function getRoot(): ShadowRoot {
    if (root) return root;
    const host = document.createElement('opendesk-web-ui');
    (document.body ?? document.documentElement).appendChild(host);
    root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    root.appendChild(style);
    return root;
}

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
    children: Array<Node | string> = []
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const child of children) node.append(child);
    return node;
}

function whenDomReady(fn: () => void): void {
    if (document.body) fn();
    else document.addEventListener('DOMContentLoaded', fn, { once: true });
}

let banner: HTMLElement | null = null;
let bannerTimer: ReturnType<typeof setTimeout> | undefined;

/** null 隐藏；首次连接稍等片刻再显示，避免正常加载时闪一下 */
export function showConnectionBanner(state: 'connecting' | 'reconnecting' | null): void {
    clearTimeout(bannerTimer);
    if (state === null) {
        banner?.remove();
        banner = null;
        return;
    }
    bannerTimer = setTimeout(
        () =>
            whenDomReady(() => {
                if (!banner) {
                    banner = el('div', { className: 'banner' });
                    getRoot().appendChild(banner);
                }
                banner.textContent = state === 'connecting' ? T.connecting : T.reconnecting;
            }),
        state === 'connecting' ? 1500 : 0
    );
}

export function showToast(content: Array<Node | string>, durationMs = 8000): void {
    whenDomReady(() => {
        const toast = el('div', { className: 'toast' }, content);
        getRoot().appendChild(toast);
        setTimeout(() => toast.remove(), durationMs);
    });
}

function openInNewTab(url: string): boolean {
    // 不带 noopener：带上它时 window.open 恒返回 null，无法判断是否被拦截；打开后再断开 opener
    const opened = window.open(url, '_blank');
    if (!opened) return false;
    try {
        opened.opener = null;
    } catch {
        // 跨源窗口不允许写 opener，忽略
    }
    return true;
}

/**
 * 打开 URL。主进程转来的 shell.openExternal（如插件发起的 SSO 授权）不是用户手势，
 * 常被浏览器拦截弹窗；此时弹出不会自动消失的对话框，由用户点击（真实手势）打开。
 */
export function openUrl(url: string): void {
    if (openInNewTab(url)) return;
    let unmount = () => {};
    const openButton = el('button', { className: 'primary', textContent: T.openLink });
    openButton.addEventListener('click', () => {
        openInNewTab(url);
        unmount();
    });
    const copyButton = el('button', { textContent: T.copyLink });
    copyButton.addEventListener('click', () => {
        void navigator.clipboard?.writeText(url).catch(() => undefined);
    });
    const closeButton = el('button', { textContent: T.close });
    closeButton.addEventListener('click', () => unmount());
    const dialog = el('div', { className: 'dlg', tabIndex: -1 }, [
        el('div', { className: 'hd', textContent: T.openLinkTitle }),
        el('div', { className: 'msg', textContent: T.popupBlocked }),
        el('div', { className: 'detail', textContent: url }),
        el('div', { className: 'ft' }, [el('span', { className: 'sp' }), closeButton, copyButton, openButton])
    ]);
    whenDomReady(() => {
        unmount = mount(dialog, () => unmount());
        openButton.focus();
    });
}

export function showAlert(title: string, message: string): void {
    void messageBox({ title, message, buttons: [T.ok] });
}

function mount(dialog: HTMLElement, onEscape: () => void): () => void {
    const mask = el('div', { className: 'mask' }, [dialog]);
    const onKey = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
            event.stopPropagation();
            onEscape();
        }
    };
    mask.addEventListener('keydown', onKey);
    getRoot().appendChild(mask);
    return () => mask.remove();
}

// ── 消息框 ───────────────────────────────────────────────

export interface MessageBoxOptions {
    title?: string;
    message?: string;
    detail?: string;
    buttons?: string[];
    defaultId?: number;
    cancelId?: number;
    checkboxLabel?: string;
    checkboxChecked?: boolean;
}

export function messageBox(options: MessageBoxOptions): Promise<{ response: number; checkboxChecked: boolean }> {
    return new Promise((resolve) => {
        const buttons = options.buttons && options.buttons.length > 0 ? options.buttons : [T.ok];
        const cancelId = options.cancelId ?? (buttons.length > 1 ? buttons.length - 1 : 0);
        const checkbox = el('input', { type: 'checkbox', checked: !!options.checkboxChecked });
        let unmount = () => {};
        const finish = (response: number) => {
            unmount();
            resolve({ response, checkboxChecked: checkbox.checked });
        };

        const footer = el('div', { className: 'ft' }, [el('span', { className: 'sp' })]);
        buttons.forEach((label, index) => {
            const button = el('button', {
                textContent: label,
                className: index === (options.defaultId ?? 0) ? 'primary' : ''
            });
            button.addEventListener('click', () => finish(index));
            footer.append(button);
        });

        const dialog = el('div', { className: 'dlg', tabIndex: -1 }, [
            ...(options.title ? [el('div', { className: 'hd', textContent: options.title })] : []),
            el('div', { className: 'msg', textContent: options.message ?? '' }),
            ...(options.detail ? [el('div', { className: 'detail', textContent: options.detail })] : []),
            ...(options.checkboxLabel ? [el('label', { className: 'chk' }, [checkbox, options.checkboxLabel])] : []),
            footer
        ]);
        unmount = mount(dialog, () => finish(cancelId));
        (footer.querySelector('button.primary') as HTMLButtonElement | null)?.focus();
    });
}

// ── 文件 / 目录 / 保存对话框（浏览服务端文件系统）─────────────

export interface FileDialogOptions {
    title?: string;
    defaultPath?: string;
    buttonLabel?: string;
    properties?: string[];
    filters?: Array<{ name: string; extensions: string[] }>;
}

type FileDialogMode = 'openFile' | 'openDirectory' | 'save';

async function fetchListing(dirPath: string): Promise<DirectoryListing> {
    const response = await fetch(`${WEB_LIST_PATH}?files=1&path=${encodeURIComponent(dirPath)}`, {
        credentials: 'same-origin'
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error || response.statusText);
    return body as DirectoryListing;
}

function joinPath(dir: string, name: string): string {
    return dir.endsWith('/') ? dir + name : `${dir}/${name}`;
}

function splitDefaultPath(
    defaultPath: string | undefined,
    mode: FileDialogMode,
    home: string
): { dir: string; name: string } {
    if (!defaultPath) return { dir: home, name: '' };
    const normalized = defaultPath.replace(/\\/g, '/');
    if (mode !== 'save') return { dir: normalized, name: '' };
    const index = normalized.lastIndexOf('/');
    if (index < 0) return { dir: home, name: normalized };
    return { dir: normalized.slice(0, index) || '/', name: normalized.slice(index + 1) };
}

function matchesFilters(name: string, filters: FileDialogOptions['filters']): boolean {
    if (!filters || filters.length === 0) return true;
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
    return filters.some((filter) => filter.extensions.some((e) => e === '*' || e.toLowerCase() === ext));
}

/**
 * 返回：openFile → 选中路径数组；openDirectory → [目录]；save → [完整路径]；取消 → undefined。
 * uploadFiles 由调用方提供（上传本地文件并返回服务端路径）。
 */
export function fileDialog(
    mode: FileDialogMode,
    options: FileDialogOptions,
    homePath: string,
    uploadFiles: (files: File[]) => Promise<string[]>
): Promise<string[] | undefined> {
    return new Promise((resolve) => {
        const multi = !!options.properties?.includes('multiSelections');
        const start = splitDefaultPath(options.defaultPath, mode, homePath);
        let current = start.dir;
        const selected = new Set<string>();

        const pathInput = el('input', { type: 'text', value: current });
        const upButton = el('button', { textContent: T.up });
        const list = el('div', { className: 'list' });
        const error = el('div', { className: 'err' });
        error.hidden = true;
        const nameInput = el('input', { type: 'text', value: start.name, placeholder: T.fileName });
        const confirm = el('button', {
            className: 'primary',
            textContent:
                options.buttonLabel || (mode === 'save' ? T.save : mode === 'openDirectory' ? T.select : T.open)
        });
        const cancel = el('button', { textContent: T.cancel });
        const newFolder = el('button', { textContent: T.newFolder });
        const upload = el('button', { textContent: T.upload });

        let unmount = () => {};
        const finish = (value: string[] | undefined) => {
            unmount();
            resolve(value);
        };

        const refreshConfirm = () => {
            if (mode === 'openFile') confirm.disabled = selected.size === 0;
            if (mode === 'save') confirm.disabled = nameInput.value.trim() === '';
        };

        const navigate = async (target: string) => {
            error.hidden = true;
            try {
                const listing = await fetchListing(target);
                current = listing.path;
                pathInput.value = current;
                upButton.disabled = listing.parent === null;
                upButton.onclick = () => listing.parent && void navigate(listing.parent);
                selected.clear();
                list.replaceChildren();
                const entries = listing.entries.filter(
                    (entry) =>
                        entry.directory || (mode !== 'openDirectory' && matchesFilters(entry.name, options.filters))
                );
                if (entries.length === 0) list.append(el('div', { className: 'muted', textContent: T.empty }));
                for (const entry of entries) {
                    const row = el('div', { className: 'row' }, [
                        el('span', { className: 'ic', textContent: entry.directory ? '📁' : '📄' }),
                        entry.name
                    ]);
                    if (entry.directory) {
                        row.addEventListener('click', () => void navigate(entry.path));
                    } else if (mode === 'openFile') {
                        row.addEventListener('click', () => {
                            if (!multi) {
                                selected.clear();
                                list.querySelectorAll('.row.sel').forEach((n) => n.classList.remove('sel'));
                            }
                            if (selected.has(entry.path)) {
                                selected.delete(entry.path);
                                row.classList.remove('sel');
                            } else {
                                selected.add(entry.path);
                                row.classList.add('sel');
                            }
                            refreshConfirm();
                        });
                        row.addEventListener('dblclick', () => finish([entry.path]));
                    } else if (mode === 'save') {
                        row.addEventListener('click', () => {
                            nameInput.value = entry.name;
                            refreshConfirm();
                        });
                    }
                    list.append(row);
                }
                refreshConfirm();
            } catch (e) {
                error.textContent = (e as Error).message;
                error.hidden = false;
            }
        };

        pathInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') void navigate(pathInput.value.trim() || '/');
        });
        nameInput.addEventListener('input', refreshConfirm);
        cancel.addEventListener('click', () => finish(undefined));
        confirm.addEventListener('click', () => {
            if (mode === 'openDirectory') finish([current]);
            else if (mode === 'save') finish([joinPath(current, nameInput.value.trim())]);
            else finish([...selected]);
        });
        newFolder.addEventListener('click', async () => {
            const name = window.prompt(T.folderName)?.trim();
            if (!name) return;
            const target = joinPath(current, name);
            const response = await fetch(`${WEB_MKDIR_PATH}?path=${encodeURIComponent(target)}`, {
                method: 'POST',
                credentials: 'same-origin'
            });
            if (response.ok) void navigate(target);
            else {
                error.textContent =
                    ((await response.json().catch(() => ({}))) as { error?: string }).error || response.statusText;
                error.hidden = false;
            }
        });
        upload.addEventListener('click', () => {
            const input = el('input', { type: 'file', multiple: multi });
            input.addEventListener('change', async () => {
                const files = [...(input.files ?? [])];
                if (files.length === 0) return;
                finish(await uploadFiles(files));
            });
            input.click();
        });

        const title =
            options.title || (mode === 'save' ? T.saveFile : mode === 'openDirectory' ? T.openDirectory : T.openFile);
        const footer = el('div', { className: 'ft' }, [
            ...(mode === 'openFile' ? [upload] : [newFolder]),
            ...(mode === 'save' ? [nameInput] : []),
            el('span', { className: 'sp' }),
            cancel,
            confirm
        ]);
        if (mode === 'save') nameInput.style.flex = '1';

        const dialog = el('div', { className: 'dlg', tabIndex: -1 }, [
            el('div', { className: 'hd', textContent: title }),
            el('div', { className: 'bar' }, [upButton, pathInput]),
            error,
            list,
            footer
        ]);
        unmount = mount(dialog, () => finish(undefined));
        void navigate(current);
        dialog.focus();
    });
}
