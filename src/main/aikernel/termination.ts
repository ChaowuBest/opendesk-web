import { logger } from '../utils/logger';
import { Setting } from '../utils/setting';
import { LLM } from './llm';
import type { TaskState } from './states/tasks';
import type { AssistantMessagePart } from './messages';

const TERMINATION_SYSTEM_PROMPT = `你是一个专业的对话终止状态判断助手。用户会给你一段对话内容，包含原始的用户问题和AI回答的最后一部分。
你需要判断这个对话的终止状态，只能输出以下三个词之一: finished, interrupted, question。

判断标准:

interrupted — 满足以下任一条件即判定为 interrupted:
- 回复中提到了"接下来""下一步""继续""正在处理"等词语，暗示后续还有操作要做但尚未完成;
- 回复中列出了多个步骤/计划，但明显只完成了部分;
- 回复以一个动作的开头结束（如"首先搜索...""让我先..."），没有给出该动作的结果;
- 回复看起来像是被截断的，缺少结论或总结。

question — 满足以下任一条件即判定为 question:
- 回复中包含向用户提出的问题（如"请问...""你希望...""能否提供..."等疑问句）;
- 回复明确表示需要用户提供更多信息才能继续。

finished — 仅当以下条件都满足时才判定为 finished:
- 回复已经完整回答了用户的问题，或者已经完成了用户请求的任务;
- 回复中没有未完成的后续步骤;
- 回复中没有向用户提出需要回答的问题。

请只输出一个词: finished、interrupted 或 question。不要输出任何解释或其他内容。`;

type TerminationState = 'finished' | 'interrupted' | 'question';

const TERMINATION_CHECK_TIMEOUT_MS = 8_000;

export function fastInterruptionCheck(lastTextResponse: string): 'interrupted' | null {
    // 常见中英文标点，用于拆分子句
    const sentenceDelimiters = /[，。！？：；、,.!?:;\n]+/;
    const clauses = lastTextResponse.split(sentenceDelimiters).filter((c) => c.trim());
    if (clauses.length === 0) {
        return null;
    }

    const lastClause = clauses[clauses.length - 1].trim();

    // 最后一段子句以"接下来"或"让我"开头
    if (lastClause.startsWith('接下来') || lastClause.startsWith('让我')) {
        return 'interrupted';
    }

    // 原文以未正常终止的标点结尾（逗号、冒号、顿号、分号）
    const trimmed = lastTextResponse.trimEnd();
    const incompleteEndings = [',', '，', ':', '：', '、', ';', '；'];
    if (incompleteEndings.some((ending) => trimmed.endsWith(ending))) {
        return 'interrupted';
    }

    return null;
}

export async function checkTerminationFromMessages(
    userQuestion: string,
    lastTextResponse: string,
    model?: string
): Promise<TerminationState> {
    const fastResult = fastInterruptionCheck(lastTextResponse);
    if (fastResult === 'interrupted') {
        logger.info('termination state checked via fast path: interrupted');
        return 'interrupted';
    }

    let userMessage = TERMINATION_SYSTEM_PROMPT + '\n\n';
    userMessage += `用户的原始问题为: ${userQuestion}\n`;
    userMessage += `你的回答的最后一部分为: ${lastTextResponse}\n\n请你判断对话的状态。`;
    const modelParam = model || Setting.getInstance().getDefaultModelInstance();
    if (!modelParam) {
        logger.warn('model not configured, skipping termination check');
        return 'finished';
    }

    let rawResult: string;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        rawResult = await Promise.race([
            LLM.ask(userMessage, modelParam, { reasoningEffort: 'none' }),
            new Promise<never>((_, reject) => {
                timeout = setTimeout(
                    () => reject(new Error('termination check timeout')),
                    TERMINATION_CHECK_TIMEOUT_MS
                );
                timeout.unref?.();
            })
        ]);
    } catch {
        logger.warn('termination check timed out or failed, defaulting to finished');
        return 'finished';
    } finally {
        if (timeout) {
            clearTimeout(timeout);
        }
    }

    const normalized = rawResult.trim().toLowerCase();

    logger.info(`termination state checked: ${rawResult} (normalized: ${normalized})`);

    if (normalized.includes('interrupted')) {
        return 'interrupted';
    } else if (normalized.includes('question')) {
        return 'question';
    } else if (normalized.includes('finished')) {
        return 'finished';
    } else {
        return 'finished';
    }
}

/**
 * 从 AssistantMessage 的 content 中提取用于终止状态判断的文本。
 * 从后往前扫描，收集 TextMessagePart 和 ReasoningMessagePart，
 * 遇到第一个 ToolCallMessagePart 时停止。
 */
function extractTrailingResponse(parts: AssistantMessagePart[]): string {
    const lines: string[] = [];
    for (let i = parts.length - 1; i >= 0; i--) {
        const part = parts[i];
        if (part.type === 'tool_call') {
            break;
        }
        if (part.type === 'text') {
            const text = String(part.text);
            if (text.trim()) {
                lines.unshift(text.trim());
            }
        } else if (part.type === 'reasoning') {
            const content = String(part.content);
            if (content.trim()) {
                lines.unshift(`[思考] ${content.trim()}`);
            }
        }
    }
    return lines.join('\n');
}

export async function checkTermination(taskState: TaskState): Promise<TerminationState> {
    // 过滤掉 internal 消息（如熔断器插入的系统提示），只保留用户可见的真实对话
    const visibleMessages = taskState.chat_context.messages.filter((msg) => !(msg.role === 'user' && msg.internal));

    // 从过滤后的消息列表中找 lastUserMessage 和 lastMessage
    let lastUserMessage: { role: 'user'; getPlainText: () => string } | undefined;
    let lastAssistantMessage: { role: 'assistant'; content: AssistantMessagePart[] } | undefined;

    for (let i = visibleMessages.length - 1; i >= 0; i--) {
        const msg = visibleMessages[i];
        if (msg.role === 'assistant' && !lastAssistantMessage) {
            lastAssistantMessage = msg as { role: 'assistant'; content: AssistantMessagePart[] };
        } else if (msg.role === 'user' && !lastUserMessage) {
            lastUserMessage = msg as { role: 'user'; getPlainText: () => string };
        }
        if (lastUserMessage && lastAssistantMessage) break;
    }

    if (!lastUserMessage || !lastAssistantMessage) {
        /* 这显然是不正常的, 只有在任务状态中存在用户的信息和Agent的最近的补全信息的时候，才应该调用这个函数 */
        throw new Error('termination state check failed: no user message or last message');
    }

    const trailingResponse = extractTrailingResponse(lastAssistantMessage.content);
    if (!trailingResponse) {
        // 最后一个 ToolCallMessagePart 之后没有任何文本或思考内容，说明对话被截断
        return 'interrupted';
    }

    return await checkTerminationFromMessages(lastUserMessage.getPlainText(), trailingResponse, taskState.model);
}
