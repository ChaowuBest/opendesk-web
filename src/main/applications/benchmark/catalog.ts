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
 * 测评集清单（catalog）文档的解析。
 *
 * 清单由各个 registry 提供（见 ./registry），本文件只负责把清单 JSON 规范化成
 * `BenchmarkSummary`：不含网络、不含缓存，便于单元测试覆盖。
 *
 * 清单是远程数据，因此按下面的策略解析：
 * - 单条容错：某一条清单项写坏只跳过它并告警，不让整份清单作废
 *   （只有整份清单一条都用不了才报错，好让调用方回退到本地缓存）；
 * - 下载地址校验：清单是远程数据，下载又是主进程直接落盘解压，所以线上清单只接受 https；
 *   本地调试清单才放行明文 http。
 *
 * 清单项除 `downloadUrl` 外，字段语义与测评集自带的 dataset.json 保持一致
 * （name / description / homepage / version / tracks）。
 */

import { t } from './locale/index.js';
import { BenchmarkDataError, parseDatasetManifest, type BenchmarkSummary, type DatasetManifest } from './common.js';
import { toErrorMessage } from '../../../common/utils/error.js';
import { logger } from '../../utils/logger.js';

export interface ParseCatalogOptions {
    /**
     * 单条清单项无效时跳过并告警，而不是整份清单报错。
     * 加载线上/缓存清单时应当开启：远程 JSON 是人手编辑的，一条写坏不该让所有测评集都消失。
     */
    lenient?: boolean;
    /** 是否允许 http 下载地址；只有本地调试清单允许（线上清单必须走 https） */
    allowInsecureDownloadUrl?: boolean;
    /**
     * 清单自身的 http(s) 地址；清单项的 `downloadUrl` 写相对路径时以它为基准解析。
     * 不给（清单不是通过 JSON 地址指定的，如本地调试文件）时相对路径按无效地址处理。
     */
    baseUrl?: string;
}

/** 解析清单文档（顶层为测评集数组） */
export function parseCatalogDocument(
    raw: unknown,
    source: string,
    options: ParseCatalogOptions = {}
): BenchmarkSummary[] {
    if (!Array.isArray(raw)) {
        throw new BenchmarkDataError(t('error.catalogDocumentInvalid', { source }));
    }
    const entries: BenchmarkSummary[] = [];
    const seen = new Set<string>();
    let firstFailure: BenchmarkDataError | null = null;

    raw.forEach((item, index) => {
        let entry: BenchmarkSummary;
        try {
            entry = parseCatalogEntry(item, index, options);
        } catch (error) {
            const failure = asCatalogError(error, source);
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

function parseCatalogEntry(item: unknown, index: number, options: ParseCatalogOptions): BenchmarkSummary {
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
    const downloadUrl = resolveDownloadUrl(asText(obj.downloadUrl), options);
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

function asCatalogError(error: unknown, source: string): BenchmarkDataError {
    if (error instanceof BenchmarkDataError) return error;
    return new BenchmarkDataError(t('error.catalogDocumentInvalid', { source }));
}

function asText(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * 归一化清单项的下载地址：绝对地址原样返回，相对路径以清单地址为基准解析。
 *
 * 相对路径的语义是「相对于清单 JSON 所在的目录」，所以只有清单本身通过 http(s)
 * JSON 地址给出（`options.baseUrl`）时才可能解析；解析结果仍要过 `isDownloadUrlAllowed`
 * 的校验（线上清单只接受 https）。没有基准或解析失败时保持原样，交由地址校验拒绝。
 */
function resolveDownloadUrl(value: string, options: ParseCatalogOptions): string {
    if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
    const base = asText(options.baseUrl);
    if (!base) return value;
    try {
        return new URL(value, base).toString();
    } catch {
        return value;
    }
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
