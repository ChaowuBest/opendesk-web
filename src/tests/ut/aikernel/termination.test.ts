import { jest } from '@jest/globals';
import { LLM } from '../../../main/aikernel/llm.js';
import {
    AssistantMessage,
    ReasoningMessagePart,
    TextMessagePart,
    ToolCallMessagePart,
    UserMessage
} from '../../../main/aikernel/messages.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { checkTermination, checkTerminationFromMessages } from '../../../main/aikernel/termination.js';
import { logger } from '../../../main/utils/logger.js';
import { Setting } from '../../../main/utils/setting.js';

describe('termination request options', () => {
    afterEach(() => {
        jest.restoreAllMocks();
        Setting.clearCache();
    });

    test('forwards runtime headers and disables reasoning', async () => {
        const askSpy = jest.spyOn(LLM, 'ask').mockResolvedValue('finished');
        jest.spyOn(Setting.getInstance(), 'getDefaultQuickModelInstance').mockReturnValue(null);
        const extraHeaders = {
            cookie: 'session=test',
            trace_id: 'trace-test'
        };

        const result = await checkTerminationFromMessages('完成当前任务', '任务已经处理完成。', 'test-model', {
            extraHeaders,
            reasoningEffort: 'high'
        });

        expect(result).toBe('finished');
        expect(askSpy).toHaveBeenCalledWith(expect.any(String), 'test-model', {
            extraHeaders,
            reasoningEffort: 'none'
        });
    });

    test('glm-5.3（不支持关闭思考）终止性检查使用其最低档位 low', async () => {
        const askSpy = jest.spyOn(LLM, 'ask').mockResolvedValue('finished');
        Setting.updateInstanceData({
            default_model: 'glm53',
            providers: [
                {
                    name: 'p',
                    provider_type: 'openai',
                    base_url: 'https://mock.local/v1',
                    api_key: 'test-key',
                    no_proxy: true
                }
            ],
            models: [{ alias: 'glm53', provider_name: 'p', model_name: 'glm-5.3' }]
        });

        const result = await checkTerminationFromMessages('完成当前任务', '任务已经处理完成。', 'glm53');

        expect(result).toBe('finished');
        expect(askSpy).toHaveBeenCalledWith(expect.any(String), 'glm53', { reasoningEffort: 'low' });
    });

    test('treats a reasoning-only assistant response as interrupted', async () => {
        const askSpy = jest.spyOn(LLM, 'ask').mockResolvedValue('finished');
        const task = new TaskState(new TaskManagerState());
        task.chat_context.appendMessage(new UserMessage('complete the task'));
        task.chat_context.appendMessage(
            new AssistantMessage([
                new ReasoningMessagePart('I should inspect the repository first.', 'reasoning_content')
            ])
        );

        await expect(checkTermination(task)).resolves.toBe('interrupted');
        expect(askSpy).not.toHaveBeenCalled();
    });

    test('treats an assistant response ending in reasoning as interrupted', async () => {
        const askSpy = jest.spyOn(LLM, 'ask').mockResolvedValue('finished');
        const task = new TaskState(new TaskManagerState());
        task.chat_context.appendMessage(new UserMessage('complete the task'));
        task.chat_context.appendMessage(
            new AssistantMessage([
                new TextMessagePart('I have started working on the task.'),
                new ReasoningMessagePart('I still need to produce the final answer.', 'reasoning_content')
            ])
        );

        await expect(checkTermination(task)).resolves.toBe('interrupted');
        expect(askSpy).not.toHaveBeenCalled();
    });

    test('checks termination normally when visible text follows reasoning', async () => {
        const askSpy = jest.spyOn(LLM, 'ask').mockResolvedValue('finished');
        const task = new TaskState(new TaskManagerState());
        task.chat_context.appendMessage(new UserMessage('complete the task'));
        task.chat_context.appendMessage(
            new AssistantMessage([
                new ReasoningMessagePart('I should inspect the repository first.', 'reasoning_content'),
                new TextMessagePart('The task is complete.')
            ])
        );
        task.model = 'test-model';

        await expect(checkTermination(task)).resolves.toBe('finished');
        expect(askSpy).toHaveBeenCalledTimes(1);
    });

    test('only considers output after the latest tool-call round', async () => {
        const askSpy = jest.spyOn(LLM, 'ask').mockResolvedValue('finished');
        const task = new TaskState(new TaskManagerState());
        task.chat_context.appendMessage(new UserMessage('complete the task'));
        task.chat_context.appendMessage(
            new AssistantMessage([
                new TextMessagePart('Earlier visible output.'),
                new ToolCallMessagePart(),
                new ReasoningMessagePart('I still need to produce the final answer.', 'reasoning_content')
            ])
        );

        await expect(checkTermination(task)).resolves.toBe('interrupted');
        expect(askSpy).not.toHaveBeenCalled();
    });
});

describe('termination logs must not contain user content', () => {
    const USER_QUESTION = '机密的原始任务输入：请帮我整理 payroll-2026 的员工薪酬数据';
    const RESPONSE_FAST_PATH = '首先读取配置文件，';
    const RESPONSE_LLM_PATH = '任务已经处理完成。';

    let logMessages: string[];

    beforeEach(() => {
        logMessages = [];
        for (const level of ['info', 'debug', 'warn', 'error'] as const) {
            jest.spyOn(logger, level).mockImplementation(((msg: unknown) => {
                logMessages.push(String(msg));
                return undefined;
            }) as any);
        }
    });

    afterEach(() => {
        jest.restoreAllMocks();
        Setting.clearCache();
    });

    test('fast path 命中时日志不包含用户问题与回复原文', async () => {
        const result = await checkTerminationFromMessages(USER_QUESTION, RESPONSE_FAST_PATH, 'test-model');

        expect(result).toBe('interrupted');
        expect(logMessages.length).toBeGreaterThan(0);
        for (const message of logMessages) {
            expect(message).not.toContain(USER_QUESTION);
            expect(message).not.toContain(RESPONSE_FAST_PATH);
        }
    });

    test('LLM 判定路径日志不包含用户问题与回复原文', async () => {
        jest.spyOn(LLM, 'ask').mockResolvedValue('finished');

        const result = await checkTerminationFromMessages(USER_QUESTION, RESPONSE_LLM_PATH, 'test-model');

        expect(result).toBe('finished');
        expect(logMessages.length).toBeGreaterThan(0);
        for (const message of logMessages) {
            expect(message).not.toContain(USER_QUESTION);
            expect(message).not.toContain(RESPONSE_LLM_PATH);
        }
    });

    test('reasoning-only 路径日志不包含用户问题与思考原文', async () => {
        const reasoning = '机密的内部思考过程';
        const task = new TaskState(new TaskManagerState());
        task.chat_context.appendMessage(new UserMessage(USER_QUESTION));
        task.chat_context.appendMessage(
            new AssistantMessage([new ReasoningMessagePart(reasoning, 'reasoning_content')])
        );

        await expect(checkTermination(task)).resolves.toBe('interrupted');
        expect(logMessages.length).toBeGreaterThan(0);
        for (const message of logMessages) {
            expect(message).not.toContain(USER_QUESTION);
            expect(message).not.toContain(reasoning);
        }
    });
});
