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
 * 应用里可以同时存在多个 registry（见 ./base.ts 的契约），内置的是官方测评集
 * （`official`，清单来自官网静态目录），后续要接入别的市场只需要在这里多推一个
 * 实现 `BaseBenchmarkRegistry` 的实例，界面会自动多出一个 Tab。
 */

import path from 'node:path';
import { logger } from '../../../utils/logger.js';
import { PlainBenchmarkRegistry } from './plain.js';
import type { BaseBenchmarkRegistry, BenchmarkRegistryDisplayName } from './base.js';

export type { BaseBenchmarkRegistry, BenchmarkRegistryDisplayName } from './base.js';
export { resolveBenchmarkRegistryDisplayName } from './base.js';
export { PlainBenchmarkRegistry } from './plain.js';

/** 官方测评集的线上清单地址 */
export const BENCHMARK_CATALOG_URL = 'https://opendesk.matrix.openharmony.cn/static/categories/benchmarks.json';

/** 本地调试：把官方清单换成该环境变量指向的本地 JSON 文件 */
export const BENCHMARK_CATALOG_PATH_ENV = 'OPENDESK_BENCHMARK_CATEGORY';

/** 内置官方 registry 的唯一标识符 */
export const OFFICIAL_REGISTRY_NAME = 'official';

/** 内置官方 registry 的显示名 */
export const OFFICIAL_REGISTRY_DISPLAY_NAME: BenchmarkRegistryDisplayName = {
    'zh-CN': '官方测评集',
    'en-US': 'From OpenDesk Team'
};

export interface CreateBenchmarkRegistriesOptions {
    /** benchmark 应用的数据目录：每个 registry 的清单缓存放在它下面 */
    dataDirectory: string;
    /** 请求实现，主进程传入走代理的平台 fetch */
    fetchImpl?: typeof fetch;
}

/**
 * 每个 registry 的清单缓存文件。
 *
 * name 来自 registry 自身声明，这里仍然收敛到安全字符集，避免它被当成路径分隔符用。
 */
export function benchmarkCatalogCacheFile(dataDirectory: string, name: string): string {
    const safeName = name.replaceAll(/[^A-Za-z0-9._-]+/g, '_') || 'registry';
    return path.join(dataDirectory, 'catalog-cache', `${safeName}.json`);
}

/** 构造应用启动时使用的 registry 列表 */
export function createBenchmarkRegistries(options: CreateBenchmarkRegistriesOptions): BaseBenchmarkRegistry[] {
    const localCatalogPath = (process.env[BENCHMARK_CATALOG_PATH_ENV] ?? '').trim();
    if (localCatalogPath) {
        logger.warn(`[benchmark] catalog is overridden by ${BENCHMARK_CATALOG_PATH_ENV}: ${localCatalogPath}`);
    }
    return [
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
    ];
}
