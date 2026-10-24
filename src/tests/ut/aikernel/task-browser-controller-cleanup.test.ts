/**
 * 回归测试（issue #122）：删除任务后 BrowserController 必须从 BrowserManager
 * 的静态注册表中移除，否则其持有的 CDP 会话与 debugger listener 会一直保留
 * 到进程结束，反复创建/删除浏览器任务导致内存与 listener 单调增长。
 *
 * 所有任务删除路径（GUI IPC、agent deleteTasks、agentoffice、appmgr、
 * workflow、opencode server、TUI）都汇聚到 TaskManagerState.removeTask /
 * clearAllTasks，因此在此汇聚点断言 Controller 的释放。
 */

import { BrowserManager } from '../../../common/embedBrowserUse/main.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';

function createTaskInManager(manager: TaskManagerState, parentId: string | null = null): TaskState {
    const task = new TaskState(manager, parentId);
    manager.tasks.push(task);
    return task;
}

/** 任务删除会触发 stop() → persistLater() 的防抖落盘定时器，afterEach 统一冲刷避免悬挂句柄 */
const createdManagers: TaskManagerState[] = [];

function createManager(): TaskManagerState {
    const manager = new TaskManagerState();
    createdManagers.push(manager);
    return manager;
}

describe('task removal releases BrowserController registry entries (issue #122)', () => {
    afterEach(async () => {
        for (const manager of createdManagers) {
            await manager.flushAllPendingSaves();
        }
        createdManagers.length = 0;
        BrowserManager.removeAllControllers();
    });

    test('removeTask removes the controller of the deleted task', () => {
        const manager = createManager();
        const task = createTaskInManager(manager);

        // 模拟该任务使用过浏览器：agent 工具链路通过 getOrCreateController 创建
        BrowserManager.getOrCreateController(task.task_id, null);
        expect(BrowserManager.getController(task.task_id)).toBeDefined();

        const removed = manager.removeTask(task.task_id);

        expect(removed).toContain(task.task_id);
        expect(BrowserManager.getController(task.task_id)).toBeUndefined();
    });

    test('removeTask recursively removes controllers of child tasks', () => {
        const manager = createManager();
        const parent = createTaskInManager(manager);
        const child = createTaskInManager(manager, parent.task_id);

        BrowserManager.getOrCreateController(parent.task_id, null);
        BrowserManager.getOrCreateController(child.task_id, null);

        const removed = manager.removeTask(parent.task_id);

        expect(removed).toEqual(expect.arrayContaining([parent.task_id, child.task_id]));
        expect(BrowserManager.getController(parent.task_id)).toBeUndefined();
        expect(BrowserManager.getController(child.task_id)).toBeUndefined();
    });

    test('clearAllTasks removes all controllers', () => {
        const manager = createManager();
        const first = createTaskInManager(manager);
        const second = createTaskInManager(manager);

        BrowserManager.getOrCreateController(first.task_id, null);
        BrowserManager.getOrCreateController(second.task_id, null);

        manager.clearAllTasks();

        expect(BrowserManager.getController(first.task_id)).toBeUndefined();
        expect(BrowserManager.getController(second.task_id)).toBeUndefined();
    });

    test('removeTask on a task that never used a browser does not throw', () => {
        const manager = createManager();
        const task = createTaskInManager(manager);

        expect(() => manager.removeTask(task.task_id)).not.toThrow();
    });

    test('recreating a controller after task removal works (registry is reusable)', () => {
        const manager = createManager();
        const task = createTaskInManager(manager);

        BrowserManager.getOrCreateController(task.task_id, null);
        manager.removeTask(task.task_id);
        expect(BrowserManager.getController(task.task_id)).toBeUndefined();

        const recreated = BrowserManager.getOrCreateController(task.task_id, null);
        expect(recreated).toBeDefined();
        expect(recreated.id).toBe(task.task_id);
    });
});
