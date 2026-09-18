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
 * MCP 注册表 provider：与 provider.ts（MCP server provider）同构的可插拔机制，
 * 供 pluginmgr 把插件通过 registry capability 贡献的注册表接入 mcpmgr。
 * provider 仅在主进程注册；注册表定义对象（含 search/getDetail 闭包）不跨线程传递。
 */

import type { PluginMcpRegistryDefinition } from '../../../../../packages/plugin-sdk/src/index.js';

export interface McpRegistryProvider {
    id: string;
    getRegistries(): Promise<PluginMcpRegistryDefinition[]>;
}

const providers = new Map<string, McpRegistryProvider>();
const listeners = new Set<() => void>();

function notifyChanged(): void {
    for (const listener of listeners) listener();
}

export function registerMcpRegistryProvider(provider: McpRegistryProvider): () => void {
    if (providers.has(provider.id)) throw new Error(`MCP registry provider already registered: ${provider.id}`);
    providers.set(provider.id, provider);
    notifyChanged();
    return () => {
        if (providers.delete(provider.id)) notifyChanged();
    };
}

export async function getProvidedMcpRegistryDefinitions(): Promise<PluginMcpRegistryDefinition[]> {
    const results = await Promise.allSettled(
        Array.from(providers.values()).map((provider) => provider.getRegistries())
    );
    return results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
}

export function onMcpRegistryProvidersChanged(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
