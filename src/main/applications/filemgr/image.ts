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
import sharp from 'sharp';
import { getPlatform } from '../../../platforms/base.js';

const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 2048;
const MAX_IMAGE_PIXELS = 100_000_000;
const IMAGE_FETCH_TIMEOUT_MS = 20_000;

const PASSTHROUGH_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export type ImageSourceErrorCode =
    | 'unsupported_protocol'
    | 'not_found'
    | 'directory'
    | 'no_access'
    | 'too_large'
    | 'http_error'
    | 'fetch_failed'
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

async function prepareImage(source: string, input: Buffer): Promise<LoadedImage> {
    try {
        const detected = await fileType.fromBuffer(input);
        const metadata = await sharp(input, {
            animated: false,
            failOn: 'error',
            limitInputPixels: MAX_IMAGE_PIXELS
        }).metadata();
        if (!metadata.width || !metadata.height || !metadata.format) {
            throw new ImageSourceError('invalid_image');
        }

        const detectedMime = detected?.mime;
        const canPassThrough =
            detectedMime !== undefined &&
            PASSTHROUGH_MIME_TYPES.has(detectedMime) &&
            metadata.width <= MAX_IMAGE_DIMENSION &&
            metadata.height <= MAX_IMAGE_DIMENSION;

        let output = input;
        let mimeType = detectedMime;
        let width = metadata.width;
        let height = metadata.height;

        if (!canPassThrough) {
            const pipeline = sharp(input, {
                animated: false,
                failOn: 'error',
                limitInputPixels: MAX_IMAGE_PIXELS
            })
                .rotate()
                .resize({
                    width: MAX_IMAGE_DIMENSION,
                    height: MAX_IMAGE_DIMENSION,
                    fit: 'inside',
                    withoutEnlargement: true
                });

            if (metadata.hasAlpha) {
                output = await pipeline.png({ compressionLevel: 9 }).toBuffer();
                mimeType = 'image/png';
            } else {
                output = await pipeline.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
                mimeType = 'image/jpeg';
            }

            const outputMetadata = await sharp(output).metadata();
            width = outputMetadata.width ?? width;
            height = outputMetadata.height ?? height;
        }

        if (!mimeType || !PASSTHROUGH_MIME_TYPES.has(mimeType) || output.length > MAX_IMAGE_INPUT_BYTES) {
            throw new ImageSourceError('invalid_image');
        }

        return {
            source,
            dataUrl: `data:${mimeType};base64,${output.toString('base64')}`,
            mimeType,
            width,
            height,
            byteLength: output.length
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
