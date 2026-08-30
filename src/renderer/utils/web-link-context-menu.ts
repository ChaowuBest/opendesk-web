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

import { getSafeWebUrl } from '../../common/web-link.js';

export type WebLinkContextMenuAction = 'copy-link' | 'open-external' | 'open-browser';

export interface WebLinkContextMenuLabels {
    copyLink: string;
    openExternal: string;
    openInBrowser: string;
}

export interface WebLinkContextMenuActions {
    copyLink: (url: string) => void;
    openExternal: (url: string) => void;
    openInBrowser: (url: string) => void;
}

export interface WebLinkContextMenuItem {
    action: WebLinkContextMenuAction;
    label: string;
    run: () => void;
}

export function createWebLinkContextMenuItems(
    value: unknown,
    labels: WebLinkContextMenuLabels,
    actions: WebLinkContextMenuActions
): WebLinkContextMenuItem[] {
    const url = getSafeWebUrl(value);
    if (!url) return [];

    return [
        { action: 'copy-link', label: labels.copyLink, run: () => actions.copyLink(url) },
        { action: 'open-external', label: labels.openExternal, run: () => actions.openExternal(url) },
        { action: 'open-browser', label: labels.openInBrowser, run: () => actions.openInBrowser(url) }
    ];
}
