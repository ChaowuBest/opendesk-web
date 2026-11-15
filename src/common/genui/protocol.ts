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
 * 生成式 UI 的轻量协议：工具名、组件名与占位节点载荷。
 * 不依赖 zod，渲染进程主包只引入这里，组件 schema 见 catalog.ts。
 */

export const GENUI_SHOW_TOOL = 'showUI';
export const GENUI_ASK_TOOL = 'askUI';
export const GENUI_TOOL_NAMES: ReadonlySet<string> = new Set([GENUI_SHOW_TOOL, GENUI_ASK_TOOL]);
/** 渲染进程据此 class 找到组件占位节点。 */
export const GENUI_PLACEHOLDER_CLASS = 'od-genui';
export const GENUI_RESPOND_CHANNEL = 'genui:respond';

export const GENUI_COMPONENT_NAMES = [
    'option-list',
    'question-flow',
    'approval-card',
    'form',
    'data-table',
    'chart',
    'comparison-card',
    'link-preview',
    'spec-sheet'
] as const;

export type GenUiComponentName = (typeof GENUI_COMPONENT_NAMES)[number];
export type GenUiMode = 'show' | 'ask';
export type GenUiStatus = 'pending' | 'running' | 'success' | 'error';

export function isGenUiComponent(name: unknown): name is GenUiComponentName {
    return typeof name === 'string' && (GENUI_COMPONENT_NAMES as readonly string[]).includes(name);
}

/**
 * 模型看到的工具名带工具集前缀（如 interaction-showUI），工具调用记录里保存的也是它；
 * 这里还原成 showUI / askUI，不是生成式 UI 工具时返回 null。
 */
export function genUiToolBaseName(toolName: unknown): string | null {
    if (typeof toolName !== 'string') return null;
    for (const name of GENUI_TOOL_NAMES) {
        if (toolName === name || toolName.endsWith(`-${name}`)) return name;
    }
    return null;
}

export function isGenUiTool(toolName: unknown): boolean {
    return genUiToolBaseName(toolName) !== null;
}

/** 主进程渲染工具调用时写进占位节点 data-genui 的内容。 */
export interface GenUiPayload {
    /** 工具调用 id */
    id: string;
    mode: GenUiMode;
    component: GenUiComponentName;
    title?: string;
    props: Record<string, unknown>;
    status: GenUiStatus;
    /** askUI 等待用户时的请求 id；有它组件才可交互 */
    requestId?: string;
    /** askUI 完成后的用户回传 */
    response?: unknown;
    cancelled?: boolean;
}

export function parseGenUiPayload(raw: string | null | undefined): GenUiPayload | null {
    if (!raw) return null;
    try {
        const value = JSON.parse(raw) as GenUiPayload;
        if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !isGenUiComponent(value.component)) {
            return null;
        }
        if (value.mode !== 'show' && value.mode !== 'ask') return null;
        if (!value.props || typeof value.props !== 'object') return null;
        return value;
    } catch {
        return null;
    }
}
