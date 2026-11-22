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

import fs from 'fs';
import path from 'path';

import { isSafeArtifactRelativePath, resolveArtifactDisplayPath } from '../utils/artifact-relative-path.js';
import { resolveOpendeskDirectoryReadOnly } from '../utils/setting.js';
import { renderMicrocompactReplacementText } from './compaction/microcompact-render.js';
import type { ToolCall } from './messages.js';

export const DEFAULT_TOOL_RESULT_SUMMARY_PREVIEW_CHARS = 300;

/** 模型可见的替代文本渲染：预览正文 + 产物定位行（路径按本机数据根展开）。 */
export function renderToolResultReferenceText(previewText: string, artifactRelativePath?: string): string {
    const displayPath = resolveArtifactDisplayPath(artifactRelativePath);
    if (!displayPath) return previewText;
    return `${previewText}\n\n完整输出已保存至: ${displayPath}\n若需完整内容请通过读文件方式获取。`;
}

/**
 * Request-local overrides take precedence; restored tasks use structured replacement views.
 *
 * 优先级：请求级 overrides（compaction pipeline 注入，已是渲染好的文本）>
 * result_storage.replacement_preview（新格式，结构化）> 旧格式 replacement_text
 * （原样返回，只读兼容）> microcompact 结构化状态（工具参数 + result_storage.relative_path 渲染）。
 *
 * 存储层不含绝对路径：新格式的模型可见文本由本函数在边界按当前数据根生成，
 * 跨机器导入/迁移后产物引用仍然有效。
 */
export function resolveToolResultReplacement(
    toolCall: Pick<ToolCall, 'result_storage' | 'microcompact' | 'tool_name' | 'args_object' | 'args_string'>,
    toolResultOverrides?: ReadonlyMap<string, string>
): string | undefined {
    const storage = toolCall.result_storage;
    const override = storage?.result_id ? toolResultOverrides?.get(storage.result_id) : undefined;
    if (typeof override === 'string' && override.length > 0) {
        return override;
    }
    if (typeof storage?.replacement_preview === 'string' && storage.replacement_preview.length > 0) {
        return renderToolResultReferenceText(storage.replacement_preview, storage.relative_path);
    }
    if (typeof storage?.replacement_text === 'string' && storage.replacement_text.length > 0) {
        return storage.replacement_text;
    }
    if (toolCall.microcompact !== undefined) {
        // 旧格式 microcompact 的自由文本原样透传（只读兼容，其中已内嵌当时的路径）；
        // 新格式按结构化状态 + result_storage.relative_path 渲染
        const legacyMicrocompactText = toolCall.microcompact.replacement_text;
        if (typeof legacyMicrocompactText === 'string' && legacyMicrocompactText.length > 0) {
            return legacyMicrocompactText;
        }
        return renderMicrocompactReplacementText(toolCall, storage?.relative_path);
    }
    return undefined;
}

/** Shared model-visible text for requests, summary input and token estimates. */
export function resolveVisibleToolResultContent(
    toolCall: ToolCall,
    toolResultOverrides?: ReadonlyMap<string, string>
): string | undefined {
    if (toolCall.hasLegacyCompressId()) return toolCall.getLegacyCompressedResultText();
    const replacement = resolveToolResultReplacement(toolCall, toolResultOverrides);
    if (replacement !== undefined) return replacement;
    if (toolCall.status === 'error') return `Toolcall failed: ${toolCall.result ?? ''}`;
    if (toolCall.status === 'success') return toolCall.result ?? '工具调用成功完成';
    return undefined;
}

/**
 * 判定工具调用结果已被压缩（compact 主流程 / tool-result budget / microcompact /
 * legacy compress_id 任一接管了原始 result）。压缩条目的模型可见文本不再依赖
 * result 本体，其内联大图可安全外置落盘；未压缩条目保持内联——活跃窗口内的图片
 * 本来就要随每次请求发给模型，落盘反而会让请求构建期的回灌读盘成为常态。
 */
export function isToolCallResultCompressed(
    toolCall: Pick<ToolCall, 'result_storage' | 'microcompact' | 'hasLegacyCompressId'>
): boolean {
    return (
        toolCall.result_storage !== undefined || toolCall.microcompact !== undefined || toolCall.hasLegacyCompressId()
    );
}

/** Summary bodies are bounded separately from the artifact locator needed to recover the full result. */
export function buildToolResultSummaryPreview(
    toolCall: ToolCall,
    maxChars: number,
    toolResultOverrides?: ReadonlyMap<string, string>
): string | undefined {
    const visible = resolveVisibleToolResultContent(toolCall, toolResultOverrides);
    // Legacy content is a retrieval identifier rather than a result preview.
    if (visible === undefined || toolCall.hasLegacyCompressId()) return visible;

    // These locator lines are emitted by tool-results and microcompact; retain the final full path,
    // without allowing the preview body or text after the locator to bypass the summary limit.
    const reference = Array.from(visible.matchAll(/^(?:完整输出已保存至|完整输出可查看)[:：][ \t]*[^\r\n]+/gm)).at(-1);
    const body = reference ? visible.slice(0, reference.index).trimEnd() : visible;
    const preview = body.length > maxChars ? `${body.slice(0, maxChars)}...` : body;
    if (reference) return `${preview}\n${reference[0]}`;

    const artifactReference = resolveArtifactDisplayPath(toolCall.result_storage?.relative_path);
    if (artifactReference && !preview.includes(artifactReference)) {
        return `${preview}\n[Artifact: ${artifactReference}]`;
    }
    return preview;
}

/**
 * 判定已压缩工具结果的原始 result 是否可以从序列化输出中安全剥离（issue #341）。
 *
 * 压缩视图（结构化预览 / microcompact 状态 / 旧 free-text）都能独立还原模型可见内容，
 * task JSON 里再保留一份副本会让大历史的落盘体积与序列化峰值成倍放大。按可恢复性分级：
 * - result 与渲染后的替代文本完全相同（写入时即以内联渲染文本替换，或渲染回填的副本）
 *   → 纯冗余副本，直接剥离；
 * - result 是被保留的原始文本（budget 流）→ 仅当 artifacts 原文文件真实存在时剥离；
 * - 没有可用的替代视图 / 原文文件缺失 → 保持内联，绝不丢数据（向后兼容硬保证）。
 *
 * 供 ToolCall.toJSON 调用；对未压缩条目恒返回 false，序列化行为不变。
 * 注意：本函数必须保持只读语义（目录不存在时不创建）——toJSON 是纯读操作，
 * 不能因为序列化而改变文件系统状态。
 */
export function canStripCompressedToolResultOriginal(
    toolCall: Pick<ToolCall, 'result' | 'result_storage' | 'microcompact' | 'tool_name' | 'args_object' | 'args_string'>
): boolean {
    const result = toolCall.result;
    if (typeof result !== 'string' || result.length === 0) {
        return false;
    }
    const storage = toolCall.result_storage;
    const microcompact = toolCall.microcompact;

    const legacyText = storage?.replacement_text;
    if (typeof legacyText === 'string' && legacyText.length > 0 && result === legacyText) {
        return true;
    }
    const preview = storage?.replacement_preview;
    if (
        typeof preview === 'string' &&
        preview.length > 0 &&
        result === renderToolResultReferenceText(preview, storage?.relative_path)
    ) {
        return true;
    }
    if (microcompact !== undefined) {
        const legacyMicrocompactText = microcompact.replacement_text;
        if (
            typeof legacyMicrocompactText === 'string' &&
            legacyMicrocompactText.length > 0 &&
            result === legacyMicrocompactText
        ) {
            return true;
        }
        if (result === renderMicrocompactReplacementText(toolCall, storage?.relative_path)) {
            return true;
        }
    }

    const hasReplacementView =
        (typeof legacyText === 'string' && legacyText.length > 0) ||
        (typeof preview === 'string' && preview.length > 0) ||
        microcompact !== undefined;
    if (!hasReplacementView) {
        return false;
    }
    const relativePath = storage?.relative_path;
    if (typeof relativePath !== 'string' || relativePath.length === 0) {
        return false;
    }
    if (!isSafeArtifactRelativePath(relativePath)) {
        // 恶意/畸形路径不参与 artifact 存在性探测（relative_path 随任务 JSON 持久化，
        // 可被导入包构造成穿越路径）：形状不合法一律保持内联（保守方向，无数据丢失）
        return false;
    }
    try {
        const dataDirectory = resolveOpendeskDirectoryReadOnly();
        if (dataDirectory === undefined) {
            // 数据目录尚未初始化：保持内联
            return false;
        }
        return fs.existsSync(path.join(dataDirectory, relativePath));
    } catch {
        // 数据目录不可用（如未初始化的测试环境）：保持内联
        return false;
    }
}
