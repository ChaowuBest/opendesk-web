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
 * BaseStorage integration tests
 *
 * 运行方式：
 * npx tsx --test src/tests/ut/node/services/storage/storage.test.ts
 */

import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import fs from 'fs';
import {
    BaseStorage,
    ColumnSchema,
    Item,
    SearchItem,
    BM25Query,
    DimMismatchError
} from '../../../../../main/services/storage/abstract-storage.js';

// ── Constants & Helpers ─────────────────────────────────────────────

const VECTOR_DIM = 1024;

function makeOneHotVector(index: number, dim: number = VECTOR_DIM): number[] {
    const vec = Array(dim).fill(0);
    vec[index] = 1;
    return vec;
}

function tmpDir(name: string): string {
    return path.join(os.tmpdir(), `storage-test-${name}-${Date.now()}`);
}

function cleanup(dir: string): void {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function extractSearchItems(result: Awaited<ReturnType<BaseStorage['search']>>): SearchItem[] {
    assert(
        result && Array.isArray(result.items) && typeof result.totalCount === 'number',
        'storage.search() must return { items, totalCount }'
    );
    return result.items;
}

// ── Shared schema (Base + BM25 + Vector + Tag) ─────────────────────

const fullSchema: ColumnSchema = {
    columns: {
        item_id: { type: 'TEXT', nullable: false },
        item_type: { type: 'TEXT', nullable: false },
        filename: { type: 'TEXT', nullable: true },
        text: { type: 'TEXT', nullable: true },
        tag: { type: 'TEXT', nullable: true },
        created_at: { type: 'INTEGER', nullable: true },
        updated_at: { type: 'INTEGER', nullable: true },
        semi_text: { type: 'TEXT', nullable: true }
    },
    needIndexers: {
        tag: [{ indexer: 'TagIndexer' }],
        text: [{ indexer: 'VectorIndexer', options: { dim: 1024 } }, { indexer: 'BM25Indexer' }]
    }
};

function buildTestItems(): Item[] {
    const now = Date.now();
    return [
        {
            item_id: 'item-1',
            item_type: 'file',
            filename: 'report-2024.txt',
            text: 'vector-a',
            tag: 'todo',
            created_at: now,
            updated_at: now,
            semi_text: 'vector-a',
            indexer_columns: {
                VectorIndexer: [{ column: 'text', content: makeOneHotVector(0) }],
                TagIndexer: [{ column: 'tag', content: 'todo' }],
                BM25Indexer: [{ column: 'text', content: '项目计划书 project proposal' }]
            }
        },
        {
            item_id: 'item-2',
            item_type: 'file',
            filename: 'notes.txt',
            text: 'vector-b',
            tag: 'idea',
            created_at: now,
            updated_at: now,
            semi_text: 'vector-b',
            indexer_columns: {
                VectorIndexer: [{ column: 'text', content: makeOneHotVector(1) }],
                TagIndexer: [{ column: 'tag', content: 'idea' }],
                BM25Indexer: [{ column: 'text', content: '会议纪要 meeting notes' }]
            }
        }
    ];
}

// ── Tests ────────────────────────────────────────────────────────────

/** 1. Basic CRUD with all four indexers */
async function testBasicCrudAllIndexers(storage: BaseStorage): Promise<void> {
    const baseResults = extractSearchItems(
        await storage.search([{ indexer: 'BaseIndexer', field: 'text', operator: 'like', value: 'vector%' }])
    );
    assert.equal(baseResults.length, 2, 'BaseIndexer like should find 2 items');

    const vecResults = extractSearchItems(
        await storage.search([
            {
                indexer: 'VectorIndexer',
                field: 'text',
                operator: 'vector_near',
                value: makeOneHotVector(0),
                vectorQuery: { topK: 1, metric: 'cosine', threshold: 0.0 }
            }
        ])
    );
    assert(vecResults.length >= 1, 'VectorIndexer should return at least 1 result');
    assert.equal(vecResults[0].item.item_id, 'item-1');

    const tagResults = extractSearchItems(
        await storage.search([{ indexer: 'TagIndexer', field: 'tag', operator: 'like', value: 'todo' }])
    );
    assert(tagResults.length >= 1, 'TagIndexer should find at least 1 result');

    const bm25Results = extractSearchItems(
        await storage.search([
            {
                indexer: 'BM25Indexer',
                field: 'text',
                operator: 'bm25_match',
                value: { query: 'project', topK: 10 } as BM25Query
            }
        ])
    );
    assert(bm25Results.length >= 1, 'BM25 English query should return results');

    const zhResults = extractSearchItems(
        await storage.search([
            {
                indexer: 'BM25Indexer',
                field: 'text',
                operator: 'bm25_match',
                value: { query: '项目计划书', topK: 10 } as BM25Query
            }
        ])
    );
    assert(zhResults.length >= 1 && zhResults[0].item.item_id === 'item-1', 'BM25 Chinese query should hit item-1');

    console.log('[testBasicCrudAllIndexers] PASS');
}

/** 2. Insert semantics: first-write-only, no overwrite */
async function testInsertSemantics(storage: BaseStorage): Promise<void> {
    await storage.insert(buildTestItems()); // double insert — no error

    await storage.insert([
        {
            item_id: 'insert-skip',
            item_type: 'file',
            filename: 'original.txt',
            indexer_columns: {
                BM25Indexer: [{ column: 'text', content: 'original text' }],
                VectorIndexer: [{ column: 'text', content: new Array(1024).fill(0.1) }],
                TagIndexer: [{ column: 'tag', content: 'original-tag' }]
            }
        }
    ]);
    const statusBefore = await storage.getStatus();

    await storage.insert([
        {
            item_id: 'insert-skip',
            item_type: 'file',
            filename: 'overwritten.txt',
            indexer_columns: {
                BM25Indexer: [{ column: 'text', content: 'overwritten text' }],
                VectorIndexer: [{ column: 'text', content: new Array(1024).fill(0.3) }],
                TagIndexer: [{ column: 'tag', content: 'overwritten-tag' }]
            }
        }
    ]);
    const statusAfter = await storage.getStatus();

    const row = extractSearchItems(
        await storage.search([{ indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: 'insert-skip' }])
    )[0]?.item;
    assert.equal(row?.filename, 'original.txt', 'Insert should not overwrite existing row');
    assert.equal(statusAfter.BaseIndexer.size, statusBefore.BaseIndexer.size);

    const bm25 = extractSearchItems(
        await storage.search([
            {
                indexer: 'BM25Indexer',
                field: 'text',
                operator: 'bm25_match',
                value: { query: 'overwritten', topK: 10 } as BM25Query
            }
        ])
    );
    assert(!bm25.some((r) => r.item.item_id === 'insert-skip'), 'Duplicate insert should not overwrite BM25 data');

    const tags = extractSearchItems(
        await storage.search([{ indexer: 'TagIndexer', field: 'tag', operator: 'like', value: 'overwritten-tag' }])
    );
    assert(!tags.some((r) => r.item.item_id === 'insert-skip'), 'Duplicate insert should not overwrite Tag data');

    console.log('[testInsertSemantics] PASS');
}

/** 3. Update semantics: non-existent item creates no rows */
async function testUpdateSemantics(storage: BaseStorage): Promise<void> {
    const before = await storage.getStatus();
    await storage.update([
        {
            item_id: 'update-missing',
            item_type: 'file',
            filename: 'should-not-exist.txt',
            indexer_columns: {
                BM25Indexer: [{ column: 'text', content: 'should not exist' }],
                VectorIndexer: [{ column: 'text', content: new Array(1024).fill(0.5) }],
                TagIndexer: [{ column: 'tag', content: 'missing-tag' }]
            }
        }
    ]);
    const after = await storage.getStatus();

    const results = extractSearchItems(
        await storage.search([{ indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: 'update-missing' }])
    );
    assert.equal(results.length, 0, 'Update non-existent should create no base row');
    assert.equal(after.BaseIndexer.size, before.BaseIndexer.size);

    console.log('[testUpdateSemantics] PASS');
}

/** 4. Delete semantics: non-existent OK, string[] accepted */
async function testDeleteSemantics(storage: BaseStorage): Promise<void> {
    await storage.delete([{ item_id: 'non-existent-delete', item_type: 'file' }]);

    await storage.insert([{ item_id: 'delete-string-id', item_type: 'file', filename: 'del.txt' }]);
    await storage.delete(['delete-string-id']);
    const results = extractSearchItems(
        await storage.search([{ indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: 'delete-string-id' }])
    );
    assert.equal(results.length, 0, 'delete(string[]) should remove item');

    console.log('[testDeleteSemantics] PASS');
}

/** 5. Upsert semantics: new + existing + mixed batch */
async function testUpsertSemantics(storage: BaseStorage): Promise<void> {
    await storage.upsert([{ item_id: 'upsert-new', item_type: 'file', filename: 'new.txt', indexer_columns: {} }]);
    const r1 = extractSearchItems(
        await storage.search([{ indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: 'upsert-new' }])
    );
    assert.equal(r1.length, 1, 'Upsert new item should create it');

    await storage.upsert([{ item_id: 'upsert-new', item_type: 'file', filename: 'updated.txt', indexer_columns: {} }]);
    const r2 = extractSearchItems(
        await storage.search([{ indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: 'upsert-new' }])
    );
    assert.equal(r2[0]?.item.filename, 'updated.txt', 'Upsert existing should update');

    await storage.insert([{ item_id: 'ur-2', item_type: 'file', filename: 'original-2.txt' }]);
    await storage.upsert([
        { item_id: 'ur-1', item_type: 'file', filename: 'new-1.txt' },
        { item_id: 'ur-2', item_type: 'file', filename: 'updated-2.txt' },
        { item_id: 'ur-3', item_type: 'file', filename: 'new-3.txt' }
    ]);
    const r3 = extractSearchItems(
        await storage.search([
            { indexer: 'BaseIndexer', field: 'item_id', operator: 'in', value: ['ur-1', 'ur-2', 'ur-3'] }
        ])
    );
    assert.equal(r3.length, 3, 'Mixed upsert batch should produce 3 items');
    assert.equal(r3.find((r) => r.item.item_id === 'ur-2')?.item.filename, 'updated-2.txt');

    console.log('[testUpsertSemantics] PASS');
}

/** 6. Vector + Base combo search */
async function testVectorBaseCombo(): Promise<void> {
    const dir = tmpDir('vec-base');
    const schema: ColumnSchema = {
        columns: {
            item_id: { type: 'TEXT', nullable: false },
            item_type: { type: 'TEXT', nullable: false },
            text: { type: 'TEXT', nullable: true },
            semi_text: { type: 'TEXT', nullable: true }
        },
        needIndexers: {
            text: [{ indexer: 'VectorIndexer', options: { dim: 1024 } }],
            semi_text: [{ indexer: 'VectorIndexer', options: { dim: 1024 } }]
        }
    };
    const storage = new BaseStorage('vec-base', schema, dir);
    await storage.initialize();

    await storage.insert([
        {
            item_id: 'vb-1',
            item_type: 'file',
            text: 'text-a',
            semi_text: 'semi-a',
            indexer_columns: {
                VectorIndexer: [
                    { column: 'text', content: makeOneHotVector(2) },
                    { column: 'semi_text', content: makeOneHotVector(3) }
                ]
            }
        },
        {
            item_id: 'vb-2',
            item_type: 'file',
            text: 'text-b',
            semi_text: 'semi-b',
            indexer_columns: {
                VectorIndexer: [
                    { column: 'text', content: makeOneHotVector(4) },
                    { column: 'semi_text', content: makeOneHotVector(5) }
                ]
            }
        }
    ]);

    const r1 = extractSearchItems(
        await storage.search([
            {
                indexer: 'VectorIndexer',
                field: 'text',
                operator: 'vector_near',
                value: makeOneHotVector(2),
                vectorQuery: { topK: 1, metric: 'cosine', threshold: 0.0 }
            },
            { indexer: 'BaseIndexer', field: 'text', operator: 'like', value: 'text-%' }
        ])
    );
    assert(r1.length >= 1 && r1[0].item.item_id === 'vb-1');

    const r2 = extractSearchItems(
        await storage.search([
            {
                indexer: 'VectorIndexer',
                field: 'semi_text',
                operator: 'vector_near',
                value: makeOneHotVector(5),
                vectorQuery: { topK: 1, metric: 'cosine', threshold: 0.0 }
            }
        ])
    );
    assert(r2.length >= 1 && r2[0].item.item_id === 'vb-2');

    storage.close();
    cleanup(dir);
    console.log('[testVectorBaseCombo] PASS');
}

/** 7. BM25 multi-column search */
async function testBM25MultiColumn(): Promise<void> {
    const dir = tmpDir('bm25-multi');
    const schema: ColumnSchema = {
        columns: {
            item_id: { type: 'TEXT', nullable: false },
            item_type: { type: 'TEXT', nullable: false },
            text: { type: 'TEXT', nullable: true },
            semi_text: { type: 'TEXT', nullable: true }
        },
        needIndexers: {
            text: [{ indexer: 'BM25Indexer' }],
            semi_text: [{ indexer: 'BM25Indexer' }]
        }
    };
    const storage = new BaseStorage('bm25-multi', schema, dir);
    await storage.initialize();

    await storage.insert([
        {
            item_id: 'bm-1',
            item_type: 'file',
            text: 'project plan project',
            semi_text: 'alpha milestones',
            indexer_columns: {
                BM25Indexer: [
                    { column: 'text', content: 'project plan project' },
                    { column: 'semi_text', content: 'alpha milestones' }
                ]
            }
        },
        {
            item_id: 'bm-2',
            item_type: 'file',
            text: 'design review notes',
            semi_text: 'design feedback',
            indexer_columns: {
                BM25Indexer: [
                    { column: 'text', content: 'design review notes' },
                    { column: 'semi_text', content: 'design feedback' }
                ]
            }
        }
    ]);

    const r1 = extractSearchItems(
        await storage.search([
            {
                indexer: 'BM25Indexer',
                field: 'text',
                operator: 'bm25_match',
                value: { query: 'project', topK: 10 } as BM25Query
            }
        ])
    );
    assert(r1.length >= 1, 'BM25 text column search should return results');

    const r2 = extractSearchItems(
        await storage.search([
            {
                indexer: 'BM25Indexer',
                field: 'semi_text',
                operator: 'bm25_match',
                value: { query: 'design', topK: 10 } as BM25Query
            }
        ])
    );
    assert(r2.length >= 1, 'BM25 semi_text column search should return results');

    storage.close();
    cleanup(dir);
    console.log('[testBM25MultiColumn] PASS');
}

/** 8. BM25 + Vector combo */
async function testBM25VectorCombo(): Promise<void> {
    const dir = tmpDir('bm25-vec');
    const schema: ColumnSchema = {
        columns: {
            item_id: { type: 'TEXT', nullable: false },
            item_type: { type: 'TEXT', nullable: false },
            text: { type: 'TEXT', nullable: true }
        },
        needIndexers: {
            text: [{ indexer: 'BM25Indexer' }, { indexer: 'VectorIndexer', options: { dim: 1024 } }]
        }
    };
    const storage = new BaseStorage('bm25-vec', schema, dir);
    await storage.initialize();

    await storage.insert([
        {
            item_id: 'vs-1',
            item_type: 'file',
            text: '项目计划 project plan',
            indexer_columns: {
                BM25Indexer: [{ column: 'text', content: '项目计划 project plan' }],
                VectorIndexer: [{ column: 'text', content: makeOneHotVector(0) }]
            }
        },
        {
            item_id: 'vs-2',
            item_type: 'file',
            text: '会议纪要 meeting notes',
            indexer_columns: {
                BM25Indexer: [{ column: 'text', content: '会议纪要 meeting notes' }],
                VectorIndexer: [{ column: 'text', content: makeOneHotVector(1) }]
            }
        }
    ]);

    const results = extractSearchItems(
        await storage.search([
            {
                indexer: 'BM25Indexer',
                field: 'text',
                operator: 'bm25_match',
                value: { query: '项目计划' } as BM25Query
            },
            {
                indexer: 'VectorIndexer',
                field: 'text',
                operator: 'vector_near',
                value: makeOneHotVector(0),
                vectorQuery: { topK: 5, metric: 'cosine', threshold: 0.5 }
            }
        ])
    );
    assert(results.length >= 1 && results[0].item.item_id === 'vs-1');

    storage.close();
    cleanup(dir);
    console.log('[testBM25VectorCombo] PASS');
}

/** 9. Multi-column vector update does not affect sibling */
async function testMultiColumnVectorUpdate(): Promise<void> {
    const dir = tmpDir('multi-col-vec');
    const schema: ColumnSchema = {
        columns: {
            item_id: { type: 'TEXT', nullable: false },
            item_type: { type: 'TEXT', nullable: false },
            col_a: { type: 'TEXT', nullable: true },
            col_b: { type: 'TEXT', nullable: true }
        },
        needIndexers: {
            col_a: [{ indexer: 'VectorIndexer', options: { dim: 1024 } }],
            col_b: [{ indexer: 'VectorIndexer', options: { dim: 1024 } }]
        }
    };
    const storage = new BaseStorage('multi-col-vec', schema, dir);
    await storage.initialize();

    await storage.insert([
        {
            item_id: 'mc-1',
            item_type: 'file',
            col_a: 'a',
            col_b: 'b',
            indexer_columns: {
                VectorIndexer: [
                    { column: 'col_a', content: makeOneHotVector(0) },
                    { column: 'col_b', content: makeOneHotVector(1) }
                ]
            }
        }
    ]);

    await storage.update([
        {
            item_id: 'mc-1',
            item_type: 'file',
            col_a: 'a-updated',
            col_b: 'b',
            indexer_columns: { VectorIndexer: [{ column: 'col_a', content: makeOneHotVector(5) }] }
        }
    ]);

    const r = extractSearchItems(
        await storage.search([
            {
                indexer: 'VectorIndexer',
                field: 'col_b',
                operator: 'vector_near',
                value: makeOneHotVector(1),
                vectorQuery: { topK: 1, metric: 'cosine', threshold: 0.9 }
            }
        ])
    );
    assert(r.length >= 1 && r[0].item.item_id === 'mc-1', 'col_b should still return mc-1 after col_a update');

    storage.close();
    cleanup(dir);
    console.log('[testMultiColumnVectorUpdate] PASS');
}

/** 10. BM25 upsert does not delete sibling columns */
async function testBM25UpsertSiblingColumns(): Promise<void> {
    const dir = tmpDir('bm25-sibling');
    const schema: ColumnSchema = {
        columns: {
            item_id: { type: 'TEXT', nullable: false },
            item_type: { type: 'TEXT', nullable: false },
            text: { type: 'TEXT', nullable: true },
            semi_text: { type: 'TEXT', nullable: true }
        },
        needIndexers: {
            text: [{ indexer: 'BM25Indexer' }],
            semi_text: [{ indexer: 'BM25Indexer' }]
        }
    };
    const storage = new BaseStorage('bm25-sibling', schema, dir);
    await storage.initialize();

    await storage.insert([
        {
            item_id: 'bm25-sib',
            item_type: 'file',
            text: 'project alpha',
            semi_text: 'release checklist',
            indexer_columns: {
                BM25Indexer: [
                    { column: 'text', content: 'project alpha' },
                    { column: 'semi_text', content: 'release checklist' }
                ]
            }
        }
    ]);

    await storage.upsert([
        {
            item_id: 'bm25-sib',
            item_type: 'file',
            text: 'project beta',
            semi_text: 'release checklist',
            indexer_columns: { BM25Indexer: [{ column: 'text', content: 'project beta' }] }
        }
    ]);

    const textR = extractSearchItems(
        await storage.search([
            {
                indexer: 'BM25Indexer',
                field: 'text',
                operator: 'bm25_match',
                value: { query: 'beta', topK: 10 } as BM25Query
            }
        ])
    );
    assert(textR.length >= 1 && textR[0].item.item_id === 'bm25-sib', 'Updated text should be searchable');

    const sibR = extractSearchItems(
        await storage.search([
            {
                indexer: 'BM25Indexer',
                field: 'semi_text',
                operator: 'bm25_match',
                value: { query: 'release', topK: 10 } as BM25Query
            }
        ])
    );
    assert(sibR.length >= 1 && sibR[0].item.item_id === 'bm25-sib', 'Sibling BM25 column should not be deleted');

    storage.close();
    cleanup(dir);
    console.log('[testBM25UpsertSiblingColumns] PASS');
}

/** 11. Vector insert skips sibling columns for existing item */
async function testVectorInsertSkipSibling(): Promise<void> {
    const dir = tmpDir('vec-skip-sib');
    const schema: ColumnSchema = {
        columns: {
            item_id: { type: 'TEXT', nullable: false },
            item_type: { type: 'TEXT', nullable: false },
            col_a: { type: 'TEXT', nullable: true },
            col_b: { type: 'TEXT', nullable: true }
        },
        needIndexers: {
            col_a: [{ indexer: 'VectorIndexer', options: { dim: 1024 } }],
            col_b: [{ indexer: 'VectorIndexer', options: { dim: 1024 } }]
        }
    };
    const storage = new BaseStorage('vec-skip-sib', schema, dir);
    await storage.initialize();

    await storage.insert([
        {
            item_id: 'vs',
            item_type: 'file',
            col_a: 'a',
            indexer_columns: { VectorIndexer: [{ column: 'col_a', content: makeOneHotVector(20) }] }
        }
    ]);
    await storage.insert([
        {
            item_id: 'vs',
            item_type: 'file',
            col_b: 'b',
            indexer_columns: { VectorIndexer: [{ column: 'col_b', content: makeOneHotVector(21) }] }
        }
    ]);

    const rA = extractSearchItems(
        await storage.search([
            {
                indexer: 'VectorIndexer',
                field: 'col_a',
                operator: 'vector_near',
                value: makeOneHotVector(20),
                vectorQuery: { topK: 5, metric: 'cosine', threshold: 0.9 }
            }
        ])
    );
    assert(rA.length >= 1 && rA[0].item.item_id === 'vs', 'Original col_a should remain');

    const rB = extractSearchItems(
        await storage.search([
            {
                indexer: 'VectorIndexer',
                field: 'col_b',
                operator: 'vector_near',
                value: makeOneHotVector(21),
                vectorQuery: { topK: 5, metric: 'cosine', threshold: 0.9 }
            }
        ])
    );
    assert.equal(rB.length, 0, 'Insert should not write sibling vector for existing item');

    storage.close();
    cleanup(dir);
    console.log('[testVectorInsertSkipSibling] PASS');
}

/** 12. DimMismatchError detection */
async function testDimMismatchDetection(): Promise<void> {
    const dir = tmpDir('dim-mismatch');
    const schema1024: ColumnSchema = {
        columns: {
            item_id: { type: 'TEXT', nullable: false },
            item_type: { type: 'TEXT', nullable: false },
            repr: { type: 'BLOB', nullable: true }
        },
        needIndexers: { repr: [{ indexer: 'VectorIndexer', options: { dim: 1024 } }] }
    };

    const s1 = new BaseStorage('dim-test', schema1024, dir);
    await s1.initialize();
    await s1.insert([
        {
            item_id: 'dm-1',
            item_type: 'file',
            indexer_columns: { VectorIndexer: [{ column: 'repr', content: makeOneHotVector(0, 1024) }] }
        }
    ]);
    s1.close();

    const schema512: ColumnSchema = {
        ...schema1024,
        needIndexers: { repr: [{ indexer: 'VectorIndexer', options: { dim: 512 } }] }
    };
    const s2 = new BaseStorage('dim-test-512', schema512, dir);
    let dimError: any = null;
    try {
        await s2.initialize();
    } catch (e) {
        dimError = e;
    }

    assert(dimError?.name === 'DimMismatchError', 'Should throw DimMismatchError');
    assert.equal(dimError.storedDim, 1024);
    assert.equal(dimError.configuredDim, 512);

    cleanup(dir);
    console.log('[testDimMismatchDetection] PASS');
}

/** 13. getStatus reports correct info */
async function testGetStatus(): Promise<void> {
    const dir = tmpDir('get-status');
    const schema: ColumnSchema = {
        columns: {
            item_id: { type: 'TEXT', nullable: false },
            item_type: { type: 'TEXT', nullable: false },
            repr: { type: 'BLOB', nullable: true }
        },
        needIndexers: { repr: [{ indexer: 'VectorIndexer', options: { dim: 1024 } }] }
    };
    const storage = new BaseStorage('get-status', schema, dir);
    await storage.initialize();

    await storage.insert([
        {
            item_id: 'gs-1',
            item_type: 'file',
            indexer_columns: { VectorIndexer: [{ column: 'repr', content: makeOneHotVector(0) }] }
        }
    ]);

    const status = await storage.getStatus();
    assert.equal(typeof status.BaseIndexer?.size, 'number');
    assert.equal(typeof status.VectorIndexer?.size, 'number');
    assert.equal(typeof status.VectorIndexer?.dim, 'number');
    assert.equal(status.BaseIndexer.size, 1);
    assert.equal(status.VectorIndexer.size, 1);

    storage.close();
    cleanup(dir);
    console.log('[testGetStatus] PASS');
}

/** 14. search returns { items, totalCount } */
async function testSearchReturnsItemsAndTotalCount(storage: BaseStorage): Promise<void> {
    const result = await storage.search([{ indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: 'item-1' }]);
    assert.equal(result.totalCount, 1);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].item.item_id, 'item-1');
    console.log('[testSearchReturnsItemsAndTotalCount] PASS');
}

/** 15. item_type not polluted by indexer column names */
async function testItemTypeNotPolluted(storage: BaseStorage): Promise<void> {
    const bm25 = extractSearchItems(
        await storage.search([
            {
                indexer: 'BM25Indexer',
                field: 'text',
                operator: 'bm25_match',
                value: { query: 'project', topK: 10 } as BM25Query
            }
        ])
    );
    assert.notEqual(bm25[0]?.item.item_type, 'text');

    const vec = extractSearchItems(
        await storage.search([
            {
                indexer: 'VectorIndexer',
                field: 'text',
                operator: 'vector_near',
                value: makeOneHotVector(0),
                vectorQuery: { topK: 1, metric: 'cosine', threshold: 0.0 }
            }
        ])
    );
    assert.notEqual(vec[0]?.item.item_type, 'text');

    const tag = extractSearchItems(
        await storage.search([{ indexer: 'TagIndexer', field: 'tag', operator: 'like', value: 'todo' }])
    );
    assert.notEqual(tag[0]?.item.item_type, 'tag');

    console.log('[testItemTypeNotPolluted] PASS');
}

async function testUpsertPartialSkipsUnwantedIndexers(): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'partial-skip-'));
    const storage = new BaseStorage('partial-skip', fullSchema, dir);
    await storage.initialize();
    try {
        await storage.upsert(
            [
                {
                    item_id: 'p1',
                    item_type: 'file',
                    filename: 'a.md',
                    text: 'hello',
                    indexer_columns: {
                        VectorIndexer: [{ column: 'text', content: makeOneHotVector(0) }],
                        BM25Indexer: [{ column: 'text', content: 'hello world' }]
                    }
                }
            ],
            { indexers: ['BaseIndexer'] }
        );
        const baseRes = await storage.search([
            { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: 'p1' }
        ]);
        assert.equal(baseRes.items.length, 1);
        const status = await storage.getStatus();
        assert.equal(
            status.VectorIndexer?.size ?? 0,
            0,
            'VectorIndexer must be empty: payload was provided but options.indexers excluded it'
        );
        assert.equal(status.BM25Indexer?.size ?? 0, 0, 'BM25Indexer must be empty likewise');
    } finally {
        await storage.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

async function testUpsertWithoutOptionsWritesAll(): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'partial-all-'));
    const storage = new BaseStorage('partial-all', fullSchema, dir);
    await storage.initialize();
    try {
        await storage.upsert([
            {
                item_id: 'p2',
                item_type: 'file',
                filename: 'b.md',
                text: 'hi',
                indexer_columns: {
                    VectorIndexer: [{ column: 'text', content: makeOneHotVector(1) }]
                }
            }
        ]);
        const status = await storage.getStatus();
        assert.equal(status.VectorIndexer?.size, 1);
    } finally {
        await storage.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

async function testUpdatePartialSkipsUnwantedIndexers(): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'partial-update-skip-'));
    const storage = new BaseStorage('partial-update-skip', fullSchema, dir);
    await storage.initialize();
    try {
        await storage.upsert([
            {
                item_id: 'pu1',
                item_type: 'file',
                filename: 'before.md',
                text: 'before',
                indexer_columns: {
                    VectorIndexer: [{ column: 'text', content: makeOneHotVector(2) }]
                }
            }
        ]);
        await storage.update(
            [
                {
                    item_id: 'pu1',
                    item_type: 'file',
                    filename: 'after.md',
                    text: 'after',
                    indexer_columns: {
                        VectorIndexer: [{ column: 'text', content: makeOneHotVector(3) }]
                    }
                }
            ],
            { indexers: ['BaseIndexer'] }
        );

        const { items: baseItems } = await storage.search([
            { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: 'pu1' }
        ]);
        assert.equal(baseItems[0]?.item?.filename, 'after.md', 'partial update must update base fields');

        const status = await storage.getStatus();
        assert.equal(status.VectorIndexer?.size, 1, 'partial update must not add vector rows');

        const oldVectorRows = extractSearchItems(
            await storage.search([
                {
                    indexer: 'VectorIndexer',
                    field: 'text',
                    operator: 'vector_similarity',
                    value: makeOneHotVector(2),
                    vectorQuery: { topK: 5, metric: 'cosine', threshold: 0.9 }
                }
            ])
        );
        assert(
            oldVectorRows.some((r) => r.item.item_id === 'pu1'),
            'old vector content must remain'
        );

        const newVectorRows = extractSearchItems(
            await storage.search([
                {
                    indexer: 'VectorIndexer',
                    field: 'text',
                    operator: 'vector_similarity',
                    value: makeOneHotVector(3),
                    vectorQuery: { topK: 5, metric: 'cosine', threshold: 0.9 }
                }
            ])
        );
        assert(!newVectorRows.some((r) => r.item.item_id === 'pu1'), 'new vector content must not be written');
    } finally {
        await storage.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// ── searchVectorMeta tests ──────────────────────────────────────────

async function testSearchVectorMetaNoConditions(): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vecmeta-all-'));
    const storage = new BaseStorage('vecmeta-all', fullSchema, dir);
    await storage.initialize();
    try {
        await storage.upsert([
            {
                item_id: 'vm1',
                item_type: 'file',
                filename: 'a.md',
                text: 'x',
                indexer_columns: { VectorIndexer: [{ column: 'text', content: makeOneHotVector(1) }] }
            },
            {
                item_id: 'vm2',
                item_type: 'file',
                filename: 'b.md',
                text: 'y',
                indexer_columns: { VectorIndexer: [{ column: 'text', content: makeOneHotVector(2) }] }
            }
        ]);
        // item with no vector — should NOT appear in searchVectorMeta
        await storage.upsert([{ item_id: 'vm3', item_type: 'file', filename: 'c.md', text: 'z' }]);

        const rows = await storage.searchVectorMeta([]);
        const ids = rows.map((r) => r.item_id).sort();
        assert.deepEqual(ids, ['vm1', 'vm2'], 'searchVectorMeta() with no conditions returns only vectorized items');
        // item_type in vector meta is the column name ('text'), not the item item_type ('file')
        assert(
            rows.every((r) => r.item_type === 'text'),
            'item_type in vector meta must equal the column name'
        );
    } finally {
        storage.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

async function testSearchVectorMetaWithConditions(): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vecmeta-cond-'));
    const storage = new BaseStorage('vecmeta-cond', fullSchema, dir);
    await storage.initialize();
    try {
        const items: Item[] = ['p', 'q', 'r'].map((id, i) => ({
            item_id: id,
            item_type: 'file',
            filename: `${id}.md`,
            text: id,
            indexer_columns: { VectorIndexer: [{ column: 'text', content: makeOneHotVector(i + 1) }] }
        }));
        await storage.upsert(items);

        // filter by item_id '='
        const byId = await storage.searchVectorMeta([{ field: 'item_id', operator: '=', value: 'q' }]);
        assert.equal(byId.length, 1, 'item_id = filter must return exactly one row');
        assert.equal(byId[0].item_id, 'q');

        // filter by item_id 'in'
        const byIn = await storage.searchVectorMeta([{ field: 'item_id', operator: 'in', value: ['p', 'r'] }]);
        const inIds = byIn.map((r) => r.item_id).sort();
        assert.deepEqual(inIds, ['p', 'r'], 'item_id in filter must return matching rows');

        // filter by item_type '=' — item_type in vector meta is the column name, not item.item_type
        const byType = await storage.searchVectorMeta([{ field: 'item_type', operator: '=', value: 'text' }]);
        assert.equal(byType.length, 3, 'item_type = text (column name) must return all three rows');

        // non-matching filter returns empty
        const empty = await storage.searchVectorMeta([{ field: 'item_id', operator: '=', value: 'nonexistent' }]);
        assert.equal(empty.length, 0, 'no match must return empty array');
    } finally {
        storage.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

async function testSearchVectorMetaEmptyDb(): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vecmeta-empty-'));
    const storage = new BaseStorage('vecmeta-empty', fullSchema, dir);
    await storage.initialize();
    try {
        const rows = await storage.searchVectorMeta([]);
        assert.equal(rows.length, 0, 'empty db must return empty array');
    } finally {
        storage.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log('=== BaseStorage Integration Tests ===\n');

    const sharedDir = tmpDir('shared');
    const storage = new BaseStorage('shared', fullSchema, sharedDir);
    await storage.initialize();
    await storage.insert(buildTestItems());

    const sharedTests = [
        () => testBasicCrudAllIndexers(storage),
        () => testInsertSemantics(storage),
        () => testUpdateSemantics(storage),
        () => testDeleteSemantics(storage),
        () => testUpsertSemantics(storage),
        () => testSearchReturnsItemsAndTotalCount(storage),
        () => testItemTypeNotPolluted(storage)
    ];

    let passed = 0,
        failed = 0;
    for (const test of sharedTests) {
        try {
            await test();
            passed++;
        } catch (e: any) {
            console.error(`  FAIL: ${e.message}`);
            failed++;
        }
    }
    storage.close();
    cleanup(sharedDir);

    const standaloneTests = [
        testVectorBaseCombo,
        testBM25MultiColumn,
        testBM25VectorCombo,
        testMultiColumnVectorUpdate,
        testBM25UpsertSiblingColumns,
        testVectorInsertSkipSibling,
        testDimMismatchDetection,
        testGetStatus,
        testUpsertPartialSkipsUnwantedIndexers,
        testUpsertWithoutOptionsWritesAll,
        testUpdatePartialSkipsUnwantedIndexers,
        testClearChunkIndexerPreservesOthers,
        testClearVectorIndexerPreservesOthers,
        testClearBM25IndexerPreservesOthers,
        testClearTagIndexerPreservesOthers,
        testClearIndexerNonexistentIsNoop,
        testClearBaseIndexerThrows,
        testClearUninitializedIndexerThrows,
        testSearchVectorMetaNoConditions,
        testSearchVectorMetaWithConditions,
        testSearchVectorMetaEmptyDb
    ];

    for (const test of standaloneTests) {
        try {
            await test();
            passed++;
        } catch (e: any) {
            console.error(`  FAIL ${test.name}: ${e.message}`);
            failed++;
        }
    }

    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
    process.exit(failed > 0 ? 1 : 0);
}

// ── clearIndexerForItem tests ───────────────────────────────────────

// Custom schema with ChunkIndexer (fullSchema doesn't include it)
const chunkTestSchema: ColumnSchema = {
    columns: {
        item_id: { type: 'TEXT', nullable: false },
        item_type: { type: 'TEXT', nullable: false },
        filename: { type: 'TEXT', nullable: true },
        text: { type: 'TEXT', nullable: true },
        tag: { type: 'TEXT', nullable: true }
    },
    needIndexers: {
        filename: [{ indexer: 'VectorIndexer', options: { dim: VECTOR_DIM } }],
        text: [{ indexer: 'ChunkIndexer', options: { dim: VECTOR_DIM } }],
        tag: [{ indexer: 'TagIndexer' }]
    }
};

async function testClearChunkIndexerPreservesOthers() {
    const dir = tmpDir('clear-chunk-preserves');
    try {
        const storage = new BaseStorage('test', chunkTestSchema, dir);
        await storage.initialize();

        await storage.insert([
            {
                item_id: 'file1',
                item_type: 'file',
                filename: 'report.pdf',
                text: null,
                tag: 'finance',
                indexer_columns: {
                    VectorIndexer: [{ column: 'filename', content: makeOneHotVector(0) }],
                    ChunkIndexer: [
                        { column: 'text', id: 'c1', text: 'chunk one', content: makeOneHotVector(1) },
                        { column: 'text', id: 'c2', text: 'chunk two', content: makeOneHotVector(2) }
                    ],
                    TagIndexer: [{ column: 'tag', content: 'finance' }]
                }
            }
        ]);

        // Verify chunks exist
        const before = await storage.search([
            {
                indexer: 'ChunkIndexer',
                field: 'text',
                operator: 'vector_near',
                value: makeOneHotVector(1),
                vectorQuery: { topK: 10 }
            },
            { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: 'file1' }
        ]);
        assert(before.items.length > 0, 'chunks should exist before clear');

        // Clear only ChunkIndexer
        await storage.clearIndexerForItem('file1', 'ChunkIndexer');

        // ChunkIndexer: cleared
        const afterChunk = await storage.search([
            {
                indexer: 'ChunkIndexer',
                field: 'text',
                operator: 'vector_near',
                value: makeOneHotVector(1),
                vectorQuery: { topK: 10 }
            },
            { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: 'file1' }
        ]);
        assert.equal(afterChunk.items.length, 0, 'ChunkIndexer should be cleared');

        // BaseIndexer: preserved
        const afterBase = await storage.search([
            { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: 'file1' }
        ]);
        assert.equal(afterBase.items.length, 1, 'BaseIndexer should be preserved');

        // VectorIndexer: preserved
        const afterVec = await storage.search([
            {
                indexer: 'VectorIndexer',
                field: 'filename',
                operator: 'vector_near',
                value: makeOneHotVector(0),
                vectorQuery: { topK: 10 }
            }
        ]);
        assert(afterVec.items.length > 0, 'VectorIndexer should be preserved');

        // TagIndexer: preserved
        const afterTag = await storage.search([
            { indexer: 'TagIndexer', field: 'tag', operator: '=', value: 'finance' }
        ]);
        assert(afterTag.items.length > 0, 'TagIndexer should be preserved');

        storage.close();
        console.log('  ✅ clearIndexerForItem: ChunkIndexer cleared, all others preserved');
    } finally {
        cleanup(dir);
    }
}

async function testClearVectorIndexerPreservesOthers() {
    const dir = tmpDir('clear-vec-preserves');
    try {
        const storage = new BaseStorage('test', chunkTestSchema, dir);
        await storage.initialize();

        await storage.insert([
            {
                item_id: 'file1',
                item_type: 'file',
                filename: 'report.pdf',
                text: null,
                tag: 'finance',
                indexer_columns: {
                    VectorIndexer: [{ column: 'filename', content: makeOneHotVector(0) }],
                    ChunkIndexer: [{ column: 'text', id: 'c1', text: 'chunk', content: makeOneHotVector(1) }],
                    TagIndexer: [{ column: 'tag', content: 'finance' }]
                }
            }
        ]);

        await storage.clearIndexerForItem('file1', 'VectorIndexer');

        // VectorIndexer: cleared
        const afterVec = await storage.search([
            {
                indexer: 'VectorIndexer',
                field: 'filename',
                operator: 'vector_near',
                value: makeOneHotVector(0),
                vectorQuery: { topK: 10 }
            }
        ]);
        assert.equal(afterVec.items.length, 0, 'VectorIndexer should be cleared');

        // ChunkIndexer: preserved
        const afterChunk = await storage.search([
            {
                indexer: 'ChunkIndexer',
                field: 'text',
                operator: 'vector_near',
                value: makeOneHotVector(1),
                vectorQuery: { topK: 10 }
            },
            { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: 'file1' }
        ]);
        assert(afterChunk.items.length > 0, 'ChunkIndexer should be preserved');

        // BaseIndexer: preserved
        const afterBase = await storage.search([
            { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: 'file1' }
        ]);
        assert.equal(afterBase.items.length, 1, 'BaseIndexer should be preserved');

        storage.close();
        console.log('  ✅ clearIndexerForItem: VectorIndexer cleared, others preserved');
    } finally {
        cleanup(dir);
    }
}

async function testClearBM25IndexerPreservesOthers() {
    // Uses fullSchema which has BM25Indexer on 'text' column
    const dir = tmpDir('clear-bm25-preserves');
    try {
        const storage = new BaseStorage('test', fullSchema, dir);
        await storage.initialize();

        await storage.insert([buildTestItems()[0]]); // item-1 with BM25+Vector+Tag

        await storage.clearIndexerForItem('item-1', 'BM25Indexer');

        // BM25: cleared
        const afterBM25 = await storage.search([
            { indexer: 'BM25Indexer', field: 'text', operator: 'bm25_match', value: { query: '项目计划书' } }
        ]);
        assert.equal(afterBM25.items.length, 0, 'BM25Indexer should be cleared');

        // BaseIndexer: preserved
        const afterBase = await storage.search([
            { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: 'item-1' }
        ]);
        assert.equal(afterBase.items.length, 1, 'BaseIndexer should be preserved');

        // VectorIndexer: preserved
        const afterVec = await storage.search([
            {
                indexer: 'VectorIndexer',
                field: 'text',
                operator: 'vector_near',
                value: makeOneHotVector(0),
                vectorQuery: { topK: 10 }
            }
        ]);
        assert(afterVec.items.length > 0, 'VectorIndexer should be preserved');

        // TagIndexer: preserved
        const afterTag = await storage.search([{ indexer: 'TagIndexer', field: 'tag', operator: '=', value: 'todo' }]);
        assert(afterTag.items.length > 0, 'TagIndexer should be preserved');

        storage.close();
        console.log('  ✅ clearIndexerForItem: BM25Indexer cleared, others preserved');
    } finally {
        cleanup(dir);
    }
}

async function testClearTagIndexerPreservesOthers() {
    const dir = tmpDir('clear-tag-preserves');
    try {
        const storage = new BaseStorage('test', fullSchema, dir);
        await storage.initialize();

        await storage.insert([buildTestItems()[0]]);

        await storage.clearIndexerForItem('item-1', 'TagIndexer');

        // TagIndexer: cleared
        const afterTag = await storage.search([{ indexer: 'TagIndexer', field: 'tag', operator: '=', value: 'todo' }]);
        assert.equal(afterTag.items.length, 0, 'TagIndexer should be cleared');

        // BaseIndexer: preserved
        const afterBase = await storage.search([
            { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: 'item-1' }
        ]);
        assert.equal(afterBase.items.length, 1, 'BaseIndexer should be preserved');

        // VectorIndexer: preserved
        const afterVec2 = await storage.search([
            {
                indexer: 'VectorIndexer',
                field: 'text',
                operator: 'vector_near',
                value: makeOneHotVector(0),
                vectorQuery: { topK: 10 }
            }
        ]);
        assert(afterVec2.items.length > 0, 'VectorIndexer should be preserved');

        // BM25Indexer: preserved
        const afterBM252 = await storage.search([
            { indexer: 'BM25Indexer', field: 'text', operator: 'bm25_match', value: { query: '项目计划书' } }
        ]);
        assert(afterBM252.items.length > 0, 'BM25Indexer should be preserved');

        storage.close();
        console.log('  ✅ clearIndexerForItem: TagIndexer cleared, others preserved');
    } finally {
        cleanup(dir);
    }
}

async function testClearIndexerNonexistentIsNoop() {
    const dir = tmpDir('clear-nonexist');
    try {
        const storage = new BaseStorage('test', chunkTestSchema, dir);
        await storage.initialize();

        // Should not throw
        await storage.clearIndexerForItem('nonexistent-id', 'ChunkIndexer');
        await storage.clearIndexerForItem('nonexistent-id', 'VectorIndexer');
        await storage.clearIndexerForItem('nonexistent-id', 'TagIndexer');

        storage.close();
        console.log('  ✅ clearIndexerForItem: nonexistent itemId is no-op');
    } finally {
        cleanup(dir);
    }
}

async function testClearBaseIndexerThrows() {
    const dir = tmpDir('clear-base-throws');
    try {
        const storage = new BaseStorage('test', fullSchema, dir);
        await storage.initialize();

        let threw = false;
        try {
            await storage.clearIndexerForItem('item-1', 'BaseIndexer');
        } catch (e: any) {
            threw = true;
            assert(e.message.includes('BaseIndexer'), 'error should mention BaseIndexer');
        }
        assert(threw, 'should throw when clearing BaseIndexer');

        storage.close();
        console.log('  ✅ clearIndexerForItem: BaseIndexer throws');
    } finally {
        cleanup(dir);
    }
}

async function testClearUninitializedIndexerThrows() {
    const dir = tmpDir('clear-uninit');
    try {
        // Schema without BM25Indexer
        const noBm25Schema: ColumnSchema = {
            columns: {
                item_id: { type: 'TEXT', nullable: false },
                item_type: { type: 'TEXT', nullable: false },
                filename: { type: 'TEXT', nullable: true }
            },
            needIndexers: {}
        };
        const storage = new BaseStorage('test', noBm25Schema, dir);
        await storage.initialize();

        let threw = false;
        try {
            await storage.clearIndexerForItem('item-1', 'BM25Indexer');
        } catch {
            threw = true;
        }
        assert(threw, 'should throw when indexer not initialized');

        storage.close();
        console.log('  ✅ clearIndexerForItem: uninitialized indexer throws');
    } finally {
        cleanup(dir);
    }
}

main().catch((e) => {
    console.error('Fatal error:', e);
    process.exit(1);
});
