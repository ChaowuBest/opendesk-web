import { AnthropicAdapter } from '../../../main/aikernel/adapters/anthropic';
import { OpenAIAdapter } from '../../../main/aikernel/adapters/openai';
import {
    applyFullCompactResult,
    buildFullCompactPlan,
    buildFullCompactResult,
    compactFullContext
} from '../../../main/aikernel/compaction/full-compact';
import { buildActiveContextView } from '../../../main/aikernel/compaction/context-view';
import {
    AssistantMessage,
    ChatContext,
    CompactSeparatorMessage,
    FileMessagePart,
    SystemMessage,
    ToolCall,
    ToolCallMessagePart,
    UserMessage
} from '../../../main/aikernel/messages';

function assistant(text: string): AssistantMessage {
    const message = new AssistantMessage();
    message.appendText(text);
    return message;
}

function appendAssistantRound(message: AssistantMessage, roundLabel: string): void {
    message.appendReasoningContent(`reasoning ${roundLabel}`);
    message.appendText(`visible ${roundLabel}`);

    const part = new ToolCallMessagePart();
    const toolCall = new ToolCall(0, `tool-call-${roundLabel}`, 'demo_tool', `{"round":"${roundLabel}"}`);
    toolCall.status = 'success';
    toolCall.result = `result ${roundLabel}`;
    part.push(toolCall);
    message.appendToolCallPart(part);
}

function createMultiRoundAssistant(roundLabels: string[]): AssistantMessage {
    const message = new AssistantMessage();
    for (const roundLabel of roundLabels) {
        appendAssistantRound(message, roundLabel);
    }
    return message;
}

describe('compact smoke: OpenAIAdapter.buildMessages active context tail', () => {
    test('最终发给模型的 messages 只包含最新 boundary 和 kept tail', () => {
        const chatContext = new ChatContext();
        chatContext.appendMessage(new UserMessage('hidden user before compact'));
        chatContext.appendMessage(assistant('hidden assistant before compact'));
        chatContext.appendMessage(
            new CompactSeparatorMessage('structured compact summary for hidden history', {
                boundary_id: 'boundary-build-messages-smoke',
                created_at: '2026-04-20T00:00:00.000Z'
            })
        );
        chatContext.appendMessage(new UserMessage('kept user after compact'));
        chatContext.appendMessage(assistant('kept assistant after compact'));

        const messages = OpenAIAdapter.buildMessages(chatContext, false);
        const serialized = JSON.stringify(messages);

        expect(messages).toHaveLength(3);
        expect(serialized).toContain('structured compact summary for hidden history');
        expect(serialized).toContain('kept user after compact');
        expect(serialized).toContain('kept assistant after compact');
        expect(serialized).not.toContain('hidden user before compact');
        expect(serialized).not.toContain('hidden assistant before compact');
    });

    test('goal command messages are included in model adapter messages', () => {
        const chatContext = new ChatContext();
        const goalMessage = new UserMessage('/goal 实现用户登录功能');
        chatContext.appendMessage(goalMessage);
        chatContext.appendMessage(new UserMessage('real user request'));

        const openAIMessages = OpenAIAdapter.buildMessages(chatContext, false);
        const anthropicMessages = AnthropicAdapter.buildMessages(chatContext, false);

        expect(JSON.stringify(openAIMessages)).toContain('/goal 实现用户登录功能');
        expect(JSON.stringify(openAIMessages)).toContain('real user request');
        expect(JSON.stringify(anthropicMessages)).toContain('/goal 实现用户登录功能');
        expect(JSON.stringify(anthropicMessages)).toContain('real user request');
    });

    test('file attachments tell OpenAI and Anthropic adapters to use extractText', () => {
        const chatContext = new ChatContext();
        const userMessage = new UserMessage();
        userMessage.content.push(new FileMessagePart('/tmp/report.pdf'));
        chatContext.appendMessage(userMessage);

        const openAIText = JSON.stringify(OpenAIAdapter.buildMessages(chatContext, false));
        const anthropicText = JSON.stringify(AnthropicAdapter.buildMessages(chatContext, false));

        for (const serialized of [openAIText, anthropicText]) {
            expect(serialized).toContain('/tmp/report.pdf');
            expect(serialized).toContain('extractText');
            expect(serialized).not.toContain('undefined');
            expect(serialized).not.toContain('<content>');
        }
    });

    test('FileMessagePart render includes data-open-file with full path', async () => {
        const filePath = '/tmp/report.pdf';
        const part = new FileMessagePart(filePath);
        const html = await part.render();
        expect(html).toContain(`data-open-file="${filePath}"`);
        expect(html).toContain(`data-file-path="${filePath}"`);
    });

    test('step 6 buildMessages replays only the visible assistant tail', () => {
        const chatContext = new ChatContext();
        const bigAssistant = createMultiRoundAssistant(['round-1', 'round-2', 'round-3']);

        chatContext.appendMessage(new UserMessage('prefix user'));
        chatContext.appendMessage(assistant('prefix assistant'));
        chatContext.appendMessage(bigAssistant);
        chatContext.appendMessage(new UserMessage('kept user'));
        chatContext.appendMessage(assistant('kept assistant'));

        const plan = buildFullCompactPlan(chatContext, {
            tailMessageCount: 3,
            tailAssistantToolMessageCount: 0,
            tailAssistantErrorMessageCount: 0,
            tailPlanMessageCount: 0,
            enableAssistantRoundBoundary: true
        });
        expect(plan?.keepAnchor).toMatchObject({
            kind: 'assistant_round',
            messageId: bigAssistant.message_id,
            startPartIndex: 6
        });

        const result = buildFullCompactResult(
            plan!,
            '<state_snapshot><overall_goal>step6</overall_goal></state_snapshot>',
            {
                boundaryId: 'boundary-build-messages-step6',
                createdAt: '2026-04-27T00:00:00.000Z',
                trigger: 'manual'
            }
        );
        applyFullCompactResult(chatContext, result);

        const messages = OpenAIAdapter.buildMessages(chatContext, false);
        const serialized = JSON.stringify(messages);

        expect(serialized).toContain('step6');
        expect(serialized).not.toContain('round-1');
        expect(serialized).not.toContain('round-2');
        expect(serialized).toContain('round-3');
        expect(serialized).toContain('kept user');
        expect(serialized).toContain('kept assistant');
    });

    test('step 2 buildMessages keeps the recent user while replaying only the visible assistant tail after a manual boundary', () => {
        const chatContext = new ChatContext();
        const bigAssistant = createMultiRoundAssistant(['round-1', 'round-2', 'round-3']);
        const recentUser = new UserMessage('keep watching the build output');
        const boundary = new CompactSeparatorMessage('structured compact summary before recent user', {
            boundary_id: 'boundary-build-messages-step2',
            created_at: '2026-04-27T00:00:00.000Z',
            kept_anchor_message_id: bigAssistant.message_id,
            kept_anchor_message_index: 4,
            kept_anchor_round_index: 2,
            kept_anchor_start_part_index: 6
        });

        chatContext.appendMessage(new UserMessage('hidden user before compact'));
        chatContext.appendMessage(assistant('hidden assistant before compact'));
        chatContext.appendMessage(boundary);
        chatContext.appendMessage(recentUser);
        chatContext.appendMessage(bigAssistant);

        const activeContext = buildActiveContextView(chatContext);
        expect(activeContext.messages).toEqual([boundary, recentUser, bigAssistant]);
        expect(activeContext.leadingPartialAssistant).toMatchObject({
            message: bigAssistant,
            messageIndex: 4,
            roundRef: {
                assistantMessageId: bigAssistant.message_id,
                roundIndex: 2,
                startPartIndex: 6,
                endPartIndexExclusive: 9
            }
        });

        const messages = OpenAIAdapter.buildMessages(chatContext, false);
        const serialized = JSON.stringify(messages);

        expect(serialized).toContain('structured compact summary before recent user');
        expect(serialized).toContain('keep watching the build output');
        expect(serialized).not.toContain('hidden user before compact');
        expect(serialized).not.toContain('hidden assistant before compact');
        expect(serialized).not.toContain('round-1');
        expect(serialized).not.toContain('round-2');
        expect(serialized).toContain('round-3');
    });

    test('Anthropic messages use top-level system and native tool_use/tool_result blocks', () => {
        const chatContext = new ChatContext();
        chatContext.system_prompt = new SystemMessage('system instructions');
        chatContext.appendMessage(new UserMessage('use a tool'));

        const assistantMessage = new AssistantMessage();
        const part = new ToolCallMessagePart();
        const toolCall = new ToolCall(0, 'tool-call-1', 'demo_tool', '{"query":"opendesk"}');
        toolCall.status = 'success';
        toolCall.result = 'tool result text';
        part.push(toolCall);
        assistantMessage.appendToolCallPart(part);
        chatContext.appendMessage(assistantMessage);

        const anthropic = AnthropicAdapter.buildMessages(chatContext, false);
        const serialized = JSON.stringify(anthropic);

        expect(anthropic.system).toBe('system instructions');
        expect(serialized).toContain('"type":"tool_use"');
        expect(serialized).toContain('"input":{"query":"opendesk"}');
        expect(serialized).toContain('"type":"tool_result"');
        expect(serialized).toContain('tool result text');
        expect(serialized).not.toContain('"role":"system"');
    });

    test('adapter usage parsers normalize OpenAI and Anthropic token fields', () => {
        const openaiUsage = OpenAIAdapter.parseUsage({
            prompt_tokens: 11,
            completion_tokens: 7
        });
        expect(openaiUsage).toMatchObject({
            prompt_tokens: 11,
            completion_tokens: 7,
            total_tokens: 18
        });

        const anthropicUsage = AnthropicAdapter.parseUsage({
            input_tokens: 13,
            output_tokens: 5,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 3
        });
        expect(anthropicUsage).toMatchObject({
            prompt_tokens: 13,
            completion_tokens: 5,
            total_tokens: 18,
            input_tokens: 13,
            output_tokens: 5,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 3
        });
    });

    test('step 5 buildMessages keeps the recent user while replaying only the visible assistant tail after full compact apply', async () => {
        const chatContext = new ChatContext();
        const recentUser = new UserMessage('keep watching the build output');
        const bigAssistant = createMultiRoundAssistant([
            'round-01',
            'round-02',
            'round-03',
            'round-04',
            'round-05',
            'round-06',
            'round-07',
            'round-08',
            'round-09',
            'round-10',
            'round-11',
            'round-12',
            'round-13',
            'round-14',
            'round-15',
            'round-16',
            'round-17',
            'round-18',
            'round-19',
            'round-20'
        ]);

        chatContext.appendMessage(recentUser);
        chatContext.appendMessage(bigAssistant);

        const runResult = await compactFullContext(chatContext, undefined, {
            enableAssistantRoundBoundary: true,
            boundaryId: 'boundary-build-messages-step5',
            createdAt: '2026-04-27T00:00:00.000Z',
            trigger: 'manual',
            generateSummary: async () => '<state_snapshot><overall_goal>step5</overall_goal></state_snapshot>'
        });

        expect(runResult.compacted).toBe(true);

        const activeContext = buildActiveContextView(chatContext);
        expect(activeContext.messages).toEqual([runResult.boundary, recentUser, bigAssistant]);
        expect(activeContext.leadingPartialAssistant).toMatchObject({
            message: bigAssistant,
            roundRef: {
                roundIndex: 12,
                startPartIndex: 36,
                endPartIndexExclusive: 39
            }
        });

        const messages = OpenAIAdapter.buildMessages(chatContext, false);
        const serialized = JSON.stringify(messages);

        expect(serialized).toContain('step5');
        expect(serialized).toContain('keep watching the build output');
        expect(serialized).not.toContain('round-01');
        expect(serialized).not.toContain('round-12');
        expect(serialized).toContain('round-13');
        expect(serialized).toContain('round-20');
    });
});
