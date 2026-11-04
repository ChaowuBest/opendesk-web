import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BaseStorage, type ColumnSchema } from '../../../../../main/services/storage/abstract-storage.js';
import { BaseIndexDB } from '../../../../../main/services/storage/base-index-db.js';
import { BaseIndexDBWasm } from '../../../../../main/services/storage/base-index-db-wasm.js';
import { VectorIndexDBWasm } from '../../../../../main/services/storage/vector-index-db-wasm.js';
import { ChunkIndexDBWasm } from '../../../../../main/services/storage/chunk-index-db-wasm.js';

const schema: ColumnSchema = {
    columns: {
        item_id: { type: 'TEXT', nullable: false },
        item_type: { type: 'TEXT', nullable: false },
        filename: { type: 'TEXT', nullable: true },
        modified: { type: 'INTEGER', nullable: true },
        ref_count: { type: 'INTEGER', nullable: false }
    },
    needIndexers: {}
};
const like = (value: string) => ({ field: 'filename', operator: 'like' as const, value });
const terms = [like('%文件系统%'), like('%内存%')];
const visible = { field: 'ref_count', operator: '>' as const, value: 0 };
const scope = { field: 'item_id', operator: 'path_descendant_or_self' as const, value: '/docs' };
const rows = [
    ['name', '文件系统设计.txt', 30, 1],
    ['memory', '内存管理.txt', 20, 1],
    ['both', '文件系统内存.txt', 10, 1],
    ['hidden', '文件系统隐藏.txt', 90, 0],
    ['unrelated', '其他.txt', 80, 1],
    ['quote', "x' OR 1=1 --.txt", 5, 1],
    ['null', null, 1, 1]
].map(([id, filename, modified, ref_count]) => ({
    item_id: `/docs/${id}`,
    item_type: 'file',
    filename,
    modified,
    ref_count
}));
rows.push({ item_id: '/docs-next/outside', item_type: 'file', filename: '内存.txt', modified: 100, ref_count: 1 });

for (const DB of [BaseIndexDB, BaseIndexDBWasm]) {
    test(`${DB.name}: OR preserves AND scope, ordering, pagination, count and bound values`, async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'base-or-'));
        const db = new DB(path.join(directory, 'base.db'), schema);
        try {
            await db.insertMany(rows);
            const conditions = [{ or: terms }, visible, scope];
            const orderBy = { field: 'modified', direction: 'DESC' as const };
            assert.deepEqual(
                (await db.search(conditions, { orderBy })).map((r) => r.item_id),
                ['/docs/name', '/docs/memory', '/docs/both']
            );
            assert.equal(await db.count(conditions), 3);
            assert.equal(
                await db.count([
                    ...conditions,
                    {
                        or: [
                            { field: 'modified', operator: 'between', value: [15, 25] },
                            { field: 'item_id', operator: 'in', value: ['/docs/name'] }
                        ]
                    }
                ]),
                2
            );
            assert.deepEqual(
                (await db.search(conditions, { orderBy, offset: 1, limit: 1 })).map((r) => r.item_id),
                ['/docs/memory']
            );
            assert.deepEqual(
                (await db.search([...terms, visible, scope])).map((r) => r.item_id),
                ['/docs/both']
            );
            assert.equal(await db.count([{ or: [terms[0]] }, visible, scope]), 2);
            assert.equal(await db.count([{ or: [terms[0], terms[0]] }, visible, scope]), 2);
            assert.equal(await db.count([{ or: [like("%x' OR 1=1 --%"), like('%missing%')] }, visible, scope]), 1);
            assert.equal(await db.count([{ or: [like('%missing%')] }, visible, scope]), 0);
            assert.deepEqual(await db.countGrouped(['ref_count'], conditions), [
                { values: { ref_count: 1 }, count: 3 }
            ]);
            for (const invalid of [
                { or: [] },
                { or: null },
                { or: [null] },
                { or: [{ or: terms }] },
                { or: [{ field: 'filename; DROP TABLE base_index', operator: '=', value: 'x' }] },
                { or: [{ field: 'filename', operator: 'unsupported', value: 'x' }] }
            ]) {
                await assert.rejects(async () => db.search([invalid as any]));
                await assert.rejects(async () => db.count([invalid as any]));
            }
            assert.equal(await db.count(), rows.length);
            assert.equal(await db.updateWhere('modified', 7, conditions), 3);
            assert.equal((await db.findById('/docs/hidden'))?.modified, 90);
            assert.equal((await db.findById('/docs-next/outside'))?.modified, 100);
            assert.equal(await db.deleteByConditions(conditions), 3);
            assert.equal(await db.count(), rows.length - 3);
            assert.ok(await db.findById('/docs/hidden'));
            assert.ok(await db.findById('/docs-next/outside'));
        } finally {
            await db.close();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test(`${DB.name}: public storage carries OR groups and rejects cross-indexer/nested groups`, async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-or-'));
        const storage = new BaseStorage(
            'or',
            { ...schema, needIndexers: { filename: [{ indexer: 'BM25Indexer' }] } },
            directory
        );
        try {
            await storage.initialize();
            // Inject a concrete local backend to exercise both through the same public API.
            const base = (storage as any).baseIndexer;
            await base.db.close();
            base.db = new DB(path.join(directory, 'explicit.db'), schema);
            await storage.insert(
                rows.map((row) => ({
                    ...row,
                    indexer_columns: { BM25Indexer: [{ column: 'filename', content: 'sharedtoken' }] }
                })) as any
            );
            const baseCondition = (c: (typeof terms)[number] | typeof visible | typeof scope) => ({
                indexer: 'BaseIndexer',
                ...c
            });
            const group = {
                indexer: 'BaseIndexer' as const,
                or: terms.map((c) => ({ indexer: 'BaseIndexer' as const, ...c }))
            };
            const conditions = [group, baseCondition(visible), baseCondition(scope)];
            const result = await storage.search(conditions, {
                orderBy: { field: 'modified', direction: 'DESC' },
                limit: 2
            });
            assert.deepEqual(
                result.items.map((r) => r.item.item_id),
                ['/docs/name', '/docs/memory']
            );
            assert.equal(await base.count(conditions), 3);
            assert.deepEqual(await storage.countGrouped(['ref_count'], conditions), [
                { values: { ref_count: 1 }, count: 3 }
            ]);
            const targetCondition = {
                indexer: 'BM25Indexer',
                field: 'filename',
                operator: 'bm25_match' as const,
                value: { query: 'sharedtoken' }
            };
            const combined = await storage.search([...conditions, targetCondition]);
            assert.deepEqual(combined.items.map((r) => r.item.item_id).sort(), [
                '/docs/both',
                '/docs/memory',
                '/docs/name'
            ]);
            const joined = await base.search(conditions, {
                existingResults: [{ item_id: '/docs/both' }, { item_id: '/docs/hidden' }]
            });
            assert.deepEqual(
                joined.items.map((r: any) => r.item_id),
                ['/docs/both']
            );
            for (const invalid of [
                { indexer: 'BaseIndexer', or: [] },
                { indexer: 'TagIndexer', or: group.or },
                { indexer: 'BaseIndexer', or: [{ ...group.or[0], indexer: 'VectorIndexer' }] },
                { indexer: 'BaseIndexer', or: [group] },
                { indexer: 'BaseIndexer', or: [{ ...group.or[0], operator: 'vector_similarity' }] }
            ]) {
                await assert.rejects(() => storage.search([invalid as any]));
                await assert.rejects(() =>
                    storage.search([{ ...targetCondition, value: { query: 'missing' } }, invalid as any])
                );
            }
            assert.equal(await base.resetField('ref_count', 0, conditions), 3);
            assert.equal(await base.count(conditions), 0);
            assert.equal((await base.db.findById('/docs-next/outside')).ref_count, 1);
            assert.equal((await base.db.findById('/docs/unrelated')).ref_count, 1);
        } finally {
            await storage.close();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test(`${DB.name}: OR filters survive chunk joins and scoped vector/chunk queries`, async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-or-'));
        const semanticSchema: ColumnSchema = {
            ...schema,
            needIndexers: {
                filename: [
                    { indexer: 'VectorIndexer', options: { dim: 2 } },
                    { indexer: 'ChunkIndexer', options: { dim: 2 } }
                ]
            }
        };
        const storage = new BaseStorage('semantic-or', semanticSchema, directory);
        try {
            await storage.initialize();
            if (DB === BaseIndexDBWasm) {
                // Force actual WASM stores without changing the process platform or factory globally.
                for (const [key, instance] of [
                    ['baseIndexer', new BaseIndexDBWasm(path.join(directory, 'wasm-base.db'), semanticSchema)],
                    ['vectorIndexer', new VectorIndexDBWasm(path.join(directory, 'wasm-vector.db'), 2)],
                    ['chunkIndexer', new ChunkIndexDBWasm(path.join(directory, 'wasm-chunk.db'), 2)]
                ] as const) {
                    const indexer = (storage as any)[key];
                    await indexer.db.close();
                    indexer.db = instance;
                }
            }
            await storage.insert(
                rows.map((row) => ({
                    ...row,
                    indexer_columns: {
                        VectorIndexer: [{ column: 'filename', content: [1, 0] }],
                        ChunkIndexer: Array.from({ length: row.item_id === '/docs/both' ? 2 : 1 }, (_, i) => ({
                            column: 'filename',
                            id: `${row.item_id}:${i}`,
                            text: `chunk ${i}`,
                            content: [1, 0]
                        }))
                    }
                })) as any
            );
            const preconditions = [
                { indexer: 'BaseIndexer' as const, or: terms.map((c) => ({ indexer: 'BaseIndexer' as const, ...c })) },
                { indexer: 'BaseIndexer', ...visible },
                { indexer: 'BaseIndexer', ...scope }
            ];
            const chunkTarget = {
                indexer: 'ChunkIndexer',
                field: 'filename',
                operator: 'vector_near' as const,
                value: [1, 0],
                vectorQuery: { topK: 20, threshold: 0.5 }
            };
            const joined = await storage.search([...preconditions, chunkTarget]);
            assert.deepEqual(joined.items.map((hit) => hit.item.item_id).sort(), [
                '/docs/both',
                '/docs/both',
                '/docs/memory',
                '/docs/name'
            ]);
            for (const indexer of ['VectorIndexer', 'ChunkIndexer']) {
                const result = await storage.searchScope(
                    { preconditions, targetCondition: { ...chunkTarget, indexer } },
                    { collectDiagnostics: true }
                );
                const expected =
                    indexer === 'ChunkIndexer'
                        ? ['/docs/both', '/docs/both', '/docs/memory', '/docs/name']
                        : ['/docs/both', '/docs/memory', '/docs/name'];
                assert.deepEqual(result.items.map((hit) => hit.item.item_id).sort(), expected);
                assert.equal(result.diagnostics?.exactCandidateCount, 3);
                assert.equal(result.diagnostics?.backend, DB === BaseIndexDBWasm ? 'wasm' : 'native');
                const empty = await storage.searchScope({
                    preconditions: [{ indexer: 'BaseIndexer', or: [{ indexer: 'BaseIndexer', ...like('%missing%') }] }],
                    targetCondition: { ...chunkTarget, indexer }
                });
                assert.deepEqual(empty.items, []);
            }
        } finally {
            await storage.close();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
}
