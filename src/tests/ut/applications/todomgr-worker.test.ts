import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import TodoMgrWorker from '../../../main/applications/todomgr/worker.js';
import type { Participant } from '../../../main/plugins/types.js';

function createWorker(): { worker: TodoMgrWorker; tempDir: string } {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-todomgr-worker-'));
    const worker = new TodoMgrWorker('todomgr', tempDir);
    (worker as any).globalTodosPath = path.join(tempDir, 'global_todos.json');
    (worker as any).globalTodos = [];
    return { worker, tempDir };
}

describe('todomgr worker automation task routing', () => {
    let tempDirs: string[] = [];

    afterEach(() => {
        jest.restoreAllMocks();
        for (const tempDir of tempDirs) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        tempDirs = [];
    });

    test('stores deliver and workspace, then passes them when triggering', async () => {
        const { worker, tempDir } = createWorker();
        tempDirs.push(tempDir);
        const deliver: Participant = {
            type: 'channel',
            channel: 'feishu',
            accountId: 'default',
            recipientId: 'oc_test'
        };
        const workspace = path.join(tempDir, 'workspace');
        fs.mkdirSync(workspace);

        const todo = await worker.addGlobalTodo('提醒', '检查日报', 'medium', undefined, undefined, deliver, workspace);

        expect(todo.deliver).toEqual(deliver);
        expect(todo.workspace).toBe(workspace);

        const callApp = jest.spyOn(worker as any, 'callApp').mockImplementation(() => {});

        await worker.triggerGlobalTodoNow(todo.id);

        expect(callApp).toHaveBeenCalledWith(
            'triggerTodoTask',
            todo.id,
            todo.title,
            todo.content,
            todo.trigger,
            deliver,
            workspace,
            undefined,
            undefined
        );
    });

    test('stores model and reasoning effort, then passes both when triggering', async () => {
        const { worker, tempDir } = createWorker();
        tempDirs.push(tempDir);
        const callApp = jest.spyOn(worker as any, 'callApp').mockImplementation(() => {});

        const todo = await worker.addGlobalTodo(
            '使用指定模型',
            '执行日报',
            'medium',
            undefined,
            undefined,
            undefined,
            undefined,
            'reasoning-pro',
            'high'
        );

        expect(todo.model).toBe('reasoning-pro');
        expect(todo.reasoningEffort).toBe('high');

        await worker.triggerGlobalTodoNow(todo.id);

        expect(callApp).toHaveBeenCalledWith(
            'triggerTodoTask',
            todo.id,
            todo.title,
            todo.content,
            todo.trigger,
            undefined,
            undefined,
            'reasoning-pro',
            'high'
        );
    });

    test('removes an explicit model when the automation returns to the global default', async () => {
        const { worker, tempDir } = createWorker();
        tempDirs.push(tempDir);
        const todo = await worker.addGlobalTodo(
            '指定模型',
            '执行任务',
            'medium',
            undefined,
            undefined,
            undefined,
            undefined,
            'reasoning-pro',
            'medium'
        );

        const updated = await worker.updateGlobalTodo(todo.id, {
            removeModel: true,
            reasoningEffort: ''
        });

        expect(updated.model).toBeUndefined();
        expect(updated.reasoningEffort).toBe('');
    });

    test('removes deliver and workspace from an existing automation task', async () => {
        const { worker, tempDir } = createWorker();
        tempDirs.push(tempDir);
        const deliver: Participant = {
            type: 'channel',
            channel: 'feishu',
            accountId: 'default',
            recipientId: 'oc_test'
        };
        const workspace = path.join(tempDir, 'workspace');

        const todo = await worker.addGlobalTodo('提醒', '检查日报', 'medium', undefined, undefined, deliver, workspace);

        const updated = await worker.updateGlobalTodo(todo.id, {
            removeDeliver: true,
            removeWorkspace: true
        });

        expect(updated.deliver).toBeUndefined();
        expect(updated.workspace).toBeUndefined();
    });
});
