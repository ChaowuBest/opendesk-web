import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from '@jest/globals';
import { AdminTokenStore, type AdminTokenEncryption } from '../../../main/utils/admin-token.js';

function createEncryption(available = true): AdminTokenEncryption & { writes: string[] } {
    return {
        writes: [],
        available: () => available,
        encrypt: (value: string) => Buffer.from(`enc:${Buffer.from(value, 'utf8').toString('base64')}`, 'utf8'),
        decrypt: (value: Buffer) => {
            const text = value.toString('utf8');
            if (!text.startsWith('enc:')) throw new Error('bad payload');
            return Buffer.from(text.slice(4), 'base64').toString('utf8');
        }
    };
}

describe('AdminTokenStore', () => {
    test('save/load roundtrip with matching server', () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'admin-token-'));
        try {
            const encryption = createEncryption();
            const store = new AdminTokenStore(path.join(dir, 'admin-token.enc'), encryption);
            store.save('http://127.0.0.1:8788', 'token-1');
            expect(store.load('http://127.0.0.1:8788/')).toBe('token-1');
            expect(store.load('https://opendesk.matrix.openharmony.cn')).toBeNull();
            // 文件内容不应包含明文令牌
            const raw = readFileSync(path.join(dir, 'admin-token.enc'), 'utf8');
            expect(raw).not.toContain('token-1');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('clear removes persisted token', () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'admin-token-'));
        try {
            const file = path.join(dir, 'admin-token.enc');
            const store = new AdminTokenStore(file, createEncryption());
            store.save('http://127.0.0.1:8788', 'token-1');
            expect(existsSync(file)).toBe(true);
            store.clear();
            expect(existsSync(file)).toBe(false);
            expect(store.load('http://127.0.0.1:8788')).toBeNull();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('rejects empty or oversized token', () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'admin-token-'));
        try {
            const store = new AdminTokenStore(path.join(dir, 'admin-token.enc'), createEncryption());
            expect(() => store.save('http://127.0.0.1:8788', '   ')).toThrow('Invalid admin token');
            expect(() => store.save('http://127.0.0.1:8788', 'x'.repeat(4097))).toThrow('Invalid admin token');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('no persistence when encryption unavailable, session fallback works', () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'admin-token-'));
        try {
            const file = path.join(dir, 'admin-token.enc');
            const store = new AdminTokenStore(file, createEncryption(false));
            expect(store.canPersist()).toBe(false);
            store.save('http://127.0.0.1:8788', 'token-1');
            expect(existsSync(file)).toBe(false);
            expect(store.load('http://127.0.0.1:8788')).toBeNull();
            store.setSession('http://127.0.0.1:8788', 'session-1');
            expect(store.loadSession('http://127.0.0.1:8788')).toBe('session-1');
            expect(store.loadSession('https://opendesk.matrix.openharmony.cn')).toBeNull();
            store.clearSession();
            expect(store.loadSession('http://127.0.0.1:8788')).toBeNull();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('corrupted payload is treated as absent', () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'admin-token-'));
        try {
            const file = path.join(dir, 'admin-token.enc');
            const store = new AdminTokenStore(file, createEncryption());
            store.save('http://127.0.0.1:8788', 'token-1');
            // 模拟换机器后解密失败：写入不合法密文
            writeFileSync(file, Buffer.from('garbage'));
            expect(store.load('http://127.0.0.1:8788')).toBeNull();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
