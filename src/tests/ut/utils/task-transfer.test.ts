import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { UserMessage } from '../../../main/aikernel/messages.js';
import { GoalStates } from '../../../main/aikernel/goal/state.js';
import { getGoalExtension } from '../../../main/aikernel/goal/task-extension.js';
import { setCustomOpendeskDirectory } from '../../../main/utils/setting.js';
import { exportTaskBundle, importTaskEntries } from '../../../main/aikernel/task/transfer.js';

import { readTaskImportFile } from '../../../main/utils/task-bundle.js';

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

    function source(independent = 0) {
        const manager = new TaskManagerState();
        for (const id of ['parent', 'child', ...Array.from({ length: independent }, (_, i) => `standalone-${i}`)]) {
            const task = new TaskState(manager, id === 'child' ? 'parent' : null);
            task.task_id = id;
            task.task_name = id;
            task.task_status = 'running';
            task.chat_context.appendMessage(new UserMessage('unsaved history'));
            manager.tasks.push(task);
        }
        return manager;
    }

    async function prepare(original = source()) {
        const file = path.join(directory, 'backup.zip');
        await exportTaskBundle(
            original,
            original.tasks.filter((task) => !task.parent_id).map((task) => task.task_id),
            file
        );
        const destination = new TaskManagerState();
        return { file, destination, entries: await readTaskImportFile(file) };
    }

    test('commits all selected tasks with one index write and notification', async () => {
        const { destination, entries } = await prepare(source(20));
        const writeIndex = jest.spyOn(destination as any, 'saveTaskListSync');
        const notify = jest.spyOn(destination, 'publishTaskListUpdate');
        expect(
            await importTaskEntries(
                entries,
                entries.map((entry) => entry.id),
                destination,
                '/new/work'
            )
        ).toBe(22);
        expect(writeIndex).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledTimes(1);
        expect(
            TaskManagerState.load()!
                .tasks.map((task) => task.task_id)
                .sort()
        ).toEqual(destination.tasks.map((task) => task.task_id).sort());
    });

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
        const destination = new TaskManagerState();
        const entries = await readTaskImportFile(file);
        const importedAt = Date.now();
        const result = await importTaskEntries(
            entries,
            entries.map((entry) => entry.id),
            destination,
            '/new/work'
        );
        expect(result).toBe(2);
        expect(original.tasks[0].task_status).toBe('running');
        const loaded = TaskManagerState.load()!;
        const parent = loaded.getTask(loaded.tasks.find((task) => task.task_name === 'parent')!.task_id)!;
        const child = loaded.getTask(loaded.tasks.find((task) => task.task_name === 'child')!.task_id)!;
        expect(parent.task_id).not.toBe('parent');
        expect(parent.task_status).toBe('stopped');
        expect(parent.chat_context.messages[0].content).toEqual(original.tasks[0].chat_context.messages[0].content);
        expect(parent.workspace).toBe('/new/work');
        expect(parent.created_at.getTime()).toBeGreaterThanOrEqual(importedAt - 100);
        expect(parent.updated_at!.getTime()).toBeGreaterThanOrEqual(importedAt);
        expect((parent.chat_context.messages[0] as UserMessage).timestamp).toBeGreaterThanOrEqual(importedAt - 100);
        expect(child.created_at.getTime()).toBeGreaterThanOrEqual(importedAt - 100);
        expect(child.parent_id).toBe(parent.task_id);
        const firstIds = loaded.tasks.map((task) => task.task_id);
        expect(await importTaskEntries(entries, ['parent', 'child'], loaded, '/new/work')).toBe(2);
        const reloaded = TaskManagerState.load()!;
        expect(reloaded.tasks).toHaveLength(4);
        expect(new Set(reloaded.tasks.map((task) => task.task_id)).size).toBe(4);
        expect(reloaded.tasks.map((task) => task.task_id)).toEqual(expect.arrayContaining(firstIds));
    });

    test.each(['file', 'index'])('%s failure rolls back the entire selected batch', async (failure) => {
        const { destination, entries } = await prepare(source(2));
        const existing = new TaskState(destination);
        destination.tasks.push(existing);
        destination.saveSync();
        const taskDirectory = path.join(directory, 'tasks');
        const originalFiles = fs.readdirSync(taskDirectory).sort();
        const originalIndex = fs.readFileSync(path.join(taskDirectory, 'task_list.json'), 'utf8');
        const notify = jest.spyOn(destination, 'publishTaskListUpdate');
        if (failure === 'index') {
            const rename = fs.renameSync;
            jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
                if (String(to).endsWith('task_list.json')) throw new Error('simulated index failure');
                return rename(from, to);
            });
        } else {
            const write = fs.writeFileSync;
            jest.spyOn(fs, 'writeFileSync').mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
                if (typeof args[0] === 'number' && JSON.parse(String(args[1])).task_name === 'child')
                    throw new Error('simulated task file failure');
                return write(...args);
            });
        }
        await expect(
            importTaskEntries(
                entries,
                entries.map((entry) => entry.id),
                destination,
                '/new/work'
            )
        ).rejects.toThrow('writeFailed');
        expect(notify).not.toHaveBeenCalled();
        expect(destination.tasks).toEqual([existing]);
        expect(fs.readdirSync(taskDirectory).sort()).toEqual(originalFiles);
        expect(fs.readFileSync(path.join(taskDirectory, 'task_list.json'), 'utf8')).toBe(originalIndex);
        expect(TaskManagerState.load()!.tasks.map((task) => task.task_id)).toEqual([existing.task_id]);
    });

    test('silently retries a temporary index rename conflict using the same task IDs', async () => {
        const { destination, entries } = await prepare();
        const rename = fs.renameSync;
        let failures = 0;
        const taskFiles: string[] = [];
        const open = fs.openSync;
        jest.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
            if (args[1] === 'wx') taskFiles.push(String(args[0]));
            return open(...args);
        });
        jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
            if (String(to).endsWith('task_list.json') && failures++ === 0) {
                throw Object.assign(new Error('temporarily locked'), { code: 'EPERM', syscall: 'rename' });
            }
            return rename(from, to);
        });
        const notify = jest.spyOn(destination, 'publishTaskListUpdate');
        expect(await importTaskEntries(entries, ['parent', 'child'], destination, '/new/work')).toBe(2);
        expect(taskFiles).toHaveLength(4);
        expect(taskFiles.slice(0, 2)).toEqual(taskFiles.slice(2));
        expect(TaskManagerState.load()!.tasks).toHaveLength(2);
        expect(notify).toHaveBeenCalledTimes(1);
        expect(fs.readdirSync(path.join(directory, 'tasks')).filter((file) => file.endsWith('.tmp'))).toEqual([]);
    });

    test('does not retry when the failed batch cannot be fully rolled back', async () => {
        const { destination, entries } = await prepare();
        const rename = fs.renameSync;
        const unlink = fs.unlinkSync;
        const cause = Object.assign(new Error('index locked'), { code: 'EPERM', syscall: 'rename' });
        let indexAttempts = 0;
        jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
            if (String(to).endsWith('task_list.json')) {
                indexAttempts++;
                throw cause;
            }
            return rename(from, to);
        });
        jest.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
            if (String(file).endsWith('.json')) throw new Error('rollback blocked');
            return unlink(file);
        });
        await expect(importTaskEntries(entries, ['parent'], destination, '/new/work')).rejects.toMatchObject({
            cause,
            retryable: false
        });
        expect(indexAttempts).toBe(1);
        expect(destination.tasks).toEqual([]);
    });

    test('silently recovers when a pending index save fails before import starts', async () => {
        const { destination, entries } = await prepare();
        const existing = new TaskState(destination);
        existing.task_name = 'existing';
        existing._dirty = true;
        destination.tasks.push(existing);
        const rename = fs.promises.rename;
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        let entered!: () => void;
        const waiting = new Promise<void>((resolve) => {
            entered = resolve;
        });
        let failFirst = true;
        const cause = Object.assign(new Error('temporarily locked pending index'), {
            code: 'EPERM',
            syscall: 'rename'
        });
        jest.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
            if (failFirst && String(to).endsWith('task_list.json')) {
                failFirst = false;
                entered();
                await blocked;
                // The async writer retries; keeping this path blocked exhausts that writer's own retry budget.
                throw cause;
            }
            if (String(to).endsWith('task_list.json')) throw cause;
            return rename(from, to);
        });
        const background = destination.flushAllPendingSaves().catch(() => {});
        await waiting;
        const importing = importTaskEntries(entries, ['parent'], destination, '/new/work');
        release();
        await background;
        expect(await importing).toBe(1);
        expect(TaskManagerState.load()!.tasks.map((task) => task.task_name)).toEqual(['existing', 'parent']);
    });

    test('stops retrying a persistent index lock and rolls back the batch', async () => {
        const { destination, entries } = await prepare();
        const rename = fs.renameSync;
        let failures = 0;
        const cause = Object.assign(new Error('still locked'), { code: 'EPERM', syscall: 'rename' });
        jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
            if (String(to).endsWith('task_list.json')) {
                failures++;
                throw cause;
            }
            return rename(from, to);
        });
        await expect(importTaskEntries(entries, ['parent'], destination, '/new/work')).rejects.toMatchObject({
            stage: 'writeIndex',
            cause
        });
        expect(failures).toBeGreaterThan(1);
        expect(failures).toBeLessThanOrEqual(8);
        expect(destination.tasks).toEqual([]);
        expect(fs.readdirSync(path.join(directory, 'tasks'))).toEqual([]);
    });

    test('does not report a committed batch as failed when list notification throws', async () => {
        const { destination, entries } = await prepare();
        jest.spyOn(destination, 'publishTaskListUpdate').mockImplementation(() => {
            throw new Error('subscriber failure');
        });
        expect(await importTaskEntries(entries, ['parent'], destination, '/new/work')).toBe(1);
        expect(TaskManagerState.load()!.tasks).toHaveLength(1);
    });

    test('retries the same snapshot after an index failure without leaving duplicate tasks', async () => {
        const { destination, entries } = await prepare();
        const rename = fs.renameSync;
        let failOnce = true;
        jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
            if (failOnce && String(to).endsWith('task_list.json')) {
                failOnce = false;
                throw Object.assign(new Error('temporarily locked'), { code: 'EPERM' });
            }
            return rename(from, to);
        });
        await expect(importTaskEntries(entries, ['parent'], destination, '/new/work')).rejects.toThrow('writeFailed');
        expect(await importTaskEntries(entries, ['parent'], destination, '/new/work')).toBe(1);
        expect(TaskManagerState.load()!.tasks).toHaveLength(1);
    });

    test.each(['serializeTask', 'writeTask', 'writeIndex'] as const)(
        'preserves the original cause and phase for %s failures',
        async (stage) => {
            const { destination, entries } = await prepare();
            const original = Object.assign(new Error('diagnostic failure'), {
                code: stage === 'serializeTask' ? undefined : 'EACCES',
                syscall: stage === 'writeIndex' ? 'rename' : 'open'
            });
            if (stage === 'serializeTask') {
                jest.spyOn(TaskState.prototype, 'toJSON').mockImplementation(() => {
                    throw original;
                });
            } else if (stage === 'writeTask') {
                const open = fs.openSync;
                jest.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
                    if (args[1] === 'wx') throw original;
                    return open(...args);
                });
            } else {
                const rename = fs.renameSync;
                jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
                    if (String(to).endsWith('task_list.json')) throw original;
                    return rename(from, to);
                });
            }
            await expect(importTaskEntries(entries, ['parent'], destination, '/new/work')).rejects.toMatchObject({
                message: 'writeFailed',
                stage,
                cause: original,
                filePath: expect.stringContaining(stage === 'writeIndex' ? 'task_list.json' : '.json')
            });
            expect(destination.tasks).toEqual([]);
        }
    );

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
        const { destination, entries } = await prepare();
        const result = await importTaskEntries(entries, ['child'], destination, '/new/work');
        expect(result).toBe(1);
        expect(destination.tasks[0].parent_id).toBeNull();
    });

    test('an active goal is paused with the new task ID and stays paused after reload', async () => {
        const manager = source();
        getGoalExtension(manager.tasks[0]).state = GoalStates.create('parent', { objective: 'finish the feature' });
        const { destination, entries } = await prepare(manager);
        await importTaskEntries(entries, ['parent', 'child'], destination, '/new/work');
        const id = destination.tasks.find((task) => task.task_name === 'parent')!.task_id;
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
