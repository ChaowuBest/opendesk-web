import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import { GlobalHooks } from '../../../main/aikernel/hooks.js';
import { LLM } from '../../../main/aikernel/llm.js';
import { AssistantMessage, AssistantResponse } from '../../../main/aikernel/messages.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { serializeTaskSimplified } from '../../../main/aikernel/task/serializer.js';
import { Setting, setCustomOpendeskDirectory } from '../../../main/utils/setting.js';
import { ModelRequestError } from '../../../main/utils/model-request-error.js';
import { AbstractPlatform, setPlatform } from '../../../platforms/base.js';

// hook 拒绝重试路径含 5s 真实 backoff，放宽全局超时兜底
jest.setTimeout(60_000);

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

function configureSetting(): void {
    Setting.updateInstanceData({
        locale: 'zh-CN',
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
            auto_retry: true
        }
    });
}

function createTask(): TaskState {
    configureSetting();
    const manager = new TaskManagerState();
    manager.save = jest.fn();
    manager.publishTaskListUpdate = jest.fn();
    const task = new TaskState(manager);
    task.task_name = 'turn-outcome-test';
    task.model = 'mock-model';
    jest.spyOn(task, 'ensureValidModelOrFallback').mockReturnValue('mock-model');
    manager.tasks.push(task);
    return task;
}

function mockTurnInfrastructure(task: TaskState): jest.Spied<typeof task.processTaskTurn> {
    jest.spyOn(task, 'buildToolsets').mockResolvedValue([]);
    jest.spyOn(task.hooks, 'noticeBeforeTurnStart').mockResolvedValue(undefined);
    jest.spyOn(task.hooks, 'noticeAfterFinishTurn').mockResolvedValue(undefined);
    jest.spyOn(task.hooks, 'checkBeforeFinishTurn').mockResolvedValue({ operation: 'finish' });
    jest.spyOn(task as any, 'scheduleSessionMemoryUpdateAfterCompletion').mockResolvedValue(undefined);
    return jest.spyOn(task, 'processTaskTurn');
}

function modelServiceErrorResponse(status: number, message: string): AssistantResponse {
    const response = AssistantResponse.richError('Stream Completion Failed', message);
    response.request_error = new ModelRequestError({
        provider: 'openai',
        message,
        status
    });
    return response;
}

function textResponse(text: string): AssistantResponse {
    const message = new AssistantMessage();
    message.appendText(text);
    return new AssistantResponse(message, 'stop');
}

describe('task failed status on model error termination', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-task-failed-status-'));
        setCustomOpendeskDirectory(tempDir);
        Setting.clearCache();
        setPlatform(new TestPlatform());
        // planning/harness 模块加载时会注册 termination 全局钩子，测试中重置隔离
        GlobalHooks.beforeFinishTurnHooks = [];
        GlobalHooks.afterFinishTurnHooks = [];
        GlobalHooks.beforeTaskStartHooks = [];
        GlobalHooks.onTaskReviewHooks = [];
        GlobalHooks.onTaskRevertHooks = [];
        GlobalHooks.afterToolcallParseHooks = [];
        GlobalHooks.beforeToolCallHooks = [];
        GlobalHooks.beforeTurnStartHooks = [];
        // 未命名任务会异步触发 LLM 自动命名，统一 mock 掉真实请求
        jest.spyOn(LLM, 'ask').mockResolvedValue('<taskname>test</taskname>');
    });

    afterEach(() => {
        jest.restoreAllMocks();
        Setting.clearCache();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('marks task as failed when an unrecoverable model error ends the turn', async () => {
        const task = createTask();
        const processSpy = mockTurnInfrastructure(task);

        // 模拟 403 No active subscription：非重试的模型服务错误终止 turn
        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* () {
            yield modelServiceErrorResponse(403, 'Error: 403 No active subscription found for this group');
        });

        await task.submitUserMessage('review the pr');
        expect(task.task_status).toBe('running');
        const finished = task.waitUntilFinished(undefined, true);
        await (processSpy.mock.results[0]?.value as Promise<void>);

        const assistant = task.chat_context.lastMessage() as AssistantMessage;
        expect(assistant.content.some((part) => part.type === 'error')).toBe(true);
        // 错误终止的任务必须进入 failed，侧栏才能区分失败与正常完成
        expect(task.task_status).toBe('failed');
        expect(task.finished_at).toBeDefined();
        // 简化快照直接携带 failed 状态，无需额外字段
        expect(serializeTaskSimplified(task).task_status).toBe('failed');
        await finished;
    });

    test('marks task as stopped when the turn completes normally', async () => {
        const task = createTask();
        const processSpy = mockTurnInfrastructure(task);

        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* () {
            yield textResponse('all done');
        });

        await task.submitUserMessage('do work');
        await (processSpy.mock.results[0]?.value as Promise<void>);

        const assistant = task.chat_context.lastMessage() as AssistantMessage;
        expect(assistant.content.some((part) => part.type === 'error')).toBe(false);
        expect(task.task_status).toBe('stopped');
    });

    test('a recovered round after hook rejection ends as stopped, not failed', async () => {
        const task = createTask();
        const processSpy = mockTurnInfrastructure(task);
        // 首轮错误后被 hook 拒绝重试，重试轮成功：最终状态必须是 stopped 而非 failed
        jest.spyOn(task.hooks, 'checkBeforeFinishTurn')
            .mockResolvedValueOnce({ operation: 'reject', message: 'call attempt_completion first' })
            .mockResolvedValueOnce({ operation: 'finish' });

        let requestCount = 0;
        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* () {
            requestCount++;
            if (requestCount === 1) {
                yield modelServiceErrorResponse(403, 'Error: 403 No active subscription found for this group');
                return;
            }
            yield textResponse('recovered, completing now');
        });

        await task.submitUserMessage('do work');
        await (processSpy.mock.results[0]?.value as Promise<void>);

        expect(requestCount).toBe(2);
        expect(task.task_status).toBe('stopped');
        // 错误发生在旧消息上，恢复轮的消息不以错误收尾
        const lastAssistant = task.chat_context.lastMessage() as AssistantMessage;
        expect(lastAssistant.content.some((part) => part.type === 'error')).toBe(false);
    });

    test('user stop is never overwritten to failed at turn settle', async () => {
        const task = createTask();
        const processSpy = mockTurnInfrastructure(task);
        // 流式中途模拟用户停止：错误 chunk 到达时 task_status 已是 stopped，
        // completion 错误路径检测到 stopped 直接退出，不追加错误 part
        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* () {
            yield textResponse('partial');
            task.task_status = 'stopped';
            yield modelServiceErrorResponse(403, 'Error: 403 No active subscription found for this group');
        });

        await task.submitUserMessage('do work');
        await (processSpy.mock.results[0]?.value as Promise<void>);

        expect(task.task_status).toBe('stopped');
    });
});
