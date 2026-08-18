/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { logger } from '../../../utils/logger.js';
import { OPENDESK_PLUGIN_CAPABILITIES, type PluginCapability } from '../../../../../packages/plugin-sdk/src/index.js';
import { ensurePluginDirectories, getPluginRegistryPath } from './paths.js';

export type PluginSourceKind = 'builtin' | 'managed' | 'local' | 'external';

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

const PluginRegistryRecordSchema = z.object({
    id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9._-]*$/),
    source: z.enum(['builtin', 'managed', 'local', 'external']),
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
