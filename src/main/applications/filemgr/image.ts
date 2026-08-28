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
import fileType from 'file-type';
import { Jimp } from 'jimp';
import { getPlatform } from '../../../platforms/base.js';

const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 2048;
const MAX_IMAGE_PIXELS = 100_000_000;
const IMAGE_FETCH_TIMEOUT_MS = 20_000;

const MODEL_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const JIMP_IMAGE_MIME_TYPES = new Set(['image/bmp', 'image/gif', 'image/tiff']);
const SUPPORTED_IMAGE_MIME_TYPES = new Set([...MODEL_IMAGE_MIME_TYPES, ...JIMP_IMAGE_MIME_TYPES]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface ImageDimensions {
    width: number;
    height: number;
}

export type ImageSourceErrorCode =
    | 'unsupported_protocol'
    | 'not_found'
    | 'directory'
    | 'no_access'
    | 'too_large'
    | 'http_error'
    | 'fetch_failed'
    | 'unsupported_format'
    | 'resize_unsupported'
    | 'invalid_image';

export class ImageSourceError extends Error {
    readonly code: ImageSourceErrorCode;
    readonly details?: string | number;

    constructor(code: ImageSourceErrorCode, details?: string | number) {
        super(code);
        this.name = 'ImageSourceError';
        this.code = code;
        this.details = details;
    }
}

export interface LoadedImage {
    source: string;
    dataUrl: string;
    mimeType: string;
    width: number;
    height: number;
    byteLength: number;
}

function parseHttpUrl(source: string): URL | undefined {
    if (!/^[a-z][a-z\d+.-]*:/i.test(source) || /^[a-z]:[\\/]/i.test(source)) {
        return undefined;
    }

    let parsed: URL;
    try {
        parsed = new URL(source);
    } catch {
        throw new ImageSourceError('unsupported_protocol');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new ImageSourceError('unsupported_protocol', parsed.protocol.replace(/:$/, ''));
    }
    return parsed;
}

export function isOnlineImageSource(source: string): boolean {
    return parseHttpUrl(source) !== undefined;
}

async function readResponseBody(response: Response): Promise<Buffer> {
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_INPUT_BYTES) {
        throw new ImageSourceError('too_large', MAX_IMAGE_INPUT_BYTES);
    }

    const reader = response.body?.getReader();
    if (!reader) {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > MAX_IMAGE_INPUT_BYTES) {
            throw new ImageSourceError('too_large', MAX_IMAGE_INPUT_BYTES);
        }
        return buffer;
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_IMAGE_INPUT_BYTES) {
            await reader.cancel();
            throw new ImageSourceError('too_large', MAX_IMAGE_INPUT_BYTES);
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, totalBytes);
}

async function downloadImage(url: URL): Promise<Buffer> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
    try {
        const response = await getPlatform().fetch(url, {
            method: 'GET',
            redirect: 'follow',
            signal: controller.signal,
            headers: {
                Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8'
            }
        });
        if (!response.ok) {
            throw new ImageSourceError('http_error', response.status);
        }
        return await readResponseBody(response);
    } catch (error) {
        if (error instanceof ImageSourceError) {
            throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new ImageSourceError('fetch_failed', message);
    } finally {
        clearTimeout(timeout);
    }
}

async function readLocalImage(filePath: string): Promise<Buffer> {
    try {
        const stat = await fs.promises.stat(filePath);
        if (stat.isDirectory()) {
            throw new ImageSourceError('directory');
        }
        if (stat.size > MAX_IMAGE_INPUT_BYTES) {
            throw new ImageSourceError('too_large', MAX_IMAGE_INPUT_BYTES);
        }
        return await fs.promises.readFile(filePath);
    } catch (error) {
        if (error instanceof ImageSourceError) {
            throw error;
        }
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code === 'ENOENT') {
            throw new ImageSourceError('not_found');
        }
        if (nodeError.code === 'EACCES' || nodeError.code === 'EPERM') {
            throw new ImageSourceError('no_access');
        }
        throw error;
    }
}

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

function readImageDimensions(input: Buffer, mimeType: string): ImageDimensions | undefined {
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

async function processImageWithJimp(
    source: string,
    input: Buffer,
    mimeType: string,
    dimensions: ImageDimensions
): Promise<LoadedImage> {
    if (mimeType === 'image/webp') {
        throw new ImageSourceError('resize_unsupported', MAX_IMAGE_DIMENSION);
    }

    const image = await Jimp.read(input);
    if (
        image.width <= 0 ||
        image.height <= 0 ||
        image.width * image.height > MAX_IMAGE_PIXELS ||
        image.width !== dimensions.width ||
        image.height !== dimensions.height
    ) {
        throw new ImageSourceError('invalid_image');
    }

    let width = image.width;
    let height = image.height;
    if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
        const scale = Math.min(MAX_IMAGE_DIMENSION / width, MAX_IMAGE_DIMENSION / height);
        width = Math.max(1, Math.round(width * scale));
        height = Math.max(1, Math.round(height * scale));
        image.resize({ w: width, h: height });
    }

    const outputMimeType = mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const output =
        outputMimeType === 'image/jpeg'
            ? await image.getBuffer('image/jpeg', { quality: 85 })
            : await image.getBuffer('image/png', { compressionLevel: 9 });
    if (output.length > MAX_IMAGE_INPUT_BYTES) {
        throw new ImageSourceError('too_large', MAX_IMAGE_INPUT_BYTES);
    }

    return {
        source,
        dataUrl: `data:${outputMimeType};base64,${output.toString('base64')}`,
        mimeType: outputMimeType,
        width,
        height,
        byteLength: output.length
    };
}

async function prepareImage(source: string, input: Buffer): Promise<LoadedImage> {
    try {
        // 常规图片原样交给视觉模型；只有超出模型友好尺寸时才用纯 JS 解码和缩放。
        const detected = await fileType.fromBuffer(input);
        const detectedMime = detected?.mime;
        if (!detectedMime || !SUPPORTED_IMAGE_MIME_TYPES.has(detectedMime)) {
            throw new ImageSourceError('unsupported_format', detectedMime);
        }

        const dimensions = readImageDimensions(input, detectedMime);
        if (
            !dimensions ||
            dimensions.width <= 0 ||
            dimensions.height <= 0 ||
            dimensions.width * dimensions.height > MAX_IMAGE_PIXELS
        ) {
            throw new ImageSourceError('invalid_image');
        }

        if (
            JIMP_IMAGE_MIME_TYPES.has(detectedMime) ||
            dimensions.width > MAX_IMAGE_DIMENSION ||
            dimensions.height > MAX_IMAGE_DIMENSION
        ) {
            return await processImageWithJimp(source, input, detectedMime, dimensions);
        }

        return {
            source,
            dataUrl: `data:${detectedMime};base64,${input.toString('base64')}`,
            mimeType: detectedMime,
            width: dimensions.width,
            height: dimensions.height,
            byteLength: input.length
        };
    } catch (error) {
        if (error instanceof ImageSourceError) {
            throw error;
        }
        throw new ImageSourceError('invalid_image');
    }
}

export async function loadImageSource(source: string): Promise<LoadedImage> {
    const url = parseHttpUrl(source);
    const input = url ? await downloadImage(url) : await readLocalImage(source);
    return await prepareImage(source, input);
}
