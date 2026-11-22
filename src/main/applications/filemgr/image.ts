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
import { getPlatform } from '../../../platforms/base.js';
import { jimpLoader } from '../../loader/jimp.js';
import { readImageDimensions, type ImageDimensions } from '../../utils/image-dimensions.js';

// jimp 体积大（bundle 内 ~2.6MB），仅在图片超出模型友好尺寸、需要用 JS 解码缩放
// 时才加载。加载失败折叠为 ImageSourceError，与图片本身损坏走同一条降级路径。

const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 2048;
const MAX_IMAGE_PIXELS = 100_000_000;
const IMAGE_FETCH_TIMEOUT_MS = 20_000;

const MODEL_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const JIMP_IMAGE_MIME_TYPES = new Set(['image/bmp', 'image/gif', 'image/tiff']);
const SUPPORTED_IMAGE_MIME_TYPES = new Set([...MODEL_IMAGE_MIME_TYPES, ...JIMP_IMAGE_MIME_TYPES]);

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

async function processImageWithJimp(
    source: string,
    input: Buffer,
    mimeType: string,
    dimensions: ImageDimensions
): Promise<LoadedImage> {
    if (mimeType === 'image/webp') {
        throw new ImageSourceError('resize_unsupported', MAX_IMAGE_DIMENSION);
    }

    let Jimp: (typeof import('jimp'))['Jimp'];
    try {
        Jimp = await jimpLoader.ensure();
    } catch {
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
