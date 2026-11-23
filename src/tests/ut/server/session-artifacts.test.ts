import fs from 'fs';
import os from 'os';
import path from 'path';
import { AssistantMessage, ToolCall, ToolCallMessagePart, UserMessage } from '../../../main/aikernel/messages.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import type { TaskTodo } from '../../../main/aikernel/todos/task-todos.js';
import {
    getOpenCodeSessionDiff,
    getTurnMessages,
    toOpenCodeTodos
} from '../../../main/server/opencode/session-artifacts.js';
import '../../../main/applications/filemgr/harness/index.js';

function createTask(): { task: TaskState; workspace: string } {
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-session-artifacts-')));
    const task = new TaskState(new TaskManagerState(), null);
    task.harnessContext.workspace = workspace;
    return { task, workspace };
}

function appendToolCall(task: TaskState, toolName: string, args: Record<string, unknown>): void {
    const toolCall = new ToolCall(0, crypto.randomUUID(), toolName, JSON.stringify(args));
    toolCall.args_object = args;
    toolCall.status = 'success';
    const part = new ToolCallMessagePart();
    part.toolcalls.push(toolCall);
    task.chat_context.appendMessage(new AssistantMessage([part]));
}

function todo(overrides: Partial<TaskTodo>): TaskTodo {
    return {
        id: 'todo-1',
        task_id: 'task-1',
        title: '',
        content: '',
        status: 'pending',
        created_at: '2026-11-23T00:00:00.000Z',
        updated_at: '2026-11-23T00:00:00.000Z',
        ...overrides
    };
}

describe('opencode session artifacts', () => {
    let workspace: string | undefined;

    afterEach(() => {
        if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
        workspace = undefined;
    });

    test('todos map to the opencode Todo shape', () => {
        expect(
            toOpenCodeTodos([
                todo({ title: 'Write tests', content: 'cover the routes', status: 'in_progress' }),
                todo({ content: 'only content', status: 'completed' })
            ])
        ).toEqual([
            { content: 'Write tests', status: 'in_progress', priority: 'medium' },
            { content: 'only content', status: 'completed', priority: 'medium' }
        ]);
    });

    test('session diff reports patches, line counts and added files', () => {
        const created = createTask();
        workspace = created.workspace;
        fs.writeFileSync(path.join(workspace, 'edit.txt'), 'alpha\ngamma\nomega\n');
        fs.writeFileSync(path.join(workspace, 'new.txt'), 'hello\n');
        appendToolCall(created.task, 'filemgr-editFile', {
            filePath: 'edit.txt',
            oldString: 'beta',
            newString: 'gamma'
        });
        appendToolCall(created.task, 'filemgr-writeFile', { filePath: 'new.txt', content: 'hello\n' });

        const diff = getOpenCodeSessionDiff(created.task);

        expect(diff.map(({ file, additions, deletions, status }) => ({ file, additions, deletions, status }))).toEqual([
            { file: 'edit.txt', additions: 1, deletions: 1, status: 'modified' },
            { file: 'new.txt', additions: 1, deletions: 0, status: 'added' }
        ]);
        expect(diff[0].patch).toContain('--- edit.txt');
        expect(diff[0].patch).toContain('+++ edit.txt');
        expect(diff[0].patch).toContain('-beta');
        expect(diff[0].patch).toContain('+gamma');
    });

    test('a turn spans from its user message to the next visible user message', () => {
        const first = new UserMessage('first');
        const internal = new UserMessage('reminder');
        internal.internal = true;
        const reply = new AssistantMessage();
        const second = new UserMessage('second');
        const secondReply = new AssistantMessage();
        const messages = [first, reply, internal, second, secondReply];

        expect(getTurnMessages(messages, (message) => message === first)).toEqual([reply, internal]);
        expect(getTurnMessages(messages, (message) => message === second)).toEqual([secondReply]);
        expect(getTurnMessages(messages, (message) => message === internal)).toBeUndefined();
    });

    test('session diff for one turn only counts that turn', () => {
        const created = createTask();
        workspace = created.workspace;
        fs.writeFileSync(path.join(workspace, 'a.txt'), 'A2\n');
        fs.writeFileSync(path.join(workspace, 'b.txt'), 'B2\n');
        const firstUser = new UserMessage('edit a');
        created.task.chat_context.appendMessage(firstUser);
        appendToolCall(created.task, 'editFile', { filePath: 'a.txt', oldString: 'A1', newString: 'A2' });
        created.task.chat_context.appendMessage(new UserMessage('edit b'));
        appendToolCall(created.task, 'editFile', { filePath: 'b.txt', oldString: 'B1', newString: 'B2' });

        const turn = getTurnMessages(created.task.chat_context.messages, (message) => message === firstUser);
        expect(getOpenCodeSessionDiff(created.task, turn).map((file) => file.file)).toEqual(['a.txt']);
        expect(getOpenCodeSessionDiff(created.task).map((file) => file.file)).toEqual(['a.txt', 'b.txt']);
    });
});
