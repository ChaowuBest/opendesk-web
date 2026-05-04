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

import {
    ChatContext,
    AssistantMessage,
    CompactSeparatorMessage,
    UserMessage,
    ToolCall,
    type ChatMessage
} from './messages.js';
import { LLM } from './llm.js';
import { logger } from '../utils/logger.js';
import { HookRegistry } from './hooks.js';
import type { TaskState } from './states/tasks.js';
import { buildActiveContextView, countNonBoundaryMessages } from './compaction/context-view.js';
import { getAutoCompactDecision, resolveReservedSummaryOutput } from './compaction/auto-compact.js';
import { describeCompactPlanVariant, logCompactInfo } from './compaction/compact-trace.js';
import { compactFullContext, type FullCompactRunOptions } from './compaction/full-compact.js';
import {
    buildToolResultReplacementText,
    getToolResultArtifactPath,
    isToolResultCompressionExcluded,
    persistToolResultForToolCall,
    truncateToolResultForPreview
} from './compaction/tool-results.js';

/**
 * @deprecated Legacy separator compact prompt.
 * Step 7 的主路径已迁移到 compaction/full-compact.ts 的 tail-preserving full compact。
 * 当前仅为旧 helper 保留，后续清理 compress_id / midpoint separator 路径时再移除。
 */
function getCompressionPrompt(): string {
    return `你是对话历史压缩器，负责将完整的对话记录提炼为结构化状态快照。

【重要性】此快照将成为智能体对过往所有交互的唯一记忆。智能体将完全依据此快照继续工作，因此必须保留一切关键信息：用户指令、决策依据、遇到的错误、已完成和待完成的工作。

【输出要求】
- 信息密度最大化：只保留有价值的事实，删除所有寒暄、重复和无关内容
- 使用要点/列表形式，避免冗长叙述
- 直接输出 <state_snapshot> XML，不要添加任何前导或后缀文字

请严格按以下结构输出：

<state_snapshot>
    <overall_goal>
        <!-- 用一句话概括用户的核心目标 -->
    </overall_goal>

    <key_knowledge>
        <!-- 智能体必须记住的关键事实、约定和约束，使用列表 -->
        <!-- 包括：技术栈、命名规范、用户偏好、重要限制条件等 -->
    </key_knowledge>

    <file_system_state>
        <!-- 列出被创建、读取、修改或删除的文件 -->
        <!-- 标注每个文件的当前状态和关键发现 -->
    </file_system_state>

    <recent_actions>
        <!-- 最近若干次重要操作及其结果，只记录事实 -->
        <!-- 特别关注：失败的操作及原因、需要重试的内容 -->
    </recent_actions>

    <current_plan>
        <!-- 当前的分步计划，标记每步的状态 -->
        <!-- 示例：
         1. [已完成] 定位所有使用废弃 API 的文件
         2. [进行中] 重构 src/components/UserProfile.tsx
         3. [待完成] 更新相关测试用例
        -->
    </current_plan>
</state_snapshot>`;
}

/**
 * 收集当前活跃上下文中的工具调用。
 * 活跃上下文由统一的 context-view 层定义，默认即最近一次 compact boundary 之后的部分。
 */
function collectActiveToolCalls(chatContext: ChatContext): ToolCall[] {
    const activeContext = buildActiveContextView(chatContext);
    const toolCalls: ToolCall[] = [];
    for (const message of activeContext.messages) {
        if (message instanceof AssistantMessage) {
            for (const part of message.content) {
                if (part.type === 'tool_call') {
                    for (const tc of part.toolcalls) {
                        toolCalls.push(tc);
                    }
                }
            }
        }
    }
    return toolCalls;
}

/**
 * @deprecated Legacy Level 1：压缩活跃上下文中的旧工具调用。
 * 保留最近 30%（但不低于 10 次）的工具调用不压缩，其余标记 compress_id。
 * Step 7 后不再作为 compactContext() 主路径，保留用于兼容旧任务/后续清理。
 *
 * @returns 本次新压缩的工具调用数量
 */
export function compressToolCalls(chatContext: ChatContext, taskId?: string): number {
    const activeToolCalls = collectActiveToolCalls(chatContext);
    const total = activeToolCalls.length;

    if (total === 0) return 0;

    const keepCount = Math.max(Math.ceil(total * 0.3), Math.min(10, total));
    const compressUpTo = total - keepCount;
    const alreadyCompressed = activeToolCalls.filter((tc) => tc.compress_id).length;

    let newlyCompressed = 0;
    for (let i = 0; i < compressUpTo; i++) {
        if (!activeToolCalls[i].compress_id) {
            activeToolCalls[i].compress_id = crypto.randomUUID();
            newlyCompressed++;
        }
    }

    if (newlyCompressed > 0) {
        logCompactInfo(taskId, {
            source: 'compact',
            event: 'legacy_tool_call_compacted',
            message:
                `[Compact L1] tool call compaction: activeContext=${total}, ` +
                `newlyCompressed=${newlyCompressed}, alreadyCompressed=${alreadyCompressed}, ` +
                `keptRecent=${keepCount}`,
            data: {
                totalToolCalls: total,
                newlyCompressed,
                alreadyCompressed,
                keepCount
            }
        });
    } else {
        logCompactInfo(taskId, {
            source: 'compact',
            event: 'legacy_tool_call_compact_noop',
            message:
                `[Compact L1] no new tool call compaction (activeContext=${total}, ` +
                `alreadyCompressed=${alreadyCompressed}, keptRecent=${keepCount})`,
            data: {
                totalToolCalls: total,
                alreadyCompressed,
                keepCount
            }
        });
    }

    return newlyCompressed;
}

/** @deprecated Legacy midpoint separator summary input builder. */
function buildMessagesText(messages: ChatMessage[]): string {
    const parts: string[] = [];

    for (const msg of messages) {
        if (msg instanceof UserMessage) {
            const text = msg.content
                .map((p) => {
                    if (p.type === 'text') return p.text;
                    if (p.type === 'file') return `[File: ${p.path}]`;
                    return '';
                })
                .join('\n');
            parts.push(`[User]: ${text}`);
        } else if (msg instanceof AssistantMessage) {
            for (const part of msg.content) {
                if (part.type === 'text') {
                    parts.push(`[Assistant]: ${part.text}`);
                } else if (part.type === 'reasoning') {
                    /* 思考过程不纳入总结文本 */
                } else if (part.type === 'tool_call') {
                    for (const tc of part.toolcalls) {
                        const resultSnippet = tc.result
                            ? tc.result.length > 300
                                ? tc.result.substring(0, 300) + '…'
                                : tc.result
                            : 'no result';
                        const argsSnippet = tc.args_string
                            ? tc.args_string.length > 300
                                ? tc.args_string.substring(0, 300) + '…'
                                : tc.args_string
                            : 'none';
                        parts.push(
                            `[Tool Call: ${tc.tool_name}] Args: ${argsSnippet} → Result(${tc.status}): ${resultSnippet}`
                        );
                    }
                }
            }
        } else if (msg instanceof CompactSeparatorMessage) {
            parts.push(`[Previous Context Summary]:\n${msg.summary}`);
        }
    }

    return parts.join('\n\n');
}

/** @deprecated Legacy midpoint separator summary generator. */
async function generateSummary(messages: ChatMessage[], model?: string): Promise<string> {
    const messagesText = buildMessagesText(messages);
    const question = new UserMessage();
    question.appendText(`${getCompressionPrompt()}\n\n---\n\n以下是需要总结的对话历史：\n\n${messagesText}`);
    const maxCompletionTokens = await resolveReservedSummaryOutput(model);
    return await LLM.ask(question, model, {
        maxCompletionTokens
    });
}

/** 统计消息列表中的对话轮次和工具调用数 */
function countMessageStats(messages: ChatMessage[]): {
    userMsgs: number;
    assistantMsgs: number;
    toolCalls: number;
} {
    let userMsgs = 0,
        assistantMsgs = 0,
        toolCalls = 0;
    for (const msg of messages) {
        if (msg instanceof UserMessage) {
            userMsgs++;
        } else if (msg instanceof AssistantMessage) {
            assistantMsgs++;
            for (const part of msg.content) {
                if (part.type === 'tool_call') {
                    toolCalls += part.toolcalls.length;
                }
            }
        }
    }
    return { userMsgs, assistantMsgs, toolCalls };
}

/** 保留在 separator 之后的最少消息数，低于此数则不再前移 */
const MIN_KEPT_MESSAGES = 4;

/**
 * @deprecated Legacy Level 2：插入或渐进式前移 compact boundary。
 *
 * - 首次：separator 放在总消息数的 50% 位置。
 * - 再次：separator 前移到"旧位置 ↔ 末尾"的中点，每次砍掉剩余消息的一半。
 * - 保底：separator 后至少保留 MIN_KEPT_MESSAGES 条消息，否则视为已压缩到极限。
 *
 * Step 7 后 compactContext() 已改为 summary + kept tail，不再调用这个中点算法。
 */
async function compressWithSeparator(chatContext: ChatContext, model?: string): Promise<void> {
    const existingBoundary = chatContext.findCompactBoundary();
    const oldIndex = existingBoundary?.index;

    // 统一由 ChatContext 维护 compact boundary 的唯一性。
    chatContext.clearCompactBoundaries();

    const totalMessages = chatContext.messages.length;
    if (totalMessages < MIN_KEPT_MESSAGES) {
        logger.info(`[Compact L2] 消息数过少 (${totalMessages})，跳过`);
        return;
    }

    let separatorPosition: number;
    if (oldIndex !== undefined) {
        // 渐进式前移：从旧位置到末尾取中点
        const remainingAfterOld = totalMessages - oldIndex;
        separatorPosition = oldIndex + Math.floor(remainingAfterOld / 2);
    } else {
        // 首次：50%
        separatorPosition = Math.floor(totalMessages / 2);
    }

    // 确保 separator 之后至少保留 MIN_KEPT_MESSAGES 条消息
    const maxPosition = totalMessages - MIN_KEPT_MESSAGES;
    if (separatorPosition > maxPosition) {
        separatorPosition = maxPosition;
    }
    // 极端情况：separator 无法比当前位置更前进
    if (oldIndex !== undefined && separatorPosition <= oldIndex) {
        logger.info(`[Compact L2] 已压缩到极限: separator 后仅剩 ${totalMessages - oldIndex} 条消息, 无法继续前移`);
        // 退无可退时仍然重新生成总结（可能旧总结遗漏了新消息）
        separatorPosition = oldIndex;
    }

    if (separatorPosition < 1) {
        logger.info(`[Compact L2] 位置过低 (${separatorPosition})，跳过`);
        return;
    }

    const messagesToSummarize = chatContext.messages.slice(0, separatorPosition);
    const summarizedStats = countMessageStats(messagesToSummarize);
    const keptMessages = chatContext.messages.slice(separatorPosition);
    const keptStats = countMessageStats(keptMessages);

    const action =
        oldIndex === undefined
            ? '插入'
            : separatorPosition > oldIndex
              ? `前移 ${oldIndex} → ${separatorPosition}`
              : '重新生成';

    logger.info(
        `[Compact L2] ${action} 分隔符, 位置 ${separatorPosition}/${totalMessages}, ` +
            `折叠: ${summarizedStats.userMsgs} 条用户 + ${summarizedStats.assistantMsgs} 条助手 ` +
            `(${summarizedStats.toolCalls} 个工具调用), ` +
            `保留: ${keptStats.userMsgs} 条用户 + ${keptStats.assistantMsgs} 条助手 ` +
            `(${keptStats.toolCalls} 个工具调用), 正在生成总结…`
    );

    try {
        const summary = await generateSummary(messagesToSummarize, model);
        const boundary = new CompactSeparatorMessage(summary, {
            summarized_range: {
                start_index: 0,
                end_index_exclusive: separatorPosition,
                message_count: messagesToSummarize.length,
                user_messages: summarizedStats.userMsgs,
                assistant_messages: summarizedStats.assistantMsgs,
                tool_calls: summarizedStats.toolCalls
            },
            previous_boundary_id: existingBoundary?.message.metadata?.boundary_id
        });
        chatContext.replaceCompactBoundary(boundary, separatorPosition);
        logger.info(`[Compact L2] 结构化总结生成完成 (${summary.length} 字符)`);
    } catch (err: any) {
        logger.error(`[Compact L2] 总结生成失败: ${err?.message ?? err}`);
    }
}

/**
 * 上下文压缩主入口：使用 tail-preserving full compact。
 *
 * Legacy 的 compressToolCalls()/compressWithSeparator() 暂时保留，方便回滚和后续清理，
 * 但不再作为主路径调用。
 *
 * @returns 是否实际执行了压缩操作
 */
export interface CompactContextRunOptions extends FullCompactRunOptions {
    taskId?: string;
}

export async function compactContext(
    chatContext: ChatContext,
    model?: string,
    options: CompactContextRunOptions = {}
): Promise<boolean> {
    chatContext.deduplicateCompactBoundaries();
    const enableAssistantRoundBoundary = options.enableAssistantRoundBoundary !== false;
    const totalMessages = countNonBoundaryMessages(chatContext);
    const trigger = options.trigger ?? 'manual';
    logCompactInfo(options.taskId, {
        source: 'compact',
        event: 'assistant_round_boundary_default',
        message: `[Compact Step9] assistant round boundary default=${enableAssistantRoundBoundary}, trigger=${trigger}`,
        data: {
            enableAssistantRoundBoundary,
            trigger
        }
    });
    logCompactInfo(options.taskId, {
        source: 'compact',
        event: 'full_compact_started',
        message: `[Compact] starting tail-preserving full compact, totalMessages=${totalMessages}, trigger=${trigger}`,
        data: {
            totalMessages,
            trigger
        }
    });

    const runResult = await compactFullContext(chatContext, model, {
        ...options,
        trigger,
        enableAssistantRoundBoundary
    });

    if (!runResult.compacted || !runResult.plan) {
        logCompactInfo(options.taskId, {
            source: 'compact',
            event: 'full_compact_noop',
            message: '[Compact] full compact skipped because the context does not satisfy compact conditions'
        });
        return false;
    }

    const compactVariant = describeCompactPlanVariant(runResult.plan);
    logCompactInfo(options.taskId, {
        source: 'compact',
        event: 'full_compact_completed',
        message:
            `[Compact] tail-preserving full compact completed, ` +
            `variant=${compactVariant.compactVariant}, ` +
            `summaryLength=${runResult.summary?.length ?? 0}, ` +
            `summarized=${runResult.plan.messagesToSummarize.length}, ` +
            `kept=${runResult.plan.messagesToKeep.length}`,
        data: {
            summaryLength: runResult.summary?.length ?? 0,
            summarizedMessages: runResult.plan.messagesToSummarize.length,
            keptMessages: runResult.plan.messagesToKeep.length,
            ...compactVariant
        }
    });
    logCompactInfo(options.taskId, {
        source: 'compact',
        event: 'keep_anchor_selected',
        message:
            `[Compact Step9] applied compact variant=${compactVariant.compactVariant}, ` +
            `recentUserPreserved=${compactVariant.recentUserPreserved}, ` +
            `keepAnchorKind=${compactVariant.keepAnchorKind}` +
            (compactVariant.keepAnchorKind === 'assistant_round'
                ? `, messageId=${compactVariant.keepAnchorMessageId}, ` +
                  `roundIndex=${compactVariant.kept_anchor_round_index}, ` +
                  `startPartIndex=${compactVariant.kept_anchor_start_part_index}`
                : ''),
        data: {
            ...compactVariant
        }
    });
    return true;
}

/**
 * 判断当前上下文是否需要压缩。
 */
export async function shouldCompact(chatContext: ChatContext, model?: string, taskId?: string): Promise<boolean> {
    const decision = await getAutoCompactDecision(chatContext, model);
    if (decision.shouldCompact) {
        logCompactInfo(taskId, {
            source: 'compact',
            event: 'auto_compact_threshold_reached',
            message:
                `[Compact] auto compact triggered: estimated_context_tokens=${decision.estimatedContextTokens}, ` +
                `threshold=${Math.floor(decision.autoCompactThreshold)} (` +
                `contextWindow=${decision.contextWindow}, ` +
                `reservedSummaryOutput=${decision.reservedSummaryOutput}, ` +
                `buffer=${decision.buffer}, ` +
                `baseUsageTokens=${decision.baseUsageTokens}, ` +
                `tailEstimatedTokens=${decision.tailEstimatedTokens}, ` +
                `assistantInternalTailTokens=${decision.assistantInternalTailTokens})`,
            data: {
                estimatedContextTokens: decision.estimatedContextTokens,
                autoCompactThreshold: Math.floor(decision.autoCompactThreshold),
                contextWindow: decision.contextWindow,
                reservedSummaryOutput: decision.reservedSummaryOutput,
                buffer: decision.buffer,
                baseUsageTokens: decision.baseUsageTokens,
                tailEstimatedTokens: decision.tailEstimatedTokens,
                assistantInternalTailTokens: decision.assistantInternalTailTokens,
                tokenEstimateSource: decision.tokenEstimateSource
            }
        });
    }
    return decision.shouldCompact;
}

// ─── 全局 afterToolCall：超长工具结果落盘并替换为摘要 ─────────────────────────────

function afterToolCallLargeResultToArtifact(task: TaskState, tool_call: ToolCall): void {
    if (isToolResultCompressionExcluded(tool_call.tool_name)) {
        return;
    }
    const result = tool_call.result;
    if (result === undefined || typeof result !== 'string') {
        return;
    }

    const preview = truncateToolResultForPreview(result);
    if (!preview) {
        return;
    }

    const previousResultStorage = tool_call.result_storage ? { ...tool_call.result_storage } : undefined;
    try {
        const resultId = tool_call.ensureResultStorage().result_id;
        const fullPath = getToolResultArtifactPath(task.task_id, resultId, true);
        const replacementText = buildToolResultReplacementText(preview.previewText, fullPath);
        const persisted = persistToolResultForToolCall(task.task_id, tool_call, result, replacementText);
        tool_call.result = persisted.metadata.replacement_text ?? replacementText;

        const sizeKB = (result.length / 1024).toFixed(1);
        const lineCount = result.split('\n').length;
        logCompactInfo(task.task_id, {
            source: 'compact',
            event: 'tool_result_persisted_to_artifact',
            message:
                `[Compact] large tool result persisted (${sizeKB} KB, ${lineCount} lines): ${persisted.fullPath} ` +
                `(tool=${tool_call.tool_name}, result_id=${persisted.metadata.result_id})`,
            data: {
                toolName: tool_call.tool_name,
                resultId: persisted.metadata.result_id,
                artifactPath: persisted.fullPath,
                sizeKB,
                lineCount
            }
        });
    } catch (err) {
        if (previousResultStorage) {
            tool_call.setResultStorage(previousResultStorage);
        } else {
            tool_call.clearResultStorage();
        }
        logger.error(`[Compact] 写入 artifact 失败: ${(err as Error)?.message ?? err}`);
        return;
    }
}

HookRegistry.afterToolCall(afterToolCallLargeResultToArtifact);
