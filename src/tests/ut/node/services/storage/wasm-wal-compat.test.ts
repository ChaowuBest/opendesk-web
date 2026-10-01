import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { ensureWasmOpenableDb } from '../../../../../main/services/storage/wasm-wal-compat.js';

const require = createRequire(import.meta.url);

function tmpDbPath(name: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wasm-wal-compat-'));
    return path.join(dir, name);
}

function cleanup(...paths: string[]): void {
    for (const p of paths) {
        fs.rmSync(p, { recursive: true, force: true });
        fs.rmSync(`${p}-wal`, { recursive: true, force: true });
        fs.rmSync(`${p}-shm`, { recursive: true, force: true });
        fs.rmSync(`${p}-journal`, { recursive: true, force: true });
    }
}

/**
 * 用 native better-sqlite3 创建一个 WAL 模式的数据库并写入数据后正常关闭。
 * 这是 filemgr 等应用在 native 可用时产生的真实数据库形态：
 * header 标记为 WAL（offset 18/19 = 0x02），关闭时 -wal 已 checkpoint 合并。
 */
function createNativeWalDb(dbPath: string, rows: Array<{ item_id: number; title: string }>): void {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE base_index (item_id INTEGER PRIMARY KEY, title TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO base_index (item_id, title) VALUES (?, ?)');
    for (const row of rows) insert.run(row.item_id, row.title);
    db.close();
}

test('wasm 直接打开 native 创建的 WAL 库会失败（复现 filemgr 初始化失败根因）', () => {
    const dbPath = tmpDbPath('wal-base.db');
    try {
        createNativeWalDb(dbPath, [
            { item_id: 1, title: 'hello' },
            { item_id: 2, title: 'world' }
        ]);

        const { Database } = require('node-sqlite3-wasm');
        const db = new Database(dbPath);
        try {
            // node-sqlite3-wasm 的 VFS 不支持 WAL：打开"成功"，但任何语句都报 CANTOPEN
            assert.throws(() => db.get('SELECT count(*) AS c FROM base_index'), /unable to open database file/);
        } finally {
            try {
                db.close();
            } catch {
                /* ignore */
            }
        }
    } finally {
        cleanup(dbPath);
    }
});

test('ensureWasmOpenableDb 将已 checkpoint 的 WAL 库降级为 rollback journal 后 wasm 可正常读写', () => {
    const dbPath = tmpDbPath('wal-downgrade.db');
    try {
        const rows = [
            { item_id: 1, title: 'alpha' },
            { item_id: 2, title: 'beta' },
            { item_id: 3, title: 'gamma' }
        ];
        createNativeWalDb(dbPath, rows);

        assert.equal(ensureWasmOpenableDb(dbPath), 'downgraded');

        const { Database } = require('node-sqlite3-wasm');
        const db = new Database(dbPath);
        try {
            const count = db.get('SELECT count(*) AS c FROM base_index');
            assert.deepEqual(count, { c: 3 });
            // 写入验证
            db.run('INSERT INTO base_index (item_id, title) VALUES (?, ?)', [4, 'delta']);
        } finally {
            db.close();
        }

        // native 侧仍能读回 wasm 写入的数据（格式兼容性）
        const Native = require('better-sqlite3');
        const native = new Native(dbPath, { readonly: true });
        try {
            const rowsAfter = native.prepare('SELECT title FROM base_index ORDER BY item_id').all();
            assert.deepEqual(
                rowsAfter.map((r: any) => r.title),
                ['alpha', 'beta', 'gamma', 'delta']
            );
        } finally {
            native.close();
        }
    } finally {
        cleanup(dbPath);
    }
});

test('ensureWasmOpenableDb 对非 WAL 库（rollback journal）保持原样', () => {
    const dbPath = tmpDbPath('rollback.db');
    try {
        const Database = require('better-sqlite3');
        const db = new Database(dbPath);
        db.exec('CREATE TABLE t (x INTEGER)');
        db.close();

        const header = Buffer.alloc(2);
        const fd = fs.openSync(dbPath, 'r');
        fs.readSync(fd, header, 0, 2, 18);
        fs.closeSync(fd);
        assert.deepEqual([...header], [1, 1]);

        assert.equal(ensureWasmOpenableDb(dbPath), 'rollback');
        // header 不应被改动
        const after = Buffer.alloc(2);
        const fd2 = fs.openSync(dbPath, 'r');
        fs.readSync(fd2, after, 0, 2, 18);
        fs.closeSync(fd2);
        assert.deepEqual([...after], [1, 1]);
    } finally {
        cleanup(dbPath);
    }
});

test('ensureWasmOpenableDb 对不存在的文件直接返回（新库将由 wasm 以 rollback journal 创建）', () => {
    const dbPath = tmpDbPath('absent.db');
    try {
        assert.equal(ensureWasmOpenableDb(dbPath), 'absent');
        assert.equal(fs.existsSync(dbPath), false);
    } finally {
        cleanup(dbPath);
    }
});

test('ensureWasmOpenableDb 存在未合并 -wal 时拒绝降级并抛出明确错误（避免丢数据）', () => {
    const dbPath = tmpDbPath('wal-pending.db');
    try {
        const Database = require('better-sqlite3');
        const db = new Database(dbPath);
        db.pragma('journal_mode = WAL');
        db.exec('CREATE TABLE t (x INTEGER)');
        db.prepare('INSERT INTO t (x) VALUES (1)').run();
        // 不 close：保持 -wal 未 checkpoint 状态
        const walPath = `${dbPath}-wal`;
        assert.ok(fs.existsSync(walPath), 'expected an unmerged -wal file while the connection is open');
        const walSize = fs.statSync(walPath).size;
        assert.ok(walSize > 0, 'expected the -wal file to be non-empty');

        assert.throws(() => ensureWasmOpenableDb(dbPath), /unmerged .*-wal/i);
        // header 不应被改动
        const header = Buffer.alloc(2);
        const fd = fs.openSync(dbPath, 'r');
        fs.readSync(fd, header, 0, 2, 18);
        fs.closeSync(fd);
        assert.deepEqual([...header], [2, 2]);
        db.close();
    } finally {
        cleanup(dbPath);
    }
});

test('ensureWasmOpenableDb 对空 -wal（已 checkpoint 但文件残留）放行降级', () => {
    const dbPath = tmpDbPath('wal-empty-wal.db');
    try {
        createNativeWalDb(dbPath, [{ item_id: 1, title: 'x' }]);
        // 伪造一个空的 -wal 残留文件
        fs.writeFileSync(`${dbPath}-wal`, Buffer.alloc(0));
        assert.equal(ensureWasmOpenableDb(dbPath), 'downgraded');

        const { Database } = require('node-sqlite3-wasm');
        const db = new Database(dbPath);
        try {
            assert.deepEqual(db.get('SELECT count(*) AS c FROM base_index'), { c: 1 });
        } finally {
            db.close();
        }
    } finally {
        cleanup(dbPath);
    }
});

test('重复调用 ensureWasmOpenableDb 是幂等的', () => {
    const dbPath = tmpDbPath('wal-idempotent.db');
    try {
        createNativeWalDb(dbPath, [{ item_id: 1, title: 'x' }]);
        assert.equal(ensureWasmOpenableDb(dbPath), 'downgraded');
        // header 已是 rollback，第二次不再降级
        assert.equal(ensureWasmOpenableDb(dbPath), 'rollback');
    } finally {
        cleanup(dbPath);
    }
});
