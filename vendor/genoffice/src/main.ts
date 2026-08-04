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

import { app, BrowserWindow, ipcMain, webContents } from 'electron';
import type { WebContents, WebPreferences } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { normalizeLang, setUiLang } from '@genoffice/i18n';
import {
    configureSlidesRuntime,
    registerAiIpc,
    registerProjectIpc,
    registerSlidesIpc,
    requestSlidesClose,
    setActiveSlidesWebContents,
    setSlidesShellWindow
} from '../apps/slides/src/main/slides-main.js';

export interface GenOfficeSlidesHostOptions {
    preloadPath: string;
    rendererFilePath: string;
    rendererDevUrl?: string;
    rendererPageName?: string;
    locale?: string;
    requestCloseChannel?: string;
}

export interface GenOfficeSlidesHost {
    getPreloadPath(): string;
    isSlidesUrl(url: string): boolean;
    configureWebPreferences(webPreferences: WebPreferences): void;
    register(): void;
    attachWindow(window: BrowserWindow): void;
    activateContents(contents: WebContents): void;
}

export function createGenOfficeSlidesHost(options: GenOfficeSlidesHostOptions): GenOfficeSlidesHost {
    const bundledGensparkCli = path.join(app.getAppPath(), 'dist', 'main', 'genoffice-gsk.cjs');
    if (!process.env.GSK_CLI_PATH && existsSync(bundledGensparkCli)) {
        process.env.GSK_CLI_PATH = bundledGensparkCli;
        process.env.GSK_NO_AUTO_UPDATE = '1';
    }
    const rendererPageName = options.rendererPageName ?? 'slides_editor.html';
    const requestCloseChannel = options.requestCloseChannel ?? 'slides-host:request-close';
    let registered = false;

    return {
        getPreloadPath(): string {
            return options.preloadPath;
        },
        isSlidesUrl(url: string): boolean {
            try {
                return new URL(url).pathname.endsWith(`/${rendererPageName}`);
            } catch {
                return url.includes(rendererPageName);
            }
        },
        configureWebPreferences(webPreferences: WebPreferences): void {
            webPreferences.preload = options.preloadPath;
            webPreferences.contextIsolation = true;
            webPreferences.nodeIntegration = false;
            webPreferences.sandbox = true;
            webPreferences.backgroundThrottling = false;
        },
        register(): void {
            if (registered) return;
            registered = true;

            setUiLang(normalizeLang(options.locale ?? app.getLocale()));
            configureSlidesRuntime({
                preloadPath: options.preloadPath,
                rendererDevUrl: options.rendererDevUrl,
                rendererFilePath: options.rendererFilePath
            });
            registerSlidesIpc();
            registerAiIpc();
            registerProjectIpc();

            ipcMain.handle(requestCloseChannel, async (event, webContentsId: number) => {
                const target = webContents.fromId(webContentsId);
                if (!target || target.isDestroyed() || target.getType() !== 'webview') return true;
                if (target.hostWebContents?.id !== event.sender.id) return false;
                return requestSlidesClose(target, BrowserWindow.fromWebContents(event.sender));
            });
        },
        attachWindow(window: BrowserWindow): void {
            setSlidesShellWindow(window);
        },
        activateContents(contents: WebContents): void {
            setActiveSlidesWebContents(contents);
        }
    };
}
