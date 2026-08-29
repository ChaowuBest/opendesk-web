/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
 * See the Mulan PSL v2 for more details.
 */

import type { MenuItemConstructorOptions } from 'electron';
import { getSafeWebUrl } from '../common/web-link.js';

export interface MainWindowContextMenuParams {
    linkURL: string;
    isEditable: boolean;
}

export interface MainWindowContextMenuLabels {
    openLink: string;
    copyLink: string;
    cut: string;
    copy: string;
    paste: string;
    selectAll: string;
}

export interface MainWindowContextMenuActions {
    openLink: (url: string) => void;
    copyText: (text: string) => void;
}

export function createMainWindowContextMenuTemplate(
    params: MainWindowContextMenuParams,
    labels: MainWindowContextMenuLabels,
    actions: MainWindowContextMenuActions
): MenuItemConstructorOptions[] {
    const linkURL = getSafeWebUrl(params.linkURL);
    if (linkURL) {
        return [
            { label: labels.openLink, click: () => actions.openLink(linkURL) },
            { label: labels.copyLink, click: () => actions.copyText(linkURL) }
        ];
    }

    if (!params.isEditable) return [];
    return [
        { role: 'cut', label: labels.cut },
        { role: 'copy', label: labels.copy },
        { role: 'paste', label: labels.paste },
        { type: 'separator' },
        { role: 'selectAll', label: labels.selectAll }
    ];
}
