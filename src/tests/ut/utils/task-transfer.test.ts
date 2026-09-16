import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { UserMessage } from '../../../main/aikernel/messages.js';
import { GoalStates } from '../../../main/aikernel/goal/state.js';
import { getGoalExtension } from '../../../main/aikernel/goal/task-extension.js';
import { setCustomOpendeskDirectory } from '../../../main/utils/setting.js';
import { exportTaskBundle, prepareTaskImport, importTaskEntries } from '../../../main/aikernel/task/transfer.js';

describe('task transfer persistence', () => {
    let directory: string;
    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'od-transfer-'));
        setCustomOpendeskDirectory(directory);
        fs.mkdirSync(path.join(directory, 'tasks'), { recursive: true });
    });
    afterEach(() => {
        jest.restoreAllMocks();
        setCustomOpendeskDirectory(undefined);
        fs.rmSync(directory, { recursive: true, force: true });
    });

    function source() {
        const manager = new TaskManagerState();
        for (const id of ['parent', 'child']) {
            const task = new TaskState(manager, id === 'child' ? 'parent' : null);
            task.task_id = id;
            task.task_name = id;
            task.task_status = 'running';
            task.chat_context.appendMessage(new UserMessage('unsaved history'));
            manager.tasks.push(task);
        }
        return manager;
    }

    test('exports live memory with children, imports copies and survives immediate reload', async () => {
        const original = source();
        const old = new Date('2020-01-01T00:00:00.000Z');
        original.tasks.forEach((task) => {
            task.created_at = old;
            task.updated_at = old;
            (task.chat_context.messages[0] as UserMessage).timestamp = old.getTime();
        });
        const file = path.join(directory, 'backup.zip');
        expect(await exportTaskBundle(original, ['parent'], file)).toBe(2);
        expect((await prepareTaskImport(file, original)).every((entry) => entry.duplicate)).toBe(true);
        const destination = new TaskManagerState();
        const entries = await prepareTaskImport(file, destination);
        const importedAt = Date.now();
        const result = await importTaskEntries(
            entries,
            entries.map((entry) => entry.id),
            destination,
            '/new/work'
        );
        expect(result.failed).toEqual([]);
        expect(result.imported).toHaveLength(2);
        expect(original.tasks[0].task_status).toBe('running');
        const loaded = TaskManagerState.load()!;
        const parent = loaded.getTask(result.imported.find((entry) => entry.sourceId === 'parent')!.taskId)!;
        const child = loaded.getTask(result.imported.find((entry) => entry.sourceId === 'child')!.taskId)!;
        expect(parent.task_id).not.toBe('parent');
        expect(parent.task_status).toBe('stopped');
        expect(parent.chat_context.messages[0].content).toEqual(original.tasks[0].chat_context.messages[0].content);
        expect(parent.workspace).toBe('/new/work');
        expect(parent.created_at.getTime()).toBeGreaterThanOrEqual(importedAt - 100);
        expect(parent.updated_at!.getTime()).toBeGreaterThanOrEqual(importedAt);
        expect((parent.chat_context.messages[0] as UserMessage).timestamp).toBeGreaterThanOrEqual(importedAt - 100);
        expect(child.created_at.getTime()).toBeGreaterThanOrEqual(importedAt - 100);
        expect(child.parent_id).toBe(parent.task_id);
        expect((await prepareTaskImport(file, loaded)).every((entry) => entry.duplicate)).toBe(true);
    });

    test('index failure rolls back the family and never reports it as imported', async () => {
        const file = path.join(directory, 'backup.zip');
        await exportTaskBundle(source(), ['parent'], file);
        const destination = new TaskManagerState();
        const entries = await prepareTaskImport(file, destination);
        // An existing directory at the index path forces the atomic rename to fail.
        fs.mkdirSync(path.join(directory, 'tasks', 'task_list.json'));
        const result = await importTaskEntries(entries, ['parent', 'child'], destination, '/new/work');
        expect(result.imported).toEqual([]);
        expect(result.failed).toHaveLength(2);
        expect(destination.tasks).toEqual([]);
        expect(fs.readdirSync(path.join(directory, 'tasks'))).toEqual(['task_list.json']);
    });

    test('a corrupt lazy task cannot be exported as a successful empty backup', async () => {
        const manager = source();
        manager.tasks.forEach((task) => {
            task._dirty = true;
        });
        manager.saveSync();
        fs.writeFileSync(path.join(directory, 'tasks', 'parent.json'), '{broken');
        const target = path.join(directory, 'backup.zip');
        fs.writeFileSync(target, 'previous backup');
        await expect(exportTaskBundle(TaskManagerState.load()!, ['parent'], target)).rejects.toThrow('invalidTask');
        expect(fs.readFileSync(target, 'utf8')).toBe('previous backup');
    });

    test('a selected child without its parent becomes an independent task', async () => {
        const file = path.join(directory, 'backup.zip');
        await exportTaskBundle(source(), ['parent'], file);
        const destination = new TaskManagerState();
        const entries = await prepareTaskImport(file, destination);
        const result = await importTaskEntries(entries, ['child'], destination, '/new/work');
        expect(result.skipped).toBe(1);
        expect(destination.getTask(result.imported[0].taskId)!.parent_id).toBeNull();
    });

    test('an active goal is paused with the new task ID and stays paused after reload', async () => {
        const manager = source();
        getGoalExtension(manager.tasks[0]).state = GoalStates.create('parent', { objective: 'finish the feature' });
        const file = path.join(directory, 'goal.zip');
        await exportTaskBundle(manager, ['parent'], file);
        const destination = new TaskManagerState();
        const entries = await prepareTaskImport(file, destination);
        const result = await importTaskEntries(entries, ['parent', 'child'], destination, '/new/work');
        const id = result.imported.find((entry) => entry.sourceId === 'parent')!.taskId;
        const loaded = TaskManagerState.load()!.getTask(id)!;
        expect(getGoalExtension(loaded).state).toMatchObject({
            taskId: id,
            status: 'paused',
            objective: 'finish the feature'
        });
        expect(loaded.task_status).toBe('stopped');
        expect(getGoalExtension(loaded).state.schedulerLease).toBeUndefined();
    });
});
