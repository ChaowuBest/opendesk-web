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

export const BROWSER_TOOLS_CSS = `
            /* ---- History / Bookmark management panels ---- */
            .wb-panel-overlay {
                display: none;
                position: absolute; top: 0; right: 0;
                width: min(380px, 100%); height: 100%;
                background: var(--od-bg-elevated);
                border-left: 1px solid var(--od-border);
                box-shadow: -4px 0 16px rgba(0,0,0,0.06);
                z-index: 50;
                flex-direction: column;
            }
            .wb-panel-overlay.wb-visible { display: flex; }
            .wb-panel-header {
                display: flex; align-items: center; gap: 8px;
                padding: 12px 16px;
                border-bottom: 1px solid var(--od-border);
                flex-shrink: 0;
            }
            .wb-panel-header-title {
                flex: 1; font-size: var(--fs-lg); font-weight: 600; color: var(--od-text);
            }
            .wb-panel-close {
                width: 28px; height: 28px; border: none; background: transparent;
                border-radius: 6px; cursor: pointer; color: var(--od-text-muted);
                display: flex; align-items: center; justify-content: center;
                transition: background 0.12s;
            }
            .wb-panel-close:hover { background: var(--od-bg-subtle); }
            .wb-panel-search {
                margin: 8px 16px; padding: 6px 10px;
                border: 1px solid var(--od-border); border-radius: 6px;
                font-size: var(--fs-base); outline: none;
                transition: border-color 0.15s;
            }
            .wb-panel-search:focus { border-color: var(--chat-accent); }
            .wb-panel-body {
                flex: 1; overflow-y: auto; padding: 4px 0;
            }
            .wb-panel-empty {
                text-align: center; color: var(--od-text-muted); padding: 32px 16px; font-size: var(--fs-base);
            }

            /* History items */
            .wb-history-item {
                display: flex; align-items: center; gap: 8px;
                padding: 8px 16px;
                cursor: pointer;
                transition: background 0.1s;
            }
            .wb-history-item:hover { background: var(--od-bg-subtle); }
            .wb-hi-icon { color: var(--od-text-muted); font-size: var(--fs-sm); flex-shrink: 0; }
            .wb-hi-content { flex: 1; min-width: 0; }
            .wb-hi-title { font-size: var(--fs-base); color: var(--od-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .wb-hi-url { font-size: var(--fs-sm); color: var(--od-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .wb-hi-time { font-size: var(--fs-sm); color: var(--od-text-muted); flex-shrink: 0; }
            .wb-hi-delete {
                width: 22px; height: 22px; border: none; background: transparent;
                border-radius: 4px; cursor: pointer; color: #d1d5db;
                display: flex; align-items: center; justify-content: center;
                opacity: 0; transition: all 0.12s; font-size: var(--fs-xs);
            }
            .wb-history-item:hover .wb-hi-delete { opacity: 1; }
            .wb-hi-delete:hover { background: #fee2e2; color: #ef4444; }

            /* Bookmark management items */
            .wb-bm-mgr-item {
                display: flex; align-items: center; gap: 8px;
                padding: 8px 16px;
                cursor: pointer;
                transition: background 0.1s;
            }
            .wb-bm-mgr-item:hover { background: var(--od-bg-subtle); }
            .wb-bm-mgr-icon { color: #f59e0b; font-size: var(--fs-sm); flex-shrink: 0; }
            .wb-bm-mgr-content { flex: 1; min-width: 0; }
            .wb-bm-mgr-title { font-size: var(--fs-base); color: var(--od-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .wb-bm-mgr-url { font-size: var(--fs-sm); color: var(--od-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .wb-bm-mgr-actions {
                display: flex; gap: 2px; opacity: 0; transition: opacity 0.12s;
            }
            .wb-bm-mgr-item:hover .wb-bm-mgr-actions { opacity: 1; }
            .wb-bm-mgr-btn {
                width: 22px; height: 22px; border: none; background: transparent;
                border-radius: 4px; cursor: pointer; color: var(--od-text-muted);
                display: flex; align-items: center; justify-content: center;
                font-size: var(--fs-xs); transition: all 0.12s;
            }
            .wb-bm-mgr-btn:hover { background: var(--od-bg-subtle); color: var(--od-text); }
            .wb-bm-mgr-btn.wb-bm-delete:hover { background: #fee2e2; color: #ef4444; }

            /* Inline edit input for bookmark rename */
            .wb-bm-edit-input {
                border: 1px solid var(--chat-accent); border-radius: 4px;
                padding: 2px 6px; font-size: var(--fs-base); outline: none;
                width: 100%;
            }

            /* ---- Download items ---- */
            .wb-dl-item {
                display: flex; align-items: center; gap: 8px;
                padding: 10px 16px;
                transition: background 0.1s;
                border-bottom: 1px solid #f5f5f5;
            }
            .wb-dl-item:last-child { border-bottom: none; }
            .wb-dl-item:hover { background: var(--od-bg-subtle); }
            .wb-dl-icon {
                color: var(--chat-accent); font-size: var(--fs-xl); flex-shrink: 0;
                width: 24px; text-align: center;
            }
            .wb-dl-icon.wb-dl-done { color: #10b981; }
            .wb-dl-icon.wb-dl-cancelled { color: var(--od-text-muted); }
            .wb-dl-content { flex: 1; min-width: 0; }
            .wb-dl-filename {
                font-size: var(--fs-base); color: var(--od-text);
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            }
            .wb-dl-meta {
                font-size: var(--fs-sm); color: var(--od-text-muted);
                margin-top: 2px;
            }
            .wb-dl-progress-wrap {
                height: 4px; background: var(--od-border); border-radius: 2px;
                margin-top: 4px; overflow: hidden;
            }
            .wb-dl-progress-bar {
                height: 100%; background: var(--chat-accent); border-radius: 2px;
                transition: width 0.3s;
                min-width: 0;
            }
            .wb-dl-progress-bar.wb-dl-done { background: #10b981; }
            .wb-dl-progress-bar.wb-dl-cancelled { background: var(--od-text-muted); }
            .wb-dl-actions {
                display: flex; gap: 2px; flex-shrink: 0;
            }
            .wb-dl-btn {
                width: 26px; height: 26px; border: none; background: transparent;
                border-radius: 4px; cursor: pointer; color: var(--od-text-muted);
                display: flex; align-items: center; justify-content: center;
                font-size: var(--fs-sm); transition: all 0.12s;
            }
            .wb-dl-btn:hover { background: var(--od-bg-subtle); color: var(--od-text); }
            .wb-dl-btn.wb-dl-cancel:hover { background: #fee2e2; color: #ef4444; }

            /* ---- Clear history button ---- */
            .wb-panel-footer {
                padding: 8px 16px;
                border-top: 1px solid var(--od-border);
                flex-shrink: 0;
            }
            .wb-clear-btn {
                width: 100%; padding: 6px 0;
                border: 1px solid var(--od-border); border-radius: 6px;
                background: var(--od-bg-elevated); cursor: pointer;
                font-size: var(--fs-base); color: #ef4444;
                transition: background 0.12s;
            }
            .wb-clear-btn:hover { background: #fef2f2; }

            /* ---- Internal pages (opendesk://) ---- */
            .wb-internal-page {
                width: 100%; height: 100%;
                display: flex; flex-direction: column;
                background: var(--od-bg);
                overflow: hidden;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            }
            .wb-internal-header {
                padding: 20px 24px 16px;
                flex-shrink: 0;
                display: flex; align-items: center; gap: 12px;
                border-bottom: 1px solid var(--od-border);
                background: var(--od-bg-elevated);
            }
            .wb-internal-header-icon { font-size: 20px; color: var(--od-text-muted); }
            .wb-internal-title {
                font-size: 20px; font-weight: 600; color: var(--od-text);
                flex: 1;
            }

            /* Favorites management page */
            .wb-fav-layout {
                flex: 1; display: flex; overflow: hidden;
            }
            .wb-fav-tree {
                width: 260px; flex-shrink: 0;
                border-right: 1px solid var(--od-border);
                display: flex; flex-direction: column;
                background: var(--od-bg-elevated);
            }
            .wb-fav-tree-search {
                margin: 8px 12px; padding: 6px 10px;
                border: 1px solid var(--od-border); border-radius: 6px;
                font-size: var(--fs-base); outline: none;
                transition: border-color 0.15s;
            }
            .wb-fav-tree-search:focus { border-color: var(--chat-accent); }
            .wb-fav-tree-body {
                flex: 1; overflow-y: auto; padding: 4px 0;
            }
            .wb-fav-tree-item {
                display: flex; align-items: center; gap: 6px;
                padding: 7px 12px 7px 16px;
                cursor: pointer;
                font-size: var(--fs-base); color: var(--od-text);
                transition: background 0.1s;
            }
            .wb-fav-tree-item:hover { background: var(--od-bg-subtle); }
            .wb-fav-tree-item.wb-selected { background: #eff6ff; color: #1d4ed8; font-weight: 500; }
            .wb-fav-tree-item i { width: 16px; text-align: center; font-size: var(--fs-md); color: var(--od-text-muted); flex-shrink: 0; }
            .wb-fav-tree-item.wb-selected i { color: var(--chat-accent); }
            .wb-fav-tree-item-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .wb-fav-tree-item-count { font-size: var(--fs-sm); color: var(--od-text-muted); flex-shrink: 0; }
            .wb-fav-tree-item.wb-indent { padding-left: 32px; }

            .wb-fav-detail {
                flex: 1; display: flex; flex-direction: column;
                overflow: hidden; background: #fafafa;
            }
            .wb-fav-detail-header {
                display: flex; align-items: center; gap: 8px;
                padding: 12px 16px;
                border-bottom: 1px solid var(--od-border);
                flex-shrink: 0;
                background: var(--od-bg-elevated);
            }
            .wb-fav-detail-title { font-size: var(--fs-lg); font-weight: 500; color: var(--od-text); flex: 1; }
            .wb-fav-detail-body {
                flex: 1; overflow-y: auto; padding: 8px 0;
            }
            .wb-fav-detail-item {
                display: flex; align-items: center; gap: 10px;
                padding: 10px 16px; margin: 0 8px;
                cursor: pointer; border-radius: 6px;
                transition: background 0.1s;
            }
            .wb-fav-detail-item:hover { background: var(--od-bg-elevated); box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
            .wb-fav-detail-icon { color: #f59e0b; font-size: var(--fs-md); flex-shrink: 0; }
            .wb-fav-detail-icon.wb-folder-icon { color: var(--od-text-muted); }
            .wb-fav-detail-content { flex: 1; min-width: 0; }
            .wb-fav-detail-name { font-size: var(--fs-base); color: var(--od-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .wb-fav-detail-url { font-size: var(--fs-sm); color: var(--od-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .wb-fav-detail-actions {
                display: flex; gap: 2px; opacity: 0; transition: opacity 0.12s;
            }
            .wb-fav-detail-item:hover .wb-fav-detail-actions { opacity: 1; }
            .wb-fav-detail-btn {
                width: 26px; height: 26px; border: none; background: transparent;
                border-radius: 4px; cursor: pointer; color: var(--od-text-muted);
                display: flex; align-items: center; justify-content: center;
                font-size: var(--fs-sm); transition: all 0.12s;
            }
            .wb-fav-detail-btn:hover { background: var(--od-bg-subtle); color: var(--od-text); }
            .wb-fav-detail-btn.wb-del:hover { background: #fee2e2; color: #ef4444; }
            .wb-fav-detail-empty {
                text-align: center; color: var(--od-text-muted); padding: 48px 16px; font-size: var(--fs-base);
            }

            /* History management page */
            .wb-hist-layout {
                flex: 1; display: flex; flex-direction: column;
                overflow: hidden;
            }
            .wb-hist-toolbar {
                display: flex; align-items: center; gap: 8px;
                padding: 12px 24px;
                flex-shrink: 0;
            }
            .wb-hist-search {
                flex: 1; padding: 8px 12px;
                border: 1px solid var(--od-border); border-radius: 8px;
                font-size: var(--fs-base); outline: none;
                background: var(--od-bg-elevated);
                transition: border-color 0.15s, box-shadow 0.15s;
            }
            .wb-hist-search:focus { border-color: var(--chat-accent); box-shadow: 0 0 0 2px rgba(59,130,246,0.08); }
            .wb-hist-clear-btn {
                padding: 8px 16px; border: 1px solid var(--od-border); border-radius: 8px;
                background: var(--od-bg-elevated); cursor: pointer; font-size: var(--fs-base); color: #ef4444;
                transition: background 0.12s; flex-shrink: 0;
            }
            .wb-hist-clear-btn:hover { background: #fef2f2; }
            .wb-hist-body {
                flex: 1; overflow-y: auto; padding: 0 16px 16px;
            }
            .wb-hist-date-group { margin-bottom: 16px; }
            .wb-hist-date-label {
                font-size: var(--fs-base); font-weight: 600; color: var(--od-text);
                padding: 8px 8px 4px; position: sticky; top: 0;
                background: var(--od-bg); z-index: 1;
            }
            .wb-hist-item {
                display: flex; align-items: center; gap: 10px;
                padding: 10px 8px; margin: 0 0 1px;
                cursor: pointer; border-radius: 6px;
                transition: background 0.1s;
            }
            .wb-hist-item:hover { background: var(--od-bg-elevated); box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
            .wb-hist-item-icon { color: var(--od-text-muted); font-size: var(--fs-sm); flex-shrink: 0; }
            .wb-hist-item-content { flex: 1; min-width: 0; }
            .wb-hist-item-title { font-size: var(--fs-base); color: var(--od-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .wb-hist-item-url { font-size: var(--fs-sm); color: var(--od-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .wb-hist-item-time { font-size: var(--fs-sm); color: var(--od-text-muted); flex-shrink: 0; }
            .wb-hist-item-del {
                width: 24px; height: 24px; border: none; background: transparent;
                border-radius: 4px; cursor: pointer; color: #d1d5db;
                display: flex; align-items: center; justify-content: center;
                opacity: 0; transition: all 0.12s; font-size: var(--fs-xs);
            }
            .wb-hist-item:hover .wb-hist-item-del { opacity: 1; }
            .wb-hist-item-del:hover { background: #fee2e2; color: #ef4444; }
            .wb-hist-empty {
                text-align: center; color: var(--od-text-muted); padding: 48px 16px; font-size: var(--fs-base);
            }

            /* Panel manage button */
            .wb-panel-manage-btn {
                padding: 4px 10px; border: 1px solid var(--od-border); border-radius: 5px;
                background: var(--od-bg-elevated); cursor: pointer; font-size: var(--fs-md); color: var(--od-text-muted);
                transition: all 0.12s; flex-shrink: 0;
            }
            .wb-panel-manage-btn:hover { background: var(--od-bg-subtle); color: var(--od-text); }

            /* ---- Browser Settings page buttons ---- */
            .wb-bs-btn {
                padding: 6px 14px; border-radius: 6px;
                border: 1px solid var(--od-border); background: var(--od-bg-elevated);
                cursor: pointer; font-size: var(--fs-base); color: var(--od-text);
                display: inline-flex; align-items: center; gap: 6px;
                transition: all 0.12s;
            }
            .wb-bs-btn:hover { background: var(--od-bg-subtle); }
            .wb-bs-btn-primary { background: var(--chat-accent); color: #fff; border-color: var(--chat-accent); }
            .wb-bs-btn-primary:hover { background: var(--chat-accent); border-color: var(--chat-accent); }
            .wb-bs-btn-danger { color: #ef4444; }
            .wb-bs-btn-danger:hover { background: #fef2f2; border-color: #fecaca; }

.od-browser-tools { position:absolute; inset:0; pointer-events:none; z-index:60; color:var(--od-text); font-family:var(--font-sans); }
.od-browser-tools > * { pointer-events:auto; }
.od-browser-tools .wb-internal-page { min-height:0; }
.od-browser-tools input { background:var(--od-bg-elevated); color:var(--od-text); }
.od-browser-tools .wb-page-panel { width:100%; }
.od-browser-tools .wb-page-body { flex:1; min-height:0; overflow:auto; }
.od-browser-tools .wb-find { position:absolute; top:0; right:0; display:flex; gap:6px; padding:8px; background:var(--od-bg-elevated); border:1px solid var(--od-border); }
.od-browser-tools .wb-find[hidden] { display:none; }
`;
