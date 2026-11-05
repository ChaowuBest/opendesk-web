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
 * 最普通的 registry：从远端清单地址（官网静态目录里的 JSON）拉测评集。
 *
 * 清单不打进包里，新增或更新测评集不需要发版。远程数据按下面的策略取用：
 * - 本地文件缓存 5 分钟：清单下载到应用数据目录下的 JSON 文件里，5 分钟内复用，
 *   过期后下一次取用才重试下载；重试失败但本地已有文件时直接复用旧文件，
 *   界面因此不会因为一次断网变成空白；
 * - 内存 + 并发去重：`getCatalog` 与 `getBenchmarkCount` 共用同一份内存清单，
 *   谁先调用谁触发那次下载，另一个不会重复请求；并发调用共用同一次请求；
 * - 单条容错：某一条清单项写坏只跳过它（见 ../catalog.ts）。
 *
 * 本地调试时清单地址可以直接给一个本地 JSON 文件路径：这时每次取用都读文件
 * （改完立刻生效），既不写缓存，也放行明文 http 下载地址。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { t } from '../locale/index.js';
import { BenchmarkDataError, type BenchmarkSummary } from '../common.js';
import { parseCatalogDocument } from '../catalog.js';
import { toErrorMessage } from '../../../../common/utils/error.js';
import { logger } from '../../../utils/logger.js';
import type { BaseBenchmarkRegistry, BenchmarkRegistryDisplayName } from './base.js';

/** 清单缓存有效期：避免切 Tab、点下载各自再拉一遍远程清单 */
export const DEFAULT_CATALOG_TTL_MS = 5 * 60 * 1000;

const FETCH_TIMEOUT_MS = 15000;

export interface PlainBenchmarkRegistryOptions {
    /** 清单本地缓存文件；不传则不落盘（本地调试清单与测试用） */
    cacheFile?: string;
    /** 请求实现：主进程传入走代理的平台 fetch */
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    /** 缓存有效期，默认 5 分钟 */
    cacheTtlMs?: number;
    /** 注入时钟（测试用） */
    now?: () => number;
}

export class PlainBenchmarkRegistry implements BaseBenchmarkRegistry {
    readonly name: string;
    readonly displayName: BenchmarkRegistryDisplayName;
    /** 清单地址；本地调试时是本地 JSON 文件路径 */
    readonly catalogUrl: string;

    private readonly cacheFile: string | undefined;
    private readonly fetchImpl: typeof fetch | undefined;
    private readonly timeoutMs: number;
    private readonly cacheTtlMs: number;
    private readonly now: () => number;

    private entries: BenchmarkSummary[] | null = null;
    private entriesAt = 0;
    private inFlight: Promise<BenchmarkSummary[]> | null = null;
    /** 手动刷新标记：下一次取用绕过缓存重新下载 */
    private refreshPending = false;

    constructor(
        name: string,
        displayName: BenchmarkRegistryDisplayName,
        catalogUrl: string,
        options: PlainBenchmarkRegistryOptions = {}
    ) {
        this.name = name.trim();
        this.displayName = displayName;
        this.catalogUrl = catalogUrl.trim();
        this.cacheFile = options.cacheFile;
        this.fetchImpl = options.fetchImpl;
        this.timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
        this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CATALOG_TTL_MS;
        this.now = options.now ?? Date.now;
    }

    async getCatalog(startAt = 0, limit?: number): Promise<BenchmarkSummary[]> {
        const entries = await this.loadEntries();
        const start = toSafeInteger(startAt, 0);
        if (limit === undefined || limit === null) return cloneEntries(entries.slice(start));
        return cloneEntries(entries.slice(start, start + toSafeInteger(limit, 0)));
    }

    async getBenchmarkCount(): Promise<number> {
        return (await this.loadEntries()).length;
    }

    /** 手动刷新的入口：丢弃已有缓存，下一次取用重新下载（失败时仍会回退到本地文件） */
    invalidate(): void {
        this.entries = null;
        this.entriesAt = 0;
        this.refreshPending = true;
    }

    /** 清单地址是不是远端 URL（否则按本地调试文件处理） */
    private get isRemoteSource(): boolean {
        return /^https?:\/\//i.test(this.catalogUrl);
    }

    private async loadEntries(): Promise<BenchmarkSummary[]> {
        // 本地调试清单每次读文件（改完立刻生效），只有远端清单才走 5 分钟缓存
        if (
            this.isRemoteSource &&
            !this.refreshPending &&
            this.entries &&
            this.now() - this.entriesAt < this.cacheTtlMs
        ) {
            return this.entries;
        }
        // 并发调用（首屏 + 切 Tab + 点数）共用同一次请求，避免弱网下越等越慢
        if (this.inFlight) return this.inFlight;

        const force = this.refreshPending;
        this.refreshPending = false;
        const promise = this.reload(force);
        this.inFlight = promise;
        try {
            return await promise;
        } finally {
            if (this.inFlight === promise) this.inFlight = null;
        }
    }

    private async reload(force: boolean): Promise<BenchmarkSummary[]> {
        if (!this.isRemoteSource) {
            return this.remember(await readLocalCatalog(this.catalogUrl));
        }

        const cached = await this.readCacheFile();
        // 缓存文件新鲜度按 mtime 判断。mtime 取的是机器时间，系统时钟回拨或缓存文件被整体拷过来
        // 都可能让 mtime 落在未来，这种负年龄绝不能算作「刚下载过」，否则清单会一直停在旧版本
        const cachedAge = cached ? this.now() - cached.modifiedAt : Number.NaN;
        if (!force && cached && cachedAge >= 0 && cachedAge < this.cacheTtlMs) {
            return this.remember(cached.entries);
        }
        try {
            const raw = await this.fetchCatalog();
            // baseUrl：清单项的相对下载地址以清单自身地址为基准解析
            const entries = parseCatalogDocument(raw, this.catalogUrl, { lenient: true, baseUrl: this.catalogUrl });
            await this.writeCacheFile(raw);
            return this.remember(entries);
        } catch (error) {
            const failure = asCatalogFetchError(error, this.catalogUrl);
            if (!cached) throw failure;
            // 线上拉不到（断网 / 清单写坏）时退回上次成功拉到的清单
            logger.warn(
                `[benchmark] failed to load catalog of registry ${this.name} from ${this.catalogUrl}, falling back to cache: ${toErrorMessage(failure)}`
            );
            return this.remember(cached.entries);
        }
    }

    private remember(entries: BenchmarkSummary[]): BenchmarkSummary[] {
        this.entries = entries;
        this.entriesAt = this.now();
        return entries;
    }

    private async fetchCatalog(): Promise<unknown> {
        const fetchImpl = this.fetchImpl ?? globalThis.fetch;
        let text: string;
        try {
            const response = await fetchImpl(this.catalogUrl, { signal: AbortSignal.timeout(this.timeoutMs) });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            text = await response.text();
        } catch (error) {
            throw new BenchmarkDataError(
                t('error.catalogFetchFailed', { url: this.catalogUrl, message: toErrorMessage(error) })
            );
        }
        try {
            return JSON.parse(text);
        } catch (error) {
            throw new BenchmarkDataError(
                t('error.catalogFetchFailed', { url: this.catalogUrl, message: toErrorMessage(error) })
            );
        }
    }

    private async readCacheFile(): Promise<{ entries: BenchmarkSummary[]; modifiedAt: number } | null> {
        if (!this.cacheFile) return null;
        try {
            const stat = await fs.promises.stat(this.cacheFile);
            const raw = JSON.parse(await fs.promises.readFile(this.cacheFile, 'utf8'));
            // 缓存存的是清单原文，相对下载地址仍以（远端）清单地址为基准解析
            return {
                entries: parseCatalogDocument(raw, this.cacheFile, {
                    lenient: true,
                    baseUrl: this.isRemoteSource ? this.catalogUrl : undefined
                }),
                modifiedAt: stat.mtimeMs
            };
        } catch (error) {
            // 首次运行本来就没有缓存，不必刷一条告警
            if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
                logger.warn(`[benchmark] catalog cache ${this.cacheFile} is unusable: ${toErrorMessage(error)}`);
            }
            return null;
        }
    }

    /** 缓存清单原文；写失败不影响本次使用 */
    private async writeCacheFile(raw: unknown): Promise<void> {
        const cacheFile = this.cacheFile;
        if (!cacheFile) return;
        const tempFile = `${cacheFile}.${process.pid}-${randomUUID()}.tmp`;
        try {
            await fs.promises.mkdir(path.dirname(cacheFile), { recursive: true });
            await fs.promises.writeFile(tempFile, JSON.stringify(raw, null, 2), 'utf8');
            // 先写临时文件再改名：并发写/进程被杀都不会留下半截 JSON，断网兜底才不会跟着一起失效
            await fs.promises.rename(tempFile, cacheFile);
        } catch (error) {
            logger.warn(`[benchmark] failed to write catalog cache ${cacheFile}: ${toErrorMessage(error)}`);
            await fs.promises.rm(tempFile, { force: true }).catch(() => undefined);
        }
    }
}

async function readLocalCatalog(localPath: string): Promise<BenchmarkSummary[]> {
    let raw: unknown;
    try {
        raw = JSON.parse(await fs.promises.readFile(localPath, 'utf8'));
    } catch (error) {
        throw new BenchmarkDataError(
            t('error.catalogFileReadFailed', { path: localPath, message: toErrorMessage(error) })
        );
    }
    return parseCatalogDocument(raw, localPath, { lenient: true, allowInsecureDownloadUrl: true });
}

function asCatalogFetchError(error: unknown, url: string): BenchmarkDataError {
    if (error instanceof BenchmarkDataError) return error;
    return new BenchmarkDataError(t('error.catalogFetchFailed', { url, message: toErrorMessage(error) }));
}

function toSafeInteger(value: number | undefined, fallback: number): number {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(0, Math.trunc(num));
}

function cloneEntries(entries: BenchmarkSummary[]): BenchmarkSummary[] {
    return entries.map((entry) => ({ ...entry, tracks: entry.tracks.map((track) => ({ ...track })) }));
}
