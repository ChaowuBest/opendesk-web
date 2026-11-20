/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import fs from 'fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { buildAtomicWriteTmpPath, isTransientFileLockError } from './temp.js';

/**
 * 流式 JSON 序列化（issue #341 导出内存防护）。
 *
 * 背景：任务 JSON 导出走 JSON.stringify(value, null, 4) 会在内存里物化整个输出串
 * （384MB 级任务导出峰值可达文件体积的 2~3 倍，直接触发 V8 OOM）。本模块按
 * JSON.stringify 的字节输出逐块产出：容器递归展开，超大字符串切片转义，
 * 输出与 JSON.stringify(value, null, indent) 逐字节一致（含 undefined 键省略、
 * 数组空洞补 null、Date.toJSON、数字格式、well-formed lone surrogate 转义），
 * 由 src/tests/ut/node/utils/json-stream-write.test.ts 钉死。
 *
 * 内存上界：单个标量的 JSON 字符串、超大字符串的单个切片与一个写批次；
 * 永远不会同时存在两个大块。注意：入参对象图本身仍需常驻（调用方持有），
 * 本模块只消除"输出串"这部分峰值。
 */

/** 超过该长度的字符串走分块转义路径（也作为单个切片的目标长度）。 */
export const JSON_BIG_STRING_CHARS = 64 * 1024;

/** 文件/zip 写出路径的批量缓冲目标长度。 */
export const JSON_WRITE_BATCH_CHARS = 256 * 1024;

/**
 * 把 value 按 JSON.stringify(value, null, indent) 的字节输出逐块产出。
 * 每块长度有界：普通片段为单个标量/容器骨架，超大字符串为单个切片。
 * 与 JSON.stringify 的差异仅有一处：根级 undefined / 函数 / symbol 在
 * JSON.stringify 里返回 undefined（产出空文件），这里直接抛 TypeError——
 * 现有调用方（task.toJSON() 产物）不会出现该输入。
 */
export function* jsonChunks(value: unknown, indent: number = 4): Generator<string> {
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
        throw new TypeError('value is not JSON serializable at root');
    }
    const pads: string[] = [''];
    const pad = (depth: number): string => {
        while (pads.length <= depth) {
            pads.push(pads[pads.length - 1] + ' '.repeat(indent));
        }
        return pads[depth];
    };
    yield* writeValue(value, 0);

    function* writeValue(current: unknown, depth: number): Generator<string> {
        current = resolveToJson(current);
        if (current === undefined || typeof current === 'function' || typeof current === 'symbol') {
            // 仅数组元素会走到这里（对象键已在 writeObject 中省略），与 JSON.stringify 一致补 null
            yield 'null';
            return;
        }
        switch (typeof current) {
            case 'string':
                yield* writeString(current);
                return;
            case 'number':
            case 'boolean':
                yield JSON.stringify(current);
                return;
            case 'bigint':
                // 与 JSON.stringify 相同的失败语义
                throw new TypeError('Do not know how to serialize a BigInt');
            case 'object':
                break;
            default:
                yield 'null';
                return;
        }
        if (current === null) {
            yield 'null';
            return;
        }
        if (Array.isArray(current)) {
            yield* writeArray(current, depth);
            return;
        }
        yield* writeObject(current as Record<string, unknown>, depth);
    }

    function* writeArray(array: unknown[], depth: number): Generator<string> {
        if (array.length === 0) {
            yield '[]';
            return;
        }
        const itemPad = pad(depth + 1);
        yield '[\n';
        for (let index = 0; index < array.length; index++) {
            if (index > 0) {
                yield ',\n';
            }
            yield itemPad;
            yield* writeValue(array[index], depth + 1);
        }
        yield '\n';
        yield pad(depth);
        yield ']';
    }

    function* writeObject(object: Record<string, unknown>, depth: number): Generator<string> {
        const keys = Object.keys(object);
        if (keys.length === 0) {
            yield '{}';
            return;
        }
        const itemPad = pad(depth + 1);
        // '{' 惰性发射：所有键都被省略时要与空对象一致输出 {}（JSON.stringify 语义）
        let opened = false;
        for (const key of keys) {
            const item = resolveToJson(object[key]);
            // 与 JSON.stringify 一致：undefined / 函数 / symbol 值的键整体省略
            if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
                continue;
            }
            if (!opened) {
                yield '{\n';
                opened = true;
            } else {
                yield ',\n';
            }
            yield itemPad;
            yield JSON.stringify(key);
            yield ': ';
            yield* writeValue(item, depth + 1);
        }
        if (!opened) {
            yield '{}';
            return;
        }
        yield '\n';
        yield pad(depth);
        yield '}';
    }

    function* writeString(text: string): Generator<string> {
        if (text.length <= JSON_BIG_STRING_CHARS) {
            yield JSON.stringify(text);
            return;
        }
        yield '"';
        let start = 0;
        while (start < text.length) {
            let end = Math.min(start + JSON_BIG_STRING_CHARS, text.length);
            if (end < text.length) {
                // 不把代理对切到两个切片：切片以高代理结尾时回退一位，
                // 保证分块转义结果与整串 JSON.stringify 逐字节一致
                const code = text.charCodeAt(end - 1);
                if (code >= 0xd800 && code <= 0xdbff) {
                    end -= 1;
                }
            }
            yield JSON.stringify(text.slice(start, end)).slice(1, -1);
            start = end;
        }
        yield '"';
    }
}

/** jsonChunks 的批量版本：把小片段聚合成不超过 maxBatchChars 的块，降低写入次数。 */
export function* jsonChunksBuffered(
    value: unknown,
    indent: number = 4,
    maxBatchChars: number = JSON_WRITE_BATCH_CHARS
): Generator<string> {
    let batch = '';
    for (const piece of jsonChunks(value, indent)) {
        batch += piece;
        if (batch.length >= maxBatchChars) {
            yield batch;
            batch = '';
        }
    }
    if (batch) {
        yield batch;
    }
}

/** zip/流式管道消费的 Buffer 版本（yazl 等下游只接受 Buffer 块）。 */
export function* jsonChunksAsBuffers(value: unknown, indent: number = 4): Generator<Buffer> {
    for (const chunk of jsonChunksBuffered(value, indent)) {
        yield Buffer.from(chunk, 'utf8');
    }
}

/**
 * 原子写出 JSON 文件：流式写入临时文件后 rename 覆盖目标，语义与 atomicWriteFile
 * 一致（瞬时锁错误有界退避重试，失败清理临时文件）。调用方负责确保父目录存在。
 */
const ATOMIC_WRITE_MAX_RETRIES = 5;
const ATOMIC_WRITE_RETRY_BASE_DELAY_MS = 10;

export async function atomicWriteJsonFile(filePath: string, value: unknown, indent: number = 4): Promise<void> {
    for (let attempt = 0; attempt < ATOMIC_WRITE_MAX_RETRIES; attempt++) {
        const tmpPath = buildAtomicWriteTmpPath(filePath);
        const output = fs.createWriteStream(tmpPath, { encoding: 'utf8' });
        try {
            await pipeline(Readable.from(jsonChunksBuffered(value, indent)), output);
            await fs.promises.rename(tmpPath, filePath);
            return;
        } catch (err) {
            // 写入失败时清理残留临时文件，避免垃圾文件堆积
            output.destroy();
            await fs.promises.unlink(tmpPath).catch(() => {});
            if (!isTransientFileLockError(err) || attempt === ATOMIC_WRITE_MAX_RETRIES - 1) {
                throw err;
            }
            await new Promise((resolve) =>
                setTimeout(resolve, ATOMIC_WRITE_RETRY_BASE_DELAY_MS * (attempt + 1) + Math.random() * 10)
            );
        }
    }
}

/**
 * 与 JSON.stringify 相同的前置处理：对象先调用 toJSON（Date → ISO 字符串等），
 * 结果可能仍是对象，继续解析直到出现纯值。JSON.stringify 会向 toJSON 传入键名，
 * 现有对象图中的实现（Date 等）均不依赖该参数，这里省略。
 */
function resolveToJson(value: unknown): unknown {
    let current = value;
    for (let hop = 0; hop < 100; hop++) {
        if (current === null || typeof current !== 'object') {
            return current;
        }
        const toJSON = (current as { toJSON?: () => unknown }).toJSON;
        if (typeof toJSON !== 'function') {
            return current;
        }
        current = toJSON.call(current);
    }
    return current;
}
