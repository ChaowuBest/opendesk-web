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

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { validateUpdateUrl } from './url-policy.js';

const DEFAULT_MAX_INSTALLER_SIZE = 4 * 1024 * 1024 * 1024;

export interface DownloadInstallerOptions {
    url: string;
    destination: string;
    expectedSize?: number;
    maxSize?: number;
    fetchImpl?: typeof fetch;
    onProgress?: (receivedBytes: number, totalBytes?: number) => void;
}

export async function downloadInstaller(options: DownloadInstallerOptions): Promise<void> {
    const sourceUrl = validateUpdateUrl(options.url, 'Update installer URL');
    const partialPath = `${options.destination}.partial`;
    const maxSize = options.maxSize ?? DEFAULT_MAX_INSTALLER_SIZE;
    const fetchImpl = options.fetchImpl ?? fetch;
    await fs.promises.mkdir(path.dirname(options.destination), { recursive: true });
    await fs.promises.rm(partialPath, { force: true });

    const response = await fetchImpl(sourceUrl, {
        redirect: 'follow',
        headers: { accept: 'application/octet-stream', 'user-agent': 'OpenDesk-Updater' }
    });
    if (!response.ok || !response.body) throw new Error(`Installer download failed with HTTP ${response.status}`);
    if (response.url) validateUpdateUrl(response.url, 'Installer redirect');
    const headerSize = Number(response.headers.get('content-length'));
    const totalBytes = Number.isSafeInteger(headerSize) && headerSize > 0 ? headerSize : options.expectedSize;
    if (totalBytes && totalBytes > maxSize) throw new Error('Update installer exceeds the maximum allowed size');
    if (options.expectedSize && totalBytes && totalBytes !== options.expectedSize) {
        throw new Error('Update installer size does not match the release metadata');
    }

    let receivedBytes = 0;
    const output = await fs.promises.open(partialPath, 'wx');
    try {
        for await (const chunk of Readable.fromWeb(response.body as never)) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
            receivedBytes += buffer.length;
            if (receivedBytes > maxSize) throw new Error('Update installer exceeds the maximum allowed size');
            await output.write(buffer);
            options.onProgress?.(receivedBytes, totalBytes);
        }
        await output.close();
        if (options.expectedSize && receivedBytes !== options.expectedSize) {
            throw new Error('Downloaded installer size does not match the release metadata');
        }
        await fs.promises.rm(options.destination, { force: true });
        await fs.promises.rename(partialPath, options.destination);
    } catch (error) {
        await output.close().catch(() => {});
        await fs.promises.rm(partialPath, { force: true });
        throw error;
    }
}

export async function copyLocalInstaller(
    source: string,
    destination: string,
    onProgress?: (receivedBytes: number, totalBytes?: number) => void
): Promise<void> {
    const partialPath = `${destination}.partial`;
    const sourceStat = await fs.promises.stat(source);
    if (!sourceStat.isFile() || !source.toLowerCase().endsWith('.exe')) {
        throw new Error('Local update test package must be an EXE file');
    }
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await fs.promises.rm(partialPath, { force: true });
    let receivedBytes = 0;
    const input = fs.createReadStream(source);
    const output = fs.createWriteStream(partialPath, { flags: 'wx' });
    input.on('data', (chunk) => {
        receivedBytes += chunk.length;
        onProgress?.(receivedBytes, sourceStat.size);
    });
    try {
        await new Promise<void>((resolve, reject) => {
            input.on('error', reject);
            output.on('error', reject);
            output.on('finish', resolve);
            input.pipe(output);
        });
        await fs.promises.rm(destination, { force: true });
        await fs.promises.rename(partialPath, destination);
    } catch (error) {
        input.destroy();
        output.destroy();
        await fs.promises.rm(partialPath, { force: true });
        throw error;
    }
}
