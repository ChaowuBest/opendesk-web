import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import { registerDeadloopHarness } from '../../../main/aikernel/harnesses/chat/deadloop.js';
import { LLM } from '../../../main/aikernel/llm.js';
import {
    AssistantMessage,
    AssistantResponse,
    ChatContext,
    Usage,
    UserMessage
} from '../../../main/aikernel/messages.js';
import { deserializeTaskData, forkTask } from '../../../main/aikernel/task/serializer.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { AbstractPlatform, setPlatform } from '../../../platforms/base.js';
import { setCustomOpendeskDirectory, Setting } from '../../../main/utils/setting.js';

class TestPlatform extends AbstractPlatform {
    getName(): string {
        return 'test';
    }

    getEffectiveWorkspace(): string {
        return process.cwd();
    }

    async initPlatformHarness(_task: TaskState): Promise<void> {}

    async fetch(_input: string | URL, _init?: RequestInit): Promise<Response> {
        return new Response('{}', { status: 200 });
    }
}

function configureSetting(locale: string): void {
    Setting.updateInstanceData({
        locale,
        default_model: 'mock-model',
        providers: [
            {
                name: 'mock-provider',
                provider_type: 'openai',
                base_url: 'https://mock.local/v1',
                api_key: 'test-key',
                no_proxy: true
            }
        ],
        models: [
            {
                alias: 'mock-model',
                provider_name: 'mock-provider',
                model_name: 'mock/model',
                context_length: 8192,
                max_output_tokens: 4096
            }
        ],
        task_config: {
            generate_taskname: false
        }
    });
}

function createTask(locale = 'zh-CN'): TaskState {
    configureSetting(locale);
    const manager = new TaskManagerState();
    manager.save = jest.fn();
    manager.publishTaskListUpdate = jest.fn();
    manager.moveTaskToEnd = jest.fn();
    const task = new TaskState(manager);
    manager.tasks.push(task);
    return task;
}

function mockTurn(task: TaskState): void {
    jest.spyOn(task, 'buildToolsets').mockResolvedValue([]);
    jest.spyOn(task, 'processTaskTurn').mockResolvedValue(undefined);
}

function textOf(message: UserMessage): string {
    return message.content
        .filter((part) => part.type === 'text')
        .map((part) => (part as { text?: string }).text ?? '')
        .join('');
}

function localeReminders(task: TaskState): UserMessage[] {
    return task.chat_context.messages.filter(
        (message): message is UserMessage =>
            message instanceof UserMessage && message.internal === true && textOf(message).includes('<system-reminder>')
    );
}

function lastIndexOfUserMessage(messages: ChatContext['messages']): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i] instanceof UserMessage) return i;
    }
    return -1;
}

async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('condition not met');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

describe('task currentLocale 语言切换提醒', () => {
    let tempDir: string;

    beforeEach(() => {
        registerDeadloopHarness();
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-task-locale-reminder-'));
        setCustomOpendeskDirectory(tempDir);
        Setting.clearCache();
        setPlatform(new TestPlatform());
    });

    afterEach(() => {
        jest.restoreAllMocks();
        Setting.clearCache();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('首次提交在首条用户消息前注入语言提醒并记录 currentLocale', async () => {
        const task = createTask('zh-CN');
        mockTurn(task);

        await task.submitUserMessage('你好');

        const reminders = localeReminders(task);
        expect(reminders).toHaveLength(1);
        expect(textOf(reminders[0])).toBe(
            '<system-reminder>The system language is now 中文 (zh-CN); ' +
                'please respond with 中文 language in the following conversation.</system-reminder>'
        );
        expect(task.currentLocale).toBe('zh-CN');

        const messages = task.chat_context.messages;
        const firstVisibleUserIndex = messages.findIndex((m) => m instanceof UserMessage && m.internal !== true);
        expect(firstVisibleUserIndex).toBe(1);
        expect(messages[firstVisibleUserIndex - 1]).toBe(reminders[0]);
        expect(textOf(messages[firstVisibleUserIndex] as UserMessage)).toBe('你好');
    });

    test('语言未变化时重复提交不再注入提醒', async () => {
        const task = createTask('zh-CN');
        mockTurn(task);

        await task.submitUserMessage('第一条');
        await task.submitUserMessage('第二条');

        const reminders = localeReminders(task);
        expect(reminders).toHaveLength(1);
        expect(task.currentLocale).toBe('zh-CN');
        const messages = task.chat_context.messages;
        expect(messages[lastIndexOfUserMessage(messages) - 1]).not.toBe(reminders[0]);
    });

    test('切换语言后再次提交注入新提醒并更新 currentLocale', async () => {
        const task = createTask('zh-CN');
        mockTurn(task);
        await task.submitUserMessage('第一条');

        configureSetting('en-US');
        await task.submitUserMessage('switch language');

        const reminders = localeReminders(task);
        expect(reminders).toHaveLength(2);
        expect(textOf(reminders[1])).toContain('English');
        expect(textOf(reminders[1])).toContain('en-US');
        expect(task.currentLocale).toBe('en-US');

        const messages = task.chat_context.messages;
        const lastUserIndex = lastIndexOfUserMessage(messages);
        expect(textOf(messages[lastUserIndex] as UserMessage)).toBe('switch language');
        expect(messages[lastUserIndex - 1]).toBe(reminders[1]);
    });

    test('语言提醒随请求上下文一起发送给 LLM', async () => {
        const task = createTask('zh-CN');
        task.model = 'mock-model';
        jest.spyOn(task, 'buildToolsets').mockResolvedValue([]);
        const capturedContexts: ChatContext[] = [];
        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* (chatContext) {
            capturedContexts.push(chatContext);
            const message = new AssistantMessage();
            message.appendText('好的');
            const response = new AssistantResponse(message, 'stop');
            response.usage = new Usage(10, 2, 12);
            yield response;
        });

        await task.submitUserMessage('第一句');
        await waitFor(() => capturedContexts.length > 0);
        await waitFor(() => task.task_status !== 'running');

        expect(capturedContexts).toHaveLength(1);
        const requestMessages = capturedContexts[0].messages;
        const lastUserIndex = lastIndexOfUserMessage(requestMessages);
        expect(textOf(requestMessages[lastUserIndex] as UserMessage)).toBe('第一句');
        const reminder = requestMessages[lastUserIndex - 1];
        expect(reminder).toBeInstanceOf(UserMessage);
        expect((reminder as UserMessage).internal).toBe(true);
        expect(textOf(reminder as UserMessage)).toContain('<system-reminder>');
    });

    test('currentLocale 随 task JSON 持久化、恢复且 fork 时复制', async () => {
        const task = createTask('zh-CN');
        mockTurn(task);
        await task.submitUserMessage('persist me');
        expect(task.currentLocale).toBe('zh-CN');

        const json = task.toJSON() as Record<string, unknown>;
        expect(json.current_locale).toBe('zh-CN');

        const restored = deserializeTaskData(json, task.task_manager_state);
        expect(restored.currentLocale).toBe('zh-CN');

        const legacy = { ...json, current_locale: null };
        const restoredLegacy = deserializeTaskData(legacy, task.task_manager_state);
        expect(restoredLegacy.currentLocale).toBeUndefined();

        const forked = forkTask(task);
        expect(forked.currentLocale).toBe('zh-CN');
    });
});
