/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getOpendeskDirectory } from '../../../utils/setting.js';
import { logger } from '../../../utils/logger.js';

export const BUILTIN_PLUGINS_DIRECTORY_ENV = 'OPENDESK_BUILTIN_PLUGINS_DIRECTORY';

// 内置插件相对于应用根目录的位置：构建产物优先，其次是随仓库一起分发的源目录
// （鸿蒙 HAP 把整个仓库放进 resources/app，源目录 resources/plugins 也随之可用）。
const BUILTIN_PLUGINS_APP_RELATIVE_PATHS = [path.join('dist', 'plugins'), path.join('resources', 'plugins')];

function isDirectory(target: string): boolean {
    return fs.existsSync(target) && fs.statSync(target).isDirectory();
}

/** Electron 打包产物：dist/plugins 由 extraResource 落到 resources/plugins */
function electronResourcesPluginsDirectory(): string | undefined {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    return resourcesPath ? path.join(resourcesPath, 'plugins') : undefined;
}

/**
 * 从给定目录向上回溯，逐层产出可能的应用根目录。
 * 仅把含 package.json 的层级视为应用根，避免上溯过程中误命中
 * 无关目录（全局安装的 CLI、monorepo 中的兄弟项目等）。
 * 覆盖三种布局，无需写死任何绝对路径：
 *   - electron-vite dev：dist/main/chunks/ → 上溯到仓库根
 *   - CLI bundle：dist/cli/ → 上溯到仓库/包根
 *   - 鸿蒙 HAP：resources/app/dist/main/chunks/ → 上溯到 resources/app
 */
export function* appRootCandidatesFrom(startDirectory: string): Generator<string> {
    let directory = path.resolve(startDirectory);
    for (let depth = 0; depth < 8; depth++) {
        if (fs.existsSync(path.join(directory, 'package.json'))) yield directory;
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
    }
}

/** 从给定目录向上回溯，定位应用根目录下的内置插件目录（构建产物优先）。 */
export function findBuiltinPluginsDirectoryFrom(startDirectory: string): string | undefined {
    for (const appRoot of appRootCandidatesFrom(startDirectory)) {
        for (const relative of BUILTIN_PLUGINS_APP_RELATIVE_PATHS) {
            const candidate = path.join(appRoot, relative);
            if (isDirectory(candidate)) return candidate;
        }
    }
    return undefined;
}

export function getPluginsDirectory(configDirectory: string = getOpendeskDirectory()): string {
    return path.join(configDirectory, 'plugins');
}

export function getBuiltinPluginsDirectory(): string {
    const configured = process.env[BUILTIN_PLUGINS_DIRECTORY_ENV];
    if (configured) return path.resolve(configured);

    const packaged = electronResourcesPluginsDirectory();
    if (packaged && isDirectory(packaged)) return packaged;

    const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
    const fromAppRoot = findBuiltinPluginsDirectoryFrom(moduleDirectory);
    if (fromAppRoot) return fromAppRoot;

    // 全部落空时返回打包布局下的期望路径，便于日志暴露实际查找位置
    return packaged ?? path.join(moduleDirectory, '..', '..', 'plugins');
}

export function getPluginManagerDirectory(configDirectory: string = getOpendeskDirectory()): string {
    return path.join(getPluginsDirectory(configDirectory), '.pluginmgr');
}

export function getPluginRegistryPath(configDirectory: string = getOpendeskDirectory()): string {
    return path.join(getPluginManagerDirectory(configDirectory), 'registry.json');
}

/**
 * 插件私有数据根目录：`<opendesk>/plugins/.pluginmgr/data`。
 *
 * 与插件代码目录（`plugins/<id>`）解耦：卸载插件默认只删除代码目录，数据目录保留，
 * 重新安装同名插件后可继续使用。放在 `.pluginmgr` 内可避免被插件发现流程当成插件扫描。
 */
function getPluginDataRootDirectory(configDirectory: string): string {
    return path.join(getPluginManagerDirectory(configDirectory), 'data');
}

/** 单个插件的私有数据目录：`<opendesk>/plugins/.pluginmgr/data/<pluginId>` */
export function getPluginDataDirectory(pluginId: string, configDirectory: string = getOpendeskDirectory()): string {
    return path.join(getPluginDataRootDirectory(configDirectory), pluginId);
}

/** 确保插件的私有数据目录存在，并返回其绝对路径 */
export function ensurePluginDataDirectory(pluginId: string, configDirectory: string = getOpendeskDirectory()): string {
    const directory = getPluginDataDirectory(pluginId, configDirectory);
    try {
        fs.mkdirSync(directory, { recursive: true });
    } catch (error) {
        // 数据目录只是插件的可选持久化区域，调用方是插件激活流程：这里绝不能抛，
        // 否则配置目录只读、被安全软件短暂占用等问题会让整个插件加载失败
        // （且 host.activate 的 this.entries.set 已执行，会留下无法回滚的幽灵实例）。
        // 插件真正写文件时才会拿到自己的 ENOENT / EPERM。
        logger.warn(`Failed to create plugin data directory: ${directory}`, error);
    }
    return directory;
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
