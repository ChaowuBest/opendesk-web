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

import { ipcMain } from 'electron';
import type { BrowserWindow, WebPreferences, WebContents } from 'electron';
import path from 'node:path';

interface OpenGenOfficeSlidesHost {
    register(): void;
    attachWindow(window: BrowserWindow): void;
    activateContents(contents: WebContents): void;
}

const rendererPageName = 'slides_editor.html';
const preloadPath = path.join(__dirname, '..', 'preload', 'slidesPreload.js');
const rendererFilePath = path.join(__dirname, '..', 'renderer', rendererPageName);
let attachedWindow: BrowserWindow | undefined;
let slidesHostPromise: Promise<OpenGenOfficeSlidesHost> | undefined;
let prepareHandlerRegistered = false;

function getOpenGenOfficeSlidesDevUrl(): string | undefined {
    const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
    if (!rendererUrl) return undefined;
    return new URL('slides_editor.html', rendererUrl.endsWith('/') ? rendererUrl : `${rendererUrl}/`).toString();
}

function loadOpenGenOfficeSlidesHost(): Promise<OpenGenOfficeSlidesHost> {
    if (slidesHostPromise) return slidesHostPromise;

    slidesHostPromise = import('@bitclub.ai/open-genoffice/main')
        .then(({ createOpenGenOfficeSlidesHost }) => {
            const host = createOpenGenOfficeSlidesHost({
                preloadPath,
                rendererDevUrl: getOpenGenOfficeSlidesDevUrl(),
                rendererFilePath
            });
            host.register();
            if (attachedWindow && !attachedWindow.isDestroyed()) {
                host.attachWindow(attachedWindow);
            }
            return host;
        })
        .catch((error: unknown) => {
            slidesHostPromise = undefined;
            throw error;
        });
    return slidesHostPromise;
}

export function getOpenGenOfficeSlidesPreloadPath(): string {
    return preloadPath;
}

export function isOpenGenOfficeSlidesUrl(url: string): boolean {
    try {
        return new URL(url).pathname.endsWith(`/${rendererPageName}`);
    } catch {
        return url.includes(rendererPageName);
    }
}

export function configureOpenGenOfficeSlidesWebPreferences(webPreferences: WebPreferences): void {
    webPreferences.preload = preloadPath;
    webPreferences.contextIsolation = true;
    webPreferences.nodeIntegration = false;
    webPreferences.sandbox = true;
    webPreferences.backgroundThrottling = false;
}

export function registerEmbeddedOpenGenOfficeSlides(): void {
    if (prepareHandlerRegistered) return;
    prepareHandlerRegistered = true;
    ipcMain.handle('slides-host:prepare', async () => {
        await loadOpenGenOfficeSlidesHost();
        return true;
    });
}

export function attachOpenGenOfficeSlidesWindow(window: BrowserWindow): void {
    attachedWindow = window;
    if (slidesHostPromise) {
        void slidesHostPromise.then((host) => host.attachWindow(window));
    }
}

export function activateOpenGenOfficeSlidesContents(contents: WebContents): void {
    if (slidesHostPromise) {
        void slidesHostPromise.then((host) => host.activateContents(contents));
    }
}
