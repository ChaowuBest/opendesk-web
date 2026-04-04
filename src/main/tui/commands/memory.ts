import type { OpenDeskTUI } from '../entry.js';
import { logger } from '../../utils/logger.js';
import { MemoryRegistry } from '../../aikernel/memory/registry.js';
import { MemoryListOverlay } from '../components/memorylist.js';
import { ChatContext, UserMessage, SystemMessage, AssistantMessage } from '../../aikernel/messages.js';
import { createMemoryToolset } from '../../aikernel/memory/tools.js';
import { TaskState } from '../../aikernel/states/tasks.js';

async function handleMemoryAdd(tui: OpenDeskTUI, prompt: string): Promise<void> {
    if (!tui.acquireMemoryLock('add')) return;

    const registry = MemoryRegistry.getInstance();
    registry.resetOpCounter();
    tui.memoryAddStart = Date.now();
    tui.startMemoryAddSpinner();

    const conversationSnapshot = tui.buildConversationSnapshot();

    const addPrompt = prompt
        ? `请根据以下指示，从对话中提取并保存相关记忆：\n\n${prompt}\n\n请使用 addMemory 工具保存。注意判断每条记忆应保存到全局(global)还是工作区(workspace)。`
        : '请回顾以下对话，提取所有值得长期保存的信息（用户偏好、重要事实、关键决策、有用上下文等），并使用 addMemory 工具逐条保存。注意判断每条记忆应保存到全局(global)还是工作区(workspace)。';

    const fullPrompt = `${addPrompt}\n\n---\n\n以下是对话记录：\n\n${conversationSnapshot}`;

    try {
        const bgContext = new ChatContext();
        bgContext.system_prompt = new SystemMessage(
            '你是一个记忆提取助手。你的唯一任务是从给定的对话历史中提取有价值的信息，并使用 addMemory 工具保存为长期记忆。' +
                '你只需要调用 addMemory 工具，不要输出其他内容。'
        );

        const memoryToolset = createMemoryToolset();
        bgContext.attachToolsets(memoryToolset);
        bgContext.appendMessage(new UserMessage(fullPrompt));
        bgContext.appendMessage(new AssistantMessage());

        const bgTask = new TaskState(tui.taskManagerState);
        bgTask.chat_context = bgContext;
        bgTask.model = tui.model;

        await bgTask.processTaskTurn();

        tui.stopMemorySpinner();
        tui.releaseMemoryLock();

        const elapsed = Math.floor((Date.now() - tui.memoryAddStart) / 1000);
        const count = registry.opCounter;
        if (count > 0) {
            tui.showMemoryResult('记忆提取完成', `耗时 ${elapsed} 秒，共提取 ${count} 条记忆。`);
        } else {
            tui.showMemoryResult('记忆提取完成', `耗时 ${elapsed} 秒，未发现需要保存的新记忆。`);
        }
    } catch (err: unknown) {
        tui.stopMemorySpinner();
        tui.releaseMemoryLock();
        tui.showMemoryResult('记忆提取失败', `操作出错：${err instanceof Error ? err.message : String(err)}`);
    }
}

async function handleMemorySearch(tui: OpenDeskTUI, query: string): Promise<void> {
    if (!tui.acquireMemoryLock('search')) return;
    tui.startMemorySpinner('正在搜索相关记忆...');

    const registry = MemoryRegistry.getInstance();
    try {
        const results = await registry.smartSearch(query);
        tui.stopMemorySpinner();
        tui.releaseMemoryLock();

        if (results.length === 0) {
            tui.showMemoryResult('记忆搜索', `未找到与「${query}」相关的记忆`);
            return;
        }

        const topResults = results.slice(0, 5);
        const memoriesForContext = topResults.map((r) => ({ scope: r.scope, meta: r.meta }));
        const formattedContent = registry.formatMemoriesForContext(memoriesForContext);

        const resultLines = topResults.map((r) => `  • ${r.meta.name}（相关度: ${r.relevance}/10）`).join('\n');

        tui.showMemoryResult(
            '记忆搜索完成',
            `找到 ${results.length} 条相关记忆，将前 ${topResults.length} 条注入对话上下文：\n\n${resultLines}`,
            async () => {
                const searchPrompt = `以下是根据查询"${query}"检索到的相关记忆，请参考这些信息：\n\n${formattedContent}`;
                await tui.onRequestSubmit(searchPrompt);
            }
        );
    } catch (err: unknown) {
        tui.stopMemorySpinner();
        tui.releaseMemoryLock();
        tui.showMemoryResult('记忆搜索失败', `操作出错：${err instanceof Error ? err.message : String(err)}`);
    }
}

async function handleMemoryForget(tui: OpenDeskTUI, description: string): Promise<void> {
    if (!tui.acquireMemoryLock('forget')) return;
    tui.startMemorySpinner('正在搜索并删除匹配的记忆...');

    const registry = MemoryRegistry.getInstance();
    try {
        const result = await registry.smartForget(description);
        tui.stopMemorySpinner();
        tui.releaseMemoryLock();

        if (result.deleted.length > 0) {
            const lines = result.deleted.map((d) => `  • ${d.name}`).join('\n');
            tui.showMemoryResult('记忆删除完成', `已删除 ${result.deleted.length} 条记忆：\n\n${lines}`);
        } else {
            tui.showMemoryResult('记忆删除', `未找到与「${description}」匹配的记忆`);
        }
    } catch (err: unknown) {
        tui.stopMemorySpinner();
        tui.releaseMemoryLock();
        tui.showMemoryResult('记忆删除失败', `操作出错：${err instanceof Error ? err.message : String(err)}`);
    }
}

function handleMemoryList(tui: OpenDeskTUI): void {
    const overlay = new MemoryListOverlay(tui);
    overlay.show();
}

export function registerMemoryCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'memory',
        description: '记忆管理：/memory add [提示]、/memory search <查询>、/memory forget <描述>、/memory list',
        getArgumentCompletions: (argPrefix: string) => {
            const options = ['add', 'search', 'forget', 'list'];
            const parts = argPrefix.split(/\s+/);
            if (parts.length <= 1) {
                return options
                    .filter((opt) => opt.startsWith((parts[0] || '').toLowerCase()))
                    .map((opt) => ({
                        value: opt,
                        label: opt,
                        description:
                            opt === 'add'
                                ? '添加记忆'
                                : opt === 'search'
                                  ? '搜索记忆'
                                  : opt === 'forget'
                                    ? '删除记忆'
                                    : '列出所有记忆'
                    }));
            }
            return null;
        },
        execute: async (args: string) => {
            const parts = args.trim().split(/\s+/);
            const subCommand = (parts[0] || '').toLowerCase();
            const restArgs = parts.slice(1).join(' ').trim();

            if (subCommand === 'add') {
                await handleMemoryAdd(tui, restArgs);
            } else if (subCommand === 'search') {
                if (!restArgs) {
                    logger.warn('用法：/memory search <查询关键词>');
                    return;
                }
                await handleMemorySearch(tui, restArgs);
            } else if (subCommand === 'forget') {
                if (!restArgs) {
                    logger.warn('用法：/memory forget <描述要删除的记忆>');
                    return;
                }
                await handleMemoryForget(tui, restArgs);
            } else if (subCommand === 'list') {
                handleMemoryList(tui);
            } else {
                logger.warn('用法：/memory add [提示] | /memory search <查询> | /memory forget <描述> | /memory list');
            }
        }
    });
}
