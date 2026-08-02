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

import { AgentOperableHTMLElement, RendererTool, RendererToolset } from '../../widget_utils.js';
import { z } from 'zod';
import { escapeHtml } from '../../../../common/utils/escape.js';
import { OPENDESK_THEME_CHANGED } from '../../../../renderer/theme/theme-iframe-bridge.ts';
import { syncShadowHostTheme } from '../../../../renderer/theme/theme-shadow-overrides.ts';
import { showConfirmModal } from '../../../../renderer/components/confirmModal';

interface McpServerState {
    id: string;
    name: string;
    transport: 'stdio' | 'sse' | 'streamableHttp';
    enabled: boolean;
    command?: string;
    args?: string[];
    cwd?: string;
    url?: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
    source?: string;
    registryId?: string;
    registryMcpId?: string;
    agentIds?: string[];
    status: 'disconnected' | 'connecting' | 'connected' | 'error';
    error?: string;
    tools: { name: string; description: string; inputSchema?: object }[];
    toolsChangedCount?: number;
    lastToolsChangedAt?: string;
}

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

const STATUS_CONFIG: Record<string, { label: string; colorClass: string; dotClass: string }> = {
    connected: { label: '已连接', colorClass: 'status-ok', dotClass: 'dot-ok' },
    connecting: { label: '连接中', colorClass: 'status-warn', dotClass: 'dot-warn' },
    disconnected: { label: '未连接', colorClass: 'status-muted', dotClass: 'dot-muted' },
    error: { label: '连接失败', colorClass: 'status-error', dotClass: 'dot-error' }
};

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
    text-align: center; padding: 28px 20px 24px;
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
    display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.18);
    z-index: 10000; align-items: center; justify-content: center;
    backdrop-filter: blur(8px); animation: fade-in 0.15s ease;
}
.detail-overlay.visible { display: flex; }
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
.detail-dialog {
    background: #fff; border-radius: 18px; padding: 0;
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
    display: flex; align-items: center; gap: 14px;
    padding: 20px 24px 16px; border-bottom: 1px solid #F0F0F0;
}
.detail-header-info { flex: 1; min-width: 0; }
.detail-name { font-size: 17px; font-weight: 700; color: #1d1d1f; margin-bottom: 2px; }
.detail-id { font-size: var(--fs-md); color: #999; word-break: break-all; }
.detail-close {
    width: 28px; height: 28px; border-radius: 50%; border: none;
    background: #F5F5F5; color: #999; font-size: var(--fs-xl); cursor: pointer;
    display: flex; align-items: center; justify-content: center;
}
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
:host([data-theme="dark"]) .mcp-card,
:host([data-theme="dark"]) .detail-dialog {
    background: #252526;
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
:host([data-theme="dark"]) .detail-overlay {
    background: rgba(0,0,0,0.55);
}
:host([data-theme="dark"]) .tag-blue { background: rgba(96,165,250,0.15); color: #93c5fd; }
:host([data-theme="dark"]) .tag-green { background: rgba(74,222,128,0.15); color: #86efac; }
:host([data-theme="dark"]) .tag-orange { background: rgba(251,191,36,0.15); color: #fcd34d; }
:host([data-theme="dark"]) .tag-gray { background: rgba(255,255,255,0.08); color: #999; }
`;

function unwrapResult<T>(result: unknown): T {
    if (result && typeof result === 'object' && 'status' in result) {
        const wrapped = result as { status?: string; data?: T; message?: string };
        if (wrapped.status === 'error') throw new Error(wrapped.message || '操作失败');
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
        unsubscribe: (eventName: string, callback: () => void) => api.unsubscribe(eventName, callback)
    };
}

class McpMgrEntryWidget extends AgentOperableHTMLElement {
    private registries: { id: string; label: string; icon: string; slogan: string }[] = [];
    private activeTab: string = 'installed';
    private servers: McpServerState[] = [];
    private loadingServers = true;
    private serverError = '';
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
    private _onServersUpdated: (() => void) | null = null;
    private _onThemeChange: ((e: any) => void) | null = null;

    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this._onThemeChange = (e: any) => syncShadowHostTheme(this, e.detail?.effective);
    }

    connectedCallback() {
        this.render();
        document.addEventListener(OPENDESK_THEME_CHANGED, this._onThemeChange as EventListener);
        this._onServersUpdated = () => this.loadServers();
        getAPI().subscribe('serversUpdated', this._onServersUpdated);
        this.loadServers();
        this.loadRegistries();
    }

    disconnectedCallback() {
        if (this._onServersUpdated) {
            getAPI().unsubscribe('serversUpdated', this._onServersUpdated);
            this._onServersUpdated = null;
        }
        document.removeEventListener(OPENDESK_THEME_CHANGED, this._onThemeChange as EventListener);
    }

    getAgentInstruct(): string {
        return (
            '你是 MCP 管理助手。用户可以通过你添加、管理和使用 MCP（Model Context Protocol）服务。' +
            '当前页面展示 MCP 广场和用户已安装 MCP 的连接状态、配置与可用工具。'
        );
    }

    getToolset(): RendererToolset {
        const toolset = new RendererToolset('mcpmgr');
        const listTool = new RendererTool(
            'listMcpServers',
            '获取当前已注册的所有 MCP 的名称、类型、连接状态和可用工具数量',
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

    async loadServers() {
        this.serverError = '';
        try {
            this.servers = await getAPI().call<McpServerState[]>('getServers');
        } catch (err: any) {
            this.servers = [];
            this.serverError = err.message || '加载 MCP 失败';
        } finally {
            this.loadingServers = false;
            this.render();
        }
    }

    async loadRegistries() {
        try {
            this.registries =
                await getAPI().callMainWorld<{ id: string; label: string; icon: string; slogan: string }[]>(
                    'getMcpRegistries'
                );
            // 默认选中第一个 registry
            if (this.registries.length > 0 && this.activeTab === 'installed') {
                this.activeTab = this.registries[0].id;
                this.searchRegistry('', 1);
            }
        } catch {
            this.registries = [];
        }
        this.render();
    }

    async searchRegistry(query = this.registryState.query, page = 1) {
        const registryId = this.activeTab !== 'installed' ? this.activeTab : '';
        if (!registryId) return;
        const state = this.registryState;
        const isNewSearch = page === 1;
        state.query = query;
        state.page = page;
        state.searching = true;
        // 新搜索时清空旧结果，确保 loading 状态能正确显示
        if (isNewSearch) {
            state.results = [];
            state.message = null;
        }
        state.message = null;
        // 新搜索需要全量重建面板（此时在顶部，无滚动位置问题）
        if (isNewSearch) this.render();
        try {
            const result = await getAPI().callMainWorld<{
                mcps: RegistryMcp[];
                total?: number;
                hasMore?: boolean;
                message?: string;
            }>('searchMcpRegistry', registryId, query, page, 30);
            state.results = result.mcps || [];
            state.total = result.total || state.results.length;
            state.hasMore = Boolean(result.hasMore);
            state.hasSearched = true;
            state.message = result.message ? { text: result.message, isError: false } : null;
        } catch (err: any) {
            state.results = [];
            state.total = 0;
            state.hasMore = false;
            state.hasSearched = true;
            state.message = { text: err.message || '搜索失败', isError: true };
        } finally {
            state.searching = false;
            // 新搜索才全量重建
            if (isNewSearch) this.render();
        }
    }

    async loadMoreRegistry() {
        const state = this.registryState;
        const registryId = this.activeTab !== 'installed' ? this.activeTab : '';
        if (!registryId || state.loadingMore || state.searching || !state.hasMore) return;
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
            state.loadingMore = false;
            this.updateLoadingMore(false);
        }
    }

    /** 只更新 loading-more 区域的显示状态，必要时重建 sentinel 观察 */
    private updateLoadingMore(loading: boolean) {
        const root = this.shadowRoot;
        if (!root) return;
        const loadingEl = root.getElementById('loading-more');
        if (loadingEl) {
            loadingEl.innerHTML = loading
                ? '<div class="loading-spinner" style="margin:0 auto 8px;width:20px;height:20px;"></div>加载更多…'
                : this.registryState.hasMore
                  ? '向下滚动加载更多'
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
        const message = state.message
            ? `<div class="registry-msg ${state.message.isError ? 'error' : ''}">${escapeHtml(state.message.text)}</div>`
            : '';
        let content = '';

        if (state.searching && state.results.length === 0) {
            content = `<div class="loading-state"><div class="loading-spinner"></div><span>加载中…</span></div>`;
        } else if (state.results.length === 0) {
            const icon = registry?.icon || '◇';
            content = `<div class="empty-state"><div class="empty-icon">${escapeHtml(icon)}</div><div class="empty-title">${state.hasSearched ? '未找到 MCP' : '暂无 MCP'}</div><div class="empty-hint">可以搜索 ${escapeHtml(label)} 中的 MCP server</div></div>`;
        } else {
            const hero = !state.query ? `<div class="hero-title">${escapeHtml(label)}</div>` : '';
            content = `
                ${hero}
                <div class="mcp-grid">
                    ${state.results.map((mcp) => this.renderRegistryCard(mcp)).join('')}
                </div>
                ${state.hasMore ? `<div class="loading-more" id="loading-more">${state.loadingMore ? '<div class="loading-spinner" style="margin:0 auto 8px;width:20px;height:20px;"></div>加载更多…' : '向下滚动加载更多'}</div><div class="scroll-sentinel" data-load-more="registry"></div>` : ''}
            `;
        }

        return `
        <div class="registry-panel">
            <div class="search-bar">
                <div class="search-input-wrap">
                    <input type="text" class="search-input" data-search-tab="${escapeHtml(registryId)}" placeholder="搜索 ${escapeHtml(label)}…" value="${escapeHtml(state.query)}" />
                    <button type="button" class="search-clear" data-clear-tab="${escapeHtml(registryId)}" title="清除搜索">×</button>
                </div>
                <button type="button" class="search-btn" data-search-btn="${escapeHtml(registryId)}" ${state.searching ? 'disabled' : ''}>搜索</button>
            </div>
            ${message}
            ${content}
        </div>`;
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
                ${this.renderIcon(mcp.name || mcp.displayName || mcp.id, mcp.logo)}
                <div class="card-info">
                    <div class="card-title">${escapeHtml(mcp.displayName || mcp.name || mcp.id)}</div>
                    <div class="card-subtitle">${escapeHtml(mcp.name || mcp.author || 'Matrix MCP')}</div>
                </div>
            </div>
            ${mcp.description ? `<div class="card-desc">${escapeHtml(mcp.description)}</div>` : ''}
            <div class="card-footer">
                <div class="card-meta">${tagHtml || `<span class="tag-pill tag-gray">${escapeHtml(mcp.source)}</span>`}</div>
                <button type="button" class="btn btn-primary btn-sm" data-install-registry="${escapeHtml(mcp.id)}" ${!mcp.canInstall || installing ? 'disabled' : ''}>${installing ? '安装中…' : '安装'}</button>
            </div>
        </div>`;
    }

    private getFilteredServers(): McpServerState[] {
        const query = this.installedQuery.trim().toLowerCase();
        if (!query) return this.servers;
        return this.servers.filter((server) => {
            const haystack = [
                server.name,
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
            return `<div class="registry-panel"><div class="loading-state"><div class="loading-spinner"></div><span>加载中…</span></div></div>`;
        }
        if (this.serverError) {
            return `<div class="registry-panel"><div class="empty-state"><div class="empty-icon">!</div><div class="empty-title">${escapeHtml(this.serverError)}</div></div></div>`;
        }
        const filtered = this.getFilteredServers();
        const content =
            this.servers.length === 0
                ? `<div class="empty-state"><div class="empty-icon">◇</div><div class="empty-title">暂无已安装 MCP</div><div class="empty-hint">可从 Matrix MCPs 安装，或点击右上角添加</div></div>`
                : filtered.length === 0
                  ? `<div class="empty-state"><div class="empty-icon">⌕</div><div class="empty-title">未找到匹配的 MCP</div><div class="empty-hint">换个关键词试试</div></div>`
                  : `<div class="hero-title">已安装 ${this.servers.length} 个 MCP</div><div class="mcp-grid">${filtered.map((server) => this.renderInstalledCard(server)).join('')}</div>`;

        return `
        <div class="registry-panel">
            <div class="search-bar">
                <div class="search-input-wrap">
                    <input type="text" class="search-input" data-search-tab="installed" placeholder="搜索已安装 MCP…" value="${escapeHtml(this.installedQuery)}" />
                    <button type="button" class="search-clear" data-clear-tab="installed" title="清除搜索">×</button>
                </div>
                <button type="button" class="search-btn" data-search-btn="installed">搜索</button>
            </div>
            ${content}
        </div>`;
    }

    private renderInstalledCard(server: McpServerState): string {
        const status = STATUS_CONFIG[server.status] || STATUS_CONFIG.disconnected;
        const desc =
            server.transport === 'stdio'
                ? `${server.command || ''} ${(server.args || []).join(' ')}`.trim()
                : server.url || '';

        // toggle 状态：enabled=true 但连接失败时显示警告样式
        const toggleError = server.enabled && server.status === 'error';
        const toggleClass = toggleError ? ' mcp-toggle-warn' : '';
        const toggleTitle = toggleError
            ? '已启用但连接失败，点击禁用'
            : server.enabled
              ? '已启用，点击禁用'
              : '已禁用，点击启用';
        const scopeControl =
            server.agentIds !== undefined
                ? '<span class="tag-pill tag-gray">Agent</span>'
                : `<label class="mcp-toggle${toggleClass}" title="${toggleTitle}">
                    <input type="checkbox" data-toggle-id="${escapeHtml(server.id)}" ${server.enabled ? 'checked' : ''}>
                    <span class="mcp-toggle-slider"></span>
                </label>`;

        return `
        <div class="mcp-card installed-card" data-server-id="${escapeHtml(server.id)}">
            <div class="card-header">
                ${this.renderIcon(server.name)}
                <div class="card-info">
                    <div class="card-title">${escapeHtml(server.name)}</div>
                    <div class="card-subtitle">${escapeHtml(desc || TRANSPORT_LABELS[server.transport] || server.transport)}</div>
                </div>
            </div>
            ${server.error ? `<div class="card-desc status-error">${escapeHtml(server.error)}</div>` : `<div class="card-desc">${server.tools?.length || 0} 个工具${server.lastToolsChangedAt ? '，已响应工具列表变更通知' : ''}</div>`}
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
            `<button type="button" class="seg-item ${this.activeTab === 'installed' ? 'active' : ''}" data-tab="installed"><span class="seg-icon">▣</span> 已安装MCP${this.servers.length > 0 ? ` <span class="seg-badge">${this.servers.length}</span>` : ''}</button>`;

        this.shadowRoot!.innerHTML = `
        <style>${STYLE}</style>
        <div class="header-area">
            <div class="header-title">MCP管理</div>
            <div class="seg-row">
                <div class="seg-control-container">
                    <div class="seg-control">${tabsHtml}</div>
                </div>
                <div class="header-actions">
                    <button type="button" class="action-btn" id="refresh-btn" title="刷新">↻</button>
                    <button type="button" class="action-btn" id="import-btn" title="导入 JSON">⇪</button>
                    <button type="button" class="action-btn" id="add-btn" title="添加 MCP">+</button>
                </div>
            </div>
        </div>
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
                    if (tab !== 'installed') {
                        // 切换到 registry tab 时触发搜索
                        const isFirstSearch = !this.registryState.hasSearched || this.registryState.query === '';
                        if (isFirstSearch) this.searchRegistry('', 1);
                    }
                    this.render();
                }
            });
        });

        root.querySelector('#refresh-btn')?.addEventListener('click', () => {
            if (this.activeTab !== 'installed') this.searchRegistry(this.registryState.query, 1);
            else this.loadServers();
        });
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
        root.querySelector(`[data-clear-tab="${CSS.escape(registryId)}"]`)?.addEventListener('click', () =>
            this.searchRegistry('', 1)
        );

        const installedInput = root.querySelector('[data-search-tab="installed"]') as HTMLInputElement | null;
        installedInput?.addEventListener('input', () => {
            this.installedQuery = installedInput.value;
        });
        installedInput?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.isComposing) this.render();
        });
        root.querySelector('[data-search-btn="installed"]')?.addEventListener('click', () => this.render());
        root.querySelector('[data-clear-tab="installed"]')?.addEventListener('click', () => {
            this.installedQuery = '';
            this.render();
        });

        root.querySelectorAll('[data-registry-mcp]').forEach((card) => {
            (card as HTMLElement).dataset.bound = '1';
            card.addEventListener('click', (event) => {
                if ((event.target as HTMLElement).closest('[data-install-registry]')) return;
                const id = (card as HTMLElement).dataset.registryMcp;
                if (id) this.showRegistryDetail(id);
            });
        });
        root.querySelectorAll('[data-install-registry]').forEach((button) => {
            (button as HTMLElement).dataset.bound = '1';
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                const id = (button as HTMLElement).dataset.installRegistry;
                if (id) this.installRegistryMcp(id);
            });
        });
        root.querySelectorAll('[data-server-id]').forEach((card) => {
            card.addEventListener('click', (event) => {
                if ((event.target as HTMLElement).closest('.mcp-toggle')) return;
                const id = (card as HTMLElement).dataset.serverId;
                if (id) this.showServerDetail(id);
            });
        });
        root.querySelectorAll('[data-toggle-id]').forEach((input) => {
            input.addEventListener('click', (event) => {
                event.stopPropagation();
            });
            input.addEventListener('change', (event) => {
                const el = event.currentTarget as HTMLInputElement;
                if (el.dataset.toggleId) this.handleToggleServer(el.dataset.toggleId, el.checked);
            });
        });

        const sentinel = root.querySelector('[data-load-more="registry"]');
        if (sentinel) {
            const observer = new IntersectionObserver((entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    observer.disconnect();
                    this.loadMoreRegistry();
                }
            });
            observer.observe(sentinel);
        }
    }

    private buildMetaGrid(items: { label: string; value?: string | number | boolean }[]): string {
        const filtered = items.filter((item) => item.value !== undefined && item.value !== '');
        if (filtered.length === 0) return '';
        return `<div class="detail-section"><div class="detail-section-label">元信息</div><div class="detail-meta-grid">${filtered
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
            { label: '来源', value: mcp.source },
            { label: '作者', value: mcp.author },
            { label: '部署类型', value: mcp.deployType },
            { label: '仓库', value: mcp.repository },
            { label: '下载', value: mcp.downloads },
            { label: '收藏', value: mcp.stars },
            { label: '浏览', value: mcp.views },
            { label: '更新时间', value: mcp.updateTime }
        ]);
        const configHtml = mcp.configuration
            ? `<div class="detail-section"><div class="detail-section-label">MCP 配置</div><pre class="detail-code">${escapeHtml(mcp.configuration)}</pre></div>`
            : '';
        const footer = `<button type="button" class="btn btn-sm" id="detail-close-secondary">关闭</button><button type="button" class="btn btn-primary btn-sm" id="detail-install-registry" ${!mcp.canInstall ? 'disabled' : ''}>安装 MCP</button>`;
        this.showDetailDialog({
            title: mcp.displayName || mcp.name || mcp.id,
            subtitle: mcp.name || mcp.id,
            iconName: mcp.name || mcp.id,
            logo: mcp.logo,
            body: `${mcp.description ? `<div class="detail-section"><div class="detail-section-label">简介</div><div class="detail-desc">${escapeHtml(mcp.description)}</div></div>` : ''}${meta}${configHtml}`,
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
        const status = STATUS_CONFIG[server.status] || STATUS_CONFIG.disconnected;
        const envEntries = Object.entries(server.env || {});
        const headerEntries = Object.entries(server.headers || {});
        const meta = this.buildMetaGrid([
            { label: '传输', value: TRANSPORT_LABELS[server.transport] || server.transport },
            { label: '状态', value: status.label },
            { label: '启用', value: server.enabled ? '是' : '否' },
            { label: '来源', value: server.source },
            { label: 'Agent ID', value: server.agentIds?.join(', ') },
            { label: '工具数量', value: server.tools?.length || 0 },
            { label: '通知刷新次数', value: server.toolsChangedCount },
            { label: '最近工具变更', value: server.lastToolsChangedAt }
        ]);
        const commandHtml =
            server.transport === 'stdio'
                ? `<div class="detail-section"><div class="detail-section-label">命令</div><pre class="detail-code">${escapeHtml(`${server.command || ''} ${(server.args || []).join(' ')}`.trim())}</pre></div>${server.cwd ? `<div class="detail-section"><div class="detail-section-label">工作目录</div><pre class="detail-code">${escapeHtml(server.cwd)}</pre></div>` : ''}`
                : `<div class="detail-section"><div class="detail-section-label">URL</div><pre class="detail-code">${escapeHtml(server.url || '-')}</pre></div>`;
        const envHtml =
            envEntries.length > 0
                ? `<div class="detail-section"><div class="detail-section-label">环境变量</div><pre class="detail-code">${escapeHtml(envEntries.map(([key, value]) => `${key}=${value}`).join('\n'))}</pre></div>`
                : '';
        const headerHtml =
            headerEntries.length > 0
                ? `<div class="detail-section"><div class="detail-section-label">请求头</div><pre class="detail-code">${escapeHtml(headerEntries.map(([key, value]) => `${key}: ${value}`).join('\n'))}</pre></div>`
                : '';
        const errorHtml = server.error
            ? `<div class="detail-section"><div class="detail-section-label">错误</div><div class="detail-desc status-error">${escapeHtml(server.error)}</div></div>`
            : '';
        const toolsHtml = this.renderTools(server.tools || []);
        const mutableActions =
            server.agentIds === undefined
                ? '<button type="button" class="btn btn-sm" id="detail-edit">编辑</button><button type="button" class="btn btn-danger btn-sm" id="detail-delete">删除</button>'
                : '';
        const footer = `
            ${server.status === 'connected' || server.status === 'error' ? '<button type="button" class="btn btn-sm" id="detail-reconnect">重新连接</button>' : ''}
            ${mutableActions}
            <button type="button" class="btn btn-sm" id="detail-close-secondary">完成</button>`;

        this.showDetailDialog({
            title: server.name,
            subtitle: server.id,
            iconName: server.name,
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
            return `<div class="detail-section"><div class="detail-section-label">可用工具</div><div class="empty-state" style="padding:24px 20px"><div class="empty-title">暂无工具</div></div></div>`;
        }
        return `<div class="detail-section"><div class="detail-section-label">可用工具 (${tools.length})</div><div class="detail-tools-list">${tools
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
    }) {
        this.removeDetailDialog();
        const overlay = document.createElement('div');
        overlay.className = 'detail-overlay visible';
        overlay.id = 'detail-overlay';
        overlay.innerHTML = `
        <div class="detail-dialog">
            <div class="detail-header">
                ${this.renderIcon(options.iconName, options.logo)}
                <div class="detail-header-info">
                    <div class="detail-name">${escapeHtml(options.title)}</div>
                    ${options.subtitle ? `<div class="detail-id">${escapeHtml(options.subtitle)}</div>` : ''}
                </div>
                <button type="button" class="detail-close" id="detail-close">×</button>
            </div>
            <div class="detail-body">${options.body}</div>
            <div class="detail-footer">${options.footer}</div>
        </div>`;
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) this.removeDetailDialog();
        });
        overlay.querySelector('#detail-close')?.addEventListener('click', () => this.removeDetailDialog());
        overlay.querySelector('#detail-close-secondary')?.addEventListener('click', () => this.removeDetailDialog());
        this.shadowRoot!.appendChild(overlay);
        options.onBind?.(overlay);
    }

    private removeDetailDialog() {
        this.shadowRoot?.getElementById('detail-overlay')?.remove();
    }

    private showServerModal(mode: 'add' | 'edit', server?: McpServerState) {
        const transport = server?.transport || 'stdio';
        const envEntries = Object.entries(server?.env || {});
        const headerText = Object.entries(server?.headers || {})
            .map(([key, value]) => `${key}: ${value}`)
            .join('\n');
        const renderEnvItems = () => {
            if (envEntries.length === 0) {
                return '<div class="env-empty-hint">暂无环境变量</div>';
            }
            return envEntries
                .map(
                    ([key, value]) => `
                <div class="env-item">
                    <input type="text" class="env-key-input" value="${escapeHtml(key)}" placeholder="变量名" />
                    <span class="env-sep">=</span>
                    <input type="text" class="env-value-input" value="${escapeHtml(value)}" placeholder="变量值" />
                    <button type="button" class="env-remove-btn" title="移除">×</button>
                </div>`
                )
                .join('');
        };

        const body = `
        <form id="server-form" class="form-body">
            <div class="form-row">
                <label>名称</label>
                <input id="f-name" value="${escapeHtml(server?.name || '')}" placeholder="例如 filesystem" />
            </div>
            <div class="form-row">
                <label>传输方式</label>
                <div class="transport-options">
                    ${(['stdio', 'sse', 'streamableHttp'] as const)
                        .map(
                            (item) =>
                                `<label class="transport-option"><input type="radio" name="transport" value="${item}" ${transport === item ? 'checked' : ''}><span>${TRANSPORT_LABELS[item]}</span></label>`
                        )
                        .join('')}
                </div>
            </div>
            <div id="fields-stdio" class="form-body" style="${transport === 'stdio' ? '' : 'display:none'}">
                <div class="form-row"><label>命令</label><input id="f-command" value="${escapeHtml(server?.command || '')}" placeholder="npx / node / python / uvx" /></div>
                <div class="form-row"><label>参数（每行一个）</label><textarea id="f-args" rows="3">${escapeHtml((server?.args || []).join('\n'))}</textarea></div>
                <div class="form-row"><label>工作目录（可选）</label><input id="f-cwd" value="${escapeHtml(server?.cwd || '')}" /></div>
                <div class="form-row">
                    <label>环境变量</label>
                    <div id="env-list" class="env-list">${renderEnvItems()}</div>
                    <button type="button" id="add-env-btn" class="env-add-btn">+ 添加环境变量</button>
                </div>
            </div>
            <div id="fields-http" class="form-body" style="${transport === 'stdio' ? 'display:none' : ''}">
                <div class="form-row"><label>URL</label><input id="f-url" value="${escapeHtml(server?.url || '')}" placeholder="https://example.com/mcp" /></div>
                <div class="form-row"><label>请求头（Key: Value）</label><textarea id="f-headers" rows="2">${escapeHtml(headerText)}</textarea></div>
            </div>
            <div id="form-error" class="form-error"></div>
        </form>`;
        const footer = `<button type="button" class="btn btn-sm" id="detail-close-secondary">取消</button><button type="submit" form="server-form" class="btn btn-primary btn-sm" ${this.saving ? 'disabled' : ''}>${mode === 'add' ? '添加' : '保存'}</button>`;
        this.showDetailDialog({
            title: mode === 'add' ? '添加 MCP' : '编辑 MCP',
            subtitle: mode === 'add' ? '手动配置 MCP server' : server?.id,
            iconName: server?.name || 'MCP',
            body,
            footer,
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
            <input type="text" class="env-key-input" placeholder="变量名" />
            <span class="env-sep">=</span>
            <input type="text" class="env-value-input" placeholder="变量值" />
            <button type="button" class="env-remove-btn" title="移除">×</button>`;
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
            hint.textContent = '暂无环境变量';
            envList.appendChild(hint);
        }
    }

    private showImportModal() {
        const body = `
        <form id="import-form" class="form-body">
            <div class="detail-section" style="margin:0">
                <div class="detail-desc">粘贴 Claude Desktop、Cursor 等工具的 MCP 配置 JSON。</div>
            </div>
            <div class="form-row">
                <label>JSON 配置</label>
                <textarea id="f-import-json" rows="9" placeholder='{ "mcpServers": { "server-name": { "command": "npx", "args": [] } } }'></textarea>
            </div>
            <div id="import-error" class="form-error"></div>
        </form>`;
        const footer = `<button type="button" class="btn btn-sm" id="detail-close-secondary">取消</button><button type="submit" form="import-form" class="btn btn-primary btn-sm">导入</button>`;
        this.showDetailDialog({
            title: '导入 MCP 配置',
            subtitle: 'JSON',
            iconName: 'MCP',
            body,
            footer,
            onBind: (overlay) => {
                overlay.querySelector('#import-form')?.addEventListener('submit', async (event) => {
                    event.preventDefault();
                    const value = (overlay.querySelector('#f-import-json') as HTMLTextAreaElement).value.trim();
                    const error = overlay.querySelector('#import-error') as HTMLElement;
                    if (!value) {
                        error.textContent = '请粘贴 JSON 配置';
                        error.classList.add('visible');
                        return;
                    }
                    try {
                        await getAPI().callMainWorld('importFromJson', value);
                        this.removeDetailDialog();
                        await this.loadServers();
                    } catch (err: any) {
                        error.textContent = err.message || '导入失败';
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
            error.textContent = '请输入名称';
            error.classList.add('visible');
            return;
        }
        const config: any = { name, transport, enabled: true };
        if (transport === 'stdio') {
            const command = (overlay.querySelector('#f-command') as HTMLInputElement).value.trim();
            if (!command) {
                error.textContent = '请输入命令';
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
                error.textContent = '请输入 URL';
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
            error.textContent = err.message || '保存失败';
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
                title: '安装失败',
                message: escapeHtml(err.message || err),
                confirmText: '我知道了',
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
            title: '删除 MCP',
            message: `确定要删除 MCP「<b>${escapeHtml(server.name)}</b>」吗？`,
            confirmText: '删除',
            cancelText: '取消',
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
                title: '删除失败',
                message: escapeHtml(err.message || err),
                confirmText: '我知道了',
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
                title: '操作失败',
                message: escapeHtml(err.message || err),
                confirmText: '我知道了',
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
                title: '重连失败',
                message: escapeHtml(err.message || err),
                confirmText: '我知道了',
                cancelText: null,
                mountTarget: this.shadowRoot!
            });
        }
    }
}

customElements.define('mcpmgr-entry-widget', McpMgrEntryWidget);
