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

/**
 * Web 模式 IPC 编解码：把 Electron IPC（结构化克隆）能传、JSON 不能传的值
 * 编码成带标记的普通对象，main 与浏览器两端共用。
 *
 * 覆盖 IPC 实际会出现的类型：undefined、NaN/±Infinity、BigInt、Date、RegExp、
 * Error、Map、Set、ArrayBuffer 与各类 TypedArray（含 Node Buffer，按 Uint8Array 传，
 * 与 Electron 把 Buffer 送到 renderer 后的形态一致）。函数与 Symbol 与结构化克隆
 * 一样无法传递，编码时丢弃；循环引用编码为 undefined。
 */

const TAG = '__odipc';

type Tagged = { [TAG]: string; v?: unknown; [key: string]: unknown };

const TYPED_ARRAYS: Record<string, new (buffer: ArrayBuffer) => ArrayBufferView> = {
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    BigInt64Array,
    BigUint64Array
};

function bytesToBase64(bytes: Uint8Array): string {
    const NodeBuffer = (globalThis as { Buffer?: typeof Buffer }).Buffer;
    if (NodeBuffer) return NodeBuffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
    const NodeBuffer = (globalThis as { Buffer?: typeof Buffer }).Buffer;
    if (NodeBuffer) {
        const buf = NodeBuffer.from(base64, 'base64');
        // 拷贝出独立的 ArrayBuffer：Buffer 可能是共享池切片
        return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    }
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function typedArrayName(value: ArrayBufferView): string {
    // Node Buffer 是 Uint8Array 子类，按 Uint8Array 传
    if (value instanceof Uint8Array) return 'Uint8Array';
    const name = value.constructor?.name;
    return name && name in TYPED_ARRAYS ? name : 'Uint8Array';
}

function encodeInner(value: unknown, path: Set<object>): unknown {
    if (value === undefined) return { [TAG]: 'u' };
    if (value === null) return null;
    switch (typeof value) {
        case 'string':
        case 'boolean':
            return value;
        case 'number':
            return Number.isFinite(value) ? value : { [TAG]: 'n', v: String(value) };
        case 'bigint':
            return { [TAG]: 'bi', v: value.toString() };
        case 'function':
        case 'symbol':
            return { [TAG]: 'u' };
    }

    const obj = value as object;
    if (path.has(obj)) return { [TAG]: 'u' };

    if (obj instanceof Date) return { [TAG]: 'd', v: obj.getTime() };
    if (obj instanceof RegExp) return { [TAG]: 're', v: obj.source, f: obj.flags };
    if (obj instanceof ArrayBuffer) return { [TAG]: 'ab', v: bytesToBase64(new Uint8Array(obj)) };
    if (ArrayBuffer.isView(obj)) {
        if (obj instanceof DataView) {
            return { [TAG]: 'ab', v: bytesToBase64(new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength)) };
        }
        const bytes = new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength);
        return { [TAG]: 'ta', k: typedArrayName(obj), v: bytesToBase64(bytes) };
    }

    path.add(obj);
    try {
        if (obj instanceof Error) {
            const extra: Record<string, unknown> = {};
            for (const key of Object.keys(obj)) extra[key] = encodeInner((obj as never)[key], path);
            return { [TAG]: 'err', name: obj.name, message: obj.message, stack: obj.stack, v: extra };
        }
        if (obj instanceof Map) {
            return {
                [TAG]: 'map',
                v: [...obj.entries()].map(([k, v]) => [encodeInner(k, path), encodeInner(v, path)])
            };
        }
        if (obj instanceof Set) return { [TAG]: 'set', v: [...obj].map((v) => encodeInner(v, path)) };
        if (Array.isArray(obj)) return obj.map((v) => encodeInner(v, path));

        const out: Record<string, unknown> = {};
        for (const key of Object.keys(obj)) {
            const item = (obj as Record<string, unknown>)[key];
            // 结构化克隆丢弃函数属性会直接报错，这里与 JSON 一致静默跳过
            if (typeof item === 'function' || typeof item === 'symbol') continue;
            out[key] = encodeInner(item, path);
        }
        // 业务对象恰好带有标记键时整体包一层，解码时原样还原
        return TAG in out ? { [TAG]: 'o', v: out } : out;
    } finally {
        path.delete(obj);
    }
}

export function encodeIpcValue(value: unknown): unknown {
    return encodeInner(value, new Set());
}

function decodeObject(obj: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) out[key] = decodeIpcValue(obj[key]);
    return out;
}

export function decodeIpcValue(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(decodeIpcValue);

    const tagged = value as Tagged;
    const tag = tagged[TAG];
    if (typeof tag !== 'string') return decodeObject(value as Record<string, unknown>);

    switch (tag) {
        case 'u':
            return undefined;
        case 'n':
            return Number(tagged.v);
        case 'bi':
            return BigInt(tagged.v as string);
        case 'd':
            return new Date(tagged.v as number);
        case 're':
            return new RegExp(tagged.v as string, tagged.f as string);
        case 'ab': {
            const bytes = base64ToBytes(tagged.v as string);
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        }
        case 'ta': {
            const bytes = base64ToBytes(tagged.v as string);
            const Ctor = TYPED_ARRAYS[tagged.k as string] ?? Uint8Array;
            if (Ctor === Uint8Array) return bytes;
            return new Ctor(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
        }
        case 'err': {
            const error = new Error(tagged.message as string);
            error.name = tagged.name as string;
            if (typeof tagged.stack === 'string') error.stack = tagged.stack;
            Object.assign(error, decodeObject((tagged.v as Record<string, unknown>) ?? {}));
            return error;
        }
        case 'map':
            return new Map((tagged.v as [unknown, unknown][]).map(([k, v]) => [decodeIpcValue(k), decodeIpcValue(v)]));
        case 'set':
            return new Set((tagged.v as unknown[]).map(decodeIpcValue));
        case 'o':
            return decodeObject(tagged.v as Record<string, unknown>);
        default:
            return decodeObject(value as Record<string, unknown>);
    }
}
