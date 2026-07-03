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
            workspace
        );
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
