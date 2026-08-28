/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { BaseTool, BaseToolset, ToolResult, type ToolsetProvider } from '../../../aikernel/tool.js';
import type { ToolCall } from '../../../aikernel/messages.js';
import type { TaskState } from '../../../aikernel/states/tasks.js';
import type {
    ToolDefinition,
    ToolExecutionContext,
    ToolRenderContent,
    ToolRenderContext
} from '../../../aikernel/types/index.js';
import { escapeHtml } from '../../../../common/utils/escape.js';
import { logger } from '../../../utils/logger.js';
import { getPluginHost, type PluginHost } from './host.js';
import { getPluginMcpToolsets } from './mcp.js';
import { getPluginToolLocalName, qualifyPluginToolsetName } from './tool-names.js';

const fallbackAbortSignal = new AbortController().signal;

function buildRenderContext(toolCall: ToolCall): ToolRenderContext {
    return {
        tool: toolCall.tool_name,
        callId: toolCall.id,
        status: toolCall.status,
        args: toolCall.args_object,
        result: toolCall.result,
        resultObject: toolCall.result_object
    };
}

function renderPluginContent(content: ToolRenderContent): string {
    if (content.type === 'text') {
        return `<div class="od-inline-toolcall-container">
            <span class="text-xs text-slate-600 whitespace-pre-wrap">${escapeHtml(content.text)}</span>
        </div>`;
    }
    if (content.type === 'code') {
        const language = content.language ? ` data-language="${escapeHtml(content.language)}"` : '';
        return `<div class="od-card-shadow my-2 rounded-[8px] border border-gray-200 bg-white overflow-hidden w-full">
            <pre class="plugin-code-block max-h-[280px] overflow-auto p-3 text-xs"><code${language}>${escapeHtml(content.code)}</code></pre>
        </div>`;
    }
    const items = content.items
        .map(
            (
                item
            ) => `<div class="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3 px-3 py-2 border-b border-gray-100 last:border-b-0">
                <span class="text-xs text-gray-500 break-words">${escapeHtml(item.label)}</span>
                <span class="text-xs text-gray-700 whitespace-pre-wrap break-words">${escapeHtml(item.value)}</span>
            </div>`
        )
        .join('');
    return `<div class="od-card-shadow my-2 rounded-[8px] border border-gray-200 bg-white overflow-hidden w-full">${items}</div>`;
}

function buildExecutionContext(taskState?: TaskState): ToolExecutionContext {
    return {
        taskId: taskState?.task_id,
        workspace: taskState?.getWorkspace?.() || undefined,
        abort: taskState?.getAbortSignal?.() ?? fallbackAbortSignal
    };
}

class PluginTool extends BaseTool<any> {
    readonly qualifiedName: string;

    constructor(
        readonly pluginId: string,
        private readonly definition: ToolDefinition
    ) {
        super(getPluginToolLocalName(pluginId, definition.name), definition.description, definition.parameters);
        this.qualifiedName = definition.name;
        this.agentIds = definition.agentIds;
        this.serialExecution = definition.serialExecution ?? false;
        this.setUniversalExecutor(async (args, result, taskState?: TaskState) => {
            const response = await definition.execute(args, buildExecutionContext(taskState), result);
            if (response === undefined) return;
            if (typeof response === 'string') {
                result.updateResult(response);
                return;
            }
            result.updateResult(response.output);
            if (response.resultObject !== undefined) result.updateResultObject(response.resultObject);
        });
    }

    override async stop(): Promise<void> {
        await this.definition.stop?.();
    }

    override getDeclaredPermissions(args: unknown, taskState?: TaskState) {
        return this.definition.getDeclaredPermissions?.(args, buildExecutionContext(taskState)) ?? [];
    }

    override getToolCallPresentation(toolCall: ToolCall) {
        if (!this.definition.presentation) return super.getToolCallPresentation(toolCall);
        try {
            const presentation =
                typeof this.definition.presentation === 'function'
                    ? this.definition.presentation(buildRenderContext(toolCall))
                    : this.definition.presentation;
            return presentation ?? super.getToolCallPresentation(toolCall);
        } catch (error) {
            logger.error(`Plugin tool presentation failed: ${this.name}`, error);
            return super.getToolCallPresentation(toolCall);
        }
    }

    override async renderToolCall(toolCall: ToolCall): Promise<string | undefined> {
        if (!this.definition.render?.gui) return undefined;
        try {
            const content = await this.definition.render.gui(buildRenderContext(toolCall));
            return content ? renderPluginContent(content) : undefined;
        } catch (error) {
            logger.error(`Plugin GUI tool renderer failed: ${this.name}`, error);
            return undefined;
        }
    }

    override renderToolCallCli(toolCall: ToolCall, width: number): string[] | undefined {
        if (!this.definition.render?.cli) return undefined;
        try {
            const lines = this.definition.render.cli({
                ...buildRenderContext(toolCall),
                width
            });
            if (lines !== undefined && (!Array.isArray(lines) || lines.some((line) => typeof line !== 'string'))) {
                throw new TypeError('Plugin CLI tool renderer must return string[] or undefined');
            }
            return lines;
        } catch (error) {
            logger.error(`Plugin CLI tool renderer failed: ${this.name}`, error);
            return undefined;
        }
    }
}

function createPluginTool(pluginId: string, definition: ToolDefinition): BaseTool<any> {
    return new PluginTool(pluginId, definition);
}

class PluginDefinedTool extends BaseTool<any> {
    constructor(
        private readonly source: BaseTool<any>,
        description: string,
        parameters: ToolDefinition['parameters']
    ) {
        super(source.name, description, parameters);
        this.agentIds = source.agentIds;
        this.serialExecution = source.serialExecution;
    }

    async stop(): Promise<void> {
        await this.source.stop();
    }

    getDeclaredPermissions(args: unknown, taskState?: TaskState) {
        return this.source.getDeclaredPermissions(args, taskState);
    }

    async renderToolCall(toolCall: Parameters<BaseTool<any>['renderToolCall']>[0]) {
        return await this.source.renderToolCall(toolCall);
    }

    getToolCallPresentation(toolCall: Parameters<BaseTool<any>['getToolCallPresentation']>[0]) {
        return this.source.getToolCallPresentation(toolCall);
    }

    renderToolCallCli(toolCall: Parameters<BaseTool<any>['renderToolCallCli']>[0], width: number) {
        return this.source.renderToolCallCli(toolCall, width);
    }

    async execute(
        args: unknown,
        updatedCallback?: (result: ToolResult) => void,
        taskState?: TaskState
    ): Promise<ToolResult> {
        const parsed = this.validateArgs(args);
        if (!parsed.success) {
            const result = new ToolResult();
            result.status = 'error';
            result.result = parsed.error;
            return result;
        }
        return await this.source.execute(parsed.data, updatedCallback, taskState);
    }
}

export class PluginToolsetProvider implements ToolsetProvider {
    constructor(private readonly host: PluginHost = getPluginHost()) {}

    async listAvailableToolsets(taskState?: TaskState): Promise<BaseToolset[]> {
        const pluginToolsets = new Map<string, BaseToolset>();
        for (const record of this.host.listTools()) {
            const toolsetName = qualifyPluginToolsetName(record.pluginId);
            const toolset = pluginToolsets.get(toolsetName) ?? new BaseToolset(toolsetName);
            pluginToolsets.set(toolsetName, toolset);
            toolset.addTool(createPluginTool(record.pluginId, record.definition));
        }
        return [...pluginToolsets.values(), ...(await getPluginMcpToolsets(taskState?.getWorkspace() || undefined))];
    }
}

export async function applyPluginToolDefinitions(
    toolsets: BaseToolset[],
    taskState?: TaskState,
    host: PluginHost = getPluginHost()
): Promise<void> {
    for (const toolset of toolsets) {
        for (const [name, source] of toolset.tools) {
            const pluginTool = source instanceof PluginTool ? source : undefined;
            const hookToolName = pluginTool?.qualifiedName ?? name;
            const output = {
                description: source.description,
                parameters: source.params
            };
            try {
                await host.trigger(
                    'tool.definition',
                    {
                        tool: hookToolName,
                        pluginId: pluginTool?.pluginId,
                        taskId: taskState?.task_id,
                        workspace: taskState?.getWorkspace() || undefined
                    },
                    output
                );
            } catch (error) {
                logger.error(`Plugin tool definition hook failed: ${hookToolName}`, error);
                continue;
            }
            if (output.description !== source.description || output.parameters !== source.params) {
                toolset.tools.set(name, new PluginDefinedTool(source, output.description, output.parameters));
            }
        }
    }
}

export class CompositeToolsetProvider implements ToolsetProvider {
    constructor(private readonly providers: ToolsetProvider[]) {}

    async listAvailableToolsets(taskState?: TaskState): Promise<BaseToolset[]> {
        const result: BaseToolset[] = [];
        for (const provider of this.providers) {
            result.push(...(await provider.listAvailableToolsets(taskState)));
        }
        return result;
    }
}

export function combineToolsetProviders(...providers: ToolsetProvider[]): ToolsetProvider {
    return new CompositeToolsetProvider(providers);
}
