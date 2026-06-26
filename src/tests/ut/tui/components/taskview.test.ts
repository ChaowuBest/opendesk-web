import { jest } from '@jest/globals';
import { TaskView, ToolCallMessagePartView } from '../../../../main/tui/components/taskview';
import { AssistantMessage, ChatContext, UserMessage } from '../../../../main/aikernel/messages';
import type { TaskUpdateChunk, TaskUpdateUserChunk } from '../../../../main/aikernel/states/tasks';

describe('TaskView chunk handling', () => {
    test('skips malformed user chunks without throwing', async () => {
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        const chunk = {
            type: 'user',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 3,
            last_part: undefined
        } as unknown as TaskUpdateUserChunk;

        await expect(taskView.handleChunkUpdate(chunk)).resolves.toBeUndefined();

        expect(taskView.messages).toHaveLength(0);
    });

    test('skips malformed assistant chunks without throwing', async () => {
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        const chunks = [
            {
                type: 'assistant',
                task_id: 'task_1',
                task_status: 'running',
                message_id: 'message_1',
                last_part_index: Number.MAX_SAFE_INTEGER,
                last_part: { type: 'text', text: 'hello' }
            },
            {
                type: 'assistant',
                task_id: 'task_1',
                task_status: 'running',
                message_id: 'message_1',
                last_part_index: 0,
                last_part: undefined
            },
            {
                type: 'assistant_replace',
                task_id: 'task_1',
                task_status: 'running',
                message_id: 'message_1',
                parts: undefined
            },
            {
                type: 'assistant_replace',
                task_id: 'task_1',
                task_status: 'running',
                message_id: 'message_1',
                parts: [undefined, { type: 'text', text: 'kept' }]
            },
            {
                type: 'unknown',
                task_id: 'task_1',
                task_status: 'running'
            }
        ] as unknown as TaskUpdateChunk[];

        for (const chunk of chunks) {
            await expect(taskView.handleChunkUpdate(chunk)).resolves.toBeUndefined();
        }

        expect(taskView.messages).toHaveLength(1);
    });

    test('rebuilds history while skipping malformed message parts', () => {
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        const chatContext = new ChatContext();
        const userMessage = new UserMessage();
        (userMessage as any).content = [undefined, { type: 'text', text: 'visible user' }];
        const assistantMessage = new AssistantMessage();
        (assistantMessage as any).content = [undefined, { type: 'text', text: 'visible assistant' }];
        chatContext.appendMessage(userMessage);
        chatContext.appendMessage(assistantMessage);
        taskView.taskState = {
            task_id: 'task_1',
            chat_context: chatContext
        } as any;

        expect(() => taskView.rebuildFromHistory()).not.toThrow();
        expect(taskView.messages).toHaveLength(2);
    });

    test('renders tool call parts with missing toolcalls as empty output', () => {
        const view = new ToolCallMessagePartView();

        expect(() => view.setToolcalls(undefined as any)).not.toThrow();
        expect(() => view.render(80)).not.toThrow();
    });
});
