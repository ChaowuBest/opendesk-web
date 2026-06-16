/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import assert from 'node:assert/strict';
import { FileMgrApplication, formatStorageStatusBlock } from '../../../../main/applications/filemgr/app.js';
import { ApplicationRegistry } from '../../../../main/applications/registry.js';
import { Setting } from '../../../../main/utils/setting.js';
import { setRuntimeLocale } from '../../../../locale/index.js';

const originalCallWorker = ApplicationRegistry.callWorker;
const now = Date.now();
setRuntimeLocale('zh-CN');

const settingDataWithFilemgrEntry = {
    locale: 'zh-CN',
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
            model_name: 'test-embedding',
            model_type: 'embedding'
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
        mode: 'full',
        alerts: [],
        sources: [
            {
                root: '/tmp/filemgr-status-test',
                entry: {
                    root: '/tmp/filemgr-status-test',
                    include_patterns: ['**/*'],
                    exclude_patterns: []
                },
                state: 'completed',
                last_scan_at: now - 5 * 60 * 1000,
                total_files: 12,
                embedded_count: 12,
                pending_count: 0,
                is_workspace: false
            }
        ],
        totals: {
            total_files: 12,
            embedded_count: 12,
            pending_count: 0,
            last_embedding_task_at: now - 5 * 60 * 1000
        },
        storage_stats: {
            db_size: 12,
            vecdb_size: 12,
            chunk_size: 24
        },
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
                mode: 'base-only',
                alerts: [{ code: 'embed_model_missing' }],
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

async function testStatusChangedBridgePublishesAndNotifiesTUI() {
    const app = new FileMgrApplication();
    const payload = {
        reason: 'test',
        snapshot: {
            status: 'running'
        }
    };
    const sentEvents = [];
    let tuiNotices = 0;

    app.sendEventToSubscribers = (eventName, eventPayload) => {
        sentEvents.push({ eventName, payload: eventPayload });
    };
    app.noticeTUIStatusUpdate = () => {
        tuiNotices += 1;
    };

    app.publishStatusChanged(payload);

    assert.deepEqual(sentEvents, [
        {
            eventName: 'onStatusChanged',
            payload
        }
    ]);
    assert.equal(tuiNotices, 1);

    const events = await app.getSupportedEvents();
    assert.ok(events.some((event) => event.eventName === 'onStatusChanged'));
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
            mode: null,
            sources: [],
            totals: null,
            storage_stats: null,
            readonly: true,
            scanners: [],
            isDeferred: true,
            deferredReason: 'missing_base_index',
            storage: null
        })
    );

    assert.equal(page.title, '文件扫描状态');
    assert.ok(page.text.includes('状态: ● 查询模式'));
    assert.ok(page.text.includes('暂无可查询索引'));
    assert.ok(page.text.includes('⚠️ 查询模式：暂无可查询索引。请等待主窗口完成首次扫描后重新打开此窗口。'));
    assert.ok(!page.text.includes('暂无扫描目录'));
}

async function testSlashReadonlyFullModeCopyIsClear() {
    const page = await runSlashStatus(
        makeStatusData({
            status: 'readonly',
            mode: 'full',
            readonly: true,
            sources: [],
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

    assert.ok(page.text.includes('状态: ● 查询模式 · 完整索引'));
    assert.ok(page.text.includes('⚠️ 查询模式：正在使用已有完整索引；本窗口不会扫描或更新文件。'));
}

async function testSlashShowsUnavailableRootsAndVisibleRebuildEvent() {
    const now = Date.now();
    const page = await runSlashStatus(
        makeStatusData({
            sources: [
                {
                    root: '/tmp/filemgr-status-test',
                    entry: {
                        root: '/tmp/filemgr-status-test',
                        include_patterns: ['**/*'],
                        exclude_patterns: []
                    },
                    state: 'unavailable',
                    last_scan_at: now - 2 * 24 * 60 * 60 * 1000,
                    total_files: 1234,
                    embedded_count: 0,
                    pending_count: 0,
                    is_workspace: false
                }
            ],
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

    assert.ok(page.text.includes('路径不可访问 · 上次 1,234 文件'));
    assert.ok(page.text.includes('最近索引重建: 文件索引（索引文件损坏）失败'));
    assert.ok(page.text.includes('：damaged'));
    assert.ok(page.text.includes('⚠️ 部分扫描路径暂时不可访问，索引已保留。'));
}

async function testSlashStatusLabels() {
    const cases = [
        ['idle', '● 未配置'],
        ['initializing', '● 正在启动'],
        ['running', '● 运行中 · 完整索引'],
        ['readonly', '● 查询模式 · 完整索引'],
        ['error', '● 异常']
    ];

    for (const [status, label] of cases) {
        const page = await runSlashStatus(
            makeStatusData({
                status,
                mode: status === 'running' || status === 'readonly' ? 'full' : null,
                sources: status === 'running' || status === 'readonly' ? undefined : [],
                totals: status === 'running' || status === 'readonly' ? undefined : null,
                storage_stats: status === 'running' || status === 'readonly' ? undefined : null
            })
        );
        assert.ok(page.text.includes(`状态: ${label}`), `missing status label ${label}`);
    }
}

async function testSlashAlertMessages() {
    const cases = [
        [{ code: 'no_roots' }, '告警: 未配置扫描目录'],
        [{ code: 'embed_model_missing' }, '告警: 向量嵌入模型未配置'],
        [{ code: 'embedding_pending' }, '告警: 向量嵌入索引暂未就绪，将在扫描时自动同步'],
        [
            { code: 'embedding_unavailable', data: { message: '401 Unauthorized' } },
            '告警: 向量嵌入不可用：401 Unauthorized'
        ],
        [{ code: 'worker_init_failed', data: { reason: 'boom' } }, '告警: FileMgr 启动失败：boom']
    ];

    for (const [alert, expected] of cases) {
        const page = await runSlashStatus(
            makeStatusData({
                status: alert.code === 'worker_init_failed' ? 'error' : 'running',
                alerts: [alert],
                mode: alert.code === 'worker_init_failed' ? null : 'base-only'
            })
        );
        assert.ok(page.text.includes(expected), `missing alert text ${expected}`);
    }
}

testBaseOnlyDoesNotReportUnloadedChunksAsZero();
testFullModeReportsChunkCount();
await testTUIReadonlyModesAreHiddenFromDashboard();
await testTUINonReadonlyBaseOnlyStillWarns();
await testStatusChangedBridgePublishesAndNotifiesTUI();
await testSlashReadonlyDeferredDoesNotShowNoScanDirs();
await testSlashReadonlyFullModeCopyIsClear();
await testSlashShowsUnavailableRootsAndVisibleRebuildEvent();
await testSlashStatusLabels();
await testSlashAlertMessages();
ApplicationRegistry.callWorker = originalCallWorker;
console.log('✅ app-status-format tests passed');
