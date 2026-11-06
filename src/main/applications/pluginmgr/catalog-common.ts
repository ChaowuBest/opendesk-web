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
 * 插件市场清单相关的纯函数（与 benchmark 的 catalog-common.ts 同构）。
 *
 * 单独成文件是为了让渲染层可以安全地在运行时引用：这里只依赖类型与版本工具，
 * 不会把主进程模块拖进渲染层打包。市场卡片上的「已安装 / 可更新 / 无法安装」
 * 与主进程安装前的拦截共用同一套判定，避免界面显示能装、装下去却被拒。
 */

import { compareVersion, normalizeVersion, OPENDESK_RUNTIME_VERSION } from '../../utils/version.js';

/**
 * 市场条目相对本地已安装插件的状态。
 *
 * - `not-installed`：本地没装
 * - `installed`：已安装且不比清单旧（含清单没声明版本、两边版本都无法解析的情况）
 * - `update-available`：清单版本高于本地版本
 */
export type PluginMarketInstallState = 'not-installed' | 'installed' | 'update-available';

/**
 * 比较两个版本号，返回 -1 / 0 / 1。
 *
 * 与 benchmark 同口径：无法解析的视为最低优先级，两边都无法解析时判定相等。
 * 插件侧额外把「清单没声明版本」当成无法比较（不会因此提示更新）——重装插件会重启插件，
 * 不能像测评集那样"没版本就让人重下一次"。
 */
function compareVersions(left: string | undefined, right: string | undefined): number | undefined {
    if (!left || !right) return undefined;
    const leftVersion = normalizeVersion(left);
    const rightVersion = normalizeVersion(right);
    if (leftVersion === undefined || rightVersion === undefined) return undefined;
    return compareVersion(leftVersion, rightVersion);
}

/**
 * 清单条目相对本地已安装插件的状态。
 *
 * @param installed 本地是否已安装（按插件 id 判断）
 * @param installedVersion 本地已安装版本（清单/清单元数据里可能没声明版本）
 * @param catalogVersion 市场清单声明的版本
 */
export function resolveMarketInstallState(
    installed: boolean,
    installedVersion: string | undefined,
    catalogVersion: string | undefined
): PluginMarketInstallState {
    if (!installed) return 'not-installed';
    const order = compareVersions(installedVersion, catalogVersion);
    // 任一侧没有可比较的版本时按「已是最新」处理：无从判断就不打扰用户；
    // 想主动换一版可以卸载后再装，CLI 的 plugins install 也支持覆盖安装
    return order !== undefined && order < 0 ? 'update-available' : 'installed';
}

/** 宿主版本上下界（含边界；省略表示该侧不限） */
export interface HostVersionRange {
    minOpenDeskVersion?: string;
    maxOpenDeskVersion?: string;
}

/**
 * 当前宿主版本是否落在条目声明支持的范围内。
 *
 * 与插件清单的 minOpenDeskVersion / maxOpenDeskVersion 同义：SemVer、含边界、
 * 省略表示不限。声明了却解析不了的上下界按「不满足」处理——宁可拦下来，
 * 也不要把一个装完必然加载失败的包装进用户机器。
 */
export function isHostVersionCompatible(
    range: HostVersionRange,
    hostVersion: string = OPENDESK_RUNTIME_VERSION
): boolean {
    const host = normalizeVersion(hostVersion);
    if (host === undefined) return true;
    if (range.minOpenDeskVersion) {
        const min = normalizeVersion(range.minOpenDeskVersion);
        if (min === undefined || (compareVersion(host, min) ?? 0) < 0) return false;
    }
    if (range.maxOpenDeskVersion) {
        const max = normalizeVersion(range.maxOpenDeskVersion);
        if (max === undefined || (compareVersion(host, max) ?? 0) > 0) return false;
    }
    return true;
}

/**
 * 把上下界拼成一句给人看的范围描述，例如 `≥ 1.2.0`、`≤ 2.0.0`、`1.2.0 – 2.0.0`。
 *
 * 只拼数学符号，不含文字：调用方把它放进本地化模板（「需要 OpenDesk ${range}」）。
 * 两侧都没声明时返回 undefined。
 */
export function describeHostVersionRange(range: HostVersionRange): string | undefined {
    const min = range.minOpenDeskVersion?.trim();
    const max = range.maxOpenDeskVersion?.trim();
    if (min && max) return `${min} – ${max}`;
    if (min) return `≥ ${min}`;
    if (max) return `≤ ${max}`;
    return undefined;
}
