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
import { z } from 'zod';

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

const NOTE_PAGE_SIZE = 30;

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
.notes-fixed-toolbar {
    display: flex; align-items: center; gap: 2px;
    padding: 6px 0; border-bottom: 1px solid #F0F0F0;
    background: #FAFAFA; flex-shrink: 0;
    margin: 0 24px;
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
.notes-editor-body {
    flex: 1; min-height: 0; padding: 0 24px;
}
.notes-editor-body .tox-tinymce {
    border: none !important;
}
.notes-editor-body .tox .tox-edit-area__iframe {
    background: #fff !important;
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
`;

class NotesEntryWidget extends AgentOperableHTMLElement {
    constructor() {
        super();
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
        this._toolbarHiddenLevel = 0;
        this._onNotesChanged = null;
        this._onTagsChanged = null;
        this._onDeletedNotesChanged = null;
        this._selectedText = '';
        this.deletedNotes = [];
        this.showDeletedView = false;
    }

    connectedCallback() {
        this._injectStyles();
        this._render();
        this._bindCore();
        this._loadInitialData();
    }

    disconnectedCallback() {
        if (this._autoSaveTimer) clearTimeout(this._autoSaveTimer);
        if (this._scrollObserver) this._scrollObserver.disconnect();
        if (this._toolbarResizeObserver) {
            this._toolbarResizeObserver.disconnect();
            this._toolbarResizeObserver = null;
        }
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

    // ─── Agent 支持 ───

    getAgentInstruct() {
        return '你是笔记助手，帮助用户管理、搜索和整理笔记。当前页面展示了用户的笔记列表和编辑器。';
    }

    getToolset() {
        const toolset = new RendererToolset('notes');
        const listTool = new RendererTool('listCurrentNotes', '获取当前界面中显示的所有笔记的标题和摘要', z.object({}));
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
                                <h2 style="font-size:20px;font-weight:700;color:#1d1d1f;">笔记</h2>
                                <button id="notes-new-btn" class="notes-new-btn">
                                    <i class="fa-solid fa-plus" style="font-size:11px;"></i>
                                    <span>新建</span>
                                </button>
                            </div>
                            <div class="notes-search">
                                <i class="fa-solid fa-magnifying-glass notes-search-icon"></i>
                                <input id="notes-search-input" type="text" placeholder="搜索笔记..." class="notes-search-input" />
                            </div>
                            <div id="notes-filter-bar" class="notes-filter-bar">
                                <button id="notes-sort-btn" class="notes-filter-btn">
                                    <i class="fa-solid fa-arrow-down-short-wide"></i>
                                    <span id="notes-sort-label">最近修改</span>
                                </button>
                                <button id="notes-tag-filter-btn" class="notes-filter-btn">
                                    <i class="fa-solid fa-tag"></i>
                                    <span id="notes-tag-filter-label">全部标签</span>
                                </button>
                            </div>
                        </div>
                        <div id="notes-list" class="flex-1 overflow-y-auto notes-scroll" style="padding:0 20px;"></div>
                        <div id="notes-deleted-entry" class="notes-deleted-entry" style="padding-left:20px;padding-right:20px;">
                            <div class="notes-deleted-entry-icon">
                                <i class="fa-regular fa-trash-can"></i>
                            </div>
                            <div class="notes-deleted-entry-text">
                                <div class="notes-deleted-entry-title">已删除</div>
                                <div class="notes-deleted-entry-count" id="notes-deleted-count">0 条笔记</div>
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
        if (date >= today) return '今天';
        if (date >= yesterday) return '昨天';
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    _buildRenderList() {
        const groups = new Map();
        for (const note of this.notes) {
            const group = this._getTimeGroup(note.updatedAt);
            if (!groups.has(group)) groups.set(group, []);
            groups.get(group).push(note);
        }
        const list = [];
        for (const [header, items] of groups) {
            list.push({ type: 'header', text: header });
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
            container.innerHTML = `<div class="notes-empty"><i class="fa-regular fa-note-sticky"></i><p>暂无笔记</p></div>`;
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
                    <div class="notes-item-title">${this._escapeHtml(note.title || '无标题')}</div>
                    <div class="notes-item-preview">${this._escapeHtml(preview)}</div>
                    <div class="notes-item-meta">
                        <div class="notes-item-tags">${tagHtml}</div>
                        <span class="notes-item-time">${this._formatRelativeTime(note.updatedAt)}</span>
                    </div>`;
                div.addEventListener('click', () => this._openNote(note.id));
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

    _renderCardGrid() {
        const main = this.querySelector('#notes-main');
        if (!main) return;

        if (this.notes.length === 0) {
            main.innerHTML = `
            <div class="notes-empty" style="padding-top:80px;">
                <i class="fa-regular fa-note-sticky"></i>
                <p>点击"新建"创建第一条笔记</p>
            </div>`;
            return;
        }

        let html = `
        <div style="padding:36px 24px 16px;display:flex;align-items:center;justify-content:space-between;">
            <h2 style="font-size:18px;font-weight:700;color:#1d1d1f;">全部笔记</h2>
            <span style="font-size:13px;color:#8E8E93;">${this.notes.length} 条</span>
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
                <div class="notes-card-title">${this._escapeHtml(note.title || '无标题')}</div>
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
                            <i class="fa-solid fa-chevron-left" style="font-size:10px;"></i> 返回
                        </button>
                        <button id="notes-pin-note-btn" class="notes-filter-btn" style="font-size:12px;${note.isPinned ? 'background:#FFF3E0;border-color:#FFA726;color:#E65100;' : ''}">
                            <i class="fa-solid fa-thumbtack" style="font-size:10px;"></i>
                            <span>${note.isPinned ? '已置顶' : '置顶'}</span>
                        </button>
                        <button id="notes-delete-note-btn" class="notes-delete-btn">
                            <i class="fa-regular fa-trash-can" style="font-size:11px;"></i> 删除
                        </button>
                    </div>
                </div>
                <input id="notes-title-input" type="text" class="notes-title-input"
                       value="${this._escapeAttr(note.title)}" placeholder="笔记标题" />
                <div id="notes-editor-tags" class="notes-editor-tags">
                    ${tagHtml}
                    <button id="notes-add-tag-btn" class="notes-add-tag-btn">
                        <i class="fa-solid fa-plus" style="font-size:10px;"></i> 标签
                    </button>
                </div>
            </div>
            <div id="notes-fixed-toolbar" class="notes-fixed-toolbar"></div>
            <div class="notes-editor-body flex-1 min-h-0" style="padding:0 24px;">
                <textarea id="notes-editor">${this._escapeHtml(this.currentNoteContent)}</textarea>
            </div>
        </div>`;

        this._initTinyMCE();
        this._bindEditorEvents();
    }

    _initTinyMCE() {
        if (window.tinymce) tinymce.remove('#notes-editor');

        this._editorReady = new Promise((resolve) => {
            this._resolveEditor = resolve;
        });

        tinymce.init({
            selector: '#notes-editor',
            height: '100%',
            menubar: false,
            branding: false,
            statusbar: false,
            resize: false,
            language: 'zh_CN',
            skin: false,
            content_css: false,
            content_style:
                contentCss +
                '\n' +
                contentUiCss +
                `
                body { font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
                       font-size: 15px; line-height: 1.7; color: #1d1d1f; padding: 8px; margin: 0; }
                h1 { font-size: 24px; font-weight: 700; margin: 16px 0 8px; }
                h2 { font-size: 20px; font-weight: 700; margin: 14px 0 6px; }
                h3 { font-size: 17px; font-weight: 600; margin: 12px 0 4px; }
                h4 { font-size: 15px; font-weight: 600; margin: 10px 0 4px; }
                h5 { font-size: 14px; font-weight: 600; margin: 8px 0 4px; }
                h6 { font-size: 13px; font-weight: 600; margin: 8px 0 4px; }
                blockquote { border-left: 3px solid #FFA726; padding-left: 12px; color: #8E8E93; margin: 8px 0; }
                p { margin: 4px 0; }
            `,
            license_key: 'gpl',
            highlight_on_focus: false,
            toolbar: false,
            plugins: ['advlist', 'autolink', 'lists', 'link', 'image', 'charmap', 'code', 'table', 'wordcount'],
            setup: (editor) => {
                editor.on('selectionchange', () => this._onEditorSelectionChange(editor));
                editor.on('input', () => this._scheduleAutoSave());
                editor.on('change', () => this._scheduleAutoSave());
                editor.on('keydown', (e) => {
                    if (e.key === 'Escape') this._hideFloatingToolbar();
                });
                editor.on('mousedown', () => {
                    this.querySelector('#notes-tag-menu')?.classList.add('hidden');
                    this.querySelector('#notes-dropdown')?.classList.add('hidden');
                });
            },
            init_instance_callback: (editor) => {
                this._resolveEditor(editor);
                this._renderFixedToolbar(editor);
            }
        });
    }

    _renderFixedToolbar(editor) {
        const toolbar = this.querySelector('#notes-fixed-toolbar');
        if (!toolbar) return;

        // 检查当前是否有选中文本，决定润色按钮文案
        const hasSelection = editor.selection.getContent({ format: 'text' }).trim().length > 0;
        const polishLabel = hasSelection ? '润色选中' : '润色全文';

        toolbar.innerHTML = `
        <button class="notes-ftb-fixed-btn" data-action="undo" data-hide-priority="6" title="撤销">
            <i class="fa-solid fa-rotate-left"></i>
        </button>
        <button class="notes-ftb-fixed-btn" data-action="redo" data-hide-priority="6" title="重做">
            <i class="fa-solid fa-rotate-right"></i>
        </button>
        <div class="notes-ftb-fixed-sep" data-hide-priority="5"></div>
        <button class="notes-ftb-fixed-btn" data-action="bold" data-hide-priority="5" title="粗体">
            <i class="fa-solid fa-bold"></i>
        </button>
        <button class="notes-ftb-fixed-btn" data-action="italic" data-hide-priority="5" title="斜体">
            <i class="fa-solid fa-italic"></i>
        </button>
        <button class="notes-ftb-fixed-btn" data-action="underline" data-hide-priority="5" title="下划线">
            <i class="fa-solid fa-underline"></i>
        </button>
        <button class="notes-ftb-fixed-btn" data-action="strikethrough" data-hide-priority="5" title="删除线">
            <i class="fa-solid fa-strikethrough"></i>
        </button>
        <div class="notes-ftb-fixed-sep" data-hide-priority="4"></div>
        <button class="notes-ftb-fixed-btn" data-action="h1" data-hide-priority="4" title="标题1" style="font-weight:700;">H1</button>
        <button class="notes-ftb-fixed-btn" data-action="h2" data-hide-priority="4" title="标题2" style="font-weight:700;">H2</button>
        <button class="notes-ftb-fixed-btn" data-action="h3" data-hide-priority="4" title="标题3" style="font-weight:600;">H3</button>
        <button class="notes-ftb-fixed-btn" data-action="p" data-hide-priority="4" title="正文" style="font-size:11px;">正文</button>
        <div class="notes-ftb-fixed-sep" data-hide-priority="3"></div>
        <button class="notes-ftb-fixed-btn" data-action="bullist" data-hide-priority="3" title="无序列表">
            <i class="fa-solid fa-list-ul"></i>
        </button>
        <button class="notes-ftb-fixed-btn" data-action="numlist" data-hide-priority="3" title="有序列表">
            <i class="fa-solid fa-list-ol"></i>
        </button>
        <div class="notes-ftb-fixed-sep" data-hide-priority="2"></div>
        <button class="notes-ftb-fixed-btn" data-action="alignleft" data-hide-priority="2" title="左对齐">
            <i class="fa-solid fa-align-left"></i>
        </button>
        <button class="notes-ftb-fixed-btn" data-action="aligncenter" data-hide-priority="2" title="居中">
            <i class="fa-solid fa-align-center"></i>
        </button>
        <button class="notes-ftb-fixed-btn" data-action="alignright" data-hide-priority="2" title="右对齐">
            <i class="fa-solid fa-align-right"></i>
        </button>
        <div class="notes-ftb-fixed-sep" data-hide-priority="1"></div>
        <button class="notes-ftb-fixed-btn" data-action="blockquote" data-hide-priority="1" title="引用">
            <i class="fa-solid fa-quote-left"></i>
        </button>
        <button class="notes-ftb-fixed-btn" data-action="link" data-hide-priority="1" title="链接">
            <i class="fa-solid fa-link"></i>
        </button>
        <button class="notes-ftb-fixed-btn" data-action="image" data-hide-priority="1" title="图片">
            <i class="fa-solid fa-image"></i>
        </button>
        <button class="notes-ftb-fixed-btn" data-action="code" data-hide-priority="1" title="源代码">
            <i class="fa-solid fa-code"></i>
        </button>
        <button class="notes-ftb-fixed-btn notes-ftb-fixed-ai" data-action="ai-polish" data-hide-priority="0" title="AI 润色">
            <i class="fa-solid fa-wand-magic-sparkles"></i>
            <span>${polishLabel}</span>
        </button>`;

        // Bind fixed toolbar actions
        toolbar.querySelectorAll('.notes-ftb-fixed-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const action = btn.dataset.action;
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
            if (aiBtn) aiBtn.textContent = hasSel ? '润色选中' : '润色全文';
        });

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
        overlay.innerHTML =
            '<div class="notes-polishing-indicator"><i class="fa-solid fa-spinner"></i> 正在润色...</div>';
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
                pinBtn.querySelector('span').textContent = newPinned ? '已置顶' : '置顶';
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
    }

    // ─── 浮动工具栏 ───

    async _onEditorSelectionChange(editor) {
        const selection = editor.selection;
        const selectedText = selection.getContent({ format: 'text' }).trim();

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
            <button class="notes-ftb-btn" data-action="undo" title="撤销">
                <i class="fa-solid fa-rotate-left"></i>
            </button>
            <button class="notes-ftb-btn" data-action="redo" title="重做">
                <i class="fa-solid fa-rotate-right"></i>
            </button>
            <div class="notes-ftb-sep"></div>
            <div class="notes-ftb-style-group">
                <button class="notes-ftb-btn" data-action="style-menu" title="样式">
                    <i class="fa-solid fa-text-height"></i>
                    <i class="fa-solid fa-chevron-down" style="font-size:8px;"></i>
                </button>
                <div class="notes-ftb-style-submenu hidden" id="notes-style-submenu">
                    <button class="notes-ftb-style-item" data-action="h1" style="font-size:18px;font-weight:700;">标题 1</button>
                    <button class="notes-ftb-style-item" data-action="h2" style="font-size:16px;font-weight:700;">标题 2</button>
                    <button class="notes-ftb-style-item" data-action="h3" style="font-size:14px;font-weight:600;">标题 3</button>
                    <button class="notes-ftb-style-item" data-action="h4" style="font-size:13px;font-weight:600;">标题 4</button>
                    <button class="notes-ftb-style-item" data-action="h5" style="font-size:12px;font-weight:600;">标题 5</button>
                    <button class="notes-ftb-style-item" data-action="h6" style="font-size:11px;font-weight:600;">标题 6</button>
                    <button class="notes-ftb-style-item" data-action="p" style="font-size:13px;">正文</button>
                </div>
            </div>
            <div class="notes-ftb-sep"></div>
            <button class="notes-ftb-btn" data-action="alignleft" title="左对齐">
                <i class="fa-solid fa-align-left"></i>
            </button>
            <button class="notes-ftb-btn" data-action="aligncenter" title="居中">
                <i class="fa-solid fa-align-center"></i>
            </button>
            <button class="notes-ftb-btn" data-action="alignright" title="右对齐">
                <i class="fa-solid fa-align-right"></i>
            </button>
            <div class="notes-ftb-sep"></div>
            <div class="notes-ftb-ai-group">
                <button class="notes-ftb-btn notes-ftb-ai-btn" data-action="ai-menu" title="AI 助手">
                    <i class="fa-solid fa-wand-magic-sparkles"></i>
                    <span>帮我</span>
                    <i class="fa-solid fa-chevron-down" style="font-size:8px;"></i>
                </button>
                <div class="notes-ftb-ai-submenu hidden" id="notes-ai-submenu">
                    <button class="notes-ftb-ai-item" data-action="polish">
                        <i class="fa-solid fa-sparkles"></i> 润色
                    </button>
                    <button class="notes-ftb-ai-item" data-action="translate" disabled>
                        <i class="fa-solid fa-language"></i> 翻译（即将推出）
                    </button>
                    <button class="notes-ftb-ai-item" data-action="execute">
                        <i class="fa-solid fa-play"></i> 执行
                    </button>
                </div>
            </div>
        </div>`;

        // Position above selection, with edge avoidance
        const tbWidth = 420; // estimated toolbar width
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

    async _bindFloatingToolbarActions() {
        const toolbar = this.querySelector('#notes-floating-toolbar');
        if (!toolbar) return;
        const editor = await this._editorReady;
        if (!editor) return;

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
            toolbar.querySelector('#notes-style-submenu')?.classList.toggle('hidden');
            toolbar.querySelector('#notes-ai-submenu')?.classList.add('hidden');
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
            toolbar.querySelector('#notes-ai-submenu')?.classList.toggle('hidden');
            toolbar.querySelector('#notes-style-submenu')?.classList.add('hidden');
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
            window.aiBarAPI.submitRequestInNewTask(selectedText);
        }
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

        let html = `<div class="notes-tag-menu-title">选择标签</div>`;
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
                <button class="notes-tag-menu-item-del" data-del-tag="${this._escapeAttr(tag.name)}" title="删除标签">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>`;
        }
        html += `
        <div class="notes-tag-menu-new">
            <input id="notes-new-tag-input" type="text" placeholder="新建标签..." />
            <button id="notes-new-tag-btn" class="notes-tag-menu-new-btn">添加</button>
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
                    title: '删除标签',
                    message: `确定要删除标签"${tagName}"吗？该标签将从所有笔记中移除。`,
                    confirmText: '删除',
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
            if (e.key === 'Enter') addNewTag();
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
        btn.innerHTML = '<i class="fa-solid fa-plus" style="font-size:10px;"></i> 标签';
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
            { value: 'updatedAt', label: '最近修改', icon: 'fa-clock-rotate-left' },
            { value: 'createdAt', label: '最近创建', icon: 'fa-calendar-plus' },
            { value: 'title', label: '按标题', icon: 'fa-arrow-down-a-z' }
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
                <i class="fa-solid fa-tags"></i> 全部标签
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
                this.querySelector('#notes-tag-filter-label').textContent = this.tagFilter || '全部标签';
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
            title: '删除笔记',
            message: '确定要删除这条笔记吗？删除后可在回收站中恢复，10天后将永久删除。',
            confirmText: '删除',
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
            count.textContent = `${this.deletedNotes.length} 条笔记`;
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
                    <i class="fa-solid fa-chevron-left" style="font-size:10px;"></i> 返回
                </button>
            </div>
            <div class="notes-empty" style="padding-top:40px;">
                <i class="fa-regular fa-trash-can"></i>
                <p>回收站为空</p>
            </div>`;
            main.querySelector('#notes-deleted-back-btn')?.addEventListener('click', () => this._toggleDeletedView());
            return;
        }

        let html = `
        <div style="padding:36px 24px 16px;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                <button id="notes-deleted-back-btn" class="notes-close-btn">
                    <i class="fa-solid fa-chevron-left" style="font-size:10px;"></i> 返回
                </button>
                <button id="notes-empty-recycle-btn" class="notes-empty-recycle-btn">
                    <i class="fa-regular fa-trash-can" style="font-size:11px;"></i> 清空回收站
                </button>
            </div>
            <div>
                <h2 style="font-size:18px;font-weight:700;color:#1d1d1f;">已删除</h2>
                <p style="font-size:12px;color:#8E8E93;margin-top:2px;">笔记删除后10天内可恢复</p>
            </div>
        </div>
        <div style="padding:0 24px 24px;overflow-y:auto;" id="notes-deleted-container">`;

        for (const note of this.deletedNotes) {
            const remainingDays = this._getRemainingDays(note.expiresAt);
            html += `
        <div class="notes-deleted-item" data-note-id="${note.id}" style="margin-bottom:8px;">
            <div class="notes-deleted-item-title">${this._escapeHtml(note.title || '无标题')}</div>
            <div class="notes-deleted-item-meta">
                <span class="notes-deleted-item-time">删除于 ${this._formatRelativeTime(note.deletedAt)}</span>
                <span class="notes-deleted-item-remaining">${remainingDays}天后永久删除</span>
            </div>
            <div class="notes-deleted-item-actions">
                <button class="notes-restore-btn" data-restore-id="${note.id}">
                    <i class="fa-solid fa-rotate-left" style="font-size:11px;"></i> 恢复
                </button>
                <button class="notes-permanent-delete-btn" data-perm-delete-id="${note.id}">
                    <i class="fa-regular fa-trash-can" style="font-size:11px;"></i> 永久删除
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
                    title: '永久删除',
                    message: '确定要永久删除这条笔记吗？此操作无法撤销。',
                    confirmText: '永久删除',
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
                title: '清空回收站',
                message: `确定要永久删除回收站中的所有 ${this.deletedNotes.length} 条笔记吗？此操作无法撤销。`,
                confirmText: '清空',
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

            await window.applicationAPI.call('updateNote', this.currentNoteId, { title, updatedAt: Date.now() });
            await window.applicationAPI.call('updateNoteContent', this.currentNoteId, content);

            // Update local cache
            const note = this.allNotes.find((n) => n.id === this.currentNoteId);
            if (note) {
                note.title = title;
                note.updatedAt = Date.now();
            }
        } catch (err) {
            console.error('自动保存失败:', err);
        } finally {
            this._isSaving = false;
        }
    }

    // ─── 工具函数 ───

    _extractPreview(note) {
        // 从 content 中提取纯文本预览（如果有缓存的内容）
        // 否则返回空
        return '';
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

        if (minutes < 1) return '刚刚';
        if (minutes < 60) return `${minutes}分钟前`;
        if (hours < 24) return `${hours}小时前`;
        if (days < 7) return `${days}天前`;
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
