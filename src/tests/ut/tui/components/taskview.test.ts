import { jest } from '@jest/globals';
import { ReasoningMessagePartView, TaskView, ToolCallMessagePartView } from '../../../../main/tui/components/taskview';
import { AssistantMessage, ChatContext, UserMessage } from '../../../../main/aikernel/messages';
import type {
    TaskUpdateChunk,
    TaskUpdateGoalEvalChunk,
    TaskUpdateUserChunk
} from '../../../../main/aikernel/states/tasks';

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

    test('routes goal evaluation updates to the panel without adding a message card', async () => {
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        const onGoalEvalUpdate = jest.fn();
        taskView.onGoalEvalUpdate = onGoalEvalUpdate;
        const chunk: TaskUpdateGoalEvalChunk = {
            type: 'goal_eval',
            task_id: 'task_1',
            task_status: 'running',
            phase: 'start',
            evaluationId: 'eval_1',
            startedAt: '2026-01-01T00:00:00.000Z'
        };

        await taskView.handleChunkUpdate(chunk);

        expect(onGoalEvalUpdate).toHaveBeenCalledWith(chunk);
        expect(taskView.messages).toHaveLength(0);
    });

    test('removes pending goal edit when the matching internal reminder materializes', async () => {
        const taskView = new TaskView({ requestRender: jest.fn() } as any);
        taskView.showPendingGoalEdit('edit', 'replacement goal', 'goal-1');

        expect(taskView.messages).toHaveLength(1);

        await taskView.handleChunkUpdate({
            type: 'user',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 0,
            last_part: { type: 'text', text: 'hidden reminder' },
            internal: true,
            metadata: {
                origin: { source: 'internal', reason: 'goal_edit' },
                execution: { controllerId: 'goal-1' }
            }
        } as any);

        expect(taskView.messages).toHaveLength(1);
        expect((taskView as any).pendingGoalEditView).toBeNull();
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

    test('assistant_replace can rebase an existing text part to reasoning', async () => {
        const taskView = new TaskView({ requestRender: jest.fn() } as any);

        await taskView.handleChunkUpdate({
            type: 'assistant',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            last_part_index: 0,
            provisional: 'implicit_think_close_candidate',
            last_part: { type: 'text', text: 'hidden' }
        } as any);
        await taskView.handleChunkUpdate({
            type: 'assistant_replace',
            task_id: 'task_1',
            task_status: 'running',
            message_id: 'message_1',
            parts: [
                { type: 'reasoning', content: 'hidden' },
                { type: 'text', text: 'visible' }
            ]
        } as any);

        const assistantView = taskView.messages[0] as any;
        expect(assistantView.parts).toHaveLength(2);
        expect(assistantView.parts[0]).toBeInstanceOf(ReasoningMessagePartView);
    });
});
