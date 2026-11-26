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
import fs from 'node:fs';
import path from 'node:path';
import type { ColumnSchema } from './abstract-storage.js';
import { BM25StatsStore, type BM25Access, type BM25Driver, type BM25Row } from './bm25-stats-store.js';
import { toWasmDbPath } from './wasm-path.js';

const require = createRequire(import.meta.url);
export type BM25WasmLoader = () => typeof import('node-sqlite3-wasm');

export function openBM25WasmDriver(filename: string, access: BM25Access, loader?: BM25WasmLoader): BM25Driver {
    const module = (loader ?? (() => require('node-sqlite3-wasm')))();
    const db = new module.Database(filename, { readOnly: access === 'readonly', fileMustExist: access === 'readonly' });
    return {
        backend: 'wasm',
        exec: (sql) => {
            db.exec(sql);
        },
        close: () => db.close(),
        prepare(sql) {
            const statement = db.prepare(sql);
            return {
                get isFinalized() {
                    return statement.isFinalized;
                },
                run: (params) => {
                    statement.run(params);
                },
                get: (params) => (statement.all(params)[0] ?? undefined) as BM25Row | undefined,
                all: (params) => statement.all(params) as BM25Row[],
                finalize: () => {
                    // sqlite3_finalize can report a prior step error after releasing its handle.
                    if (!statement.isFinalized) statement.finalize();
                }
            };
        }
    };
}

export class BM25IndexDBWasm extends BM25StatsStore {
    constructor(_schema: ColumnSchema, dbPath: string, access: BM25Access = 'readwrite', loader?: BM25WasmLoader) {
        const physicalPath = toWasmDbPath(dbPath);
        if (access === 'readwrite') fs.mkdirSync(path.dirname(physicalPath), { recursive: true });
        super(openBM25WasmDriver(physicalPath, access, loader), physicalPath, access);
    }
}
export default BM25IndexDBWasm;
