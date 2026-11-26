import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { OpenAIAdapter } from '../../../main/aikernel/adapters/openai.js';
import { compactFullContext } from '../../../main/aikernel/compaction/full-compact.js';
import {
    AssistantMessage,
    ChatContext,
    FileMessagePart,
    ImageMessagePart,
    ToolCall,
    ToolCallMessagePart,
    UserMessage
} from '../../../main/aikernel/messages.js';
import { TaskState } from '../../../main/aikernel/states/tasks.js';

afterEach(() => jest.restoreAllMocks());

const compactOptions = {
    tailMessageCount: 2,
    tailAssistantToolMessageCount: 0,
    tailAssistantErrorMessageCount: 0,
    tailPlanMessageCount: 0
};
const summary = '<state_snapshot><overall_goal>demo</overall_goal></state_snapshot>';

function createFixture() {
    const context = new ChatContext();
    const user = new UserMessage('user text');
    user.appendPart(new FileMessagePart('/tmp/compact-render.txt', 100));
    user.appendPart(new ImageMessagePart('data:image/png;base64,aGVsbG8='));
    const assistant = new AssistantMessage();
    assistant.appendReasoningContent('reasoning');
    assistant.appendText('assistant **text**');
    assistant.appendError('Error', 'tool failed');
    const toolCall = new ToolCall(0, 'render-tool', 'demo_tool', '{"renderedWorkspace":"original"}');
    toolCall.status = 'success';
    toolCall.result = 'tool result';
    toolCall.result_object = { rendered: 'original' };
    const toolPart = new ToolCallMessagePart();
    toolPart.push(toolCall);
    assistant.appendToolCallPart(toolPart);
    context.appendMessage(user);
    context.appendMessage(assistant);
    for (let index = 0; index < 4; index++) {
        context.appendMessage(new UserMessage(`user ${index}`));
        const reply = new AssistantMessage();
        reply.appendText(`assistant ${index}`);
        context.appendMessage(reply);
    }
    return { context, user, toolCall, toolPart };
}

async function renderTask(context: ChatContext, workspace: string | null = process.cwd()): Promise<void> {
    await TaskState.prototype.render.call({
        chat_context: context,
        getWorkspace: () => workspace
    } as TaskState);
}

describe('full compaction while opening a task', () => {
    test.each([false, true])(
        'rendering completes without cancelling compaction (existing caches: %s)',
        async (warm) => {
            const { context, toolCall } = createFixture();
            if (warm) await renderTask(context, null);
            const before = JSON.stringify(context.messages);
            const modelInput = JSON.stringify(OpenAIAdapter.buildMessages(context, true));
            const result = await compactFullContext(context, undefined, {
                ...compactOptions,
                generateSummary: async () => {
                    await renderTask(context);
                    await toolCall.freezeRenderResult();
                    expect(JSON.stringify(context.messages)).not.toBe(before);
                    expect(JSON.stringify(OpenAIAdapter.buildMessages(context, true))).toBe(modelInput);
                    return summary;
                }
            });
            expect(result.compacted).toBe(true);
            expect(context.findCompactBoundary()?.message.summary).toBe(summary);
        }
    );

    test('an unfinished tool render does not invalidate a previously rendered context', async () => {
        const { context, toolCall, toolPart } = createFixture();
        await renderTask(context);
        const pendingRender = Promise.withResolvers<string>();
        const renderStarted = Promise.withResolvers<void>();
        jest.spyOn(toolCall, 'render').mockImplementation(() => {
            renderStarted.resolve();
            return pendingRender.promise;
        });
        let rendering: Promise<void> | undefined;
        try {
            await expect(
                compactFullContext(context, undefined, {
                    ...compactOptions,
                    generateSummary: async () => {
                        rendering = renderTask(context);
                        await renderStarted.promise;
                        expect(toolPart.rendered).toBe('');
                        return summary;
                    }
                })
            ).resolves.toMatchObject({ compacted: true });
        } finally {
            pendingRender.resolve('<div>tool render complete</div>');
            await rendering;
        }
    });

    const mutations: Array<[string, (fixture: ReturnType<typeof createFixture>) => void]> = [
        ['user text', ({ user }) => user.appendText(' changed')],
        ['tool result', ({ toolCall }) => (toolCall.result = 'changed result')],
        ['tool result data named rendered', ({ toolCall }) => (toolCall.result_object = { rendered: 'changed' })],
        [
            'tool argument data named renderedWorkspace',
            ({ toolCall }) => (toolCall.args_object = { renderedWorkspace: 'changed' })
        ]
    ];

    test.each(mutations)('still cancels compaction after changing %s', async (_name, mutate) => {
        const fixture = createFixture();
        // The structured argument field must already exist so a nested value change is checked.
        fixture.toolCall.args_object = { renderedWorkspace: 'original' };
        await expect(
            compactFullContext(fixture.context, undefined, {
                ...compactOptions,
                generateSummary: async () => {
                    mutate(fixture);
                    return summary;
                }
            })
        ).rejects.toMatchObject({ name: 'ContextPreparationBlockedError', code: 'cancelled' });
        expect(fixture.context.findCompactBoundary()).toBeUndefined();
    });
});
