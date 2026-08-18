/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import path from 'path';
import { Setting } from '../../../utils/setting.js';

export interface PluginManagerConfig {
    externalPaths: string[];
}

const DEFAULT_PLUGIN_MANAGER_CONFIG: PluginManagerConfig = {
    externalPaths: []
};

let runtimePluginDirectories: string[] = [];

export function getPluginManagerConfig(): PluginManagerConfig {
    const data = Setting.getInstance().getData() as unknown as {
        applications?: {
            pluginmgr?: Partial<PluginManagerConfig>;
        };
    };
    const configured = data.applications?.pluginmgr;
    return {
        externalPaths: Array.isArray(configured?.externalPaths)
            ? configured.externalPaths.filter((entry): entry is string => typeof entry === 'string')
            : DEFAULT_PLUGIN_MANAGER_CONFIG.externalPaths
    };
}

export function setRuntimePluginDirectories(directories: readonly string[]): void {
    runtimePluginDirectories = Array.from(
        new Set(
            directories
                .map((directory) => directory.trim())
                .filter(Boolean)
                .map((directory) => path.resolve(directory))
        )
    );
}

export function getRuntimePluginDirectories(): string[] {
    return [...runtimePluginDirectories];
}
