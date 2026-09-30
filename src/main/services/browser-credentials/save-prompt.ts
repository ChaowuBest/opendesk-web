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

import type { BrowserWindow, WebContents } from 'electron';
import {
    CONFIRM_BUTTON_CSS,
    CONFIRM_LIGHT_TOKENS,
    CONFIRM_DARK_TOKENS
} from '../../../common/confirm-button-styles.js';
import { randomUUID } from 'node:crypto';
import { renderCredentialPrompt } from './prompt-view.js';
import { t } from '../../../locale/index.js';

/** The prompt belongs to the trusted host UI, not the login page or a separate OS window. */
export async function showCredentialSavePrompt(
    host: BrowserWindow,
    guest: WebContents,
    candidate: { oldPassword: string | undefined; newPassword: string },
    signal?: AbortSignal
): Promise<boolean> {
    if (host.isDestroyed() || guest.isDestroyed() || signal?.aborted) return false;
    const updating = candidate.oldPassword !== undefined;
    const id = `opendesk-credential-${randomUUID()}`;
    const options = {
        id,
        guestId: guest.id,
        buttonCSS: `:host{${CONFIRM_LIGHT_TOKENS}}:host-context([data-theme="dark"]){${CONFIRM_DARK_TOKENS}}${CONFIRM_BUTTON_CSS}`,
        question: t(updating ? 'credentials.updateQuestion' : 'credentials.saveQuestion'),
        action: t(updating ? 'credentials.update' : 'credentials.save'),
        cancel: t('credentials.cancelUpdate'),
        close: t('credentials.close'),
        oldLabel: t('credentials.oldPassword'),
        newLabel: t('credentials.newPassword'),
        reveal: t('credentials.showPasswords'),
        ...(updating ? { oldPassword: candidate.oldPassword, newPassword: candidate.newPassword } : {})
    };
    return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (accepted: boolean) => {
            if (settled) return;
            settled = true;
            host.removeListener('closed', cancel);
            guest.removeListener('destroyed', cancel);
            host.webContents.removeListener('did-start-navigation', hostNavigating);
            signal?.removeEventListener('abort', cancel);
            resolve(accepted);
        };
        const cancel = () => {
            if (!host.isDestroyed() && !host.webContents.isDestroyed()) {
                void host.webContents
                    .executeJavaScript(
                        `document.getElementById(${JSON.stringify(id)})?.dispatchEvent(new Event('opendesk-credential-dismiss'))`
                    )
                    .catch(() => undefined);
            }
            finish(false);
        };
        const hostNavigating = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
            if (mainFrame && !inPlace) cancel();
        };
        host.once('closed', cancel);
        guest.once('destroyed', cancel);
        host.webContents.on('did-start-navigation', hostNavigating);
        signal?.addEventListener('abort', cancel, { once: true });
        // The self-contained renderer function uses textContent and only accepts trusted button clicks.
        // Passwords are never placed in URLs or sent into the untrusted login page.
        void host.webContents
            .executeJavaScript(`(${renderCredentialPrompt.toString()})(${JSON.stringify(options)})`)
            .then(
                (accepted) => finish(accepted === true && !signal?.aborted),
                () => finish(false)
            );
    });
}
