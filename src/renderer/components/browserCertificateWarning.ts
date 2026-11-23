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

import type { WebviewTag } from 'electron';
import type { ErrorInfo } from '../../common/browserErrors.js';
import { escapeHtml } from '../../common/utils/escape.js';
import { createTranslatorForBrowser } from '../../main/applications/browser/locale/renderer.js';

interface BrowserCertificateAPI {
    pickCertificate(): Promise<{ success: boolean; message: string } | null>;
    canContinue(webContentsId: number, url: string): Promise<boolean>;
    continueNavigation(webContentsId: number, url: string): Promise<boolean>;
    onExceptionApplied?(callback: (webContentsId: number, url: string) => void): () => void;
}

export function getBrowserCertificateAPI(): BrowserCertificateAPI | undefined {
    return (window as Window & { browserCertificateAPI?: BrowserCertificateAPI }).browserCertificateAPI;
}

const t = createTranslatorForBrowser();

export function getBrowserCertificateWarningTitle(): string {
    return t('renderer.browser.certWarning.title');
}

export function isBrowserCertificateError(description: string | undefined): boolean {
    return !!description && description.startsWith('ERR_CERT_');
}

function browserCertificateOrigin(url: string): string | undefined {
    try {
        return new URL(url).origin;
    } catch {
        return undefined;
    }
}

interface CertificateAwareTab {
    webview: WebviewTag | null;
    unverifiedOrigins?: Set<string>;
}

export function observeBrowserCertificateExceptions(
    getTabs: () => readonly CertificateAwareTab[],
    onChange: () => void
): (() => void) | undefined {
    return getBrowserCertificateAPI()?.onExceptionApplied?.((webContentsId, url) => {
        const origin = browserCertificateOrigin(url);
        if (!origin) return;
        const tab = getTabs().find(({ webview }) => {
            try {
                return webview?.getWebContentsId() === webContentsId;
            } catch {
                return false;
            }
        });
        if (!tab) return;
        (tab.unverifiedOrigins ??= new Set()).add(origin);
        onChange();
    });
}

export function renderBrowserCertificateIndicator(
    icon: HTMLElement | null,
    url: string,
    tab?: CertificateAwareTab & { errorInfo?: ErrorInfo }
): void {
    if (!icon) return;
    const origin = browserCertificateOrigin(url);
    const warning =
        isBrowserCertificateError(tab?.errorInfo?.description) || !!(origin && tab?.unverifiedOrigins?.has(origin));
    icon.classList.toggle('fa-lock', !warning);
    icon.classList.toggle('fa-triangle-exclamation', warning);
    icon.style.display = url.startsWith('https://') || warning ? '' : 'none';
    icon.style.color = warning ? 'var(--od-warning-fg, #b45309)' : '';
    icon.title = warning ? t('renderer.browser.certWarning.notSecure') : '';
}

export function clearBrowserCertificateWarning(wrap: HTMLElement | null): void {
    wrap?.querySelector('.od-browser-cert-warning')?.remove();
}

export function showBrowserCertificateWarning(
    wrap: HTMLElement,
    webview: WebviewTag,
    error: ErrorInfo,
    onBack: () => void
): void {
    clearBrowserCertificateWarning(wrap);
    const overlay = document.createElement('section');
    const site = browserCertificateOrigin(error.url) ?? error.url;
    const title = getBrowserCertificateWarningTitle();
    const text = (key: string) => escapeHtml(t(`renderer.browser.certWarning.${key}`, { site }));
    overlay.className = 'od-browser-cert-warning';
    overlay.setAttribute('aria-label', title);
    overlay.innerHTML = `
        <style>
            .od-browser-cert-warning {
                position: absolute; inset: 0; z-index: 11; overflow: auto;
                background: var(--od-bg-elevated, #fff); color: var(--od-text, #1f2937);
                padding: clamp(20px, 8%, 80px); font-size: 15px; line-height: 1.55; overflow-wrap: anywhere;
            }
            .od-browser-cert-warning [hidden] { display: none; }
            .od-browser-cert-warning > div { max-width: 560px; margin: auto; }
            .od-browser-cert-warning i { color: var(--od-warning-fg, #b45309); font-size: 28px; }
            .od-browser-cert-warning button { cursor: pointer; padding: 6px 10px; font: inherit; }
            .od-browser-cert-warning summary { cursor: pointer; margin-top: 14px; }
        </style>
        <div>
            <i class="fas fa-triangle-exclamation" aria-hidden="true"></i>
            <h1>${escapeHtml(title)}</h1>
            <p>${text('message')}</p>
            <code>${escapeHtml(error.description)}</code>
            <p><button type="button">${text('back')}</button></p>
            <details hidden>
                <summary>${text('advanced')}</summary>
                <p>${text('risk')}</p>
                <button type="button">${text('continue')}</button>
                <p role="status"></p>
            </details>
        </div>
    `;

    overlay.querySelector('button')!.addEventListener('click', (event) => {
        if (event.isTrusted) onBack();
    });
    wrap.append(overlay);

    const api = getBrowserCertificateAPI();
    if (!api) return;
    let webContentsId: number;
    try {
        webContentsId = webview.getWebContentsId();
    } catch {
        return;
    }
    const details = overlay.querySelector<HTMLDetailsElement>('details')!;
    const continueButton = details.querySelector('button')!;
    const status = details.querySelector('[role="status"]')!;
    void api
        .canContinue(webContentsId, error.url)
        .then((allowed) => {
            if (allowed) details.hidden = false;
        })
        .catch(() => {});

    continueButton.addEventListener('click', async (event) => {
        if (!event.isTrusted || details.hidden) return;
        continueButton.disabled = true;
        try {
            if (await api.continueNavigation(webContentsId, error.url)) {
                return;
            }
        } catch {
            // The tab may have navigated or closed while the warning was open.
        }
        status.textContent = t('renderer.browser.certWarning.continueFailed');
        continueButton.disabled = false;
    });
}
