/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import assert from 'node:assert/strict';
import { FileMgrApplication, formatStorageStatusBlock } from '../app.js';
import { ApplicationRegistry } from '../../registry.js';
import { Setting } from '../../../utils/setting.js';

const originalCallWorker = ApplicationRegistry.callWorker;

const settingDataWithFilemgrEntry = {
    default_embedding_model: 'test-embed',
    default_reranker_model: '',
    default_model: '',
    default_intent_parsing_model: '',
    default_vision_model: '',
    providers: [
        {
            name: 'test',
            base_url: 'https://example.test/v1',
            api_key: 'test',
            no_proxy: true
        }
    ],
    models: [
        {
            alias: 'test-embed',
            provider_name: 'test',
            model_name: 'test-embedding'
        }
    ],
    applications: {
        filemgr: {
            entries: [
                {
                    root: '/tmp/filemgr-status-test',
                    include_patterns: ['**/*'],
                    exclude_patterns: []
                }
            ]
        }
    }
};

function makeStatusData(overrides = {}) {
    return {
        status: 'running',
        scanners: [
            {
                root: '/tmp/filemgr-status-test',
                lastFullScan: 0,
                totalFiles: 0,
                isRunning: false
            }
        ],
        storage: {
            mode: 'full',
            total_files: 0,
            embedded_count: 0,
            pending_count: 0,
            db_size: 0,
            vecdb_size: 0,
            chunk_size: 0
        },
        isDeferred: false,
        deferredReason: null,
        probe_permanent_error: null,
        last_rebuild_event: null,
        unavailable_roots: {},
        readonly: false,
        ...overrides
    };
}

function testBaseOnlyDoesNotReportUnloadedChunksAsZero() {
    const text = formatStorageStatusBlock({
        mode: 'base-only',
        total_files: 18255,
        embedded_count: 6146,
        pending_count: 12109,
        db_size: 18255,
        vecdb_size: 0,
        chunk_size: 0
    });

    assert.ok(text.includes('已嵌入文件: 6146 条（嵌入暂停）'));
    assert.ok(text.includes('内容分片 未加载（基础模式）'));
    assert.ok(!text.includes('内容分片 0 条'));
    assert.ok(!text.includes('向量存储: 6146 条'));
}

function testFullModeReportsChunkCount() {
    const text = formatStorageStatusBlock({
        mode: 'full',
        total_files: 10,
        embedded_count: 4,
        pending_count: 6,
        db_size: 10,
        vecdb_size: 4,
        chunk_size: 12
    });

    assert.ok(text.includes('向量嵌入: 4 / 10 已完成（6 待处理）'));
    assert.ok(text.includes('存储占用: 元数据 10 条 | 内容分片 12 条'));
}

async function testTUIReadonlyModesAreHiddenFromDashboard() {
    Setting.updateInstanceData(settingDataWithFilemgrEntry);
    Setting.getInstance().data.applications.filemgr = settingDataWithFilemgrEntry.applications.filemgr;

    const app = new FileMgrApplication();
    const statusData = makeStatusData({
        status: 'readonly',
        readonly: true,
        storage: {
            mode: 'base-only',
            total_files: 12,
            embedded_count: 0,
            pending_count: 0,
            db_size: 12,
            vecdb_size: 0,
            chunk_size: 0
        }
    });
    app.registry = {
        callWorker: async () => ({
            data: statusData
        })
    };

    assert.equal(await app.getTUIStatusBlock(), null);

    statusData.storage = {
        mode: 'full',
        total_files: 12,
        embedded_count: 12,
        pending_count: 0,
        db_size: 12,
        vecdb_size: 12,
        chunk_size: 24
    };

    assert.equal(await app.getTUIStatusBlock(), null);
}

async function testTUINonReadonlyBaseOnlyStillWarns() {
    Setting.updateInstanceData(settingDataWithFilemgrEntry);
    Setting.getInstance().data.applications.filemgr = settingDataWithFilemgrEntry.applications.filemgr;

    const app = new FileMgrApplication();
    app.registry = {
        callWorker: async () => ({
            data: makeStatusData({
                storage: {
                    mode: 'base-only',
                    total_files: 12,
                    embedded_count: 0,
                    pending_count: 0,
                    db_size: 12,
                    vecdb_size: 0,
                    chunk_size: 0
                }
            })
        })
    };

    const text = await app.getTUIStatusBlock();
    assert.equal(text, '⚠ 向量嵌入暂时不可用，将在下次扫描时自动重试');
}

async function runSlashStatus(data) {
    ApplicationRegistry.callWorker = async () => ({
        status: 'ok',
        data: {
            status: 'ok',
            data
        }
    });

    let page = null;
    const tui = {
        showTextPage: (title, text) => {
            page = { title, text };
        }
    };
    const app = new FileMgrApplication();
    const command = app.getCliSlashCommands(tui).find((cmd) => cmd.name === 'fs-status');
    await command.execute();
    return page;
}

async function testSlashReadonlyDeferredDoesNotShowNoScanDirs() {
    const page = await runSlashStatus(
        makeStatusData({
            status: 'readonly',
            readonly: true,
            scanners: [],
            isDeferred: true,
            deferredReason: 'missing_base_index',
            storage: null
        })
    );

    assert.equal(page.title, '文件扫描状态');
    assert.ok(page.text.includes('状态: 查询模式'));
    assert.ok(page.text.includes('暂无可查询索引'));
    assert.ok(page.text.includes('⚠️ 查询模式：暂无可查询索引。请等待主窗口完成首次扫描后重新打开此窗口。'));
    assert.ok(!page.text.includes('暂无扫描目录'));
}

async function testSlashReadonlyFullModeCopyIsClear() {
    const page = await runSlashStatus(
        makeStatusData({
            status: 'readonly',
            readonly: true,
            scanners: [],
            storage: {
                mode: 'full',
                total_files: 420,
                embedded_count: 71,
                pending_count: 349,
                db_size: 420,
                vecdb_size: 71,
                chunk_size: 3192
            }
        })
    );

    assert.ok(page.text.includes('查询模式：可搜索已有完整索引'));
    assert.ok(page.text.includes('  当前窗口只用于查询，不扫描或更新文件。'));
    assert.ok(page.text.includes('  文件扫描和索引更新由另一个窗口负责。'));
    assert.ok(page.text.includes('⚠️ 查询模式：正在使用已有完整索引；本窗口不会扫描或更新文件。'));
}

async function testSlashShowsUnavailableRootsAndVisibleRebuildEvent() {
    const now = Date.now();
    const page = await runSlashStatus(
        makeStatusData({
            unavailable_roots: {
                '/tmp/filemgr-status-test': {
                    reason: 'enoent',
                    last_count: 1234,
                    ts: now
                }
            },
            last_rebuild_event: {
                type: 'full',
                reason: 'open_full_failed',
                status: 'failed',
                message: 'damaged',
                ts: now - 5 * 60 * 1000
            }
        })
    );

    assert.ok(page.text.includes('  ⚠ 暂时不可访问，索引已保留（上次 1,234 个文件）'));
    assert.ok(page.text.includes('最近索引重建: 文件索引（索引文件损坏）失败'));
    assert.ok(page.text.includes('：damaged'));
    assert.ok(page.text.includes('⚠️ 部分扫描路径暂时不可访问，索引已保留。'));
}

testBaseOnlyDoesNotReportUnloadedChunksAsZero();
testFullModeReportsChunkCount();
await testTUIReadonlyModesAreHiddenFromDashboard();
await testTUINonReadonlyBaseOnlyStillWarns();
await testSlashReadonlyDeferredDoesNotShowNoScanDirs();
await testSlashReadonlyFullModeCopyIsClear();
await testSlashShowsUnavailableRootsAndVisibleRebuildEvent();
ApplicationRegistry.callWorker = originalCallWorker;
console.log('✅ app-status-format tests passed');
