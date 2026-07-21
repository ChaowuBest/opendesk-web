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
import { saveEntries } from '../../../../main/applications/filemgr/renderer/adapter.js';
import { FSEntrySchema } from '../../../../main/applications/filemgr/setting.js';

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
            testProbeErrorAlertsUseStableCodes,
            testTask7ScanLockCreatesDirectoryAndFinalizeReleases,
            testGetFileSystemStatusSkipsStorageSnapshotBeforeReady,
            testEmptyScannedSourceStateIsCompleted,
            testInitializeSchedulesProbeContinuationBeforeStartingScanners,
            testApplicationConfigChangedSyncsModeBeforeRestartingScanners,
            testIncrementalScanIndexesMovedOldFileByCtime,
            testScanYieldsToPendingConfigChangeBeforeNextBatch,
            testIncrementalScanYieldsDuringGlobWhenNoFilesChanged,
            testFullScanYieldsAfterRemoveDeletedFilesBeforeCheckpoint,
            testStatusUsesPendingConfigWhenConfigChangeQueued,
            testConfigChangeKeepsPendingConfigVisibleUntilLastConfigUpdates,
            testInitializeClearsEquivalentPendingConfigBeforeStartingScanners,
            testReconcileConfigAppliesExplicitLatestConfig,
            testReconcileConfigNormalizesExplicitLatestConfigBeforeComparing,
            testApplicationConfigChangedNormalizesRawEntries,
            testSaveEntriesPassesExplicitConfigToWorkerReconcile,
            testSourceConfigPendingDoesNotLeakOnEarlyReturn,
            testWorkspacePendingControlLifecycle,
            testEmbeddingPendingControlLifecycle,
            testSkippedScanTaskDoesNotLeaveScanPending,
            testEmbeddingQueueDoesNotStartDuringPendingControlChange,
            testSetSourcePausedStopsScannerPersistsAndReturnsSnapshot,
            testSetSourcePausedResumeStartsScannerBeforeSuccess,
            testSetSourcePausedYieldsScannerWithinCandidateBoundary,
            testSetSourcePausedFinishesCurrentSaveBatchOnly,
            testSetSourcePausedYieldsEmbeddingAfterCurrentFile,
            testPausedRootStaysStoppedAcrossConfigRestart,
            testPausedStateSurvivesRestartRetainsSearchAndFullReset,
            testSourceControlRequestsAreFifoIdempotentAndRootLocal,
            testPausedRootSurvivesConfigEmbeddingAndWorkspaceLifecycles,
            testSourceControlValidationReadonlyAndDeferredWriter,
            testSourceControlPersistenceFailuresRollbackDiskMemoryAndRuntime,
            testSourceControlRuntimeFailuresAndStoppedScannerRecovery,
            testAllPausedRootsDoNotFallBackToUnfilteredEmbedding,
            testSourceControlReturnsDegradedAuthoritativeSnapshot,
            testQueuedRootRemovalWinsOverPauseRequest,
            testEmbeddingConfigChangedKeepsPausedOnlyRowsPending,
            testMultiPathSubsetRunsEachRouteOnce,
            testMultiPathChangePreservesConfiguredSinglePathAndRejectsInvalidSinglePath,
            testMultiPathAllConfiguredSourcesIncludingPausedBecomeUnscoped,
            testMultiPathInvalidNeverCallsARouteOrFallsBackUnscoped,
            testMultiPathWhollyUnavailableSelectedPathFailsButPausedDoesNot,
            testMultiPathRequestedUnionFiltersBackendLeakEvenAfterAllSourceOptimization,
            testMultiPathSelectedSourceRemovalDuringSearchFailsClosed,
            testMultiPathFinalStatWindowReappliesLatestScopePolicy,
            testMultiPathScopeValidationHasDeterministicErrorPriority
        ].filter((test) => test.name.includes(filter));
        if (filteredTests.length === 0) {
            console.error(`No no-API worker tests matched TEST_FILTER=${filter}`);
            cleanup(globalAppDir);
            process.exit(1);
        }
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
    await testIncrementalScanIndexesMovedOldFileByCtime();
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
    await testSearchIndexedFilesExplicitZeroRoutesDoNotCallStorage();
    await testSearchIndexedFilesScopedRouteBudgetsAndOutcomes();
    await testMultiPathSubsetRunsEachRouteOnce();
    await testMultiPathChangePreservesConfiguredSinglePathAndRejectsInvalidSinglePath();
    await testMultiPathAllConfiguredSourcesIncludingPausedBecomeUnscoped();
    await testMultiPathInvalidNeverCallsARouteOrFallsBackUnscoped();
    await testMultiPathWhollyUnavailableSelectedPathFailsButPausedDoesNot();
    await testMultiPathRequestedUnionFiltersBackendLeakEvenAfterAllSourceOptimization();
    await testMultiPathSelectedSourceRemovalDuringSearchFailsClosed();
    await testMultiPathFinalStatWindowReappliesLatestScopePolicy();
    await testMultiPathScopeValidationHasDeterministicErrorPriority();
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
    await testProbeErrorAlertsUseStableCodes();
    await testGetFileSystemStatusSkipsStorageSnapshotBeforeReady();
    await testEmptyScannedSourceStateIsCompleted();
    await testScannerIntervalUsesWorkspaceAndEmbeddingState();
    await testEmbeddingQueueOnlySchedulesInFullMode();
    await testEmbeddingQueueFailureIsHandled();
    await testEmbeddingQueueYieldsToPendingConfigChange();
    await testScanYieldsToPendingConfigChangeBeforeNextBatch();
    await testIncrementalScanYieldsDuringGlobWhenNoFilesChanged();
    await testFullScanYieldsAfterRemoveDeletedFilesBeforeCheckpoint();
    await testStatusUsesPendingConfigWhenConfigChangeQueued();
    await testConfigChangeKeepsPendingConfigVisibleUntilLastConfigUpdates();
    await testInitializeClearsEquivalentPendingConfigBeforeStartingScanners();
    await testReconcileConfigAppliesExplicitLatestConfig();
    await testReconcileConfigNormalizesExplicitLatestConfigBeforeComparing();
    await testApplicationConfigChangedNormalizesRawEntries();
    await testSaveEntriesPassesExplicitConfigToWorkerReconcile();
    await testSourceConfigPendingDoesNotLeakOnEarlyReturn();
    await testWorkspacePendingControlLifecycle();
    await testEmbeddingPendingControlLifecycle();
    await testSkippedScanTaskDoesNotLeaveScanPending();
    await testEmbeddingQueueDoesNotStartDuringPendingControlChange();
    await testSetSourcePausedStopsScannerPersistsAndReturnsSnapshot();
    await testSetSourcePausedResumeStartsScannerBeforeSuccess();
    await testSetSourcePausedYieldsScannerWithinCandidateBoundary();
    await testSetSourcePausedFinishesCurrentSaveBatchOnly();
    await testSetSourcePausedYieldsEmbeddingAfterCurrentFile();
    await testPausedRootStaysStoppedAcrossConfigRestart();
    await testPausedStateSurvivesRestartRetainsSearchAndFullReset();
    await testSourceControlRequestsAreFifoIdempotentAndRootLocal();
    await testPausedRootSurvivesConfigEmbeddingAndWorkspaceLifecycles();
    await testSourceControlValidationReadonlyAndDeferredWriter();
    await testSourceControlPersistenceFailuresRollbackDiskMemoryAndRuntime();
    await testSourceControlRuntimeFailuresAndStoppedScannerRecovery();
    await testAllPausedRootsDoNotFallBackToUnfilteredEmbedding();
    await testSourceControlReturnsDegradedAuthoritativeSnapshot();
    await testQueuedRootRemovalWinsOverPauseRequest();
    await testEmbeddingConfigChangedKeepsPausedOnlyRowsPending();
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
        await worker.storage._setProbeError('dim_unsupported');
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

        const contentResult = await worker.searchIndexedFiles('authentication', { routes: ['content_semantic'] });
        assert.ok(contentResult.query === 'authentication', 'content search should have query field');
        assert.ok(Array.isArray(contentResult.results), 'content search should have results array');
        assert.ok(contentResult.results.length > 0, 'content search should find results');
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

async function testIncrementalScanIndexesMovedOldFileByCtime() {
    console.log('  testIncrementalScanIndexesMovedOldFileByCtime...');
    const scanDir = tmpDir('scan-incr-moved-old');
    const stagingDir = tmpDir('scan-incr-moved-old-staging');
    const appDir = tmpDir('app-incr-moved-old');
    let worker;
    try {
        fs.writeFileSync(path.join(scanDir, 'existing.txt'), 'already indexed', 'utf-8');

        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.config = makeConfig(scanDir);
        await worker.initialize();
        await worker.taskQueue.onIdle();

        const scanner = worker.scanners.get(scanDir);
        const firstScanTime = scanner.state.last_full_scan;
        assert.ok(firstScanTime > 0, 'initial full scan should complete');

        const sourcePath = path.join(stagingDir, 'moved-old.txt');
        const movedPath = path.join(scanDir, 'moved-old.txt');
        fs.writeFileSync(sourcePath, 'old content moved into root', 'utf-8');
        const oldTimestamp = firstScanTime - 60_000;
        fs.utimesSync(sourcePath, oldTimestamp / 1000, oldTimestamp / 1000);

        await new Promise((r) => setTimeout(r, 20));
        fs.renameSync(sourcePath, movedPath);

        const movedStat = fs.statSync(movedPath);
        assert.ok(
            Math.floor(movedStat.mtimeMs) < firstScanTime,
            'moved file mtime should be older than last full scan'
        );
        assert.ok(Math.floor(movedStat.ctimeMs) > firstScanTime, 'move should bump ctime after last full scan');

        scanner._counter = 1;
        await worker.taskQueue.add(() => scanner.scan());
        await worker.taskQueue.onIdle();

        const row = await getOptionalBaseRow(worker, movedPath);
        assert.ok(row, 'moved old file should be indexed by incremental scan');
    } finally {
        if (worker) await worker.finalize();
        cleanup(scanDir);
        cleanup(stagingDir);
        cleanup(appDir);
    }
    console.log('  ✅ testIncrementalScanIndexesMovedOldFileByCtime');
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

async function testProbeErrorAlertsUseStableCodes() {
    console.log('  testProbeErrorAlertsUseStableCodes...');
    const appDir = tmpDir('probe-error-alerts');
    const worker = new FileManagerWorker('com.test.filemgr', appDir);
    try {
        worker.storage = {
            scannerState: {
                probe_error: { code: 'dim_unsupported', ts: Date.now() }
            }
        };
        assert.deepEqual(worker._buildAlerts('running', 'base-only'), [{ code: 'dim_unsupported' }]);

        worker.storage.scannerState.probe_error = { code: 'embedding_config_error', ts: Date.now() };
        assert.deepEqual(worker._buildAlerts('running', 'base-only'), [{ code: 'embedding_unavailable' }]);
    } finally {
        cleanup(appDir);
    }
    console.log('  ✅ testProbeErrorAlertsUseStableCodes');
}

async function testGetFileSystemStatusSkipsStorageSnapshotBeforeReady() {
    console.log('  testGetFileSystemStatusSkipsStorageSnapshotBeforeReady...');
    const appDir = tmpDir('status-before-ready');
    const scanDir = tmpDir('status-before-ready-scan');
    const worker = new FileManagerWorker('com.test.filemgr', appDir);
    try {
        let getStatusCalls = 0;
        worker.status = 'initializing';
        worker._lastConfig = makeConfig(scanDir);
        worker.storage = {
            mode: 'base-only',
            scannerState: {
                roots: {},
                probe_error: null,
                unavailable_roots: {},
                last_rebuild_event: null,
                last_embedding_task_at: null
            },
            getStatus: async () => {
                getStatusCalls++;
                throw new Error('BaseIndexer not initialized. Call initialize() first.');
            },
            isDeferred: () => false,
            deferredReason: null
        };

        const status = await worker.getFileSystemStatus();

        assert.equal(getStatusCalls, 0, 'initializing status snapshot must not query storage/indexers');
        assert.equal(status.status, 'initializing');
        assert.equal(status.mode, null);
        assert.equal(status.totals, null);
        assert.equal(status.storage_stats, null);
        assert.equal(status.storage, null);
        assert.equal(status.sources.length, 1);
        assert.equal(status.sources[0].root, scanDir);
        assert.equal(status.sources[0].state, 'pending');
    } finally {
        cleanup(scanDir);
        cleanup(appDir);
    }
    console.log('  ✅ testGetFileSystemStatusSkipsStorageSnapshotBeforeReady');
}

async function testEmptyScannedSourceStateIsCompleted() {
    console.log('  testEmptyScannedSourceStateIsCompleted...');
    const appDir = tmpDir('empty-source-state');
    const worker = new FileManagerWorker('com.test.filemgr', appDir);
    try {
        worker.storage = {
            scannerState: {
                unavailable_roots: {}
            }
        };

        assert.equal(
            worker._deriveSourceState(
                '/tmp/empty-source',
                {
                    total_files: 0,
                    embedded_count: 0,
                    pending_count: 0,
                    failed_count: 0,
                    last_scan_at: Date.now()
                },
                'full'
            ),
            'completed'
        );
        assert.equal(
            worker._deriveSourceState(
                '/tmp/unscanned-source',
                {
                    total_files: 0,
                    embedded_count: 0,
                    pending_count: 0,
                    failed_count: 0,
                    last_scan_at: null
                },
                'full'
            ),
            'pending'
        );
    } finally {
        cleanup(appDir);
    }
    console.log('  ✅ testEmptyScannedSourceStateIsCompleted');
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

        worker.storage.scannerState.probe_error = {
            code: 'embedding_config_error',
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
        assert.equal(statusWithProbeError.data.probe_error.code, 'embedding_config_error');
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

        const indexed = await worker.searchIndexedFiles('alpha', { topK: 5, routes: ['content_semantic'] });
        assert.equal(indexed.warning, '文件索引尚未就绪，请稍后重试。');
        assert.equal(indexed.code, 'INDEX_NOT_READY');
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
            isDeferred: () => false
        };

        const blankName = await worker.searchFileByName('   ', 10);
        assert.deepEqual(blankName, { query: '   ', results: [], totalHits: 0 });
        assert.equal(calls.length, 0, 'blank name query should not call storage');

        await worker.searchFileByName('alpha', 500);

        assert.deepEqual(calls, [{ method: 'name', query: 'alpha', options: { topK: 100 } }]);
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
        scannerState: { unavailable_roots: {}, roots: {}, probe_error: null, last_rebuild_event: null },
        isDeferred: () => false,
        searchFilesByKeyword: async () => [],
        searchFileByName: async () => {
            throw new Error('semantic should not run');
        },
        searchIndexedChunks: async () => {
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
        worker.storage.searchIndexedChunks = async () => ({
            results: [
                {
                    chunk: { id: '1', text: 'hello' },
                    score: 0.8,
                    source: { path: '/docs/content.md', filename: 'content.md', modified: 5, size: 6, refCount: 1 }
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
        worker.storage.searchIndexedChunks = async () => {
            semanticCalls += 1;
            return {
                results: [
                    {
                        chunk: { id: '1', text: 'content hit' },
                        score: 0.5,
                        source: {
                            path: '/workspace/content.md',
                            filename: 'content.md',
                            modified: 1,
                            size: 2,
                            refCount: 1
                        }
                    },
                    {
                        chunk: { id: '2', text: 'both content' },
                        score: 0.4,
                        source: { path: '/workspace/both.md', filename: 'both.md', modified: 1, size: 2, refCount: 1 }
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
        worker.storage.searchIndexedChunks = async () => ({ results: [] });

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

async function testSearchIndexedFilesExplicitZeroRoutesDoNotCallStorage() {
    console.log('  testSearchIndexedFilesExplicitZeroRoutesDoNotCallStorage...');
    for (const options of [
        { routes: [] },
        { routes: ['unknown'] },
        { routes: ['content_semantic'], includeContentSemantic: false }
    ]) {
        const worker = makeSearchWorker();
        let calls = 0;
        worker.storage.mode = 'full';
        worker.storage.searchFilesByKeyword = async () => {
            calls++;
            return [];
        };
        worker.storage.searchFileByName = async () => {
            calls++;
            return { results: [] };
        };
        worker.storage.searchIndexedChunks = async () => {
            calls++;
            return { results: [] };
        };
        const result = await worker.searchIndexedFiles('report', options);
        assert.equal(calls, 0);
        assert.deepEqual(result.results, []);
        assert.equal(result.totalHits, 0);
        assert.equal(result.code, undefined);
        cleanup(worker.appDataDirectory);
    }
    console.log('  ✅ testSearchIndexedFilesExplicitZeroRoutesDoNotCallStorage');
}

async function testSearchIndexedFilesScopedRouteBudgetsAndOutcomes() {
    console.log('  testSearchIndexedFilesScopedRouteBudgetsAndOutcomes...');
    const scope = { type: 'path', path: '/workspace/empty' };
    const worker = makeSearchWorker();
    for (const method of [
        '_checkIndexedSearchPreconditions',
        '_runKeywordRoute',
        '_runNameSemanticRoute',
        '_runContentSemanticRoute',
        '_finalizeIndexedSearch'
    ])
        assert.equal(
            typeof worker[method],
            'function',
            `${method} must remain an explicit search orchestration boundary`
        );
    const calls = [];
    worker.storage.mode = 'full';
    worker.storage.searchFilesByKeyword = async (_query, options) => {
        calls.push(['keyword', options]);
        return [];
    };
    worker.storage.searchFileByName = async (_query, options) => {
        calls.push(['name', options]);
        return { results: [] };
    };
    worker.storage.searchIndexedChunks = async (_query, options) => {
        calls.push(['content', options]);
        return { results: [] };
    };
    let statCalls = 0;
    worker._statFileForSearch = async () => {
        statCalls++;
        return { isFile: () => true };
    };

    const empty = await worker.searchIndexedFiles('plan', { topK: 5, scope });
    assert.deepEqual(calls, [
        ['keyword', { limit: 15, scope }],
        ['name', { topK: 10, scope }],
        ['content', { topK: 15, scope }]
    ]);
    assert.deepEqual(empty.results, []);
    assert.equal(empty.code, undefined);
    assert.equal(statCalls, 0);

    worker.storage.searchFileByName = async () => ({
        results: [{ path: '/workspace/empty/stale.md', filename: 'stale.md', ref_count: 1 }]
    });
    worker._statFileForSearch = async () => {
        statCalls++;
        return null;
    };
    const scopedFiltered = await worker.searchIndexedFiles('plan', { routes: ['name_semantic'], scope });
    assert.deepEqual(scopedFiltered.results, []);
    assert.equal(statCalls, 1);

    let unscopedContentOptions;
    worker.storage.searchIndexedChunks = async (_query, options) => {
        unscopedContentOptions = options;
        return { results: [] };
    };
    await worker.searchIndexedFiles('plan', { topK: 100, routes: ['content_semantic'] });
    assert.deepEqual(unscopedContentOptions, { topK: 300, scope: undefined });

    worker.storage.searchFilesByKeyword = async () => {
        throw new Error('keyword down');
    };
    worker.storage.searchFileByName = async () => ({ results: [] });
    const partial = await worker.searchIndexedFiles('plan', { routes: ['keyword', 'name_semantic'], scope });
    assert.equal(partial.code, CODES.SEARCH_PARTIAL);

    worker.storage.searchFileByName = async () => {
        throw new Error('name down');
    };
    const failed = await worker.searchIndexedFiles('plan', { routes: ['keyword', 'name_semantic'], scope });
    assert.equal(failed.code, CODES.SEARCH_FAILED);
    cleanup(worker.appDataDirectory);
    console.log('  ✅ testSearchIndexedFilesScopedRouteBudgetsAndOutcomes');
}

function makeMultiPathSearchWorker({ entries, pausedRoots = [], unavailableRoots = {} }) {
    const worker = Object.create(FileManagerWorker.prototype);
    const calls = [];
    worker.status = 'running';
    worker.config = { entries };
    worker._lastConfig = { entries };
    worker._pendingConfigChange = null;
    worker._getVisibleConfigEntries = FileManagerWorker.prototype._getVisibleConfigEntries;
    worker._currentWorkspace = null;
    worker._statFileForSearch = async () => ({ isFile: () => true });
    worker.storage = {
        mode: 'full',
        isDeferred: () => false,
        scannerState: {
            roots: Object.fromEntries(
                entries.map((entry) => [entry.root, { paused: pausedRoots.includes(entry.root) }])
            ),
            unavailable_roots: unavailableRoots
        },
        searchIndexedFilesByKeyword: async (_query, options) => {
            calls.push(['keyword', options]);
            return [];
        },
        searchFileByName: async (_query, options) => {
            calls.push(['name', options]);
            return { results: [] };
        },
        searchIndexedChunks: async (_query, options) => {
            calls.push(['content', options]);
            return { results: [] };
        }
    };
    return { worker, calls };
}

async function testMultiPathSubsetRunsEachRouteOnce() {
    const entries = [
        { root: '/source/a', exclude_patterns: [] },
        { root: '/source/b', exclude_patterns: [] }
    ];
    const { worker, calls } = makeMultiPathSearchWorker({ entries });
    const scope = { type: 'paths', paths: ['/source/a/one', '/source/b/two'] };

    const result = await worker.searchIndexedFiles('plan', { topK: 5, scope });
    assert.equal(result.code, undefined);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls, [
        ['keyword', { limit: 15, scope }],
        ['name', { topK: 10, scope }],
        ['content', { topK: 15, scope }]
    ]);
}

async function testMultiPathChangePreservesConfiguredSinglePathAndRejectsInvalidSinglePath() {
    const entries = [
        { root: '/source/a', exclude_patterns: [] },
        { root: '/source/b', exclude_patterns: [] }
    ];
    const scope = { type: 'path', path: '/source/a/sub' };
    const accepted = makeMultiPathSearchWorker({ entries });
    const acceptedResult = await accepted.worker.searchIndexedFiles('plan', { topK: 5, scope });
    assert.equal(acceptedResult.code, undefined);
    assert.deepEqual(accepted.calls, [
        ['keyword', { limit: 15, scope }],
        ['name', { topK: 10, scope }],
        ['content', { topK: 15, scope }]
    ]);

    for (const { candidate, unavailableRoots = {} } of [
        { candidate: '/outside' },
        { candidate: '/source/a/sub', unavailableRoots: { '/source/a': { since: 1 } } }
    ]) {
        const rejected = makeMultiPathSearchWorker({ entries, unavailableRoots });
        const result = await rejected.worker.searchIndexedFiles('plan', {
            scope: { type: 'path', path: candidate }
        });
        assert.equal(result.code, CODES.INVALID_SCOPE);
        assert.equal(rejected.calls.length, 0);
    }
}

async function testMultiPathAllConfiguredSourcesIncludingPausedBecomeUnscoped() {
    const entries = [
        { root: '/source/a', exclude_patterns: [] },
        { root: '/source/b', exclude_patterns: [] }
    ];

    const activeOnly = makeMultiPathSearchWorker({ entries, pausedRoots: ['/source/b'] });
    await activeOnly.worker.searchIndexedFiles('plan', {
        topK: 5,
        scope: { type: 'paths', paths: ['/source/a'] }
    });
    assert.ok(activeOnly.calls.every(([, options]) => options.scope?.type === 'paths'));

    const all = makeMultiPathSearchWorker({ entries, pausedRoots: ['/source/b'] });
    await all.worker.searchIndexedFiles('plan', {
        topK: 5,
        scope: { type: 'paths', paths: ['/source/a', '/source/b'] }
    });
    assert.equal(all.calls.length, 3);
    assert.deepEqual(
        all.calls.map(([route]) => route),
        ['keyword', 'name', 'content']
    );
    assert.ok(all.calls.every(([, options]) => options.scope === undefined));
}

async function testMultiPathInvalidNeverCallsARouteOrFallsBackUnscoped() {
    const entries = [{ root: '/source/a', exclude_patterns: [] }];
    for (const scope of [
        { type: 'paths', paths: [] },
        { type: 'paths', paths: ['/source/a', '/unknown'] },
        { type: 'paths', paths: ['/source/a', 'relative/path'] },
        { type: 'paths', paths: Array.from({ length: 65 }, (_, index) => `/source/a/${index}`) }
    ]) {
        const { worker, calls } = makeMultiPathSearchWorker({ entries });
        const result = await worker.searchIndexedFiles('plan', { scope });
        assert.equal(result.code, CODES.INVALID_SCOPE);
        assert.equal(calls.length, 0);
    }
}

async function testMultiPathWhollyUnavailableSelectedPathFailsButPausedDoesNot() {
    const entries = [
        { root: '/source/a', exclude_patterns: [] },
        { root: '/source/b', exclude_patterns: [] }
    ];
    const unavailable = makeMultiPathSearchWorker({
        entries,
        unavailableRoots: { '/source/b': { since: 1 } }
    });
    const rejected = await unavailable.worker.searchIndexedFiles('plan', {
        scope: { type: 'paths', paths: ['/source/b/sub'] }
    });
    assert.equal(rejected.code, CODES.INVALID_SCOPE);
    assert.equal(unavailable.calls.length, 0);

    const paused = makeMultiPathSearchWorker({ entries, pausedRoots: ['/source/b'] });
    const accepted = await paused.worker.searchIndexedFiles('plan', {
        routes: ['keyword'],
        scope: { type: 'paths', paths: ['/source/b'] }
    });
    assert.equal(accepted.code, undefined);
    assert.equal(paused.calls.length, 1);
}

async function testMultiPathRequestedUnionFiltersBackendLeakEvenAfterAllSourceOptimization() {
    const entries = [
        { root: '/source/a', exclude_patterns: [] },
        { root: '/source/b', exclude_patterns: [] }
    ];
    const { worker } = makeMultiPathSearchWorker({ entries });
    let routedScope = 'not-called';
    worker.storage.searchFileByName = async (_query, options) => {
        routedScope = options.scope;
        const expandedEntries = [...entries, { root: '/source/c', exclude_patterns: [] }];
        worker.config = { entries: expandedEntries };
        worker._lastConfig = worker.config;
        return {
            results: [
                { path: '/source/a/in.md', filename: 'in.md', ref_count: 1 },
                { path: '/source/c/leak.md', filename: 'leak.md', ref_count: 1 }
            ]
        };
    };
    const result = await worker.searchIndexedFiles('plan', {
        routes: ['name_semantic'],
        scope: { type: 'paths', paths: ['/source/a', '/source/b'] }
    });
    assert.equal(routedScope, undefined);
    assert.deepEqual(
        result.results.map((item) => item.path),
        ['/source/a/in.md']
    );
}

async function testMultiPathSelectedSourceRemovalDuringSearchFailsClosed() {
    const entries = [
        { root: '/source/a', exclude_patterns: [] },
        { root: '/source/b', exclude_patterns: [] }
    ];
    const { worker } = makeMultiPathSearchWorker({ entries });
    worker.storage.searchFileByName = async () => {
        const remainingEntries = [{ root: '/source/b', exclude_patterns: [] }];
        worker.config = { entries: remainingEntries };
        worker._lastConfig = worker.config;
        return {
            results: [{ path: '/source/a/in.md', filename: 'in.md', ref_count: 1 }]
        };
    };

    const result = await worker.searchIndexedFiles('plan', {
        routes: ['name_semantic'],
        scope: { type: 'paths', paths: ['/source/a'] }
    });
    assert.equal(result.code, CODES.INVALID_SCOPE);
    assert.deepEqual(result.results, []);
}

async function runMultiPathFinalStatConfigChange(mutateVisiblePolicy) {
    const entries = [
        { root: '/source/a', exclude_patterns: [] },
        { root: '/source/b', exclude_patterns: [] }
    ];
    const { worker } = makeMultiPathSearchWorker({ entries });
    worker.storage.searchFileByName = async () => ({
        results: [{ path: '/source/a/in.md', filename: 'in.md', ref_count: 1 }]
    });

    let releaseStat;
    let markStatStarted;
    const statStarted = new Promise((resolve) => {
        markStatStarted = resolve;
    });
    const statBlocked = new Promise((resolve) => {
        releaseStat = resolve;
    });
    worker._statFileForSearch = async () => {
        markStatStarted();
        await statBlocked;
        return { isFile: () => true };
    };

    const search = worker.searchIndexedFiles('plan', {
        routes: ['name_semantic'],
        scope: { type: 'paths', paths: ['/source/a'] }
    });
    await statStarted;
    mutateVisiblePolicy(worker);
    releaseStat();
    return await search;
}

async function testMultiPathFinalStatWindowReappliesLatestScopePolicy() {
    const removed = await runMultiPathFinalStatConfigChange((worker) => {
        worker._pendingConfigChange = {
            entries: [{ root: '/source/b', exclude_patterns: [] }]
        };
    });
    assert.equal(removed.code, CODES.INVALID_SCOPE);
    assert.deepEqual(removed.results, []);

    const unavailable = await runMultiPathFinalStatConfigChange((worker) => {
        worker.storage.scannerState.unavailable_roots = { '/source/a': { since: 1 } };
    });
    assert.equal(unavailable.code, CODES.INVALID_SCOPE);
    assert.deepEqual(unavailable.results, []);

    const excluded = await runMultiPathFinalStatConfigChange((worker) => {
        worker._pendingConfigChange = {
            entries: [
                { root: '/source/a', exclude_patterns: ['**/*.md'] },
                { root: '/source/b', exclude_patterns: [] }
            ]
        };
    });
    assert.equal(excluded.code, undefined);
    assert.deepEqual(excluded.results, []);
}

async function testMultiPathScopeValidationHasDeterministicErrorPriority() {
    const entries = [{ root: '/source/a', exclude_patterns: [] }];

    const blankUnknown = makeMultiPathSearchWorker({ entries });
    const blankUnknownResult = await blankUnknown.worker.searchIndexedFiles('   ', {
        scope: { type: 'paths', paths: ['/unknown'] }
    });
    assert.equal(blankUnknownResult.code, CODES.INVALID_SCOPE);
    assert.equal(blankUnknown.calls.length, 0);

    const missingUnknown = makeMultiPathSearchWorker({ entries });
    missingUnknown.worker.storage = null;
    const missingUnknownResult = await missingUnknown.worker.searchIndexedFiles('plan', {
        scope: { type: 'paths', paths: ['/unknown'] }
    });
    assert.equal(missingUnknownResult.code, CODES.INVALID_SCOPE);

    const missingKnown = makeMultiPathSearchWorker({ entries });
    missingKnown.worker.storage = null;
    const missingKnownResult = await missingKnown.worker.searchIndexedFiles('plan', {
        scope: { type: 'paths', paths: ['/source/a'] }
    });
    assert.equal(missingKnownResult.code, CODES.INDEX_NOT_READY);
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
        const lockArtifact = path.join(appDir, 'scan.lock.lock');
        assert.equal(fs.existsSync(lockArtifact), true, 'proper-lockfile lock artifact should exist');
        assert.equal(fs.statSync(lockArtifact).isDirectory(), true, 'lock artifact should be a directory');

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
                probe_error: null,
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
        let processedCount = 0;
        let shouldYieldAfterConfigApplied = null;
        worker.storage = {
            mode: 'full',
            processEmbeddingQueue: async (shouldYield) => {
                processedCount++;
                shouldYieldAfterConfigApplied = shouldYield();
                return 0;
            }
        };
        worker._scanPending = false;
        worker._pendingConfigChange = { entries: [makeEntry('/new-root')] };

        worker._enqueueEmbeddingQueue();
        await worker.taskQueue.onIdle();

        assert.equal(processedCount, 0, 'embedding queue should not start while source config is pending');
        worker._pendingConfigChange = null;
        worker._enqueueEmbeddingQueue();
        await worker.taskQueue.onIdle();

        assert.equal(processedCount, 1);
        assert.equal(shouldYieldAfterConfigApplied, false);
    } finally {
        if (worker) await worker.finalize();
        cleanup(appDir);
    }
    console.log('  ✅ testEmbeddingQueueYieldsToPendingConfigChange');
}

async function testScanYieldsToPendingConfigChangeBeforeNextBatch() {
    console.log('  testScanYieldsToPendingConfigChangeBeforeNextBatch...');
    const scanDir = tmpDir('scan-config-yield');
    const appDir = tmpDir('app-scan-config-yield');
    let worker;
    try {
        fs.mkdirSync(scanDir, { recursive: true });
        for (let i = 0; i < 501; i++) {
            fs.writeFileSync(path.join(scanDir, `file-${i}.txt`), `content ${i}`, 'utf-8');
        }

        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.callApp = () => {};
        const initialConfig = { entries: [makeEntry(scanDir, [])] };
        worker.config = initialConfig;
        worker._lastConfig = initialConfig;
        worker.status = 'running';

        let saveCalls = 0;
        worker.storage = {
            mode: 'base-only',
            scannerState: {
                roots: {
                    [scanDir]: {
                        last_full_scan: 0,
                        last_scan_at: null,
                        total_files: 0,
                        last_file_count: 0
                    }
                },
                unavailable_roots: {},
                probe_error: null,
                last_rebuild_event: null,
                last_embedding_task_at: null
            },
            isDeferred: () => false,
            initialize: async () => {},
            syncEmbeddingMode: async () => {},
            syncEmbeddingModeForStartup: async () => {},
            saveScannerState: async () => {},
            saveFiles: async (files) => {
                saveCalls++;
                if (saveCalls === 1) {
                    void worker.applicationConfigChanged({ entries: [] });
                }
                return { saved: files.length, failed: 0, failures: [] };
            },
            removeDeletedFiles: async () => {},
            detachRootForConfigChange: async (root) => {
                delete worker.storage.scannerState.roots[root];
            },
            removeOrphanedItems: async () => ({ deleted: 0 })
        };

        await worker._startScanners(initialConfig.entries);
        await worker.taskQueue.onIdle();

        assert.equal(saveCalls, 1, 'scan should yield after config change instead of saving another batch');
        assert.equal(worker.status, 'idle', 'queued config deletion should run after scan yields');
        assert.ok(!worker.scanners.has(scanDir), 'deleted root scanner should be stopped');
    } finally {
        if (worker) await worker.finalize();
        cleanup(scanDir);
        cleanup(appDir);
    }
    console.log('  ✅ testScanYieldsToPendingConfigChangeBeforeNextBatch');
}

async function testIncrementalScanYieldsDuringGlobWhenNoFilesChanged() {
    console.log('  testIncrementalScanYieldsDuringGlobWhenNoFilesChanged...');
    const scanDir = tmpDir('scan-glob-yield');
    const appDir = tmpDir('app-glob-yield');
    let worker;
    try {
        fs.mkdirSync(scanDir, { recursive: true });
        for (let i = 0; i < 700; i++) {
            fs.writeFileSync(path.join(scanDir, `file-${i}.txt`), `content ${i}`, 'utf-8');
        }

        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.callApp = () => {};
        const initialConfig = { entries: [makeEntry(scanDir, [])] };
        const rootState = {
            last_full_scan: Date.now() + 60_000,
            last_scan_at: Date.now(),
            total_files: 700,
            last_file_count: 700
        };
        let releaseScan;
        const scanGate = new Promise((resolve) => {
            releaseScan = resolve;
        });
        let saveFilesCalls = 0;
        let saveScannerStateCalls = 0;
        let enqueueEmbeddingCalls = 0;

        worker.config = initialConfig;
        worker._lastConfig = initialConfig;
        worker.status = 'running';
        worker.storage = {
            mode: 'base-only',
            scannerState: {
                roots: {
                    [scanDir]: rootState
                },
                unavailable_roots: {},
                probe_error: null,
                last_rebuild_event: null,
                last_embedding_task_at: null
            },
            isDeferred: () => false,
            initialize: async () => {},
            syncEmbeddingMode: async () => {
                await scanGate;
            },
            saveScannerState: async () => {
                saveScannerStateCalls++;
            },
            saveFiles: async () => {
                saveFilesCalls++;
                return { saved: 0, failed: 0, failures: [] };
            },
            removeDeletedFiles: async () => {}
        };
        worker._enqueueEmbeddingQueue = () => {
            enqueueEmbeddingCalls++;
        };

        await worker._startScanners(initialConfig.entries);
        const scanner = worker.scanners.get(scanDir);
        assert.ok(scanner, 'scanner should be started');
        scanner._counter = 1;

        let updateChecks = 0;
        scanner._isFileUpdated = () => {
            updateChecks++;
            if (updateChecks === 250) {
                worker._pendingWorkspaceChange = '/next-workspace';
            }
            return false;
        };

        releaseScan();
        await worker.taskQueue.onIdle();

        assert.ok(updateChecks < 700, `scan should yield during glob enumeration, got ${updateChecks} checks`);
        assert.ok(updateChecks <= 520, `scan should yield near the first 500-entry boundary, got ${updateChecks}`);
        assert.equal(saveFilesCalls, 0, 'unchanged incremental scan should not save a batch');
        assert.equal(saveScannerStateCalls, 0, 'partial scan should not checkpoint scanner state');
        assert.equal(enqueueEmbeddingCalls, 0, 'partial scan should not enqueue embedding');
    } finally {
        if (worker) await worker.finalize();
        cleanup(scanDir);
        cleanup(appDir);
    }
    console.log('  ✅ testIncrementalScanYieldsDuringGlobWhenNoFilesChanged');
}

async function testFullScanYieldsAfterRemoveDeletedFilesBeforeCheckpoint() {
    console.log('  testFullScanYieldsAfterRemoveDeletedFilesBeforeCheckpoint...');
    const scanDir = tmpDir('scan-remove-deleted-yield');
    const appDir = tmpDir('app-remove-deleted-yield');
    let worker;
    try {
        fs.mkdirSync(scanDir, { recursive: true });
        fs.writeFileSync(path.join(scanDir, 'file.txt'), 'content', 'utf-8');

        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.callApp = () => {};
        const initialConfig = { entries: [makeEntry(scanDir, [])] };
        const rootState = {
            last_full_scan: 0,
            last_scan_at: null,
            total_files: 0,
            last_file_count: 0
        };
        let saveScannerStateCalls = 0;
        let enqueueEmbeddingCalls = 0;

        worker.config = initialConfig;
        worker._lastConfig = initialConfig;
        worker.status = 'running';
        worker.storage = {
            mode: 'base-only',
            scannerState: {
                roots: {
                    [scanDir]: rootState
                },
                unavailable_roots: {},
                probe_error: null,
                last_rebuild_event: null,
                last_embedding_task_at: null
            },
            isDeferred: () => false,
            initialize: async () => {},
            syncEmbeddingMode: async () => {},
            saveScannerState: async () => {
                saveScannerStateCalls++;
            },
            saveFiles: async (files) => ({ saved: files.length, failed: 0, failures: [] }),
            removeDeletedFiles: async () => {
                worker._pendingWorkspaceChange = '/next-workspace';
            }
        };
        worker._enqueueEmbeddingQueue = () => {
            enqueueEmbeddingCalls++;
        };

        await worker._startScanners(initialConfig.entries);
        await worker.taskQueue.onIdle();

        assert.equal(saveScannerStateCalls, 0, 'scan should not checkpoint after control pending arrives');
        assert.equal(rootState.last_scan_at, null);
        assert.equal(rootState.last_full_scan, 0);
        assert.equal(rootState.total_files, 0);
        assert.equal(rootState.last_file_count, 0);
        assert.equal(enqueueEmbeddingCalls, 0);
    } finally {
        if (worker) await worker.finalize();
        cleanup(scanDir);
        cleanup(appDir);
    }
    console.log('  ✅ testFullScanYieldsAfterRemoveDeletedFilesBeforeCheckpoint');
}

async function testStatusUsesPendingConfigWhenConfigChangeQueued() {
    console.log('  testStatusUsesPendingConfigWhenConfigChangeQueued...');
    const appDir = tmpDir('app-visible-pending-config');
    const worker = new FileManagerWorker('com.test.filemgr', appDir);
    try {
        worker.status = 'running';
        worker.config = { entries: [] };
        worker._lastConfig = { entries: [makeEntry('/old-root')] };
        worker._pendingConfigChange = { entries: [] };
        worker.storage = {
            mode: 'base-only',
            scannerState: {
                roots: {},
                unavailable_roots: {},
                probe_error: null,
                last_rebuild_event: null,
                last_embedding_task_at: null
            },
            getStatus: async () => ({ db_size: 0, vecdb_size: 0, chunk_size: 0 }),
            getPerRootCounts: async (roots) =>
                new Map(
                    roots.map((root) => [
                        root,
                        {
                            total_files: 1,
                            embedded_count: 0,
                            pending_count: 0,
                            failed_count: 0,
                            last_scan_at: null
                        }
                    ])
                ),
            isDeferred: () => false,
            deferredReason: null
        };

        const status = await worker.getFileSystemStatus();

        assert.deepEqual(status.sources, [], 'pending source config should drive visible sources immediately');
    } finally {
        cleanup(appDir);
    }
    console.log('  ✅ testStatusUsesPendingConfigWhenConfigChangeQueued');
}

async function testConfigChangeKeepsPendingConfigVisibleUntilLastConfigUpdates() {
    console.log('  testConfigChangeKeepsPendingConfigVisibleUntilLastConfigUpdates...');
    const appDir = tmpDir('app-pending-config-visible-window');
    let worker;
    try {
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        const oldConfig = { entries: [makeEntry('/old-root')] };
        const nextConfig = { entries: [] };
        let statusDuringRestart = null;

        worker.status = 'running';
        worker.config = oldConfig;
        worker._lastConfig = oldConfig;
        worker.storage = {
            mode: 'base-only',
            scannerState: {
                roots: {},
                unavailable_roots: {},
                probe_error: null,
                last_rebuild_event: null,
                last_embedding_task_at: null
            },
            syncEmbeddingModeForStartup: async () => {},
            saveScannerState: async () => {},
            detachRootForConfigChange: async () => {},
            removeOrphanedItems: async () => ({ deleted: 0 }),
            getStatus: async () => ({ db_size: 0, vecdb_size: 0, chunk_size: 0 }),
            getPerRootCounts: async (roots) =>
                new Map(
                    roots.map((root) => [
                        root,
                        {
                            total_files: 1,
                            embedded_count: 0,
                            pending_count: 0,
                            failed_count: 0,
                            last_scan_at: null
                        }
                    ])
                ),
            isDeferred: () => false,
            deferredReason: null
        };
        worker._restartScanners = async () => {
            statusDuringRestart = await worker.getFileSystemStatus();
        };
        worker._enqueueEmbeddingQueue = () => {};

        await worker.applicationConfigChanged(nextConfig);

        assert.deepEqual(
            statusDuringRestart?.sources,
            [],
            'pending config should remain visible until lastConfig updates'
        );
        assert.equal(worker._pendingConfigChange, null);
        assert.deepEqual(worker._lastConfig, nextConfig);
    } finally {
        if (worker) await worker.finalize();
        cleanup(appDir);
    }
    console.log('  ✅ testConfigChangeKeepsPendingConfigVisibleUntilLastConfigUpdates');
}

async function testReconcileConfigAppliesExplicitLatestConfig() {
    console.log('  testReconcileConfigAppliesExplicitLatestConfig...');
    const scanDir1 = tmpDir('reconcile-root1');
    const scanDir2 = tmpDir('reconcile-root2');
    const appDir = tmpDir('app-reconcile-explicit-config');
    let worker;
    try {
        createTestFiles(scanDir1);
        createTestFiles(scanDir2);

        const staleConfig = {
            entries: [makeEntry(scanDir1), makeEntry(scanDir2)]
        };
        const latestConfig = {
            entries: [makeEntry(scanDir1)]
        };

        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.config = staleConfig;
        await worker.initialize();
        await worker.taskQueue.onIdle();

        assert.ok(worker.scanners.has(scanDir2), 'stale root should be active before reconcile');
        assert.ok(worker.storage.getScannerState().roots[scanDir2], 'stale root state should exist before reconcile');

        const result = await worker.reconcileConfig(latestConfig);
        await worker.taskQueue.onIdle();

        assert.equal(result.status, 'ok');
        assert.equal(result.reconciled, true);
        assert.deepEqual(worker._lastConfig, latestConfig);
        assert.ok(!worker.scanners.has(scanDir2), 'stale root scanner should be removed by reconcile');
        assert.equal(
            worker.storage.getScannerState().roots[scanDir2],
            undefined,
            'stale root state should be removed by reconcile'
        );
    } finally {
        if (worker) await worker.finalize();
        cleanup(scanDir1);
        cleanup(scanDir2);
        cleanup(appDir);
    }
    console.log('  ✅ testReconcileConfigAppliesExplicitLatestConfig');
}

async function testReconcileConfigNormalizesExplicitLatestConfigBeforeComparing() {
    console.log('  testReconcileConfigNormalizesExplicitLatestConfigBeforeComparing...');
    const scanDir = tmpDir('reconcile-normalize-root');
    const appDir = tmpDir('app-reconcile-normalize-config');
    let worker;
    try {
        createTestFiles(scanDir);

        const rawEntry = { root: scanDir, exclude_patterns: ['**/node_modules/**', '**/.git/**'] };
        const normalizedConfig = {
            entries: [FSEntrySchema.parse(rawEntry)]
        };
        const rawEquivalentConfig = { entries: [rawEntry] };

        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.config = normalizedConfig;
        await worker.initialize();
        await worker.taskQueue.onIdle();

        const result = await worker.reconcileConfig(rawEquivalentConfig);
        await worker.taskQueue.onIdle();

        assert.deepEqual(result, { status: 'ok', reconciled: false });
        assert.deepEqual(worker._lastConfig, normalizedConfig);
    } finally {
        if (worker) await worker.finalize();
        cleanup(scanDir);
        cleanup(appDir);
    }
    console.log('  ✅ testReconcileConfigNormalizesExplicitLatestConfigBeforeComparing');
}

async function testApplicationConfigChangedNormalizesRawEntries() {
    console.log('  testApplicationConfigChangedNormalizesRawEntries...');
    const scanDir = tmpDir('config-change-normalize-root');
    const appDir = tmpDir('app-config-change-normalize-config');
    let worker;
    try {
        createTestFiles(scanDir);

        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.config = { entries: [] };
        await worker.initialize();
        await worker.taskQueue.onIdle();

        await worker.applicationConfigChanged({ entries: [{ root: scanDir, exclude_patterns: [] }] });
        await worker.taskQueue.onIdle();

        assert.ok(worker.scanners.has(scanDir), 'raw entry should still start a scanner');
        assert.ok(
            Array.isArray(worker.scanners.get(scanDir).entry.include_patterns),
            'scanner entry should have normalized include_patterns'
        );
        assert.ok(
            worker.scanners.get(scanDir).entry.include_patterns.length > 0,
            'normalized include_patterns should include defaults'
        );
    } finally {
        if (worker) await worker.finalize();
        cleanup(scanDir);
        cleanup(appDir);
    }
    console.log('  ✅ testApplicationConfigChangedNormalizesRawEntries');
}

async function testSaveEntriesPassesExplicitConfigToWorkerReconcile() {
    console.log('  testSaveEntriesPassesExplicitConfigToWorkerReconcile...');
    const previousWindow = globalThis.window;
    const entries = [makeEntry('/tmp/filemgr-reconcile-explicit')];
    const settings = {
        applications: {
            filemgr: {
                entries: [makeEntry('/tmp/old-filemgr-root')],
                other_option: true
            },
            mailbox: {
                enabled: true
            }
        }
    };
    let savedObject = null;
    let workerCall = null;
    let workerCallResolve;

    try {
        globalThis.window = {
            settingAPI: {
                loadSettingObject: async () => settings,
                saveSettingObject: async (nextSettings) => {
                    savedObject = nextSettings;
                    return nextSettings;
                }
            },
            applicationAPI: {
                call: (methodName, config) => {
                    workerCall = { methodName, config };
                    return new Promise((resolve) => {
                        workerCallResolve = resolve;
                    });
                }
            }
        };

        await saveEntries(entries);

        assert.deepEqual(savedObject.applications.filemgr.entries, entries);
        assert.deepEqual(workerCall, {
            methodName: 'reconcileConfig',
            config: savedObject.applications.filemgr
        });
        assert.equal(typeof workerCallResolve, 'function', 'saveEntries should not await reconcile completion');
        workerCallResolve({ status: 'ok' });
    } finally {
        if (previousWindow === undefined) {
            delete globalThis.window;
        } else {
            globalThis.window = previousWindow;
        }
    }
    console.log('  ✅ testSaveEntriesPassesExplicitConfigToWorkerReconcile');
}

async function testSourceConfigPendingDoesNotLeakOnEarlyReturn() {
    console.log('  testSourceConfigPendingDoesNotLeakOnEarlyReturn...');
    const appDir = tmpDir('app-source-config-pending-lifecycle');
    let worker;
    try {
        worker = new FileManagerWorker('com.test.filemgr', appDir);

        worker._readonlyMode = true;
        await worker.applicationConfigChanged({ entries: [makeEntry('/readonly-root')] });
        assert.equal(worker._pendingConfigChange, null);

        worker._readonlyMode = false;
        worker.storage = null;
        worker.status = 'idle';
        await worker.applicationConfigChanged({ entries: [makeEntry('/missing-storage-root')] });
        assert.equal(worker._pendingConfigChange, null);

        worker.status = 'error';
        worker.storage = {
            mode: 'base-only'
        };
        await worker.applicationConfigChanged({ entries: [makeEntry('/error-root')] });
        assert.equal(worker._pendingConfigChange, null);

        worker.status = 'running';
        let release;
        const blocker = worker.runSequentially(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                })
        );
        worker.storage = {
            mode: 'base-only',
            scannerState: { roots: {} },
            syncEmbeddingModeForStartup: async () => {},
            saveScannerState: async () => {},
            storage: { close() {} }
        };
        worker._detachRemovedRoots = async () => new Set();
        worker._restartScanners = async () => {};
        worker._enqueueEmbeddingQueue = () => {};

        const first = worker.applicationConfigChanged({ entries: [makeEntry('/first-root')] });
        const secondConfig = { entries: [makeEntry('/second-root')] };
        const second = worker.applicationConfigChanged(secondConfig);

        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(worker._pendingConfigChange, secondConfig);
        assert.equal(typeof release, 'function');
        release();
        await Promise.all([blocker, first, second]);
        assert.equal(worker._pendingConfigChange, null);
    } finally {
        if (worker) await worker.finalize();
        cleanup(appDir);
    }
    console.log('  ✅ testSourceConfigPendingDoesNotLeakOnEarlyReturn');
}

async function testWorkspacePendingControlLifecycle() {
    console.log('  testWorkspacePendingControlLifecycle...');
    const appDir = tmpDir('app-workspace-pending-control');
    let worker;
    try {
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.status = 'running';
        worker.storage = {
            mode: 'base-only',
            scannerState: {
                roots: {
                    '/first-workspace': {
                        last_full_scan: 10,
                        last_scan_at: 20,
                        total_files: 1,
                        last_file_count: 1
                    },
                    '/second-workspace': {
                        last_full_scan: 30,
                        last_scan_at: 40,
                        total_files: 1,
                        last_file_count: 1
                    }
                }
            },
            saveScannerState: async () => {},
            getStatus: async () => ({ db_size: 0, vecdb_size: 0, chunk_size: 0 }),
            getPerRootCounts: async () => new Map(),
            isDeferred: () => false,
            deferredReason: null
        };

        let release;
        const blocker = worker.runSequentially(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                })
        );

        const first = worker.workspaceChanged('/first-workspace');
        const second = worker.workspaceChanged('/second-workspace');

        assert.equal(worker._pendingWorkspaceChange, '/second-workspace');
        assert.equal(worker._hasPendingControlChange(), true);
        assert.equal(worker._shouldYieldEmbeddingQueue(), true);

        release();
        await Promise.all([blocker, first, second]);

        assert.equal(worker._pendingWorkspaceChange, null);
        assert.equal(worker._currentWorkspace, '/second-workspace');
        assert.equal(worker.storage.scannerState.roots['/first-workspace'].last_full_scan, 10);
        assert.equal(worker.storage.scannerState.roots['/second-workspace'].last_full_scan, 0);

        await worker.workspaceChanged(null);
        assert.equal(worker._pendingWorkspaceChange, null);

        const throwingWorker = new FileManagerWorker('com.test.filemgr.throwing', appDir);
        try {
            throwingWorker.status = 'running';
            throwingWorker.storage = {
                scannerState: {
                    roots: {
                        '/throwing-workspace': {
                            last_full_scan: 1,
                            last_scan_at: 2,
                            total_files: 1,
                            last_file_count: 1
                        }
                    }
                },
                saveScannerState: async () => {
                    throw new Error('save failed');
                },
                getStatus: async () => ({ db_size: 0, vecdb_size: 0, chunk_size: 0 }),
                getPerRootCounts: async () => new Map(),
                isDeferred: () => false,
                deferredReason: null
            };
            await assert.rejects(() => throwingWorker.workspaceChanged('/throwing-workspace'), /save failed/);
            assert.equal(throwingWorker._pendingWorkspaceChange, null);
        } finally {
            await throwingWorker.finalize();
        }
    } finally {
        if (worker) await worker.finalize();
        cleanup(appDir);
    }
    console.log('  ✅ testWorkspacePendingControlLifecycle');
}

async function testEmbeddingPendingControlLifecycle() {
    console.log('  testEmbeddingPendingControlLifecycle...');
    const appDir = tmpDir('app-embedding-pending-control');
    let worker;
    try {
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.status = 'running';
        let syncCalls = 0;
        let scanRequests = 0;
        worker.storage = {
            mode: 'base-only',
            scannerState: {
                roots: {},
                unavailable_roots: {},
                probe_error: null,
                last_rebuild_event: null,
                last_embedding_task_at: null
            },
            syncEmbeddingModeForStartup: async () => {
                syncCalls++;
            },
            getStatus: async () => ({ db_size: 0, vecdb_size: 0, chunk_size: 0 }),
            getPerRootCounts: async () => new Map(),
            isDeferred: () => false,
            deferredReason: null
        };
        worker.scanners.set('/scan-root', {
            state: {
                last_full_scan: 0,
                last_scan_at: null,
                total_files: 0,
                last_file_count: 0
            },
            requestImmediateScan: () => {
                scanRequests++;
            },
            isRunning: () => true,
            stop: async () => {}
        });

        let release;
        const blocker = worker.runSequentially(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                })
        );

        const first = worker.embeddingConfigChanged();
        const second = worker.embeddingConfigChanged();

        assert.equal(worker._pendingEmbeddingConfigChange, true);
        assert.equal(worker._hasPendingControlChange(), true);
        assert.equal(worker._shouldYieldEmbeddingQueue(), true);

        release();
        await Promise.all([blocker, first, second]);

        assert.equal(syncCalls, 1);
        assert.equal(scanRequests, 1);
        assert.equal(worker._pendingEmbeddingConfigChange, false);

        worker.storage = null;
        await worker.embeddingConfigChanged();
        assert.equal(worker._pendingEmbeddingConfigChange, false);

        worker.storage = {
            syncEmbeddingModeForStartup: async () => {},
            scannerState: {
                roots: {},
                unavailable_roots: {},
                probe_error: null,
                last_rebuild_event: null,
                last_embedding_task_at: null
            },
            getStatus: async () => ({ db_size: 0, vecdb_size: 0, chunk_size: 0 }),
            getPerRootCounts: async () => new Map(),
            isDeferred: () => false,
            deferredReason: null
        };
        worker.status = 'error';
        await worker.embeddingConfigChanged();
        assert.equal(worker._pendingEmbeddingConfigChange, false);

        worker._readonlyMode = true;
        worker.status = 'running';
        await worker.embeddingConfigChanged();
        assert.equal(worker._pendingEmbeddingConfigChange, false);
    } finally {
        if (worker) await worker.finalize();
        cleanup(appDir);
    }
    console.log('  ✅ testEmbeddingPendingControlLifecycle');
}

async function testSkippedScanTaskDoesNotLeaveScanPending() {
    console.log('  testSkippedScanTaskDoesNotLeaveScanPending...');
    const appDir = tmpDir('app-skipped-scan-pending');
    let worker;
    try {
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.status = 'running';
        worker.config = { entries: [makeEntry('/scan-root')] };
        worker._lastConfig = worker.config;
        worker.storage = {
            mode: 'base-only',
            scannerState: {
                roots: {
                    '/scan-root': {
                        last_full_scan: 0,
                        last_scan_at: null,
                        total_files: 0,
                        last_file_count: 0
                    }
                },
                unavailable_roots: {}
            },
            isDeferred: () => false,
            syncEmbeddingMode: async () => {},
            saveFiles: async () => ({ saved: 0, failed: 0, failures: [] }),
            saveScannerState: async () => {},
            removeDeletedFiles: async () => {}
        };

        await worker._startScanners(worker.config.entries);
        const scanner = worker.scanners.get('/scan-root');
        assert.ok(scanner, 'scanner should exist');

        worker._pendingConfigChange = { entries: [] };
        worker._scanPending = true;
        scanner.requestImmediateScan(worker.taskQueue);
        await worker.taskQueue.onIdle();

        assert.equal(worker._scanPending, false);
    } finally {
        if (worker) await worker.finalize();
        cleanup(appDir);
    }
    console.log('  ✅ testSkippedScanTaskDoesNotLeaveScanPending');
}

async function testEmbeddingQueueDoesNotStartDuringPendingControlChange() {
    console.log('  testEmbeddingQueueDoesNotStartDuringPendingControlChange...');
    const appDir = tmpDir('app-embedding-queue-pending-control');
    let worker;
    try {
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        const cases = [
            () => {
                worker._pendingConfigChange = { entries: [] };
            },
            () => {
                worker._pendingWorkspaceChange = '/next-workspace';
            },
            () => {
                worker._pendingEmbeddingConfigChange = true;
            }
        ];

        for (const markPending of cases) {
            let processed = false;
            worker._pendingConfigChange = null;
            worker._pendingWorkspaceChange = null;
            worker._pendingEmbeddingConfigChange = false;
            worker.storage = {
                mode: 'full',
                processEmbeddingQueue: async () => {
                    processed = true;
                    return 0;
                }
            };
            markPending();

            worker._enqueueEmbeddingQueue();
            await worker.taskQueue.onIdle();

            assert.equal(processed, false);
            assert.equal(worker._embeddingQueueScheduled, false);
            assert.equal(worker._embeddingQueueActive, false);
        }
    } finally {
        if (worker) await worker.finalize();
        cleanup(appDir);
    }
    console.log('  ✅ testEmbeddingQueueDoesNotStartDuringPendingControlChange');
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
                probe_error: null,
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
                probe_error: null,
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

async function testInitializeClearsEquivalentPendingConfigBeforeStartingScanners() {
    console.log('  testInitializeClearsEquivalentPendingConfigBeforeStartingScanners...');
    const appDir = tmpDir('app-init-clears-equivalent-pending');
    const scanDir = tmpDir('scan-init-clears-equivalent-pending');
    let worker;
    try {
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        const currentConfig = worker._normalizeConfig({ entries: [makeEntry(scanDir)] });
        const equivalentPendingConfig = worker._normalizeConfig({ entries: [makeEntry(scanDir)] });
        assert.notEqual(equivalentPendingConfig, currentConfig, 'test requires distinct config objects');

        worker.config = currentConfig;
        worker._lastConfig = currentConfig;
        worker._pendingConfigChange = equivalentPendingConfig;
        worker._initSeq = 2;
        worker.status = 'initializing';
        worker.storage = {
            mode: 'base-only',
            scannerState: {
                roots: {},
                unavailable_roots: {}
            },
            syncEmbeddingModeForStartup: async () => {},
            saveScannerState: async () => {},
            detachRootForConfigChange: async () => {
                throw new Error('no roots should be detached for equivalent startup config');
            },
            isDeferred: () => false
        };

        const originalAdd = worker.taskQueue.add.bind(worker.taskQueue);
        let queuedScans = 0;
        worker.taskQueue.add = () => {
            queuedScans++;
            return Promise.resolve();
        };
        try {
            await worker._continueInitializeAfterProbe(2, 'initialize');
        } finally {
            worker.taskQueue.add = originalAdd;
        }

        assert.equal(worker._pendingConfigChange, null, 'equivalent startup config pending marker should be cleared');
        assert.equal(queuedScans, 1, 'first scanner scan task should be queued after stale pending config is cleared');
        assert.ok(worker.scanners.has(scanDir), 'scanner should remain active for configured root');
    } finally {
        if (worker) await worker.finalize();
        cleanup(scanDir);
        cleanup(appDir);
    }
    console.log('  ✅ testInitializeClearsEquivalentPendingConfigBeforeStartingScanners');
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

async function testSetSourcePausedStopsScannerPersistsAndReturnsSnapshot() {
    console.log('  testSetSourcePausedStopsScannerPersistsAndReturnsSnapshot...');
    const appDir = tmpDir('app-source-pause');
    const root = path.join(appDir, 'source');
    let worker;
    try {
        const entry = makeEntry(root);
        const rootState = {
            last_full_scan: 10,
            last_scan_at: 20,
            total_files: 3,
            last_file_count: 3,
            paused: false
        };
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.callApp = () => {};
        worker.config = { entries: [entry] };
        worker._lastConfig = worker.config;
        worker.status = 'running';
        let persisted = null;
        worker.storage = {
            mode: 'base-only',
            scannerState: {
                roots: { [root]: rootState },
                unavailable_roots: {},
                probe_error: null,
                last_rebuild_event: null,
                last_embedding_task_at: null
            },
            setRootPaused: async (targetRoot, paused) => {
                persisted = { root: targetRoot, paused };
                rootState.paused = paused;
            },
            getStatus: async () => ({
                mode: 'base-only',
                total_files: 3,
                embedded_count: 0,
                pending_count: 3,
                last_embedding_task_at: null,
                db_size: 3,
                vecdb_size: 0,
                chunk_size: 0
            }),
            getPerRootCounts: async () =>
                new Map([
                    [
                        root,
                        {
                            total_files: 3,
                            embedded_count: 0,
                            pending_count: 3,
                            failed_count: 0,
                            last_scan_at: 20
                        }
                    ]
                ]),
            isDeferred: () => false,
            deferredReason: null
        };
        let stopped = false;
        worker.scanners.set(root, {
            entry,
            root,
            state: rootState,
            isRunning: () => !stopped,
            stop: async () => {
                stopped = true;
            }
        });

        const result = await worker.setSourcePaused({ root, paused: true });

        assert.equal(result.status, 'ok');
        assert.deepEqual(persisted, { root, paused: true });
        assert.equal(stopped, true);
        assert.equal(worker.scanners.has(root), false);
        assert.equal(result.data.sources.find((source) => source.root === root).paused, true);
    } finally {
        if (worker) await worker.finalize();
        cleanup(appDir);
    }
    console.log('  ✅ testSetSourcePausedStopsScannerPersistsAndReturnsSnapshot');
}

async function testSetSourcePausedResumeStartsScannerBeforeSuccess() {
    console.log('  testSetSourcePausedResumeStartsScannerBeforeSuccess...');
    const appDir = tmpDir('app-source-resume');
    const root = path.join(appDir, 'source');
    fs.mkdirSync(root, { recursive: true });
    let worker;
    try {
        const entry = makeEntry(root);
        const rootState = {
            last_full_scan: 0,
            last_scan_at: null,
            total_files: 0,
            last_file_count: 0,
            paused: true
        };
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.callApp = () => {};
        worker.config = { entries: [entry] };
        worker._lastConfig = worker.config;
        worker.status = 'running';
        let persisted = null;
        worker.storage = {
            mode: 'base-only',
            scannerState: {
                roots: { [root]: rootState },
                unavailable_roots: {},
                probe_error: null,
                last_rebuild_event: null,
                last_embedding_task_at: null
            },
            setRootPaused: async (targetRoot, paused) => {
                persisted = { root: targetRoot, paused };
                rootState.paused = paused;
            },
            isDeferred: () => false,
            syncEmbeddingMode: async () => {},
            saveFiles: async (files) => ({ saved: files.length, failed: 0, failures: [] }),
            removeDeletedFiles: async () => {},
            saveScannerState: async () => {},
            getStatus: async () => ({
                mode: 'base-only',
                total_files: 0,
                embedded_count: 0,
                pending_count: 0,
                last_embedding_task_at: null,
                db_size: 0,
                vecdb_size: 0,
                chunk_size: 0
            }),
            getPerRootCounts: async () =>
                new Map([
                    [
                        root,
                        {
                            total_files: 0,
                            embedded_count: 0,
                            pending_count: 0,
                            failed_count: 0,
                            last_scan_at: null
                        }
                    ]
                ]),
            deferredReason: null
        };

        const result = await worker.setSourcePaused({ root, paused: false });

        assert.equal(result.status, 'ok');
        assert.deepEqual(persisted, { root, paused: false });
        assert.equal(worker.scanners.get(root)?.isRunning(), true);
        assert.equal(result.data.sources.find((source) => source.root === root).paused, false);
        await worker.taskQueue.onIdle();
    } finally {
        if (worker) await worker.finalize();
        cleanup(appDir);
    }
    console.log('  ✅ testSetSourcePausedResumeStartsScannerBeforeSuccess');
}

async function testSetSourcePausedYieldsScannerWithinCandidateBoundary() {
    console.log('  testSetSourcePausedYieldsScannerWithinCandidateBoundary...');
    const scanDir = tmpDir('scan-source-pause-yield');
    const appDir = tmpDir('app-source-pause-yield');
    let worker;
    let releaseScan;
    let pausePromise;
    try {
        for (let i = 0; i < 700; i++) {
            fs.writeFileSync(path.join(scanDir, `file-${i}.txt`), `content ${i}`, 'utf-8');
        }
        const entry = makeEntry(scanDir, []);
        const scanGate = new Promise((resolve) => {
            releaseScan = resolve;
        });
        let saveFilesCalls = 0;
        let saveScannerStateCalls = 0;
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.callApp = () => {};
        worker.config = { entries: [] };
        worker._lastConfig = worker.config;
        worker.status = 'running';
        worker.storage = {
            mode: 'base-only',
            scannerState: {
                roots: {},
                unavailable_roots: {},
                probe_error: null,
                last_rebuild_event: null,
                last_embedding_task_at: null
            },
            syncEmbeddingModeForStartup: async () => {},
            syncEmbeddingMode: async () => {
                await scanGate;
            },
            saveScannerState: async () => {
                saveScannerStateCalls++;
            },
            saveFiles: async () => {
                saveFilesCalls++;
                return { saved: 0, failed: 0, failures: [] };
            },
            setRootPaused: async (root, paused) => {
                worker.storage.scannerState.roots[root].paused = paused;
            },
            isDeferred: () => false,
            detachRootForConfigChange: async () => {},
            removeOrphanedItems: async () => ({ deleted: 0 }),
            removeDeletedFiles: async () => {},
            getStatus: async () => ({
                mode: 'base-only',
                total_files: 700,
                embedded_count: 0,
                pending_count: 700,
                last_embedding_task_at: null,
                db_size: 700,
                vecdb_size: 0,
                chunk_size: 0
            }),
            getPerRootCounts: async () =>
                new Map([
                    [
                        scanDir,
                        {
                            total_files: 700,
                            embedded_count: 0,
                            pending_count: 700,
                            failed_count: 0,
                            last_scan_at: 1
                        }
                    ]
                ]),
            deferredReason: null
        };

        await worker.applicationConfigChanged({ entries: [entry] });
        const scanner = worker.scanners.get(scanDir);
        assert.ok(scanner);
        scanner.state.last_full_scan = Date.now() + 60_000;
        scanner.state.last_scan_at = Date.now();
        scanner.state.total_files = 700;
        scanner.state.last_file_count = 700;
        scanner._counter = 1;
        saveScannerStateCalls = 0;
        let updateChecks = 0;
        scanner._isFileUpdated = () => {
            updateChecks++;
            if (updateChecks === 250) {
                pausePromise = worker.setSourcePaused({ root: scanDir, paused: true });
            }
            return false;
        };

        releaseScan();
        await waitForCondition(() => pausePromise !== undefined, {
            timeoutMs: 5000,
            intervalMs: 5,
            label: 'source pause intent during candidate scan'
        });
        const pauseResult = await pausePromise;

        assert.ok(updateChecks >= 500);
        assert.ok(updateChecks <= 520);
        assert.equal(saveFilesCalls, 0);
        assert.equal(saveScannerStateCalls, 0);
        assert.equal(pauseResult.status, 'ok');
    } finally {
        releaseScan?.();
        await Promise.allSettled([pausePromise].filter(Boolean));
        if (worker) await worker.finalize();
        cleanup(scanDir);
        cleanup(appDir);
    }
    console.log('  ✅ testSetSourcePausedYieldsScannerWithinCandidateBoundary');
}

async function testSetSourcePausedFinishesCurrentSaveBatchOnly() {
    console.log('  testSetSourcePausedFinishesCurrentSaveBatchOnly...');
    const scanDir = tmpDir('scan-source-pause-save-batch');
    const appDir = tmpDir('app-source-pause-save-batch');
    let worker;
    try {
        for (let i = 0; i < 1000; i++) {
            fs.writeFileSync(path.join(scanDir, `file-${i}.txt`), `content ${i}`, 'utf-8');
        }
        const entry = makeEntry(scanDir, []);
        let notifyFirstBatch;
        const firstBatchStarted = new Promise((resolve) => {
            notifyFirstBatch = resolve;
        });
        let releaseFirstBatch;
        const firstBatchGate = new Promise((resolve) => {
            releaseFirstBatch = resolve;
        });
        const batchSizes = [];
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.callApp = () => {};
        worker.config = { entries: [] };
        worker._lastConfig = worker.config;
        worker.status = 'running';
        worker.storage = {
            mode: 'base-only',
            scannerState: {
                roots: {},
                unavailable_roots: {},
                probe_error: null,
                last_rebuild_event: null,
                last_embedding_task_at: null
            },
            syncEmbeddingModeForStartup: async () => {},
            syncEmbeddingMode: async () => {},
            saveScannerState: async () => {},
            saveFiles: async (files) => {
                batchSizes.push(files.length);
                if (batchSizes.length === 1) {
                    notifyFirstBatch();
                    await firstBatchGate;
                }
                return { saved: files.length, failed: 0, failures: [] };
            },
            setRootPaused: async (root, paused) => {
                worker.storage.scannerState.roots[root].paused = paused;
            },
            isDeferred: () => false,
            detachRootForConfigChange: async () => {},
            removeOrphanedItems: async () => ({ deleted: 0 }),
            removeDeletedFiles: async () => {},
            getStatus: async () => ({
                mode: 'base-only',
                total_files: 1000,
                embedded_count: 0,
                pending_count: 1000,
                last_embedding_task_at: null,
                db_size: 1000,
                vecdb_size: 0,
                chunk_size: 0
            }),
            getPerRootCounts: async () =>
                new Map([
                    [
                        scanDir,
                        {
                            total_files: 1000,
                            embedded_count: 0,
                            pending_count: 1000,
                            failed_count: 0,
                            last_scan_at: null
                        }
                    ]
                ]),
            deferredReason: null
        };

        await worker.applicationConfigChanged({ entries: [entry] });
        await firstBatchStarted;
        const pausePromise = worker.setSourcePaused({ root: scanDir, paused: true });
        releaseFirstBatch();
        const paused = await pausePromise;

        assert.equal(paused.status, 'ok');
        assert.deepEqual(batchSizes, [500]);
        assert.equal(worker.scanners.has(scanDir), false);
        assert.equal(worker.storage.scannerState.roots[scanDir].paused, true);
    } finally {
        if (worker) await worker.finalize();
        cleanup(scanDir);
        cleanup(appDir);
    }
    console.log('  ✅ testSetSourcePausedFinishesCurrentSaveBatchOnly');
}

async function testSetSourcePausedYieldsEmbeddingAfterCurrentFile() {
    console.log('  testSetSourcePausedYieldsEmbeddingAfterCurrentFile...');
    const appDir = tmpDir('app-source-pause-embedding');
    const root = path.join(appDir, 'source');
    fs.mkdirSync(root, { recursive: true });
    let worker;
    try {
        const storage = new FSStorage(appDir);
        await storage._resetVectorChunk('test-bootstrap', { dim: 1, mode: 'full' });
        const firstFile = path.join(root, 'first.md');
        const secondFile = path.join(root, 'second.md');
        await storage.storage.upsert(
            [firstFile, secondFile].map((itemId) => ({
                item_id: itemId,
                item_type: 'file',
                filename: path.basename(itemId),
                ext: '.md',
                size: 1,
                modified: 1,
                created: 1,
                accessed: 1,
                type: 'file',
                chunk_text: null,
                root_refs: JSON.stringify([root]),
                ref_count: 1,
                embedded: 0
            })),
            { indexers: ['BaseIndexer'] }
        );
        storage.scannerState.roots[root] = {
            last_full_scan: 1,
            last_scan_at: 1,
            total_files: 2,
            last_file_count: 2,
            paused: false
        };
        await storage.saveScannerState();

        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.callApp = () => {};
        worker.config = { entries: [makeEntry(root)] };
        worker._lastConfig = worker.config;
        worker.status = 'running';
        worker.storage = storage;
        const embeddedPaths = [];
        let releaseFirst;
        let notifyFirst;
        const firstStarted = new Promise((resolve) => {
            notifyFirst = resolve;
        });
        storage.embedSingleFile = async (file) => {
            embeddedPaths.push(file.item_id);
            notifyFirst();
            await new Promise((resolve) => {
                releaseFirst = resolve;
            });
            await storage.storage.update([{ item_id: file.item_id, item_type: 'file', embedded: 1 }], {
                indexers: ['BaseIndexer']
            });
        };

        worker._enqueueEmbeddingQueue();
        await firstStarted;
        const pausePromise = worker.setSourcePaused({ root, paused: true });
        releaseFirst();
        const pauseResult = await pausePromise;

        assert.deepEqual(embeddedPaths, [firstFile]);
        assert.equal(pauseResult.status, 'ok');
    } finally {
        if (worker) await worker.finalize();
        cleanup(appDir);
    }
    console.log('  ✅ testSetSourcePausedYieldsEmbeddingAfterCurrentFile');
}

async function testPausedRootStaysStoppedAcrossConfigRestart() {
    console.log('  testPausedRootStaysStoppedAcrossConfigRestart...');
    const appDir = tmpDir('app-paused-config-restart');
    const pausedRoot = path.join(appDir, 'paused');
    const runnableRoot = path.join(appDir, 'runnable');
    fs.mkdirSync(pausedRoot, { recursive: true });
    fs.mkdirSync(runnableRoot, { recursive: true });
    let worker;
    try {
        const config = { entries: [makeEntry(pausedRoot), makeEntry(runnableRoot)] };
        const roots = {
            [pausedRoot]: {
                last_full_scan: 1,
                last_scan_at: 1,
                total_files: 0,
                last_file_count: 0,
                paused: true
            },
            [runnableRoot]: {
                last_full_scan: 1,
                last_scan_at: 1,
                total_files: 0,
                last_file_count: 0,
                paused: false
            }
        };
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.callApp = () => {};
        worker.config = config;
        worker._lastConfig = config;
        worker.status = 'running';
        worker.storage = {
            mode: 'base-only',
            scannerState: {
                roots,
                unavailable_roots: {},
                probe_error: null,
                last_rebuild_event: null,
                last_embedding_task_at: null
            },
            syncEmbeddingModeForStartup: async () => {},
            syncEmbeddingMode: async () => {},
            saveScannerState: async () => {},
            saveFiles: async (files) => ({ saved: files.length, failed: 0, failures: [] }),
            removeDeletedFiles: async () => {},
            detachRootForConfigChange: async () => {},
            removeOrphanedItems: async () => ({ deleted: 0 }),
            isDeferred: () => false
        };

        await worker.applicationConfigChanged(config);

        assert.equal(worker.scanners.has(pausedRoot), false);
        assert.equal(worker.scanners.get(runnableRoot)?.isRunning(), true);
        assert.equal(roots[pausedRoot].paused, true);
        await worker.taskQueue.onIdle();
    } finally {
        if (worker) await worker.finalize();
        cleanup(appDir);
    }
    console.log('  ✅ testPausedRootStaysStoppedAcrossConfigRestart');
}

async function testPausedStateSurvivesRestartRetainsSearchAndFullReset() {
    console.log('  testPausedStateSurvivesRestartRetainsSearchAndFullReset...');
    const appDir = tmpDir('app-paused-restart-search-reset');
    const scanDir = tmpDir('scan-paused-restart-search-reset');
    const filePath = path.join(scanDir, 'retained-note.txt');
    let firstWorker;
    let secondWorker;
    try {
        Setting.updateInstanceData({ ...settingData, default_embedding_model: '' });
        fs.writeFileSync(filePath, 'retained index content', 'utf-8');
        const config = makeConfig(scanDir);

        firstWorker = new FileManagerWorker('com.test.filemgr', appDir);
        firstWorker.callApp = () => {};
        firstWorker.config = config;
        await firstWorker.initialize();
        await firstWorker.taskQueue.onIdle();
        assert.ok((await firstWorker.searchIndexedFiles('retained', { routes: ['keyword'] })).results.length > 0);

        const paused = await firstWorker.setSourcePaused({ root: scanDir, paused: true });
        assert.equal(paused.status, 'ok');
        await firstWorker.finalize();
        firstWorker = null;

        const persisted = JSON.parse(fs.readFileSync(path.join(appDir, 'scanner_state.json'), 'utf-8'));
        assert.equal(persisted.roots[scanDir].paused, true);

        secondWorker = new FileManagerWorker('com.test.filemgr', appDir);
        secondWorker.callApp = () => {};
        secondWorker.config = config;
        await secondWorker.initialize();
        await secondWorker.taskQueue.onIdle();
        assert.equal(secondWorker.storage.scannerState.roots[scanDir].paused, true);
        assert.equal(secondWorker.scanners.has(scanDir), false);

        const unscoped = await secondWorker.searchIndexedFiles('retained', { routes: ['keyword'] });
        const scoped = await secondWorker.searchIndexedFiles('retained', {
            routes: ['keyword'],
            scope: { type: 'path', path: scanDir }
        });
        assert.ok(unscoped.results.some((result) => result.path === filePath));
        assert.ok(scoped.results.some((result) => result.path === filePath));

        const reset = await secondWorker.resetFileSystemStorage();
        assert.equal(reset.status, 'ok');
        await secondWorker.taskQueue.onIdle();
        assert.equal(secondWorker.storage.scannerState.roots[scanDir].paused, true);
        assert.equal(secondWorker.scanners.has(scanDir), false);
        assert.equal((await secondWorker.searchIndexedFiles('retained', { routes: ['keyword'] })).results.length, 0);
    } finally {
        Setting.updateInstanceData(settingData);
        if (firstWorker) await firstWorker.finalize();
        if (secondWorker) await secondWorker.finalize();
        cleanup(scanDir);
        cleanup(appDir);
    }
    console.log('  ✅ testPausedStateSurvivesRestartRetainsSearchAndFullReset');
}

async function testSourceControlRequestsAreFifoIdempotentAndRootLocal() {
    console.log('  testSourceControlRequestsAreFifoIdempotentAndRootLocal...');
    const appDir = tmpDir('app-source-control-fifo');
    const firstRoot = tmpDir('scan-source-control-fifo-first');
    const secondRoot = tmpDir('scan-source-control-fifo-second');
    let worker;
    try {
        Setting.updateInstanceData({ ...settingData, default_embedding_model: '' });
        fs.writeFileSync(path.join(firstRoot, 'first.txt'), 'first', 'utf-8');
        fs.writeFileSync(path.join(secondRoot, 'second.txt'), 'second', 'utf-8');
        const config = { entries: [makeEntry(firstRoot), makeEntry(secondRoot)] };
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.callApp = () => {};
        worker.config = config;
        await worker.initialize();
        await worker.taskQueue.onIdle();

        const originalSetRootPaused = worker.storage.setRootPaused.bind(worker.storage);
        let activeWrites = 0;
        let maxActiveWrites = 0;
        const applied = [];
        worker.storage.setRootPaused = async (root, paused) => {
            activeWrites++;
            maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
            await new Promise((resolve) => setTimeout(resolve, 5));
            try {
                await originalSetRootPaused(root, paused);
                applied.push([root, paused]);
            } finally {
                activeWrites--;
            }
        };

        const results = await Promise.all([
            worker.setSourcePaused({ root: firstRoot, paused: true }),
            worker.setSourcePaused({ root: firstRoot, paused: true }),
            worker.setSourcePaused({ root: secondRoot, paused: true }),
            worker.setSourcePaused({ root: firstRoot, paused: false }),
            worker.setSourcePaused({ root: firstRoot, paused: false }),
            worker.setSourcePaused({ root: firstRoot, paused: true })
        ]);

        assert.ok(results.every((result) => result.status === 'ok'));
        assert.deepEqual(
            results.map((result) => result.data.sources.find((source) => source.root === firstRoot)?.paused),
            [true, true, true, false, false, true]
        );
        assert.equal(maxActiveWrites, 1);
        assert.deepEqual(applied, [
            [firstRoot, true],
            [secondRoot, true],
            [firstRoot, false],
            [firstRoot, true]
        ]);
        assert.equal(worker.storage.scannerState.roots[firstRoot].paused, true);
        assert.equal(worker.storage.scannerState.roots[secondRoot].paused, true);
        assert.equal(worker.scanners.has(firstRoot), false);
        assert.equal(worker.scanners.has(secondRoot), false);
    } finally {
        Setting.updateInstanceData(settingData);
        if (worker) await worker.finalize();
        cleanup(firstRoot);
        cleanup(secondRoot);
        cleanup(appDir);
    }
    console.log('  ✅ testSourceControlRequestsAreFifoIdempotentAndRootLocal');
}

async function testPausedRootSurvivesConfigEmbeddingAndWorkspaceLifecycles() {
    console.log('  testPausedRootSurvivesConfigEmbeddingAndWorkspaceLifecycles...');
    const appDir = tmpDir('app-paused-public-lifecycles');
    const pausedRoot = tmpDir('scan-paused-public-lifecycles');
    const runnableRoot = tmpDir('scan-runnable-public-lifecycles');
    const addedRoot = tmpDir('scan-added-public-lifecycles');
    let worker;
    try {
        Setting.updateInstanceData({ ...settingData, default_embedding_model: '' });
        fs.writeFileSync(path.join(pausedRoot, 'paused.txt'), 'paused', 'utf-8');
        fs.writeFileSync(path.join(runnableRoot, 'runnable.txt'), 'runnable', 'utf-8');
        fs.writeFileSync(path.join(addedRoot, 'added.txt'), 'added', 'utf-8');
        const initialConfig = { entries: [makeEntry(pausedRoot), makeEntry(runnableRoot)] };
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.callApp = () => {};
        worker.config = initialConfig;
        await worker.initialize();
        await worker.taskQueue.onIdle();
        assert.equal((await worker.setSourcePaused({ root: pausedRoot, paused: true })).status, 'ok');

        const expandedConfig = { entries: [makeEntry(pausedRoot), makeEntry(runnableRoot), makeEntry(addedRoot)] };
        await worker.applicationConfigChanged(expandedConfig);
        await worker.taskQueue.onIdle();
        assert.equal(worker.storage.scannerState.roots[pausedRoot].paused, true);
        assert.equal(worker.storage.scannerState.roots[addedRoot].paused, false);
        assert.equal(worker.scanners.has(pausedRoot), false);
        assert.equal(worker.scanners.get(runnableRoot)?.isRunning(), true);
        assert.equal(worker.scanners.get(addedRoot)?.isRunning(), true);

        const embeddingResult = await worker.embeddingConfigChanged();
        assert.equal(embeddingResult.status, 'ok');
        await worker.taskQueue.onIdle();
        assert.equal(worker.storage.scannerState.roots[pausedRoot].paused, true);
        assert.equal(worker.scanners.has(pausedRoot), false);

        const workspaceResult = await worker.workspaceChanged(pausedRoot);
        assert.equal(workspaceResult.status, 'ok');
        assert.equal(worker.storage.scannerState.roots[pausedRoot].paused, true);
        assert.equal(worker.storage.scannerState.roots[pausedRoot].last_full_scan, 0);
        assert.equal(worker.scanners.has(pausedRoot), false);

        const resumed = await worker.setSourcePaused({ root: pausedRoot, paused: false });
        assert.equal(resumed.status, 'ok');
        assert.equal(worker.scanners.get(pausedRoot)?.isRunning(), true);
        await worker.taskQueue.onIdle();
        assert.ok(worker.storage.scannerState.roots[pausedRoot].last_full_scan > 0);
    } finally {
        Setting.updateInstanceData(settingData);
        if (worker) await worker.finalize();
        cleanup(pausedRoot);
        cleanup(runnableRoot);
        cleanup(addedRoot);
        cleanup(appDir);
    }
    console.log('  ✅ testPausedRootSurvivesConfigEmbeddingAndWorkspaceLifecycles');
}

async function testSourceControlValidationReadonlyAndDeferredWriter() {
    console.log('  testSourceControlValidationReadonlyAndDeferredWriter...');
    const appDir = tmpDir('app-source-control-validation');
    const root = path.join(appDir, 'source');
    const entry = makeEntry(root);
    let worker;
    try {
        fs.mkdirSync(root, { recursive: true });
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.callApp = () => {};
        worker.config = { entries: [entry] };
        worker._lastConfig = worker.config;
        worker.status = 'running';

        for (const request of [null, {}, { root, paused: 'yes' }, { root: '', paused: true }]) {
            const result = await worker.setSourcePaused(request);
            assert.equal(result.status, 'error');
            assert.equal(result.code, 'invalid_request');
        }
        assert.equal((await worker.setSourcePaused({ root, paused: true })).code, 'not_ready');

        const storage = new FSStorage(appDir);
        storage.scannerState.roots[root] = {
            last_full_scan: 5,
            last_scan_at: 6,
            total_files: 7,
            last_file_count: 7,
            paused: false
        };
        await storage.saveScannerState();
        worker.storage = storage;
        assert.equal(storage.isDeferred(), true);

        worker.status = 'error';
        const errorStatus = await worker.setSourcePaused({ root, paused: true });
        assert.equal(errorStatus.code, 'not_ready');
        assert.equal(errorStatus.data.sources.find((source) => source.root === root)?.paused, false);

        worker.status = 'initializing';
        const initializingStatus = await worker.setSourcePaused({ root, paused: true });
        assert.equal(initializingStatus.code, 'not_ready');
        assert.equal(initializingStatus.data.sources.find((source) => source.root === root)?.paused, false);

        worker.status = 'running';
        const savedRootState = storage.scannerState.roots[root];
        delete storage.scannerState.roots[root];
        const missingRootState = await worker.setSourcePaused({ root, paused: true });
        assert.equal(missingRootState.code, 'not_ready');
        assert.equal(missingRootState.data.sources.find((source) => source.root === root)?.paused, false);
        storage.scannerState.roots[root] = savedRootState;

        assert.equal((await worker.setSourcePaused({ root: '/unknown', paused: true })).code, 'unknown_root');

        const deferredPause = await worker.setSourcePaused({ root, paused: true });
        assert.equal(deferredPause.status, 'ok');
        assert.equal(deferredPause.data.isDeferred, true);
        assert.equal(deferredPause.data.sources[0].paused, true);
        assert.equal(
            JSON.parse(fs.readFileSync(path.join(appDir, 'scanner_state.json'), 'utf-8')).roots[root].paused,
            true
        );

        const deferredResume = await worker.setSourcePaused({ root, paused: false });
        assert.equal(deferredResume.status, 'ok');
        assert.equal(deferredResume.data.sources[0].paused, false);
        assert.equal(worker.scanners.get(root)?.isRunning(), true);
        assert.equal((await worker.setSourcePaused({ root, paused: true })).status, 'ok');

        worker._readonlyMode = true;
        const readonly = await worker.setSourcePaused({ root, paused: false });
        assert.equal(readonly.status, 'error');
        assert.equal(readonly.code, 'readonly');
        assert.equal(readonly.data.sources.find((source) => source.root === root)?.paused, true);
        assert.equal(storage.scannerState.roots[root].paused, true);
        assert.equal(
            JSON.parse(fs.readFileSync(path.join(appDir, 'scanner_state.json'), 'utf-8')).roots[root].paused,
            true
        );
    } finally {
        if (worker) await worker.finalize();
        cleanup(appDir);
    }
    console.log('  ✅ testSourceControlValidationReadonlyAndDeferredWriter');
}

async function testSourceControlPersistenceFailuresRollbackDiskMemoryAndRuntime() {
    console.log('  testSourceControlPersistenceFailuresRollbackDiskMemoryAndRuntime...');
    const appDir = tmpDir('app-source-control-persistence-failures');
    const root = tmpDir('scan-source-control-persistence-failures');
    let worker;
    try {
        Setting.updateInstanceData({ ...settingData, default_embedding_model: '' });
        fs.writeFileSync(path.join(root, 'file.txt'), 'file', 'utf-8');
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.callApp = () => {};
        worker.config = makeConfig(root);
        await worker.initialize();
        await worker.taskQueue.onIdle();

        const originalSetRootPaused = worker.storage.setRootPaused.bind(worker.storage);
        worker.storage.setRootPaused = async (_root, paused) => {
            if (paused) throw new Error('injected pause persistence failure');
            return originalSetRootPaused(_root, paused);
        };
        const failedPause = await worker.setSourcePaused({ root, paused: true });
        assert.equal(failedPause.status, 'error');
        assert.equal(failedPause.code, 'persistence_failed');
        assert.equal(worker.storage.scannerState.roots[root].paused, false);
        assert.equal(worker.scanners.get(root)?.isRunning(), true);
        assert.equal(
            JSON.parse(fs.readFileSync(path.join(appDir, 'scanner_state.json'), 'utf-8')).roots[root].paused,
            false
        );

        worker.storage.setRootPaused = originalSetRootPaused;
        assert.equal((await worker.setSourcePaused({ root, paused: true })).status, 'ok');
        worker.storage.setRootPaused = async (_root, paused) => {
            if (!paused) throw new Error('injected resume persistence failure');
            return originalSetRootPaused(_root, paused);
        };
        const failedResume = await worker.setSourcePaused({ root, paused: false });
        assert.equal(failedResume.status, 'error');
        assert.equal(failedResume.code, 'persistence_failed');
        assert.equal(worker.storage.scannerState.roots[root].paused, true);
        assert.equal(worker.scanners.has(root), false);
        assert.equal(
            JSON.parse(fs.readFileSync(path.join(appDir, 'scanner_state.json'), 'utf-8')).roots[root].paused,
            true
        );
    } finally {
        Setting.updateInstanceData(settingData);
        if (worker) await worker.finalize();
        cleanup(root);
        cleanup(appDir);
    }
    console.log('  ✅ testSourceControlPersistenceFailuresRollbackDiskMemoryAndRuntime');
}

async function testSourceControlRuntimeFailuresAndStoppedScannerRecovery() {
    console.log('  testSourceControlRuntimeFailuresAndStoppedScannerRecovery...');
    const appDir = tmpDir('app-source-control-runtime-failures');
    const root = tmpDir('scan-source-control-runtime-failures');
    let worker;
    let originalQueueAdd;
    try {
        Setting.updateInstanceData({ ...settingData, default_embedding_model: '' });
        fs.writeFileSync(path.join(root, 'file.txt'), 'file', 'utf-8');
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.callApp = () => {};
        worker.config = makeConfig(root);
        await worker.initialize();
        await worker.taskQueue.onIdle();

        const runningScanner = worker.scanners.get(root);
        const originalStop = runningScanner.stop.bind(runningScanner);
        runningScanner.stop = async () => {
            throw new Error('injected scanner stop failure');
        };
        const failedStop = await worker.setSourcePaused({ root, paused: true });
        assert.equal(failedStop.status, 'error');
        assert.equal(failedStop.code, 'runtime_failed');
        assert.equal(worker.storage.scannerState.roots[root].paused, false);
        assert.equal(worker.scanners.get(root), runningScanner);
        runningScanner.stop = originalStop;

        assert.equal((await worker.setSourcePaused({ root, paused: true })).status, 'ok');
        let residueStopped = false;
        const stoppedResidue = {
            root,
            entry: makeEntry(root),
            state: worker.storage.scannerState.roots[root],
            isRunning: () => false,
            stop: async () => {
                residueStopped = true;
            }
        };
        worker.scanners.set(root, stoppedResidue);
        const recovered = await worker.setSourcePaused({ root, paused: false });
        assert.equal(recovered.status, 'ok');
        assert.equal(residueStopped, true);
        assert.notEqual(worker.scanners.get(root), stoppedResidue);
        assert.equal(worker.scanners.get(root)?.isRunning(), true);

        assert.equal((await worker.setSourcePaused({ root, paused: true })).status, 'ok');
        let failedResidueStopped = false;
        let partialScanner;
        originalQueueAdd = worker.taskQueue.add.bind(worker.taskQueue);
        worker.scanners.set(root, {
            root,
            entry: makeEntry(root),
            state: worker.storage.scannerState.roots[root],
            isRunning: () => false,
            stop: async () => {
                failedResidueStopped = true;
                worker.taskQueue.add = () => {
                    partialScanner = worker.scanners.get(root);
                    throw new Error('injected scanner start failure');
                };
            }
        });
        const failedStart = await worker.setSourcePaused({ root, paused: false });
        worker.taskQueue.add = originalQueueAdd;
        assert.equal(failedResidueStopped, true);
        assert.ok(partialScanner);
        assert.equal(partialScanner.isRunning(), false);
        assert.equal(failedStart.status, 'error');
        assert.equal(failedStart.code, 'runtime_failed');
        assert.equal(worker.storage.scannerState.roots[root].paused, true);
        assert.equal(worker.scanners.has(root), false);
        assert.equal(
            JSON.parse(fs.readFileSync(path.join(appDir, 'scanner_state.json'), 'utf-8')).roots[root].paused,
            true
        );
    } finally {
        if (worker && originalQueueAdd) {
            worker.taskQueue.add = originalQueueAdd;
        }
        Setting.updateInstanceData(settingData);
        if (worker) await worker.finalize();
        cleanup(root);
        cleanup(appDir);
    }
    console.log('  ✅ testSourceControlRuntimeFailuresAndStoppedScannerRecovery');
}

async function testAllPausedRootsDoNotFallBackToUnfilteredEmbedding() {
    console.log('  testAllPausedRootsDoNotFallBackToUnfilteredEmbedding...');
    const appDir = tmpDir('app-all-paused-no-embedding');
    const roots = [tmpDir('scan-all-paused-first'), tmpDir('scan-all-paused-second')];
    let worker;
    try {
        Setting.updateInstanceData({ ...settingData, default_embedding_model: '' });
        roots.forEach((root, index) => fs.writeFileSync(path.join(root, `${index}.txt`), `${index}`, 'utf-8'));
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.callApp = () => {};
        worker.config = { entries: roots.map((root) => makeEntry(root)) };
        await worker.initialize();
        await worker.taskQueue.onIdle();

        let embeddingCalls = 0;
        worker.storage.mode = 'full';
        worker.storage.processEmbeddingQueue = async () => {
            embeddingCalls++;
            return 0;
        };
        const results = await Promise.all(roots.map((root) => worker.setSourcePaused({ root, paused: true })));
        await worker.taskQueue.onIdle();

        assert.ok(results.every((result) => result.status === 'ok'));
        assert.ok(roots.every((root) => worker.storage.scannerState.roots[root].paused === true));
        assert.equal(worker.scanners.size, 0);
        assert.equal(embeddingCalls, 0);
    } finally {
        Setting.updateInstanceData(settingData);
        if (worker) await worker.finalize();
        roots.forEach(cleanup);
        cleanup(appDir);
    }
    console.log('  ✅ testAllPausedRootsDoNotFallBackToUnfilteredEmbedding');
}

async function testSourceControlReturnsDegradedAuthoritativeSnapshot() {
    console.log('  testSourceControlReturnsDegradedAuthoritativeSnapshot...');
    const appDir = tmpDir('app-source-control-degraded-snapshot');
    const root = tmpDir('scan-source-control-degraded-snapshot');
    let worker;
    try {
        Setting.updateInstanceData({ ...settingData, default_embedding_model: '' });
        fs.writeFileSync(path.join(root, 'file.txt'), 'file', 'utf-8');
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.callApp = () => {};
        worker.config = makeConfig(root);
        await worker.initialize();
        await worker.taskQueue.onIdle();
        worker.storage.getPerRootCounts = async () => {
            throw new Error('injected snapshot count failure');
        };

        const result = await worker.setSourcePaused({ root, paused: true });

        assert.equal(result.status, 'ok');
        assert.equal(result.data.mode, null);
        assert.equal(result.data.sources[0].root, root);
        assert.equal(result.data.sources[0].paused, true);
        assert.equal(result.data.sources[0].state, 'paused');
        assert.equal(result.data.sources[0].last_scan_at !== null, true);
        assert.equal(worker.scanners.has(root), false);
        assert.equal(
            JSON.parse(fs.readFileSync(path.join(appDir, 'scanner_state.json'), 'utf-8')).roots[root].paused,
            true
        );
    } finally {
        Setting.updateInstanceData(settingData);
        if (worker) await worker.finalize();
        cleanup(root);
        cleanup(appDir);
    }
    console.log('  ✅ testSourceControlReturnsDegradedAuthoritativeSnapshot');
}

async function testQueuedRootRemovalWinsOverPauseRequest() {
    console.log('  testQueuedRootRemovalWinsOverPauseRequest...');
    const appDir = tmpDir('app-source-control-remove-race');
    const root = tmpDir('scan-source-control-remove-race');
    let worker;
    let releaseBlocker;
    try {
        Setting.updateInstanceData({ ...settingData, default_embedding_model: '' });
        fs.writeFileSync(path.join(root, 'file.txt'), 'file', 'utf-8');
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.callApp = () => {};
        worker.config = makeConfig(root);
        await worker.initialize();
        await worker.taskQueue.onIdle();

        const blocker = worker.taskQueue.add(
            () =>
                new Promise((resolve) => {
                    releaseBlocker = resolve;
                })
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        const removalPromise = worker.applicationConfigChanged({ entries: [] });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const pauseResult = await worker.setSourcePaused({ root, paused: true });
        assert.equal(pauseResult.status, 'error');
        assert.equal(pauseResult.code, 'unknown_root');
        releaseBlocker();
        await blocker;
        await removalPromise;
        await worker.taskQueue.onIdle();

        assert.equal(worker.storage.scannerState.roots[root], undefined);
        assert.equal(worker.scanners.has(root), false);
        const persisted = JSON.parse(fs.readFileSync(path.join(appDir, 'scanner_state.json'), 'utf-8'));
        assert.equal(persisted.roots[root], undefined);
    } finally {
        releaseBlocker?.();
        Setting.updateInstanceData(settingData);
        if (worker) await worker.finalize();
        cleanup(root);
        cleanup(appDir);
    }
    console.log('  ✅ testQueuedRootRemovalWinsOverPauseRequest');
}

async function testEmbeddingConfigChangedKeepsPausedOnlyRowsPending() {
    console.log('  testEmbeddingConfigChangedKeepsPausedOnlyRowsPending...');
    const appDir = tmpDir('app-embedding-config-paused-row');
    const pausedRoot = tmpDir('scan-embedding-config-paused-row');
    const runnableRoot = tmpDir('scan-embedding-config-runnable-row');
    const pausedFile = path.join(pausedRoot, 'paused.txt');
    const runnableFile = path.join(runnableRoot, 'runnable.txt');
    let worker;
    try {
        Setting.updateInstanceData({ ...settingData, default_embedding_model: '' });
        fs.writeFileSync(pausedFile, 'paused', 'utf-8');
        fs.writeFileSync(runnableFile, 'runnable', 'utf-8');
        worker = new FileManagerWorker('com.test.filemgr', appDir);
        worker.callApp = () => {};
        worker.config = { entries: [makeEntry(pausedRoot), makeEntry(runnableRoot)] };
        await worker.initialize();
        await worker.taskQueue.onIdle();
        assert.equal((await worker.setSourcePaused({ root: pausedRoot, paused: true })).status, 'ok');

        worker.storage.mode = 'full';
        worker.storage.syncEmbeddingModeForStartup = async () => {};
        worker.storage.syncEmbeddingMode = async () => {};
        const embedded = [];
        worker.storage.embedSingleFile = async (file) => {
            embedded.push(file.item_id);
            await worker.storage.storage.update([{ item_id: file.item_id, item_type: 'file', embedded: 1 }], {
                indexers: ['BaseIndexer']
            });
        };

        const pauseAgainPromise = worker.setSourcePaused({ root: pausedRoot, paused: true });
        const result = await worker.embeddingConfigChanged();
        assert.equal((await pauseAgainPromise).status, 'ok');
        assert.equal(result.status, 'ok');
        await worker.taskQueue.onIdle();

        assert.ok(embedded.includes(runnableFile));
        assert.equal(embedded.includes(pausedFile), false);
        assert.equal((await getBaseRow(worker, pausedFile)).embedded, 0);
        assert.equal((await getBaseRow(worker, runnableFile)).embedded, 1);
        assert.deepEqual(JSON.parse((await getBaseRow(worker, pausedFile)).root_refs), [pausedRoot]);
    } finally {
        Setting.updateInstanceData(settingData);
        if (worker) await worker.finalize();
        cleanup(pausedRoot);
        cleanup(runnableRoot);
        cleanup(appDir);
    }
    console.log('  ✅ testEmbeddingConfigChangedKeepsPausedOnlyRowsPending');
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
        testProbeErrorAlertsUseStableCodes,
        testEmptyScannedSourceStateIsCompleted,
        testScannerIntervalUsesWorkspaceAndEmbeddingState,
        testEmbeddingQueueOnlySchedulesInFullMode,
        testEmbeddingQueueFailureIsHandled,
        testFullScanYieldsAfterRemoveDeletedFilesBeforeCheckpoint,
        testConfigChangeKeepsPendingConfigVisibleUntilLastConfigUpdates,
        testSourceConfigPendingDoesNotLeakOnEarlyReturn,
        testWorkspacePendingControlLifecycle,
        testEmbeddingPendingControlLifecycle,
        testSkippedScanTaskDoesNotLeaveScanPending,
        testEmbeddingQueueDoesNotStartDuringPendingControlChange,
        testWorkspaceChangedForExistingEntryForcesFullScanAndImmediateScan,
        testApplicationConfigChangedPassesActiveRootsToEmbeddingQueue,
        testInitializeSchedulesProbeContinuationBeforeStartingScanners,
        testApplicationConfigChangedSyncsModeBeforeRestartingScanners,
        testInitializeClearsEquivalentPendingConfigBeforeStartingScanners,
        testTask16V3ConfigChangeCases,
        testTask16ConfigChangeDedup,
        testConfigChangeDuringInitializeDoesNotDropRemovedRoots,
        testInitializeReconcilesStaleScannerStateRoots,
        testSetSourcePausedStopsScannerPersistsAndReturnsSnapshot,
        testSetSourcePausedResumeStartsScannerBeforeSuccess,
        testSetSourcePausedYieldsScannerWithinCandidateBoundary,
        testSetSourcePausedFinishesCurrentSaveBatchOnly,
        testSetSourcePausedYieldsEmbeddingAfterCurrentFile,
        testPausedRootStaysStoppedAcrossConfigRestart,
        testPausedStateSurvivesRestartRetainsSearchAndFullReset,
        testSourceControlRequestsAreFifoIdempotentAndRootLocal,
        testPausedRootSurvivesConfigEmbeddingAndWorkspaceLifecycles,
        testSourceControlValidationReadonlyAndDeferredWriter,
        testSourceControlPersistenceFailuresRollbackDiskMemoryAndRuntime,
        testSourceControlRuntimeFailuresAndStoppedScannerRecovery,
        testAllPausedRootsDoNotFallBackToUnfilteredEmbedding,
        testSourceControlReturnsDegradedAuthoritativeSnapshot,
        testQueuedRootRemovalWinsOverPauseRequest,
        testEmbeddingConfigChangedKeepsPausedOnlyRowsPending,
        testMultiPathSubsetRunsEachRouteOnce,
        testMultiPathChangePreservesConfiguredSinglePathAndRejectsInvalidSinglePath,
        testMultiPathAllConfiguredSourcesIncludingPausedBecomeUnscoped,
        testMultiPathInvalidNeverCallsARouteOrFallsBackUnscoped,
        testMultiPathWhollyUnavailableSelectedPathFailsButPausedDoesNot,
        testMultiPathRequestedUnionFiltersBackendLeakEvenAfterAllSourceOptimization,
        testMultiPathSelectedSourceRemovalDuringSearchFailsClosed,
        testMultiPathFinalStatWindowReappliesLatestScopePolicy,
        testMultiPathScopeValidationHasDeterministicErrorPriority,
        testE2EBaseOnlyToFullCatchUp
    ];

    const filteredTests = filter ? tests.filter((t) => t.name.includes(filter)) : tests;
    if (filteredTests.length === 0) {
        console.error(`No worker tests matched TEST_FILTER=${filter}`);
        cleanup(globalAppDir);
        process.exit(1);
    }

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
