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
 * 宿主版本号与 SemVer 工具。
 *
 * 插件清单、测评集清单、ACP 客户端握手、CLI 自升级、桌面端更新器等处的版本号
 * 统一在这里解析与比较，避免各模块各写一套比较规则（历史上存在多套语义不一致的实现）：
 * - 测评集清单的「非 SemVer 视为最低优先级」等业务策略留在调用方，这里只给通用能力；
 * - 桌面端更新器额外只接受 `x.y.z` 稳定版本（见 updater/release-feed.ts），比较语义仍然复用这里。
 *
 * 注意：测评集的渲染层（benchmark/catalog-common.ts）也会 import 本文件来比较版本，
 * 所以这里必须保持「零 Node 依赖」，只允许 import 纯 JS 的 semver。
 */

import semver from 'semver';

/** 宿主运行时版本号；由 scripts/sync-version.mjs 随 package.json 同步 */
export const OPENDESK_RUNTIME_VERSION = '0.4.1';

/**
 * 严格解析 SemVer（允许 `v` 前缀与首尾空白，由 semver 自身放宽）。
 * @returns 解析失败返回 undefined，不抛异常
 */
function parseVersion(value: string | null | undefined): semver.SemVer | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return semver.parse(trimmed) ?? undefined;
}

/** 是否为合法 SemVer */
export function isValidVersion(value: string | null | undefined): boolean {
    return parseVersion(value) !== undefined;
}

/**
 * 归一化成 SemVer 规范形式。
 *
 * 兼容历史上出现过的两段式写法（如 `0.2`），补齐 PATCH 后按 SemVer 处理；
 * 无法识别成版本的字符串（如 `2024-09`）返回 undefined，由调用方决定拒绝还是放行。
 */
export function normalizeVersion(value: string | null | undefined): string | undefined {
    const parsed = parseVersion(value);
    if (parsed) return parsed.version;
    if (typeof value !== 'string') return undefined;
    const twoSegment = value.trim().match(/^v?(\d+)\.(\d+)$/i);
    if (!twoSegment) return undefined;
    return parseVersion(`${twoSegment[1]}.${twoSegment[2]}.0`)?.version;
}

/**
 * 按 SemVer 优先级比较两个版本。
 * @returns 1 / 0 / -1；任一方不是合法 SemVer 时返回 undefined
 */
export function compareVersion(left: string | null | undefined, right: string | null | undefined): number | undefined {
    const a = parseVersion(left);
    const b = parseVersion(right);
    if (!a || !b) return undefined;
    return semver.compare(a, b);
}

/**
 * 远端版本是否严格新于本地版本。
 *
 * 用于「有没有新版本可以装」这类判断（设置界面的检查更新、CLI 自升级）：
 * 本地版本可能是预发布或开发构建（`0.4.0-beta.1`、`0.0.0-dev` 之类），
 * 所以不能要求本地也必须是正式版——`0.4.0` 相对 `0.4.0-beta.1` 就算更新；
 * 反过来远端落后于本地（回滚、手动装了更高版本）时不算更新，避免把降级当成升级。
 * 任一侧解析不了时退化为字符串不等，宁可多提示也不漏掉真更新。
 */
export function isNewerVersion(latest: string | null | undefined, current: string | null | undefined): boolean {
    if (!latest || !current) return false;
    const comparison = compareVersion(latest, current);
    return comparison === undefined ? latest !== current : comparison > 0;
}
