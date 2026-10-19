import { buildActiveContextView } from '../../../main/aikernel/compaction/context-view';
import { estimateAutoCompactContextTokens } from '../../../main/aikernel/compaction/auto-compact';
import { estimateTextTokens } from '../../../utils/token-estimation';
import {
    estimateAssistantPostUsageVisibleTokens,
    estimateRoughTokensFromChatMessage,
    estimateVisibleContextTokens,
    getContextTokensFromUsage,
    normalizeUsage
} from '../../../main/aikernel/compaction/token-estimation';
import {
    AssistantMessage,
    ChatContext,
    ToolCall,
    ToolCallMessagePart,
    SystemMessage,
    Usage,
    UserMessage
} from '../../../main/aikernel/messages';

function assistantWithStableToolResult(
    resultText: string,
    usage?: Usage
): { message: AssistantMessage; toolCall: ToolCall } {
    const message = new AssistantMessage();
    message.message_id = 'assistant-anchor';
    message.appendText('Calling demo tool.');

    const part = new ToolCallMessagePart();
    const toolCall = new ToolCall(0, 'tool-call-1', 'demo_tool', '{"query":"demo"}');
    toolCall.status = 'success';
    toolCall.result = resultText;
    toolCall.ensureResultStorage({ result_id: 'result-anchor' });
    part.push(toolCall);
    message.appendToolCallPart(part);
    message.usage = usage;

    return { message, toolCall };
}

describe('token estimation foundation', () => {
    test('estimateTextTokens 对 CJK 与非 CJK 字符分别加权估算', () => {
        // 空文本为 0
        expect(estimateTextTokens(undefined)).toBe(0);
        expect(estimateTextTokens('')).toBe(0);

        // 纯 ASCII：约 4 字符 1 token
        expect(estimateTextTokens('a'.repeat(400))).toBe(100);
        expect(estimateTextTokens('a'.repeat(3))).toBe(1);

        // 纯 CJK 统一表意文字：每字 0.7 token（ceil(100 * 0.7) = 70）
        expect(estimateTextTokens('中'.repeat(100))).toBe(70);
        // 单个汉字向上取整为 1
        expect(estimateTextTokens('中')).toBe(1);

        // CJK 标点与全角形式计入 CJK 类
        expect(estimateTextTokens('。！')).toBe(2);

        // 混合文本：CJK 与 ASCII 分别累加后取整
        // 10 个汉字 * 0.7 + 40 个 ASCII * 0.25 = 7 + 10 = 17
        expect(estimateTextTokens('中'.repeat(10) + 'a'.repeat(40))).toBe(17);
    });

    test('normalizeUsage 与 getContextTokensFromUsage 会优先使用 expanded usage 字段', () => {
        const normalized = normalizeUsage({
            prompt_tokens: 100.8,
            completion_tokens: 21,
            total_tokens: 121,
            input_tokens: 90.2,
            output_tokens: 30,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 5,
            ignored_field: 999
        });

        expect(normalized).toMatchObject({
            prompt_tokens: 100,
            completion_tokens: 21,
            total_tokens: 121,
            input_tokens: 90,
            output_tokens: 30,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 5
        });
        expect(getContextTokensFromUsage(normalized)).toBe(135);
    });

    test('estimateAssistantPostUsageVisibleTokens 只统计 usage 之后可见的 tool result 内容', () => {
        const { message } = assistantWithStableToolResult('very large raw tool result that should be replaced');
        const toolResultOverrides = new Map([['result-anchor', 'tool preview only']]);

        expect(estimateAssistantPostUsageVisibleTokens(message, toolResultOverrides)).toBe(
            estimateTextTokens('tool preview only')
        );
    });

    test('estimateVisibleContextTokens 会叠加 usage 基线、assistant 内部 tail 与 usage 后消息 tail', () => {
        const chatContext = new ChatContext();
        chatContext.appendMessage(new UserMessage('Seed context before the latest usage anchor.'));

        const usage = new Usage(100, 20, 120, {
            input_tokens: 90,
            output_tokens: 30,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 5
        });
        const { message } = assistantWithStableToolResult('full raw result should not be counted directly', usage);
        chatContext.appendMessage(message);

        const tailUser = new UserMessage('Follow-up request after the last usage anchor.');
        chatContext.appendMessage(tailUser);

        const toolResultOverrides = new Map([['result-anchor', 'tool preview only']]);
        const estimate = estimateVisibleContextTokens({
            activeContext: buildActiveContextView(chatContext),
            toolResultOverrides
        });

        const expectedBaseUsageTokens = 135;
        const expectedAssistantInternalTailTokens = estimateTextTokens('tool preview only');
        const expectedTailEstimatedTokens = estimateRoughTokensFromChatMessage(tailUser);

        expect(estimate).toMatchObject({
            estimatedContextTokens:
                expectedBaseUsageTokens + expectedAssistantInternalTailTokens + expectedTailEstimatedTokens,
            baseUsageTokens: expectedBaseUsageTokens,
            tailEstimatedTokens: expectedTailEstimatedTokens,
            assistantInternalTailTokens: expectedAssistantInternalTailTokens,
            source: 'usage_plus_tail_estimate',
            usageAnchorMessageId: 'assistant-anchor',
            usageAnchorMessageIndex: 1
        });
    });

    test('estimateVisibleContextTokens 在没有 usage 时退回 rough_estimate_only', () => {
        const chatContext = new ChatContext();
        const user = new UserMessage('hello world');
        const assistant = new AssistantMessage();
        assistant.appendText('plain answer without usage');
        chatContext.appendMessage(user);
        chatContext.appendMessage(assistant);

        const expectedTokens = estimateRoughTokensFromChatMessage(user) + estimateRoughTokensFromChatMessage(assistant);
        const estimate = estimateVisibleContextTokens({
            activeContext: buildActiveContextView(chatContext)
        });

        expect(estimate).toEqual({
            estimatedContextTokens: expectedTokens,
            baseUsageTokens: 0,
            tailEstimatedTokens: expectedTokens,
            assistantInternalTailTokens: 0,
            source: 'rough_estimate_only'
        });
    });

    test('estimateAutoCompactContextTokens 会把 system_prompt 计入预算', () => {
        const chatContext = new ChatContext();
        chatContext.system_prompt = new SystemMessage('system prompt '.repeat(400));

        const user = new UserMessage('hello world');
        const assistant = new AssistantMessage();
        assistant.appendText('plain answer with no usage');
        chatContext.appendMessage(user);
        chatContext.appendMessage(assistant);

        const estimate = estimateAutoCompactContextTokens(chatContext);

        const visibleMessageTokens = chatContext.messages.reduce(
            (total, message) => total + estimateRoughTokensFromChatMessage(message),
            0
        );
        const systemPromptTokens = estimateTextTokens(chatContext.system_prompt.content);

        expect(estimate.estimatedContextTokens).toBe(visibleMessageTokens + systemPromptTokens);
    });
});
