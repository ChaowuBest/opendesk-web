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
const DEFAULT_STALL_TIMEOUT_MS = 30_000;

export interface DownloadInstallerOptions {
    url: string;
    destination: string;
    expectedSize?: number;
    maxSize?: number;
    fetchImpl?: typeof fetch;
    /**
     * 传输停滞检测：超过该时长没有任何字节推进即中止下载（0 = 禁用）。
     * 防 CDN/代理连接假死导致协调器状态永久停留在 downloading。
     */
    stallTimeoutMs?: number;
    onProgress?: (receivedBytes: number, totalBytes?: number) => void;
}

export async function downloadInstaller(options: DownloadInstallerOptions): Promise<void> {
    const sourceUrl = validateUpdateUrl(options.url, 'Update installer URL');
    const partialPath = `${options.destination}.partial`;
    const maxSize = options.maxSize ?? DEFAULT_MAX_INSTALLER_SIZE;
    const fetchImpl = options.fetchImpl ?? fetch;
    const stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    await fs.promises.mkdir(path.dirname(options.destination), { recursive: true });
    await fs.promises.rm(partialPath, { force: true });

    const controller = new AbortController();
    const response = await fetchImpl(sourceUrl, {
        redirect: 'follow',
        headers: { accept: 'application/octet-stream', 'user-agent': 'OpenDesk-Updater' },
        signal: controller.signal
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
    // 停滞看门狗：每个 chunk 到达即重置；触发时 abort 底层请求并 reject 泵流，
    // 双保险覆盖"尊重 signal"与"忽略 signal"两种 fetch 实现
    let stallReject: ((error: Error) => void) | undefined;
    const stalled = new Promise<never>((_, reject) => {
        stallReject = reject;
    });
    // 含 DOM lib 时 setTimeout 统一返回 number（@types/node 的 node:timers 亦 re-export 全局版）
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const resetStallWatchdog = () => {
        if (stallTimeoutMs <= 0) return;
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
            controller.abort();
            stallReject?.(new Error('Installer download stalled with no progress'));
        }, stallTimeoutMs);
    };
    resetStallWatchdog();

    const output = await fs.promises.open(partialPath, 'wx');
    try {
        const pump = (async () => {
            for await (const chunk of Readable.fromWeb(response.body as never)) {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
                receivedBytes += buffer.length;
                if (receivedBytes > maxSize) throw new Error('Update installer exceeds the maximum allowed size');
                await output.write(buffer);
                resetStallWatchdog();
                options.onProgress?.(receivedBytes, totalBytes);
            }
        })();
        try {
            await Promise.race([pump, stalled]);
        } finally {
            pump.catch(() => {});
        }
        clearTimeout(stallTimer);
        await output.close();
        if (options.expectedSize && receivedBytes !== options.expectedSize) {
            throw new Error('Downloaded installer size does not match the release metadata');
        }
        await fs.promises.rm(options.destination, { force: true });
        await fs.promises.rename(partialPath, options.destination);
    } catch (error) {
        clearTimeout(stallTimer);
        controller.abort();
        await output.close().catch(() => {});
        await fs.promises.rm(partialPath, { force: true });
        throw error;
    }
}

export async function copyLocalInstaller(
    source: string,
    destination: string,
    onProgress?: (receivedBytes: number, totalBytes?: number) => void,
    expectedExtension = '.exe'
): Promise<void> {
    const partialPath = `${destination}.partial`;
    const sourceStat = await fs.promises.stat(source);
    if (!sourceStat.isFile() || !source.toLowerCase().endsWith(expectedExtension)) {
        throw new Error(`Local update test package must be a ${expectedExtension} file`);
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
