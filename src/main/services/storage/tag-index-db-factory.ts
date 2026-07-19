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

/**
 * TagIndexDB 工厂：根据平台动态加载 Node 原生或 WASM 实现
 */
import type { ITagIndexDB } from './tag-indexer.js';
import { createWithNativeSqliteFallback } from './platform.js';

export async function createTagIndexDB(dbPath: string): Promise<ITagIndexDB> {
    return createWithNativeSqliteFallback(
        async () => {
            const { TagIndexDB } = await import('./tag-index-db.js');
            return new TagIndexDB(dbPath);
        },
        async () => {
            const { TagIndexDBWasm } = await import('./tag-index-db-wasm.js');
            return new TagIndexDBWasm(dbPath);
        }
    );
}
