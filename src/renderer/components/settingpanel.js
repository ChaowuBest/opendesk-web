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
import { showConfirmModal } from './confirmModal.ts';

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
        this.buildTime = null;
        this._activeTab = 'models';
        this._environEntries = [];
        this.gatewayHostOptions = [];
        this.visionSupportMap = {};
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
        await this.refreshVisionSupport();
        this.providerTemplates = await window.settingAPI.getProviderTemplates();
        try {
            this.gatewayHostOptions = await window.settingAPI.getGatewayHostOptions();
        } catch (e) {
            console.warn('Failed to load gateway host options:', e);
            this.gatewayHostOptions = [
                { value: 'none', label: this._t('sp.gateway.host.none') },
                { value: '127.0.0.1', label: this._t('sp.gateway.host.localhost') },
                { value: '0.0.0.0', label: this._t('sp.gateway.host.all') }
            ];
        }
        try {
            this.appVersion = await window.settingAPI.getVersion();
        } catch (e) {
            console.warn('Failed to load version:', e);
        }
        try {
            const info = await window.settingAPI.getBuildTime();
            if (info) {
                const label = info.dev ? this._t('sp.build.dev') : this._t('sp.build.time');
                const formatted = new Date(info.time).toLocaleString(undefined, {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                });
                this.buildTime = `${label} ${formatted}`;
            }
        } catch (e) {
            console.warn('Failed to load build time:', e);
        }
    }

    render() {
        if (this._hasRendered) {
            this._switchTab(this._activeTab);
            return;
        }
        const svg = (p) =>
            `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
        const tabs = [
            {
                id: 'models',
                label: this._t('sp.tab.models'),
                iconSvg: svg(
                    '<rect x="4" y="4" width="16" height="16" rx="3"/><rect x="9" y="9" width="6" height="6"/>'
                )
            },
            {
                id: 'tasks',
                label: this._t('sp.tab.tasks'),
                iconSvg: svg(
                    '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>'
                )
            },
            {
                id: 'search',
                label: this._t('sp.tab.search'),
                iconSvg: svg('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>')
            },
            {
                id: 'general',
                label: this._t('sp.tab.general'),
                iconSvg: svg(
                    '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>'
                )
            },
            {
                id: 'wizard',
                label: this._t('sp.tab.wizard'),
                iconSvg: svg(
                    '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>'
                )
            }
        ];

        const tabButtons = tabs
            .map((t) => {
                const active = t.id === this._activeTab;
                return `<button class="sp-nav-item ${active ? 'active' : ''}" data-tab="${t.id}">
                ${t.iconSvg} ${t.label}
            </button>`;
            })
            .join('');

        this.innerHTML = `
        <style>
            /* ═══ CSS Variables ═══ */
            :root {
                --sp-color-primary: #DF4436;
                --sp-color-primary-hover: #C83A2D;
                --sp-color-primary-light: #FDEEEC;
                --sp-color-primary-bg: #FEF9F8;
                --sp-color-text: #1C1917;
                --sp-color-text-secondary: #4A4642;
                --sp-color-text-tertiary: #8A8580;
                --sp-color-text-quaternary: #B4AFA9;
                --sp-color-border: #E7E5E2;
                --sp-color-border-light: #EFEEEA;
                --sp-color-bg: #FFFFFF;
                --sp-color-bg-page: #F5F4F2;
                --sp-color-bg-sidebar: #FAF9F7;
                --sp-color-bg-hover: #F0EFEC;
                --sp-color-success: #1F9D66;
                --sp-color-success-light: #E7F5EE;
                --sp-color-danger: #ef4444;
                --sp-color-warning: #B87503;
                --sp-color-warning-light: #FDF3E3;
                --sp-color-blue: #4267B2;
                --sp-color-blue-light: #EBF1FB;
                --sp-radius-sm: 8px;
                --sp-radius-md: 8px;
                --sp-radius-lg: 12px;
                --sp-radius-xl: 14px;
                --sp-shadow-sm: 0 1px 2px rgba(0,0,0,0.04);
                --sp-shadow-md: 0 1px 2px rgba(28,25,23,.04), 0 8px 24px rgba(28,25,23,.05);
                --sp-font-sans: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Helvetica Neue', 'Microsoft YaHei', sans-serif;
            }

            /* Dark theme overrides — use app-level variables */
            /* Dark theme overrides (design spec dark mode) */
            html[data-theme='dark'] {
                --sp-color-primary: #E8563F;
                --sp-color-primary-hover: #D93826;
                --sp-color-primary-light: rgba(232,86,63,.16);
                --sp-color-primary-bg: rgba(232,86,63,.09);
                --sp-color-text: #EFEDEA;
                --sp-color-text-secondary: #D5D1CB;
                --sp-color-text-tertiary: #9B968F;
                --sp-color-text-quaternary: #6F6A63;
                --sp-color-border: #3B3835;
                --sp-color-border-light: #33302D;
                --sp-color-bg: #2A2826;
                --sp-color-bg-page: var(--od-bg);
                --sp-color-bg-sidebar: var(--od-bg-muted);
                --sp-color-bg-hover: #33302D;
                --sp-color-success: #3DBF82;
                --sp-color-success-light: rgba(61,191,130,.15);
                --sp-color-warning: #E2A23B;
                --sp-color-warning-light: rgba(226,162,59,.15);
                --sp-color-blue: #7AA2E8;
                --sp-color-blue-light: rgba(122,162,232,.16);
                --sp-shadow-sm: 0 1px 2px rgba(0,0,0,0.25);
                --sp-shadow-md: 0 1px 2px rgba(0,0,0,.25), 0 8px 24px rgba(0,0,0,.3);
            }

            /* ── Left sidebar navigation (Tabs) ── */
            .sp-nav {
                width: 164px; flex: none;
                display: flex; flex-direction: column; gap: 2px;
            }
            .sp-nav-item {
                width: 100%; justify-content: flex-start;
                background: none; border: 0; border-radius: 8px;
                padding: 8px 10px; font-family: inherit; font-size: 12.5px;
                color: var(--sp-color-text-secondary); cursor: pointer;
                display: inline-flex; align-items: center; gap: 6px;
                transition: background .15s ease, color .15s ease;
                white-space: nowrap;
            }
            .sp-nav-item svg {
                flex-shrink: 0;
            }
            .sp-nav-item:hover {
                background: var(--sp-color-bg-hover, #F0EFEC);
            }
            .sp-nav-item:focus-visible {
                outline: 2px solid var(--sp-color-primary);
                outline-offset: 2px;
            }
            .sp-nav-item.active {
                background: var(--sp-color-primary-light, #FDEEEC);
                color: var(--sp-color-primary, #DF4436);
            }
            html[data-theme='dark'] .sp-nav-item:hover {
                background: #33302D;
            }
            html[data-theme='dark'] .sp-nav-item.active {
                background: rgba(232, 86, 63, .16);
                color: #E8563F;
            }

            /* ── Section ── */
            .sp-section {
                margin-bottom: 20px;
            }
            .sp-section-card {
                background: var(--sp-color-bg);
                border: 1px solid var(--sp-color-border);
                border-radius: var(--sp-radius-lg);
                padding: 14px;
            }
            .sp-section-title {
                font-size: 14px;
                font-weight: 600;
                color: var(--sp-color-text);
                margin-bottom: 10px;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .sp-section-subtitle {
                font-size: 11.5px;
                color: var(--sp-color-text-tertiary);
                margin-left: 6px;
                font-weight: 400;
            }
            .sp-section-desc {
                font-size: 11.5px;
                color: var(--sp-color-text-tertiary);
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
                padding: 6px 10px;
                font-size: 12px;
                border: 1px solid var(--sp-color-border);
                border-radius: var(--sp-radius-sm);
                background: var(--sp-color-bg);
                color: var(--sp-color-text);
                transition: border-color 0.15s, box-shadow 0.15s;
                outline: none;
                font-family: var(--sp-font-sans);
            }
            .sp-form-input::placeholder { color: var(--sp-color-text-quaternary); }
            .sp-form-input:focus {
                border-color: var(--sp-color-primary);
                outline: none;
            }
            textarea.sp-form-input {
                resize: vertical;
                min-height: 80px;
            }
            select.sp-form-input {
                appearance: none;
                background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='%238A8580' viewBox='0 0 16 16'%3E%3Cpath d='M4.5 6l3.5 4 3.5-4z'/%3E%3C/svg%3E");
                background-repeat: no-repeat;
                background-position: right 9px center;
                padding-right: 26px;
                cursor: pointer;
            }

            /* ── Toggle Switch ── */
            .sp-toggle-row {
                display: flex;
                align-items: center;
                gap: 14px;
                padding: 13px 0;
                border-bottom: 1px solid var(--sp-color-border-light);
            }
            .sp-toggle-row:last-child { border-bottom: none; }
            .sp-toggle-info { flex: 1; min-width: 0; }
            .sp-toggle-label {
                font-size: 13px;
                font-weight: 500;
                color: var(--sp-color-text);
            }
            .sp-toggle-desc {
                font-size: 11.5px;
                color: var(--sp-color-text-tertiary);
                margin-top: 3px;
            }
            .sp-toggle-switch {
                position: relative;
                width: 36px;
                height: 20px;
                flex-shrink: 0;
                margin-left: 14px;
            }
            .sp-toggle-switch input {
                opacity: 0;
                width: 0;
                height: 0;
            }
            .sp-toggle-track {
                position: absolute;
                inset: 0;
                background: #D8D4CE;
                border-radius: 999px;
                cursor: pointer;
                transition: background 0.2s;
            }
            .sp-toggle-track::after {
                content: '';
                position: absolute;
                top: 2px;
                left: 2px;
                width: 16px;
                height: 16px;
                background: #fff;
                border-radius: 50%;
                transition: transform 0.2s;
                box-shadow: var(--sp-shadow-sm);
            }
            .sp-toggle-switch input:checked + .sp-toggle-track {
                background: var(--sp-color-primary);
            }
            .sp-toggle-switch input:checked + .sp-toggle-track::after {
                transform: translateX(16px);
            }
            html[data-theme='dark'] .sp-toggle-track { background: #4A4642; }

            /* ── Buttons ── */
            .sp-btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 4px;
                padding: 6px 14px;
                font-size: 12px;
                font-weight: 600;
                border-radius: var(--sp-radius-sm);
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
            .sp-btn-sm { padding: 4px 10px; font-size: 11.5px; }

            /* ── Cards (Provider / Model / Search) ── */
            .sp-card {
                background: var(--sp-color-bg);
                border: 1px solid var(--sp-color-border);
                border-radius: var(--sp-radius-lg);
                padding: 11px 13px;
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
                padding: 12px;
                font-size: 12.5px;
                color: var(--sp-color-text-tertiary);
                background: transparent;
                border: 1.5px dashed #D8D4CE;
                border-radius: var(--sp-radius-lg);
                cursor: pointer;
                transition: all 0.15s;
                font-family: var(--sp-font-sans);
            }
            .sp-add-btn:hover {
                color: var(--sp-color-primary);
                border-color: var(--sp-color-primary);
            }
            html[data-theme='dark'] .sp-add-btn:hover {
                background: rgba(255,255,255,0.03);
            }

            /* ── Tags / Badges ── */
            .sp-tag {
                display: inline-flex;
                align-items: center;
                padding: 1px 7px;
                font-size: 10px;
                font-weight: 500;
                border-radius: 5px;
                white-space: nowrap;
                flex-shrink: 0;
            }
            .sp-tag-primary {
                background: var(--sp-color-primary-light);
                color: var(--sp-color-primary);
                border: 1px solid #c7d2fe;
            }
            .sp-tag-success {
                background: var(--sp-color-success-light);
                color: var(--sp-color-success);
                border: none;
            }
            .sp-tag-warning {
                background: var(--sp-color-warning-light);
                color: var(--sp-color-warning);
                border: none;
            }
            .sp-tag-neutral {
                background: #F1EFEC;
                color: var(--sp-color-text-tertiary);
                border: none;
            }
            .sp-tag-blue {
                background: var(--sp-color-blue-light);
                color: var(--sp-color-blue);
                border: none;
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
            html[data-theme='dark'] .sp-tag-teal {
                background: rgba(13, 148, 136, 0.12);
                color: #5eead4;
                border-color: rgba(13, 148, 136, 0.3);
            }
            html[data-theme='dark'] .sp-tag-blue {
                background: rgba(59, 130, 246, 0.12);
                color: #93c5fd;
                border-color: rgba(59, 130, 246, 0.3);
            }
            html[data-theme='dark'] .sp-tag-emerald {
                background: rgba(5, 150, 105, 0.12);
                color: #6ee7b7;
                border-color: rgba(5, 150, 105, 0.3);
            }

            /* ── Telemetry URL Input ── */
            .sp-telemetry-url {
                flex: 1;
                min-width: 0;
                font-family: var(--sp-font-mono, 'Maple Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', 'Monaco', monospace);
                font-size: 13px;
                color: var(--sp-color-text);
                background: transparent;
                border: 1px solid transparent;
                border-radius: var(--sp-radius-sm, 6px);
                padding: 4px 8px;
                outline: none;
                transition: border-color 0.15s, background 0.15s;
            }
            .sp-telemetry-url:hover {
                background: rgba(0,0,0,0.03);
            }
            html[data-theme='dark'] .sp-telemetry-url:hover {
                background: rgba(255,255,255,0.04);
            }
            .sp-telemetry-url:focus {
                border-color: var(--sp-color-primary);
                background: var(--sp-color-bg);
                outline: none;
            }
            .sp-telemetry-delete-btn:hover {
                color: var(--sp-color-danger, #ef4444) !important;
                background: rgba(239, 68, 68, 0.08) !important;
            }

            /* ── Telemetry Endpoint Row ── */
            .sp-telemetry-row {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 10px 14px;
                border-radius: var(--sp-radius-md, 8px);
                border: 1px solid var(--sp-color-border-light);
                background: var(--sp-color-bg-page, #F5F4F2);
                transition: border-color 0.15s, box-shadow 0.15s;
            }
            .sp-telemetry-row:hover {
                border-color: var(--sp-color-border);
                box-shadow: var(--sp-shadow-sm, 0 1px 2px rgba(0,0,0,0.05));
            }
            html[data-theme='dark'] .sp-telemetry-row {
                background: rgba(255,255,255,0.03);
                border-color: var(--od-border, #1f2937);
            }
            html[data-theme='dark'] .sp-telemetry-row:hover {
                border-color: var(--od-border-strong, #374151);
                background: rgba(255,255,255,0.05);
            }
            .sp-telemetry-row .sp-toggle-switch {
                margin-left: 0;
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
                transform: scale(1.05);
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
                cursor: pointer;
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
                background: color-mix(in srgb, var(--sp-color-bg-page) 88%, transparent);
                backdrop-filter: blur(12px);
                border-bottom: 1px solid var(--sp-color-border);
            }
            html[data-theme='dark'] .sp-header {
                background: color-mix(in srgb, var(--od-bg) 85%, transparent);
                border-bottom-color: #3B3835;
            }
            .sp-header-title {
                font-size: 17px;
                font-weight: 650;
                color: var(--sp-color-text);
            }

            /* ── Footer ── */
            .sp-footer {
                flex-shrink: 0;
                padding: 14px 22px 8px;
                border-top: 1px solid var(--sp-color-border-light);
                text-align: center;
                background: var(--sp-color-bg);
            }
            .sp-footer-text {
                font-size: 11px;
                color: var(--sp-color-text-quaternary);
            }
            .sp-footer-link {
                font-size: 11px;
                color: var(--sp-color-primary, #DF4436);
                cursor: pointer;
                text-decoration: none;
                margin-left: 16px;
            }
            .sp-footer-link:hover {
                text-decoration: underline;
            }

            /* ── Dark mode component overrides (design spec) ── */
            html[data-theme='dark'] .sp-add-btn {
                border-color: #4A4642;
            }
            html[data-theme='dark'] .sp-tag-neutral {
                background: #2E2B28;
            }
            html[data-theme='dark'] .sp-form-input::placeholder {
                color: #6F6A63;
            }
            html[data-theme='dark'] .sp-telemetry-row {
                background: rgba(255,255,255,0.03);
                border-color: var(--od-border, #33302D);
            }
            html[data-theme='dark'] .sp-telemetry-row:hover {
                border-color: var(--od-border-strong, #3B3835);
                background: rgba(255,255,255,0.05);
            }
        </style>
        <div class="w-full h-full overflow-hidden flex flex-col" style="background:var(--sp-color-bg-page)">
            <!-- 固定在右上角的工具栏 -->
            <div id="setting-panel-toolbar" class="sp-fixed-toolbar"></div>

            <!-- 顶部标题栏 -->
            <div class="sp-header">
                <div class="px-6 py-4 flex items-center">
                    <h1 class="sp-header-title">${this._t('sp.title')}</h1>
                    <span id="save-indicator" class="ml-4 text-xs text-green-500 opacity-0 transition-opacity duration-300 flex items-center gap-1">
                        <i class="fas fa-check-circle"></i> ${this._t('sp.saved')}
                    </span>
                </div>
            </div>

            <!-- 主体：左栏导航 + 内容区 -->
            <div class="flex-1 flex flex-col overflow-hidden">
                <div class="flex-1 flex overflow-hidden">
                    <!-- 左栏导航 -->
                    <nav class="sp-nav" style="background:var(--sp-color-bg-sidebar); border-right:1px solid var(--sp-color-border); padding:16px 12px;">
                        ${tabButtons}
                    </nav>

                    <!-- 可滚动内容区 -->
                    <div class="sp-scroll-content flex-1 overflow-y-auto" style="padding:16px 22px 8px;">
                        <div id="tab-models" class="${this._activeTab === 'models' ? '' : 'hidden'} space-y-5">
                            ${this.renderProvidersSection()}
                            ${this.renderModelsSection()}
                            ${this.renderDefaultModelsSection()}
                        </div>
                        <div id="tab-tasks" class="${this._activeTab === 'tasks' ? '' : 'hidden'} space-y-5">
                            ${this.renderTaskSection()}
                        </div>
                        <div id="tab-search" class="${this._activeTab === 'search' ? '' : 'hidden'} space-y-5">
                            ${this.renderSearchSection()}
                        </div>
                        <div id="tab-general" class="${this._activeTab === 'general' ? '' : 'hidden'} space-y-5">
                            ${this.renderGeneralSection()}
                        </div>
                        <div id="tab-wizard" class="${this._activeTab === 'wizard' ? '' : 'hidden'} space-y-5">
                            ${this.renderWizardSection()}
                        </div>
                    </div>
                </div>

                <!-- 底部版本信息栏 -->
                <div class="sp-footer">
                    <span class="sp-footer-text">OpenDesk v${this.appVersion || '...'} · ${this.buildTime || ''}</span>
                    <a class="sp-footer-link" id="privacy-link">${this._t('sp.privacy')}</a>
                </div>
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
        this.querySelectorAll('.sp-nav-item[data-tab]').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.tab === tab);
        });
        const tabIds = ['models', 'tasks', 'search', 'general', 'wizard'];
        for (const id of tabIds) {
            const el = this.querySelector(`#tab-${id}`);
            if (el) el.classList.toggle('hidden', id !== tab);
        }
    }

    renderWizardSection() {
        return `
        <section class="sp-section">
            <h2 class="sp-section-title">${this._t('sp.wizard.title')}</h2>
            <div class="sp-section-card">
            <div class="sp-toggle-row">
                <div class="sp-toggle-info">
                    <div class="sp-toggle-label">${this._t('sp.wizard.rerun')}</div>
                    <div class="sp-toggle-desc">${this._t('sp.wizard.rerun.desc')}</div>
                </div>
                <button class="sp-btn sp-btn-secondary" id="run-wizard-btn">${this._t('sp.wizard.run')}</button>
            </div>
            </div>
        </section>
        `;
    }

    renderTaskSection() {
        const taskConfig = this.currentData?.task_config || {};
        const autoRetry = taskConfig.auto_retry !== false;
        const generateTaskname = taskConfig.generate_taskname !== false;
        const terminationCheck = taskConfig.termination_check !== false;
        const evidenceCardEnabled = taskConfig.evidence_card === true;

        return `
        <section class="sp-section">
            <h2 class="sp-section-title">${this._t('sp.task.title')}</h2>
            <div class="sp-section-card">
            <div class="sp-toggle-row">
                <div class="sp-toggle-info">
                    <div class="sp-toggle-label">${this._t('sp.task.autoRetry')}</div>
                    <div class="sp-toggle-desc">${this._t('sp.task.autoRetry.desc')}</div>
                </div>
                <label class="sp-toggle-switch">
                    <input id="task-auto-retry-toggle" type="checkbox" ${autoRetry ? 'checked' : ''}>
                    <span class="sp-toggle-track"></span>
                </label>
            </div>
            <div class="sp-toggle-row">
                <div class="sp-toggle-info">
                    <div class="sp-toggle-label">${this._t('sp.task.autoTaskname')}</div>
                    <div class="sp-toggle-desc">${this._t('sp.task.autoTaskname.desc')}</div>
                </div>
                <label class="sp-toggle-switch">
                    <input id="task-generate-taskname-toggle" type="checkbox" ${generateTaskname ? 'checked' : ''}>
                    <span class="sp-toggle-track"></span>
                </label>
            </div>
            <div class="sp-toggle-row">
                <div class="sp-toggle-info">
                    <div class="sp-toggle-label">${this._t('sp.task.terminationCheck')}</div>
                    <div class="sp-toggle-desc">${this._t('sp.task.terminationCheck.desc')}</div>
                </div>
                <label class="sp-toggle-switch">
                    <input id="task-termination-check-toggle" type="checkbox" ${terminationCheck ? 'checked' : ''}>
                    <span class="sp-toggle-track"></span>
                </label>
            </div>
            <div class="sp-toggle-row">
                <div class="sp-toggle-info">
                    <div class="sp-toggle-label">${this._t('sp.task.evidenceCard')}</div>
                    <div class="sp-toggle-desc">${this._t('sp.task.evidenceCard.desc')}</div>
                </div>
                <label class="sp-toggle-switch">
                    <input id="task-evidence-card-toggle" type="checkbox" ${evidenceCardEnabled ? 'checked' : ''}>
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
            {
                id: 'duckduckgo',
                name: 'DuckDuckGo',
                desc: this._t('sp.search.channel.duckduckgo.desc'),
                needsKey: false
            },
            { id: 'bing', name: 'Bing', desc: this._t('sp.search.channel.bing.desc'), needsKey: false },
            {
                id: 'baidu',
                name: this._t('sp.search.channel.baidu.name'),
                desc: this._t('sp.search.channel.baidu.desc'),
                needsKey: false
            },
            { id: 'tavily', name: 'Tavily', desc: this._t('sp.search.channel.tavily.desc'), needsKey: true },
            { id: 'brave', name: 'Brave', desc: this._t('sp.search.channel.brave.desc'), needsKey: true },
            {
                id: 'bocha',
                name: this._t('sp.search.channel.bocha.name'),
                desc: this._t('sp.search.channel.bocha.desc'),
                needsKey: true
            },
            { id: 'exa', name: 'Exa', desc: this._t('sp.search.channel.exa.desc'), needsKey: true }
        ];

        const webChannelCards = webChannels
            .map((ch) => {
                const apiKey = channels[ch.id]?.api_key || '';
                const hasKey = apiKey !== '';
                const isDefault = ch.id === defaultWeb;
                const canSelect = !ch.needsKey || hasKey;
                const statusColor = canSelect ? (isDefault ? 'text-emerald-600' : 'text-gray-400') : 'text-orange-400';
                const statusText = isDefault
                    ? this._t('sp.search.status.default')
                    : canSelect
                      ? this._t('sp.search.status.available')
                      : this._t('sp.search.status.needsKey');
                const borderColor = isDefault ? 'border-emerald-200/60' : '';
                const bgColor = isDefault ? 'bg-emerald-50/30' : '';

                return `
            <div class="sp-card" style="${isDefault ? 'border-color:var(--sp-color-primary);background:var(--sp-color-primary-bg)' : ''}">
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
                    <button class="search-set-default-btn sp-btn sp-btn-sm sp-btn-secondary" data-channel="${ch.id}" data-type="web">${this._t('sp.search.setDefault')}</button>
                    `
                            : ''
                    }
                </div>
                ${
                    ch.needsKey
                        ? `
                <div style="margin-top:12px;display:flex;align-items:center;gap:8px">
                    <input type="password" class="search-api-key-input sp-form-input" style="flex:1;padding:6px 10px;font-size:13px" value="${this.escapeHtml(apiKey)}" placeholder="API Key" data-channel="${ch.id}">
                    <button class="search-set-key-btn sp-btn sp-btn-sm sp-btn-primary" data-channel="${ch.id}">${this._t('sp.search.save')}</button>
                </div>
                `
                        : ''
                }
                ${
                    ch.id === 'bing'
                        ? `
                <div style="margin-top:12px;display:flex;align-items:center;gap:8px">
                    <label style="font-size:13px;color:var(--sp-color-text-secondary);flex-shrink:0">${this._t('sp.search.region')}</label>
                    <select class="bing-lang-select sp-form-input" style="flex:1;padding:6px 10px;font-size:13px">
                        <option value="zh" ${bingLang === 'zh' ? 'selected' : ''}>${this._t('sp.search.region.cn')}</option>
                        <option value="en" ${bingLang === 'en' ? 'selected' : ''}>${this._t('sp.search.region.global')}</option>
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
            { id: 'arxiv', name: 'arXiv', desc: this._t('sp.search.channel.arxiv.desc') },
            { id: 'dblp', name: 'DBLP', desc: this._t('sp.search.channel.dblp.desc') }
        ];
        const academicChannelCards = academicChannels
            .map((ch) => {
                const isDefault = ch.id === defaultAcademic;
                return `
            <div class="sp-card" style="${isDefault ? 'border-color:var(--sp-color-primary);background:var(--sp-color-primary-bg)' : ''}">
                <div class="flex items-start justify-between">
                    <div>
                        <div class="flex items-center gap-2">
                            <h3 style="font-size:14px;font-weight:600;color:var(--sp-color-text)">${ch.name}</h3>
                            <span class="sp-tag ${isDefault ? 'sp-tag-success' : 'sp-tag-neutral'}">${isDefault ? this._t('sp.search.status.default') : this._t('sp.search.status.available')}</span>
                        </div>
                        <p style="font-size:13px;color:var(--sp-color-text-secondary);margin-top:2px">${ch.desc}</p>
                    </div>
                    ${
                        !isDefault
                            ? `
                    <button class="search-set-default-btn sp-btn sp-btn-sm sp-btn-secondary" data-channel="${ch.id}" data-type="academic">${this._t('sp.search.setDefault')}</button>
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
                <h2 class="sp-section-title" style="margin-bottom:0">${this._t('sp.search.webTitle')}</h2>
                <span class="sp-section-subtitle">${this._t('sp.search.webSubtitle')}</span>
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
                    ${this._t('sp.search.webHint')}
                </p>
            </div>
            ${!webSearchEnabled ? `<p class="sp-form-hint" style="margin-top:12px;display:flex;align-items:center;gap:4px"><i class="fas fa-info-circle"></i>${this._t('sp.search.webDisabled')}</p>` : ''}
        </section>

        <!-- 学术搜索引擎 -->
        <section class="sp-section">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
                <h2 class="sp-section-title" style="margin-bottom:0">${this._t('sp.search.academicTitle')}</h2>
                <span class="sp-section-subtitle">${this._t('sp.search.academicSubtitle')}</span>
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
            ${!academicSearchEnabled ? `<p class="sp-form-hint" style="margin-top:12px;display:flex;align-items:center;gap:4px"><i class="fas fa-info-circle"></i>${this._t('sp.search.academicDisabled')}</p>` : ''}
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
                      { value: 'none', label: this._t('sp.gateway.host.none') },
                      { value: '127.0.0.1', label: this._t('sp.gateway.host.localhost') },
                      { value: '0.0.0.0', label: this._t('sp.gateway.host.all') }
                  ];

        if (!options.some((option) => option.value === currentHost)) {
            options.push({ value: currentHost, label: this._t('sp.gateway.host.custom', { host: currentHost }) });
        }
        return options;
    }

    renderGatewaySection() {
        const config = this._getGatewayConfig();
        const hostOptions = this._getGatewayHostOptions(config.host);
        const statusText = config.enabled ? `${config.host}:${config.port}` : this._t('sp.gateway.disabled');
        const statusClass = config.enabled ? 'bg-emerald-100/70 text-emerald-700' : 'bg-gray-100 text-gray-500';

        return `
        <section class="sp-section">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:20px">
                <h2 class="sp-section-title" style="margin-bottom:0">${this._t('sp.gateway.title')}</h2>
                <span class="sp-tag ${config.enabled ? 'sp-tag-success' : 'sp-tag-neutral'}">${this.escapeHtml(statusText)}</span>
            </div>
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px">
                <div class="sp-form-group" style="margin-bottom:0">
                    <label class="sp-form-label">${this._t('sp.gateway.host')}</label>
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
                    <label class="sp-form-label">${this._t('sp.gateway.port')}</label>
                    <input id="gateway-port-input" type="number" min="1" max="65535" step="1" value="${config.port}" ${config.enabled ? '' : 'disabled'} class="sp-form-input" style="${config.enabled ? '' : 'opacity:0.5'}">
                </div>
                <div class="sp-form-group" style="margin-bottom:0;display:flex;align-items:flex-end">
                    <label style="display:flex;align-items:center;gap:8px;font-size:14px;color:var(--sp-color-text);${config.enabled ? '' : 'opacity:0.5'}">
                        <input id="gateway-auto-approve-input" type="checkbox" ${config.autoApproveLocal ? 'checked' : ''} ${config.enabled ? '' : 'disabled'} style="width:16px;height:16px;accent-color:var(--sp-color-primary)">
                        ${this._t('sp.gateway.autoApprove')}
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
        const guiReasonDisplay = this.currentData?.gui_config?.gui_reason_display || 'inline';
        const networkConfig = this.currentData?.network_config || {};
        const noSsl = networkConfig.no_ssl !== false;
        const useProxy = networkConfig.use_proxy || 'none';
        const customProxyAddr = networkConfig.custom_proxy_addr || '';
        const noProxy = networkConfig.no_proxy || '';
        const scaleSteps = [0.75, 0.9, 1, 1.25, 1.5];
        const scaleLabels = {
            'zh-CN': [
                this._t('sp.general.scale.tiny'),
                this._t('sp.general.scale.small'),
                this._t('sp.general.scale.standard'),
                this._t('sp.general.scale.large'),
                this._t('sp.general.scale.xlarge')
            ],
            'en-US': [
                this._t('sp.general.scale.tiny'),
                this._t('sp.general.scale.small'),
                this._t('sp.general.scale.standard'),
                this._t('sp.general.scale.large'),
                this._t('sp.general.scale.xlarge')
            ],
            auto: [
                this._t('sp.general.scale.tiny'),
                this._t('sp.general.scale.small'),
                this._t('sp.general.scale.standard'),
                this._t('sp.general.scale.large'),
                this._t('sp.general.scale.xlarge')
            ]
        };
        const labels = scaleLabels[currentLocale] || scaleLabels['auto'];
        const currentStepIndex = scaleSteps.indexOf(scaleFactor);
        const activeStep = currentStepIndex >= 0 ? currentStepIndex : 2;

        // Locale-aware string picker: zh side when not explicitly en-US
        const isEn = (this.currentData?.resolved_locale || currentLocale) === 'en-US';

        // 环境变量
        const environ = this.currentData?.environ || {};
        const environEntries = Object.entries(environ);

        const renderEnvironList = () => {
            const items = environEntries
                .map(
                    (entry, i) => `
                <div class="environ-item flex items-center gap-2 mb-2" data-index="${i}">
                    <input type="text" class="environ-key sp-form-input" value="${this.escapeHtml(entry[0])}" placeholder="${this._t('sp.environ.keyPlaceholder')}">
                    <span class="text-gray-400 text-xs">=</span>
                    <input type="text" class="environ-value sp-form-input" value="${this.escapeHtml(entry[1])}" placeholder="${this._t('sp.environ.valuePlaceholder')}">
                    <button class="remove-environ-btn sp-card-action-btn sp-delete-btn" data-index="${i}">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            `
                )
                .join('');
            return items || `<p class="text-xs text-gray-400 italic">${this._t('sp.environ.empty')}</p>`;
        };

        return `
        <section class="sp-section">
            <h2 class="sp-section-title">${this._t('sp.general.display')}</h2>
            <div class="sp-section-card">
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px">
                <div class="sp-form-group" style="margin-bottom:0">
                    <label class="sp-form-label">${this._t('sp.general.language')}</label>
                    <select id="locale-select" class="sp-form-input">
                        <option value="auto"${currentLocale === 'auto' ? ' selected' : ''}>${this._t('sp.general.language.system')}</option>
                        <option value="zh-CN"${currentLocale === 'zh-CN' ? ' selected' : ''}>中文</option>
                        <option value="en-US"${currentLocale === 'en-US' ? ' selected' : ''}>English</option>
                    </select>
                </div>
                <div class="sp-form-group" style="margin-bottom:0">
                    <label class="sp-form-label">${this._t('sp.general.font')}</label>
                    <select id="font-preset-select" class="sp-form-input">
                        <option value="default"${fontPreset === 'default' ? ' selected' : ''}>${this._t('sp.general.font.default')}</option>
                        <option value="lxgwwenkai"${fontPreset === 'lxgwwenkai' ? ' selected' : ''}>${this._t('sp.general.font.lxgw')}</option>
                    </select>
                </div>
                <div class="sp-form-group" style="margin-bottom:0">
                    <label class="sp-form-label">${this._t('sp.general.theme')}</label>
                    <select id="theme-preference-select" class="sp-form-input">
                        <option value="system"${themePreference === 'system' ? ' selected' : ''}>${this._t('sp.general.theme.system')}</option>
                        <option value="light"${themePreference === 'light' ? ' selected' : ''}>${this._t('sp.general.theme.light')}</option>
                        <option value="dark"${themePreference === 'dark' ? ' selected' : ''}>${this._t('sp.general.theme.dark')}</option>
                    </select>
                </div>
                <div class="sp-form-group" style="margin-bottom:0">
                    <label class="sp-form-label">${this._t('sp.general.reasoningDisplay')}</label>
                    <select id="gui-reason-display-select" class="sp-form-input">
                        <option value="inline"${guiReasonDisplay === 'inline' ? ' selected' : ''}>${this._t('sp.general.reasoningDisplay.inline')}</option>
                        <option value="bubble"${guiReasonDisplay === 'bubble' ? ' selected' : ''}>${this._t('sp.general.reasoningDisplay.bubble')}</option>
                    </select>
                </div>
            </div>
            <hr class="sp-section-divider">
            <div class="sp-form-group" style="margin-bottom:0">
                <label class="sp-form-label">${this._t('sp.general.displaySize')}</label>
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
                                <button class="scale-step-btn" style="width:12px;height:12px;border-radius:50%;border:2px solid ${i <= activeStep ? 'var(--sp-color-primary)' : 'var(--sp-color-border)'};background:${i <= activeStep ? 'var(--sp-color-primary)' : 'var(--sp-color-bg)'};cursor:pointer;transition:all 0.15s;padding:0;${i === activeStep ? 'box-shadow:0 0 0 3px rgba(223,68,54,0.15);' : ''}" data-step="${i}" data-value="${step}"></button>
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

        <section class="sp-section">
            <h2 class="sp-section-title">${this._t('sp.network.title')}</h2>
            <div class="sp-section-card">
            <div class="sp-toggle-row">
                <div class="sp-toggle-info">
                    <div class="sp-toggle-label">${this._t('sp.network.noSsl')}</div>
                    <div class="sp-toggle-desc">${this._t('sp.network.noSsl.desc')}</div>
                </div>
                <label class="sp-toggle-switch">
                    <input id="network-no-ssl-toggle" type="checkbox" ${noSsl ? 'checked' : ''}>
                    <span class="sp-toggle-track"></span>
                </label>
            </div>
            <div style="display:grid;grid-template-columns:120px 1fr;align-items:center;gap:16px;padding:12px 0;border-bottom:1px solid var(--sp-color-border-light)">
                <label style="font-size:13px;color:var(--sp-color-text-secondary)">${this._t('sp.network.proxy')}</label>
                <select id="network-use-proxy-select" class="sp-form-input" style="margin:0">
                    <option value="none"${useProxy === 'none' ? ' selected' : ''}>${this._t('sp.network.proxy.none')}</option>
                    <option value="system"${useProxy === 'system' ? ' selected' : ''}>${this._t('sp.network.proxy.system')}</option>
                    <option value="custom"${useProxy === 'custom' ? ' selected' : ''}>${this._t('sp.network.proxy.custom')}</option>
                </select>
            </div>
            <div id="network-custom-proxy-group" style="display:grid;grid-template-columns:120px 1fr;align-items:center;gap:16px;padding:12px 0;border-bottom:1px solid var(--sp-color-border-light);${useProxy === 'custom' ? '' : 'display:none;'}">
                <label style="font-size:13px;color:var(--sp-color-text-secondary)">${this._t('sp.network.proxyAddr')}</label>
                <input id="network-custom-proxy-addr-input" type="text" class="sp-form-input" value="${this.escapeHtml(customProxyAddr)}" placeholder="http://proxy.example.com:8080" style="margin:0">
            </div>
            <div id="network-no-proxy-group" style="display:grid;grid-template-columns:120px 1fr;align-items:start;gap:16px;padding:12px 0;${useProxy === 'custom' ? '' : 'display:none;'}">
                <label style="font-size:13px;color:var(--sp-color-text-secondary);padding-top:8px">${this._t('sp.network.noProxy')}</label>
                <div>
                    <input id="network-no-proxy-input" type="text" class="sp-form-input" value="${this.escapeHtml(noProxy)}" placeholder="localhost,127.0.0.1,.local" style="margin:0">
                    <p style="font-size:12px;color:var(--sp-color-text-tertiary);margin-top:4px">${this._t('sp.network.noProxy.hint')}</p>
                </div>
            </div>
            </div>
        </section>

        ${this.renderGatewaySection()}

        <section class="sp-section">
            <h2 class="sp-section-title">${this._t('sp.environ.title')}<span class="sp-section-subtitle">${this._t('sp.environ.subtitle')}</span></h2>
            <div class="sp-section-card">
            <div id="environ-list" style="margin-bottom:12px">
                ${renderEnvironList()}
            </div>
            <button id="add-environ-btn" class="sp-add-btn">
                <i class="fas fa-plus" style="margin-right:8px"></i>${this._t('sp.environ.add')}
            </button>
            <p style="font-size:13px;color:var(--sp-color-text-secondary);margin-top:8px">${this._t('sp.environ.hint')}</p>
            </div>
        </section>

        ${this.renderConfigManagementSection()}

        ${this.renderDebugModeSection()}

        ${this.renderTelemetrySection()}
        `;
    }

    renderConfigManagementSection() {
        return `
        <section class="sp-section">
            <h2 class="sp-section-title">${this._t('renderer.settings.configManagement')}</h2>
            <p class="sp-section-desc">${this._t('sp.configManagement.desc')}</p>
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

    renderTelemetrySection() {
        const endpoints = this.getTelemetryEndpointEntries();

        return `
        <section id="telemetry-section" class="sp-section">
            <h2 class="sp-section-title">${this._t('renderer.settings.telemetry')}</h2>
            <div class="sp-section-card">
                <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px">
                    <div>
                        <h3 style="font-size:15px;font-weight:600;color:var(--sp-color-text)">${this._t('config.telemetry.endpoints')}</h3>
                        <p style="font-size:12px;color:var(--sp-color-text-secondary);margin-top:3px">${this._t('config.telemetry.title.hint')}</p>
                    </div>
                    <span class="sp-tag sp-tag-teal">${this._t('renderer.settings.telemetryEndpointCount', { count: endpoints.length })}</span>
                </div>
                <div id="telemetry-list" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px">
                    ${endpoints.map((entry) => this.renderTelemetryCard(entry)).join('')}
                </div>
                <button id="telemetry-add-btn" class="sp-add-btn" style="margin-top:16px">
                    <i class="fas fa-plus" style="margin-right:8px"></i>${this._t('renderer.settings.telemetryAddEndpoint')}
                </button>
            </div>
        </section>
        `;
    }

    getTelemetryEndpointEntries() {
        const openTelemetryEndpoints = this.currentData?.telemetry?.opentelemetry?.endpoints;
        const langfuseEndpoints = this.currentData?.telemetry?.langfuse?.endpoints;
        return [
            ...(Array.isArray(openTelemetryEndpoints)
                ? openTelemetryEndpoints.map((endpoint, index) => ({
                      protocol: 'opentelemetry',
                      index,
                      endpoint
                  }))
                : []),
            ...(Array.isArray(langfuseEndpoints)
                ? langfuseEndpoints.map((endpoint, index) => ({
                      protocol: 'langfuse',
                      index,
                      endpoint
                  }))
                : [])
        ];
    }

    renderTelemetryCard({ endpoint, protocol, index }) {
        const enabled = !!endpoint.enabled;
        const url = protocol === 'langfuse' ? endpoint.base_url || 'https://cloud.langfuse.com' : endpoint.url || '';
        const name = endpoint.name || '';
        const protocolLabel = protocol === 'opentelemetry' ? 'OpenTelemetry' : 'Langfuse';
        const displayName = name || url || this._t('renderer.settings.telemetryEndpointUnset');

        return `
        <div class="sp-card" data-telemetry-protocol="${protocol}" data-telemetry-index="${index}">
            <div class="flex items-start justify-between">
                <div class="flex-1 min-w-0">
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                        <h3 style="font-size:14px;font-weight:600;color:var(--sp-color-text);word-break:break-all">${this.escapeHtml(displayName)}</h3>
                        <span class="sp-tag sp-tag-teal">${this.escapeHtml(protocolLabel)}</span>
                        <span class="sp-tag ${enabled ? 'sp-tag-success' : 'sp-tag-neutral'}">${this._t(enabled ? 'config.telemetry.status.enabled' : 'config.telemetry.status.disabled')}</span>
                    </div>
                    <p style="font-size:13px;color:var(--sp-color-text-secondary);margin-top:4px;font-family:var(--sp-font-mono,'Maple Mono','Cascadia Code','Fira Code','JetBrains Mono','Consolas','Monaco',monospace)">${this.escapeHtml(url || 'http://localhost:4318/v1/traces')}</p>
                </div>
                <div class="sp-card-actions">
                    <button class="edit-telemetry-btn sp-card-action-btn" data-protocol="${protocol}" data-index="${index}" title="${this._t('renderer.settings.telemetryEdit')}">
                        <i class="fas fa-pen" style="font-size:12px"></i>
                    </button>
                    <button class="delete-telemetry-btn sp-card-action-btn sp-delete-btn" data-protocol="${protocol}" data-index="${index}" title="${this._t('renderer.settings.telemetryDeleteEndpoint')}">
                        <i class="fas fa-trash" style="font-size:12px"></i>
                    </button>
                </div>
            </div>
        </div>
        `;
    }

    getLangfuseConfig() {
        return {
            endpoints: [],
            environment: 'development',
            max_payload_chars: 20000,
            ...(this.currentData?.telemetry?.langfuse || {})
        };
    }

    showTelemetryEditModal(index, initialProtocol = 'opentelemetry') {
        const isEdit = index >= 0;
        const protocol = initialProtocol === 'langfuse' ? 'langfuse' : 'opentelemetry';
        const langfuseConfig = this.getLangfuseConfig();
        const endpoint =
            (isEdit
                ? protocol === 'langfuse'
                    ? langfuseConfig.endpoints?.[index]
                    : this.currentData?.telemetry?.opentelemetry?.endpoints?.[index]
                : undefined) ||
            (protocol === 'langfuse'
                ? {
                      name: '',
                      protocol: 'langfuse',
                      enabled: true,
                      base_url: '',
                      public_key: '',
                      secret_key: '',
                      export_mode: 'batched',
                      flush_at: 50,
                      flush_interval_seconds: 5
                  }
                : { name: '', url: '', protocol: 'opentelemetry', enabled: true });

        this._editingTelemetryIndex = index;
        this._editingTelemetryProtocol = protocol;

        this.showModal(`
            <div class="bg-white/95 backdrop-blur-2xl rounded-3xl shadow-2xl border border-white/50 w-full min-w-[480px] max-w-xl mx-4 overflow-hidden">
                <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                    <h3 class="text-base font-semibold text-gray-800">${isEdit ? this._t('config.telemetry.edit') : this._t('config.telemetry.add_title')}</h3>
                    <button class="modal-close-btn sp-modal-close w-8 h-8 rounded-lg text-gray-400">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="px-6 py-5 space-y-4">
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1.5">${this._t('config.telemetry.field.name')}</label>
                        <input id="telemetry-name-input" type="text" value="${this.escapeHtml(endpoint.name)}" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all" placeholder="${this._t('config.telemetry.field.name')}">
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1.5">${this._t('config.telemetry.protocol')}</label>
                        <select id="telemetry-protocol-input" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all">
                            <option value="opentelemetry" ${protocol === 'opentelemetry' ? 'selected' : ''}>OpenTelemetry (OTLP)</option>
                            <option value="langfuse" ${protocol === 'langfuse' ? 'selected' : ''}>Langfuse</option>
                        </select>
                    </div>
                    <div id="telemetry-opentelemetry-fields">
                        <label class="block text-xs font-medium text-gray-600 mb-1.5">${this._t('config.telemetry.endpoint')}</label>
                        <input id="telemetry-url-input" type="text" value="${this.escapeHtml(endpoint.url || '')}" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all font-mono" placeholder="${this._t('renderer.settings.telemetryEndpointPlaceholder')}">
                    </div>
                    <div id="telemetry-langfuse-fields" class="space-y-4">
                        <div>
                            <label class="block text-xs font-medium text-gray-600 mb-1.5">${this._t('config.telemetry.langfuse.field.base_url')}</label>
                            <input id="telemetry-langfuse-base-url-input" type="text" value="${this.escapeHtml(endpoint.base_url || '')}" class="w-full px-4 py-2.5 text-sm bg-white/60 border border-gray-200/60 rounded-xl font-mono" placeholder="https://cloud.langfuse.com">
                        </div>
                        <div>
                            <label class="block text-xs font-medium text-gray-600 mb-1.5">${this._t('config.telemetry.langfuse.field.public_key')}</label>
                            <input id="telemetry-langfuse-public-key-input" type="text" value="${this.escapeHtml(endpoint.public_key || '')}" class="w-full px-4 py-2.5 text-sm bg-white/60 border border-gray-200/60 rounded-xl font-mono" placeholder="pk-lf-...">
                        </div>
                        <div>
                            <label class="block text-xs font-medium text-gray-600 mb-1.5">${this._t('config.telemetry.langfuse.field.secret_key')}</label>
                            <input id="telemetry-langfuse-secret-key-input" type="password" value="${this.escapeHtml(endpoint.secret_key || '')}" class="w-full px-4 py-2.5 text-sm bg-white/60 border border-gray-200/60 rounded-xl font-mono" placeholder="sk-lf-...">
                        </div>
                        <div>
                            <label class="block text-xs font-medium text-gray-600 mb-1.5">${this._t('config.telemetry.langfuse.field.environment')}</label>
                            <input id="telemetry-langfuse-environment-input" type="text" value="${this.escapeHtml(langfuseConfig.environment)}" class="w-full px-4 py-2.5 text-sm bg-white/60 border border-gray-200/60 rounded-xl" placeholder="development">
                        </div>
                        <div>
                            <label class="block text-xs font-medium text-gray-600 mb-1.5">${this._t('config.telemetry.langfuse.field.export_mode')}</label>
                            <select id="telemetry-langfuse-export-mode-input" class="w-full px-4 py-2.5 text-sm bg-white/60 border border-gray-200/60 rounded-xl">
                                <option value="batched" ${endpoint.export_mode !== 'immediate' ? 'selected' : ''}>${this._t('config.telemetry.langfuse.option.export_mode.batched')}</option>
                                <option value="immediate" ${endpoint.export_mode === 'immediate' ? 'selected' : ''}>${this._t('config.telemetry.langfuse.option.export_mode.immediate')}</option>
                            </select>
                        </div>
                        <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px">
                            <div>
                                <label class="block text-xs font-medium text-gray-600 mb-1.5">${this._t('config.telemetry.langfuse.field.max_payload_chars')}</label>
                                <input id="telemetry-langfuse-max-payload-chars-input" type="number" min="1" step="1" value="${this.escapeHtml(langfuseConfig.max_payload_chars)}" class="w-full px-3 py-2.5 text-sm bg-white/60 border border-gray-200/60 rounded-xl">
                            </div>
                            <div>
                                <label class="block text-xs font-medium text-gray-600 mb-1.5">${this._t('config.telemetry.langfuse.field.flush_at')}</label>
                                <input id="telemetry-langfuse-flush-at-input" type="number" min="1" step="1" value="${this.escapeHtml(endpoint.flush_at || 50)}" class="w-full px-3 py-2.5 text-sm bg-white/60 border border-gray-200/60 rounded-xl">
                            </div>
                            <div>
                                <label class="block text-xs font-medium text-gray-600 mb-1.5">${this._t('config.telemetry.langfuse.field.flush_interval_seconds')}</label>
                                <input id="telemetry-langfuse-flush-interval-input" type="number" min="1" step="1" value="${this.escapeHtml(endpoint.flush_interval_seconds || 5)}" class="w-full px-3 py-2.5 text-sm bg-white/60 border border-gray-200/60 rounded-xl">
                            </div>
                        </div>
                    </div>
                    <div class="flex items-center gap-2">
                        <input id="telemetry-enabled-input" type="checkbox" ${endpoint.enabled ? 'checked' : ''} class="w-4 h-4 rounded border-gray-300 text-blue-500 focus:ring-blue-400/30">
                        <label for="telemetry-enabled-input" class="text-sm text-gray-600">${this._t('config.telemetry.field.enabled')}</label>
                    </div>
                </div>
                <div class="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
                    <button id="telemetry-modal-cancel" class="px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded-xl hover:bg-gray-200 transition-colors">${this._t('renderer.settings.telemetryCancelAdd')}</button>
                    <button id="telemetry-modal-save" class="px-4 py-2 text-sm text-white bg-gradient-to-r from-blue-500 to-blue-600 rounded-xl hover:from-blue-600 hover:to-blue-700 transition-all">${this._t('renderer.settings.telemetryConfirmAdd')}</button>
                </div>
            </div>
        `);

        // 绑定事件
        this.querySelector('.modal-close-btn')?.addEventListener('click', () => this.closeModal());
        this.querySelector('#telemetry-modal-cancel')?.addEventListener('click', () => this.closeModal());
        this.querySelector('#telemetry-modal-save')?.addEventListener('click', () => this.saveTelemetryEndpoint());
        this.querySelector('#telemetry-protocol-input')?.addEventListener('change', () =>
            this.updateTelemetryProtocolFields()
        );
        this.querySelector('#telemetry-url-input')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.isComposing) {
                e.preventDefault();
                this.saveTelemetryEndpoint();
            }
        });
        this.updateTelemetryProtocolFields();
    }

    updateTelemetryProtocolFields() {
        const protocol = this.querySelector('#telemetry-protocol-input')?.value;
        const openTelemetryFields = this.querySelector('#telemetry-opentelemetry-fields');
        const langfuseFields = this.querySelector('#telemetry-langfuse-fields');
        if (openTelemetryFields) openTelemetryFields.style.display = protocol === 'langfuse' ? 'none' : '';
        if (langfuseFields) langfuseFields.style.display = protocol === 'langfuse' ? '' : 'none';
    }

    saveTelemetryEndpoint() {
        const name = this.querySelector('#telemetry-name-input')?.value?.trim() || '';
        const protocol =
            this.querySelector('#telemetry-protocol-input')?.value === 'langfuse' ? 'langfuse' : 'opentelemetry';
        const enabled = this.querySelector('#telemetry-enabled-input')?.checked ?? true;
        const index = this._editingTelemetryIndex;
        const previousProtocol = this._editingTelemetryProtocol;

        if (!this.currentData.telemetry) this.currentData.telemetry = {};
        if (!this.currentData.telemetry.opentelemetry) {
            this.currentData.telemetry.opentelemetry = { endpoints: [] };
        }
        if (!Array.isArray(this.currentData.telemetry.opentelemetry.endpoints)) {
            this.currentData.telemetry.opentelemetry.endpoints = [];
        }
        const langfuseConfig = this.getLangfuseConfig();
        if (!Array.isArray(langfuseConfig.endpoints)) langfuseConfig.endpoints = [];
        this.currentData.telemetry.langfuse = langfuseConfig;

        let endpoint;
        if (protocol === 'opentelemetry') {
            const url = this.querySelector('#telemetry-url-input')?.value?.trim();
            if (!url) {
                window.notificationAPI.sendNotification(
                    'error',
                    this._t('renderer.settings.telemetry'),
                    this._t('config.telemetry.validation.endpoint_required')
                );
                return;
            }
            endpoint = { name, url, protocol, enabled };
        } else {
            const positiveInteger = (selector) => {
                const value = Number(this.querySelector(selector)?.value);
                return Number.isInteger(value) && value > 0 ? value : undefined;
            };
            const maxPayloadChars = positiveInteger('#telemetry-langfuse-max-payload-chars-input');
            const flushAt = positiveInteger('#telemetry-langfuse-flush-at-input');
            const flushIntervalSeconds = positiveInteger('#telemetry-langfuse-flush-interval-input');
            const publicKey = this.querySelector('#telemetry-langfuse-public-key-input')?.value || '';
            const secretKey = this.querySelector('#telemetry-langfuse-secret-key-input')?.value || '';
            if (!maxPayloadChars || !flushAt || !flushIntervalSeconds) {
                window.notificationAPI.sendNotification(
                    'error',
                    this._t('renderer.settings.telemetry'),
                    this._t('config.telemetry.langfuse.validation.positive_integer')
                );
                return;
            }
            if (enabled && (!publicKey.trim() || !secretKey.trim())) {
                window.notificationAPI.sendNotification(
                    'error',
                    this._t('renderer.settings.telemetry'),
                    this._t('config.telemetry.langfuse.validation.keys_required')
                );
                return;
            }
            endpoint = {
                name,
                protocol,
                enabled,
                base_url: this.querySelector('#telemetry-langfuse-base-url-input')?.value?.trim() || '',
                public_key: publicKey,
                secret_key: secretKey,
                export_mode:
                    this.querySelector('#telemetry-langfuse-export-mode-input')?.value === 'immediate'
                        ? 'immediate'
                        : 'batched',
                flush_at: flushAt,
                flush_interval_seconds: flushIntervalSeconds
            };
            langfuseConfig.environment =
                this.querySelector('#telemetry-langfuse-environment-input')?.value?.trim() || 'development';
            langfuseConfig.max_payload_chars = maxPayloadChars;
        }

        const previousEndpoints =
            previousProtocol === 'langfuse'
                ? langfuseConfig.endpoints
                : this.currentData.telemetry.opentelemetry.endpoints;
        const nextEndpoints =
            protocol === 'langfuse' ? langfuseConfig.endpoints : this.currentData.telemetry.opentelemetry.endpoints;
        if (index >= 0 && previousProtocol === protocol && index < nextEndpoints.length) {
            nextEndpoints[index] = endpoint;
        } else {
            if (index >= 0 && index < previousEndpoints.length) {
                previousEndpoints.splice(index, 1);
            }
            nextEndpoints.push(endpoint);
        }

        this.closeModal();
        this.saveImmediately();
        this.refreshTelemetrySection();
    }

    deleteTelemetryEndpoint(protocol, index) {
        if (!this.currentData.telemetry) this.currentData.telemetry = {};
        const endpoints =
            protocol === 'langfuse'
                ? this.currentData.telemetry.langfuse?.endpoints
                : this.currentData.telemetry.opentelemetry?.endpoints;
        if (Array.isArray(endpoints) && index >= 0 && index < endpoints.length) {
            endpoints.splice(index, 1);
            this.saveImmediately();
            this.refreshTelemetrySection();
        }
    }

    escapeHtml(str) {
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    _bindTelemetryEvents() {
        // 添加端点按钮
        this.querySelector('#telemetry-add-btn')?.addEventListener('click', () => {
            this.showTelemetryEditModal(-1, 'opentelemetry');
        });

        // 编辑端点
        this.querySelectorAll('.edit-telemetry-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                const index = parseInt(e.currentTarget.dataset.index);
                this.showTelemetryEditModal(index, e.currentTarget.dataset.protocol);
            });
        });

        // 删除端点
        this.querySelectorAll('.delete-telemetry-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                const index = parseInt(e.currentTarget.dataset.index);
                this.deleteTelemetryEndpoint(e.currentTarget.dataset.protocol, index);
            });
        });
    }

    refreshTelemetrySection() {
        const telemetrySection = this.querySelector('#telemetry-section');
        if (!telemetrySection) return;
        const next = telemetrySection.nextElementSibling;
        const parent = telemetrySection.parentElement;
        if (!parent) return;
        telemetrySection.remove();
        const html = this.renderTelemetrySection();
        if (next) {
            next.insertAdjacentHTML('beforebegin', html);
        } else {
            parent.insertAdjacentHTML('beforeend', html);
        }
        this._bindTelemetryEvents();
    }

    renderProvidersSection() {
        const providers = this.currentData?.providers || [];
        return `
        <section class="sp-section">
            <h2 class="sp-section-title">${this._t('sp.providers.title')}<span class="sp-section-subtitle">${this._t('sp.providers.configured', { count: providers.length })}</span></h2>
            <div id="provider-list" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px">
                ${providers.map((p, i) => this.renderProviderCard(p, i)).join('')}
            </div>
            <button id="add-provider-btn" class="sp-add-btn" style="margin-top:16px">
                <i class="fas fa-plus" style="margin-right:8px"></i>${this._t('sp.providers.add')}
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
                    ${provider.no_proxy ? `<span class="sp-tag sp-tag-amber" style="margin-top:4px">${this._t('sp.providers.tag.noProxy')}</span>` : ''}
                    ${provider.no_ssl ? `<span class="sp-tag sp-tag-red" style="margin-top:4px">${this._t('sp.providers.tag.noSsl')}</span>` : ''}
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
        const maxOutLabel =
            modelType === 'chat' && model.max_output_tokens && model.max_output_tokens > 0
                ? model.max_output_tokens >= 1000
                    ? `${Math.round(model.max_output_tokens / 1000)}k`
                    : String(model.max_output_tokens)
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
                        ${maxOutLabel ? `<span class="sp-tag sp-tag-blue">${maxOutLabel} out</span>` : ''}
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

    async refreshVisionSupport() {
        try {
            this.visionSupportMap = await window.settingAPI.checkVisionSupport(this.getModelsByType('chat'));
        } catch (error) {
            console.warn('Failed to load model vision capabilities:', error);
            this.visionSupportMap = {};
        }
    }

    getVisionModels() {
        return this.getModelsByType('chat').filter((model) => this.visionSupportMap[model.alias] === true);
    }

    renderDefaultModelsSection() {
        const chatModelOptions = this.renderModelOptions(this.getModelsByType('chat'));
        const embeddingModelOptions = this.renderModelOptions(this.getModelsByType('embedding'));
        const visionModelOptions = this.renderModelOptions(this.getVisionModels());

        return `
        <section class="sp-section">
            <h2 class="sp-section-title">${this._t('sp.defaultModels.title')}</h2>
            <p class="sp-section-desc">${this._t('sp.defaultModels.desc')}</p>
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
                        ${visionModelOptions}
                    </select>
                </div>

            </div>
        </section>
        `;
    }

    setUpEventListeners() {
        // Tab 切换
        this.querySelectorAll('.sp-nav-item[data-tab]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const newTab = btn.dataset.tab;
                if (newTab === this._activeTab) return;
                this._switchTab(newTab);
            });
        });

        // 设置向导：运行向导按钮
        this.querySelector('#run-wizard-btn')?.addEventListener('click', () => {
            window.globalControlAPI.openWizard();
        });

        // 隐私协议
        this.querySelector('#privacy-link')?.addEventListener('click', () => {
            const url =
                'https://agreement-drcn.hispace.dbankcloud.cn/index.html?lang=zh&agreementId=1990542080371379008';
            window.globalControlAPI.openApplication('browser');
            const doNavigate = () => {
                const browserWidget = document.querySelector('#nonAppSlot > browser-entry-widget');
                if (browserWidget && typeof browserWidget.navigateTo === 'function') {
                    browserWidget.navigateTo(url);
                } else {
                    setTimeout(doNavigate, 100);
                }
            };
            setTimeout(doNavigate, 300);
        });

        this.querySelector('#task-auto-retry-toggle')?.addEventListener('change', (e) => {
            if (!this.currentData.task_config) this.currentData.task_config = {};
            this.currentData.task_config.auto_retry = e.target.checked;
            this.saveImmediately();
        });

        this.querySelector('#task-generate-taskname-toggle')?.addEventListener('change', (e) => {
            if (!this.currentData.task_config) this.currentData.task_config = {};
            this.currentData.task_config.generate_taskname = e.target.checked;
            this.saveImmediately();
        });

        this.querySelector('#task-termination-check-toggle')?.addEventListener('change', (e) => {
            if (!this.currentData.task_config) this.currentData.task_config = {};
            this.currentData.task_config.termination_check = e.target.checked;
            this.saveImmediately();
        });

        this.querySelector('#task-evidence-card-toggle')?.addEventListener('change', (e) => {
            if (!this.currentData.task_config) this.currentData.task_config = {};
            this.currentData.task_config.evidence_card = e.target.checked;
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
            'default-vision-model-select'
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
            this.refreshAll();
            void this.saveImmediately().then(() => {
                this._t = createRendererTranslator(this.currentData);
                this.refreshAll();
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

        // 思考内容显示模式
        this.querySelector('#gui-reason-display-select')?.addEventListener('change', (e) => {
            if (!this.currentData.gui_config) this.currentData.gui_config = {};
            this.currentData.gui_config.gui_reason_display = e.target.value;
            this.saveImmediately();
        });

        this.querySelector('#debug-mode-toggle-hidden')?.addEventListener('change', (e) => {
            if (!this.currentData.debug) this.currentData.debug = {};
            this.currentData.debug.developer_mode = e.target.checked;
            this.saveImmediately();
        });

        this.querySelector('#experimental-feature-toggle-hidden')?.addEventListener('change', async (e) => {
            if (this._suppressExperimentalToggle) return;
            if (e.target.checked) {
                const confirmed = await showConfirmModal({
                    icon: 'fa-triangle-exclamation',
                    iconBg: '#FFFBEB',
                    iconColor: '#D97706',
                    title: this._t('sp.experimental.title'),
                    message: this._t('sp.experimental.message'),
                    confirmText: this._t('sp.experimental.confirm'),
                    cancelText: this._t('sp.experimental.cancel')
                });
                if (!confirmed) {
                    this._suppressExperimentalToggle = true;
                    e.target.checked = false;
                    this._suppressExperimentalToggle = false;
                    return;
                }
            }
            if (!this.currentData.debug) this.currentData.debug = {};
            this.currentData.debug.experimental_feature = e.target.checked;
            this.saveImmediately();
        });

        this.querySelector('#log-raw-llm-toggle-hidden')?.addEventListener('change', (e) => {
            if (!this.currentData.debug) this.currentData.debug = {};
            this.currentData.debug.log_raw_llm_request = e.target.checked;
            this.saveImmediately();
        });

        this._bindTelemetryEvents();

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

        // 网络设置
        this._bindNetworkEvents();

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
            'default-vision-model-select': 'default_vision_model'
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
            window.notificationAPI.sendNotification(
                'error',
                this._t('sp.title'),
                this._t('sp.save.failed'),
                error.message
            );
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
            this.refreshAll();
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
                    <h3 class="text-base font-semibold text-gray-800">${this._t('sp.providers.template.title')}</h3>
                    <button class="modal-close-btn sp-modal-close w-8 h-8 rounded-lg text-gray-400">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="px-6 py-5">
                    <div class="grid grid-cols-2 md:grid-cols-3 gap-3 max-h-[400px] overflow-y-auto">
                        ${templateCards}
                        <button class="provider-custom-btn sp-template-custom-btn flex flex-col items-center justify-center p-4 rounded-xl border border-dashed border-gray-300">
                            <i class="fas fa-plus text-gray-400 mb-1"></i>
                            <span class="text-sm text-gray-500">${this._t('sp.providers.template.custom')}</span>
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
                    <h3 class="text-base font-semibold text-gray-800">${isEdit ? this._t('sp.providers.edit.title.edit') : this._t('sp.providers.edit.title.add')}</h3>
                    <button class="modal-close-btn sp-modal-close w-8 h-8 rounded-lg text-gray-400">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="px-6 py-5 space-y-4">
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1.5">${this._t('sp.providers.field.name')}</label>
                        <input id="provider-name-input" type="text" value="${this.escapeHtml(provider.name)}" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all" placeholder="${this._t('sp.providers.field.name.placeholder')}">
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1.5">${this._t('sp.providers.field.type')}</label>
                        <select id="provider-type-input" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all">
                            <option value="openai" ${providerType === 'openai' ? 'selected' : ''}>OpenAI</option>
                            <option value="anthropic" ${providerType === 'anthropic' ? 'selected' : ''}>Anthropic</option>
                        </select>
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1.5">${this._t('sp.providers.field.url')}</label>
                        <input id="provider-url-input" type="text" value="${this.escapeHtml(provider.base_url)}" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all" placeholder="https://api.example.com/v1">
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1.5">${this._t('sp.providers.field.key')}</label>
                        <div class="relative">
                            <input id="provider-key-input" type="password" value="${this.escapeHtml(provider.api_key)}" class="w-full px-4 py-2.5 pr-10 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all" placeholder="sk-...">
                            <button id="toggle-key-visibility" class="sp-toggle-key absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">
                                <i class="fas fa-eye text-xs"></i>
                            </button>
                        </div>
                    </div>
                    <div class="flex items-center gap-2">
                        <input id="provider-no-proxy-input" type="checkbox" ${provider.no_proxy ? 'checked' : ''} class="w-4 h-4 rounded border-gray-300 text-blue-500 focus:ring-blue-400/30">
                        <label for="provider-no-proxy-input" class="text-sm text-gray-600">${this._t('sp.providers.field.noProxy')}</label>
                    </div>
                    <div class="flex items-center gap-2">
                        <input id="provider-no-ssl-input" type="checkbox" ${provider.no_ssl ? 'checked' : ''} class="w-4 h-4 rounded border-gray-300 text-blue-500 focus:ring-blue-400/30">
                        <label for="provider-no-ssl-input" class="text-sm text-gray-600">${this._t('sp.providers.field.noSsl')}</label>
                    </div>
                </div>
                <div class="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
                    <button class="modal-close-btn sp-modal-cancel px-4 py-2 text-sm text-gray-600 rounded-xl">${this._t('sp.providers.cancel')}</button>
                    <button id="save-provider-btn" class="sp-modal-save px-4 py-2 text-sm text-white bg-gradient-to-r from-blue-500 to-blue-600 rounded-xl">${isEdit ? this._t('sp.providers.save') : this._t('sp.providers.addBtn')}</button>
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
            window.notificationAPI.sendNotification('error', this._t('sp.title'), this._t('sp.providers.nameRequired'));
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
                ? this._t('sp.providers.delete.confirmWithModels', { name: provider.name, count: modelCount })
                : this._t('sp.providers.delete.confirm', { name: provider.name });

        this.showModal(`
            <div class="bg-white/95 backdrop-blur-2xl rounded-3xl shadow-2xl border border-white/50 w-full max-w-md mx-4 overflow-hidden">
                <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                    <h3 class="text-base font-semibold text-gray-800">${this._t('sp.providers.delete.title')}</h3>
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
                    <button class="modal-close-btn sp-modal-cancel px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded-xl">${this._t('sp.providers.delete.cancel')}</button>
                    <button id="confirm-delete-provider-btn" class="sp-confirm-delete px-4 py-2 text-sm text-white bg-red-500 rounded-xl">${this._t('sp.providers.delete.confirmBtn')}</button>
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
                  max_output_tokens: undefined,
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
	                        <label class="block text-xs font-medium text-gray-600 mb-1.5">${this.escapeHtml(this._t('config.model.field.max_output_tokens'))}</label>
	                        <input id="model-max-output-tokens-input" type="number" min="0" step="1" value="${model.max_output_tokens || ''}" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all" placeholder="${this.escapeHtml(this._t('config.model.field.max_output_tokens.placeholder'))}">
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
	                            <i class="fas fa-plus mr-2"></i>${this.escapeHtml(this._t('config.model.header.add_title'))}
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

        // 模型名变化时，实时估算上下文大小并更新 placeholder
        let _estimateTimer = null;
        const contextLengthInput = this.querySelector('#model-context-length-input');
        const updateContextPlaceholder = async (modelName) => {
            if (!contextLengthInput) return;
            const trimmed = (modelName || '').trim();
            if (!trimmed) {
                contextLengthInput.placeholder = this._t('config.model.field.context_length.placeholder');
                return;
            }
            try {
                const size = await window.settingAPI.estimateContextSize(trimmed);
                if (size > 0) {
                    const k = Math.round(size / 1000);
                    contextLengthInput.placeholder = this._t('sp.model.contextPlaceholder', { k });
                } else {
                    contextLengthInput.placeholder = this._t('sp.model.contextFallback');
                }
            } catch {
                contextLengthInput.placeholder = this._t('config.model.field.context_length.placeholder');
            }
        };

        // 模型名变化时，实时估算最大补全长度并更新 placeholder
        const maxOutputTokensInput = this.querySelector('#model-max-output-tokens-input');
        const updateMaxOutputTokensPlaceholder = async (modelName) => {
            if (!maxOutputTokensInput) return;
            const trimmed = (modelName || '').trim();
            if (!trimmed) {
                maxOutputTokensInput.placeholder = this._t('config.model.field.max_output_tokens.placeholder');
                return;
            }
            try {
                const tokens = await window.settingAPI.estimateMaxOutputTokens(trimmed);
                if (tokens > 0) {
                    const k = Math.round(tokens / 1000);
                    maxOutputTokensInput.placeholder = this._t('sp.model.maxOutputPlaceholder', { k });
                } else {
                    maxOutputTokensInput.placeholder = this._t('sp.model.maxOutputFallback');
                }
            } catch {
                maxOutputTokensInput.placeholder = this._t('config.model.field.max_output_tokens.placeholder');
            }
        };
        nameInput?.addEventListener('input', () => {
            clearTimeout(_estimateTimer);
            _estimateTimer = setTimeout(() => {
                updateContextPlaceholder(nameInput.value);
                updateMaxOutputTokensPlaceholder(nameInput.value);
            }, 250);
        });
        // 初始加载时立即估算
        if (nameInput?.value?.trim()) {
            updateContextPlaceholder(nameInput.value);
            updateMaxOutputTokensPlaceholder(nameInput.value);
        }

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
                    updateContextPlaceholder(nameInput.value);
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

        // 提前检查别名是否重复，避免验证通过后才发现无法保存
        const existingIdx = this.currentData.models?.findIndex((m) => m.alias === alias);
        if (existingIdx !== undefined && existingIdx !== -1 && existingIdx !== this._editingModelIndex) {
            await showConfirmModal({
                icon: 'fa-circle-exclamation',
                iconBg: '#FEF2F2',
                iconColor: '#DC2626',
                title: this._t('config.model.validation.alias_exists'),
                message: this._t('config.model.validation.alias_exists'),
                confirmText: this._t('common.confirm'),
                cancelText: null
            });
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
            await this.saveModel();
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

    async saveModel() {
        const alias = this.querySelector('#model-alias-input')?.value?.trim();
        const provider_name = this.querySelector('#model-provider-input')?.value || '';
        const model_name = this.querySelector('#model-name-input')?.value?.trim();
        const model_type = this.normalizeModelType(this.querySelector('#model-type-input')?.value || 'chat');
        const reasoning_effort = this.querySelector('#model-effort-input')?.value || '';
        const contextLengthRaw = this.querySelector('#model-context-length-input')?.value?.trim();
        const contextLengthNum = contextLengthRaw ? parseInt(contextLengthRaw, 10) : undefined;
        const maxOutputTokensRaw = this.querySelector('#model-max-output-tokens-input')?.value?.trim();
        const maxOutputTokensNum = maxOutputTokensRaw ? Number(maxOutputTokensRaw) : undefined;
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

        if (
            maxOutputTokensRaw &&
            (!/^\d+$/.test(maxOutputTokensRaw) || !Number.isSafeInteger(maxOutputTokensNum) || maxOutputTokensNum < 0)
        ) {
            window.notificationAPI.sendNotification(
                'error',
                this._t('config.main.title'),
                this._t('config.model.validation.max_output_tokens_invalid')
            );
            return;
        }

        // 检查别名是否重复
        const existingIndex = this.currentData.models?.findIndex((m) => m.alias === alias);
        if (existingIndex !== undefined && existingIndex !== -1 && existingIndex !== this._editingModelIndex) {
            await showConfirmModal({
                icon: 'fa-circle-exclamation',
                iconBg: '#FEF2F2',
                iconColor: '#DC2626',
                title: this._t('config.model.validation.alias_exists'),
                message: this._t('config.model.validation.alias_exists'),
                confirmText: this._t('common.confirm'),
                cancelText: null
            });
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
        if (model_type === 'chat' && maxOutputTokensNum && maxOutputTokensNum > 0) {
            model.max_output_tokens = maxOutputTokensNum;
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
        await this.refreshVisionSupport();
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
            'default_vision_model'
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

    refreshAll() {
        this._hasRendered = false;
        this.render();
        this.setUpEventListeners();
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
                this.refreshAll();
                void this.saveImmediately().then(() => {
                    this._t = createRendererTranslator(this.currentData);
                    this.refreshAll();
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

            this.querySelector('#experimental-feature-toggle-hidden')?.addEventListener('change', async (e) => {
                if (this._suppressExperimentalToggle) return;
                if (e.target.checked) {
                    const confirmed = await showConfirmModal({
                        icon: 'fa-triangle-exclamation',
                        iconBg: '#FFFBEB',
                        iconColor: '#D97706',
                        title: this._t('sp.experimental.title'),
                        message: this._t('sp.experimental.message'),
                        confirmText: this._t('sp.experimental.confirm'),
                        cancelText: this._t('sp.experimental.cancel')
                    });
                    if (!confirmed) {
                        this._suppressExperimentalToggle = true;
                        e.target.checked = false;
                        this._suppressExperimentalToggle = false;
                        return;
                    }
                }
                if (!this.currentData.debug) this.currentData.debug = {};
                this.currentData.debug.experimental_feature = e.target.checked;
                this.saveImmediately();
            });

            this.querySelector('#log-raw-llm-toggle-hidden')?.addEventListener('change', (e) => {
                if (!this.currentData.debug) this.currentData.debug = {};
                this.currentData.debug.log_raw_llm_request = e.target.checked;
                this.saveImmediately();
            });

            this._bindTelemetryEvents();

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
            this._bindNetworkEvents();
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
                'default-vision-model-select'
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
                    <h3 class="text-base font-semibold text-gray-800">${this._t('sp.quickpass.export.title')}</h3>
                    <button class="modal-close-btn sp-modal-close w-8 h-8 rounded-lg text-gray-400">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="px-6 py-5 space-y-4">
                    <div class="flex gap-3">
                        <button id="export-base-btn" class="sp-export-option-btn sp-export-base flex-1 py-3 text-sm text-gray-700 bg-white border border-gray-200 rounded-xl">
                            <i class="fas fa-cog mr-2 text-blue-500"></i>${this._t('sp.quickpass.export.base')}
                        </button>
                        <button id="export-all-btn" class="sp-export-option-btn sp-export-all flex-1 py-3 text-sm text-gray-700 bg-white border border-gray-200 rounded-xl">
                            <i class="fas fa-box mr-2 text-purple-500"></i>${this._t('sp.quickpass.export.all')}
                        </button>
                    </div>
                    <textarea id="export-result" readonly class="w-full h-32 px-4 py-3 text-xs font-mono bg-gray-50 border border-gray-200 rounded-xl resize-none focus:outline-none" placeholder="${this._t('sp.quickpass.export.placeholder')}"></textarea>
                    <button id="copy-quickpass-btn" class="sp-modal-save w-full py-2.5 text-sm text-white bg-gradient-to-r from-gray-700 to-gray-600 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed" disabled>
                        <i class="fas fa-copy mr-2"></i>${this._t('sp.quickpass.export.copy')}
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
                window.notificationAPI.sendNotification(
                    'error',
                    this._t('sp.title'),
                    this._t('sp.quickpass.export.failed'),
                    error.message
                );
            }
        });
        this.querySelector('#export-all-btn')?.addEventListener('click', async () => {
            try {
                const quickpass = await window.quickpassAPI.exportAllConfig();
                this.querySelector('#export-result').value = quickpass;
                this.querySelector('#copy-quickpass-btn').disabled = false;
            } catch (error) {
                window.notificationAPI.sendNotification(
                    'error',
                    this._t('sp.title'),
                    this._t('sp.quickpass.export.failed'),
                    error.message
                );
            }
        });
        this.querySelector('#copy-quickpass-btn')?.addEventListener('click', async () => {
            const text = this.querySelector('#export-result')?.value;
            if (text) {
                await navigator.clipboard.writeText(text);
                window.notificationAPI.sendNotification(
                    'info',
                    this._t('sp.title'),
                    this._t('sp.quickpass.export.success'),
                    this._t('sp.quickpass.export.copied')
                );
            }
        });
    }

    showImportQuickPassModal() {
        this.showModal(`
            <div class="bg-white/95 backdrop-blur-2xl rounded-3xl shadow-2xl border border-white/50 w-full min-w-[480px] max-w-lg mx-4 overflow-hidden">
                <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                    <h3 class="text-base font-semibold text-gray-800">${this._t('sp.quickpass.import.title')}</h3>
                    <button class="modal-close-btn sp-modal-close w-8 h-8 rounded-lg text-gray-400">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="px-6 py-5 space-y-4">
                    <textarea id="import-input" class="w-full h-32 px-4 py-3 text-xs font-mono bg-white/60 border border-gray-200/60 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all" placeholder="${this._t('sp.quickpass.import.placeholder')}"></textarea>
                    <div id="import-result" class="text-sm"></div>
                    <button id="import-quickpass-confirm-btn" class="sp-modal-save w-full py-2.5 text-sm text-white bg-gradient-to-r from-blue-500 to-blue-600 rounded-xl">
                        <i class="fas fa-check mr-2"></i>${this._t('sp.quickpass.import.btn')}
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
                window.notificationAPI.sendNotification(
                    'error',
                    this._t('sp.title'),
                    this._t('sp.quickpass.import.empty')
                );
                return;
            }

            const resultDiv = this.querySelector('#import-result');
            resultDiv.innerHTML =
                '<span class="text-gray-500"><i class="fas fa-spinner fa-spin mr-2"></i>' +
                this._t('sp.quickpass.import.importing') +
                '</span>';

            try {
                const result = await window.quickpassAPI.importQuickPass(quickpass);
                const hasApps = result.hasApplications;
                resultDiv.innerHTML = `<span class="text-green-500"><i class="fas fa-check-circle mr-2"></i>${this._t('sp.quickpass.import.success', { name: this.escapeHtml(result.name) })}${hasApps ? this._t('sp.quickpass.import.success.apps') : this._t('sp.quickpass.import.success.base')}</span>`;

                // 刷新数据
                await this.loadData();
                this.refreshAll();
            } catch (error) {
                resultDiv.innerHTML = `<span class="text-red-500"><i class="fas fa-times-circle mr-2"></i>${this._t('sp.quickpass.import.failed', { message: this.escapeHtml(error.message) })}</span>`;
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
                window.notificationAPI.sendNotification(
                    'error',
                    this._t('sp.title'),
                    this._t('sp.gateway.portInvalid')
                );
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
                        <input type="text" class="environ-key sp-form-input" value="${this.escapeHtml(entry.key)}" placeholder="${this._t('sp.environ.keyPlaceholder')}">
                        <span class="text-gray-400 text-xs">=</span>
                        <input type="text" class="environ-value sp-form-input" value="${this.escapeHtml(entry.value)}" placeholder="${this._t('sp.environ.valuePlaceholder')}">
                        <button class="remove-environ-btn sp-card-action-btn sp-delete-btn" data-index="${i}">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                `
                    )
                    .join('');
                container.innerHTML =
                    items || `<p class="text-xs text-gray-400 italic">${this._t('sp.environ.empty')}</p>`;
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

    _bindNetworkEvents() {
        // 跳过 SSL 证书校验
        this.querySelector('#network-no-ssl-toggle')?.addEventListener('change', (e) => {
            if (!this.currentData.network_config) this.currentData.network_config = {};
            this.currentData.network_config.no_ssl = e.target.checked;
            this.saveImmediately();
        });

        // 使用代理
        this.querySelector('#network-use-proxy-select')?.addEventListener('change', (e) => {
            if (!this.currentData.network_config) this.currentData.network_config = {};
            this.currentData.network_config.use_proxy = e.target.value;
            // 切换自定义代理地址和 no_proxy 输入框的显示
            const isCustom = e.target.value === 'custom';
            const customGroup = this.querySelector('#network-custom-proxy-group');
            if (customGroup) {
                customGroup.style.display = isCustom ? 'grid' : 'none';
            }
            const noProxyGroup = this.querySelector('#network-no-proxy-group');
            if (noProxyGroup) {
                noProxyGroup.style.display = isCustom ? 'grid' : 'none';
            }
            this.saveImmediately();
        });

        // 自定义代理地址
        this.querySelector('#network-custom-proxy-addr-input')?.addEventListener('change', (e) => {
            if (!this.currentData.network_config) this.currentData.network_config = {};
            this.currentData.network_config.custom_proxy_addr = e.target.value;
            this.saveImmediately();
        });

        // 不代理的地址
        this.querySelector('#network-no-proxy-input')?.addEventListener('change', (e) => {
            if (!this.currentData.network_config) this.currentData.network_config = {};
            this.currentData.network_config.no_proxy = e.target.value;
            this.saveImmediately();
        });
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
        if (!key) return this._t('sp.provider.keyNotSet');
        if (key.length <= 8) return '****';
        return key.substring(0, 4) + '****' + key.substring(key.length - 4);
    }

    getEffortLabel(effort) {
        const labels = {
            none: this._t('sp.model.effort.none'),
            low: this._t('sp.model.effort.low'),
            medium: this._t('sp.model.effort.medium'),
            high: this._t('sp.model.effort.high')
        };
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
