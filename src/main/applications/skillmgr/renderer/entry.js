/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { showConfirmModal, renderIcon, bindOverlayDismiss } from '../../../../renderer/components/confirmModal';
import { resolveRendererLocale } from '../../../../renderer/locale.js';
import { createTranslatorForSkillMgr } from '../locale/renderer.js';
import { showDuplicateInstallModal } from './duplicateInstallModal.js';
import { getSkillInitial, getSkillPastel } from '../../../../renderer/components/skills/skill-detail-card.ts';
import { OPENDESK_THEME_CHANGED } from '../../../../renderer/theme/theme-iframe-bridge.ts';
import { syncShadowHostTheme } from '../../../../renderer/theme/theme-shadow-overrides.ts';

async function getPathFromFile(file) {
    if (!file) return null;
    const path = await window.fsAPI.getFilePath(file);
    return path ? String(path).replace(/\\/g, '/') : null;
}

function getSkillsAPI() {
    if (typeof window.applicationAPI === 'undefined') return null;
    return {
        list: () => window.applicationAPI.call('list'),
        refresh: () => window.applicationAPI.call('refresh'),
        getSkillsDirectory: () => window.applicationAPI.call('getSkillsDirectory'),
        addFromDirectory: (sourceDirectory) => window.applicationAPI.callMainWorld('addFromDirectory', sourceDirectory),
        addFromZip: (zipPath, skillRelPath) => window.applicationAPI.callMainWorld('addFromZip', zipPath, skillRelPath),
        addFromUrl: (url) => window.applicationAPI.callMainWorld('addFromUrl', url),
        delete: (skillId) => window.applicationAPI.call('delete', skillId),
        deleteSkills: (skillIds, callback) => window.applicationAPI.streamCall('deleteSkills', callback, skillIds),
        getRegistries: () => window.applicationAPI.call('getRegistries'),
        searchRegistry: (registryId, query, page, limit, cursor, categoryFilter) =>
            window.applicationAPI.call('searchRegistry', registryId, query, page, limit, cursor, categoryFilter),
        installFromRegistry: (installUrl, force, customName) =>
            window.applicationAPI.callMainWorld('installFromRegistry', installUrl, force, customName),
        skillExists: (skillName) => window.applicationAPI.call('skillExists', skillName),
        getSkillDetail: (skillId) => window.applicationAPI.call('getSkillDetail', skillId),
        sendNotification: (type, title, message) =>
            window.applicationAPI.call('sendNotification', type, title, message),
        getBuiltinSkills: () => window.applicationAPI.callMainWorld('getBuiltinSkills'),
        scanDirectoryForSkills: (dirPath, callback) =>
            window.applicationAPI.streamCall('scanDirectoryForSkills', callback, dirPath),
        batchImportSkills: (skills, callback) =>
            window.applicationAPI.streamCall('batchImportSkills', callback, skills),
        getSkillStatus: (skillId) => window.applicationAPI.call('getSkillStatus', skillId),
        setSkillStatus: (skillId, enabled) => window.applicationAPI.call('setSkillStatus', skillId, enabled),
        removeFromBlacklist: (skillId) => window.applicationAPI.call('removeFromBlacklist', skillId),
        // 分析相关接口走主进程（callMainWorld）
        getAnalyzeStatus: () => window.applicationAPI.callMainWorld('getAnalyzeStatus'),
        analyzeSkillDependencies: (skillIds, concurrency) =>
            window.applicationAPI.callMainWorld('analyzeSkillDependencies', skillIds, concurrency),
        generateSkillTests: (skillIds, concurrency) =>
            window.applicationAPI.callMainWorld('generateSkillTests', skillIds, concurrency),
        runSkillTests: (skillIds, concurrency, options) =>
            window.applicationAPI.callMainWorld('runSkillTests', skillIds, concurrency, options),
        runUnpassedSkillTests: (skillIds, concurrency, options) =>
            window.applicationAPI.callMainWorld('runUnpassedSkillTests', skillIds, concurrency, options),
        runSingleSkillTest: (skillId, testCaseIndex, options) =>
            window.applicationAPI.callMainWorld('runSingleSkillTest', skillId, testCaseIndex, options),
        stopAnalysis: () => window.applicationAPI.callMainWorld('stopAnalysis'),
        getExistingSkillMetadatas: () => window.applicationAPI.callMainWorld('getExistingSkillMetadatas'),
        exportSkillMetadatas: (skillIds, zipFilePath, options) =>
            window.applicationAPI.callMainWorld('exportSkillMetadatas', skillIds, zipFilePath, options),
        importSkillMetadatas: (zipFilePath) => window.applicationAPI.callMainWorld('importSkillMetadatas', zipFilePath),
        exportAnalyzePage: (filePath, skillIds) =>
            window.applicationAPI.callMainWorld('exportAnalyzePage', filePath, skillIds),
        deleteSkillMetadatas: (skillIds) => window.applicationAPI.callMainWorld('deleteSkillMetadatas', skillIds),
        getAnalysisPrompts: () => window.applicationAPI.callMainWorld('getAnalysisPrompts'),
        saveAnalysisPrompts: (prompts) => window.applicationAPI.callMainWorld('saveAnalysisPrompts', prompts)
    };
}

import { escapeHtml } from '../../../../common/utils/escape.js';
import { mergeRegistryTabState } from './registry-tabs.js';
import { Marked, Renderer } from 'marked';
import markdownCSS from '../../../../renderer/styles/print-markdown.css?inline';
import {
    buildSelectedSkillTestReportPage,
    TEST_RESULTS_REPORT_MODAL_CLASS,
    TEST_RESULTS_REPORT_STYLE
} from './testResultsReportPage.js';

const marked = new Marked();
const testCaseMarkdownRenderer = new Renderer();
testCaseMarkdownRenderer.html = (token) => {
    const raw = typeof token === 'string' ? token : (token?.raw ?? token?.text ?? '');
    return escapeHtml(raw);
};
const testCaseMarked = new Marked({ renderer: testCaseMarkdownRenderer });

function renderTestCaseMarkdown(content) {
    return testCaseMarked.parse(content || '');
}

function formatDownloads(n) {
    if (!n || n <= 0) return '';
    if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + 'w';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
}

const DEFAULT_SLOGAN_KEY = 'renderer.skill.defaultSlogan';

const TEST_FAILURE_REASON_CATEGORY_KEYS = {
    misconfigured: 'renderer.skill.failure.misconfigured',
    dependency_runtime: 'renderer.skill.failure.dependencyRuntime',
    input_data: 'renderer.skill.failure.inputData',
    external_service: 'renderer.skill.failure.externalService',
    skill_implementation: 'renderer.skill.failure.skillImplementation'
};

const REGISTRY_TABS = [
    { id: 'matrix', label: 'OpenHarmony Matrix', icon: '🔷', sloganKey: 'renderer.skill.slogan.matrix' },
    { id: 'clawhub', label: 'ClawHub', icon: '🐾', sloganKey: 'renderer.skill.slogan.clawhub' },
    { id: 'skillhub', label: 'SkillHub', icon: '💎', sloganKey: 'renderer.skill.slogan.skillhub' },
    { id: 'modelscope', label: 'ModelScope', icon: '🔮', sloganKey: 'renderer.skill.slogan.modelscope' }
];

const STYLE = `
:host {
    display: flex; flex-direction: column; height: 100%;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', sans-serif;
    font-size: 13px; color: #1d1d1f; box-sizing: border-box;
    overflow: hidden; background: #fff;
    -webkit-font-smoothing: antialiased;
}
:host([data-theme="dark"]) {
    color-scheme: dark;
    background: #1e1e1e !important;
    color: #cccccc !important;
}
:host([data-theme="dark"]) .header-area {
    background: rgba(37, 37, 38, 0.95);
    border-bottom-color: rgba(255, 255, 255, 0.2);
}
:host([data-theme="dark"]) .header-title {
    color: #cccccc;
    -webkit-text-fill-color: #cccccc;
}
:host([data-theme="dark"]) .seg-control {
    background: #333333;
}
:host([data-theme="dark"]) .seg-scroll-btn {
    background: #333333;
    border-color: rgba(255, 255, 255, 0.2);
    color: #ababab;
}
:host([data-theme="dark"]) .seg-scroll-btn:hover {
    background: #3f3f46;
    color: #cccccc;
}
:host([data-theme="dark"]) .seg-item {
    color: rgba(255, 255, 255, 0.55);
}
:host([data-theme="dark"]) .seg-item.active {
    background: #252526;
    color: #fff;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
}
:host([data-theme="dark"]) .action-btn {
    background: #333333;
    border-color: rgba(255, 255, 255, 0.2);
    color: #cccccc;
}
:host([data-theme="dark"]) .search-input {
    background: #333333;
    border-color: rgba(255, 255, 255, 0.2);
    color: #cccccc;
}
:host([data-theme="dark"]) .search-input::placeholder {
    color: #9d9d9d;
}
:host([data-theme="dark"]) .skill-card {
    background: #252526;
    border-color: rgba(255, 255, 255, 0.18);
    color: #cccccc;
}
:host([data-theme="dark"]) .hero-title {
    color: #e4e4e4;
    -webkit-text-fill-color: #e4e4e4;
    background: none;
    background-clip: unset;
}
:host([data-theme="dark"]) .card-title,
:host([data-theme="dark"]) .detail-name,
:host([data-theme="dark"]) .empty-title {
    color: #e4e4e4;
}
:host([data-theme="dark"]) .card-author,
:host([data-theme="dark"]) .card-id,
:host([data-theme="dark"]) .empty-hint,
:host([data-theme="dark"]) .loading-state,
:host([data-theme="dark"]) .loading-more,
:host([data-theme="dark"]) .registry-msg {
    color: #ababab;
}
:host([data-theme="dark"]) .registry-filter-seg {
    background: #333333;
}
:host([data-theme="dark"]) .registry-filter-item {
    color: rgba(255, 255, 255, 0.55);
}
:host([data-theme="dark"]) .registry-filter-item.active {
    background: #252526; color: #fff;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
}
:host([data-theme="dark"]) .card-desc {
    color: #9d9d9d;
}
:host([data-theme="dark"]) .tag-score {
    background: #3f3f46;
    color: #ababab;
}
:host([data-theme="dark"]) .tag-star { background: rgba(251,191,36,0.15); color: #fcd34d; }
:host([data-theme="dark"]) .tag-download { background: rgba(96,165,250,0.15); color: #93c5fd; }
:host([data-theme="dark"]) .install-btn {
    background: rgba(96, 165, 250, 0.2);
    color: #93c5fd;
}
:host([data-theme="dark"]) .install-btn.installing {
    background: #333;
    color: #787878;
}
:host([data-theme="dark"]) .search-btn {
    background: #3b82f6;
    color: #fff;
}
:host([data-theme="dark"]) .btn {
    background: #333;
    border-color: rgba(255, 255, 255, 0.2);
    color: #ccc;
}
:host([data-theme="dark"]) .btn-primary {
    background: #3b82f6;
    color: #fff;
}
:host([data-theme="dark"]) .add-dropdown-item,
:host([data-theme="dark"]) .modal-dialog label,
:host([data-theme="dark"]) .modal-dialog input,
:host([data-theme="dark"]) .modal-dialog textarea {
    color: #ccc;
}
:host([data-theme="dark"]) .add-dropdown-item .item-hint {
    color: #787878;
}
:host([data-theme="dark"]) .add-dropdown-item .item-name {
    color: #e5e7eb;
}
:host([data-theme="dark"]) .add-dropdown-item:hover {
    background: rgba(255, 255, 255, 0.08);
}
:host([data-theme="dark"]) .add-dropdown-section + .add-dropdown-section {
    border-top-color: rgba(255, 255, 255, 0.1);
}
:host([data-theme="dark"]) .add-dropdown-item .icon.folder { background: rgba(91,141,239,0.18); }
:host([data-theme="dark"]) .add-dropdown-item .icon.zip { background: rgba(232,147,90,0.18); }
:host([data-theme="dark"]) .add-dropdown-item .icon.url,
:host([data-theme="dark"]) .add-dropdown-item .icon.import { background: rgba(76,175,110,0.18); }
:host([data-theme="dark"]) .search-clear,
:host([data-theme="dark"]) .analyze-filter-bar .search-clear {
    background: rgba(255,255,255,0.1);
    color: rgba(255,255,255,0.62);
}
:host([data-theme="dark"]) .search-clear:hover,
:host([data-theme="dark"]) .analyze-filter-bar .search-clear:hover {
    background: rgba(255,255,255,0.17);
    color: #fff;
}
:host([data-theme="dark"]) .add-dropdown,
:host([data-theme="dark"]) .modal-dialog,
:host([data-theme="dark"]) .detail-dialog {
    background: #252526;
    border-color: rgba(255, 255, 255, 0.2);
    color: #cccccc;
}
:host([data-theme="dark"]) .detail-header {
    border-bottom-color: rgba(255, 255, 255, 0.12);
}
:host([data-theme="dark"]) .detail-header-info .detail-id {
    color: #ababab;
}
:host([data-theme="dark"]) .detail-section-label {
    color: #9d9d9d;
}
:host([data-theme="dark"]) .detail-desc,
:host([data-theme="dark"]) .detail-body-content {
    color: #e4e4e4;
}
:host([data-theme="dark"]) .detail-body-content {
    background: #333333;
    border-color: rgba(255, 255, 255, 0.12);
}
:host([data-theme="dark"]) .detail-meta-item {
    background: #333333;
    border-color: rgba(255, 255, 255, 0.12);
    color: #cccccc;
}
:host([data-theme="dark"]) .detail-meta-item .meta-label {
    color: #9d9d9d;
}
:host([data-theme="dark"]) .detail-meta-item .meta-value {
    color: #e4e4e4;
}
:host([data-theme="dark"]) .detail-resource-tag {
    background: #3f3f46;
    color: #cccccc;
}
:host([data-theme="dark"]) .detail-close {
    background: #3f3f46;
    color: #cccccc;
}
:host([data-theme="dark"]) .detail-close:hover {
    background: #4a4a4d;
    color: #fff;
}
:host([data-theme="dark"]) .detail-footer {
    background: #252526;
    border-top-color: rgba(255, 255, 255, 0.12);
}
:host([data-theme="dark"]) .url-dialog-overlay,
:host([data-theme="dark"]) .detail-overlay {
    background: rgba(0, 0, 0, 0.55);
}
:host([data-theme="dark"]) .tab-panel::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.18);
}
:host([data-theme="dark"]) .tab-panel::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.28);
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
.add-dropdown-item .icon.import { background: #E7F6EA; color: #4CAF6E; }
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
    box-shadow: 0 1px 2px rgba(0,0,0,0.03);
    cursor: pointer; display: flex; flex-direction: column; gap: 8px;
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
.installed-card .card-footer { justify-content: space-between; }
.builtin-card .card-footer { justify-content: space-between; }
.external-card .card-footer { justify-content: flex-start; }

/* ── Toggle 开关 ── */
.skill-toggle {
    position: relative;
    width: 40px;
    height: 24px;
    flex-shrink: 0;
}
.skill-toggle input {
    opacity: 0;
    width: 0;
    height: 0;
    position: absolute;
}
.skill-toggle-slider {
    position: absolute;
    inset: 0;
    background: #D1D1D6;
    border-radius: 999px;
    cursor: pointer;
    transition: background 0.25s ease;
}
.skill-toggle-slider::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 20px;
    height: 20px;
    background: #fff;
    border-radius: 50%;
    box-shadow: 0 1px 3px rgba(0,0,0,0.15);
    transition: transform 0.25s ease;
}
.skill-toggle input:checked + .skill-toggle-slider {
    background: #34C759;
}
.skill-toggle input:checked + .skill-toggle-slider::after {
    transform: translateX(16px);
}

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

/* ── Registry Filter ── */
.registry-info-bar { display: flex; align-items: center; justify-content: center; gap: 16px; margin: 12px 0; }
.registry-info-bar .registry-msg { margin: 0; }
.registry-filter-seg {
    display: inline-flex;
    background: rgba(0, 0, 0, 0.04);
    border-radius: 8px; padding: 2px; gap: 2px;
}
.registry-filter-item {
    padding: 4px 12px; border-radius: 6px; border: none;
    background: transparent; color: rgba(0, 0, 0, 0.4);
    font-size: 11px; font-weight: 500; cursor: pointer;
    font-family: inherit; white-space: nowrap; flex-shrink: 0;
    line-height: 1.5; transition: background 0.2s, color 0.2s, box-shadow 0.2s;
}
.registry-filter-item:hover { color: rgba(0, 0, 0, 0.6); }
.registry-filter-item.active {
    background: #fff; color: #1d1d1f;
    box-shadow: 0 1px 3px rgba(0,0,0,0.06), 0 0.5px 1px rgba(0,0,0,0.03);
}

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

    /* ── Analyze Panel ── */
    .analyze-panel { height: 100%; display: flex; flex-direction: column; }
    .analyze-toolbar-area { flex-shrink: 0; padding: 16px 24px 0; }
    .analyze-scroll-area { flex: 1; overflow-y: auto; padding: 0 24px 60px; }
    .analyze-toolbar { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 16px; }
    .analyze-toolbar .tool-dropdown-anchor { position: relative; }
    .analyze-tool-btn {
        display: inline-flex; align-items: center; gap: 5px;
        padding: 7px 14px; border-radius: 8px; border: 1px solid rgba(0,0,0,0.08);
        background: #fff; color: #333; font-size: 12px; font-weight: 500;
        cursor: pointer; font-family: inherit; transition: all 0.15s; white-space: nowrap;
    }
    .analyze-tool-btn:hover { background: #f8f8f8; border-color: rgba(0,0,0,0.12); }
    .analyze-tool-btn svg { width: 14px; height: 14px; flex-shrink: 0; }
    .analyze-tool-dropdown {
        display: none; flex-direction: column;
        position: absolute; top: calc(100% + 4px); left: 0;
        min-width: 180px; background: #fff; border-radius: 10px;
        border: 1px solid rgba(0,0,0,0.06);
        box-shadow: 0 8px 28px -6px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.04);
        z-index: 9999; overflow: hidden; animation: dropdown-in 0.14s ease-out;
    }
    .analyze-tool-dropdown.visible { display: flex; }
    .analyze-tool-dropdown-item {
        width: 100%; padding: 9px 14px; border: none; background: transparent;
        text-align: left; font-size: 13px; color: #1d1d1f; font-family: inherit;
        cursor: pointer; transition: background 0.1s;
    }
    .analyze-tool-dropdown-item:hover { background: #f5f5f5; }
    .analyze-tool-dropdown-item + .analyze-tool-dropdown-item { border-top: 1px solid rgba(0,0,0,0.03); }

    /* ── Analyze filter bar (outside scroll area, never rebuilt) ── */
    .analyze-filter-bar {
        display: flex; align-items: center; gap: 10px;
        padding: 0 24px 12px;
    }
    .analyze-filter-bar .search-input-wrap { flex: 1; min-width: 0; position: relative; }
    .analyze-filter-bar .search-input {
        width: 100%; padding: 8px 34px 8px 14px;
        border: 1px solid rgba(0,0,0,0.08); border-radius: 9px;
        background: #FAFAFA; font-size: 13px; font-family: inherit;
        outline: none; transition: all 0.2s; color: #1d1d1f;
    }
    .analyze-filter-bar .search-input:focus { border-color: #8BB8F0; box-shadow: 0 0 0 3px rgba(90,140,240,0.08); background: #fff; }
    .analyze-filter-bar .search-input::placeholder { color: #bbb; }
    .analyze-filter-bar .search-clear {
        position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
        width: 18px; height: 18px; border-radius: 50%;
        background: rgba(0,0,0,0.06); border: none;
        color: rgba(0,0,0,0.35); font-size: 11px; line-height: 1;
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        transition: all 0.15s;
    }
    .analyze-filter-bar .search-clear:hover { background: rgba(0,0,0,0.1); color: rgba(0,0,0,0.55); }
    .analyze-select-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
    .analyze-select-btn {
        padding: 7px 13px; border-radius: 7px; border: 1px solid rgba(0,0,0,0.08);
        background: #fff; color: #555; font-size: 12px; font-weight: 500;
        cursor: pointer; font-family: inherit; transition: all 0.15s; white-space: nowrap;
    }
    .analyze-select-btn:hover { background: #f8f8f8; border-color: rgba(0,0,0,0.12); }
    .analyze-select-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .analyze-sort-wrap { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
    .analyze-sort-label { font-size: 12px; color: #999; }
    .analyze-sort-wrap select {
        padding: 7px 10px; border-radius: 7px; border: 1px solid rgba(0,0,0,0.08);
        background: #fff; color: #555; font-size: 12px; font-weight: 500;
        cursor: pointer; font-family: inherit; outline: none;
    }
    .analyze-sort-wrap select:focus { border-color: #8BB8F0; }

    /* ── Analyze list ── */
    .analyze-list { display: flex; flex-direction: column; gap: 3px; }
    .analyze-row {
        display: flex; align-items: center; gap: 10px;
        padding: 9px 12px; border-radius: 9px;
        border: 1px solid transparent; background: #fff;
        transition: all 0.15s; cursor: pointer;
    }
    .analyze-row:hover { background: #FAFAFA; border-color: rgba(0,0,0,0.04); }
    .analyze-row.selected { background: #EBF3FE; border-color: #D0E3FC; }
    .analyze-checkbox {
        width: 18px; height: 18px; border-radius: 5px;
        border: 1.5px solid rgba(0,0,0,0.2); background: #fff;
        cursor: pointer; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
        transition: all 0.15s; font-size: 11px; color: transparent;
    }
    .analyze-row.selected .analyze-checkbox {
        background: #5B8DEF; border-color: #5B8DEF; color: #fff;
    }
    .analyze-row-icon {
        width: 32px; height: 32px; border-radius: 8px;
        display: flex; align-items: center; justify-content: center;
        font-size: 13px; font-weight: 700; flex-shrink: 0;
    }
    .analyze-row-info { flex: 1; min-width: 0; }
    .analyze-row-name { font-size: 13px; font-weight: 600; color: #1d1d1f; line-height: 1.3; }
    .analyze-row-desc { font-size: 11px; color: #999; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .analyze-row-meta { font-size: 11px; color: #bbb; flex-shrink: 0; }

    /* ── Analyze pagination ── */
    .analyze-pagination {
        display: flex; align-items: center; justify-content: space-between;
        margin-top: 14px; padding-top: 12px; border-top: 1px solid rgba(0,0,0,0.04);
    }
    .analyze-pagination-info { font-size: 12px; color: #999; }
    .analyze-pagination-controls { display: flex; align-items: center; gap: 8px; }
    .analyze-pagination-controls select {
        padding: 5px 8px; border-radius: 6px; border: 1px solid rgba(0,0,0,0.1);
        background: #fff; font-size: 12px; font-family: inherit; color: #333; outline: none;
    }
    .analyze-pagination-controls .page-btn {
        padding: 5px 11px; border-radius: 6px; border: 1px solid rgba(0,0,0,0.08);
        background: #fff; color: #555; font-size: 12px; cursor: pointer;
        font-family: inherit; transition: all 0.15s;
    }
    .analyze-pagination-controls .page-btn:hover:not(:disabled) { background: #f8f8f8; }
    .analyze-pagination-controls .page-btn:disabled { opacity: 0.3; cursor: not-allowed; }
    .analyze-pagination-controls .page-num { font-size: 12px; color: #555; text-align: center; }
    .analyze-pagination-controls .page-jump-input {
        width: 42px; padding: 4px 4px; border-radius: 6px; border: 1px solid rgba(0,0,0,0.1);
        background: #fff; font-size: 12px; font-family: inherit; color: #333; text-align: center;
        outline: none; -moz-appearance: textfield;
    }
    .analyze-pagination-controls .page-jump-input::-webkit-inner-spin-button,
    .analyze-pagination-controls .page-jump-input::-webkit-outer-spin-button {
        -webkit-appearance: none; margin: 0;
    }
    .analyze-pagination-controls .page-jump-input:focus {
        border-color: rgba(0,0,0,0.25); box-shadow: 0 0 0 2px rgba(0,0,0,0.04);
    }

    /* ── Analyze empty state ── */
    .analyze-empty { display: flex; flex-direction: column; align-items: center; padding: 40px 20px; color: #999; }
    .analyze-empty .empty-icon { font-size: 32px; margin-bottom: 10px; opacity: 0.4; }
    .analyze-empty .empty-title { font-size: 14px; font-weight: 600; color: #1d1d1f; margin-bottom: 4px; }
    .analyze-empty .empty-hint { font-size: 12px; color: #999; }

    /* ── Analyze progress bar ── */
    .analyze-progress-bar-wrap {
        margin-bottom: 14px; padding: 10px 14px;
        background: #F8FAFD; border-radius: 10px;
        border: 1px solid rgba(91, 141, 239, 0.12);
    }
    .analyze-progress-label {
        display: flex; align-items: center; justify-content: space-between;
        margin-bottom: 6px;
    }
    .analyze-progress-title { font-size: 12px; color: #5B8DEF; font-weight: 500; }
    .analyze-progress-stats { font-size: 12px; color: #999; font-variant-numeric: tabular-nums; }
    .analyze-progress-bar {
        width: 100%; height: 4px; background: rgba(91, 141, 239, 0.12);
        border-radius: 2px; overflow: hidden;
    }
    .analyze-progress-fill {
        height: 100%; background: linear-gradient(90deg, #5B8DEF, #7DB0F3);
        border-radius: 2px; transition: width 0.4s ease;
    }
    .analyze-stop-btn {
        margin-top: 8px; padding: 5px 14px;
        border-radius: 6px; border: 1px solid rgba(224, 96, 96, 0.25);
        background: #fff; color: #E06060; font-size: 12px; font-weight: 500;
        cursor: pointer; font-family: inherit; transition: all 0.15s;
    }
    .analyze-stop-btn:hover { background: #FFF5F5; border-color: rgba(224, 96, 96, 0.4); }

    /* ── Analyze concurrency selector ── */
    .analyze-concurrency-wrap {
        display: flex; align-items: center; gap: 5px; margin-left: auto; flex-shrink: 0;
    }
    .analyze-concurrency-label {
        font-size: 12px; color: #999; font-weight: 500;
    }
    .analyze-concurrency-input {
        width: 44px; padding: 4px 6px; border: 1px solid rgba(0,0,0,0.1);
        border-radius: 6px; font-size: 12px; font-family: inherit; text-align: center;
        outline: none; color: #333; background: #fff;
        transition: border-color 0.15s;
    }
    .analyze-concurrency-input:focus { border-color: #8BB8F0; }
    .analyze-concurrency-input:disabled { opacity: 0.4; background: #f5f5f5; }

    /* ── Analyze row actions ── */
    .analyze-row-actions {
        display: flex; align-items: center; gap: 4px; flex-shrink: 0;
        margin-left: 8px;
    }
    .analyze-row-btn {
        height: 26px; border-radius: 6px; padding: 0 10px;
        border: 1px solid rgba(0,0,0,0.08); background: #fff;
        font-size: 12px; font-weight: 500; cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center;
        transition: all 0.15s; color: #555; font-family: inherit;
        white-space: nowrap;
    }
    .analyze-row-btn:hover { background: #f5f5f5; border-color: rgba(0,0,0,0.12); color: #333; }
    .analyze-row-action {
        font-size: 13px; flex-shrink: 0;
    }
    .analyze-row-waiting { opacity: 0.4; animation: pulse 1.5s infinite; }
    .analyze-row-error { color: #E06060; }
    .analyze-row-error-btn {
        color: #E06060 !important; border-color: rgba(224, 96, 96, 0.2) !important;
    }
    .analyze-row-error-btn:hover { background: #FFF5F5 !important; }
    .analyze-row-none { color: #ccc; font-size: 11px; }
    @keyframes pulse {
        0%, 100% { opacity: 0.3; }
        50% { opacity: 0.7; }
    }

    /* ── Analyze toolbar disabled ── */
    .analyze-tool-btn:disabled {
        opacity: 0.4; cursor: not-allowed;
    }
    .analyze-tool-dropdown-item:disabled {
        opacity: 0.4; cursor: not-allowed; pointer-events: none;
    }

    /* ── Analyze modal ── */
    .analyze-modal-overlay {
        display: none; position: fixed; inset: 0;
        background: rgba(0,0,0,0.3); z-index: 10001;
        align-items: center; justify-content: center;
        backdrop-filter: blur(6px); animation: fade-in 0.15s ease;
    }
    .analyze-modal-overlay.visible { display: flex; }
    .analyze-modal-dialog {
        background: #fff; border-radius: 16px;
        width: 620px; max-width: 90%; max-height: 75vh;
        box-shadow: 0 24px 80px -16px rgba(0,0,0,0.2);
        animation: dialog-in 0.2s ease-out;
        display: flex; flex-direction: column; overflow: hidden;
    }
    .analyze-modal-header {
        display: flex; align-items: center; gap: 12px;
        padding: 16px 24px; border-bottom: 1px solid rgba(0,0,0,0.06);
        flex-shrink: 0;
    }
    .analyze-modal-header.info { background: #EBF1FB; }
    .analyze-modal-banner-icon {
        width: 36px; height: 36px; border-radius: 10px; flex-shrink: 0;
        display: flex; align-items: center; justify-content: center;
        background: #4267B2;
    }
    .analyze-modal-banner-icon i { color: #fff; font-size: 16px; }
    .analyze-modal-banner-icon svg { width: 16px; height: 16px; color: #fff; }
    .analyze-modal-banner-text { flex: 1; min-width: 0; }
    .analyze-modal-header.info h3 {
        margin: 0; font-size: 15px; font-weight: 700; color: #1d1d1f;
    }
    .analyze-modal-close {
        width: 26px; height: 26px; border-radius: 7px;
        border: none; background: rgba(0,0,0,0.06);
        color: #555; cursor: pointer;
        display: flex; align-items: center; justify-content: center; flex-shrink: 0;
        transition: all 0.15s;
    }
    .analyze-modal-close svg { width: 14px; height: 14px; }
    .analyze-modal-close:hover { background: rgba(0,0,0,0.12); color: #333; }
    .analyze-modal-body {
        padding: 20px; overflow-y: auto; flex: 1 1 auto; min-height: 0;
    }
    .analyze-modal-footer {
        padding: 16px 20px; border-top: 1px solid rgba(0,0,0,0.06);
        display: flex; justify-content: flex-end; gap: 10px;
    }
    .analyze-modal-footer-btn {
        padding: 7px 16px; border-radius: 8px; border: none;
        font-size: 12.5px; font-weight: 600; cursor: pointer;
        font-family: inherit; transition: all 0.15s;
    }
    .analyze-modal-footer-btn.btn-cancel {
        background: rgba(0,0,0,0.04); color: #555;
    }
    .analyze-modal-footer-btn.btn-cancel:hover { background: rgba(0,0,0,0.08); }
    .analyze-modal-footer-btn.btn-danger {
        background: #E06060; color: #fff;
    }
    .analyze-modal-footer-btn.btn-danger:hover { background: #D94F4F; }
    .analyze-modal-section-title {
        font-size: 14px; font-weight: 600; color: #1d1d1f; margin-bottom: 14px;
    }
    .analyze-modal-subsection { margin-bottom: 16px; }
    .analyze-modal-subsection-title {
        font-size: 12px; font-weight: 600; color: #86868B; text-transform: uppercase;
        letter-spacing: 0.5px; margin-bottom: 8px;
    }
    .analyze-modal-table {
        width: 100%; border-collapse: collapse; font-size: 12px;
    }
    .analyze-modal-table th {
        text-align: left; padding: 6px 10px; color: #999; font-weight: 500;
        border-bottom: 1px solid rgba(0,0,0,0.04);
    }
    .analyze-modal-table td {
        padding: 7px 10px; border-bottom: 1px solid rgba(0,0,0,0.03);
        color: #333;
    }
    .analyze-modal-table code {
        font-family: 'SF Mono', 'Fira Code', monospace; font-size: 11px;
        background: #f5f5f5; padding: 2px 5px; border-radius: 4px;
    }
    .analyze-modal-empty {
        text-align: center; padding: 24px; color: #999; font-size: 13px;
    }

    /* ── Analyze modal dark mode ── */
    :host([data-theme="dark"]) .analyze-modal-overlay { background: rgba(0,0,0,0.45); }
    :host([data-theme="dark"]) .analyze-modal-dialog { background: #2A2826; }
    :host([data-theme="dark"]) .analyze-modal-header.info { background: rgba(122,162,232,0.16); }
    :host([data-theme="dark"]) .analyze-modal-banner-icon { background: #7AA2E8; }
    :host([data-theme="dark"]) .analyze-modal-header.info h3 { color: #e4e4e4; }
    :host([data-theme="dark"]) .analyze-modal-close { background: rgba(255,255,255,0.08); color: #ccc; }
    :host([data-theme="dark"]) .analyze-modal-close:hover { background: rgba(255,255,255,0.15); color: #fff; }
    :host([data-theme="dark"]) .analyze-modal-body { color: #ccc; }
    :host([data-theme="dark"]) .analyze-modal-section-title { color: #e4e4e4; }
    :host([data-theme="dark"]) .analyze-modal-subsection-title { color: #9d9d9d; }
    :host([data-theme="dark"]) .analyze-modal-table th { color: #9d9d9d; border-bottom-color: rgba(255,255,255,0.08); }
    :host([data-theme="dark"]) .analyze-modal-table td { color: #ccc; border-bottom-color: rgba(255,255,255,0.06); }
    :host([data-theme="dark"]) .analyze-modal-table code { background: #3f3f46; }
    :host([data-theme="dark"]) .analyze-modal-footer { border-top-color: rgba(255,255,255,0.12); }
    :host([data-theme="dark"]) .analyze-modal-footer-btn.btn-cancel { background: rgba(255,255,255,0.06); color: #ccc; }
    :host([data-theme="dark"]) .analyze-modal-footer-btn.btn-cancel:hover { background: rgba(255,255,255,0.12); }
    :host([data-theme="dark"]) .analyze-modal-footer-btn.btn-danger { background: #E85A5A; color: #fff; }
    :host([data-theme="dark"]) .analyze-modal-footer-btn.btn-danger:hover { background: #D04A4A; }
    :host([data-theme="dark"]) .analyze-modal-empty { color: #777; }

${TEST_RESULTS_REPORT_STYLE}

    /* ── Export options form ── */
    .export-options-form {
        display: flex; flex-direction: column; gap: 20px;
    }
    .export-option-row {
        display: flex; flex-direction: column; gap: 8px;
    }
    .export-option-label {
        font-size: 13px; font-weight: 600; color: #1d1d1f;
    }
    .export-option-checkbox,
    .export-option-radio {
        display: flex; align-items: center; gap: 8px;
        font-size: 13px; color: #333; cursor: pointer;
        user-select: none;
    }
    .export-option-checkbox input,
    .export-option-radio input {
        width: 16px; height: 16px; accent-color: #007AFF;
        flex-shrink: 0; cursor: pointer;
    }
    .export-option-disabled {
        opacity: 0.45; cursor: not-allowed;
    }
    .export-option-disabled input {
        cursor: not-allowed;
    }
    .export-option-radio-group {
        display: flex; flex-direction: column; gap: 8px;
        padding-left: 4px;
    }
    .analyze-modal-btn {
        padding: 8px 20px; border-radius: 8px; border: none;
        font-size: 13px; font-weight: 500; cursor: pointer;
        font-family: inherit; transition: all 0.15s;
    }
    .analyze-modal-btn-cancel {
        background: rgba(0,0,0,0.04); color: #555;
    }
    .analyze-modal-btn-cancel:hover { background: rgba(0,0,0,0.08); }
    .analyze-modal-btn-primary {
        background: #007AFF; color: #fff;
    }
    .analyze-modal-btn-primary:hover { background: #0066D6; }
    .analyze-modal-btn-primary:disabled {
        opacity: 0.45; cursor: not-allowed;
    }

    /* ── Prompt manager ── */
    .prompt-manager {
        display: flex; flex-direction: column; gap: 14px;
    }
    .prompt-tabs {
        display: flex; align-items: center; gap: 4px;
        padding: 3px; background: rgba(0,0,0,0.04); border-radius: 10px;
    }
    .prompt-tab-btn {
        flex: 1; min-width: 0; padding: 8px 10px;
        border: none; border-radius: 8px; background: transparent;
        color: rgba(0,0,0,0.5); font-size: 12px; font-weight: 500;
        font-family: inherit; cursor: pointer; transition: all 0.15s;
        white-space: nowrap;
    }
    .prompt-tab-btn:hover { color: rgba(0,0,0,0.7); }
    .prompt-tab-btn:disabled {
        opacity: 0.45; cursor: not-allowed;
    }
    .prompt-tab-btn.active {
        background: #fff; color: #1d1d1f;
        box-shadow: 0 1px 3px rgba(0,0,0,0.06), 0 0.5px 1px rgba(0,0,0,0.03);
    }
    .prompt-editor {
        display: flex; flex-direction: column; gap: 8px;
    }
    .prompt-editor-title {
        font-size: 13px; font-weight: 600; color: #1d1d1f;
    }
    .prompt-editor-hint {
        font-size: 12px; color: #86868B; line-height: 1.5;
    }
    .prompt-textarea {
        width: 100%; min-height: 260px; resize: vertical;
        padding: 12px 14px; border: 1px solid rgba(0,0,0,0.1);
        border-radius: 10px; background: #fff; color: #1d1d1f;
        font-size: 13px; line-height: 1.6; font-family: 'SF Mono', 'Cascadia Code', monospace;
        outline: none; transition: border-color 0.15s, box-shadow 0.15s;
    }
    .prompt-textarea:focus {
        border-color: #8BB8F0; box-shadow: 0 0 0 3px rgba(90,140,240,0.1);
    }
    .prompt-textarea:disabled {
        background: #F5F5F7; color: #86868B; cursor: not-allowed;
    }
    .prompt-loading {
        padding: 28px 0; color: #86868B; font-size: 13px; text-align: center;
    }

    /* ── Analyze modal accordion ── */
    .accordion-item {
        border: 1px solid rgba(0,0,0,0.05); border-radius: 10px;
        margin-bottom: 6px; overflow: hidden; background: #fff;
        transition: box-shadow 0.15s;
    }
    .accordion-item:hover { box-shadow: 0 1px 4px rgba(0,0,0,0.04); }
    .accordion-header {
        display: flex; align-items: center; gap: 8px;
        padding: 10px 14px; cursor: pointer; user-select: none;
        transition: background 0.1s;
    }
    .accordion-header:hover { background: #FAFAFA; }
    .accordion-arrow {
        font-size: 10px; color: #999; transition: transform 0.2s ease;
        flex-shrink: 0; width: 12px; text-align: center;
    }
    .accordion-index {
        font-size: 11px; font-weight: 600; color: #5B8DEF;
        background: #EBF3FE; padding: 2px 7px; border-radius: 4px;
        flex-shrink: 0;
    }
    .accordion-title {
        font-size: 13px; font-weight: 500; color: #1d1d1f;
        flex: 1; min-width: 0;
    }
    .accordion-body {
        padding: 4px 14px 14px; border-top: 1px solid rgba(0,0,0,0.03);
        animation: accordion-in 0.18s ease-out;
    }
    @keyframes accordion-in {
        from { opacity: 0; transform: translateY(-4px); }
        to { opacity: 1; transform: translateY(0); }
    }
    .accordion-field { margin-bottom: 10px; }
    .accordion-field:last-child { margin-bottom: 0; }
    .accordion-field .label {
        display: block; font-size: 11px; font-weight: 600; color: #86868B;
        text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 4px;
    }
    .accordion-field-error .label { color: #E06060; }
    .testcase-failure-category {
        display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
        margin-bottom: 8px;
    }
    .testcase-failure-category-label {
        font-size: 11px; font-weight: 500; color: #86868B;
    }
    .testcase-failure-category-chip {
        display: inline-flex; align-items: center; min-height: 20px;
        padding: 2px 8px; border-radius: 4px;
        background: #FFF5F5; border: 1px solid rgba(224,96,96,0.18);
        color: #B84C4C; font-size: 11px; font-weight: 500;
    }
    .analyze-goto-task-btn {
        display: inline-flex; align-items: center; gap: 4px;
        padding: 5px 12px; border-radius: 6px; border: 1px solid rgba(0,0,0,0.1);
        background: #f5f5f7; color: #333; font-size: 12px; cursor: pointer;
        font-family: inherit; transition: all 0.15s;
    }
    .analyze-goto-task-btn:hover { background: #e8e8ed; border-color: rgba(0,0,0,0.15); }
    .analyze-rerun-btn {
        display: inline-flex; align-items: center; gap: 4px;
        padding: 5px 12px; border-radius: 6px; border: 1px solid rgba(0,122,255,0.2);
        background: rgba(0,122,255,0.06); color: #007AFF; font-size: 12px; cursor: pointer;
        font-family: inherit; transition: all 0.15s;
    }
    .analyze-rerun-btn:hover { background: rgba(0,122,255,0.12); border-color: rgba(0,122,255,0.35); }
    .accordion-markdown {
        font-size: 13px; color: #333; line-height: 1.6;
    }
    .accordion-markdown p { margin: 0 0 6px; }
    .accordion-markdown p:last-child { margin-bottom: 0; }
    .accordion-markdown code {
        font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px;
        background: #f5f5f5; padding: 1px 4px; border-radius: 3px;
    }
    .accordion-markdown pre {
        background: #f8f8f8; border-radius: 6px; padding: 10px; overflow-x: auto;
        font-size: 12px; line-height: 1.5;
    }

    /* ── Analyze modal status labels ── */
    .analyze-modal-testcase-status {
        font-size: 11px; font-weight: 500; padding: 2px 8px; border-radius: 4px; flex-shrink: 0;
    }
    .analyze-modal-testcase-status.status-pending { background: #FFF7E0; color: #D4A028; }
    .analyze-modal-testcase-status.status-passed { background: #E7F6EA; color: #4CAF6E; }
    .analyze-modal-testcase-status.status-failed { background: #FDE9E9; color: #E06060; }
    .analyze-modal-testcase-status.status-skipped { background: #f5f5f5; color: #999; }

    /* ── Analyze modal error box ── */
    .analyze-modal-error-box {
        display: flex; gap: 12px; padding: 16px;
        background: #FFF5F5; border: 1px solid rgba(224, 96, 96, 0.2);
        border-radius: 10px;
    }
    .analyze-modal-error-icon { font-size: 20px; flex-shrink: 0; }
    .analyze-modal-error-msg {
        font-size: 13px; color: #333; line-height: 1.6; word-break: break-all;
    }

${markdownCSS}`;

class SkillMgrEntryWidget extends HTMLElement {
    constructor() {
        super();
        this._t = createTranslatorForSkillMgr();
        this._locale = undefined;
        this._settingUnsubscribe = null;
        this.skills = [];
        this.externalSkills = [];
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
        this._segScrollResizeObserver = null;
        this._promptLoadRequestId = 0;

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

        this.metaImport = {
            active: false,
            phase: 'importing', // 'importing' | 'complete'
            zipPath: '',
            result: null
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

        this.analyzeState = {
            sortBy: 'addedAt',
            query: '',
            page: 1,
            pageSize: 20,
            selected: new Set(),
            activeDropdown: null,
            filtered: [],
            concurrency: 5,
            timeoutMinutes: null,
            // Worker 分析状态
            workerStatus: null,
            // 模态弹窗
            modalVisible: false,
            modalTitle: '',
            modalContent: '',
            modalFooter: '',
            modalSkillId: null,
            modalExpandedTestCaseIndex: null,
            // 导出元数据选项
            exportOptions: {
                includeDependencies: true,
                includeTestCases: 'all',
                includeTestResults: true
            },
            promptActiveTab: 'dependencyAnalysis',
            prompts: {
                dependencyAnalysis: '',
                testGeneration: '',
                testRun: '',
                runtimeDependencyAnalysis: ''
            },
            promptSaving: false
        };

        // 分析状态轮询定时器
        this._analysisPollTimer = null;

        this.installedState = {
            query: '',
            page: 1,
            pageSize: 30,
            filtered: []
        };

        this.externalState = {
            query: '',
            page: 1,
            pageSize: 30
        };

        this.builtinState = {
            query: '',
            page: 1,
            pageSize: 30
        };

        this.registryStates = {};
        this._registryInfoRequestId = 0;
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
                autoLoaded: false,
                activeFilter: ''
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
            if (this.analyzeState && this.analyzeState.activeDropdown) {
                const anchors = this.shadowRoot.querySelectorAll('.tool-dropdown-anchor');
                let insideAny = false;
                anchors.forEach((a) => {
                    if (a.contains(e.composedPath()[0])) insideAny = true;
                });
                if (!insideAny) {
                    this.analyzeState.activeDropdown = null;
                    this._setAnalyzeDropdown(null);
                }
            }
        };
        this._onKeyDown = (e) => {
            if (e.key === 'Escape' && this.analyzeState?.modalVisible) {
                this._closeAnalyzeModal();
            }
        };
        this._onThemeChange = (e) => {
            syncShadowHostTheme(this, e.detail?.effective);
            const detailCard = this.shadowRoot?.getElementById('detail-overlay');
            if (detailCard && e.detail?.effective) detailCard.dataset.theme = e.detail.effective;
        };
    }

    async connectedCallback() {
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
        this.render();
        document.addEventListener(OPENDESK_THEME_CHANGED, this._onThemeChange);
        await Promise.all([this.loadSkills(), this._loadRegistryInfo(), this.loadBuiltinSkills()]);
        document.addEventListener('click', this._onDocClick, true);
        document.addEventListener('keydown', this._onKeyDown);
        this._autoLoadIfNeeded(this.activeTab);
        this._startAnalysisPolling();
        // 通过 applicationAPI.subscribe 监听技能/插件 registry 变更，
        // 收到通知后刷新已安装、内置技能和市场 registry 列表。
        try {
            this._skillsChangedSubscriptionId = await window.applicationAPI.subscribe('skillsChanged', () => {
                this.loadSkills();
                this.loadBuiltinSkills();
                // 插件启停也会发出 skillsChanged。技能窗口可能被桌面复用，
                // 因此不能只刷新技能列表，否则已停用的 registry tab 会继续保留。
                this._loadRegistryInfo();
            });
        } catch {
            // subscribe 失败不影响正常功能
        }
    }

    _applyLocaleSetting(setting) {
        this._locale = resolveRendererLocale(setting);
        this._t = createTranslatorForSkillMgr(setting);
    }

    /* 语言设置变化时重建翻译器并整体重渲染；打开中的弹窗原样保留（用户输入态） */
    _subscribeLocaleChanges() {
        if (this._settingUnsubscribe) return;
        const unsubscribe = window.settingAPI?.onSettingChanged?.((setting) => {
            if (!this.isConnected) return;
            if (resolveRendererLocale(setting) === this._locale) return;
            const openOverlay = this.shadowRoot?.querySelector('.detail-overlay, .bi-overlay, .analyze-modal-overlay');
            this._applyLocaleSetting(setting);
            this.render();
            if (openOverlay) this.shadowRoot?.appendChild(openOverlay);
        });
        if (typeof unsubscribe === 'function') {
            this._settingUnsubscribe = unsubscribe;
        }
    }

    disconnectedCallback() {
        if (this._settingUnsubscribe) {
            this._settingUnsubscribe();
            this._settingUnsubscribe = null;
        }
        document.removeEventListener('click', this._onDocClick, true);
        document.removeEventListener('keydown', this._onKeyDown);
        document.removeEventListener(OPENDESK_THEME_CHANGED, this._onThemeChange);
        // 移除技能列表变更监听
        if (this._skillsChangedSubscriptionId) {
            try {
                window.applicationAPI.unsubscribe('skillsChanged');
            } catch {}
            this._skillsChangedSubscriptionId = null;
        }
        this._stopAnalysisPolling();
        this._disconnectObservers();
        if (this._segScrollResizeObserver) {
            this._segScrollResizeObserver.disconnect();
            this._segScrollResizeObserver = null;
        }
    }

    /**
     * 启动分析状态轮询。每 1 秒查询一次 Worker 状态。
     */
    _startAnalysisPolling() {
        this._stopAnalysisPolling();
        this._analysisPollTimer = setInterval(async () => {
            try {
                const api = getSkillsAPI();
                if (!api?.getAnalyzeStatus) return;
                const status = await api.getAnalyzeStatus();
                if (!status) return;
                const wasRunning = this.analyzeState.workerStatus?.running;
                // 始终合并已有结果，后端实时结果优先
                const existingResults = this.analyzeState.workerStatus?.results || {};
                this.analyzeState.workerStatus = { ...status, results: { ...existingResults, ...status.results } };
                // 仅在状态变化时重新渲染，避免频繁重绘
                if (wasRunning !== status.running || status.running) {
                    if (wasRunning && !status.running) {
                        // 分析刚结束/被停止 → 全量渲染以刷新工具栏按钮状态（禁用 → 可用）
                        this.render();
                    } else {
                        this._updateAnalyzeScrollArea();
                    }
                }
            } catch {
                // 静默忽略轮询错误
            }
        }, 1000);
    }

    _stopAnalysisPolling() {
        if (this._analysisPollTimer) {
            clearInterval(this._analysisPollTimer);
            this._analysisPollTimer = null;
        }
    }

    /**
     * 仅更新分析面板的可滚动区域（不重建 toolbar DOM），避免下拉菜单闪烁。
     */
    _updateAnalyzeScrollArea() {
        const panel = this.shadowRoot.querySelector('#panel-analyze');
        if (!panel) return;
        if (this.activeTab !== 'analyze') return;

        const scrollArea = panel.querySelector('.analyze-scroll-area');
        if (!scrollArea) return;

        const state = this.analyzeState;
        const allSkills = [...this.skills];
        if (state.sortBy === 'name')
            allSkills.sort((a, b) =>
                (a.name || a.id || '').toLowerCase().localeCompare((b.name || b.id || '').toLowerCase())
            );
        const ws = state.workerStatus;
        const isAnalyzing = ws && ws.running;

        if (allSkills.length === 0) return;

        const q = state.query.trim().toLowerCase();
        const filtered = q
            ? allSkills.filter(
                  (s) =>
                      (s.name || '').toLowerCase().includes(q) ||
                      (s.id || '').toLowerCase().includes(q) ||
                      (s.description || '').toLowerCase().includes(q)
              )
            : allSkills;

        const totalPages = Math.ceil(filtered.length / state.pageSize) || 1;
        if (state.page > totalPages) state.page = totalPages;
        const start = (state.page - 1) * state.pageSize;
        const visible = filtered.slice(start, start + state.pageSize);
        const selectedCount = [...state.selected].filter((id) => filtered.some((s) => s.id === id)).length;

        // 进度条
        let progressHtml = '';
        if (isAnalyzing) {
            const pct = ws.total > 0 ? Math.round((ws.completed / ws.total) * 100) : 0;
            let taskLabel;
            if (ws.taskType === 'testrun') taskLabel = this._t('renderer.skill.analyze.task.testrun');
            else if (ws.taskType === 'testgen') taskLabel = this._t('renderer.skill.analyze.task.testgen');
            else taskLabel = this._t('renderer.skill.analyze.task.analyze');
            progressHtml = `
            <div class="analyze-progress-bar-wrap">
                <div class="analyze-progress-label">
                    <span class="analyze-progress-title">${taskLabel}</span>
                    <span class="analyze-progress-stats">${ws.completed} / ${ws.total}</span>
                </div>
                <div class="analyze-progress-bar">
                    <div class="analyze-progress-fill" style="width:${pct}%"></div>
                </div>
                <button type="button" class="analyze-stop-btn" data-analyze-stop>${ws.taskType === 'testrun' ? this._t('renderer.skill.analyze.stopTest') : this._t('renderer.skill.analyze.stopAnalyze')}</button>
            </div>`;
        }

        // 技能列表
        const listHtml =
            visible.length === 0
                ? `<div class="analyze-empty"><div class="empty-icon">🔍</div><div class="empty-title">${this._t('renderer.skill.analyze.noMatch')}</div><div class="empty-hint">${this._t('renderer.skill.empty.noMatchTry')}</div></div>`
                : `<div class="analyze-list">${visible
                      .map((s) => {
                          const color = this._getSkillPastel(s.name || s.id);
                          const isSelected = state.selected.has(s.id);
                          const skillResult = ws?.results?.[s.id];
                          const hasDeps =
                              skillResult?.dependencies &&
                              ((skillResult.dependencies.envVars && skillResult.dependencies.envVars.length > 0) ||
                                  (skillResult.dependencies.pythonPackages &&
                                      skillResult.dependencies.pythonPackages.length > 0) ||
                                  (skillResult.dependencies.npmPackages &&
                                      skillResult.dependencies.npmPackages.length > 0) ||
                                  (skillResult.dependencies.binaries && skillResult.dependencies.binaries.length > 0));
                          const hasTestCases = skillResult?.testCases && skillResult.testCases.length > 0;

                          let actionBtns = '';
                          if (skillResult) {
                              if (skillResult.error) {
                                  actionBtns = `<button type="button" class="analyze-row-btn analyze-row-error-btn" data-view-error="${escapeHtml(s.id)}">${this._t('renderer.skill.analyze.viewError')}</button>`;
                              } else {
                                  if (hasDeps) {
                                      actionBtns += `<button type="button" class="analyze-row-btn" data-view-deps="${escapeHtml(s.id)}">${this._t('renderer.skill.analyze.deps')}</button>`;
                                  }
                                  if (hasTestCases) {
                                      actionBtns += `<button type="button" class="analyze-row-btn" data-view-tests="${escapeHtml(s.id)}">${this._t('renderer.skill.analyze.testCases')}${escapeHtml(this._getTestCaseStats(skillResult))}</button>`;
                                  }
                                  if (!hasDeps && !hasTestCases) {
                                      actionBtns = `<span class="analyze-row-action analyze-row-none">—</span>`;
                                  }
                              }
                          } else if (isAnalyzing && isSelected) {
                              actionBtns = `<span class="analyze-row-action analyze-row-waiting">⏳</span>`;
                          }

                          if (!isSelected && !skillResult) {
                              actionBtns = `<span class="analyze-row-action analyze-row-none">—</span>`;
                          }

                          return `
                    <div class="analyze-row ${isSelected ? 'selected' : ''}" data-analyze-skill="${escapeHtml(s.id)}">
                        <span class="analyze-checkbox">${isSelected ? '✓' : ''}</span>
                        <span class="analyze-row-icon" style="background:${color.bg};color:${color.text}">${this._getSkillInitial(s.name || s.id)}</span>
                        <div class="analyze-row-info">
                            <div class="analyze-row-name">${escapeHtml(s.name || s.id)}</div>
                            ${s.description ? `<div class="analyze-row-desc">${escapeHtml(s.description)}</div>` : ''}
                        </div>
                        <span class="analyze-row-actions">${actionBtns}</span>
                    </div>`;
                      })
                      .join('')}</div>`;

        // 分页
        const pageSizeOptions = [10, 20, 30, 50];
        const paginationHtml = `
            <div class="analyze-pagination">
                <div class="analyze-pagination-info">${this._t('renderer.skill.analyze.totalSkills', { count: filtered.length })}${selectedCount > 0 ? this._t('renderer.skill.analyze.selectedSuffix', { count: selectedCount }) : ''}</div>
                <div class="analyze-pagination-controls">
                    <span style="font-size:12px;color:#999;">${this._t('renderer.skill.analyze.perPage')}</span>
                    <select data-analyze-page-size>
                        ${pageSizeOptions
                            .map((n) => `<option value="${n}" ${state.pageSize === n ? 'selected' : ''}>${n}</option>`)
                            .join('')}
                    </select>
                    <button type="button" class="page-btn" data-analyze-page="first" ${state.page <= 1 ? 'disabled' : ''}>${this._t('renderer.skill.analyze.page.first')}</button>
                    <button type="button" class="page-btn" data-analyze-page="prev" ${state.page <= 1 ? 'disabled' : ''}>${this._t('renderer.skill.analyze.page.prev')}</button>
                    <input type="number" class="page-jump-input" data-analyze-page-jump value="${state.page}" min="1" max="${totalPages}" />
                    <span class="page-num">/ ${totalPages}</span>
                    <button type="button" class="page-btn" data-analyze-page="next" ${state.page >= totalPages ? 'disabled' : ''}>${this._t('renderer.skill.analyze.page.next')}</button>
                    <button type="button" class="page-btn" data-analyze-page="last" ${state.page >= totalPages ? 'disabled' : ''}>${this._t('renderer.skill.analyze.page.last')}</button>
                </div>
            </div>`;

        // 更新 scroll area 内容（只含进度条、列表和分页，搜索框在外面不受影响）
        const scrollTop = scrollArea.scrollTop;
        scrollArea.innerHTML = `
            ${progressHtml}
            <div class="analyze-list-wrap">
                ${listHtml}
                ${filtered.length > 0 ? paginationHtml : ''}
            </div>
        `;
        scrollArea.scrollTop = scrollTop;

        // 更新筛选栏状态；筛选栏不在 scroll area 内，局部刷新时需要手动同步。
        const searchInput = panel.querySelector('[data-analyze-search]');
        if (searchInput && searchInput.value !== state.query) {
            searchInput.value = state.query;
        }
        const sortSelect = panel.querySelector('[data-analyze-sort]');
        if (sortSelect && sortSelect.value !== state.sortBy) {
            sortSelect.value = state.sortBy;
        }
        const selectAllBtn = panel.querySelector('[data-analyze-select-all]');
        if (selectAllBtn) {
            selectAllBtn.disabled = filtered.length === 0;
        }
        const selectPageBtn = panel.querySelector('[data-analyze-select-page]');
        if (selectPageBtn) {
            selectPageBtn.disabled = filtered.length === 0;
        }
        const deselectBtn = panel.querySelector('[data-analyze-deselect-all]');
        if (deselectBtn) {
            deselectBtn.disabled = selectedCount === 0;
            deselectBtn.textContent =
                selectedCount > 0
                    ? this._t('renderer.skill.analyze.deselectWithCount', { count: selectedCount })
                    : this._t('renderer.skill.analyze.deselect');
        }

        this._syncAnalyzeToolbarState(filtered, selectedCount);
        this._bindAnalyzeScrollAreaEvents();
    }

    async _loadRegistryInfo() {
        const requestId = ++this._registryInfoRequestId;
        try {
            const api = getSkillsAPI();
            if (!api?.getRegistries) return;
            const infos = await api.getRegistries();
            // 插件重载期间可能同时发起多次刷新；只应用最后一次快照，
            // 防止停用后的旧响应把已移除的 tab 恢复出来。
            if (requestId !== this._registryInfoRequestId) return;
            if (!Array.isArray(infos)) return;
            // 合并当前启用插件贡献的注册表 tab：新增追加，已消失的 tab 清除。
            const stateMerge = mergeRegistryTabState(REGISTRY_TABS, this.registryStates, this.activeTab, infos);
            this.activeTab = stateMerge.activeTab;
            for (const info of infos) {
                if (!this.registryStates[info.id]) {
                    this.registryStates[info.id] = {
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
                        autoLoaded: false,
                        activeFilter: ''
                    };
                }
            }
            this.render();
        } catch {}
    }

    _disconnectObservers() {
        if (this._scrollObservers) {
            this._scrollObservers.forEach((o) => o.disconnect());
            this._scrollObservers = [];
        }
        if (this._segScrollResizeObserver) {
            this._segScrollResizeObserver.disconnect();
            this._segScrollResizeObserver = null;
        }
    }

    async loadSkills() {
        const api = getSkillsAPI();
        if (!api) {
            this.error = this._t('renderer.skill.error.connect');
            this.render();
            return;
        }
        this.loading = true;
        this.error = null;
        this.render();
        try {
            const skills = await api.list();
            const normalizedSkills = Array.isArray(skills) ? skills : [];
            this.externalSkills = normalizedSkills.filter((s) => s?.source === 'config' || s?.readonly === true);
            this.skills = normalizedSkills.filter((s) => s?.source !== 'config' && s?.readonly !== true);
            const dir = await api.getSkillsDirectory();
            if (dir) this.skillsDir = dir;
            this.installedState.query = '';
            this.installedState.page = 1;
            this.externalState.query = '';
            this.externalState.page = 1;
        } catch (e) {
            this.error = e?.message || this._t('renderer.skill.error.load');
            this.skills = [];
            this.externalSkills = [];
        } finally {
            if (this.activeTab === 'external' && this.externalSkills.length === 0) this.activeTab = 'installed';
            this.loading = false;
            this.render();
        }
    }

    async loadBuiltinSkills() {
        const api = getSkillsAPI();
        if (!api) {
            this.builtinError = this._t('renderer.skill.error.connect');
            return;
        }
        this.builtinLoading = true;
        this.builtinError = null;
        try {
            this.builtinSkills = await api.getBuiltinSkills();
            if (!Array.isArray(this.builtinSkills)) this.builtinSkills = [];
        } catch (e) {
            this.builtinError = e?.message || this._t('renderer.skill.error.load');
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
            this.error = e?.message || this._t('renderer.skill.error.refresh');
            this.render();
        }
    }

    switchTab(tabId) {
        if (this.activeTab === tabId) return;
        this.activeTab = tabId;
        this.render();
        if (tabId !== 'installed' && tabId !== 'external' && tabId !== 'builtin' && tabId !== 'analyze')
            this._autoLoadIfNeeded(tabId);
        if (tabId === 'analyze') this._loadExistingMetadatas();
    }

    /**
     * 加载已有技能的 opendesk_meta.json，合并到 workerStatus.results 中。
     * 这样之前分析过的技能进入页面时就能直接看到依赖项按钮。
     */
    async _loadExistingMetadatas() {
        try {
            const api = getSkillsAPI();
            if (!api?.getExistingSkillMetadatas) return;
            const existing = await api.getExistingSkillMetadatas();
            if (!existing) return;
            // 合并到 workerStatus.results（已有分析结果优先）
            if (!this.analyzeState.workerStatus) {
                this.analyzeState.workerStatus = {
                    running: false,
                    total: 0,
                    completed: 0,
                    currentSkill: null,
                    results: {}
                };
            }
            const results = this.analyzeState.workerStatus.results || {};
            // 移除 results 中已不再存在的技能（对应元数据已被删除的情况）
            for (const skillId of Object.keys(results)) {
                if (!(skillId in existing)) {
                    delete results[skillId];
                }
            }
            for (const [skillId, meta] of Object.entries(existing)) {
                const current = results[skillId] || {};
                const next = { ...current };
                if (meta.dependencies) next.dependencies = meta.dependencies;
                if (meta.testCases) next.testCases = meta.testCases;
                // 文件中有有效数据时，清除之前分析失败产生的 error 状态
                if (meta.dependencies || meta.testCases) delete next.error;
                results[skillId] = next;
            }
            this.analyzeState.workerStatus.results = results;
            this._updateAnalyzeScrollArea();
        } catch {
            // 静默忽略
        }
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
                api.searchRegistry(tabId, state.query, nextPage, 30, state.nextCursor, state.activeFilter || undefined),
                new Promise((_, rej) =>
                    setTimeout(() => rej(new Error(this._t('renderer.skill.error.loadTimeout'))), 30000)
                )
            ]);
            state.page = nextPage;
            const newSkills = res?.skills ?? [];
            state.results = [...state.results, ...newSkills];
            state.hasMore = !!res?.hasMore;
            state.nextCursor = res?.nextCursor || null;
            state.total = res?.total ?? state.results.length;

            this._appendCards(tabId, newSkills);
        } catch (e) {
            state.message = { text: e?.message || this._t('renderer.skill.error.loadMore'), isError: true };
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
            const name = card?.getAttribute('data-skill-name');
            if (url && name)
                el.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.installFromRegistry(url, id, name);
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
            state.message = { text: this._t('renderer.skill.error.connect'), isError: true };
            this.render();
            return;
        }
        state.searching = true;
        state.message = null;
        if (page === 1) state.results = [];
        this.render();
        try {
            const res = await Promise.race([
                api.searchRegistry(tabId, query, page, 30, state.nextCursor, state.activeFilter || undefined),
                new Promise((_, rej) =>
                    setTimeout(() => rej(new Error(this._t('renderer.skill.error.searchTimeout'))), 30000)
                )
            ]);
            state.results = page === 1 ? (res?.skills ?? []) : [...state.results, ...(res?.skills ?? [])];
            state.total = res?.total ?? state.results.length;
            state.hasMore = !!res?.hasMore;
            state.nextCursor = res?.nextCursor || null;
            if (res?.error) state.message = { text: res.error, isError: true };
            else if (res?.message) state.message = { text: res.message, isError: false };
        } catch (e) {
            state.message = { text: e?.message || this._t('renderer.skill.error.searchFailed'), isError: true };
            if (page === 1) state.results = [];
        } finally {
            state.searching = false;
            state.hasSearched = true;
            this.render();
        }
    }

    async _resolveRegistryInstallConflict(skillName) {
        const result = await showDuplicateInstallModal({
            skillName,
            mountTarget: this.shadowRoot
        });
        if (result.action === 'overwrite') return { force: true, customName: undefined };
        if (result.action === 'install-new' && result.customName) {
            return { force: false, customName: result.customName };
        }
        return null;
    }

    getRegistryConflictSkillName(error) {
        const message = String(error?.message || error || '').replace(/^Error:\s*/, '');
        return message.match(/^技能「(.+?)」已存在(?:，.*)?$/)?.[1] || null;
    }

    async installFromRegistry(installUrl, skillId, skillName) {
        const api = getSkillsAPI();
        if (!installUrl || !skillName || !api?.installFromRegistry) return;
        let force = false;
        let customName = undefined;
        try {
            if (await api.skillExists(skillName)) {
                const conflict = await this._resolveRegistryInstallConflict(skillName);
                if (!conflict) return;
                ({ force, customName } = conflict);
            }
        } catch {
            // 前置检查仅用于提前展示交互，最终冲突仍由安装策略处理。
        }
        this.installingRegistryIds.add(skillId);
        this._updateInstallBtn(skillId, true);
        try {
            let addRes;
            try {
                addRes = await api.installFromRegistry(installUrl, force, customName);
            } catch (e) {
                const conflictSkillName = !force && !customName ? this.getRegistryConflictSkillName(e) : null;
                if (!conflictSkillName) throw e;
                const conflict = await this._resolveRegistryInstallConflict(conflictSkillName);
                if (!conflict) return;
                ({ force, customName } = conflict);
                addRes = await api.installFromRegistry(installUrl, force, customName);
            }
            const message = customName
                ? this._t('renderer.skill.install.installedAs', { name: customName })
                : force
                  ? this._t('renderer.skill.install.overwritten', { name: addRes?.name ?? '' })
                  : this._t('renderer.skill.install.doneWithName', { name: addRes?.name ?? '' });
            this._notify('info', this._t('renderer.skill.install.success'), message);
            await this.loadSkills();
        } catch (e) {
            this._notify(
                'error',
                this._t('renderer.skill.install.failed'),
                e?.message || this._t('renderer.skill.common.unknownError')
            );
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
            btn.innerHTML = `<span class="installing-dots"><span>.</span><span>.</span><span>.</span></span> ${this._t('renderer.skill.common.installing')}`;
            btn.classList.add('installing');
            if (!pw && card) {
                const b = document.createElement('div');
                b.className = 'progress-bar-wrap';
                b.innerHTML = '<div class="progress-bar-indeterminate"></div>';
                card.querySelector('.card-info')?.appendChild(b);
            }
        } else {
            btn.disabled = false;
            btn.textContent = this._t('renderer.skill.common.install');
            btn.classList.remove('installing');
            pw?.remove();
        }
    }

    _renderLoadingMore(tabId, show) {
        const el = this.shadowRoot.querySelector(`#loading-more-${tabId}`);
        if (el) el.style.display = show ? 'block' : 'none';
    }

    async onPathPicked(file) {
        const fp = await getPathFromFile(file);
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
            this._notify(
                'info',
                this._t('renderer.skill.install.success'),
                this._t('renderer.skill.install.added', { name: r?.name ?? '' })
            );
            await this.loadSkills();
        } catch (e) {
            this._notify(
                'error',
                this._t('renderer.skill.add.failed'),
                e?.message || this._t('renderer.skill.common.unknownError')
            );
        } finally {
            this.addingFromPath = false;
        }
    }

    async onZipPicked(file) {
        const p = await getPathFromFile(file);
        if (!p) return;
        const api = getSkillsAPI();
        if (!api?.addFromZip) return;
        this.addingFromZip = true;
        this.showAddDropdown = false;
        this._updateDropdown();
        try {
            const r = await api.addFromZip(p);
            this._notify(
                'info',
                this._t('renderer.skill.install.success'),
                this._t('renderer.skill.install.added', { name: r?.name ?? '' })
            );
            await this.loadSkills();
        } catch (e) {
            this._notify(
                'error',
                this._t('renderer.skill.add.failed'),
                e?.message || this._t('renderer.skill.common.unknownError')
            );
        } finally {
            this.addingFromZip = false;
        }
    }

    async addFromUrl() {
        const api = getSkillsAPI();
        const url = this.addUrl.trim();
        if (!api?.addFromUrl || !url) return;
        this.addingFromUrl = true;
        this.render();
        try {
            const r = await api.addFromUrl(url);
            this._notify(
                'info',
                this._t('renderer.skill.install.success'),
                this._t('renderer.skill.install.added', { name: r?.name ?? '' })
            );
            this.addUrl = '';
            await this.loadSkills();
        } catch (e) {
            this._notify(
                'error',
                this._t('renderer.skill.add.failed'),
                e?.message || this._t('renderer.skill.common.unknownError')
            );
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
            title: this._t('renderer.skill.delete.title'),
            message: this._t('renderer.skill.delete.confirm', { id: skillId }),
            confirmText: this._t('renderer.skill.common.delete'),
            cancelText: this._t('renderer.skill.common.cancel'),
            danger: true
        });
        if (!confirmed) return;

        this.deletingId = skillId;
        this.render();
        try {
            await api.delete(skillId);
            this._notify(
                'info',
                this._t('renderer.skill.delete.deleted.title'),
                this._t('renderer.skill.delete.deleted.message', { id: skillId })
            );
            await this.loadSkills();
        } catch (e) {
            this._notify(
                'error',
                this._t('renderer.skill.delete.failed'),
                e?.message || this._t('renderer.skill.common.unknownError')
            );
        } finally {
            this.deletingId = null;
            this.render();
        }
    }

    async _toggleSkillStatus(skillId, enabled) {
        const api = getSkillsAPI();
        if (!api?.setSkillStatus) return;
        try {
            await api.setSkillStatus(skillId, enabled);
            // 更新本地 skills 数组中的 enabled 状态
            const skill = this.skills.find((s) => s.id === skillId);
            if (skill) skill.enabled = enabled;
            // 也更新 builtinSkills 数组中的 enabled 状态
            const builtin = this.builtinSkills.find((s) => s.id === skillId);
            if (builtin) builtin.enabled = enabled;
            // 更新 toggle 的 title
            const toggle = this.shadowRoot.querySelector(`[data-toggle-id="${skillId}"]`);
            if (toggle) {
                toggle.title = enabled
                    ? this._t('renderer.skill.toggle.enableHint')
                    : this._t('renderer.skill.toggle.disableHint');
            }
            this._notify(
                'info',
                enabled ? this._t('renderer.skill.toggle.done.enable') : this._t('renderer.skill.toggle.done.disable'),
                this._t('renderer.skill.toggle.done.message', {
                    id: skillId,
                    action: enabled ? this._t('renderer.skill.common.enable') : this._t('renderer.skill.common.disable')
                })
            );
        } catch (e) {
            // 失败时恢复 toggle 状态
            const toggle = this.shadowRoot.querySelector(`[data-toggle-id="${skillId}"]`);
            if (toggle) toggle.checked = !enabled;
            this._notify(
                'error',
                this._t('renderer.skill.toggle.failed'),
                e?.message || this._t('renderer.skill.common.unknownError')
            );
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

    async showExternalSkillDetail(skillId) {
        const api = getSkillsAPI();
        if (!api) return;
        let detail;
        try {
            detail = await api.getSkillDetail(skillId);
        } catch {
            detail = null;
        }
        if (!detail) {
            const skill = this.externalSkills.find((s) => s.id === skillId);
            if (skill) detail = { ...skill, body: '', resources: { references: [], scripts: [], assets: [] } };
            else return;
        }
        this._renderDetailModal(detail, { isExternal: true });
    }

    showBuiltinSkillDetail(skillId) {
        const skill = this.builtinSkills.find((s) => s.id === skillId);
        if (!skill) return;
        const detail = {
            id: skill.id,
            name: skill.name,
            description: skill.description,
            bundleName: skill.bundleName,
            pluginId: skill.pluginId,
            pluginName: skill.pluginName,
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
            <div class="detail-section-label">${this._t('renderer.skill.detail.builtinTools', { count: tools.length })}</div>
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
                            <span class="toggle-icon">▶</span> ${this._t('renderer.skill.detail.params', { count: t.params.length })}
                           </button>
                           <div class="detail-tool-params" data-tool-params="${i}" style="display:none">
                             <div class="detail-tool-params-header">
                               <span>${this._t('renderer.skill.detail.paramName')}</span><span>${this._t('renderer.skill.detail.paramType')}</span><span>${this._t('renderer.skill.detail.paramRequired')}</span><span>${this._t('renderer.skill.deps.col.desc')}</span>
                             </div>
                             ${t.params
                                 .map(
                                     (p) => `
                               <div class="detail-tool-param">
                                 <span class="param-name">${escapeHtml(p.name)}</span>
                                 <span class="param-type">${escapeHtml(p.type)}</span>
                                 <span class="param-required ${p.required ? 'is-required' : 'is-optional'}">${p.required ? this._t('renderer.skill.detail.required') : this._t('renderer.skill.detail.optional')}</span>
                                 <span class="param-desc">${escapeHtml(p.description || '-')}</span>
                               </div>`
                                 )
                                 .join('')}
                           </div>`
                            : `<div class="detail-tool-no-params">${this._t('renderer.skill.detail.noParams')}</div>`
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
        const metaItems = [];
        if (detail.author) metaItems.push({ label: this._t('renderer.skill.detail.author'), value: detail.author });
        if (detail.source)
            metaItems.push({
                label: this._t('renderer.skill.detail.source'),
                value:
                    opts.isExternal && detail.source === 'config'
                        ? this._t('renderer.skill.detail.sourceExternal')
                        : detail.source
            });
        if (detail.bundleName)
            metaItems.push({ label: this._t('renderer.skill.detail.app'), value: detail.bundleName });
        if (detail.license) metaItems.push({ label: this._t('renderer.skill.detail.license'), value: detail.license });
        if (detail.compatibility)
            metaItems.push({ label: this._t('renderer.skill.detail.compatibility'), value: detail.compatibility });
        if (detail.allowedTools?.length)
            metaItems.push({
                label: this._t('renderer.skill.detail.allowedTools'),
                value: detail.allowedTools.join(', ')
            });
        if (detail.skillDir)
            metaItems.push({
                label: opts.isExternal
                    ? this._t('renderer.skill.detail.externalPath')
                    : this._t('renderer.skill.detail.installPath'),
                value: detail.skillDir
            });
        if (opts.isBuiltin && detail.directory)
            metaItems.push({ label: this._t('renderer.skill.detail.skillDir'), value: detail.directory });

        const res = detail.resources || {};
        const hasRes = (res.references?.length || 0) + (res.scripts?.length || 0) + (res.assets?.length || 0) > 0;
        const resourceHtml = hasRes
            ? `<div class="detail-section"><div class="detail-section-label">${this._t('renderer.skill.detail.resources')}</div><div class="detail-resources">${(res.references || []).map((r) => `<span class="detail-resource-tag">📄 ${escapeHtml(r.name || r)}</span>`).join('')}${(res.scripts || []).map((s) => `<span class="detail-resource-tag">📜 ${escapeHtml(s)}</span>`).join('')}${(res.assets || []).map((a) => `<span class="detail-resource-tag">🖼️ ${escapeHtml(a)}</span>`).join('')}</div></div>`
            : '';

        // 内置技能的工具列表
        const toolsHtml =
            opts.isBuiltin && detail.tools && detail.tools.length > 0 ? this._renderToolsList(detail.tools) : '';

        const downloadsStr = formatDownloads(detail.downloads);
        const statsPills =
            detail.stars || downloadsStr
                ? `<div style="display:flex;gap:6px;margin-top:4px">${detail.stars ? `<span class="tag-pill tag-star">★ ${detail.stars}</span>` : ''}${downloadsStr ? `<span class="tag-pill tag-download">↓ ${downloadsStr}</span>` : ''}</div>`
                : '';
        const pluginSkillOwner = detail.pluginName || detail.pluginId;
        const pluginSkillAttribution = pluginSkillOwner ? `${pluginSkillOwner}/${detail.name || detail.id}` : '';
        const headerAttribution =
            opts.isBuiltin && detail.bundleName
                ? `<div style="font-size:11px;color:#8e8e93;margin-top:2px">${escapeHtml(detail.bundleName)}</div>`
                : '';

        let actions;
        if (opts.isBuiltin || opts.isExternal) {
            actions = [{ id: 'close', label: this._t('renderer.skill.detail.done') }];
        } else if (opts.isInstalled) {
            actions = [
                { id: 'delete', label: this._t('renderer.skill.detail.deleteSkill'), variant: 'danger' },
                { id: 'close', label: this._t('renderer.skill.detail.done') }
            ];
        } else {
            actions = [{ id: 'close', label: this._t('renderer.skill.detail.close') }];
            if (opts.canInstall !== false) {
                actions.push({
                    id: 'install',
                    label: this._t('renderer.skill.detail.installSkill'),
                    variant: 'primary',
                    data: opts.installUrl || ''
                });
            }
        }

        const card = document.createElement('skill-detail-card');
        card.id = 'detail-overlay';
        card.dataset.theme = this.dataset.theme || document.documentElement.dataset.theme || 'light';
        card.model = {
            id: detail.id,
            name: detail.name || detail.id,
            subtitle: pluginSkillAttribution || undefined,
            closeLabel: this._t('renderer.skill.detail.close'),
            description: detail.description,
            descriptionLabel: this._t('renderer.skill.detail.descLabel'),
            bodyHtml: detail.body ? marked.parse(detail.body) : undefined,
            bodyLabel: this._t('renderer.skill.detail.contentLabel'),
            metadata: metaItems,
            metadataLabel: this._t('renderer.skill.detail.metadataLabel'),
            headerExtraHtml: `${opts.isBuiltin ? headerAttribution : ''}${statsPills}`,
            extraSectionsHtml: `${resourceHtml}${toolsHtml}`,
            actions
        };
        card.addEventListener('skill-detail-action', (event) => {
            const action = event.detail;
            this._removeDetailModal();
            if (action.id === 'delete') this.deleteSkill(detail.id);
            if (action.id === 'install' && action.data) this.installFromRegistry(action.data, detail.id, detail.name);
        });

        this.shadowRoot.appendChild(card);
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

    _searchBuiltin() {
        this.builtinState.page = 1;
        this.render();
    }

    _clearBuiltinSearch() {
        this.builtinState.query = '';
        this.builtinState.page = 1;
        this.render();
    }

    _searchExternal() {
        this.externalState.page = 1;
        this.render();
    }

    _clearExternalSearch() {
        this.externalState.query = '';
        this.externalState.page = 1;
        this.render();
    }

    _loadMoreExternal() {
        const state = this.externalState;
        const q = state.query.trim().toLowerCase();
        const filtered = q
            ? this.externalSkills.filter(
                  (s) =>
                      (s.name || '').toLowerCase().includes(q) ||
                      (s.id || '').toLowerCase().includes(q) ||
                      (s.description || '').toLowerCase().includes(q) ||
                      (s.skillDir || '').toLowerCase().includes(q)
              )
            : this.externalSkills;
        const visible = filtered.slice(0, state.page * state.pageSize);
        if (visible.length >= filtered.length) {
            const sentinel = this.shadowRoot.querySelector(`.scroll-sentinel[data-tab="external"]`);
            if (sentinel) sentinel.remove();
            return;
        }
        state.page++;
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
            <div style="background:#fff;border-radius:16px;width:420px;max-width:92vw;
                box-shadow:0 24px 80px rgba(0,0,0,0.18),0 0 1px rgba(0,0,0,0.1);
                animation:od-modal-scale-in 0.25s cubic-bezier(0.23,1,0.32,1);overflow:hidden;">
                <div style="display:flex;align-items:center;gap:12px;padding:16px 24px;background:#EBF1FB;border-bottom:1px solid rgba(0,0,0,0.06);">
                    <div style="width:36px;height:36px;border-radius:10px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:#4267B2;">
                        <i class="fa-solid fa-trash-can" style="color:#fff;font-size:16px;"></i>
                    </div>
                    <div style="flex:1;">
                        <div style="font-size:15px;font-weight:700;color:#1d1d1f;">${this._t('renderer.skill.delete.deleting')}</div>
                    </div>
                </div>
                <div style="padding:16px 24px;">
                    <div style="width:100%;height:6px;background:#F0F0F0;border-radius:3px;overflow:hidden;margin-bottom:10px;">
                        <div style="height:100%;background:linear-gradient(90deg,#DF4436,#F09090);border-radius:3px;transition:width 0.3s ease;width:${pct}%;"></div>
                    </div>
                    <div style="font-size:13px;color:#555;text-align:center;">${this._t('renderer.skill.delete.progress', { done: ds.deleted, total: ds.total })}${ds.failed > 0 ? this._t('renderer.skill.delete.progressFailed', { count: ds.failed }) : ''}</div>
                </div>
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
            title: this._t('renderer.skill.deleteAll.title'),
            message: this._t('renderer.skill.deleteAll.message', { count }),
            confirmText: this._t('renderer.skill.deleteAll.confirm'),
            cancelText: this._t('renderer.skill.common.cancel'),
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
        this._notify(
            'info',
            this._t('renderer.skill.deleteAll.done'),
            this._t('renderer.skill.deleteAll.summary', { deleted: deleted }) +
                (failed > 0 ? this._t('renderer.skill.deleteAll.failedSuffix', { count: failed }) : '')
        );
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
                        <div class="bi-title">${this._t('renderer.skill.batch.title')}</div>
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
                        <span>${this._t('renderer.skill.batch.scanning')}</span>
                        <span class="bi-progress-count">${this._t('renderer.skill.batch.scanFound', { count: bi.scanFound })}</span>
                    </div>
                    ${bi.scanTotal > 0 ? `<div class="bi-progress-text"><span></span><span class="bi-progress-pct">${progressPct}%</span></div>` : ''}
                </div>`;
        }
        if (bi.phase === 'results') {
            let listHtml;
            if (bi.skills.length === 0) {
                listHtml = `<div class="bi-empty-hint">${this._t('renderer.skill.batch.empty')}</div>`;
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
                        <span>${this._t('renderer.skill.batch.scanDone')}</span>
                        <span class="bi-progress-count">${this._t('renderer.skill.batch.scanTotal', { count: bi.scanFound })}</span>
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
                        <span>${this._t('renderer.skill.batch.importing')}</span>
                        <span class="bi-progress-count">${this._t('renderer.skill.batch.importProgress', { index: bi.importIndex, total: bi.importTotal })}${bi.importFailed > 0 ? this._t('renderer.skill.batch.importProgressFailed', { count: bi.importFailed }) : ''}</span>
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
                        <span style="color:#E06060;font-size:11px;flex:1;text-align:right;">${escapeHtml(e.message || this._t('renderer.skill.common.unknownError'))}</span>
                    </div>`;
                });
                // 如果有 skill 失败了但没记录到 importErrors（通过 catch 的），也要显示
                failedHtml = `
                    <div class="bi-progress-text" style="margin-top:12px;color:#E06060;">${this._t('renderer.skill.batch.failures')}</div>
                    <div class="bi-import-pending" style="max-height:180px;">${failedItems.join('')}</div>`;
            }
            return `
                <div class="bi-progress-section">
                    <div class="bi-progress-text">
                        <span>${this._t('renderer.skill.batch.importDone')}</span>
                        <span class="bi-progress-count" style="color:${bi.importFailed > 0 ? '#E06060' : '#4CAF6E'}">
                            ${this._t('renderer.skill.batch.importDoneSummary', { success: bi.importSuccess })}${bi.importFailed > 0 ? this._t('renderer.skill.batch.failedSuffix', { count: bi.importFailed }) : ''}
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
                <button type="button" class="btn btn-cancel" id="bi-cancel-btn">${this._t('renderer.skill.common.cancel')}</button>
            </div>`;
        }
        if (bi.phase === 'results') {
            return `<div class="batch-import-footer">
                <button type="button" class="btn btn-cancel" id="bi-cancel-btn">${this._t('renderer.skill.common.cancel')}</button>
                ${bi.skills.length > 0 ? `<button type="button" class="btn btn-primary" id="bi-confirm-btn">${this._t('renderer.skill.batch.confirmImport', { count: bi.skills.length })}</button>` : ''}
            </div>`;
        }
        if (bi.phase === 'importing') {
            return `<div class="batch-import-footer">
                <button type="button" class="btn btn-cancel" id="bi-stop-btn">${this._t('renderer.skill.batch.stop')}</button>
            </div>`;
        }
        if (bi.phase === 'complete') {
            return `<div class="batch-import-footer">
                <button type="button" class="btn btn-primary" id="bi-done-btn">${this._t('renderer.skill.common.done')}</button>
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

    // ── Meta Import Modal ──

    _renderMetaImportDialog() {
        const mi = this.metaImport;
        if (!mi.active) return '';

        if (mi.phase === 'importing') {
            return `
            <div class="batch-import-dialog">
                <div class="batch-import-header">
                    <div class="bi-icon" style="background:#EFF6FF;color:#2563EB;">📥</div>
                    <div>
                        <div class="bi-title">${this._t('renderer.skill.metaImport.title')}</div>
                        <div class="bi-subtitle">${escapeHtml(mi.zipPath || '')}</div>
                    </div>
                </div>
                <div class="batch-import-body">
                    <div class="bi-progress-section">
                        <div class="bi-progress-bar">
                            <div class="bi-progress-fill indeterminate"></div>
                        </div>
                        <div class="bi-progress-text">
                            <span>${this._t('renderer.skill.metaImport.importing')}</span>
                        </div>
                    </div>
                </div>
            </div>`;
        }

        if (mi.phase === 'complete') {
            const r = mi.result;
            if (!r) return '';

            let detailsHtml = '';
            if (r.details && r.details.length > 0) {
                detailsHtml = `
                    <div class="bi-skill-list" style="max-height:240px;">
                        ${r.details
                            .map(
                                (d) => `
                            <div class="bi-skill-item">
                                <span class="bi-skill-type" style="background:${d.status === 'success' ? '#EBF9EE' : d.status === 'skipped' ? '#FFF8E6' : '#FDEBEB'};color:${d.status === 'success' ? '#4CAF6E' : d.status === 'skipped' ? '#E8935A' : '#E06060'};">${d.status === 'success' ? '✓' : d.status === 'skipped' ? '⊘' : '✕'}</span>
                                <span class="bi-skill-name">${escapeHtml(d.skillName)}</span>
                                <span class="bi-skill-path" style="color:${d.status === 'success' ? '#4CAF6E' : '#999'};">${escapeHtml(d.message)}</span>
                            </div>`
                            )
                            .join('')}
                    </div>`;
            }

            const hasError = r.error && !r.success;
            return `
            <div class="batch-import-dialog">
                <div class="batch-import-header">
                    <div class="bi-icon" style="background:${hasError ? '#FDEBEB' : '#EBF9EE'};color:${hasError ? '#E06060' : '#4CAF6E'};">${hasError ? '❌' : '✅'}</div>
                    <div>
                        <div class="bi-title">${this._t(hasError ? 'renderer.skill.metaImport.failed.title' : 'renderer.skill.metaImport.done.title')}</div>
                        <div class="bi-subtitle">${escapeHtml(mi.zipPath || '')}</div>
                    </div>
                </div>
                <div class="batch-import-body">
                    <div class="bi-progress-section">
                        <div class="bi-progress-text">
                            <span>${hasError ? escapeHtml(r.error) : ''}</span>
                            <span class="bi-progress-count" style="color:${hasError ? '#E06060' : '#4CAF6E'}">
                                ${this._t('renderer.skill.metaImport.doneSummary', { success: r.successCount || 0 })}${r.failedCount > 0 ? this._t('renderer.skill.metaImport.failedSuffix', { count: r.failedCount }) : ''}${r.skippedCount > 0 ? this._t('renderer.skill.metaImport.skippedSuffix', { count: r.skippedCount }) : ''}
                            </span>
                        </div>
                    </div>
                    ${detailsHtml}
                </div>
                <div class="batch-import-footer">
                    <button type="button" class="btn btn-primary" id="mi-done-btn">${this._t('renderer.skill.common.done')}</button>
                </div>
            </div>`;
        }

        return '';
    }

    _openMetaImportModal(zipPath) {
        this.metaImport.active = true;
        this.metaImport.phase = 'importing';
        this.metaImport.zipPath = zipPath;
        this.metaImport.result = null;
        const overlay = this.shadowRoot.getElementById('meta-import-overlay');
        if (overlay) {
            overlay.innerHTML = this._renderMetaImportDialog();
            overlay.classList.add('visible');
            overlay._miDelegated = false;
        }
        this._bindMetaImportEvents();
    }

    _closeMetaImportModal() {
        const wasComplete = this.metaImport.phase === 'complete';
        this.metaImport.active = false;
        const overlay = this.shadowRoot.getElementById('meta-import-overlay');
        if (overlay) overlay.classList.remove('visible');
        // 导入完成后刷新分析面板
        if (wasComplete) {
            this._loadExistingMetadatas();
        }
    }

    _updateMetaImportModal() {
        const overlay = this.shadowRoot.getElementById('meta-import-overlay');
        if (!overlay || !this.metaImport.active) return;
        overlay.innerHTML = this._renderMetaImportDialog();
        overlay.classList.add('visible');
        overlay._miDelegated = false;
        this._bindMetaImportEvents();
    }

    _bindMetaImportEvents() {
        const overlay = this.shadowRoot.getElementById('meta-import-overlay');
        if (!overlay) return;

        if (overlay._miDelegated) return;
        overlay._miDelegated = true;

        bindOverlayDismiss(overlay, () => {
            if (this.metaImport.phase === 'complete') {
                this._closeMetaImportModal();
            }
        });

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) return;
            const btn = e.target.closest('button');
            if (!btn) return;
            const id = btn.id;
            if (id === 'mi-done-btn') this._closeMetaImportModal();
        });
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
            bindOverlayDismiss(overlay, () => {
                // 蒙层点击
                if (this.batchImport.phase === 'scanning' || this.batchImport.phase === 'results') {
                    this._closeBatchImportModal();
                }
            });
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) return;
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
                    this._notify(
                        'error',
                        this._t('renderer.skill.error.searchFailed'),
                        chunk.message || this._t('renderer.skill.common.unknownError')
                    );
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
            this._notify(
                'error',
                this._t('renderer.skill.error.searchFailed'),
                e?.message || this._t('renderer.skill.common.unknownError')
            );
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
        return getSkillInitial(name || '');
    }

    _getSkillPastel(name) {
        return getSkillPastel(name || '');
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
            <div class="skill-card" data-skill-id="${escapeHtml(s.id)}" data-skill-name="${escapeHtml(s.name)}" data-registry-tab="${tabId}">
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
                  ${s.score ? `<span class="tag-pill tag-score">${this._t('renderer.skill.analyze.matchScore', { score: typeof s.score === 'number' ? s.score.toFixed(2) : s.score })}</span>` : ''}
                </div>
                <button type="button" class="install-btn ${isInstalling ? 'installing' : ''}"
                  data-install-url="${escapeHtml(s.installUrl || '')}"
                  ${!s.canInstall || isInstalling ? 'disabled' : ''}>
                  ${isInstalling ? '<span class="installing-dots"><span>.</span><span>.</span><span>.</span></span> ' + this._t('renderer.skill.common.installing') : s.canInstall ? this._t('renderer.skill.common.install') : this._t('renderer.skill.tag.unavailable')}
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

        // 构建筛选滑块 HTML（仅当 registry 声明了 filters 时）
        const tabFilters = tabInfo?.filters;
        let filterHtml = '';
        if (tabFilters && tabFilters.length > 0) {
            filterHtml = tabFilters
                .map((f) => {
                    const isActive = state.activeFilter === f.categoryValue;
                    return `<div class="registry-filter-seg" data-filter-tab="${tabId}">
                    <button type="button" class="registry-filter-item ${!isActive ? 'active' : ''}" data-filter-value="">${escapeHtml(f.labelOff)}</button>
                    <button type="button" class="registry-filter-item ${isActive ? 'active' : ''}" data-filter-value="${escapeHtml(f.categoryValue)}">${escapeHtml(f.labelOn)}</button>
                </div>`;
                })
                .join('');
        }

        const infoBarHtml = msgHtml || filterHtml ? `<div class="registry-info-bar">${msgHtml}${filterHtml}</div>` : '';

        let contentHtml = '';
        if (state.searching && state.results.length === 0) {
            contentHtml = `<div class="loading-state"><div class="loading-spinner"></div><span>${this._t('renderer.skill.search.searching')}</span></div>`;
        } else if (state.hasSearched && state.results.length > 0) {
            if (isDefaultView) {
                const slogan = this._t(tabInfo?.sloganKey || DEFAULT_SLOGAN_KEY);
                contentHtml = `<div class="hero-title">${escapeHtml(slogan)}</div>`;
            }
            contentHtml += `<div class="skills-grid">${this._renderRegistryCards(state.results, tabId)}</div>`;
            if (state.hasMore) {
                contentHtml += `<div class="loading-more" id="loading-more-${tabId}" style="${state.loadingMore ? '' : 'display:none'}"><div class="loading-spinner" style="margin:0 auto 8px;width:20px;height:20px;"></div>${this._t('renderer.skill.common.loadingMore')}</div>`;
            }
            contentHtml += `<div class="scroll-sentinel" data-tab="${tabId}"></div>`;
        } else if (state.hasSearched) {
            contentHtml = `<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-title">${this._t('renderer.skill.empty.noMatch')}</div><div class="empty-hint">${this._t('renderer.skill.empty.noMatchTry')}</div></div>`;
        } else {
            contentHtml = `<div class="loading-state"><div class="loading-spinner"></div><span>${this._t('renderer.skill.common.loading')}</span></div>`;
        }

        return `
        <div class="registry-panel">
          <div class="search-bar">
            <div class="search-input-wrap">
              <input type="text" class="search-input" data-search-tab="${tabId}"
                placeholder="${this._t('renderer.skill.search.placeholder', { label: tabInfo?.label || '' })}"
                value="${escapeHtml(state.query)}" ${state.searching ? 'disabled' : ''} />
              <button type="button" class="search-clear" data-clear-tab="${tabId}" title="${this._t('renderer.skill.common.clearSearch')}">×</button>
            </div>
            <button type="button" class="search-btn" data-search-btn="${tabId}" ${state.searching ? 'disabled' : ''}>
              ${state.searching ? this._t('renderer.skill.search.searching') : this._t('renderer.skill.common.search')}
            </button>
          </div>
          ${infoBarHtml}${contentHtml}
        </div>`;
    }

    _renderInstalledPanel() {
        const state = this.installedState;
        if (this.loading)
            return `<div class="registry-panel"><div class="loading-state"><div class="loading-spinner"></div><span>${this._t('renderer.skill.common.loading')}</span></div></div>`;
        if (this.error)
            return `<div class="registry-panel"><div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-title">${escapeHtml(this.error)}</div></div></div>`;
        if (this.skills.length === 0)
            return `<div class="registry-panel"><div class="empty-state"><div class="empty-icon">📦</div><div class="empty-title">${this._t('renderer.skill.empty.installed')}</div><div class="empty-hint">${this._t('renderer.skill.empty.installedHint')}</div>${this.skillsDir ? `<code class="empty-dir">${escapeHtml(this.skillsDir)}</code>` : ''}</div></div>`;

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
            contentHtml = `<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-title">${this._t('renderer.skill.analyze.noMatch')}</div><div class="empty-hint">${this._t('renderer.skill.empty.noMatchTry')}</div></div>`;
        } else {
            const skillCount = this.skills.length;
            const heroHtml =
                !q && state.page === 1
                    ? `<div class="hero-title">${this._t('renderer.skill.count.installed', { count: skillCount })}</div>`
                    : '';
            contentHtml = `
                ${heroHtml}
                <div class="skills-grid">${visible
                    .map((s) => {
                        const color = this._getSkillPastel(s.name || s.id);
                        const isEnabled = s.enabled !== false;
                        const isBlacklisted = s.blacklisted === true;
                        const borderStyle = isBlacklisted
                            ? 'border:1.5px solid #DC2626;box-shadow:0 0 0 1px rgba(220,38,38,0.15);'
                            : '';
                        const blacklistHint =
                            isBlacklisted && s.blacklistEvidence ? escapeHtml(s.blacklistEvidence) : '';
                        return `
                <div class="skill-card installed-card" data-view-skill="${escapeHtml(s.id)}" style="${borderStyle}" title="${blacklistHint}">
                  <div class="card-header">
                    <div class="card-icon" style="background:${color.bg};color:${color.text}">${this._getSkillInitial(s.name || s.id)}</div>
                    <div class="card-info">
                      <div class="card-title">
                        ${escapeHtml(s.name || s.id || '')}
                        ${isBlacklisted ? `<span style="display:inline-block;font-size:10px;font-weight:600;color:#DC2626;background:#FEF2F2;border:1px solid #FECACA;border-radius:4px;padding:0 5px;margin-left:6px;vertical-align:middle;">${this._t('renderer.skill.badge.blacklist')}</span>` : ''}
                      </div>
                    </div>
                  </div>
                  ${s.description ? `<div class="card-desc">${escapeHtml(s.description)}</div>` : ''}
                  ${isBlacklisted && s.blacklistEvidence ? `<div style="font-size:11px;color:#DC2626;background:#FEF2F2;border-radius:6px;padding:6px 8px;margin-top:2px;line-height:1.4;border:1px solid #FECACA;">${escapeHtml(s.blacklistEvidence).slice(0, 200)}</div>` : ''}
                  <div class="card-footer">
                    <label class="skill-toggle" title="${isBlacklisted ? this._t('renderer.skill.toggle.blacklistHint') : isEnabled ? this._t('renderer.skill.toggle.enableHint') : this._t('renderer.skill.toggle.disableHint')}">
                      <input type="checkbox" data-toggle-id="${escapeHtml(s.id)}" ${isEnabled ? 'checked' : ''}>
                      <span class="skill-toggle-slider" style="${isBlacklisted ? 'opacity:0.4;' : ''}"></span>
                    </label>
                    <button type="button" class="btn btn-sm btn-danger" data-delete="${escapeHtml(s.id)}" ${this.deletingId === s.id ? 'disabled' : ''}>${this.deletingId === s.id ? '…' : this._t('renderer.skill.common.delete')}</button>
                  </div>
                </div>`;
                    })
                    .join('')}</div>`;
            if (hasMore) {
                contentHtml += `<div class="loading-more" id="loading-more-installed" style="display:none"><div class="loading-spinner" style="margin:0 auto 8px;width:20px;height:20px;"></div>${this._t('renderer.skill.common.loadingMore')}</div>`;
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
                placeholder="${this._t('renderer.skill.search.placeholder.installed')}"
                value="${escapeHtml(state.query)}" />
              <button type="button" class="search-clear" data-clear-tab="installed" title="${this._t('renderer.skill.common.clearSearch')}">×</button>
            </div>
            <button type="button" class="search-btn" data-search-btn="installed">${this._t('renderer.skill.common.search')}</button>
            <button type="button" class="btn btn-danger btn-sm" id="delete-all-btn" title="${this._t('renderer.skill.deleteAll.title')}" style="flex-shrink:0;white-space:nowrap;padding:10px 22px;border-radius:10px;border:none;background:#E06060;color:#fff;font-size:13px;font-weight:500;font-family:inherit;cursor:pointer;transition:all 0.15s;">${this._t('renderer.skill.deleteAll.confirm')}</button>
          </div>
          ${contentHtml}
        </div>`;
    }

    _renderExternalPanel() {
        const state = this.externalState;
        if (this.loading)
            return `<div class="registry-panel"><div class="loading-state"><div class="loading-spinner"></div><span>${this._t('renderer.skill.common.loading')}</span></div></div>`;
        if (this.error)
            return `<div class="registry-panel"><div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-title">${escapeHtml(this.error)}</div></div></div>`;
        if (this.externalSkills.length === 0)
            return `<div class="registry-panel"><div class="empty-state"><div class="empty-icon">🗂️</div><div class="empty-title">${this._t('renderer.skill.empty.external')}</div><div class="empty-hint">${this._t('renderer.skill.empty.externalHint')}</div></div></div>`;

        const q = state.query.trim().toLowerCase();
        const filtered = q
            ? this.externalSkills.filter(
                  (s) =>
                      (s.name || '').toLowerCase().includes(q) ||
                      (s.id || '').toLowerCase().includes(q) ||
                      (s.description || '').toLowerCase().includes(q) ||
                      (s.skillDir || '').toLowerCase().includes(q)
              )
            : this.externalSkills;

        const total = filtered.length;
        const visible = filtered.slice(0, state.page * state.pageSize);
        const hasMore = visible.length < total;

        let contentHtml;
        if (filtered.length === 0) {
            contentHtml = `<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-title">${this._t('renderer.skill.empty.noMatch')}</div><div class="empty-hint">${this._t('renderer.skill.empty.noMatchTry')}</div></div>`;
        } else {
            const externalCount = this.externalSkills.length;
            const heroHtml =
                !q && state.page === 1
                    ? `<div class="hero-title">${this._t('renderer.skill.count.external', { count: externalCount })}</div>`
                    : '';
            contentHtml = `
                ${heroHtml}
                <div class="skills-grid">${visible
                    .map((s) => {
                        const color = this._getSkillPastel(s.name || s.id);
                        return `
                <div class="skill-card external-card" data-external-skill="${escapeHtml(s.id)}">
                  <div class="card-header">
                    <div class="card-icon" style="background:${color.bg};color:${color.text}">${this._getSkillInitial(s.name || s.id)}</div>
                    <div class="card-info">
                      <div class="card-title">${escapeHtml(s.name || s.id || '')}</div>
                    </div>
                  </div>
                  ${s.description ? `<div class="card-desc">${escapeHtml(s.description)}</div>` : ''}
                  <div class="card-footer">
                    <div class="card-meta">
                      <span class="tag-pill tag-score">${this._t('renderer.skill.analyze.tag.external')}</span>
                    </div>
                  </div>
                </div>`;
                    })
                    .join('')}</div>`;
            if (hasMore) {
                contentHtml += `<div class="loading-more" id="loading-more-external" style="display:none"><div class="loading-spinner" style="margin:0 auto 8px;width:20px;height:20px;"></div>${this._t('renderer.skill.common.loadingMore')}</div>`;
                contentHtml += `<div class="scroll-sentinel" data-tab="external"></div>`;
            }
        }

        return `
        <div class="registry-panel">
          <div class="search-bar">
            <div class="search-input-wrap">
              <input type="text" class="search-input" data-search-tab="external"
                placeholder="${this._t('renderer.skill.search.placeholder.external')}"
                value="${escapeHtml(state.query)}" />
              <button type="button" class="search-clear" data-clear-tab="external" title="${this._t('renderer.skill.common.clearSearch')}">×</button>
            </div>
            <button type="button" class="search-btn" data-search-btn="external">${this._t('renderer.skill.common.search')}</button>
          </div>
          ${contentHtml}
        </div>`;
    }

    _renderBuiltinPanel() {
        if (this.builtinLoading)
            return `<div class="registry-panel"><div class="loading-state"><div class="loading-spinner"></div><span>${this._t('renderer.skill.common.loading')}</span></div></div>`;
        if (this.builtinError)
            return `<div class="registry-panel"><div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-title">${escapeHtml(this.builtinError)}</div></div></div>`;
        if (this.builtinSkills.length === 0)
            return `<div class="registry-panel"><div class="empty-state"><div class="empty-icon">🔌</div><div class="empty-title">${this._t('renderer.skill.empty.builtin')}</div><div class="empty-hint">${this._t('renderer.skill.empty.builtinHint')}</div></div></div>`;

        const state = this.builtinState;
        const q = state.query.trim().toLowerCase();
        const filtered = q
            ? this.builtinSkills.filter(
                  (s) =>
                      (s.name || '').toLowerCase().includes(q) ||
                      (s.id || '').toLowerCase().includes(q) ||
                      (s.description || '').toLowerCase().includes(q) ||
                      (s.pluginName || '').toLowerCase().includes(q) ||
                      (s.pluginId || '').toLowerCase().includes(q) ||
                      (s.bundleName || '').toLowerCase().includes(q)
              )
            : this.builtinSkills;

        let contentHtml;
        if (filtered.length === 0) {
            contentHtml = `<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-title">${this._t('renderer.skill.empty.noMatch')}</div><div class="empty-hint">${this._t('renderer.skill.empty.noMatchTry')}</div></div>`;
        } else {
            const builtinCount = this.builtinSkills.length;
            const heroHtml = !q
                ? `<div class="hero-title">${this._t('renderer.skill.count.builtin', { count: builtinCount })}</div>`
                : '';
            contentHtml = `
                ${heroHtml}
                <div class="skills-grid">${filtered
                    .map((s) => {
                        const color = this._getSkillPastel(s.name || s.id);
                        const toolCount = (s.tools && s.tools.length) || 0;
                        const isEnabled = s.enabled !== false;
                        const skillOwner = s.pluginName || s.pluginId || s.bundleName || '';
                        const scopeControl = s.readOnly
                            ? `<span class="tag-pill tag-score">${escapeHtml(s.bundleName || '')}</span>`
                            : `<label class="skill-toggle" title="${isEnabled ? this._t('renderer.skill.toggle.enableHint') : this._t('renderer.skill.toggle.disableHint')}">
                  <input type="checkbox" data-toggle-id="${escapeHtml(s.id)}" ${isEnabled ? 'checked' : ''}>
                  <span class="skill-toggle-slider"></span>
                </label>`;
                        return `
            <div class="skill-card builtin-card" data-builtin-skill="${escapeHtml(s.id)}">
              <div class="card-header">
                <div class="card-icon" style="background:${color.bg};color:${color.text}">${this._getSkillInitial(s.name || s.id)}</div>
                <div class="card-info">
                  <div class="card-title">${escapeHtml(s.name || s.id)}</div>
                  ${skillOwner ? `<div class="card-author">${escapeHtml(skillOwner)}${toolCount > 0 ? ' · ' + this._t('renderer.skill.analyze.toolCount', { count: toolCount }) : ''}</div>` : ''}
                </div>
              </div>
              ${s.description ? `<div class="card-desc">${escapeHtml(s.description)}</div>` : ''}
              <div class="card-footer">
                ${scopeControl}
                <span class="tag-pill tag-score">${this._t('renderer.skill.analyze.tag.builtin')}</span>
              </div>
            </div>`;
                    })
                    .join('')}</div>`;
        }

        return `
        <div class="registry-panel">
          <div class="search-bar">
            <div class="search-input-wrap">
              <input type="text" class="search-input" data-search-tab="builtin"
                placeholder="${this._t('renderer.skill.search.placeholder.builtin')}"
                value="${escapeHtml(state.query)}" />
              <button type="button" class="search-clear" data-clear-tab="builtin" title="${this._t('renderer.skill.common.clearSearch')}">×</button>
            </div>
            <button type="button" class="search-btn" data-search-btn="builtin">${this._t('renderer.skill.common.search')}</button>
          </div>
          ${contentHtml}
        </div>`;
    }

    _renderAnalyzePanel() {
        const state = this.analyzeState;
        const allSkills = [...this.skills];
        if (state.sortBy === 'name')
            allSkills.sort((a, b) =>
                (a.name || a.id || '').toLowerCase().localeCompare((b.name || b.id || '').toLowerCase())
            );
        const ws = state.workerStatus;
        const isAnalyzing = ws && ws.running;

        if (allSkills.length === 0) {
            return `<div class="analyze-panel"><div class="analyze-empty"><div class="empty-icon">📋</div><div class="empty-title">${this._t('renderer.skill.analyze.empty')}</div><div class="empty-hint">${this._t('renderer.skill.analyze.emptyHint')}</div></div></div>`;
        }

        const q = state.query.trim().toLowerCase();
        const filtered = q
            ? allSkills.filter(
                  (s) =>
                      (s.name || '').toLowerCase().includes(q) ||
                      (s.id || '').toLowerCase().includes(q) ||
                      (s.description || '').toLowerCase().includes(q)
              )
            : allSkills;

        const totalPages = Math.ceil(filtered.length / state.pageSize) || 1;
        if (state.page > totalPages) state.page = totalPages;
        const start = (state.page - 1) * state.pageSize;
        const visible = filtered.slice(start, start + state.pageSize);
        const selectedCount = [...state.selected].filter((id) => filtered.some((s) => s.id === id)).length;

        // 进度条 + 停止按钮 HTML
        let progressHtml = '';
        if (isAnalyzing) {
            const pct = ws.total > 0 ? Math.round((ws.completed / ws.total) * 100) : 0;
            let taskLabel;
            if (ws.taskType === 'testrun') taskLabel = this._t('renderer.skill.analyze.task.testrun');
            else if (ws.taskType === 'testgen') taskLabel = this._t('renderer.skill.analyze.task.testgen');
            else taskLabel = this._t('renderer.skill.analyze.task.analyze');
            progressHtml = `
            <div class="analyze-progress-bar-wrap">
                <div class="analyze-progress-label">
                    <span class="analyze-progress-title">${taskLabel}</span>
                    <span class="analyze-progress-stats">${ws.completed} / ${ws.total}</span>
                </div>
                <div class="analyze-progress-bar">
                    <div class="analyze-progress-fill" style="width:${pct}%"></div>
                </div>
                <button type="button" class="analyze-stop-btn" data-analyze-stop>${ws.taskType === 'testrun' ? this._t('renderer.skill.analyze.stopTest') : this._t('renderer.skill.analyze.stopAnalyze')}</button>
            </div>`;
        }

        // Toolbar definition
        const tools = [
            {
                id: 'analyze-deps',
                label: this._t('renderer.skill.analyze.menu.analyze'),
                icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M6.5 17.5L10.3 7M13.7 7l3.8 10.5M12 7v3"/></svg>',
                items: [
                    { id: 'analyze-deps-selected', label: this._t('renderer.skill.analyze.menu.analyzeSelected') },
                    { id: 'analyze-deps-all', label: this._t('renderer.skill.analyze.menu.analyzeAll') }
                ]
            },
            {
                id: 'gen-test',
                label: this._t('renderer.skill.analyze.menu.genTest'),
                icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 12l2 2 4-4"/></svg>',
                items: [
                    { id: 'gen-test-selected', label: this._t('renderer.skill.analyze.menu.genTestSelected') },
                    { id: 'gen-test-all', label: this._t('renderer.skill.analyze.menu.genTestAll') }
                ]
            },
            {
                id: 'run-test',
                label: this._t('renderer.skill.analyze.menu.runTest'),
                icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
                items: [
                    { id: 'run-test-selected', label: this._t('renderer.skill.analyze.menu.runTestSelected') },
                    { id: 'run-test-all', label: this._t('renderer.skill.analyze.menu.runTestAll') },
                    {
                        id: 'run-test-unpassed-selected',
                        label: this._t('renderer.skill.analyze.menu.runTestUnpassedSelected')
                    },
                    { id: 'run-test-unpassed-all', label: this._t('renderer.skill.analyze.menu.runTestUnpassedAll') }
                ]
            },
            {
                id: 'test-report',
                label: this._t('renderer.skill.analyze.menu.stats'),
                icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><rect x="7" y="11" width="3" height="6" rx="1"/><rect x="12" y="7" width="3" height="10" rx="1"/><rect x="17" y="4" width="3" height="13" rx="1"/></svg>',
                noDropdown: true,
                actionId: 'show-test-report'
            },
            {
                id: 'refresh-metadata',
                label: '',
                icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
                noDropdown: true,
                actionId: 'refresh-metadata'
            },
            {
                id: 'export',
                label: this._t('renderer.skill.analyze.menu.export'),
                icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
                items: [
                    { id: 'export-meta-selected', label: this._t('renderer.skill.analyze.menu.exportMetaSelected') },
                    { id: 'export-meta-all', label: this._t('renderer.skill.analyze.menu.exportMetaAll') },
                    { id: 'export-analyze-html', label: this._t('renderer.skill.analyze.menu.exportHtml') }
                ]
            },
            {
                id: 'import',
                label: this._t('renderer.skill.analyze.menu.import'),
                icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
                noDropdown: true,
                actionId: 'import-meta'
            },
            {
                id: 'prompts',
                label: this._t('renderer.skill.analyze.menu.prompts'),
                icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a4 4 0 0 1-4 4H7l-4 4V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/><path d="M8 9h8"/><path d="M8 13h6"/></svg>',
                noDropdown: true,
                actionId: 'manage-prompts'
            },
            {
                id: 'delete-meta',
                label: this._t('renderer.skill.analyze.menu.delete'),
                icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>',
                items: [
                    { id: 'delete-meta-selected', label: this._t('renderer.skill.analyze.menu.deleteMetaSelected') },
                    { id: 'delete-meta-all', label: this._t('renderer.skill.analyze.menu.deleteMetaAll') }
                ]
            }
        ];

        // 分析运行时禁用分析相关按钮
        const disabledTools = new Set(isAnalyzing ? ['analyze-deps', 'gen-test', 'run-test'] : []);

        // 未选中技能时禁用「选中技能」相关下拉项
        const selectedRequiredActions = new Set([
            'analyze-deps-selected',
            'gen-test-selected',
            'run-test-selected',
            'run-test-unpassed-selected',
            'show-test-report',
            'export-meta-selected',
            'delete-meta-selected'
        ]);

        const toolbarHtml = tools
            .map((tool) => {
                if (tool.noDropdown) {
                    const disabled =
                        disabledTools.has(tool.id) ||
                        (selectedRequiredActions.has(tool.actionId) && selectedCount === 0);
                    return `
                <div class="tool-dropdown-anchor">
                    <button type="button" class="analyze-tool-btn" data-analyze-action="${tool.actionId}" ${disabled ? 'disabled' : ''}>
                        ${tool.icon} ${tool.label}
                    </button>
                </div>`;
                }
                return `
                <div class="tool-dropdown-anchor">
                    <button type="button" class="analyze-tool-btn" data-analyze-tool="${tool.id}" ${disabledTools.has(tool.id) ? 'disabled' : ''}>
                        ${tool.icon} ${tool.label}
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:10px;height:10px;flex-shrink:0"><polyline points="6 9 12 15 18 9"/></svg>
                    </button>
                    <div class="analyze-tool-dropdown ${state.activeDropdown === tool.id ? 'visible' : ''}" data-analyze-dropdown="${tool.id}">
                        ${tool.items
                            .map(
                                (item) =>
                                    `<button type="button" class="analyze-tool-dropdown-item" data-analyze-action="${item.id}" ${disabledTools.has(tool.id) || (selectedRequiredActions.has(item.id) && selectedCount === 0) ? 'disabled' : ''}>${item.label}</button>`
                            )
                            .join('')}
                    </div>
                </div>`;
            })
            .join('');

        const listHtml =
            visible.length === 0
                ? `<div class="analyze-empty"><div class="empty-icon">🔍</div><div class="empty-title">${this._t('renderer.skill.analyze.noMatch')}</div><div class="empty-hint">${this._t('renderer.skill.empty.noMatchTry')}</div></div>`
                : `<div class="analyze-list">${visible
                      .map((s) => {
                          const color = this._getSkillPastel(s.name || s.id);
                          const isSelected = state.selected.has(s.id);
                          // 检查该技能的 Worker 分析结果
                          const skillResult = ws?.results?.[s.id];
                          const hasDeps =
                              skillResult?.dependencies &&
                              ((skillResult.dependencies.envVars && skillResult.dependencies.envVars.length > 0) ||
                                  (skillResult.dependencies.pythonPackages &&
                                      skillResult.dependencies.pythonPackages.length > 0) ||
                                  (skillResult.dependencies.npmPackages &&
                                      skillResult.dependencies.npmPackages.length > 0) ||
                                  (skillResult.dependencies.binaries && skillResult.dependencies.binaries.length > 0));
                          const hasTestCases = skillResult?.testCases && skillResult.testCases.length > 0;

                          // 操作按钮
                          let actionBtns = '';
                          if (skillResult) {
                              if (skillResult.error) {
                                  actionBtns = `<button type="button" class="analyze-row-btn analyze-row-error-btn" data-view-error="${escapeHtml(s.id)}">${this._t('renderer.skill.analyze.viewError')}</button>`;
                              } else {
                                  if (hasDeps) {
                                      actionBtns += `<button type="button" class="analyze-row-btn" data-view-deps="${escapeHtml(s.id)}">${this._t('renderer.skill.analyze.deps')}</button>`;
                                  }
                                  if (hasTestCases) {
                                      actionBtns += `<button type="button" class="analyze-row-btn" data-view-tests="${escapeHtml(s.id)}">${this._t('renderer.skill.analyze.testCases')}${escapeHtml(this._getTestCaseStats(skillResult))}</button>`;
                                  }
                                  if (!hasDeps && !hasTestCases) {
                                      actionBtns = `<span class="analyze-row-action analyze-row-none">—</span>`;
                                  }
                              }
                          } else if (isAnalyzing && isSelected) {
                              actionBtns = `<span class="analyze-row-action analyze-row-waiting">⏳</span>`;
                          }

                          if (!isSelected && !skillResult) {
                              actionBtns = `<span class="analyze-row-action analyze-row-none">—</span>`;
                          }

                          return `
                    <div class="analyze-row ${isSelected ? 'selected' : ''}" data-analyze-skill="${escapeHtml(s.id)}">
                        <span class="analyze-checkbox">${isSelected ? '✓' : ''}</span>
                        <span class="analyze-row-icon" style="background:${color.bg};color:${color.text}">${this._getSkillInitial(s.name || s.id)}</span>
                        <div class="analyze-row-info">
                            <div class="analyze-row-name">${escapeHtml(s.name || s.id)}</div>
                            ${s.description ? `<div class="analyze-row-desc">${escapeHtml(s.description)}</div>` : ''}
                        </div>
                        <span class="analyze-row-actions">${actionBtns}</span>
                    </div>`;
                      })
                      .join('')}</div>`;

        const pageSizeOptions = [10, 20, 30, 50];
        const paginationHtml = `
            <div class="analyze-pagination">
                <div class="analyze-pagination-info">${this._t('renderer.skill.analyze.totalSkills', { count: filtered.length })}${selectedCount > 0 ? this._t('renderer.skill.analyze.selectedSuffix', { count: selectedCount }) : ''}</div>
                <div class="analyze-pagination-controls">
                    <span style="font-size:12px;color:#999;">${this._t('renderer.skill.analyze.perPage')}</span>
                    <select data-analyze-page-size>
                        ${pageSizeOptions
                            .map((n) => `<option value="${n}" ${state.pageSize === n ? 'selected' : ''}>${n}</option>`)
                            .join('')}
                    </select>
                    <button type="button" class="page-btn" data-analyze-page="first" ${state.page <= 1 ? 'disabled' : ''}>${this._t('renderer.skill.analyze.page.first')}</button>
                    <button type="button" class="page-btn" data-analyze-page="prev" ${state.page <= 1 ? 'disabled' : ''}>${this._t('renderer.skill.analyze.page.prev')}</button>
                    <input type="number" class="page-jump-input" data-analyze-page-jump value="${state.page}" min="1" max="${totalPages}" />
                    <span class="page-num">/ ${totalPages}</span>
                    <button type="button" class="page-btn" data-analyze-page="next" ${state.page >= totalPages ? 'disabled' : ''}>${this._t('renderer.skill.analyze.page.next')}</button>
                    <button type="button" class="page-btn" data-analyze-page="last" ${state.page >= totalPages ? 'disabled' : ''}>${this._t('renderer.skill.analyze.page.last')}</button>
                </div>
            </div>`;

        const scrollAreaHtml = this._renderAnalyzeScrollArea(
            progressHtml,
            listHtml,
            paginationHtml,
            state,
            filtered,
            selectedCount
        );

        return `
        <div class="analyze-panel">
            <div class="analyze-toolbar-area">
                <div class="analyze-toolbar">
                    ${toolbarHtml}
                    <div class="analyze-concurrency-wrap">
                        <label class="analyze-concurrency-label">${this._t('renderer.skill.analyze.concurrency')}</label>
                        <input type="number" class="analyze-concurrency-input" data-analyze-concurrency
                            value="${state.concurrency}" min="1" max="10"
                            ${isAnalyzing ? 'disabled' : ''} />
                        <label class="analyze-concurrency-label">${this._t('renderer.skill.analyze.timeout')}</label>
                        <input type="number" class="analyze-concurrency-input" data-analyze-timeout-minutes
                            value="${state.timeoutMinutes ?? ''}" min="1" step="1" placeholder="${this._t('renderer.skill.analyze.timeoutPlaceholder')}"
                            ${isAnalyzing ? 'disabled' : ''} />
                    </div>
                </div>
            </div>
            ${scrollAreaHtml}
        </div>`;
    }

    /**
     * 仅渲染分析面板的可滚动区域（toolbar 以下部分）。
     * 用于轮询更新时局部刷新，避免重建 toolbar DOM 导致下拉菜单闪烁。
     */
    _renderAnalyzeScrollArea(progressHtml, listHtml, paginationHtml, state, filtered, selectedCount) {
        if (selectedCount === undefined) {
            selectedCount = [...state.selected].filter((id) => filtered.some((s) => s.id === id)).length;
        }
        return `
            <div class="analyze-filter-bar">
                <div class="search-input-wrap">
                    <input type="text" class="search-input" data-analyze-search
                        placeholder="${this._t('renderer.skill.search.placeholder.analyze')}"
                        value="${escapeHtml(state.query)}" />
                    <button type="button" class="search-clear" data-analyze-clear title="${this._t('renderer.skill.common.clearSearch')}">×</button>
                </div>
                <div class="analyze-sort-wrap">
                    <span class="analyze-sort-label">${this._t('renderer.skill.analyze.sort')}</span>
                    <select data-analyze-sort>
                        <option value="addedAt" ${state.sortBy === 'addedAt' ? 'selected' : ''}>${this._t('renderer.skill.analyze.sort.addedAt')}</option>
                        <option value="name" ${state.sortBy === 'name' ? 'selected' : ''}>${this._t('renderer.skill.analyze.sort.name')}</option>
                    </select>
                </div>
                <div class="analyze-select-actions">
                    <button type="button" class="analyze-select-btn" data-analyze-select-all ${filtered.length === 0 ? 'disabled' : ''}>${this._t('renderer.skill.analyze.selectAll')}</button>
                    <button type="button" class="analyze-select-btn" data-analyze-select-page ${filtered.length === 0 ? 'disabled' : ''}>${this._t('renderer.skill.analyze.selectAllPage')}</button>
                    <button type="button" class="analyze-select-btn" data-analyze-deselect-all ${selectedCount === 0 ? 'disabled' : ''}>${selectedCount > 0 ? this._t('renderer.skill.analyze.deselectWithCount', { count: selectedCount }) : this._t('renderer.skill.analyze.deselect')}</button>
                </div>
            </div>
            <div class="analyze-scroll-area">
                ${progressHtml}
                <div class="analyze-list-wrap">
                    ${listHtml}
                    ${filtered.length > 0 ? paginationHtml : ''}
                </div>
            </div>`;
    }

    render() {
        const scrollPositions = {};
        [
            ...REGISTRY_TABS.map((t) => `panel-${t.id}`),
            'panel-installed',
            'panel-external',
            'panel-builtin',
            'panel-analyze'
        ].forEach((id) => {
            const el = this.shadowRoot.querySelector(`#${id}`);
            if (el) scrollPositions[id] = el.scrollTop;
        });
        // 同时保存 analyze 面板内 .analyze-scroll-area 的滚动位置
        const analyzeScrollArea = this.shadowRoot.querySelector('#panel-analyze .analyze-scroll-area');
        const analyzeScrollTop = analyzeScrollArea ? analyzeScrollArea.scrollTop : 0;
        this._disconnectObservers();

        // 防止 innerHTML 替换期间出现白屏闪烁：在替换前设置宿主元素内联背景
        const effectiveTheme =
            this.dataset.theme ||
            document.documentElement.dataset.theme ||
            this.closest('[data-theme]')?.dataset?.theme ||
            'light';
        syncShadowHostTheme(this, effectiveTheme);
        const isDark = effectiveTheme === 'dark';
        this.style.backgroundColor = isDark ? '#1e1e1e' : '#fff';

        const skillCount = this.skills.length;
        const externalCount = this.externalSkills.length;
        const builtinCount = this.builtinSkills.length;
        if (this.activeTab === 'external' && externalCount === 0) this.activeTab = 'installed';
        const tabsHtml =
            REGISTRY_TABS.map(
                (t) =>
                    `<button type="button" class="seg-item ${this.activeTab === t.id ? 'active' : ''}" data-tab="${t.id}"><span class="seg-icon">${t.icon}</span> ${t.label}</button>`
            ).join('') +
            `<button type="button" class="seg-item ${this.activeTab === 'installed' ? 'active' : ''}" data-tab="installed"><span class="seg-icon">📦</span> ${this._t('renderer.skill.tab.installed')}${skillCount > 0 ? ` <span class="seg-badge">${skillCount}</span>` : ''}</button>` +
            (externalCount > 0
                ? `<button type="button" class="seg-item ${this.activeTab === 'external' ? 'active' : ''}" data-tab="external"><span class="seg-icon">🗂️</span> ${this._t('renderer.skill.tab.external')} <span class="seg-badge">${externalCount}</span></button>`
                : '') +
            `<button type="button" class="seg-item ${this.activeTab === 'builtin' ? 'active' : ''}" data-tab="builtin"><span class="seg-icon">⚙️</span> ${this._t('renderer.skill.tab.builtin')}${builtinCount > 0 ? ` <span class="seg-badge">${builtinCount}</span>` : ''}</button>` +
            `<button type="button" class="seg-item ${this.activeTab === 'analyze' ? 'active' : ''}" data-tab="analyze"><span class="seg-icon">🔬</span> ${this._t('renderer.skill.tab.analyze')}</button>`;

        const panelsHtml =
            REGISTRY_TABS.map(
                (t) =>
                    `<div class="tab-panel ${this.activeTab === t.id ? 'active' : ''}" id="panel-${t.id}">${this._renderRegistryPanel(t.id)}</div>`
            ).join('') +
            `<div class="tab-panel ${this.activeTab === 'installed' ? 'active' : ''}" id="panel-installed">${this._renderInstalledPanel()}</div>` +
            (externalCount > 0
                ? `<div class="tab-panel ${this.activeTab === 'external' ? 'active' : ''}" id="panel-external">${this._renderExternalPanel()}</div>`
                : '') +
            `<div class="tab-panel ${this.activeTab === 'builtin' ? 'active' : ''}" id="panel-builtin">${this._renderBuiltinPanel()}</div>` +
            `<div class="tab-panel ${this.activeTab === 'analyze' ? 'active' : ''}" id="panel-analyze">${this._renderAnalyzePanel()}</div>`;

        this.shadowRoot.innerHTML = `
        <style>${STYLE}</style>
        <div class="header-area">
            <div class="header-title">${this._t('app.name')}</div>
            <div class="seg-row">
                <button type="button" class="seg-scroll-btn seg-scroll-btn-left" aria-label="${this._t('renderer.skill.scrollLeft')}">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="15 18 9 12 15 6"></polyline>
                    </svg>
                </button>
                <div class="seg-control-container">
                    <div class="seg-control">${tabsHtml}</div>
                </div>
                <button type="button" class="seg-scroll-btn seg-scroll-btn-right" aria-label="${this._t('renderer.skill.scrollRight')}">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="9 18 15 12 9 6"></polyline>
                    </svg>
                </button>
                <div class="header-actions">
                    <button type="button" class="action-btn" id="refresh-btn" title="${this._t('renderer.skill.common.refresh')}" ${this.loading ? 'disabled' : ''}>↻</button>
                    <div class="add-dropdown-anchor">
                        <button type="button" class="action-btn" id="add-btn" title="${this._t('renderer.skill.action.add')}">+</button>
                        <div class="add-dropdown" id="add-dropdown">
                            <div class="add-dropdown-section">
                                <label class="add-dropdown-item ${this.addingFromPath ? 'disabled' : ''}">
                                    <input type="file" id="add-from-path-input" webkitdirectory directory style="display:none" ${this.addingFromPath ? 'disabled' : ''} />
                                    <span class="icon folder">📁</span>
                                    <span class="item-info"><span class="item-name">${this._t('renderer.skill.add.fromDir')}</span><span class="item-hint">${this._t('renderer.skill.add.fromDirHint')}</span></span>
                                </label>
                                <label class="add-dropdown-item ${this.addingFromZip ? 'disabled' : ''}">
                                    <input type="file" id="add-from-zip-input" accept=".zip" style="display:none" ${this.addingFromZip ? 'disabled' : ''} />
                                    <span class="icon zip">📦</span>
                                    <span class="item-info"><span class="item-name">${this._t('renderer.skill.add.fromZip')}</span><span class="item-hint">${this._t('renderer.skill.add.fromZipHint')}</span></span>
                                </label>
                                <button type="button" class="add-dropdown-item" id="batch-import-item">
                                    <span class="icon import">📥</span>
                                    <span class="item-info"><span class="item-name">${this._t('renderer.skill.add.batchImport')}</span><span class="item-hint">${this._t('renderer.skill.add.batchImportHint')}</span></span>
                                </button>
                            </div>
                            <div class="add-dropdown-section">
                                <button type="button" class="add-dropdown-item" id="add-url-item">
                                    <span class="icon url">🔗</span>
                                    <span class="item-info"><span class="item-name">${this._t('renderer.skill.add.fromUrl')}</span><span class="item-hint">${this._t('renderer.skill.add.fromUrlHint')}</span></span>
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
                <h3>${this._t('renderer.skill.url.title')}</h3>
                <div class="hint">${this._t('renderer.skill.url.hint')}</div>
                <input type="url" id="url-dialog-input" placeholder="https://..." value="${escapeHtml(this.addUrl)}" />
                <div class="dialog-actions">
                    <button type="button" class="btn" id="url-dialog-cancel">${this._t('renderer.skill.common.cancel')}</button>
                    <button type="button" class="btn btn-primary" id="url-dialog-ok" ${this.addingFromUrl ? 'disabled' : ''}>${this.addingFromUrl ? this._t('renderer.skill.common.installingDots') : this._t('renderer.skill.common.install')}</button>
                </div>
            </div>
        </div>
        <div class="batch-import-overlay" id="batch-import-overlay">
            ${this._renderBatchImportDialog()}
        </div>
        <div class="batch-import-overlay" id="meta-import-overlay">
            ${this._renderMetaImportDialog()}
        </div>
        <div class="analyze-modal-overlay ${this.analyzeState.modalVisible ? 'visible' : ''}" id="analyze-modal-overlay">
            <div class="analyze-modal-dialog ${this.analyzeState._modalType === 'testReport' ? TEST_RESULTS_REPORT_MODAL_CLASS : ''}">
                <div class="analyze-modal-header info">
                    <div class="analyze-modal-banner-icon">${renderIcon('fa-flask')}</div>
                    <div class="analyze-modal-banner-text"><h3>${escapeHtml(this.analyzeState.modalTitle)}</h3></div>
                    <button type="button" class="analyze-modal-close" id="analyze-modal-close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                </div>
                <div class="analyze-modal-body">${this.analyzeState.modalContent}</div>
                ${this.analyzeState.modalFooter ? `<div class="analyze-modal-footer">${this.analyzeState.modalFooter}</div>` : ''}
            </div>
        </div>`;

        this._bindEvents();
        Object.entries(scrollPositions).forEach(([id, top]) => {
            const el = this.shadowRoot.querySelector(`#${id}`);
            if (el) el.scrollTop = top;
        });
        // 恢复 analyze 面板内 .analyze-scroll-area 的滚动位置
        if (this.activeTab === 'analyze' && analyzeScrollTop > 0) {
            const newAnalyzeScrollArea = this.shadowRoot.querySelector('#panel-analyze .analyze-scroll-area');
            if (newAnalyzeScrollArea) newAnalyzeScrollArea.scrollTop = analyzeScrollTop;
        }
        this._bindScrollObservers();
        // innerHTML 会抹掉 Shadow 内的主题 <style>，每次重绘后须重新注入
        syncShadowHostTheme(this, effectiveTheme);
        // 清除 innerHTML 替换期间的临时内联背景色。延后一帧，避免当前帧露出默认白底。
        requestAnimationFrame(() => {
            if (this.dataset.theme === effectiveTheme) {
                this.style.backgroundColor = '';
            }
        });
    }

    // ----- Seg-control scroll -----

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
                        else if (tabId === 'external') this._loadMoreExternal();
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
        const urlDialogOverlay = $('#url-dialog-overlay');
        if (urlDialogOverlay) {
            // URL 输入弹窗属于表单类，禁用遮罩关闭防止误关丢失输入
            bindOverlayDismiss(urlDialogOverlay, () => urlDialogOverlay.classList.remove('visible'), undefined, false);
        }
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

        // 滚动按钮事件
        const segControl = $('.seg-control');
        const segLeftBtn = $('.seg-scroll-btn-left');
        const segRightBtn = $('.seg-scroll-btn-right');
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
        const segRow = $('.seg-row');
        if (segRow && segControl) {
            segRow.addEventListener('wheel', (e) => {
                if (Math.abs(e.deltaX) < Math.abs(e.deltaY)) {
                    e.preventDefault();
                    segControl.scrollBy({ left: e.deltaY, behavior: 'auto' });
                }
            });
        }

        // 初始化 seg-control 滚动观察器
        this._initSegScrollObserver();

        for (const tab of REGISTRY_TABS) {
            const si = $(`[data-search-tab="${tab.id}"]`);
            if (si) {
                si.addEventListener('input', (e) => {
                    this.registryStates[tab.id].query = e.target.value;
                });
                si.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !e.isComposing) this.searchRegistry(tab.id);
                });
            }
            $(`[data-search-btn="${tab.id}"]`)?.addEventListener('click', () => this.searchRegistry(tab.id));
            $(`[data-clear-tab="${tab.id}"]`)?.addEventListener('click', () => this.clearAndReload(tab.id));
        }

        // 注册源筛选滑块事件
        $$('.registry-filter-item').forEach((el) => {
            if (el._filterBound) return;
            el._filterBound = true;
            el.addEventListener('click', () => {
                const seg = el.closest('[data-filter-tab]');
                if (!seg) return;
                const tabId = seg.getAttribute('data-filter-tab');
                const filterValue = el.getAttribute('data-filter-value') || '';
                const state = this.registryStates[tabId];
                if (!state || state.activeFilter === filterValue) return;
                state.activeFilter = filterValue;
                state.page = 1;
                state.results = [];
                state.nextCursor = null;
                this._doSearch(tabId, state.query, 1);
            });
        });

        // 已安装面板搜索
        const installedSi = $(`[data-search-tab="installed"]`);
        if (installedSi) {
            installedSi.addEventListener('input', (e) => {
                this.installedState.query = e.target.value;
            });
            installedSi.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.isComposing) this._searchInstalled();
            });
        }
        $(`[data-search-btn="installed"]`)?.addEventListener('click', () => this._searchInstalled());
        $(`[data-clear-tab="installed"]`)?.addEventListener('click', () => this._clearInstalledSearch());
        $('#delete-all-btn')?.addEventListener('click', () => this._deleteAllSkills());

        // 外部技能面板搜索
        const externalSi = $(`[data-search-tab="external"]`);
        if (externalSi) {
            externalSi.addEventListener('input', (e) => {
                this.externalState.query = e.target.value;
            });
            externalSi.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.isComposing) this._searchExternal();
            });
        }
        $(`[data-search-btn="external"]`)?.addEventListener('click', () => this._searchExternal());
        $(`[data-clear-tab="external"]`)?.addEventListener('click', () => this._clearExternalSearch());

        // 内置技能面板搜索
        const builtinSi = $(`[data-search-tab="builtin"]`);
        if (builtinSi) {
            builtinSi.addEventListener('input', (e) => {
                this.builtinState.query = e.target.value;
            });
            builtinSi.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.isComposing) this._searchBuiltin();
            });
        }
        $(`[data-search-btn="builtin"]`)?.addEventListener('click', () => this._searchBuiltin());
        $(`[data-clear-tab="builtin"]`)?.addEventListener('click', () => this._clearBuiltinSearch());

        $$('.install-btn').forEach((el) => {
            const url = el.getAttribute('data-install-url');
            const card = el.closest('.skill-card');
            const id = card?.getAttribute('data-skill-id');
            const name = card?.getAttribute('data-skill-name');
            if (url && name)
                el.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.installFromRegistry(url, id, name);
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
                if (e.target.closest('.skill-toggle')) return;
                this.showSkillDetail(el.getAttribute('data-view-skill'));
            });
        });

        $$('[data-external-skill]').forEach((el) => {
            el.addEventListener('click', () => {
                this.showExternalSkillDetail(el.getAttribute('data-external-skill'));
            });
        });

        $$('[data-toggle-id]').forEach((el) => {
            el.addEventListener('change', async (e) => {
                const skillId = el.getAttribute('data-toggle-id');
                if (!skillId) return;
                // 如果是开启被拉黑的 skill，弹确认框
                if (el.checked) {
                    const skill =
                        this.skills.find((s) => s.id === skillId) || this.builtinSkills.find((s) => s.id === skillId);
                    if (skill?.blacklisted) {
                        const evidence = skill.blacklistEvidence || this._t('renderer.skill.blacklist.defaultEvidence');
                        const confirmed = await showConfirmModal({
                            icon: 'fa-shield-halved',
                            iconBg: '#FEF2F2',
                            iconColor: '#DC2626',
                            danger: true,
                            title: this._t('renderer.skill.blacklist.confirmTitle'),
                            message: `<div style="font-size:14px;color:#3C3C43;line-height:1.6;">${this._t('renderer.skill.blacklist.confirmPrefix', { name: escapeHtml(skill.name || skillId) })}</div>
<div style="font-size:13px;color:#DC2626;background:#FEF2F2;border-radius:8px;padding:10px;margin:10px 0;border:1px solid #FECACA;line-height:1.5;">${escapeHtml(evidence)}</div>
<div style="font-size:14px;color:#3C3C43;line-height:1.6;">${this._t('renderer.skill.blacklist.confirmSuffix')}</div>`,
                            confirmText: this._t('renderer.skill.blacklist.confirmEnable'),
                            cancelText: this._t('renderer.skill.common.cancel')
                        });
                        if (!confirmed) {
                            el.checked = false;
                            return;
                        }
                        // 用户确认：从黑名单移除。黑名单状态变更不只影响 enabled，
                        // 需重新拉取 list() 拿到 blacklisted=false 并重渲染卡片，
                        // 否则红边框/恶意skill标签/证据框等旧 DOM 不会刷新。
                        // 重渲染会重建 toggle，其 checked 依据 status.json（此刻仍是 false），
                        // 故 _toggleSkillStatus 落定 enabled=true 后需手动同步 toggle 的 checked 视觉。
                        const api = getSkillsAPI();
                        if (api?.removeFromBlacklist) {
                            await api.removeFromBlacklist(skillId);
                            await this.loadSkills();
                            await this._toggleSkillStatus(skillId, el.checked);
                            const newToggle = this.shadowRoot.querySelector(`[data-toggle-id="${skillId}"]`);
                            if (newToggle) newToggle.checked = el.checked;
                        }
                        return;
                    }
                }
                this._toggleSkillStatus(skillId, el.checked);
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
                if (e.target.closest('.skill-toggle')) return;
                this.showBuiltinSkillDetail(el.getAttribute('data-builtin-skill'));
            });
        });

        // ── Analyze panel events ──
        this._bindAnalyzeEvents();

        // Close dropdowns on outside click (handled globally via _onDocClick)
    }

    /**
     * 分析面板的工具栏、局部列表和弹窗事件分开绑定，避免局部刷新重复挂载持久 DOM 监听器。
     */
    _getAnalyzeSelectedRequiredActions() {
        return new Set([
            'analyze-deps-selected',
            'gen-test-selected',
            'run-test-selected',
            'run-test-unpassed-selected',
            'show-test-report',
            'export-meta-selected',
            'delete-meta-selected'
        ]);
    }

    _getAnalyzeFilteredSkills() {
        const q = this.analyzeState.query.trim().toLowerCase();
        const allSkills = [...this.skills];
        if (this.analyzeState.sortBy === 'name')
            allSkills.sort((a, b) =>
                (a.name || a.id || '').toLowerCase().localeCompare((b.name || b.id || '').toLowerCase())
            );
        return q
            ? allSkills.filter(
                  (s) =>
                      (s.name || '').toLowerCase().includes(q) ||
                      (s.id || '').toLowerCase().includes(q) ||
                      (s.description || '').toLowerCase().includes(q)
              )
            : allSkills;
    }

    _syncAnalyzeToolbarState(filteredSkills, selectedCount) {
        const filtered = filteredSkills || this._getAnalyzeFilteredSkills();
        const selected =
            selectedCount === undefined
                ? [...this.analyzeState.selected].filter((id) => filtered.some((s) => s.id === id)).length
                : selectedCount;
        const isAnalyzing = this.analyzeState.workerStatus?.running;
        const disabledTools = new Set(isAnalyzing ? ['analyze-deps', 'gen-test', 'run-test'] : []);
        const selectedRequiredActions = this._getAnalyzeSelectedRequiredActions();

        this.shadowRoot.querySelectorAll('[data-analyze-tool]').forEach((btn) => {
            const toolId = btn.getAttribute('data-analyze-tool');
            btn.disabled = disabledTools.has(toolId);
            if (btn.disabled && this.analyzeState.activeDropdown === toolId) {
                this.analyzeState.activeDropdown = null;
            }
        });

        this.shadowRoot.querySelectorAll('[data-analyze-action]').forEach((btn) => {
            const actionId = btn.getAttribute('data-analyze-action');
            const toolBtn = btn.closest('.tool-dropdown-anchor')?.querySelector('[data-analyze-tool]');
            const toolId = toolBtn?.getAttribute('data-analyze-tool');
            btn.disabled = disabledTools.has(toolId) || (selectedRequiredActions.has(actionId) && selected === 0);
        });

        this._setAnalyzeDropdown(this.analyzeState.activeDropdown);
    }

    _setAnalyzeDropdown(toolId) {
        this.analyzeState.activeDropdown = toolId;
        this.shadowRoot.querySelectorAll('[data-analyze-dropdown]').forEach((dropdown) => {
            dropdown.classList.toggle('visible', dropdown.getAttribute('data-analyze-dropdown') === toolId);
        });
        this.shadowRoot.querySelectorAll('[data-analyze-tool]').forEach((btn) => {
            btn.setAttribute('aria-expanded', btn.getAttribute('data-analyze-tool') === toolId ? 'true' : 'false');
        });
    }

    _closeAnalyzeModal() {
        if (this.analyzeState.promptSaving) return;
        if (this.analyzeState._modalType === 'prompts') {
            this._promptLoadRequestId++;
        }
        this.analyzeState.modalVisible = false;
        this.analyzeState.modalFooter = '';
        this.analyzeState._modalType = null;
        this.analyzeState.modalSkillId = null;
        this.analyzeState.modalExpandedTestCaseIndex = null;
        this.analyzeState.promptSaving = false;
        this._pendingDeleteSkillIds = null;
        this._pendingExportSkillIds = null;
        this._pendingExportActionId = null;
        this.render();
    }

    _bindAnalyzeEvents() {
        const $ = (sel) => this.shadowRoot.querySelector(sel);
        const $$ = (sel) => this.shadowRoot.querySelectorAll(sel);

        const analyzeSearch = $('[data-analyze-search]');
        if (analyzeSearch) {
            analyzeSearch.addEventListener('input', (e) => {
                this.analyzeState.query = e.target.value;
                this.analyzeState.page = 1;
                this._updateAnalyzeScrollArea();
            });
        }
        $('[data-analyze-clear]')?.addEventListener('click', () => {
            this.analyzeState.query = '';
            this.analyzeState.page = 1;
            this._updateAnalyzeScrollArea();
        });

        // Sort by
        $('[data-analyze-sort]')?.addEventListener('change', (e) => {
            this.analyzeState.sortBy = e.target.value;
            this.analyzeState.page = 1;
            this._updateAnalyzeScrollArea();
        });

        // Select all / deselect all
        $('[data-analyze-select-all]')?.addEventListener('click', () => {
            // 全选所有匹配的技能，而非仅当前页
            this._getAnalyzeFilteredSkills().forEach((s) => this.analyzeState.selected.add(s.id));
            this._updateAnalyzeScrollArea();
        });
        // Select current page
        $('[data-analyze-select-page]')?.addEventListener('click', () => {
            const filtered = this._getAnalyzeFilteredSkills();
            const state = this.analyzeState;
            const start = (state.page - 1) * state.pageSize;
            const visible = filtered.slice(start, start + state.pageSize);
            visible.forEach((s) => state.selected.add(s.id));
            this._updateAnalyzeScrollArea();
        });
        $('[data-analyze-deselect-all]')?.addEventListener('click', () => {
            // 取消全选所有已选技能
            this.analyzeState.selected.clear();
            this._updateAnalyzeScrollArea();
        });

        // Toolbar dropdown toggles
        $$('[data-analyze-tool]').forEach((btn) => {
            if (btn.dataset.analyzeToolBound === '1') return;
            btn.dataset.analyzeToolBound = '1';
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                // 禁用状态下不处理
                if (btn.disabled) return;
                const toolId = btn.getAttribute('data-analyze-tool');
                this._setAnalyzeDropdown(this.analyzeState.activeDropdown === toolId ? null : toolId);
            });
        });

        // Toolbar dropdown items
        $$('[data-analyze-action]').forEach((btn) => {
            if (btn.dataset.analyzeActionBound === '1') return;
            btn.dataset.analyzeActionBound = '1';
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (btn.disabled) return;
                const actionId = btn.getAttribute('data-analyze-action');
                this._setAnalyzeDropdown(null);
                this._handleAnalyzeAction(actionId);
            });
        });

        // Concurrency input
        $('[data-analyze-concurrency]')?.addEventListener('change', (e) => {
            const val = parseInt(e.target.value, 10);
            if (val >= 1 && val <= 10) {
                this.analyzeState.concurrency = val;
            } else {
                e.target.value = this.analyzeState.concurrency;
            }
        });

        // Timeout input (minutes)
        $('[data-analyze-timeout-minutes]')?.addEventListener('change', (e) => {
            const raw = e.target.value.trim();
            if (raw === '') {
                this.analyzeState.timeoutMinutes = null;
                return;
            }
            const val = Number(raw);
            if (Number.isFinite(val) && val > 0) {
                this.analyzeState.timeoutMinutes = val;
            } else {
                e.target.value = this.analyzeState.timeoutMinutes ?? '';
            }
        });

        this._syncAnalyzeToolbarState();
        this._bindAnalyzeScrollAreaEvents();
        this._bindAnalyzeModalEvents();
    }

    _bindAnalyzeScrollAreaEvents() {
        const root = this.shadowRoot.querySelector('#panel-analyze .analyze-scroll-area');
        if (!root) return;
        const $ = (sel) => root.querySelector(sel);
        const $$ = (sel) => root.querySelectorAll(sel);

        // Checkbox toggle — 仅点击复选框区域时切换选中状态
        $$('[data-analyze-skill]').forEach((el) => {
            const checkbox = el.querySelector('.analyze-checkbox');
            if (checkbox) {
                checkbox.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const skillId = el.getAttribute('data-analyze-skill');
                    if (this.analyzeState.selected.has(skillId)) {
                        this.analyzeState.selected.delete(skillId);
                    } else {
                        this.analyzeState.selected.add(skillId);
                    }
                    this._updateAnalyzeScrollArea();
                });
            }
            // 行点击（排除按钮、复选框）：打开技能详情
            el.addEventListener('click', (e) => {
                if (e.target.closest('button') || e.target.closest('select') || e.target.closest('.analyze-checkbox'))
                    return;
                const skillId = el.getAttribute('data-analyze-skill');
                this.showSkillDetail(skillId);
            });
        });

        // Stop analysis button
        $('[data-analyze-stop]')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
                const api = getSkillsAPI();
                await api?.stopAnalysis?.();
            } catch (err) {
                console.error('[SkillMgr] stopAnalysis failed:', err);
            }
        });

        // View dependencies / test cases buttons
        $$('[data-view-deps]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const skillId = btn.getAttribute('data-view-deps');
                this._showDependenciesModal(skillId);
            });
        });
        $$('[data-view-tests]').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const skillId = btn.getAttribute('data-view-tests');
                if (!skillId) return;
                await this._loadExistingMetadatas();
                this._showTestCasesModal(skillId);
            });
        });
        $$('[data-view-error]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const skillId = btn.getAttribute('data-view-error');
                this._showErrorModal(skillId);
            });
        });

        // Pagination
        $('[data-analyze-page="first"]')?.addEventListener('click', () => {
            this.analyzeState.page = 1;
            this._updateAnalyzeScrollArea();
        });
        $('[data-analyze-page="prev"]')?.addEventListener('click', () => {
            if (this.analyzeState.page > 1) {
                this.analyzeState.page--;
                this._updateAnalyzeScrollArea();
            }
        });
        $('[data-analyze-page="next"]')?.addEventListener('click', () => {
            const filtered = this._getAnalyzeFilteredSkills();
            const totalPages = Math.ceil(filtered.length / this.analyzeState.pageSize) || 1;
            if (this.analyzeState.page < totalPages) {
                this.analyzeState.page++;
                this._updateAnalyzeScrollArea();
            }
        });
        $('[data-analyze-page="last"]')?.addEventListener('click', () => {
            const filtered = this._getAnalyzeFilteredSkills();
            const totalPages = Math.ceil(filtered.length / this.analyzeState.pageSize) || 1;
            this.analyzeState.page = totalPages;
            this._updateAnalyzeScrollArea();
        });
        const jumpInput = $('[data-analyze-page-jump]');
        if (jumpInput) {
            const doJump = () => {
                const filtered = this._getAnalyzeFilteredSkills();
                const totalPages = Math.ceil(filtered.length / this.analyzeState.pageSize) || 1;
                let v = parseInt(jumpInput.value, 10);
                if (isNaN(v) || v < 1) v = 1;
                if (v > totalPages) v = totalPages;
                jumpInput.value = v;
                if (v !== this.analyzeState.page) {
                    this.analyzeState.page = v;
                    this._updateAnalyzeScrollArea();
                }
            };
            jumpInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.isComposing) {
                    e.preventDefault();
                    doJump();
                }
            });
            jumpInput.addEventListener('blur', () => {
                // 失焦时恢复为当前页码（用户必须按回车确认）
                jumpInput.value = this.analyzeState.page;
            });
        }
        $('[data-analyze-page-size]')?.addEventListener('change', (e) => {
            this.analyzeState.pageSize = parseInt(e.target.value, 10);
            this.analyzeState.page = 1;
            this._updateAnalyzeScrollArea();
        });
    }

    _bindAnalyzeModalEvents() {
        const $ = (sel) => this.shadowRoot.querySelector(sel);
        const $$ = (sel) => this.shadowRoot.querySelectorAll(sel);

        // Modal close
        $('#analyze-modal-close')?.addEventListener('click', () => this._closeAnalyzeModal());
        const analyzeModalOverlay = $('#analyze-modal-overlay');
        if (analyzeModalOverlay) {
            bindOverlayDismiss(analyzeModalOverlay, () => this._closeAnalyzeModal());
        }

        // Modal footer buttons
        $('[data-modal-cancel]')?.addEventListener('click', () => this._closeAnalyzeModal());
        $('[data-modal-confirm-delete]')?.addEventListener('click', () => {
            this._executeDeleteMeta();
        });
        $('[data-modal-confirm-export]')?.addEventListener('click', () => {
            this._executeExportWithOptions();
        });
        $('[data-modal-save-prompts]')?.addEventListener('click', () => {
            this._savePromptManager();
        });

        this._bindPromptManagerEvents();

        // Accordion toggle for test cases
        $$('[data-accordion-toggle]').forEach((header) => {
            header.addEventListener('click', (e) => {
                e.stopPropagation();
                const index = header.getAttribute('data-accordion-toggle');
                const body = this.shadowRoot.querySelector(`[data-accordion-body="${index}"]`);
                const arrow = header.querySelector('.accordion-arrow');
                if (body) {
                    const isOpen = body.style.display !== 'none';
                    body.style.display = isOpen ? 'none' : 'block';
                    if (arrow) arrow.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(90deg)';
                }
            });
        });

        // Goto task button
        $$('[data-goto-task]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const taskId = btn.getAttribute('data-goto-task');
                if (taskId) {
                    window.parent.postMessage({ type: 'openTask', taskId }, '*');
                }
            });
        });

        // Rerun single test button
        $$('[data-rerun-skill]').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const skillId = btn.getAttribute('data-rerun-skill');
                const testCaseIndex = parseInt(btn.getAttribute('data-rerun-index'), 10);
                if (!skillId || isNaN(testCaseIndex)) return;

                const api = getSkillsAPI();
                if (!api?.runSingleSkillTest) {
                    this._showNotification(this._t('renderer.skill.common.apiUnavailable'));
                    return;
                }

                try {
                    btn.disabled = true;
                    btn.textContent = this._t('renderer.skill.analyze.rerunRunning');
                    const timeoutMs =
                        this.analyzeState.timeoutMinutes === null
                            ? undefined
                            : this.analyzeState.timeoutMinutes * 60_000;
                    const status = await api.runSingleSkillTest(skillId, testCaseIndex, { timeoutMs });
                    // 合并结果到当前状态
                    const existing = this.analyzeState.workerStatus?.results || {};
                    this.analyzeState.workerStatus = { ...status, results: { ...existing, ...status.results } };
                    if (this.analyzeState._modalType === 'testCases' && this.analyzeState.modalSkillId === skillId) {
                        await this._loadExistingMetadatas();
                        this._showTestCasesModal(skillId, testCaseIndex);
                        return;
                    }
                } catch (err) {
                    console.error('[SkillMgr] runSingleSkillTest failed:', err);
                    this._showNotification(
                        this._t('renderer.skill.analyze.rerunFailed', {
                            message: err?.message || this._t('renderer.skill.common.unknownError')
                        })
                    );
                } finally {
                    btn.disabled = false;
                    btn.textContent = this._t('renderer.skill.analyze.rerun');
                }
                this.render();
            });
        });

        // 导出选项模态窗口 - 选项变更事件
        this._bindExportOptionEvents($, $$);
    }

    _capturePromptManagerTextarea() {
        const textarea = this.shadowRoot.querySelector('[data-prompt-textarea]');
        const key = textarea?.getAttribute('data-prompt-textarea');
        if (!key) return;
        this.analyzeState.prompts[key] = textarea.value;
    }

    _updatePromptManagerContent() {
        this.analyzeState.modalContent = this._renderPromptManagerContent();
        const body = this.shadowRoot.querySelector('.analyze-modal-body');
        if (!body) {
            this.render();
            return;
        }
        body.innerHTML = this.analyzeState.modalContent;
        this._bindPromptManagerEvents(body);
    }

    _bindPromptManagerEvents(root = this.shadowRoot) {
        root.querySelectorAll('[data-prompt-tab]').forEach((btn) => {
            btn.addEventListener('click', () => {
                if (btn.disabled) return;
                const tabId = btn.getAttribute('data-prompt-tab');
                if (!tabId || this.analyzeState.promptActiveTab === tabId) return;
                this._capturePromptManagerTextarea();
                this.analyzeState.promptActiveTab = tabId;
                this._updatePromptManagerContent();
            });
        });

        const textarea = root.querySelector('[data-prompt-textarea]');
        textarea?.addEventListener('input', (e) => {
            const key = e.target.getAttribute('data-prompt-textarea');
            if (!key) return;
            this.analyzeState.prompts[key] = e.target.value;
        });
    }

    /**
     * 绑定导出元数据选项表单的事件。
     */
    _bindExportOptionEvents($, $$) {
        // 依赖信息复选框
        const depCheckbox = $('[data-export-opt="includeDependencies"]');
        if (depCheckbox) {
            depCheckbox.addEventListener('change', (e) => {
                this.analyzeState.exportOptions.includeDependencies = e.target.checked;
            });
        }

        // 测试用例单选按钮
        const testCaseRadios = $$('[data-export-opt="includeTestCases"]');
        const resultCheckbox = $('[data-export-opt="includeTestResults"]');
        const resultLabel = resultCheckbox?.closest('.export-option-checkbox');

        testCaseRadios.forEach((radio) => {
            radio.addEventListener('change', (e) => {
                const value = e.target.value;
                this.analyzeState.exportOptions.includeTestCases = value;

                // 直接操作 DOM 更新"包含运行结果"的禁用状态，避免重新渲染导致闪烁
                if (resultCheckbox && resultLabel) {
                    if (value === 'none') {
                        this.analyzeState.exportOptions.includeTestResults = false;
                        resultCheckbox.checked = false;
                        resultCheckbox.disabled = true;
                        resultLabel.classList.add('export-option-disabled');
                    } else {
                        resultCheckbox.disabled = false;
                        resultLabel.classList.remove('export-option-disabled');
                    }
                }
            });
        });

        // 运行结果复选框 - 复用上面已查询的 resultCheckbox
        if (resultCheckbox) {
            resultCheckbox.addEventListener('change', (e) => {
                this.analyzeState.exportOptions.includeTestResults = e.target.checked;
            });
        }
    }

    /**
     * 处理分析工具栏的动作。
     */
    async _handleAnalyzeAction(actionId) {
        console.log('[SkillMgr] _handleAnalyzeAction called:', actionId);
        const allSkills = [...this.skills];
        let skillIds = [];

        switch (actionId) {
            case 'analyze-deps-selected':
                skillIds = [...this.analyzeState.selected];
                if (skillIds.length === 0) {
                    console.warn('[SkillMgr] analyze-deps-selected: no skills selected');
                    this._showNotification(this._t('renderer.skill.analyze.selectFirst'));
                    return;
                }
                break;
            case 'analyze-deps-all':
                skillIds = allSkills.map((s) => s.id);
                console.log('[SkillMgr] analyze-deps-all: analyzing', skillIds.length, 'skills');
                break;
            case 'gen-test-selected':
                skillIds = [...this.analyzeState.selected];
                if (skillIds.length === 0) {
                    this._showNotification(this._t('renderer.skill.analyze.selectFirstTestgen'));
                    return;
                }
                break;
            case 'gen-test-all':
                skillIds = allSkills.map((s) => s.id);
                break;
            case 'run-test-selected':
            case 'run-test-all':
            case 'run-test-unpassed-selected':
            case 'run-test-unpassed-all':
                this._handleRunTests(actionId);
                return;
            case 'show-test-report':
                await this._showSelectedTestReportModal();
                return;
            case 'refresh-metadata':
                await this._loadExistingMetadatas();
                this.render();
                return;
            case 'export-meta-selected':
            case 'export-meta-all':
                this._handleExportMeta(actionId);
                return;
            case 'export-analyze-html':
                await this._handleExportAnalyzePage();
                return;
            case 'import-meta':
                this._handleImportMeta();
                return;
            case 'manage-prompts':
                this._showPromptManagerModal();
                return;
            case 'delete-meta-selected':
            case 'delete-meta-all':
                this._handleDeleteMeta(actionId);
                return;
            default:
                console.log('[SkillMgr] unhandled action:', actionId);
                this.render();
                return;
        }

        if (skillIds.length === 0) {
            this.render();
            return;
        }

        const isTestGen = actionId === 'gen-test-selected' || actionId === 'gen-test-all';
        const isTestRun = actionId === 'run-test-selected' || actionId === 'run-test-all';
        console.log(
            `[SkillMgr] calling ${isTestRun ? 'runSkillTests' : isTestGen ? 'generateSkillTests' : 'analyzeSkillDependencies'} with`,
            skillIds.length,
            'skills'
        );
        try {
            const api = getSkillsAPI();
            const fn = isTestRun
                ? api?.runSkillTests
                : isTestGen
                  ? api?.generateSkillTests
                  : api?.analyzeSkillDependencies;
            if (!fn) {
                this._showNotification(this._t('renderer.skill.common.apiUnavailable'));
                this.render();
                return;
            }
            const status = await fn(skillIds, this.analyzeState.concurrency);
            console.log(
                `[SkillMgr] ${isTestRun ? 'runSkillTests' : isTestGen ? 'generateSkillTests' : 'analyzeSkillDependencies'} returned:`,
                JSON.stringify(status)
            );
            const existing = this.analyzeState.workerStatus?.results || {};
            this.analyzeState.workerStatus = { ...status, results: { ...existing, ...status.results } };
        } catch (err) {
            console.error('[SkillMgr] analyzeSkillDependencies failed:', err);
            this._showNotification(
                this._t('renderer.skill.analyze.startFailed', {
                    message: err?.message || this._t('renderer.skill.common.unknownError')
                })
            );
        }
        this.render();
    }

    /**
     * 处理导出独立 HTML 页面操作。
     */
    async _handleExportAnalyzePage() {
        try {
            const result = await window.fsAPI.saveFile({
                title: this._t('renderer.skill.export.htmlDialogTitle'),
                defaultPath: `skills-analysis-${new Date().toISOString().slice(0, 10)}.html`,
                filters: [{ name: 'HTML', extensions: ['html'] }]
            });
            if (result.canceled || !result.filePath) return;

            const api = getSkillsAPI();
            if (!api?.exportAnalyzePage) {
                this._showNotification(this._t('renderer.skill.common.apiUnavailable'));
                return;
            }

            const skillIds = [...this.analyzeState.selected];
            const exportResult = await api.exportAnalyzePage(result.filePath, skillIds);
            this._showExportResultModal({
                success: exportResult.success,
                successCount:
                    exportResult.success && typeof exportResult.skillCount === 'number'
                        ? exportResult.skillCount
                        : exportResult.success
                          ? skillIds.length
                          : 0,
                errorCount: exportResult.success ? 0 : 1,
                errors: exportResult.error ? [exportResult.error] : []
            });
        } catch (err) {
            console.error('[SkillMgr] exportAnalyzePage failed:', err);
            this._showExportResultModal({
                success: false,
                successCount: 0,
                errorCount: 1,
                errors: [err?.message || this._t('renderer.skill.common.unknownError')]
            });
        }
    }

    /**
     * 处理运行测试操作。
     */
    async _handleRunTests(actionId) {
        const allSkills = [...this.skills];
        let skillIds;
        const selectedOnly = actionId === 'run-test-selected' || actionId === 'run-test-unpassed-selected';
        const unpassedOnly = actionId === 'run-test-unpassed-selected' || actionId === 'run-test-unpassed-all';

        if (selectedOnly) {
            skillIds = [...this.analyzeState.selected];
            if (skillIds.length === 0) {
                this._showNotification(this._t('renderer.skill.analyze.selectFirstRunTest'));
                return;
            }
        } else {
            skillIds = allSkills.map((s) => s.id);
        }

        console.log(
            `[SkillMgr] ${unpassedOnly ? 'runUnpassedSkillTests' : 'runSkillTests'}:`,
            skillIds.length,
            'skills'
        );
        try {
            const api = getSkillsAPI();
            const fn = unpassedOnly ? api?.runUnpassedSkillTests : api?.runSkillTests;
            if (!fn) {
                this._showNotification(this._t('renderer.skill.common.apiUnavailable'));
                this.render();
                return;
            }
            const timeoutMs =
                this.analyzeState.timeoutMinutes === null ? undefined : this.analyzeState.timeoutMinutes * 60_000;
            const status = await fn(skillIds, this.analyzeState.concurrency, { timeoutMs });
            console.log(
                `[SkillMgr] ${unpassedOnly ? 'runUnpassedSkillTests' : 'runSkillTests'} returned:`,
                JSON.stringify(status)
            );
            const existing = this.analyzeState.workerStatus?.results || {};
            this.analyzeState.workerStatus = { ...status, results: { ...existing, ...status.results } };
        } catch (err) {
            console.error(`[SkillMgr] ${unpassedOnly ? 'runUnpassedSkillTests' : 'runSkillTests'} failed:`, err);
            this._showNotification(
                this._t('renderer.skill.analyze.testStartFailed', {
                    message: err?.message || this._t('renderer.skill.common.unknownError')
                })
            );
        }
        this.render();
    }

    /**
     * 处理导出元数据操作 - 弹出导出选项模态窗口。
     */
    async _handleExportMeta(actionId) {
        const allSkills = [...this.skills];
        let skillIds;

        if (actionId === 'export-meta-selected') {
            skillIds = [...this.analyzeState.selected];
            if (skillIds.length === 0) {
                this._showNotification(this._t('renderer.skill.analyze.selectFirstExport'));
                return;
            }
        } else {
            skillIds = allSkills.map((s) => s.id);
        }

        // 存储待导出的 skillIds 和 actionId，供模态窗口确认后使用
        this._pendingExportSkillIds = skillIds;
        this._pendingExportActionId = actionId;

        // 重置导出选项为默认值
        this.analyzeState.exportOptions = {
            includeDependencies: true,
            includeTestCases: 'all',
            includeTestResults: true
        };

        // 显示导出选项模态窗口
        this._showExportOptionsModal();
    }

    /**
     * 显示导出元数据选项模态窗口。
     */
    _showExportOptionsModal() {
        const opts = this.analyzeState.exportOptions;
        const testNone = opts.includeTestCases === 'none';

        this.analyzeState.modalTitle = this._t('renderer.skill.export.modalTitle');
        this.analyzeState.modalContent = `
            <div class="export-options-form">
                <div class="export-option-row">
                    <label class="export-option-checkbox">
                        <input type="checkbox" data-export-opt="includeDependencies"
                            ${opts.includeDependencies ? 'checked' : ''}>
                        <span>${this._t('renderer.skill.export.includeDeps')}</span>
                    </label>
                </div>
                <div class="export-option-row">
                    <div class="export-option-label">${this._t('renderer.skill.export.testCases')}</div>
                    <div class="export-option-radio-group">
                        <label class="export-option-radio">
                            <input type="radio" name="exportTestCases" value="all"
                                data-export-opt="includeTestCases"
                                ${opts.includeTestCases === 'all' ? 'checked' : ''}>
                            <span>${this._t('renderer.skill.export.testAll')}</span>
                        </label>
                        <label class="export-option-radio">
                            <input type="radio" name="exportTestCases" value="passed"
                                data-export-opt="includeTestCases"
                                ${opts.includeTestCases === 'passed' ? 'checked' : ''}>
                            <span>${this._t('renderer.skill.export.testPassed')}</span>
                        </label>
                        <label class="export-option-radio">
                            <input type="radio" name="exportTestCases" value="none"
                                data-export-opt="includeTestCases"
                                ${testNone ? 'checked' : ''}>
                            <span>${this._t('renderer.skill.export.testNone')}</span>
                        </label>
                    </div>
                </div>
                <div class="export-option-row">
                    <label class="export-option-checkbox ${testNone ? 'export-option-disabled' : ''}">
                        <input type="checkbox" data-export-opt="includeTestResults"
                            ${opts.includeTestResults ? 'checked' : ''}
                            ${testNone ? 'disabled' : ''}>
                        <span>${this._t('renderer.skill.export.includeResults')}</span>
                    </label>
                </div>
            </div>`;
        this.analyzeState.modalFooter = `
            <button type="button" class="analyze-modal-btn analyze-modal-btn-cancel" data-modal-cancel>${this._t('renderer.skill.common.cancel')}</button>
            <button type="button" class="analyze-modal-btn analyze-modal-btn-primary" data-modal-confirm-export>${this._t('renderer.skill.export.button')}</button>`;

        this.analyzeState.modalVisible = true;
        this.analyzeState._modalType = 'export';
        this.render();
    }

    /**
     * 导出选项模态确认后，打开保存对话框并执行导出。
     */
    async _executeExportWithOptions() {
        this.analyzeState.modalVisible = false;
        this.analyzeState.modalFooter = '';
        this.analyzeState._modalType = null;
        this.render();

        const skillIds = this._pendingExportSkillIds;
        if (!skillIds || skillIds.length === 0) return;

        try {
            // 打开保存对话框
            const result = await window.fsAPI.saveFile({
                title: this._t('renderer.skill.export.dialogTitle'),
                defaultPath: `skill-metadata-${new Date().toISOString().slice(0, 10)}.zip`,
                filters: [{ name: 'ZIP', extensions: ['zip'] }]
            });
            if (result.canceled || !result.filePath) return;

            const api = getSkillsAPI();
            if (!api?.exportSkillMetadatas) {
                this._showNotification(this._t('renderer.skill.common.apiUnavailable'));
                return;
            }

            const exportResult = await api.exportSkillMetadatas(
                skillIds,
                result.filePath,
                this.analyzeState.exportOptions
            );
            this._showExportResultModal(exportResult);
        } catch (err) {
            console.error('[SkillMgr] exportSkillMetadatas failed:', err);
            this._showExportResultModal({
                success: false,
                successCount: 0,
                errorCount: 1,
                errors: [err?.message || this._t('renderer.skill.common.unknownError')]
            });
        } finally {
            this._pendingExportSkillIds = null;
        }
    }

    /**
     * 显示导出结果模态弹窗。
     */
    _showExportResultModal(result) {
        if (result.success) {
            this.analyzeState.modalVisible = true;
            this.analyzeState.modalTitle = this._t('renderer.skill.export.success.title');
            this.analyzeState.modalContent = `
                <div style="padding:16px 0;">
                    <div style="font-size:15px;color:#1d1d1f;font-weight:600;">${this._t('renderer.skill.export.success.message', { count: result.successCount })}</div>
                    ${result.errorCount > 0 ? `<div style="font-size:12px;color:#E06060;margin-top:8px;">${this._t('renderer.skill.export.success.failedSuffix', { count: result.errorCount })}</div>` : ''}
                </div>`;
        } else {
            this.analyzeState.modalVisible = true;
            this.analyzeState.modalTitle = this._t('renderer.skill.export.failed.title');
            this.analyzeState.modalContent = `
                <div style="padding:16px 0;">
                    <div style="font-size:15px;color:#E06060;font-weight:600;">${this._t('renderer.skill.export.failed.title')}</div>
                    <div style="font-size:12px;color:#999;margin-top:8px;max-height:120px;overflow-y:auto;">
                        ${(result.errors || []).map((e) => `<div>• ${escapeHtml(e)}</div>`).join('')}
                    </div>
                </div>`;
        }
        this.analyzeState.modalFooter = `
            <button type="button" class="analyze-modal-btn analyze-modal-btn-primary" data-modal-cancel>${this._t('renderer.skill.common.confirm')}</button>`;
        this.analyzeState._modalType = null;
        this.render();
    }

    /**
     * 处理导入元数据操作。
     */
    async _handleImportMeta() {
        try {
            // 打开文件选择对话框
            const filePaths = await window.fsAPI.selectFile();
            if (!filePaths || filePaths.length === 0) return;

            const zipPath = filePaths[0];
            if (!zipPath.toLowerCase().endsWith('.zip')) {
                this._showNotification(this._t('renderer.skill.export.selectZip'));
                return;
            }

            // 等待一帧，确保 native 文件对话框已完全关闭再弹出模态窗口
            await new Promise((r) => setTimeout(r, 100));

            // 显示导入进度模态框
            this._openMetaImportModal(zipPath);

            const api = getSkillsAPI();
            if (!api?.importSkillMetadatas) {
                this._closeMetaImportModal();
                this._showNotification(this._t('renderer.skill.common.apiUnavailable'));
                return;
            }

            // 更新进度
            this.metaImport.phase = 'importing';
            this._updateMetaImportModal();

            const result = await api.importSkillMetadatas(zipPath);

            // 显示结果
            this.metaImport.phase = 'complete';
            this.metaImport.result = result;
            this._updateMetaImportModal();
        } catch (err) {
            console.error('[SkillMgr] importSkillMetadatas failed:', err);
            this.metaImport.phase = 'complete';
            this.metaImport.result = {
                success: false,
                successCount: 0,
                failedCount: 1,
                skippedCount: 0,
                details: [],
                error: err?.message || this._t('renderer.skill.common.unknownError')
            };
            this._updateMetaImportModal();
        }
    }

    _getPromptTabs() {
        return [
            {
                id: 'dependencyAnalysis',
                label: this._t('renderer.skill.prompts.deps.label'),
                title: this._t('renderer.skill.prompts.deps.title'),
                hint: this._t('renderer.skill.prompts.deps.hint'),
                placeholder: this._t('renderer.skill.prompts.deps.placeholder')
            },
            {
                id: 'testGeneration',
                label: this._t('renderer.skill.prompts.testgen.label'),
                title: this._t('renderer.skill.prompts.testgen.title'),
                hint: this._t('renderer.skill.prompts.testgen.hint'),
                placeholder: this._t('renderer.skill.prompts.testgen.placeholder')
            },
            {
                id: 'testRun',
                label: this._t('renderer.skill.prompts.testrun.label'),
                title: this._t('renderer.skill.prompts.testrun.title'),
                hint: this._t('renderer.skill.prompts.testrun.hint'),
                placeholder: this._t('renderer.skill.prompts.testrun.placeholder')
            },
            {
                id: 'runtimeDependencyAnalysis',
                label: this._t('renderer.skill.prompts.runtime.label'),
                title: this._t('renderer.skill.prompts.runtime.title'),
                hint: this._t('renderer.skill.prompts.runtime.hint'),
                placeholder: this._t('renderer.skill.prompts.runtime.placeholder')
            }
        ];
    }

    _renderPromptManagerFooter() {
        return `
            <button type="button" class="analyze-modal-btn analyze-modal-btn-cancel" data-modal-cancel ${this.analyzeState.promptSaving ? 'disabled' : ''}>${this._t('renderer.skill.common.cancel')}</button>
            <button type="button" class="analyze-modal-btn analyze-modal-btn-primary" data-modal-save-prompts ${this.analyzeState.promptSaving ? 'disabled' : ''}>${this.analyzeState.promptSaving ? this._t('renderer.skill.common.saving') : this._t('renderer.skill.common.save')}</button>`;
    }

    _renderPromptManagerContent() {
        const tabs = this._getPromptTabs();
        const activeTab = tabs.find((tab) => tab.id === this.analyzeState.promptActiveTab) || tabs[0];
        const prompts = this.analyzeState.prompts || {};
        const value = prompts[activeTab.id] || '';

        return `
            <div class="prompt-manager">
                <div class="prompt-tabs">
                    ${tabs
                        .map(
                            (tab) =>
                                `<button type="button" class="prompt-tab-btn ${tab.id === activeTab.id ? 'active' : ''}" data-prompt-tab="${escapeHtml(tab.id)}" ${this.analyzeState.promptSaving ? 'disabled' : ''}>${escapeHtml(tab.label)}</button>`
                        )
                        .join('')}
                </div>
                <div class="prompt-editor">
                    <div class="prompt-editor-title">${escapeHtml(activeTab.title)}</div>
                    <div class="prompt-editor-hint">${escapeHtml(activeTab.hint)}</div>
                    <textarea class="prompt-textarea" data-prompt-textarea="${escapeHtml(activeTab.id)}" placeholder="${escapeHtml(activeTab.placeholder)}" ${this.analyzeState.promptSaving ? 'disabled' : ''}>${escapeHtml(value)}</textarea>
                </div>
            </div>`;
    }

    async _showPromptManagerModal() {
        const requestId = ++this._promptLoadRequestId;
        this.analyzeState.promptSaving = false;
        this.analyzeState.promptActiveTab = 'dependencyAnalysis';
        this.analyzeState.modalTitle = this._t('renderer.skill.prompts.title');
        this.analyzeState.modalContent =
            '<div class="prompt-loading">' + this._t('renderer.skill.common.loading') + '</div>';
        this.analyzeState.modalFooter = this._renderPromptManagerFooter();
        this.analyzeState.modalVisible = true;
        this.analyzeState._modalType = 'prompts';
        this.render();

        try {
            const api = getSkillsAPI();
            if (!api?.getAnalysisPrompts) {
                throw new Error(this._t('renderer.skill.common.apiUnavailable'));
            }
            const prompts = await api.getAnalysisPrompts();
            if (
                requestId !== this._promptLoadRequestId ||
                this.analyzeState._modalType !== 'prompts' ||
                !this.analyzeState.modalVisible
            ) {
                return;
            }
            this.analyzeState.prompts = {
                dependencyAnalysis: prompts?.dependencyAnalysis || '',
                testGeneration: prompts?.testGeneration || '',
                testRun: prompts?.testRun || '',
                runtimeDependencyAnalysis: prompts?.runtimeDependencyAnalysis || ''
            };
            this.analyzeState.modalContent = this._renderPromptManagerContent();
        } catch (err) {
            if (
                requestId !== this._promptLoadRequestId ||
                this.analyzeState._modalType !== 'prompts' ||
                !this.analyzeState.modalVisible
            ) {
                return;
            }
            this.analyzeState.modalContent = `
                <div style="padding:16px 0;color:#E06060;font-size:13px;">
                    ${this._t('renderer.skill.prompts.loadFailed', { message: escapeHtml(err?.message || this._t('renderer.skill.common.unknownError')) })}
                </div>`;
        }
        this.analyzeState.modalFooter = this._renderPromptManagerFooter();
        this.render();
    }

    async _savePromptManager() {
        if (this.analyzeState.promptSaving) return;

        try {
            const api = getSkillsAPI();
            if (!api?.saveAnalysisPrompts) {
                throw new Error(this._t('renderer.skill.common.apiUnavailable'));
            }

            this.analyzeState.promptSaving = true;
            this.analyzeState.modalFooter = this._renderPromptManagerFooter();
            this.render();

            const saved = await api.saveAnalysisPrompts(this.analyzeState.prompts);
            this.analyzeState.prompts = {
                dependencyAnalysis: saved?.dependencyAnalysis || '',
                testGeneration: saved?.testGeneration || '',
                testRun: saved?.testRun || '',
                runtimeDependencyAnalysis: saved?.runtimeDependencyAnalysis || ''
            };
            this.analyzeState.modalVisible = false;
            this.analyzeState.modalFooter = '';
            this.analyzeState._modalType = null;
            this.analyzeState.promptSaving = false;
            this._showNotification(this._t('renderer.skill.prompts.saved'));
        } catch (err) {
            this.analyzeState.promptSaving = false;
            this.analyzeState.modalContent = `
                ${this._renderPromptManagerContent()}
                <div style="margin-top:12px;color:#E06060;font-size:12px;">${this._t('renderer.skill.prompts.saveFailed', { message: escapeHtml(err?.message || this._t('renderer.skill.common.unknownError')) })}</div>`;
            this.analyzeState.modalFooter = this._renderPromptManagerFooter();
        }
        this.render();
    }

    /**
     * 处理删除元数据操作。
     */
    async _handleDeleteMeta(actionId) {
        const allSkills = [...this.skills];
        let skillIds;
        let confirmMsg;

        if (actionId === 'delete-meta-selected') {
            skillIds = [...this.analyzeState.selected];
            if (skillIds.length === 0) {
                this._showNotification(this._t('renderer.skill.analyze.selectFirstDeleteMeta'));
                return;
            }
            confirmMsg = this._t('renderer.skill.metaDelete.confirmSelected', { count: skillIds.length });
        } else {
            skillIds = allSkills.map((s) => s.id);
            confirmMsg = this._t('renderer.skill.metaDelete.confirmAll', { count: skillIds.length });
        }

        // 显示确认弹窗
        this.analyzeState.modalVisible = true;
        this.analyzeState.modalTitle = this._t('renderer.skill.metaDelete.title');
        this.analyzeState.modalContent = `<div style="padding:8px 0;font-size:14px;line-height:1.8;">${confirmMsg}</div>`;
        this.analyzeState.modalFooter = `
            <button type="button" class="analyze-modal-footer-btn btn-cancel" data-modal-cancel>${this._t('renderer.skill.common.cancel')}</button>
            <button type="button" class="analyze-modal-footer-btn btn-danger" data-modal-confirm-delete>${this._t('renderer.skill.metaDelete.confirmButton')}</button>`;
        this.analyzeState._modalType = 'delete';
        this._pendingDeleteSkillIds = skillIds;
        this.render();
    }

    /**
     * 执行实际的元数据删除（确认弹窗回调）。
     */
    async _executeDeleteMeta() {
        const skillIds = this._pendingDeleteSkillIds || [];
        this._pendingDeleteSkillIds = null;
        this.analyzeState.modalVisible = false;
        this.analyzeState.modalFooter = '';
        this.analyzeState._modalType = null;
        this.render();

        try {
            const api = getSkillsAPI();
            if (!api?.deleteSkillMetadatas) {
                this._showNotification(this._t('renderer.skill.common.apiUnavailable'));
                return;
            }

            const result = await api.deleteSkillMetadatas(skillIds);
            const msg =
                this._t('renderer.skill.metaDelete.done', { deleted: result.deleted }) +
                (result.notFound > 0
                    ? this._t('renderer.skill.metaDelete.notFoundSuffix', { count: result.notFound })
                    : '') +
                (result.errors.length > 0
                    ? this._t('renderer.skill.metaDelete.failedSuffix', { count: result.errors.length })
                    : '');
            this._showNotification(msg);

            // 刷新分析面板中的元数据展示
            this._loadExistingMetadatas();
        } catch (err) {
            console.error('[SkillMgr] deleteSkillMetadatas failed:', err);
            this._showNotification(
                this._t('renderer.skill.metaDelete.failed', {
                    message: err?.message || this._t('renderer.skill.common.unknownError')
                })
            );
        }
    }

    /**
     * 显示依赖项模态弹窗。
     */
    _showDependenciesModal(skillId) {
        const ws = this.analyzeState.workerStatus;
        const result = ws?.results?.[skillId];
        if (!result || !result.dependencies) return;

        const deps = result.dependencies;
        const skill = [...this.skills, ...this.builtinSkills].find((s) => s.id === skillId);
        const skillName = skill?.name || skillId;

        let html = `<div class="analyze-modal-section"><div class="analyze-modal-section-title">${this._t('renderer.skill.deps.of', { name: escapeHtml(skillName) })}</div>`;

        // 环境变量
        if (deps.envVars && deps.envVars.length > 0) {
            html += `<div class="analyze-modal-subsection"><div class="analyze-modal-subsection-title">${this._t('renderer.skill.deps.env')}</div>`;
            html += `<table class="analyze-modal-table"><thead><tr><th>${this._t('renderer.skill.deps.col.name')}</th><th>${this._t('renderer.skill.deps.col.required')}</th><th>${this._t('renderer.skill.deps.col.desc')}</th></tr></thead><tbody>`;
            for (const ev of deps.envVars) {
                html += `<tr><td><code>${escapeHtml(ev.name)}</code></td><td>${ev.required ? '✅' : '❌'}</td><td>${escapeHtml(ev.description || '—')}</td></tr>`;
            }
            html += `</tbody></table></div>`;
        }

        // Python 包
        if (deps.pythonPackages && deps.pythonPackages.length > 0) {
            html += `<div class="analyze-modal-subsection"><div class="analyze-modal-subsection-title">${this._t('renderer.skill.deps.python')}</div>`;
            html += `<table class="analyze-modal-table"><thead><tr><th>${this._t('renderer.skill.deps.col.package')}</th><th>${this._t('renderer.skill.deps.col.version')}</th><th>${this._t('renderer.skill.deps.col.desc')}</th></tr></thead><tbody>`;
            for (const pkg of deps.pythonPackages) {
                html += `<tr><td><code>${escapeHtml(pkg.name)}</code></td><td>${escapeHtml(pkg.version || '—')}</td><td>${escapeHtml(pkg.description || '—')}</td></tr>`;
            }
            html += `</tbody></table></div>`;
        }

        // npm 包
        if (deps.npmPackages && deps.npmPackages.length > 0) {
            html += `<div class="analyze-modal-subsection"><div class="analyze-modal-subsection-title">${this._t('renderer.skill.deps.npm')}</div>`;
            html += `<table class="analyze-modal-table"><thead><tr><th>${this._t('renderer.skill.deps.col.package')}</th><th>${this._t('renderer.skill.deps.col.version')}</th><th>${this._t('renderer.skill.deps.col.desc')}</th></tr></thead><tbody>`;
            for (const pkg of deps.npmPackages) {
                html += `<tr><td><code>${escapeHtml(pkg.name)}</code></td><td>${escapeHtml(pkg.version || '—')}</td><td>${escapeHtml(pkg.description || '—')}</td></tr>`;
            }
            html += `</tbody></table></div>`;
        }

        // 二进制命令
        if (deps.binaries && deps.binaries.length > 0) {
            html += `<div class="analyze-modal-subsection"><div class="analyze-modal-subsection-title">${this._t('renderer.skill.deps.commands')}</div>`;
            html += `<table class="analyze-modal-table"><thead><tr><th>${this._t('renderer.skill.deps.col.command')}</th><th>${this._t('renderer.skill.deps.col.desc')}</th></tr></thead><tbody>`;
            for (const bin of deps.binaries) {
                html += `<tr><td><code>${escapeHtml(bin.name)}</code></td><td>${escapeHtml(bin.description || '—')}</td></tr>`;
            }
            html += `</tbody></table></div>`;
        }

        if (
            !deps.envVars?.length &&
            !deps.pythonPackages?.length &&
            !deps.npmPackages?.length &&
            !deps.binaries?.length
        ) {
            html += `<div class="analyze-modal-empty">${this._t('renderer.skill.deps.none')}</div>`;
        }

        html += `</div>`;

        this.analyzeState.modalTitle = this._t('renderer.skill.deps.title');
        this.analyzeState.modalContent = html;
        this.analyzeState.modalFooter = '';
        this.analyzeState.modalVisible = true;
        this.analyzeState._modalType = null;
        this.analyzeState.modalSkillId = null;
        this.analyzeState.modalExpandedTestCaseIndex = null;
        this.analyzeState.promptSaving = false;
        this.render();
    }

    /**
     * 显示错误信息模态弹窗。
     */
    _showErrorModal(skillId) {
        const ws = this.analyzeState.workerStatus;
        const result = ws?.results?.[skillId];
        if (!result || !result.error) return;

        const skill = [...this.skills, ...this.builtinSkills].find((s) => s.id === skillId);
        const skillName = skill?.name || skillId;

        const html = `<div class="analyze-modal-section">
            <div class="analyze-modal-section-title">${this._t('renderer.skill.errorDetail.of', { name: escapeHtml(skillName) })}</div>
            <div class="analyze-modal-error-box">
                <div class="analyze-modal-error-icon">⚠️</div>
                <div class="analyze-modal-error-msg">${escapeHtml(result.error)}</div>
            </div>
        </div>`;

        this.analyzeState.modalTitle = this._t('renderer.skill.errorDetail.title');
        this.analyzeState.modalContent = html;
        this.analyzeState.modalFooter = '';
        this.analyzeState.modalVisible = true;
        this.analyzeState._modalType = null;
        this.analyzeState.modalSkillId = null;
        this.analyzeState.modalExpandedTestCaseIndex = null;
        this.analyzeState.promptSaving = false;
        this.render();
    }

    /**
     * 计算测试用例统计信息字符串。
     * @returns {string} 如 " (共3条，2通过，1失败)" 或空字符串
     */
    _getTestCaseStats(skillResult) {
        if (!skillResult?.testCases || skillResult.testCases.length === 0) return '';
        const tcs = skillResult.testCases;
        const total = tcs.length;
        const passed = tcs.filter((tc) => tc.status === 'passed').length;
        const failed = tcs.filter((tc) => tc.status === 'failed').length;
        return this._t('renderer.skill.testStats.summary', { total, passed, failed });
    }

    _formatTestFailureReasonCategory(category) {
        if (!category) return '';
        const key = TEST_FAILURE_REASON_CATEGORY_KEYS[category];
        return key ? this._t(key) : String(category);
    }

    async _showSelectedTestReportModal() {
        const skillIds = [...this.analyzeState.selected];
        if (skillIds.length === 0) {
            this._showNotification(this._t('renderer.skill.analyze.selectFirstStats'));
            return;
        }

        await this._loadExistingMetadatas();
        const report = buildSelectedSkillTestReportPage({
            skillIds,
            skills: this.skills,
            results: this.analyzeState.workerStatus?.results || {}
        });
        if (!report.hasTestInfo) {
            this._showNotification(this._t('renderer.skill.analyze.noTestInfo'));
            return;
        }

        this.analyzeState.modalTitle = this._t('renderer.skill.testStats.title');
        this.analyzeState.modalContent = report.html;
        this.analyzeState.modalFooter = '';
        this.analyzeState.modalVisible = true;
        this.analyzeState._modalType = 'testReport';
        this.analyzeState.modalSkillId = null;
        this.analyzeState.modalExpandedTestCaseIndex = null;
        this.analyzeState.promptSaving = false;
        this.render();
    }

    /**
     * 显示测试用例模态弹窗。
     */
    _showTestCasesModal(skillId, expandedTestCaseIndex = null) {
        const ws = this.analyzeState.workerStatus;
        const result = ws?.results?.[skillId];
        if (!result || !result.testCases) return;

        const testCases = result.testCases;
        const skill = [...this.skills, ...this.builtinSkills].find((s) => s.id === skillId);
        const skillName = skill?.name || skillId;

        const statusLabels = {
            pending: this._t('renderer.skill.testStats.pending'),
            passed: this._t('renderer.skill.testStats.passed'),
            failed: this._t('renderer.skill.testStats.failed'),
            skipped: this._t('renderer.skill.testStats.skipped')
        };

        let html = `<div class="analyze-modal-section"><div class="analyze-modal-section-title">${this._t('renderer.skill.testStats.of', { name: escapeHtml(skillName), count: testCases.length })}</div>`;

        for (const tc of testCases) {
            const promptHtml = renderTestCaseMarkdown(tc.prompt);
            const expectedHtml = renderTestCaseMarkdown(tc.expectedResult);
            const actualHtml = tc.actualResult ? renderTestCaseMarkdown(tc.actualResult) : '';
            const errorHtml = tc.error ? renderTestCaseMarkdown(tc.error) : '';
            const failureReasonLabel = this._formatTestFailureReasonCategory(tc.failureReasonCategory);
            const failureReasonHtml = failureReasonLabel
                ? `<div class="testcase-failure-category"><span class="testcase-failure-category-label">${this._t('renderer.skill.testStats.failureCategory')}</span><span class="testcase-failure-category-chip">${escapeHtml(failureReasonLabel)}</span></div>`
                : '';
            const failureDetailHtml =
                errorHtml || failureReasonHtml
                    ? `<div class="accordion-field accordion-field-error"><span class="label">${this._t('renderer.skill.testStats.error')}</span>${failureReasonHtml}${errorHtml ? `<div class="accordion-markdown">${errorHtml}</div>` : ''}</div>`
                    : '';
            const isExpanded = expandedTestCaseIndex != null && String(tc.index) === String(expandedTestCaseIndex);
            const taskId = tc.taskId || '';

            html += `
            <div class="accordion-item">
                <div class="accordion-header" data-accordion-toggle="${escapeHtml(String(tc.index))}">
                    <span class="accordion-arrow" style="${isExpanded ? 'transform:rotate(90deg)' : ''}">▶</span>
                    <span class="accordion-index">#${tc.index}</span>
                    <span class="accordion-title">${escapeHtml(tc.title)}</span>
                    <span class="analyze-modal-testcase-status status-${tc.status}">${statusLabels[tc.status] || tc.status}</span>
                </div>
                <div class="accordion-body" data-accordion-body="${escapeHtml(String(tc.index))}" style="display:${isExpanded ? 'block' : 'none'}">
                    <div class="accordion-field"><span class="label">${this._t('renderer.skill.testStats.prompt')}</span><div class="accordion-markdown">${promptHtml}</div></div>
                    <div class="accordion-field"><span class="label">${this._t('renderer.skill.testStats.expected')}</span><div class="accordion-markdown">${expectedHtml}</div></div>
                    ${actualHtml ? `<div class="accordion-field"><span class="label">${this._t('renderer.skill.testStats.actual')}</span><div class="accordion-markdown">${actualHtml}</div></div>` : ''}
                    ${failureDetailHtml}
                    <div class="accordion-field" style="margin-top:12px;padding-top:10px;border-top:1px solid rgba(0,0,0,0.06);display:flex;gap:8px;flex-wrap:wrap;">
                        ${taskId ? `<button type="button" class="analyze-goto-task-btn" data-goto-task="${escapeHtml(taskId)}" title="${this._t('renderer.skill.testcase.gotoTask')}">${this._t('renderer.skill.testcase.viewTask')}</button>` : ''}
                        <button type="button" class="analyze-rerun-btn" data-rerun-skill="${escapeHtml(skillId)}" data-rerun-index="${tc.index}" title="${this._t('renderer.skill.testcase.rerunHint')}">${this.analyzeState.workerStatus?.running ? '⏳' : '🔄'}${this._t('renderer.skill.testcase.rerunLabel')}</button>
                    </div>
                </div>
            </div>`;
        }

        html += `</div>`;

        this.analyzeState.modalTitle = this._t('renderer.skill.testcase.title');
        this.analyzeState.modalContent = html;
        this.analyzeState.modalFooter = '';
        this.analyzeState.modalVisible = true;
        this.analyzeState._modalType = 'testCases';
        this.analyzeState.modalSkillId = skillId;
        this.analyzeState.modalExpandedTestCaseIndex = expandedTestCaseIndex;
        this.analyzeState.promptSaving = false;
        this.render();
    }

    /**
     * 显示简要通知（使用 SweetAlert2 Toast 风格或简单的 alert）。
     */
    _showNotification(message) {
        // 使用简单的控制台输出，后续可替换为 Toast 组件
        console.log(`[SkillMgr] ${message}`);
        // 尝试发送系统通知
        try {
            const api = getSkillsAPI();
            api?.sendNotification?.('info', this._t('renderer.skill.notify.title'), message);
        } catch {
            // 静默忽略
        }
    }
}

customElements.define('skillmgr-entry-widget', SkillMgrEntryWidget);
