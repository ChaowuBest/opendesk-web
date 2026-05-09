/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import assert from 'node:assert/strict';
import { formatStorageStatusBlock } from '../app.js';

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

testBaseOnlyDoesNotReportUnloadedChunksAsZero();
testFullModeReportsChunkCount();
console.log('✅ app-status-format tests passed');
