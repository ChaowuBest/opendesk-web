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

/** 宿主版本不满足的具体方向：`too_old` 是宿主低于下界，`too_new` 是宿主高于上界 */
export type HostVersionIssueDirection = 'too_old' | 'too_new';

/**
 * 宿主版本违反了声明的哪一侧；兼容（或无从判断）时返回 undefined。
 *
 * 版本比较只写在这一处：`isHostVersionCompatible`、`describeHostVersionIssue` 以及
 * 安装期闸门 / 市场卡片 / 加载期诊断都基于它，避免各处口径漂移。
 *
 * 与插件清单的 minOpenDeskVersion / maxOpenDeskVersion 同义：SemVer、含边界、
 * 省略（含空白）表示不限。声明了却解析不了的上下界按「不满足」处理——宁可拦下来，
 * 也不要把一个装完必然加载失败的包装进用户机器。宿主版本自身无法解析时无从判断，
 * 按放行处理。
 */
function resolveHostVersionViolation(
    range: HostVersionRange,
    hostVersion: string
): HostVersionIssueDirection | undefined {
    const host = normalizeVersion(hostVersion);
    if (host === undefined) return undefined;
    if (range.minOpenDeskVersion?.trim()) {
        const min = normalizeVersion(range.minOpenDeskVersion);
        if (min === undefined || (compareVersion(host, min) ?? 0) < 0) return 'too_old';
    }
    if (range.maxOpenDeskVersion?.trim()) {
        const max = normalizeVersion(range.maxOpenDeskVersion);
        if (max === undefined || (compareVersion(host, max) ?? 0) > 0) return 'too_new';
    }
    return undefined;
}

/** 当前宿主版本是否落在条目声明支持的范围内（见 resolveHostVersionViolation） */
export function isHostVersionCompatible(
    range: HostVersionRange,
    hostVersion: string = OPENDESK_RUNTIME_VERSION
): boolean {
    return resolveHostVersionViolation(range, hostVersion) === undefined;
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

/**
 * 从插件市场安装的结果。
 *
 * 主进程 `installFromPluginRegistry` 的返回值与渲染层收到的形状必须一致，
 * 类型定义放在本模块（渲染层可安全引用）由两侧共用，避免字段各写一份后漂移。
 *
 * 失败时**不抛错**而是返回（`success: false`），因为界面要对「上架信息与包内清单不一致」
 * 或「宿主版本不满足」单独弹模态弹窗强调；其余失败（下载不了、内置冲突、id 对不上……）
 * 仍然抛错，走的是统一的错误提示路径。
 */
export type PluginMarketInstallOutcome =
    | { success: true; id?: string }
    | {
          success: false;
          /** `manifest_mismatch` 表示包内清单与市场条目对不上 */
          code: 'manifest_mismatch';
          /** 给用户看的原因（已本地化） */
          message: string;
      }
    | {
          success: false;
          /** `host_version` 表示当前 OpenDesk 不满足插件声明的宿主版本范围，安装已被拒绝 */
          code: 'host_version';
          /** 不满足的方向：宿主低于下界（too_old）/ 高于上界（too_new） */
          direction: HostVersionIssueDirection;
          /** 插件声明的版本范围描述（如 `≥ 1.0.0`） */
          range: string;
          /** 拦截时的宿主版本 */
          current: string;
          /** 给用户看的原因（已本地化；界面弹窗优先使用上面的结构化字段自行本地化） */
          message: string;
      };

/** 宿主版本不满足的具体方向与范围描述 */
export interface HostVersionIssue {
    direction: HostVersionIssueDirection;
    /** 插件声明的版本范围描述（见 describeHostVersionRange），直接放进本地化模板 */
    range: string;
}

/**
 * 宿主版本不满足时给出方向与范围描述；满足时返回 undefined。
 *
 * 安装期的宿主版本闸门、市场条目的「无法安装」提示共用这一份判定，
 * 避免多处口径漂移。min/max 都声明却仍不满足时（min > max 的坏数据）优先按
 * too_old 报告——反正装不上，方向只影响提示文案。
 */
export function describeHostVersionIssue(
    range: HostVersionRange,
    hostVersion: string = OPENDESK_RUNTIME_VERSION
): HostVersionIssue | undefined {
    const direction = resolveHostVersionViolation(range, hostVersion);
    if (direction === undefined) return undefined;
    return { direction, range: describeHostVersionRange(range) ?? '' };
}

/** PluginHostVersionError.message 的前缀：渲染层据此识别「宿主版本不满足」的安装失败 */
export const PLUGIN_HOST_VERSION_MESSAGE_PREFIX = 'plugin.install_host_version:';

export interface PluginHostVersionIssueData {
    direction: HostVersionIssueDirection;
    /** 插件声明的版本范围描述（如 `≥ 1.0.0`） */
    range: string;
    /** 拦截时的宿主版本 */
    hostVersion: string;
}

/**
 * 宿主版本不满足插件要求时在安装期抛出。
 *
 * message 是稳定格式的结构化串（`plugin.install_host_version:<direction>:<range>:<hostVersion>`）：
 * 分类与渲染层解析都靠它，不要改成人类可读文案。
 */
export class PluginHostVersionError extends Error {
    constructor(
        readonly direction: HostVersionIssueDirection,
        readonly range: string,
        readonly hostVersion: string
    ) {
        super(`${PLUGIN_HOST_VERSION_MESSAGE_PREFIX}${direction}:${range}:${hostVersion}`);
        this.name = 'PluginHostVersionError';
    }
}

/** 解析 PluginHostVersionError 的 message；不是宿主版本错误（或缺字段）时返回 undefined */
export function parsePluginHostVersionMessage(message: string): PluginHostVersionIssueData | undefined {
    if (!message.startsWith(PLUGIN_HOST_VERSION_MESSAGE_PREFIX)) return undefined;
    const rest = message.slice(PLUGIN_HOST_VERSION_MESSAGE_PREFIX.length);
    const directionEnd = rest.indexOf(':');
    if (directionEnd <= 0) return undefined;
    const direction = rest.slice(0, directionEnd);
    if (direction !== 'too_old' && direction !== 'too_new') return undefined;
    const hostVersionStart = rest.lastIndexOf(':');
    if (hostVersionStart <= directionEnd) return undefined;
    return {
        direction,
        range: rest.slice(directionEnd + 1, hostVersionStart),
        hostVersion: rest.slice(hostVersionStart + 1)
    };
}

/** 平台闸门结构化串前缀：`plugin.install_platform_unsupported:<id>:<platforms>`。分类与渲染层解析都靠它，不要改成人类可读文案 */
export const PLUGIN_PLATFORM_UNSUPPORTED_MESSAGE_PREFIX = 'plugin.install_platform_unsupported:';

/** 平台闸门结构化串的载荷：插件 id 与其支持的平台列表 */
export interface PluginPlatformUnsupportedIssue {
    id: string;
    platforms: string;
}

/**
 * 解析安装期平台闸门抛出的结构化串；不是该前缀（或缺字段）时返回 undefined。
 *
 * 插件 id 由 assertSafePluginId 限制为 `[a-zA-Z][a-zA-Z0-9._-]*`，不含冒号，
 * 所以首个冒号就是 id 与平台列表的分隔。
 */
export function parsePluginPlatformUnsupportedMessage(
    message: string | undefined
): PluginPlatformUnsupportedIssue | undefined {
    if (!message?.startsWith(PLUGIN_PLATFORM_UNSUPPORTED_MESSAGE_PREFIX)) return undefined;
    const rest = message.slice(PLUGIN_PLATFORM_UNSUPPORTED_MESSAGE_PREFIX.length);
    const separator = rest.indexOf(':');
    if (separator <= 0) return undefined;
    const id = rest.slice(0, separator);
    const platforms = rest.slice(separator + 1);
    if (!id || !platforms) return undefined;
    return { id, platforms };
}

/**
 * 有专用文案的加载期诊断码 → locale 词条（src/locale 的 plugin.diagnostic.*）。
 *
 * 渲染层插件中心与 CLI `plugins status` 共用；不在表里的诊断码保持
 * `stage/code: detail` 原样输出（面向开发者的原始信息，不做本地化）。
 */
export const PLUGIN_DIAGNOSTIC_LOCALE_KEYS: Record<string, string> = {
    'plugin.opendesk_version_too_old': 'plugin.diagnostic.opendeskVersionTooOld',
    'plugin.opendesk_version_too_new': 'plugin.diagnostic.opendeskVersionTooNew'
};

/**
 * 把一条加载期诊断渲染成给用户看的文案。
 *
 * 有映射的诊断码走本地化模板（detail 作为插值参数），其余保持
 * `stage/code: detail` 原样——那部分是面向开发者的原始信息。
 */
export function formatPluginDiagnostic(
    diagnostic: { stage: string; code: string; detail?: string },
    translate: (key: string, params?: Record<string, string | number>) => string
): string {
    const localeKey = PLUGIN_DIAGNOSTIC_LOCALE_KEYS[diagnostic.code];
    if (localeKey) {
        return diagnostic.detail ? translate(localeKey, { detail: diagnostic.detail }) : translate(localeKey);
    }
    return `${diagnostic.stage}/${diagnostic.code}${diagnostic.detail ? `: ${diagnostic.detail}` : ''}`;
}
