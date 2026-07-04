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

import { createRendererTranslator } from '../locale.ts';

class SettingPanel extends HTMLElement {
    constructor() {
        super();
        this.currentData = null;
        this.providerTemplates = [];
        this._saveTimeout = null;
        this._saveDelay = 600;
        this._saving = false;
        this._pendingSave = false;
        this._editingProviderIndex = -1;
        this._editingModelIndex = -1;
        this.appVersion = null;
        this._activeTab = 'models';
        this._environEntries = [];
        this.gatewayHostOptions = [];
        this._hasRendered = false;
        this._t = createRendererTranslator();
    }

    connectedCallback() {
        (async () => {
            await this.loadData();
            this.render();
            this.setUpEventListeners();
        })();
    }

    async loadData() {
        this.currentData = await window.settingAPI.loadSettingObject();
        this._t = createRendererTranslator(this.currentData);
        this.providerTemplates = await window.settingAPI.getProviderTemplates();
        try {
            this.gatewayHostOptions = await window.settingAPI.getGatewayHostOptions();
        } catch (e) {
            console.warn('Failed to load gateway host options:', e);
            this.gatewayHostOptions = [
                { value: 'none', label: '无（关闭监听服务）' },
                { value: '127.0.0.1', label: '127.0.0.1（仅本机）' },
                { value: '0.0.0.0', label: '0.0.0.0（所有 IPv4 地址）' }
            ];
        }
        try {
            this.appVersion = await window.settingAPI.getVersion();
        } catch (e) {
            console.warn('Failed to load version:', e);
        }
    }

    render() {
        if (this._hasRendered) {
            this._switchTab(this._activeTab);
            return;
        }
        const tabs = [
            { id: 'models', icon: 'fa-brain', label: '模型设置' },
            { id: 'tasks', icon: 'fa-list-check', label: '任务设置' },
            { id: 'search', icon: 'fa-magnifying-glass', label: '搜索设置' },
            { id: 'general', icon: 'fa-sliders', label: '通用设置' }
        ];

        const tabButtons = tabs
            .map((t) => {
                const active = t.id === this._activeTab;
                return `<button class="seg-item ${active ? 'active' : ''}" data-tab="${t.id}">
                <i class="fas ${t.icon} seg-icon"></i> ${t.label}
            </button>`;
            })
            .join('');

        this.innerHTML = `
        <style>
            /* ═══ CSS Variables ═══ */
            :root {
                --sp-color-primary: #6366f1;
                --sp-color-primary-hover: #4f46e5;
                --sp-color-primary-light: #eef2ff;
                --sp-color-text: #111827;
                --sp-color-text-secondary: #6b7280;
                --sp-color-text-tertiary: #9ca3af;
                --sp-color-border: #e5e7eb;
                --sp-color-border-light: #f3f4f6;
                --sp-color-bg: #ffffff;
                --sp-color-bg-page: #f9fafb;
                --sp-color-success: #10b981;
                --sp-color-danger: #ef4444;
                --sp-color-warning: #f59e0b;
                --sp-radius-sm: 6px;
                --sp-radius-md: 8px;
                --sp-radius-lg: 12px;
                --sp-radius-xl: 16px;
                --sp-shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
                --sp-shadow-md: 0 4px 6px -1px rgba(0,0,0,0.07), 0 2px 4px -2px rgba(0,0,0,0.05);
                --sp-font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            }

            /* Dark theme overrides — use app-level variables */
            html[data-theme='dark'] {
                --sp-color-primary: var(--od-accent, #818cf8);
                --sp-color-primary-hover: color-mix(in srgb, var(--od-accent, #818cf8) 80%, white);
                --sp-color-primary-light: color-mix(in srgb, var(--od-accent, #818cf8) 15%, transparent);
                --sp-color-text: var(--od-text, #e5e7eb);
                --sp-color-text-secondary: var(--od-text-muted, #9ca3af);
                --sp-color-text-tertiary: var(--od-text-disabled, #6b7280);
                --sp-color-border: var(--od-border-strong, #374151);
                --sp-color-border-light: var(--od-border, #1f2937);
                --sp-color-bg: var(--od-bg-elevated, #1f2937);
                --sp-color-bg-page: var(--od-bg, #111827);
                --sp-shadow-sm: 0 1px 2px rgba(0,0,0,0.3);
                --sp-shadow-md: 0 4px 6px -1px rgba(0,0,0,0.4), 0 2px 4px -2px rgba(0,0,0,0.3);
            }

            /* ── Segmented Control (Tabs) — keep as is ── */
            .seg-control {
                display: inline-flex; min-width: 0;
                background: var(--sp-seg-control-bg, rgba(0, 0, 0, 0.04));
                border-radius: 10px; padding: 3px; gap: 2px;
            }
            .seg-item {
                padding: 7px 13px; border-radius: 8px; border: none;
                background: transparent; color: var(--sp-seg-item-color, rgba(0, 0, 0, 0.44));
                font-size: 12px; font-weight: 500; cursor: pointer;
                transition: all 0.22s cubic-bezier(0.4, 0, 0.2, 1);
                white-space: nowrap;
                display: inline-flex; align-items: center; gap: 5px; line-height: 1;
            }
            .seg-item:hover {
                color: var(--sp-seg-item-hover-color, rgba(0, 0, 0, 0.64));
                background: var(--sp-seg-item-hover-bg, transparent);
            }
            .seg-item:focus-visible {
                outline: 2px solid var(--od-accent);
                outline-offset: 2px;
            }
            .seg-item.active {
                background: var(--sp-seg-active-bg, #fff);
                color: var(--sp-seg-active-color, #1d1d1f);
                box-shadow: var(--sp-seg-active-shadow, 0 1px 3px rgba(0,0,0,0.06), 0 0.5px 1px rgba(0,0,0,0.03));
            }
            .seg-item .seg-icon { font-size: 13px; }
            html[data-theme='dark'] setting-panel {
                --sp-seg-control-bg: rgba(255, 255, 255, 0.08);
                --sp-seg-item-color: var(--od-text-muted);
                --sp-seg-item-hover-color: var(--od-text);
                --sp-seg-item-hover-bg: rgba(255, 255, 255, 0.06);
                --sp-seg-active-bg: rgba(255, 255, 255, 0.14);
                --sp-seg-active-color: var(--od-text);
                --sp-seg-active-shadow: 0 1px 4px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(255,255,255,0.08);
            }

            /* ── Section ── */
            .sp-section {
                margin-bottom: 24px;
            }
            .sp-section-card {
                background: var(--sp-color-bg);
                border: 1px solid var(--sp-color-border);
                border-radius: var(--sp-radius-lg);
                padding: 20px;
            }
            .sp-section-title {
                font-size: 14px;
                font-weight: 600;
                color: var(--sp-color-text);
                margin-bottom: 12px;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .sp-section-subtitle {
                font-size: 12px;
                color: var(--sp-color-text-secondary);
                margin-left: 4px;
                font-weight: 400;
            }
            .sp-section-desc {
                font-size: 13px;
                color: var(--sp-color-text-secondary);
                margin-bottom: 20px;
            }
            .sp-section-divider {
                border: none;
                border-top: 1px solid var(--sp-color-border);
                margin: 20px 0;
            }

            /* ── Form Elements ── */
            .sp-form-group { margin-bottom: 16px; }
            .sp-form-label {
                display: block;
                font-size: 13px;
                font-weight: 600;
                color: var(--sp-color-text);
                margin-bottom: 4px;
            }
            .sp-form-label .sp-required {
                color: var(--sp-color-danger);
                margin-left: 2px;
            }
            .sp-form-hint {
                font-size: 12px;
                color: var(--sp-color-text-secondary);
                margin-bottom: 6px;
            }
            .sp-form-input {
                width: 100%;
                padding: 8px 12px;
                font-size: 13px;
                border: 1px solid var(--sp-color-border);
                border-radius: var(--sp-radius-lg);
                background: var(--sp-color-bg);
                color: var(--sp-color-text);
                transition: border-color 0.15s, box-shadow 0.15s;
                outline: none;
                font-family: var(--sp-font-sans);
            }
            .sp-form-input::placeholder { color: var(--sp-color-text-tertiary); }
            .sp-form-input:focus {
                border-color: var(--sp-color-primary);
                box-shadow: 0 0 0 3px rgba(99,102,241,0.12);
            }
            textarea.sp-form-input {
                resize: vertical;
                min-height: 80px;
            }
            select.sp-form-input {
                appearance: none;
                background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='%236b7280' viewBox='0 0 16 16'%3E%3Cpath d='M4.5 6l3.5 4 3.5-4z'/%3E%3C/svg%3E");
                background-repeat: no-repeat;
                background-position: right 12px center;
                padding-right: 36px;
                cursor: pointer;
            }

            /* ── Toggle Switch ── */
            .sp-toggle-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 10px 0;
                border-bottom: 1px solid var(--sp-color-border-light);
            }
            .sp-toggle-row:last-child { border-bottom: none; }
            .sp-toggle-info { flex: 1; }
            .sp-toggle-label {
                font-size: 13px;
                font-weight: 600;
                color: var(--sp-color-text);
            }
            .sp-toggle-desc {
                font-size: 12px;
                color: var(--sp-color-text-secondary);
                margin-top: 2px;
            }
            .sp-toggle-switch {
                position: relative;
                width: 40px;
                height: 22px;
                flex-shrink: 0;
                margin-left: 16px;
            }
            .sp-toggle-switch input {
                opacity: 0;
                width: 0;
                height: 0;
            }
            .sp-toggle-track {
                position: absolute;
                inset: 0;
                background: #d1d5db;
                border-radius: 11px;
                cursor: pointer;
                transition: background 0.2s;
            }
            .sp-toggle-track::after {
                content: '';
                position: absolute;
                top: 2px;
                left: 2px;
                width: 18px;
                height: 18px;
                background: #fff;
                border-radius: 50%;
                transition: transform 0.2s;
                box-shadow: var(--sp-shadow-sm);
            }
            .sp-toggle-switch input:checked + .sp-toggle-track {
                background: var(--sp-color-primary);
            }
            .sp-toggle-switch input:checked + .sp-toggle-track::after {
                transform: translateX(18px);
            }
            html[data-theme='dark'] .sp-toggle-track { background: #4b5563; }

            /* ── Buttons ── */
            .sp-btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 4px;
                padding: 8px 16px;
                font-size: 13px;
                font-weight: 600;
                border-radius: var(--sp-radius-lg);
                border: none;
                cursor: pointer;
                transition: all 0.15s;
                font-family: var(--sp-font-sans);
                text-decoration: none;
            }
            .sp-btn-primary {
                background: var(--sp-color-primary);
                color: #fff;
            }
            .sp-btn-primary:hover { background: var(--sp-color-primary-hover); }
            .sp-btn-secondary {
                background: var(--sp-color-bg);
                color: var(--sp-color-text);
                border: 1px solid var(--sp-color-border);
            }
            .sp-btn-secondary:hover { background: rgba(0,0,0,0.04); }
            html[data-theme='dark'] .sp-btn-secondary:hover { background: rgba(255,255,255,0.06); }
            .sp-btn-ghost {
                background: transparent;
                color: var(--sp-color-text-secondary);
                padding: 6px 10px;
            }
            .sp-btn-ghost:hover { color: var(--sp-color-text); background: rgba(0,0,0,0.04); }
            .sp-btn-danger {
                background: #fef2f2;
                color: var(--sp-color-danger);
                border: 1px solid #fecaca;
            }
            .sp-btn-danger:hover { background: rgba(239,68,68,0.08); }
            html[data-theme='dark'] .sp-btn-danger {
                background: rgba(239,68,68,0.12);
                border-color: rgba(239,68,68,0.25);
            }
            html[data-theme='dark'] .sp-btn-danger:hover { background: rgba(239,68,68,0.15); }
            .sp-btn-block { width: 100%; }
            .sp-btn-sm { padding: 5px 12px; font-size: 12px; }

            /* ── Cards (Provider / Model / Search) ── */
            .sp-card {
                background: var(--sp-color-bg);
                border: 1px solid var(--sp-color-border);
                border-radius: var(--sp-radius-lg);
                padding: 14px;
            }
            .sp-card-actions { display: flex; gap: 4px; }
            .sp-card-action-btn {
                width: 32px; height: 32px;
                display: flex; align-items: center; justify-content: center;
                border-radius: var(--sp-radius-sm);
                border: 1px solid var(--sp-color-border);
                background: var(--sp-color-bg);
                color: var(--sp-color-text-secondary);
                cursor: pointer;
                transition: all 0.15s;
            }
            .sp-card-action-btn:hover { background: rgba(0,0,0,0.04); }
            html[data-theme='dark'] .sp-card-action-btn:hover { background: rgba(255,255,255,0.06); }
            .sp-delete-btn:hover { background: rgba(0,0,0,0.04); }
            html[data-theme='dark'] .sp-delete-btn:hover { background: rgba(255,255,255,0.06); }

            /* ── Add button (dashed border) ── */
            .sp-add-btn {
                width: 100%;
                padding: 10px;
                font-size: 13px;
                color: var(--sp-color-text-secondary);
                background: transparent;
                border: 2px dashed var(--sp-color-border);
                border-radius: var(--sp-radius-lg);
                cursor: pointer;
                transition: all 0.15s;
                font-family: var(--sp-font-sans);
            }
            .sp-add-btn:hover {
                color: var(--sp-color-text);
                border-color: var(--sp-color-text-tertiary);
                background: rgba(0,0,0,0.02);
            }
            html[data-theme='dark'] .sp-add-btn:hover {
                background: rgba(255,255,255,0.03);
            }

            /* ── Tags / Badges ── */
            .sp-tag {
                display: inline-flex;
                align-items: center;
                padding: 1px 7px;
                font-size: 11px;
                font-weight: 600;
                border-radius: 4px;
                white-space: nowrap;
                flex-shrink: 0;
            }
            .sp-tag-primary {
                background: var(--sp-color-primary-light);
                color: var(--sp-color-primary);
                border: 1px solid #c7d2fe;
            }
            .sp-tag-success {
                background: #ecfdf5;
                color: var(--sp-color-success);
                border: 1px solid #a7f3d0;
            }
            .sp-tag-warning {
                background: #fffbeb;
                color: var(--sp-color-warning);
                border: 1px solid #fde68a;
            }
            .sp-tag-neutral {
                background: var(--sp-color-border-light);
                color: var(--sp-color-text-secondary);
                border: 1px solid var(--sp-color-border);
            }
            .sp-tag-blue {
                background: #eff6ff;
                color: #3b82f6;
                border: 1px solid #bfdbfe;
            }
            .sp-tag-sky {
                background: #f0f9ff;
                color: #0284c7;
                border: 1px solid #bae6fd;
            }
            .sp-tag-emerald {
                background: #ecfdf5;
                color: #059669;
                border: 1px solid #a7f3d0;
            }
            .sp-tag-teal {
                background: #f0fdfa;
                color: #0d9488;
                border: 1px solid #99f6e4;
            }
            .sp-tag-purple {
                background: #faf5ff;
                color: #7c3aed;
                border: 1px solid #e9d5ff;
            }
            .sp-tag-amber {
                background: #fffbeb;
                color: #d97706;
                border: 1px solid #fde68a;
            }

            /* ── Divider with text ── */
            .sp-divider-text {
                display: flex;
                align-items: center;
                gap: 16px;
                margin: 24px 0;
                color: var(--sp-color-text-tertiary);
                font-size: 13px;
                font-weight: 500;
            }
            .sp-divider-text::before,
            .sp-divider-text::after {
                content: '';
                flex: 1;
                border-top: 1px dashed var(--sp-color-border);
            }

            /* ── Color Swatch ── */
            .sp-color-options {
                display: flex;
                gap: 8px;
                padding: 8px 0;
            }
            .sp-color-swatch {
                width: 32px;
                height: 32px;
                border-radius: 50%;
                cursor: pointer;
                border: 3px solid transparent;
                transition: all 0.15s;
                position: relative;
            }
            .sp-color-swatch:hover { transform: scale(1.1); }
            .sp-color-swatch.selected {
                border-color: var(--sp-color-primary);
                box-shadow: 0 0 0 2px var(--sp-color-bg), 0 0 0 4px var(--sp-color-primary);
            }

            /* ── Slider ── */
            .sp-slider-row {
                display: flex;
                align-items: center;
                gap: 16px;
                padding: 10px 0;
            }
            .sp-slider-row input[type="range"] {
                flex: 1;
                accent-color: var(--sp-color-primary);
                height: 4px;
            }
            .sp-slider-value {
                font-size: 14px;
                font-weight: 600;
                min-width: 36px;
                text-align: right;
                color: var(--sp-color-text);
            }

            /* ── Keyboard Shortcut ── */
            .sp-shortcut { display: inline-flex; align-items: center; gap: 4px; }
            .sp-shortcut kbd {
                display: inline-block;
                padding: 2px 8px;
                font-size: 12px;
                font-family: var(--sp-font-sans);
                font-weight: 600;
                background: var(--sp-color-bg);
                border: 1px solid var(--sp-color-border);
                border-radius: 4px;
                box-shadow: 0 1px 0 var(--sp-color-border);
                color: var(--sp-color-text-secondary);
            }

            /* ── Scrollbar ── */
            .sp-scroll-content::-webkit-scrollbar { width: 6px; }
            .sp-scroll-content::-webkit-scrollbar-track { background: transparent; }
            .sp-scroll-content::-webkit-scrollbar-thumb {
                background: #d1d5db;
                border-radius: 3px;
            }
            .sp-scroll-content::-webkit-scrollbar-thumb:hover { background: #9ca3af; }
            html[data-theme='dark'] setting-panel .sp-scroll-content::-webkit-scrollbar-thumb {
                background: rgba(255, 255, 255, 0.18);
            }
            html[data-theme='dark'] setting-panel .sp-scroll-content::-webkit-scrollbar-thumb:hover {
                background: rgba(255, 255, 255, 0.28);
            }

            /* ── Modal ── */
            .sp-modal-overlay {
                position: fixed; inset: 0; z-index: 50;
                background: rgba(0,0,0,0.3);
                backdrop-filter: blur(4px);
            }
            .sp-modal-container {
                position: fixed; inset: 0; z-index: 50;
                display: flex; align-items: center; justify-content: center;
                pointer-events: none;
            }
            .sp-modal-content {
                background: var(--sp-color-bg);
                border-radius: var(--sp-radius-xl);
                border: 1px solid var(--sp-color-border);
                box-shadow: var(--sp-shadow-md);
                pointer-events: auto;
                max-height: 85vh;
                overflow: hidden;
            }
            .sp-modal-header {
                padding: 16px 24px;
                border-bottom: 1px solid var(--sp-color-border);
                display: flex; align-items: center; justify-content: space-between;
            }
            .sp-modal-title { font-size: 16px; font-weight: 700; color: var(--sp-color-text); }
            .sp-modal-close {
                width: 32px; height: 32px;
                display: flex; align-items: center; justify-content: center;
                border-radius: var(--sp-radius-sm);
                border: none; background: transparent;
                color: var(--sp-color-text-tertiary);
                cursor: pointer; transition: all 0.15s;
            }
            .sp-modal-close:hover { color: var(--sp-color-text); background: var(--sp-color-border-light); }
            .sp-modal-body { padding: 24px; }
            .sp-modal-footer {
                padding: 16px 24px;
                border-top: 1px solid var(--sp-color-border);
                display: flex; justify-content: flex-end; gap: 12px;
            }

            /* ── Header ── */
            .sp-header {
                position: sticky; top: 0; z-index: 10;
                background: rgba(255,255,255,0.85);
                backdrop-filter: blur(12px);
                border-bottom: 1px solid var(--sp-color-border);
            }
            html[data-theme='dark'] .sp-header {
                background: color-mix(in srgb, var(--od-bg, #111827) 85%, transparent);
                border-bottom-color: var(--od-border-strong, #374151);
            }
            .sp-header-title {
                font-size: 18px;
                font-weight: 700;
                color: var(--sp-color-text);
            }

            /* ── Footer ── */
            .sp-footer {
                flex-shrink: 0;
                padding: 12px 24px;
                border-top: 1px solid var(--sp-color-border);
                text-align: center;
                background: var(--sp-color-bg);
            }
            .sp-footer-text {
                font-size: 12px;
                color: var(--sp-color-text-tertiary);
            }
        </style>
        <div class="w-full h-full overflow-hidden flex flex-col" style="background:var(--sp-color-bg-page)">
            <!-- 固定在右上角的工具栏 -->
            <div id="setting-panel-toolbar" class="sp-fixed-toolbar"></div>

            <!-- 顶部标题栏 + Tab -->
            <div class="sp-header">
                <div class="px-6 py-4 flex items-center">
                    <h1 class="sp-header-title">设置</h1>
                    <span id="save-indicator" class="ml-4 text-xs text-green-500 opacity-0 transition-opacity duration-300 flex items-center gap-1">
                        <i class="fas fa-check-circle"></i> 已保存
                    </span>
                </div>
                <!-- Tab 栏：保持不变 -->
                <div class="px-6 pb-3 flex items-center gap-3">
                    <div class="seg-control">
                        ${tabButtons}
                        <button id="quick-setup-btn" class="seg-item">
                            <i class="fa-solid fa-magic seg-icon"></i> 设置向导
                        </button>
                    </div>
                </div>
            </div>

            <!-- 可滚动内容区 -->
            <div class="sp-scroll-content flex-1 overflow-y-auto px-6 py-6">
                <div id="tab-models" class="${this._activeTab === 'models' ? '' : 'hidden'} space-y-8">
                    ${this.renderProvidersSection()}
                    ${this.renderModelsSection()}
                    ${this.renderDefaultModelsSection()}
                </div>
                <div id="tab-tasks" class="${this._activeTab === 'tasks' ? '' : 'hidden'} space-y-8">
                    ${this.renderTaskSection()}
                </div>
                <div id="tab-search" class="${this._activeTab === 'search' ? '' : 'hidden'} space-y-8">
                    ${this.renderSearchSection()}
                </div>
                <div id="tab-general" class="${this._activeTab === 'general' ? '' : 'hidden'} space-y-8">
                    ${this.renderGeneralSection()}
                </div>
            </div>

            <!-- 底部版本信息栏 -->
            <div class="sp-footer">
                <span class="sp-footer-text">OpenDesk v${this.appVersion || '...'}</span>
            </div>
        </div>

        <!-- 模态框容器 -->
        <div id="modal-overlay" class="hidden fixed inset-0 z-50 bg-black/30 backdrop-blur-sm"></div>
        <div id="modal-container" class="hidden fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
            <div id="modal-content" class="pointer-events-auto"></div>
        </div>
        `;

        this._createSettingPanelToolbar();
        this._hasRendered = true;
    }

    _createSettingPanelToolbar() {
        const container = this.querySelector('#setting-panel-toolbar');
        if (!container) return;
        // toolbar is now empty (buttons moved to inline button group)
    }

    _switchTab(tab) {
        this._activeTab = tab;
        this.querySelectorAll('.seg-item[data-tab]').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.tab === tab);
        });
        const tabIds = ['models', 'tasks', 'search', 'general'];
        for (const id of tabIds) {
            const el = this.querySelector(`#tab-${id}`);
            if (el) el.classList.toggle('hidden', id !== tab);
        }
    }

    renderTaskSection() {
        const taskConfig = this.currentData?.task_config || {};
        const autoRetry = taskConfig.auto_retry !== false;

        return `
        <section class="sp-section">
            <h2 class="sp-section-title">任务设置</h2>
            <div class="sp-section-card">
            <div class="sp-toggle-row">
                <div class="sp-toggle-info">
                    <div class="sp-toggle-label">LLM 请求失败时自动重试</div>
                    <div class="sp-toggle-desc">任务中的模型请求失败后自动重试，间隔按 10 秒起步指数退避，最长不超过 10 分钟。</div>
                </div>
                <label class="sp-toggle-switch">
                    <input id="task-auto-retry-toggle" type="checkbox" ${autoRetry ? 'checked' : ''}>
                    <span class="sp-toggle-track"></span>
                </label>
            </div>
            </div>
        </section>
        `;
    }

    renderSearchSection() {
        const searchConfig = this._getSearchConfig();
        const channels = searchConfig.channels || {};
        const defaultWeb = searchConfig.defaultWebSearch || 'bing';
        const defaultAcademic = searchConfig.defaultAcademicSearch || 'arxiv';
        const webSearchEnabled = searchConfig.webSearchEnabled !== false; // 默认 true
        const academicSearchEnabled = searchConfig.academicSearchEnabled !== false; // 默认 true
        const bingChannels = channels.bing || {};
        const bingLang = bingChannels.lang || 'zh';

        const webChannels = [
            { id: 'duckduckgo', name: 'DuckDuckGo', desc: '注重隐私的免费搜索引擎', needsKey: false },
            { id: 'bing', name: 'Bing', desc: '免费的网页搜索引擎，支持中文版和全球版', needsKey: false },
            { id: 'baidu', name: '百度', desc: '中文网页搜索引擎，自动过滤广告', needsKey: false },
            { id: 'tavily', name: 'Tavily', desc: '专为AI设计的搜索引擎', needsKey: true },
            { id: 'brave', name: 'Brave', desc: '隐私优先的搜索引擎', needsKey: true },
            { id: 'bocha', name: '博查', desc: '专为AI设计的中文搜索引擎', needsKey: true },
            { id: 'exa', name: 'Exa', desc: 'AI驱动的搜索引擎', needsKey: true }
        ];

        const webChannelCards = webChannels
            .map((ch) => {
                const apiKey = channels[ch.id]?.api_key || '';
                const hasKey = apiKey !== '';
                const isDefault = ch.id === defaultWeb;
                const canSelect = !ch.needsKey || hasKey;
                const statusColor = canSelect ? (isDefault ? 'text-emerald-600' : 'text-gray-400') : 'text-orange-400';
                const statusText = isDefault ? '当前默认' : canSelect ? '可用' : '需要 API Key';
                const borderColor = isDefault ? 'border-emerald-200/60' : '';
                const bgColor = isDefault ? 'bg-emerald-50/30' : '';

                return `
            <div class="sp-card" style="${isDefault ? 'border-color:var(--sp-color-primary);background:var(--sp-color-primary-light)' : ''}">
                <div class="flex items-start justify-between">
                    <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-2">
                            <h3 style="font-size:14px;font-weight:600;color:var(--sp-color-text)">${ch.name}</h3>
                            <span class="sp-tag ${isDefault ? 'sp-tag-success' : canSelect ? 'sp-tag-neutral' : 'sp-tag-warning'}">${statusText}</span>
                        </div>
                        <p style="font-size:13px;color:var(--sp-color-text-secondary);margin-top:2px">${ch.desc}</p>
                    </div>
                    ${
                        canSelect && !isDefault
                            ? `
                    <button class="search-set-default-btn sp-btn sp-btn-sm sp-btn-secondary" data-channel="${ch.id}" data-type="web">设为默认</button>
                    `
                            : ''
                    }
                </div>
                ${
                    ch.needsKey
                        ? `
                <div style="margin-top:12px;display:flex;align-items:center;gap:8px">
                    <input type="password" class="search-api-key-input sp-form-input" style="flex:1;padding:6px 10px;font-size:13px" value="${this.escapeHtml(apiKey)}" placeholder="API Key" data-channel="${ch.id}">
                    <button class="search-set-key-btn sp-btn sp-btn-sm sp-btn-primary" data-channel="${ch.id}">保存</button>
                </div>
                `
                        : ''
                }
                ${
                    ch.id === 'bing'
                        ? `
                <div style="margin-top:12px;display:flex;align-items:center;gap:8px">
                    <label style="font-size:13px;color:var(--sp-color-text-secondary);flex-shrink:0">搜索区域</label>
                    <select class="bing-lang-select sp-form-input" style="flex:1;padding:6px 10px;font-size:13px">
                        <option value="zh" ${bingLang === 'zh' ? 'selected' : ''}>中国版 (cn.bing.com)</option>
                        <option value="en" ${bingLang === 'en' ? 'selected' : ''}>全球版 (www.bing.com)</option>
                    </select>
                </div>
                `
                        : ''
                }
            </div>
            `;
            })
            .join('');

        const academicChannels = [
            { id: 'arxiv', name: 'arXiv', desc: '学术论文预印本搜索引擎' },
            { id: 'dblp', name: 'DBLP', desc: '计算机科学文献数据库' }
        ];
        const academicChannelCards = academicChannels
            .map((ch) => {
                const isDefault = ch.id === defaultAcademic;
                return `
            <div class="sp-card" style="${isDefault ? 'border-color:var(--sp-color-primary);background:var(--sp-color-primary-light)' : ''}">
                <div class="flex items-start justify-between">
                    <div>
                        <div class="flex items-center gap-2">
                            <h3 style="font-size:14px;font-weight:600;color:var(--sp-color-text)">${ch.name}</h3>
                            <span class="sp-tag ${isDefault ? 'sp-tag-success' : 'sp-tag-neutral'}">${isDefault ? '当前默认' : '可用'}</span>
                        </div>
                        <p style="font-size:13px;color:var(--sp-color-text-secondary);margin-top:2px">${ch.desc}</p>
                    </div>
                    ${
                        !isDefault
                            ? `
                    <button class="search-set-default-btn sp-btn sp-btn-sm sp-btn-secondary" data-channel="${ch.id}" data-type="academic">设为默认</button>
                    `
                            : ''
                    }
                </div>
            </div>
            `;
            })
            .join('');

        return `
        <!-- 网页搜索引擎 -->
        <section class="sp-section">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
                <h2 class="sp-section-title" style="margin-bottom:0">网页搜索引擎</h2>
                <span class="sp-section-subtitle">WebSearch 工具使用的渠道</span>
                <label class="search-toggle-label sp-toggle-switch" data-type="web" style="margin-left:auto">
                    <input type="checkbox" class="search-toggle-checkbox" ${webSearchEnabled ? 'checked' : ''}>
                    <span class="sp-toggle-track"></span>
                </label>
            </div>
            <div class="${webSearchEnabled ? '' : 'hidden'}">
                <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px">
                    ${webChannelCards}
                </div>
                <p style="font-size:13px;color:var(--sp-color-text-secondary);margin-top:12px;display:flex;align-items:center;gap:4px">
                    <i class="fas fa-info-circle"></i>
                    默认渠道将用于所有 WebSearch 调用。需要 API Key 的渠道必须配置 Key 后才能设为默认。
                </p>
            </div>
            ${!webSearchEnabled ? '<p class="sp-form-hint" style="margin-top:12px;display:flex;align-items:center;gap:4px"><i class="fas fa-info-circle"></i>网页搜索已关闭，WebSearch 工具将不可用</p>' : ''}
        </section>

        <!-- 学术搜索引擎 -->
        <section class="sp-section">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
                <h2 class="sp-section-title" style="margin-bottom:0">学术搜索引擎</h2>
                <span class="sp-section-subtitle">AcademicSearch 工具使用的渠道</span>
                <label class="search-toggle-label sp-toggle-switch" data-type="academic" style="margin-left:auto">
                    <input type="checkbox" class="search-toggle-checkbox" ${academicSearchEnabled ? 'checked' : ''}>
                    <span class="sp-toggle-track"></span>
                </label>
            </div>
            <div class="${academicSearchEnabled ? '' : 'hidden'}">
                <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px">
                    ${academicChannelCards}
                </div>
            </div>
            ${!academicSearchEnabled ? '<p class="sp-form-hint" style="margin-top:12px;display:flex;align-items:center;gap:4px"><i class="fas fa-info-circle"></i>学术搜索已关闭，AcademicSearch 工具将不可用</p>' : ''}
        </section>
        `;
    }

    _getSearchConfig() {
        const apps = this.currentData?.applications || {};
        return apps.search || {};
    }

    _normalizeGatewayHost(host) {
        const value = String(host || '').trim();
        if (!value) return '127.0.0.1';
        const lower = value.toLowerCase();
        if (lower === 'none' || lower === 'off' || lower === 'disabled' || value === '无') return 'none';
        if (value === '*') return '0.0.0.0';
        return value;
    }

    _getGatewayConfig() {
        const raw = this.currentData?.applications?.devicemgr || {};
        const host = this._normalizeGatewayHost(raw.host || '127.0.0.1');
        const disabled = raw.enabled === false || host === 'none';
        const port = Number.isInteger(raw.port) && raw.port > 0 ? raw.port : 19010;
        return {
            enabled: !disabled,
            host: disabled ? 'none' : host,
            port,
            autoApproveLocal: raw.autoApproveLocal !== false
        };
    }

    _getGatewayHostOptions(currentHost) {
        const options =
            Array.isArray(this.gatewayHostOptions) && this.gatewayHostOptions.length > 0
                ? [...this.gatewayHostOptions]
                : [
                      { value: 'none', label: '无（关闭监听服务）' },
                      { value: '127.0.0.1', label: '127.0.0.1（仅本机）' },
                      { value: '0.0.0.0', label: '0.0.0.0（所有 IPv4 地址）' }
                  ];

        if (!options.some((option) => option.value === currentHost)) {
            options.push({ value: currentHost, label: `自定义：${currentHost}` });
        }
        return options;
    }

    renderGatewaySection() {
        const config = this._getGatewayConfig();
        const hostOptions = this._getGatewayHostOptions(config.host);
        const statusText = config.enabled ? `${config.host}:${config.port}` : '已关闭';
        const statusClass = config.enabled ? 'bg-emerald-100/70 text-emerald-700' : 'bg-gray-100 text-gray-500';

        return `
        <section class="sp-section">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:20px">
                <h2 class="sp-section-title" style="margin-bottom:0">设备网关</h2>
                <span class="sp-tag ${config.enabled ? 'sp-tag-success' : 'sp-tag-neutral'}">${this.escapeHtml(statusText)}</span>
            </div>
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px">
                <div class="sp-form-group" style="margin-bottom:0">
                    <label class="sp-form-label">监听地址</label>
                    <select id="gateway-host-select" class="sp-form-input">
                        ${hostOptions
                            .map(
                                (option) =>
                                    `<option value="${this.escapeHtml(option.value)}" ${option.value === config.host ? 'selected' : ''}>${this.escapeHtml(option.label)}</option>`
                            )
                            .join('')}
                    </select>
                </div>
                <div class="sp-form-group" style="margin-bottom:0">
                    <label class="sp-form-label">监听端口</label>
                    <input id="gateway-port-input" type="number" min="1" max="65535" step="1" value="${config.port}" ${config.enabled ? '' : 'disabled'} class="sp-form-input" style="${config.enabled ? '' : 'opacity:0.5'}">
                </div>
                <div class="sp-form-group" style="margin-bottom:0;display:flex;align-items:flex-end">
                    <label style="display:flex;align-items:center;gap:8px;font-size:14px;color:var(--sp-color-text);${config.enabled ? '' : 'opacity:0.5'}">
                        <input id="gateway-auto-approve-input" type="checkbox" ${config.autoApproveLocal ? 'checked' : ''} ${config.enabled ? '' : 'disabled'} style="width:16px;height:16px;accent-color:var(--sp-color-primary)">
                        自动审批本机配对
                    </label>
                </div>
            </div>
        </section>
        `;
    }

    renderGeneralSection() {
        const currentLocale = this.currentData?.locale || 'auto';
        const fontPreset = this.currentData?.gui_config?.font_preset || 'default';
        const themePreference = this.currentData?.gui_config?.theme_preference || 'system';
        const scaleFactor = this.currentData?.gui_config?.scale_factor ?? 1;
        const scaleSteps = [0.75, 0.9, 1, 1.25, 1.5];
        const scaleLabels = {
            'zh-CN': ['极小', '小', '标准', '大', '极大'],
            'en-US': ['Tiny', 'Small', 'Standard', 'Large', 'Extra Large'],
            auto: ['极小', '小', '标准', '大', '极大']
        };
        const labels = scaleLabels[currentLocale] || scaleLabels['auto'];
        const currentStepIndex = scaleSteps.indexOf(scaleFactor);
        const activeStep = currentStepIndex >= 0 ? currentStepIndex : 2;

        // 环境变量
        const environ = this.currentData?.environ || {};
        const environEntries = Object.entries(environ);

        const renderEnvironList = () => {
            const items = environEntries
                .map(
                    (entry, i) => `
                <div class="environ-item flex items-center gap-2 mb-2" data-index="${i}">
                    <input type="text" class="environ-key sp-form-input" value="${this.escapeHtml(entry[0])}" placeholder="变量名">
                    <span class="text-gray-400 text-xs">=</span>
                    <input type="text" class="environ-value sp-form-input" value="${this.escapeHtml(entry[1])}" placeholder="变量值">
                    <button class="remove-environ-btn sp-card-action-btn sp-delete-btn" data-index="${i}">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            `
                )
                .join('');
            return items || '<p class="text-xs text-gray-400 italic">暂无环境变量</p>';
        };

        return `
        <section class="sp-section">
            <h2 class="sp-section-title">通用设置</h2>
            <div class="sp-section-card">
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px">
                <div class="sp-form-group" style="margin-bottom:0">
                    <label class="sp-form-label">语言</label>
                    <select id="locale-select" class="sp-form-input">
                        <option value="auto"${currentLocale === 'auto' ? ' selected' : ''}>跟随系统</option>
                        <option value="zh-CN"${currentLocale === 'zh-CN' ? ' selected' : ''}>中文</option>
                        <option value="en-US"${currentLocale === 'en-US' ? ' selected' : ''}>English</option>
                    </select>
                </div>
                <div class="sp-form-group" style="margin-bottom:0">
                    <label class="sp-form-label">字体 / Font</label>
                    <select id="font-preset-select" class="sp-form-input">
                        <option value="default"${fontPreset === 'default' ? ' selected' : ''}>默认 / Default</option>
                        <option value="lxgwwenkai"${fontPreset === 'lxgwwenkai' ? ' selected' : ''}>霞鹜文楷 / LXGW WenKai</option>
                    </select>
                </div>
                <div class="sp-form-group" style="margin-bottom:0">
                    <label class="sp-form-label">外观主题 / Theme</label>
                    <select id="theme-preference-select" class="sp-form-input">
                        <option value="system"${themePreference === 'system' ? ' selected' : ''}>跟随系统</option>
                        <option value="light"${themePreference === 'light' ? ' selected' : ''}>浅色</option>
                        <option value="dark"${themePreference === 'dark' ? ' selected' : ''}>深色</option>
                    </select>
                </div>
            </div>
            <hr class="sp-section-divider">
            <div class="sp-form-group" style="margin-bottom:0">
                <label class="sp-form-label">显示大小 / Display Size</label>
                <div style="display:flex;align-items:center;gap:12px">
                    <span style="font-size:12px;color:var(--sp-color-text-tertiary);min-width:28px">${labels[0]}</span>
                    <div style="flex:1;position:relative;height:24px;display:flex;align-items:center">
                        <div style="position:absolute;left:0;right:0;height:4px;background:var(--sp-color-border);border-radius:2px">
                            <div id="scale-track-fill" style="height:100%;background:var(--sp-color-primary);border-radius:2px;transition:width 0.2s;width:${(activeStep / (scaleSteps.length - 1)) * 100}%"></div>
                        </div>
                        <div style="position:absolute;left:0;right:0;display:flex;justify-content:space-between">
                            ${scaleSteps
                                .map(
                                    (step, i) => `
                                <button class="scale-step-btn" style="width:12px;height:12px;border-radius:50%;border:2px solid ${i <= activeStep ? 'var(--sp-color-primary)' : 'var(--sp-color-border)'};background:${i <= activeStep ? 'var(--sp-color-primary)' : 'var(--sp-color-bg)'};cursor:pointer;transition:all 0.15s;padding:0;${i === activeStep ? 'box-shadow:0 0 0 3px rgba(99,102,241,0.15);' : ''}" data-step="${i}" data-value="${step}"></button>
                            `
                                )
                                .join('')}
                        </div>
                    </div>
                    <span style="font-size:12px;color:var(--sp-color-text-tertiary);min-width:28px;text-align:right">${labels[labels.length - 1]}</span>
                </div>
                <p style="font-size:12px;color:var(--sp-color-text-tertiary);margin-top:6px;display:flex;align-items:center;gap:4px">
                    Ctrl + <kbd style="padding:1px 5px;background:var(--sp-color-border-light);border-radius:3px;font-size:11px;color:var(--sp-color-text-secondary)">+</kbd> / <kbd style="padding:1px 5px;background:var(--sp-color-border-light);border-radius:3px;font-size:11px;color:var(--sp-color-text-secondary)">-</kbd>
                </p>
            </div>
            </div>
        </section>

        ${this.renderGatewaySection()}

        <section class="sp-section">
            <h2 class="sp-section-title">环境变量<span class="sp-section-subtitle">所有 Shell 命令执行时共享</span></h2>
            <div class="sp-section-card">
            <div id="environ-list" style="margin-bottom:12px">
                ${renderEnvironList()}
            </div>
            <button id="add-environ-btn" class="sp-add-btn">
                <i class="fas fa-plus" style="margin-right:8px"></i>添加环境变量
            </button>
            <p style="font-size:13px;color:var(--sp-color-text-secondary);margin-top:8px">配置后，所有终端命令（Bash / Zsh / PowerShell）执行时都会携带这些环境变量</p>
            </div>
        </section>

        ${this.renderConfigManagementSection()}

        ${this.renderDebugModeSection()}
        `;
    }

    renderConfigManagementSection() {
        return `
        <section class="sp-section">
            <h2 class="sp-section-title">${this._t('renderer.settings.configManagement')}</h2>
            <p class="sp-section-desc">导入、导出或通过口令分享你的设置。</p>
            <div style="display:flex;flex-wrap:nowrap;gap:8px;overflow-x:auto">
                <button id="export-config-json-btn" class="sp-btn sp-btn-secondary" style="flex:1;min-width:128px;white-space:nowrap">
                    <i class="fa-solid fa-file-export" style="margin-right:6px"></i>${this._t('renderer.settings.exportConfigJson')}
                </button>
                <button id="import-config-json-btn" class="sp-btn sp-btn-secondary" style="flex:1;min-width:128px;white-space:nowrap">
                    <i class="fa-solid fa-file-import" style="margin-right:6px"></i>${this._t('renderer.settings.importConfigJson')}
                </button>
                <button id="export-config-quickpass-btn" class="sp-btn sp-btn-secondary" style="flex:1;min-width:128px;white-space:nowrap">
                    <i class="fa-solid fa-key" style="margin-right:6px"></i>${this._t('renderer.settings.exportConfigQuickpass')}
                </button>
                <button id="import-config-quickpass-btn" class="sp-btn sp-btn-secondary" style="flex:1;min-width:128px;white-space:nowrap">
                    <i class="fa-solid fa-key" style="margin-right:6px"></i>${this._t('renderer.settings.importConfigQuickpass')}
                </button>
        </section>
        `;
    }

    renderDebugModeSection() {
        const debugConfig = this.currentData?.debug || {};
        const debugDevMode = !!debugConfig.developer_mode;
        const debugExpFeature = !!debugConfig.experimental_feature;
        const debugLogRawLlm = !!debugConfig.log_raw_llm_request;

        return `
        <section class="sp-section">
            <h2 class="sp-section-title">${this._t('renderer.settings.debugMode')}</h2>
            <div class="sp-section-card">
            <div class="sp-toggle-row">
                <div class="sp-toggle-info">
                    <div class="sp-toggle-label">${this._t('renderer.settings.developerMode')}</div>
                </div>
                <label class="sp-toggle-switch">
                    <input type="checkbox" ${debugDevMode ? 'checked' : ''} id="debug-mode-toggle-hidden">
                    <span id="debug-mode-toggle" class="sp-toggle-track" style="cursor:pointer" data-key="developer_mode"></span>
                </label>
            </div>
            <div class="sp-toggle-row">
                <div class="sp-toggle-info">
                    <div class="sp-toggle-label">${this._t('renderer.settings.experimentalFeature')}</div>
                </div>
                <label class="sp-toggle-switch">
                    <input type="checkbox" ${debugExpFeature ? 'checked' : ''} id="experimental-feature-toggle-hidden">
                    <span id="experimental-feature-toggle" class="sp-toggle-track" style="cursor:pointer" data-key="experimental_feature"></span>
                </label>
            </div>
            <div class="sp-toggle-row">
                <div class="sp-toggle-info">
                    <div class="sp-toggle-label">${this._t('renderer.settings.logRawLlmRequest')}</div>
                </div>
                <label class="sp-toggle-switch">
                    <input type="checkbox" ${debugLogRawLlm ? 'checked' : ''} id="log-raw-llm-toggle-hidden">
                    <span id="log-raw-llm-toggle" class="sp-toggle-track" style="cursor:pointer" data-key="log_raw_llm_request"></span>
                </label>
            </div>
            </div>
        </section>
        `;
    }

    renderProvidersSection() {
        const providers = this.currentData?.providers || [];
        return `
        <section class="sp-section">
            <h2 class="sp-section-title">模型提供方<span class="sp-section-subtitle">${providers.length} 个已配置</span></h2>
            <div id="provider-list" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px">
                ${providers.map((p, i) => this.renderProviderCard(p, i)).join('')}
            </div>
            <button id="add-provider-btn" class="sp-add-btn" style="margin-top:16px">
                <i class="fas fa-plus" style="margin-right:8px"></i>添加提供方
            </button>
        </section>
        `;
    }

    renderProviderCard(provider, index) {
        const maskedKey = this.maskApiKey(provider.api_key);
        const providerType = provider.provider_type || 'openai';
        const providerTypeLabel = providerType === 'anthropic' ? 'Anthropic' : 'OpenAI';
        return `
        <div class="sp-card" data-provider-index="${index}">
            <div class="flex items-start justify-between">
                <div class="flex-1 min-w-0">
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                        <h3 style="font-size:14px;font-weight:600;color:var(--sp-color-text)">${this.escapeHtml(provider.name)}</h3>
                        <span class="sp-tag ${providerType === 'anthropic' ? 'sp-tag-teal' : 'sp-tag-blue'}">${providerTypeLabel}</span>
                    </div>
                    <p style="font-size:13px;color:var(--sp-color-text-secondary);margin-top:4px">${this.escapeHtml(provider.base_url)}</p>
                    <p style="font-size:13px;color:var(--sp-color-text-secondary)">${maskedKey}</p>
                    ${provider.no_proxy ? '<span class="sp-tag sp-tag-amber" style="margin-top:4px">禁用代理</span>' : ''}
                    ${provider.no_ssl ? '<span class="sp-tag sp-tag-red" style="margin-top:4px">跳过SSL证书校验</span>' : ''}
                </div>
                <div class="sp-card-actions">
                    <button class="edit-provider-btn sp-card-action-btn" data-index="${index}">
                        <i class="fas fa-pen" style="font-size:12px"></i>
                    </button>
                    <button class="delete-provider-btn sp-card-action-btn sp-delete-btn" data-index="${index}">
                        <i class="fas fa-trash" style="font-size:12px"></i>
                    </button>
                </div>
            </div>
        </div>
        `;
    }

    renderModelsSection() {
        const models = this.currentData?.models || [];
        return `
	        <section class="sp-section">
	            <h2 class="sp-section-title">${this.escapeHtml(this._t('config.model.title'))}<span class="sp-section-subtitle">${this.escapeHtml(this._t('config.model.configured_count', { count: models.length }))}</span></h2>
            <div id="model-list" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px">
	                ${models.map((m, i) => this.renderModelCard(m, i)).join('')}
	            </div>
	            <button id="add-model-btn" class="sp-add-btn" style="margin-top:16px">
	                <i class="fas fa-plus" style="margin-right:8px"></i>${this.escapeHtml(this._t('config.model.add.label'))}
	            </button>
	        </section>
	        `;
    }

    renderModelCard(model, index) {
        const modelType = this.normalizeModelType(model.model_type);
        const typeLabel = this.getModelTypeLabel(modelType);
        const typeBadge =
            modelType === 'embedding'
                ? `<span class="sp-tag sp-tag-emerald">${typeLabel}</span>`
                : `<span class="sp-tag sp-tag-sky">${typeLabel}</span>`;
        const effortLabel = this.getEffortLabel(model.reasoning_effort);
        const ctxLabel =
            modelType === 'chat' && model.context_length && model.context_length > 0
                ? model.context_length >= 1000
                    ? `${Math.round(model.context_length / 1000)}k`
                    : String(model.context_length)
                : '';
        return `
        <div class="sp-card" data-model-index="${index}">
            <div style="display:flex;align-items:flex-start;justify-content:space-between">
                <div style="flex:1;min-width:0">
                    <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                        <h3 style="font-size:14px;font-weight:600;color:var(--sp-color-text)">${this.escapeHtml(model.alias)}</h3>
                        ${typeBadge}
                        ${modelType === 'chat' && effortLabel ? `<span class="sp-tag sp-tag-purple">${effortLabel}</span>` : ''}
                        ${ctxLabel ? `<span class="sp-tag sp-tag-blue">${ctxLabel} ctx</span>` : ''}
                    </div>
                    <p style="font-size:13px;color:var(--sp-color-text-secondary);margin-top:4px">${this.escapeHtml(model.provider_name)} / ${this.escapeHtml(model.model_name)} · ${typeLabel}</p>
                </div>
                <div class="sp-card-actions">
                    <button class="edit-model-btn sp-card-action-btn" data-index="${index}">
                        <i class="fas fa-pen" style="font-size:12px"></i>
                    </button>
                    <button class="delete-model-btn sp-card-action-btn sp-delete-btn" data-index="${index}">
                        <i class="fas fa-trash" style="font-size:12px"></i>
                    </button>
                </div>
            </div>
        </div>
        `;
    }

    normalizeModelType(modelType) {
        return modelType === 'embedding' || modelType === 'embed' ? 'embedding' : 'chat';
    }

    getModelTypeLabel(modelType) {
        return this.normalizeModelType(modelType) === 'embedding'
            ? this._t('config.model.type.embedding')
            : this._t('config.model.type.chat');
    }

    getModelsByType(type) {
        const target = this.normalizeModelType(type);
        return (this.currentData?.models || []).filter((model) => this.normalizeModelType(model.model_type) === target);
    }

    renderModelOptions(models) {
        return models
            .map((m) => `<option value="${this.escapeHtml(m.alias)}">${this.escapeHtml(m.alias)}</option>`)
            .join('');
    }

    renderDefaultModelsSection() {
        const chatModelOptions = this.renderModelOptions(this.getModelsByType('chat'));
        const embeddingModelOptions = this.renderModelOptions(this.getModelsByType('embedding'));

        return `
        <section class="sp-section">
            <h2 class="sp-section-title">默认模型选择</h2>
            <p class="sp-section-desc">为各场景指定默认使用的模型。</p>
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px">
                <div class="sp-form-group" style="margin-bottom:0">
                    <label class="sp-form-label">${this._t('config.defaultmodel.field.default_model')}</label>
                    <select id="default-model-select" class="sp-form-input">
                        <option value="">${this._t('common.none')}</option>
                        ${chatModelOptions}
                    </select>
                </div>
                <div class="sp-form-group" style="margin-bottom:0">
                    <label class="sp-form-label">${this._t('config.defaultmodel.field.embedding_model')}</label>
                    <select id="default-embedding-model-select" class="sp-form-input">
                        <option value="">${this._t('common.none')}</option>
                        ${embeddingModelOptions}
                    </select>
                </div>
                <div class="sp-form-group" style="margin-bottom:0">
                    <label class="sp-form-label">${this._t('config.defaultmodel.field.reranker_model')}</label>
                    <select id="default-reranker-model-select" class="sp-form-input">
                        <option value="">${this._t('common.none')}</option>
                        ${chatModelOptions}
                    </select>
                </div>
                <div class="sp-form-group" style="margin-bottom:0">
                    <label class="sp-form-label">${this._t('config.defaultmodel.field.vision_model')}</label>
                    <select id="default-vision-model-select" class="sp-form-input">
                        <option value="">${this._t('common.none')}</option>
                        ${chatModelOptions}
                    </select>
                </div>
                <div class="sp-form-group" style="margin-bottom:0">
                    <label class="sp-form-label">${this._t('config.defaultmodel.field.intent_model')}</label>
                    <select id="default-intent-model-select" class="sp-form-input">
                        <option value="">${this._t('common.none')}</option>
                        ${chatModelOptions}
                    </select>
                </div>
            </div>
        </section>
        `;
    }

    setUpEventListeners() {
        // Tab 切换
        this.querySelectorAll('.seg-item[data-tab]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const newTab = btn.dataset.tab;
                if (newTab === this._activeTab) return;
                this._switchTab(newTab);
            });
        });

        // 快捷操作
        this.querySelector('#quick-setup-btn')?.addEventListener('click', () => {
            window.globalControlAPI.openWizard();
        });

        this.querySelector('#task-auto-retry-toggle')?.addEventListener('change', (e) => {
            if (!this.currentData.task_config) this.currentData.task_config = {};
            this.currentData.task_config.auto_retry = e.target.checked;
            this.saveImmediately();
        });

        // 搜索设置 - API Key 保存按钮
        this.querySelectorAll('.search-set-key-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const channel = btn.dataset.channel;
                const input = this.querySelector(`.search-api-key-input[data-channel="${channel}"]`);
                const apiKey = input?.value?.trim() || '';
                this._saveSearchChannelApiKey(channel, apiKey);
            });
        });

        // 搜索设置 - 设为默认按钮
        this.querySelectorAll('.search-set-default-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const channel = btn.dataset.channel;
                const type = btn.dataset.type;
                this._setDefaultSearchChannel(channel, type);
            });
        });

        // 搜索设置 - 开关切换
        this.querySelectorAll('.search-toggle-checkbox').forEach((checkbox) => {
            checkbox.addEventListener('change', (e) => {
                const label = e.target.closest('.search-toggle-label');
                const type = label?.dataset.type;
                if (type === 'web') {
                    this._setWebSearchEnabled(e.target.checked);
                } else if (type === 'academic') {
                    this._setAcademicSearchEnabled(e.target.checked);
                }
            });
        });

        // Bing 搜索语言/区域切换
        this.querySelectorAll('.bing-lang-select').forEach((select) => {
            select.addEventListener('change', (e) => {
                this._setBingLang(e.target.value);
            });
        });

        // 设置默认模型选择框的初始值
        this.updateDefaultModelSelects();

        // 默认模型选择框变化时立即保存
        const selects = [
            'default-model-select',
            'default-embedding-model-select',
            'default-reranker-model-select',
            'default-vision-model-select',
            'default-intent-model-select'
        ];
        selects.forEach((id) => {
            this.querySelector(`#${id}`)?.addEventListener('change', (e) => {
                const field = this.getDefaultModelFieldMap()[id];
                this.currentData[field] = e.target.value;
                this.saveImmediately();
            });
        });

        // 语言选择
        this.querySelector('#locale-select')?.addEventListener('change', (e) => {
            this.currentData.locale = e.target.value;
            this._t = createRendererTranslator(this.currentData.locale === 'auto' ? 'auto' : this.currentData);
            this.refreshGeneralSection();
            void this.saveImmediately().then(() => {
                this._t = createRendererTranslator(this.currentData);
                this.refreshGeneralSection();
            });
        });

        // 字体预设
        this.querySelector('#font-preset-select')?.addEventListener('change', (e) => {
            const preset = e.target.value;
            if (!this.currentData.gui_config) this.currentData.gui_config = {};
            this.currentData.gui_config.font_preset = preset;
            document.documentElement.setAttribute('data-font-preset', preset);
            window.broadcastFontSettings?.(preset);
            this.saveImmediately();
        });

        // 外观主题
        this.querySelector('#theme-preference-select')?.addEventListener('change', async (e) => {
            const pref = e.target.value;
            if (!this.currentData.gui_config) this.currentData.gui_config = {};
            this.currentData.gui_config.theme_preference = pref;
            if (window.themeAPI?.setPreference) {
                try {
                    const result = await window.themeAPI.setPreference(pref);
                    if (result.status === 'ok' && result.data) {
                        const { applyResolvedTheme } = await import('../theme/theme-renderer.ts');
                        applyResolvedTheme(result.data);
                        window.broadcastThemeSettings?.(result.data);
                    }
                } catch (err) {
                    console.warn('[setting] theme setPreference failed', err);
                }
            }
            this.saveImmediately();
        });

        this.querySelector('#debug-mode-toggle-hidden')?.addEventListener('change', (e) => {
            if (!this.currentData.debug) this.currentData.debug = {};
            this.currentData.debug.developer_mode = e.target.checked;
            this.saveImmediately();
        });

        this.querySelector('#experimental-feature-toggle-hidden')?.addEventListener('change', (e) => {
            if (!this.currentData.debug) this.currentData.debug = {};
            this.currentData.debug.experimental_feature = e.target.checked;
            this.saveImmediately();
        });

        this.querySelector('#log-raw-llm-toggle-hidden')?.addEventListener('change', (e) => {
            if (!this.currentData.debug) this.currentData.debug = {};
            this.currentData.debug.log_raw_llm_request = e.target.checked;
            this.saveImmediately();
        });

        this._bindConfigManagementEvents();

        // 显示大小（分档点击）
        const bindScaleStepEvents = () => {
            this.querySelectorAll('.scale-step-btn, .scale-step-label').forEach((el) => {
                el.addEventListener('click', async () => {
                    const value = parseFloat(el.dataset.value);
                    if (!this.currentData.gui_config) this.currentData.gui_config = {};
                    this.currentData.gui_config.scale_factor = value;
                    if (window.displayAPI?.setScaleFactor) {
                        await window.displayAPI.setScaleFactor(value);
                    }
                    this.refreshGeneralSection();
                    this.saveImmediately();
                });
            });
        };
        bindScaleStepEvents();

        // 添加提供方按钮
        this.querySelector('#add-provider-btn')?.addEventListener('click', () => {
            this.showProviderTemplateModal();
        });

        // 编辑/删除提供方
        this.querySelectorAll('.edit-provider-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                const index = parseInt(e.currentTarget.dataset.index);
                this.showProviderEditModal(index);
            });
        });
        this.querySelectorAll('.delete-provider-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                const index = parseInt(e.currentTarget.dataset.index);
                this.deleteProvider(index);
            });
        });

        // 添加模型按钮
        this.querySelector('#add-model-btn')?.addEventListener('click', () => {
            this.showModelEditModal(-1);
        });

        // 编辑/删除模型
        this.querySelectorAll('.edit-model-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                const index = parseInt(e.currentTarget.dataset.index);
                this.showModelEditModal(index);
            });
        });
        this.querySelectorAll('.delete-model-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                const index = parseInt(e.currentTarget.dataset.index);
                this.deleteModel(index);
            });
        });

        // 模态框关闭
        this.querySelector('#modal-overlay')?.addEventListener('click', () => {
            this.closeModal();
        });

        // 环境变量管理
        this._bindGatewayEvents();
        this._bindEnvironEvents();
    }

    _saveSearchChannelApiKey(channel, apiKey) {
        if (!this.currentData.applications) this.currentData.applications = {};
        if (!this.currentData.applications.search) this.currentData.applications.search = {};
        const searchConfig = this.currentData.applications.search;
        if (!searchConfig.channels) searchConfig.channels = {};
        if (!searchConfig.channels[channel]) searchConfig.channels[channel] = {};
        searchConfig.channels[channel].api_key = apiKey;
        this.saveImmediately();
        // 刷新搜索 tab
        this.refreshSearchSection();
    }

    _setDefaultSearchChannel(channel, type) {
        if (!this.currentData.applications) this.currentData.applications = {};
        if (!this.currentData.applications.search) this.currentData.applications.search = {};
        const searchConfig = this.currentData.applications.search;
        if (type === 'web') {
            searchConfig.defaultWebSearch = channel;
        } else if (type === 'academic') {
            searchConfig.defaultAcademicSearch = channel;
        }
        this.saveImmediately();
        this.refreshSearchSection();
    }

    _setWebSearchEnabled(enabled) {
        if (!this.currentData.applications) this.currentData.applications = {};
        if (!this.currentData.applications.search) this.currentData.applications.search = {};
        this.currentData.applications.search.webSearchEnabled = enabled;
        this.saveImmediately();
        this.refreshSearchSection();
    }

    _setAcademicSearchEnabled(enabled) {
        if (!this.currentData.applications) this.currentData.applications = {};
        if (!this.currentData.applications.search) this.currentData.applications.search = {};
        this.currentData.applications.search.academicSearchEnabled = enabled;
        this.saveImmediately();
        this.refreshSearchSection();
    }

    _setBingLang(lang) {
        if (!this.currentData.applications) this.currentData.applications = {};
        if (!this.currentData.applications.search) this.currentData.applications.search = {};
        const searchConfig = this.currentData.applications.search;
        if (!searchConfig.channels) searchConfig.channels = {};
        if (!searchConfig.channels.bing) searchConfig.channels.bing = {};
        searchConfig.channels.bing.lang = lang;
        this.saveImmediately();
    }

    refreshSearchSection() {
        const tabSearch = this.querySelector('#tab-search');
        if (tabSearch) {
            tabSearch.innerHTML = this.renderSearchSection();
            // 重新绑定搜索设置事件
            this.querySelectorAll('.search-set-key-btn').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const channel = btn.dataset.channel;
                    const input = this.querySelector(`.search-api-key-input[data-channel="${channel}"]`);
                    const apiKey = input?.value?.trim() || '';
                    this._saveSearchChannelApiKey(channel, apiKey);
                });
            });
            this.querySelectorAll('.search-set-default-btn').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const channel = btn.dataset.channel;
                    const type = btn.dataset.type;
                    this._setDefaultSearchChannel(channel, type);
                });
            });
            this.querySelectorAll('.search-toggle-checkbox').forEach((checkbox) => {
                checkbox.addEventListener('change', (e) => {
                    const label = e.target.closest('.search-toggle-label');
                    const type = label?.dataset.type;
                    if (type === 'web') {
                        this._setWebSearchEnabled(e.target.checked);
                    } else if (type === 'academic') {
                        this._setAcademicSearchEnabled(e.target.checked);
                    }
                });
            });
            this.querySelectorAll('.bing-lang-select').forEach((select) => {
                select.addEventListener('change', (e) => {
                    this._setBingLang(e.target.value);
                });
            });
        }
    }

    updateDefaultModelSelects() {
        const mapping = this.getDefaultModelFieldMap();
        for (const [selectId, field] of Object.entries(mapping)) {
            const select = this.querySelector(`#${selectId}`);
            if (select && this.currentData) {
                select.value = this.currentData[field] || '';
            }
        }
    }

    getDefaultModelFieldMap() {
        return {
            'default-model-select': 'default_model',
            'default-embedding-model-select': 'default_embedding_model',
            'default-reranker-model-select': 'default_reranker_model',
            'default-vision-model-select': 'default_vision_model',
            'default-intent-model-select': 'default_intent_parsing_model'
        };
    }

    // --- 自动保存机制 ---
    scheduleSave() {
        if (this._saveTimeout) clearTimeout(this._saveTimeout);
        this._saveTimeout = setTimeout(() => {
            this.saveCurrentData();
        }, this._saveDelay);
    }

    saveImmediately() {
        if (this._saveTimeout) clearTimeout(this._saveTimeout);
        return this.saveCurrentData();
    }

    async saveCurrentData() {
        if (this._saving) {
            this._pendingSave = true;
            return;
        }
        this._saving = true;
        try {
            const savedData = await window.settingAPI.saveSettingObject(this.currentData);
            if (savedData && typeof savedData === 'object' && typeof savedData.resolved_locale === 'string') {
                this.currentData.resolved_locale = savedData.resolved_locale;
            }
            this.showSaveIndicator();
        } catch (error) {
            window.notificationAPI.sendNotification('error', '设置', '自动保存失败', error.message);
        } finally {
            this._saving = false;
            if (this._pendingSave) {
                this._pendingSave = false;
                this.scheduleSave();
            }
        }
    }

    showSaveIndicator() {
        const indicator = this.querySelector('#save-indicator');
        if (indicator) {
            indicator.classList.remove('opacity-0');
            indicator.classList.add('opacity-100');
            setTimeout(() => {
                indicator.classList.remove('opacity-100');
                indicator.classList.add('opacity-0');
            }, 2000);
        }
    }

    _syncCurrentEnvironFromDom() {
        if (!this.currentData) return;
        const items = Array.from(this.querySelectorAll('.environ-item'));
        if (items.length === 0) return;

        const environ = {};
        this._environEntries = items.map((item) => {
            const key = item.querySelector('.environ-key')?.value || '';
            const value = item.querySelector('.environ-value')?.value || '';
            if (key && value) {
                environ[key] = value;
            }
            return { key, value };
        });
        this.currentData.environ = Object.keys(environ).length > 0 ? environ : {};
    }

    _getExportableSettingData() {
        this._syncCurrentEnvironFromDom();
        const data = { ...(this.currentData || {}) };
        delete data.resolved_locale;
        return data;
    }

    async exportSettingJson() {
        const content = JSON.stringify(this._getExportableSettingData(), null, 2);
        try {
            if (typeof window.showSaveFilePicker === 'function') {
                const handle = await window.showSaveFilePicker({
                    suggestedName: 'setting.json',
                    types: [
                        {
                            description: this._t('renderer.settings.jsonFile'),
                            accept: { 'application/json': ['.json'] }
                        }
                    ]
                });
                const writable = await handle.createWritable();
                await writable.write(content);
                await writable.close();
            } else if (window.fsAPI?.saveFile && window.fsAPI?.writeTextFile) {
                const result = await window.fsAPI.saveFile({
                    defaultPath: 'setting.json',
                    filters: [{ name: this._t('renderer.settings.jsonFile'), extensions: ['json'] }]
                });
                if (!result || result.canceled || !result.filePath) {
                    return;
                }
                await window.fsAPI.writeTextFile(result.filePath, content);
            } else {
                const blob = new Blob([content], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'setting.json';
                a.click();
                URL.revokeObjectURL(url);
            }
            window.notificationAPI.sendNotification(
                'info',
                this._t('renderer.settings.notificationTitle'),
                this._t('renderer.settings.exportSuccess'),
                this._t('renderer.settings.exportJsonSuccess')
            );
        } catch (error) {
            if (error?.name === 'AbortError') return;
            window.notificationAPI.sendNotification(
                'error',
                this._t('renderer.settings.notificationTitle'),
                this._t('renderer.settings.exportFailed'),
                error?.message || String(error)
            );
        }
    }

    async _readSettingJsonFileText() {
        if (typeof window.showOpenFilePicker === 'function') {
            const [fileHandle] = await window.showOpenFilePicker({
                types: [
                    {
                        description: this._t('renderer.settings.jsonFile'),
                        accept: { 'application/json': ['.json'] }
                    }
                ],
                multiple: false
            });
            if (!fileHandle) return null;
            const file = await fileHandle.getFile();
            return file.text();
        }

        return new Promise((resolve, reject) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,application/json';
            input.addEventListener('change', () => {
                const file = input.files?.[0];
                if (!file) {
                    resolve(null);
                    return;
                }
                file.text().then(resolve).catch(reject);
            });
            input.addEventListener('cancel', () => {
                resolve(null);
            });
            input.click();
        });
    }

    async importSettingJson() {
        try {
            const text = await this._readSettingJsonFileText();
            if (!text) return;

            let jsonData;
            try {
                jsonData = JSON.parse(text);
            } catch (error) {
                window.notificationAPI.sendNotification(
                    'error',
                    this._t('renderer.settings.notificationTitle'),
                    this._t('renderer.settings.importFailed'),
                    this._t('renderer.settings.invalidJson', { message: error?.message || String(error) })
                );
                return;
            }

            await window.settingAPI.saveSettingObject(jsonData);
            await this.loadData();
            this._hasRendered = false;
            this.render();
            this.setUpEventListeners();
            window.notificationAPI.sendNotification(
                'info',
                this._t('renderer.settings.notificationTitle'),
                this._t('renderer.settings.importSuccess'),
                this._t('renderer.settings.importJsonSuccess')
            );
        } catch (error) {
            if (error?.name === 'AbortError') return;
            window.notificationAPI.sendNotification(
                'error',
                this._t('renderer.settings.notificationTitle'),
                this._t('renderer.settings.importFailed'),
                error?.message || String(error)
            );
        }
    }

    _bindConfigManagementEvents() {
        this.querySelector('#export-config-json-btn')?.addEventListener('click', () => {
            void this.exportSettingJson();
        });

        this.querySelector('#import-config-json-btn')?.addEventListener('click', () => {
            void this.importSettingJson();
        });

        this.querySelector('#export-config-quickpass-btn')?.addEventListener('click', () => {
            this.showExportQuickPassModal();
        });

        this.querySelector('#import-config-quickpass-btn')?.addEventListener('click', () => {
            this.showImportQuickPassModal();
        });
    }

    // --- 提供方管理 ---
    showProviderTemplateModal() {
        const templates = this.providerTemplates;
        const templateCards = templates
            .map(
                (t, i) => `
            <button class="provider-template-btn sp-template-btn flex flex-col items-center justify-center p-4 rounded-xl border border-gray-200" data-index="${i}">
                <span class="font-medium text-gray-800">${this.escapeHtml(t.displayName)}</span>
                <span class="text-xs text-gray-400 mt-1 truncate max-w-full">${this.escapeHtml(t.base_url)}</span>
                ${t.provider_type === 'anthropic' ? '<span class="text-[11px] text-teal-500 mt-1">Anthropic</span>' : ''}
            </button>
        `
            )
            .join('');

        this.showModal(`
            <div class="bg-white/95 backdrop-blur-2xl rounded-3xl shadow-2xl border border-white/50 w-full max-w-2xl mx-4 overflow-hidden">
                <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                    <h3 class="text-base font-semibold text-gray-800">选择提供方模板</h3>
                    <button class="modal-close-btn sp-modal-close w-8 h-8 rounded-lg text-gray-400">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="px-6 py-5">
                    <div class="grid grid-cols-2 md:grid-cols-3 gap-3 max-h-[400px] overflow-y-auto">
                        ${templateCards}
                        <button class="provider-custom-btn sp-template-custom-btn flex flex-col items-center justify-center p-4 rounded-xl border border-dashed border-gray-300">
                            <i class="fas fa-plus text-gray-400 mb-1"></i>
                            <span class="text-sm text-gray-500">自定义</span>
                        </button>
                    </div>
                </div>
            </div>
        `);

        // 绑定模板选择事件
        this.querySelectorAll('.provider-template-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const index = parseInt(btn.dataset.index);
                const template = templates[index];
                this.closeModal();
                this.showProviderEditModal(-1, template);
            });
        });
        this.querySelector('.provider-custom-btn')?.addEventListener('click', () => {
            this.closeModal();
            this.showProviderEditModal(-1, null);
        });
        this.querySelectorAll('.modal-close-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                this.closeModal();
            });
        });
    }

    showProviderEditModal(index, template = null) {
        const isEdit = index >= 0;
        const provider = isEdit
            ? this.currentData.providers[index]
            : template || {
                  name: '',
                  provider_type: 'openai',
                  base_url: '',
                  api_key: '',
                  no_proxy: false,
                  no_ssl: false
              };
        const providerType = provider.provider_type === 'anthropic' ? 'anthropic' : 'openai';
        this._editingProviderIndex = index;

        this.showModal(`
            <div class="bg-white/95 backdrop-blur-2xl rounded-3xl shadow-2xl border border-white/50 w-full min-w-[480px] max-w-xl mx-4 overflow-hidden">
                <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                    <h3 class="text-base font-semibold text-gray-800">${isEdit ? '编辑提供方' : '添加提供方'}</h3>
                    <button class="modal-close-btn sp-modal-close w-8 h-8 rounded-lg text-gray-400">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="px-6 py-5 space-y-4">
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1.5">名称</label>
                        <input id="provider-name-input" type="text" value="${this.escapeHtml(provider.name)}" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all" placeholder="例如: openai">
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1.5">协议类型</label>
                        <select id="provider-type-input" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all">
                            <option value="openai" ${providerType === 'openai' ? 'selected' : ''}>OpenAI</option>
                            <option value="anthropic" ${providerType === 'anthropic' ? 'selected' : ''}>Anthropic</option>
                        </select>
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1.5">API 地址</label>
                        <input id="provider-url-input" type="text" value="${this.escapeHtml(provider.base_url)}" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all" placeholder="https://api.example.com/v1">
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1.5">API 密钥</label>
                        <div class="relative">
                            <input id="provider-key-input" type="password" value="${this.escapeHtml(provider.api_key)}" class="w-full px-4 py-2.5 pr-10 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all" placeholder="sk-...">
                            <button id="toggle-key-visibility" class="sp-toggle-key absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">
                                <i class="fas fa-eye text-xs"></i>
                            </button>
                        </div>
                    </div>
                    <div class="flex items-center gap-2">
                        <input id="provider-no-proxy-input" type="checkbox" ${provider.no_proxy ? 'checked' : ''} class="w-4 h-4 rounded border-gray-300 text-blue-500 focus:ring-blue-400/30">
                        <label for="provider-no-proxy-input" class="text-sm text-gray-600">禁用代理</label>
                    </div>
                    <div class="flex items-center gap-2">
                        <input id="provider-no-ssl-input" type="checkbox" ${provider.no_ssl ? 'checked' : ''} class="w-4 h-4 rounded border-gray-300 text-blue-500 focus:ring-blue-400/30">
                        <label for="provider-no-ssl-input" class="text-sm text-gray-600">跳过SSL证书校验</label>
                    </div>
                </div>
                <div class="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
                    <button class="modal-close-btn sp-modal-cancel px-4 py-2 text-sm text-gray-600 rounded-xl">取消</button>
                    <button id="save-provider-btn" class="sp-modal-save px-4 py-2 text-sm text-white bg-gradient-to-r from-blue-500 to-blue-600 rounded-xl">${isEdit ? '保存' : '添加'}</button>
                </div>
            </div>
        `);

        // 绑定事件
        this.querySelectorAll('.modal-close-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                this.closeModal();
            });
        });
        this.querySelector('#toggle-key-visibility')?.addEventListener('click', () => {
            const input = this.querySelector('#provider-key-input');
            const icon = this.querySelector('#toggle-key-visibility i');
            if (input.type === 'password') {
                input.type = 'text';
                icon.classList.remove('fa-eye');
                icon.classList.add('fa-eye-slash');
            } else {
                input.type = 'password';
                icon.classList.remove('fa-eye-slash');
                icon.classList.add('fa-eye');
            }
        });
        this.querySelector('#save-provider-btn')?.addEventListener('click', () => {
            this.saveProvider();
        });
    }

    saveProvider() {
        const name = this.querySelector('#provider-name-input')?.value?.trim();
        const provider_type =
            this.querySelector('#provider-type-input')?.value === 'anthropic' ? 'anthropic' : 'openai';
        const base_url = this.querySelector('#provider-url-input')?.value?.trim();
        const api_key = this.querySelector('#provider-key-input')?.value || '';
        const no_proxy = this.querySelector('#provider-no-proxy-input')?.checked || false;
        const no_ssl = this.querySelector('#provider-no-ssl-input')?.checked || false;

        if (!name) {
            window.notificationAPI.sendNotification('error', '设置', '请输入提供方名称');
            return;
        }

        const provider = { name, provider_type, base_url, api_key, no_proxy, no_ssl };

        if (this._editingProviderIndex >= 0) {
            this.currentData.providers[this._editingProviderIndex] = provider;
        } else {
            if (!this.currentData.providers) this.currentData.providers = [];
            this.currentData.providers.push(provider);
        }

        this.closeModal();
        this.refreshProvidersSection();
        this.scheduleSave();
    }

    deleteProvider(index) {
        const provider = this.currentData.providers[index];
        const modelsUsingProvider = this.currentData.models?.filter((m) => m.provider_name === provider.name) || [];

        const modelCount = modelsUsingProvider.length;
        const message =
            modelCount > 0
                ? `提供方「${provider.name}」下有 ${modelCount} 个关联模型，删除提供方将同时删除这些模型。`
                : `确定要删除提供方「${provider.name}」吗？`;

        this.showModal(`
            <div class="bg-white/95 backdrop-blur-2xl rounded-3xl shadow-2xl border border-white/50 w-full max-w-md mx-4 overflow-hidden">
                <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                    <h3 class="text-base font-semibold text-gray-800">删除提供方</h3>
                    <button class="modal-close-btn sp-modal-close text-gray-400">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="px-6 py-5">
                    <div class="flex items-start gap-3">
                        <div class="shrink-0 w-10 h-10 rounded-full ${modelCount > 0 ? 'bg-amber-50 text-amber-500' : 'bg-red-50 text-red-500'} flex items-center justify-center">
                            <i class="fas ${modelCount > 0 ? 'fa-exclamation-triangle' : 'fa-trash-alt'}"></i>
                        </div>
                        <div class="text-sm text-gray-600 leading-relaxed">${message}</div>
                    </div>
                    ${
                        modelCount > 0
                            ? `
                    <div class="mt-3 ml-[52px] text-xs text-gray-400 bg-gray-50 rounded-lg p-2.5 space-y-0.5">
                        ${modelsUsingProvider.map((m) => `<div class="truncate">· ${m.alias || m.model_name}</div>`).join('')}
                    </div>`
                            : ''
                    }
                </div>
                <div class="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
                    <button class="modal-close-btn sp-modal-cancel px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded-xl">取消</button>
                    <button id="confirm-delete-provider-btn" class="sp-confirm-delete px-4 py-2 text-sm text-white bg-red-500 rounded-xl">确认删除</button>
                </div>
            </div>
        `);

        this.querySelectorAll('.modal-close-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                this.closeModal();
            });
        });
        this.querySelector('#confirm-delete-provider-btn')?.addEventListener('click', () => {
            if (modelCount > 0) {
                this.currentData.models = this.currentData.models.filter((m) => m.provider_name !== provider.name);
                this.refreshModelsSection();
                this.refreshDefaultModelsSection();
            }
            this.currentData.providers.splice(index, 1);
            this.closeModal();
            this.refreshProvidersSection();
            this.scheduleSave();
        });
    }

    refreshProvidersSection() {
        const tabModels = this.querySelector('#tab-models');
        if (!tabModels) return;
        const sections = tabModels.querySelectorAll('section');
        if (sections.length >= 1) {
            sections[0].outerHTML = this.renderProvidersSection();
            // 重新绑定事件
            this.querySelector('#add-provider-btn')?.addEventListener('click', () => {
                this.showProviderTemplateModal();
            });
            this.querySelectorAll('.edit-provider-btn').forEach((btn) => {
                btn.addEventListener('click', (e) => {
                    const index = parseInt(e.currentTarget.dataset.index);
                    this.showProviderEditModal(index);
                });
            });
            this.querySelectorAll('.delete-provider-btn').forEach((btn) => {
                btn.addEventListener('click', (e) => {
                    const index = parseInt(e.currentTarget.dataset.index);
                    this.deleteProvider(index);
                });
            });
        }
    }

    // --- 模型管理 ---
    showModelEditModal(index) {
        const isEdit = index >= 0;
        const model = isEdit
            ? { ...this.currentData.models[index] }
            : {
                  alias: '',
                  provider_name: '',
                  model_name: '',
                  model_type: 'chat',
                  reasoning_effort: '',
                  context_length: undefined,
                  custom_headers: undefined
              };
        model.model_type = this.normalizeModelType(model.model_type);
        this._editingModelIndex = index;

        const providers = this.currentData?.providers || [];
        const providerOptions = providers
            .map(
                (p) =>
                    `<option value="${this.escapeHtml(p.name)}" ${p.name === model.provider_name ? 'selected' : ''}>${this.escapeHtml(p.name)}</option>`
            )
            .join('');

        // 将 custom_headers 转换为 JSON 字符串用于编辑
        // 将 custom_headers 转换为键值对数组
        const headersArray = model.custom_headers
            ? Object.entries(model.custom_headers).map(([k, v]) => ({ key: k, value: v }))
            : [];
        this._customHeaders = headersArray;

        // 生成 headers 列表的 HTML
        const renderHeadersList = () => {
            const items = this._customHeaders
                .map(
                    (h, i) => `
	                <div class="header-item flex items-center gap-2 mb-2" data-index="${i}">
	                    <input type="text" class="header-key sp-form-input" value="${this.escapeHtml(h.key)}" placeholder="${this.escapeHtml(this._t('config.model.header.key'))}">
	                    <input type="text" class="header-value sp-form-input" value="${this.escapeHtml(h.value)}" placeholder="${this.escapeHtml(this._t('config.model.header.value'))}">
	                    <button class="remove-header-btn w-8 h-8 flex items-center justify-center text-gray-400 hover:text-red-500 transition-colors" data-index="${i}">
	                        <i class="fas fa-times"></i>
	                    </button>
	                </div>
	            `
                )
                .join('');
            return (
                items ||
                `<p class="text-xs text-gray-400 italic">${this.escapeHtml(this._t('config.model.header.empty_list'))}</p>`
            );
        };

        this.showModal(`
            <div class="bg-white/95 backdrop-blur-2xl rounded-3xl shadow-2xl border border-white/50 w-full min-w-[480px] max-w-xl mx-4 overflow-hidden">
                <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
	                    <h3 class="text-base font-semibold text-gray-800">${this.escapeHtml(this._t(isEdit ? 'config.model.edit.title.edit' : 'config.model.edit.title.add'))}</h3>
	                    <button class="modal-close-btn sp-modal-close w-8 h-8 rounded-lg text-gray-400">
	                        <i class="fas fa-times"></i>
	                    </button>
	                </div>
	                <div class="px-6 py-5 space-y-4 max-h-[60vh] overflow-y-auto">
	                    <div>
	                        <label class="block text-xs font-medium text-gray-600 mb-1.5">${this.escapeHtml(this._t('config.model.field.alias'))}</label>
	                        <input id="model-alias-input" type="text" value="${this.escapeHtml(model.alias)}" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all" placeholder="${this.escapeHtml(this._t('config.model.field.alias.placeholder'))}">
	                    </div>
	                    <div>
	                        <label class="block text-xs font-medium text-gray-600 mb-1.5">${this.escapeHtml(this._t('config.model.field.provider'))}</label>
	                        <select id="model-provider-input" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all">
	                            <option value="">${this.escapeHtml(this._t('config.model.field.provider.placeholder'))}</option>
	                            ${providerOptions}
	                        </select>
	                    </div>
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1.5">${this._t('config.model.field.model_type')}</label>
                        <select id="model-type-input" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all">
                            <option value="chat" ${model.model_type === 'chat' ? 'selected' : ''}>${this._t('config.model.type.chat')}</option>
                            <option value="embedding" ${model.model_type === 'embedding' ? 'selected' : ''}>${this._t('config.model.type.embedding')}</option>
                        </select>
	                    </div>
	                    <div>
	                        <label class="block text-xs font-medium text-gray-600 mb-1.5">${this.escapeHtml(this._t('config.model.field.model_name'))}</label>
	                        <div class="relative" id="model-name-combo">
	                            <input id="model-name-input" type="text" value="${this.escapeHtml(model.model_name)}" autocomplete="off" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all" placeholder="${this.escapeHtml(this._t('config.model.field.model_name.placeholder'))}">
	                            <div id="model-name-dropdown" class="hidden absolute z-10 left-0 right-0 top-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg max-h-48 overflow-y-auto"></div>
	                        </div>
	                    </div>
	                    <div class="chat-model-field">
	                        <label class="block text-xs font-medium text-gray-600 mb-1.5">${this.escapeHtml(this._t('config.model.field.reasoning_effort'))}</label>
	                        <select id="model-effort-input" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all">
	                            <option value="" ${!model.reasoning_effort ? 'selected' : ''}>${this.escapeHtml(this._t('config.model.option.default'))}</option>
	                            <option value="none" ${model.reasoning_effort === 'none' ? 'selected' : ''}>none</option>
	                            <option value="low" ${model.reasoning_effort === 'low' ? 'selected' : ''}>low</option>
	                            <option value="medium" ${model.reasoning_effort === 'medium' ? 'selected' : ''}>medium</option>
	                            <option value="high" ${model.reasoning_effort === 'high' ? 'selected' : ''}>high</option>
	                        </select>
	                    </div>
	                    <div class="chat-model-field">
	                        <label class="block text-xs font-medium text-gray-600 mb-1.5">${this.escapeHtml(this._t('config.model.field.context_length'))}</label>
	                        <input id="model-context-length-input" type="number" min="0" step="1" value="${model.context_length || ''}" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all" placeholder="${this.escapeHtml(this._t('config.model.field.context_length.placeholder'))}">
	                    </div>
	                    <div class="chat-model-field">
	                        <label class="flex items-center gap-2 cursor-pointer">
	                            <input id="model-auto-parse-think-input" type="checkbox" ${model.auto_parse_think_tags ? 'checked' : ''} class="w-4 h-4 text-indigo-600 bg-white/60 border-gray-200/60 rounded focus:ring-2 focus:ring-blue-400/30 transition-all">
	                            <span class="text-xs font-medium text-gray-600">${this.escapeHtml(this._t('config.model.field.auto_parse_think_tags'))}</span>
	                        </label>
	                    </div>
	                    <div>
	                        <label class="block text-xs font-medium text-gray-600 mb-1.5">${this.escapeHtml(this._t('config.model.field.custom_headers'))}</label>
	                        <div id="headers-list" class="space-y-1">
	                            ${renderHeadersList()}
	                        </div>
	                        <button id="add-header-btn" class="mt-2 w-full py-2 text-sm text-gray-500 bg-gray-50/50 border border-dashed border-gray-200 rounded-lg hover:bg-gray-100/50 transition-colors">
	                            <i class="fas fa-plus mr-2"></i>${this.escapeHtml(this._t('config.model.header.add'))}
	                        </button>
	                        <p class="text-xs text-gray-400 mt-2">${this.escapeHtml(this._t('config.model.field.custom_headers_hint'))}</p>
	                    </div>
	                </div>
	                <div id="model-verify-result" class="mx-6 mb-1 text-sm hidden max-h-48 overflow-y-auto"></div>
	                <div class="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
	                    <button class="modal-close-btn sp-modal-cancel px-4 py-2 text-sm text-gray-600 rounded-xl">${this.escapeHtml(this._t('common.cancel'))}</button>
	                    <button id="save-model-without-verify-btn" class="px-4 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 hover:border-gray-300 transition-all duration-200"><i class="fas fa-save mr-2"></i>${this.escapeHtml(this._t('config.model.action.save_without_verify'))}</button>
	                    <button id="save-model-btn" class="sp-modal-save px-4 py-2 text-sm font-medium text-white bg-gradient-to-r from-indigo-500 to-indigo-600 rounded-xl hover:shadow-md hover:shadow-indigo-200 transition-all duration-200"><i class="fas fa-check-double mr-2"></i>${this._t(isEdit ? 'config.model.verify.save' : 'config.model.verify.add')}</button>
	                </div>
            </div>
        `);

        // Headers 列表操作
        const syncHeadersFromDom = () => {
            this.querySelectorAll('.header-item').forEach((item) => {
                const idx = parseInt(item.dataset.index);
                if (!isNaN(idx) && idx >= 0 && idx < this._customHeaders.length) {
                    this._customHeaders[idx].key = item.querySelector('.header-key')?.value || '';
                    this._customHeaders[idx].value = item.querySelector('.header-value')?.value || '';
                }
            });
        };

        const refreshHeadersList = () => {
            syncHeadersFromDom();
            const container = this.querySelector('#headers-list');
            if (container) {
                container.innerHTML = renderHeadersList();
                bindHeaderItemEvents();
            }
        };

        const bindHeaderItemEvents = () => {
            this.querySelectorAll('.remove-header-btn').forEach((btn) => {
                btn.addEventListener('click', (e) => {
                    const idx = parseInt(e.currentTarget.dataset.index);
                    this._customHeaders.splice(idx, 1);
                    refreshHeadersList();
                });
            });
        };

        this.querySelector('#add-header-btn')?.addEventListener('click', () => {
            this._customHeaders.push({ key: '', value: '' });
            refreshHeadersList();
        });

        bindHeaderItemEvents();

        this.querySelectorAll('.modal-close-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                this.closeModal();
            });
        });
        this.querySelector('#save-model-btn')?.addEventListener('click', () => {
            this.verifyAndSaveModel();
        });
        this.querySelector('#save-model-without-verify-btn')?.addEventListener('click', () => {
            this.saveModel();
        });

        // 模型名称 combo 下拉逻辑
        this._modelNameList = [];
        const nameInput = this.querySelector('#model-name-input');
        const dropdown = this.querySelector('#model-name-dropdown');
        const providerSelect = this.querySelector('#model-provider-input');
        const modelTypeSelect = this.querySelector('#model-type-input');

        const syncModelTypeFields = () => {
            const isEmbedding = modelTypeSelect?.value === 'embedding';
            this.querySelectorAll('.chat-model-field').forEach((field) => {
                field.classList.toggle('hidden', isEmbedding);
            });
            const saveBtn = this.querySelector('#save-model-btn');
            if (saveBtn) {
                saveBtn.innerHTML = isEmbedding
                    ? `<i class="fas fa-check-double mr-2"></i>${this._t(isEdit ? 'config.model.verify.embedding.save' : 'config.model.verify.embedding.add')}`
                    : `<i class="fas fa-check-double mr-2"></i>${this._t(isEdit ? 'config.model.verify.save' : 'config.model.verify.add')}`;
            }
        };
        modelTypeSelect?.addEventListener('change', syncModelTypeFields);
        syncModelTypeFields();

        const renderDropdownItems = (filter) => {
            const keyword = (filter || '').toLowerCase();
            const filtered = keyword
                ? this._modelNameList.filter((n) => n.toLowerCase().includes(keyword))
                : this._modelNameList;
            if (filtered.length === 0) {
                dropdown.classList.add('hidden');
                return;
            }
            dropdown.innerHTML = filtered
                .map(
                    (n) =>
                        `<div class="model-name-option px-4 py-2 text-sm cursor-pointer hover:bg-blue-50 transition-colors truncate" data-value="${this.escapeHtml(n)}">${this.escapeHtml(n)}</div>`
                )
                .join('');
            dropdown.classList.remove('hidden');
            dropdown.querySelectorAll('.model-name-option').forEach((opt) => {
                opt.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    nameInput.value = opt.dataset.value;
                    dropdown.classList.add('hidden');
                });
            });
        };

        const fetchModelsForProvider = async (providerName) => {
            this._modelNameList = [];
            dropdown.classList.add('hidden');
            if (!providerName) return;
            const provider = this.currentData?.providers?.find((p) => p.name === providerName);
            if (!provider || !provider.base_url) return;
            try {
                const models = await window.settingAPI.fetchProviderModels({
                    base_url: provider.base_url,
                    api_key: provider.api_key || '',
                    provider_type: provider.provider_type === 'anthropic' ? 'anthropic' : 'openai',
                    no_proxy: !!provider.no_proxy,
                    no_ssl: !!provider.no_ssl
                });
                if (Array.isArray(models) && models.length > 0) {
                    this._modelNameList = models;
                }
            } catch {
                // 获取失败时静默处理，用户仍可手动输入
            }
        };

        nameInput.addEventListener('focus', () => {
            if (this._modelNameList.length > 0) {
                renderDropdownItems(nameInput.value);
            }
        });
        nameInput.addEventListener('input', () => {
            if (this._modelNameList.length > 0) {
                renderDropdownItems(nameInput.value);
            }
        });
        nameInput.addEventListener('blur', () => {
            // 延迟隐藏以允许 mousedown 事件触发
            setTimeout(() => dropdown.classList.add('hidden'), 150);
        });

        providerSelect.addEventListener('change', () => {
            fetchModelsForProvider(providerSelect.value);
        });

        // 初始加载：如果已有选中的提供方，尝试获取模型列表
        if (providerSelect.value) {
            fetchModelsForProvider(providerSelect.value);
        }
    }

    async verifyAndSaveModel() {
        const alias = this.querySelector('#model-alias-input')?.value?.trim();
        const provider_name = this.querySelector('#model-provider-input')?.value || '';
        const model_name = this.querySelector('#model-name-input')?.value?.trim();
        const model_type = this.normalizeModelType(this.querySelector('#model-type-input')?.value || 'chat');
        const resultDiv = this.querySelector('#model-verify-result');
        const saveBtn = this.querySelector('#save-model-btn');

        if (!alias) {
            window.notificationAPI.sendNotification(
                'error',
                this._t('config.main.title'),
                this._t('config.model.validation.alias_required')
            );
            return;
        }
        if (!provider_name) {
            window.notificationAPI.sendNotification(
                'error',
                this._t('config.main.title'),
                this._t('config.model.validation.provider_required')
            );
            return;
        }
        if (!model_name) {
            window.notificationAPI.sendNotification(
                'error',
                this._t('config.main.title'),
                this._t('config.model.validation.model_name_required')
            );
            return;
        }

        // 从键值对列表收集自定义 headers
        const headersItems = this.querySelectorAll('.header-item');
        const custom_headers = {};
        for (const item of headersItems) {
            const key = item.querySelector('.header-key')?.value?.trim();
            const value = item.querySelector('.header-value')?.value?.trim();
            if (key && value) {
                custom_headers[key] = value;
            }
        }
        this._parsedCustomHeaders = Object.keys(custom_headers).length > 0 ? custom_headers : undefined;

        const provider = this.currentData?.providers?.find((p) => p.name === provider_name);
        if (!provider) {
            window.notificationAPI.sendNotification(
                'error',
                this._t('config.main.title'),
                this._t('config.model.validation.provider_not_found')
            );
            return;
        }

        const origText = saveBtn.innerHTML;
        saveBtn.disabled = true;
        saveBtn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i>${this.escapeHtml(
            this._t(
                model_type === 'embedding' ? 'config.model.verify.status.embedding' : 'config.model.verify.status.chat'
            )
        )}`;
        if (resultDiv) {
            resultDiv.classList.remove('hidden');
            resultDiv.className =
                'mx-6 text-sm p-3 text-blue-600 bg-blue-50 rounded-xl border border-blue-200 max-h-48 overflow-y-auto';
            resultDiv.innerHTML =
                model_type === 'embedding'
                    ? `<i class="fas fa-info-circle mr-2"></i>${this._t('config.model.verify.status.embedding')}`
                    : `<i class="fas fa-info-circle mr-2"></i>${this._t('config.model.verify.status.chat')}`;
        }

        try {
            await window.settingAPI.verifyModel({
                base_url: provider.base_url,
                api_key: provider.api_key,
                provider_type: provider.provider_type === 'anthropic' ? 'anthropic' : 'openai',
                model_name: model_name,
                model_type,
                custom_headers: this._parsedCustomHeaders,
                no_proxy: !!provider.no_proxy,
                no_ssl: !!provider.no_ssl
            });
            if (resultDiv) {
                resultDiv.className =
                    'mx-6 text-sm p-3 text-green-600 bg-green-50 rounded-xl border border-green-200 max-h-48 overflow-y-auto';
                resultDiv.innerHTML = `<i class="fas fa-check-circle mr-2"></i>${this.escapeHtml(this._t('config.model.verify.status.saving'))}`;
            }
            this.saveModel();
        } catch (error) {
            if (resultDiv) {
                resultDiv.className =
                    'mx-6 text-sm p-3 text-red-600 bg-red-50 rounded-xl border border-red-200 max-h-48 overflow-y-auto';
                resultDiv.innerHTML = `<i class="fas fa-times-circle mr-2"></i>${this.escapeHtml(
                    this._t('config.model.verify.failed', { message: error.message || '' })
                )}`;
            }
        } finally {
            saveBtn.disabled = false;
            saveBtn.innerHTML = origText;
        }
    }

    saveModel() {
        const alias = this.querySelector('#model-alias-input')?.value?.trim();
        const provider_name = this.querySelector('#model-provider-input')?.value || '';
        const model_name = this.querySelector('#model-name-input')?.value?.trim();
        const model_type = this.normalizeModelType(this.querySelector('#model-type-input')?.value || 'chat');
        const reasoning_effort = this.querySelector('#model-effort-input')?.value || '';
        const contextLengthRaw = this.querySelector('#model-context-length-input')?.value?.trim();
        const contextLengthNum = contextLengthRaw ? parseInt(contextLengthRaw, 10) : undefined;
        const auto_parse_think_tags = this.querySelector('#model-auto-parse-think-input')?.checked ?? false;

        if (!alias) {
            window.notificationAPI.sendNotification(
                'error',
                this._t('config.main.title'),
                this._t('config.model.validation.alias_required')
            );
            return;
        }

        if (contextLengthRaw && (!Number.isFinite(contextLengthNum) || contextLengthNum < 0)) {
            window.notificationAPI.sendNotification(
                'error',
                this._t('config.main.title'),
                this._t('config.model.validation.context_length_invalid')
            );
            return;
        }

        // 检查别名是否重复
        const existingIndex = this.currentData.models?.findIndex((m) => m.alias === alias);
        if (existingIndex !== undefined && existingIndex !== -1 && existingIndex !== this._editingModelIndex) {
            window.notificationAPI.sendNotification(
                'error',
                this._t('config.main.title'),
                this._t('config.model.validation.alias_exists')
            );
            return;
        }

        // 从 DOM 收集自定义 headers
        const custom_headers = {};
        const headersItems = this.querySelectorAll('.header-item');
        for (const item of headersItems) {
            const key = item.querySelector('.header-key')?.value?.trim();
            const value = item.querySelector('.header-value')?.value?.trim();
            if (key && value) {
                custom_headers[key] = value;
            }
        }

        const model = {
            alias,
            provider_name,
            model_name,
            model_type,
            reasoning_effort: model_type === 'chat' ? reasoning_effort : '',
            auto_parse_think_tags
        };
        if (model_type === 'chat' && contextLengthNum && contextLengthNum > 0) {
            model.context_length = contextLengthNum;
        }
        if (Object.keys(custom_headers).length > 0) {
            model.custom_headers = custom_headers;
        }

        if (this._editingModelIndex >= 0) {
            this.currentData.models[this._editingModelIndex] = model;
        } else {
            if (!this.currentData.models) this.currentData.models = [];
            this.currentData.models.push(model);
        }

        this.closeModal();
        this.refreshModelsSection();
        this.refreshDefaultModelsSection();
        this.scheduleSave();
    }

    deleteModel(index) {
        const model = this.currentData.models[index];

        // 检查是否是默认模型
        const isDefault = [
            'default_model',
            'default_embedding_model',
            'default_reranker_model',
            'default_vision_model',
            'default_intent_parsing_model'
        ].some((field) => this.currentData[field] === model.alias);

        if (isDefault) {
            window.notificationAPI.sendNotification(
                'warning',
                this._t('config.main.title'),
                this._t('config.model.delete.default.title'),
                this._t('config.model.delete.default.message')
            );
            return;
        }

        this.currentData.models.splice(index, 1);
        this.refreshModelsSection();
        this.refreshDefaultModelsSection();
        this.scheduleSave();
    }

    refreshModelsSection() {
        const tabModels = this.querySelector('#tab-models');
        if (!tabModels) return;
        const sections = tabModels.querySelectorAll('section');
        if (sections.length >= 2) {
            sections[1].outerHTML = this.renderModelsSection();
            this.querySelector('#add-model-btn')?.addEventListener('click', () => {
                this.showModelEditModal(-1);
            });
            this.querySelectorAll('.edit-model-btn').forEach((btn) => {
                btn.addEventListener('click', (e) => {
                    const index = parseInt(e.currentTarget.dataset.index);
                    this.showModelEditModal(index);
                });
            });
            this.querySelectorAll('.delete-model-btn').forEach((btn) => {
                btn.addEventListener('click', (e) => {
                    const index = parseInt(e.currentTarget.dataset.index);
                    this.deleteModel(index);
                });
            });
        }
    }

    refreshGeneralSection() {
        const tabGeneral = this.querySelector('#tab-general');
        if (!tabGeneral) return;
        const sections = tabGeneral.querySelectorAll('section');
        if (sections.length >= 1) {
            sections.forEach((s) => s.remove());
            tabGeneral.innerHTML = this.renderGeneralSection();
            // 重新绑定事件
            this.querySelector('#locale-select')?.addEventListener('change', (e) => {
                this.currentData.locale = e.target.value;
                this._t = createRendererTranslator(this.currentData.locale === 'auto' ? 'auto' : this.currentData);
                this.refreshGeneralSection();
                void this.saveImmediately().then(() => {
                    this._t = createRendererTranslator(this.currentData);
                    this.refreshGeneralSection();
                });
            });
            this.querySelector('#font-preset-select')?.addEventListener('change', (e) => {
                const preset = e.target.value;
                if (!this.currentData.gui_config) this.currentData.gui_config = {};
                this.currentData.gui_config.font_preset = preset;
                document.documentElement.setAttribute('data-font-preset', preset);
                window.broadcastFontSettings?.(preset);
                this.saveImmediately();
            });
            this.querySelector('#theme-preference-select')?.addEventListener('change', async (e) => {
                const pref = e.target.value;
                if (!this.currentData.gui_config) this.currentData.gui_config = {};
                this.currentData.gui_config.theme_preference = pref;
                if (window.themeAPI?.setPreference) {
                    try {
                        const result = await window.themeAPI.setPreference(pref);
                        if (result.status === 'ok' && result.data) {
                            const { applyResolvedTheme } = await import('../theme/theme-renderer.ts');
                            applyResolvedTheme(result.data);
                            window.broadcastThemeSettings?.(result.data);
                        }
                    } catch (err) {
                        console.warn('[setting] theme setPreference failed', err);
                    }
                }
                this.saveImmediately();
            });
            this.querySelector('#debug-mode-toggle-hidden')?.addEventListener('change', (e) => {
                if (!this.currentData.debug) this.currentData.debug = {};
                this.currentData.debug.developer_mode = e.target.checked;
                this.saveImmediately();
            });

            this.querySelector('#experimental-feature-toggle-hidden')?.addEventListener('change', (e) => {
                if (!this.currentData.debug) this.currentData.debug = {};
                this.currentData.debug.experimental_feature = e.target.checked;
                this.saveImmediately();
            });

            this._bindConfigManagementEvents();

            this.querySelectorAll('.scale-step-btn, .scale-step-label').forEach((el) => {
                el.addEventListener('click', async () => {
                    const value = parseFloat(el.dataset.value);
                    if (!this.currentData.gui_config) this.currentData.gui_config = {};
                    this.currentData.gui_config.scale_factor = value;
                    if (window.displayAPI?.setScaleFactor) {
                        await window.displayAPI.setScaleFactor(value);
                    }
                    this.refreshGeneralSection();
                    this.saveImmediately();
                });
            });
            this._bindGatewayEvents();
            this._bindEnvironEvents();
        }
    }

    refreshDefaultModelsSection() {
        const tabModels = this.querySelector('#tab-models');
        if (!tabModels) return;
        const sections = tabModels.querySelectorAll('section');
        if (sections.length >= 3) {
            sections[2].outerHTML = this.renderDefaultModelsSection();
            this.updateDefaultModelSelects();
            const selects = [
                'default-model-select',
                'default-embedding-model-select',
                'default-reranker-model-select',
                'default-vision-model-select',
                'default-intent-model-select'
            ];
            selects.forEach((id) => {
                this.querySelector(`#${id}`)?.addEventListener('change', (e) => {
                    const field = this.getDefaultModelFieldMap()[id];
                    this.currentData[field] = e.target.value;
                    this.saveImmediately();
                });
            });
        }
    }

    // --- QuickPass 模态框 ---
    showExportQuickPassModal() {
        this.showModal(`
            <div class="bg-white/95 backdrop-blur-2xl rounded-3xl shadow-2xl border border-white/50 w-full min-w-[480px] max-w-lg mx-4 overflow-hidden">
                <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                    <h3 class="text-base font-semibold text-gray-800">导出口令</h3>
                    <button class="modal-close-btn sp-modal-close w-8 h-8 rounded-lg text-gray-400">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="px-6 py-5 space-y-4">
                    <div class="flex gap-3">
                        <button id="export-base-btn" class="sp-export-option-btn sp-export-base flex-1 py-3 text-sm text-gray-700 bg-white border border-gray-200 rounded-xl">
                            <i class="fas fa-cog mr-2 text-blue-500"></i>基础设置口令
                        </button>
                        <button id="export-all-btn" class="sp-export-option-btn sp-export-all flex-1 py-3 text-sm text-gray-700 bg-white border border-gray-200 rounded-xl">
                            <i class="fas fa-box mr-2 text-purple-500"></i>全部设置口令
                        </button>
                    </div>
                    <textarea id="export-result" readonly class="w-full h-32 px-4 py-3 text-xs font-mono bg-gray-50 border border-gray-200 rounded-xl resize-none focus:outline-none" placeholder="点击上方按钮生成口令..."></textarea>
                    <button id="copy-quickpass-btn" class="sp-modal-save w-full py-2.5 text-sm text-white bg-gradient-to-r from-gray-700 to-gray-600 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed" disabled>
                        <i class="fas fa-copy mr-2"></i>复制到剪贴板
                    </button>
                </div>
            </div>
        `);

        this.querySelectorAll('.modal-close-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                this.closeModal();
            });
        });
        this.querySelector('#export-base-btn')?.addEventListener('click', async () => {
            try {
                const quickpass = await window.quickpassAPI.exportBaseConfig();
                this.querySelector('#export-result').value = quickpass;
                this.querySelector('#copy-quickpass-btn').disabled = false;
            } catch (error) {
                window.notificationAPI.sendNotification('error', '设置', '导出失败', error.message);
            }
        });
        this.querySelector('#export-all-btn')?.addEventListener('click', async () => {
            try {
                const quickpass = await window.quickpassAPI.exportAllConfig();
                this.querySelector('#export-result').value = quickpass;
                this.querySelector('#copy-quickpass-btn').disabled = false;
            } catch (error) {
                window.notificationAPI.sendNotification('error', '设置', '导出失败', error.message);
            }
        });
        this.querySelector('#copy-quickpass-btn')?.addEventListener('click', async () => {
            const text = this.querySelector('#export-result')?.value;
            if (text) {
                await navigator.clipboard.writeText(text);
                window.notificationAPI.sendNotification('info', '设置', '导出成功', '口令已复制到剪贴板');
            }
        });
    }

    showImportQuickPassModal() {
        this.showModal(`
            <div class="bg-white/95 backdrop-blur-2xl rounded-3xl shadow-2xl border border-white/50 w-full min-w-[480px] max-w-lg mx-4 overflow-hidden">
                <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                    <h3 class="text-base font-semibold text-gray-800">导入口令</h3>
                    <button class="modal-close-btn sp-modal-close w-8 h-8 rounded-lg text-gray-400">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="px-6 py-5 space-y-4">
                    <textarea id="import-input" class="w-full h-32 px-4 py-3 text-xs font-mono bg-white/60 border border-gray-200/60 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all" placeholder="粘贴口令..."></textarea>
                    <div id="import-result" class="text-sm"></div>
                    <button id="import-quickpass-confirm-btn" class="sp-modal-save w-full py-2.5 text-sm text-white bg-gradient-to-r from-blue-500 to-blue-600 rounded-xl">
                        <i class="fas fa-check mr-2"></i>导入
                    </button>
                </div>
            </div>
        `);

        this.querySelectorAll('.modal-close-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                this.closeModal();
            });
        });
        this.querySelector('#import-quickpass-confirm-btn')?.addEventListener('click', async () => {
            const quickpass = this.querySelector('#import-input')?.value?.trim();
            if (!quickpass) {
                window.notificationAPI.sendNotification('error', '设置', '请输入口令');
                return;
            }

            const resultDiv = this.querySelector('#import-result');
            resultDiv.innerHTML =
                '<span class="text-gray-500"><i class="fas fa-spinner fa-spin mr-2"></i>正在导入...</span>';

            try {
                const result = await window.quickpassAPI.importQuickPass(quickpass);
                const hasApps = result.hasApplications;
                resultDiv.innerHTML = `<span class="text-green-500"><i class="fas fa-check-circle mr-2"></i>导入成功：${this.escapeHtml(result.name)}${hasApps ? '（含应用配置）' : '（基础设置）'}</span>`;

                // 刷新数据
                await this.loadData();
                this._hasRendered = false;
                this.render();
                this.setUpEventListeners();
            } catch (error) {
                resultDiv.innerHTML = `<span class="text-red-500"><i class="fas fa-times-circle mr-2"></i>导入失败：${this.escapeHtml(error.message)}</span>`;
            }
        });
    }

    // --- 设备网关设置 ---
    _saveGatewayConfig(config) {
        if (!this.currentData.applications) this.currentData.applications = {};
        const existing = this.currentData.applications.devicemgr || {};
        this.currentData.applications.devicemgr = {
            ...existing,
            enabled: config.enabled,
            host: config.host,
            port: config.port,
            autoApproveLocal: config.autoApproveLocal
        };
        this.saveImmediately();
    }

    _bindGatewayEvents() {
        this.querySelector('#gateway-host-select')?.addEventListener('change', (e) => {
            const host = this._normalizeGatewayHost(e.target.value);
            const current = this._getGatewayConfig();
            this._saveGatewayConfig({
                ...current,
                enabled: host !== 'none',
                host
            });
            this.refreshGeneralSection();
        });

        this.querySelector('#gateway-port-input')?.addEventListener('change', (e) => {
            const port = parseInt(e.target.value, 10);
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
                window.notificationAPI.sendNotification('error', '设置', '网关端口必须是 1-65535 之间的整数');
                e.target.value = String(this._getGatewayConfig().port);
                return;
            }
            const current = this._getGatewayConfig();
            this._saveGatewayConfig({
                ...current,
                port
            });
            this.refreshGeneralSection();
        });

        this.querySelector('#gateway-auto-approve-input')?.addEventListener('change', (e) => {
            const current = this._getGatewayConfig();
            this._saveGatewayConfig({
                ...current,
                autoApproveLocal: e.target.checked
            });
        });
    }

    // --- 环境变量管理 ---
    _bindEnvironEvents() {
        const syncEnvironFromDom = () => {
            this.querySelectorAll('.environ-item').forEach((item) => {
                const idx = parseInt(item.dataset.index);
                if (!isNaN(idx) && idx >= 0 && idx < this._environEntries.length) {
                    this._environEntries[idx].key = item.querySelector('.environ-key')?.value || '';
                    this._environEntries[idx].value = item.querySelector('.environ-value')?.value || '';
                }
            });
        };

        const refreshEnvironList = () => {
            syncEnvironFromDom();
            // 保存到 currentData
            const environ = {};
            for (const entry of this._environEntries) {
                if (entry.key && entry.value) {
                    environ[entry.key] = entry.value;
                }
            }
            this.currentData.environ = Object.keys(environ).length > 0 ? environ : {};
            this.saveImmediately();

            const container = this.querySelector('#environ-list');
            if (container) {
                const items = this._environEntries
                    .map(
                        (entry, i) => `
                    <div class="environ-item flex items-center gap-2 mb-2" data-index="${i}">
                        <input type="text" class="environ-key sp-form-input" value="${this.escapeHtml(entry.key)}" placeholder="变量名">
                        <span class="text-gray-400 text-xs">=</span>
                        <input type="text" class="environ-value sp-form-input" value="${this.escapeHtml(entry.value)}" placeholder="变量值">
                        <button class="remove-environ-btn sp-card-action-btn sp-delete-btn" data-index="${i}">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                `
                    )
                    .join('');
                container.innerHTML = items || '<p class="text-xs text-gray-400 italic">暂无环境变量</p>';
                bindEnvironItemEvents();
            }
        };

        const bindEnvironItemEvents = () => {
            this.querySelectorAll('.remove-environ-btn').forEach((btn) => {
                btn.addEventListener('click', (e) => {
                    const idx = parseInt(e.currentTarget.dataset.index);
                    this._environEntries.splice(idx, 1);
                    refreshEnvironList();
                });
            });
            // 监听输入变化，自动保存
            this.querySelectorAll('.environ-key, .environ-value').forEach((input) => {
                input.addEventListener('change', () => {
                    refreshEnvironList();
                });
            });
        };

        // 初始填充 _environEntries
        const environ = this.currentData?.environ || {};
        this._environEntries = Object.entries(environ).map(([k, v]) => ({ key: k, value: v }));

        this.querySelector('#add-environ-btn')?.addEventListener('click', () => {
            this._environEntries.push({ key: '', value: '' });
            refreshEnvironList();
        });

        bindEnvironItemEvents();
    }

    // --- 模态框工具方法 ---
    showModal(content) {
        const overlay = this.querySelector('#modal-overlay');
        const container = this.querySelector('#modal-container');
        const contentEl = this.querySelector('#modal-content');

        if (overlay && container && contentEl) {
            contentEl.innerHTML = content;
            overlay.classList.remove('hidden');
            container.classList.remove('hidden');
        }

        // ESC 关闭模态框（capture 阶段，优先于 guiShortcutManager）
        if (this._modalEscHandler) {
            document.removeEventListener('keydown', this._modalEscHandler, true);
        }
        this._modalEscHandler = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                this.closeModal();
            }
        };
        document.addEventListener('keydown', this._modalEscHandler, true);
    }

    closeModal() {
        const overlay = this.querySelector('#modal-overlay');
        const container = this.querySelector('#modal-container');

        if (overlay && container) {
            overlay.classList.add('hidden');
            container.classList.add('hidden');
        }

        if (this._modalEscHandler) {
            document.removeEventListener('keydown', this._modalEscHandler, true);
            this._modalEscHandler = null;
        }
    }

    // --- 工具方法 ---
    maskApiKey(key) {
        if (!key) return '未设置';
        if (key.length <= 8) return '****';
        return key.substring(0, 4) + '****' + key.substring(key.length - 4);
    }

    getEffortLabel(effort) {
        const labels = { none: '无推理', low: '低', medium: '中', high: '高' };
        return labels[effort] || '';
    }

    escapeHtml(text) {
        if (!text) return '';
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}

customElements.define('setting-panel', SettingPanel);
