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
import { performance } from 'node:perf_hooks';
import {
    BaseStorage,
    ColumnSchema,
    Item,
    SearchItem,
    BM25Query,
    DimMismatchError,
    ScopedSearchValidationError,
    mergeScopedVectorHits,
    splitScopedCandidateItems
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
    if (!fs.existsSync(dir)) return;
    // Windows may keep SQLite file handles briefly after close(); retry a few times.
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
            return;
        } catch (err: any) {
            if (err?.code !== 'EPERM' && err?.code !== 'EBUSY') throw err;
            const waitMs = 100 * (attempt + 1);
            const start = Date.now();
            while (Date.now() - start < waitMs) {
                /* busy wait (sync context) */
            }
        }
    }
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
        cleanup(dir);
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
        cleanup(dir);
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
        cleanup(dir);
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
        cleanup(dir);
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
        cleanup(dir);
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
        cleanup(dir);
    }
}

// ── Main ─────────────────────────────────────────────────────────────

async function testScopedSearchValidationAndVectorBatching(): Promise<void> {
    const items = Array.from({ length: 10001 }, (_, index) => ({
        item_id: `item-${index}`,
        item_type: 'file' as const,
        marker: index
    }));
    assert.deepEqual(
        splitScopedCandidateItems(items, 5000).map((batch) => batch.length),
        [5000, 5000, 1]
    );

    const dir = tmpDir('scoped-contract');
    const storage = new BaseStorage('scoped-contract', fullSchema, dir);
    await assert.rejects(
        () =>
            storage.searchScope({
                preconditions: [],
                targetCondition: {
                    indexer: 'VectorIndexer',
                    field: 'text',
                    operator: 'vector_near',
                    value: makeOneHotVector(0),
                    vectorQuery: { topK: 2 }
                }
            }),
        ScopedSearchValidationError
    );

    const calls: string[] = [];
    (storage as any).baseIndexer = {
        search: async () => {
            calls.push('base');
            return { items: items.slice(0, 3), totalCount: 3 };
        }
    };
    (storage as any).vectorIndexer = {
        getBackend: () => 'wasm',
        search: async (_conditions: unknown, options: any) => {
            calls.push(`vector:${options.existingResults.length}`);
            return {
                items: [
                    { item_id: 'item-2', item_type: 'file' },
                    { item_id: 'outside', item_type: 'file' },
                    { item_id: 'item-1', item_type: 'file' }
                ],
                scores: new Map([
                    ['item-2', 0.8],
                    ['outside', 1],
                    ['item-1', 0.8]
                ]),
                totalCount: 3
            };
        }
    };
    const result = await storage.searchScope({
        preconditions: [{ indexer: 'BaseIndexer', field: 'item_type', operator: '=', value: 'file' }],
        targetCondition: {
            indexer: 'VectorIndexer',
            field: 'text',
            operator: 'vector_near',
            value: makeOneHotVector(0),
            vectorQuery: { topK: 2 }
        }
    });
    assert.deepEqual(calls, ['base', 'vector:3']);
    assert.deepEqual(
        result.items.map((hit) => hit.item.item_id),
        ['item-1', 'item-2']
    );
    assert.equal(result.items[0].item.marker, 1);
    assert.equal(result.totalCount, 2);
    cleanup(dir);
}

async function testScopedVectorTargetValidationPrecedesBasePrefilter(): Promise<void> {
    const invalidTargets: Array<[string, any]> = [
        ['non-object target', null],
        ['empty field', { indexer: 'VectorIndexer', field: ' ', operator: 'vector_near', value: [1] }],
        ['unsupported operator', { indexer: 'VectorIndexer', field: 'text', operator: '=', value: [1] }],
        ['empty array vector', { indexer: 'VectorIndexer', field: 'text', operator: 'vector_near', value: [] }],
        [
            'non-finite array vector',
            { indexer: 'VectorIndexer', field: 'text', operator: 'vector_near', value: [Number.NaN] }
        ],
        [
            'empty typed vector',
            { indexer: 'VectorIndexer', field: 'text', operator: 'vector_near', value: new Float32Array() }
        ],
        [
            'invalid vectorQuery',
            { indexer: 'VectorIndexer', field: 'text', operator: 'vector_near', value: [1], vectorQuery: [] }
        ],
        [
            'invalid topK',
            {
                indexer: 'VectorIndexer',
                field: 'text',
                operator: 'vector_near',
                value: [1],
                vectorQuery: { topK: 0 }
            }
        ],
        [
            'invalid metric',
            {
                indexer: 'VectorIndexer',
                field: 'text',
                operator: 'vector_near',
                value: [1],
                vectorQuery: { metric: 'chebyshev' }
            }
        ],
        [
            'invalid threshold',
            {
                indexer: 'VectorIndexer',
                field: 'text',
                operator: 'vector_near',
                value: [1],
                vectorQuery: { threshold: 1.1 }
            }
        ]
    ];

    for (const candidateItems of [[], [{ item_id: 'candidate', item_type: 'file' as const }]]) {
        const storage = new BaseStorage('scoped-vector-validation', fullSchema, tmpDir('scoped-vector-validation'));
        let baseCalls = 0;
        let backendCalls = 0;
        let targetCalls = 0;
        (storage as any).baseIndexer = {
            search: async () => {
                baseCalls++;
                return { items: candidateItems, totalCount: candidateItems.length };
            }
        };
        (storage as any).vectorIndexer = {
            getBackend: () => {
                backendCalls++;
                return 'native';
            },
            search: async (_conditions: unknown, options: any) => {
                targetCalls++;
                assert.deepEqual(options.existingResults, candidateItems);
                return {
                    items: candidateItems,
                    scores: new Map(candidateItems.map((item) => [item.item_id, 0.75])),
                    totalCount: candidateItems.length
                };
            }
        };
        const control = await storage.searchScope({
            preconditions: [{ indexer: 'BaseIndexer', field: 'item_type', operator: '=', value: 'file' }],
            targetCondition: {
                indexer: 'VectorIndexer',
                field: 'text',
                operator: 'vector_near',
                value: [1],
                vectorQuery: { topK: 1 }
            }
        });
        assert.equal(baseCalls, 1);
        assert.equal(backendCalls, 1);
        assert.equal(targetCalls, candidateItems.length === 0 ? 0 : 1);
        assert.deepEqual(
            control.items.map((hit) => hit.item.item_id),
            candidateItems.map((item) => item.item_id)
        );
        baseCalls = 0;
        backendCalls = 0;
        targetCalls = 0;
        for (const [name, targetCondition] of invalidTargets) {
            await assert.rejects(
                () =>
                    storage.searchScope({
                        preconditions: [{ indexer: 'BaseIndexer', field: 'item_type', operator: '=', value: 'file' }],
                        targetCondition
                    }),
                ScopedSearchValidationError,
                `${name} must fail before a ${candidateItems.length === 0 ? 'potentially empty' : 'non-empty'} prefilter`
            );
        }
        assert.equal(baseCalls, 0);
        assert.equal(backendCalls, 0);
        assert.equal(targetCalls, 0);
    }
}

async function testScopedSearchRejectsMalformedPreconditionsBeforeAnyStorageCall(): Promise<void> {
    const malformedPreconditions: Array<[string, unknown]> = [
        ['null', null],
        ['undefined', undefined],
        ['array', []],
        ['string', 'BaseIndexer'],
        ['number', 1]
    ];
    const storage = new BaseStorage(
        'scoped-precondition-validation',
        fullSchema,
        tmpDir('scoped-precondition-validation')
    );
    let baseCalls = 0;
    let backendCalls = 0;
    let vectorCalls = 0;
    let chunkCalls = 0;
    (storage as any).baseIndexer = {
        search: async () => {
            baseCalls++;
            return { items: [{ item_id: 'candidate', item_type: 'file' }], totalCount: 1 };
        }
    };
    (storage as any).vectorIndexer = {
        getBackend: () => {
            backendCalls++;
            return 'native';
        },
        search: async () => {
            vectorCalls++;
            return { items: [], scores: new Map(), totalCount: 0 };
        }
    };
    (storage as any).chunkIndexer = {
        getBackend: () => {
            backendCalls++;
            return 'native';
        },
        searchChunks: async () => {
            chunkCalls++;
            return [];
        }
    };

    for (const [name, malformedPrecondition] of malformedPreconditions) {
        await assert.rejects(
            () =>
                storage.searchScope({
                    preconditions: [malformedPrecondition] as any,
                    targetCondition: {
                        indexer: 'VectorIndexer',
                        field: 'text',
                        operator: 'vector_near',
                        value: [1],
                        vectorQuery: { topK: 1 }
                    }
                }),
            ScopedSearchValidationError,
            `${name} precondition must fail with the scoped search validation error`
        );
        assert.equal(baseCalls, 0, `${name} precondition must not run the Base prefilter`);
        assert.equal(backendCalls, 0, `${name} precondition must not inspect a backend`);
        assert.equal(vectorCalls, 0, `${name} precondition must not run the Vector target`);
        assert.equal(chunkCalls, 0, `${name} precondition must not run the Chunk target`);
    }
}

async function testScopedVectorMergeRejectsInvariantViolations(): Promise<void> {
    const candidateMap = new Map<string, Item>([['a', { item_id: 'a', item_type: 'file' }]]);
    assert.throws(
        () =>
            mergeScopedVectorHits(
                [
                    [{ item: { item_id: 'a', item_type: 'file' }, VecScore: 0.8 }],
                    [{ item: { item_id: 'a', item_type: 'file' }, VecScore: 0.7 }]
                ],
                candidateMap,
                2
            ),
        /duplicate vector hit/
    );
    for (const score of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.throws(
            () =>
                mergeScopedVectorHits(
                    [[{ item: { item_id: 'a', item_type: 'file' }, VecScore: score }]],
                    candidateMap,
                    1
                ),
            /finite VecScore/
        );
    }
}

async function testScopedSearchEmptyAndDiagnostics(): Promise<void> {
    const storage = new BaseStorage('scoped-diagnostics', fullSchema, tmpDir('scoped-diagnostics'));
    let targetCalls = 0;
    let getInfoCalls = 0;
    (storage as any).baseIndexer = { search: async () => ({ items: [], totalCount: 0 }) };
    (storage as any).vectorIndexer = {
        getBackend: () => 'wasm',
        search: async () => {
            targetCalls++;
            return { items: [], totalCount: 0 };
        },
        getInfo: async () => {
            getInfoCalls++;
            return { size: 42 };
        }
    };
    const request = {
        preconditions: [{ indexer: 'BaseIndexer', field: 'item_type', operator: '=' as const, value: 'file' }],
        targetCondition: {
            indexer: 'VectorIndexer',
            field: 'text',
            operator: 'vector_near' as const,
            value: makeOneHotVector(0),
            vectorQuery: { topK: 7 }
        }
    };
    const withoutDiagnostics = await storage.searchScope(request);
    assert.equal(withoutDiagnostics.diagnostics, undefined);
    assert.equal(getInfoCalls, 0);
    const withDiagnostics = await storage.searchScope(request, { collectDiagnostics: true });
    assert.equal(getInfoCalls, 1);
    assert.equal(targetCalls, 0, 'empty candidates must not execute an unfiltered target search');
    assert.equal(withDiagnostics.diagnostics?.totalTargetRows, 42);
    assert.equal(withDiagnostics.diagnostics?.backend, 'wasm');
    assert.equal(withDiagnostics.diagnostics?.strategy, 'ann_overfetch_filter');
    assert.equal(withDiagnostics.diagnostics?.exactBatchCount, 0);
    assert.equal(withDiagnostics.diagnostics?.exactBatchSize, 0);
    assert.equal(withDiagnostics.diagnostics?.targetSearchLatencyMs, 0);
    assert.equal(withDiagnostics.diagnostics?.topK, 7);
}

async function testSemanticBackendCapabilityIsSynchronousAndDoesNotReinitialize(): Promise<void> {
    const vectorDir = tmpDir('vector-backend-capability');
    const chunkDir = tmpDir('chunk-backend-capability');
    const chunkSchema: ColumnSchema = {
        columns: {
            item_id: { type: 'TEXT', nullable: false },
            item_type: { type: 'TEXT', nullable: false },
            chunk_text: { type: 'TEXT', nullable: true }
        },
        needIndexers: { chunk_text: [{ indexer: 'ChunkIndexer', options: { dim: 4 } }] }
    };
    const vectorStorage = new BaseStorage('vector-backend-capability', fullSchema, vectorDir);
    const chunkStorage = new BaseStorage('chunk-backend-capability', chunkSchema, chunkDir);
    try {
        await vectorStorage.initialize();
        await chunkStorage.initialize();
        const vectorIndexer = (vectorStorage as any).vectorIndexer;
        const chunkIndexer = (chunkStorage as any).chunkIndexer;
        let vectorStoredDimCalls = 0;
        let chunkStoredDimCalls = 0;
        vectorIndexer.db.getStoredDim = async () => {
            vectorStoredDimCalls++;
            return 1024;
        };
        chunkIndexer.db.getStoredDim = async () => {
            chunkStoredDimCalls++;
            return 4;
        };

        assert.equal(vectorIndexer.getBackend(), 'native');
        assert.equal(chunkIndexer.getBackend(), 'native');
        assert.equal(vectorStoredDimCalls, 0);
        assert.equal(chunkStoredDimCalls, 0);
    } finally {
        vectorStorage.close();
        chunkStorage.close();
        cleanup(vectorDir);
        cleanup(chunkDir);
    }
}

async function testScopedSearchRejectsMissingOrInvalidBackendCapability(): Promise<void> {
    const storage = new BaseStorage('scoped-backend-contract', fullSchema, tmpDir('scoped-backend-contract'));
    (storage as any).baseIndexer = {
        search: async () => ({ items: [{ item_id: 'inside', item_type: 'file' }], totalCount: 1 })
    };
    const request = {
        preconditions: [{ indexer: 'BaseIndexer', field: 'item_type', operator: '=' as const, value: 'file' }],
        targetCondition: {
            indexer: 'VectorIndexer' as const,
            field: 'text',
            operator: 'vector_near' as const,
            value: makeOneHotVector(0),
            vectorQuery: { topK: 1 }
        }
    };
    (storage as any).vectorIndexer = { search: async () => ({ items: [], scores: new Map(), totalCount: 0 }) };
    await assert.rejects(() => storage.searchScope(request), /VectorIndexer backend capability is missing/);
    (storage as any).vectorIndexer.getBackend = () => 'cuda';
    await assert.rejects(() => storage.searchScope(request), /VectorIndexer backend capability is invalid: cuda/);
}

async function testNativeScopedVectorUsesExactCandidateTopK(): Promise<void> {
    const schema: ColumnSchema = {
        columns: {
            item_id: { type: 'TEXT', nullable: false },
            item_type: { type: 'TEXT', nullable: false },
            filename: { type: 'TEXT', nullable: true }
        },
        needIndexers: { filename: [{ indexer: 'VectorIndexer', options: { dim: 4 } }] }
    };
    const dir = tmpDir('native-scoped-vector');
    const storage = new BaseStorage('native-scoped-vector', schema, dir);
    try {
        await storage.initialize();
        await storage.insert([
            {
                item_id: 'outside',
                item_type: 'file',
                filename: 'outside',
                indexer_columns: { VectorIndexer: [{ column: 'filename', content: [1, 0, 0, 0] }] }
            },
            {
                item_id: 'inside-best',
                item_type: 'file',
                filename: 'inside-best',
                indexer_columns: { VectorIndexer: [{ column: 'filename', content: [0.9, 0.1, 0, 0] }] }
            },
            {
                item_id: 'inside-worse',
                item_type: 'file',
                filename: 'inside-worse',
                indexer_columns: { VectorIndexer: [{ column: 'filename', content: [0, 1, 0, 0] }] }
            }
        ]);
        const result = await storage.searchScope({
            preconditions: [{ indexer: 'BaseIndexer', field: 'filename', operator: 'like', value: 'inside%' }],
            targetCondition: {
                indexer: 'VectorIndexer',
                field: 'filename',
                operator: 'vector_near',
                value: [1, 0, 0, 0],
                vectorQuery: { topK: 1, metric: 'cosine' }
            }
        });
        assert.deepEqual(
            result.items.map((hit) => hit.item.item_id),
            ['inside-best']
        );
        assert.equal(result.items[0].item.filename, 'inside-best');
    } finally {
        storage.close();
        cleanup(dir);
    }
}

async function testNativeScopedVectorRanksAcrossPathUnion(): Promise<void> {
    const schema: ColumnSchema = {
        columns: {
            item_id: { type: 'TEXT', nullable: false },
            item_type: { type: 'TEXT', nullable: false },
            filename: { type: 'TEXT', nullable: true }
        },
        needIndexers: {
            filename: [{ indexer: 'VectorIndexer', options: { dim: 4 } }]
        }
    };
    const dir = tmpDir('native-path-union-vector');
    const storage = new BaseStorage('native-path-union-vector', schema, dir);
    try {
        await storage.initialize();
        await storage.insert([
            {
                item_id: '/outside/global-best.md',
                item_type: 'file',
                filename: 'outside',
                indexer_columns: { VectorIndexer: [{ column: 'filename', content: [1, 0, 0, 0] }] }
            },
            {
                item_id: '/source/a/best.md',
                item_type: 'file',
                filename: 'a-best',
                indexer_columns: { VectorIndexer: [{ column: 'filename', content: [0.99, 0.01, 0, 0] }] }
            },
            {
                item_id: '/source/b/best.md',
                item_type: 'file',
                filename: 'b-best',
                indexer_columns: { VectorIndexer: [{ column: 'filename', content: [0.95, 0.05, 0, 0] }] }
            },
            {
                item_id: '/source/a/lower.md',
                item_type: 'file',
                filename: 'a-lower',
                indexer_columns: { VectorIndexer: [{ column: 'filename', content: [0, 1, 0, 0] }] }
            }
        ]);

        const result = await storage.searchScope({
            preconditions: [
                { indexer: 'BaseIndexer', field: 'item_type', operator: '=', value: 'file' },
                {
                    indexer: 'BaseIndexer',
                    field: 'item_id',
                    operator: 'path_descendant_or_self',
                    value: ['/source/a', '/source/b']
                }
            ],
            targetCondition: {
                indexer: 'VectorIndexer',
                field: 'filename',
                operator: 'vector_near',
                value: [1, 0, 0, 0],
                vectorQuery: { topK: 2, metric: 'cosine' }
            }
        });

        assert.deepEqual(
            result.items.map((item) => item.item.item_id),
            ['/source/a/best.md', '/source/b/best.md']
        );
        assert.equal(
            result.items.some((item) => item.item.item_id.startsWith('/outside/')),
            false
        );
    } finally {
        storage.close();
        cleanup(dir);
    }
}

async function testForcedWasmScopedVectorUsesOneCompleteCandidateCall(): Promise<void> {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    const previousArkData = process.env.ARKDATA_AVAILABLE;
    Object.defineProperty(process, 'platform', { value: 'openharmony', configurable: true });
    delete process.env.ARKDATA_AVAILABLE;
    const schema: ColumnSchema = {
        columns: {
            item_id: { type: 'TEXT', nullable: false },
            item_type: { type: 'TEXT', nullable: false },
            filename: { type: 'TEXT', nullable: true },
            scoped: { type: 'INTEGER', nullable: true }
        },
        needIndexers: { filename: [{ indexer: 'VectorIndexer', options: { dim: 4 } }] }
    };
    const dir = tmpDir('wasm-scoped-vector');
    const storage = new BaseStorage('wasm-scoped-vector', schema, dir);
    try {
        await storage.initialize();
        const candidates = Array.from({ length: 65 }, (_, index) => ({
            item_id: `inside-${index}`,
            item_type: 'file' as const,
            filename: `inside-${index}`,
            scoped: 1,
            indexer_columns: { VectorIndexer: [{ column: 'filename', content: [1, index / 1000, 0, 0] }] }
        }));
        await storage.insert([
            ...candidates,
            {
                item_id: 'outside',
                item_type: 'file',
                filename: 'outside',
                scoped: 0,
                indexer_columns: { VectorIndexer: [{ column: 'filename', content: [1, 0, 0, 0] }] }
            }
        ]);
        const realIndexer = (storage as any).vectorIndexer;
        const realSearch = realIndexer.search.bind(realIndexer);
        const delivered: number[] = [];
        realIndexer.search = async (conditions: unknown, options: any) => {
            delivered.push(options.existingResults.length);
            return realSearch(conditions, options);
        };
        const result = await storage.searchScope(
            {
                preconditions: [{ indexer: 'BaseIndexer', field: 'scoped', operator: '=', value: 1 }],
                targetCondition: {
                    indexer: 'VectorIndexer',
                    field: 'filename',
                    operator: 'vector_near',
                    value: [1, 0, 0, 0],
                    vectorQuery: { topK: 5, metric: 'cosine' }
                }
            },
            { collectDiagnostics: true }
        );
        assert.deepEqual(delivered, [65]);
        assert.equal(result.diagnostics?.strategy, 'ann_overfetch_filter');
        assert(!result.items.some((hit) => hit.item.item_id === 'outside'));
    } finally {
        storage.close();
        cleanup(dir);
        if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
        if (previousArkData === undefined) delete process.env.ARKDATA_AVAILABLE;
        else process.env.ARKDATA_AVAILABLE = previousArkData;
    }
}

async function testArkDataScopedSearchRunsExactBatchesAndFailsWholeTarget(): Promise<void> {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    const previousArkData = process.env.ARKDATA_AVAILABLE;
    Object.defineProperty(process, 'platform', { value: 'openharmony', configurable: true });
    process.env.ARKDATA_AVAILABLE = '1';
    try {
        const candidates = Array.from({ length: 10001 }, (_, index) => ({
            item_id: `item-${String(index).padStart(5, '0')}`,
            item_type: 'file' as const,
            marker: index
        }));
        const storage = new BaseStorage('arkdata-scoped', fullSchema, tmpDir('arkdata-scoped'));
        (storage as any).baseIndexer = { search: async () => ({ items: candidates, totalCount: candidates.length }) };
        const batchSizes: number[] = [];
        (storage as any).vectorIndexer = {
            getBackend: () => 'arkdata',
            search: async (_conditions: unknown, options: any) => {
                batchSizes.push(options.existingResults.length);
                const item = options.existingResults.at(-1);
                return {
                    items: [item],
                    scores: new Map([[item.item_id, item.marker / 10000]]),
                    totalCount: 1
                };
            },
            getInfo: async () => ({ size: 10001 })
        };
        const request = {
            preconditions: [{ indexer: 'BaseIndexer', field: 'item_type', operator: '=' as const, value: 'file' }],
            targetCondition: {
                indexer: 'VectorIndexer',
                field: 'text',
                operator: 'vector_near' as const,
                value: makeOneHotVector(0),
                vectorQuery: { topK: 2 }
            }
        };
        const result = await storage.searchScope(request, { collectDiagnostics: true });
        assert.deepEqual(batchSizes, [5000, 5000, 1]);
        assert.deepEqual(
            result.items.map((hit) => hit.item.marker),
            [10000, 9999]
        );
        assert.equal(result.diagnostics?.backend, 'arkdata');
        assert.equal(result.diagnostics?.strategy, 'exact_in');
        assert.equal(result.diagnostics?.exactBatchSize, 5000);
        assert.equal(result.diagnostics?.exactBatchCount, 3);

        let calls = 0;
        (storage as any).vectorIndexer.search = async () => {
            calls++;
            if (calls === 2) throw new Error('batch failed');
            return { items: [], scores: new Map(), totalCount: 0 };
        };
        await assert.rejects(() => storage.searchScope(request), /batch failed/);
        assert.equal(calls, 2, 'target batches must be sequential and fail fast without partial results');
    } finally {
        if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
        if (previousArkData === undefined) delete process.env.ARKDATA_AVAILABLE;
        else process.env.ARKDATA_AVAILABLE = previousArkData;
    }
}

const SCOPED_SEARCH_PERF_ENABLED = process.env.FILEMGR_SCOPED_SEARCH_PERF === '1';
const SCOPED_SEARCH_PERF_DIM = 32;
const SCOPED_SEARCH_PERF_REQUESTED_K = 10;
const SCOPED_SEARCH_PERF_MEASURED_RUNS = 5;

interface ScopedSearchPerfIteration {
    iteration: number;
    latencyMs: number;
    basePrefilterLatencyMs: number;
    targetSearchLatencyMs: number;
    memoryBeforeRssBytes: number;
    memoryAfterRssBytes: number;
    memoryDeltaRssBytes: number;
    returnedIds: string[];
}

function scopedSearchPerfPercentile(values: number[], percentile: number): number {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)];
}

function scopedSearchPerfVector(rank: number, totalRows: number): number[] {
    const vector = Array(SCOPED_SEARCH_PERF_DIM).fill(0);
    vector[0] = (rank + 1) / totalRows;
    vector[1] = 1;
    return vector;
}

function scopedSearchPerfExpectedIds(totalRows: number, scopeRows: number): string[] {
    return Array.from({ length: SCOPED_SEARCH_PERF_REQUESTED_K }, (_, offset) => {
        const rank = scopeRows - offset - 1;
        return `perf-${totalRows}-${String(rank).padStart(5, '0')}`;
    });
}

function scopedSearchPerfInsertionRanks(totalRows: number): number[] {
    return Array.from({ length: totalRows }, (_, position) => (position * 7919 + 104729) % totalRows);
}

function assertScopedSearchPerfInsertionOrderIsIndependent(
    insertionRanks: number[],
    totalRows: number,
    scopeRows: number
): void {
    const insertionOrderTopK = insertionRanks
        .filter((rank) => rank < scopeRows)
        .slice(-SCOPED_SEARCH_PERF_REQUESTED_K)
        .reverse();
    const semanticTopK = Array.from({ length: SCOPED_SEARCH_PERF_REQUESTED_K }, (_, offset) => scopeRows - offset - 1);
    assert.notDeepEqual(
        insertionOrderTopK,
        semanticTopK,
        `fixture must reject reverse rowid/insertion order: total=${totalRows} scope=${scopeRows}`
    );
}

async function runScopedSearchPerfCase(
    storage: BaseStorage,
    totalRows: number,
    scopeRows: number,
    target: 'vector' | 'chunk'
): Promise<void> {
    const queryVector = Array(SCOPED_SEARCH_PERF_DIM).fill(0);
    queryVector[0] = 1;
    const request = {
        preconditions: [
            { indexer: 'BaseIndexer' as const, field: 'scope_rank', operator: '<=' as const, value: scopeRows - 1 }
        ],
        targetCondition: {
            indexer: target === 'vector' ? ('VectorIndexer' as const) : ('ChunkIndexer' as const),
            field: target === 'vector' ? 'filename' : 'text',
            operator: 'vector_near' as const,
            value: queryVector,
            vectorQuery: { topK: SCOPED_SEARCH_PERF_REQUESTED_K, metric: 'cosine' as const }
        }
    };
    const expectedIds = scopedSearchPerfExpectedIds(totalRows, scopeRows);

    const warmup = await storage.searchScope(request, { collectDiagnostics: true });
    assert.equal(warmup.diagnostics?.backend, 'native', 'benchmark must measure the native backend');
    assert.equal(warmup.diagnostics?.strategy, 'exact_temp', 'native benchmark must use exact candidate filtering');
    assert.deepEqual(
        warmup.items.map((hit) => hit.item.item_id),
        expectedIds,
        `${target} warmup must return the in-scope topK`
    );

    const iterations: ScopedSearchPerfIteration[] = [];
    for (let iteration = 1; iteration <= SCOPED_SEARCH_PERF_MEASURED_RUNS; iteration++) {
        const startedAt = performance.now();
        const result = await storage.searchScope(request, { collectDiagnostics: true });
        const latencyMs = performance.now() - startedAt;
        const returnedIds = result.items.map((hit) => hit.item.item_id);
        assert.deepEqual(returnedIds, expectedIds, `${target} measured run ${iteration} must return the in-scope topK`);
        assert.equal(result.items.length, SCOPED_SEARCH_PERF_REQUESTED_K, `${target} must apply topK inside scope`);
        assert(
            result.items.every((hit) => hit.item.scope_rank < scopeRows),
            `${target} must not return out-of-scope rows`
        );
        const diagnostics = result.diagnostics;
        assert(diagnostics, 'benchmark diagnostics must be collected');
        assert.equal(diagnostics.backend, 'native');
        assert.equal(diagnostics.strategy, 'exact_temp');
        assert.equal(diagnostics.totalTargetRows, totalRows);
        assert.equal(diagnostics.exactCandidateCount, scopeRows);
        iterations.push({
            iteration,
            latencyMs,
            basePrefilterLatencyMs: diagnostics.basePrefilterLatencyMs,
            targetSearchLatencyMs: diagnostics.targetSearchLatencyMs,
            memoryBeforeRssBytes: diagnostics.memoryBeforeRssBytes,
            memoryAfterRssBytes: diagnostics.memoryAfterRssBytes,
            memoryDeltaRssBytes: diagnostics.memoryDeltaRssBytes,
            returnedIds
        });
    }

    const latencies = iterations.map((iteration) => iteration.latencyMs);
    const prefilterLatencies = iterations.map((iteration) => iteration.basePrefilterLatencyMs);
    const targetLatencies = iterations.map((iteration) => iteration.targetSearchLatencyMs);
    console.log(
        `[filemgr-scoped-search-perf] ${JSON.stringify({
            totalRows,
            scopeRows,
            requestedK: SCOPED_SEARCH_PERF_REQUESTED_K,
            target,
            backend: 'native',
            strategy: 'exact_temp',
            warmupRuns: 1,
            measuredRuns: SCOPED_SEARCH_PERF_MEASURED_RUNS,
            p50LatencyMs: scopedSearchPerfPercentile(latencies, 0.5),
            p90LatencyMs: scopedSearchPerfPercentile(latencies, 0.9),
            prefilterP50LatencyMs: scopedSearchPerfPercentile(prefilterLatencies, 0.5),
            prefilterP90LatencyMs: scopedSearchPerfPercentile(prefilterLatencies, 0.9),
            targetP50LatencyMs: scopedSearchPerfPercentile(targetLatencies, 0.5),
            targetP90LatencyMs: scopedSearchPerfPercentile(targetLatencies, 0.9),
            peakMemoryAfterRssBytes: Math.max(...iterations.map((iteration) => iteration.memoryAfterRssBytes)),
            peakMemoryDeltaRssBytes: Math.max(...iterations.map((iteration) => iteration.memoryDeltaRssBytes)),
            returnedIds: expectedIds,
            iterations
        })}`
    );
}

async function runScopedSearchNativeBenchmark(): Promise<void> {
    if (!SCOPED_SEARCH_PERF_ENABLED) return;

    const schema: ColumnSchema = {
        columns: {
            item_id: { type: 'TEXT', nullable: false },
            item_type: { type: 'TEXT', nullable: false },
            filename: { type: 'TEXT', nullable: true },
            text: { type: 'TEXT', nullable: true },
            scope_rank: { type: 'INTEGER', nullable: false }
        },
        needIndexers: {
            filename: [{ indexer: 'VectorIndexer', options: { dim: SCOPED_SEARCH_PERF_DIM } }],
            text: [{ indexer: 'ChunkIndexer', options: { dim: SCOPED_SEARCH_PERF_DIM } }]
        }
    };
    const matrix = [
        { totalRows: 10000, scopeRows: [100, 1000, 5000, 10000] },
        { totalRows: 20000, scopeRows: [1000, 10000] }
    ];

    for (const fixture of matrix) {
        const dir = tmpDir(`scoped-perf-${fixture.totalRows}`);
        let storage: BaseStorage | undefined;
        try {
            storage = new BaseStorage(`scoped-perf-${fixture.totalRows}`, schema, dir);
            await storage.initialize();
            const insertionRanks = scopedSearchPerfInsertionRanks(fixture.totalRows);
            assert.equal(
                new Set(insertionRanks).size,
                fixture.totalRows,
                'fixture insertion ranks must be a permutation'
            );
            for (const scopeRows of fixture.scopeRows) {
                assertScopedSearchPerfInsertionOrderIsIndependent(insertionRanks, fixture.totalRows, scopeRows);
            }
            for (let start = 0; start < fixture.totalRows; start += 500) {
                const items = Array.from({ length: Math.min(500, fixture.totalRows - start) }, (_, offset) => {
                    const rank = insertionRanks[start + offset];
                    const itemId = `perf-${fixture.totalRows}-${String(rank).padStart(5, '0')}`;
                    const vector = scopedSearchPerfVector(rank, fixture.totalRows);
                    return {
                        item_id: itemId,
                        item_type: 'file' as const,
                        filename: `${itemId}.txt`,
                        text: `benchmark chunk ${rank}`,
                        scope_rank: rank,
                        indexer_columns: {
                            VectorIndexer: [{ column: 'filename', content: vector }],
                            ChunkIndexer: [
                                {
                                    column: 'text',
                                    id: `chunk-${rank}`,
                                    text: `benchmark chunk ${rank}`,
                                    content: vector
                                }
                            ]
                        }
                    };
                });
                await storage.insert(items);
            }
            for (const scopeRows of fixture.scopeRows) {
                await runScopedSearchPerfCase(storage, fixture.totalRows, scopeRows, 'vector');
                await runScopedSearchPerfCase(storage, fixture.totalRows, scopeRows, 'chunk');
            }
        } finally {
            storage?.close();
            cleanup(dir);
        }
    }
}

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
        testScopedSearchValidationAndVectorBatching,
        testScopedVectorTargetValidationPrecedesBasePrefilter,
        testScopedSearchRejectsMalformedPreconditionsBeforeAnyStorageCall,
        testScopedVectorMergeRejectsInvariantViolations,
        testScopedSearchEmptyAndDiagnostics,
        testSemanticBackendCapabilityIsSynchronousAndDoesNotReinitialize,
        testScopedSearchRejectsMissingOrInvalidBackendCapability,
        testNativeScopedVectorUsesExactCandidateTopK,
        testNativeScopedVectorRanksAcrossPathUnion,
        testForcedWasmScopedVectorUsesOneCompleteCandidateCall,
        testArkDataScopedSearchRunsExactBatchesAndFailsWholeTarget,
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

    try {
        await runScopedSearchNativeBenchmark();
    } catch (e: any) {
        console.error(`  FAIL runScopedSearchNativeBenchmark: ${e.message}`);
        failed++;
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
