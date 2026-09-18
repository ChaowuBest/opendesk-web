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
 * MCP 注册表汇聚点。内置注册表（matrix/modelscope）已迁移到
 * 品牌插件 matrix-mcp-registry、modelscope-mcp-registry，经 registry capability 贡献；本模块把各 provider
 * （pluginmgr）贡献的注册表适配后合并进 allRegistries，下游消费方
 * （市场 UI tab、agent 工具、installFromRegistry）与内置时期完全一致。
 *
 * allRegistries 仍是可变数组：测试或调用方可直接注入替身，
 * 同步逻辑只增量替换自己上一轮贡献的实例。
 */

export type { RegistryMcp, SearchOptions, SearchResult } from './base.js';
export { MCPRegistryBase } from './base.js';
export { ContributedMCPRegistry } from './contributed.js';

import type { MCPRegistryBase, SearchOptions, SearchResult } from './base.js';
import { ContributedMCPRegistry } from './contributed.js';
import { getProvidedMcpRegistryDefinitions, onMcpRegistryProvidersChanged } from './provider.js';
import { logger } from '../../../utils/logger.js';
import { t } from '../locale/index.js';

export const allRegistries: MCPRegistryBase[] = [];

/** 上一轮同步时由 provider 贡献、已合入 allRegistries 的适配器实例 */
let contributedInstances: MCPRegistryBase[] = [];
let syncChain: Promise<void> = Promise.resolve();

/**
 * 把 provider 当前贡献的注册表合并进 allRegistries（增量替换上一轮贡献实例）。
 * 读路径（市场 tab、搜索、安装）在使用前 await 本函数即可感知最新插件状态。
 */
export function ensureMcpRegistriesSynced(): Promise<void> {
    // 串行化同步，避免并发交替导致列表状态错乱；链内吞掉异常，
    // 防止单次同步失败毒化后续所有 ensure 调用
    syncChain = syncChain.then(async () => {
        try {
            const definitions = await getProvidedMcpRegistryDefinitions();
            const seenIds = new Set<string>();
            // registry id 是 installUrl 前缀，跨 provider 去重（保留首个），避免歧义路由
            const instances: MCPRegistryBase[] = [];
            for (const definition of definitions) {
                if (seenIds.has(definition.id)) {
                    logger.warn(`Duplicate MCP registry id from providers, keeping first: ${definition.id}`);
                    continue;
                }
                seenIds.add(definition.id);
                instances.push(new ContributedMCPRegistry(definition));
            }
            for (let index = allRegistries.length - 1; index >= 0; index--) {
                if (contributedInstances.includes(allRegistries[index])) allRegistries.splice(index, 1);
            }
            allRegistries.push(...instances);
            contributedInstances = instances;
        } catch (error) {
            // 同步失败时保留上一轮合并结果，下次读取重试
            logger.warn('Syncing contributed MCP registries failed; keeping previous list', error);
        }
    });
    return syncChain;
}

// provider 注册/注销（如插件重载）时自动同步，已打开的页面下次读取即拿到最新列表
onMcpRegistryProvidersChanged(() => {
    void ensureMcpRegistriesSynced();
});

export function getRegistry(id: string): MCPRegistryBase | undefined {
    return allRegistries.find((registry) => registry.id === id);
}

export async function searchRegistry(registryId: string, opts: SearchOptions = {}): Promise<SearchResult> {
    await ensureMcpRegistriesSynced();
    const registry = getRegistry(registryId);
    if (!registry) throw new Error(t('error.unknownRegistry', { id: registryId }));
    return registry.search(opts);
}

export async function getRegistriesInfo(): Promise<
    { id: string; label: string; icon: string; slogan: string; iconClass: string }[]
> {
    await ensureMcpRegistriesSynced();
    return allRegistries.map((registry) => ({
        id: registry.id,
        label: registry.label,
        icon: registry.icon,
        slogan: registry.slogan,
        iconClass: registry.iconClass
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
