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

import { RendererToolset, RendererTool, AgentOperableHTMLElement } from '../../widget_utils.js';
import { showConfirmModal } from '../../../../renderer/components/confirmModal.ts';
import { TOUCH_LONG_PRESS_SCRIPT } from '../../../../renderer/touchLongPressScript.ts';
import { resolveRendererLocale } from '../../../../renderer/locale.js';
import { createTranslatorForNotes } from '../locale/renderer.js';
import { z } from 'zod';
import TurndownService from 'turndown';

// ========== TinyMCE 7.x 导入 ==========
import tinymce from 'tinymce/tinymce';
import 'tinymce/models/dom';
import 'tinymce/themes/silver';
import 'tinymce/icons/default';
import 'tinymce/plugins/advlist';
import 'tinymce/plugins/autolink';
import 'tinymce/plugins/lists';
import 'tinymce/plugins/link';
import 'tinymce/plugins/image';
import 'tinymce/plugins/charmap';
import 'tinymce/plugins/code';
import 'tinymce/plugins/table';
import 'tinymce/plugins/wordcount';
import 'tinymce/skins/ui/oxide/skin.css';
import contentCss from 'tinymce/skins/content/default/content.css?inline';
import contentUiCss from 'tinymce/skins/ui/oxide/content.css?inline';
import 'tinymce-i18n/langs7/zh_CN.js';

// 笔记代码块语法高亮（与 taskview 同源，按需注册语言子集）
import hljs from '../../../../renderer/utils/highlight-registry.js';
import {
    LANG_DISPLAY_NAMES,
    renderCodeBlockHtml,
    renderCodeLineHtml,
    renderCodeLineInnerHtml,
    splitHighlightedLines
} from '../../../../common/markdown/code-block-render.js';

const NOTE_PAGE_SIZE = 30;

/** 笔记正文文字颜色预设（value 为空表示恢复默认；label 为 locale 键） */
const NOTES_TEXT_COLORS = [
    { labelKey: 'renderer.note.color.default', value: '' },
    { labelKey: 'renderer.note.color.red', value: '#FF3B30' },
    { labelKey: 'renderer.note.color.orange', value: '#FF9500' },
    { labelKey: 'renderer.note.color.yellow', value: '#FFCC00' },
    { labelKey: 'renderer.note.color.green', value: '#34C759' },
    { labelKey: 'renderer.note.color.blue', value: '#007AFF' },
    { labelKey: 'renderer.note.color.purple', value: '#5856D6' },
    { labelKey: 'renderer.note.color.pink', value: '#AF52DE' },
    { labelKey: 'renderer.note.color.gray', value: '#8E8E93' }
];

/** 列表分组头：内部键 -> locale 键（日期字符串原样显示） */
const GROUP_LABEL_KEYS = {
    pinned: 'renderer.note.group.pinned',
    today: 'renderer.note.group.today',
    yesterday: 'renderer.note.group.yesterday'
};

/** 排序方式 -> locale 键 */
const SORT_LABELS = {
    updatedAt: 'renderer.note.sort.updatedAt',
    createdAt: 'renderer.note.sort.createdAt',
    title: 'renderer.note.sort.title'
};

// ========== CSS ==========
const NOTES_CSS = `
/* ---- Root ---- */
.notes-root {
    font-family: -apple-system, BlinkMacFont, 'SF Pro Display', 'SF Pro Text', 'Segoe UI', system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    color: #1d1d1f;
}

/* ---- Left panel ---- */
.notes-left {
    background: #FAFAFA;
    border-right: 1px solid #F0F0F0;
}

/* ---- Search ---- */
.notes-search {
    position: relative;
    margin-bottom: 12px;
}
.notes-search-icon {
    position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
    font-size: 12px; color: #8E8E93; pointer-events: none;
}
.notes-search-input {
    width: 100%; padding: 8px 12px 8px 32px; border-radius: 10px;
    border: 1px solid #E5E5EA; background: #fff; font-size: 13px;
    color: #1d1d1f; outline: none; transition: all 0.2s;
    box-sizing: border-box;
}
.notes-search-input:focus {
    border-color: #FFA726; box-shadow: 0 0 0 3px rgba(255,167,38,0.15);
}
.notes-search-input::placeholder { color: #C7C7CC; }

/* ---- New note button ---- */
.notes-new-btn {
    display: flex; align-items: center; gap: 6px; padding: 7px 16px;
    border-radius: 10px; border: none; background: #1d1d1f; color: #fff;
    font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.15s;
    white-space: nowrap;
}
.notes-new-btn:hover { background: #333; }
.notes-new-btn:active { transform: scale(0.97); }

/* ---- Filter bar ---- */
.notes-filter-bar {
    display: flex; gap: 8px; margin-bottom: 12px;
}
.notes-filter-btn {
    display: flex; align-items: center; gap: 4px; padding: 5px 12px;
    border-radius: 8px; border: 1px solid #E5E5EA; background: #fff;
    font-size: 12px; font-weight: 500; color: #8E8E93; cursor: pointer;
    transition: all 0.15s; white-space: nowrap;
}
.notes-filter-btn:hover { background: #F5F5F7; border-color: #D1D1D6; color: #1d1d1f; }
.notes-filter-btn.active { background: #FFF3E0; border-color: #FFA726; color: #E65100; }

/* ---- Note list ---- */
.notes-group-header {
    font-size: 12px; font-weight: 600; color: #8E8E93;
    padding: 12px 0 6px; letter-spacing: 0.02em;
    text-transform: uppercase;
}
.notes-item {
    padding: 10px 12px; border-radius: 10px; cursor: pointer;
    transition: all 0.15s; margin-bottom: 2px;
}
.notes-item:hover { background: #F0F0F2; }
.notes-item.active { background: #FFF3E0; }
.notes-item-title {
    font-size: 14px; font-weight: 600; color: #1d1d1f;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    margin-bottom: 3px;
}
.notes-item-preview {
    font-size: 12px; color: #8E8E93; line-height: 1.4;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    margin-bottom: 4px;
}
.notes-item-meta {
    display: flex; align-items: center; justify-content: space-between; gap: 6px;
}
.notes-item-tags {
    display: flex; gap: 4px; overflow: hidden; flex: 1;
}
.notes-item-time {
    font-size: 11px; color: #C7C7CC; flex-shrink: 0;
}

/* ---- Tag pill ---- */
.notes-tag {
    display: inline-flex; align-items: center; gap: 3px;
    padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 500;
    white-space: nowrap; line-height: 1.4;
}
.notes-tag.removable { cursor: pointer; }
.notes-tag.removable:hover { opacity: 0.8; }
.notes-tag .fa-xmark { font-size: 9px; margin-left: 1px; opacity: 0.6; }

/* ---- Card grid ---- */
.notes-card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 16px;
}
.notes-card {
    background: #fff; border: 1px solid #F0F0F2; border-radius: 14px;
    padding: 16px; cursor: pointer; transition: all 0.2s;
}
.notes-card:hover {
    box-shadow: 0 4px 16px rgba(0,0,0,0.08);
    border-color: #E5E5EA; transform: translateY(-2px);
}
.notes-card-title {
    font-size: 15px; font-weight: 600; color: #1d1d1f;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    margin-bottom: 6px;
}
.notes-card-preview {
    font-size: 13px; color: #8E8E93; line-height: 1.5;
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
    overflow: hidden; margin-bottom: 10px; min-height: 40px;
}
.notes-card-meta {
    display: flex; align-items: center; justify-content: space-between;
}
.notes-card-time {
    font-size: 11px; color: #C7C7CC;
}
.notes-card-tags {
    display: flex; gap: 4px; overflow: hidden;
}

/* ---- Fixed toolbar ---- */
.notes-editor-shell {
    flex: 1; min-height: 0;
    display: flex; flex-direction: column;
    margin: 8px 24px 24px;
    border-radius: 14px;
    overflow: hidden;
    background: var(--notes-shell-bg, #fff);
    box-shadow: 0 0 0 1px var(--notes-shell-border, #F0F0F2);
}
.notes-fixed-toolbar {
    display: flex; align-items: center; gap: 2px;
    padding: 6px 10px; border-bottom: 1px solid var(--notes-shell-border, #F0F0F0);
    background: var(--notes-toolbar-bg, #FAFAFA); flex-shrink: 0;
}
.notes-editor-body {
    flex: 1; min-height: 0;
    background: var(--notes-shell-bg, #fff);
}
.notes-ftb-fixed-btn {
    display: flex; align-items: center; justify-content: center; gap: 3px;
    padding: 5px 8px; border-radius: 6px; border: none;
    background: transparent; color: #8E8E93; font-size: 12px; font-weight: 600;
    cursor: pointer; transition: all 0.12s; white-space: nowrap;
}
.notes-ftb-fixed-btn:hover { background: #E5E5EA; color: #1d1d1f; }
.notes-ftb-fixed-btn:active { transform: scale(0.95); }
.notes-ftb-fixed-btn.active { background: #1d1d1f; color: #fff; }
.notes-ftb-fixed-sep {
    width: 1px; height: 18px; background: #E5E5EA; margin: 0 4px; flex-shrink: 0;
}
.notes-ftb-fixed-ai {
    color: #FFA726; margin-left: auto;
}
.notes-ftb-fixed-ai:hover { background: #FFF8E1; }
.notes-ftb-hidden { display: none !important; }

/* ---- Text color picker ---- */
.notes-ftb-color-group { position: relative; flex-shrink: 0; }
.notes-ftb-color-btn { position: relative; padding-bottom: 7px !important; }
.notes-ftb-color-indicator {
    position: absolute; bottom: 4px; left: 50%; transform: translateX(-50%);
    width: 14px; height: 3px; border-radius: 2px; background: #1d1d1f;
    pointer-events: none;
}
.notes-ftb-color-submenu {
    position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
    margin-top: 6px; padding: 8px; border-radius: 12px;
    background: rgba(255,255,255,0.96); backdrop-filter: blur(40px);
    box-shadow: 0 8px 32px rgba(0,0,0,0.14), 0 0 1px rgba(0,0,0,0.08);
    border: 1px solid rgba(0,0,0,0.06);
    min-width: 200px; z-index: 10000;
    animation: notes-ftb-in 0.15s ease-out forwards;
}
.notes-ftb-color-submenu.hidden { display: none; }
.notes-ftb-color-grid {
    display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px;
    margin-bottom: 8px;
}
.notes-ftb-color-swatch {
    width: 28px; height: 28px; border-radius: 6px; border: 1px solid rgba(0,0,0,0.1);
    cursor: pointer; padding: 0; transition: transform 0.1s;
}
.notes-ftb-color-swatch:hover { transform: scale(1.08); }
.notes-ftb-color-swatch.notes-ftb-color-reset {
    background: #fff; color: #1d1d1f; font-size: 12px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
}
.notes-ftb-color-custom {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding-top: 6px; border-top: 1px solid #F0F0F0;
    font-size: 12px; color: #8E8E93;
}
.notes-ftb-color-input {
    width: 32px; height: 24px; padding: 0; border: 1px solid #E5E5EA;
    border-radius: 4px; cursor: pointer; background: transparent;
}

/* ---- Polishing overlay ---- */
.notes-polishing-overlay {
    position: absolute; inset: 0; z-index: 100;
    background: rgba(255,255,255,0.5);
    display: flex; align-items: center; justify-content: center;
    animation: notes-fade-in 0.2s ease-out forwards;
}
.notes-polishing-indicator {
    padding: 12px 24px; border-radius: 12px;
    background: rgba(255,167,38,0.95); color: #fff;
    font-size: 14px; font-weight: 600;
    box-shadow: 0 4px 16px rgba(255,167,38,0.3);
    display: flex; align-items: center; gap: 8px;
}
.notes-polishing-indicator .fa-spinner { animation: fa-spin 1s linear infinite; }

/* ---- Editor ---- */
.notes-editor-container { height: 100%; position: relative; }
.notes-editor-header {
    padding: 36px 24px 0;
}
.notes-title-input {
    width: 100%; border: none; outline: none; font-size: 22px; font-weight: 700;
    color: #1d1d1f; background: transparent; padding: 0 0 8px;
    letter-spacing: -0.02em;
}
.notes-title-input::placeholder { color: #C7C7CC; }
.notes-editor-tags {
    display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    padding-bottom: 12px; margin-bottom: 0;
}
.notes-editor-tags-border {
    border-bottom: 1px solid #F0F0F0; margin: 0 0;
}
.notes-add-tag-btn {
    display: flex; align-items: center; gap: 4px; padding: 3px 10px;
    border-radius: 6px; border: 1px dashed #D1D1D6; background: transparent;
    font-size: 12px; color: #8E8E93; cursor: pointer; transition: all 0.15s;
}
.notes-add-tag-btn:hover { border-color: #FFA726; color: #FFA726; background: #FFF8E1; }
.notes-editor-body .tox-tinymce {
    border: none !important;
    border-radius: 0 !important;
}
.notes-editor-body .tox .tox-edit-area__iframe {
    background: transparent !important;
}

/* ---- Floating toolbar ---- */
.notes-floating-toolbar {
    position: fixed; z-index: 9999;
    animation: notes-ftb-in 0.2s ease-out forwards;
}
.notes-floating-toolbar.hidden {
    display: none;
}
.notes-ftb {
    display: flex; align-items: center; gap: 2px;
    padding: 4px 6px; border-radius: 12px;
    background: rgba(255,255,255,0.92); backdrop-filter: blur(40px);
    box-shadow: 0 4px 24px rgba(0,0,0,0.12), 0 0 1px rgba(0,0,0,0.08);
    border: 1px solid rgba(0,0,0,0.06);
}
.notes-ftb-btn {
    display: flex; align-items: center; justify-content: center; gap: 3px;
    padding: 5px 8px; border-radius: 8px; border: none;
    background: transparent; color: #1d1d1f; font-size: 12px; font-weight: 600;
    cursor: pointer; transition: all 0.12s; white-space: nowrap;
}
.notes-ftb-btn:hover { background: #F5F5F7; }
.notes-ftb-btn:active { transform: scale(0.95); }
.notes-ftb-btn.active { background: #1d1d1f; color: #fff; }
.notes-ftb-btn[disabled] { opacity: 0.4; cursor: not-allowed; }
.notes-ftb-sep {
    width: 1px; height: 18px; background: #E5E5EA; margin: 0 2px; flex-shrink: 0;
}

/* ---- AI submenu ---- */
.notes-ftb-ai-group { position: relative; }
.notes-ftb-ai-btn { color: #FFA726; }
.notes-ftb-ai-btn:hover { background: #FFF8E1; }
.notes-ftb-ai-submenu {
    position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
    margin-top: 6px; padding: 6px; border-radius: 12px;
    background: rgba(255,255,255,0.95); backdrop-filter: blur(40px);
    box-shadow: 0 8px 32px rgba(0,0,0,0.14), 0 0 1px rgba(0,0,0,0.08);
    border: 1px solid rgba(0,0,0,0.06);
    min-width: 140px; z-index: 10000;
    animation: notes-ftb-in 0.15s ease-out forwards;
}
.notes-ftb-ai-submenu.hidden { display: none; }
.notes-ftb-ai-item {
    display: flex; align-items: center; gap: 8px; width: 100%;
    padding: 8px 12px; border-radius: 8px; border: none;
    background: transparent; color: #1d1d1f; font-size: 13px; font-weight: 500;
    cursor: pointer; transition: all 0.12s; text-align: left;
}
.notes-ftb-ai-item:hover { background: #F5F5F7; }
.notes-ftb-ai-item[disabled] { opacity: 0.4; cursor: not-allowed; }
.notes-ftb-ai-item .fa-sparkles { color: #FFA726; }
.notes-ftb-ai-item .fa-language { color: #5AC8FA; }
.notes-ftb-ai-item .fa-play { color: #34C759; }

/* ---- Style submenu ---- */
.notes-ftb-style-group { position: relative; }
.notes-ftb-style-submenu {
    position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
    margin-top: 6px; padding: 6px; border-radius: 12px;
    background: rgba(255,255,255,0.95); backdrop-filter: blur(40px);
    box-shadow: 0 8px 32px rgba(0,0,0,0.14), 0 0 1px rgba(0,0,0,0.08);
    border: 1px solid rgba(0,0,0,0.06);
    min-width: 120px; z-index: 10000;
    animation: notes-ftb-in 0.15s ease-out forwards;
}
.notes-ftb-style-submenu.hidden { display: none; }
.notes-ftb-style-item {
    display: block; width: 100%; padding: 6px 12px; border-radius: 6px;
    border: none; background: transparent; color: #1d1d1f;
    font-size: 13px; font-weight: 500; cursor: pointer;
    transition: all 0.12s; text-align: left;
}
.notes-ftb-style-item:hover { background: #F5F5F7; }

/* ---- Tag menu (dropdown) ---- */
.notes-tag-menu {
    position: fixed; z-index: 10001; padding: 8px;
    border-radius: 14px; background: rgba(255,255,255,0.96);
    backdrop-filter: blur(40px);
    box-shadow: 0 8px 32px rgba(0,0,0,0.14), 0 0 1px rgba(0,0,0,0.08);
    border: 1px solid rgba(0,0,0,0.06);
    min-width: 200px; max-height: 300px; overflow-y: auto;
    animation: notes-ftb-in 0.15s ease-out forwards;
}
.notes-tag-menu.hidden { display: none; }
.notes-tag-menu-title {
    font-size: 12px; font-weight: 600; color: #8E8E93;
    padding: 4px 8px 8px; text-transform: uppercase; letter-spacing: 0.02em;
}
.notes-tag-menu-item {
    display: flex; align-items: center; justify-content: space-between;
    padding: 6px 8px; border-radius: 8px; cursor: pointer;
    transition: all 0.12s;
}
.notes-tag-menu-item:hover { background: #F5F5F7; }
.notes-tag-menu-item-left {
    display: flex; align-items: center; gap: 8px;
}
.notes-tag-menu-item-check {
    width: 16px; height: 16px; border-radius: 4px; border: 1.5px solid #D1D1D6;
    display: flex; align-items: center; justify-content: center;
    font-size: 10px; color: transparent; transition: all 0.15s;
}
.notes-tag-menu-item-check.checked {
    background: #FFA726; border-color: #FFA726; color: #fff;
}
.notes-tag-menu-item-del {
    width: 22px; height: 22px; border-radius: 6px; border: none;
    background: transparent; color: #C7C7CC; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    font-size: 11px; transition: all 0.12s;
}
.notes-tag-menu-item-del:hover { background: #FEF2F2; color: #FF3B30; }
.notes-tag-menu-new {
    display: flex; align-items: center; gap: 6px;
    padding: 8px; border-top: 1px solid #F0F0F0; margin-top: 4px;
}
.notes-tag-menu-new input {
    flex: 1; border: none; outline: none; font-size: 13px;
    background: transparent; color: #1d1d1f;
}
.notes-tag-menu-new input::placeholder { color: #C7C7CC; }
.notes-tag-menu-new-btn {
    padding: 4px 10px; border-radius: 6px; border: none;
    background: #1d1d1f; color: #fff; font-size: 12px; font-weight: 600;
    cursor: pointer; transition: all 0.12s;
}
.notes-tag-menu-new-btn:hover { background: #333; }

/* ---- Dropdown menu (sort/filter) ---- */
.notes-dropdown {
    position: fixed; z-index: 10001; padding: 6px;
    border-radius: 12px; background: rgba(255,255,255,0.96);
    backdrop-filter: blur(40px);
    box-shadow: 0 8px 32px rgba(0,0,0,0.14), 0 0 1px rgba(0,0,0,0.08);
    border: 1px solid rgba(0,0,0,0.06);
    min-width: 160px;
    animation: notes-ftb-in 0.15s ease-out forwards;
}
.notes-dropdown.hidden { display: none; }
.notes-dropdown-item {
    display: flex; align-items: center; gap: 8px; width: 100%;
    padding: 8px 12px; border-radius: 8px; border: none;
    background: transparent; color: #1d1d1f; font-size: 13px; font-weight: 500;
    cursor: pointer; transition: all 0.12s; text-align: left;
}
.notes-dropdown-item:hover { background: #F5F5F7; }
.notes-dropdown-item.active { color: #FFA726; }
.notes-dropdown-item .fa-check { font-size: 11px; margin-left: auto; }

/* ---- Scrollbar ---- */
.notes-scroll::-webkit-scrollbar { width: 6px; }
.notes-scroll::-webkit-scrollbar-track { background: transparent; }
.notes-scroll::-webkit-scrollbar-thumb {
    background: #D1D1D6; border-radius: 3px;
}
.notes-scroll::-webkit-scrollbar-thumb:hover { background: #C7C7CC; }

/* ---- Animations ---- */
@keyframes notes-ftb-in {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
}
@keyframes notes-fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
}
@keyframes notes-slide-up {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
}
.notes-anim-item {
    animation: notes-slide-up 0.25s ease-out forwards;
}

/* ---- Empty state ---- */
.notes-empty {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    height: 100%; color: #C7C7CC; gap: 8px;
}
.notes-empty i { font-size: 40px; margin-bottom: 8px; }
.notes-empty p { font-size: 14px; }

/* ---- Close editor button ---- */
.notes-close-btn {
    display: flex; align-items: center; gap: 4px; padding: 5px 12px;
    border-radius: 8px; border: 1px solid #E5E5EA; background: #fff;
    font-size: 12px; font-weight: 500; color: #8E8E93; cursor: pointer;
    transition: all 0.15s;
}
.notes-close-btn:hover { background: #F5F5F7; color: #1d1d1f; border-color: #D1D1D6; }

/* ---- Delete note button ---- */
.notes-delete-btn {
    display: flex; align-items: center; gap: 4px; padding: 5px 12px;
    border-radius: 8px; border: 1px solid #E5E5EA; background: #fff;
    font-size: 12px; font-weight: 500; color: #FF3B30; cursor: pointer;
    transition: all 0.15s;
}
.notes-delete-btn:hover { background: #FEF2F2; border-color: #FF3B30; }

/* ---- Deleted notes sidebar entry ---- */
.notes-deleted-entry {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px; border-radius: 10px; cursor: pointer;
    transition: all 0.15s; margin-top: 8px;
    border-top: 1px solid #F0F0F0; padding-top: 12px;
}
.notes-deleted-entry:hover { background: #F0F0F2; }
.notes-deleted-entry.active { background: #FFF3E0; }
.notes-deleted-entry-icon {
    width: 28px; height: 28px; border-radius: 8px;
    background: #FEF2F2; display: flex; align-items: center;
    justify-content: center; flex-shrink: 0;
}
.notes-deleted-entry-icon i { color: #FF3B30; font-size: 12px; }
.notes-deleted-entry-text {
    flex: 1; min-width: 0;
}
.notes-deleted-entry-title {
    font-size: 13px; font-weight: 600; color: #1d1d1f;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.notes-deleted-entry-count {
    font-size: 11px; color: #8E8E93;
}
.notes-deleted-entry-badge {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 18px; height: 18px; border-radius: 9px;
    background: #FF3B30; color: #fff; font-size: 10px;
    font-weight: 700; padding: 0 5px; flex-shrink: 0;
}

/* ---- Deleted note item ---- */
.notes-deleted-item {
    padding: 10px 12px; border-radius: 10px;
    transition: all 0.15s; margin-bottom: 2px;
    border: 1px solid #F0F0F0; background: #fff;
}
.notes-deleted-item-title {
    font-size: 14px; font-weight: 600; color: #1d1d1f;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    margin-bottom: 4px;
}
.notes-deleted-item-meta {
    display: flex; align-items: center; justify-content: space-between;
    gap: 6px; margin-bottom: 8px;
}
.notes-deleted-item-time {
    font-size: 11px; color: #8E8E93;
}
.notes-deleted-item-remaining {
    font-size: 11px; color: #FF9500; font-weight: 500;
}
.notes-deleted-item-actions {
    display: flex; gap: 6px;
}
.notes-restore-btn {
    display: flex; align-items: center; gap: 4px; padding: 5px 12px;
    border-radius: 8px; border: 1px solid #34C759; background: #fff;
    font-size: 12px; font-weight: 500; color: #34C759; cursor: pointer;
    transition: all 0.15s;
}
.notes-restore-btn:hover { background: #F0FFF4; }
.notes-permanent-delete-btn {
    display: flex; align-items: center; gap: 4px; padding: 5px 12px;
    border-radius: 8px; border: 1px solid #E5E5EA; background: #fff;
    font-size: 12px; font-weight: 500; color: #FF3B30; cursor: pointer;
    transition: all 0.15s;
}
.notes-permanent-delete-btn:hover { background: #FEF2F2; border-color: #FF3B30; }
.notes-empty-recycle-btn {
    display: flex; align-items: center; gap: 4px; padding: 5px 12px;
    border-radius: 8px; border: 1px solid #E5E5EA; background: #fff;
    font-size: 12px; font-weight: 500; color: #8E8E93; cursor: pointer;
    transition: all 0.15s; margin-top: 8px;
}
.notes-empty-recycle-btn:hover { background: #F5F5F7; color: #FF3B30; border-color: #FF3B30; }

/* ---- 深色主题（html[data-theme] 由应用框架同步到 iframe 文档）---- */
html[data-theme='dark'] {
    --notes-shell-bg: #1e1e1e;
    --notes-shell-border: rgba(255, 255, 255, 0.10);
    --notes-toolbar-bg: #232326;
}
html[data-theme='dark'] .notes-fixed-toolbar {
    border-bottom-color: rgba(255, 255, 255, 0.08);
}
`;

class NotesEntryWidget extends AgentOperableHTMLElement {
    constructor() {
        super();
        this._t = createTranslatorForNotes();
        this._locale = undefined;
        this._settingUnsubscribe = null;
        this.notes = [];
        this.allNotes = [];
        this.tags = [];
        this.currentNoteId = null;
        this.currentNoteContent = '';
        this.searchQuery = '';
        this.tagFilter = null;
        this.sortBy = 'updatedAt';
        this._displayedCount = 0;
        this._loadingMore = false;
        this._fullRenderList = [];
        this._editorReady = null;
        this._resolveEditor = null;
        this._autoSaveTimer = null;
        this._isSaving = false;
        this._scrollObserver = null;
        this._toolbarResizeObserver = null;
        this._selectedHTML = '';
        this._turndownService = null;
        this._toolbarHiddenLevel = 0;
        this._onNotesChanged = null;
        this._onTagsChanged = null;
        this._onDeletedNotesChanged = null;
        this._selectedText = '';
        this.deletedNotes = [];
        this.showDeletedView = false;
        this._originalNoteTitle = '';
        this._originalNoteContent = '';
        this._themeObserver = null;
        this._clipboardRequestId = 0;
    }

    async connectedCallback() {
        this._injectStyles();
        // 先加载语言设置再渲染，避免首帧出现错误语言
        let setting;
        try {
            setting = await window.settingAPI?.loadSettingObject?.();
        } catch {
            setting = undefined;
        }
        this._applyLocaleSetting(setting);
        // 等待设置加载期间元素可能已被移除，避免对脱离 DOM 的元素继续渲染
        if (!this.isConnected) return;
        this._subscribeLocaleChanges();
        this._render();
        this._bindCore();
        this._loadInitialData();
    }

    disconnectedCallback() {
        if (this._settingUnsubscribe) {
            this._settingUnsubscribe();
            this._settingUnsubscribe = null;
        }
        if (this._autoSaveTimer) clearTimeout(this._autoSaveTimer);
        if (this._scrollObserver) this._scrollObserver.disconnect();
        if (this._toolbarResizeObserver) {
            this._toolbarResizeObserver.disconnect();
            this._toolbarResizeObserver = null;
        }
        if (this._themeObserver) {
            this._themeObserver.disconnect();
            this._themeObserver = null;
        }
        if (this._codeHighlightTimer) {
            clearTimeout(this._codeHighlightTimer);
            this._codeHighlightTimer = null;
        }
        // 右键菜单不随笔记关闭自动消失（挂在本 widget 上），需显式清理
        this._dismissEditorContextMenu();
        this._dismissNoteContextMenu();
        if (window.tinymce) tinymce.remove('#notes-editor');
        if (this._onNotesChanged) {
            window.applicationAPI.unsubscribe('notesChanged', this._onNotesChanged);
        }
        if (this._onTagsChanged) {
            window.applicationAPI.unsubscribe('tagsChanged', this._onTagsChanged);
        }
        if (this._onDeletedNotesChanged) {
            window.applicationAPI.unsubscribe('deletedNotesChanged', this._onDeletedNotesChanged);
        }
    }

    _injectStyles() {
        if (document.getElementById('notes-custom-css')) return;
        const s = document.createElement('style');
        s.id = 'notes-custom-css';
        s.textContent = NOTES_CSS;
        document.head.appendChild(s);
    }

    _applyLocaleSetting(setting) {
        this._locale = resolveRendererLocale(setting);
        this._t = createTranslatorForNotes(setting);
    }

    /* 语言设置变化时重建翻译器并按新语言重建界面。
       编辑态（TinyMCE 编辑器）属于用户输入态，不重建编辑器，仅刷新左侧列表 */
    _subscribeLocaleChanges() {
        if (this._settingUnsubscribe) return;
        const unsubscribe = window.settingAPI?.onSettingChanged?.((setting) => {
            if (!this.isConnected) return;
            if (resolveRendererLocale(setting) === this._locale) return;
            this._applyLocaleSetting(setting);
            if (this.currentNoteId) {
                this._reloadNoteList();
                this._updateDeletedBadge();
                return;
            }
            this._render();
            this._bindCoreDom();
            this._reloadNoteList();
            if (this.showDeletedView) {
                this._renderDeletedView();
            } else {
                this._renderCardGrid();
            }
            this._updateDeletedBadge();
        });
        if (typeof unsubscribe === 'function') {
            this._settingUnsubscribe = unsubscribe;
        }
    }

    // ─── Agent 支持 ───

    getAgentInstruct() {
        return this._t('agent.instruct');
    }

    getToolset() {
        const toolset = new RendererToolset('notes');
        const listTool = new RendererTool(
            'listCurrentNotes',
            this._t('renderer.tool.listCurrentNotes.description'),
            z.object({})
        );
        listTool.setExecutor(async () => {
            return JSON.stringify(
                this.notes.map((n) => ({
                    id: n.id,
                    title: n.title,
                    tags: n.tags,
                    updatedAt: n.updatedAt
                }))
            );
        });
        toolset.addTool(listTool);
        return toolset;
    }

    // ─── 渲染骨架 ───

    _render() {
        this.innerHTML = `
        <div class="notes-root relative w-full h-full select-none" style="display:flex;">
            <splitter-widget class="w-full h-full" initial-width="320">
                <div slot="left" class="notes-left w-full h-full overflow-hidden">
                    <div class="flex flex-col h-full">
                        <div style="padding:36px 20px 0;">
                            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
                                <h2 style="font-size:20px;font-weight:700;color:#1d1d1f;">${this._t('app.name')}</h2>
                                <button id="notes-new-btn" class="notes-new-btn">
                                    <i class="fa-solid fa-plus" style="font-size:11px;"></i>
                                    <span>${this._t('renderer.note.new')}</span>
                                </button>
                            </div>
                            <div class="notes-search">
                                <i class="fa-solid fa-magnifying-glass notes-search-icon"></i>
                                <input id="notes-search-input" type="text" placeholder="${this._t('renderer.note.search.placeholder')}" class="notes-search-input" />
                            </div>
                            <div id="notes-filter-bar" class="notes-filter-bar">
                                <button id="notes-sort-btn" class="notes-filter-btn">
                                    <i class="fa-solid fa-arrow-down-short-wide"></i>
                                    <span id="notes-sort-label">${this._t(SORT_LABELS[this.sortBy] || 'renderer.note.sort.updatedAt')}</span>
                                </button>
                                <button id="notes-tag-filter-btn" class="notes-filter-btn">
                                    <i class="fa-solid fa-tag"></i>
                                    <span id="notes-tag-filter-label">${this._t(this.tagFilter || 'renderer.note.tag.all')}</span>
                                </button>
                            </div>
                        </div>
                        <div id="notes-list" class="flex-1 overflow-y-auto notes-scroll" style="padding:0 20px;"></div>
                        <div id="notes-deleted-entry" class="notes-deleted-entry" style="padding-left:20px;padding-right:20px;">
                            <div class="notes-deleted-entry-icon">
                                <i class="fa-regular fa-trash-can"></i>
                            </div>
                            <div class="notes-deleted-entry-text">
                                <div class="notes-deleted-entry-title">${this._t('renderer.note.deleted.entry')}</div>
                                <div class="notes-deleted-entry-count" id="notes-deleted-count">${this._t('renderer.note.count.notes', { count: 0 })}</div>
                            </div>
                            <span class="notes-deleted-entry-badge" id="notes-deleted-badge" style="display:none;">0</span>
                        </div>
                    </div>
                </div>
                <div slot="right" class="w-full h-full overflow-hidden" style="background:#fff;">
                    <div id="notes-main" class="flex flex-col h-full"></div>
                </div>
            </splitter-widget>
            <div id="notes-floating-toolbar" class="notes-floating-toolbar hidden"></div>
            <div id="notes-dropdown" class="notes-dropdown hidden"></div>
            <div id="notes-tag-menu" class="notes-tag-menu hidden"></div>
        </div>`;
    }

    _bindCore() {
        this._bindCoreDom();
        this._subscribeEvents();
    }

    _bindCoreDom() {
        // 新建笔记
        this.querySelector('#notes-new-btn').addEventListener('click', () => this._createNote());

        // 搜索
        this.querySelector('#notes-search-input').addEventListener('input', (e) => {
            this.searchQuery = e.target.value;
            this._reloadNoteList();
        });

        // 排序按钮
        this.querySelector('#notes-sort-btn').addEventListener('click', (e) => {
            this._showSortDropdown(e.currentTarget);
        });

        // 标签过滤按钮
        this.querySelector('#notes-tag-filter-btn').addEventListener('click', (e) => {
            this._showTagFilterDropdown(e.currentTarget);
        });

        // 回收站入口
        this.querySelector('#notes-deleted-entry').addEventListener('click', () => this._toggleDeletedView());

        // 订阅事件
        this._subscribeEvents();
    }

    _subscribeEvents() {
        this._onNotesChanged = () => this._refreshNotes();
        this._onTagsChanged = () => this._refreshTags();
        this._onDeletedNotesChanged = () => this._refreshDeletedNotes();
        window.applicationAPI.subscribe('notesChanged', this._onNotesChanged);
        window.applicationAPI.subscribe('tagsChanged', this._onTagsChanged);
        window.applicationAPI.subscribe('deletedNotesChanged', this._onDeletedNotesChanged);
    }

    // ─── 数据加载 ───

    async _loadInitialData() {
        const [notes, tags, deletedNotes] = await Promise.all([
            window.applicationAPI.call('getNotes', { sortBy: this.sortBy }),
            window.applicationAPI.call('getTags'),
            window.applicationAPI.call('getDeletedNotes')
        ]);
        this.allNotes = notes || [];
        this.tags = tags || [];
        this.deletedNotes = deletedNotes || [];
        this._applyFilters();
        this._renderCardGrid();
        this._updateDeletedBadge();
    }

    async _refreshNotes() {
        const notes = await window.applicationAPI.call('getNotes', { sortBy: this.sortBy });
        this.allNotes = notes || [];
        this._applyFilters();
        if (this.currentNoteId) {
            this._updateNoteListHighlight();
        } else if (this.showDeletedView) {
            // 在回收站视图时不重新渲染卡片网格
        } else {
            this._renderCardGrid();
        }
    }

    async _refreshTags() {
        const tags = await window.applicationAPI.call('getTags');
        this.tags = tags || [];
    }

    _applyFilters() {
        let notes = [...this.allNotes];
        if (this.searchQuery) {
            const q = this.searchQuery.toLowerCase();
            notes = notes.filter((n) => n.title.toLowerCase().includes(q));
        }
        if (this.tagFilter) {
            notes = notes.filter((n) => n.tags.includes(this.tagFilter));
        }
        this.notes = notes;
        this._reloadNoteList();
    }

    // ─── 笔记列表 ───

    _getTimeGroup(timestamp) {
        const now = new Date();
        const date = new Date(timestamp);
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yesterday = new Date(today.getTime() - 86400000);
        if (date >= today) return 'today';
        if (date >= yesterday) return 'yesterday';
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    _buildRenderList() {
        const groups = new Map();
        for (const note of this.notes) {
            const group = note.isPinned ? 'pinned' : this._getTimeGroup(note.updatedAt);
            if (!groups.has(group)) groups.set(group, []);
            groups.get(group).push(note);
        }
        // 分组头排序：置顶 > 今天 > 昨天 > 日期降序
        const sortedHeaders = [...groups.keys()].sort((a, b) => {
            if (a === 'pinned') return -1;
            if (b === 'pinned') return 1;
            if (a === 'today') return -1;
            if (b === 'today') return 1;
            if (a === 'yesterday') return -1;
            if (b === 'yesterday') return 1;
            // 都是 YYYY-MM-DD 格式，字符串降序 = 日期降序
            return b.localeCompare(a);
        });
        const list = [];
        for (const header of sortedHeaders) {
            const items = groups.get(header);
            list.push({ type: 'header', text: this._t(GROUP_LABEL_KEYS[header] || header) });
            for (const item of items) {
                list.push({ type: 'note', data: item });
            }
        }
        return list;
    }

    _reloadNoteList() {
        this._fullRenderList = this._buildRenderList();
        this._displayedCount = 0;
        if (this._scrollObserver) this._scrollObserver.disconnect();

        const container = this.querySelector('#notes-list');
        if (!container) return;
        container.innerHTML = '';

        if (this._fullRenderList.length === 0) {
            container.innerHTML = `<div class="notes-empty"><i class="fa-regular fa-note-sticky"></i><p>${this._t('renderer.note.empty.noNotes')}</p></div>`;
            return;
        }

        const slice = this._fullRenderList.slice(0, NOTE_PAGE_SIZE);
        this._renderListItems(container, slice);
        this._displayedCount = slice.length;

        if (this._fullRenderList.length > NOTE_PAGE_SIZE) {
            const sentinel = document.createElement('div');
            sentinel.id = 'notes-list-sentinel';
            sentinel.style.cssText = 'height:1px;';
            container.appendChild(sentinel);
            this._setupScrollObserver(container, sentinel);
        }
    }

    _renderListItems(container, items) {
        const frag = document.createDocumentFragment();
        for (const item of items) {
            if (item.type === 'header') {
                const h = document.createElement('div');
                h.className = 'notes-group-header';
                h.textContent = item.text;
                frag.appendChild(h);
            } else {
                const note = item.data;
                const div = document.createElement('div');
                div.className = `notes-item ${note.id === this.currentNoteId ? 'active' : ''}`;
                div.dataset.noteId = note.id;
                const preview = this._extractPreview(note);
                const tagHtml = note.tags
                    .slice(0, 2)
                    .map((t) => {
                        const color = this._getTagColor(t);
                        return `<span class="notes-tag" style="background:${color}18;color:${color}">${t}</span>`;
                    })
                    .join('');
                div.innerHTML = `
                    <div class="notes-item-title">${this._escapeHtml(note.title || this._t('renderer.note.untitled'))}</div>
                    <div class="notes-item-preview">${this._escapeHtml(preview)}</div>
                    <div class="notes-item-meta">
                        <div class="notes-item-tags">${tagHtml}</div>
                        <span class="notes-item-time">${this._formatRelativeTime(note.updatedAt)}</span>
                    </div>`;
                div.addEventListener('click', () => this._openNote(note.id));
                div.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this._showNoteContextMenu(e.clientX, e.clientY, note);
                });
                frag.appendChild(div);
            }
        }
        container.appendChild(frag);
    }

    _setupScrollObserver(container, sentinel) {
        this._scrollObserver = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        this._loadMoreNotes(container);
                    }
                }
            },
            { root: container, threshold: 0.1 }
        );
        this._scrollObserver.observe(sentinel);
    }

    _loadMoreNotes(container) {
        if (this._loadingMore) return;
        if (this._displayedCount >= this._fullRenderList.length) {
            if (this._scrollObserver) this._scrollObserver.disconnect();
            const sentinel = container.querySelector('#notes-list-sentinel');
            if (sentinel) sentinel.remove();
            return;
        }
        this._loadingMore = true;
        const next = this._fullRenderList.slice(this._displayedCount, this._displayedCount + NOTE_PAGE_SIZE);
        // Remove sentinel before adding new items
        const sentinel = container.querySelector('#notes-list-sentinel');
        if (sentinel) sentinel.remove();
        this._renderListItems(container, next);
        this._displayedCount += next.length;
        // Re-add sentinel if more items
        if (this._displayedCount < this._fullRenderList.length) {
            const newSentinel = document.createElement('div');
            newSentinel.id = 'notes-list-sentinel';
            newSentinel.style.cssText = 'height:1px;';
            container.appendChild(newSentinel);
            this._setupScrollObserver(container, newSentinel);
        }
        this._loadingMore = false;
    }

    _updateNoteListHighlight() {
        this.querySelectorAll('.notes-item').forEach((el) => {
            el.classList.toggle('active', el.dataset.noteId === this.currentNoteId);
        });
    }

    // ─── 卡片网格视图 ───

    // ─── 笔记条目右键菜单 ───

    /** 笔记条目右键菜单（重命名 / 删除），样式复用全局 ctx-menu 组件 */
    _showNoteContextMenu(x, y, note) {
        this._dismissNoteContextMenu();
        this._dismissEditorContextMenu(); // 与编辑区右键菜单互斥

        const menu = document.createElement('div');
        menu.id = 'note-context-menu';
        menu.className = 'ctx-menu';
        menu.style.minWidth = '160px';
        menu.innerHTML = `
            <button class="ctx-item" data-action="rename">
                <span class="ctx-icon-sm"><i class="fa-solid fa-pen"></i></span>
                <span class="ctx-label">${this._t('renderer.note.rename')}</span>
            </button>
            <div class="ctx-divider"></div>
            <button class="ctx-item danger" data-action="delete">
                <span class="ctx-icon-sm"><i class="fa-regular fa-trash-can"></i></span>
                <span class="ctx-label">${this._t('renderer.note.delete')}</span>
            </button>`;

        this.appendChild(menu);
        // notes 应用 iframe 无 fixed 包含块建立者，fixed 以 iframe 视口为原点
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;

        requestAnimationFrame(() => {
            const rect = menu.getBoundingClientRect();
            const vw = this.ownerDocument.documentElement.clientWidth;
            const vh = this.ownerDocument.documentElement.clientHeight;
            if (rect.right > vw - 8) menu.style.left = `${vw - rect.width - 8}px`;
            if (rect.bottom > vh - 8) menu.style.top = `${vh - rect.height - 8}px`;
        });

        // 阻止菜单项 mousedown 抢焦点（重命名依赖打开后聚焦标题输入框）
        menu.querySelectorAll('[data-action]').forEach((btn) => {
            btn.addEventListener('pointerdown', (e) => e.preventDefault());
            btn.addEventListener('mousedown', (e) => e.preventDefault());
        });
        menu.querySelector('[data-action="rename"]').addEventListener('click', () => {
            this._dismissNoteContextMenu();
            this._startInlineRename(note);
        });

        menu.querySelector('[data-action="delete"]').addEventListener('click', () => {
            this._dismissNoteContextMenu();
            this._deleteNoteFromList(note);
        });

        const dismissHandler = (e) => {
            if (!menu.contains(e.target)) {
                this._dismissNoteContextMenu();
                this.ownerDocument.removeEventListener('mousedown', dismissHandler, true);
            }
        };
        setTimeout(() => this.ownerDocument.addEventListener('mousedown', dismissHandler, true), 0);
    }

    _dismissNoteContextMenu() {
        this.querySelector('#note-context-menu')?.remove();
    }

    // ─── 编辑区自定义右键菜单 ───

    /** 剪贴板读取：优先 navigator.clipboard.readText（编辑器聚焦时 Chromium
     *  允许读取，notes iframe 实测可用）；不可用时回退事件桥 */
    _readClipboardText() {
        const w = this.ownerDocument.defaultView;
        if (w.navigator.clipboard?.readText) {
            return w.navigator.clipboard
                .readText()
                .then((text) => (typeof text === 'string' ? text : ''))
                .catch(() => this._readClipboardTextViaBridge());
        }
        return this._readClipboardTextViaBridge();
    }

    /** 事件桥回退路径（preload od-clipboard-read） */
    _readClipboardTextViaBridge() {
        const w = this.ownerDocument.defaultView;
        if (w.childFrameClipboard?.readText) {
            return w.childFrameClipboard
                .readText()
                .then((text) => (typeof text === 'string' ? text : ''))
                .catch(() => '');
        }
        return new Promise((resolve) => {
            const requestId = ++this._clipboardRequestId;
            const onResult = (event) => {
                const detail = event?.detail;
                if (!detail || detail.requestId !== requestId) return;
                w.removeEventListener('od-clipboard-read-result', onResult);
                resolve(typeof detail.text === 'string' ? detail.text : '');
            };
            w.addEventListener('od-clipboard-read-result', onResult);
            w.dispatchEvent(new CustomEvent('od-clipboard-read', { detail: { requestId } }));
            // 桥不可用兜底：超时返回空串，粘贴流程正常收尾
            setTimeout(() => {
                w.removeEventListener('od-clipboard-read-result', onResult);
                resolve('');
            }, 1500);
        });
    }

    /** 剪贴板写入：优先 contextBridge API，回退事件桥 */
    _writeClipboardText(text) {
        const w = this.ownerDocument.defaultView;
        if (w.childFrameClipboard?.writeText) {
            w.childFrameClipboard.writeText(text).catch(() => {});
            return;
        }
        w.dispatchEvent(new CustomEvent('od-clipboard-write', { detail: { text } }));
    }

    /**
     * 编辑区右键菜单：剪切/复制/粘贴/粘贴为纯文本/全选。
     * 覆盖 TinyMCE iframe 文档的原生 contextmenu。
     */
    _showEditorContextMenu(x, y, editor) {
        this._dismissEditorContextMenu();
        this._dismissNoteContextMenu(); // 与列表右键菜单互斥

        const hasSelection = editor.selection.getContent({ format: 'text' }).length > 0;
        const menu = document.createElement('div');
        menu.id = 'notes-editor-context-menu';
        menu.className = 'ctx-menu';
        menu.style.minWidth = '170px';
        const item = (action, icon, label, disabled = false) =>
            `<button class="ctx-item${disabled ? ' disabled' : ''}" data-action="${action}">` +
            `<span class="ctx-icon-sm"><i class="fa-solid ${icon}"></i></span>` +
            `<span class="ctx-label">${this._t(label)}</span></button>`;
        menu.innerHTML =
            item('cut', 'fa-scissors', 'renderer.note.menu.cut', !hasSelection) +
            item('copy', 'fa-copy', 'renderer.note.menu.copy', !hasSelection) +
            item('paste', 'fa-clipboard', 'renderer.note.menu.paste') +
            item('paste-plain', 'fa-clipboard-list', 'renderer.note.menu.pastePlain') +
            '<div class="ctx-divider"></div>' +
            item('selectall', 'fa-object-group', 'renderer.note.menu.selectAll');

        this.appendChild(menu);
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
        requestAnimationFrame(() => {
            const rect = menu.getBoundingClientRect();
            const vw = this.ownerDocument.documentElement.clientWidth;
            const vh = this.ownerDocument.documentElement.clientHeight;
            if (rect.right > vw - 8) menu.style.left = `${Math.max(8, vw - rect.width - 8)}px`;
            if (rect.bottom > vh - 8) menu.style.top = `${Math.max(8, vh - rect.height - 8)}px`;
        });

        const exec = async (action) => {
            this._dismissEditorContextMenu();
            editor.focus();
            switch (action) {
                case 'cut': {
                    const text = editor.selection.getContent({ format: 'text' });
                    if (text) {
                        this._writeClipboardText(text);
                        // TinyMCE 原生剪切等价：删除选区
                        editor.execCommand('Delete');
                    }
                    break;
                }
                case 'copy': {
                    const text = editor.selection.getContent({ format: 'text' });
                    if (text) this._writeClipboardText(text);
                    break;
                }
                case 'paste': {
                    // 剪贴板是完整 markdown 围栏 → 直接转代码块（与原生 paste 同语义）；
                    // 普通文本走 editor.insertContent（TinyMCE 官方插入管线，处理
                    // 选区恢复/undo/input 事件，多行按 forced_root_block 生成块级结构）。
                    // 不用 execCommand('insertText')——它透传原生 document.execCommand，
                    // 跨 iframe 焦点恢复抖动时会静默失败。
                    const text = await this._readClipboardText();
                    if (text) {
                        if (editor.selection.getContent({ format: 'text' })) editor.execCommand('Delete');
                        const fence = this._parseCodeFence(text);
                        if (fence) {
                            this._insertFencedCodeBlock(editor, fence.lang, fence.code);
                        } else {
                            editor.insertContent(this._escapeHtml(text).replace(/\r\n/g, '\n').replace(/\n/g, '<br>'));
                        }
                    }
                    break;
                }
                case 'paste-plain': {
                    const text = await this._readClipboardText();
                    if (text) {
                        if (editor.selection.getContent({ format: 'text' })) editor.execCommand('Delete');
                        // 纯文本路径：转义后原样插入（换行转 <br>），不做围栏转换
                        editor.insertContent(this._escapeHtml(text).replace(/\r\n/g, '\n').replace(/\n/g, '<br>'));
                    }
                    break;
                }
                case 'selectall':
                    editor.execCommand('SelectAll');
                    break;
            }
        };

        menu.querySelectorAll('[data-action]').forEach((btn) => {
            // 阻止焦点转移：mousedown 把焦点抢到按钮上会让 TinyMCE iframe
            // 失焦丢选区，随后的 insertText/execCommand 全部落空
            btn.addEventListener('pointerdown', (e) => e.preventDefault());
            btn.addEventListener('mousedown', (e) => e.preventDefault());
            btn.addEventListener('click', () => {
                if (btn.classList.contains('disabled')) return;
                exec(btn.dataset.action);
            });
        });

        const dismissHandler = (e) => {
            if (!menu.contains(e.target)) {
                this._dismissEditorContextMenu();
                // 点击可能发生在 TinyMCE iframe 内（不冒泡到应用文档），
                // 两层文档都要摘掉监听
                this.ownerDocument.removeEventListener('mousedown', dismissHandler, true);
                const edoc = editor.getDoc();
                edoc?.removeEventListener('mousedown', dismissHandler, true);
            }
        };
        // 右键若发生在编辑 iframe 内，后续 mousedown 也在 iframe 文档里
        // （iframe 间不冒泡），两份监听都挂
        setTimeout(() => {
            this.ownerDocument.addEventListener('mousedown', dismissHandler, true);
            editor.getDoc()?.addEventListener('mousedown', dismissHandler, true);
        }, 0);
    }

    _dismissEditorContextMenu() {
        this.querySelector('#notes-editor-context-menu')?.remove();
    }

    /** 列表内重命名：打开笔记后聚焦标题输入框并全选 */
    async _startInlineRename(note) {
        await this._openNote(note.id);
        const titleInput = this.querySelector('#notes-title-input');
        if (!titleInput) return;
        titleInput.focus();
        titleInput.select();
    }

    /** 列表/卡片上的删除：带确认弹窗（与编辑器删除按钮同一套确认与刷新） */
    async _deleteNoteFromList(note) {
        const confirmed = await showConfirmModal({
            icon: 'fa-trash-can',
            iconBg: '#FEF2F2',
            iconColor: '#FF3B30',
            title: this._t('renderer.note.note.delete.confirm.title'),
            message: this._t('renderer.note.note.delete.confirm.message'),
            confirmText: this._t('renderer.note.common.delete'),
            danger: true
        });
        if (!confirmed) return;
        if (this.currentNoteId === note.id) {
            // 当前正打开的笔记：走编辑器删除路径（清编辑器状态）
            await this._confirmDeleteNote();
            return;
        }
        await window.applicationAPI.call('deleteNote', note.id);
        await this._refreshNotes();
        await this._refreshDeletedNotes();
    }

    _renderCardGrid() {
        const main = this.querySelector('#notes-main');
        if (!main) return;

        if (this.notes.length === 0) {
            main.innerHTML = `
            <div class="notes-empty" style="padding-top:80px;">
                <i class="fa-regular fa-note-sticky"></i>
                <p>${this._t('renderer.note.empty.createFirst')}</p>
            </div>`;
            return;
        }

        let html = `
        <div style="padding:36px 24px 16px;display:flex;align-items:center;justify-content:space-between;">
            <h2 style="font-size:18px;font-weight:700;color:#1d1d1f;">${this._t('renderer.note.allNotes')}</h2>
            <span style="font-size:13px;color:#8E8E93;">${this._t('renderer.note.count.notesShort', { count: this.notes.length })}</span>
        </div>
        <div class="notes-card-grid" style="padding:0 24px 24px;overflow-y:auto;" id="notes-card-container">`;

        for (const note of this.notes) {
            const preview = this._extractPreview(note);
            const tagHtml = note.tags
                .slice(0, 3)
                .map((t) => {
                    const color = this._getTagColor(t);
                    return `<span class="notes-tag" style="background:${color}18;color:${color}">${t}</span>`;
                })
                .join('');
            html += `
            <div class="notes-card" data-note-id="${note.id}">
                <div class="notes-card-title">${this._escapeHtml(note.title || this._t('renderer.note.untitled'))}</div>
                <div class="notes-card-preview">${this._escapeHtml(preview)}</div>
                <div class="notes-card-meta">
                    <div class="notes-card-tags">${tagHtml}</div>
                    <span class="notes-card-time">${this._formatRelativeTime(note.updatedAt)}</span>
                </div>
            </div>`;
        }
        html += `</div>`;
        main.innerHTML = html;

        main.querySelectorAll('.notes-card').forEach((card) => {
            card.addEventListener('click', () => this._openNote(card.dataset.noteId));
            card.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const note = this.notes.find((n) => n.id === card.dataset.noteId);
                if (note) this._showNoteContextMenu(e.clientX, e.clientY, note);
            });
        });
    }

    // ─── 打开/关闭笔记 ───

    async _openNote(noteId) {
        if (this.currentNoteId === noteId) return;
        if (this.currentNoteId) await this._autoSave();

        this.currentNoteId = noteId;
        const main = this.querySelector('#notes-main');
        main.style.opacity = '0';
        main.style.transform = 'translateY(8px)';
        main.style.transition = 'opacity 0.2s, transform 0.2s';

        setTimeout(async () => {
            await this._renderEditor();
            this._updateNoteListHighlight();
            requestAnimationFrame(() => {
                main.style.opacity = '1';
                main.style.transform = 'translateY(0)';
            });
        }, 200);
    }

    async _closeNote() {
        await this._autoSave();
        this.currentNoteId = null;
        this._hideFloatingToolbar();

        const main = this.querySelector('#notes-main');
        main.style.opacity = '0';
        main.style.transform = 'translateY(8px)';

        setTimeout(() => {
            this._renderCardGrid();
            requestAnimationFrame(() => {
                main.style.opacity = '1';
                main.style.transform = 'translateY(0)';
            });
        }, 200);
    }

    // ─── 编辑器 ───

    async _renderEditor() {
        const note =
            this.notes.find((n) => n.id === this.currentNoteId) ||
            this.allNotes.find((n) => n.id === this.currentNoteId);
        if (!note) return;

        this.currentNoteContent = await window.applicationAPI.call('getNoteContent', note.id);
        // 保存原始内容，用于检测变化
        this._originalNoteTitle = note.title || '';
        this._originalNoteContent = this.currentNoteContent;

        const main = this.querySelector('#notes-main');
        const tagHtml = note.tags
            .map((t) => {
                const color = this._getTagColor(t);
                return `<span class="notes-tag removable" data-tag="${t}" style="background:${color}18;color:${color}">${t}<i class="fa-solid fa-xmark"></i></span>`;
            })
            .join('');

        main.innerHTML = `
        <div class="notes-editor-container flex flex-col h-full">
            <div class="notes-editor-header">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                    <div style="display:flex;gap:8px;">
                        <button id="notes-close-editor-btn" class="notes-close-btn">
                            <i class="fa-solid fa-chevron-left" style="font-size:10px;"></i> ${this._t('renderer.note.editor.back')}
                        </button>
                        <button id="notes-pin-note-btn" class="notes-filter-btn" style="font-size:12px;${note.isPinned ? 'background:#FFF3E0;border-color:#FFA726;color:#E65100;' : ''}">
                            <i class="fa-solid fa-thumbtack" style="font-size:10px;"></i>
                            <span>${note.isPinned ? this._t('renderer.note.pin.pinned') : this._t('renderer.note.pin.unpinned')}</span>
                        </button>
                        <button id="notes-delete-note-btn" class="notes-delete-btn">
                            <i class="fa-regular fa-trash-can" style="font-size:11px;"></i> ${this._t('renderer.note.delete')}
                        </button>
                    </div>
                </div>
                <input id="notes-title-input" type="text" class="notes-title-input"
                       value="${this._escapeAttr(note.title)}" placeholder="${this._t('renderer.note.title.placeholder')}" />
                <div id="notes-editor-tags" class="notes-editor-tags">
                    ${tagHtml}
                    <button id="notes-add-tag-btn" class="notes-add-tag-btn">
                        <i class="fa-solid fa-plus" style="font-size:10px;"></i> ${this._t('renderer.note.tag.add')}
                    </button>
                </div>
            </div>
            <div class="notes-editor-shell">
                <div id="notes-fixed-toolbar" class="notes-fixed-toolbar"></div>
                <div class="notes-editor-body">
                    <textarea id="notes-editor">${this._escapeHtml(this.currentNoteContent)}</textarea>
                </div>
            </div>
        </div>`;

        this._initTinyMCE();
        this._bindEditorEvents();
    }

    _getEditorThemeColors() {
        const isDark = document.documentElement.dataset.theme === 'dark';
        return {
            bg: isDark ? '#1e1e1e' : '#fff',
            text: isDark ? '#e5e5e7' : '#1d1d1f',
            heading: isDark ? '#f5f5f7' : '#1d1d1f',
            blockquoteBorder: '#FFA726',
            blockquoteText: isDark ? '#8e8e93' : '#8E8E93'
        };
    }

    _initTinyMCE() {
        if (window.tinymce) tinymce.remove('#notes-editor');

        this._editorReady = new Promise((resolve) => {
            this._resolveEditor = resolve;
        });

        const colors = this._getEditorThemeColors();

        tinymce.init({
            selector: '#notes-editor',
            height: '100%',
            menubar: false,
            branding: false,
            statusbar: false,
            resize: false,
            // 英文使用内置文案；仅中文环境加载语言包
            ...(this._locale === 'zh-CN' ? { language: 'zh_CN' } : {}),
            skin: false,
            content_css: false,
            content_style:
                contentCss +
                '\n' +
                contentUiCss +
                `
                body { font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
                       font-size: 15px; line-height: 1.7; color: ${colors.text}; padding: 8px; margin: 0; background: ${colors.bg}; }
                h1 { font-size: 24px; font-weight: 700; margin: 16px 0 8px; color: ${colors.heading}; }
                h2 { font-size: 20px; font-weight: 700; margin: 14px 0 6px; color: ${colors.heading}; }
                h3 { font-size: 17px; font-weight: 600; margin: 12px 0 4px; color: ${colors.heading}; }
                h4 { font-size: 15px; font-weight: 600; margin: 10px 0 4px; color: ${colors.heading}; }
                h5 { font-size: 14px; font-weight: 600; margin: 8px 0 4px; color: ${colors.heading}; }
                h6 { font-size: 13px; font-weight: 600; margin: 8px 0 4px; color: ${colors.heading}; }
                blockquote { border-left: 3px solid ${colors.blockquoteBorder}; padding-left: 12px; color: ${colors.blockquoteText}; margin: 8px 0; }
                p { margin: 4px 0; }
            `,
            license_key: 'gpl',
            highlight_on_focus: false,
            toolbar: false,
            // 禁用链接快捷工具条（选中/触摸长按链接文字时弹出的「链接... Ctrl+K」），
            // 避免与自定义右键菜单在触摸长按场景同时弹出
            link_context_toolbar: false,
            // 禁用 TinyMCE 内置右键菜单（link 插件注册的 contextmenu 项：
            // 光标落在 <a> 内时右键会弹「链接... Ctrl+K」菜单，与自定义
            // 右键菜单叠加）——编辑区右键完全由自定义菜单接管
            contextmenu: false,
            plugins: ['advlist', 'autolink', 'lists', 'link', 'image', 'charmap', 'code', 'table', 'wordcount'],
            setup: (editor) => {
                editor.on('selectionchange', () => {
                    this._onEditorSelectionChange(editor);
                    // 光标离开的代码块在此补上完整高亮（编辑中不动 DOM）
                    this._scheduleCodeBlockHighlight(editor);
                });
                editor.on('input', () => {
                    this._scheduleAutoSave();
                });
                // 粘贴完整 markdown 围栏文本（```lang\n...\n```）时自动转为代码块；
                // 只拦截原生粘贴，「粘贴为纯文本」走 insertText 不经过这里
                editor.on('paste', (e) => {
                    this._handleCodeFencePaste(editor, e);
                });
                // 编辑区自定义右键菜单（剪切/复制/粘贴/粘贴为纯文本/全选）
                editor.on('contextmenu', (e) => {
                    e.preventDefault();
                    // e.clientX/Y 是 TinyMCE iframe 内坐标；菜单挂在外层应用文档，
                    // fixed 以外层视口为原点——需加 iframe 偏移换算
                    const iframe = editor.iframeElement;
                    const offset = iframe ? iframe.getBoundingClientRect() : { left: 0, top: 0 };
                    this._showEditorContextMenu(offset.left + e.clientX, offset.top + e.clientY, editor);
                });
                editor.on('change', () => this._scheduleAutoSave());
                editor.on('keydown', (e) => {
                    if (e.key === 'Escape') this._hideFloatingToolbar();
                    // 代码块内方向键：首行↑/末行↓离开代码块（浏览器在此结构下
                    // 算不出跨块视觉位置，会弹回原位）
                    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.isComposing && !e.shiftKey) {
                        this._handleCodeBlockArrowKeys(editor, e);
                    }
                    // 代码块内行尾/空行 Delete：合并行（空行可被删除）
                    if (e.key === 'Delete' && !e.isComposing) {
                        this._handleCodeBlockDelete(editor, e);
                    }
                    // 代码块内回车自行处理（拆分 code-line 行），避免 TinyMCE 默认行为破坏行号结构
                    if (e.key === 'Enter' && !e.isComposing) {
                        if (!this._handleCodeBlockEnter(editor, e)) {
                            this._handleHorizontalRuleShortcut(editor, e);
                            this._handleCodeBlockShortcut(editor, e);
                        }
                    }
                });
                editor.on('mousedown', () => {
                    this.querySelector('#notes-tag-menu')?.classList.add('hidden');
                    this.querySelector('#notes-dropdown')?.classList.add('hidden');
                });
            },
            init_instance_callback: (editor) => {
                this._resolveEditor(editor);
                this._applyCodeBlockStyles(editor);
                // 既有内容里的代码块（重开笔记）：挂上语言编辑能力
                editor.dom.select('.code-block-wrapper').forEach((block) => {
                    this._makeCodeLangEditable(block, editor);
                });
                // 触摸长按手势脚本：主进程注入只覆盖 dom-ready/navigate 时点，
                // TinyMCE iframe 是之后动态创建的，脚本不会自动到达——
                // 在这里补注入，保证长按进度环与手势行为和外部区域一致。
                // 注入前先移除 preload 打的编辑菜单宿主标记：本 iframe 的
                // 右键/长按菜单由上方自定义菜单接管，脚本自带的编辑菜单
                // 若不禁会和它叠加成双菜单（脚本手势、进度环不受标记影响）。
                // 用 <script> 元素注入：脚本在 iframe 文档上下文执行，
                // 其内部 window/document 自然解析到 iframe。
                try {
                    const tdoc = editor.getDoc();
                    if (tdoc && !tdoc.getElementById('od-longpress-injected')) {
                        const scriptEl = tdoc.createElement('script');
                        scriptEl.id = 'od-longpress-injected';
                        scriptEl.textContent =
                            "try { document.documentElement.removeAttribute('data-od-lp-edit-menu'); } catch {}";
                        scriptEl.textContent += TOUCH_LONG_PRESS_SCRIPT;
                        tdoc.head.appendChild(scriptEl);
                    }
                } catch {
                    /* 注入失败不影响编辑功能 */
                }
                this._renderFixedToolbar(editor);
            }
        });
    }

    _notesColorPickerMarkup(submenuId, options = {}) {
        const btnClass = options.btnClass || 'notes-ftb-fixed-btn';
        const hideAttr = options.hidePriority != null ? ` data-hide-priority="${options.hidePriority}"` : '';
        const swatches = NOTES_TEXT_COLORS.map((item) => {
            if (!item.value) {
                return `<button type="button" class="notes-ftb-color-swatch notes-ftb-color-reset" data-color="" title="${this._t(item.labelKey)}">A</button>`;
            }
            return `<button type="button" class="notes-ftb-color-swatch" data-color="${item.value}" title="${this._t(item.labelKey)}" style="background:${item.value}"></button>`;
        }).join('');
        return `
        <div class="notes-ftb-color-group"${hideAttr}>
            <button type="button" class="${btnClass} notes-ftb-color-btn" data-action="color-menu" title="${this._t('renderer.note.color.title')}">
                <i class="fa-solid fa-font"></i>
                <span class="notes-ftb-color-indicator"></span>
            </button>
            <div class="notes-ftb-color-submenu hidden" id="${submenuId}">
                <div class="notes-ftb-color-grid">${swatches}</div>
                <label class="notes-ftb-color-custom">
                    <span>${this._t('renderer.note.color.custom')}</span>
                    <input type="color" class="notes-ftb-color-input" value="#1d1d1f" />
                </label>
            </div>
        </div>`;
    }

    _applyNotesTextColor(editor, color) {
        if (!color) {
            if (editor.formatter?.remove) {
                editor.formatter.remove('forecolor');
            } else {
                editor.execCommand('ForeColor', false, '#1d1d1f');
            }
        } else {
            editor.execCommand('ForeColor', false, color);
        }
        editor.focus();
    }

    _updateNotesColorIndicator(toolbar, editor) {
        const indicator = toolbar.querySelector('.notes-ftb-color-indicator');
        if (!indicator) return;
        let color = '#1d1d1f';
        try {
            const node = editor.selection.getStart();
            const el = editor.dom.getParent(node, (n) => {
                const style = editor.dom.getAttrib(n, 'style') || '';
                return style.includes('color');
            });
            if (el) {
                const parsed = editor.dom.parseStyle(editor.dom.getAttrib(el, 'style'));
                if (parsed.color) {
                    color = parsed.color;
                }
            }
        } catch {
            /* ignore */
        }
        indicator.style.background = color;
    }

    _bindNotesColorPicker(toolbar, editor, submenuId) {
        const group = toolbar.querySelector(`#${submenuId}`)?.closest('.notes-ftb-color-group');
        const submenu = toolbar.querySelector(`#${submenuId}`);
        if (!group || !submenu) return;

        const closeColorSubmenu = () => submenu.classList.add('hidden');

        group.querySelector('[data-action="color-menu"]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const willOpen = submenu.classList.contains('hidden');
            toolbar.querySelectorAll('.notes-ftb-color-submenu').forEach((el) => el.classList.add('hidden'));
            toolbar.querySelector('#notes-style-submenu')?.classList.add('hidden');
            toolbar.querySelector('#notes-ai-submenu')?.classList.add('hidden');
            if (willOpen) {
                submenu.classList.remove('hidden');
                this._adjustSubmenuPosition(submenu);
            }
        });

        submenu.querySelectorAll('[data-color]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._applyNotesTextColor(editor, btn.dataset.color || '');
                closeColorSubmenu();
                this._updateNotesColorIndicator(toolbar, editor);
            });
        });

        submenu.querySelector('.notes-ftb-color-input')?.addEventListener('input', (e) => {
            e.stopPropagation();
            const value = e.target.value;
            if (value) {
                this._applyNotesTextColor(editor, value);
                this._updateNotesColorIndicator(toolbar, editor);
            }
        });

        submenu.querySelector('.notes-ftb-color-input')?.addEventListener('click', (e) => e.stopPropagation());
    }

    _renderFixedToolbar(editor) {
        const toolbar = this.querySelector('#notes-fixed-toolbar');
        if (!toolbar) return;

        // 检查当前是否有选中文本，决定润色按钮文案
        const hasSelection = editor.selection.getContent({ format: 'text' }).trim().length > 0;
        const polishLabel = hasSelection ? this._t('renderer.note.ai.selection') : this._t('renderer.note.ai.all');

        toolbar.innerHTML = `
        <button class="notes-ftb-fixed-btn" data-action="undo" data-hide-priority="6" title="${this._t('renderer.note.undo')}">
            <i class="fa-solid fa-rotate-left"></i>
        </button>
        <button class="notes-ftb-fixed-btn" data-action="redo" data-hide-priority="6" title="${this._t('renderer.note.redo')}">
            <i class="fa-solid fa-rotate-right"></i>
        </button>
        <div class="notes-ftb-fixed-sep" data-hide-priority="5"></div>
        <button class="notes-ftb-fixed-btn" data-action="bold" data-hide-priority="5" title="${this._t('renderer.note.bold')}">
            <i class="fa-solid fa-bold"></i>
        </button>
        <button class="notes-ftb-fixed-btn" data-action="italic" data-hide-priority="5" title="${this._t('renderer.note.italic')}">
            <i class="fa-solid fa-italic"></i>
        </button>
        <button class="notes-ftb-fixed-btn" data-action="underline" data-hide-priority="5" title="${this._t('renderer.note.underline')}">
            <i class="fa-solid fa-underline"></i>
        </button>
        <button class="notes-ftb-fixed-btn" data-action="strikethrough" data-hide-priority="5" title="${this._t('renderer.note.strikethrough')}">
            <i class="fa-solid fa-strikethrough"></i>
        </button>
        ${this._notesColorPickerMarkup('notes-fixed-color-submenu', { hidePriority: 5 })}
        <div class="notes-ftb-fixed-sep" data-hide-priority="4"></div>
        <button class="notes-ftb-fixed-btn" data-action="h1" data-hide-priority="4" title="${this._t('renderer.note.heading1')}" style="font-weight:700;">H1</button>
        <button class="notes-ftb-fixed-btn" data-action="h2" data-hide-priority="4" title="${this._t('renderer.note.heading2')}" style="font-weight:700;">H2</button>
        <button class="notes-ftb-fixed-btn" data-action="h3" data-hide-priority="4" title="${this._t('renderer.note.heading3')}" style="font-weight:600;">H3</button>
        <button class="notes-ftb-fixed-btn" data-action="p" data-hide-priority="4" title="${this._t('renderer.note.body')}" style="font-size:11px;">${this._t('renderer.note.body')}</button>
        <button class="notes-ftb-fixed-btn" data-action="codeblock" data-hide-priority="4" title="${this._t('renderer.note.codeblock')}">
            <i class="fa-solid fa-code"></i>
        </button>
        <div class="notes-ftb-fixed-sep" data-hide-priority="3"></div>
        <button class="notes-ftb-fixed-btn" data-action="bullist" data-hide-priority="3" title="${this._t('renderer.note.list.bullet')}">
            <i class="fa-solid fa-list-ul"></i>
        </button>
        <button class="notes-ftb-fixed-btn" data-action="numlist" data-hide-priority="3" title="${this._t('renderer.note.list.numbered')}">
            <i class="fa-solid fa-list-ol"></i>
        </button>
        <div class="notes-ftb-fixed-sep" data-hide-priority="2"></div>
        <button class="notes-ftb-fixed-btn" data-action="alignleft" data-hide-priority="2" title="${this._t('renderer.note.align.left')}">
            <i class="fa-solid fa-align-left"></i>
        </button>
        <button class="notes-ftb-fixed-btn" data-action="aligncenter" data-hide-priority="2" title="${this._t('renderer.note.align.center')}">
            <i class="fa-solid fa-align-center"></i>
        </button>
        <button class="notes-ftb-fixed-btn" data-action="alignright" data-hide-priority="2" title="${this._t('renderer.note.align.right')}">
            <i class="fa-solid fa-align-right"></i>
        </button>
        <div class="notes-ftb-fixed-sep" data-hide-priority="1"></div>
        <button class="notes-ftb-fixed-btn" data-action="blockquote" data-hide-priority="1" title="${this._t('renderer.note.blockquote')}">
            <i class="fa-solid fa-quote-left"></i>
        </button>
        <button class="notes-ftb-fixed-btn" data-action="link" data-hide-priority="1" title="${this._t('renderer.note.link')}">
            <i class="fa-solid fa-link"></i>
        </button>
        <button class="notes-ftb-fixed-btn" data-action="image" data-hide-priority="1" title="${this._t('renderer.note.image')}">
            <i class="fa-solid fa-image"></i>
        </button>
        <button class="notes-ftb-fixed-btn" data-action="code" data-hide-priority="1" title="${this._t('renderer.note.code')}">
            <i class="fa-solid fa-code"></i>
        </button>
        <button class="notes-ftb-fixed-btn notes-ftb-fixed-ai" data-action="ai-polish" data-hide-priority="0" title="${this._t('renderer.note.ai.polishTitle')}">
            <i class="fa-solid fa-wand-magic-sparkles"></i>
            <span>${polishLabel}</span>
        </button>`;

        this._bindNotesColorPicker(toolbar, editor, 'notes-fixed-color-submenu');
        this._updateNotesColorIndicator(toolbar, editor);

        // Bind fixed toolbar actions
        toolbar.querySelectorAll('.notes-ftb-fixed-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const action = btn.dataset.action;
                if (action === 'color-menu') {
                    return;
                }
                switch (action) {
                    case 'undo':
                        editor.execCommand('undo');
                        break;
                    case 'redo':
                        editor.execCommand('redo');
                        break;
                    case 'bold':
                        editor.execCommand('Bold');
                        break;
                    case 'italic':
                        editor.execCommand('Italic');
                        break;
                    case 'underline':
                        editor.execCommand('Underline');
                        break;
                    case 'strikethrough':
                        editor.execCommand('Strikethrough');
                        break;
                    case 'h1':
                        editor.execCommand('formatBlock', false, 'h1');
                        break;
                    case 'h2':
                        editor.execCommand('formatBlock', false, 'h2');
                        break;
                    case 'h3':
                        editor.execCommand('formatBlock', false, 'h3');
                        break;
                    case 'p':
                        editor.execCommand('formatBlock', false, 'p');
                        break;
                    case 'codeblock':
                        this._insertCodeBlockAfterCaret(editor, 'python');
                        break;
                    case 'bullist':
                        editor.execCommand('InsertUnorderedList');
                        break;
                    case 'numlist':
                        editor.execCommand('InsertOrderedList');
                        break;
                    case 'alignleft':
                        editor.execCommand('JustifyLeft');
                        break;
                    case 'aligncenter':
                        editor.execCommand('JustifyCenter');
                        break;
                    case 'alignright':
                        editor.execCommand('JustifyRight');
                        break;
                    case 'blockquote':
                        editor.execCommand('formatBlock', false, 'blockquote');
                        break;
                    case 'link':
                        editor.execCommand('mceInsertLink');
                        break;
                    case 'image':
                        editor.execCommand('mceInsertImage');
                        break;
                    case 'code':
                        editor.execCommand('mceCodeEditor');
                        break;
                    case 'ai-polish':
                        this._polishFromFixedToolbar(editor);
                        break;
                }
                editor.focus();
            });
        });

        // Update polish button label on selection change
        editor.on('selectionchange', () => {
            const hasSel = editor.selection.getContent({ format: 'text' }).trim().length > 0;
            const aiBtn = toolbar.querySelector('.notes-ftb-fixed-ai span');
            if (aiBtn)
                aiBtn.textContent = hasSel ? this._t('renderer.note.ai.selection') : this._t('renderer.note.ai.all');
            this._updateNotesColorIndicator(toolbar, editor);
        });

        document.addEventListener(
            'click',
            (e) => {
                const submenu = toolbar.querySelector('#notes-fixed-color-submenu');
                if (!submenu || submenu.classList.contains('hidden')) return;
                if (!toolbar.contains(e.target)) {
                    submenu.classList.add('hidden');
                }
            },
            true
        );

        this._setupToolbarOverflow();
    }

    _setupToolbarOverflow() {
        const toolbar = this.querySelector('#notes-fixed-toolbar');
        if (!toolbar) return;

        this._toolbarHiddenLevel = 0;

        if (this._toolbarResizeObserver) {
            this._toolbarResizeObserver.disconnect();
        }

        this._toolbarResizeObserver = new ResizeObserver(() => {
            this._updateToolbarOverflow();
        });
        this._toolbarResizeObserver.observe(toolbar);

        this._updateToolbarOverflow();
    }

    _updateToolbarOverflow() {
        const toolbar = this.querySelector('#notes-fixed-toolbar');
        if (!toolbar) return;

        const allItems = toolbar.querySelectorAll('[data-hide-priority]');
        const MAX_PRIORITY = 6;

        if (toolbar.scrollWidth > toolbar.clientWidth) {
            while (toolbar.scrollWidth > toolbar.clientWidth && this._toolbarHiddenLevel < MAX_PRIORITY) {
                this._toolbarHiddenLevel++;
                allItems.forEach((item) => {
                    if (parseInt(item.dataset.hidePriority) === this._toolbarHiddenLevel) {
                        item.classList.add('notes-ftb-hidden');
                    }
                });
            }
        } else {
            while (this._toolbarHiddenLevel > 0) {
                const levelToShow = this._toolbarHiddenLevel;
                allItems.forEach((item) => {
                    if (parseInt(item.dataset.hidePriority) === levelToShow) {
                        item.classList.remove('notes-ftb-hidden');
                    }
                });

                if (toolbar.scrollWidth <= toolbar.clientWidth) {
                    this._toolbarHiddenLevel--;
                } else {
                    allItems.forEach((item) => {
                        if (parseInt(item.dataset.hidePriority) === levelToShow) {
                            item.classList.add('notes-ftb-hidden');
                        }
                    });
                    break;
                }
            }
        }
    }

    async _polishFromFixedToolbar(editor) {
        const selectedText = editor.selection.getContent({ format: 'text' }).trim();
        if (selectedText) {
            this._selectedText = selectedText;
            await this._polishSelection(editor, true);
        } else {
            // 润色全文：获取编辑器全部内容
            const fullText = editor.getContent({ format: 'text' }).trim();
            if (!fullText) return;
            this._selectedText = fullText;
            await this._polishSelection(editor, false);
        }
    }

    async _polishSelection(editor, replaceSelection = true) {
        const text = this._selectedText || editor.selection.getContent({ format: 'text' }).trim();
        if (!text) return;

        const note =
            this.notes.find((n) => n.id === this.currentNoteId) ||
            this.allNotes.find((n) => n.id === this.currentNoteId);
        const noteTitle = note?.title || '';
        const noteContext = editor.getContent({ format: 'text' }).substring(0, 500);

        // Show polishing overlay
        const container = this.querySelector('.notes-editor-container');
        if (!container) return;
        const overlay = document.createElement('div');
        overlay.className = 'notes-polishing-overlay';
        overlay.innerHTML = `<div class="notes-polishing-indicator"><i class="fa-solid fa-spinner"></i> ${this._t('renderer.note.ai.running')}</div>`;
        container.appendChild(overlay);

        // Disable editor
        editor.mode.set('readonly');

        try {
            const polishedText = await window.applicationAPI.callMainWorld('polishText', text, noteTitle, noteContext);

            if (replaceSelection && editor.selection.getContent({ format: 'text' }).trim().length > 0) {
                // 替换选中内容
                editor.selection.setContent(polishedText);
            } else {
                // 替换全文
                editor.setContent(polishedText);
            }
            this._scheduleAutoSave();
        } catch (err) {
            console.error('润色失败:', err);
        } finally {
            // Re-enable editor and remove overlay
            editor.mode.set('design');
            overlay.remove();
        }
    }

    _bindEditorEvents() {
        // 标题变化
        this.querySelector('#notes-title-input')?.addEventListener('input', () => {
            this._scheduleAutoSave();
        });

        // 关闭编辑器
        this.querySelector('#notes-close-editor-btn')?.addEventListener('click', () => this._closeNote());

        // 置顶切换
        this.querySelector('#notes-pin-note-btn')?.addEventListener('click', async () => {
            const note =
                this.notes.find((n) => n.id === this.currentNoteId) ||
                this.allNotes.find((n) => n.id === this.currentNoteId);
            if (!note) return;
            const newPinned = !note.isPinned;
            await window.applicationAPI.call('updateNote', this.currentNoteId, { isPinned: newPinned });
            note.isPinned = newPinned;
            // 更新按钮状态
            const pinBtn = this.querySelector('#notes-pin-note-btn');
            if (pinBtn) {
                pinBtn.querySelector('span').textContent = newPinned
                    ? this._t('renderer.note.pin.pinned')
                    : this._t('renderer.note.pin.unpinned');
                if (newPinned) {
                    pinBtn.style.background = '#FFF3E0';
                    pinBtn.style.borderColor = '#FFA726';
                    pinBtn.style.color = '#E65100';
                } else {
                    pinBtn.style.background = '';
                    pinBtn.style.borderColor = '';
                    pinBtn.style.color = '';
                }
            }
        });

        // 删除笔记
        this.querySelector('#notes-delete-note-btn')?.addEventListener('click', () => this._confirmDeleteNote());

        // 标签移除
        this.querySelectorAll('.notes-tag.removable').forEach((tag) => {
            tag.addEventListener('click', async () => {
                const tagName = tag.dataset.tag;
                await this._removeTagFromCurrentNote(tagName);
            });
        });

        // 添加标签
        this.querySelector('#notes-add-tag-btn')?.addEventListener('click', (e) => {
            this._showTagMenu(e.currentTarget);
        });

        // 监听主题变化
        this._themeChangeHandler = () => this._updateEditorTheme();
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.type === 'attributes' && mutation.attributeName === 'data-theme') {
                    this._updateEditorTheme();
                    break;
                }
            }
        });
        observer.observe(document.documentElement, { attributes: true });
        this._themeObserver = observer;
    }

    _updateEditorTheme() {
        this._editorReady?.then((editor) => {
            if (!editor) return;
            const colors = this._getEditorThemeColors();
            const body = editor.getBody();
            if (body) {
                body.style.backgroundColor = colors.bg;
                body.style.color = colors.text;
            }
            // 更新标题颜色
            const headings = editor.dom.select('h1, h2, h3, h4, h5, h6');
            headings.forEach((h) => {
                h.style.color = colors.heading;
            });
            // 更新引用块
            const blockquotes = editor.dom.select('blockquote');
            blockquotes.forEach((bq) => {
                bq.style.borderColor = colors.blockquoteBorder;
                bq.style.color = colors.blockquoteText;
            });
            // 更新代码块配色（样式表整体按主题重建）
            this._applyCodeBlockStyles(editor);
        });
    }

    // ─── 分割线自动补全 ───

    _handleHorizontalRuleShortcut(editor, e) {
        const node = editor.selection.getNode();
        if (!node || node.nodeName === 'HR') return;

        const text = node.textContent || '';
        const trimmedText = text.trim();

        // 支持 --- 和 *** 两种常见分割线语法
        if (trimmedText === '---' || trimmedText === '***') {
            // 阻止默认回车行为
            e.preventDefault();

            // 清空当前节点内容并插入分割线
            editor.undoManager.transact(() => {
                node.textContent = '';
                // 在当前节点后插入分割线
                const hr = editor.dom.create('hr');
                editor.dom.insertAfter(hr, node);
                // 在分割线后插入空段落，并将光标移动到那里
                const p = editor.dom.create('p');
                p.innerHTML = '<br data-mce-bogus="1">';
                editor.dom.insertAfter(p, hr);
                editor.selection.setCursorLocation(p, 0);
            });
        }
    }

    // ─── 代码块自动补全 ───

    /** 段落为 ``` 或 ```lang 时按回车，转换为带行号/圆角外框/语法高亮的代码块（外观同 taskview） */
    _handleCodeBlockShortcut(editor, e) {
        // 若光标已在代码块内，回车应保持编辑器默认换行行为
        if (this._findCodeBlockAncestor(editor)) return;

        const node = editor.selection.getNode();
        if (!node || node.nodeName === 'HR') return;

        const text = (node.textContent || '').trim();
        // ``` 或 ```lang（lang 不含空白与反引号；以空格开头视为普通文本）
        const match = /^```([^\s`]*)$/.exec(text);
        if (!match) return;

        // 先检查前面是否有未闭合的围栏文本（如粘贴的 ```c\nint main() {\n}）：
        // 有则把它闭环为代码块，而不是开新的空块
        const unclosed = this._findUnclosedFence(editor, node);
        if (unclosed) {
            e.preventDefault();
            this._closeUnclosedFence(editor, unclosed, match[1] || null, node);
            return;
        }

        e.preventDefault();
        this._insertCodeBlock(editor, node, match[1] || null);
    }

    /** 元素文本按行拆（br → \n；nbsp 归一；剥掉 TinyMCE 插入的 BOM/零宽标记） */
    _elementTextLines(editor, el) {
        const withBreaks = el.innerHTML.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
        const div = editor.dom.create('div');
        div.innerHTML = withBreaks;
        return (div.textContent || '')
            .replace(/[\uFEFF\u200B\u200C\u200D]/g, '')
            .replace(/\u00a0/g, ' ')
            .split('\n')
            .map((l) => l.trimEnd());
    }

    /**
     * 从 fenceLine 段落向上扫描（最多 50 个元素），寻找未闭合的围栏起始元素。
     * 兼容两种结构：扁平段落（每段一行）与单元素内 <br> 分隔的多行（粘贴产物）。
     * 返回 { fenceNode, lang, bodyNodes, code }；无则返回 null。
     * code 为完整代码体（已剥掉起始围栏行与中间闭合行）。
     */
    _findUnclosedFence(editor, fenceLine) {
        const body = editor.getBody();
        const all = Array.from(body.children);
        const fenceIdx = all.indexOf(fenceLine);
        if (fenceIdx <= 0) return null;
        // 向上找第一个"以围栏行开头"的元素（最多回看 50 个）
        let startIdx = -1;
        let startFence = null;
        for (let i = fenceIdx - 1; i >= 0 && i >= fenceIdx - 50; i--) {
            const el = all[i];
            if (el.classList?.contains('code-block-wrapper')) break; // 围栏不跨已有代码块
            const lines = this._elementTextLines(editor, el);
            const m = /^(```|~~~)([^\s`]*)\s*$/.exec(lines[0] || '');
            if (m) {
                startIdx = i;
                startFence = { lang: m[2] || '', lines };
                break;
            }
        }
        if (startIdx < 0) return null;

        // 收集代码体：起始元素的围栏行之后，到当前段之前的所有行；
        // 遇到独立闭合行（``` / ~~~）即认为已闭合：不算未闭合
        const bodyNodes = all.slice(startIdx + 1, fenceIdx);
        const codeLines = startFence.lines.slice(1);
        for (const el of bodyNodes) {
            for (const l of this._elementTextLines(editor, el)) {
                if (/^(```|~~~)\s*$/.test(l)) return null; // 已闭合
                codeLines.push(l);
            }
        }

        return {
            fenceNode: all[startIdx],
            lang: startFence.lang,
            bodyNodes,
            code: codeLines.length ? codeLines.join('\n') : ' '
        };
    }
    /**
     * 闭环未闭合围栏：起始元素 + 中间元素 + 当前 ``` 行，整体替换为一个代码块。
     * 用户在当前行敲的 lang（match[1]）优先于起始行的 lang（起始行通常也有）。
     */
    _closeUnclosedFence(editor, unclosed, currentLang, fenceLine) {
        const lang = currentLang || unclosed.lang || '';
        // 再剥一次零宽字符：TinyMCE insertContent 会在内容里插入 \uFEFF
        // caret 标记，残留进 code 会让 hljs 高亮错位、caret 视觉计算异常
        // （回车光标不动 / 方向键失灵的直接根源）
        const code = unclosed.code.replace(/[\uFEFF\u200B\u200C\u200D]/g, '');

        // 从起始段落到当前段落全部移除，替换为代码块
        // 注意：anchor 必须在 remove 之前取——节点 remove 后
        // previousSibling 会变为 null（真实 Chromium 语义），
        // 后取会导致代码块总是被插到笔记最顶部
        const anchor = unclosed.fenceNode.previousSibling;
        editor.undoManager.transact(() => {
            for (const el of unclosed.bodyNodes) el.remove();
            unclosed.fenceNode.remove();
            fenceLine.remove();

            const langValid = lang && hljs.getLanguage(lang);
            const language = langValid ? lang : 'plaintext';
            const highlighted = langValid ? hljs.highlight(code, { language }).value : this._escapeHtml(code);
            const html = renderCodeBlockHtml(highlighted, { lang: lang || '', withHeader: !!lang });

            const wrap = editor.dom.create('div', { class: 'code-block-wrapper' });
            wrap.innerHTML = html;
            const block = wrap.firstElementChild;
            if (!block) return;
            if (lang) block.dataset.lang = lang;

            // 插到原起始段落的位置（anchor 已在 remove 前取好）
            const body = editor.getBody();
            if (anchor) editor.dom.insertAfter(block, anchor);
            else body.insertBefore(block, body.firstChild);

            const p = editor.dom.create('p');
            p.innerHTML = '<br data-mce-bogus="1">';
            editor.dom.insertAfter(p, block);

            const firstLine = block.querySelector('.code-block-body .code-lines .code-line');
            if (firstLine && firstLine.firstChild) {
                editor.selection.setCursorLocation(firstLine.firstChild, 0);
            } else {
                editor.selection.setCursorLocation(p, 0);
            }
            this._stripZeroWidthInBlock(block);
            if (lang) this._makeCodeLangEditable(block, editor);
        });
        this._scheduleAutoSave();
    }

    /** 向上查找光标所在的代码块容器（选区悬空时回退到 body 级最近代码块） */
    _findCodeBlockAncestor(editor) {
        let cur = editor.selection.getNode();
        if (cur && !cur.isConnected) {
            // 选区悬空：从 DOM 上的最后一个代码块兜底（自愈后再走正常路径）
            const blocks = editor.dom.select('.code-block-wrapper');
            return blocks.length ? blocks[blocks.length - 1] : null;
        }
        while (cur && cur.nodeName !== 'BODY') {
            if (cur.classList?.contains('code-block-wrapper')) return cur;
            cur = cur.parentNode;
            if (cur && cur.nodeType === 11) cur = null; // DocumentFragment：跳到外层
        }
        return null;
    }

    /**
     * 把当前段落替换为代码块：结构/类名与 taskview 完全一致
     * （行号由 CSS counter 生成，高亮与 taskview 同源），并在其后留一个空段落。
     */
    _insertCodeBlock(editor, sourceNode, lang) {
        // 用占位空格保证空代码块也渲染出一行 code-line，光标有落点
        const highlighted = ' ';
        const html = renderCodeBlockHtml(highlighted, { lang: lang || '', withHeader: !!lang });

        let insertedBlock = null;
        editor.undoManager.transact(() => {
            const wrap = editor.dom.create('div', { class: 'code-block-wrapper' });
            wrap.innerHTML = html;
            const block = wrap.firstElementChild;
            if (!block) return;
            if (lang) block.dataset.lang = lang;
            editor.dom.insertAfter(block, sourceNode);
            sourceNode.remove();
            insertedBlock = block;

            const body = block.querySelector('.code-block-body .code-lines');
            const p = editor.dom.create('p');
            p.innerHTML = '<br data-mce-bogus="1">';
            editor.dom.insertAfter(p, block);
            if (body) {
                // 光标落首行内部文本节点（元素边界点会被 TinyMCE 归一化挪走）
                const firstLine = body.firstElementChild;
                if (firstLine && firstLine.firstChild) {
                    editor.selection.setCursorLocation(firstLine.firstChild, 0);
                } else {
                    editor.selection.setCursorLocation(p, 0);
                }
            } else {
                editor.selection.setCursorLocation(p, 0);
            }
        });
        if (lang && insertedBlock) this._makeCodeLangEditable(insertedBlock, editor);
        this._scheduleAutoSave();
    }

    /** 工具栏插入：当前段落保留，在其后插入默认语言代码块 */
    _insertCodeBlockAfterCaret(editor, lang) {
        const node = editor.selection.getNode();
        if (!node) return;
        // 光标在代码块内时按钮无意义：直接把光标留在块内
        if (this._findCodeBlockAncestor(editor)) return;

        // 空段落就地转换（与 ``` 快捷键一致体验）；非空段落保留原文，块插在其后
        const isEmptyPara = node.nodeName === 'P' && (node.textContent || '').trim() === '';
        if (isEmptyPara) {
            this._insertCodeBlock(editor, node, lang);
            return;
        }

        const highlighted = ' ';
        const html = renderCodeBlockHtml(highlighted, { lang, withHeader: true });

        let insertedBlock = null;
        editor.undoManager.transact(() => {
            const wrap = editor.dom.create('div', { class: 'code-block-wrapper' });
            wrap.innerHTML = html;
            const block = wrap.firstElementChild;
            if (!block) return;
            block.dataset.lang = lang;
            editor.dom.insertAfter(block, node);
            insertedBlock = block;

            const p = editor.dom.create('p');
            p.innerHTML = '<br data-mce-bogus="1">';
            editor.dom.insertAfter(p, block);

            const firstLine = block.querySelector('.code-block-body .code-lines .code-line');
            if (firstLine && firstLine.firstChild) {
                editor.selection.setCursorLocation(firstLine.firstChild, 0);
            } else {
                editor.selection.setCursorLocation(p, 0);
            }
        });
        if (insertedBlock) this._makeCodeLangEditable(insertedBlock, editor);
        this._scheduleAutoSave();
    }

    /**
     * 让代码块 header 的语言标签可编辑：
     * 点击进入输入态，回车/失焦提交，Esc 取消。
     * 提交后更新 data-lang 与 language-* 类，整块按新语言重新高亮。
     */
    _makeCodeLangEditable(block, editor) {
        const langEl = block.querySelector('.code-block-header .code-block-lang');
        if (!langEl || langEl.dataset.langEditable) return;
        langEl.dataset.langEditable = '1';
        langEl.style.cursor = 'text';
        langEl.title = this._t('renderer.note.codeblock.langHint');

        const commit = (rawValue) => {
            const newLang = rawValue.trim().toLowerCase();
            const oldLang = this._getCodeBlockLang(block);
            if (!newLang || newLang === oldLang || !hljs.getLanguage(newLang)) {
                // 非法/未变：恢复显示名
                langEl.textContent = oldLang
                    ? LANG_DISPLAY_NAMES[oldLang] || oldLang.charAt(0).toUpperCase() + oldLang.slice(1)
                    : '';
                return;
            }
            block.dataset.lang = newLang;
            const bodyDiv = block.querySelector('.code-block-body');
            if (bodyDiv) {
                bodyDiv.className = bodyDiv.className.replace(/\blanguage-[\w+-]+\b/, `language-${newLang}`);
                if (!/\blanguage-/.test(bodyDiv.className)) bodyDiv.className += ` language-${newLang}`;
            }
            langEl.textContent = LANG_DISPLAY_NAMES[newLang] || newLang.charAt(0).toUpperCase() + newLang.slice(1);
            // 整块按新语言重高亮（此时光标在 header input 里，不在代码行上，替换安全）
            this._refreshCodeBlockHighlightForce(block, editor);
            this._scheduleAutoSave();
        };

        langEl.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (langEl.querySelector('input')) return;
            const current = this._getCodeBlockLang(block);
            const doc = editor.getDoc();
            const input = doc.createElement('input');
            input.value = current;
            input.placeholder = this._t('renderer.note.codeblock.langHint');
            input.style.cssText = [
                'font: inherit',
                'font-size: 11px',
                'width: 90px',
                'border: none',
                'outline: none',
                'background: transparent',
                'color: inherit',
                'padding: 0'
            ].join(';');
            langEl.textContent = '';
            langEl.appendChild(input);
            input.focus?.();
            input.select?.();

            const done = (cancel) => {
                const value = input.value;
                input.remove();
                if (cancel) {
                    // 取消：恢复旧显示名
                    const oldLang = this._getCodeBlockLang(block);
                    langEl.textContent = oldLang
                        ? LANG_DISPLAY_NAMES[oldLang] || oldLang.charAt(0).toUpperCase() + oldLang.slice(1)
                        : '';
                    return;
                }
                commit(value);
            };
            input.addEventListener('keydown', (ev) => {
                ev.stopPropagation(); // 防止编辑器快捷键（回车拆行等）截获
                if (ev.key === 'Enter') {
                    ev.preventDefault();
                    done(false);
                } else if (ev.key === 'Escape') {
                    ev.preventDefault();
                    done(true);
                }
            });
            input.addEventListener('blur', () => done(false));
            input.addEventListener('click', (ev) => ev.stopPropagation());
        });
    }

    /** 深浅色主题的代码块配色（取值与 taskview 的 --chat-* 品牌暖色系一致） */
    _getCodeBlockThemeColors() {
        const isDark = document.documentElement.dataset.theme === 'dark';
        return {
            isDark,
            frameBg: isDark ? '#1f1d1b' : '#f7f6f4',
            headerBg: isDark ? '#22201e' : '#fafafa',
            lineSoft: isDark ? '#33302d' : '#f0efec',
            ink2: isDark ? '#d5d1cb' : '#4a4642',
            ink3: isDark ? '#9b968f' : '#8a8580',
            ink4: isDark ? '#6f6a63' : '#b4afa9',
            accent: isDark ? '#e8563f' : '#df4436',
            green: isDark ? '#3dbf82' : '#1f9d66',
            blue: isDark ? '#7aa2e8' : '#4267b2',
            amber: isDark ? '#e2a23b' : '#b87503',
            // 自绘按行选区高亮色（行级整行覆盖，不透明）
            selectionBg: isDark ? '#39435a' : '#d4e0f4'
        };
    }

    /**
     * Maple Mono @font-face 定义：TinyMCE iframe 是独立文档，解析不到
     * 主文档 fonts.css 里的字体名，必须自带 @font-face。
     * 字体 URL 基于主文档 baseURI 计算为绝对地址（dev 为 http 静态服务、
     * 生产为 file:// 相对目录），避免相对路径在 iframe 内解析失败。
     */
    _getMonoFontFaceCss() {
        if (this._monoFontFaceCss) return this._monoFontFaceCss;
        const variants = [
            ['normal', 'normal', 'MapleMono-Regular.ttf.woff2'],
            ['italic', 'normal', 'MapleMono-Italic.ttf.woff2'],
            ['normal', 'bold', 'MapleMono-Bold.ttf.woff2'],
            ['italic', 'bold', 'MapleMono-BoldItalic.ttf.woff2']
        ];
        this._monoFontFaceCss = variants
            .map(([style, weight, file]) => {
                const url = new URL(`fonts/maplemono/${file}`, document.baseURI).href;
                return (
                    `@font-face { font-family: 'Maple Mono'; font-style: ${style}; font-weight: ${weight}; ` +
                    `src: url('${url}') format('woff2'); font-display: swap; }`
                );
            })
            .join('\n');
        return this._monoFontFaceCss;
    }

    /** 把代码块样式写入 TinyMCE iframe 文档，并按当前主题上色（主题切换时重复调用即可刷新） */
    _applyCodeBlockStyles(editor) {
        const doc = editor.getDoc();
        if (!doc) return;
        doc.getElementById('notes-code-block-style')?.remove();
        // iframe 文档声明 color-scheme，让原生 UI（选区高亮等）跟随主题，
        // 否则深色模式下 Chromium 用浅色默认选区色画出大块蓝色选区
        doc.documentElement.style.colorScheme = this._getCodeBlockThemeColors().isDark ? 'dark' : 'light';
        const c = this._getCodeBlockThemeColors();
        const monoStack =
            "'Maple Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', 'Monaco', monospace";
        const style = doc.createElement('style');
        style.id = 'notes-code-block-style';
        style.textContent = `
            ${this._getMonoFontFaceCss()}
            /* 覆盖 TinyMCE 自带 content.css 的行内 code 灰底/等宽规则（会打到 code.code-lines 上） */
            .code-block-wrapper code {
                background: transparent;
                border-radius: 0;
                padding: 0;
                text-shadow: none;
                font-size: inherit;
                font-family: ${monoStack};
                color: inherit;
            }
            /* 关键修复：跨行选择时 TinyMCE 给边界元素打 data-mce-selected="inline-boundary"，
               oxide 皮肤为此画 #b4d7ff 蓝底（就是代码块"整块变蓝"的元凶）。
               把它压回代码区底色，选区视觉由文字上的原生 ::selection 呈现。 */
            .mce-content-body [data-mce-selected='inline-boundary'] {
                background: ${c.frameBg} !important;
            }
            .code-block-wrapper {
                border: 1px solid ${c.lineSoft};
                border-radius: 8px;
                overflow: hidden;
                margin: 0.6em 0;
                width: 100%;
                box-sizing: border-box;
            }
            .code-block-header {
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 0.35em 0.75em;
                background: ${c.headerBg};
                border-bottom: 1px solid ${c.lineSoft};
            }
            .code-block-lang {
                font-size: 11px;
                font-weight: 600;
                color: ${c.ink3};
                user-select: none;
            }
            .code-block-body {
                overflow-x: auto;
                background: ${c.frameBg};
                color: ${c.ink2};
                font-size: 13px;
                line-height: 1.55;
                font-family: ${monoStack};
            }
            .code-block-pre {
                display: block;
                margin: 0;
                padding: 0;
                border: none;
                background: transparent;
                font-size: inherit;
                line-height: inherit;
                font-family: inherit;
            }
            .code-lines {
                display: block;
                margin: 0;
                padding: 0.5em 0;
                counter-reset: codeln;
                white-space: pre;
                font-size: inherit;
                line-height: inherit;
                font-family: inherit;
            }
            .code-line {
                display: block;
                position: relative;
                counter-increment: codeln;
                margin: 0;
                padding: 0 0.8em 0 3.4em;
                white-space: pre;
                font-family: inherit;
                min-height: 1.55em;
            }
            .code-line::before {
                content: counter(codeln);
                position: absolute;
                left: 0;
                top: 0;
                height: 100%;
                width: 3.4em;
                padding: 0 0.6em;
                box-sizing: border-box;
                text-align: right;
                user-select: none;
                color: ${c.ink4};
                background: ${c.headerBg};
                border-right: 1px solid ${c.lineSoft};
            }
            .code-block-body .hljs-keyword, .code-block-body .hljs-selector-tag,
            .code-block-body .hljs-doctag, .code-block-body .hljs-tag {
                color: ${c.accent}; font-weight: 500;
            }
            .code-block-body .hljs-string, .code-block-body .hljs-regexp,
            .code-block-body .hljs-attr { color: ${c.green}; }
            .code-block-body .hljs-number, .code-block-body .hljs-literal,
            .code-block-body .hljs-type { color: ${c.blue}; }
            .code-block-body .hljs-title, .code-block-body .hljs-function .hljs-title,
            .code-block-body .hljs-section, .code-block-body .hljs-attribute,
            .code-block-body .hljs-name, .code-block-body .hljs-built_in { color: ${c.amber}; }
            .code-block-body .hljs-comment, .code-block-body .hljs-quote {
                color: ${c.ink4}; font-style: italic;
            }
            .code-block-body .hljs-meta { color: ${c.ink3}; }
            .code-block-body .hljs-variable, .code-block-body .hljs-params { color: ${c.ink2}; }
        `;
        doc.head.appendChild(style);
    }

    /**
     * 代码块内方向键：
     * - 末行行尾按 ↓：光标移到代码块后的相邻段落
     * - 首行行首按 ↑：光标移到代码块前的相邻段落
     * 浏览器在 display:block 行结构里算不出跨块移动，默认会弹回原位。
     * @returns true 表示已处理
     */
    _handleCodeBlockArrowKeys(editor, e) {
        const block = this._findCodeBlockAncestor(editor);
        if (!block) return false;
        const line = this._getSelectedCodeLine(editor);
        if (!line) {
            // 选区锚点不在任何行内（浏览器在方向键失败后的重映射状态）：
            // 视为用户在块底部按回车，退出代码块到下方新段落
            e.preventDefault();
            const p = editor.dom.create('p');
            p.innerHTML = '<br data-mce-bogus="1">';
            editor.dom.insertAfter(p, block);
            editor.selection.setCursorLocation(p, 0);
            this._scheduleAutoSave();
            return true;
        }

        const lines = Array.from(block.querySelectorAll('.code-line'));
        const lineIndex = lines.indexOf(line);
        const rng = editor.selection.getRng();
        const lineText = this._getCodeLineText(line);
        const caretOffset = this._caretTextOffset(line, rng);

        // 块内跨行移动：display:block 的 span 行结构下浏览器算不出
        // 跨行 caret 视觉位置（会弹回原地），全部接管为逻辑行移动
        if (e.key === 'ArrowDown' && lineIndex < lines.length - 1) {
            e.preventDefault();
            const target = lines[lineIndex + 1];
            const targetLen = this._getCodeLineText(target).length;
            this._setCaretInLine(editor, target, Math.min(caretOffset, targetLen));
            return true;
        }

        if (e.key === 'ArrowUp' && lineIndex > 0) {
            e.preventDefault();
            const target = lines[lineIndex - 1];
            const targetLen = this._getCodeLineText(target).length;
            this._setCaretInLine(editor, target, Math.min(caretOffset, targetLen));
            return true;
        }

        if (e.key === 'ArrowDown' && lineIndex === lines.length - 1) {
            // 末行：只要已在行尾（或末行是空行）就向下离开
            const atEnd = caretOffset >= lineText.length || lineText.trim().length === 0;
            if (!atEnd) return false;
            e.preventDefault();
            const next = this._findAdjacentBlockElement(editor, block, 'next');
            if (next) {
                this._setCaretAtElementStart(editor, next);
            } else {
                // 块后没有段落：补一个
                const p = editor.dom.create('p');
                p.innerHTML = '<br data-mce-bogus="1">';
                editor.dom.insertAfter(p, block);
                editor.selection.setCursorLocation(p, 0);
            }
            return true;
        }

        if (e.key === 'ArrowUp' && lineIndex === 0) {
            const atStart = caretOffset === 0;
            if (!atStart) return false;
            e.preventDefault();
            const prev = this._findAdjacentBlockElement(editor, block, 'prev');
            if (prev) {
                // 移到前一个元素的文本末尾
                this._setCaretAtElementEnd(editor, prev);
            }
            return true;
        }
        return false;
    }

    /** 把光标放到元素的文本开头（优先文本节点，避免元素边界） */
    _setCaretAtElementStart(editor, el) {
        const firstText = this._findFirstTextNode(el);
        if (firstText) {
            editor.selection.setCursorLocation(firstText.node, firstText.offset);
        } else {
            editor.selection.setCursorLocation(el, 0);
        }
    }

    /** 找元素内第一个文本节点（返回其引用；起始 offset 恒为 0） */
    _findFirstTextNode(el) {
        const walk = (node) => {
            for (const child of Array.from(node.childNodes)) {
                if (child.nodeType === 3 && child.textContent.length > 0) {
                    return { node: child, offset: 0 };
                }
                const deep = walk(child);
                if (deep) return deep;
            }
            return null;
        };
        return walk(el);
    }

    /** 找代码块前/后相邻的块级元素 */
    _findAdjacentBlockElement(editor, block, direction) {
        const body = editor.getBody();
        let cur = direction === 'next' ? block.nextElementSibling : block.previousElementSibling;
        while (cur && cur !== body) {
            if (!cur.classList?.contains('code-block-wrapper')) return cur;
            cur = direction === 'next' ? cur.nextElementSibling : cur.previousElementSibling;
        }
        return null;
    }

    /** 把光标放到元素文本末尾（优先文本节点，避免元素边界） */
    _setCaretAtElementEnd(editor, el) {
        const lastText = this._findLastTextNode(el);
        if (lastText) {
            editor.selection.setCursorLocation(lastText.node, lastText.offset);
        } else {
            // 空元素（无文本）：光标落元素起点，由 TinyMCE 自行归一化
            editor.selection.setCursorLocation(el, 0);
        }
    }

    /** 找元素内最后一个文本节点及其长度 */
    _findLastTextNode(el) {
        const walk = (node) => {
            for (let i = node.childNodes.length - 1; i >= 0; i--) {
                const child = node.childNodes[i];
                if (child.nodeType === 3 && child.textContent.length > 0) {
                    return { node: child, offset: child.textContent.length };
                }
                const deep = walk(child);
                if (deep) return deep;
            }
            return null;
        };
        return walk(el);
    }

    /**
     * 代码块内按回车：在光标处把当前 code-line 拆成两行（保持行号结构）。
     * 当前行为空且是最后一行时，回车退出代码块，在下方开新段落。
     * @returns true 表示已处理（阻止默认回车）
     */
    _handleCodeBlockEnter(editor, e) {
        const block = this._findCodeBlockAncestor(editor);
        if (!block) return false;

        // 选区悬空自愈：重高亮刚重建 DOM 后选区锚点可能已脱离文档树，
        // 此时 TinyMCE 的默认回车会基于坏选区在原位后插行（光标不动的 bug）
        const rng = editor.selection.getRng();
        if (rng.startContainer && !rng.startContainer.isConnected) {
            const lines = block.querySelectorAll('.code-line');
            const fallback = lines[lines.length - 1];
            if (!fallback) return false;
            this._setCaretInLine(editor, fallback, 0);
        }

        const line = this._getSelectedCodeLine(editor);
        if (!line) return false;

        e.preventDefault();
        const lineIndex = Array.from(block.querySelectorAll('.code-line')).indexOf(line);
        editor.undoManager.transact(() => {
            // 回车永远拆行（主流编辑器语义）；退出代码块用 ↓ 方向键或 Escape
            const newLine = this._splitCodeLineAtCaret(editor, line);
            // 光标必须落到新行内部的文本节点上：空元素边界点会被 TinyMCE
            // 选区归一化挪回上一行行尾，导致后续回车不断在行尾后插行
            this._setCaretInLine(editor, newLine, 0);
        });
        // 硬校验：transact/选区归一化后光标必须仍在新行（拆分前的 line 的下一行）。
        // 任何一环（TinyMCE 选区 normalize、浏览器选区重映射）把光标挪走
        // 都会重现"光标不动、行往下堆"的 bug——这里强制拉回。
        const linesNow = Array.from(block.querySelectorAll('.code-line'));
        const expectedNewLine = linesNow[lineIndex + 1];
        if (expectedNewLine && this._getSelectedCodeLine(editor) !== expectedNewLine) {
            this._setCaretInLine(editor, expectedNewLine, 0);
        }
        this._scheduleAutoSave();
        return true;
    }

    /**
     * 代码块内 Delete 键：
     * - 行尾按 Delete：下一行合并到当前行（保留当前行高亮壳，吃进下一行内容）
     * - 空行按 Delete：删除本行，光标到上一行行尾
     * @returns true 表示已处理
     */
    _handleCodeBlockDelete(editor, e) {
        const block = this._findCodeBlockAncestor(editor);
        if (!block) return false;
        const line = this._getSelectedCodeLine(editor);
        if (!line) return false;

        const rng = editor.selection.getRng();
        const lineText = this._getCodeLineText(line);
        const caretOffset = this._caretTextOffset(line, rng);
        const lines = Array.from(block.querySelectorAll('.code-line'));
        const lineIndex = lines.indexOf(line);
        // 空行（占位空格）无论光标位置都按行级 Delete 处理
        const isEmptyLine = lineText.trim().length === 0;
        const atLineEnd = caretOffset >= lineText.length;
        if (!isEmptyLine && !atLineEnd) return false; // 行中 Delete：浏览器默认删字符即可
        if (!isEmptyLine && lineIndex >= lines.length - 1) return false; // 末行行尾：无下一行可吞，走默认

        e.preventDefault();
        editor.undoManager.transact(() => {
            if (isEmptyLine && lineIndex > 0) {
                // 空行 Delete：删掉本行，光标到上一行行尾
                const prev = lines[lineIndex - 1];
                line.remove();
                this._setCaretAtLineEnd(editor, prev);
            } else if (!isEmptyLine) {
                // 行尾 Delete：下一行内容并入当前行，删除下一行，光标停在合并点
                const next = lines[lineIndex + 1];
                const nextChildren = Array.from(next.childNodes);
                nextChildren.forEach((child) => line.appendChild(child));
                next.remove();
                this._setCaretInLine(editor, line, caretOffset);
            }
            // 空行且是首行（lineIndex 0）：没有上一行可退，仅清空占位保持原状
        });
        this._scheduleAutoSave();
        return true;
    }

    /** 把光标放到 line 的文本末尾（复用行尾文本节点，无文本时补空格占位） */
    _setCaretAtLineEnd(editor, line) {
        const lastText = this._findLastTextNode(line);
        if (lastText) {
            editor.selection.setCursorLocation(lastText.node, lastText.offset);
        } else {
            const doc = editor.getDoc();
            const tail = doc.createTextNode(' ');
            line.appendChild(tail);
            editor.selection.setCursorLocation(tail, 1);
        }
    }

    // ─── 粘贴围栏转代码块 ───

    /**
     * 匹配完整 markdown 围栏：```lang\n...\n``` 或 ~~~（允许首行 ``` 前有换行外的空白）。
     * 返回 { lang, code }；非围栏返回 null。无语言（裸 ```）也接受（lang 为 ''）。
     */
    _parseCodeFence(text) {
        if (typeof text !== 'string') return null;
        const m = /^(\s*)(`{3,}|~{3,})([^\n`]*)\n([\s\S]*?)\n?\2\s*$/.exec(text);
        if (!m) return null;
        // 开头反引号行之后必须有内容（或允许空体——空也转，用户就是想要个块）
        const lang = m[3].trim().split(/\s+/)[0].toLowerCase();
        const code = m[4];
        if (lang && /[`~]/.test(lang)) return null; // 语言位混入围栏字符：不是合法围栏
        return { lang, code };
    }

    /** 原生粘贴拦截：完整围栏文本转代码块，其余放行 */
    _handleCodeFencePaste(editor, e) {
        // 已经在代码块内粘贴：不转换（用户在补代码内容）
        if (this._findCodeBlockAncestor(editor)) return;
        const text = e.clipboardData?.getData?.('text/plain');
        const fence = this._parseCodeFence(text);
        if (!fence) return;

        e.preventDefault();
        this._insertFencedCodeBlock(editor, fence.lang, fence.code);
    }

    /** 把围栏内容转为代码块插入光标处（当前段落非空时保留，块插在其后） */
    _insertFencedCodeBlock(editor, lang, code) {
        const node = editor.selection.getNode();
        if (!node) return;
        const langValid = lang && hljs.getLanguage(lang);
        const language = langValid ? lang : 'plaintext';
        // 剥零宽字符（TinyMCE caret 标记可能混入剪贴板文本）
        const plain = (code.length ? code : ' ').replace(/[\uFEFF\u200B\u200C\u200D]/g, '') || ' ';
        const highlighted = langValid ? hljs.highlight(plain, { language }).value : this._escapeHtml(plain);
        const html = renderCodeBlockHtml(highlighted, { lang: lang || '', withHeader: !!lang });

        editor.undoManager.transact(() => {
            const wrap = editor.dom.create('div', { class: 'code-block-wrapper' });
            wrap.innerHTML = html;
            const block = wrap.firstElementChild;
            if (!block) return;
            if (lang) block.dataset.lang = lang;

            const isEmptyPara = node.nodeName === 'P' && (node.textContent || '').trim() === '';
            if (isEmptyPara) {
                // 空段落就地替换
                editor.dom.insertAfter(block, node);
                node.remove();
            } else {
                // 非空段落：块插在其后
                editor.dom.insertAfter(block, node);
            }

            const p = editor.dom.create('p');
            p.innerHTML = '<br data-mce-bogus="1">';
            editor.dom.insertAfter(p, block);

            const firstLine = block.querySelector('.code-block-body .code-lines .code-line');
            if (firstLine && firstLine.firstChild) {
                editor.selection.setCursorLocation(firstLine.firstChild, 0);
            } else {
                editor.selection.setCursorLocation(p, 0);
            }
            this._stripZeroWidthInBlock(block);
            if (lang) this._makeCodeLangEditable(block, editor);
        });
        this._scheduleAutoSave();
    }

    /** 光标所在的 code-line 元素（从 Range startContainer 向上查找） */
    _getSelectedCodeLine(editor) {
        let cur = editor.selection.getRng().startContainer;
        if (cur && cur.nodeType === 3) cur = cur.parentNode;
        while (cur && cur.nodeName !== 'BODY') {
            if (cur.classList?.contains('code-line')) return cur;
            if (cur.classList?.contains('code-block-wrapper')) break;
            cur = cur.parentNode;
        }
        return null;
    }

    /** code-line 的纯文本（忽略行内 span，nbsp 归一为空格，剥零宽字符） */
    _getCodeLineText(line) {
        if (!line) return '';
        return (line.textContent || '').replace(/[\uFEFF\u200B\u200C\u200D]/g, '').replace(/\u00a0/g, ' ');
    }

    /**
     * DOM 级自愈：移除代码块所有行文本里的零宽字符（\uFEFF 等）。
     * TinyMCE 的 caret 标记（\uFEFF）可能在插入/编辑时混进行文本，
     * 残留会导致 hljs 高亮错位与 caret 视觉计算异常（回车/方向键失灵）。
     * 直接对 DOM 文本节点操作，不依赖上游剥离是否生效。
     */
    _stripZeroWidthInBlock(block) {
        const doc = this.ownerDocument;
        // NodeFilter.SHOW_TEXT === 4（linkedom 等简化 DOM 无 NodeFilter 全局）
        const SHOW_TEXT = doc.defaultView?.NodeFilter?.SHOW_TEXT ?? 4;
        const walker = doc.createTreeWalker(block, SHOW_TEXT);
        const targets = [];
        while (walker.nextNode()) {
            const node = walker.currentNode;
            if (node.textContent && /[\uFEFF\u200B\u200C\u200D]/.test(node.textContent)) {
                targets.push(node);
            }
        }
        for (const node of targets) {
            node.textContent = node.textContent.replace(/[\uFEFF\u200B\u200C\u200D]/g, '');
        }
    }

    // ─── 代码块语法高亮 ───

    /** 节流 150ms 后刷新所有无光标代码块的高亮（selectionchange 触发） */
    _scheduleCodeBlockHighlight(editor) {
        if (this._codeHighlightTimer) clearTimeout(this._codeHighlightTimer);
        this._codeHighlightTimer = setTimeout(() => {
            this._codeHighlightTimer = null;
            this._refreshCodeBlockHighlight(editor);
        }, 150);
    }

    /** 光标离开代码块后对无光标的代码块做整体重新高亮 */
    _refreshCodeBlockHighlight(editor) {
        const blocks = editor.dom.select('.code-block-wrapper');
        for (const block of blocks) {
            // 常驻自愈：TinyMCE 会在空 inline 元素的 caret 处插入 \uFEFF
            // caret 标记，残留破坏高亮与光标行为——每次刷新顺手清除
            this._stripZeroWidthInBlock(block);
            // 只刷新光标不在其中的块：编辑中的块不动 DOM（选区安全），
            // 离开后由本函数补上完整高亮
            const caretLine = this._getSelectedCodeLine(editor);
            if (caretLine && block.contains(caretLine)) continue;
            this._refreshCodeBlockHighlightIn(block, editor);
        }
    }

    /** 强制整块重新高亮（语言变更后调用；调用方须保证光标不在代码行上） */
    _refreshCodeBlockHighlightForce(block, editor) {
        // 语言标签编辑态光标在 header input 里，不在代码行上，替换安全
        this._refreshCodeBlockHighlightIn(block, editor);
    }

    /** 对单个代码块整体重新高亮（调用方须保证光标不在此块内） */
    _refreshCodeBlockHighlightIn(block, editor) {
        const lang = this._getCodeBlockLang(block);
        if (!lang || !hljs.getLanguage(lang)) return;

        const body = block.querySelector('.code-block-body .code-lines');
        if (!body) return;

        const plain = this._getCodeBlockPlainText(block);
        const html = hljs.highlight(plain, { language: lang }).value;
        const lines = splitHighlightedLines(html);
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

        const children = Array.from(body.children);
        let dirty = false;
        for (let i = 0; i < children.length && i < lines.length; i++) {
            const inner = renderCodeLineInnerHtml(lines[i]);
            if (children[i].innerHTML !== inner) {
                children[i].innerHTML = inner;
                dirty = true;
            }
        }
        // DOM 行数多于高亮输出（用户删行后）：移除尾部多余行；不足则补
        for (let i = children.length - 1; i >= lines.length; i--) {
            children[i].remove();
            dirty = true;
        }
        for (let i = children.length; i < lines.length; i++) {
            const holder = editor.dom.create('div');
            holder.innerHTML = renderCodeLineHtml(lines[i]);
            const fresh = holder.firstElementChild;
            if (fresh) {
                body.appendChild(fresh);
                dirty = true;
            }
        }
        if (dirty) this._scheduleAutoSave();
    }

    /** 代码块语言：优先 data-lang，回退 body 类名 language-*（防笔记重开后属性被剥离） */
    _getCodeBlockLang(block) {
        const direct = (block.dataset.lang || '').toLowerCase();
        if (direct) return direct;
        const body = block.querySelector('.code-block-body');
        const m = /\blanguage-([\w+-]+)\b/.exec(body?.className || '');
        return m ? m[1].toLowerCase() : '';
    }

    /** 整个代码块的纯文本（行以 \n 连接；空行补占位空格，与渲染约定对齐） */
    _getCodeBlockPlainText(block) {
        return Array.from(block.querySelectorAll('.code-line'))
            .map((l) => {
                const text = (l.textContent || '').replace(/\u00a0/g, ' ');
                // 空行的 DOM textContent 为空，但渲染约定是占位空格；
                // 不补齐会让高亮输出的行数少于 DOM 行数，导致尾行漏更新
                return text.length === 0 ? ' ' : text;
            })
            .join('\n');
    }

    /** 光标在 line 内的文本偏移（跨 span 边界时按拼接文本累计） */
    _caretTextOffset(line, rng) {
        const container = rng.startContainer;
        if (container.nodeType === 3) {
            let offset = 0;
            let found = false;
            const walk = (node) => {
                if (found) return;
                for (const child of Array.from(node.childNodes)) {
                    if (child === container) {
                        offset += rng.startOffset;
                        found = true;
                        return;
                    }
                    if (child.nodeType === 3) offset += child.textContent.length;
                    walk(child);
                    if (found) return;
                }
            };
            walk(line);
            return offset;
        }
        // 元素容器：偏移即前若干子节点的文本长度
        let offset = 0;
        for (let i = 0; i < rng.startOffset && i < container.childNodes.length; i++) {
            offset += container.childNodes[i].textContent.length;
        }
        return offset;
    }

    /** 把光标放到 line 内的指定文本偏移处（跨 span 定位；行首空文本节点优先承接 offset 0） */
    _setCaretInLine(editor, line, textOffset) {
        const find = (node, remaining) => {
            for (const child of Array.from(node.childNodes)) {
                const len = child.textContent.length;
                if (child.nodeType === 3 && remaining <= len) {
                    return { node: child, offset: remaining };
                }
                if (remaining <= len) {
                    const deep = find(child, remaining);
                    if (deep) return deep;
                }
                remaining -= len;
            }
            return null;
        };
        const hit = find(line, textOffset);
        if (hit) {
            editor.selection.setCursorLocation(hit.node, hit.offset);
        } else {
            // 找不到落点（空行/超出行尾）：补空格占位，光标放占位内
            // （offset 0 在空格前=行首；超行尾时在空格后=行尾）
            const doc = editor.getDoc();
            const tail = doc.createTextNode(' ');
            line.appendChild(tail);
            editor.selection.setCursorLocation(tail, Math.min(textOffset, 1));
        }
    }

    /**
     * 以纯 DOM 操作在光标处拆分 code-line（不依赖 Range 剪切 API）：
     * 光标后的文本与节点移入克隆出的新 code-line，行内高亮 span 壳按原层级重建，
     * 返回新 code-line 元素。
     */
    _splitCodeLineAtCaret(editor, line) {
        const doc = editor.getDoc();
        const rng = editor.selection.getRng();
        const container = rng.startContainer;
        const offset = rng.startOffset;
        const newLine = line.cloneNode(false);

        // container 与 line 之间的元素祖先（外层在前）；若 container 本身是元素也纳入
        const chain = [];
        if (container !== line && container.nodeType !== 3) chain.push(container);
        for (let n = container.parentNode; n && n !== line; n = n.parentNode) {
            chain.unshift(n);
        }

        // 在 newLine 内按原层级重建祖先壳，deepest 为最内层挂载点
        const shells = [];
        let deepest = newLine;
        for (const el of chain) {
            const shell = el.cloneNode(false);
            deepest.appendChild(shell);
            shells.push(shell);
            deepest = shell;
        }

        if (container.nodeType === 3) {
            // 拆分光标所在文本节点，尾部文本与后续兄弟移入最深壳
            const tail = container.textContent.slice(offset);
            container.textContent = container.textContent.slice(0, offset);
            if (tail) deepest.appendChild(doc.createTextNode(tail));
            for (let s = container.nextSibling; s;) {
                const next = s.nextSibling;
                deepest.appendChild(s);
                s = next;
            }
        } else {
            // 光标位于元素子节点之间：offset 之后的子节点移入最深壳
            for (let kid = container.childNodes[offset] || null; kid;) {
                const next = kid.nextSibling;
                deepest.appendChild(kid);
                kid = next;
            }
        }

        // 逐层上移：每层元素在其父层中排在其后的兄弟，移入对应外层壳（最外层即 newLine）
        for (let i = chain.length - 1; i >= 0; i--) {
            const outer = i === 0 ? newLine : shells[i - 1];
            for (let s = chain[i].nextSibling; s;) {
                const next = s.nextSibling;
                outer.appendChild(s);
                s = next;
            }
        }

        line.after(newLine);
        return newLine;
    }

    // ─── 浮动工具栏 ───

    async _onEditorSelectionChange(editor) {
        const selection = editor.selection;
        const selectedText = selection.getContent({ format: 'text' }).trim();
        const selectedHTML = selection.getContent({ format: 'html' }).trim();

        if (!selectedText || selectedText.length < 1) {
            this._hideFloatingToolbar();
            return;
        }

        const rng = selection.getRng();
        const rect = rng.getBoundingClientRect();
        if (!rect || rect.width === 0) {
            this._hideFloatingToolbar();
            return;
        }

        this._selectedText = selectedText;
        this._selectedHTML = selectedHTML;

        // TinyMCE 编辑区域在 iframe 中，需要加上 iframe 相对于父文档的偏移
        const iframe = editor.iframeElement;
        const iframeRect = iframe.getBoundingClientRect();
        const adjustedRect = {
            left: iframeRect.left + rect.left,
            right: iframeRect.left + rect.right,
            top: iframeRect.top + rect.top,
            bottom: iframeRect.top + rect.bottom,
            width: rect.width,
            height: rect.height
        };

        this._showFloatingToolbar(adjustedRect);
    }

    _showFloatingToolbar(selectionRect) {
        const toolbar = this.querySelector('#notes-floating-toolbar');
        if (!toolbar) return;

        // 获取当前编辑器中的对齐状态
        const editor = this._editorReady ? null : null; // will check after init

        toolbar.innerHTML = `
        <div class="notes-ftb">
            <button class="notes-ftb-btn" data-action="undo" title="${this._t('renderer.note.undo')}">
                <i class="fa-solid fa-rotate-left"></i>
            </button>
            <button class="notes-ftb-btn" data-action="redo" title="${this._t('renderer.note.redo')}">
                <i class="fa-solid fa-rotate-right"></i>
            </button>
            <div class="notes-ftb-sep"></div>
            <div class="notes-ftb-style-group">
                <button class="notes-ftb-btn" data-action="style-menu" title="${this._t('renderer.note.style.menu')}">
                    <i class="fa-solid fa-text-height"></i>
                    <i class="fa-solid fa-chevron-down" style="font-size:8px;"></i>
                </button>
                <div class="notes-ftb-style-submenu hidden" id="notes-style-submenu">
                    <button class="notes-ftb-style-item" data-action="h1" style="font-size:18px;font-weight:700;">${this._t('renderer.note.heading1')}</button>
                    <button class="notes-ftb-style-item" data-action="h2" style="font-size:16px;font-weight:700;">${this._t('renderer.note.heading2')}</button>
                    <button class="notes-ftb-style-item" data-action="h3" style="font-size:14px;font-weight:600;">${this._t('renderer.note.heading3')}</button>
                    <button class="notes-ftb-style-item" data-action="h4" style="font-size:13px;font-weight:600;">${this._t('renderer.note.heading4')}</button>
                    <button class="notes-ftb-style-item" data-action="h5" style="font-size:12px;font-weight:600;">${this._t('renderer.note.heading5')}</button>
                    <button class="notes-ftb-style-item" data-action="h6" style="font-size:11px;font-weight:600;">${this._t('renderer.note.heading6')}</button>
                    <button class="notes-ftb-style-item" data-action="p" style="font-size:13px;">${this._t('renderer.note.body')}</button>
                </div>
            </div>
            ${this._notesColorPickerMarkup('notes-float-color-submenu', { btnClass: 'notes-ftb-btn' })}
            <div class="notes-ftb-sep"></div>
            <button class="notes-ftb-btn" data-action="alignleft" title="${this._t('renderer.note.align.left')}">
                <i class="fa-solid fa-align-left"></i>
            </button>
            <button class="notes-ftb-btn" data-action="aligncenter" title="${this._t('renderer.note.align.center')}">
                <i class="fa-solid fa-align-center"></i>
            </button>
            <button class="notes-ftb-btn" data-action="alignright" title="${this._t('renderer.note.align.right')}">
                <i class="fa-solid fa-align-right"></i>
            </button>
            <div class="notes-ftb-sep"></div>
            <div class="notes-ftb-ai-group">
                <button class="notes-ftb-btn notes-ftb-ai-btn" data-action="ai-menu" title="${this._t('renderer.note.ai.assistant')}">
                    <i class="fa-solid fa-wand-magic-sparkles"></i>
                    <span>${this._t('renderer.note.ai.trigger')}</span>
                    <i class="fa-solid fa-chevron-down" style="font-size:8px;"></i>
                </button>
                <div class="notes-ftb-ai-submenu hidden" id="notes-ai-submenu">
                    <button class="notes-ftb-ai-item" data-action="polish">
                        <i class="fa-solid fa-sparkles"></i> ${this._t('renderer.note.ai.polish')}
                    </button>
                    <button class="notes-ftb-ai-item" data-action="translate" disabled>
                        <i class="fa-solid fa-language"></i> ${this._t('renderer.note.ai.translate')}
                    </button>
                    <button class="notes-ftb-ai-item" data-action="execute">
                        <i class="fa-solid fa-play"></i> ${this._t('renderer.note.ai.execute')}
                    </button>
                </div>
            </div>
        </div>`;

        // Position above selection, with edge avoidance
        const tbWidth = 480; // estimated toolbar width
        const tbHeight = 40;
        let left = selectionRect.left + selectionRect.width / 2 - tbWidth / 2;
        let top = selectionRect.top - tbHeight - 8;

        // Avoid left/right edges
        if (left < 8) left = 8;
        if (left + tbWidth > window.innerWidth - 8) left = window.innerWidth - 8 - tbWidth;

        // If no room above, show below
        if (top < 8) {
            top = selectionRect.bottom + 8;
        }

        // Avoid bottom edge
        if (top + tbHeight > window.innerHeight - 8) {
            top = window.innerHeight - 8 - tbHeight;
        }

        toolbar.style.left = `${left}px`;
        toolbar.style.top = `${top}px`;
        toolbar.classList.remove('hidden');

        this._bindFloatingToolbarActions();
    }

    _hideFloatingToolbar() {
        const toolbar = this.querySelector('#notes-floating-toolbar');
        if (toolbar) toolbar.classList.add('hidden');
    }

    /**
     * 调整子菜单位置，处理边缘自适应避让
     */
    _adjustSubmenuPosition(submenu) {
        if (!submenu) return;

        // 重置样式（移除所有内联样式，使用CSS默认样式）
        submenu.style.top = '';
        submenu.style.bottom = '';
        submenu.style.left = '';
        submenu.style.right = '';
        submenu.style.transform = '';
        submenu.style.marginTop = '';
        submenu.style.marginBottom = '';

        // 强制重绘以获取正确的尺寸
        submenu.getBoundingClientRect();

        // 获取按钮组（父元素）和按钮的位置
        const group = submenu.parentElement;
        if (!group) return;

        const button = group.querySelector('button');
        if (!button) return;

        const buttonRect = button.getBoundingClientRect();
        const submenuRect = submenu.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        // 检查垂直方向：按钮下方空间是否足够
        const spaceBelow = viewportHeight - buttonRect.bottom - 8;
        const spaceAbove = buttonRect.top - 8;
        const needShowAbove = spaceBelow < submenuRect.height && spaceAbove > spaceBelow;

        if (needShowAbove) {
            // 向上展开
            submenu.style.top = 'auto';
            submenu.style.bottom = '100%';
            submenu.style.marginBottom = '6px';
        } else {
            // 向下展开（默认，不需要额外设置，CSS已经设置了margin-top: 6px）
            submenu.style.marginTop = '6px';
        }

        // 检查水平方向
        const submenuWidth = submenuRect.width;
        const buttonCenter = buttonRect.left + buttonRect.width / 2;
        const centeredLeft = buttonCenter - submenuWidth / 2;
        const leftOverflow = 8 - centeredLeft;
        const rightOverflow = centeredLeft + submenuWidth - (viewportWidth - 8);

        if (leftOverflow > 0) {
            // 左侧超出，向右偏移，确保左边缘在视口内
            submenu.style.left = `${8 - group.getBoundingClientRect().left}px`;
            submenu.style.transform = 'none';
        } else if (rightOverflow > 0) {
            // 右侧超出，向左偏移，确保右边缘在视口内
            const groupRect = group.getBoundingClientRect();
            submenu.style.left = 'auto';
            submenu.style.right = `${8 - (viewportWidth - groupRect.right)}px`;
            submenu.style.transform = 'none';
        }
        // 否则保持居中（CSS默认样式）
    }

    async _bindFloatingToolbarActions() {
        const toolbar = this.querySelector('#notes-floating-toolbar');
        if (!toolbar) return;
        const editor = await this._editorReady;
        if (!editor) return;

        this._bindNotesColorPicker(toolbar, editor, 'notes-float-color-submenu');
        this._updateNotesColorIndicator(toolbar, editor);

        // Undo/Redo
        toolbar.querySelector('[data-action="undo"]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            editor.execCommand('undo');
        });
        toolbar.querySelector('[data-action="redo"]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            editor.execCommand('redo');
        });

        // Style menu toggle
        toolbar.querySelector('[data-action="style-menu"]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const submenu = toolbar.querySelector('#notes-style-submenu');
            submenu?.classList.toggle('hidden');
            toolbar.querySelector('#notes-ai-submenu')?.classList.add('hidden');
            toolbar.querySelector('#notes-float-color-submenu')?.classList.add('hidden');

            // 调整子菜单位置，处理边缘自适应
            if (submenu && !submenu.classList.contains('hidden')) {
                this._adjustSubmenuPosition(submenu);
            }
        });

        // Style items
        ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p'].forEach((tag) => {
            toolbar.querySelector(`[data-action="${tag}"]`)?.addEventListener('click', (e) => {
                e.stopPropagation();
                editor.execCommand('formatBlock', false, tag);
                toolbar.querySelector('#notes-style-submenu')?.classList.add('hidden');
            });
        });

        // Alignment
        toolbar.querySelector('[data-action="alignleft"]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            editor.execCommand('JustifyLeft');
        });
        toolbar.querySelector('[data-action="aligncenter"]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            editor.execCommand('JustifyCenter');
        });
        toolbar.querySelector('[data-action="alignright"]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            editor.execCommand('JustifyRight');
        });

        // AI menu toggle
        toolbar.querySelector('[data-action="ai-menu"]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const submenu = toolbar.querySelector('#notes-ai-submenu');
            submenu?.classList.toggle('hidden');
            toolbar.querySelector('#notes-style-submenu')?.classList.add('hidden');
            toolbar.querySelector('#notes-float-color-submenu')?.classList.add('hidden');

            // 调整子菜单位置，处理边缘自适应
            if (submenu && !submenu.classList.contains('hidden')) {
                this._adjustSubmenuPosition(submenu);
            }
        });

        // Polish
        toolbar.querySelector('[data-action="polish"]')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            this._hideFloatingToolbar();
            await this._polishSelection(editor, true);
        });

        // Execute
        toolbar.querySelector('[data-action="execute"]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this._hideFloatingToolbar();
            this._executeSelection();
        });

        // Click outside to close submenus
        const closeSubmenus = (e) => {
            if (!toolbar.contains(e.target)) {
                toolbar.querySelector('#notes-style-submenu')?.classList.add('hidden');
                toolbar.querySelector('#notes-ai-submenu')?.classList.add('hidden');
                toolbar.querySelector('#notes-float-color-submenu')?.classList.add('hidden');
                document.removeEventListener('click', closeSubmenus, true);
            }
        };
        setTimeout(() => document.addEventListener('click', closeSubmenus, true), 0);
    }

    // ─── AI 功能 ───

    _executeSelection() {
        const selectedText = this._selectedText;
        if (!selectedText) return;
        if (window.aiBarAPI?.submitRequestInNewTask) {
            const prompt = this._selectedHTML ? this._htmlToMarkdown(this._selectedHTML) : selectedText;
            window.aiBarAPI.submitRequestInNewTask(prompt);
        }
    }

    _htmlToMarkdown(html) {
        if (!this._turndownService) {
            this._turndownService = new TurndownService({
                headingStyle: 'atx',
                codeBlockStyle: 'fenced',
                bulletListMarker: '-'
            });
        }
        return this._turndownService.turndown(html);
    }

    // ─── 标签管理 ───

    async _showTagMenu(anchorEl) {
        const menu = this.querySelector('#notes-tag-menu');
        if (!menu) return;

        const note =
            this.notes.find((n) => n.id === this.currentNoteId) ||
            this.allNotes.find((n) => n.id === this.currentNoteId);
        if (!note) return;

        const rect = anchorEl.getBoundingClientRect();
        menu.style.left = `${rect.left}px`;
        menu.style.top = `${rect.bottom + 6}px`;

        let html = `<div class="notes-tag-menu-title">${this._t('renderer.note.tag.menu.title')}</div>`;
        for (const tag of this.tags) {
            const checked = note.tags.includes(tag.name);
            html += `
            <div class="notes-tag-menu-item" data-tag-name="${this._escapeAttr(tag.name)}">
                <div class="notes-tag-menu-item-left">
                    <div class="notes-tag-menu-item-check ${checked ? 'checked' : ''}">
                        <i class="fa-solid fa-check"></i>
                    </div>
                    <span class="notes-tag" style="background:${tag.color}18;color:${tag.color}">${tag.name}</span>
                </div>
                <button class="notes-tag-menu-item-del" data-del-tag="${this._escapeAttr(tag.name)}" title="${this._t('renderer.note.tag.delete')}">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>`;
        }
        html += `
        <div class="notes-tag-menu-new">
            <input id="notes-new-tag-input" type="text" placeholder="${this._t('renderer.note.tag.new.placeholder')}" />
            <button id="notes-new-tag-btn" class="notes-tag-menu-new-btn">${this._t('renderer.note.tag.add.button')}</button>
        </div>`;

        menu.innerHTML = html;
        menu.classList.remove('hidden');

        // Bind tag toggle
        menu.querySelectorAll('.notes-tag-menu-item').forEach((item) => {
            item.addEventListener('click', async (e) => {
                if (e.target.closest('.notes-tag-menu-item-del')) return;
                const tagName = item.dataset.tagName;
                await this._toggleTagOnCurrentNote(tagName);
                this._showTagMenu(anchorEl); // refresh
            });
        });

        // Bind tag delete
        menu.querySelectorAll('.notes-tag-menu-item-del').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const tagName = btn.dataset.delTag;
                const confirmed = await showConfirmModal({
                    icon: 'fa-tag',
                    iconBg: '#FFF3E0',
                    iconColor: '#FFA726',
                    title: this._t('renderer.note.tag.delete.confirm.title'),
                    message: this._t('renderer.note.tag.delete.confirm.message', { name: tagName }),
                    confirmText: this._t('renderer.note.common.delete'),
                    danger: true
                });
                if (confirmed) {
                    await window.applicationAPI.call('deleteTag', tagName);
                    await this._refreshTags();
                    this._showTagMenu(anchorEl); // refresh
                }
            });
        });

        // Bind new tag
        const newTagInput = menu.querySelector('#notes-new-tag-input');
        const newTagBtn = menu.querySelector('#notes-new-tag-btn');
        const addNewTag = async () => {
            const name = newTagInput.value.trim();
            if (!name) return;
            await window.applicationAPI.call('addTag', name);
            await this._refreshTags();
            await this._toggleTagOnCurrentNote(name);
            this._showTagMenu(anchorEl);
        };
        newTagBtn?.addEventListener('click', addNewTag);
        newTagInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.isComposing) addNewTag();
        });

        // Close on outside click
        const closeMenu = (e) => {
            if (!menu.contains(e.target) && e.target !== anchorEl && !anchorEl.contains(e.target)) {
                menu.classList.add('hidden');
                document.removeEventListener('click', closeMenu, true);
            }
        };
        setTimeout(() => document.addEventListener('click', closeMenu, true), 0);
    }

    async _toggleTagOnCurrentNote(tagName) {
        const note =
            this.notes.find((n) => n.id === this.currentNoteId) ||
            this.allNotes.find((n) => n.id === this.currentNoteId);
        if (!note) return;

        let newTags;
        if (note.tags.includes(tagName)) {
            newTags = note.tags.filter((t) => t !== tagName);
        } else {
            newTags = [...note.tags, tagName];
        }
        await window.applicationAPI.call('updateNote', this.currentNoteId, { tags: newTags });
        note.tags = newTags;
        this._refreshEditorTags();
    }

    async _removeTagFromCurrentNote(tagName) {
        const note =
            this.notes.find((n) => n.id === this.currentNoteId) ||
            this.allNotes.find((n) => n.id === this.currentNoteId);
        if (!note) return;
        const newTags = note.tags.filter((t) => t !== tagName);
        await window.applicationAPI.call('updateNote', this.currentNoteId, { tags: newTags });
        note.tags = newTags;
        this._refreshEditorTags();
    }

    _refreshEditorTags() {
        const note =
            this.notes.find((n) => n.id === this.currentNoteId) ||
            this.allNotes.find((n) => n.id === this.currentNoteId);
        if (!note) return;

        const tagsContainer = this.querySelector('#notes-editor-tags');
        if (!tagsContainer) return;

        const addBtn = tagsContainer.querySelector('#notes-add-tag-btn');
        const tagHtml = note.tags
            .map((t) => {
                const color = this._getTagColor(t);
                return `<span class="notes-tag removable" data-tag="${t}" style="background:${color}18;color:${color}">${t}<i class="fa-solid fa-xmark"></i></span>`;
            })
            .join('');

        // Remove existing tags, keep add button
        tagsContainer.innerHTML = tagHtml;
        tagsContainer.appendChild(addBtn || this._createAddTagBtn());

        // Re-bind tag remove events
        tagsContainer.querySelectorAll('.notes-tag.removable').forEach((tag) => {
            tag.addEventListener('click', async () => {
                await this._removeTagFromCurrentNote(tag.dataset.tag);
            });
        });
    }

    _createAddTagBtn() {
        const btn = document.createElement('button');
        btn.id = 'notes-add-tag-btn';
        btn.className = 'notes-add-tag-btn';
        btn.innerHTML = `<i class="fa-solid fa-plus" style="font-size:10px;"></i> ${this._t('renderer.note.tag.add')}`;
        btn.addEventListener('click', (e) => this._showTagMenu(e.currentTarget));
        return btn;
    }

    // ─── 排序/筛选下拉 ───

    _showSortDropdown(anchorEl) {
        const dropdown = this.querySelector('#notes-dropdown');
        if (!dropdown) return;

        const rect = anchorEl.getBoundingClientRect();
        dropdown.style.left = `${rect.left}px`;
        dropdown.style.top = `${rect.bottom + 6}px`;

        const options = [
            { value: 'updatedAt', label: this._t(SORT_LABELS.updatedAt), icon: 'fa-clock-rotate-left' },
            { value: 'createdAt', label: this._t(SORT_LABELS.createdAt), icon: 'fa-calendar-plus' },
            { value: 'title', label: this._t(SORT_LABELS.title), icon: 'fa-arrow-down-a-z' }
        ];

        dropdown.innerHTML = options
            .map(
                (opt) => `
            <button class="notes-dropdown-item ${this.sortBy === opt.value ? 'active' : ''}" data-sort="${opt.value}">
                <i class="fa-solid ${opt.icon}"></i> ${opt.label}
                ${this.sortBy === opt.value ? '<i class="fa-solid fa-check"></i>' : ''}
            </button>
        `
            )
            .join('');
        dropdown.classList.remove('hidden');

        dropdown.querySelectorAll('.notes-dropdown-item').forEach((item) => {
            item.addEventListener('click', async () => {
                this.sortBy = item.dataset.sort;
                this.querySelector('#notes-sort-label').textContent = item.textContent.trim();
                dropdown.classList.add('hidden');
                await this._refreshNotes();
            });
        });

        const closeDropdown = (e) => {
            if (!dropdown.contains(e.target) && e.target !== anchorEl) {
                dropdown.classList.add('hidden');
                document.removeEventListener('click', closeDropdown, true);
            }
        };
        setTimeout(() => document.addEventListener('click', closeDropdown, true), 0);
    }

    _showTagFilterDropdown(anchorEl) {
        const dropdown = this.querySelector('#notes-dropdown');
        if (!dropdown) return;

        const rect = anchorEl.getBoundingClientRect();
        dropdown.style.left = `${rect.left}px`;
        dropdown.style.top = `${rect.bottom + 6}px`;

        let html = `
            <button class="notes-dropdown-item ${!this.tagFilter ? 'active' : ''}" data-tag="">
                <i class="fa-solid fa-tags"></i> ${this._t('renderer.note.tag.all')}
                ${!this.tagFilter ? '<i class="fa-solid fa-check"></i>' : ''}
            </button>`;

        for (const tag of this.tags) {
            html += `
            <button class="notes-dropdown-item ${this.tagFilter === tag.name ? 'active' : ''}" data-tag="${this._escapeAttr(tag.name)}">
                <span class="notes-tag" style="background:${tag.color}18;color:${tag.color}">${tag.name}</span>
                ${this.tagFilter === tag.name ? '<i class="fa-solid fa-check"></i>' : ''}
            </button>`;
        }

        dropdown.innerHTML = html;
        dropdown.classList.remove('hidden');

        dropdown.querySelectorAll('.notes-dropdown-item').forEach((item) => {
            item.addEventListener('click', async () => {
                this.tagFilter = item.dataset.tag || null;
                this.querySelector('#notes-tag-filter-label').textContent =
                    this.tagFilter || this._t('renderer.note.tag.all');
                this.querySelector('#notes-tag-filter-btn').classList.toggle('active', !!this.tagFilter);
                dropdown.classList.add('hidden');
                this._applyFilters();
                if (!this.currentNoteId) this._renderCardGrid();
            });
        });

        const closeDropdown = (e) => {
            if (!dropdown.contains(e.target) && e.target !== anchorEl) {
                dropdown.classList.add('hidden');
                document.removeEventListener('click', closeDropdown, true);
            }
        };
        setTimeout(() => document.addEventListener('click', closeDropdown, true), 0);
    }

    // ─── 创建/删除笔记 ───

    async _createNote() {
        const note = await window.applicationAPI.call('createNote', { title: '' });
        await this._refreshNotes();
        this._openNote(note.id);
    }

    async _confirmDeleteNote() {
        const confirmed = await showConfirmModal({
            icon: 'fa-trash-can',
            iconBg: '#FEF2F2',
            iconColor: '#FF3B30',
            title: this._t('renderer.note.note.delete.confirm.title'),
            message: this._t('renderer.note.note.delete.confirm.message'),
            confirmText: this._t('renderer.note.common.delete'),
            danger: true
        });
        if (confirmed) {
            await window.applicationAPI.call('deleteNote', this.currentNoteId);
            this.currentNoteId = null;
            this._hideFloatingToolbar();
            if (window.tinymce) tinymce.remove('#notes-editor');
            await this._refreshNotes();
            await this._refreshDeletedNotes();
            this._renderCardGrid();
        }
    }

    // ─── 回收站 ───

    async _refreshDeletedNotes() {
        const deletedNotes = await window.applicationAPI.call('getDeletedNotes');
        this.deletedNotes = deletedNotes || [];
        this._updateDeletedBadge();
        if (this.showDeletedView) {
            this._renderDeletedView();
        }
    }

    _updateDeletedBadge() {
        const badge = this.querySelector('#notes-deleted-badge');
        const count = this.querySelector('#notes-deleted-count');
        if (badge) {
            if (this.deletedNotes.length > 0) {
                badge.textContent = String(this.deletedNotes.length);
                badge.style.display = '';
            } else {
                badge.style.display = 'none';
            }
        }
        if (count) {
            count.textContent = this._t('renderer.note.count.notes', { count: this.deletedNotes.length });
        }
    }

    _toggleDeletedView() {
        this.showDeletedView = !this.showDeletedView;

        // 更新入口高亮
        const entry = this.querySelector('#notes-deleted-entry');
        if (entry) entry.classList.toggle('active', this.showDeletedView);

        if (this.showDeletedView) {
            // 关闭当前编辑的笔记
            if (this.currentNoteId) {
                this._autoSave();
                this.currentNoteId = null;
                if (window.tinymce) tinymce.remove('#notes-editor');
            }
            this._renderDeletedView();
        } else {
            this._renderCardGrid();
        }
    }

    _renderDeletedView() {
        const main = this.querySelector('#notes-main');
        if (!main) return;

        if (this.deletedNotes.length === 0) {
            main.innerHTML = `
            <div style="padding:36px 24px 0;">
                <button id="notes-deleted-back-btn" class="notes-close-btn" style="margin-bottom:16px;">
                    <i class="fa-solid fa-chevron-left" style="font-size:10px;"></i> ${this._t('renderer.note.editor.back')}
                </button>
            </div>
            <div class="notes-empty" style="padding-top:40px;">
                <i class="fa-regular fa-trash-can"></i>
                <p>${this._t('renderer.note.deleted.empty')}</p>
            </div>`;
            main.querySelector('#notes-deleted-back-btn')?.addEventListener('click', () => this._toggleDeletedView());
            return;
        }

        let html = `
        <div style="padding:36px 24px 16px;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                <button id="notes-deleted-back-btn" class="notes-close-btn">
                    <i class="fa-solid fa-chevron-left" style="font-size:10px;"></i> ${this._t('renderer.note.editor.back')}
                </button>
                <button id="notes-empty-recycle-btn" class="notes-empty-recycle-btn">
                    <i class="fa-regular fa-trash-can" style="font-size:11px;"></i> ${this._t('renderer.note.deleted.clear')}
                </button>
            </div>
            <div>
                <h2 style="font-size:18px;font-weight:700;color:#1d1d1f;">${this._t('renderer.note.deleted.entry')}</h2>
                <p style="font-size:12px;color:#8E8E93;margin-top:2px;">${this._t('renderer.note.deleted.hint')}</p>
            </div>
        </div>
        <div style="padding:0 24px 24px;overflow-y:auto;" id="notes-deleted-container">`;

        for (const note of this.deletedNotes) {
            const remainingDays = this._getRemainingDays(note.expiresAt);
            html += `
        <div class="notes-deleted-item" data-note-id="${note.id}" style="margin-bottom:8px;">
            <div class="notes-deleted-item-title">${this._escapeHtml(note.title || this._t('renderer.note.untitled'))}</div>
            <div class="notes-deleted-item-meta">
                <span class="notes-deleted-item-time">${this._t('renderer.note.deleted.deletedAt', { time: this._formatRelativeTime(note.deletedAt) })}</span>
                <span class="notes-deleted-item-remaining">${this._t('renderer.note.deleted.remaining', { days: remainingDays })}</span>
            </div>
            <div class="notes-deleted-item-actions">
                <button class="notes-restore-btn" data-restore-id="${note.id}">
                    <i class="fa-solid fa-rotate-left" style="font-size:11px;"></i> ${this._t('renderer.note.restore')}
                </button>
                <button class="notes-permanent-delete-btn" data-perm-delete-id="${note.id}">
                    <i class="fa-regular fa-trash-can" style="font-size:11px;"></i> ${this._t('renderer.note.delete.permanent')}
                </button>
            </div>
        </div>`;
        }

        html += `</div>`;
        main.innerHTML = html;

        // 绑定返回按钮
        main.querySelector('#notes-deleted-back-btn')?.addEventListener('click', () => this._toggleDeletedView());

        // 绑定恢复按钮
        main.querySelectorAll('.notes-restore-btn').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const noteId = btn.dataset.restoreId;
                await window.applicationAPI.call('restoreNote', noteId);
                await this._refreshDeletedNotes();
                await this._refreshNotes();
            });
        });

        // 绑定永久删除按钮
        main.querySelectorAll('.notes-permanent-delete-btn').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const noteId = btn.dataset.permDeleteId;
                const confirmed = await showConfirmModal({
                    icon: 'fa-trash-can',
                    iconBg: '#FEF2F2',
                    iconColor: '#FF3B30',
                    title: this._t('renderer.note.delete.permanent'),
                    message: this._t('renderer.note.permanent.confirm.message'),
                    confirmText: this._t('renderer.note.delete.permanent'),
                    danger: true
                });
                if (confirmed) {
                    await window.applicationAPI.call('permanentlyDeleteNote', noteId);
                    await this._refreshDeletedNotes();
                }
            });
        });

        // 绑定清空回收站按钮
        main.querySelector('#notes-empty-recycle-btn')?.addEventListener('click', async () => {
            const confirmed = await showConfirmModal({
                icon: 'fa-trash-can',
                iconBg: '#FEF2F2',
                iconColor: '#FF3B30',
                title: this._t('renderer.note.deleted.clear'),
                message: this._t('renderer.note.clear.confirm.message', { count: this.deletedNotes.length }),
                confirmText: this._t('renderer.note.clear.confirm.button'),
                danger: true
            });
            if (confirmed) {
                await window.applicationAPI.call('emptyRecycleBin');
                await this._refreshDeletedNotes();
            }
        });
    }

    _getRemainingDays(expiresAt) {
        const remaining = expiresAt - Date.now();
        const days = Math.ceil(remaining / 86400000);
        return Math.max(0, days);
    }

    // ─── 自动保存 ───

    _scheduleAutoSave() {
        if (this._autoSaveTimer) clearTimeout(this._autoSaveTimer);
        this._autoSaveTimer = setTimeout(() => this._autoSave(), 1500);
    }

    async _autoSave() {
        if (this._isSaving || !this.currentNoteId) return;
        this._isSaving = true;

        try {
            const editor = await this._editorReady;
            const titleEl = this.querySelector('#notes-title-input');
            const title = titleEl?.value || '';
            const content = editor?.getContent() || '';

            // 检测内容是否变化
            const contentChanged = content !== this._originalNoteContent || title !== this._originalNoteTitle;

            if (contentChanged) {
                await window.applicationAPI.call('updateNote', this.currentNoteId, { title, updatedAt: Date.now() });
                await window.applicationAPI.call('updateNoteContent', this.currentNoteId, content);

                // 更新原始内容，避免重复保存
                this._originalNoteTitle = title;
                this._originalNoteContent = content;

                // Update local cache
                const note = this.allNotes.find((n) => n.id === this.currentNoteId);
                if (note) {
                    note.title = title;
                    note.updatedAt = Date.now();
                }
            }
        } catch (err) {
            console.error('自动保存失败:', err);
        } finally {
            this._isSaving = false;
        }
    }

    // ─── 工具函数 ───

    _extractPreview(note) {
        return note.preview || '';
    }

    _getTagColor(tagName) {
        const tag = this.tags.find((t) => t.name === tagName);
        return tag?.color || '#007AFF';
    }

    _formatRelativeTime(timestamp) {
        const now = Date.now();
        const diff = now - timestamp;
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);

        if (minutes < 1) return this._t('renderer.note.time.justNow');
        if (minutes < 60) return this._t('renderer.note.time.minutesAgo', { n: minutes });
        if (hours < 24) return this._t('renderer.note.time.hoursAgo', { n: hours });
        if (days < 7) return this._t('renderer.note.time.daysAgo', { n: days });
        const date = new Date(timestamp);
        return `${date.getMonth() + 1}/${date.getDate()}`;
    }

    _escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    _escapeAttr(str) {
        if (!str) return '';
        return str
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }
}

customElements.define('notes-entry-widget', NotesEntryWidget);
