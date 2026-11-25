import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const backend = process.env.FILEMGR_SWITCH_TEST_BACKEND;
if (backend) {
    // Each restart gets a fresh module cache. Simulate the missing native package,
    // letting the production storage factories choose their fallback normally.
    const require = createRequire(import.meta.url);
    const moduleLoader = require('node:module');
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (id: string, ...args: any[]) {
        if (backend === 'wasm' && id === 'better-sqlite3') {
            const error = Object.assign(new Error("Cannot find module 'better-sqlite3'"), {
                code: 'MODULE_NOT_FOUND'
            });
            throw error;
        }
        return originalLoad.call(this, id, ...args);
    };
    const profile = process.env.OPENDESK_CONFIG_DIRECTORY!;
    const root = path.join(profile, 'files');
    const appDir = path.join(profile, 'filemgr');
    const { Setting, setCustomOpendeskDirectory } = await import('../../../../main/utils/setting.js');
    setCustomOpendeskDirectory(profile);
    const settings = {
        default_embedding_model: 'test-embed',
        default_reranker_model: '',
        providers: [{ name: 'fixture', base_url: 'http://127.0.0.1:1', api_key: '', no_proxy: true }],
        models: [
            {
                alias: 'test-embed',
                provider_name: 'fixture',
                model_name: process.env.FILEMGR_SWITCH_TEST_MODEL || 'model-a',
                model_type: 'embedding'
            }
        ],
        applications: {}
    };
    fs.writeFileSync(path.join(profile, 'setting.json'), JSON.stringify(settings));
    Setting.updateInstanceData(settings as any);
    const { LLM } = await import('../../../../main/aikernel/llm.js');
    // Only model requests are stubbed; scan, parse, database writes and search are real.
    let dimension = Number(process.env.FILEMGR_SWITCH_TEST_DIM || 2);
    let embeddedFiles = 0;
    const vector = () =>
        Array.from({ length: dimension }, (_, i) =>
            i === (settings.models[0].model_name === 'model-a' ? 0 : 1) ? 1 : 0
        );
    LLM.embed = async () => vector();
    LLM.batchEmbed = async (texts: string[]) => {
        embeddedFiles++;
        return texts.map(() => vector());
    };
    LLM.rerank = async (_query: string, items: any[]) => items;
    const { default: FileManagerWorker } = await import('../../../../main/applications/filemgr/worker.js');
    const worker = new FileManagerWorker('com.test.filemgr', appDir);
    worker.config = { entries: [{ root, include_patterns: ['**/*'], exclude_patterns: [] }] };
    worker.callApp = async () => undefined;
    try {
        await worker.initialize();
        await worker.taskQueue.onIdle();
        assert.equal(worker._initError, null);
        if (process.env.FILEMGR_SWITCH_TEST_ONLINE_MODEL) {
            settings.models[0].model_name = process.env.FILEMGR_SWITCH_TEST_ONLINE_MODEL;
            dimension = Number(process.env.FILEMGR_SWITCH_TEST_ONLINE_DIM || dimension);
            fs.writeFileSync(path.join(profile, 'setting.json'), JSON.stringify(settings));
            Setting.updateInstanceData(settings as any);
            await worker.embeddingConfigChanged();
            await worker.taskQueue.onIdle();
        }
        assert.equal(worker.storage.mode, 'full');
        const rows = await worker.storage.storage.search([
            { indexer: 'BaseIndexer', field: 'type', operator: '=', value: 'file' }
        ]);
        assert.equal(rows.items.length, 2, 'startup must scan deep unchanged files despite the old checkpoint');
        assert.ok(rows.items.every(({ item }: any) => item.embedded === 1 && item.ref_count === 1));
        const status = await worker.storage.getStatus();
        assert.equal(status.vecdb_size, 2);
        assert.ok(status.chunk_size >= 2);
        const search = await worker.storage.retrieval.searchNames('fixture');
        assert.equal(search.results.length, 2, 'base rows must join to the current vector store');
        const chunks = await worker.storage.retrieval.searchContent('fixture', { topK: 10 });
        assert.ok(chunks.results.length >= 2, 'base rows must join to the current chunk store');
        assert.ok(worker.storage.scannerState.roots[root].last_full_scan > 0);
        assert.ok(
            rows.items.every(
                ({ item }: any) => item.embedding_generation === worker.storage.scannerState.embedding_generation
            )
        );
        console.log(
            'RESULT ' + JSON.stringify({ embeddedFiles, generation: worker.storage.scannerState.embedding_generation })
        );
    } finally {
        await worker.finalize();
        moduleLoader._load = originalLoad;
    }
    process.exit(0);
} else {
    const require = createRequire(import.meta.url);
    function withFixture(
        run: (profile: string, restart: (backend: string, options?: Record<string, string | number>) => any) => void
    ) {
        const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'filemgr-backend-switch-'));
        const root = path.join(profile, 'files');
        const deepDir = path.join(root, ...Array.from({ length: 14 }, (_, i) => `depth-${i}`));
        fs.mkdirSync(deepDir, { recursive: true });
        fs.writeFileSync(path.join(root, 'one.md'), '# First fixture\n\nAn isolated storage regression test.');
        fs.writeFileSync(
            path.join(deepDir, 'two.md'),
            '# Deep fixture\n\nComplete scans after changing storage backends.'
        );
        const restart = (selectedBackend: string, options: Record<string, string | number> = {}) => {
            const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url)], {
                env: {
                    ...process.env,
                    OPENDESK_CONFIG_DIRECTORY: profile,
                    FILEMGR_SWITCH_TEST_BACKEND: selectedBackend,
                    ...Object.fromEntries(
                        Object.entries(options).map(([key, value]) => [`FILEMGR_SWITCH_TEST_${key}`, String(value)])
                    )
                },
                encoding: 'utf8',
                timeout: 60_000
            });
            assert.equal(result.status, 0, `${selectedBackend} restart failed:\n${result.stdout}\n${result.stderr}`);
            return JSON.parse(
                result.stdout
                    .split('\n')
                    .find((line) => line.startsWith('RESULT '))!
                    .slice(7)
            );
        };
        try {
            run(profile, restart);
        } finally {
            fs.rmSync(profile, { recursive: true, force: true });
        }
    }
    test('unchanged model: actual backend changes preserve inactive base and invalidate semantics only once', () => {
        withFixture((profile, restart) => {
            const first = restart('native');
            const dbDir = path.join(profile, 'filemgr', 'storage');
            const nativePath = path.join(dbDir, 'base-index.db');
            const nativeBefore = fs.readFileSync(nativePath);
            const statePath = path.join(profile, 'filemgr', 'scanner_state.json');
            const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            state.roots[path.join(profile, 'files')].last_full_scan = Date.now() + 86_400_000;
            state.embedded_migrated = true;
            state._migratedRefCount = true;
            fs.writeFileSync(statePath, JSON.stringify(state));
            assert.equal(restart('wasm').generation, first.generation + 1);
            assert.ok(fs.existsSync(path.join(dbDir, 'base-index.wasm.db')));
            assert.deepEqual(fs.readFileSync(nativePath), nativeBefore);
            assert.equal(restart('wasm').embeddedFiles, 0);
            assert.deepEqual(fs.readFileSync(nativePath), nativeBefore);
            assert.equal(restart('native').embeddedFiles, 2);
            assert.equal(restart('native').embeddedFiles, 0);
        });
    });
    for (const backend of ['native', 'wasm']) {
        test(`${backend}: old JSON and old table upgrade without repeat embedding`, () => {
            withFixture((profile, restart) => {
                assert.equal(restart(backend).generation, 0);
                const statePath = path.join(profile, 'filemgr', 'scanner_state.json');
                const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
                delete state.embedding_generation;
                fs.writeFileSync(statePath, JSON.stringify(state));
                const dbPath = path.join(
                    profile,
                    'filemgr',
                    'storage',
                    backend === 'native' ? 'base-index.db' : 'base-index.wasm.db'
                );
                const db =
                    backend === 'native'
                        ? new (require('better-sqlite3'))(dbPath)
                        : new (require('node-sqlite3-wasm').Database)(dbPath);
                const execute = (sql: string) => (backend === 'native' ? db.exec(sql) : db.run(sql));
                execute('DROP INDEX IF EXISTS idx_base_embedding_generation');
                execute('ALTER TABLE base_index DROP COLUMN embedding_generation');
                db.close();
                const upgraded = restart(backend);
                assert.equal(upgraded.generation, 0);
                assert.equal(upgraded.embeddedFiles, 0);
            });
        });
        const other = backend === 'native' ? 'wasm' : 'native';
        for (const dimension of [2, 3]) {
            test(`${backend} → ${other} changes model while closed → ${backend}, dimensions=${dimension}`, () => {
                withFixture((_profile, restart) => {
                    const first = restart(backend);
                    const changed = restart(other, { MODEL: 'model-b', DIM: dimension });
                    assert.ok(changed.generation > first.generation);
                    assert.equal(restart(backend, { MODEL: 'model-b', DIM: dimension }).embeddedFiles, 2);
                    assert.equal(restart(backend, { MODEL: 'model-b', DIM: dimension }).embeddedFiles, 0);
                });
            });
        }
        test(`${backend} changes model online without switching backend and resumes the real scanner`, () => {
            withFixture((_profile, restart) => {
                const first = restart(backend);
                const changed = restart(backend, { ONLINE_MODEL: 'model-b', ONLINE_DIM: 3 });
                assert.ok(changed.generation > first.generation);
                assert.equal(changed.embeddedFiles, 2);
                assert.equal(restart(backend, { MODEL: 'model-b', DIM: 3 }).embeddedFiles, 0);
            });
        });
        test(`${backend} → ${other} changes model online → ${backend} does not reuse stale surviving vectors`, () => {
            withFixture((profile, restart) => {
                restart(backend);
                const suffix = backend === 'native' ? '.db' : '.wasm.db';
                const basePath = path.join(profile, 'filemgr', 'storage', 'base-index' + suffix);
                const untouched = fs.readFileSync(basePath);
                const changed = restart(other, { ONLINE_MODEL: 'model-b' });
                assert.ok(changed.generation > 0);
                assert.deepEqual(fs.readFileSync(basePath), untouched, 'inactive base must not be opened or edited');
                // A reset owns both semantic backend files; the inactive base stays untouched.
                assert.equal(fs.existsSync(path.join(profile, 'filemgr', 'storage', 'vector-index' + suffix)), false);
                assert.equal(restart(backend, { MODEL: 'model-b' }).embeddedFiles, 2);
                assert.equal(restart(backend, { MODEL: 'model-b' }).embeddedFiles, 0);
            });
        });
    }
}
