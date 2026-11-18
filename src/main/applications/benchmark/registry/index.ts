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
 * 测评集 registry 的汇聚点。
 *
 * 应用里可以同时存在多个 registry（见 ./base.ts 的契约），它们来自用户配置的
 * 「测评集仓库」（见 ../channels.ts）：系统默认仓库固定排第一，其后是用户添加的仓库。
 * 每个启用的仓库在测评应用界面里占一个独立的 Tab，注册表之间互不影响。
 */

import path from 'node:path';
import { createHash } from 'node:crypto';
import { logger } from '../../../utils/logger.js';
import { PlainBenchmarkRegistry } from './plain.js';
import type { BaseBenchmarkRegistry, BenchmarkRegistryDisplayName } from './base.js';
import {
    BENCHMARK_CATALOG_PATH_ENV,
    BENCHMARK_CATALOG_URL,
    normalizeBenchmarkChannels,
    OFFICIAL_CHANNEL_ID
} from '../channels.js';

export type { BaseBenchmarkRegistry, BenchmarkRegistryDisplayName } from './base.js';
export { resolveBenchmarkRegistryDisplayName } from './base.js';
export { PlainBenchmarkRegistry } from './plain.js';
export {
    BENCHMARK_CATALOG_PATH_ENV,
    BENCHMARK_CATALOG_URL,
    MAX_BENCHMARK_CHANNELS,
    OFFICIAL_CHANNEL_ID,
    type BenchmarkChannel,
    type BenchmarkChannelView
} from '../channels.js';

/** 内置官方仓库对应的 registry 名；同时是它的清单缓存文件名 */
export const OFFICIAL_REGISTRY_NAME = OFFICIAL_CHANNEL_ID;

/** 内置官方仓库的显示名（系统默认仓库按语言显示） */
export const OFFICIAL_REGISTRY_DISPLAY_NAME: BenchmarkRegistryDisplayName = {
    'zh-CN': '官方测评集',
    'en-US': 'From OpenDesk Team'
};

export interface CreateBenchmarkRegistriesOptions {
    /** benchmark 应用的数据目录：每个 registry 的清单缓存放在它下面 */
    dataDirectory: string;
    /** 用户配置的仓库列表；省略时只启用系统默认仓库 */
    channels?: unknown;
    /** 请求实现，主进程传入走代理的平台 fetch */
    fetchImpl?: typeof fetch;
}

/**
 * 每个 registry 的清单缓存文件。
 *
 * name 来自 registry 自身声明（自定义仓库来自用户配置的仓库 id），这里仍然收敛到
 * 安全字符集，避免它被当成路径分隔符用。
 */
export function benchmarkCatalogCacheFile(dataDirectory: string, name: string): string {
    const safeName = name.replaceAll(/[^A-Za-z0-9._-]+/g, '_') || 'registry';
    return path.join(dataDirectory, 'catalog-cache', `${safeName}.json`);
}

/**
 * 自定义仓库的清单缓存文件：文件名带上清单地址的短哈希。
 *
 * 用户改掉仓库地址后，旧地址的缓存文件仍然「新鲜」（5 分钟内），若继续复用同一个
 * 文件名，改完地址后的几分钟里 Tab 里显示的还是旧仓库的测评集。把地址纳入文件名，
 * 换地址就等于换缓存，不需要额外失效逻辑。
 */
export function customChannelCacheFile(dataDirectory: string, channelId: string, url: string): string {
    const digest = createHash('sha1').update(url).digest('hex').slice(0, 8);
    return benchmarkCatalogCacheFile(dataDirectory, `${channelId}-${digest}`);
}

/**
 * 构造应用启动时使用的 registry 列表。
 *
 * 只有启用的仓库才会被构造：禁用仓库的清单既不该拉取，也不该在界面上占 Tab。
 */
export function createBenchmarkRegistries(options: CreateBenchmarkRegistriesOptions): BaseBenchmarkRegistry[] {
    const localCatalogPath = (process.env[BENCHMARK_CATALOG_PATH_ENV] ?? '').trim();
    if (localCatalogPath) {
        logger.warn(`[benchmark] catalog is overridden by ${BENCHMARK_CATALOG_PATH_ENV}: ${localCatalogPath}`);
    }

    const registries: BaseBenchmarkRegistry[] = [];
    for (const channel of normalizeBenchmarkChannels(options.channels)) {
        if (!channel.isEnabled) continue;
        if (channel.id === OFFICIAL_CHANNEL_ID) {
            registries.push(
                new PlainBenchmarkRegistry(
                    OFFICIAL_REGISTRY_NAME,
                    OFFICIAL_REGISTRY_DISPLAY_NAME,
                    localCatalogPath || BENCHMARK_CATALOG_URL,
                    {
                        // 本地调试清单直接读文件，不落缓存
                        cacheFile: localCatalogPath
                            ? undefined
                            : benchmarkCatalogCacheFile(options.dataDirectory, OFFICIAL_REGISTRY_NAME),
                        fetchImpl: options.fetchImpl
                    }
                )
            );
            continue;
        }
        registries.push(
            new PlainBenchmarkRegistry(channel.id, channel.name || channel.url, channel.url, {
                cacheFile: customChannelCacheFile(options.dataDirectory, channel.id, channel.url),
                fetchImpl: options.fetchImpl
            })
        );
    }
    return registries;
}
