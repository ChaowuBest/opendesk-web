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
 * 「测评集下载」的静态清单。
 *
 * 每条清单项除 `downloadUrl` 外，字段语义与测评集自带的 dataset.json 保持一致
 * （name / description / homepage / version / tracks），发新版本时同步改 `version`
 * 与 `downloadUrl` 即可，界面会按版本号自动给出「下载」或「更新」。
 *
 * 调试下载流程时直接把这里的 downloadUrl 指到本地起的压缩包地址即可。
 */

import type { CatalogDatasetEntry } from './common.js';

const ENTRIES: CatalogDatasetEntry[] = [
    {
        id: 'workbuddy-bench',
        name: 'WorkBuddy Bench',
        description:
            'WorkBuddy Bench 的 Office 与 Code 两个 track：Office 50 个办公文件处理用例，Code 80 个仓库级软件工程用例。',
        homepage: 'https://github.com/Tencent/workbuddy-bench',
        version: '0.1',
        downloadUrl:
            'https://gitcode.com/openharmony-robot/OpenDesk/releases/download/benchmarks/workbuddy-bench-0.1.zip',
        tracks: [
            {
                id: 'office',
                name: 'Office',
                description: '办公文件处理（xlsx / csv / pdf / docx），评分 = pytest 规则分 + LLM rubric 分'
            },
            {
                id: 'code',
                name: 'Code',
                description: '仓库级软件工程（Python），评分 = 注入测试后的 pytest 通过率'
            }
        ]
    }
];

/** 列出下载清单 */
export function listCatalogDatasets(): CatalogDatasetEntry[] {
    return ENTRIES.map((entry) => ({ ...entry, tracks: [...entry.tracks] }));
}

/** 按清单 id 查一条清单项；不存在时返回 null */
export function findCatalogDataset(catalogId: string): CatalogDatasetEntry | null {
    const target = catalogId.trim();
    if (!target) return null;
    return listCatalogDatasets().find((entry) => entry.id === target) ?? null;
}
