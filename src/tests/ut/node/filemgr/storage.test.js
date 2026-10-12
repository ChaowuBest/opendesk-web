/**
 * FSStorage integration tests
 *
 * Uses REAL dependencies: real BaseStorage (SQLite in tmp dir), real parseAndChunk,
 * real LLM via OpenRouter API.
 *
 * 运行方式：
 * source ~/.nvm/nvm.sh && nvm use 20 && npx tsx --test src/tests/ut/node/filemgr/storage.test.js
 */

import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { RAW_TEXT_MAX_FILE_SIZE } from '../../../../main/applications/filemgr/parser/extract.js';
import {
    CONTENT_EMBED_MAX_CHARS_PER_CHUNK,
    CONTENT_EMBED_MAX_CHUNKS_PER_FILE,
    CONTENT_EMBED_MAX_TOTAL_CHARS_PER_FILE,
    CODES,
    EMBED_API_BATCH_SIZE,
    FSStorage,
    RebuildRequiredError,
    WARNINGS,
    buildIndexedFilePreconditions,
    classifyEmbeddingError,
    limitChunksForEmbedding,
    makeSchema,
    planEmbeddingInputs
} from '../../../../main/applications/filemgr/storage.js';

assert.deepEqual(buildIndexedFilePreconditions({ scope: undefined, requireEmbedded: false }), [
    { indexer: 'BaseIndexer', field: 'type', operator: '=', value: 'file' },
    { indexer: 'BaseIndexer', field: 'ref_count', operator: '>', value: 0 }
]);
assert.deepEqual(
    buildIndexedFilePreconditions({ scope: { type: 'path', path: '/workspace' }, requireEmbedded: true }),
    [
        { indexer: 'BaseIndexer', field: 'type', operator: '=', value: 'file' },
        { indexer: 'BaseIndexer', field: 'embedded', operator: '=', value: 1 },
        { indexer: 'BaseIndexer', field: 'ref_count', operator: '>', value: 0 },
        { indexer: 'BaseIndexer', field: 'item_id', operator: 'path_descendant_or_self', value: '/workspace' }
    ]
);
assert.deepEqual(
    buildIndexedFilePreconditions({
        scope: { type: 'paths', paths: ['/workspace/a', '/workspace/b'] },
        requireEmbedded: true
    }),
    [
        { indexer: 'BaseIndexer', field: 'type', operator: '=', value: 'file' },
        { indexer: 'BaseIndexer', field: 'embedded', operator: '=', value: 1 },
        { indexer: 'BaseIndexer', field: 'ref_count', operator: '>', value: 0 },
        {
            indexer: 'BaseIndexer',
            field: 'item_id',
            operator: 'path_descendant_or_self',
            value: ['/workspace/a', '/workspace/b']
        }
    ]
);
import { BaseStorage } from '../../../../main/services/storage/abstract-storage.js';
import { VectorIndexer } from '../../../../main/services/storage/vector-indexer.js';
import { ChunkIndexer } from '../../../../main/services/storage/chunk-indexer.js';
import { setArkdataDatabaseKit } from '../../../../main/services/storage/arkdata-bridge.js';
import { dropVectorIndexStoreArkdata } from '../../../../main/services/storage/vector-index-db-arkdata.js';
import { dropChunkIndexStoreArkdata } from '../../../../main/services/storage/chunk-index-db-arkdata.js';
import { Setting, setCustomOpendeskDirectory } from '../../../../main/utils/setting.js';
import { LLM } from '../../../../main/aikernel/llm.ts';
import { logger } from '../../../../main/utils/logger.js';

// ── Constants & Helpers ─────────────────────────────────────────────

const SAMPLE_MD_CONTENT = `# Project Architecture Guide

This document describes the architecture of our software system. The main components include
the authentication service, the data pipeline, and the notification engine.

## Authentication Service

The auth service handles user login, token refresh, and session management. It uses JWT tokens
with a 24-hour expiry window. Rate limiting is applied at 100 requests per minute per user.

## Data Pipeline

The data pipeline processes incoming events through three stages: validation, transformation,
and storage. Each stage runs as an independent worker with its own queue.

## Notification Engine

The notification engine supports email, SMS, and push notifications. Templates are stored in
the database and rendered at send time using Handlebars syntax.
`;

function tmpDir(name) {
    const dir = path.join(os.tmpdir(), `filemgr-test-${name}-${Date.now()}`);
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

async function withPlatform(value, fn) {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value });
    try {
        return await fn();
    } finally {
        Object.defineProperty(process, 'platform', descriptor);
    }
}

// ── Global Setting setup ────────────────────────────────────────────
// Must set custom app dir BEFORE Setting.getInstance() is called.
// Initialised here (before the no-API early-exit) so that tests that
// depend on settingData / globalAppDir can run in the fast path too.
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

// Persist setting to disk so Setting.load() works after clearCache()
fs.writeFileSync(path.join(globalAppDir, 'setting.json'), JSON.stringify(settingData, null, 4), 'utf-8');

Setting.updateInstanceData(settingData);

if (!OPENROUTER_API_KEY) {
    console.log('OPENROUTER_API_KEY not set, running pure storage tests');
    const filter = process.env.TEST_FILTER;
    if (filter) {
        const filteredTests = [
            testEmbedSingleFileOversizedContentFallsBackToFilenameOnly,
            testGetStatusReportsMetadata,
            testRefCountZeroHiddenFromSearchQueueAndStats,
            testCarveOutKeepsIntermediateRowInvisibleUntilChildScan,
            testInitializeSyncEmbeddingGate,
            testProbeEmbeddingBudgetOptions,
            testScannerStateMigratesLegacyProbeError,
            testScannerStateMigratesPausedWithoutResettingCheckpoint,
            testSetRootPausedPersistsDiskBeforeMemoryCommit,
            testSetRootPausedUsesCallTimeSnapshot,
            testQueuedCheckpointSaveKeepsCommittedPause,
            testSetRootPausedFailureDoesNotLeakIntoLaterSave,
            testProbeEmbeddingOpenHarmonyReducesLargeDimensions,
            testProbeEmbeddingOpenHarmonyOnlyReportsDimUnsupportedForWrongReducedDim,
            testProbeEmbeddingOpenHarmonyMapsReducedFailuresToConfigError,
            testSyncEmbeddingModeRecordsRequestDimForConsistentState,
            testDetachRootForConfigChangeBatchesLargeDeletes,
            testPerRootCountsUseRootRefsForOverlappingRoots,
            testPerRootCountsNormalizeRootRefsBeforeCompare,
            testPerRootCountsNormalizeWindowsSeparatorsBeforeCompare,
            testHarmonyPerRootCountsUseFreshCache,
            testHarmonyPerRootCountsReturnStaleWhileRefreshInFlight,
            testHarmonyPerRootCountsFallbackToScannerStateOnError,
            testHarmonyPerRootCountsClearCacheHelpers,
            testHarmonyPerRootCountsClearInvalidatesInFlightRefresh,
            testHarmonyPerRootCountsModeTransitionClearsCache,
            testProcessEmbeddingQueueExcludesPausedOnlyOwnership
        ].filter((test) => test.name.includes(filter));
        for (const test of filteredTests) {
            await test();
        }
        cleanup(globalAppDir);
        process.exit(0);
    }
    await testScannerStateNewField();
    await testScannerStateMigratesLastFileCount();
    await testScannerStateMigratesLastScanAt();
    await testScannerStateMigratesPausedWithoutResettingCheckpoint();
    await testSetRootPausedPersistsDiskBeforeMemoryCommit();
    await testSetRootPausedUsesCallTimeSnapshot();
    await testQueuedCheckpointSaveKeepsCommittedPause();
    await testSetRootPausedFailureDoesNotLeakIntoLaterSave();
    await testScannerStateMigratesLegacyProbeError();
    await testProbeErrorPersistsAndNotifies();
    await testClassifyEmbeddingErrorTableRules();
    await testSyncEmbeddingModeClearsProbeErrorWhenModelMissing();
    await testSyncEmbeddingModeClearsProbeErrorAfterSuccessfulProbe();
    await testSyncEmbeddingModePersistsProbeError();
    await testProbeEmbeddingOpenHarmonyReducesLargeDimensions();
    await testProbeEmbeddingOpenHarmonyOnlyReportsDimUnsupportedForWrongReducedDim();
    await testProbeEmbeddingOpenHarmonyMapsReducedFailuresToConfigError();
    await testSyncEmbeddingModeRecordsRequestDimForConsistentState();
    await testSyncEmbeddingModeUsesCanonicalResetReasons();
    await testInitializeSyncEmbeddingGate();
    await testProbeEmbeddingBudgetOptions();
    await testMakeSchemaModes();
    await testMigrateRefCountBackfillsLegacyRowsOnce();
    await testSearchItemsUnderRootUsesSubtreeBounds();
    await testRemoveRootFromItemsKeepsEmptyRefsForCoveredChildren();
    await testDetachRootForConfigChangeKeepsNewChildRootRows();
    await testDetachRootForConfigChangeBatchesLargeDeletes();
    await testRemoveDeletedFilesUsesActiveRootsWithoutSelfKeeping();
    await testRefCountZeroHiddenFromSearchQueueAndStats();
    await testProcessEmbeddingQueueUsesRootAwareCandidates();
    await testProcessEmbeddingQueueExcludesPausedOnlyOwnership();
    await testProcessEmbeddingQueueYieldsAtFileBoundary();
    await testRootAwareCandidatesDedupMultiRootFile();
    await testCarveOutKeepsIntermediateRowInvisibleUntilChildScan();
    await testGetPerRootCountsReportsVisibleFailedUnavailableAndBaseOnly();
    await testPerRootCountsUseRootRefsForOverlappingRoots();
    await testPerRootCountsNormalizeRootRefsBeforeCompare();
    await testPerRootCountsNormalizeWindowsSeparatorsBeforeCompare();
    await testHarmonyPerRootCountsUseFreshCache();
    await testHarmonyPerRootCountsReturnStaleWhileRefreshInFlight();
    await testHarmonyPerRootCountsFallbackToScannerStateOnError();
    await testHarmonyPerRootCountsClearCacheHelpers();
    await testHarmonyPerRootCountsClearInvalidatesInFlightRefresh();
    await testHarmonyPerRootCountsModeTransitionClearsCache();
    await testResetVectorChunkAcceptsExplicitDimAndMode();
    await testResetVectorChunkPreservesBaseAndResetsEmbedded();
    await testUninitializedVectorAndChunkIndexersDropOldDimStorage();
    await testResetVectorChunkRecoversFromBaseOnlyOldDimStorage();
    await testResetVectorChunkDoesNotPublishHalfInitializedStorage();
    await testArkDataRawDropOnlyDropsTables();
    await testResetVectorChunkRecordsRebuildEvent();
    await testResetVectorChunkPreservesOriginalErrorWhenEventSaveFails();
    await testRebuildAllRecordsFullEventAndResetsVectorState();
    await testRebuildAllRecordsFailedFullEvent();
    await testRebuildAllPreservesOriginalErrorWhenEventSaveFails();
    await testSaveFilesBaseOnlyWritesEmbeddedZero();
    await testSaveFilesRefOnlyPreservesEmbedded();
    await testSaveFilesModifiedChangedResetsEmbedded();
    await testSaveFilesMaintainsRootRefsAndRefCountScenarios();
    await testPlanEmbeddingInputsSplitsOversizedChunksAndCapsBudget();
    await testSemanticWriteStateDefaultsToAccepting();
    await testEmbedSingleFileSkipsChunksWhenChunkWritesLimited();
    await testEmbedSingleFileSkipsSemanticWorkWhenVectorWritesLimited();
    await testEmbedWithRetryUsesSmallApiBatch();
    await testEmbedWithRetryDoesNotRetryPermanentQuota();
    await testEmbedSingleFileOversizedContentFallsBackToFilenameOnly();
    await testEmbedSingleFileGoneDeletes();
    await testInitializeBaseOnlyWhenNoEmbedding();
    await testSearchByNameBaseOnlyReturnsEmbedUnavailable();
    await testSearchBaseOnlyWithoutPermanentErrorReturnsEmbedUnavailable();
    await testSearchBlankQueryReturnsEmptyResult();
    await testSearchDeferredReturnsIndexNotReady();
    await testSearchBaseOnlyPermanentErrorReturnsEmbedApiDown();
    await testSearchEmbedFailureReturnsEmbedApiDown();
    await testSearchSemanticRoutesExposeScores();
    await testScopedSearchDiagnosticsIncludeFilemgrRouteAndScope();
    await testSearchIndexedChunksContractAndRerankFallback();
    await testSearchFilesByKeywordSupportsLimit();
    await testProcessEmbeddingQueueSkipsFileErrorsOnce();
    await testProcessEmbeddingQueueMarksPermanentFileErrorsAsDisabled();
    await testProcessEmbeddingQueueKeepsAmbiguousBadRequestRetryable();
    await testProcessEmbeddingQueuePrioritizesFreshBeforeFailed();
    await testProcessEmbeddingQueueStopsImmediatelyOnPermanentApiErrors();
    await testProcessEmbeddingQueueSkipsResetApiFailureStreak();
    await testInitializeReadonlyMissingBaseIndexDoesNotWriteState();
    await testInitializeReadonlyUsesStorageProbeInsteadOfHardcodedBasePath();
    await testInitializeReadonlyOpensExistingBaseIndex();
    cleanup(globalAppDir);
    process.exit(0);
}

// ── Helper: create FSStorage with initialized Setting ───────────────

async function createFSStorage(testDir) {
    const fss = new FSStorage(testDir);
    await fss.initialize();
    return fss;
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

function makeLegacySchemaWithoutRefCount() {
    const schema = makeSchema(1, { mode: 'base-only' });
    const columns = { ...schema.columns };
    delete columns.ref_count;

    return {
        columns,
        needIndexers: {}
    };
}

async function seedLegacyStorage(storageDir, items) {
    const storage = new BaseStorage('filemgr', makeLegacySchemaWithoutRefCount(), storageDir);
    await storage.initialize();
    await storage.upsert(items, { indexers: ['BaseIndexer'] });
    await storage.close();
}

async function getBaseRow(fss, filePath) {
    const rows = await fss.storage.search([
        { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: filePath }
    ]);
    assert.equal(rows.items.length, 1, `expected one row for ${filePath}`);
    return rows.items[0].item;
}

function assertRefsAndCount(row, expectedRefs) {
    assert.deepEqual(JSON.parse(row.root_refs).sort(), [...expectedRefs].sort());
    assert.equal(row.ref_count, expectedRefs.length);
}

function makeStoredFileItem(filePath, rootRefs, overrides = {}) {
    return {
        item_id: filePath,
        item_type: 'file',
        filename: path.basename(filePath),
        ext: path.extname(filePath),
        size: 1,
        modified: 1,
        created: 1,
        accessed: 1,
        type: 'file',
        chunk_text: null,
        root_refs: JSON.stringify(rootRefs),
        ref_count: rootRefs.length,
        embedded: 0,
        ...overrides
    };
}

// ── Test 4: _parseRootRefs ──────────────────────────────────────────

async function testParseRootRefs() {
    console.log('  testParseRootRefs...');
    const testDir = tmpDir('parse-refs');
    let fss;
    try {
        fss = new FSStorage(testDir);
        // Don't need to initialize for _parseRootRefs

        // null → []
        assert.deepEqual(fss._parseRootRefs(null), []);

        // undefined → []
        assert.deepEqual(fss._parseRootRefs(undefined), []);

        // valid JSON array → parsed
        assert.deepEqual(fss._parseRootRefs('["a","b","c"]'), ['a', 'b', 'c']);

        // non-array JSON → []
        assert.deepEqual(fss._parseRootRefs('{"key":"val"}'), []);

        // invalid JSON → []
        assert.deepEqual(fss._parseRootRefs('not json at all'), []);

        // non-string elements are filtered out
        const result = fss._parseRootRefs('["/root", 42, "/other", null, true]');
        assert.deepEqual(result, ['/root', '/other']);

        // empty string → []
        assert.deepEqual(fss._parseRootRefs(''), []);

        console.log('  ✅ testParseRootRefs');
    } finally {
        cleanup(testDir);
    }
}

// ── Test 5: searchFileByName ────────────────────────────────────────

async function testSearchFileByName() {
    console.log('  testSearchFileByName...');
    const testDir = tmpDir('search-name');
    let fss;
    try {
        fss = await createFSStorage(testDir);

        // Create and index a few files
        const files = [
            { name: 'readme.md', content: SAMPLE_MD_CONTENT },
            { name: 'config.yaml', content: 'server:\n  port: 8080\n  host: localhost\n' },
            { name: 'notes.txt', content: 'Some notes about the project setup and deployment process.\n'.repeat(5) }
        ];

        const fileEntries = [];
        for (const f of files) {
            const filePath = path.join(testDir, f.name);
            fs.writeFileSync(filePath, f.content, 'utf-8');
            fileEntries.push(makeFileEntry(filePath));
        }
        await fss.saveFiles(fileEntries, testDir);

        // Search by name (keyword-based, uses BaseIndexer LIKE query)
        const result = await fss.searchFilesByKeyword('readme');
        assert.ok(Array.isArray(result), 'result should be an array');
        assert.ok(result.length > 0, 'should find at least one result');

        // First result should have expected shape
        const first = result[0];
        assert.ok(typeof first.path === 'string', 'result item should have path');
        assert.ok(typeof first.filename === 'string', 'result item should have filename');

        console.log('  ✅ testSearchFileByName');
    } finally {
        await fss?.close();
        cleanup(testDir);
    }
}

// ── Test 6: searchFileByContent ─────────────────────────────────────

async function testSearchFileByContent() {
    console.log('  testSearchFileByContent...');
    const testDir = tmpDir('search-content');
    let fss;
    try {
        fss = await createFSStorage(testDir);

        // Create multiple .md files with content that will produce multiple chunks
        const file1 = path.join(testDir, 'architecture.md');
        fs.writeFileSync(file1, SAMPLE_MD_CONTENT, 'utf-8');

        const file2Content = `# Deployment Guide

This guide covers deploying the application to production environments.

## Docker Setup

Build the Docker image using the provided Dockerfile. The multi-stage build
reduces the final image size by separating build dependencies from runtime.

## Kubernetes Configuration

Deploy using Helm charts in the k8s/ directory. The deployment includes
horizontal pod autoscaling based on CPU and memory metrics.

## Monitoring

Prometheus metrics are exposed on port 9090. Grafana dashboards are
preconfigured for latency, throughput, and error rate monitoring.
`;
        const file2 = path.join(testDir, 'deployment.md');
        fs.writeFileSync(file2, file2Content, 'utf-8');

        const entries = [file1, file2].map(makeFileEntry);
        await fss.saveFiles(entries, testDir);

        // Verify base index has both files
        const status = await fss.getStatus();
        assert.ok(status.db_size >= 2, 'should have 2 files in BaseIndexer');

        // Search by keyword — base-only search, no vector data needed
        const result = await fss.searchFilesByKeyword('architecture');
        assert.ok(Array.isArray(result), 'result should be an array');
        assert.ok(result.length > 0, 'should find at least one result by keyword');

        // Result follows SearchResultItem shape
        const first = result[0];
        assert.ok(typeof first.path === 'string', 'result should have path');
        assert.ok(typeof first.filename === 'string', 'result should have filename');

        console.log('  ✅ testSearchFileByContent');
    } finally {
        await fss?.close();
        cleanup(testDir);
    }
}

// ── Test 7: removeDeletedFiles multi-root ───────────────────────────

async function testRemoveDeletedFilesMultiRoot() {
    console.log('  testRemoveDeletedFilesMultiRoot...');
    const testDir = tmpDir('multi-root');
    let fss;
    try {
        fss = await createFSStorage(testDir);

        const root1 = '/fake/root1';
        const root2 = '/fake/root2';

        // Create a file and index it under root1
        const mdPath = path.join(testDir, 'shared.md');
        fs.writeFileSync(mdPath, SAMPLE_MD_CONTENT, 'utf-8');
        const fileEntry = makeFileEntry(mdPath);

        await fss.saveFiles([fileEntry], root1);

        // Add root2 as a second root for the same file
        await fss.saveFiles([fileEntry], root2);

        // Verify root_refs has both roots
        const afterBoth = await fss.storage.search([
            { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: mdPath }
        ]);
        const rootRefs = JSON.parse(afterBoth.items[0].item.root_refs);
        assert.ok(rootRefs.includes(root1), 'should have root1');
        assert.ok(rootRefs.includes(root2), 'should have root2');

        // Remove from root1 (file not in scannedPaths for root1)
        await fss.removeDeletedFiles(root1, new Set());

        // File should still exist (detached from root1, still has root2)
        const afterDetach = await fss.storage.search([
            { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: mdPath }
        ]);
        assert.equal(afterDetach.items.length, 1, 'file should still exist after detaching one root');
        const refsAfterDetach = JSON.parse(afterDetach.items[0].item.root_refs);
        assert.ok(!refsAfterDetach.includes(root1), 'root1 should be removed');
        assert.ok(refsAfterDetach.includes(root2), 'root2 should still be present');
        assert.equal(afterDetach.items[0].item.ref_count, 1, 'ref_count should follow remaining root_refs');

        // Remove from root2 → should delete
        await fss.removeDeletedFiles(root2, new Set());
        const afterDelete = await fss.storage.search([
            { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: mdPath }
        ]);
        assert.equal(afterDelete.items.length, 0, 'file should be deleted after removing all roots');

        console.log('  ✅ testRemoveDeletedFilesMultiRoot');
    } finally {
        await fss?.close();
        cleanup(testDir);
    }
}

async function testSearchItemsUnderRootUsesSubtreeBounds() {
    console.log('  testSearchItemsUnderRootUsesSubtreeBounds...');
    const dir = tmpDir('subtree-bounds');
    let fss;
    try {
        fss = new FSStorage(dir);
        await fss._resetVectorChunk('test-bootstrap', { dim: 1, mode: 'base-only' });

        const root = path.join(dir, 'foo');
        await fss.storage.upsert(
            [
                makeStoredFileItem(path.join(root, 'a.md'), [root]),
                makeStoredFileItem(path.join(root, 'nested', 'b.md'), [root]),
                makeStoredFileItem(path.join(dir, 'foobar', 'c.md'), [path.join(dir, 'foobar')]),
                makeStoredFileItem(path.join(dir, 'fooish', 'd.md'), [path.join(dir, 'fooish')])
            ],
            { indexers: ['BaseIndexer'] }
        );

        const result = await fss._searchItemsUnderRoot(root);
        const itemIds = result.items.map((it) => it.item.item_id).sort();
        assert.deepEqual(itemIds, [path.join(root, 'a.md'), path.join(root, 'nested', 'b.md')].sort());
    } finally {
        await fss?.close();
        cleanup(dir);
    }
    console.log('  ✅ testSearchItemsUnderRootUsesSubtreeBounds');
}

async function testRemoveRootFromItemsKeepsEmptyRefsForCoveredChildren() {
    console.log('  testRemoveRootFromItemsKeepsEmptyRefsForCoveredChildren...');
    const dir = tmpDir('remove-root-keep-empty');
    let fss;
    try {
        fss = new FSStorage(dir);
        await fss._resetVectorChunk('test-bootstrap', { dim: 1, mode: 'base-only' });

        const root = path.join(dir, 'root');
        const keep = path.join(root, 'keep.md');
        const remove = path.join(root, 'remove.md');
        await fss.storage.upsert([makeStoredFileItem(keep, [root]), makeStoredFileItem(remove, [root])], {
            indexers: ['BaseIndexer']
        });

        const result = await fss._removeRootFromItems(root, undefined, {
            deleteEmptyRefs: true,
            keepEmptyRefsIf: (itemPath) => itemPath === keep
        });
        assert.deepEqual(result, { deleted: 1, detached: 1 });

        const kept = await getBaseRow(fss, keep);
        assertRefsAndCount(kept, []);
        const removed = await fss.storage.search([
            { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: remove }
        ]);
        assert.equal(removed.items.length, 0, 'uncovered empty-ref row should be deleted');
    } finally {
        await fss?.close();
        cleanup(dir);
    }
    console.log('  ✅ testRemoveRootFromItemsKeepsEmptyRefsForCoveredChildren');
}

async function testDetachRootForConfigChangeKeepsNewChildRootRows() {
    console.log('  testDetachRootForConfigChangeKeepsNewChildRootRows...');
    const dir = tmpDir('detach-root-config-change');
    let fss;
    try {
        fss = new FSStorage(dir);
        await fss._resetVectorChunk('test-bootstrap', { dim: 1, mode: 'base-only' });

        const parentRoot = path.join(dir, 'project');
        const childRoot = path.join(parentRoot, 'src');
        fss.scannerState.roots[parentRoot] = { last_full_scan: 1, total_files: 3, last_file_count: 3 };
        fss.scannerState.roots[childRoot] = { last_full_scan: 1, total_files: 1, last_file_count: 1 };

        const childPending = path.join(childRoot, 'pending.md');
        const childShared = path.join(childRoot, 'shared.md');
        const uncovered = path.join(parentRoot, 'docs', 'old.md');
        await fss.storage.upsert(
            [
                makeStoredFileItem(childPending, [parentRoot]),
                makeStoredFileItem(childShared, [parentRoot, childRoot]),
                makeStoredFileItem(uncovered, [parentRoot])
            ],
            { indexers: ['BaseIndexer'] }
        );

        await fss.detachRootForConfigChange(parentRoot, [{ root: childRoot }]);

        assert.equal(fss.scannerState.roots[parentRoot], undefined);
        assert.ok(fss.scannerState.roots[childRoot]);
        assertRefsAndCount(await getBaseRow(fss, childPending), []);
        assertRefsAndCount(await getBaseRow(fss, childShared), [childRoot]);
        const deleted = await fss.storage.search([
            { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: uncovered }
        ]);
        assert.equal(deleted.items.length, 0, 'rows not covered by new roots should be deleted');
    } finally {
        await fss?.close();
        cleanup(dir);
    }
    console.log('  ✅ testDetachRootForConfigChangeKeepsNewChildRootRows');
}

async function testDetachRootForConfigChangeBatchesLargeDeletes() {
    console.log('  testDetachRootForConfigChangeBatchesLargeDeletes...');
    const dir = tmpDir('detach-root-large-delete');
    let fss;
    try {
        fss = new FSStorage(dir);
        await fss._resetVectorChunk('test-bootstrap', { dim: 1, mode: 'base-only' });

        const root = path.join(dir, 'large-root');
        const itemCount = 1200;
        fss.scannerState.roots[root] = { last_full_scan: 1, total_files: itemCount, last_file_count: itemCount };

        const items = [];
        for (let i = 0; i < itemCount; i++) {
            items.push(makeStoredFileItem(path.join(root, `file-${i}.md`), [root]));
        }
        await fss.storage.upsert(items, { indexers: ['BaseIndexer'] });

        const batchSizes = [];
        const originalDelete = fss.storage.baseIndexer.delete.bind(fss.storage.baseIndexer);
        fss.storage.baseIndexer.delete = async (itemIds) => {
            batchSizes.push(itemIds.length);
            assert.ok(itemIds.length <= 500, `delete batch too large: ${itemIds.length}`);
            return originalDelete(itemIds);
        };

        await fss.detachRootForConfigChange(root, []);

        assert.deepEqual(batchSizes, [500, 500, 200]);
        const remaining = await fss._searchItemsUnderRoot(root);
        assert.equal(remaining.items.length, 0, 'large removed root rows should be deleted');
        assert.equal(fss.scannerState.roots[root], undefined);
    } finally {
        await fss?.close();
        cleanup(dir);
    }
    console.log('  ✅ testDetachRootForConfigChangeBatchesLargeDeletes');
}

async function testRemoveDeletedFilesUsesActiveRootsWithoutSelfKeeping() {
    console.log('  testRemoveDeletedFilesUsesActiveRootsWithoutSelfKeeping...');
    const dir = tmpDir('remove-deleted-active-roots');
    let fss;
    try {
        fss = new FSStorage(dir);
        await fss._resetVectorChunk('test-bootstrap', { dim: 1, mode: 'base-only' });

        const parentRoot = path.join(dir, 'project');
        const childRoot = path.join(parentRoot, 'src');
        const childPending = path.join(childRoot, 'pending.md');
        const uncovered = path.join(parentRoot, 'docs', 'old.md');
        const selfRoot = path.join(dir, 'self');
        const selfOnly = path.join(selfRoot, 'gone.md');

        await fss.storage.upsert(
            [
                makeStoredFileItem(childPending, [parentRoot]),
                makeStoredFileItem(uncovered, [parentRoot]),
                makeStoredFileItem(selfOnly, [selfRoot])
            ],
            { indexers: ['BaseIndexer'] }
        );

        await fss.removeDeletedFiles(parentRoot, new Set(), { activeRoots: [parentRoot, childRoot] });
        assertRefsAndCount(await getBaseRow(fss, childPending), []);
        const deleted = await fss.storage.search([
            { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: uncovered }
        ]);
        assert.equal(deleted.items.length, 0, 'uncovered deleted file should be removed');

        await fss.removeDeletedFiles(selfRoot, new Set(), { activeRoots: [selfRoot] });
        const selfDeleted = await fss.storage.search([
            { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: selfOnly }
        ]);
        assert.equal(selfDeleted.items.length, 0, 'scanner root must not keep its own missing rows');
    } finally {
        await fss?.close();
        cleanup(dir);
    }
    console.log('  ✅ testRemoveDeletedFilesUsesActiveRootsWithoutSelfKeeping');
}

async function testRefCountZeroHiddenFromSearchQueueAndStats() {
    console.log('  testRefCountZeroHiddenFromSearchQueueAndStats...');
    const dir = tmpDir('ref-count-zero-hidden');
    const originalEmbed = LLM.embed;
    const originalRerank = LLM.rerank;
    let fss;
    try {
        fss = new FSStorage(dir);
        await fss._resetVectorChunk('test-bootstrap', { dim: 1, mode: 'full' });
        fss.scannerState.vec_dim = 1;

        const root = path.join(dir, 'root');
        const visible = path.join(root, 'visible-needle.md');
        const hidden = path.join(root, 'hidden-needle.md');
        const hiddenPending = path.join(root, 'hidden-pending.md');
        await fss.storage.upsert(
            [
                makeStoredFileItem(visible, [root], {
                    embedding_generation: fss.scannerState.embedding_generation,
                    embedded: 1
                }),
                makeStoredFileItem(hidden, [], {
                    embedding_generation: fss.scannerState.embedding_generation,
                    embedded: 1
                }),
                makeStoredFileItem(hiddenPending, [], {
                    embedding_generation: fss.scannerState.embedding_generation,
                    embedded: 0
                })
            ],
            { indexers: ['BaseIndexer'] }
        );
        await fss.storage.upsert(
            [
                {
                    item_id: visible,
                    item_type: 'file',
                    filename: 'visible-needle.md',
                    chunk_text: null,
                    indexer_columns: {
                        VectorIndexer: [{ column: 'filename', content: [0.1] }],
                        ChunkIndexer: [
                            { column: 'chunk_text', id: 'visible-1', text: 'visible needle', content: [0.1] }
                        ]
                    }
                },
                {
                    item_id: hidden,
                    item_type: 'file',
                    filename: 'hidden-needle.md',
                    chunk_text: null,
                    indexer_columns: {
                        VectorIndexer: [{ column: 'filename', content: [0.1] }],
                        ChunkIndexer: [{ column: 'chunk_text', id: 'hidden-1', text: 'hidden needle', content: [0.1] }]
                    }
                }
            ],
            { indexers: ['VectorIndexer', 'ChunkIndexer'] }
        );

        LLM.embed = async () => [0.1];
        LLM.rerank = async (_query, items) => items;

        const keyword = await fss.searchFilesByKeyword('needle');
        assert.deepEqual(
            keyword.map((item) => item.path),
            [visible],
            'keyword search should hide ref_count=0 rows'
        );

        const byName = await fss.searchFileByName('needle');
        assert.ok(
            !byName.results.some((item) => item.path === hidden),
            'vector name search should hide ref_count=0 rows'
        );

        const byContent = await fss.searchIndexedChunks('needle', { topK: 20 });
        assert.ok(
            !byContent.results.some((item) => item.source.path === hidden),
            'vector content search should hide ref_count=0 rows'
        );

        const stats = await fss.getGlobalFileCounts();
        assert.equal(stats.total_files, 1);
        assert.equal(stats.embedded_count, 1);
        assert.equal(stats.pending_count, 0);

        const embedCalls = [];
        fss.embedSingleFile = async (row) => {
            embedCalls.push(row.item_id);
        };
        const processed = await fss.processEmbeddingQueue(() => false);
        assert.equal(processed, 0);
        assert.deepEqual(embedCalls, [], 'embedding queue should skip ref_count=0 pending rows');
    } finally {
        LLM.embed = originalEmbed;
        LLM.rerank = originalRerank;
        await fss?.close();
        cleanup(dir);
    }
    console.log('  ✅ testRefCountZeroHiddenFromSearchQueueAndStats');
}

async function testProcessEmbeddingQueueUsesRootAwareCandidates() {
    console.log('  testProcessEmbeddingQueueUsesRootAwareCandidates...');
    const dir = tmpDir('embedding-root-aware');
    let fss;
    try {
        fss = new FSStorage(dir);
        await fss._resetVectorChunk('test-bootstrap', { dim: 1, mode: 'full' });

        const workspaceRoot = '/workspace';
        const docsRoot = '/docs';
        const rows = [];
        for (let i = 1; i <= 8; i++) {
            rows.push(
                makeStoredFileItem(`${workspaceRoot}/file-${i}.md`, [workspaceRoot], {
                    embedding_generation: fss.scannerState.embedding_generation,
                    embedded: 0
                })
            );
        }
        for (let i = 1; i <= 8; i++) {
            rows.push(
                makeStoredFileItem(`${docsRoot}/file-${i}.md`, [docsRoot], {
                    embedding_generation: fss.scannerState.embedding_generation,
                    embedded: 0
                })
            );
        }
        await fss.storage.upsert(rows, { indexers: ['BaseIndexer'] });

        const seen = [];
        fss.embedSingleFile = async (file) => {
            seen.push(file.item_id);
            await fss.storage.update(
                [
                    {
                        item_id: file.item_id,
                        item_type: 'file',
                        embedded: 1,
                        embedding_generation: fss.scannerState.embedding_generation
                    }
                ],
                {
                    indexers: ['BaseIndexer']
                }
            );
        };

        const processed = await fss.processEmbeddingQueue(() => false, {
            activeRoots: [workspaceRoot, docsRoot],
            currentWorkspace: workspaceRoot,
            limit: 6
        });

        assert.equal(processed, 16);
        const firstBatch = seen.slice(0, 6);
        const firstBatchWorkspace = firstBatch.filter((id) => id.startsWith(workspaceRoot)).length;
        const firstBatchDocs = firstBatch.filter((id) => id.startsWith(docsRoot)).length;
        assert.ok(firstBatchWorkspace > 0, 'workspace root should receive candidates');
        assert.ok(firstBatchDocs > 0, 'normal root should not be starved by workspace root');
        assert.deepEqual(
            [firstBatchWorkspace, firstBatchDocs],
            [4, 2],
            'workspace priority weight should pick two workspace files for each normal-root file'
        );

        const workspaceProcessed = seen.filter((id) => id.startsWith(workspaceRoot)).length;
        const docsProcessed = seen.filter((id) => id.startsWith(docsRoot)).length;
        assert.equal(workspaceProcessed, 8);
        assert.equal(docsProcessed, 8);
    } finally {
        await fss?.close();
        cleanup(dir);
    }
    console.log('  ✅ testProcessEmbeddingQueueUsesRootAwareCandidates');
}

async function testProcessEmbeddingQueueYieldsAtFileBoundary() {
    console.log('  testProcessEmbeddingQueueYieldsAtFileBoundary...');
    const dir = tmpDir('embedding-yield-boundary');
    let fss;
    try {
        fss = new FSStorage(dir);
        await fss._resetVectorChunk('test-bootstrap', { dim: 1, mode: 'full' });

        const root = '/workspace';
        await fss.storage.upsert(
            [1, 2, 3].map((i) =>
                makeStoredFileItem(`${root}/file-${i}.md`, [root], {
                    embedding_generation: fss.scannerState.embedding_generation,
                    embedded: 0
                })
            ),
            { indexers: ['BaseIndexer'] }
        );

        const seen = [];
        let scanPending = false;
        fss.embedSingleFile = async (file) => {
            seen.push(file.item_id);
            await fss.storage.update(
                [
                    {
                        item_id: file.item_id,
                        item_type: 'file',
                        embedded: 1,
                        embedding_generation: fss.scannerState.embedding_generation
                    }
                ],
                {
                    indexers: ['BaseIndexer']
                }
            );
            scanPending = true;
        };

        const processed = await fss.processEmbeddingQueue(() => scanPending, {
            activeRoots: [root],
            limit: 50
        });

        assert.equal(processed, 1);
        assert.equal(seen.length, 1);
    } finally {
        await fss?.close();
        cleanup(dir);
    }
    console.log('  ✅ testProcessEmbeddingQueueYieldsAtFileBoundary');
}

async function testProcessEmbeddingQueueExcludesPausedOnlyOwnership() {
    console.log('  testProcessEmbeddingQueueExcludesPausedOnlyOwnership...');
    const dir = tmpDir('embedding-runnable-ownership');
    let fss;
    try {
        fss = new FSStorage(dir);
        await fss._resetVectorChunk('test-bootstrap', { dim: 1, mode: 'full' });
        const pausedRoot = '/paused';
        const runnableRoot = '/runnable';
        const pausedOnly = `${pausedRoot}/only.md`;
        const runnableOnly = `${runnableRoot}/only.md`;
        const shared = `${runnableRoot}/shared.md`;
        await fss.storage.upsert(
            [
                makeStoredFileItem(pausedOnly, [pausedRoot], {
                    embedding_generation: fss.scannerState.embedding_generation,
                    embedded: 0
                }),
                makeStoredFileItem(runnableOnly, [runnableRoot], {
                    embedding_generation: fss.scannerState.embedding_generation,
                    embedded: 0
                }),
                makeStoredFileItem(shared, [pausedRoot, runnableRoot], {
                    embedding_generation: fss.scannerState.embedding_generation,
                    embedded: 0,
                    ref_count: 2
                })
            ],
            { indexers: ['BaseIndexer'] }
        );
        const seen = [];
        fss.embedSingleFile = async (row) => {
            seen.push(row.item_id);
            await fss.storage.update(
                [
                    {
                        item_id: row.item_id,
                        item_type: 'file',
                        embedded: 1,
                        embedding_generation: fss.scannerState.embedding_generation
                    }
                ],
                {
                    indexers: ['BaseIndexer']
                }
            );
        };

        const processed = await fss.processEmbeddingQueue(() => false, { activeRoots: [runnableRoot] });

        assert.equal(processed, 2);
        assert.deepEqual(seen.sort(), [runnableOnly, shared].sort());
        const pending = await fss.storage.search([
            { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: pausedOnly }
        ]);
        assert.equal(pending.items[0].item.embedded, 0);
        const sharedRow = await fss.storage.search([
            { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: shared }
        ]);
        assert.equal(sharedRow.items[0].item.embedded, 1);
        assert.deepEqual(JSON.parse(sharedRow.items[0].item.root_refs).sort(), [pausedRoot, runnableRoot].sort());
        assert.equal(sharedRow.items[0].item.ref_count, 2);
    } finally {
        await fss?.close();
        cleanup(dir);
    }
    console.log('  ✅ testProcessEmbeddingQueueExcludesPausedOnlyOwnership');
}

async function testRootAwareCandidatesDedupMultiRootFile() {
    console.log('  testRootAwareCandidatesDedupMultiRootFile...');
    const dir = tmpDir('embedding-root-dedup');
    let fss;
    try {
        fss = new FSStorage(dir);
        await fss._resetVectorChunk('test-bootstrap', { dim: 1, mode: 'full' });

        const root = '/workspace';
        const childRoot = '/workspace/src';
        const file = `${childRoot}/shared.md`;
        await fss.storage.upsert(
            [
                makeStoredFileItem(file, [root, childRoot], {
                    embedding_generation: fss.scannerState.embedding_generation,
                    embedded: 0,
                    ref_count: 2
                })
            ],
            {
                indexers: ['BaseIndexer']
            }
        );

        const seen = [];
        fss.embedSingleFile = async (row) => {
            seen.push(row.item_id);
            await fss.storage.update(
                [
                    {
                        item_id: row.item_id,
                        item_type: 'file',
                        embedded: 1,
                        embedding_generation: fss.scannerState.embedding_generation
                    }
                ],
                {
                    indexers: ['BaseIndexer']
                }
            );
        };

        const processed = await fss.processEmbeddingQueue(() => false, {
            activeRoots: [root, childRoot],
            currentWorkspace: root,
            limit: 50
        });

        assert.equal(processed, 1);
        assert.deepEqual(seen, [file]);
    } finally {
        await fss?.close();
        cleanup(dir);
    }
    console.log('  ✅ testRootAwareCandidatesDedupMultiRootFile');
}

async function testCarveOutKeepsIntermediateRowInvisibleUntilChildScan() {
    console.log('  testCarveOutKeepsIntermediateRowInvisibleUntilChildScan...');
    const dir = tmpDir('carve-out-convergence');
    let fss;
    try {
        fss = new FSStorage(dir);
        await fss._resetVectorChunk('test-bootstrap', { dim: 1, mode: 'full' });

        const parentRoot = path.join(dir, 'project');
        const childRoot = path.join(parentRoot, 'src');
        const file = path.join(childRoot, 'feature.md');
        fs.mkdirSync(childRoot, { recursive: true });
        fs.writeFileSync(file, '# feature');

        await fss.saveFiles([makeFileEntry(file)], parentRoot);
        await fss.storage.update(
            [
                {
                    item_id: file,
                    item_type: 'file',
                    embedded: 1,
                    embedding_generation: fss.scannerState.embedding_generation
                }
            ],
            { indexers: ['BaseIndexer'] }
        );

        await fss.removeDeletedFiles(parentRoot, new Set(), { activeRoots: [parentRoot, childRoot] });
        let row = await getBaseRow(fss, file);
        assertRefsAndCount(row, []);
        assert.equal(row.embedded, 1, 'carve-out intermediate row should preserve embedded=1 to avoid duplicate work');

        let stats = await fss.getGlobalFileCounts();
        assert.equal(stats.total_files, 0);
        assert.equal(stats.embedded_count, 0);
        assert.equal(stats.pending_count, 0);
        const hiddenSearch = await fss.searchFilesByKeyword('feature');
        assert.equal(hiddenSearch.length, 0, 'carve-out intermediate row should be hidden from search');

        await fss.saveFiles([makeFileEntry(file)], childRoot);
        row = await getBaseRow(fss, file);
        assertRefsAndCount(row, [childRoot]);
        assert.equal(row.embedded, 1, 'child scan should adopt the row without resetting embedded');

        stats = await fss.getGlobalFileCounts();
        assert.equal(stats.total_files, 1);
        assert.equal(stats.embedded_count, 1);
        assert.equal(stats.pending_count, 0);
    } finally {
        await fss?.close();
        cleanup(dir);
    }
    console.log('  ✅ testCarveOutKeepsIntermediateRowInvisibleUntilChildScan');
}

async function testGetPerRootCountsReportsVisibleFailedUnavailableAndBaseOnly() {
    console.log('  testGetPerRootCountsReportsVisibleFailedUnavailableAndBaseOnly...');
    const dir = tmpDir('per-root-counts');
    let fss;
    try {
        fss = new FSStorage(dir);
        await fss._resetVectorChunk('test-bootstrap', { dim: 1, mode: 'full' });

        const rootA = path.join(dir, 'a');
        const rootB = path.join(dir, 'b');
        fss.scannerState.roots[rootA] = {
            last_full_scan: 1000,
            last_scan_at: 1100,
            total_files: 3,
            last_file_count: 3
        };
        fss.scannerState.roots[rootB] = {
            last_full_scan: 2000,
            last_scan_at: 2100,
            total_files: 1,
            last_file_count: 1
        };

        await fss.storage.upsert(
            [
                makeStoredFileItem(path.join(rootA, 'embedded.md'), [rootA], {
                    embedding_generation: fss.scannerState.embedding_generation,
                    embedded: 1
                }),
                makeStoredFileItem(path.join(rootA, 'pending.md'), [rootA], {
                    embedding_generation: fss.scannerState.embedding_generation,
                    embedded: 0
                }),
                makeStoredFileItem(path.join(rootA, 'failed.md'), [rootA], {
                    embedding_generation: fss.scannerState.embedding_generation,
                    embedded: -2
                }),
                makeStoredFileItem(path.join(rootA, 'middle.md'), [], {
                    embedding_generation: fss.scannerState.embedding_generation,
                    embedded: 1
                }),
                makeStoredFileItem(path.join(rootB, 'done.md'), [rootB], {
                    embedding_generation: fss.scannerState.embedding_generation,
                    embedded: 1
                })
            ],
            { indexers: ['BaseIndexer'] }
        );

        const counts = await fss.getPerRootCounts([rootB, rootA]);
        assert.deepEqual([...counts.keys()], [rootB, rootA], 'Map should preserve input root order');
        assert.deepEqual(counts.get(rootB), {
            total_files: 1,
            embedded_count: 1,
            pending_count: 0,
            failed_count: 0,
            last_scan_at: 2100
        });
        assert.deepEqual(counts.get(rootA), {
            total_files: 3,
            embedded_count: 1,
            pending_count: 1,
            failed_count: 1,
            last_scan_at: 1100
        });

        await fss.close();
        fss = new FSStorage(dir);
        await fss._resetVectorChunk('test-bootstrap', { dim: 1, mode: 'base-only' });

        const root = path.join(dir, 'base');
        const unavailableRoot = path.join(dir, 'missing');
        fss.scannerState.roots[root] = {
            last_full_scan: 1000,
            last_scan_at: 1200,
            total_files: 2,
            last_file_count: 2
        };
        fss.scannerState.roots[unavailableRoot] = {
            last_full_scan: 2000,
            last_scan_at: 2200,
            total_files: 42,
            last_file_count: 42
        };
        fss.scannerState.unavailable_roots[unavailableRoot] = {
            since: Date.now(),
            last_count: 42
        };

        await fss.storage.upsert(
            [
                makeStoredFileItem(path.join(root, 'embedded-but-base-only.md'), [root], {
                    embedding_generation: fss.scannerState.embedding_generation,
                    embedded: 1
                }),
                makeStoredFileItem(path.join(root, 'pending-but-base-only.md'), [root], {
                    embedding_generation: fss.scannerState.embedding_generation,
                    embedded: 0
                })
            ],
            { indexers: ['BaseIndexer'] }
        );

        const baseOnlyCounts = await fss.getPerRootCounts([root, unavailableRoot]);
        assert.deepEqual(baseOnlyCounts.get(root), {
            total_files: 2,
            embedded_count: 0,
            pending_count: 2,
            failed_count: 0,
            last_scan_at: 1200
        });
        assert.deepEqual(baseOnlyCounts.get(unavailableRoot), {
            total_files: 42,
            embedded_count: 0,
            pending_count: 0,
            failed_count: 0,
            last_scan_at: 2200
        });
    } finally {
        await fss?.close();
        cleanup(dir);
    }
    console.log('  ✅ testGetPerRootCountsReportsVisibleFailedUnavailableAndBaseOnly');
}

async function testPerRootCountsUseRootRefsForOverlappingRoots() {
    console.log('  testPerRootCountsUseRootRefsForOverlappingRoots...');
    const fss = Object.create(FSStorage.prototype);
    fss.mode = 'full';
    fss.scannerState = { roots: { '/Documents': {}, '/Documents/sub': {} }, unavailable_roots: {} };
    fss.storage = {
        async search(conditions) {
            const lower = conditions.find((c) => c.field === 'item_id' && c.operator === '>=').value;
            if (lower === '/Documents/') {
                return {
                    totalCount: 2,
                    items: [
                        {
                            item: {
                                item_id: '/Documents/sub/a.txt',
                                item_type: 'file',
                                type: 'file',
                                root_refs: JSON.stringify(['/Documents/sub']),
                                ref_count: 1,
                                embedded: 1
                            }
                        },
                        {
                            item: {
                                item_id: '/Documents/b.txt',
                                item_type: 'file',
                                type: 'file',
                                root_refs: JSON.stringify(['/Documents']),
                                ref_count: 1,
                                embedded: 0
                            }
                        }
                    ]
                };
            }
            return { totalCount: 0, items: [] };
        }
    };

    fss.storage.countGrouped = async (_fields, conditions) => {
        const result = await fss.storage.search(conditions);
        return result.items.map(({ item }) => ({ values: item, count: 1 }));
    };
    const counts = await fss.getPerRootCounts(['/Documents']);
    assert.equal(counts.get('/Documents').total_files, 1);
    assert.equal(counts.get('/Documents').embedded_count, 0);
    assert.equal(counts.get('/Documents').pending_count, 1);
    console.log('  ✅ testPerRootCountsUseRootRefsForOverlappingRoots');
}

async function testPerRootCountsNormalizeRootRefsBeforeCompare() {
    console.log('  testPerRootCountsNormalizeRootRefsBeforeCompare...');
    const fss = Object.create(FSStorage.prototype);
    fss.mode = 'base-only';
    fss.scannerState = { roots: { '/Documents': {} }, unavailable_roots: {} };
    fss.storage = {
        async search() {
            return {
                totalCount: 1,
                items: [
                    {
                        item: {
                            item_id: '/Documents/a.txt',
                            item_type: 'file',
                            type: 'file',
                            root_refs: JSON.stringify(['/Documents/']),
                            ref_count: 1,
                            embedded: 0
                        }
                    }
                ]
            };
        }
    };

    fss.storage.countGrouped = async (_fields, conditions) => {
        const result = await fss.storage.search(conditions);
        return result.items.map(({ item }) => ({ values: item, count: 1 }));
    };
    const counts = await fss.getPerRootCounts(['/Documents']);
    assert.deepEqual(counts.get('/Documents'), {
        total_files: 1,
        embedded_count: 0,
        pending_count: 1,
        failed_count: 0,
        last_scan_at: null
    });
    console.log('  ✅ testPerRootCountsNormalizeRootRefsBeforeCompare');
}

async function testPerRootCountsNormalizeWindowsSeparatorsBeforeCompare() {
    console.log('  testPerRootCountsNormalizeWindowsSeparatorsBeforeCompare...');
    const fss = Object.create(FSStorage.prototype);
    fss.mode = 'base-only';
    fss.scannerState = { roots: { 'C:/Users/Stella/Docs': {} }, unavailable_roots: {} };
    fss.storage = {
        async search() {
            return {
                totalCount: 1,
                items: [
                    {
                        item: {
                            item_id: 'C:/Users/Stella/Docs/a.txt',
                            item_type: 'file',
                            type: 'file',
                            root_refs: JSON.stringify(['C:\\Users\\Stella\\Docs\\']),
                            ref_count: 1,
                            embedded: 0
                        }
                    }
                ]
            };
        }
    };

    fss.storage.countGrouped = async (_fields, conditions) => {
        const result = await fss.storage.search(conditions);
        return result.items.map(({ item }) => ({ values: item, count: 1 }));
    };
    const counts = await fss.getPerRootCounts(['C:/Users/Stella/Docs']);
    assert.deepEqual(counts.get('C:/Users/Stella/Docs'), {
        total_files: 1,
        embedded_count: 0,
        pending_count: 1,
        failed_count: 0,
        last_scan_at: null
    });
    console.log('  ✅ testPerRootCountsNormalizeWindowsSeparatorsBeforeCompare');
}

async function testHarmonyPerRootCountsUseFreshCache() {
    console.log('  testHarmonyPerRootCountsUseFreshCache...');
    await withPlatform('openharmony', async () => {
        const fss = Object.create(FSStorage.prototype);
        fss.mode = 'base-only';
        fss._perRootCountsCache = new Map();
        fss.scannerState = { roots: { '/Documents': {} }, unavailable_roots: {} };
        let calls = 0;
        fss.storage = {
            async search() {
                calls++;
                return {
                    totalCount: 1,
                    items: [
                        {
                            item: {
                                item_id: '/Documents/a.txt',
                                item_type: 'file',
                                type: 'file',
                                root_refs: JSON.stringify(['/Documents']),
                                ref_count: 1,
                                embedded: 0
                            }
                        }
                    ]
                };
            }
        };
        fss.storage.countGrouped = async (_fields, conditions) => {
            const result = await fss.storage.search(conditions);
            return result.items.map(({ item }) => ({ values: item, count: 1 }));
        };

        const first = await fss.getPerRootCounts(['/Documents']);
        const second = await fss.getPerRootCounts(['/Documents']);
        assert.equal(first.get('/Documents').total_files, 1);
        assert.equal(second.get('/Documents').total_files, 1);
        assert.equal(calls, 1);
    });
    console.log('  ✅ testHarmonyPerRootCountsUseFreshCache');
}

async function testHarmonyPerRootCountsReturnStaleWhileRefreshInFlight() {
    console.log('  testHarmonyPerRootCountsReturnStaleWhileRefreshInFlight...');
    await withPlatform('openharmony', async () => {
        const fss = Object.create(FSStorage.prototype);
        fss.mode = 'base-only';
        fss._perRootCountsCache = new Map([
            [
                '/Documents',
                {
                    computedAt: Date.now() - 60_000,
                    counts: {
                        total_files: 7,
                        embedded_count: 0,
                        pending_count: 7,
                        failed_count: 0
                    },
                    inFlight: null
                }
            ]
        ]);
        fss.scannerState = {
            roots: {
                '/Documents': {
                    total_files: 7,
                    last_file_count: 7
                }
            },
            unavailable_roots: {}
        };

        let calls = 0;
        let releaseBlocker;
        const blocker = new Promise((resolve) => {
            releaseBlocker = resolve;
        });
        fss.storage = {
            async search() {
                calls++;
                await blocker;
                return {
                    totalCount: 8,
                    items: [
                        {
                            item: {
                                item_id: '/Documents/refreshed.txt',
                                item_type: 'file',
                                type: 'file',
                                root_refs: JSON.stringify(['/Documents']),
                                ref_count: 1,
                                embedded: 0
                            }
                        }
                    ]
                };
            }
        };
        fss.storage.countGrouped = async (_fields, conditions) => {
            const result = await fss.storage.search(conditions);
            return result.items.map(({ item }) => ({ values: item, count: 1 }));
        };

        const timeout = Symbol('timeout');
        let result;
        try {
            const countsPromise = fss.getPerRootCounts(['/Documents']);
            result = await Promise.race([
                countsPromise,
                new Promise((resolve) => setTimeout(() => resolve(timeout), 25))
            ]);
            assert.notEqual(result, timeout, 'getPerRootCounts should return stale counts without waiting for refresh');
            assert.equal(result.get('/Documents').total_files, 7);
            assert.equal(calls, 1);
            const entry = fss._perRootCountsCache.get('/Documents');
            assert.ok(entry.inFlight);
            releaseBlocker();
            await entry.inFlight;
            assert.equal(fss._perRootCountsCache.get('/Documents').inFlight, null);
        } finally {
            releaseBlocker();
        }
    });
    console.log('  ✅ testHarmonyPerRootCountsReturnStaleWhileRefreshInFlight');
}

async function testHarmonyPerRootCountsFallbackToScannerStateOnError() {
    console.log('  testHarmonyPerRootCountsFallbackToScannerStateOnError...');
    await withPlatform('openharmony', async () => {
        const fss = Object.create(FSStorage.prototype);
        fss.mode = 'full';
        fss._perRootCountsCache = new Map();
        fss.scannerState = {
            roots: {
                '/Documents': {
                    total_files: 123,
                    last_file_count: 99,
                    last_scan_at: 456
                }
            },
            unavailable_roots: {}
        };
        fss.storage = {
            async search() {
                throw new Error('synthetic status count failure');
            }
        };
        fss.storage.countGrouped = async (_fields, conditions) => {
            const result = await fss.storage.search(conditions);
            return result.items.map(({ item }) => ({ values: item, count: 1 }));
        };

        const counts = await fss.getPerRootCounts(['/Documents']);
        assert.deepEqual(counts.get('/Documents'), {
            total_files: 123,
            embedded_count: 0,
            pending_count: 123,
            failed_count: 0,
            last_scan_at: 456
        });
    });
    console.log('  ✅ testHarmonyPerRootCountsFallbackToScannerStateOnError');
}

async function testHarmonyPerRootCountsClearCacheHelpers() {
    console.log('  testHarmonyPerRootCountsClearCacheHelpers...');
    const fss = Object.create(FSStorage.prototype);
    fss._perRootCountsCache = new Map([
        ['/Documents', { computedAt: Date.now(), counts: { total_files: 1 }, inFlight: null }],
        ['/Downloads', { computedAt: Date.now(), counts: { total_files: 2 }, inFlight: null }]
    ]);

    fss._clearPerRootCountsCache('/Documents');
    assert.equal(fss._perRootCountsCache.has('/Documents'), false);
    assert.equal(fss._perRootCountsCache.has('/Downloads'), true);
    fss._clearPerRootCountsCache();
    assert.equal(fss._perRootCountsCache.size, 0);
    console.log('  ✅ testHarmonyPerRootCountsClearCacheHelpers');
}

async function testHarmonyPerRootCountsClearInvalidatesInFlightRefresh() {
    console.log('  testHarmonyPerRootCountsClearInvalidatesInFlightRefresh...');
    await withPlatform('openharmony', async () => {
        const fss = Object.create(FSStorage.prototype);
        fss.mode = 'base-only';
        fss._perRootCountsCache = new Map([
            [
                '/Documents',
                {
                    computedAt: Date.now() - 60_000,
                    counts: {
                        total_files: 7,
                        embedded_count: 0,
                        pending_count: 7,
                        failed_count: 0
                    },
                    inFlight: null
                }
            ]
        ]);
        fss.scannerState = {
            roots: {
                '/Documents': {
                    total_files: 7,
                    last_file_count: 7
                }
            },
            unavailable_roots: {}
        };

        let releaseBlocker;
        const blocker = new Promise((resolve) => {
            releaseBlocker = resolve;
        });
        fss.storage = {
            async search() {
                await blocker;
                return {
                    totalCount: 1,
                    items: [
                        {
                            item: {
                                item_id: '/Documents/new.txt',
                                item_type: 'file',
                                type: 'file',
                                root_refs: JSON.stringify(['/Documents']),
                                ref_count: 1,
                                embedded: 0
                            }
                        }
                    ]
                };
            }
        };
        fss.storage.countGrouped = async (_fields, conditions) => {
            const result = await fss.storage.search(conditions);
            return result.items.map(({ item }) => ({ values: item, count: 1 }));
        };

        const counts = await fss.getPerRootCounts(['/Documents']);
        assert.equal(counts.get('/Documents').total_files, 7);
        const oldInFlight = fss._perRootCountsCache.get('/Documents').inFlight;
        assert.ok(oldInFlight);

        fss._clearPerRootCountsCache('/Documents');
        assert.equal(fss._perRootCountsCache.has('/Documents'), false);
        releaseBlocker();
        await oldInFlight;

        assert.equal(fss._getAnyCachedPerRootCount('/Documents'), null);
        assert.equal(fss._getFreshCachedPerRootCount('/Documents'), null);
    });
    console.log('  ✅ testHarmonyPerRootCountsClearInvalidatesInFlightRefresh');
}

async function testHarmonyPerRootCountsModeTransitionClearsCache() {
    console.log('  testHarmonyPerRootCountsModeTransitionClearsCache...');
    const fss = Object.create(FSStorage.prototype);
    fss._perRootCountsCache = new Map([
        [
            '/Documents',
            {
                computedAt: Date.now(),
                counts: {
                    total_files: 3,
                    embedded_count: 2,
                    pending_count: 1,
                    failed_count: 0
                },
                inFlight: null
            }
        ]
    ]);

    fss._clearPerRootCountsCacheForModeTransition();
    assert.equal(fss._perRootCountsCache.size, 0);
    console.log('  ✅ testHarmonyPerRootCountsModeTransitionClearsCache');
}

// ── Test 8: _detachRoot in deferred state ───────────────────────────

async function testDetachRootDeferred() {
    console.log('  testDetachRootDeferred...');
    const testDir = tmpDir('detach-deferred');
    try {
        // Create FSStorage but don't initialize (deferred state: storage=null)
        const fss = new FSStorage(testDir);
        fs.mkdirSync(testDir, { recursive: true });
        // Manually set scanner state with a root
        fss.scannerState.roots['/some/root'] = {
            last_full_scan: 1000,
            total_files: 50,
            last_failed_count: 0
        };

        assert.ok(fss.isDeferred(), 'should be in deferred state');

        // _detachRoot should succeed without storage access
        await fss._detachRoot('/some/root');

        // Root should be removed from state
        assert.ok(!('/some/root' in fss.scannerState.roots), 'root should be removed from state');

        // State should be saved to disk
        const savedState = JSON.parse(fs.readFileSync(fss._scannerStatePath, 'utf-8'));
        assert.ok(!('/some/root' in savedState.roots), 'root should be removed from saved state');

        console.log('  ✅ testDetachRootDeferred');
    } finally {
        cleanup(testDir);
    }
}

// ── Test 9: saveScannerState concurrent ─────────────────────────────

async function testSaveScannerStateConcurrent() {
    console.log('  testSaveScannerStateConcurrent...');
    const testDir = tmpDir('save-concurrent');
    try {
        const fss = new FSStorage(testDir);
        fs.mkdirSync(testDir, { recursive: true });

        // Fire saves with interleaved mutations — each save captures a different
        // snapshot of the roots object. The chain should serialize writes so the
        // final file contains the last mutation's state, never a torn/partial write.
        const saves = [];
        for (let i = 0; i < 10; i++) {
            fss.scannerState.roots[`/root${i}`] = {
                last_full_scan: Date.now() + i,
                total_files: i * 10,
                last_failed_count: i
            };
            saves.push(fss.saveScannerState());
            // Also fire a save that updates an existing root mid-chain
            if (i > 0) {
                fss.scannerState.roots[`/root${i - 1}`].total_files = (i - 1) * 10 + 999;
                saves.push(fss.saveScannerState());
            }
        }

        await Promise.all(saves);

        // Verify the file is valid JSON (not torn/corrupted)
        const raw = fs.readFileSync(fss._scannerStatePath, 'utf-8');
        const parsed = JSON.parse(raw);
        assert.ok(parsed && typeof parsed === 'object', 'saved state should be valid JSON object');
        assert.ok(typeof parsed.roots === 'object', 'should have roots');

        // All 10 roots should be present
        for (let i = 0; i < 10; i++) {
            assert.ok(`/root${i}` in parsed.roots, `should have /root${i}`);
        }

        // The last write should reflect the final mutation (root0-root8 updated to +999)
        for (let i = 0; i < 9; i++) {
            assert.equal(
                parsed.roots[`/root${i}`].total_files,
                i * 10 + 999,
                `root${i} should have updated total_files`
            );
        }

        console.log('  ✅ testSaveScannerStateConcurrent');
    } finally {
        cleanup(testDir);
    }
}

// ── Test 10: _embedWithRetry retries on 429 ──────────────────────────

async function testEmbedWithRetry429() {
    console.log('  testEmbedWithRetry429...');
    const testDir = tmpDir('embed-retry');
    let fss;
    const originalBatchEmbed = LLM.batchEmbed;
    try {
        fss = new FSStorage(testDir);
        fs.mkdirSync(testDir, { recursive: true });

        // Mock LLM.batchEmbed to fail with 429 a few times, then succeed
        let callCount = 0;
        const successResult = await originalBatchEmbed.call(LLM, ['test']);
        const embedDim = successResult[0].length;

        LLM.batchEmbed = async (texts) => {
            callCount++;
            if (callCount <= 3) {
                // Detected as rate-limit via message regex `/too\s+many\s+requests/i`
                // (RateLimitDetector.MESSAGE_PATTERNS). Plain Error doesn't match the
                // APIError-status branch, so we rely on message-pattern matching here.
                throw new Error('429 Too Many Requests');
            }
            // Return fake embeddings of correct dimension
            return texts.map(() => new Array(embedDim).fill(0).map(() => Math.random()));
        };

        const result = await fss._embedWithRetry(['hello', 'world']);
        assert.equal(result.length, 2, 'should return 2 embeddings');
        assert.equal(result[0].length, embedDim, 'embedding dimension should match');
        assert.ok(callCount >= 4, `should have retried (callCount=${callCount})`);
        assert.ok(callCount <= 8, `should not exceed maxRetries=8 (callCount=${callCount})`);

        console.log('  ✅ testEmbedWithRetry429');
    } finally {
        LLM.batchEmbed = originalBatchEmbed;
        cleanup(testDir);
    }
}

async function testEmbedWithRetryUsesSmallApiBatch() {
    console.log('  testEmbedWithRetryUsesSmallApiBatch...');
    const testDir = tmpDir('embed-batch-size');
    const originalBatchEmbed = LLM.batchEmbed;
    try {
        const fss = new FSStorage(testDir);
        let seenBatchSize = null;
        LLM.batchEmbed = async (texts, batchSize) => {
            seenBatchSize = batchSize;
            return texts.map(() => [1]);
        };

        const result = await fss._embedWithRetry(['hello', 'world']);

        assert.equal(seenBatchSize, EMBED_API_BATCH_SIZE);
        assert.equal(EMBED_API_BATCH_SIZE, 32);
        assert.deepEqual(result, [[1], [1]]);
    } finally {
        LLM.batchEmbed = originalBatchEmbed;
        cleanup(testDir);
    }
    console.log('  ✅ testEmbedWithRetryUsesSmallApiBatch');
}

async function testEmbedWithRetryDoesNotRetryPermanentQuota() {
    console.log('  testEmbedWithRetryDoesNotRetryPermanentQuota...');
    const testDir = tmpDir('embed-no-retry-quota');
    const originalBatchEmbed = LLM.batchEmbed;
    try {
        const fss = new FSStorage(testDir);
        let callCount = 0;
        LLM.batchEmbed = async () => {
            callCount++;
            const err = new Error('Key limit exceeded monthly limit');
            err.status = 403;
            throw err;
        };

        await assert.rejects(() => fss._embedWithRetry(['hello']), /monthly limit/);
        assert.equal(callCount, 1, 'quota errors should not consume retry budget');
    } finally {
        LLM.batchEmbed = originalBatchEmbed;
        cleanup(testDir);
    }
    console.log('  ✅ testEmbedWithRetryDoesNotRetryPermanentQuota');
}

// ── Test 11: makeSchema supports base-only and full modes ───────────

async function testMakeSchemaModes() {
    console.log('  testMakeSchemaModes...');
    const baseOnly = makeSchema(1024, { mode: 'base-only' });
    assert.deepEqual(baseOnly.needIndexers, {});

    const full = makeSchema(1024, { mode: 'full' });
    assert.equal(full.needIndexers.filename[0].indexer, 'VectorIndexer');
    assert.equal(full.needIndexers.chunk_text[0].indexer, 'ChunkIndexer');

    assert.equal(baseOnly.columns.embedded.defaultValue, 0);
    assert.equal(full.columns.embedded.defaultValue, 0);
    assert.equal(baseOnly.columns.ref_count.defaultValue, 0);
    assert.equal(full.columns.ref_count.defaultValue, 0);
    console.log('  ✅ testMakeSchemaModes');
}

// ── Test: ref_count migration backfills legacy rows once ────────────

async function testMigrateRefCountBackfillsLegacyRowsOnce() {
    console.log('  testMigrateRefCountBackfillsLegacyRowsOnce...');
    const dir = tmpDir('migrate-ref-count');
    const storageDir = path.join(dir, 'storage');
    const fileA = path.join(dir, 'a.md');
    const fileB = path.join(dir, 'b.md');
    const originalSetting = Setting.getInstance().data;
    try {
        fs.writeFileSync(fileA, '# a');
        fs.writeFileSync(fileB, '# b');
        await seedLegacyStorage(storageDir, [
            {
                item_id: fileA,
                item_type: 'file',
                filename: 'a.md',
                ext: '.md',
                size: 3,
                modified: 1,
                created: 1,
                accessed: 1,
                type: 'file',
                chunk_text: null,
                root_refs: JSON.stringify(['/rootA', '/rootB']),
                embedded: 1
            },
            {
                item_id: fileB,
                item_type: 'file',
                filename: 'b.md',
                ext: '.md',
                size: 3,
                modified: 1,
                created: 1,
                accessed: 1,
                type: 'file',
                chunk_text: null,
                root_refs: JSON.stringify(['/rootB']),
                embedded: 0
            }
        ]);

        Setting.updateInstanceData({
            ...originalSetting,
            default_embedding_model: '',
            models: []
        });

        const first = new FSStorage(dir);
        await first.initialize();
        let rowA = await getBaseRow(first, fileA);
        const rowB = await getBaseRow(first, fileB);
        assert.equal(rowA.ref_count, 2);
        assert.equal(rowB.ref_count, 1);
        assert.equal(first.scannerState._migratedRefCount, true);
        await first.close();

        const storage = new BaseStorage('filemgr', makeSchema(1, { mode: 'base-only' }), storageDir);
        await storage.initialize();
        await storage.update([{ item_id: fileA, item_type: 'file', ref_count: 99 }], { indexers: ['BaseIndexer'] });
        await storage.close();

        const second = new FSStorage(dir);
        await second.initialize();
        rowA = await getBaseRow(second, fileA);
        assert.equal(rowA.ref_count, 99, '_migratedRefCount should skip repeat migration on second startup');
        await second.close();
    } finally {
        Setting.updateInstanceData(originalSetting);
        cleanup(dir);
    }
    console.log('  ✅ testMigrateRefCountBackfillsLegacyRowsOnce');
}

// ── Test 12: scanner_state has embedding task timestamp field ───────

async function testScannerStateNewField() {
    console.log('  testScannerStateNewField...');
    const fss = new FSStorage(tmpDir('state'));
    assert.equal(fss.scannerState.last_embedding_task_at, null);
    assert.equal(fss.scannerState.embedding_request_dim, null);
    assert.equal(fss.scannerState._requestDimResolved, false);
    assert.equal(fss.scannerState.probe_error, null);
    assert.equal(fss.scannerState.last_rebuild_event, null);
    assert.deepEqual(fss.scannerState.unavailable_roots, {});
    assert.equal(fss.onStateChanged, null);
    assert.equal(fss.deferredReason, null);
    console.log('  ✅ testScannerStateNewField');
}

async function testScannerStateMigratesLastFileCount() {
    console.log('  testScannerStateMigratesLastFileCount...');
    const dir = tmpDir('state-migrate-last-file-count');
    try {
        fs.writeFileSync(
            path.join(dir, 'scanner_state.json'),
            JSON.stringify(
                {
                    version: 1,
                    vec_dim: null,
                    embedding_model: null,
                    last_embedding_task_at: null,
                    chunk_level: null,
                    embedded_migrated: false,
                    roots: {
                        '/legacy/root': {
                            last_full_scan: 123,
                            total_files: 45
                        }
                    }
                },
                null,
                2
            ),
            'utf-8'
        );

        const fss = new FSStorage(dir);
        fss._loadScannerState();

        assert.equal(fss.scannerState.roots['/legacy/root'].last_file_count, 45);
        assert.equal(fss.scannerState.embedding_request_dim, null);
        assert.equal(fss.scannerState._requestDimResolved, false);
        assert.equal(fss.scannerState.probe_error, null);
        assert.equal(fss.scannerState.last_rebuild_event, null);
        assert.deepEqual(fss.scannerState.unavailable_roots, {});
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testScannerStateMigratesLastFileCount');
}

async function testScannerStateMigratesLastScanAt() {
    console.log('  testScannerStateMigratesLastScanAt...');
    const dir = tmpDir('state-migrate-last-scan-at');
    try {
        fs.writeFileSync(
            path.join(dir, 'scanner_state.json'),
            JSON.stringify(
                {
                    version: 1,
                    vec_dim: null,
                    embedding_model: null,
                    last_embedding_task_at: null,
                    chunk_level: null,
                    embedded_migrated: false,
                    roots: {
                        '/legacy/scanned': {
                            last_full_scan: 123,
                            total_files: 45,
                            last_file_count: 45
                        },
                        '/legacy/pending': {
                            last_full_scan: 0,
                            total_files: 0,
                            last_file_count: 0
                        }
                    }
                },
                null,
                2
            ),
            'utf-8'
        );

        const fss = new FSStorage(dir);
        fss._loadScannerState();

        assert.equal(fss.scannerState.roots['/legacy/scanned'].last_scan_at, 123);
        assert.equal(fss.scannerState.roots['/legacy/pending'].last_scan_at, null);
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testScannerStateMigratesLastScanAt');
}

async function testScannerStateMigratesPausedWithoutResettingCheckpoint() {
    console.log('  testScannerStateMigratesPausedWithoutResettingCheckpoint...');
    const dir = tmpDir('scanner-paused-migration');
    const root = path.join(dir, 'source');
    try {
        fs.writeFileSync(
            path.join(dir, 'scanner_state.json'),
            JSON.stringify({
                version: 1,
                roots: {
                    [root]: {
                        last_full_scan: 111,
                        last_scan_at: 222,
                        total_files: 33,
                        last_file_count: 44
                    }
                }
            }),
            'utf-8'
        );
        const storage = new FSStorage(dir);
        await storage.initializeReadonly();
        assert.deepEqual(storage.getScannerState().roots[root], {
            last_full_scan: 111,
            last_scan_at: 222,
            total_files: 33,
            last_file_count: 44,
            paused: false
        });
    } finally {
        cleanup(dir);
    }
}

async function testSetRootPausedPersistsDiskBeforeMemoryCommit() {
    console.log('  testSetRootPausedPersistsDiskBeforeMemoryCommit...');
    const dir = tmpDir('scanner-paused-success');
    const root = path.join(dir, 'source');
    try {
        const storage = new FSStorage(dir);
        storage.scannerState.roots[root] = {
            last_full_scan: 10,
            last_scan_at: 20,
            total_files: 30,
            last_file_count: 30,
            paused: false
        };
        await storage.saveScannerState();

        await storage.setRootPaused(root, true);

        assert.equal(storage.scannerState.roots[root].paused, true);
        const saved = JSON.parse(fs.readFileSync(path.join(dir, 'scanner_state.json'), 'utf-8'));
        assert.equal(saved.roots[root].paused, true);
        assert.equal(saved.roots[root].last_full_scan, 10);
        assert.equal(saved.roots[root].last_scan_at, 20);
        assert.equal(saved.roots[root].total_files, 30);
        assert.equal(saved.roots[root].last_file_count, 30);
    } finally {
        cleanup(dir);
    }
}

async function testSetRootPausedUsesCallTimeSnapshot() {
    console.log('  testSetRootPausedUsesCallTimeSnapshot...');
    const dir = tmpDir('scanner-paused-call-time-snapshot');
    const root = path.join(dir, 'source');
    const storage = new FSStorage(dir);
    const originalWrite = fs.promises.writeFile;
    let releaseWrite;
    let writeStarted;
    let pausePromise;
    try {
        storage.scannerState.roots[root] = {
            last_full_scan: 10,
            last_scan_at: 20,
            total_files: 30,
            last_file_count: 30,
            paused: false
        };
        await storage.saveScannerState();
        writeStarted = new Promise((resolve) => {
            fs.promises.writeFile = async (...args) => {
                resolve();
                await new Promise((release) => {
                    releaseWrite = release;
                });
                return originalWrite(...args);
            };
        });

        pausePromise = storage.setRootPaused(root, true);
        await writeStarted;
        assert.equal(storage.scannerState.roots[root].paused, false);
        storage.scannerState.roots[root].total_files = 999;
        releaseWrite();
        await pausePromise;

        const saved = JSON.parse(fs.readFileSync(path.join(dir, 'scanner_state.json'), 'utf-8'));
        assert.equal(saved.roots[root].paused, true);
        assert.equal(saved.roots[root].total_files, 30);
        assert.equal(storage.scannerState.roots[root].total_files, 999);
    } finally {
        fs.promises.writeFile = originalWrite;
        releaseWrite?.();
        await Promise.allSettled([pausePromise].filter(Boolean));
        cleanup(dir);
    }
}

async function testQueuedCheckpointSaveKeepsCommittedPause() {
    console.log('  testQueuedCheckpointSaveKeepsCommittedPause...');
    const dir = tmpDir('scanner-paused-queued-checkpoint');
    const root = path.join(dir, 'source');
    const storage = new FSStorage(dir);
    const originalWrite = fs.promises.writeFile;
    let releasePauseWrite;
    let pauseWriteStarted;
    let pausePromise;
    let checkpointPromise;
    try {
        storage.scannerState.roots[root] = {
            last_full_scan: 10,
            last_scan_at: 20,
            total_files: 30,
            last_file_count: 30,
            paused: false
        };
        await storage.saveScannerState();
        pauseWriteStarted = new Promise((resolve) => {
            let blocked = false;
            fs.promises.writeFile = async (...args) => {
                if (!blocked) {
                    blocked = true;
                    resolve();
                    await new Promise((release) => {
                        releasePauseWrite = release;
                    });
                }
                return originalWrite(...args);
            };
        });

        pausePromise = storage.setRootPaused(root, true);
        await pauseWriteStarted;
        checkpointPromise = storage.saveScannerState();
        storage.scannerState.roots[root].last_full_scan = 77;
        releasePauseWrite();
        await Promise.all([pausePromise, checkpointPromise]);

        const saved = JSON.parse(fs.readFileSync(path.join(dir, 'scanner_state.json'), 'utf-8'));
        assert.equal(saved.roots[root].paused, true);
        assert.equal(saved.roots[root].last_full_scan, 77);
        assert.equal(storage.scannerState.roots[root].paused, true);
    } finally {
        fs.promises.writeFile = originalWrite;
        releasePauseWrite?.();
        await Promise.allSettled([pausePromise, checkpointPromise].filter(Boolean));
        cleanup(dir);
    }
}

async function testSetRootPausedFailureDoesNotLeakIntoLaterSave() {
    console.log('  testSetRootPausedFailureDoesNotLeakIntoLaterSave...');
    const dir = tmpDir('scanner-paused-failure');
    const root = path.join(dir, 'source');
    const storage = new FSStorage(dir);
    const originalWrite = fs.promises.writeFile;
    try {
        storage.scannerState.roots[root] = {
            last_full_scan: 1,
            last_scan_at: 2,
            total_files: 3,
            last_file_count: 3,
            paused: false
        };
        await storage.saveScannerState();
        fs.promises.writeFile = async () => {
            throw new Error('pause state write failed');
        };
        await assert.rejects(() => storage.setRootPaused(root, true), /pause state write failed/);
        assert.equal(storage.scannerState.roots[root].paused, false);

        fs.promises.writeFile = originalWrite;
        storage.scannerState.last_embedding_task_at = 123;
        await storage.saveScannerState();
        const saved = JSON.parse(fs.readFileSync(path.join(dir, 'scanner_state.json'), 'utf-8'));
        assert.equal(saved.roots[root].paused, false);
    } finally {
        fs.promises.writeFile = originalWrite;
        cleanup(dir);
    }
}

async function testScannerStateMigratesLegacyProbeError() {
    console.log('  testScannerStateMigratesLegacyProbeError...');
    const dir = tmpDir('state-migrate-probe-error');
    try {
        fs.writeFileSync(
            path.join(dir, 'scanner_state.json'),
            JSON.stringify(
                {
                    version: 1,
                    vec_dim: null,
                    embedding_model: null,
                    last_embedding_task_at: null,
                    chunk_level: null,
                    embedded_migrated: false,
                    roots: {},
                    probe_permanent_error: {
                        code: 'invalid_api_key',
                        message: 'old provider message',
                        ts: 123
                    }
                },
                null,
                2
            ),
            'utf-8'
        );

        const fss = new FSStorage(dir);
        fss._loadScannerState();

        assert.deepEqual(fss.scannerState.probe_error, { code: 'embedding_config_error', ts: 123 });
        assert.equal(fss.scannerState.probe_permanent_error, undefined);
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testScannerStateMigratesLegacyProbeError');
}

async function testProbeErrorPersistsAndNotifies() {
    console.log('  testProbeErrorPersistsAndNotifies...');
    const dir = tmpDir('probe-error');
    try {
        const fss = new FSStorage(dir);
        fs.mkdirSync(dir, { recursive: true });
        let notices = 0;
        fss.onStateChanged = () => {
            notices++;
        };

        await fss._setProbeError('embedding_config_error');
        assert.equal(fss.scannerState.probe_error.code, 'embedding_config_error');
        assert.equal(notices, 1);

        const saved = JSON.parse(fs.readFileSync(fss._scannerStatePath, 'utf-8'));
        assert.equal(saved.probe_error.code, 'embedding_config_error');

        await fss._setProbeError('embedding_config_error');
        assert.equal(notices, 1, 'same probe error should not notify repeatedly');

        await fss._clearProbeError();
        assert.equal(fss.scannerState.probe_error, null);
        assert.equal(notices, 2);

        const cleared = JSON.parse(fs.readFileSync(fss._scannerStatePath, 'utf-8'));
        assert.equal(cleared.probe_error, null);
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testProbeErrorPersistsAndNotifies');
}

async function testClassifyEmbeddingErrorTableRules() {
    console.log('  testClassifyEmbeddingErrorTableRules...');
    assert.deepEqual(classifyEmbeddingError(Object.assign(new Error('monthly limit exceeded'), { status: 403 })), {
        kind: 'quota',
        code: 'quota_exceeded',
        retryable: false,
        scope: 'global',
        status: 403,
        message: 'monthly limit exceeded'
    });
    assert.equal(classifyEmbeddingError(Object.assign(new Error('invalid api key'), { status: 401 })).kind, 'config');
    assert.equal(classifyEmbeddingError(Object.assign(new Error('input too long'), { status: 400 })).kind, 'file');
    assert.equal(
        classifyEmbeddingError(Object.assign(new Error('400 status code (no body)'), { status: 400 })).kind,
        'unknown'
    );
    assert.equal(
        classifyEmbeddingError(Object.assign(new Error('too many requests'), { status: 429 })).kind,
        'transient'
    );
    console.log('  ✅ testClassifyEmbeddingErrorTableRules');
}

async function testSyncEmbeddingModeClearsProbeErrorWhenModelMissing() {
    console.log('  testSyncEmbeddingModeClearsProbeErrorWhenModelMissing...');
    const noEmbeddingSetting = { ...settingData, default_embedding_model: '' };
    Setting.updateInstanceData(noEmbeddingSetting);
    fs.writeFileSync(path.join(globalAppDir, 'setting.json'), JSON.stringify(noEmbeddingSetting, null, 4));

    const dir = tmpDir('sync-no-model-clears-permanent-error');
    try {
        const fss = new FSStorage(dir);
        fs.mkdirSync(dir, { recursive: true });
        await fss._setProbeError('embedding_config_error');

        let notices = 0;
        let demoteReason = null;
        fss.onStateChanged = () => {
            notices++;
        };
        fss._demoteToBaseOnly = async (reason) => {
            demoteReason = reason;
        };

        await fss.syncEmbeddingMode('no-model-test');

        assert.equal(fss.scannerState.probe_error, null);
        assert.equal(notices, 1, 'clearing old probe error should notify once');
        assert.equal(demoteReason, 'no-model-test: no embedding model configured');

        const saved = JSON.parse(fs.readFileSync(fss._scannerStatePath, 'utf-8'));
        assert.equal(saved.probe_error, null);
    } finally {
        Setting.updateInstanceData(settingData);
        fs.writeFileSync(path.join(globalAppDir, 'setting.json'), JSON.stringify(settingData, null, 4));
        cleanup(dir);
    }
    console.log('  ✅ testSyncEmbeddingModeClearsProbeErrorWhenModelMissing');
}

async function testSyncEmbeddingModeClearsProbeErrorAfterSuccessfulProbe() {
    console.log('  testSyncEmbeddingModeClearsProbeErrorAfterSuccessfulProbe...');
    Setting.updateInstanceData(settingData);
    fs.writeFileSync(path.join(globalAppDir, 'setting.json'), JSON.stringify(settingData, null, 4));

    const dir = tmpDir('sync-probe-success-clears-permanent-error');
    try {
        const fss = new FSStorage(dir);
        fs.mkdirSync(dir, { recursive: true });
        fss.scannerState.embedded_migrated = true;
        await fss._setProbeError('embedding_config_error');

        let notices = 0;
        let openedDim = null;
        fss.onStateChanged = () => {
            notices++;
        };
        fss._probeEmbedding = async () => ({ ok: true, dim: 3, model_name: 'BAAI/bge-m3', requestDim: null });
        fss._openFull = async (dim) => {
            openedDim = dim;
            fss.mode = 'full';
        };

        await fss.syncEmbeddingMode('probe-success-test');

        assert.equal(fss.scannerState.probe_error, null);
        assert.equal(notices, 1, 'successful probe should clear old probe error once');
        assert.equal(openedDim, 3);

        const saved = JSON.parse(fs.readFileSync(fss._scannerStatePath, 'utf-8'));
        assert.equal(saved.probe_error, null);
        assert.equal(saved.embedding_request_dim, null);
        assert.equal(saved._requestDimResolved, true);
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testSyncEmbeddingModeClearsProbeErrorAfterSuccessfulProbe');
}

async function testSyncEmbeddingModePersistsProbeError() {
    console.log('  testSyncEmbeddingModePersistsProbeError...');
    Setting.updateInstanceData(settingData);
    fs.writeFileSync(path.join(globalAppDir, 'setting.json'), JSON.stringify(settingData, null, 4));

    const dir = tmpDir('sync-probe-permanent-error');
    try {
        const fss = new FSStorage(dir);
        fs.mkdirSync(dir, { recursive: true });

        let notices = 0;
        let demoteReason = null;
        fss.onStateChanged = () => {
            notices++;
        };
        fss._probeEmbedding = async () => ({ ok: false, code: 'embedding_config_error' });
        fss._demoteToBaseOnly = async (reason) => {
            demoteReason = reason;
        };

        await fss.syncEmbeddingMode('probe-fail-test');

        assert.equal(fss.scannerState.probe_error.code, 'embedding_config_error');
        assert.equal(notices, 1, 'new probe error should notify once');
        assert.equal(demoteReason, 'probe-fail-test: probe failed');

        const saved = JSON.parse(fs.readFileSync(fss._scannerStatePath, 'utf-8'));
        assert.equal(saved.probe_error.code, 'embedding_config_error');
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testSyncEmbeddingModePersistsProbeError');
}

async function testProbeEmbeddingOpenHarmonyReducesLargeDimensions() {
    console.log('  testProbeEmbeddingOpenHarmonyReducesLargeDimensions...');
    const dir = tmpDir('probe-ohos-reduce');
    const originalEmbed = LLM.embed;
    try {
        const fss = new FSStorage(dir);
        fss._isOpenHarmony = () => true;
        const dimensions = [];
        LLM.embed = async (_text, dim) => {
            dimensions.push(dim);
            return new Array(dim === 1024 ? 1024 : 1536).fill(0.1);
        };

        const probe = await fss._probeEmbedding({ probeRetries: 0, rateLimitMaxRetries: 0 });

        assert.deepEqual(dimensions, [undefined, 1024]);
        assert.deepEqual(probe, {
            ok: true,
            dim: 1024,
            model_name: 'BAAI/bge-m3',
            requestDim: 1024
        });
    } finally {
        LLM.embed = originalEmbed;
        cleanup(dir);
    }
    console.log('  ✅ testProbeEmbeddingOpenHarmonyReducesLargeDimensions');
}

async function testProbeEmbeddingOpenHarmonyOnlyReportsDimUnsupportedForWrongReducedDim() {
    console.log('  testProbeEmbeddingOpenHarmonyOnlyReportsDimUnsupportedForWrongReducedDim...');
    const dir = tmpDir('probe-ohos-dim-unsupported');
    const originalEmbed = LLM.embed;
    try {
        const fss = new FSStorage(dir);
        fss._isOpenHarmony = () => true;
        LLM.embed = async (_text, dim) => new Array(dim === 1024 ? 768 : 1536).fill(0.1);

        const probe = await fss._probeEmbedding({ probeRetries: 0, rateLimitMaxRetries: 0 });

        assert.deepEqual(probe, { ok: false, code: 'dim_unsupported' });
    } finally {
        LLM.embed = originalEmbed;
        cleanup(dir);
    }
    console.log('  ✅ testProbeEmbeddingOpenHarmonyOnlyReportsDimUnsupportedForWrongReducedDim');
}

async function testProbeEmbeddingOpenHarmonyMapsReducedFailuresToConfigError() {
    console.log('  testProbeEmbeddingOpenHarmonyMapsReducedFailuresToConfigError...');
    const dir = tmpDir('probe-ohos-reduced-error');
    const originalEmbed = LLM.embed;
    try {
        const fss = new FSStorage(dir);
        fss._isOpenHarmony = () => true;
        LLM.embed = async (_text, dim) => {
            if (dim === 1024) {
                const err = new Error('dimensions parameter rejected');
                err.status = 400;
                throw err;
            }
            return new Array(1536).fill(0.1);
        };

        const probe = await fss._probeEmbedding({ probeRetries: 0, rateLimitMaxRetries: 0 });

        assert.deepEqual(probe, { ok: false, code: 'embedding_config_error' });
    } finally {
        LLM.embed = originalEmbed;
        cleanup(dir);
    }
    console.log('  ✅ testProbeEmbeddingOpenHarmonyMapsReducedFailuresToConfigError');
}

async function testSyncEmbeddingModeRecordsRequestDimForConsistentState() {
    console.log('  testSyncEmbeddingModeRecordsRequestDimForConsistentState...');
    const dir = tmpDir('sync-record-request-dim-3b');
    try {
        const fss = new FSStorage(dir);
        fs.mkdirSync(dir, { recursive: true });
        fss.mode = 'full';
        fss.scannerState.vec_dim = 1024;
        fss.scannerState.embedding_model = 'BAAI/bge-m3';
        fss.scannerState.chunk_level = 'structured';
        fss.scannerState.vector_backend = 'native';
        fss.scannerState.embedding_request_dim = null;
        fss.scannerState._requestDimResolved = false;
        fss.scannerState.embedded_migrated = true;
        fss._isOpenHarmony = () => true;
        fss._probeEmbedding = async () => ({
            ok: true,
            dim: 1024,
            model_name: 'BAAI/bge-m3',
            requestDim: 1024
        });
        let openedDim = null;
        fss._openFull = async (dim) => {
            openedDim = dim;
            fss.mode = 'full';
        };

        await fss.syncEmbeddingMode('migration-request-dim');

        assert.equal(openedDim, 1024, 'old OHOS full state must not fast no-op before requestDim is resolved');
        assert.equal(fss.scannerState.embedding_request_dim, 1024);
        assert.equal(fss.scannerState._requestDimResolved, true);

        const saved = JSON.parse(fs.readFileSync(fss._scannerStatePath, 'utf-8'));
        assert.equal(saved.embedding_request_dim, 1024);
        assert.equal(saved._requestDimResolved, true);
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testSyncEmbeddingModeRecordsRequestDimForConsistentState');
}

// ── Test: syncEmbeddingMode uses canonical reset reasons ─────────────

async function testSyncEmbeddingModeUsesCanonicalResetReasons() {
    console.log('  testSyncEmbeddingModeUsesCanonicalResetReasons...');
    const dir = tmpDir('sync-reset-reasons');
    try {
        const fss = new FSStorage(dir);

        fss.mode = 'base-only';
        fss.scannerState.vec_dim = 1;
        fss.scannerState.embedding_model = 'old-model';
        fss.scannerState.chunk_level = 'old-level';
        fss.scannerState.embedded_migrated = true;
        fss._probeEmbedding = async () => ({ ok: true, dim: 2, model_name: 'BAAI/bge-m3', requestDim: null });
        const reasons = [];
        fss._resetVectorChunk = async (reason) => {
            reasons.push(reason);
            fss.mode = 'full';
        };

        await fss.syncEmbeddingMode('config-change');
        assert.equal(reasons.at(-1), 'embedding_config_changed');

        fss.mode = 'base-only';
        fss.scannerState.vec_dim = 2;
        fss.scannerState.embedding_model = 'BAAI/bge-m3';
        fss.scannerState.chunk_level = 'structured';
        fss._openFull = async () => {
            throw new Error('vector open failed');
        };

        await fss.syncEmbeddingMode('scan');
        assert.equal(reasons.at(-1), 'open_full_failed');
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testSyncEmbeddingModeUsesCanonicalResetReasons');
}

async function testInitializeSyncEmbeddingGate() {
    console.log('  testInitializeSyncEmbeddingGate...');
    const dir = tmpDir('initialize-sync-gate');
    try {
        const withoutSync = new FSStorage(path.join(dir, 'without'));
        let withoutSyncCalls = 0;
        withoutSync.syncEmbeddingMode = async () => {
            withoutSyncCalls++;
        };
        await withoutSync.initialize({ syncEmbedding: false });
        assert.equal(withoutSyncCalls, 0, 'syncEmbedding:false should skip initialize probe');
        withoutSync.storage?.close?.();

        const withSync = new FSStorage(path.join(dir, 'with'));
        const reasons = [];
        withSync.syncEmbeddingMode = async (reason) => {
            reasons.push(reason);
        };
        await withSync.initialize();
        assert.deepEqual(reasons, ['initialize'], 'default initialize should preserve sync behavior');
        withSync.storage?.close?.();
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testInitializeSyncEmbeddingGate');
}

async function testProbeEmbeddingBudgetOptions() {
    console.log('  testProbeEmbeddingBudgetOptions...');
    const dir = tmpDir('probe-budget');
    try {
        const timeoutStorage = new FSStorage(path.join(dir, 'timeout'));
        timeoutStorage._probeCallOnce = async () => new Promise(() => {});
        const started = Date.now();
        const timeoutProbe = await timeoutStorage._probeEmbedding({ probeTimeoutMs: 50, probeRetries: 0 });
        assert.deepEqual(timeoutProbe, { ok: false, code: 'embedding_config_error' });
        assert.ok(Date.now() - started < 500, 'probe timeout should use caller budget');

        const retryStorage = new FSStorage(path.join(dir, 'retry'));
        let attempts = 0;
        retryStorage._probeCallOnce = async () => {
            attempts++;
            throw new Error('fetch failed');
        };
        const retryProbe = await retryStorage._probeEmbedding({ probeRetries: 1 });
        assert.deepEqual(retryProbe, { ok: false, code: 'embedding_config_error' });
        assert.equal(attempts, 2, 'probeRetries:1 means one attempt plus one retry');
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testProbeEmbeddingBudgetOptions');
}

// ── Test 13: _resetVectorChunk preserves base and resets embedded ────

async function testResetVectorChunkPreservesBaseAndResetsEmbedded() {
    console.log('  testResetVectorChunkPreservesBaseAndResetsEmbedded...');
    const dir = tmpDir('reset-vec');
    try {
        // Bootstrap with dim=1 so this test runs without a real embedding API.
        const fss = new FSStorage(dir);
        fss.scannerState.vec_dim = 1;
        await fss._resetVectorChunk('test-bootstrap', { dim: 1, mode: 'full' });

        const file = path.join(dir, 'r.md');
        fs.writeFileSync(file, 'r body');
        await fss.saveFiles([makeFileEntry(file)], dir);

        // Seed a vector row + flip embedded=1 manually (bypasses embedSingleFile).
        const dim = fss.scannerState.vec_dim; // = 1
        await fss.storage.upsert(
            [
                {
                    item_id: file,
                    item_type: 'file',
                    filename: 'r.md',
                    indexer_columns: { VectorIndexer: [{ column: 'filename', content: new Array(dim).fill(0.1) }] }
                }
            ],
            { indexers: ['VectorIndexer'] }
        );
        await fss.storage.update(
            [
                {
                    item_id: file,
                    item_type: 'file',
                    embedded: 1,
                    embedding_generation: fss.scannerState.embedding_generation
                }
            ],
            { indexers: ['BaseIndexer'] }
        );

        await fss._resetVectorChunk('test', { dim: fss.scannerState.vec_dim, mode: fss.mode });

        const after = (
            await fss.storage.search([{ indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: file }])
        ).items[0].item;
        assert.equal(after.embedded, 0);
        const status = await fss.storage.getStatus();
        assert.equal(status.VectorIndexer?.size ?? 0, 0);
        assert.equal(status.ChunkIndexer?.size ?? 0, 0);
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testResetVectorChunkPreservesBaseAndResetsEmbedded');
}

// ── Test 14: _resetVectorChunk accepts explicit dim and mode ─────────

async function testResetVectorChunkAcceptsExplicitDimAndMode() {
    console.log('  testResetVectorChunkAcceptsExplicitDimAndMode...');
    const dir = tmpDir('reset-explicit');
    try {
        const fss = await createFSStorage(dir);
        // Caller is responsible for updating scannerState BEFORE calling reset.
        fss.scannerState.vec_dim = 768;
        await fss._resetVectorChunk('dim change', { dim: 768, mode: 'full' });
        assert.equal(fss.mode, 'full');
        // The reopened storage should accept 768-dim writes:
        await fss.storage.upsert(
            [
                {
                    item_id: 'q',
                    item_type: 'file',
                    filename: 'q.md',
                    root_refs: '[]',
                    indexer_columns: { VectorIndexer: [{ column: 'filename', content: new Array(768).fill(0.2) }] }
                }
            ],
            { indexers: ['VectorIndexer', 'BaseIndexer'] }
        );
        const status = await fss.storage.getStatus();
        assert.equal(status.VectorIndexer.size, 1);
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testResetVectorChunkAcceptsExplicitDimAndMode');
}

async function seedDimOneVectorAndChunkStorage(storageDir) {
    const oldStorage = new BaseStorage('filemgr', makeSchema(1, { mode: 'full' }), storageDir);
    await oldStorage.initialize();
    await oldStorage.upsert(
        [
            {
                item_id: 'old-file',
                item_type: 'file',
                filename: 'old.md',
                type: 'file',
                path: 'old.md',
                root_refs: '[]',
                embedded: 1,
                indexer_columns: {
                    VectorIndexer: [{ column: 'filename', content: [0.1] }],
                    ChunkIndexer: [{ column: 'chunk_text', id: 'old-1', text: 'old chunk', content: [0.1] }]
                }
            }
        ],
        { indexers: ['BaseIndexer', 'VectorIndexer', 'ChunkIndexer'] }
    );
    await oldStorage.close();
}

// ── Test: uninitialized semantic indexers can drop old-dim storage ───

async function testUninitializedVectorAndChunkIndexersDropOldDimStorage() {
    console.log('  testUninitializedVectorAndChunkIndexersDropOldDimStorage...');
    const dir = tmpDir('raw-drop-indexers');
    const storageDir = path.join(dir, 'storage');
    try {
        await seedDimOneVectorAndChunkStorage(storageDir);

        const schema = makeSchema(2, { mode: 'full' });
        const vectorIndexer = new VectorIndexer(schema, path.join(storageDir, 'vector-index.db'), { dim: 2 });
        const chunkIndexer = new ChunkIndexer(schema, path.join(storageDir, 'chunk-index.db'), { dim: 2 });

        await vectorIndexer.dropStorage();
        await chunkIndexer.dropStorage();

        const reopened = new BaseStorage('filemgr', makeSchema(2, { mode: 'full' }), storageDir);
        await reopened.initialize();
        const status = await reopened.getStatus();
        assert.equal(status.VectorIndexer.size, 0);
        assert.equal(status.ChunkIndexer.size, 0);
        reopened.close();
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testUninitializedVectorAndChunkIndexersDropOldDimStorage');
}

// ── Test: base-only old vector data resets when restored model has new dim ─

async function testResetVectorChunkRecoversFromBaseOnlyOldDimStorage() {
    console.log('  testResetVectorChunkRecoversFromBaseOnlyOldDimStorage...');
    const dir = tmpDir('baseonly-old-dim-reset');
    try {
        const fss = new FSStorage(dir);
        fss._probeEmbedding = async () => ({
            ok: true,
            dim: 1,
            model_name: 'old-embed',
            requestDim: null
        });
        await fss.initialize();
        assert.equal(fss.mode, 'full');

        const file = path.join(dir, 'old.md');
        fs.writeFileSync(file, 'old body');
        await fss.saveFiles([makeFileEntry(file)], dir);
        await fss.storage.upsert(
            [
                {
                    item_id: file,
                    item_type: 'file',
                    filename: 'old.md',
                    type: 'file',
                    path: file,
                    root_refs: JSON.stringify([dir]),
                    embedded: 1,
                    indexer_columns: {
                        VectorIndexer: [{ column: 'filename', content: [0.1] }],
                        ChunkIndexer: [{ column: 'chunk_text', id: 'old-1', text: 'old chunk', content: [0.1] }]
                    }
                }
            ],
            { indexers: ['VectorIndexer', 'ChunkIndexer'] }
        );

        await fss._demoteToBaseOnly('test no model');
        assert.equal(fss.mode, 'base-only');
        fss.scannerState.vec_dim = null;
        fss.scannerState.embedding_model = null;
        fss.scannerState.chunk_level = null;
        fss.scannerState.vector_backend = null;

        fss._probeEmbedding = async () => ({
            ok: true,
            dim: 2,
            model_name: 'new-embed',
            requestDim: null
        });
        await fss.syncEmbeddingMode('test restored model');

        assert.equal(fss.mode, 'full');
        assert.equal(fss.scannerState.vec_dim, 2);
        const status = await fss.storage.getStatus();
        assert.equal(status.VectorIndexer.size, 0);
        assert.equal(status.ChunkIndexer.size, 0);
        await fss.storage.upsert(
            [
                {
                    item_id: 'new-file',
                    item_type: 'file',
                    filename: 'new.md',
                    root_refs: '[]',
                    indexer_columns: { VectorIndexer: [{ column: 'filename', content: [0.2, 0.3] }] }
                }
            ],
            { indexers: ['VectorIndexer', 'BaseIndexer'] }
        );
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testResetVectorChunkRecoversFromBaseOnlyOldDimStorage');
}

// ── Test: reset failure does not publish half-initialized storage ─────

async function testResetVectorChunkDoesNotPublishHalfInitializedStorage() {
    console.log('  testResetVectorChunkDoesNotPublishHalfInitializedStorage...');
    const dir = tmpDir('reset-no-half-storage');
    const originalInitialize = BaseStorage.prototype.initialize;
    try {
        const fss = new FSStorage(dir);
        await fss._resetVectorChunk('bootstrap', { dim: 1, mode: 'base-only' });
        const oldStorage = fss.storage;

        BaseStorage.prototype.initialize = async function () {
            if (this !== oldStorage) {
                throw new Error('synthetic init failure');
            }
            return originalInitialize.call(this);
        };

        await assert.rejects(
            () => fss._resetVectorChunk('synthetic-failure', { dim: 1, mode: 'base-only' }),
            /synthetic init failure/
        );
        assert.equal(fss.storage, oldStorage, 'failed reset must leave the previous storage installed');
        await assert.doesNotReject(() => fss.storage.getStatus());
    } finally {
        BaseStorage.prototype.initialize = originalInitialize;
        cleanup(dir);
    }
    console.log('  ✅ testResetVectorChunkDoesNotPublishHalfInitializedStorage');
}

// ── Test: ArkData raw drop avoids schema creation and dim reads ───────

async function testArkDataRawDropOnlyDropsTables() {
    console.log('  testArkDataRawDropOnlyDropsTables...');
    const calls = [];
    const kit = {
        openStore: async (storeId, options) => {
            calls.push(['openStore', storeId, options]);
        },
        execSql: async (storeId, sql) => {
            calls.push(['execSql', storeId, sql]);
        },
        closeStore: async (storeId) => {
            calls.push(['closeStore', storeId]);
        },
        queryPrepared: async () => {
            throw new Error('raw drop must not query');
        },
        executePrepared: async () => {
            throw new Error('raw drop must not execute prepared statements');
        }
    };
    setArkdataDatabaseKit(kit);

    await dropVectorIndexStoreArkdata('/tmp/vector-index.db');
    await dropChunkIndexStoreArkdata('/tmp/chunk-index.db');

    const sqls = calls.filter((c) => c[0] === 'execSql').map((c) => c[2]);
    assert.deepEqual(sqls, [
        'DROP TABLE IF EXISTS vector_index',
        'DROP TABLE IF EXISTS __schema_meta_safe',
        'DROP TABLE IF EXISTS chunk_index',
        'DROP TABLE IF EXISTS __schema_meta_safe'
    ]);
    assert.equal(calls.filter((c) => c[0] === 'openStore').length, 2);
    assert.equal(calls.filter((c) => c[0] === 'closeStore').length, 2);
    assert.ok(!sqls.some((sql) => /CREATE TABLE|SELECT/i.test(sql)));
    console.log('  ✅ testArkDataRawDropOnlyDropsTables');
}

// ── Test: _resetVectorChunk records last_rebuild_event ────────────────

async function testResetVectorChunkRecordsRebuildEvent() {
    console.log('  testResetVectorChunkRecordsRebuildEvent...');
    const dir = tmpDir('reset-vector-event');
    try {
        const fss = new FSStorage(dir);
        let notices = 0;
        fss.onStateChanged = () => {
            notices++;
        };

        await fss._resetVectorChunk('vector-reset-test', { dim: 1, mode: 'base-only' });

        assert.deepEqual(
            {
                type: fss.scannerState.last_rebuild_event.type,
                reason: fss.scannerState.last_rebuild_event.reason,
                status: fss.scannerState.last_rebuild_event.status
            },
            { type: 'vector', reason: 'vector-reset-test', status: 'completed' }
        );
        assert.equal(typeof fss.scannerState.last_rebuild_event.ts, 'number');
        assert.ok(notices >= 1, 'vector reset event should notify status listeners');

        const saved = JSON.parse(fs.readFileSync(fss._scannerStatePath, 'utf-8'));
        assert.equal(saved.last_rebuild_event.type, 'vector');
        assert.equal(saved.last_rebuild_event.reason, 'vector-reset-test');
        assert.equal(saved.last_rebuild_event.status, 'completed');

        await assert.rejects(
            () => fss._resetVectorChunk('bad-vector-reset', { dim: null, mode: 'full' }),
            /dim and mode are required/
        );
        assert.equal(fss.scannerState.last_rebuild_event.type, 'vector');
        assert.equal(fss.scannerState.last_rebuild_event.reason, 'bad-vector-reset');
        assert.equal(fss.scannerState.last_rebuild_event.status, 'failed');
        assert.match(fss.scannerState.last_rebuild_event.message, /dim and mode are required/);
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testResetVectorChunkRecordsRebuildEvent');
}

// ── Test: rebuildAll records full event and resets vector state ───────

async function testRebuildAllRecordsFullEventAndResetsVectorState() {
    console.log('  testRebuildAllRecordsFullEventAndResetsVectorState...');
    const dir = tmpDir('rebuild-full-event');
    try {
        const fss = new FSStorage(dir);
        fss.scannerState.roots[dir] = {
            last_full_scan: 123,
            total_files: 7,
            last_file_count: 7
        };
        fss.scannerState.vec_dim = 768;
        fss.scannerState.embedding_model = 'old-model';
        fss.scannerState.chunk_level = 'old-level';
        fss.scannerState.embedded_migrated = true;
        await fss._resetVectorChunk('bootstrap', { dim: 1, mode: 'base-only' });

        let syncReason = null;
        let notices = 0;
        fss.syncEmbeddingMode = async (reason) => {
            syncReason = reason;
            fss.scannerState.last_rebuild_event = {
                type: 'vector',
                reason: 'internal-vector-reset',
                status: 'completed',
                ts: Date.now()
            };
            await fss.saveScannerState();
        };
        fss.onStateChanged = () => {
            notices++;
        };

        await fss.rebuildAll('manual_reset');

        assert.equal(syncReason, 'manual_reset');
        assert.equal(fss.mode, 'base-only');
        assert.equal(fss.scannerState.roots[dir].last_full_scan, 0);
        assert.equal(fss.scannerState.vec_dim, null);
        assert.equal(fss.scannerState.embedding_model, null);
        assert.equal(fss.scannerState.chunk_level, null);
        assert.equal(fss.scannerState.embedded_migrated, false);
        assert.equal(fss.scannerState.last_rebuild_event.type, 'full');
        assert.equal(fss.scannerState.last_rebuild_event.reason, 'manual_reset');
        assert.equal(fss.scannerState.last_rebuild_event.status, 'completed');
        assert.equal(typeof fss.scannerState.last_rebuild_event.ts, 'number');
        assert.ok(notices >= 1, 'full rebuild event should notify status listeners');

        const saved = JSON.parse(fs.readFileSync(fss._scannerStatePath, 'utf-8'));
        assert.equal(saved.last_rebuild_event.type, 'full');
        assert.equal(saved.last_rebuild_event.reason, 'manual_reset');
        assert.equal(saved.last_rebuild_event.status, 'completed');
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testRebuildAllRecordsFullEventAndResetsVectorState');
}

// ── Test: rebuildAll records failed full event ────────────────────────

async function testRebuildAllRecordsFailedFullEvent() {
    console.log('  testRebuildAllRecordsFailedFullEvent...');
    const dir = tmpDir('rebuild-full-failed-event');
    try {
        const fss = new FSStorage(dir);
        await fss._resetVectorChunk('bootstrap', { dim: 1, mode: 'base-only' });
        fss.syncEmbeddingMode = async () => {
            throw new Error('sync failed');
        };

        await assert.rejects(() => fss.rebuildAll('base_init_failed'), /sync failed/);

        assert.equal(fss.scannerState.last_rebuild_event.type, 'full');
        assert.equal(fss.scannerState.last_rebuild_event.reason, 'base_init_failed');
        assert.equal(fss.scannerState.last_rebuild_event.status, 'failed');
        assert.equal(fss.scannerState.last_rebuild_event.message, 'sync failed');

        const saved = JSON.parse(fs.readFileSync(fss._scannerStatePath, 'utf-8'));
        assert.equal(saved.last_rebuild_event.type, 'full');
        assert.equal(saved.last_rebuild_event.reason, 'base_init_failed');
        assert.equal(saved.last_rebuild_event.status, 'failed');
        assert.equal(saved.last_rebuild_event.message, 'sync failed');
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testRebuildAllRecordsFailedFullEvent');
}

// ── Test: rebuildAll preserves original failure if event save fails ──

async function testRebuildAllPreservesOriginalErrorWhenEventSaveFails() {
    console.log('  testRebuildAllPreservesOriginalErrorWhenEventSaveFails...');
    const dir = tmpDir('rebuild-event-save-fails');
    try {
        const fss = new FSStorage(dir);
        await fss._resetVectorChunk('bootstrap', { dim: 1, mode: 'base-only' });
        fss.syncEmbeddingMode = async () => {
            throw new Error('sync failed first');
        };
        const originalSaveScannerState = fss.saveScannerState.bind(fss);
        fss.saveScannerState = async () => {
            if (fss.scannerState.last_rebuild_event?.reason === 'save-mask-test') {
                throw new Error('event save failed second');
            }
            return originalSaveScannerState();
        };

        await assert.rejects(() => fss.rebuildAll('save-mask-test'), /sync failed first/);
        assert.equal(fss.scannerState.last_rebuild_event.type, 'full');
        assert.equal(fss.scannerState.last_rebuild_event.reason, 'save-mask-test');
        assert.equal(fss.scannerState.last_rebuild_event.status, 'failed');
        assert.equal(fss.scannerState.last_rebuild_event.message, 'sync failed first');
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testRebuildAllPreservesOriginalErrorWhenEventSaveFails');
}

// ── Test: _resetVectorChunk preserves original failure if event save fails

async function testResetVectorChunkPreservesOriginalErrorWhenEventSaveFails() {
    console.log('  testResetVectorChunkPreservesOriginalErrorWhenEventSaveFails...');
    const dir = tmpDir('vector-event-save-fails');
    try {
        const fss = new FSStorage(dir);
        fss.saveScannerState = async () => {
            if (fss.scannerState.last_rebuild_event?.reason === 'vector-save-mask-test') {
                throw new Error('event save failed second');
            }
        };

        await assert.rejects(
            () => fss._resetVectorChunk('vector-save-mask-test', { dim: null, mode: 'full' }),
            /dim and mode are required/
        );
        assert.equal(fss.scannerState.last_rebuild_event.type, 'vector');
        assert.equal(fss.scannerState.last_rebuild_event.reason, 'vector-save-mask-test');
        assert.equal(fss.scannerState.last_rebuild_event.status, 'failed');
        assert.match(fss.scannerState.last_rebuild_event.message, /dim and mode are required/);
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testResetVectorChunkPreservesOriginalErrorWhenEventSaveFails');
}

// ── Test: saveFiles base-only writes embedded=0 ─────────────────────

async function testSaveFilesBaseOnlyWritesEmbeddedZero() {
    console.log('  testSaveFilesBaseOnlyWritesEmbeddedZero...');
    const dir = tmpDir('savefiles-baseonly');
    try {
        // Bypass full initialize() — directly use _resetVectorChunk which bootstraps
        // storage in the requested mode. Task 9 will wire initialize() to handle
        // base-only automatically; for now we bootstrap manually.
        const fss = new FSStorage(dir);
        // _resetVectorChunk closes old storage and opens new one with given schema.
        // Use a placeholder dim=1 — base-only schema ignores dim in needIndexers.
        await fss._resetVectorChunk('test-bootstrap', { dim: 1, mode: 'base-only' });
        assert.equal(fss.mode, 'base-only');
        const file = path.join(dir, 'doc.md');
        fs.writeFileSync(file, '# hi');
        const result = await fss.saveFiles([makeFileEntry(file)], dir);
        assert.equal(result.saved, 1);
        const rows = await fss.storage.search([
            { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: file }
        ]);
        assert.equal(rows.items[0].item.embedded, 0);
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testSaveFilesBaseOnlyWritesEmbeddedZero');
}

// ── Test: saveFiles ref-only preserves embedded ──────────────────────

async function testSaveFilesRefOnlyPreservesEmbedded() {
    console.log('  testSaveFilesRefOnlyPreservesEmbedded...');
    const dir = tmpDir('savefiles-refonly');
    try {
        const fss = new FSStorage(dir);
        await fss._resetVectorChunk('test-bootstrap', { dim: 1, mode: 'base-only' });
        const file = path.join(dir, 'shared.md');
        fs.writeFileSync(file, '# shared');
        // First scan from rootA
        await fss.saveFiles([makeFileEntry(file)], '/rootA');
        // Manually mark embedded=1 (simulating embedding completion)
        await fss.storage.update(
            [
                {
                    item_id: file,
                    item_type: 'file',
                    embedded: 1
                }
            ],
            { indexers: ['BaseIndexer'] }
        );
        // Second scan from rootB — same file, no modification
        await fss.saveFiles([makeFileEntry(file)], '/rootB');
        const row = (
            await fss.storage.search([{ indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: file }])
        ).items[0].item;
        assert.equal(row.embedded, 1, 'ref-only update must not reset embedded');
        const refs = JSON.parse(row.root_refs);
        assert.deepEqual(refs.sort(), ['/rootA', '/rootB']);
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testSaveFilesRefOnlyPreservesEmbedded');
}

// ── Test: saveFiles modified changed resets embedded ─────────────────

async function testSaveFilesModifiedChangedResetsEmbedded() {
    console.log('  testSaveFilesModifiedChangedResetsEmbedded...');
    const dir = tmpDir('savefiles-modified');
    try {
        const fss = new FSStorage(dir);
        await fss._resetVectorChunk('test-bootstrap', { dim: 1, mode: 'base-only' });
        const file = path.join(dir, 'm.md');
        fs.writeFileSync(file, 'a');
        const e1 = makeFileEntry(file);
        await fss.saveFiles([e1], dir);
        await fss.storage.update(
            [
                {
                    item_id: file,
                    item_type: 'file',
                    embedded: 1,
                    embedding_generation: fss.scannerState.embedding_generation
                }
            ],
            { indexers: ['BaseIndexer'] }
        );
        // Touch mtime
        await new Promise((r) => setTimeout(r, 10));
        fs.writeFileSync(file, 'a longer content');
        const e2 = makeFileEntry(file);
        assert.notEqual(e1.modified, e2.modified);
        await fss.saveFiles([e2], dir);
        const row = (
            await fss.storage.search([{ indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: file }])
        ).items[0].item;
        assert.equal(row.embedded, 0, 'modifiedChanged must reset embedded=0');
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testSaveFilesModifiedChangedResetsEmbedded');
}

// ── Test: saveFiles keeps root_refs/ref_count consistent ────────────

async function testSaveFilesMaintainsRootRefsAndRefCountScenarios() {
    console.log('  testSaveFilesMaintainsRootRefsAndRefCountScenarios...');
    const dir = tmpDir('savefiles-ref-count-scenarios');
    try {
        const fss = new FSStorage(dir);
        await fss._resetVectorChunk('test-bootstrap', { dim: 1, mode: 'base-only' });

        const shared = path.join(dir, 'shared.md');
        fs.writeFileSync(shared, '# shared');
        const sharedEntry = makeFileEntry(shared);

        await fss.saveFiles([sharedEntry], '/rootA');
        let row = await getBaseRow(fss, shared);
        assertRefsAndCount(row, ['/rootA']);
        assert.equal(row.embedded, 0);

        await fss.saveFiles([sharedEntry], '/rootA');
        row = await getBaseRow(fss, shared);
        assertRefsAndCount(row, ['/rootA']);

        await fss.storage.update(
            [
                {
                    item_id: shared,
                    item_type: 'file',
                    embedded: 1,
                    embedding_generation: fss.scannerState.embedding_generation
                }
            ],
            { indexers: ['BaseIndexer'] }
        );
        await fss.saveFiles([sharedEntry], '/rootB');
        row = await getBaseRow(fss, shared);
        assertRefsAndCount(row, ['/rootA', '/rootB']);
        assert.equal(row.embedded, 1, 'ref-only root adoption must preserve embedded');

        await new Promise((r) => setTimeout(r, 10));
        fs.writeFileSync(shared, '# shared changed');
        await fss.saveFiles([makeFileEntry(shared)], '/rootB');
        row = await getBaseRow(fss, shared);
        assertRefsAndCount(row, ['/rootA', '/rootB']);
        assert.equal(row.embedded, 0, 'modified row must reset embedded');

        const pending = path.join(dir, 'pending.md');
        fs.writeFileSync(pending, '# pending');
        const pendingEntry = makeFileEntry(pending);
        await fss.storage.upsert(
            [
                {
                    item_id: pending,
                    item_type: 'file',
                    filename: 'pending.md',
                    ext: '.md',
                    size: pendingEntry.size,
                    modified: pendingEntry.modified,
                    created: pendingEntry.created,
                    accessed: pendingEntry.accessed,
                    type: 'file',
                    chunk_text: null,
                    root_refs: '[]',
                    ref_count: 0,
                    embedded: 1
                }
            ],
            { indexers: ['BaseIndexer'] }
        );
        await fss.saveFiles([pendingEntry], '/rootC');
        row = await getBaseRow(fss, pending);
        assertRefsAndCount(row, ['/rootC']);
        assert.equal(row.embedded, 1, 'ref-only takeover of intermediate row must preserve embedded');
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testSaveFilesMaintainsRootRefsAndRefCountScenarios');
}

// ── Test: embedSingleFile happy path ─────────────────────────────────

async function testEmbedSingleFileHappyPath() {
    console.log('  testEmbedSingleFileHappyPath...');
    const dir = tmpDir('embed-happy');
    try {
        const fss = await createFSStorage(dir);
        const file = path.join(dir, 'a.md');
        fs.writeFileSync(file, SAMPLE_MD_CONTENT);
        await fss.saveFiles([makeFileEntry(file)], dir);
        const row = (
            await fss.storage.search([{ indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: file }])
        ).items[0].item;
        assert.equal(row.embedded, 0);
        await fss.embedSingleFile(row);
        const after = (
            await fss.storage.search([{ indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: file }])
        ).items[0].item;
        assert.equal(after.embedded, 1);
        const status = await fss.storage.getStatus();
        assert.ok((status.VectorIndexer?.size ?? 0) >= 1);
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testEmbedSingleFileHappyPath');
}

// ── Test: embedSingleFile gone deletes ───────────────────────────────

async function testEmbedSingleFileGoneDeletes() {
    console.log('  testEmbedSingleFileGoneDeletes...');
    const dir = tmpDir('embed-gone');
    try {
        const fss = new FSStorage(dir);
        fss.scannerState.vec_dim = 1;
        await fss._resetVectorChunk('test-bootstrap', { dim: 1, mode: 'full' });
        const file = path.join(dir, 'gone.md');
        fs.writeFileSync(file, 'x');
        await fss.saveFiles([makeFileEntry(file)], dir);
        const row = (
            await fss.storage.search([{ indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: file }])
        ).items[0].item;
        fs.unlinkSync(file);
        await fss.embedSingleFile(row);
        const after = await fss.storage.search([
            { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: file }
        ]);
        assert.equal(after.items.length, 0);
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testEmbedSingleFileGoneDeletes');
}

// ── Test: embedSingleFile drift returns skipped ──────────────────────

async function testEmbedSingleFileDriftReturnsSkipped() {
    console.log('  testEmbedSingleFileDriftReturnsSkipped...');
    const dir = tmpDir('embed-drift');
    try {
        const fss = new FSStorage(dir);
        fss.scannerState.vec_dim = 1;
        await fss._resetVectorChunk('test-bootstrap', { dim: 1, mode: 'full' });
        const file = path.join(dir, 'drift.md');
        fs.writeFileSync(file, 'a');
        await fss.saveFiles([makeFileEntry(file)], dir);
        const row = (
            await fss.storage.search([{ indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: file }])
        ).items[0].item;

        // Force drift: monkey-patch _embedWithRetry to mutate file mid-flight
        const orig = fss._embedWithRetry.bind(fss);
        fss._embedWithRetry = async (texts) => {
            await new Promise((r) => setTimeout(r, 50));
            fs.writeFileSync(file, 'a much longer content now to change size+mtime');
            return orig(texts);
        };

        const r = await fss.embedSingleFile(row);
        assert.equal(r?.status, 'skipped_drift');
        const after = (
            await fss.storage.search([{ indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: file }])
        ).items[0].item;
        assert.equal(after.embedded, 0);
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testEmbedSingleFileDriftReturnsSkipped');
}

// ── Test: embedSingleFile caps per-file chunk inputs ────────────────

async function testPlanEmbeddingInputsSplitsOversizedChunksAndCapsBudget() {
    console.log('  testPlanEmbeddingInputsSplitsOversizedChunksAndCapsBudget...');
    const chunks = Array.from({ length: 250 }, (_, index) => ({
        id: `chunk-${index}`,
        text: `chunk text ${index}`
    }));

    const selected = limitChunksForEmbedding(chunks);

    assert.equal(selected.length, CONTENT_EMBED_MAX_CHUNKS_PER_FILE);
    assert.equal(selected[0].id, 'chunk-0');
    assert.equal(selected.at(-1).id, `chunk-${CONTENT_EMBED_MAX_CHUNKS_PER_FILE - 1}`);
    assert.equal(chunks.length, 250, 'helper must not mutate parser output');

    const oversized = 'a'.repeat(CONTENT_EMBED_MAX_CHARS_PER_CHUNK * 2 + 137);
    const oversizedChunks = [
        { id: 'oversized', text: oversized },
        ...Array.from({ length: 120 }, (_, index) => ({
            id: `chunk-${index}`,
            text: `chunk text ${index} ${'b'.repeat(1000)}`
        }))
    ];

    const plan = planEmbeddingInputs(oversizedChunks);
    const totalChars = plan.selectedChunks.reduce((sum, chunk) => sum + chunk.text.length, 0);

    assert.ok(plan.truncated, 'large inputs should report truncation metadata');
    assert.ok(plan.originalChunkCount > plan.selectedChunks.length);
    assert.ok(
        plan.selectedChunks.every((chunk) => chunk.text.length <= CONTENT_EMBED_MAX_CHARS_PER_CHUNK),
        'planner must never pass an oversized chunk to embedding'
    );
    assert.ok(plan.selectedChunks.length <= CONTENT_EMBED_MAX_CHUNKS_PER_FILE);
    assert.ok(totalChars <= CONTENT_EMBED_MAX_TOTAL_CHARS_PER_FILE);
    assert.equal(plan.selectedChunks[0].id, 'oversized.part0');
    assert.equal(oversizedChunks[0].text, oversized, 'planner must not mutate parser output');
    console.log('  ✅ testPlanEmbeddingInputsSplitsOversizedChunksAndCapsBudget');
}

async function testEmbedSingleFileOversizedContentFallsBackToFilenameOnly() {
    console.log('  testEmbedSingleFileOversizedContentFallsBackToFilenameOnly...');
    const dir = tmpDir('embed-oversized-filename-only');
    try {
        const fss = new FSStorage(dir);
        fss.scannerState.vec_dim = 1;
        await fss._resetVectorChunk('test-bootstrap', { dim: 1, mode: 'full' });
        const file = path.join(dir, 'huge.js');
        fs.closeSync(fs.openSync(file, 'w'));
        fs.truncateSync(file, RAW_TEXT_MAX_FILE_SIZE + 1);
        await fss.saveFiles([makeFileEntry(file)], dir);
        const row = (
            await fss.storage.search([{ indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: file }])
        ).items[0].item;

        let embeddedTexts = null;
        fss._embedWithRetry = async (texts) => {
            embeddedTexts = texts;
            return texts.map(() => [1]);
        };

        await fss.embedSingleFile(row);

        assert.deepEqual(embeddedTexts, ['huge.js']);
        const after = (
            await fss.storage.search([{ indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: file }])
        ).items[0].item;
        assert.equal(after.embedded, 1);
        const status = await fss.storage.getStatus();
        assert.equal(status.ChunkIndexer?.size ?? 0, 0);
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testEmbedSingleFileOversizedContentFallsBackToFilenameOnly');
}

async function testSemanticWriteStateDefaultsToAccepting() {
    console.log('  testSemanticWriteStateDefaultsToAccepting...');
    const dir = tmpDir('semantic-write-default');
    try {
        const fss = new FSStorage(dir);
        fss.scannerState.vec_dim = 1;
        await fss._resetVectorChunk('test-bootstrap', { dim: 1, mode: 'full' });

        const state = await fss.storage.getSemanticWriteState();

        assert.equal(state.vector.acceptingWrites, true);
        assert.equal(state.chunk.acceptingWrites, true);
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testSemanticWriteStateDefaultsToAccepting');
}

async function testEmbedSingleFileSkipsChunksWhenChunkWritesLimited() {
    console.log('  testEmbedSingleFileSkipsChunksWhenChunkWritesLimited...');
    const dir = tmpDir('semantic-chunk-limited');
    try {
        const fss = new FSStorage(dir);
        fss.scannerState.vec_dim = 1;
        await fss._resetVectorChunk('test-bootstrap', { dim: 1, mode: 'full' });
        const file = path.join(dir, 'chunked.md');
        fs.writeFileSync(file, SAMPLE_MD_CONTENT);
        await fss.saveFiles([makeFileEntry(file)], dir);
        const row = await getBaseRow(fss, file);

        fss.storage.getSemanticWriteState = async () => ({
            vector: { acceptingWrites: true },
            chunk: { acceptingWrites: false, reason: 'capacity_limit' }
        });
        let embeddedTexts = null;
        fss._embedWithRetry = async (texts) => {
            embeddedTexts = texts;
            return texts.map(() => [1]);
        };

        await fss.embedSingleFile(row);

        assert.deepEqual(embeddedTexts, ['chunked.md']);
        const after = await getBaseRow(fss, file);
        assert.equal(after.embedded, 1);
        const status = await fss.storage.getStatus();
        assert.equal(status.VectorIndexer?.size ?? 0, 1);
        assert.equal(status.ChunkIndexer?.size ?? 0, 0);
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testEmbedSingleFileSkipsChunksWhenChunkWritesLimited');
}

async function testEmbedSingleFileSkipsSemanticWorkWhenVectorWritesLimited() {
    console.log('  testEmbedSingleFileSkipsSemanticWorkWhenVectorWritesLimited...');
    const dir = tmpDir('semantic-vector-limited');
    try {
        const fss = new FSStorage(dir);
        fss.scannerState.vec_dim = 1;
        await fss._resetVectorChunk('test-bootstrap', { dim: 1, mode: 'full' });
        const file = path.join(dir, 'limited.md');
        fs.writeFileSync(file, SAMPLE_MD_CONTENT);
        await fss.saveFiles([makeFileEntry(file)], dir);
        const row = await getBaseRow(fss, file);

        fss.storage.getSemanticWriteState = async () => ({
            vector: { acceptingWrites: false, reason: 'capacity_limit' },
            chunk: { acceptingWrites: true }
        });
        fss._embedWithRetry = async () => {
            throw new Error('embedding should not be requested when vector writes are limited');
        };

        await fss.embedSingleFile(row);

        const after = await getBaseRow(fss, file);
        assert.equal(after.embedded, 1);
        const status = await fss.storage.getStatus();
        assert.equal(status.VectorIndexer?.size ?? 0, 0);
        assert.equal(status.ChunkIndexer?.size ?? 0, 0);
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testEmbedSingleFileSkipsSemanticWorkWhenVectorWritesLimited');
}

// ── Test: processEmbeddingQueue drains pending ───────────────────────

async function testProcessEmbeddingQueueDrainsPending() {
    console.log('  testProcessEmbeddingQueueDrainsPending...');
    const dir = tmpDir('embed-queue');
    try {
        const fss = await createFSStorage(dir);
        const f1 = path.join(dir, 'a.md');
        const f2 = path.join(dir, 'b.md');
        fs.writeFileSync(f1, '# a content');
        fs.writeFileSync(f2, '# b content');
        await fss.saveFiles([makeFileEntry(f1), makeFileEntry(f2)], dir);

        const processed = await fss.processEmbeddingQueue(() => false);
        assert.equal(processed, 2);

        const all = await fss.storage.search([
            { indexer: 'BaseIndexer', field: 'item_type', operator: '=', value: 'file' }
        ]);
        for (const it of all.items) assert.equal(it.item.embedded, 1);
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testProcessEmbeddingQueueDrainsPending');
}

// ── Test: processEmbeddingQueue drift skipped once ───────────────────

async function testProcessEmbeddingQueueDriftSkippedOnce() {
    console.log('  testProcessEmbeddingQueueDriftSkippedOnce...');
    const dir = tmpDir('embed-queue-drift');
    try {
        const fss = new FSStorage(dir);
        fss.scannerState.vec_dim = 1;
        await fss._resetVectorChunk('test-bootstrap', { dim: 1, mode: 'full' });
        const file = path.join(dir, 'drift.md');
        fs.writeFileSync(file, 'a');
        await fss.saveFiles([makeFileEntry(file)], dir);

        let calls = 0;
        fss.embedSingleFile = async (row) => {
            calls++;
            return { status: 'skipped_drift' };
        };

        const processed = await fss.processEmbeddingQueue(() => false);
        assert.equal(processed, 0);
        assert.equal(calls, 1, 'must NOT reselect the same drifting file within one task');
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testProcessEmbeddingQueueDriftSkippedOnce');
}

// ── Test: syncEmbeddingMode switches base-only → full when model becomes available ───────

async function testHotSwapBaseOnlyToFull() {
    console.log('  testHotSwapBaseOnlyToFull...');
    Setting.updateInstanceData({ ...settingData, default_embedding_model: '' });
    fs.writeFileSync(
        path.join(globalAppDir, 'setting.json'),
        JSON.stringify({ ...settingData, default_embedding_model: '' }, null, 4)
    );

    const dir = tmpDir('hotswap');
    try {
        // Bootstrap in base-only mode (no embedding configured)
        const fss = new FSStorage(dir);
        fss.scannerState.vec_dim = null;
        await fss._resetVectorChunk('test-bootstrap', { dim: 1, mode: 'base-only' });
        assert.equal(fss.mode, 'base-only');

        // Configure embedding now
        Setting.updateInstanceData(settingData);
        fs.writeFileSync(path.join(globalAppDir, 'setting.json'), JSON.stringify(settingData, null, 4));

        // syncEmbeddingMode detects model available and transitions to full
        await fss.syncEmbeddingMode('test');

        assert.equal(fss.mode, 'full');
        assert.ok(fss.scannerState.vec_dim !== null, 'vec_dim should be recorded after sync');
        assert.ok(fss.scannerState.embedding_model !== null, 'embedding_model should be recorded after sync');
    } finally {
        Setting.updateInstanceData(settingData);
        fs.writeFileSync(path.join(globalAppDir, 'setting.json'), JSON.stringify(settingData, null, 4));
        cleanup(dir);
    }
    console.log('  ✅ testHotSwapBaseOnlyToFull');
}

// ── Test A: base-only when no embedding configured ───────────────────

async function testInitializeBaseOnlyWhenNoEmbedding() {
    console.log('  testInitializeBaseOnlyWhenNoEmbedding...');
    Setting.updateInstanceData({ ...settingData, default_embedding_model: '' });
    fs.writeFileSync(
        path.join(globalAppDir, 'setting.json'),
        JSON.stringify({ ...settingData, default_embedding_model: '' }, null, 4)
    );
    const dir = tmpDir('baseonly-init');
    try {
        const fss = new FSStorage(dir);
        await fss.initialize();
        assert.equal(fss.mode, 'base-only');
        assert.ok(fss.storage !== null, 'storage must be initialized even in base-only');
        const status = await fss.storage.getStatus();
        assert.ok(!status.VectorIndexer, 'VectorIndexer must NOT be initialized in base-only');
    } finally {
        Setting.updateInstanceData(settingData);
        fs.writeFileSync(path.join(globalAppDir, 'setting.json'), JSON.stringify(settingData, null, 4));
        cleanup(dir);
    }
    console.log('  ✅ testInitializeBaseOnlyWhenNoEmbedding');
}

// ── Test: readonly init defers when no base index exists ─────────────

async function testInitializeReadonlyMissingBaseIndexDoesNotWriteState() {
    console.log('  testInitializeReadonlyMissingBaseIndexDoesNotWriteState...');
    const dir = tmpDir('readonly-missing-base');
    try {
        const fss = new FSStorage(dir);

        await fss.initializeReadonly();

        assert.equal(fss.storage, null);
        assert.equal(fss.deferredReason, 'missing_base_index');
        assert.equal(fs.existsSync(path.join(dir, 'scanner_state.json')), false);
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testInitializeReadonlyMissingBaseIndexDoesNotWriteState');
}

async function testInitializeReadonlyUsesStorageProbeInsteadOfHardcodedBasePath() {
    console.log('  testInitializeReadonlyUsesStorageProbeInsteadOfHardcodedBasePath...');
    const dir = tmpDir('readonly-probe-base');
    const originalProbeBase = BaseStorage.prototype.probeBaseIndexStore;
    const originalProbeIndexers = BaseStorage.prototype.probeIndexers;
    const originalInitialize = BaseStorage.prototype.initialize;
    try {
        BaseStorage.prototype.probeBaseIndexStore = async () => 'exists';
        BaseStorage.prototype.probeIndexers = async () => ({ VectorIndexer: 'missing', ChunkIndexer: 'missing' });
        BaseStorage.prototype.initialize = async function () {};

        const readonly = new FSStorage(dir);
        await readonly.initializeReadonly();

        assert.ok(readonly.storage, 'readonly storage should trust storage probe instead of hardcoded db filename');
        assert.equal(readonly.mode, 'base-only');
        assert.equal(readonly.deferredReason, null);
    } finally {
        BaseStorage.prototype.probeBaseIndexStore = originalProbeBase;
        BaseStorage.prototype.probeIndexers = originalProbeIndexers;
        BaseStorage.prototype.initialize = originalInitialize;
        cleanup(dir);
    }
    console.log('  ✅ testInitializeReadonlyUsesStorageProbeInsteadOfHardcodedBasePath');
}

// ── Test: readonly init opens existing base index without state writes ─

async function testInitializeReadonlyOpensExistingBaseIndex() {
    console.log('  testInitializeReadonlyOpensExistingBaseIndex...');
    Setting.updateInstanceData({ ...settingData, default_embedding_model: '' });
    fs.writeFileSync(
        path.join(globalAppDir, 'setting.json'),
        JSON.stringify({ ...settingData, default_embedding_model: '' }, null, 4)
    );
    const dir = tmpDir('readonly-existing-base');
    try {
        const writer = new FSStorage(dir);
        await writer.initialize();
        writer.storage?.close?.();

        const statePath = path.join(dir, 'scanner_state.json');
        assert.equal(fs.existsSync(statePath), false, 'setup should not write scanner state');

        const readonly = new FSStorage(dir);
        await readonly.initializeReadonly();

        assert.ok(readonly.storage, 'readonly storage should open existing base index');
        assert.equal(readonly.mode, 'base-only');
        assert.equal(readonly.deferredReason, null);
        assert.equal(fs.existsSync(statePath), false, 'readonly init should not write scanner state');
    } finally {
        Setting.updateInstanceData(settingData);
        fs.writeFileSync(path.join(globalAppDir, 'setting.json'), JSON.stringify(settingData, null, 4));
        cleanup(dir);
    }
    console.log('  ✅ testInitializeReadonlyOpensExistingBaseIndex');
}

// ── Test B: full mode when embedding configured ──────────────────────

async function testInitializeFullWhenEmbeddingConfigured() {
    console.log('  testInitializeFullWhenEmbeddingConfigured...');
    const dir = tmpDir('full-init');
    try {
        const fss = new FSStorage(dir);
        await fss.initialize();
        assert.equal(fss.mode, 'full');
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testInitializeFullWhenEmbeddingConfigured');
}

// ── Test C: dim change triggers soft reset ───────────────────────────

async function testInitializeDimChangeSoftResetsAndStaysFull() {
    console.log('  testInitializeDimChangeSoftResetsAndStaysFull...');
    const dir = tmpDir('dimchange-init');
    try {
        // First init
        const fss1 = new FSStorage(dir);
        await fss1.initialize();
        assert.equal(fss1.mode, 'full');
        const file = path.join(dir, 'd.md');
        fs.writeFileSync(file, 'd');
        await fss1.saveFiles([makeFileEntry(file)], dir);
        await fss1.storage.update(
            [
                {
                    item_id: file,
                    item_type: 'file',
                    embedded: 1,
                    embedding_generation: fss1.scannerState.embedding_generation
                }
            ],
            { indexers: ['BaseIndexer'] }
        );
        await fss1.storage.close?.();

        // Patch state file to look like old different dim/model
        const stateFile = path.join(dir, 'scanner_state.json');
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        state.vec_dim = 99999; // Force mismatch
        state.embedding_model = 'old-model';
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

        // Re-init — should detect dim mismatch and soft-reset
        const fss2 = new FSStorage(dir);
        await fss2.initialize();
        assert.equal(fss2.mode, 'full');
        // Base row preserved, embedded reset to 0
        const row = (
            await fss2.storage.search([{ indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: file }])
        ).items[0].item;
        assert.equal(row.embedded, 0, 'embedded must be reset to 0 after dim change');
        const status = await fss2.storage.getStatus();
        assert.equal(status.VectorIndexer.size, 0, 'VectorIndexer must be empty after reset');
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testInitializeDimChangeSoftResetsAndStaysFull');
}

// ── Test: searchFileByName returns EMBED_UNAVAILABLE in base-only mode ─

async function testSearchByNameBaseOnlyReturnsEmbedUnavailable() {
    console.log('  testSearchByNameBaseOnlyReturnsEmbedUnavailable...');
    Setting.updateInstanceData({ ...settingData, default_embedding_model: '' });
    fs.writeFileSync(
        path.join(globalAppDir, 'setting.json'),
        JSON.stringify({ ...settingData, default_embedding_model: '' }, null, 4)
    );
    const dir = tmpDir('semantic-baseonly');
    try {
        const fss = await createFSStorage(dir);
        const r = await fss.searchFileByName('foo');
        assert.equal(r.results.length, 0);
        assert.equal(r.totalHits, 0);
        assert.equal(r.code, 'EMBED_UNAVAILABLE');
        assert.ok(r.warning);

        const byContent = await fss.searchIndexedChunks('foo', { topK: 20 });
        assert.equal(byContent.results.length, 0);
        assert.equal(byContent.totalHits, 0);
        assert.equal(byContent.warning, WARNINGS.NO_EMBEDDING_MODEL);
        assert.equal(byContent.code, CODES.EMBED_UNAVAILABLE);
    } finally {
        Setting.updateInstanceData(settingData);
        fs.writeFileSync(path.join(globalAppDir, 'setting.json'), JSON.stringify(settingData, null, 4));
        cleanup(dir);
    }
    console.log('  ✅ testSearchByNameBaseOnlyReturnsEmbedUnavailable');
}

// ── Test: base-only without permanent probe error returns EMBED_UNAVAILABLE ─

async function testSearchBaseOnlyWithoutPermanentErrorReturnsEmbedUnavailable() {
    console.log('  testSearchBaseOnlyWithoutPermanentErrorReturnsEmbedUnavailable...');
    const dir = tmpDir('semantic-baseonly-configured');
    try {
        const fss = new FSStorage(dir);
        fss.storage = {};
        fss.mode = 'base-only';
        fss.scannerState.probe_error = null;

        const byName = await fss.searchFileByName('alpha');
        assert.equal(byName.warning, WARNINGS.NO_EMBEDDING_MODEL);
        assert.equal(byName.code, CODES.EMBED_UNAVAILABLE);

        const byContent = await fss.searchIndexedChunks('alpha', { topK: 20 });
        assert.equal(byContent.warning, WARNINGS.NO_EMBEDDING_MODEL);
        assert.equal(byContent.code, CODES.EMBED_UNAVAILABLE);
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testSearchBaseOnlyWithoutPermanentErrorReturnsEmbedUnavailable');
}

// ── Test: semantic search blank query returns empty result ───────────

async function testSearchBlankQueryReturnsEmptyResult() {
    console.log('  testSearchBlankQueryReturnsEmptyResult...');
    const dir = tmpDir('semantic-blank');
    try {
        const fss = new FSStorage(dir);
        const byName = await fss.searchFileByName('   ');
        assert.equal(byName.query, '   ');
        assert.deepEqual(byName.results, []);
        assert.equal(byName.totalHits, 0);
        assert.equal(byName.code, undefined);

        const byContent = await fss.searchIndexedChunks('', { topK: 20 });
        assert.equal(byContent.query, '');
        assert.deepEqual(byContent.results, []);
        assert.equal(byContent.totalHits, 0);
        assert.equal(byContent.code, undefined);
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testSearchBlankQueryReturnsEmptyResult');
}

// ── Test: semantic search deferred state returns INDEX_NOT_READY ─────

async function testSearchDeferredReturnsIndexNotReady() {
    console.log('  testSearchDeferredReturnsIndexNotReady...');
    const dir = tmpDir('semantic-deferred');
    try {
        const fss = new FSStorage(dir);

        const byName = await fss.searchFileByName('alpha');
        assert.equal(byName.warning, WARNINGS.DEFERRED);
        assert.equal(byName.code, CODES.INDEX_NOT_READY);

        const byContent = await fss.searchIndexedChunks('alpha', { topK: 20 });
        assert.equal(byContent.warning, WARNINGS.DEFERRED);
        assert.equal(byContent.code, CODES.INDEX_NOT_READY);
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testSearchDeferredReturnsIndexNotReady');
}

// ── Test: base-only permanent probe error returns EMBED_API_DOWN ─────

async function testSearchBaseOnlyPermanentErrorReturnsEmbedApiDown() {
    console.log('  testSearchBaseOnlyPermanentErrorReturnsEmbedApiDown...');
    const dir = tmpDir('semantic-permanent-error');
    try {
        const fss = new FSStorage(dir);
        fss.storage = {};
        fss.mode = 'base-only';
        fss.scannerState.probe_error = { code: 'embedding_config_error', ts: Date.now() };

        const byName = await fss.searchFileByName('alpha');
        assert.equal(byName.warning, WARNINGS.EMBED_API_DOWN);
        assert.equal(byName.code, CODES.EMBED_API_DOWN);

        const byContent = await fss.searchIndexedChunks('alpha', { topK: 20 });
        assert.equal(byContent.warning, WARNINGS.EMBED_API_DOWN);
        assert.equal(byContent.code, CODES.EMBED_API_DOWN);
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testSearchBaseOnlyPermanentErrorReturnsEmbedApiDown');
}

// ── Test: full-mode query embedding failure returns EMBED_API_DOWN ───

async function testSearchEmbedFailureReturnsEmbedApiDown() {
    console.log('  testSearchEmbedFailureReturnsEmbedApiDown...');
    const dir = tmpDir('semantic-embed-fail');
    const originalEmbed = LLM.embed;
    try {
        const fss = new FSStorage(dir);
        fss.storage = {
            search() {
                throw new Error('search should not run when query embedding fails');
            }
        };
        fss.mode = 'full';
        // This fixture represents an index ready for the configured query model.
        fss.scannerState.embedding_model = Setting.getInstance().getDefaultEmbeddingModelInstance().model_name;
        LLM.embed = async () => {
            const err = new Error('terminated');
            err.status = 500;
            throw err;
        };

        const byName = await fss.searchFileByName('alpha');
        assert.equal(byName.warning, WARNINGS.EMBED_API_DOWN);
        assert.equal(byName.code, CODES.EMBED_API_DOWN);

        const byContent = await fss.searchIndexedChunks('alpha', { topK: 20 });
        assert.equal(byContent.warning, WARNINGS.EMBED_API_DOWN);
        assert.equal(byContent.code, CODES.EMBED_API_DOWN);
    } finally {
        LLM.embed = originalEmbed;
        cleanup(dir);
    }
    console.log('  ✅ testSearchEmbedFailureReturnsEmbedApiDown');
}

async function testSearchSemanticRoutesExposeScores() {
    console.log('  testSearchSemanticRoutesExposeScores...');
    const dir = tmpDir('semantic-score');
    const originalEmbed = LLM.embed;
    const originalRerank = LLM.rerank;
    try {
        const fss = new FSStorage(dir);
        fss.mode = 'full';
        // This fixture represents an index ready for the configured query model.
        fss.scannerState.embedding_model = Setting.getInstance().getDefaultEmbeddingModelInstance().model_name;
        fss.storage = {
            async search(filters) {
                const first = filters[0];
                if (first.indexer === 'VectorIndexer') {
                    return {
                        totalCount: 1,
                        items: [
                            {
                                item: { item_id: '/docs/name.md', filename: 'name.md', modified: 1, size: 2 },
                                VecScore: 0.91
                            }
                        ]
                    };
                }
                return {
                    totalCount: 1,
                    items: [
                        {
                            item: { item_id: '/docs/content.md', filename: 'content.md', modified: 1, size: 2 },
                            chunk_text: 'matched chunk',
                            ChunkScore: 0.77
                        }
                    ]
                };
            }
        };
        fss.scannerState.embedding_request_dim = 1024;
        LLM.embed = async (_text, dimensions) => {
            assert.equal(dimensions, 1024);
            return [0.1, 0.2];
        };
        LLM.rerank = async (_query, items) => items;

        const byName = await fss.searchFileByName('alpha');
        assert.equal(byName.results[0].semanticScore, 0.91);

        const byContent = await fss.searchIndexedChunks('alpha', { topK: 20 });
        assert.equal(byContent.results[0].score, 0.77);
    } finally {
        LLM.embed = originalEmbed;
        LLM.rerank = originalRerank;
        cleanup(dir);
    }
    console.log('  ✅ testSearchSemanticRoutesExposeScores');
}

async function testSearchFilesByKeywordSupportsLimit() {
    console.log('  testSearchFilesByKeywordSupportsLimit...');
    const dir = tmpDir('keyword-limit');
    let fss;
    try {
        fss = new FSStorage(dir);
        await fss._resetVectorChunk('test-bootstrap', { dim: 1, mode: 'base-only' });

        await fss.storage.upsert(
            [
                makeStoredFileItem('/workspace/report-1.md', ['/workspace'], { modified: 1 }),
                makeStoredFileItem('/workspace/report-2.md', ['/workspace'], { modified: 2 }),
                makeStoredFileItem('/workspace/report-3.md', ['/workspace'], { modified: 3 }),
                makeStoredFileItem('/workspace/report-hidden.md', [], { modified: 4, ref_count: 0 })
            ],
            { indexers: ['BaseIndexer'] }
        );

        const rows = await fss.searchFilesByKeyword('report', { limit: 2 });

        assert.equal(rows.length, 2);
        assert.ok(rows.every((row) => !('ref_count' in row)));
        assert.ok(rows.every((row) => !('root_refs' in row)));

        const indexedRows = await fss.searchIndexedFilesByKeyword('report', { limit: 2 });
        assert.equal(indexedRows.length, 2);
        assert.ok(indexedRows.every((row) => row.ref_count > 0));
    } finally {
        await fss?.close();
        cleanup(dir);
    }
    console.log('  ✅ testSearchFilesByKeywordSupportsLimit');
}

async function testScopedSearchDiagnosticsIncludeFilemgrRouteAndScope() {
    console.log('  testScopedSearchDiagnosticsIncludeFilemgrRouteAndScope...');
    const dir = tmpDir('scoped-diagnostics');
    const originalEmbed = LLM.embed;
    const originalRerank = LLM.rerank;
    const originalInfo = logger.info;
    const previousFlag = process.env.FILEMGR_SCOPED_SEARCH_DIAGNOSTICS;
    try {
        const calls = [];
        const logs = [];
        const fss = new FSStorage(dir);
        fss.mode = 'full';
        // This fixture represents an index ready for the configured query model.
        fss.scannerState.embedding_model = Setting.getInstance().getDefaultEmbeddingModelInstance().model_name;
        fss.storage = {
            async searchScope(request, options) {
                calls.push({ request, options });
                return { items: [], totalCount: 0, diagnostics: { backend: 'native' } };
            }
        };
        LLM.embed = async () => [0.1];
        LLM.rerank = async (_query, items) => items;
        logger.info = (...args) => logs.push(args.join(' '));

        delete process.env.FILEMGR_SCOPED_SEARCH_DIAGNOSTICS;
        await fss.searchFileByName('plan', { topK: 2, scope: { type: 'path', path: '/Docs' } });
        assert.equal(calls[0].options.collectDiagnostics, false);
        assert.deepEqual(logs, []);

        process.env.FILEMGR_SCOPED_SEARCH_DIAGNOSTICS = '1';
        await fss.searchFileByName('plan', { topK: 2, scope: { type: 'path', path: '/Docs' } });
        assert.equal(calls[1].options.collectDiagnostics, true);
        assert.equal(logs.length, 1);
        assert.match(logs[0], /name_semantic/);
        assert.match(logs[0], /\/Docs/);

        await fss.searchIndexedChunks('plan', { topK: 2, scope: { type: 'path', path: '/Docs' } });
        assert.equal(logs.length, 2);
        assert.match(logs[1], /content_semantic/);
        assert.match(logs[1], /\/Docs/);
    } finally {
        LLM.embed = originalEmbed;
        LLM.rerank = originalRerank;
        logger.info = originalInfo;
        if (previousFlag === undefined) delete process.env.FILEMGR_SCOPED_SEARCH_DIAGNOSTICS;
        else process.env.FILEMGR_SCOPED_SEARCH_DIAGNOSTICS = previousFlag;
        cleanup(dir);
    }
    console.log('  ✅ testScopedSearchDiagnosticsIncludeFilemgrRouteAndScope');
}

async function testSearchIndexedChunksContractAndRerankFallback() {
    console.log('  testSearchIndexedChunksContractAndRerankFallback...');
    const dir = tmpDir('chunk-contract');
    const originalEmbed = LLM.embed;
    const originalRerank = LLM.rerank;
    try {
        const calls = [];
        const hits = [
            {
                item: {
                    item_id: '/Docs/a.md',
                    filename: 'a.md',
                    modified: 1,
                    size: 2,
                    ref_count: 1,
                    root_refs: '["/Docs"]'
                },
                chunk_id: 'a',
                chunk_text: 'complete A',
                ChunkScore: 0.7
            },
            {
                item: {
                    item_id: '/Docs/b.md',
                    filename: 'b.md',
                    modified: 3,
                    size: 4,
                    ref_count: 1,
                    root_refs: '["/Docs"]'
                },
                chunk_id: 'b',
                chunk_text: 'complete B',
                ChunkScore: 0.9
            }
        ];
        const fss = new FSStorage(dir);
        fss.mode = 'full';
        // This fixture represents an index ready for the configured query model.
        fss.scannerState.embedding_model = Setting.getInstance().getDefaultEmbeddingModelInstance().model_name;
        fss.storage = {
            async search(conditions) {
                calls.push(['global', conditions]);
                return { items: hits, totalCount: 2 };
            },
            async searchScope(request) {
                calls.push(['scope', request]);
                return { items: hits, totalCount: 2 };
            }
        };
        LLM.embed = async () => [0.1];
        let rerankCalls = 0;
        LLM.rerank = async (_query, items, text) => {
            rerankCalls++;
            assert.deepEqual(items.map(text), ['complete A', 'complete B']);
            return [items[1]];
        };

        const global = await fss.searchIndexedChunks('plan', { topK: 7 });
        assert.equal(calls[0][1][0].vectorQuery.topK, 7);
        assert.equal(global.results[0].chunk.text, 'complete B');
        assert.equal(global.results[0].score, 0.9);
        assert.equal(global.results[0].source.path, '/Docs/b.md');
        assert.equal(global.totalHits, 1);

        const scoped = await fss.searchIndexedChunks('plan', { topK: 9, scope: { type: 'path', path: '/Docs' } });
        assert.equal(calls[1][1].targetCondition.vectorQuery.topK, 9);
        assert.deepEqual(
            calls[1][1].preconditions.map((condition) => [condition.field, condition.operator, condition.value]),
            [
                ['type', '=', 'file'],
                ['embedded', '=', 1],
                ['embedding_generation', '=', fss.scannerState.embedding_generation],
                ['ref_count', '>', 0],
                ['item_id', 'path_descendant_or_self', '/Docs']
            ]
        );
        assert.equal(rerankCalls, 2);

        LLM.rerank = async () => {
            throw new Error('rerank down');
        };
        const fallback = await fss.searchIndexedChunks('plan', { topK: 2 });
        assert.deepEqual(
            fallback.results.map((hit) => hit.chunk.id),
            ['a', 'b']
        );
        assert.deepEqual(
            fallback.results.map((hit) => hit.score),
            [0.7, 0.9]
        );
        await assert.rejects(() => fss.searchIndexedChunks('plan', { topK: 1.5 }), /integer/);
        await assert.rejects(() => fss.searchIndexedChunks('plan', { topK: 5001 }), /1\.\.5000/);
    } finally {
        LLM.embed = originalEmbed;
        LLM.rerank = originalRerank;
        cleanup(dir);
    }
    console.log('  ✅ testSearchIndexedChunksContractAndRerankFallback');
}

// ── Test: processEmbeddingQueue skips non-API file errors once ───────

async function testProcessEmbeddingQueueSkipsFileErrorsOnce() {
    console.log('  testProcessEmbeddingQueueSkipsFileErrorsOnce...');
    const dir = tmpDir('embed-file-error');
    try {
        const fss = new FSStorage(dir);
        fss.mode = 'full';
        const file = { item_id: path.join(dir, 'bad.md'), type: 'file', embedded: 0 };
        fss.storage = {
            search: async () => ({ items: file.embedded === 0 ? [{ item: file }] : [] }),
            update: async (items) => {
                for (const item of items) {
                    if (item.item_id === file.item_id && typeof item.embedded === 'number') {
                        file.embedded = item.embedded;
                    }
                }
            }
        };
        let calls = 0;
        fss.embedSingleFile = async () => {
            calls++;
            const err = new Error('malformed content');
            err.status = 400;
            throw err;
        };

        const processed = await fss.processEmbeddingQueue(() => false);
        assert.equal(processed, 0);
        assert.equal(calls, 1, 'file-level errors should be skipped for the current task');
        assert.ok(fss.scannerState.last_embedding_task_at, 'embedding task timestamp should be updated');
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testProcessEmbeddingQueueSkipsFileErrorsOnce');
}

async function testProcessEmbeddingQueueMarksPermanentFileErrorsAsDisabled() {
    console.log('  testProcessEmbeddingQueueMarksPermanentFileErrorsAsDisabled...');
    const dir = tmpDir('embed-file-error-state');
    try {
        const fss = new FSStorage(dir);
        fss.mode = 'full';
        const file = { item_id: path.join(dir, 'bad.md'), type: 'file', embedded: 0, ref_count: 1 };
        fss.storage = {
            search: async (conditions) => {
                const embeddedFilter = conditions.find((condition) => condition.field === 'embedded');
                return file.embedded === embeddedFilter.value ? { items: [{ item: file }] } : { items: [] };
            },
            update: async (items) => {
                for (const item of items) {
                    if (item.item_id === file.item_id && typeof item.embedded === 'number') {
                        file.embedded = item.embedded;
                    }
                }
            }
        };
        let calls = 0;
        fss.embedSingleFile = async () => {
            calls++;
            const err = new Error('input too long');
            err.status = 400;
            throw err;
        };

        const processed = await fss.processEmbeddingQueue(() => false);
        assert.equal(processed, 0);
        assert.equal(calls, 1, 'file-level errors should not be retried in the same task');
        assert.equal(file.embedded, -2, 'permanent file-level errors should be persisted as embedded=-2');
        assert.ok(fss.scannerState.last_embedding_task_at, 'embedding task timestamp should be updated');
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testProcessEmbeddingQueueMarksPermanentFileErrorsAsDisabled');
}

async function testProcessEmbeddingQueueKeepsAmbiguousBadRequestRetryable() {
    console.log('  testProcessEmbeddingQueueKeepsAmbiguousBadRequestRetryable...');
    const dir = tmpDir('embed-ambiguous-bad-request');
    try {
        const fss = new FSStorage(dir);
        fss.mode = 'full';
        const file = { item_id: path.join(dir, 'ambiguous.md'), type: 'file', embedded: 0, ref_count: 1 };
        fss.storage = {
            search: async (conditions) => {
                const embeddedFilter = conditions.find((condition) => condition.field === 'embedded');
                return file.embedded === embeddedFilter.value ? { items: [{ item: file }] } : { items: [] };
            },
            update: async (items) => {
                for (const item of items) {
                    if (item.item_id === file.item_id && typeof item.embedded === 'number') {
                        file.embedded = item.embedded;
                    }
                }
            }
        };
        fss.embedSingleFile = async () => {
            const err = new Error('400 status code (no body)');
            err.status = 400;
            throw err;
        };

        const processed = await fss.processEmbeddingQueue(() => false);
        assert.equal(processed, 0);
        assert.equal(file.embedded, -1, 'ambiguous 400 errors should remain retryable');
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testProcessEmbeddingQueueKeepsAmbiguousBadRequestRetryable');
}

async function testProcessEmbeddingQueuePrioritizesFreshBeforeFailed() {
    console.log('  testProcessEmbeddingQueuePrioritizesFreshBeforeFailed...');
    const dir = tmpDir('embed-fresh-before-failed');
    try {
        const fss = new FSStorage(dir);
        fss.mode = 'full';
        const files = [
            { item_id: path.join(dir, 'failed.md'), type: 'file', embedded: -1, ref_count: 1 },
            { item_id: path.join(dir, 'fresh.md'), type: 'file', embedded: 0, ref_count: 1 }
        ];
        fss.storage = {
            search: async (conditions) => {
                const embeddedFilter = conditions.find((condition) => condition.field === 'embedded');
                return {
                    items: files.filter((item) => item.embedded === embeddedFilter.value).map((item) => ({ item }))
                };
            },
            update: async () => {}
        };
        const calls = [];
        fss.embedSingleFile = async (file) => {
            calls.push(path.basename(file.item_id));
            file.embedded = 1;
        };

        const processed = await fss.processEmbeddingQueue(() => false);
        assert.equal(processed, 2);
        assert.deepEqual(calls, ['fresh.md', 'failed.md'], 'embedded=0 files should run before embedded=-1 files');
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testProcessEmbeddingQueuePrioritizesFreshBeforeFailed');
}

// ── Test: processEmbeddingQueue retries API-level errors up to 3 times ─

async function testProcessEmbeddingQueueRetriesApiLevelErrorsThreeTimes() {
    console.log('  testProcessEmbeddingQueueRetriesApiLevelErrorsThreeTimes...');
    const dir = tmpDir('embed-retry-3');
    try {
        const fss = new FSStorage(dir);
        fss.mode = 'full';
        const files = [
            { item_id: path.join(dir, 'api-1.md'), type: 'file', embedded: 0 },
            { item_id: path.join(dir, 'api-2.md'), type: 'file', embedded: 0 },
            { item_id: path.join(dir, 'api-3.md'), type: 'file', embedded: 0 },
            { item_id: path.join(dir, 'api-4.md'), type: 'file', embedded: 0 },
            { item_id: path.join(dir, 'api-5.md'), type: 'file', embedded: 0 }
        ];
        fss.storage = {
            search: async (conditions) => {
                const embeddedFilter = conditions.find((c) => c.field === 'embedded');
                return {
                    items: files.filter((f) => f.embedded === embeddedFilter.value).map((f) => ({ item: f }))
                };
            },
            update: async (items) => {
                for (const item of items) {
                    const target = files.find((f) => f.item_id === item.item_id);
                    if (target && typeof item.embedded === 'number') {
                        target.embedded = item.embedded;
                    }
                }
            }
        };
        let calls = 0;
        fss.embedSingleFile = async () => {
            calls++;
            const err = new Error('server unavailable');
            err.status = 503;
            throw err;
        };

        const processed = await fss.processEmbeddingQueue(() => false);
        assert.equal(processed, 0, 'no files should be successfully processed');
        assert.equal(calls, 3, 'should retry exactly 3 times before stopping');
        assert.equal(files[0].embedded, -1, 'first file should be marked as failed (retriable)');
        assert.equal(files[1].embedded, -1, 'second file should be marked as failed (retriable)');
        assert.equal(files[2].embedded, -1, 'third file should be marked as failed (retriable)');
        assert.equal(files[3].embedded, 0, 'fourth file should not be attempted');
        assert.equal(files[4].embedded, 0, 'fifth file should not be attempted');
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testProcessEmbeddingQueueRetriesApiLevelErrorsThreeTimes');
}

// ── Test: processEmbeddingQueue stops immediately on permanent API errors ─

async function testProcessEmbeddingQueueStopsImmediatelyOnPermanentApiErrors() {
    console.log('  testProcessEmbeddingQueueStopsImmediatelyOnPermanentApiErrors...');
    const dir = tmpDir('embed-api-error');
    try {
        const fss = new FSStorage(dir);
        fss.mode = 'full';
        const file = { item_id: path.join(dir, 'auth.md'), type: 'file', embedded: 0 };
        fss.storage = {
            search: async () => ({ items: [{ item: file }] })
        };
        let calls = 0;
        fss.embedSingleFile = async () => {
            calls++;
            const err = new Error('unauthorized');
            err.status = 401;
            throw err;
        };

        const processed = await fss.processEmbeddingQueue(() => false);
        assert.equal(processed, 0);
        assert.equal(calls, 1, 'permanent API errors should stop the queue immediately');
        assert.ok(fss.scannerState.last_embedding_task_at, 'embedding task timestamp should be updated');
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testProcessEmbeddingQueueStopsImmediatelyOnPermanentApiErrors');
}

// ── Test: processEmbeddingQueue skips reset API failure streak ───────

async function testProcessEmbeddingQueueSkipsResetApiFailureStreak() {
    console.log('  testProcessEmbeddingQueueSkipsResetApiFailureStreak...');
    const dir = tmpDir('embed-skip-reset');
    try {
        const fss = new FSStorage(dir);
        fss.mode = 'full';
        const files = [
            { item_id: path.join(dir, 'api-1.md'), type: 'file', embedded: 0 },
            { item_id: path.join(dir, 'drift.md'), type: 'file', embedded: 0 },
            { item_id: path.join(dir, 'api-2.md'), type: 'file', embedded: 0 },
            { item_id: path.join(dir, 'file-error.md'), type: 'file', embedded: 0 },
            { item_id: path.join(dir, 'api-3.md'), type: 'file', embedded: 0 },
            { item_id: path.join(dir, 'api-4.md'), type: 'file', embedded: 0 },
            { item_id: path.join(dir, 'api-5.md'), type: 'file', embedded: 0 }
        ];
        fss.storage = {
            search: async (conditions) => {
                const embeddedFilter = conditions.find((condition) => condition.field === 'embedded');
                return {
                    items: files.filter((item) => item.embedded === embeddedFilter.value).map((item) => ({ item }))
                };
            },
            update: async (items) => {
                for (const item of items) {
                    const target = files.find((file) => file.item_id === item.item_id);
                    if (target && typeof item.embedded === 'number') {
                        target.embedded = item.embedded;
                    }
                }
            }
        };
        const calls = [];
        fss.embedSingleFile = async (file) => {
            calls.push(path.basename(file.item_id));
            if (file.item_id.endsWith('drift.md')) {
                return { status: 'skipped_drift' };
            }
            if (file.item_id.endsWith('file-error.md')) {
                const err = new Error('input too long');
                err.status = 400;
                throw err;
            }
            const err = new Error('server unavailable');
            err.status = 503;
            throw err;
        };

        const processed = await fss.processEmbeddingQueue(() => false);
        assert.equal(processed, 0);
        assert.deepEqual(
            calls,
            ['api-1.md', 'drift.md', 'api-2.md', 'file-error.md', 'api-3.md', 'api-4.md', 'api-5.md'],
            'drift and file-level skips should reset consecutive API failures'
        );
        assert.ok(fss.scannerState.last_embedding_task_at, 'embedding task timestamp should be updated');
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testProcessEmbeddingQueueSkipsResetApiFailureStreak');
}

// ── Test 11 (Task 11): getStatus reports metadata without global counts ─────────────

async function testGetStatusReportsMetadata() {
    console.log('  testGetStatusReportsMetadata...');
    const dir = tmpDir('status');
    try {
        const fss = await createFSStorage(dir);
        const file = path.join(dir, 'x.md');
        fs.writeFileSync(file, 'x');
        await fss.saveFiles([makeFileEntry(file)], dir);
        const s = await fss.getStatus();
        assert.equal(s.mode, OPENROUTER_API_KEY ? 'full' : 'base-only');
        assert.equal('embedded_count' in s, false);
        assert.equal('pending_count' in s, false);
        assert.equal(s.last_embedding_task_at, null);
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testGetStatusReportsMetadata');
}

// ── Test: searchFileByName filters embedded=0 rows ───────────────────

async function testSearchFilterEmbeddedOneExcludesPending() {
    console.log('  testSearchFilterEmbeddedOneExcludesPending...');
    const dir = tmpDir('embedfilter');
    try {
        const fss = await createFSStorage(dir);
        // File A: fully embedded
        const fa = path.join(dir, 'alpha.md');
        fs.writeFileSync(fa, '# alpha topic');
        await fss.saveFiles([makeFileEntry(fa)], dir);
        const rowA = (
            await fss.storage.search([{ indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: fa }])
        ).items[0].item;
        await fss.embedSingleFile(rowA);

        // File B: vector seeded manually (simulating a stale state) but base.embedded=0
        const fb = path.join(dir, 'beta.md');
        fs.writeFileSync(fb, '# beta topic');
        await fss.saveFiles([makeFileEntry(fb)], dir);
        // Manually inject a vector row for B but keep embedded=0
        const dim = fss.scannerState.vec_dim;
        await fss.storage.upsert(
            [
                {
                    item_id: fb,
                    item_type: 'file',
                    filename: 'beta.md',
                    indexer_columns: { VectorIndexer: [{ column: 'filename', content: new Array(dim).fill(0.1) }] }
                }
            ],
            { indexers: ['VectorIndexer'] }
        );
        // Confirm B is still embedded=0
        const rowB = (
            await fss.storage.search([{ indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: fb }])
        ).items[0].item;
        assert.equal(rowB.embedded, 0);

        // Query — must NOT include B
        const r = await fss.searchFileByName('beta');
        const paths = r.results.map((x) => x.path);
        assert.ok(!paths.includes(fb), 'embedded=0 row must be filtered out');

        // After embedding B, it should appear
        await fss.embedSingleFile(rowB);
        const r2 = await fss.searchFileByName('beta');
        const paths2 = r2.results.map((x) => x.path);
        assert.ok(paths2.includes(fb));
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testSearchFilterEmbeddedOneExcludesPending');
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
    console.log('=== FSStorage Tests ===\n');
    let passed = 0,
        failed = 0;

    const tests = [
        testParseRootRefs,
        testSearchFileByName,
        testSearchFileByContent,
        testRemoveDeletedFilesMultiRoot,
        testDetachRootDeferred,
        testSaveScannerStateConcurrent,
        testEmbedWithRetry429,
        testEmbedWithRetryUsesSmallApiBatch,
        testMakeSchemaModes,
        testScannerStateNewField,
        testScannerStateMigratesLastFileCount,
        testScannerStateMigratesLastScanAt,
        testScannerStateMigratesPausedWithoutResettingCheckpoint,
        testSetRootPausedPersistsDiskBeforeMemoryCommit,
        testSetRootPausedUsesCallTimeSnapshot,
        testQueuedCheckpointSaveKeepsCommittedPause,
        testSetRootPausedFailureDoesNotLeakIntoLaterSave,
        testPermanentErrorPersistsFormatsAndNotifies,
        testClassifyEmbeddingErrorTableRules,
        testSyncEmbeddingModeClearsPermanentErrorWhenModelMissing,
        testSyncEmbeddingModeClearsPermanentErrorAfterSuccessfulProbe,
        testSyncEmbeddingModePersistsPermanentProbeError,
        testSyncEmbeddingModeUsesCanonicalResetReasons,
        testInitializeSyncEmbeddingGate,
        testProbeEmbeddingBudgetOptions,
        testResetVectorChunkPreservesBaseAndResetsEmbedded,
        testResetVectorChunkAcceptsExplicitDimAndMode,
        testUninitializedVectorAndChunkIndexersDropOldDimStorage,
        testResetVectorChunkRecoversFromBaseOnlyOldDimStorage,
        testResetVectorChunkDoesNotPublishHalfInitializedStorage,
        testArkDataRawDropOnlyDropsTables,
        testResetVectorChunkRecordsRebuildEvent,
        testRebuildAllRecordsFullEventAndResetsVectorState,
        testRebuildAllRecordsFailedFullEvent,
        testMigrateRefCountBackfillsLegacyRowsOnce,
        testSearchItemsUnderRootUsesSubtreeBounds,
        testRemoveRootFromItemsKeepsEmptyRefsForCoveredChildren,
        testDetachRootForConfigChangeKeepsNewChildRootRows,
        testRemoveDeletedFilesUsesActiveRootsWithoutSelfKeeping,
        testRefCountZeroHiddenFromSearchQueueAndStats,
        testCarveOutKeepsIntermediateRowInvisibleUntilChildScan,
        testGetPerRootCountsReportsVisibleFailedUnavailableAndBaseOnly,
        testPerRootCountsUseRootRefsForOverlappingRoots,
        testPerRootCountsNormalizeRootRefsBeforeCompare,
        testPerRootCountsNormalizeWindowsSeparatorsBeforeCompare,
        testHarmonyPerRootCountsUseFreshCache,
        testHarmonyPerRootCountsReturnStaleWhileRefreshInFlight,
        testHarmonyPerRootCountsFallbackToScannerStateOnError,
        testHarmonyPerRootCountsClearCacheHelpers,
        testHarmonyPerRootCountsClearInvalidatesInFlightRefresh,
        testHarmonyPerRootCountsModeTransitionClearsCache,
        testSaveFilesBaseOnlyWritesEmbeddedZero,
        testSaveFilesRefOnlyPreservesEmbedded,
        testSaveFilesModifiedChangedResetsEmbedded,
        testSaveFilesMaintainsRootRefsAndRefCountScenarios,
        testPlanEmbeddingInputsSplitsOversizedChunksAndCapsBudget,
        testEmbedSingleFileHappyPath,
        testEmbedSingleFileOversizedContentFallsBackToFilenameOnly,
        testEmbedSingleFileGoneDeletes,
        testEmbedSingleFileDriftReturnsSkipped,
        testProcessEmbeddingQueueDrainsPending,
        testProcessEmbeddingQueueDriftSkippedOnce,
        testProcessEmbeddingQueueExcludesPausedOnlyOwnership,
        testHotSwapBaseOnlyToFull,
        testInitializeBaseOnlyWhenNoEmbedding,
        testInitializeFullWhenEmbeddingConfigured,
        testInitializeDimChangeSoftResetsAndStaysFull,
        testSearchByNameBaseOnlyReturnsEmbedUnavailable,
        testSearchBlankQueryReturnsEmptyResult,
        testSearchDeferredReturnsIndexNotReady,
        testSearchBaseOnlyPermanentErrorReturnsEmbedApiDown,
        testSearchEmbedFailureReturnsEmbedApiDown,
        testSearchSemanticRoutesExposeScores,
        testScopedSearchDiagnosticsIncludeFilemgrRouteAndScope,
        testSearchIndexedChunksContractAndRerankFallback,
        testProcessEmbeddingQueueSkipsFileErrorsOnce,
        testProcessEmbeddingQueueMarksPermanentFileErrorsAsDisabled,
        testProcessEmbeddingQueueKeepsAmbiguousBadRequestRetryable,
        testProcessEmbeddingQueuePrioritizesFreshBeforeFailed,
        testProcessEmbeddingQueueRetriesApiLevelErrorsThreeTimes,
        testInitializeReadonlyMissingBaseIndexDoesNotWriteState,
        testInitializeReadonlyUsesStorageProbeInsteadOfHardcodedBasePath,
        testInitializeReadonlyOpensExistingBaseIndex,
        testGetStatusReportsMetadata,
        testSearchFilterEmbeddedOneExcludesPending
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
