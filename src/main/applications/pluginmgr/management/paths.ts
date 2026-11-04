/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getOpendeskDirectory } from '../../../utils/setting.js';
import { logger } from '../../../utils/logger.js';
import { getPluginManagerConfig } from './config.js';
import type { PluginSourceKind } from './registry.js';

export const BUILTIN_PLUGINS_DIRECTORY_ENV = 'OPENDESK_BUILTIN_PLUGINS_DIRECTORY';

/**
 * 附加插件目录（逗号分隔）。这些目录与默认内置插件目录合并扫描，其中的插件同样按内置插件
 * 处理（来源 builtin、不允许卸载、清单 system 生效），但优先级低于默认内置目录。
 *
 * 三个来源按顺序合并去重：本环境变量 → CLI `--plugins-directory` → settings 里的
 * `applications.pluginmgr.externalPaths`（沿用旧键，避免用户已有的开发插件路径失效）。
 */
export const PLUGINS_DIRECTORY_ENV = 'OPENDESK_PLUGINS_DIRECTORY';

const CLI_PLUGINS_DIRECTORY_ORIGIN = '--plugins-directory';
const SETTINGS_EXTERNAL_PATHS_ORIGIN = 'applications.pluginmgr.externalPaths';

// 内置插件相对于应用根目录的位置：构建产物优先，其次是随仓库一起分发的源目录
// （鸿蒙 HAP 把整个仓库放进 resources/app，源目录 resources/plugins 也随之可用）。
const BUILTIN_PLUGINS_APP_RELATIVE_PATHS = [path.join('dist', 'plugins'), path.join('resources', 'plugins')];

/** CLI `--plugins-directory` 注入的目录条目，只在本次进程内生效 */
let runtimePluginDirectoryEntries: string[] = [];

/** 已告警过的非法目录：插件发现会被反复调用，同一条告警只打一次 */
const warnedAdditionalDirectories = new Set<string>();

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

/**
 * 默认内置插件目录（随应用发布的那一份），不含附加插件目录。
 *
 * 它同时是内置级注册表记录里相对路径的基准目录（见 `getPluginRecordRoot`）。需要扫描全部
 * 内置级插件请用 `discoverPlugins`，或至少用 `getBuiltinPluginsDirectories`——只扫这个目录
 * 会漏掉 `--plugins-directory` / `OPENDESK_PLUGINS_DIRECTORY` / `externalPaths` 里的插件。
 */
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

/** Windows 路径大小写不敏感：比较前统一归一，避免同一个目录被当成两个 */
function normalizePathForCompare(target: string): string {
    const resolved = path.resolve(target);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function uniqueDirectories(directories: readonly string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const directory of directories) {
        const key = normalizePathForCompare(directory);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(path.resolve(directory));
    }
    return result;
}

function splitDirectoryList(raw: string): string[] {
    return raw
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
}

/** 拆分并解析目录条目：可用目录与不可用条目分开返回，告警方式交给调用方 */
function partitionDirectories(
    entries: readonly string[],
    baseDirectory: string
): { usable: string[]; missing: string[] } {
    const usable: string[] = [];
    const missing: string[] = [];
    for (const entry of entries) {
        const resolved = path.resolve(baseDirectory, entry);
        (isDirectory(resolved) ? usable : missing).push(resolved);
    }
    return { usable, missing };
}

/**
 * 从条目里挑出真实存在的目录。非法路径只告警并跳过，其余条目照常使用：
 * 附加目录是增强项，不该让整个插件加载流程失败。
 */
function resolveExistingDirectories(
    entries: readonly string[],
    origin: string,
    baseDirectory: string = process.cwd()
): string[] {
    const { usable, missing } = partitionDirectories(entries, baseDirectory);
    for (const resolved of missing) {
        const warningKey = `${origin}:${resolved}`;
        if (warnedAdditionalDirectories.has(warningKey)) continue;
        warnedAdditionalDirectories.add(warningKey);
        logger.warn(`Ignoring additional plugin directory from ${origin}: not an existing directory: ${resolved}`);
    }
    return usable;
}

/**
 * 记录 CLI `--plugins-directory` 传入的目录（逗号分隔）。
 * 这里只做拆分，路径校验留到插件发现时：那时日志输出通道已经就绪，告警才能被用户看到。
 */
export function setRuntimePluginsDirectories(raw: string): void {
    runtimePluginDirectoryEntries = splitDirectoryList(raw);
}

/**
 * 列出目录列表里不可用的条目（已解析成绝对路径）。
 *
 * 插件发现期已经会把这些条目告警并跳过，但一次性子命令（`plugins list` 等）会把 logger
 * 的输出收进内存缓冲，用户看不到。CLI 入口据此直接在终端提示一遍，避免显式传入的目录
 * 被静默忽略。
 */
export function findUnusablePluginDirectories(raw: string, baseDirectory: string = process.cwd()): string[] {
    return partitionDirectories(splitDirectoryList(raw), baseDirectory).missing;
}

/**
 * 附加插件目录：环境变量、CLI 参数与 settings 配置合并去重，仅包含实际存在的目录。
 * settings 里的相对路径沿用既有口径，以 OpenDesk 配置目录为基准。
 */
export function getAdditionalPluginDirectories(): string[] {
    return uniqueDirectories([
        ...resolveExistingDirectories(
            splitDirectoryList(process.env[PLUGINS_DIRECTORY_ENV] ?? ''),
            PLUGINS_DIRECTORY_ENV
        ),
        ...resolveExistingDirectories(runtimePluginDirectoryEntries, CLI_PLUGINS_DIRECTORY_ORIGIN),
        ...resolveExistingDirectories(
            getPluginManagerConfig().externalPaths,
            SETTINGS_EXTERNAL_PATHS_ORIGIN,
            getOpendeskDirectory()
        )
    ]);
}

/** 内置插件目录列表：默认内置目录在前，附加插件目录依次追加（全部按内置插件处理） */
export function getBuiltinPluginsDirectories(): string[] {
    return uniqueDirectories([getBuiltinPluginsDirectory(), ...getAdditionalPluginDirectories()]);
}

/**
 * 把插件位置换算成注册表里记录的路径：位于 root 内的记相对路径（内置目录在安装位置
 * 变化后仍可解析），root 外的记绝对路径——附加插件目录之间可能有同名条目，相对路径
 * 无法唯一还原到原目录。
 */
export function toPluginRecordPath(spec: string, root: string): string {
    const resolved = path.resolve(spec);
    const relative = path.relative(path.resolve(root), resolved);
    if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
        return relative;
    }
    return resolved;
}

/**
 * 注册表记录里相对路径的基准目录：内置级（默认内置目录 + 附加插件目录）记内置目录，
 * 本地插件记 `plugins/` 目录。写入（`toPluginRecordPath`）与反解必须共用它，否则
 * 「按 A 目录记、按 B 目录读」会解析到错误的插件位置。
 */
export function getPluginRecordRoot(
    source: PluginSourceKind,
    configDirectory: string = getOpendeskDirectory()
): string {
    return source === 'builtin' ? getBuiltinPluginsDirectory() : getPluginsDirectory(configDirectory);
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
