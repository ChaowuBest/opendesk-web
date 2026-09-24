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
    baseUrl: 'https://personal.example.com/api/v1',
    accessToken: 'access-token-123',
    tokenType: 'Bearer',
    user: {
        id: 'u-1',
        username: 'alice',
        display_name: 'Alice',
        email: 'alice@example.com'
    }
};

function secretsFilePath(dir: string, scope: string): string {
    return path.join(dir, 'identity', 'secrets', `${scope}.json`);
}

test('save persists session to the plugin-scoped secrets file', () => {
    withTempDir('opendesk-token-store-save-', (dir) => {
        const store = new AccountTokenStore('opendesk-account');
        store.save(sampleSession);

        const filePath = secretsFilePath(dir, 'opendesk-account');
        assert.equal(fs.existsSync(filePath), true);
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        assert.deepEqual(parsed, sampleSession);
    });
});

test('load returns the persisted session', () => {
    withTempDir('opendesk-token-store-load-', () => {
        const store = new AccountTokenStore('opendesk-account');
        store.save(sampleSession);

        const loaded = store.load();
        assert.deepEqual(loaded, sampleSession);
    });
});

test('load returns null when no session file exists', () => {
    withTempDir('opendesk-token-store-empty-', () => {
        const store = new AccountTokenStore('opendesk-account');
        assert.equal(store.load(), null);
    });
});

test('load returns null when the session file is corrupt', () => {
    withTempDir('opendesk-token-store-corrupt-', (dir) => {
        fs.mkdirSync(path.join(dir, 'identity', 'secrets'), { recursive: true });
        fs.writeFileSync(secretsFilePath(dir, 'opendesk-account'), '{ not valid json');

        const store = new AccountTokenStore('opendesk-account');
        assert.equal(store.load(), null);
    });
});

test('sessions of different plugins are isolated', () => {
    withTempDir('opendesk-token-store-isolation-', (dir) => {
        const builtin = new AccountTokenStore('opendesk-account');
        const thirdParty = new AccountTokenStore('third-party-account');

        builtin.save(sampleSession);
        assert.equal(thirdParty.load(), null);

        const otherSession = { ...sampleSession, accessToken: 'third-party-token' };
        thirdParty.save(otherSession);

        assert.deepEqual(builtin.load(), sampleSession);
        assert.deepEqual(thirdParty.load(), otherSession);

        thirdParty.clear();
        assert.deepEqual(builtin.load(), sampleSession);
        assert.equal(fs.existsSync(secretsFilePath(dir, 'third-party-account')), false);
    });
});

test('stores only read files inside the plugin-scoped secrets directory', () => {
    withTempDir('opendesk-token-store-scope-', (dir) => {
        // identity 目录下的其他文件（无论内容是否有效）都不属于任何插件作用域
        const identityDir = path.join(dir, 'identity');
        fs.mkdirSync(identityDir, { recursive: true });
        fs.writeFileSync(path.join(identityDir, 'stray-session.json'), JSON.stringify(sampleSession, null, 4), {
            mode: 0o600
        });

        const store = new AccountTokenStore('opendesk-account');
        assert.equal(store.load(), null);
        assert.equal(fs.existsSync(path.join(identityDir, 'stray-session.json')), true);
    });
});

test('clear removes the session file', () => {
    withTempDir('opendesk-token-store-clear-', (dir) => {
        const store = new AccountTokenStore('opendesk-account');
        store.save(sampleSession);
        assert.notEqual(store.load(), null);

        store.clear();
        assert.equal(store.load(), null);
        assert.equal(fs.existsSync(secretsFilePath(dir, 'opendesk-account')), false);
    });
});

test('save writes the session file with 0o600 permissions', () => {
    withTempDir('opendesk-token-store-mode-', (dir) => {
        const store = new AccountTokenStore('opendesk-account');
        store.save(sampleSession);

        const filePath = secretsFilePath(dir, 'opendesk-account');
        if (process.platform !== 'win32') {
            const mode = fs.statSync(filePath).mode & 0o777;
            assert.equal(mode, 0o600);
        }
    });
});
