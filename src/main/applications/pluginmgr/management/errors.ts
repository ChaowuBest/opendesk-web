/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import {
    OpenDeskPluginPackageError,
    type OpenDeskPluginPackageErrorCode
} from '../../../../../packages/plugin-sdk/src/package.js';
import {
    parsePluginHostVersionMessage,
    parsePluginPlatformUnsupportedMessage,
    PluginHostVersionError
} from '../catalog-common.js';
import { t } from '../../../../locale/index.js';

export type PluginInstallErrorCode =
    | 'source_unavailable'
    | 'npm_unavailable'
    | 'invalid_package'
    | 'not_opendesk_plugin'
    | 'invalid_manifest'
    | 'incompatible_api'
    | 'invalid_structure'
    | 'builtin_conflict'
    | 'platform_unsupported'
    | 'host_version_too_old'
    | 'host_version_too_new'
    | 'unknown';

export interface PluginInstallResult {
    success: boolean;
    id?: string;
    error?: string;
    errorCode?: PluginInstallErrorCode;
}

export type PluginInstallStage = 'install' | 'resolve' | 'validate' | 'commit';

const PACKAGE_ERROR_CODES: Record<OpenDeskPluginPackageErrorCode, PluginInstallErrorCode> = {
    package_json_missing: 'invalid_package',
    package_json_invalid: 'invalid_package',
    package_metadata_invalid: 'invalid_package',
    plugin_declaration_missing: 'not_opendesk_plugin',
    plugin_manifest_invalid: 'invalid_manifest',
    plugin_api_incompatible: 'incompatible_api',
    plugin_structure_invalid: 'invalid_structure'
};

const ERROR_LOCALE_KEYS: Record<PluginInstallErrorCode, string> = {
    source_unavailable: 'plugin.install.error.sourceUnavailable',
    npm_unavailable: 'plugin.install.error.npmUnavailable',
    invalid_package: 'plugin.install.error.invalidPackage',
    not_opendesk_plugin: 'plugin.install.error.notOpenDeskPlugin',
    invalid_manifest: 'plugin.install.error.invalidManifest',
    incompatible_api: 'plugin.install.error.incompatibleApi',
    invalid_structure: 'plugin.install.error.invalidStructure',
    builtin_conflict: 'plugin.install.error.builtinConflict',
    platform_unsupported: 'plugin.install.error.platformUnsupported',
    host_version_too_old: 'plugin.install.error.hostVersionTooOld',
    host_version_too_new: 'plugin.install.error.hostVersionTooNew',
    unknown: 'plugin.install.error.unknown'
};

export function classifyPluginInstallError(error: unknown, stage: PluginInstallStage): PluginInstallErrorCode {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'plugin.install_npm_cli_not_found') return 'npm_unavailable';
    // 宿主版本闸门的错误先于 stage 兜底判定：它携带方向信息，一旦被当成 source_unavailable，
    // 界面与工具就拿不到「该升级宿主还是该换插件版本」的引导文案
    if (error instanceof PluginHostVersionError) {
        return error.direction === 'too_old' ? 'host_version_too_old' : 'host_version_too_new';
    }
    if (stage === 'install') return 'source_unavailable';
    if (error instanceof OpenDeskPluginPackageError) return PACKAGE_ERROR_CODES[error.code];

    if (message.startsWith('plugin.install_builtin_conflict:')) return 'builtin_conflict';
    if (message.startsWith('plugin.install_platform_unsupported:')) return 'platform_unsupported';
    if (
        message === 'plugin.install_package_not_found' ||
        message === 'plugin.install_package_ambiguous' ||
        message === 'plugin.install_invalid_id'
    ) {
        return 'invalid_package';
    }
    return 'unknown';
}

export function formatPluginInstallError(
    result: Pick<PluginInstallResult, 'errorCode' | 'error'>,
    translate: typeof t = t
): string {
    const key = ERROR_LOCALE_KEYS[result.errorCode ?? 'unknown'];
    // 平台不匹配文案带插件 id 与平台列表（与市场预检共用同一键），参数取自闸门抛出的结构化串
    if (result.errorCode === 'platform_unsupported') {
        const issue = parsePluginPlatformUnsupportedMessage(result.error);
        return translate(key, { id: issue?.id ?? '', platforms: issue?.platforms ?? '' });
    }
    return translate(key);
}

/**
 * 把安装异常翻译成宿主版本引导文案；不是宿主版本闸门的结构化错误时返回 undefined。
 *
 * `PluginMgrApplication.install` 对宿主版本不满足的失败会原样抛出结构化串
 * （渲染层要解析它弹模态）。AI 工具、TUI / CLI 等消费方用本函数换成本地化文案，
 * 避免把内部串直接展示给用户；其余错误由调用方原样处理。
 *
 * 文案与市场安装弹窗共用（`plugin.center.market.installBlockedTooOld/TooNew`），
 * 带上插件要求的范围与当前宿主版本，避免不同入口的措辞漂移。
 */
export function formatPluginInstallException(error: unknown, translate: typeof t = t): string | undefined {
    const message = error instanceof Error ? error.message : String(error);
    const issue = parsePluginHostVersionMessage(message);
    if (!issue) return undefined;
    return translate(
        issue.direction === 'too_old'
            ? 'plugin.center.market.installBlockedTooOld'
            : 'plugin.center.market.installBlockedTooNew',
        { range: issue.range, current: issue.hostVersion }
    );
}

/** 卸载在「不能卸载」这一档上返回的错误码，对应各自的专用文案 */
const UNINSTALL_ERROR_LOCALE_KEYS: Record<string, string> = {
    'plugin.uninstall_builtin': 'plugin.uninstall.builtin',
    'plugin.uninstall_invalid_path': 'plugin.uninstall.invalidPath'
};

/**
 * 把卸载失败原因（错误码或原始消息）翻译成用户可读文案。
 *
 * 只有上面这几个错误码有专用文案，其余（磁盘错误、`Plugin not found` 等）原样透出，
 * 便于用户和日志直接对上原始原因。
 */
export function formatPluginUninstallError(error: string | undefined, id: string, translate: typeof t = t): string {
    const localeKey = error === undefined ? undefined : UNINSTALL_ERROR_LOCALE_KEYS[error];
    if (localeKey) return translate(localeKey, { id });
    return error ?? translate('plugin.uninstall.fail');
}
