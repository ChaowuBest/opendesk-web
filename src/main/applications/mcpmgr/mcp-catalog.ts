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

import type { McpToolInfo } from './common.js';

export const MCP_CATALOG_CHAR_BUDGET = 6_000;
export const MCP_EAGER_DEFINITION_CHAR_BUDGET = 16_000;
// 窗口感知直装预算的上限：更大的集合仍走懒加载，避免工具选择精度被稀释并减少前缀缓存失效。
export const MCP_EAGER_DEFINITION_CHAR_BUDGET_MAX = 128_000;
// 16k 字符基线最初为 70k token 窗口设计，换算比例取 0.25 字符/token。
const MCP_EAGER_BUDGET_CHARS_PER_TOKEN = 0.25;

/**
 * 按模型上下文窗口缩放 MCP 直装预算：窗口越大可直装的字符越多，线性放大后封顶。
 * 窗口未知或非法时回落到 16k 基线，保持小窗口模型的既有懒加载行为。
 */
export function scaleEagerDefinitionBudget(contextWindow?: number): number {
    if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) {
        return MCP_EAGER_DEFINITION_CHAR_BUDGET;
    }
    const scaled = Math.round(contextWindow * MCP_EAGER_BUDGET_CHARS_PER_TOKEN);
    return Math.min(MCP_EAGER_DEFINITION_CHAR_BUDGET_MAX, Math.max(MCP_EAGER_DEFINITION_CHAR_BUDGET, scaled));
}

interface ToolEntry {
    serverId: string;
    serverName: string;
    name: string;
    summary: string;
    truncated: boolean;
}

interface ServerEntry {
    serverId: string;
    serverName: string;
    toolCount: number;
    examples: { name: string; summary: string }[];
}

export interface McpCatalogPage {
    kind: 'tools' | 'servers';
    items: (ToolEntry | ServerEntry)[];
    total: number;
    nextOffset: number | null;
}

function summarize(tool: McpToolInfo): ToolEntry {
    const description = tool.description.replace(/\s+/g, ' ').trim();
    return {
        serverId: tool.serverId,
        serverName: tool.serverName,
        name: tool.name,
        summary: description.length > 240 ? `${description.slice(0, 239)}…` : description,
        truncated: description.length > 240
    };
}

export function listMcpCatalog(
    tools: readonly McpToolInfo[],
    options: { kind?: 'tools' | 'servers'; serverId?: string; offset?: number } = {},
    budget = MCP_CATALOG_CHAR_BUDGET
): McpCatalogPage {
    const kind = options.kind ?? 'tools';
    const filtered =
        options.serverId === undefined ? tools : tools.filter((tool) => tool.serverId === options.serverId);
    let entries: (ToolEntry | ServerEntry)[];
    if (kind === 'servers') {
        const servers = new Map<string, ServerEntry>();
        for (const tool of filtered) {
            const entry = servers.get(tool.serverId) ?? {
                serverId: tool.serverId,
                serverName: tool.serverName,
                toolCount: 0,
                examples: []
            };
            entry.toolCount++;
            if (entry.examples.length < 3) {
                entry.examples.push({ name: tool.name, summary: summarize(tool).summary.slice(0, 100) });
            }
            servers.set(tool.serverId, entry);
        }
        entries = [...servers.values()];
    } else {
        entries = filtered.map(summarize);
    }

    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const page: McpCatalogPage = { kind, items: [], total: entries.length, nextOffset: null };
    for (let index = offset; index < entries.length; index++) {
        page.items.push(entries[index]);
        page.nextOffset = index + 1 < entries.length ? index + 1 : null;
        if (JSON.stringify(page).length > budget) {
            // Keep exact identifiers and guarantee forward progress even for one oversized entry.
            if (page.items.length > 1) {
                page.items.pop();
                page.nextOffset = index;
            }
            break;
        }
    }
    return page;
}

export function buildMcpCatalog(tools: readonly McpToolInfo[]): McpCatalogPage {
    const page = listMcpCatalog(tools);
    return page.nextOffset === null ? page : listMcpCatalog(tools, { kind: 'servers' });
}
