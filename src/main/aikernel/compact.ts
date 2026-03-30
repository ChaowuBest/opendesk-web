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
    ChatContext, AssistantMessage, CompactSeparatorMessage,
    UserMessage, ToolCall, type ChatMessage
} from './messages.js';
import { LLM } from './llm.js';
import { Setting, ModelInstance, getArtifactDirectory } from '../utils/setting.js';
import { lookupKnownContextSize, fetchContextSizeFromAPI } from '../utils/model-context.js';
import { logger } from '../utils/logger.js';
import { HookRegistry } from './hooks.js';
import type { TaskState } from './states/tasks.js';
import path from 'path';
import fs from 'fs';


/**
 * 构建结构化总结所使用的 system prompt
 * 最早的结构化总结Prompt基本使用了Gemini Cli的版本
 * appreciation: @Gemini Cli
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
 * 收集"活跃上下文"中的工具调用——即 CompactSeparatorMessage 之后的部分。
 * separator 之前的消息已被 buildMessages 跳过，对它们做 Level 1 压缩无意义。
 */
function collectActiveToolCalls(chatContext: ChatContext): ToolCall[] {
    const separator = chatContext.findCompactSeparator();
    const startIndex = separator ? separator.index + 1 : 0;

    const toolCalls: ToolCall[] = [];
    for (let i = startIndex; i < chatContext.messages.length; i++) {
        const message = chatContext.messages[i];
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
 * Level 1：压缩活跃上下文中的旧工具调用。
 * 保留最近 30%（但不低于 10 次）的工具调用不压缩，其余标记 compress_id。
 *
 * @returns 本次新压缩的工具调用数量
 */
export function compressToolCalls(chatContext: ChatContext): number {
    const activeToolCalls = collectActiveToolCalls(chatContext);
    const total = activeToolCalls.length;

    if (total === 0) return 0;

    const keepCount = Math.max(Math.ceil(total * 0.3), Math.min(10, total));
    const compressUpTo = total - keepCount;
    const alreadyCompressed = activeToolCalls.filter(tc => tc.compress_id).length;

    let newlyCompressed = 0;
    for (let i = 0; i < compressUpTo; i++) {
        if (!activeToolCalls[i].compress_id) {
            activeToolCalls[i].compress_id = crypto.randomUUID();
            newlyCompressed++;
        }
    }

    if (newlyCompressed > 0) {
        logger.info(
            `[Compact L1] 工具调用压缩: 活跃上下文共 ${total} 个, ` +
            `本次新压缩 ${newlyCompressed} 个, 此前已压缩 ${alreadyCompressed} 个, ` +
            `保留最近 ${keepCount} 个不压缩`
        );
    } else {
        logger.info(
            `[Compact L1] 无新增压缩 (活跃上下文共 ${total} 个工具调用, ` +
            `已压缩 ${alreadyCompressed} 个, 保留 ${keepCount} 个)`
        );
    }

    return newlyCompressed;
}

/** 将消息列表序列化为可供 LLM 总结的纯文本 */
function buildMessagesText(messages: ChatMessage[]): string {
    const parts: string[] = [];

    for (const msg of messages) {
        if (msg instanceof UserMessage) {
            const text = msg.content.map(p => {
                if (p.type === 'text') return p.text;
                if (p.type === 'file') return `[File: ${p.path}]`;
                return '';
            }).join('\n');
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
                            ? (tc.result.length > 300 ? tc.result.substring(0, 300) + '…' : tc.result)
                            : 'no result';
                        const argsSnippet = tc.args_string
                            ? (tc.args_string.length > 300 ? tc.args_string.substring(0, 300) + '…' : tc.args_string)
                            : 'none';
                        parts.push(`[Tool Call: ${tc.tool_name}] Args: ${argsSnippet} → Result(${tc.status}): ${resultSnippet}`);
                    }
                }
            }
        } else if (msg instanceof CompactSeparatorMessage) {
            parts.push(`[Previous Context Summary]:\n${msg.summary}`);
        }
    }

    return parts.join('\n\n');
}

/**
 * 调用 LLM 生成对话历史的结构化总结
 */
async function generateSummary(
    messages: ChatMessage[],
    model?: string
): Promise<string> {
    const messagesText = buildMessagesText(messages);
    const question = new UserMessage();
    question.appendText(
        `${getCompressionPrompt()}\n\n---\n\n以下是需要总结的对话历史：\n\n${messagesText}`
    );
    return await LLM.ask(question, model);
}

/** 统计消息列表中的对话轮次和工具调用数 */
function countMessageStats(messages: ChatMessage[]): { userMsgs: number; assistantMsgs: number; toolCalls: number } {
    let userMsgs = 0, assistantMsgs = 0, toolCalls = 0;
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
 * Level 2：插入或渐进式前移 CompactSeparatorMessage。
 *
 * - 首次：separator 放在总消息数的 50% 位置。
 * - 再次：separator 前移到"旧位置 ↔ 末尾"的中点，每次砍掉剩余消息的一半。
 * - 保底：separator 后至少保留 MIN_KEPT_MESSAGES 条消息，否则视为已压缩到极限。
 */
async function compressWithSeparator(chatContext: ChatContext, model?: string): Promise<void> {
    const existingSep = chatContext.findCompactSeparator();
    const oldIndex = existingSep?.index;

    // 移除已存在的 separator（用 role 字段检查，避免 instanceof 跨模块失效）
    chatContext.messages = chatContext.messages.filter(
        m => (m as any).role !== 'compact_separator'
    );

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
        logger.info(
            `[Compact L2] 已压缩到极限: separator 后仅剩 ${totalMessages - oldIndex} 条消息, 无法继续前移`
        );
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

    const action = oldIndex === undefined ? '插入'
        : (separatorPosition > oldIndex ? `前移 ${oldIndex} → ${separatorPosition}` : '重新生成');

    logger.info(
        `[Compact L2] ${action} 分隔符, 位置 ${separatorPosition}/${totalMessages}, ` +
        `折叠: ${summarizedStats.userMsgs} 条用户 + ${summarizedStats.assistantMsgs} 条助手 ` +
        `(${summarizedStats.toolCalls} 个工具调用), ` +
        `保留: ${keptStats.userMsgs} 条用户 + ${keptStats.assistantMsgs} 条助手 ` +
        `(${keptStats.toolCalls} 个工具调用), 正在生成总结…`
    );

    try {
        const summary = await generateSummary(messagesToSummarize, model);
        const separator = new CompactSeparatorMessage(summary);
        chatContext.messages.splice(separatorPosition, 0, separator);
        logger.info(`[Compact L2] 结构化总结生成完成 (${summary.length} 字符)`);
    } catch (err: any) {
        logger.error(`[Compact L2] 总结生成失败: ${err?.message ?? err}`);
    }
}

/**
 * 上下文压缩主入口：先尝试 Level 1，无效果则触发 Level 2。
 *
 * @returns 是否执行了压缩操作
 */
export async function compactContext(chatContext: ChatContext, model?: string): Promise<boolean> {
    chatContext.deduplicateSeparators();
    const totalMessages = chatContext.messages.filter(m => (m as any).role !== 'compact_separator').length;
    logger.info(`[Compact] 开始压缩, 当前消息数: ${totalMessages}`);

    const newlyCompressed = compressToolCalls(chatContext);

    if (newlyCompressed === 0) {
        logger.info('[Compact] Level 1 无新增效果, 升级到 Level 2');
        await compressWithSeparator(chatContext, model);
    } else {
        // Level 1 有效果，但如果 separator 还不存在且消息数较多，也主动启动 Level 2
        const hasSeparator = chatContext.findCompactSeparator() !== undefined;
        if (!hasSeparator && totalMessages > MIN_KEPT_MESSAGES * 2) {
            logger.info('[Compact] Level 1 完成, 消息数仍较多且无 separator, 同时执行 Level 2');
            await compressWithSeparator(chatContext, model);
        }
    }
    return true;
}

/**
 * 获取模型的上下文窗口大小（先查内置表，再查 API）
 */
async function getContextSize(model?: string): Promise<number> {
    try {
        let modelInstance: ModelInstance;
        if (typeof model === 'string') {
            const instance = Setting.getInstance().getModelInstance(model);
            if (!instance) return 0;
            modelInstance = instance;
        } else {
            modelInstance = Setting.getInstance().getDefaultModelInstance();
        }

        const knownSize = lookupKnownContextSize(modelInstance.model_name);
        if (knownSize > 0) return knownSize;

        return await fetchContextSizeFromAPI(modelInstance);
    } catch {
        return 0;
    }
}

/**
 * 判断当前上下文是否需要压缩（prompt_tokens >= contextSize * 80%）
 */
export async function shouldCompact(chatContext: ChatContext, model?: string): Promise<boolean> {
    let lastUsage: { prompt_tokens: number } | undefined;
    for (let i = chatContext.messages.length - 1; i >= 0; i--) {
        const msg = chatContext.messages[i];
        if (msg instanceof AssistantMessage && msg.usage) {
            lastUsage = msg.usage;
            break;
        }
    }

    if (!lastUsage) return false;

    const contextSize = await getContextSize(model);
    if (contextSize <= 0) return false;

    const threshold = contextSize * 0.8;
    const needed = lastUsage.prompt_tokens >= threshold;
    if (needed) {
        logger.info(
            `[Compact] 自动压缩触发: prompt_tokens=${lastUsage.prompt_tokens}, ` +
            `阈值=${Math.floor(threshold)} (${contextSize} × 80%)`
        );
    }
    return needed;
}

// ─── 全局 afterToolCall：超长工具结果落盘并替换为摘要 ─────────────────────────────

const LARGE_TOOL_RESULT_LINES = 2000;
const LARGE_TOOL_RESULT_CHARS = 100_000; // 100KB
const ARTIFACT_HEAD_LINES = 100;
const ARTIFACT_TAIL_LINES = 200;
const ARTIFACT_HEAD_CHARS = 4_000;
const ARTIFACT_TAIL_CHARS = 8_000;

/** 不压缩这些工具的结果，保留完整输出供 agent 使用（如读文件工具） */
const TOOLS_EXCLUDED_FROM_RESULT_COMPRESSION = new Set(['readFiles']);

function isExcludedFromCompression(tool_name: string): boolean {
    return TOOLS_EXCLUDED_FROM_RESULT_COMPRESSION.has(tool_name)
        || tool_name.endsWith('-readFiles');
}

function truncateByLines(result: string): string | undefined {
    const lines = result.split('\n');
    if (lines.length <= LARGE_TOOL_RESULT_LINES) {
        return undefined;
    }
    const head = lines.slice(0, ARTIFACT_HEAD_LINES).join('\n');
    const tail = lines.slice(-ARTIFACT_TAIL_LINES).join('\n');
    const omitted = lines.length - ARTIFACT_HEAD_LINES - ARTIFACT_TAIL_LINES;
    return `${head}\n\n... [中间省略 ${omitted} 行] ...\n\n${tail}`;
}

function truncateByChars(result: string): string | undefined {
    if (result.length <= LARGE_TOOL_RESULT_CHARS) {
        return undefined;
    }
    const head = result.slice(0, ARTIFACT_HEAD_CHARS);
    const tail = result.slice(-ARTIFACT_TAIL_CHARS);
    const omittedKB = ((result.length - ARTIFACT_HEAD_CHARS - ARTIFACT_TAIL_CHARS) / 1024).toFixed(1);
    return `${head}\n\n... [中间省略约 ${omittedKB} KB] ...\n\n${tail}`;
}

function afterToolCallLargeResultToArtifact(task: TaskState, tool_call: ToolCall): void {
    if (isExcludedFromCompression(tool_call.tool_name)) {
        return;
    }
    const result = tool_call.result;
    if (result === undefined || typeof result !== 'string') {
        return;
    }

    const truncated = truncateByChars(result) ?? truncateByLines(result);
    if (!truncated) {
        return;
    }

    const artifactDir = getArtifactDirectory();
    const filename = `artifact_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}.txt`;
    const fullPath = path.join(artifactDir, filename);
    try {
        fs.writeFileSync(fullPath, result, 'utf8');
    } catch (err) {
        logger.error(`[Compact] 写入 artifact 失败: ${(err as Error)?.message ?? err}`);
        return;
    }
    tool_call.result = `${truncated}\n\n完整输出已保存至: ${fullPath}\n若需完整内容请通过读文件方式获取。`;
    const sizeKB = (result.length / 1024).toFixed(1);
    logger.info(`[Compact] 工具结果过大 (${sizeKB} KB, ${result.split('\n').length} 行)，已落盘: ${fullPath}`);
}

HookRegistry.afterToolCall(afterToolCallLargeResultToArtifact);
