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

export interface WorkspaceFocusLayoutState {
    active: boolean;
    fullscreen: boolean;
}

interface WorkspaceFocusLayoutControllerOptions {
    getPanel: () => HTMLElement | null;
    getDefaultPanelWidth: () => string;
    shouldSuppressAnimation: () => boolean;
    collapseNavigation: () => void;
}

const FOCUS_PANEL_WIDTH = '75%';
const FOCUS_LAYOUT_TRANSITION = 'width 320ms cubic-bezier(0.4, 0, 0.2, 1)';

/** Coordinates the outer task layout while focused workspace content is active. */
export class WorkspaceFocusLayoutController {
    private _active = false;
    private _previousPanelWidth: string | null = null;
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
            this._options.collapseNavigation();
            this._animatePanelWidth(panel, FOCUS_PANEL_WIDTH);
            return;
        }

        this._active = false;
        const restoreWidth = this._previousPanelWidth || this._options.getDefaultPanelWidth();
        this._previousPanelWidth = null;
        this._animatePanelWidth(panel, restoreWidth);
    }

    getTargetPanelWidth(): string {
        return this._active ? FOCUS_PANEL_WIDTH : this._options.getDefaultPanelWidth();
    }

    dispose(): void {
        if (this._transitionTimer !== null) {
            window.clearTimeout(this._transitionTimer);
            this._transitionTimer = null;
        }
    }

    private _animatePanelWidth(panel: HTMLElement, width: string): void {
        this.dispose();
        const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
        if (this._options.shouldSuppressAnimation() || reduceMotion) {
            panel.style.width = width;
            panel.style.transition = '';
            return;
        }

        panel.style.transition = FOCUS_LAYOUT_TRANSITION;
        requestAnimationFrame(() => {
            panel.style.width = width;
        });
        this._transitionTimer = window.setTimeout(() => {
            panel.style.transition = '';
            this._transitionTimer = null;
        }, 360);
    }
}
