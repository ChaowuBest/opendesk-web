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
import { escapeHtml } from '../../../../common/utils/escape.js';
import { isSupportedLocale } from '../../../../common/locale.js';
import { createRendererTranslator, resolveRendererLocale } from '../../../../renderer/locale.js';
import {
    resolvePluginDisplayName,
    resolvePluginLocalizedText,
    type PluginDisplayName,
    type PluginLocalizedText
} from '../../../../../packages/plugin-sdk/src/index.js';
import {
    getSkillInitial,
    getSkillPastel,
    type SkillDetailCard,
    type SkillDetailCardModel
} from '../../../../renderer/components/skills/skill-detail-card.ts';
import { renderSafeMarkdown } from '../../../../renderer/utils/markdown.js';
import { showConfirmModal } from '../../../../renderer/components/confirmModal.js';
import { OPENDESK_THEME_CHANGED } from '../../../../renderer/theme/theme-iframe-bridge.ts';
import { syncShadowHostTheme } from '../../../../renderer/theme/theme-shadow-overrides.ts';

interface PluginRuntimeEntry {
    id: string;
    displayName?: PluginDisplayName;
    description?: PluginLocalizedText;
    version?: string;
    status: 'active' | 'error' | 'disabled';
    origin: string;
    apiVersion: number;
    capabilities: string[];
    diagnostics: Array<{ stage: string; code: string; detail?: string }>;
}

interface PluginAgentInfo {
    name: string;
    whenToUse: string;
    dispatchable?: boolean;
    body: string;
}

interface PluginListEntry {
    id: string;
    source: 'builtin' | 'local' | 'external';
    path?: string;
    removable: boolean;
    enabled: boolean;
    installedAt?: string;
    spec?: string;
    verification?: {
        integrityStatus: string;
        allowed: boolean;
    };
    runtime?: PluginRuntimeEntry;
    manifest?: {
        displayName?: PluginDisplayName;
        description?: PluginLocalizedText;
        version?: string;
        apiVersion?: number;
        capabilities?: string[];
    };
    skills?: Array<{
        name: string;
        description: string;
        directory?: string;
        userInvocable?: boolean;
        modelInvocable?: boolean;
    }>;
    mcpServers?: Array<{
        name: string;
        transport: 'stdio' | 'sse' | 'streamableHttp';
        command?: string;
        cwd?: string;
        url?: string;
    }>;
    tools?: Array<{
        name: string;
        description: string;
    }>;
    hooks?: Array<{
        name: string;
    }>;
    browserHints?: Array<{
        urlPrefix: string;
    }>;
    agents?: PluginAgentInfo[];
}

type InstallDialogMode = 'npm' | 'url';
type ManagedInstallSource = InstallDialogMode | 'directory' | 'package';

interface InstallProgressState {
    source: ManagedInstallSource;
    spec: string;
}

interface PluginFileSystemAPI {
    getFilePath?: (file: File) => string | Promise<string>;
    selectDirectory?: () => Promise<string | null>;
}

const STYLE = `
${OVERLAY_CSS}
:host {
    display: block;
    height: 100%;
    overflow: hidden;
    color: #1d1d1f;
    background: #fff;
    font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
button, input { font: inherit; }
.shell { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.header-area {
    position: relative;
    z-index: 10;
    flex: none;
    padding: 20px 24px 16px;
    background: rgba(255, 255, 255, .88);
    backdrop-filter: blur(24px) saturate(180%);
    -webkit-backdrop-filter: blur(24px) saturate(180%);
    border-bottom: .5px solid rgba(0, 0, 0, .06);
}
.header-title { margin-bottom: 14px; font-size: 22px; font-weight: 700; letter-spacing: -.03em; }
.seg-row { display: flex; align-items: center; gap: 8px; }
.seg-control {
    display: inline-flex;
    flex: 1;
    min-width: 0;
    padding: 3px;
    gap: 2px;
    overflow-x: auto;
    background: rgba(0, 0, 0, .04);
    border-radius: 10px;
    scrollbar-width: none;
}
.seg-control::-webkit-scrollbar { display: none; }
.seg-item {
    display: inline-flex;
    align-items: center;
    flex: none;
    gap: 5px;
    padding: 7px 13px;
    color: rgba(0, 0, 0, .45);
    background: transparent;
    border: 0;
    border-radius: 8px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    transition: all .18s ease;
}
.seg-item.active {
    color: #1d1d1f;
    background: #fff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, .06), 0 .5px 1px rgba(0, 0, 0, .03);
}
.seg-icon { display: inline-flex; font-size: 13px; }
/* 块级显示消除 inline svg 的基线 descender 空隙，保证图标与文字垂直居中对齐 */
.seg-icon svg { display: block; }
.seg-badge {
    padding: 1px 7px;
    color: #5b8def;
    background: rgba(90, 140, 240, .12);
    border-radius: 10px;
    font-size: 10px;
    font-weight: 650;
}
.header-actions { display: flex; gap: 6px; flex: none; }
.action-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    padding: 0;
    color: #444;
    background: #fff;
    border: 1px solid rgba(0, 0, 0, .08);
    border-radius: 9px;
    cursor: pointer;
    font-size: 17px;
}
.action-btn:hover { background: #f8f8f8; }
.action-btn:disabled, button:disabled { cursor: default; opacity: .45; }
.add-dropdown-anchor { position: relative; }
.add-dropdown {
    display: none;
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 20;
    width: 270px;
    overflow: hidden;
    background: #fff;
    border: 1px solid rgba(0, 0, 0, .06);
    border-radius: 12px;
    box-shadow: 0 8px 32px -8px rgba(0, 0, 0, .14), 0 2px 8px -1px rgba(0, 0, 0, .04);
    animation: dropdown-in .16s ease-out;
}
.add-dropdown.visible { display: flex; flex-direction: column; }
@keyframes dropdown-in {
    from { opacity: 0; transform: translateY(-4px) scale(.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
}
.add-dropdown-section { padding: 3px; }
.add-dropdown-section + .add-dropdown-section { border-top: 1px solid rgba(0, 0, 0, .04); }
.add-dropdown-item {
    display: flex;
    width: 100%;
    padding: 8px 10px;
    align-items: center;
    gap: 10px;
    color: #1d1d1f;
    background: transparent;
    border: 0;
    border-radius: 8px;
    cursor: pointer;
    text-align: left;
}
.add-dropdown-item:hover { background: #f5f5f5; }
.add-dropdown-item .icon {
    display: flex;
    width: 30px;
    height: 30px;
    align-items: center;
    justify-content: center;
    flex: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 700;
    color: #1d1d1f;
    background: var(--od-bg);
}
.add-dropdown-item .icon svg { width: 16px; height: 16px; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.add-dropdown-item .icon .k { stroke: currentColor; }
.add-dropdown-item .icon .r { stroke: #de4433; }
.item-info { display: flex; min-width: 0; flex-direction: column; gap: 1px; }
.item-name { color: #1d1d1f; font-size: 13px; font-weight: 600; line-height: 1.3; }
.item-hint { color: #999da5; font-size: 11px; line-height: 1.35; }
.notice {
    flex: none;
    margin: 12px 24px 0;
    padding: 10px 12px;
    color: #285b9c;
    background: #edf4ff;
    border-radius: 9px;
}
.notice.error { color: #b0372c; background: #fff0ee; }
.content { flex: 1; min-height: 0; overflow: hidden; }
.tab-panel { height: 100%; overflow-y: auto; }
.installed-panel { min-height: 100%; padding: 20px 24px 60px; }
.modal-overlay {
    display: none;
    position: fixed;
    inset: 0;
    z-index: 30;
    align-items: center;
    justify-content: center;
    animation: fade-in .15s ease;
}
.modal-overlay.visible { display: flex; }
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
.modal-dialog {
    width: 480px;
    max-width: 90%;
    padding: 24px;
    overflow-y: auto;
    color: #1d1d1f;
    background: #fff;
    border-radius: 16px;
    box-shadow: 0 24px 80px -16px rgba(0, 0, 0, .2);
    animation: dialog-in .2s ease-out;
}
@keyframes dialog-in {
    from { opacity: 0; transform: scale(.95) translateY(8px); }
    to { opacity: 1; transform: scale(1) translateY(0); }
}
.modal-dialog h3 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
.modal-dialog .hint { margin-bottom: 14px; color: #888d96; font-size: 12px; }
.modal-dialog input {
    width: 100%;
    padding: 10px 12px;
    color: inherit;
    background: #fff;
    border: 1px solid rgba(0, 0, 0, .1);
    border-radius: 10px;
    outline: none;
}
.modal-dialog input:focus {
    border-color: #8bb8f0;
    box-shadow: 0 0 0 3px rgba(90, 140, 240, .1);
}
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.install-progress-overlay {
    position: fixed;
    inset: 0;
    z-index: 35;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgba(248, 249, 252, .84);
    backdrop-filter: blur(18px) saturate(150%);
    -webkit-backdrop-filter: blur(18px) saturate(150%);
    animation: fade-in .18s ease-out;
}
.install-progress-card {
    width: 420px;
    max-width: 100%;
    padding: 32px;
    text-align: center;
    background: rgba(255, 255, 255, .94);
    border: 1px solid rgba(0, 0, 0, .06);
    border-radius: 20px;
    box-shadow: 0 24px 80px -20px rgba(31, 48, 80, .24);
    animation: dialog-in .24s cubic-bezier(.23, 1, .32, 1);
}
.install-progress-icon {
    position: relative;
    display: grid;
    width: 64px;
    height: 64px;
    margin: 0 auto 20px;
    place-items: center;
    color: #5b8def;
    background: #edf4ff;
    border-radius: 18px;
    font-size: 26px;
    font-weight: 700;
}
.install-progress-icon::after {
    position: absolute;
    inset: -6px;
    border: 2px solid rgba(91, 141, 239, .22);
    border-top-color: #5b8def;
    border-radius: 22px;
    content: '';
    animation: install-spin 1.1s linear infinite;
}
.install-progress-title { color: #1d1d1f; font-size: 17px; font-weight: 700; }
.install-progress-description { margin-top: 8px; color: #74777f; font-size: 13px; line-height: 1.55; }
.install-progress-spec {
    margin-top: 14px;
    overflow: hidden;
    padding: 9px 12px;
    color: #555a64;
    background: #f6f7f9;
    border-radius: 9px;
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.install-progress-track {
    height: 3px;
    margin-top: 20px;
    overflow: hidden;
    background: #e8edf5;
    border-radius: 999px;
}
.install-progress-bar {
    width: 42%;
    height: 100%;
    background: linear-gradient(90deg, #5b8def, #8bb8f0);
    border-radius: inherit;
    animation: install-progress 1.25s ease-in-out infinite;
}
@keyframes install-spin { to { transform: rotate(360deg); } }
@keyframes install-progress {
    from { transform: translateX(-110%); }
    to { transform: translateX(340%); }
}
button {
    padding: 8px 13px;
    color: #303238;
    background: #fff;
    border: 1px solid #d9dce2;
    border-radius: 8px;
    cursor: pointer;
}
button:hover { background: #f4f5f7; }
.primary { flex: none; padding-inline: 18px; color: #fff; background: #6ba3ef; border-color: #6ba3ef; }
.primary:hover { background: #7db0f3; }
.danger { color: #c94d4d; }
.empty {
    margin: 0 auto;
    padding: 44px 24px;
    color: #74777f;
    background: linear-gradient(180deg, #fbfcfe, #f7f8fa);
    border: 1px dashed #d9dce2;
    border-radius: 14px;
    text-align: center;
}
.empty-icon { margin-bottom: 10px; font-size: 30px; }
.empty-title { color: #3b3e45; font-size: 15px; font-weight: 650; }
.empty-hint { margin-top: 6px; color: #8a8d95; font-size: 12px; line-height: 1.5; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)); gap: 12px; }
.card {
    display: flex;
    min-width: 0;
    padding: 16px 18px;
    flex-direction: column;
    gap: 10px;
    background: #fff;
    border: 1px solid rgba(0, 0, 0, .05);
    border-radius: 14px;
    box-shadow: 0 1px 2px rgba(0, 0, 0, .03);
    cursor: pointer;
    outline: none;
    transition: border-color .15s, box-shadow .15s, transform .15s;
}
.card:hover, .card:focus-visible {
    border-color: rgba(91, 141, 239, .28);
    box-shadow: 0 8px 24px rgba(0, 0, 0, .05);
    transform: translateY(-1px);
}
.card-head { display: flex; min-width: 0; align-items: flex-start; gap: 12px; }
.card-icon {
    display: flex;
    width: 40px;
    height: 40px;
    align-items: center;
    justify-content: center;
    flex: none;
    border-radius: 11px;
    font-size: 17px;
    font-weight: 700;
}
.card-info { min-width: 0; flex: 1; }
.name {
    overflow: hidden;
    color: #1d1d1f;
    font-size: 14px;
    font-weight: 650;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.plugin-id { margin-top: 2px; overflow: hidden; color: #999; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.meta, .diagnostic { color: #70737b; font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
.diagnostic { color: #b0372c; }
.contributions { display: flex; flex-wrap: wrap; gap: 6px; }
.contribution-pill { padding: 3px 9px; color: #5b8def; background: #ebf3fe; border-radius: 12px; font-size: 11px; font-weight: 550; }
.contribution-pill.mcp { color: #4a9b63; background: #e7f6ea; }
.contribution-pill.tool { color: #8b6fd6; background: #f1ecfb; }
.contribution-pill.hook { color: #c07a2d; background: #fdf3e7; }
.contribution-pill.agent { color: #2f7fbf; background: #e8f1fb; }
.contribution-pill.browser { color: #c05a8a; background: #fbeaf2; }
.card-footer { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 10px; margin-top: auto; padding-top: 2px; }
.card-footer button { padding: 5px 12px; border-radius: 14px; font-size: 12px; font-weight: 600; }
.builtin-tag {
    margin-right: auto;
    padding: 3px 9px;
    color: #8a6d1f;
    background: #fdf6e3;
    border: 1px solid rgba(196, 154, 42, .25);
    border-radius: 12px;
    font-size: 11px;
    font-weight: 550;
}
.card-footer .plugin-toggle { margin-left: auto; }
.plugin-toggle {
    position: relative;
    width: 40px;
    height: 24px;
    flex: none;
}
.plugin-toggle input {
    position: absolute;
    width: 0;
    height: 0;
    opacity: 0;
}
.plugin-toggle-slider {
    position: absolute;
    inset: 0;
    background: #d1d1d6;
    border-radius: 999px;
    cursor: pointer;
    transition: background .25s ease;
}
.plugin-toggle-slider::after {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 20px;
    height: 20px;
    background: #fff;
    border-radius: 50%;
    box-shadow: 0 1px 3px rgba(0, 0, 0, .15);
    content: '';
    transition: transform .25s ease;
}
.plugin-toggle input:checked + .plugin-toggle-slider { background: #34c759; }
.plugin-toggle input:checked + .plugin-toggle-slider::after { transform: translateX(16px); }
.plugin-toggle input:focus-visible + .plugin-toggle-slider { outline: 2px solid #5b8def; outline-offset: 2px; }
.plugin-toggle input:disabled + .plugin-toggle-slider { cursor: default; opacity: .45; }
:host([data-theme="dark"]) { color: #ddd; background: #1e1e1e; color-scheme: dark; }
:host([data-theme="dark"]) .header-area { background: rgba(37, 37, 38, .95); border-color: rgba(255, 255, 255, .1); }
:host([data-theme="dark"]) .seg-control { background: #333; }
/* 全局深色 button 背景会污染 seg-item，这里显式还原：非激活 tab 必须保持透明底、无边框 */
:host([data-theme="dark"]) .seg-item { color: rgba(255, 255, 255, .58); background: transparent; border: 0; }
:host([data-theme="dark"]) .seg-item.active { color: #fff; background: #252526; border: 0; box-shadow: none; }
:host([data-theme="dark"]) .action-btn, :host([data-theme="dark"]) button,
:host([data-theme="dark"]) .card, :host([data-theme="dark"]) .add-dropdown,
:host([data-theme="dark"]) .modal-dialog {
    color: #ddd;
    background: #252526;
    border-color: rgba(255, 255, 255, .12);
}
:host([data-theme="dark"]) button:hover, :host([data-theme="dark"]) .action-btn:hover { background: #303033; }
:host([data-theme="dark"]) .primary { color: #fff; background: #5b8def; border-color: #5b8def; }
:host([data-theme="dark"]) .modal-dialog input {
    color: #ddd;
    background: #252526;
    border-color: rgba(255, 255, 255, .14);
}
:host([data-theme="dark"]) .install-progress-overlay { background: rgba(24, 24, 25, .84); }
:host([data-theme="dark"]) .install-progress-card {
    background: rgba(37, 37, 38, .96);
    border-color: rgba(255, 255, 255, .1);
    box-shadow: 0 24px 80px -20px rgba(0, 0, 0, .6);
}
:host([data-theme="dark"]) .install-progress-title { color: #f3f3f3; }
:host([data-theme="dark"]) .install-progress-description { color: #a4a7ad; }
:host([data-theme="dark"]) .install-progress-spec { color: #c8cad0; background: #303033; }
:host([data-theme="dark"]) .install-progress-track { background: #3a3d44; }
:host([data-theme="dark"]) .add-dropdown-item { color: #ddd; }
:host([data-theme="dark"]) .add-dropdown-item .icon { color: #eceae6; background: var(--od-bg); }
:host([data-theme="dark"]) .add-dropdown-item .icon .r { stroke: #ff6b5a; }
:host([data-theme="dark"]) .add-dropdown-item:hover { background: rgba(255, 255, 255, .08); }
:host([data-theme="dark"]) .add-dropdown-section + .add-dropdown-section { border-top-color: rgba(255, 255, 255, .1); }
:host([data-theme="dark"]) .item-name { color: #e5e7eb; }
:host([data-theme="dark"]) .item-hint { color: #858990; }
:host([data-theme="dark"]) .contribution-pill.agent { color: #8bc2f2; background: rgba(47, 127, 191, .22); }
:host([data-theme="dark"]) .contribution-pill.browser { color: #efa6c6; background: rgba(192, 90, 138, .22); }
:host([data-theme="dark"]) .builtin-tag { color: #d9b96a; background: rgba(196, 154, 42, .14); border-color: rgba(196, 154, 42, .3); }
:host([data-theme="dark"]) .empty {
    color: #a4a7ad;
    background: #242426;
    border-color: rgba(255, 255, 255, .14);
}
:host([data-theme="dark"]) .empty-title { color: #ddd; }
:host([data-theme="dark"]) .name { color: #e5e7eb; }
:host([data-theme="dark"]) .meta, :host([data-theme="dark"]) .plugin-id,
:host([data-theme="dark"]) .modal-dialog .hint { color: #a4a7ad; }
@media (max-width: 700px) {
    .header-area, .installed-panel { padding-left: 16px; padding-right: 16px; }
}
`;

function getAPI() {
    return window.applicationAPI;
}

export class PluginMgrEntryWidget extends HTMLElement {
    private entries: PluginListEntry[] = [];
    private loading = true;
    private busy = false;
    private addMenuOpen = false;
    /** 当前展示的 tab：内置插件与用户已安装插件分组展示 */
    private activeTab: 'builtin' | 'installed' = 'installed';
    private installDialogMode?: InstallDialogMode;
    private installSpec = '';
    private installProgress?: InstallProgressState;
    private selectedPluginId?: string;
    private selectedAgentName?: string;
    private returningFromAgent = false;
    private notice?: { text: string; error: boolean };
    private t = createRendererTranslator();
    private locale = resolveRendererLocale();
    private readonly onPluginsChanged = () => void this.load();
    /** 主窗口在应用语言变化时向 iframe 广播 LOCALE_CHANGED，这里据此切换插件显示语言 */
    private readonly onLocaleMessage = (event: Event) => {
        const data = (event as MessageEvent).data;
        if (data?.type !== 'LOCALE_CHANGED') return;
        if (typeof data.locale === 'string') this.applyLocale(data.locale);
    };
    private readonly onThemeChanged = (event: Event) => {
        const theme = (event as CustomEvent).detail?.effective;
        syncShadowHostTheme(this, theme);
        const detail = this.shadowRoot?.querySelector<SkillDetailCard>('#plugin-detail-card');
        if (detail && theme) detail.dataset.theme = theme;
    };

    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
    }

    connectedCallback(): void {
        void this.initialize();
    }

    disconnectedCallback(): void {
        getAPI().unsubscribe('pluginsChanged', this.onPluginsChanged);
        window.removeEventListener('message', this.onLocaleMessage);
        document.removeEventListener(OPENDESK_THEME_CHANGED, this.onThemeChanged);
    }

    private applyLocale(locale: string): void {
        if (!isSupportedLocale(locale) || locale === this.locale) return;
        this.locale = locale;
        this.t = createRendererTranslator(locale);
        this.render();
    }

    /** 按当前界面语言解析插件显示名：运行时值优先，未声明时回退插件 ID */
    private pluginName(entry: PluginListEntry): string {
        return (
            resolvePluginDisplayName(entry.runtime?.displayName, this.locale) ??
            resolvePluginDisplayName(entry.manifest?.displayName, this.locale) ??
            entry.id
        );
    }

    /** 按当前界面语言解析插件描述：运行时值优先，未声明时回退 manifest，均无则返回 undefined */
    private pluginDescription(entry: PluginListEntry): string | undefined {
        return (
            resolvePluginLocalizedText(entry.runtime?.description, this.locale) ??
            resolvePluginLocalizedText(entry.manifest?.description, this.locale)
        );
    }

    private async initialize(): Promise<void> {
        try {
            const settings = await window.top?.settingAPI?.loadSettingObject?.();
            this.t = createRendererTranslator(settings);
            this.locale = resolveRendererLocale(settings);
        } catch {
            this.t = createRendererTranslator();
            this.locale = resolveRendererLocale();
        }
        window.addEventListener('message', this.onLocaleMessage);
        document.addEventListener(OPENDESK_THEME_CHANGED, this.onThemeChanged);
        getAPI().subscribe('pluginsChanged', this.onPluginsChanged);
        await this.load();
    }

    private async load(preserveNotice = false): Promise<void> {
        try {
            this.entries = (await getAPI().callMainWorld('list')) as PluginListEntry[];
            if (this.selectedPluginId && !this.entries.some((entry) => entry.id === this.selectedPluginId)) {
                this.selectedPluginId = undefined;
            }
            if (!preserveNotice) this.notice = undefined;
        } catch (error) {
            this.notice = { text: error instanceof Error ? error.message : String(error), error: true };
        } finally {
            this.loading = false;
            this.render();
        }
    }

    private async run(
        operation: () => Promise<unknown>,
        successKey: string,
        onSuccess?: () => void,
        preserveRenderedState = false
    ): Promise<void> {
        if (this.busy) return;
        this.busy = true;
        if (preserveRenderedState) {
            this.shadowRoot
                ?.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')
                .forEach((control) => {
                    control.disabled = true;
                });
        } else {
            this.render();
        }
        try {
            await operation();
            onSuccess?.();
            this.notice = { text: this.t(successKey), error: false };
            await this.load(true);
        } catch (error) {
            this.notice = { text: error instanceof Error ? error.message : String(error), error: true };
        } finally {
            this.busy = false;
            this.render();
        }
    }

    private openInstallDialog(mode: InstallDialogMode): void {
        this.addMenuOpen = false;
        this.installDialogMode = mode;
        this.installSpec = '';
        this.render();
        const focusInput = () => this.shadowRoot?.querySelector<HTMLInputElement>('input[name="spec"]')?.focus();
        if (typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(focusInput);
        } else {
            setTimeout(focusInput, 0);
        }
    }

    private closeInstallDialog(): void {
        if (this.busy) return;
        this.installDialogMode = undefined;
        this.installSpec = '';
        this.render();
    }

    private install(spec: string, successKey = 'plugin.install.success', source?: ManagedInstallSource): void {
        const normalizedSpec = spec.trim();
        if (!normalizedSpec) return;
        const startedAt = Date.now();
        if (source) {
            this.installProgress = { source, spec: normalizedSpec };
            this.installDialogMode = undefined;
            this.installSpec = '';
        }
        const operation = this.run(
            async () => {
                try {
                    return await getAPI().callMainWorld('install', normalizedSpec);
                } finally {
                    if (source) {
                        const remaining = Math.max(0, 450 - (Date.now() - startedAt));
                        if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
                    }
                }
            },
            successKey,
            () => {
                this.installDialogMode = undefined;
                this.installSpec = '';
            }
        );
        if (source) {
            void operation.finally(() => {
                this.installProgress = undefined;
                this.render();
            });
        }
    }

    private async installFromDirectory(): Promise<void> {
        this.addMenuOpen = false;
        this.render();
        const directory = await (window as unknown as { fsAPI?: PluginFileSystemAPI }).fsAPI?.selectDirectory?.();
        if (directory) this.install(directory, 'plugin.install.success', 'directory');
    }

    private async installFromFile(file?: File): Promise<void> {
        if (!file) return;
        try {
            const filePath = await (window as unknown as { fsAPI?: PluginFileSystemAPI }).fsAPI?.getFilePath?.(file);
            if (!filePath) {
                this.notice = { text: this.t('plugin.center.filePathUnavailable'), error: true };
                this.render();
                return;
            }
            this.addMenuOpen = false;
            this.install(filePath, 'plugin.install.success', 'package');
        } catch (error) {
            this.notice = { text: error instanceof Error ? error.message : String(error), error: true };
            this.render();
        }
    }

    private async confirmAndUninstall(id: string, onSuccess?: () => void): Promise<void> {
        const confirmed = await showConfirmModal({
            icon: 'fa-trash-can',
            iconBg: '#FEF2F2',
            iconColor: '#DC2626',
            title: this.t('plugin.center.uninstallTitle'),
            message: escapeHtml(this.t('plugin.center.uninstallConfirm', { id })),
            confirmText: this.t('plugin.center.uninstall'),
            cancelText: this.t('plugin.center.cancel'),
            danger: true,
            mountTarget: this.shadowRoot!
        });
        if (!confirmed) return;
        void this.run(() => getAPI().callMainWorld('uninstall', id), 'plugin.uninstall.success', onSuccess);
    }

    private statusOf(entry: PluginListEntry): string {
        if (!entry.enabled) return 'disabled';
        return entry.runtime?.status ?? 'disabled';
    }

    private renderCard(entry: PluginListEntry): string {
        const diagnostics = entry.runtime?.diagnostics ?? [];
        const name = this.pluginName(entry);
        const color = getSkillPastel(name);
        const contributionPills = [
            entry.skills?.length
                ? `<span class="contribution-pill">${escapeHtml(
                      this.t('plugin.center.skillCount', { count: entry.skills.length })
                  )}</span>`
                : '',
            entry.mcpServers?.length
                ? `<span class="contribution-pill mcp">${escapeHtml(
                      this.t('plugin.center.mcpCount', { count: entry.mcpServers.length })
                  )}</span>`
                : '',
            entry.tools?.length
                ? `<span class="contribution-pill tool">${escapeHtml(
                      this.t('plugin.center.toolCount', { count: entry.tools.length })
                  )}</span>`
                : '',
            entry.hooks?.length
                ? `<span class="contribution-pill hook">${escapeHtml(
                      this.t('plugin.center.hookCount', { count: entry.hooks.length })
                  )}</span>`
                : '',
            entry.agents?.length
                ? `<span class="contribution-pill agent">${escapeHtml(
                      this.t('plugin.center.agentCount', { count: entry.agents.length })
                  )}</span>`
                : '',
            entry.browserHints?.length
                ? `<span class="contribution-pill browser">${escapeHtml(
                      this.t('plugin.center.browserHintCount', { count: entry.browserHints.length })
                  )}</span>`
                : ''
        ].filter(Boolean);
        return `<article class="card" data-plugin-id="${escapeHtml(entry.id)}" role="button" tabindex="0">
            <div class="card-head">
                <div class="card-icon" style="background:${color.bg};color:${color.text}">${escapeHtml(getSkillInitial(name))}</div>
                <div class="card-info">
                    <div class="name">${escapeHtml(name)}</div>
                    <div class="plugin-id">${escapeHtml(entry.id)}</div>
                </div>
            </div>
            ${contributionPills.length ? `<div class="contributions">${contributionPills.join('')}</div>` : ''}
            ${diagnostics
                .map(
                    (item) =>
                        `<div class="diagnostic">${escapeHtml(`${item.stage}/${item.code}${item.detail ? `: ${item.detail}` : ''}`)}</div>`
                )
                .join('')}
            <div class="card-footer">
                ${entry.source === 'builtin' ? `<span class="builtin-tag">${escapeHtml(this.t('plugin.center.builtinTag'))}</span>` : ''}
                <label class="plugin-toggle" title="${escapeHtml(
                    this.t(entry.enabled ? 'plugin.center.disable' : 'plugin.center.enable')
                )}">
                    <input type="checkbox" data-action="toggle" data-id="${escapeHtml(entry.id)}"
                        aria-label="${escapeHtml(
                            this.t(entry.enabled ? 'plugin.center.disable' : 'plugin.center.enable')
                        )}"
                        ${entry.enabled ? 'checked' : ''} ${this.busy ? 'disabled' : ''}>
                    <span class="plugin-toggle-slider"></span>
                </label>
                ${
                    entry.removable
                        ? `<button class="danger" data-action="uninstall" data-id="${escapeHtml(entry.id)}" ${this.busy ? 'disabled' : ''}>${escapeHtml(this.t('plugin.center.uninstall'))}</button>`
                        : ''
                }
            </div>
        </article>`;
    }

    private renderContributionDetails(entry: PluginListEntry): string {
        const skills = entry.skills ?? [];
        const mcpServers = entry.mcpServers ?? [];
        const skillItems = skills.length
            ? skills
                  .map(
                      (skill) => `<div class="detail-tool-item">
                        <div class="detail-tool-name">${escapeHtml(skill.name)}</div>
                        <div class="detail-tool-desc">${escapeHtml(skill.description)}</div>
                    </div>`
                  )
                  .join('')
            : `<div class="detail-tool-no-params">${escapeHtml(this.t('plugin.center.detail.noSkills'))}</div>`;
        const mcpItems = mcpServers.length
            ? mcpServers
                  .map((server) => {
                      const endpoint = server.command || server.url;
                      return `<div class="detail-tool-item">
                        <div class="detail-tool-name">${escapeHtml(server.name)}</div>
                        <div class="detail-tool-desc">${escapeHtml(
                            this.t('plugin.center.detail.transport', { transport: server.transport })
                        )}${endpoint ? ` · ${escapeHtml(endpoint)}` : ''}</div>
                    </div>`;
                  })
                  .join('')
            : `<div class="detail-tool-no-params">${escapeHtml(this.t('plugin.center.detail.noMcps'))}</div>`;
        const tools = entry.tools ?? [];
        const hooks = entry.hooks ?? [];
        const toolItems = tools.length
            ? tools
                  .map(
                      (tool) => `<div class="detail-tool-item">
                        <div class="detail-tool-name">${escapeHtml(tool.name)}</div>
                        <div class="detail-tool-desc">${escapeHtml(tool.description)}</div>
                    </div>`
                  )
                  .join('')
            : `<div class="detail-tool-no-params">${escapeHtml(this.t('plugin.center.detail.noTools'))}</div>`;
        const hookItems = hooks.length
            ? hooks.map((hook) => `<span class="hook-pill">${escapeHtml(hook.name)}</span>`).join('')
            : `<div class="detail-tool-no-params">${escapeHtml(this.t('plugin.center.detail.noHooks'))}</div>`;
        const browserHints = entry.browserHints ?? [];
        const browserHintItems = browserHints.length
            ? browserHints.map((hint) => `<span class="hook-pill">${escapeHtml(hint.urlPrefix)}</span>`).join('')
            : `<div class="detail-tool-no-params">${escapeHtml(this.t('plugin.center.detail.noBrowserHints'))}</div>`;
        return `<section class="detail-section">
            <div class="detail-section-label">${escapeHtml(this.t('plugin.center.detail.skills'))}</div>
            <div class="detail-tools-list">${skillItems}</div>
        </section>
        <section class="detail-section">
            <div class="detail-section-label">${escapeHtml(this.t('plugin.center.detail.mcps'))}</div>
            <div class="detail-tools-list">${mcpItems}</div>
        </section>
        <section class="detail-section">
            <div class="detail-section-label">${escapeHtml(this.t('plugin.center.detail.tools'))}</div>
            <div class="detail-tools-list">${toolItems}</div>
        </section>
        <section class="detail-section">
            <div class="detail-section-label">${escapeHtml(this.t('plugin.center.detail.hooks'))}</div>
            <div class="hook-list">${hookItems}</div>
        </section>
        <section class="detail-section">
            <div class="detail-section-label">${escapeHtml(this.t('plugin.center.detail.browserHints'))}</div>
            <div class="hook-list">${browserHintItems}</div>
        </section>`;
    }

    private renderAgentsList(entry: PluginListEntry, name: string, status: string, capabilities: string[]): void {
        const agents = entry.agents ?? [];
        const agentItems = agents.length
            ? agents
                  .map((agent) => {
                      const pastel = getSkillPastel(agent.name);
                      return `<div class="agent-row" data-agent-name="${escapeHtml(agent.name)}" role="button" tabindex="0">
                        <div class="agent-avatar" style="background:${pastel.bg};color:${pastel.text}">${escapeHtml(
                            getSkillInitial(agent.name)
                        )}</div>
                        <div class="agent-row-info">
                            <div class="agent-row-name">${escapeHtml(agent.name)}</div>
                            <div class="agent-row-usage">${escapeHtml(agent.whenToUse)}</div>
                        </div>
                        ${
                            agent.dispatchable === false
                                ? `<span class="agent-flag">${escapeHtml(this.t('plugin.center.detail.agentNotDispatchable'))}</span>`
                                : ''
                        }
                        <svg class="agent-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
                    </div>`;
                  })
                  .join('')
            : `<div class="detail-tool-no-params">${escapeHtml(this.t('plugin.center.detail.noAgents'))}</div>`;
        const model: SkillDetailCardModel = {
            id: entry.id,
            name,
            description: this.pluginDescription(entry),
            descriptionLabel: this.t('plugin.center.detail.description'),
            closeLabel: this.t('plugin.center.detail.close'),
            transition: this.returningFromAgent ? 'back' : undefined,
            metadataLabel: this.t('plugin.center.detail.basicInfo'),
            metadata: [
                { label: this.t('plugin.center.detail.status'), value: this.t(`plugin.runtime.status.${status}`) },
                {
                    label: this.t('plugin.center.detail.version'),
                    value: entry.runtime?.version || entry.manifest?.version || '-'
                },
                {
                    label: this.t('plugin.center.detail.apiVersion'),
                    value: String(entry.runtime?.apiVersion ?? entry.manifest?.apiVersion ?? '-')
                },
                { label: this.t('plugin.center.source'), value: this.t(`plugin.center.source.${entry.source}`) },
                { label: this.t('plugin.center.detail.path'), value: entry.path || entry.runtime?.origin || '-' },
                { label: this.t('plugin.settings.capabilities'), value: capabilities.join(', ') || '-' }
            ],
            extraSectionsHtml: agentItems
                ? `<section class="detail-section">
                    <div class="detail-section-label">${escapeHtml(this.t('plugin.center.detail.agents'))}</div>
                    <div class="agent-list">${agentItems}</div>
                </section>${this.renderContributionDetails(entry)}`
                : this.renderContributionDetails(entry),
            actions: [
                {
                    id: 'toggle',
                    label: this.t(entry.enabled ? 'plugin.center.disable' : 'plugin.center.enable'),
                    variant: entry.enabled ? 'default' : 'primary'
                },
                ...(entry.removable
                    ? [
                          {
                              id: 'uninstall',
                              label: this.t('plugin.center.uninstall'),
                              variant: 'danger' as const
                          }
                      ]
                    : [])
            ]
        };
        const detail = this.shadowRoot?.querySelector<SkillDetailCard>('#plugin-detail-card');
        if (detail) {
            detail.model = model;
            // 返回动画只应作用于这一次渲染
            this.returningFromAgent = false;
            if (agents.length > 0) {
                detail.shadowRoot?.querySelectorAll<HTMLElement>('[data-agent-name]').forEach((row) => {
                    const open = () => {
                        const agentName = row.dataset.agentName;
                        if (!agentName) return;
                        this.selectedAgentName = agentName;
                        this.returningFromAgent = false;
                        // 仅切换 detail 视图，不重建组件树，保持弹窗位置与尺寸稳定
                        this.renderAgentDetail(entry);
                    };
                    row.addEventListener('click', open);
                    row.addEventListener('keydown', (event) => {
                        const keyboardEvent = event as KeyboardEvent;
                        if (keyboardEvent.key !== 'Enter' && keyboardEvent.key !== ' ') return;
                        keyboardEvent.preventDefault();
                        open();
                    });
                });
            }
        }
    }

    private renderAgentDetail(entry: PluginListEntry): void {
        const detail = this.shadowRoot?.querySelector<SkillDetailCard>('#plugin-detail-card');
        if (!detail) return;
        const agent = entry.agents?.find((candidate) => candidate.name === this.selectedAgentName);
        if (!agent) {
            this.selectedAgentName = undefined;
            return;
        }
        const meta = [
            { label: this.t('plugin.center.detail.agentId'), value: `${entry.id}:${agent.name}` },
            {
                label: this.t('plugin.center.detail.dispatchable'),
                value: this.t(agent.dispatchable === false ? 'plugin.center.detail.no' : 'plugin.center.detail.yes')
            }
        ];
        if (agent.whenToUse) {
            meta.push({ label: this.t('plugin.center.detail.whenToUse'), value: agent.whenToUse });
        }
        const model: SkillDetailCardModel = {
            id: `${entry.id}:${agent.name}`,
            name: agent.name,
            subtitle: entry.id,
            closeLabel: this.t('plugin.center.detail.close'),
            backLabel: this.t('plugin.center.detail.back'),
            transition: 'forward',
            descriptionLabel: this.t('plugin.center.detail.agents'),
            bodyHtml: renderSafeMarkdown(agent.body),
            bodyLabel: this.t('plugin.center.detail.agentsMd'),
            metadataLabel: this.t('plugin.center.detail.agentInfo'),
            metadata: meta,
            actions: []
        };
        detail.model = model;
    }

    private renderPluginDetail(): void {
        if (!this.selectedPluginId) return;
        const entry = this.entries.find((candidate) => candidate.id === this.selectedPluginId);
        if (!entry) return;
        const detail = this.shadowRoot?.querySelector<SkillDetailCard>('#plugin-detail-card');
        if (!detail) return;
        const status = this.statusOf(entry);
        const capabilities = entry.runtime?.capabilities.length
            ? entry.runtime.capabilities
            : (entry.manifest?.capabilities ?? []);
        const name = this.pluginName(entry);
        const detailTheme =
            this.dataset.theme ||
            document.documentElement.dataset.theme ||
            this.closest('[data-theme]')?.getAttribute('data-theme');
        if (detailTheme) detail.dataset.theme = detailTheme;
        if (this.selectedAgentName) {
            if (!entry.agents?.some((candidate) => candidate.name === this.selectedAgentName)) {
                this.selectedAgentName = undefined;
            } else {
                this.renderAgentDetail(entry);
                return;
            }
        }
        this.renderAgentsList(entry, name, status, capabilities);
    }

    private renderInstalledPanel(entries: PluginListEntry[]): string {
        if (this.loading) {
            return `<section class="installed-panel"><div class="empty">${escapeHtml(this.t('plugin.center.loading'))}</div></section>`;
        }
        if (entries.length === 0) {
            const emptyKey = this.activeTab === 'builtin' ? 'plugin.center.builtinEmpty' : 'plugin.center.empty';
            const hintKey = this.activeTab === 'builtin' ? 'plugin.center.builtinEmptyHint' : 'plugin.center.emptyHint';
            return `<section class="installed-panel"><div class="empty">
                <div class="empty-icon">📦</div>
                <div class="empty-title">${escapeHtml(this.t(emptyKey))}</div>
                <div class="empty-hint">${escapeHtml(this.t(hintKey))}</div>
            </div></section>`;
        }
        return `<section class="installed-panel"><div class="grid">${entries.map((entry) => this.renderCard(entry)).join('')}</div></section>`;
    }

    private renderInstallProgress(): string {
        const progress = this.installProgress;
        if (!progress) return '';
        const source = this.t(`plugin.center.installProgress.source.${progress.source}`);
        return `<div class="install-progress-overlay" data-install-progress data-install-source="${progress.source}">
            <div class="install-progress-card" role="status" aria-live="polite">
                <div class="install-progress-icon" aria-hidden="true">↓</div>
                <div class="install-progress-title">${escapeHtml(this.t('plugin.center.installProgress.title'))}</div>
                <div class="install-progress-description">${escapeHtml(
                    this.t('plugin.center.installProgress.description', { source })
                )}</div>
                <div class="install-progress-spec" title="${escapeHtml(progress.spec)}">${escapeHtml(progress.spec)}</div>
                <div class="install-progress-track"><div class="install-progress-bar"></div></div>
            </div>
        </div>`;
    }

    private renderInstallDialog(): string {
        const mode = this.installDialogMode;
        if (!mode) return '<div class="modal-overlay od-overlay" data-install-dialog></div>';
        const titleKey = mode === 'npm' ? 'plugin.center.installNpmTitle' : 'plugin.center.installUrlTitle';
        const hintKey = mode === 'npm' ? 'plugin.center.installNpmHint' : 'plugin.center.installUrlHint';
        const placeholderKey =
            mode === 'npm' ? 'plugin.center.installNpmPlaceholder' : 'plugin.center.installUrlPlaceholder';
        return `<div class="modal-overlay od-overlay visible" data-install-dialog>
            <form class="modal-dialog" data-install-form>
                <h3>${escapeHtml(this.t(titleKey))}</h3>
                <div class="hint">${escapeHtml(this.t(hintKey))}</div>
                <input name="spec" type="${mode === 'url' ? 'url' : 'text'}"
                    aria-label="${escapeHtml(this.t(titleKey))}"
                    placeholder="${escapeHtml(this.t(placeholderKey))}"
                    value="${escapeHtml(this.installSpec)}"
                    ${this.busy ? 'disabled' : ''}>
                <div class="dialog-actions">
                    <button type="button" data-action="cancel-install" ${this.busy ? 'disabled' : ''}>${escapeHtml(this.t('plugin.center.cancel'))}</button>
                    <button class="primary" type="submit" ${this.busy ? 'disabled' : ''}>${escapeHtml(this.t(this.busy ? 'plugin.center.installing' : 'plugin.center.install'))}</button>
                </div>
            </form>
        </div>`;
    }

    private render(): void {
        syncShadowHostTheme(
            this,
            this.dataset.theme ||
                document.documentElement.dataset.theme ||
                this.closest('[data-theme]')?.getAttribute('data-theme')
        );
        const builtinEntries = this.entries.filter((entry) => entry.source === 'builtin');
        const installedEntries = this.entries.filter((entry) => entry.source !== 'builtin');
        this.shadowRoot!.innerHTML = `<style>${STYLE}</style>
            <div class="shell">
                <header class="header-area">
                    <div class="header-title">${escapeHtml(this.t('plugin.app.name'))}</div>
                    <div class="seg-row">
                        <div class="seg-control">
                            <button type="button" class="seg-item ${this.activeTab === 'installed' ? 'active' : ''}" data-tab="installed">
                                <span class="seg-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/></svg></span>${escapeHtml(this.t('plugin.center.installed'))}
                                ${installedEntries.length ? `<span class="seg-badge">${installedEntries.length}</span>` : ''}
                            </button>
                            <button type="button" class="seg-item ${this.activeTab === 'builtin' ? 'active' : ''}" data-tab="builtin">
                                <span class="seg-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3Z"/></svg></span>${escapeHtml(this.t('plugin.center.builtin'))}
                                ${builtinEntries.length ? `<span class="seg-badge">${builtinEntries.length}</span>` : ''}
                            </button>
                        </div>
                        <div class="header-actions">
                            <button type="button" class="action-btn" data-action="reload" title="${escapeHtml(this.t('plugin.settings.reload'))}" aria-label="${escapeHtml(this.t('plugin.settings.reload'))}" ${this.busy ? 'disabled' : ''}>↻</button>
                            <div class="add-dropdown-anchor">
                                <button type="button" class="action-btn" data-action="add" title="${escapeHtml(this.t('plugin.center.add'))}" aria-label="${escapeHtml(this.t('plugin.center.add'))}" ${this.busy ? 'disabled' : ''}>+</button>
                                <div class="add-dropdown ${this.addMenuOpen ? 'visible' : ''}">
                                    <div class="add-dropdown-section">
                                        <button type="button" class="add-dropdown-item" data-install-source="npm">
                                            <span class="icon npm"><svg viewBox="0 0 24 24"><g class="k"><path d="M21 14.5V18a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 18v-3.5"/></g><g class="r"><path d="M12 3.5v10"/><path d="m7.5 9.5 4.5 4.5 4.5-4.5"/></g></svg></span>
                                            <span class="item-info"><span class="item-name">${escapeHtml(this.t('plugin.center.installFromNpm'))}</span><span class="item-hint">${escapeHtml(this.t('plugin.center.installFromNpmHint'))}</span></span>
                                        </button>
                                        <button type="button" class="add-dropdown-item" data-install-source="directory">
                                            <span class="icon folder"><svg viewBox="0 0 24 24"><g class="k"><path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"/></g></svg></span>
                                            <span class="item-info"><span class="item-name">${escapeHtml(this.t('plugin.center.installFromDirectory'))}</span><span class="item-hint">${escapeHtml(this.t('plugin.center.installFromDirectoryHint'))}</span></span>
                                        </button>
                                        <label class="add-dropdown-item">
                                            <input type="file" data-install-file accept=".tgz,.zip,application/gzip,application/zip" hidden>
                                            <span class="icon archive"><svg viewBox="0 0 24 24"><g class="k"><rect x="2.5" y="3.5" width="19" height="5" rx="1.2"/><path d="M4.5 8.5V18a2.5 2.5 0 0 0 2.5 2.5h10A2.5 2.5 0 0 0 19.5 18V8.5"/></g><g class="r"><path d="M9.75 12.5h4.5"/></g></svg></span>
                                            <span class="item-info"><span class="item-name">${escapeHtml(this.t('plugin.center.installFromPackage'))}</span><span class="item-hint">${escapeHtml(this.t('plugin.center.installFromPackageHint'))}</span></span>
                                        </label>
                                    </div>
                                    <div class="add-dropdown-section">
                                        <button type="button" class="add-dropdown-item" data-install-source="url">
                                            <span class="icon url"><svg viewBox="0 0 24 24"><g class="k"><rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="M3 9.5h18"/><path d="M6.2 7h.01"/><path d="M9 7h.01"/><path d="M6.5 16h11"/></g><g class="r"><path d="M6.5 13h7"/></g></svg></span>
                                            <span class="item-info"><span class="item-name">${escapeHtml(this.t('plugin.center.installFromUrl'))}</span><span class="item-hint">${escapeHtml(this.t('plugin.center.installFromUrlHint'))}</span></span>
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </header>
                ${this.notice ? `<div class="notice ${this.notice.error ? 'error' : ''}">${escapeHtml(this.notice.text)}</div>` : ''}
                <div class="content">
                    <div class="tab-panel" data-panel="installed" ${this.activeTab === 'installed' ? '' : 'hidden'}>${this.renderInstalledPanel(installedEntries)}</div>
                    <div class="tab-panel" data-panel="builtin" ${this.activeTab === 'builtin' ? '' : 'hidden'}>${this.renderInstalledPanel(builtinEntries)}</div>
                </div>
                ${this.renderInstallDialog()}
                ${this.renderInstallProgress()}
            </div>
            ${this.selectedPluginId ? '<skill-detail-card id="plugin-detail-card"></skill-detail-card>' : ''}`;
        this.bindEvents();
        this.renderPluginDetail();
        this.bindDetailActions();
    }

    private bindDetailActions(): void {
        const detail = this.shadowRoot?.querySelector<SkillDetailCard>('#plugin-detail-card');
        if (!detail) return;
        const entry = this.entries.find((candidate) => candidate.id === this.selectedPluginId);
        if (!entry) return;
        // 避免重复绑定：每次 render() 重新创建 detail 元素，直接使用新引用即可
        detail.addEventListener('skill-detail-action', (event) => {
            const action = (event as CustomEvent<{ id: string }>).detail.id;
            if (action === 'close') {
                this.selectedPluginId = undefined;
                this.selectedAgentName = undefined;
                this.render();
            } else if (action === 'back') {
                this.selectedAgentName = undefined;
                this.returningFromAgent = true;
                this.renderPluginDetail();
            } else if (action === 'toggle') {
                void this.run(
                    () => getAPI().callMainWorld('setEnabled', entry.id, !entry.enabled),
                    entry.enabled ? 'plugin.disable.success' : 'plugin.enable.success'
                );
            } else if (action === 'uninstall') {
                void this.confirmAndUninstall(entry.id, () => {
                    this.selectedPluginId = undefined;
                    this.selectedAgentName = undefined;
                });
            }
        });
    }

    private bindEvents(): void {
        this.shadowRoot?.querySelectorAll<HTMLElement>('[data-tab]').forEach((tab) => {
            tab.addEventListener('click', () => {
                const target = tab.dataset.tab;
                if (target !== 'builtin' && target !== 'installed') return;
                if (this.activeTab === target) return;
                this.activeTab = target;
                this.render();
            });
        });
        this.shadowRoot?.querySelector('[data-action="add"]')?.addEventListener('click', (event) => {
            event.stopPropagation();
            this.addMenuOpen = !this.addMenuOpen;
            this.render();
        });
        this.shadowRoot?.querySelector('[data-install-source="npm"]')?.addEventListener('click', () => {
            this.openInstallDialog('npm');
        });
        this.shadowRoot?.querySelector('[data-install-source="url"]')?.addEventListener('click', () => {
            this.openInstallDialog('url');
        });
        this.shadowRoot?.querySelector('[data-install-source="directory"]')?.addEventListener('click', () => {
            void this.installFromDirectory();
        });
        this.shadowRoot?.querySelector<HTMLInputElement>('[data-install-file]')?.addEventListener('change', (event) => {
            const input = event.currentTarget as HTMLInputElement;
            void this.installFromFile(input.files?.[0]);
            input.value = '';
        });
        this.shadowRoot?.querySelector<HTMLInputElement>('input[name="spec"]')?.addEventListener('input', (event) => {
            this.installSpec = (event.currentTarget as HTMLInputElement).value;
        });
        this.shadowRoot?.querySelector('[data-install-form]')?.addEventListener('submit', (event) => {
            event.preventDefault();
            this.install(this.installSpec, 'plugin.install.success', this.installDialogMode);
        });
        this.shadowRoot?.querySelector('[data-action="cancel-install"]')?.addEventListener('click', () => {
            this.closeInstallDialog();
        });
        this.shadowRoot?.querySelector('[data-install-dialog]')?.addEventListener('click', (event) => {
            if (event.target === event.currentTarget) this.closeInstallDialog();
        });
        this.shadowRoot?.querySelector('.shell')?.addEventListener('click', (event) => {
            if (this.addMenuOpen && !(event.target as Element).closest('.add-dropdown-anchor')) {
                this.addMenuOpen = false;
                this.render();
            }
        });
        this.shadowRoot?.querySelector('[data-action="reload"]')?.addEventListener('click', () => {
            void this.run(() => getAPI().callMainWorld('reload'), 'plugin.runtime.reload.success');
        });
        this.shadowRoot?.querySelectorAll<HTMLElement>('[data-plugin-id]').forEach((card) => {
            const open = (event: Event) => {
                if ((event.target as Element).closest('button, input, label')) return;
                const id = card.dataset.pluginId;
                if (!id) return;
                this.selectedPluginId = id;
                this.selectedAgentName = undefined;
                this.returningFromAgent = false;
                this.render();
            };
            card.addEventListener('click', open);
            card.addEventListener('keydown', (event) => {
                const keyboardEvent = event as KeyboardEvent;
                if (keyboardEvent.key !== 'Enter' && keyboardEvent.key !== ' ') return;
                keyboardEvent.preventDefault();
                open(event);
            });
        });
        this.shadowRoot?.querySelectorAll<HTMLInputElement>('[data-action="toggle"]').forEach((toggle) => {
            toggle.addEventListener('change', () => {
                const id = toggle.dataset.id;
                const entry = this.entries.find((candidate) => candidate.id === id);
                if (id && entry) {
                    void this.run(
                        () => getAPI().callMainWorld('setEnabled', id, toggle.checked),
                        toggle.checked ? 'plugin.enable.success' : 'plugin.disable.success',
                        undefined,
                        true
                    );
                }
            });
        });
        this.shadowRoot?.querySelectorAll<HTMLElement>('[data-action="uninstall"]').forEach((button) => {
            button.addEventListener('click', () => {
                const id = button.dataset.id;
                if (id) void this.confirmAndUninstall(id);
            });
        });
    }
}

if (!customElements.get('pluginmgr-entry-widget')) {
    customElements.define('pluginmgr-entry-widget', PluginMgrEntryWidget);
}
