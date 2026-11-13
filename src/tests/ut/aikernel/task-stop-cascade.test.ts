import { jest } from '@jest/globals';
import { CreateSubTaskTool, startSubTask, waitSubTaskResult } from '../../../main/aikernel/planning/tools.js';
import { SkillRegistry } from '../../../main/aikernel/skill.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { TASK_NAME_MAX_LENGTH } from '../../../main/utils/task-name.js';
import { Setting } from '../../../main/utils/setting.js';

function createTaskTree(parentStatus: TaskState['task_status'] = 'running'): {
    manager: TaskManagerState;
    parent: TaskState;
    child: TaskState;
} {
    const manager = new TaskManagerState();
    manager.save = jest.fn();
    manager.publishTaskListUpdate = jest.fn();
    manager.moveTaskToEnd = jest.fn();

    const parent = new TaskState(manager, null);
    parent.task_id = 'task-parent';
    parent.task_status = parentStatus;

    const child = new TaskState(manager, parent.task_id);
    child.task_id = 'task-child';
    child.task_status = 'running';

    manager.tasks.push(parent, child);
    return { manager, parent, child };
}

describe('TaskState.stop() child task cascade', () => {
    afterEach(() => {
        jest.restoreAllMocks();
        Setting.clearCache();
    });

    test('stops running child tasks when parent is running', () => {
        const { parent, child } = createTaskTree('running');

        parent.stop('system');

        expect(parent.task_status).toBe('stopped');
        expect(child.task_status).toBe('stopped');
    });

    test('stops running child tasks even when parent has already finished', () => {
        const { parent, child } = createTaskTree('stopped');

        parent.stop('system');

        expect(parent.task_status).toBe('stopped');
        expect(child.task_status).toBe('stopped');
    });

    test('interrupting for a new message does not finish unrelated child waiters', async () => {
        const { parent, child } = createTaskTree('running');
        let waiterFinished = false;
        const waiter = child.waitUntilFinished(undefined, true).then(() => {
            waiterFinished = true;
        });

        parent.interruptForNewMessage();
        const waiterState = await Promise.race([
            waiter.then(() => 'finished'),
            new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 0))
        ]);

        expect(parent.task_status).toBe('stopped');
        expect(child.task_status).toBe('running');
        expect(waiterState).toBe('waiting');
        expect(waiterFinished).toBe(false);

        child.stop('system');
        await waiter;
    });

    test('interrupting for a new message releases the child waiter that opts into detaching', async () => {
        const { parent, child } = createTaskTree('running');
        const detachWaiter = child.waitUntilFinished(undefined, true, true);

        parent.interruptForNewMessage();

        await expect(detachWaiter).resolves.toBeUndefined();
        expect(parent.task_status).toBe('stopped');
        expect(child.task_status).toBe('running');

        child.stop('system');
    });

    test('a runtime interruption that stops running tools also stops child tasks', async () => {
        const { parent, child } = createTaskTree('running');

        await parent.interruptRunningTurn({
            reason: 'goal_pause',
            stopRunningTools: true,
            cancelPermissionPrompts: true
        });

        expect(parent.task_status).toBe('stopped');
        expect(child.task_status).toBe('stopped');
    });

    test('reports a detached child wait failure instead of leaving waitSubTask pending', async () => {
        const manager = new TaskManagerState();
        manager.save = jest.fn();
        manager.publishTaskListUpdate = jest.fn();
        manager.moveTaskToEnd = jest.fn();
        const parent = new TaskState(manager, null);
        parent.task_id = 'task-parent';
        parent.task_status = 'running';
        manager.tasks.push(parent);
        jest.spyOn(SkillRegistry.getInstance(), 'getSkillFrontmatterXml').mockResolvedValue('');

        let child!: TaskState;
        let waitCallCount = 0;
        const detached = await startSubTask({
            parentTask: parent,
            config: {
                title: 'detached child',
                objective: 'finish in background',
                criteria: 'return a result',
                isAsync: false
            },
            onCreated: (createdChild) => {
                child = createdChild;
                child.task_status = 'running';
                jest.spyOn(child, 'submitUserMessage').mockResolvedValue({ status: 'ok' });
                jest.spyOn(child, 'waitUntilFinished').mockImplementation(async () => {
                    waitCallCount++;
                    if (waitCallCount === 1) return;
                    if (waitCallCount === 2) {
                        await new Promise((resolve) => setTimeout(resolve, 0));
                        child.task_status = 'stopped';
                        throw new Error('detached wait failed');
                    }
                    await new Promise((resolve) => setTimeout(resolve, 1));
                });
            }
        });

        expect(detached).toMatchObject({
            success: true,
            subtask_id: child.task_id
        });

        const result = await Promise.race([
            waitSubTaskResult({ subtaskId: child.task_id, parentTask: parent }),
            new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 100))
        ]);

        expect(result).not.toBe('timed-out');
        expect(result).toMatchObject({
            success: false,
            subtask_id: child.task_id,
            result: expect.stringContaining('detached wait failed')
        });
    });

    test('passes the parent turn model request options to a child task', async () => {
        const manager = new TaskManagerState();
        manager.save = jest.fn();
        manager.publishTaskListUpdate = jest.fn();
        manager.moveTaskToEnd = jest.fn();
        const parent = new TaskState(manager, null);
        parent.task_id = 'task-parent';
        parent.task_status = 'running';
        manager.tasks.push(parent);
        jest.spyOn(SkillRegistry.getInstance(), 'getSkillFrontmatterXml').mockResolvedValue('');

        let submitSpy!: ReturnType<typeof jest.spyOn>;
        const modelRequestOptions = {
            extraHeaders: {
                cookie: 'sid=abc',
                trace_id: 'trace-123'
            }
        };
        await startSubTask({
            parentTask: parent,
            config: {
                title: 'child',
                objective: 'do work',
                criteria: 'return result',
                isAsync: false
            },
            modelRequestOptions,
            onCreated: (child) => {
                submitSpy = jest.spyOn(child, 'submitUserMessage').mockResolvedValue({ status: 'ok' });
                jest.spyOn(child, 'waitUntilFinished').mockImplementation(async () => {
                    child.task_status = 'stopped';
                });
            }
        });

        expect(submitSpy).toHaveBeenCalledWith(expect.any(String), { modelRequestOptions });
    });

    test('notifies the parent after a child task is configured', async () => {
        const manager = new TaskManagerState();
        manager.save = jest.fn();
        manager.publishTaskListUpdate = jest.fn();
        manager.moveTaskToEnd = jest.fn();
        const parent = new TaskState(manager, null);
        parent.task_id = 'task-parent';
        parent.task_status = 'running';
        parent.model = 'parent-model';
        manager.tasks.push(parent);
        jest.spyOn(SkillRegistry.getInstance(), 'getSkillFrontmatterXml').mockResolvedValue('');

        const listener = jest.fn();
        parent.onSubTaskCreated(listener);
        await startSubTask({
            parentTask: parent,
            config: {
                title: 'configured child',
                objective: 'do work',
                criteria: 'return result',
                isAsync: false
            },
            onCreated: (child) => {
                jest.spyOn(child, 'submitUserMessage').mockResolvedValue({ status: 'ok' });
                jest.spyOn(child, 'waitUntilFinished').mockImplementation(async () => {
                    child.task_status = 'stopped';
                });
            }
        });

        expect(listener).toHaveBeenCalledWith(
            expect.objectContaining({
                task_name: 'configured child',
                model: 'parent-model'
            })
        );
    });

    test('cleans the model-generated subtask title before it becomes the task name', async () => {
        const runWithTitle = async (title: string): Promise<string> => {
            const manager = new TaskManagerState();
            manager.save = jest.fn();
            manager.publishTaskListUpdate = jest.fn();
            manager.moveTaskToEnd = jest.fn();
            const parent = new TaskState(manager, null);
            parent.task_id = 'task-parent';
            parent.task_status = 'running';
            manager.tasks.push(parent);
            jest.spyOn(SkillRegistry.getInstance(), 'getSkillFrontmatterXml').mockResolvedValue('');

            let child!: TaskState;
            await startSubTask({
                parentTask: parent,
                config: { title, objective: 'do work', criteria: 'return result', isAsync: false },
                onCreated: (created) => {
                    child = created;
                    jest.spyOn(child, 'submitUserMessage').mockResolvedValue({ status: 'ok' });
                    jest.spyOn(child, 'waitUntilFinished').mockImplementation(async () => {
                        child.task_status = 'stopped';
                    });
                }
            });
            return child.task_name ?? '';
        };

        // 模型照抄 schema 描述里的占位说法时，不能直接落库成子任务名
        expect(await runWithTitle('{子任务标题}')).toBe('未命名子任务');
        expect(await runWithTitle('子任务标题')).toBe('未命名子任务');
        expect(await runWithTitle('   ')).toBe('未命名子任务');
        // 不可见字符在落库前剔除
        expect(await runWithTitle('修复\u200B登录')).toBe('修复登录');
        // 把占位标签当标题前缀复读时，剥掉前缀留下真名
        expect(await runWithTitle('任务名称：修复登录')).toBe('修复登录');
        expect(await runWithTitle('子任务标题 - 重构解析器')).toBe('重构解析器');

        const longTitle = '重构解析器并补齐单元测试与回归验证以及文档更新和示例代码，顺带整理类型定义';
        expect(await runWithTitle(longTitle)).toBe(
            Array.from(longTitle).slice(0, TASK_NAME_MAX_LENGTH).join('') + '...'
        );
    });

    test('rejects an unusable subtask title so the model can correct it', async () => {
        const manager = new TaskManagerState();
        manager.save = jest.fn();
        manager.publishTaskListUpdate = jest.fn();
        manager.moveTaskToEnd = jest.fn();
        const parent = new TaskState(manager, null);
        parent.task_id = 'task-parent';
        parent.task_status = 'running';
        manager.tasks.push(parent);
        jest.spyOn(SkillRegistry.getInstance(), 'getSkillFrontmatterXml').mockResolvedValue('');

        const result = await new CreateSubTaskTool().execute(
            {
                title: '{子任务标题}',
                objective: 'do work',
                criteria: 'return result',
                isAsync: false
            },
            undefined,
            parent
        );

        // 不静默落成同名占位子任务，而是把可纠正的错误回给模型
        expect(result.status).toBe('error');
        expect(String(result.result)).toContain('title');
        // 错误里回显原值，模型才知道要改的是哪个参数、原值是什么
        expect(String(result.result)).toContain('{子任务标题}');
        expect(manager.tasks).toHaveLength(1);
    });

    test('keeps the child task id in createSubTask progress updates', async () => {
        const manager = new TaskManagerState();
        manager.save = jest.fn();
        manager.publishTaskListUpdate = jest.fn();
        manager.moveTaskToEnd = jest.fn();
        const parent = new TaskState(manager, null);
        parent.task_id = 'task-parent';
        parent.task_status = 'running';
        manager.tasks.push(parent);
        jest.spyOn(SkillRegistry.getInstance(), 'getSkillFrontmatterXml').mockResolvedValue('');

        parent.onSubTaskCreated((child) => {
            jest.spyOn(child, 'submitUserMessage').mockResolvedValue({ status: 'ok' });
            jest.spyOn(child, 'waitUntilFinished').mockImplementation(async (callback) => {
                await callback?.({
                    type: 'assistant',
                    task_id: child.task_id,
                    task_status: 'running',
                    message_id: 'child-progress',
                    last_part_index: 0,
                    last_part: {
                        type: 'tool_call',
                        toolcalls: [{ name: 'filemgr-readFile', status: 'running' }]
                    }
                } as any);
                child.task_status = 'stopped';
            });
        });

        const updates: Array<Record<string, unknown>> = [];
        const result = await new CreateSubTaskTool().execute(
            {
                title: 'inspect files',
                objective: 'inspect the current directory',
                criteria: 'return a summary',
                isAsync: false
            },
            (toolResult) => {
                if (toolResult.result_object) {
                    updates.push(structuredClone(toolResult.result_object) as Record<string, unknown>);
                }
            },
            parent
        );

        const progressUpdate = updates.find((update) => update.subtask_progress !== undefined);
        expect(result.status).toBe('success');
        expect(progressUpdate).toEqual(
            expect.objectContaining({
                subtask_id: expect.stringMatching(/^task_/),
                subtask_progress: expect.any(Object)
            })
        );
    });

    test('allows a normally finished task to start a new user turn', async () => {
        Setting.updateInstanceData({
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
                    model_name: 'mock/model'
                }
            ]
        });
        const manager = new TaskManagerState();
        manager.save = jest.fn();
        manager.publishTaskListUpdate = jest.fn();
        manager.moveTaskToEnd = jest.fn();
        const task = new TaskState(manager, null);
        task.task_status = 'stopped';
        manager.tasks.push(task);
        jest.spyOn(task, 'buildToolsets').mockResolvedValue([]);
        const processSpy = jest.spyOn(task, 'processTaskTurn').mockResolvedValue();

        const result = await task.submitUserMessage('continue');

        expect(result).toEqual({ status: 'ok' });
        expect(task.task_status).toBe('running');
        expect(processSpy).toHaveBeenCalledTimes(1);
    });
});
