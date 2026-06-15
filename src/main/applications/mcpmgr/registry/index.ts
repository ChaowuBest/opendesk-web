/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

export type { RegistryMcp, SearchOptions, SearchResult } from './base.js';
export { MCPRegistryBase } from './base.js';
export { MatrixMCPRegistry } from './matrix.js';
export { ModelScopeMCPRegistry } from './modelscope.js';

import { type MCPRegistryBase, type SearchOptions, type SearchResult } from './base.js';
import { MatrixMCPRegistry } from './matrix.js';
import { ModelScopeMCPRegistry } from './modelscope.js';

const matrix = new MatrixMCPRegistry();
const modelscope = new ModelScopeMCPRegistry();

export const allRegistries: MCPRegistryBase[] = [matrix, modelscope];

export function getRegistry(id: string): MCPRegistryBase | undefined {
    return allRegistries.find((registry) => registry.id === id);
}

export async function searchRegistry(registryId: string, opts: SearchOptions = {}): Promise<SearchResult> {
    const registry = getRegistry(registryId);
    if (!registry) throw new Error(`未知 MCP Registry: ${registryId}`);
    return registry.search(opts);
}

export function getRegistriesInfo(): { id: string; label: string; icon: string; slogan: string }[] {
    return allRegistries.map((registry) => ({
        id: registry.id,
        label: registry.label,
        icon: registry.icon,
        slogan: registry.slogan
    }));
}

export function parseInstallUrl(installUrl: string): { registryId: string; id: string } | null {
    if (!installUrl || typeof installUrl !== 'string') return null;
    for (const registry of allRegistries) {
        const parsed = registry.parseInstallUrl(installUrl);
        if (parsed) return { registryId: registry.id, id: parsed.id };
    }
    return null;
}
