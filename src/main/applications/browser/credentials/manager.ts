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

import { dialog, session } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { showCredentialSavePrompt } from './save-prompt.js';
import { BrowserCredentialStore, credentialOrigin } from './store.js';
import { initializeBrowserCredentials } from './runtime.js';
import { t } from '../locale/index.js';

export function installBrowserCredentials(
    host: BrowserWindow,
    contents: WebContents,
    vault: BrowserCredentialStore = initializeBrowserCredentials()
): void {
    let navigation = 0;
    let suggestion:
        | { requestId: string; origin: string; revision: number; navigation: number; usernames: string[] }
        | undefined;
    let prompting = false;
    let pendingPrompt: AbortController | undefined;
    const stopWatchingClear = vault.onClear(() => {
        suggestion = undefined;
        pendingPrompt?.abort();
    });
    contents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => {
        if (!mainFrame) return;
        navigation += 1;
        suggestion = undefined;
    });
    contents.once('destroyed', () => {
        suggestion = undefined;
        pendingPrompt?.abort();
        stopWatchingClear();
    });

    function originFor(event: IpcMainInvokeEvent): string | null {
        if (
            contents.isDestroyed() ||
            host.isDestroyed() ||
            event.sender !== contents ||
            contents.session !== session.fromPartition('persist:opendesk-browser') ||
            event.senderFrame !== contents.mainFrame
        )
            return null;
        return credentialOrigin(event.senderFrame.url);
    }

    async function showError(key: string): Promise<void> {
        if (host.isDestroyed()) return;
        await dialog.showMessageBox(host, {
            type: 'warning',
            title: t('credentials.title'),
            message: t(key),
            buttons: [t('credentials.ok')]
        });
    }

    contents.ipc.handle('browser-credentials:list', (event) => {
        suggestion = undefined;
        const origin = originFor(event);
        if (!origin || !contents.isFocused()) return null;
        try {
            if (!vault.available()) return null;
            const usernames = vault.list(origin);
            if (!usernames.length) return null;
            suggestion = { requestId: randomUUID(), origin, revision: vault.revision, navigation, usernames };
            return { requestId: suggestion.requestId, usernames, label: t('credentials.accounts') };
        } catch {
            return null;
        }
    });

    contents.ipc.handle('browser-credentials:fill', (event, selection: unknown) => {
        const pending = suggestion;
        suggestion = undefined;
        if (!pending || !selection || typeof selection !== 'object') return null;
        const { requestId, username } = selection as Record<string, unknown>;
        if (
            requestId !== pending.requestId ||
            typeof username !== 'string' ||
            !pending.usernames.includes(username) ||
            pending.navigation !== navigation ||
            pending.revision !== vault.revision ||
            originFor(event) !== pending.origin
        )
            return null;
        try {
            const password = vault.get(pending.origin, username);
            return password === undefined ? null : { username, password };
        } catch {
            return null;
        }
    });

    contents.ipc.handle('browser-credentials:save', async (event, candidate: unknown) => {
        const origin = originFor(event);
        if (!origin || prompting || !candidate || typeof candidate !== 'object') return;
        const { username, password } = candidate as Record<string, unknown>;
        if (
            typeof username !== 'string' ||
            typeof password !== 'string' ||
            !username ||
            !password ||
            username.length > 1024 ||
            password.length > 4096
        )
            return;
        prompting = true;
        const revision = vault.revision;
        try {
            if (!vault.available()) {
                await showError('credentials.unavailable');
                return;
            }
            const oldPassword = vault.get(origin, username);
            if (oldPassword === password) return;
            pendingPrompt = new AbortController();
            const accepted = await showCredentialSavePrompt(
                host,
                contents,
                {
                    oldPassword,
                    newPassword: password
                },
                pendingPrompt.signal
            );
            if (accepted && revision === vault.revision) vault.save(origin, username, password);
        } catch {
            await showError('credentials.failed');
        } finally {
            pendingPrompt = undefined;
            prompting = false;
        }
    });
}
