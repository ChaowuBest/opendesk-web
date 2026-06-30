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
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

// Monaco Editor worker 配置：根据语言模块选择对应的 worker
(self as any).MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
        if (label === 'json') return new jsonWorker();
        if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
        if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
        if (label === 'typescript' || label === 'javascript') return new tsWorker();
        return new editorWorker();
    }
};

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

// 不再对预览文件体积做硬性限制；传 0 表示由后端自行决定（不截断）。
const PREVIEW_MAX_BYTES = 0;

// ============================================================================
// Utilities
// ============================================================================

import { escapeHtml } from '../../common/utils/escape.js';

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
            padding: 0;
            gap: 0;
            box-sizing: border-box;
            overflow: hidden;
        }

        .ws-browser {
            background: white;
            border: none;
            border-radius: 0;
            overflow: hidden;
            flex: 1;
            min-height: 120px;
            display: flex;
            flex-direction: column;
            border-bottom: 1px solid #e5e7eb;
        }

        .ws-browser-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            padding: 7px 12px;
            background: #f9fafb;
            border-bottom: 1px solid #e5e7eb;
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
            background: #f3f4f6;
            border-radius: 6px;
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
            box-shadow: 0 1px 1px rgba(0, 0, 0, 0.08), 0 0 0 0.5px rgba(0, 0, 0, 0.05);
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
            background: #f3f4f6;
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
            padding: 3px 12px 3px 10px; cursor: pointer; user-select: none;
            border-radius: 0; margin: 0; color: #1f2937; line-height: 1.5;
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
            display: flex; align-items: center; gap: 6px; padding: 4px 12px; font-size: 11px; color: #9ca3af;
        }
        .ws-tree-error { color: #b91c1c; }

        /* Grid view */
        .ws-grid { flex: 1; display: flex; flex-direction: column; min-height: 0; }
        .ws-crumb {
            display: flex; flex-wrap: wrap; align-items: center; gap: 2px;
            padding: 6px 12px; border-bottom: 1px solid #e5e7eb; font-size: 11px;
            color: #6b7280; background: #f9fafb;
        }
        .ws-crumb-seg {
            background: transparent; border: none; padding: 2px 6px;
            border-radius: 4px; cursor: pointer; color: #6b7280; font-size: 11px;
        }
        .ws-crumb-seg:hover { background: #f3f4f6; color: #1f2937; }
        .ws-crumb-seg-current { color: #1f2937; font-weight: 500; }
        .ws-crumb-sep { font-size: 9px; color: #cbd5e1; }

        .ws-grid-body { flex: 1; overflow: auto; padding: 8px 12px; }
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
            background: white; border: none; border-radius: 0;
            overflow: hidden; flex: 2; min-height: 80px;
            display: flex; flex-direction: column;
        }
        .ws-preview:empty, .ws-preview.ws-preview--collapsed {
            flex: 0 0 auto; min-height: 44px;
        }
        .ws-preview.ws-preview--unsupported {
            flex: 0 0 auto; min-height: auto;
        }
        .ws-preview.ws-preview--animating {
            animation: ws-preview-appear 0.18s ease-out;
        }
        @keyframes ws-preview-appear {
            from {
                opacity: 0;
                transform: translateY(8px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
        .ws-preview-empty {
            display: flex; align-items: center; justify-content: center;
            gap: 6px; padding: 10px 12px; font-size: 11px; color: #9ca3af;
        }
        .ws-preview-header {
            display: flex; align-items: center; gap: 6px;
            padding: 6px 12px; background: #f9fafb; border-bottom: 1px solid #e5e7eb;
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
        .ws-preview-close:hover { background: #f3f4f6; color: #1f2937; }
        .ws-preview-body { flex: 1; overflow: auto; overflow-x: auto; background: #fafafa; min-height: 60px; }
        .ws-preview-body::-webkit-scrollbar { width: 8px; height: 8px; }
        .ws-preview-body::-webkit-scrollbar-thumb {
            background: rgba(0, 0, 0, 0.2);
            border-radius: 4px;
        }
        .ws-preview-body::-webkit-scrollbar-thumb:hover { background: rgba(0, 0, 0, 0.35); }
        .ws-preview-body::-webkit-scrollbar-corner { background: transparent; }
        .ws-preview-pre {
            margin: 0; padding: 10px 12px;
            font-family: 'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace;
            font-size: 11px; line-height: 1.55; color: #1f2937; white-space: pre; min-width: max-content;
        }
        .ws-preview-info {
            display: flex; align-items: flex-start; gap: 8px;
            padding: 12px 14px; font-size: 12px; color: #475569;
        }
        .ws-preview-info > i { font-size: 14px; color: #64748b; margin-top: 2px; }
        .ws-preview-hint { font-size: 11px; color: #94a3b8; margin-top: 2px; }
        .ws-preview-code-host { flex: 1; overflow: auto; overflow-x: auto; min-height: 60px; background: #fafafa; }
        .ws-preview-code-host::-webkit-scrollbar { width: 8px; height: 8px; }
        .ws-preview-code-host::-webkit-scrollbar-thumb {
            background: rgba(0, 0, 0, 0.2);
            border-radius: 4px;
        }
        .ws-preview-code-host::-webkit-scrollbar-thumb:hover { background: rgba(0, 0, 0, 0.35); }
        .ws-preview-code-host::-webkit-scrollbar-corner { background: transparent; }
        .ws-preview-code-container {
            margin: 0; padding: 10px 12px;
            font-family: 'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace;
            font-size: 11px; line-height: 1.55; white-space: pre; min-width: max-content;
        }
        .ws-preview-code-container > span { white-space: pre; }

        .ws-preview-md-host {
            flex: 1; overflow: auto; overflow-x: auto; min-height: 60px;
        }
        .ws-preview-md-host::-webkit-scrollbar { width: 8px; height: 8px; }
        .ws-preview-md-host::-webkit-scrollbar-thumb {
            background: rgba(0, 0, 0, 0.2);
            border-radius: 4px;
        }
        .ws-preview-md-host::-webkit-scrollbar-thumb:hover { background: rgba(0, 0, 0, 0.35); }
        .ws-preview-md-host::-webkit-scrollbar-corner { background: transparent; }

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

        /* ── 深色模式覆盖 ── */
        :host([data-theme="dark"]) .ws-browser {
            background: #1e1e1e !important;
            border-bottom-color: rgba(255, 255, 255, 0.12) !important;
        }
        :host([data-theme="dark"]) .ws-browser-header {
            background: #252526 !important;
            border-bottom-color: rgba(255, 255, 255, 0.12) !important;
        }
        :host([data-theme="dark"]) .ws-path { color: #cccccc !important; }
        :host([data-theme="dark"]) .ws-path-icon { color: #ababab !important; }
        :host([data-theme="dark"]) .ws-view-switch { background: #333333 !important; }
        :host([data-theme="dark"]) .ws-view-btn { color: #ababab !important; }
        :host([data-theme="dark"]) .ws-view-btn:hover { color: #cccccc !important; }
        :host([data-theme="dark"]) .ws-view-btn.ws-view-active {
            background: #1e1e1e !important;
            color: #e4e4e4 !important;
            box-shadow: 0 1px 1px rgba(0,0,0,0.3), 0 0 0 0.5px rgba(255,255,255,0.08) !important;
        }
        :host([data-theme="dark"]) .ws-refresh-btn { color: #ababab !important; }
        :host([data-theme="dark"]) .ws-refresh-btn:hover {
            color: #cccccc !important;
            background: #333333 !important;
        }
        :host([data-theme="dark"]) .ws-tree-row { color: #cccccc !important; }
        :host([data-theme="dark"]) .ws-tree-row:hover { background: #333333 !important; }
        :host([data-theme="dark"]) .ws-tree-row.ws-file-selected { background: rgba(96, 165, 250, 0.15) !important; }
        :host([data-theme="dark"]) .ws-tree-caret { color: #787878 !important; }
        :host([data-theme="dark"]) .ws-tree-icon-file { color: #787878 !important; }
        :host([data-theme="dark"]) .ws-tree-size { color: #787878 !important; }
        :host([data-theme="dark"]) .ws-tree-loading,
        :host([data-theme="dark"]) .ws-tree-empty { color: #787878 !important; }
        :host([data-theme="dark"]) .ws-grid-item { color: #cccccc !important; }
        :host([data-theme="dark"]) .ws-grid-item:hover { background: #333333 !important; }
        :host([data-theme="dark"]) .ws-grid-item.ws-file-selected { background: rgba(96, 165, 250, 0.15) !important; }
        :host([data-theme="dark"]) .ws-grid-icon-file { color: #787878 !important; }
        :host([data-theme="dark"]) .ws-grid-icon-up { color: #ababab !important; }
        :host([data-theme="dark"]) .ws-grid-name { color: #cccccc !important; }
        :host([data-theme="dark"]) .ws-grid-size { color: #787878 !important; }
        :host([data-theme="dark"]) .ws-grid-loading,
        :host([data-theme="dark"]) .ws-grid-empty { color: #787878 !important; }
        :host([data-theme="dark"]) .ws-crumb {
            color: #ababab !important;
            background: #252526 !important;
            border-bottom-color: rgba(255, 255, 255, 0.12) !important;
        }
        :host([data-theme="dark"]) .ws-crumb-seg { color: #ababab !important; }
        :host([data-theme="dark"]) .ws-crumb-seg:hover {
            background: #333333 !important;
            color: #cccccc !important;
        }
        :host([data-theme="dark"]) .ws-crumb-seg-current { color: #e4e4e4 !important; }
        :host([data-theme="dark"]) .ws-crumb-sep { color: #555555 !important; }
        :host([data-theme="dark"]) .ws-preview {
            background: #1e1e1e !important;
        }
        :host([data-theme="dark"]) .ws-preview-empty { color: #787878 !important; }
        :host([data-theme="dark"]) .ws-preview-header {
            background: #252526 !important;
            border-bottom-color: rgba(255, 255, 255, 0.12) !important;
            color: #cccccc !important;
        }
        :host([data-theme="dark"]) .ws-preview-header > i { color: #ababab !important; }
        :host([data-theme="dark"]) .ws-preview-size { color: #787878 !important; }
        :host([data-theme="dark"]) .ws-preview-close { color: #ababab !important; }
        :host([data-theme="dark"]) .ws-preview-close:hover {
            background: #333333 !important;
            color: #cccccc !important;
        }
        :host([data-theme="dark"]) .ws-preview-body { background: #1e1e1e !important; }
        :host([data-theme="dark"]) .ws-preview-pre { color: #cccccc !important; }
        :host([data-theme="dark"]) .ws-preview-info { color: #ababab !important; }
        :host([data-theme="dark"]) .ws-preview-info > i { color: #787878 !important; }
        :host([data-theme="dark"]) .ws-preview-hint { color: #787878 !important; }
        :host([data-theme="dark"]) .ws-preview-code-host { background: #1e1e1e !important; }
        :host([data-theme="dark"]) .ws-fullscreen-btn { color: #ababab !important; }
        :host([data-theme="dark"]) .ws-fullscreen-btn:hover {
            color: #cccccc !important;
            background: #333333 !important;
        }
        :host([data-theme="dark"]) .ws-tree::-webkit-scrollbar-thumb,
        :host([data-theme="dark"]) .ws-grid-body::-webkit-scrollbar-thumb,
        :host([data-theme="dark"]) .ws-preview-body::-webkit-scrollbar-thumb,
        :host([data-theme="dark"]) .ws-preview-code-host::-webkit-scrollbar-thumb,
        :host([data-theme="dark"]) .ws-preview-md-host::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.25) !important;
            border-radius: 4px;
        }
        :host([data-theme="dark"]) .ws-tree::-webkit-scrollbar-thumb:hover,
        :host([data-theme="dark"]) .ws-grid-body::-webkit-scrollbar-thumb:hover,
        :host([data-theme="dark"]) .ws-preview-body::-webkit-scrollbar-thumb:hover,
        :host([data-theme="dark"]) .ws-preview-code-host::-webkit-scrollbar-thumb:hover,
        :host([data-theme="dark"]) .ws-preview-md-host::-webkit-scrollbar-thumb:hover {
            background: rgba(255, 255, 255, 0.4) !important;
        }
        :host([data-theme="dark"]) .ws-preview-body::-webkit-scrollbar,
        :host([data-theme="dark"]) .ws-preview-code-host::-webkit-scrollbar,
        :host([data-theme="dark"]) .ws-preview-md-host::-webkit-scrollbar {
            width: 8px; height: 8px;
        }
        :host([data-theme="dark"]) .ws-preview-body::-webkit-scrollbar-corner,
        :host([data-theme="dark"]) .ws-preview-code-host::-webkit-scrollbar-corner,
        :host([data-theme="dark"]) .ws-preview-md-host::-webkit-scrollbar-corner {
            background: transparent;
        }

        /* CSS 变量穿透 Shadow DOM 供 Markdown 预览使用 */
        .ws-preview-md-host {
            --od-md-bg: #fafafa;
            --od-md-color: #1f2937;
            --od-md-border: #e5e7eb;
            --od-md-border-light: #f3f4f6;
            --od-md-code-bg: #f1f5f9;
            --od-md-code-color: #334155;
            --od-md-pre-bg: #f8fafc;
            --od-md-pre-border: #e2e8f0;
            --od-md-blockquote-bg: #f9fafb;
            --od-md-blockquote-border: #d1d5db;
            --od-md-blockquote-color: #6b7280;
            --od-md-table-border: #e2e8f0;
            --od-md-th-bg: #f8fafc;
            --od-md-link-color: #2563eb;
        }
        :host([data-theme="dark"]) .ws-preview-md-host {
            --od-md-bg: #1e1e1e;
            --od-md-color: #cccccc;
            --od-md-border: rgba(255,255,255,0.12);
            --od-md-border-light: rgba(255,255,255,0.08);
            --od-md-code-bg: rgba(255,255,255,0.08);
            --od-md-code-color: #f0a0c0;
            --od-md-pre-bg: #252526;
            --od-md-pre-border: rgba(255,255,255,0.12);
            --od-md-blockquote-bg: #252526;
            --od-md-blockquote-border: #555555;
            --od-md-blockquote-color: #ababab;
            --od-md-table-border: rgba(255,255,255,0.12);
            --od-md-th-bg: #252526;
            --od-md-link-color: #93c5fd;
        }
    `;
}

function isMarkdownFile(filePath: string): boolean {
    const ext = filePath.split('.').pop()?.toLowerCase();
    return ext === 'md' || ext === 'markdown';
}

function isHtmlFile(filePath: string): boolean {
    const ext = filePath.split('.').pop()?.toLowerCase();
    return ext === 'html' || ext === 'htm';
}

const CODE_FILE_EXTENSIONS: Record<string, string> = {
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    tsx: 'typescript',
    json: 'json',
    jsonc: 'json',
    css: 'css',
    scss: 'scss',
    less: 'less',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    kts: 'kotlin',
    swift: 'swift',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    cs: 'csharp',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    sql: 'sql',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    svg: 'xml',
    toml: 'ini',
    ini: 'ini',
    dockerfile: 'dockerfile',
    makefile: 'makefile',
    r: 'r',
    lua: 'lua',
    php: 'php',
    perl: 'perl',
    pl: 'perl',
    vue: 'html',
    graphql: 'graphql',
    gql: 'graphql'
};

function getCodeLanguage(filePath: string): string | null {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    return CODE_FILE_EXTENSIONS[ext] || null;
}

const MARKDOWN_PREVIEW_CSS = `
    :host {
        display: block;
        height: 100%;
        overflow: auto;
        background: var(--od-md-bg, #fbfcfd);
    }
    .markdown-body {
        font-family: var(--font-sans);
        font-size: 12px;
        line-height: 1.7;
        color: var(--od-md-color, #1f2937);
        padding: 12px 14px;
        word-wrap: break-word;
    }
    .markdown-body h1 { font-size: 1.4em; margin: 0.8em 0 0.4em; font-weight: 600; border-bottom: 1px solid var(--od-md-border, #e5e7eb); padding-bottom: 0.3em; }
    .markdown-body h2 { font-size: 1.25em; margin: 0.7em 0 0.3em; font-weight: 600; border-bottom: 1px solid var(--od-md-border-light, #f3f4f6); padding-bottom: 0.2em; }
    .markdown-body h3 { font-size: 1.1em; margin: 0.6em 0 0.3em; font-weight: 600; }
    .markdown-body h4, .markdown-body h5, .markdown-body h6 { font-size: 1em; margin: 0.5em 0 0.2em; font-weight: 600; }
    .markdown-body p { margin: 0 0 0.5em; }
    .markdown-body ul, .markdown-body ol { padding-left: 1.6em; margin: 0.3em 0 0.5em; }
    .markdown-body li { margin-bottom: 0.15em; }
    .markdown-body blockquote {
        margin: 0.5em 0; padding: 0.3em 0.8em;
        border-left: 3px solid var(--od-md-blockquote-border, #d1d5db);
        color: var(--od-md-blockquote-color, #6b7280);
        background: var(--od-md-blockquote-bg, #f9fafb);
    }
    .markdown-body code {
        font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace;
        font-size: 0.9em; padding: 0.15em 0.35em;
        background: var(--od-md-code-bg, #f1f5f9);
        border-radius: 3px;
        color: var(--od-md-code-color, #334155);
    }
    .markdown-body pre {
        margin: 0.5em 0; padding: 0.7em 0.9em;
        background: var(--od-md-pre-bg, #f8fafc);
        border: 1px solid var(--od-md-pre-border, #e2e8f0);
        border-radius: 6px;
        overflow-x: auto; font-size: 11px; line-height: 1.5;
    }
    .markdown-body pre code { padding: 0; background: none; border-radius: 0; font-size: inherit; }
    .markdown-body table {
        font-size: 11px; margin: 0.5em 0; width: 100%;
        border-collapse: collapse; border: 1px solid var(--od-md-table-border, #e2e8f0); border-radius: 6px;
    }
    .markdown-body th { background: var(--od-md-th-bg, #f8fafc); font-weight: 600; text-align: left; }
    .markdown-body th, .markdown-body td { padding: 0.4em 0.7em; border-bottom: 1px solid var(--od-md-border-light, #f1f5f9); }
    .markdown-body hr { border: none; border-top: 1px solid var(--od-md-border, #e5e7eb); margin: 0.8em 0; }
    .markdown-body a { color: var(--od-md-link-color, #2563eb); text-decoration: none; }
    .markdown-body a:hover { text-decoration: underline; }
    .markdown-body img { max-width: 100%; border-radius: 4px; }
    .markdown-body strong { font-weight: 600; }
`;

// ============================================================================
// FileExplorer
// ============================================================================

// 编辑器自动保存延迟（毫秒）
const EDITOR_AUTO_SAVE_DELAY = 1500;

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

    /** 在浏览器中打开文件的回调（由宿主组件设置） */
    onOpenInBrowser: ((filePath: string) => void) | null = null;

    // Monaco Editor 状态
    private _editorMode = false;
    private _editorInstance: monaco.editor.IStandaloneCodeEditor | null = null;
    private _editorOverlay: HTMLElement | null = null;
    private _editorFilePath: string | null = null;
    private _editorDirty = false;
    private _editorSaving = false;
    private _editorOpenLine: number | null = null;
    private _editorSaveTimer: number | null = null;
    private _editorResizeObserver: ResizeObserver | null = null;

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
        // 切换任务/工作空间时先关闭编辑器覆盖层
        this._destroyEditorOverlay();
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

    /**
     * 关闭编辑器（供外部调用，如侧边栏收起时）。
     */
    closeEditor(): void {
        this._closeEditor();
    }

    /**
     * 编辑器是否处于打开状态。
     */
    isEditorOpen(): boolean {
        return this._editorMode && this._editorOverlay !== null;
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
        // 检查当前是否为空状态（展开动画）
        const wasEmpty = !this._selectedFile;
        this._selectedFile = filePath;
        this._previewState = { status: 'loading' };
        this._renderPreview(wasEmpty);
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

        const isDark = document.documentElement.dataset.theme === 'dark';
        const menuBg = isDark ? 'rgba(37, 37, 38, 0.95)' : 'rgba(255, 255, 255, 0.88)';
        const menuBorder = isDark ? '0.5px solid rgba(255, 255, 255, 0.12)' : '0.5px solid rgba(0, 0, 0, 0.08)';
        const menuShadow = isDark
            ? '0 12px 40px -8px rgba(0,0,0,0.5), 0 0 0 0.5px rgba(255,255,255,0.06), inset 0 0.5px 0 rgba(255,255,255,0.04)'
            : '0 12px 40px -8px rgba(0,0,0,0.15), 0 0 0 0.5px rgba(0,0,0,0.04), inset 0 0.5px 0 rgba(255,255,255,0.5)';
        const btnColor = isDark ? '#cccccc' : '#1f2937';
        const iconColor = isDark ? '#ababab' : '#6b7280';
        const sepColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
        const hoverBg = isDark ? '#3b82f6' : '#3b82f6';
        const hoverColor = 'white';
        const dangerHoverBg = isDark ? 'rgba(220, 38, 38, 0.15)' : '#fef2f2';

        const menu = document.createElement('div');
        Object.assign(menu.style, {
            position: 'fixed',
            zIndex: '9999',
            minWidth: '180px',
            padding: '4px',
            borderRadius: '10px',
            background: menuBg,
            backdropFilter: 'blur(40px) saturate(1.8)',
            WebkitBackdropFilter: 'blur(40px) saturate(1.8)',
            border: menuBorder,
            boxShadow: menuShadow,
            animation: 'ws-ctx-appear 0.12s ease-out',
            fontFamily: 'system-ui, -apple-system, sans-serif'
        });

        const items: { icon: string; label: string; action: string; danger?: boolean }[] = [];
        if (!isDirectory) {
            items.push({ icon: 'fa-eye', label: '预览', action: 'preview' });
            items.push({ icon: 'fa-pen-to-square', label: `编辑 ${filePath.split('/').pop() || ''}`, action: 'edit' });
            const ext = filePath.split('.').pop()?.toLowerCase();
            if (ext === 'html' || ext === 'htm') {
                items.push({ icon: 'fa-globe', label: '在浏览器中打开', action: 'open-in-browser' });
            }
        }
        items.push({ icon: 'fa-arrow-up-right-from-square', label: '用默认应用打开', action: 'open-default' });
        items.push({ icon: 'fa-folder-open', label: '在文件夹中显示', action: 'reveal' });
        items.push({ icon: 'fa-link', label: '复制路径', action: 'copy-path' });
        items.push({ icon: 'fa-trash-can', label: '删除', action: 'delete', danger: true });

        const btnStyle = `
            display:flex; align-items:center; gap:8px; width:100%;
            padding:6px 10px; border:none; border-radius:6px;
            background:transparent; font-size:12px; color:${btnColor};
            cursor:pointer; text-align:left; transition:background 0.1s;
        `.trim();
        const iconStyle = `width:16px; text-align:center; font-size:12px; color:${iconColor}; flex-shrink:0;`;

        const dangerBtnStyle = btnStyle.replace(`color:${btnColor}`, 'color:#dc2626');
        const dangerIconStyle = iconStyle.replace(`color:${iconColor}`, 'color:#dc2626');

        menu.innerHTML = items
            .map((it, i) => {
                const needSep = (i > 0 && it.action === 'copy-path') || it.action === 'delete';
                const sep = needSep ? `<div style="height:1px; margin:3px 8px; background:${sepColor};"></div>` : '';
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
                btn.style.background = isDanger ? dangerHoverBg : hoverBg;
                btn.style.color = isDanger ? '#dc2626' : hoverColor;
                const icon = btn.querySelector('i');
                if (icon) (icon as HTMLElement).style.color = isDanger ? '#dc2626' : hoverColor;
            });
            btn.addEventListener('mouseleave', () => {
                btn.style.background = 'transparent';
                btn.style.color = isDanger ? '#dc2626' : btnColor;
                const icon = btn.querySelector('i');
                if (icon) (icon as HTMLElement).style.color = isDanger ? '#dc2626' : iconColor;
            });
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = btn.dataset.ctxAction;
                this._dismissContextMenu();
                switch (action) {
                    case 'preview':
                        this.selectFile(filePath);
                        break;
                    case 'edit':
                        this.openEditor(filePath);
                        break;
                    case 'open-in-browser':
                        this.onOpenInBrowser?.(filePath);
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
                if (this._editorMode) {
                    this.openEditor(p);
                } else {
                    this.selectFile(p);
                }
                break;
            case 'grid-dir':
                this._enterGridDir(p);
                break;
            case 'grid-file':
                if (this._editorMode) {
                    this.openEditor(p);
                } else {
                    this.selectFile(p);
                }
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
        <div class="ws-preview${this._selectedFile ? '' : ' ws-preview--collapsed'}${this._previewFullscreen ? ' ws-preview--fullscreen' : ''}${this._isPreviewUnsupported() ? ' ws-preview--unsupported' : ''}" data-preview-root>
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
                if (target.closest('[data-action="open-editor"]')) {
                    if (this._selectedFile) {
                        this.openEditor(this._selectedFile);
                    }
                    return;
                }
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

        this._attachMarkdownShadow(panel);
        this._attachHtmlPreview(panel);
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

    // ----- Monaco Editor -----

    /**
     * 打开 Monaco Editor 编辑指定文件。
     * 编辑器以浮动覆盖层形式呈现在主文档中（避免 Shadow DOM 样式隔离问题）。
     */
    openEditor(filePath: string, line?: number): void {
        // 如果编辑器正在编辑同一文件，仅跳转行号
        if (this._editorMode && this._editorFilePath === filePath && this._editorInstance) {
            if (line != null && line > 0) {
                this._editorInstance.revealLineInCenter(line);
                this._editorInstance.setPosition({ lineNumber: line, column: 1 });
            }
            this._editorInstance.focus();
            return;
        }
        // 如果当前有未保存的内容，先触发保存（不阻塞）
        if (this._editorDirty && this._editorInstance && this._editorFilePath) {
            const content = this._editorInstance.getValue();
            const oldPath = this._editorFilePath;
            (window as any).fsAPI?.writeTextFile?.(oldPath, content)?.catch?.(() => {});
        }
        // 仅清理旧编辑器实例，不恢复布局（马上会打开新编辑器）
        this._teardownEditorInstance();
        this._editorFilePath = filePath;
        this._editorMode = true;
        this._editorDirty = false;
        this._editorSaving = false;
        this._editorEverDirtied = false;
        this._editorOpenLine = line ?? null;
        this._clearEditorSaveTimer();
        this._selectedFile = filePath;
        // 更新树中文件的选中高亮
        const rn = this._rootNode;
        if (rn) {
            rn.querySelectorAll<HTMLElement>('.ws-file-selected').forEach((el) => {
                el.classList.remove('ws-file-selected');
            });
            rn.querySelectorAll<HTMLElement>(`[data-file="${cssEscape(filePath)}"]`).forEach((el) => {
                el.classList.add('ws-file-selected');
            });
        }
        // 不改变当前布局——编辑器 overlay 会自动对齐 previewRoot 的位置和尺寸
        // 开始异步加载流程
        this._loadFileForEditor(filePath);
    }

    /**
     * 将文件路径解析为规范化的绝对路径，委托给后端处理平台差异。
     */
    private async _resolveFilePath(filePath: string): Promise<string> {
        const api = window.fsAPI;
        if (api && typeof api.resolveFilePath === 'function') {
            return api.resolveFilePath(filePath);
        }
        return filePath;
    }

    private async _loadFileForEditor(filePath: string): Promise<void> {
        try {
            // 根据当前布局状态同步 DOM class，但不重建 DOM 以保留文件树状态
            const rn = this._rootNode;
            if (rn) {
                const browserEl = rn.querySelector<HTMLElement>('.ws-browser');
                const previewEl = rn.querySelector<HTMLElement>('[data-preview-root]');
                if (browserEl) {
                    browserEl.classList.toggle('ws-browser--hidden', this._previewFullscreen);
                    browserEl.classList.toggle('ws-browser--fullscreen', this._browserFullscreen);
                }
                if (previewEl) {
                    previewEl.classList.toggle('ws-preview--fullscreen', this._previewFullscreen);
                    previewEl.classList.remove('ws-preview--collapsed', 'ws-preview--unsupported');
                    previewEl.innerHTML = '<div class="ws-preview-body" style="flex:1;"></div>';
                }
            } else if (this._container) {
                // 面板尚未渲染过，回退到完整渲染
                this._renderPanel();
            }

            const api = window.fsAPI;
            if (!api || typeof api.readTextFile !== 'function') {
                throw new Error('当前环境未提供 fsAPI.readTextFile');
            }

            // 解析为绝对路径
            const resolvedPath = await this._resolveFilePath(filePath);

            // 并行：读取文件 + 等待 previewRoot 就绪
            const [data] = await Promise.all([api.readTextFile(resolvedPath, 0), this._waitForPreviewRoot()]);

            if (this._editorFilePath !== filePath) return;
            if (data.binary) {
                this._editorMode = false;
                return;
            }
            this._createEditorOverlay(resolvedPath, data.content);
        } catch (err) {
            console.error('Failed to load file for editor:', err);
            this._editorMode = false;
        }
    }

    /**
     * 等待 previewRoot 元素存在且尺寸大于 0。
     * 在侧边栏展开动画期间 previewRoot 可能尚不可用。
     */
    private _waitForPreviewRoot(maxAttempts = 40): Promise<void> {
        return new Promise((resolve) => {
            const check = (attempt: number) => {
                const rn = this._rootNode;
                if (rn) {
                    const el = rn.querySelector<HTMLElement>('[data-preview-root]');
                    if (el) {
                        const rect = el.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            resolve();
                            return;
                        }
                    }
                }
                if (attempt >= maxAttempts) {
                    // 超时后仍然尝试
                    resolve();
                    return;
                }
                requestAnimationFrame(() => check(attempt + 1));
            };
            check(0);
        });
    }

    private _createEditorOverlay(filePath: string, content: string): void {
        // 仅清理旧编辑器实例，不恢复布局（马上会创建新编辑器覆盖层）
        this._teardownEditorInstance();
        this._editorFilePath = filePath;

        const rn = this._rootNode;
        if (!rn) return;
        const previewRoot = rn.querySelector<HTMLElement>('[data-preview-root]');
        if (!previewRoot) return;

        // 在 preview 区域放一个占位元素（防止 :empty 触发 flex 收缩）
        previewRoot.innerHTML = '<div class="ws-preview-body" style="flex:1;"></div>';
        previewRoot.classList.remove('ws-preview--collapsed', 'ws-preview--unsupported');

        const fileName = filePath.split('/').pop() || filePath;

        // Monaco 必须挂载到主文档（Shadow DOM 下样式无法生效），
        // 使用 fixed 定位对齐 previewRoot 的位置
        const overlay = document.createElement('div');
        overlay.className = 'opendesk-editor-overlay';
        overlay.style.cssText = `
            position: fixed;
            display: flex;
            flex-direction: column;
            background: #fafafa;
            border-radius: 0;
            overflow: hidden;
            z-index: 9000;
            box-shadow: none;
            border: none;
        `;

        const updateOverlayPosition = () => {
            const rect = previewRoot.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                overlay.style.top = rect.top + 'px';
                overlay.style.left = rect.left + 'px';
                overlay.style.width = rect.width + 'px';
                overlay.style.height = rect.height + 'px';
            }
        };
        // 延迟一帧让布局稳定后再定位
        requestAnimationFrame(() => updateOverlayPosition());

        // 工具栏
        const toolbar = document.createElement('div');
        toolbar.className = 'opendesk-editor-toolbar';
        toolbar.style.cssText = `
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px 12px;
            background: #f9fafb;
            border-bottom: 1px solid #e5e7eb;
            flex-shrink: 0;
            position: relative;
            z-index: 10;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        `;
        toolbar.innerHTML = `
            <i class="fas fa-file-code" style="color: #4a90d9; font-size: 12px; flex-shrink: 0;"></i>
            <span class="editor-filename" style="
                color: #334155; font-size: 12px; font-weight: 500;
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                min-width: 0; flex: 1;
            " title="${escapeHtml(filePath)}">${escapeHtml(fileName)}</span>
            <span class="editor-status" style="
                color: #858585; font-size: 11px; flex-shrink: 0;
                display: flex; align-items: center; gap: 4px;
            "></span>
            <button class="editor-save-btn" title="保存 (Ctrl+S)" style="
                display: none; align-items: center; gap: 4px;
                padding: 3px 10px; border: none; border-radius: 4px;
                background: #0e639c; color: white; font-size: 11px;
                cursor: pointer; flex-shrink: 0; transition: background 0.15s;
            "><i class="fas fa-floppy-disk" style="font-size: 10px;"></i> 保存</button>
            <button class="editor-maximize-btn" title="最大化" style="
                width: 24px; height: 24px; border: none; border-radius: 4px;
                background: transparent; color: #6b7280; cursor: pointer;
                display: flex; align-items: center; justify-content: center;
                font-size: 12px; flex-shrink: 0; transition: background 0.15s;
            "><i class="fas fa-expand"></i></button>
            <button class="editor-close-btn" title="关闭编辑器" style="
                width: 24px; height: 24px; border: none; border-radius: 4px;
                background: transparent; color: #6b7280; cursor: pointer;
                display: flex; align-items: center; justify-content: center;
                font-size: 13px; flex-shrink: 0; transition: background 0.15s;
            "><i class="fas fa-xmark"></i></button>
        `;

        // 编辑器容器
        const editorContainer = document.createElement('div');
        editorContainer.className = 'opendesk-editor-container';
        editorContainer.style.cssText = 'flex: 1; overflow: hidden;';

        overlay.appendChild(toolbar);
        overlay.appendChild(editorContainer);
        document.body.appendChild(overlay);
        this._editorOverlay = overlay;

        // 监听 previewRoot 尺寸变化，实时同步 overlay 位置
        this._editorResizeObserver = new ResizeObserver(() => updateOverlayPosition());
        this._editorResizeObserver.observe(previewRoot);
        window.addEventListener('resize', updateOverlayPosition);
        (overlay as any)._updatePosition = updateOverlayPosition;

        // 绑定工具栏事件（使用 pointerdown 确保不被 Monaco 吞掉事件）
        const closeBtn = toolbar.querySelector('.editor-close-btn') as HTMLButtonElement;
        closeBtn.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            e.preventDefault();
            this._closeEditor();
        });
        closeBtn.addEventListener('mouseenter', () => {
            closeBtn.style.background = '#eef2f6';
        });
        closeBtn.addEventListener('mouseleave', () => {
            closeBtn.style.background = 'transparent';
        });

        const saveBtn = toolbar.querySelector('.editor-save-btn') as HTMLButtonElement;
        const doSave = async () => {
            console.log(
                '[editor-save] doSave called, instance:',
                !!this._editorInstance,
                'path:',
                this._editorFilePath
            );
            if (!this._editorInstance || !this._editorFilePath) {
                console.log('[editor-save] aborted: no instance or no path');
                return;
            }
            const statusEl = overlay.querySelector('.editor-status') as HTMLElement;
            console.log('[editor-save] statusEl:', statusEl);
            try {
                statusEl.innerHTML = '<i class="fas fa-circle-notch fa-spin" style="font-size:10px;"></i> 保存中…';
                statusEl.style.color = '#3b82f6';
                const content = this._editorInstance.getValue();
                console.log('[editor-save] calling writeTextFile, length:', content.length);
                await (window as any).fsAPI.writeTextFile(this._editorFilePath, content);
                console.log('[editor-save] writeTextFile success');
                this._editorDirty = false;
                this._editorEverDirtied = true;
                statusEl.innerHTML = '<i class="fas fa-check" style="font-size:10px;"></i> 已保存';
                statusEl.style.color = '#16a34a';
                saveBtn.style.display = 'none';
                const fn = overlay.querySelector('.editor-filename') as HTMLElement;
                if (fn && fn.textContent?.startsWith('● ')) fn.textContent = fn.textContent.slice(2);
                setTimeout(() => {
                    if (!this._editorDirty) statusEl.innerHTML = '';
                }, 2000);
                this.softRefresh();
            } catch (err: any) {
                console.error('[editor-save] save error:', err);
                statusEl.innerHTML = `<i class="fas fa-triangle-exclamation" style="font-size:10px;"></i> ${err?.message || err}`;
                statusEl.style.color = '#dc2626';
            }
        };
        saveBtn.addEventListener('pointerdown', (e) => {
            console.log('[editor-save] pointerdown on save btn');
            e.stopPropagation();
            e.preventDefault();
            void doSave();
        });
        saveBtn.addEventListener('click', (e) => {
            console.log('[editor-save] click on save btn');
            e.stopPropagation();
            e.preventDefault();
            void doSave();
        });
        saveBtn.addEventListener('mouseenter', () => {
            saveBtn.style.background = '#1177bb';
        });
        saveBtn.addEventListener('mouseleave', () => {
            saveBtn.style.background = '#0e639c';
        });

        const maximizeBtn = toolbar.querySelector('.editor-maximize-btn') as HTMLButtonElement;
        maximizeBtn.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            e.preventDefault();
            this._previewFullscreen = !this._previewFullscreen;
            this._browserFullscreen = false;
            // 直接切换 CSS 类而非重渲染面板，避免破坏 overlay 的 DOM 引用
            const rn = this._rootNode;
            if (rn) {
                const browserEl = rn.querySelector<HTMLElement>('.ws-browser');
                const previewEl = rn.querySelector<HTMLElement>('[data-preview-root]');
                if (browserEl) {
                    browserEl.classList.toggle('ws-browser--hidden', this._previewFullscreen);
                    browserEl.classList.remove('ws-browser--fullscreen');
                }
                if (previewEl) {
                    previewEl.classList.toggle('ws-preview--fullscreen', this._previewFullscreen);
                }
            }
            const icon = maximizeBtn.querySelector('i')!;
            if (this._previewFullscreen) {
                icon.className = 'fas fa-compress';
                maximizeBtn.title = '还原';
            } else {
                icon.className = 'fas fa-expand';
                maximizeBtn.title = '最大化';
            }
            requestAnimationFrame(() => updateOverlayPosition());
        });
        maximizeBtn.addEventListener('mouseenter', () => {
            maximizeBtn.style.background = '#eef2f6';
        });
        maximizeBtn.addEventListener('mouseleave', () => {
            maximizeBtn.style.background = 'transparent';
        });

        // 初始化 Monaco Editor
        const language = this._getMonacoLanguage(filePath);
        const isDark = document.documentElement.dataset.theme === 'dark';
        this._editorInstance = monaco.editor.create(editorContainer, {
            value: content,
            language,
            theme: isDark ? 'vs-dark' : 'vs',
            fontSize: 13,
            lineHeight: 20,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            wordWrap: 'on',
            tabSize: 4,
            renderWhitespace: 'selection',
            smoothScrolling: true,
            cursorBlinking: 'smooth',
            cursorSmoothCaretAnimation: 'on',
            padding: { top: 8, bottom: 8 },
            bracketPairColorization: { enabled: true },
            guides: { bracketPairs: true }
        });

        // 监听内容变化 → 标记 dirty
        this._editorInstance.onDidChangeModelContent(() => {
            this._editorDirty = true;
            this._updateEditorStatus();
            this._scheduleEditorAutoSave();
        });

        // Ctrl+S / Cmd+S 手动保存
        this._editorInstance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => this._saveEditorContent());

        // Escape 关闭编辑器
        this._editorInstance.addCommand(monaco.KeyCode.Escape, () => this._closeEditor());

        this._updateEditorStatus();

        // 跳转到指定行并聚焦（延迟以确保编辑器完成布局）
        const targetLine = this._editorOpenLine != null && this._editorOpenLine > 0 ? this._editorOpenLine : null;
        this._editorOpenLine = null;
        const editor = this._editorInstance;
        setTimeout(() => {
            if (!editor || editor !== this._editorInstance) return;
            editor.layout();
            if (targetLine) {
                editor.revealLineInCenter(targetLine);
                editor.setPosition({ lineNumber: targetLine, column: 1 });
            }
            editor.focus();
        }, 100);
    }

    private _editorEverDirtied = false;

    private _updateEditorStatus(): void {
        if (!this._editorOverlay) return;
        const statusEl = this._editorOverlay.querySelector('.editor-status') as HTMLElement;
        const saveBtn = this._editorOverlay.querySelector('.editor-save-btn') as HTMLElement;
        const filenameEl = this._editorOverlay.querySelector('.editor-filename') as HTMLElement;

        if (this._editorSaveError) {
            statusEl.innerHTML = `<i class="fas fa-triangle-exclamation" style="font-size:10px;"></i> ${this._editorSaveError}`;
            statusEl.style.color = '#dc2626';
            saveBtn.style.display = 'flex';
        } else if (this._editorSaving) {
            statusEl.innerHTML = '<i class="fas fa-circle-notch fa-spin" style="font-size:10px;"></i> 保存中…';
            statusEl.style.color = '#3b82f6';
        } else if (this._editorDirty) {
            this._editorEverDirtied = true;
            statusEl.innerHTML = '<i class="fas fa-circle" style="font-size:6px;"></i> 未保存';
            statusEl.style.color = '#d97706';
            saveBtn.style.display = 'flex';
            // 文件名标记为修改
            if (filenameEl && !filenameEl.textContent?.startsWith('● ')) {
                filenameEl.textContent = '● ' + filenameEl.textContent;
            }
        } else if (this._editorEverDirtied) {
            statusEl.innerHTML = '<i class="fas fa-check" style="font-size:10px;"></i> 已保存';
            statusEl.style.color = '#16a34a';
            saveBtn.style.display = 'none';
            // 恢复文件名
            if (filenameEl && filenameEl.textContent?.startsWith('● ')) {
                filenameEl.textContent = filenameEl.textContent.slice(2);
            }
            // 短暂显示后隐藏状态文字
            setTimeout(() => {
                if (!this._editorDirty && !this._editorSaving && statusEl) {
                    statusEl.innerHTML = '';
                }
            }, 2000);
        } else {
            statusEl.innerHTML = '';
            saveBtn.style.display = 'none';
        }
    }

    private _scheduleEditorAutoSave(): void {
        this._clearEditorSaveTimer();
        this._editorSaveTimer = window.setTimeout(() => {
            this._saveEditorContent();
        }, EDITOR_AUTO_SAVE_DELAY);
    }

    private _clearEditorSaveTimer(): void {
        if (this._editorSaveTimer !== null) {
            window.clearTimeout(this._editorSaveTimer);
            this._editorSaveTimer = null;
        }
    }

    private _editorSaveError: string | null = null;

    private async _saveEditorContent(): Promise<void> {
        console.log('[editor-save] _saveEditorContent called');
        const editor = this._editorInstance;
        const filePath = this._editorFilePath;
        if (!editor || !filePath) {
            console.log('[editor-save] _saveEditorContent: no editor or path');
            return;
        }
        if (this._editorSaving) {
            console.log('[editor-save] _saveEditorContent: already saving, skip');
            return;
        }

        this._clearEditorSaveTimer();
        this._editorSaving = true;
        this._editorSaveError = null;
        this._updateEditorStatus();

        try {
            const content = editor.getValue();
            console.log('[editor-save] _saveEditorContent: writing', filePath, 'length:', content.length);
            await (window as any).fsAPI.writeTextFile(filePath, content);
            console.log('[editor-save] _saveEditorContent: write success');
            if (this._editorFilePath === filePath) {
                this._editorDirty = false;
            }
            this.softRefresh();
        } catch (err: any) {
            console.error('[editor-save] _saveEditorContent failed:', filePath, err);
            this._editorSaveError = err?.message || String(err);
        } finally {
            this._editorSaving = false;
            this._updateEditorStatus();
        }
    }

    private _closeEditor(): void {
        if (this._editorDirty) {
            // 如果有未保存的更改，先保存
            this._saveEditorContent().then(() => {
                this._destroyEditorOverlay();
            });
        } else {
            this._destroyEditorOverlay();
        }
    }

    /**
     * 仅清理编辑器实例和 overlay DOM，不做任何布局恢复。
     */
    private _teardownEditorInstance(): void {
        this._clearEditorSaveTimer();
        if (this._editorInstance) {
            this._editorInstance.dispose();
            this._editorInstance = null;
        }
        if (this._editorOverlay) {
            const updateFn = (this._editorOverlay as any)._updatePosition;
            if (updateFn) window.removeEventListener('resize', updateFn);
            this._editorOverlay.remove();
            this._editorOverlay = null;
        }
        if (this._editorResizeObserver) {
            this._editorResizeObserver.disconnect();
            this._editorResizeObserver = null;
        }
    }

    private _destroyEditorOverlay(): void {
        this._teardownEditorInstance();
        this._editorMode = false;
        this._editorFilePath = null;
        this._editorDirty = false;
        this._editorSaving = false;
        // 退出预览最大化并重新渲染
        if (this._previewFullscreen) {
            this._previewFullscreen = false;
            this._renderPanel();
        } else {
            this._renderPreview();
        }
    }

    private _getMonacoLanguage(filePath: string): string {
        const ext = filePath.split('.').pop()?.toLowerCase() || '';
        const langMap: Record<string, string> = {
            js: 'javascript',
            mjs: 'javascript',
            cjs: 'javascript',
            jsx: 'javascript',
            ts: 'typescript',
            tsx: 'typescript',
            mts: 'typescript',
            cts: 'typescript',
            json: 'json',
            jsonc: 'json',
            html: 'html',
            htm: 'html',
            css: 'css',
            scss: 'scss',
            less: 'less',
            md: 'markdown',
            markdown: 'markdown',
            py: 'python',
            rb: 'ruby',
            go: 'go',
            rs: 'rust',
            java: 'java',
            kt: 'kotlin',
            kts: 'kotlin',
            swift: 'swift',
            c: 'c',
            h: 'c',
            cpp: 'cpp',
            cc: 'cpp',
            cxx: 'cpp',
            hpp: 'cpp',
            cs: 'csharp',
            sh: 'shell',
            bash: 'shell',
            zsh: 'shell',
            sql: 'sql',
            yaml: 'yaml',
            yml: 'yaml',
            xml: 'xml',
            svg: 'xml',
            toml: 'ini',
            ini: 'ini',
            dockerfile: 'dockerfile',
            makefile: 'makefile',
            r: 'r',
            lua: 'lua',
            php: 'php',
            perl: 'perl',
            pl: 'perl',
            vue: 'html',
            graphql: 'graphql',
            gql: 'graphql'
        };
        return langMap[ext] || 'plaintext';
    }

    // ----- Preview HTML -----

    private _renderPreview(animate: boolean = false): void {
        const rn = this._rootNode;
        if (!rn) return;
        const el = rn.querySelector<HTMLElement>('[data-preview-root]');
        if (!el) return;
        el.innerHTML = this._renderPreviewHtml();
        el.classList.toggle('ws-preview--collapsed', !this._selectedFile);
        el.classList.toggle('ws-preview--unsupported', this._isPreviewUnsupported());

        // 首次展开时触发动画
        if (animate && this._selectedFile) {
            el.classList.add('ws-preview--animating');
            // 动画结束后移除 class
            el.addEventListener(
                'animationend',
                () => {
                    el.classList.remove('ws-preview--animating');
                },
                { once: true }
            );
        }

        this._attachMarkdownShadow(el);
        this._attachHtmlPreview(el);
        this._attachCodeHighlight(el);
    }

    private _attachCodeHighlight(root: ParentNode): void {
        const host = root.querySelector<HTMLElement>('.ws-preview-code-host');
        if (!host || host.dataset.attached) return;
        if (this._previewState.status !== 'idle' || !this._previewState.data?.content) return;
        host.dataset.attached = '1';

        const lang = host.dataset.lang || 'plaintext';
        const content = this._previewState.data.content;

        monaco.editor
            .colorize(content, lang, { tabSize: 4 })
            .then((html) => {
                host.innerHTML = `<div class="ws-preview-code-container">${html}</div>`;
            })
            .catch(() => {
                host.innerHTML = `<pre class="ws-preview-pre">${escapeHtml(content)}</pre>`;
            });
    }

    private _isPreviewUnsupported(): boolean {
        if (this._previewState.status !== 'idle' || !this._previewState.data) return false;
        const d = this._previewState.data;
        return d.tooLarge || d.binary;
    }

    private _attachHtmlPreview(root: ParentNode): void {
        if (
            !this._selectedFile ||
            !isHtmlFile(this._selectedFile) ||
            this._previewState.status !== 'idle' ||
            !this._previewState.data?.content
        ) {
            return;
        }
        const host = root.querySelector<HTMLElement>('.ws-preview-html-host');
        if (!host || host.dataset.attached) return;
        host.dataset.attached = '1';

        const dirPath = this._selectedFile.replace(/[^/\\]+$/, '');
        const baseHref = `file://${dirPath}`;

        const iframe = document.createElement('iframe');
        iframe.sandbox.add('allow-same-origin');
        iframe.style.cssText = 'width:100%;height:100%;border:none;display:block;background:#fff;';

        const content = this._previewState.data.content;
        const hasBase = /<base\s/i.test(content);
        const baseTag = hasBase ? '' : `<base href="${baseHref}">`;
        const headInsert = baseTag;

        let srcdoc: string;
        if (/<head[\s>]/i.test(content)) {
            srcdoc = content.replace(/(<head[^>]*>)/i, `$1${headInsert}`);
        } else if (/<html[\s>]/i.test(content)) {
            srcdoc = content.replace(/(<html[^>]*>)/i, `$1<head>${headInsert}</head>`);
        } else {
            srcdoc = `<!DOCTYPE html><html><head>${headInsert}</head><body>${content}</body></html>`;
        }

        iframe.srcdoc = srcdoc;
        host.style.cssText = 'width:100%;height:100%;overflow:hidden;';
        host.appendChild(iframe);
    }

    private _renderPreviewHtml(): string {
        // 编辑器模式下只渲染占位元素（编辑器 overlay 会覆盖此区域）
        if (this._editorMode) {
            return '<div class="ws-preview-body" style="flex:1;"></div>';
        }
        if (!this._selectedFile) {
            return `
            <div class="ws-preview-empty">
                <i class="fas fa-eye"></i>
                <span>点击文件以在此预览</span>
            </div>`;
        }
        const name = this._selectedFile.split('/').pop() || this._selectedFile;
        const canEdit = this._previewState.data && !this._previewState.data.binary;
        const header = `
        <div class="ws-preview-header">
            <i class="fas fa-file-lines"></i>
            <span class="ws-preview-name" title="${escapeHtml(this._selectedFile)}">${escapeHtml(name)}</span>
            ${
                this._previewState.data
                    ? `<span class="ws-preview-size">${escapeHtml(formatBytes(this._previewState.data.size))}</span>`
                    : ''
            }
            ${canEdit ? `<button class="ws-fullscreen-btn" title="编辑文件" data-action="open-editor"><i class="fas fa-pen-to-square"></i></button>` : ''}
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
            } else if (this._selectedFile && isHtmlFile(this._selectedFile)) {
                bodyHtml = `<div class="ws-preview-html-host"></div>`;
            } else if (this._selectedFile && getCodeLanguage(this._selectedFile)) {
                bodyHtml = `<div class="ws-preview-body ws-preview-code-host" data-lang="${getCodeLanguage(this._selectedFile)}"></div>`;
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
