/**
 * FileManagerWorker integration tests
 *
 * Uses REAL dependencies: real FSStorage (SQLite in tmp dir), real parseAndChunk,
 * real LLM via OpenRouter API, real fast-glob scanning.
 *
 * 运行方式：
 * source ~/.nvm/nvm.sh && nvm use 20 && npx tsx --test src/tests/ut/node/filemgr/worker.test.js
 */

import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { Setting, setCustomOpendeskDirectory } from '../../../../main/utils/setting.js';
import { CODES, FSStorage, WARNINGS } from '../../../../main/applications/filemgr/storage.js';
import FileManagerWorker from '../../../../main/applications/filemgr/worker.js';

// ── Constants & Helpers ─────────────────────────────────────────────

function tmpDir(name) {
    const dir = path.join(os.tmpdir(), `filemgr-worker-test-${name}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function cleanup(dir) {
    if (!fs.existsSync(dir)) return;
    // Windows may keep SQLite file handles briefly after close(); retry a few times.
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
            return;
        } catch (err) {
            if (err?.code !== 'EPERM' && err?.code !== 'EBUSY') throw err;
            const waitMs = 100 * (attempt + 1);
            const start = Date.now();
            while (Date.now() - start < waitMs) {
                /* busy wait (sync context) */
            }
        }
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

function makeEntry(root, excludePatterns = ['**/node_modules/**', '**/.git/**']) {
    return {
        root,
        include_patterns: ['**/*'],
        exclude_patterns: excludePatterns
    };
}

async function getBaseRow(worker, filePath) {
    const rows = await worker.storage.storage.search([
        { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: filePath }
    ]);
    assert.equal(rows.items.length, 1, `expected one row for ${filePath}`);
    return rows.items[0].item;
}

async function getOptionalBaseRow(worker, filePath) {
    const rows = await worker.storage.storage.search([
        { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: filePath }
    ]);
    return rows.items[0]?.item ?? null;
}

function assertRootRefs(row, expectedRefs) {
    assert.deepEqual(JSON.parse(row.root_refs).sort(), [...expectedRefs].sort());
    assert.equal(row.ref_count, expectedRefs.length);
}

// ── Global Setting setup ────────────────────────────────────────────
// Initialised before the no-API early-exit so that the fast-path tests
// can reference globalAppDir / settingData.

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const globalAppDir = tmpDir('setting');
setCustomOpendeskDirectory(globalAppDir);

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
            model_name: 'BAAI/bge-m3',
            model_type: 'embedding'
        }
    ],
    applications: {}
};

fs.writeFileSync(path.join(globalAppDir, 'setting.json'), JSON.stringify(settingData, null, 4), 'utf-8');
Setting.updateInstanceData(settingData);

if (!OPENROUTER_API_KEY) {
    console.log('OPENROUTER_API_KEY not set, running no-API worker orchestration tests');
    const filter = process.env.TEST_FILTER;
    if (filter) {
        const filteredTests = [
            testInitializeSchedulesProbeContinuationBeforeStartingScanners,
            testApplicationConfigChangedSyncsModeBeforeRestartingScanners
        ].filter((test) => test.name.includes(filter));
        for (const test of filteredTests) {
            await test();
        }
        cleanup(globalAppDir);
        process.exit(0);
    }
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
    await testSearchIndexedFilesBaseOnlyRunsKeywordOnly();
    await testSearchIndexedFilesMergesSortsAndFilters();
    await testSearchIndexedFilesRouteSelectionKeepsExpectedGroups();
    await testSearchIndexedFilesDropsUnavailableAndExcluded();
    await testSearchIndexedFilesSemanticPartial();
    await testSearchIndexedFilesKeywordFailureReturnsError();
    await testTask5StartScannersDedupesRoots();
    await testResetFileSystemStorageUsesManualResetReason();
    await testTask7ReadonlyModeWhenScanLockHeld();
    await testTask7ScanLockCreatesDirectoryAndFinalizeReleases();
    await testTask7RepeatedInitializeKeepsWriterMode();
    await testTask7ReadonlyResetAndRebuildAreGuarded();
    await testTask8UnavailableRootForcesFullScanDepth();
    await testTask8EmptyFullScanMarksRootUnavailableAndPreservesIndex();
    await testTask8RecoveredRootClearsUnavailableAndUpdatesLastFileCount();
    await testTask17DLastScanAtIncrementalAndFullScan();
    await testTask15StatusPushLayers();
    await testSemanticWriteCapacityAlertOnlyForVectorLimit();
    await testScannerIntervalUsesWorkspaceAndEmbeddingState();
    await testEmbeddingQueueOnlySchedulesInFullMode();
    await testEmbeddingQueueFailureIsHandled();
    await testEmbeddingQueueYieldsToPendingConfigChange();
    await testStartupConfigChangeMarksPendingConfigForEmbeddingQueueYield();
    await testWorkspaceChangedForExistingEntryForcesFullScanAndImmediateScan();
    await testApplicationConfigChangedPassesActiveRootsToEmbeddingQueue();
    await testInitializeSchedulesProbeContinuationBeforeStartingScanners();
    await testApplicationConfigChangedSyncsModeBeforeRestartingScanners();
    await testTask16V3ConfigChangeCases();
    await testTask16ConfigChangeDedup();
    await testConfigChangeDuringInitializeDoesNotDropRemovedRoots();
    await testInitializeReconcilesStaleScannerStateRoots();
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
        const embedding = (await import('../../../../main/aikernel/llm.js')).LLM;
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

        const pushes = [];
        worker.callApp = async (method, payload) => {
            if (method === 'publishStatusChanged') pushes.push(payload);
        };

        await worker.initialize();
        await worker.taskQueue.onIdle();

        const rootState = worker.storage.getScannerState().roots[scanDir];
        assert.ok(rootState, 'scanner state should have configured root after initialize');
        assert.equal(typeof rootState.last_file_count, 'number');

        pushes.length = 0;
        await worker.storage._setPermanentError('403', 'forbidden');
        await new Promise((r) => setTimeout(r, 10));
        assert.ok(
            pushes.some((payload) => payload.reason === 'storage-state'),
            'storage state changes should publish'
        );
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
        setCustomOpendeskDirectory(deferredAppDir);
        Setting.updateInstanceData(noEmbedData);

        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.config = makeConfig(scanDir);
        await worker.initialize();
        await worker.taskQueue.onIdle();

        // Storage should be in base-only mode (no embedding model configured)
        assert.ok(!worker.storage.isDeferred(), 'storage should not be truly deferred — base-only always initializes');
        assert.equal(worker.storage.mode, 'base-only', 'storage should be in base-only mode without embedding config');

        // Restore embedding config
        setCustomOpendeskDirectory(globalAppDir);
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
        setCustomOpendeskDirectory(globalAppDir);
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
        assert.equal(data.status, 'running', 'embedding probe errors should not pause base scanning status');
        assert.equal(data.mode, 'base-only');
        assert.ok(
            ['embed_model_missing', 'embedding_unavailable', 'embedding_pending'].includes(data.alerts[0]?.code),
            'base-only status should expose an embedding alert'
        );
        assert.ok(Array.isArray(data.sources), 'data.sources should be an array');
        assert.equal(data.sources.length, 1, 'should have one source');
        assert.equal(data.sources[0].root, scanDir);
        assert.equal(data.sources[0].entry.root, scanDir);
        assert.equal(typeof data.sources[0].is_workspace, 'boolean');
        assert.ok(['pending', 'completed', 'unavailable'].includes(data.sources[0].state));
        assert.ok(data.totals, 'data.totals should exist');
        assert.ok(data.storage_stats, 'data.storage_stats should exist');
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

async function testSemanticWriteCapacityAlertOnlyForVectorLimit() {
    console.log('  testSemanticWriteCapacityAlertOnlyForVectorLimit...');
    const appDir = tmpDir('semantic-capacity-alert');
    const worker = new FileManagerWorker('com.test.filemgr', appDir);
    try {
        const vectorLimitedAlerts = worker._buildAlerts('running', 'full', {
            semantic_write_state: {
                vector: { acceptingWrites: false, reason: 'capacity_limit' },
                chunk: { acceptingWrites: true }
            }
        });
        assert.equal(vectorLimitedAlerts[0]?.code, 'semantic_capacity_limited');

        const chunkLimitedAlerts = worker._buildAlerts('running', 'full', {
            semantic_write_state: {
                vector: { acceptingWrites: true },
                chunk: { acceptingWrites: false, reason: 'capacity_limit' }
            }
        });
        assert.deepEqual(chunkLimitedAlerts, []);

        const acceptingAlerts = worker._buildAlerts('running', 'full', {
            semantic_write_state: {
                vector: { acceptingWrites: true },
                chunk: { acceptingWrites: true }
            }
        });
        assert.deepEqual(acceptingAlerts, []);
    } finally {
        cleanup(appDir);
    }
    console.log('  ✅ testSemanticWriteCapacityAlertOnlyForVectorLimit');
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

        const statusWithProbeError = await worker.getStatus();
        assert.equal(statusWithProbeError.status, 'ok');
        assert.equal(
            statusWithProbeError.data.status,
            'running',
            'permanent probe errors should not pause base scanning status'
        );
        assert.equal(statusWithProbeError.data.deferredReason, null);
        assert.equal(statusWithProbeError.data.probe_permanent_error.message, '401 Unauthorized');
        assert.equal(statusWithProbeError.data.last_rebuild_event.reason, 'open_full_failed');
        assert.equal(statusWithProbeError.data.unavailable_roots[scanDir].last_count, 4);
        assert.equal(statusWithProbeError.data.readonly, false);

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
        const { getOpendeskDirectory } = await import('../../../../main/utils/setting.js');
        const globalDir = getOpendeskDirectory();
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
    let worker;
    try {
        worker = new FileManagerWorker('test', dir);
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
        if (worker) await worker.finalize();
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
        assert.equal(missing.code, CODES.INDEX_NOT_READY);

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

function makeSearchWorker() {
    const appDir = tmpDir('search-indexed-worker');
    const worker = new FileManagerWorker('com.test.filemgr', appDir);
    const entries = [makeEntry('/workspace'), makeEntry('/docs', ['secret/**'])];
    worker.config = { entries };
    worker._lastConfig = worker.config;
    worker.status = 'running';
    worker._currentWorkspace = '/workspace';
    worker.storage = {
        mode: 'base-only',
        scannerState: { unavailable_roots: {}, roots: {}, probe_permanent_error: null, last_rebuild_event: null },
        isDeferred: () => false,
        searchFilesByKeyword: async () => [],
        searchFileByName: async () => {
            throw new Error('semantic should not run');
        },
        searchFileByContent: async () => {
            throw new Error('semantic should not run');
        }
    };
    worker._statFileForSearch = async () => ({ isFile: () => true });
    return worker;
}

async function testSearchIndexedFilesBaseOnlyRunsKeywordOnly() {
    console.log('  testSearchIndexedFilesBaseOnlyRunsKeywordOnly...');
    const worker = makeSearchWorker();
    try {
        worker.storage.searchFilesByKeyword = async (_query, options) => {
            assert.equal(options.limit, 6);
            return [
                {
                    path: '/workspace/report.md',
                    filename: 'report.md',
                    modified: 1,
                    size: 2,
                    snippet: null,
                    ref_count: 1
                }
            ];
        };

        const result = await worker.searchIndexedFiles('report', { topK: 2 });

        assert.equal(result.results.length, 1);
        assert.deepEqual(result.results[0].matchTypes, ['keyword']);
        assert.equal(result.code, CODES.EMBED_UNAVAILABLE);
    } finally {
        cleanup(worker.appDataDirectory);
    }
    console.log('  ✅ testSearchIndexedFilesBaseOnlyRunsKeywordOnly');
}

async function testSearchIndexedFilesMergesSortsAndFilters() {
    console.log('  testSearchIndexedFilesMergesSortsAndFilters...');
    const worker = makeSearchWorker();
    try {
        worker.storage.mode = 'full';
        worker.storage.searchFilesByKeyword = async () => [
            { path: '/workspace/report.md', filename: 'report.md', modified: 1, size: 2, snippet: null, ref_count: 1 }
        ];
        worker.storage.searchFileByName = async () => ({
            results: [
                {
                    path: '/workspace/report.md',
                    filename: 'report.md',
                    modified: 1,
                    size: 2,
                    snippet: null,
                    ref_count: 1
                },
                { path: '/docs/plan.md', filename: 'plan.md', modified: 3, size: 4, snippet: null, ref_count: 1 }
            ]
        });
        worker.storage.searchFileByContent = async () => ({
            results: [
                {
                    path: '/docs/content.md',
                    filename: 'content.md',
                    modified: 5,
                    size: 6,
                    snippet: 'hello',
                    ref_count: 1
                }
            ]
        });

        const result = await worker.searchIndexedFiles('report', { topK: 10 });

        assert.equal(result.results[0].path, '/workspace/report.md');
        assert.deepEqual(result.results[0].matchTypes, ['keyword', 'name_semantic']);
        assert.equal(result.results.length, 3);
        assert.equal(result.results.find((row) => row.path === '/docs/content.md')?.snippet, 'hello');
    } finally {
        cleanup(worker.appDataDirectory);
    }
    console.log('  ✅ testSearchIndexedFilesMergesSortsAndFilters');
}

async function testSearchIndexedFilesRouteSelectionKeepsExpectedGroups() {
    console.log('  testSearchIndexedFilesRouteSelectionKeepsExpectedGroups...');
    const worker = makeSearchWorker();
    try {
        let keywordCalls = 0;
        let semanticCalls = 0;
        worker.storage.mode = 'full';
        worker.storage.searchFilesByKeyword = async () => {
            keywordCalls += 1;
            return [
                {
                    path: '/workspace/report.md',
                    filename: 'report.md',
                    modified: 1,
                    size: 2,
                    snippet: null,
                    ref_count: 1
                }
            ];
        };
        worker.storage.searchFileByName = async () => {
            semanticCalls += 1;
            return {
                results: [
                    {
                        path: '/workspace/name.md',
                        filename: 'name.md',
                        modified: 1,
                        size: 2,
                        snippet: null,
                        semanticScore: 0.9,
                        ref_count: 1
                    },
                    {
                        path: '/workspace/both.md',
                        filename: 'both.md',
                        modified: 1,
                        size: 2,
                        snippet: null,
                        semanticScore: 0.2,
                        ref_count: 1
                    }
                ]
            };
        };
        worker.storage.searchFileByContent = async () => {
            semanticCalls += 1;
            return {
                results: [
                    {
                        path: '/workspace/content.md',
                        filename: 'content.md',
                        modified: 1,
                        size: 2,
                        snippet: 'content hit',
                        semanticScore: 0.5,
                        ref_count: 1
                    },
                    {
                        path: '/workspace/both.md',
                        filename: 'both.md',
                        modified: 1,
                        size: 2,
                        snippet: 'both content',
                        semanticScore: 0.4,
                        ref_count: 1
                    }
                ]
            };
        };

        const keywordOnly = await worker.searchIndexedFiles('report', { topK: 10, routes: ['keyword'] });
        assert.equal(keywordCalls, 1);
        assert.equal(semanticCalls, 0);
        assert.deepEqual(
            keywordOnly.results.map((row) => row.path),
            ['/workspace/report.md']
        );
        assert.deepEqual(keywordOnly.results[0].matchTypes, ['keyword']);

        keywordCalls = 0;
        const semanticOnly = await worker.searchIndexedFiles('report', {
            topK: 10,
            routes: ['name_semantic', 'content_semantic']
        });

        assert.equal(keywordCalls, 0);
        assert.equal(semanticCalls, 2);
        assert.deepEqual(
            semanticOnly.results.map((row) => row.path),
            ['/workspace/content.md', '/workspace/both.md', '/workspace/name.md']
        );
        assert.deepEqual(semanticOnly.results[1].matchTypes, ['name_semantic', 'content_semantic']);
        assert.equal(semanticOnly.results[1].snippet, 'both content');
    } finally {
        cleanup(worker.appDataDirectory);
    }
    console.log('  ✅ testSearchIndexedFilesRouteSelectionKeepsExpectedGroups');
}

async function testSearchIndexedFilesDropsUnavailableAndExcluded() {
    console.log('  testSearchIndexedFilesDropsUnavailableAndExcluded...');
    const worker = makeSearchWorker();
    try {
        worker.storage.scannerState.unavailable_roots = { '/docs': { since: 1 } };
        worker.config = { entries: [makeEntry('/workspace', ['secret/**']), makeEntry('/docs')] };
        worker._lastConfig = worker.config;
        worker.storage.searchFilesByKeyword = async () => [
            { path: '/docs/offline.md', filename: 'offline.md', modified: 1, size: 1, ref_count: 1 },
            { path: '/workspace/secret/hidden.md', filename: 'hidden.md', modified: 1, size: 1, ref_count: 1 },
            { path: '/workspace/keep.md', filename: 'keep.md', modified: 1, size: 1, ref_count: 1 }
        ];

        const result = await worker.searchIndexedFiles('md');

        assert.deepEqual(
            result.results.map((row) => row.path),
            ['/workspace/keep.md']
        );
    } finally {
        cleanup(worker.appDataDirectory);
    }
    console.log('  ✅ testSearchIndexedFilesDropsUnavailableAndExcluded');
}

async function testSearchIndexedFilesSemanticPartial() {
    console.log('  testSearchIndexedFilesSemanticPartial...');
    const worker = makeSearchWorker();
    try {
        worker.storage.mode = 'full';
        worker.storage.searchFilesByKeyword = async () => [
            { path: '/workspace/report.md', filename: 'report.md', modified: 1, size: 1, ref_count: 1 }
        ];
        worker.storage.searchFileByName = async () => {
            throw new Error('semantic down');
        };
        worker.storage.searchFileByContent = async () => ({ results: [] });

        const result = await worker.searchIndexedFiles('report');

        assert.equal(result.code, CODES.SEMANTIC_PARTIAL);
        assert.equal(result.results.length, 1);
    } finally {
        cleanup(worker.appDataDirectory);
    }
    console.log('  ✅ testSearchIndexedFilesSemanticPartial');
}

async function testSearchIndexedFilesKeywordFailureReturnsError() {
    console.log('  testSearchIndexedFilesKeywordFailureReturnsError...');
    const worker = makeSearchWorker();
    try {
        worker.storage.searchFilesByKeyword = async () => {
            throw new Error('keyword failed');
        };

        const result = await worker.searchIndexedFiles('report');

        assert.equal(result.results.length, 0);
        assert.equal(result.totalHits, 0);
        assert.equal(result.code, CODES.SEARCH_FAILED);
    } finally {
        cleanup(worker.appDataDirectory);
    }
    console.log('  ✅ testSearchIndexedFilesKeywordFailureReturnsError');
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
        assert.deepEqual(
            reader._lastConfig,
            makeConfig(scanDir),
            'readonly init should snapshot config for status sources'
        );
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

// ── Test: Task 7 repeated initialize does not self-contend ──────────

async function testTask7RepeatedInitializeKeepsWriterMode() {
    console.log('  testTask7RepeatedInitializeKeepsWriterMode...');
    const appDir = tmpDir('app-task7-repeat-init');
    const scanDir = tmpDir('scan-task7-repeat-init');
    let worker;
    try {
        Setting.updateInstanceData({ ...settingData, default_embedding_model: '' });
        fs.writeFileSync(
            path.join(globalAppDir, 'setting.json'),
            JSON.stringify({ ...settingData, default_embedding_model: '' }, null, 4)
        );

        fs.writeFileSync(path.join(scanDir, 'one.txt'), 'one', 'utf-8');
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.config = makeConfig(scanDir);

        await worker.initialize();
        assert.equal(worker._readonlyMode, false, 'first initialize should own the writer role');

        await worker.initialize();
        assert.equal(worker._readonlyMode, false, 'repeated initialize must not self-demote to readonly');

        const status = await worker.getFileSystemStatus();
        assert.notEqual(status.status, 'readonly', 'worker should keep writer status after repeated initialize');
    } finally {
        Setting.updateInstanceData(settingData);
        fs.writeFileSync(path.join(globalAppDir, 'setting.json'), JSON.stringify(settingData, null, 4));
        if (worker) await worker.finalize();
        cleanup(scanDir);
        cleanup(appDir);
    }
    console.log('  ✅ testTask7RepeatedInitializeKeepsWriterMode');
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

        const counts = await worker.storage.getPerRootCounts([scanDir]);
        assert.deepEqual(counts.get(scanDir), {
            total_files: 55,
            embedded_count: 0,
            pending_count: 0,
            failed_count: 0,
            last_scan_at: scanner.state.last_scan_at ?? null
        });
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

        const counts = await worker.storage.getPerRootCounts([scanDir]);
        assert.equal(counts.get(scanDir).total_files, 3, 'recovered root counts should reflect current files');
        assert.equal(counts.get(scanDir).last_scan_at, scanner.state.last_scan_at);
    } finally {
        if (worker) await worker.finalize();
        cleanup(scanDir);
        cleanup(appDir);
    }
    console.log('  ✅ testTask8RecoveredRootClearsUnavailableAndUpdatesLastFileCount');
}

async function testTask17DLastScanAtIncrementalAndFullScan() {
    console.log('  testTask17DLastScanAtIncrementalAndFullScan...');
    const scanDir = tmpDir('scan-task17d-last-scan-at');
    const appDir = tmpDir('app-task17d-last-scan-at');
    let worker;
    try {
        fs.writeFileSync(path.join(scanDir, 'a.txt'), 'a', 'utf-8');

        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.config = makeConfig(scanDir);
        await worker.initialize();
        await worker.taskQueue.onIdle();

        const scanner = worker.scanners.get(scanDir);
        assert.ok(scanner, 'scanner should exist');
        assert.ok(scanner.state.last_full_scan > 0, 'initial full scan should set last_full_scan');
        assert.ok(scanner.state.last_scan_at > 0, 'initial full scan should set last_scan_at');

        await new Promise((r) => setTimeout(r, 10));
        const pinnedFullScan = Date.now();
        scanner.state.last_full_scan = pinnedFullScan;
        const previousScanAt = scanner.state.last_scan_at;
        scanner._counter = 1;
        await worker.taskQueue.add(() => scanner.scan());
        await worker.taskQueue.onIdle();

        assert.equal(scanner.state.last_full_scan, pinnedFullScan, 'incremental scan must not move last_full_scan');
        assert.ok(scanner.state.last_scan_at > previousScanAt, 'incremental scan should update last_scan_at');

        await new Promise((r) => setTimeout(r, 10));
        scanner.state.last_full_scan = 0;
        scanner._counter = 32;
        const beforeFullScan = Date.now();
        await worker.taskQueue.add(() => scanner.scan());
        await worker.taskQueue.onIdle();

        assert.ok(scanner.state.last_full_scan >= beforeFullScan, 'full scan should update last_full_scan');
        assert.equal(
            scanner.state.last_scan_at,
            scanner.state.last_full_scan,
            'full scan should update both timestamps together'
        );
    } finally {
        if (worker) await worker.finalize();
        cleanup(scanDir);
        cleanup(appDir);
    }
    console.log('  ✅ testTask17DLastScanAtIncrementalAndFullScan');
}

async function testTask15StatusPushLayers() {
    console.log('  testTask15StatusPushLayers...');
    const appDir = tmpDir('app-task15-push');
    let worker;
    try {
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        const pushes = [];
        worker.callApp = async (method, payload) => {
            if (method === 'publishStatusChanged') pushes.push(payload);
        };

        worker._setStatus('running', 'unit-test');
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(pushes.at(-1)?.reason, 'status:running', 'status changes should publish immediately');

        worker._ensureStatusPushHooks();
        await worker.taskQueue.add(() => {});
        await worker.taskQueue.onIdle();
        await new Promise((r) => setTimeout(r, 10));
        assert.ok(
            pushes.some((payload) => payload.reason === 'task-done'),
            'task completion should publish'
        );

        worker._startStatusTick(5);
        await new Promise((r) => setTimeout(r, 20));
        worker._clearStatusTick();
        assert.equal(
            pushes.some((payload) => payload.reason === 'tick'),
            false,
            'status tick should not publish after storage is cleared'
        );

        worker.storage = {
            mode: 'base-only',
            scannerState: {
                last_embedding_task_at: null,
                last_rebuild_event: null,
                probe_permanent_error: null,
                unavailable_roots: {}
            },
            getStatus: async () => ({ db_size: 0, vecdb_size: 0, chunk_size: 0 }),
            getPerRootCounts: async () => new Map(),
            isDeferred: () => false,
            deferredReason: null,
            storage: { close: () => {} }
        };
        worker._startStatusTick(5);
        await new Promise((r) => setTimeout(r, 20));
        worker._clearStatusTick();
        assert.ok(
            pushes.some((payload) => payload.reason === 'tick'),
            'status tick should publish while storage is active'
        );
        worker.storage = null;
    } finally {
        if (worker) await worker.finalize();
        cleanup(appDir);
    }
    console.log('  ✅ testTask15StatusPushLayers');
}

async function testScannerIntervalUsesWorkspaceAndEmbeddingState() {
    console.log('  testScannerIntervalUsesWorkspaceAndEmbeddingState...');
    const appDir = tmpDir('app-workspace-intervals');
    let worker;
    try {
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.config = { entries: [makeEntry('/workspace'), makeEntry('/docs')] };
        worker._lastConfig = worker.config;
        worker._currentWorkspace = '/workspace';

        worker.storage = { mode: 'base-only' };
        assert.equal(worker._getScanIntervalForRoot('/workspace'), 60 * 1000);
        worker._embeddingQueueScheduled = true;
        assert.equal(worker._getScanIntervalForRoot('/workspace'), 60 * 1000);
        assert.equal(worker._getScanIntervalForRoot('/docs'), 5 * 60 * 1000);

        worker.storage = { mode: 'full' };
        worker._embeddingQueueScheduled = true;
        assert.equal(worker._getScanIntervalForRoot('/workspace'), 180 * 1000);
        worker._embeddingQueueScheduled = false;
        worker._embeddingQueueActive = true;
        assert.equal(worker._getScanIntervalForRoot('/workspace'), 180 * 1000);
        assert.equal(worker._getScanIntervalForRoot('/docs'), 5 * 60 * 1000);
    } finally {
        if (worker) await worker.finalize();
        cleanup(appDir);
    }
    console.log('  ✅ testScannerIntervalUsesWorkspaceAndEmbeddingState');
}

async function testEmbeddingQueueOnlySchedulesInFullMode() {
    console.log('  testEmbeddingQueueOnlySchedulesInFullMode...');
    const appDir = tmpDir('app-embedding-queue-mode');
    let worker;
    try {
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.storage = { mode: 'base-only' };
        worker._enqueueEmbeddingQueue();
        assert.equal(worker._embeddingQueueScheduled, false);

        let processed = false;
        worker.storage = {
            mode: 'full',
            processEmbeddingQueue: async () => {
                processed = true;
                return 0;
            }
        };
        worker.taskQueue.pause();
        worker._enqueueEmbeddingQueue();
        assert.equal(worker._embeddingQueueScheduled, true);
        worker.taskQueue.start();
        await worker.taskQueue.onIdle();
        assert.equal(processed, true);
        assert.equal(worker._embeddingQueueScheduled, false);
        assert.equal(worker._embeddingQueueActive, false);
    } finally {
        if (worker) await worker.finalize();
        cleanup(appDir);
    }
    console.log('  ✅ testEmbeddingQueueOnlySchedulesInFullMode');
}

async function testEmbeddingQueueFailureIsHandled() {
    console.log('  testEmbeddingQueueFailureIsHandled...');
    const appDir = tmpDir('app-embedding-queue-failure');
    let worker;
    try {
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.callApp = () => {};
        worker.storage = {
            mode: 'full',
            processEmbeddingQueue: async () => {
                throw new Error('embedding queue boom');
            }
        };

        worker._enqueueEmbeddingQueue();
        await worker.taskQueue.onIdle();
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(worker._embeddingQueueScheduled, false);
        assert.equal(worker._embeddingQueueActive, false);

        let processedAfterFailure = false;
        worker.storage = {
            mode: 'full',
            processEmbeddingQueue: async () => {
                processedAfterFailure = true;
                return 0;
            }
        };

        worker._enqueueEmbeddingQueue();
        await worker.taskQueue.onIdle();

        assert.equal(processedAfterFailure, true);
        assert.equal(worker._embeddingQueueScheduled, false);
        assert.equal(worker._embeddingQueueActive, false);
    } finally {
        if (worker) await worker.finalize();
        cleanup(appDir);
    }
    console.log('  ✅ testEmbeddingQueueFailureIsHandled');
}

async function testEmbeddingQueueYieldsToPendingConfigChange() {
    console.log('  testEmbeddingQueueYieldsToPendingConfigChange...');
    const appDir = tmpDir('app-embedding-queue-config-yield');
    let worker;
    try {
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        let shouldYieldBeforeConfigApplied = null;
        let shouldYieldAfterConfigApplied = null;
        worker.storage = {
            mode: 'full',
            processEmbeddingQueue: async (shouldYield) => {
                shouldYieldBeforeConfigApplied = shouldYield();
                worker._pendingConfigChange = null;
                shouldYieldAfterConfigApplied = shouldYield();
                return 0;
            }
        };
        worker._scanPending = false;
        worker._pendingConfigChange = { entries: [makeEntry('/new-root')] };

        worker._enqueueEmbeddingQueue();
        await worker.taskQueue.onIdle();

        assert.equal(shouldYieldBeforeConfigApplied, true);
        assert.equal(shouldYieldAfterConfigApplied, false);
    } finally {
        if (worker) await worker.finalize();
        cleanup(appDir);
    }
    console.log('  ✅ testEmbeddingQueueYieldsToPendingConfigChange');
}

async function testStartupConfigChangeMarksPendingConfigForEmbeddingQueueYield() {
    console.log('  testStartupConfigChangeMarksPendingConfigForEmbeddingQueueYield...');
    const appDir = tmpDir('app-startup-config-embedding-queue');
    let worker;
    try {
        worker = new FileManagerWorker('com.test.filemgr', appDir);

        await worker.applicationConfigChanged({ entries: [makeEntry('/startup-root')] });
        assert.deepEqual(worker._pendingConfigChange, { entries: [makeEntry('/startup-root')] });

        let shouldYieldAtQueueStart = null;
        worker.storage = {
            mode: 'full',
            processEmbeddingQueue: async (shouldYield) => {
                shouldYieldAtQueueStart = shouldYield();
                return 0;
            }
        };
        worker._scanPending = false;

        worker._enqueueEmbeddingQueue();
        await worker.taskQueue.onIdle();

        assert.equal(shouldYieldAtQueueStart, true);
    } finally {
        if (worker) await worker.finalize();
        cleanup(appDir);
    }
    console.log('  ✅ testStartupConfigChangeMarksPendingConfigForEmbeddingQueueYield');
}

async function testWorkspaceChangedForExistingEntryForcesFullScanAndImmediateScan() {
    console.log('  testWorkspaceChangedForExistingEntryForcesFullScanAndImmediateScan...');
    const appDir = tmpDir('app-workspace-force-scan');
    let worker;
    try {
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        const config = { entries: [makeEntry('/workspace'), makeEntry('/docs')] };
        worker.config = config;
        worker._lastConfig = config;
        worker.status = 'running';
        worker.storage = {
            mode: 'base-only',
            scannerState: {
                roots: {
                    '/workspace': {
                        last_full_scan: 12345,
                        last_scan_at: 67890,
                        total_files: 1,
                        last_file_count: 1
                    },
                    '/docs': {
                        last_full_scan: 22222,
                        last_scan_at: 33333,
                        total_files: 1,
                        last_file_count: 1
                    }
                },
                probe_permanent_error: null,
                unavailable_roots: {},
                last_rebuild_event: null,
                last_embedding_task_at: null
            },
            saveScannerState: async () => {},
            getStatus: async () => ({ db_size: 0, vecdb_size: 0, chunk_size: 0 }),
            getPerRootCounts: async (roots) =>
                new Map(
                    roots.map((root) => [
                        root,
                        {
                            total_files: 1,
                            embedded_count: 0,
                            pending_count: 1,
                            failed_count: 0,
                            last_scan_at: worker.storage.scannerState.roots[root]?.last_scan_at ?? null
                        }
                    ])
                ),
            isDeferred: () => false,
            deferredReason: null
        };

        let restartCalled = false;
        worker._restartScanners = async () => {
            restartCalled = true;
        };
        const pushes = [];
        worker.callApp = (method, payload) => {
            if (method === 'publishStatusChanged') pushes.push(payload);
        };

        let workspaceScanRequests = 0;
        let docsScanRequests = 0;
        worker.scanners.set('/workspace', {
            root: '/workspace',
            entry: config.entries[0],
            state: worker.storage.scannerState.roots['/workspace'],
            isRunning: () => true,
            stop: async () => {},
            requestImmediateScan: () => {
                workspaceScanRequests++;
            }
        });
        worker.scanners.set('/docs', {
            root: '/docs',
            entry: config.entries[1],
            state: worker.storage.scannerState.roots['/docs'],
            isRunning: () => true,
            stop: async () => {},
            requestImmediateScan: () => {
                docsScanRequests++;
            }
        });

        await worker.workspaceChanged('/workspace');

        assert.equal(worker._currentWorkspace, '/workspace');
        assert.equal(worker.storage.scannerState.roots['/workspace'].last_full_scan, 0);
        assert.equal(worker.storage.scannerState.roots['/workspace'].last_scan_at, 67890);
        assert.equal(worker.storage.scannerState.roots['/docs'].last_full_scan, 22222);
        assert.equal(restartCalled, false);
        assert.equal(workspaceScanRequests, 1);
        assert.equal(docsScanRequests, 0);
        assert.equal(pushes.at(-1)?.reason, 'workspace');
        assert.equal(pushes.at(-1)?.snapshot.default_workspace, '/workspace');
        assert.equal(
            pushes.at(-1)?.snapshot.sources.find((source) => source.root === '/workspace')?.is_workspace,
            true
        );
        assert.equal(pushes.at(-1)?.snapshot.sources.find((source) => source.root === '/docs')?.is_workspace, false);
    } finally {
        if (worker) await worker.finalize();
        cleanup(appDir);
    }
    console.log('  ✅ testWorkspaceChangedForExistingEntryForcesFullScanAndImmediateScan');
}

async function testApplicationConfigChangedPassesActiveRootsToEmbeddingQueue() {
    console.log('  testApplicationConfigChangedPassesActiveRootsToEmbeddingQueue...');
    const appDir = tmpDir('app-config-active-roots');
    let worker;
    try {
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        const config = { entries: [makeEntry('/workspace'), makeEntry('/docs')] };
        worker.config = config;
        worker._lastConfig = { entries: [] };
        worker.status = 'running';
        worker._currentWorkspace = '/stale-workspace';
        Setting.updateInstanceData({
            ...settingData,
            default_workspace: '/workspace',
            applications: { filemgr: config }
        });

        let queueOptions = null;
        worker.storage = {
            mode: 'full',
            scannerState: {
                roots: {},
                probe_permanent_error: null,
                unavailable_roots: {},
                last_rebuild_event: null,
                last_embedding_task_at: null
            },
            saveScannerState: async () => {},
            syncEmbeddingMode: async () => {},
            syncEmbeddingModeForStartup: async () => {},
            processEmbeddingQueue: async (_isScanPending, options) => {
                queueOptions = options;
                return 0;
            },
            removeOrphanedItems: async () => ({ deleted: 0 }),
            getStatus: async () => ({ db_size: 0, vecdb_size: 0, chunk_size: 0 }),
            getPerRootCounts: async () => new Map(),
            isDeferred: () => false,
            deferredReason: null
        };
        worker._restartScanners = async () => {};

        await worker.applicationConfigChanged(config);
        await worker.taskQueue.onIdle();

        assert.deepEqual(queueOptions?.activeRoots, ['/workspace', '/docs']);
        assert.equal(queueOptions?.currentWorkspace, '/workspace');
    } finally {
        Setting.updateInstanceData(settingData);
        if (worker) await worker.finalize();
        cleanup(appDir);
    }
    console.log('  ✅ testApplicationConfigChangedPassesActiveRootsToEmbeddingQueue');
}

async function testTask16V3ConfigChangeCases() {
    console.log('  testTask16V3ConfigChangeCases...');

    async function withWorker(name, entries, setup) {
        const appDir = tmpDir(`app-task16-${name}`);
        let worker;
        try {
            worker = new FileManagerWorker('com.test.filemgr', appDir);
            worker.config = { entries };
            await setup(worker);
        } finally {
            if (worker) await worker.finalize();
            cleanup(appDir);
        }
    }

    const upgradeRoot = tmpDir('task16-upgrade-root');
    try {
        const src = path.join(upgradeRoot, 'src');
        fs.mkdirSync(src, { recursive: true });
        const file = path.join(src, 'feature.md');
        fs.writeFileSync(file, '# feature', 'utf-8');
        await withWorker('upgrade', [makeEntry(src)], async (worker) => {
            await worker.initialize();
            await worker.taskQueue.onIdle();
            await worker.storage.storage.update([{ item_id: file, item_type: 'file', embedded: 1 }], {
                indexers: ['BaseIndexer']
            });

            await worker.applicationConfigChanged({ entries: [makeEntry(upgradeRoot)] });
            await worker.taskQueue.onIdle();

            const row = await getBaseRow(worker, file);
            assertRootRefs(row, [upgradeRoot]);
            assert.equal(row.embedded, 1, 'parent scan should adopt without resetting embedded');
        });
    } finally {
        cleanup(upgradeRoot);
    }

    const multiRoot = tmpDir('task16-delete-overlap');
    try {
        const src = path.join(multiRoot, 'src');
        const docs = path.join(multiRoot, 'docs');
        fs.mkdirSync(src, { recursive: true });
        fs.mkdirSync(docs, { recursive: true });
        const srcFile = path.join(src, 'old.md');
        const docsFile = path.join(docs, 'keep.md');
        fs.writeFileSync(srcFile, '# old', 'utf-8');
        fs.writeFileSync(docsFile, '# keep', 'utf-8');
        await withWorker('delete-overlap', [makeEntry(src), makeEntry(docs)], async (worker) => {
            await worker.initialize();
            await worker.taskQueue.onIdle();

            await worker.applicationConfigChanged({ entries: [makeEntry(docs)] });
            await worker.taskQueue.onIdle();

            assert.equal(await getOptionalBaseRow(worker, srcFile), null, 'removed non-overlap root should be deleted');
            assert.ok(await getOptionalBaseRow(worker, docsFile), 'remaining root should stay indexed');
        });
    } finally {
        cleanup(multiRoot);
    }

    const deleteAll = tmpDir('task16-delete-all');
    try {
        const src = path.join(deleteAll, 'src');
        fs.mkdirSync(src, { recursive: true });
        const file = path.join(src, 'gone.md');
        fs.writeFileSync(file, '# gone', 'utf-8');
        await withWorker('delete-all', [makeEntry(src)], async (worker) => {
            await worker.initialize();
            await worker.taskQueue.onIdle();

            await worker.applicationConfigChanged({ entries: [] });
            await worker.taskQueue.onIdle();

            assert.equal(await getOptionalBaseRow(worker, file), null, 'delete-all should remove indexed rows');
            assert.deepEqual(worker.storage.scannerState.roots, {});
            assert.equal(worker.status, 'idle');
        });
    } finally {
        cleanup(deleteAll);
    }

    const excludeRoot = tmpDir('task16-exclude');
    try {
        const src = path.join(excludeRoot, 'src');
        fs.mkdirSync(src, { recursive: true });
        const file = path.join(src, 'excluded.md');
        fs.writeFileSync(file, '# excluded', 'utf-8');
        await withWorker('exclude', [makeEntry(excludeRoot, [])], async (worker) => {
            await worker.initialize();
            await worker.taskQueue.onIdle();
            assert.ok(await getOptionalBaseRow(worker, file));

            await worker.applicationConfigChanged({ entries: [makeEntry(excludeRoot, ['src/**'])] });
            await worker.taskQueue.onIdle();

            assert.equal(await getOptionalBaseRow(worker, file), null, 'exclude addition should physically delete row');
        });
    } finally {
        cleanup(excludeRoot);
    }

    const carveRoot = tmpDir('task16-carve');
    try {
        const src = path.join(carveRoot, 'src');
        fs.mkdirSync(src, { recursive: true });
        const file = path.join(src, 'carve.md');
        fs.writeFileSync(file, '# carve', 'utf-8');
        await withWorker('carve', [makeEntry(carveRoot, [])], async (worker) => {
            await worker.initialize();
            await worker.taskQueue.onIdle();
            await worker.storage.storage.update([{ item_id: file, item_type: 'file', embedded: 1 }], {
                indexers: ['BaseIndexer']
            });

            await worker.applicationConfigChanged({
                entries: [makeEntry(carveRoot, ['src/**']), makeEntry(src, [])]
            });
            await worker.taskQueue.onIdle();

            const row = await getBaseRow(worker, file);
            assertRootRefs(row, [src]);
            assert.equal(row.embedded, 1, 'carve-out child scan should avoid duplicate embedding');
        });
    } finally {
        cleanup(carveRoot);
    }

    console.log('  ✅ testTask16V3ConfigChangeCases');
}

async function testTask16ConfigChangeDedup() {
    console.log('  testTask16ConfigChangeDedup...');
    const appDir = tmpDir('app-task16-dedup');
    let worker;
    let release;
    try {
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.config = { entries: [makeEntry('/old')] };
        worker._lastConfig = worker.config;
        worker.storage = {
            mode: 'base-only',
            scannerState: { roots: {} },
            detachRootForConfigChange: async () => {},
            saveScannerState: async () => {},
            syncEmbeddingMode: async () => {},
            syncEmbeddingModeForStartup: async () => {},
            processEmbeddingQueue: async () => 0
        };
        worker._restartScanners = async () => {
            restartedWith.push(worker.config.entries.map((entry) => entry.root).join(','));
        };
        const restartedWith = [];
        const blocker = worker.runSequentially(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                })
        );

        const first = worker.applicationConfigChanged({ entries: [makeEntry('/first')] });
        const second = worker.applicationConfigChanged({ entries: [makeEntry('/second')] });
        release();
        await Promise.all([blocker, first, second]);

        assert.deepEqual(restartedWith, ['/second'], 'older queued config change should be skipped');
    } finally {
        if (worker) await worker.finalize();
        cleanup(appDir);
    }
    console.log('  ✅ testTask16ConfigChangeDedup');
}

async function testConfigChangeDuringInitializeDoesNotDropRemovedRoots() {
    console.log('  testConfigChangeDuringInitializeDoesNotDropRemovedRoots...');
    const appDir = tmpDir('app-config-change-initialize');
    let worker;
    try {
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        const oldConfig = { entries: [makeEntry('/old-root')] };
        const nextConfig = { entries: [makeEntry('/new-root')] };
        const detachedRoots = [];
        worker.config = oldConfig;
        worker._lastConfig = oldConfig;
        worker.storage = {
            mode: 'base-only',
            scannerState: { roots: {} },
            detachRootForConfigChange: async (root) => {
                detachedRoots.push(root);
                return { deleted: 0, detached: 0 };
            },
            saveScannerState: async () => {},
            syncEmbeddingMode: async () => {},
            syncEmbeddingModeForStartup: async () => {}
        };
        worker._restartScanners = async () => {};
        worker._enqueueEmbeddingQueue = () => {};

        worker._initializing = true;
        await worker.applicationConfigChanged(nextConfig);
        worker._initializing = false;
        await worker.applicationConfigChanged(nextConfig);

        assert.ok(detachedRoots.includes('/old-root'), 'removed root should be detached after worker becomes ready');
    } finally {
        if (worker) await worker.finalize();
        cleanup(appDir);
    }
    console.log('  ✅ testConfigChangeDuringInitializeDoesNotDropRemovedRoots');
}

async function testInitializeSchedulesProbeContinuationBeforeStartingScanners() {
    console.log('  testInitializeSchedulesProbeContinuationBeforeStartingScanners...');
    const appDir = tmpDir('app-init-continuation');
    const scanDir = tmpDir('scan-init-continuation');
    const originalInitialize = FSStorage.prototype.initialize;
    let worker;
    let initOptions;
    let releaseProbe;
    const probeBlocker = new Promise((resolve) => {
        releaseProbe = resolve;
    });

    try {
        FSStorage.prototype.initialize = async function (options) {
            initOptions = options;
            this.mode = 'base-only';
            this.scannerState = { roots: {} };
            this.storage = { close() {} };
            this.saveScannerState = async () => {};
            this.syncEmbeddingModeForStartup = async () => probeBlocker;
            this.getStatus = async () => ({ db_size: 0, vecdb_size: 0, chunk_size: 0 });
            this.getPerRootCounts = async () => new Map();
        };

        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.config = { entries: [makeEntry(scanDir)] };
        worker._emitStatusChanged = async () => {};
        let startCalls = 0;
        worker._startScanners = async () => {
            startCalls++;
        };

        await worker.initialize();

        assert.deepEqual(initOptions, { syncEmbedding: false });
        assert.equal(worker.status, 'initializing');
        assert.equal(startCalls, 0, 'scanner startup must wait for probe continuation');

        releaseProbe();
        await worker.taskQueue.onIdle();
        assert.equal(startCalls, 1);
    } finally {
        FSStorage.prototype.initialize = originalInitialize;
        if (worker) await worker.finalize();
        cleanup(scanDir);
        cleanup(appDir);
    }
    console.log('  ✅ testInitializeSchedulesProbeContinuationBeforeStartingScanners');
}

async function testApplicationConfigChangedSyncsModeBeforeRestartingScanners() {
    console.log('  testApplicationConfigChangedSyncsModeBeforeRestartingScanners...');
    const appDir = tmpDir('app-config-sync-order');
    let worker;
    try {
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        const order = [];
        worker.status = 'running';
        worker._initializing = false;
        worker._readonlyMode = false;
        worker._lastConfig = { entries: [makeEntry('/old-root')] };
        worker._emitStatusChanged = async () => {};
        worker.storage = {
            mode: 'base-only',
            scannerState: { roots: {} },
            syncEmbeddingModeForStartup: async () => {
                order.push('sync');
            },
            syncEmbeddingMode: async () => {
                order.push('legacy-sync');
            },
            saveScannerState: async () => {},
            storage: { close() {} }
        };
        worker._detachRemovedRoots = async () => {
            order.push('detach');
            return new Set(['/old-root']);
        };
        worker._restartScanners = async () => {
            order.push('restart');
        };
        worker._enqueueEmbeddingQueue = () => {
            order.push('queue');
        };

        await worker.applicationConfigChanged({ entries: [makeEntry('/new-root')] });

        assert.deepEqual(order.slice(0, 3), ['sync', 'detach', 'restart']);
        assert.equal(worker._pendingConfigChange, null);
    } finally {
        if (worker) await worker.finalize();
        cleanup(appDir);
    }
    console.log('  ✅ testApplicationConfigChangedSyncsModeBeforeRestartingScanners');
}

async function testInitializeReconcilesStaleScannerStateRoots() {
    console.log('  testInitializeReconcilesStaleScannerStateRoots...');
    const appDir = tmpDir('app-reconcile-stale-scanner-roots');
    let worker;
    try {
        const currentRoot = path.join(appDir, 'current');
        const staleRoot = path.join(appDir, 'stale');
        fs.mkdirSync(currentRoot, { recursive: true });
        fs.writeFileSync(path.join(currentRoot, 'keep.md'), '# keep', 'utf-8');
        fs.mkdirSync(appDir, { recursive: true });
        fs.writeFileSync(
            path.join(appDir, 'scanner_state.json'),
            JSON.stringify({
                version: 1,
                roots: {
                    [staleRoot]: {
                        last_full_scan: 123,
                        last_scan_at: 123,
                        total_files: 10,
                        last_file_count: 10
                    }
                }
            }),
            'utf-8'
        );

        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.config = { entries: [makeEntry(currentRoot)] };
        await worker.initialize();
        await worker.taskQueue.onIdle();

        assert.equal(worker.storage.scannerState.roots[staleRoot], undefined);
        assert.ok(worker.storage.scannerState.roots[currentRoot], 'current root should remain in scanner state');
    } finally {
        if (worker) await worker.finalize();
        cleanup(appDir);
    }
    console.log('  ✅ testInitializeReconcilesStaleScannerStateRoots');
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
        testSearchIndexedFilesRouteSelectionKeepsExpectedGroups,
        testTask5StartScannersDedupesRoots,
        testResetFileSystemStorageUsesManualResetReason,
        testTask7ReadonlyModeWhenScanLockHeld,
        testTask7ScanLockCreatesDirectoryAndFinalizeReleases,
        testTask7ReadonlyResetAndRebuildAreGuarded,
        testTask8UnavailableRootForcesFullScanDepth,
        testTask8EmptyFullScanMarksRootUnavailableAndPreservesIndex,
        testTask8RecoveredRootClearsUnavailableAndUpdatesLastFileCount,
        testTask17DLastScanAtIncrementalAndFullScan,
        testTask15StatusPushLayers,
        testSemanticWriteCapacityAlertOnlyForVectorLimit,
        testScannerIntervalUsesWorkspaceAndEmbeddingState,
        testEmbeddingQueueOnlySchedulesInFullMode,
        testEmbeddingQueueFailureIsHandled,
        testStartupConfigChangeMarksPendingConfigForEmbeddingQueueYield,
        testWorkspaceChangedForExistingEntryForcesFullScanAndImmediateScan,
        testApplicationConfigChangedPassesActiveRootsToEmbeddingQueue,
        testInitializeSchedulesProbeContinuationBeforeStartingScanners,
        testApplicationConfigChangedSyncsModeBeforeRestartingScanners,
        testTask16V3ConfigChangeCases,
        testTask16ConfigChangeDedup,
        testConfigChangeDuringInitializeDoesNotDropRemovedRoots,
        testInitializeReconcilesStaleScannerStateRoots,
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
