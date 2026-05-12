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
import { WARNINGS } from '../storage.js';
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

function makeFileEntry(filePath) {
    const stat = fs.statSync(filePath);
    return {
        path: filePath,
        filename: path.basename(filePath),
        size: stat.size,
        modified: Math.floor(stat.mtimeMs),
        created: Math.floor(stat.birthtimeMs),
        accessed: Math.floor(stat.atimeMs),
        type: 'file'
    };
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
// Initialised before the no-API early-exit so that the fast-path tests
// can reference globalAppDir / settingData.

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

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
            api_key: OPENROUTER_API_KEY ?? '',
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

if (!OPENROUTER_API_KEY) {
    console.log('OPENROUTER_API_KEY not set, running no-API worker orchestration tests');
    // Tests below exercise base-only scanning, config-change root plumbing,
    // getStatus shape, legacy-file cleanup, and queue-yield logic without
    // any real embedding API calls.
    await testInitializeRootStateAndStorageStateCallback();
    await testGetStatus();
    await testGetStatusTask4DisplayFields();
    await testConfigChangeAddRoot();
    await testConfigChangeRemoveRoot();
    await testLegacyFileCleanup();
    await testEmbeddingTaskYieldsToQueuedScan();
    await testSearchWhenStorageMissingReturnsIndexNotReady();
    await testTask5SearchWrappersNormalizeAndShortCircuit();
    await testTask5StartScannersDedupesRoots();
    await testResetFileSystemStorageUsesManualResetReason();
    await testTask7ReadonlyModeWhenScanLockHeld();
    await testTask7ScanLockCreatesDirectoryAndFinalizeReleases();
    await testTask7ReadonlyResetAndRebuildAreGuarded();
    await testTask8UnavailableRootForcesFullScanDepth();
    await testTask8EmptyFullScanMarksRootUnavailableAndPreservesIndex();
    await testTask8RecoveredRootClearsUnavailableAndUpdatesLastFileCount();
    cleanup(globalAppDir);
    process.exit(0);
}

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

// ── Test 0: Task 1 root state + storage state callback ──────────────

async function testInitializeRootStateAndStorageStateCallback() {
    console.log('  testInitializeRootStateAndStorageStateCallback...');
    const scanDir = tmpDir('scan-init-root-state');
    const appDir = tmpDir('app-init-root-state');
    let worker;
    try {
        createTestFiles(scanDir);
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.config = makeConfig(scanDir);

        let notices = 0;
        worker.callApp = async (method) => {
            if (method === 'noticeTUIStatusUpdate') notices++;
        };

        await worker.initialize();

        const rootState = worker.storage.getScannerState().roots[scanDir];
        assert.ok(rootState, 'scanner state should have configured root after initialize');
        assert.equal(rootState.last_file_count, 0);

        notices = 0;
        await worker.storage._setPermanentError('403', 'forbidden');
        assert.equal(notices, 1, 'storage state changes should notify TUI status update');
    } finally {
        if (worker) await worker.finalize();
        cleanup(scanDir);
        cleanup(appDir);
    }
    console.log('  ✅ testInitializeRootStateAndStorageStateCallback');
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
        assert.equal(state.roots[scanDir2].last_file_count, 4, 'full scan should checkpoint root2 file count');

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

        // Storage should be in base-only mode (no embedding model configured)
        assert.ok(!worker.storage.isDeferred(), 'storage should not be truly deferred — base-only always initializes');
        assert.equal(worker.storage.mode, 'base-only', 'storage should be in base-only mode without embedding config');

        // Restore embedding config
        setCustomAppDirectory(globalAppDir);
        Setting.updateInstanceData(settingData);

        // Trigger mode sync from base-only to full via scanner's scan() method.
        // syncEmbeddingMode at scan start detects embedding now available and transitions to full.
        // Going through taskQueue keeps test path consistent with production
        // serialization — see worker.js header concurrency invariant.
        const scanner = worker.scanners.get(scanDir);
        assert.ok(scanner, 'scanner should exist even in base-only state');
        await worker.taskQueue.add(() => scanner.scan());
        // Drain embedding task enqueued by scan
        await worker.taskQueue.onIdle();

        assert.equal(
            worker.storage.mode,
            'full',
            'storage should recover to full mode after embedding config restored via scan'
        );

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
        const expectedStatus = data.probe_permanent_error ? 'paused' : 'running';
        assert.equal(data.status, expectedStatus, 'data.status should reflect permanent probe error pause state');
        assert.ok(Array.isArray(data.scanners), 'data.scanners should be an array');
        assert.ok(data.scanners.length > 0, 'should have at least one scanner');
        assert.ok(data.storage !== undefined, 'data.storage should exist');
        assert.equal(data.isDeferred, false, 'isDeferred should be false');
        assert.equal(data.deferredReason, null, 'deferredReason should be null when storage is ready');
        assert.equal(typeof data.readonly, 'boolean', 'readonly flag should be present');
        assert.ok(data.unavailable_roots, 'unavailable_roots should be present');

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

// ── Test 6b: Task 4 getStatus display fields ───────────────────────

async function testGetStatusTask4DisplayFields() {
    console.log('  testGetStatusTask4DisplayFields...');
    const scanDir = tmpDir('scan-status-display');
    const appDir = tmpDir('app-status-display');
    let worker;
    try {
        createTestFiles(scanDir);

        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.config = makeConfig(scanDir);
        await worker.initialize();
        await worker.taskQueue.onIdle();

        worker.storage.scannerState.probe_permanent_error = {
            status: '401',
            message: '401 Unauthorized',
            ts: Date.now()
        };
        worker.storage.scannerState.last_rebuild_event = {
            type: 'full',
            reason: 'open_full_failed',
            status: 'failed',
            ts: Date.now(),
            message: 'broken index'
        };
        worker.storage.scannerState.unavailable_roots = {
            [scanDir]: {
                reason: 'enoent',
                last_count: 4,
                ts: Date.now()
            }
        };

        const paused = await worker.getStatus();
        assert.equal(paused.status, 'ok');
        assert.equal(paused.data.status, 'paused', 'permanent probe errors should pause status display');
        assert.equal(paused.data.deferredReason, null);
        assert.equal(paused.data.probe_permanent_error.message, '401 Unauthorized');
        assert.equal(paused.data.last_rebuild_event.reason, 'open_full_failed');
        assert.equal(paused.data.unavailable_roots[scanDir].last_count, 4);
        assert.equal(paused.data.readonly, false);

        worker._readonlyMode = true;
        const readonly = await worker.getStatus();
        assert.equal(readonly.data.status, 'readonly', 'readonly mode should override paused status display');
        assert.equal(readonly.data.readonly, true);

        console.log('  ✅ testGetStatusTask4DisplayFields');
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

// ── Test: testEmbeddingTaskYieldsToQueuedScan ────────────────────────

async function testEmbeddingTaskYieldsToQueuedScan() {
    console.log('  testEmbeddingTaskYieldsToQueuedScan...');
    const dir = tmpDir('yield');
    try {
        const worker = new FileManagerWorker('test', dir);
        worker.config = { entries: [] };
        await worker.initialize();

        const fss = worker.storage;
        for (let i = 0; i < 5; i++) {
            const f = path.join(dir, `f${i}.md`);
            fs.writeFileSync(f, `# content ${i}`);
            await fss.saveFiles([makeFileEntry(f)], dir);
        }

        // Set mode to full so processEmbeddingQueue runs
        fss.mode = 'full';

        // Stub embedSingleFile with a delay so we can observe mid-batch yield.
        // No real API call — this test is only about queue-yield behaviour.
        let processed = 0;
        fss.embedSingleFile = async (_row) => {
            await new Promise((r) => setTimeout(r, 50));
            processed++;
        };

        const taskPromise = fss.processEmbeddingQueue(() => worker._scanPending);
        setTimeout(() => {
            worker._scanPending = true;
        }, 75);

        const total = await taskPromise;
        assert.ok(total < 5, `must yield mid-task (got ${total} processed)`);
        assert.ok(processed >= 1);
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testEmbeddingTaskYieldsToQueuedScan');
}

// ── E2E: testE2EBaseOnlyToFullCatchUp ────────────────────────────────

async function waitForCondition(checkFn, { timeoutMs = 15000, intervalMs = 100, label } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await checkFn()) return;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`waitForCondition timeout: ${label ?? 'condition'}`);
}

async function testE2EBaseOnlyToFullCatchUp() {
    console.log('  testE2EBaseOnlyToFullCatchUp...');
    Setting.updateInstanceData({ ...settingData, default_embedding_model: '' });
    fs.writeFileSync(
        path.join(globalAppDir, 'setting.json'),
        JSON.stringify({ ...settingData, default_embedding_model: '' }, null, 4)
    );
    const dir = tmpDir('e2e');
    let worker;
    try {
        fs.writeFileSync(path.join(dir, 'alpha.md'), '# alpha content');
        fs.writeFileSync(path.join(dir, 'beta.md'), '# beta content');

        worker = new FileManagerWorker('test', dir);
        worker.config = { entries: [{ root: dir, include_patterns: ['**/*.md'], exclude_patterns: [] }] };
        await worker.initialize();
        // Wait for first scan to complete deterministically
        await worker.taskQueue.onIdle();

        const k = await worker.searchFilesByKeyword('alpha');
        assert.ok(k.length >= 1, 'keyword search must work in base-only');

        const s1 = await worker.searchFileByName('alpha');
        assert.equal(s1.code, 'EMBED_UNAVAILABLE');

        // Configure embedding
        Setting.updateInstanceData(settingData);
        fs.writeFileSync(path.join(globalAppDir, 'setting.json'), JSON.stringify(settingData, null, 4));
        await worker.applicationConfigChanged(worker.config);

        // syncEmbeddingMode runs inside applicationConfigChanged; embedding follow-up
        // is enqueued afterwards. Wait until queue drains AND mode is full
        // AND no rows remain pending.
        await waitForCondition(
            async () => {
                await worker.taskQueue.onIdle();
                const status = await worker.storage.getStatus();
                return status?.mode === 'full' && status.pending_count === 0;
            },
            { timeoutMs: 30000, label: 'mode=full + pending_count=0' }
        );

        const s2 = await worker.searchFileByName('alpha');
        assert.equal(s2.code, undefined);
        assert.ok(s2.results.length >= 1);
    } finally {
        Setting.updateInstanceData(settingData);
        if (worker) await worker.taskQueue.onIdle();
        cleanup(dir);
    }
    console.log('  ✅ testE2EBaseOnlyToFullCatchUp');
}

// ── Test: search returns INDEX_NOT_READY before storage exists ───────

async function testSearchWhenStorageMissingReturnsIndexNotReady() {
    console.log('  testSearchWhenStorageMissingReturnsIndexNotReady...');
    const appDir = tmpDir('app-search-missing-storage');
    const worker = new FileManagerWorker('com.test.filemgr', appDir);
    try {
        const byName = await worker.searchFileByName('alpha', 5);
        assert.equal(byName.warning, '文件索引尚未就绪，请稍后重试。');
        assert.equal(byName.code, 'INDEX_NOT_READY');

        const byContent = await worker.searchFileByContent('alpha', 5);
        assert.equal(byContent.warning, '文件索引尚未就绪，请稍后重试。');
        assert.equal(byContent.code, 'INDEX_NOT_READY');
    } finally {
        cleanup(appDir);
    }
    console.log('  ✅ testSearchWhenStorageMissingReturnsIndexNotReady');
}

// ── Test: Task 5 search wrappers normalize only after storage exists ─

async function testTask5SearchWrappersNormalizeAndShortCircuit() {
    console.log('  testTask5SearchWrappersNormalizeAndShortCircuit...');
    const appDir = tmpDir('app-task5-search');
    const worker = new FileManagerWorker('com.test.filemgr', appDir);
    try {
        const originalQuery = { text: 'alpha' };
        const missing = await worker.searchFileByName(originalQuery, 500);
        assert.equal(missing.query, originalQuery, 'missing storage path should preserve original query');
        assert.equal(missing.code, 'INDEX_NOT_READY');

        const calls = [];
        worker.storage = {
            async searchFileByName(query, options) {
                calls.push({ method: 'name', query, options });
                return { query, results: [], totalHits: 0 };
            },
            async searchFileByContent(query, options) {
                calls.push({ method: 'content', query, options });
                return { query, results: [], totalHits: 0 };
            }
        };

        const blankName = await worker.searchFileByName('   ', 10);
        assert.deepEqual(blankName, { query: '   ', results: [], totalHits: 0 });
        assert.equal(calls.length, 0, 'blank name query should not call storage');

        const blankContent = await worker.searchFileByContent({ text: 'beta' }, 10);
        assert.deepEqual(blankContent, { query: '', results: [], totalHits: 0 });
        assert.equal(calls.length, 0, 'non-string content query should normalize to blank and not call storage');

        await worker.searchFileByName('alpha', 500);
        await worker.searchFileByContent('beta', -3);
        await worker.searchFileByContent('gamma', 'not-a-number');

        assert.deepEqual(calls, [
            { method: 'name', query: 'alpha', options: { topK: 100 } },
            { method: 'content', query: 'beta', options: { topK: 1 } },
            { method: 'content', query: 'gamma', options: { topK: 20 } }
        ]);
    } finally {
        cleanup(appDir);
    }
    console.log('  ✅ testTask5SearchWrappersNormalizeAndShortCircuit');
}

// ── Test: Task 5 duplicate scanner roots are ignored ────────────────

async function testTask5StartScannersDedupesRoots() {
    console.log('  testTask5StartScannersDedupesRoots...');
    const scanDir = tmpDir('scan-task5-dedup');
    const appDir = tmpDir('app-task5-dedup');
    const worker = new FileManagerWorker('com.test.filemgr', appDir);
    try {
        let queuedScans = 0;
        worker.taskQueue = {
            add() {
                queuedScans++;
            }
        };
        worker.storage = {
            scannerState: {
                roots: {
                    [scanDir]: {
                        last_full_scan: 0,
                        total_files: 0,
                        last_file_count: 0
                    }
                }
            }
        };

        await worker._startScanners([
            { root: scanDir, include_patterns: ['**/*.md'], exclude_patterns: [] },
            { root: scanDir, include_patterns: ['**/*.txt'], exclude_patterns: [] }
        ]);

        assert.equal(worker.scanners.size, 1, 'duplicate roots should create one scanner');
        assert.equal(queuedScans, 1, 'duplicate roots should queue one scanner task');
        assert.deepEqual(
            worker.scanners.get(scanDir).entry.include_patterns,
            ['**/*.md'],
            'first root entry should win when duplicates are ignored'
        );
    } finally {
        for (const scanner of worker.scanners.values()) {
            await scanner.stop();
        }
        worker.scanners.clear();
        cleanup(scanDir);
        cleanup(appDir);
    }
    console.log('  ✅ testTask5StartScannersDedupesRoots');
}

// ── Test: Task 6 manual reset uses canonical rebuild reason ───────────

async function testResetFileSystemStorageUsesManualResetReason() {
    console.log('  testResetFileSystemStorageUsesManualResetReason...');
    const appDir = tmpDir('app-task6-manual-reset');
    const worker = new FileManagerWorker('com.test.filemgr', appDir);
    try {
        let reason = null;
        worker.storage = {};
        worker._rebuildAndRestart = async (value) => {
            reason = value;
        };

        const result = await worker.resetFileSystemStorage();

        assert.equal(result.status, 'ok');
        assert.equal(reason, 'manual_reset');
    } finally {
        cleanup(appDir);
    }
    console.log('  ✅ testResetFileSystemStorageUsesManualResetReason');
}

// ── Test: Task 7 lock contention enters readonly query mode ─────────

async function testTask7ReadonlyModeWhenScanLockHeld() {
    console.log('  testTask7ReadonlyModeWhenScanLockHeld...');
    const appDir = tmpDir('app-task7-readonly');
    const scanDir = tmpDir('scan-task7-readonly');
    const nextScanDir = tmpDir('scan-task7-readonly-next');
    let writer;
    let reader;
    try {
        Setting.updateInstanceData({ ...settingData, default_embedding_model: '' });
        fs.writeFileSync(
            path.join(globalAppDir, 'setting.json'),
            JSON.stringify({ ...settingData, default_embedding_model: '' }, null, 4)
        );

        writer = new FileManagerWorker('com.test.filemgr', appDir);
        writer.config = { entries: [] };
        await writer.initialize();

        reader = new FileManagerWorker('com.test.filemgr', appDir);
        reader.config = makeConfig(scanDir);
        await reader.initialize();

        assert.equal(reader._readonlyMode, true, 'second worker should enter readonly mode');
        assert.equal(reader.scanners.size, 0, 'readonly worker must not start scanners');
        assert.equal(reader._lastConfig, null, 'readonly init should not snapshot config');
        assert.equal(
            reader.storage.scannerState.roots[scanDir],
            undefined,
            'readonly init must not create scanner root state'
        );

        const status = await reader.getFileSystemStatus();
        assert.equal(status.status, 'readonly');
        assert.equal(status.readonly, true);

        await reader.applicationConfigChanged(makeConfig(nextScanDir));
        assert.equal(
            reader.storage.scannerState.roots[nextScanDir],
            undefined,
            'readonly config changes must not write scanner state'
        );
    } finally {
        Setting.updateInstanceData(settingData);
        fs.writeFileSync(path.join(globalAppDir, 'setting.json'), JSON.stringify(settingData, null, 4));
        if (reader) await reader.finalize();
        if (writer) await writer.finalize();
        cleanup(scanDir);
        cleanup(nextScanDir);
        cleanup(appDir);
    }
    console.log('  ✅ testTask7ReadonlyModeWhenScanLockHeld');
}

// ── Test: Task 7 scan lock prepares app dir and finalizes cleanly ───

async function testTask7ScanLockCreatesDirectoryAndFinalizeReleases() {
    console.log('  testTask7ScanLockCreatesDirectoryAndFinalizeReleases...');
    const appDir = path.join(os.tmpdir(), `filemgr-worker-test-app-task7-lock-${Date.now()}`);
    const worker = new FileManagerWorker('com.test.filemgr', appDir);
    const contender = new FileManagerWorker('com.test.filemgr', appDir);
    try {
        const acquired = await worker._acquireScanLock();
        assert.equal(acquired, true);
        assert.equal(fs.existsSync(appDir), true, 'lock acquisition should create appDataDirectory');
        assert.equal(fs.existsSync(path.join(appDir, 'scan.lock')), true, 'lock file should exist');

        await worker.finalize();

        const reacquired = await contender._acquireScanLock();
        assert.equal(reacquired, true, 'finalize should release scan lock');
    } finally {
        if (typeof contender._releaseScanLock === 'function') {
            await contender._releaseScanLock().catch(() => {});
        }
        if (typeof worker._releaseScanLock === 'function') {
            await worker._releaseScanLock().catch(() => {});
        }
        cleanup(appDir);
    }
    console.log('  ✅ testTask7ScanLockCreatesDirectoryAndFinalizeReleases');
}

// ── Test: Task 7 readonly reset/rebuild are guarded ─────────────────

async function testTask7ReadonlyResetAndRebuildAreGuarded() {
    console.log('  testTask7ReadonlyResetAndRebuildAreGuarded...');
    const appDir = tmpDir('app-task7-readonly-guards');
    const worker = new FileManagerWorker('com.test.filemgr', appDir);
    try {
        let queued = false;
        worker._readonlyMode = true;
        worker.storage = {};
        worker.runSequentially = () => {
            queued = true;
            return Promise.resolve();
        };

        await worker._rebuildAndRestart('readonly-test');
        assert.equal(queued, false, 'readonly rebuild should not enter task queue');

        worker._rebuildAndRestart = async () => {
            throw new Error('should not rebuild in readonly mode');
        };
        const result = await worker.resetFileSystemStorage();
        assert.deepEqual(result, {
            status: 'error',
            warning: WARNINGS.READONLY_MODE,
            message: '查询模式不支持重置索引'
        });
    } finally {
        cleanup(appDir);
    }
    console.log('  ✅ testTask7ReadonlyResetAndRebuildAreGuarded');
}

// ── Test: Task 8 unavailable root forces full scan ──────────────────

async function testTask8UnavailableRootForcesFullScanDepth() {
    console.log('  testTask8UnavailableRootForcesFullScanDepth...');
    const scanDir = tmpDir('scan-task8-depth');
    const appDir = tmpDir('app-task8-depth');
    let worker;
    try {
        fs.writeFileSync(path.join(scanDir, 'one.txt'), 'one', 'utf-8');

        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.config = makeConfig(scanDir);
        await worker.initialize();
        await worker.taskQueue.onIdle();

        const scanner = worker.scanners.get(scanDir);
        assert.ok(scanner, 'scanner should exist');
        scanner.state.last_full_scan = Date.now();
        scanner._counter = 1;
        worker.storage.scannerState.unavailable_roots[scanDir] = {
            since: Date.now(),
            last_count: 51
        };

        assert.equal(scanner._getScanDepth(), undefined, 'unavailable roots should force a full scan');
    } finally {
        if (worker) await worker.finalize();
        cleanup(scanDir);
        cleanup(appDir);
    }
    console.log('  ✅ testTask8UnavailableRootForcesFullScanDepth');
}

// ── Test: Task 8 empty full scan preserves index for unavailable root ─

async function testTask8EmptyFullScanMarksRootUnavailableAndPreservesIndex() {
    console.log('  testTask8EmptyFullScanMarksRootUnavailableAndPreservesIndex...');
    const scanDir = tmpDir('scan-task8-unavailable');
    const appDir = tmpDir('app-task8-unavailable');
    let worker;
    try {
        for (let i = 0; i < 55; i++) {
            fs.writeFileSync(path.join(scanDir, `file-${i}.txt`), `file ${i}`, 'utf-8');
        }

        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.config = makeConfig(scanDir);
        await worker.initialize();
        await worker.taskQueue.onIdle();

        const scanner = worker.scanners.get(scanDir);
        assert.ok(scanner, 'scanner should exist');
        scanner.state.last_file_count = 55;
        const before = await worker.storage.storage.search([
            { indexer: 'BaseIndexer', field: 'type', operator: '=', value: 'file' }
        ]);
        assert.equal(before.items.length, 55, 'initial full scan should index all files');

        for (const name of fs.readdirSync(scanDir)) {
            fs.rmSync(path.join(scanDir, name), { recursive: true, force: true });
        }

        scanner._counter = 32;
        await worker.taskQueue.add(() => scanner.scan());

        const unavailable = worker.storage.scannerState.unavailable_roots[scanDir];
        assert.ok(unavailable, 'empty full scan after a large prior root should mark unavailable');
        assert.equal(unavailable.last_count, 55);
        assert.equal(scanner.state.last_file_count, 55, 'unavailable scan should not checkpoint zero count');

        const after = await worker.storage.storage.search([
            { indexer: 'BaseIndexer', field: 'type', operator: '=', value: 'file' }
        ]);
        assert.equal(after.items.length, 55, 'unavailable scan should preserve old index entries');
    } finally {
        if (worker) await worker.finalize();
        cleanup(scanDir);
        cleanup(appDir);
    }
    console.log('  ✅ testTask8EmptyFullScanMarksRootUnavailableAndPreservesIndex');
}

// ── Test: Task 8 recovered root clears unavailable and checkpoints ───

async function testTask8RecoveredRootClearsUnavailableAndUpdatesLastFileCount() {
    console.log('  testTask8RecoveredRootClearsUnavailableAndUpdatesLastFileCount...');
    const scanDir = tmpDir('scan-task8-recovered');
    const appDir = tmpDir('app-task8-recovered');
    let worker;
    try {
        fs.writeFileSync(path.join(scanDir, 'a.txt'), 'a', 'utf-8');
        fs.writeFileSync(path.join(scanDir, 'b.txt'), 'b', 'utf-8');
        fs.writeFileSync(path.join(scanDir, 'c.txt'), 'c', 'utf-8');

        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.config = makeConfig(scanDir);
        await worker.initialize();
        await worker.taskQueue.onIdle();

        const scanner = worker.scanners.get(scanDir);
        assert.ok(scanner, 'scanner should exist');
        worker.storage.scannerState.unavailable_roots[scanDir] = {
            since: Date.now(),
            last_count: 55
        };

        scanner._counter = 32;
        await worker.taskQueue.add(() => scanner.scan());
        await worker.taskQueue.onIdle();

        assert.equal(
            worker.storage.scannerState.unavailable_roots[scanDir],
            undefined,
            'non-empty full scan should clear unavailable state'
        );
        assert.equal(scanner.state.last_file_count, 3, 'non-empty full scan should checkpoint current file count');
    } finally {
        if (worker) await worker.finalize();
        cleanup(scanDir);
        cleanup(appDir);
    }
    console.log('  ✅ testTask8RecoveredRootClearsUnavailableAndUpdatesLastFileCount');
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
    console.log('=== FileManagerWorker Tests ===\n');
    let passed = 0,
        failed = 0;

    const filter = process.env.TEST_FILTER;

    const tests = [
        testInitializeRootStateAndStorageStateCallback,
        testFullScanSmallDir,
        testSearchAfterScan,
        testIncrementalScan,
        testConfigChangeAddRoot,
        testConfigChangeRemoveRoot,
        testDeferredRecovery,
        testGetStatus,
        testResetFileSystemStorage,
        testScannerStateCorruptRebuild,
        testLegacyFileCleanup,
        testEmbeddingTaskYieldsToQueuedScan,
        testSearchWhenStorageMissingReturnsIndexNotReady,
        testTask5SearchWrappersNormalizeAndShortCircuit,
        testTask5StartScannersDedupesRoots,
        testResetFileSystemStorageUsesManualResetReason,
        testTask7ReadonlyModeWhenScanLockHeld,
        testTask7ScanLockCreatesDirectoryAndFinalizeReleases,
        testTask7ReadonlyResetAndRebuildAreGuarded,
        testTask8UnavailableRootForcesFullScanDepth,
        testTask8EmptyFullScanMarksRootUnavailableAndPreservesIndex,
        testTask8RecoveredRootClearsUnavailableAndUpdatesLastFileCount,
        testE2EBaseOnlyToFullCatchUp
    ];

    const filteredTests = filter ? tests.filter((t) => t.name.includes(filter)) : tests;

    for (const test of filteredTests) {
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
