/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import fs from 'fs';
import path from 'path';
import { getOpendeskDirectory } from '../../../utils/setting.js';
import { logger } from '../../../utils/logger.js';
import { computePluginIntegrity } from './integrity.js';
import { resolvePluginEntry, type PluginCandidate } from './loader.js';
import { readManifestDeclaration, resolveManifestControlFields } from './manifest.js';
import {
    ensurePluginDirectories,
    getBuiltinPluginsDirectories,
    getPluginRecordRoot,
    getPluginsDirectory
} from '../management/paths.js';
import { listPluginRecords, type PluginRegistryRecord, type PluginSourceKind } from '../management/registry.js';

export interface DiscoveredPluginCandidate extends PluginCandidate {
    id: string;
    source: PluginSourceKind;
    enabled: boolean;
    /** 内置插件在清单里声明了 system: true：启停由清单固定，pluginmgr 不允许修改开关 */
    system: boolean;
}

export interface PluginDiscoveryConflict {
    id: string;
    paths: string[];
}

export interface PluginDiscoveryResult {
    candidates: DiscoveredPluginCandidate[];
    conflicts: PluginDiscoveryConflict[];
}

export interface PluginVerification {
    id: string;
    path: string;
    integrityStatus: 'verified' | 'missing' | 'mismatch' | 'unmanaged';
    expectedIntegrity?: string;
    actualIntegrity?: string;
    detail?: string;
    allowed: boolean;
}

const PLUGIN_FILE_PATTERN = /\.(?:js|mjs|cjs)$/i;
const PLUGIN_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]*$/;

/** 已告警过的发现期问题：插件发现会被反复调用，同一条配置问题只提示一次 */
const warnedDiscoveryIssues = new Set<string>();

function warnOnce(key: string, message: string): void {
    if (warnedDiscoveryIssues.has(key)) return;
    warnedDiscoveryIssues.add(key);
    logger.warn(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readJson(file: string): Record<string, unknown> | undefined {
    if (!fs.existsSync(file)) return undefined;
    try {
        const value = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
        return isRecord(value) ? value : undefined;
    } catch {
        return undefined;
    }
}

function normalizePluginId(value: string): string {
    const normalized = value
        .replace(/^@/, '')
        .replace(/[\\/]+/g, '.')
        .replace(/[^a-zA-Z0-9._-]+/g, '-');
    const candidate = /^[a-zA-Z]/.test(normalized) ? normalized : `plugin-${normalized}`;
    return candidate || 'plugin';
}

function inferPluginId(spec: string): string {
    const stat = fs.statSync(spec);
    const root = stat.isDirectory() ? spec : path.dirname(spec);
    const basename = path.basename(spec, stat.isFile() ? path.extname(spec) : undefined);
    const manifest = readManifestDeclaration(spec);
    if (typeof manifest?.id === 'string' && PLUGIN_ID_PATTERN.test(manifest.id)) return manifest.id;
    const packageJson = stat.isDirectory() ? readJson(path.join(root, 'package.json')) : undefined;
    if (isRecord(packageJson?.opendesk) && typeof packageJson.opendesk.id === 'string') {
        return normalizePluginId(packageJson.opendesk.id);
    }
    if (typeof packageJson?.name === 'string') return normalizePluginId(packageJson.name);
    return normalizePluginId(basename);
}

/**
 * 读取内置插件清单里的启停控制字段。
 * 清单缺失或损坏时按「未声明」处理：这类问题由加载阶段报 plugin.* 诊断。
 */
function readBuiltinControlFields(spec: string) {
    return resolveManifestControlFields(readManifestDeclaration(spec), { builtin: true });
}

/**
 * 把注册表记录里的插件位置解析为绝对路径：内置记录相对内置插件目录，本地记录相对
 * plugins 目录。附加插件目录里的插件记的是绝对路径（见 `toPluginRecordPath`），
 * 所以这里不存在「相对路径要落到哪个内置目录」的歧义。
 */
export function resolvePluginRecordPath(
    record: PluginRegistryRecord,
    configDirectory: string = getOpendeskDirectory()
): string {
    if (path.isAbsolute(record.path)) return record.path;
    return path.resolve(getPluginRecordRoot(record.source, configDirectory), record.path);
}

function toCandidate(
    spec: string,
    source: PluginSourceKind,
    origin: string,
    record?: PluginRegistryRecord
): DiscoveredPluginCandidate | undefined {
    if (!fs.existsSync(spec)) return undefined;
    const stat = fs.statSync(spec);
    if (!stat.isDirectory() && !(stat.isFile() && PLUGIN_FILE_PATTERN.test(spec))) return undefined;
    // system/enabled 只对内置插件生效，后装插件声明了也不会锁住自己的开关
    const control = source === 'builtin' ? readBuiltinControlFields(spec) : undefined;
    const system = control?.system === true;
    return {
        id: record?.id ?? inferPluginId(spec),
        spec,
        origin,
        source,
        system,
        // 清单固定启停的内置插件不再采信注册表里的开关状态
        enabled: system ? (control?.enabled ?? true) : (record?.enabled ?? true),
        options: record?.options,
        grantedCapabilities: record?.grantedCapabilities,
        integrity: record?.integrity
    };
}

function scanDirectory(
    directory: string,
    source: PluginSourceKind,
    accept?: (spec: string) => boolean
): DiscoveredPluginCandidate[] {
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return [];
    const result: DiscoveredPluginCandidate[] = [];
    for (const entry of fs
        .readdirSync(directory, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.')) continue;
        const spec = path.join(directory, entry.name);
        if (accept && !accept(spec)) continue;
        const candidate = toCandidate(spec, source, directory);
        if (candidate) result.push(candidate);
    }
    return result;
}

/**
 * 探测一个条目能否作为内置插件加载：可加载返回 undefined，否则返回不可加载的原因。
 *
 * stat 与清单解析都在 try 内：附加目录里出现失效的符号链接时 statSync 会抛错，
 * 那只是「不是插件」，不能让整个发现流程失败。
 */
function probePluginDirectory(spec: string): string | undefined {
    try {
        if (!fs.statSync(spec).isDirectory()) return 'plugin.entry_not_found';
        resolvePluginEntry(spec, path.dirname(spec), { requireDeclaration: true });
        return undefined;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

/**
 * 目录是否自称是插件：有清单文件（哪怕内容坏了），或在 package.json 里声明了 opendesk 入口。
 *
 * `readManifestDeclaration` 已覆盖目录清单、单文件 sidecar 与 package.json#opendesk，但清单
 * 解析失败时它返回 undefined，所以清单文件本身要单独探一次——「清单损坏」正是最需要告警的一种。
 */
function declaresPlugin(spec: string): boolean {
    if (fs.existsSync(path.join(spec, 'opendesk.plugin.json'))) return true;
    return readManifestDeclaration(spec) !== undefined;
}

/**
 * 附加目录里的条目是否可以作为插件加载。
 *
 * 附加目录由用户指定，里面常混有文档、临时文件等非插件条目，那些保持安静；但「自称是插件
 * 却加载不了」的目录必须留一条告警，否则插件只会从列表里悄悄消失，排查时没有任何线索。
 */
function acceptAdditionalEntry(spec: string): boolean {
    const reason = probePluginDirectory(spec);
    if (reason === undefined) return true;
    if (declaresPlugin(spec)) {
        warnOnce(
            `additional-plugin-invalid:${spec}`,
            `Ignoring additional plugin entry that cannot be loaded: ${spec} (${reason})`
        );
    }
    return false;
}

/**
 * 扫描单个附加插件目录。它可能是「插件目录集合」，也可能直接就是某个插件目录，
 * 两种都支持（与 `--plugins-directory` 的口径一致），避免把插件目录本身传进来时
 * 静默发现 0 个插件。
 */
function scanAdditionalDirectory(directory: string): DiscoveredPluginCandidate[] {
    const reason = probePluginDirectory(directory);
    if (reason === undefined) {
        const candidate = toCandidate(directory, 'builtin', directory);
        return candidate ? [candidate] : [];
    }
    if (declaresPlugin(directory)) {
        // 目录本身自称插件却加载不了：它不该再被当成集合扫描，直接留下可排查的告警
        warnOnce(
            `additional-plugin-invalid:${directory}`,
            `Ignoring additional plugin directory that cannot be loaded: ${directory} (${reason})`
        );
        return [];
    }
    return scanDirectory(directory, 'builtin', acceptAdditionalEntry);
}

/**
 * 扫描内置插件目录列表：首个是主内置目录，其余是附加插件目录。
 *
 * 附加插件目录额外支持直接指向单个插件目录。ID 冲突时先扫到的目录胜出（内置目录在最前），
 * 避免同名条目让两边一起从发现结果里消失。
 */
function scanBuiltinDirectories(directories: readonly string[]): DiscoveredPluginCandidate[] {
    const result: DiscoveredPluginCandidate[] = [];
    const owners = new Map<string, string>();
    for (const [index, directory] of directories.entries()) {
        const candidates = index === 0 ? scanDirectory(directory, 'builtin') : scanAdditionalDirectory(directory);
        logger.info(
            `OpenDesk ${index === 0 ? 'builtin' : 'additional builtin'} plugins directory: ${directory} (exists: ${fs.existsSync(directory)}, found: ${candidates.length})`
        );
        // 同目录内的重复 ID 照常进入后续的冲突检测（那是插件自身的问题），跨目录才按顺序去重
        const accepted = candidates.filter((candidate) => {
            const owner = owners.get(candidate.id);
            if (!owner) return true;
            warnOnce(
                `duplicate-builtin-plugin:${candidate.id}:${candidate.spec}`,
                `Ignoring OpenDesk plugin from additional plugin directory: ${candidate.spec} (plugin id "${candidate.id}" is already provided by ${owner})`
            );
            return false;
        });
        for (const candidate of accepted) owners.set(candidate.id, directory);
        result.push(...accepted);
    }
    return result;
}

export function discoverPlugins(
    options: {
        configDirectory?: string;
        /** 内置插件目录列表：首个是默认内置目录，其余为附加插件目录 */
        builtinDirectories?: readonly string[];
    } = {}
): PluginDiscoveryResult {
    const configDirectory = options.configDirectory ?? getOpendeskDirectory();
    ensurePluginDirectories(configDirectory);
    const root = getPluginsDirectory(configDirectory);
    const builtinDirectories = (options.builtinDirectories ?? getBuiltinPluginsDirectories()).map((directory) =>
        path.resolve(directory)
    );
    const records = listPluginRecords(configDirectory);
    const builtinCandidates = scanBuiltinDirectories(builtinDirectories);
    const builtinIds = new Set(builtinCandidates.map((candidate) => candidate.id));
    // Registry records inside the plugins directory start with their container
    // entry (directory or single plugin file); skip those during the loose scan.
    const containerNames = new Set(
        records
            .filter((record) => record.source !== 'builtin' && !path.isAbsolute(record.path))
            .map((record) => record.path.split(/[\\/]/)[0])
    );
    const candidates: DiscoveredPluginCandidate[] = [];
    const knownPaths = new Set<string>();

    for (const record of records) {
        // 内置插件的候选一律来自当前内置目录的扫描（启停/options 从注册表读取）：记录不该
        // 复活扫描已经排除的条目——被过滤的非插件目录、被去重的同名副本都会因此重新出现，
        // 甚至与目录里的插件撞成发现冲突，让两边一起消失。
        if (record.source === 'builtin') continue;
        if (builtinIds.has(record.id)) continue;
        const spec = resolvePluginRecordPath(record, configDirectory);
        const origin = getPluginsDirectory(configDirectory);
        const candidate = toCandidate(spec, record.source, origin, record);
        if (!candidate) continue;
        if (!candidate.enabled) continue;
        const realPath = fs.realpathSync(spec);
        knownPaths.add(realPath);
        candidates.push(candidate);
    }

    for (const candidate of builtinCandidates) {
        const realPath = fs.realpathSync(candidate.spec);
        if (knownPaths.has(realPath)) continue;
        const policy = records.find((record) => record.id === candidate.id && record.source === 'builtin');
        // 清单固定启停时以清单为准，忽略用户开关留下的注册表记录。
        // 清单固定禁用的内置插件即使当前禁用也保留在发现结果里，加载阶段会跳过它：
        // 这样 pluginmgr 列表仍能展示「已禁用且不可更改」的状态。
        const enabled = candidate.system ? candidate.enabled : (policy?.enabled ?? true);
        if (!enabled && !candidate.system) continue;
        knownPaths.add(realPath);
        candidates.push({
            ...candidate,
            enabled,
            options: policy?.options,
            grantedCapabilities: policy?.grantedCapabilities,
            integrity: policy?.integrity
        });
    }

    for (const candidate of scanDirectory(root, 'local')) {
        if (containerNames.has(path.basename(candidate.spec))) continue;
        if (builtinIds.has(candidate.id)) continue;
        const realPath = fs.realpathSync(candidate.spec);
        if (knownPaths.has(realPath)) continue;
        knownPaths.add(realPath);
        const policy = records.find((record) => record.id === candidate.id);
        if (policy?.enabled === false) continue;
        candidates.push({
            ...candidate,
            options: policy?.options,
            grantedCapabilities: policy?.grantedCapabilities
        });
    }

    const pathsById = new Map<string, string[]>();
    for (const candidate of candidates) {
        const paths = pathsById.get(candidate.id) ?? [];
        paths.push(candidate.spec);
        pathsById.set(candidate.id, paths);
    }
    const conflicts = Array.from(pathsById.entries())
        .filter(([, paths]) => paths.length > 1)
        .map(([id, paths]) => ({ id, paths }));
    const conflictingIds = new Set(conflicts.map((conflict) => conflict.id));
    return {
        candidates: candidates.filter((candidate) => !conflictingIds.has(candidate.id)),
        conflicts
    };
}

export function verifyPluginRecord(record: PluginRegistryRecord, configDirectory?: string): PluginVerification {
    const resolvedConfigDirectory = configDirectory ?? getOpendeskDirectory();
    const pluginPath = resolvePluginRecordPath(record, resolvedConfigDirectory);
    if (!fs.existsSync(pluginPath)) {
        return {
            id: record.id,
            path: pluginPath,
            integrityStatus: 'missing',
            allowed: false
        };
    }
    // Only plugins with a recorded integrity snapshot are integrity-checked;
    // hand-placed plugins have no baseline and are allowed as-is.
    if (!record.integrity) {
        return {
            id: record.id,
            path: pluginPath,
            integrityStatus: 'unmanaged',
            allowed: true
        };
    }
    try {
        const actualIntegrity = computePluginIntegrity(pluginPath);
        const integrityStatus =
            record.integrity && record.integrity !== actualIntegrity ? ('mismatch' as const) : ('verified' as const);
        return {
            id: record.id,
            path: pluginPath,
            integrityStatus,
            expectedIntegrity: record.integrity,
            actualIntegrity,
            allowed: integrityStatus === 'verified'
        };
    } catch (error) {
        return {
            id: record.id,
            path: pluginPath,
            integrityStatus: 'mismatch',
            expectedIntegrity: record.integrity,
            detail: error instanceof Error ? error.message : String(error),
            allowed: false
        };
    }
}
