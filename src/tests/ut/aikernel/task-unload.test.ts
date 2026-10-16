import fs from 'fs';
import os from 'os';
import path from 'path';
import { ChatContext, UserMessage } from '../../../main/aikernel/messages';
import { registerTaskExtension } from '../../../main/aikernel/task-extension';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks';
import { setCustomOpendeskDirectory } from '../../../main/utils/setting';

let tempRootDir: string | undefined;

function createTempTaskDirectory(): void {
    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-task-unload-'));
    setCustomOpendeskDirectory(tempRootDir);
    fs.mkdirSync(path.join(tempRootDir, 'tasks'), { recursive: true });
}

function cleanupTempTaskDirectory(): void {
    if (tempRootDir && fs.existsSync(tempRootDir)) {
        fs.rmSync(tempRootDir, { recursive: true, force: true });
    }
    tempRootDir = undefined;
}

function createTask(manager: TaskManagerState, taskId: string): TaskState {
    const task = new TaskState(manager, null);
    task.task_id = taskId;
    task.task_name = `name-${taskId}`;
    task.task_status = 'stopped';
    task.chat_context = new ChatContext();
    task.chat_context.appendMessage(new UserMessage('hello unload'));
    manager.tasks.push(task);
    return task;
}

function taskFilePath(taskId: string): string {
    return path.join(tempRootDir as string, 'tasks', `${taskId}.json`);
}

/** 直接读取私有重字段，避免触发 chat_context / extensions getter 的惰性回读。 */
function rawMessages(task: TaskState): unknown[] {
    return (task as unknown as { _chat_context: ChatContext })._chat_context.messages;
}

function rawExtensions(task: TaskState): { restoredRaw?: unknown } {
    return (task as unknown as { _extensions: { restoredRaw?: unknown } })._extensions;
}

describe('TaskState.unload', () => {
    afterEach(() => {
        cleanupTempTaskDirectory();
    });

    test('卸载后释放重字段并切回懒加载壳状态', () => {
        createTempTaskDirectory();
        const manager = new TaskManagerState();
        const task = createTask(manager, 'task-unload-basic');

        expect(task._fullyLoaded).toBe(true);
        expect(rawMessages(task)).toHaveLength(1);

        const released = task.unload();

        expect(released).toBe(true);
        expect(task._fullyLoaded).toBe(false);
        expect(rawMessages(task)).toHaveLength(0);
        expect(task._lazyFilePath).toBe(taskFilePath('task-unload-basic'));
        expect(task._lazySimplifiedJSON).toBeDefined();
    });

    test('卸载后 toSimplifiedJSON 返回缓存元数据', () => {
        createTempTaskDirectory();
        const manager = new TaskManagerState();
        const task = createTask(manager, 'task-unload-simplified');

        task.unload();

        const simplified = task.toSimplifiedJSON() as Record<string, unknown>;
        expect(simplified.task_id).toBe('task-unload-simplified');
        expect(simplified.task_name).toBe('name-task-unload-simplified');
        // 仍处于懒加载壳状态，说明没有因访问简化元数据而回读磁盘
        expect(task._fullyLoaded).toBe(false);
    });

    test('卸载后重新加载可完整恢复消息历史（往返一致）', () => {
        createTempTaskDirectory();
        const manager = new TaskManagerState();
        const task = createTask(manager, 'task-unload-roundtrip');
        task._dirty = true;

        task.unload();
        expect(rawMessages(task)).toHaveLength(0);
        expect(fs.existsSync(taskFilePath('task-unload-roundtrip'))).toBe(true);

        task.ensureLoaded();

        expect(task._fullyLoaded).toBe(true);
        expect(task.chat_context.messages).toHaveLength(1);
        expect(JSON.stringify((task.chat_context.messages[0] as UserMessage).content)).toContain('hello unload');
    });

    test('卸载后访问 chat_context 会自动重新加载（惰性恢复）', () => {
        createTempTaskDirectory();
        const manager = new TaskManagerState();
        const task = createTask(manager, 'task-unload-lazy-reload');
        task._dirty = true;

        task.unload();
        expect(task._fullyLoaded).toBe(false);

        // getter 在未加载时触发 ensureLoaded()，从磁盘恢复完整数据
        expect(task.chat_context.messages).toHaveLength(1);
        expect(task._fullyLoaded).toBe(true);
    });

    test('未落盘的修改会在卸载前写回磁盘', () => {
        createTempTaskDirectory();
        const manager = new TaskManagerState();
        const task = createTask(manager, 'task-unload-dirty');
        task.task_name = 'renamed-before-unload';
        task._dirty = true;

        task.unload();

        const onDisk = JSON.parse(fs.readFileSync(taskFilePath('task-unload-dirty'), 'utf8'));
        expect(onDisk.task_name).toBe('renamed-before-unload');
        expect(task._dirty).toBe(false);
    });

    test('运行中的任务不卸载', () => {
        createTempTaskDirectory();
        const manager = new TaskManagerState();
        const task = createTask(manager, 'task-unload-running');
        task.task_status = 'running';

        expect(task.unload()).toBe(false);
        expect(task._fullyLoaded).toBe(true);
        expect(rawMessages(task)).toHaveLength(1);
    });

    test('waiting 状态的任务不卸载', () => {
        createTempTaskDirectory();
        const manager = new TaskManagerState();
        const task = createTask(manager, 'task-unload-waiting');
        task.task_status = 'waiting';

        expect(task.unload()).toBe(false);
        expect(task._fullyLoaded).toBe(true);
        expect(rawMessages(task)).toHaveLength(1);
    });

    test('failed 状态的任务可卸载（崩溃恢复的 running → failed 路径）', () => {
        createTempTaskDirectory();
        const manager = new TaskManagerState();
        const task = createTask(manager, 'task-unload-failed');
        // 模拟应用退出时任务仍在运行：落盘 running，重新加载后反序列化改写为 failed
        task.task_status = 'running';
        task._dirty = true;
        manager.saveSync(); // 同步落盘（save() 有 2s 节流，测试内等不到文件写出）

        const reloaded = TaskState.load(taskFilePath('task-unload-failed'), manager);
        expect(reloaded.task_status).toBe('failed');

        expect(reloaded.unload()).toBe(true);
        expect(reloaded._fullyLoaded).toBe(false);
    });

    test('会话记忆后台抽取进行中不卸载', () => {
        createTempTaskDirectory();
        const manager = new TaskManagerState();
        const task = createTask(manager, 'task-unload-session-memory');
        (task as unknown as { _sessionMemoryUpdatePromise: Promise<unknown> })._sessionMemoryUpdatePromise =
            Promise.resolve({} as never);

        expect(task.unload()).toBe(false);
        expect(task._fullyLoaded).toBe(true);
    });

    test('turn 收尾期间不卸载（stopped 后收尾写回尚未完成）', () => {
        createTempTaskDirectory();
        const manager = new TaskManagerState();
        const task = createTask(manager, 'task-unload-turn-settling');
        (task as unknown as { _turnRunning: boolean })._turnRunning = true;

        expect(task.unload()).toBe(false);
        expect(task._fullyLoaded).toBe(true);
        expect(rawMessages(task)).toHaveLength(1);
    });

    test('手动压缩进行中不卸载', () => {
        createTempTaskDirectory();
        const manager = new TaskManagerState();
        const task = createTask(manager, 'task-unload-compacting');
        task.compactProgress = {
            type: 'compact',
            task_id: task.task_id,
            task_status: 'stopped',
            phase: 'start',
            trigger: 'manual'
        };

        expect(task.unload()).toBe(false);
        expect(task._fullyLoaded).toBe(true);
    });

    test('消息队列非空的任务不卸载', () => {
        createTempTaskDirectory();
        const manager = new TaskManagerState();
        const task = createTask(manager, 'task-unload-queued');
        task.message_queue.push('pending message');

        expect(task.unload()).toBe(false);
        expect(task._fullyLoaded).toBe(true);
    });

    test('重复卸载幂等：已是懒加载壳时返回 false', () => {
        createTempTaskDirectory();
        const manager = new TaskManagerState();
        const task = createTask(manager, 'task-unload-idempotent');

        expect(task.unload()).toBe(true);
        expect(task.unload()).toBe(false);
    });

    test('卸载后任务列表仍可正常读取（不触发全量加载）', () => {
        createTempTaskDirectory();
        const manager = new TaskManagerState();
        const task = createTask(manager, 'task-unload-list');

        task.unload();

        const entry = (manager.getTaskList() as Array<Record<string, unknown>>).find(
            (item) => item.task_id === 'task-unload-list'
        );
        expect(entry).toBeDefined();
        expect(task._fullyLoaded).toBe(false);
    });
});

describe('TaskState.unload 扩展状态清理', () => {
    afterEach(() => {
        cleanupTempTaskDirectory();
    });

    test('清空扩展持有的整份任务 JSON 副本（restoredRaw）', () => {
        createTempTaskDirectory();
        const manager = new TaskManagerState();
        const task = createTask(manager, 'task-unload-restored-raw');
        rawExtensions(task).restoredRaw = {
            task_id: 'task-unload-restored-raw',
            chat_context: { messages: [{ role: 'user', content: 'x' }] }
        };

        task.unload();

        expect(rawExtensions(task).restoredRaw).toBeUndefined();
    });

    test('调用扩展自定义的 unload hook', () => {
        const unloadedTaskIds: string[] = [];
        registerTaskExtension('unload-test-ext', (t) => ({
            key: 'unload-test-ext',
            unload() {
                unloadedTaskIds.push(t.task_id);
            }
        }));

        createTempTaskDirectory();
        const manager = new TaskManagerState();
        const task = createTask(manager, 'task-unload-ext-hook');

        task.unload();

        expect(unloadedTaskIds).toEqual(['task-unload-ext-hook']);
    });
});
