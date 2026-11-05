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
 * 插件市场的 registry provider 注入点。
 *
 * 内置的 `PlainPluginRegistry` 只认「一份 HTTP 上的 plugins.json」。未来出现别的市场协议时
 * （分页 RPC、需要认证的私有市场、增量索引进而拉详情……），不必改 `createPluginRegistries`
 * 与 app.ts：注册一个 provider，让它接管能认领的渠道即可，其余渠道照旧走内置实现。
 *
 * 与 mcpmgr / skillmgr 的 provider 机制同一套写法（register 返回退订函数、重复注册直接报错），
 * 但注册只发生在主进程：provider 是宿主侧能力，不跨线程传递。
 */

import type { PluginChannel } from '../channels.js';
import type { BasePluginRegistry } from './base.js';

/** provider 构造 registry 时可用的上下文 */
export interface PluginRegistryProviderContext {
    /** pluginmgr 的数据目录：provider 想落缓存就放这里 */
    dataDirectory: string;
    /** 走平台代理的 fetch：provider 直接用它就不会绕过用户配置的代理 */
    fetchImpl?: typeof fetch;
}

export interface PluginRegistryProvider {
    /** 唯一标识，用于日志与排障 */
    id: string;
    /** 这个 provider 是否接管该渠道（按地址/协议判定）；官方渠道同样可以被接管 */
    supports(channel: PluginChannel): boolean;
    /** 构造 registry；返回 undefined 表示不接管，交给下一个 provider 或内置实现 */
    create(channel: PluginChannel, context: PluginRegistryProviderContext): BasePluginRegistry | undefined;
}

const providers = new Map<string, PluginRegistryProvider>();

/** 注册一个 provider，返回退订函数（与 mcpmgr / skillmgr 的 provider 同款约定） */
export function registerPluginRegistryProvider(provider: PluginRegistryProvider): () => void {
    if (providers.has(provider.id)) {
        throw new Error(`plugin registry provider already registered: ${provider.id}`);
    }
    providers.set(provider.id, provider);
    return () => {
        providers.delete(provider.id);
    };
}

/** 当前已注册的 provider，按注册顺序（先注册者优先接管渠道） */
export function listPluginRegistryProviders(): PluginRegistryProvider[] {
    return Array.from(providers.values());
}

/** 仅用于测试：清空已注册的 provider，避免用例之间互相影响 */
export function resetPluginRegistryProviders(): void {
    providers.clear();
}
