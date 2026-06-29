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

const BASE_URL = (typeof process !== 'undefined' && process.env?.AGENT_GATE_URL) || 'http://127.0.0.1:9100';
const DASHBOARD_URL = `${BASE_URL}/dashboard/`;
const HEALTH_URL = `${BASE_URL}/api/v1/health`;

// ── Theme & Locale Helpers ───────────────────────────────────────────────────

function getEffectiveTheme(): 'light' | 'dark' {
    return (document.documentElement.dataset.theme as 'light' | 'dark') || 'light';
}
function isDark(): boolean {
    return getEffectiveTheme() === 'dark';
}

let _locale: string | null = null; // null 表示未初始化，避免竞态条件
let _localePromise: Promise<string> | null = null;

async function getLocale(): Promise<string> {
    if (_locale) return _locale; // 已确定则直接返回
    if (_localePromise) return _localePromise;
    _localePromise = (async () => {
        // 优先使用主进程提供的 locale（最可靠）
        try {
            const api = (window as any).applicationAPI;
            if (api?.callMainWorld) {
                const loc = await api.callMainWorld('getLocale');
                if (loc) {
                    _locale = loc;
                    return loc;
                }
            }
        } catch {}

        // 回退到 settingAPI
        try {
            const s = (window as any).settingAPI;
            if (s) {
                const d = await s.loadSettingObject();
                const l = d?.locale;
                if (l && l !== 'auto') {
                    _locale = l;
                    return l;
                }
            }
        } catch {}

        // 最终 fallback：使用系统 locale，但优先匹配 zh
        const sysLocale = Intl.DateTimeFormat().resolvedOptions().locale;
        _locale = sysLocale.startsWith('zh') ? 'zh-CN' : 'en-US';
        return _locale;
    })();
    return _localePromise;
}

function isZh(): boolean {
    // 未初始化时，尝试从 DOM 或系统快速检测（同步）
    if (!_locale) {
        // 检查 document.documentElement.lang 或 navigator.language
        const docLang = document.documentElement.lang;
        if (docLang?.startsWith('zh')) {
            _locale = 'zh-CN';
        } else if (docLang?.startsWith('en')) {
            _locale = 'en-US';
        } else {
            // navigator.language 通常反映系统偏好
            const navLang = navigator.language;
            if (navLang?.startsWith('zh')) {
                _locale = 'zh-CN';
            } else {
                // 默认中文，而不是依赖 Intl（在某些平台上不稳定）
                _locale = 'zh-CN';
            }
        }
    }
    return _locale === 'zh-CN';
}

// ── i18n ─────────────────────────────────────────────────────────────────────

const T: Record<string, { zh: string; en: string }> = {
    tabDashboard: { zh: '实时状态', en: 'Dashboard' },
    tabConfig: { zh: '设置', en: 'Config' },
    sectionMoss: { zh: '安全分析引擎', en: 'Security Analysis Engine' },
    masterSwitch: { zh: '安全网关总开关', en: 'Security Gateway Master Switch' },
    masterSwitchDesc: {
        zh: '关闭后所有安全审查能力停止工作，即使试验性功能已开启',
        en: 'When disabled, all security inspection capabilities stop working, even if experimental features are enabled'
    },
    llmTitle: { zh: 'LLM 深度分析', en: 'LLM Deep Analysis' },
    llmEnable: { zh: '启用 LLM 语义分析（Layer 3）', en: 'Enable LLM Semantic Analysis (Layer 3)' },
    llmModel: { zh: '分析模型', en: 'Analysis Model' },
    llmModelDefault: { zh: '默认模型', en: 'Default Model' },
    llmTimeout: { zh: '超时', en: 'Timeout' },
    llmTimeoutUnit: { zh: '秒', en: 's' },
    securityTitle: { zh: '安全拦截策略', en: 'Security Interception Policy' },
    securityLevel: { zh: '拦截程度', en: 'Interception Level' },
    securityLevelLow: { zh: '低 — 仅弹窗提醒，不拦截', en: 'Low — Warning only, no interception' },
    securityLevelMedium: {
        zh: '中 — 高风险拦截，低风险提示 override（推荐）',
        en: 'Medium — Block high-risk, prompt override for others (Recommended)'
    },
    securityLevelHigh: { zh: '高 — 所有 deny 一律直接拦截', en: 'High — Block all deny decisions' },
    securityDescLow: {
        zh: '所有 deny 仅弹窗提醒，不会阻止命令执行。适用于宽松安全策略。',
        en: 'All denies only show warnings without blocking execution.'
    },
    securityDescMedium: {
        zh: '高风险(high/critical)直接拦截；低中风险拦截并提示 override 方式（推荐）。',
        en: 'High/critical risk operations are blocked; low/medium risk prompts override option (Recommended).'
    },
    securityDescHigh: {
        zh: '所有 deny 一律直接拦截，不提供 override。适用于严格安全环境。',
        en: 'All denies are blocked with no override option.'
    },
    rulesTitle: { zh: '自定义安全规则', en: 'Custom Security Rules' },
    rulesAdd: { zh: '+ 添加规则', en: '+ Add Rule' },
    rulesPatternPlaceholder: { zh: '正则匹配模式, 如 rm -rf /', en: 'Regex pattern, e.g. rm -rf /' },
    confirm: { zh: '确认', en: 'Confirm' },
    cancel: { zh: '取消', en: 'Cancel' },
    sectionGate: { zh: '数据网关服务', en: 'Data Gateway Service' },
    labelMoss: { zh: '安全分析引擎', en: 'Analysis Engine' },
    labelGate: { zh: '安全网关服务', en: 'Gateway Service' },
    storageTitle: { zh: '数据存储', en: 'Data Storage' },
    storageSqlite: { zh: 'SQLite 数据库', en: 'SQLite Database' },
    storageJson: { zh: 'JSON 文件', en: 'JSON Files' },
    storageActive: { zh: '（当前）', en: '(Active)' },
    storageSwitchWarning: {
        zh: '切换存储类型将重启 AgentGate 服务，请确认路径正确。',
        en: 'Switching storage type will restart the AgentGate service. Please confirm the path is correct.'
    },
    storageSqliteUnavailable: {
        zh: 'SQLite 模块不可用，已自动切换为 JSON 文件存储。',
        en: 'SQLite module unavailable. Automatically switched to JSON file storage.'
    },
    dbPathLabel: { zh: '数据库路径', en: 'Database Path' },
    jsonPathLabel: { zh: '文件路径', en: 'File Path' },
    pathEdit: { zh: '修改', en: 'Edit' },
    pathApply: { zh: '确认生效', en: 'Apply' },
    pathConfirmMsg: {
        zh: '修改路径将重启 AgentGate 服务。请确认路径正确。',
        en: 'Changing the path will restart the AgentGate service. Please confirm the path is correct.'
    },
    statusTitle: { zh: '服务状态', en: 'Service Status' },
    statusRunning: { zh: '运行中', en: 'Running' },
    statusStopped: { zh: '已停止', en: 'Stopped' },
    statusChecking: { zh: '检测中...', en: 'Checking...' },
    statusStartFailed: { zh: '安全网关启动失败', en: 'Security Gateway Failed to Start' },
    dashboardLoading: { zh: '加载中...', en: 'Loading...' },
    dashboardLoadFailed: { zh: '实时状态加载失败', en: 'Dashboard failed to load' },
    dashboardUnreachable: { zh: '安全网关服务未连接', en: 'Security gateway service unreachable' },
    masterSwitchOff: { zh: '安全网关总开关已关闭', en: 'Master Switch Off' },
    masterSwitchOffHint: {
        zh: '请打开总开关以启用安全监控',
        en: 'Enable the master switch to activate security monitoring'
    },
    connecting: { zh: '正在连接安全网关服务...', en: 'Connecting to security gateway...' },
    floatingWindowTitle: { zh: '安全网关浮窗', en: 'Security Gateway Floating Window' },
    floatingWindowSwitch: { zh: '显示浮窗', en: 'Show Floating Window' },
    floatingWindowSwitchDesc: {
        zh: '在会话界面右上角显示半透明浮窗，实时显示拦截/放行记录',
        en: 'Show a semi-transparent floating window at the top-right corner to display interception records'
    },
    floatingWindowOpacity: { zh: '浮窗透明度', en: 'Floating Window Opacity' },
    floatingWindowOpacityDesc: {
        zh: '调整浮窗的透明度（0.3 为极透明，1.0 为不透明）',
        en: 'Adjust floating window transparency (0.3 = very transparent, 1.0 = opaque)'
    },
    resetFloatingWindow: { zh: '重置初始状态', en: 'Reset to Default' },
    prevPage: { zh: '上一页', en: 'Prev' },
    nextPage: { zh: '下一页', en: 'Next' },
    pageInfo: { zh: '第 {page} / {total} 页（共 {count} 条）', en: 'Page {page} / {total} ({count} records)' },
    perPage: { zh: '每页', en: 'Per page' }
};

function tr(key: string): string {
    const entry = T[key];
    return entry ? (isZh() ? entry.zh : entry.en) : key;
}

// ── CSS ──────────────────────────────────────────────────────────────────────

const STYLE = `
:host {
    display: block; width: 100%; height: 100%; overflow: hidden;
    --ag-bg: #f5f5f7;
    --ag-card-bg: rgba(255,255,255,.72);
    --ag-card-border: rgba(255,255,255,.5);
    --ag-text: #1d1d1f;
    --ag-text-secondary: #6e6e73;
    --ag-text-tertiary: #aeaeb2;
    --ag-text-heading: #1d1d1f;
    --ag-accent: #007AFF;
    --ag-accent-hover: #005EC4;
    --ag-red: #FF3B30;
    --ag-green: #34C759;
    --ag-orange: #FF9500;
    --ag-input-bg: rgba(255,255,255,.6);
    --ag-input-border: rgba(0,0,0,.08);
    --ag-input-focus-ring: rgba(0,122,255,.3);
    --ag-divider: rgba(0,0,0,.06);
    --ag-code-bg: rgba(0,0,0,.04);
    --ag-danger-bg: rgba(255,59,48,.06);
    --ag-danger-border: rgba(255,59,48,.18);
    --ag-tab-active-border: #007AFF;
    --ag-tab-inactive: #aeaeb2;
    --ag-status-dot-running: #34C759;
    --ag-status-dot-stopped: #aeaeb2;
    --ag-badge-deny-bg: rgba(255,59,48,.12);
    --ag-badge-allow-bg: rgba(52,199,89,.12);
    /* Dashboard 变量（Shadow DOM 内 :root 失效，由 :host 提供） */
    --red: #FF3B30;
    --orange: #FF9500;
    --yellow: #FFCC00;
    --green: #34C759;
    --muted: #aeaeb2;
    --card-bg: #fff;
    --border: rgba(0,0,0,.06);
    color-scheme: light;
    background: var(--ag-bg);
    color: var(--ag-text);
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', sans-serif;
    -webkit-font-smoothing: antialiased;
}
:host([data-theme="dark"]) {
    --ag-bg: #1c1c1e;
    --ag-card-bg: rgba(44,44,46,.75);
    --ag-card-border: rgba(255,255,255,.08);
    --ag-text: #e5e5e7;
    --ag-text-secondary: #98989d;
    --ag-text-tertiary: #636366;
    --ag-text-heading: #e5e5e7;
    --ag-accent: #0A84FF;
    --ag-accent-hover: #409CFF;
    --ag-input-bg: rgba(255,255,255,.08);
    --ag-input-border: rgba(255,255,255,.1);
    --ag-input-focus-ring: rgba(10,132,255,.35);
    --ag-divider: rgba(255,255,255,.08);
    --ag-code-bg: rgba(255,255,255,.06);
    --ag-danger-bg: rgba(255,69,58,.12);
    --ag-danger-border: rgba(255,69,58,.25);
    --ag-tab-active-border: #0A84FF;
    --ag-tab-inactive: #636366;
    --ag-status-dot-running: #30D158;
    --ag-status-dot-stopped: #636366;
    --ag-badge-deny-bg: rgba(255,69,58,.18);
    --ag-badge-allow-bg: rgba(48,209,88,.18);
    /* Dashboard 变量（深色模式） */
    --red: #FF453A;
    --orange: #FF9F0A;
    --yellow: #FFD60A;
    --green: #30D158;
    --muted: #636366;
    --card-bg: rgba(44,44,46,.75);
    --border: rgba(255,255,255,.08);
    color-scheme: dark;
}
*, *::before, *::after { box-sizing: border-box; }

/* Layout */
.ag-wrap { display: flex; flex-direction: column; height: 100%; }
.ag-tabs {
    display: flex; align-items: flex-end;
    border-bottom: 1px solid var(--ag-divider);
    padding: 20px 20px 0;
    background: transparent;
}
.ag-tab {
    padding: 8px 16px 7px; font-size: 13px; font-weight: 500;
    cursor: pointer; border-bottom: 2px solid transparent;
    user-select: none; color: var(--ag-tab-inactive); transition: color .2s;
}
.ag-tab:hover { color: var(--ag-text); }
.ag-tab.active { color: var(--ag-accent); border-bottom-color: var(--ag-tab-active-border); }
.ag-panel { flex: 1; overflow: auto; padding: 20px; }
.ag-panel.hidden { display: none; }

/* Cards & Sections */
.ag-card {
    background: var(--ag-card-bg);
    backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
    border-radius: 14px; border: 1px solid var(--ag-card-border);
    box-shadow: 0 2px 8px rgba(0,0,0,.04);
    padding: 16px; margin-bottom: 16px;
}
:host([data-theme="dark"]) .ag-card { box-shadow: 0 4px 12px rgba(0,0,0,.25); }
.ag-section-title {
    font-size: 13px; font-weight: 600; color: var(--ag-text-heading);
    margin: 0 0 14px; display: flex; align-items: center; gap: 8px;
}
.ag-section-title::before {
    content: ''; display: block; width: 3px; height: 14px;
    background: var(--ag-accent); border-radius: 2px;
}
.ag-section-desc { font-size: 12px; color: var(--ag-text-secondary); line-height: 1.5; margin: 0 0 14px; }
.ag-form-row { margin-bottom: 14px; }
.ag-form-row:last-child { margin-bottom: 0; }
.ag-label { display: block; font-size: 12px; font-weight: 500; color: var(--ag-text-secondary); margin-bottom: 6px; }
.ag-row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

/* Inputs & Selects */
.ag-input, .ag-select {
    width: 100%; padding: 8px 10px; font-size: 13px;
    border: 1px solid var(--ag-input-border); border-radius: 8px;
    background: var(--ag-input-bg); color: var(--ag-text);
    outline: none; transition: border-color .2s, box-shadow .2s;
    -webkit-appearance: none;
}
.ag-input:focus, .ag-select:focus { border-color: var(--ag-accent); box-shadow: 0 0 0 3px var(--ag-input-focus-ring); }
.ag-input::placeholder { color: var(--ag-text-tertiary); }

/* Range Slider */
.ag-range {
    -webkit-appearance: none; appearance: none;
    width: 100%; height: 6px; border-radius: 3px;
    background: var(--ag-input-border); outline: none; cursor: pointer;
}
:host([data-theme="dark"]) .ag-range { background: #48484a; }
.ag-range::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none;
    width: 18px; height: 18px; border-radius: 50%;
    background: var(--ag-accent); cursor: pointer;
    box-shadow: 0 1px 4px rgba(0,0,0,.15);
}

/* Toggle Switch */
.ag-toggle {
    position: relative; width: 42px; height: 24px;
    border-radius: 12px; border: none; background: #d1d5db;
    cursor: pointer; transition: background .22s ease; padding: 0; flex-shrink: 0;
}
:host([data-theme="dark"]) .ag-toggle { background: #48484a; }
.ag-toggle.on { background: var(--ag-accent); }
:host([data-theme="dark"]) .ag-toggle.on { background: #C94C40; }
.ag-toggle-knob {
    position: absolute; top: 2px; left: 2px; width: 20px; height: 20px;
    border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.15);
    transition: transform .22s ease;
}
.ag-toggle.on .ag-toggle-knob { transform: translateX(18px); }
.ag-toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ag-toggle-row-label { font-size: 13px; font-weight: 500; color: var(--ag-text); }

/* Buttons */
.ag-btn {
    display: inline-flex; align-items: center; justify-content: center;
    padding: 6px 14px; font-size: 12px; font-weight: 500;
    border-radius: 8px; cursor: pointer; transition: all .2s; border: none; gap: 6px;
}
.ag-btn-primary { background: var(--ag-accent); color: #fff; }
.ag-btn-primary:hover { background: var(--ag-accent-hover); }
.ag-btn-ghost { background: transparent; color: var(--ag-accent); border: 1px solid var(--ag-accent); }
.ag-btn-ghost:hover { background: rgba(0,122,255,.06); }
.ag-btn-danger { background: transparent; color: var(--ag-red); border: 1px solid var(--ag-red); }
.ag-btn-danger:hover { background: var(--ag-danger-bg); }
.ag-btn-muted { background: transparent; color: var(--ag-text-secondary); }
.ag-btn-muted:hover { background: rgba(0,0,0,.04); }
.ag-btn-sm { padding: 4px 10px; font-size: 11px; border-radius: 6px; }

/* Rules List */
.ag-rule-item {
    display: flex; align-items: center; gap: 8px; padding: 8px 0;
    border-bottom: 1px solid var(--ag-divider); font-size: 13px;
}
.ag-rule-item:last-child { border-bottom: none; }
.ag-rule-pattern {
    flex: 1; background: var(--ag-code-bg); padding: 3px 6px; border-radius: 5px;
    font-family: 'SF Mono', monospace; font-size: 11px; color: var(--ag-text);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ag-badge {
    display: inline-block; min-width: 48px; text-align: center;
    padding: 2px 6px; border-radius: 8px; font-size: 10px; font-weight: 600;
}
.ag-badge-deny { background: var(--ag-badge-deny-bg); color: var(--ag-red); }
.ag-badge-allow { background: var(--ag-badge-allow-bg); color: var(--ag-green); }
.ag-rule-form {
    margin-top: 12px; padding: 12px; background: var(--ag-card-bg);
    border-radius: 10px; border: 1px solid var(--ag-divider);
}
.ag-rule-form-row { display: flex; gap: 8px; margin-top: 8px; }
.ag-rule-form-row:first-child { margin-top: 0; }

/* Status */
.ag-status-row {
    display: flex; align-items: center; font-size: 13px; color: var(--ag-text-secondary); padding: 4px 0;
}
.ag-status-label { width: 90px; flex-shrink: 0; }
.ag-status-dot {
    display: inline-block; width: 6px; height: 6px; border-radius: 50%;
    margin-right: 6px;
}
.ag-status-dot-running { background: var(--ag-status-dot-running); }
.ag-status-dot-stopped { background: var(--ag-status-dot-stopped); }
.ag-divider { border: none; border-top: 1px solid var(--ag-divider); margin: 20px 0; }

/* Highlight row animation */
.ag-highlight-row {
    background: rgba(0,122,255,.10) !important;
    border-left: 3px solid #007AFF !important;
    transition: background 0.3s ease;
}
:host([data-theme="dark"]) .ag-highlight-row {
    background: rgba(10,132,255,.18) !important;
    border-left: 3px solid #4dabff !important;
}
@keyframes ag-highlight-pulse {
    0%   { background: rgba(0,122,255,.18) !important; }
    20%  { background: rgba(0,122,255,.12) !important; }
    100% { background: rgba(0,122,255,.06) !important; }
}
@keyframes ag-highlight-pulse-dark {
    0%   { background: rgba(10,132,255,.22) !important; }
    20%  { background: rgba(10,132,255,.14) !important; }
    100% { background: rgba(10,132,255,.08) !important; }
}

/* Pagination */
.ag-pagination {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 14px;
    font-size: 12px;
    color: var(--ag-text);
    background: rgba(255,255,255,.88);
    border: 1px solid rgba(0,0,0,.10);
    border-radius: 12px;
    margin-top: 8px;
}
.ag-pagination .page-nav {
    display: flex;
    align-items: center;
    gap: 8px;
}
.ag-pagination button {
    padding: 4px 12px;
    border-radius: 6px;
    border: 1px solid rgba(0,0,0,.14);
    background: rgba(255,255,255,.9);
    color: var(--ag-text);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
}
.ag-pagination button:hover:not(:disabled) {
    background: var(--ag-accent);
    color: #fff;
    border-color: var(--ag-accent);
}
.ag-pagination button:disabled {
    opacity: 0.35;
    cursor: default;
}
.ag-pagination .page-info {
    font-weight: 600;
    color: var(--ag-text);
}
.ag-pagination .page-size-group {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 4px;
}
.ag-pagination .page-size-select {
    padding: 2px 6px;
    border-radius: 6px;
    border: 1px solid rgba(0,0,0,.14);
    background: rgba(255,255,255,.9);
    color: var(--ag-text);
    font-size: 12px;
    cursor: pointer;
}
`;

// ── Dashboard Modern Theme Injection ─────────────────────────────────────────

const DASH_LIGHT = `
/* Dashboard Modern Theme - Light */
.ag-dash-panel {
    background: transparent !important;
    padding: 0 !important;
}
.ag-dash-panel > * {
    animation: dashFadeIn .3s ease;
}
@keyframes dashFadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
}

/* Header */
.ag-dash-panel .dashboard-header,
.ag-dash-panel > div:first-child {
    background: var(--ag-card-bg) !important;
    backdrop-filter: blur(24px) !important;
    -webkit-backdrop-filter: blur(24px) !important;
    border-radius: 14px !important;
    border: 1px solid var(--ag-card-border) !important;
    padding: 16px 20px !important;
    margin-bottom: 16px !important;
    box-shadow: 0 2px 8px rgba(0,0,0,.04) !important;
    display: flex !important;
    align-items: center !important;
    justify-content: space-between !important;
}
.ag-dash-panel .dashboard-header h1,
.ag-dash-panel .dashboard-header .title,
.ag-dash-panel > div:first-child h1,
.ag-dash-panel > div:first-child .title {
    font-size: 18px !important;
    font-weight: 600 !important;
    color: var(--ag-text-heading) !important;
    margin: 0 !important;
    display: flex !important;
    align-items: center !important;
    gap: 8px !important;
}
.ag-dash-panel .dashboard-header h1::before,
.ag-dash-panel .dashboard-header .title::before {
    content: '' !important;
    display: block !important;
    width: 4px !important;
    height: 18px !important;
    background: var(--ag-accent) !important;
    border-radius: 2px !important;
}
.ag-dash-panel .clock,
.ag-dash-panel #clock {
    font-size: 13px !important;
    color: var(--ag-text-tertiary) !important;
    font-variant-numeric: tabular-nums !important;
}

/* Stats Cards */
.ag-dash-panel .stats-row,
.ag-dash-panel .stats,
.ag-dash-panel > div:nth-child(2) {
    display: grid !important;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)) !important;
    gap: 12px !important;
    margin-bottom: 16px !important;
}
.ag-dash-panel .stat-card,
.ag-dash-panel .stat,
.ag-dash-panel [class*="stat"] {
    background: var(--ag-card-bg) !important;
    backdrop-filter: blur(24px) !important;
    -webkit-backdrop-filter: blur(24px) !important;
    border-radius: 12px !important;
    border: 1px solid var(--ag-card-border) !important;
    padding: 14px 16px !important;
    box-shadow: 0 2px 8px rgba(0,0,0,.04) !important;
    transition: transform .2s, box-shadow .2s !important;
}
.ag-dash-panel .stat-card:hover,
.ag-dash-panel .stat:hover {
    transform: translateY(-2px) !important;
    box-shadow: 0 4px 12px rgba(0,0,0,.08) !important;
}
.ag-dash-panel .stat-label,
.ag-dash-panel .stat-card .label {
    font-size: 11px !important;
    font-weight: 500 !important;
    color: var(--ag-text-secondary) !important;
    text-transform: uppercase !important;
    letter-spacing: .5px !important;
    margin-bottom: 6px !important;
}
.ag-dash-panel .stat-value,
.ag-dash-panel .stat-card .value {
    font-size: 28px !important;
    font-weight: 700 !important;
    color: var(--ag-text-heading) !important;
    font-variant-numeric: tabular-nums !important;
    line-height: 1 !important;
}
.ag-dash-panel .stat-value.allow,
.ag-dash-panel .stat-card .value.allow { color: var(--ag-green) !important; }
.ag-dash-panel .stat-value.deny,
.ag-dash-panel .stat-card .value.deny { color: var(--ag-red) !important; }
.ag-dash-panel .stat-value.latency,
.ag-dash-panel .stat-card .value.latency { font-size: 22px !important; }

/* Risk Bar */
.ag-dash-panel .risk-bar,
.ag-dash-panel [id="risk-bar"],
.ag-dash-panel .risk-segment {
    height: 6px !important;
    border-radius: 3px !important;
    overflow: hidden !important;
    margin-bottom: 10px !important;
    background: var(--ag-divider) !important;
}
.ag-dash-panel .risk-bar > div,
.ag-dash-panel [id="risk-bar"] > div {
    height: 100% !important;
    transition: width .3s ease !important;
}
.ag-dash-panel .risk-legend,
.ag-dash-panel [id="risk-legend"] {
    display: flex !important;
    flex-wrap: wrap !important;
    gap: 12px !important;
    font-size: 11px !important;
    color: var(--ag-text-secondary) !important;
}
.ag-dash-panel .risk-dot {
    display: inline-block !important;
    width: 6px !important;
    height: 6px !important;
    border-radius: 50% !important;
    margin-right: 4px !important;
    vertical-align: middle !important;
}

/* Tabs */
.ag-dash-panel .tabs,
.ag-dash-panel .tab-bar {
    display: flex !important;
    gap: 4px !important;
    border-bottom: 1px solid var(--ag-divider) !important;
    padding-bottom: 0 !important;
    margin-bottom: 16px !important;
}
.ag-dash-panel .tab {
    padding: 8px 16px !important;
    font-size: 13px !important;
    font-weight: 500 !important;
    color: var(--ag-tab-inactive) !important;
    cursor: pointer !important;
    border-bottom: 2px solid transparent !important;
    margin-bottom: -1px !important;
    transition: color .2s !important;
    user-select: none !important;
    background: none !important;
    border-top: none !important;
    border-left: none !important;
    border-right: none !important;
    border-radius: 0 !important;
}
.ag-dash-panel .tab:hover { color: var(--ag-text) !important; }
.ag-dash-panel .tab.active {
    color: var(--ag-accent) !important;
    border-bottom-color: var(--ag-tab-active-border) !important;
}

/* Tables */
.ag-dash-panel table {
    width: 100% !important;
    border-collapse: collapse !important;
    font-size: 12px !important;
    background: var(--ag-card-bg) !important;
    backdrop-filter: blur(24px) !important;
    -webkit-backdrop-filter: blur(24px) !important;
    border-radius: 12px !important;
    border: 1px solid var(--ag-card-border) !important;
    overflow: hidden !important;
    box-shadow: 0 2px 8px rgba(0,0,0,.04) !important;
}
.ag-dash-panel thead { background: transparent !important; }
.ag-dash-panel th {
    padding: 12px 14px !important;
    text-align: left !important;
    font-size: 11px !important;
    font-weight: 600 !important;
    color: var(--ag-text-secondary) !important;
    text-transform: uppercase !important;
    letter-spacing: .5px !important;
    border-bottom: 1px solid var(--ag-divider) !important;
    background: transparent !important;
}
.ag-dash-panel td {
    padding: 10px 14px !important;
    color: var(--ag-text) !important;
    border-bottom: 1px solid var(--ag-divider) !important;
    vertical-align: middle !important;
}
.ag-dash-panel tbody tr:last-child td { border-bottom: none !important; }
.ag-dash-panel tbody tr {
    transition: background .15s !important;
}
.ag-dash-panel tbody tr:hover {
    background: rgba(0,122,255,.04) !important;
}
.ag-dash-panel code {
    background: var(--ag-code-bg) !important;
    padding: 2px 6px !important;
    border-radius: 4px !important;
    font-family: 'SF Mono', 'JetBrains Mono', monospace !important;
    font-size: 11px !important;
    color: var(--ag-text) !important;
}

/* Badges */
.ag-dash-panel .badge,
.ag-dash-panel [class*="badge"] {
    display: inline-flex !important;
    align-items: center !important;
    padding: 2px 8px !important;
    border-radius: 6px !important;
    font-size: 10px !important;
    font-weight: 600 !important;
    text-transform: uppercase !important;
    letter-spacing: .3px !important;
}
.ag-dash-panel .badge-allow,
.ag-dash-panel [class*="badge-allow"] {
    background: var(--ag-badge-allow-bg) !important;
    color: var(--ag-green) !important;
}
.ag-dash-panel .badge-deny,
.ag-dash-panel [class*="badge-deny"] {
    background: var(--ag-badge-deny-bg) !important;
    color: var(--ag-red) !important;
}

/* Scrollbar */
.ag-dash-panel ::-webkit-scrollbar { width: 6px; height: 6px; }
.ag-dash-panel ::-webkit-scrollbar-track { background: transparent; }
.ag-dash-panel ::-webkit-scrollbar-thumb { background: rgba(0,0,0,.12); border-radius: 3px; }
.ag-dash-panel ::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,.2); }
`;

const DASH_DARK = `
/* Dashboard Modern Theme - Dark */
.ag-dash-panel {
    background: transparent !important;
    padding: 0 !important;
}
.ag-dash-panel > * {
    animation: dashFadeIn .3s ease;
}
@keyframes dashFadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
}

/* Header */
.ag-dash-panel .dashboard-header,
.ag-dash-panel > div:first-child {
    background: var(--ag-card-bg) !important;
    backdrop-filter: blur(24px) !important;
    -webkit-backdrop-filter: blur(24px) !important;
    border-radius: 14px !important;
    border: 1px solid var(--ag-card-border) !important;
    padding: 16px 20px !important;
    margin-bottom: 16px !important;
    box-shadow: 0 4px 16px rgba(0,0,0,.2) !important;
    display: flex !important;
    align-items: center !important;
    justify-content: space-between !important;
}
.ag-dash-panel .dashboard-header h1,
.ag-dash-panel .dashboard-header .title,
.ag-dash-panel > div:first-child h1,
.ag-dash-panel > div:first-child .title {
    font-size: 18px !important;
    font-weight: 600 !important;
    color: var(--ag-text-heading) !important;
    margin: 0 !important;
    display: flex !important;
    align-items: center !important;
    gap: 8px !important;
}
.ag-dash-panel .dashboard-header h1::before,
.ag-dash-panel .dashboard-header .title::before {
    content: '' !important;
    display: block !important;
    width: 4px !important;
    height: 18px !important;
    background: var(--ag-accent) !important;
    border-radius: 2px !important;
}
.ag-dash-panel .clock,
.ag-dash-panel #clock {
    font-size: 13px !important;
    color: var(--ag-text-tertiary) !important;
    font-variant-numeric: tabular-nums !important;
}

/* Stats Cards */
.ag-dash-panel .stats-row,
.ag-dash-panel .stats,
.ag-dash-panel > div:nth-child(2) {
    display: grid !important;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)) !important;
    gap: 12px !important;
    margin-bottom: 16px !important;
}
.ag-dash-panel .stat-card,
.ag-dash-panel .stat,
.ag-dash-panel [class*="stat"] {
    background: var(--ag-card-bg) !important;
    backdrop-filter: blur(24px) !important;
    -webkit-backdrop-filter: blur(24px) !important;
    border-radius: 12px !important;
    border: 1px solid var(--ag-card-border) !important;
    padding: 14px 16px !important;
    box-shadow: 0 4px 16px rgba(0,0,0,.2) !important;
    transition: transform .2s, box-shadow .2s !important;
}
.ag-dash-panel .stat-card:hover,
.ag-dash-panel .stat:hover {
    transform: translateY(-2px) !important;
    box-shadow: 0 6px 20px rgba(0,0,0,.3) !important;
}
.ag-dash-panel .stat-label,
.ag-dash-panel .stat-card .label {
    font-size: 11px !important;
    font-weight: 500 !important;
    color: var(--ag-text-secondary) !important;
    text-transform: uppercase !important;
    letter-spacing: .5px !important;
    margin-bottom: 6px !important;
}
.ag-dash-panel .stat-value,
.ag-dash-panel .stat-card .value {
    font-size: 28px !important;
    font-weight: 700 !important;
    color: var(--ag-text-heading) !important;
    font-variant-numeric: tabular-nums !important;
    line-height: 1 !important;
}
.ag-dash-panel .stat-value.allow,
.ag-dash-panel .stat-card .value.allow { color: var(--ag-green) !important; }
.ag-dash-panel .stat-value.deny,
.ag-dash-panel .stat-card .value.deny { color: var(--ag-red) !important; }
.ag-dash-panel .stat-value.latency,
.ag-dash-panel .stat-card .value.latency { font-size: 22px !important; }

/* Risk Bar */
.ag-dash-panel .risk-bar,
.ag-dash-panel [id="risk-bar"],
.ag-dash-panel .risk-segment {
    height: 6px !important;
    border-radius: 3px !important;
    overflow: hidden !important;
    margin-bottom: 10px !important;
    background: var(--ag-divider) !important;
}
.ag-dash-panel .risk-bar > div,
.ag-dash-panel [id="risk-bar"] > div {
    height: 100% !important;
    transition: width .3s ease !important;
}
.ag-dash-panel .risk-legend,
.ag-dash-panel [id="risk-legend"] {
    display: flex !important;
    flex-wrap: wrap !important;
    gap: 12px !important;
    font-size: 11px !important;
    color: var(--ag-text-secondary) !important;
}
.ag-dash-panel .risk-dot {
    display: inline-block !important;
    width: 6px !important;
    height: 6px !important;
    border-radius: 50% !important;
    margin-right: 4px !important;
    vertical-align: middle !important;
}

/* Tabs */
.ag-dash-panel .tabs,
.ag-dash-panel .tab-bar {
    display: flex !important;
    gap: 4px !important;
    border-bottom: 1px solid var(--ag-divider) !important;
    padding-bottom: 0 !important;
    margin-bottom: 16px !important;
}
.ag-dash-panel .tab {
    padding: 8px 16px !important;
    font-size: 13px !important;
    font-weight: 500 !important;
    color: var(--ag-tab-inactive) !important;
    cursor: pointer !important;
    border-bottom: 2px solid transparent !important;
    margin-bottom: -1px !important;
    transition: color .2s !important;
    user-select: none !important;
    background: none !important;
    border-top: none !important;
    border-left: none !important;
    border-right: none !important;
    border-radius: 0 !important;
}
.ag-dash-panel .tab:hover { color: var(--ag-text) !important; }
.ag-dash-panel .tab.active {
    color: var(--ag-accent) !important;
    border-bottom-color: var(--ag-tab-active-border) !important;
}

/* Tables */
.ag-dash-panel table {
    width: 100% !important;
    border-collapse: collapse !important;
    font-size: 12px !important;
    background: var(--ag-card-bg) !important;
    backdrop-filter: blur(24px) !important;
    -webkit-backdrop-filter: blur(24px) !important;
    border-radius: 12px !important;
    border: 1px solid var(--ag-card-border) !important;
    overflow: hidden !important;
    box-shadow: 0 4px 16px rgba(0,0,0,.2) !important;
}
.ag-dash-panel thead { background: transparent !important; }
.ag-dash-panel th {
    padding: 12px 14px !important;
    text-align: left !important;
    font-size: 11px !important;
    font-weight: 600 !important;
    color: var(--ag-text-secondary) !important;
    text-transform: uppercase !important;
    letter-spacing: .5px !important;
    border-bottom: 1px solid var(--ag-divider) !important;
    background: transparent !important;
}
.ag-dash-panel td {
    padding: 10px 14px !important;
    color: var(--ag-text) !important;
    border-bottom: 1px solid var(--ag-divider) !important;
    vertical-align: middle !important;
}
.ag-dash-panel tbody tr:last-child td { border-bottom: none !important; }
.ag-dash-panel tbody tr {
    transition: background .15s !important;
}
.ag-dash-panel tbody tr:hover {
    background: rgba(10,132,255,.08) !important;
}
.ag-dash-panel code {
    background: var(--ag-code-bg) !important;
    padding: 2px 6px !important;
    border-radius: 4px !important;
    font-family: 'SF Mono', 'JetBrains Mono', monospace !important;
    font-size: 11px !important;
    color: var(--ag-text) !important;
}

/* Badges */
.ag-dash-panel .badge,
.ag-dash-panel [class*="badge"] {
    display: inline-flex !important;
    align-items: center !important;
    padding: 2px 8px !important;
    border-radius: 6px !important;
    font-size: 10px !important;
    font-weight: 600 !important;
    text-transform: uppercase !important;
    letter-spacing: .3px !important;
}
.ag-dash-panel .badge-allow,
.ag-dash-panel [class*="badge-allow"] {
    background: var(--ag-badge-allow-bg) !important;
    color: var(--ag-green) !important;
}
.ag-dash-panel .badge-deny,
.ag-dash-panel [class*="badge-deny"] {
    background: var(--ag-badge-deny-bg) !important;
    color: var(--ag-red) !important;
}

/* Scrollbar */
.ag-dash-panel ::-webkit-scrollbar { width: 6px; height: 6px; }
.ag-dash-panel ::-webkit-scrollbar-track { background: transparent; }
.ag-dash-panel ::-webkit-scrollbar-thumb { background: rgba(255,255,255,.15); border-radius: 3px; }
.ag-dash-panel ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,.25); }
`;

function injectDashTheme(panel: HTMLElement): void {
    const dark = isDark();
    panel.querySelector('#ag-dash-theme')?.remove();

    // 添加统一的容器类
    panel.classList.add('ag-dash-panel');

    if (dark) {
        panel.classList.add('ag-dash-dark');
        panel.classList.remove('ag-dash-light');
        const s = document.createElement('style');
        s.id = 'ag-dash-theme';
        s.textContent = DASH_DARK;
        panel.insertBefore(s, panel.firstChild);
    } else {
        panel.classList.add('ag-dash-light');
        panel.classList.remove('ag-dash-dark');
        const s = document.createElement('style');
        s.id = 'ag-dash-theme';
        s.textContent = DASH_LIGHT;
        panel.insertBefore(s, panel.firstChild);
    }
}

/** 根据当前 locale 替换 dashboard HTML 中的英文文本为中文 */
function injectDashLocale(panel: HTMLElement): void {
    if (!isZh()) return; // 英文时不需要替换（dashboard 默认就是英文）
    const replace = (selector: string, text: string) => {
        const el = panel.querySelector(selector);
        if (el) el.textContent = text;
    };
    // Header
    replace('.header h1', '安全网关实时状态');
    // Stats card labels ( Agents / Sessions / Tool Calls / Allow / Deny / Avg Latency )
    const labels = panel.querySelectorAll('.card .label');
    const zhLabels = ['智能体', '会话', '工具调用', '放行', '拦截', '平均延迟'];
    labels.forEach((l, i) => {
        if (zhLabels[i]) l.textContent = zhLabels[i];
    });
    // Tab labels ( Recent Calls / Agents / Timeline )
    const tabs = panel.querySelectorAll('.tab');
    const zhTabs = ['近期调用', '智能体', '时间线'];
    tabs.forEach((t, i) => {
        if (zhTabs[i]) t.textContent = zhTabs[i];
    });
    // Table headers
    const ths = panel.querySelectorAll('th');
    const zhTh = [
        '时间',
        '智能体',
        '会话',
        '命令',
        '决策',
        '风险',
        '延迟',
        '原因',
        '智能体类型',
        '主机',
        '会话数',
        '调用数',
        '时间',
        '放行',
        '拦截'
    ];
    ths.forEach((th, i) => {
        if (zhTh[i]) th.textContent = zhTh[i];
    });
}

// ── Templates ────────────────────────────────────────────────────────────────

function connectingHTML(): string {
    return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;background:var(--ag-bg);color:var(--ag-text-secondary);padding:40px;text-align:center;">
  <div style="font-size:48px;margin-bottom:16px;line-height:1;">🔗</div>
  <h2 style="font-size:16px;font-weight:600;color:var(--ag-text);margin:0 0 8px;">${tr('connecting')}</h2>
  <p style="font-size:13px;margin:0 0 24px;color:var(--ag-text-secondary);">${isZh() ? '请确认安全网关服务已启动（默认端口 9100）' : 'Please ensure the security gateway service is running (default port 9100)'}</p>
  <div id="ag-bridge-error" style="display:none;max-width:400px;margin:0 0 16px;padding:10px 14px;background:var(--ag-danger-bg);border:1px solid var(--ag-danger-border);border-radius:8px;font-size:12px;color:var(--ag-red);line-height:1.5;text-align:left;word-break:break-all;white-space:pre-wrap;"></div>
  <button id="ag-retry" style="padding:8px 20px;border-radius:10px;border:none;background:var(--ag-accent);color:#fff;font-size:14px;font-weight:600;cursor:pointer;">${isZh() ? '重新检测' : 'Retry'}</button>
</div>`;
}

function emptyDashboardHTML(): string {
    return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;background:var(--ag-bg);color:var(--ag-text-secondary);padding:40px;text-align:center;">
  <div style="font-size:64px;margin-bottom:16px;line-height:1;">🛡️</div>
  <h2 style="font-size:18px;font-weight:600;color:var(--ag-text);margin:0 0 8px;">${tr('masterSwitchOff')}</h2>
  <p style="font-size:14px;margin:0;color:var(--ag-text-secondary);line-height:1.6;">${tr('masterSwitchOffHint')}</p>
  <p style="font-size:12px;margin-top:20px;color:var(--ag-text-tertiary);">${isZh() ? '切换到「设置」标签页开启总开关' : 'Switch to the Config tab to enable the master switch'}</p>
</div>`;
}

function configHTML(): string {
    return `
<h3 class="ag-section-title">${tr('sectionMoss')}</h3>

<div class="ag-card">
    <div class="ag-toggle-row">
        <div>
            <div class="ag-toggle-row-label">${tr('masterSwitch')}</div>
            <div style="font-size:12px;color:var(--ag-text-secondary);margin-top:4px;line-height:1.4;">${tr('masterSwitchDesc')}</div>
        </div>
        <button id="ag-master" class="ag-toggle on" role="switch" aria-checked="true"><span class="ag-toggle-knob"></span></button>
    </div>
</div>

<div class="ag-card">
    <h3 class="ag-section-title" style="margin-top:0;">${tr('llmTitle')}</h3>
    <div class="ag-toggle-row" style="margin-bottom:14px;">
        <span class="ag-toggle-row-label">${tr('llmEnable')}</span>
        <button id="ag-llm-toggle" class="ag-toggle on" role="switch" aria-checked="true"><span class="ag-toggle-knob"></span></button>
    </div>
    <div class="ag-row-2">
        <div class="ag-form-row">
            <label class="ag-label">${tr('llmModel')}</label>
            <select id="ag-llm-model" class="ag-select"><option value="">${tr('llmModelDefault')}</option></select>
        </div>
        <div class="ag-form-row">
            <label class="ag-label">${tr('llmTimeout')} (${tr('llmTimeoutUnit')})</label>
            <input id="ag-llm-timeout" type="number" min="10" max="600" value="300" class="ag-input">
        </div>
    </div>
</div>

<div class="ag-card">
    <h3 class="ag-section-title" style="margin-top:0;">${tr('securityTitle')}</h3>
    <div class="ag-form-row">
        <label class="ag-label">${tr('securityLevel')}</label>
        <select id="ag-sec-level" class="ag-select">
            <option value="low">${tr('securityLevelLow')}</option>
            <option value="medium" selected>${tr('securityLevelMedium')}</option>
            <option value="high">${tr('securityLevelHigh')}</option>
        </select>
    </div>
    <div id="ag-sec-desc" style="font-size:12px;color:var(--ag-text-secondary);line-height:1.5;"></div>
</div>

<div class="ag-card">
    <h3 class="ag-section-title" style="margin-top:0;">${tr('rulesTitle')}</h3>
    <div id="ag-rules"></div>
    <div style="margin-top:10px;">
        <button id="ag-add-rule" class="ag-btn ag-btn-ghost ag-btn-sm">${tr('rulesAdd')}</button>
    </div>
    <div id="ag-rule-form" class="ag-rule-form" style="display:none;">
        <div class="ag-rule-form-row">
            <input id="ag-rule-pat" class="ag-input" placeholder="${tr('rulesPatternPlaceholder')}" style="flex:1;">
        </div>
        <div class="ag-rule-form-row">
            <select id="ag-rule-act" class="ag-select" style="flex:1;"><option value="Deny">Deny</option><option value="Allow">Allow</option></select>
            <select id="ag-rule-sev" class="ag-select" style="flex:1;">
                <option value="critical">Critical</option><option value="high">High</option><option value="medium" selected>Medium</option><option value="low">Low</option>
            </select>
            <button id="ag-rule-save" class="ag-btn ag-btn-primary ag-btn-sm">${tr('confirm')}</button>
            <button id="ag-rule-cancel" class="ag-btn ag-btn-muted ag-btn-sm">${tr('cancel')}</button>
        </div>
    </div>
</div>

<hr class="ag-divider">

<h3 class="ag-section-title">${tr('floatingWindowTitle')}</h3>

<div class="ag-card">
    <div class="ag-toggle-row">
        <div>
            <div class="ag-toggle-row-label">${tr('floatingWindowSwitch')}</div>
            <div style="font-size:12px;color:var(--ag-text-secondary);margin-top:4px;line-height:1.4;">${tr('floatingWindowSwitchDesc')}</div>
        </div>
        <button id="ag-floating-toggle" class="ag-toggle" role="switch" aria-checked="false"><span class="ag-toggle-knob"></span></button>
    </div>
    <div class="ag-form-row" style="margin-top:14px;">
        <label class="ag-label">${tr('floatingWindowOpacity')}</label>
        <div style="display:flex;align-items:center;gap:10px;">
            <input id="ag-floating-opacity" type="range" min="0.3" max="1.0" step="0.02" value="0.76" class="ag-range" style="flex:1;">
            <span id="ag-floating-opacity-val" style="font-size:13px;color:var(--ag-text-secondary);min-width:36px;">0.76</span>
        </div>
        <div style="font-size:12px;color:var(--ag-text-secondary);margin-top:4px;line-height:1.4;">${tr('floatingWindowOpacityDesc')}</div>
    </div>
    <div style="margin-top:12px;text-align:right;">
        <button id="ag-floating-reset" class="ag-btn ag-btn-muted ag-btn-sm">${tr('resetFloatingWindow')}</button>
    </div>
</div>

<hr class="ag-divider">

<h3 class="ag-section-title">${tr('sectionGate')}</h3>

<div class="ag-card">
    <h3 class="ag-section-title" style="margin-top:0;">${tr('storageTitle')}</h3>
    <!-- Radio 选择存储类型 -->
    <div style="display:flex;gap:16px;margin-bottom:12px;">
        <label id="ag-storage-sqlite-label" style="cursor:pointer;display:flex;align-items:center;gap:6px;font-size:14px;">
            <input type="radio" id="ag-storage-sqlite" name="ag-storage-type" value="sqlite" style="accent-color:var(--ag-accent);">
            <span>${tr('storageSqlite')}</span>
            <span id="ag-storage-sqlite-active" class="ag-storage-active-tag" style="display:none;font-size:11px;color:var(--ag-green);font-weight:600;">${tr('storageActive')}</span>
        </label>
        <label id="ag-storage-json-label" style="cursor:pointer;display:flex;align-items:center;gap:6px;font-size:14px;">
            <input type="radio" id="ag-storage-json" name="ag-storage-type" value="json" style="accent-color:var(--ag-accent);">
            <span>${tr('storageJson')}</span>
            <span id="ag-storage-json-active" class="ag-storage-active-tag" style="display:none;font-size:11px;color:var(--ag-green);font-weight:600;">${tr('storageActive')}</span>
        </label>
    </div>
    <!-- SQLite 路径 -->
    <div id="ag-sqlite-path-section" style="margin-bottom:8px;">
        <div style="font-size:12px;color:var(--ag-text-secondary);margin-bottom:4px;">${tr('dbPathLabel')}</div>
        <div class="ag-form-row">
            <input id="ag-db" readonly class="ag-input" style="color:var(--ag-text-secondary);">
        </div>
        <div style="display:flex;gap:8px;">
            <button id="ag-db-edit" class="ag-btn ag-btn-ghost ag-btn-sm">${tr('pathEdit')}</button>
            <button id="ag-db-ok" class="ag-btn ag-btn-danger ag-btn-sm" style="display:none;">${tr('pathApply')}</button>
            <button id="ag-db-cancel" class="ag-btn ag-btn-muted ag-btn-sm" style="display:none;">${tr('cancel')}</button>
        </div>
        <div id="ag-db-msg" style="display:none;margin-top:10px;padding:10px;background:var(--ag-danger-bg);border:1px solid var(--ag-danger-border);border-radius:8px;font-size:12px;color:var(--ag-red);line-height:1.4;">${tr('pathConfirmMsg')}</div>
    </div>
    <!-- JSON 路径 -->
    <div id="ag-json-path-section" style="display:none;margin-bottom:8px;">
        <div style="font-size:12px;color:var(--ag-text-secondary);margin-bottom:4px;">${tr('jsonPathLabel')}</div>
        <div class="ag-form-row">
            <input id="ag-json-dir" readonly class="ag-input" style="color:var(--ag-text-secondary);">
        </div>
        <div style="display:flex;gap:8px;">
            <button id="ag-json-edit" class="ag-btn ag-btn-ghost ag-btn-sm">${tr('pathEdit')}</button>
            <button id="ag-json-ok" class="ag-btn ag-btn-danger ag-btn-sm" style="display:none;">${tr('pathApply')}</button>
            <button id="ag-json-cancel" class="ag-btn ag-btn-muted ag-btn-sm" style="display:none;">${tr('cancel')}</button>
        </div>
        <div id="ag-json-msg" style="display:none;margin-top:10px;padding:10px;background:var(--ag-danger-bg);border:1px solid var(--ag-danger-border);border-radius:8px;font-size:12px;color:var(--ag-red);line-height:1.4;">${tr('pathConfirmMsg')}</div>
    </div>
    <!-- 切换存储类型警告 -->
    <div id="ag-storage-switch-msg" style="display:none;margin-top:10px;padding:10px;background:var(--ag-danger-bg);border:1px solid var(--ag-danger-border);border-radius:8px;font-size:12px;color:var(--ag-red);line-height:1.4;">
        ${tr('storageSwitchWarning')}
        <button id="ag-storage-switch-ok" class="ag-btn ag-btn-danger ag-btn-sm" style="margin-left:8px;">${tr('pathApply')}</button>
    </div>
    <!-- SQLite 不可用警告 -->
    <div id="ag-sqlite-unavailable-msg" style="display:none;margin-top:10px;padding:10px;background:rgba(255,149,0,.06);border:1px solid rgba(255,149,0,.18);border-radius:8px;font-size:12px;color:var(--ag-orange);line-height:1.4;">${tr('storageSqliteUnavailable')}</div>
</div>

<div class="ag-card">
    <h3 class="ag-section-title" style="margin-top:0;">${tr('statusTitle')}</h3>
    <div class="ag-status-row"><span class="ag-status-label">${tr('labelMoss')}</span><span class="ag-status-dot ag-status-dot-stopped"></span><span id="ag-moss-st">${tr('statusChecking')}</span><span style="margin-left:8px;font-size:12px;" id="ag-moss-addr"></span></div>
    <div class="ag-status-row" style="margin-top:4px;"><span class="ag-status-label">${tr('labelGate')}</span><span class="ag-status-dot ag-status-dot-stopped"></span><span id="ag-gate-st">${tr('statusChecking')}</span><span style="margin-left:8px;font-size:12px;" id="ag-gate-addr"></span></div>
    <div id="ag-bridge-error" style="display:none;margin-top:8px;padding:8px 12px;background:var(--ag-danger-bg);border:1px solid var(--ag-danger-border);border-radius:6px;font-size:12px;color:var(--ag-red);line-height:1.5;word-break:break-all;white-space:pre-wrap;"></div>
</div>`;
}

// ── Widget ───────────────────────────────────────────────────────────────────

class AgentGateEntryWidget extends HTMLElement {
    shadow: ShadowRoot;
    root: HTMLElement;
    _highlightEventId: string | null = null;
    _highlightedRowId: string | null = null;
    _currentPage: number = 1;
    _pageSize: number = 20;
    _totalRecords: number = 0;
    _refreshFn: (() => Promise<void>) | null = null;
    _refreshTimer: ReturnType<typeof setInterval> | null = null;
    _refreshRunning = false;
    _settingUnsub: (() => void) | null = null;

    constructor() {
        super();
        this.shadow = this.attachShadow({ mode: 'open' });
        this.root = document.createElement('div');
        this.root.className = 'ag-wrap';
        this.shadow.appendChild(this.root);
    }

    connectedCallback() {
        const style = document.createElement('style');
        style.textContent = STYLE;
        this.shadow.insertBefore(style, this.shadow.firstChild);

        this.dataset.theme = getEffectiveTheme();
        document.addEventListener('opendesk-theme-changed', ((e: CustomEvent) => {
            this.dataset.theme = e.detail?.effective || getEffectiveTheme();
            const dash = this.shadow.querySelector('#ag-dash') as HTMLElement;
            if (dash) injectDashTheme(dash);
        }) as EventListener);

        // Read highlightEventId from URL hash (when iframe is freshly opened)
        try {
            const hash = window.location.hash;
            const match = hash.match(/highlightEventId=([^&]+)/);
            if (match) this._highlightEventId = decodeURIComponent(match[1]);
        } catch {}

        // Listen for postMessage (when iframe is already cached)
        window.addEventListener('message', ((e: MessageEvent) => {
            // NAVIGATE_TO_DASHBOARD：无论在哪个 tab，都切换到 dashboard
            if (e.data?.type === 'NAVIGATE_TO_DASHBOARD') {
                this._switchToDashboardTab();
            }
            // HIGHLIGHT_EVENT：切换到 dashboard tab 并高亮指定记录
            if (e.data?.type === 'HIGHLIGHT_EVENT') {
                if (e.data.highlightEventId) {
                    this._highlightEventId = e.data.highlightEventId;
                }
                this._switchToDashboardTab();
                // Immediately trigger refresh to show highlight (don't wait for next 10s cycle)
                if (this._refreshFn) this._refreshFn();
            }
            // LOCALE_CHANGED：主窗口通知 locale 变化，重新渲染 UI
            if (e.data?.type === 'LOCALE_CHANGED' && e.data.locale) {
                const newLocale = e.data.locale as string;
                if (newLocale !== _locale) {
                    _locale = newLocale;
                    _localePromise = null;
                    this._init();
                }
            }
        }) as EventListener);

        getLocale().then(() => this._init());
    }

    async _init() {
        this.root.innerHTML = `
            <div class="ag-tabs">
                <div class="ag-tab active" data-tab="dashboard">${tr('tabDashboard')}</div>
                <div class="ag-tab" data-tab="config">${tr('tabConfig')}</div>
            </div>
            <div id="ag-dash" class="ag-panel"></div>
            <div id="ag-conf" class="ag-panel hidden"></div>
        `;

        // Tabs
        this.shadow.querySelectorAll('.ag-tab').forEach((t) => {
            t.addEventListener('click', () => {
                this.shadow.querySelectorAll('.ag-tab').forEach((x) => x.classList.remove('active'));
                t.classList.add('active');
                const target = t.dataset.tab;
                (this.shadow.querySelector('#ag-dash') as HTMLElement).classList.toggle(
                    'hidden',
                    target !== 'dashboard'
                );
                (this.shadow.querySelector('#ag-conf') as HTMLElement).classList.toggle('hidden', target !== 'config');
                if (target === 'dashboard') this._renderDash();
                if (target === 'config') this._loadModels();
            });
        });

        this._renderDash();
        this._initConf();
    }

    /** 切换到 dashboard tab（供浮窗跳转时调用，不重新 fetch） */
    _switchToDashboardTab() {
        const tabs = this.shadow.querySelectorAll('.ag-tab');
        tabs.forEach((x) => x.classList.remove('active'));
        const dashTab = this.shadow.querySelector('.ag-tab[data-tab="dashboard"]');
        if (dashTab) dashTab.classList.add('active');
        (this.shadow.querySelector('#ag-dash') as HTMLElement).classList.remove('hidden');
        (this.shadow.querySelector('#ag-conf') as HTMLElement).classList.add('hidden');
        // 不调用 _renderDash()，避免和 refresh interval 冲突导致交替清空
        // 仅在 dashboard 未初始化时才首次渲染
        const dash = this.shadow.querySelector('#ag-dash') as HTMLElement;
        if (!dash.children.length) {
            this._renderDash();
        }
    }

    async _renderDash() {
        const panel = this.shadow.querySelector('#ag-dash') as HTMLElement;

        // 检查总开关状态
        let enabled = true;
        try {
            enabled = await (window as any).applicationAPI?.callMainWorld('getEnabled');
        } catch {}
        if (enabled === false) {
            panel.innerHTML = emptyDashboardHTML();
            return;
        }

        // 总开关已开启，尝试连接安全网关服务
        this._connectDash();
    }

    async _connectDash(retry = 0) {
        const panel = this.shadow.querySelector('#ag-dash') as HTMLElement;
        if (retry === 0)
            panel.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--ag-text-secondary);font-size:14px;">${tr('dashboardLoading')}</div>`;

        let healthData: any = null;
        try {
            const r = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
            if (r.ok) {
                healthData = await r.json();
                this._loadDash(panel, healthData);
                return;
            }
        } catch {}

        if (retry === 0) {
            panel.innerHTML = connectingHTML();
            const btn = this.shadow.querySelector('#ag-retry');
            btn?.addEventListener('click', () => this._connectDash(0));
        }

        // 查询主进程 Bridge 状态，显示具体错误原因
        let bridgeError: string | null = null;
        let bridgeRunning = false;
        try {
            const status = await (window as any).applicationAPI?.callMainWorld('getBridgeStatus');
            if (status) {
                bridgeRunning = !!status.running;
                bridgeError = status.lastError || null;
            }
        } catch {
            /* callMainWorld unavailable in some contexts */
        }

        // 若已有错误信息，提前展示给用户
        if (bridgeError) {
            const errBox = panel.querySelector('#ag-bridge-error') as HTMLElement | null;
            if (errBox) {
                errBox.style.display = '';
                errBox.textContent = bridgeError;
            }
        }

        // 若 Bridge 已停止且存在不可恢复的错误，重试耗尽后显示启动失败
        if (!bridgeRunning && bridgeError && retry >= 9) {
            panel.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;background:var(--ag-bg);color:var(--ag-text-secondary);padding:40px;text-align:center;">
  <div style="font-size:48px;margin-bottom:16px;line-height:1;">⚠️</div>
  <h2 style="font-size:16px;font-weight:600;color:var(--ag-text);margin:0 0 8px;">${tr('statusStartFailed')}</h2>
  <div style="max-width:400px;margin:0 0 16px;padding:10px 14px;background:var(--ag-danger-bg);border:1px solid var(--ag-danger-border);border-radius:8px;font-size:12px;color:var(--ag-red);line-height:1.5;text-align:left;word-break:break-all;white-space:pre-wrap;">${bridgeError}</div>
  <button id="ag-retry" style="padding:8px 20px;border-radius:10px;border:none;background:var(--ag-accent);color:#fff;font-size:14px;font-weight:600;cursor:pointer;">${isZh() ? '重新检测' : 'Retry'}</button>
</div>`;
            const btn = this.shadow.querySelector('#ag-retry');
            btn?.addEventListener('click', () => this._connectDash(0));
            return;
        }

        if (retry < 9) {
            const h2 = panel.querySelector('h2');
            if (h2) h2.textContent = `${tr('connecting')} (${retry + 1}/10)`;
            setTimeout(() => this._connectDash(retry + 1), retry === 0 ? 500 : 1500);
        } else {
            // 重试耗尽，显示无法连接状态
            panel.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;background:var(--ag-bg);color:var(--ag-text-secondary);padding:40px;text-align:center;">
  <div style="font-size:48px;margin-bottom:16px;line-height:1;">⚠️</div>
  <h2 style="font-size:16px;font-weight:600;color:var(--ag-text);margin:0 0 8px;">${tr('dashboardUnreachable')}</h2>
  <p style="font-size:13px;margin:0 0 24px;color:var(--ag-text-secondary);">${isZh() ? '请确认安全网关服务已启动（默认端口 9100）' : 'Please ensure the security gateway service is running (default port 9100)'}</p>
  <button id="ag-retry" style="padding:8px 20px;border-radius:10px;border:none;background:var(--ag-accent);color:#fff;font-size:14px;font-weight:600;cursor:pointer;">${isZh() ? '重新检测' : 'Retry'}</button>
</div>`;
            const btn = this.shadow.querySelector('#ag-retry');
            btn?.addEventListener('click', () => this._connectDash(0));
        }
    }

    async _loadDash(panel: HTMLElement, healthData?: any) {
        try {
            const r = await fetch(DASHBOARD_URL);
            if (r.ok) {
                panel.innerHTML = await r.text();
                injectDashTheme(panel);
                injectDashLocale(panel);

                // Inject pagination container after recent-table
                const recentTable = panel.querySelector('#recent-table');
                if (recentTable && recentTable.parentElement) {
                    const paginationDiv = document.createElement('div');
                    paginationDiv.id = 'ag-pagination';
                    paginationDiv.className = 'ag-pagination';
                    recentTable.parentElement.insertBefore(paginationDiv, recentTable.nextSibling);
                }

                // Update footer immediately with health data from _connectDash
                if (healthData) {
                    const footer = panel.querySelector('#footer') as HTMLElement;
                    if (footer) {
                        const gateV = healthData.version || 'N/A';
                        const mossV = healthData.moss_version || 'N/A';
                        const mossS = healthData.moss_status || 'unknown';
                        let mossLabel = mossV === 'N/A' ? 'AgentMoss N/A' : `AgentMoss v${mossV}`;
                        if (mossS === 'healthy') mossLabel += ' ✓';
                        footer.textContent = `AgentGate v${gateV} + ${mossLabel} (TypeScript)`;
                    }
                }

                // Dashboard internal tabs
                panel.querySelectorAll('.tab').forEach((tab) => {
                    (tab as HTMLElement).style.cursor = 'pointer';
                    tab.addEventListener('click', () => {
                        panel.querySelectorAll('.tab').forEach((t) => {
                            (t as HTMLElement).className = 'tab';
                        });
                        (tab as HTMLElement).className = 'tab active';
                        const p = (tab as HTMLElement).dataset.panel;
                        ['calls', 'agents', 'timeline'].forEach((id) => {
                            const el = panel.querySelector('#' + id + '-panel') as HTMLElement;
                            if (el) el.style.display = id === p ? 'block' : 'none';
                        });
                    });
                });

                // Clock
                const clk = panel.querySelector('#clock');
                if (clk) {
                    const tick = () => {
                        clk.textContent = new Date().toLocaleString(isZh() ? 'zh-CN' : 'en-US');
                    };
                    tick();
                    setInterval(tick, 1000);
                }

                // Helper: build HTML rows via DOM fragment to avoid esbuild SSR parsing issues
                const buildRows = (data: any[], renderer: (item: any) => HTMLElement[]) => {
                    const fragment = document.createDocumentFragment();
                    for (const item of data) {
                        const cells = renderer(item);
                        const tr = document.createElement('tr');
                        for (const cell of cells) tr.appendChild(cell);
                        fragment.appendChild(tr);
                    }
                    return fragment;
                };

                // Stats refresh
                const refresh = async () => {
                    // Prevent concurrent refresh (postMessage + setInterval could overlap)
                    if (this._refreshRunning) return;
                    this._refreshRunning = true;
                    this._refreshFn = refresh;
                    try {
                        const offset = (this._currentPage - 1) * this._pageSize;
                        const [tc, tcAll, ag, tl] = await Promise.all([
                            fetch(`${BASE_URL}/api/v1/tool_calls?limit=${this._pageSize}&offset=${offset}`),
                            fetch(`${BASE_URL}/api/v1/tool_calls?limit=200`),
                            fetch(`${BASE_URL}/api/v1/agents`),
                            fetch(`${BASE_URL}/api/v1/timeline?minutes=60`)
                        ]);
                        const tcData = await tc.json();
                        // API may return array or {data, total} object
                        let arr = Array.isArray(tcData) ? tcData : Array.isArray(tcData.data) ? tcData.data : [];
                        const tcTotal = Array.isArray(tcData) ? arr.length : (tcData.total ?? arr.length);
                        this._totalRecords = tcTotal;
                        const allArr = await tcAll
                            .json()
                            .then((r: any) => (Array.isArray(r) ? r : Array.isArray(r.data) ? r.data : []));
                        const agents = await ag.json().then((r: any) => (Array.isArray(r) ? r : []));
                        const timeline = await tl.json().then((r: any) => (Array.isArray(r) ? r : []));

                        // Stats should reflect ALL records, not just current page
                        const allow = allArr.filter((x: any) => x.decision === 'Allow').length;
                        const deny = allArr.filter((x: any) => x.decision === 'Deny').length;
                        const sessions = new Set(allArr.map((x: any) => x.session_id)).size;

                        const setText = (id: string, v: string) => {
                            const el = panel.querySelector('#' + id);
                            if (el) el.textContent = v;
                        };
                        setText('stat-agents', String(agents.length));
                        setText('stat-total', String(tcTotal));
                        setText('stat-sessions', String(sessions));
                        setText('stat-allow', String(allow));
                        setText('stat-deny', String(deny));
                        const avg = allArr.length
                            ? Math.round(
                                  allArr.reduce((s: number, x: any) => s + (x.analysis_duration_ms || 0), 0) /
                                      allArr.length
                              )
                            : 0;
                        setText('stat-latency', avg + 'ms');

                        const lv: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
                        allArr.forEach((x: any) => {
                            if (x.risk_level in lv) lv[x.risk_level]++;
                        });
                        const tot = lv.critical + lv.high + lv.medium + lv.low || 1;
                        const rb = panel.querySelector('#risk-bar');
                        const rl = panel.querySelector('#risk-legend');
                        if (rb)
                            rb.innerHTML = `<div style="width:${(lv.critical / tot) * 100}%;background:var(--red)"></div><div style="width:${(lv.high / tot) * 100}%;background:var(--orange)"></div><div style="width:${(lv.medium / tot) * 100}%;background:var(--yellow)"></div><div style="width:${(lv.low / tot) * 100}%;background:var(--muted)"></div>`;
                        if (rl)
                            rl.innerHTML = isZh()
                                ? `<span><span class="risk-dot" style="background:var(--red)"></span>极危 ${lv.critical}</span><span><span class="risk-dot" style="background:var(--orange)"></span>高危 ${lv.high}</span><span><span class="risk-dot" style="background:var(--yellow)"></span>中危 ${lv.medium}</span><span><span class="risk-dot" style="background:var(--muted)"></span>低危 ${lv.low}</span>`
                                : `<span><span class="risk-dot" style="background:var(--red)"></span>Critical ${lv.critical}</span><span><span class="risk-dot" style="background:var(--orange)"></span>High ${lv.high}</span><span><span class="risk-dot" style="background:var(--yellow)"></span>Medium ${lv.medium}</span><span><span class="risk-dot" style="background:var(--muted)"></span>Low ${lv.low}</span>`;

                        // Render recent calls table via DOM manipulation
                        // When highlight request arrives, locate the target event in allArr,
                        // calculate its page, and navigate there. Then render with arr (current page).
                        const newHlId = this._highlightEventId;
                        if (newHlId) {
                            this._highlightedRowId = newHlId;
                            this._highlightEventId = null;
                            // Find target in allArr and jump to its page
                            const targetIdx = allArr.findIndex((x: any) => x.id === newHlId);
                            if (targetIdx >= 0) {
                                this._currentPage = Math.floor(targetIdx / this._pageSize) + 1;
                            } else {
                                this._currentPage = 1;
                            }
                            // Re-fetch current page data with the new offset
                            const newOffset = (this._currentPage - 1) * this._pageSize;
                            try {
                                const pageR = await fetch(
                                    `${BASE_URL}/api/v1/tool_calls?limit=${this._pageSize}&offset=${newOffset}`
                                );
                                const pageData = await pageR.json();
                                arr = Array.isArray(pageData)
                                    ? pageData
                                    : Array.isArray(pageData.data)
                                      ? pageData.data
                                      : [];
                            } catch {}
                        }
                        const hlId = this._highlightedRowId;
                        const displayArr = arr;
                        const tbody = panel.querySelector('#recent-table');
                        if (tbody) {
                            const loc = isZh() ? 'zh-CN' : 'en-US';
                            tbody.innerHTML = '';
                            const rows = buildRows(displayArr, (x: any) => {
                                const tr_cells: HTMLElement[] = [];
                                // Time
                                const tdTime = document.createElement('td');
                                tdTime.textContent = x.called_at
                                    ? new Date(x.called_at + 'Z').toLocaleString(loc, {
                                          month: '2-digit',
                                          day: '2-digit',
                                          hour: '2-digit',
                                          minute: '2-digit',
                                          second: '2-digit'
                                      })
                                    : '-';
                                tr_cells.push(tdTime);
                                // Agent type
                                const tdAgent = document.createElement('td');
                                tdAgent.textContent = x.agent_type || '-';
                                tr_cells.push(tdAgent);
                                // Session
                                const tdSession = document.createElement('td');
                                tdSession.textContent = x.session_id || '-';
                                tr_cells.push(tdSession);
                                // Command
                                const tdCmd = document.createElement('td');
                                const codeEl = document.createElement('code');
                                codeEl.textContent = x.command || x.action_detail || '-';
                                tdCmd.appendChild(codeEl);
                                tr_cells.push(tdCmd);
                                // Decision badge
                                const tdDecision = document.createElement('td');
                                const badge = document.createElement('span');
                                badge.className = 'badge ' + (x.decision === 'Allow' ? 'badge-allow' : 'badge-deny');
                                badge.textContent = isZh() ? (x.decision === 'Allow' ? '放行' : '拦截') : x.decision;
                                tdDecision.appendChild(badge);
                                tr_cells.push(tdDecision);
                                // Risk level
                                const tdRisk = document.createElement('td');
                                const riskColors: Record<string, string> = {
                                    critical: 'var(--red)',
                                    high: 'var(--orange)',
                                    medium: 'var(--yellow)',
                                    low: 'var(--muted)'
                                };
                                tdRisk.style.color = riskColors[x.risk_level] || 'var(--muted)';
                                const riskZh: Record<string, string> = {
                                    critical: '极危',
                                    high: '高危',
                                    medium: '中危',
                                    low: '低危'
                                };
                                tdRisk.textContent = isZh()
                                    ? riskZh[x.risk_level] || x.risk_level || '-'
                                    : x.risk_level || '-';
                                tr_cells.push(tdRisk);
                                // Latency
                                const tdLatency = document.createElement('td');
                                tdLatency.textContent = Math.round(x.analysis_duration_ms || 0) + 'ms';
                                tr_cells.push(tdLatency);
                                // Reason
                                const tdReason = document.createElement('td');
                                tdReason.textContent = x.reason || '-';
                                tr_cells.push(tdReason);
                                return tr_cells;
                            });
                            // Set data-event-id and highlight class on each row
                            for (let i = 0; i < displayArr.length; i++) {
                                const row = rows.children[i] as HTMLElement;
                                if (row) {
                                    row.setAttribute('data-event-id', displayArr[i].id || '');
                                    if (hlId && displayArr[i].id === hlId) row.classList.add('ag-highlight-row');
                                }
                            }
                            tbody.appendChild(rows);

                            // Scroll highlighted row into view (only on first highlight render)
                            if (newHlId) {
                                const hlRow = tbody.querySelector(`tr[data-event-id="${newHlId}"]`);
                                if (hlRow) hlRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            }
                            // If the highlighted row is not on the current page, clear it
                            if (this._highlightedRowId && !arr.find((x: any) => x.id === this._highlightedRowId)) {
                                this._highlightedRowId = null;
                            }
                        }

                        // Pagination controls
                        const totalPages = Math.max(1, Math.ceil(this._totalRecords / this._pageSize));
                        const paginationContainer = panel.querySelector('#ag-pagination') as HTMLElement | null;
                        if (paginationContainer) {
                            paginationContainer.innerHTML = '';
                            const btnPrev = document.createElement('button');
                            btnPrev.textContent = tr('prevPage');
                            btnPrev.disabled = this._currentPage <= 1;
                            btnPrev.addEventListener('click', () => {
                                this._currentPage--;
                                refresh();
                            });
                            const pageLabel = document.createElement('span');
                            pageLabel.className = 'page-info';
                            pageLabel.textContent = tr('pageInfo')
                                .replace('{page}', String(this._currentPage))
                                .replace('{total}', String(totalPages))
                                .replace('{count}', String(this._totalRecords));
                            const btnNext = document.createElement('button');
                            btnNext.textContent = tr('nextPage');
                            btnNext.disabled = this._currentPage >= totalPages;
                            btnNext.addEventListener('click', () => {
                                this._currentPage++;
                                refresh();
                            });
                            // Per-page selector
                            const pageSizeLabel = document.createElement('span');
                            pageSizeLabel.className = 'page-info';
                            pageSizeLabel.textContent = tr('perPage');
                            const pageSizeSelect = document.createElement('select');
                            pageSizeSelect.className = 'page-size-select';
                            [10, 20, 50, 100].forEach((size) => {
                                const opt = document.createElement('option');
                                opt.value = String(size);
                                opt.textContent = String(size);
                                if (size === this._pageSize) opt.selected = true;
                                pageSizeSelect.appendChild(opt);
                            });
                            pageSizeSelect.addEventListener('change', () => {
                                this._pageSize = parseInt(pageSizeSelect.value, 10);
                                this._currentPage = 1;
                                refresh();
                            });
                            // Nav group: Prev | Page info | Next
                            const navGroup = document.createElement('div');
                            navGroup.className = 'page-nav';
                            navGroup.appendChild(btnPrev);
                            navGroup.appendChild(pageLabel);
                            navGroup.appendChild(btnNext);
                            // Size group: Per page [select] (pushed to right)
                            const sizeGroup = document.createElement('div');
                            sizeGroup.className = 'page-size-group';
                            sizeGroup.appendChild(pageSizeLabel);
                            sizeGroup.appendChild(pageSizeSelect);
                            paginationContainer.appendChild(navGroup);
                            paginationContainer.appendChild(sizeGroup);
                        }
                        const at = panel.querySelector('#agents-table');
                        if (at) {
                            at.innerHTML = '';
                            at.appendChild(
                                buildRows(agents, (a: any) => {
                                    const cells: HTMLElement[] = [];
                                    const td1 = document.createElement('td');
                                    td1.textContent = a.agent_type;
                                    cells.push(td1);
                                    const td2 = document.createElement('td');
                                    td2.textContent = a.hostname;
                                    cells.push(td2);
                                    const td3 = document.createElement('td');
                                    td3.textContent = String(a.session_count);
                                    cells.push(td3);
                                    const td4 = document.createElement('td');
                                    td4.textContent = String(a.call_count);
                                    cells.push(td4);
                                    return cells;
                                })
                            );
                        }
                        const tt = panel.querySelector('#timeline-table');
                        if (tt) {
                            tt.innerHTML = '';
                            tt.appendChild(
                                buildRows(timeline, (t: any) => {
                                    const cells: HTMLElement[] = [];
                                    const td1 = document.createElement('td');
                                    td1.textContent = t.time;
                                    cells.push(td1);
                                    const td2 = document.createElement('td');
                                    td2.textContent = String(t.allow);
                                    td2.style.color = 'var(--green)';
                                    cells.push(td2);
                                    const td3 = document.createElement('td');
                                    td3.textContent = String(t.deny);
                                    td3.style.color = 'var(--red)';
                                    cells.push(td3);
                                    return cells;
                                })
                            );
                        }

                        // Fetch versions from health API (dashboard.html <script> won't execute via innerHTML)
                        try {
                            const hR = await fetch(`${BASE_URL}/api/v1/health`);
                            const hData = await hR.json();
                            const gateV = hData.version || 'N/A';
                            const mossV = hData.moss_version || 'N/A';
                            const mossS = hData.moss_status || 'unknown';
                            const footer = panel.querySelector('#footer') as HTMLElement;
                            if (footer) {
                                let mossLabel = mossV === 'N/A' ? 'AgentMoss N/A' : `AgentMoss v${mossV}`;
                                if (mossS === 'healthy') mossLabel += ' ✓';
                                footer.textContent = `AgentGate v${gateV} + ${mossLabel} (TypeScript)`;
                            }
                        } catch {}
                    } catch {}
                    this._refreshRunning = false;
                };
                refresh();
                if (this._refreshTimer) clearInterval(this._refreshTimer);
                this._refreshTimer = setInterval(refresh, 10000);
            } else {
                panel.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--ag-text-secondary);">${tr('dashboardLoadFailed')} (${r.status})</div>`;
            }
        } catch {
            panel.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--ag-text-secondary);">${tr('dashboardUnreachable')}</div>`;
        }
    }

    async _initConf() {
        const panel = this.shadow.querySelector('#ag-conf') as HTMLElement;
        panel.innerHTML = configHTML();

        // Toggle helper
        const _tog = (el: HTMLElement | null, on: boolean) => {
            if (!el) return;
            el.classList.toggle('on', on);
            el.setAttribute('aria-checked', String(on));
        };

        // Master switch
        const ms = this.shadow.querySelector('#ag-master') as HTMLElement;
        if (ms) {
            try {
                const en = await (window as any).applicationAPI?.callMainWorld('getEnabled');
                _tog(ms, en !== false);
            } catch {}
            ms.addEventListener('click', () => {
                const on = !ms.classList.contains('on');
                _tog(ms, on);
                try {
                    (window as any).applicationAPI?.callMainWorld('setEnabled', on);
                } catch {}
                // 服务启动/停止由 main 进程处理，切回 Dashboard 标签页时自动刷新
            });
        }

        await this._loadModels();

        // 刷新服务状态区（显示真实运行状态与错误信息）
        this._refreshServiceStatus();

        // LLM toggle
        const llm = this.shadow.querySelector('#ag-llm-toggle') as HTMLElement;
        if (llm) {
            llm.addEventListener('click', () => {
                const on = !llm.classList.contains('on');
                _tog(llm, on);
                try {
                    (window as any).applicationAPI?.callMainWorld('setEnableLLM', on);
                } catch {}
            });
        }

        // LLM timeout
        const to = this.shadow.querySelector('#ag-llm-timeout') as HTMLInputElement;
        if (to) {
            to.addEventListener('blur', () => {
                const v = parseInt(to.value, 10);
                if (v >= 10 && v <= 600)
                    try {
                        (window as any).applicationAPI?.callMainWorld('setLLMTimeout', v);
                    } catch {}
            });
        }

        // Security level
        const sl = this.shadow.querySelector('#ag-sec-level') as HTMLSelectElement;
        const sd = this.shadow.querySelector('#ag-sec-desc') as HTMLElement;
        const dm: Record<string, string> = {
            low: tr('securityDescLow'),
            medium: tr('securityDescMedium'),
            high: tr('securityDescHigh')
        };
        const upd = (v: string) => {
            if (sd) sd.textContent = dm[v] || '';
        };

        try {
            const lv = await (window as any).applicationAPI?.callMainWorld('getSecurityLevel');
            if (lv && ['low', 'medium', 'high'].includes(lv)) {
                sl.value = lv;
                upd(lv);
            } else {
                upd('medium');
            }
        } catch {}
        if (sl) {
            sl.addEventListener('change', () => {
                upd(sl.value);
                try {
                    (window as any).applicationAPI?.callMainWorld('setSecurityLevel', sl.value);
                } catch {}
            });
        }

        // Floating window toggle
        const ft = this.shadow.querySelector('#ag-floating-toggle') as HTMLElement;
        if (ft) {
            try {
                const fwConfig = await (window as any).applicationAPI?.callMainWorld('getFloatingWindowConfig');
                const fwEnabled = fwConfig?.enabled || false;
                _tog(ft, fwEnabled);
            } catch {}
            ft.addEventListener('click', () => {
                const on = !ft.classList.contains('on');
                _tog(ft, on);
                try {
                    (window as any).applicationAPI?.callMainWorld('setFloatingWindowEnabled', on);
                } catch {}
            });
            // 监听 setting 变化，同步浮窗 toggle 和 opacity 状态（浮窗设置面板或重置按钮触发）
            try {
                const unsub = (window as any).settingAPI?.onSettingChanged?.(() => {
                    try {
                        (window as any).applicationAPI?.callMainWorld('getFloatingWindowConfig').then((cfg: any) => {
                            _tog(ft, cfg?.enabled || false);
                            // 同步透明度 slider
                            if (fo && fov && cfg?.opacity !== undefined) {
                                fo.value = String(cfg.opacity);
                                fov.textContent = cfg.opacity.toFixed(2);
                            }
                        });
                    } catch {}
                });
                // 存储 unsub 以便 disconnectedCallback 时清理
                this._settingUnsub = unsub;
            } catch {}
        }

        // Floating window opacity
        const fo = this.shadow.querySelector('#ag-floating-opacity') as HTMLInputElement;
        const fov = this.shadow.querySelector('#ag-floating-opacity-val') as HTMLElement;
        if (fo && fov) {
            try {
                const fwConfig = await (window as any).applicationAPI?.callMainWorld('getFloatingWindowConfig');
                const fwOpacity = fwConfig?.opacity ?? 0.76;
                fo.value = String(fwOpacity);
                fov.textContent = fwOpacity.toFixed(2);
            } catch {}
            fo.addEventListener('input', () => {
                const val = parseFloat(fo.value);
                fov.textContent = val.toFixed(2);
                try {
                    (window as any).applicationAPI?.callMainWorld('setFloatingWindowOpacity', val);
                } catch {}
            });
        }

        // Reset floating window button
        const resetBtn = this.shadow.querySelector('#ag-floating-reset') as HTMLElement;
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                try {
                    // 重置透明度到默认值 0.76（通过 setting:changed 自动同步到浮窗）
                    (window as any).applicationAPI?.callMainWorld('setFloatingWindowOpacity', 0.76);
                } catch {}
                try {
                    if (fo) fo.value = '0.76';
                    if (fov) fov.textContent = '0.76';
                } catch {}
                // 重置位置（通过 parent.postMessage 通知主 window）
                try {
                    window.parent.postMessage({ type: 'RESET_FLOATING_WINDOW_POSITION' }, '*');
                } catch {}
            });
        }

        // Storage type & paths
        const sqliteRadio = this.shadow.querySelector('#ag-storage-sqlite') as HTMLInputElement;
        const jsonRadio = this.shadow.querySelector('#ag-storage-json') as HTMLInputElement;
        const sqliteActive = this.shadow.querySelector('#ag-storage-sqlite-active') as HTMLElement;
        const jsonActive = this.shadow.querySelector('#ag-storage-json-active') as HTMLElement;
        const sqliteSection = this.shadow.querySelector('#ag-sqlite-path-section') as HTMLElement;
        const jsonSection = this.shadow.querySelector('#ag-json-path-section') as HTMLElement;
        const switchMsg = this.shadow.querySelector('#ag-storage-switch-msg') as HTMLElement;
        const sqliteUnavailMsg = this.shadow.querySelector('#ag-sqlite-unavailable-msg') as HTMLElement;

        // 用户选择的存储类型（radio checked 状态）
        let selectedType = 'sqlite';
        // 实际生效的存储类型（active 标记）
        let effectiveType = 'sqlite';

        try {
            selectedType =
                (await (window as any).applicationAPI?.callMainWorld('getStorageTypeConfigured')) || 'sqlite';
        } catch {}
        try {
            effectiveType = (await (window as any).applicationAPI?.callMainWorld('getStorageType')) || 'json';
        } catch {}

        // 检查 SQLite 是否可用
        let sqliteAvailable = true;
        try {
            const check = await (window as any).applicationAPI?.callMainWorld('checkSqliteAvailable');
            if (check && !check.available) {
                sqliteAvailable = false;
                sqliteUnavailMsg.style.display = '';
                // 禁用 sqlite radio
                if (sqliteRadio) sqliteRadio.disabled = true;
            }
        } catch {}

        const updateStorageUI = (type: string) => {
            // radio 显示用户选择的类型
            if (sqliteRadio) sqliteRadio.checked = type === 'sqlite';
            if (jsonRadio) jsonRadio.checked = type === 'json';
            // active 标记显示实际生效的类型
            if (sqliteActive) sqliteActive.style.display = effectiveType === 'sqlite' ? '' : 'none';
            if (jsonActive) jsonActive.style.display = effectiveType === 'json' ? '' : 'none';
            // 根据选择显示对应路径区域
            if (sqliteSection) sqliteSection.style.display = type === 'sqlite' ? '' : 'none';
            if (jsonSection) jsonSection.style.display = type === 'json' ? '' : 'none';
            // 如果选择的类型和实际生效不同，显示切换警告
            if (switchMsg) switchMsg.style.display = type !== effectiveType ? '' : 'none';
        };

        updateStorageUI(selectedType);

        // Radio 切换事件
        if (sqliteRadio) sqliteRadio.addEventListener('change', () => updateStorageUI('sqlite'));
        if (jsonRadio) jsonRadio.addEventListener('change', () => updateStorageUI('json'));

        // 切换存储类型确认按钮
        const switchOk = this.shadow.querySelector('#ag-storage-switch-ok') as HTMLElement;
        if (switchOk)
            switchOk.addEventListener('click', async () => {
                const newType = sqliteRadio?.checked ? 'sqlite' : 'json';
                try {
                    await (window as any).applicationAPI?.callMainWorld('setStorageType', newType);
                } catch {}
                selectedType = newType;
                effectiveType = newType;
                updateStorageUI(newType);
            });

        // SQLite path (db)
        const db = this.shadow.querySelector('#ag-db') as HTMLInputElement;
        const de = this.shadow.querySelector('#ag-db-edit') as HTMLElement;
        const dok = this.shadow.querySelector('#ag-db-ok') as HTMLElement;
        const dc = this.shadow.querySelector('#ag-db-cancel') as HTMLElement;
        const dm2 = this.shadow.querySelector('#ag-db-msg') as HTMLElement;

        try {
            const p = await (window as any).applicationAPI?.callMainWorld('getDbPath');
            if (db) db.value = p || '';
        } catch {}

        const enterDb = () => {
            if (db) db.removeAttribute('readonly');
            de.style.display = 'none';
            dok.style.display = '';
            dc.style.display = '';
            dm2.style.display = '';
        };
        const exitDb = async () => {
            try {
                const p = await (window as any).applicationAPI?.callMainWorld('getDbPath');
                if (db) db.value = p || '';
            } catch {}
            if (db) db.setAttribute('readonly', 'true');
            de.style.display = '';
            dok.style.display = 'none';
            dc.style.display = 'none';
            dm2.style.display = 'none';
        };

        if (de) de.addEventListener('click', enterDb);
        if (dc) dc.addEventListener('click', exitDb);
        if (dok)
            dok.addEventListener('click', async () => {
                const np = db?.value?.trim();
                if (np)
                    try {
                        await (window as any).applicationAPI?.callMainWorld('setDbPath', np);
                    } catch {}
                // 同时切换存储类型为 sqlite（如果当前不是 sqlite）
                const newType = sqliteRadio?.checked ? 'sqlite' : 'json';
                if (newType !== effectiveType) {
                    try {
                        await (window as any).applicationAPI?.callMainWorld('setStorageType', newType);
                    } catch {}
                    selectedType = newType;
                    effectiveType = newType;
                    updateStorageUI(newType);
                }
                exitDb();
            });

        // JSON path
        const jsonDir = this.shadow.querySelector('#ag-json-dir') as HTMLInputElement;
        const je = this.shadow.querySelector('#ag-json-edit') as HTMLElement;
        const jok = this.shadow.querySelector('#ag-json-ok') as HTMLElement;
        const jc = this.shadow.querySelector('#ag-json-cancel') as HTMLElement;
        const jm = this.shadow.querySelector('#ag-json-msg') as HTMLElement;

        try {
            const p = await (window as any).applicationAPI?.callMainWorld('getJsonDataDir');
            if (jsonDir) jsonDir.value = p || '';
        } catch {}

        const enterJson = () => {
            if (jsonDir) jsonDir.removeAttribute('readonly');
            je.style.display = 'none';
            jok.style.display = '';
            jc.style.display = '';
            jm.style.display = '';
        };
        const exitJson = async () => {
            try {
                const p = await (window as any).applicationAPI?.callMainWorld('getJsonDataDir');
                if (jsonDir) jsonDir.value = p || '';
            } catch {}
            if (jsonDir) jsonDir.setAttribute('readonly', 'true');
            je.style.display = '';
            jok.style.display = 'none';
            jc.style.display = 'none';
            jm.style.display = 'none';
        };

        if (je) je.addEventListener('click', enterJson);
        if (jc) jc.addEventListener('click', exitJson);
        if (jok)
            jok.addEventListener('click', async () => {
                const np = jsonDir?.value?.trim();
                if (np)
                    try {
                        await (window as any).applicationAPI?.callMainWorld('setJsonDataDir', np);
                    } catch {}
                // 同时切换存储类型为 json（如果当前不是 json）
                const newType = jsonRadio?.checked ? 'json' : 'sqlite';
                if (newType !== effectiveType) {
                    try {
                        await (window as any).applicationAPI?.callMainWorld('setStorageType', newType);
                    } catch {}
                    selectedType = newType;
                    effectiveType = newType;
                    updateStorageUI(newType);
                }
                exitJson();
            });

        // Rules
        const addBtn = this.shadow.querySelector('#ag-add-rule');
        const form = this.shadow.querySelector('#ag-rule-form') as HTMLElement;
        if (addBtn && form) {
            addBtn.addEventListener('click', () => {
                form.style.display = form.style.display === 'none' ? '' : 'none';
            });
        }
        const cancelBtn = this.shadow.querySelector('#ag-rule-cancel');
        if (cancelBtn && form)
            cancelBtn.addEventListener('click', () => {
                form.style.display = 'none';
            });

        const saveBtn = this.shadow.querySelector('#ag-rule-save');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                const pat = (this.shadow.querySelector('#ag-rule-pat') as HTMLInputElement)?.value;
                const act = (this.shadow.querySelector('#ag-rule-act') as HTMLSelectElement)?.value;
                const sev = (this.shadow.querySelector('#ag-rule-sev') as HTMLSelectElement)?.value;
                if (!pat) return;
                this._addRule(pat, act, sev);
                if (form) form.style.display = 'none';
                (this.shadow.querySelector('#ag-rule-pat') as HTMLInputElement).value = '';
            });
        }

        this._renderRules();
    }

    /** 查询主进程 Bridge 状态并更新配置页的服务状态指示器 */
    async _refreshServiceStatus() {
        const mossDot = this.shadow.querySelector('.ag-status-row .ag-status-dot') as HTMLElement | null;
        const mossSt = this.shadow.querySelector('#ag-moss-st') as HTMLElement | null;
        const mossAddr = this.shadow.querySelector('#ag-moss-addr') as HTMLElement | null;
        const gateDot = this.shadow.querySelectorAll('.ag-status-row .ag-status-dot')[1] as HTMLElement | null;
        const gateSt = this.shadow.querySelector('#ag-gate-st') as HTMLElement | null;
        const gateAddr = this.shadow.querySelector('#ag-gate-addr') as HTMLElement | null;
        const errBox = this.shadow.querySelector('#ag-bridge-error') as HTMLElement | null;

        let mossRunning = false;
        let gateRunning = false;
        let mossPort = 0;
        let gatePort = 0;
        let lastError: string | null = null;
        try {
            const status = await (window as any).applicationAPI?.callMainWorld('getBridgeStatus');
            if (status) {
                mossRunning = !!status.mossRunning;
                gateRunning = !!status.gateRunning;
                mossPort = status.mossPort || 0;
                gatePort = status.gatePort || 0;
                lastError = status.lastError || null;
            }
        } catch {
            /* callMainWorld unavailable */
        }

        const apply = (
            dot: HTMLElement | null,
            stEl: HTMLElement | null,
            addrEl: HTMLElement | null,
            running: boolean,
            port: number
        ) => {
            if (dot) {
                dot.classList.toggle('ag-status-dot-running', running);
                dot.classList.toggle('ag-status-dot-stopped', !running);
            }
            if (stEl) stEl.textContent = running ? tr('statusRunning') : tr('statusStopped');
            if (addrEl) addrEl.textContent = port ? `127.0.0.1:${port}` : '';
        };
        apply(mossDot, mossSt, mossAddr, mossRunning, mossPort);
        apply(gateDot, gateSt, gateAddr, gateRunning, gatePort);

        if (errBox) {
            if (lastError) {
                errBox.style.display = '';
                errBox.textContent = lastError;
            } else {
                errBox.style.display = 'none';
                errBox.textContent = '';
            }
        }
    }

    async _loadModels() {
        const sel = this.shadow.querySelector('#ag-llm-model') as HTMLSelectElement;
        if (!sel) return;
        try {
            const m = await (window as any).applicationAPI?.callMainWorld('getModels');
            sel.innerHTML = `<option value="">${tr('llmModelDefault')}</option>`;
            (m || []).forEach((x: any) => {
                const o = document.createElement('option');
                o.value = x.alias;
                o.textContent = `${x.alias} (${x.name})`;
                sel.appendChild(o);
            });
        } catch {}
    }

    async _addRule(pat: string, act: string, sev: string) {
        const r = await this._getRules();
        r.push({ pattern: pat, action: act, severity: sev });
        await this._saveRules(r);
        this._renderRules(r);
    }
    async _removeRule(i: number) {
        const r = await this._getRules();
        r.splice(i, 1);
        await this._saveRules(r);
        this._renderRules(r);
    }
    async _getRules() {
        try {
            return (await (window as any).applicationAPI?.callMainWorld('getCustomRules')) || [];
        } catch {}
        try {
            return JSON.parse(localStorage.getItem('ag_rules') || '[]');
        } catch {
            return [];
        }
    }
    async _saveRules(r: any[]) {
        try {
            await (window as any).applicationAPI?.callMainWorld('saveCustomRules', r);
            return;
        } catch {}
        localStorage.setItem('ag_rules', JSON.stringify(r));
    }
    async _renderRules(r?: any[]) {
        const el = this.shadow.querySelector('#ag-rules');
        if (!el) return;
        if (!r) r = await this._getRules();
        if (!r.length) {
            el.innerHTML = `<div style="font-size:12px;color:var(--ag-text-secondary);padding:8px 0;">${isZh() ? '暂无自定义规则' : 'No custom rules'}</div>`;
            return;
        }
        el.innerHTML = r
            .map(
                (x: any, i: number) => `
            <div class="ag-rule-item">
                <code class="ag-rule-pattern">${x.pattern}</code>
                <span class="ag-badge ${x.action === 'Deny' ? 'ag-badge-deny' : 'ag-badge-allow'}">${x.action}</span>
                <span style="font-size:10px;color:var(--ag-orange);min-width:48px;text-align:center;">${x.severity}</span>
                <button class="ag-btn ag-btn-muted ag-btn-sm" style="padding:2px 6px;font-size:12px;">✕</button>
            </div>
        `
            )
            .join('');
        el.querySelectorAll('button').forEach((b, i) => b.addEventListener('click', () => this._removeRule(i)));
    }

    disconnectedCallback() {
        // 清理 setting 监听器，避免内存泄漏
        if (this._settingUnsub) {
            this._settingUnsub();
            this._settingUnsub = null;
        }
    }
}

customElements.define('agentgate-entry-widget', AgentGateEntryWidget);
