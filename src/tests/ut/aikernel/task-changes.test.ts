import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import { AssistantMessage, ToolCall, ToolCallMessagePart, UserMessage } from '../../../main/aikernel/messages.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import '../../../main/applications/filemgr/harness/index.js';

function createTaskWithWorkspace(): { task: TaskState; workspace: string } {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-task-changes-'));
    const task = new TaskState(new TaskManagerState(), null);
    task.harnessContext.workspace = workspace;
    return { task, workspace };
}

function appendSuccessfulToolCall(task: TaskState, toolName: string, args: Record<string, unknown>): void {
    const toolCall = new ToolCall(0, crypto.randomUUID(), toolName, JSON.stringify(args));
    toolCall.args_object = args;
    toolCall.status = 'success';

    const part = new ToolCallMessagePart();
    part.toolcalls.push(toolCall);
    task.chat_context.appendMessage(new AssistantMessage([part]));
}

describe('TaskState.getTaskChanges()', () => {
    let workspace: string | undefined;

    afterEach(() => {
        if (workspace && fs.existsSync(workspace)) {
            fs.rmSync(workspace, { recursive: true, force: true });
        }
        workspace = undefined;
    });

    test('filters out a file when later edits restore the original content', () => {
        const created = createTaskWithWorkspace();
        const task = created.task;
        workspace = created.workspace;
        const filePath = path.join(workspace, 'sample.txt');
        fs.writeFileSync(filePath, 'alpha\nbeta\nomega\n', 'utf8');

        appendSuccessfulToolCall(task, 'editFile', {
            filePath: 'sample.txt',
            oldString: 'beta',
            newString: 'gamma'
        });
        appendSuccessfulToolCall(task, 'editFile', {
            filePath: 'sample.txt',
            oldString: 'gamma',
            newString: 'beta'
        });

        const changes = task.getTaskChanges();

        expect(changes.files).toHaveLength(0);
        expect(changes.totalFiles).toBe(0);
        expect(changes.totalAdded).toBe(0);
        expect(changes.totalRemoved).toBe(0);
    });

    test('returns one cumulative diff for multiple edits to the same file', () => {
        const created = createTaskWithWorkspace();
        const task = created.task;
        workspace = created.workspace;
        const filePath = path.join(workspace, 'sample.txt');
        fs.writeFileSync(filePath, 'alpha\ndelta\nomega\n', 'utf8');

        appendSuccessfulToolCall(task, 'editFile', {
            filePath: 'sample.txt',
            oldString: 'beta',
            newString: 'gamma'
        });
        appendSuccessfulToolCall(task, 'editFile', {
            filePath: 'sample.txt',
            oldString: 'gamma',
            newString: 'delta'
        });

        const changes = task.getTaskChanges();

        expect(changes.files).toHaveLength(1);
        expect(changes.files[0].changes).toHaveLength(1);
        expect(changes.files[0].changes[0].toolName).toBe('cumulative');
        expect(changes.files[0].totalAdded).toBe(1);
        expect(changes.files[0].totalRemoved).toBe(1);

        const diffLines = changes.files[0].changes[0].hunks.flatMap((hunk) => hunk.lines);
        expect(diffLines).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ type: 'removed', content: 'beta' }),
                expect.objectContaining({ type: 'added', content: 'delta' })
            ])
        );
    });

    test('does not expose per-tool change blocks when cumulative reconstruction falls back', () => {
        const created = createTaskWithWorkspace();
        const task = created.task;
        workspace = created.workspace;

        appendSuccessfulToolCall(task, 'editFile', {
            filePath: 'missing.txt',
            oldString: 'alpha',
            newString: 'beta'
        });
        appendSuccessfulToolCall(task, 'searchReplace', {
            filePath: 'missing.txt',
            oldString: 'gamma',
            newString: 'delta'
        });

        const changes = task.getTaskChanges();

        expect(changes.files).toHaveLength(1);
        expect(changes.files[0].changes).toHaveLength(1);
        expect(changes.files[0].changes[0].toolName).toBe('cumulative');
        expect(changes.files[0].changes[0].addedLines).toBe(2);
        expect(changes.files[0].changes[0].removedLines).toBe(2);
    });

    test('stringifies non-string paths from historical tool calls', () => {
        const created = createTaskWithWorkspace();
        const task = created.task;
        workspace = created.workspace;

        appendSuccessfulToolCall(task, 'writeFile', {
            path: 42,
            content: 'content\n'
        });

        const changes = task.getTaskChanges();

        expect(changes.files).toHaveLength(1);
        expect(changes.files[0].filePath).toBe('42');
    });
});

describe('TaskState.rewindToUserMessage()', () => {
    test('removes the selected user message and everything after it', async () => {
        const manager = new TaskManagerState();
        manager.save = jest.fn();
        manager.publishTaskListUpdate = jest.fn();
        const task = new TaskState(manager, null);
        const firstUser = new UserMessage('first');
        const secondUser = new UserMessage('second');

        task.chat_context.appendMessage(firstUser);
        task.chat_context.appendMessage(new AssistantMessage());
        task.chat_context.appendMessage(secondUser);
        task.chat_context.appendMessage(new AssistantMessage());

        const result = await task.rewindToUserMessage(secondUser.message_id);

        expect(result).toEqual({ removedCount: 2, resubmitted: false, userMessageText: 'second' });
        expect(task.chat_context.messages).toHaveLength(2);
        expect(task.chat_context.messages[0]).toBe(firstUser);
        expect(task.chat_context.messages[1].role).toBe('assistant');
        expect(manager.save).toHaveBeenCalled();
        expect(manager.publishTaskListUpdate).toHaveBeenCalled();
    });

    test('can resubmit the selected user message after rewinding', async () => {
        const manager = new TaskManagerState();
        manager.save = jest.fn();
        manager.publishTaskListUpdate = jest.fn();
        const task = new TaskState(manager, null);
        const user = new UserMessage('continue from here');
        user.rawText = '/skill original prompt';
        task.chat_context.appendMessage(user);
        task.chat_context.appendMessage(new AssistantMessage());
        const submit = jest.spyOn(task, 'submitUserMessage').mockResolvedValue(undefined);

        const result = await task.rewindToUserMessage(user.message_id, { resubmit: true });

        expect(result).toEqual({ removedCount: 2, resubmitted: true, userMessageText: '/skill original prompt' });
        expect(task.chat_context.messages).toHaveLength(0);
        expect(submit).toHaveBeenCalledWith('/skill original prompt', { imageDataUris: [] });
    });

    test('clears file read state cache so re-reads are not skipped after rewind', async () => {
        const manager = new TaskManagerState();
        manager.save = jest.fn();
        manager.publishTaskListUpdate = jest.fn();
        const task = new TaskState(manager, null);
        const user = new UserMessage('read a file');
        task.chat_context.appendMessage(user);
        task.chat_context.appendMessage(new AssistantMessage());

        // Simulate a file read that populated the cache
        task.getFileReadState().set('/tmp/example.txt', {
            content: 'hello',
            timestamp: Date.now(),
            offset: 1,
            isPartialView: false
        });
        expect(task.getFileReadState().size).toBe(1);

        await task.rewindToUserMessage(user.message_id);

        expect(task.getFileReadState().size).toBe(0);
    });
});
