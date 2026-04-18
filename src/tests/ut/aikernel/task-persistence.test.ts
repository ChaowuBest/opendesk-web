import fs from 'fs';
import os from 'os';
import path from 'path';
import { setCustomAppDirectory } from '../../../main/utils/setting';
import { AutoCompactStates } from '../../../main/aikernel/compaction/auto-compact';
import { ChatContext, UserMessage } from '../../../main/aikernel/messages';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks';

let tempRootDir: string | undefined;

function createTempTaskDirectory(): string {
    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-task-persistence-'));
    setCustomAppDirectory(tempRootDir);
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

function createTask(manager: TaskManagerState): TaskState {
    const task = new TaskState(manager, null);
    task.task_id = 'task-root';
    task.task_name = 'root-task';
    task.task_status = 'waiting';
    task.model = 'demo-model';
    task.started_at = new Date('2026-04-17T02:00:00.000Z');
    task.finished_at = new Date('2026-04-17T02:05:00.000Z');
    task.total_elapsed_ms = 300000;
    task.bookmark_path = 'bookmarks/root.json';
    task.chat_context = new ChatContext();
    task.chat_context.appendMessage(new UserMessage('seed context'));
    task.setAutoCompactState(
        AutoCompactStates.deserialize({
            consecutive_failures: 2,
            last_attempt_at: '2026-04-17T02:01:00.000Z',
            last_failure_at: '2026-04-17T02:01:00.000Z',
            cooldown_until: '2026-04-17T02:11:00.000Z',
            failure_threshold: 3,
            cooldown_ms: 600000,
            last_failure_reason: 'compact failed'
        })
    );
    return task;
}

describe('任务持久化中的自动压缩状态', () => {
    afterEach(() => {
        cleanupTempTaskDirectory();
    });

    test('save 和 load 会保留 auto_compact_state', () => {
        const taskDir = createTempTaskDirectory();
        const manager = new TaskManagerState();
        const task = createTask(manager);
        manager.tasks.push(task);

        manager.save();

        const savedTaskJson = JSON.parse(fs.readFileSync(path.join(taskDir, 'task-root.json'), 'utf8'));
        expect(savedTaskJson.auto_compact_state).toMatchObject({
            consecutive_failures: 2,
            last_attempt_at: '2026-04-17T02:01:00.000Z',
            last_failure_at: '2026-04-17T02:01:00.000Z',
            cooldown_until: '2026-04-17T02:11:00.000Z',
            failure_threshold: 3,
            cooldown_ms: 600000,
            last_failure_reason: 'compact failed'
        });
        expect(savedTaskJson.auto_compact_state).not.toHaveProperty('last_success_at');

        const reloadedManager = TaskManagerState.load();
        expect(reloadedManager).not.toBeNull();
        expect(reloadedManager!.tasks).toHaveLength(1);

        const loadedTask = reloadedManager!.getTask('task-root');
        expect(loadedTask).toBeDefined();
        expect(loadedTask!.getAutoCompactState()).toEqual(task.getAutoCompactState());
        expect(loadedTask!.task_name).toBe('root-task');
        expect(loadedTask!.started_at?.toISOString()).toBe('2026-04-17T02:00:00.000Z');
        expect(loadedTask!.finished_at?.toISOString()).toBe('2026-04-17T02:05:00.000Z');
        expect(loadedTask!.bookmark_path).toBe('bookmarks/root.json');
        expect(loadedTask!.chat_context.messages).toHaveLength(1);
    });

    test('fork 会复制自动压缩状态，且父子任务彼此独立', () => {
        createTempTaskDirectory();
        const manager = new TaskManagerState();
        const task = createTask(manager);
        manager.tasks.push(task);

        const forked = task.fork();
        const forkedTaskId = forked.task_id;

        expect(manager.tasks).toHaveLength(2);
        expect(forked.parent_id).toBeNull();
        expect(forked.task_name).toBe('root-task-fork');
        expect(forked.getAutoCompactState()).toEqual(task.getAutoCompactState());

        forked.recordAutoCompactFailure('forked task failed', new Date('2026-04-17T02:12:00.000Z'));

        expect(task.getAutoCompactState().consecutiveFailures).toBe(2);
        expect(forked.getAutoCompactState().consecutiveFailures).toBe(3);
        expect(task.getAutoCompactState().lastFailureReason).toBe('compact failed');
        expect(forked.getAutoCompactState().lastFailureReason).toBe('forked task failed');

        manager.save();

        const reloadedManager = TaskManagerState.load();
        expect(reloadedManager).not.toBeNull();
        expect(reloadedManager!.tasks).toHaveLength(2);

        const reloadedParent = reloadedManager!.getTask('task-root');
        const reloadedFork = reloadedManager!.getTask(forkedTaskId);

        expect(reloadedParent).toBeDefined();
        expect(reloadedFork).toBeDefined();
        expect(reloadedParent!.getAutoCompactState()).toEqual(task.getAutoCompactState());
        expect(reloadedFork!.getAutoCompactState()).toEqual(forked.getAutoCompactState());
    });

    test('load 兼容旧字段 autoCompactState', () => {
        const taskDir = createTempTaskDirectory();
        const legacyState = AutoCompactStates.deserialize({
            consecutive_failures: 4,
            last_attempt_at: '2026-04-17T02:10:00.000Z',
            last_failure_at: '2026-04-17T02:10:00.000Z',
            cooldown_until: '2026-04-17T02:20:00.000Z',
            failure_threshold: 4,
            cooldown_ms: 600000,
            last_failure_reason: 'legacy compact failure'
        });

        fs.writeFileSync(
            path.join(taskDir, 'task_list.json'),
            JSON.stringify([{ task_id: 'task-legacy' }], null, 4),
            'utf8'
        );
        fs.writeFileSync(
            path.join(taskDir, 'task-legacy.json'),
            JSON.stringify(
                {
                    task_id: 'task-legacy',
                    parent_id: null,
                    task_name: 'legacy-task',
                    task_status: 'waiting',
                    chat_context: { messages: [] },
                    tool_result_replacement_state: { seen_ids: [], replacements: [] },
                    autoCompactState: {
                        consecutive_failures: 4,
                        last_attempt_at: '2026-04-17T02:10:00.000Z',
                        last_failure_at: '2026-04-17T02:10:00.000Z',
                        cooldown_until: '2026-04-17T02:20:00.000Z',
                        failure_threshold: 4,
                        cooldown_ms: 600000,
                        last_failure_reason: 'legacy compact failure'
                    }
                },
                null,
                4
            ),
            'utf8'
        );

        const reloadedManager = TaskManagerState.load();
        expect(reloadedManager).not.toBeNull();
        const loadedTask = reloadedManager!.getTask('task-legacy');
        expect(loadedTask).toBeDefined();
        expect(loadedTask!.getAutoCompactState()).toEqual(legacyState);
        expect(loadedTask!.getAutoCompactState().cooldownUntil).toBe('2026-04-17T02:20:00.000Z');
        expect(loadedTask!.getAutoCompactState().lastFailureReason).toBe('legacy compact failure');
    });
});
