/**
 * FSStorage integration tests
 *
 * Uses REAL dependencies: real BaseStorage (SQLite in tmp dir), real parseAndChunk,
 * real LLM via OpenRouter API.
 *
 * 运行方式：
 * source ~/.nvm/nvm.sh && nvm use 20 && npx tsx src/main/applications/filemgr/__tests__/storage.test.js
 */

import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { FSStorage, RebuildRequiredError, SCAN_INTERVAL_MS, makeSchema } from '../storage.js';
import { Setting, setCustomAppDirectory } from '../../../utils/setting.js';
import { LLM } from '../../../aikernel/llm.ts';

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
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// ── Global Setting setup ────────────────────────────────────────────
// Must set custom app dir BEFORE Setting.getInstance() is called.
// Initialised here (before the no-API early-exit) so that tests that
// depend on settingData / globalAppDir can run in the fast path too.
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

// Persist setting to disk so Setting.load() works after clearCache()
fs.writeFileSync(path.join(globalAppDir, 'setting.json'), JSON.stringify(settingData, null, 4), 'utf-8');

Setting.updateInstanceData(settingData);

if (!OPENROUTER_API_KEY) {
    console.log('OPENROUTER_API_KEY not set, running pure storage tests');
    await testScannerStateNewField();
    await testMakeSchemaModes();
    await testResetVectorChunkAcceptsExplicitDimAndMode();
    await testResetVectorChunkPreservesBaseAndResetsEmbedded();
    await testSaveFilesBaseOnlyWritesEmbeddedZero();
    await testSaveFilesRefOnlyPreservesEmbedded();
    await testSaveFilesModifiedChangedResetsEmbedded();
    await testEmbedSingleFileGoneDeletes();
    await testInitializeBaseOnlyWhenNoEmbedding();
    await testSearchByNameBaseOnlyReturnsEmbedUnavailable();
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
        if (fss?.storage) fss.storage.close();
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
        if (fss?.storage) fss.storage.close();
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

        // Remove from root2 → should delete
        await fss.removeDeletedFiles(root2, new Set());
        const afterDelete = await fss.storage.search([
            { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: mdPath }
        ]);
        assert.equal(afterDelete.items.length, 0, 'file should be deleted after removing all roots');

        console.log('  ✅ testRemoveDeletedFilesMultiRoot');
    } finally {
        if (fss?.storage) fss.storage.close();
        cleanup(testDir);
    }
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
    console.log('  ✅ testMakeSchemaModes');
}

// ── Test 12: scanner_state has embedding task timestamp field ───────

async function testScannerStateNewField() {
    console.log('  testScannerStateNewField...');
    const fss = new FSStorage(tmpDir('state'));
    assert.equal(fss.scannerState.last_embedding_task_at, null);
    console.log('  ✅ testScannerStateNewField');
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
        await fss.storage.update([{ item_id: file, item_type: 'file', embedded: 1 }], { indexers: ['BaseIndexer'] });

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
        await fss.storage.update([{ item_id: file, item_type: 'file', embedded: 1 }], { indexers: ['BaseIndexer'] });
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
        await fss1.storage.update([{ item_id: file, item_type: 'file', embedded: 1 }], { indexers: ['BaseIndexer'] });
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
    } finally {
        Setting.updateInstanceData(settingData);
        fs.writeFileSync(path.join(globalAppDir, 'setting.json'), JSON.stringify(settingData, null, 4));
        cleanup(dir);
    }
    console.log('  ✅ testSearchByNameBaseOnlyReturnsEmbedUnavailable');
}

// ── Test 11 (Task 11): getStatus reports mode and counts ─────────────

async function testGetStatusReportsModeAndCounts() {
    console.log('  testGetStatusReportsModeAndCounts...');
    const dir = tmpDir('status');
    try {
        const fss = await createFSStorage(dir);
        const file = path.join(dir, 'x.md');
        fs.writeFileSync(file, 'x');
        await fss.saveFiles([makeFileEntry(file)], dir);
        const s = await fss.getStatus();
        assert.equal(s.mode, 'full');
        assert.equal(s.embedded_count, 0);
        assert.equal(s.pending_count, 1);
        assert.equal(s.last_embedding_task_at, null);
    } finally {
        cleanup(dir);
    }
    console.log('  ✅ testGetStatusReportsModeAndCounts');
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
        testMakeSchemaModes,
        testScannerStateNewField,
        testResetVectorChunkPreservesBaseAndResetsEmbedded,
        testResetVectorChunkAcceptsExplicitDimAndMode,
        testSaveFilesBaseOnlyWritesEmbeddedZero,
        testSaveFilesRefOnlyPreservesEmbedded,
        testSaveFilesModifiedChangedResetsEmbedded,
        testEmbedSingleFileHappyPath,
        testEmbedSingleFileGoneDeletes,
        testEmbedSingleFileDriftReturnsSkipped,
        testProcessEmbeddingQueueDrainsPending,
        testProcessEmbeddingQueueDriftSkippedOnce,
        testHotSwapBaseOnlyToFull,
        testInitializeBaseOnlyWhenNoEmbedding,
        testInitializeFullWhenEmbeddingConfigured,
        testInitializeDimChangeSoftResetsAndStaysFull,
        testSearchByNameBaseOnlyReturnsEmbedUnavailable,
        testGetStatusReportsModeAndCounts,
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
