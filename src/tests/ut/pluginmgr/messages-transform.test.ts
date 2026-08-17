import { OpenAIAdapter } from '../../../main/aikernel/adapters/openai.js';
import { buildActiveContextView } from '../../../main/aikernel/compaction/context-view.js';
import {
    AssistantMessage,
    ChatContext,
    CompactSeparatorMessage,
    ToolCall,
    ToolCallMessagePart,
    UserMessage
} from '../../../main/aikernel/messages.js';
import { definePlugin } from '../../../../packages/plugin/src/index.js';
import { getPluginHost } from '../../../main/applications/pluginmgr/runtime/host.js';
import { runPluginChatMessagesTransform } from '../../../main/applications/pluginmgr/runtime/hooks.js';
import { buildRequestChatContext } from '../../../main/aikernel/adapters/context.js';
import { BaseToolset } from '../../../main/aikernel/tool.js';

function appendToolRound(message: AssistantMessage, label: string, result: string): ToolCall {
    message.appendReasoningContent(`reasoning ${label}`);
    message.appendText(`answer ${label}`);
    const toolCall = new ToolCall(0, `call-${label}`, 'demo_tool', `{"round":"${label}"}`);
    toolCall.status = 'success';
    toolCall.result = result;
    const part = new ToolCallMessagePart();
    part.push(toolCall);
    message.appendToolCallPart(part);
    return toolCall;
}

describe('chat.messages.transform request view', () => {
    beforeEach(async () => {
        await getPluginHost().dispose();
    });

    afterEach(async () => {
        await getPluginHost().dispose();
    });

    test('transforms only the active request context and reaches the provider payload', async () => {
        let pluginMessages = '';
        await getPluginHost().activate(
            definePlugin({
                id: 'active-context-transform',
                setup(ctx) {
                    ctx.hooks.on('chat.messages.transform', (_input, output) => {
                        pluginMessages = JSON.stringify(output.messages);
                        const lastMessage = output.messages.at(-1);
                        if (!lastMessage || lastMessage.role === 'compact_separator') {
                            throw new Error('expected a user or assistant message');
                        }
                        const part = lastMessage.content[0];
                        if (!part || part.type !== 'text') {
                            throw new Error('expected the request tail text part');
                        }
                        part.text = '[plugin request tail]';
                    });
                }
            }),
            { origin: 'test:active-context-transform' }
        );

        const context = new ChatContext();
        const toolset = new BaseToolset('request-tools');
        context.attachToolsets(toolset);
        context.appendMessage(new UserMessage('hidden before compact'));
        context.appendMessage(
            new CompactSeparatorMessage('summary of hidden history', {
                boundary_id: 'boundary-transform-active-context',
                created_at: '2026-08-12T00:00:00.000Z'
            })
        );
        context.appendMessage(new UserMessage('visible user message'));

        const requestContext = buildRequestChatContext(context, {
            activeContext: buildActiveContextView(context),
            requestTailText: 'original request tail'
        });
        const transformed = await runPluginChatMessagesTransform({ taskId: 'task-1' }, requestContext);
        const providerMessages = OpenAIAdapter.buildMessages(transformed, false);
        const providerPayload = JSON.stringify(providerMessages);

        expect(pluginMessages).toContain('summary of hidden history');
        expect(pluginMessages).toContain('visible user message');
        expect(pluginMessages).toContain('original request tail');
        expect(pluginMessages).not.toContain('hidden before compact');
        expect(providerPayload).toContain('[plugin request tail]');
        expect(providerPayload).not.toContain('original request tail');
        expect(providerPayload).not.toContain('hidden before compact');
        expect(transformed.toolsets.get('request-tools')).toBe(toolset);
        expect(context.lastUserMessage()?.getPlainText()).toBe('visible user message');
    });

    test('materializes partial assistant replay and tool-result overrides before the hook', async () => {
        let pluginMessages = '';
        await getPluginHost().activate(
            definePlugin({
                id: 'prepared-context-transform',
                setup(ctx) {
                    ctx.hooks.on('chat.messages.transform', (_input, output) => {
                        pluginMessages = JSON.stringify(output.messages);
                        const assistant = output.messages.find((message) => message.role === 'assistant');
                        if (!assistant || assistant.role !== 'assistant') {
                            throw new Error('expected an assistant message');
                        }
                        const toolCall = assistant.content
                            .find((part) => part.type === 'tool_call')
                            ?.toolcalls?.find((candidate) => candidate.id === 'call-round-2');
                        if (toolCall) toolCall.result = '[plugin transformed preview]';
                    });
                }
            }),
            { origin: 'test:prepared-context-transform' }
        );

        const context = new ChatContext();
        const assistant = new AssistantMessage();
        appendToolRound(assistant, 'round-1', 'hidden result');
        const visibleToolCall = appendToolRound(assistant, 'round-2', 'full result that must not reach the model');
        visibleToolCall.ensureResultStorage({ result_id: 'result-round-2' });
        const boundary = new CompactSeparatorMessage('summary before assistant tail', {
            boundary_id: 'boundary-transform-partial-assistant',
            created_at: '2026-08-12T00:00:00.000Z',
            kept_anchor_message_id: assistant.message_id,
            kept_anchor_message_index: 1,
            kept_anchor_round_index: 1,
            kept_anchor_start_part_index: 3
        });
        context.appendMessage(boundary);
        context.appendMessage(assistant);
        context.appendMessage(new UserMessage('continue'));

        const requestContext = buildRequestChatContext(context, {
            activeContext: buildActiveContextView(context),
            toolResultOverrides: new Map([['result-round-2', 'request-time result preview']])
        });
        const transformed = await runPluginChatMessagesTransform({ taskId: 'task-1' }, requestContext);
        const providerMessages = OpenAIAdapter.buildMessages(transformed, false);
        const providerPayload = JSON.stringify(providerMessages);

        expect(pluginMessages).not.toContain('round-1');
        expect(pluginMessages).not.toContain('hidden result');
        expect(pluginMessages).not.toContain('full result that must not reach the model');
        expect(pluginMessages).toContain('round-2');
        expect(pluginMessages).toContain('request-time result preview');
        expect(providerPayload).toContain('[plugin transformed preview]');
        expect(providerPayload).not.toContain('request-time result preview');
        expect(providerPayload).not.toContain('full result that must not reach the model');
        expect(visibleToolCall.result).toBe('full result that must not reach the model');
    });
});
