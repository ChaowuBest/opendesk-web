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

import type { WebContents, WebFrameMain } from 'electron';

interface NavigationOptions {
    isInternalUrl: (url: string) => boolean;
    openExternal: (url: string) => void;
}

/** srcdoc / about:blank / data: / blob: 文档：由宿主页面即时生成的内嵌内容容器。 */
function isOpaqueDocumentUrl(url: string): boolean {
    return /^(about:|data:|blob:)/i.test(url);
}

/**
 * 判断要导航的子框架是否位于内嵌内容容器中（预览卡片、Markdown/HTML 预览、
 * 沉浸桌面卡片都用 srcdoc 或 data: iframe 承载任意 HTML）。
 *
 * 这类容器再去加载 http(s) 子框架，属于页面自身的嵌入内容而不是「用户点了外部
 * 链接」：把这种导航转交系统浏览器，会让打开任务、重渲染消息时直接弹出默认浏览器。
 * 框架已销毁或访问异常时同样按内容容器处理——宁可放弃这次转交，也不要误拉起
 * 系统浏览器。
 */
function isInsideContentContainer(frame: WebFrameMain | null): boolean {
    // 框架可能已被销毁（Electron 在 `frame` 上明确了这个可能），此时无法判定归属。
    if (!frame) return true;
    let current: WebFrameMain | null = frame;
    while (current) {
        try {
            if (isOpaqueDocumentUrl(current.url || '')) return true;
            current = current.parent;
        } catch {
            return true;
        }
    }
    return false;
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

    // Renderer-initiated navigation must never replace the shell. Reloading the
    // current page is safe and is required for Vite's full-page refresh.
    // Main-process loadURL/loadFile/reload calls do not emit will-navigate.
    contents.on('will-navigate', (event) => {
        if (event.url === contents.getURL()) return;
        event.preventDefault();
        openExternalLink(event.url);
    });
    contents.on('will-frame-navigate', (event) => {
        if (event.isMainFrame || options.isInternalUrl(event.url)) return;
        // 非内部地址一律不加载进主窗口：子框架同样会执行 preload
        // （nodeIntegrationInSubFrames），远程文档一旦进来就能拿到 windowControlAPI
        // 这类只应属于应用自身页面的能力。
        event.preventDefault();
        // 内容容器里的子框架是页面自身的嵌入内容，不是用户点的链接：只挡掉加载，
        // 不要再把系统浏览器也拉起来。
        if (isInsideContentContainer(event.frame)) return;
        openExternalLink(event.url);
    });
    contents.setWindowOpenHandler(({ url }) => {
        openExternalLink(url);
        return { action: 'deny' };
    });
}
