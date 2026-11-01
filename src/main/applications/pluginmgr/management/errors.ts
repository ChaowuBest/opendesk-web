/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import {
    OpenDeskPluginPackageError,
    type OpenDeskPluginPackageErrorCode
} from '../../../../../packages/plugin-sdk/src/package.js';
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
    unknown: 'plugin.install.error.unknown'
};

export function classifyPluginInstallError(error: unknown, stage: PluginInstallStage): PluginInstallErrorCode {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'plugin.install_npm_cli_not_found') return 'npm_unavailable';
    if (stage === 'install') return 'source_unavailable';
    if (error instanceof OpenDeskPluginPackageError) return PACKAGE_ERROR_CODES[error.code];

    if (message.startsWith('plugin.install_builtin_conflict:')) return 'builtin_conflict';
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
    result: Pick<PluginInstallResult, 'errorCode'>,
    translate: typeof t = t
): string {
    return translate(ERROR_LOCALE_KEYS[result.errorCode ?? 'unknown']);
}

/** 卸载在「不能卸载」这一档上返回的错误码，对应各自的专用文案 */
const UNINSTALL_ERROR_LOCALE_KEYS: Record<string, string> = {
    'plugin.uninstall_builtin': 'plugin.uninstall.builtin',
    'plugin.uninstall_external': 'plugin.uninstall.external',
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
