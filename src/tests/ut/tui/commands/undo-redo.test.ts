import { jest } from '@jest/globals';
import { SlashCommandRegistry } from '../../../../main/tui/commands/base';
import { registerRedoCommand } from '../../../../main/tui/commands/redo';
import { registerUndoCommand } from '../../../../main/tui/commands/undo';
import { UndoOverlay, getUndoableUserMessages } from '../../../../main/tui/components/undo';
import { AssistantMessage, UserMessage } from '../../../../main/aikernel/messages';
import { TaskManagerState, TaskState } from '../../../../main/aikernel/states/tasks';
import { setRuntimeLocale } from '../../../../locale/index';

function createTask(taskId = 'task-undo-redo'): TaskState {
    const manager = new TaskManagerState();
    manager.save = jest.fn();
    manager.publishTaskListUpdate = jest.fn();
    manager.moveTaskToEnd = jest.fn();
    const task = new TaskState(manager);
    task.task_id = taskId;
    manager.tasks.push(task);
    return task;
}

function addRound(task: TaskState, text: string): UserMessage {
    const user = new UserMessage(text);
    task.chat_context.messages.push(user);
    task.chat_context.messages.push(new AssistantMessage());
    return user;
}

function createTui(task = createTask()) {
    const registry = new SlashCommandRegistry();
    let inputText = '';
    const tui = {
        commandRegistry: registry,
        activeTaskId: task.task_id,
        taskManagerState: task.task_manager_state,
        undoStacks: new Map(),
        taskView: {
            clearMessages: jest.fn(),
            rebuildFromHistory: jest.fn()
        },
        inputArea: {
            showPromptWidget: jest.fn(),
            input: {
                getText: jest.fn(() => inputText),
                setText: jest.fn((text: string) => {
                    inputText = text;
                })
            }
        },
        tui: {
            terminal: { rows: 32 },
            requestRender: jest.fn(),
            setFocus: jest.fn()
        },
        closeInputPrompt: jest.fn(() => null),
        focusAfterInputPromptClose: jest.fn(),
        focusInputAreaIfAvailable: jest.fn(),
        deferInputPromptIfBlockedByMode: jest.fn(() => false),
        followRunningTask: jest.fn(),
        hasOpenOverlay: false
    } as any;
    return { tui, registry, task };
}

describe('/undo and /redo commands', () => {
    beforeEach(() => {
        setRuntimeLocale('en-US');
    });

    afterEach(() => {
        setRuntimeLocale(null);
        jest.restoreAllMocks();
    });

    test('/undo opens the message picker in chronological order and selects the latest message', async () => {
        const { tui, registry, task } = createTui();
        addRound(task, 'first');
        addRound(task, 'second');
        registerUndoCommand(tui);

        expect(registry.get('undo')?.getArgumentCompletions?.('')).toEqual([]);
        expect(await registry.execute('/undo 2')).toBe(true);

        expect(task.chat_context.messages).toHaveLength(4);
        expect(tui.inputArea.showPromptWidget).toHaveBeenCalledWith(expect.any(UndoOverlay));
        expect(tui.tui.setFocus).toHaveBeenCalledWith(expect.any(UndoOverlay));

        const overlay = tui.inputArea.showPromptWidget.mock.calls[0][0] as any;
        expect(overlay.table.innerRows.map((row: any) => row.labels[1])).toEqual(['first', 'second']);
        expect(overlay.table.innerList.selectedIndex).toBe(1);
        expect(overlay.table.innerList.getSelectedItem()?.labels[1]).toBe('second');
    });

    test('undo picker excludes internal user messages', () => {
        const task = createTask();
        const visible = addRound(task, 'visible');
        const internal = new UserMessage('internal');
        internal.internal = true;
        task.chat_context.messages.push(internal);

        expect(getUndoableUserMessages(task).map((entry) => entry.message)).toEqual([visible]);
    });

    test('rewinding from the picker stores a redo snapshot and restores the selected message to input', async () => {
        const { tui, task } = createTui();
        addRound(task, 'first');
        const second = addRound(task, 'second');
        const overlay = new UndoOverlay(tui, task);

        await (overlay as any).execute(second.message_id);

        expect(task.chat_context.messages).toHaveLength(2);
        expect(tui.undoStacks.get(task.task_id)?.at(-1)).toHaveLength(2);
        expect(tui.inputArea.input.setText).toHaveBeenCalledWith('second');
        expect(tui.focusInputAreaIfAvailable).toHaveBeenCalled();
        expect(tui.followRunningTask).toHaveBeenCalledWith(task);
    });

    test('/redo restores the most recent undo snapshot and clears the unedited restored input', async () => {
        const { tui, registry, task } = createTui();
        addRound(task, 'first');
        const secondUser = new UserMessage('second');
        const secondAssistant = new AssistantMessage();
        tui.undoStacks.set(task.task_id, [[secondUser, secondAssistant]]);
        tui.inputArea.input.setText('second');
        jest.clearAllMocks();
        registerRedoCommand(tui);

        expect(registry.get('redo')?.getArgumentCompletions?.('')).toEqual([]);
        expect(await registry.execute('/redo 99')).toBe(true);

        expect(task.chat_context.messages.at(-2)).toBe(secondUser);
        expect(task.chat_context.messages.at(-1)).toBe(secondAssistant);
        expect(tui.inputArea.input.setText).toHaveBeenCalledWith('');
        expect(tui.taskView.clearMessages).toHaveBeenCalled();
        expect(tui.taskView.rebuildFromHistory).toHaveBeenCalled();
    });
});
