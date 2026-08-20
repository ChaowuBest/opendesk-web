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
import { showImageLightbox } from './imageLightbox.js';
import { createRendererTranslator } from '../locale';
import { marked } from 'marked';
import { cjkAutolinkFix } from '../../common/markdown/cjk-autolink-fix.js';
import 'ace-builds/css/ace.css';
import aceCss from 'ace-builds/css/ace.css?inline';
import type { Ace as AceLib } from 'ace-builds';
import { escapeHtml } from '../../common/utils/escape.js';
import {
    OPENDESK_OFFICE_DOCUMENT_READY_CHANNEL,
    OPENDESK_OFFICE_EDITOR_VISIBLE_CHANNEL
} from '@bitclub.ai/opendesk-office/host-events';
import type { WorkspaceFocusLayoutState } from './workspaceFocusLayout.js';
import type { AgentInputRequest } from '../input/agentInputRequest.js';
import { createSlidesSelectionInputRequest } from '../applications/office/slidesSelectionInput.js';

const t = createRendererTranslator();

marked.use(cjkAutolinkFix);

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
    dataUri?: string;
}

type ChildrenCache = FSEntry[] | 'loading' | { error: string };
type ViewMode = 'tree' | 'grid';

// Ace 文本预览和编辑的单文件体积上限。
const ACE_TEXT_MAX_BYTES = 10 * 1024 * 1024;

// ============================================================================
// Utilities
// ============================================================================

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
        case 'pptx':
            return 'fa-file-powerpoint';
        case 'docx':
            return 'fa-file-word';
        case 'xlsx':
            return 'fa-file-excel';
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

type OfficeEditorKind = 'slides' | 'word' | 'sheets';

interface OfficeEditorConfig {
    kind: OfficeEditorKind;
    extension: string;
    rendererPage: string;
    iconClass: string;
    titleKey: string;
    unavailableKey: string;
}

const OFFICE_EDITOR_CONFIGS: readonly OfficeEditorConfig[] = [
    {
        kind: 'slides',
        extension: '.pptx',
        rendererPage: 'slides_editor.html',
        iconClass: 'fa-file-powerpoint',
        titleKey: 'renderer.fileExplorer.pptx.editor',
        unavailableKey: 'renderer.fileExplorer.pptx.unavailable'
    },
    {
        kind: 'word',
        extension: '.docx',
        rendererPage: 'word_editor.html',
        iconClass: 'fa-file-word',
        titleKey: 'renderer.fileExplorer.word.editor',
        unavailableKey: 'renderer.fileExplorer.word.unavailable'
    },
    {
        kind: 'sheets',
        extension: '.xlsx',
        rendererPage: 'sheets_editor.html',
        iconClass: 'fa-file-excel',
        titleKey: 'renderer.fileExplorer.xlsx.editor',
        unavailableKey: 'renderer.fileExplorer.xlsx.unavailable'
    }
];

function getOfficeEditorConfig(filePath: string): OfficeEditorConfig | undefined {
    const normalizedPath = filePath.toLowerCase();
    return OFFICE_EDITOR_CONFIGS.find(({ extension }) => normalizedPath.endsWith(extension));
}

function isOfficeDocument(filePath: string): boolean {
    return getOfficeEditorConfig(filePath) !== undefined;
}

function renderOfficeEditorLoadingIndicator(): string {
    return `
        <div class="ws-office-editor-loading-indicator" role="status" aria-live="polite">
            <span class="ws-office-editor-loading-spinner" aria-hidden="true"></span>
            <span class="ws-office-editor-loading-text">${escapeHtml(t('renderer.fileExplorer.preview.loadingEditor'))}</span>
        </div>`;
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
            font-size: var(--fs-md);
            color: #334155;
            font-weight: 500;
        }
        .ws-path-icon {
            color: #64748b;
            font-size: var(--fs-sm);
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
            font-size: var(--fs-sm);
            transition: background 0.15s, color 0.15s, box-shadow 0.15s;
            white-space: nowrap;
        }
        .ws-view-btn i {
            font-size: var(--fs-xs);
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
            font-size: var(--fs-sm);
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
        .ws-tree { flex: 1; overflow: auto; padding: 4px 0; font-size: var(--fs-md); }
        .ws-tree-row {
            display: flex; align-items: center; gap: 4px;
            padding: 3px 12px 3px 10px; cursor: pointer; user-select: none;
            border-radius: 0; margin: 0; color: #1f2937; line-height: 1.5;
        }
        .ws-tree-row:hover { background: #f3f4f6; }
        .ws-tree-row.ws-file-selected { background: #e0edff; }
        .ws-tree-caret { width: 10px; color: #9ca3af; font-size: var(--fs-2xs); flex-shrink: 0; text-align: center; }
        .ws-tree-icon { flex-shrink: 0; font-size: var(--fs-md); }
        .ws-tree-icon-dir { color: #f59e0b; }
        .ws-tree-icon-file { color: #94a3b8; }
        .ws-tree-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .ws-tree-size { font-size: var(--fs-xs); color: #9ca3af; flex-shrink: 0; font-variant-numeric: tabular-nums; }
        .ws-tree-loading, .ws-tree-empty, .ws-tree-error {
            display: flex; align-items: center; gap: 6px; padding: 4px 12px; font-size: var(--fs-sm); color: #9ca3af;
        }
        .ws-tree-error { color: #b91c1c; }

        /* Grid view */
        .ws-grid { flex: 1; display: flex; flex-direction: column; min-height: 0; }
        .ws-crumb {
            display: flex; flex-wrap: wrap; align-items: center; gap: 2px;
            padding: 6px 12px; border-bottom: 1px solid #e5e7eb; font-size: var(--fs-sm);
            color: #6b7280; background: #f9fafb;
        }
        .ws-crumb-seg {
            background: transparent; border: none; padding: 2px 6px;
            border-radius: 4px; cursor: pointer; color: #6b7280; font-size: var(--fs-sm);
        }
        .ws-crumb-seg:hover { background: #f3f4f6; color: #1f2937; }
        .ws-crumb-seg-current { color: #1f2937; font-weight: 500; }
        .ws-crumb-sep { font-size: var(--fs-2xs); color: #cbd5e1; }

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
            font-size: var(--fs-sm); color: #1f2937; width: 100%;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.3;
        }
        .ws-grid-size { font-size: var(--fs-2xs); color: #9ca3af; font-variant-numeric: tabular-nums; }
        .ws-grid-loading, .ws-grid-error, .ws-grid-empty {
            display: flex; align-items: center; justify-content: center;
            gap: 6px; padding: 20px; font-size: var(--fs-sm); color: #9ca3af; grid-column: 1 / -1;
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
            gap: 6px; padding: 10px 12px; font-size: var(--fs-sm); color: #9ca3af;
        }
        .ws-preview-header {
            display: flex; align-items: center; gap: 6px;
            padding: 6px 12px; background: #f9fafb; border-bottom: 1px solid #e5e7eb;
            font-size: var(--fs-md); color: #334155; flex-shrink: 0;
        }
        .ws-preview-header > i { color: #64748b; font-size: var(--fs-sm); }
        .ws-preview-name {
            flex: 1; min-width: 0; overflow: hidden;
            text-overflow: ellipsis; white-space: nowrap; font-weight: 500;
        }
        .ws-breadcrumb {
            flex: 1; min-width: 0; overflow: hidden;
            display: flex; align-items: center; gap: 1px;
            font-size: var(--fs-sm); font-weight: 500;
        }
        .ws-breadcrumb-item {
            padding: 2px 4px; border-radius: 4px; cursor: pointer;
            white-space: nowrap; color: #64748b;
            transition: background 0.15s, color 0.15s;
            flex-shrink: 0;
        }
        .ws-breadcrumb-item:hover { background: #f1f3f6; color: #1f2937; }
        .ws-breadcrumb-current { color: #1f2937; }
        .ws-breadcrumb-sep {
            color: #9ca3af; font-size: 8px; flex-shrink: 0; padding: 0 1px;
        }
        .ws-mode-tag {
            flex-shrink: 0; font-size: 11px;
            padding: 1px 7px; border-radius: 3px;
            font-weight: 500; line-height: 1.6;
        }
        .ws-mode-readonly {
            color: #6b7280; background: #f3f4f6;
            border: 1px solid #e5e7eb;
        }
        .ws-mode-edit {
            color: #b45309; background: #fffbeb;
            border: 1px solid #fde68a;
        }
        .ws-preview-size { font-size: var(--fs-xs); color: #9ca3af; font-variant-numeric: tabular-nums; flex-shrink: 0; }
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
            font-size: var(--fs-sm); line-height: 1.55; color: #1f2937; white-space: pre; min-width: max-content;
        }
        .ws-preview-info {
            display: flex; align-items: flex-start; gap: 8px;
            padding: 12px 14px; font-size: var(--fs-md); color: #475569;
        }
        .ws-preview-info > i { font-size: var(--fs-lg); color: #64748b; margin-top: 2px; }
        .ws-preview-hint { font-size: var(--fs-sm); color: #94a3b8; margin-top: 2px; }
        .ws-office-editor-host { position: relative; flex: 1; min-height: 0; overflow: hidden; background: #e9edf3; }
        .ws-office-editor-loading { background: #ffffff; }
        .ws-office-editor-loading-indicator {
            position: absolute; inset: 0; z-index: 1;
            display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px;
            box-sizing: border-box;
            background: #ffffff;
            color: #6b7280;
        }
        .ws-office-editor-loading-spinner {
            width: 28px; height: 28px; box-sizing: border-box;
            border: 2px solid rgba(222, 68, 51, 0.18);
            border-top-color: var(--brand-red, #DE4433);
            border-radius: 50%;
            animation: ws-office-editor-loading-spin 0.8s linear infinite;
        }
        .ws-office-editor-loading-text {
            font-size: var(--fs-sm, 13px); line-height: 1.4; font-weight: 400;
            letter-spacing: 0.02em;
        }
        @keyframes ws-office-editor-loading-spin {
            to { transform: rotate(360deg); }
        }
        .ws-office-editor-frame {
            position: absolute; inset: 0; display: flex;
            width: 100%; height: 100%; border: 0; background: #ffffff;
        }
        .ws-office-editor-frame--loading { visibility: hidden; }
        .ws-editor-host {
            flex: 1;
            display: flex;
            flex-direction: column;
            min-height: 0;
        }
        .ws-editor-toolbar {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 6px 10px;
            background: #f9fafb;
            border-bottom: 1px solid #e5e7eb;
            flex-shrink: 0;
        }
        .ws-editor-filename {
            flex: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            color: #334155;
            font-size: var(--fs-md);
            font-weight: 500;
        }
        .ws-editor-status {
            color: #858585;
            font-size: var(--fs-sm);
            flex-shrink: 0;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .ws-editor-save-btn {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 2px 8px;
            border: none;
            border-radius: 4px;
            background: #0e639c;
            color: #ffffff;
            font-size: var(--fs-sm);
            cursor: pointer;
            flex-shrink: 0;
            transition: background 0.15s;
        }
        .ws-editor-save-btn:hover { background: #1177bb; }
        .ws-editor-save-btn[data-disabled='1'] { display: none; }
        .ws-editor-container {
            flex: 1;
            min-height: 60px;
            min-width: 0;
            font-family: 'Maple Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            font-size: var(--fs-base);
        }
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
            font-size: var(--fs-sm); line-height: 1.55; white-space: pre; min-width: max-content;
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

        .ws-preview-svg-host {
            flex: 1; overflow: auto; min-height: 60px;
            display: flex; align-items: center; justify-content: center;
            background: repeating-conic-gradient(#f0f0f0 0% 25%, transparent 0% 50%) 50% / 20px 20px;
        }
        .ws-preview-svg-host img {
            max-width: 100%; max-height: 100%; object-fit: contain;
        }

        /* Fullscreen toggle button (shared style for browser & preview) */
        .ws-fullscreen-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            height: 22px;
            padding: 0 4px;
            background: transparent; border: none; border-radius: 4px;
            cursor: pointer; color: #9ca3af; font-size: var(--fs-xs);
            transition: color 0.15s, background 0.15s;
            flex-shrink: 0;
        }
        .ws-fullscreen-btn:hover { color: #374151; background: #f1f3f6; }
        .ws-preview-close {
            height: 22px; display: inline-flex; align-items: center; justify-content: center;
            padding: 0 4px;
            background: transparent; border: none; border-radius: 4px; color: #6b7280; cursor: pointer; font-size: var(--fs-sm);
        }
        .ws-preview-close:hover { background: #f3f4f6; color: #1f2937; }
        .ws-btn-label {
            max-width: 0; opacity: 0; overflow: hidden; white-space: nowrap;
            margin-left: 0; transition: max-width 0.25s ease, opacity 0.2s ease, margin-left 0.25s ease;
        }
        .ws-fullscreen-btn:hover .ws-btn-label,
        .ws-preview-close:hover .ws-btn-label {
            max-width: 60px; opacity: 1; margin-left: 4px;
        }

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
        :host([data-theme="dark"]) .ws-editor-host { background: #1e1e1e !important; }
        :host([data-theme="dark"]) .ws-editor-toolbar {
            background: #252526 !important;
            border-bottom-color: rgba(255, 255, 255, 0.12) !important;
        }
        :host([data-theme="dark"]) .ws-editor-filename { color: #cccccc !important; }
        :host([data-theme="dark"]) .ws-breadcrumb-item { color: #787878; }
        :host([data-theme="dark"]) .ws-breadcrumb-item:hover { background: #333333; color: #cccccc; }
        :host([data-theme="dark"]) .ws-breadcrumb-current { color: #cccccc; }
        :host([data-theme="dark"]) .ws-breadcrumb-sep { color: #555555; }
        :host([data-theme="dark"]) .ws-mode-readonly { color: #9ca3af; background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.1); }
        :host([data-theme="dark"]) .ws-mode-edit { color: #fbbf24; background: rgba(251,191,36,0.1); border-color: rgba(251,191,36,0.25); }
        :host([data-theme="dark"]) .ws-editor-status { color: #cccccc !important; }
        :host([data-theme="dark"]) .ws-editor-save-btn { background: #2563eb !important; }
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

export function isHtmlFile(filePath: string): boolean {
    const ext = filePath.split('.').pop()?.toLowerCase();
    return ext === 'html' || ext === 'htm';
}

function isSvgFile(filePath: string): boolean {
    const ext = filePath.split('.').pop()?.toLowerCase();
    return ext === 'svg';
}

const IMAGE_FILE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'apng']);

function isImageFile(filePath: string): boolean {
    const ext = filePath.split('.').pop()?.toLowerCase();
    return ext !== undefined && IMAGE_FILE_EXTENSIONS.has(ext);
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
    gql: 'graphql',
    md: 'markdown',
    markdown: 'markdown'
};

type AceMode =
    | 'text'
    | 'html'
    | 'javascript'
    | 'typescript'
    | 'json'
    | 'css'
    | 'scss'
    | 'less'
    | 'python'
    | 'ruby'
    | 'go'
    | 'rust'
    | 'java'
    | 'kotlin'
    | 'swift'
    | 'c_cpp'
    | 'csharp'
    | 'sh'
    | 'sql'
    | 'yaml'
    | 'xml'
    | 'ini'
    | 'dockerfile'
    | 'makefile'
    | 'r'
    | 'lua'
    | 'php'
    | 'perl'
    | 'graphql'
    | 'markdown';

type AceEditorMode = typeof import('ace-builds/src-noconflict/ace.js');
type AceEditorInstance = AceLib.Editor;

const ACE_MODE_LOADERS: Record<NonNullable<AceMode>, () => Promise<unknown>> = {
    javascript: () => import('ace-builds/src-noconflict/mode-javascript.js'),
    typescript: () => import('ace-builds/src-noconflict/mode-typescript.js'),
    json: () => import('ace-builds/src-noconflict/mode-json.js'),
    css: () => import('ace-builds/src-noconflict/mode-css.js'),
    scss: () => import('ace-builds/src-noconflict/mode-scss.js'),
    less: () => import('ace-builds/src-noconflict/mode-less.js'),
    python: () => import('ace-builds/src-noconflict/mode-python.js'),
    ruby: () => import('ace-builds/src-noconflict/mode-ruby.js'),
    go: () => import('ace-builds/src-noconflict/mode-golang.js'),
    rust: () => import('ace-builds/src-noconflict/mode-rust.js'),
    java: () => import('ace-builds/src-noconflict/mode-java.js'),
    kotlin: () => import('ace-builds/src-noconflict/mode-kotlin.js'),
    swift: () => import('ace-builds/src-noconflict/mode-swift.js'),
    c_cpp: () => import('ace-builds/src-noconflict/mode-c_cpp.js'),
    csharp: () => import('ace-builds/src-noconflict/mode-csharp.js'),
    sh: () => import('ace-builds/src-noconflict/mode-sh.js'),
    sql: () => import('ace-builds/src-noconflict/mode-sql.js'),
    yaml: () => import('ace-builds/src-noconflict/mode-yaml.js'),
    xml: () => import('ace-builds/src-noconflict/mode-xml.js'),
    ini: () => import('ace-builds/src-noconflict/mode-ini.js'),
    dockerfile: () => import('ace-builds/src-noconflict/mode-dockerfile.js'),
    makefile: () => import('ace-builds/src-noconflict/mode-makefile.js'),
    r: () => import('ace-builds/src-noconflict/mode-r.js'),
    lua: () => import('ace-builds/src-noconflict/mode-lua.js'),
    php: () => import('ace-builds/src-noconflict/mode-php.js'),
    perl: () => import('ace-builds/src-noconflict/mode-perl.js'),
    graphql: () => import('ace-builds/src-noconflict/mode-graphqlschema.js'),
    markdown: () => import('ace-builds/src-noconflict/mode-markdown.js'),
    html: () => import('ace-builds/src-noconflict/mode-html.js'),
    text: () => Promise.resolve()
};

const ACE_THEME_LOADERS: Record<'clouds' | 'dracula', () => Promise<unknown>> = {
    clouds: () => import('ace-builds/src-noconflict/theme-clouds.js'),
    dracula: () => import('ace-builds/src-noconflict/theme-dracula.js')
};

// 编辑器自动保存延迟（毫秒）
const EDITOR_AUTO_SAVE_DELAY = 1500;

// 与 ws-preview-pre 保持一致的字体栈
const PREVIEW_FONT_FAMILY = "'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace";

type AceEditorStatus = 'idle' | 'unsaved' | 'saving' | 'saved' | 'error';

function getCodeLanguage(filePath: string): string | null {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    return CODE_FILE_EXTENSIONS[ext] || null;
}

function resolveAceMode(filePath: string): AceMode {
    const fileName = filePath.split('/').pop()?.toLowerCase() || '';
    const baseName = fileName;
    if (baseName === 'makefile' || baseName === 'dockerfile') {
        return baseName === 'makefile' ? 'makefile' : 'dockerfile';
    }
    if (baseName === 'readme.md' || baseName === 'readme') {
        return 'markdown';
    }
    const codeLang = getCodeLanguage(filePath);
    if (!codeLang) return 'text';

    if (codeLang === 'shell' || codeLang === 'bash' || codeLang === 'zsh') return 'sh';
    if (
        codeLang === 'c' ||
        codeLang === 'cpp' ||
        codeLang === 'h' ||
        codeLang === 'hpp' ||
        codeLang === 'cc' ||
        codeLang === 'cxx'
    ) {
        return 'c_cpp';
    }
    if (codeLang === 'csharp') return 'csharp';

    return codeLang as AceMode;
}

function resolveThemeName(): 'clouds' | 'dracula' {
    const themeToken = document.documentElement.dataset.theme;
    return themeToken === 'dark' ? 'dracula' : 'clouds';
}

/**
 * 判断文件是否应在预览时直接使用 Ace editor（只读模式）。
 * 排除有专属渲染预览的文件类型（markdown/html/svg/image/office 文档），
 * 其余文本文件（含 .txt/.log 等无语言模式的）均使用 Ace editor。
 */
function shouldUseAcePreview(filePath: string): boolean {
    if (isOfficeDocument(filePath)) return false;
    if (isHtmlFile(filePath)) return false;
    if (isSvgFile(filePath)) return false;
    if (isMarkdownFile(filePath)) return false;
    if (isImageFile(filePath)) return false;
    return true;
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
        font-size: var(--fs-md);
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
        overflow-x: auto; font-size: var(--fs-sm); line-height: 1.5;
    }
    .markdown-body pre code { padding: 0; background: none; border-radius: 0; font-size: inherit; }
    .markdown-body table {
        font-size: var(--fs-sm); margin: 0.5em 0; width: 100%;
        border-collapse: collapse; border: 1px solid var(--od-md-table-border, #e2e8f0); border-radius: 12px;
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
    private _taskWorkspace: string | null = null;
    private _workspaceRequested = false;
    private _workspaceError: string | null = null;
    private _viewMode: ViewMode = 'tree';
    private _expandedPaths: Set<string> = new Set();
    private _childrenCache: Map<string, ChildrenCache> = new Map();
    private _gridPath: string | null = null;
    private _selectedFile: string | null = null;
    private _editorMode = false;
    private _editorReadOnly = false;
    private _editorFilePath: string | null = null;
    private _editorInstance: AceEditorInstance | null = null;
    private _editorDirty = false;
    private _editorStatus: AceEditorStatus = 'idle';
    private _editorChangeHandler: (() => void) | null = null;
    private _editorSaving = false;
    private _editorPendingSave = false;
    private _editorSaveError: string | null = null;
    private _editorSaveTimer: number | null = null;
    private _editorResizeObserver: ResizeObserver | null = null;
    private _editorOpenLine: number | null = null;
    private _currentLoadSeq = 0;
    private _aceLib: AceEditorMode | null = null;
    private _loadedAceModes = new Set<string>();
    private _loadedAceThemes = new Set<string>();
    private _loadedThemeData = new Map<string, { cssText: string; cssClass: string }>();
    private _previewState: { status: 'idle' | 'loading' | 'error'; error?: string; data?: PreviewPayload } = {
        status: 'idle'
    };
    private _browserFullscreen = false;
    private _previewFullscreen = false;
    private _officeClosePending = false;
    private _officeCloseApproved = false;
    private _taskId: string | null = null;

    /** 在浏览器中打开文件的回调（由宿主组件设置） */
    onOpenInBrowser: ((filePath: string) => void) | null = null;
    /** 聚焦内容的工作区布局变化回调（由 task-artifacts 协调外层布局） */
    onWorkspaceFocusLayoutChange: ((state: WorkspaceFocusLayoutState) => void) | null = null;
    onAgentInputRequest: ((request: AgentInputRequest) => void) | null = null;

    setTaskId(taskId: string): void {
        this._taskId = taskId;
    }

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
     * @param workspace 可选的任务级工作空间路径，传入后优先使用而非全局 default_workspace
     */
    refresh(workspace?: string): void {
        if (this._deferUntilOfficeCanClose(() => this.refresh(workspace))) return;
        // 切换任务/工作空间时先关闭预览
        this._dismissBreadcrumbDropdown();
        this._selectedFile = null;
        this._previewState = { status: 'idle' };
        this._browserFullscreen = false;
        this._previewFullscreen = false;
        this._editorMode = false;
        this._editorReadOnly = false;
        this._editorFilePath = null;
        this._editorOpenLine = null;
        this._editorDirty = false;
        this._editorStatus = 'idle';
        this._destroyEditorInstance();
        this._taskWorkspace = workspace ?? null;
        this._workspaceRequested = false;
        this._workspaceRoot = null;
        this._workspaceError = null;
        this._expandedPaths.clear();
        this._childrenCache.clear();
        this._gridPath = null;
        this._selectedFile = null;
        this._previewState = { status: 'idle' };
        this._notifyWorkspaceFocusLayoutChange();
        if (this._container) {
            void this._ensureWorkspaceLoaded();
        }
    }

    /**
     * 关闭预览（供外部调用，如侧边栏收起时）。
     */
    closeEditor(): void {
        if (this._deferUntilOfficeCanClose(() => this.closeEditor())) return;
        void this._saveEditorIfNeeded();
        this._destroyEditorInstance();
        this._dismissBreadcrumbDropdown();
        this._selectedFile = null;
        this._editorMode = false;
        this._editorReadOnly = false;
        this._editorFilePath = null;
        this._editorOpenLine = null;
        this._editorDirty = false;
        this._editorStatus = 'idle';
        this._editorSaving = false;
        this._editorPendingSave = false;
        this._previewState = { status: 'idle' };
        this._previewFullscreen = false;
        this._browserFullscreen = false;
        this._notifyWorkspaceFocusLayoutChange();
        const rn = this._rootNode;
        if (rn) {
            rn.querySelectorAll<HTMLElement>('.ws-file-selected').forEach((el) => {
                el.classList.remove('ws-file-selected');
            });
        }
        this._renderPanel();
    }

    /**
     * 编辑器是否处于打开状态。
     */
    isEditorOpen(): boolean {
        return this._editorMode && this._editorInstance !== null;
    }

    // ----- workspace loading -----

    private async _ensureWorkspaceLoaded(): Promise<void> {
        if (this._workspaceRequested) return;
        this._workspaceRequested = true;
        try {
            let root: string;
            // 优先使用任务级工作空间，否则使用全局工作空间
            if (this._taskWorkspace) {
                root = this._taskWorkspace;
            } else {
                const api = window.workspaceAPI;
                if (!api || typeof api.getEffectiveWorkspace !== 'function') {
                    this._workspaceError = t('renderer.fileExplorer.error.noWorkspaceApi');
                    this._renderPanel();
                    return;
                }
                root = await api.getEffectiveWorkspace();
            }
            if (!root) {
                this._workspaceError = t('renderer.fileExplorer.error.noWorkspacePath');
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
                throw new Error(t('renderer.fileExplorer.error.noListDir'));
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
        this._renderBrowserSection();
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
        this._renderBrowserSection();
        void this._loadChildren(dirPath);
    }

    /**
     * 选中并预览指定文件。
     * 可由外部调用（如工具卡片中的"查看文件"按钮）。
     */
    selectFile(filePath: string, line?: number, onSwitchBlocked?: () => void): void {
        if (this._selectedFile === filePath && isOfficeDocument(filePath)) return;
        if (
            this._deferUntilOfficeCanClose(
                () => this.selectFile(filePath, line, onSwitchBlocked),
                onSwitchBlocked
            )
        ) {
            return;
        }

        // HTML/HTM 文件在浏览器 tab 中打开，不在文件预览面板中渲染
        if (isHtmlFile(filePath)) {
            if (this._editorMode) {
                void this._saveEditorIfNeeded();
                this._destroyEditorInstance();
                this._editorMode = false;
                this._editorReadOnly = false;
                this._editorFilePath = null;
                this._editorDirty = false;
                this._editorStatus = 'idle';
            }
            this._selectedFile = null;
            this._previewState = { status: 'idle' };
            this._previewFullscreen = false;
            this._browserFullscreen = false;
            this._notifyWorkspaceFocusLayoutChange();
            const rn = this._rootNode;
            if (rn) {
                rn.querySelectorAll<HTMLElement>('.ws-file-selected').forEach((el) => {
                    el.classList.remove('ws-file-selected');
                });
            }
            this._renderPanel();
            this.onOpenInBrowser?.(filePath);
            return;
        }

        if (this._editorMode) {
            void this._saveEditorIfNeeded();
            this._destroyEditorInstance();
            this._editorMode = false;
            this._editorReadOnly = false;
            this._editorFilePath = null;
            this._editorDirty = false;
            this._editorStatus = 'idle';
        }
        // 检查当前是否为空状态（展开动画）
        const wasEmpty = !this._selectedFile;
        this._selectedFile = filePath;
        // 代码文件直接以 Ace editor 只读模式预览
        const useAcePreview = shouldUseAcePreview(filePath);
        if (useAcePreview) {
            this._editorMode = true;
            this._editorReadOnly = true;
            this._editorFilePath = filePath;
            this._editorDirty = false;
            this._editorStatus = 'idle';
            this._editorSaving = false;
            this._editorPendingSave = false;
            this._editorSaveError = null;
            this._editorOpenLine = line != null && line > 0 ? line : null;
        }
        this._previewState = { status: 'loading' };
        this._renderPreview(wasEmpty);
        this._notifyWorkspaceFocusLayoutChange();
        const rn = this._rootNode;
        if (rn) {
            rn.querySelectorAll<HTMLElement>('.ws-file-selected').forEach((el) => {
                el.classList.remove('ws-file-selected');
            });
            rn.querySelectorAll<HTMLElement>(`[data-file="${cssEscape(filePath)}"]`).forEach((el) => {
                el.classList.add('ws-file-selected');
            });
        }
        if (useAcePreview) {
            void this._loadFileForEditor(filePath);
        } else {
            void this._loadPreview(filePath);
        }
    }

    private _deferUntilOfficeCanClose(onApproved: () => void, onBlocked?: () => void): boolean {
        if (this._officeCloseApproved) {
            this._officeCloseApproved = false;
            return false;
        }
        if (!this._selectedFile) return false;
        const editorConfig = getOfficeEditorConfig(this._selectedFile);
        if (!editorConfig) return false;
        if (this._officeClosePending) return true;

        const webview = this._rootNode?.querySelector<HTMLElement>('.ws-office-editor-frame') as
            | (HTMLElement & { getWebContentsId?: () => number })
            | null;
        const webContentsId = webview?.getWebContentsId?.();
        if (!webContentsId || !window.officeHostAPI?.requestClose) return false;

        this._officeClosePending = true;
        void window.officeHostAPI
            .requestClose(editorConfig.kind, webContentsId)
            .then((canClose) => {
                if (!canClose) {
                    onBlocked?.();
                    return;
                }
                this._officeCloseApproved = true;
                onApproved();
            })
            .catch(() => onBlocked?.())
            .finally(() => {
                this._officeClosePending = false;
            });
        return true;
    }

    private async _loadPreview(filePath: string): Promise<void> {
        try {
            const editorConfig = getOfficeEditorConfig(filePath);
            if (editorConfig) {
                const fileSize = this._getCachedFileSize(filePath) ?? 0;
                const officeHostAPI = window.officeHostAPI;
                if (!officeHostAPI?.prepare) {
                    throw new Error(t(editorConfig.unavailableKey));
                }
                // 先让局部 loading 完成一次绘制，再启动 OpenDesk Office 冷初始化。
                await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
                if (this._selectedFile !== filePath) return;
                await officeHostAPI.prepare(editorConfig.kind);
                if (this._selectedFile !== filePath) return;
                this._previewState = {
                    status: 'idle',
                    data: { tooLarge: false, size: fileSize, limit: 0, content: '', binary: false }
                };
                this._previewFullscreen = true;
                this._notifyWorkspaceFocusLayoutChange();
                this._renderPreview();
                this._mountOfficeEditor(filePath, editorConfig);
                return;
            }
            const api = window.fsAPI;
            if (!api || typeof api.readTextFile !== 'function') {
                throw new Error(t('renderer.fileExplorer.error.noReadFile'));
            }
            const data = await api.readTextFile(filePath, 0);
            if (this._selectedFile !== filePath) return;
            this._previewState = { status: 'idle', data };
            // 可预览内容进入全屏（图片即使 binary 也可通过 dataUri 预览）
            const isImage = isImageFile(filePath);
            this._previewFullscreen = !data.binary || (isImage && !!data.dataUri);
            if (data.tooLarge) this._previewFullscreen = false;
            this._notifyWorkspaceFocusLayoutChange();
        } catch (err) {
            if (this._selectedFile !== filePath) return;
            this._previewState = { status: 'error', error: err instanceof Error ? err.message : String(err) };
            this._previewFullscreen = false;
            this._notifyWorkspaceFocusLayoutChange();
        }
        this._renderPreview();
        this._applyFullscreenLayout();
    }

    private _getCachedFileSize(filePath: string): number | undefined {
        for (const cached of this._childrenCache.values()) {
            if (!Array.isArray(cached)) continue;
            const entry = cached.find((candidate) => candidate.path === filePath && !candidate.isDirectory);
            if (entry) return entry.size;
        }
        return undefined;
    }

    // ----- context menu -----

    private _ctxMenuEl: HTMLElement | null = null;
    private _ctxDismissHandler: ((ev: MouseEvent) => void) | null = null;

    private _showContextMenu(ev: MouseEvent, filePath: string, isDirectory: boolean): void {
        ev.preventDefault();
        ev.stopPropagation();
        this._dismissContextMenu();

        const menu = document.createElement('div');
        menu.className = 'ctx-menu';
        menu.style.minWidth = '200px';

        const items: { icon: string; label: string; action: string; danger?: boolean }[] = [];
        if (!isDirectory) {
            items.push({ icon: 'fa-eye', label: t('renderer.fileExplorer.ctx.preview'), action: 'preview' });
            items.push({
                icon: 'fa-pen-to-square',
                label: t('renderer.fileExplorer.ctx.open', { name: filePath.split('/').pop() || '' }),
                action: 'edit'
            });
            const ext = filePath.split('.').pop()?.toLowerCase();
            if (ext === 'html' || ext === 'htm') {
                items.push({
                    icon: 'fa-globe',
                    label: t('renderer.fileExplorer.ctx.openInBrowser'),
                    action: 'open-in-browser'
                });
            }
        }
        items.push({
            icon: 'fa-arrow-up-right-from-square',
            label: t('renderer.fileExplorer.ctx.openDefault'),
            action: 'open-default'
        });
        items.push({ icon: 'fa-folder-open', label: t('renderer.fileExplorer.ctx.reveal'), action: 'reveal' });
        items.push({ icon: 'fa-link', label: t('renderer.fileExplorer.ctx.copyPath'), action: 'copy-path' });
        items.push({
            icon: 'fa-trash-can',
            label: t('renderer.fileExplorer.ctx.delete'),
            action: 'delete',
            danger: true
        });

        menu.innerHTML = items
            .map((it) => {
                const needSep = it.action === 'copy-path' || it.action === 'delete';
                const sep = needSep ? '<div class="ctx-divider"></div>' : '';
                const cls = it.danger ? 'ctx-item danger' : 'ctx-item';
                return (
                    `${sep}<button class="${cls}" data-ctx-action="${it.action}">` +
                    `<span class="ctx-icon-sm"><i class="fas ${it.icon}"></i></span>` +
                    `<span class="ctx-label">${it.label}</span></button>`
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
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = btn.dataset.ctxAction;
                this._dismissContextMenu();
                switch (action) {
                    case 'preview':
                        this.selectFile(filePath);
                        break;
                    case 'edit':
                        if (isOfficeDocument(filePath)) {
                            this.selectFile(filePath);
                        } else {
                            this.openEditor(filePath);
                        }
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
        const typeLabel = isDirectory
            ? t('renderer.fileExplorer.delete.folder')
            : t('renderer.fileExplorer.delete.file');

        const confirmed = await showConfirmModal({
            icon: 'fa-trash-can',
            iconBg: '#FEF2F2',
            iconColor: '#DC2626',
            title: t('renderer.fileExplorer.delete.title', { type: typeLabel }),
            message: t('renderer.fileExplorer.delete.confirm', { type: typeLabel, name: escapeHtml(name) }),
            confirmText: t('renderer.fileExplorer.delete.confirmBtn'),
            cancelText: t('renderer.fileExplorer.delete.cancel'),
            danger: true
        });
        if (!confirmed) return;

        try {
            const api = (window as any).fsAPI;
            if (!api || typeof api.trashItem !== 'function') {
                throw new Error(t('renderer.fileExplorer.error.noDelete'));
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
            window.alert(t('renderer.fileExplorer.delete.failed', { msg }));
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
                if (this._editorMode && !isOfficeDocument(p)) {
                    this.openEditor(p, undefined, this._editorReadOnly);
                } else {
                    this.selectFile(p);
                }
                break;
            case 'grid-dir':
                this._enterGridDir(p);
                break;
            case 'grid-file':
                if (this._editorMode && !isOfficeDocument(p)) {
                    this.openEditor(p, undefined, this._editorReadOnly);
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

    private _notifyWorkspaceFocusLayoutChange(): void {
        const active = this._previewFullscreen;
        this.onWorkspaceFocusLayoutChange?.({
            active,
            fullscreen: active
        });
    }

    private _applyFullscreenLayout(): void {
        const panel = this._container;
        if (!panel) return;

        const browser = panel.querySelector<HTMLElement>('.ws-browser');
        browser?.classList.toggle('ws-browser--fullscreen', this._browserFullscreen);
        browser?.classList.toggle('ws-browser--hidden', this._previewFullscreen);

        const preview = panel.querySelector<HTMLElement>('[data-preview-root]');
        preview?.classList.toggle('ws-preview--fullscreen', this._previewFullscreen);

        const browserIcon = panel.querySelector<HTMLElement>('[data-action="browser-fullscreen"] i');
        if (browserIcon) {
            browserIcon.className = `fas ${this._browserFullscreen ? 'fa-compress' : 'fa-expand'}`;
        }
    }

    private _renderBrowserSection(): void {
        const panel = this._container;
        const browserBody = panel?.querySelector<HTMLElement>('.ws-browser-body');
        if (!panel || !browserBody) return;
        panel.querySelectorAll<HTMLButtonElement>('.ws-view-btn').forEach((button) => {
            button.classList.toggle('ws-view-active', button.dataset.view === this._viewMode);
        });
        browserBody.innerHTML =
            this._viewMode === 'tree' ? this._renderTreeContainerHtml() : this._renderGridContainerHtml();
    }

    private _renderPanel(): void {
        const panel = this._container;
        if (!panel) return;

        if (this._workspaceError) {
            panel.innerHTML = `
            <div class="placeholder-content">
                <i class="fas fa-folder-open placeholder-icon"></i>
                <p>${t('renderer.fileExplorer.workspace.loadFailed')}</p>
                <p class="placeholder-hint">${escapeHtml(this._workspaceError)}</p>
            </div>`;
            return;
        }
        if (!this._workspaceRoot) {
            panel.innerHTML = `
            <div class="placeholder-content">
                <i class="fas fa-folder-open placeholder-icon"></i>
                <p>${t('renderer.fileExplorer.workspace.loading')}</p>
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
                    <button class="ws-refresh-btn" title="${t('renderer.fileExplorer.refresh')}" data-action="refresh">
                        <i class="fas fa-arrows-rotate"></i>
                    </button>
                    <button class="ws-fullscreen-btn" title="${t('renderer.fileExplorer.fullscreen')}" data-action="browser-fullscreen">
                        <i class="fas ${this._browserFullscreen ? 'fa-compress' : 'fa-expand'}"></i>
                    </button>
                    <div class="ws-view-switch" role="tablist" aria-label="${t('renderer.fileExplorer.viewMode')}">
                        <button class="ws-view-btn ${this._viewMode === 'tree' ? 'ws-view-active' : ''}"
                            data-view="tree" title="${t('renderer.fileExplorer.view.tree')}">
                            <i class="fas fa-list"></i>
                            <span>${t('renderer.fileExplorer.view.treeLabel')}</span>
                        </button>
                        <button class="ws-view-btn ${this._viewMode === 'grid' ? 'ws-view-active' : ''}"
                            data-view="grid" title="${t('renderer.fileExplorer.view.grid')}">
                            <i class="fas fa-grip"></i>
                            <span>${t('renderer.fileExplorer.view.gridLabel')}</span>
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
                this._applyFullscreenLayout();
                this._notifyWorkspaceFocusLayoutChange();
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
                        if (this._editorMode && this._editorReadOnly) {
                            this._toggleEditorReadOnly();
                        } else {
                            this.openEditor(this._selectedFile);
                        }
                    }
                    return;
                }
                if (target.closest('[data-action="editor-save"]')) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    void this._saveEditorContent();
                    return;
                }
                if (target.closest('[data-action="editor-preview"]')) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    if (this._selectedFile) {
                        if (shouldUseAcePreview(this._selectedFile)) {
                            void this._toggleEditorReadOnly();
                        } else {
                            this.selectFile(this._selectedFile);
                        }
                    }
                    return;
                }
                if (target.closest('[data-action="editor-close"]')) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    this.closeEditor();
                    return;
                }
                if (target.closest('[data-preview-close]')) {
                    this.closeEditor();
                    return;
                }
                const bcItem = target.closest<HTMLElement>('[data-breadcrumb-dir]');
                if (bcItem) {
                    ev.stopPropagation();
                    const dir = bcItem.dataset.breadcrumbDir;
                    if (dir) {
                        this._showBreadcrumbDropdown(dir, bcItem);
                    }
                    return;
                }
            });
        }

        this._attachMarkdownShadow(panel);
        this._attachHtmlPreview(panel);
        this._attachSvgPreview(panel);
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
                <span>${t('renderer.fileExplorer.loading')}</span>
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
            return `<div class="ws-tree-empty" style="padding-left:${depth * 14 + 10}px">${t('renderer.fileExplorer.emptyDir')}</div>`;
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
                <span>${t('renderer.fileExplorer.loading')}</span>
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
                        <div class="ws-grid-name">${t('renderer.fileExplorer.parentDir')}</div>
                    </div>`
                : '';
        if (entries.length === 0) {
            return `<div class="ws-grid-items">
                ${upButton}
                <div class="ws-grid-empty">${t('renderer.fileExplorer.emptyDir')}</div>
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

    // ----- file open / editor -----

    /**
     * 打开文件编辑器。
     */
    openEditor(filePath: string, line?: number, readOnly?: boolean): void {
        if (isOfficeDocument(filePath)) {
            this.selectFile(filePath);
            return;
        }
        if (this._deferUntilOfficeCanClose(() => this.openEditor(filePath, line, readOnly))) return;
        if (this._editorMode && this._editorFilePath === filePath && this._editorInstance) {
            // 已打开同一文件：若 readOnly 状态不同则切换
            if (this._editorReadOnly && !readOnly) {
                this._editorReadOnly = false;
                this._editorInstance.setReadOnly(false);
                const rn = this._rootNode;
                if (rn) {
                    const oldHeader = rn.querySelector('.ws-preview-header');
                    if (oldHeader) {
                        const temp = document.createElement('div');
                        temp.innerHTML = this._renderPreviewHtml();
                        const newHeader = temp.querySelector('.ws-preview-header');
                        if (newHeader) oldHeader.replaceWith(newHeader);
                    }
                }
                this._updateEditorStatus();
            }
            if (line != null && line > 0) {
                this._gotoEditorLine(line);
            }
            this._editorInstance.focus();
            return;
        }

        if (this._editorDirty && this._editorInstance && this._editorFilePath) {
            // 切换文件前异步保存当前未保存内容，避免阻塞操作流
            const oldInstance = this._editorInstance;
            const oldPath = this._editorFilePath;
            const content = oldInstance.getValue();
            const pendingSave = window.fsAPI?.writeTextFile?.(oldPath, content);
            if (pendingSave && typeof pendingSave.catch === 'function') {
                pendingSave.catch(() => {});
            }
            this._editorDirty = false;
        }

        this._destroyEditorInstance();

        this._editorMode = true;
        this._editorReadOnly = !!readOnly;
        this._editorFilePath = filePath;
        this._editorDirty = false;
        this._editorStatus = 'idle';
        this._editorSaving = false;
        this._editorPendingSave = false;
        this._editorSaveError = null;
        this._editorOpenLine = line != null && line > 0 ? line : null;
        const selected = filePath;
        this._selectedFile = selected;
        this._previewState = { status: 'loading' };
        this._notifyWorkspaceFocusLayoutChange();

        // 更新树中文件高亮
        const rn = this._rootNode;
        if (rn) {
            rn.querySelectorAll<HTMLElement>('.ws-file-selected').forEach((el) => {
                el.classList.remove('ws-file-selected');
            });
            rn.querySelectorAll<HTMLElement>(`[data-file="${cssEscape(filePath)}"]`).forEach((el) => {
                el.classList.add('ws-file-selected');
            });
        }

        this._renderPreview();
        void this._loadFileForEditor(filePath);
    }

    private async _resolveFilePath(filePath: string): Promise<string> {
        const api = window.fsAPI;
        if (api && typeof api.resolveFilePath === 'function') {
            return api.resolveFilePath(filePath);
        }
        return filePath;
    }

    private async _loadFileForEditor(filePath: string): Promise<void> {
        if (!this._editorMode || this._editorFilePath !== filePath) {
            return;
        }
        const seq = ++this._currentLoadSeq;
        try {
            const api = window.fsAPI;
            if (!api || typeof api.readTextFile !== 'function') {
                throw new Error(t('renderer.fileExplorer.error.noReadFile'));
            }
            const resolvedPath = await this._resolveFilePath(filePath);
            const data = await api.readTextFile(resolvedPath, ACE_TEXT_MAX_BYTES);
            if (this._editorMode === false || this._editorFilePath !== filePath || seq !== this._currentLoadSeq) {
                return;
            }
            if (data.binary || data.tooLarge) {
                this._editorMode = false;
                this._editorReadOnly = false;
                this._editorFilePath = null;
                this._previewState = { status: 'idle', data };
                this._previewFullscreen = false;
                this._notifyWorkspaceFocusLayoutChange();
                this._renderPreview();
                this._applyFullscreenLayout();
                return;
            }
            this._previewState = { status: 'idle', data };
            this._previewFullscreen = true;
            this._notifyWorkspaceFocusLayoutChange();
            this._renderPreview();
            this._applyFullscreenLayout();
            await this._initAceEditor(filePath, data.content, seq);
        } catch (err) {
            if (this._editorFilePath !== filePath || seq !== this._currentLoadSeq) {
                return;
            }
            this._previewState = {
                status: 'error',
                error: err instanceof Error ? err.message : String(err)
            };
            this._editorMode = false;
            this._editorReadOnly = false;
            this._editorFilePath = null;
            this._previewFullscreen = false;
            this._notifyWorkspaceFocusLayoutChange();
            this._renderPreview();
            this._applyFullscreenLayout();
        }
    }

    private _isCurrentEditorLoad(filePath: string, seq: number): boolean {
        return this._editorMode && this._editorFilePath === filePath && seq === this._currentLoadSeq;
    }

    private async _ensureAce(): Promise<AceEditorMode> {
        if (this._aceLib) {
            return this._aceLib;
        }
        const ace = await import('ace-builds/src-noconflict/ace.js');
        this._aceLib = ace as AceEditorMode;
        return this._aceLib;
    }

    private async _ensureAceMode(mode: AceMode): Promise<void> {
        if (mode === 'text') return;
        if (this._loadedAceModes.has(mode)) return;
        const loader = ACE_MODE_LOADERS[mode];
        if (!loader) return;
        await loader();
        this._loadedAceModes.add(mode);
    }

    private async _ensureAceTheme(theme: 'clouds' | 'dracula'): Promise<{ cssText: string; cssClass: string }> {
        const cached = this._loadedThemeData.get(theme);
        if (cached) return cached;
        const loader = ACE_THEME_LOADERS[theme];
        const mod = (await loader()) as unknown as { cssText: string; cssClass: string; isDark: boolean };
        this._loadedAceThemes.add(theme);
        const data = { cssText: mod.cssText, cssClass: mod.cssClass };
        this._loadedThemeData.set(theme, data);
        return data;
    }

    /**
     * 将 ace 结构 CSS 和主题 CSS 注入到 Shadow DOM 中。
     * 因为 ace editor 创建在 Shadow DOM 内部，全局 ace CSS 无法穿透 Shadow boundary。
     * 每次打开编辑器时调用，确保主题 CSS 与当前主题一致。
     */
    private _injectAceShadowStyles(themeCssText: string): void {
        const rn = this._rootNode;
        if (!rn) return;

        // 仅在 ShadowRoot 中需要注入（普通 Document 中全局 CSS 已生效）
        const isShadowRoot = rn.toString() === '[object ShadowRoot]';
        if (!isShadowRoot) return;

        // 移除之前注入的 ace 样式（主题可能已切换）
        const oldStyle = (rn as unknown as ParentNode).querySelector('#ace-shadow-styles');
        if (oldStyle) oldStyle.remove();

        const style = document.createElement('style');
        style.id = 'ace-shadow-styles';
        style.textContent =
            aceCss +
            '\n' +
            themeCssText +
            `\n.ace_editor, .ace_editor * { font-family: ${PREVIEW_FONT_FAMILY} !important; }`;
        (rn as unknown as Node).appendChild(style);
    }

    private _resolvePreviewFontSize(): number {
        const host =
            this._rootNode instanceof ShadowRoot ? this._rootNode.host : (this._rootNode as HTMLElement | null);
        if (!host) return 11;
        const val = getComputedStyle(host).getPropertyValue('--fs-sm').trim();
        return parseFloat(val) || 11;
    }

    private async _initAceEditor(filePath: string, content: string, seq: number): Promise<void> {
        if (!this._isCurrentEditorLoad(filePath, seq)) return;

        const rn = this._rootNode;
        const editorContainer = rn?.querySelector<HTMLElement>('.ws-editor-container');
        if (!rn || !editorContainer) return;

        this._destroyEditorInstance();
        const ace = await this._ensureAce();
        if (!this._isCurrentEditorLoad(filePath, seq)) return;
        const mode = resolveAceMode(filePath);
        const theme = resolveThemeName();
        const [themeData] = await Promise.all([this._ensureAceTheme(theme), this._ensureAceMode(mode)]);
        if (!this._isCurrentEditorLoad(filePath, seq)) return;

        // 注入 ace 结构和主题 CSS 到 Shadow DOM（确保 Shadow DOM 内的 ace 元素能匹配到样式）
        this._injectAceShadowStyles(themeData.cssText);

        const editor = ace.edit(editorContainer, {
            value: content,
            mode: `ace/mode/${mode}`,
            theme: `ace/theme/${theme}`,
            showPrintMargin: false,
            fontSize: this._resolvePreviewFontSize(),
            fontFamily: PREVIEW_FONT_FAMILY,
            tabSize: 4,
            showLineNumbers: true,
            readOnly: this._editorReadOnly
        });
        editor.setOption('useSoftTabs', true);
        editor.setOption('wrap', false);
        editor.getSession().setUseWrapMode(false);
        editor.focus();
        this._editorInstance = editor;
        this._editorDirty = false;
        this._editorStatus = 'idle';
        this._editorSaveError = null;
        this._clearEditorAutoSaveTimer();

        const onChange = (): void => {
            this._editorDirty = true;
            this._editorStatus = 'unsaved';
            this._editorSaveError = null;
            this._updateEditorStatus();
            this._scheduleEditorAutoSave();
        };
        this._editorChangeHandler = onChange;
        editor.on('change', this._editorChangeHandler);

        editor.commands.addCommand({
            name: 'saveFile',
            bindKey: { win: 'Ctrl-S', mac: 'Command-S' },
            exec: () => {
                void this._saveEditorContent();
            }
        });
        editor.commands.addCommand({
            name: 'closeEditor',
            bindKey: { win: 'Esc', mac: 'Esc' },
            exec: () => {
                this.closeEditor();
            }
        });

        this._editorResizeObserver?.disconnect();
        this._editorResizeObserver = new ResizeObserver(() => {
            this._editorInstance?.resize();
        });
        this._editorResizeObserver.observe(editorContainer);

        this._updateEditorStatus();

        const targetLine = this._editorOpenLine;
        this._editorOpenLine = null;
        if (targetLine != null && targetLine > 0) {
            this._gotoEditorLine(targetLine);
        }
        requestAnimationFrame(() => {
            editor.resize();
            editor.focus();
        });
    }

    /**
     * 在只读预览与可编辑之间切换，不销毁 Ace editor 实例。
     */
    private async _toggleEditorReadOnly(): Promise<void> {
        const nextReadOnly = !this._editorReadOnly;
        if (nextReadOnly && !(await this._saveEditorIfNeeded())) {
            this._updateEditorStatus();
            return;
        }

        this._editorReadOnly = nextReadOnly;
        if (this._editorInstance) {
            this._editorInstance.setReadOnly(this._editorReadOnly);
        }
        if (this._editorReadOnly) {
            this._editorStatus = 'idle';
        }
        // 仅替换头部，不触碰编辑器容器
        const rn = this._rootNode;
        if (rn) {
            const oldHeader = rn.querySelector('.ws-preview-header');
            if (oldHeader) {
                const temp = document.createElement('div');
                temp.innerHTML = this._renderPreviewHtml();
                const newHeader = temp.querySelector('.ws-preview-header');
                if (newHeader) {
                    oldHeader.replaceWith(newHeader);
                }
            }
        }
        if (!this._editorReadOnly) {
            this._updateEditorStatus();
            this._editorInstance?.focus();
        }
    }

    private _gotoEditorLine(line: number): void {
        if (!this._editorInstance || !line || line <= 0) return;
        this._editorInstance.gotoLine(line, 0, true);
    }

    private _updateEditorStatus(): void {
        const root = this._rootNode;
        if (!root || !this._editorMode) return;
        const statusEl = root.querySelector<HTMLElement>('.ws-editor-status');
        const saveBtn = root.querySelector<HTMLElement>('.ws-editor-save-btn');
        if (!statusEl || !saveBtn) return;
        const filenameEl = root.querySelector<HTMLElement>('.ws-breadcrumb-current');

        if (this._editorSaveError) {
            statusEl.innerHTML = `<i class="fas fa-triangle-exclamation" style="font-size: var(--fs-xs);"></i> ${escapeHtml(this._editorSaveError)}`;
            statusEl.style.color = '#dc2626';
            saveBtn.style.display = 'inline-flex';
            saveBtn.dataset.disabled = '0';
            return;
        }

        if (this._editorSaving) {
            statusEl.innerHTML =
                '<i class="fas fa-circle-notch fa-spin" style="font-size: var(--fs-xs);"></i> ' +
                t('renderer.fileExplorer.editor.saving');
            statusEl.style.color = '#3b82f6';
            saveBtn.style.display = 'inline-flex';
            saveBtn.dataset.disabled = '0';
            return;
        }

        if (this._editorDirty) {
            statusEl.innerHTML =
                '<i class="fas fa-circle" style="font-size:6px;"></i> ' + t('renderer.fileExplorer.editor.unsaved');
            statusEl.style.color = '#d97706';
            saveBtn.style.display = 'inline-flex';
            saveBtn.dataset.disabled = '0';
            if (filenameEl && filenameEl.textContent && !filenameEl.textContent.startsWith('● ')) {
                filenameEl.textContent = `● ${filenameEl.textContent}`;
            }
            return;
        }

        if (this._editorStatus === 'saved') {
            statusEl.innerHTML =
                '<i class="fas fa-check" style="font-size: var(--fs-xs);"></i> ' +
                t('renderer.fileExplorer.editor.saved');
            statusEl.style.color = '#16a34a';
            saveBtn.style.display = 'none';
            saveBtn.dataset.disabled = '1';
            if (filenameEl && filenameEl.textContent && filenameEl.textContent.startsWith('● ')) {
                filenameEl.textContent = filenameEl.textContent.slice(2);
            }
            if (!this._editorSaving && !this._editorDirty) {
                setTimeout(() => {
                    if (!this._editorDirty && !this._editorSaving && statusEl) {
                        statusEl.textContent = '';
                    }
                }, 2000);
            }
            return;
        }

        statusEl.textContent = '';
        saveBtn.style.display = 'none';
        saveBtn.dataset.disabled = '1';
    }

    private _scheduleEditorAutoSave(): void {
        this._clearEditorAutoSaveTimer();
        this._editorSaveTimer = window.setTimeout(() => {
            void this._saveEditorContent();
        }, EDITOR_AUTO_SAVE_DELAY);
    }

    private _clearEditorAutoSaveTimer(): void {
        if (this._editorSaveTimer !== null) {
            window.clearTimeout(this._editorSaveTimer);
            this._editorSaveTimer = null;
        }
    }

    private async _saveEditorIfNeeded(): Promise<boolean> {
        if (!this._editorInstance || !this._editorFilePath) return true;
        if (!this._editorDirty && !this._editorPendingSave && !this._editorSaving) return true;
        return this._saveEditorContent();
    }

    private async _saveEditorContent(): Promise<boolean> {
        const editor = this._editorInstance;
        const filePath = this._editorFilePath;
        if (!editor || !filePath) return true;
        if (this._editorSaving) {
            this._editorPendingSave = true;
            return false;
        }

        this._clearEditorAutoSaveTimer();
        this._editorSaving = true;
        this._editorPendingSave = false;
        this._editorStatus = 'saving';
        this._editorSaveError = null;
        this._updateEditorStatus();

        try {
            const content = editor.getValue();
            const fs = window.fsAPI;
            if (!fs || typeof fs.writeTextFile !== 'function') {
                throw new Error(t('renderer.fileExplorer.error.noWriteFile'));
            }
            await fs.writeTextFile(filePath, content);
            const contentUnchanged = this._editorFilePath === filePath && editor.getValue() === content;
            if (contentUnchanged) {
                this._editorDirty = false;
                this._editorStatus = 'saved';
            }
            this.softRefresh();
            return contentUnchanged;
        } catch (err: any) {
            this._editorDirty = true;
            this._editorStatus = 'error';
            this._editorSaveError = err?.message || String(err);
            return false;
        } finally {
            this._editorSaving = false;
            this._updateEditorStatus();
            if (this._editorPendingSave) {
                this._editorPendingSave = false;
                void this._saveEditorContent();
            }
        }
    }

    private _destroyEditorInstance(): void {
        this._clearEditorAutoSaveTimer();
        if (this._editorResizeObserver) {
            this._editorResizeObserver.disconnect();
            this._editorResizeObserver = null;
        }
        if (this._editorInstance) {
            if (this._editorChangeHandler) {
                const handler = this._editorChangeHandler;
                this._editorInstance.removeListener?.('change', handler);
                this._editorInstance.off?.('change', handler);
                this._editorChangeHandler = null;
            }
            this._editorInstance.destroy();
            this._editorInstance = null;
        }
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
        this._applyFullscreenLayout();

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

        if (!this._editorMode) {
            this._attachMarkdownShadow(el);
            this._attachHtmlPreview(el);
            this._attachSvgPreview(el);
            this._attachImagePreview(el);
        }
    }

    private _mountOfficeEditor(filePath: string, editorConfig: OfficeEditorConfig): void {
        const host = this._rootNode?.querySelector<HTMLElement>('.ws-office-editor-host');
        if (!host) {
            this._renderPreview();
            return;
        }

        const editorParams = new URLSearchParams({ mode: 'tab', file: filePath });
        if (editorConfig.kind === 'slides') {
            editorParams.set('extensionGroupLabel', t('renderer.fileExplorer.pptx.ai.groupLabel'));
            editorParams.set('selectionActionLabel', t('renderer.fileExplorer.pptx.ai.selectionAction'));
            editorParams.set('selectionActionTitle', t('renderer.fileExplorer.pptx.ai.selectionActionTitle'));
        }
        const editorUrl = `./${editorConfig.rendererPage}?${editorParams.toString()}`;
        const webview = document.createElement('webview');
        webview.className = 'ws-office-editor-frame ws-office-editor-frame--loading';
        webview.setAttribute('src', editorUrl);
        webview.setAttribute('title', t(editorConfig.titleKey));
        let editorReadyHandled = false;
        const handleEditorMessage = (event: Event): void => {
            const ipcEvent = event as Event & { channel?: string; args?: unknown[] };
            if (ipcEvent.channel === 'opendesk-office:extension-action') {
                const payload = ipcEvent.args?.[0] as { action?: { id?: string }; context?: unknown } | undefined;
                if (payload?.action?.id === 'opendesk-ai-selection') {
                    this.onAgentInputRequest?.(createSlidesSelectionInputRequest(payload.context, t));
                }
                return;
            }
            if (
                ipcEvent.channel !== OPENDESK_OFFICE_EDITOR_VISIBLE_CHANNEL &&
                ipcEvent.channel !== OPENDESK_OFFICE_DOCUMENT_READY_CHANNEL
            ) {
                return;
            }
            if (editorReadyHandled) return;
            editorReadyHandled = true;
            host.classList.remove('ws-office-editor-loading');
            host.querySelector('.ws-office-editor-loading-indicator')?.remove();
            webview.classList.remove('ws-office-editor-frame--loading');
            if (this._taskId && window.officeHostAPI?.bindOfficeTask) {
                const webContentsId = (
                    webview as HTMLElement & { getWebContentsId?: () => number }
                ).getWebContentsId?.();
                if (webContentsId) {
                    void window.officeHostAPI.bindOfficeTask(
                        editorConfig.kind,
                        this._taskId,
                        filePath,
                        webContentsId
                    );
                }
            }
        };
        webview.addEventListener('ipc-message', handleEditorMessage);
        host.classList.add('ws-office-editor-loading');
        host.innerHTML = renderOfficeEditorLoadingIndicator();
        host.prepend(webview);
    }

    private _isPreviewUnsupported(): boolean {
        if (this._editorMode) return false;
        if (this._previewState.status !== 'idle' || !this._previewState.data) return false;
        const d = this._previewState.data;
        // 图片文件有自己的预览方式，不算"不支持"
        if (this._selectedFile && isImageFile(this._selectedFile)) return false;
        if (this._selectedFile && isOfficeDocument(this._selectedFile)) return false;
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

    private _attachSvgPreview(root: ParentNode): void {
        if (
            !this._selectedFile ||
            !isSvgFile(this._selectedFile) ||
            this._previewState.status !== 'idle' ||
            !this._previewState.data?.content
        ) {
            return;
        }
        const host = root.querySelector<HTMLElement>('.ws-preview-svg-host');
        if (!host || host.dataset.attached) return;
        host.dataset.attached = '1';

        const svgText = this._previewState.data.content;
        const dataUri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
        const img = document.createElement('img');
        img.src = dataUri;
        img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;';
        img.alt = this._selectedFile.split('/').pop() || 'SVG';
        host.style.cssText =
            'width:100%;height:100%;overflow:auto;display:flex;align-items:center;justify-content:center;background:repeating-conic-gradient(#f0f0f0 0% 25%, transparent 0% 50%) 50% / 20px 20px;';
        host.appendChild(img);
    }

    private _attachImagePreview(root: ParentNode): void {
        if (!this._selectedFile || !isImageFile(this._selectedFile)) {
            return;
        }
        const host = root.querySelector<HTMLElement>('.ws-preview-image-host');
        if (!host || host.dataset.attached) return;
        host.dataset.attached = '1';

        const dataUri = this._previewState.data?.dataUri;
        if (!dataUri) return;

        const img = document.createElement('img');
        img.src = dataUri;
        img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;cursor:pointer;';
        img.alt = this._selectedFile.split('/').pop() || 'image';
        host.style.cssText =
            'width:100%;height:100%;overflow:auto;display:flex;align-items:center;justify-content:center;background:repeating-conic-gradient(#f0f0f0 0% 25%, transparent 0% 50%) 50% / 20px 20px;';
        img.addEventListener('click', () => showImageLightbox(img.src));
        host.appendChild(img);
    }

    private _breadcrumbDropdown: HTMLElement | null = null;
    private _breadcrumbDismissHandler: ((e: MouseEvent) => void) | null = null;
    // 面包屑下拉菜单中已展开的目录路径集合
    private _dropdownExpandedDirs: Set<string> = new Set();

    private _renderBreadcrumbHtml(): string {
        if (!this._selectedFile) return '';
        const file = this._selectedFile;
        const root = this._workspaceRoot || '';

        const segments: { name: string; dir: string }[] = [];
        if (root && file.startsWith(root + '/')) {
            const relPath = file.slice(root.length + 1);
            const parts = relPath.split('/');
            let currentDir = root;
            for (let i = 0; i < parts.length; i++) {
                const isLast = i === parts.length - 1;
                if (!isLast) {
                    currentDir = currentDir + '/' + parts[i];
                    segments.push({ name: parts[i], dir: currentDir });
                } else {
                    segments.push({ name: parts[i], dir: currentDir });
                }
            }
        } else {
            segments.push({ name: file.split('/').pop() || file, dir: this._parentOf(file) });
        }

        const html = segments
            .map((seg, i) => {
                const isLast = i === segments.length - 1;
                const cls = isLast ? 'ws-breadcrumb-item ws-breadcrumb-current' : 'ws-breadcrumb-item';
                const sep = i > 0 ? '<i class="fas fa-chevron-right ws-breadcrumb-sep"></i>' : '';
                return `${sep}<span class="${cls}" data-breadcrumb-dir="${escapeHtml(seg.dir)}">${escapeHtml(seg.name)}</span>`;
            })
            .join('');
        return `<div class="ws-breadcrumb">${html}</div>`;
    }

    private _dismissBreadcrumbDropdown(): void {
        if (this._breadcrumbDropdown) {
            this._breadcrumbDropdown.remove();
            this._breadcrumbDropdown = null;
        }
        if (this._breadcrumbDismissHandler) {
            document.removeEventListener('click', this._breadcrumbDismissHandler);
            this._breadcrumbDismissHandler = null;
        }
    }

    private _showBreadcrumbDropdown(dirPath: string, anchorEl: HTMLElement): void {
        this._dismissBreadcrumbDropdown();
        this._dismissContextMenu();

        const dropdown = document.createElement('div');
        dropdown.className = 'ctx-menu bc-dropdown';

        // 每次打开下拉菜单时重置展开状态，默认展开根目录
        this._dropdownExpandedDirs = new Set<string>();
        this._dropdownExpandedDirs.add(dirPath);

        const BC_INDENT = 16; // 每级缩进像素

        // 递归渲染树，已展开的目录会内联渲染子条目
        const renderTree = (parentPath: string, depth: number): string => {
            const cached = this._childrenCache.get(parentPath);

            if (!cached || cached === 'loading') {
                return `<div class="ctx-item" style="pointer-events:none;padding-left:${12 + depth * BC_INDENT}px">
                    <span class="ctx-icon-sm"><i class="fas fa-circle-notch fa-spin"></i></span>
                    <span class="ctx-label">Loading…</span></div>`;
            }

            if (!Array.isArray(cached)) {
                const errMsg = cached.error || 'Error';
                return `<div class="ctx-item" style="pointer-events:none;color:var(--ctx-danger);padding-left:${12 + depth * BC_INDENT}px">
                    <span class="ctx-icon-sm"><i class="fas fa-exclamation-triangle"></i></span>
                    <span class="ctx-label">${escapeHtml(errMsg)}</span></div>`;
            }

            const sorted = [...cached].sort((a, b) => {
                if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
                return a.name.localeCompare(b.name);
            });

            const currentFile = this._selectedFile;
            let html = '';

            for (const entry of sorted) {
                const isCurrent = entry.path === currentFile;
                const paddingLeft = 12 + depth * BC_INDENT;

                if (entry.isDirectory) {
                    const isExpanded = this._dropdownExpandedDirs.has(entry.path);
                    const arrowIcon = isExpanded ? 'fa-chevron-down' : 'fa-chevron-right';
                    const cls = isCurrent ? 'ctx-item bc-dir-item favorite' : 'ctx-item bc-dir-item';

                    html += `<button class="${cls}" data-bc-path="${escapeHtml(entry.path)}" data-bc-dir="true"
                        style="padding-left:${paddingLeft}px">
                        <span class="bc-arrow"><i class="fas ${arrowIcon}"></i></span>
                        <span class="ctx-icon-sm"><i class="fas fa-folder" style="color:#f59e0b"></i></span>
                        <span class="ctx-label">${escapeHtml(entry.name)}</span></button>`;

                    if (isExpanded) {
                        html += renderTree(entry.path, depth + 1);
                    }
                } else {
                    const icon = pickFileIcon(entry);
                    const cls = isCurrent ? 'ctx-item favorite' : 'ctx-item';
                    html += `<button class="${cls}" data-bc-path="${escapeHtml(entry.path)}" data-bc-dir="false"
                        style="padding-left:${paddingLeft}px">
                        <span class="ctx-icon-sm"><i class="fas ${icon}" style="color:#94a3b8"></i></span>
                        <span class="ctx-label">${escapeHtml(entry.name)}</span></button>`;
                }
            }

            return html;
        };

        const renderAll = (): void => {
            dropdown.innerHTML = renderTree(dirPath, 0);
        };

        renderAll();

        // 首次加载
        const cached = this._childrenCache.get(dirPath);
        if (!cached || !Array.isArray(cached)) {
            dropdown.innerHTML =
                '<div class="ctx-item" style="pointer-events:none;"><span class="ctx-icon-sm"><i class="fas fa-circle-notch fa-spin"></i></span><span class="ctx-label">Loading…</span></div>';
            void this._loadChildren(dirPath).then(() => {
                if (this._breadcrumbDropdown === dropdown) {
                    renderAll();
                }
            });
        }

        // 定位：不超出视口
        const rect = anchorEl.getBoundingClientRect();
        const menuMaxH = 400;
        const viewportH = window.innerHeight;
        let top = rect.bottom + 2;
        if (top + menuMaxH > viewportH - 8) {
            top = Math.max(8, rect.top - Math.min(menuMaxH, viewportH - 16) - 2);
        }
        dropdown.style.left = `${Math.max(4, rect.left)}px`;
        dropdown.style.top = `${top}px`;
        document.body.appendChild(dropdown);
        this._breadcrumbDropdown = dropdown;

        // 点击处理
        dropdown.addEventListener('click', (ev) => {
            const item = (ev.target as HTMLElement).closest('[data-bc-path]');
            if (!item) return;
            const path = item.dataset.bcPath;
            const isDir = item.dataset.bcDir === 'true';
            if (!path) return;

            if (isDir) {
                ev.stopPropagation();
                if (this._dropdownExpandedDirs.has(path)) {
                    this._dropdownExpandedDirs.delete(path);
                    renderAll();
                } else {
                    this._dropdownExpandedDirs.add(path);
                    const dirCached = this._childrenCache.get(path);
                    if (!dirCached || !Array.isArray(dirCached)) {
                        // 先渲染 loading 态，等加载完再刷新
                        renderAll();
                        void this._loadChildren(path).then(() => {
                            if (this._breadcrumbDropdown === dropdown) {
                                renderAll();
                            }
                        });
                    } else {
                        renderAll();
                    }
                }
            } else {
                this._dismissBreadcrumbDropdown();
                this.selectFile(path);
            }
        });

        // 点击外部关闭（跳过本次点击冒泡）
        let skipCurrent = true;
        this._breadcrumbDismissHandler = (e: MouseEvent): void => {
            if (skipCurrent) {
                skipCurrent = false;
                return;
            }
            if (!dropdown.contains(e.target as Node) && !anchorEl.contains(e.target as Node)) {
                this._dismissBreadcrumbDropdown();
            }
        };
        setTimeout(() => {
            document.addEventListener('click', this._breadcrumbDismissHandler!);
        }, 0);
    }

    private _renderPreviewHtml(): string {
        if (!this._selectedFile) {
            return `
            <div class="ws-preview-empty">
                <i class="fas fa-eye"></i>
                <span>${t('renderer.fileExplorer.preview.empty')}</span>
            </div>`;
        }
        if (this._editorMode) {
            // 只读预览模式：显示预览风格头部（编辑按钮 + 全屏 + 关闭）
            if (this._editorReadOnly) {
                return `
                <div class="ws-preview-header">
                    <i class="fas fa-file-code"></i>
                    ${this._renderBreadcrumbHtml()}
                    <span class="ws-mode-tag ws-mode-readonly">${t('renderer.fileExplorer.preview.readonly')}</span>
                    <button class="ws-fullscreen-btn" data-action="open-editor"><i class="fas fa-pen-to-square"></i><span class="ws-btn-label">${t('renderer.fileExplorer.preview.btnEdit')}</span></button>
                    <button class="ws-preview-close" data-preview-close>
                        <i class="fas fa-xmark"></i><span class="ws-btn-label">${t('renderer.fileExplorer.preview.btnClose')}</span>
                    </button>
                </div>
                <div class="ws-editor-host">
                    ${
                        this._previewState.status === 'loading'
                            ? `<div class="ws-preview-body ws-preview-info"><i class="fas fa-circle-notch fa-spin"></i><span>${t('renderer.fileExplorer.preview.reading')}</span></div>`
                            : this._previewState.status === 'error'
                              ? `<div class="ws-preview-body ws-preview-info"><i class="fas fa-triangle-exclamation"></i><span>${escapeHtml(this._previewState.error || t('renderer.fileExplorer.preview.readFailed'))}</span></div>`
                              : `<div class="ws-editor-container"></div>`
                    }
                </div>`;
            }
            return `
            <div class="ws-preview-header">
                <i class="fas fa-file-code"></i>
                ${this._renderBreadcrumbHtml()}
                <span class="ws-mode-tag ws-mode-edit">${t('renderer.fileExplorer.preview.editing')}</span>
                <span class="ws-editor-status"></span>
                <button class="ws-editor-save-btn" data-action="editor-save" style="display:none;">
                    <i class="fas fa-floppy-disk" style="font-size: var(--fs-xs);"></i> ${t('renderer.fileExplorer.preview.save')}
                </button>
                <button class="ws-fullscreen-btn" data-action="editor-preview">
                    <i class="fas fa-eye"></i><span class="ws-btn-label">${t('renderer.fileExplorer.preview.btnPreview')}</span>
                </button>
                <button class="ws-preview-close" data-action="editor-close">
                    <i class="fas fa-xmark"></i><span class="ws-btn-label">${t('renderer.fileExplorer.preview.btnClose')}</span>
                </button>
            </div>
            <div class="ws-editor-host">
                ${
                    this._previewState.status === 'loading'
                        ? `<div class="ws-preview-body ws-preview-info"><i class="fas fa-circle-notch fa-spin"></i><span>${t('renderer.fileExplorer.preview.loadingEditor')}</span></div>`
                        : this._previewState.status === 'error'
                          ? `<div class="ws-preview-body ws-preview-info"><i class="fas fa-triangle-exclamation"></i><span>${escapeHtml(this._previewState.error || t('renderer.fileExplorer.preview.readFailed'))}</span></div>`
                          : `<div class="ws-editor-container"></div>`
                }
            </div>`;
        }

        const header = `
        <div class="ws-preview-header">
            <i class="fas ${getOfficeEditorConfig(this._selectedFile)?.iconClass ?? 'fa-file-lines'}"></i>
            ${this._renderBreadcrumbHtml()}
            ${
                this._previewState.data
                    ? `<span class="ws-preview-size">${escapeHtml(formatBytes(this._previewState.data.size))}</span>`
                    : ''
            }
            ${
                this._previewState.data &&
                !isOfficeDocument(this._selectedFile) &&
                !this._previewState.data.binary &&
                !this._previewState.data.tooLarge
                    ? `<button class="ws-fullscreen-btn" data-action="open-editor"><i class="fas fa-pen-to-square"></i><span class="ws-btn-label">${t('renderer.fileExplorer.preview.btnEdit')}</span></button>`
                    : ''
            }
            <button class="ws-preview-close" data-preview-close>
                <i class="fas fa-xmark"></i><span class="ws-btn-label">${t('renderer.fileExplorer.preview.btnClose')}</span>
            </button>
        </div>`;

        let bodyHtml = '';
        if (this._previewState.status === 'loading') {
            bodyHtml =
                this._selectedFile && isOfficeDocument(this._selectedFile)
                    ? `<div class="ws-office-editor-host ws-office-editor-loading">${renderOfficeEditorLoadingIndicator()}</div>`
                    : `
            <div class="ws-preview-body ws-preview-info">
                <i class="fas fa-circle-notch fa-spin"></i>
                <span>${t('renderer.fileExplorer.preview.reading')}</span>
            </div>`;
        } else if (this._previewState.status === 'error') {
            bodyHtml = `
            <div class="ws-preview-body ws-preview-info">
                <i class="fas fa-triangle-exclamation"></i>
                <span>${escapeHtml(this._previewState.error || t('renderer.fileExplorer.preview.readError'))}</span>
            </div>`;
        } else if (this._previewState.data) {
            const d = this._previewState.data;
            const editorConfig = getOfficeEditorConfig(this._selectedFile);
            if (editorConfig) {
                const editorUrl = `./${editorConfig.rendererPage}?mode=tab&file=${encodeURIComponent(this._selectedFile)}`;
                bodyHtml = `<div class="ws-office-editor-host"><webview class="ws-office-editor-frame" src="${escapeHtml(editorUrl)}" title="${escapeHtml(t(editorConfig.titleKey))}"></webview></div>`;
            } else if (d.tooLarge) {
                bodyHtml = `
                <div class="ws-preview-body ws-preview-info">
                    <i class="fas fa-file-circle-xmark"></i>
                    <div>
                        <div>${t('renderer.fileExplorer.preview.tooLarge', { size: escapeHtml(formatBytes(d.size)), limit: escapeHtml(formatBytes(d.limit)) })}
                        </div>
                        <div class="ws-preview-hint">${t('renderer.fileExplorer.preview.tooLargeHint')}</div>
                    </div>
                </div>`;
            } else if (this._selectedFile && isImageFile(this._selectedFile)) {
                bodyHtml = `<div class="ws-preview-image-host"></div>`;
            } else if (d.binary) {
                bodyHtml = `
                <div class="ws-preview-body ws-preview-info">
                    <i class="fas fa-file-shield"></i>
                    <div>
                        <div>${t('renderer.fileExplorer.preview.binary')}</div>
                        <div class="ws-preview-hint">${t('renderer.fileExplorer.preview.binaryHint')}</div>
                    </div>
                </div>`;
            } else if (this._selectedFile && isSvgFile(this._selectedFile)) {
                bodyHtml = `<div class="ws-preview-svg-host"></div>`;
            } else if (this._selectedFile && isMarkdownFile(this._selectedFile)) {
                bodyHtml = `<div class="ws-preview-md-host"></div>`;
            } else if (this._selectedFile && isHtmlFile(this._selectedFile)) {
                bodyHtml = `<div class="ws-preview-html-host"></div>`;
            } else if (this._selectedFile && getCodeLanguage(this._selectedFile)) {
                bodyHtml = `
                <div class="ws-preview-body">
                    <pre class="ws-preview-pre">${escapeHtml(d.content)}</pre>
                </div>`;
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
