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

/**
 * AgentGate Floating Window — 安全网关浮窗组件
 *
 * 显示 AgentGate 的拦截/放行记录，支持：
 *   - 鼠标悬停展开显示更多记录
 *   - 用户自定义透明度
 *   - 点击记录跳转到 AgentGate Dashboard
 *   - 配置开关（显示/隐藏浮窗）
 *
 * 参考 jiuwenswarm-fb 的 SecurityFloatingWindow React 组件，
 * 改造为 OpenDesk 的 Web Component + Shadow DOM 模式。
 */

// ── i18n ──────────────────────────────────────────────────────────────────
const T = {
    floatingTitle: { zh: '安全网关', en: 'AgentGate' },
    floatingWindowSwitch: { zh: '显示浮窗', en: 'Show Floating Window' },
    securityGatewaySwitch: { zh: '安全网关', en: 'Security Gateway' },
    maliciousSkillSwitch: { zh: '恶意技能检测', en: 'Malicious Skill Detection' },
    floatingWindowOpacity: { zh: '透明度', en: 'Opacity' },
    floatingWindowResetPosition: { zh: '重置初始位置', en: 'Reset Position' },
    floatingWindowDetail: { zh: '详情', en: 'Details' },
    floatingWindowPin: { zh: '固定', en: 'Pin' },
    floatingWindowCollapse: { zh: '收起', en: 'Collapse' },
    floatingWindowNoRecords: { zh: '暂无记录', en: 'No records' },
    floatingWindowLoading: { zh: '加载中...', en: 'Loading...' },
    floatingWindowProtected: { zh: '保护中', en: 'Protecting' },
    floatingWindowOff: { zh: '已关闭', en: 'Off' },
    floatingWindowBlocked: { zh: '已拦截', en: 'Blocked' },
    floatingWindowAllowed: { zh: '已放行', en: 'Allowed' },
    floatingWindowRecords: { zh: '条记录', en: 'records' },
    floatingWindowViewMore: { zh: '查看更多...', en: 'View more...' },
    riskCritical: { zh: '极危', en: 'Critical' },
    riskHigh: { zh: '高危', en: 'High' },
    riskMedium: { zh: '中危', en: 'Medium' },
    riskLow: { zh: '低危', en: 'Low' }
};

// 当前 locale 状态（从 setting 同步）
let _floatingLocale = null; // 'zh-CN' | 'en-US' | null

async function resolveFloatingLocale() {
    try {
        const data = await window.settingAPI?.loadSettingObject();
        if (data) {
            const loc = data.locale || data.resolved_locale;
            if (loc && loc !== 'auto') {
                _floatingLocale = loc;
                return;
            }
            if (data.resolved_locale) {
                _floatingLocale = data.resolved_locale;
                return;
            }
        }
    } catch {}
    // fallback: navigator
    _floatingLocale = navigator.language?.startsWith('zh') ? 'zh-CN' : 'en-US';
}

function isZh() {
    if (_floatingLocale) return _floatingLocale.startsWith('zh');
    const navLang = navigator.language;
    if (navLang?.startsWith('zh')) return true;
    return true; // 默认中文
}

function t(key) {
    const entry = T[key];
    if (!entry) return key;
    return isZh() ? entry.zh : entry.en;
}

function getEffectiveTheme() {
    return document.documentElement.dataset.theme || 'light';
}

// ── CSS (Shadow DOM 内联) ──────────────────────────────────────────────
const CSS = `
:host {
    display: block;
    font-family: var(--font-sans);
    font-size: 13px;
    line-height: 1.4;
    color-scheme: light dark;
}

button, input, select, option, optgroup, textarea { font-family: inherit; }

.agentgate-floating {
    position: fixed;
    /* 默认位置由 _restorePosition() 动态计算：会话界面顶部居中 */
    z-index: 80;
    width: 320px;
    max-width: calc(100vw - 32px);
    overflow: hidden;
    border: 1px solid rgba(200, 200, 210, 0.72);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.72);
    box-shadow: 0 18px 42px rgba(15, 23, 42, 0.18);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    opacity: var(--floating-opacity, 0.76);
    transition: width 0.25s ease, opacity 0.15s ease, box-shadow 0.15s ease;
    user-select: none;
}

:host([data-theme="dark"]) .agentgate-floating {
    background: rgba(30, 30, 40, 0.72);
    border-color: rgba(80, 80, 90, 0.72);
}

.agentgate-floating:hover,
.agentgate-floating:focus-within,
.agentgate-floating.is-auto-expanded,
.agentgate-floating.is-pinned {
    width: 456px;
    opacity: var(--floating-opacity-hover, 0.9);
    box-shadow: 0 24px 58px rgba(15, 23, 42, 0.22);
}

/* ── Header ── */
.floating-header {
    min-height: 40px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px;
    border-bottom: 1px solid rgba(200, 200, 210, 0.7);
    cursor: grab;
}

.floating-header:active {
    cursor: grabbing;
}

:host([data-theme="dark"]) .floating-header {
    border-bottom-color: rgba(80, 80, 90, 0.7);
}

.floating-title {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-weight: 760;
    color: inherit;
    flex: 0 0 auto;
    /* 未展开时不被右侧内容压缩（右侧 count-tag 4 位数字变宽时，
       title 的 overflow:hidden 会裁掉 moss 指示灯 → 指示灯消失。
       flex:0 0 auto 让 title 盾牌+指示灯区不被压，压缩交给 actions 内部消化） */
    overflow: hidden;
}

.floating-title-label {
    overflow: hidden;
    white-space: nowrap;
    max-width: 0;
    opacity: 0;
    transition: max-width 0.25s ease, opacity 0.15s ease;
}

.agentgate-floating:hover .floating-title-label,
.agentgate-floating:focus-within .floating-title-label,
.agentgate-floating.is-auto-expanded .floating-title-label,
.agentgate-floating.is-pinned .floating-title-label {
    max-width: 80px;
    opacity: 1;
}

.floating-title svg {
    flex: 0 0 auto;
    color: #22c55e;
}

:host([data-theme="dark"]) .floating-title svg {
    color: #4ade80;
}

.floating-actions {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    flex: 1 1 auto;
    min-width: 0;
}

.floating-detail-link {
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    padding: 0 8px;
    border: 1px solid rgba(200, 200, 210, 0.78);
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.62);
    color: inherit;
    font-size: 12px;
    font-weight: 700;
    text-decoration: none;
    cursor: pointer;
    transition: background 0.15s ease;
}

/* ── Collapse Button ── */
.floating-collapse-btn {
    height: 24px;
    display: none;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    padding: 0 6px;
    border: 1px solid rgba(200, 200, 210, 0.78);
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.62);
    color: inherit;
    font-size: 11px;
    font-weight: 700;
    cursor: pointer;
    transition: background 0.15s ease;
}

:host([data-theme="dark"]) .floating-collapse-btn {
    background: rgba(30, 30, 40, 0.62);
    border-color: rgba(80, 80, 90, 0.78);
}

.floating-collapse-btn:hover {
    background: rgba(255, 255, 255, 0.82);
}

:host([data-theme="dark"]) .floating-collapse-btn:hover {
    background: rgba(30, 30, 40, 0.82);
}

/* pinned 状态时按钮高亮，提示用户当前已固定 */
.agentgate-floating.is-pinned .floating-collapse-btn {
    background: rgba(0, 122, 255, 0.15);
    border-color: rgba(0, 122, 255, 0.6);
    color: #007AFF;
}

:host([data-theme="dark"]) .agentgate-floating.is-pinned .floating-collapse-btn {
    background: rgba(0, 122, 255, 0.2);
    border-color: rgba(0, 122, 255, 0.5);
    color: #4da3ff;
}

/* 展开状态（hover/auto-expand/focus-within/pinned）时显示按钮 */
.agentgate-floating:hover .floating-collapse-btn,
.agentgate-floating:focus-within .floating-collapse-btn,
.agentgate-floating.is-auto-expanded .floating-collapse-btn,
.agentgate-floating.is-pinned .floating-collapse-btn {
    display: inline-flex;
}

:host([data-theme="dark"]) .floating-detail-link {
    background: rgba(30, 30, 40, 0.62);
    border-color: rgba(80, 80, 90, 0.78);
}

.floating-detail-link:hover {
    background: rgba(255, 255, 255, 0.82);
}

:host([data-theme="dark"]) .floating-detail-link:hover {
    background: rgba(30, 30, 40, 0.82);
}

.status-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 52px;
    height: 24px;
    padding: 0 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 650;
    white-space: nowrap;
}

.status-badge.is-active {
    background: #e6efff;
    color: #2563eb;
}

:host([data-theme="dark"]) .status-badge.is-active {
    background: rgba(37, 99, 235, 0.2);
    color: #60a5fa;
}

.status-badge.is-off {
    background: #eef0f3;
    color: #6b7280;
}

:host([data-theme="dark"]) .status-badge.is-off {
    background: rgba(156, 163, 175, 0.18);
    color: #9ca3af;
}

.event-count {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: 0 0 auto;
    font-size: 12px;
    font-weight: 760;
    color: inherit;
}

/* Moss health indicator dot — 置于 floating-title 内盾牌之后，紧贴盾牌。
   title 已 flex:0 0 auto 不可压缩，overflow:hidden 不会裁掉它。
   margin-left 负值抵消 title gap(8px)，让指示灯贴近盾牌而非被 gap 推远。 */
.moss-health-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-left: -3px;
    background: #9CA3AF;
    vertical-align: middle;
    flex: 0 0 auto;
}
.moss-health-dot.ok {
    background: #22C55E;
    box-shadow: 0 0 6px rgba(34, 197, 94, 0.5);
}
.moss-health-dot.err {
    background: #EF4444;
    box-shadow: 0 0 6px rgba(239, 68, 68, 0.5);
}
.moss-health-dot.warn {
    background: #EAB308;
    box-shadow: 0 0 6px rgba(234, 179, 8, 0.5);
}

.count-tag {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 20px;
    height: 18px;
    padding: 0 5px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1;
}

.count-tag--total {
    background: rgba(100, 116, 139, 0.10);
    color: rgba(100, 116, 139, 1);
}

:host([data-theme="dark"]) .count-tag--total {
    background: rgba(148, 163, 184, 0.10);
    color: rgba(148, 163, 184, 1);
}

.count-tag--deny {
    background: rgba(239, 68, 68, 0.10);
    color: #ef4444;
}

:host([data-theme="dark"]) .count-tag--deny {
    background: rgba(255, 69, 58, 0.12);
    color: #ff453a;
}

.count-tag--allow {
    background: rgba(34, 197, 94, 0.10);
    color: #22c55e;
}

:host([data-theme="dark"]) .count-tag--allow {
    background: rgba(48, 209, 88, 0.12);
    color: #30d158;
}

.settings-btn {
    height: 24px;
    width: 24px;
    display: none;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 6px;
    background: rgba(200, 200, 210, 0.3);
    color: inherit;
    font-size: 14px;
    cursor: pointer;
    transition: background 0.15s ease;
}

.agentgate-floating:hover .settings-btn,
.agentgate-floating:focus-within .settings-btn,
.agentgate-floating.is-auto-expanded .settings-btn,
.agentgate-floating.is-pinned .settings-btn {
    display: inline-flex;
}

:host([data-theme="dark"]) .settings-btn {
    background: rgba(80, 80, 90, 0.3);
}

.settings-btn:hover {
    background: rgba(200, 200, 210, 0.5);
}

:host([data-theme="dark"]) .settings-btn:hover {
    background: rgba(80, 80, 90, 0.5);
}

/* ── Records ── */
.floating-records {
    max-height: 0;
    overflow-y: auto;
    opacity: 0;
    border-top: 1px solid transparent;
    transition: max-height 0.25s ease, opacity 0.15s ease, border-top-color 0.15s ease;
}

.agentgate-floating:hover .floating-records,
.agentgate-floating:focus-within .floating-records,
.agentgate-floating.is-auto-expanded .floating-records,
.agentgate-floating.is-pinned .floating-records {
    max-height: 240px;
    opacity: 1;
    border-top-color: rgba(200, 200, 210, 0.7);
}

:host([data-theme="dark"]) .agentgate-floating:hover .floating-records,
:host([data-theme="dark"]) .agentgate-floating:focus-within .floating-records,
:host([data-theme="dark"]) .agentgate-floating.is-auto-expanded .floating-records,
:host([data-theme="dark"]) .agentgate-floating.is-pinned .floating-records {
    border-top-color: rgba(80, 80, 90, 0.7);
}

:host([data-theme="dark"]) .agentgate-floating:hover .floating-records,
:host([data-theme="dark"]) .agentgate-floating:focus-within .floating-records {
    border-top-color: rgba(80, 80, 90, 0.7);
}

.floating-record {
    min-height: 52px;
    padding: 8px 12px 9px;
    border-bottom: 1px solid rgba(200, 200, 210, 0.72);
    cursor: pointer;
    transition: background 0.15s ease;
}

:host([data-theme="dark"]) .floating-record {
    border-bottom-color: rgba(80, 80, 90, 0.72);
}

.floating-record:hover {
    background: rgba(15, 23, 42, 0.04);
}

:host([data-theme="dark"]) .floating-record:hover {
    background: rgba(255, 255, 255, 0.04);
}

/* ── New-event highlight ── */
.floating-record.is-new {
    background: rgba(34, 197, 94, 0.08);
    animation: floating-new-highlight 5s ease-out forwards;
}

:host([data-theme="dark"]) .floating-record.is-new {
    background: rgba(74, 222, 128, 0.10);
    animation: floating-new-highlight-dark 5s ease-out forwards;
}

@keyframes floating-new-highlight {
    0%   { background: rgba(34, 197, 94, 0.18); }
    30%  { background: rgba(34, 197, 94, 0.10); }
    100% { background: rgba(34, 197, 94, 0.0); }
}

@keyframes floating-new-highlight-dark {
    0%   { background: rgba(74, 222, 128, 0.22); }
    30%  { background: rgba(74, 222, 128, 0.12); }
    100% { background: rgba(74, 222, 128, 0.0); }
}

.floating-record:last-child {
    border-bottom: 0;
}

.record-main {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-weight: 700;
    font-size: 12px;
}

.record-detail {
    margin-top: 4px;
    color: rgba(100, 116, 139, 1);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

:host([data-theme="dark"]) .record-detail {
    color: rgba(148, 163, 184, 1);
}

.record-meta {
    margin-top: 5px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    color: rgba(100, 116, 139, 1);
    font-size: 11px;
}

:host([data-theme="dark"]) .record-meta {
    color: rgba(148, 163, 184, 1);
}

.risk-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 48px;
    height: 22px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 700;
}

.risk-badge--critical { background: #fef2f2; color: #991b1b; }
.risk-badge--high { background: #fee2e2; color: #b91c1c; }
.risk-badge--medium { background: #fef3c7; color: #92400e; }
.risk-badge--low { background: #dcfce7; color: #15803d; }

:host([data-theme="dark"]) .risk-badge--critical { background: rgba(127, 29, 29, 0.3); color: #fca5a5; }
:host([data-theme="dark"]) .risk-badge--high { background: rgba(153, 27, 27, 0.3); color: #fca5a5; }
:host([data-theme="dark"]) .risk-badge--medium { background: rgba(113, 63, 18, 0.3); color: #fde68a; }
:host([data-theme="dark"]) .risk-badge--low { background: rgba(20, 83, 45, 0.3); color: #4ade80; }

.decision-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 48px;
    height: 22px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 700;
}

.decision-badge--Allow { background: #dcfce7; color: #15803d; }
.decision-badge--Deny { background: #fee2e2; color: #b91c1c; }

:host([data-theme="dark"]) .decision-badge--Allow { background: rgba(20, 83, 45, 0.3); color: #4ade80; }
:host([data-theme="dark"]) .decision-badge--Deny { background: rgba(153, 27, 27, 0.3); color: #fca5a5; }

.floating-empty {
    min-height: 80px;
    display: grid;
    place-items: center;
    color: rgba(100, 116, 139, 1);
    font-size: 12px;
}

:host([data-theme="dark"]) .floating-empty {
    color: rgba(148, 163, 184, 1);
}

.floating-view-more {
    min-height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 6px 12px;
    color: rgba(100, 116, 139, 1);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: color 0.15s ease, background 0.15s ease;
}

:host([data-theme="dark"]) .floating-view-more {
    color: rgba(148, 163, 184, 1);
}

.floating-view-more:hover {
    color: #22c55e;
    background: rgba(34, 197, 94, 0.06);
}

:host([data-theme="dark"]) .floating-view-more:hover {
    color: #4ade80;
    background: rgba(74, 222, 128, 0.08);
}

/* ── Settings Panel ── */
.floating-settings {
    max-height: 0;
    overflow: hidden;
    opacity: 0;
    padding: 0;
    border-top: 1px solid transparent;
    transition: max-height 0.25s ease, opacity 0.15s ease, padding 0.15s ease, border-top-color 0.15s ease;
}

.floating-settings.is-open {
    max-height: 150px;
    opacity: 1;
    padding: 10px 12px;
    border-top-color: rgba(200, 200, 210, 0.7);
}

:host([data-theme="dark"]) .floating-settings.is-open {
    border-top-color: rgba(80, 80, 90, 0.7);
}

.setting-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
}

.setting-row:last-child {
    margin-bottom: 0;
}

/* 三个开关（安全网关/恶意技能检测/显示浮窗）铺平一行 */
.toggles-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
}

.toggle-cell {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    flex: 1 1 0;
    min-width: 0;
}

.toggle-cell .setting-label {
    min-width: 0;
    text-align: center;
    font-size: 11px;
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
}

.toggle-cell .toggle-switch {
    flex-shrink: 0;
}

.setting-label {
    min-width: 50px;
    font-size: 12px;
    font-weight: 650;
    color: inherit;
}

/* ── Reset Position Button ── */
.floating-reset-btn {
    width: 100%;
    height: 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid rgba(200, 200, 210, 0.78);
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.62);
    color: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s ease;
}

:host([data-theme="dark"]) .floating-reset-btn {
    background: rgba(30, 30, 40, 0.62);
    border-color: rgba(80, 80, 90, 0.78);
}

.floating-reset-btn:hover {
    background: rgba(255, 255, 255, 0.82);
}

:host([data-theme="dark"]) .floating-reset-btn:hover {
    background: rgba(30, 30, 40, 0.82);
}

.opacity-slider {
    flex: 1;
    height: 4px;
    -webkit-appearance: none;
    appearance: none;
    border-radius: 2px;
    background: rgba(200, 200, 210, 0.5);
    outline: none;
}

:host([data-theme="dark"]) .opacity-slider {
    background: rgba(80, 80, 90, 0.5);
}

.opacity-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #22c55e;
    cursor: pointer;
}

.opacity-value {
    min-width: 36px;
    font-size: 12px;
    color: rgba(100, 116, 139, 1);
    text-align: right;
}

:host([data-theme="dark"]) .opacity-value {
    color: rgba(148, 163, 184, 1);
}

.toggle-switch {
    position: relative;
    width: 36px;
    height: 20px;
    border-radius: 999px;
    background: #d1d5db;
    cursor: pointer;
    transition: background 0.15s ease;
}

:host([data-theme="dark"]) .toggle-switch {
    background: rgba(100, 100, 110, 0.6);
}

.toggle-switch.is-on {
    background: #22c55e;
}

.toggle-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 3px rgba(15, 23, 42, 0.22);
    transition: transform 0.15s ease;
}

.toggle-switch.is-on .toggle-thumb {
    transform: translateX(16px);
}

/* ── Responsive ── */
@media (max-width: 720px) {
    .agentgate-floating,
    .agentgate-floating:hover,
    .agentgate-floating:focus-within {
        bottom: 12px;
        right: 12px;
        width: calc(100vw - 24px);
    }
}
`;

// ── ShieldCheck SVG Icon ──────────────────────────────────────────────────
const SHIELD_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>`;

// ── Component ────────────────────────────────────────────────────────────
class AgentGateFloatingWindow extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });

        // State
        this._events = [];
        this._enabled = false;
        this._opacity = 0.76;
        this._globalEnabled = true;
        this._globalEnabledBase = true; // 安全网关配置基线（不含安全网关总开关）
        this._gateEnabled = true; // 安全网关总开关
        this._gateToggling = false;
        this._gateActionUntil = 0; // 总开关操作后的抑制期截止时间戳（避免服务启停触发的自动展开/折叠）
        this._malEnabled = true; // 恶意技能检测开关
        this._malToggling = false;
        this._settingsOpen = false;
        this._loading = true;
        this._dashboardUrl = '';
        this._opacityLabel = null;
        this._toggleLabel = null;

        // Drag state
        this._isDragging = false;
        this._dragOffsetX = 0;
        this._dragOffsetY = 0;

        // Auto-expand state
        this._autoExpandTimer = null;
        this._isAutoExpanded = false;
        this._prevEventCount = 0;
        this._newEventIds = new Set(); // IDs of newly arrived events (for highlight)

        // Count state (from server, not from local 50-item cache)
        this._totalCount = 0;
        this._denyCount = 0;
        this._allowCount = 0;
        this._prevTotalCount = 0;

        // Moss health
        this._mossDot = null;
        this._mossHealthTimer = null;

        // Build initial DOM
        this._buildDOM();
    }

    static get observedAttributes() {
        return ['data-theme'];
    }

    attributeChangedCallback(name, oldVal, newVal) {
        if (name === 'data-theme') {
            // Theme updates
        }
    }

    connectedCallback() {
        // 初始默认隐藏，直到从配置确认应显示
        this.style.display = 'none';

        // Sync theme
        this._syncTheme();
        this._themeObserver = new MutationObserver(() => this._syncTheme());
        this._themeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme']
        });

        // 尝试初始化，如果 API 尚未就绪则延迟等待
        this._tryInit();
    }

    /** 尝试初始化，如果 agentGateFloatingAPI 尚未就绪则延迟重试 */
    _tryInit(retries = 0) {
        // 元素已从 DOM 移除时不再重试：否则会注册一个无人退订的事件订阅
        if (!this.isConnected) return;
        // 初始化 locale（从 setting 同步）
        if (!_floatingLocale) resolveFloatingLocale();

        const api = window.agentGateFloatingAPI;
        if (!api) {
            if (retries < 10) {
                // API 尚未暴露（preload 可能还没执行完），延迟重试
                setTimeout(() => this._tryInit(retries + 1), 200);
                return;
            }
            console.warn('[agentgate-floating-window] agentGateFloatingAPI not available after 10 retries');
            return;
        }

        // Subscribe to IPC events (only once)
        this._eventsCallback = (events, counts) => {
            const newEvents = events || [];
            // 提取全量统计（与 dashboard 一致），不受本地 50 条缓存限制
            if (counts) {
                this._totalCount = counts.totalCount || 0;
                this._denyCount = counts.denyCount || 0;
                this._allowCount = counts.allowCount || 0;
            }
            const oldCount = this._prevEventCount;

            // Detect newly arrived event IDs for highlight
            // Compare current events with the new ones to find IDs not seen before
            if (oldCount > 0 && newEvents.length > oldCount) {
                const prevIds = new Set(this._events.map((e) => e.id));
                for (const ev of newEvents) {
                    if (!prevIds.has(ev.id)) {
                        this._newEventIds.add(ev.id);
                    }
                }
            }

            // 用服务器全量计数来判断是否有新事件（本地缓存始终50条，长度不变）
            const prevTotal = this._prevTotalCount;
            this._prevTotalCount = this._totalCount;
            this._prevEventCount = newEvents.length;
            this._events = newEvents;
            this._loading = false;
            this._renderRecords();
            this._updateHeader();

            // Auto-expand when total count increases (new event arrived on server)
            if (this._totalCount > prevTotal && prevTotal > 0) {
                this._triggerAutoExpand();
            }
        };
        // 重复初始化（元素重新连接）时先退订上一次订阅，避免同通道堆叠 handler
        if (this._eventsUnsubscribe) {
            this._eventsUnsubscribe();
            this._eventsUnsubscribe = null;
        }
        this._eventsUnsubscribe = api.onEventsUpdate(this._eventsCallback) ?? null;

        // Load initial config
        const registry = window.applicationRegistryAPI;
        const callAG = (methodName, ...args) => registry?.callMainWorld('agentgate', methodName, ...args);
        callAG('getFloatingWindowConfig')
            .then(async (config) => {
                // 读取安全网关总开关真实状态（区别于浮窗显示开关）
                let gateEnabled = false;
                try {
                    gateEnabled = await registry?.callMainWorld('agentgate', 'getEnabled');
                } catch {}
                this._globalEnabledBase = true;
                this._gateEnabled = gateEnabled === true;
                this._globalEnabled = this._globalEnabledBase && this._gateEnabled;

                // 读取恶意技能检测开关真实状态（默认 true）
                let malEnabled = true;
                try {
                    malEnabled = await registry?.callMainWorld('agentgate', 'getMaliciousSkillDetection');
                } catch {}
                this._malEnabled = malEnabled !== false;

                this._enabled = config.enabled;
                this._opacity = config.opacity;
                // 根据 enabled 状态控制 host 元素可见性
                this.style.display = this._enabled ? '' : 'none';
                this._updateOpacity();
                this._updateToggleSwitch();
                this._updateGateSwitch();
                this._updateMalSwitch();
                this._updateHeader();
            })
            .catch((err) => {
                console.warn('[agentgate-floating-window] getFloatingWindowConfig failed:', err);
            });

        // Load initial events (set prevEventCount so first load doesn't trigger auto-expand)
        callAG('getRecentEvents')
            .then((events) => {
                this._events = events || [];
                this._prevEventCount = this._events.length;
                this._loading = false;
                this._renderRecords();
                this._updateHeader();
            })
            .catch((err) => {
                console.warn('[agentgate-floating-window] getRecentEvents failed:', err);
            });

        // Get dashboard URL for navigation
        callAG('getDashboardUrl')
            .then((url) => {
                this._dashboardUrl = url;
            })
            .catch(() => {
                this._dashboardUrl = 'http://127.0.0.1:9100/dashboard/';
            });

        // Start moss health check polling (runs in background, won't block)
        this._startMossHealthCheck();

        // Listen for global setting changes to sync visibility
        if (window.settingAPI) {
            this._settingCallback = (data) => {
                const agConfig = data?.applications?.agentgate || {};
                const agentgateEnabled = agConfig.enabled === true;

                // AgentGate is only truly active when its own total switch is on
                this._globalEnabledBase = true;
                this._gateEnabled = agentgateEnabled;
                this._globalEnabled = this._globalEnabledBase && this._gateEnabled;

                // 同步恶意技能检测开关（默认 false，显式开启才生效）
                this._malEnabled = agConfig.maliciousSkillDetection === true;

                // Floating window visibility is controlled by the AgentGate application config
                const floatingWindowEnabled = agConfig.floatingWindowEnabled === true;
                const newEnabled = floatingWindowEnabled;
                if (newEnabled !== this._enabled) {
                    this._enabled = newEnabled;
                    this.style.display = this._enabled ? '' : 'none';
                    // 重新开启浮窗时，关闭设置面板（回到初始状态）
                    if (this._enabled && this._settingsOpen) {
                        this._settingsOpen = false;
                        this._settingsEl.className = 'floating-settings';
                    }
                }
                // Sync opacity
                if (agConfig.floatingWindowOpacity !== undefined) {
                    this._opacity = agConfig.floatingWindowOpacity;
                    this._updateOpacity();
                    if (this._opacitySlider) {
                        this._opacitySlider.value = String(this._opacity);
                    }
                    if (this._opacityValue) {
                        this._opacityValue.textContent = this._opacity.toFixed(2);
                    }
                }
                this._updateToggleSwitch();
                this._updateGateSwitch();
                this._updateMalSwitch();
                this._updateHeader();
                // 总开关状态可能变化：重渲染记录列表（关闭时不显示历史记录）
                this._renderRecords();
                // Locale 变化时重新同步翻译（locale='auto' 时取 resolved_locale，与 resolveFloatingLocale 一致）
                let newLocale = data?.locale;
                if (!newLocale || newLocale === 'auto') newLocale = data?.resolved_locale;
                if (newLocale && newLocale !== _floatingLocale) {
                    _floatingLocale = newLocale;
                    this._reRenderAll();
                }
            };
            window.settingAPI.onSettingChanged(this._settingCallback);
        }
    }

    /** locale 变化时重新渲染所有翻译文本 */
    _reRenderAll() {
        this._updateHeader();
        this._renderRecords();
        // 标题（无论设置面板是否打开都要同步，元素始终在 DOM 中）
        if (this._titleLabel) this._titleLabel.textContent = t('floatingTitle');
        if (this._container) this._container.setAttribute('aria-label', t('floatingTitle'));
        // 重新渲染设置面板文本（去掉 _settingsOpen 条件：元素已在 DOM，下次打开即为新文案）
        if (this._gateLabel) this._gateLabel.textContent = t('securityGatewaySwitch');
        if (this._malLabel) this._malLabel.textContent = t('maliciousSkillSwitch');
        if (this._toggleLabel) this._toggleLabel.textContent = t('floatingWindowSwitch');
        if (this._opacityLabel) this._opacityLabel.textContent = t('floatingWindowOpacity');
        // 重新渲染详情链接
        if (this._detailLink) this._detailLink.textContent = t('floatingWindowDetail');
    }

    disconnectedCallback() {
        if (this._themeObserver) {
            this._themeObserver.disconnect();
        }
        // 只退订本浮窗自己的订阅，不影响同通道上的其他 consumer
        if (this._eventsUnsubscribe) {
            try {
                this._eventsUnsubscribe();
            } catch {
                /* ignore */
            }
            this._eventsUnsubscribe = null;
        }
        // Clean up auto-expand timer
        if (this._autoExpandTimer) {
            clearTimeout(this._autoExpandTimer);
            this._autoExpandTimer = null;
        }
        // Clean up drag handlers on document
        if (this._docDragMoveHandler) {
            document.removeEventListener('mousemove', this._docDragMoveHandler);
        }
        if (this._dragEndHandler) {
            document.removeEventListener('mouseup', this._dragEndHandler);
        }
        // Clean up moss health timer
        if (this._mossHealthTimer) {
            clearInterval(this._mossHealthTimer);
            this._mossHealthTimer = null;
        }
    }

    // ── Theme sync ────────────────────────────────────────────────────
    _syncTheme() {
        const theme = document.documentElement.dataset.theme || 'light';
        this.setAttribute('data-theme', theme);
    }

    // ── DOM Construction ───────────────────────────────────────────────
    _buildDOM() {
        const style = document.createElement('style');
        style.textContent = CSS;

        this._container = document.createElement('aside');
        this._container.className = 'agentgate-floating';
        this._container.setAttribute('aria-label', t('floatingTitle'));

        // Header
        this._headerEl = document.createElement('div');
        this._headerEl.className = 'floating-header';

        const titleDiv = document.createElement('div');
        titleDiv.className = 'floating-title';
        titleDiv.innerHTML = `${SHIELD_ICON}<span class="floating-title-label"></span>`;
        this._titleLabel = titleDiv.querySelector('.floating-title-label');
        this._titleLabel.textContent = t('floatingTitle');
        // Moss health dot — 放回 floating-title 内，插在盾牌与 label 之间紧贴盾牌。
        // 安全前提：title 已设 flex:0 0 auto（不可收缩），盒宽不会被压到小于内容，
        // 故 overflow:hidden 不会裁掉 dot（区别于最初 flex:0 1 auto 会压裁的版本）。
        this._mossDot = document.createElement('span');
        this._mossDot.className = 'moss-health-dot';
        this._mossDot.title = 'AgentMoss';
        titleDiv.insertBefore(this._mossDot, this._titleLabel);

        this._actionsDiv = document.createElement('div');
        this._actionsDiv.className = 'floating-actions';

        // Collapse/Pin button: expanded → "固定", pinned → "收起"
        this._collapseBtn = document.createElement('button');
        this._collapseBtn.className = 'floating-collapse-btn';
        this._isPinned = false;
        this._collapseBtn.textContent = t('floatingWindowPin');
        this._collapseBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this._isPinned) {
                // 已固定状态：点击"收起" → 解除固定 + 折叠
                this._unpinAndCollapse();
            } else {
                // 展开状态：点击"固定" → 固定展开
                this._pinExpand();
            }
        });

        // Detail link button
        this._detailLink = document.createElement('button');
        this._detailLink.className = 'floating-detail-link';
        this._detailLink.textContent = t('floatingWindowDetail');
        this._detailLink.addEventListener('click', () => this._navigateToDashboard());

        // Status badge
        this._statusBadge = document.createElement('span');
        this._statusBadge.className = 'status-badge';

        // Event count — 3 tags: total / deny / allow
        this._eventCount = document.createElement('span');
        this._eventCount.className = 'event-count';

        this._countTotal = document.createElement('span');
        this._countTotal.className = 'count-tag count-tag--total';
        this._countTotal.textContent = '0';

        this._countDeny = document.createElement('span');
        this._countDeny.className = 'count-tag count-tag--deny';
        this._countDeny.textContent = '0';

        this._countAllow = document.createElement('span');
        this._countAllow.className = 'count-tag count-tag--allow';
        this._countAllow.textContent = '0';

        this._eventCount.appendChild(this._countTotal);
        this._eventCount.appendChild(this._countDeny);
        this._eventCount.appendChild(this._countAllow);

        // Settings button
        this._settingsBtn = document.createElement('button');
        this._settingsBtn.className = 'settings-btn';
        this._settingsBtn.textContent = '⚙';
        this._settingsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleSettings();
        });

        this._actionsDiv.appendChild(this._collapseBtn);
        this._actionsDiv.appendChild(this._detailLink);
        this._actionsDiv.appendChild(this._statusBadge);
        this._actionsDiv.appendChild(this._eventCount);
        this._actionsDiv.appendChild(this._settingsBtn);

        this._headerEl.appendChild(titleDiv);
        this._headerEl.appendChild(this._actionsDiv);

        // Records container
        this._recordsEl = document.createElement('div');
        this._recordsEl.className = 'floating-records';

        // Settings panel
        this._settingsEl = document.createElement('div');
        this._settingsEl.className = 'floating-settings';
        this._buildSettingsPanel();

        this._container.appendChild(this._headerEl);
        this._container.appendChild(this._recordsEl);
        this._container.appendChild(this._settingsEl);

        this.shadowRoot.appendChild(style);
        this.shadowRoot.appendChild(this._container);

        // Hover tracking for auto-expand behavior
        this._container.addEventListener('mouseenter', () => this._onHoverStart());
        this._container.addEventListener('mouseleave', () => this._onHoverEnd());

        // Initialize drag behavior
        this._initDrag();

        // Restore saved position
        this._restorePosition();

        // Initial header update
        this._updateHeader();
        this._renderRecords();
    }

    _buildSettingsPanel() {
        // 三个开关（安全网关/恶意技能检测/显示浮窗）铺平一行的容器
        const togglesRow = document.createElement('div');
        togglesRow.className = 'toggles-row';

        // Security gateway master switch cell (总开关)
        const gateRow = document.createElement('div');
        gateRow.className = 'toggle-cell';

        const gateLabel = document.createElement('span');
        gateLabel.className = 'setting-label';
        gateLabel.textContent = t('securityGatewaySwitch');
        this._gateLabel = gateLabel;

        this._gateSwitch = document.createElement('div');
        this._gateSwitch.className = 'toggle-switch';
        this._gateSwitch.setAttribute('tabindex', '0');
        this._gateSwitch.setAttribute('role', 'switch');
        this._gateSwitch.innerHTML = '<div class="toggle-thumb"></div>';
        this._gateSwitch.addEventListener('click', async (e) => {
            e.stopPropagation();
            // 点击后主动把焦点保留在开关上，避免 :focus-within 丢失导致浮窗 CSS 收回
            try {
                this._gateSwitch.focus();
            } catch {}
            if (this._gateToggling) return;
            this._gateToggling = true;
            const next = !this._gateEnabled;
            // 乐观更新 UI
            this._gateEnabled = next;
            this._globalEnabled = this._globalEnabledBase && next;
            this._updateGateSwitch();
            this._updateHeader();
            // 总开关状态变化：立即重渲染记录列表（关闭时不显示历史记录）
            this._renderRecords();
            // 抑制后续一段时间内的自动展开/折叠，避免服务启停或事件轮询带来的状态扰动
            this._gateActionUntil = Date.now() + 2500;
            try {
                await window.applicationRegistryAPI?.callMainWorld('agentgate', 'setEnabled', next);
                // 后端 setEnabled 会触发 setting 广播，_settingCallback 会回填真实状态
            } catch (err) {
                console.warn('[agentgate-floating-window] setEnabled failed:', err);
                // 回滚乐观更新
                this._gateEnabled = !next;
                this._globalEnabled = this._globalEnabledBase && this._gateEnabled;
                this._updateGateSwitch();
                this._updateHeader();
                this._renderRecords();
            } finally {
                this._gateToggling = false;
            }
        });

        gateRow.appendChild(gateLabel);
        gateRow.appendChild(this._gateSwitch);

        // Malicious skill detection switch cell（恶意技能检测：拦截归因+弹窗+黑名单）
        const malRow = document.createElement('div');
        malRow.className = 'toggle-cell';

        const malLabel = document.createElement('span');
        malLabel.className = 'setting-label';
        malLabel.textContent = t('maliciousSkillSwitch');
        this._malLabel = malLabel;

        this._malSwitch = document.createElement('div');
        this._malSwitch.className = 'toggle-switch';
        this._malSwitch.setAttribute('tabindex', '0');
        this._malSwitch.setAttribute('role', 'switch');
        this._malSwitch.innerHTML = '<div class="toggle-thumb"></div>';
        this._malSwitch.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
                this._malSwitch.focus();
            } catch {}
            if (this._malToggling) return;
            this._malToggling = true;
            const next = !this._malEnabled;
            // 乐观更新 UI
            this._malEnabled = next;
            this._updateMalSwitch();
            try {
                await window.applicationRegistryAPI?.callMainWorld('agentgate', 'setMaliciousSkillDetection', next);
                // 后端 setMaliciousSkillDetection 会触发 setting 广播，_settingCallback 回填真实状态
            } catch (err) {
                console.warn('[agentgate-floating-window] setMaliciousSkillDetection failed:', err);
                this._malEnabled = !next;
                this._updateMalSwitch();
            } finally {
                this._malToggling = false;
            }
        });

        malRow.appendChild(malLabel);
        malRow.appendChild(this._malSwitch);

        // Opacity row
        const opacityRow = document.createElement('div');
        opacityRow.className = 'setting-row';

        const opacityLabel = document.createElement('span');
        opacityLabel.className = 'setting-label';
        opacityLabel.textContent = t('floatingWindowOpacity');
        this._opacityLabel = opacityLabel;

        this._opacitySlider = document.createElement('input');
        this._opacitySlider.className = 'opacity-slider';
        this._opacitySlider.type = 'range';
        this._opacitySlider.min = '0.3';
        this._opacitySlider.max = '1.0';
        this._opacitySlider.step = '0.02';
        this._opacitySlider.value = String(this._opacity);
        this._opacitySlider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            this._opacity = val;
            this._opacityValue.textContent = val.toFixed(2);
            this._updateOpacity();
            window.applicationRegistryAPI?.callMainWorld('agentgate', 'setFloatingWindowOpacity', val);
        });

        this._opacityValue = document.createElement('span');
        this._opacityValue.className = 'opacity-value';
        this._opacityValue.textContent = this._opacity.toFixed(2);

        opacityRow.appendChild(opacityLabel);
        opacityRow.appendChild(this._opacitySlider);
        opacityRow.appendChild(this._opacityValue);

        // Toggle cell (显示浮窗)
        const toggleRow = document.createElement('div');
        toggleRow.className = 'toggle-cell';

        const toggleLabel = document.createElement('span');
        toggleLabel.className = 'setting-label';
        toggleLabel.textContent = t('floatingWindowSwitch');
        this._toggleLabel = toggleLabel;

        this._toggleSwitch = document.createElement('div');
        this._toggleSwitch.className = 'toggle-switch';
        this._toggleSwitch.setAttribute('tabindex', '0');
        this._toggleSwitch.setAttribute('role', 'switch');
        this._toggleSwitch.innerHTML = '<div class="toggle-thumb"></div>';
        this._toggleSwitch.addEventListener('click', (e) => {
            e.stopPropagation();
            try {
                this._toggleSwitch.focus();
            } catch {}
            this._enabled = !this._enabled;
            this._updateToggleSwitch();
            this.style.display = this._enabled ? '' : 'none';
            window.applicationRegistryAPI?.callMainWorld('agentgate', 'setFloatingWindowEnabled', this._enabled);
        });

        toggleRow.appendChild(toggleLabel);
        toggleRow.appendChild(this._toggleSwitch);

        // Reset position row
        const resetRow = document.createElement('div');
        resetRow.className = 'setting-row';
        this._resetRow = resetRow;

        const resetBtn = document.createElement('button');
        resetBtn.className = 'floating-reset-btn';
        resetBtn.textContent = t('floatingWindowResetPosition');
        this._resetBtn = resetBtn;
        resetBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.resetPosition();
        });

        resetRow.appendChild(resetBtn);

        // 三个开关铺平一行，opacity 与 reset 各占一行
        togglesRow.appendChild(gateRow);
        togglesRow.appendChild(malRow);
        togglesRow.appendChild(toggleRow);
        this._settingsEl.appendChild(togglesRow);
        this._settingsEl.appendChild(opacityRow);
        this._settingsEl.appendChild(resetRow);

        this._updateToggleSwitch();
        this._updateGateSwitch();
        this._updateMalSwitch();
    }

    // ── Update Methods ────────────────────────────────────────────────
    _updateHeader() {
        // Collapse/Pin button text (locale may change, also depends on pinned state)
        if (this._collapseBtn)
            this._collapseBtn.textContent = this._isPinned ? t('floatingWindowCollapse') : t('floatingWindowPin');
        // Detail link text (locale may change)
        if (this._detailLink) this._detailLink.textContent = t('floatingWindowDetail');
        // Reset position button text (locale may change)
        if (this._resetBtn) this._resetBtn.textContent = t('floatingWindowResetPosition');
        // Security gateway switch label (locale may change)
        if (this._gateLabel) this._gateLabel.textContent = t('securityGatewaySwitch');

        // Status badge
        if (this._globalEnabled) {
            this._statusBadge.className = 'status-badge is-active';
            this._statusBadge.textContent = t('floatingWindowProtected');
        } else {
            this._statusBadge.className = 'status-badge is-off';
            this._statusBadge.textContent = t('floatingWindowOff');
        }

        // Count tags: total / deny / allow — 使用服务端全量统计，与 dashboard 一致
        this._countTotal.textContent = String(this._totalCount || this._events.length);
        this._countDeny.textContent = String(
            this._denyCount || this._events.filter((e) => e.decision === 'Deny').length
        );
        this._countAllow.textContent = String(
            this._allowCount || this._events.filter((e) => e.decision === 'Allow').length
        );
    }

    _updateOpacity() {
        this._container.style.setProperty('--floating-opacity', String(this._opacity));
        // Hover opacity: slightly higher, but not exceeding 0.95
        const hoverOpacity = Math.min(this._opacity + 0.14, 0.95);
        this._container.style.setProperty('--floating-opacity-hover', String(hoverOpacity));
    }

    // ── Moss Health Check ────────────────────────────────────────────
    _startMossHealthCheck() {
        this._checkMossHealth();
        this._mossHealthTimer = setInterval(() => this._checkMossHealth(), 10000);
    }

    async _checkMossHealth() {
        try {
            const status = await window.applicationRegistryAPI?.callMainWorld('agentgate', 'getBridgeStatus');
            if (!status) return;
            const dot = this._mossDot;
            if (!dot) return;
            if (status?.mossRunning === true && status?.llmAvailable !== false) {
                dot.className = 'moss-health-dot ok';
                dot.title = '安全网关正常';
            } else if (status?.mossRunning === true && status?.llmAvailable === false) {
                dot.className = 'moss-health-dot warn';
                dot.title = 'AgentMoss 服务不可用';
            } else {
                dot.className = 'moss-health-dot err';
                dot.title = '安全网关不可达';
            }
        } catch {
            const dot = this._mossDot;
            if (dot) {
                dot.className = 'moss-health-dot err';
                dot.title = 'AgentMoss 不可达';
            }
        }
    }

    _updateToggleSwitch() {
        this._toggleSwitch.className = this._enabled ? 'toggle-switch is-on' : 'toggle-switch';
    }

    _updateGateSwitch() {
        if (!this._gateSwitch) return;
        this._gateSwitch.className = this._gateEnabled ? 'toggle-switch is-on' : 'toggle-switch';
    }

    _updateMalSwitch() {
        if (!this._malSwitch) return;
        this._malSwitch.className = this._malEnabled ? 'toggle-switch is-on' : 'toggle-switch';
    }

    _toggleSettings() {
        this._settingsOpen = !this._settingsOpen;
        this._settingsEl.className = this._settingsOpen ? 'floating-settings is-open' : 'floating-settings';
    }

    // ── Auto-Expand ──────────────────────────────────────────────────
    /** 新事件到达时自动展开浮窗，显示几秒后收回 */
    _triggerAutoExpand() {
        if (!this._enabled) return;
        // 总开关操作后的抑制期内，不触发自动展开（避免服务启停带来的扰动）
        if (this._gateActionUntil && Date.now() < this._gateActionUntil) return;

        // Add auto-expanded class to expand records
        this._isAutoExpanded = true;
        this._container.classList.add('is-auto-expanded');

        // Scroll records to top so the latest event is visible
        this._recordsEl.scrollTop = 0;

        // Only start the collapse timer if not already running
        // (keep the original 5s window, don't extend it for subsequent new events)
        if (!this._autoExpandTimer) {
            this._autoExpandTimer = setTimeout(() => {
                this._collapseAutoExpand();
            }, 3000);
        }
    }

    /** 收回自动展开（如果用户正在 hover 则不收回），并清除高亮 */
    /** 收回自动展开（如果已固定则不收回），并清除高亮 */
    _collapseAutoExpand() {
        if (this._isPinned) return; // 固定状态下不自动收回
        // 总开关操作后的抑制期内，不自动收回（避免服务启停带来的扰动）
        if (this._gateActionUntil && Date.now() < this._gateActionUntil) return;
        this._isAutoExpanded = false;
        this._autoExpandTimer = null;
        // Clear new-event highlights
        this._newEventIds.clear();
        this._renderRecords();
        // Only remove the class if user is NOT hovering
        const isHovering = this._container.matches(':hover');
        if (!isHovering) {
            this._container.classList.remove('is-auto-expanded');
        }
    }

    /** 固定浮窗展开（用户点击"固定"按钮） */
    _pinExpand() {
        this._isPinned = true;
        // 取消 auto-expand timer，因为已经固定了不需要自动收回
        if (this._autoExpandTimer) {
            clearTimeout(this._autoExpandTimer);
            this._autoExpandTimer = null;
        }
        this._container.classList.add('is-pinned');
        this._container.classList.remove('is-auto-expanded'); // pinned 取代 auto-expand
        this._collapseBtn.textContent = t('floatingWindowCollapse');
        this._updateHeader();
    }

    /** 解除固定并折叠浮窗（用户点击"收起"按钮） */
    _unpinAndCollapse() {
        this._isPinned = false;
        this._isAutoExpanded = false;
        if (this._autoExpandTimer) {
            clearTimeout(this._autoExpandTimer);
            this._autoExpandTimer = null;
        }
        this._newEventIds.clear();
        this._container.classList.remove('is-pinned');
        this._container.classList.remove('is-auto-expanded');
        this._collapseBtn.textContent = t('floatingWindowPin');
        this._renderRecords();
        this._updateHeader();
    }

    /** 强制折叠浮窗（无论 hover/auto-expand/pinned 状态） */
    _forceCollapse() {
        this._unpinAndCollapse();
    }

    /** 用户开始 hover 时，取消自动收回 timer（固定状态下 timer 已不存在，不影响） */
    _onHoverStart() {
        if (this._autoExpandTimer) {
            clearTimeout(this._autoExpandTimer);
            this._autoExpandTimer = null;
        }
    }

    /** 用户结束 hover 时，如果已固定则保持展开；否则按默认逻辑收回 */
    _onHoverEnd() {
        if (this._isPinned) return; // 固定状态下不受 hover 影响
        // 总开关操作后的抑制期内，不因 hover 结束而折叠
        if (this._gateActionUntil && Date.now() < this._gateActionUntil) return;
        if (!this._isAutoExpanded) {
            this._container.classList.remove('is-auto-expanded');
        } else if (!this._autoExpandTimer) {
            // 自动展开状态但 timer 已被清除（hover 时取消了 timer），立即收回
            this._collapseAutoExpand();
        }
        // 折叠时同时关闭设置面板，避免残留
        if (this._settingsOpen) {
            this._settingsOpen = false;
            this._settingsEl.className = 'floating-settings';
        }
    }

    // ── Render Records ────────────────────────────────────────────────
    _renderRecords() {
        // 安全网关总开关关闭时，不显示历史拦截/放行记录（与实时状态、策略控制台一致）
        if (this._gateEnabled === false) {
            this._recordsEl.innerHTML = `<div class="floating-empty">${t('floatingWindowNoRecords')}</div>`;
            return;
        }
        if (this._events.length === 0) {
            this._recordsEl.innerHTML = `<div class="floating-empty">${
                this._loading ? t('floatingWindowLoading') : t('floatingWindowNoRecords')
            }</div>`;
            return;
        }

        this._recordsEl.innerHTML = '';
        for (const event of this._events) {
            const recordEl = this.createElement('div');
            const isNew = this._newEventIds.has(event.id);
            recordEl.className = isNew ? 'floating-record is-new' : 'floating-record';
            recordEl.addEventListener('click', () => this._navigateToDashboard(event.id));

            // Main row: operation type + risk level
            const mainDiv = this.createElement('div');
            mainDiv.className = 'record-main';

            const operationSpan = this.createElement('span');
            operationSpan.textContent = this._getOperationText(event);

            const riskBadge = this.createElement('span');
            riskBadge.className = `risk-badge risk-badge--${event.risk_level || 'low'}`;
            riskBadge.textContent = this._getRiskText(event.risk_level);

            mainDiv.appendChild(operationSpan);
            mainDiv.appendChild(riskBadge);

            // Detail row: command preview
            const detailDiv = this.createElement('div');
            detailDiv.className = 'record-detail';
            detailDiv.textContent = this._getDetailText(event);

            // Meta row: time + decision
            const metaDiv = this.createElement('div');
            metaDiv.className = 'record-meta';

            const timeSpan = this.createElement('span');
            timeSpan.textContent = this._formatTime(event.called_at);

            const decisionBadge = this.createElement('span');
            decisionBadge.className = `decision-badge decision-badge--${event.decision}`;
            decisionBadge.textContent =
                event.decision === 'Allow' ? t('floatingWindowAllowed') : t('floatingWindowBlocked');

            metaDiv.appendChild(timeSpan);
            metaDiv.appendChild(decisionBadge);

            recordEl.appendChild(mainDiv);
            recordEl.appendChild(detailDiv);
            recordEl.appendChild(metaDiv);

            this._recordsEl.appendChild(recordEl);
        }

        // "查看更多..." footer link
        const viewMoreEl = this.createElement('div');
        viewMoreEl.className = 'floating-view-more';
        viewMoreEl.textContent = t('floatingWindowViewMore');
        viewMoreEl.addEventListener('click', () => this._navigateToDashboard());
        this._recordsEl.appendChild(viewMoreEl);
    }

    // Use shadowRoot's createElement to ensure elements are in the shadow DOM context
    createElement(tag) {
        return document.createElement(tag);
    }

    _getOperationText(event) {
        const command = event.command || event.action_detail || '';
        if (command.length > 40) return command.slice(0, 37) + '...';
        return command || event.agent_type || '-';
    }

    _getRiskText(riskLevel) {
        switch (riskLevel) {
            case 'critical':
                return t('riskCritical');
            case 'high':
                return t('riskHigh');
            case 'medium':
                return t('riskMedium');
            case 'low':
                return t('riskLow');
            default:
                return t('riskLow');
        }
    }

    _getDetailText(event) {
        const reason = event.reason || '';
        if (reason.length > 60) return reason.slice(0, 57) + '...';
        return reason || event.command || '-';
    }

    _formatTime(calledAt) {
        if (!calledAt) return '-';
        try {
            const date = new Date(calledAt + (calledAt.endsWith('Z') ? '' : 'Z'));
            return date.toLocaleString(isZh() ? 'zh-CN' : 'en-US', {
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
        } catch {
            return calledAt;
        }
    }

    // ── Drag Behavior ──────────────────────────────────────────────────
    _initDrag() {
        // Header as drag handle
        this._headerEl.addEventListener('mousedown', (e) => {
            // Don't start drag if clicking on interactive elements (buttons, links)
            if (e.target.closest('button, a, .settings-btn, .floating-detail-link')) return;

            this._isDragging = true;
            const rect = this._container.getBoundingClientRect();
            this._dragOffsetX = e.clientX - rect.left;
            this._dragOffsetY = e.clientY - rect.top;

            // Disable hover expand during drag
            this._container.style.transition = 'none';

            e.preventDefault();
        });

        // Mouse move handler (on shadow root so it captures even if mouse leaves header)
        this._dragMoveHandler = (e) => {
            if (!this._isDragging) return;
            const x = e.clientX - this._dragOffsetX;
            const y = e.clientY - this._dragOffsetY;

            // Clamp to viewport (keep at least 40px visible on each side)
            const maxX = window.innerWidth - 40;
            const maxY = window.innerHeight - 40;
            const clampedX = Math.max(0, Math.min(x, maxX));
            const clampedY = Math.max(0, Math.min(y, maxY));

            this._container.style.left = clampedX + 'px';
            this._container.style.top = clampedY + 'px';
            // Remove right/bottom positioning when using explicit left/top
            this._container.style.right = 'auto';
            this._container.style.bottom = 'auto';
        };
        this.shadowRoot.addEventListener('mousemove', this._dragMoveHandler);

        // Also listen on document for moves outside shadow root
        this._docDragMoveHandler = (e) => {
            if (!this._isDragging) return;
            this._dragMoveHandler(e);
        };
        document.addEventListener('mousemove', this._docDragMoveHandler);

        // Mouse up — end drag
        this._dragEndHandler = () => {
            if (!this._isDragging) return;
            this._isDragging = false;
            // Restore transitions
            this._container.style.transition = '';
            // Save position
            this._savePosition();
        };
        this.shadowRoot.addEventListener('mouseup', this._dragEndHandler);
        document.addEventListener('mouseup', this._dragEndHandler);
    }

    _savePosition() {
        const rect = this._container.getBoundingClientRect();
        try {
            localStorage.setItem(
                'agentgate-floating-position',
                JSON.stringify({
                    left: rect.left,
                    top: rect.top
                })
            );
        } catch {
            /* localStorage unavailable */
        }
    }

    _restorePosition() {
        try {
            const saved = localStorage.getItem('agentgate-floating-position');
            if (saved) {
                const pos = JSON.parse(saved);
                if (pos.left !== undefined && pos.top !== undefined) {
                    // Validate position is still within viewport
                    const maxX = window.innerWidth - 40;
                    const maxY = window.innerHeight - 40;
                    const clampedX = Math.max(0, Math.min(pos.left, maxX));
                    const clampedY = Math.max(0, Math.min(pos.top, maxY));
                    this._container.style.left = clampedX + 'px';
                    this._container.style.top = clampedY + 'px';
                    this._container.style.right = 'auto';
                    this._container.style.bottom = 'auto';
                    return;
                }
            }
        } catch {
            /* localStorage unavailable or parse error */
        }
        // 没有保存位置时（首次开启）：计算默认位置
        // 会话界面顶部居中，与"导出"/"面板" toolbar 同水平线
        this._applyDefaultPosition();
    }

    /** 计算并应用浮窗默认位置：从 opendesk 窗口最上方距离的一半，右侧面板水平居中 */
    _applyDefaultPosition() {
        const fwWidth = 320; // 浮窗宽度
        const rightPanel = document.getElementById('rightPanel');
        // 距 opendesk 窗口最上方偏移：原 96 的一半
        const topOffset = 40;
        if (rightPanel) {
            const rect = rightPanel.getBoundingClientRect();
            // 水平居中于右侧面板
            const centerX = rect.left + (rect.width - fwWidth) / 2;
            this._container.style.left = Math.max(8, centerX) + 'px';
            this._container.style.top = topOffset + 'px';
            this._container.style.right = 'auto';
            this._container.style.bottom = 'auto';
        } else {
            // 回退：viewport 顶部偏移居中
            this._container.style.left = (window.innerWidth - fwWidth) / 2 + 'px';
            this._container.style.top = topOffset + 'px';
            this._container.style.right = 'auto';
            this._container.style.bottom = 'auto';
        }
    }

    /** 重置浮窗位置到默认（供 config 页重置按钮调用） */
    resetPosition() {
        try {
            localStorage.removeItem('agentgate-floating-position');
        } catch {}
        this._applyDefaultPosition();
    }

    _navigateToDashboard(highlightEventId) {
        // Navigate to AgentGate application within OpenDesk
        if (window.globalControlAPI && window.globalControlAPI.openApplication) {
            window.globalControlAPI.openApplication('agentgate', { highlightEventId: highlightEventId || null });
        } else if (this._dashboardUrl) {
            window.open(this._dashboardUrl, '_blank');
        }
    }
}

customElements.define('agentgate-floating-window', AgentGateFloatingWindow);
