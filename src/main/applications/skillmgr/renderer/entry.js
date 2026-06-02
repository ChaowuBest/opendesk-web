/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { showConfirmModal } from '../../../../renderer/components/confirmModal';

function getPathFromFile(file) {
    if (!file) return null;
    const path = window.fsAPI.getFilePath(file);
    return path ? String(path).replace(/\\/g, '/') : null;
}

function getSkillsAPI() {
    if (typeof window.applicationAPI === 'undefined') return null;
    return {
        list: () => window.applicationAPI.call('list'),
        refresh: () => window.applicationAPI.call('refresh'),
        getSkillsDirectory: () => window.applicationAPI.call('getSkillsDirectory'),
        addFromDirectory: (sourceDirectory) => window.applicationAPI.call('addFromDirectory', sourceDirectory),
        addFromZip: (zipPath, skillRelPath) => window.applicationAPI.call('addFromZip', zipPath, skillRelPath),
        delete: (skillId) => window.applicationAPI.call('delete', skillId),
        deleteSkills: (skillIds, callback) => window.applicationAPI.streamCall('deleteSkills', callback, skillIds),
        getRegistries: () => window.applicationAPI.call('getRegistries'),
        searchRegistry: (registryId, query, page, limit, cursor) =>
            window.applicationAPI.call('searchRegistry', registryId, query, page, limit, cursor),
        installFromRegistry: (installUrl, force) =>
            window.applicationAPI.call('installFromRegistry', installUrl, force),
        skillExists: (skillName) => window.applicationAPI.call('skillExists', skillName),
        getSkillDetail: (skillId) => window.applicationAPI.call('getSkillDetail', skillId),
        sendNotification: (type, title, message) =>
            window.applicationAPI.call('sendNotification', type, title, message),
        getBuiltinSkills: () => window.applicationAPI.callMainWorld('getBuiltinSkills'),
        scanDirectoryForSkills: (dirPath, callback) =>
            window.applicationAPI.streamCall('scanDirectoryForSkills', callback, dirPath),
        batchImportSkills: (skills, callback) => window.applicationAPI.streamCall('batchImportSkills', callback, skills)
    };
}

import { escapeHtml } from '../../../../common/utils/escape.js';
import { Marked } from 'marked';
import markdownCSS from '../../../../renderer/styles/github-markdown-light.min.css?inline';

const marked = new Marked();

function formatDownloads(n) {
    if (!n || n <= 0) return '';
    if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + 'w';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
}

const DEFAULT_SLOGAN = '技能，让智能体无所不能';

const REGISTRY_TABS = [
    { id: 'matrix', label: 'OpenHarmony Matrix', icon: '🔷', slogan: DEFAULT_SLOGAN },
    { id: 'clawhub', label: 'ClawHub', icon: '🐾', slogan: DEFAULT_SLOGAN },
    { id: 'skillhub', label: 'SkillHub', icon: '💎', slogan: DEFAULT_SLOGAN },
    { id: 'modelscope', label: 'ModelScope', icon: '🔮', slogan: DEFAULT_SLOGAN }
];

const PASTEL_COLORS = [
    { bg: '#EBF3FE', text: '#5B8DEF' },
    { bg: '#FEF1E6', text: '#E8935A' },
    { bg: '#E7F6EA', text: '#4CAF6E' },
    { bg: '#F2E8FD', text: '#9B6DD7' },
    { bg: '#FDE9E9', text: '#E06060' },
    { bg: '#E5F7F4', text: '#3DB49E' },
    { bg: '#FFF7E0', text: '#D4A028' },
    { bg: '#FBE5EE', text: '#D45D8A' }
];

const STYLE = `
:host {
    display: flex; flex-direction: column; height: 100%;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', sans-serif;
    font-size: 13px; color: #1d1d1f; box-sizing: border-box;
    overflow: hidden; background: #fff;
    -webkit-font-smoothing: antialiased;
}
*, *::before, *::after { box-sizing: border-box; }

/* ── Header ── */
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
    display: flex; align-items: center; gap: 10px;
    -webkit-app-region: no-drag;
}
.seg-control {
    display: inline-flex; flex: 1; min-width: 0;
    background: rgba(0, 0, 0, 0.04);
    border-radius: 10px; padding: 3px; gap: 2px;
}
.seg-item {
    padding: 7px 13px; border-radius: 8px; border: none;
    background: transparent; color: rgba(0, 0, 0, 0.4);
    font-size: 12px; font-weight: 500; cursor: pointer;
    transition: all 0.22s cubic-bezier(0.4, 0, 0.2, 1);
    font-family: inherit; white-space: nowrap;
    display: inline-flex; align-items: center; gap: 5px; line-height: 1;
}
.seg-item:hover { color: rgba(0, 0, 0, 0.6); }
.seg-item.active {
    background: #fff; color: #1d1d1f;
    box-shadow: 0 1px 3px rgba(0,0,0,0.06), 0 0.5px 1px rgba(0,0,0,0.03);
}
.seg-item .seg-icon { font-size: 13px; }
.seg-item .seg-badge {
    font-size: 10px; background: rgba(0,0,0,0.05); border-radius: 10px;
    padding: 1px 7px; font-weight: 600; line-height: 1.4;
}
.seg-item.active .seg-badge { background: rgba(90,140,240,0.12); color: #5B8DEF; }

/* ── Action buttons (next to tabs, like image 1) ── */
.header-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.action-btn {
    width: 34px; height: 34px; border-radius: 9px; border: 1px solid rgba(0,0,0,0.08);
    background: #fff; color: #444; font-size: 16px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: all 0.15s; font-family: inherit;
}
.action-btn:hover { background: #f8f8f8; border-color: rgba(0,0,0,0.12); }
.action-btn:active { transform: scale(0.95); }
.action-btn:disabled { opacity: 0.35; cursor: not-allowed; transform: none; }

/* ── Add Dropdown ── */
.add-dropdown-anchor { position: relative; }
.add-dropdown {
    display: none; flex-direction: column;
    position: absolute; top: calc(100% + 6px); right: 0;
    width: 260px; background: #fff; border-radius: 12px;
    border: 1px solid rgba(0,0,0,0.06);
    box-shadow: 0 8px 32px -8px rgba(0,0,0,0.14), 0 2px 8px -1px rgba(0,0,0,0.04);
    z-index: 9999; overflow: hidden; animation: dropdown-in 0.16s ease-out;
}
.add-dropdown.visible { display: flex; }
@keyframes dropdown-in {
    from { opacity: 0; transform: translateY(-4px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
}
.add-dropdown-section { padding: 3px; }
.add-dropdown-section + .add-dropdown-section { border-top: 1px solid rgba(0,0,0,0.04); }
.add-dropdown-item {
    display: flex; flex-direction: row; align-items: center;
    width: 100%; padding: 8px 10px; border: none; background: transparent;
    border-radius: 8px; cursor: pointer; text-align: left;
    font-size: 13px; color: #1d1d1f; font-family: inherit; transition: background 0.12s;
    gap: 10px;
}
.add-dropdown-item:hover { background: #f5f5f5; }
.add-dropdown-item .icon {
    width: 30px; height: 30px; border-radius: 8px;
    display: flex; align-items: center; justify-content: center;
    font-size: 14px; flex-shrink: 0;
}
.add-dropdown-item .icon.folder { background: #EBF3FE; color: #5B8DEF; }
.add-dropdown-item .icon.zip { background: #FEF1E6; color: #E8935A; }
.add-dropdown-item .icon.url { background: #E7F6EA; color: #4CAF6E; }
.add-dropdown-item .item-info { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.add-dropdown-item .item-name { font-weight: 600; font-size: 13px; line-height: 1.3; color: #1d1d1f; }
.add-dropdown-item .item-hint { font-size: 11px; color: #aaa; line-height: 1.35; }
.add-dropdown-item.disabled { opacity: 0.5; cursor: not-allowed; }

/* ── URL Dialog ── */
.url-dialog-overlay {
    display: none; position: fixed; inset: 0;
    background: rgba(0,0,0,0.18); z-index: 10000;
    align-items: center; justify-content: center;
    backdrop-filter: blur(6px); animation: fade-in 0.15s ease;
}
.url-dialog-overlay.visible { display: flex; }
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
.modal-dialog {
    background: #fff; border-radius: 16px; padding: 24px;
    width: 480px; max-width: 90%;
    box-shadow: 0 24px 80px -16px rgba(0,0,0,0.2);
    animation: dialog-in 0.2s ease-out; max-height: 80vh; overflow-y: auto;
}
@keyframes dialog-in {
    from { opacity: 0; transform: scale(0.95) translateY(8px); }
    to { opacity: 1; transform: scale(1) translateY(0); }
}
.modal-dialog h3 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
.modal-dialog .hint { font-size: 12px; color: #999; margin-bottom: 14px; }
.modal-dialog input[type="url"] {
    width: 100%; padding: 10px 12px; border: 1px solid rgba(0,0,0,0.1); border-radius: 10px;
    font-size: 13px; font-family: inherit; outline: none; background: #fff;
    transition: border-color 0.15s, box-shadow 0.15s;
}
.modal-dialog input[type="url"]:focus {
    border-color: #8BB8F0; box-shadow: 0 0 0 3px rgba(90,140,240,0.1);
}
.dialog-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
.btn { display: inline-flex; align-items: center; gap: 6px; padding: 7px 16px; border-radius: 8px; border: 1px solid rgba(0,0,0,0.08); background: #fff; color: #333; cursor: pointer; font-size: 12px; font-weight: 500; font-family: inherit; transition: all 0.15s; }
.btn:hover { background: #f8f8f8; }
.btn:active { transform: scale(0.97); }
.btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }
.btn-primary { background: #6BA3EF; color: #fff; border-color: #6BA3EF; }
.btn-primary:hover { background: #7DB0F3; }
.btn-danger { color: #E06060; border-color: rgba(224,96,96,0.2); }
.btn-danger:hover { background: #FFF5F5; }
.btn-sm { padding: 5px 12px; font-size: 11px; }

/* ── Content ── */
.content { flex: 1; min-height: 0; overflow: hidden; }
.tab-panel { display: none; height: 100%; overflow-y: auto; }
.tab-panel.active { display: block; }

/* ── Registry panel ── */
.registry-panel { padding: 20px 24px 60px; }

/* ── Hero title ── */
.hero-title {
    text-align: center; padding: 28px 20px 24px;
    font-size: 20px; font-weight: 700; color: #1d1d1f;
    letter-spacing: -0.02em;
    background: linear-gradient(135deg, #1d1d1f 0%, #6e6e73 100%);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    background-clip: text;
}

/* ── Search bar ── */
.search-bar { display: flex; gap: 10px; align-items: center; margin-bottom: 20px; }
.search-input-wrap { flex: 1; position: relative; min-width: 0; }
.search-input {
    width: 100%; padding: 10px 36px 10px 16px;
    border: 1px solid rgba(0,0,0,0.08); border-radius: 10px;
    background: #FAFAFA; font-size: 13px; font-family: inherit;
    outline: none; transition: all 0.2s; color: #1d1d1f;
}
.search-input:focus { border-color: #8BB8F0; box-shadow: 0 0 0 3px rgba(90,140,240,0.08); background: #fff; }
.search-input::placeholder { color: #bbb; }
.search-clear {
    position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
    width: 20px; height: 20px; border-radius: 50%;
    background: rgba(0,0,0,0.06); border: none;
    color: rgba(0,0,0,0.35); font-size: 11px; line-height: 1;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    transition: all 0.15s;
}
.search-clear:hover { background: rgba(0,0,0,0.1); color: rgba(0,0,0,0.55); }
.search-btn {
    padding: 10px 22px; border-radius: 10px; border: none;
    background: #6BA3EF; color: #fff; font-size: 13px; font-weight: 500;
    cursor: pointer; font-family: inherit; transition: all 0.15s; white-space: nowrap;
}
.search-btn:hover { background: #7DB0F3; }
.search-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* ── Skills grid ── */
.skills-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)); gap: 12px;
}

/* ── Skill card ── */
.skill-card {
    background: #fff; border-radius: 14px; padding: 16px 18px;
    border: 1px solid rgba(0,0,0,0.05);
    box-shadow: 0 1px 3px rgba(0,0,0,0.02);
    transition: all 0.22s cubic-bezier(0.4, 0, 0.2, 1);
    cursor: pointer; display: flex; flex-direction: column; gap: 8px;
}
.skill-card:hover {
    box-shadow: 0 4px 20px rgba(0,0,0,0.06);
    transform: translateY(-1px); border-color: rgba(0,0,0,0.08);
}
.card-header { display: flex; align-items: flex-start; gap: 12px; }
.card-icon {
    width: 40px; height: 40px; border-radius: 11px;
    display: flex; align-items: center; justify-content: center;
    font-size: 17px; font-weight: 700; flex-shrink: 0;
}
.card-info { flex: 1; min-width: 0; }
.card-title {
    font-size: 14px; font-weight: 600; color: #1d1d1f; line-height: 1.3;
    margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.card-author { font-size: 11px; color: #999; }
.card-desc {
    font-size: 12px; color: #777; line-height: 1.5;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.card-footer {
    display: flex; align-items: center; justify-content: space-between;
    margin-top: auto; padding-top: 4px;
}
.card-meta { display: flex; align-items: center; gap: 6px; }
.tag-pill {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 3px 9px; border-radius: 12px; font-size: 11px; font-weight: 500;
}
.tag-star { background: #FFF7E0; color: #C89520; }
.tag-download { background: #EBF3FE; color: #5B8DEF; }
.tag-score { background: #F3F3F3; color: #888; font-size: 10px; }
.install-btn {
    padding: 5px 14px; border-radius: 14px; border: none;
    background: #EBF3FE; color: #5B8DEF; font-size: 12px; font-weight: 600;
    cursor: pointer; font-family: inherit; transition: all 0.15s; flex-shrink: 0;
}
.install-btn:hover { background: #DCE9FC; }
.install-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.install-btn.installing { color: #999; background: #F5F5F5; }
.installed-card .card-footer { justify-content: flex-end; }
.builtin-card .card-footer { justify-content: flex-end; }

/* ── Progress ── */
@keyframes pulse-dot { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
.installing-dots span { display: inline-block; animation: pulse-dot 1.2s infinite; font-weight: 700; }
.installing-dots span:nth-child(2) { animation-delay: 0.2s; }
.installing-dots span:nth-child(3) { animation-delay: 0.4s; }
.progress-bar-wrap { width: 100%; height: 2.5px; background: #F0F0F0; border-radius: 2px; overflow: hidden; margin-top: 4px; }
.progress-bar-indeterminate { width: 40%; height: 100%; background: #6BA3EF; border-radius: 2px; animation: indeterminate 1.5s ease-in-out infinite; }
@keyframes indeterminate { 0% { transform: translateX(-100%); } 100% { transform: translateX(350%); } }

/* ── Messages ── */
.registry-msg { font-size: 12px; color: #999; margin: 12px 0; text-align: center; }
.registry-msg.error { color: #D14; }

/* ── Empty / Loading ── */
.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px 20px; color: #999; }
.empty-state .empty-icon { font-size: 36px; margin-bottom: 12px; opacity: 0.4; }
.empty-state .empty-title { font-size: 15px; font-weight: 600; color: #1d1d1f; margin-bottom: 6px; }
.empty-state .empty-hint { font-size: 12px; color: #999; text-align: center; max-width: 320px; line-height: 1.6; }
.empty-state .empty-dir { display: block; padding: 10px 14px; background: #FAFAFA; border-radius: 8px; font-size: 11px; font-family: 'Maple Mono', 'SF Mono', 'Cascadia Code', monospace; color: #999; margin-top: 12px; word-break: break-all; border: 1px solid #F0F0F0; }
.loading-state { display: flex; flex-direction: column; align-items: center; padding: 40px 20px; color: #999; }
.loading-spinner { width: 24px; height: 24px; border: 2.5px solid #F0F0F0; border-top-color: #6BA3EF; border-radius: 50%; animation: spin 0.7s linear infinite; margin-bottom: 12px; }
@keyframes spin { to { transform: rotate(360deg); } }
.loading-more { text-align: center; padding: 20px; color: #999; font-size: 12px; }
.scroll-sentinel { height: 1px; }

/* ── Detail Modal ── */
.detail-overlay {
    display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.18);
    z-index: 10000; align-items: center; justify-content: center;
    backdrop-filter: blur(8px); animation: fade-in 0.15s ease;
}
.detail-overlay.visible { display: flex; }
.detail-dialog {
    background: #fff; border-radius: 18px; padding: 0;
    width: 680px; max-width: 94%; max-height: 80vh; overflow: hidden;
    box-shadow: 0 24px 80px -16px rgba(0,0,0,0.22);
    animation: dialog-in 0.2s ease-out;
    display: flex; flex-direction: column;
}
.detail-header {
    display: flex; align-items: center; gap: 14px;
    padding: 20px 24px 16px; border-bottom: 1px solid #F0F0F0;
}
.detail-header .detail-icon {
    width: 48px; height: 48px; border-radius: 13px;
    display: flex; align-items: center; justify-content: center;
    font-size: 22px; font-weight: 700; flex-shrink: 0;
}
.detail-header-info { flex: 1; min-width: 0; }
.detail-header-info .detail-name { font-size: 17px; font-weight: 700; color: #1d1d1f; margin-bottom: 2px; }
.detail-header-info .detail-id { font-size: 12px; color: #999; }
.detail-close {
    width: 28px; height: 28px; border-radius: 50%; border: none;
    background: #F5F5F5; color: #999; font-size: 16px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.12s; flex-shrink: 0;
}
.detail-close:hover { background: #EBEBEB; color: #555; }
.detail-body { flex: 1; overflow-y: auto; padding: 20px 24px 24px; }
.detail-section { margin-bottom: 16px; }
.detail-section:last-child { margin-bottom: 0; }
.detail-section-label { font-size: 11px; font-weight: 600; color: #999; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; }
.detail-desc { font-size: 13px; color: #1d1d1f; line-height: 1.6; }
.detail-body-content {
    background: #fff; border-radius: 10px; padding: 16px 20px;
    max-height: 480px; overflow-y: auto; border: 1px solid #F0F0F0;
}
/* markdown-body 内标题与详情页协调，整体字号缩小两号 */
.detail-body-content.markdown-body { font-size: 13px; }
.detail-body-content.markdown-body h1 { font-size: 1.5em; }
.detail-body-content.markdown-body h2 { font-size: 1.25em; }
.detail-body-content.markdown-body h3 { font-size: 1.1em; }
.detail-meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.detail-meta-item { padding: 8px 12px; background: #FAFAFA; border-radius: 8px; font-size: 12px; color: #555; }
.detail-meta-item .meta-label { font-size: 10px; color: #999; text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 2px; }
.detail-meta-item .meta-value { font-weight: 500; }
.detail-resources { display: flex; flex-wrap: wrap; gap: 6px; }
.detail-resource-tag { padding: 4px 10px; background: #F5F5F5; border-radius: 6px; font-size: 11px; color: #555; }
.detail-tools-list { display: flex; flex-direction: column; gap: 8px; }
.detail-tool-item { padding: 12px 14px; background: #FAFAFA; border-radius: 10px; border: 1px solid #F0F0F0; }
.detail-tool-header { margin-bottom: 8px; }
.detail-tool-name { font-size: 13px; font-weight: 600; color: #1d1d1f; margin-bottom: 3px; }
.detail-tool-desc { font-size: 12px; color: #777; line-height: 1.5; }
.detail-tool-no-params { font-size: 11px; color: #bbb; margin-top: 4px; }
.detail-tool-params-toggle {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 4px 10px; border-radius: 6px; border: 1px solid rgba(0,0,0,0.06);
    background: #fff; color: #555; font-size: 11px; font-weight: 500;
    cursor: pointer; font-family: inherit; transition: all 0.12s;
}
.detail-tool-params-toggle:hover { background: #F0F0F0; color: #333; }
.detail-tool-params-toggle .toggle-icon { font-size: 8px; transition: transform 0.15s; display: inline-block; }
.detail-tool-params-toggle.expanded .toggle-icon { transform: rotate(90deg); }
.detail-tool-params {
    margin-top: 10px; border-radius: 8px; overflow: hidden;
    border: 1px solid #F0F0F0;
}
.detail-tool-params-header {
    display: grid; grid-template-columns: 1fr 0.7fr 0.5fr 1.5fr; gap: 8px;
    padding: 6px 12px; background: #F5F5F5;
    font-size: 10px; font-weight: 600; color: #999; text-transform: uppercase; letter-spacing: 0.03em;
}
.detail-tool-param {
    display: grid; grid-template-columns: 1fr 0.7fr 0.5fr 1.5fr; gap: 8px;
    padding: 6px 12px; font-size: 11px; border-top: 1px solid #F5F5F5;
}
.detail-tool-param:nth-child(odd) { background: #fff; }
.param-name { font-weight: 500; color: #333; font-family: 'SF Mono', 'Cascadia Code', monospace; }
.param-type { color: #6BA3EF; font-family: 'SF Mono', 'Cascadia Code', monospace; }
.param-required { font-size: 10px; font-weight: 600; }
.param-required.is-required { color: #E06060; }
.param-required.is-optional { color: #999; }
.param-desc { color: #666; line-height: 1.4; word-break: break-word; }
.detail-footer {
    padding: 12px 24px 16px; border-top: 1px solid #F0F0F0;
    display: flex; justify-content: flex-end; gap: 8px;
}

/* ── Scrollbar ── */
.tab-panel::-webkit-scrollbar { width: 6px; }
.tab-panel::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.1); border-radius: 3px; }
.tab-panel::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,0.18); }
.detail-body::-webkit-scrollbar { width: 5px; }
.detail-body::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.08); border-radius: 3px; }

/* ── Batch Import Modal ── */
.batch-import-overlay {
    display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.3);
    z-index: 10001; align-items: center; justify-content: center;
    backdrop-filter: blur(6px); animation: fade-in 0.25s ease;
}
.batch-import-overlay.visible { display: flex; }
.batch-import-dialog {
    background: #fff; border-radius: 20px; padding: 0;
    width: 560px; max-width: 94vw; max-height: 80vh; overflow: hidden;
    box-shadow: 0 24px 80px rgba(0,0,0,0.18), 0 0 1px rgba(0,0,0,0.1);
    animation: dialog-in 0.25s cubic-bezier(0.23, 1, 0.32, 1);
    display: flex; flex-direction: column;
}
.batch-import-header {
    display: flex; align-items: center; gap: 12px;
    padding: 24px 28px 18px; border-bottom: 1px solid #F0F0F0;
}
.batch-import-header .bi-icon {
    width: 42px; height: 42px; border-radius: 12px;
    display: flex; align-items: center; justify-content: center;
    font-size: 18px; flex-shrink: 0;
}
.batch-import-header .bi-title {
    font-size: 16px; font-weight: 700; color: #1d1d1f;
}
.batch-import-header .bi-subtitle {
    font-size: 12px; color: #999; margin-top: 2px;
}
.batch-import-body {
    flex: 1; overflow-y: auto; padding: 20px 28px 24px;
}
.batch-import-body .bi-progress-section { margin-bottom: 16px; }
.bi-progress-bar {
    width: 100%; height: 6px; background: #F0F0F0;
    border-radius: 3px; overflow: hidden;
}
.bi-progress-fill {
    height: 100%; background: linear-gradient(90deg, #5B8DEF, #7DB0F3);
    border-radius: 3px; transition: width 0.3s ease;
}
.bi-progress-fill.indeterminate {
    width: 40%; animation: bi-indeterminate 1.5s ease-in-out infinite;
}
@keyframes bi-indeterminate {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(350%); }
}
.bi-progress-text {
    display: flex; justify-content: space-between; align-items: center;
    margin-top: 8px; font-size: 13px; color: #555;
}
.bi-progress-text .bi-progress-count { font-weight: 600; color: #5B8DEF; }
.bi-progress-text .bi-progress-pct { font-size: 12px; color: #999; }
.bi-skill-list {
    max-height: 280px; overflow-y: auto; margin-top: 12px;
    border: 1px solid #F0F0F0; border-radius: 10px;
}
.bi-skill-item {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 14px; border-bottom: 1px solid #F5F5F5;
    font-size: 13px;
}
.bi-skill-item:last-child { border-bottom: none; }
.bi-skill-item .bi-skill-type {
    width: 28px; height: 28px; border-radius: 7px;
    display: flex; align-items: center; justify-content: center;
    font-size: 13px; flex-shrink: 0;
}
.bi-skill-item .bi-skill-type.dir { background: #EBF3FE; color: #5B8DEF; }
.bi-skill-item .bi-skill-type.zip { background: #FEF1E6; color: #E8935A; }
.bi-skill-item .bi-skill-name {
    flex: 1; min-width: 0; font-weight: 500;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    color: #1d1d1f;
}
.bi-skill-item .bi-skill-path {
    font-size: 11px; color: #aaa;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    max-width: 200px;
}
.bi-import-progress {
    margin-top: 12px;
}
.bi-import-progress .bi-import-item {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 0; font-size: 12px;
}
.bi-import-progress .bi-import-item .bi-import-status {
    width: 18px; text-align: center; flex-shrink: 0;
}
.bi-import-pending {
    max-height: 220px; overflow-y: auto; margin-top: 12px;
    border: 1px solid #F0F0F0; border-radius: 10px; padding: 6px 12px;
}
.bi-import-pending .bi-import-item {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 0; font-size: 12px;
}
.bi-import-pending .bi-import-item .bi-import-status {
    width: 18px; text-align: center; flex-shrink: 0;
}
.bi-import-progress .bi-import-item .bi-import-status.ok { color: #4CAF6E; }
.bi-import-progress .bi-import-item .bi-import-status.fail { color: #E06060; }
.bi-import-progress .bi-import-item .bi-import-status.pending { color: #ccc; }
.bi-empty-hint {
    text-align: center; padding: 32px 16px; color: #999; font-size: 13px;
}
.batch-import-footer {
    padding: 12px 28px 20px; border-top: 1px solid #F0F0F0;
    display: flex; justify-content: flex-end; gap: 10px;
}
.batch-import-footer .btn {
    padding: 10px 24px; border-radius: 12px;
    font-size: 14px; font-weight: 600; cursor: pointer;
    transition: all 0.15s; font-family: inherit;
}
.batch-import-footer .btn:active { transform: scale(0.97); }
.batch-import-footer .btn-cancel {
    background: #fff; color: #1d1d1f; border: 1.5px solid #E5E5EA;
}
.batch-import-footer .btn-cancel:hover { background: #F5F5F7; }
.batch-import-footer .btn-primary {
    background: #1d1d1f; color: #fff; border: none;
}
.batch-import-footer .btn-primary:hover { background: #333; }
.batch-import-footer .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }

/* ── Delete Progress Modal (复用 batch-import overlay 结构) ── */
.delete-progress-dialog {
    background: #fff; border-radius: 20px; padding: 28px;
    width: 420px; max-width: 92vw;
    box-shadow: 0 24px 80px rgba(0,0,0,0.18), 0 0 1px rgba(0,0,0,0.1);
    animation: dialog-in 0.25s cubic-bezier(0.23, 1, 0.32, 1);
}
.delete-progress-dialog h3 { margin: 0 0 16px; font-size: 16px; font-weight: 700; color: #1d1d1f; }
.delete-progress-bar {
    width: 100%; height: 6px; background: #F0F0F0;
    border-radius: 3px; overflow: hidden; margin-bottom: 10px;
}
.delete-progress-fill {
    height: 100%; background: linear-gradient(90deg, #E06060, #F09090);
    border-radius: 3px; transition: width 0.3s ease;
}
.delete-progress-text { font-size: 13px; color: #555; text-align: center; }

${markdownCSS}`;

class SkillMgrEntryWidget extends HTMLElement {
    constructor() {
        super();
        this.skills = [];
        this.skillsDir = '';
        this.loading = false;
        this.error = null;
        this.activeTab = 'matrix';
        this.addingFromPath = false;
        this.addingFromZip = false;
        this.addingFromUrl = false;
        this.addUrl = '';
        this.deletingId = null;
        this.showAddDropdown = false;
        this.installingRegistryIds = new Set();
        this._scrollObservers = [];

        this.batchImport = {
            active: false,
            phase: 'scanning',
            directory: '',
            scanTotal: 0,
            scanScanned: 0,
            scanFound: 0,
            skills: [],
            importIndex: 0,
            importTotal: 0,
            importSuccess: 0,
            importFailed: 0,
            importErrors: [],
            streamSub: null
        };

        this.deleteState = {
            active: false,
            total: 0,
            deleted: 0,
            failed: 0
        };

        this.builtinSkills = [];
        this.builtinLoading = false;
        this.builtinError = null;

        this.installedState = {
            query: '',
            page: 1,
            pageSize: 30,
            filtered: []
        };

        this.registryStates = {};
        for (const tab of REGISTRY_TABS) {
            this.registryStates[tab.id] = {
                query: '',
                results: [],
                total: 0,
                searching: false,
                hasSearched: false,
                message: null,
                page: 1,
                hasMore: false,
                loadingMore: false,
                nextCursor: null,
                autoLoaded: false
            };
        }

        this.attachShadow({ mode: 'open' });
        this._onDocClick = (e) => {
            if (this.showAddDropdown) {
                const anchor = this.shadowRoot.querySelector('.add-dropdown-anchor');
                if (anchor && !anchor.contains(e.composedPath()[0])) {
                    this.showAddDropdown = false;
                    this._updateDropdown();
                }
            }
        };
    }

    async connectedCallback() {
        this.render();
        await Promise.all([this.loadSkills(), this._loadRegistryInfo(), this.loadBuiltinSkills()]);
        document.addEventListener('click', this._onDocClick, true);
        this._autoLoadIfNeeded(this.activeTab);
    }

    async _loadRegistryInfo() {
        try {
            const api = getSkillsAPI();
            if (!api?.getRegistries) return;
            const infos = await api.getRegistries();
            if (!Array.isArray(infos)) return;
            for (const info of infos) {
                const tab = REGISTRY_TABS.find((t) => t.id === info.id);
                if (tab) {
                    if (info.label) tab.label = info.label;
                    if (info.icon) tab.icon = info.icon;
                    if (info.slogan) tab.slogan = info.slogan;
                }
            }
            this.render();
        } catch {}
    }

    disconnectedCallback() {
        document.removeEventListener('click', this._onDocClick, true);
        this._disconnectObservers();
    }

    _disconnectObservers() {
        if (this._scrollObservers) {
            this._scrollObservers.forEach((o) => o.disconnect());
            this._scrollObservers = [];
        }
    }

    async loadSkills() {
        const api = getSkillsAPI();
        if (!api) {
            this.error = '无法连接技能服务';
            this.render();
            return;
        }
        this.loading = true;
        this.error = null;
        this.render();
        try {
            this.skills = await api.list();
            if (!Array.isArray(this.skills)) this.skills = [];
            const dir = await api.getSkillsDirectory();
            if (dir) this.skillsDir = dir;
            this.installedState.query = '';
            this.installedState.page = 1;
        } catch (e) {
            this.error = e?.message || '加载失败';
            this.skills = [];
        } finally {
            this.loading = false;
            this.render();
        }
    }

    async loadBuiltinSkills() {
        const api = getSkillsAPI();
        if (!api) {
            this.builtinError = '无法连接技能服务';
            return;
        }
        this.builtinLoading = true;
        this.builtinError = null;
        try {
            this.builtinSkills = await api.getBuiltinSkills();
            if (!Array.isArray(this.builtinSkills)) this.builtinSkills = [];
        } catch (e) {
            this.builtinError = e?.message || '加载失败';
            this.builtinSkills = [];
        } finally {
            this.builtinLoading = false;
            this.render();
        }
    }

    _notify(type, title, message) {
        getSkillsAPI()?.sendNotification(type, title, message);
    }

    async refresh() {
        const api = getSkillsAPI();
        if (!api) return;
        this.loading = true;
        this.error = null;
        this.render();
        try {
            await api.refresh();
            await this.loadSkills();
        } catch (e) {
            this.error = e?.message || '刷新失败';
            this.render();
        }
    }

    switchTab(tabId) {
        if (this.activeTab === tabId) return;
        this.activeTab = tabId;
        this.render();
        if (tabId !== 'installed') this._autoLoadIfNeeded(tabId);
    }

    async _autoLoadIfNeeded(tabId) {
        const state = this.registryStates[tabId];
        if (!state || state.autoLoaded || state.searching) return;
        state.autoLoaded = true;
        await this._doSearch(tabId, '', 1);
    }

    clearAndReload(tabId) {
        const state = this.registryStates[tabId];
        if (!state) return;
        state.query = '';
        state.page = 1;
        state.results = [];
        state.nextCursor = null;
        state.hasSearched = false;
        state.message = null;
        state.autoLoaded = true;
        this._doSearch(tabId, '', 1);
    }

    async searchRegistry(tabId) {
        const state = this.registryStates[tabId];
        if (!state) return;
        state.page = 1;
        state.results = [];
        state.nextCursor = null;
        await this._doSearch(tabId, state.query, 1);
    }

    async loadMoreRegistry(tabId) {
        const state = this.registryStates[tabId];
        if (!state || !state.hasMore || state.loadingMore || state.searching) return;
        state.loadingMore = true;
        this._renderLoadingMore(tabId, true);
        const nextPage = state.page + 1;
        try {
            const api = getSkillsAPI();
            if (!api) return;
            const res = await Promise.race([
                api.searchRegistry(tabId, state.query, nextPage, 30, state.nextCursor),
                new Promise((_, rej) => setTimeout(() => rej(new Error('加载超时')), 30000))
            ]);
            state.page = nextPage;
            const newSkills = res?.skills ?? [];
            state.results = [...state.results, ...newSkills];
            state.hasMore = !!res?.hasMore;
            state.nextCursor = res?.nextCursor || null;
            state.total = res?.total ?? state.results.length;

            this._appendCards(tabId, newSkills);
        } catch (e) {
            state.message = { text: e?.message || '加载更多失败', isError: true };
            this.render();
        } finally {
            state.loadingMore = false;
            this._renderLoadingMore(tabId, false);
            if (!state.hasMore) {
                const sentinel = this.shadowRoot.querySelector(`.scroll-sentinel[data-tab="${tabId}"]`);
                if (sentinel) sentinel.remove();
            }
        }
    }

    _appendCards(tabId, newSkills) {
        const panel = this.shadowRoot.querySelector(`#panel-${tabId}`);
        if (!panel) return;
        const grid = panel.querySelector('.skills-grid');
        if (!grid) return;
        const html = this._renderRegistryCards(newSkills, tabId);
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        while (tmp.firstElementChild) {
            grid.appendChild(tmp.firstElementChild);
        }
        this._bindCardEvents(grid);
    }

    _bindCardEvents(container) {
        container.querySelectorAll('.install-btn').forEach((el) => {
            if (el._bound) return;
            el._bound = true;
            const url = el.getAttribute('data-install-url');
            const card = el.closest('.skill-card');
            const id = card?.getAttribute('data-skill-id');
            if (url && !el.disabled)
                el.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.installFromRegistry(url, id);
                });
        });
        container.querySelectorAll('[data-registry-tab]').forEach((el) => {
            if (el._bound) return;
            el._bound = true;
            el.addEventListener('click', (e) => {
                if (e.target.closest('.install-btn')) return;
                const skillId = el.getAttribute('data-skill-id');
                const tabId = el.getAttribute('data-registry-tab');
                if (skillId && tabId) this.showRegistrySkillDetail(skillId, tabId);
            });
        });
    }

    async _doSearch(tabId, query, page) {
        const state = this.registryStates[tabId];
        const api = getSkillsAPI();
        if (!api?.searchRegistry) {
            state.message = { text: '无法连接技能服务', isError: true };
            this.render();
            return;
        }
        state.searching = true;
        state.message = null;
        if (page === 1) state.results = [];
        this.render();
        try {
            const res = await Promise.race([
                api.searchRegistry(tabId, query, page, 30, state.nextCursor),
                new Promise((_, rej) => setTimeout(() => rej(new Error('搜索超时，请检查网络或稍后重试')), 30000))
            ]);
            state.results = page === 1 ? (res?.skills ?? []) : [...state.results, ...(res?.skills ?? [])];
            state.total = res?.total ?? state.results.length;
            state.hasMore = !!res?.hasMore;
            state.nextCursor = res?.nextCursor || null;
            if (res?.error) state.message = { text: res.error, isError: true };
            else if (res?.message) state.message = { text: res.message, isError: false };
        } catch (e) {
            state.message = { text: e?.message || '搜索失败', isError: true };
            if (page === 1) state.results = [];
        } finally {
            state.searching = false;
            state.hasSearched = true;
            this.render();
        }
    }

    async installFromRegistry(installUrl, skillId) {
        const api = getSkillsAPI();
        if (!installUrl || !api?.installFromRegistry) return;
        let force = false;
        try {
            const exists = await api.skillExists(skillId);
            if (exists) {
                if (!confirm(`技能「${skillId}」已存在，是否覆盖安装？`)) return;
                force = true;
            }
        } catch {}
        this.installingRegistryIds.add(skillId);
        this._updateInstallBtn(skillId, true);
        try {
            const addRes = await api.installFromRegistry(installUrl, force);
            this._notify('info', '安装成功', `技能「${addRes?.name ?? ''}」已${force ? '覆盖' : ''}安装`);
            await this.loadSkills();
        } catch (e) {
            this._notify('error', '安装失败', e?.message || '未知错误');
        } finally {
            this.installingRegistryIds.delete(skillId);
            this._updateInstallBtn(skillId, false);
        }
    }

    _updateInstallBtn(skillId, installing) {
        const btn = this.shadowRoot.querySelector(`[data-skill-id="${skillId}"] .install-btn`);
        if (!btn) return;
        const card = btn.closest('.skill-card');
        const pw = card?.querySelector('.progress-bar-wrap');
        if (installing) {
            btn.disabled = true;
            btn.innerHTML = '<span class="installing-dots"><span>.</span><span>.</span><span>.</span></span> 安装中';
            btn.classList.add('installing');
            if (!pw && card) {
                const b = document.createElement('div');
                b.className = 'progress-bar-wrap';
                b.innerHTML = '<div class="progress-bar-indeterminate"></div>';
                card.querySelector('.card-info')?.appendChild(b);
            }
        } else {
            btn.disabled = false;
            btn.textContent = '安装';
            btn.classList.remove('installing');
            pw?.remove();
        }
    }

    _renderLoadingMore(tabId, show) {
        const el = this.shadowRoot.querySelector(`#loading-more-${tabId}`);
        if (el) el.style.display = show ? 'block' : 'none';
    }

    async onPathPicked(file) {
        const fp = getPathFromFile(file);
        if (!fp) return;
        const dp = fp.replace(/[/\\][^/\\]*$/, '');
        if (!dp) return;
        const api = getSkillsAPI();
        if (!api?.addFromDirectory) return;
        this.addingFromPath = true;
        this.showAddDropdown = false;
        this._updateDropdown();
        try {
            const r = await api.addFromDirectory(dp);
            this._notify('info', '安装成功', `技能「${r?.name ?? ''}」已添加`);
            await this.loadSkills();
        } catch (e) {
            this._notify('error', '添加失败', e?.message || '未知错误');
        } finally {
            this.addingFromPath = false;
        }
    }

    async onZipPicked(file) {
        const p = getPathFromFile(file);
        if (!p) return;
        const api = getSkillsAPI();
        if (!api?.addFromZip) return;
        this.addingFromZip = true;
        this.showAddDropdown = false;
        this._updateDropdown();
        try {
            const r = await api.addFromZip(p);
            this._notify('info', '安装成功', `技能「${r?.name ?? ''}」已添加`);
            await this.loadSkills();
        } catch (e) {
            this._notify('error', '添加失败', e?.message || '未知错误');
        } finally {
            this.addingFromZip = false;
        }
    }

    async addFromUrl() {
        const api = getSkillsAPI();
        const url = this.addUrl.trim();
        if (!api?.installFromRegistry || !url) return;
        this.addingFromUrl = true;
        this.render();
        try {
            const r = await api.installFromRegistry(url);
            this._notify('info', '安装成功', `技能「${r?.name ?? ''}」已添加`);
            this.addUrl = '';
            await this.loadSkills();
        } catch (e) {
            this._notify('error', '添加失败', e?.message || '未知错误');
        } finally {
            this.addingFromUrl = false;
            this.render();
        }
    }

    async deleteSkill(skillId) {
        const api = getSkillsAPI();
        if (!api?.delete) return;

        const confirmed = await showConfirmModal({
            icon: 'fa-trash-can',
            iconBg: '#FEF2F2',
            iconColor: '#DC2626',
            title: '删除技能',
            message: `确定要删除技能「<b>${skillId}</b>」吗？删除后需要重新安装才能恢复。`,
            confirmText: '删除',
            cancelText: '取消',
            danger: true
        });
        if (!confirmed) return;

        this.deletingId = skillId;
        this.render();
        try {
            await api.delete(skillId);
            this._notify('info', '已删除', `技能「${skillId}」已移除`);
            await this.loadSkills();
        } catch (e) {
            this._notify('error', '删除失败', e?.message || '未知错误');
        } finally {
            this.deletingId = null;
            this.render();
        }
    }

    async showSkillDetail(skillId) {
        const api = getSkillsAPI();
        if (!api) return;
        let detail;
        try {
            detail = await api.getSkillDetail(skillId);
        } catch {
            detail = null;
        }
        if (!detail) {
            const skill = this.skills.find((s) => s.id === skillId);
            if (skill) detail = { ...skill, body: '', resources: { references: [], scripts: [], assets: [] } };
            else return;
        }
        this._renderDetailModal(detail, { isInstalled: true });
    }

    showBuiltinSkillDetail(skillId) {
        const skill = this.builtinSkills.find((s) => s.id === skillId);
        if (!skill) return;
        const detail = {
            id: skill.id,
            name: skill.name,
            description: skill.description,
            bundleName: skill.bundleName,
            tools: skill.tools || [],
            body: '',
            resources: { references: [], scripts: [], assets: [] },
            license: skill.license,
            compatibility: skill.compatibility,
            directory: skill.directory
        };
        this._renderDetailModal(detail, { isBuiltin: true });
    }

    /**
     * 独立的工具列表渲染组件，可在任何需要展示工具列表的地方复用
     * @param {Array<{name:string, description:string, params?:Array<{name:string, type:string, description:string, required:boolean}>}>} tools
     * @returns {string} HTML 字符串
     */
    _renderToolsList(tools) {
        if (!tools || tools.length === 0) return '';
        return `<div class="detail-section">
            <div class="detail-section-label">自带工具 (${tools.length})</div>
            <div class="detail-tools-list">${tools
                .map(
                    (t, i) => `
                <div class="detail-tool-item">
                    <div class="detail-tool-header">
                        <div class="detail-tool-name">🔧 ${escapeHtml(t.name)}</div>
                        <div class="detail-tool-desc">${escapeHtml(t.description)}</div>
                    </div>
                    ${
                        t.params && t.params.length > 0
                            ? `<button type="button" class="detail-tool-params-toggle" data-tool-toggle="${i}">
                            <span class="toggle-icon">▶</span> 参数 (${t.params.length})
                           </button>
                           <div class="detail-tool-params" data-tool-params="${i}" style="display:none">
                             <div class="detail-tool-params-header">
                               <span>参数名</span><span>类型</span><span>必填</span><span>描述</span>
                             </div>
                             ${t.params
                                 .map(
                                     (p) => `
                               <div class="detail-tool-param">
                                 <span class="param-name">${escapeHtml(p.name)}</span>
                                 <span class="param-type">${escapeHtml(p.type)}</span>
                                 <span class="param-required ${p.required ? 'is-required' : 'is-optional'}">${p.required ? '必填' : '可选'}</span>
                                 <span class="param-desc">${escapeHtml(p.description || '-')}</span>
                               </div>`
                                 )
                                 .join('')}
                           </div>`
                            : `<div class="detail-tool-no-params">无参数</div>`
                    }
                </div>`
                )
                .join('')}
            </div>
        </div>`;
    }

    showRegistrySkillDetail(skillId, tabId) {
        const state = this.registryStates[tabId];
        if (!state) return;
        const skill = state.results.find((s) => s.id === skillId);
        if (!skill) return;
        const detail = {
            id: skill.id,
            name: skill.name,
            description: skill.description,
            body: '',
            resources: { references: [], scripts: [], assets: [] },
            author: skill.author,
            source: skill.source,
            installUrl: skill.installUrl,
            canInstall: skill.canInstall,
            stars: skill.stars,
            downloads: skill.downloads,
            score: skill.score
        };
        this._renderDetailModal(detail, {
            isInstalled: false,
            installUrl: skill.installUrl,
            canInstall: skill.canInstall
        });
    }

    _renderDetailModal(detail, opts = {}) {
        this._removeDetailModal();
        const overlay = document.createElement('div');
        overlay.className = 'detail-overlay visible';
        overlay.id = 'detail-overlay';
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) this._removeDetailModal();
        });

        const color = this._getSkillPastel(detail.name || detail.id);
        const metaItems = [];
        if (detail.author) metaItems.push({ label: '作者', value: detail.author });
        if (detail.source) metaItems.push({ label: '来源', value: detail.source });
        if (detail.bundleName) metaItems.push({ label: '应用', value: detail.bundleName });
        if (detail.license) metaItems.push({ label: '许可证', value: detail.license });
        if (detail.compatibility) metaItems.push({ label: '兼容性', value: detail.compatibility });
        if (detail.allowedTools?.length) metaItems.push({ label: '允许工具', value: detail.allowedTools.join(', ') });
        if (detail.skillDir) metaItems.push({ label: '安装路径', value: detail.skillDir });
        if (opts.isBuiltin && detail.directory) metaItems.push({ label: '技能目录', value: detail.directory });

        const metaHtml =
            metaItems.length > 0
                ? `<div class="detail-section"><div class="detail-section-label">元信息</div><div class="detail-meta-grid">${metaItems.map((m) => `<div class="detail-meta-item"><div class="meta-label">${escapeHtml(m.label)}</div><div class="meta-value">${escapeHtml(m.value)}</div></div>`).join('')}</div></div>`
                : '';

        const res = detail.resources || {};
        const hasRes = (res.references?.length || 0) + (res.scripts?.length || 0) + (res.assets?.length || 0) > 0;
        const resourceHtml = hasRes
            ? `<div class="detail-section"><div class="detail-section-label">资源</div><div class="detail-resources">${(res.references || []).map((r) => `<span class="detail-resource-tag">📄 ${escapeHtml(r.name || r)}</span>`).join('')}${(res.scripts || []).map((s) => `<span class="detail-resource-tag">📜 ${escapeHtml(s)}</span>`).join('')}${(res.assets || []).map((a) => `<span class="detail-resource-tag">🖼️ ${escapeHtml(a)}</span>`).join('')}</div></div>`
            : '';

        // 内置技能的工具列表
        const toolsHtml =
            opts.isBuiltin && detail.tools && detail.tools.length > 0 ? this._renderToolsList(detail.tools) : '';

        const downloadsStr = formatDownloads(detail.downloads);
        const statsPills =
            detail.stars || downloadsStr
                ? `<div style="display:flex;gap:6px;margin-top:4px">${detail.stars ? `<span class="tag-pill tag-star">★ ${detail.stars}</span>` : ''}${downloadsStr ? `<span class="tag-pill tag-download">↓ ${downloadsStr}</span>` : ''}</div>`
                : '';

        let footerHtml;
        if (opts.isBuiltin) {
            footerHtml = `<button type="button" class="btn btn-sm" id="detail-done-btn">完成</button>`;
        } else if (opts.isInstalled) {
            footerHtml = `<button type="button" class="btn btn-danger btn-sm" id="detail-delete-btn">删除技能</button><button type="button" class="btn btn-sm" id="detail-done-btn">完成</button>`;
        } else {
            footerHtml = `<button type="button" class="btn btn-sm" id="detail-done-btn">关闭</button>${opts.canInstall !== false ? `<button type="button" class="btn btn-primary btn-sm" id="detail-install-btn" data-install-url="${escapeHtml(opts.installUrl || '')}">安装技能</button>` : ''}`;
        }

        overlay.innerHTML = `
          <div class="detail-dialog">
            <div class="detail-header">
              <div class="detail-icon" style="background:${color.bg};color:${color.text}">${this._getSkillInitial(detail.name || detail.id)}</div>
              <div class="detail-header-info">
                <div class="detail-name">${escapeHtml(detail.name || detail.id)}</div>
                <div class="detail-id">${escapeHtml(detail.id)}</div>
                ${opts.isBuiltin && detail.bundleName ? `<div style="font-size:11px;color:#8E8E93;margin-top:2px">${escapeHtml(detail.bundleName)}</div>` : ''}
                ${statsPills}
              </div>
              <button type="button" class="detail-close" id="detail-close-btn">×</button>
            </div>
            <div class="detail-body">
              ${detail.description ? `<div class="detail-section"><div class="detail-section-label">简介</div><div class="detail-desc">${escapeHtml(detail.description)}</div></div>` : ''}
              ${detail.body ? `<div class="detail-section"><div class="detail-section-label">技能内容</div><div class="detail-body-content markdown-body">${marked.parse(detail.body)}</div></div>` : ''}
              ${metaHtml}${resourceHtml}${toolsHtml}
            </div>
            <div class="detail-footer">${footerHtml}</div>
          </div>`;
        this.shadowRoot.appendChild(overlay);
        overlay.querySelector('#detail-close-btn')?.addEventListener('click', () => this._removeDetailModal());
        overlay.querySelector('#detail-done-btn')?.addEventListener('click', () => this._removeDetailModal());
        overlay.querySelector('#detail-delete-btn')?.addEventListener('click', () => {
            this._removeDetailModal();
            this.deleteSkill(detail.id);
        });
        overlay.querySelector('#detail-install-btn')?.addEventListener('click', (e) => {
            const url = e.currentTarget.getAttribute('data-install-url');
            this._removeDetailModal();
            if (url) this.installFromRegistry(url, detail.id);
        });

        // 绑定工具参数展开/折叠
        overlay.querySelectorAll('.detail-tool-params-toggle').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = btn.getAttribute('data-tool-toggle');
                const paramsEl = overlay.querySelector(`[data-tool-params="${idx}"]`);
                if (!paramsEl) return;
                const isHidden = paramsEl.style.display === 'none';
                paramsEl.style.display = isHidden ? 'block' : 'none';
                btn.classList.toggle('expanded', isHidden);
            });
        });
    }

    _removeDetailModal() {
        this.shadowRoot.getElementById('detail-overlay')?.remove();
    }

    // ── Installed Panel: search / lazy-load / delete-all ──

    _searchInstalled() {
        this.installedState.page = 1;
        this.render();
    }

    _clearInstalledSearch() {
        this.installedState.query = '';
        this.installedState.page = 1;
        this.render();
    }

    _loadMoreInstalled() {
        const state = this.installedState;
        const q = state.query.trim().toLowerCase();
        const filtered = q
            ? this.skills.filter(
                  (s) =>
                      (s.name || '').toLowerCase().includes(q) ||
                      (s.id || '').toLowerCase().includes(q) ||
                      (s.description || '').toLowerCase().includes(q)
              )
            : this.skills;
        const visible = filtered.slice(0, state.page * state.pageSize);
        if (visible.length >= filtered.length) {
            // 已全部加载
            const sentinel = this.shadowRoot.querySelector(`.scroll-sentinel[data-tab="installed"]`);
            if (sentinel) sentinel.remove();
            return;
        }
        state.page++;
        this.render();
    }

    _renderDeleteProgressDialog() {
        const ds = this.deleteState;
        if (!ds.active) return '';
        const pct = ds.total > 0 ? Math.round((ds.deleted / ds.total) * 100) : 0;
        return `
            <div style="background:#fff;border-radius:20px;padding:28px;width:420px;max-width:92vw;
                box-shadow:0 24px 80px rgba(0,0,0,0.18),0 0 1px rgba(0,0,0,0.1);
                animation:od-modal-scale-in 0.25s cubic-bezier(0.23,1,0.32,1);">
                <h3 style="margin:0 0 16px;font-size:16px;font-weight:700;color:#1d1d1f;">删除技能中…</h3>
                <div style="width:100%;height:6px;background:#F0F0F0;border-radius:3px;overflow:hidden;margin-bottom:10px;">
                    <div style="height:100%;background:linear-gradient(90deg,#E06060,#F09090);border-radius:3px;transition:width 0.3s ease;width:${pct}%;"></div>
                </div>
                <div style="font-size:13px;color:#555;text-align:center;">${ds.deleted} / ${ds.total}${ds.failed > 0 ? `（${ds.failed} 个失败）` : ''}</div>
            </div>`;
    }

    _updateDeleteProgress() {
        // 直接在 document.body 上操作，避免 shadow DOM z-index 隔离问题
        let overlay = document.getElementById('delete-progress-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'delete-progress-overlay';
            overlay.style.cssText =
                'display:none;position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.3);' +
                'align-items:center;justify-content:center;backdrop-filter:blur(6px);';
            document.body.appendChild(overlay);
        }
        const html = this._renderDeleteProgressDialog();
        if (this.deleteState.active && html) {
            overlay.innerHTML = html;
            overlay.style.display = 'flex';
        } else {
            overlay.style.display = 'none';
            if (!this.deleteState.active) {
                setTimeout(() => overlay.remove(), 300);
            }
        }
    }

    async _deleteAllSkills() {
        const api = getSkillsAPI();
        if (!api?.deleteSkills) return;
        const count = this.skills.length;
        if (count === 0) return;

        const confirmed = await showConfirmModal({
            icon: 'fa-trash-can',
            iconBg: '#FEF2F2',
            iconColor: '#DC2626',
            title: '删除所有技能',
            message: `确定要删除全部 <b>${count}</b> 个已安装技能吗？<br>删除后需要重新安装才能恢复。`,
            confirmText: '全部删除',
            cancelText: '取消',
            danger: true
        });
        if (!confirmed) return;

        // 显示进度弹窗
        this.deleteState = { active: true, total: count, deleted: 0, failed: 0 };
        this._updateDeleteProgress();

        const ids = this.skills.map((s) => s.id);
        try {
            await api.deleteSkills(ids, (chunk) => {
                if (chunk.type === 'progress') {
                    this.deleteState.deleted = chunk.deleted;
                    this._updateDeleteProgress();
                }
                if (chunk.type === 'complete') {
                    this.deleteState.deleted = chunk.deleted;
                    this.deleteState.failed = chunk.errors?.length || 0;
                }
            });
        } catch (e) {
            this.deleteState.failed = count;
        }
        this.deleteState.active = false;
        this._updateDeleteProgress();

        const deleted = this.deleteState.deleted;
        const failed = this.deleteState.failed;
        this._notify('info', '批量删除完成', `成功删除 ${deleted} 个${failed > 0 ? `，失败 ${failed} 个` : ''}`);
        await this.loadSkills();
    }

    // ── Batch Import ──

    _renderBatchImportDialog() {
        const bi = this.batchImport;
        if (!bi.active) return '';

        return `
            <div class="batch-import-dialog">
                <div class="batch-import-header">
                    <div class="bi-icon" style="background:#EFF6FF;color:#2563EB;">📥</div>
                    <div>
                        <div class="bi-title">批量导入技能</div>
                        <div class="bi-subtitle">${escapeHtml(bi.directory || '')}</div>
                    </div>
                </div>
                <div class="batch-import-body">${this._renderBatchImportBody()}</div>
                ${this._renderBatchImportFooter()}
            </div>`;
    }

    _renderBatchImportBody() {
        const bi = this.batchImport;
        const progressPct = bi.scanTotal > 0 ? Math.round((bi.scanScanned / bi.scanTotal) * 100) : 0;

        if (bi.phase === 'scanning') {
            return `
                <div class="bi-progress-section">
                    <div class="bi-progress-bar">
                        <div class="bi-progress-fill${bi.scanTotal === 0 ? ' indeterminate' : ''}" style="${bi.scanTotal > 0 ? `width:${progressPct}%` : ''}"></div>
                    </div>
                    <div class="bi-progress-text">
                        <span>正在扫描目录…</span>
                        <span class="bi-progress-count">已发现 <b>${bi.scanFound}</b> 个技能</span>
                    </div>
                    ${bi.scanTotal > 0 ? `<div class="bi-progress-text"><span></span><span class="bi-progress-pct">${progressPct}%</span></div>` : ''}
                </div>`;
        }
        if (bi.phase === 'results') {
            let listHtml;
            if (bi.skills.length === 0) {
                listHtml = `<div class="bi-empty-hint">未在所选目录中发现任何技能</div>`;
            } else {
                listHtml = `
                    <div class="bi-skill-list">${bi.skills
                        .map(
                            (s) => `
                        <div class="bi-skill-item">
                            <span class="bi-skill-type ${s.type}">${s.type === 'directory' ? '📁' : '📦'}</span>
                            <span class="bi-skill-name">${escapeHtml(s.name)}</span>
                            <span class="bi-skill-path" title="${escapeHtml(s.path)}">${escapeHtml(s.path)}</span>
                        </div>`
                        )
                        .join('')}
                    </div>`;
            }
            return `
                <div class="bi-progress-section">
                    <div class="bi-progress-text">
                        <span>扫描完成</span>
                        <span class="bi-progress-count">共发现 <b>${bi.scanFound}</b> 个技能</span>
                    </div>
                </div>
                ${listHtml}`;
        }
        if (bi.phase === 'importing') {
            const pendingItems = bi.skills.slice(bi.importIndex).map((s) => {
                return `<div class="bi-import-item">
                    <span class="bi-import-status pending">○</span>
                    <span>${escapeHtml(s.name)}</span>
                </div>`;
            });
            const importPct = bi.importTotal > 0 ? Math.round((bi.importIndex / bi.importTotal) * 100) : 0;
            return `
                <div class="bi-progress-section">
                    <div class="bi-progress-bar">
                        <div class="bi-progress-fill" style="width:${importPct}%"></div>
                    </div>
                    <div class="bi-progress-text">
                        <span>正在导入…</span>
                        <span class="bi-progress-count">${bi.importIndex} / ${bi.importTotal}${bi.importFailed > 0 ? `（${bi.importFailed} 个失败）` : ''}</span>
                    </div>
                </div>
                ${pendingItems.length > 0 ? `<div class="bi-import-pending">${pendingItems.join('')}</div>` : ''}`;
        }
        if (bi.phase === 'complete') {
            let failedHtml = '';
            if (bi.importFailed > 0) {
                const failedItems = bi.importErrors.map((e) => {
                    const skill = bi.skills[e.index];
                    return `<div class="bi-import-item">
                        <span class="bi-import-status fail">✕</span>
                        <span>${escapeHtml(skill?.name || '?')}</span>
                        <span style="color:#E06060;font-size:11px;flex:1;text-align:right;">${escapeHtml(e.message || '未知错误')}</span>
                    </div>`;
                });
                // 如果有 skill 失败了但没记录到 importErrors（通过 catch 的），也要显示
                failedHtml = `
                    <div class="bi-progress-text" style="margin-top:12px;color:#E06060;">失败详情：</div>
                    <div class="bi-import-pending" style="max-height:180px;">${failedItems.join('')}</div>`;
            }
            return `
                <div class="bi-progress-section">
                    <div class="bi-progress-text">
                        <span>导入完成</span>
                        <span class="bi-progress-count" style="color:${bi.importFailed > 0 ? '#E06060' : '#4CAF6E'}">
                            成功 ${bi.importSuccess} 个${bi.importFailed > 0 ? `，失败 ${bi.importFailed} 个` : ''}
                        </span>
                    </div>
                </div>
                ${failedHtml}`;
        }
        return '';
    }

    _renderBatchImportFooter() {
        const bi = this.batchImport;
        if (bi.phase === 'scanning') {
            return `<div class="batch-import-footer">
                <button type="button" class="btn btn-cancel" id="bi-cancel-btn">取消</button>
            </div>`;
        }
        if (bi.phase === 'results') {
            return `<div class="batch-import-footer">
                <button type="button" class="btn btn-cancel" id="bi-cancel-btn">取消</button>
                ${bi.skills.length > 0 ? `<button type="button" class="btn btn-primary" id="bi-confirm-btn">确认导入 (${bi.skills.length})</button>` : ''}
            </div>`;
        }
        if (bi.phase === 'importing') {
            return `<div class="batch-import-footer">
                <button type="button" class="btn btn-cancel" id="bi-stop-btn">停止导入</button>
            </div>`;
        }
        if (bi.phase === 'complete') {
            return `<div class="batch-import-footer">
                <button type="button" class="btn btn-primary" id="bi-done-btn">完成</button>
            </div>`;
        }
        return '';
    }

    _openBatchImportModal() {
        this.batchImport.active = true;
        const overlay = this.shadowRoot.getElementById('batch-import-overlay');
        if (overlay) {
            overlay.innerHTML = this._renderBatchImportDialog();
            overlay.classList.add('visible');
            // 新对话框重置事件委托标记
            overlay._biDelegated = false;
        }
        this._bindBatchImportEvents();

        // Esc 键关闭
        this._batchImportEscHandler = (e) => {
            if (e.key === 'Escape' && this.batchImport.active) {
                if (this.batchImport.phase === 'scanning' || this.batchImport.phase === 'results') {
                    this._closeBatchImportModal();
                }
            }
        };
        document.addEventListener('keydown', this._batchImportEscHandler);
    }

    _closeBatchImportModal() {
        // 取消 stream 订阅
        if (this.batchImport.streamSub) {
            this.batchImport.streamSub();
            this.batchImport.streamSub = null;
        }
        this.batchImport.active = false;
        const overlay = this.shadowRoot.getElementById('batch-import-overlay');
        if (overlay) overlay.classList.remove('visible');
        if (this._batchImportEscHandler) {
            document.removeEventListener('keydown', this._batchImportEscHandler);
            this._batchImportEscHandler = null;
        }
    }

    _updateBatchImportModal() {
        const overlay = this.shadowRoot.getElementById('batch-import-overlay');
        if (!overlay || !this.batchImport.active) return;
        // 仅替换 body/footer 的内容，不触碰 dialog 本身，避免动画重新触发
        const body = overlay.querySelector('.batch-import-body');
        if (body) body.innerHTML = this._renderBatchImportBody();
        const existingFooter = overlay.querySelector('.batch-import-footer');
        const newFooterHtml = this._renderBatchImportFooter();
        if (existingFooter) {
            if (newFooterHtml) {
                existingFooter.innerHTML = newFooterHtml
                    .replace('<div class="batch-import-footer">', '')
                    .replace('</div>', '');
            } else {
                existingFooter.remove();
            }
        } else if (newFooterHtml) {
            const dialog = overlay.querySelector('.batch-import-dialog');
            if (dialog) dialog.insertAdjacentHTML('beforeend', newFooterHtml);
        }
        this._bindBatchImportEvents();
    }

    _bindBatchImportEvents() {
        const overlay = this.shadowRoot.getElementById('batch-import-overlay');
        if (!overlay) return;

        // 事件委托：只在 dialog 上绑定一次，通过 e.target 判断点击了哪个按钮
        if (!overlay._biDelegated) {
            overlay._biDelegated = true;
            overlay.addEventListener('click', (e) => {
                // 蒙层点击
                if (e.target === overlay) {
                    if (this.batchImport.phase === 'scanning' || this.batchImport.phase === 'results') {
                        this._closeBatchImportModal();
                    }
                    return;
                }
                // 按钮点击
                const btn = e.target.closest('button');
                if (!btn) return;
                const id = btn.id;
                if (id === 'bi-cancel-btn') this._closeBatchImportModal();
                else if (id === 'bi-done-btn') this._closeBatchImportModal();
                else if (id === 'bi-confirm-btn') this._confirmBatchImport();
                else if (id === 'bi-stop-btn') {
                    this.batchImport.phase = 'complete';
                    this._updateBatchImportModal();
                    if (this.batchImport.importSuccess > 0) this.loadSkills();
                }
            });
        }
    }

    async _startBatchImport(dirPath) {
        // 重置状态
        this.batchImport = {
            active: true,
            phase: 'scanning',
            directory: dirPath,
            scanTotal: 0,
            scanScanned: 0,
            scanFound: 0,
            skills: [],
            importIndex: 0,
            importTotal: 0,
            importSuccess: 0,
            importFailed: 0,
            importErrors: [],
            streamSub: null
        };

        this._openBatchImportModal();
        await this._startBatchImportScan(dirPath);
    }

    async _startBatchImportScan(dirPath) {
        const api = getSkillsAPI();
        if (!api?.scanDirectoryForSkills) {
            this.batchImport.phase = 'results';
            this._updateBatchImportModal();
            return;
        }

        // 使用 streamCall 进行流式扫描
        try {
            await api.scanDirectoryForSkills(dirPath, (chunk) => {
                if (!this.batchImport.active) return;
                if (chunk.type === 'error') {
                    this.batchImport.phase = 'results';
                    this._updateBatchImportModal();
                    this._notify('error', '扫描失败', chunk.message || '未知错误');
                    return;
                }
                if (chunk.type === 'scanStart') {
                    this.batchImport.scanTotal = chunk.total;
                }
                if (chunk.type === 'progress') {
                    this.batchImport.scanScanned = chunk.scanned;
                    this.batchImport.scanFound = chunk.found;
                    this._updateBatchImportModal();
                }
                if (chunk.type === 'complete') {
                    this.batchImport.scanScanned = chunk.scanned;
                    this.batchImport.scanFound = chunk.found;
                    this.batchImport.skills = chunk.skills || [];
                    this.batchImport.phase = 'results';
                    this._updateBatchImportModal();
                }
            });
        } catch (e) {
            if (!this.batchImport.active) return;
            this.batchImport.phase = 'results';
            this._updateBatchImportModal();
            this._notify('error', '扫描失败', e?.message || '未知错误');
        }
    }

    async _confirmBatchImport() {
        const skills = this.batchImport.skills;
        if (skills.length === 0) return;

        this.batchImport.phase = 'importing';
        this.batchImport.importTotal = skills.length;
        this.batchImport.importIndex = 0;
        this.batchImport.importSuccess = 0;
        this.batchImport.importFailed = 0;
        this.batchImport.importErrors = [];
        this._updateBatchImportModal();

        const api = getSkillsAPI();
        if (!api?.batchImportSkills) return;

        try {
            await api.batchImportSkills(skills, (chunk) => {
                if (!this.batchImport.active) return;
                if (chunk.type === 'progress') {
                    this.batchImport.importIndex = chunk.index;
                    this.batchImport.importSuccess = chunk.success;
                    this.batchImport.importFailed = chunk.failed;
                    this._updateBatchImportModal();
                }
                if (chunk.type === 'complete') {
                    this.batchImport.importIndex = chunk.total;
                    this.batchImport.importSuccess = chunk.success;
                    this.batchImport.importFailed = chunk.failed;
                    if (chunk.errors) {
                        this.batchImport.importErrors = chunk.errors.map((e) => ({
                            index: e.index,
                            message: e.error
                        }));
                    }
                    this.batchImport.phase = 'complete';
                    this._updateBatchImportModal();
                }
            });
        } catch (e) {
            if (!this.batchImport.active) return;
            this.batchImport.importFailed = skills.length - this.batchImport.importSuccess;
            this.batchImport.phase = 'complete';
            this._updateBatchImportModal();
        }

        // 刷新技能列表（只刷新一次）
        if (this.batchImport.importSuccess > 0) {
            await this.loadSkills();
        }
    }

    _updateDropdown() {
        const el = this.shadowRoot.querySelector('.add-dropdown');
        if (el) el.classList.toggle('visible', this.showAddDropdown);
    }

    _getSkillInitial(name) {
        if (!name) return '⚡';
        const first = name.charAt(0).toUpperCase();
        return /[A-Z0-9\u4e00-\u9fff]/.test(first) ? first : '⚡';
    }

    _getSkillPastel(name) {
        let hash = 0;
        for (let i = 0; i < (name || '').length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
        return PASTEL_COLORS[Math.abs(hash) % PASTEL_COLORS.length];
    }

    _getSkillColor(name) {
        return this._getSkillPastel(name).bg;
    }

    _renderRegistryCards(results, tabId) {
        return results
            .map((s) => {
                const isInstalling = this.installingRegistryIds.has(s.id);
                const downloadsStr = formatDownloads(s.downloads);
                const color = this._getSkillPastel(s.name || s.id);
                return `
            <div class="skill-card" data-skill-id="${escapeHtml(s.id)}" data-registry-tab="${tabId}">
              <div class="card-header">
                <div class="card-icon" style="background:${color.bg};color:${color.text}">${this._getSkillInitial(s.name || s.id)}</div>
                <div class="card-info">
                  <div class="card-title">${escapeHtml(s.name || s.id)}</div>
                  ${s.author ? `<div class="card-author">@${escapeHtml(s.author)}</div>` : ''}
                  ${isInstalling ? '<div class="progress-bar-wrap"><div class="progress-bar-indeterminate"></div></div>' : ''}
                </div>
              </div>
              ${s.description ? `<div class="card-desc">${escapeHtml(s.description)}</div>` : ''}
              <div class="card-footer">
                <div class="card-meta">
                  ${s.stars ? `<span class="tag-pill tag-star">★ ${s.stars}</span>` : ''}
                  ${downloadsStr ? `<span class="tag-pill tag-download">↓ ${downloadsStr}</span>` : ''}
                  ${s.score ? `<span class="tag-pill tag-score">匹配 ${typeof s.score === 'number' ? s.score.toFixed(2) : s.score}</span>` : ''}
                </div>
                <button type="button" class="install-btn ${isInstalling ? 'installing' : ''}"
                  data-install-url="${escapeHtml(s.installUrl || '')}"
                  ${!s.canInstall || isInstalling ? 'disabled' : ''}>
                  ${isInstalling ? '<span class="installing-dots"><span>.</span><span>.</span><span>.</span></span> 安装中' : s.canInstall ? '安装' : '不可用'}
                </button>
              </div>
            </div>`;
            })
            .join('');
    }

    _renderRegistryPanel(tabId) {
        const state = this.registryStates[tabId];
        if (!state) return '';
        const tabInfo = REGISTRY_TABS.find((t) => t.id === tabId);
        const isDefaultView = state.hasSearched && state.results.length > 0 && !state.query.trim();

        const msgHtml = state.message
            ? `<div class="registry-msg ${state.message.isError ? 'error' : ''}">${escapeHtml(state.message.text)}</div>`
            : '';

        let contentHtml = '';
        if (state.searching && state.results.length === 0) {
            contentHtml = `<div class="loading-state"><div class="loading-spinner"></div><span>搜索中…</span></div>`;
        } else if (state.hasSearched && state.results.length > 0) {
            if (isDefaultView) {
                const slogan = tabInfo?.slogan || DEFAULT_SLOGAN;
                contentHtml = `<div class="hero-title">${escapeHtml(slogan)}</div>`;
            }
            contentHtml += `<div class="skills-grid">${this._renderRegistryCards(state.results, tabId)}</div>`;
            if (state.hasMore) {
                contentHtml += `<div class="loading-more" id="loading-more-${tabId}" style="${state.loadingMore ? '' : 'display:none'}"><div class="loading-spinner" style="margin:0 auto 8px;width:20px;height:20px;"></div>加载更多…</div>`;
            }
            contentHtml += `<div class="scroll-sentinel" data-tab="${tabId}"></div>`;
        } else if (state.hasSearched) {
            contentHtml = `<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-title">未找到结果</div><div class="empty-hint">换个关键词试试</div></div>`;
        } else {
            contentHtml = `<div class="loading-state"><div class="loading-spinner"></div><span>加载中…</span></div>`;
        }

        return `
        <div class="registry-panel">
          <div class="search-bar">
            <div class="search-input-wrap">
              <input type="text" class="search-input" data-search-tab="${tabId}"
                placeholder="搜索 ${tabInfo?.label || ''} 中的技能…"
                value="${escapeHtml(state.query)}" ${state.searching ? 'disabled' : ''} />
              <button type="button" class="search-clear" data-clear-tab="${tabId}" title="清除搜索">×</button>
            </div>
            <button type="button" class="search-btn" data-search-btn="${tabId}" ${state.searching ? 'disabled' : ''}>
              ${state.searching ? '搜索中…' : '搜索'}
            </button>
          </div>
          ${msgHtml}${contentHtml}
        </div>`;
    }

    _renderInstalledPanel() {
        const state = this.installedState;
        if (this.loading)
            return `<div class="registry-panel"><div class="loading-state"><div class="loading-spinner"></div><span>加载中…</span></div></div>`;
        if (this.error)
            return `<div class="registry-panel"><div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-title">${escapeHtml(this.error)}</div></div></div>`;
        if (this.skills.length === 0)
            return `<div class="registry-panel"><div class="empty-state"><div class="empty-icon">📦</div><div class="empty-title">暂无已安装技能</div><div class="empty-hint">通过右上角「+」或切换到其他标签页安装</div>${this.skillsDir ? `<code class="empty-dir">${escapeHtml(this.skillsDir)}</code>` : ''}</div></div>`;

        // 过滤
        const q = state.query.trim().toLowerCase();
        const filtered = q
            ? this.skills.filter(
                  (s) =>
                      (s.name || '').toLowerCase().includes(q) ||
                      (s.id || '').toLowerCase().includes(q) ||
                      (s.description || '').toLowerCase().includes(q)
              )
            : this.skills;

        const total = filtered.length;
        const visible = filtered.slice(0, state.page * state.pageSize);
        const hasMore = visible.length < total;

        let contentHtml;
        if (filtered.length === 0) {
            contentHtml = `<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-title">未找到匹配的技能</div><div class="empty-hint">换个关键词试试</div></div>`;
        } else {
            const skillCount = this.skills.length;
            const heroHtml = !q && state.page === 1 ? `<div class="hero-title">已安装 ${skillCount} 个技能</div>` : '';
            contentHtml = `
                ${heroHtml}
                <div class="skills-grid">${visible
                    .map((s) => {
                        const color = this._getSkillPastel(s.name || s.id);
                        return `
                <div class="skill-card installed-card" data-view-skill="${escapeHtml(s.id)}">
                  <div class="card-header">
                    <div class="card-icon" style="background:${color.bg};color:${color.text}">${this._getSkillInitial(s.name || s.id)}</div>
                    <div class="card-info"><div class="card-title">${escapeHtml(s.name || s.id || '')}</div></div>
                  </div>
                  ${s.description ? `<div class="card-desc">${escapeHtml(s.description)}</div>` : ''}
                  <div class="card-footer">
                    <div class="card-meta"></div>
                    <button type="button" class="btn btn-sm btn-danger" data-delete="${escapeHtml(s.id)}" ${this.deletingId === s.id ? 'disabled' : ''}>${this.deletingId === s.id ? '…' : '删除'}</button>
                  </div>
                </div>`;
                    })
                    .join('')}</div>`;
            if (hasMore) {
                contentHtml += `<div class="loading-more" id="loading-more-installed" style="display:none"><div class="loading-spinner" style="margin:0 auto 8px;width:20px;height:20px;"></div>加载更多…</div>`;
            }
            if (hasMore) {
                contentHtml += `<div class="scroll-sentinel" data-tab="installed"></div>`;
            }
        }

        return `
        <div class="registry-panel">
          <div class="search-bar">
            <div class="search-input-wrap">
              <input type="text" class="search-input" data-search-tab="installed"
                placeholder="搜索已安装技能…"
                value="${escapeHtml(state.query)}" />
              <button type="button" class="search-clear" data-clear-tab="installed" title="清除搜索">×</button>
            </div>
            <button type="button" class="search-btn" data-search-btn="installed">搜索</button>
            <button type="button" class="btn btn-danger btn-sm" id="delete-all-btn" title="删除所有技能" style="flex-shrink:0;white-space:nowrap;padding:10px 22px;border-radius:10px;border:none;background:#E06060;color:#fff;font-size:13px;font-weight:500;font-family:inherit;cursor:pointer;transition:all 0.15s;">删除全部</button>
          </div>
          ${contentHtml}
        </div>`;
    }

    _renderBuiltinPanel() {
        if (this.builtinLoading)
            return `<div class="registry-panel"><div class="loading-state"><div class="loading-spinner"></div><span>加载中…</span></div></div>`;
        if (this.builtinError)
            return `<div class="registry-panel"><div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-title">${escapeHtml(this.builtinError)}</div></div></div>`;
        if (this.builtinSkills.length === 0)
            return `<div class="registry-panel"><div class="empty-state"><div class="empty-icon">🔌</div><div class="empty-title">暂无内置技能</div><div class="empty-hint">系统内置技能会在启用对应应用后自动显示</div></div></div>`;
        return `<div class="registry-panel"><div class="skills-grid">${this.builtinSkills
            .map((s) => {
                const color = this._getSkillPastel(s.name || s.id);
                const toolCount = (s.tools && s.tools.length) || 0;
                return `
            <div class="skill-card builtin-card" data-builtin-skill="${escapeHtml(s.id)}">
              <div class="card-header">
                <div class="card-icon" style="background:${color.bg};color:${color.text}">${this._getSkillInitial(s.name || s.id)}</div>
                <div class="card-info">
                  <div class="card-title">${escapeHtml(s.name || s.id)}</div>
                  ${s.bundleName ? `<div class="card-author">${escapeHtml(s.bundleName)}${toolCount > 0 ? ` · ${toolCount} 个工具` : ''}</div>` : ''}
                </div>
              </div>
              ${s.description ? `<div class="card-desc">${escapeHtml(s.description)}</div>` : ''}
              <div class="card-footer">
                <div class="card-meta"></div>
                <span class="tag-pill tag-score">内置</span>
              </div>
            </div>`;
            })
            .join('')}</div></div>`;
    }

    render() {
        const scrollPositions = {};
        [...REGISTRY_TABS.map((t) => `panel-${t.id}`), 'panel-installed', 'panel-builtin'].forEach((id) => {
            const el = this.shadowRoot.querySelector(`#${id}`);
            if (el) scrollPositions[id] = el.scrollTop;
        });
        this._disconnectObservers();

        const skillCount = this.skills.length;
        const builtinCount = this.builtinSkills.length;
        const tabsHtml =
            REGISTRY_TABS.map(
                (t) =>
                    `<button type="button" class="seg-item ${this.activeTab === t.id ? 'active' : ''}" data-tab="${t.id}"><span class="seg-icon">${t.icon}</span> ${t.label}</button>`
            ).join('') +
            `<button type="button" class="seg-item ${this.activeTab === 'installed' ? 'active' : ''}" data-tab="installed"><span class="seg-icon">📦</span> 已安装${skillCount > 0 ? ` <span class="seg-badge">${skillCount}</span>` : ''}</button>` +
            `<button type="button" class="seg-item ${this.activeTab === 'builtin' ? 'active' : ''}" data-tab="builtin"><span class="seg-icon">⚙️</span> 内置技能${builtinCount > 0 ? ` <span class="seg-badge">${builtinCount}</span>` : ''}</button>`;

        const panelsHtml =
            REGISTRY_TABS.map(
                (t) =>
                    `<div class="tab-panel ${this.activeTab === t.id ? 'active' : ''}" id="panel-${t.id}">${this._renderRegistryPanel(t.id)}</div>`
            ).join('') +
            `<div class="tab-panel ${this.activeTab === 'installed' ? 'active' : ''}" id="panel-installed">${this._renderInstalledPanel()}</div>` +
            `<div class="tab-panel ${this.activeTab === 'builtin' ? 'active' : ''}" id="panel-builtin">${this._renderBuiltinPanel()}</div>`;

        this.shadowRoot.innerHTML = `
        <style>${STYLE}</style>
        <div class="header-area">
            <div class="header-title">技能中心</div>
            <div class="seg-row">
                <div class="seg-control">${tabsHtml}</div>
                <div class="header-actions">
                    <button type="button" class="action-btn" id="refresh-btn" title="刷新" ${this.loading ? 'disabled' : ''}>↻</button>
                    <div class="add-dropdown-anchor">
                        <button type="button" class="action-btn" id="add-btn" title="添加技能">+</button>
                        <div class="add-dropdown" id="add-dropdown">
                            <div class="add-dropdown-section">
                                <label class="add-dropdown-item ${this.addingFromPath ? 'disabled' : ''}">
                                    <input type="file" id="add-from-path-input" webkitdirectory directory style="display:none" ${this.addingFromPath ? 'disabled' : ''} />
                                    <span class="icon folder">📁</span>
                                    <span class="item-info"><span class="item-name">从目录安装</span><span class="item-hint">选择含 SKILL.md 的目录</span></span>
                                </label>
                                <label class="add-dropdown-item ${this.addingFromZip ? 'disabled' : ''}">
                                    <input type="file" id="add-from-zip-input" accept=".zip" style="display:none" ${this.addingFromZip ? 'disabled' : ''} />
                                    <span class="icon zip">📦</span>
                                    <span class="item-info"><span class="item-name">从 ZIP 安装</span><span class="item-hint">选择 .zip 技能压缩包</span></span>
                                </label>
                                <button type="button" class="add-dropdown-item" id="batch-import-item">
                                    <span class="icon" style="background:#E7F6EA;color:#4CAF6E;">📥</span>
                                    <span class="item-info"><span class="item-name">批量导入</span><span class="item-hint">从目录批量扫描并导入技能</span></span>
                                </button>
                            </div>
                            <div class="add-dropdown-section">
                                <button type="button" class="add-dropdown-item" id="add-url-item">
                                    <span class="icon url">🔗</span>
                                    <span class="item-info"><span class="item-name">从 URL 安装</span><span class="item-hint">ZIP 下载链接 / GitHub tree URL</span></span>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        <div class="content">${panelsHtml}</div>
        <div class="url-dialog-overlay" id="url-dialog-overlay">
            <div class="modal-dialog">
                <h3>从 URL 安装技能</h3>
                <div class="hint">支持 .zip URL 或 GitHub tree URL</div>
                <input type="url" id="url-dialog-input" placeholder="https://..." value="${escapeHtml(this.addUrl)}" />
                <div class="dialog-actions">
                    <button type="button" class="btn" id="url-dialog-cancel">取消</button>
                    <button type="button" class="btn btn-primary" id="url-dialog-ok" ${this.addingFromUrl ? 'disabled' : ''}>${this.addingFromUrl ? '安装中…' : '安装'}</button>
                </div>
            </div>
        </div>
        <div class="batch-import-overlay" id="batch-import-overlay">
            ${this._renderBatchImportDialog()}
        </div>`;

        this._bindEvents();
        Object.entries(scrollPositions).forEach(([id, top]) => {
            const el = this.shadowRoot.querySelector(`#${id}`);
            if (el) el.scrollTop = top;
        });
        this._bindScrollObservers();
    }

    _bindScrollObservers() {
        this._disconnectObservers();
        this.shadowRoot.querySelectorAll('.scroll-sentinel').forEach((sentinel) => {
            const tabId = sentinel.dataset.tab;
            const panel = sentinel.closest('.tab-panel');
            if (!panel || !tabId) return;
            const obs = new IntersectionObserver(
                (entries) => {
                    if (entries[0].isIntersecting) {
                        if (tabId === 'installed') this._loadMoreInstalled();
                        else this.loadMoreRegistry(tabId);
                    }
                },
                { rootMargin: '300px', root: panel }
            );
            obs.observe(sentinel);
            this._scrollObservers.push(obs);
        });
    }

    _bindEvents() {
        const $ = (sel) => this.shadowRoot.querySelector(sel);
        const $$ = (sel) => this.shadowRoot.querySelectorAll(sel);

        $('#refresh-btn')?.addEventListener('click', () => this.refresh());
        $('#add-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showAddDropdown = !this.showAddDropdown;
            this._updateDropdown();
        });

        const pathInput = $('#add-from-path-input');
        if (pathInput)
            pathInput.addEventListener('change', (e) => {
                const f = e.target.files?.[0];
                if (f) this.onPathPicked(f);
                e.target.value = '';
            });
        const zipInput = $('#add-from-zip-input');
        if (zipInput)
            zipInput.addEventListener('change', (e) => {
                const f = e.target.files?.[0];
                if (f) this.onZipPicked(f);
                e.target.value = '';
            });

        // 批量导入：点击后通过原生对话框选择目录
        $('#batch-import-item')?.addEventListener('click', async () => {
            this.showAddDropdown = false;
            this._updateDropdown();
            const dirPath = await window.fsAPI.selectDirectory();
            if (!dirPath) return;
            await this._startBatchImport(dirPath);
        });

        $('#add-url-item')?.addEventListener('click', () => {
            this.showAddDropdown = false;
            this._updateDropdown();
            $('#url-dialog-overlay')?.classList.add('visible');
            setTimeout(() => $('#url-dialog-input')?.focus(), 50);
        });
        $('#url-dialog-cancel')?.addEventListener('click', () => $('#url-dialog-overlay')?.classList.remove('visible'));
        $('#url-dialog-overlay')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) e.currentTarget.classList.remove('visible');
        });
        const urlInput = $('#url-dialog-input');
        if (urlInput) {
            urlInput.addEventListener('input', (e) => {
                this.addUrl = e.target.value;
            });
            urlInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.isComposing) this.addFromUrl();
            });
        }
        $('#url-dialog-ok')?.addEventListener('click', () => this.addFromUrl());

        $$('.seg-item').forEach((btn) => btn.addEventListener('click', () => this.switchTab(btn.dataset.tab)));

        for (const tab of REGISTRY_TABS) {
            const si = $(`[data-search-tab="${tab.id}"]`);
            if (si) {
                si.addEventListener('input', (e) => {
                    this.registryStates[tab.id].query = e.target.value;
                });
                si.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') this.searchRegistry(tab.id);
                });
            }
            $(`[data-search-btn="${tab.id}"]`)?.addEventListener('click', () => this.searchRegistry(tab.id));
            $(`[data-clear-tab="${tab.id}"]`)?.addEventListener('click', () => this.clearAndReload(tab.id));
        }

        // 已安装面板搜索
        const installedSi = $(`[data-search-tab="installed"]`);
        if (installedSi) {
            installedSi.addEventListener('input', (e) => {
                this.installedState.query = e.target.value;
            });
            installedSi.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') this._searchInstalled();
            });
        }
        $(`[data-search-btn="installed"]`)?.addEventListener('click', () => this._searchInstalled());
        $(`[data-clear-tab="installed"]`)?.addEventListener('click', () => this._clearInstalledSearch());
        $('#delete-all-btn')?.addEventListener('click', () => this._deleteAllSkills());

        $$('.install-btn').forEach((el) => {
            const url = el.getAttribute('data-install-url');
            const card = el.closest('.skill-card');
            const id = card?.getAttribute('data-skill-id');
            if (url && !el.disabled)
                el.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.installFromRegistry(url, id);
                });
        });

        $$('[data-registry-tab]').forEach((el) => {
            el.addEventListener('click', (e) => {
                if (e.target.closest('.install-btn')) return;
                const skillId = el.getAttribute('data-skill-id');
                const tabId = el.getAttribute('data-registry-tab');
                if (skillId && tabId) this.showRegistrySkillDetail(skillId, tabId);
            });
        });

        $$('[data-view-skill]').forEach((el) => {
            el.addEventListener('click', (e) => {
                if (e.target.closest('[data-delete]')) return;
                this.showSkillDetail(el.getAttribute('data-view-skill'));
            });
        });

        $$('[data-delete]').forEach((el) => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                this.deleteSkill(el.getAttribute('data-delete'));
            });
        });

        $$('[data-builtin-skill]').forEach((el) => {
            el.addEventListener('click', (e) => {
                if (e.target.closest('[data-delete]')) return;
                this.showBuiltinSkillDetail(el.getAttribute('data-builtin-skill'));
            });
        });
    }
}

customElements.define('skillmgr-entry-widget', SkillMgrEntryWidget);
