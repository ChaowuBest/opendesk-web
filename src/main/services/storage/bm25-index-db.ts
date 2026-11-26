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

const require = createRequire(import.meta.url);
export type BM25NativeLoader = () => typeof import('better-sqlite3');

export function openBM25NativeDriver(filename: string, access: BM25Access, loader?: BM25NativeLoader): BM25Driver {
    const module = (loader ?? (() => require('better-sqlite3')))();
    const db = new module(filename, { readonly: access === 'readonly', fileMustExist: access === 'readonly' });
    return {
        backend: 'native',
        exec: (sql) => {
            db.exec(sql);
        },
        close: () => db.close(),
        prepare(sql) {
            const statement = db.prepare(sql);
            return {
                run: (params) => {
                    statement.run(...params);
                },
                get: (params) => statement.get(...params) as BM25Row | undefined,
                all: (params) => statement.all(...params) as BM25Row[],
                finalize: () => {
                    /* better-sqlite3 releases native statements with the connection. */
                }
            };
        }
    };
}

export class BM25IndexDB extends BM25StatsStore {
    constructor(_schema: ColumnSchema, dbPath: string, access: BM25Access = 'readwrite', loader?: BM25NativeLoader) {
        const physicalPath = dbPath;
        if (access === 'readwrite') fs.mkdirSync(path.dirname(physicalPath), { recursive: true });
        super(openBM25NativeDriver(physicalPath, access, loader), physicalPath, access);
    }
}
export default BM25IndexDB;
