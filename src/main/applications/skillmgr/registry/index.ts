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
 * 技能注册表汇聚点。内置注册表（matrix/clawhub/modelscope/skillhub/skill0/skillsmp）
 * 已迁移到内置品牌插件（clawhub-registry 等 6 个 *-registry），经 registry capability 贡献；本模块把
 * 各 provider（pluginmgr）贡献的注册表适配后合并进 allRegistries，下游消费方
 * （市场 UI tab、TUI、agent 工具、安装路由）与内置时期完全一致。
 *
 * 本模块同时被主进程与全局 worker 线程加载（各自一份模块实例）：
 * - 主进程：贡献定义对象（含闭包）就在本线程，直接适配进 allRegistries；
 * - worker 线程：定义对象不可跨线程，经 worker-bridge RPC 回主进程
 *   （skillmgr 应用上的 getPluginSkillRegistries / searchPluginSkillRegistry /
 *   resolvePluginSkillInstall）。
 *
 * allRegistries 仍是可变数组：测试或调用方可直接注入替身，
 * 同步逻辑只增量替换自己上一轮贡献的实例。
 */

import type { RegistryFilterDef } from './base.js';

export type { RegistrySkill, SearchResult, SearchOptions, RegistryFilterDef } from './base.js';
export { SkillRegistryBase } from './base.js';
export { ContributedSkillRegistry, ProxySkillRegistry, type PluginSkillRegistryInfo } from './contributed.js';

import { parentPort } from 'worker_threads';
import { logger } from '../../../utils/logger.js';
import { type SearchOptions, type SearchResult, type SkillRegistryBase } from './base.js';
import { ContributedSkillRegistry, ProxySkillRegistry, type PluginSkillRegistryInfo } from './contributed.js';
import { callAppFromWorker } from './worker-bridge.js';

const runningInWorkerThread = parentPort !== null;

/** 主进程侧：pluginmgr 注册的 provider；worker 线程中该 map 恒为空 */
import { getProvidedSkillRegistryDefinitions, onSkillRegistryProvidersChanged } from './provider.js';

export const allRegistries: SkillRegistryBase[] = [];

/**
 * 内置注册表的 installUrl 前缀（<id>:）固定有效：这四个注册表的下载地址构造
 * 内置于 skill-installer（RegistrySlugInstaller），安装路由不依赖对应插件是否
 * 已加载/启用——避免插件启动窗口期或被禁用时，已知历史 installUrl 无法安装。
 */
const BUILTIN_INSTALL_REGISTRY_IDS = ['matrix', 'clawhub', 'modelscope', 'skillhub'];

/** 上一轮同步时由 provider 贡献、已合入 allRegistries 的适配器实例 */
let contributedInstances: SkillRegistryBase[] = [];
let syncChain: Promise<void> = Promise.resolve();

/**
 * 把当前插件贡献的注册表合并进 allRegistries（增量替换上一轮贡献实例）。
 * 读路径（市场 tab、搜索、安装路由）在使用前 await 本函数即可感知最新插件状态。
 */
export function ensureSkillRegistriesSynced(): Promise<void> {
    // 串行化同步，避免并发交替导致列表状态错乱；链内吞掉异常，
    // 防止单次同步失败（如 worker 桥超时）毒化后续所有 ensure 调用
    syncChain = syncChain.then(async () => {
        try {
            let instances: SkillRegistryBase[];
            if (runningInWorkerThread) {
                // worker 线程：拿可序列化元数据，search/resolveInstall 经 RPC 回代
                const infos = await callAppFromWorker<PluginSkillRegistryInfo[]>('getPluginSkillRegistries');
                instances = (Array.isArray(infos) ? infos : []).map(
                    (info) => new ProxySkillRegistry(info, callAppFromWorker)
                );
            } else {
                const definitions = await getProvidedSkillRegistryDefinitions();
                instances = definitions.map((definition) => new ContributedSkillRegistry(definition));
            }
            // registry id 是 installUrl 前缀，跨 provider 去重（保留首个），避免歧义路由
            const seenIds = new Set<string>();
            instances = instances.filter((instance) => {
                if (seenIds.has(instance.id)) {
                    logger.warn(`Duplicate skill registry id from providers, keeping first: ${instance.id}`);
                    return false;
                }
                seenIds.add(instance.id);
                return true;
            });
            for (let index = allRegistries.length - 1; index >= 0; index--) {
                if (contributedInstances.includes(allRegistries[index])) allRegistries.splice(index, 1);
            }
            allRegistries.push(...instances);
            contributedInstances = instances;
        } catch (error) {
            // 同步失败时保留上一轮合并结果，下次读取重试
            logger.warn('Syncing contributed skill registries failed; keeping previous list', error);
        }
    });
    return syncChain;
}

// provider 注册/注销（如插件重载）时自动同步；worker 线程无本地 provider，不会触发
onSkillRegistryProvidersChanged(() => {
    void ensureSkillRegistriesSynced();
});

export function getRegistry(id: string): SkillRegistryBase | undefined {
    return allRegistries.find((r) => r.id === id);
}

export async function searchRegistry(registryId: string, opts: SearchOptions = {}): Promise<SearchResult> {
    await ensureSkillRegistriesSynced();
    const registry = getRegistry(registryId);
    if (!registry) throw new Error(`未知 Registry: ${registryId}`);
    return registry.search(opts);
}

export async function getRegistriesInfo(): Promise<
    { id: string; label: string; icon: string; slogan: string; filters: RegistryFilterDef[] }[]
> {
    await ensureSkillRegistriesSynced();
    // guiHidden 的注册表（如 skillsmp/skill0）不在 GUI 市场出 tab，与迁移前行为一致
    return allRegistries
        .filter((registry) => !isGuiHiddenRegistry(registry))
        .map((r) => ({ id: r.id, label: r.label, icon: r.icon, slogan: r.slogan, filters: r.filters }));
}

/** TUI 也显示 guiHidden 的注册表，列表以当前已启用插件的快照为准。 */
export async function getTuiRegistriesInfo(): Promise<{ id: string; label: string }[]> {
    await ensureSkillRegistriesSynced();
    return allRegistries.map(({ id, label }) => ({ id, label }));
}

function isGuiHiddenRegistry(registry: SkillRegistryBase): boolean {
    return registry instanceof ContributedSkillRegistry || registry instanceof ProxySkillRegistry
        ? (registry as ContributedSkillRegistry | ProxySkillRegistry).guiHidden
        : false;
}

export function getInstallMethod(installUrl: string): string {
    if (!installUrl || typeof installUrl !== 'string') return 'zip';
    for (const reg of allRegistries) {
        if (reg.matchesInstallUrl(installUrl)) return reg.id;
    }
    const colonIndex = installUrl.indexOf(':');
    if (colonIndex > 0 && BUILTIN_INSTALL_REGISTRY_IDS.includes(installUrl.slice(0, colonIndex))) {
        return installUrl.slice(0, colonIndex);
    }
    if (installUrl.includes('github.com') && installUrl.includes('/tree/')) return 'github';
    if (/github\.com\/[^/]+\/[^/]+/.test(installUrl)) return 'github';
    return 'zip';
}

export function parseInstallUrl(installUrl: string): { slug: string; version?: string } | null {
    if (!installUrl || typeof installUrl !== 'string') return null;
    for (const reg of allRegistries) {
        if (reg.matchesInstallUrl(installUrl)) {
            return reg.parseInstallUrl(installUrl);
        }
    }
    const colonIndex = installUrl.indexOf(':');
    if (colonIndex > 0) {
        const registryId = installUrl.slice(0, colonIndex);
        if (BUILTIN_INSTALL_REGISTRY_IDS.includes(registryId)) {
            const rest = installUrl.slice(colonIndex + 1).trim();
            if (!rest) return null;
            const atIndex = rest.indexOf('@');
            if (atIndex === -1) return { slug: rest };
            return { slug: rest.slice(0, atIndex), version: rest.slice(atIndex + 1).trim() || undefined };
        }
    }
    return null;
}
