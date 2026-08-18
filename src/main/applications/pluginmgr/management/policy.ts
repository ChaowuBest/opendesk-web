/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import path from 'path';
import { discoverPlugins } from '../discovery/discovery.js';
import { getBuiltinPluginsDirectory } from './paths.js';
import { OPENDESK_PLUGIN_CAPABILITIES, type PluginCapability } from '../../../../../packages/plugin-sdk/src/index.js';
import { getPluginRecord, upsertPluginRecord, type PluginRegistryRecord } from './registry.js';

export interface PluginPolicyEntry {
    id: string;
    enabled: boolean;
    options: Record<string, unknown>;
    granted_capabilities?: PluginCapability[];
}

function toPolicyEntry(record: PluginRegistryRecord): PluginPolicyEntry {
    return {
        id: record.id,
        enabled: record.enabled,
        options: { ...record.options },
        granted_capabilities: record.grantedCapabilities ? [...record.grantedCapabilities] : undefined
    };
}

function updateEntry(id: string, update: (entry: PluginRegistryRecord) => PluginRegistryRecord): PluginPolicyEntry {
    let current = getPluginRecord(id);
    if (!current) {
        const builtinDirectory = getBuiltinPluginsDirectory();
        const builtin = discoverPlugins({ builtinDirectory }).candidates.find(
            (candidate) => candidate.id === id && candidate.source === 'builtin'
        );
        current = builtin
            ? {
                  id,
                  source: 'builtin',
                  path: path.relative(builtinDirectory, builtin.spec),
                  enabled: true,
                  options: {}
              }
            : {
                  id,
                  source: 'local',
                  path: id,
                  enabled: true,
                  options: {}
              };
    }
    const next = update(current);
    upsertPluginRecord(next);
    return toPolicyEntry(next);
}

export function getPluginRuntimeEntry(id: string): PluginPolicyEntry | undefined {
    const record = getPluginRecord(id);
    return record ? toPolicyEntry(record) : undefined;
}

export function setPluginOptions(id: string, options: Record<string, unknown>): PluginPolicyEntry {
    return updateEntry(id, (entry) => ({ ...entry, options: { ...options } }));
}

export function setPluginGrantedCapabilities(id: string, capabilities: readonly PluginCapability[]): PluginPolicyEntry {
    const normalized = OPENDESK_PLUGIN_CAPABILITIES.filter((capability) => capabilities.includes(capability));
    return updateEntry(id, (entry) => ({
        ...entry,
        grantedCapabilities: normalized
    }));
}
