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
 * 插件市场清单（`plugins.json`）的解析。
 *
 * 清单由渠道自己托管，形状可能随渠道演进而变，因此这里的解析策略是：
 * - 只认必需的字段（id + 下载地址），其余字段缺失都按「没声明」处理；
 * - 声明了的展示字段与插件清单同一口径（`version` 是 SemVer、`author` 是对象且 name 必填、
 *   `apiVersion` 必须等于宿主支持的插件 API 版本、`platforms` 取自同一套枚举），
 *   免得市场显示的和装完之后的插件对不上；
 * - `lenient` 模式下单条写坏只跳过那一条，不让整个市场因为一条脏数据变成空白；
 * - 渠道级校验（用户点「确定」新增渠道时）用严格模式，任何一条写坏都要先修好。
 *
 * 下载地址只放行归档包（.zip / .tgz / .tar.gz）：插件安装走的是「下载归档 → 解包 → 校验」
 * 这条路径，地址若不是归档包，装下去只会得到一句莫名其妙的解包失败。下载地址允许写成相对于
 * 清单的地址（`plugins/demo.zip`）：渠道把包和清单放在同一个仓库里时不必写死绝对地址，
 * 换域名/换分支都不会让整份清单失效。
 */

import path from 'node:path';
import {
    localePrimaryTag,
    OPENDESK_PLUGIN_API_VERSION,
    OPENDESK_PLUGIN_PLATFORMS,
    type PluginAuthor,
    type PluginDisplayName,
    type PluginLocalizedText,
    type PluginPlatform
} from '../../../../../packages/plugin-sdk/src/index.js';
import { toErrorMessage } from '../../../../common/utils/error.js';
import { logger } from '../../../utils/logger.js';
import { isValidVersion } from '../../../utils/version.js';
import { t } from '../locale/index.js';

/** 插件市场的领域错误：消息已经是给用户看的文案 */
export class PluginMarketError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PluginMarketError';
    }
}

/** 清单里的一条插件（下载安装所需的最小信息） */
export interface PluginCatalogEntry {
    /** 市场内唯一 id；安装后即为插件 id */
    id: string;
    displayName?: PluginDisplayName;
    description?: PluginLocalizedText;
    /** 插件版本，与插件清单一致要求是合法 SemVer */
    version?: string;
    /**
     * 插件声明的 apiVersion（与插件清单同义）：仅支持宿主当前的插件 API 版本。
     * 省略表示不声明，声明了就必须等于宿主支持的版本。
     */
    apiVersion?: number;
    /**
     * 宿主版本上下界（与插件清单的 minOpenDeskVersion / maxOpenDeskVersion 同义）：
     * SemVer、含边界、省略表示不限。不含当前宿主的条目不上架，也不允许安装。
     */
    minOpenDeskVersion?: string;
    maxOpenDeskVersion?: string;
    /** 支持平台：与插件清单同义，未声明表示全平台；不含当前平台的条目不会出现在市场上 */
    platforms?: PluginPlatform[];
    /** 分类标签：与渠道声明的 categories 取值对应，未声明表示未分类 */
    category?: string[];
    /** 插件归档包的下载地址 */
    downloadUrl: string;
    /** 作者信息：市场卡片与详情展示用，结构与插件清单的 author 一致 */
    author?: PluginAuthor;
    homepage?: string;
    /**
     * 插件图标地址：市场卡片用它代替首字母图标。
     * 绝对 http(s) 图片链接原样保留；相对链接按清单来源解析（远端清单解析成绝对 URL，
     * 本地调试清单解析成同级文件路径，由宿主在返回给渲染层前内联成 data URL）。
     */
    iconUrl?: string;
}

/** 一份解析后的市场清单 */
export interface PluginCatalogDocument {
    /** 渠道声明的分类；缺省表示该渠道不支持按分类显示 */
    categories?: string[];
    entries: PluginCatalogEntry[];
}

export interface ParsePluginCatalogOptions {
    /** 单条容错：写坏的条目跳过而不是整体报错 */
    lenient?: boolean;
    /**
     * 允许明文 http 下载地址。
     * 只在清单来源本身不是 https（本地调试文件 / 内网 http 市场）时打开，
     * 免得线上市场的明文下载地址被中间人换成一个恶意插件包。
     */
    allowInsecureDownloadUrl?: boolean;
    /**
     * 相对下载地址的基准（清单来源的地址或文件路径），缺省用 parse 的 `source`。
     *
     * 单独一个字段是为了读缓存时也能解析相对地址：缓存文件里存的是清单原文，
     * 基准必须仍是清单的原始地址，而不是缓存文件自己的路径。
     */
    downloadUrlBase?: string;
}

const pluginIdPattern = /^[a-zA-Z][a-zA-Z0-9._-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asText(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function optionalText(value: unknown): string | undefined {
    const text = asText(value);
    return text || undefined;
}

/** 本地化文本：字符串或按语言声明的对象（键归一化为主语言标签） */
function optionalLocalizedText(value: unknown): PluginLocalizedText | undefined {
    if (typeof value === 'string') return asText(value) || undefined;
    if (!isRecord(value)) return undefined;
    const localized: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value)) {
        const text = asText(entry);
        const tag = localePrimaryTag(key);
        if (!tag || !text) continue;
        localized[tag] = text;
    }
    return Object.keys(localized).length > 0 ? localized : undefined;
}

/**
 * 作者信息（可选）。
 *
 * 与插件清单的 author 同一口径：必须是对象，`name` 必填、`institution` 可选，两者都支持
 * 字符串或本地化对象；`homepage` 只接受 http(s)。不合法就让这条市场条目不成立，
 * 免得市场显示的作者和安装后的插件对不上。
 */
function optionalAuthor(value: unknown): PluginAuthor | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value)) throw new PluginMarketError(t('market.entryAuthorInvalid'));
    const name = optionalLocalizedText(value.name);
    if (!name) throw new PluginMarketError(t('market.entryAuthorInvalid'));
    const homepage = optionalUrl(value.homepage);
    if (value.homepage !== undefined && !homepage) {
        throw new PluginMarketError(t('market.entryAuthorInvalid'));
    }
    return {
        name,
        institution: optionalLocalizedText(value.institution),
        homepage
    };
}

/** 站点地址：只保留 http(s)，界面上要把它当链接展示 */
function optionalUrl(value: unknown): string | undefined {
    const text = asText(value);
    if (!text) return undefined;
    try {
        const url = new URL(text);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
    } catch {
        return undefined;
    }
}

/**
 * 插件图标地址（可选，展示字段，写坏按未声明处理）。
 *
 * 绝对 http(s) 图片链接原样保留；相对链接与 downloadUrl 同一套基准解析：
 * 清单是远端地址时解析成绝对 URL，本地调试清单解析成同级文件路径。
 */
function optionalIconUrl(value: unknown, base: string): string | undefined {
    const text = asText(value);
    if (!text) return undefined;
    const resolved = resolveDownloadTarget(text, base);
    if (resolved.url) {
        return resolved.url.protocol === 'http:' || resolved.url.protocol === 'https:'
            ? resolved.url.toString()
            : undefined;
    }
    return resolved.filePath;
}

function optionalStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const texts = value.map(asText).filter(Boolean);
    if (texts.length === 0) return undefined;
    return [...new Set(texts)];
}

/**
 * 下载地址必须是归档包，且默认只允许 https。
 *
 * 相对地址（`plugins/demo.zip`）按清单来源解析：清单是 http(s) 地址时按 URL 语义解析
 * （`./`、`../`、以 `/` 开头都按浏览器规则归一），清单是本地调试文件时解析成同级目录下的
 * 绝对路径——安装流程对「本地归档路径」和「远端归档地址」都支持（见 management/manager.ts）。
 */
function normalizeDownloadUrl(value: unknown, options: ParsePluginCatalogOptions, base: string): string {
    const text = asText(value);
    if (!text) throw new PluginMarketError(t('market.entryDownloadUrlMissing'));
    const resolved = resolveDownloadTarget(text, base);
    const lower = resolved.pathname.toLowerCase();
    if (resolved.url) {
        if (resolved.url.protocol === 'http:' && !options.allowInsecureDownloadUrl) {
            throw new PluginMarketError(t('market.entryDownloadUrlInsecure', { url: text }));
        }
    } else if (!resolved.filePath) {
        throw new PluginMarketError(t('market.entryDownloadUrlInvalid', { url: text }));
    }
    if (!lower.endsWith('.zip') && !lower.endsWith('.tgz') && !lower.endsWith('.tar.gz')) {
        throw new PluginMarketError(t('market.entryDownloadUrlNotArchive', { url: text }));
    }
    return resolved.url ? resolved.url.toString() : (resolved.filePath as string);
}

/** 把下载地址解析成远端 URL 或本地文件路径（两者都失败时返回空对象） */
function resolveDownloadTarget(text: string, base: string): { url?: URL; filePath?: string; pathname: string } {
    try {
        const url = new URL(text);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
            return { pathname: '' };
        }
        return { url, pathname: url.pathname };
    } catch {
        // 不是绝对地址：相对地址按清单来源解析
    }
    if (/^https?:\/\//i.test(base)) {
        try {
            const url = new URL(text, base);
            return url.protocol === 'https:' || url.protocol === 'http:'
                ? { url, pathname: url.pathname }
                : { pathname: '' };
        } catch {
            return { pathname: '' };
        }
    }
    if (!base.trim()) return { pathname: '' };
    const filePath = path.resolve(path.dirname(base), text);
    return { filePath, pathname: filePath };
}

/** 版本号：与插件清单一致，必须是合法 SemVer */
function optionalSemver(value: unknown): string | undefined {
    const text = optionalText(value);
    if (text === undefined) return undefined;
    if (!isValidVersion(text)) throw new PluginMarketError(t('market.entryVersionInvalid', { version: text }));
    return text;
}

/**
 * 宿主版本上下界：与插件清单一致要求合法 SemVer。
 *
 * 单独一条文案是为了让渠道校验的报错能指出是哪个字段写坏了——`minOpenDeskVersion`
 * 写成 `latest` 时不该只说「插件版本号不合法」，那会让人去翻 `version`。
 */
function optionalHostVersion(value: unknown, field: 'minOpenDeskVersion' | 'maxOpenDeskVersion'): string | undefined {
    const text = optionalText(value);
    if (text === undefined) return undefined;
    if (!isValidVersion(text)) {
        throw new PluginMarketError(t('market.entryHostVersionInvalid', { field, version: text }));
    }
    return text;
}

/** apiVersion：与插件清单同义，只能声明宿主支持的那个版本 */
function optionalApiVersion(value: unknown): number | undefined {
    if (value === undefined) return undefined;
    if (value !== OPENDESK_PLUGIN_API_VERSION) {
        throw new PluginMarketError(t('market.entryApiVersionUnsupported', { apiVersion: String(value) }));
    }
    return OPENDESK_PLUGIN_API_VERSION;
}

/** 支持平台：与插件清单同一套枚举；未声明表示全平台 */
function optionalPlatforms(value: unknown): PluginPlatform[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length === 0) {
        throw new PluginMarketError(t('market.entryPlatformsInvalid'));
    }
    const allowed = new Set<string>(OPENDESK_PLUGIN_PLATFORMS);
    const platforms: string[] = [];
    for (const item of value) {
        const platform = asText(item);
        if (!allowed.has(platform)) {
            throw new PluginMarketError(t('market.entryPlatformsInvalid'));
        }
        if (!platforms.includes(platform)) platforms.push(platform);
    }
    return platforms as PluginPlatform[];
}

/** 解析单条插件；任何不合法之处都抛错，由调用方决定跳过还是整体失败 */
function parseEntry(value: unknown, options: ParsePluginCatalogOptions, base: string): PluginCatalogEntry {
    if (!isRecord(value)) throw new PluginMarketError(t('market.entryInvalid'));
    const id = asText(value.id);
    if (!id) throw new PluginMarketError(t('market.entryIdMissing'));
    if (!pluginIdPattern.test(id)) throw new PluginMarketError(t('market.entryIdInvalid', { id }));
    return {
        id,
        displayName: optionalLocalizedText(value.displayName),
        description: optionalLocalizedText(value.description),
        version: optionalSemver(value.version),
        apiVersion: optionalApiVersion(value.apiVersion),
        minOpenDeskVersion: optionalHostVersion(value.minOpenDeskVersion, 'minOpenDeskVersion'),
        maxOpenDeskVersion: optionalHostVersion(value.maxOpenDeskVersion, 'maxOpenDeskVersion'),
        platforms: optionalPlatforms(value.platforms),
        category: optionalStringArray(value.category),
        downloadUrl: normalizeDownloadUrl(value.downloadUrl, options, base),
        author: optionalAuthor(value.author),
        homepage: optionalUrl(value.homepage),
        iconUrl: optionalIconUrl(value.iconUrl, base)
    };
}

/** 清单里的插件数组：允许 `plugins` / `entries` 两种写法，也允许清单本身就是数组 */
function extractEntryList(raw: unknown): unknown[] {
    if (Array.isArray(raw)) return raw;
    if (!isRecord(raw)) return [];
    const list = raw.plugins ?? raw.entries;
    return Array.isArray(list) ? list : [];
}

function extractCategories(raw: unknown): string[] | undefined {
    if (!isRecord(raw)) return undefined;
    return optionalStringArray(raw.categories);
}

/**
 * 解析市场清单。
 *
 * @param raw 清单原文（已 JSON.parse）
 * @param source 清单来源（地址或文件路径），只用于日志与错误定位
 */
export function parsePluginCatalogDocument(
    raw: unknown,
    source: string,
    options: ParsePluginCatalogOptions = {}
): PluginCatalogDocument {
    const list = extractEntryList(raw);
    const entries: PluginCatalogEntry[] = [];
    const seen = new Set<string>();
    const base = options.downloadUrlBase ?? source;
    let firstFailure: PluginMarketError | null = null;
    for (const [index, item] of list.entries()) {
        try {
            const entry = parseEntry(item, options, base);
            // 同一市场里重复声明同一个 id：保留先出现的那条，界面与安装路径都以它为准
            if (seen.has(entry.id)) continue;
            seen.add(entry.id);
            entries.push(entry);
        } catch (error) {
            const detail = error instanceof PluginMarketError ? error.message : toErrorMessage(error);
            const failure = new PluginMarketError(t('market.entryRejected', { index: index + 1, detail }));
            if (!options.lenient) throw failure;
            firstFailure ??= failure;
            logger.warn(`[pluginmgr] skip invalid entry #${index + 1} of ${source}: ${detail}`);
        }
    }
    // 一条都用不了的清单是坏的（写错字段、指到了目录页……）：报出第一条错误，
    // 让调用方回退到缓存并给用户一个能排查的提示，而不是显示成一个「空市场」。
    if (entries.length === 0 && list.length > 0 && firstFailure) throw firstFailure;
    return { categories: extractCategories(raw), entries };
}

/**
 * 按分类过滤清单条目。
 *
 * 不传分类（或传空数组）表示不过滤，与 `BasePluginRegistry.getCatalog` 的语义一致；
 * 声明了分类但条目没有 categories 的，算作「未分类」，不匹配任何具体分类。
 */
export function filterCatalogByCategories(
    entries: readonly PluginCatalogEntry[],
    categories?: readonly string[]
): PluginCatalogEntry[] {
    const wanted = (categories ?? []).map((category) => category.trim()).filter(Boolean);
    if (wanted.length === 0) return [...entries];
    const wantedSet = new Set(wanted);
    return entries.filter((entry) => (entry.category ?? []).some((category) => wantedSet.has(category)));
}

/**
 * 按 `startAt` / `limit` 切一段清单。
 *
 * 语义与 benchmark 的 `PlainBenchmarkRegistry.getCatalog(startAt, limit)` 一致：`startAt`
 * 默认 0，负数与小数会被夹到 0 并取整；省略 `limit` 表示取到末尾，`limit: 0` 表示不取。
 * 单独抽出来是给 registry 实现（含未来的 provider）复用，避免各写一份切片规则。
 */
export function paginateCatalogEntries(
    entries: readonly PluginCatalogEntry[],
    query: { startAt?: number; limit?: number } = {}
): PluginCatalogEntry[] {
    const start = toSafeCount(query.startAt, 0);
    if (query.limit === undefined || query.limit === null) return entries.slice(start);
    const limit = toSafeCount(query.limit, 0);
    return entries.slice(start, start + limit);
}

/** 把外部传进来的计数归一化：非数字退回 fallback，负数夹到 0，小数取整 */
function toSafeCount(value: number | undefined, fallback: number): number {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(0, Math.trunc(num));
}

/** 在清单里按 id / 显示名 / 描述 / 作者做大小写不敏感的包含匹配（插件市场搜索用） */
export function filterCatalogByQuery(entries: readonly PluginCatalogEntry[], query: string): PluginCatalogEntry[] {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return [...entries];
    return entries.filter((entry) => {
        const haystack = [
            entry.id,
            entry.version ?? '',
            ...Object.values(toTextMap(entry.displayName)),
            ...Object.values(toTextMap(entry.description)),
            ...Object.values(toTextMap(entry.author?.name)),
            ...Object.values(toTextMap(entry.author?.institution))
        ]
            .join('\n')
            .toLowerCase();
        return haystack.includes(keyword);
    });
}

function toTextMap(value: PluginDisplayName | PluginLocalizedText | undefined): Record<string, string> {
    if (!value) return {};
    return typeof value === 'string' ? { default: value } : value;
}
