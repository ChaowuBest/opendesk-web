/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import fs from 'fs';
import path from 'path';
import { getOpendeskDirectory } from '../../../utils/setting.js';
import { computePluginIntegrity } from './integrity.js';
import type { PluginCandidate } from './loader.js';
import { ensurePluginDirectories, getBuiltinPluginsDirectory, getPluginsDirectory } from '../management/paths.js';
import { listPluginRecords, type PluginRegistryRecord, type PluginSourceKind } from '../management/registry.js';

export interface DiscoveredPluginCandidate extends PluginCandidate {
    id: string;
    source: PluginSourceKind;
    managed: boolean;
    enabled: boolean;
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
    const sidecar = stat.isFile()
        ? (readJson(path.join(root, `${basename}.opendesk.plugin.json`)) ??
          readJson(path.join(root, `${basename}.plugin.json`)))
        : undefined;
    const manifest = sidecar ?? readJson(path.join(root, 'opendesk.plugin.json'));
    if (typeof manifest?.id === 'string' && PLUGIN_ID_PATTERN.test(manifest.id)) return manifest.id;
    const packageJson = stat.isDirectory() ? readJson(path.join(root, 'package.json')) : undefined;
    if (isRecord(packageJson?.opendesk) && typeof packageJson.opendesk.id === 'string') {
        return normalizePluginId(packageJson.opendesk.id);
    }
    if (typeof packageJson?.name === 'string') return normalizePluginId(packageJson.name);
    return normalizePluginId(basename);
}

function resolveStoredPath(
    record: PluginRegistryRecord,
    configDirectory: string,
    builtinDirectory: string = getBuiltinPluginsDirectory()
): string {
    if (path.isAbsolute(record.path)) return record.path;
    const root = record.source === 'builtin' ? builtinDirectory : getPluginsDirectory(configDirectory);
    return path.resolve(root, record.path);
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
    return {
        id: record?.id ?? inferPluginId(spec),
        spec,
        origin,
        source,
        managed: source === 'managed',
        enabled: record?.enabled ?? true,
        options: record?.options,
        grantedCapabilities: record?.grantedCapabilities,
        integrity: record?.integrity
    };
}

function scanDirectory(directory: string, source: PluginSourceKind): DiscoveredPluginCandidate[] {
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return [];
    const result: DiscoveredPluginCandidate[] = [];
    for (const entry of fs
        .readdirSync(directory, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.')) continue;
        const spec = path.join(directory, entry.name);
        const candidate = toCandidate(spec, source, directory);
        if (candidate) result.push(candidate);
    }
    return result;
}

function externalCandidates(externalPaths: readonly string[], configDirectory: string): DiscoveredPluginCandidate[] {
    const result: DiscoveredPluginCandidate[] = [];
    for (const configuredPath of externalPaths) {
        const resolved = path.isAbsolute(configuredPath)
            ? configuredPath
            : path.resolve(configDirectory, configuredPath);
        if (!fs.existsSync(resolved)) continue;
        const direct = toCandidate(resolved, 'external', configuredPath);
        if (direct) result.push(direct);
        else result.push(...scanDirectory(resolved, 'external'));
    }
    return result;
}

function pluginDirectoryCandidates(pluginDirectories: readonly string[]): DiscoveredPluginCandidate[] {
    return pluginDirectories.flatMap((directory) => scanDirectory(path.resolve(directory), 'external'));
}

export function discoverPlugins(
    options: {
        configDirectory?: string;
        externalPaths?: readonly string[];
        pluginDirectories?: readonly string[];
        builtinDirectory?: string;
    } = {}
): PluginDiscoveryResult {
    const configDirectory = options.configDirectory ?? getOpendeskDirectory();
    ensurePluginDirectories(configDirectory);
    const root = getPluginsDirectory(configDirectory);
    const builtinDirectory = path.resolve(options.builtinDirectory ?? getBuiltinPluginsDirectory());
    const records = listPluginRecords(configDirectory);
    const builtinCandidates = scanDirectory(builtinDirectory, 'builtin');
    const builtinIds = new Set(builtinCandidates.map((candidate) => candidate.id));
    const managedContainerNames = new Set(
        records
            .filter((record) => record.source === 'managed' && !path.isAbsolute(record.path))
            .map((record) => record.path.split(/[\\/]/)[0])
    );
    const candidates: DiscoveredPluginCandidate[] = [];
    const knownPaths = new Set<string>();

    for (const record of records) {
        if (!record.enabled) continue;
        if (record.source !== 'builtin' && builtinIds.has(record.id)) continue;
        const spec = resolveStoredPath(record, configDirectory, builtinDirectory);
        const origin = record.source === 'builtin' ? builtinDirectory : getPluginsDirectory(configDirectory);
        const candidate = toCandidate(spec, record.source, origin, record);
        if (!candidate) continue;
        const realPath = fs.realpathSync(spec);
        knownPaths.add(realPath);
        candidates.push(candidate);
    }

    for (const candidate of builtinCandidates) {
        const realPath = fs.realpathSync(candidate.spec);
        if (knownPaths.has(realPath)) continue;
        const policy = records.find((record) => record.id === candidate.id && record.source === 'builtin');
        if (policy?.enabled === false) continue;
        knownPaths.add(realPath);
        candidates.push({
            ...candidate,
            options: policy?.options,
            grantedCapabilities: policy?.grantedCapabilities
        });
    }

    for (const candidate of scanDirectory(root, 'local')) {
        if (managedContainerNames.has(path.basename(candidate.spec))) continue;
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

    for (const candidate of externalCandidates(options.externalPaths ?? [], configDirectory)) {
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

    for (const candidate of pluginDirectoryCandidates(options.pluginDirectories ?? [])) {
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
    const pluginPath = resolveStoredPath(record, resolvedConfigDirectory);
    if (!fs.existsSync(pluginPath)) {
        return {
            id: record.id,
            path: pluginPath,
            integrityStatus: 'missing',
            allowed: false
        };
    }
    if (record.source !== 'managed') {
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
