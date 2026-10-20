import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Setting, setCustomOpendeskDirectory } from '../../../../main/utils/setting.js';
import { LLM } from '../../../../main/aikernel/llm.js';

const { BaseStorage } = await import('../../../../main/services/storage/abstract-storage.js');
const { FSStorage, makeSchema } = await import('../../../../main/applications/filemgr/storage.js');
const { default: FileManagerWorker } = await import('../../../../main/applications/filemgr/worker.js');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'filemgr-search-transition-'));
setCustomOpendeskDirectory(profile);
after(() => fs.rmSync(profile, { recursive: true, force: true }));
const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
};
for (const route of ['name', 'content'])
    for (const stage of ['embedding', 'rerank'])
        test(`${route}: model transition during ${stage} cannot publish a mismatched result`, async (t) => {
            const directory = fs.mkdtempSync(path.join(profile, route + '-' + stage + '-'));
            const entered = deferred(),
                resume = deferred();
            let model = 'model-a',
                blocked = false;
            t.mock.method(Setting, 'getInstance', () => ({
                getDefaultEmbeddingModelInstance: () => ({ model_name: model }),
                getData: () => ({})
            }));
            t.mock.method(LLM, 'embed', async () => {
                const chosen = model;
                if (stage === 'embedding' && !blocked) {
                    blocked = true;
                    entered.resolve();
                    await resume.promise;
                }
                return chosen === 'model-a' ? [0, 1] : [1, 0];
            });
            t.mock.method(LLM, 'rerank', async (_q: string, items: any[]) => {
                if (stage === 'rerank' && !blocked) {
                    blocked = true;
                    entered.resolve();
                    await resume.promise;
                }
                return items;
            });
            const owner = new FSStorage(directory);
            owner.storage = new BaseStorage('filemgr', makeSchema(2), owner._storageDir);
            owner.mode = 'full';
            Object.assign(owner.scannerState, {
                embedding_model: model,
                vec_dim: 2,
                chunk_level: 'structured',
                vector_backend: 'native',
                chunk_backend: 'native',
                embedding_generation: 0,
                embedded_migrated: true,
                _migratedRefCount: true
            });
            // 对齐产品路径约定：item_id 来自 fast-glob、root 经 renderer normalizePath，Windows 上均为正斜杠
            const root = path.join(directory, 'files').replace(/\\/g, '/');
            fs.mkdirSync(root);
            const oldFile = `${root}/old-a.md`,
                newFile = `${root}/current-b.md`;
            fs.writeFileSync(oldFile, 'old model A text');
            fs.writeFileSync(newFile, 'current model B text');
            const row = (file: string, id: string, text: string, generation: number) => ({
                item_id: file,
                item_type: 'file',
                type: 'file',
                filename: path.basename(file),
                root_refs: JSON.stringify([root]),
                ref_count: 1,
                embedded: 1,
                embedding_generation: generation,
                indexer_columns: {
                    VectorIndexer: [{ column: 'filename', content: [0, 1] }],
                    ChunkIndexer: [{ column: 'chunk_text', id, text, content: [0, 1] }]
                }
            });
            let query: Promise<any> | undefined;
            try {
                await owner.storage.initialize();
                await owner.storage.upsert([row(oldFile, 'obsolete-a', 'old model A text', 0)]);
                await owner.saveScannerState();
                query =
                    route === 'name'
                        ? owner.searchFileByName('query', { topK: 10 })
                        : owner.searchIndexedChunks('query', { topK: 10 });
                await entered.promise;
                model = 'model-b';
                await owner._resetVectorChunk('embedding_config_changed', {
                    dim: 2,
                    mode: 'full',
                    embeddingState: {
                        embedding_model: model,
                        vec_dim: 2,
                        chunk_level: 'structured',
                        vector_backend: 'native',
                        chunk_backend: 'native'
                    }
                });
                await owner.storage.upsert([
                    row(newFile, 'current-b', 'current model B text', owner.scannerState.embedding_generation)
                ]);
                const seen: any[] = [];
                const storage = owner.storage,
                    search = storage.search.bind(storage);
                storage.search = async (conditions: any[], ...rest: any[]) => {
                    const semantic = conditions.find((c) => c.vectorQuery);
                    if (semantic) seen.push(semantic.value);
                    return search(conditions, ...rest);
                };
                resume.resolve();
                const result = await query;
                console.log(
                    JSON.stringify({
                        route,
                        stage,
                        generation: owner.scannerState.embedding_generation,
                        seen,
                        code: result.code,
                        results: result.results
                    })
                );
                if (stage === 'embedding')
                    assert.equal(
                        seen.some((v) => JSON.stringify(v) === '[0,1]'),
                        false,
                        'A query embedding from model A cannot be applied to the new model B storage'
                    );
                else
                    assert.equal(
                        result.results.some((hit: any) => hit.path === oldFile || hit.source?.path === oldFile),
                        false,
                        'Results computed before reset cannot be returned as current after model B is committed'
                    );
            } finally {
                resume.resolve();
                await query?.catch(() => {});
                await owner.close();
            }
        });
for (const stage of [
    'between-routes',
    'final-filter',
    'promotion-between-routes',
    'final-close',
    'keyword-close',
    'between-routes-close'
])
    test(`production aggregate: transition during ${stage} discards obsolete semantic routes and preserves keyword`, async (t) => {
        const directory = fs.mkdtempSync(path.join(profile, stage + '-')),
            root = path.join(directory, 'files').replace(/\\/g, '/');
        fs.mkdirSync(root);
        const oldFile = `${root}/old-a.md`,
            keywordFile = `${root}/query-keyword.md`;
        fs.writeFileSync(oldFile, 'obsolete model A');
        fs.writeFileSync(keywordFile, 'keyword file');
        const entered = deferred(),
            resume = deferred();
        let model = 'model-a',
            blocked = false;
        t.mock.method(Setting, 'getInstance', () => ({
            getDefaultEmbeddingModelInstance: () => ({ model_name: model }),
            getData: () => ({})
        }));
        t.mock.method(LLM, 'embed', async () => [0, 1]);
        t.mock.method(LLM, 'rerank', async (_q: string, items: any[]) => items);
        const owner = new FSStorage(directory);
        owner.storage = new BaseStorage('filemgr', makeSchema(2), owner._storageDir);
        owner.mode = 'full';
        Object.assign(owner.scannerState, {
            embedding_model: model,
            vec_dim: 2,
            chunk_level: 'structured',
            vector_backend: 'native',
            chunk_backend: 'native',
            embedding_generation: 0,
            embedded_migrated: true,
            _migratedRefCount: true
        });
        const worker = new FileManagerWorker('filemgr', directory);
        worker.storage = owner;
        worker.status = 'idle';
        worker.config = { entries: [{ root, include_patterns: ['**/*'], exclude_patterns: [] }] };
        let query: Promise<any> | undefined;
        try {
            await owner.storage.initialize();
            await owner.storage.upsert([
                {
                    item_id: oldFile,
                    item_type: 'file',
                    type: 'file',
                    filename: 'old-a.md',
                    root_refs: JSON.stringify([root]),
                    ref_count: 1,
                    embedded: 1,
                    embedding_generation: 0,
                    indexer_columns: {
                        VectorIndexer: [{ column: 'filename', content: [0, 1] }],
                        ChunkIndexer: [
                            { column: 'chunk_text', id: 'obsolete-a', text: 'obsolete model A', content: [0, 1] }
                        ]
                    }
                }
            ]);
            await owner.storage.upsert(
                [
                    {
                        item_id: keywordFile,
                        item_type: 'file',
                        type: 'file',
                        filename: 'query-keyword.md',
                        root_refs: JSON.stringify([root]),
                        ref_count: 1,
                        embedded: 0,
                        embedding_generation: 0
                    }
                ],
                { indexers: ['BaseIndexer'] }
            );
            await owner.saveScannerState();
            if (stage === 'promotion-between-routes') {
                await owner._demoteToBaseOnly('fixture before search');
                const keyword = worker._runKeywordRoute.bind(worker);
                t.mock.method(worker, '_runKeywordRoute', async (context: any) => {
                    const result = await keyword(context);
                    await owner._openFull(2);
                    return result;
                });
            }
            const method =
                    stage === 'keyword-close'
                        ? '_runKeywordRoute'
                        : stage.includes('between-routes')
                          ? '_runContentSemanticRoute'
                          : '_statFileForSearch',
                original = worker[method].bind(worker);
            t.mock.method(worker, method, async (...args: any[]) => {
                if (stage === 'keyword-close') {
                    const result = await original(...args);
                    entered.resolve();
                    await resume.promise;
                    return result;
                }
                if (!blocked) {
                    blocked = true;
                    entered.resolve();
                    await resume.promise;
                }
                return original(...args);
            });
            query = worker.searchIndexedFiles('query', { topK: 10 });
            await entered.promise;
            if (stage.endsWith('close')) await worker.finalize();
            else {
                model = 'model-b';
                await owner._resetVectorChunk('embedding_config_changed', {
                    dim: 2,
                    mode: 'full',
                    embeddingState: {
                        embedding_model: model,
                        vec_dim: 2,
                        chunk_level: 'structured',
                        vector_backend: 'native',
                        chunk_backend: 'native'
                    }
                });
            }
            resume.resolve();
            const result = await query;
            console.log(JSON.stringify({ aggregate: stage, code: result.code, results: result.results }));
            assert.equal(
                result.results.some((hit: any) => hit.path === oldFile),
                false,
                'An obsolete semantic route cannot survive a completed generation change in the final aggregate'
            );
            assert.ok(
                result.results.some((hit: any) => hit.path === keywordFile),
                'Valid keyword results must remain available when semantic routes become obsolete'
            );
        } finally {
            resume.resolve();
            await query?.catch(() => {});
            await owner.close();
        }
    });
for (const route of ['name', 'content'])
    test(`${route}: new global model while its queued FileMgr transition is pending cannot query the old model index`, async (t) => {
        const directory = fs.mkdtempSync(path.join(profile, 'setting-' + route + '-'));
        let model = 'model-a';
        t.mock.method(Setting, 'getInstance', () => ({
            getDefaultEmbeddingModelInstance: () => ({ model_name: model }),
            getData: () => ({})
        }));
        t.mock.method(LLM, 'embed', async () => (model === 'model-a' ? [0, 1] : [1, 0]));
        t.mock.method(LLM, 'rerank', async (_q: string, items: any[]) => items);
        const owner = new FSStorage(directory);
        owner.storage = new BaseStorage('filemgr', makeSchema(2), owner._storageDir);
        owner.mode = 'full';
        Object.assign(owner.scannerState, {
            embedding_model: model,
            vec_dim: 2,
            chunk_level: 'structured',
            vector_backend: 'native',
            chunk_backend: 'native',
            embedding_generation: 0
        });
        const seen: any[] = [],
            search = owner.storage.search.bind(owner.storage);
        try {
            await owner.storage.initialize();
            owner.storage.search = async (conditions: any[], ...rest: any[]) => {
                if (conditions.some((c) => c.vectorQuery)) seen.push(conditions);
                return search(conditions, ...rest);
            };
            // __updateGlobalSetting is dispatched immediately; embeddingConfigChanged
            // separately waits behind existing scan tasks in the production worker queue.
            model = 'model-b';
            const result =
                route === 'name'
                    ? await owner.searchFileByName('query', { topK: 10 })
                    : await owner.searchIndexedChunks('query', { topK: 10 });
            console.log(
                JSON.stringify({
                    settingOnly: route,
                    recorded: owner.scannerState.embedding_model,
                    configured: model,
                    queries: seen.length,
                    code: result.code
                })
            );
            assert.equal(
                seen.length,
                0,
                'A model B query embedding cannot search the still-model-A index before the queued transition executes'
            );
            assert.ok(result.code);
        } finally {
            await owner.close();
        }
    });
