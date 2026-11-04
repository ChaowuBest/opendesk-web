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
 * 插件 registry 的汇聚点。
 *
 * 应用里可以同时存在多个 registry（见 ./base.ts 的契约），它们来自用户配置的
 * 「插件渠道」（见 ../channels.ts）：系统默认渠道固定排第一，其后是用户添加的渠道。
 * 每个启用的渠道在「插件中心 → 插件市场」里是一个独立的插件市场，互不影响。
 */

import path from 'node:path';
import { createHash } from 'node:crypto';
import { logger } from '../../../utils/logger.js';
import { toErrorMessage } from '../../../../common/utils/error.js';
import { PlainPluginRegistry } from './plain.js';
import type { BasePluginRegistry, PluginRegistryDisplayName } from './base.js';
import { listPluginRegistryProviders, type PluginRegistryProvider } from './provider.js';
import {
    normalizePluginChannels,
    OFFICIAL_PLUGIN_CHANNEL_ID,
    PLUGIN_CATALOG_PATH_ENV,
    PLUGIN_CATALOG_URL,
    type PluginChannel
} from '../channels.js';

export type { BasePluginRegistry, PluginCatalogQuery, PluginRegistryDisplayName } from './base.js';
export { resolvePluginRegistryDisplayName } from './base.js';
export { PlainPluginRegistry } from './plain.js';
export {
    listPluginRegistryProviders,
    registerPluginRegistryProvider,
    resetPluginRegistryProviders,
    type PluginRegistryProvider,
    type PluginRegistryProviderContext
} from './provider.js';
export {
    filterCatalogByCategories,
    filterCatalogByQuery,
    paginateCatalogEntries,
    parsePluginCatalogDocument,
    PluginMarketError,
    type PluginCatalogDocument,
    type PluginCatalogEntry
} from './catalog.js';
export {
    MAX_PLUGIN_CHANNELS,
    OFFICIAL_PLUGIN_CHANNEL_ID,
    PLUGIN_CATALOG_PATH_ENV,
    PLUGIN_CATALOG_URL,
    type PluginChannel,
    type PluginChannelView
} from '../channels.js';

/** 内置官方渠道对应的 registry 名；同时是它的清单缓存文件名 */
export const OFFICIAL_REGISTRY_NAME = OFFICIAL_PLUGIN_CHANNEL_ID;

/** 内置官方渠道的显示名（系统默认渠道按语言显示） */
export const OFFICIAL_REGISTRY_DISPLAY_NAME: PluginRegistryDisplayName = {
    'zh-CN': '官方插件市场',
    'en-US': 'Official Marketplace'
};

export interface CreatePluginRegistriesOptions {
    /** pluginmgr 应用的数据目录：每个 registry 的清单缓存放在它下面 */
    dataDirectory: string;
    /** 用户配置的渠道列表；省略时只启用系统默认渠道 */
    channels?: unknown;
    /** 请求实现，主进程传入走代理的平台 fetch */
    fetchImpl?: typeof fetch;
}

/**
 * 每个 registry 的清单缓存文件。
 *
 * name 来自 registry 自身声明（自定义渠道来自用户配置的渠道 id），这里仍然收敛到
 * 安全字符集，避免它被当成路径分隔符用。
 */
export function pluginCatalogCacheFile(dataDirectory: string, name: string): string {
    const safeName = name.replaceAll(/[^A-Za-z0-9._-]+/g, '_') || 'registry';
    return path.join(dataDirectory, 'plugin-catalog-cache', `${safeName}.json`);
}

/**
 * 自定义渠道的清单缓存文件：文件名带上清单地址的短哈希。
 *
 * 用户改掉渠道地址后，旧地址的缓存文件仍然「新鲜」（5 分钟内），若继续复用同一个
 * 文件名，改完地址后的几分钟里市场里显示的还是旧渠道的插件。把地址纳入文件名，
 * 换地址就等于换缓存，不需要额外失效逻辑。
 */
export function customPluginChannelCacheFile(dataDirectory: string, channelId: string, url: string): string {
    const digest = createHash('sha1').update(url).digest('hex').slice(0, 8);
    return pluginCatalogCacheFile(dataDirectory, `${channelId}-${digest}`);
}

/**
 * 构造应用启动时使用的 registry 列表。
 *
 * 只有启用的渠道才会被构造：禁用渠道的清单既不该拉取，也不该在插件市场里出现。
 */
export function createPluginRegistries(options: CreatePluginRegistriesOptions): BasePluginRegistry[] {
    const localCatalogPath = (process.env[PLUGIN_CATALOG_PATH_ENV] ?? '').trim();
    if (localCatalogPath) {
        logger.warn(`[pluginmgr] plugin catalog is overridden by ${PLUGIN_CATALOG_PATH_ENV}: ${localCatalogPath}`);
    }

    const providers = listPluginRegistryProviders();
    const registries: BasePluginRegistry[] = [];
    for (const channel of normalizePluginChannels(options.channels)) {
        if (!channel.isEnabled) continue;
        // 先问 provider：能接管这个渠道的（未来的新市场协议）优先，其余落到内置的清单实现
        const provided = takeOverByProvider(channel, providers, options);
        if (provided) {
            registries.push(provided);
            continue;
        }
        if (channel.id === OFFICIAL_PLUGIN_CHANNEL_ID) {
            registries.push(
                new PlainPluginRegistry(
                    OFFICIAL_REGISTRY_NAME,
                    OFFICIAL_REGISTRY_DISPLAY_NAME,
                    localCatalogPath || PLUGIN_CATALOG_URL,
                    {
                        // 本地调试清单直接读文件，不落缓存
                        cacheFile: localCatalogPath
                            ? undefined
                            : pluginCatalogCacheFile(options.dataDirectory, OFFICIAL_REGISTRY_NAME),
                        fetchImpl: options.fetchImpl
                    }
                )
            );
            continue;
        }
        registries.push(
            new PlainPluginRegistry(channel.id, channel.name || channel.url, channel.url, {
                cacheFile: customPluginChannelCacheFile(options.dataDirectory, channel.id, channel.url),
                fetchImpl: options.fetchImpl
            })
        );
    }
    return registries;
}

/** 让已注册的 provider 认领渠道；没人认领时返回 undefined，由内置实现兜底 */
function takeOverByProvider(
    channel: PluginChannel,
    providers: readonly PluginRegistryProvider[],
    options: CreatePluginRegistriesOptions
): BasePluginRegistry | undefined {
    if (providers.length === 0) return undefined;
    const context = { dataDirectory: options.dataDirectory, fetchImpl: options.fetchImpl };
    for (const provider of providers) {
        let handled = false;
        try {
            handled = provider.supports(channel);
        } catch (error) {
            // provider 自己判断出错不该让整个市场列表空掉：记一条日志，继续问下一个
            logger.warn(`[pluginmgr] registry provider ${provider.id} supports() failed: ${toErrorMessage(error)}`);
            continue;
        }
        if (!handled) continue;
        try {
            const registry = provider.create(channel, context);
            if (registry) return registry;
        } catch (error) {
            logger.warn(`[pluginmgr] registry provider ${provider.id} create() failed: ${toErrorMessage(error)}`);
        }
    }
    return undefined;
}
