import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import { setCustomOpendeskDirectory } from '../../../main/utils/setting.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';

let tempRootDir: string | undefined;

function createTempTaskDirectory(): string {
    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-task-rename-'));
    setCustomOpendeskDirectory(tempRootDir);
    const taskDir = path.join(tempRootDir, 'tasks');
    fs.mkdirSync(taskDir, { recursive: true });
    return taskDir;
}

function cleanupTempTaskDirectory(): void {
    if (tempRootDir && fs.existsSync(tempRootDir)) {
        fs.rmSync(tempRootDir, { recursive: true, force: true });
    }
    tempRootDir = undefined;
}

/** 模拟 main.ts 中 taskManager:renameTask IP*C handler 的纯函数逻辑 */
function handleRenameTask(
    manager: TaskManagerState,
    taskId: string,
    newName: string
): { status: string; message?: string } {
    const task = manager.getTask(taskId);
    if (task === undefined) {
        return { status: 'error', message: `task ${taskId} not found` };
    }
    task.rename(newName);
    return { status: 'ok' };
}

// ================================================================
// Level 1: TaskState.rename() — core logic
// ================================================================
describe('TaskState.rename()', () => {
    let manager: TaskManagerState;
    let task: TaskState;

    beforeEach(() => {
        createTempTaskDirectory();
        manager = new TaskManagerState();
        task = new TaskState(manager, null);
        task.task_id = 'task-test-rename';
        task.task_name = '原始名称';
        manager.tasks.push(task);
    });

    afterEach(async () => {
        await manager.flushAllPendingSaves().catch(() => {});
        cleanupTempTaskDirectory();
    });

    test('重命名更新 task_name 并标记 dirty', () => {
        task.rename('新名称');
        expect(task.task_name).toBe('新名称');
        expect(task._dirty).toBe(true);
    });

    test('空字符串重命名', () => {
        task.rename('');
        expect(task.task_name).toBe('');
        expect(task._dirty).toBe(true);
    });

    test('Unicode 字符重命名', () => {
        const name = '分析报告 🚀 日本語 中文';
        task.rename(name);
        expect(task.task_name).toBe(name);
    });

    test('超长字符串重命名', () => {
        const longName = 'a'.repeat(1000);
        task.rename(longName);
        expect(task.task_name).toBe(longName);
        expect(task.task_name.length).toBe(1000);
    });

    test('连续重命名两次后取最终值', () => {
        task.rename('A');
        task.rename('B');
        expect(task.task_name).toBe('B');
    });

    test('重命名触发 publishTaskListUpdate', () => {
        const spy = jest.spyOn(manager, 'publishTaskListUpdate');
        task.rename('新名称');
        expect(spy).toHaveBeenCalledTimes(1);
    });

    test('重命名后订阅者收到更新', () => {
        const subscriber = jest.fn();
        manager.addSubscriber({
            subscription_id: crypto.randomUUID(),
            send: subscriber
        });
        task.rename('新名称');
        expect(subscriber).toHaveBeenCalledTimes(1);
        const updatedList = subscriber.mock.calls[0][0];
        expect(Array.isArray(updatedList)).toBe(true);
        const updatedTask = updatedList.find((t: any) => t.task_id === 'task-test-rename');
        expect(updatedTask).toBeDefined();
        expect(updatedTask.task_name).toBe('新名称');
    });

    test('重命名后 flush 写入磁盘文件', async () => {
        task.rename('磁盘写入验证');
        await manager.flushAllPendingSaves();

        const taskFile = path.join(tempRootDir!, 'tasks', 'task-test-rename.json');
        expect(fs.existsSync(taskFile)).toBe(true);
        const saved = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
        expect(saved.task_name).toBe('磁盘写入验证');
        expect(saved.task_id).toBe('task-test-rename');
    });
});

// ================================================================
// Level 2: IPC handler 逻辑模拟
// ================================================================
describe('taskManager:renameTask handler', () => {
    let manager: TaskManagerState;
    let task: TaskState;

    beforeEach(() => {
        createTempTaskDirectory();
        manager = new TaskManagerState();
        task = new TaskState(manager, null);
        task.task_id = 'task-handler-test';
        task.task_name = '原名';
        manager.tasks.push(task);
    });

    afterEach(async () => {
        await manager.flushAllPendingSaves().catch(() => {});
        cleanupTempTaskDirectory();
    });

    test('成功重命名返回 ok', () => {
        const result = handleRenameTask(manager, 'task-handler-test', '新名称');
        expect(result).toEqual({ status: 'ok' });
        expect(task.task_name).toBe('新名称');
    });

    test('不存在的任务返回 error', () => {
        const result = handleRenameTask(manager, 'no-such-task', '新名称');
        expect(result).toEqual({
            status: 'error',
            message: 'task no-such-task not found'
        });
        expect(task.task_name).toBe('原名');
    });

    test('空名称重命名通过 handler 正常', () => {
        const result = handleRenameTask(manager, 'task-handler-test', '');
        expect(result).toEqual({ status: 'ok' });
        expect(task.task_name).toBe('');
    });
});
