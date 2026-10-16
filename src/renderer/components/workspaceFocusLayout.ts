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

export const WORKSPACE_FOCUS_LAYOUT_CHANGE_EVENT = 'workspace-focus-layout-change';

/** 右侧面板展开时，聊天区（TaskView 主内容列）必须保留的最小可读宽度。 */
export const MIN_CHAT_AREA_WIDTH = 350;

/** 聊天区与右侧面板之间拖拽条的宽度，与 taskview 渲染模板中的 resizer 保持一致。 */
export const RIGHT_PANEL_RESIZER_WIDTH = 4;

export interface WorkspaceFocusLayoutState {
    active: boolean;
    fullscreen: boolean;
}

interface WorkspaceFocusLayoutControllerOptions {
    getPanel: () => HTMLElement | null;
    getDefaultPanelWidth: () => string;
    /** 面板当前允许的最大像素宽度；返回 null 表示容器尚未完成布局，不做限制。 */
    getMaxPanelWidth: () => number | null;
    shouldSuppressAnimation: () => boolean;
    collapseNavigation: () => void;
    isNavigationCollapsed: () => boolean;
    expandNavigation: () => void;
}

const FOCUS_PANEL_WIDTH = '70%';
const FOCUS_LAYOUT_TRANSITION = 'width 320ms cubic-bezier(0.4, 0, 0.2, 1)';

/** Coordinates the outer task layout while focused workspace content is active. */
export class WorkspaceFocusLayoutController {
    private _active = false;
    private _previousPanelWidth: string | null = null;
    private _navigationWasCollapsed: boolean | null = null;
    private _transitionTimer: number | null = null;

    constructor(private readonly _options: WorkspaceFocusLayoutControllerOptions) {}

    get active(): boolean {
        return this._active;
    }

    readonly handleChange = (event: Event): void => {
        const state = (event as CustomEvent<WorkspaceFocusLayoutState>).detail;
        this.setActive(state?.active === true);
    };

    setActive(active: boolean): void {
        if (active === this._active) return;

        const panel = this._options.getPanel();
        if (!panel) return;

        if (active) {
            this._active = true;
            this._previousPanelWidth =
                panel.style.width ||
                (panel.offsetWidth > 0 ? `${panel.offsetWidth}px` : this._options.getDefaultPanelWidth());
            this._navigationWasCollapsed = this._options.isNavigationCollapsed();
            this._options.collapseNavigation();
            this._animatePanelWidth(panel, FOCUS_PANEL_WIDTH);
            return;
        }

        this._active = false;
        const restoreWidth = this._previousPanelWidth || this._options.getDefaultPanelWidth();
        this._previousPanelWidth = null;
        if (this._navigationWasCollapsed === false) {
            this._options.expandNavigation();
        }
        this._navigationWasCollapsed = null;
        this._animatePanelWidth(panel, restoreWidth);
    }

    getTargetPanelWidth(): string {
        return this.constrainPanelWidth(this._active ? FOCUS_PANEL_WIDTH : this._options.getDefaultPanelWidth());
    }

    /**
     * 把期望的面板宽度收敛到「聊天区不小于 MIN_CHAT_AREA_WIDTH」的约束内。
     * 支持 px 与百分比两种写法；容器未完成布局或宽度无法解析时原样返回。
     */
    constrainPanelWidth(width: string): string {
        const maxWidth = this._options.getMaxPanelWidth();
        if (maxWidth === null || maxWidth <= 0) return width;
        const desiredPx = this._resolvePanelWidthPx(width);
        if (desiredPx === null || desiredPx <= maxWidth) return width;
        return `${Math.floor(maxWidth)}px`;
    }

    dispose(): void {
        if (this._transitionTimer !== null) {
            window.clearTimeout(this._transitionTimer);
            this._transitionTimer = null;
        }
    }

    private _resolvePanelWidthPx(width: string): number | null {
        const text = String(width ?? '').trim();
        if (!text) return null;
        if (text.endsWith('%')) {
            // 百分比宽度以面板所在行（content-row）的宽度为基准
            const referenceWidth = this._options.getPanel()?.parentElement?.clientWidth ?? 0;
            if (!referenceWidth) return null;
            const percent = Number.parseFloat(text);
            return Number.isFinite(percent) ? (referenceWidth * percent) / 100 : null;
        }
        const px = Number.parseFloat(text);
        return Number.isFinite(px) ? px : null;
    }

    private _animatePanelWidth(panel: HTMLElement, width: string): void {
        this.dispose();
        const constrainedWidth = this.constrainPanelWidth(width);
        const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
        if (this._options.shouldSuppressAnimation() || reduceMotion) {
            panel.style.width = constrainedWidth;
            panel.style.transition = '';
            return;
        }

        panel.style.transition = FOCUS_LAYOUT_TRANSITION;
        requestAnimationFrame(() => {
            panel.style.width = constrainedWidth;
        });
        this._transitionTimer = window.setTimeout(() => {
            panel.style.transition = '';
            this._transitionTimer = null;
        }, 360);
    }
}
