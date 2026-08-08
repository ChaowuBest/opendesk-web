import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntimeTurnController, type AgentRuntimeTurnHost } from '../../../main/aikernel/agents/runtime.js';
import { AssistantMessage, ChatContext, ToolCallMessagePart, UserMessage } from '../../../main/aikernel/messages.js';

test('agent runtime turn keeps streamed output and tool progress in the local chat context', async () => {
    const chatContext = new ChatContext();
    const publishedParts: number[] = [];
    const host: AgentRuntimeTurnHost = {
        chatContext,
        publishUserMessage: async () => undefined,
        publishAssistantPart: async (partIndex) => {
            publishedParts.push(partIndex);
        }
    };
    const turn = new AgentRuntimeTurnController(host);

    await turn.start('Inspect the project');
    await turn.apply({ type: 'thought_delta', text: 'Looking around. ' });
    await turn.apply({ type: 'message_delta', text: 'Found ' });
    await turn.apply({ type: 'message_delta', text: 'the issue.' });
    await turn.apply({
        type: 'tool_call',
        toolCallId: 'call-1',
        title: 'Read file',
        status: 'in_progress',
        rawInput: { path: '/workspace/a.ts' }
    });
    await turn.apply({
        type: 'tool_call',
        toolCallId: 'call-1',
        title: 'Read file',
        status: 'completed',
        rawOutput: { content: 'ok' }
    });
    turn.finish();

    assert.equal(chatContext.messages.length, 2);
    assert.equal((chatContext.messages[0] as UserMessage).getPlainText(), 'Inspect the project');
    const assistant = chatContext.messages[1] as AssistantMessage;
    assert.equal(assistant.content[0].type, 'reasoning');
    assert.equal((assistant.content[0] as any).content, 'Looking around. ');
    assert.equal(assistant.content[1].type, 'text');
    assert.equal((assistant.content[1] as any).text, 'Found the issue.');
    const tools = assistant.content[2] as ToolCallMessagePart;
    assert.equal(tools.toolcalls.length, 1);
    assert.equal(tools.toolcalls[0].id, 'call-1');
    assert.equal(tools.toolcalls[0].status, 'success');
    assert.equal(tools.toolcalls[0].result, JSON.stringify({ content: 'ok' }));
    assert.deepEqual(publishedParts, [0, 1, 1, 2, 2]);
});

test('agent runtime turn records errors as local assistant content', async () => {
    const chatContext = new ChatContext();
    const turn = new AgentRuntimeTurnController({
        chatContext,
        publishUserMessage: async () => undefined,
        publishAssistantPart: async () => undefined
    });

    await turn.start('Run it');
    await turn.apply({ type: 'error', title: 'Remote agent', message: 'Connection closed' });
    turn.finish();

    const assistant = chatContext.messages[1] as AssistantMessage;
    assert.equal(assistant.content[0].type, 'error');
    assert.equal((assistant.content[0] as any).message, 'Connection closed');
});
