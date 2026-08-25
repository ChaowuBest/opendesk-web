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

import { createRendererTranslator } from '../locale.js';
import { bindOverlayDismiss, detectDarkMode, MODAL_CSS, renderIcon } from './confirmModal.js';

export interface CommandResultDialogOptions {
    commandName: string;
    title?: string;
    output: string;
    variant?: 'success' | 'info' | 'error';
}

let t = createRendererTranslator();
let closeActiveDialog: (() => void) | undefined;

function updateTranslator(setting: unknown): void {
    t = createRendererTranslator(setting as any);
}

if (typeof window !== 'undefined') {
    const settingAPI = (window as any).settingAPI;
    void settingAPI
        ?.loadSettingObject?.()
        .then(updateTranslator)
        .catch(() => {});
    settingAPI?.onSettingChanged?.(updateTranslator);
}

const COMMAND_RESULT_CSS = `
.od-command-result-card {
    width: min(720px, 92vw);
    max-height: min(720px, calc(100vh - 48px));
    display: flex;
    flex-direction: column;
}
.od-command-result-card .od-confirm-modal-banner {
    flex-shrink: 0;
}
.od-command-result-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.od-command-result-body {
    min-height: 160px;
    padding: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}
.od-command-result-toolbar {
    min-height: 38px;
    padding: 0 16px 0 20px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    color: var(--mc-ink3);
    border-bottom: 1px solid var(--mc-line-soft);
    background: var(--mc-bg);
}
.od-command-result-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
}
.od-command-result-copy {
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 7px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    cursor: pointer;
    color: var(--mc-ink3);
    background: transparent;
    transition: color 0.15s, background 0.15s;
}
.od-command-result-copy:hover {
    color: var(--mc-ink2);
    background: var(--mc-close-bg);
}
.od-command-result-copy[data-copy-state="copied"] {
    color: #1F9D66;
}
.od-modal-dark .od-command-result-copy[data-copy-state="copied"] {
    color: #3DBF82;
}
.od-command-result-output {
    min-height: 120px;
    max-height: min(520px, calc(100vh - 220px));
    margin: 0;
    padding: 18px 20px;
    overflow: auto;
    box-sizing: border-box;
    color: var(--mc-ink2);
    background: var(--mc-card-bg);
    font-family: 'JetBrains Mono', 'SFMono-Regular', Consolas, monospace;
    font-size: 12.5px;
    line-height: 1.65;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
}
.od-command-result-footer {
    flex-shrink: 0;
}
.od-command-result-footer .od-confirm-btn {
    min-width: 84px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    white-space: nowrap;
}
@media (max-width: 560px) {
    .od-command-result-card {
        width: calc(100vw - 24px);
        max-height: calc(100vh - 24px);
    }
    .od-command-result-output {
        max-height: calc(100vh - 196px);
        padding: 14px 16px;
    }
}
`;

function bannerVariant(variant: CommandResultDialogOptions['variant']): 'success' | 'info' | 'danger' {
    if (variant === 'error') return 'danger';
    return variant ?? 'info';
}

function iconForVariant(variant: CommandResultDialogOptions['variant']): string {
    if (variant === 'error') return 'fa-triangle-exclamation';
    if (variant === 'success') return 'fa-terminal';
    return 'fa-circle-info';
}

export function showCommandResultDialog(options: CommandResultDialogOptions): void {
    const mountTarget = document.body;
    closeActiveDialog?.();

    const overlay = document.createElement('div');
    overlay.className = 'od-confirm-modal-overlay';
    overlay.setAttribute('data-command-result-dialog', '');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'od-command-result-title');
    if (detectDarkMode(mountTarget)) overlay.classList.add('od-modal-dark');

    overlay.innerHTML = `
<style>${MODAL_CSS}${COMMAND_RESULT_CSS}</style>
<div class="od-confirm-modal-card od-command-result-card">
    <div class="od-confirm-modal-banner ${bannerVariant(options.variant)}">
        <div class="od-confirm-modal-icon">${renderIcon(iconForVariant(options.variant))}</div>
        <div class="od-confirm-modal-banner-text">
            <div id="od-command-result-title" class="od-confirm-modal-title od-command-result-title" data-command-result-title></div>
            <div class="od-confirm-modal-subtitle" data-command-result-command></div>
        </div>
        <button class="od-confirm-modal-close" type="button" data-action="close" aria-label=""></button>
    </div>
    <div class="od-command-result-body">
        <div class="od-command-result-toolbar">
            <span class="od-command-result-label" data-command-result-label></span>
            <button class="od-command-result-copy" type="button" data-action="copy" title="" aria-label="">${renderIcon('fa-copy')}</button>
        </div>
        <pre class="od-command-result-output" data-command-result-output></pre>
    </div>
    <div class="od-confirm-modal-footer od-command-result-footer">
        <button class="od-confirm-btn od-confirm-btn-primary" type="button" data-action="close-footer"><span data-command-result-close-label></span></button>
    </div>
</div>`;

    const title = options.title || options.commandName;
    const closeLabel = t('renderer.pluginCommand.close');
    const copyLabel = t('renderer.pluginCommand.copy');
    const titleElement = overlay.querySelector('[data-command-result-title]')!;
    const commandElement = overlay.querySelector('[data-command-result-command]')!;
    const outputElement = overlay.querySelector('[data-command-result-output]')!;
    const outputLabel = overlay.querySelector('[data-command-result-label]')!;
    const copyButton = overlay.querySelector('[data-action="copy"]') as HTMLButtonElement;
    const headerCloseButton = overlay.querySelector('[data-action="close"]') as HTMLButtonElement;
    const footerCloseButton = overlay.querySelector('[data-action="close-footer"]') as HTMLButtonElement;

    titleElement.textContent = title;
    commandElement.textContent = `/${options.commandName}`;
    outputElement.textContent = options.output;
    outputLabel.textContent = t('renderer.pluginCommand.output');
    copyButton.title = copyLabel;
    copyButton.setAttribute('aria-label', copyLabel);
    headerCloseButton.innerHTML = renderIcon('fa-xmark');
    headerCloseButton.setAttribute('aria-label', closeLabel);
    overlay.querySelector('[data-command-result-close-label]')!.textContent = closeLabel;

    let copyFeedbackTimer: ReturnType<typeof setTimeout> | undefined;
    const close = () => {
        if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
        document.removeEventListener('keydown', keydownHandler);
        overlay.remove();
        if (closeActiveDialog === close) closeActiveDialog = undefined;
    };
    const keydownHandler = (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        close();
    };

    document.addEventListener('keydown', keydownHandler);
    bindOverlayDismiss(overlay, close);
    headerCloseButton.addEventListener('click', close);
    footerCloseButton.addEventListener('click', close);
    copyButton.addEventListener('click', () => {
        void navigator.clipboard
            ?.writeText(options.output)
            .then(() => {
                copyButton.dataset.copyState = 'copied';
                copyButton.innerHTML = renderIcon('fa-check');
                const copiedLabel = t('renderer.pluginCommand.copied');
                copyButton.title = copiedLabel;
                copyButton.setAttribute('aria-label', copiedLabel);
                copyFeedbackTimer = setTimeout(() => {
                    copyButton.dataset.copyState = '';
                    copyButton.innerHTML = renderIcon('fa-copy');
                    copyButton.title = copyLabel;
                    copyButton.setAttribute('aria-label', copyLabel);
                }, 1600);
            })
            .catch(() => {});
    });

    mountTarget.appendChild(overlay);
    closeActiveDialog = close;
    footerCloseButton.focus();
}
