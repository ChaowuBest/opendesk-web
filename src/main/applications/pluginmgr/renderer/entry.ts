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
import { adoptDeferredSubscription } from '../../../../renderer/deferredSubscription.js';
import {
    resolvePluginDisplayName,
    resolvePluginLocalizedText,
    type PluginAuthor,
    type PluginDisplayName,
    type PluginLocalizedText
} from '../../../../../packages/plugin-sdk/src/index.js';
import {
    getSkillInitial,
    getSkillPastel,
    type SkillDetailAction,
    type SkillDetailCard,
    type SkillDetailCardModel,
    type SkillDetailMetaItem
} from '../../../../renderer/components/skills/skill-detail-card.ts';
import { renderSafeMarkdown } from '../../../../renderer/utils/markdown.js';
import { showConfirmModal, showConfirmModalWithCheckbox } from '../../../../renderer/components/confirmModal.js';
import { OPENDESK_THEME_CHANGED } from '../../../../renderer/theme/theme-iframe-bridge.ts';
import { syncShadowHostTheme } from '../../../../renderer/theme/theme-shadow-overrides.ts';
import type { ThemeAppearance } from '../../../../renderer/theme/theme-manager.js';
import {
    describeHostVersionRange,
    formatPluginDiagnostic,
    isHostVersionCompatible,
    parsePluginHostVersionMessage,
    resolveMarketInstallState,
    type PluginMarketInstallOutcome,
    type PluginMarketInstallState
} from '../catalog-common.js';

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
    source: 'builtin' | 'local';
    path?: string;
    removable: boolean;
    enabled: boolean;
    /** 启停由清单固定（内置插件的 system: true）：开关不可操作 */
    system: boolean;
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
        author?: PluginAuthor;
        /** 插件自身的站点地址（作者主页是 author.homepage） */
        homepage?: string;
        /** 插件图标（zip 解压后的清单声明，主进程已把本地图标内联成 data URL） */
        iconUrl?: string;
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

/** 插件市场里的一个市场（渠道） */
interface PluginMarketRegistryView {
    name: string;
    displayName: string;
}

/** 插件市场清单里的一条插件 */
interface PluginMarketEntry {
    id: string;
    displayName?: PluginDisplayName;
    description?: PluginLocalizedText;
    version?: string;
    apiVersion?: number;
    /** 宿主版本上下界（与插件清单同义，含边界）：不满足时市场里直接标为装不了 */
    minOpenDeskVersion?: string;
    maxOpenDeskVersion?: string;
    platforms?: string[];
    category?: string[];
    downloadUrl: string;
    author?: PluginAuthor;
    /** 插件自身的站点地址（作者主页是 author.homepage） */
    homepage?: string;
    /** 插件图标地址（本地图标已被主进程内联成 data URL） */
    iconUrl?: string;
}

/** 一个市场的清单：categories 缺省表示该市场不支持按分类显示 */
interface PluginMarketCatalog {
    categories?: string[];
    entries: PluginMarketEntry[];
}

/** 从市场安装时的下载进度（total 为 null 表示服务端没给长度） */
interface MarketInstallProgress {
    received: number;
    total: number | null;
}

/**
 * 可以单独重绘的叶子区域：通知条、安装弹窗、安装进度浮层、插件市场面板。
 *
 * 它们与插件列表互不依赖，各自挂在 render() 输出的 [data-region] 挂载点上，
 * 状态变化时只替换这一段 HTML，不牵连列表（滚动位置、卡片动画都不受影响）。
 */
type LeafRegion = 'notice' | 'install-dialog' | 'install-progress' | 'market';

/**
 * 每个插件市场（registry）在插件中心占一个独立 Tab，与测评集应用的导航一致：
 * tab id 带前缀，名字直接用渠道展示名，而不是「插件市场 → 再选市场」两层。
 */
const MARKET_TAB_PREFIX = 'market:';

type PluginTab = 'installed' | 'builtin' | `${typeof MARKET_TAB_PREFIX}${string}`;

function marketTabId(name: string): PluginTab {
    return `${MARKET_TAB_PREFIX}${name}`;
}

/** Tab id 对应的市场名；「已安装」「内置插件」这类内置 Tab 返回 null */
function marketNameOfTab(tab: string): string | null {
    return tab.startsWith(MARKET_TAB_PREFIX) ? tab.slice(MARKET_TAB_PREFIX.length) : null;
}

interface InstallProgressState {
    source: ManagedInstallSource;
    spec: string;
}

interface PluginFileSystemAPI {
    getFilePath?: (file: File) => string | Promise<string>;
    selectDirectory?: () => Promise<string | null>;
}

const STYLE = `
:where(button, input, select, textarea, option, optgroup) { font-family: inherit; }
${OVERLAY_CSS}
:host {
    display: block;
    height: 100%;
    overflow: hidden;
    color: #1d1d1f;
    background: #fff;
    font: 13px var(--font-sans);
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
    position: relative;
    overflow: hidden;
    width: 40px;
    height: 40px;
    align-items: center;
    justify-content: center;
    flex: none;
    border-radius: 11px;
    font-size: 17px;
    font-weight: 700;
}
/* 清单声明了 iconUrl 的卡片：图片覆盖在首字母上（加载失败移除图片露出首字母兜底） */
.card-icon-img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
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
/* 来源与启停标记靠左并排，右侧留给开关与卸载按钮 */
.plugin-tags { display: flex; align-items: center; gap: 6px; margin-right: auto; }
.builtin-tag, .system-tag {
    padding: 3px 9px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 550;
}
.builtin-tag {
    color: #8a6d1f;
    background: #fdf6e3;
    border: 1px solid rgba(196, 154, 42, .25);
}
.system-tag {
    color: #4a6ab5;
    background: #eef2fb;
    border: 1px solid rgba(91, 141, 239, .25);
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
/* 启停由清单固定的插件：开关永久禁用，光标提示不可操作 */
.plugin-toggle.is-locked input:disabled + .plugin-toggle-slider { cursor: not-allowed; }
/* 启停请求发出后原地换成一个转圈（与侧边栏任务列表的进行中图标同款），等结果回来再恢复开关 */
.plugin-toggle-spinner { display: none; }
.plugin-toggle.is-pending .plugin-toggle-slider { display: none; }
.plugin-toggle.is-pending .plugin-toggle-spinner {
    display: block;
    position: absolute;
    top: 3px;
    left: 11px;
    width: 18px;
    height: 18px;
    border: 2px solid rgba(0, 0, 0, .12);
    border-top-color: #5b8def;
    border-radius: 50%;
    animation: plugin-toggle-spin .8s linear infinite;
}
@keyframes plugin-toggle-spin { to { transform: rotate(360deg); } }
/* ── 插件市场 ── */
/* 搜索框、计数与搜索按钮的观感与技能中心的市场页保持一致；
   每个插件市场一个 Tab，面板里只有搜索框、刷新、分类切换与插件卡片 */
.market-panel { display: flex; flex-direction: column; gap: 14px; }
.search-bar { display: flex; align-items: center; gap: 10px; }
.search-input-wrap { position: relative; flex: 1; min-width: 0; }
.search-input {
    width: 100%;
    padding: 9px 34px 9px 14px;
    color: #1d1d1f;
    background: #fafafa;
    border: 1px solid rgba(0, 0, 0, .08);
    border-radius: 10px;
    outline: none;
    font-size: 13px;
    transition: border-color .18s, box-shadow .18s, background .18s;
}
.search-input:focus { background: #fff; border-color: #8bb8f0; box-shadow: 0 0 0 3px rgba(90, 140, 240, .08); }
.search-input::placeholder { color: #b9bcc2; }
/* 搜索框为空时隐藏清除按钮：此时点击只会无谓地重新拉取清单并让结果区闪一下 */
.search-input:placeholder-shown ~ .search-clear { display: none; }
.search-clear {
    position: absolute;
    top: 50%;
    right: 10px;
    display: flex;
    width: 20px;
    height: 20px;
    align-items: center;
    justify-content: center;
    padding: 0;
    transform: translateY(-50%);
    color: rgba(0, 0, 0, .35);
    background: rgba(0, 0, 0, .06);
    border: 0;
    border-radius: 50%;
    font-size: 11px;
    line-height: 1;
    cursor: pointer;
}
.search-clear:hover { color: rgba(0, 0, 0, .55); background: rgba(0, 0, 0, .1); }
.search-count {
    position: absolute;
    top: 50%;
    right: 36px;
    max-width: 40%;
    overflow: hidden;
    transform: translateY(-50%);
    color: #9a9da4;
    font-size: 11.5px;
    text-overflow: ellipsis;
    white-space: nowrap;
    pointer-events: none;
}
/* 有计数时给输入区右侧留白，避免压住用户输入的文本 */
.search-input-wrap.has-count .search-input { padding-right: 42%; }
.search-btn {
    flex: none;
    padding: 9px 20px;
    color: #fff;
    background: #6ba3ef;
    border-color: #6ba3ef;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 550;
}
.search-btn:hover { background: #7db0f3; }
.market-categories { display: flex; flex-wrap: wrap; gap: 6px; }
.market-category {
    padding: 5px 12px;
    color: #55595f;
    background: #f4f5f7;
    border: 1px solid transparent;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 550;
}
.market-category:hover { background: #eef0f4; }
.market-category.active { color: #2f6bc4; background: #eaf2fe; border-color: rgba(91, 141, 239, .35); }
/* 市场页签右上角的刷新：与搜索按钮同高，单独占一格 */
.market-refresh-btn {
    flex: none;
    width: 38px;
    height: 38px;
    padding: 0;
    color: #444;
    border-radius: 10px;
    font-size: 15px;
    line-height: 1;
}
/* 市场里的插件卡片：尺寸与信息密度对齐技能中心的卡片 */
.market-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)); gap: 12px; }
.market-card {
    display: flex;
    min-width: 0;
    padding: 16px 18px;
    flex-direction: column;
    gap: 8px;
    background: #fff;
    border: 1px solid rgba(0, 0, 0, .05);
    border-radius: 14px;
    box-shadow: 0 1px 2px rgba(0, 0, 0, .03);
    cursor: pointer;
    outline: none;
    transition: border-color .15s, box-shadow .15s;
}
.market-card:hover, .market-card:focus-visible {
    border-color: rgba(91, 141, 239, .28);
    box-shadow: 0 8px 24px rgba(0, 0, 0, .05);
}
.market-card .card-header { display: flex; min-width: 0; align-items: flex-start; gap: 12px; }
.market-card .card-icon {
    display: flex;
    position: relative;
    overflow: hidden;
    width: 40px;
    height: 40px;
    flex: none;
    align-items: center;
    justify-content: center;
    border-radius: 11px;
    font-size: 17px;
    font-weight: 700;
}
.market-card .card-info { min-width: 0; flex: 1; }
.card-title-row { display: flex; min-width: 0; align-items: center; gap: 6px; }
.market-card .card-title {
    overflow: hidden;
    font-size: 14px;
    font-weight: 600;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.tag-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: none;
    padding: 3px 9px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 500;
}
/* 插件名右侧的版本号胶囊 */
.tag-version { padding: 1px 7px; color: #5b8def; background: #ebf3fe; font-size: 10px; }
.tag-category { color: #6b7280; background: #f3f4f6; }
.tag-installed { color: #4a9b63; background: #e7f6ea; }
/* 可更新：与「已安装」区分开的暖色，和测评集应用的「可更新」观感一致 */
.tag-update { color: #b26b00; background: #fff2dd; }
/* 装不了（与内置插件冲突 / 宿主版本不满足）：只在市场里出现，说明「为什么装不了」 */
.tag-blocked { color: #b4372f; background: #fdecea; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 作者行：@作者 (单位)；作者给了主页时名字可点，交给系统浏览器打开 */
.market-card .card-author { margin-top: 2px; font-size: 11px; color: #999; overflow-wrap: anywhere; }
.card-author-link { color: #5b8def; text-decoration: none; }
.card-author-link:hover { text-decoration: underline; }
/* 正文最多两行 */
.market-card .card-desc {
    display: -webkit-box;
    overflow: hidden;
    font-size: 12px;
    color: #777;
    line-height: 1.5;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
}
.market-card .card-footer {
    display: flex;
    min-width: 0;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: auto;
    padding-top: 4px;
}
.card-meta { display: flex; min-width: 0; flex-wrap: wrap; align-items: center; gap: 6px; }
.install-btn {
    flex: none;
    padding: 5px 14px;
    color: #5b8def;
    background: #ebf3fe;
    border: 0;
    border-radius: 14px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background .15s;
}
.install-btn:hover { background: #dce9fc; }
.install-btn:disabled { opacity: .4; cursor: not-allowed; }
.install-btn.installing { color: #999; background: #f5f5f5; }
.market-progress { display: flex; flex-direction: column; gap: 5px; }
.market-progress-track { height: 3px; overflow: hidden; background: #e8edf5; border-radius: 999px; }
.market-progress-bar {
    width: 0;
    height: 100%;
    background: linear-gradient(90deg, #5b8def, #8bb8f0);
    border-radius: inherit;
    transition: width .18s ease;
}
.market-progress-label { color: #8a8d95; font-size: 11px; }
/* 载入/空结果：与技能中心同一套观感（居中的圆环 / 淡图标 + 标题 + 提示） */
.loading-state { display: flex; flex-direction: column; align-items: center; padding: 40px 20px; color: #999; }
.loading-spinner {
    width: 24px;
    height: 24px;
    margin-bottom: 12px;
    border: 2.5px solid #f0f0f0;
    border-top-color: #6ba3ef;
    border-radius: 50%;
    animation: market-spin .7s linear infinite;
}
@keyframes market-spin { to { transform: rotate(360deg); } }
/* 搜索框右端的忙碌提示：与技能中心同款小转圈 */
.mini-spinner {
    display: inline-block;
    width: 11px;
    height: 11px;
    margin-right: 5px;
    border: 1.6px solid rgba(0, 0, 0, .12);
    border-top-color: #6ba3ef;
    border-radius: 50%;
    animation: market-spin .7s linear infinite;
}
.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px 20px; color: #999; }
.empty-state .empty-icon { margin-bottom: 12px; font-size: 36px; opacity: .4; }
.empty-state .empty-title { margin-bottom: 6px; color: #1d1d1f; font-size: 15px; font-weight: 600; }
.empty-state .empty-hint {
    max-width: min(320px, 100%);
    color: #999;
    font-size: 12px;
    line-height: 1.6;
    text-align: center;
    /* 提示里可能出现 URL 这类不可断长串：允许折行，否则整行会从容器左侧溢出，
       居中失效（浏览器会把溢出的单行退化成左对齐），看着歪掉 */
    overflow-wrap: anywhere;
}
/* 错误详情是「一句话 + 接口地址 + 状态码」，比普通提示需要更宽的行：让地址保持完整不被打断 */
.empty-state .empty-hint.error-detail { max-width: min(460px, 100%); }
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
:host([data-theme="dark"]) .system-tag { color: #9db8ef; background: rgba(91, 141, 239, .18); border-color: rgba(91, 141, 239, .3); }
:host([data-theme="dark"]) .empty {
    color: #a4a7ad;
    background: #242426;
    border-color: rgba(255, 255, 255, .14);
}
:host([data-theme="dark"]) .empty-title { color: #ddd; }
:host([data-theme="dark"]) .plugin-toggle.is-pending .plugin-toggle-spinner {
    border-color: rgba(255, 255, 255, .16);
    border-top-color: #8bb8f0;
}
:host([data-theme="dark"]) .name { color: #e5e7eb; }
:host([data-theme="dark"]) .meta, :host([data-theme="dark"]) .plugin-id,
:host([data-theme="dark"]) .modal-dialog .hint { color: #a4a7ad; }
:host([data-theme="dark"]) .search-input { color: #ddd; background: #2a2a2c; border-color: rgba(255, 255, 255, .12); }
:host([data-theme="dark"]) .search-input:focus { background: #303033; border-color: rgba(91, 141, 239, .6); }
:host([data-theme="dark"]) .search-count { color: #8f939a; }
:host([data-theme="dark"]) .market-category { color: #b8bcc2; background: #2a2a2c; }
:host([data-theme="dark"]) .market-category:hover { background: #333336; }
:host([data-theme="dark"]) .market-category.active { color: #a8c8ff; background: rgba(91, 141, 239, .2); }
:host([data-theme="dark"]) .market-card { background: #252526; border-color: rgba(255, 255, 255, .18); }
:host([data-theme="dark"]) .market-card .card-title { color: #e5e7eb; }
:host([data-theme="dark"]) .market-card .card-desc { color: #ababab; }
:host([data-theme="dark"]) .market-card .card-author { color: #ababab; }
:host([data-theme="dark"]) .card-author-link { color: #8bb8f0; }
:host([data-theme="dark"]) .tag-version { color: #9db8ef; background: rgba(91, 141, 239, .18); }
:host([data-theme="dark"]) .tag-category { color: #b8bcc2; background: rgba(255, 255, 255, .08); }
:host([data-theme="dark"]) .tag-installed { color: #8ce0a4; background: rgba(74, 155, 99, .22); }
:host([data-theme="dark"]) .tag-update { color: #ffc978; background: rgba(178, 107, 0, .24); }
:host([data-theme="dark"]) .tag-blocked { color: #ff9d94; background: rgba(180, 55, 47, .24); }
:host([data-theme="dark"]) .install-btn { color: #9db8ef; background: rgba(91, 141, 239, .18); }
:host([data-theme="dark"]) .install-btn:hover { background: rgba(91, 141, 239, .26); }
:host([data-theme="dark"]) .install-btn.installing { color: #a4a7ad; background: #303033; }
:host([data-theme="dark"]) .loading-state { color: #ababab; }
:host([data-theme="dark"]) .loading-spinner { border-color: rgba(255, 255, 255, .16); border-top-color: #8bb8f0; }
:host([data-theme="dark"]) .empty-state { color: #ababab; }
:host([data-theme="dark"]) .empty-state .empty-title { color: #e5e7eb; }
:host([data-theme="dark"]) .empty-state .empty-hint { color: #ababab; }
:host([data-theme="dark"]) .market-progress-track { background: #3a3d44; }
:host([data-theme="dark"]) .market-progress-label { color: #a4a7ad; }
:host([data-theme="dark"]) .market-link { color: #8bb8f0; }
@media (max-width: 700px) {
    .header-area, .installed-panel { padding-left: 16px; padding-right: 16px; }
}
`;

function getAPI() {
    return window.applicationAPI;
}

/** 有总长度时算百分比，否则返回 null（界面退化成「已下载 x」） */
function progressPercent(progress: MarketInstallProgress | undefined): number | null {
    if (!progress || !progress.total || progress.total <= 0) return null;
    return Math.min(100, Math.round((progress.received / progress.total) * 100));
}

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export class PluginMgrEntryWidget extends HTMLElement {
    private entries: PluginListEntry[] = [];
    private loading = true;
    /**
     * 是否存在全局操作（安装 / 卸载 / 重载）进行中。
     *
     * 单插件的启停不走这个标志：每张卡片用自己的 pending 状态显示转圈，见 pendingToggles。
     */
    private busy = false;
    /**
     * 正在切换启用状态、还在等结果的插件 ID。
     *
     * 主进程的插件宿主操作本身是串行的（bootstrap 的 serializeHostOperation），所以这里不
     * 需要把整页控件禁用掉来互斥：多个开关可以连续点击，后端按顺序执行，每张卡片各自显示
     * 转圈提示即可。
     */
    private readonly pendingToggles = new Set<string>();
    /** 已经绑过动作监听的详情元素：增量刷新复用同一个元素，不能重复绑 */
    private readonly boundDetailCards = new WeakSet<SkillDetailCard>();
    private addMenuOpen = false;
    /** 当前展示的 tab：已安装 / 内置插件，以及每个插件市场各占一个 Tab */
    private activeTab: PluginTab = 'installed';
    /** 首屏默认落点已应用：进入插件中心默认停在第一个市场，用户切走过之后不再抢焦点 */
    private initialTabApplied = false;
    /** 插件市场（registry）列表：每个市场在顶部占一个 Tab，名字来自渠道展示名 */
    private marketRegistries: PluginMarketRegistryView[] = [];
    private marketRegistriesLoading = false;
    /** 当前市场 Tab 的清单（含该市场自述的分类） */
    private marketCatalog?: PluginMarketCatalog;
    private marketCatalogLoading = false;
    private marketCatalogError?: string;
    /** 当前分类（空串表示「全部插件」）与搜索关键词 */
    private marketCategory = '';
    private marketQuery = '';
    private marketSearching = false;
    /**
     * 清单请求序号：切分类、连续搜索时旧请求可能后到，只允许最后一次请求写回结果。
     * 只比 registry 名是不够的——同一个市场里换分类也会并发。
     */
    private marketCatalogRequestId = 0;
    /** 搜索触发的重绘后要把焦点还给搜索框，否则回车搜索完必须再点一次才输得进去 */
    private marketFocusSearch = false;
    /** 正在从市场安装的插件：插件 id → 下载进度 */
    private readonly marketInstalls = new Map<string, MarketInstallProgress>();
    private installDialogMode?: InstallDialogMode;
    private installSpec = '';
    private installProgress?: InstallProgressState;
    private selectedPluginId?: string;
    /** 已打开详情的市场插件 id（插件市场卡片里的条目，与已安装插件的详情互斥） */
    private selectedMarketPluginId?: string;
    /** 已经绑过动作监听的市场详情元素（同上，不能重复绑） */
    private readonly boundMarketDetailCards = new WeakSet<SkillDetailCard>();
    private selectedAgentName?: string;
    private returningFromAgent = false;
    private notice?: { text: string; error: boolean };
    private t = createRendererTranslator();
    private locale = resolveRendererLocale();
    /** pluginsChanged 订阅句柄（异步获取，由 adoptDeferredSubscription 接管过期退订） */
    private pluginsChangedUnsubscribe?: () => void;
    /** marketInstallProgress 订阅句柄（同上） */
    private marketInstallUnsubscribe?: () => void;
    /** registriesChanged 订阅句柄（同上） */
    private registriesChangedUnsubscribe?: () => void;
    /**
     * 宿主侧变更通知：拉一次列表后增量更新界面（只有插件增删才整树重绘），并保留当前 notice。
     *
     * 失败操作同样会广播（实例被装回后必须让订阅方重新对齐），如果这里清 notice，
     * 用户点完卸载后看到的错误提示会被紧随其后的刷新抹掉。
     */
    private readonly onPluginsChanged = () => void this.refreshEntries();
    /**
     * 插件渠道变了（设置里加/删/启停）：重新拉一次市场列表。
     *
     * 不重新拉的话，用户在设置里加完渠道回到插件中心，还得先切走再切回来才看得到新市场。
     * 打开着的市场被禁用/删除时由 ensureMarketRegistries 退回市场列表。
     */
    private readonly onRegistriesChanged = () => void this.ensureMarketRegistries(true);
    /** 市场安装下载进度：只更新对应卡片的进度条，不整树重绘 */
    private readonly onMarketInstallProgress = (payload: unknown) => {
        const data = payload as
            | {
                  registry?: unknown;
                  pluginId?: unknown;
                  receivedBytes?: unknown;
                  totalBytes?: unknown;
                  failed?: unknown;
              }
            | undefined;
        const pluginId = typeof data?.pluginId === 'string' ? data.pluginId : '';
        const registryName = typeof data?.registry === 'string' ? data.registry : '';
        // 失败终态由 installFromMarket 的 finally 收尾（那里会重画面板并给出错误提示）；
        // 市场名也要对上：两个市场可能有同名插件，进度不能串到另一个市场的卡片上
        if (!pluginId || data?.failed === true || !this.marketInstalls.has(pluginId)) return;
        if (registryName && this.currentMarket && registryName !== this.currentMarket) return;
        const received = typeof data?.receivedBytes === 'number' ? data.receivedBytes : 0;
        const total = typeof data?.totalBytes === 'number' ? data.totalBytes : null;
        this.marketInstalls.set(pluginId, { received, total });
        this.syncMarketInstallProgress(pluginId, received, total);
    };
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
        this.pluginsChangedUnsubscribe?.();
        this.pluginsChangedUnsubscribe = undefined;
        this.marketInstallUnsubscribe?.();
        this.marketInstallUnsubscribe = undefined;
        this.registriesChangedUnsubscribe?.();
        this.registriesChangedUnsubscribe = undefined;
        // 事件级兜底：句柄尚未返回时（订阅仍在 IPC 往返中）本 frame 仍有登记，按事件名清掉
        // 即可；句柄已释放时这次调用是 no-op（preload 不会重复递减 main 侧计数）
        getAPI().unsubscribe('pluginsChanged');
        getAPI().unsubscribe('marketInstallProgress');
        getAPI().unsubscribe('registriesChanged');
        window.removeEventListener('message', this.onLocaleMessage);
        document.removeEventListener(OPENDESK_THEME_CHANGED, this.onThemeChanged);
    }

    private applyLocale(locale: string): void {
        if (!isSupportedLocale(locale) || locale === this.locale) return;
        this.locale = locale;
        this.t = createRendererTranslator(locale);
        this.render();
        // 市场 Tab 的名字是主进程按「当时的界面语言」解析好的：切语言后要重新拉一次，
        // 否则官方市场会一直停在切换前的语言上
        if (this.marketRegistries.length > 0) void this.ensureMarketRegistries(true);
    }

    /** 按当前界面语言解析插件显示名：运行时值优先，未声明时回退插件 ID */
    private pluginName(entry: PluginListEntry): string {
        return (
            resolvePluginDisplayName(entry.runtime?.displayName, this.locale) ??
            resolvePluginDisplayName(entry.manifest?.displayName, this.locale) ??
            entry.id
        );
    }

    /**
     * 按 id 取通知里要展示的名字。
     *
     * 优先用已装条目里解析好的展示名；条目已经不在列表里时（刚被卸载）再退到市场清单里的
     * displayName，最后才回退 id——通知是给用户看的，不该出现内部 id。
     */
    private pluginDisplayName(id: string): string {
        const entry = this.entries.find((candidate) => candidate.id === id);
        if (entry) return this.pluginName(entry);
        const catalogEntry = this.marketCatalog?.entries.find((candidate) => candidate.id === id);
        return resolvePluginDisplayName(catalogEntry?.displayName, this.locale) ?? id;
    }

    /** 当前 Tab 对应的市场名（「已安装」「内置插件」这类内置 Tab 返回 null） */
    private get currentMarket(): string | null {
        return marketNameOfTab(this.activeTab);
    }

    /** 按当前界面语言解析插件描述：运行时值优先，未声明时回退 manifest，均无则返回 undefined */
    private pluginDescription(entry: PluginListEntry): string | undefined {
        return (
            resolvePluginLocalizedText(entry.runtime?.description, this.locale) ??
            resolvePluginLocalizedText(entry.manifest?.description, this.locale)
        );
    }

    /**
     * 市场卡片的作者行：`@名字 (单位)`。
     *
     * 作者声明了主页时，名字本身是可点链接：`<a target="_blank">` 会被主窗口的
     * window-open 策略交给系统浏览器打开（见 main/utils/main-window-navigation.ts）。
     */
    private renderMarketAuthor(entry: PluginMarketEntry): string {
        const name = resolvePluginDisplayName(entry.author?.name, this.locale);
        if (!name) return '';
        const institution = resolvePluginLocalizedText(entry.author?.institution, this.locale);
        const homepage = entry.author?.homepage;
        const nameHtml = homepage
            ? `<a class="card-author-link" href="${escapeHtml(
                  homepage
              )}" target="_blank" rel="noopener noreferrer">@${escapeHtml(name)}</a>`
            : `@${escapeHtml(name)}`;
        return `<div class="card-author">${nameHtml}${institution ? ` (${escapeHtml(institution)})` : ''}</div>`;
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
        // 订阅要等 IPC 往返才拿到句柄：元素若在此期间被销毁，由 adoptDeferredSubscription 自动退订
        adoptDeferredSubscription(
            this,
            getAPI().subscribe('pluginsChanged', this.onPluginsChanged),
            (unsubscribe) => {
                this.pluginsChangedUnsubscribe = unsubscribe;
            },
            (error) => console.warn('Failed to subscribe pluginsChanged:', error)
        );
        adoptDeferredSubscription(
            this,
            getAPI().subscribe('marketInstallProgress', this.onMarketInstallProgress),
            (unsubscribe) => {
                this.marketInstallUnsubscribe = unsubscribe;
            },
            (error) => console.warn('Failed to subscribe marketInstallProgress:', error)
        );
        adoptDeferredSubscription(
            this,
            getAPI().subscribe('registriesChanged', this.onRegistriesChanged),
            (unsubscribe) => {
                this.registriesChangedUnsubscribe = unsubscribe;
            },
            (error) => console.warn('Failed to subscribe registriesChanged:', error)
        );
        await this.load();
        // 每个插件市场占一个 Tab，所以首屏就要拿到渠道列表
        await this.ensureMarketRegistries();
    }

    /** 首屏加载：拉列表后整树渲染（loading 骨架 → 内容） */
    private async load(): Promise<void> {
        const next = await this.fetchEntries();
        if (next) {
            this.entries = next;
            if (this.selectedPluginId && !next.some((entry) => entry.id === this.selectedPluginId)) {
                this.selectedPluginId = undefined;
            }
        }
        this.loading = false;
        this.render();
    }

    /** 拉一次插件列表；失败时把错误写进通知条并返回 null（保留现有列表） */
    private async fetchEntries(): Promise<PluginListEntry[] | null> {
        try {
            return (await getAPI().callMainWorld('list')) as PluginListEntry[];
        } catch (error) {
            this.setNotice(error instanceof Error ? error.message : String(error), true);
            return null;
        }
    }

    /**
     * 顶栏刷新：并行重拉插件列表与当前市场的清单，不触碰插件运行时。
     *
     * 顶栏的 ↻ 在视觉上就是「刷新」，不能绑定运行时重载——那会把全部插件停掉
     * 再重启，秒级起步还顺带禁用整页控件。「重新加载运行时」保留在「+」菜单里。
     * 当前不在市场 Tab 时 loadMarketCatalog 会自己空转，这里不用分情况。
     */
    private async refreshFromHeader(): Promise<void> {
        const button = this.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="refresh"]');
        if (button?.disabled) return;
        if (button) button.disabled = true;
        try {
            await Promise.all([this.refreshEntries(), this.loadMarketCatalog({ forceRefresh: true })]);
        } finally {
            // 刷新期间可能并行跑了一个 run()（busy 已置 true）：此时按钮的禁用要交给 busy 管，别抢着恢复
            if (button) button.disabled = this.busy;
        }
    }

    /**
     * 拉最新列表后按需更新界面：只有插件增删才整树重绘，纯状态变化只替换受影响的卡片。
     *
     * 整树重绘会重建整个列表 DOM（滚动位置虽有 render() 兜底，但卡片上的过渡动画会从头播），
     * 启停这类高频操作不该付这个代价。
     *
     * @param dirtyIds 无论数据是否变化都必须重绘的卡片（如刚结束 pending 的那张）
     */
    private async refreshEntries(dirtyIds?: Iterable<string>): Promise<void> {
        const next = await this.fetchEntries();
        if (!next) {
            // 列表拉不回来时按现有数据把这几张卡片重绘一遍：转圈、禁用态一起复位，
            // 否则卡片会卡在「转圈摘了就点不动」的半截状态
            for (const id of dirtyIds ?? []) {
                const entry = this.entries.find((candidate) => candidate.id === id);
                if (entry) this.syncCard(entry);
            }
            return;
        }
        if (this.applyEntries(next, dirtyIds)) return;
        this.renderPluginDetail();
        this.bindDetailActions();
        this.renderMarketPluginDetail();
        this.refreshMarketCards();
    }

    /**
     * 插件列表变了（版本 / 启停 / 安装状态）：当前市场卡片上的「已安装 / 可更新」要按新状态重算。
     *
     * 版本变化可能来自别处（头部「+」装本地包、另一个窗口、CLI），那种情况下插件 id 集合没变，
     * applyEntries 走的是增量路径，不会重画市场区域——不补这一下，卡片会一直提示已经装上的旧版本。
     * 搜索框正在输入时跳过重画，免得把光标和输入法状态顶掉；那种情况下下次重画自然会更新。
     */
    private refreshMarketCards(): void {
        if (!this.currentMarket) return;
        const input = this.shadowRoot?.querySelector<HTMLInputElement>('[data-market-search]');
        if (input && this.shadowRoot?.activeElement === input) return;
        this.paintMarket();
    }

    /** 把新列表应用到界面；返回 true 表示已整树重绘 */
    private applyEntries(next: PluginListEntry[], dirtyIds?: Iterable<string>): boolean {
        const previous = this.entries;
        const previousById = new Map(previous.map((entry) => [entry.id, entry]));
        this.entries = next;
        if (this.selectedPluginId && !next.some((entry) => entry.id === this.selectedPluginId)) {
            this.selectedPluginId = undefined;
        }
        // 增删插件会改变分组、计数与卡片顺序，只有这种情况才值得整树重绘
        const sameComposition =
            previous.length === next.length && previous.every((entry, index) => entry.id === next[index].id);
        if (!sameComposition) {
            this.render();
            return true;
        }
        const dirty = new Set(dirtyIds ?? []);
        for (const entry of next) {
            const before = previousById.get(entry.id);
            if (!dirty.has(entry.id) && before && JSON.stringify(before) === JSON.stringify(entry)) continue;
            this.syncCard(entry);
        }
        return false;
    }

    /** 用最新数据原地替换一张卡片（含运行时诊断与 pending 外观），不触碰列表其它部分 */
    private syncCard(entry: PluginListEntry): void {
        const card = this.findCard(entry.id);
        if (!card || !card.parentNode) return;
        // 键盘操作时焦点停在开关上：换节点后把焦点还回去，别让它掉到 body
        const keepFocus = card.contains(this.shadowRoot?.activeElement ?? null);
        const holder = document.createElement('div');
        holder.innerHTML = this.renderCard(entry);
        const next = holder.firstElementChild as HTMLElement | null;
        if (!next) return;
        card.parentNode.replaceChild(next, card);
        this.bindCardEvents(next);
        if (keepFocus) next.querySelector<HTMLInputElement>('[data-action="toggle"]')?.focus();
    }

    /** 按 id 找卡片：插件 id 可能含引号/尖括号等字符，不能用属性选择器拼串 */
    private findCard(id: string): HTMLElement | null {
        return this.cards().find((card) => card.dataset.pluginId === id) ?? null;
    }

    private cards(): HTMLElement[] {
        return Array.from(this.shadowRoot?.querySelectorAll<HTMLElement>('[data-plugin-id]') ?? []);
    }

    /**
     * 跑一次全局操作（安装 / 卸载 / 重载）。
     *
     * 全程只做局部更新：busy 期间的控件禁用由 setBusy 就地把属性改掉，
     * 收尾的列表刷新走 refreshEntries 的增量路径，不整树重绘。
     *
     * 结果一律走系统通知，不写页面顶部的提示条：安装 / 卸载可能耗时几十秒，用户常常已经切走；
     * 而提示条在详情模态弹窗打开时还会被盖住，等于没反馈。
     *
     * `onError` 返回 true 表示该失败已由调用方自行反馈（如宿主版本不满足的模态弹窗），
     * 不再发默认的系统通知。
     */
    private async run(
        operation: () => Promise<unknown>,
        successKey: string,
        onSuccess?: () => void,
        onError?: (message: string) => boolean
    ): Promise<void> {
        if (this.busy) return;
        this.clearNotice();
        this.setBusy(true);
        try {
            const outcome = await operation();
            onSuccess?.();
            const id =
                outcome && typeof outcome === 'object' && typeof (outcome as { id?: unknown }).id === 'string'
                    ? (outcome as { id: string }).id
                    : undefined;
            // 先刷新列表再发通知：通知要用插件自己的展示名，名字来自刷新后的条目
            await this.refreshEntries();
            this.notifyOperationResult(
                this.t(successKey),
                id ? this.t(`${successKey}Detail`, { name: this.pluginDisplayName(id) }) : this.t(successKey),
                false
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (onError?.(message)) return;
            this.notifyOperationResult(this.t(successKey.replace(/\.success$/, '.fail')), message, true);
        } finally {
            this.setBusy(false);
        }
    }

    /**
     * 切换单个插件的启用状态。
     *
     * 只影响这一张卡片：开关原地换成转圈，其它插件的开关保持可用。后端串行执行，
     * 所以连续点几个开关也没问题，各自完成后各自恢复。
     */
    private async togglePlugin(id: string, enabled: boolean): Promise<void> {
        // 启停由清单固定（system）的插件不接受开关操作；UI 已禁用开关，这里兜住其它触发路径
        if (this.entries.find((entry) => entry.id === id)?.system === true) return;
        if (this.pendingToggles.has(id) || this.busy) return;
        this.pendingToggles.add(id);
        this.clearNotice();
        // 就地切到转圈，而不是整表重绘：整树重建会让开关的过渡动画从头播放
        this.syncTogglePending(id);
        try {
            await getAPI().callMainWorld('setEnabled', id, enabled);
            this.notifyToggle(id, enabled);
        } catch (error) {
            this.notifyToggle(id, enabled, error instanceof Error ? error.message : String(error));
        } finally {
            this.pendingToggles.delete(id);
            // 只把这一张卡片刷成最终状态（摘掉 pending 外观），不整表刷新
            await this.refreshEntries([id]);
        }
    }

    /**
     * 启停结果走系统通知（与技能中心里技能的启停一致），不占用页面顶部的通知条：
     * 开关本身已经表达了状态，顶部横幅只留给安装 / 卸载这类过程性结果。
     */
    private notifyToggle(id: string, enabled: boolean, errorMessage?: string): void {
        const action = enabled ? 'enable' : 'disable';
        const title = this.t(`plugin.${action}.${errorMessage ? 'fail' : 'success'}`);
        // 通知面向用户，用插件自己的展示名（多语言由清单声明），别把内部 id 摆出来
        const message = errorMessage ?? this.t(`plugin.${action}.successDetail`, { name: this.pluginDisplayName(id) });
        // 通知只是结果反馈：应用 API 异常（含同步抛出的 Unavailable）不能反过来影响启停流程
        try {
            void getAPI()
                .callMainWorld(
                    'sendNotification',
                    errorMessage ? 'error' : 'info',
                    this.t('plugin.app.name'),
                    title,
                    message
                )
                .catch(() => undefined);
        } catch {
            /* applicationAPI 不可用时静默跳过 */
        }
    }

    /**
     * 全局操作进行中：只同步受影响的控件，不重建界面。
     *
     * 现场渲染时这些控件同样会按 busy 输出 disabled（安装弹窗还会切成「安装中」），
     * 这里就地改属性，保证增量状态与整树渲染的结果一致。
     */
    private setBusy(busy: boolean): void {
        if (this.busy === busy) return;
        this.busy = busy;
        const root = this.shadowRoot;
        if (!root) return;
        for (const selector of ['[data-action="refresh"]', '[data-action="add"]']) {
            const button = root.querySelector<HTMLButtonElement>(selector);
            if (button) button.disabled = busy;
        }
        // 弹窗里的输入框、取消/安装按钮（含「安装中」文案）都随 busy 变，直接按状态重绘这一段
        this.syncInstallDialog();
        for (const card of this.cards()) this.syncCardControls(card);
    }

    /**
     * 一张卡片的控件可用性：本地在等结果（pending）、全局操作进行中（busy）
     * 或启停由清单固定（system）时都禁用开关。
     */
    private syncCardControls(card: HTMLElement): void {
        const id = card.dataset.pluginId ?? '';
        const pending = this.pendingToggles.has(id);
        const locked = this.entries.find((entry) => entry.id === id)?.system === true;
        const toggle = card.querySelector<HTMLInputElement>('[data-action="toggle"]');
        if (toggle) toggle.disabled = this.busy || locked || pending;
        const uninstall = card.querySelector<HTMLButtonElement>('[data-action="uninstall"]');
        if (uninstall) uninstall.disabled = this.busy || pending;
    }

    /** 更新通知条：状态与所在区域一处改，整树渲染时由 noticeHtml 输出同一份标记 */
    private setNotice(text: string, error = false): void {
        this.notice = { text, error };
        this.paintRegion('notice', this.noticeHtml);
    }

    /**
     * 收走顶部通知条。
     *
     * 通知条只表达「最近一次操作的结果」：新操作一开始就把旧结果撤掉，
     * 否则用户点了开关之后，上一次安装失败的红条还会挂在那里像是这次的结果。
     */
    private clearNotice(): void {
        if (!this.notice) return;
        this.notice = undefined;
        this.paintRegion('notice', '');
    }

    /**
     * 叶子区域局部重绘：把一段 HTML 写进对应的 [data-region] 挂载点。
     *
     * 挂载点由 render() 固定输出，所以这里既不需要判断「元素在不在」，
     * 也不会像整树重绘那样牵连列表。
     */
    private paintRegion(region: LeafRegion, html: string): void {
        const host = this.shadowRoot?.querySelector(`[data-region="${region}"]`);
        if (host) host.innerHTML = html;
    }

    /** 安装弹窗的开关由 installDialogMode 决定：只重绘弹窗这一段，并补绑它自己的交互 */
    private syncInstallDialog(): void {
        this.paintRegion('install-dialog', this.renderInstallDialog());
        this.bindInstallDialogEvents();
    }

    /** 安装进度浮层的显隐由 installProgress 决定：同上，只重绘这一段 */
    private syncInstallProgress(): void {
        this.paintRegion('install-progress', this.renderInstallProgress());
    }

    /** 加号下拉只靠 visible 类控制显隐：改类即可，不必重建列表 */
    private syncAddDropdown(): void {
        this.shadowRoot?.querySelector('.add-dropdown')?.classList.toggle('visible', this.addMenuOpen);
    }

    /** 一张卡片的启停在等结果：开关位置换成转圈，控件先禁用 */
    private syncTogglePending(id: string): void {
        const card = this.findCard(id);
        if (!card) return;
        card.querySelector('.plugin-toggle')?.classList.toggle('is-pending', this.pendingToggles.has(id));
        this.syncCardControls(card);
    }

    private openInstallDialog(mode: InstallDialogMode): void {
        this.addMenuOpen = false;
        this.installDialogMode = mode;
        this.installSpec = '';
        this.syncAddDropdown();
        this.syncInstallDialog();
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
        this.syncInstallDialog();
    }

    private install(spec: string, successKey = 'plugin.install.success', source?: ManagedInstallSource): void {
        const normalizedSpec = spec.trim();
        if (!normalizedSpec) return;
        // 已有全局操作在跑：再进一次会把进度浮层与 busy 归属搞乱（收尾的 finally 会把在跑那次
        // 的浮层提前清掉），这里直接忽略后续触发
        if (this.busy) return;
        const startedAt = Date.now();
        if (source) {
            this.installProgress = { source, spec: normalizedSpec };
            this.installDialogMode = undefined;
            this.installSpec = '';
            this.syncInstallDialog();
            this.syncInstallProgress();
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
                // 按下安装后弹窗就该收起（列表组成变化时的整树重绘也会顺带把它关掉）
                this.installDialogMode = undefined;
                this.installSpec = '';
                this.syncInstallDialog();
            },
            // 宿主版本不满足的失败弹模态引导升级，不再发默认的系统通知
            (message) => {
                const issue = parsePluginHostVersionMessage(message);
                if (!issue) return false;
                void this.showInstallBlockedModal({
                    direction: issue.direction,
                    range: issue.range,
                    current: issue.hostVersion
                });
                return true;
            }
        );
        if (source) {
            void operation.finally(() => {
                this.installProgress = undefined;
                this.syncInstallProgress();
            });
        }
    }

    private async installFromDirectory(): Promise<void> {
        this.addMenuOpen = false;
        this.syncAddDropdown();
        const directory = await (window as unknown as { fsAPI?: PluginFileSystemAPI }).fsAPI?.selectDirectory?.();
        if (directory) this.install(directory, 'plugin.install.success', 'directory');
    }

    private async installFromFile(file?: File): Promise<void> {
        if (!file) return;
        try {
            const filePath = await (window as unknown as { fsAPI?: PluginFileSystemAPI }).fsAPI?.getFilePath?.(file);
            if (!filePath) {
                this.setNotice(this.t('plugin.center.filePathUnavailable'), true);
                return;
            }
            this.addMenuOpen = false;
            this.syncAddDropdown();
            this.install(filePath, 'plugin.install.success', 'package');
        } catch (error) {
            this.setNotice(error instanceof Error ? error.message : String(error), true);
        }
    }

    private async confirmAndUninstall(id: string, onSuccess?: () => void): Promise<void> {
        const { confirmed, checked } = await showConfirmModalWithCheckbox({
            icon: 'fa-trash-can',
            variant: 'danger',
            title: this.t('plugin.center.uninstallTitle'),
            message: escapeHtml(this.t('plugin.center.uninstallConfirm', { id })),
            confirmText: this.t('plugin.center.uninstall'),
            cancelText: this.t('plugin.center.cancel'),
            checkbox: {
                label: escapeHtml(this.t('plugin.center.uninstallRemoveData')),
                hint: escapeHtml(this.t('plugin.center.uninstallRemoveDataHint'))
            },
            mountTarget: this.shadowRoot!
        });
        if (!confirmed) return;
        // 等 run 真的跑完（含列表刷新）再返回：市场详情卸载后要立刻按新状态重绘
        await this.run(() => getAPI().callMainWorld('uninstall', id, checked), 'plugin.uninstall.success', onSuccess);
    }

    private statusOf(entry: PluginListEntry): string {
        if (!entry.enabled) return 'disabled';
        return entry.runtime?.status ?? 'disabled';
    }

    /**
     * 插件卡片图标：清单声明了 iconUrl 时用图片，否则按名字取色渲染首字母。
     *
     * 图片绝对定位盖在首字母上并带 onerror 自移除：图标链接失效时自然回退到首字母兜底，
     * 不需要额外的加载状态管理。
     */
    private renderCardIcon(name: string, iconUrl?: string): string {
        const color = getSkillPastel(name);
        const image = iconUrl
            ? `<img class="card-icon-img" src="${escapeHtml(iconUrl)}" alt="" loading="lazy" onerror="this.remove()">`
            : '';
        return `<div class="card-icon" style="background:${color.bg};color:${color.text}">
            <span class="card-icon-initial">${escapeHtml(getSkillInitial(name))}</span>${image}
        </div>`;
    }

    private renderCard(entry: PluginListEntry): string {
        const diagnostics = entry.runtime?.diagnostics ?? [];
        /** 该插件的启停还在等结果：开关换成转圈，等结果回来后再恢复 */
        const pending = this.pendingToggles.has(entry.id);
        /** 启停由清单固定：开关不可点击，悬停提示说明原因 */
        const locked = entry.system === true;
        const toggleTitle = locked
            ? this.t('plugin.center.systemLocked')
            : this.t(entry.enabled ? 'plugin.center.disable' : 'plugin.center.enable');
        /** 来源标记：内置插件显示「内置」，启停固定的插件紧跟一个「系统」 */
        const tags = [
            entry.source === 'builtin'
                ? `<span class="builtin-tag">${escapeHtml(this.t('plugin.center.builtinTag'))}</span>`
                : '',
            locked ? `<span class="system-tag">${escapeHtml(this.t('plugin.center.systemTag'))}</span>` : ''
        ].filter(Boolean);
        const name = this.pluginName(entry);
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
                ${this.renderCardIcon(name, entry.manifest?.iconUrl)}
                <div class="card-info">
                    <div class="name">${escapeHtml(name)}</div>
                    <div class="plugin-id">${escapeHtml(entry.id)}</div>
                </div>
            </div>
            ${contributionPills.length ? `<div class="contributions">${contributionPills.join('')}</div>` : ''}
            ${diagnostics
                .map((item) => `<div class="diagnostic">${escapeHtml(formatPluginDiagnostic(item, this.t))}</div>`)
                .join('')}
            <div class="card-footer">
                ${tags.length ? `<div class="plugin-tags">${tags.join('')}</div>` : ''}
                <label class="plugin-toggle${pending ? ' is-pending' : ''}${locked ? ' is-locked' : ''}" title="${escapeHtml(
                    toggleTitle
                )}" ${pending ? 'aria-busy="true"' : ''}>
                    <input type="checkbox" data-action="toggle" data-id="${escapeHtml(entry.id)}"
                        aria-label="${escapeHtml(toggleTitle)}"
                        ${entry.enabled ? 'checked' : ''} ${locked || pending || this.busy ? 'disabled' : ''}>
                    <span class="plugin-toggle-slider"></span>
                    <span class="plugin-toggle-spinner" aria-hidden="true"></span>
                </label>
                ${
                    entry.removable
                        ? `<button class="danger" data-action="uninstall" data-id="${escapeHtml(entry.id)}" ${pending || this.busy ? 'disabled' : ''}>${escapeHtml(this.t('plugin.center.uninstall'))}</button>`
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
        /** 基本信息：作者信息只在清单声明了才追加，避免详情里出现一排「-」 */
        const metadata: SkillDetailMetaItem[] = [
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
        ];
        const author = entry.manifest?.author;
        const authorName = resolvePluginDisplayName(author?.name, this.locale);
        const institution = resolvePluginLocalizedText(author?.institution, this.locale);
        if (authorName) metadata.push({ label: this.t('plugin.center.detail.author'), value: authorName });
        if (institution) metadata.push({ label: this.t('plugin.center.detail.institution'), value: institution });
        if (author?.homepage) {
            metadata.push({
                label: this.t('plugin.center.detail.authorHomepage'),
                value: author.homepage,
                href: author.homepage
            });
        }
        if (entry.manifest?.homepage) {
            metadata.push({
                label: this.t('plugin.center.detail.pluginHomepage'),
                value: entry.manifest.homepage,
                href: entry.manifest.homepage
            });
        }
        const model: SkillDetailCardModel = {
            id: entry.id,
            name,
            description: this.pluginDescription(entry),
            descriptionLabel: this.t('plugin.center.detail.description'),
            closeLabel: this.t('plugin.center.detail.close'),
            transition: this.returningFromAgent ? 'back' : undefined,
            metadataLabel: this.t('plugin.center.detail.basicInfo'),
            metadata,
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
                    variant: entry.enabled ? 'default' : 'primary',
                    // 启停由清单固定的插件（system）：按钮置灰不可点，原因写在左侧小字里
                    disabled: entry.system === true
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
            ],
            footerHint: entry.system === true ? this.t('plugin.center.systemDetailHint') : undefined
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

    // ── 插件市场 ────────────────────────────────────────────────────────────

    /**
     * 拉一次插件市场列表：每个市场在顶部占一个 Tab，所以首屏就要拿到它。
     *
     * 渠道配置变了（registriesChanged）会重新拉；当前停留的市场被删除或禁用时回落到「已安装」，
     * 还在的话重新拉一次它的清单——渠道地址可能被改过，留着旧市场的卡片只会装出别处的插件。
     */
    private async ensureMarketRegistries(force = false): Promise<void> {
        if (this.marketRegistriesLoading) return;
        if (!force && this.marketRegistries.length > 0) return;
        this.marketRegistriesLoading = true;
        let currentMarketSurvived = false;
        try {
            const registries = await getAPI().callMainWorld('listPluginRegistries');
            this.marketRegistries = Array.isArray(registries) ? registries : [];
            // 进入插件中心默认落在第一个市场（官方市场固定排最前）而不是「已安装」；
            // 首屏只应用一次，之后（含渠道变更触发的重拉）不再抢用户当前停留的 Tab
            if (!this.initialTabApplied) {
                this.initialTabApplied = true;
                const firstMarket = this.marketRegistries[0];
                if (firstMarket && this.activeTab === 'installed') {
                    this.activeTab = marketTabId(firstMarket.name);
                }
            }
            const current = this.currentMarket;
            if (current && !this.marketRegistries.some((item) => item.name === current)) {
                this.activeTab = 'installed';
                this.resetMarketCatalog();
            } else if (current) {
                currentMarketSurvived = true;
            }
        } catch (error) {
            // 市场列表只读本地渠道配置，失败通常是应用还没就绪：Tab 少几个不影响其它功能
            console.warn('Failed to list plugin registries:', error);
        } finally {
            this.marketRegistriesLoading = false;
            this.render();
        }
        // 不清缓存地重取一次：主进程已经按新配置重建过 registry，这里拿到的是新渠道的清单
        if (currentMarketSurvived) await this.loadMarketCatalog();
    }

    /** 切换 Tab；切到某个市场时才去拉它的清单（每个市场各自缓存，来回切不重复请求） */
    private async switchTab(target: PluginTab): Promise<void> {
        if (target === this.activeTab) return;
        // 详情属于当前市场里的某一条，切 Tab 后没有意义
        this.selectedMarketPluginId = undefined;
        this.activeTab = target;
        if (marketNameOfTab(target)) this.resetMarketCatalog();
        this.render();
        if (marketNameOfTab(target)) await this.loadMarketCatalog();
    }

    /**
     * 清空当前市场的清单与界面状态。
     *
     * 请求序号一起递增：上一个市场可能还有在途请求，切走后它的结果不能再写回界面。
     */
    private resetMarketCatalog(): void {
        this.marketCatalog = undefined;
        this.marketCatalogError = undefined;
        this.marketCatalogLoading = false;
        this.marketCategory = '';
        this.marketQuery = '';
        this.marketSearching = false;
        this.marketCatalogRequestId += 1;
    }

    /**
     * 拉当前市场的插件清单。
     *
     * 分类与关键词都交给主进程过滤：清单在主进程里有内存缓存，过滤只作用在已拉下来的
     * 数据上，切换分类/搜索既不会重复请求远端，界面里也不用维护第二份清单。
     */
    private async loadMarketCatalog(options: { forceRefresh?: boolean } = {}): Promise<void> {
        const registryName = this.currentMarket;
        if (!registryName) return;
        const requestId = ++this.marketCatalogRequestId;
        this.marketCatalogLoading = true;
        this.marketCatalogError = undefined;
        this.paintMarket();
        try {
            const catalog = await getAPI().callMainWorld(
                'getPluginCatalog',
                registryName,
                this.marketCategory ? [this.marketCategory] : undefined,
                this.marketQuery.trim(),
                options.forceRefresh === true
            );
            // 期间用户可能切了市场、换了分类或又搜了一次：只接受最后一次请求的结果
            if (requestId !== this.marketCatalogRequestId) return;
            this.marketCatalog = (catalog as PluginMarketCatalog | undefined) ?? undefined;
        } catch (error) {
            if (requestId !== this.marketCatalogRequestId) return;
            this.marketCatalogError = error instanceof Error ? error.message : String(error);
            this.marketCatalog = undefined;
        } finally {
            // 被更新请求接管时不要收尾：loading 与重绘都归最新那次请求管
            if (requestId === this.marketCatalogRequestId) {
                this.marketCatalogLoading = false;
                this.paintMarket();
                // 开着详情时（刷新 / 搜索后）让它跟着新清单走：这条没了会自己收起，
                // 还在的话版本号与安装状态也要按最新数据重画
                this.renderMarketPluginDetail();
            }
        }
    }

    /** 搜索：与技能中心一致，点搜索按钮或回车才查，查询期间按钮切成「搜索中…」 */
    private async searchMarket(): Promise<void> {
        if (!this.currentMarket || this.marketSearching) return;
        // 记下焦点是否在搜索框：搜索会重绘面板，重绘后要把它还回去
        this.marketFocusSearch =
            this.shadowRoot?.querySelector<HTMLInputElement>('[data-market-search]') === this.shadowRoot?.activeElement;
        this.marketSearching = true;
        this.paintMarket();
        try {
            await this.loadMarketCatalog();
        } finally {
            this.marketSearching = false;
            this.paintMarket();
        }
    }

    private clearMarketSearch(): void {
        if (!this.marketQuery) return;
        this.marketQuery = '';
        // 直接重拉而不是走 searchMarket：正在搜索时点清除也要生效，
        // 由请求序号保证在途的那次结果被丢弃
        void this.loadMarketCatalog();
    }

    private switchMarketCategory(category: string): void {
        if (this.marketCategory === category) return;
        this.marketCategory = category;
        void this.loadMarketCatalog();
    }

    /** 市场面板单独重绘：只替换市场那一段，不牵连已安装/内置列表的滚动与动画 */
    private paintMarket(): void {
        this.paintRegion('market', this.renderMarketPanel());
        this.bindMarketEvents();
        // 搜索引起的重绘结束后把焦点还给搜索框，并把光标放到末尾
        if (!this.marketFocusSearch) return;
        const input = this.shadowRoot?.querySelector<HTMLInputElement>('[data-market-search]');
        if (!input || input.disabled) return;
        this.marketFocusSearch = false;
        input.focus();
        input.setSelectionRange?.(input.value.length, input.value.length);
    }

    /** 当前市场 Tab 的面板内容；没有市场 Tab 时不该被渲染 */
    private renderMarketPanel(): string {
        const registryName = this.currentMarket;
        if (!registryName) return '';
        const registry = this.marketRegistries.find((item) => item.name === registryName);
        const label = registry?.displayName ?? registryName;
        const entries = this.marketCatalog?.entries ?? [];
        const filtered = Boolean(this.marketCategory) || Boolean(this.marketQuery.trim());
        // 搜索框右端：搜索/刷新期间就地显示转圈（与技能中心一致），否则显示结果数量。
        // 刷新时清单已经有内容，列表本身不会变成载入态，不给这一处反馈就等于点了没反应
        const countHtml = this.marketSearching
            ? `<span class="mini-spinner"></span>${escapeHtml(this.t('plugin.center.market.searching'))}`
            : this.marketCatalogLoading && this.marketCatalog
              ? `<span class="mini-spinner"></span>${escapeHtml(this.t('plugin.center.market.loadingCatalog'))}`
              : this.marketCatalog && !this.marketCatalogError
                ? escapeHtml(this.t('plugin.center.market.pluginCount', { count: entries.length }))
                : '';
        const searchBar = `<div class="search-bar">
            <div class="search-input-wrap${countHtml ? ' has-count' : ''}">
                <input type="text" class="search-input" data-market-search
                    placeholder="${escapeHtml(this.t('plugin.center.market.searchPlaceholder', { label }))}"
                    value="${escapeHtml(this.marketQuery)}" ${this.marketSearching ? 'disabled' : ''}>
                ${countHtml ? `<span class="search-count">${countHtml}</span>` : ''}
                <button type="button" class="search-clear" data-market-clear title="${escapeHtml(
                    this.t('plugin.center.market.clearSearch')
                )}">×</button>
            </div>
            <button type="button" class="search-btn" data-market-search-btn ${
                this.marketSearching ? 'disabled' : ''
            }>${escapeHtml(
                this.t(this.marketSearching ? 'plugin.center.market.searching' : 'plugin.center.market.search')
            )}</button>
            <button type="button" class="market-refresh-btn" data-market-refresh ${
                this.marketCatalogLoading ? 'disabled' : ''
            } title="${escapeHtml(this.t('plugin.center.market.refresh'))}" aria-label="${escapeHtml(
                this.t('plugin.center.market.refresh')
            )}">↻</button>
        </div>`;
        // 分类切换只在市场自述了 categories 时出现；没有该字段的市场就是不支持按分类显示
        const categories = this.marketCatalog?.categories ?? [];
        const categoryBar = categories.length
            ? `<div class="market-categories">${['', ...categories]
                  .map((category) => {
                      const active = this.marketCategory === category;
                      const text = category || this.t('plugin.center.market.all');
                      return `<button type="button" class="market-category${
                          active ? ' active' : ''
                      }" data-market-category="${escapeHtml(category)}">${escapeHtml(text)}</button>`;
                  })
                  .join('')}</div>`
            : '';
        return `<section class="installed-panel market-panel">${searchBar}${categoryBar}${this.renderMarketBody(
            entries,
            filtered
        )}</section>`;
    }

    private renderMarketBody(entries: PluginMarketEntry[], filtered: boolean): string {
        if (this.marketCatalogError) {
            return `<div class="empty-state">
                <div class="empty-icon">⚠️</div>
                <div class="empty-title">${escapeHtml(this.t('plugin.center.market.loadFailed'))}</div>
                <div class="empty-hint error-detail">${escapeHtml(this.marketCatalogError)}</div>
            </div>`;
        }
        // 载入态与技能中心一致：居中的圆环 + 一行文案，不用整块灰色卡片
        if (this.marketCatalogLoading && !this.marketCatalog) {
            return `<div class="loading-state">
                <div class="loading-spinner"></div>
                <span>${escapeHtml(this.t('plugin.center.market.loadingCatalog'))}</span>
            </div>`;
        }
        if (entries.length === 0) {
            const title = filtered
                ? this.t('plugin.center.market.noMatch')
                : this.t('plugin.center.market.emptyCatalog');
            const hint = filtered
                ? this.t('plugin.center.market.noMatchHint')
                : this.t('plugin.center.market.emptyCatalogHint');
            return `<div class="empty-state">
                <div class="empty-icon">🔍</div>
                <div class="empty-title">${escapeHtml(title)}</div>
                <div class="empty-hint">${escapeHtml(hint)}</div>
            </div>`;
        }
        return `<div class="market-grid">${entries.map((entry) => this.renderMarketCard(entry)).join('')}</div>`;
    }

    /**
     * 市场条目在当前机器上的状态：已安装 / 可更新 / 未安装，以及"装不了"的原因。
     *
     * 卡片与详情共用这一份判定，并且与主进程安装前的拦截同口径（见 ./catalog-common.js）：
     * 界面显示能装、点下去才被拒，是最容易让人困惑的组合。
     */
    private marketEntryState(entry: PluginMarketEntry): {
        installState: PluginMarketInstallState;
        installedVersion?: string;
        /** 装不了的原因（已本地化）；可安装时为 undefined */
        blockedReason?: string;
    } {
        const installedEntry = this.entries.find((item) => item.id === entry.id);
        const installedVersion = installedEntry?.manifest?.version ?? installedEntry?.runtime?.version;
        const installState = resolveMarketInstallState(installedEntry !== undefined, installedVersion, entry.version);
        // 内置插件优先：同 id 的包装不上，市场里直接说明，别等用户点下去才报错
        const blockedReason =
            installedEntry?.source === 'builtin'
                ? this.t('plugin.center.market.blockedBuiltinConflict')
                : !isHostVersionCompatible(entry)
                  ? this.t('plugin.center.market.blockedHostVersion', {
                        range: describeHostVersionRange(entry) ?? ''
                    })
                  : undefined;
        return { installState, installedVersion, blockedReason };
    }

    /**
     * 市场卡片的动作按钮文案：装不了 > 安装中 > 可更新（升级）> 已是最新 > 安装。
     *
     * 与测评集下载中心同语义：已安装且清单版本不更高时按钮显示「已是最新」并禁用，
     * 不再提供「重新安装」——重装应通过卸载后安装完成，避免用户误把最新版再覆盖一遍。
     */
    private marketActionLabel(
        state: { installState: PluginMarketInstallState; blockedReason?: string },
        installing: boolean
    ): string {
        if (installing) return this.t('plugin.center.market.installing');
        if (state.blockedReason) return this.t('plugin.center.market.installBlocked');
        if (state.installState === 'update-available') return this.t('plugin.center.market.update');
        if (state.installState === 'installed') return this.t('plugin.center.market.installed');
        return this.t('plugin.center.market.install');
    }

    /** 卡片底部的状态胶囊：可更新 / 已是最新 / 装不了；未安装且可安装时为空 */
    private marketStatePill(state: { installState: PluginMarketInstallState; blockedReason?: string }): string {
        if (state.blockedReason) {
            return `<span class="tag-pill tag-blocked" title="${escapeHtml(
                state.blockedReason
            )}">${escapeHtml(state.blockedReason)}</span>`;
        }
        if (state.installState === 'update-available') {
            return `<span class="tag-pill tag-update">${escapeHtml(this.t('plugin.center.market.updateAvailable'))}</span>`;
        }
        if (state.installState === 'installed') {
            return `<span class="tag-pill tag-installed">${escapeHtml(this.t('plugin.center.market.installed'))}</span>`;
        }
        return '';
    }

    /**
     * 市场里的插件卡片：结构与技能中心的卡片对齐（图标 + 名字/版本 + 作者 + 两行描述 + 底部胶囊/安装）。
     *
     * 插件名右侧的胶囊是版本号；作者行是 `@名字 (机构)`，作者给了主页时名字可点（系统浏览器打开）。
     */
    private renderMarketCard(entry: PluginMarketEntry): string {
        const name = resolvePluginDisplayName(entry.displayName, this.locale) ?? entry.id;
        const description = resolvePluginLocalizedText(entry.description, this.locale);
        const state = this.marketEntryState(entry);
        const progress = this.marketInstalls.get(entry.id);
        const installing = progress !== undefined;
        const percent = progressPercent(progress);
        const categoryPills = (entry.category ?? [])
            .map((category) => `<span class="tag-pill tag-category">${escapeHtml(category)}</span>`)
            .join('');
        // 已是最新（且未在安装中）时禁用主按钮，与详情弹窗的动作保持同一口径
        const disabled = installing || Boolean(state.blockedReason) || state.installState === 'installed';
        return `<div class="market-card" data-market-plugin="${escapeHtml(entry.id)}" role="button" tabindex="0">
            <div class="card-header">
                ${this.renderCardIcon(name, entry.iconUrl)}
                <div class="card-info">
                    <div class="card-title-row">
                        <span class="card-title">${escapeHtml(name)}</span>
                        ${entry.version ? `<span class="tag-pill tag-version">${escapeHtml(entry.version)}</span>` : ''}
                    </div>
                    ${this.renderMarketAuthor(entry)}
                </div>
            </div>
            ${description ? `<div class="card-desc">${escapeHtml(description)}</div>` : ''}
            ${
                installing
                    ? `<div class="market-progress" data-market-progress="${escapeHtml(entry.id)}">
                <div class="market-progress-track"><div class="market-progress-bar" style="width:${
                    percent === null ? 15 : percent
                }%"></div></div>
                <div class="market-progress-label">${escapeHtml(this.marketProgressLabel(progress))}</div>
            </div>`
                    : ''
            }
            <div class="card-footer">
                <div class="card-meta">${this.marketStatePill(state)}${categoryPills}</div>
                <button type="button" class="install-btn${installing ? ' installing' : ''}" data-market-install="${escapeHtml(
                    entry.id
                )}" ${disabled ? 'disabled' : ''}>${escapeHtml(this.marketActionLabel(state, installing))}</button>
            </div>
        </div>`;
    }

    /**
     * 市场条目的详情卡：与已安装插件的详情同一套组件（skill-detail-card），
     * 展示清单里声明的元数据，并把「安装 / 升级」作为主动作。
     */
    private renderMarketPluginDetail(): void {
        const pluginId = this.selectedMarketPluginId;
        if (!pluginId) return;
        const detail = this.shadowRoot?.querySelector<SkillDetailCard>('#market-detail-card');
        const entry = this.marketCatalog?.entries.find((item) => item.id === pluginId);
        if (!detail) return;
        if (!entry) {
            // 清单刷新后这条没了（市场换了一版）：连弹窗一起收起。只清状态是不够的——
            // 增量刷新不会重建整树，元素会带着上一版的数据继续挂在界面上。
            this.selectedMarketPluginId = undefined;
            detail.remove();
            return;
        }
        const name = resolvePluginDisplayName(entry.displayName, this.locale) ?? entry.id;
        const state = this.marketEntryState(entry);
        const installing = this.marketInstalls.has(entry.id);
        const statusLabel = state.blockedReason
            ? this.t('plugin.center.market.installBlocked')
            : state.installState === 'update-available'
              ? this.t('plugin.center.market.updateAvailable')
              : state.installState === 'installed'
                ? this.t('plugin.center.market.installed')
                : this.t('plugin.center.market.notInstalled');
        const metadata: SkillDetailMetaItem[] = [
            { label: this.t('plugin.center.detail.status'), value: statusLabel },
            { label: this.t('plugin.center.detail.version'), value: entry.version || '-' },
            { label: this.t('plugin.center.detail.pluginId'), value: entry.id }
        ];
        // 已安装且清单版本更高时把本地版本摆出来，用户才知道「可更新」是从哪一版开始算的
        if (state.installState === 'update-available' && state.installedVersion) {
            metadata.push({
                label: this.t('plugin.center.market.installedVersionLabel'),
                value: this.t('plugin.center.market.installedVersion', { version: state.installedVersion })
            });
        }
        if (state.blockedReason) {
            metadata.push({
                label: this.t('plugin.center.detail.blockedReason'),
                value: state.blockedReason
            });
        }
        if (entry.apiVersion !== undefined) {
            metadata.push({ label: this.t('plugin.center.detail.apiVersion'), value: String(entry.apiVersion) });
        }
        if (entry.category?.length) {
            metadata.push({
                label: this.t('plugin.center.detail.category'),
                value: entry.category.join(' · ')
            });
        }
        const authorName = resolvePluginDisplayName(entry.author?.name, this.locale);
        const institution = resolvePluginLocalizedText(entry.author?.institution, this.locale);
        if (authorName) metadata.push({ label: this.t('plugin.center.detail.author'), value: authorName });
        if (institution) metadata.push({ label: this.t('plugin.center.detail.institution'), value: institution });
        if (entry.author?.homepage) {
            metadata.push({
                label: this.t('plugin.center.detail.authorHomepage'),
                value: entry.author.homepage,
                href: entry.author.homepage
            });
        }
        if (entry.homepage) {
            metadata.push({
                label: this.t('plugin.center.detail.pluginHomepage'),
                value: entry.homepage,
                href: entry.homepage
            });
        }
        const theme =
            this.dataset.theme ||
            document.documentElement.dataset.theme ||
            this.closest('[data-theme]')?.getAttribute('data-theme');
        if (theme) detail.dataset.theme = theme;
        // 已装的插件在市场上打开详情时也要能卸载：否则用户想删掉它只能回到「已安装」再找一遍
        const installed = state.installState === 'installed' || state.installState === 'update-available';
        const actions: SkillDetailAction[] = [];
        if (installed) {
            actions.push({
                id: 'uninstall',
                label: this.t('plugin.center.uninstall'),
                variant: 'danger',
                disabled: installing
            });
        }
        actions.push({
            id: 'install',
            label: this.marketActionLabel(state, installing),
            variant: 'primary',
            disabled: installing || Boolean(state.blockedReason) || state.installState === 'installed'
        });
        detail.model = {
            id: entry.id,
            name,
            subtitle: entry.id,
            description: resolvePluginLocalizedText(entry.description, this.locale),
            descriptionLabel: this.t('plugin.center.detail.description'),
            closeLabel: this.t('plugin.center.detail.close'),
            metadataLabel: this.t('plugin.center.detail.basicInfo'),
            metadata,
            actions
        };
    }

    private bindMarketDetailActions(): void {
        const detail = this.shadowRoot?.querySelector<SkillDetailCard>('#market-detail-card');
        // 同一个 detail 元素只绑一次：市场局部重绘不会重建它，重复绑会让动作触发两次
        if (!detail || this.boundMarketDetailCards.has(detail)) return;
        this.boundMarketDetailCards.add(detail);
        detail.addEventListener('skill-detail-action', (event) => {
            const action = (event as CustomEvent<{ id: string }>).detail.id;
            if (action === 'close') {
                this.selectedMarketPluginId = undefined;
                this.render();
            } else if (action === 'install') {
                const pluginId = this.selectedMarketPluginId;
                if (pluginId) void this.installFromMarket(pluginId);
            } else if (action === 'uninstall') {
                const pluginId = this.selectedMarketPluginId;
                if (pluginId) void this.uninstallFromMarket(pluginId);
            }
        });
    }

    /**
     * 从市场详情里卸载插件。
     *
     * 卸载完不关详情：用户刚在市场上把它删掉，这里把状态就地刷成「未安装」比直接收起弹窗更清楚。
     */
    private async uninstallFromMarket(pluginId: string): Promise<void> {
        await this.confirmAndUninstall(pluginId);
        this.paintMarket();
        this.renderMarketPluginDetail();
    }

    private marketProgressLabel(progress: MarketInstallProgress): string {
        const percent = progressPercent(progress);
        return percent === null
            ? this.t('plugin.center.market.downloaded', { size: formatBytes(progress.received) })
            : this.t('plugin.center.market.downloading', { percent });
    }

    /** 下载进度只更新对应卡片的进度条：卡片本身不重绘，按钮的 disabled 状态也不闪 */
    private syncMarketInstallProgress(pluginId: string, received: number, total: number | null): void {
        const holder = Array.from(this.shadowRoot?.querySelectorAll<HTMLElement>('[data-market-progress]') ?? []).find(
            (element) => element.dataset.marketProgress === pluginId
        );
        if (!holder) return;
        const percent = progressPercent({ received, total });
        const bar = holder.querySelector<HTMLElement>('.market-progress-bar');
        if (bar) bar.style.width = `${percent === null ? 15 : percent}%`;
        const label = holder.querySelector<HTMLElement>('.market-progress-label');
        if (label) label.textContent = this.marketProgressLabel({ received, total });
    }

    /**
     * 从市场下载并安装插件。
     *
     * 下载走主进程的平台 fetch（继承代理设置），进度通过 marketInstallProgress 事件回传；
     * 安装成功后宿主会广播 pluginsChanged，已安装标记随之刷新。
     */
    private async installFromMarket(pluginId: string): Promise<void> {
        const registryName = this.currentMarket;
        if (!registryName || !pluginId || this.marketInstalls.has(pluginId)) return;
        // 与内置插件冲突 / 宿主版本不满足 / 已是最新的条目：按钮已经是禁用的，这里再挡一次，
        // 免得禁用态渲染出来之前的一次点击把注定失败（或不该发生的覆盖安装）跑起来
        const entry = this.marketCatalog?.entries.find((item) => item.id === pluginId);
        const entryState = entry ? this.marketEntryState(entry) : undefined;
        if (entryState?.blockedReason || entryState?.installState === 'installed') return;
        // 升级（清单版本高于本地）成功后的提示与全新安装区分开
        const wasUpgrade = entryState?.installState === 'update-available';
        this.clearNotice();
        this.marketInstalls.set(pluginId, { received: 0, total: null });
        this.paintMarket();
        // 详情弹窗开着时（用户从弹窗点的安装）它的按钮也要立刻变「安装中…」并禁用
        this.renderMarketPluginDetail();
        try {
            const outcome = (await getAPI().callMainWorld('installFromPluginRegistry', registryName, pluginId)) as
                PluginMarketInstallOutcome | undefined;
            // 落盘前的核对没过（包内清单与市场条目不一致），或插件要求的宿主版本不满足：
            // 两种失败都已经在主进程里中止、磁盘上什么都没变。这类问题用户需要看清原因，
            // 只弹模态弹窗——提示条会和弹窗重复一遍同样的长文案，反而把页面顶部的市场信息挤下去
            if (outcome && outcome.success === false) {
                if (outcome.code === 'host_version') {
                    // 弹窗不 await：先让 finally 把进度条收掉、刷新列表，别让卡片一直停在「安装中」
                    void this.showInstallBlockedModal(outcome);
                } else {
                    void this.showMarketInstallMismatch(outcome.message);
                }
                return;
            }
            this.notifyOperationResult(
                this.t(
                    wasUpgrade ? 'plugin.center.market.updateSuccessTitle' : 'plugin.center.market.installSuccessTitle'
                ),
                this.t('plugin.install.successDetail', { name: this.pluginDisplayName(pluginId) }),
                false
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.notifyMarketInstallFailure(message);
        } finally {
            this.marketInstalls.delete(pluginId);
            await this.refreshEntries();
            this.paintMarket();
            // 详情弹窗若开着，按钮文案与状态行也要跟着变
            this.renderMarketPluginDetail();
        }
    }

    /**
     * 「上架信息与包内清单不一致」的模态提醒。
     *
     * 这类失败不是网络问题，而是「市场说的和包里装的对不上」——继续装下去用户拿到的插件
     * 与描述不符，所以安装已经在主进程侧中止。界面只用模态弹窗反馈（不再同时写一条提示条），
     * 因此弹窗本身失败时必须把原因退回提示条，否则用户什么都看不到。
     */
    private async showMarketInstallMismatch(message: string): Promise<void> {
        try {
            await showConfirmModal({
                variant: 'warn',
                title: this.t('plugin.center.market.manifestMismatchTitle'),
                message: escapeHtml(message),
                confirmText: this.t('common.close'),
                cancelText: null
            });
        } catch {
            this.setNotice(message, true);
        }
    }

    /**
     * 「宿主版本不满足，无法安装」的模态提醒。
     *
     * 本地安装（目录 / zip / npm）与市场安装共用：安装已经在主进程侧被宿主版本闸门拒绝，
     * 磁盘上什么都没变。弹窗按不满足的方向给出可操作建议——宿主过低时引导升级 OpenDesk，
     * 宿主过高时引导寻找支持当前版本的插件。弹窗失败时退回提示条，保证用户至少能看到原因。
     */
    private async showInstallBlockedModal(issue: {
        direction: 'too_old' | 'too_new';
        range: string;
        current: string;
    }): Promise<void> {
        const message = this.t(
            issue.direction === 'too_old'
                ? 'plugin.center.market.installBlockedTooOld'
                : 'plugin.center.market.installBlockedTooNew',
            { range: issue.range, current: issue.current }
        );
        try {
            await showConfirmModal({
                variant: 'warn',
                icon: 'fa-triangle-exclamation',
                title: this.t('plugin.center.market.installBlockedTitle'),
                message: escapeHtml(message),
                confirmText: this.t('common.close'),
                cancelText: null,
                mountTarget: this.shadowRoot!
            });
        } catch {
            this.setNotice(message, true);
        }
    }

    /**
     * 市场安装失败时补一条系统通知。
     *
     * 安装要下载几十兆的包，用户常常切到别的应用去等：失败原因只留在页面提示条上等于没反馈，
     * 所以这里把原因一并推到通知中心。通知只是反馈，接口不可用时静默跳过。
     */
    private notifyMarketInstallFailure(message: string): void {
        try {
            void getAPI()
                .callMainWorld(
                    'sendNotification',
                    'error',
                    this.t('plugin.app.name'),
                    this.t('plugin.center.market.installFailedTitle'),
                    message
                )
                .catch(() => undefined);
        } catch {
            /* applicationAPI 不可用时静默跳过 */
        }
    }

    /**
     * 操作结果推一条系统通知。
     *
     * 安装 / 卸载这类操作可能跑几十秒，用户常常切到别的应用去等；页面里的提示条既看不到，
     * 详情弹窗打开时还会被盖住。通知只是反馈，接口不可用时静默跳过。
     */
    private notifyOperationResult(title: string, message: string, error: boolean): void {
        try {
            void getAPI()
                .callMainWorld('sendNotification', error ? 'error' : 'info', this.t('plugin.app.name'), title, message)
                .catch(() => undefined);
        } catch {
            /* applicationAPI 不可用时静默跳过 */
        }
    }

    private bindMarketEvents(): void {
        const root = this.shadowRoot?.querySelector('[data-region="market"]');
        if (!root) return;
        // 点卡片看详情（安装按钮与作者链接有自己的行为，不触发详情）
        root.querySelectorAll<HTMLElement>('[data-market-plugin]').forEach((card) => {
            const open = (event: Event) => {
                if ((event.target as Element).closest('button, a')) return;
                const pluginId = card.dataset.marketPlugin;
                if (!pluginId) return;
                this.selectedMarketPluginId = pluginId;
                // 与已安装插件的详情互斥，避免同时挂两个详情弹窗
                this.selectedPluginId = undefined;
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
        root.querySelector('[data-market-refresh]')?.addEventListener(
            'click',
            () => void this.loadMarketCatalog({ forceRefresh: true })
        );
        root.querySelectorAll<HTMLElement>('[data-market-category]').forEach((button) => {
            button.addEventListener('click', () => this.switchMarketCategory(button.dataset.marketCategory ?? ''));
        });
        const input = root.querySelector<HTMLInputElement>('[data-market-search]');
        if (input) {
            input.addEventListener('input', () => {
                this.marketQuery = input.value;
            });
            input.addEventListener('keydown', (event) => {
                const keyboardEvent = event as KeyboardEvent;
                if (keyboardEvent.key !== 'Enter' || keyboardEvent.isComposing) return;
                void this.searchMarket();
            });
        }
        root.querySelector('[data-market-search-btn]')?.addEventListener('click', () => void this.searchMarket());
        root.querySelector('[data-market-clear]')?.addEventListener('click', () => this.clearMarketSearch());
        root.querySelectorAll<HTMLElement>('[data-market-install]').forEach((button) => {
            button.addEventListener('click', () => void this.installFromMarket(button.dataset.marketInstall ?? ''));
        });
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
        // 整树重建会让面板回到顶部：先记下各面板的滚动位置，重建完再恢复
        const panelScrollTops = this.capturePanelScrollTops();
        // 详情浮层不从字符串重建：安装 / 卸载会改变列表组成、触发整树重绘，
        // 若把弹窗一起销毁重建，入场动画会从头再播一遍——看起来就是"关掉又打开"。
        // 同一个插件 / 同一条市场条目的弹窗直接把原元素复挂回去（见 mountDetailCards）。
        const cachedPluginDetail = this.shadowRoot?.querySelector<SkillDetailCard>('#plugin-detail-card') ?? undefined;
        const cachedMarketDetail = this.shadowRoot?.querySelector<SkillDetailCard>('#market-detail-card') ?? undefined;
        syncShadowHostTheme(
            this,
            (this.dataset.theme ||
                document.documentElement.dataset.theme ||
                this.closest('[data-theme]')?.getAttribute('data-theme')) as ThemeAppearance | undefined
        );
        const builtinEntries = this.entries.filter((entry) => entry.source === 'builtin');
        const installedEntries = this.entries.filter((entry) => entry.source !== 'builtin');
        this.shadowRoot!.innerHTML = `<style>${STYLE}</style>
            <div class="shell">
                <header class="header-area">
                    <div class="header-title">${escapeHtml(this.t('plugin.app.name'))}</div>
                    <div class="seg-row">
                        <div class="seg-control">
                            ${this.marketRegistries
                                .map((registry) => {
                                    const tabId = marketTabId(registry.name);
                                    const label = registry.displayName || registry.name;
                                    return `<button type="button" class="seg-item ${
                                        this.activeTab === tabId ? 'active' : ''
                                    }" data-tab="${escapeHtml(tabId)}" title="${escapeHtml(label)}">
                                <span class="seg-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9h18"/><path d="M4.5 9V6.5A2.5 2.5 0 0 1 7 4h10a2.5 2.5 0 0 1 2.5 2.5V9"/><path d="M4 9v9.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V9"/><path d="M9.5 13h5"/></svg></span>${escapeHtml(
                                    label
                                )}
                            </button>`;
                                })
                                .join('')}
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
                            <button type="button" class="action-btn" data-action="refresh" title="${escapeHtml(this.t('plugin.center.refresh'))}" aria-label="${escapeHtml(this.t('plugin.center.refresh'))}" ${this.busy ? 'disabled' : ''}>↻</button>
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
                                        <button type="button" class="add-dropdown-item" data-action="reload-runtime" ${this.busy ? 'disabled' : ''}>
                                            <span class="icon reload"><svg viewBox="0 0 24 24"><g class="k"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></g></svg></span>
                                            <span class="item-info"><span class="item-name">${escapeHtml(this.t('plugin.center.reloadRuntime'))}</span><span class="item-hint">${escapeHtml(this.t('plugin.center.reloadRuntimeHint'))}</span></span>
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </header>
                <div data-region="notice">${this.noticeHtml}</div>
                <div class="content">
                    <div class="tab-panel" data-panel="installed" ${this.activeTab === 'installed' ? '' : 'hidden'}>${this.renderInstalledPanel(installedEntries)}</div>
                    <div class="tab-panel" data-panel="builtin" ${this.activeTab === 'builtin' ? '' : 'hidden'}>${this.renderInstalledPanel(builtinEntries)}</div>
                    ${this.marketRegistries
                        .map((registry) => {
                            const tabId = marketTabId(registry.name);
                            const active = this.activeTab === tabId;
                            // 只有当前市场才渲染内容：切 Tab 会整树重绘，其它市场留空面板
                            return `<div class="tab-panel" data-panel="${escapeHtml(tabId)}" ${
                                active ? '' : 'hidden'
                            }>${active ? `<div data-region="market">${this.renderMarketPanel()}</div>` : ''}</div>`;
                        })
                        .join('')}
                </div>
                <div data-region="install-dialog">${this.renderInstallDialog()}</div>
                <div data-region="install-progress">${this.renderInstallProgress()}</div>
            </div>
            <div data-detail-mount="plugin"></div>
            <div data-detail-mount="market"></div>`;
        this.mountDetailCards({ plugin: cachedPluginDetail, market: cachedMarketDetail });
        this.bindEvents();
        this.restorePanelScrollTops(panelScrollTops);
        this.renderPluginDetail();
        this.bindDetailActions();
        this.renderMarketPluginDetail();
        this.bindMarketDetailActions();
    }

    /** 各 tab 面板当前的滚动位置（按 data-panel 记录，只存非零值） */
    /**
     * 把详情浮层挂到整树重绘后的挂载点上。
     *
     * 指向同一条目的弹窗**复用旧元素**：整树重绘只是换了外面的 shell，弹窗本身没必要重建。
     * 复挂时会关掉入场动画（见 SkillDetailCard.suppressEnterAnimation），否则元素被移出文档
     * 再插回去，fade-in / dialog-in 会重播一次——表现就是弹窗"闪一下"。
     * 换成另一个条目时仍新建元素，入场动画照常。
     */
    private mountDetailCards(cached: { plugin?: SkillDetailCard; market?: SkillDetailCard }): void {
        const mountInto = (region: 'plugin' | 'market', id: string, targetId: string, cachedCard?: SkillDetailCard) => {
            const host = this.shadowRoot?.querySelector(`[data-detail-mount="${region}"]`);
            if (!host) return;
            const reusable = cachedCard?.dataset.detailTarget === targetId ? cachedCard : undefined;
            const card = reusable ?? (document.createElement('skill-detail-card') as SkillDetailCard);
            card.id = id;
            card.dataset.detailTarget = targetId;
            if (reusable) reusable.suppressEnterAnimation();
            host.append(card);
        };
        if (this.selectedPluginId) {
            mountInto('plugin', 'plugin-detail-card', this.selectedPluginId, cached.plugin);
        }
        if (this.selectedMarketPluginId) {
            mountInto('market', 'market-detail-card', this.selectedMarketPluginId, cached.market);
        }
    }

    private capturePanelScrollTops(): Map<string, number> {
        const tops = new Map<string, number>();
        this.shadowRoot?.querySelectorAll<HTMLElement>('.tab-panel').forEach((panel) => {
            if (panel.dataset.panel && panel.scrollTop) tops.set(panel.dataset.panel, panel.scrollTop);
        });
        return tops;
    }

    private restorePanelScrollTops(tops: Map<string, number>): void {
        if (tops.size === 0) return;
        this.shadowRoot?.querySelectorAll<HTMLElement>('.tab-panel').forEach((panel) => {
            const top = panel.dataset.panel ? tops.get(panel.dataset.panel) : 0;
            if (top) panel.scrollTop = top;
        });
    }

    /** 通知条标记：整树渲染与区域重绘共用同一份，避免两处文案/样式漂移 */
    private get noticeHtml(): string {
        if (!this.notice) return '';
        return `<div class="notice${this.notice.error ? ' error' : ''}">${escapeHtml(this.notice.text)}</div>`;
    }

    private bindDetailActions(): void {
        const detail = this.shadowRoot?.querySelector<SkillDetailCard>('#plugin-detail-card');
        // 同一个 detail 元素只绑一次：增量刷新不会重建详情元素，重复绑会让一个动作触发两次。
        // 动作处理一律在事件发生时现取 entry，避免闭包捕获到刷新前的旧数据
        if (!detail || this.boundDetailCards.has(detail)) return;
        this.boundDetailCards.add(detail);
        detail.addEventListener('skill-detail-action', (event) => {
            const entry = this.entries.find((candidate) => candidate.id === this.selectedPluginId);
            if (!entry) return;
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
                // 与卡片上的开关共用同一条路径：单卡片 pending、增量刷新、系统通知反馈
                void this.togglePlugin(entry.id, !entry.enabled);
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
                if (!target) return;
                if (target !== 'builtin' && target !== 'installed' && !marketNameOfTab(target)) return;
                void this.switchTab(target as PluginTab);
            });
        });
        this.shadowRoot?.querySelector('[data-action="add"]')?.addEventListener('click', (event) => {
            event.stopPropagation();
            this.addMenuOpen = !this.addMenuOpen;
            this.syncAddDropdown();
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
        this.shadowRoot?.querySelector('.shell')?.addEventListener('click', (event) => {
            if (this.addMenuOpen && !(event.target as Element).closest('.add-dropdown-anchor')) {
                this.addMenuOpen = false;
                this.syncAddDropdown();
            }
        });
        this.shadowRoot?.querySelector('[data-action="refresh"]')?.addEventListener('click', () => {
            void this.refreshFromHeader();
        });
        this.shadowRoot?.querySelector('[data-action="reload-runtime"]')?.addEventListener('click', () => {
            this.addMenuOpen = false;
            this.syncAddDropdown();
            void this.run(() => getAPI().callMainWorld('reload'), 'plugin.runtime.reload.success');
        });
        this.shadowRoot?.querySelectorAll<HTMLElement>('[data-plugin-id]').forEach((card) => this.bindCardEvents(card));
        this.bindInstallDialogEvents();
        this.bindMarketEvents();
    }

    /**
     * 绑定安装弹窗自己的交互。
     *
     * 弹窗是独立叶子区域（见 paintRegion），打开/关闭时只重绘那一段，所以要在这里单独补绑，
     * 不能指望 bindEvents 每次都跑一遍。
     */
    private bindInstallDialogEvents(): void {
        const root = this.shadowRoot;
        root?.querySelector<HTMLInputElement>('input[name="spec"]')?.addEventListener('input', (event) => {
            this.installSpec = (event.currentTarget as HTMLInputElement).value;
        });
        root?.querySelector('[data-install-form]')?.addEventListener('submit', (event) => {
            event.preventDefault();
            this.install(this.installSpec, 'plugin.install.success', this.installDialogMode);
        });
        root?.querySelector('[data-action="cancel-install"]')?.addEventListener('click', () => {
            this.closeInstallDialog();
        });
        root?.querySelector('[data-install-dialog]')?.addEventListener('click', (event) => {
            if (event.target === event.currentTarget) this.closeInstallDialog();
        });
    }

    /**
     * 绑定一张卡片的交互：打开详情、启停开关、卸载。
     *
     * 单独抽出来是因为增量刷新会用新节点替换单张卡片（见 syncCard），那里只需要补绑这一张，
     * 不能重跑 bindEvents —— 否则其它卡片上的监听会被重复注册。
     */
    private bindCardEvents(card: HTMLElement): void {
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
        const toggle = card.querySelector<HTMLInputElement>('[data-action="toggle"]');
        if (toggle) {
            toggle.addEventListener('change', () => {
                const id = toggle.dataset.id;
                const entry = id ? this.entries.find((candidate) => candidate.id === id) : undefined;
                if (!id || !entry) return;
                if (this.pendingToggles.has(id)) {
                    // 这张卡片的结果还没回来：保持开关显示为原状态，等刷新后再接受新的点击
                    toggle.checked = entry.enabled;
                    return;
                }
                void this.togglePlugin(id, toggle.checked);
            });
        }
        const uninstall = card.querySelector<HTMLElement>('[data-action="uninstall"]');
        if (uninstall) {
            uninstall.addEventListener('click', () => {
                const id = uninstall.dataset.id;
                if (id) void this.confirmAndUninstall(id);
            });
        }
    }
}

if (!customElements.get('pluginmgr-entry-widget')) {
    customElements.define('pluginmgr-entry-widget', PluginMgrEntryWidget);
}
