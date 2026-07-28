import {
    AssistantMessage,
    ChatContext,
    ToolCall,
    ToolCallMessagePart,
    Usage,
    UserMessage
} from '../../../main/aikernel/messages.js';
import { buildTurnInput, buildTurnOutput, findTurnStartIndex } from '../../../main/telemetry/langfuse/task-format.js';

describe('Langfuse task turn formatting', () => {
    test('uses the latest user message as the global task turn input', () => {
        const context = new ChatContext();
        context.appendMessage(new UserMessage('first turn'));
        context.appendMessage(new AssistantMessage());
        context.appendMessage(new UserMessage('latest turn'));
        context.appendMessage(new AssistantMessage());

        expect(buildTurnInput(context)).toEqual({
            role: 'user',
            content: [{ type: 'text', text: 'latest turn' }]
        });
    });

    test('collects every assistant message, part and usage value produced by the turn', () => {
        const context = new ChatContext();
        context.appendMessage(new UserMessage('previous turn'));
        const previousAssistant = new AssistantMessage();
        previousAssistant.appendText('previous answer');
        context.appendMessage(previousAssistant);
        context.appendMessage(new UserMessage('hello'));
        const firstAssistant = new AssistantMessage();
        firstAssistant.appendReasoningContent('checking', 'reasoning_content');
        const toolPart = new ToolCallMessagePart();
        const toolCall = new ToolCall(0, 'call-1', 'project-search', '{"query":"hello"}');
        toolCall.args_object = { query: 'hello' };
        toolCall.status = 'success';
        toolCall.result = 'match';
        toolPart.toolcalls.push(toolCall);
        firstAssistant.content.push(toolPart);
        firstAssistant.usage = new Usage(10, 2, 12, {
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 1
        });
        context.appendMessage(firstAssistant);
        const finalAssistant = new AssistantMessage();
        finalAssistant.appendText('hello back');
        finalAssistant.usage = new Usage(20, 5, 25);
        context.appendMessage(finalAssistant);

        const startMessageIndex = findTurnStartIndex(context);
        const result = buildTurnOutput(context, {
            startMessageIndex,
            taskID: 'task-1',
            sessionID: 'ses-1',
            workspace: '/workspace',
            providerID: 'openai',
            modelID: 'gpt-4o',
            completedAt: 123
        });

        expect(result.output).toMatchObject({
            info: {
                id: finalAssistant.message_id,
                sessionID: 'ses-1',
                role: 'assistant',
                time: { created: 123, completed: 123 },
                parentID: expect.any(String),
                providerID: 'openai',
                modelID: 'gpt-4o',
                mode: 'default',
                agent: 'explore',
                path: { cwd: '/workspace', root: '/workspace' },
                cost: 0,
                tokens: {
                    input: 30,
                    output: 7,
                    cache: { read: 3, write: 1 }
                }
            }
        });
        expect(result.output.parts).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ type: 'reasoning', text: 'checking' }),
                expect.objectContaining({
                    type: 'tool',
                    callID: 'call-1',
                    tool: 'project-search',
                    state: expect.objectContaining({
                        status: 'completed',
                        input: { query: 'hello' },
                        output: 'match'
                    })
                }),
                expect.objectContaining({ type: 'text', text: 'hello back' })
            ])
        );
        expect(result.output.parts).not.toContainEqual(expect.objectContaining({ text: 'previous answer' }));
        expect(result.usageDetails).toEqual({
            promptTokens: 30,
            completionTokens: 7,
            totalTokens: 37,
            cacheReadInputTokens: 3,
            cacheCreationInputTokens: 1
        });
    });

    test('marks an assistant error for the task turn result', () => {
        const context = new ChatContext();
        const assistant = new AssistantMessage();
        assistant.appendError('Stream Completion Failed', 'network unavailable');
        context.appendMessage(assistant);

        const result = buildTurnOutput(context);
        expect(result.output.parts).toContainEqual(
            expect.objectContaining({
                type: 'text',
                text: 'Error: Stream Completion Failed: network unavailable'
            })
        );
        expect(result.error).toBe('Stream Completion Failed: network unavailable');
    });
});
