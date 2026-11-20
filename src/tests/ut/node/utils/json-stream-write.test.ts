import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import {
    atomicWriteJsonFile,
    jsonChunks,
    jsonChunksBuffered,
    JSON_BIG_STRING_CHARS
} from '../../../../main/utils/json-stream-write.js';

/**
 * 流式 JSON 写出（issue #341 导出内存防护）：
 * - jsonChunks 按 JSON.stringify(value, null, indent) 的字节输出分块产出；
 * - 峰值内存 = 单个标量字符串 + 超大字符串切片 + 批量写缓冲，不物化整个输出串；
 * - 原子写出与 atomicWriteFile 同语义（临时文件 + rename + 瞬时锁重试）。
 * 字节一致性由本文件钉死：包括 undefined 省略、数组空洞补 null、Date.toJSON、
 * 数字格式（-0 / NaN / 1e21）、well-formed lone surrogate、代理对不跨切片。
 */

let dataDir: string | undefined;

before(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-json-stream-write-'));
});

after(() => {
    if (dataDir && fs.existsSync(dataDir)) {
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
    dataDir = undefined;
});

/** 代理对恰好落在切片边界上的超大字符串（首尾各覆盖一次边界） */
function buildBoundaryString(): string {
    // 高代理位于 index 65535（切片默认在 65536 处截断会把它单独留下）
    return 'x'.repeat(JSON_BIG_STRING_CHARS - 1) + '\ud83d\ude00' + 'y'.repeat(JSON_BIG_STRING_CHARS * 2 - 2) + '😀';
}

test('jsonChunks is byte-identical to JSON.stringify(value, null, 4) on a rich fixture', () => {
    const value = {
        task_id: 'stream-1',
        escapes: 'quote " backslash \\ newline \n tab \t control \u0000 unicode 😀 lone\ud800',
        numbers: [0, -0, 1.5, -1.5, 1e21, 1e-7, NaN, Infinity, -Infinity, 0.1],
        booleans: [true, false, null],
        omitted: { skip: undefined, skipFn: () => 1, keep: 1 },
        allSkipped: { a: undefined, b: () => 2 },
        arrayHoles: [undefined, 1, null, 'x'],
        date: new Date('2026-11-09T09:00:00.000Z'),
        emptyObj: {},
        emptyArr: [],
        nested: { deep: { deeper: [{ a: [1, { b: 2 }] }, []] } }
    };
    const actual = [...jsonChunks(value, 4)].join('');
    assert.equal(actual, JSON.stringify(value, null, 4));
});

test('big strings are chunked without splitting surrogate pairs and stay byte-identical', () => {
    const value = {
        boundary: buildBoundaryString(),
        chunks: ['a'.repeat(JSON_BIG_STRING_CHARS + 7), ''.padEnd(JSON_BIG_STRING_CHARS * 2, '的')]
    };
    const actual = [...jsonChunks(value, 4)].join('');
    assert.equal(actual, JSON.stringify(value, null, 4));
    // 切片必须真的走大字符串路径，否则该用例没有覆盖到分块逻辑
    const chunks = [...jsonChunks({ s: 'x'.repeat(JSON_BIG_STRING_CHARS * 3) }, 4)];
    assert.ok(chunks.length > 1, 'big string must produce multiple chunks');
    for (const chunk of chunks) {
        assert.ok(chunk.length <= JSON_BIG_STRING_CHARS * 2 + 2, 'single chunk must stay bounded');
    }
});

test('a multi-hundred-KB document streams in bounded chunks and round-trips', async () => {
    const messages = Array.from({ length: 200 }, (_, i) => ({
        role: 'assistant',
        content: [
            {
                type: 'tool_call',
                toolcalls: [{ id: `call-${i}`, result: 'z'.repeat(4096), index: i }]
            }
        ]
    }));
    const value = { task_id: 'stream-big', chat_context: { messages } };
    const expected = JSON.stringify(value, null, 4);

    const chunks = [...jsonChunks(value, 4)];
    assert.equal(chunks.join(''), expected);
    assert.ok(chunks.length > 8, 'large document must stream in multiple bounded chunks');
    for (const chunk of chunks) {
        assert.ok(chunk.length <= 300 * 1024, 'write batch must stay bounded');
    }

    // 批量缓冲版本（文件/zip 写出实际使用的入口）同样保持字节一致且有界
    const batches = [...jsonChunksBuffered(value, 4)];
    assert.equal(batches.join(''), expected);
    assert.ok(batches.length < chunks.length, 'buffered variant must coalesce pieces');
    for (const batch of batches) {
        assert.ok(batch.length <= 300 * 1024, 'buffered batch must stay bounded');
    }
});

test('atomicWriteJsonFile matches JSON.stringify output and overwrites existing files', async () => {
    const value = { task_id: 'stream-atomic', nested: { list: [1, { s: '的'.repeat(100000) }] } };
    const target = path.join(dataDir!, 'dir-not-exists', 'task.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'stale content');

    await atomicWriteJsonFile(target, value, 4);

    assert.equal(fs.readFileSync(target, 'utf8'), JSON.stringify(value, null, 4));
    // 原子写出的临时文件不应残留
    const leftovers = fs.readdirSync(path.dirname(target)).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'no temp files may be left behind');
});

test('atomicWriteJsonFile rejects unserializable roots like JSON.stringify does', async () => {
    await assert.rejects(() => atomicWriteJsonFile(path.join(dataDir!, 'bad.json'), undefined, 4), TypeError);
    assert.throws(() => [...jsonChunks(123n, 4)], TypeError);
});
