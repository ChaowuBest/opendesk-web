import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setCustomOpendeskDirectory } from '../../../../main/utils/setting.js';
import { AccountTokenStore } from '../../../../main/applications/account/token-store.js';

function makeTempDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withTempDir(prefix: string, fn: (dir: string) => void): void {
    const dir = makeTempDir(prefix);
    const original = process.env.OPENDESK_CONFIG_DIRECTORY;
    try {
        setCustomOpendeskDirectory(dir);
        fn(dir);
    } finally {
        setCustomOpendeskDirectory(undefined);
        if (original === undefined) {
            delete process.env.OPENDESK_CONFIG_DIRECTORY;
        } else {
            process.env.OPENDESK_CONFIG_DIRECTORY = original;
        }
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const sampleSession = {
    version: 1 as const,
    kind: 'personal' as const,
    baseUrl: 'http://127.0.0.1:8000/api/v1',
    accessToken: 'access-token-123',
    tokenType: 'Bearer',
    user: {
        id: 'u-1',
        username: 'alice',
        display_name: 'Alice',
        email: 'alice@example.com'
    }
};

test('save persists session to identity/account-session.json', () => {
    withTempDir('opendesk-token-store-save-', (dir) => {
        const store = new AccountTokenStore();
        store.save(sampleSession);

        const filePath = path.join(dir, 'identity', 'account-session.json');
        assert.equal(fs.existsSync(filePath), true);
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        assert.deepEqual(parsed, sampleSession);
    });
});

test('load returns the persisted session', () => {
    withTempDir('opendesk-token-store-load-', (dir) => {
        const store = new AccountTokenStore();
        store.save(sampleSession);

        const loaded = store.load();
        assert.deepEqual(loaded, sampleSession);
    });
});

test('load returns null when no session file exists', () => {
    withTempDir('opendesk-token-store-empty-', (dir) => {
        const store = new AccountTokenStore();
        assert.equal(store.load(), null);
    });
});

test('load returns null when the session file is corrupt', () => {
    withTempDir('opendesk-token-store-corrupt-', (dir) => {
        const identityDir = path.join(dir, 'identity');
        fs.mkdirSync(identityDir, { recursive: true });
        fs.writeFileSync(path.join(identityDir, 'account-session.json'), '{ not valid json');

        const store = new AccountTokenStore();
        assert.equal(store.load(), null);
    });
});

test('clear removes the session file', () => {
    withTempDir('opendesk-token-store-clear-', (dir) => {
        const store = new AccountTokenStore();
        store.save(sampleSession);
        assert.notEqual(store.load(), null);

        store.clear();
        assert.equal(store.load(), null);
        assert.equal(fs.existsSync(path.join(dir, 'identity', 'account-session.json')), false);
    });
});

test('save writes the session file with 0o600 permissions', () => {
    withTempDir('opendesk-token-store-mode-', (dir) => {
        const store = new AccountTokenStore();
        store.save(sampleSession);

        const filePath = path.join(dir, 'identity', 'account-session.json');
        if (process.platform !== 'win32') {
            const mode = fs.statSync(filePath).mode & 0o777;
            assert.equal(mode, 0o600);
        }
    });
});
