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

import { z } from 'zod';
import { t } from './locale/index.js';
import { BaseTool } from '../../aikernel/tool.js';
import type { McpToolInfo } from './common.js';
import type { ToolCall } from '../../aikernel/messages.js';
import { MCPTool, renderMcpToolCall } from './mcp-tool.js';

export const MCP_EAGER_DEFINITION_CHAR_BUDGET = 16_000;

const MCP_TOOL_SUMMARY_MAX_CHARS = 240;

export interface McpToolPartition {
    eager: McpToolInfo[];
    deferred: McpToolInfo[];
}

function estimateToolDefinitionChars(tool: McpToolInfo): number {
    const toolNamespace =
        tool.agentIds === undefined ? tool.serverName : `${tool.serverName}_${tool.serverId.slice(-8)}`;
    return JSON.stringify(
        new MCPTool(
            tool.serverName,
            tool.name,
            tool.description,
            tool.inputSchema,
            tool.agentIds,
            toolNamespace
        ).toJSON()
    ).length;
}

abstract class McpGatewayTool<T extends z.ZodType> extends BaseTool<T> {
    private exposedSchema?: Record<string, any>;
    private exposedSchemaSource?: Record<string, any>;

    getJsonSchema(): Record<string, any> {
        const source = super.getJsonSchema();
        if (this.exposedSchema === undefined || this.exposedSchemaSource !== source) {
            const schema = structuredClone(source);
            const required = Array.isArray(schema.required) ? schema.required : [];
            schema.required = required.includes('description') ? required : [...required, 'description'];
            this.exposedSchema = schema;
            this.exposedSchemaSource = source;
        }
        return this.exposedSchema;
    }
}

/**
 * Keep small MCP collections directly callable for compatibility, while deferring
 * the largest servers until the total eager definitions fit the context budget.
 */
export function partitionMcpToolsForContext(
    tools: readonly McpToolInfo[],
    budget: number = MCP_EAGER_DEFINITION_CHAR_BUDGET
): McpToolPartition {
    const groups = new Map<string, { size: number; tools: McpToolInfo[] }>();
    let totalSize = 0;

    for (const tool of tools) {
        const size = estimateToolDefinitionChars(tool);
        totalSize += size;
        const group = groups.get(tool.serverId) || { size: 0, tools: [] };
        group.size += size;
        group.tools.push(tool);
        groups.set(tool.serverId, group);
    }

    const deferredServerIds = new Set<string>();
    const groupsBySize = Array.from(groups.entries()).sort(
        ([leftId, left], [rightId, right]) => right.size - left.size || leftId.localeCompare(rightId)
    );

    for (const [serverId, group] of groupsBySize) {
        if (totalSize <= budget) break;
        deferredServerIds.add(serverId);
        totalSize -= group.size;
    }

    return {
        eager: tools.filter((tool) => !deferredServerIds.has(tool.serverId)),
        deferred: tools.filter((tool) => deferredServerIds.has(tool.serverId))
    };
}

function compactSummary(description: string): string {
    const compact = description.replace(/\s+/g, ' ').trim();
    if (compact.length <= MCP_TOOL_SUMMARY_MAX_CHARS) return compact;
    return `${compact.slice(0, MCP_TOOL_SUMMARY_MAX_CHARS - 1)}…`;
}

function normalizeSearchText(value: string): string {
    return value.trim().toLocaleLowerCase();
}

function scoreTool(tool: McpToolInfo, query: string): number {
    if (!query) return 1;

    const name = normalizeSearchText(tool.name);
    const serverName = normalizeSearchText(tool.serverName);
    const description = normalizeSearchText(tool.description);
    const normalizedQuery = normalizeSearchText(query);
    const terms = normalizedQuery.split(/[\s,，;；/]+/u).filter(Boolean);
    let score = 0;

    for (const term of terms) {
        if (name === term) score += 100;
        else if (name.includes(term)) score += 60;
        if (serverName === term) score += 40;
        else if (serverName.includes(term)) score += 20;
        if (description.includes(term)) score += 10;
    }

    if (terms.length > 1 && description.includes(normalizedQuery)) score += 20;
    return score;
}

const MCP_SEARCH_LIMIT_HARD_MAX = 50;
const MCP_SEARCH_LIMIT_SOFT_MAX = 10;

const McpSearchToolsSchema = z.object({
    description: z.string().optional().describe(t('tool.purpose.description')),
    query: z.string().default('').describe(t('gateway.search.query')),
    server: z.string().optional().describe(t('gateway.search.server')),
    offset: z.number().int().min(0).default(0).describe(t('gateway.search.offset')),
    limit: z.number().int().min(1).max(MCP_SEARCH_LIMIT_HARD_MAX).default(5).describe(t('gateway.search.limit'))
});

export class McpSearchToolsTool extends McpGatewayTool<typeof McpSearchToolsSchema> {
    constructor(private readonly tools: readonly McpToolInfo[]) {
        super('mcpSearchTools', t('gateway.search.description'), McpSearchToolsSchema);
        this.renderToolCallOnError = true;
        this.setExecutor(this.handleExecute.bind(this));
    }

    async renderToolCall(toolcall: ToolCall): Promise<string> {
        return renderMcpToolCall(toolcall, this.name);
    }

    private async handleExecute(args: z.output<typeof McpSearchToolsSchema>): Promise<string> {
        const serverFilter = args.server ? normalizeSearchText(args.server) : '';
        const offset = Math.max(0, Math.floor(args.offset));
        const requestedLimit = Math.max(1, Math.floor(args.limit));
        const effectiveLimit = Math.min(requestedLimit, MCP_SEARCH_LIMIT_SOFT_MAX);
        const matches = this.tools
            .map((tool, index) => ({ tool, index, score: scoreTool(tool, args.query) }))
            .filter(({ tool, score }) => {
                if (score <= 0) return false;
                if (!serverFilter) return true;
                return (
                    normalizeSearchText(tool.serverId) === serverFilter ||
                    normalizeSearchText(tool.serverName) === serverFilter
                );
            })
            .sort((left, right) => right.score - left.score || left.index - right.index);
        const page = matches.slice(offset, offset + effectiveLimit);
        const nextOffset = offset + page.length < matches.length ? offset + page.length : null;
        const clamped = requestedLimit > effectiveLimit;

        return JSON.stringify({
            tools: page.map(({ tool }) => ({
                serverId: tool.serverId,
                serverName: tool.serverName,
                name: tool.name,
                summary: compactSummary(tool.description)
            })),
            total: matches.length,
            nextOffset,
            clamped,
            effectiveLimit,
            hint: clamped
                ? `${t('gateway.search.hint')} ${t('gateway.search.clampedHint', { n: String(effectiveLimit) })}`
                : t('gateway.search.hint')
        });
    }
}

const McpGetToolSchema = z.object({
    description: z.string().optional().describe(t('tool.purpose.description')),
    serverId: z.string().min(1).describe(t('gateway.get.serverId')),
    toolName: z.string().min(1).describe(t('gateway.get.toolName'))
});

export class McpGetToolTool extends McpGatewayTool<typeof McpGetToolSchema> {
    constructor(private readonly tools: readonly McpToolInfo[]) {
        super('mcpGetTool', t('gateway.get.description'), McpGetToolSchema);
        this.renderToolCallOnError = true;
        this.setExecutor(this.handleExecute.bind(this));
    }

    async renderToolCall(toolcall: ToolCall): Promise<string> {
        return renderMcpToolCall(toolcall, this.name);
    }

    private async handleExecute(args: z.output<typeof McpGetToolSchema>): Promise<string> {
        const tool = this.tools.find(
            (candidate) => candidate.serverId === args.serverId && candidate.name === args.toolName
        );
        if (!tool) {
            throw new Error(
                t('gateway.toolNotFound', {
                    serverId: args.serverId,
                    toolName: args.toolName
                })
            );
        }

        return JSON.stringify({
            serverId: tool.serverId,
            serverName: tool.serverName,
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema
        });
    }
}

const McpCallToolSchema = z.object({
    description: z.string().optional().describe(t('tool.purpose.description')),
    serverId: z.string().min(1).describe(t('gateway.call.serverId')),
    toolName: z.string().min(1).describe(t('gateway.call.toolName')),
    arguments: z.record(z.string(), z.unknown()).default({}).describe(t('gateway.call.arguments'))
});

function unwrapNestedArguments(args: Record<string, unknown>, tool: McpToolInfo): Record<string, unknown> {
    if (Object.keys(args).length !== 1) return args;
    const wrapperKeys = ['query', 'arguments', 'params', 'parameters'];
    for (const key of wrapperKeys) {
        if (key in args && typeof args[key] === 'object' && args[key] !== null && !Array.isArray(args[key])) {
            const nested = args[key] as Record<string, unknown>;
            const toolParamKeys = new Set(Object.keys((tool.inputSchema as any)?.properties || {}));
            const nestedKeys = Object.keys(nested);
            if (nestedKeys.length > 0 && nestedKeys.every((k) => toolParamKeys.has(k))) {
                return nested;
            }
        }
    }
    return args;
}

export class McpCallToolTool extends McpGatewayTool<typeof McpCallToolSchema> {
    constructor(
        private readonly tools: readonly McpToolInfo[],
        callTool: (tool: McpToolInfo, args: Record<string, unknown>) => Promise<string>
    ) {
        super('mcpCallTool', t('gateway.call.description'), McpCallToolSchema);
        this.renderToolCallOnError = true;
        this.setExecutor(async (args) => {
            const tool = this.tools.find(
                (candidate) => candidate.serverId === args.serverId && candidate.name === args.toolName
            );
            if (!tool) {
                throw new Error(
                    t('gateway.toolNotFound', {
                        serverId: args.serverId,
                        toolName: args.toolName
                    })
                );
            }
            const toolArgs = unwrapNestedArguments(args.arguments, tool);
            return callTool(tool, toolArgs);
        });
    }

    async renderToolCall(toolcall: ToolCall): Promise<string> {
        const serverId = toolcall.args_object?.['serverId'];
        const toolName = toolcall.args_object?.['toolName'];
        const tool = this.tools.find((candidate) => candidate.serverId === serverId && candidate.name === toolName);
        return renderMcpToolCall(
            toolcall,
            tool ? `${tool.serverName} · ${tool.name}` : `${serverId ?? ''} · ${toolName ?? this.name}`
        );
    }
}
