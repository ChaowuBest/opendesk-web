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
 * Channel plugin type definitions (shared with the native channel adapter).
 * The OpenClaw-compatible plugin runtime has been removed; channel plugins are
 * now loaded exclusively through the pluginmgr native plugin system.
 */

// Types
export type {
    PluginManifest,
    PluginInstallRecord,
    PluginEntry,
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
    ChannelMessagingAdapter,
    ChannelPlugin,
    PluginLogger,
    Participant
} from './types.js';
