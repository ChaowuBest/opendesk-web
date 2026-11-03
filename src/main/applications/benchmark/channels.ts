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
 * 测评集渠道（registry 来源）的领域模型。
 *
 * 一个渠道就是一份「托管在某个地址上的测评集清单」。渠道列表来自用户配置
 * （`applications.benchmark.channels`），其中：
 * - 系统默认渠道固定排在最前面，地址写死在 `BENCHMARK_CATALOG_URL`，用户只能启/禁，
 *   不能改名、改地址或删除；
 * - 用户添加的渠道由用户自己填名字和清单地址，添加/修改前必须联网验证清单可解析。
 *
 * 本文件只放与 Electron / 文件系统无关的逻辑（归一化、校验、联网验证），
 * 便于单元测试覆盖；真正的新增/删除/启停由 app.ts 负责落配置。
 */

import { t } from './locale/index.js';
import { BenchmarkDataError, type BenchmarkSummary } from './common.js';
import { parseCatalogDocument } from './catalog.js';
import { toErrorMessage } from '../../../common/utils/error.js';

/** 系统默认（官方）渠道的稳定 id，同时用作它的 registry 名与清单缓存文件名 */
export const OFFICIAL_CHANNEL_ID = 'official';

/** 官方测评集的线上清单地址 */
export const BENCHMARK_CATALOG_URL = 'https://opendesk.matrix.openharmony.cn/static/categories/benchmarks.json';

/** 本地调试：把官方清单换成该环境变量指向的本地 JSON 文件 */
export const BENCHMARK_CATALOG_PATH_ENV = 'OPENDESK_BENCHMARK_CATEGORY';

/** 自定义渠道数量上限（系统默认渠道不计入）：每个渠道在测评应用里占一个 Tab，不设上限会被异常配置撑爆界面 */
export const MAX_BENCHMARK_CHANNELS = 20;

/** 添加/编辑渠道时的联网校验超时 */
export const CHANNEL_VERIFY_TIMEOUT_MS = 15000;

/**
 * 一个测评集渠道。
 *
 * `id` 在整份配置里唯一；系统默认渠道的 `id` 固定为 `OFFICIAL_CHANNEL_ID`，
 * 且它的 `name` 恒为空串——展示名由界面按当前语言解析（见 app.ts 的 listBenchmarkChannels）。
 */
export interface BenchmarkChannel {
    id: string;
    name: string;
    url: string;
    /** 是否启用；禁用的渠道不会出现在测评应用里 */
    isEnabled: boolean;
}

/** 传给渲染层的渠道描述：名字已按当前语言解析好 */
export interface BenchmarkChannelView {
    id: string;
    /** 展示名（系统默认渠道按语言解析，自定义渠道是用户填的名字） */
    name: string;
    url: string;
    isEnabled: boolean;
    /** 系统默认渠道：不支持编辑/删除，只能启停 */
    isDefault: boolean;
}

function asText(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * 把配置里的渠道数组归一化成「系统默认渠道 + 用户渠道」的有序列表。
 *
 * 配置是用户可改的（也能被外部工具直接编辑），因此这里按「能救则救」处理：
 * - 配置里没有系统默认渠道时补一条（默认启用），旧版本配置升级后照样能用；
 * - 缺地址 / 缺 id 的自定义渠道直接丢弃——它们在界面上点了也只会报错；
 * - id 重复时保留先出现的那条，避免同一渠道在界面上出现两次。
 */
export function normalizeBenchmarkChannels(raw: unknown): BenchmarkChannel[] {
    const list = Array.isArray(raw) ? raw : [];
    let officialEnabled = true;
    let officialSeen = false;
    const custom: BenchmarkChannel[] = [];
    const seen = new Set<string>([OFFICIAL_CHANNEL_ID]);

    for (const item of list) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const record = item as Record<string, unknown>;
        const id = asText(record.id);
        if (!id) continue;
        const isEnabled = record.isEnabled !== false;
        if (id === OFFICIAL_CHANNEL_ID) {
            // 与自定义渠道一致：id 重复时保留先出现的那条
            if (!officialSeen) {
                officialSeen = true;
                officialEnabled = isEnabled;
            }
            continue;
        }
        const url = asText(record.url);
        if (!url) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        custom.push({ id, name: asText(record.name) || url, url, isEnabled });
    }

    // 系统默认渠道的地址始终取常量：配置里的旧地址不该盖掉当前官方地址
    return [{ id: OFFICIAL_CHANNEL_ID, name: '', url: BENCHMARK_CATALOG_URL, isEnabled: officialEnabled }, ...custom];
}

/** 校验并规范化用户输入的渠道名称 */
export function normalizeChannelName(raw: unknown): string {
    const name = asText(raw);
    if (!name) {
        throw new BenchmarkDataError(t('error.channelNameMissing'));
    }
    if (name.length > 80) {
        throw new BenchmarkDataError(t('error.channelNameTooLong'));
    }
    return name;
}

/**
 * 校验并规范化清单地址。
 *
 * 只接受 http(s)：清单会被主进程直接请求并把结果交给解析器，`file:` / `javascript:`
 * 这类协议既没有意义也不该被放行。
 */
export function normalizeChannelUrl(raw: unknown): string {
    const value = asText(raw);
    if (!value) {
        throw new BenchmarkDataError(t('error.channelUrlMissing'));
    }
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new BenchmarkDataError(t('error.channelUrlInvalid', { url: value }));
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new BenchmarkDataError(t('error.channelUrlInvalid', { url: value }));
    }
    return url.toString();
}

/** 渠道名是否已被其它渠道占用（大小写不敏感，系统默认渠道的名字也算占用） */
export function assertChannelNameAvailable(
    channels: readonly BenchmarkChannel[],
    name: string,
    officialName: string,
    exceptId?: string
): void {
    const target = name.trim().toLowerCase();
    if (!target) return;
    // 系统默认渠道不能改名，所以它的名字永远被占用
    if (officialName.trim().toLowerCase() === target) {
        throw new BenchmarkDataError(t('error.channelNameExists', { name }));
    }
    for (const channel of channels) {
        if (channel.id === OFFICIAL_CHANNEL_ID || channel.id === exceptId) continue;
        if (channel.name.trim().toLowerCase() === target) {
            throw new BenchmarkDataError(t('error.channelNameExists', { name }));
        }
    }
}

/** 渠道地址是否已被其它渠道占用 */
export function assertChannelUrlAvailable(channels: readonly BenchmarkChannel[], url: string, exceptId?: string): void {
    for (const channel of channels) {
        if (channel.id === exceptId) continue;
        if (channel.url === url) {
            throw new BenchmarkDataError(t('error.channelUrlExists', { url }));
        }
    }
}

export interface FetchChannelCatalogOptions {
    /** 请求实现：主进程传入走代理的平台 fetch */
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
}

/**
 * 联网验证渠道：把地址当作测评集清单拉下来并完整解析一遍。
 *
 * 这里刻意用严格解析（不是 registry 取清单时的「单条容错」）：用户点「确定」时
 * 要回答的是「这个地址确实是一份可用的测评集清单吗」，任何一条写坏都该让用户先修好，
 * 而不是存下来之后在测评应用里悄悄少几个测评集。
 *
 * 返回解析出来的清单项（调用方只用长度，测试里也好断言）。
 */
export async function fetchChannelCatalog(
    url: string,
    options: FetchChannelCatalogOptions = {}
): Promise<BenchmarkSummary[]> {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const timeoutMs = options.timeoutMs ?? CHANNEL_VERIFY_TIMEOUT_MS;

    let text: string;
    try {
        const response = await fetchImpl(url, {
            redirect: 'follow',
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(timeoutMs)
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        text = await response.text();
    } catch (error) {
        throw new BenchmarkDataError(t('error.channelVerifyFailed', { url, message: toErrorMessage(error) }));
    }

    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (error) {
        throw new BenchmarkDataError(t('error.channelVerifyFailed', { url, message: toErrorMessage(error) }));
    }

    const entries = parseCatalogDocument(raw, url);
    if (entries.length === 0) {
        // 语法合法但一个测评集都没有：多半是地址填到了目录页而不是清单文件
        throw new BenchmarkDataError(t('error.channelEmpty', { url }));
    }
    return entries;
}
