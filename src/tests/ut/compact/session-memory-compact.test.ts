import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import { AutoCompactStates, createAutoCompactDecision } from '../../../main/aikernel/compaction/auto-compact';
import { buildActiveContextView } from '../../../main/aikernel/compaction/context-view';
import { FULL_COMPACT_BOUNDARY_STRATEGY } from '../../../main/aikernel/compaction/full-compact';
import { prepareContextForModel } from '../../../main/aikernel/compaction/pipeline';
import {
    SESSION_MEMORY_COMPACT_BOUNDARY_STRATEGY,
    SessionMemoryStates,
    applySessionMemoryCompactResult,
    buildSessionMemoryCompactPlan,
    buildSessionMemoryCompactResult,
    trySessionMemoryCompaction,
    writeTaskSessionMemory
} from '../../../main/aikernel/compaction/session-memory-compact';
import { LLM } from '../../../main/aikernel/llm';
import {
    AssistantMessage,
    ChatContext,
    CompactSeparatorMessage,
    UserMessage,
    isCompactBoundaryMessage,
    type ChatMessage
} from '../../../main/aikernel/messages';
import { setCustomAppDirectory } from '../../../main/utils/setting';

let tempRootDir: string | undefined;

function createTempAppDirectory(): string {
    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-session-memory-compact-'));
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

function createMessageFactory() {
    const labels = new Map<ChatMessage, string>();

    const label = <T extends ChatMessage>(message: T, name: string): T => {
        labels.set(message, name);
        return message;
    };

    return {
        user(name: string): UserMessage {
            return label(new UserMessage(`user ${name}`), name);
        },

        assistant(name: string): AssistantMessage {
            const message = new AssistantMessage();
            message.appendText(`assistant ${name}`);
            return label(message, name);
        },

        boundary(name: string, boundaryId = name): CompactSeparatorMessage {
            return label(
                new CompactSeparatorMessage(`summary for ${name}`, {
                    boundary_id: boundaryId,
                    created_at: '2026-04-23T00:00:00.000Z'
                }),
                name
            );
        },

        labelsOf(messages: ChatMessage[]): string[] {
            return messages.map((message) => labels.get(message) ?? '<unlabelled>');
        }
    };
}

function appendMessages(chatContext: ChatContext, messages: ChatMessage[]): void {
    for (const message of messages) {
        chatContext.appendMessage(message);
    }
}

function createCompactableChatContext(): ChatContext {
    const factory = createMessageFactory();
    const chatContext = new ChatContext();
    appendMessages(chatContext, [
        factory.user('u1'),
        factory.assistant('a1'),
        factory.user('u2'),
        factory.assistant('a2'),
        factory.user('u3'),
        factory.assistant('a3'),
        factory.user('u4'),
        factory.assistant('a4'),
        factory.user('u5'),
        factory.assistant('a5')
    ]);
    return chatContext;
}

function validMemory(): string {
    return `# Session Title
_A short and distinctive 5-10 word descriptive title for the session._
OpenDesk session memory compact

# Current State
_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._
Step 8D/8E is being implemented with session memory compact before full compact fallback.

# Task Specification
_What did the user ask to build? Any constraints or design decisions?_
Only auto compact should try session memory; manual compact stays full compact.

# Files and Functions
_Important files, functions, and why they matter._
src/main/aikernel/compaction/session-memory-compact.ts plans and applies compact.

# Workflow
_Commands usually run and how to interpret them._
npm test -- --runTestsByPath src/tests/ut/compact/session-memory-compact.test.ts

# Errors & Corrections
_Errors encountered, corrections, and approaches to avoid._
Fallback to full compact if session memory is missing, empty, too large, or unsafe.

# Key Results
_Exact results or important outputs._
Session memory can produce a compact boundary without calling LLM.ask.

# Worklog
_Terse chronological worklog._
- Added pure session memory compact planning.
- Integrated pipeline fallback behavior.
`;
}

describe('session memory compact planning and apply', () => {
    test('last_summarized_message_id 命中时，从该消息之后开始保留 tail', () => {
        const factory = createMessageFactory();
        const chatContext = new ChatContext();
        const a2 = factory.assistant('a2');
        appendMessages(chatContext, [
            factory.user('u1'),
            factory.assistant('a1'),
            factory.user('u2'),
            a2,
            factory.user('u3'),
            factory.assistant('a3')
        ]);
        const state = SessionMemoryStates.deserialize({
            initialized: true,
            last_summarized_message_id: a2.message_id,
            tokens_at_last_extraction: 1000
        });

        const plan = buildSessionMemoryCompactPlan(chatContext, state, validMemory(), {
            minTokens: 1,
            minTextMessages: 1
        });

        expect(plan).toBeDefined();
        expect(plan!.reason).toBe('normal');
        expect(plan!.keepStartIndex).toBe(4);
        expect(factory.labelsOf(plan!.messagesToKeep)).toEqual(['u3', 'a3']);
    });

    test('last_summarized_message_id 丢失时走 resume fallback，并保守保留最近 tail', () => {
        const factory = createMessageFactory();
        const chatContext = new ChatContext();
        appendMessages(chatContext, [
            factory.user('u1'),
            factory.assistant('a1'),
            factory.user('u2'),
            factory.assistant('a2'),
            factory.user('u3'),
            factory.assistant('a3')
        ]);
        const state = SessionMemoryStates.deserialize({
            initialized: true,
            last_summarized_message_id: 'missing-message-id',
            tokens_at_last_extraction: 1000
        });

        const plan = buildSessionMemoryCompactPlan(chatContext, state, validMemory(), {
            minTokens: 1,
            minTextMessages: 2
        });

        expect(plan).toBeDefined();
        expect(plan!.reason).toBe('resume_without_last_summarized_message');
        expect(factory.labelsOf(plan!.messagesToKeep)).toEqual(['u3', 'a3']);
    });

    test('规划不会跨越最近 compact boundary，且 kept tail 不包含旧 boundary', () => {
        const factory = createMessageFactory();
        const chatContext = new ChatContext();
        const obsoleteBoundary = factory.boundary('obsolete-boundary', 'boundary-obsolete');
        const latestBoundary = factory.boundary('latest-boundary', 'boundary-latest');
        appendMessages(chatContext, [
            factory.user('hidden-before-obsolete'),
            obsoleteBoundary,
            factory.user('hidden-before-latest'),
            latestBoundary,
            factory.user('u1'),
            factory.assistant('a1'),
            factory.user('u2'),
            factory.assistant('a2')
        ]);

        const plan = buildSessionMemoryCompactPlan(chatContext, SessionMemoryStates.create(), validMemory(), {
            minTokens: 1,
            minTextMessages: 10
        });

        expect(plan).toBeDefined();
        expect(chatContext.messages).not.toContain(obsoleteBoundary);
        expect(plan!.previousBoundary?.message).toBe(latestBoundary);
        expect(factory.labelsOf(plan!.messagesToKeep)).toEqual(['u1', 'a1', 'u2', 'a2']);
        expect(plan!.messagesToKeep.some(isCompactBoundaryMessage)).toBe(false);
    });

    test('apply 后 active context 变成 session memory boundary + kept tail', () => {
        const factory = createMessageFactory();
        const chatContext = new ChatContext();
        const previousBoundary = factory.boundary('previous-boundary', 'boundary-old');
        const keptUser = factory.user('kept-u');
        const keptAssistant = factory.assistant('kept-a');
        appendMessages(chatContext, [
            factory.user('hidden-u'),
            previousBoundary,
            factory.user('folded-u1'),
            factory.assistant('folded-a1'),
            keptUser,
            keptAssistant
        ]);

        const plan = buildSessionMemoryCompactPlan(chatContext, SessionMemoryStates.create(), validMemory(), {
            minTokens: 1,
            minTextMessages: 2,
            boundaryId: 'boundary-new'
        });
        expect(plan).toBeDefined();

        const result = buildSessionMemoryCompactResult(plan!, {
            boundaryId: 'boundary-new',
            createdAt: '2026-04-23T02:00:00.000Z'
        });
        applySessionMemoryCompactResult(chatContext, result);

        expect(chatContext.messages.filter(isCompactBoundaryMessage)).toEqual([result.boundary]);
        expect(chatContext.messages).not.toContain(previousBoundary);
        expect(result.boundary.summary).toContain('<session_memory>');
        expect(result.boundary.metadata).toMatchObject({
            boundary_id: 'boundary-new',
            previous_boundary_id: 'boundary-old',
            trigger: 'auto',
            strategy: SESSION_MEMORY_COMPACT_BOUNDARY_STRATEGY,
            kept_messages: 2
        });
        expect(buildActiveContextView(chatContext).messages).toEqual([result.boundary, keptUser, keptAssistant]);
    });
});

describe('session memory compact try/pipeline integration', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
        cleanupTempAppDirectory();
    });

    test('trySessionMemoryCompaction 在 post compact 仍超过阈值时返回 no-op 且不修改上下文', async () => {
        createTempAppDirectory();
        const taskId = 'task-threshold';
        writeTaskSessionMemory(taskId, validMemory());
        const chatContext = createCompactableChatContext();
        const state = SessionMemoryStates.deserialize({
            initialized: true,
            last_summarized_message_id: (chatContext.messages[3] as AssistantMessage).message_id
        });

        const result = await trySessionMemoryCompaction(
            chatContext,
            taskId,
            state,
            createAutoCompactDecision({
                contextWindow: 10,
                promptTokens: 10,
                buffer: 0
            }),
            {
                minTokens: 1,
                minTextMessages: 1
            }
        );

        expect(result.compacted).toBe(false);
        expect(result.noopReason).toBe('post_compact_threshold_exceeded');
        expect(chatContext.findCompactBoundary()).toBeUndefined();
    });

    test('pipeline 中 session memory compact 成功时不会调用 full compact summary', async () => {
        createTempAppDirectory();
        const now = new Date('2026-04-23T02:00:00.000Z');
        jest.setSystemTime(now);
        const taskId = 'task-pipeline-sm';
        writeTaskSessionMemory(taskId, validMemory());
        const chatContext = createCompactableChatContext();
        const autoCompactState = AutoCompactStates.create();
        const sessionMemoryState = SessionMemoryStates.deserialize({
            initialized: true,
            last_summarized_message_id: (chatContext.messages[3] as AssistantMessage).message_id,
            tokens_at_last_extraction: 12000
        });
        const askSpy = jest.spyOn(LLM, 'ask').mockResolvedValue('full compact should not run');

        const result = await prepareContextForModel(chatContext, 'demo-model', {
            autoCompactDecisionOverride: createAutoCompactDecision({
                contextWindow: 1000,
                promptTokens: 720,
                reservedSummaryOutput: 100
            }),
            autoCompactState,
            enableSessionMemoryCompact: true,
            taskId,
            sessionMemoryState,
            sessionMemoryCompactOptions: {
                minTokens: 1,
                minTextMessages: 2,
                boundaryId: 'boundary-session-memory',
                createdAt: now.toISOString()
            }
        });

        expect(result.compacted).toBe(true);
        expect(result.sessionMemoryCompacted).toBe(true);
        expect(result.sessionMemoryCompactResult?.compacted).toBe(true);
        expect(askSpy).not.toHaveBeenCalled();
        expect(autoCompactState.consecutiveFailures).toBe(0);
        expect(autoCompactState.lastSuccessAt).toBe(now.toISOString());

        const boundary = chatContext.findCompactBoundary();
        expect(boundary).toBeDefined();
        expect(boundary!.message.metadata).toMatchObject({
            boundary_id: 'boundary-session-memory',
            trigger: 'auto',
            strategy: SESSION_MEMORY_COMPACT_BOUNDARY_STRATEGY
        });
        expect(result.activeContext.messages[0]).toBe(boundary!.message);
    });

    test('pipeline 中 session memory no-op 时 fallback 到 full compact', async () => {
        createTempAppDirectory();
        const now = new Date('2026-04-23T02:00:00.000Z');
        jest.setSystemTime(now);
        const chatContext = createCompactableChatContext();
        const autoCompactState = AutoCompactStates.create();
        const askSpy = jest
            .spyOn(LLM, 'ask')
            .mockResolvedValue('<state_snapshot><overall_goal>fallback compact</overall_goal></state_snapshot>');

        const result = await prepareContextForModel(chatContext, 'demo-model', {
            autoCompactDecisionOverride: createAutoCompactDecision({
                contextWindow: 1000,
                promptTokens: 720,
                reservedSummaryOutput: 100
            }),
            autoCompactState,
            enableSessionMemoryCompact: true,
            taskId: 'task-missing-memory',
            sessionMemoryState: SessionMemoryStates.create()
        });

        expect(result.compacted).toBe(true);
        expect(result.sessionMemoryCompacted).toBe(false);
        expect(result.sessionMemoryCompactResult?.noopReason).toBe('missing_memory_file');
        expect(askSpy).toHaveBeenCalledTimes(1);
        expect(autoCompactState.lastSuccessAt).toBe(now.toISOString());
        expect(chatContext.findCompactBoundary()?.message.metadata.strategy).toBe(FULL_COMPACT_BOUNDARY_STRATEGY);
    });
});
