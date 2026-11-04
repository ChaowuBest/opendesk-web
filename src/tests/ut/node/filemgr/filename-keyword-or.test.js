import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BaseStorage } from '../../../../main/services/storage/abstract-storage.js';
import { BaseIndexDBWasm } from '../../../../main/services/storage/base-index-db-wasm.js';
import { FSStorage, makeSchema } from '../../../../main/applications/filemgr/storage.js';
import {
    createIndexedSearchContext,
    mergeSearchRoutes,
    rankSearchResults
} from '../../../../main/applications/filemgr/search/indexed.js';

test('native: filename matching skips files outside the scope or visibility filters', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'filename-filter-cost-'));
    const storage = new BaseStorage('filename-filter-cost', makeSchema(2, { mode: 'base-only' }), directory);
    const matcher = new Database(':memory:');
    try {
        await storage.initialize();
        await storage.insert(
            [
                { item_id: '/docs/a', ref_count: 1, type: 'file' },
                { item_id: '/docs/b', ref_count: 1, type: 'file' },
                { item_id: '/docs/hidden', ref_count: 0, type: 'file' },
                { item_id: '/docs/directory', ref_count: 1, type: 'directory' },
                ...Array.from({ length: 30 }, (_, i) => ({ item_id: `/other/${i}`, ref_count: 1, type: 'file' }))
            ].map((row, modified) => ({ ...row, item_type: 'file', filename: 'unrelated.txt', modified, size: 1 }))
        );
        // Delegate matching to SQLite itself; count only filename predicates, not scope predicates.
        const match = matcher.prepare('SELECT ? LIKE ? ESCAPE ? AS matched');
        let filenameChecks = 0;
        storage.baseIndexer.db.db.function('like', { deterministic: true }, (pattern, value, escape) => {
            if (pattern === '%missingA%' || pattern === '%missingB%') filenameChecks++;
            return match.get(value, pattern, escape).matched;
        });
        const result = await FSStorage.prototype.searchIndexedFilesByKeyword.call({ storage }, 'missingA missingB', {
            terms: ['missingA', 'missingB'],
            scope: { type: 'path', path: '/docs' }
        });
        assert.deepEqual(result, []);
        // Two eligible files × two terms × the existing search and count statements.
        assert.equal(filenameChecks, 8);
    } finally {
        await storage.close();
        matcher.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

for (const backend of ['native', 'wasm']) {
    test(`${backend}: filename OR treats percent, underscore and backslash as literal characters`, async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'filename-literal-'));
        const schema = makeSchema(2, { mode: 'base-only' });
        const storage = new BaseStorage('filename-literal', schema, directory);
        try {
            await storage.initialize();
            if (backend === 'wasm') {
                await storage.baseIndexer.db.close();
                storage.baseIndexer.db = new BaseIndexDBWasm(path.join(directory, 'wasm.db'), schema);
            }
            const names = [
                '100%.txt',
                '100A.txt',
                'invoice_2026.txt',
                'invoiceX2026.txt',
                String.raw`literal\name.txt`,
                '报告.txt'
            ];
            await storage.insert(
                [
                    ...names.map((filename, i) => ({
                        item_id: `/docs/${filename}`,
                        filename,
                        modified: 10 - i,
                        ref_count: 1
                    })),
                    { item_id: '/docs/hidden_%.txt', filename: 'hidden_%.txt', modified: 100, ref_count: 0 },
                    { item_id: '/docs-next/outside_%.txt', filename: 'outside_%.txt', modified: 200, ref_count: 1 }
                ].map((row) => ({ ...row, item_type: 'file', type: 'file', size: 1, root_refs: '["/docs"]' }))
            );
            const owner = { storage };
            const search = (query, options = {}) => {
                const context = createIndexedSearchContext(query);
                return FSStorage.prototype.searchIndexedFilesByKeyword.call(owner, context.query, {
                    terms: context.keywordTerms,
                    scope: { type: 'path', path: '/docs' },
                    ...options
                });
            };
            for (const [query, expected] of [
                ['% 报告', ['100%.txt', '报告.txt']],
                ['_ 报告', ['invoice_2026.txt', '报告.txt']],
                ['\\ 报告', [String.raw`literal\name.txt`, '报告.txt']],
                ['100%', ['100%.txt']],
                ['invoice_', ['invoice_2026.txt']],
                ['%;%', ['100%.txt']]
            ]) {
                assert.deepEqual(
                    (await search(query)).map((row) => row.filename),
                    expected,
                    query
                );
            }
            assert.deepEqual(
                (await search('% 报告', { limit: 1 })).map((row) => row.filename),
                ['100%.txt']
            );
            const legacy = await FSStorage.prototype.searchFilesByKeyword.call(
                { storage, searchIndexedFilesByKeyword: FSStorage.prototype.searchIndexedFilesByKeyword },
                '100_'
            );
            assert.deepEqual(
                legacy.map((row) => row.filename),
                ['100%.txt', '100A.txt']
            );
            assert.deepEqual(await search('100_'), []);

            assert.deepEqual(
                (await search('% 报告', { scope: undefined })).map((row) => row.filename),
                ['outside_%.txt', '100%.txt', '报告.txt']
            );
        } finally {
            await storage.close();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    test(`${backend}: filename OR search preserves scope, limit, rank and single-character terms`, async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'filename-or-'));
        const schema = makeSchema(2, { mode: 'base-only' });
        const storage = new BaseStorage('filename', schema, directory);
        try {
            await storage.initialize();
            if (backend === 'wasm') {
                await storage.baseIndexer.db.close();
                storage.baseIndexer.db = new BaseIndexDBWasm(path.join(directory, 'wasm.db'), schema);
            }
            const entries = [
                ['/docs/文件系统设计.txt', 30, 1],
                ['/docs/内存管理.txt', 20, 1],
                ['/docs/文件系统内存.txt', 10, 1],
                ['/docs/其他.txt', 100, 1],
                ['/docs/A手册.txt', 3, 1],
                ['/docs/1号.txt', 2, 1],
                ['/docs/内存隐藏.txt', 200, 0],
                ['/docs-next/内存.txt', 300, 1]
            ].map(([item_id, modified, ref_count]) => ({
                item_id,
                item_type: 'file',
                type: 'file',
                filename: path.basename(item_id),
                modified,
                ref_count,
                size: 1,
                root_refs: '["/docs"]'
            }));
            await storage.insert(entries);
            const owner = { storage };
            const scope = { type: 'path', path: '/docs' };
            let queryCount = 0;
            const originalSearch = storage.search.bind(storage);
            storage.search = (...args) => {
                queryCount++;
                return originalSearch(...args);
            };
            const search = (query, options = {}) => {
                const context = createIndexedSearchContext(query);
                return FSStorage.prototype.searchIndexedFilesByKeyword.call(owner, context.query, {
                    terms: context.keywordTerms,
                    scope,
                    ...options
                });
            };
            const keyword = await search('文件系统 内存');
            assert.equal(queryCount, 1, 'OR is executed as one storage query');
            assert.deepEqual(
                keyword.map((r) => r.filename),
                ['文件系统设计.txt', '内存管理.txt', '文件系统内存.txt']
            );
            assert.deepEqual(
                (await search('文件系统 内存', { limit: 2 })).map((r) => r.filename),
                ['文件系统设计.txt', '内存管理.txt']
            );
            assert.deepEqual(
                (await search('文件系统；文件系统')).map((r) => r.filename),
                ['文件系统设计.txt', '文件系统内存.txt']
            );
            assert.deepEqual(
                (await search('A 1')).map((r) => r.filename),
                ['A手册.txt', '1号.txt']
            );
            assert.deepEqual(
                (await search('1；1')).map((r) => r.filename),
                ['1号.txt']
            );
            assert.deepEqual(
                (await search('A；')).map((r) => r.filename),
                ['A手册.txt']
            );
            assert.deepEqual(
                (await search('missing absent')).map((r) => r.filename),
                []
            );
            const multiple = await search('文件系统 内存', {
                scope: { type: 'paths', paths: ['/docs', '/docs-next'] }
            });
            assert.equal(multiple.length, 4);
            assert.equal(multiple[0].path, '/docs-next/内存.txt');
            const unscoped = await search('文件系统 内存', { scope: undefined });
            assert.equal(unscoped.length, 4);
            assert.equal(
                unscoped.some((row) => row.filename === '内存隐藏.txt'),
                false
            );
            assert.deepEqual(
                unscoped.map((row) => row.path),
                multiple.map((row) => row.path)
            );

            // The legacy literal-name API and other routes retain their existing semantics.
            const literal = await FSStorage.prototype.searchIndexedFilesByKeyword.call(owner, '文件系统 内存', {
                scope
            });
            assert.deepEqual(literal, []);
            const ranked = rankSearchResults(
                mergeSearchRoutes({
                    keyword,
                    nameSemantic: [
                        { path: '/docs/其他.txt', filename: '其他.txt', semanticScore: 0.9 },
                        { ...keyword[0], semanticScore: 0.8 }
                    ]
                })
            );
            assert.equal(ranked[0].filename, '文件系统设计.txt');
            assert.deepEqual(ranked[0].matchTypes, ['keyword', 'name_semantic']);
            assert.equal(ranked.at(-1).filename, '其他.txt');
        } finally {
            await storage.close();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
}
