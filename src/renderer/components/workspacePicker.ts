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

import { OVERLAY_CSS } from '../../common/overlay-styles.js';
import { FileSelector } from './fileSelector.ts';
import { showConfirmModal, renderIcon, detectDarkMode, bindOverlayDismiss } from './confirmModal.ts';
import { escapeHtml } from '../../common/utils/escape.js';
import { createRendererTranslator } from '../locale.ts';

declare const window: Window & {
    systemInfo?: {
        isWindows?: boolean;
        isOpenHarmony?: boolean;
        harmonyRuntime?: {
            variant: 'pc' | 'tablet';
            appDataDir: string;
            browseRoots: { kind: 'userHome' | 'appSandbox'; path: string }[];
        } | null;
    };
    workspaceAPI: {
        getEffectiveWorkspace(): Promise<string>;
        setWorkspaceDirectory(path: string): Promise<string>;
        getRecentWorkspaces(): Promise<string[]>;
        removeRecentWorkspace(workspacePath: string): Promise<void>;
        listDirectory(
            path: string,
            opts?: { includeFiles?: boolean; extensions?: string[] }
        ): Promise<{ name: string; path: string; isDirectory: boolean; isDrive?: boolean }[]>;
        listDrives(): Promise<{ name: string; path: string; isDirectory: boolean; isDrive?: boolean }[] | null>;
        renameEntry(oldPath: string, newName: string): Promise<string>;
        createDirectory(parentPath: string, dirName: string): Promise<string>;
        deleteEntry(entryPath: string): Promise<void>;
        pickDirectoryDialog(): Promise<string | null>;
    };
};

const ANIM_DURATION_IN = 250;
const ANIM_DURATION_OUT = 180;

interface WorkspacePickerOptions {
    title?: string;
    initialWorkspace?: string;
    /** 可选的翻译器（已携带 locale 设置）。缺省时按浏览器语言自动检测。 */
    t?: (key: string, params?: Record<string, string | number>) => string;
}

/**
 * 工作空间选择器模态弹窗。
 *
 * 展示最近使用的工作空间列表 + macOS NSBrowser 风格的列视图目录浏览器。
 * 返回 Promise<string | null>：用户选择的路径，取消时为 null。
 */
export function showWorkspacePicker(options: WorkspacePickerOptions = {}): Promise<string | null> {
    const t = options.t ?? createRendererTranslator();
    return new Promise((resolve) => {
        let resolved = false;
        let recentWorkspaces: string[] = [];
        let currentWorkspace = '';
        let dirSelector: FileSelector | null = null;

        const overlay = document.createElement('div');
        overlay.className = 'od-ws-picker-overlay od-overlay';
        if (detectDarkMode()) {
            overlay.classList.add('od-ws-dark', 'od-modal-dark');
        }

        const close = (result: string | null) => {
            if (resolved) return;
            resolved = true;
            overlay.classList.add('od-ws-leaving');
            setTimeout(() => {
                overlay.remove();
                resolve(result);
            }, ANIM_DURATION_OUT);
            document.removeEventListener('keydown', escHandler);
        };

        const escHandler = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;

            // 确认弹窗打开时，让它自己处理 Esc
            if (document.querySelector('.od-confirm-modal-overlay:not([hidden])')) return;

            // 右键菜单打开时，仅关闭菜单
            if (dirSelector?.hasOpenMenu) {
                dirSelector.dismissMenu();
                return;
            }

            // 内联编辑中（重命名 / 新建文件夹），由 input 的 keydown 处理
            if (dirSelector?.isEditing) return;

            close(null);
        };
        document.addEventListener('keydown', escHandler);

        function buildRecentItems(): string {
            if (recentWorkspaces.length === 0) {
                return `<div class="od-ws-recent-empty">${t('renderer.workspacePicker.recentEmpty')}</div>`;
            }
            return recentWorkspaces
                .map((p) => {
                    const dirName = p.split('/').pop() || p;
                    return `<div class="od-ws-recent-item" data-path="${p}" title="${p}">
                        <i class="fa-solid fa-clock-rotate-left od-ws-recent-item-icon"></i>
                        <span class="od-ws-recent-item-name">${dirName}</span>
                        <span class="od-ws-recent-item-path">${p}</span>
                        <button class="od-ws-recent-remove" data-action="remove-recent" data-path="${p}" title="${t('renderer.workspacePicker.removeRecent')}">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                    </div>`;
                })
                .join('');
        }

        function renderOverlay() {
            overlay.innerHTML = `
<style>
${OVERLAY_CSS}
    .od-ws-picker-overlay {
        position: fixed; inset: 0; z-index: 99999;
        display: flex; align-items: center; justify-content: center;
        animation: od-ws-fade-in ${ANIM_DURATION_IN}ms ease-out forwards;
    }
    .od-ws-picker-overlay.od-ws-leaving {
        animation: od-ws-fade-out ${ANIM_DURATION_OUT}ms ease-in forwards;
    }
    .od-ws-picker-panel {
        background: var(--od-bg-elevated, #fff); border-radius: 16px;
        box-shadow: 0 24px 80px rgba(0,0,0,0.18), 0 0 1px rgba(0,0,0,0.1);
        width: 720px; max-width: 92vw; height: 72vh; max-height: 680px;
        display: flex; flex-direction: column; overflow: hidden;
	        contain: layout style;
        animation: od-ws-scale-in ${ANIM_DURATION_IN}ms cubic-bezier(0.23, 1, 0.32, 1) forwards;
    }
    .od-ws-picker-overlay.od-ws-leaving .od-ws-picker-panel {
        animation: od-ws-scale-out ${ANIM_DURATION_OUT}ms ease-in forwards;
    }
    .od-ws-header {
        display: flex; align-items: center; gap: 12px;
        padding: 16px 24px; background: #EBF1FB;
        border-bottom: 1px solid var(--od-border, rgba(0,0,0,0.08));
    }
    .od-ws-dark .od-ws-header { background: rgba(122,162,232,0.16); }
    .od-ws-header-icon {
        width: 36px; height: 36px; border-radius: 10px; flex-shrink: 0;
        background: #4267B2; display: flex; align-items: center; justify-content: center;
    }
    .od-ws-dark .od-ws-header-icon { background: #7AA2E8; }
    .od-ws-header-icon svg { width: 17px; height: 17px; color: #fff; }
    .od-ws-header-title {
        flex: 1; min-width: 0;
        font-size: 15px; font-weight: 700; color: var(--od-text, #1d1d1f);
        line-height: 1.3;
    }
    .od-ws-close-btn {
        width: 26px; height: 26px; border-radius: 7px; border: none;
        background: rgba(0,0,0,0.06); color: var(--od-text-muted, #8e8e93);
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        flex-shrink: 0; transition: background 0.15s, color 0.15s;
    }
    .od-ws-dark .od-ws-close-btn { background: rgba(255,255,255,0.08); }
    .od-ws-close-btn:hover { background: rgba(0,0,0,0.12); color: var(--od-text, #1d1d1f); }
    .od-ws-dark .od-ws-close-btn:hover { background: rgba(255,255,255,0.15); }
    .od-ws-close-btn svg { width: 13px; height: 13px; }
    .od-ws-current {
        padding: 10px 22px; background: var(--od-bg-muted, #f9fafb); border-bottom: 1px solid var(--od-border, rgba(0,0,0,0.08));
        font-size: var(--fs-md); color: var(--od-text-muted, #6b7280); display: flex; align-items: center; gap: 6px;
        min-width: 0;
    }
    .od-ws-current-path {
        color: var(--od-text, #374151); font-weight: 500;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;
        cursor: text; border-radius: 4px; padding: 1px 4px; margin-left: -4px;
        transition: background 0.12s;
    }
    .od-ws-current-path:hover { background: var(--od-bg-subtle, #f3f4f6); }
    .od-ws-current-edit {
        flex: 1; min-width: 0; font-size: var(--fs-md); font-family: inherit; font-weight: 500;
        border: 1px solid var(--od-accent, #3b82f6); border-radius: 4px; outline: none;
        padding: 1px 4px; color: var(--od-text, #1f2937); background: var(--od-bg-elevated, #fff);
    }
    .od-ws-pick-btn {
        flex-shrink: 0; margin-left: auto; display: inline-flex; align-items: center; gap: 4px;
        padding: 3px 10px; border-radius: 6px; border: 1px solid var(--od-border-strong, #e5e5ea);
        background: var(--od-bg-elevated, #fff); color: var(--od-text-muted, #6b7280);
        font-size: var(--fs-sm); font-family: inherit; cursor: pointer;
        transition: all 0.15s; white-space: nowrap;
    }
    .od-ws-pick-btn:hover { border-color: var(--od-accent, #3b82f6); color: var(--od-accent, #3b82f6); }
    .od-ws-pick-btn i { font-size: var(--fs-sm); }
    .od-ws-body { flex: 1; overflow: hidden; display: flex; flex-direction: column; min-height: 0; padding-bottom: 10px; }

    /* 最近使用 - 紧凑单行布局 */
    .od-ws-recent { padding: 8px 22px 4px; }
    .od-ws-recent-title {
        font-size: var(--fs-sm); font-weight: 600; color: var(--od-text-muted, #8e8e93); text-transform: uppercase;
        letter-spacing: 0.5px; margin-bottom: 4px;
    }
    .od-ws-recent-list { display: flex; flex-direction: column; gap: 1px; max-height: 100px; overflow-y: auto; }
    .od-ws-recent-item {
        display: flex; align-items: center; gap: 8px; padding: 5px 8px;
        border-radius: 6px; cursor: pointer;
        text-align: left; width: 100%; transition: background 0.12s; font-family: inherit;
        min-width: 0;
    }
    .od-ws-recent-item:hover { background: var(--od-bg-subtle, #f3f4f6); }
    .od-ws-recent-item-icon { color: var(--od-text-muted, #9ca3af); font-size: var(--fs-sm); flex-shrink: 0; }
    .od-ws-recent-item-name {
        font-size: var(--fs-md); font-weight: 500; color: var(--od-text, #1f2937);
        white-space: nowrap; flex-shrink: 0; max-width: 160px;
        overflow: hidden; text-overflow: ellipsis;
    }
    .od-ws-recent-item-path {
        font-size: var(--fs-sm); color: var(--od-text-muted, #9ca3af);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        min-width: 0; flex: 1;
    }
    .od-ws-recent-remove {
        width: 20px; height: 20px; border-radius: 4px; border: none;
        background: transparent; color: var(--od-text-muted, #9ca3af); font-size: var(--fs-xs);
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        flex-shrink: 0; opacity: 0; transition: all 0.12s; padding: 0;
    }
    .od-ws-recent-item:hover .od-ws-recent-remove { opacity: 1; }
    .od-ws-recent-remove:hover { background: rgba(220, 38, 38, 0.12); color: #dc2626; }
    .od-ws-recent-empty { font-size: var(--fs-md); color: var(--od-text-disabled, #9ca3af); padding: 4px 0; }

    /* 分隔线 */
    .od-ws-divider { height: 1px; background: var(--od-border, #f0f0f0); margin: 4px 22px; }

    /* 列视图区域 */
    .od-ws-browser-section { padding: 8px 22px 0; flex: 1; display: flex; flex-direction: column; min-height: 0; }
    .od-ws-browser-title {
        display: flex; align-items: center; justify-content: space-between;
        font-size: var(--fs-sm); font-weight: 600; color: var(--od-text-muted, #8e8e93); text-transform: uppercase;
        letter-spacing: 0.5px; margin-bottom: 8px; flex-shrink: 0;
    }
    .od-ws-show-hidden {
        display: flex; align-items: center; gap: 4px;
        font-size: var(--fs-sm); font-weight: 400; color: var(--od-text-muted, #8e8e93);
        text-transform: none; letter-spacing: 0; cursor: pointer;
        user-select: none;
    }
    .od-ws-show-hidden input[type="checkbox"] {
        margin: 0; cursor: pointer;
    }
    .od-ws-browser-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }

    /* 底部 */
    .od-ws-footer {
        display: flex; align-items: center; justify-content: flex-end;
        padding: 14px 24px 18px; border-top: 1px solid var(--od-border, rgba(0,0,0,0.08)); gap: 12px;
    }
    .od-ws-footer-btns { display: flex; gap: 10px; flex-shrink: 0; }
    .od-ws-btn {
        padding: 7px 16px; border-radius: 8px; border: none;
        font-size: 12.5px; font-weight: 600; cursor: pointer; transition: all 0.15s;
        font-family: inherit;
    }
    .od-ws-btn:active { transform: scale(0.97); }
    .od-ws-btn-cancel { background: var(--od-bg-elevated, #fff); color: var(--od-text, #1d1d1f); border: 1px solid var(--od-border-strong, #e5e5ea); }
    .od-ws-btn-cancel:hover { border-color: #DF4436; color: #DF4436; }
    .od-ws-btn-confirm { background: #DF4436; color: #fff; }
    .od-ws-btn-confirm:hover { background: #E8563F; }
    .od-ws-btn-confirm:disabled { opacity: 0.4; cursor: not-allowed; }

    @keyframes od-ws-fade-in { from { opacity: 0; } to { opacity: 1; } }
    @keyframes od-ws-fade-out { from { opacity: 1; } to { opacity: 0; } }
    @keyframes od-ws-scale-in {
        from { opacity: 0; transform: scale(0.95) translateY(10px); }
        to { opacity: 1; transform: scale(1) translateY(0); }
    }
    @keyframes od-ws-scale-out {
        from { opacity: 1; transform: scale(1) translateY(0); }
        to { opacity: 0; transform: scale(0.95) translateY(10px); }
    }
</style>
<div class="od-ws-picker-panel">
    <div class="od-ws-header">
        <div class="od-ws-header-icon">${renderIcon('fa-folder-open')}</div>
        <div class="od-ws-header-title">${escapeHtml(options.title || t('renderer.workspacePicker.defaultTitle'))}</div>
        <button class="od-ws-close-btn" data-action="close" title="${t('renderer.workspacePicker.close')}" aria-label="${t('renderer.workspacePicker.close')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>
    <div class="od-ws-current">
        <i class="fa-solid fa-folder-open" style="font-size: var(--fs-sm);flex-shrink:0"></i>
        <span style="flex-shrink:0">${t('renderer.workspacePicker.current')}</span>
        <span class="od-ws-current-path" data-action="edit-current" title="${t('renderer.workspacePicker.editPath')}">${currentWorkspace || t('renderer.workspacePicker.unset')}</span>
        <button class="od-ws-pick-btn" data-action="pick-directory" title="${t('renderer.workspacePicker.pickInSystemHint')}">
            <i class="fa-solid fa-folder-tree"></i>${t('renderer.workspacePicker.pickInSystem')}
        </button>
    </div>
    <div class="od-ws-body">
        <div class="od-ws-recent">
            <div class="od-ws-recent-title">${t('renderer.workspacePicker.recent')}</div>
            <div class="od-ws-recent-list" id="od-ws-recent-list">${buildRecentItems()}</div>
        </div>
        <div class="od-ws-divider"></div>
        <div class="od-ws-browser-section">
            <div class="od-ws-browser-title">
                <span>${t('renderer.workspacePicker.browse')}</span>
                <label class="od-ws-show-hidden">
                    <input type="checkbox" id="od-ws-show-hidden-check">
                    ${t('renderer.workspacePicker.showHidden')}
                </label>
            </div>
            <div class="od-ws-browser-wrap" id="od-ws-browser-wrap"></div>
        </div>
    </div>
    <div class="od-ws-footer">
        <div class="od-ws-footer-btns">
            <button class="od-ws-btn od-ws-btn-cancel" data-action="cancel">${t('renderer.workspacePicker.cancel')}</button>
            <button class="od-ws-btn od-ws-btn-confirm" data-action="confirm" disabled>${t('renderer.workspacePicker.confirm')}</button>
        </div>
    </div>
</div>`;
        }

        function updateConfirmBtn() {
            const confirmBtn = overlay.querySelector('[data-action="confirm"]') as HTMLButtonElement;
            if (confirmBtn) {
                confirmBtn.disabled = !currentWorkspace;
            }
        }

        /** 更新当前工作空间显示并让文件浏览器导航到该路径 */
        function syncBrowserToPath(path: string) {
            currentWorkspace = path;
            const pathEl = overlay.querySelector('.od-ws-current-path');
            if (pathEl) pathEl.textContent = path || t('renderer.workspacePicker.unset');
            updateConfirmBtn();
            const homeDir = _getHomeDirFromWorkspace(path);
            dirSelector?.navigateToPath(path, homeDir);
        }

        /** 仅更新当前工作空间显示（不导航浏览器） */
        function updateCurrentPath(path: string) {
            currentWorkspace = path;
            const pathEl = overlay.querySelector('.od-ws-current-path');
            if (pathEl) pathEl.textContent = path || t('renderer.workspacePicker.unset');
            updateConfirmBtn();
        }

        /** 当前工作空间路径就地编辑 */
        function startInlineEditCurrent() {
            const pathEl = overlay.querySelector('.od-ws-current-path') as HTMLElement;
            if (!pathEl) return;
            const originalPath = currentWorkspace || '';

            const input = document.createElement('input');
            input.className = 'od-ws-current-edit';
            input.type = 'text';
            input.value = originalPath;
            input.placeholder = t('renderer.workspacePicker.pathPlaceholder');
            pathEl.replaceWith(input);
            input.focus();
            input.select();

            const restoreSpan = (text: string) => {
                const span = document.createElement('span');
                span.className = 'od-ws-current-path';
                span.dataset.action = 'edit-current';
                span.title = t('renderer.workspacePicker.editPath');
                span.textContent = text || t('renderer.workspacePicker.unset');
                input.replaceWith(span);
                span.addEventListener('click', () => startInlineEditCurrent());
            };

            let finished = false;
            const finish = (save: boolean) => {
                if (finished) return;
                finished = true;
                const newPath = input.value.trim().replace(/\\/g, '/');
                if (save && newPath && newPath !== originalPath) {
                    restoreSpan(newPath);
                    syncBrowserToPath(newPath);
                } else {
                    restoreSpan(originalPath);
                }
            };

            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.isComposing) {
                    e.preventDefault();
                    e.stopPropagation();
                    finish(true);
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    finish(false);
                }
            });
            input.addEventListener('blur', () => finish(true));
        }

        function bindEvents() {
            // 工作空间选择器包含路径编辑/搜索输入框，禁用遮罩关闭，防止误关丢失输入
            bindOverlayDismiss(overlay, () => close(null), undefined, false);
            overlay.querySelector('[data-action="close"]')?.addEventListener('click', () => close(null));
            overlay.querySelector('[data-action="cancel"]')?.addEventListener('click', () => close(null));
            overlay.querySelector('[data-action="confirm"]')?.addEventListener('click', () => {
                if (currentWorkspace) close(currentWorkspace);
            });

            // 当前工作空间路径：点击进入编辑
            overlay.querySelector('[data-action="edit-current"]')?.addEventListener('click', () => {
                startInlineEditCurrent();
            });

            // 系统文件选择按钮
            overlay.querySelector('[data-action="pick-directory"]')?.addEventListener('click', async () => {
                try {
                    const picked = await window.workspaceAPI.pickDirectoryDialog();
                    if (picked) syncBrowserToPath(picked);
                } catch {
                    // 静默处理
                }
            });

            overlay.querySelectorAll('.od-ws-recent-item').forEach((item) => {
                item.addEventListener('click', (e) => {
                    // 点击删除按钮时不触发选择
                    const target = e.target as HTMLElement;
                    if (target.closest('[data-action="remove-recent"]')) return;

                    const dirPath = (item as HTMLElement).dataset.path || '';
                    if (dirPath) syncBrowserToPath(dirPath);
                });
            });

            overlay.querySelectorAll('[data-action="remove-recent"]').forEach((btn) => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const workspacePath = (btn as HTMLElement).dataset.path || '';
                    if (!workspacePath) return;

                    // 从 DOM 中移除该项
                    const item = (btn as HTMLElement).closest('.od-ws-recent-item');
                    if (item) item.remove();

                    // 从内存列表中移除
                    recentWorkspaces = recentWorkspaces.filter((p) => p !== workspacePath);

                    // 如果列表已空，显示空状态
                    if (recentWorkspaces.length === 0) {
                        const list = overlay.querySelector('#od-ws-recent-list');
                        if (list)
                            list.innerHTML = `<div class="od-ws-recent-empty">${t('renderer.workspacePicker.recentEmpty')}</div>`;
                    }

                    // 持久化删除
                    try {
                        await window.workspaceAPI.removeRecentWorkspace(workspacePath);
                    } catch {
                        // 静默处理
                    }
                });
            });
        }

        async function init() {
            try {
                [currentWorkspace, recentWorkspaces] = await Promise.all([
                    options.initialWorkspace ?? window.workspaceAPI.getEffectiveWorkspace(),
                    window.workspaceAPI.getRecentWorkspaces()
                ]);
            } catch {
                currentWorkspace = '';
                recentWorkspaces = [];
            }

            renderOverlay();
            bindEvents();
            document.body.appendChild(overlay);

            // 创建目录选择器组件并挂载
            dirSelector = new FileSelector({
                t,
                listDirectory: async (p, opts) => {
                    // 处理虚拟根目录：Windows 盘符浏览
                    if (p === '{DRIVE_ROOT}') {
                        const drives = await window.workspaceAPI.listDrives();
                        return drives || [];
                    }
                    // {OH_ROOT}（OpenHarmony 家目录 + 应用沙箱）由主进程统一处理，
                    // 通过 getHarmonyBrowseRoots 返回与运行时一致的根目录列表。
                    return window.workspaceAPI.listDirectory(p, opts);
                },
                onSelect: (p) => {
                    if (p) updateCurrentPath(p);
                },
                height: '100%',
                directoryOnly: true,
                renameEntry: (oldPath, newName) => window.workspaceAPI.renameEntry(oldPath, newName),
                createDirectory: (parentPath, dirName) => window.workspaceAPI.createDirectory(parentPath, dirName),
                deleteEntry: (entryPath) => window.workspaceAPI.deleteEntry(entryPath),
                confirmDelete: (name) =>
                    showConfirmModal({
                        icon: 'fa-trash',
                        iconBg: '#FEF2F2',
                        iconColor: '#DC2626',
                        title: t('renderer.workspacePicker.deleteTitle'),
                        message: t('renderer.workspacePicker.deleteMessage', { name }),
                        confirmText: t('renderer.workspacePicker.delete'),
                        cancelText: t('renderer.workspacePicker.cancel'),
                        danger: true
                    }),
                menuContainer: overlay
            });

            // 显示隐藏文件复选框事件
            const showHiddenCheck = overlay.querySelector('#od-ws-show-hidden-check') as HTMLInputElement;
            if (showHiddenCheck) {
                showHiddenCheck.addEventListener('change', () => {
                    dirSelector?.setShowHidden(showHiddenCheck.checked);
                });
            }

            const wrap = overlay.querySelector('#od-ws-browser-wrap') as HTMLElement;
            if (wrap) {
                wrap.appendChild(dirSelector.element);
            }

            const homeDir = _getHomeDirFromWorkspace(currentWorkspace);
            await dirSelector.navigateToPath(currentWorkspace, homeDir);
        }

        init();
    });
}

/**
 * 从工作空间路径推导出合理的起始浏览目录。
 * Windows 平台返回虚拟根目录标记，显示所有盘符。
 * HarmonyOS PC 使用包含用户家目录和应用沙箱的虚拟根；tablet 直接从应用沙箱开始。
 * Unix/macOS 平台返回用户家目录。
 */
function _getHomeDirFromWorkspace(workspace: string): string {
    const systemInfo = window.systemInfo;

    // Windows 平台返回虚拟根目录标记
    if (systemInfo?.isWindows || navigator.platform.toLowerCase().includes('win')) {
        return '{DRIVE_ROOT}';
    }

    // HarmonyOS tablet 不存在 PC 用户家目录，只允许从应用沙箱开始浏览。
    if (systemInfo?.isOpenHarmony) {
        const roots = systemInfo.harmonyRuntime?.browseRoots ?? [];
        return roots.length === 1 ? roots[0].path : '{OH_ROOT}';
    }

    // Unix/macOS 原有逻辑
    if (!workspace) return '/';
    const parts = workspace.replace(/\\/g, '/').split('/');
    // /Users/xxx/... → /Users/xxx  or  /home/xxx/... → /home/xxx
    if (parts.length >= 3 && (parts[1] === 'Users' || parts[1] === 'home')) {
        return parts.slice(0, 3).join('/');
    }
    return parts.slice(0, Math.max(2, Math.ceil(parts.length / 2))).join('/') || '/';
}
