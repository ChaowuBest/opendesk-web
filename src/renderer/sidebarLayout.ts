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

import { createRendererTranslator } from './locale.js';

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'opendesk-sidebar-collapsed';

type CollapsibleSplitter = HTMLElement & {
    setCollapsed?: (collapsed: boolean) => void;
};

type SidebarLayoutController = {
    setCollapsed: (collapsed: boolean) => void;
    destroy: () => void;
};

function readStoredCollapsedState(): boolean {
    try {
        return localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
}

function storeCollapsedState(collapsed: boolean): void {
    try {
        localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(collapsed));
    } catch {
        // localStorage can be unavailable in restricted renderer contexts.
    }
}

export function initializeSidebarLayout(root: Document = document): SidebarLayoutController | null {
    const appRoot = root.getElementById('app-root');
    const splitter = root.querySelector('splitter-widget') as CollapsibleSplitter | null;
    const expandButton = root.getElementById('expand-sidebar-btn');

    if (!appRoot || !splitter || !expandButton) {
        return null;
    }

    const updateExpandButtonLabel = (setting?: Parameters<typeof createRendererTranslator>[0]): void => {
        const label = createRendererTranslator(setting)('renderer.sidebar.expand');
        expandButton.setAttribute('title', label);
        expandButton.setAttribute('aria-label', label);
    };

    const applyCollapsedState = (collapsed: boolean, persist = true): void => {
        if (typeof splitter.setCollapsed === 'function') {
            splitter.setCollapsed(collapsed);
        } else {
            splitter.toggleAttribute('collapsed', collapsed);
        }
        appRoot.classList.toggle('sidebar-collapsed', collapsed);
        expandButton.hidden = !collapsed;
        expandButton.setAttribute('aria-expanded', String(!collapsed));
        if (persist) {
            storeCollapsedState(collapsed);
        }
        root.dispatchEvent(
            new CustomEvent('sidebar-visibility-changed', {
                detail: { collapsed }
            })
        );
    };

    const collapseRequestHandler = (event: Event): void => {
        const collapsed = (event as CustomEvent<{ collapsed?: boolean }>).detail?.collapsed ?? true;
        applyCollapsedState(collapsed);
    };
    const expandClickHandler = (): void => applyCollapsedState(false);

    root.addEventListener('sidebar-collapse-request', collapseRequestHandler);
    expandButton.addEventListener('click', expandClickHandler);

    updateExpandButtonLabel();
    applyCollapsedState(readStoredCollapsedState(), false);

    window.settingAPI
        ?.loadSettingObject?.()
        .then((setting) => updateExpandButtonLabel(setting))
        .catch(() => {});
    const unsubscribeSetting = window.settingAPI?.onSettingChanged?.((setting) => {
        updateExpandButtonLabel(setting);
    });

    return {
        setCollapsed: applyCollapsedState,
        destroy: () => {
            root.removeEventListener('sidebar-collapse-request', collapseRequestHandler);
            expandButton.removeEventListener('click', expandClickHandler);
            if (typeof unsubscribeSetting === 'function') {
                unsubscribeSetting();
            }
        }
    };
}
