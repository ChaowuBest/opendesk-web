/**
 * Combined long-term memory review tests.
 */

import { jest } from '@jest/globals';
import { GlobalHooks } from '../../../main/aikernel/hooks';
import { AssistantMessage, UserMessage } from '../../../main/aikernel/messages';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks';
import {
    buildMemoryReviewPrompt,
    buildMemoryReviewSystemPrompt,
    formatConversationForMemoryReview,
    MemoryReviewQueue,
    MEMORY_REVIEW_TASK_NAME,
    registerMemoryReviewHook
} from '../../../main/aikernel/memory/review';
import { BaseToolset } from '../../../main/aikernel/tool';

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function createReviewOptions() {
    const taskManagerState = new TaskManagerState();
    taskManagerState.toolsetProvider = {
        listAvailableToolsets: async () => [] as BaseToolset[]
    };
    return {
        taskManagerState,
        initializeReviewTask: async (_task: TaskState) => {}
    };
}

function resetHookRegistry(): void {
    GlobalHooks.beforeFinishTurnHooks = [];
    GlobalHooks.afterFinishTurnHooks = [];
    GlobalHooks.beforeTaskStartHooks = [];
    GlobalHooks.onTaskReviewHooks = [];
    GlobalHooks.afterParseToolcallHooks = [];
    GlobalHooks.beforeToolCallHooks = [];
    GlobalHooks.afterToolCallHooks = [];
}

afterEach(() => {
    resetHookRegistry();
});

describe('联合长期记忆回顾', () => {
    test('全局自动回顾只注册一个联合 hook', () => {
        const options = createReviewOptions();

        registerMemoryReviewHook(options);
        registerMemoryReviewHook(options);

        expect(GlobalHooks.onTaskReviewHooks).toHaveLength(1);
    });

    test('联合 system prompt 同时维护用户画像和关键事实记忆', () => {
        const prompt = buildMemoryReviewSystemPrompt(
            '/tmp/memory/user.md',
            '/workspace/.opendesk/memory/memory.json',
            '/tmp/memory/memory.json'
        );

        expect(prompt).toContain('同一个任务中维护用户画像 user.md 和关键事实记忆 memory.json');
        expect(prompt).toContain('updateUserPortrait(content)');
        expect(prompt).toContain('addMemory(scope, title, content)');
        expect(prompt).toContain('每条候选信息必须先分类，只能进入一个位置');
        expect(prompt).toContain('个人偏好、身份背景、沟通习惯、长期协作要求，必须写入用户画像');
        expect(prompt).toContain('项目事实不要写入用户画像');
    });

    test('联合 review prompt 包含当前画像、事实记忆索引和本轮对话', () => {
        const prompt = buildMemoryReviewPrompt(
            '# 用户画像\n\n- 偏好简洁输出。',
            '- [workspace / 工作区] abc123 · heat=2 · 项目构建命令',
            '用户: 项目使用 npm run build 构建。'
        );

        expect(prompt).toContain('# 用户画像');
        expect(prompt).toContain('abc123');
        expect(prompt).toContain('用户: 项目使用 npm run build 构建。');
        expect(prompt).toContain('逐条判断候选信息属于用户画像、workspace 关键事实、global 关键事实');
    });

    test('联合回顾对话只截取 startMessageIndex 之后的用户和助手文本', () => {
        const task = new TaskState(new TaskManagerState());
        task.chat_context.appendMessage(new UserMessage('旧消息'));

        const assistant = new AssistantMessage();
        assistant.appendText('我会记录长期事实。');
        task.chat_context.appendMessage(new UserMessage('以后请用简体中文回答。'));
        task.chat_context.appendMessage(assistant);

        const formatted = formatConversationForMemoryReview(task, 1);

        expect(formatted).not.toContain('旧消息');
        expect(formatted).toContain('用户: 以后请用简体中文回答。');
        expect(formatted).toContain('OpenDesk: 我会记录长期事实。');
    });

    test('联合回顾对话使用冻结的 endMessageIndex 排除排队期间新增消息', () => {
        const task = new TaskState(new TaskManagerState());
        task.chat_context.appendMessage(new UserMessage('旧消息'));
        task.chat_context.appendMessage(new UserMessage('本批消息'));
        task.chat_context.appendMessage(new UserMessage('排队期间新增消息'));

        const formatted = formatConversationForMemoryReview(task, 1, 2);

        expect(formatted).not.toContain('旧消息');
        expect(formatted).toContain('用户: 本批消息');
        expect(formatted).not.toContain('排队期间新增消息');
    });

    test('多个任务的回顾请求按入队顺序串行执行', async () => {
        const options = createReviewOptions();
        const sourceTaskA = new TaskState(options.taskManagerState);
        const sourceTaskB = new TaskState(options.taskManagerState);
        const reviewTaskA = new TaskState(options.taskManagerState);
        const reviewTaskB = new TaskState(options.taskManagerState);
        const reviewTaskAFinished = createDeferred();
        const executionOrder: string[] = [];

        jest.spyOn(reviewTaskA, 'waitUntilFinished').mockImplementation(async () => {
            executionOrder.push('wait-a');
            await reviewTaskAFinished.promise;
        });
        jest.spyOn(reviewTaskB, 'waitUntilFinished').mockImplementation(async () => {
            executionOrder.push('wait-b');
        });
        const startReviewTask = jest.fn(async (sourceTask: TaskState) => {
            if (sourceTask === sourceTaskA) {
                executionOrder.push('start-a');
                return reviewTaskA;
            }
            executionOrder.push('start-b');
            return reviewTaskB;
        });
        const queue = new MemoryReviewQueue(options, startReviewTask);

        expect(queue.enqueue(sourceTaskA, 0)).toBe(true);
        expect(queue.enqueue(sourceTaskB, 0)).toBe(true);
        await Promise.resolve();

        expect(startReviewTask).toHaveBeenCalledTimes(1);
        expect(executionOrder).toEqual(['start-a', 'wait-a']);

        reviewTaskAFinished.resolve();
        await queue.waitUntilIdle();

        expect(startReviewTask).toHaveBeenCalledTimes(2);
        expect(executionOrder).toEqual(['start-a', 'wait-a', 'start-b', 'wait-b']);
    });

    test('同一任务尚未执行的回顾请求合并 start 和 end 范围', async () => {
        const options = createReviewOptions();
        const blockerSourceTask = new TaskState(options.taskManagerState);
        const pendingSourceTask = new TaskState(options.taskManagerState);
        const blockerReviewTask = new TaskState(options.taskManagerState);
        const pendingReviewTask = new TaskState(options.taskManagerState);
        const blockerFinished = createDeferred();

        pendingSourceTask.chat_context.appendMessage(new UserMessage('message 0'));
        pendingSourceTask.chat_context.appendMessage(new UserMessage('message 1'));
        pendingSourceTask.chat_context.appendMessage(new UserMessage('message 2'));

        jest.spyOn(blockerReviewTask, 'waitUntilFinished').mockImplementation(async () => {
            await blockerFinished.promise;
        });
        jest.spyOn(pendingReviewTask, 'waitUntilFinished').mockResolvedValue();
        const startReviewTask = jest.fn(async (sourceTask: TaskState) =>
            sourceTask === blockerSourceTask ? blockerReviewTask : pendingReviewTask
        );
        const queue = new MemoryReviewQueue(options, startReviewTask);

        queue.enqueue(blockerSourceTask, 0);
        queue.enqueue(pendingSourceTask, 1);

        pendingSourceTask.chat_context.appendMessage(new UserMessage('message 3'));
        pendingSourceTask.chat_context.appendMessage(new UserMessage('message 4'));
        queue.enqueue(pendingSourceTask, 2);

        blockerFinished.resolve();
        await queue.waitUntilIdle();

        expect(startReviewTask).toHaveBeenNthCalledWith(2, pendingSourceTask, 1, options, 5);
    });

    test('同一任务运行期间的新请求形成下一批', async () => {
        const options = createReviewOptions();
        const sourceTask = new TaskState(options.taskManagerState);
        const firstReviewTask = new TaskState(options.taskManagerState);
        const secondReviewTask = new TaskState(options.taskManagerState);
        const firstReviewFinished = createDeferred();

        sourceTask.chat_context.appendMessage(new UserMessage('message 0'));
        sourceTask.chat_context.appendMessage(new UserMessage('message 1'));

        jest.spyOn(firstReviewTask, 'waitUntilFinished').mockImplementation(async () => {
            await firstReviewFinished.promise;
        });
        jest.spyOn(secondReviewTask, 'waitUntilFinished').mockResolvedValue();
        const startReviewTask = jest
            .fn()
            .mockResolvedValueOnce(firstReviewTask)
            .mockResolvedValueOnce(secondReviewTask);
        const queue = new MemoryReviewQueue(options, startReviewTask);

        expect(queue.enqueue(sourceTask, 0)).toBe(true);
        await Promise.resolve();
        expect(startReviewTask).toHaveBeenNthCalledWith(1, sourceTask, 0, options, 2);

        sourceTask.chat_context.appendMessage(new UserMessage('message 2'));
        sourceTask.chat_context.appendMessage(new UserMessage('message 3'));
        expect(queue.enqueue(sourceTask, 2)).toBe(true);
        expect(startReviewTask).toHaveBeenCalledTimes(1);

        firstReviewFinished.resolve();
        await queue.waitUntilIdle();

        expect(startReviewTask).toHaveBeenNthCalledWith(2, sourceTask, 2, options, 4);
        expect(secondReviewTask.waitUntilFinished).toHaveBeenCalledTimes(1);
    });

    test('拒绝子任务、内部任务和长期记忆回顾任务', async () => {
        const options = createReviewOptions();
        jest.spyOn(options.taskManagerState, 'save').mockImplementation(() => undefined);
        const childTask = new TaskState(options.taskManagerState, 'parent-task');
        const internalTask = new TaskState(options.taskManagerState);
        internalTask.markAsInternal();
        const memoryReviewTask = new TaskState(options.taskManagerState);
        memoryReviewTask.rename(MEMORY_REVIEW_TASK_NAME);
        const startReviewTask = jest.fn();
        const queue = new MemoryReviewQueue(options, startReviewTask);

        expect(queue.enqueue(childTask, 0)).toBe(false);
        expect(queue.enqueue(internalTask, 0)).toBe(false);
        expect(queue.enqueue(memoryReviewTask, 0)).toBe(false);
        await queue.waitUntilIdle();

        expect(startReviewTask).not.toHaveBeenCalled();
    });

    test('一个回顾请求失败后继续处理下一项且不重试', async () => {
        const options = createReviewOptions();
        const sourceTaskA = new TaskState(options.taskManagerState);
        const sourceTaskB = new TaskState(options.taskManagerState);
        const reviewTaskB = new TaskState(options.taskManagerState);

        jest.spyOn(reviewTaskB, 'waitUntilFinished').mockResolvedValue();
        const startReviewTask = jest.fn(async (sourceTask: TaskState) => {
            if (sourceTask === sourceTaskA) {
                throw new Error('review A failed');
            }
            return reviewTaskB;
        });
        const queue = new MemoryReviewQueue(options, startReviewTask);

        queue.enqueue(sourceTaskA, 0);
        queue.enqueue(sourceTaskB, 0);
        await queue.waitUntilIdle();

        expect(startReviewTask).toHaveBeenCalledTimes(2);
        expect(startReviewTask.mock.calls.map(([sourceTask]) => sourceTask)).toEqual([sourceTaskA, sourceTaskB]);
        expect(reviewTaskB.waitUntilFinished).toHaveBeenCalledTimes(1);
    });
});
