import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import { AutoCompactStates, createAutoCompactDecision } from '../../../main/aikernel/compaction/auto-compact';
import { buildActiveContextView } from '../../../main/aikernel/compaction/context-view';
import { MicrocompactStates } from '../../../main/aikernel/compaction/microcompact-state';
import { ToolResultReplacementStates } from '../../../main/aikernel/compaction/tool-results';
import { estimateVisibleContextTokens } from '../../../main/aikernel/compaction/token-estimation';
import { inspectContextForDiagnostics } from '../../../main/aikernel/context/inspect';
import {
    AssistantMessage,
    ChatContext,
    CompactSeparatorMessage,
    SystemMessage,
    ToolCall,
    ToolCallMessagePart,
    Usage,
    UserMessage
} from '../../../main/aikernel/messages';
import { setCustomAppDirectory } from '../../../main/utils/setting';

let tempRootDir: string | undefined;

function createTempAppDirectory(): string {
    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-context-inspect-'));
    setCustomAppDirectory(tempRootDir);
    return tempRootDir;
}

function cleanupTempAppDirectory(): void {
    if (tempRootDir && fs.existsSync(tempRootDir)) {
        fs.rmSync(tempRootDir, { recursive: true, force: true });
    }
    tempRootDir = undefined;
}

function createAssistantWithToolResult(
    id: string,
    result: string,
    toolName: string = 'executePowerShell'
): { message: AssistantMessage; toolCall: ToolCall } {
    const message = new AssistantMessage();
    message.appendText(`assistant ${id}`);

    const toolCall = new ToolCall(0, `tool-${id}`, toolName, `{"command":"echo ${id}"}`);
    toolCall.status = 'success';
    toolCall.result = result;

    const part = new ToolCallMessagePart();
    part.push(toolCall);
    message.appendToolCallPart(part);

    return { message, toolCall };
}

function createInspectableChatContext(): {
    chatContext: ChatContext;
    toolCalls: {
        old: ToolCall;
        recent: ToolCall;
    };
} {
    const chatContext = new ChatContext();
    chatContext.system_prompt = new SystemMessage('system prompt that should stay unchanged');
    chatContext.appendMessage(new UserMessage('before boundary'));
    chatContext.appendMessage(
        new CompactSeparatorMessage('compact summary before inspect', {
            boundary_id: 'boundary-inspect',
            created_at: '2026-05-08T00:00:00.000Z'
        })
    );
    chatContext.appendMessage(new UserMessage('inspect this context'));

    const old = createAssistantWithToolResult('old', `HEAD\n${'x'.repeat(24_000)}\nTAIL`);
    const recent = createAssistantWithToolResult('recent', 'recent result should stay visible');
    recent.message.usage = new Usage(12_500, 0, 12_500);
    chatContext.appendMessage(old.message);
    chatContext.appendMessage(recent.message);

    return {
        chatContext,
        toolCalls: {
            old: old.toolCall,
            recent: recent.toolCall
        }
    };
}

describe('context inspection', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-05-08T00:00:00.000Z'));
        createTempAppDirectory();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
        cleanupTempAppDirectory();
    });

    test('only inspects a cloned context and leaves the original chatContext and states untouched', async () => {
        const { chatContext, toolCalls } = createInspectableChatContext();
        const originalChatContext = JSON.stringify(chatContext.toJSON());
        const autoCompactState = AutoCompactStates.deserialize({
            consecutive_failures: 1,
            failure_threshold: 2,
            cooldown_ms: 60_000
        });
        const microcompactState = MicrocompactStates.deserialize({
            version: 1,
            last_assistant_completed_at: '2026-05-08T00:30:00.000Z'
        });
        const replacementState = ToolResultReplacementStates.create();
        const originalAutoCompactState = JSON.stringify(AutoCompactStates.serialize(autoCompactState));
        const originalMicrocompactState = JSON.stringify(MicrocompactStates.serialize(microcompactState));
        const originalReplacementState = JSON.stringify(ToolResultReplacementStates.serialize(replacementState));

        const result = await inspectContextForDiagnostics(chatContext, undefined, {
            taskId: 'task-context-inspect',
            autoCompactDecisionOverride: createAutoCompactDecision({
                contextWindow: 1_000,
                estimatedContextTokens: 950,
                reservedSummaryOutput: 100,
                buffer: 0
            }),
            autoCompactState,
            enableMicrocompact: true,
            microcompactRequestKind: 'task_turn',
            microcompactTaskRole: 'main',
            microcompactTailAssistantMessages: 1,
            microcompactState,
            enableToolResultBudget: true,
            toolResultBudgetChars: 1_000,
            toolResultReplacementState: replacementState
        });

        expect(JSON.stringify(chatContext.toJSON())).toBe(originalChatContext);
        expect(JSON.stringify(AutoCompactStates.serialize(autoCompactState))).toBe(originalAutoCompactState);
        expect(JSON.stringify(MicrocompactStates.serialize(microcompactState))).toBe(originalMicrocompactState);
        expect(JSON.stringify(ToolResultReplacementStates.serialize(replacementState))).toBe(originalReplacementState);

        expect(result.shouldCompact).toBe(true);
        expect(result.compacted).toBe(false);
        expect(result.sessionMemoryCompacted).toBe(false);
        expect(result.activeContext.startIndex).toBe(1);
        expect(result.activeContext.boundary?.message.metadata.boundary_id).toBe('boundary-inspect');
        expect(result.activeContext.messages).toHaveLength(4);
        expect(result.contextTokenEstimate).toMatchObject({
            source: 'usage_plus_tail_estimate'
        });
        expect(result.toolResultOverrides.size).toBeGreaterThan(0);
        expect(result.microcompactDecision?.mode).toBeDefined();
        expect(toolCalls.old.result).toContain('x'.repeat(100));
        expect(toolCalls.old.result_storage).toBeUndefined();
        expect(toolCalls.recent.result).toBe('recent result should stay visible');
    });

    test('returns the same visible token estimate as the current active context snapshot', async () => {
        const { chatContext } = createInspectableChatContext();
        const activeContext = buildActiveContextView(chatContext);
        const expectedTokens = estimateVisibleContextTokens({
            activeContext,
            systemPrompt: chatContext.system_prompt
        });

        const result = await inspectContextForDiagnostics(chatContext, undefined, {
            taskId: 'task-context-inspect-estimate',
            autoCompactDecisionOverride: createAutoCompactDecision({
                contextWindow: 1_000,
                estimatedContextTokens: 950,
                reservedSummaryOutput: 100,
                buffer: 0
            })
        });

        expect(result.contextTokenEstimate).toMatchObject(expectedTokens);
    });
});
