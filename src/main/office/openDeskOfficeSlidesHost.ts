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
import { createTrustedRendererUrlMatcher } from '@bitclub.ai/opendesk-office/host-security';

interface OpenDeskOfficeSlidesHost {
    register(): void;
    attachWindow(window: BrowserWindow): void;
    activateContents(contents: WebContents): void;
    requestCloseAll(): Promise<boolean>;
}

const rendererPageName = 'slides_editor.html';
const preloadPath = path.join(__dirname, '..', 'preload', 'slidesPreload.js');
const rendererFilePath = path.join(__dirname, '..', 'renderer', rendererPageName);
let attachedWindow: BrowserWindow | undefined;
let slidesHostPromise: Promise<OpenDeskOfficeSlidesHost> | undefined;
let prepareHandlerRegistered = false;

function getOpenDeskOfficeSlidesDevUrl(): string | undefined {
    const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
    if (!rendererUrl) return undefined;
    return new URL('slides_editor.html', rendererUrl.endsWith('/') ? rendererUrl : `${rendererUrl}/`).toString();
}

const isTrustedSlidesUrl = createTrustedRendererUrlMatcher({
    rendererFilePath,
    rendererDevUrl: getOpenDeskOfficeSlidesDevUrl()
});

function loadOpenDeskOfficeSlidesHost(): Promise<OpenDeskOfficeSlidesHost> {
    if (slidesHostPromise) return slidesHostPromise;

    slidesHostPromise = import('@bitclub.ai/opendesk-office/main')
        .then(({ createOpenDeskOfficeSlidesHost }) => {
            const host = createOpenDeskOfficeSlidesHost({
                preloadPath,
                rendererDevUrl: getOpenDeskOfficeSlidesDevUrl(),
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

export function getOpenDeskOfficeSlidesPreloadPath(): string {
    return preloadPath;
}

export function isOpenDeskOfficeSlidesUrl(url: string): boolean {
    return isTrustedSlidesUrl(url);
}

export function configureOpenDeskOfficeSlidesWebPreferences(webPreferences: WebPreferences): void {
    webPreferences.preload = preloadPath;
    webPreferences.contextIsolation = true;
    webPreferences.nodeIntegration = false;
    webPreferences.sandbox = true;
    webPreferences.backgroundThrottling = false;
}

export function registerEmbeddedOpenDeskOfficeSlides(): void {
    if (prepareHandlerRegistered) return;
    prepareHandlerRegistered = true;
    ipcMain.handle('slides-host:prepare', async () => {
        await loadOpenDeskOfficeSlidesHost();
        return true;
    });
}

export function attachOpenDeskOfficeSlidesWindow(window: BrowserWindow): void {
    attachedWindow = window;
    if (slidesHostPromise) {
        void slidesHostPromise.then((host) => host.attachWindow(window));
    }
}

export function activateOpenDeskOfficeSlidesContents(contents: WebContents): void {
    if (slidesHostPromise) {
        void slidesHostPromise.then((host) => host.activateContents(contents));
    }
}

export async function requestCloseOpenDeskOfficeSlidesContents(): Promise<boolean> {
    if (!slidesHostPromise) return true;
    const host = await slidesHostPromise;
    return host.requestCloseAll();
}
