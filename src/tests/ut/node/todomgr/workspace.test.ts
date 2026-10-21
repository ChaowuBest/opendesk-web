import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getTodoIsolatedWorkspacePath, resolveTodoWorkspace } from '../../../../main/applications/todomgr/workspace.js';
import TodoMgrWorker from '../../../../main/applications/todomgr/worker.js';
import type { TodoWorkspaceConfig } from '../../../../main/applications/todomgr/common.js';

function createWorkerForTest(appDirectory: string): TodoMgrWorker {
    const worker = new TodoMgrWorker('todomgr', appDirectory);
    const testWorker = worker as any;
    testWorker.globalTodosPath = path.join(appDirectory, 'global_todos.json');
    testWorker.emitEvent = async () => {};
    return worker;
}

test('resolveTodoWorkspace uses provided default workspace when config is absent', () => {
    assert.equal(
        resolveTodoWorkspace('todo-1', undefined, { defaultWorkspace: '/workspace/default' }),
        '/workspace/default'
    );
});

test('resolveTodoWorkspace resolves explicit path workspace', () => {
    const resolved = resolveTodoWorkspace(
        'todo-1',
        { type: 'path', path: './relative-workspace' },
        {
            defaultWorkspace: '/workspace/default'
        }
    );

    assert.equal(resolved, path.resolve('./relative-workspace'));
});

test('resolveTodoWorkspace creates isolated job workspace from todo id', () => {
    const appDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-todomgr-workspace-'));
    try {
        const workspace = resolveTodoWorkspace('todo:unsafe/id', { type: 'isolated' }, { appDirectory });
        const expected = path.join(appDirectory, 'workspaces', 'job-todo-unsafe-id');

        assert.equal(workspace, expected);
        assert.equal(fs.statSync(workspace).isDirectory(), true);
        assert.equal(getTodoIsolatedWorkspacePath('todo:unsafe/id', appDirectory), expected);
    } finally {
        fs.rmSync(appDirectory, { recursive: true, force: true });
    }
});

test('TodoMgrWorker persists workspace config when adding global todo', async () => {
    const appDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-todomgr-worker-'));
    try {
        const worker = createWorkerForTest(appDirectory);
        const workspace: TodoWorkspaceConfig = { type: 'path', path: '/workspace/project-a' };

        const todo = await worker.addGlobalTodo(
            'title',
            'content',
            'medium',
            undefined,
            undefined,
            undefined,
            workspace
        );
        const stored = JSON.parse(fs.readFileSync(path.join(appDirectory, 'global_todos.json'), 'utf-8'));

        assert.deepEqual(todo.workspace, workspace);
        assert.deepEqual(stored.todos[0].workspace, workspace);
    } finally {
        fs.rmSync(appDirectory, { recursive: true, force: true });
    }
});

test('TodoMgrWorker clears workspace config when update receives null', async () => {
    const appDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-todomgr-worker-'));
    try {
        const worker = createWorkerForTest(appDirectory);
        const todo = await worker.addGlobalTodo('title', 'content', 'medium', undefined, undefined, undefined, {
            type: 'isolated'
        });

        const updated = await worker.updateGlobalTodo(todo.id, { workspace: null } as any);
        const stored = JSON.parse(fs.readFileSync(path.join(appDirectory, 'global_todos.json'), 'utf-8'));

        assert.equal(updated.workspace, undefined);
        assert.equal(stored.todos[0].workspace, undefined);
    } finally {
        fs.rmSync(appDirectory, { recursive: true, force: true });
    }
});

test('TodoMgrWorker passes workspace config to triggered automation task', async () => {
    const appDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-todomgr-worker-'));
    try {
        const worker = createWorkerForTest(appDirectory);
        const calls: unknown[][] = [];
        (worker as any).callApp = (...args: unknown[]) => {
            calls.push(args);
        };
        const workspace: TodoWorkspaceConfig = { type: 'path', path: '/workspace/project-b' };
        const todo = await worker.addGlobalTodo(
            'title',
            'content',
            'medium',
            undefined,
            undefined,
            undefined,
            workspace
        );

        await worker.triggerGlobalTodoNow(todo.id);

        assert.equal(calls.length, 1);
        assert.equal(calls[0][0], 'triggerTodoTask');
        assert.equal(calls[0][1], todo.id);
        assert.deepEqual(calls[0][6], workspace);
        assert.equal(calls[0][7], undefined);
        assert.equal(calls[0][8], undefined);
    } finally {
        fs.rmSync(appDirectory, { recursive: true, force: true });
    }
});
