import { jest } from '@jest/globals';
import { GlobalHooks } from '../../../main/aikernel/hooks.js';
import { LLM } from '../../../main/aikernel/llm.js';
import { AssistantMessage, UserMessage } from '../../../main/aikernel/messages.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';

function createTask(): TaskState {
    const manager = new TaskManagerState();
    manager.save = jest.fn();
    manager.publishTaskListUpdate = jest.fn();
    manager.moveTaskToEnd = jest.fn();
    const task = new TaskState(manager);
    manager.tasks.push(task);
    return task;
}

function resetHookRegistry(): void {
    GlobalHooks.beforeFinishTurnHooks = [];
    GlobalHooks.afterFinishTurnHooks = [];
    GlobalHooks.beforeTaskStartHooks = [];
    GlobalHooks.onTaskReviewHooks = [];
    GlobalHooks.onTaskRevertHooks = [];
    GlobalHooks.afterToolcallParseHooks = [];
    GlobalHooks.beforeToolCallHooks = [];
    GlobalHooks.beforeTurnStartHooks = [];
}

describe('assistant turn execution timestamps', () => {
    beforeEach(() => {
        // planning/harness 模块加载时会注册主任务 termination 全局钩子，
        // 其内部会真实调用 LLM，测试中重置注册表隔离
        resetHookRegistry();
        // submitUserMessage 对未命名任务会异步触发 LLM 自动命名，统一 mock 掉真实请求
        jest.spyOn(LLM, 'ask').mockResolvedValue('<taskname>test</taskname>');
    });

    afterEach(() => {
        resetHookRegistry();
        jest.restoreAllMocks();
    });

    test('submitUserMessage stamps execution.startAt on the assistant message', async () => {
        const task = createTask();
        jest.spyOn(task, 'buildToolsets').mockResolvedValue([]);
        jest.spyOn(task, 'processTaskTurn').mockResolvedValue(undefined);

        await task.submitUserMessage('hello');

        const assistant = task.chat_context.lastMessage() as AssistantMessage;
        expect(assistant).toBeInstanceOf(AssistantMessage);
        expect(assistant.metadata?.execution?.startAt).toEqual(expect.any(Number));
        expect(assistant.metadata?.execution?.finishAt).toBeUndefined();
    });

    test('processTaskTurn finish solidifies execution.finishAt for the whole turn', async () => {
        const task = createTask();
        jest.spyOn(task, 'buildToolsets').mockResolvedValue([]);
        jest.spyOn(task.hooks, 'noticeBeforeTurnStart').mockResolvedValue(undefined);
        jest.spyOn(task.hooks, 'noticeAfterFinishTurn').mockResolvedValue(undefined);
        jest.spyOn(task, 'processCompletion').mockResolvedValue(false);
        jest.spyOn(task, 'processToolCalls').mockResolvedValue(false);
        jest.spyOn(task as any, 'scheduleSessionMemoryUpdateAfterCompletion').mockResolvedValue(undefined);
        const processSpy = jest.spyOn(task, 'processTaskTurn');
        task.task_status = 'running';

        await task.submitUserMessage('do work');
        // processTaskTurn 是 fire-and-forget 调用，取回真实 promise 等待 turn 收尾完成
        await (processSpy.mock.results[0]?.value as Promise<void>);

        const assistant = task.chat_context.lastMessage() as AssistantMessage;
        expect(assistant.metadata?.execution?.finishAt).toEqual(expect.any(Number));
        expect(assistant.metadata?.execution?.finishAt).toBeGreaterThanOrEqual(
            assistant.metadata?.execution?.startAt ?? 0
        );
    });

    test('a crashed turn still solidifies execution.finishAt', async () => {
        const task = createTask();
        jest.spyOn(task, 'buildToolsets').mockResolvedValue([]);
        jest.spyOn(task.hooks, 'noticeBeforeTurnStart').mockResolvedValue(undefined);
        jest.spyOn(task.hooks, 'noticeAfterFinishTurn').mockResolvedValue(undefined);
        jest.spyOn(task, 'processCompletion').mockRejectedValue(new Error('stream failed'));
        const processSpy = jest.spyOn(task, 'processTaskTurn');
        task.task_status = 'running';

        await task.submitUserMessage('do work');
        await (processSpy.mock.results[0]?.value as Promise<void>);

        const assistant = task.chat_context.lastMessage() as AssistantMessage;
        expect(assistant.metadata?.execution?.finishAt).toEqual(expect.any(Number));
    });

    test('finalizeTurnFinishAt leaves historical turn messages untouched', () => {
        const task = createTask();
        const historical = new AssistantMessage();
        historical.metadata = { execution: { generation: 1, startAt: 1_000 } };
        const current = new AssistantMessage();
        current.metadata = { execution: { generation: 2, startAt: 2_000 } };
        task.chat_context.appendMessage(historical);
        task.chat_context.appendMessage(current);

        (task as any).finalizeTurnFinishAt(2);

        expect(historical.metadata?.execution?.finishAt).toBeUndefined();
        expect(current.metadata?.execution?.finishAt).toEqual(expect.any(Number));
        expect(current.metadata?.execution?.startAt).toBe(2_000);
    });

    test('legacy persisted timestamp is migrated to execution.finishAt on assign', () => {
        // 老任务磁盘数据的 legacy timestamp（旧"最后一轮流结束"语义）在反序列化边界
        // 迁移为 execution.finishAt，前端只消费新格式；迁移后旧字段被删除
        const legacy = AssistantMessage.assign({
            role: 'assistant',
            message_id: 'legacy-1',
            content: [],
            timestamp: 123_456
        });

        expect(legacy.metadata?.execution?.finishAt).toBe(123_456);
        expect((legacy as { timestamp?: unknown }).timestamp).toBeUndefined();
    });

    test('assign does not overwrite an existing execution.finishAt with legacy timestamp', () => {
        const merged = AssistantMessage.assign({
            role: 'assistant',
            message_id: 'legacy-merge-1',
            content: [],
            timestamp: 123_456,
            metadata: { execution: { startAt: 100, finishAt: 999 } }
        });

        expect(merged.metadata?.execution?.finishAt).toBe(999);
        expect(merged.metadata?.execution?.startAt).toBe(100);
        expect((merged as { timestamp?: unknown }).timestamp).toBeUndefined();
    });

    test('assign leaves non-numeric legacy timestamp untouched (no execution synthesized)', () => {
        const weird = AssistantMessage.assign({
            role: 'assistant',
            message_id: 'legacy-weird-1',
            content: [],
            timestamp: 'not-a-number'
        });

        expect(weird.metadata?.execution).toBeUndefined();
        expect((weird as { timestamp?: unknown }).timestamp).toBe('not-a-number');
    });

    test('render JSON of an assistant message carries metadata instead of timestamp', () => {
        const message = new UserMessage('hi');
        message.metadata = {
            execution: { turnId: 't1', generation: 1, startAt: 100, finishAt: 900 }
        };
        const assistant = new AssistantMessage();
        assistant.metadata = message.metadata;
        const rendered = assistant.toRenderJSON() as Record<string, unknown>;

        expect(rendered.timestamp).toBeUndefined();
        expect(rendered.metadata).toEqual(message.metadata);
    });

    test('completion backfills execution.finishAt for messages created without metadata', async () => {
        const task = createTask();
        jest.spyOn(task, 'buildToolsets').mockResolvedValue([]);
        jest.spyOn(task.hooks, 'noticeBeforeTurnStart').mockResolvedValue(undefined);
        jest.spyOn(task.hooks, 'noticeAfterFinishTurn').mockResolvedValue(undefined);
        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* () {
            yield {
                content: (() => {
                    const message = new AssistantMessage();
                    message.appendText('plain reply');
                    return message;
                })(),
                finish_reason: 'stop'
            } as any;
        } as any);
        // 模拟渠道/邮箱等非标准路径：裸建消息，不带 execution 元数据
        const assistant = new AssistantMessage();
        task.chat_context.appendMessage(assistant);
        task.task_status = 'running';

        await task.processCompletion();

        expect(assistant.metadata?.execution?.finishAt).toEqual(expect.any(Number));
        expect(assistant.metadata?.execution?.startAt).toBeUndefined();
    });

    test('completion does not touch execution metadata that already exists', async () => {
        const task = createTask();
        jest.spyOn(task, 'buildToolsets').mockResolvedValue([]);
        jest.spyOn(task.hooks, 'noticeBeforeTurnStart').mockResolvedValue(undefined);
        jest.spyOn(task.hooks, 'noticeAfterFinishTurn').mockResolvedValue(undefined);
        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* () {
            yield {
                content: (() => {
                    const message = new AssistantMessage();
                    message.appendText('plain reply');
                    return message;
                })(),
                finish_reason: 'stop'
            } as any;
        } as any);
        const assistant = new AssistantMessage();
        assistant.metadata = { execution: { generation: 1, startAt: 1_000 } };
        task.chat_context.appendMessage(assistant);
        task.task_status = 'running';

        await task.processCompletion();

        expect(assistant.metadata?.execution?.startAt).toBe(1_000);
        expect(assistant.metadata?.execution?.finishAt).toBeUndefined();
    });

    test('render JSON passes through legacy timestamp for old tasks (renderer fallback)', () => {
        // 老任务磁盘数据经 assign 迁移后，前端 JSON 只含新格式字段
        const legacy = AssistantMessage.assign({
            role: 'assistant',
            message_id: 'legacy-render-1',
            content: [],
            timestamp: 123_456
        });
        const rendered = legacy.toRenderJSON() as Record<string, unknown>;
        expect(rendered.timestamp).toBeUndefined();
        expect((rendered.metadata as { execution?: { finishAt?: number } })?.execution?.finishAt).toBe(123_456);

        // 新消息同样不携带该字段
        const fresh = new AssistantMessage();
        expect((fresh.toRenderJSON() as Record<string, unknown>).timestamp).toBeUndefined();
    });
});
