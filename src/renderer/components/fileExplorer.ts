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
 * 工作空间文件浏览器（FileExplorer）。
 *
 * 纯 DOM 管理类（非 Custom Element），由宿主组件提供一个容器 HTMLElement，
 * FileExplorer 负责往容器内渲染树视图 / 网格视图 / 文件预览。
 *
 * 特性：
 *   - 树状动态展开，每层异步加载（listDirectory）
 *   - 网格（grid）视图 + 面包屑导航
 *   - macOS 风格的 segmented control 切换
 *   - 点击文件弹出文本预览（>50 KB / 二进制 → 拒绝提示）
 */

import { showConfirmModal } from './confirmModal';
import { marked } from 'marked';

// ============================================================================
// Types
// ============================================================================

export interface FSEntry {
    name: string;
    path: string;
    isDirectory: boolean;
    isSymbolicLink?: boolean;
    size: number;
    modifiedAt: number | null;
}

export interface PreviewPayload {
    tooLarge: boolean;
    size: number;
    limit: number;
    content: string;
    binary: boolean;
}

type ChildrenCache = FSEntry[] | 'loading' | { error: string };
type ViewMode = 'tree' | 'grid';

const PREVIEW_MAX_BYTES = 50 * 1024;

// ============================================================================
// Utilities
// ============================================================================

function escapeHtml(str: unknown): string {
    if (str === undefined || str === null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function cssEscape(s: string): string {
    const win = globalThis as unknown as { CSS?: { escape?: (v: string) => string } };
    if (win.CSS && typeof win.CSS.escape === 'function') {
        return win.CSS.escape(s);
    }
    return String(s).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

export function formatBytes(n: number): string {
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 1024) return `${n} B`;
    const kb = n / 1024;
    if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
    const gb = mb / 1024;
    return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
}

function pickFileIcon(entry: FSEntry): string {
    if (entry.isDirectory) return 'fa-folder';
    const name = entry.name.toLowerCase();
    const ext = name.includes('.') ? name.split('.').pop() : '';
    switch (ext) {
        case 'md':
        case 'markdown':
        case 'txt':
        case 'log':
            return 'fa-file-lines';
        case 'json':
        case 'yaml':
        case 'yml':
        case 'toml':
        case 'xml':
        case 'js':
        case 'mjs':
        case 'cjs':
        case 'jsx':
        case 'ts':
        case 'tsx':
        case 'py':
        case 'rb':
        case 'go':
        case 'rs':
        case 'java':
        case 'kt':
        case 'swift':
        case 'c':
        case 'h':
        case 'cpp':
        case 'cc':
        case 'cs':
        case 'sh':
        case 'bash':
        case 'zsh':
        case 'ps1':
        case 'sql':
        case 'html':
        case 'htm':
        case 'css':
        case 'scss':
        case 'less':
            return 'fa-file-code';
        case 'png':
        case 'jpg':
        case 'jpeg':
        case 'gif':
        case 'webp':
        case 'svg':
        case 'ico':
        case 'bmp':
            return 'fa-file-image';
        case 'pdf':
            return 'fa-file-pdf';
        case 'zip':
        case 'tar':
        case 'gz':
        case 'rar':
        case '7z':
            return 'fa-file-zipper';
        case 'mp3':
        case 'wav':
        case 'flac':
        case 'ogg':
            return 'fa-file-audio';
        case 'mp4':
        case 'mov':
        case 'mkv':
        case 'webm':
        case 'avi':
            return 'fa-file-video';
        default:
            return 'fa-file';
    }
}

// ============================================================================
// CSS (returned as string, injected by host)
// ============================================================================

export function getFileExplorerCSS(): string {
    return `
        .tab-content[data-tab="workspace"] {
            display: flex;
            flex-direction: column;
            padding: 10px;
            gap: 10px;
            box-sizing: border-box;
            overflow: hidden;
        }

        .ws-browser {
            background: white;
            border: 1px solid #eef0f3;
            border-radius: 10px;
            overflow: hidden;
            flex: 1;
            min-height: 120px;
            display: flex;
            flex-direction: column;
        }

        .ws-browser-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            padding: 7px 10px;
            background: #f8fafc;
            border-bottom: 1px solid #eef0f3;
            flex-shrink: 0;
        }
        .ws-path {
            display: flex;
            align-items: center;
            gap: 6px;
            min-width: 0;
            flex: 1;
            font-size: 12px;
            color: #334155;
            font-weight: 500;
        }
        .ws-path-icon {
            color: #64748b;
            font-size: 11px;
            flex-shrink: 0;
        }
        .ws-path-text {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .ws-view-switch {
            display: inline-flex;
            background: #f1f3f6;
            border-radius: 7px;
            padding: 2px;
            gap: 2px;
            flex-shrink: 0;
        }
        .ws-view-btn {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 2px 8px;
            height: 24px;
            background: transparent;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            color: #6b7280;
            font-size: 11px;
            transition: background 0.15s, color 0.15s, box-shadow 0.15s;
            white-space: nowrap;
        }
        .ws-view-btn i {
            font-size: 10px;
        }
        .ws-view-btn:hover {
            color: #374151;
        }
        .ws-view-btn.ws-view-active {
            background: white;
            color: #1f2937;
            box-shadow: 0 1px 1px rgba(15, 23, 42, 0.08), 0 0 0 0.5px rgba(15, 23, 42, 0.05);
        }

        .ws-refresh-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 24px;
            height: 24px;
            background: transparent;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            color: #9ca3af;
            font-size: 11px;
            transition: color 0.15s, background 0.15s;
            flex-shrink: 0;
        }
        .ws-refresh-btn:hover {
            color: #374151;
            background: #f1f3f6;
        }

        .ws-browser-body {
            flex: 1;
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }

        /* Tree view */
        .ws-tree { flex: 1; overflow: auto; padding: 4px 0; font-size: 12px; }
        .ws-tree-row {
            display: flex; align-items: center; gap: 4px;
            padding: 3px 10px 3px 8px; cursor: pointer; user-select: none;
            border-radius: 4px; margin: 0 4px; color: #1f2937; line-height: 1.5;
        }
        .ws-tree-row:hover { background: #f3f4f6; }
        .ws-tree-row.ws-file-selected { background: #e0edff; }
        .ws-tree-caret { width: 10px; color: #9ca3af; font-size: 9px; flex-shrink: 0; text-align: center; }
        .ws-tree-icon { flex-shrink: 0; font-size: 12px; }
        .ws-tree-icon-dir { color: #f59e0b; }
        .ws-tree-icon-file { color: #94a3b8; }
        .ws-tree-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .ws-tree-size { font-size: 10px; color: #9ca3af; flex-shrink: 0; font-variant-numeric: tabular-nums; }
        .ws-tree-loading, .ws-tree-empty, .ws-tree-error {
            display: flex; align-items: center; gap: 6px; padding: 4px 10px; font-size: 11px; color: #9ca3af;
        }
        .ws-tree-error { color: #b91c1c; }

        /* Grid view */
        .ws-grid { flex: 1; display: flex; flex-direction: column; min-height: 0; }
        .ws-crumb {
            display: flex; flex-wrap: wrap; align-items: center; gap: 2px;
            padding: 6px 10px; border-bottom: 1px solid #eef0f3; font-size: 11px;
            color: #6b7280; background: #fafbfc;
        }
        .ws-crumb-seg {
            background: transparent; border: none; padding: 2px 6px;
            border-radius: 4px; cursor: pointer; color: #6b7280; font-size: 11px;
        }
        .ws-crumb-seg:hover { background: #eef2f6; color: #1f2937; }
        .ws-crumb-seg-current { color: #1f2937; font-weight: 500; }
        .ws-crumb-sep { font-size: 9px; color: #cbd5e1; }

        .ws-grid-body { flex: 1; overflow: auto; padding: 8px; }
        .ws-grid-items { display: grid; grid-template-columns: repeat(auto-fill, minmax(80px, 1fr)); gap: 6px; }
        .ws-grid-item {
            display: flex; flex-direction: column; align-items: center;
            padding: 8px 4px 6px; border-radius: 8px; cursor: pointer;
            text-align: center; gap: 4px; user-select: none; transition: background 0.15s;
        }
        .ws-grid-item:hover { background: #f3f4f6; }
        .ws-grid-item.ws-file-selected { background: #e0edff; }
        .ws-grid-icon { font-size: 28px; line-height: 1; }
        .ws-grid-icon-dir { color: #f59e0b; }
        .ws-grid-icon-file { color: #94a3b8; }
        .ws-grid-icon-up { color: #64748b; }
        .ws-grid-name {
            font-size: 11px; color: #1f2937; width: 100%;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.3;
        }
        .ws-grid-size { font-size: 9px; color: #9ca3af; font-variant-numeric: tabular-nums; }
        .ws-grid-loading, .ws-grid-error, .ws-grid-empty {
            display: flex; align-items: center; justify-content: center;
            gap: 6px; padding: 20px; font-size: 11px; color: #9ca3af; grid-column: 1 / -1;
        }
        .ws-grid-error { color: #b91c1c; }

        /* Preview */
        .ws-preview {
            background: white; border: 1px solid #eef0f3; border-radius: 10px;
            overflow: hidden; flex: 2; min-height: 80px;
            display: flex; flex-direction: column;
        }
        .ws-preview:empty, .ws-preview.ws-preview--collapsed {
            flex: 0 0 auto; min-height: 44px;
        }
        .ws-preview-empty {
            display: flex; align-items: center; justify-content: center;
            gap: 6px; padding: 10px; font-size: 11px; color: #9ca3af;
        }
        .ws-preview-header {
            display: flex; align-items: center; gap: 6px;
            padding: 6px 10px; background: #f8fafc; border-bottom: 1px solid #eef0f3;
            font-size: 12px; color: #334155; flex-shrink: 0;
        }
        .ws-preview-header > i { color: #64748b; font-size: 11px; }
        .ws-preview-name {
            flex: 1; min-width: 0; overflow: hidden;
            text-overflow: ellipsis; white-space: nowrap; font-weight: 500;
        }
        .ws-preview-size { font-size: 10px; color: #9ca3af; font-variant-numeric: tabular-nums; flex-shrink: 0; }
        .ws-preview-close {
            width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center;
            background: transparent; border: none; border-radius: 4px; color: #6b7280; cursor: pointer; font-size: 11px;
        }
        .ws-preview-close:hover { background: #eef2f6; color: #1f2937; }
        .ws-preview-body { flex: 1; overflow: auto; background: #fbfcfd; min-height: 60px; }
        .ws-preview-pre {
            margin: 0; padding: 10px 12px;
            font-family: 'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace;
            font-size: 11px; line-height: 1.55; color: #1f2937; white-space: pre; min-width: 0;
        }
        .ws-preview-info {
            display: flex; align-items: flex-start; gap: 8px;
            padding: 12px 14px; font-size: 12px; color: #475569;
        }
        .ws-preview-info > i { font-size: 14px; color: #64748b; margin-top: 2px; }
        .ws-preview-hint { font-size: 11px; color: #94a3b8; margin-top: 2px; }

        .ws-preview-md-host {
            flex: 1; overflow: auto; min-height: 60px;
        }

        /* Fullscreen toggle button (shared style for browser & preview) */
        .ws-fullscreen-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 22px; height: 22px;
            background: transparent; border: none; border-radius: 4px;
            cursor: pointer; color: #9ca3af; font-size: 10px;
            transition: color 0.15s, background 0.15s;
            flex-shrink: 0;
        }
        .ws-fullscreen-btn:hover { color: #374151; background: #f1f3f6; }

        /* When browser is fullscreen, hide preview */
        .ws-browser--fullscreen { flex: 1 !important; }
        .ws-browser--fullscreen ~ .ws-preview { display: none !important; }

        /* When preview is fullscreen, hide browser */
        .ws-preview--fullscreen { flex: 1 !important; min-height: 0 !important; }
        .ws-browser--hidden { display: none !important; }
    `;
}

function isMarkdownFile(filePath: string): boolean {
    const ext = filePath.split('.').pop()?.toLowerCase();
    return ext === 'md' || ext === 'markdown';
}

const MARKDOWN_PREVIEW_CSS = `
    :host {
        display: block;
        height: 100%;
        overflow: auto;
        background: #fbfcfd;
    }
    .markdown-body {
        font-family: 'PingFang SC', 'Microsoft YaHei', -apple-system, sans-serif;
        font-size: 12px;
        line-height: 1.7;
        color: #1f2937;
        padding: 12px 14px;
        word-wrap: break-word;
    }
    .markdown-body h1 { font-size: 1.4em; margin: 0.8em 0 0.4em; font-weight: 600; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.3em; }
    .markdown-body h2 { font-size: 1.25em; margin: 0.7em 0 0.3em; font-weight: 600; border-bottom: 1px solid #f3f4f6; padding-bottom: 0.2em; }
    .markdown-body h3 { font-size: 1.1em; margin: 0.6em 0 0.3em; font-weight: 600; }
    .markdown-body h4, .markdown-body h5, .markdown-body h6 { font-size: 1em; margin: 0.5em 0 0.2em; font-weight: 600; }
    .markdown-body p { margin: 0 0 0.5em; }
    .markdown-body ul, .markdown-body ol { padding-left: 1.6em; margin: 0.3em 0 0.5em; }
    .markdown-body li { margin-bottom: 0.15em; }
    .markdown-body blockquote {
        margin: 0.5em 0; padding: 0.3em 0.8em;
        border-left: 3px solid #d1d5db; color: #6b7280; background: #f9fafb;
    }
    .markdown-body code {
        font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace;
        font-size: 0.9em; padding: 0.15em 0.35em;
        background: #f1f5f9; border-radius: 3px; color: #334155;
    }
    .markdown-body pre {
        margin: 0.5em 0; padding: 0.7em 0.9em;
        background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px;
        overflow-x: auto; font-size: 11px; line-height: 1.5;
    }
    .markdown-body pre code { padding: 0; background: none; border-radius: 0; font-size: inherit; }
    .markdown-body table {
        font-size: 11px; margin: 0.5em 0; width: 100%;
        border-collapse: collapse; border: 1px solid #e2e8f0; border-radius: 6px;
    }
    .markdown-body th { background: #f8fafc; font-weight: 600; text-align: left; }
    .markdown-body th, .markdown-body td { padding: 0.4em 0.7em; border-bottom: 1px solid #f1f5f9; }
    .markdown-body hr { border: none; border-top: 1px solid #e5e7eb; margin: 0.8em 0; }
    .markdown-body a { color: #2563eb; text-decoration: none; }
    .markdown-body a:hover { text-decoration: underline; }
    .markdown-body img { max-width: 100%; border-radius: 4px; }
    .markdown-body strong { font-weight: 600; }
`;

// ============================================================================
// FileExplorer
// ============================================================================

/**
 * 工作空间文件浏览器。
 *
 * 不继承 HTMLElement — 而是由宿主组件持有实例并调用 `mount(container)` 将 UI
 * 渲染到指定容器节点中。容器节点通常位于宿主组件的 shadow root 内部。
 */
export class FileExplorer {
    private _container: HTMLElement | null = null;
    /** 用于在 shadow root 中执行 querySelector 等 DOM 操作 */
    private _rootNode: ParentNode | null = null;

    private _workspaceRoot: string | null = null;
    private _workspaceRequested = false;
    private _workspaceError: string | null = null;
    private _viewMode: ViewMode = 'tree';
    private _expandedPaths: Set<string> = new Set();
    private _childrenCache: Map<string, ChildrenCache> = new Map();
    private _gridPath: string | null = null;
    private _selectedFile: string | null = null;
    private _previewState: { status: 'idle' | 'loading' | 'error'; error?: string; data?: PreviewPayload } = {
        status: 'idle'
    };
    private _browserFullscreen = false;
    private _previewFullscreen = false;

    /**
     * 将文件浏览器渲染到指定容器中。
     * @param container  workspace tab 的面板容器 element
     * @param rootNode   shadow root（或 document），用于全局 querySelector
     */
    mount(container: HTMLElement, rootNode?: ParentNode): void {
        this._container = container;
        this._rootNode = rootNode ?? container;
        void this._ensureWorkspaceLoaded();
    }

    /**
     * 软刷新：保留当前展开/选中状态，仅重新加载已缓存目录的内容。
     * 适用于文件编辑/写入后的增量更新。
     */
    softRefresh(): void {
        if (!this._container || !this._workspaceRoot) return;
        const dirs = [...this._childrenCache.keys()];
        for (const dir of dirs) {
            this._childrenCache.delete(dir);
        }
        for (const dir of dirs) {
            void this._loadChildren(dir);
        }
    }

    /**
     * 重置所有状态并重新加载工作空间。
     * 切换任务 / 切换工作空间时调用。
     */
    refresh(): void {
        this._workspaceRequested = false;
        this._workspaceRoot = null;
        this._workspaceError = null;
        this._expandedPaths.clear();
        this._childrenCache.clear();
        this._gridPath = null;
        this._selectedFile = null;
        this._previewState = { status: 'idle' };
        if (this._container) {
            void this._ensureWorkspaceLoaded();
        }
    }

    // ----- workspace loading -----

    private async _ensureWorkspaceLoaded(): Promise<void> {
        if (this._workspaceRequested) return;
        this._workspaceRequested = true;
        try {
            const api = window.workspaceAPI;
            if (!api || typeof api.getEffectiveWorkspace !== 'function') {
                this._workspaceError = '当前环境未提供 workspaceAPI';
                this._renderPanel();
                return;
            }
            const root = await api.getEffectiveWorkspace();
            if (!root) {
                this._workspaceError = '未能获取工作空间路径';
                this._renderPanel();
                return;
            }
            this._workspaceRoot = root.replace(/\\/g, '/');
            this._gridPath = this._workspaceRoot;
            this._expandedPaths.add(this._workspaceRoot);
            this._renderPanel();
            await this._loadChildren(this._workspaceRoot);
        } catch (err) {
            this._workspaceError = err instanceof Error ? err.message : String(err);
            this._renderPanel();
        }
    }

    private async _loadChildren(dirPath: string): Promise<void> {
        const cached = this._childrenCache.get(dirPath);
        if (cached && cached !== 'loading' && !(cached as { error?: string }).error) return;
        if (cached === 'loading') return;
        this._childrenCache.set(dirPath, 'loading');
        this._rerenderDirContent(dirPath);
        try {
            const api = window.fsAPI;
            if (!api || typeof api.listDirectory !== 'function') {
                throw new Error('当前环境未提供 fsAPI.listDirectory');
            }
            const entries = await api.listDirectory(dirPath);
            this._childrenCache.set(dirPath, entries);
        } catch (err) {
            this._childrenCache.set(dirPath, { error: err instanceof Error ? err.message : String(err) });
        }
        this._rerenderDirContent(dirPath);
    }

    // ----- incremental re-render helpers -----

    private _rerenderDirContent(dirPath: string): void {
        const rn = this._rootNode;
        if (!rn) return;
        if (this._viewMode === 'tree') {
            const container = rn.querySelector<HTMLElement>(`.ws-tree-children[data-dir="${cssEscape(dirPath)}"]`);
            if (container) {
                container.innerHTML = this._renderTreeChildrenHtml(dirPath, this._depthOf(dirPath));
            }
        } else if (this._viewMode === 'grid' && this._gridPath === dirPath) {
            const gridRoot = rn.querySelector<HTMLElement>('.ws-grid-body');
            if (gridRoot) {
                gridRoot.innerHTML = this._renderGridBodyHtml();
            }
        }
    }

    private _rerenderTree(): void {
        const rn = this._rootNode;
        if (!rn || !this._workspaceRoot) return;
        const container = rn.querySelector<HTMLElement>(
            `.ws-tree > .ws-tree-children[data-dir="${cssEscape(this._workspaceRoot)}"]`
        );
        if (!container) return;
        container.innerHTML = this._renderTreeChildrenHtml(this._workspaceRoot, 0);
    }

    private _depthOf(dirPath: string): number {
        if (!this._workspaceRoot) return 0;
        if (dirPath === this._workspaceRoot) return 0;
        const rel = dirPath.slice(this._workspaceRoot.length).replace(/^\/+/, '');
        if (!rel) return 0;
        return rel.split('/').length;
    }

    // ----- user actions -----

    private _setViewMode(mode: ViewMode): void {
        if (this._viewMode === mode) return;
        this._viewMode = mode;
        this._renderPanel();
        if (mode === 'grid' && this._gridPath) {
            void this._loadChildren(this._gridPath);
        }
    }

    private _toggleTreeNode(dirPath: string): void {
        if (this._expandedPaths.has(dirPath)) {
            this._expandedPaths.delete(dirPath);
        } else {
            this._expandedPaths.add(dirPath);
            const cached = this._childrenCache.get(dirPath);
            if (!cached || (cached as { error?: string }).error) {
                void this._loadChildren(dirPath);
            }
        }
        this._rerenderTree();
    }

    private _enterGridDir(dirPath: string): void {
        this._gridPath = dirPath;
        this._renderPanel();
        void this._loadChildren(dirPath);
    }

    /**
     * 选中并预览指定文件。
     * 可由外部调用（如工具卡片中的"查看文件"按钮）。
     */
    selectFile(filePath: string): void {
        this._selectedFile = filePath;
        this._previewState = { status: 'loading' };
        this._renderPreview();
        const rn = this._rootNode;
        if (rn) {
            rn.querySelectorAll<HTMLElement>('.ws-file-selected').forEach((el) => {
                el.classList.remove('ws-file-selected');
            });
            rn.querySelectorAll<HTMLElement>(`[data-file="${cssEscape(filePath)}"]`).forEach((el) => {
                el.classList.add('ws-file-selected');
            });
        }
        void this._loadPreview(filePath);
    }

    private async _loadPreview(filePath: string): Promise<void> {
        try {
            const api = window.fsAPI;
            if (!api || typeof api.readTextFile !== 'function') {
                throw new Error('当前环境未提供 fsAPI.readTextFile');
            }
            const data = await api.readTextFile(filePath, PREVIEW_MAX_BYTES);
            if (this._selectedFile !== filePath) return;
            this._previewState = { status: 'idle', data };
        } catch (err) {
            if (this._selectedFile !== filePath) return;
            this._previewState = { status: 'error', error: err instanceof Error ? err.message : String(err) };
        }
        this._renderPreview();
    }

    // ----- context menu -----

    private _ctxMenuEl: HTMLElement | null = null;
    private _ctxDismissHandler: ((ev: MouseEvent) => void) | null = null;

    private _showContextMenu(ev: MouseEvent, filePath: string, isDirectory: boolean): void {
        ev.preventDefault();
        ev.stopPropagation();
        this._dismissContextMenu();

        const menu = document.createElement('div');
        Object.assign(menu.style, {
            position: 'fixed',
            zIndex: '9999',
            minWidth: '180px',
            padding: '4px',
            borderRadius: '10px',
            background: 'rgba(255, 255, 255, 0.88)',
            backdropFilter: 'blur(40px) saturate(1.8)',
            WebkitBackdropFilter: 'blur(40px) saturate(1.8)',
            border: '0.5px solid rgba(0, 0, 0, 0.08)',
            boxShadow:
                '0 12px 40px -8px rgba(0,0,0,0.15), 0 0 0 0.5px rgba(0,0,0,0.04), inset 0 0.5px 0 rgba(255,255,255,0.5)',
            animation: 'ws-ctx-appear 0.12s ease-out',
            fontFamily: 'system-ui, -apple-system, sans-serif'
        });

        const items: { icon: string; label: string; action: string; danger?: boolean }[] = [];
        if (!isDirectory) {
            items.push({ icon: 'fa-eye', label: '预览', action: 'preview' });
        }
        items.push({ icon: 'fa-arrow-up-right-from-square', label: '用默认应用打开', action: 'open-default' });
        items.push({ icon: 'fa-folder-open', label: '在文件夹中显示', action: 'reveal' });
        items.push({ icon: 'fa-link', label: '复制路径', action: 'copy-path' });
        items.push({ icon: 'fa-trash-can', label: '删除', action: 'delete', danger: true });

        const btnStyle = `
            display:flex; align-items:center; gap:8px; width:100%;
            padding:6px 10px; border:none; border-radius:6px;
            background:transparent; font-size:12px; color:#1f2937;
            cursor:pointer; text-align:left; transition:background 0.1s;
        `.trim();
        const iconStyle = 'width:16px; text-align:center; font-size:12px; color:#6b7280; flex-shrink:0;';

        const dangerBtnStyle = btnStyle.replace('color:#1f2937', 'color:#dc2626');
        const dangerIconStyle = iconStyle.replace('color:#6b7280', 'color:#dc2626');

        menu.innerHTML = items
            .map((it, i) => {
                const needSep = (i > 0 && it.action === 'copy-path') || it.action === 'delete';
                const sep = needSep
                    ? '<div style="height:1px; margin:3px 8px; background:rgba(0,0,0,0.06);"></div>'
                    : '';
                const bStyle = it.danger ? dangerBtnStyle : btnStyle;
                const iStyle = it.danger ? dangerIconStyle : iconStyle;
                return (
                    `${sep}<button data-ctx-action="${it.action}" data-danger="${it.danger ? '1' : ''}" style="${bStyle}">` +
                    `<i class="fas ${it.icon}" style="${iStyle}"></i><span>${it.label}</span></button>`
                );
            })
            .join('');

        menu.style.left = `${ev.clientX}px`;
        menu.style.top = `${ev.clientY}px`;
        document.body.appendChild(menu);

        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            menu.style.left = `${window.innerWidth - rect.width - 8}px`;
        }
        if (rect.bottom > window.innerHeight) {
            menu.style.top = `${window.innerHeight - rect.height - 8}px`;
        }

        this._ctxMenuEl = menu;

        menu.querySelectorAll<HTMLElement>('[data-ctx-action]').forEach((btn) => {
            const isDanger = btn.dataset.danger === '1';
            btn.addEventListener('mouseenter', () => {
                btn.style.background = isDanger ? '#fef2f2' : '#3b82f6';
                btn.style.color = isDanger ? '#b91c1c' : 'white';
                const icon = btn.querySelector('i');
                if (icon) (icon as HTMLElement).style.color = isDanger ? '#b91c1c' : 'white';
            });
            btn.addEventListener('mouseleave', () => {
                btn.style.background = 'transparent';
                btn.style.color = isDanger ? '#dc2626' : '#1f2937';
                const icon = btn.querySelector('i');
                if (icon) (icon as HTMLElement).style.color = isDanger ? '#dc2626' : '#6b7280';
            });
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = btn.dataset.ctxAction;
                this._dismissContextMenu();
                switch (action) {
                    case 'preview':
                        this.selectFile(filePath);
                        break;
                    case 'open-default':
                        window.fsAPI?.openPath?.(filePath);
                        break;
                    case 'reveal': {
                        const parentDir = isDirectory ? filePath : this._parentOf(filePath);
                        window.fsAPI?.openPath?.(parentDir);
                        break;
                    }
                    case 'copy-path':
                        navigator.clipboard.writeText(filePath).catch(() => {});
                        break;
                    case 'delete':
                        this._deleteItem(filePath, isDirectory);
                        break;
                }
            });
        });

        this._ctxDismissHandler = () => this._dismissContextMenu();
        setTimeout(() => {
            document.addEventListener('click', this._ctxDismissHandler!, { once: true });
            document.addEventListener('contextmenu', this._ctxDismissHandler!, { once: true });
        }, 0);
    }

    private _dismissContextMenu(): void {
        if (this._ctxMenuEl) {
            this._ctxMenuEl.remove();
            this._ctxMenuEl = null;
        }
        if (this._ctxDismissHandler) {
            document.removeEventListener('click', this._ctxDismissHandler);
            document.removeEventListener('contextmenu', this._ctxDismissHandler);
            this._ctxDismissHandler = null;
        }
    }

    private async _deleteItem(filePath: string, isDirectory: boolean): Promise<void> {
        const name = filePath.split('/').pop() || filePath;
        const typeLabel = isDirectory ? '文件夹' : '文件';

        const confirmed = await showConfirmModal({
            icon: 'fa-trash-can',
            iconBg: '#FEF2F2',
            iconColor: '#DC2626',
            title: `删除${typeLabel}`,
            message: `确定要将${typeLabel}「<b>${escapeHtml(name)}</b>」移动到回收站吗？此操作可从回收站恢复。`,
            confirmText: '删除',
            cancelText: '取消',
            danger: true
        });
        if (!confirmed) return;

        try {
            const api = (window as any).fsAPI;
            if (!api || typeof api.trashItem !== 'function') {
                throw new Error('当前环境不支持删除操作');
            }
            await api.trashItem(filePath);
            if (this._selectedFile === filePath) {
                this._selectedFile = null;
                this._previewState = { status: 'idle' };
                this._renderPreview();
            }
            this.softRefresh();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            window.alert(`删除失败: ${msg}`);
        }
    }

    // ----- event delegation -----

    private _handleBrowserClick(ev: MouseEvent): void {
        const target = ev.target as HTMLElement | null;
        if (!target) return;
        const row = target.closest<HTMLElement>('[data-action]');
        if (!row) return;
        const action = row.dataset.action;
        const p = row.dataset.path;
        if (!p) return;
        switch (action) {
            case 'tree-toggle':
            case 'tree-dir':
                this._toggleTreeNode(p);
                break;
            case 'tree-file':
                this.selectFile(p);
                break;
            case 'grid-dir':
                this._enterGridDir(p);
                break;
            case 'grid-file':
                this.selectFile(p);
                break;
            case 'grid-up':
            case 'grid-crumb':
                this._enterGridDir(p);
                break;
        }
    }

    // ----- full panel render -----

    private _renderPanel(): void {
        const panel = this._container;
        if (!panel) return;

        if (this._workspaceError) {
            panel.innerHTML = `
            <div class="placeholder-content">
                <i class="fas fa-folder-open placeholder-icon"></i>
                <p>无法加载工作空间</p>
                <p class="placeholder-hint">${escapeHtml(this._workspaceError)}</p>
            </div>`;
            return;
        }
        if (!this._workspaceRoot) {
            panel.innerHTML = `
            <div class="placeholder-content">
                <i class="fas fa-folder-open placeholder-icon"></i>
                <p>正在加载工作空间…</p>
            </div>`;
            return;
        }

        const rootName = this._workspaceRoot.split('/').filter(Boolean).pop() || this._workspaceRoot;

        panel.innerHTML = `
        <div class="ws-browser${this._browserFullscreen ? ' ws-browser--fullscreen' : ''}${this._previewFullscreen ? ' ws-browser--hidden' : ''}">
            <div class="ws-browser-header">
                <div class="ws-path" title="${escapeHtml(this._workspaceRoot)}">
                    <i class="fas fa-folder-tree ws-path-icon"></i>
                    <span class="ws-path-text">${escapeHtml(rootName)}</span>
                </div>
                <div style="display:flex;align-items:center;gap:4px;">
                    <button class="ws-refresh-btn" title="刷新" data-action="refresh">
                        <i class="fas fa-arrows-rotate"></i>
                    </button>
                    <button class="ws-fullscreen-btn" title="全屏文件列表" data-action="browser-fullscreen">
                        <i class="fas ${this._browserFullscreen ? 'fa-compress' : 'fa-expand'}"></i>
                    </button>
                    <div class="ws-view-switch" role="tablist" aria-label="视图模式">
                        <button class="ws-view-btn ${this._viewMode === 'tree' ? 'ws-view-active' : ''}"
                            data-view="tree" title="树状视图">
                            <i class="fas fa-list"></i>
                            <span>树状</span>
                        </button>
                        <button class="ws-view-btn ${this._viewMode === 'grid' ? 'ws-view-active' : ''}"
                            data-view="grid" title="图标视图">
                            <i class="fas fa-grip"></i>
                            <span>图标</span>
                        </button>
                    </div>
                </div>
            </div>
            <div class="ws-browser-body">
                ${this._viewMode === 'tree' ? this._renderTreeContainerHtml() : this._renderGridContainerHtml()}
            </div>
        </div>
        <div class="ws-preview${this._selectedFile ? '' : ' ws-preview--collapsed'}${this._previewFullscreen ? ' ws-preview--fullscreen' : ''}" data-preview-root>
            ${this._renderPreviewHtml()}
        </div>`;

        // Bind events
        panel.querySelectorAll<HTMLButtonElement>('.ws-view-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const v = btn.dataset.view as ViewMode | undefined;
                if (v === 'tree' || v === 'grid') this._setViewMode(v);
            });
        });
        const refreshBtn = panel.querySelector<HTMLButtonElement>('.ws-refresh-btn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => {
                const icon = refreshBtn.querySelector('i');
                if (icon) {
                    icon.style.transition = 'transform 0.5s ease';
                    icon.style.transform = 'rotate(360deg)';
                    setTimeout(() => {
                        icon.style.transition = '';
                        icon.style.transform = '';
                    }, 500);
                }
                this.softRefresh();
            });
        }

        // Fullscreen toggle buttons
        panel.querySelectorAll<HTMLButtonElement>('[data-action="browser-fullscreen"]').forEach((btn) => {
            btn.addEventListener('click', () => {
                this._browserFullscreen = !this._browserFullscreen;
                this._previewFullscreen = false;
                this._renderPanel();
            });
        });

        const browser = panel.querySelector<HTMLElement>('.ws-browser-body');
        if (browser) {
            browser.addEventListener('click', (ev) => this._handleBrowserClick(ev));
            browser.addEventListener('contextmenu', (ev) => {
                const target = ev.target as HTMLElement | null;
                if (!target) return;
                const row = target.closest<HTMLElement>('[data-path]');
                if (!row) return;
                const p = row.dataset.path;
                if (!p) return;
                const isDir = !!row.closest('.ws-tree-dir, .ws-grid-dir');
                this._showContextMenu(ev, p, isDir);
            });
        }

        const previewEl = panel.querySelector<HTMLElement>('[data-preview-root]');
        if (previewEl) {
            previewEl.addEventListener('click', (ev) => {
                const target = ev.target as HTMLElement | null;
                if (!target) return;
                if (target.closest('[data-action="preview-fullscreen"]')) {
                    this._previewFullscreen = !this._previewFullscreen;
                    this._browserFullscreen = false;
                    this._renderPanel();
                    return;
                }
                if (target.closest('[data-preview-close]')) {
                    this._selectedFile = null;
                    this._previewState = { status: 'idle' };
                    this._previewFullscreen = false;
                    const rn = this._rootNode;
                    if (rn) {
                        rn.querySelectorAll<HTMLElement>('.ws-file-selected').forEach((el) => {
                            el.classList.remove('ws-file-selected');
                        });
                    }
                    this._renderPreview();
                }
            });
        }

        // _renderPanel 后需要重新挂载 Markdown Shadow DOM（_renderPreviewHtml 只输出占位 div）
        this._attachMarkdownShadow(panel);
    }

    /**
     * 为 Markdown 预览的占位 div 挂载 Shadow DOM 并渲染内容。
     * 由 _renderPanel 和 _renderPreview 共同调用。
     */
    private _attachMarkdownShadow(root: ParentNode): void {
        if (
            !this._selectedFile ||
            !isMarkdownFile(this._selectedFile) ||
            this._previewState.status !== 'idle' ||
            !this._previewState.data?.content
        ) {
            return;
        }
        const host = root.querySelector<HTMLElement>('.ws-preview-md-host');
        if (!host || host.shadowRoot) return;
        const shadow = host.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = MARKDOWN_PREVIEW_CSS;
        shadow.appendChild(style);
        const container = document.createElement('div');
        container.className = 'markdown-body';
        container.innerHTML = marked.parse(this._previewState.data.content, { async: false }) as string;
        shadow.appendChild(container);
    }

    // ----- Tree HTML -----

    private _renderTreeContainerHtml(): string {
        if (!this._workspaceRoot) return '';
        return `
        <div class="ws-tree">
            <div class="ws-tree-children" data-dir="${escapeHtml(this._workspaceRoot)}">
                ${this._renderTreeChildrenHtml(this._workspaceRoot, 0)}
            </div>
        </div>`;
    }

    private _renderTreeChildrenHtml(dirPath: string, depth: number): string {
        const cached = this._childrenCache.get(dirPath);
        if (cached === 'loading' || cached === undefined) {
            return `<div class="ws-tree-loading" style="padding-left:${depth * 14 + 10}px">
                <i class="fas fa-circle-notch fa-spin"></i>
                <span>加载中…</span>
            </div>`;
        }
        if ((cached as { error?: string }).error) {
            return `<div class="ws-tree-error" style="padding-left:${depth * 14 + 10}px">
                <i class="fas fa-triangle-exclamation"></i>
                <span>${escapeHtml((cached as { error: string }).error)}</span>
            </div>`;
        }
        const entries = cached as FSEntry[];
        if (entries.length === 0) {
            return `<div class="ws-tree-empty" style="padding-left:${depth * 14 + 10}px">（空目录）</div>`;
        }
        return entries.map((e) => this._renderTreeEntryHtml(e, depth)).join('');
    }

    private _renderTreeEntryHtml(entry: FSEntry, depth: number): string {
        const pad = depth * 14 + 8;
        if (entry.isDirectory) {
            const expanded = this._expandedPaths.has(entry.path);
            const caret = expanded ? 'fa-chevron-down' : 'fa-chevron-right';
            const icon = expanded ? 'fa-folder-open' : 'fa-folder';
            const childrenHtml = expanded
                ? `<div class="ws-tree-children" data-dir="${escapeHtml(entry.path)}">
                        ${this._renderTreeChildrenHtml(entry.path, depth + 1)}
                    </div>`
                : '';
            return `
            <div class="ws-tree-node">
                <div class="ws-tree-row ws-tree-dir" data-action="tree-toggle"
                    data-path="${escapeHtml(entry.path)}" style="padding-left:${pad}px">
                    <i class="fas ${caret} ws-tree-caret"></i>
                    <i class="fas ${icon} ws-tree-icon ws-tree-icon-dir"></i>
                    <span class="ws-tree-name">${escapeHtml(entry.name)}</span>
                </div>
                ${childrenHtml}
            </div>`;
        }
        const selected = this._selectedFile === entry.path ? 'ws-file-selected' : '';
        return `
        <div class="ws-tree-node">
            <div class="ws-tree-row ws-tree-file ${selected}" data-action="tree-file"
                data-path="${escapeHtml(entry.path)}" data-file="${escapeHtml(entry.path)}"
                style="padding-left:${pad + 14}px">
                <i class="fas ${pickFileIcon(entry)} ws-tree-icon ws-tree-icon-file"></i>
                <span class="ws-tree-name">${escapeHtml(entry.name)}</span>
                <span class="ws-tree-size">${formatBytes(entry.size)}</span>
            </div>
        </div>`;
    }

    // ----- Grid HTML -----

    private _renderGridContainerHtml(): string {
        return `
        <div class="ws-grid">
            ${this._renderGridBreadcrumbHtml()}
            <div class="ws-grid-body">
                ${this._renderGridBodyHtml()}
            </div>
        </div>`;
    }

    private _renderGridBreadcrumbHtml(): string {
        if (!this._workspaceRoot || !this._gridPath) return '';
        const wsRoot = this._workspaceRoot;
        const cur = this._gridPath;
        const rel = cur === wsRoot ? '' : cur.slice(wsRoot.length).replace(/^\/+/, '');
        const segments = rel ? rel.split('/') : [];
        const parts: { label: string; path: string }[] = [
            { label: wsRoot.split('/').filter(Boolean).pop() || wsRoot, path: wsRoot }
        ];
        let acc = wsRoot;
        for (const seg of segments) {
            acc = `${acc}/${seg}`;
            parts.push({ label: seg, path: acc });
        }
        return `
        <div class="ws-crumb">
            ${parts
                .map((p, i) => {
                    const sep = i === 0 ? '' : '<i class="fas fa-angle-right ws-crumb-sep"></i>';
                    const isLast = i === parts.length - 1;
                    return `${sep}<button class="ws-crumb-seg ${isLast ? 'ws-crumb-seg-current' : ''}"
                            data-action="grid-crumb" data-path="${escapeHtml(p.path)}">
                            ${escapeHtml(p.label)}
                        </button>`;
                })
                .join('')}
        </div>`;
    }

    private _renderGridBodyHtml(): string {
        if (!this._gridPath) return '';
        const cached = this._childrenCache.get(this._gridPath);
        if (cached === undefined || cached === 'loading') {
            return `<div class="ws-grid-loading">
                <i class="fas fa-circle-notch fa-spin"></i>
                <span>加载中…</span>
            </div>`;
        }
        if ((cached as { error?: string }).error) {
            return `<div class="ws-grid-error">
                <i class="fas fa-triangle-exclamation"></i>
                <span>${escapeHtml((cached as { error: string }).error)}</span>
            </div>`;
        }
        const entries = cached as FSEntry[];
        const upButton =
            this._gridPath !== this._workspaceRoot
                ? `<div class="ws-grid-item ws-grid-up" data-action="grid-up"
                        data-path="${escapeHtml(this._parentOf(this._gridPath))}">
                        <i class="fas fa-arrow-up ws-grid-icon ws-grid-icon-up"></i>
                        <div class="ws-grid-name">上级目录</div>
                    </div>`
                : '';
        if (entries.length === 0) {
            return `<div class="ws-grid-items">
                ${upButton}
                <div class="ws-grid-empty">（空目录）</div>
            </div>`;
        }
        const items = entries
            .map((e) => {
                if (e.isDirectory) {
                    return `<div class="ws-grid-item ws-grid-dir" data-action="grid-dir"
                            data-path="${escapeHtml(e.path)}" title="${escapeHtml(e.name)}">
                            <i class="fas fa-folder ws-grid-icon ws-grid-icon-dir"></i>
                            <div class="ws-grid-name">${escapeHtml(e.name)}</div>
                        </div>`;
                }
                const selected = this._selectedFile === e.path ? 'ws-file-selected' : '';
                return `<div class="ws-grid-item ws-grid-file ${selected}" data-action="grid-file"
                        data-path="${escapeHtml(e.path)}" data-file="${escapeHtml(e.path)}"
                        title="${escapeHtml(e.name)}">
                        <i class="fas ${pickFileIcon(e)} ws-grid-icon ws-grid-icon-file"></i>
                        <div class="ws-grid-name">${escapeHtml(e.name)}</div>
                        <div class="ws-grid-size">${formatBytes(e.size)}</div>
                    </div>`;
            })
            .join('');
        return `<div class="ws-grid-items">
            ${upButton}
            ${items}
        </div>`;
    }

    private _parentOf(p: string): string {
        const idx = p.lastIndexOf('/');
        if (idx <= 0) return p;
        return p.slice(0, idx);
    }

    // ----- Preview HTML -----

    private _renderPreview(): void {
        const rn = this._rootNode;
        if (!rn) return;
        const el = rn.querySelector<HTMLElement>('[data-preview-root]');
        if (!el) return;
        el.innerHTML = this._renderPreviewHtml();
        el.classList.toggle('ws-preview--collapsed', !this._selectedFile);

        this._attachMarkdownShadow(el);
    }

    private _renderPreviewHtml(): string {
        if (!this._selectedFile) {
            return `
            <div class="ws-preview-empty">
                <i class="fas fa-eye"></i>
                <span>点击文件以在此预览</span>
            </div>`;
        }
        const name = this._selectedFile.split('/').pop() || this._selectedFile;
        const header = `
        <div class="ws-preview-header">
            <i class="fas fa-file-lines"></i>
            <span class="ws-preview-name" title="${escapeHtml(this._selectedFile)}">${escapeHtml(name)}</span>
            ${
                this._previewState.data
                    ? `<span class="ws-preview-size">${escapeHtml(formatBytes(this._previewState.data.size))}</span>`
                    : ''
            }
            <button class="ws-fullscreen-btn" title="全屏预览" data-action="preview-fullscreen">
                <i class="fas ${this._previewFullscreen ? 'fa-compress' : 'fa-expand'}"></i>
            </button>
            <button class="ws-preview-close" title="关闭预览" data-preview-close>
                <i class="fas fa-xmark"></i>
            </button>
        </div>`;

        let bodyHtml = '';
        if (this._previewState.status === 'loading') {
            bodyHtml = `
            <div class="ws-preview-body ws-preview-info">
                <i class="fas fa-circle-notch fa-spin"></i>
                <span>正在读取文件…</span>
            </div>`;
        } else if (this._previewState.status === 'error') {
            bodyHtml = `
            <div class="ws-preview-body ws-preview-info">
                <i class="fas fa-triangle-exclamation"></i>
                <span>${escapeHtml(this._previewState.error || '读取失败')}</span>
            </div>`;
        } else if (this._previewState.data) {
            const d = this._previewState.data;
            if (d.tooLarge) {
                bodyHtml = `
                <div class="ws-preview-body ws-preview-info">
                    <i class="fas fa-file-circle-xmark"></i>
                    <div>
                        <div>无法预览：文件大小 ${escapeHtml(formatBytes(d.size))}
                            超过 ${escapeHtml(formatBytes(d.limit))} 限制</div>
                        <div class="ws-preview-hint">当前预览器仅支持较小的文本文件</div>
                    </div>
                </div>`;
            } else if (d.binary) {
                bodyHtml = `
                <div class="ws-preview-body ws-preview-info">
                    <i class="fas fa-file-shield"></i>
                    <div>
                        <div>无法预览：检测到二进制文件</div>
                        <div class="ws-preview-hint">当前预览器仅支持文本文件</div>
                    </div>
                </div>`;
            } else if (this._selectedFile && isMarkdownFile(this._selectedFile)) {
                bodyHtml = `<div class="ws-preview-md-host"></div>`;
            } else {
                bodyHtml = `
                <div class="ws-preview-body">
                    <pre class="ws-preview-pre">${escapeHtml(d.content)}</pre>
                </div>`;
            }
        }

        return `${header}${bodyHtml}`;
    }
}
