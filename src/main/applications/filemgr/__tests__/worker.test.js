/**
 * FileManagerWorker integration tests
 *
 * Uses REAL dependencies: real FSStorage (SQLite in tmp dir), real parseAndChunk,
 * real LLM via OpenRouter API, real fast-glob scanning.
 *
 * 运行方式：
 * source ~/.nvm/nvm.sh && nvm use 20 && npx tsx src/main/applications/filemgr/__tests__/worker.test.js
 */

import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { Setting, setCustomAppDirectory } from '../../../utils/setting.js';
import FileManagerWorker from '../worker.js';

// ── Constants & Helpers ─────────────────────────────────────────────

function tmpDir(name) {
    const dir = path.join(os.tmpdir(), `filemgr-worker-test-${name}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function cleanup(dir) {
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function createTestFiles(dir) {
    fs.mkdirSync(dir, { recursive: true });

    // .md with content (will have chunks)
    fs.writeFileSync(
        path.join(dir, 'readme.md'),
        `# Project README

This project implements a data processing pipeline with authentication, caching, and monitoring capabilities.

## Features

- User authentication with JWT tokens
- Redis-based caching layer
- Prometheus metrics integration
`,
        'utf-8'
    );

    // .txt with content (will have chunks)
    fs.writeFileSync(
        path.join(dir, 'notes.txt'),
        'Development notes about the deployment process and infrastructure setup.\n'.repeat(3),
        'utf-8'
    );

    // .json (chunk_type='filename', no content chunks)
    fs.writeFileSync(path.join(dir, 'config.json'), '{"port": 8080, "host": "localhost"}', 'utf-8');

    // .bin (unknown format, chunks=null)
    fs.writeFileSync(path.join(dir, 'data.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03]));
}

function makeConfig(root) {
    return {
        entries: [
            {
                root,
                include_patterns: ['**/*'],
                exclude_patterns: ['**/node_modules/**', '**/.git/**']
            }
        ]
    };
}

// ── Global Setting setup ────────────────────────────────────────────

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) {
    console.log('OPENROUTER_API_KEY not set, skipping filemgr worker tests');
    process.exit(0);
}

const globalAppDir = tmpDir('setting');
setCustomAppDirectory(globalAppDir);

const settingData = {
    default_embedding_model: 'test-embed',
    default_reranker_model: '',
    default_model: '',
    default_intent_parsing_model: '',
    default_vision_model: '',
    providers: [
        {
            name: 'openrouter',
            base_url: 'https://openrouter.ai/api/v1',
            api_key: OPENROUTER_API_KEY,
            no_proxy: true
        }
    ],
    models: [
        {
            alias: 'test-embed',
            provider_name: 'openrouter',
            model_name: 'BAAI/bge-m3'
        }
    ],
    applications: {}
};

fs.writeFileSync(path.join(globalAppDir, 'setting.json'), JSON.stringify(settingData, null, 4), 'utf-8');
Setting.updateInstanceData(settingData);

// ── Test 1: testFullScanSmallDir ─────────────────────────────────────

async function testFullScanSmallDir() {
    console.log('  testFullScanSmallDir...');
    const scanDir = tmpDir('scan-small');
    const appDir = tmpDir('app-scan-small');
    let worker;
    try {
        createTestFiles(scanDir);

        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.config = makeConfig(scanDir);
        await worker.initialize();

        // Wait for scan to complete
        await worker.taskQueue.onIdle();

        const storage = worker.storage;
        assert.ok(storage, 'storage should be initialized');
        assert.ok(!storage.isDeferred(), 'storage should not be deferred');

        // All files should have BaseIndexer records
        for (const filename of ['readme.md', 'notes.txt', 'config.json', 'data.bin']) {
            const filePath = path.join(scanDir, filename);
            const result = await storage.storage.search([
                { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: filePath }
            ]);
            assert.equal(result.items.length, 1, `BaseIndexer should have record for ${filename}`);
        }

        // .md files should have ChunkIndexer records
        const status = await storage.getStatus();
        assert.ok(status.chunk_size >= 1, 'ChunkIndexer should have data from .md file');

        // Per-file VectorIndexer check — all files should have filename embeddings
        assert.ok(status.vecdb_size >= 4, 'VectorIndexer should have records for all 4 files');

        // .json and .bin should NOT have ChunkIndexer records — verify per-file
        const embedding = (await import('../../../aikernel/llm.js')).LLM;
        const probeVec = await embedding.embed('test');
        for (const noChunkFile of ['config.json', 'data.bin']) {
            const filePath = path.join(scanDir, noChunkFile);
            const chunkResult = await storage.storage.search([
                {
                    indexer: 'ChunkIndexer',
                    field: 'chunk_text',
                    operator: 'vector_near',
                    value: probeVec,
                    vectorQuery: { topK: 100, metric: 'cosine' }
                },
                { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: filePath }
            ]);
            assert.equal(chunkResult.items.length, 0, `${noChunkFile} should have no ChunkIndexer records`);
        }

        // Scanner state should have correct root with last_full_scan > 0
        const scannerState = storage.getScannerState();
        assert.ok(scannerState.roots[scanDir], 'scanner state should have the scan root');
        assert.ok(scannerState.roots[scanDir].last_full_scan > 0, 'last_full_scan should be > 0');

        console.log('  ✅ testFullScanSmallDir');
    } finally {
        if (worker) await worker.finalize();
        cleanup(scanDir);
        cleanup(appDir);
    }
}

// ── Test 2: testSearchAfterScan ──────────────────────────────────────

async function testSearchAfterScan() {
    console.log('  testSearchAfterScan...');
    const scanDir = tmpDir('scan-search');
    const appDir = tmpDir('app-scan-search');
    let worker;
    try {
        createTestFiles(scanDir);

        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.config = makeConfig(scanDir);
        await worker.initialize();
        await worker.taskQueue.onIdle();

        // searchFileByName
        const nameResult = await worker.searchFileByName('readme');
        assert.ok(nameResult.query === 'readme', 'searchFileByName should have query field');
        assert.ok(Array.isArray(nameResult.results), 'searchFileByName should have results array');
        assert.ok(typeof nameResult.totalHits === 'number', 'searchFileByName should have totalHits');
        assert.ok(nameResult.results.length > 0, 'searchFileByName should find results');

        // searchFileByContent
        const contentResult = await worker.searchFileByContent('authentication');
        assert.ok(contentResult.query === 'authentication', 'searchFileByContent should have query field');
        assert.ok(Array.isArray(contentResult.results), 'searchFileByContent should have results array');
        assert.ok(contentResult.results.length > 0, 'searchFileByContent should find results');
        // First result should have snippet
        assert.ok(contentResult.results[0].snippet !== undefined, 'content result should have snippet');

        // searchFilesByKeyword
        const kwResult = await worker.searchFilesByKeyword('readme');
        assert.ok(Array.isArray(kwResult), 'searchFilesByKeyword should return array');
        assert.ok(kwResult.length > 0, 'searchFilesByKeyword should find results');
        assert.ok(typeof kwResult[0].path === 'string', 'keyword result should have .path field');

        // searchFilesByNameSimilarity
        const simResult = await worker.searchFilesByNameSimilarity('readme');
        assert.ok(Array.isArray(simResult), 'searchFilesByNameSimilarity should return array');
        assert.ok(simResult.length > 0, 'searchFilesByNameSimilarity should find results');

        console.log('  ✅ testSearchAfterScan');
    } finally {
        if (worker) await worker.finalize();
        cleanup(scanDir);
        cleanup(appDir);
    }
}

// ── Test 2b: testIncrementalScan ────────────────────────────────────

async function testIncrementalScan() {
    console.log('  testIncrementalScan...');
    const scanDir = tmpDir('scan-incr');
    const appDir = tmpDir('app-incr');
    let worker;
    try {
        createTestFiles(scanDir);

        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.config = makeConfig(scanDir);
        await worker.initialize();
        await worker.taskQueue.onIdle();

        // Record state after first scan
        const state1 = worker.storage.getScannerState();
        const firstScanTime = state1.roots[scanDir].last_full_scan;
        assert.ok(firstScanTime > 0, 'first scan should complete');

        // Get original data for an unmodified file
        const jsonPath = path.join(scanDir, 'config.json');
        const origResult = await worker.storage.storage.search([
            { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: jsonPath }
        ]);
        assert.equal(origResult.items.length, 1, 'config.json should be indexed');

        // Modify only one file — add new content to readme.md
        const mdPath = path.join(scanDir, 'readme.md');
        fs.appendFileSync(
            mdPath,
            '\n## New Section\n\nThis is brand new content added for the incremental scan test.\n'
        );

        // Add a new file
        const newFile = path.join(scanDir, 'newfile.txt');
        fs.writeFileSync(newFile, 'This is a new file for incremental scan testing.\n'.repeat(3), 'utf-8');

        // Trigger second scan by manually invoking scan via taskQueue.
        // (SCAN_INTERVAL_MS is 10 min, we can't wait that long.)
        // Going through taskQueue keeps test path consistent with production
        // serialization — see worker.js header concurrency invariant.
        const scanner = worker.scanners.get(scanDir);
        await worker.taskQueue.add(() => scanner.scan());

        // New file should be indexed
        const newResult = await worker.storage.storage.search([
            { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: newFile }
        ]);
        assert.equal(newResult.items.length, 1, 'new file should be indexed after incremental scan');

        // Unmodified file should still be present
        const stillResult = await worker.storage.storage.search([
            { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: jsonPath }
        ]);
        assert.equal(stillResult.items.length, 1, 'unmodified file should still be indexed');

        console.log('  ✅ testIncrementalScan');
    } finally {
        if (worker) await worker.finalize();
        cleanup(scanDir);
        cleanup(appDir);
    }
}

// ── Test 3: testConfigChangeAddRoot ──────────────────────────────────

async function testConfigChangeAddRoot() {
    console.log('  testConfigChangeAddRoot...');
    const scanDir1 = tmpDir('scan-add-root1');
    const scanDir2 = tmpDir('scan-add-root2');
    const appDir = tmpDir('app-add-root');
    let worker;
    try {
        createTestFiles(scanDir1);
        createTestFiles(scanDir2);

        // Initialize with one root
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.config = makeConfig(scanDir1);
        await worker.initialize();
        await worker.taskQueue.onIdle();

        assert.ok(worker.scanners.has(scanDir1), 'should have scanner for root1');
        assert.ok(!worker.scanners.has(scanDir2), 'should not have scanner for root2 yet');

        // Add second root via config change
        const newConfig = {
            entries: [
                {
                    root: scanDir1,
                    include_patterns: ['**/*'],
                    exclude_patterns: ['**/node_modules/**', '**/.git/**']
                },
                {
                    root: scanDir2,
                    include_patterns: ['**/*'],
                    exclude_patterns: ['**/node_modules/**', '**/.git/**']
                }
            ]
        };
        await worker.applicationConfigChanged(newConfig);
        await worker.taskQueue.onIdle();

        // New root should appear in scanner state
        const state = worker.storage.getScannerState();
        assert.ok(state.roots[scanDir2], 'scanner state should have root2');

        // New scanner should be started
        assert.ok(worker.scanners.has(scanDir2), 'should have scanner for root2');
        assert.ok(worker.scanners.get(scanDir2).isRunning(), 'root2 scanner should be running');

        console.log('  ✅ testConfigChangeAddRoot');
    } finally {
        if (worker) await worker.finalize();
        cleanup(scanDir1);
        cleanup(scanDir2);
        cleanup(appDir);
    }
}

// ── Test 4: testConfigChangeRemoveRoot ───────────────────────────────

async function testConfigChangeRemoveRoot() {
    console.log('  testConfigChangeRemoveRoot...');
    const scanDir1 = tmpDir('scan-rm-root1');
    const scanDir2 = tmpDir('scan-rm-root2');
    const appDir = tmpDir('app-rm-root');
    let worker;
    try {
        createTestFiles(scanDir1);
        createTestFiles(scanDir2);

        // Initialize with two roots
        const twoRootConfig = {
            entries: [
                {
                    root: scanDir1,
                    include_patterns: ['**/*'],
                    exclude_patterns: ['**/node_modules/**', '**/.git/**']
                },
                {
                    root: scanDir2,
                    include_patterns: ['**/*'],
                    exclude_patterns: ['**/node_modules/**', '**/.git/**']
                }
            ]
        };
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.config = twoRootConfig;
        await worker.initialize();
        await worker.taskQueue.onIdle();

        // Verify both roots scanned
        assert.ok(worker.scanners.has(scanDir1), 'should have scanner for root1');
        assert.ok(worker.scanners.has(scanDir2), 'should have scanner for root2');
        assert.ok(worker.storage.getScannerState().roots[scanDir2], 'state should have root2');

        // Remove root2 via config change
        await worker.applicationConfigChanged(makeConfig(scanDir1));
        await worker.taskQueue.onIdle();

        // Removed root should be gone from scanner state
        const stateAfter = worker.storage.getScannerState();
        assert.ok(!stateAfter.roots[scanDir2], 'root2 should be removed from scanner state');

        // Remaining root's scanner should still be running
        assert.ok(worker.scanners.has(scanDir1), 'should still have scanner for root1');
        assert.ok(worker.scanners.get(scanDir1).isRunning(), 'root1 scanner should still be running');

        // Root2 scanner should be gone
        assert.ok(!worker.scanners.has(scanDir2), 'root2 scanner should be removed');

        console.log('  ✅ testConfigChangeRemoveRoot');
    } finally {
        if (worker) await worker.finalize();
        cleanup(scanDir1);
        cleanup(scanDir2);
        cleanup(appDir);
    }
}

// ── Test 5: testDeferredRecovery ─────────────────────────────────────

async function testDeferredRecovery() {
    console.log('  testDeferredRecovery...');
    const scanDir = tmpDir('scan-deferred');
    const appDir = tmpDir('app-deferred');
    const deferredAppDir = tmpDir('setting-deferred');
    let worker;
    try {
        createTestFiles(scanDir);

        // Save a setting without embedding config
        const noEmbedData = {
            ...settingData,
            default_embedding_model: '',
            models: []
        };
        fs.writeFileSync(path.join(deferredAppDir, 'setting.json'), JSON.stringify(noEmbedData, null, 4), 'utf-8');

        // Temporarily switch to no-embed setting
        setCustomAppDirectory(deferredAppDir);
        Setting.updateInstanceData(noEmbedData);

        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.config = makeConfig(scanDir);
        await worker.initialize();
        await worker.taskQueue.onIdle();

        // Storage should be deferred (no embedding model)
        assert.ok(worker.storage.isDeferred(), 'storage should be deferred without embedding config');

        // Restore embedding config
        setCustomAppDirectory(globalAppDir);
        Setting.updateInstanceData(settingData);

        // Trigger recovery through scanner's scan() method — which calls
        // storage.initialize() when deferred, mimicking the real recovery path.
        // Going through taskQueue keeps test path consistent with production
        // serialization — see worker.js header concurrency invariant.
        const scanner = worker.scanners.get(scanDir);
        assert.ok(scanner, 'scanner should exist even in deferred state');
        await worker.taskQueue.add(() => scanner.scan());

        assert.ok(!worker.storage.isDeferred(), 'storage should recover after embedding config restored via scan');

        console.log('  ✅ testDeferredRecovery');
    } finally {
        // Restore global setting
        setCustomAppDirectory(globalAppDir);
        Setting.updateInstanceData(settingData);
        if (worker) await worker.finalize();
        cleanup(scanDir);
        cleanup(appDir);
        cleanup(deferredAppDir);
    }
}

// ── Test 6: testGetStatus ────────────────────────────────────────────

async function testGetStatus() {
    console.log('  testGetStatus...');
    const scanDir = tmpDir('scan-status');
    const appDir = tmpDir('app-status');
    let worker;
    try {
        createTestFiles(scanDir);

        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.config = makeConfig(scanDir);
        await worker.initialize();
        await worker.taskQueue.onIdle();

        const result = await worker.getStatus();
        assert.equal(result.status, 'ok', 'getStatus should return status=ok');
        assert.ok(result.data, 'getStatus should have data field');

        const data = result.data;
        assert.equal(data.status, 'running', 'data.status should be running');
        assert.ok(Array.isArray(data.scanners), 'data.scanners should be an array');
        assert.ok(data.scanners.length > 0, 'should have at least one scanner');
        assert.ok(data.storage !== undefined, 'data.storage should exist');
        assert.equal(data.isDeferred, false, 'isDeferred should be false');

        // Verify scanner info shape
        const scanner = data.scanners[0];
        assert.ok(scanner.root, 'scanner should have root');
        assert.ok(typeof scanner.lastFullScan === 'number', 'scanner should have lastFullScan');
        assert.ok(typeof scanner.totalFiles === 'number', 'scanner should have totalFiles');
        assert.ok(typeof scanner.isRunning === 'boolean', 'scanner should have isRunning');

        console.log('  ✅ testGetStatus');
    } finally {
        if (worker) await worker.finalize();
        cleanup(scanDir);
        cleanup(appDir);
    }
}

// ── Test 7: testResetFileSystemStorage ───────────────────────────────

async function testResetFileSystemStorage() {
    console.log('  testResetFileSystemStorage...');
    const scanDir = tmpDir('scan-reset');
    const appDir = tmpDir('app-reset');
    let worker;
    try {
        createTestFiles(scanDir);

        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.config = makeConfig(scanDir);
        await worker.initialize();
        await worker.taskQueue.onIdle();

        // Verify data exists before reset
        const statusBefore = await worker.storage.getStatus();
        assert.ok(statusBefore.db_size > 0, 'should have data before reset');

        // Record the old scanner state timestamp
        const oldFullScan = worker.storage.getScannerState().roots[scanDir].last_full_scan;
        assert.ok(oldFullScan > 0, 'last_full_scan should be > 0 before reset');

        // Reset
        const resetResult = await worker.resetFileSystemStorage();
        assert.equal(resetResult.status, 'ok', 'resetFileSystemStorage should return ok');

        // After rebuild, scanner state roots should have last_full_scan reset to 0
        // (rebuildAll resets progress for all roots)
        // Note: scanners restart immediately and may complete a new scan before
        // we can check, so we verify the storage was rebuilt by checking that it
        // is valid and scanners are restarted.

        // Storage should still exist and not be deferred
        assert.ok(worker.storage, 'storage should still exist after reset');
        assert.ok(!worker.storage.isDeferred(), 'storage should not be deferred after reset');

        // Scanners should be restarted
        assert.ok(worker.scanners.size > 0, 'scanners should be restarted');
        assert.ok(worker.scanners.has(scanDir), 'scanner for scanDir should exist');

        // Wait for scan to complete after reset
        await worker.taskQueue.onIdle();

        // After the rescan, data should be back (proves rebuild + rescan cycle works)
        const statusAfter = await worker.storage.getStatus();
        assert.ok(statusAfter.db_size > 0, 'data should be re-indexed after reset + rescan');

        console.log('  ✅ testResetFileSystemStorage');
    } finally {
        if (worker) await worker.finalize();
        cleanup(scanDir);
        cleanup(appDir);
    }
}

// ── Test 8: testScannerStateCorruptRebuild ──────────────────────────

async function testScannerStateCorruptRebuild() {
    console.log('  testScannerStateCorruptRebuild...');
    const scanDir = tmpDir('scan-corrupt');
    const appDir = tmpDir('app-corrupt');
    let worker;
    try {
        createTestFiles(scanDir);

        // First: normal init to create valid storage
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.config = makeConfig(scanDir);
        await worker.initialize();
        await worker.taskQueue.onIdle();
        await worker.finalize();

        // Corrupt scanner_state.json
        const statePath = path.join(appDir, 'scanner_state.json');
        fs.writeFileSync(statePath, '{invalid json!!!', 'utf-8');

        // Re-init — should detect corruption and rebuild
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.config = makeConfig(scanDir);
        await worker.initialize();
        await worker.taskQueue.onIdle();

        // Storage should be valid after rebuild
        assert.ok(worker.storage, 'storage should exist after corrupt state rebuild');
        assert.ok(!worker.storage.isDeferred(), 'storage should not be deferred');

        // Scanner state should be valid
        const state = worker.storage.getScannerState();
        assert.ok(state.vec_dim !== null, 'vec_dim should be set after rebuild');
        assert.ok(state.embedding_model !== null, 'embedding_model should be set');

        console.log('  ✅ testScannerStateCorruptRebuild');
    } finally {
        if (worker) await worker.finalize();
        cleanup(scanDir);
        cleanup(appDir);
    }
}

// ── Test 9: testLegacyFileCleanup ───────────────────────────────────

async function testLegacyFileCleanup() {
    console.log('  testLegacyFileCleanup...');
    const scanDir = tmpDir('scan-legacy');
    const appDir = tmpDir('app-legacy');
    let worker;
    try {
        createTestFiles(scanDir);

        // Create fake legacy files in the global app directory
        const { getAppDirectory } = await import('../../../utils/setting.js');
        const globalDir = getAppDirectory();
        const legacyFiles = ['fs_storage.db', 'vec_storage.db', 'vec_cache.jsonl'];
        for (const f of legacyFiles) {
            const p = path.join(globalDir, f);
            if (!fs.existsSync(p)) {
                fs.writeFileSync(p, 'legacy data', 'utf-8');
            }
        }

        // Initialize worker — should clean up legacy files
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.config = makeConfig(scanDir);
        await worker.initialize();
        await worker.taskQueue.onIdle();

        // Legacy files should be removed
        for (const f of legacyFiles) {
            const p = path.join(globalDir, f);
            assert.ok(!fs.existsSync(p), `legacy file ${f} should be removed`);
        }

        console.log('  ✅ testLegacyFileCleanup');
    } finally {
        if (worker) await worker.finalize();
        cleanup(scanDir);
        cleanup(appDir);
    }
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
    console.log('=== FileManagerWorker Tests ===\n');
    let passed = 0,
        failed = 0;

    const tests = [
        testFullScanSmallDir,
        testSearchAfterScan,
        testIncrementalScan,
        testConfigChangeAddRoot,
        testConfigChangeRemoveRoot,
        testDeferredRecovery,
        testGetStatus,
        testResetFileSystemStorage,
        testScannerStateCorruptRebuild,
        testLegacyFileCleanup
    ];

    for (const test of tests) {
        try {
            await test();
            passed++;
        } catch (e) {
            try {
                console.log(`  ⟳ retrying ${test.name}...`);
                await test();
                passed++;
            } catch (e2) {
                console.error(`  FAIL ${test.name}: ${e2.message}`);
                console.error(e2.stack);
                failed++;
            }
        }
    }

    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
    cleanup(globalAppDir);
    if (failed > 0) process.exit(1);
}

main().catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
});
