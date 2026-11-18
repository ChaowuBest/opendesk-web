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
 * 插件 registry 的公共契约。
 *
 * 一个 registry 就是一处插件来源（官方市场、第三方市场、企业内网镜像……），
 * 每个 registry 在「插件中心 → 插件市场」里是一个独立的插件市场，互不影响：
 * 某个 registry 拉不到清单只是它自己那个市场报错，不会连带其它市场。
 */

import type { PluginCatalogEntry } from './catalog.js';

/**
 * registry 的显示名。
 *
 * 给字符串时所有语言共用同一个名字；给映射时按 locale 取（键形如 `zh-CN` / `en-US`，
 * 大小写与 `_`/`-` 差异会被归一化，取不到再退回语言主标签、最后退回第一个值）。
 */
export type PluginRegistryDisplayName = string | Record<string, string>;

/**
 * 取清单的查询参数。
 *
 * `startAt` / `limit` 与 benchmark 的 `BaseBenchmarkRegistry.getCatalog(startAt, limit)`
 * 同义（`startAt` 默认 0、省略 `limit` 表示取到末尾，切片在 registry 侧完成），
 * 只是这里多了一个分类过滤，所以收进一个对象而不是加第三个位置参数。
 *
 * 目的：让未来的大型市场（分页 RPC / 增量索引）能在不改契约的前提下按页取用；
 * 内置的 HTTP 清单实现是「拉全量 → 过滤 → 切片」，界面上目前也一次取全量。
 */
export interface PluginCatalogQuery {
    /** 从第几条开始取，默认 0；负数与非整数会被夹到 0 */
    startAt?: number;
    /** 最多取多少条；省略表示取到末尾，0 表示不取 */
    limit?: number;
    /** 只取这些分类下的插件；省略（或空数组）表示取全部 */
    categories?: string[];
}

export interface BasePluginRegistry {
    /** 唯一标识符：同一次运行内不重名，用于按 registry 定位清单、下载记录与界面 */
    readonly name: string;
    readonly displayName: PluginRegistryDisplayName;
    /**
     * 该 registry 支持的插件分类，按仓库声明顺序排列。
     *
     * 为 undefined 表示这个仓库不支持按插件类型分类显示——界面上也就不会出现
     * 「全部插件 / 分类A / 分类B」那一排切换按钮。分类以 registry 自述为准，
     * 因此它是只读的，界面上没有「新建分类」这类入口。
     */
    readonly categories?: string[];
    /**
     * 取该 registry 的插件清单。
     *
     * @param query 分类过滤与分页；省略表示「全部插件、从第一条取到末尾」
     */
    getCatalog(query?: PluginCatalogQuery): Promise<PluginCatalogEntry[]>;
    /**
     * 该 registry 一共收录多少个插件（可限定分类）。
     *
     * 只数不收分页参数：分页是「怎么取」，不影响总数——界面将来做分页时用它算总页数。
     */
    getPluginCount(query?: Pick<PluginCatalogQuery, 'categories'>): Promise<number>;
    /**
     * 手动刷新：丢弃已有缓存，让下一次取清单重新拉取。
     * 没有缓存概念的 registry 可以不实现，界面上的「刷新」就只是重新取一次。
     */
    invalidate?(): void;
}

/**
 * 按 locale 解析显示名。
 *
 * @param displayName registry 声明的显示名
 * @param locale 当前语言（`zh-CN` / `en-US` 这类 BCP 47 标签）
 */
export function resolvePluginRegistryDisplayName(displayName: PluginRegistryDisplayName, locale: string): string {
    if (typeof displayName === 'string') return displayName;
    const normalize = (value: string) => value.trim().toLowerCase().replaceAll('_', '-');
    const target = normalize(locale);
    const entries = Object.entries(displayName).filter(([, value]) => typeof value === 'string' && value.trim());
    if (entries.length === 0) return '';
    for (const [key, value] of entries) {
        if (normalize(key) === target) return value;
    }
    const language = target.split('-')[0];
    for (const [key, value] of entries) {
        if (normalize(key).split('-')[0] === language) return value;
    }
    return entries[0][1];
}
