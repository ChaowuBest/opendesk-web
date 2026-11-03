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

import type { BenchmarkSummary, CatalogInstallState, InstalledBenchmarkSummary } from './common.js';
import { compareVersion, normalizeVersion } from '../../utils/version.js';

/**
 * 比较两个版本号，返回 -1 / 0 / 1。
 *
 * 版本按 SemVer 优先级比较（预发布低于同号正式版、构建元数据不参与排序）。
 * 无法解析成版本的字符串（历史数据里的 `2024-09` 这类自由文本）视为最低优先级，
 * 两个都无法解析时判定相等——这样旧数据不会挡住新版本，也不会反复提示更新。
 */
export function compareVersions(left: string, right: string): number {
    const leftVersion = normalizeVersion(left);
    const rightVersion = normalizeVersion(right);
    if (leftVersion === undefined || rightVersion === undefined) {
        if (leftVersion === rightVersion) return 0;
        return leftVersion === undefined ? -1 : 1;
    }
    return compareVersion(leftVersion, rightVersion) ?? 0;
}

/** 按名称（忽略大小写与首尾空白）找本地已安装的同名测评集 */
export function findLocalDatasetByName(
    datasets: readonly InstalledBenchmarkSummary[],
    name: string
): InstalledBenchmarkSummary | null {
    const target = name.trim().toLowerCase();
    if (!target) return null;
    return datasets.find((dataset) => dataset.name.trim().toLowerCase() === target) ?? null;
}

/**
 * 下载状态的定位键。
 *
 * 清单项 id 只在同一个 registry 内唯一（不同 registry 完全可能收录同一个测评集），
 * 所以按下发状态的两段信息拼一个键：`registryName` + `catalogId`。
 */
export function downloadStateKey(registryName: string, catalogId: string): string {
    return `${registryName}\u0000${catalogId}`;
}

/** 判断清单项在本地的安装状态：未安装 / 可更新（本地版本更低）/ 已是最新 */
export function resolveCatalogInstallState(
    entry: Pick<BenchmarkSummary, 'name' | 'version'>,
    datasets: readonly InstalledBenchmarkSummary[]
): CatalogInstallState {
    const local = findLocalDatasetByName(datasets, entry.name);
    if (!local) return 'not-installed';
    return compareVersions(local.version, entry.version) < 0 ? 'update-available' : 'installed';
}
