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
 * 测评集下载清单相关的纯函数。
 *
 * 单独成文件是为了让渲染层可以安全地在运行时引用：这里只依赖类型，
 * 不会把 common.ts（依赖应用词表、进而依赖主进程模块）拖进渲染层打包。
 */

import type { CatalogDatasetEntry, CatalogInstallState, DatasetSummary } from './common.js';

/**
 * 比较两个版本号，返回 -1 / 0 / 1。
 *
 * 测评集版本来自 dataset.json 的自由文本（如 `1.0`、`v1.2.3`、`2024-09`），
 * 因此按非字母数字切段：纯数字段按数值比较，其余按字典序比较，缺失段视为 0。
 */
export function compareVersions(left: string, right: string): number {
    const split = (value: string): string[] =>
        value
            .trim()
            .replace(/^v/i, '')
            .split(/[^0-9A-Za-z]+/)
            .filter((segment) => segment.length > 0);
    const a = split(left);
    const b = split(right);
    const length = Math.max(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
        const leftSegment = a[index] ?? '0';
        const rightSegment = b[index] ?? '0';
        if (/^\d+$/.test(leftSegment) && /^\d+$/.test(rightSegment)) {
            const diff = Number(leftSegment) - Number(rightSegment);
            if (diff !== 0) return diff < 0 ? -1 : 1;
            continue;
        }
        if (leftSegment === rightSegment) continue;
        return leftSegment < rightSegment ? -1 : 1;
    }
    return 0;
}

/** 按名称（忽略大小写与首尾空白）找本地已安装的同名测评集 */
export function findLocalDatasetByName(datasets: readonly DatasetSummary[], name: string): DatasetSummary | null {
    const target = name.trim().toLowerCase();
    if (!target) return null;
    return datasets.find((dataset) => dataset.name.trim().toLowerCase() === target) ?? null;
}

/** 判断清单项在本地的安装状态：未安装 / 可更新（本地版本更低）/ 已是最新 */
export function resolveCatalogInstallState(
    entry: Pick<CatalogDatasetEntry, 'name' | 'version'>,
    datasets: readonly DatasetSummary[]
): CatalogInstallState {
    const local = findLocalDatasetByName(datasets, entry.name);
    if (!local) return 'not-installed';
    return compareVersions(local.version, entry.version) < 0 ? 'update-available' : 'installed';
}
