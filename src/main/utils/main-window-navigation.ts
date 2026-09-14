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

import type { WebContents } from 'electron';

interface NavigationOptions {
    isInternalUrl: (url: string) => boolean;
    openExternal: (url: string) => void;
}

export function installMainWindowNavigationGuard(contents: WebContents, options: NavigationOptions): void {
    const openExternalLink = (url: string) => {
        try {
            const protocol = new URL(url).protocol;
            if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') {
                options.openExternal(url);
            }
        } catch {
            // Invalid URLs are blocked without handing them to the operating system.
        }
    };

    // Renderer-initiated navigation must never replace the shell. Main-process
    // loadURL/loadFile/reload calls do not emit will-navigate and still work.
    contents.on('will-navigate', (event) => {
        event.preventDefault();
        openExternalLink(event.url);
    });
    contents.on('will-frame-navigate', (event) => {
        if (event.isMainFrame || options.isInternalUrl(event.url)) return;
        event.preventDefault();
        openExternalLink(event.url);
    });
    contents.setWindowOpenHandler(({ url }) => {
        openExternalLink(url);
        return { action: 'deny' };
    });
}
