/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import {
    OpenDeskPluginPackageError,
    type OpenDeskPluginPackageErrorCode
} from '../../../../../packages/plugin/src/package.js';
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
