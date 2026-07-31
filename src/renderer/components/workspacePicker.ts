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

import { FileSelector } from './fileSelector.ts';
import { showConfirmModal } from './confirmModal.ts';
import { escapeHtml } from '../../common/utils/escape.js';

declare const window: Window & {
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
    };
};

const ANIM_DURATION_IN = 250;
const ANIM_DURATION_OUT = 180;

interface WorkspacePickerOptions {
    title?: string;
}

/**
 * 工作空间选择器模态弹窗。
 *
 * 展示最近使用的工作空间列表 + macOS NSBrowser 风格的列视图目录浏览器。
 * 返回 Promise<string | null>：用户选择的路径，取消时为 null。
 */
export function showWorkspacePicker(options: WorkspacePickerOptions = {}): Promise<string | null> {
    return new Promise((resolve) => {
        let resolved = false;
        let recentWorkspaces: string[] = [];
        let currentWorkspace = '';
        let selectedBrowserPath: string | null = null;
        let dirSelector: FileSelector | null = null;

        const overlay = document.createElement('div');
        overlay.className = 'od-ws-picker-overlay';

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
            if (document.querySelector('.od-confirm-modal-overlay')) return;

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
                return '<div class="od-ws-recent-empty">暂无最近使用的工作空间</div>';
            }
            return recentWorkspaces
                .map((p) => {
                    const dirName = p.split('/').pop() || p;
                    return `<div class="od-ws-recent-item" data-path="${p}" title="${p}">
                        <i class="fa-solid fa-clock-rotate-left od-ws-recent-item-icon"></i>
                        <span class="od-ws-recent-item-name">${dirName}</span>
                        <span class="od-ws-recent-item-path">${p}</span>
                        <button class="od-ws-recent-remove" data-action="remove-recent" data-path="${p}" title="移除此记录">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                    </div>`;
                })
                .join('');
        }

        function renderOverlay() {
            overlay.innerHTML = `
<style>
    .od-ws-picker-overlay {
        position: fixed; inset: 0; z-index: 99999;
        background: rgba(0,0,0,0.35);
        display: flex; align-items: center; justify-content: center;
        animation: od-ws-fade-in ${ANIM_DURATION_IN}ms ease-out forwards;
    }
    .od-ws-picker-overlay.od-ws-leaving {
        animation: od-ws-fade-out ${ANIM_DURATION_OUT}ms ease-in forwards;
    }
    .od-ws-picker-panel {
        background: var(--od-bg-elevated, #fff); border-radius: 16px;
        box-shadow: 0 24px 80px rgba(0,0,0,0.22), 0 0 1px rgba(0,0,0,0.1);
        width: 720px; max-width: 92vw; height: 72vh; max-height: 680px;
        display: flex; flex-direction: column; overflow: hidden;
	        contain: layout style;
        animation: od-ws-scale-in ${ANIM_DURATION_IN}ms cubic-bezier(0.23, 1, 0.32, 1) forwards;
    }
    .od-ws-picker-overlay.od-ws-leaving .od-ws-picker-panel {
        animation: od-ws-scale-out ${ANIM_DURATION_OUT}ms ease-in forwards;
    }
    .od-ws-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 18px 22px 14px; border-bottom: 1px solid var(--od-border, rgba(0,0,0,0.08));
    }
    .od-ws-header-title {
        font-size: var(--fs-xl); font-weight: 700; color: var(--od-text, #1d1d1f);
        display: flex; align-items: center; gap: 8px;
    }
    .od-ws-close-btn {
        width: 28px; height: 28px; border-radius: 8px; border: none;
        background: transparent; color: var(--od-text-muted, #8e8e93); font-size: var(--fs-lg);
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        transition: all 0.15s;
    }
    .od-ws-close-btn:hover { background: var(--od-bg-subtle, #f5f5f7); color: var(--od-text, #1d1d1f); }
    .od-ws-current {
        padding: 10px 22px; background: var(--od-bg-muted, #f9fafb); border-bottom: 1px solid var(--od-border, rgba(0,0,0,0.08));
        font-size: var(--fs-md); color: var(--od-text-muted, #6b7280); display: flex; align-items: center; gap: 6px;
        min-width: 0;
    }
    .od-ws-current-path {
        color: var(--od-text, #374151); font-weight: 500;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;
    }
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
        display: flex; align-items: center; justify-content: space-between;
        padding: 12px 22px 16px; border-top: 1px solid var(--od-border, rgba(0,0,0,0.08)); gap: 12px;
    }
    .od-ws-selected-path {
        flex: 1; min-width: 0; font-size: var(--fs-md); color: var(--od-text-muted, #6b7280);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .od-ws-footer-btns { display: flex; gap: 8px; flex-shrink: 0; }
    .od-ws-btn {
        padding: 8px 20px; border-radius: 10px; border: none;
        font-size: var(--fs-base); font-weight: 600; cursor: pointer; transition: all 0.15s;
    }
    .od-ws-btn:active { transform: scale(0.97); }
    .od-ws-btn-cancel { background: var(--od-bg-elevated, #fff); color: var(--od-text, #1d1d1f); border: 1.5px solid var(--od-border-strong, #e5e5ea); }
    .od-ws-btn-cancel:hover { background: var(--od-bg-subtle, #f5f5f7); }
    .od-ws-btn-confirm { background: var(--od-accent, #3b82f6); color: #fff; }
    .od-ws-btn-confirm:hover { filter: brightness(0.92); }
    .od-ws-btn-confirm:disabled { opacity: 0.5; cursor: not-allowed; }

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
        <div class="od-ws-header-title">
            <i class="fa-solid fa-briefcase" style="opacity:0.6"></i>
            ${escapeHtml(options.title || '选择工作空间')}
        </div>
        <button class="od-ws-close-btn" data-action="close" title="关闭">
            <i class="fa-solid fa-times"></i>
        </button>
    </div>
    <div class="od-ws-current">
        <i class="fa-solid fa-folder-open" style="font-size: var(--fs-sm);flex-shrink:0"></i>
        <span style="flex-shrink:0">当前：</span>
        <span class="od-ws-current-path">${currentWorkspace || '未设置'}</span>
    </div>
    <div class="od-ws-body">
        <div class="od-ws-recent">
            <div class="od-ws-recent-title">最近使用</div>
            <div class="od-ws-recent-list" id="od-ws-recent-list">${buildRecentItems()}</div>
        </div>
        <div class="od-ws-divider"></div>
        <div class="od-ws-browser-section">
            <div class="od-ws-browser-title">
                <span>浏览目录</span>
                <label class="od-ws-show-hidden">
                    <input type="checkbox" id="od-ws-show-hidden-check">
                    显示隐藏文件
                </label>
            </div>
            <div class="od-ws-browser-wrap" id="od-ws-browser-wrap"></div>
        </div>
    </div>
    <div class="od-ws-footer">
        <div class="od-ws-selected-path" id="od-ws-selected-display">未选择目录</div>
        <div class="od-ws-footer-btns">
            <button class="od-ws-btn od-ws-btn-cancel" data-action="cancel">取消</button>
            <button class="od-ws-btn od-ws-btn-confirm" data-action="confirm" disabled>选择</button>
        </div>
    </div>
</div>`;
        }

        function updateSelectedDisplay() {
            const display = overlay.querySelector('#od-ws-selected-display') as HTMLElement;
            const confirmBtn = overlay.querySelector('[data-action="confirm"]') as HTMLButtonElement;
            if (display) {
                display.textContent = selectedBrowserPath || '未选择目录';
            }
            if (confirmBtn) {
                confirmBtn.disabled = !selectedBrowserPath;
            }
        }

        function bindEvents() {
            overlay.addEventListener('click', (e) => {
                if ((e.target as HTMLElement).classList.contains('od-ws-picker-overlay')) {
                    close(null);
                }
            });
            overlay.querySelector('[data-action="close"]')?.addEventListener('click', () => close(null));
            overlay.querySelector('[data-action="cancel"]')?.addEventListener('click', () => close(null));
            overlay.querySelector('[data-action="confirm"]')?.addEventListener('click', () => {
                if (selectedBrowserPath) close(selectedBrowserPath);
            });

            overlay.querySelectorAll('.od-ws-recent-item').forEach((item) => {
                item.addEventListener('click', (e) => {
                    // 点击删除按钮时不触发选择
                    const target = e.target as HTMLElement;
                    if (target.closest('[data-action="remove-recent"]')) return;

                    const dirPath = (item as HTMLElement).dataset.path || '';
                    if (dirPath) close(dirPath);
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
                        if (list) list.innerHTML = '<div class="od-ws-recent-empty">暂无最近使用的工作空间</div>';
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
                    window.workspaceAPI.getEffectiveWorkspace(),
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
                listDirectory: async (p, opts) => {
                    // 处理虚拟根目录：Windows 盘符浏览
                    if (p === '{DRIVE_ROOT}') {
                        const drives = await window.workspaceAPI.listDrives();
                        return drives || [];
                    }
                    // 处理虚拟根目录：OpenHarmony 家目录 + 应用沙箱
                    if (p === '{OH_ROOT}') {
                        return [
                            {
                                name: '家目录',
                                path: '/storage/Users/currentUser',
                                isDirectory: true
                            },
                            {
                                name: '应用沙箱',
                                path: '/data/storage/el2/base/files',
                                isDirectory: true
                            }
                        ];
                    }
                    return window.workspaceAPI.listDirectory(p, opts);
                },
                onSelect: (p) => {
                    selectedBrowserPath = p;
                    updateSelectedDisplay();
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
                        title: '删除确认',
                        message: `确定要删除 <b>${name}</b> 吗？此操作无法撤销。`,
                        confirmText: '删除',
                        cancelText: '取消',
                        danger: true
                    })
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
            await dirSelector.setRoot(homeDir);
        }

        init();
    });
}

/**
 * 从工作空间路径推导出合理的起始浏览目录。
 * Windows 平台返回虚拟根目录标记，显示所有盘符。
 * OpenHarmony 平台使用系统暴露的家目录路径（USER_DATA_PATH）。
 * Unix/macOS 平台返回用户家目录。
 */
function _getHomeDirFromWorkspace(workspace: string): string {
    const systemInfo = (window as any).systemInfo;

    // Windows 平台返回虚拟根目录标记
    if (systemInfo?.isWindows || navigator.platform.toLowerCase().includes('win')) {
        return '{DRIVE_ROOT}';
    }

    // OpenHarmony 平台返回虚拟根目录标记（家目录 + 应用沙箱）
    if (systemInfo?.isOpenHarmony) {
        return '{OH_ROOT}';
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
