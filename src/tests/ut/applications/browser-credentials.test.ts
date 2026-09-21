import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { BrowserCredentialStore, credentialOrigin } from '../../../main/services/browser-credentials/store.js';

const directories: string[] = [];
const key = randomBytes(32);
const encryption = {
    available: () => true,
    encrypt(value: string) {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decrypt(value: Buffer) {
        const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
        cipher.setAuthTag(value.subarray(12, 28));
        return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8');
    }
};
function fixture() {
    const directory = mkdtempSync(path.join(tmpdir(), 'opendesk-credentials-'));
    directories.push(directory);
    const file = path.join(directory, 'credentials.enc');
    return { file, store: new BrowserCredentialStore(file, encryption) };
}
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

describe('browser credentials', () => {
    it('persists encrypted accounts across instances and isolates exact origins', () => {
        const { file, store } = fixture();
        store.save('https://example.com/login', 'alice', 'secret-one');
        store.save('https://example.com/other', 'bob', 'secret-two');
        expect(readFileSync(file).includes(Buffer.from('secret-one'))).toBe(false);
        expect(readFileSync(file).includes(Buffer.from('alice'))).toBe(false);
        const restored = new BrowserCredentialStore(file, encryption);
        expect(restored.list('https://example.com')).toEqual(['alice', 'bob']);
        expect(restored.get('https://example.com', 'bob')).toBe('secret-two');
        for (const url of ['http://example.com', 'https://sub.example.com', 'https://example.com:444']) {
            expect(restored.list(url)).toEqual([]);
        }
    });
    it('updates one account without duplicating it and deletes all persisted data', () => {
        const { store, file } = fixture();
        store.save('https://example.com', 'alice', 'old');
        store.save('https://example.com', 'alice', 'new');
        expect(store.list('https://example.com')).toEqual(['alice']);
        expect(store.get('https://example.com', 'alice')).toBe('new');
        store.clear();
        expect(new BrowserCredentialStore(file, encryption).list('https://example.com')).toEqual([]);
        store.save('https://example.com', 'alice', 'new');
        expect(new BrowserCredentialStore(file, encryption).get('https://example.com', 'alice')).toBe('new');
    });
    it('refuses insecure origins and unavailable encryption without creating plaintext files', () => {
        const { file } = fixture();
        const store = new BrowserCredentialStore(file, { ...encryption, available: () => false });
        expect(() => store.save('https://example.com', 'alice', 'secret')).toThrow();
        expect(existsSync(file)).toBe(false);
        for (const url of ['http://example.com', 'file:///login', 'data:text/html,login', 'about:blank']) {
            expect(credentialOrigin(url)).toBeNull();
        }
        expect(credentialOrigin('http://localhost:123/login')).toBe('http://localhost:123');
        expect(credentialOrigin('https://example.com/path')).toBe('https://example.com');
    });
    it('does not overwrite a damaged vault or silently replace undecryptable accounts', () => {
        const { store, file } = fixture();
        writeFileSync(file, 'corrupt');
        expect(() => store.save('https://example.com', 'alice', 'secret')).toThrow();
        expect(readFileSync(file, 'utf8')).toBe('corrupt');
        store.clear();
        store.save('https://example.com', 'alice', 'secret');
        expect(store.list('https://example.com')).toEqual(['alice']);
    });
    it('clears persisted data before lazy initialization and shares the same vault with active guests', async () => {
        const { file } = fixture();
        const persisted = path.join(path.dirname(file), 'browser-credentials.enc');
        new BrowserCredentialStore(persisted, encryption).save('https://example.com', 'alice', 'secret');
        jest.unstable_mockModule('electron', () => ({
            app: { getPath: () => path.dirname(file) },
            safeStorage: {
                isEncryptionAvailable: () => true,
                encryptString: encryption.encrypt,
                decryptString: encryption.decrypt
            }
        }));
        const { clearBrowserCredentials, initializeBrowserCredentials } =
            await import('../../../main/services/browser-credentials/runtime.js');
        clearBrowserCredentials();
        expect(existsSync(persisted)).toBe(false);
        const activeVault = initializeBrowserCredentials();
        const invalidatePrompt = jest.fn();
        activeVault.onClear(invalidatePrompt);
        activeVault.save('https://example.com', 'alice', 'secret');
        clearBrowserCredentials();
        expect(activeVault.list('https://example.com')).toEqual([]);
        expect(invalidatePrompt).toHaveBeenCalledTimes(1);
    });
});
