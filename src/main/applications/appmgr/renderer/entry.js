/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { syncShadowHostTheme } from '../../../../renderer/theme/theme-shadow-overrides.ts';

function getAppMgrAPI() {
    return {
        listAllApps: () => window.applicationAPI.callMainWorld('listAllApps'),
        installFromZip: (zipPath) => window.applicationAPI.callMainWorld('installFromZip', zipPath),
        createApp: (input) => window.applicationAPI.callMainWorld('createApp', input),
        setActive: (bundleName, active) => window.applicationAPI.callMainWorld('setActive', bundleName, active),
        setCurrentVersion: (bundleName, versionId) =>
            window.applicationAPI.callMainWorld('setCurrentVersion', bundleName, versionId),
        updateMetadata: (input) => window.applicationAPI.callMainWorld('updateMetadata', input),
        deleteApp: (bundleName) => window.applicationAPI.callMainWorld('deleteApp', bundleName),
        getPreviewUrl: (bundleName, versionId) =>
            window.applicationAPI.callMainWorld('getPreviewUrl', bundleName, versionId),
        requestModifyApp: (bundleName, requirements) =>
            window.applicationAPI.callMainWorld('requestModifyApp', bundleName, requirements)
    };
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const BUNDLE_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[.-]?[a-z0-9]+)*$/;
const BUNDLE_NAME_HELP = '包名只能包含小写字母、数字、点号和连字符，必须以小写字母开头，例如 abc.def 或 my-app。';

const SVG_PATHS = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    filePlus:
        '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 11v6M9 14h6"/>',
    zip: '<path d="M10 2h4l5 5v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h3z"/><path d="M14 2v5h5"/><path d="M10 6h2M12 8h2M10 10h2M12 12h2M10 14h2"/><path d="M12 17v2"/>',
    store: '<path d="M4 10h16l-1-6H5z"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/><path d="M4 10c0 1.2 1 2 2 2s2-.8 2-2c0 1.2 1 2 2 2s2-.8 2-2c0 1.2 1 2 2 2s2-.8 2-2c0 1.2 1 2 2 2s2-.8 2-2"/>',
    archive:
        '<path d="M21 8v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8"/><path d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3H3z"/><path d="M10 12h4"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 16 9 5 9-5"/>',
    boxOpen: '<path d="m3 8 9-5 9 5-9 5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/><path d="m7.5 5.5 9 5"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
    arrowLeft: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
    upload: '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M20 16v4H4v-4"/>',
    reload: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
    send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>'
};

function icon(name, className = '') {
    return `<svg class="svg-icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SVG_PATHS[name] || ''}</svg>`;
}

function validateBundleNameInput(bundleName) {
    if (!bundleName) {
        return '包名不能为空。';
    }
    if (!BUNDLE_NAME_PATTERN.test(bundleName) || bundleName.length < 2 || bundleName.length > 128) {
        return BUNDLE_NAME_HELP;
    }
    return '';
}

function formatUserError(error) {
    const message = error?.message || String(error);
    if (message.includes('invalid_format') && message.includes('regex')) {
        return BUNDLE_NAME_HELP;
    }
    return message;
}

const STYLE = `
:host {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    background: #fff;
    color: #1d1d1f;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    font-size: 13px;
}
:host([data-theme="dark"]) {
    background: #1e1e1e !important;
    color: #cccccc !important;
}
* { box-sizing: border-box; }
.header-area {
    flex-shrink: 0;
    padding: 20px 24px 16px;
    background: rgba(255, 255, 255, 0.88);
    backdrop-filter: blur(24px) saturate(180%);
    -webkit-backdrop-filter: blur(24px) saturate(180%);
    -webkit-app-region: drag;
    border-bottom: 0.5px solid rgba(0, 0, 0, 0.06);
    position: relative; z-index: 100;
}
.header-title {
    font-size: 22px; font-weight: 700; color: #1d1d1f;
    letter-spacing: -0.03em; margin-bottom: 14px;
    -webkit-app-region: no-drag;
}
.seg-row {
    display: flex; align-items: center; gap: 4px;
    -webkit-app-region: no-drag;
}
.seg-control-container {
    flex: 1; min-width: 0; overflow: hidden;
    display: flex;
}
.seg-control {
    display: inline-flex; flex: 1; min-width: 0;
    background: rgba(0, 0, 0, 0.04);
    border-radius: 10px; padding: 3px; gap: 2px;
    overflow-x: auto;
    scrollbar-width: none;
    -ms-overflow-style: none;
}
.seg-control::-webkit-scrollbar { display: none; }
.seg-scroll-btn {
    display: none;
    align-items: center; justify-content: center;
    width: 24px; height: 34px;
    background: rgba(255,255,255,0.8);
    border: 1px solid rgba(0,0,0,0.06);
    border-radius: 8px;
    cursor: pointer; color: #999;
    flex-shrink: 0; z-index: 10;
    transition: all 0.15s;
}
.seg-scroll-btn:hover { color: #555; background: #f5f5f5; }
.seg-scroll-btn svg { width: 14px; height: 14px; }
.seg-item {
    padding: 7px 13px; border-radius: 8px; border: none;
    background: transparent; color: rgba(0, 0, 0, 0.4);
    font-size: 12px; font-weight: 500; cursor: pointer;
    transition: all 0.22s cubic-bezier(0.4, 0, 0.2, 1);
    font-family: inherit; white-space: nowrap; flex-shrink: 0;
    display: inline-flex; align-items: center; gap: 5px; line-height: 1;
}
.seg-item:hover { color: rgba(0, 0, 0, 0.6); }
.seg-item.active {
    background: #fff; color: #1d1d1f;
    box-shadow: 0 1px 3px rgba(0,0,0,0.06), 0 0.5px 1px rgba(0,0,0,0.03);
}
.svg-icon { width: 14px; height: 14px; flex-shrink: 0; }
.svg-icon.large { width: 22px; height: 22px; }
.header-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.action-btn {
    width: 34px; height: 34px; border-radius: 9px; border: 1px solid rgba(0,0,0,0.08);
    background: #fff; color: #444; font-size: 16px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: all 0.15s; font-family: inherit;
}
.action-btn:hover { background: #f8f8f8; border-color: rgba(0,0,0,0.12); }
.action-btn:active { transform: scale(0.95); }
.add-dropdown-anchor { position: relative; }
.add-menu {
    display: none;
    flex-direction: column;
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    min-width: 210px;
    padding: 5px;
    border: 1px solid rgba(0,0,0,0.06);
    border-radius: 10px;
    background: #fff;
    box-shadow: 0 8px 28px -6px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.04);
    z-index: 100;
    animation: dropdown-in .14s ease-out;
}
.add-menu.visible { display: flex; }
.menu-item {
    width: 100%;
    border: 0;
    background: transparent;
    border-radius: 9px;
    padding: 10px 11px;
    display: flex;
    align-items: center;
    gap: 10px;
    font: inherit;
    font-size: 13px;
    color: #1d1d1f;
    cursor: pointer;
    text-align: left;
    transition: background .1s;
}
.menu-item:hover { background: #f5f5f5; }
.menu-item + .menu-item { border-top: 1px solid rgba(0,0,0,0.03); }
.menu-icon { width: 28px; height: 28px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; background: #f4f8ff; color: #4f7edb; flex-shrink: 0; }
.menu-copy { display: flex; flex-direction: column; min-width: 0; }
.menu-title { font-weight: 650; line-height: 1.2; }
.menu-desc { margin-top: 2px; color: #8a8a8f; font-size: 11px; line-height: 1.3; }
@keyframes dropdown-in { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: translateY(0); } }
.content { flex: 1; min-height: 0; overflow: hidden; }
.tab-panel { height: 100%; overflow: auto; padding: 20px 24px 60px; }
.cards-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)); gap: 12px; }
.app-card {
    border: 1px solid rgba(0,0,0,0.06);
    border-radius: 14px;
    background: #fff;
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.03);
}
.card-header { display: flex; gap: 12px; min-width: 0; }
.card-icon {
    width: 42px;
    height: 42px;
    border-radius: 12px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    background: #ebf3fe;
    color: #5b8def;
    font-weight: 800;
}
.card-icon img { width: 100%; height: 100%; object-fit: cover; }
.card-info { flex: 1; min-width: 0; }
.card-title { font-size: 14px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 2px; }
.card-sub { font-size: 11px; color: #999; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card-desc { min-height: 36px; color: #777; font-size: 12px; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.card-footer { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: auto; }
.pill { padding: 4px 9px; border-radius: 999px; background: #f3f4f6; color: #6b7280; font-size: 11px; }
.card-actions { display: flex; align-items: center; gap: 6px; }
.mini-btn {
    height: 28px;
    min-width: 28px;
    padding: 0 9px;
    border-radius: 8px;
    border: 1px solid rgba(0,0,0,0.08);
    background: #fff;
    cursor: pointer;
    color: #555;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    font: inherit;
}
.mini-btn:hover { background: #f8f8f8; }
.mini-btn.danger { color: #d9534f; }
.toggle { position: relative; width: 40px; height: 24px; display: inline-block; }
.toggle input { opacity: 0; width: 0; height: 0; }
.toggle-slider { position: absolute; inset: 0; border-radius: 999px; background: #d1d1d6; cursor: pointer; transition: background .2s; }
.toggle-slider::after { content: ''; position: absolute; width: 20px; height: 20px; left: 2px; top: 2px; background: #fff; border-radius: 50%; box-shadow: 0 1px 3px rgba(0,0,0,.18); transition: transform .2s; }
.toggle input:checked + .toggle-slider { background: #34c759; }
.toggle input:checked + .toggle-slider::after { transform: translateX(16px); }
.empty-state { height: 100%; min-height: 360px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: #999; text-align: center; }
.empty-icon { width: 54px; height: 54px; border-radius: 16px; display: flex; align-items: center; justify-content: center; background: #ebf3fe; color: #5b8def; font-size: 22px; }
.empty-title { color: #1d1d1f; font-weight: 700; font-size: 16px; }
.empty-hint { max-width: 420px; line-height: 1.6; }
.editor { height: 100%; min-height: 0; }
.editor-left { height: 100%; overflow: auto; padding: 20px 20px 60px 24px; background: #fbfbfc; border-right: 1px solid rgba(0,0,0,0.04); }
.editor-right { height: 100%; min-width: 0; display: flex; flex-direction: column; background: #f8fafc; }
.editor-toolbar { height: 54px; flex-shrink: 0; display: flex; align-items: center; gap: 8px; padding: 0 16px; border-bottom: 1px solid #e5e7eb; background: #fff; }
.preview-container { flex: 1; min-height: 0; overflow: hidden; background: #fff; border-bottom: 1px solid #e5e7eb; }
.preview-viewport { min-width: 100%; min-height: 100%; }
.preview-frame { border: 0; width: 100%; height: 100%; display: block; }
.zoom-toolbar { height: 40px; flex-shrink: 0; display: flex; align-items: center; gap: 10px; padding: 0 16px; background: #fff; border-bottom: 1px solid #e5e7eb; }
.zoom-label { font-size: 12px; font-weight: 600; color: #666; min-width: 36px; text-align: right; }
.zoom-slider { flex: 1; max-width: 200px; height: 4px; -webkit-appearance: none; appearance: none; background: #d1d5db; border-radius: 2px; outline: none; cursor: pointer; }
.zoom-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 16px; height: 16px; border-radius: 50%; background: #5b8def; cursor: pointer; border: 2px solid #fff; box-shadow: 0 1px 3px rgba(0,0,0,.2); }
.modify-panel { flex-shrink: 0; padding: 12px 16px; background: #fff; border-top: 1px solid #e5e7eb; }
.modify-input-row { display: flex; gap: 8px; align-items: flex-end; }
.modify-input { flex: 1; border: 1px solid rgba(0,0,0,0.1); border-radius: 10px; padding: 9px 11px; background: #fff; font: inherit; font-size: 13px; outline: none; resize: none; min-height: 42px; }
.modify-input:focus { border-color: #8bb8f0; box-shadow: 0 0 0 3px rgba(90,140,240,.1); }
.modify-btn { height: 42px; width: 42px; border-radius: 10px; border: 1px solid rgba(0,0,0,0.08); background: #5b8def; color: #fff; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; transition: all .15s; }
.modify-btn:hover { background: #4a7de0; }
.modify-btn:disabled { background: #a0c4ff; cursor: not-allowed; }
.modify-status-line { min-height: 16px; color: #6b7280; font-size: 12px; line-height: 1.45; margin-top: 6px; word-break: break-word; }
.form-section { margin-bottom: 22px; }
.section-title { font-size: 12px; font-weight: 700; color: #666; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 10px; }
.field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.field label { font-size: 12px; color: #666; font-weight: 600; }
.field input, .field textarea, .field select {
    width: 100%;
    border: 1px solid rgba(0,0,0,0.1);
    border-radius: 10px;
    padding: 9px 11px;
    background: #fff;
    font: inherit;
    outline: none;
}
.field textarea { resize: vertical; min-height: 76px; }
.field input:focus, .field textarea:focus, .field select:focus { border-color: #8bb8f0; box-shadow: 0 0 0 3px rgba(90,140,240,.1); }
.icon-edit-row { display: flex; align-items: center; gap: 12px; }
.version-list { display: flex; flex-direction: column; gap: 6px; }
.version-item { border: 1px solid #edf0f3; border-radius: 10px; padding: 9px 11px; background: #fff; }
.version-item.current { border-color: #bcd7ff; background: #f4f8ff; }
.version-name { font-weight: 700; font-size: 12px; }
.version-meta { color: #999; font-size: 11px; margin-top: 3px; }
.modal-overlay { display: none; position: fixed; inset: 0; z-index: 200; background: rgba(0,0,0,.18); align-items: center; justify-content: center; backdrop-filter: blur(6px); }
.modal-overlay.visible { display: flex; }
.modal { width: 460px; max-width: calc(100vw - 32px); background: #fff; border-radius: 16px; padding: 22px; box-shadow: 0 24px 80px rgba(0,0,0,.2); }
.modal h3 { margin: 0 0 14px; font-size: 16px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.btn { border: 1px solid rgba(0,0,0,.08); border-radius: 9px; background: #fff; padding: 8px 14px; font: inherit; cursor: pointer; }
.btn.primary { border-color: #5b8def; background: #5b8def; color: #fff; }
.btn.danger { color: #d9534f; }
.status-line { min-height: 18px; color: #d9534f; font-size: 12px; line-height: 1.45; margin-top: 8px; word-break: break-word; }

:host-context(html[data-theme='dark']),
:host([data-theme='dark']) {
    background: var(--od-bg, #1e1e1e);
    color: var(--od-text, #e4e4e4);
    color-scheme: dark;
}
:host-context(html[data-theme='dark']) .header-area,
:host([data-theme='dark']) .header-area {
    background: rgba(37, 37, 38, 0.95);
    border-bottom-color: var(--od-border-strong, rgba(255,255,255,0.2));
}
:host-context(html[data-theme='dark']) .header-title,
:host-context(html[data-theme='dark']) .card-title,
:host-context(html[data-theme='dark']) .empty-title,
:host-context(html[data-theme='dark']) .modal h3,
:host-context(html[data-theme='dark']) .menu-title,
:host-context(html[data-theme='dark']) .version-name,
:host-context(html[data-theme='dark']) .editor-toolbar strong,
:host-context(html[data-theme='dark']) .field label,
:host([data-theme='dark']) .header-title,
:host([data-theme='dark']) .card-title,
:host([data-theme='dark']) .empty-title,
:host([data-theme='dark']) .modal h3,
:host([data-theme='dark']) .menu-title,
:host([data-theme='dark']) .version-name,
:host([data-theme='dark']) .editor-toolbar strong,
:host([data-theme='dark']) .field label {
    color: var(--od-text, #e4e4e4);
}
:host-context(html[data-theme='dark']) .seg-control,
:host([data-theme='dark']) .seg-control {
    background: var(--od-bg-subtle, #333333);
}
:host-context(html[data-theme='dark']) .seg-item,
:host([data-theme='dark']) .seg-item {
    color: var(--od-text-muted, #ababab);
}
:host-context(html[data-theme='dark']) .seg-item.active,
:host([data-theme='dark']) .seg-item.active {
    background: var(--od-bg-elevated, #252526);
    color: var(--od-text, #e4e4e4);
    box-shadow: 0 1px 4px rgba(0,0,0,0.35);
}
:host-context(html[data-theme='dark']) .appmgr-tool-btn,
:host-context(html[data-theme='dark']) .mini-btn,
:host-context(html[data-theme='dark']) .btn,
:host([data-theme='dark']) .appmgr-tool-btn,
:host([data-theme='dark']) .mini-btn,
:host([data-theme='dark']) .btn {
    background: var(--od-bg-subtle, #333333);
    border-color: var(--od-border-strong, rgba(255,255,255,0.2));
    color: var(--od-text, #e4e4e4);
}
:host-context(html[data-theme='dark']) .appmgr-tool-btn:hover,
:host-context(html[data-theme='dark']) .mini-btn:hover,
:host-context(html[data-theme='dark']) .btn:hover,
:host([data-theme='dark']) .appmgr-tool-btn:hover,
:host([data-theme='dark']) .mini-btn:hover,
:host([data-theme='dark']) .btn:hover {
    background: var(--od-bg-muted, #2d2d30);
    border-color: var(--od-border, rgba(255,255,255,0.12));
}
:host-context(html[data-theme='dark']) .add-menu,
:host-context(html[data-theme='dark']) .modal,
:host([data-theme='dark']) .add-menu,
:host([data-theme='dark']) .modal {
    background: var(--od-bg-elevated, #252526);
    border-color: var(--od-border-strong, rgba(255,255,255,0.2));
    color: var(--od-text, #e4e4e4);
    box-shadow: 0 16px 60px rgba(0,0,0,0.45);
}
:host-context(html[data-theme='dark']) .modal-overlay,
:host([data-theme='dark']) .modal-overlay {
    background: rgba(0,0,0,0.48);
}
:host-context(html[data-theme='dark']) .menu-item,
:host([data-theme='dark']) .menu-item {
    color: var(--od-text, #e4e4e4);
}
:host-context(html[data-theme='dark']) .menu-item:hover,
:host([data-theme='dark']) .menu-item:hover {
    background: var(--od-bg-subtle, #333333);
}
:host-context(html[data-theme='dark']) .menu-item + .menu-item,
:host([data-theme='dark']) .menu-item + .menu-item {
    border-top-color: var(--od-border, rgba(255,255,255,0.12));
}
:host-context(html[data-theme='dark']) .menu-icon,
:host-context(html[data-theme='dark']) .empty-icon,
:host-context(html[data-theme='dark']) .card-icon,
:host([data-theme='dark']) .menu-icon,
:host([data-theme='dark']) .empty-icon,
:host([data-theme='dark']) .card-icon {
    background: rgba(96,165,250,0.16);
    color: var(--od-accent, #60a5fa);
}
:host-context(html[data-theme='dark']) .menu-desc,
:host-context(html[data-theme='dark']) .card-sub,
:host-context(html[data-theme='dark']) .card-desc,
:host-context(html[data-theme='dark']) .empty-hint,
:host-context(html[data-theme='dark']) .version-meta,
:host-context(html[data-theme='dark']) .section-title,
:host([data-theme='dark']) .menu-desc,
:host([data-theme='dark']) .card-sub,
:host([data-theme='dark']) .card-desc,
:host([data-theme='dark']) .empty-hint,
:host([data-theme='dark']) .version-meta,
:host([data-theme='dark']) .section-title {
    color: var(--od-text-muted, #ababab);
}
:host-context(html[data-theme='dark']) .tab-panel,
:host([data-theme='dark']) .tab-panel {
    background: var(--od-bg, #1e1e1e);
}
:host-context(html[data-theme='dark']) .app-card,
:host([data-theme='dark']) .app-card {
    background: var(--od-bg-elevated, #252526);
    border-color: var(--od-border, rgba(255,255,255,0.12));
    box-shadow: none;
}
:host-context(html[data-theme='dark']) .app-card:hover,
:host([data-theme='dark']) .app-card:hover {
    border-color: var(--od-border-strong, rgba(255,255,255,0.2));
}
:host-context(html[data-theme='dark']) .pill,
:host([data-theme='dark']) .pill {
    background: var(--od-bg-subtle, #333333);
    color: var(--od-text-muted, #ababab);
}
:host-context(html[data-theme='dark']) .editor-left,
:host([data-theme='dark']) .editor-left {
    background: var(--od-bg, #1e1e1e);
    border-right-color: var(--od-border-strong, rgba(255,255,255,0.2));
}
:host-context(html[data-theme='dark']) .editor-right,
:host([data-theme='dark']) .editor-right {
    background: var(--od-bg-muted, #2d2d30);
}
:host-context(html[data-theme='dark']) .editor-toolbar,
:host([data-theme='dark']) .editor-toolbar {
    background: var(--od-bg-elevated, #252526);
    border-bottom-color: var(--od-border-strong, rgba(255,255,255,0.2));
}
:host-context(html[data-theme='dark']) .preview-frame,
:host([data-theme='dark']) .preview-frame {
    background: var(--od-bg-elevated, #252526);
}
:host-context(html[data-theme='dark']) .preview-container,
:host([data-theme='dark']) .preview-container {
    background: var(--od-bg-elevated, #252526);
    border-bottom-color: var(--od-border-strong, rgba(255,255,255,0.2));
}
:host-context(html[data-theme='dark']) .zoom-toolbar,
:host([data-theme='dark']) .zoom-toolbar {
    background: var(--od-bg-elevated, #252526);
    border-bottom-color: var(--od-border-strong, rgba(255,255,255,0.2));
}
:host-context(html[data-theme='dark']) .zoom-label,
:host([data-theme='dark']) .zoom-label {
    color: var(--od-text-muted, #ababab);
}
:host-context(html[data-theme='dark']) .zoom-slider,
:host([data-theme='dark']) .zoom-slider {
    background: #55555a;
}
:host-context(html[data-theme='dark']) .modify-panel,
:host([data-theme='dark']) .modify-panel {
    background: var(--od-bg-elevated, #252526);
    border-top-color: var(--od-border-strong, rgba(255,255,255,0.2));
}
:host-context(html[data-theme='dark']) .modify-input,
:host([data-theme='dark']) .modify-input {
    background: var(--od-bg-subtle, #333333);
    border-color: var(--od-border-strong, rgba(255,255,255,0.2));
    color: var(--od-text, #e4e4e4);
}
:host-context(html[data-theme='dark']) .modify-input::placeholder,
:host([data-theme='dark']) .modify-input::placeholder {
    color: var(--od-placeholder, #9a9a9a);
}
:host-context(html[data-theme='dark']) .modify-input:focus,
:host([data-theme='dark']) .modify-input:focus {
    border-color: var(--od-accent, #60a5fa);
    box-shadow: 0 0 0 3px rgba(96,165,250,0.16);
}
:host-context(html[data-theme='dark']) .modify-btn,
:host([data-theme='dark']) .modify-btn {
    background: var(--od-accent, #60a5fa);
    border-color: var(--od-accent, #60a5fa);
}
:host-context(html[data-theme='dark']) .modify-btn:disabled,
:host([data-theme='dark']) .modify-btn:disabled {
    background: #3b5998;
}
:host-context(html[data-theme='dark']) .modify-status-line,
:host([data-theme='dark']) .modify-status-line {
    color: var(--od-text-muted, #ababab);
}
:host-context(html[data-theme='dark']) .field input,
:host-context(html[data-theme='dark']) .field textarea,
:host-context(html[data-theme='dark']) .field select,
:host([data-theme='dark']) .field input,
:host([data-theme='dark']) .field textarea,
:host([data-theme='dark']) .field select {
    background: var(--od-bg-subtle, #333333);
    border-color: var(--od-border-strong, rgba(255,255,255,0.2));
    color: var(--od-text, #e4e4e4);
}
:host-context(html[data-theme='dark']) .field input::placeholder,
:host-context(html[data-theme='dark']) .field textarea::placeholder,
:host([data-theme='dark']) .field input::placeholder,
:host([data-theme='dark']) .field textarea::placeholder {
    color: var(--od-placeholder, #9a9a9a);
}
:host-context(html[data-theme='dark']) .field input:focus,
:host-context(html[data-theme='dark']) .field textarea:focus,
:host-context(html[data-theme='dark']) .field select:focus,
:host([data-theme='dark']) .field input:focus,
:host([data-theme='dark']) .field textarea:focus,
:host([data-theme='dark']) .field select:focus {
    border-color: var(--od-accent, #60a5fa);
    box-shadow: 0 0 0 3px rgba(96,165,250,0.16);
}
:host-context(html[data-theme='dark']) .version-item,
:host([data-theme='dark']) .version-item {
    background: var(--od-bg-elevated, #252526);
    border-color: var(--od-border, rgba(255,255,255,0.12));
}
:host-context(html[data-theme='dark']) .version-item.current,
:host([data-theme='dark']) .version-item.current {
    background: rgba(96,165,250,0.14);
    border-color: rgba(96,165,250,0.45);
}
:host-context(html[data-theme='dark']) .toggle-slider,
:host([data-theme='dark']) .toggle-slider {
    background: #55555a;
}
:host-context(html[data-theme='dark']) .toggle input:checked + .toggle-slider,
:host([data-theme='dark']) .toggle input:checked + .toggle-slider {
    background: #34c759;
}
:host-context(html[data-theme='dark']) .mini-btn.danger,
:host([data-theme='dark']) .mini-btn.danger {
    color: #f87171;
}
:host-context(html[data-theme='dark']) .btn.primary,
:host([data-theme='dark']) .btn.primary {
    background: var(--od-accent, #60a5fa);
    border-color: var(--od-accent, #60a5fa);
    color: #fff;
}
:host-context(html[data-theme='dark']) .btn.danger,
:host([data-theme='dark']) .btn.danger,
:host-context(html[data-theme='dark']) .status-line,
:host([data-theme='dark']) .status-line {
    color: #f87171;
}
:host-context(html[data-theme='dark']) *::-webkit-scrollbar-thumb,
:host([data-theme='dark']) *::-webkit-scrollbar-thumb {
    background: rgba(255,255,255,0.18);
}
`;

class AppMgrEntryWidget extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this.api = getAppMgrAPI();
        this.activeTab = 'installed';
        this.userApps = [];
        this.builtinApps = [];
        this.editingApp = null;
        this.addMenuVisible = false;
        this.createDialogVisible = false;
        this.createForm = {
            bundleName: '',
            displayName: '',
            description: ''
        };
        this.status = '';
        this.modifyRequirements = '';
        this.modifyStatus = '';
        this.previewZoom = 75;
    }

    connectedCallback() {
        // 立即注入主题样式，避免首次渲染时白屏
        syncShadowHostTheme(this);
        this.load().catch((error) => {
            this.status = formatUserError(error);
            this.render();
        });

        // 监听来自侧边栏的编辑应用请求
        this._editAppHandler = (event) => {
            const bundleName = event.detail?.bundleName;
            if (!bundleName) return;
            this.editingApp = this.userApps.find((app) => app.bundleName === bundleName) || null;
            if (this.editingApp) {
                this.activeTab = 'installed';
                this.status = '';
                this.render();
            }
        };
        document.addEventListener('appmgr:editApp', this._editAppHandler);

        // 监听应用更新事件（AI 修改完成后自动刷新预览）
        this._appUpdatedHandler = async (bundleName) => {
            if (this.editingApp && this.editingApp.bundleName === bundleName) {
                // 重新加载应用数据以获取最新版本信息
                await this.load();
                // 刷新预览 iframe
                const frame = this.shadowRoot.querySelector('.preview-frame');
                if (frame) {
                    // eslint-disable-next-line no-self-assign
                    frame.src = frame.src;
                }
                this.modifyStatus = '';
                this.render();
            }
        };
        window.applicationAPI.subscribe('appUpdated', this._appUpdatedHandler);
    }

    disconnectedCallback() {
        if (this._editAppHandler) {
            document.removeEventListener('appmgr:editApp', this._editAppHandler);
            this._editAppHandler = null;
        }
        if (this._appUpdatedHandler) {
            window.applicationAPI.unsubscribe('appUpdated', this._appUpdatedHandler);
            this._appUpdatedHandler = null;
        }
        if (this._segScrollResizeObserver) {
            this._segScrollResizeObserver.disconnect();
            this._segScrollResizeObserver = null;
        }
    }

    async load() {
        const data = await this.api.listAllApps();
        this.userApps = data.userApps || [];
        this.builtinApps = data.builtinApps || [];
        if (this.editingApp) {
            this.editingApp = this.userApps.find((app) => app.bundleName === this.editingApp.bundleName) || null;
        }
        this.render();
    }

    render() {
        // 防止 innerHTML 替换期间出现白屏闪烁
        const isDark = this.dataset.theme === 'dark';
        if (isDark) {
            this.style.backgroundColor = '#1e1e1e';
        }
        this.shadowRoot.innerHTML = `
            <style>${STYLE}</style>
            ${this.renderShell()}
            ${this.renderCreateDialog()}
        `;
        this.bindEvents();
        // innerHTML 会抹掉 Shadow 内的主题 <style>，每次重绘后须重新注入
        syncShadowHostTheme(this);
        if (isDark) {
            this.style.backgroundColor = '';
        }
    }

    renderShell() {
        if (this.editingApp) {
            return this.renderEditor();
        }
        return `
            <div class="header-area">
                <div class="header-title">应用工坊</div>
                <div class="seg-row">
                    <button type="button" class="seg-scroll-btn seg-scroll-btn-left" aria-label="向左滚动">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="15 18 9 12 15 6"></polyline>
                        </svg>
                    </button>
                    <div class="seg-control-container">
                        <div class="seg-control">
                            ${this.renderTabButton('market', '应用市场', 'store')}
                            ${this.renderTabButton('installed', '已安装应用', 'archive')}
                            ${this.renderTabButton('builtin', '内置应用', 'layers')}
                        </div>
                    </div>
                    <button type="button" class="seg-scroll-btn seg-scroll-btn-right" aria-label="向右滚动">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="9 18 15 12 9 6"></polyline>
                        </svg>
                    </button>
                    <div class="header-actions">
                        <div class="add-dropdown-anchor">
                            <button class="action-btn" data-action="toggle-add" title="添加应用">
                                ${icon('plus')}
                            </button>
                            <div class="add-menu ${this.addMenuVisible ? 'visible' : ''}">
                                <button class="menu-item" data-action="create">
                                    <span class="menu-icon">${icon('filePlus')}</span>
                                    <span class="menu-copy">
                                        <span class="menu-title">创建应用</span>
                                        <span class="menu-desc">生成一个最小应用模板</span>
                                    </span>
                                </button>
                                <button class="menu-item" data-action="import">
                                    <span class="menu-icon">${icon('zip')}</span>
                                    <span class="menu-copy">
                                        <span class="menu-title">导入应用</span>
                                        <span class="menu-desc">从 zip 应用包安装</span>
                                    </span>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="content">
                ${this.renderCurrentTab()}
            </div>
        `;
    }

    renderTabButton(id, label, iconName) {
        return `
            <button class="seg-item ${this.activeTab === id ? 'active' : ''}" data-tab="${id}">
                ${icon(iconName)}
                <span>${label}</span>
            </button>
        `;
    }

    renderCurrentTab() {
        if (this.activeTab === 'market') {
            return `
                <div class="tab-panel">
                    <div class="empty-state">
                        <div class="empty-icon">${icon('store', 'large')}</div>
                        <div class="empty-title">应用市场即将开放</div>
                        <div class="empty-hint">这里会用于发现、搜索和安装由社区发布的 OpenDesk 应用。当前版本可以先通过右上角导入 zip 应用包。</div>
                    </div>
                </div>
            `;
        }
        if (this.activeTab === 'builtin') {
            return `
                <div class="tab-panel">
                    <div class="cards-grid">${this.builtinApps.map((app) => this.renderBuiltinCard(app)).join('')}</div>
                </div>
            `;
        }
        return `
            <div class="tab-panel">
                ${
                    this.userApps.length === 0
                        ? `<div class="empty-state">
                            <div class="empty-icon">${icon('boxOpen', 'large')}</div>
                            <div class="empty-title">还没有后装应用</div>
                            <div class="empty-hint">点击右上角加号创建一个最小应用模板，或导入符合 AppSDK 清单格式的 zip 应用包。</div>
                        </div>`
                        : `<div class="cards-grid">${this.userApps.map((app) => this.renderUserCard(app)).join('')}</div>`
                }
                <div class="status-line">${escapeHtml(this.status)}</div>
            </div>
        `;
    }

    renderIcon(app) {
        const iconUrl = app.iconUrl || './applications/default_icon.png';
        return `<img src="${escapeHtml(iconUrl)}" alt="${escapeHtml(app.name)}" onerror="this.src='./applications/default_icon.png'">`;
    }

    renderUserCard(app) {
        const current = (app.versions || []).find((version) => version.versionId === app.currentVersionId);
        return `
            <div class="app-card" data-bundle-name="${escapeHtml(app.bundleName)}">
                <div class="card-header">
                    <div class="card-icon">${this.renderIcon(app)}</div>
                    <div class="card-info">
                        <div class="card-title">${escapeHtml(app.name)}</div>
                        <div class="card-sub">${escapeHtml(app.bundleName)}</div>
                    </div>
                    <label class="toggle" title="激活应用">
                        <input type="checkbox" data-action="toggle-active" ${app.active ? 'checked' : ''}>
                        <span class="toggle-slider"></span>
                    </label>
                </div>
                <div class="card-desc">${escapeHtml(app.description || '无描述')}</div>
                <div class="card-footer">
                    <span class="pill">${escapeHtml(current?.versionName || app.currentVersionId || '未命名版本')}</span>
                    <div class="card-actions">
                        <button class="mini-btn" data-action="edit" title="编辑">${icon('edit')}</button>
                        <button class="mini-btn danger" data-action="delete" title="删除">${icon('trash')}</button>
                    </div>
                </div>
            </div>
        `;
    }

    renderBuiltinCard(app) {
        return `
            <div class="app-card">
                <div class="card-header">
                    <div class="card-icon">${this.renderIcon(app)}</div>
                    <div class="card-info">
                        <div class="card-title">${escapeHtml(app.name)}</div>
                        <div class="card-sub">${escapeHtml(app.bundleName)}</div>
                    </div>
                </div>
                <div class="card-desc">OpenDesk 内置系统应用，随主体一起安装和更新。</div>
                <div class="card-footer"><span class="pill">系统应用</span></div>
            </div>
        `;
    }

    renderEditor() {
        const app = this.editingApp;
        const versions = app.versions || [];
        const zoomPct = this.previewZoom || 75;
        return `
            <splitter-widget class="editor" initial-width="360">
                <div slot="left" class="editor-left">
                    <div class="form-section">
                        <button class="mini-btn" data-action="back">${icon('arrowLeft')} 返回</button>
                    </div>
                    <div class="form-section">
                        <div class="section-title">基本信息</div>
                        <div class="icon-edit-row">
                            <div class="card-icon">${this.renderIcon(app)}</div>
                            <label class="mini-btn">
                                ${icon('upload')} 上传图标
                                <input type="file" accept="image/*" data-action="upload-icon" style="display:none">
                            </label>
                        </div>
                    </div>
                    <div class="form-section">
                        <div class="field">
                            <label>包名</label>
                            <input value="${escapeHtml(app.bundleName)}" disabled>
                        </div>
                        <div class="field">
                            <label>显示名称</label>
                            <input id="displayNameInput" value="${escapeHtml(app.name)}">
                        </div>
                        <div class="field">
                            <label>描述</label>
                            <textarea id="descriptionInput">${escapeHtml(app.description || '')}</textarea>
                        </div>
                        <button class="btn primary" data-action="save-metadata">保存信息</button>
                    </div>
                    <div class="form-section">
                        <div class="section-title">当前版本</div>
                        <div class="field">
                            <select id="versionSelect">
                                ${versions
                                    .map(
                                        (version) =>
                                            `<option value="${escapeHtml(version.versionId)}" ${version.versionId === app.currentVersionId ? 'selected' : ''}>${escapeHtml(version.versionName)} (${escapeHtml(version.versionId)})</option>`
                                    )
                                    .join('')}
                            </select>
                        </div>
                    </div>
                    <div class="form-section">
                        <div class="section-title">版本树</div>
                        <div class="version-list">
                            ${versions.map((version) => this.renderVersionItem(version, app.currentVersionId)).join('')}
                        </div>
                    </div>
                    <div class="status-line">${escapeHtml(this.status)}</div>
                </div>
                <div slot="right" class="editor-right">
                    <div class="editor-toolbar">
                        <strong>${escapeHtml(app.name)}</strong>
                        <span class="pill">${escapeHtml(app.currentVersionId)}</span>
                        <button class="mini-btn" data-action="reload-preview" title="刷新预览">${icon('reload')}</button>
                    </div>
                    <div class="preview-container">
                        <div class="preview-viewport" style="transform: scale(${zoomPct / 100}); transform-origin: 0 0; width: ${(100 / zoomPct) * 100}%; height: ${(100 / zoomPct) * 100}%;">
                            <iframe class="preview-frame" src="${escapeHtml(app.entryUrl)}"></iframe>
                        </div>
                    </div>
                    <div class="zoom-toolbar">
                        <span class="zoom-label">${zoomPct}%</span>
                        <input type="range" class="zoom-slider" data-action="zoom" min="25" max="200" value="${zoomPct}" step="5">
                    </div>
                    <div class="modify-panel">
                        <div class="modify-input-row">
                            <textarea id="modifyInput" class="modify-input" placeholder="描述你对当前应用的修改需求，AI 将帮你完成修改…" rows="2">${escapeHtml(this.modifyRequirements)}</textarea>
                            <button class="modify-btn" data-action="request-modify" title="提交修改需求">${icon('send')}</button>
                        </div>
                        <div class="modify-status-line">${escapeHtml(this.modifyStatus)}</div>
                    </div>
                </div>
            </splitter-widget>
        `;
    }

    renderVersionItem(version, currentVersionId) {
        return `
            <div class="version-item ${version.versionId === currentVersionId ? 'current' : ''}">
                <div class="version-name">${escapeHtml(version.versionName)}</div>
                <div class="version-meta">ID ${escapeHtml(version.versionId)} · 父版本 ${escapeHtml(version.parentVersionId || '无')}</div>
            </div>
        `;
    }

    renderCreateDialog() {
        return `
            <div class="modal-overlay ${this.createDialogVisible ? 'visible' : ''}">
                <div class="modal">
                    <h3>创建应用</h3>
                    <div class="field">
                        <label>包名</label>
                        <input id="createBundleInput" placeholder="abc.def" value="${escapeHtml(this.createForm.bundleName)}">
                    </div>
                    <div class="field">
                        <label>显示名称</label>
                        <input id="createNameInput" placeholder="我的应用" value="${escapeHtml(this.createForm.displayName)}">
                    </div>
                    <div class="field">
                        <label>描述</label>
                        <textarea id="createDescriptionInput" placeholder="应用说明">${escapeHtml(this.createForm.description)}</textarea>
                    </div>
                    <div class="status-line">${escapeHtml(this.status)}</div>
                    <div class="modal-actions">
                        <button class="btn" data-action="cancel-create">取消</button>
                        <button class="btn primary" data-action="confirm-create">创建</button>
                    </div>
                </div>
            </div>
        `;
    }

    bindEvents() {
        this.shadowRoot.querySelectorAll('[data-tab]').forEach((button) => {
            button.addEventListener('click', () => {
                this.activeTab = button.dataset.tab;
                this.addMenuVisible = false;
                this.status = '';
                this.render();
            });
        });
        this.shadowRoot.querySelector('[data-action="toggle-add"]')?.addEventListener('click', (event) => {
            event.stopPropagation();
            this.addMenuVisible = !this.addMenuVisible;
            this.render();
        });
        this.shadowRoot.querySelector('[data-action="create"]')?.addEventListener('click', () => {
            this.addMenuVisible = false;
            this.createDialogVisible = true;
            this.resetCreateForm();
            this.status = '';
            this.render();
        });
        this.shadowRoot.querySelector('[data-action="import"]')?.addEventListener('click', () => this.importApp());
        this.shadowRoot.querySelector('[data-action="cancel-create"]')?.addEventListener('click', () => {
            this.createDialogVisible = false;
            this.status = '';
            this.resetCreateForm();
            this.render();
        });
        this.shadowRoot
            .querySelector('[data-action="confirm-create"]')
            ?.addEventListener('click', () => this.createApp());
        this.shadowRoot.querySelector('#createBundleInput')?.addEventListener('input', (event) => {
            this.createForm.bundleName = event.target.value;
        });
        this.shadowRoot.querySelector('#createNameInput')?.addEventListener('input', (event) => {
            this.createForm.displayName = event.target.value;
        });
        this.shadowRoot.querySelector('#createDescriptionInput')?.addEventListener('input', (event) => {
            this.createForm.description = event.target.value;
        });

        this.shadowRoot.querySelectorAll('.app-card[data-bundle-name]').forEach((card) => {
            const bundleName = card.dataset.bundleName;
            card.querySelector('[data-action="toggle-active"]')?.addEventListener('change', (event) => {
                this.setActive(bundleName, event.target.checked);
            });
            card.querySelector('[data-action="edit"]')?.addEventListener('click', () => {
                this.editingApp = this.userApps.find((app) => app.bundleName === bundleName) || null;
                this.status = '';
                this.render();
            });
            card.querySelector('[data-action="delete"]')?.addEventListener('click', () => this.deleteApp(bundleName));
        });

        this.shadowRoot.querySelector('[data-action="back"]')?.addEventListener('click', () => {
            this.editingApp = null;
            this.status = '';
            this.render();
        });
        this.shadowRoot
            .querySelector('[data-action="save-metadata"]')
            ?.addEventListener('click', () => this.saveMetadata());
        this.shadowRoot
            .querySelector('[data-action="upload-icon"]')
            ?.addEventListener('change', (event) => this.uploadIcon(event));
        this.shadowRoot
            .querySelector('#versionSelect')
            ?.addEventListener('change', (event) => this.setCurrentVersion(event.target.value));
        this.shadowRoot.querySelector('[data-action="reload-preview"]')?.addEventListener('click', () => {
            const frame = this.shadowRoot.querySelector('.preview-frame');
            if (frame) {
                // 通过重置 src 来刷新，避免跨域问题
                // eslint-disable-next-line no-self-assign
                frame.src = frame.src;
            }
        });
        this.shadowRoot.querySelector('[data-action="zoom"]')?.addEventListener('input', (event) => {
            this.previewZoom = parseInt(event.target.value, 10) || 75;
            // 只更新缩放，不重新渲染整个页面
            const viewport = this.shadowRoot.querySelector('.preview-viewport');
            const label = this.shadowRoot.querySelector('.zoom-label');
            if (viewport) {
                const pct = this.previewZoom;
                viewport.style.transform = `scale(${pct / 100})`;
                viewport.style.transformOrigin = '0 0';
                viewport.style.width = `${(100 / pct) * 100}%`;
                viewport.style.height = `${(100 / pct) * 100}%`;
            }
            if (label) {
                label.textContent = `${this.previewZoom}%`;
            }
        });
        this.shadowRoot.querySelector('[data-action="request-modify"]')?.addEventListener('click', () => {
            this.requestModify();
        });
        // 支持 Ctrl+Enter 提交修改需求
        this.shadowRoot.querySelector('#modifyInput')?.addEventListener('keydown', (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                this.requestModify();
            }
        });

        // 滚动按钮事件
        const segControl = this.shadowRoot.querySelector('.seg-control');
        const segLeftBtn = this.shadowRoot.querySelector('.seg-scroll-btn-left');
        const segRightBtn = this.shadowRoot.querySelector('.seg-scroll-btn-right');
        if (segLeftBtn && segControl) {
            segLeftBtn.addEventListener('click', () => {
                segControl.scrollBy({ left: -100, behavior: 'smooth' });
            });
        }
        if (segRightBtn && segControl) {
            segRightBtn.addEventListener('click', () => {
                segControl.scrollBy({ left: 100, behavior: 'smooth' });
            });
        }

        // 鼠标滚轮横向滚动
        const segRow = this.shadowRoot.querySelector('.seg-row');
        if (segRow && segControl) {
            segRow.addEventListener(
                'wheel',
                (e) => {
                    if (Math.abs(e.deltaX) < Math.abs(e.deltaY)) {
                        e.preventDefault();
                        segControl.scrollBy({ left: e.deltaY, behavior: 'auto' });
                    }
                },
                { passive: false }
            );
        }

        // 初始化 seg-control 滚动观察器
        this._initSegScrollObserver();
    }

    _initSegScrollObserver() {
        const container = this.shadowRoot?.querySelector('.seg-control-container');
        const segControl = this.shadowRoot?.querySelector('.seg-control');

        if (!container || !segControl) return;

        if (this._segScrollResizeObserver) {
            this._segScrollResizeObserver.disconnect();
        }

        this._segScrollResizeObserver = new ResizeObserver(() => {
            this._updateSegScrollButtons();
        });
        this._segScrollResizeObserver.observe(container);

        segControl.addEventListener('scroll', () => this._updateSegScrollButtons());

        requestAnimationFrame(() => this._updateSegScrollButtons());
        setTimeout(() => this._updateSegScrollButtons(), 100);
    }

    _updateSegScrollButtons() {
        const segControl = this.shadowRoot?.querySelector('.seg-control');
        const leftBtn = this.shadowRoot?.querySelector('.seg-scroll-btn-left');
        const rightBtn = this.shadowRoot?.querySelector('.seg-scroll-btn-right');

        if (!segControl || !leftBtn || !rightBtn) return;

        const { scrollLeft, scrollWidth, clientWidth } = segControl;
        const needsScroll = scrollWidth > clientWidth + 1;
        const canScrollLeft = scrollLeft > 0;
        const canScrollRight = scrollLeft + clientWidth < scrollWidth - 1;

        leftBtn.style.display = needsScroll && canScrollLeft ? 'flex' : 'none';
        rightBtn.style.display = needsScroll && canScrollRight ? 'flex' : 'none';
    }

    async importApp() {
        try {
            this.addMenuVisible = false;
            const paths = await window.fsAPI.selectFile();
            const zipPath = (paths || []).find((item) => String(item).toLowerCase().endsWith('.zip'));
            if (!zipPath) {
                this.status = '请选择 .zip 应用包';
                this.render();
                return;
            }
            const result = await this.api.installFromZip(zipPath);
            await this.load();
            this.activeTab = 'installed';
            this.editingApp = this.userApps.find((app) => app.bundleName === result.app.bundleName) || null;
            this.status = '';
            this.render();
        } catch (error) {
            this.status = formatUserError(error);
            this.render();
        }
    }

    resetCreateForm() {
        this.createForm = {
            bundleName: '',
            displayName: '',
            description: ''
        };
    }

    syncCreateForm() {
        const bundleInput = this.shadowRoot.querySelector('#createBundleInput');
        const nameInput = this.shadowRoot.querySelector('#createNameInput');
        const descriptionInput = this.shadowRoot.querySelector('#createDescriptionInput');
        this.createForm = {
            bundleName: bundleInput ? bundleInput.value : this.createForm.bundleName,
            displayName: nameInput ? nameInput.value : this.createForm.displayName,
            description: descriptionInput ? descriptionInput.value : this.createForm.description
        };
    }

    async createApp() {
        try {
            this.syncCreateForm();
            const bundleName = this.createForm.bundleName.trim();
            const displayName = this.createForm.displayName.trim();
            const description = this.createForm.description.trim();
            this.createForm = { bundleName, displayName, description };
            if (!bundleName || !displayName) {
                this.status = '包名和显示名称不能为空';
                this.render();
                return;
            }
            const bundleNameError = validateBundleNameInput(bundleName);
            if (bundleNameError) {
                this.status = bundleNameError;
                this.render();
                return;
            }
            const result = await this.api.createApp({ bundleName, displayName, description });
            this.createDialogVisible = false;
            this.resetCreateForm();
            await this.load();
            this.activeTab = 'installed';
            this.editingApp = this.userApps.find((app) => app.bundleName === result.app.bundleName) || null;
            this.status = '';
            this.render();
        } catch (error) {
            this.status = formatUserError(error);
            this.render();
        }
    }

    async setActive(bundleName, active) {
        try {
            await this.api.setActive(bundleName, active);
            await this.load();
        } catch (error) {
            this.status = formatUserError(error);
            this.render();
        }
    }

    async deleteApp(bundleName) {
        if (!confirm(`删除应用 ${bundleName}？`)) {
            return;
        }
        try {
            await this.api.deleteApp(bundleName);
            if (this.editingApp?.bundleName === bundleName) {
                this.editingApp = null;
            }
            await this.load();
        } catch (error) {
            this.status = formatUserError(error);
            this.render();
        }
    }

    async saveMetadata() {
        if (!this.editingApp) return;
        try {
            const displayName = this.shadowRoot.querySelector('#displayNameInput')?.value.trim();
            const description = this.shadowRoot.querySelector('#descriptionInput')?.value;
            await this.api.updateMetadata({
                bundleName: this.editingApp.bundleName,
                displayName,
                description
            });
            this.status = '';
            await this.load();
        } catch (error) {
            this.status = formatUserError(error);
            this.render();
        }
    }

    async uploadIcon(event) {
        if (!this.editingApp) return;
        try {
            const file = event.target.files?.[0];
            if (!file) return;
            // 使用 FileReader 将图片转为 base64，避免依赖 preload 中的 fsAPI/webUtils
            const iconDataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(new Error('读取图片文件失败'));
                reader.readAsDataURL(file);
            });
            await this.api.updateMetadata({
                bundleName: this.editingApp.bundleName,
                iconDataUrl
            });
            this.status = '';
            await this.load();
        } catch (error) {
            this.status = formatUserError(error);
            this.render();
        }
    }

    async setCurrentVersion(versionId) {
        if (!this.editingApp) return;
        try {
            await this.api.setCurrentVersion(this.editingApp.bundleName, versionId);
            this.status = '';
            await this.load();
        } catch (error) {
            this.status = formatUserError(error);
            this.render();
        }
    }

    async requestModify() {
        if (!this.editingApp) return;
        const input = this.shadowRoot.querySelector('#modifyInput');
        const requirements = (input?.value || '').trim();
        if (!requirements) {
            this.modifyStatus = '请输入修改需求';
            this.render();
            return;
        }
        const btn = this.shadowRoot.querySelector('[data-action="request-modify"]');
        if (btn) btn.disabled = true;

        try {
            this.modifyStatus = '正在创建修改任务…';
            this.modifyRequirements = '';
            this.render();

            const result = await this.api.requestModifyApp(this.editingApp.bundleName, requirements);

            // 立即刷新应用数据，显示新版本信息
            await this.load();
            this.modifyStatus = `修改任务已创建 (${result.versionId})，Agent 正在处理中…完成后将自动刷新预览。`;
        } catch (error) {
            this.modifyStatus = `创建修改任务失败: ${formatUserError(error)}`;
        } finally {
            this.render();
            // 5 分钟后清除状态提示
            setTimeout(
                () => {
                    if (this.modifyStatus && !this.modifyStatus.includes('失败')) {
                        this.modifyStatus = '';
                        this.render();
                    }
                },
                5 * 60 * 1000
            );
        }
    }
}

customElements.define('appmgr-entry-widget', AppMgrEntryWidget);
