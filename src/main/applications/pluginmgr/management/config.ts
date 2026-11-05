/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { Setting } from '../../../utils/setting.js';

export interface PluginManagerConfig {
    /**
     * settings 里持久化的附加插件目录。
     *
     * 与 `--plugins-directory` / `OPENDESK_PLUGINS_DIRECTORY` 是同一概念的持久化形态：
     * 这些目录按内置插件处理，但优先级低于默认内置插件目录。键名沿用旧版的
     * `externalPaths`，避免已配置的开发插件路径失效。
     */
    externalPaths: string[];
}

const DEFAULT_PLUGIN_MANAGER_CONFIG: PluginManagerConfig = {
    externalPaths: []
};

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
