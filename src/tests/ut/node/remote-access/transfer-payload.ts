/**
 * 大消息载荷的构造与核对（test-only）。
 *
 * 手机侧 `__tests__/native/transfer-payload.js` 必须与本文件**逐字同算法**：
 * 发送方声明 `bytes` / `checksum`，接收方对实际收到的正文**重新计算**后比对，
 * 两边实现若有差异会直接判失败，不会静默通过。
 *
 * 校验和不是密码学摘要，只用于判定「同一串字节、同一顺序」：
 * 两个累加器都对位置敏感，少字节、改内容、分片重排都会改变结果。
 * 另有与校验和互相独立的块标记顺序核对，见 `inspectPayload`。
 */

/** 每个块开头写 `#<8 位十六进制块号>#`，其余为伪随机十六进制字符。 */
export const PAYLOAD_BLOCK_BYTES = 65536;
const MARKER_BYTES = 10;

export function checksumHex(text: string): string {
    let h1 = 0x811c9dc5 >>> 0;
    let h2 = 0x9e3779b9 >>> 0;
    for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
        h2 = (Math.imul(h2 + code, 0x85ebca6b) ^ (h2 >>> 13)) >>> 0;
    }
    return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

const HEX = '0123456789abcdef';

/** 生成 `bytes` 个单字节字符；全部取自十六进制字母表与 `#`，UTF-8 下字节数等于字符数。 */
export function buildPayload(seed: number, bytes: number): string {
    const parts: string[] = [];
    let produced = 0;
    let block = 0;
    while (produced < bytes) {
        const size = Math.min(PAYLOAD_BLOCK_BYTES, bytes - produced);
        const chars = new Array<string>(size);
        let cursor = 0;
        if (size >= MARKER_BYTES) {
            const marker = `#${(block >>> 0).toString(16).padStart(8, '0')}#`;
            for (; cursor < MARKER_BYTES; cursor += 1) chars[cursor] = marker[cursor];
        }
        let state = (Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(block + 1, 0x27d4eb2f)) >>> 0;
        if (state === 0) state = 0x1234567;
        for (; cursor < size; cursor += 1) {
            state ^= state << 13;
            state >>>= 0;
            state ^= state >>> 17;
            state ^= state << 5;
            state >>>= 0;
            chars[cursor] = HEX[state & 0xf];
        }
        parts.push(chars.join(''));
        produced += size;
        block += 1;
    }
    return parts.join('');
}

export interface PayloadInspection {
    bytes: number;
    checksum: string;
    /** 块标记是否按 0,1,2,… 连续且落在预期偏移上；与校验和互相独立。 */
    blocksOrdered: boolean;
    blocks: number;
    firstBadBlock: number | null;
}

export function inspectPayload(text: string): PayloadInspection {
    let blocksOrdered = true;
    let firstBadBlock: number | null = null;
    let blocks = 0;
    for (let offset = 0; offset < text.length; offset += PAYLOAD_BLOCK_BYTES) {
        if (text.length - offset < MARKER_BYTES) break;
        const expected = `#${(blocks >>> 0).toString(16).padStart(8, '0')}#`;
        if (text.slice(offset, offset + MARKER_BYTES) !== expected) {
            blocksOrdered = false;
            if (firstBadBlock === null) firstBadBlock = blocks;
        }
        blocks += 1;
    }
    return { bytes: text.length, checksum: checksumHex(text), blocksOrdered, blocks, firstBadBlock };
}
