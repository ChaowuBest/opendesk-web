import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import { GlobalHooks } from '../../../main/aikernel/hooks.js';
import { LLM } from '../../../main/aikernel/llm.js';
import { attachToSubTask } from '../../../main/aikernel/planning/tools.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { Setting, setCustomOpendeskDirectory } from '../../../main/utils/setting.js';
import { AbstractPlatform, setPlatform } from '../../../platforms/base.js';

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

function createParentAndSubTask(): { parent: TaskState; sub: TaskState } {
    Setting.updateInstanceData({
        locale: 'zh-CN',
        default_model: 'mock-model'
    });
    const manager = new TaskManagerState();
    manager.save = jest.fn();
    manager.publishTaskListUpdate = jest.fn();
    const parent = new TaskState(manager);
    parent.task_name = 'attach-restart-parent';
    parent.model = 'mock-model';
    const sub = new TaskState(manager);
    sub.task_name = 'attach-restart-sub';
    sub.model = 'mock-model';
    sub.parent_id = parent.task_id;
    manager.tasks.push(parent, sub);
    return { parent, sub };
}

describe('attachToSubTask 对已结束子任务的重启行为', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-attach-subtask-restart-'));
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

    test('failed 子任务（模型错误终止）收到后续消息时必须重启而非静默追加', async () => {
        const { parent, sub } = createParentAndSubTask();
        sub.task_status = 'failed';
        const submitSpy = jest.spyOn(sub, 'submitUserMessage').mockResolvedValue(undefined);
        const appendSpy = jest.spyOn(sub.chat_context, 'appendMessage');

        const result = await attachToSubTask({
            subtaskId: sub.task_id,
            message: 'continue the work',
            parentTask: parent,
            isAsync: true
        });

        // 已结束的子任务必须走 submitUserMessage 重启，否则消息只会进入
        // 上下文而没有 turn 处理它，子任务表现为永久挂起
        expect(submitSpy).toHaveBeenCalledWith('continue the work');
        expect(appendSpy).not.toHaveBeenCalled();
        expect(result.success).toBe(true);
    });

    test('stopped 子任务仍走重启路径（既有行为回归保护）', async () => {
        const { parent, sub } = createParentAndSubTask();
        sub.task_status = 'stopped';
        const submitSpy = jest.spyOn(sub, 'submitUserMessage').mockResolvedValue(undefined);
        const appendSpy = jest.spyOn(sub.chat_context, 'appendMessage');

        await attachToSubTask({
            subtaskId: sub.task_id,
            message: 'continue the work',
            parentTask: parent,
            isAsync: true
        });

        expect(submitSpy).toHaveBeenCalledWith('continue the work');
        expect(appendSpy).not.toHaveBeenCalled();
    });

    test('running 子任务直接追加消息，不重启', async () => {
        const { parent, sub } = createParentAndSubTask();
        sub.task_status = 'running';
        const submitSpy = jest.spyOn(sub, 'submitUserMessage');
        const appendSpy = jest.spyOn(sub.chat_context, 'appendMessage');

        const result = await attachToSubTask({
            subtaskId: sub.task_id,
            message: 'add more context',
            parentTask: parent,
            isAsync: true
        });

        expect(appendSpy).toHaveBeenCalledTimes(1);
        expect(submitSpy).not.toHaveBeenCalled();
        expect(result.success).toBe(true);
    });
});
