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

import { adoptDeferredSubscription } from './deferredSubscription.js';

interface PluginCommandsSubscriptionOwner {
    readonly isConnected: boolean;
}

/**
 * 订阅 pluginmgr 的 `pluginsChanged`（用于刷新插件斜杠命令）。
 *
 * 这条链路要等 `ensureFullyLoaded()` 与 `subscribeEvent()` 两跳 IPC 才拿到退订句柄，
 * 期间 AgentInput 可能已被宿主重建：句柄交给 adoptDeferredSubscription 按「代」判定，
 * 过期订阅自动退订，避免旧实例的刷新回调留在全局通道上。
 */
export function subscribePluginSlashCommands(
    owner: PluginCommandsSubscriptionOwner,
    onPluginsChanged: () => void,
    onReady: (unsubscribe: () => void) => void,
    onError?: (error: unknown) => void
): void {
    const registry = window.applicationRegistryAPI;
    const loaded = registry?.ensureFullyLoaded?.();
    const subscription = Promise.resolve(loaded).then(() =>
        registry?.subscribeEvent?.('pluginmgr', 'pluginsChanged', onPluginsChanged)
    );
    adoptDeferredSubscription(owner, subscription, onReady, onError);
}
