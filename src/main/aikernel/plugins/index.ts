/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

/**
 * Plugin system entry point.
 * Re-exports all public APIs from the plugin system.
 */

// Manager functions
export {
    installPlugin,
    uninstallPlugin,
    listInstalledPlugins,
    setPluginEnabled,
    loadPlugins,
    resetOpenClawShim,
} from './manager.js';

// Types
export type {
    PluginManifest,
    PluginInstallRecord,
    PluginEntry,
    PluginsConfig,
    ChannelId,
    ChannelMeta,
    ChannelCapabilities,
    ChannelConfigAdapter,
    ChannelOutboundAdapter,
    ChannelGatewayAdapter,
    ChannelGatewayContext,
    ChannelDispatchFn,
    InboundChannelMessage,
    ChannelAccountStatus,
    ChannelStatusAdapter,
    ChannelAccountSnapshot,
    ChannelStatusIssue,
    ChannelHeartbeatAdapter,
    ChannelMessagingAdapter,
    ChannelPlugin,
    PluginLogger,
    OpenClawPluginApi,
} from './types.js';

// OpenClaw compatibility layer
export { ensureOpenClawShim, createPluginApi } from './openclaw/index.js';