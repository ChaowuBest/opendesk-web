import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import { AutoCompactStates, createAutoCompactDecision } from '../../../main/aikernel/compaction/auto-compact';
import { buildProjectedActiveContextView } from '../../../main/aikernel/compaction/context-view';
import { FULL_COMPACT_BOUNDARY_STRATEGY } from '../../../main/aikernel/compaction/full-compact';
import { prepareContextForModel } from '../../../main/aikernel/compaction/pipeline';
import {
    SESSION_MEMORY_COMPACT_BOUNDARY_STRATEGY,
    SessionMemoryStates,
    writeTaskSessionMemory
} from '../../../main/aikernel/compaction/session-memory-compact';
import { LLM } from '../../../main/aikernel/llm';
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
    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-long-running-compact-'));
    setCustomAppDirectory(tempRootDir);
    fs.mkdirSync(path.join(tempRootDir, 'tasks'), { recursive: true });
    return tempRootDir;
}

function cleanupTempAppDirectory(): void {
    if (tempRootDir && fs.existsSync(tempRootDir)) {
        fs.rmSync(tempRootDir, { recursive: true, force: true });
    }
    tempRootDir = undefined;
}

function appendMessages(
    chatContext: ChatContext,
    messages: Array<UserMessage | AssistantMessage | CompactSeparatorMessage>
) {
    for (const message of messages) {
        chatContext.appendMessage(message);
    }
}

function createTextAssistant(text: string): AssistantMessage {
    return new AssistantMessage().appendText(text);
}

function appendAssistantRound(
    message: AssistantMessage,
    assistantName: string,
    roundLabel: string,
    resultLines = 1
): void {
    message.appendReasoningContent(`reasoning ${assistantName} ${roundLabel}`);
    message.appendText(`assistant ${assistantName} ${roundLabel}`);

    const toolCall = new ToolCall(
        0,
        `tool-call-${assistantName}-${roundLabel}`,
        'demo_tool',
        `{"assistant":"${assistantName}","round":"${roundLabel}"}`
    );
    toolCall.status = 'success';
    toolCall.result = Array.from(
        { length: resultLines },
        (_, index) => `result ${assistantName} ${roundLabel} line ${index + 1}`
    ).join('\n');

    const part = new ToolCallMessagePart();
    part.push(toolCall);
    message.appendToolCallPart(part);
}

function appendAssistantRoundSequence(
    message: AssistantMessage,
    assistantName: string,
    startNumber: number,
    count: number,
    resultLines = 1
): string[] {
    const labels: string[] = [];
    for (let offset = 0; offset < count; offset++) {
        const roundNumber = startNumber + offset;
        const roundLabel = formatRoundLabel(roundNumber);
        appendAssistantRound(message, assistantName, roundLabel, resultLines);
        labels.push(roundLabel);
    }
    return labels;
}

function formatRoundLabel(roundNumber: number): string {
    return `round-${String(roundNumber).padStart(2, '0')}`;
}

function getVisibleAssistantRoundIndices(chatContext: ChatContext, message: AssistantMessage): number[] {
    return buildProjectedActiveContextView(chatContext)
        .projectedItems.filter((item) => item.kind === 'assistant_round' && item.message === message)
        .map((item) => item.roundRef.roundIndex);
}

function getSingleCompactBoundary(chatContext: ChatContext): CompactSeparatorMessage {
    const boundaries = chatContext.messages.filter(
        (message): message is CompactSeparatorMessage => message instanceof CompactSeparatorMessage
    );
    expect(boundaries).toHaveLength(1);
    return boundaries[0];
}

function serializeVisibleMessages(chatContext: ChatContext): string {
    return JSON.stringify(LLM.buildMessages(chatContext, false));
}

function expectActiveContextMessages(
    chatContext: ChatContext,
    expectedMessages: Array<UserMessage | AssistantMessage | CompactSeparatorMessage>
): void {
    const boundary = chatContext.findCompactBoundary();
    expect(boundary).toBeDefined();
    expect(chatContext.messages.slice(boundary!.index)).toEqual(expectedMessages);
}

function createForcedCompactDecision() {
    return createAutoCompactDecision({
        contextWindow: 1000,
        promptTokens: 720,
        reservedSummaryOutput: 100,
        buffer: 180
    });
}

function validMemory(): string {
    return `# Session Title
compact regression

# Current State
keep compacting safely

# Task Specification
single session keeps running

# Files and Functions
prepareContextForModel drives the query-time compaction pipeline.

# Workflow
npm test compact

# Errors & Corrections
keep the user visible

# Key Results
window stays bounded

# Worklog
- stress regression
- bounded replay
`;
}

describe('long-running compaction window regressions', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
        cleanupTempAppDirectory();
    });

    test('pipeline fallback full compact keeps a growing single assistant bounded across repeated cycles', async () => {
        const now = new Date('2026-04-27T00:00:00.000Z');
        jest.setSystemTime(now);

        const chatContext = new ChatContext();
        const hiddenUser = new UserMessage('hidden user before the active boundary');
        const initialBoundary = new CompactSeparatorMessage('summary for earlier history', {
            boundary_id: 'boundary-long-running-full-initial',
            created_at: now.toISOString(),
            strategy: FULL_COMPACT_BOUNDARY_STRATEGY
        });
        const bigAssistant = new AssistantMessage();
        appendAssistantRoundSequence(bigAssistant, 'builder', 1, 20);
        appendMessages(chatContext, [hiddenUser, initialBoundary, bigAssistant]);

        const askSpy = jest
            .spyOn(LLM, 'ask')
            .mockResolvedValue(
                '<state_snapshot><overall_goal>long running full compact</overall_goal></state_snapshot>'
            );

        const autoCompactState = AutoCompactStates.create();
        const anchorHistory: number[] = [];
        const visibleWindowStarts: number[] = [];
        let previousBoundaryId = initialBoundary.metadata.boundary_id;
        let previousBoundaryMessage: CompactSeparatorMessage = initialBoundary;

        for (let iteration = 0; iteration < 4; iteration++) {
            const result = await prepareContextForModel(chatContext, 'demo-model', {
                autoCompactDecisionOverride: createForcedCompactDecision(),
                autoCompactState
            });

            expect(result.compacted).toBe(true);
            expect(result.sessionMemoryCompacted).toBe(false);

            const boundary = chatContext.findCompactBoundary()?.message;
            expect(boundary).toBeDefined();
            expect(boundary).not.toBe(previousBoundaryMessage);
            expect(boundary?.metadata).toMatchObject({
                previous_boundary_id: previousBoundaryId,
                strategy: FULL_COMPACT_BOUNDARY_STRATEGY,
                kept_anchor_message_id: bigAssistant.message_id
            });
            expect(chatContext.messages).toEqual([hiddenUser, boundary, bigAssistant]);
            expect(result.activeContext.messages).toEqual([boundary, bigAssistant]);
            expect(result.activeContext.leadingPartialAssistant).toMatchObject({
                message: bigAssistant,
                roundRef: {
                    roundIndex: boundary?.metadata.kept_anchor_round_index
                }
            });

            const anchorRoundIndex = boundary?.metadata.kept_anchor_round_index;
            expect(typeof anchorRoundIndex).toBe('number');
            anchorHistory.push(anchorRoundIndex!);

            const visibleRoundIndices = getVisibleAssistantRoundIndices(chatContext, bigAssistant);
            visibleWindowStarts.push(visibleRoundIndices[0] ?? -1);
            expect(visibleRoundIndices).toHaveLength(8);
            expect(visibleRoundIndices[0]).toBe(anchorRoundIndex);
            expect(visibleRoundIndices).toEqual(Array.from({ length: 8 }, (_, index) => anchorRoundIndex! + index));

            const serialized = serializeVisibleMessages(chatContext);
            const firstVisibleRoundNumber = anchorRoundIndex! + 1;
            const lastVisibleRoundNumber = anchorRoundIndex! + 8;
            expect(serialized).not.toContain(formatRoundLabel(anchorRoundIndex!));
            expect(serialized).toContain(formatRoundLabel(firstVisibleRoundNumber));
            expect(serialized).toContain(formatRoundLabel(lastVisibleRoundNumber));

            previousBoundaryId = boundary!.metadata.boundary_id;
            previousBoundaryMessage = boundary!;
            if (iteration < 3) {
                appendAssistantRoundSequence(bigAssistant, 'builder', lastVisibleRoundNumber + 1, 8);
            }
        }

        expect(askSpy).toHaveBeenCalledTimes(4);
        expect(anchorHistory).toEqual([12, 20, 28, 36]);
        expect(visibleWindowStarts).toEqual(anchorHistory);
    });

    test('pipeline session memory compact keeps recent user plus a growing single assistant bounded across repeated cycles', async () => {
        createTempAppDirectory();

        const now = new Date('2026-04-27T00:00:00.000Z');
        jest.setSystemTime(now);

        const taskId = 'task-long-running-session-memory';
        writeTaskSessionMemory(taskId, validMemory());

        const chatContext = new ChatContext();
        const recentUser = new UserMessage('keep watching the build output');
        const bigAssistant = new AssistantMessage();
        appendAssistantRoundSequence(bigAssistant, 'builder', 1, 4, 40);
        appendMessages(chatContext, [recentUser, bigAssistant]);

        const askSpy = jest.spyOn(LLM, 'ask').mockResolvedValue('full compact should not run');
        const autoCompactState = AutoCompactStates.create();
        const sessionMemoryState = SessionMemoryStates.create();
        const anchorHistory: number[] = [];
        const visibleWindowStarts: number[] = [];
        let previousBoundaryId: string | undefined = undefined;
        let nextRoundNumber = 5;

        for (let iteration = 0; iteration < 4; iteration++) {
            const boundaryId = `boundary-long-running-session-memory-${iteration + 1}`;
            const result = await prepareContextForModel(chatContext, 'demo-model', {
                autoCompactDecisionOverride: createForcedCompactDecision(),
                autoCompactState,
                enableSessionMemoryCompact: true,
                taskId,
                sessionMemoryState,
                sessionMemoryCompactOptions: {
                    minTokens: 1,
                    minTextMessages: 1,
                    maxTokens: 300,
                    boundaryId,
                    createdAt: now.toISOString()
                }
            });

            expect(result.compacted).toBe(true);
            expect(result.sessionMemoryCompacted).toBe(true);
            expect(result.sessionMemoryCompactResult?.compacted).toBe(true);

            const boundary = chatContext.findCompactBoundary()?.message;
            expect(boundary).toBe(result.sessionMemoryCompactResult?.boundary);
            expect(boundary?.metadata).toMatchObject({
                boundary_id: boundaryId,
                strategy: SESSION_MEMORY_COMPACT_BOUNDARY_STRATEGY,
                kept_anchor_message_id: bigAssistant.message_id
            });
            expect(boundary?.metadata.previous_boundary_id).toBe(previousBoundaryId);
            expect(result.activeContext.messages).toEqual([boundary!, recentUser, bigAssistant]);
            expect(result.activeContext.leadingPartialAssistant).toMatchObject({
                message: bigAssistant,
                roundRef: {
                    roundIndex: boundary?.metadata.kept_anchor_round_index
                }
            });

            const anchorRoundIndex = boundary?.metadata.kept_anchor_round_index;
            expect(typeof anchorRoundIndex).toBe('number');
            anchorHistory.push(anchorRoundIndex!);

            const visibleRoundIndices = getVisibleAssistantRoundIndices(chatContext, bigAssistant);
            visibleWindowStarts.push(visibleRoundIndices[0] ?? -1);
            expect(visibleRoundIndices.length).toBeGreaterThanOrEqual(1);
            expect(visibleRoundIndices.length).toBeLessThanOrEqual(2);
            expect(visibleRoundIndices[0]).toBe(anchorRoundIndex);

            const serialized = serializeVisibleMessages(chatContext);
            const firstVisibleRoundNumber = anchorRoundIndex! + 1;
            expect(serialized).toContain('keep watching the build output');
            expect(serialized).not.toContain(formatRoundLabel(anchorRoundIndex!));
            expect(serialized).toContain(formatRoundLabel(firstVisibleRoundNumber));
            expect(result.sessionMemoryCompactResult?.postCompactTokens).toBeLessThan(
                result.sessionMemoryCompactResult?.autoCompactThreshold ?? Number.POSITIVE_INFINITY
            );

            previousBoundaryId = boundaryId;
            if (iteration < 3) {
                appendAssistantRoundSequence(bigAssistant, 'builder', nextRoundNumber, 1, 40);
                nextRoundNumber += 1;
            }
        }

        expect(askSpy).not.toHaveBeenCalled();
        expect(visibleWindowStarts).toEqual(anchorHistory);
        expect(anchorHistory[0]).toBeGreaterThanOrEqual(0);
        expect(anchorHistory[1]).toBeGreaterThan(anchorHistory[0]);
        expect(anchorHistory[2]).toBeGreaterThan(anchorHistory[1]);
        expect(anchorHistory[3]).toBeGreaterThan(anchorHistory[2]);
    });

    test('mixed long-running pipeline scenario stays runnable across short replies, huge replies, continued assistants, and path switches', async () => {
        createTempAppDirectory();

        const now = new Date('2026-04-27T00:00:00.000Z');
        jest.setSystemTime(now);

        const taskId = 'task-long-running-mixed-window';
        writeTaskSessionMemory(taskId, validMemory());

        const chatContext = new ChatContext();
        const autoCompactState = AutoCompactStates.create();
        const sessionMemoryState = SessionMemoryStates.create();
        const askSpy = jest
            .spyOn(LLM, 'ask')
            .mockResolvedValue(
                '<state_snapshot><overall_goal>mixed long running compact</overall_goal></state_snapshot>'
            );

        const u1 = new UserMessage('user asks a short setup question');
        const a1 = createTextAssistant('short setup answer');
        const u2 = new UserMessage('user asks a second short setup question');
        const a2 = createTextAssistant('second short answer');
        const u3 = new UserMessage('user asks for a very large first response');
        const hugeAssistant1 = new AssistantMessage();
        appendAssistantRoundSequence(hugeAssistant1, 'builder', 1, 20, 2);
        appendMessages(chatContext, [u1, a1, u2, a2, u3, hugeAssistant1]);

        const fullCompactPhase1 = await prepareContextForModel(chatContext, 'demo-model', {
            autoCompactDecisionOverride: createForcedCompactDecision(),
            autoCompactState
        });

        expect(fullCompactPhase1.compacted).toBe(true);
        expect(fullCompactPhase1.sessionMemoryCompacted).toBe(false);
        const fullBoundaryPhase1 = getSingleCompactBoundary(chatContext);
        expect(fullBoundaryPhase1.metadata.strategy).toBe(FULL_COMPACT_BOUNDARY_STRATEGY);
        expectActiveContextMessages(chatContext, [fullBoundaryPhase1, u3, hugeAssistant1]);
        expect(fullCompactPhase1.activeContext.messages).toEqual([fullBoundaryPhase1, u3, hugeAssistant1]);
        expect(fullCompactPhase1.activeContext.leadingPartialAssistant?.message).toBe(hugeAssistant1);

        const fullAnchorPhase1 = fullBoundaryPhase1.metadata.kept_anchor_round_index;
        expect(typeof fullAnchorPhase1).toBe('number');
        expect(getVisibleAssistantRoundIndices(chatContext, hugeAssistant1)).toEqual(
            Array.from({ length: 8 }, (_, index) => fullAnchorPhase1! + index)
        );
        const serializedAfterFullPhase1 = serializeVisibleMessages(chatContext);
        expect(serializedAfterFullPhase1).toContain('user asks for a very large first response');
        expect(serializedAfterFullPhase1).not.toContain('user asks a short setup question');
        expect(serializedAfterFullPhase1).not.toContain('second short answer');
        expect(serializedAfterFullPhase1).not.toContain(formatRoundLabel(fullAnchorPhase1!));
        expect(serializedAfterFullPhase1).toContain(formatRoundLabel(fullAnchorPhase1! + 1));
        expect(serializedAfterFullPhase1).toContain(formatRoundLabel(fullAnchorPhase1! + 8));

        appendAssistantRoundSequence(hugeAssistant1, 'builder', 21, 8, 2);
        const fullCompactPhase2 = await prepareContextForModel(chatContext, 'demo-model', {
            autoCompactDecisionOverride: createForcedCompactDecision(),
            autoCompactState
        });

        expect(fullCompactPhase2.compacted).toBe(true);
        expect(fullCompactPhase2.sessionMemoryCompacted).toBe(false);
        const fullBoundaryPhase2 = getSingleCompactBoundary(chatContext);
        expect(fullBoundaryPhase2).not.toBe(fullBoundaryPhase1);
        expect(fullBoundaryPhase2.metadata).toMatchObject({
            previous_boundary_id: fullBoundaryPhase1.metadata.boundary_id,
            strategy: FULL_COMPACT_BOUNDARY_STRATEGY,
            kept_anchor_message_id: hugeAssistant1.message_id
        });
        expectActiveContextMessages(chatContext, [fullBoundaryPhase2, u3, hugeAssistant1]);
        expect(fullCompactPhase2.activeContext.messages).toEqual([fullBoundaryPhase2, u3, hugeAssistant1]);

        const fullAnchorPhase2 = fullBoundaryPhase2.metadata.kept_anchor_round_index;
        expect(typeof fullAnchorPhase2).toBe('number');
        expect(fullAnchorPhase2).toBeGreaterThan(fullAnchorPhase1!);
        expect(getVisibleAssistantRoundIndices(chatContext, hugeAssistant1)).toEqual(
            Array.from({ length: 8 }, (_, index) => fullAnchorPhase2! + index)
        );
        const serializedAfterFullPhase2 = serializeVisibleMessages(chatContext);
        expect(serializedAfterFullPhase2).toContain('user asks for a very large first response');
        expect(serializedAfterFullPhase2).not.toContain(formatRoundLabel(fullAnchorPhase2!));
        expect(serializedAfterFullPhase2).toContain(formatRoundLabel(fullAnchorPhase2! + 1));
        expect(serializedAfterFullPhase2).toContain(formatRoundLabel(fullAnchorPhase2! + 8));

        appendAssistantRoundSequence(hugeAssistant1, 'builder', 29, 1, 1);
        const u4 = new UserMessage('user asks a short follow-up after the first huge response');
        const a4 = createTextAssistant('short follow-up answer after the first huge response');
        const u5 = new UserMessage('user asks for a second huge response');
        const hugeAssistant2 = new AssistantMessage();
        appendAssistantRoundSequence(hugeAssistant2, 'planner', 1, 4, 40);
        appendMessages(chatContext, [u4, a4, u5, hugeAssistant2]);

        const sessionMemoryPhase1 = await prepareContextForModel(chatContext, 'demo-model', {
            autoCompactDecisionOverride: createForcedCompactDecision(),
            autoCompactState,
            enableSessionMemoryCompact: true,
            taskId,
            sessionMemoryState,
            sessionMemoryCompactOptions: {
                minTokens: 1,
                minTextMessages: 1,
                maxTokens: 300,
                boundaryId: 'boundary-long-running-mixed-session-memory-1',
                createdAt: now.toISOString()
            }
        });

        expect(sessionMemoryPhase1.compacted).toBe(true);
        expect(sessionMemoryPhase1.sessionMemoryCompacted).toBe(true);
        expect(sessionMemoryPhase1.sessionMemoryCompactResult?.compacted).toBe(true);
        const sessionBoundaryPhase1 = getSingleCompactBoundary(chatContext);
        expect(sessionBoundaryPhase1.metadata).toMatchObject({
            boundary_id: 'boundary-long-running-mixed-session-memory-1',
            previous_boundary_id: fullBoundaryPhase2.metadata.boundary_id,
            strategy: SESSION_MEMORY_COMPACT_BOUNDARY_STRATEGY,
            kept_anchor_message_id: hugeAssistant2.message_id
        });
        expectActiveContextMessages(chatContext, [sessionBoundaryPhase1, u5, hugeAssistant2]);
        expect(sessionMemoryPhase1.activeContext.messages).toEqual([sessionBoundaryPhase1, u5, hugeAssistant2]);

        const sessionAnchorPhase1 = sessionBoundaryPhase1.metadata.kept_anchor_round_index;
        expect(typeof sessionAnchorPhase1).toBe('number');
        const visibleRoundsAfterSessionPhase1 = getVisibleAssistantRoundIndices(chatContext, hugeAssistant2);
        expect(visibleRoundsAfterSessionPhase1.length).toBeGreaterThanOrEqual(1);
        expect(visibleRoundsAfterSessionPhase1.length).toBeLessThanOrEqual(2);
        expect(visibleRoundsAfterSessionPhase1[0]).toBe(sessionAnchorPhase1);
        const serializedAfterSessionPhase1 = serializeVisibleMessages(chatContext);
        expect(serializedAfterSessionPhase1).toContain('user asks for a second huge response');
        expect(serializedAfterSessionPhase1).not.toContain('user asks a short follow-up after the first huge response');
        expect(serializedAfterSessionPhase1).not.toContain('short follow-up answer after the first huge response');
        expect(serializedAfterSessionPhase1).not.toContain('user asks for a very large first response');
        expect(serializedAfterSessionPhase1).not.toContain(formatRoundLabel(sessionAnchorPhase1!));
        expect(serializedAfterSessionPhase1).toContain(formatRoundLabel(sessionAnchorPhase1! + 1));

        appendAssistantRoundSequence(hugeAssistant2, 'planner', 5, 1, 40);
        const sessionMemoryPhase2 = await prepareContextForModel(chatContext, 'demo-model', {
            autoCompactDecisionOverride: createForcedCompactDecision(),
            autoCompactState,
            enableSessionMemoryCompact: true,
            taskId,
            sessionMemoryState,
            sessionMemoryCompactOptions: {
                minTokens: 1,
                minTextMessages: 1,
                maxTokens: 300,
                boundaryId: 'boundary-long-running-mixed-session-memory-2',
                createdAt: now.toISOString()
            }
        });

        expect(sessionMemoryPhase2.compacted).toBe(true);
        expect(sessionMemoryPhase2.sessionMemoryCompacted).toBe(true);
        const sessionBoundaryPhase2 = getSingleCompactBoundary(chatContext);
        expect(sessionBoundaryPhase2.metadata).toMatchObject({
            boundary_id: 'boundary-long-running-mixed-session-memory-2',
            previous_boundary_id: sessionBoundaryPhase1.metadata.boundary_id,
            strategy: SESSION_MEMORY_COMPACT_BOUNDARY_STRATEGY,
            kept_anchor_message_id: hugeAssistant2.message_id
        });
        expectActiveContextMessages(chatContext, [sessionBoundaryPhase2, u5, hugeAssistant2]);

        const sessionAnchorPhase2 = sessionBoundaryPhase2.metadata.kept_anchor_round_index;
        expect(typeof sessionAnchorPhase2).toBe('number');
        expect(sessionAnchorPhase2).toBeGreaterThan(sessionAnchorPhase1!);
        expect(getVisibleAssistantRoundIndices(chatContext, hugeAssistant2)[0]).toBe(sessionAnchorPhase2);
        const serializedAfterSessionPhase2 = serializeVisibleMessages(chatContext);
        expect(serializedAfterSessionPhase2).toContain('user asks for a second huge response');
        expect(serializedAfterSessionPhase2).not.toContain(formatRoundLabel(sessionAnchorPhase2!));
        expect(serializedAfterSessionPhase2).toContain(formatRoundLabel(sessionAnchorPhase2! + 1));

        const u6 = new UserMessage('user switches back to a short question');
        const a6 = createTextAssistant('short answer after multiple compactions');
        const u7 = new UserMessage('user asks for a third huge response');
        const hugeAssistant3 = new AssistantMessage();
        appendAssistantRoundSequence(hugeAssistant3, 'finalizer', 1, 4, 40);
        appendMessages(chatContext, [u6, a6, u7, hugeAssistant3]);

        const sessionMemoryPhase3 = await prepareContextForModel(chatContext, 'demo-model', {
            autoCompactDecisionOverride: createForcedCompactDecision(),
            autoCompactState,
            enableSessionMemoryCompact: true,
            taskId,
            sessionMemoryState,
            sessionMemoryCompactOptions: {
                minTokens: 1,
                minTextMessages: 1,
                maxTokens: 300,
                boundaryId: 'boundary-long-running-mixed-session-memory-3',
                createdAt: now.toISOString()
            }
        });

        expect(sessionMemoryPhase3.compacted).toBe(true);
        expect(sessionMemoryPhase3.sessionMemoryCompacted).toBe(true);
        const sessionBoundaryPhase3 = getSingleCompactBoundary(chatContext);
        expect(sessionBoundaryPhase3.metadata).toMatchObject({
            boundary_id: 'boundary-long-running-mixed-session-memory-3',
            previous_boundary_id: sessionBoundaryPhase2.metadata.boundary_id,
            strategy: SESSION_MEMORY_COMPACT_BOUNDARY_STRATEGY,
            kept_anchor_message_id: hugeAssistant3.message_id
        });
        expectActiveContextMessages(chatContext, [sessionBoundaryPhase3, u7, hugeAssistant3]);
        expect(sessionMemoryPhase3.activeContext.messages).toEqual([sessionBoundaryPhase3, u7, hugeAssistant3]);
        expect(sessionMemoryPhase3.activeContext.leadingPartialAssistant?.message).toBe(hugeAssistant3);

        const sessionAnchorPhase3 = sessionBoundaryPhase3.metadata.kept_anchor_round_index;
        expect(typeof sessionAnchorPhase3).toBe('number');
        const visibleRoundsAfterSessionPhase3 = getVisibleAssistantRoundIndices(chatContext, hugeAssistant3);
        expect(visibleRoundsAfterSessionPhase3.length).toBeGreaterThanOrEqual(1);
        expect(visibleRoundsAfterSessionPhase3.length).toBeLessThanOrEqual(2);
        expect(visibleRoundsAfterSessionPhase3[0]).toBe(sessionAnchorPhase3);
        const serializedAfterSessionPhase3 = serializeVisibleMessages(chatContext);
        expect(serializedAfterSessionPhase3).toContain('user asks for a third huge response');
        expect(serializedAfterSessionPhase3).not.toContain('user asks for a second huge response');
        expect(serializedAfterSessionPhase3).not.toContain('user switches back to a short question');
        expect(serializedAfterSessionPhase3).not.toContain('short answer after multiple compactions');
        expect(serializedAfterSessionPhase3).not.toContain(formatRoundLabel(sessionAnchorPhase3!));
        expect(serializedAfterSessionPhase3).toContain(formatRoundLabel(sessionAnchorPhase3! + 1));

        expect(askSpy).toHaveBeenCalledTimes(2);
        expect(autoCompactState.consecutiveFailures).toBe(0);
        expect(sessionMemoryPhase3.activeContext.messages).toHaveLength(3);
    });
});
