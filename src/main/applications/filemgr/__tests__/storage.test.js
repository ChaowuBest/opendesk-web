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
import { FSStorage, EmbeddingNotConfiguredError, RebuildRequiredError, SCAN_INTERVAL_MS } from '../storage.js';
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
// Must set custom app dir BEFORE Setting.getInstance() is called
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) {
    console.log('OPENROUTER_API_KEY not set, skipping filemgr storage tests');
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

// Persist setting to disk so Setting.load() works after clearCache()
fs.writeFileSync(path.join(globalAppDir, 'setting.json'), JSON.stringify(settingData, null, 4), 'utf-8');

Setting.updateInstanceData(settingData);

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

// ── Test 1: indexFile with chunks ───────────────────────────────────

async function testIndexFileWithChunks() {
    console.log('  testIndexFileWithChunks...');
    const testDir = tmpDir('idx-chunks');
    let fss;
    try {
        // Create a .md file with real content
        const mdPath = path.join(testDir, 'architecture.md');
        fs.writeFileSync(mdPath, SAMPLE_MD_CONTENT, 'utf-8');

        fss = await createFSStorage(testDir);
        const fileEntry = makeFileEntry(mdPath);

        await fss.indexFile(fileEntry, {
            wasInDb: false,
            existingItem: undefined,
            scannerRoot: testDir
        });

        // Verify BaseIndexer has data
        const baseResult = await fss.storage.search([
            { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: mdPath }
        ]);
        assert.equal(baseResult.items.length, 1, 'BaseIndexer should have 1 item');
        assert.equal(baseResult.items[0].item.filename, 'architecture.md');

        // Verify VectorIndexer has data
        const embedding = await LLM.embed('architecture');
        const vecResult = await fss.storage.search([
            {
                indexer: 'VectorIndexer',
                field: 'filename',
                operator: 'vector_near',
                value: embedding,
                vectorQuery: { topK: 5, metric: 'cosine' }
            }
        ]);
        assert.ok(vecResult.items.length >= 1, 'VectorIndexer should find the file');

        // Verify ChunkIndexer has data
        const chunkResult = await fss.storage.search([
            {
                indexer: 'ChunkIndexer',
                field: 'chunk_text',
                operator: 'vector_near',
                value: embedding,
                vectorQuery: { topK: 5, metric: 'cosine' }
            }
        ]);
        assert.ok(chunkResult.items.length >= 1, 'ChunkIndexer should have chunk data');

        // Verify status reflects data in all indexers
        const status = await fss.getStatus();
        assert.ok(status.db_size >= 1, 'db_size should be >= 1');
        assert.ok(status.vecdb_size >= 1, 'vecdb_size should be >= 1');
        assert.ok(status.chunk_size >= 1, 'chunk_size should be >= 1');

        console.log('  ✅ testIndexFileWithChunks');
    } finally {
        if (fss?.storage) fss.storage.close();
        cleanup(testDir);
    }
}

// ── Test 2: indexFile without chunks ────────────────────────────────

async function testIndexFileNoChunks() {
    console.log('  testIndexFileNoChunks...');
    const testDir = tmpDir('idx-nochunks');
    let fss;
    try {
        // Create a tiny .json file (parseAndChunk returns chunk_type='filename')
        const jsonPath = path.join(testDir, 'config.json');
        fs.writeFileSync(jsonPath, '{"key": "value"}', 'utf-8');

        fss = await createFSStorage(testDir);
        const fileEntry = makeFileEntry(jsonPath);

        await fss.indexFile(fileEntry, {
            wasInDb: false,
            existingItem: undefined,
            scannerRoot: testDir
        });

        // Verify BaseIndexer has data
        const baseResult = await fss.storage.search([
            { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: jsonPath }
        ]);
        assert.equal(baseResult.items.length, 1, 'BaseIndexer should have 1 item');

        // Verify VectorIndexer has data (filename embedding)
        const embedding = await LLM.embed('config');
        const vecResult = await fss.storage.search([
            {
                indexer: 'VectorIndexer',
                field: 'filename',
                operator: 'vector_near',
                value: embedding,
                vectorQuery: { topK: 5, metric: 'cosine' }
            }
        ]);
        assert.ok(vecResult.items.length >= 1, 'VectorIndexer should find the file');

        // Verify ChunkIndexer is empty
        const status = await fss.getStatus();
        assert.equal(status.chunk_size, 0, 'ChunkIndexer should be empty for filename-only file');

        console.log('  ✅ testIndexFileNoChunks');
    } finally {
        if (fss?.storage) fss.storage.close();
        cleanup(testDir);
    }
}

// ── Test 3: indexFile transition to no-chunks ───────────────────────

async function testIndexFileTransitionToNoChunks() {
    console.log('  testIndexFileTransitionToNoChunks...');
    const testDir = tmpDir('idx-transition');
    let fss;
    try {
        // Step 1: Create a .md file with content and index it
        const mdPath = path.join(testDir, 'doc.md');
        fs.writeFileSync(mdPath, SAMPLE_MD_CONTENT, 'utf-8');

        fss = await createFSStorage(testDir);
        const fileEntry1 = makeFileEntry(mdPath);

        await fss.indexFile(fileEntry1, {
            wasInDb: false,
            existingItem: undefined,
            scannerRoot: testDir
        });

        // Verify chunks exist
        let status = await fss.getStatus();
        assert.ok(status.chunk_size >= 1, 'ChunkIndexer should have data after first index');
        const chunkSizeBefore = status.chunk_size;

        // Step 2: Overwrite the file with empty content, re-index with wasInDb=true
        fs.writeFileSync(mdPath, '', 'utf-8');
        const fileEntry2 = makeFileEntry(mdPath);

        // Get existing item for wasInDb=true
        const existing = await fss.storage.search([
            { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: mdPath }
        ]);
        const existingItem = existing.items[0].item;

        await fss.indexFile(fileEntry2, {
            wasInDb: true,
            existingItem,
            scannerRoot: testDir
        });

        // Verify ChunkIndexer is now empty (clearIndexerForItem was called)
        status = await fss.getStatus();
        assert.equal(status.chunk_size, 0, 'ChunkIndexer should be cleared after transition to no-chunks');

        // BaseIndexer and VectorIndexer should still have data
        assert.ok(status.db_size >= 1, 'BaseIndexer should still have the item');
        assert.ok(status.vecdb_size >= 1, 'VectorIndexer should still have filename embedding');

        console.log('  ✅ testIndexFileTransitionToNoChunks');
    } finally {
        if (fss?.storage) fss.storage.close();
        cleanup(testDir);
    }
}

// ── Test 2b: indexFile with chunks=null (unknown format) ──────────────

async function testIndexFileChunksNull() {
    console.log('  testIndexFileChunksNull...');
    const testDir = tmpDir('idx-chunks-null');
    let fss;
    try {
        // .bin → resolveFormat returns null → chunk_type=null, chunks=null
        const binPath = path.join(testDir, 'data.bin');
        fs.writeFileSync(binPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));

        fss = await createFSStorage(testDir);
        const fileEntry = makeFileEntry(binPath);

        await fss.indexFile(fileEntry, {
            wasInDb: false,
            existingItem: undefined,
            scannerRoot: testDir
        });

        // BaseIndexer + VectorIndexer should have data, ChunkIndexer empty
        const status = await fss.getStatus();
        assert.ok(status.db_size >= 1, 'BaseIndexer should have item');
        assert.ok(status.vecdb_size >= 1, 'VectorIndexer should have filename embedding');
        assert.equal(status.chunk_size, 0, 'ChunkIndexer should be empty for unknown format');

        console.log('  ✅ testIndexFileChunksNull');
    } finally {
        if (fss?.storage) fss.storage.close();
        cleanup(testDir);
    }
}

// ── Test 2c: indexFile with empty .md (chunks=[]) ─────────────────

async function testIndexFileChunksEmpty() {
    console.log('  testIndexFileChunksEmpty...');
    const testDir = tmpDir('idx-chunks-empty');
    let fss;
    try {
        // Empty .md → extractText returns '' → segmentText returns [] → mergeBySize returns []
        const mdPath = path.join(testDir, 'empty.md');
        fs.writeFileSync(mdPath, '', 'utf-8');

        fss = await createFSStorage(testDir);
        const fileEntry = makeFileEntry(mdPath);

        await fss.indexFile(fileEntry, {
            wasInDb: false,
            existingItem: undefined,
            scannerRoot: testDir
        });

        // BaseIndexer + VectorIndexer should have data, ChunkIndexer empty
        const status = await fss.getStatus();
        assert.ok(status.db_size >= 1, 'BaseIndexer should have item');
        assert.ok(status.vecdb_size >= 1, 'VectorIndexer should have filename embedding');
        assert.equal(status.chunk_size, 0, 'ChunkIndexer should be empty for empty file');

        console.log('  ✅ testIndexFileChunksEmpty');
    } finally {
        if (fss?.storage) fss.storage.close();
        cleanup(testDir);
    }
}

// ── Test 3b: indexFile re-index with chunks (wasInDb=true, hasUsableChunks=true)

async function testIndexFileReindexWithChunks() {
    console.log('  testIndexFileReindexWithChunks...');
    const testDir = tmpDir('idx-reindex');
    let fss;
    try {
        fss = await createFSStorage(testDir);

        // Step 1: Index a .md file
        const mdPath = path.join(testDir, 'doc.md');
        fs.writeFileSync(mdPath, SAMPLE_MD_CONTENT, 'utf-8');
        const fileEntry1 = makeFileEntry(mdPath);

        await fss.indexFile(fileEntry1, {
            wasInDb: false,
            existingItem: undefined,
            scannerRoot: testDir
        });

        const statusBefore = await fss.getStatus();
        assert.ok(statusBefore.chunk_size >= 1, 'should have chunks after first index');

        // Step 2: Update the file with different content, re-index with wasInDb=true
        const updatedContent = `# Updated Document

This is a completely different document about machine learning and neural networks.

## Deep Learning

Convolutional neural networks process images through multiple layers of filters.
Each layer learns increasingly abstract features from raw pixels to complex patterns.

## Reinforcement Learning

Agents learn optimal policies by interacting with environments and receiving rewards.
`;
        fs.writeFileSync(mdPath, updatedContent, 'utf-8');
        const fileEntry2 = makeFileEntry(mdPath);

        const existing = await fss.storage.search([
            { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: mdPath }
        ]);
        const existingItem = existing.items[0].item;

        await fss.indexFile(fileEntry2, {
            wasInDb: true,
            existingItem,
            scannerRoot: testDir
        });

        // Verify ChunkIndexer still has data (new chunks replaced old)
        const statusAfter = await fss.getStatus();
        assert.ok(statusAfter.chunk_size >= 1, 'should still have chunks after re-index');
        assert.ok(statusAfter.db_size >= 1, 'BaseIndexer should still have item');
        assert.ok(statusAfter.vecdb_size >= 1, 'VectorIndexer should still have data');

        // Verify the content is from the updated file (search for new content)
        const result = await fss.searchFileByContent('neural networks deep learning');
        assert.ok(result.results.length > 0, 'should find updated content');

        console.log('  ✅ testIndexFileReindexWithChunks');
    } finally {
        if (fss?.storage) fss.storage.close();
        cleanup(testDir);
    }
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

        for (const f of files) {
            const filePath = path.join(testDir, f.name);
            fs.writeFileSync(filePath, f.content, 'utf-8');
            const fileEntry = makeFileEntry(filePath);
            await fss.indexFile(fileEntry, {
                wasInDb: false,
                existingItem: undefined,
                scannerRoot: testDir
            });
        }

        // Search by name
        const result = await fss.searchFileByName('readme');
        assert.ok(result.query === 'readme', 'result should have query field');
        assert.ok(Array.isArray(result.results), 'result should have results array');
        assert.ok(typeof result.totalHits === 'number', 'result should have totalHits');
        assert.ok(result.results.length > 0, 'should find at least one result');

        // First result should have expected shape
        const first = result.results[0];
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

        for (const filePath of [file1, file2]) {
            const fileEntry = makeFileEntry(filePath);
            await fss.indexFile(fileEntry, {
                wasInDb: false,
                existingItem: undefined,
                scannerRoot: testDir
            });
        }

        // Verify multiple chunks exist (both files should produce chunks)
        const status = await fss.getStatus();
        assert.ok(status.chunk_size >= 2, 'should have chunks from multiple files');

        // Search by content — should return file-level aggregated results
        const result = await fss.searchFileByContent('authentication JWT token');
        assert.ok(result.query === 'authentication JWT token', 'result should have query field');
        assert.ok(Array.isArray(result.results), 'result should have results array');
        assert.ok(typeof result.totalHits === 'number', 'result should have totalHits');
        assert.ok(result.results.length > 0, 'should find at least one result');

        // Verify file-level aggregation: one result per file (even if multiple chunks matched)
        const paths = result.results.map((r) => r.path);
        const uniquePaths = [...new Set(paths)];
        assert.equal(paths.length, uniquePaths.length, 'should have one result per file (aggregated)');

        // Result follows SearchResultItem shape: path, filename, modified, size, snippet
        const first = result.results[0];
        assert.ok(typeof first.path === 'string', 'result should have path');
        assert.ok(typeof first.filename === 'string', 'result should have filename');
        assert.ok(
            typeof first.snippet === 'string' && first.snippet.length > 0,
            'result should have non-empty snippet'
        );

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

        await fss.indexFile(fileEntry, {
            wasInDb: false,
            existingItem: undefined,
            scannerRoot: root1
        });

        // Re-index under root2 (wasInDb=true, existing item has root1)
        const existing1 = await fss.storage.search([
            { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: mdPath }
        ]);
        await fss.indexFile(fileEntry, {
            wasInDb: true,
            existingItem: existing1.items[0].item,
            scannerRoot: root2
        });

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

// ── Main ────────────────────────────────────────────────────────────

async function main() {
    console.log('=== FSStorage Tests ===\n');
    let passed = 0,
        failed = 0;

    const tests = [
        testIndexFileWithChunks,
        testIndexFileNoChunks,
        testIndexFileChunksNull,
        testIndexFileChunksEmpty,
        testIndexFileTransitionToNoChunks,
        testIndexFileReindexWithChunks,
        testParseRootRefs,
        testSearchFileByName,
        testSearchFileByContent,
        testRemoveDeletedFilesMultiRoot,
        testDetachRootDeferred,
        testSaveScannerStateConcurrent,
        testEmbedWithRetry429
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
