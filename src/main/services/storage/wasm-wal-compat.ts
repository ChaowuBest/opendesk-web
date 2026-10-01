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

import fs from 'fs';

/**
 * node-sqlite3-wasm 的自定义 Node VFS 不支持 WAL：
 * `PRAGMA journal_mode = WAL` 会被静默忽略（实际保持 rollback journal），
 * 且打开 header 标记为 WAL 的数据库时，任何语句都会报 "unable to open database file"
 * （SQLITE_CANTOPEN）。
 *
 * 而 native better-sqlite3 创建索引库时会显式启用 WAL（base-index-db.ts /
 * tag-index-db.ts），数据库 header 的 file format write/read version
 * （offset 18/19，值 0x02）会持久化为 WAL。
 *
 * 因此当 native 在主进程不可加载（如 canvas 的旧 libstdc++.so.6 劫持动态链接器，
 * 项目已有记录）、回退到 wasm 后端时，直接打开既有索引库必然失败，表现为
 * filemgr 等应用"文件系统初始化失败"。
 *
 * 本模块在 wasm 打开数据库前检查 header：若库被标记为 WAL 且不存在未合并的
 * -wal 文件（数据已全部 checkpoint 回主库），将标记降级为 rollback journal
 * （0x01），使 wasm 能直接读写原文件，保留既有索引数据。
 * 存在未合并 -wal 时拒绝降级并抛错，避免丢失尚未 checkpoint 的写入。
 */

/** SQLite header 中 file format write version / read version 的偏移（连续 2 字节） */
const HEADER_FORMAT_VERSION_OFFSET = 18;
/** 值 2 = WAL 模式（header 持久化标记，由 SQLite 写入） */
const WAL_FORMAT_VERSION = 0x02;
/** 值 1 = rollback journal 模式 */
const ROLLBACK_FORMAT_VERSION = 0x01;
/** WAL 未合并日志文件名后缀 */
const WAL_FILE_SUFFIX = '-wal';

export type WasmWalCompatResult = 'absent' | 'rollback' | 'downgraded';

/**
 * 确保 dbPath 指向的既有数据库可被 wasm 后端打开。
 * - 文件不存在：返回 'absent'（新库由调用方以 rollback journal 创建）
 * - 存在非空 -wal（未 checkpoint 的写入）：抛错，不能安全降级
 * - header 为 WAL 且无未合并 -wal：将标记改写为 rollback journal，
 *   并清理已无意义的空 -wal/-shm 残留，返回 'downgraded'
 * - header 非 WAL：仅清理空 -wal/-shm 残留（如有），返回 'rollback'
 *
 * 注意：即使 header 已是非 WAL 标记，只要 -wal 文件存在（哪怕为空），
 * node-sqlite3-wasm 打开时仍会尝试读取它并报 CANTOPEN，因此残留文件必须一并清理。
 *
 * 该操作幂等：重复调用时 header 已是 rollback，直接返回 'rollback'。
 */
export function ensureWasmOpenableDb(dbPath: string): WasmWalCompatResult {
    if (!fs.existsSync(dbPath)) return 'absent';

    const walPath = `${dbPath}${WAL_FILE_SUFFIX}`;
    const shmPath = `${dbPath}-shm`;
    let walSize = 0;
    try {
        walSize = fs.statSync(walPath).size;
    } catch {
        walSize = 0; // 无 -wal 文件 = 数据已全部合并回主库
    }
    if (walSize > 0) {
        throw new Error(
            `cannot downgrade WAL database for wasm backend: unmerged ${walPath} (${walSize} bytes); ` +
                `close the owning connection or checkpoint first to avoid data loss`
        );
    }

    const header = Buffer.alloc(2);
    let fd: number;
    try {
        fd = fs.openSync(dbPath, 'r+');
    } catch (error) {
        // 无写权限也应给出可诊断的失败，而不是让 wasm 抛出含糊的 CANTOPEN
        throw new Error(`cannot open database for wasm wal check: ${dbPath}: ${(error as Error).message}`);
    }
    try {
        // 空 -wal 或 -shm 为已 checkpoint 后的残留，wasm 无法读取空 -wal，一律清理
        if (fs.existsSync(walPath)) {
            fs.rmSync(walPath, { force: true });
        }
        if (fs.existsSync(shmPath)) {
            fs.rmSync(shmPath, { force: true });
        }

        const bytesRead = fs.readSync(fd, header, 0, 2, HEADER_FORMAT_VERSION_OFFSET);
        // 短于 20 字节的"数据库"由 sqlite 自己判定为损坏，不干预
        if (bytesRead < 2) return 'rollback';
        if (header[0] !== WAL_FORMAT_VERSION || header[1] !== WAL_FORMAT_VERSION) {
            return 'rollback';
        }

        fs.writeSync(
            fd,
            Buffer.from([ROLLBACK_FORMAT_VERSION, ROLLBACK_FORMAT_VERSION]),
            0,
            2,
            HEADER_FORMAT_VERSION_OFFSET
        );
        fs.fsyncSync(fd);
        return 'downgraded';
    } finally {
        fs.closeSync(fd);
    }
}
