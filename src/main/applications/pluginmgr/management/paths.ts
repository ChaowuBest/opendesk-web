/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getOpendeskDirectory } from '../../../utils/setting.js';

export const BUILTIN_PLUGINS_DIRECTORY_ENV = 'OPENDESK_BUILTIN_PLUGINS_DIRECTORY';

export function getPluginsDirectory(configDirectory: string = getOpendeskDirectory()): string {
    return path.join(configDirectory, 'plugins');
}

export function getBuiltinPluginsDirectory(): string {
    const configured = process.env[BUILTIN_PLUGINS_DIRECTORY_ENV];
    if (configured) return path.resolve(configured);

    const electronProcess = process as NodeJS.Process & {
        defaultApp?: boolean;
        resourcesPath?: string;
    };
    if (electronProcess.resourcesPath && electronProcess.defaultApp !== true) {
        return path.join(electronProcess.resourcesPath, 'plugins');
    }

    // chunk 位于 dist/main/chunks/，内置插件由 build-builtin-plugins 输出到 dist/plugins/
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins');
}

export function getPluginManagerDirectory(configDirectory: string = getOpendeskDirectory()): string {
    return path.join(getPluginsDirectory(configDirectory), '.pluginmgr');
}

export function getPluginRegistryPath(configDirectory: string = getOpendeskDirectory()): string {
    return path.join(getPluginManagerDirectory(configDirectory), 'registry.json');
}

export function getPluginStagingDirectory(configDirectory: string = getOpendeskDirectory()): string {
    return path.join(getPluginManagerDirectory(configDirectory), 'staging');
}

export function getPluginCacheDirectory(configDirectory: string = getOpendeskDirectory()): string {
    return path.join(getPluginManagerDirectory(configDirectory), 'cache');
}

export function getPluginTrashDirectory(configDirectory: string = getOpendeskDirectory()): string {
    return path.join(getPluginManagerDirectory(configDirectory), 'trash');
}

export function ensurePluginDirectories(configDirectory: string = getOpendeskDirectory()): void {
    for (const directory of [
        getPluginsDirectory(configDirectory),
        getPluginManagerDirectory(configDirectory),
        getPluginStagingDirectory(configDirectory),
        getPluginCacheDirectory(configDirectory),
        getPluginTrashDirectory(configDirectory)
    ]) {
        fs.mkdirSync(directory, { recursive: true });
    }
}
