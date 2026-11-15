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
 * 生成式 UI 工具：showUI 在对话里展示预制组件，askUI 展示可交互组件并等待用户操作。
 *
 * 工具调用渲染成带 data-genui 载荷的占位节点，渲染进程按组件名挂载 React 组件；
 * askUI 的用户操作经 GenUiProvider 回到这里，作为工具结果交还模型。
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { InteractiveTool, type ToolArgsValidationResult, type ToolResult } from '../tool.js';
import type { ToolCall } from '../messages.js';
import type { TaskState } from '../states/tasks.js';
import { escapeHtml } from '../../../common/utils/escape.js';
import {
    GENUI_ASK_TOOL,
    GENUI_PLACEHOLDER_CLASS,
    GENUI_SHOW_TOOL,
    describeGenUiCatalog,
    describeGenUiResponse,
    isGenUiComponent,
    listGenUiComponents,
    parseGenUiProps,
    type GenUiComponentName,
    type GenUiMode,
    type GenUiPayload
} from '../../../common/genui/catalog.js';

export interface GenUiRequest {
    requestId: string;
    taskId: string;
    taskName?: string | null;
    toolCallId?: string;
    component: GenUiComponentName;
    title?: string;
    props: Record<string, unknown>;
}

export type GenUiOutcome = { cancelled: true } | { cancelled?: false; response: unknown };

export interface GenUiProvider {
    request(request: GenUiRequest): Promise<GenUiOutcome>;
    cancelCurrent(): void;
}

function createArgsSchema(mode: GenUiMode) {
    const names = listGenUiComponents(mode) as [GenUiComponentName, ...GenUiComponentName[]];
    return z.object({
        component: z.enum(names).describe('组件名，见工具说明'),
        title: z.string().trim().max(120).optional().describe('显示在组件上方的标题，可省略'),
        props: z.looseObject({}).describe('组件参数，必须符合工具说明里该组件的 props schema')
    });
}

const ShowArgsSchema = createArgsSchema('show');
const AskArgsSchema = createArgsSchema('ask');
type GenUiArgs = z.output<typeof ShowArgsSchema>;

/** 部分模型把嵌套对象序列化成字符串传入，这里先还原。 */
function normalizeArgs(args: unknown): unknown {
    if (!args || typeof args !== 'object') return args;
    const record = args as Record<string, unknown>;
    if (typeof record.props !== 'string') return args;
    try {
        return { ...record, props: JSON.parse(record.props) };
    } catch {
        return args;
    }
}

function readGenUiState(toolcall: ToolCall): { requestId?: string; response?: unknown; cancelled?: boolean } {
    const state = (toolcall.result_object as { genui?: Record<string, unknown> } | undefined)?.genui;
    if (state && typeof state === 'object') {
        return {
            requestId: typeof state.requestId === 'string' ? state.requestId : undefined,
            response: state.response,
            cancelled: state.cancelled === true
        };
    }
    // 结果对象未持久化时回退解析结果文本
    if (toolcall.status === 'success' && toolcall.result) {
        try {
            const parsed = JSON.parse(toolcall.result) as { response?: unknown; cancelled?: boolean };
            return { response: parsed.response, cancelled: parsed.cancelled === true };
        } catch {
            return {};
        }
    }
    return {};
}

abstract class GenUiTool extends InteractiveTool<typeof ShowArgsSchema> {
    protected constructor(
        name: string,
        private readonly mode: GenUiMode,
        description: string,
        displayName: { 'zh-CN': string; 'en-US': string }
    ) {
        super(name, description, mode === 'show' ? ShowArgsSchema : AskArgsSchema, undefined, displayName);
    }

    validateArgs(args: unknown): ToolArgsValidationResult<typeof ShowArgsSchema> {
        const normalized = normalizeArgs(args);
        const base = super.validateArgs(normalized);
        if (!base.success) return base;
        const checked = parseGenUiProps(base.data.component, base.data.props);
        if (!checked.success) {
            return { success: false, error: `组件 ${base.data.component} 的参数不合法：\n${checked.error}` };
        }
        const repaired = base.repaired === true || normalized !== args;
        return { success: true, data: { ...base.data, props: checked.props }, ...(repaired ? { repaired } : {}) };
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = normalizeArgs(toolcall.args_object) as Partial<GenUiArgs> | undefined;
        const component = args?.component;
        const checked = isGenUiComponent(component) ? parseGenUiProps(component, args?.props) : null;
        if (!checked?.success || !isGenUiComponent(component)) {
            // 参数仍在流式生成或不合法：回退为通用的行内工具行
            return undefined;
        }
        const state = readGenUiState(toolcall);
        const payload: GenUiPayload = {
            id: toolcall.id,
            mode: this.mode,
            component,
            ...(args?.title ? { title: args.title } : {}),
            props: checked.props,
            status: toolcall.status,
            ...(state.requestId && toolcall.status === 'running' ? { requestId: state.requestId } : {}),
            ...(state.response !== undefined ? { response: state.response } : {}),
            ...(state.cancelled ? { cancelled: true } : {})
        };
        const fallback = args?.title || component;
        return `<div class="${GENUI_PLACEHOLDER_CLASS}" data-genui-id="${escapeHtml(toolcall.id)}" data-genui="${escapeHtml(
            JSON.stringify(payload)
        )}"><div class="od-genui-fallback">${escapeHtml(fallback)}</div></div>`;
    }
}

export class ShowUiTool extends GenUiTool {
    constructor() {
        super(
            GENUI_SHOW_TOOL,
            'show',
            '在对话中内嵌展示一个预制的界面组件，用来呈现结构化结果（表格、指标趋势、方案对比、链接预览、参数表）。' +
                '组件已经展示给用户后，正文不要重复其中的数据，只补充结论或解读。可用组件：\n\n' +
                describeGenUiCatalog('show'),
            { 'zh-CN': '展示界面', 'en-US': 'Show UI' }
        );
        this.setUniversalExecutor(this.handleExecute.bind(this));
    }

    cancelCurrent(): void {}

    private async handleExecute(args: GenUiArgs, toolResult: ToolResult): Promise<void> {
        toolResult.result = JSON.stringify({ shown: true, component: args.component });
    }
}

export class AskUiTool extends GenUiTool {
    private provider: GenUiProvider | null = null;

    constructor() {
        super(
            GENUI_ASK_TOOL,
            'ask',
            '在对话中内嵌展示一个可交互组件并等待用户操作，用户的选择或填写作为工具结果返回。' +
                '适合需要用户在卡片上做选择、批准操作或填写信息的场景；简单的文字澄清问题仍用 askUser。' +
                '工具会阻塞直到用户操作，仅在主任务中可用。可用组件：\n\n' +
                describeGenUiCatalog('ask'),
            { 'zh-CN': '交互界面', 'en-US': 'Ask via UI' }
        );
        this.setUniversalExecutor(this.handleExecute.bind(this));
    }

    /** 无人值守模式不支持阻塞式交互。 */
    isAvailable(taskState?: TaskState): boolean {
        if (!taskState) return true;
        return taskState.getAgentMode().interactive !== false;
    }

    requiresUserAttention(toolcall: ToolCall): boolean | undefined {
        return toolcall.status === 'running';
    }

    setProvider(provider: GenUiProvider): void {
        this.provider = provider;
    }

    cancelCurrent(): void {
        this.provider?.cancelCurrent();
    }

    async stop(): Promise<void> {
        this.cancelCurrent();
    }

    private async handleExecute(
        args: GenUiArgs,
        toolResult: ToolResult,
        taskState?: TaskState,
        toolCall?: ToolCall
    ): Promise<void> {
        if (!this.provider) {
            throw new Error('askUI: no provider configured');
        }
        const requestId = `genui-${randomUUID()}`;
        // 先把请求 id 推给渲染进程，组件拿到它才可交互
        toolResult.updateResultObject({ genui: { requestId } });

        const outcome = await this.provider.request({
            requestId,
            taskId: taskState?.task_id ?? 'unknown',
            taskName: taskState?.task_name ?? null,
            toolCallId: toolCall?.id,
            component: args.component,
            ...(args.title ? { title: args.title } : {}),
            props: args.props
        });

        if (outcome.cancelled) {
            toolResult.result_object = { genui: { cancelled: true } };
            toolResult.result = JSON.stringify({ cancelled: true, summary: '用户没有操作，本次交互已取消' });
            return;
        }
        toolResult.result_object = { genui: { response: outcome.response } };
        toolResult.result = JSON.stringify({
            component: args.component,
            response: outcome.response,
            summary: describeGenUiResponse(args.component, args.props, outcome.response)
        });
    }
}

export function createGenUiTools(provider: GenUiProvider): [ShowUiTool, AskUiTool] {
    const askTool = new AskUiTool();
    askTool.setProvider(provider);
    return [new ShowUiTool(), askTool];
}
