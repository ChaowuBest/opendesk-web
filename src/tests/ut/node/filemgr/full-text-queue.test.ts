import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FSStorage } from '../../../../main/applications/filemgr/storage.js';

async function fixture(t: TestContext, algorithm: 'bm25' | 'embedding', count: number, sources = 1) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-build-'));
    const owner = new FSStorage(directory);
    await owner.initialize({ syncEmbedding: false });
    t.after(async () => {
        await owner.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const roots = Array.from({ length: sources }, (_, i) => path.join(directory, `source-${i}`));
    const rows = Array.from({ length: count }, (_, i) => {
        const root = roots[i % sources];
        fs.mkdirSync(root, { recursive: true });
        const file = path.join(root, `${String(i).padStart(5, '0')}.txt`);
        fs.writeFileSync(file, '');
        const stat = fs.statSync(file);
        return {
            item_id: file,
            item_type: 'file',
            type: 'file',
            ext: '.txt',
            filename: path.basename(file),
            modified: Math.floor(stat.mtimeMs),
            size: 0,
            root_refs: JSON.stringify([root]),
            ref_count: 1,
            embedded: 0,
            embedding_generation: owner.scannerState.embedding_generation,
            bm25: 0,
            bm25_generation: owner.scannerState.bm25_generation
        };
    });
    await owner.storage.upsert(rows, { indexers: ['BaseIndexer'] });
    const built: string[] = [];
    if (algorithm === 'embedding') {
        const rules = owner.retrieval.getFileRules();
        t.mock.method(owner.retrieval, 'getFileRules', () => ({
            ...rules,
            canBuild: () => true,
            pendingConditions: (state: number) => [
                { indexer: 'BaseIndexer', field: 'embedded', operator: '=', value: state }
            ]
        }));
        t.mock.method(owner.retrieval, 'buildStep', async (row: any) => {
            built.push(row.item_id);
            await owner.storage.update([{ ...row, embedded: 1 }], { indexers: ['BaseIndexer'] });
            return { kind: 'completed' };
        });
    } else {
        const update = owner.storage.update.bind(owner.storage);
        t.mock.method(owner.storage, 'update', async (items: any[], options: any) => {
            built.push(...items.filter((row) => row.bm25 === 1).map((row) => row.item_id));
            return update(items, options);
        });
    }
    const queries: any[] = [];
    const search = owner.storage.search.bind(owner.storage);
    t.mock.method(owner.storage, 'search', async (conditions: any[], options: any) => {
        if (conditions.some((c) => ['bm25', 'bm25_generation', 'embedded'].includes(c.field))) {
            assert.equal(options?.limit, undefined, 'R01 rollback must fetch the complete priority group');
            assert.equal(options?.offset, undefined);
            queries.push({ conditions, options });
        }
        return search(conditions, options);
    });
    const run = (yielding = () => false, options: any = {}) =>
        algorithm === 'bm25'
            ? owner.processFullTextQueue(yielding, { activeRoots: roots, ...options })
            : owner.processEmbeddingQueue(yielding, { activeRoots: roots, ...options });
    return { directory, owner, roots, rows, built, queries, run };
}

for (const algorithm of ['bm25', 'embedding'] as const) {
    const prefetchLimit = algorithm === 'bm25' ? 10000 : 500;
    test(`R01/R02 ${algorithm}: full group queries retain a shared bounded cache and drain all files`, async (t) => {
        const f = await fixture(t, algorithm, 613);
        await f.run();
        assert.equal(f.built.length, 613);
        assert.equal(new Set(f.built).size, 613);
        assert.ok(f.queries.length < 15, 'prefetched rows must be consumed before rereading candidates');
    });
    test(`R01/R02 ${algorithm}: ten sources share ${prefetchLimit} cached slots and preserve weighted ownership`, async (t) => {
        const f = await fixture(t, algorithm, 710, 10);
        const create = (f.owner as any)._createBuildCandidateQueue.bind(f.owner);
        t.mock.method(f.owner as any, '_createBuildCandidateQueue', (...args: any[]) => {
            const queue = create(...args);
            const next = queue.next;
            queue.next = async () => {
                const rows = await next();
                assert.ok(queue.buffer.length + rows.length <= prefetchLimit);
                assert.ok(rows.length <= 50);
                return rows;
            };
            return queue;
        });
        const shared = f.rows[0];
        await f.owner.storage.update([{ ...shared, root_refs: JSON.stringify([f.roots[1], f.roots[0]]) }], {
            indexers: ['BaseIndexer']
        });
        await f.run(() => false, { currentWorkspace: f.roots[1] });
        assert.equal(f.built.length, 710);
        assert.equal(new Set(f.built).size, 710);
        const first = f.built.slice(0, 11);
        const refs = (id: string) =>
            id === shared.item_id
                ? [f.roots[1], f.roots[0]]
                : JSON.parse(f.rows.find((r) => r.item_id === id)!.root_refs);
        const assigned = first.map((id) => (refs(id).includes(f.roots[1]) ? f.roots[1] : refs(id)[0]));
        assert.deepEqual(assigned, [f.roots[1], f.roots[1], f.roots[0], ...f.roots.slice(2)]);
    });
    test(`R01/R02 ${algorithm}: inactive roots in the complete group cannot hide runnable roots or retries`, async (t) => {
        const f = await fixture(t, algorithm, 525, 2);
        await f.run(() => false, { activeRoots: [f.roots[1]], limit: 20 });
        assert.equal(f.built.length, 262);
        assert.ok(f.built.every((id) => id.startsWith(f.roots[1] + '/')));
    });
    test(`R01/R02 ${algorithm}: generic callers keep the cache bounded and never mix priority groups`, async (t) => {
        const f = await fixture(t, algorithm, 24);
        const state = algorithm === 'bm25' ? 'bm25' : 'embedded';
        await f.owner.storage.update(
            f.rows.slice(20).map((row) => ({ ...row, [state]: -1 })),
            { indexers: ['BaseIndexer'] }
        );
        const create = (f.owner as any)._createBuildCandidateQueue.bind(f.owner);
        const sizes: number[] = [];
        t.mock.method(f.owner as any, '_createBuildCandidateQueue', (...args: any[]) => {
            const queue = create(...args);
            const next = queue.next;
            queue.next = async () => {
                const selected = await next();
                sizes.push(selected.length);
                return selected;
            };
            return queue;
        });
        await f.run(() => false, { activeRoots: [] });
        assert.deepEqual(sizes, [20, 4, 0]);
        assert.equal(f.built.length, 24);
    });
    for (const change of ['yield', 'holder', 'generation'] as const) {
        test(`R01/R02 ${algorithm}: ${change} invalidates prefetched work before the next file`, async (t) => {
            const f = await fixture(t, algorithm, 64);
            let yielding = false;
            const search = f.owner.storage.search.bind(f.owner.storage);
            const holder = f.owner.storage;
            t.mock.method(holder, 'search', async (...args: any[]) => {
                const result = await search(...args);
                if (change === 'yield') yielding = true;
                if (change === 'holder') f.owner.storage = null;
                if (change === 'generation')
                    f.owner.scannerState[algorithm === 'bm25' ? 'bm25_generation' : 'embedding_generation']++;
                return result;
            });
            try {
                await f.run(() => yielding);
                assert.equal(f.built.length, 0);
            } finally {
                f.owner.storage = holder;
            }
        });
    }
}

test('R01/R02 BM25: skipped first page is exhausted before switching to old/retry groups', async (t) => {
    const f = await fixture(t, 'bm25', 526);
    for (const row of f.rows.slice(0, 520)) fs.unlinkSync(row.item_id);
    await f.owner.storage.update(
        [{ ...f.rows[525], bm25: -1, bm25_generation: f.owner.scannerState.bm25_generation }],
        { indexers: ['BaseIndexer'] }
    );
    await f.run();
    assert.deepEqual(
        f.built,
        f.rows.slice(520).map((row) => row.item_id)
    );
});

for (const algorithm of ['bm25', 'embedding'] as const) {
    test(`R02 ${algorithm}: prefetch capacity is independent of the per-batch limit`, async (t) => {
        const f = await fixture(t, algorithm, 163, 3);
        const create = (f.owner as any)._createBuildCandidateQueue.bind(f.owner);
        const batchSizes: number[] = [];
        t.mock.method(
            f.owner as any,
            '_createBuildCandidateQueue',
            (holder: any, groups: any, options: any, current: any) => {
                assert.equal(options.prefetchLimit, algorithm === 'bm25' ? 10000 : 500);
                const queue = create(holder, groups, { ...options, prefetchLimit: 73 }, current);
                const next = queue.next;
                queue.next = async () => {
                    const rows = await next();
                    assert.ok(rows.length <= 10);
                    assert.ok(rows.length + queue.buffer.length <= 73);
                    if (rows.length) batchSizes.push(rows.length);
                    return rows;
                };
                return queue;
            }
        );
        await f.run(() => false, { limit: 10 });
        assert.equal(f.built.length, 163);
        assert.equal(new Set(f.built).size, 163);
        assert.ok(f.queries.length < batchSizes.length, 'consume retained cache before fetching again');
    });

    test(`R02 ${algorithm}: source-clustered input is scheduled before retaining the cache`, async (t) => {
        const f = await fixture(t, algorithm, 140, 2);
        // The first seventy returned records all belong to source0. Both sources must still be selected.
        const search = f.owner.storage.search.bind(f.owner.storage);
        t.mock.method(f.owner.storage, 'search', async (...args: any[]) => {
            const result = await search(...args);
            result.items.sort((a: any, b: any) =>
                JSON.parse(a.item.root_refs)[0].localeCompare(JSON.parse(b.item.root_refs)[0])
            );
            return result;
        });
        const create = (f.owner as any)._createBuildCandidateQueue.bind(f.owner);
        t.mock.method(
            f.owner as any,
            '_createBuildCandidateQueue',
            (holder: any, groups: any, options: any, current: any) =>
                create(holder, groups, { ...options, prefetchLimit: 50 }, current)
        );
        await f.run(() => false);
        const first = f.built.slice(0, 50);
        assert.equal(
            first.filter((id) => JSON.parse(f.rows.find((r) => r.item_id === id)!.root_refs)[0] === f.roots[0]).length,
            25
        );
        assert.equal(
            first.filter((id) => JSON.parse(f.rows.find((r) => r.item_id === id)!.root_refs)[0] === f.roots[1]).length,
            25
        );
        assert.equal(new Set(f.built).size, 140);
    });
}

test('R02 BM25 entry retains at most 10000 candidates across ten sources', async (t) => {
    const f = await fixture(t, 'bm25', 0, 10);
    const items = Array.from({ length: 10137 }, (_, i) => ({
        item: {
            item_id: path.join(f.roots[i % f.roots.length], `${i}.txt`),
            root_refs: JSON.stringify([f.roots[i % f.roots.length]])
        }
    }));
    let stop = false;
    let reads = 0;
    let retained = 0;
    const create = (f.owner as any)._createBuildCandidateQueue.bind(f.owner);
    t.mock.method(
        f.owner as any,
        '_createBuildCandidateQueue',
        (_holder: any, groups: any, options: any, current: any) => {
            assert.equal(options.prefetchLimit, 10000);
            const queue = create(
                {
                    search: async (_conditions: any, sqlOptions?: any) => {
                        assert.equal(sqlOptions, undefined);
                        reads++;
                        return { items };
                    }
                },
                groups,
                options,
                current
            );
            const next = queue.next.bind(queue);
            queue.next = async () => {
                const selected = await next();
                assert.equal(selected.length, 50);
                retained = selected.length + queue.buffer.length;
                stop = true;
                return selected;
            };
            return queue;
        }
    );
    const result = await f.run(() => stop);
    assert.deepEqual(result, { outcome: 'yielded', processed: 0 });
    assert.equal(reads, 1);
    assert.equal(retained, 10000);
});
for (const algorithm of ['bm25', 'embedding'] as const) {
    test(`R02 ${algorithm}: every fifty-file batch preserves workspace weights throughout one cache`, async (t) => {
        const f = await fixture(t, algorithm, 1100, 10);
        await f.run(() => f.built.length >= 500, { currentWorkspace: f.roots[1] });
        assert.equal(f.built.length, 500);
        assert.equal(f.queries.length, 1, 'the complete priority group is fetched once for all ten batches');
        for (let offset = 0; offset < 500; offset += 50) {
            const counts = new Map(f.roots.map((root) => [root, 0]));
            for (const id of f.built.slice(offset, offset + 50)) {
                const root = JSON.parse(f.rows.find((row) => row.item_id === id)!.root_refs)[0];
                counts.set(root, counts.get(root)! + 1);
            }
            assert.deepEqual(
                f.roots.map((root) => counts.get(root)),
                [5, 10, 5, 5, 5, 4, 4, 4, 4, 4]
            );
        }
    });
}
