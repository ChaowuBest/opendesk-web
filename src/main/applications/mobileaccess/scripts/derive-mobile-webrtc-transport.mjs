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
 * 两端共用的 WebRTC 数据通道规则在 ../remote-access/webrtc-transport.ts 维护。
 * 修改规则后，在 OpenDesk 主仓根目录运行以下命令，把规则同步到手机端，保留手机专用的适配代码：
 *   node src/main/applications/mobileaccess/scripts/derive-mobile-webrtc-transport.mjs --mobile-root /path/to/OpenDesk-Mobile/OpenDesk_Mobile
 * --mobile-root 指向包含 src/features/remote 的目录，也可用环境变量 OPENDESK_MOBILE_ROOT 指定。
 * 同步后在该目录运行 npx prettier --write src/features/remote/connection/webrtc-transport.ts。
 * 正常打包不会运行此脚本。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const applicationDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const mobileRootFlag = process.argv.indexOf('--mobile-root');
const mobileRootValue = mobileRootFlag >= 0 ? process.argv[mobileRootFlag + 1] : process.env.OPENDESK_MOBILE_ROOT;
if (!mobileRootValue) {
    console.error('missing the Mobile root: pass --mobile-root <path> or set OPENDESK_MOBILE_ROOT');
    process.exit(2);
}
const MOBILE_ROOT = resolve(mobileRootValue);
if (!existsSync(MOBILE_ROOT)) {
    console.error(`mobile root does not exist: ${MOBILE_ROOT}`);
    process.exit(2);
}

const PC = join(applicationDir, 'remote-access/webrtc-transport.ts');
const MOBILE = join(MOBILE_ROOT, 'src/features/remote/connection/webrtc-transport.ts');

const source = readFileSync(PC, 'utf8');

// 1. 切掉 PC 的协议头与 import，保留从 DATA_CHANNEL_LIMITS 开始的协议核心。
const coreStart = source.indexOf('/** 全部为编码字节');
if (coreStart < 0) throw new Error('找不到协议核心的起点');
// Electron 宿主桥是 PC 专有的，不能派生到 Mobile；两端共享的纯函数都在它之前。
const coreEnd = source.indexOf(
    '// ===========================================================================\n// Electron 宿主桥：main 侧'
);
if (coreEnd < 0) throw new Error('找不到协议核心的终点（Electron 宿主桥分界）');
const core = source.slice(coreStart, coreEnd);

// 2. 只替换上层适配类型；其余逻辑逐字保留。
const substitutions = [
    [/AcpMessageChannel/g, 'AcpTextMessagePort'],
    // PC 用 Buffer（Node）；RN 没有 Buffer，改用同语义的纯 JS 实现。
    [
        /function decodeCanonicalBase64\(value: string\): Uint8Array \| null \{[\s\S]*?\n\}/,
        `function decodeCanonicalBase64(value: string): Uint8Array | null {
    if (value.length === 0 || value.length % 4 !== 0 || !BASE64_ALPHABET.test(value)) return null;
    let bytes: Uint8Array;
    try {
        bytes = base64ToBytes(value);
    } catch {
        return null;
    }
    if (bytes.length === 0) return null;
    if (bytesToBase64(bytes) !== value) return null;
    return bytes;
}`
    ],
    [
        /export function encodeBase64\(bytes: Uint8Array\): string \{\n {4}return Buffer\.from\(bytes\)\.toString\('base64'\);\n\}/,
        `export function encodeBase64(bytes: Uint8Array): string {
    return bytesToBase64(bytes);
}`
    ],
    // RN/Hermes 没有 TextDecoder（TextEncoder 有）。这里换成同语义的严格解码器：
    // 任何非法 UTF-8 抛错，与 PC 的 { fatal: true } 一致。
    [
        /const strictDecoder = new TextDecoder\('utf-8', \{ fatal: true \}\);/,
        `const strictDecoder = { decode: decodeStrictUtf8 };`
    ]
];

let body = core;
for (const [pattern, replacement] of substitutions) {
    const before = body;
    body = body.replace(pattern, replacement);
    if (body === before) throw new Error(`替换未命中: ${pattern}`);
}

if (/\bBuffer\b/.test(body)) throw new Error('派生结果仍引用 Node 的 Buffer');
if (/\bTextDecoder\b/.test(body)) throw new Error('派生结果仍引用 RN 没有的 TextDecoder');

const header = `/**
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
 * 远程网络数据通道（RN 侧）：n3-channel-v1 封装、分片重组、跨端消费回报、存活探测与关闭收敛。
 *
 * 本文件的协议核心由 PC 的
 * \`src/main/applications/mobileaccess/remote-access/webrtc-transport.ts\` 机械派生，两端逐字一致，
 * 只有上层适配类型（AcpTextMessagePort）与 Base64 实现不同（RN 无 Node Buffer）。
 * 共同的边界向量在 \`__tests__/remote/fixtures/n3-channel-v1.json\`，与 PC 副本逐字节相同。
 * 不要只改一端：协议语义的修改必须回到 PC 维护源，再重新派生。
 */

import type { AcpTextMessagePort } from '../acp/port';

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** RN 没有 Node 的 Buffer，也不能依赖 atob/btoa 的二进制安全性，这里按字节直接实现。 */
function bytesToBase64(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i];
        const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
        const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
        out += BASE64_CHARS[b0 >> 2];
        out += BASE64_CHARS[((b0 & 3) << 4) | (b1 >> 4)];
        out += i + 1 < bytes.length ? BASE64_CHARS[((b1 & 15) << 2) | (b2 >> 6)] : '=';
        out += i + 2 < bytes.length ? BASE64_CHARS[b2 & 63] : '=';
    }
    return out;
}

/**
 * RN/Hermes 没有 TextDecoder，这里按字节严格解码 UTF-8：过长编码、代理区码点、
 * 超出 U+10FFFF、截断序列和游离续字节一律抛错，等价于 PC 侧的 { fatal: true }。
 */
function decodeStrictUtf8(bytes: Uint8Array): string {
    const parts: string[] = [];
    let units: number[] = [];
    let index = 0;
    while (index < bytes.length) {
        const lead = bytes[index];
        let codePoint: number;
        let size: number;
        if (lead < 0x80) {
            codePoint = lead;
            size = 1;
        } else if (lead >= 0xc2 && lead <= 0xdf) {
            codePoint = lead & 0x1f;
            size = 2;
        } else if (lead >= 0xe0 && lead <= 0xef) {
            codePoint = lead & 0x0f;
            size = 3;
        } else if (lead >= 0xf0 && lead <= 0xf4) {
            codePoint = lead & 0x07;
            size = 4;
        } else {
            throw new TypeError('invalid utf-8');
        }
        if (index + size > bytes.length) throw new TypeError('invalid utf-8');
        for (let offset = 1; offset < size; offset += 1) {
            const next = bytes[index + offset];
            if ((next & 0xc0) !== 0x80) throw new TypeError('invalid utf-8');
            codePoint = (codePoint << 6) | (next & 0x3f);
        }
        // 过长编码与非法码点。
        if (size === 3 && codePoint < 0x800) throw new TypeError('invalid utf-8');
        if (size === 4 && codePoint < 0x10000) throw new TypeError('invalid utf-8');
        if (codePoint > 0x10ffff) throw new TypeError('invalid utf-8');
        if (codePoint >= 0xd800 && codePoint <= 0xdfff) throw new TypeError('invalid utf-8');
        if (codePoint <= 0xffff) {
            units.push(codePoint);
        } else {
            const rest = codePoint - 0x10000;
            units.push(0xd800 + (rest >> 10), 0xdc00 + (rest & 0x3ff));
        }
        // 分段拼接，避免 64 MiB 消息一次性展开成一个巨大的参数列表。
        if (units.length >= 4096) {
            parts.push(String.fromCharCode.apply(null, units));
            units = [];
        }
        index += size;
    }
    if (units.length > 0) parts.push(String.fromCharCode.apply(null, units));
    return parts.join('');
}

function base64ToBytes(value: string): Uint8Array {
    const clean = value.endsWith('==') ? value.slice(0, -2) : value.endsWith('=') ? value.slice(0, -1) : value;
    const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let outIndex = 0;
    let accumulator = 0;
    let bits = 0;
    for (const character of clean) {
        const index = BASE64_CHARS.indexOf(character);
        if (index < 0) throw new Error('invalid base64');
        accumulator = (accumulator << 6) | index;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[outIndex++] = (accumulator >> bits) & 0xff;
        }
    }
    return out.subarray(0, outIndex);
}

`;

// 分界标记：标记以上是机械派生的协议核心（不可手改），以下是手写的 RN 平台适配。
// 重新派生时只重写标记以上，标记以下原样保留——这样一个文件里既能防漂移，
// 又不需要为平台代码另开一个文件（Plan §3.1 的 Mobile 行只列了这一个文件）。
const MARKER =
    '// ===== 以上为从 PC 维护源机械派生的协议核心，请勿手改 =====\n' +
    '// ===== 以下为手写的 RN 平台适配，重新派生时原样保留 =====\n';

let eol = '\n';
let tail = Buffer.alloc(0);
if (existsSync(MOBILE)) {
    const current = readFileSync(MOBILE);
    const matches = [];
    for (const newline of ['\n', '\r\n']) {
        const marker = Buffer.from(MARKER.replaceAll('\n', newline));
        let start = current.indexOf(marker);
        while (start >= 0) {
            if (start === 0 || current[start - 1] === 0x0a) matches.push({ newline, end: start + marker.length });
            start = current.indexOf(marker, start + marker.length);
        }
    }
    if (matches.length !== 1) {
        throw new Error(`需要唯一的手写适配分界标记，找到 ${matches.length} 处，已保留原文件：${MOBILE}`);
    }
    eol = matches[0].newline;
    tail = current.subarray(matches[0].end);
}

const generated = (header + body + '\n' + MARKER).replace(/\r?\n/g, eol);
writeFileSync(MOBILE, Buffer.concat([Buffer.from(generated), tail]));
console.log('wrote', MOBILE);
console.log('核心行数:', body.split('\n').length, ' 保留的适配字节数:', tail.length);
