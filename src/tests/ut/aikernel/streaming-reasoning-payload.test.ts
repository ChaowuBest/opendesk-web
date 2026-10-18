import {
    AssistantMessage,
    ReasoningMessagePart,
    TextMessagePart,
    ToolCall,
    ToolCallMessagePart
} from '../../../main/aikernel/messages.js';
import { serializeTaskUpdateForRender } from '../../../main/aikernel/task/update-render.js';

function makeAssistantChunk(lastPart: any, streaming: boolean) {
    return {
        type: 'assistant' as const,
        task_id: 'task-1',
        task_status: 'running' as const,
        message_id: 'message-1',
        last_part_index: 0,
        last_part: lastPart,
        ...(streaming ? { streaming: true } : {})
    };
}

describe('streaming assistant render payload', () => {
    test('streaming reasoning snapshot does not carry the duplicated rendered copy', () => {
        // 回归护栏：流式快照的 rendered 与 content 是同一份内容的两次拷贝。
        // 正常流式路径 rendered 恒为 undefined（append 后 invalidateRender 且流式不渲染），
        // 但「渲染过 → 又以流式身份重发」的窗口会把它带进 payload，长思考下体积翻倍。
        // 流式身份的 reasoning 快照必须显式剔除 rendered，text 是唯一内容拷贝。
        const part = new ReasoningMessagePart('a'.repeat(4096), 'reasoning_content');
        (part as any).rendered = 'a'.repeat(4096);

        const update = serializeTaskUpdateForRender(makeAssistantChunk(part, true)) as any;

        expect(update.streaming).toBe(true);
        expect(update.last_part).not.toHaveProperty('rendered');
        expect(update.last_part.text).toBe('a'.repeat(4096));
        expect(update.last_part.contentLength).toBe(4096);
    });

    test('non-streaming reasoning snapshot keeps the rendered copy', () => {
        // 终态/非流式快照的 rendered 是唯一的 HTML 拷贝，text 也不存在——必须保持原样。
        const part = new ReasoningMessagePart('done thinking', 'reasoning_content');
        part.rendered = 'done thinking';

        const update = serializeTaskUpdateForRender(makeAssistantChunk(part, false)) as any;

        expect(update.last_part.rendered).toBe('done thinking');
    });

    test('streaming text snapshot is unchanged', () => {
        const part = new TextMessagePart('hello world');

        const update = serializeTaskUpdateForRender(makeAssistantChunk(part, true)) as any;

        expect(update.last_part.text).toBe('hello world');
        expect(update.last_part.rendered).toBeUndefined();
    });

    test('tool_call part serialization is untouched', () => {
        const call = new ToolCall(0, 'call-1', 'demo-tool', '{}');
        call.status = 'running';
        const part = new ToolCallMessagePart();
        part.toolcalls.push(call);
        part.rendered = '<div>card</div>';
        const message = new AssistantMessage();
        message.content.push(part);

        const update = serializeTaskUpdateForRender({
            type: 'assistant_replace',
            task_id: 'task-1',
            task_status: 'running',
            message_id: 'message-1',
            parts: message.content
        }) as any;

        expect(update.parts[0].rendered).toBe('<div>card</div>');
        expect(update.parts[0].toolcalls[0]).not.toHaveProperty('args_string');
    });
});
