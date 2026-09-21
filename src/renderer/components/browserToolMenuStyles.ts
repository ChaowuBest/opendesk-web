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

export const BROWSER_TOOL_MENU_CSS = `
.od-browser-menu, .od-browser-menu * { box-sizing:border-box; }
.od-browser-menu {
    position:absolute; top:100%; right:0; width:260px; max-width:calc(100vw - 16px);
    padding:6px 0; z-index:200; font-family:var(--font-sans,system-ui,sans-serif);
    font-size:var(--fs-base,13px); color:var(--od-text); background:var(--od-bg-elevated);
    border:1px solid var(--od-border-strong); border-radius:10px; box-shadow:0 8px 24px #0003;
}
.od-browser-menu[hidden], .od-browser-menu [hidden] { display:none !important; }
.od-browser-menu .bm-item {
    display:flex; align-items:center; gap:10px; width:100%; padding:8px 16px;
    border:0; border-radius:0; background:transparent; color:var(--od-text);
    font:inherit; text-align:left; cursor:pointer;
}
.od-browser-menu .bm-item:hover, .od-browser-menu .bm-item[aria-expanded=true] { background:var(--od-bg-subtle); }
.od-browser-menu button:focus-visible { outline:2px solid var(--chat-accent,var(--od-accent)); outline-offset:-2px; }
.od-browser-menu i { width:16px; flex-shrink:0; text-align:center; color:var(--od-text-muted); font-size:inherit; }
.od-browser-menu .bm-label { flex:1; }
.od-browser-menu .bm-shortcut { color:var(--od-text-muted); font-size:var(--fs-sm,11px); white-space:nowrap; }
.od-browser-menu .bm-divider { height:1px; background:var(--od-border); margin:4px 0; }
.od-browser-menu .bm-danger { color:var(--chat-accent,var(--od-titlebar-btn-close-hover)); }
.od-browser-menu .bm-flyout {
    position:fixed; width:190px; max-width:calc(100vw - 16px); max-height:calc(100vh - 16px); overflow:auto;
    background:var(--od-bg-elevated); color:var(--od-text); border:1px solid var(--od-border-strong);
    border-radius:8px; box-shadow:0 8px 24px #0003; padding:4px 0; z-index:230;
}
.od-browser-menu .bm-flyout .bm-item { padding:7px 12px; font-size:var(--fs-md,12px); }
.od-browser-menu .bm-zoom { display:flex; align-items:center; gap:6px; padding:6px 16px; }
.od-browser-menu .bm-zoom-controls { display:flex; align-items:center; gap:4px; }
.od-browser-menu .bm-zoom button {
    width:24px; height:24px; padding:0; border-radius:4px; border:1px solid var(--od-border-strong);
    background:var(--od-bg-elevated); color:var(--od-text); cursor:pointer; font:inherit;
    display:flex; align-items:center; justify-content:center;
}
.od-browser-menu .bm-zoom button:hover { background:var(--od-bg-subtle); }
.od-browser-menu .bm-zoom button:disabled { color:var(--od-text-disabled); cursor:default; }
.od-browser-menu .bm-zoom button:disabled i { color:inherit; }
.od-browser-menu [data-zoom-value] { min-width:36px; text-align:center; font-size:var(--fs-md,12px); }
`;
