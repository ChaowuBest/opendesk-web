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
 * 把插件经 registry capability 贡献的注册表接入 mcpmgr / skillmgr：
 * 以 provider（与 pluginmgr 向 mcpmgr 提供 MCP server 的机制同构）的身份
 * 惰性拉取 host 中的注册表贡献，应用侧各自完成适配与合并。
 */

import { registerMcpRegistryProvider } from '../../mcpmgr/registry/provider.js';
import { registerSkillRegistryProvider } from '../../skillmgr/registry/provider.js';
import { getPluginHost } from './host.js';

let disposeMcpRegistryProvider: (() => void) | undefined;
let disposeSkillRegistryProvider: (() => void) | undefined;

export function initializePluginRegistryProvider(): void {
    disposeMcpRegistryProvider ??= registerMcpRegistryProvider({
        id: 'pluginmgr',
        getRegistries: async () =>
            getPluginHost()
                .listMcpRegistries()
                .map((entry) => entry.definition)
    });
    disposeSkillRegistryProvider ??= registerSkillRegistryProvider({
        id: 'pluginmgr',
        getRegistries: async () =>
            getPluginHost()
                .listSkillRegistries()
                .map((entry) => entry.definition)
    });
}

export function disposePluginRegistryProvider(): void {
    disposeMcpRegistryProvider?.();
    disposeMcpRegistryProvider = undefined;
    disposeSkillRegistryProvider?.();
    disposeSkillRegistryProvider = undefined;
}
