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

import { createRequire } from 'node:module';
import path from 'node:path';
import { BrowserCredentialStore } from './store.js';

const require = createRequire(import.meta.url);
let store: BrowserCredentialStore | undefined;
export function initializeBrowserCredentials(): BrowserCredentialStore {
    if (!store) {
        // BrowserApplication is also imported by CLI/Workers without an Electron installation.
        // Load the desktop APIs only when a caller actually uses the credential vault.
        const { app, safeStorage } = require('electron') as typeof import('electron');
        store = new BrowserCredentialStore(path.join(app.getPath('userData'), 'browser-credentials.enc'), {
            available: () =>
                typeof safeStorage?.isEncryptionAvailable === 'function' &&
                safeStorage.isEncryptionAvailable() &&
                (typeof safeStorage.getSelectedStorageBackend !== 'function' ||
                    safeStorage.getSelectedStorageBackend() !== 'basic_text'),
            encrypt: (value) => safeStorage.encryptString(value),
            decrypt: (value) => safeStorage.decryptString(value)
        });
    }
    return store;
}

export function clearBrowserCredentials(): void {
    initializeBrowserCredentials().clear();
}
