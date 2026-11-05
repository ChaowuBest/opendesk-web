/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { logger } from '../../../utils/logger.js';
import { getOpendeskDirectory } from '../../../utils/setting.js';
import { OPENDESK_PLUGIN_CAPABILITIES, type PluginCapability } from '../../../../../packages/plugin-sdk/src/index.js';
import { ensurePluginDirectories, getPluginRecordRoot, getPluginRegistryPath } from './paths.js';

/**
 * 插件来源：`builtin` 为内置级（默认内置目录 + 附加插件目录），`local` 为安装到
 * `plugins/` 目录里的插件。附加插件目录与内置同级，因此不再单独区分外部来源。
 */
export type PluginSourceKind = 'builtin' | 'local';

/**
 * 旧版注册表可能写入的来源，读取时一次性归并，避免散落到各处判断：
 * - `external`：附加插件目录（`--plugins-directory` / settings 的 externalPaths）已并入内置级；
 * - `managed`：曾是托管安装的中介状态，现统一视为本地插件。
 */
const LEGACY_SOURCE_ALIASES: Record<string, PluginSourceKind> = {
    external: 'builtin',
    managed: 'local'
};

export interface PluginRegistryRecord {
    id: string;
    source: PluginSourceKind;
    path: string;
    spec?: string;
    enabled: boolean;
    installedAt?: string;
    integrity?: string;
    options: Record<string, unknown>;
    grantedCapabilities?: PluginCapability[];
}

export interface PluginRegistryData {
    schemaVersion: 1;
    plugins: PluginRegistryRecord[];
}

/**
 * schema 仍接受旧来源取值，这样带旧记录的 registry.json 不会被整体判为损坏。
 * 元素类型写成 `string`：取值里包含上面那些旧别名，用 `PluginSourceKind` 会与归一化前的
 * 真实取值不符。
 */
const REGISTRY_SOURCE_VALUES: readonly [string, ...string[]] = [
    'builtin',
    'local',
    ...Object.keys(LEGACY_SOURCE_ALIASES)
];

const PluginRegistryRecordSchema = z.object({
    id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9._-]*$/),
    // 旧来源取值在解析时立即归并，读取注册表的地方（发现、列表、卸载）只看得到新口径
    source: z.enum(REGISTRY_SOURCE_VALUES).transform((source) => normalizeSource(source)),
    path: z.string().min(1),
    spec: z.string().optional(),
    enabled: z.boolean().default(true),
    installedAt: z.string().optional(),
    integrity: z.string().optional(),
    options: z.record(z.string(), z.unknown()).default({}),
    grantedCapabilities: z.array(z.enum(OPENDESK_PLUGIN_CAPABILITIES)).optional()
});

const PluginRegistrySchema = z.object({
    schemaVersion: z.literal(1),
    plugins: z.array(PluginRegistryRecordSchema).default([])
});

/** 把 schema 接受的来源取值归并成当前口径 */
function normalizeSource(source: string): PluginSourceKind {
    return LEGACY_SOURCE_ALIASES[source] ?? (source as PluginSourceKind);
}

function emptyRegistry(): PluginRegistryData {
    return { schemaVersion: 1, plugins: [] };
}

export function loadPluginRegistry(configDirectory?: string): PluginRegistryData {
    const registryPath = getPluginRegistryPath(configDirectory);
    if (!fs.existsSync(registryPath)) return emptyRegistry();
    try {
        return PluginRegistrySchema.parse(JSON.parse(fs.readFileSync(registryPath, 'utf-8')));
    } catch (error) {
        logger.error(`Failed to read plugin registry: ${registryPath}`, error);
        return emptyRegistry();
    }
}

export function savePluginRegistry(registry: PluginRegistryData, configDirectory?: string): void {
    ensurePluginDirectories(configDirectory);
    const registryPath = getPluginRegistryPath(configDirectory);
    const temporaryPath = path.join(path.dirname(registryPath), `.registry-${process.pid}-${Date.now()}.tmp`);
    const parsed = PluginRegistrySchema.parse(registry);
    fs.writeFileSync(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
    fs.renameSync(temporaryPath, registryPath);
}

export function listPluginRecords(configDirectory?: string): PluginRegistryRecord[] {
    return loadPluginRegistry(configDirectory).plugins.map((record) => ({
        ...record,
        options: { ...record.options },
        grantedCapabilities: record.grantedCapabilities ? [...record.grantedCapabilities] : undefined
    }));
}

export function getPluginRecord(id: string, configDirectory?: string): PluginRegistryRecord | undefined {
    return listPluginRecords(configDirectory).find((record) => record.id === id);
}

export function upsertPluginRecord(record: PluginRegistryRecord, configDirectory?: string): void {
    const registry = loadPluginRegistry(configDirectory);
    const index = registry.plugins.findIndex((candidate) => candidate.id === record.id);
    const next = PluginRegistryRecordSchema.parse(record);
    if (index >= 0) registry.plugins[index] = next;
    else registry.plugins.push(next);
    registry.plugins.sort((left, right) => left.id.localeCompare(right.id));
    savePluginRegistry(registry, configDirectory);
}

export function removePluginRecord(id: string, configDirectory?: string): boolean {
    const registry = loadPluginRegistry(configDirectory);
    const next = registry.plugins.filter((record) => record.id !== id);
    if (next.length === registry.plugins.length) return false;
    registry.plugins = next;
    savePluginRegistry(registry, configDirectory);
    return true;
}

/**
 * 注册表记录是否已经成了「幽灵」：记录指向的插件目录/文件已经不存在。
 *
 * 常见于三种情况：应用不再内置某个插件（改成只从市场分发）、用户手工删掉了插件目录、
 * 外部插件目录被撤掉。这类记录既不能被启用也不能被卸载（连插件本体都没了），
 * 列出来只是幽灵条目，所以展示层据此把它过滤掉。
 */
export function isStalePluginRecord(record: PluginRegistryRecord, configDirectory?: string): boolean {
    const resolvedConfigDirectory = configDirectory ?? getOpendeskDirectory();
    const target = path.isAbsolute(record.path)
        ? record.path
        : path.resolve(getPluginRecordRoot(record.source, resolvedConfigDirectory), record.path);
    return !fs.existsSync(target);
}
