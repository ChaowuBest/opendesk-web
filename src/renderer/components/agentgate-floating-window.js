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
    floatingWindowOpacity: { zh: '透明度', en: 'Opacity' },
    floatingWindowDetail: { zh: '详情', en: 'Details' },
    floatingWindowNoRecords: { zh: '暂无记录', en: 'No records' },
    floatingWindowLoading: { zh: '加载中...', en: 'Loading...' },
    floatingWindowProtected: { zh: '已防护', en: 'Protected' },
    floatingWindowOff: { zh: '未启用', en: 'Off' },
    floatingWindowBlocked: { zh: '已拦截', en: 'Blocked' },
    floatingWindowAllowed: { zh: '已放行', en: 'Allowed' },
    floatingWindowRecords: { zh: '条记录', en: 'records' },
    floatingWindowViewMore: { zh: '查看更多...', en: 'View more...' },
    riskCritical: { zh: '极危', en: 'Critical' },
    riskHigh: { zh: '高危', en: 'High' },
    riskMedium: { zh: '中危', en: 'Medium' },
    riskLow: { zh: '低危', en: 'Low' }
};

function isZh() {
    const docLang = document.documentElement.lang;
    if (docLang?.startsWith('zh')) return true;
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
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 13px;
    line-height: 1.4;
    color-scheme: light dark;
}

.agentgate-floating {
    position: fixed;
    bottom: 24px;
    right: 24px;
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
.agentgate-floating.is-auto-expanded {
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
    flex: 0 1 auto;
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
.agentgate-floating.is-auto-expanded .floating-title-label {
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
    background: #e6f7ed;
    color: #15803d;
}

:host([data-theme="dark"]) .status-badge.is-active {
    background: rgba(22, 163, 74, 0.2);
    color: #4ade80;
}

.status-badge.is-off {
    background: rgba(156, 163, 175, 0.1);
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
    display: inline-flex;
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
.agentgate-floating.is-auto-expanded .floating-records {
    max-height: 240px;
    opacity: 1;
    border-top-color: rgba(200, 200, 210, 0.7);
}

:host([data-theme="dark"]) .agentgate-floating:hover .floating-records,
:host([data-theme="dark"]) .agentgate-floating:focus-within .floating-records,
:host([data-theme="dark"]) .agentgate-floating.is-auto-expanded .floating-records {
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
    max-height: 120px;
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

.setting-label {
    min-width: 50px;
    font-size: 12px;
    font-weight: 650;
    color: inherit;
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
        this._settingsOpen = false;
        this._loading = true;
        this._dashboardUrl = '';

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
        api.onEventsUpdate(this._eventsCallback);

        // Load initial config
        api.getFloatingWindowConfig()
            .then(async (config) => {
                // Also check experimental mode from setting
                let experimentalEnabled = false;
                try {
                    const settingData = await window.settingAPI?.loadSettingObject();
                    experimentalEnabled = settingData?.debug?.experimental_feature === true;
                } catch {}
                this._globalEnabled = experimentalEnabled && config.enabled !== false;

                this._enabled = experimentalEnabled && config.enabled;
                this._opacity = config.opacity;
                // 根据 enabled 状态控制 host 元素可见性
                this.style.display = this._enabled ? '' : 'none';
                this._updateOpacity();
                this._updateToggleSwitch();
                this._updateHeader();
            })
            .catch((err) => {
                console.warn('[agentgate-floating-window] getFloatingWindowConfig failed:', err);
            });

        // Load initial events (set prevEventCount so first load doesn't trigger auto-expand)
        api.getRecentEvents()
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
        api.getDashboardUrl()
            .then((url) => {
                this._dashboardUrl = url;
            })
            .catch(() => {
                this._dashboardUrl = 'http://127.0.0.1:9100/dashboard/';
            });

        // Listen for global setting changes to sync visibility
        if (window.settingAPI) {
            this._settingCallback = (data) => {
                const agConfig = data?.applications?.agentgate || {};
                const experimentalEnabled = data?.debug?.experimental_feature === true;
                const agentgateEnabled = agConfig.enabled !== false;

                // AgentGate is only truly active when experimental mode AND its own enabled switch are both on
                this._globalEnabled = experimentalEnabled && agentgateEnabled;

                // Floating window should only show when experimental mode is on
                const floatingWindowEnabled = agConfig.floatingWindowEnabled === true;
                const newEnabled = experimentalEnabled && floatingWindowEnabled;
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
                this._updateHeader();
            };
            window.settingAPI.onSettingChanged(this._settingCallback);
        }
    }

    disconnectedCallback() {
        if (this._themeObserver) {
            this._themeObserver.disconnect();
        }
        if (window.agentGateFloatingAPI) {
            window.agentGateFloatingAPI.removeEventsUpdateListener();
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
        titleDiv.innerHTML = `${SHIELD_ICON}<span class="floating-title-label">${t('floatingTitle')}</span>`;

        this._actionsDiv = document.createElement('div');
        this._actionsDiv.className = 'floating-actions';

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
        // Opacity row
        const opacityRow = document.createElement('div');
        opacityRow.className = 'setting-row';

        const opacityLabel = document.createElement('span');
        opacityLabel.className = 'setting-label';
        opacityLabel.textContent = t('floatingWindowOpacity');

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
            window.agentGateFloatingAPI?.setFloatingWindowOpacity(val);
        });

        this._opacityValue = document.createElement('span');
        this._opacityValue.className = 'opacity-value';
        this._opacityValue.textContent = this._opacity.toFixed(2);

        opacityRow.appendChild(opacityLabel);
        opacityRow.appendChild(this._opacitySlider);
        opacityRow.appendChild(this._opacityValue);

        // Toggle row
        const toggleRow = document.createElement('div');
        toggleRow.className = 'setting-row';

        const toggleLabel = document.createElement('span');
        toggleLabel.className = 'setting-label';
        toggleLabel.textContent = t('floatingWindowSwitch');

        this._toggleSwitch = document.createElement('div');
        this._toggleSwitch.className = 'toggle-switch';
        this._toggleSwitch.innerHTML = '<div class="toggle-thumb"></div>';
        this._toggleSwitch.addEventListener('click', (e) => {
            e.stopPropagation();
            this._enabled = !this._enabled;
            this._updateToggleSwitch();
            this.style.display = this._enabled ? '' : 'none';
            window.agentGateFloatingAPI?.setFloatingWindowEnabled(this._enabled);
        });

        toggleRow.appendChild(toggleLabel);
        toggleRow.appendChild(this._toggleSwitch);

        this._settingsEl.appendChild(opacityRow);
        this._settingsEl.appendChild(toggleRow);

        this._updateToggleSwitch();
    }

    // ── Update Methods ────────────────────────────────────────────────
    _updateHeader() {
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

    _updateToggleSwitch() {
        this._toggleSwitch.className = this._enabled ? 'toggle-switch is-on' : 'toggle-switch';
    }

    _toggleSettings() {
        this._settingsOpen = !this._settingsOpen;
        this._settingsEl.className = this._settingsOpen ? 'floating-settings is-open' : 'floating-settings';
    }

    // ── Auto-Expand ──────────────────────────────────────────────────
    /** 新事件到达时自动展开浮窗，显示几秒后收回 */
    _triggerAutoExpand() {
        if (!this._enabled) return;

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
            }, 5000);
        }
    }

    /** 收回自动展开（如果用户正在 hover 则不收回），并清除高亮 */
    _collapseAutoExpand() {
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

    /** 用户开始 hover 时，取消自动收回 timer */
    _onHoverStart() {
        if (this._autoExpandTimer) {
            clearTimeout(this._autoExpandTimer);
            this._autoExpandTimer = null;
        }
    }

    /** 用户结束 hover 时，如果自动展开已过期，收回 */
    _onHoverEnd() {
        if (!this._isAutoExpanded) {
            this._container.classList.remove('is-auto-expanded');
        }
    }

    // ── Render Records ────────────────────────────────────────────────
    _renderRecords() {
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
                }
            }
        } catch {
            /* localStorage unavailable or parse error */
        }
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
