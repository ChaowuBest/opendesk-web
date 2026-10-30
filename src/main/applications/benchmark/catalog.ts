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
 * 「测评集下载」清单的加载。
 *
 * 清单不打进包里，从官网静态目录拉取 JSON（由 OpenDesk-Pages 仓库的
 * `public/static/categories/benchmarks.json` 提供），新增或更新测评集不需要发版。
 * 本地调试时把 `OPENDESK_BENCHMARK_CATEGORY` 指向一个本地 JSON 文件即可跳过网络
 * （仅调试用，发布环境不要设置）。
 *
 * 清单是远程数据，因此按下面的策略取用：
 * - 内存缓存 + 并发去重：5 分钟内多次打开/切换下载中心不再各自重新请求，
 *   手动刷新通过 `forceRefresh` 绕过；
 * - 单条容错：某一条清单项写坏只跳过它并告警，不让整份清单作废
 *   （只有整份清单一条都用不了才报错，好让调用方回退到缓存）；
 * - 断网兜底：拉取失败时回退到上次成功拉到的清单（原文缓存到应用数据目录）。
 *   界面不区分「线上清单」和「离线缓存」：缓存里那条清单项的版本号就是实际能装到的版本，
 *   只有拉取彻底失败（连缓存都没有）时才会报错。
 *
 * 清单项除 `downloadUrl` 外，字段语义与测评集自带的 dataset.json 保持一致
 * （name / description / homepage / version / tracks）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { t } from './locale/index.js';
import { BenchmarkDataError, parseDatasetManifest, type CatalogDatasetEntry, type DatasetManifest } from './common.js';
import { toErrorMessage } from '../../../common/utils/error.js';
import { logger } from '../../utils/logger.js';

/** 线上清单地址 */
export const BENCHMARK_CATALOG_URL = 'https://opendesk.matrix.openharmony.cn/static/categories/benchmarks.json';

/** 本地调试：把清单换成该环境变量指向的本地 JSON 文件 */
export const BENCHMARK_CATALOG_PATH_ENV = 'OPENDESK_BENCHMARK_CATEGORY';

/** 断网兜底用的缓存文件名（放在应用数据目录下） */
export const BENCHMARK_CATALOG_CACHE_FILE = 'catalog-cache.json';

const FETCH_TIMEOUT_MS = 15000;

/** 清单内存缓存有效期：避免切页签、点下载各自再拉一遍远程清单 */
const MEMORY_CACHE_TTL_MS = 5 * 60 * 1000;

export interface LoadCatalogOptions {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    /** 清单缓存文件；拉取成功时写入，拉取失败时回退读取 */
    cacheFile?: string;
    /** 跳过内存缓存，强制重新拉取一次（手动刷新用） */
    forceRefresh?: boolean;
    /** 内存缓存有效期，默认 5 分钟 */
    memoryTtlMs?: number;
}

export interface ParseCatalogOptions {
    /**
     * 单条清单项无效时跳过并告警，而不是整份清单报错。
     * 加载线上/缓存清单时应当开启：远程 JSON 是人手编辑的，一条写坏不该让所有测评集都消失。
     */
    lenient?: boolean;
    /** 是否允许 http 下载地址；只有本地调试清单允许（线上清单必须走 https） */
    allowInsecureDownloadUrl?: boolean;
}

interface MemoryCache {
    /** 缓存归属（远程清单 + 缓存文件路径），配置变了不会误用旧缓存 */
    key: string;
    entries: CatalogDatasetEntry[];
    fetchedAt: number;
}

let memoryCache: MemoryCache | null = null;
let inFlight: { key: string; promise: Promise<CatalogDatasetEntry[]> } | null = null;

/** 清空内存缓存（换配置或测试用） */
export function resetCatalogCache(): void {
    memoryCache = null;
    inFlight = null;
}

/** 加载下载清单：环境变量指定了本地文件时读文件，否则请求线上清单 */
export async function loadCatalogDatasets(options: LoadCatalogOptions = {}): Promise<CatalogDatasetEntry[]> {
    const localPath = (process.env[BENCHMARK_CATALOG_PATH_ENV] ?? '').trim();
    if (localPath) {
        logger.warn(`[benchmark] catalog is overridden by ${BENCHMARK_CATALOG_PATH_ENV}: ${localPath}`);
        return parseCatalogDocument(await readLocalCatalog(localPath), localPath, {
            lenient: true,
            allowInsecureDownloadUrl: true
        });
    }

    const key = `remote|${options.cacheFile ?? ''}`;
    const ttl = options.memoryTtlMs ?? MEMORY_CACHE_TTL_MS;
    if (!options.forceRefresh) {
        if (memoryCache && memoryCache.key === key && Date.now() - memoryCache.fetchedAt < ttl) {
            return cloneEntries(memoryCache.entries);
        }
        // 并发调用（首屏 + 切页签 + 点下载）共用同一次请求，避免弱网下越等越慢
        if (inFlight && inFlight.key === key) {
            return cloneEntries(await inFlight.promise);
        }
    }

    const promise = loadRemoteCatalog(options, key);
    inFlight = { key, promise };
    try {
        return cloneEntries(await promise);
    } finally {
        if (inFlight?.promise === promise) inFlight = null;
    }
}

/** 按清单 id 查一条清单项；不存在时返回 null */
export async function findCatalogDataset(
    catalogId: string,
    options: LoadCatalogOptions = {}
): Promise<CatalogDatasetEntry | null> {
    const target = catalogId.trim();
    if (!target) return null;
    const entries = await loadCatalogDatasets(options);
    return entries.find((entry) => entry.id === target) ?? null;
}

/** 解析清单文档（顶层为测评集数组） */
export function parseCatalogDocument(
    raw: unknown,
    source: string,
    options: ParseCatalogOptions = {}
): CatalogDatasetEntry[] {
    if (!Array.isArray(raw)) {
        throw new BenchmarkDataError(t('error.catalogDocumentInvalid', { source }));
    }
    const entries: CatalogDatasetEntry[] = [];
    const seen = new Set<string>();
    let firstFailure: BenchmarkDataError | null = null;

    raw.forEach((item, index) => {
        let entry: CatalogDatasetEntry;
        try {
            entry = parseCatalogEntry(item, index, options);
        } catch (error) {
            const failure = asCatalogError(error);
            if (!options.lenient) throw failure;
            firstFailure ??= failure;
            logger.warn(
                `[benchmark] skip invalid catalog entry #${index + 1} from ${source}: ${toErrorMessage(failure)}`
            );
            return;
        }
        if (seen.has(entry.id)) {
            const failure = new BenchmarkDataError(
                t('error.catalogEntryInvalid', {
                    index: index + 1,
                    message: t('error.catalogEntryDuplicateId', { id: entry.id })
                })
            );
            if (!options.lenient) throw failure;
            firstFailure ??= failure;
            logger.warn(`[benchmark] skip duplicate catalog entry #${index + 1} from ${source}: id ${entry.id}`);
            return;
        }
        seen.add(entry.id);
        entries.push(entry);
    });

    // 一条都用不了说明这份清单是坏的：报出第一条错误，调用方好回退到缓存
    if (entries.length === 0 && raw.length > 0 && firstFailure) {
        throw firstFailure;
    }
    return entries;
}

async function loadRemoteCatalog(options: LoadCatalogOptions, key: string): Promise<CatalogDatasetEntry[]> {
    try {
        const raw = await fetchRemoteCatalog(options);
        const entries = parseCatalogDocument(raw, BENCHMARK_CATALOG_URL, { lenient: true });
        memoryCache = { key, entries, fetchedAt: Date.now() };
        await writeCatalogCache(options.cacheFile, raw);
        return entries;
    } catch (error) {
        const failure = asCatalogError(error);
        logger.warn(
            `[benchmark] failed to load catalog from ${BENCHMARK_CATALOG_URL}, falling back to cache: ${toErrorMessage(failure)}`
        );
        // 线上拉不到（断网 / 清单写坏）时退回上次成功拉到的清单
        const cached = await readCatalogCache(options.cacheFile);
        if (cached) {
            try {
                const entries = parseCatalogDocument(cached, options.cacheFile ?? BENCHMARK_CATALOG_URL, {
                    lenient: true
                });
                memoryCache = { key, entries, fetchedAt: Date.now() };
                return entries;
            } catch (cacheError) {
                // 缓存也坏了就别拿它的错误盖住真正的原因
                logger.warn(
                    `[benchmark] catalog cache ${options.cacheFile ?? ''} is unusable: ${toErrorMessage(cacheError)}`
                );
            }
        }
        throw failure;
    }
}

async function readLocalCatalog(localPath: string): Promise<unknown> {
    try {
        const text = await fs.promises.readFile(localPath, 'utf8');
        return JSON.parse(text);
    } catch (error) {
        throw new BenchmarkDataError(
            t('error.catalogFileReadFailed', { path: localPath, message: toErrorMessage(error) })
        );
    }
}

/** 缓存线上清单原文；写失败不影响本次使用 */
async function writeCatalogCache(cacheFile: string | undefined, raw: unknown): Promise<void> {
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

async function readCatalogCache(cacheFile: string | undefined): Promise<unknown> {
    if (!cacheFile) return null;
    try {
        return JSON.parse(await fs.promises.readFile(cacheFile, 'utf8'));
    } catch (error) {
        // 首次运行本来就没有缓存，不必刷一条告警
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
            logger.warn(`[benchmark] failed to read catalog cache ${cacheFile}: ${toErrorMessage(error)}`);
        }
        return null;
    }
}

async function fetchRemoteCatalog(options: LoadCatalogOptions): Promise<unknown> {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const url = BENCHMARK_CATALOG_URL;
    let text: string;
    try {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS) });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        text = await response.text();
    } catch (error) {
        throw new BenchmarkDataError(t('error.catalogFetchFailed', { url, message: toErrorMessage(error) }));
    }
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new BenchmarkDataError(t('error.catalogFetchFailed', { url, message: toErrorMessage(error) }));
    }
}

function parseCatalogEntry(item: unknown, index: number, options: ParseCatalogOptions): CatalogDatasetEntry {
    const position = index + 1;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new BenchmarkDataError(
            t('error.catalogEntryInvalid', {
                index: position,
                message: t('error.catalogEntryNotObject')
            })
        );
    }
    const obj = item as Record<string, unknown>;
    const id = asText(obj.id);
    if (!id) {
        throw new BenchmarkDataError(t('error.catalogEntryFieldMissing', { index: position, field: 'id' }));
    }
    const downloadUrl = asText(obj.downloadUrl);
    if (!isDownloadUrlAllowed(downloadUrl, options.allowInsecureDownloadUrl === true)) {
        throw new BenchmarkDataError(t('error.catalogEntryDownloadUrlInvalid', { index: position }));
    }
    // name / description / homepage / version / tracks 直接复用 dataset.json 的解析与校验
    let manifest: DatasetManifest;
    try {
        manifest = parseDatasetManifest(obj);
    } catch (error) {
        throw new BenchmarkDataError(
            t('error.catalogEntryInvalid', { index: position, message: toErrorMessage(error) })
        );
    }
    return { id, ...manifest, downloadUrl };
}

function cloneEntries(entries: CatalogDatasetEntry[]): CatalogDatasetEntry[] {
    return entries.map((entry) => ({ ...entry, tracks: entry.tracks.map((track) => ({ ...track })) }));
}

function asCatalogError(error: unknown): BenchmarkDataError {
    if (error instanceof BenchmarkDataError) return error;
    return new BenchmarkDataError(
        t('error.catalogFetchFailed', { url: BENCHMARK_CATALOG_URL, message: toErrorMessage(error) })
    );
}

function asText(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * 下载地址校验。
 *
 * 清单是远程数据，下载又是主进程直接落盘解压，所以线上清单只接受 https；
 * `file://` 之类的协议、以及明文 http 一律拒绝（本地调试清单才放行 http）。
 */
function isDownloadUrlAllowed(value: string, allowInsecure: boolean): boolean {
    if (!value) return false;
    try {
        const protocol = new URL(value).protocol;
        if (protocol === 'https:') return true;
        return allowInsecure && protocol === 'http:';
    } catch {
        return false;
    }
}
