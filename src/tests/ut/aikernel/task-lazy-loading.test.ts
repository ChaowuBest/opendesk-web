import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { AutoCompactStates } from '../../../main/aikernel/compaction/auto-compact.js';
import { GoalStates } from '../../../main/aikernel/goal/state.js';
import '../../../main/aikernel/goal/task-extension.js';
import { ChatContext, UserMessage } from '../../../main/aikernel/messages.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { deleteTaskTodos, getTaskTodosForDisplay, setTaskTodos } from '../../../main/aikernel/todos/task-todos.js';
import { getTaskArtifactDirectory, setCustomOpendeskDirectory } from '../../../main/utils/setting.js';

let tempRootDir: string | undefined;

function createTempTaskDirectory(): string {
    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-task-lazy-loading-'));
    setCustomOpendeskDirectory(tempRootDir);
    const taskDirectory = path.join(tempRootDir, 'tasks');
    fs.mkdirSync(taskDirectory, { recursive: true });
    return taskDirectory;
}

function cleanupTempTaskDirectory(): void {
    deleteTaskTodos('task-lazy');
    if (tempRootDir && fs.existsSync(tempRootDir)) {
        fs.rmSync(tempRootDir, { recursive: true, force: true });
    }
    tempRootDir = undefined;
    setCustomOpendeskDirectory(undefined);
}

function persistTaskFixture(): { taskDirectory: string; taskFile: string; taskListFile: string } {
    const taskDirectory = createTempTaskDirectory();
    const manager = new TaskManagerState();
    const task = new TaskState(manager);
    task.task_id = 'task-lazy';
    task.task_name = 'lazy task';
    task.task_status = 'waiting';
    task.model = 'fixture-model';
    task.created_at = new Date('2026-07-18T08:00:00.000Z');
    task.started_at = new Date('2026-07-18T08:01:00.000Z');
    task.finished_at = new Date('2026-07-18T08:02:00.000Z');
    task.total_elapsed_ms = 60000;
    task.bookmark_path = '/review/lazy';
    task.workspace = '/workspace/lazy';
    task.chat_context = new ChatContext();
    task.chat_context.appendMessage(new UserMessage('persisted lazy history'));
    task.setAutoCompactState(
        AutoCompactStates.deserialize({
            consecutive_failures: 1,
            last_failure_reason: 'fixture failure'
        })
    );
    task.goal_state = GoalStates.create(task.task_id, {
        objective: 'keep the complete goal summary in renderer updates',
        successCriteria: ['task index only stores goal status'],
        source: 'system'
    });
    manager.tasks.push(task);
    manager.saveSync();

    return {
        taskDirectory,
        taskFile: path.join(taskDirectory, 'task-lazy.json'),
        taskListFile: path.join(taskDirectory, 'task_list.json')
    };
}

describe('task lazy loading', () => {
    afterEach(() => {
        cleanupTempTaskDirectory();
    });

    test('loads metadata from the index without reading the full task file', () => {
        const { taskFile } = persistTaskFixture();
        const manager = TaskManagerState.load();

        expect(manager).not.toBeNull();
        expect(manager!.tasks).toHaveLength(1);
        const lazyTask = manager!.tasks[0];
        expect(lazyTask._fullyLoaded).toBe(false);

        const movedTaskFile = `${taskFile}.moved`;
        fs.renameSync(taskFile, movedTaskFile);
        expect(manager!.getTaskList()).toEqual([
            expect.objectContaining({
                task_id: 'task-lazy',
                task_name: 'lazy task',
                task_status: 'waiting',
                bookmark_path: '/review/lazy',
                workspace: '/workspace/lazy'
            })
        ]);
        expect(lazyTask._fullyLoaded).toBe(false);
        expect(lazyTask._corrupted).toBe(false);
        fs.renameSync(movedTaskFile, taskFile);
    });

    test('hydrates heavy fields on first getTask and does not read the file again', () => {
        const { taskFile } = persistTaskFixture();
        const manager = TaskManagerState.load()!;

        const loadedTask = manager.getTask('task-lazy');
        expect(loadedTask).toBeDefined();
        expect(loadedTask!._fullyLoaded).toBe(true);
        expect(loadedTask!.model).toBe('fixture-model');
        expect(loadedTask!.chat_context.messages).toHaveLength(1);
        expect(loadedTask!.chat_context.messages[0]).toBeInstanceOf(UserMessage);
        expect(loadedTask!.getAutoCompactState()).toMatchObject({
            consecutiveFailures: 1,
            lastFailureReason: 'fixture failure'
        });

        fs.unlinkSync(taskFile);
        const loadedAgain = manager.getTask('task-lazy');
        expect(loadedAgain).toBe(loadedTask);
        expect(loadedAgain!._corrupted).toBe(false);
        expect(loadedAgain!.chat_context.messages).toHaveLength(1);
    });

    test('saveSync does not recreate or overwrite an unloaded task file', () => {
        const { taskFile } = persistTaskFixture();
        const manager = TaskManagerState.load()!;
        const lazyTask = manager.tasks[0];
        const movedTaskFile = `${taskFile}.moved`;
        fs.renameSync(taskFile, movedTaskFile);

        manager.saveSync();

        expect(fs.existsSync(taskFile)).toBe(false);
        expect(fs.readFileSync(movedTaskFile, 'utf8')).toContain('persisted lazy history');
        expect(lazyTask._fullyLoaded).toBe(false);
        fs.renameSync(movedTaskFile, taskFile);
    });

    test('stores only goal status in the index while keeping the full renderer summary', () => {
        const { taskListFile } = persistTaskFixture();
        const persistedIndex = JSON.parse(fs.readFileSync(taskListFile, 'utf8'));

        expect(persistedIndex[0].goal).toEqual({ status: 'active' });
        expect(persistedIndex[0].goal).not.toHaveProperty('objective');
        expect(persistedIndex[0].goal).not.toHaveProperty('successCriteria');

        const manager = TaskManagerState.load()!;
        expect(manager.getTaskList()[0]).toEqual(expect.objectContaining({ goal: { status: 'active' } }));

        manager.getTask('task-lazy');
        expect(manager.getTaskList()[0]).toEqual(
            expect.objectContaining({
                goal: expect.objectContaining({
                    status: 'paused',
                    objective: 'keep the complete goal summary in renderer updates',
                    successCriteria: ['task index only stores goal status']
                })
            })
        );
    });

    test('compacts rich goal metadata already present in a lazy index entry', () => {
        const { taskListFile } = persistTaskFixture();
        const index = JSON.parse(fs.readFileSync(taskListFile, 'utf8'));
        index[0].goal = {
            status: 'blocked',
            objective: 'legacy objective',
            successCriteria: ['legacy criterion'],
            lastEvaluation: { reason: 'legacy evidence' }
        };
        fs.writeFileSync(taskListFile, JSON.stringify(index, null, 4), 'utf8');
        const manager = TaskManagerState.load()!;

        expect(manager.tasks[0]._fullyLoaded).toBe(false);
        manager.saveSync();

        const compactedIndex = JSON.parse(fs.readFileSync(taskListFile, 'utf8'));
        expect(compactedIndex[0].goal).toEqual({ status: 'blocked' });
        expect(manager.tasks[0]._fullyLoaded).toBe(false);
    });

    test('compacts goal metadata when preserving an entry created by another process', () => {
        const { taskDirectory, taskListFile } = persistTaskFixture();
        const manager = TaskManagerState.load()!;
        const index = JSON.parse(fs.readFileSync(taskListFile, 'utf8'));
        index.push({
            task_id: 'task-external',
            task_name: 'external task',
            task_status: 'waiting',
            created_at: '2026-07-18T09:00:00.000Z',
            goal: {
                status: 'complete',
                objective: 'external objective',
                successCriteria: ['external criterion']
            }
        });
        fs.writeFileSync(taskListFile, JSON.stringify(index, null, 4), 'utf8');
        fs.writeFileSync(path.join(taskDirectory, 'task-external.json'), '{}', 'utf8');

        manager.saveSync();

        const mergedIndex = JSON.parse(fs.readFileSync(taskListFile, 'utf8'));
        const externalEntry = mergedIndex.find((entry: { task_id: string }) => entry.task_id === 'task-external');
        expect(externalEntry.goal).toEqual({ status: 'complete' });
    });

    test('upgrades a legacy id-only index without rewriting the full task file', () => {
        const { taskFile, taskListFile } = persistTaskFixture();
        const taskJson = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
        delete taskJson.goal_state;
        delete taskJson.goal_final_snapshots;
        delete taskJson.goal_event_log;
        fs.writeFileSync(taskFile, JSON.stringify(taskJson, null, 4), 'utf8');
        const taskFileBeforeLoad = fs.readFileSync(taskFile, 'utf8');
        fs.writeFileSync(taskListFile, JSON.stringify([{ task_id: 'task-lazy' }], null, 4), 'utf8');

        const manager = TaskManagerState.load();

        expect(manager).not.toBeNull();
        expect(manager!.tasks[0]._fullyLoaded).toBe(true);
        expect(manager!.tasks[0]._dirty).toBe(false);
        expect(manager!.tasks[0].chat_context.messages).toHaveLength(1);
        const upgradedIndex = JSON.parse(fs.readFileSync(taskListFile, 'utf8'));
        expect(upgradedIndex).toEqual([
            expect.objectContaining({
                task_id: 'task-lazy',
                task_name: 'lazy task',
                task_status: 'waiting',
                created_at: '2026-07-18T08:00:00.000Z'
            })
        ]);
        expect(fs.readFileSync(taskFile, 'utf8')).toBe(taskFileBeforeLoad);
    });

    test('drops a mismatched legacy index entry without touching its task file', () => {
        const { taskDirectory, taskFile, taskListFile } = persistTaskFixture();
        const mismatchedJson = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
        mismatchedJson.task_id = 'task-other';
        const mismatchedContent = JSON.stringify(mismatchedJson, null, 4);
        fs.writeFileSync(taskFile, mismatchedContent, 'utf8');

        const validTaskFile = path.join(taskDirectory, 'task-valid.json');
        const validTaskJson = { ...mismatchedJson, task_id: 'task-valid', task_name: 'valid legacy task' };
        fs.writeFileSync(validTaskFile, JSON.stringify(validTaskJson, null, 4), 'utf8');
        fs.writeFileSync(
            taskListFile,
            JSON.stringify([{ task_id: 'task-lazy' }, { task_id: 'task-valid' }], null, 4),
            'utf8'
        );

        const manager = TaskManagerState.load()!;

        expect(manager.tasks.map((task) => task.task_id)).toEqual(['task-valid']);
        expect(
            JSON.parse(fs.readFileSync(taskListFile, 'utf8')).map((entry: { task_id: string }) => entry.task_id)
        ).toEqual(['task-valid']);
        expect(fs.readFileSync(taskFile, 'utf8')).toBe(mismatchedContent);
    });

    test('marks a malformed full task file as corrupted when hydration is requested', () => {
        const { taskFile } = persistTaskFixture();
        fs.writeFileSync(taskFile, '{invalid json', 'utf8');
        const manager = TaskManagerState.load()!;
        const lazyTask = manager.tasks[0];

        expect(lazyTask._fullyLoaded).toBe(false);
        const result = manager.getTaskLoadResult('task-lazy');
        const degradedTask = result.task;

        expect(degradedTask).toBe(lazyTask);
        expect(result.corrupted).toBe(true);
        expect(degradedTask!._fullyLoaded).toBe(true);
        expect(degradedTask!._corrupted).toBe(true);
        expect(degradedTask!.chat_context.messages).toEqual([]);
    });

    test('removes a corrupted entry without deleting task data, artifacts, or todos', () => {
        const { taskDirectory, taskFile, taskListFile } = persistTaskFixture();
        const malformedContent = '{invalid json';
        fs.writeFileSync(taskFile, malformedContent, 'utf8');
        const artifactFile = path.join(getTaskArtifactDirectory('task-lazy'), 'preserved.txt');
        fs.mkdirSync(path.dirname(artifactFile), { recursive: true });
        fs.writeFileSync(artifactFile, 'preserved artifact', 'utf8');
        setTaskTodos('task-lazy', [
            {
                id: 'todo-preserved',
                task_id: 'task-lazy',
                title: 'preserved todo',
                content: 'must remain available',
                status: 'pending',
                created_at: '2026-07-18T08:00:00.000Z',
                updated_at: '2026-07-18T08:00:00.000Z'
            }
        ]);
        const manager = TaskManagerState.load()!;
        const concurrentTaskManager = new TaskManagerState();
        const concurrentTask = new TaskState(concurrentTaskManager);
        concurrentTask.task_id = 'task-from-another-process';
        concurrentTask.task_name = 'concurrent task';
        concurrentTask.created_at = new Date('2026-07-18T09:00:00.000Z');
        fs.writeFileSync(
            path.join(taskDirectory, `${concurrentTask.task_id}.json`),
            JSON.stringify(concurrentTask.toJSON(), null, 4),
            'utf8'
        );
        const concurrentIndexEntry = concurrentTask.toIndexJSON();
        const diskIndex = JSON.parse(fs.readFileSync(taskListFile, 'utf8'));
        fs.writeFileSync(taskListFile, JSON.stringify([...diskIndex, concurrentIndexEntry], null, 4), 'utf8');

        expect(manager.getTaskLoadResult('task-lazy').corrupted).toBe(true);
        expect(manager.removeCorruptedTaskEntry('task-lazy')).toBe(true);

        expect(manager.tasks).toEqual([]);
        expect(JSON.parse(fs.readFileSync(taskListFile, 'utf8'))).toEqual([concurrentIndexEntry]);
        expect(fs.readFileSync(taskFile, 'utf8')).toBe(malformedContent);
        expect(fs.readFileSync(artifactFile, 'utf8')).toBe('preserved artifact');
        expect(getTaskTodosForDisplay('task-lazy')).toEqual([
            expect.objectContaining({ id: 'todo-preserved', status: 'pending' })
        ]);
    });

    test('safe task lookup removes a corrupted entry before callers can mutate it', () => {
        const { taskFile, taskListFile } = persistTaskFixture();
        const malformedContent = '{invalid json';
        fs.writeFileSync(taskFile, malformedContent, 'utf8');
        const manager = TaskManagerState.load()!;

        expect(manager.getTask('task-lazy')).toBeUndefined();

        expect(manager.tasks).toEqual([]);
        expect(JSON.parse(fs.readFileSync(taskListFile, 'utf8'))).toEqual([]);
        expect(fs.readFileSync(taskFile, 'utf8')).toBe(malformedContent);
    });

    test('treats a mismatched full-task ID as corruption without touching either task file', () => {
        const { taskDirectory, taskFile, taskListFile } = persistTaskFixture();
        const mismatchedJson = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
        mismatchedJson.task_id = 'task-other';
        const mismatchedContent = JSON.stringify(mismatchedJson, null, 4);
        fs.writeFileSync(taskFile, mismatchedContent, 'utf8');
        const otherTaskFile = path.join(taskDirectory, 'task-other.json');
        const otherTaskContent = '{preserve this unrelated task file';
        fs.writeFileSync(otherTaskFile, otherTaskContent, 'utf8');
        const manager = TaskManagerState.load()!;

        expect(manager.getTask('task-lazy')).toBeUndefined();

        expect(manager.tasks).toEqual([]);
        expect(JSON.parse(fs.readFileSync(taskListFile, 'utf8'))).toEqual([]);
        expect(fs.readFileSync(taskFile, 'utf8')).toBe(mismatchedContent);
        expect(fs.readFileSync(otherTaskFile, 'utf8')).toBe(otherTaskContent);
    });

    test('clears stale optional index metadata when the full task file omits it', () => {
        const { taskFile, taskListFile } = persistTaskFixture();
        const taskJson = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
        for (const field of [
            'started_at',
            'finished_at',
            'updated_at',
            'total_elapsed_ms',
            'bookmark_path',
            'origin',
            'workspace',
            'workspaceID',
            'executionNodeId',
            'executionNodeLabel'
        ]) {
            delete taskJson[field];
        }
        fs.writeFileSync(taskFile, JSON.stringify(taskJson, null, 4), 'utf8');

        const index = JSON.parse(fs.readFileSync(taskListFile, 'utf8'));
        Object.assign(index[0], {
            parent_id: 'stale-parent',
            internal: true,
            updated_at: '2026-07-18T08:03:00.000Z',
            origin: {
                type: 'channel',
                channel: 'stale-channel',
                accountId: 'stale-account',
                recipientId: 'stale-recipient'
            },
            workspaceID: 'stale-workspace-id',
            executionNodeId: 'stale-node-id',
            executionNodeLabel: 'stale-node-label'
        });
        fs.writeFileSync(taskListFile, JSON.stringify(index, null, 4), 'utf8');
        const manager = TaskManagerState.load()!;

        const task = manager.getTask('task-lazy')!;

        expect(task.parent_id).toBeNull();
        expect(task.internal).toBeUndefined();
        expect(task.started_at).toBeUndefined();
        expect(task.finished_at).toBeUndefined();
        expect(task.updated_at).toBeUndefined();
        expect(task.total_elapsed_ms).toBe(0);
        expect(task.bookmark_path).toBeUndefined();
        expect(task.origin).toBeUndefined();
        expect(task.workspace).toBeUndefined();
        expect(task.workspaceID).toBeUndefined();
        expect(task.executionNodeId).toBeUndefined();
        expect(task.executionNodeLabel).toBeUndefined();

        manager.saveSync();
        const savedTaskJson = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
        expect(savedTaskJson).toEqual(
            expect.objectContaining({
                parent_id: null,
                total_elapsed_ms: 0
            })
        );
        for (const field of [
            'internal',
            'started_at',
            'finished_at',
            'updated_at',
            'bookmark_path',
            'origin',
            'workspace',
            'workspaceID',
            'executionNodeId',
            'executionNodeLabel'
        ]) {
            expect(savedTaskJson).not.toHaveProperty(field);
        }
    });

    test('explicit deletion still removes the files of a corrupted task', () => {
        const { taskFile } = persistTaskFixture();
        fs.writeFileSync(taskFile, '{invalid json', 'utf8');
        const manager = TaskManagerState.load()!;

        expect(manager.removeTask('task-lazy')).toEqual(['task-lazy']);

        expect(manager.tasks).toEqual([]);
        expect(fs.existsSync(taskFile)).toBe(false);
    });

    test('explicit deletion does not restore the task index when removing its task file fails', () => {
        const { taskFile, taskListFile } = persistTaskFixture();
        const manager = TaskManagerState.load()!;
        const originalUnlinkSync = fs.unlinkSync.bind(fs);
        const unlinkSpy = jest.spyOn(fs, 'unlinkSync').mockImplementation((filePath) => {
            if (path.resolve(filePath.toString()) === path.resolve(taskFile)) {
                throw new Error('simulated task file deletion failure');
            }
            originalUnlinkSync(filePath);
        });

        try {
            expect(manager.removeTask('task-lazy')).toEqual(['task-lazy']);
        } finally {
            unlinkSpy.mockRestore();
        }

        expect(fs.existsSync(taskFile)).toBe(true);
        expect(manager.tasks).toEqual([]);
        expect(
            JSON.parse(fs.readFileSync(taskListFile, 'utf8')).map((entry: { task_id: string }) => entry.task_id)
        ).not.toContain('task-lazy');
    });

    test('manual recovery scans every task file and rebuilds an exact index', () => {
        const { taskDirectory, taskListFile } = persistTaskFixture();
        const indexedTaskFile = path.join(taskDirectory, 'task-lazy.json');
        const indexedTaskBeforeRecovery = fs.readFileSync(indexedTaskFile, 'utf8');
        const sourceManager = new TaskManagerState();
        const unindexedTask = new TaskState(sourceManager);
        unindexedTask.task_id = 'task-unindexed';
        unindexedTask.task_name = 'recoverable unindexed task';
        unindexedTask.task_status = 'stopped';
        unindexedTask.created_at = new Date('2026-07-18T09:00:00.000Z');
        unindexedTask.chat_context.appendMessage(new UserMessage('recover me from the directory scan'));
        const unindexedTaskFile = path.join(taskDirectory, 'task-unindexed.json');
        const unindexedTaskContent = JSON.stringify(unindexedTask.toJSON(), null, 4);
        fs.writeFileSync(unindexedTaskFile, unindexedTaskContent, 'utf8');
        fs.writeFileSync(path.join(taskDirectory, 'task-corrupt.json'), '{invalid json', 'utf8');
        const oldIndex = JSON.parse(fs.readFileSync(taskListFile, 'utf8'));
        oldIndex.push({
            task_id: 'task-corrupt',
            task_name: 'stale corrupt entry',
            task_status: 'waiting',
            created_at: '2026-07-18T10:00:00.000Z'
        });
        fs.writeFileSync(taskListFile, JSON.stringify(oldIndex, null, 4), 'utf8');

        const recovered = TaskManagerState.rebuildTaskListFromDirectory();

        expect(recovered).not.toBeNull();
        expect(recovered!.tasks.map((task) => task.task_id).sort()).toEqual(['task-lazy', 'task-unindexed']);
        const rebuiltIds = JSON.parse(fs.readFileSync(taskListFile, 'utf8'))
            .map((entry: { task_id: string }) => entry.task_id)
            .sort();
        expect(rebuiltIds).toEqual(['task-lazy', 'task-unindexed']);
        expect(fs.existsSync(path.join(taskDirectory, 'task-corrupt.json'))).toBe(true);
        expect(fs.readFileSync(indexedTaskFile, 'utf8')).toBe(indexedTaskBeforeRecovery);
        expect(fs.readFileSync(unindexedTaskFile, 'utf8')).toBe(unindexedTaskContent);
        expect(recovered!.tasks.every((task) => task._dirty === false)).toBe(true);
    });

    test('manual recovery skips a task file whose name does not match its internal ID', () => {
        const { taskFile, taskListFile } = persistTaskFixture();
        const mismatchedJson = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
        mismatchedJson.task_id = 'task-other';
        const mismatchedContent = JSON.stringify(mismatchedJson, null, 4);
        fs.writeFileSync(taskFile, mismatchedContent, 'utf8');

        const recovered = TaskManagerState.rebuildTaskListFromDirectory();

        expect(recovered).toBeNull();
        expect(JSON.parse(fs.readFileSync(taskListFile, 'utf8'))).toEqual([]);
        expect(fs.readFileSync(taskFile, 'utf8')).toBe(mismatchedContent);
    });
});
