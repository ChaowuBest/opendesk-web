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

import type { McpServerState } from './common.js';

export interface McpServerProvider {
    id: string;
    getServers(): Promise<McpServerState[]>;
}

const providers = new Map<string, McpServerProvider>();
const listeners = new Set<() => void>();

function notifyChanged(): void {
    for (const listener of listeners) listener();
}

export function registerMcpServerProvider(provider: McpServerProvider): () => void {
    if (providers.has(provider.id)) throw new Error(`MCP server provider already registered: ${provider.id}`);
    providers.set(provider.id, provider);
    notifyChanged();
    return () => {
        if (providers.delete(provider.id)) notifyChanged();
    };
}

export async function getProvidedMcpServers(): Promise<McpServerState[]> {
    const results = await Promise.allSettled(Array.from(providers.values()).map((provider) => provider.getServers()));
    return results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
}

export function onMcpServerProvidersChanged(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function notifyMcpServerProvidersChanged(): void {
    notifyChanged();
}
