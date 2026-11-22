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

import { resolveOpendeskDirectoryReadOnly } from '../utils/setting.js';
import { isSafeArtifactRelativePath } from '../utils/artifact-relative-path.js';
import type { ToolCall } from './messages.js';

export const DEFAULT_TOOL_RESULT_SUMMARY_PREVIEW_CHARS = 300;

/**
 * Request-local overrides take precedence; restored tasks can use persisted replacements directly.
 *
 * 优先级：请求级 overrides（compaction pipeline 按 result_id 注入）> result_storage
 * 持久化的 replacement_text。注意 microcompact.replacement_text 与
 * result_storage.replacement_text 允许并存（见 compaction/microcompact.ts 的写入处），
 * 重载后无 overrides 时以本函数读取的 result_storage 字段为准。
 */
export function resolveToolResultReplacement(
    toolCall: Pick<ToolCall, 'result_storage'>,
    toolResultOverrides?: ReadonlyMap<string, string>
): string | undefined {
    const storage = toolCall.result_storage;
    const override = storage?.result_id ? toolResultOverrides?.get(storage.result_id) : undefined;
    if (typeof override === 'string' && override.length > 0) return override;
    const persisted = storage?.replacement_text;
    return typeof persisted === 'string' && persisted.length > 0 ? persisted : undefined;
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

    const artifactPath = toolCall.microcompact?.artifact_path_hint ?? toolCall.result_storage?.relative_path;
    // Artifact is part of the model summary protocol, not a user-interface label.
    if (artifactPath && !preview.includes(artifactPath)) return `${preview}\n[Artifact: ${artifactPath}]`;
    return preview;
}

/**
 * 判定已压缩工具结果的原始 result 是否可以从序列化输出中安全剥离（issue #341）。
 *
 * 压缩流程（compact 主流程 / tool-result budget）都会先把原始结果落盘到
 * result_storage.relative_path 指向的 artifacts 文件；task JSON 里再保留一份原始
 * 副本会让大历史的落盘体积与全量序列化峰值成倍放大。按可恢复性分级剥离：
 * - result 与替代文本内容相同（compact 主流程落盘前已在内存里原地替换为同一文本，
 *   通常还是同一引用）→ 纯冗余副本，直接剥离；
 * - result 是被保留的原始文本（budget 流）→ 仅当 artifacts 原文文件真实存在时剥离；
 * - 原文文件缺失（旧 JSON 拷贝到没有 artifacts 的机器 / best-effort 落盘失败）→
 *   保持内联，绝不丢数据（向后兼容硬保证）。
 *
 * 供 ToolCall.toJSON 调用；对未压缩条目恒返回 false，序列化行为不变。
 * 注意：本函数必须保持只读语义（目录不存在时不创建）——toJSON 是纯读操作，
 * 不能因为序列化而改变文件系统状态。
 */
export function canStripCompressedToolResultOriginal(toolCall: Pick<ToolCall, 'result' | 'result_storage'>): boolean {
    const result = toolCall.result;
    const storage = toolCall.result_storage;
    const replacement = storage?.replacement_text;
    if (typeof result !== 'string' || result.length === 0) {
        return false;
    }
    if (typeof replacement !== 'string' || replacement.length === 0) {
        return false;
    }
    if (result === replacement) {
        // result 就是替代文本的副本：替代文本本身随 result_storage 持久化，
        // 模型可见内容（resolveVisibleToolResultContent 优先取替代文本）不受影响
        return true;
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
