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

import { WEB_FS_PATH } from './web/protocol.js';

/** Convert POSIX, Windows drive, and Windows UNC paths to encoded file URLs. */
export function filePathToFileUrl(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');
    // Web 模式的浏览器无法加载 file://，改用服务端的同源文件代理（见 src/main/web/web-server.ts）
    const webOrigin = getWebModeOrigin();
    if (webOrigin) {
        const absolute = normalized.startsWith('/') ? normalized : `/${normalized}`;
        return `${webOrigin}${WEB_FS_PATH}${absolute.split('/').map(encodeURIComponent).join('/')}`;
    }
    const url = new URL('file:///');

    if (normalized.startsWith('//')) {
        const uncPath = normalized.slice(2);
        const separatorIndex = uncPath.indexOf('/');
        url.hostname = separatorIndex === -1 ? uncPath : uncPath.slice(0, separatorIndex);
        url.pathname = separatorIndex === -1 ? '/' : uncPath.slice(separatorIndex);
        return url.href;
    }

    url.pathname = normalized.startsWith('/') ? normalized : `/${normalized}`;
    return url.href;
}

function getWebModeOrigin(): string | null {
    const scope = globalThis as { __OPENDESK_WEB__?: unknown; location?: { origin?: string } };
    return scope.__OPENDESK_WEB__ && scope.location?.origin ? scope.location.origin : null;
}

/** Decode file links for native file actions without turning them into page navigation. */
export function fileUrlToFilePath(value: string): string | undefined {
    try {
        const url = new URL(value);
        if (url.protocol !== 'file:' || /%2f|%5c/i.test(url.pathname)) return undefined;
        const pathname = decodeURIComponent(url.pathname);
        if (pathname.includes('\0')) return undefined;
        if (url.hostname) return `//${url.hostname}${pathname}`;
        return /^\/[a-z]:\//i.test(pathname) ? pathname.slice(1) : pathname;
    } catch {
        return undefined;
    }
}
