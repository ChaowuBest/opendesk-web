import { buildActiveContextView } from '../../../main/aikernel/compaction/context-view';
import { buildFullCompactPlan } from '../../../main/aikernel/compaction/full-compact';
import {
    AssistantMessage,
    ChatContext,
    ToolCall,
    ToolCallMessagePart,
    UserMessage
} from '../../../main/aikernel/messages';

function appendAssistantRound(message: AssistantMessage, roundLabel: string, resultLines: number): void {
    message.appendReasoningContent(`reasoning ${roundLabel}`);
    message.appendText(`visible ${roundLabel}`);

    const toolCall = new ToolCall(0, `tool-call-${roundLabel}`, 'demo_tool', `{"round":"${roundLabel}"}`);
    toolCall.status = 'success';
    toolCall.result = Array.from(
        { length: resultLines },
        (_, index) => `${roundLabel} tool result line ${index + 1}`
    ).join('\n');

    const part = new ToolCallMessagePart();
    part.push(toolCall);
    message.appendToolCallPart(part);
}

function createLargeAssistantMessage(): AssistantMessage {
    const message = new AssistantMessage();
    appendAssistantRound(message, 'old-round-1', 120);
    appendAssistantRound(message, 'old-round-2', 120);
    appendAssistantRound(message, 'recent-round-3', 4);
    return message;
}

function createPlannerBaselineContext(largeAssistant: AssistantMessage): {
    chatContext: ChatContext;
    olderUser: UserMessage;
    olderAssistant: AssistantMessage;
    recentUser: UserMessage;
} {
    const chatContext = new ChatContext();
    const olderUser = new UserMessage('older user before the large assistant');
    const olderAssistant = new AssistantMessage().appendText('older assistant before the large assistant');
    const recentUser = new UserMessage('recent user immediately before the large assistant');

    chatContext.appendMessage(olderUser);
    chatContext.appendMessage(olderAssistant);
    chatContext.appendMessage(recentUser);
    chatContext.appendMessage(largeAssistant);

    return {
        chatContext,
        olderUser,
        olderAssistant,
        recentUser
    };
}

describe('Step 0 baseline: assistant message boundaries remain message-granular', () => {
    test('buildActiveContextView 仍然把多轮 assistant 当成单条 ChatMessage 返回', () => {
        const chatContext = new ChatContext();
        const user = new UserMessage('continue the task');
        const largeAssistant = createLargeAssistantMessage();

        chatContext.appendMessage(user);
        chatContext.appendMessage(largeAssistant);

        const activeContext = buildActiveContextView(chatContext);
        const openAIMessages = largeAssistant.toOpenAIMessages();

        expect(activeContext.startIndex).toBe(0);
        expect(activeContext.messages).toEqual([user, largeAssistant]);
        expect(activeContext.messages.filter((message) => message instanceof AssistantMessage)).toEqual([
            largeAssistant
        ]);
        expect(openAIMessages).toHaveLength(9);

        const serialized = JSON.stringify(openAIMessages);
        expect(serialized).toContain('visible old-round-1');
        expect(serialized).toContain('visible old-round-2');
        expect(serialized).toContain('visible recent-round-3');
    });

    test('buildFullCompactPlan 只能整条保留大 assistant，不能从其内部 round 起保留', () => {
        const largeAssistant = createLargeAssistantMessage();
        const { chatContext, olderUser, olderAssistant, recentUser } = createPlannerBaselineContext(largeAssistant);

        const plan = buildFullCompactPlan(chatContext, {
            tailMessageCount: 1,
            tailAssistantToolMessageCount: 1,
            tailAssistantErrorMessageCount: 0,
            tailPlanMessageCount: 0,
            minMessagesToSummarize: 2
        });

        expect(plan).toBeDefined();
        expect(plan!.keepStartIndex).toBe(chatContext.messages.indexOf(recentUser));
        expect(plan!.messagesToSummarize).toEqual([olderUser, olderAssistant]);
        expect(plan!.messagesToKeep).toEqual([recentUser, largeAssistant]);
        expect(plan!.keptStats.assistantMessages).toBe(1);
        expect(plan!.keptStats.toolCalls).toBe(3);
    });

    test('即使把 tail 保护参数压到最小，planner 仍然不能从大 assistant 中间切开', () => {
        const largeAssistant = createLargeAssistantMessage();
        const { chatContext, olderUser, olderAssistant, recentUser } = createPlannerBaselineContext(largeAssistant);

        const plan = buildFullCompactPlan(chatContext, {
            tailMessageCount: 1,
            tailAssistantToolMessageCount: 0,
            tailAssistantErrorMessageCount: 0,
            tailPlanMessageCount: 0,
            minMessagesToSummarize: 2
        });

        expect(plan).toBeDefined();
        expect(plan!.keepStartIndex).toBe(chatContext.messages.indexOf(recentUser));
        expect(plan!.messagesToSummarize).toEqual([olderUser, olderAssistant]);
        expect(plan!.messagesToKeep).toEqual([recentUser, largeAssistant]);
        expect(plan!.keptStats.assistantMessages).toBe(1);
        expect(plan!.keptStats.toolCalls).toBe(3);
    });
});
