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

import { escapeHtml } from '../../../common/utils/escape.js';
import { createRendererTranslator, resolveRendererLocale } from '../../locale.js';
import { isApplicationVisibleInMenu, type ExperimentalFeatureSettings } from '../../utils/application-visibility.js';
import { fixedLayerOrigin, visibleViewportRect } from '../../utils/window-frame.js';
import { CLOSE_SVG, detectDarkMode, MODAL_CSS, renderIcon } from '../confirmModal.js';
import { composeCardSrcDoc, hasCardContent } from './cardContent.js';
import { playDesktopExitTransition } from './desktopEffects.js';
import { buildDesktopStyles } from './desktopStyles.js';
import { isThemePreference, nextThemePreference } from './desktopTheme.js';
import type { ThemePreference } from '../../theme/theme-manager.js';
import {
    DEFAULT_CARD_GRID_H,
    DEFAULT_CARD_GRID_W,
    GRID_COLUMNS,
    GRID_ROWS,
    MIN_CARD_GRID_H,
    MIN_CARD_GRID_W,
    clamp,
    computeGridMetrics,
    findAvailableCardLayout,
    findNearestAvailableCardLayout,
    fitResizedCardLayout,
    gridRectToPixel,
    layoutCollides,
    movePixelRectAvoidingCards,
    resolveDraggedCardLayout,
    resizePixelRectAvoidingCards,
    snapPixelRectToGrid,
    type GridMetrics,
    type GridRect,
    type PixelRect,
    type ResizeDir
} from './cardLayout.js';

type CardInterval = '15m' | '1h' | '1d';

export type SmartCard = {
    id: string;
    prompt: string;
    html: string;
    gridX: number;
    gridY: number;
    gridW: number;
    gridH: number;
    interval: CardInterval;
    lastUpdatedAt?: number;
    lastError?: string;
    lastErrorAt?: number;
    lastErrorTaskId?: string;
};

type DesktopApp = {
    bundleName: string;
    name: string;
    iconUrl?: string;
    showIcon?: boolean;
    isExperimental?: boolean;
};

type ApplicationGuiConfig = {
    source?: string;
    entryUrl?: string;
};

type DesktopWindowKind = 'app' | 'chat';

type DesktopWindow = {
    id: string;
    kind: DesktopWindowKind;
    bundleName?: string;
    title: string;
    iconUrl?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    zIndex: number;
    minimized: boolean;
    maximized: boolean;
    restoreRect?: { x: number; y: number; width: number; height: number };
    element: HTMLElement;
    contentElement: HTMLElement;
};

type PointerState =
    | {
          type: 'card-drag';
          id: string;
          startClientX: number;
          startClientY: number;
          start: GridRect;
          currentRect: PixelRect;
          /** 抓取偏移：按下时指针相对卡片左缘/上缘的位置，拖动按"指针 + 偏移"绝对跟随 */
          grabOffsetX: number;
          grabOffsetY: number;
      }
    | {
          type: 'card-resize';
          id: string;
          dir: ResizeDir;
          startClientX: number;
          startClientY: number;
          startRect: PixelRect;
      }
    | {
          type: 'window-drag';
          id: string;
          startClientX: number;
          startClientY: number;
          startX: number;
          startY: number;
      }
    | {
          type: 'window-resize';
          id: string;
          dir: ResizeDir;
          startClientX: number;
          startClientY: number;
          startRect: { x: number; y: number; width: number; height: number };
      };

const DESKTOP_TRANSITION_MS = 440;
const CARD_SNAP_TRANSITION_MS = 140;
const AUTO_REFRESH_TICK_MS = 60_000;
const CHAT_TASK_STORAGE_KEY = 'opendesk.immersiveDesktop.chatTaskId';

const INTERVAL_OPTIONS: Array<{ value: CardInterval; ms: number; key: string }> = [
    { value: '15m', ms: 15 * 60_000, key: 'renderer.desktop.card.interval.15m' },
    { value: '1h', ms: 60 * 60_000, key: 'renderer.desktop.card.interval.1h' },
    { value: '1d', ms: 24 * 60 * 60_000, key: 'renderer.desktop.card.interval.1d' }
];

const THEME_ICON_MAP: Record<ThemePreference, string> = {
    light: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>',
    dark: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
    system: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18V3z" fill="currentColor" stroke="none"/></svg>'
};

const THEME_TOGGLE_LABEL_KEY: Record<ThemePreference, string> = {
    light: 'renderer.sidebar.themeToggleToLight',
    dark: 'renderer.sidebar.themeToggleToDark',
    system: 'renderer.sidebar.themeToggleToSystem'
};

// 模块级卡片剪贴板：复制/粘贴卡片时使用，进程内共享
const cardClipboard: { card: SmartCard | null } = { card: null };

const globalWindow = window as Window & Record<string, any>;

function safeText(value: string | undefined | null): string {
    return escapeHtml(value ?? '');
}

function normalizeInterval(value: unknown): CardInterval {
    return value === '1h' || value === '1d' || value === '15m' ? value : '15m';
}

function cardIntervalMs(interval: CardInterval): number {
    return INTERVAL_OPTIONS.find((item) => item.value === interval)?.ms ?? INTERVAL_OPTIONS[0].ms;
}

function createCardId(): string {
    return `card_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createWindowId(kind: DesktopWindowKind, key?: string): string {
    if (kind === 'chat') return 'chat';
    return `app:${key ?? 'unknown'}`;
}

declare global {
    interface HTMLElementTagNameMap {
        'immersive-desktop': ImmersiveDesktop;
    }
}

export class ImmersiveDesktop extends HTMLElement {
    private _t = createRendererTranslator();
    private _locale = 'zh-CN';
    private _cards: SmartCard[] = [];
    private _apps: DesktopApp[] = [];
    private _windows = new Map<string, DesktopWindow>();
    private _zSeed = 20;
    private _pointerState: PointerState | null = null;
    private _contextGrid: { gridX: number; gridY: number } | null = null;
    private _contextCardId: string | null = null;
    private _refreshingCards = new Set<string>();
    private _clockTimer: number | null = null;
    private _refreshTimer: number | null = null;
    private _themeObserver: MutationObserver | null = null;
    private _themePreference: ThemePreference = 'system';
    private _themeUnsubscribe: (() => void) | null = null;
    private _isClosing = false;
    private _cardSeq = 0;
    private _activeMetrics: GridMetrics | null = null;
    private _stageObserver: ResizeObserver | null = null;
    private _renderedAppsSignature = '';
    private _lastHeaderDragMoved = false;
    private _editingNewCardId: string | null = null;

    connectedCallback(): void {
        document.body.classList.add('immersive-desktop-open');
        // host 需可聚焦，保证打开后焦点进入桌面、键盘事件（Escape）能被处理
        this.tabIndex = -1;
        this.renderShell();
        this.bindEvents();
        this.applyTheme();
        this.installThemeObserver();
        this.installThemePreference();
        this.installStageObserver();
        this.updateClock();
        this._clockTimer = window.setInterval(() => this.updateClock(), 15000);
        this._refreshTimer = window.setInterval(() => this.refreshDueCards(), AUTO_REFRESH_TICK_MS);
        // 串行加载：先就绪 locale 再渲染卡片，避免卡片按默认语言渲染后整桌重渲一次
        void (async () => {
            await this.loadSettings();
            await this.loadCards();
        })();
        void this.loadApplications();
        this.focus({ preventScroll: true });
    }

    disconnectedCallback(): void {
        document.body.classList.remove('immersive-desktop-open');
        if (this._clockTimer !== null) window.clearInterval(this._clockTimer);
        if (this._refreshTimer !== null) window.clearInterval(this._refreshTimer);
        this._themeObserver?.disconnect();
        this._themeObserver = null;
        this._themeUnsubscribe?.();
        this._themeUnsubscribe = null;
        window.removeEventListener('pointerdown', this.onGlobalPointerDown);
        window.removeEventListener('pointermove', this.onGlobalPointerMove);
        window.removeEventListener('pointerup', this.onGlobalPointerUp);
        window.removeEventListener('pointercancel', this.onGlobalPointerCancel);
        window.removeEventListener('keydown', this.onGlobalKeyDown);
        window.removeEventListener('message', this.onCardLinkMessage);
        this._stageObserver?.disconnect();
        this._stageObserver = null;
        this._pointerState = null;
        this._windows.clear();
    }

    private t(key: string, params?: Record<string, string | number>): string {
        return this._t?.(key, params) ?? key;
    }

    /* ================= 生命周期 ================= */

    async open(): Promise<void> {
        this._isClosing = false;
        this.classList.remove('od-desktop-leaving');
        requestAnimationFrame(() => {
            // 若在同一帧内被关闭，不得再把入场类加回来
            if (this._isClosing) return;
            this.classList.add('od-active', 'od-play');
            this.setAttribute('aria-hidden', 'false');
            this.positionAllCards();
            this.positionAllWindows();
        });
        // 覆盖层展开后把焦点收进桌面，保证 Escape 等键盘交互可用
        window.setTimeout(() => this.focus({ preventScroll: true }), DESKTOP_TRANSITION_MS);
    }

    close(): void {
        if (this._isClosing) return;
        this._isClosing = true;
        this.hideContextMenu();
        this.hideAppList();
        this.closeCardEditor();
        playDesktopExitTransition();
        this.classList.add('od-leaving');
        this.classList.remove('od-active');
        this.setAttribute('aria-hidden', 'true');
        window.setTimeout(() => this.remove(), DESKTOP_TRANSITION_MS);
    }

    private async loadSettings(): Promise<void> {
        try {
            const setting = await globalWindow.settingAPI?.loadSettingObject?.();
            this._locale = resolveRendererLocale(setting);
            this._t = createRendererTranslator(setting);
        } catch {
            this._locale = resolveRendererLocale();
            this._t = createRendererTranslator();
        }
        this.updateLocalizedText();
        this.updateClock();
    }

    private applyTheme(): void {
        const dark = document.documentElement.getAttribute('data-theme') === 'dark';
        const changed = this.classList.contains('theme-dark') !== dark;
        this.classList.toggle('theme-dark', dark);
        // 主题翻转后重组卡片 srcdoc，让已生成内容的 color-scheme/配色跟随新主题；
        // 初始调用时卡片尚未加载（_cards 为空），不会触发多余重渲
        if (changed && this._cards.some((card) => card.html)) {
            this.renderCards(false);
        }
    }

    private getTheme(): 'light' | 'dark' {
        return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    }

    private installThemeObserver(): void {
        this._themeObserver = new MutationObserver(() => this.applyTheme());
        this._themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }

    private installThemePreference(): void {
        void globalWindow.themeAPI
            ?.getResolvedTheme?.()
            .then((result: { status?: string; data?: { preference?: unknown } }) => {
                const preference = result?.data?.preference;
                if (result?.status === 'ok' && isThemePreference(preference)) {
                    this._themePreference = preference;
                    this.updateThemeToggle();
                }
            })
            .catch(() => undefined);

        this._themeUnsubscribe =
            globalWindow.themeAPI?.onThemeChanged?.((resolved: { preference?: unknown }) => {
                if (isThemePreference(resolved?.preference)) {
                    this._themePreference = resolved.preference;
                    this.updateThemeToggle();
                }
            }) ?? null;
    }

    private async toggleThemePreference(): Promise<void> {
        if (!globalWindow.themeAPI?.setPreference) return;
        const next = nextThemePreference(this._themePreference);
        try {
            const result = await globalWindow.themeAPI.setPreference(next);
            const preference = result?.data?.preference;
            if (result?.status === 'ok' && isThemePreference(preference)) {
                this._themePreference = preference;
                this.updateThemeToggle();
                const themeSelect = document.querySelector<HTMLSelectElement>('#theme-preference-select');
                if (themeSelect) themeSelect.value = preference;
            }
        } catch (error) {
            console.warn('[immersive desktop] theme setPreference failed', error);
        }
    }

    private updateThemeToggle(): void {
        const button = this.querySelector<HTMLButtonElement>('[data-desktop-theme-toggle]');
        if (!button) return;
        button.innerHTML = THEME_ICON_MAP[this._themePreference];
        const label = this.t(THEME_TOGGLE_LABEL_KEY[nextThemePreference(this._themePreference)]);
        button.title = label;
        button.setAttribute('aria-label', label);
    }

    /**
     * 监听 stage 尺寸变化并重排卡片/浮窗：
     * 用户手动调整窗口大小后，卡片与浮窗需要按新的 stage 尺寸重新定位。
     */
    private installStageObserver(): void {
        const stage = this.querySelector('[data-stage]') as HTMLElement | null;
        if (!stage || typeof ResizeObserver === 'undefined') return;
        this._stageObserver = new ResizeObserver(() => this.onStageResized());
        this._stageObserver.observe(stage);
    }

    private onStageResized(): void {
        const cardInteraction = this._pointerState?.type === 'card-drag' || this._pointerState?.type === 'card-resize';
        if (!cardInteraction) this.positionAllCards();
        for (const desktopWindow of this._windows.values()) {
            if (desktopWindow.minimized || desktopWindow.maximized) continue;
            // 浮窗坐标是内容区坐标（fixed 于 #app-root），上限基于可视内容区而非窗口矩形
            const view = visibleViewportRect();
            const clampedX = clamp(
                desktopWindow.x,
                -desktopWindow.width + 80,
                Math.max(8, view.right - view.left - 80)
            );
            const clampedY = clamp(desktopWindow.y, 0, Math.max(8, view.bottom - view.top - 40));
            const clampedW = clamp(desktopWindow.width, 320, Math.max(320, view.right - view.left - 8));
            const clampedH = clamp(desktopWindow.height, 220, Math.max(220, view.bottom - view.top - 8));
            if (
                clampedX !== desktopWindow.x ||
                clampedY !== desktopWindow.y ||
                clampedW !== desktopWindow.width ||
                clampedH !== desktopWindow.height
            ) {
                desktopWindow.x = clampedX;
                desktopWindow.y = clampedY;
                desktopWindow.width = clampedW;
                desktopWindow.height = clampedH;
            }
            this.positionWindow(desktopWindow);
        }
    }

    /* ================= 渲染 ================= */

    private renderShell(): void {
        this.innerHTML = `
        ${buildDesktopStyles()}
        <div class="od-bg"></div>
        <div class="od-app">
            <header class="od-topbar">
                <div class="od-brand"><svg class="od-brand-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="4" width="19" height="13" rx="2"></rect><path d="M8 21h8M12 17v4"></path></svg>OpenDesk <em>${safeText(this.t('renderer.desktop.subtitle'))}</em></div>
                <div class="od-status">
                    <button type="button" class="od-chip od-add-card-btn" data-add-card-btn><i class="fa-solid fa-plus"></i><span data-add-card-label>${safeText(this.t('renderer.desktop.addCard'))}</span></button>
                    <span class="od-chip od-refresh-chip" data-refresh-chip hidden><span class="od-pulse-dot"></span><span data-refresh-chip-text></span></span>
                    <span class="od-chip od-clock-chip">--:--</span>
                    <button type="button" class="od-icon-ghost od-theme-toggle" data-desktop-theme-toggle></button>
                    <button class="od-icon-ghost" data-desktop-exit title="${safeText(this.t('renderer.desktop.exitDesktop'))}" aria-label="${safeText(this.t('renderer.desktop.exitDesktop'))}"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </header>
            <main class="od-stage" data-stage></main>
        </div>
        <div class="od-dock-wrap">
            <div class="od-minimized" data-minimized-dock></div>
            <div class="od-dock">
                <div class="od-applist" data-applist role="menu" hidden></div>
                <button type="button" class="od-icon-btn" data-apps-btn title="${safeText(this.t('renderer.desktop.appList.title'))}" aria-label="${safeText(this.t('renderer.desktop.appList.title'))}" aria-haspopup="menu" aria-expanded="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="3.5"/><rect x="14" y="3" width="7" height="7" rx="3.5"/><rect x="14" y="14" width="7" height="7" rx="3.5"/><rect x="3" y="14" width="7" height="7" rx="3.5"/></svg></button>
                <input type="text" class="od-task-input" data-task-input placeholder="${safeText(this.t('renderer.desktop.dock.placeholder'))}">
                <button type="button" class="od-send" data-send-btn disabled title="${safeText(this.t('renderer.desktop.dock.send'))}" aria-label="${safeText(this.t('renderer.desktop.dock.send'))}"><i class="fa-solid fa-arrow-up"></i></button>
            </div>
        </div>
        <div class="od-context-menu" data-context-menu hidden></div>
        <div data-modal-host></div>
        `;
        this.updateThemeToggle();
    }

    private updateLocalizedText(): void {
        const input = this.querySelector('[data-task-input]') as HTMLInputElement | null;
        if (input) input.placeholder = this.t('renderer.desktop.dock.placeholder');
        const addLabel = this.querySelector('[data-add-card-label]');
        if (addLabel) addLabel.textContent = this.t('renderer.desktop.addCard');
        this.updateThemeToggle();
        this.renderCards();
    }

    /** 顶栏生成状态：有卡片在生成/刷新时显示“N 张卡片更新中”，空闲时隐藏。 */
    private updateRefreshingChip(): void {
        const chip = this.querySelector('[data-refresh-chip]');
        if (!chip) return;
        const count = this._refreshingCards.size;
        if (count > 0) {
            const text = chip.querySelector('[data-refresh-chip-text]');
            if (text) text.textContent = this.t('renderer.desktop.refreshBadge', { count });
            chip.removeAttribute('hidden');
        } else {
            chip.setAttribute('hidden', '');
        }
    }

    private updateClock(): void {
        const chip = this.querySelector('.od-clock-chip');
        if (!chip) return;
        const d = new Date();
        chip.textContent =
            `${d.toLocaleDateString(this._locale, { month: 'long', day: 'numeric', weekday: 'short' })} ` +
            d.toLocaleTimeString(this._locale, { hour: '2-digit', minute: '2-digit' });
    }

    /* ================= 事件绑定 ================= */

    private bindEvents(): void {
        this.querySelector('[data-desktop-exit]')?.addEventListener('click', () => this.close());
        this.querySelector('[data-desktop-theme-toggle]')?.addEventListener('click', () => {
            void this.toggleThemePreference();
        });

        this.addEventListener('click', this.handleContextMenuClick);

        const stage = this.querySelector('[data-stage]') as HTMLElement | null;
        stage?.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            const target = event.target as HTMLElement;
            const cardElement = target.closest?.('.od-card') as HTMLElement | null;
            if (cardElement?.dataset.cardId) {
                this.showCardContextMenu(cardElement.dataset.cardId, event.clientX, event.clientY);
            } else {
                this.showBlankContextMenu(event.clientX, event.clientY);
            }
        });

        window.addEventListener('pointerdown', this.onGlobalPointerDown);
        window.addEventListener('pointermove', this.onGlobalPointerMove);
        window.addEventListener('pointerup', this.onGlobalPointerUp);
        window.addEventListener('pointercancel', this.onGlobalPointerCancel);
        window.addEventListener('keydown', this.onGlobalKeyDown);
        window.addEventListener('message', this.onCardLinkMessage);

        this.querySelector('[data-send-btn]')?.addEventListener('click', () => this.submitTask());
        // 顶栏"添加卡片"按钮：在首个可用网格位新建卡片并打开设置
        this.querySelector('[data-add-card-btn]')?.addEventListener('click', () => this.createSmartCardAt());
        const input = this.querySelector('[data-task-input]') as HTMLInputElement | null;
        input?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') this.submitTask();
        });
        // 空输入时置灰发送按钮，给出明确的可提交信号
        input?.addEventListener('input', () => this.syncSendState());
        this.syncSendState();
        this.querySelector('[data-apps-btn]')?.addEventListener('click', (event) => {
            event.stopPropagation();
            this.toggleAppList();
        });
    }

    /**
     * Escape 分层处理：右键菜单 → 卡片设置模态 → 应用列表 → 退出桌面。
     * 绑定在 window 且不过滤事件目标：桌面打开期间覆盖整个视口，即使焦点仍留在
     * 被遮挡的主界面上（例如打开前的入口胶囊），Escape 也应归属桌面处理。
     */
    private onGlobalKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape') return;
        if (!this.isContextMenuHidden()) {
            this.hideContextMenu();
            return;
        }
        const modalHost = this.querySelector('[data-modal-host]') as HTMLElement | null;
        if (modalHost?.childElementCount) {
            this.closeCardEditor();
            return;
        }
        if (!this.isAppListHidden()) {
            this.hideAppList();
            return;
        }
        this.close();
    };

    private onGlobalPointerDown = (event: PointerEvent): void => {
        const target = event.target as HTMLElement;
        if (!this.contains(target)) return;
        const menu = this.querySelector('[data-context-menu]') as HTMLElement | null;
        if (menu && !menu.hidden && !menu.contains(target)) this.hideContextMenu();
        const applist = this.querySelector('[data-applist]') as HTMLElement | null;
        if (applist && !applist.hidden && !applist.contains(target)) {
            const appsBtn = this.querySelector('[data-apps-btn]');
            if (!appsBtn?.contains(target)) this.hideAppList();
        }
        const dragTarget = target.closest?.('[data-card-drag]') as HTMLElement | null;
        if (dragTarget) {
            // 头部失败警告标记不参与拖动
            if (target.closest?.('[data-card-error-jump]')) return;
            const cardElement = dragTarget.closest('.od-card') as HTMLElement | null;
            if (cardElement?.dataset.cardId) this.startCardDrag(event, cardElement.dataset.cardId);
            return;
        }
        const resizeTarget = target.closest?.('.od-card-resize-handle') as HTMLElement | null;
        if (resizeTarget) {
            const cardElement = resizeTarget.closest('.od-card') as HTMLElement | null;
            if (cardElement?.dataset.cardId && resizeTarget.dataset.dir) {
                this.startCardResize(event, cardElement.dataset.cardId, resizeTarget.dataset.dir as ResizeDir);
            }
            return;
        }
        const windowDragTarget = target.closest?.('[data-window-drag]') as HTMLElement | null;
        if (windowDragTarget) {
            // 标题栏上的窗口控制按钮不应触发拖动
            if (target.closest?.('button')) return;
            const winElement = windowDragTarget.closest('.od-floating-window') as HTMLElement | null;
            if (winElement?.dataset.desktopWindowId) {
                this.startWindowDrag(event, winElement.dataset.desktopWindowId);
            }
            return;
        }
        const windowResizeTarget = target.closest?.('.od-window-resize-handle') as HTMLElement | null;
        if (windowResizeTarget) {
            const winElement = windowResizeTarget.closest('.od-floating-window') as HTMLElement | null;
            if (winElement?.dataset.desktopWindowId && windowResizeTarget.dataset.dir) {
                this.startWindowResize(
                    event,
                    winElement.dataset.desktopWindowId,
                    windowResizeTarget.dataset.dir as ResizeDir
                );
            }
        }
    };

    private onGlobalPointerMove = (event: PointerEvent): void => {
        if (!this._pointerState) return;
        switch (this._pointerState.type) {
            case 'card-drag':
                this.handleCardDragMove(event);
                break;
            case 'card-resize':
                this.handleCardResizeMove(event);
                break;
            case 'window-drag':
                this.handleWindowDragMove(event);
                break;
            case 'window-resize':
                this.handleWindowResizeMove(event);
                break;
        }
    };

    private onGlobalPointerUp = (): void => {
        this.finishPointerInteraction();
    };

    // 拖动/缩放被系统打断（如窗口切换触发 pointercancel）时与 pointerup 同样收尾，
    // 避免拖动状态卡死
    private onGlobalPointerCancel = (): void => {
        this.finishPointerInteraction();
    };

    private finishPointerInteraction(): void {
        if (!this._pointerState) return;
        const state = this._pointerState;
        this._pointerState = null;
        switch (state.type) {
            case 'card-drag':
                this.finishCardDrag(state);
                break;
            case 'card-resize':
                this.finishCardResize(state);
                break;
            case 'window-drag':
            case 'window-resize':
                this.endDesktopInteraction();
                break;
        }
    }

    /* ================= 卡片数据 ================= */

    private async loadCards(): Promise<void> {
        try {
            const cards = await globalWindow.desktopAPI?.loadCards?.();
            this._cards = (Array.isArray(cards) ? cards : [])
                .map((card) => this.normalizeCard(card))
                .filter((card): card is SmartCard => !!card && hasCardContent(card));
            const positioned: SmartCard[] = [];
            for (const card of this._cards) {
                if (layoutCollides(card, positioned)) {
                    const available = findNearestAvailableCardLayout(card, positioned);
                    if (available) Object.assign(card, available);
                }
                positioned.push(card);
            }
        } catch {
            this._cards = [];
        }
        this.renderCards(true);
        // 启动时检查一次过期卡片
        this.refreshDueCards();
    }

    private normalizeCard(value: unknown): SmartCard | null {
        if (!value || typeof value !== 'object') return null;
        const record = value as Record<string, unknown>;
        const gridW = clamp(Math.round(Number(record.gridW) || DEFAULT_CARD_GRID_W), MIN_CARD_GRID_W, GRID_COLUMNS);
        const gridH = clamp(Math.round(Number(record.gridH) || DEFAULT_CARD_GRID_H), MIN_CARD_GRID_H, GRID_ROWS);
        return {
            id: typeof record.id === 'string' && record.id ? record.id : createCardId(),
            prompt: typeof record.prompt === 'string' ? record.prompt : '',
            html: typeof record.html === 'string' ? record.html : '',
            gridX: clamp(Math.round(Number(record.gridX) || 0), 0, GRID_COLUMNS - gridW),
            gridY: clamp(Math.round(Number(record.gridY) || 0), 0, GRID_ROWS - gridH),
            gridW,
            gridH,
            interval: normalizeInterval(record.interval),
            lastUpdatedAt: typeof record.lastUpdatedAt === 'number' ? record.lastUpdatedAt : undefined,
            lastError: typeof record.lastError === 'string' ? record.lastError : undefined,
            lastErrorAt: typeof record.lastErrorAt === 'number' ? record.lastErrorAt : undefined,
            lastErrorTaskId: typeof record.lastErrorTaskId === 'string' ? record.lastErrorTaskId : undefined
        };
    }

    private saveCards(): void {
        void globalWindow.desktopAPI?.saveCards?.(this._cards)?.catch?.(() => undefined);
    }

    private findCard(id: string | undefined): SmartCard | undefined {
        if (!id) return undefined;
        return this._cards.find((card) => card.id === id);
    }

    private getGridMetrics(): GridMetrics | null {
        const stage = this.querySelector('[data-stage]') as HTMLElement | null;
        if (!stage) return null;
        return computeGridMetrics(stage.getBoundingClientRect(), {
            width: stage.clientWidth,
            height: stage.clientHeight
        });
    }

    private getCardPixelRect(card: SmartCard): PixelRect {
        const metrics = this.getGridMetrics();
        if (!metrics) return { left: 0, top: 0, width: 420, height: 320 };
        return gridRectToPixel(card, metrics);
    }

    /* ================= 卡片渲染 ================= */

    private positionAllCards(): void {
        for (const card of this._cards) {
            const element = this.querySelector<HTMLElement>(`.od-card[data-card-id="${CSS.escape(card.id)}"]`);
            if (element) this.positionCardElement(element, card);
        }
    }

    private positionCardElement(element: HTMLElement, card: SmartCard): void {
        const rect = this.getCardPixelRect(card);
        element.style.left = `${rect.left}px`;
        element.style.top = `${rect.top}px`;
        element.style.width = `${rect.width}px`;
        element.style.height = `${rect.height}px`;
    }

    private renderCards(enter = false): void {
        const stage = this.querySelector('[data-stage]') as HTMLElement | null;
        if (!stage) return;
        stage.innerHTML = `<div class="od-empty-state" data-empty-state>${safeText(this.t('renderer.desktop.emptyHint'))}</div>`;
        this._cardSeq = 0;
        for (const card of this._cards) {
            if (!hasCardContent(card)) continue;
            const element = this.createCardElement(card, enter);
            stage.appendChild(element);
            this.positionCardElement(element, card);
            this.renderCardContent(element, card);
        }
        this.updateEmptyState();
    }

    private updateEmptyState(): void {
        const empty = this.querySelector<HTMLElement>('[data-empty-state]');
        if (empty) empty.hidden = this._cards.some(hasCardContent);
    }

    private createCardElement(card: SmartCard, enter = false): HTMLElement {
        const element = document.createElement('section');
        element.className = `od-card${enter ? ' od-card-enter' : ''}${card.html ? ' od-card-done' : ''}`;
        if (enter) {
            const onEntranceAnimationEnd = (event: AnimationEvent): void => {
                if (event.target !== element) return;
                element.classList.remove('od-card-enter');
                element.removeEventListener('animationend', onEntranceAnimationEnd);
            };
            element.addEventListener('animationend', onEntranceAnimationEnd);
        }
        element.dataset.cardId = card.id;
        element.style.setProperty('--od-i', String(this._cardSeq++));
        element.innerHTML = `
            <div class="od-card-drag-zone" data-card-drag="${safeText(card.id)}" data-od-no-longpress="1"></div>
            <header class="od-card-header">
                <div class="od-card-pill">
                    <span class="od-card-title" title="${safeText(card.prompt)}">${safeText(card.prompt || this.t('renderer.desktop.card.untitled'))}</span>
                    ${card.prompt ? `<span class="od-card-live">${safeText(this.t(`renderer.desktop.card.interval.${card.interval}`))}</span>` : ''}
                    ${card.html && card.lastError ? this.renderCardErrorBadge(card) : ''}
                </div>
            </header>
            <div class="od-card-body" data-card-body></div>
            ${this.renderCardResizeHandles()}
        `;
        return element;
    }

    /**
     * 刷新失败警告标记：已有内容的卡片刷新失败时不覆盖内容，
     * 仅在头部间隔标签右侧展示警告，点击直达出错的生成任务。
     */
    private renderCardErrorBadge(card: SmartCard): string {
        const title = card.lastError
            ? `${card.lastError} — ${this.t('renderer.desktop.card.errorJump')}`
            : this.t('renderer.desktop.card.errorJump');
        return `<button type="button" class="od-card-warn" data-card-error-jump="${safeText(card.lastErrorTaskId ?? '')}" title="${safeText(title)}"><i class="fa-solid fa-triangle-exclamation"></i></button>`;
    }

    private renderCardResizeHandles(): string {
        const dirs: ResizeDir[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
        // data-od-no-longpress：触摸长按脚本按下即跳过，不显示进度圆环
        return dirs
            .map((dir) => `<div class="od-card-resize-handle" data-dir="${dir}" data-od-no-longpress="1"></div>`)
            .join('');
    }

    private renderCardContent(cardElement: HTMLElement, card: SmartCard): void {
        const body = cardElement.querySelector('[data-card-body]') as HTMLElement | null;
        if (!body) return;
        body.innerHTML = '';
        const refreshing = this._refreshingCards.has(card.id);

        if (refreshing && card.html) {
            // 已有内容时后台刷新：保留旧内容 + 更新中角标
            const frame = document.createElement('iframe');
            frame.className = 'od-card-frame';
            frame.setAttribute('sandbox', 'allow-scripts allow-forms');
            frame.srcdoc = composeCardSrcDoc(card.html, this.getTheme());
            body.appendChild(frame);
            const banner = document.createElement('div');
            banner.className = 'od-card-updating';
            banner.innerHTML = `<span class="od-pulse-dot"></span>${safeText(this.t('renderer.desktop.card.updating'))}`;
            body.appendChild(banner);
            return;
        }

        if (refreshing && !card.html) {
            cardElement.classList.add('od-card-new');
            cardElement.classList.remove('od-card-done');
            body.innerHTML = `
                <div class="od-gen-head"><span class="od-pulse-dot"></span><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${safeText(this.t('renderer.desktop.card.generating'))} · ${safeText(card.prompt)}</span></div>
                <div class="od-sk-lines"><div class="od-sk-line" style="width:86%"></div><div class="od-sk-line" style="width:64%"></div><div class="od-sk-line" style="width:74%"></div></div>`;
            return;
        }

        if (card.html) {
            cardElement.classList.remove('od-card-new');
            cardElement.classList.add('od-card-done');
            const frame = document.createElement('iframe');
            frame.className = 'od-card-frame';
            frame.setAttribute('sandbox', 'allow-scripts allow-forms');
            frame.srcdoc = composeCardSrcDoc(card.html, this.getTheme());
            body.appendChild(frame);
            // 刷新失败不覆盖内容也不打内容角标，警告统一由头部警告标记承载
            return;
        }

        if (card.lastError) {
            const jumpLink = card.lastErrorTaskId
                ? `<button type="button" class="od-error-task-link" data-card-error-jump="${safeText(card.lastErrorTaskId)}">${safeText(this.t('renderer.desktop.card.viewErrorTask'))}</button>`
                : '';
            body.innerHTML = `
                <div class="od-card-error">
                    <i class="fa-solid fa-triangle-exclamation"></i>
                    <strong>${safeText(this.t('renderer.desktop.card.generateFailed'))}</strong>
                    <span>${safeText(card.lastError)}</span>
                    ${jumpLink}
                    <small>${safeText(this.t('renderer.desktop.card.errorRetryHint'))}</small>
                </div>`;
            return;
        }

        // 有 prompt 但从未生成过：按生成中样式渲染
        cardElement.classList.add('od-card-new');
        body.innerHTML = `
            <div class="od-gen-head"><span class="od-pulse-dot"></span><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${safeText(this.t('renderer.desktop.card.generating'))} · ${safeText(card.prompt)}</span></div>
            <div class="od-sk-lines"><div class="od-sk-line" style="width:86%"></div><div class="od-sk-line" style="width:64%"></div><div class="od-sk-line" style="width:74%"></div></div>`;
    }

    private updateSingleCard(card: SmartCard): void {
        const existing = this.querySelector<HTMLElement>(`.od-card[data-card-id="${CSS.escape(card.id)}"]`);
        if (!existing) {
            this.renderCards();
            return;
        }
        const next = this.createCardElement(card);
        // 单卡更新不参与入场交错动画，避免动画延迟随更新次数累积
        next.style.setProperty('--od-i', '0');
        existing.replaceWith(next);
        this.positionCardElement(next, card);
        this.renderCardContent(next, card);
    }

    /**
     * 刷新开始时：已有内容的卡片仅叠加“更新中”角标，不重建 iframe，
     * 避免定时刷新造成内容闪烁；无内容的卡片仍走整体重渲染（骨架屏）。
     */
    private beginCardRefresh(card: SmartCard): void {
        const element = this.querySelector<HTMLElement>(`.od-card[data-card-id="${CSS.escape(card.id)}"]`);
        const body = element?.querySelector('[data-card-body]') as HTMLElement | null;
        if (!element || !body || !card.html || !body.querySelector('.od-card-frame')) {
            this.updateSingleCard(card);
            return;
        }
        body.querySelector('.od-card-updating')?.remove();
        const banner = document.createElement('div');
        banner.className = 'od-card-updating';
        banner.innerHTML = `<span class="od-pulse-dot"></span>${safeText(this.t('renderer.desktop.card.updating'))}`;
        body.appendChild(banner);
    }

    private createSmartCardAt(layout?: GridRect | null): void {
        const rect = layout ?? findAvailableCardLayout(0, 0, this._cards);
        if (!rect) return;
        const card: SmartCard = {
            id: createCardId(),
            prompt: '',
            html: '',
            gridX: rect.gridX,
            gridY: rect.gridY,
            gridW: rect.gridW,
            gridH: rect.gridH,
            interval: '15m'
        };
        this._cards.push(card);
        this._editingNewCardId = card.id;
        this.showCardEditor(card);
    }

    /* ================= 卡片拖动与缩放 ================= */

    /**
     * 进入拖动/缩放交互：
     * 1) 禁用所有 iframe/webview 的指针事件，避免指针进入其它卡片或应用窗口时
     *    pointermove/up 被 iframe 文档吞掉导致拖动“冻结”；
     * 2) 缓存网格度量，pointermove 中不再触发强制回流。
     */
    private beginDesktopInteraction(metrics: GridMetrics | null): void {
        this._activeMetrics = metrics;
        this.classList.add('od-interacting');
    }

    private endDesktopInteraction(): void {
        this._activeMetrics = null;
        this.classList.remove('od-interacting');
    }

    /**
     * 捕获指针：拖动/缩放期间即使鼠标移出窗口也能连续收到坐标，
     * 避免回窗时产生巨大位移增量导致卡片跳变、抓取点错位。
     */
    private captureCardPointer(element: HTMLElement | null, event: PointerEvent): void {
        try {
            element?.setPointerCapture(event.pointerId);
        } catch {
            // 指针可能已不再活跃（capture 失败不影响常规拖动），忽略
        }
    }

    private startCardDrag(event: PointerEvent, cardId: string): void {
        if (this._pointerState) return;
        const card = this.findCard(cardId);
        const metrics = this.getGridMetrics();
        if (!card || !metrics || event.button !== 0) return;
        // 双击头部打开设置；上一次按下若发生了拖动则不算连击
        const now = Date.now();
        if (
            now - (this._lastHeaderClickAt ?? 0) < 320 &&
            this._lastHeaderClickCardId === cardId &&
            !this._lastHeaderDragMoved
        ) {
            this._lastHeaderClickAt = 0;
            this.showCardEditor(card);
            return;
        }
        this._lastHeaderClickAt = now;
        this._lastHeaderClickCardId = cardId;
        this._lastHeaderDragMoved = false;
        this.hideContextMenu();
        const startRect = gridRectToPixel(card, metrics);
        this._pointerState = {
            type: 'card-drag',
            id: cardId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            start: { gridX: card.gridX, gridY: card.gridY, gridW: card.gridW, gridH: card.gridH },
            currentRect: startRect,
            grabOffsetX: event.clientX - startRect.left,
            grabOffsetY: event.clientY - startRect.top
        };
        const element = this.querySelector<HTMLElement>(`.od-card[data-card-id="${CSS.escape(cardId)}"]`);
        element?.classList.remove('od-card-enter');
        element?.classList.add('od-card-dragging');
        this.bringCardToFront(element);
        this.captureCardPointer(element, event);
        this.beginDesktopInteraction(metrics);
    }

    private _lastHeaderClickAt = 0;
    private _lastHeaderClickCardId: string | null = null;

    private handleCardDragMove(event: PointerEvent): void {
        const state = this._pointerState;
        if (state?.type !== 'card-drag') return;
        const metrics = this._activeMetrics ?? this.getGridMetrics();
        if (!metrics) return;
        const others = this._cards
            .filter((card) => card.id !== state.id && hasCardContent(card))
            .map((card) => gridRectToPixel(card, metrics));
        // 绝对跟随：目标位置 = 指针当前位置 + 抓取偏移。相比按增量位移，
        // 事件丢失（如鼠标移出窗口、被系统打断）不会累积位移差——
        // 指针回到窗口时卡片立即吸附回指针，而不是带着错位的偏移平行漂移。
        const next = movePixelRectAvoidingCards(
            state.currentRect,
            (event.clientX - state.grabOffsetX - state.currentRect.left) / metrics.viewportScaleX,
            (event.clientY - state.grabOffsetY - state.currentRect.top) / metrics.viewportScaleY,
            metrics,
            others
        );
        state.currentRect = next;
        if (Math.abs(event.clientX - state.startClientX) > 5 || Math.abs(event.clientY - state.startClientY) > 5) {
            this._lastHeaderDragMoved = true;
        }
        const element = this.querySelector<HTMLElement>(`.od-card[data-card-id="${CSS.escape(state.id)}"]`);
        if (element) {
            element.style.left = `${next.left}px`;
            element.style.top = `${next.top}px`;
        }
    }

    private finishCardDrag(state: Extract<PointerState, { type: 'card-drag' }>): void {
        const metrics = this._activeMetrics ?? this.getGridMetrics();
        const card = this.findCard(state.id);
        const element = this.querySelector<HTMLElement>(`.od-card[data-card-id="${CSS.escape(state.id)}"]`);
        element?.classList.remove('od-card-dragging');
        if (!card || !metrics) {
            this.endDesktopInteraction();
            this.positionAllCards();
            return;
        }
        const others = this._cards.filter((other) => other.id !== state.id);
        Object.assign(card, resolveDraggedCardLayout(state.currentRect, metrics, state.start, others));
        this.endDesktopInteraction();
        if (element) {
            // 先提交普通卡片样式，再写入吸附位置，确保 CSS transition 不被同帧批量更新跳过。
            void element.offsetWidth;
        }
        // ResizeObserver 在交互中不改写坐标；放下后一次性用当前舞台尺寸重排全部卡片。
        this.positionAllCards();
        if (element) this.restoreCardStacking(element);
        this.saveCards();
    }

    private startCardResize(event: PointerEvent, cardId: string, dir: ResizeDir): void {
        if (this._pointerState) return;
        const card = this.findCard(cardId);
        const metrics = this.getGridMetrics();
        if (!card || !metrics || event.button !== 0) return;
        this.hideContextMenu();
        const element = this.querySelector<HTMLElement>(`.od-card[data-card-id="${CSS.escape(cardId)}"]`);
        element?.classList.remove('od-card-enter');
        element?.classList.add('od-card-resizing');
        this.bringCardToFront(element);
        this.captureCardPointer(element, event);
        this._pointerState = {
            type: 'card-resize',
            id: cardId,
            dir,
            startClientX: event.clientX,
            startClientY: event.clientY,
            startRect: gridRectToPixel(card, metrics)
        };
        this.beginDesktopInteraction(metrics);
    }

    private handleCardResizeMove(event: PointerEvent): void {
        const state = this._pointerState;
        if (state?.type !== 'card-resize') return;
        const metrics = this._activeMetrics ?? this.getGridMetrics();
        const element = this.querySelector<HTMLElement>(`.od-card[data-card-id="${CSS.escape(state.id)}"]`);
        if (!metrics || !element) return;
        const minimum = gridRectToPixel(
            { gridX: 0, gridY: 0, gridW: MIN_CARD_GRID_W, gridH: MIN_CARD_GRID_H },
            metrics
        );
        const rect = resizePixelRectAvoidingCards(
            state.dir,
            state.startRect,
            (event.clientX - state.startClientX) / metrics.viewportScaleX,
            (event.clientY - state.startClientY) / metrics.viewportScaleY,
            metrics,
            this._cards
                .filter((card) => card.id !== state.id && hasCardContent(card))
                .map((card) => gridRectToPixel(card, metrics)),
            minimum.width,
            minimum.height
        );
        element.style.left = `${rect.left}px`;
        element.style.top = `${rect.top}px`;
        element.style.width = `${rect.width}px`;
        element.style.height = `${rect.height}px`;
    }

    private finishCardResize(state: Extract<PointerState, { type: 'card-resize' }>): void {
        const metrics = this._activeMetrics ?? this.getGridMetrics();
        const card = this.findCard(state.id);
        const element = this.querySelector<HTMLElement>(`.od-card[data-card-id="${CSS.escape(state.id)}"]`);
        element?.classList.remove('od-card-resizing');
        if (!card || !metrics || !element) {
            this.endDesktopInteraction();
            this.positionAllCards();
            return;
        }
        const pixel: PixelRect = {
            left: parseFloat(element.style.left) || 0,
            top: parseFloat(element.style.top) || 0,
            width: parseFloat(element.style.width) || 0,
            height: parseFloat(element.style.height) || 0
        };
        const snapped = snapPixelRectToGrid(pixel, metrics, MIN_CARD_GRID_W, MIN_CARD_GRID_H);
        Object.assign(
            card,
            fitResizedCardLayout(
                snapped,
                card,
                state.dir,
                this._cards.filter((other) => other.id !== card.id)
            )
        );
        this.endDesktopInteraction();
        void element.offsetWidth;
        this.positionAllCards();
        this.restoreCardStacking(element);
        this.saveCards();
    }

    private bringCardToFront(element: HTMLElement | null): void {
        if (!element) return;
        element.style.zIndex = String(++this._zSeed);
    }

    /** 吸附动画结束后恢复 DOM 默认堆叠，避免拖动卡片的阴影长期盖住相邻卡片。 */
    private restoreCardStacking(element: HTMLElement): void {
        const clear = (): void => {
            if (element.classList.contains('od-card-dragging') || element.classList.contains('od-card-resizing'))
                return;
            element.style.removeProperty('z-index');
            element.removeEventListener('transitionend', onTransitionEnd);
        };
        const onTransitionEnd = (event: TransitionEvent): void => {
            if (event.target !== element || !['left', 'top', 'width', 'height'].includes(event.propertyName)) return;
            clear();
        };
        element.addEventListener('transitionend', onTransitionEnd);
        window.setTimeout(clear, CARD_SNAP_TRANSITION_MS + 40);
    }

    /* ================= 右键菜单 ================= */

    private showCardContextMenu(cardId: string, clientX: number, clientY: number): void {
        this._contextCardId = cardId;
        this._contextGrid = null;
        const card = this.findCard(cardId);
        const refreshing = this._refreshingCards.has(cardId);
        // 刷新时间二级菜单：当前间隔在左侧打勾，点击即改
        const intervalSubmenu = INTERVAL_OPTIONS.map(
            (option) =>
                `<button type="button" class="od-context-item${option.value === card?.interval ? ' od-sub-active' : ''}" data-menu="interval" data-value="${option.value}"><span class="od-context-check">${option.value === card?.interval ? '<i class="fa-solid fa-check"></i>' : ''}</span>${safeText(this.t(option.key))}</button>`
        ).join('');
        const items: Array<string | false> = [
            `<button class="od-context-item" data-menu="settings"><i class="fa-solid fa-gear"></i>${safeText(this.t('renderer.desktop.menu.settings'))}</button>`,
            card?.prompt && !refreshing
                ? `<button class="od-context-item" data-menu="refresh"><i class="fa-solid fa-rotate"></i>${safeText(this.t('renderer.desktop.menu.refreshNow'))}</button>`
                : card?.prompt && refreshing
                  ? `<button class="od-context-item" disabled><i class="fa-solid fa-rotate"></i>${safeText(this.t('renderer.desktop.menu.refreshNow'))}</button>`
                  : false,
            `<div class="od-context-item od-context-sub-trigger" data-submenu aria-haspopup="true"><i class="fa-solid fa-clock"></i>${safeText(this.t('renderer.desktop.menu.interval'))}<span class="od-context-arrow"><i class="fa-solid fa-chevron-right"></i></span><div class="od-context-submenu">${intervalSubmenu}</div></div>`,
            'sep',
            `<button class="od-context-item" data-menu="copy"><i class="fa-regular fa-copy"></i>${safeText(this.t('renderer.desktop.menu.copy'))}</button>`,
            `<button class="od-context-item danger" data-menu="delete"><i class="fa-regular fa-trash-can"></i>${safeText(this.t('common.delete'))}</button>`
        ];
        this.renderContextMenu(items, clientX, clientY);
    }

    private showBlankContextMenu(clientX: number, clientY: number): void {
        this._contextCardId = null;
        const metrics = this.getGridMetrics();
        this._contextGrid = metrics
            ? {
                  gridX: clamp(
                      Math.floor((clientX - metrics.left) / metrics.viewportScaleX / metrics.cellW),
                      0,
                      GRID_COLUMNS - 1
                  ),
                  gridY: clamp(
                      Math.floor((clientY - metrics.top) / metrics.viewportScaleY / metrics.cellH),
                      0,
                      GRID_ROWS - 1
                  )
              }
            : null;
        const hasClipboard = !!cardClipboard.card;
        const items: Array<string | false> = [
            `<button class="od-context-item" data-menu="add"><i class="fa-solid fa-plus"></i>${safeText(this.t('renderer.desktop.addCard'))}</button>`,
            hasClipboard
                ? `<button class="od-context-item" data-menu="paste"><i class="fa-regular fa-paste"></i>${safeText(this.t('renderer.desktop.menu.paste'))}</button>`
                : `<button class="od-context-item" disabled><i class="fa-regular fa-paste"></i>${safeText(this.t('renderer.desktop.menu.paste'))}</button>`
        ];
        this.renderContextMenu(items, clientX, clientY);
    }

    private renderContextMenu(items: Array<string | false>, clientX: number, clientY: number): void {
        const menu = this.querySelector('[data-context-menu]') as HTMLElement | null;
        if (!menu) return;
        menu.innerHTML = items
            .filter((item) => item !== false)
            .map((item) => (item === 'sep' ? '<div class="od-context-sep"></div>' : item))
            .join('');
        menu.hidden = false;
        // 菜单 fixed 定位在 #app-root 内，坐标原点是内容区而非视口（见 window-frame.ts）；
        // 防溢出修正同样基于可视内容区
        const view = visibleViewportRect();
        const origin = fixedLayerOrigin(menu);
        // 菜单贴右侧屏幕时二级菜单翻到左侧展开
        menu.classList.toggle('od-sub-opens-left', clientX > view.right - 380);
        const left = clamp(clientX - origin.x, 8, Math.max(8, view.right - origin.x - 210));
        const top = clamp(clientY - origin.y, 8, Math.max(8, view.bottom - origin.y - 60));
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
    }

    private hideContextMenu(): void {
        const menu = this.querySelector('[data-context-menu]') as HTMLElement | null;
        if (menu) menu.hidden = true;
    }

    private isContextMenuHidden(): boolean {
        const menu = this.querySelector('[data-context-menu]') as HTMLElement | null;
        return !menu || menu.hidden;
    }

    private handleContextMenuClick = (event: Event): void => {
        const target = event.target as HTMLElement;
        // 卡片头部的失败警告标记：点击直达出错的生成任务
        const jump = target.closest?.('[data-card-error-jump]') as HTMLElement | null;
        if (jump) {
            void this.openTaskWindow(jump.dataset.cardErrorJump ?? '');
            return;
        }
        const item = target.closest?.('[data-menu]') as HTMLElement | null;
        if (!item || item.hasAttribute('disabled')) return;
        const action = item.dataset.menu;
        this.hideContextMenu();
        switch (action) {
            case 'settings': {
                const card = this.findCard(this._contextCardId ?? undefined);
                if (card) this.showCardEditor(card);
                break;
            }
            case 'refresh': {
                const card = this.findCard(this._contextCardId ?? undefined);
                if (card) void this.refreshCard(card);
                break;
            }
            case 'interval': {
                const card = this.findCard(this._contextCardId ?? undefined);
                if (card) {
                    card.interval = normalizeInterval(item.dataset.value);
                    this.saveCards();
                    // 只改间隔不重建卡片：就地更新胶囊上的间隔徽标，避免 iframe 重载闪烁
                    const live = this.querySelector<HTMLElement>(
                        `.od-card[data-card-id="${CSS.escape(card.id)}"] .od-card-live`
                    );
                    if (live) live.textContent = this.t(`renderer.desktop.card.interval.${card.interval}`);
                }
                break;
            }
            case 'copy': {
                const card = this.findCard(this._contextCardId ?? undefined);
                if (card) this.copyCard(card);
                break;
            }
            case 'paste':
                this.pasteCard();
                break;
            case 'delete': {
                const card = this.findCard(this._contextCardId ?? undefined);
                if (card) this.deleteCard(card.id);
                break;
            }
            case 'add': {
                const start = this._contextGrid ?? { gridX: 0, gridY: 0 };
                this.createSmartCardAt(findAvailableCardLayout(start.gridX, start.gridY, this._cards));
                break;
            }
        }
        this._contextCardId = null;
        this._contextGrid = null;
    };

    /**
     * 卡片内链接点击（由 composeCardSrcDoc 注入的拦截脚本转发）：
     * 仅接受 http(s) 链接，以浏览器浮窗打开，避免卡片被就地导航毁掉。
     * 以及卡片内的右键（od-card-contextmenu）：卡片任意位置右键都弹出卡片菜单。
     */
    private onCardLinkMessage = (event: MessageEvent): void => {
        const data = event.data as { type?: string; url?: string; x?: number; y?: number } | null;
        if (!data || typeof data.type !== 'string') return;
        if (data.type === 'od-open-link') {
            if (typeof data.url !== 'string') return;
            if (!/^https?:\/\//i.test(data.url)) return;
            void this.openLinkInBrowser(data.url);
            return;
        }
        if (data.type === 'od-card-contextmenu') {
            this.showCardContextMenuFromFrame(event.source, data.x, data.y);
        }
    };

    /**
     * iframe 内右键（由注入脚本转发）：右键事件停留在 iframe 文档内，
     * 父层拿不到，这里按消息来源定位卡片，把 iframe 视口坐标换算为桌面
     * 客户区坐标后弹出卡片上下文菜单。
     */
    private showCardContextMenuFromFrame(source: MessageEventSource | null, x: unknown, y: unknown): void {
        if (!source || typeof x !== 'number' || typeof y !== 'number') return;
        const cardElement = Array.from(this.querySelectorAll<HTMLElement>('.od-card')).find(
            (element) => element.querySelector('iframe')?.contentWindow === source
        );
        const frame = cardElement?.querySelector('iframe');
        if (!cardElement || !frame || !cardElement.dataset.cardId) return;
        const rect = frame.getBoundingClientRect();
        // 桌面可能存在整体缩放，按渲染尺寸/布局尺寸折算 iframe 本地坐标
        const scaleX = frame.offsetWidth ? rect.width / frame.offsetWidth : 1;
        const scaleY = frame.offsetHeight ? rect.height / frame.offsetHeight : 1;
        this.showCardContextMenu(cardElement.dataset.cardId, rect.left + x * scaleX, rect.top + y * scaleY);
    }

    private async openLinkInBrowser(url: string): Promise<void> {
        const desktopWindow = await this.openApplicationWindow('browser');
        if (!desktopWindow) return;
        const browser = desktopWindow.contentElement.querySelector('browser-entry-widget') as
            (HTMLElement & { openUrl?: (url: string) => void }) | null;
        browser?.openUrl?.(url);
    }

    /* ================= 卡片复制 / 粘贴 / 删除 ================= */

    private copyCard(card: SmartCard): void {
        cardClipboard.card = {
            ...card,
            html: card.html,
            prompt: card.prompt
        };
    }

    private pasteCard(): void {
        const source = cardClipboard.card;
        if (!source) return;
        const start = this._contextGrid ?? { gridX: 0, gridY: 0 };
        const layout = findAvailableCardLayout(start.gridX, start.gridY, this._cards, source.gridW, source.gridH);
        if (!layout) return;
        const card: SmartCard = {
            ...source,
            id: createCardId(),
            gridX: layout.gridX,
            gridY: layout.gridY,
            gridW: layout.gridW,
            gridH: layout.gridH,
            // 副本拥有自己的刷新生命周期，不继承源卡片的错误状态
            lastError: undefined,
            lastErrorAt: undefined,
            lastErrorTaskId: undefined
        };
        this._cards.push(card);
        this.saveCards();
        this.updateSingleCard(card);
    }

    private deleteCard(cardId: string): void {
        this._cards = this._cards.filter((card) => card.id !== cardId);
        this._refreshingCards.delete(cardId);
        this.saveCards();
        this.querySelector<HTMLElement>(`.od-card[data-card-id="${CSS.escape(cardId)}"]`)?.remove();
        this.updateEmptyState();
    }

    /* ================= 卡片设置模态 ================= */

    /**
     * 卡片设置模态：复用 confirmModal 的顶部色带体系（docs/designs/modal.html 规范，
     * 与设置界面模型编辑等弹窗一致）。含表单，刻意不绑定"点击遮罩关闭"——
     * 对应 bindOverlayDismiss 的 enabled=false 语义，避免误触遮罩丢失正在填写的内容。
     */
    private showCardEditor(card: SmartCard): void {
        const host = this.querySelector('[data-modal-host]') as HTMLElement | null;
        if (!host) return;
        // 打开时的原始值：底部按钮按"去除首尾空格后的关注内容是否变化"切换
        const originalPrompt = card.prompt;
        const originalInterval = card.interval;
        const intervalOptions = INTERVAL_OPTIONS.map(
            (option) =>
                `<option value="${option.value}" ${card.interval === option.value ? 'selected' : ''}>${safeText(this.t(option.key))}</option>`
        ).join('');
        host.innerHTML = `
        <div class="od-confirm-modal-overlay${detectDarkMode(host) ? ' od-modal-dark' : ''}">
            <style>${MODAL_CSS}
            /* 卡片设置表单：遵循 modal.html §02 表单区标注（16/24 内边距、12 组间距、11.5 标签） */
            .od-card-editor-card { width: 460px; max-width: 92vw; }
            .od-card-editor-form { padding: 16px 24px; display: flex; flex-direction: column; gap: 12px; }
            .od-card-editor-form .fg { display: flex; flex-direction: column; gap: 5px; }
            .od-card-editor-form .fl { font-size: 11.5px; font-weight: 500; color: var(--mc-ink2); }
            .od-card-editor-form textarea, .od-card-editor-form select {
                appearance: none; -webkit-appearance: none;
                width: 100%; box-sizing: border-box;
                border: 1px solid var(--mc-line); border-radius: 8px; background: var(--mc-bg);
                padding: 7px 10px; font-family: inherit; font-size: 12px; color: var(--mc-ink2);
                transition: border-color 0.15s; outline: none;
            }
            .od-card-editor-form textarea { min-height: 96px; resize: vertical; line-height: 1.6; }
            .od-card-editor-form textarea::placeholder { color: var(--mc-ink4); }
            .od-card-editor-form select {
                padding-right: 24px; cursor: pointer;
                background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%239B968F' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>");
                background-repeat: no-repeat; background-position: right 8px center;
            }
            .od-card-editor-form textarea:focus, .od-card-editor-form select:focus { border-color: var(--mc-accent); }
            </style>
            <div class="od-confirm-modal-card od-card-editor-card" role="dialog" aria-modal="true">
                <div class="od-confirm-modal-banner info">
                    <div class="od-confirm-modal-icon">${renderIcon('fa-gear')}</div>
                    <div class="od-confirm-modal-banner-text">
                        <div class="od-confirm-modal-title">${safeText(this.t('renderer.desktop.card.editorTitle'))}</div>
                    </div>
                    <button type="button" class="od-confirm-modal-close" data-card-editor-close aria-label="${safeText(this.t('common.close'))}">${CLOSE_SVG}</button>
                </div>
                <div class="od-card-editor-form">
                    <div class="fg">
                        <label class="fl" for="od-card-editor-prompt">${safeText(this.t('renderer.desktop.card.promptLabel'))}</label>
                        <textarea id="od-card-editor-prompt" data-card-prompt placeholder="${safeText(this.t('renderer.desktop.card.promptPlaceholder'))}">${safeText(card.prompt)}</textarea>
                    </div>
                    <div class="fg">
                        <label class="fl" for="od-card-editor-interval">${safeText(this.t('renderer.desktop.card.intervalLabel'))}</label>
                        <select id="od-card-editor-interval" data-card-editor-interval>${intervalOptions}</select>
                    </div>
                </div>
                <div class="od-confirm-modal-footer">
                    <button type="button" class="od-confirm-btn od-confirm-btn-cancel" data-card-editor-cancel>${safeText(this.t('common.cancel'))}</button>
                    <button type="button" class="od-confirm-btn od-confirm-btn-primary" data-card-editor-save>${safeText(this.t('renderer.desktop.card.save'))}</button>
                    <button type="button" class="od-confirm-btn od-confirm-btn-primary" data-card-editor-save-generate hidden>${safeText(this.t('renderer.desktop.card.saveAndGenerate'))}</button>
                </div>
            </div>
        </div>`;
        const textarea = host.querySelector('[data-card-prompt]') as HTMLTextAreaElement | null;
        const saveBtn = host.querySelector('[data-card-editor-save]') as HTMLButtonElement | null;
        const generateBtn = host.querySelector('[data-card-editor-save-generate]') as HTMLButtonElement | null;
        host.querySelector('[data-card-editor-close]')?.addEventListener('click', () => this.closeCardEditor());
        host.querySelector('[data-card-editor-cancel]')?.addEventListener('click', () => this.closeCardEditor());

        // 关注内容按首尾空格裁剪后对比：未变化只显示"保存"（避免无谓的重新生成），
        // 有变化时追加"保存并立即生成"。两个按钮恒为红色主样式，切换只控制显隐，
        // 避免"保存"按钮背景随输入来回闪变。
        const syncEditorActions = (): void => {
            if (!textarea || !saveBtn || !generateBtn) return;
            generateBtn.hidden = textarea.value.trim() === originalPrompt.trim();
        };
        textarea?.addEventListener('input', syncEditorActions);
        syncEditorActions();

        const applyEditor = (generate: boolean): void => {
            const latest = this.findCard(card.id);
            if (!latest || !textarea) return;
            const interval = host.querySelector('[data-card-editor-interval]') as HTMLSelectElement | null;
            latest.prompt = textarea.value.trim();
            latest.interval = normalizeInterval(interval?.value);
            if (!hasCardContent(latest)) {
                if (this._editingNewCardId !== latest.id) this.deleteCard(latest.id);
                this.closeCardEditor();
                return;
            }
            this._editingNewCardId = null;
            this.saveCards();
            this.closeCardEditor();
            // 内容与间隔都未变化时不重建卡片，避免 iframe 无谓重载闪烁
            if (latest.prompt !== originalPrompt.trim() || latest.interval !== originalInterval) {
                // 只更新当前卡片，避免全量重渲染导致其它卡片的 iframe 重新加载
                this.updateSingleCard(latest);
            }
            if (generate && latest.prompt) void this.refreshCard(latest);
        };
        saveBtn?.addEventListener('click', () => applyEditor(false));
        generateBtn?.addEventListener('click', () => applyEditor(true));
        // Ctrl/Cmd + Enter 触发当前主操作：未变更时为"保存"，变更后为"保存并立即生成"
        textarea?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                (generateBtn && !generateBtn.hidden ? generateBtn : saveBtn)?.click();
            }
        });
        window.setTimeout(() => textarea?.focus(), 0);
    }

    private closeCardEditor(): void {
        const host = this.querySelector('[data-modal-host]') as HTMLElement | null;
        if (host) host.innerHTML = '';
        if (this._editingNewCardId) {
            this._cards = this._cards.filter((card) => card.id !== this._editingNewCardId);
            this._editingNewCardId = null;
        }
    }

    /* ================= 卡片生成与定时刷新 ================= */

    private refreshDueCards(): void {
        const now = Date.now();
        for (const card of this._cards) {
            if (!card.prompt.trim() || this._refreshingCards.has(card.id)) continue;
            if (!card.lastUpdatedAt || now - card.lastUpdatedAt >= cardIntervalMs(card.interval)) {
                void this.refreshCard(card);
            }
        }
    }

    private async refreshCard(card: SmartCard): Promise<void> {
        if (this._refreshingCards.has(card.id)) return;
        if (!card.prompt.trim()) {
            this.showCardEditor(card);
            return;
        }
        this._refreshingCards.add(card.id);
        this.beginCardRefresh(card);
        this.updateRefreshingChip();
        const promptAtStart = card.prompt;
        try {
            const rect = this.getCardPixelRect(card);
            // preload 返回完整结果对象：{ status, data?, message?, taskId? }
            const result = await globalWindow.desktopAPI?.generateCardContent?.({
                prompt: card.prompt,
                currentHtml: card.html,
                width: Math.max(160, Math.round(rect.width)),
                height: Math.max(120, Math.round(rect.height)),
                locale: this._locale,
                theme: this.getTheme()
            });
            if (!result || result.status !== 'ok') {
                // 失败不立即抛出：先记录出错任务 id，供头部警告标记跳转
                card.lastErrorTaskId = result?.taskId || card.lastErrorTaskId;
                throw new Error(result?.message || this.t('renderer.desktop.card.generateEmpty'));
            }
            card.html = result.data.html;
            card.lastUpdatedAt = Date.now();
            card.lastError = undefined;
            card.lastErrorAt = undefined;
            card.lastErrorTaskId = undefined;
            this.saveCards();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            card.lastError = message;
            card.lastErrorAt = Date.now();
            card.lastUpdatedAt = Date.now();
            this.saveCards();
        } finally {
            this._refreshingCards.delete(card.id);
            this.updateRefreshingChip();
            // 卡片在生成期间被删除时跳过重渲，避免 updateSingleCard 触发全量 renderCards
            if (this._cards.includes(card)) {
                this.updateSingleCard(card);
                // 生成期间用户改了 prompt（编辑确认因在途被跳过），用新内容补一次刷新
                if (card.prompt.trim() && card.prompt !== promptAtStart) {
                    void this.refreshCard(card);
                }
            }
        }
    }

    /* ================= 应用列表 ================= */

    private async loadApplications(): Promise<void> {
        try {
            const list = await globalWindow.applicationRegistryAPI?.getApplicationList?.();
            if (!Array.isArray(list)) return;
            let features: ExperimentalFeatureSettings | undefined;
            try {
                const setting = await globalWindow.settingAPI?.loadSettingObject?.();
                features = setting?.debug?.experimental_features;
            } catch {
                // 读取失败时按未开启实验性应用处理
            }
            // 与侧边栏的应用可见性规则保持一致（含用户已开启的实验性应用）
            this._apps = (list as DesktopApp[]).filter((app) => isApplicationVisibleInMenu(app, features ?? null));
        } catch {
            this._apps = [];
        }
        this.renderAppList();
    }

    private isAppListHidden(): boolean {
        const panel = this.querySelector('[data-applist]') as HTMLElement | null;
        return !panel || panel.hidden;
    }

    private toggleAppList(): void {
        const panel = this.querySelector('[data-applist]') as HTMLElement | null;
        if (!panel) return;
        if (panel.hidden) {
            this.renderAppList();
            panel.hidden = false;
            const button = this.querySelector('[data-apps-btn]');
            button?.classList.add('active');
            button?.setAttribute('aria-expanded', 'true');
        } else {
            this.hideAppList();
        }
    }

    private hideAppList(): void {
        const panel = this.querySelector('[data-applist]') as HTMLElement | null;
        if (panel) panel.hidden = true;
        const button = this.querySelector('[data-apps-btn]');
        button?.classList.remove('active');
        button?.setAttribute('aria-expanded', 'false');
    }

    private renderAppList(): void {
        const panel = this.querySelector('[data-applist]') as HTMLElement | null;
        if (!panel) return;
        // 应用清单未变化时跳过重渲，避免反复打开面板时图标闪烁
        const signature = this._apps.map((app) => app.bundleName).join(',');
        if (signature === this._renderedAppsSignature && panel.childElementCount) return;
        this._renderedAppsSignature = signature;
        const defaultIconUrl = './applications/default_icon.png';
        const items = this._apps
            .map((app) => {
                const iconUrl = app.iconUrl || `./applications/${app.bundleName}/icon.svg`;
                const pngFallbackUrl = `./applications/${app.bundleName}/icon.png`;
                const iconClass = /\.svg$/i.test(iconUrl) ? 'od-app-icon-svg' : '';
                return `
                <button type="button" role="menuitem" class="od-applist-item" data-app-bundle="${safeText(app.bundleName)}" title="${safeText(app.name)}">
                    <span class="od-applist-icon"><img data-app-icon src="${safeText(iconUrl)}" data-png-fallback="${safeText(pngFallbackUrl)}" alt="" class="${iconClass}"></span>
                    <span class="od-applist-label">${safeText(app.name)}</span>
                </button>`;
            })
            .join('');
        panel.innerHTML = `<div class="od-applist-grid">${items || `<div class="od-applist-empty">${safeText(this.t('renderer.desktop.appList.empty'))}</div>`}</div>`;
        panel.querySelectorAll<HTMLImageElement>('[data-app-icon]').forEach((image) => {
            image.addEventListener('error', () => {
                const step = Number(image.dataset.fallbackStep ?? '0');
                if (step === 0) {
                    image.dataset.fallbackStep = '1';
                    image.src = image.dataset.pngFallback ?? defaultIconUrl;
                } else if (step === 1) {
                    image.dataset.fallbackStep = '2';
                    image.src = defaultIconUrl;
                }
            });
        });
        panel.querySelector('.od-applist-grid')?.addEventListener('click', (event) => {
            const item = (event.target as HTMLElement).closest?.('[data-app-bundle]') as HTMLElement | null;
            if (!item) return;
            this.hideAppList();
            void this.openApplicationWindow(item.dataset.appBundle ?? '');
        });
    }

    /* ================= 浮动窗口 ================= */

    private createFloatingWindow(input: {
        id: string;
        kind: DesktopWindowKind;
        bundleName?: string;
        title: string;
        iconUrl?: string;
        width: number;
        height: number;
    }): DesktopWindow {
        const offset = (this._windows.size % 5) * 28;
        // 浮窗坐标是内容区坐标（fixed 于 #app-root），尺寸/摆放上限基于可视内容区
        const view = visibleViewportRect();
        const width = Math.min(input.width, Math.max(360, view.right - view.left - 32));
        const height = Math.min(input.height, Math.max(260, view.bottom - view.top - 32));
        const x = clamp(64 + offset, 8, Math.max(8, view.right - view.left - width - 8));
        const y = clamp(48 + offset, 8, Math.max(8, view.bottom - view.top - height - 8));
        const element = document.createElement('section');
        element.className = 'od-floating-window od-window-enter';
        element.dataset.desktopWindowId = input.id;
        element.innerHTML = `
            <header class="od-floating-window-titlebar" data-window-drag="${safeText(input.id)}" data-od-no-longpress="1">
                <div class="od-floating-window-title">
                    ${
                        input.iconUrl
                            ? `<img src="${safeText(input.iconUrl)}" alt="" onerror="this.style.display='none'">`
                            : '<i class="fa-solid fa-window-maximize"></i>'
                    }
                    <strong>${safeText(input.title)}</strong>
                </div>
                <div class="od-floating-window-controls">
                    <button type="button" data-window-minimize="${safeText(input.id)}" title="${safeText(this.t('renderer.desktop.window.minimize'))}"><i class="fa-solid fa-minus"></i></button>
                    <button type="button" data-window-maximize="${safeText(input.id)}" title="${safeText(this.t('renderer.desktop.window.maximize'))}"><i class="fa-regular fa-square"></i></button>
                    <button type="button" data-window-close="${safeText(input.id)}" title="${safeText(this.t('renderer.desktop.window.close'))}"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </header>
            <div class="od-floating-window-content" data-window-content></div>
            ${this.renderWindowResizeHandles()}
        `;
        const contentElement = element.querySelector('[data-window-content]') as HTMLElement;
        element.addEventListener('pointerdown', () => this.bringWindowToFront(input.id));
        element.querySelector('[data-window-minimize]')?.addEventListener('click', () => this.minimizeWindow(input.id));
        element
            .querySelector('[data-window-maximize]')
            ?.addEventListener('click', () => this.toggleMaximizeWindow(input.id));
        element.querySelector('[data-window-close]')?.addEventListener('click', () => this.closeWindow(input.id));
        return {
            id: input.id,
            kind: input.kind,
            bundleName: input.bundleName,
            title: input.title,
            iconUrl: input.iconUrl,
            x,
            y,
            width,
            height,
            zIndex: ++this._zSeed,
            minimized: false,
            maximized: false,
            element,
            contentElement
        };
    }

    private renderWindowResizeHandles(): string {
        const dirs: ResizeDir[] = ['n', 'e', 'w', 's', 'ne', 'nw', 'se', 'sw'];
        // data-od-no-longpress：触摸长按脚本按下即跳过，不显示进度圆环
        return dirs
            .map((dir) => `<div class="od-window-resize-handle" data-dir="${dir}" data-od-no-longpress="1"></div>`)
            .join('');
    }

    private attachWindow(desktopWindow: DesktopWindow): void {
        this._windows.set(desktopWindow.id, desktopWindow);
        this.appendChild(desktopWindow.element);
        this.positionWindow(desktopWindow);
        this.bringWindowToFront(desktopWindow.id);
        // 入场动画只播一次，之后最小化/恢复不重播
        window.setTimeout(() => desktopWindow.element.classList.remove('od-window-enter'), 300);
    }

    private positionAllWindows(): void {
        for (const desktopWindow of this._windows.values()) this.positionWindow(desktopWindow);
    }

    private positionWindow(desktopWindow: DesktopWindow): void {
        desktopWindow.element.style.left = `${desktopWindow.x}px`;
        desktopWindow.element.style.top = `${desktopWindow.y}px`;
        desktopWindow.element.style.width = `${desktopWindow.width}px`;
        desktopWindow.element.style.height = `${desktopWindow.height}px`;
        desktopWindow.element.style.zIndex = String(desktopWindow.zIndex);
    }

    private bringWindowToFront(windowId: string | undefined): void {
        const desktopWindow = this._windows.get(windowId ?? '');
        if (!desktopWindow) return;
        desktopWindow.zIndex = ++this._zSeed;
        desktopWindow.element.style.zIndex = String(desktopWindow.zIndex);
    }

    private closeWindow(windowId: string | undefined): void {
        const desktopWindow = this._windows.get(windowId ?? '');
        if (!desktopWindow) return;
        desktopWindow.element.remove();
        this._windows.delete(desktopWindow.id);
        this.renderMinimizedDock();
    }

    private minimizeWindow(windowId: string | undefined): void {
        const desktopWindow = this._windows.get(windowId ?? '');
        if (!desktopWindow) return;
        desktopWindow.minimized = true;
        desktopWindow.element.hidden = true;
        this.renderMinimizedDock();
    }

    private restoreWindow(windowId: string | undefined): void {
        const desktopWindow = this._windows.get(windowId ?? '');
        if (!desktopWindow) return;
        desktopWindow.minimized = false;
        desktopWindow.element.hidden = false;
        this.bringWindowToFront(desktopWindow.id);
        this.renderMinimizedDock();
    }

    private toggleMaximizeWindow(windowId: string | undefined): void {
        const desktopWindow = this._windows.get(windowId ?? '');
        if (!desktopWindow) return;
        if (desktopWindow.maximized) {
            const restore = desktopWindow.restoreRect ?? {
                x: desktopWindow.x,
                y: desktopWindow.y,
                width: desktopWindow.width,
                height: desktopWindow.height
            };
            desktopWindow.x = restore.x;
            desktopWindow.y = restore.y;
            desktopWindow.width = restore.width;
            desktopWindow.height = restore.height;
            desktopWindow.maximized = false;
        } else {
            desktopWindow.restoreRect = {
                x: desktopWindow.x,
                y: desktopWindow.y,
                width: desktopWindow.width,
                height: desktopWindow.height
            };
            const view = visibleViewportRect();
            desktopWindow.x = 12;
            desktopWindow.y = 12;
            desktopWindow.width = view.right - view.left - 24;
            desktopWindow.height = view.bottom - view.top - 24;
            desktopWindow.maximized = true;
        }
        this.positionWindow(desktopWindow);
        this.updateMaximizeButton(desktopWindow);
    }

    private updateMaximizeButton(desktopWindow: DesktopWindow): void {
        const icon = desktopWindow.element.querySelector<HTMLButtonElement>('[data-window-maximize] i');
        if (icon) {
            icon.className = desktopWindow.maximized ? 'fa-regular fa-window-restore' : 'fa-regular fa-square';
        }
    }

    private renderMinimizedDock(): void {
        const dock = this.querySelector('[data-minimized-dock]') as HTMLElement | null;
        if (!dock) return;
        const minimized = [...this._windows.values()].filter((item) => item.minimized);
        dock.innerHTML = minimized
            .map(
                (item) => `
                <div class="od-minimized-pill" data-restore-window="${safeText(item.id)}" title="${safeText(item.title)}">
                    ${item.iconUrl ? `<img src="${safeText(item.iconUrl)}" width="14" height="14" alt="">` : '<i class="fa-regular fa-window-maximize"></i>'}
                    <strong>${safeText(item.title)}</strong>
                </div>`
            )
            .join('');
        dock.querySelectorAll('[data-restore-window]').forEach((pill) => {
            pill.addEventListener('click', () => this.restoreWindow((pill as HTMLElement).dataset.restoreWindow));
        });
    }

    /* ---------- 窗口拖动 / 缩放 ---------- */

    private startWindowDrag(event: PointerEvent, windowId: string): void {
        if (this._pointerState) return;
        const desktopWindow = this._windows.get(windowId);
        if (!desktopWindow || event.button !== 0) return;
        if (desktopWindow.maximized) return;
        this.hideContextMenu();
        this.bringWindowToFront(windowId);
        this.beginDesktopInteraction(null);
        this._pointerState = {
            type: 'window-drag',
            id: windowId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            startX: desktopWindow.x,
            startY: desktopWindow.y
        };
    }

    private handleWindowDragMove(event: PointerEvent): void {
        const state = this._pointerState;
        if (state?.type !== 'window-drag') return;
        const desktopWindow = this._windows.get(state.id);
        if (!desktopWindow) return;
        const view = visibleViewportRect();
        desktopWindow.x = clamp(
            state.startX + (event.clientX - state.startClientX),
            -desktopWindow.width + 80,
            Math.max(8, view.right - view.left - 80)
        );
        desktopWindow.y = clamp(
            state.startY + (event.clientY - state.startClientY),
            0,
            Math.max(8, view.bottom - view.top - 40)
        );
        this.positionWindow(desktopWindow);
    }

    private startWindowResize(event: PointerEvent, windowId: string, dir: ResizeDir): void {
        if (this._pointerState) return;
        const desktopWindow = this._windows.get(windowId);
        if (!desktopWindow || event.button !== 0) return;
        this.hideContextMenu();
        this.bringWindowToFront(windowId);
        this.beginDesktopInteraction(null);
        this._pointerState = {
            type: 'window-resize',
            id: windowId,
            dir,
            startClientX: event.clientX,
            startClientY: event.clientY,
            startRect: {
                x: desktopWindow.x,
                y: desktopWindow.y,
                width: desktopWindow.width,
                height: desktopWindow.height
            }
        };
    }

    private handleWindowResizeMove(event: PointerEvent): void {
        const state = this._pointerState;
        if (state?.type !== 'window-resize') return;
        const desktopWindow = this._windows.get(state.id);
        if (!desktopWindow) return;
        const start = state.startRect;
        const dx = event.clientX - state.startClientX;
        const dy = event.clientY - state.startClientY;
        const view = visibleViewportRect();
        if (state.dir.includes('n')) {
            const delta = clamp(dy, -start.y, start.height - 220);
            desktopWindow.y = start.y + delta;
            desktopWindow.height = start.height - delta;
        }
        if (state.dir.includes('e')) {
            desktopWindow.width = clamp(start.width + dx, 320, view.right - view.left - start.x);
        }
        if (state.dir.includes('s')) {
            desktopWindow.height = clamp(start.height + dy, 220, view.bottom - view.top - start.y);
        }
        if (state.dir.includes('w')) {
            const delta = clamp(dx, -start.x, start.width - 320);
            desktopWindow.x = start.x + delta;
            desktopWindow.width = start.width - delta;
        }
        this.positionWindow(desktopWindow);
    }

    /* ---------- 打开应用 / 对话 ---------- */

    private async openApplicationWindow(bundleName: string): Promise<DesktopWindow | null> {
        if (!bundleName) return null;
        const windowId = createWindowId('app', bundleName);
        const existing = this._windows.get(windowId);
        if (existing) {
            this.restoreWindow(windowId);
            this.bringWindowToFront(windowId);
            return existing;
        }
        const app = this._apps.find((item) => item.bundleName === bundleName);
        const title = app?.name || bundleName;
        const desktopWindow = this.createFloatingWindow({
            id: windowId,
            kind: 'app',
            bundleName,
            title,
            iconUrl: app?.iconUrl || `./applications/${bundleName}/icon.png`,
            width: Math.min(980, Math.max(680, window.innerWidth * 0.58)),
            height: Math.min(720, Math.max(460, window.innerHeight * 0.62))
        });
        desktopWindow.contentElement.innerHTML = `
            <div class="od-window-loading">
                <span class="od-spinner"></span>
                <span>${safeText(this.t('renderer.desktop.app.loading'))}</span>
            </div>`;
        this.attachWindow(desktopWindow);
        await this.mountApplicationContent(desktopWindow, bundleName, title);
        return desktopWindow;
    }

    private async mountApplicationContent(
        desktopWindow: DesktopWindow,
        bundleName: string,
        title: string
    ): Promise<void> {
        desktopWindow.contentElement.innerHTML = '';
        if (bundleName === 'browser') {
            const browser = document.createElement('browser-entry-widget');
            browser.style.cssText = 'width:100%;height:100%;display:block;';
            desktopWindow.contentElement.appendChild(browser);
        } else {
            const frame = document.createElement('iframe');
            frame.className = 'od-desktop-app-frame';
            frame.src = await this.resolveApplicationFrameSrc(bundleName);
            frame.setAttribute('title', this.t('renderer.desktop.app.frameTitle', { app: title }));
            frame.style.pointerEvents = 'auto';
            // 应用页加载完成瞬间补发当前主题/字体，消除与主界面的短暂不一致
            // （消息格式与 renderer/theme/theme-iframe-bridge 的 THEME_SETTINGS 一致）
            frame.addEventListener('load', () => {
                const win = frame.contentWindow;
                if (!win) return;
                const theme = document.documentElement.dataset.theme;
                if (theme === 'dark' || theme === 'light') {
                    win.postMessage({ type: 'THEME_SETTINGS', theme }, '*');
                }
                const fontPreset = document.documentElement.getAttribute('data-font-preset');
                if (fontPreset) {
                    win.postMessage({ type: 'FONT_SETTINGS', fontPreset }, '*');
                }
            });
            desktopWindow.contentElement.appendChild(frame);
        }
        document.dispatchEvent(new CustomEvent('application-opened', { detail: { bundleName } }));
        if (bundleName !== 'mailbox') {
            globalWindow.applicationRegistryAPI?.call?.('mailbox', 'notifyMailboxClosed')?.catch?.(() => undefined);
        } else {
            globalWindow.applicationRegistryAPI?.call?.('mailbox', 'notifyMailboxOpened')?.catch?.(() => undefined);
        }
    }

    private async resolveApplicationFrameSrc(bundleName: string): Promise<string> {
        try {
            const config = (await globalWindow.applicationRegistryAPI?.getApplicationGUIConfig?.(bundleName)) as
                ApplicationGuiConfig | null | undefined;
            if (config?.source === 'user' && config.entryUrl) {
                return config.entryUrl;
            }
        } catch {
            // 回退到内建应用宿主页面
        }
        return `./application.html?applicationBundleName=${encodeURIComponent(bundleName)}`;
    }

    private async ensureChatTask(): Promise<string | null> {
        // 复用同一个桌面会话任务，保证连续对话且已打开的对话窗口内容持续更新
        const cached = globalWindow.localStorage?.getItem(CHAT_TASK_STORAGE_KEY);
        if (cached && globalWindow.taskManagerAPI?.getFullTask) {
            try {
                await globalWindow.taskManagerAPI.getFullTask(cached);
                return cached;
            } catch {
                globalWindow.localStorage?.removeItem(CHAT_TASK_STORAGE_KEY);
            }
        }
        try {
            const taskId = await globalWindow.taskManagerAPI?.createTask?.({
                internal: true,
                taskName: this.t('renderer.desktop.chat.taskName')
            });
            if (taskId) globalWindow.localStorage?.setItem(CHAT_TASK_STORAGE_KEY, taskId);
            return taskId || null;
        } catch {
            return null;
        }
    }

    private async openChatWindow(taskId: string): Promise<void> {
        const windowId = createWindowId('chat');
        const existing = this._windows.get(windowId);
        if (existing) {
            this.restoreWindow(windowId);
            this.bringWindowToFront(windowId);
            return;
        }
        const desktopWindow = this.createFloatingWindow({
            id: windowId,
            kind: 'chat',
            title: this.t('renderer.desktop.chat.title'),
            width: 560,
            height: Math.min(680, Math.max(420, window.innerHeight * 0.6))
        });
        desktopWindow.contentElement.innerHTML = `<task-view embedded task_id="${safeText(taskId)}"></task-view>`;
        this.attachWindow(desktopWindow);
    }

    /** 在浮窗中查看出错的卡片生成任务（警告标记点击入口）。 */
    private async openTaskWindow(taskId: string): Promise<void> {
        if (!taskId) return;
        const windowId = `task:${taskId}`;
        const existing = this._windows.get(windowId);
        if (existing) {
            this.restoreWindow(windowId);
            this.bringWindowToFront(windowId);
            return;
        }
        const desktopWindow = this.createFloatingWindow({
            id: windowId,
            kind: 'chat',
            title: this.t('renderer.desktop.card.errorTaskTitle'),
            width: 720,
            height: Math.min(660, Math.max(420, window.innerHeight * 0.58))
        });
        desktopWindow.contentElement.innerHTML = `<task-view embedded task_id="${safeText(taskId)}"></task-view>`;
        this.attachWindow(desktopWindow);
    }

    /** 根据输入内容同步发送按钮的可用状态。 */
    private syncSendState(): void {
        const input = this.querySelector('[data-task-input]') as HTMLInputElement | null;
        const send = this.querySelector('[data-send-btn]') as HTMLButtonElement | null;
        if (input && send) send.disabled = !input.value.trim();
    }

    private async submitTask(): Promise<void> {
        const input = this.querySelector('[data-task-input]') as HTMLInputElement | null;
        const text = input?.value.trim();
        if (!input || !text) return;
        input.value = '';
        this.syncSendState();
        const taskId = await this.ensureChatTask();
        if (!taskId) return;
        await globalWindow.taskManagerAPI?.submitMessage?.(taskId, { message: text });
        void this.openChatWindow(taskId);
    }
}

customElements.define('immersive-desktop', ImmersiveDesktop);
