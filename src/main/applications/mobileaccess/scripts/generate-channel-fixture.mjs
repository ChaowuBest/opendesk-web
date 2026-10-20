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
 * 数据通道协议 6.3/6.4 的帧格式或边界值变化后，在本脚本中更新样本规则。
 * 从 OpenDesk 主仓根目录运行以下命令，重新生成 PC 端的 n3-channel-v1.json：
 *   node src/main/applications/mobileaccess/scripts/generate-channel-fixture.mjs
 * 如需同时生成手机端的相同样本，追加 --mobile-root /path/to/OpenDesk-Mobile/OpenDesk_Mobile，
 * 或设置 OPENDESK_MOBILE_ROOT。路径应指向包含 __tests__/remote 的目录。正常打包不会运行此脚本。
 */
import { writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

function mobileRoot() {
    const flag = process.argv.indexOf('--mobile-root');
    const value = flag >= 0 ? process.argv[flag + 1] : process.env.OPENDESK_MOBILE_ROOT;
    return value ? resolve(value) : null;
}

const enc = new TextEncoder();
const utf8 = (s) => enc.encode(s);
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

const LIMITS = {
    message_bytes: 67108864,
    frame_bytes: 262144,
    send_window_bytes: 4194304,
    peer_data_bytes: 4194304,
    peer_data_frames: 64,
    control_bytes: 131072,
    control_frames: 128,
    control_frame_bytes: 1024,
    raw_bridge_bytes: 4325376,
    raw_bridge_frames: 192,
    max_safe_integer: Number.MAX_SAFE_INTEGER
};

const serialize = (frame) => JSON.stringify(frame);
const byteLength = (frame) => utf8(serialize(frame)).length;
const dataHeaderBytes = (id, total, offset) => byteLength({ n3: 1, type: 'data', id, total, offset, data: '' });

/** Contract §3.3. Returns the exact block list for one message under a given frame cap. */
function chunk(text, id, frameCap) {
    const bytes = utf8(text);
    const total = bytes.length;
    const blocks = [];
    let offset = 0;
    while (offset < total) {
        const headerLen = dataHeaderBytes(id, total, offset);
        const b64Budget = frameCap - headerLen;
        if (b64Budget < 4) throw new Error(`frame cap ${frameCap} too small at offset ${offset}`);
        const maxB64 = Math.floor(b64Budget / 4) * 4;
        const maxRaw = (maxB64 / 4) * 3;
        const raw = Math.min(maxRaw, total - offset);
        const slice = bytes.subarray(offset, offset + raw);
        const frame = { n3: 1, type: 'data', id, total, offset, data: b64(slice) };
        const encoded = byteLength(frame);
        if (encoded > frameCap) throw new Error(`serialized ${encoded} exceeds cap ${frameCap}`);
        blocks.push({ frame, bytes: encoded, raw_bytes: raw });
        offset += raw;
    }
    return { total, blocks };
}

/** True when this block's own bytes are not standalone-decodable, i.e. a code point straddles it. */
const splitsCodePoint = (frame) => {
    const raw = Buffer.from(frame.data, 'base64');
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(raw);
        return false;
    } catch {
        return true;
    }
};

const chunkVector = (name, text, id, frameCap, note, { requireSplit = false } = {}) => {
    const { total, blocks } = chunk(text, id, frameCap);
    const split = blocks.some((b) => splitsCodePoint(b.frame));
    // A full block always carries maxB64/4*3 raw bytes, which is always a multiple of 3. Pure
    // 3-byte-per-character text therefore never straddles a boundary; the vector has to mix widths.
    if (requireSplit && !split) throw new Error(`${name}: no block splits a code point, so the vector proves nothing`);
    const rebuilt = Buffer.concat(blocks.map((b) => Buffer.from(b.frame.data, 'base64'))).toString('utf8');
    if (rebuilt !== text) throw new Error(`${name}: reassembly does not reproduce the message`);
    return {
        name,
        note,
        message: text,
        message_bytes: total,
        message_code_points: [...text].length,
        frame_cap: frameCap,
        id,
        splits_code_point: split,
        blocks: blocks.map((b) => ({
            frame: b.frame,
            serialized: serialize(b.frame),
            bytes: b.bytes,
            raw_bytes: b.raw_bytes,
            standalone_decodable: !splitsCodePoint(b.frame)
        }))
    };
};

// A frame cap of 80 leaves 80-60=20 b64 budget -> 20/4*4=20 b64 chars -> 15 raw bytes per block,
// which forces multi-byte characters to be split across blocks.
const CHUNKING = [
    chunkVector('single_block_ascii', 'hello', 1, 262144, '一条消息一块；最常见路径'),
    chunkVector('empty_is_invalid_guard', 'x', 1, 262144, 'total 最小合法值 1'),
    chunkVector(
        'chinese_across_blocks',
        'a中文消息跨越多个分片边界的测试向量',
        1,
        80,
        '前导 1 字节 ASCII 使 12 字节的满块与 3 字节汉字错位，汉字必然被切开',
        { requireSplit: true }
    ),
    chunkVector(
        'emoji_across_blocks',
        'ab👩‍💻🚀✅ mixed 中文 and ASCII 👨‍👩‍👧‍👦',
        2,
        80,
        '含 ZWJ 序列的 4 字节码点与组合字符跨块',
        { requireSplit: true }
    ),
    chunkVector('exact_multiple_of_three', 'abcdefghijklmnopqr', 3, 80, '原始字节数为 3 的倍数，Base64 无填充'),
    chunkVector('one_over_multiple', 'abcdefghijklmnopqrs', 4, 80, '余 1 字节，Base64 双 = 填充'),
    chunkVector('two_over_multiple', 'abcdefghijklmnopqrst', 5, 80, '余 2 字节，Base64 单 = 填充'),
    chunkVector(
        'tail_shorter_than_cap',
        '0123456789012345678901234567890123',
        6,
        80,
        '末块短于满块，b64Len = 4*ceil(raw/3)'
    )
];

// Frames at their measured minimum / maximum serialization sizes (contract §3.1).
const MAX_INT = Number.MAX_SAFE_INTEGER;
const CONTROL_FRAMES = [
    { name: 'probe_min', frame: { n3: 1, type: 'probe', id: 1 } },
    { name: 'probe_max', frame: { n3: 1, type: 'probe', id: MAX_INT } },
    { name: 'reply_min', frame: { n3: 1, type: 'reply', id: 1 } },
    { name: 'reply_max', frame: { n3: 1, type: 'reply', id: MAX_INT } },
    { name: 'consumed_min', frame: { n3: 1, type: 'consumed', seq: 1 } },
    { name: 'consumed_max', frame: { n3: 1, type: 'consumed', seq: MAX_INT } }
].map((entry) => ({ ...entry, serialized: serialize(entry.frame), bytes: byteLength(entry.frame) }));

// Reachable bounds under the contract limits: id may reach MAX_SAFE_INTEGER (16 digits) but total is
// capped at 64 MiB (8 digits) and offset at total-1, so (MAX_INT, MAX_INT, MAX_INT) is unreachable.
const MAX_OFFSET = LIMITS.message_bytes - 1;
const DATA_HEADER_BOUNDS = {
    min: { id: 1, total: 1, offset: 0, bytes: dataHeaderBytes(1, 1, 0) },
    max: {
        id: MAX_INT,
        total: LIMITS.message_bytes,
        offset: MAX_OFFSET,
        bytes: dataHeaderBytes(MAX_INT, LIMITS.message_bytes, MAX_OFFSET)
    },
    max_total_first_block: {
        id: 1,
        total: LIMITS.message_bytes,
        offset: 0,
        bytes: dataHeaderBytes(1, LIMITS.message_bytes, 0)
    }
};

// Raw strings so both ends can also exercise the parse-level rejection path.
// stage: 'decode'   -> 帧结构，decodeDataChannelFrame 返回 null
// stage: 'semantic'  -> 结构合法，由重组/容量检查按 reason 收敛
const INVALID_FRAMES = [
    {
        name: 'unknown_version',
        raw: '{"n3":2,"type":"data","id":1,"total":5,"offset":0,"data":"aGVsbG8="}',
        reason: 'invalid_frame',
        stage: 'decode'
    },
    {
        name: 'missing_n3',
        raw: '{"type":"data","id":1,"total":5,"offset":0,"data":"aGVsbG8="}',
        reason: 'invalid_frame',
        stage: 'decode'
    },
    {
        name: 'extra_field',
        raw: '{"n3":1,"type":"data","id":1,"total":5,"offset":0,"data":"aGVsbG8=","x":1}',
        reason: 'invalid_frame',
        stage: 'decode'
    },
    { name: 'unknown_type', raw: '{"n3":1,"type":"ping","id":1}', reason: 'invalid_frame', stage: 'decode' },
    {
        name: 'data_missing_field',
        raw: '{"n3":1,"type":"data","id":1,"total":5,"offset":0}',
        reason: 'invalid_frame',
        stage: 'decode'
    },
    {
        name: 'id_zero',
        raw: '{"n3":1,"type":"data","id":0,"total":5,"offset":0,"data":"aGVsbG8="}',
        reason: 'invalid_frame',
        stage: 'decode'
    },
    {
        name: 'id_negative',
        raw: '{"n3":1,"type":"data","id":-1,"total":5,"offset":0,"data":"aGVsbG8="}',
        reason: 'invalid_frame',
        stage: 'decode'
    },
    {
        name: 'id_fractional',
        raw: '{"n3":1,"type":"data","id":1.5,"total":5,"offset":0,"data":"aGVsbG8="}',
        reason: 'invalid_frame',
        stage: 'decode'
    },
    {
        name: 'id_unsafe',
        raw: '{"n3":1,"type":"data","id":9007199254740992,"total":5,"offset":0,"data":"aGVsbG8="}',
        reason: 'invalid_frame',
        stage: 'decode'
    },
    {
        name: 'id_string',
        raw: '{"n3":1,"type":"data","id":"1","total":5,"offset":0,"data":"aGVsbG8="}',
        reason: 'invalid_frame',
        stage: 'decode'
    },
    {
        name: 'id_boolean',
        raw: '{"n3":1,"type":"data","id":true,"total":5,"offset":0,"data":"aGVsbG8="}',
        reason: 'invalid_frame',
        stage: 'decode'
    },
    {
        name: 'offset_negative',
        raw: '{"n3":1,"type":"data","id":1,"total":5,"offset":-1,"data":"aGVsbG8="}',
        reason: 'invalid_frame',
        stage: 'decode'
    },
    {
        name: 'total_zero',
        raw: '{"n3":1,"type":"data","id":1,"total":0,"offset":0,"data":"aGVsbG8="}',
        reason: 'invalid_frame',
        stage: 'decode'
    },
    {
        name: 'total_over_limit',
        raw: `{"n3":1,"type":"data","id":1,"total":${LIMITS.message_bytes + 1},"offset":0,"data":"aGVsbG8="}`,
        reason: 'message_too_large',
        stage: 'semantic'
    },
    {
        name: 'data_empty',
        raw: '{"n3":1,"type":"data","id":1,"total":5,"offset":0,"data":""}',
        reason: 'invalid_frame',
        stage: 'decode'
    },
    {
        name: 'data_not_multiple_of_four',
        raw: '{"n3":1,"type":"data","id":1,"total":5,"offset":0,"data":"aGVsbG8"}',
        reason: 'invalid_frame',
        stage: 'decode'
    },
    {
        name: 'data_url_safe_alphabet',
        raw: '{"n3":1,"type":"data","id":1,"total":3,"offset":0,"data":"-_8="}',
        reason: 'invalid_frame',
        stage: 'decode'
    },
    {
        name: 'data_non_canonical_padding_bits',
        raw: '{"n3":1,"type":"data","id":1,"total":1,"offset":0,"data":"AB=="}',
        reason: 'invalid_frame',
        stage: 'semantic'
    },
    {
        name: 'data_whitespace',
        raw: '{"n3":1,"type":"data","id":1,"total":5,"offset":0,"data":"aGVs bG8="}',
        reason: 'invalid_frame',
        stage: 'decode'
    },
    {
        name: 'probe_extra_field',
        raw: '{"n3":1,"type":"probe","id":1,"seq":1}',
        reason: 'invalid_frame',
        stage: 'decode'
    },
    { name: 'consumed_wrong_key', raw: '{"n3":1,"type":"consumed","id":1}', reason: 'invalid_frame', stage: 'decode' },
    { name: 'consumed_seq_zero', raw: '{"n3":1,"type":"consumed","seq":0}', reason: 'invalid_frame', stage: 'decode' },
    { name: 'not_an_object', raw: '[1,2,3]', reason: 'invalid_frame', stage: 'decode' },
    { name: 'malformed_json', raw: '{"n3":1,', reason: 'invalid_frame', stage: 'decode' }
];

// Sequencing counter-examples consumed by the reassembly tests (contract §3.4 step 5).
const SEQUENCING = [
    {
        name: 'wrong_first_offset',
        note: '新消息的首块 offset 必须为 0',
        frames: [{ n3: 1, type: 'data', id: 1, total: 10, offset: 3, data: b64(utf8('abc')) }],
        reject_at: 0,
        reason: 'invalid_frame'
    },
    {
        name: 'skipped_message_id',
        note: 'id 必须是期望的下一序号',
        frames: [{ n3: 1, type: 'data', id: 2, total: 5, offset: 0, data: b64(utf8('hello')) }],
        reject_at: 0,
        reason: 'invalid_frame'
    },
    {
        name: 'offset_gap',
        note: '后续块 offset 必须精确等于已收字节数',
        frames: [
            { n3: 1, type: 'data', id: 1, total: 10, offset: 0, data: b64(utf8('abc')) },
            { n3: 1, type: 'data', id: 1, total: 10, offset: 4, data: b64(utf8('efg')) }
        ],
        reject_at: 1,
        reason: 'invalid_frame'
    },
    {
        name: 'duplicate_block',
        note: '重复数据片不接受',
        frames: [
            { n3: 1, type: 'data', id: 1, total: 10, offset: 0, data: b64(utf8('abc')) },
            { n3: 1, type: 'data', id: 1, total: 10, offset: 0, data: b64(utf8('abc')) }
        ],
        reject_at: 1,
        reason: 'invalid_frame'
    },
    {
        name: 'total_changed_mid_message',
        note: '后续块 total 必须与当前重组一致',
        frames: [
            { n3: 1, type: 'data', id: 1, total: 10, offset: 0, data: b64(utf8('abc')) },
            { n3: 1, type: 'data', id: 1, total: 11, offset: 3, data: b64(utf8('def')) }
        ],
        reject_at: 1,
        reason: 'invalid_frame'
    },
    {
        name: 'interleaved_other_message',
        note: '不接受混入另一条消息的分片',
        frames: [
            { n3: 1, type: 'data', id: 1, total: 10, offset: 0, data: b64(utf8('abc')) },
            { n3: 1, type: 'data', id: 2, total: 5, offset: 0, data: b64(utf8('hello')) }
        ],
        reject_at: 1,
        reason: 'invalid_frame'
    },
    {
        name: 'exceeds_declared_total',
        note: '解码后不得超过剩余总长',
        frames: [{ n3: 1, type: 'data', id: 1, total: 4, offset: 0, data: b64(utf8('abcdef')) }],
        reject_at: 0,
        reason: 'invalid_frame'
    },
    {
        name: 'invalid_utf8_on_completion',
        note: '精确收齐但整体不是合法 UTF-8',
        frames: [{ n3: 1, type: 'data', id: 1, total: 2, offset: 0, data: b64(Uint8Array.from([0xc3, 0x28])) }],
        reject_at: 0,
        reason: 'invalid_frame'
    },
    {
        name: 'control_interleaved_with_data',
        note: '控制帧可穿插在尚未提交的块之间，不打断重组',
        frames: [
            { n3: 1, type: 'data', id: 1, total: 6, offset: 0, data: b64(utf8('abc')) },
            { n3: 1, type: 'probe', id: 1 },
            { n3: 1, type: 'consumed', seq: 1 },
            { n3: 1, type: 'data', id: 1, total: 6, offset: 3, data: b64(utf8('def')) }
        ],
        reject_at: null,
        delivers: 'abcdef'
    },
    {
        name: 'two_messages_sequential',
        note: '期望接收序号只在完整消息交付后才递增',
        frames: [
            { n3: 1, type: 'data', id: 1, total: 3, offset: 0, data: b64(utf8('abc')) },
            { n3: 1, type: 'data', id: 2, total: 3, offset: 0, data: b64(utf8('def')) }
        ],
        reject_at: null,
        delivers_all: ['abc', 'def']
    }
];

const fixture = {
    fixture_revision: 1,
    version: 1,
    synthetic: true,
    note: '维护源为 PC src/tests/ut/node/remote-access/fixtures/n3-channel-v1.json；Mobile 持相同副本。与 N2 remote-network-v1.json 分开，不改其 revision。',
    limits: LIMITS,
    data_header_bytes: DATA_HEADER_BOUNDS,
    control_frames: CONTROL_FRAMES,
    chunking: CHUNKING,
    sequencing: SEQUENCING,
    invalid_frames: INVALID_FRAMES
};

const json = JSON.stringify(fixture, null, 2) + '\n';
const mobile = mobileRoot();
if (mobile && !existsSync(mobile)) {
    console.error(`mobile root does not exist: ${mobile}`);
    process.exit(2);
}
const targets = [join(REPO_ROOT, 'src/tests/ut/node/remote-access/fixtures/n3-channel-v1.json')];
if (mobile) targets.push(join(mobile, '__tests__/remote/fixtures/n3-channel-v1.json'));
else console.log('skipped the Mobile copy: pass --mobile-root or set OPENDESK_MOBILE_ROOT');
for (const target of targets) {
    writeFileSync(target, json);
    console.log('wrote', target, json.length, 'bytes');
}
console.log('chunking vectors:', CHUNKING.length);
console.log('sequencing vectors:', SEQUENCING.length);
console.log('invalid frames:', INVALID_FRAMES.length);
for (const v of CHUNKING) console.log(' ', v.name, `${v.message_bytes}B ->`, v.blocks.length, 'blocks');
