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
 * 技能注册表 provider：供 pluginmgr 把插件通过 registry capability 贡献的
 * 注册表接入 skillmgr。provider 仅在主进程注册；注册表定义对象（含 search
 * 等闭包）不跨线程传递——worker 线程经 registry/worker-bridge.ts 回调主进程。
 */

import type { PluginSkillRegistryDefinition } from '../../../../../packages/plugin-sdk/src/index.js';

export interface SkillRegistryProvider {
    id: string;
    getRegistries(): Promise<PluginSkillRegistryDefinition[]>;
}

const providers = new Map<string, SkillRegistryProvider>();
const listeners = new Set<() => void>();

function notifyChanged(): void {
    for (const listener of listeners) listener();
}

export function registerSkillRegistryProvider(provider: SkillRegistryProvider): () => void {
    if (providers.has(provider.id)) throw new Error(`Skill registry provider already registered: ${provider.id}`);
    providers.set(provider.id, provider);
    notifyChanged();
    return () => {
        if (providers.delete(provider.id)) notifyChanged();
    };
}

export async function getProvidedSkillRegistryDefinitions(): Promise<PluginSkillRegistryDefinition[]> {
    const results = await Promise.allSettled(
        Array.from(providers.values()).map((provider) => provider.getRegistries())
    );
    return results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
}

export function onSkillRegistryProvidersChanged(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
