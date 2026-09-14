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

import { fileUrlToFilePath } from '../../common/file-url.js';
import { getSafeWebUrl } from '../../common/web-link.js';

interface TaskViewLinkHost extends HTMLElement {
    openFileInSidebar?: (path: string) => void;
    openUrlInSidebar?: (url: string) => void;
}

/** Route both cached/raw links and links inside Shadow DOM previews through task actions. */
export function handleTaskViewLinkClick(event: MouseEvent): void {
    if (event.type === 'auxclick' && event.button !== 1) return;
    const elements = event.composedPath().filter((node): node is HTMLElement => (node as Node).nodeType === 1);
    const anchor = elements.find((node) => node.matches('a[href]'));
    const taskView = elements.find((node) => node.tagName === 'TASK-VIEW') as TaskViewLinkHost | undefined;
    if (!anchor || !taskView) return;

    const href = anchor.getAttribute('href')?.trim() ?? '';
    if (href.startsWith('#')) return;
    event.preventDefault();

    const filePath = fileUrlToFilePath(href);
    if (filePath !== undefined) {
        taskView.openFileInSidebar?.(filePath);
        return;
    }
    const webUrl = getSafeWebUrl(href);
    if (webUrl) {
        taskView.openUrlInSidebar?.(webUrl);
        return;
    }
    try {
        if (new URL(href).protocol === 'mailto:') window.open(href, '_blank');
    } catch {
        // Malformed and unsupported links must not navigate the application shell.
    }
}
