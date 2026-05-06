import fs from 'fs';
import os from 'os';
import path from 'path';
import { FULL_COMPACT_BOUNDARY_STRATEGY } from '../../../main/aikernel/compaction/full-compact';
import { buildActiveContextView } from '../../../main/aikernel/compaction/context-view';
import { MicrocompactStates } from '../../../main/aikernel/compaction/microcompact-state';
import { ToolResultReplacementStates } from '../../../main/aikernel/compaction/tool-results';
import { ChatContext, CompactSeparatorMessage, UserMessage } from '../../../main/aikernel/messages';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks';
import { setCustomAppDirectory } from '../../../main/utils/setting';

let tempRootDir: string | undefined;

function createTempTaskDirectory(): void {
    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-task-json-smoke-'));
    setCustomAppDirectory(tempRootDir);
    fs.mkdirSync(path.join(tempRootDir, 'tasks'), { recursive: true });
}

function cleanupTempTaskDirectory(): void {
    if (tempRootDir && fs.existsSync(tempRootDir)) {
        fs.rmSync(tempRootDir, { recursive: true, force: true });
    }
    tempRootDir = undefined;
}

describe('compact smoke: task JSON persistence', () => {
    afterEach(() => {
        cleanupTempTaskDirectory();
    });

    test('保存和加载后仍能从 compact boundary 重建 active context', () => {
        createTempTaskDirectory();
        const manager = new TaskManagerState();
        const task = new TaskState(manager, null);
        task.task_id = 'task-json-smoke';
        task.task_name = 'compact persistence smoke';
        task.task_status = 'waiting';
        task.chat_context = new ChatContext();
        task.chat_context.appendMessage(new UserMessage('raw history before boundary'));
        task.chat_context.appendMessage(
            new CompactSeparatorMessage('persisted compact summary', {
                boundary_id: 'boundary-json-smoke',
                created_at: '2026-04-20T00:00:00.000Z',
                trigger: 'manual',
                strategy: FULL_COMPACT_BOUNDARY_STRATEGY,
                summarized_messages: 4,
                kept_messages: 1,
                kept_anchor_message_id: 'assistant-anchor-json-smoke',
                kept_anchor_message_index: 5,
                kept_anchor_round_index: 2,
                kept_anchor_start_part_index: 4
            })
        );
        task.chat_context.appendMessage(new UserMessage('kept tail after reload'));
        task.tool_result_replacement_state = ToolResultReplacementStates.deserialize({
            seen_ids: ['result-json-smoke'],
            replacements: [
                {
                    result_id: 'result-json-smoke',
                    replacement_text: 'stored replacement text',
                    relative_path: 'artifacts/task-json-smoke/tool-results/result-json-smoke.txt'
                }
            ]
        });
        manager.tasks.push(task);

        manager.saveSync();

        const reloadedManager = TaskManagerState.load();
        const reloadedTask = reloadedManager?.getTask('task-json-smoke');
        expect(reloadedTask).toBeDefined();
        expect(reloadedTask!.chat_context.findCompactBoundary()?.message.metadata).toMatchObject({
            boundary_id: 'boundary-json-smoke',
            trigger: 'manual',
            strategy: FULL_COMPACT_BOUNDARY_STRATEGY,
            summarized_messages: 4,
            kept_messages: 1,
            kept_anchor_message_id: 'assistant-anchor-json-smoke',
            kept_anchor_message_index: 5,
            kept_anchor_round_index: 2,
            kept_anchor_start_part_index: 4
        });
        expect(buildActiveContextView(reloadedTask!.chat_context).messages.map((message) => message.role)).toEqual([
            'compact_separator',
            'user'
        ]);

        const serializedState = ToolResultReplacementStates.serialize(reloadedTask!.tool_result_replacement_state);
        expect(serializedState).toEqual({
            seen_ids: ['result-json-smoke'],
            replacements: [
                {
                    result_id: 'result-json-smoke',
                    replacement_text: 'stored replacement text',
                    relative_path: 'artifacts/task-json-smoke/tool-results/result-json-smoke.txt'
                }
            ]
        });
    });

    test('task JSON 会保存 microcompact_state，且旧 JSON 缺少该字段时仍兼容加载', () => {
        createTempTaskDirectory();
        const manager = new TaskManagerState();
        const task = new TaskState(manager, null);
        task.task_id = 'task-json-microcompact';
        task.task_name = 'microcompact persistence smoke';
        task.chat_context = new ChatContext();
        task.chat_context.appendMessage(new UserMessage('persist microcompact state'));
        task.setMicrocompactState(
            MicrocompactStates.deserialize({
                version: 1,
                last_assistant_completed_at: '2026-05-04T00:00:00.000Z',
                last_decision_at: '2026-05-04T00:05:00.000Z',
                last_decision_mode: 'noop',
                last_local_clear_at: '2026-05-04T00:10:00.000Z',
                last_local_clear_result_ids: ['result-alpha', 'result-beta']
            })
        );
        manager.tasks.push(task);

        manager.saveSync();

        const savedTaskJson = JSON.parse(
            fs.readFileSync(path.join(tempRootDir!, 'tasks', 'task-json-microcompact.json'), 'utf8')
        );
        expect(savedTaskJson.microcompact_state).toMatchObject({
            version: 1,
            last_assistant_completed_at: '2026-05-04T00:00:00.000Z',
            last_decision_at: '2026-05-04T00:05:00.000Z',
            last_decision_mode: 'noop',
            last_local_clear_at: '2026-05-04T00:10:00.000Z',
            last_local_clear_result_ids: ['result-alpha', 'result-beta']
        });

        const reloadedManager = TaskManagerState.load();
        const reloadedTask = reloadedManager?.getTask('task-json-microcompact');
        expect(reloadedTask).toBeDefined();
        expect(reloadedTask!.getMicrocompactState()).toEqual(task.getMicrocompactState());

        fs.writeFileSync(
            path.join(tempRootDir!, 'tasks', 'task-list-legacy.json'),
            JSON.stringify([{ task_id: 'task-json-legacy-no-microcompact' }], null, 4),
            'utf8'
        );
        fs.writeFileSync(
            path.join(tempRootDir!, 'tasks', 'task-json-legacy-no-microcompact.json'),
            JSON.stringify(
                {
                    task_id: 'task-json-legacy-no-microcompact',
                    parent_id: null,
                    task_name: 'legacy task',
                    task_status: 'waiting',
                    chat_context: { messages: [] },
                    tool_result_replacement_state: { seen_ids: [], replacements: [] }
                },
                null,
                4
            ),
            'utf8'
        );

        const legacyTask = TaskState.load(
            path.join(tempRootDir!, 'tasks', 'task-json-legacy-no-microcompact.json'),
            new TaskManagerState()
        );
        expect(legacyTask.getMicrocompactState()).toEqual(MicrocompactStates.create());
    });
});
