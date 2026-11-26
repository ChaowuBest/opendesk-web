import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PAYLOAD_BLOCK_BYTES, buildPayload, checksumHex, inspectPayload } from './transfer-payload.js';

// 载荷构造与校验是两端共用的传输判据来源（Mobile 侧副本为 __tests__/native/transfer-payload.js）。
// 旧的 PC 侧联调入口删除后，这里把算法不变量锁成正式回归，避免它退化成没人验证的死代码。

test('a payload is deterministic, byte-counted and block-ordered', () => {
    const bytes = PAYLOAD_BLOCK_BYTES * 2 + 12345;
    const payload = buildPayload(7, bytes);

    assert.equal(payload.length, bytes);
    assert.equal(payload, buildPayload(7, bytes), 'the same seed must reproduce the same payload');
    assert.notEqual(payload, buildPayload(8, bytes), 'a different seed must change the payload');
    // 单字节字符集：UTF-8 下字节数等于字符数，接收端才能用长度当字节判据。
    assert.match(payload, /^[0-9a-f#]+$/);

    const inspection = inspectPayload(payload);
    assert.equal(inspection.bytes, bytes);
    assert.equal(inspection.blocks, 3);
    assert.equal(inspection.blocksOrdered, true);
    assert.equal(inspection.firstBadBlock, null);
    assert.equal(inspection.checksum, checksumHex(payload));
});

test('reordered or altered blocks are reported instead of passing silently', () => {
    const payload = buildPayload(3, PAYLOAD_BLOCK_BYTES * 3);
    const blocks = [
        payload.slice(0, PAYLOAD_BLOCK_BYTES),
        payload.slice(PAYLOAD_BLOCK_BYTES, PAYLOAD_BLOCK_BYTES * 2),
        payload.slice(PAYLOAD_BLOCK_BYTES * 2)
    ];

    const swapped = inspectPayload([blocks[0], blocks[2], blocks[1]].join(''));
    assert.equal(swapped.blocksOrdered, false);
    assert.equal(swapped.firstBadBlock, 1);
    assert.equal(swapped.bytes, payload.length);

    // 顺序与校验和互相独立：改一个字符不动块标记，顺序仍成立但校验和必须变。
    const altered = `${payload.slice(0, -1)}${payload.endsWith('f') ? '0' : 'f'}`;
    const alteredInspection = inspectPayload(altered);
    assert.equal(alteredInspection.blocksOrdered, true);
    assert.notEqual(alteredInspection.checksum, inspectPayload(payload).checksum);
});

test('a payload shorter than one block carries no marker and still checksums', () => {
    const tiny = buildPayload(1, 4);
    assert.equal(tiny.length, 4);
    const inspection = inspectPayload(tiny);
    assert.equal(inspection.blocks, 0);
    assert.equal(inspection.blocksOrdered, true);
    assert.equal(inspection.checksum, checksumHex(tiny));
});

test(
    'the Mobile copy keeps the same block size and marker contract',
    { skip: !process.env.OPENDESK_MOBILE_REPO },
    () => {
        const mobileCopy = join(process.env.OPENDESK_MOBILE_REPO!, '__tests__/native/transfer-payload.js');
        assert.equal(existsSync(mobileCopy), true, `the Mobile payload copy is missing: ${mobileCopy}`);
        const source = readFileSync(mobileCopy, 'utf8');
        assert.match(source, new RegExp(`PAYLOAD_BLOCK_BYTES\\s*=\\s*${PAYLOAD_BLOCK_BYTES}`));
        assert.match(source, /padStart\(8, '0'\)/);
    }
);
