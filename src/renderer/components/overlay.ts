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

import { OVERLAY_CSS } from '../../common/overlay-styles.js';

export function ensureOverlayStyles(root: Document | ShadowRoot = document): void {
    if (root.querySelector('style[data-od-overlay-style]')) return;
    const style = (root.ownerDocument ?? document).createElement('style');
    style.dataset.odOverlayStyle = '';
    style.textContent = OVERLAY_CSS;
    (root.nodeType === 9 ? (root as Document).head : root).appendChild(style);
}

export interface OverlayOptions {
    /** The non-scrolling panel shell to cover. Omit to cover the window. */
    target?: HTMLElement;
    className?: string;
}

const containers = new WeakMap<HTMLElement, { count: number; position: string; priority: string; changed: boolean }>();

/** Positioning only: the caller owns content, dismissal and focus behavior. */
export function createOverlay({ target, className = '' }: OverlayOptions = {}): {
    element: HTMLDivElement;
    dispose(): void;
} {
    const parent = target ?? document.body;
    const root = parent.getRootNode() as Document | ShadowRoot;
    ensureOverlayStyles(root);
    const element = parent.ownerDocument.createElement('div');
    element.className = `od-overlay od-overlay-root ${className}`.trim();
    if (target) {
        element.classList.add('od-overlay-local');
        let state = containers.get(target);
        if (!state) {
            state = {
                count: 0,
                position: target.style.getPropertyValue('position'),
                priority: target.style.getPropertyPriority('position'),
                changed: target.ownerDocument.defaultView!.getComputedStyle(target).position === 'static'
            };
            containers.set(target, state);
            if (state.changed) target.style.setProperty('position', 'relative');
        }
        state.count++;
    }
    parent.appendChild(element);
    let disposed = false;
    return {
        element,
        dispose() {
            if (disposed) return;
            disposed = true;
            element.remove();
            if (!target) return;
            const state = containers.get(target)!;
            if (--state.count) return;
            containers.delete(target);
            if (state.changed && target.style.position === 'relative') {
                if (state.position) target.style.setProperty('position', state.position, state.priority);
                else target.style.removeProperty('position');
            }
        }
    };
}
