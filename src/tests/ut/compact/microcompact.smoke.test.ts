import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    analyzeMicrocompactCandidatesForChatContext,
    applyLocalMicrocompactToChatContext,
    buildRequestTimeMicrocompactOverrides,
    isMicrocompactableToolName
} from '../../../main/aikernel/compaction/microcompact';
import { getToolResultArtifactPath } from '../../../main/aikernel/compaction/tool-results';
import {
    AssistantMessage,
    ChatContext,
    CompactSeparatorMessage,
    ToolCall,
    ToolCallMessagePart,
    UserMessage
} from '../../../main/aikernel/messages';
import { setCustomAppDirectory } from '../../../main/utils/setting';

let tempRootDir: string | undefined;

function createTempAppDirectory(): string {
    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-microcompact-smoke-'));
    setCustomAppDirectory(tempRootDir);
    return tempRootDir;
}

function cleanupTempAppDirectory(): void {
    if (tempRootDir && fs.existsSync(tempRootDir)) {
        fs.rmSync(tempRootDir, { recursive: true, force: true });
    }
    tempRootDir = undefined;
}

function createToolAssistant(
    name: string,
    result: string,
    toolName: string = 'executePowerShell'
): { message: AssistantMessage; toolCall: ToolCall } {
    const message = new AssistantMessage();
    message.appendText(`assistant ${name}`);

    const toolCall = new ToolCall(0, `tool-${name}`, toolName, `{"command":"echo ${name}"}`);
    toolCall.status = 'success';
    toolCall.result = result;

    const part = new ToolCallMessagePart();
    part.push(toolCall);
    message.appendToolCallPart(part);

    return { message, toolCall };
}

function appendAssistantRound(message: AssistantMessage, roundLabel: string, result: string): ToolCall {
    message.appendReasoningContent(`reasoning ${roundLabel}`);
    message.appendText(`assistant ${roundLabel}`);

    const toolCall = new ToolCall(0, `tool-${roundLabel}`, 'executePowerShell', `{"round":"${roundLabel}"}`);
    toolCall.status = 'success';
    toolCall.result = result;

    const part = new ToolCallMessagePart();
    part.push(toolCall);
    message.appendToolCallPart(part);
    return toolCall;
}

function createLargeAssistantWithRounds(): {
    message: AssistantMessage;
    toolCalls: {
        oldRound1: ToolCall;
        oldRound2: ToolCall;
        recentRound3: ToolCall;
    };
} {
    const message = new AssistantMessage();
    const oldRound1 = appendAssistantRound(message, 'old-round-1', 'old round 1 '.repeat(80));
    const oldRound2 = appendAssistantRound(message, 'old-round-2', 'old round 2 '.repeat(80));
    const recentRound3 = appendAssistantRound(message, 'recent-round-3', 'recent round 3 should stay visible');
    return {
        message,
        toolCalls: {
            oldRound1,
            oldRound2,
            recentRound3
        }
    };
}

function createLargeAssistantWithVisibleTailRounds(): {
    message: AssistantMessage;
    toolCalls: {
        oldRound1: ToolCall;
        oldRound2: ToolCall;
        visibleRound3: ToolCall;
        latestRound4: ToolCall;
    };
} {
    const message = new AssistantMessage();
    const oldRound1 = appendAssistantRound(message, 'old-round-1', 'old round 1 '.repeat(80));
    const oldRound2 = appendAssistantRound(message, 'old-round-2', 'old round 2 '.repeat(80));
    const visibleRound3 = appendAssistantRound(message, 'visible-round-3', 'visible round 3 '.repeat(80));
    const latestRound4 = appendAssistantRound(message, 'latest-round-4', 'latest round 4 should stay visible');
    return {
        message,
        toolCalls: {
            oldRound1,
            oldRound2,
            visibleRound3,
            latestRound4
        }
    };
}

describe('compact smoke: microcompact', () => {
    afterEach(() => {
        cleanupTempAppDirectory();
    });

    test('readFile matcher 会进入 Step 5 microcompact 覆盖面，并兼容带 toolset 前缀的工具名', () => {
        const chatContext = new ChatContext();
        chatContext.appendMessage(new UserMessage('read several files'));

        const directReadFile = createToolAssistant('read-file', 'alpha\n'.repeat(400), 'readFile');
        const prefixedReadFile = createToolAssistant('prefixed-read-file', 'beta\n'.repeat(400), 'filemgr-readFile');
        const recent = createToolAssistant('recent-shell', 'recent shell result should stay visible');
        chatContext.appendMessage(directReadFile.message);
        chatContext.appendMessage(prefixedReadFile.message);
        chatContext.appendMessage(recent.message);

        expect(isMicrocompactableToolName('readFile')).toBe(true);
        expect(isMicrocompactableToolName('filemgr-readFile')).toBe(true);
        expect(isMicrocompactableToolName('executePowerShell')).toBe(true);
        expect(isMicrocompactableToolName('webSearch')).toBe(true);

        const analysis = analyzeMicrocompactCandidatesForChatContext(chatContext, {
            tailAssistantMessages: 1
        });

        expect(analysis.candidates.map((candidate) => candidate.toolName)).toEqual(['readFile', 'filemgr-readFile']);
        expect(analysis.candidates.map((candidate) => candidate.toolCall.id)).toEqual([
            'tool-read-file',
            'tool-prefixed-read-file'
        ]);
        expect(analysis.stats.tailProtectedCount).toBe(1);
        expect(analysis.skipped.map((candidate) => candidate.toolCall.id)).toEqual(['tool-recent-shell']);
    });

    test('会清理旧工具结果，并保护最近的工具调用 tail', () => {
        const chatContext = new ChatContext();
        chatContext.appendMessage(new UserMessage('run several tools'));

        const old1 = createToolAssistant('old-1', 'old result 1 '.repeat(80));
        const old2 = createToolAssistant('old-2', 'old result 2 '.repeat(80));
        const recent = createToolAssistant('recent', 'recent result should stay visible');
        chatContext.appendMessage(old1.message);
        chatContext.appendMessage(old2.message);
        chatContext.appendMessage(recent.message);

        const analysis = analyzeMicrocompactCandidatesForChatContext(chatContext, {
            tailAssistantMessages: 1
        });
        expect(analysis.candidates.map((candidate) => candidate.toolCall.id)).toEqual(['tool-old-1', 'tool-old-2']);
        expect(analysis.stats.tailProtectedCount).toBe(1);

        const result = applyLocalMicrocompactToChatContext(chatContext, 'task-microcompact-smoke', {
            analysis
        });

        expect(result.appliedCandidates).toHaveLength(2);
        expect(old1.toolCall.result).toContain('[旧工具结果已被 microcompact 清理');
        expect(old2.toolCall.result).toContain('[旧工具结果已被 microcompact 清理');
        expect(old1.toolCall.microcompact?.strategy).toBe('local_clear');
        expect(old2.toolCall.microcompact?.strategy).toBe('local_clear');
        expect(recent.toolCall.result).toBe('recent result should stay visible');
        expect(recent.toolCall.microcompact).toBeUndefined();
        expect(result.activeContext.messages).toHaveLength(4);
    });

    test('request-time override 不改写原始 tool result，但会生成稳定 override', () => {
        const chatContext = new ChatContext();
        chatContext.appendMessage(new UserMessage('run several tools'));

        const old1 = createToolAssistant('old-1', 'old result 1 '.repeat(80));
        const old2 = createToolAssistant('old-2', 'old result 2 '.repeat(80));
        const recent = createToolAssistant('recent', 'recent result should stay visible');
        chatContext.appendMessage(old1.message);
        chatContext.appendMessage(old2.message);
        chatContext.appendMessage(recent.message);

        const analysis = analyzeMicrocompactCandidatesForChatContext(chatContext, {
            tailAssistantMessages: 1
        });

        const result = buildRequestTimeMicrocompactOverrides('task-microcompact-request-override', {
            analysis,
            selectedResultIds: analysis.candidates.map((candidate) => candidate.resultId)
        });

        expect(result.appliedCandidates).toHaveLength(2);
        expect(result.overrides.size).toBe(2);
        expect(old1.toolCall.result).toContain('old result 1');
        expect(old2.toolCall.result).toContain('old result 2');
        expect(old1.toolCall.microcompact).toBeUndefined();
        expect(old2.toolCall.microcompact).toBeUndefined();
        expect(old1.toolCall.result_storage?.result_id).toBeDefined();
        expect(old2.toolCall.result_storage?.result_id).toBeDefined();
        expect(result.overrides.get(old1.toolCall.result_storage!.result_id)).toContain(
            '[旧工具结果已被 microcompact 清理'
        );
        expect(result.overrides.get(old2.toolCall.result_storage!.result_id)).toContain(
            '[旧工具结果已被 microcompact 清理'
        );
    });

    test('readFile warm path 会保留原结果，并在大结果时写 artifact 与路径范围提示', () => {
        createTempAppDirectory();
        const chatContext = new ChatContext();
        chatContext.appendMessage(new UserMessage('inspect an older file read result'));

        const readFile = createToolAssistant('read-file-large', 'line content\n'.repeat(12_000), 'readFile');
        readFile.toolCall.args_string = JSON.stringify({
            file_path: 'src/main/aikernel/compaction/microcompact.ts',
            offset: 21,
            limit: 120
        });
        const recent = createToolAssistant('recent', 'recent result should stay visible');
        chatContext.appendMessage(readFile.message);
        chatContext.appendMessage(recent.message);

        const analysis = analyzeMicrocompactCandidatesForChatContext(chatContext, {
            tailAssistantMessages: 1
        });

        const result = buildRequestTimeMicrocompactOverrides('task-microcompact-readfile-artifact', {
            analysis,
            selectedResultIds: analysis.candidates.map((candidate) => candidate.resultId)
        });

        const resultId = readFile.toolCall.result_storage?.result_id;
        expect(result.appliedCandidates).toHaveLength(1);
        expect(result.overrides.size).toBe(1);
        expect(resultId).toBeDefined();
        expect(readFile.toolCall.result).toContain('line content');
        expect(readFile.toolCall.microcompact).toBeUndefined();
        expect(readFile.toolCall.result_storage?.relative_path).toBeDefined();
        expect(readFile.toolCall.result_storage?.replacement_text).toBeUndefined();
        expect(
            fs.readFileSync(getToolResultArtifactPath('task-microcompact-readfile-artifact', resultId!, false), 'utf8')
        ).toBe(readFile.toolCall.result);

        const replacement = result.overrides.get(resultId!);
        expect(replacement).toContain('工具: readFile');
        expect(replacement).toContain('文件: src/main/aikernel/compaction/microcompact.ts');
        expect(replacement).toContain('读取范围: 第 21~140 行');
        expect(replacement).toContain('完整输出可查看:');
        expect(replacement).toContain('重新调用 readFile');
    });

    test('step 8 protects only the most recent tool rounds inside one assistant', () => {
        const chatContext = new ChatContext();
        chatContext.appendMessage(new UserMessage('run a long assistant with multiple tool rounds'));

        const largeAssistant = createLargeAssistantWithRounds();
        chatContext.appendMessage(largeAssistant.message);

        const analysis = analyzeMicrocompactCandidatesForChatContext(chatContext, {
            tailAssistantMessages: 1
        });

        expect(analysis.candidates.map((candidate) => candidate.toolCall.id)).toEqual([
            'tool-old-round-1',
            'tool-old-round-2'
        ]);
        expect(analysis.candidates.map((candidate) => candidate.roundIndex)).toEqual([0, 1]);
        expect(analysis.skipped.map((candidate) => candidate.toolCall.id)).toEqual(['tool-recent-round-3']);
        expect(analysis.skipped[0].roundRef).toMatchObject({
            assistantMessageId: largeAssistant.message.message_id,
            roundIndex: 2,
            startPartIndex: 6,
            endPartIndexExclusive: 9
        });
        expect(analysis.stats.assistantMessagesWithToolCalls).toBe(1);
        expect(analysis.stats.assistantRoundsWithToolCalls).toBe(3);
        expect(analysis.stats.tailAssistantRounds).toBe(1);
        expect(analysis.stats.tailProtectedCount).toBe(1);
        expect(analysis.tailProtectedAssistantMessageIds).toEqual([largeAssistant.message.message_id]);
        expect(analysis.tailProtectedAssistantRoundRefs).toEqual([
            {
                assistantMessageId: largeAssistant.message.message_id,
                roundIndex: 2,
                startPartIndex: 6,
                endPartIndexExclusive: 9
            }
        ]);

        const result = applyLocalMicrocompactToChatContext(chatContext, 'task-microcompact-step8-rounds', {
            analysis
        });

        expect(result.appliedCandidates).toHaveLength(2);
        expect(largeAssistant.toolCalls.oldRound1.result).toContain('microcompact');
        expect(largeAssistant.toolCalls.oldRound2.result).toContain('microcompact');
        expect(largeAssistant.toolCalls.recentRound3.result).toBe('recent round 3 should stay visible');
    });

    test('step 8 partial first assistant scans only visible rounds', () => {
        const chatContext = new ChatContext();
        const hiddenUser = new UserMessage('hidden before boundary');
        const largeAssistant = createLargeAssistantWithRounds();
        chatContext.appendMessage(hiddenUser);
        chatContext.appendMessage(
            new CompactSeparatorMessage('summary before the visible tail', {
                boundary_id: 'boundary-microcompact-step8',
                created_at: '2026-04-27T00:00:00.000Z',
                kept_anchor_message_id: largeAssistant.message.message_id,
                kept_anchor_message_index: 2,
                kept_anchor_round_index: 2,
                kept_anchor_start_part_index: 6
            })
        );
        chatContext.appendMessage(largeAssistant.message);

        const analysis = analyzeMicrocompactCandidatesForChatContext(chatContext, {
            tailAssistantMessages: 0
        });

        expect(analysis.activeContext.leadingPartialAssistant).toMatchObject({
            message: largeAssistant.message,
            messageIndex: 2,
            roundRef: {
                assistantMessageId: largeAssistant.message.message_id,
                roundIndex: 2,
                startPartIndex: 6,
                endPartIndexExclusive: 9
            }
        });
        expect(analysis.stats.scannedToolCallCount).toBe(1);
        expect(analysis.stats.assistantMessagesWithToolCalls).toBe(1);
        expect(analysis.stats.assistantRoundsWithToolCalls).toBe(1);
        expect(analysis.candidates.map((candidate) => candidate.toolCall.id)).toEqual(['tool-recent-round-3']);
        expect(analysis.candidates[0].roundRef).toMatchObject({
            assistantMessageId: largeAssistant.message.message_id,
            roundIndex: 2,
            startPartIndex: 6,
            endPartIndexExclusive: 9
        });
        expect(analysis.candidates.map((candidate) => candidate.toolCall.id)).not.toContain('tool-old-round-1');
        expect(analysis.candidates.map((candidate) => candidate.toolCall.id)).not.toContain('tool-old-round-2');
        expect(analysis.skipped.map((candidate) => candidate.toolCall.id)).not.toContain('tool-old-round-1');
        expect(analysis.skipped.map((candidate) => candidate.toolCall.id)).not.toContain('tool-old-round-2');
    });

    test('step 8 boundary + recent user + partial assistant only microcompacts visible non-tail rounds', () => {
        const chatContext = new ChatContext();
        const hiddenUser = new UserMessage('hidden before boundary');
        const hiddenAssistant = new AssistantMessage().appendText('hidden assistant before boundary');
        const recentUser = new UserMessage('keep watching the build output');
        const largeAssistant = createLargeAssistantWithVisibleTailRounds();
        chatContext.appendMessage(hiddenUser);
        chatContext.appendMessage(hiddenAssistant);
        chatContext.appendMessage(
            new CompactSeparatorMessage('summary before the recent user', {
                boundary_id: 'boundary-microcompact-step8-recent-user',
                created_at: '2026-04-27T00:00:00.000Z',
                kept_anchor_message_id: largeAssistant.message.message_id,
                kept_anchor_message_index: 4,
                kept_anchor_round_index: 2,
                kept_anchor_start_part_index: 6
            })
        );
        chatContext.appendMessage(recentUser);
        chatContext.appendMessage(largeAssistant.message);

        const analysis = analyzeMicrocompactCandidatesForChatContext(chatContext, {
            tailAssistantMessages: 1
        });

        expect(analysis.activeContext.messages).toEqual([chatContext.messages[2], recentUser, largeAssistant.message]);
        expect(analysis.activeContext.leadingPartialAssistant).toMatchObject({
            message: largeAssistant.message,
            messageIndex: 4,
            roundRef: {
                assistantMessageId: largeAssistant.message.message_id,
                roundIndex: 2,
                startPartIndex: 6,
                endPartIndexExclusive: 9
            }
        });
        expect(analysis.stats.scannedToolCallCount).toBe(2);
        expect(analysis.stats.assistantMessagesWithToolCalls).toBe(1);
        expect(analysis.stats.assistantRoundsWithToolCalls).toBe(2);
        expect(analysis.stats.tailAssistantRounds).toBe(1);
        expect(analysis.stats.tailProtectedCount).toBe(1);
        expect(analysis.candidates.map((candidate) => candidate.toolCall.id)).toEqual(['tool-visible-round-3']);
        expect(analysis.candidates[0].roundIndex).toBe(2);
        expect(analysis.candidates[0].roundRef).toMatchObject({
            assistantMessageId: largeAssistant.message.message_id,
            roundIndex: 2,
            startPartIndex: 6,
            endPartIndexExclusive: 9
        });
        expect(analysis.skipped.map((candidate) => candidate.toolCall.id)).toEqual(['tool-latest-round-4']);
        expect(analysis.skipped[0]).toMatchObject({
            reason: 'tail_protected',
            roundIndex: 3,
            roundRef: {
                assistantMessageId: largeAssistant.message.message_id,
                roundIndex: 3,
                startPartIndex: 9,
                endPartIndexExclusive: 12
            }
        });
        expect(analysis.tailProtectedAssistantRoundRefs).toEqual([
            {
                assistantMessageId: largeAssistant.message.message_id,
                roundIndex: 3,
                startPartIndex: 9,
                endPartIndexExclusive: 12
            }
        ]);
        expect(analysis.candidates.map((candidate) => candidate.toolCall.id)).not.toContain('tool-old-round-1');
        expect(analysis.candidates.map((candidate) => candidate.toolCall.id)).not.toContain('tool-old-round-2');
        expect(analysis.skipped.map((candidate) => candidate.toolCall.id)).not.toContain('tool-old-round-1');
        expect(analysis.skipped.map((candidate) => candidate.toolCall.id)).not.toContain('tool-old-round-2');

        const result = applyLocalMicrocompactToChatContext(chatContext, 'task-microcompact-step8-recent-user', {
            analysis
        });

        expect(result.appliedCandidates).toHaveLength(1);
        expect(result.appliedCandidates[0].toolCall.id).toBe('tool-visible-round-3');
        expect(result.activeContext.messages).toEqual([chatContext.messages[2], recentUser, largeAssistant.message]);
        expect(largeAssistant.toolCalls.oldRound1.result).toContain('old round 1');
        expect(largeAssistant.toolCalls.oldRound2.result).toContain('old round 2');
        expect(largeAssistant.toolCalls.visibleRound3.result).toContain('microcompact');
        expect(largeAssistant.toolCalls.visibleRound3.microcompact?.strategy).toBe('local_clear');
        expect(largeAssistant.toolCalls.latestRound4.result).toBe('latest round 4 should stay visible');
        expect(largeAssistant.toolCalls.latestRound4.microcompact).toBeUndefined();
    });
});
