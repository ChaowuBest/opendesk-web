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

import { readFile } from 'node:fs/promises';
import { dialog, webContents } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron';
import { ApplicationRegistry } from '../registry.js';
import { safeSendToWebContents } from '../../utils/electron-ipc.js';
import { logger } from '../../utils/logger.js';
import type { BrowserApplication } from './app.js';
import { BrowserCertificateExceptions } from './certificates.js';
import { t as browserT } from './locale/index.js';

type BrowserContentsCheck = (contents: WebContents) => boolean;

const browserCertificateExceptions = new BrowserCertificateExceptions<WebContents>();

export function installBrowserCertificates(host: BrowserWindow, isEmbeddedBrowserContents: BrowserContentsCheck): void {
    host.webContents.on('did-attach-webview', (_event, guest) => {
        if (isEmbeddedBrowserContents(guest)) installBrowserCertificateHandlers(guest);
    });

    const { ipc } = host.webContents;
    const isHostFrame = (event: IpcMainInvokeEvent) =>
        event.sender === host.webContents && event.senderFrame === event.sender.mainFrame;

    function browserCertificateTarget(event: IpcMainInvokeEvent, id: number): WebContents | null {
        if (!Number.isInteger(id) || !isHostFrame(event)) return null;
        const target = webContents.fromId(id);
        if (
            target?.getType() !== 'webview' ||
            target.hostWebContents !== event.sender ||
            !isEmbeddedBrowserContents(target)
        ) {
            return null;
        }
        return target;
    }

    ipc.handle('browser:pickCertificate', async (event) => {
        const browserApp = ApplicationRegistry.getApplication('browser') as BrowserApplication | undefined;
        if (!isHostFrame(event) || !browserApp)
            return { success: false, message: browserT('renderer.browser.settings.cert.importUnsupported') };
        try {
            const result = await dialog.showOpenDialog(host, {
                title: browserT('renderer.browser.settings.cert.import'),
                filters: [
                    {
                        name: browserT('renderer.browser.settings.cert.fileFilter'),
                        extensions: ['pem', 'cer', 'crt', 'cert', 'der']
                    }
                ],
                properties: ['openFile']
            });
            const filePath = result.filePaths[0];
            if (result.canceled || !filePath) return null;
            return await browserApp.importBrowserCertificate(await readFile(filePath));
        } catch (error) {
            logger.warn('Failed to select or read a browser certificate', error);
            return { success: false, message: browserT('renderer.browser.settings.cert.readFailed') };
        }
    });
    ipc.handle('browser:canContinueCertificate', (event, id: number, url: string) => {
        const target = browserCertificateTarget(event, id);
        return !!target && typeof url === 'string' && browserCertificateExceptions.canContinue(target, url);
    });
    ipc.handle('browser:continueCertificate', (event, id: number, url: string) => {
        const target = browserCertificateTarget(event, id);
        if (!target || typeof url !== 'string' || !browserCertificateExceptions.confirm(target, url)) return false;
        void target.loadURL(url).catch((error) => {
            logger.debug('Browser navigation after certificate confirmation did not commit', error);
        });
        return true;
    });
}

function installBrowserCertificateHandlers(contents: WebContents): void {
    contents.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) {
            browserCertificateExceptions.navigationStarted(contents, details.url);
        }
    });
    contents.on('certificate-error', (event, url, error, certificate, callback, isMainFrame) => {
        const browserApp = ApplicationRegistry.getApplication('browser') as BrowserApplication | undefined;
        const explicitlyTrusted = browserApp?.matchesBrowserCertificate(certificate.data);
        const allowedByException =
            !explicitlyTrusted &&
            (isMainFrame
                ? browserCertificateExceptions.handleError(contents, url, error, certificate.fingerprint)
                : browserCertificateExceptions.allowsSubresource(
                      contents.getURL(),
                      url,
                      error,
                      certificate.fingerprint
                  ));
        if (!explicitlyTrusted && !allowedByException) return;
        if (allowedByException) {
            safeSendToWebContents(contents.hostWebContents, 'browser:certificateExceptionApplied', contents.id, url);
        }
        event.preventDefault();
        callback(true);
    });
}
