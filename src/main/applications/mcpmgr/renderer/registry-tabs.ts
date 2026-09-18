/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY or FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

export interface McpRegistryTab {
    id: string;
    label?: string;
    icon?: string;
    slogan?: string;
    iconClass?: string;
}

export interface McpRegistrySearchState {
    query: string;
    results: unknown[];
    total: number;
    page: number;
    hasMore: boolean;
    searching: boolean;
    loadingMore: boolean;
    hasSearched: boolean;
    message: unknown;
}

/**
 * 合并最新 MCP registry 快照，并清理已经停用 registry 的页面状态。
 * 注册表列表来自主进程的成功响应，因此快照中缺失的 id 可以安全视为已停用。
 */
export function mergeMcpRegistryTabState(
    tabs: McpRegistryTab[],
    state: McpRegistrySearchState,
    activeTab: string,
    infos: McpRegistryTab[]
): { removedIds: string[]; activeTab: string } {
    const knownIds = new Set(infos.map((info) => info.id));
    const removedIds: string[] = [];

    for (let index = tabs.length - 1; index >= 0; index--) {
        if (!knownIds.has(tabs[index].id)) {
            removedIds.push(tabs[index].id);
            tabs.splice(index, 1);
        }
    }

    for (const info of infos) {
        const existing = tabs.find((tab) => tab.id === info.id);
        if (existing) {
            Object.assign(existing, info);
        } else {
            tabs.push({ ...info });
        }
    }

    const nextActiveTab = removedIds.includes(activeTab) ? 'installed' : activeTab;
    if (nextActiveTab !== activeTab) {
        state.query = '';
        state.results = [];
        state.total = 0;
        state.page = 1;
        state.hasMore = false;
        state.searching = false;
        state.loadingMore = false;
        state.hasSearched = false;
        state.message = null;
    }

    return { removedIds, activeTab: nextActiveTab };
}
