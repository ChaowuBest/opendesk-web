import { logger } from '../utils/logger';
import { Setting } from '../utils/setting';
import { LLM } from './llm';
import { ChatContext, SystemMessage } from './messages';
import type { TaskState } from './states/tasks';

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

export async function checkTerminationFromMessages(
    userQuestion: string,
    lastTextResponse: string
): Promise<TerminationState> {
    let userMessage = TERMINATION_SYSTEM_PROMPT + '\n\n';
    userMessage += `用户的原始问题为: ${userQuestion}\n`;
    userMessage += `你的回答的最后一部分为: ${lastTextResponse}\n\n请你判断对话的状态。`;
    const model = Setting.getInstance().getDefaultModelInstance();
    const rawResult = await LLM.ask(userMessage, model);
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

export async function checkTermination(taskState: TaskState): Promise<TerminationState> {
    const lastMessage = taskState.chat_context.lastMessage();
    const lastUserMessage = taskState.chat_context.lastUserMessage();
    if (!lastUserMessage || !lastMessage || lastMessage.role !== 'assistant') {
        /* 这显然是不正常的, 只有在任务状态中存在用户的信息和Agent的最近的补全信息的时候，才应该调用这个函数 */
        throw new Error('termination state check failed: no user message or last message');
    }

    const lastAssistantMessagePart = lastMessage.content[lastMessage.content.length - 1];
    if (lastAssistantMessagePart.type !== 'text') {
        // 如果最后一个 part 不是文本，那只能是工具等调用结果，这种情况下，对话天然应该继续进行，不可能会调用这个函数进行判断 */
        throw new Error('termination state check failed: last assistant message part is not a text');
    }

    return await checkTerminationFromMessages(lastUserMessage.getPlainText(), lastAssistantMessagePart.text);
}
