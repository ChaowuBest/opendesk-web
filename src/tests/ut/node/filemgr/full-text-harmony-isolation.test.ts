import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fork } from 'node:child_process';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { BaseWorker } from '../../../../../packages/app-sdk/src/index.js';
import { WorkerDatabaseKitProxy } from '../../../../platforms/bridges/worker.js';
import { LLM } from '../../../../main/aikernel/llm.js';
import { parseHTML } from 'linkedom';
import { FSStorage, makeSchema, CODES } from '../../../../main/applications/filemgr/storage.js';
import { isFullTextPlatformSupported } from '../../../../main/applications/filemgr/document-retrieval/common/full-text-state.js';
import FileManagerWorker from '../../../../main/applications/filemgr/worker.js';
import { Setting } from '../../../../main/utils/setting.js';
import { createSources } from '../../../../main/applications/filemgr/renderer/sources.js';
import { __resetForTesting, setEntries, setSnapshot } from '../../../../main/applications/filemgr/renderer/state.js';

import { setArkdataDatabaseKit } from '../../../../main/services/storage/arkdata-bridge.js';
import { arkDataFixture, registryWorkers } from '../services/storage/fixtures/arkdata-fixture.js';

async function platform(value: string, run: () => Promise<void>) {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value });
    try {
        await run();
    } finally {
        Object.defineProperty(process, 'platform', original);
    }
}

async function harmonyFixture(t: any, availability: string | undefined, run: (f: any) => Promise<void>) {
    // Load the host SDK substitute before overriding process.platform for the application factories.
    const Sqlite = createRequire(import.meta.url)('better-sqlite3');
    new Sqlite(':memory:').close();
    const f = arkDataFixture();
    const directory = path.join(f.directory, 'filemgr');
    fs.mkdirSync(directory);
    const originalArk = process.env.ARKDATA_AVAILABLE;
    const previousKit = setArkdataDatabaseKit(f.proxy().proxy);
    if (availability === undefined) delete process.env.ARKDATA_AVAILABLE;
    else process.env.ARKDATA_AVAILABLE = availability;
    t.mock.method(
        Setting,
        'getInstance',
        () =>
            ({
                getData: () => ({}),
                getDefaultEmbeddingModelInstance: () => null
            }) as any
    );
    try {
        await platform('openharmony', async () => {
            const owner = new FSStorage(directory);
            try {
                await run({ ...f, owner, directory });
            } finally {
                await owner.close();
            }
        });
    } finally {
        setArkdataDatabaseKit(previousKit);
        if (originalArk === undefined) delete process.env.ARKDATA_AVAILABLE;
        else process.env.ARKDATA_AVAILABLE = originalArk;
        f.cleanup();
        __resetForTesting();
    }
}

if (isMainThread && !process.env.FILEMGR_BM25_RESTART_CHILD) {
    const hostOptions = {
        skip:
            !process.env.OPENDESK_ARKDATA_ADAPTER_DIR &&
            'Harmony cross-repository tests require OPENDESK_ARKDATA_ADAPTER_DIR'
    };
    test('Harmony read-only contender opens base retrieval without touching the BM25 store', hostOptions, async (t) => {
        await harmonyFixture(t, '1', async ({ owner, directory, calls }) => {
            await owner.initialize({ syncEmbedding: false });
            const reader = new FSStorage(directory);
            try {
                const previousOpens = calls.filter(
                    (call: any) => call.operation === 'open' && call.config.name.includes('bm25')
                ).length;
                await reader.initializeReadonly();
                assert.ok(reader.storage);
                assert.deepEqual((await reader.storage.search([])).items, []);
                assert.equal(reader.getFullTextState().available, false);
                assert.equal(owner.getFullTextState().available, true);
                assert.equal(
                    calls.filter((call: any) => call.operation === 'open' && call.config.name.includes('bm25')).length,
                    previousOpens
                );
            } finally {
                await reader.close();
            }
        });
    });

    for (const availability of [undefined, '0', '1']) {
        test(`Harmony enables BM25 independently of startup ArkData flag ${availability}`, hostOptions, async (t) => {
            await harmonyFixture(t, availability, async ({ owner, directory, calls }) => {
                assert.equal(isFullTextPlatformSupported(), true);
                const schema = makeSchema(4, { mode: 'base-only', fullText: true });
                for (const key of ['bm25', 'bm25_generation', 'bm25_modified', 'full_text'])
                    assert.ok(schema.columns[key]);
                assert.deepEqual(schema.needIndexers, { full_text: [{ indexer: 'BM25Indexer' }] });
                await owner.initialize({ syncEmbedding: false });
                assert.deepEqual(owner.getFullTextState(), { available: true });
                const file = path.join(directory, 'query.txt');
                fs.writeFileSync(file, 'harmonycontent');
                const stat = fs.statSync(file);
                await owner.saveFiles(
                    [
                        {
                            path: file,
                            filename: 'query.txt',
                            type: 'file',
                            size: stat.size,
                            modified: Math.floor(stat.mtimeMs)
                        }
                    ],
                    directory
                );
                assert.deepEqual(await owner.processFullTextQueue(() => false, { activeRoots: [directory] }), {
                    outcome: 'completed',
                    processed: 1
                });
                assert.equal((await owner.searchFullText('harmonycontent'))[0]?.item_id, file);
                assert.equal((await owner.storage.getStatus()).BM25Indexer.tokenizer, 'harmonyos-intl');
                assert.ok(!calls.some((call: any) => call.operation === 'nlp-segment'));
                const state = JSON.parse(fs.readFileSync(owner._scannerStatePath, 'utf8'));
                assert.equal(state.bm25_rule_version, 1);
                assert.equal(state.bm25_reset_pending, false);
                // All three flags use ArkData for BM25; base keeps its existing factory selection.
                assert.equal(
                    owner.storage.baseIndexer.db.constructor.name,
                    availability === '1' ? 'BaseIndexDBArkdata' : 'BaseIndexDBWasm'
                );
            });
        });
    }

    test('Harmony Intl keeps BM25 and keyword search available without NLP', hostOptions, async (t) => {
        await harmonyFixture(t, '1', async ({ owner, directory, calls }) => {
            await owner.initialize({ syncEmbedding: false });
            assert.deepEqual(owner.getFullTextState(), { available: true });
            assert.equal(owner.scannerState.bm25_reset_pending, false);
            const file = path.join(directory, 'query.txt');
            fs.writeFileSync(file, 'text');
            const stat = fs.statSync(file);
            await owner.saveFiles(
                [
                    {
                        path: file,
                        filename: 'query.txt',
                        type: 'file',
                        size: stat.size,
                        modified: Math.floor(stat.mtimeMs)
                    }
                ],
                directory
            );
            assert.equal((await owner.processFullTextQueue(() => false, { activeRoots: [directory] })).processed, 1);
            assert.equal((await owner.searchFullText('text'))[0]?.item_id, file);
            assert.ok(!calls.some((call: any) => call.operation === 'nlp-segment'));
            const worker = new FileManagerWorker('wf2.harmony', directory);
            worker.storage = owner;
            worker.status = 'running';
            worker.config = { entries: [{ root: directory, include_patterns: ['**/*'], exclude_patterns: [] }] };
            worker._lastConfig = worker.config;
            const result = await worker.searchIndexedFiles('query');
            assert.equal(result.results.length, 1);
            assert.deepEqual(result.results[0].matchTypes, ['keyword']);
            assert.equal(result.fullTextAvailable, true);
            assert.equal(result.code, CODES.EMBED_UNAVAILABLE);
            await worker.getFileSystemStatus();
            await owner._perRootCountsCache.get(directory)?.inFlight;
            const snapshot = await worker.getFileSystemStatus();
            assert.equal(snapshot.full_text.available, true);
            assert.equal(snapshot.sources[0].full_text.done, 1);
            __resetForTesting();
            setEntries(worker.config.entries);
            setSnapshot(snapshot);
            const { document } = parseHTML('<html><head></head><body></body></html>');
            const sources = createSources({ document });
            document.body.append(sources.element);
            assert.equal(document.querySelectorAll('.fill.full-text').length, 1);
            sources.destroy();
        });
    });

    test('Harmony retains BM25 scanner generation across startup probe changes', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wf2-harmony-state-'));
        const originalArk = process.env.ARKDATA_AVAILABLE;
        try {
            await platform('openharmony', async () => {
                for (const availability of ['1', '0', undefined]) {
                    if (availability === undefined) delete process.env.ARKDATA_AVAILABLE;
                    else process.env.ARKDATA_AVAILABLE = availability;
                    const owner = new FSStorage(directory);
                    fs.writeFileSync(
                        owner._scannerStatePath,
                        JSON.stringify({
                            version: 1,
                            roots: {},
                            unavailable_roots: {},
                            bm25_generation: 4,
                            bm25_rule_version: 1,
                            bm25_reset_pending: false
                        })
                    );
                    owner._loadScannerState();
                    assert.equal(owner.scannerState.bm25_generation, 4);
                    await owner.saveScannerState();
                    assert.equal(JSON.parse(fs.readFileSync(owner._scannerStatePath, 'utf8')).bm25_generation, 4);
                }
            });
        } finally {
            if (originalArk === undefined) delete process.env.ARKDATA_AVAILABLE;
            else process.env.ARKDATA_AVAILABLE = originalArk;
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    for (const availability of ['terminal', 'unsupported']) {
        test(
            `complete process restart after ${availability} and failed SDK close`,
            { ...hostOptions, timeout: 90_000 },
            async () => {
                const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'filemgr-bm25-restart-'));
                async function launch(stage: string) {
                    const child = fork(new URL(import.meta.url), [], {
                        execArgv: [
                            '--import',
                            'tsx',
                            '--import',
                            new URL('../../../test-env.ts', import.meta.url).pathname
                        ],
                        env: {
                            ...process.env,
                            FILEMGR_BM25_RESTART_CHILD: JSON.stringify({
                                directory,
                                stage,
                                availability
                            }),
                            OPENDESK_CONFIG_DIRECTORY: path.join(directory, 'profile')
                        },
                        timeout: 40_000,
                        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
                    });
                    let report: any;
                    let output = '';
                    child.stdout!.on('data', (data) => {
                        output += data;
                    });
                    child.stderr!.on('data', (data) => {
                        output += data;
                    });
                    child.on('message', (message: any) => {
                        if (message.type === 'restart-report') report = message;
                    });
                    const exit = await new Promise((resolve, reject) => {
                        child.once('error', reject);
                        child.once('exit', resolve);
                    });
                    assert.equal(exit, 0, output);
                    assert.ok(report, 'child must execute every restart assertion: ' + output);
                    return report;
                }
                try {
                    const first = await launch('blocked');
                    const second = await launch('reopened');
                    assert.notEqual(first.pid, second.pid);
                    assert.equal(first.generation, second.generation);
                    assert.equal(first.embeddingGeneration, second.embeddingGeneration);
                    assert.equal(second.embedded, 1);
                    assert.ok(first.closeFailures > 0, 'Failure must reach an actual SDK close in the fixture');
                    assert.equal(second.bm25Available, true);
                    assert.ok(second.routes.includes('keyword'));
                    assert.ok(second.routes.includes('name_semantic'));
                } finally {
                    fs.rmSync(directory, { recursive: true, force: true });
                }
            }
        );
    }
} else if (isMainThread) {
    await restartHost(JSON.parse(process.env.FILEMGR_BM25_RESTART_CHILD!));
} else if (workerData?.filemgrRestart) {
    await restartWorker(workerData.filemgrRestart);
}

async function restartHost(scenario: any) {
    const f = arkDataFixture({ directory: scenario.directory });
    const before = f.control.before;
    let closeFailures = 0;
    const runtime = registryWorkers(f.kit, scenario.directory, {
        filename: new URL(import.meta.url),
        options: {
            execArgv: [
                '--import',
                'data:text/javascript,' +
                    encodeURIComponent(`import { register } from '${import.meta.resolve('tsx/esm/api')}'; register();`)
            ],
            workerData: {
                filemgrRestart: scenario,
                paths: { opendeskDirectory: path.join(scenario.directory, 'profile') }
            }
        }
    });
    const worker = runtime.registry.globalWorker!;
    try {
        const report: any = await new Promise((resolve, reject) => {
            worker.once('error', reject);
            worker.once('exit', (code) => reject(new Error('restart worker exited before report: ' + code)));
            worker.on('message', (message) => {
                if (message.type === 'fail-release') {
                    f.control.before = async (operation: string, detail: any) => {
                        await before(operation, detail);
                        if (operation === 'close') {
                            closeFailures++;
                            throw Object.assign(new Error('isolated persistent SDK close failure'), { code: 14800000 });
                        }
                    };
                    worker.postMessage({ type: 'release-failure-ready' });
                }
                if (message.type === 'restart-result') {
                    f.control.before = before;
                    resolve({ ...message, closeFailures });
                }
            });
        });
        await runtime.close();
        f.cleanup();
        process.send!({ ...report, type: 'restart-report', pid: process.pid });
        process.disconnect();
    } catch (error) {
        f.control.before = before;
        await runtime.close();
        f.cleanup();
        throw error;
    }
}

async function restartWorker(scenario: any) {
    const profile = path.join(scenario.directory, 'profile');
    process.env.OPENDESK_CONFIG_DIRECTORY = profile;
    process.env.ARKDATA_AVAILABLE = '0';
    Object.defineProperty(process, 'platform', { value: 'openharmony' });
    const vector = [1, ...Array(1023).fill(0)];
    (LLM as any).embed = async () => vector;
    (LLM as any).batchEmbed = async (texts: string[]) => texts.map(() => vector);
    (LLM as any).rerank = async (_query: string, rows: any[]) => rows;
    (Setting as any).getInstance = () => ({
        getData: () => ({}),
        getDefaultEmbeddingModelInstance: () => ({ model_name: 'restart-model', getTimeoutMs: () => 1000 })
    });
    const directory = path.join(scenario.directory, 'app');
    const root = path.join(directory, 'docs');
    const file = path.join(root, 'retained.txt');
    const worker = new FileManagerWorker('filemgr-restart', directory);
    parentPort!.on('message', (message) => {
        if (message.type === 'response') BaseWorker.handleAppResponse(message);
    });
    const proxy = new WorkerDatabaseKitProxy(worker);
    setArkdataDatabaseKit(proxy);
    const owner = new FSStorage(directory);
    await owner.initialize({ syncEmbedding: false });
    await owner.retrieval.prepare({ context: {}, reason: 'restart-test', role: 'write' });
    worker.storage = owner;
    worker.status = 'running';
    worker.config = { entries: [{ root, include_patterns: ['**/*'], exclude_patterns: [] }] };
    worker._lastConfig = worker.config;
    if (scenario.stage === 'blocked') {
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(file, 'harmonycontent retained');
        const stat = fs.statSync(file);
        await owner.saveFiles(
            [
                {
                    path: file,
                    filename: 'retained.txt',
                    type: 'file',
                    size: stat.size,
                    modified: Math.floor(stat.mtimeMs)
                }
            ],
            root
        );
        await owner.processFullTextQueue(() => false, { activeRoots: [root] });
        await owner.processEmbeddingQueue(() => false, { activeRoots: [root] });
        const failure = Object.assign(new Error('isolated runtime tokenizer failure'), {
            code: 'bm25_tokenizer_unavailable',
            details: { availability: scenario.availability }
        });
        owner.storage.searchBM25 = async () => {
            throw failure;
        };
        await assert.rejects(owner.searchFullText('harmonycontent'), (error) => error === failure);
        assert.equal(owner.getFullTextState().available, false);
        const healthy = await worker.searchIndexedFiles('retained');
        assert.ok(healthy.results[0].matchTypes.includes('name_semantic'));
        const ready = new Promise<void>((resolve) =>
            parentPort!.on('message', (message) => {
                if (message.type === 'release-failure-ready') resolve();
            })
        );
        parentPort!.postMessage({ type: 'fail-release' });
        await ready;
        const old = owner.storage;
        // Intl owns no NLP session; replacement only releases a shared BM25 store reference.
        // The final holder must still retain ownership when the actual SDK close fails.
        await owner._replaceRetrievalStorage({ dim: 1024, mode: 'base-only' });
        await assert.rejects(owner.close());
        assert.ok(owner._pendingStorageClosures.size > 0);
        assert.equal(owner.storage, null);
        await assert.rejects(old.search([]));
        parentPort!.postMessage({
            type: 'restart-result',
            generation: owner.scannerState.bm25_generation,
            embeddingGeneration: owner.scannerState.embedding_generation
        });
    } else {
        const row = (await owner.storage.search([])).items.find((hit: any) => hit.item.item_id === file)!.item;
        assert.equal(row.embedded, 1);
        assert.equal(row.root_refs, JSON.stringify([root]));
        const healthy = await worker.searchIndexedFiles('retained');
        assert.equal(healthy.results[0].path, file);
        assert.equal(owner.getFullTextState().available, true);
        assert.equal((await owner.searchFullText('harmonycontent'))[0].item_id, file);
        assert.equal((await owner.storage.getStatus()).BM25Indexer.tokenizer, 'harmonyos-intl');
        parentPort!.postMessage({
            type: 'restart-result',
            generation: owner.scannerState.bm25_generation,
            embeddingGeneration: owner.scannerState.embedding_generation,
            embedded: row.embedded,
            bm25Available: owner.getFullTextState().available,
            routes: healthy.results[0].matchTypes
        });
        await owner.close();
    }
}
