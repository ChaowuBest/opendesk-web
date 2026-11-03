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
 * 测评集 registry 的公共契约。
 *
 * 一个 registry 就是一处测评集来源（官网清单、第三方市场、企业内网镜像……）。
 * 每个 registry 在测评应用界面里占一个独立的 Tab，注册表之间互不影响：
 * 某个 registry 拉不到清单只是它自己那个 Tab 报错，不会连带其它 Tab。
 */

import type { BenchmarkSummary } from '../common.js';

/**
 * registry 的显示名。
 *
 * 给字符串时所有语言共用同一个名字；给映射时按 locale 取（键形如 `zh-CN` / `en-US`，
 * 大小写与 `_`/`-` 差异会被归一化，取不到再退回语言主标签、最后退回第一个值）。
 */
export type BenchmarkRegistryDisplayName = string | Record<string, string>;

export interface BaseBenchmarkRegistry {
    /** 唯一标识符：同一次运行内不重名，用于按 registry 定位清单、下载记录与界面 Tab */
    readonly name: string;
    readonly displayName: BenchmarkRegistryDisplayName;
    /**
     * 取该 registry 的测评集清单。
     *
     * @param startAt 跳过前多少条，默认 0
     * @param limit 最多取多少条；省略表示取到末尾
     */
    getCatalog(startAt?: number, limit?: number): Promise<BenchmarkSummary[]>;
    /** 该 registry 一共收录多少个测评集 */
    getBenchmarkCount(): Promise<number>;
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
export function resolveBenchmarkRegistryDisplayName(displayName: BenchmarkRegistryDisplayName, locale: string): string {
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
