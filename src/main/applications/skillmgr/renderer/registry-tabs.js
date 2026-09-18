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
 * 技能市场注册表 tab 的合并逻辑（纯函数，供渲染端与单元测试共用）。
 *
 * REGISTRY_TABS 是模块级常量，在同一渲染进程内跨页面开关持久；每次以当前
 * 启用插件返回的快照为准，注册表消失（插件禁用/卸载）后清除，避免残留点击
 * 报「未知 Registry」的幽灵 tab。
 */

/**
 * 把最新注册表信息合并进 tab 列表（原地修改）：
 * - 已知 tab：就地更新 label/icon/filters；
 * - 未知 id：追加新 tab（sloganKey 置 null 走默认标语，contributed: true）；
 * - 已消失的 tab（插件禁用/卸载）：移除并返回其 id 列表。
 *
 * 仅在 infos 拉取成功时调用（拉取失败走调用方 catch 分支保留现有 tab），
 * 因此「infos 中缺失」即可安全判定为注册表已停用/移除。
 *
 * @param {Array<{id: string, label?: string, icon?: string, sloganKey?: string|null, filters?: unknown, contributed?: boolean}>} tabs
 * @param {Array<{id: string, label?: string, icon?: string, filters?: unknown}>} infos
 * @returns {string[]} 本次被移除的 tab id 列表
 */
export function mergeRegistryTabs(tabs, infos) {
    const knownIds = new Set(infos.map((info) => info.id));
    const removed = [];
    for (let index = tabs.length - 1; index >= 0; index--) {
        if (!knownIds.has(tabs[index].id)) {
            removed.push(tabs[index].id);
            tabs.splice(index, 1);
        }
    }
    for (const info of infos) {
        let tab = tabs.find((candidate) => candidate.id === info.id);
        if (!tab) {
            tab = {
                id: info.id,
                label: info.label,
                icon: info.icon,
                sloganKey: null,
                filters: info.filters,
                contributed: true
            };
            tabs.push(tab);
        } else {
            if (info.label) tab.label = info.label;
            if (info.icon) tab.icon = info.icon;
            if (info.filters) tab.filters = info.filters;
        }
    }
    return removed;
}

/**
 * 合并注册表 tab 的同时清理对应的页面状态。
 * 页面复用时，停用的 registry 不能只从导航中移除，旧搜索结果也必须一并丢弃，
 * 否则用户仍可能从残留状态触发对已停用 registry 的请求。
 *
 * @param {Array<object>} tabs
 * @param {Record<string, object>} states
 * @param {string} activeTab
 * @param {Array<object>} infos
 * @returns {{removedIds: string[], activeTab: string}}
 */
export function mergeRegistryTabState(tabs, states, activeTab, infos) {
    const removedIds = mergeRegistryTabs(tabs, infos);
    for (const removedId of removedIds) delete states[removedId];
    return {
        removedIds,
        activeTab: removedIds.includes(activeTab) ? 'installed' : activeTab
    };
}
