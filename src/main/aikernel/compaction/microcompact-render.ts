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
 * microcompact 替代文本的边界渲染。
 *
 * 存储层只保存结构化状态（strategy / cleared_at / 统计），产物路径复用
 * result_storage.relative_path（相对数据根）；模型可见文本在这里按当前数据根生成——
 * 跨机器导入/迁移后不再有 "内嵌路径失效" 的问题，文本也不需要任何字符串改写。
 *
 * 独立成模块是为了让 resolver（tool-result-content.ts）能复用渲染逻辑而不引入
 * microcompact → messages 的运行时循环依赖（本模块对 ToolCall 只有类型依赖）。
 */
import { matchesToolName } from './compactable-tools.js';
import { resolveArtifactDisplayPath } from '../../utils/artifact-relative-path.js';
import type { ToolCall } from '../messages.js';

/** 渲染所需的最小工具调用形状（只读投影，便于 resolver 传入序列化对象） */
type MicrocompactRenderSource = Pick<ToolCall, 'tool_name' | 'args_object' | 'args_string'>;

function parseToolCallArgsObject(toolCall: MicrocompactRenderSource): Record<string, unknown> | undefined {
    if (
        toolCall.args_object &&
        typeof toolCall.args_object === 'object' &&
        !Array.isArray(toolCall.args_object) &&
        Object.keys(toolCall.args_object).length > 0
    ) {
        return toolCall.args_object as Record<string, unknown>;
    }

    if (typeof toolCall.args_string !== 'string' || toolCall.args_string.trim().length === 0) {
        return undefined;
    }

    try {
        const parsed = JSON.parse(toolCall.args_string);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        /* best-effort only */
    }

    return undefined;
}

function normalizeOptionalPositiveInteger(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return undefined;
    }

    const normalized = Math.floor(value);
    return normalized > 0 ? normalized : undefined;
}

function normalizeOptionalNonNegativeInteger(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return undefined;
    }

    const normalized = Math.floor(value);
    return normalized >= 0 ? normalized : undefined;
}

function formatReadFileRange(offset?: number, limit?: number): string | undefined {
    if (offset !== undefined && limit !== undefined) {
        return `第 ${offset}~${offset + limit - 1} 行`;
    }

    if (offset !== undefined) {
        return `从第 ${offset} 行开始`;
    }

    if (limit !== undefined) {
        return `前 ${limit} 行`;
    }

    return undefined;
}

function buildMicrocompactReadFileHint(
    toolCall: MicrocompactRenderSource
): { filePath?: string; range?: string } | undefined {
    if (!matchesToolName(toolCall.tool_name, 'readFile')) {
        return undefined;
    }

    const argsObject = parseToolCallArgsObject(toolCall);
    const filePath =
        typeof argsObject?.file_path === 'string' && argsObject.file_path.trim().length > 0
            ? argsObject.file_path.trim()
            : undefined;
    const offsetRaw = normalizeOptionalNonNegativeInteger(argsObject?.offset);
    const offset = offsetRaw !== undefined ? Math.max(1, offsetRaw) : undefined;
    const limit = normalizeOptionalPositiveInteger(argsObject?.limit);
    const range = formatReadFileRange(offset, limit);

    if (!filePath && !range) {
        return undefined;
    }

    return { filePath, range };
}

/**
 * 渲染 microcompact 替代文本：结构化状态 + 当前数据根 → 模型可见文本。
 * 与旧实现逐字节一致（加载持久化状态后重新渲染得到当时写入的同一段文本），
 * 唯一差异是产物路径按当前数据根展开（旧实现把写入时刻的绝对路径固化成文本）。
 */
export function renderMicrocompactReplacementText(
    toolCall: MicrocompactRenderSource,
    artifactRelativePath?: string
): string {
    const lines = ['[旧工具结果已被 microcompact 清理，以减少上下文体积。]', `工具: ${toolCall.tool_name}`];
    const readFileHint = buildMicrocompactReadFileHint(toolCall);
    if (readFileHint?.filePath) {
        lines.push(`文件: ${readFileHint.filePath}`);
    }
    if (readFileHint?.range) {
        lines.push(`读取范围: ${readFileHint.range}`);
    }
    const artifactDisplayPath = resolveArtifactDisplayPath(artifactRelativePath);
    if (artifactDisplayPath) {
        lines.push(`完整输出可查看: ${artifactDisplayPath}`);
        lines.push(
            matchesToolName(toolCall.tool_name, 'readFile')
                ? '如需完整内容，请重新调用 readFile，或直接读取该 artifact 文件。'
                : '如需完整内容，请读取该文件或重新执行该工具。'
        );
    } else {
        lines.push(
            matchesToolName(toolCall.tool_name, 'readFile')
                ? '如需完整内容，请重新调用 readFile 读取原文件。'
                : '如需完整内容，请重新执行该工具，或重新读取相关文件/网页。'
        );
    }
    return lines.join('\n');
}
