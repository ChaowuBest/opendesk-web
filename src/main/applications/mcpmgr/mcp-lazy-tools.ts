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
import { BaseTool, BaseToolset } from '../../aikernel/tool.js';
import type { TaskState } from '../../aikernel/states/tasks.js';
import type { ToolCall } from '../../aikernel/messages.js';
import type { McpToolInfo } from './common.js';
import { MCPTool, renderMcpToolCall } from './mcp-tool.js';
import { buildMcpCatalog, listMcpCatalog, MCP_EAGER_DEFINITION_CHAR_BUDGET } from './mcp-catalog.js';
import { t } from './locale/index.js';

interface McpToolsetOptions {
    task?: TaskState;
    callTool: (tool: McpToolInfo, args: Record<string, unknown>) => Promise<string>;
    loadTools?: () => Promise<readonly McpToolInfo[]>;
    // 直装预算（字符）：按任务模型上下文窗口缩放；缺省回落到 16k 基线。
    eagerBudget?: number;
}

// Store identities only: a rebuilt task toolset always uses the latest discovered definitions.
const activeTools = new WeakMap<TaskState, string[]>();

function identity(tool: { serverId: string; name: string }): string {
    return JSON.stringify([tool.serverId, tool.name]);
}

function toolNamespace(info: McpToolInfo): string {
    return info.agentIds === undefined ? info.serverName : `${info.serverName}_${info.serverId.slice(-8)}`;
}

function nativeName(info: McpToolInfo): string {
    return `${toolNamespace(info).replace(/[^a-zA-Z0-9_]/g, '_')}__${info.name}`;
}

function allowsName(task: TaskState | undefined, name: string): boolean {
    return (
        !task ||
        ((!task.allowedTools?.length || task.allowedTools.includes(name)) && !task.disabledTools?.includes(name))
    );
}

function allowsTool(task: TaskState | undefined, info: McpToolInfo, name: string): boolean {
    return (
        allowsName(task, name) &&
        (!task || info.agentIds === undefined || (!!task.agentId && info.agentIds.includes(task.agentId)))
    );
}

class McpDiscoveryTool<T extends z.ZodType> extends BaseTool<T> {
    async renderToolCall(call: ToolCall): Promise<string> {
        return renderMcpToolCall(call, this.name);
    }
}

export function createMcpToolset(
    tools: readonly McpToolInfo[],
    options: McpToolsetOptions,
    preferred = options.task ? (activeTools.get(options.task) ?? []) : []
): BaseToolset {
    const toolset = new BaseToolset('mcpmgr');
    const entries = tools
        .map((info) => {
            const native = new MCPTool(
                info.serverName,
                info.name,
                info.description,
                info.inputSchema,
                info.agentIds,
                toolNamespace(info)
            );
            native.setExecutor(async (args, caller) => {
                if (
                    (options.task && caller && caller !== options.task) ||
                    !allowsTool(caller ?? options.task, info, native.name)
                ) {
                    throw new Error(t('discovery.unavailable'));
                }
                return options.callTool(info, args);
            });
            return { info, native, key: identity(info), size: JSON.stringify(native.toJSON()).length };
        })
        .filter(({ info, native }) => allowsTool(options.task, info, native.name));

    const fullSize = entries.reduce((sum, entry) => sum + entry.size, 0);
    const eagerBudget = options.eagerBudget ?? MCP_EAGER_DEFINITION_CHAR_BUDGET;
    // Explicit tool-name restrictions must not make permitted native tools unreachable.
    if (
        fullSize <= eagerBudget ||
        !allowsName(options.task, 'mcpActivateTools') ||
        !allowsName(options.task, 'mcpListTools')
    ) {
        toolset.addTools(...entries.map((entry) => entry.native));
        return toolset;
    }

    const visible = entries.map((entry) => entry.info);
    const resolveTask = (caller?: TaskState): TaskState | undefined => {
        if (options.task && caller && caller !== options.task) throw new Error(t('discovery.unavailable'));
        return caller ?? options.task;
    };
    const list = new McpDiscoveryTool(
        'mcpListTools',
        t('discovery.list.description'),
        z.object({
            description: z.string().optional().describe(t('tool.purpose.description')),
            kind: z.enum(['servers', 'tools']).default('tools').describe(t('discovery.list.kind')),
            serverId: z.string().optional().describe(t('discovery.serverId')),
            offset: z.number().int().min(0).default(0).describe(t('gateway.search.offset'))
        })
    );
    list.renderToolCallOnError = true;
    list.setExecutor(async (args, caller) => {
        const owner = resolveTask(caller);
        if (!allowsName(owner, list.name)) throw new Error(t('discovery.unavailable'));
        const latest = options.loadTools ? await options.loadTools() : tools;
        if (!allowsName(owner, list.name)) throw new Error(t('discovery.unavailable'));
        const current = latest.filter((info) => allowsTool(owner, info, nativeName(info)));
        return JSON.stringify(listMcpCatalog(current, args));
    });

    const activate = new McpDiscoveryTool(
        'mcpActivateTools',
        `${t('discovery.activate.description')}\n${JSON.stringify(buildMcpCatalog(visible))}`,
        z.object({
            description: z.string().optional().describe(t('tool.purpose.description')),
            tools: z
                .array(
                    z.object({
                        serverId: z.string().min(1).describe(t('discovery.serverId')),
                        toolName: z.string().min(1).describe(t('discovery.toolName'))
                    })
                )
                .min(1)
                .max(16)
                .describe(t('discovery.activate.selection'))
        })
    );
    activate.renderToolCallOnError = true;
    activate.serialExecution = true;
    activate.setExecutor(async (args, caller) => {
        const owner = resolveTask(caller);
        if (!owner) throw new Error(t('discovery.taskRequired'));
        if (!allowsName(owner, activate.name)) throw new Error(t('discovery.unavailable'));
        const generation = owner.getTurnGeneration();
        const latest = options.loadTools ? await options.loadTools() : tools;
        if (
            owner.getTurnGeneration() !== generation ||
            owner.task_status === 'stopped' ||
            !allowsName(owner, activate.name)
        ) {
            throw new Error(t('discovery.unavailable'));
        }
        const requested = [
            ...new Set(args.tools.map(({ serverId, toolName }) => identity({ serverId, name: toolName })))
        ];
        const order = [...requested, ...(activeTools.get(owner) ?? []).filter((key) => !requested.includes(key))];
        const next = createMcpToolset(latest, { ...options, task: owner }, order);
        const selected = args.tools.map(({ serverId, toolName }) => {
            const info = latest.find((entry) => entry.serverId === serverId && entry.name === toolName);
            if (!info) throw new Error(t('gateway.toolNotFound', { serverId, toolName }));
            const name = nativeName(info);
            if (!allowsTool(owner, info, name)) throw new Error(t('discovery.unavailable'));
            if (!next.tools.has(name)) throw new Error(t('discovery.batchTooLarge'));
            return `${next.name}-${name}`;
        });
        // Commit only after every requested identity has been checked; activation never executes tools.
        const installed = new Set(latest.filter((info) => next.tools.has(nativeName(info))).map(identity));
        activeTools.set(
            owner,
            order.filter((key) => installed.has(key))
        );
        owner.chat_context.toolsets.set('mcpmgr', next);
        return JSON.stringify({ activated: [...new Set(selected)], hint: t('discovery.activated') });
    });
    toolset.addTools(list, activate);

    let size = [...toolset.tools.values()].reduce((sum, tool) => sum + JSON.stringify(tool.toJSON()).length, 0);
    const ordered = [
        ...preferred.flatMap((key) => entries.filter((entry) => entry.key === key)),
        ...entries.filter((entry) => !preferred.includes(entry.key)).sort((a, b) => a.size - b.size)
    ];
    let installed = 0;
    for (const entry of ordered) {
        // A single explicitly selected definition may exceed the soft MCP budget; never truncate its schema.
        if (size + entry.size > eagerBudget && !(installed === 0 && preferred[0] === entry.key)) continue;
        toolset.addTool(entry.native);
        size += entry.size;
        installed++;
    }
    return toolset;
}
