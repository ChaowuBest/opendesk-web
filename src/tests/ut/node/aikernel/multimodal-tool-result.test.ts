import assert from 'node:assert/strict';
import test from 'node:test';
import { AnthropicAdapter } from '../../../../main/aikernel/adapters/anthropic.js';
import {
    AssistantMessage,
    ChatContext,
    ImageMessagePart,
    ToolCall,
    ToolCallMessagePart,
    UserMessage
} from '../../../../main/aikernel/messages.js';

const IMAGE_URL = 'data:image/png;base64,iVBORw0KGgo=';

function createImageToolCall(): ToolCall {
    const toolCall = new ToolCall(0, 'call-image', 'filemgr-readImage', '{"path":"image.png"}');
    toolCall.status = 'success';
    toolCall.result = '{"type":"image","source":"image.png"}';
    toolCall.result_object = {
        type: 'image',
        images: [
            {
                image_url: IMAGE_URL,
                media_type: 'image/png',
                source: 'image.png'
            }
        ]
    };
    return toolCall;
}

function createAssistantWithImageToolCall(): AssistantMessage {
    const part = new ToolCallMessagePart();
    part.toolcalls.push(createImageToolCall());
    return new AssistantMessage([part]);
}

test('OpenAI projection keeps tool responses contiguous and attaches image content afterward', () => {
    const messages = createAssistantWithImageToolCall().toOpenAIMessages(undefined, true) as any[];

    assert.deepEqual(
        messages.map((message) => message.role),
        ['assistant', 'tool', 'user']
    );
    assert.equal(messages[1].tool_call_id, 'call-image');
    assert.equal(messages[2].content[1].type, 'image_url');
    assert.equal(messages[2].content[1].image_url.url, IMAGE_URL);
});

test('OpenAI projection omits tool-result images for text-only models', () => {
    const messages = createAssistantWithImageToolCall().toOpenAIMessages(undefined, false) as any[];

    assert.deepEqual(
        messages.map((message) => message.role),
        ['assistant', 'tool']
    );
});

test('Anthropic projection places image blocks inside tool_result content', () => {
    const context = new ChatContext();
    context.appendMessage(createAssistantWithImageToolCall());

    const projected = AnthropicAdapter.buildMessages(context, true) as any;
    const toolResult = projected.messages
        .flatMap((message: any) => message.content ?? [])
        .find((block: any) => block.type === 'tool_result');

    assert.ok(toolResult);
    assert.ok(Array.isArray(toolResult.content));
    assert.equal(toolResult.content[1].type, 'image');
    assert.equal(toolResult.content[1].source.type, 'base64');
    assert.equal(toolResult.content[1].source.media_type, 'image/png');
    assert.equal(toolResult.content[1].source.data, 'iVBORw0KGgo=');
});

test('Anthropic projection omits tool-result image blocks for text-only models', () => {
    const context = new ChatContext();
    context.appendMessage(createAssistantWithImageToolCall());

    const projected = AnthropicAdapter.buildMessages(context, false) as any;
    const toolResult = projected.messages
        .flatMap((message: any) => message.content ?? [])
        .find((block: any) => block.type === 'tool_result');

    assert.ok(toolResult);
    assert.equal(typeof toolResult.content, 'string');
});

test('Anthropic projection sends persisted user image attachments as file references', () => {
    const context = new ChatContext();
    const message = new UserMessage('Describe the attachment.');
    message.content.push(new ImageMessagePart(IMAGE_URL, '/tmp/pasted-image.png'));
    context.appendMessage(message);

    for (const supportsVision of [true, false]) {
        const projected = AnthropicAdapter.buildMessages(context, supportsVision) as any;
        const blocks = projected.messages[0].content as any[];

        assert.deepEqual(
            blocks.map((block) => block.type),
            ['text', 'text']
        );
        assert.match(blocks[1].text, /\/tmp\/pasted-image\.png/);
        assert.doesNotMatch(JSON.stringify(projected), /iVBORw0KGgo=/);
    }
});
