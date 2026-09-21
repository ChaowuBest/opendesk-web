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

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface CredentialEncryption {
    available(): boolean;
    encrypt(value: string): Buffer;
    decrypt(value: Buffer): string;
}
interface Credential {
    origin: string;
    username: string;
    password: string;
}

export function credentialOrigin(url: string): string | null {
    try {
        const parsed = new URL(url);
        const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
        return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && local) ? parsed.origin : null;
    } catch {
        return null;
    }
}

/** The entire vault is encrypted, including usernames and site origins. */
export class BrowserCredentialStore {
    revision = 0;
    private readonly clearListeners = new Set<() => void>();

    constructor(
        private readonly file: string,
        private readonly encryption: CredentialEncryption
    ) {}

    available(): boolean {
        return this.encryption.available();
    }

    private read(): Credential[] {
        if (!this.available()) throw new Error('Credential encryption unavailable');
        if (!existsSync(this.file)) return [];
        const value: unknown = JSON.parse(this.encryption.decrypt(readFileSync(this.file)));
        if (
            !Array.isArray(value) ||
            !value.every(
                (entry) =>
                    entry &&
                    typeof entry.origin === 'string' &&
                    credentialOrigin(entry.origin) === entry.origin &&
                    typeof entry.username === 'string' &&
                    typeof entry.password === 'string'
            )
        )
            throw new Error('Invalid credential vault');
        return value;
    }

    list(url: string): string[] {
        const origin = credentialOrigin(url);
        if (!origin) return [];
        return this.read()
            .filter((entry) => entry.origin === origin)
            .map((entry) => entry.username);
    }

    get(url: string, username: string): string | undefined {
        const origin = credentialOrigin(url);
        if (!origin) return undefined;
        return this.read().find((entry) => entry.origin === origin && entry.username === username)?.password;
    }

    save(url: string, username: string, password: string): void {
        const origin = credentialOrigin(url);
        if (!origin || !username || !password || username.length > 1024 || password.length > 4096) {
            throw new Error('Invalid credential');
        }
        const records = this.read();
        const existing = records.find((entry) => entry.origin === origin && entry.username === username);
        if (existing) existing.password = password;
        else records.push({ origin, username, password });
        const encrypted = this.encryption.encrypt(JSON.stringify(records));
        mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        const temporary = this.file + '.tmp';
        try {
            writeFileSync(temporary, encrypted, { mode: 0o600 });
            renameSync(temporary, this.file);
        } finally {
            rmSync(temporary, { force: true });
        }
    }

    clear(): void {
        // Invalidates prompts and menus opened before the user cleared their data.
        rmSync(this.file, { force: true });
        this.revision += 1;
        for (const listener of this.clearListeners) listener();
    }

    onClear(listener: () => void): () => void {
        this.clearListeners.add(listener);
        return () => this.clearListeners.delete(listener);
    }
}
