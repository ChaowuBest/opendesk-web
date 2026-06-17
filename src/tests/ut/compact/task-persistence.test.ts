import fs from 'fs';
import os from 'os';
import path from 'path';
import { setCustomOpendeskDirectory } from '../../../main/utils/setting';
import { AutoCompactStates } from '../../../main/aikernel/compaction/auto-compact';
import { MicrocompactStates } from '../../../main/aikernel/compaction/microcompact-state';
import { SessionMemoryStates } from '../../../main/aikernel/compaction/session-memory-compact';
import { FULL_COMPACT_BOUNDARY_STRATEGY } from '../../../main/aikernel/compaction/full-compact';
import { buildActiveContextView } from '../../../main/aikernel/compaction/context-view';
import {
    AssistantMessage,
    ChatContext,
    CompactSeparatorMessage,
    ToolCall,
    ToolCallMessagePart,
    Usage,
    UserMessage
} from '../../../main/aikernel/messages';
import { BenchmarkUsageLedger } from '../../../main/aikernel/evaluation/index';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks';

let tempRootDir: string | undefined;

function createTempTaskDirectory(): string {
    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-task-persistence-'));
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

    test('task-local file read state stays in memory and is not persisted', () => {
        const taskDir = createTempTaskDirectory();
        const manager = new TaskManagerState();
        const task = createTask(manager);
        manager.tasks.push(task);

        expect(task.getFileReadState().size).toBe(0);

        task.getFileReadState().set('C:/repo/a.ts', {
            content: 'line 1',
            timestamp: 123,
            offset: 1,
            isPartialView: false
        });

        expect(task.getFileReadState().get('C:/repo/a.ts')).toEqual({
            content: 'line 1',
            timestamp: 123,
            offset: 1,
            isPartialView: false
        });

        manager.saveSync();

        const savedTaskJson = JSON.parse(fs.readFileSync(path.join(taskDir, 'task-root.json'), 'utf8'));
        expect(savedTaskJson).not.toHaveProperty('file_read_state');

        const reloadedManager = TaskManagerState.load();
        expect(reloadedManager).not.toBeNull();
        const loadedTask = reloadedManager!.getTask('task-root');
        expect(loadedTask).toBeDefined();
        expect(loadedTask!.getFileReadState().size).toBe(0);
    });

    test('file read state is isolated between tasks and resettable', () => {
        const manager = new TaskManagerState();
        const firstTask = createTask(manager);
        const secondTask = new TaskState(manager, null);
        secondTask.task_id = 'task-second';

        firstTask.getFileReadState().set('C:/repo/a.ts', {
            content: 'first',
            timestamp: 1
        });
        secondTask.getFileReadState().set('C:/repo/a.ts', {
            content: 'second',
            timestamp: 2
        });

        expect(firstTask.getFileReadState().get('C:/repo/a.ts')).toEqual({
            content: 'first',
            timestamp: 1
        });
        expect(secondTask.getFileReadState().get('C:/repo/a.ts')).toEqual({
            content: 'second',
            timestamp: 2
        });

        firstTask.resetFileReadState();

        expect(firstTask.getFileReadState().size).toBe(0);
        expect(secondTask.getFileReadState().get('C:/repo/a.ts')).toEqual({
            content: 'second',
            timestamp: 2
        });
    });

    test('save 和 load 会保留 auto_compact_state', () => {
        const taskDir = createTempTaskDirectory();
        const manager = new TaskManagerState();
        const task = createTask(manager);
        manager.tasks.push(task);

        manager.saveSync();

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

    test('load 会把中断任务里的活动工具调用标记为停止错误', () => {
        const taskDir = createTempTaskDirectory();
        const manager = new TaskManagerState();
        const task = createTask(manager);
        task.task_status = 'running';

        const assistant = new AssistantMessage();
        const toolPart = new ToolCallMessagePart();
        const pendingTool = new ToolCall(0, 'call-pending', 'filemgr-readFile', '{"path":"/etc/master.passwd"}');
        pendingTool.rendered = '<div>old pending render</div>';
        const runningTool = new ToolCall(1, 'call-running', 'skill-manager-CallSkillTool', '{}');
        runningTool.status = 'running';
        runningTool.rendered = '<div>old running render</div>';
        const successTool = new ToolCall(2, 'call-success', 'filemgr-readFile', '{}');
        successTool.status = 'success';
        successTool.result = 'ok';
        toolPart.push(pendingTool);
        toolPart.push(runningTool);
        toolPart.push(successTool);
        toolPart.rendered = '<div>old part render</div>';
        assistant.content.push(toolPart);
        task.chat_context.appendMessage(assistant);
        manager.tasks.push(task);

        manager.saveSync();

        const loadedTask = TaskState.load(path.join(taskDir, 'task-root.json'), new TaskManagerState());
        expect(loadedTask.task_status).toBe('failed');

        const loadedAssistant = loadedTask.chat_context.messages[1] as AssistantMessage;
        const loadedToolPart = loadedAssistant.content[0] as ToolCallMessagePart;
        const [loadedPending, loadedRunning, loadedSuccess] = loadedToolPart.toolcalls;

        expect(loadedPending.status).toBe('error');
        expect(loadedPending.result).toBe('任务已停止');
        expect(loadedPending.result_object).toEqual({ interrupted: true, reason: 'task_stopped' });
        expect(loadedPending.rendered).toBeUndefined();
        expect(loadedRunning.status).toBe('error');
        expect(loadedRunning.result).toBe('任务已停止');
        expect(loadedRunning.rendered).toBeUndefined();
        expect(loadedSuccess.status).toBe('success');
        expect(loadedSuccess.result).toBe('ok');
        expect(loadedToolPart.rendered).toBeUndefined();
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

        manager.saveSync();

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
        expect(loadedTask!.getMicrocompactState()).toEqual(MicrocompactStates.create());
        expect(loadedTask!.getSessionMemoryState()).toEqual(SessionMemoryStates.create());
    });

    test('save 和 load 会保留 session_memory_state，fork 会重置 session memory 状态', () => {
        const taskDir = createTempTaskDirectory();
        const manager = new TaskManagerState();
        const task = createTask(manager);
        const sessionMemoryState = SessionMemoryStates.deserialize({
            version: 2,
            initialized: true,
            relative_path: 'artifacts/task-root/session-memory/session-memory.md',
            last_extracted_at: '2026-04-23T02:00:00.000Z',
            last_summarized_message_id: 'message-session-memory',
            last_summarized_round_index: 2,
            last_summarized_round_start_part_index: 6,
            preferred_language: 'zh-CN',
            tokens_at_last_extraction: 12000,
            extraction_in_progress: false
        });
        task.setSessionMemoryState(sessionMemoryState);
        manager.tasks.push(task);

        manager.saveSync();

        const savedTaskJson = JSON.parse(fs.readFileSync(path.join(taskDir, 'task-root.json'), 'utf8'));
        expect(savedTaskJson.session_memory_state).toMatchObject({
            version: 2,
            initialized: true,
            relative_path: 'artifacts/task-root/session-memory/session-memory.md',
            last_extracted_at: '2026-04-23T02:00:00.000Z',
            last_summarized_message_id: 'message-session-memory',
            last_summarized_round_index: 2,
            last_summarized_round_start_part_index: 6,
            preferred_language: 'zh-CN',
            tokens_at_last_extraction: 12000,
            extraction_in_progress: false
        });

        const reloadedManager = TaskManagerState.load();
        expect(reloadedManager).not.toBeNull();
        const loadedTask = reloadedManager!.getTask('task-root');
        expect(loadedTask).toBeDefined();
        expect(loadedTask!.getSessionMemoryState()).toEqual(sessionMemoryState);

        const forked = loadedTask!.fork();
        expect(forked.getSessionMemoryState()).toEqual(SessionMemoryStates.create());
    });

    test('save 和 load 会保留 microcompact_state，fork / subtask 会重置 microcompact 状态', () => {
        const taskDir = createTempTaskDirectory();
        const manager = new TaskManagerState();
        const task = createTask(manager);
        const microcompactState = MicrocompactStates.deserialize({
            version: 1,
            last_assistant_completed_at: '2026-05-04T01:00:00.000Z',
            last_decision_at: '2026-05-04T01:05:00.000Z',
            last_decision_mode: 'noop',
            last_local_clear_at: '2026-05-04T01:10:00.000Z',
            last_local_clear_result_ids: ['result-a', 'result-b']
        });
        task.setMicrocompactState(microcompactState);
        manager.tasks.push(task);

        manager.saveSync();

        const savedTaskJson = JSON.parse(fs.readFileSync(path.join(taskDir, 'task-root.json'), 'utf8'));
        expect(savedTaskJson.microcompact_state).toMatchObject({
            version: 1,
            last_assistant_completed_at: '2026-05-04T01:00:00.000Z',
            last_decision_at: '2026-05-04T01:05:00.000Z',
            last_decision_mode: 'noop',
            last_local_clear_at: '2026-05-04T01:10:00.000Z',
            last_local_clear_result_ids: ['result-a', 'result-b']
        });

        const reloadedManager = TaskManagerState.load();
        expect(reloadedManager).not.toBeNull();
        const loadedTask = reloadedManager!.getTask('task-root');
        expect(loadedTask).toBeDefined();
        expect(loadedTask!.getMicrocompactState()).toEqual(microcompactState);

        const forked = loadedTask!.fork();
        expect(forked.getMicrocompactState()).toEqual(MicrocompactStates.create());

        const subTask = reloadedManager!.createSubTask(loadedTask!.task_id);
        expect(subTask.getMicrocompactState()).toEqual(MicrocompactStates.create());
    });

    test('save 和 load 会保留 assistant usage 的扩展字段，并归一化为 Usage 实例', () => {
        const taskDir = createTempTaskDirectory();
        const manager = new TaskManagerState();
        const task = createTask(manager);
        const assistant = new AssistantMessage();
        assistant.appendText('assistant with normalized usage');
        assistant.usage = new Usage(100, 20, 120, {
            input_tokens: 90,
            output_tokens: 30,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 5
        });
        task.chat_context = new ChatContext();
        task.chat_context.appendMessage(new UserMessage('seed context'));
        task.chat_context.appendMessage(assistant);
        manager.tasks.push(task);

        manager.saveSync();

        const savedTaskJson = JSON.parse(fs.readFileSync(path.join(taskDir, 'task-root.json'), 'utf8'));
        const savedAssistant = savedTaskJson.chat_context.messages.find(
            (message: { role?: string }) => message.role === 'assistant'
        );
        expect(savedAssistant.usage).toMatchObject({
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            input_tokens: 90,
            output_tokens: 30,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 5
        });

        const reloadedManager = TaskManagerState.load();
        expect(reloadedManager).not.toBeNull();
        const loadedTask = reloadedManager!.getTask('task-root');
        const loadedAssistant = loadedTask!.chat_context.messages[1] as AssistantMessage;

        expect(loadedAssistant.usage).toBeInstanceOf(Usage);
        expect(loadedAssistant.usage).toMatchObject(savedAssistant.usage);
    });

    test('load 兼容旧任务 assistant usage JSON', () => {
        const taskDir = createTempTaskDirectory();
        fs.writeFileSync(
            path.join(taskDir, 'task_list.json'),
            JSON.stringify([{ task_id: 'task-legacy-usage' }], null, 4),
            'utf8'
        );
        fs.writeFileSync(
            path.join(taskDir, 'task-legacy-usage.json'),
            JSON.stringify(
                {
                    task_id: 'task-legacy-usage',
                    parent_id: null,
                    task_name: 'legacy-usage-task',
                    task_status: 'waiting',
                    chat_context: {
                        messages: [
                            {
                                role: 'assistant',
                                message_id: 'assistant-legacy-usage',
                                usage: {
                                    prompt_tokens: 321,
                                    completion_tokens: 45,
                                    total_tokens: 366
                                },
                                content: [{ type: 'text', text: 'legacy assistant usage payload' }]
                            }
                        ]
                    },
                    tool_result_replacement_state: { seen_ids: [], replacements: [] }
                },
                null,
                4
            ),
            'utf8'
        );

        const reloadedManager = TaskManagerState.load();
        expect(reloadedManager).not.toBeNull();
        const loadedTask = reloadedManager!.getTask('task-legacy-usage');
        expect(loadedTask).toBeDefined();

        const loadedAssistant = loadedTask!.chat_context.messages[0] as AssistantMessage;
        expect(loadedAssistant.usage).toBeInstanceOf(Usage);
        expect(loadedAssistant.usage).toMatchObject({
            prompt_tokens: 321,
            completion_tokens: 45,
            total_tokens: 366
        });
        expect(loadedAssistant.usage?.input_tokens).toBeUndefined();
        expect(loadedAssistant.usage?.cache_creation_input_tokens).toBeUndefined();
    });

    test('save compact benchmark_usage metadata, and fork clears it', () => {
        const taskDir = createTempTaskDirectory();
        const manager = new TaskManagerState();
        const task = createTask(manager);
        const ledger = new BenchmarkUsageLedger(task.task_id);
        const requestIndex = ledger.beginRequest({
            turn: 1,
            requestType: 'streamComplete',
            model: 'demo-model',
            provider: 'demo-provider',
            startMs: 1_000
        });
        ledger.recordRetry(requestIndex, 'rate limit');
        ledger.finishRequest(requestIndex, {
            endMs: 1_450,
            usage: {
                prompt_tokens: 11,
                completion_tokens: 7,
                total_tokens: 18,
                input_tokens: 11,
                output_tokens: 7,
                cache_creation_input_tokens: 2,
                cache_read_input_tokens: 3
            }
        });
        task.benchmark_usage = ledger;
        manager.tasks.push(task);

        manager.saveSync();

        const savedTaskJson = JSON.parse(fs.readFileSync(path.join(taskDir, 'task-root.json'), 'utf8'));
        expect(savedTaskJson.benchmark_usage).toMatchObject({
            version: 1,
            task_id: 'task-root',
            task_summary: {
                task_status: 'waiting',
                task_success: false,
                stop_requested_by_user: false,
                request_count: 1,
                retry_count: 1,
                turn_count: 1,
                prompt_tokens: 11,
                completion_tokens: 7,
                total_tokens: 18,
                input_tokens: 11,
                output_tokens: 7,
                cache_creation_input_tokens: 2,
                cache_read_input_tokens: 3
            }
        });
        expect(savedTaskJson.benchmark_usage.task_summary.cached_token_ratio).toBeCloseTo(3 / 11, 10);
        expect(savedTaskJson.benchmark_usage).not.toHaveProperty('requests');
        expect(savedTaskJson.benchmark_usage).not.toHaveProperty('summary');

        const reloadedManager = TaskManagerState.load();
        expect(reloadedManager).not.toBeNull();
        const loadedTask = reloadedManager!.getTask('task-root');
        expect(loadedTask!.benchmark_usage).toBeUndefined();

        const forked = task.fork();
        expect(forked.benchmark_usage).toBeUndefined();

        manager.saveSync();
        const forkedTaskJson = JSON.parse(fs.readFileSync(path.join(taskDir, `${forked.task_id}.json`), 'utf8'));
        expect(forkedTaskJson).not.toHaveProperty('benchmark_usage');
    });

    test('save 和 load 会保留 full compact boundary metadata', () => {
        const taskDir = createTempTaskDirectory();
        const manager = new TaskManagerState();
        const task = createTask(manager);
        const boundary = new CompactSeparatorMessage('saved full compact summary', {
            boundary_id: 'boundary-full-compact',
            created_at: '2026-04-20T08:00:00.000Z',
            previous_boundary_id: 'boundary-previous',
            trigger: 'auto',
            strategy: FULL_COMPACT_BOUNDARY_STRATEGY,
            summarized_range: {
                start_index: 0,
                end_index_exclusive: 6,
                message_count: 6,
                user_messages: 3,
                assistant_messages: 3,
                tool_calls: 1
            },
            kept_range: {
                start_index: 6,
                end_index_exclusive: 8,
                message_count: 2,
                user_messages: 1,
                assistant_messages: 1,
                tool_calls: 0
            },
            kept_messages: 2,
            summarized_messages: 6,
            kept_anchor_message_id: 'assistant-anchor-message',
            kept_anchor_message_index: 6,
            kept_anchor_round_index: 1,
            kept_anchor_start_part_index: 3
        });

        task.chat_context = new ChatContext();
        task.chat_context.appendMessage(new UserMessage('folded raw message'));
        task.chat_context.appendMessage(boundary);
        task.chat_context.appendMessage(new UserMessage('kept user message'));
        manager.tasks.push(task);

        manager.saveSync();

        const savedTaskJson = JSON.parse(fs.readFileSync(path.join(taskDir, 'task-root.json'), 'utf8'));
        const savedBoundary = savedTaskJson.chat_context.messages.find(
            (message: { role?: string }) => message.role === 'compact_separator'
        );
        expect(savedBoundary.metadata).toMatchObject({
            boundary_id: 'boundary-full-compact',
            previous_boundary_id: 'boundary-previous',
            trigger: 'auto',
            strategy: FULL_COMPACT_BOUNDARY_STRATEGY,
            kept_messages: 2,
            summarized_messages: 6,
            kept_anchor_message_id: 'assistant-anchor-message',
            kept_anchor_message_index: 6,
            kept_anchor_round_index: 1,
            kept_anchor_start_part_index: 3,
            summarized_range: {
                start_index: 0,
                end_index_exclusive: 6,
                message_count: 6,
                user_messages: 3,
                assistant_messages: 3,
                tool_calls: 1
            },
            kept_range: {
                start_index: 6,
                end_index_exclusive: 8,
                message_count: 2,
                user_messages: 1,
                assistant_messages: 1,
                tool_calls: 0
            }
        });

        const reloadedManager = TaskManagerState.load();
        expect(reloadedManager).not.toBeNull();
        const loadedTask = reloadedManager!.getTask('task-root');
        expect(loadedTask).toBeDefined();

        const loadedBoundary = loadedTask!.chat_context.findCompactBoundary();
        expect(loadedBoundary?.message.summary).toBe('saved full compact summary');
        expect(loadedBoundary?.message.metadata).toMatchObject(savedBoundary.metadata);
        expect(buildActiveContextView(loadedTask!.chat_context).messages.map((message) => message.role)).toEqual([
            'compact_separator',
            'user'
        ]);
    });
});
