/**
 * Combined long-term memory review tests.
 */

import { HookRegistry } from '../../../main/aikernel/hooks';
import { AssistantMessage, UserMessage } from '../../../main/aikernel/messages';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks';
import {
    buildMemoryReviewPrompt,
    buildMemoryReviewSystemPrompt,
    formatConversationForMemoryReview,
    registerMemoryReviewHook
} from '../../../main/aikernel/memory/review';
import { BaseToolset } from '../../../main/aikernel/tool';

function resetHookRegistry(): void {
    HookRegistry.beforeFinishTurnCallbacks = [];
    HookRegistry.afterFinishTurnCallbacks = [];
    HookRegistry.beforeTaskStartCallbacks = [];
    HookRegistry.onTaskReviewCallbacks = [];
    HookRegistry.afterParseToolcallCallbacks = [];
    HookRegistry.beforeToolCallCallbacks = [];
    HookRegistry.afterToolCallCallbacks = [];
}

afterEach(() => {
    resetHookRegistry();
});

describe('联合长期记忆回顾', () => {
    test('全局自动回顾只注册一个联合 hook', () => {
        const taskManagerState = new TaskManagerState();
        taskManagerState.toolsetProvider = {
            listAvailableToolsets: async () => [] as BaseToolset[]
        };
        const options = {
            taskManagerState,
            initializeReviewTask: async (_task: TaskState) => {}
        };

        registerMemoryReviewHook(options);
        registerMemoryReviewHook(options);

        expect(HookRegistry.onTaskReviewCallbacks).toHaveLength(1);
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
});
