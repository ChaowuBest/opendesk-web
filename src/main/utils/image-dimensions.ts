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
 * 从图片文件头解析像素尺寸（不依赖解码器、不分配位图）。
 *
 * 用于在交给 jimp/sharp 等解码器之前做像素上限判断：压缩炸弹类图片（文件字节很小、
 * 声明尺寸巨大）一旦进入解码就会按 width*height*4 分配位图，直接触发 V8 OOM。
 * 支持 PNG / JPEG / GIF / BMP / TIFF / WebP；无法识别时返回 undefined（调用方自行决定
 * 是保守拒绝还是放行）。逻辑自 filemgr 的图片处理抽取，供多处共用。
 */

export interface ImageDimensions {
    width: number;
    height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPngDimensions(input: Buffer): ImageDimensions | undefined {
    if (
        input.length < 24 ||
        !input.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
        input.toString('ascii', 12, 16) !== 'IHDR' ||
        input.readUInt32BE(8) !== 13
    ) {
        return undefined;
    }
    return {
        width: input.readUInt32BE(16),
        height: input.readUInt32BE(20)
    };
}

function isJpegStartOfFrame(marker: number): boolean {
    return (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
    );
}

function readJpegDimensions(input: Buffer): ImageDimensions | undefined {
    if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) {
        return undefined;
    }

    let offset = 2;
    while (offset < input.length) {
        if (input[offset] !== 0xff) {
            return undefined;
        }
        while (offset < input.length && input[offset] === 0xff) {
            offset++;
        }
        if (offset >= input.length) {
            return undefined;
        }

        const marker = input[offset++];
        if (marker === 0xd9 || marker === 0xda) {
            return undefined;
        }
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
            continue;
        }
        if (offset + 2 > input.length) {
            return undefined;
        }

        const segmentLength = input.readUInt16BE(offset);
        if (segmentLength < 2 || offset + segmentLength > input.length) {
            return undefined;
        }
        if (isJpegStartOfFrame(marker)) {
            if (segmentLength < 7) {
                return undefined;
            }
            return {
                width: input.readUInt16BE(offset + 5),
                height: input.readUInt16BE(offset + 3)
            };
        }
        offset += segmentLength;
    }
    return undefined;
}

function readUInt24LE(input: Buffer, offset: number): number {
    return input[offset] | (input[offset + 1] << 8) | (input[offset + 2] << 16);
}

function readWebpDimensions(input: Buffer): ImageDimensions | undefined {
    if (input.length < 20 || input.toString('ascii', 0, 4) !== 'RIFF' || input.toString('ascii', 8, 12) !== 'WEBP') {
        return undefined;
    }

    const riffEnd = input.readUInt32LE(4) + 8;
    if (riffEnd > input.length || riffEnd < 20) {
        return undefined;
    }

    let offset = 12;
    while (offset + 8 <= riffEnd) {
        const chunkType = input.toString('ascii', offset, offset + 4);
        const chunkLength = input.readUInt32LE(offset + 4);
        const payloadOffset = offset + 8;
        const chunkEnd = payloadOffset + chunkLength;
        if (chunkEnd > riffEnd) {
            return undefined;
        }

        if (chunkType === 'VP8X' && chunkLength >= 10) {
            return {
                width: readUInt24LE(input, payloadOffset + 4) + 1,
                height: readUInt24LE(input, payloadOffset + 7) + 1
            };
        }
        if (
            chunkType === 'VP8 ' &&
            chunkLength >= 10 &&
            input[payloadOffset + 3] === 0x9d &&
            input[payloadOffset + 4] === 0x01 &&
            input[payloadOffset + 5] === 0x2a
        ) {
            return {
                width: input.readUInt16LE(payloadOffset + 6) & 0x3fff,
                height: input.readUInt16LE(payloadOffset + 8) & 0x3fff
            };
        }
        if (chunkType === 'VP8L' && chunkLength >= 5 && input[payloadOffset] === 0x2f) {
            const bits = input.readUInt32LE(payloadOffset + 1);
            return {
                width: (bits & 0x3fff) + 1,
                height: ((bits >>> 14) & 0x3fff) + 1
            };
        }

        offset = chunkEnd + (chunkLength % 2);
    }
    return undefined;
}

function readBmpDimensions(input: Buffer): ImageDimensions | undefined {
    if (input.length < 26 || input.toString('ascii', 0, 2) !== 'BM') {
        return undefined;
    }

    const dibHeaderSize = input.readUInt32LE(14);
    if (dibHeaderSize === 12) {
        return {
            width: input.readUInt16LE(18),
            height: input.readUInt16LE(20)
        };
    }
    if (dibHeaderSize < 40) {
        return undefined;
    }
    return {
        width: Math.abs(input.readInt32LE(18)),
        height: Math.abs(input.readInt32LE(22))
    };
}

function readGifDimensions(input: Buffer): ImageDimensions | undefined {
    const signature = input.toString('ascii', 0, 6);
    if (input.length < 10 || (signature !== 'GIF87a' && signature !== 'GIF89a')) {
        return undefined;
    }
    return {
        width: input.readUInt16LE(6),
        height: input.readUInt16LE(8)
    };
}

function readTiffDimensions(input: Buffer): ImageDimensions | undefined {
    if (input.length < 8) {
        return undefined;
    }

    const byteOrder = input.toString('ascii', 0, 2);
    const littleEndian = byteOrder === 'II';
    if (!littleEndian && byteOrder !== 'MM') {
        return undefined;
    }

    const readUInt16 = (offset: number): number =>
        littleEndian ? input.readUInt16LE(offset) : input.readUInt16BE(offset);
    const readUInt32 = (offset: number): number =>
        littleEndian ? input.readUInt32LE(offset) : input.readUInt32BE(offset);
    if (readUInt16(2) !== 42) {
        return undefined;
    }

    const ifdOffset = readUInt32(4);
    if (ifdOffset + 2 > input.length) {
        return undefined;
    }

    const entryCount = readUInt16(ifdOffset);
    let width: number | undefined;
    let height: number | undefined;
    for (let index = 0; index < entryCount; index++) {
        const entryOffset = ifdOffset + 2 + index * 12;
        if (entryOffset + 12 > input.length) {
            return undefined;
        }

        const tag = readUInt16(entryOffset);
        if (tag !== 256 && tag !== 257) {
            continue;
        }

        const type = readUInt16(entryOffset + 2);
        const count = readUInt32(entryOffset + 4);
        if (count !== 1 || (type !== 3 && type !== 4)) {
            return undefined;
        }
        const value = type === 3 ? readUInt16(entryOffset + 8) : readUInt32(entryOffset + 8);
        if (tag === 256) {
            width = value;
        } else {
            height = value;
        }
        if (width !== undefined && height !== undefined) {
            return { width, height };
        }
    }
    return undefined;
}

export function readImageDimensions(input: Buffer, mimeType: string): ImageDimensions | undefined {
    switch (mimeType) {
        case 'image/bmp':
            return readBmpDimensions(input);
        case 'image/gif':
            return readGifDimensions(input);
        case 'image/jpeg':
            return readJpegDimensions(input);
        case 'image/png':
            return readPngDimensions(input);
        case 'image/tiff':
            return readTiffDimensions(input);
        case 'image/webp':
            return readWebpDimensions(input);
        default:
            return undefined;
    }
}
