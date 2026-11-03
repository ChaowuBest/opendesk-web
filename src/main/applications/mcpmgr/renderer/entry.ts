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

import { OVERLAY_CSS } from '../../../../common/overlay-styles.js';
import { AgentOperableHTMLElement, RendererTool, RendererToolset } from '../../widget_utils.js';
import { z } from 'zod';
import { escapeHtml } from '../../../../common/utils/escape.js';
import { OPENDESK_THEME_CHANGED } from '../../../../renderer/theme/theme-iframe-bridge.ts';
import { syncShadowHostTheme } from '../../../../renderer/theme/theme-shadow-overrides.ts';
import { showConfirmModal, bindOverlayDismiss } from '../../../../renderer/components/confirmModal';
import { resolveRendererLocale } from '../../../../renderer/locale.js';
import { createTranslatorForMcpMgr } from '../locale/renderer.js';
import { mergeMcpRegistryTabState } from './registry-tabs.js';
import type { McpBatchFailure, McpBatchOperationResult, McpServerState } from '../common.js';

type Translator = ReturnType<typeof createTranslatorForMcpMgr>;

/* 模块级翻译器：供 getAPI/unwrapResult 等脱离实例上下文的工具函数取词，
   随 widget 应用语言设置而更新 */
let sharedT: Translator = createTranslatorForMcpMgr();

interface RegistryMcp {
    id: string;
    name: string;
    displayName?: string;
    description: string;
    author?: string;
    source: string;
    installUrl: string;
    repository?: string;
    configuration?: string;
    logo?: string;
    deployType?: string;
    serverType?: string;
    downloads?: number;
    stars?: number;
    views?: number;
    updateTime?: string;
    tags?: string[];
    categories?: string[];
    canInstall: boolean;
}

interface RegistryState {
    query: string;
    results: RegistryMcp[];
    total: number;
    page: number;
    hasMore: boolean;
    searching: boolean;
    loadingMore: boolean;
    hasSearched: boolean;
    message: { text: string; isError: boolean } | null;
}

const TRANSPORT_LABELS: Record<string, string> = {
    stdio: 'STDIO',
    sse: 'SSE',
    streamableHttp: 'Streamable HTTP'
};

const STATUS_STYLES: Record<string, { colorClass: string; dotClass: string }> = {
    connected: { colorClass: 'status-ok', dotClass: 'dot-ok' },
    connecting: { colorClass: 'status-warn', dotClass: 'dot-warn' },
    disconnected: { colorClass: 'status-muted', dotClass: 'dot-muted' },
    error: { colorClass: 'status-error', dotClass: 'dot-error' }
};

function getStatusInfo(status: string, t: Translator) {
    const key =
        { connected: 'status.connected', connecting: 'status.connecting', error: 'status.error' }[status] ||
        'status.disconnected';
    return { ...(STATUS_STYLES[status] || STATUS_STYLES.disconnected), label: t(key) };
}

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
${OVERLAY_CSS}
:host {
    display: flex; flex-direction: column; height: 100%;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', sans-serif;
    font-size: var(--fs-base); color: #1d1d1f; box-sizing: border-box;
    overflow: hidden; background: #fff;
    -webkit-font-smoothing: antialiased;
    /* 统一字号体系 */
    --fs-2xs: 9px; --fs-xs: 10px; --fs-sm: 11px; --fs-md: 12px;
    --fs-base: 13px; --fs-lg: 14px; --fs-xl: 16px;
    --icon-xs: 8px; --icon-sm: 10px; --icon-md: 12px; --icon-lg: 13px;
}
:host([data-theme="dark"]) {
    background: #1e1e1e !important;
    color: #cccccc !important;
    color-scheme: dark;
}
*, *::before, *::after { box-sizing: border-box; }
button, input, textarea { font: inherit; }

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
.runtime-banner {
    flex-shrink: 0; margin: 0 24px 12px; padding: 10px 14px; border-radius: 8px;
    color: #9a6700; background: #fff8c5; border: 1px solid #d4a72c;
}
:host([data-theme="dark"]) .runtime-banner {
    color: #f2cc60; background: rgba(187,128,9,0.16); border-color: rgba(210,153,34,0.45);
}
.header-title {
    font-size: 22px; font-weight: 700; color: #1d1d1f;
    margin-bottom: 14px;
    -webkit-app-region: no-drag;
}
.seg-row { display: flex; align-items: center; gap: 8px; -webkit-app-region: no-drag; }
.seg-control-container { flex: 1; min-width: 0; overflow: hidden; display: flex; }
.seg-control {
    display: inline-flex; flex: 1; min-width: 0;
    background: rgba(0, 0, 0, 0.04);
    border-radius: 10px; padding: 3px; gap: 2px;
}
.seg-item {
    padding: 7px 13px; border-radius: 8px; border: none;
    background: transparent; color: rgba(0, 0, 0, 0.4);
    font-size: var(--fs-md); font-weight: 500; cursor: pointer;
    transition: all 0.18s ease;
    white-space: nowrap; flex-shrink: 0;
    display: inline-flex; align-items: center; gap: 5px; line-height: 1;
}
.seg-item:hover { color: rgba(0, 0, 0, 0.6); }
.seg-item.active {
    background: #fff; color: #1d1d1f;
    box-shadow: 0 1px 3px rgba(0,0,0,0.06), 0 0.5px 1px rgba(0,0,0,0.03);
}
.seg-icon { font-size: var(--fs-base); }
.seg-badge {
    font-size: var(--fs-xs); background: rgba(0,0,0,0.05); border-radius: 10px;
    padding: 1px 7px; font-weight: 600; line-height: 1.4;
}
.header-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.action-btn {
    width: 34px; height: 34px; border-radius: 9px; border: 1px solid rgba(0,0,0,0.08);
    background: #fff; color: #444; font-size: var(--fs-xl); cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: all 0.15s;
}
.action-btn:hover { background: #f8f8f8; border-color: rgba(0,0,0,0.12); }
.action-btn:active { transform: scale(0.95); }
.action-btn:disabled { opacity: 0.35; cursor: not-allowed; transform: none; }

.content { flex: 1; min-height: 0; overflow: hidden; }
.tab-panel { display: none; height: 100%; overflow-y: auto; }
.tab-panel.active { display: block; }
.registry-panel { padding: 20px 24px 60px; }
.hero-title {
    text-align: center; padding: 6px 20px 20px;
    font-size: 20px; font-weight: 700; color: #1d1d1f;
    background: linear-gradient(135deg, #1d1d1f 0%, #6e6e73 100%);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    background-clip: text;
}
.search-bar { display: flex; gap: 10px; align-items: center; margin-bottom: 20px; }
.search-input-wrap { flex: 1; position: relative; min-width: 0; }
.search-input {
    width: 100%; padding: 10px 36px 10px 16px;
    border: 1px solid rgba(0,0,0,0.08); border-radius: 10px;
    background: #FAFAFA; font-size: var(--fs-base);
    outline: none; transition: all 0.2s; color: #1d1d1f;
}
.search-input:focus { border-color: #8BB8F0; box-shadow: 0 0 0 3px rgba(90,140,240,0.08); background: #fff; }
.search-input::placeholder { color: #bbb; }
.search-clear {
    position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
    width: 20px; height: 20px; border-radius: 50%;
    background: rgba(0,0,0,0.06); border: none;
    color: rgba(0,0,0,0.35); font-size: var(--fs-sm); line-height: 1;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.search-btn {
    padding: 10px 22px; border-radius: 10px; border: none;
    background: #6BA3EF; color: #fff; font-size: var(--fs-base); font-weight: 500;
    cursor: pointer; transition: all 0.15s; white-space: nowrap;
}
.search-btn:hover { background: #7DB0F3; }
.search-btn:disabled { opacity: 0.4; cursor: not-allowed; }
/* 搜索框为空时隐藏清除按钮：此时点击只会无谓地重新拉取列表并让结果区闪一下 */
.search-input:placeholder-shown ~ .search-clear { display: none; }
/* 注册源回传的结果计数：内嵌在搜索框右端，为它预留输入区右侧留白 */
.search-input-wrap.has-count .search-input { padding-right: 196px; }
.search-count {
    position: absolute; right: 38px; top: 50%; transform: translateY(-50%);
    max-width: 152px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: var(--fs-md); color: #999; pointer-events: none;
}
.search-count.is-busy { display: inline-flex; align-items: center; gap: 5px; }
.mini-spinner {
    display: inline-block; width: 11px; height: 11px;
    border: 1.6px solid rgba(0, 0, 0, 0.12); border-top-color: #6BA3EF;
    border-radius: 50%; animation: spin 0.7s linear infinite;
}
/* 搜索/刷新期间的结果区过渡：只替换内容并淡入淡出，避免整块变成 loading 再闪回 */
.registry-body, .panel-body { transition: opacity 0.18s ease; }

.mcp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)); gap: 12px; }
.mcp-card {
    background: #fff; border-radius: 14px; padding: 16px 18px;
    border: 1px solid rgba(0,0,0,0.05);
    box-shadow: 0 1px 3px rgba(0,0,0,0.02);
    transition: all 0.22s cubic-bezier(0.4, 0, 0.2, 1);
    cursor: pointer; display: flex; flex-direction: column; gap: 8px;
    min-height: 150px;
}
.mcp-card:hover {
    box-shadow: 0 4px 20px rgba(0,0,0,0.06);
    transform: translateY(-1px); border-color: rgba(0,0,0,0.08);
}
/* ── 批量多选：卡片勾选圈 + ⋯ 批量菜单 + 已选托盘 ── */
.mcp-card { position: relative; }
.mcp-card.sel {
    border-color: rgba(223,68,54,0.45);
    box-shadow: 0 0 0 1px rgba(223,68,54,0.16);
}
.batch-check { position: absolute; top: 12px; right: 12px; width: 20px; height: 20px; cursor: pointer; z-index: 5; }
.batch-check input { opacity: 0; width: 0; height: 0; position: absolute; }
.batch-box {
    width: 18px; height: 18px; border-radius: 6px;
    border: 1.5px solid rgba(0,0,0,0.18); background: #fff;
    display: flex; align-items: center; justify-content: center;
    transition: all 0.15s;
}
.batch-box svg { opacity: 0; transition: opacity 0.12s; }
.batch-check input:checked + .batch-box { background: #DF4436; border-color: #DF4436; }
.batch-check input:checked + .batch-box svg { opacity: 1; }
.more-btn {
    position: relative; width: 40px; height: 40px; flex-shrink: 0; padding: 0;
    border-radius: 10px; border: 1px solid rgba(0,0,0,0.08); background: #fff;
    color: #4A4642; cursor: pointer; transition: all 0.15s;
    display: inline-flex; align-items: center; justify-content: center;
}
.more-btn:hover { border-color: rgba(223,68,54,0.5); background: #FEF9F8; color: #DF4436; }
.more-badge {
    position: absolute; top: -6px; right: -6px;
    min-width: 16px; height: 16px; border-radius: 9px;
    background: #DF4436; color: #fff; font-size: var(--fs-xs); font-weight: 600;
    font-style: normal; display: flex; align-items: center; justify-content: center;
    padding: 0 4px; box-shadow: 0 0 0 2px #f5f4f2;
}
.batch-dropdown-anchor { position: relative; }
.batch-dropdown {
    display: none; flex-direction: column;
    position: absolute; top: calc(100% + 6px); right: 0;
    width: 260px; background: #fff; border-radius: 12px;
    border: 1px solid rgba(0,0,0,0.06);
    box-shadow: 0 8px 32px -8px rgba(0,0,0,0.14), 0 2px 8px -1px rgba(0,0,0,0.04);
    z-index: 9999; overflow: hidden; animation: dropdown-in 0.16s ease-out;
}
.batch-dropdown.visible { display: flex; }
@keyframes dropdown-in {
    from { opacity: 0; transform: translateY(-4px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
}
.batch-menu-section { padding: 3px; }
.batch-menu-section + .batch-menu-section { border-top: 1px solid rgba(0,0,0,0.04); }
.batch-menu-head { font-size: var(--fs-sm); color: #999; font-weight: 600; padding: 6px 10px 4px; }
.batch-menu-item {
    display: flex; align-items: center; gap: 10px; width: 100%;
    padding: 8px 10px; border: none; background: transparent; border-radius: 8px;
    cursor: pointer; text-align: left; font-size: var(--fs-base); color: #1d1d1f;
    transition: background 0.12s;
}
.batch-menu-item:hover { background: #f5f5f5; }
.batch-menu-item.dis, .batch-menu-item:disabled { opacity: 0.4; cursor: not-allowed; }
.batch-menu-item .item-info { display: flex; flex-direction: column; min-width: 0; }
.batch-menu-item .item-name { font-size: var(--fs-base); }
.batch-menu-item .item-hint { font-size: var(--fs-sm); color: #999; }
.batch-menu-empty { padding: 10px; text-align: center; font-size: var(--fs-md); color: #999; }
.batch-failure-detail {
    margin-top: 10px; padding: 8px 10px; border-radius: 8px;
    background: #FEF2F2; border: 1px solid #FECACA;
    font-size: var(--fs-sm); color: #DC2626; line-height: 1.5;
    max-height: 120px; overflow-y: auto; text-align: left;
}
.batch-tray {
    display: flex; align-items: center; gap: 8px;
    margin: -4px 0 14px; padding: 7px 8px 7px 12px;
    background: #fff; border: 1px solid rgba(0,0,0,0.08); border-radius: 10px;
    animation: dropdown-in 0.16s ease-out;
}
.tray-label { font-size: var(--fs-md); font-weight: 600; color: #4A4642; white-space: nowrap; flex-shrink: 0; }
.tray-label b { color: #DF4436; }
.tray-chips { display: flex; gap: 6px; overflow-x: auto; flex: 1; min-width: 0; padding: 1px; scrollbar-width: thin; }
.tray-chip {
    display: inline-flex; align-items: center; gap: 5px;
    height: 24px; padding: 0 6px 0 4px;
    border: 1px solid rgba(0,0,0,0.08); border-radius: 999px; background: #fff;
    flex-shrink: 0;
}
.tray-chip-icon {
    width: 16px; height: 16px; border-radius: 5px;
    display: flex; align-items: center; justify-content: center;
    font-size: var(--fs-xs); font-weight: 700; flex-shrink: 0;
}
.tray-chip-name { font-size: var(--fs-sm); color: #4A4642; white-space: nowrap; max-width: 140px; overflow: hidden; text-overflow: ellipsis; }
.tray-chip-x {
    width: 15px; height: 15px; border: 0; border-radius: 50%;
    background: none; color: #B4AFA9; cursor: pointer; padding: 0; flex-shrink: 0;
    display: inline-flex; align-items: center; justify-content: center;
}
.tray-chip-x:hover { background: #FDEEEC; color: #DF4436; }
.tray-clear {
    flex-shrink: 0; height: 24px; padding: 0 8px; border: 0; border-radius: 7px;
    background: none; color: #8A8580; font-size: var(--fs-sm); cursor: pointer;
    display: inline-flex; align-items: center; gap: 3px; transition: all 0.12s; white-space: nowrap;
}
.tray-clear:hover { background: #F0EFEC; color: #4A4642; }
.card-header { display: flex; align-items: flex-start; gap: 12px; }
.card-icon {
    width: 40px; height: 40px; border-radius: 11px;
    display: flex; align-items: center; justify-content: center;
    font-size: 17px; font-weight: 700; flex-shrink: 0; overflow: hidden;
}
.card-icon img { width: 100%; height: 100%; object-fit: cover; }
.card-info { flex: 1; min-width: 0; }
.card-title {
    font-size: var(--fs-lg); font-weight: 600; color: #1d1d1f; line-height: 1.3;
    margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.card-subtitle { font-size: var(--fs-sm); color: #999; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card-desc {
    font-size: var(--fs-md); color: #777; line-height: 1.5;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.card-footer {
    display: flex; align-items: center; justify-content: space-between;
    margin-top: auto; padding-top: 4px; gap: 8px;
}
.card-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
.tag-pill {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 3px 9px; border-radius: 12px; font-size: var(--fs-sm); font-weight: 500;
}
.tag-blue { background: #EBF3FE; color: #5B8DEF; }
.tag-green { background: #E7F6EA; color: #4CAF6E; }
.tag-orange { background: #FEF1E6; color: #E8935A; }
.tag-gray { background: #F3F3F3; color: #888; }
.status-line { display: inline-flex; align-items: center; gap: 5px; font-size: var(--fs-sm); font-weight: 600; }
.status-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.dot-ok { background: #34C759; }
.dot-warn { background: #FFB020; animation: pulse-dot 1.2s infinite; }
.dot-muted { background: #C7C7CC; }
.dot-error { background: #E06060; }
.status-ok { color: #2FA866; }
.status-warn { color: #C98520; }
.status-muted { color: #999; }
.status-error { color: #E06060; }
@keyframes pulse-dot { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }

.btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    padding: 7px 16px; border-radius: 8px; border: 1px solid rgba(0,0,0,0.08);
    background: #fff; color: #333; cursor: pointer; font-size: var(--fs-md); font-weight: 500;
    transition: all 0.15s; white-space: nowrap;
}
.btn:hover { background: #f8f8f8; }
.btn:active { transform: scale(0.97); }
.btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }
.btn-primary { background: #6BA3EF; color: #fff; border-color: #6BA3EF; }
.btn-primary:hover { background: #7DB0F3; }
.btn-danger { color: #E06060; border-color: rgba(224,96,96,0.2); }
.btn-danger:hover { background: #FFF5F5; }
.btn-sm { padding: 5px 12px; font-size: var(--fs-sm); }

.mcp-toggle { position: relative; width: 40px; height: 24px; flex-shrink: 0; }
.mcp-toggle input { opacity: 0; width: 0; height: 0; position: absolute; }
.mcp-toggle-slider {
    position: absolute; inset: 0; background: #D1D1D6;
    border-radius: 999px; cursor: pointer; transition: background 0.25s ease;
}
.mcp-toggle-slider::after {
    content: ''; position: absolute; top: 2px; left: 2px;
    width: 20px; height: 20px; background: #fff; border-radius: 50%;
    box-shadow: 0 1px 3px rgba(0,0,0,0.15); transition: transform 0.25s ease;
}
.mcp-toggle input:checked + .mcp-toggle-slider { background: #34C759; }
.mcp-toggle input:checked + .mcp-toggle-slider::after { transform: translateX(16px); }
	.mcp-toggle-warn input:checked + .mcp-toggle-slider { background: #F0A030; }

.registry-msg { font-size: var(--fs-md); color: #999; margin: 12px 0; text-align: center; }
.registry-msg.error { color: #D14; }
.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px 20px; color: #999; }
.empty-icon { font-size: 36px; margin-bottom: 12px; opacity: 0.4; }
.empty-title { font-size: var(--fs-lg); font-weight: 600; color: #1d1d1f; margin-bottom: 6px; }
.empty-hint { font-size: var(--fs-md); color: #999; text-align: center; max-width: 320px; line-height: 1.6; }
.loading-state { display: flex; flex-direction: column; align-items: center; padding: 40px 20px; color: #999; }
.loading-spinner { width: 24px; height: 24px; border: 2.5px solid #F0F0F0; border-top-color: #6BA3EF; border-radius: 50%; animation: spin 0.7s linear infinite; margin-bottom: 12px; }
@keyframes spin { to { transform: rotate(360deg); } }
.loading-more { text-align: center; padding: 20px; color: #999; font-size: var(--fs-md); }
.scroll-sentinel { height: 1px; }

.detail-overlay {
    display: none; position: fixed; inset: 0;
    z-index: 10000; align-items: center; justify-content: center;
    animation: fade-in 0.15s ease;
}
.detail-overlay.visible { display: flex; }
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
.detail-dialog {
    background: #fff; border-radius: 16px; padding: 0;
    width: 720px; max-width: 94%; max-height: 84vh; overflow: hidden;
    box-shadow: 0 24px 80px -16px rgba(0,0,0,0.22);
    animation: dialog-in 0.2s ease-out;
    display: flex; flex-direction: column;
}
@keyframes dialog-in {
    from { opacity: 0; transform: scale(0.95) translateY(8px); }
    to { opacity: 1; transform: scale(1) translateY(0); }
}
.detail-header {
    display: flex; align-items: center; gap: 12px;
    padding: 16px 24px; border-bottom: 1px solid rgba(0,0,0,0.06);
}
.detail-header.info { background: #EBF1FB; }
.detail-header.info .card-icon {
    width: 36px !important; height: 36px !important; border-radius: 10px !important;
    background: #4267B2 !important; color: #fff !important; font-size: 15px;
}
.detail-header-info { flex: 1; min-width: 0; }
.detail-name { font-size: 15px; font-weight: 700; color: #1d1d1f; margin-bottom: 2px; }
.detail-id { font-size: 11px; color: #86868B; word-break: break-all; }
.detail-close {
    width: 26px; height: 26px; border-radius: 7px; border: none;
    background: rgba(0,0,0,0.06); color: #555; cursor: pointer;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.detail-close svg { width: 14px; height: 14px; }
.detail-close:hover { background: rgba(0,0,0,0.12); color: #333; }
.detail-body { flex: 1; overflow-y: auto; padding: 20px 24px 24px; }
.detail-section { margin-bottom: 16px; }
.detail-section:last-child { margin-bottom: 0; }
.detail-section-label { font-size: var(--fs-sm); font-weight: 600; color: #999; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; }
.detail-desc { font-size: var(--fs-base); color: #1d1d1f; line-height: 1.6; white-space: pre-wrap; }
.detail-meta-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.detail-meta-item { padding: 8px 12px; background: #FAFAFA; border-radius: 8px; font-size: var(--fs-md); color: #555; min-width: 0; }
.meta-label { font-size: var(--fs-xs); color: #999; text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 2px; }
.meta-value { font-weight: 500; word-break: break-word; }
.detail-code {
    white-space: pre-wrap; word-break: break-word;
    margin: 0; padding: 12px 14px; background: #FAFAFA;
    border: 1px solid #F0F0F0; border-radius: 10px;
    color: #555; font-size: var(--fs-sm); line-height: 1.55;
    max-height: 220px; overflow: auto;
}
.detail-tools-list { display: flex; flex-direction: column; gap: 8px; }
.detail-tool-item { padding: 12px 14px; background: #FAFAFA; border-radius: 10px; border: 1px solid #F0F0F0; }
.detail-tool-name { font-size: var(--fs-base); font-weight: 600; color: #1d1d1f; margin-bottom: 3px; font-family: 'SF Mono', 'Cascadia Code', monospace; }
.detail-tool-desc { font-size: var(--fs-md); color: #777; line-height: 1.5; }
.detail-tool-params { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px; }
.detail-footer {
    padding: 12px 24px 16px; border-top: 1px solid #F0F0F0;
    display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap;
}
.form-body { display: flex; flex-direction: column; gap: 14px; }
.form-row { display: flex; flex-direction: column; gap: 6px; }
.form-row label { font-size: var(--fs-md); font-weight: 600; color: #555; }
.form-row input, .form-row textarea {
    width: 100%; padding: 9px 11px; border-radius: 10px;
    border: 1px solid rgba(0,0,0,0.1); background: #fff; color: #1d1d1f;
    outline: none; resize: vertical;
}
.form-row input:focus, .form-row textarea:focus { border-color: #8BB8F0; box-shadow: 0 0 0 3px rgba(90,140,240,0.08); }
.transport-options { display: flex; gap: 8px; flex-wrap: wrap; }
.transport-option { position: relative; cursor: pointer; }
.transport-option input { position: absolute; opacity: 0; }
.transport-option span {
    display: inline-flex; padding: 7px 12px; border-radius: 10px;
    border: 1px solid rgba(0,0,0,0.08); color: #666; background: #FAFAFA;
    font-size: var(--fs-md); font-weight: 600;
}
.transport-option input:checked + span { border-color: #8BB8F0; background: #EBF3FE; color: #5B8DEF; }
.form-error { display: none; padding: 10px 12px; border-radius: 10px; background: #FFF5F5; color: #D14; font-size: var(--fs-md); }
.form-error.visible { display: block; }

/* 环境变量编辑器（与模型设置风格统一） */
.env-list { display: flex; flex-direction: column; gap: 8px; }
.env-item { display: flex; align-items: center; gap: 8px; }
.env-key-input, .env-value-input {
    flex: 1; min-width: 0; padding: 8px 12px; border-radius: 8px;
    border: 1px solid rgba(0,0,0,0.08); background: rgba(255,255,255,0.6);
    color: #1d1d1f; font-size: var(--fs-base); outline: none;
}
.env-key-input:focus, .env-value-input:focus {
    border-color: #8BB8F0; box-shadow: 0 0 0 3px rgba(90,140,240,0.08);
}
.env-sep { color: #aaa; font-size: var(--fs-md); flex-shrink: 0; }
.env-remove-btn {
    width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
    border: none; background: none; color: #aaa; cursor: pointer; border-radius: 6px;
    font-size: var(--fs-lg); flex-shrink: 0; transition: color 0.15s;
}
.env-remove-btn:hover { color: #E06060; }
.env-empty-hint { font-size: var(--fs-md); color: #aaa; font-style: italic; padding: 4px 0; }
.env-add-btn {
    width: 100%; margin-top: 8px; padding: 8px 12px; font-size: var(--fs-base);
    color: #888; background: rgba(0,0,0,0.02); border: 1px dashed rgba(0,0,0,0.12);
    border-radius: 8px; cursor: pointer; transition: background 0.15s;
}
.env-add-btn:hover { background: rgba(0,0,0,0.04); }

.tab-panel::-webkit-scrollbar, .detail-body::-webkit-scrollbar, .detail-code::-webkit-scrollbar { width: 6px; }
.tab-panel::-webkit-scrollbar-thumb, .detail-body::-webkit-scrollbar-thumb, .detail-code::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.1); border-radius: 3px; }

:host([data-theme="dark"]) .header-area {
    background: rgba(37, 37, 38, 0.95);
    border-bottom-color: rgba(255,255,255,0.16);
}
:host([data-theme="dark"]) .header-title,
:host([data-theme="dark"]) .card-title,
:host([data-theme="dark"]) .detail-name,
:host([data-theme="dark"]) .detail-tool-name,
:host([data-theme="dark"]) .empty-title {
    color: #e4e4e4;
}
:host([data-theme="dark"]) .seg-control,
:host([data-theme="dark"]) .search-input,
:host([data-theme="dark"]) .form-row input,
:host([data-theme="dark"]) .form-row textarea,
:host([data-theme="dark"]) .env-key-input,
:host([data-theme="dark"]) .env-value-input {
    background: #333333;
    border-color: rgba(255,255,255,0.18);
    color: #cccccc;
}
:host([data-theme="dark"]) .env-add-btn {
    color: #aaa;
    background: rgba(255,255,255,0.04);
    border-color: rgba(255,255,255,0.1);
}
:host([data-theme="dark"]) .env-add-btn:hover { background: rgba(255,255,255,0.08); }
:host([data-theme="dark"]) .env-remove-btn { color: #888; }
:host([data-theme="dark"]) .env-remove-btn:hover { color: #f87171; }
:host([data-theme="dark"]) .env-empty-hint { color: #777; }
:host([data-theme="dark"]) .seg-item { color: rgba(255,255,255,0.55); }
:host([data-theme="dark"]) .seg-item.active {
    background: #252526;
    color: #fff;
    box-shadow: 0 1px 4px rgba(0,0,0,0.35);
}
:host([data-theme="dark"]) .action-btn,
:host([data-theme="dark"]) .btn {
    background: #333333;
    border-color: rgba(255,255,255,0.18);
    color: #cccccc;
}
:host([data-theme="dark"]) .btn-primary,
:host([data-theme="dark"]) .search-btn {
    background: #3b82f6;
    border-color: #3b82f6;
    color: #fff;
}
:host([data-theme="dark"]) .mcp-card {
    background: #252526;
    border-color: rgba(255,255,255,0.16);
    color: #cccccc;
}
:host([data-theme="dark"]) .detail-dialog {
    background: #2A2826;
    border-color: rgba(255,255,255,0.16);
    color: #cccccc;
}
:host([data-theme="dark"]) .hero-title {
    color: #e4e4e4;
    -webkit-text-fill-color: #e4e4e4;
    background: none;
}
:host([data-theme="dark"]) .card-subtitle,
:host([data-theme="dark"]) .card-desc,
:host([data-theme="dark"]) .empty-hint,
:host([data-theme="dark"]) .loading-state,
:host([data-theme="dark"]) .loading-more,
:host([data-theme="dark"]) .registry-msg,
:host([data-theme="dark"]) .detail-id,
:host([data-theme="dark"]) .detail-section-label,
:host([data-theme="dark"]) .detail-tool-desc {
    color: #ababab;
}
:host([data-theme="dark"]) .detail-header,
:host([data-theme="dark"]) .detail-footer {
    border-color: rgba(255,255,255,0.12);
}
:host([data-theme="dark"]) .detail-desc {
    color: #e4e4e4;
}
:host([data-theme="dark"]) .detail-meta-item,
:host([data-theme="dark"]) .detail-tool-item,
:host([data-theme="dark"]) .detail-code {
    background: #333333;
    border-color: rgba(255,255,255,0.12);
    color: #cccccc;
}
:host([data-theme="dark"]) .transport-option span {
    background: #333333;
    border-color: rgba(255,255,255,0.14);
    color: #cccccc;
}
:host([data-theme="dark"]) .transport-option input:checked + span {
    background: rgba(96,165,250,0.2);
    border-color: #60a5fa;
    color: #93c5fd;
}
:host([data-theme="dark"]) .detail-header.info {
    background: rgba(122,162,232,0.16);
}
:host([data-theme="dark"]) .detail-header.info .card-icon {
    background: #7AA2E8 !important; color: #fff !important;
}
:host([data-theme="dark"]) .detail-close {
    background: rgba(255,255,255,0.08); color: #ccc;
}
:host([data-theme="dark"]) .detail-close:hover {
    background: rgba(255,255,255,0.15); color: #fff;
}
:host([data-theme="dark"]) .tag-blue { background: rgba(96,165,250,0.15); color: #93c5fd; }
:host([data-theme="dark"]) .tag-green { background: rgba(74,222,128,0.15); color: #86efac; }
:host([data-theme="dark"]) .tag-orange { background: rgba(251,191,36,0.15); color: #fcd34d; }
:host([data-theme="dark"]) .tag-gray { background: rgba(255,255,255,0.08); color: #999; }
/* 批量多选与搜索计数的深色适配 */
:host([data-theme="dark"]) .search-count { color: #8b8b8b; }
:host([data-theme="dark"]) .mini-spinner {
    border-color: rgba(255, 255, 255, 0.18); border-top-color: #6BA3EF;
}
:host([data-theme="dark"]) .batch-box { background: #2a2a2a; border-color: rgba(255,255,255,0.25); }
:host([data-theme="dark"]) .batch-check input:checked + .batch-box { background: #DF4436; border-color: #DF4436; }
:host([data-theme="dark"]) .more-btn { background: #2a2a2a; border-color: rgba(255,255,255,0.14); color: #ccc; }
:host([data-theme="dark"]) .more-btn:hover { background: #333; border-color: rgba(223,68,54,0.5); color: #DF4436; }
:host([data-theme="dark"]) .batch-dropdown { background: #2a2a2a; border-color: rgba(255,255,255,0.12); }
:host([data-theme="dark"]) .batch-menu-section + .batch-menu-section { border-top-color: rgba(255,255,255,0.08); }
:host([data-theme="dark"]) .batch-menu-item { color: #ddd; }
:host([data-theme="dark"]) .batch-menu-item:hover { background: #333; }
:host([data-theme="dark"]) .batch-tray { background: #2a2a2a; border-color: rgba(255,255,255,0.12); }
:host([data-theme="dark"]) .tray-label { color: #ccc; }
:host([data-theme="dark"]) .tray-chip { background: #2a2a2a; border-color: rgba(255,255,255,0.14); }
:host([data-theme="dark"]) .tray-chip-name { color: #ccc; }
:host([data-theme="dark"]) .tray-clear { color: #999; }
:host([data-theme="dark"]) .tray-clear:hover { background: #333; color: #ddd; }
`;

function unwrapResult<T>(result: unknown): T {
    if (result && typeof result === 'object' && 'status' in result) {
        const wrapped = result as { status?: string; data?: T; message?: string };
        if (wrapped.status === 'error') throw new Error(wrapped.message || sharedT('error.operationFailed'));
        if (wrapped.status === 'ok') return wrapped.data as T;
    }
    return result as T;
}

function getAPI() {
    const api = (window as any).applicationAPI;
    return {
        call: async <T>(method: string, ...args: unknown[]) => unwrapResult<T>(await api.call(method, ...args)),
        callMainWorld: async <T>(method: string, ...args: unknown[]) =>
            unwrapResult<T>(await api.callMainWorld(method, ...args)),
        subscribe: (eventName: string, callback: () => void) => api.subscribe(eventName, callback),
        unsubscribe: (eventName: string) => api.unsubscribe(eventName)
    };
}

class McpMgrEntryWidget extends AgentOperableHTMLElement {
    private _t: Translator = createTranslatorForMcpMgr();
    private _locale: string | undefined = undefined;
    private _settingUnsubscribe: (() => void) | null = null;
    private registries: { id: string; label: string; icon: string; slogan: string }[] = [];
    private activeTab: string = 'installed';
    private servers: McpServerState[] = [];
    private loadingServers = true;
    private serverError = '';
    private localRuntimeAvailable = true;
    private localRuntimeMessage = '';
    private selectedServerId: string | null = null;
    private installingId: string | null = null;
    private saving = false;
    private registryState: RegistryState = {
        query: '',
        results: [],
        total: 0,
        page: 1,
        hasMore: false,
        searching: false,
        loadingMore: false,
        hasSearched: false,
        message: null
    };
    private installedQuery = '';
    private installedScrollTop = 0;
    /* 已安装 MCP 的批量多选集合（只收录可操作项：非只读、非 agent 专属） */
    private installedSelection = new Set<string>();
    private showBatchMenu = false;
    /* 顶部刷新进行中：只让刷新按钮进入忙碌态，页面内容保持旧结果 */
    private _refreshing = false;
    /* 局部结果区淡入淡出的在途定时器：同一节点只保留最后一次替换，卸载时统一清理 */
    private _pendingSwaps = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
    private _onServersUpdated: (() => void) | null = null;
    private _onRegistriesChanged: (() => void) | null = null;
    private _onThemeChange: ((e: any) => void) | null = null;
    private _registriesLoaded = false;
    private _registryInfoRequestId = 0;
    private _registrySearchRequestId = 0;

    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this._onThemeChange = (e: any) => syncShadowHostTheme(this, e.detail?.effective);
    }

    async connectedCallback() {
        // 先加载语言设置再渲染，避免首帧出现错误语言
        let setting;
        try {
            setting = await (window as any).settingAPI?.loadSettingObject?.();
        } catch {
            setting = undefined;
        }
        this._applyLocaleSetting(setting);
        // 等待设置加载期间元素可能已被移除，避免对脱离 DOM 的元素继续渲染
        if (!this.isConnected) return;
        this._subscribeLocaleChanges();
        this.render();
        document.addEventListener(OPENDESK_THEME_CHANGED, this._onThemeChange as EventListener);
        this._onServersUpdated = () => {
            // 后台推送（连接状态变化）只做局部同步，避免整页重渲染把已选托盘重建一次
            void this.loadServers({ silent: true });
        };
        getAPI().subscribe('serversUpdated', this._onServersUpdated);
        this._onRegistriesChanged = () => {
            void this.loadRegistries();
        };
        getAPI().subscribe('registriesChanged', this._onRegistriesChanged);
        this.loadServers();
        this.loadRegistries();
        this.loadLocalRuntimeStatus();
    }

    disconnectedCallback() {
        if (this._onServersUpdated) {
            getAPI().unsubscribe('serversUpdated');
            this._onServersUpdated = null;
        }
        if (this._onRegistriesChanged) {
            getAPI().unsubscribe('registriesChanged');
            this._onRegistriesChanged = null;
        }
        if (this._settingUnsubscribe) {
            this._settingUnsubscribe();
            this._settingUnsubscribe = null;
        }
        this.cancelPendingSwaps();
        document.removeEventListener(OPENDESK_THEME_CHANGED, this._onThemeChange as EventListener);
    }

    private _applyLocaleSetting(setting?: { locale?: string; resolved_locale?: string }) {
        this._locale = resolveRendererLocale(setting);
        this._t = createTranslatorForMcpMgr(setting);
        sharedT = this._t;
    }

    /* 语言设置变化时重建翻译器并按新语言重建界面。
       打开中的详情/表单弹窗属于用户输入态，原样保留不重建（与日历策略一致） */
    private _subscribeLocaleChanges() {
        if (this._settingUnsubscribe) return;
        const unsubscribe = (window as any).settingAPI?.onSettingChanged?.((setting: any) => {
            if (!this.isConnected) return;
            if (resolveRendererLocale(setting) === this._locale) return;
            const openOverlay = this.shadowRoot?.getElementById('detail-overlay') ?? null;
            this._applyLocaleSetting(setting);
            this.render();
            if (openOverlay) this.shadowRoot?.appendChild(openOverlay);
        });
        if (typeof unsubscribe === 'function') {
            this._settingUnsubscribe = unsubscribe;
        }
    }

    getAgentInstruct(): string {
        return this._t('agent.instruct');
    }

    getToolset(): RendererToolset {
        const toolset = new RendererToolset('mcpmgr');
        const listTool = new RendererTool(
            'listMcpServers',
            this._t('renderer.tool.listMcpServers.description'),
            z.object({})
        );
        listTool.setExecutor(async () => {
            return JSON.stringify(
                this.servers.map((server) => ({
                    name: server.name,
                    transport: server.transport,
                    enabled: server.enabled,
                    status: server.status,
                    toolCount: server.tools?.length || 0,
                    error: server.error,
                    agentIds: server.agentIds
                }))
            );
        });
        toolset.addTool(listTool);
        return toolset;
    }

    private getEffectiveTheme(): string {
        return (
            this.dataset.theme ||
            document.documentElement.dataset.theme ||
            this.closest('[data-theme]')?.getAttribute('data-theme') ||
            'light'
        );
    }

    private getColor(seed: string): { bg: string; text: string } {
        let hash = 0;
        for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
        return PASTEL_COLORS[hash % PASTEL_COLORS.length];
    }

    private getInitial(name: string): string {
        const trimmed = (name || 'M').trim();
        return escapeHtml(trimmed.slice(0, 1).toUpperCase());
    }

    private formatCount(value?: number): string {
        if (!value || value <= 0) return '0';
        if (value >= 10000) return `${(value / 10000).toFixed(1).replace(/\.0$/, '')}w`;
        if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
        return String(value);
    }

    private renderIcon(name: string, logo?: string): string {
        const color = this.getColor(name);
        if (logo) {
            return `<div class="card-icon" style="background:${color.bg};color:${color.text}"><img src="${escapeHtml(logo)}" alt="" loading="lazy" onerror="this.style.display='none';this.parentElement.textContent='${this.getInitial(name)}'"></div>`;
        }
        return `<div class="card-icon" style="background:${color.bg};color:${color.text}">${this.getInitial(name)}</div>`;
    }

    /* silent：不整页重渲染，只局部同步已安装面板与 tab 徽标（刷新/后台推送走这条路） */
    async loadServers({ silent = false } = {}) {
        if (!silent) this.serverError = '';
        try {
            this.servers = await getAPI().callMainWorld<McpServerState[]>('getServersForUI');
            // 服务端已不存在的 id 从多选集合里剔除，避免批量操作命中幽灵项
            for (const id of [...this.installedSelection]) {
                if (!this.servers.some((server) => server.id === id)) this.installedSelection.delete(id);
            }
        } catch (err: any) {
            this.servers = [];
            this.serverError = err.message || this._t('error.loadMcpFailed');
        } finally {
            this.loadingServers = false;
            if (silent) {
                this.syncHeaderBadge();
                this.syncInstalledPanel({ fade: true });
                this.syncInstalledTray();
                this.syncBatchBadge();
            } else {
                this.render();
            }
        }
    }

    async loadRegistries() {
        const requestId = ++this._registryInfoRequestId;
        try {
            const infos =
                await getAPI().callMainWorld<
                    { id: string; label: string; icon: string; slogan: string; iconClass?: string }[]
                >('getMcpRegistries');
            if (requestId !== this._registryInfoRequestId || !Array.isArray(infos)) return;

            const wasLoaded = this._registriesLoaded;
            const previousActiveTab = this.activeTab;
            // Registry 快照变化时，当前搜索请求可能仍在返回；先作废旧响应，
            // 避免停用后旧请求把结果重新写回页面。
            this._registrySearchRequestId++;
            this.registryState.searching = false;
            this.registryState.loadingMore = false;
            const stateMerge = mergeMcpRegistryTabState(this.registries, this.registryState, this.activeTab, infos);
            this.activeTab = stateMerge.activeTab;
            this._registriesLoaded = true;

            this.render();

            // 仅首次成功加载时自动进入第一个 registry。插件启停后的刷新不应
            // 把用户从“已安装”页强行切换到市场页。
            if (!wasLoaded && this.activeTab === 'installed' && this.registries.length > 0) {
                this.activeTab = this.registries[0].id;
                this.render();
                void this.searchRegistry('', 1);
            } else if (
                this.activeTab !== 'installed' &&
                this.activeTab === previousActiveTab &&
                !stateMerge.removedIds.includes(this.activeTab)
            ) {
                // 当前 registry 仍然存在时刷新其内容，确保重新启用/重载后的定义生效。
                void this.searchRegistry(this.registryState.query, 1);
            }
        } catch {
            // 查询失败时保留上一次可用快照，避免瞬态错误制造幽灵状态或清空导航。
        }
        this.render();
    }

    async loadLocalRuntimeStatus() {
        try {
            const status = await getAPI().callMainWorld<{
                available: boolean;
                message: string | null;
            }>('getLocalRuntimeStatus');
            this.localRuntimeAvailable = status.available;
            this.localRuntimeMessage = status.message || '';
        } catch {
            this.localRuntimeAvailable = true;
            this.localRuntimeMessage = '';
        }
        this.render();
    }

    async searchRegistry(query = this.registryState.query, page = 1) {
        const registryId = this.activeTab !== 'installed' ? this.activeTab : '';
        if (!registryId) return;
        const requestId = ++this._registrySearchRequestId;
        const state = this.registryState;
        const isNewSearch = page === 1;
        state.query = query;
        state.page = page;
        state.searching = true;
        state.loadingMore = false;
        // 保留旧结果与旧计数：搜索期间结果区不动，只在计数处显示「刷新中」。
        // 上一次的错误提示要立刻下掉，否则重新搜索期间仍挂着旧错误
        if (isNewSearch) {
            if (state.message?.isError) {
                state.message = null;
                this.syncRegistryPanel({ fade: false });
            }
            this.syncRegistrySearchState();
        }
        try {
            const result = await getAPI().callMainWorld<{
                mcps: RegistryMcp[];
                total?: number;
                hasMore?: boolean;
                message?: string;
            }>('searchMcpRegistry', registryId, query, page, 30);
            if (
                requestId !== this._registrySearchRequestId ||
                this.activeTab !== registryId ||
                !this.registries.some((registry) => registry.id === registryId)
            ) {
                return;
            }
            state.results = result.mcps || [];
            state.total = result.total || state.results.length;
            state.hasMore = Boolean(result.hasMore);
            state.hasSearched = true;
            state.message = result.message ? { text: result.message, isError: false } : null;
        } catch (err: any) {
            if (requestId !== this._registrySearchRequestId || this.activeTab !== registryId) return;
            state.results = [];
            state.total = 0;
            state.hasMore = false;
            state.hasSearched = true;
            state.message = { text: err.message || this._t('error.searchFailed'), isError: true };
        } finally {
            if (requestId === this._registrySearchRequestId) {
                state.searching = false;
                this.syncRegistrySearchState();
                // 结果区局部淡入切换，不重建整个页面；搜索条件变了才回到顶部
                this.syncRegistryPanel({ fade: true, resetScroll: true });
            }
        }
    }

    async loadMoreRegistry() {
        const state = this.registryState;
        const registryId = this.activeTab !== 'installed' ? this.activeTab : '';
        if (!registryId || state.loadingMore || state.searching || !state.hasMore) return;
        const requestId = ++this._registrySearchRequestId;
        state.loadingMore = true;
        // 增量更新 loading 状态，不重建整个 DOM
        this.updateLoadingMore(true);
        try {
            const nextPage = state.page + 1;
            const result = await getAPI().callMainWorld<{
                mcps: RegistryMcp[];
                total?: number;
                hasMore?: boolean;
                message?: string;
            }>('searchMcpRegistry', registryId, state.query, nextPage, 30);
            if (
                requestId !== this._registrySearchRequestId ||
                this.activeTab !== registryId ||
                !this.registries.some((registry) => registry.id === registryId)
            ) {
                return;
            }
            const newMcps = result.mcps || [];
            state.results = [...state.results, ...newMcps];
            state.total = result.total || state.results.length;
            state.page = nextPage;
            state.hasMore = Boolean(result.hasMore);
            // 增量追加新卡片到 DOM，不重建整个页面
            this.appendRegistryCards(newMcps);
        } catch {
            // 加载失败保持现有数据不变
        } finally {
            if (requestId === this._registrySearchRequestId) {
                state.loadingMore = false;
                this.updateLoadingMore(false);
            }
        }
    }

    /** 只更新 loading-more 区域的显示状态，必要时重建 sentinel 观察 */
    private updateLoadingMore(loading: boolean) {
        const root = this.shadowRoot;
        if (!root) return;
        const loadingEl = root.getElementById('loading-more');
        if (loadingEl) {
            loadingEl.innerHTML = loading
                ? `<div class="loading-spinner" style="margin:0 auto 8px;width:20px;height:20px;"></div>${escapeHtml(this._t('renderer.mcp.loadingMore'))}`
                : this.registryState.hasMore
                  ? escapeHtml(this._t('renderer.mcp.scrollForMore'))
                  : '';
        }
        const sentinel = root.querySelector('[data-load-more="registry"]') as HTMLElement | null;
        if (!loading && this.registryState.hasMore && sentinel) {
            // loadMore 完成后重建 IntersectionObserver（因为之前的已被 disconnect）
            const observer = new IntersectionObserver((entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    observer.disconnect();
                    this.loadMoreRegistry();
                }
            });
            observer.observe(sentinel);
        } else if (!this.registryState.hasMore && sentinel) {
            sentinel.remove();
        }
    }

    /** 向 mcp-grid 中增量追加卡片，保持滚动位置不变 */
    private appendRegistryCards(mcps: RegistryMcp[]) {
        const root = this.shadowRoot;
        if (!root) return;
        const grid = root.querySelector('.mcp-grid');
        if (!grid) return;
        grid.insertAdjacentHTML('beforeend', mcps.map((mcp) => this.renderRegistryCard(mcp)).join(''));
        // 为新卡片绑定事件
        grid.querySelectorAll('[data-registry-mcp]').forEach((card) => {
            // 跳过已绑定的
            if ((card as HTMLElement).dataset.bound === '1') return;
            (card as HTMLElement).dataset.bound = '1';
            card.addEventListener('click', (event) => {
                if ((event.target as HTMLElement).closest('[data-install-registry]')) return;
                const id = (card as HTMLElement).dataset.registryMcp;
                if (id) this.showRegistryDetail(id);
            });
        });
        grid.querySelectorAll('[data-install-registry]').forEach((button) => {
            if ((button as HTMLElement).dataset.bound === '1') return;
            (button as HTMLElement).dataset.bound = '1';
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                const id = (button as HTMLElement).dataset.installRegistry;
                if (id) this.installRegistryMcp(id);
            });
        });
    }

    private renderRegistryPanel(registryId: string): string {
        const registry = this.registries.find((r) => r.id === registryId);
        const label = registry?.label || registryId;
        const state = this.registryState;
        const countHtml = this.registryCountHtml();
        const countTitle = !state.searching && state.message && !state.message.isError ? state.message.text : '';

        return `
        <div class="registry-panel">
            <div class="search-bar">
                <div class="search-input-wrap ${countHtml ? 'has-count' : ''}">
                    <input type="text" class="search-input" data-search-tab="${escapeHtml(registryId)}" placeholder="${escapeHtml(this._t('renderer.mcp.search.placeholder.registry', { label }))}" value="${escapeHtml(state.query)}" ${state.searching ? 'disabled' : ''} />
                    ${countHtml ? `<span class="search-count ${state.searching ? 'is-busy' : ''}"${countTitle ? ` title="${escapeHtml(countTitle)}"` : ''}>${countHtml}</span>` : ''}
                    <button type="button" class="search-clear" data-clear-tab="${escapeHtml(registryId)}" title="${escapeHtml(this._t('renderer.mcp.search.clear'))}">×</button>
                </div>
                <button type="button" class="search-btn" data-search-btn="${escapeHtml(registryId)}" ${state.searching ? 'disabled' : ''}>${escapeHtml(state.searching ? this._t('renderer.mcp.search.searching') : this._t('renderer.mcp.search.button'))}</button>
            </div>
            <div class="registry-body">${this.renderRegistryBody(registryId)}</div>
        </div>`;
    }

    /** 搜索框右端的结果计数：搜索中就地显示转圈提示，避免整块内容区被 loading 取代 */
    private registryCountHtml(): string {
        const state = this.registryState;
        if (state.searching) {
            return `<span class="mini-spinner"></span>${escapeHtml(this._t('renderer.mcp.search.refreshing'))}`;
        }
        // 非错误提示（注册源常用来回传结果计数）内嵌到搜索框右端，不再单独占一行
        return state.message && !state.message.isError ? escapeHtml(state.message.text) : '';
    }

    /** 注册源结果区（错误提示 + 结果网格）；单独成函数以便搜索完成后局部替换 */
    private renderRegistryBody(registryId: string): string {
        const registry = this.registries.find((r) => r.id === registryId);
        const label = registry?.label || registryId;
        const state = this.registryState;
        // 错误提示仍需独立一行，避免被输入框宽度截断
        const message = state.message?.isError
            ? `<div class="registry-msg error">${escapeHtml(state.message.text)}</div>`
            : '';
        let content = '';

        if (state.searching && state.results.length === 0) {
            content = `<div class="loading-state"><div class="loading-spinner"></div><span>${escapeHtml(this._t('renderer.mcp.loading'))}</span></div>`;
        } else if (state.results.length === 0) {
            const icon = registry?.icon || '◇';
            const emptyTitle = this._t(
                state.hasSearched ? 'renderer.mcp.registry.empty.searched' : 'renderer.mcp.registry.empty.default'
            );
            content = `<div class="empty-state"><div class="empty-icon">${escapeHtml(icon)}</div><div class="empty-title">${escapeHtml(emptyTitle)}</div><div class="empty-hint">${escapeHtml(this._t('renderer.mcp.registry.empty.hint', { label }))}</div></div>`;
        } else {
            const hero = !state.query ? `<div class="hero-title">${escapeHtml(label)}</div>` : '';
            content = `
                ${hero}
                <div class="mcp-grid">
                    ${state.results.map((mcp) => this.renderRegistryCard(mcp)).join('')}
                </div>
                ${state.hasMore ? `<div class="loading-more" id="loading-more">${state.loadingMore ? `<div class="loading-spinner" style="margin:0 auto 8px;width:20px;height:20px;"></div>${escapeHtml(this._t('renderer.mcp.loadingMore'))}` : escapeHtml(this._t('renderer.mcp.scrollForMore'))}</div><div class="scroll-sentinel" data-load-more="registry"></div>` : ''}
            `;
        }

        return `${message}${content}`;
    }

    private renderRegistryCard(mcp: RegistryMcp): string {
        const installing = this.installingId === mcp.id;
        const tagHtml = [
            mcp.deployType ? `<span class="tag-pill tag-blue">${escapeHtml(mcp.deployType)}</span>` : '',
            typeof mcp.downloads === 'number'
                ? `<span class="tag-pill tag-green">↓ ${this.formatCount(mcp.downloads)}</span>`
                : '',
            typeof mcp.stars === 'number'
                ? `<span class="tag-pill tag-orange">★ ${this.formatCount(mcp.stars)}</span>`
                : ''
        ].join('');

        return `
        <div class="mcp-card" data-registry-mcp="${escapeHtml(mcp.id)}">
            <div class="card-header">
                ${this.renderIcon(mcp.displayName || mcp.name || mcp.id, mcp.logo)}
                <div class="card-info">
                    <div class="card-title">${escapeHtml(mcp.displayName || mcp.name || mcp.id)}</div>
                    <div class="card-subtitle">${escapeHtml(mcp.name || mcp.author || 'Matrix MCP')}</div>
                </div>
            </div>
            ${mcp.description ? `<div class="card-desc">${escapeHtml(mcp.description)}</div>` : ''}
            <div class="card-footer">
                <div class="card-meta">${tagHtml || `<span class="tag-pill tag-gray">${escapeHtml(mcp.source)}</span>`}</div>
                <button type="button" class="btn btn-primary btn-sm" data-install-registry="${escapeHtml(mcp.id)}" ${!mcp.canInstall || installing ? 'disabled' : ''}>${installing ? escapeHtml(this._t('renderer.mcp.registry.installing')) : escapeHtml(this._t('renderer.mcp.registry.install'))}</button>
            </div>
        </div>`;
    }

    private getFilteredServers(): McpServerState[] {
        const query = this.installedQuery.trim().toLowerCase();
        if (!query) return this.servers;
        return this.servers.filter((server) => {
            const haystack = [
                server.name,
                server.displayName,
                server.transport,
                server.command,
                (server.args || []).join(' '),
                server.url,
                server.source,
                ...(server.agentIds || []),
                server.error
            ]
                .filter(Boolean)
                .join(' ')
                .toLowerCase();
            return haystack.includes(query);
        });
    }

    private renderInstalledPanel(): string {
        if (this.loadingServers) {
            return `<div class="registry-panel"><div class="loading-state"><div class="loading-spinner"></div><span>${escapeHtml(this._t('renderer.mcp.loading'))}</span></div></div>`;
        }
        if (this.serverError) {
            return `<div class="registry-panel"><div class="empty-state"><div class="empty-icon">!</div><div class="empty-title">${escapeHtml(this.serverError)}</div></div></div>`;
        }
        const content = this.renderInstalledBody();
        const badge =
            this.installedSelection.size > 0 ? `<i class="more-badge">${this.installedSelection.size}</i>` : '';

        return `
        <div class="registry-panel">
            <div class="search-bar">
                <div class="search-input-wrap">
                    <input type="text" class="search-input" data-search-tab="installed" placeholder="${escapeHtml(this._t('renderer.mcp.search.placeholder.installed'))}" value="${escapeHtml(this.installedQuery)}" />
                    <button type="button" class="search-clear" data-clear-tab="installed" title="${escapeHtml(this._t('renderer.mcp.search.clear'))}">×</button>
                </div>
                <button type="button" class="search-btn" data-search-btn="installed">${escapeHtml(this._t('renderer.mcp.search.button'))}</button>
                <div class="batch-dropdown-anchor">
                    <button type="button" class="more-btn" data-more-scope="installed" title="${escapeHtml(this._t('renderer.mcp.batch.more'))}">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>
                        ${badge}
                    </button>
                    <div class="batch-dropdown ${this.showBatchMenu ? 'visible' : ''}">${this.batchDropdownItemsHtml()}</div>
                </div>
            </div>
            ${this.renderTrayHtml()}
            <div class="panel-body">${content}</div>
        </div>`;
    }

    /** 已安装列表结果区（英雄标题 + 卡片网格 / 空态），供整页渲染与局部替换共用 */
    private renderInstalledBody(): string {
        const filtered = this.getFilteredServers();
        if (this.servers.length === 0) {
            return `<div class="empty-state"><div class="empty-icon">◇</div><div class="empty-title">${escapeHtml(this._t('renderer.mcp.installed.empty.title'))}</div><div class="empty-hint">${escapeHtml(this._t('renderer.mcp.installed.empty.hint'))}</div></div>`;
        }
        if (filtered.length === 0) {
            return `<div class="empty-state"><div class="empty-icon">⌕</div><div class="empty-title">${escapeHtml(this._t('renderer.mcp.installed.filter.empty.title'))}</div><div class="empty-hint">${escapeHtml(this._t('renderer.mcp.installed.filter.empty.hint'))}</div></div>`;
        }
        return `<div class="hero-title">${escapeHtml(this._t('renderer.mcp.installed.count', { count: this.servers.length }))}</div><div class="mcp-grid">${filtered.map((server) => this.renderInstalledCard(server)).join('')}</div>`;
    }

    /** 只读或 agent 专属的条目不可批量操作，也不显示勾选圈 */
    private canOperate(server: McpServerState): boolean {
        return !server.readOnly && server.agentIds === undefined;
    }

    private selectedServers(): McpServerState[] {
        return [...this.installedSelection]
            .map((id) => this.servers.find((server) => server.id === id))
            .filter((server): server is McpServerState => Boolean(server));
    }

    private renderBatchCheck(server: McpServerState): string {
        if (!this.canOperate(server)) return '';
        const checked = this.installedSelection.has(server.id);
        return `<label class="batch-check" title="${escapeHtml(this._t('renderer.mcp.batch.check'))}">
                    <input type="checkbox" data-batch-check="${escapeHtml(server.id)}" ${checked ? 'checked' : ''}>
                    <span class="batch-box"><svg width="11" height="11" viewBox="0 0 12 12"><path d="M2.5 6.5l2.4 2.4L9.5 3.6" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
                </label>`;
    }

    /** 已选托盘：常驻展示全部已选 MCP（含被搜索过滤掉的），芯片可单独撤销 */
    private renderTrayHtml(): string {
        const selection = this.installedSelection;
        if (!selection.size) return '';
        const chips = [...selection].map((id) => this.renderTrayChipHtml(id)).join('');
        return `<div class="batch-tray" data-tray-scope="installed">
            <span class="tray-label">${this._t('renderer.mcp.batch.tray.label', { count: selection.size })}</span>
            <div class="tray-chips">${chips}</div>
            <button type="button" class="tray-clear" data-tray-clear="installed" title="${escapeHtml(this._t('renderer.mcp.batch.tray.clear'))}">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>`;
    }

    /** 单个已选芯片：整条渲染与增量同步共用同一份 HTML */
    private renderTrayChipHtml(id: string): string {
        const server = this.servers.find((item) => item.id === id);
        if (!server) return '';
        const label = this.getServerLabel(server);
        const color = this.getColor(label);
        return `<span class="tray-chip" data-chip-id="${escapeHtml(id)}">
            <span class="tray-chip-icon" style="background:${color.bg};color:${color.text}">${this.getInitial(label)}</span>
            <span class="tray-chip-name">${escapeHtml(label)}</span>
            <button type="button" class="tray-chip-x" data-tray-remove="${escapeHtml(id)}" title="${escapeHtml(this._t('renderer.mcp.batch.tray.remove'))}"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </span>`;
    }

    /** ⋯ 菜单：批量选择（全选 / 选择搜索结果 / 清空）+ 批量执行（启用 / 禁用 / 删除） */
    private batchDropdownItemsHtml(): string {
        const selection = this.installedSelection;
        const filtered = this.getFilteredServers();
        const operable = this.servers.filter((server) => this.canOperate(server));
        const searching = this.installedQuery.trim().length > 0;
        const t = this._t;
        const allSelected = operable.length > 0 && operable.every((server) => selection.has(server.id));
        const visNew = filtered.filter((server) => this.canOperate(server) && !selection.has(server.id)).length;

        const pickItem = searching
            ? visNew > 0
                ? `<button type="button" class="batch-menu-item" data-batch-action="pick-vis">
                     <span class="item-info"><span class="item-name">${t('renderer.mcp.batch.menu.pickVisible')}</span><span class="item-hint">${t('renderer.mcp.batch.menu.pickVisibleHint', { count: visNew })}</span></span>
                   </button>`
                : `<button type="button" class="batch-menu-item dis" disabled>
                     <span class="item-info"><span class="item-name">${t('renderer.mcp.batch.menu.pickVisible')}</span><span class="item-hint">${t('renderer.mcp.batch.menu.pickVisibleHintDone', { count: visNew })}</span></span>
                   </button>`
            : allSelected
              ? `<button type="button" class="batch-menu-item dis" disabled>
                   <span class="item-info"><span class="item-name">${t('renderer.mcp.batch.menu.pickAll')}</span><span class="item-hint">${t('renderer.mcp.batch.menu.pickAllHint', { count: operable.length })}</span></span>
                 </button>`
              : `<button type="button" class="batch-menu-item" data-batch-action="pick-all">
                   <span class="item-info"><span class="item-name">${t('renderer.mcp.batch.menu.pickAll')}</span><span class="item-hint">${t('renderer.mcp.batch.menu.pickAllHint', { count: operable.length })}</span></span>
                 </button>`;
        const clearItem =
            selection.size > 0
                ? `<button type="button" class="batch-menu-item" data-batch-action="clear-sel">
                     <span class="item-info"><span class="item-name">${t('renderer.mcp.batch.menu.clear')}</span><span class="item-hint">${t('renderer.mcp.batch.menu.clearHint', { count: selection.size })}</span></span>
                   </button>`
                : '';

        const selectedServers = this.selectedServers();
        const allEnabled = selectedServers.length > 0 && selectedServers.every((server) => server.enabled);
        const allDisabled = selectedServers.length > 0 && selectedServers.every((server) => !server.enabled);
        const execItems =
            selection.size > 0
                ? `
                <button type="button" class="batch-menu-item ${allEnabled ? 'dis' : ''}" data-batch-action="enable-sel" ${allEnabled ? 'disabled' : ''}>
                  <span class="item-info"><span class="item-name">${t('renderer.mcp.batch.menu.enable')}</span><span class="item-hint">${t('renderer.mcp.batch.menu.enableHint', { count: selection.size })}</span></span>
                </button>
                <button type="button" class="batch-menu-item ${allDisabled ? 'dis' : ''}" data-batch-action="disable-sel" ${allDisabled ? 'disabled' : ''}>
                  <span class="item-info"><span class="item-name">${t('renderer.mcp.batch.menu.disable')}</span><span class="item-hint">${t('renderer.mcp.batch.menu.disableHint', { count: selection.size })}</span></span>
                </button>
                <button type="button" class="batch-menu-item" data-batch-action="delete-sel">
                  <span class="item-info"><span class="item-name" style="color:#DF4436;">${t('renderer.mcp.batch.menu.delete')}</span><span class="item-hint">${t('renderer.mcp.batch.menu.deleteHint', { count: selection.size })}</span></span>
                </button>`
                : `<div class="batch-menu-empty">${t('renderer.mcp.batch.menu.empty')}</div>`;

        return `
          <div class="batch-menu-section">
            <div class="batch-menu-head">${t('renderer.mcp.batch.menu.headPick')}</div>
            ${pickItem}
            ${clearItem}
          </div>
          <div class="batch-menu-section">
            <div class="batch-menu-head">${t('renderer.mcp.batch.menu.headExec')}</div>
            ${execItems}
          </div>`;
    }

    /** 展示名优先，未设置时回退到技术名 */
    private getServerLabel(server: McpServerState): string {
        return server.displayName || server.name;
    }

    private renderInstalledCard(server: McpServerState): string {
        const status = getStatusInfo(server.status, this._t);
        const label = this.getServerLabel(server);
        const desc =
            server.transport === 'stdio'
                ? `${server.command || ''} ${(server.args || []).join(' ')}`.trim()
                : server.url || '';

        // toggle 状态：enabled=true 但连接失败时显示警告样式
        const toggleError = server.enabled && server.status === 'error';
        const toggleClass = toggleError ? ' mcp-toggle-warn' : '';
        const toggleTitle = toggleError
            ? this._t('renderer.mcp.card.toggle.errorHint')
            : server.enabled
              ? this._t('renderer.mcp.card.toggle.disableHint')
              : this._t('renderer.mcp.card.toggle.enableHint');
        const scopeControl = server.readOnly
            ? `<span class="tag-pill tag-gray">${escapeHtml(server.source || server.providerId || '')}</span>`
            : server.agentIds !== undefined
              ? '<span class="tag-pill tag-gray">Agent</span>'
              : `<label class="mcp-toggle${toggleClass}" title="${toggleTitle}">
                    <input type="checkbox" data-toggle-id="${escapeHtml(server.id)}" ${server.enabled ? 'checked' : ''}>
                    <span class="mcp-toggle-slider"></span>
                </label>`;

        return `
        <div class="mcp-card installed-card ${this.installedSelection.has(server.id) ? 'sel' : ''}" data-server-id="${escapeHtml(server.id)}">
            ${this.renderBatchCheck(server)}
            <div class="card-header">
                ${this.renderIcon(label)}
                <div class="card-info">
                    <div class="card-title">${escapeHtml(label)}</div>
                    <div class="card-subtitle">${escapeHtml(desc || TRANSPORT_LABELS[server.transport] || server.transport)}</div>
                </div>
            </div>
            ${server.error ? `<div class="card-desc status-error">${escapeHtml(server.error)}</div>` : `<div class="card-desc">${escapeHtml(this._t('renderer.mcp.card.toolsCount', { count: server.tools?.length || 0 }))}${server.lastToolsChangedAt ? escapeHtml(this._t('renderer.mcp.card.toolsChangedSuffix')) : ''}</div>`}
            <div class="card-footer">
                <div class="card-meta">
                    <span class="tag-pill tag-blue">${escapeHtml(TRANSPORT_LABELS[server.transport] || server.transport)}</span>
                    <span class="status-line ${status.colorClass}"><span class="status-dot ${status.dotClass}"></span>${status.label}</span>
                </div>
                ${scopeControl}
            </div>
        </div>`;
    }

    render() {
        const installedPanel = this.shadowRoot?.getElementById('panel-installed') as HTMLElement | null;
        if (installedPanel) this.installedScrollTop = installedPanel.scrollTop;

        const effectiveTheme = this.getEffectiveTheme();
        syncShadowHostTheme(this, effectiveTheme as any);
        this.style.backgroundColor = effectiveTheme === 'dark' ? '#1e1e1e' : '#fff';

        const registryTabs = this.registries
            .map(
                (r) =>
                    `<button type="button" class="seg-item ${this.activeTab === r.id ? 'active' : ''}" data-tab="${escapeHtml(r.id)}"><span class="seg-icon">${escapeHtml(r.icon)}</span> ${escapeHtml(r.label)}</button>`
            )
            .join('');
        const tabsHtml =
            registryTabs +
            `<button type="button" class="seg-item ${this.activeTab === 'installed' ? 'active' : ''}" data-tab="installed"><span class="seg-icon">▣</span> ${escapeHtml(this._t('renderer.mcp.tab.installed'))}${this.servers.length > 0 ? ` <span class="seg-badge">${this.servers.length}</span>` : ''}</button>`;

        this.shadowRoot!.innerHTML = `
        <style>${STYLE}</style>
        <div class="header-area">
            <div class="header-title">${escapeHtml(this._t('renderer.mcp.title'))}</div>
            <div class="seg-row">
                <div class="seg-control-container">
                    <div class="seg-control">${tabsHtml}</div>
                </div>
                <div class="header-actions">
                    <button type="button" class="action-btn" id="refresh-btn" title="${escapeHtml(this._t('renderer.mcp.action.refresh'))}" ${this._refreshing ? 'disabled' : ''}>${this._refreshing ? '<span class="mini-spinner"></span>' : '↻'}</button>
                    <button type="button" class="action-btn" id="import-btn" title="${escapeHtml(this._t('renderer.mcp.action.import'))}">⇪</button>
                    <button type="button" class="action-btn" id="add-btn" title="${escapeHtml(this._t('renderer.mcp.action.add'))}">+</button>
                </div>
            </div>
        </div>
        ${this.localRuntimeMessage ? `<div class="runtime-banner">${escapeHtml(this.localRuntimeMessage)}</div>` : ''}
        <div class="content">
            <div class="tab-panel ${this.activeTab !== 'installed' ? 'active' : ''}" id="panel-registry">${this.activeTab !== 'installed' ? this.renderRegistryPanel(this.activeTab) : ''}</div>
            <div class="tab-panel ${this.activeTab === 'installed' ? 'active' : ''}" id="panel-installed">${this.renderInstalledPanel()}</div>
        </div>`;

        this.bindEvents();
        const nextInstalledPanel = this.shadowRoot!.getElementById('panel-installed') as HTMLElement | null;
        if (nextInstalledPanel) nextInstalledPanel.scrollTop = this.installedScrollTop;
        syncShadowHostTheme(this, effectiveTheme as any);
        requestAnimationFrame(() => {
            if (this.dataset.theme === effectiveTheme) this.style.backgroundColor = '';
        });
    }

    private bindEvents() {
        const root = this.shadowRoot!;
        root.querySelectorAll('[data-tab]').forEach((button) => {
            button.addEventListener('click', () => {
                const tab = (button as HTMLElement).dataset.tab;
                if (tab && tab !== this.activeTab) {
                    this.activeTab = tab;
                    // 切走时收起批量菜单：面板隐藏后点不到外面，菜单会一直挂成展开态
                    this.showBatchMenu = false;
                    if (tab !== 'installed') {
                        // 切换到 registry tab 时触发搜索
                        const isFirstSearch = !this.registryState.hasSearched || this.registryState.query === '';
                        if (isFirstSearch) this.searchRegistry('', 1);
                    }
                    this.render();
                }
            });
        });

        root.querySelector('#refresh-btn')?.addEventListener('click', () => this.refresh());
        root.querySelector('#add-btn')?.addEventListener('click', () => this.showServerModal('add'));
        root.querySelector('#import-btn')?.addEventListener('click', () => this.showImportModal());

        const registryId = this.activeTab !== 'installed' ? this.activeTab : '';
        const matrixInput = root.querySelector(
            `[data-search-tab="${CSS.escape(registryId)}"]`
        ) as HTMLInputElement | null;
        matrixInput?.addEventListener('input', () => {
            this.registryState.query = matrixInput.value;
        });
        matrixInput?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.isComposing) this.searchRegistry(matrixInput.value.trim(), 1);
        });
        root.querySelector(`[data-search-btn="${CSS.escape(registryId)}"]`)?.addEventListener('click', () =>
            this.searchRegistry(this.registryState.query.trim(), 1)
        );
        root.querySelector(`[data-clear-tab="${CSS.escape(registryId)}"]`)?.addEventListener('click', () => {
            // 搜索框本来就空时没有可清内容，避免无谓的重新拉取
            if (!this.registryState.query.trim()) return;
            this.registryState.query = '';
            if (matrixInput) matrixInput.value = '';
            void this.searchRegistry('', 1);
        });

        const installedInput = root.querySelector('[data-search-tab="installed"]') as HTMLInputElement | null;
        installedInput?.addEventListener('input', () => {
            this.installedQuery = installedInput.value;
        });
        installedInput?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.isComposing) this.syncInstalledPanel({ resetScroll: true });
        });
        root.querySelector('[data-search-btn="installed"]')?.addEventListener('click', () =>
            this.syncInstalledPanel({ resetScroll: true })
        );
        root.querySelector('[data-clear-tab="installed"]')?.addEventListener('click', () => {
            if (!this.installedQuery.trim()) return;
            this.installedQuery = '';
            if (installedInput) installedInput.value = '';
            this.syncInstalledPanel({ resetScroll: true });
        });

        this.bindRegistryCardEvents(root);
        this.bindInstalledCardEvents(root);
        this.bindBatchEvents(root);
        this.bindRegistrySentinel(root);
    }

    /** 注册源卡片的点击/安装：局部替换结果区后需要重新绑定 */
    private bindRegistryCardEvents(root: ParentNode) {
        root.querySelectorAll('[data-registry-mcp]').forEach((card) => {
            if ((card as HTMLElement).dataset.bound === '1') return;
            (card as HTMLElement).dataset.bound = '1';
            card.addEventListener('click', (event) => {
                if ((event.target as HTMLElement).closest('[data-install-registry]')) return;
                const id = (card as HTMLElement).dataset.registryMcp;
                if (id) this.showRegistryDetail(id);
            });
        });
        root.querySelectorAll('[data-install-registry]').forEach((button) => {
            if ((button as HTMLElement).dataset.bound === '1') return;
            (button as HTMLElement).dataset.bound = '1';
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                const id = (button as HTMLElement).dataset.installRegistry;
                if (id) void this.installRegistryMcp(id);
            });
        });
    }

    /** 已安装卡片的点击与启停开关：局部替换结果区后需要重新绑定 */
    private bindInstalledCardEvents(root: ParentNode) {
        root.querySelectorAll('[data-server-id]').forEach((card) => {
            if ((card as HTMLElement).dataset.bound === '1') return;
            (card as HTMLElement).dataset.bound = '1';
            card.addEventListener('click', (event) => {
                if ((event.target as HTMLElement).closest('.mcp-toggle')) return;
                if ((event.target as HTMLElement).closest('.batch-check')) return;
                const id = (card as HTMLElement).dataset.serverId;
                if (id) this.showServerDetail(id);
            });
        });
        root.querySelectorAll('[data-toggle-id]').forEach((input) => {
            if ((input as HTMLElement).dataset.bound === '1') return;
            (input as HTMLElement).dataset.bound = '1';
            input.addEventListener('click', (event) => {
                event.stopPropagation();
            });
            input.addEventListener('change', (event) => {
                const el = event.currentTarget as HTMLInputElement;
                if (el.dataset.toggleId) void this.handleToggleServer(el.dataset.toggleId, el.checked);
            });
        });
    }

    /** ⋯ 菜单、卡片勾选圈与已选托盘的交互：事件委托到面板根节点，重建后无需重绑 */
    private bindBatchEvents(root: ParentNode) {
        const panel = root.querySelector('#panel-installed') as HTMLElement | null;
        if (!panel || panel.dataset.batchDelegated === '1') return;
        panel.dataset.batchDelegated = '1';
        panel.addEventListener('click', (event) => {
            const target = event.target as HTMLElement;
            const moreBtn = target.closest('[data-more-scope]') as HTMLElement | null;
            // 点击菜单与 ⋯ 按钮以外的区域时收起菜单
            if (!moreBtn && this.showBatchMenu && !target.closest('.batch-dropdown-anchor')) {
                this.showBatchMenu = false;
                this.updateBatchDropdown();
            }
            if (moreBtn) {
                event.stopPropagation();
                this.showBatchMenu = !this.showBatchMenu;
                this.updateBatchDropdown();
                return;
            }
            const trayX = target.closest('[data-tray-remove]') as HTMLElement | null;
            if (trayX) {
                this.installedSelection.delete(trayX.dataset.trayRemove || '');
                this.syncBatchSelectionDom();
                return;
            }
            if (target.closest('[data-tray-clear]')) {
                this.clearSelection();
                return;
            }
            const item = target.closest('[data-batch-action]') as HTMLElement | null;
            if (!item) return;
            const action = item.dataset.batchAction;
            this.showBatchMenu = false;
            this.updateBatchDropdown();
            if (action === 'pick-all') this.pickAll();
            else if (action === 'pick-vis') this.pickVisible();
            else if (action === 'clear-sel') this.clearSelection();
            else if (action === 'enable-sel') void this.batchSetEnabled(true);
            else if (action === 'disable-sel') void this.batchSetEnabled(false);
            else if (action === 'delete-sel') void this.batchDeleteSelected();
        });
        panel.addEventListener('change', (event) => {
            const input = event.target as HTMLInputElement;
            if (!input || !input.dataset.batchCheck) return;
            const id = input.dataset.batchCheck;
            if (input.checked) this.installedSelection.add(id);
            else this.installedSelection.delete(id);
            input.closest('.mcp-card')?.classList.toggle('sel', input.checked);
            this.syncInstalledTray();
            this.syncBatchBadge();
            this.syncBatchMenu();
        });
    }

    /** 注册源无限滚动哨兵：结果区局部替换后需要重新观察 */
    private bindRegistrySentinel(root: ParentNode) {
        const sentinel = root.querySelector('[data-load-more="registry"]');
        if (!sentinel) return;
        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
                observer.disconnect();
                void this.loadMoreRegistry();
            }
        });
        observer.observe(sentinel);
    }

    /* ── 局部更新与批量操作 ── */

    /** 元素内容淡出 → 渲染新内容 → 淡入，避免整块区域闪动；同一元素的连续调用只应用最后一次 */
    private swapWithFade(el: HTMLElement, render: () => void, fade: boolean) {
        const pending = this._pendingSwaps.get(el);
        if (pending !== undefined) {
            clearTimeout(pending);
            this._pendingSwaps.delete(el);
        }
        if (!fade) {
            el.style.opacity = '';
            render();
            return;
        }
        el.style.opacity = '0';
        const timer = setTimeout(() => {
            this._pendingSwaps.delete(el);
            render();
            // 双 rAF 保证浏览器记录到 opacity:0 的起始帧，过渡才会生效
            requestAnimationFrame(() => requestAnimationFrame(() => (el.style.opacity = '1')));
        }, 120);
        this._pendingSwaps.set(el, timer);
    }

    /** 卸载时丢弃在途的结果区替换：否则定时器会继续操作已脱离文档的节点 */
    private cancelPendingSwaps() {
        for (const timer of this._pendingSwaps.values()) clearTimeout(timer);
        this._pendingSwaps.clear();
    }

    /** 刷新按钮忙碌态：按钮内换成小转圈并禁用，避免整页进入 loading */
    private setRefreshBusy(busy: boolean) {
        this._refreshing = busy;
        const btn = this.shadowRoot?.querySelector('#refresh-btn') as HTMLButtonElement | null;
        if (!btn) return;
        btn.disabled = busy;
        btn.innerHTML = busy ? '<span class="mini-spinner"></span>' : '↻';
    }

    /** 顶部刷新：只在按钮上转圈，结果区等数据回来后再局部淡入切换 */
    private async refresh() {
        if (this._refreshing) return;
        this.setRefreshBusy(true);
        try {
            if (this.activeTab !== 'installed') await this.searchRegistry(this.registryState.query.trim(), 1);
            else await this.loadServers({ silent: true });
        } finally {
            this.setRefreshBusy(false);
        }
    }

    /** 只同步顶部 tab 上的已安装数量徽标，不重建 header */
    private syncHeaderBadge() {
        const btn = this.shadowRoot?.querySelector('.seg-control .seg-item[data-tab="installed"]');
        if (!btn) return;
        const badge = btn.querySelector('.seg-badge');
        const count = this.servers.length;
        if (count > 0) {
            if (badge) badge.textContent = String(count);
            else btn.insertAdjacentHTML('beforeend', ` <span class="seg-badge">${count}</span>`);
        } else {
            badge?.remove();
        }
    }

    /** 搜索进行中/结束：只切搜索框、按钮与计数，结果区保持旧内容 */
    private syncRegistrySearchState() {
        const panel = this.shadowRoot?.querySelector('#panel-registry');
        if (!panel) return;
        const state = this.registryState;
        const input = panel.querySelector('.search-input') as HTMLInputElement | null;
        if (input) input.disabled = state.searching;
        const btn = panel.querySelector('.search-btn') as HTMLButtonElement | null;
        if (btn) {
            btn.disabled = state.searching;
            btn.textContent = state.searching
                ? this._t('renderer.mcp.search.searching')
                : this._t('renderer.mcp.search.button');
        }
        const wrap = panel.querySelector('.search-input-wrap');
        if (!wrap) return;
        const countHtml = this.registryCountHtml();
        const countTitle = !state.searching && state.message && !state.message.isError ? state.message.text : '';
        const count = wrap.querySelector('.search-count');
        if (!countHtml) {
            count?.remove();
        } else if (count) {
            count.innerHTML = countHtml;
            count.classList.toggle('is-busy', state.searching);
            if (countTitle) count.setAttribute('title', countTitle);
            else count.removeAttribute('title');
        } else {
            const clearBtn = wrap.querySelector('.search-clear');
            if (clearBtn) {
                const titleAttr = countTitle ? ` title="${escapeHtml(countTitle)}"` : '';
                clearBtn.insertAdjacentHTML(
                    'beforebegin',
                    `<span class="search-count ${state.searching ? 'is-busy' : ''}"${titleAttr}>${countHtml}</span>`
                );
            }
        }
        wrap.classList.toggle('has-count', Boolean(countHtml));
    }

    /** registry 结果区局部替换，不重建搜索框与 header */
    private syncRegistryPanel({ fade = true, resetScroll = false } = {}) {
        const registryId = this.activeTab;
        // 已切换回「已安装」时 registry 面板没有内容，不能把注册源结果写进去
        if (registryId === 'installed') return;
        const panel = this.shadowRoot?.querySelector('#panel-registry') as HTMLElement | null;
        const body = panel?.querySelector('.registry-body') as HTMLElement | null;
        if (!panel || !body) return;
        this.swapWithFade(
            body,
            () => {
                // 到点才取数据：淡出期间可能已经产生更新的结果
                body.innerHTML = this.renderRegistryBody(registryId);
                this.bindRegistryCardEvents(body);
                this.bindRegistrySentinel(body);
            },
            fade
        );
        if (resetScroll) panel.scrollTop = 0;
    }

    /** installed 结果区局部替换，搜索框、⋯ 菜单与已选托盘保持不动 */
    private syncInstalledPanel({ fade = true, resetScroll = false } = {}) {
        const panel = this.shadowRoot?.querySelector('#panel-installed') as HTMLElement | null;
        const body = panel?.querySelector('.panel-body') as HTMLElement | null;
        if (!panel || !body) return;
        if (this.loadingServers || this.serverError) {
            // 加载/错误态没有结果区，交给整页渲染处理
            this.render();
            return;
        }
        this.swapWithFade(
            body,
            () => {
                body.innerHTML = this.renderInstalledBody();
                this.bindInstalledCardEvents(body);
            },
            // 后台刷新可能发生在不可见面板上，此时不需要淡入淡出
            fade && panel.classList.contains('active')
        );
        // 只有搜索条件变化才回到顶部：后台状态推送不该把用户正在看的位置顶走
        if (resetScroll) panel.scrollTop = 0;
    }

    /** 已选托盘：为空时移除，否则原地增量维护芯片（避免重播入场动画） */
    private syncInstalledTray() {
        const panel = this.shadowRoot?.querySelector('#panel-installed');
        if (!panel) return;
        const selection = this.installedSelection;
        const existing = panel.querySelector('.batch-tray');
        if (!selection.size) {
            existing?.remove();
            return;
        }
        if (!existing) {
            const searchBar = panel.querySelector('.search-bar');
            if (searchBar) searchBar.insertAdjacentHTML('afterend', this.renderTrayHtml());
            return;
        }
        const label = existing.querySelector('.tray-label');
        if (label) label.innerHTML = this._t('renderer.mcp.batch.tray.label', { count: selection.size });
        const chips = existing.querySelector('.tray-chips');
        if (!chips) return;
        chips.querySelectorAll('[data-chip-id]').forEach((chip) => {
            if (!selection.has(chip.getAttribute('data-chip-id') || '')) chip.remove();
        });
        const present = new Set(
            [...chips.querySelectorAll('[data-chip-id]')].map((chip) => chip.getAttribute('data-chip-id'))
        );
        for (const id of selection) {
            if (present.has(id)) continue;
            const chipHtml = this.renderTrayChipHtml(id);
            if (chipHtml) chips.insertAdjacentHTML('beforeend', chipHtml);
        }
    }

    /** 同步 ⋯ 按钮上的已选数量角标 */
    private syncBatchBadge() {
        const btn = this.shadowRoot?.querySelector('#panel-installed .more-btn');
        if (!btn) return;
        const n = this.installedSelection.size;
        const badge = btn.querySelector('.more-badge');
        if (n > 0) {
            if (badge) badge.textContent = String(n);
            else btn.insertAdjacentHTML('beforeend', `<i class="more-badge">${n}</i>`);
        } else {
            badge?.remove();
        }
    }

    /** 菜单展开中时按最新选中集合重建内容 */
    private syncBatchMenu() {
        if (!this.showBatchMenu) return;
        const dd = this.shadowRoot?.querySelector('#panel-installed .batch-dropdown');
        if (dd) dd.innerHTML = this.batchDropdownItemsHtml();
    }

    private updateBatchDropdown() {
        const dd = this.shadowRoot?.querySelector('#panel-installed .batch-dropdown');
        if (!dd) return;
        if (this.showBatchMenu) dd.innerHTML = this.batchDropdownItemsHtml();
        dd.classList.toggle('visible', this.showBatchMenu);
    }

    /** 勾选/托盘/菜单变化后的局部同步，避免整体重渲染丢失滚动位置 */
    private syncBatchSelectionDom() {
        this.shadowRoot?.querySelectorAll('[data-batch-check]').forEach((el) => {
            const input = el as HTMLInputElement;
            const checked = this.installedSelection.has(input.dataset.batchCheck || '');
            input.checked = checked;
            input.closest('.mcp-card')?.classList.toggle('sel', checked);
        });
        this.syncInstalledTray();
        this.syncBatchBadge();
        this.syncBatchMenu();
    }

    private pickAll() {
        for (const server of this.servers) if (this.canOperate(server)) this.installedSelection.add(server.id);
        this.syncBatchSelectionDom();
    }

    private pickVisible() {
        for (const server of this.getFilteredServers()) {
            if (this.canOperate(server)) this.installedSelection.add(server.id);
        }
        this.syncBatchSelectionDom();
    }

    private clearSelection() {
        this.installedSelection.clear();
        this.syncBatchSelectionDom();
    }

    /** 批量启停：只作用于选中且未处于目标态的条目；一次批量接口调用，失败明细在结束后提示 */
    private async batchSetEnabled(enabled: boolean) {
        const targets = this.selectedServers().filter(
            (server) => this.canOperate(server) && server.enabled !== enabled
        );
        if (!targets.length) {
            this.clearSelection();
            return;
        }
        let result: McpBatchOperationResult = { changed: 0, failed: [] };
        try {
            result = await getAPI().callMainWorld<McpBatchOperationResult>(
                'setServersEnabled',
                targets.map((server) => server.id),
                enabled
            );
        } catch (err: any) {
            result = {
                changed: 0,
                failed: targets.map((server) => ({ id: server.id, error: err?.message || String(err) }))
            };
        }
        this.clearSelection();
        // 以主进程落盘结果为准重新拉取列表（局部更新，不整页重渲染）
        await this.loadServers({ silent: true });
        if (result.failed.length > 0) await this.showBatchFailure(result.failed);
    }

    /** 批量删除：先确认，再一次批量接口调用完成删除并汇总失败明细 */
    private async batchDeleteSelected() {
        const targets = this.selectedServers().filter((server) => this.canOperate(server));
        if (!targets.length) return;
        const confirmed = await showConfirmModal({
            icon: 'fa-trash-can',
            iconBg: '#FEF2F2',
            iconColor: '#DC2626',
            title: this._t('renderer.mcp.batch.delete.title'),
            message: this._t('renderer.mcp.batch.delete.message', { count: targets.length }),
            confirmText: this._t('renderer.mcp.detail.delete'),
            cancelText: this._t('renderer.mcp.form.cancel'),
            danger: true,
            mountTarget: this.shadowRoot!
        });
        if (!confirmed) return;
        const ids = targets.map((server) => server.id);
        let result: McpBatchOperationResult = { changed: 0, failed: [] };
        try {
            result = await getAPI().callMainWorld<McpBatchOperationResult>('deleteServers', ids);
        } catch (err: any) {
            result = { changed: 0, failed: ids.map((id) => ({ id, error: err?.message || String(err) })) };
        }
        if (this.selectedServerId && ids.includes(this.selectedServerId)) this.selectedServerId = null;
        this.clearSelection();
        await this.loadServers({ silent: true });
        if (result.failed.length > 0) await this.showBatchFailure(result.failed);
    }

    private async showBatchFailure(failed: McpBatchFailure[]) {
        const detailHtml = failed
            .slice(0, 3)
            .map((item) => `<div>${escapeHtml(item.id)}: ${escapeHtml(item.error)}</div>`)
            .join('');
        const message =
            escapeHtml(this._t('renderer.mcp.batch.failed', { count: failed.length })) +
            (detailHtml ? `<div class="batch-failure-detail">${detailHtml}</div>` : '');
        await showConfirmModal({
            icon: 'fa-circle-xmark',
            iconBg: '#FEF2F2',
            iconColor: '#DC2626',
            title: this._t('renderer.mcp.confirm.actionFailed.title'),
            message,
            confirmText: this._t('renderer.mcp.confirm.acknowledge'),
            cancelText: null,
            mountTarget: this.shadowRoot!
        });
    }

    private buildMetaGrid(items: { label: string; value?: string | number | boolean }[]): string {
        const filtered = items.filter((item) => item.value !== undefined && item.value !== '');
        if (filtered.length === 0) return '';
        return `<div class="detail-section"><div class="detail-section-label">${escapeHtml(this._t('renderer.mcp.detail.section.meta'))}</div><div class="detail-meta-grid">${filtered
            .map(
                (item) =>
                    `<div class="detail-meta-item"><div class="meta-label">${escapeHtml(item.label)}</div><div class="meta-value">${escapeHtml(String(item.value))}</div></div>`
            )
            .join('')}</div></div>`;
    }

    private showRegistryDetail(id: string) {
        const mcp = this.registryState.results.find((item) => item.id === id);
        if (!mcp) return;
        const meta = this.buildMetaGrid([
            { label: this._t('renderer.mcp.detail.meta.source'), value: mcp.source },
            { label: this._t('renderer.mcp.detail.meta.author'), value: mcp.author },
            { label: this._t('renderer.mcp.detail.meta.deployType'), value: mcp.deployType },
            { label: this._t('renderer.mcp.detail.meta.repository'), value: mcp.repository },
            { label: this._t('renderer.mcp.detail.meta.downloads'), value: mcp.downloads },
            { label: this._t('renderer.mcp.detail.meta.stars'), value: mcp.stars },
            { label: this._t('renderer.mcp.detail.meta.views'), value: mcp.views },
            { label: this._t('renderer.mcp.detail.meta.updated'), value: mcp.updateTime }
        ]);
        const configHtml = mcp.configuration
            ? `<div class="detail-section"><div class="detail-section-label">${escapeHtml(this._t('renderer.mcp.detail.section.config'))}</div><pre class="detail-code">${escapeHtml(mcp.configuration)}</pre></div>`
            : '';
        const footer = `<button type="button" class="btn btn-sm" id="detail-close-secondary">${escapeHtml(this._t('renderer.mcp.detail.close'))}</button><button type="button" class="btn btn-primary btn-sm" id="detail-install-registry" ${!mcp.canInstall ? 'disabled' : ''}>${escapeHtml(this._t('renderer.mcp.detail.installMcp'))}</button>`;
        this.showDetailDialog({
            title: mcp.displayName || mcp.name || mcp.id,
            subtitle: mcp.name || mcp.id,
            iconName: mcp.name || mcp.id,
            logo: mcp.logo,
            body: `${mcp.description ? `<div class="detail-section"><div class="detail-section-label">${escapeHtml(this._t('renderer.mcp.detail.section.intro'))}</div><div class="detail-desc">${escapeHtml(mcp.description)}</div></div>` : ''}${meta}${configHtml}`,
            footer,
            onBind: (overlay) => {
                overlay.querySelector('#detail-install-registry')?.addEventListener('click', () => {
                    this.removeDetailDialog();
                    this.installRegistryMcp(mcp.id);
                });
            }
        });
    }

    private showServerDetail(id: string) {
        const server = this.servers.find((item) => item.id === id);
        if (!server) return;
        this.selectedServerId = id;
        const status = getStatusInfo(server.status, this._t);
        const envEntries = Object.entries(server.env || {});
        const headerEntries = Object.entries(server.headers || {});
        const meta = this.buildMetaGrid([
            {
                label: this._t('renderer.mcp.detail.meta.transport'),
                value: TRANSPORT_LABELS[server.transport] || server.transport
            },
            { label: this._t('renderer.mcp.detail.meta.status'), value: status.label },
            {
                label: this._t('renderer.mcp.detail.meta.enabled'),
                value: server.enabled ? this._t('renderer.mcp.detail.meta.yes') : this._t('renderer.mcp.detail.meta.no')
            },
            { label: this._t('renderer.mcp.detail.meta.source'), value: server.source },
            { label: 'Agent ID', value: server.agentIds?.join(', ') },
            { label: this._t('renderer.mcp.detail.meta.toolCount'), value: server.tools?.length || 0 },
            { label: this._t('renderer.mcp.detail.meta.refreshCount'), value: server.toolsChangedCount },
            { label: this._t('renderer.mcp.detail.meta.lastToolChange'), value: server.lastToolsChangedAt }
        ]);
        const commandHtml =
            server.transport === 'stdio'
                ? `<div class="detail-section"><div class="detail-section-label">${escapeHtml(this._t('renderer.mcp.detail.section.command'))}</div><pre class="detail-code">${escapeHtml(`${server.command || ''} ${(server.args || []).join(' ')}`.trim())}</pre></div>${server.cwd ? `<div class="detail-section"><div class="detail-section-label">${escapeHtml(this._t('renderer.mcp.detail.section.cwd'))}</div><pre class="detail-code">${escapeHtml(server.cwd)}</pre></div>` : ''}`
                : `<div class="detail-section"><div class="detail-section-label">URL</div><pre class="detail-code">${escapeHtml(server.url || '-')}</pre></div>`;
        const envHtml =
            envEntries.length > 0
                ? `<div class="detail-section"><div class="detail-section-label">${escapeHtml(this._t('renderer.mcp.detail.section.env'))}</div><pre class="detail-code">${escapeHtml(envEntries.map(([key, value]) => `${key}=${value}`).join('\n'))}</pre></div>`
                : '';
        const headerHtml =
            headerEntries.length > 0
                ? `<div class="detail-section"><div class="detail-section-label">${escapeHtml(this._t('renderer.mcp.detail.section.headers'))}</div><pre class="detail-code">${escapeHtml(headerEntries.map(([key, value]) => `${key}: ${value}`).join('\n'))}</pre></div>`
                : '';
        const errorHtml = server.error
            ? `<div class="detail-section"><div class="detail-section-label">${escapeHtml(this._t('renderer.mcp.detail.section.error'))}</div><div class="detail-desc status-error">${escapeHtml(server.error)}</div></div>`
            : '';
        const toolsHtml = this.renderTools(server.tools || []);
        const mutableActions =
            server.agentIds === undefined
                ? `<button type="button" class="btn btn-sm" id="detail-edit">${escapeHtml(this._t('renderer.mcp.detail.edit'))}</button><button type="button" class="btn btn-danger btn-sm" id="detail-delete">${escapeHtml(this._t('renderer.mcp.detail.delete'))}</button>`
                : '';
        const footer = server.readOnly
            ? `<button type="button" class="btn btn-sm" id="detail-close-secondary">${escapeHtml(this._t('renderer.mcp.detail.done'))}</button>`
            : `
                ${server.status === 'connected' || server.status === 'error' ? `<button type="button" class="btn btn-sm" id="detail-reconnect">${escapeHtml(this._t('renderer.mcp.detail.reconnect'))}</button>` : ''}
                ${mutableActions}
                <button type="button" class="btn btn-sm" id="detail-close-secondary">${escapeHtml(this._t('renderer.mcp.detail.done'))}</button>`;

        this.showDetailDialog({
            title: this.getServerLabel(server),
            subtitle: server.displayName ? server.name : server.id,
            iconName: this.getServerLabel(server),
            body: `${errorHtml}${meta}${commandHtml}${envHtml}${headerHtml}${toolsHtml}`,
            footer,
            onBind: (overlay) => {
                overlay.querySelector('#detail-edit')?.addEventListener('click', () => {
                    this.removeDetailDialog();
                    this.showServerModal('edit', server);
                });
                overlay.querySelector('#detail-delete')?.addEventListener('click', () => {
                    this.removeDetailDialog();
                    this.handleDeleteServer(server.id);
                });
                overlay
                    .querySelector('#detail-reconnect')
                    ?.addEventListener('click', () => this.handleReconnectServer(server.id));
            }
        });
    }

    private renderTools(tools: { name: string; description: string; inputSchema?: object }[]): string {
        if (tools.length === 0) {
            return `<div class="detail-section"><div class="detail-section-label">${escapeHtml(this._t('renderer.mcp.detail.section.tools'))}</div><div class="empty-state" style="padding:24px 20px"><div class="empty-title">${escapeHtml(this._t('renderer.mcp.detail.tools.empty'))}</div></div></div>`;
        }
        return `<div class="detail-section"><div class="detail-section-label">${escapeHtml(this._t('renderer.mcp.detail.section.toolsWithCount', { count: tools.length }))}</div><div class="detail-tools-list">${tools
            .map((tool) => {
                const schema = tool.inputSchema as any;
                const properties = schema?.properties || {};
                const required = schema?.required || [];
                const params = Object.entries(properties)
                    .map(([name, prop]: [string, any]) => {
                        const type = prop?.type || 'any';
                        const req = required.includes(name) ? '*' : '';
                        return `<span class="tag-pill ${required.includes(name) ? 'tag-orange' : 'tag-gray'}">${escapeHtml(name)}: ${escapeHtml(type)}${req}</span>`;
                    })
                    .join('');
                return `<div class="detail-tool-item"><div class="detail-tool-name">${escapeHtml(tool.name)}</div>${tool.description ? `<div class="detail-tool-desc">${escapeHtml(tool.description)}</div>` : ''}${params ? `<div class="detail-tool-params">${params}</div>` : ''}</div>`;
            })
            .join('')}</div></div>`;
    }

    private showDetailDialog(options: {
        title: string;
        subtitle?: string;
        iconName: string;
        logo?: string;
        body: string;
        footer: string;
        onBind?: (overlay: HTMLElement) => void;
        /** 是否允许点击遮罩关闭；带表单填写的弹窗应传 false 防止误关丢失输入 */
        dismissOnOverlay?: boolean;
    }) {
        this.removeDetailDialog();
        const overlay = document.createElement('div');
        overlay.className = 'detail-overlay od-overlay visible';
        overlay.id = 'detail-overlay';
        overlay.innerHTML = `
        <div class="detail-dialog">
            <div class="detail-header info">
                ${this.renderIcon(options.iconName, options.logo)}
                <div class="detail-header-info">
                    <div class="detail-name">${escapeHtml(options.title)}</div>
                    ${options.subtitle ? `<div class="detail-id">${escapeHtml(options.subtitle)}</div>` : ''}
                </div>
                <button type="button" class="detail-close" id="detail-close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
            </div>
            <div class="detail-body">${options.body}</div>
            <div class="detail-footer">${options.footer}</div>
        </div>`;
        bindOverlayDismiss(overlay, () => this.removeDetailDialog(), undefined, options.dismissOnOverlay !== false);
        overlay.querySelector('#detail-close')?.addEventListener('click', () => this.removeDetailDialog());
        overlay.querySelector('#detail-close-secondary')?.addEventListener('click', () => this.removeDetailDialog());
        this.shadowRoot!.appendChild(overlay);
        options.onBind?.(overlay);
    }

    private removeDetailDialog() {
        this.shadowRoot?.getElementById('detail-overlay')?.remove();
    }

    private showServerModal(mode: 'add' | 'edit', server?: McpServerState) {
        const transport = server?.transport || (this.localRuntimeAvailable ? 'stdio' : 'streamableHttp');
        const envEntries = Object.entries(server?.env || {});
        const headerText = Object.entries(server?.headers || {})
            .map(([key, value]) => `${key}: ${value}`)
            .join('\n');
        const renderEnvItems = () => {
            if (envEntries.length === 0) {
                return `<div class="env-empty-hint">${escapeHtml(this._t('renderer.mcp.env.empty'))}</div>`;
            }
            return envEntries
                .map(
                    ([key, value]) => `
                <div class="env-item">
                    <input type="text" class="env-key-input" value="${escapeHtml(key)}" placeholder="${escapeHtml(this._t('renderer.mcp.env.keyPlaceholder'))}" />
                    <span class="env-sep">=</span>
                    <input type="text" class="env-value-input" value="${escapeHtml(value)}" placeholder="${escapeHtml(this._t('renderer.mcp.env.valuePlaceholder'))}" />
                    <button type="button" class="env-remove-btn" title="${escapeHtml(this._t('renderer.mcp.env.remove'))}">×</button>
                </div>`
                )
                .join('');
        };

        const body = `
        <form id="server-form" class="form-body">
            <div class="form-row">
                <label>${escapeHtml(this._t('renderer.mcp.form.name'))}</label>
                <input id="f-name" value="${escapeHtml(server?.displayName || server?.name || '')}" placeholder="${escapeHtml(this._t('renderer.mcp.form.name.placeholder'))}" />
            </div>
            <div class="form-row">
                <label>${escapeHtml(this._t('renderer.mcp.form.transport'))}</label>
                <div class="transport-options">
                    ${(['stdio', 'sse', 'streamableHttp'] as const)
                        .map(
                            (item) =>
                                `<label class="transport-option"><input type="radio" name="transport" value="${item}" ${transport === item ? 'checked' : ''} ${item === 'stdio' && !this.localRuntimeAvailable ? 'disabled' : ''}><span>${TRANSPORT_LABELS[item]}</span></label>`
                        )
                        .join('')}
                </div>
            </div>
            <div id="fields-stdio" class="form-body" style="${transport === 'stdio' ? '' : 'display:none'}">
                <div class="form-row"><label>${escapeHtml(this._t('renderer.mcp.form.command'))}</label><input id="f-command" value="${escapeHtml(server?.command || '')}" placeholder="npx / node / python / uvx" /></div>
                <div class="form-row"><label>${escapeHtml(this._t('renderer.mcp.form.args'))}</label><textarea id="f-args" rows="3">${escapeHtml((server?.args || []).join('\n'))}</textarea></div>
                <div class="form-row"><label>${escapeHtml(this._t('renderer.mcp.form.cwd'))}</label><input id="f-cwd" value="${escapeHtml(server?.cwd || '')}" /></div>
                <div class="form-row">
                    <label>${escapeHtml(this._t('renderer.mcp.form.env'))}</label>
                    <div id="env-list" class="env-list">${renderEnvItems()}</div>
                    <button type="button" id="add-env-btn" class="env-add-btn">${escapeHtml(this._t('renderer.mcp.form.addEnv'))}</button>
                </div>
            </div>
            <div id="fields-http" class="form-body" style="${transport === 'stdio' ? 'display:none' : ''}">
                <div class="form-row"><label>URL</label><input id="f-url" value="${escapeHtml(server?.url || '')}" placeholder="https://example.com/mcp" /></div>
                <div class="form-row"><label>${escapeHtml(this._t('renderer.mcp.form.headers'))}</label><textarea id="f-headers" rows="2">${escapeHtml(headerText)}</textarea></div>
            </div>
            <div id="form-error" class="form-error"></div>
        </form>`;
        const footer = `<button type="button" class="btn btn-sm" id="detail-close-secondary">${escapeHtml(this._t('renderer.mcp.form.cancel'))}</button><button type="submit" form="server-form" class="btn btn-primary btn-sm" ${this.saving ? 'disabled' : ''}>${mode === 'add' ? escapeHtml(this._t('renderer.mcp.form.add')) : escapeHtml(this._t('renderer.mcp.form.save'))}</button>`;
        this.showDetailDialog({
            title: mode === 'add' ? this._t('renderer.mcp.form.addTitle') : this._t('renderer.mcp.form.editTitle'),
            subtitle: mode === 'add' ? this._t('renderer.mcp.form.addSubtitle') : server?.id,
            iconName: server?.name || 'MCP',
            body,
            footer,
            // 服务器编辑弹窗包含表单输入，禁用遮罩关闭防止误关丢失输入
            dismissOnOverlay: false,
            onBind: (overlay) => {
                overlay.querySelectorAll('input[name="transport"]').forEach((radio) => {
                    radio.addEventListener('change', () => {
                        const value = (radio as HTMLInputElement).value;
                        (overlay.querySelector('#fields-stdio') as HTMLElement).style.display =
                            value === 'stdio' ? '' : 'none';
                        (overlay.querySelector('#fields-http') as HTMLElement).style.display =
                            value === 'stdio' ? 'none' : '';
                    });
                });

                // 环境变量增删事件
                const envList = overlay.querySelector('#env-list') as HTMLElement;
                overlay.querySelector('#add-env-btn')?.addEventListener('click', () => {
                    this.addEnvItem(envList);
                });
                envList?.addEventListener('click', (e) => {
                    const target = e.target as HTMLElement;
                    if (target.classList.contains('env-remove-btn') || target.closest('.env-remove-btn')) {
                        (target.closest('.env-item') as HTMLElement)?.remove();
                        this.refreshEnvEmptyHint(envList);
                    }
                });

                overlay.querySelector('#server-form')?.addEventListener('submit', (event) => {
                    event.preventDefault();
                    this.handleSaveServer(overlay, mode, server?.id);
                });
            }
        });
    }

    private addEnvItem(envList: HTMLElement) {
        const item = document.createElement('div');
        item.className = 'env-item';
        item.innerHTML = `
            <input type="text" class="env-key-input" placeholder="${escapeHtml(this._t('renderer.mcp.env.keyPlaceholder'))}" />
            <span class="env-sep">=</span>
            <input type="text" class="env-value-input" placeholder="${escapeHtml(this._t('renderer.mcp.env.valuePlaceholder'))}" />
            <button type="button" class="env-remove-btn" title="${escapeHtml(this._t('renderer.mcp.env.remove'))}">×</button>`;
        envList.appendChild(item);
        this.refreshEnvEmptyHint(envList);
    }

    private refreshEnvEmptyHint(envList: HTMLElement) {
        const existing = envList.querySelector('.env-empty-hint');
        const hasItems = envList.querySelectorAll('.env-item').length > 0;
        if (hasItems && existing) {
            existing.remove();
        } else if (!hasItems && !existing) {
            const hint = document.createElement('div');
            hint.className = 'env-empty-hint';
            hint.textContent = this._t('renderer.mcp.env.empty');
            envList.appendChild(hint);
        }
    }

    private showImportModal() {
        const body = `
        <form id="import-form" class="form-body">
            <div class="detail-section" style="margin:0">
                <div class="detail-desc">${escapeHtml(this._t('renderer.mcp.import.desc'))}</div>
            </div>
            <div class="form-row">
                <label>${escapeHtml(this._t('renderer.mcp.import.label'))}</label>
                <textarea id="f-import-json" rows="9" placeholder='{ "mcpServers": { "server-name": { "command": "npx", "args": [] } } }'></textarea>
            </div>
            <div id="import-error" class="form-error"></div>
        </form>`;
        const footer = `<button type="button" class="btn btn-sm" id="detail-close-secondary">${escapeHtml(this._t('renderer.mcp.form.cancel'))}</button><button type="submit" form="import-form" class="btn btn-primary btn-sm">${escapeHtml(this._t('renderer.mcp.import.button'))}</button>`;
        this.showDetailDialog({
            title: this._t('renderer.mcp.import.title'),
            subtitle: 'JSON',
            iconName: 'MCP',
            body,
            footer,
            // 导入弹窗包含 textarea 表单输入，禁用遮罩关闭防止误关丢失输入
            dismissOnOverlay: false,
            onBind: (overlay) => {
                overlay.querySelector('#import-form')?.addEventListener('submit', async (event) => {
                    event.preventDefault();
                    const value = (overlay.querySelector('#f-import-json') as HTMLTextAreaElement).value.trim();
                    const error = overlay.querySelector('#import-error') as HTMLElement;
                    if (!value) {
                        error.textContent = this._t('renderer.mcp.import.emptyError');
                        error.classList.add('visible');
                        return;
                    }
                    try {
                        await getAPI().callMainWorld('importFromJson', value);
                        this.removeDetailDialog();
                        await this.loadServers();
                    } catch (err: any) {
                        error.textContent = err.message || this._t('renderer.mcp.import.failed');
                        error.classList.add('visible');
                    }
                });
            }
        });
    }

    private parseKvLines(text: string, sep: string): Record<string, string> {
        const result: Record<string, string> = {};
        for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const idx = trimmed.indexOf(sep);
            if (idx > 0) result[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + sep.length).trim();
        }
        return result;
    }

    private async handleSaveServer(overlay: HTMLElement, mode: 'add' | 'edit', existingId?: string) {
        const error = overlay.querySelector('#form-error') as HTMLElement;
        const name = (overlay.querySelector('#f-name') as HTMLInputElement).value.trim();
        const transport = (overlay.querySelector('input[name="transport"]:checked') as HTMLInputElement)
            ?.value as McpServerState['transport'];
        if (!name) {
            error.textContent = this._t('renderer.mcp.form.error.nameRequired');
            error.classList.add('visible');
            return;
        }
        // 从注册表安装的 server 有展示名：表单里编辑的是展示名，技术名（用于工具命名空间）保持不变
        const editingServer = mode === 'edit' ? this.servers.find((item) => item.id === existingId) : undefined;
        const config: any = editingServer?.displayName
            ? { displayName: name, transport, enabled: true }
            : { name, transport, enabled: true };
        if (transport === 'stdio') {
            const command = (overlay.querySelector('#f-command') as HTMLInputElement).value.trim();
            if (!command) {
                error.textContent = this._t('renderer.mcp.form.error.commandRequired');
                error.classList.add('visible');
                return;
            }
            config.command = command;
            config.args = (overlay.querySelector('#f-args') as HTMLTextAreaElement).value
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean);
            const cwd = (overlay.querySelector('#f-cwd') as HTMLInputElement).value.trim();
            if (cwd) config.cwd = cwd;
        } else {
            const url = (overlay.querySelector('#f-url') as HTMLInputElement).value.trim();
            if (!url) {
                error.textContent = this._t('renderer.mcp.form.error.urlRequired');
                error.classList.add('visible');
                return;
            }
            config.url = url;
            const headers = this.parseKvLines((overlay.querySelector('#f-headers') as HTMLTextAreaElement).value, ':');
            if (Object.keys(headers).length > 0) config.headers = headers;
        }
        // 从 key-value 对编辑器收集环境变量
        if (transport === 'stdio') {
            const env: Record<string, string> = {};
            overlay.querySelectorAll('.env-item').forEach((item) => {
                const key = (item.querySelector('.env-key-input') as HTMLInputElement)?.value?.trim();
                const value = (item.querySelector('.env-value-input') as HTMLInputElement)?.value ?? '';
                if (key) env[key] = value;
            });
            if (Object.keys(env).length > 0) config.env = env;
        }

        try {
            this.saving = true;
            if (mode === 'add') await getAPI().callMainWorld('addServer', config);
            else await getAPI().callMainWorld('updateServer', existingId, config);
            this.removeDetailDialog();
            await this.loadServers();
        } catch (err: any) {
            error.textContent = err.message || this._t('renderer.mcp.form.error.saveFailed');
            error.classList.add('visible');
        } finally {
            this.saving = false;
        }
    }

    private async installRegistryMcp(id: string) {
        const mcp = this.registryState.results.find((item) => item.id === id);
        if (!mcp || !mcp.installUrl) return;
        try {
            this.installingId = id;
            this.render();
            await getAPI().callMainWorld('installFromRegistry', mcp.installUrl, false);
            this.activeTab = 'installed';
            await this.loadServers();
        } catch (err: any) {
            await showConfirmModal({
                icon: 'fa-circle-xmark',
                iconBg: '#FEF2F2',
                iconColor: '#DC2626',
                title: this._t('renderer.mcp.confirm.installFailed.title'),
                message: escapeHtml(err.message || err),
                confirmText: this._t('renderer.mcp.confirm.acknowledge'),
                cancelText: null,
                mountTarget: this.shadowRoot!
            });
        } finally {
            this.installingId = null;
            this.render();
        }
    }

    private async handleDeleteServer(id: string) {
        const server = this.servers.find((item) => item.id === id);
        if (!server) return;
        const confirmed = await showConfirmModal({
            icon: 'fa-trash-can',
            iconBg: '#FEF2F2',
            iconColor: '#DC2626',
            title: this._t('renderer.mcp.confirm.delete.title'),
            message: this._t('renderer.mcp.confirm.delete.message', { name: escapeHtml(server.name) }),
            confirmText: this._t('renderer.mcp.detail.delete'),
            cancelText: this._t('renderer.mcp.form.cancel'),
            danger: true,
            mountTarget: this.shadowRoot!
        });
        if (!confirmed) return;
        try {
            await getAPI().callMainWorld('deleteServer', id);
            if (this.selectedServerId === id) this.selectedServerId = null;
            await this.loadServers();
        } catch (err: any) {
            await showConfirmModal({
                icon: 'fa-circle-xmark',
                iconBg: '#FEF2F2',
                iconColor: '#DC2626',
                title: this._t('renderer.mcp.confirm.deleteFailed.title'),
                message: escapeHtml(err.message || err),
                confirmText: this._t('renderer.mcp.confirm.acknowledge'),
                cancelText: null,
                mountTarget: this.shadowRoot!
            });
        }
    }

    private async handleToggleServer(id: string, enabled: boolean) {
        const server = this.servers.find((item) => item.id === id);
        if (server) {
            server.enabled = enabled;
            this.render();
        }
        try {
            await getAPI().callMainWorld('toggleServer', id, enabled);
        } catch (err: any) {
            if (server) server.enabled = !enabled;
            this.render();
            await showConfirmModal({
                icon: 'fa-circle-xmark',
                iconBg: '#FEF2F2',
                iconColor: '#DC2626',
                title: this._t('renderer.mcp.confirm.actionFailed.title'),
                message: escapeHtml(err.message || err),
                confirmText: this._t('renderer.mcp.confirm.acknowledge'),
                cancelText: null,
                mountTarget: this.shadowRoot!
            });
        }
    }

    private async handleReconnectServer(id: string) {
        try {
            await getAPI().call('reconnectServer', id);
            await this.loadServers();
        } catch (err: any) {
            await showConfirmModal({
                icon: 'fa-circle-xmark',
                iconBg: '#FEF2F2',
                iconColor: '#DC2626',
                title: this._t('renderer.mcp.confirm.reconnectFailed.title'),
                message: escapeHtml(err.message || err),
                confirmText: this._t('renderer.mcp.confirm.acknowledge'),
                cancelText: null,
                mountTarget: this.shadowRoot!
            });
        }
    }
}

customElements.define('mcpmgr-entry-widget', McpMgrEntryWidget);
