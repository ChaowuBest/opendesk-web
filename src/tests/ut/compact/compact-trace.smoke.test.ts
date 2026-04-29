import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import { AutoCompactStates, createAutoCompactDecision } from '../../../main/aikernel/compaction/auto-compact';
import { prepareContextForModel } from '../../../main/aikernel/compaction/pipeline';
import { SessionMemoryStates, writeTaskSessionMemory } from '../../../main/aikernel/compaction/session-memory-compact';
import { LLM } from '../../../main/aikernel/llm';
import {
    AssistantMessage,
    ChatContext,
    ToolCall,
    ToolCallMessagePart,
    UserMessage
} from '../../../main/aikernel/messages';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks';
import { getTaskArtifactDirectory, setCustomAppDirectory } from '../../../main/utils/setting';

interface CompactTraceRecord {
    ts: string;
    level: 'info';
    taskId: string;
    source: string;
    event: string;
    message: string;
    data?: Record<string, unknown>;
}

let tempRootDir: string | undefined;

function createTempAppDirectory(): string {
    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-compact-trace-'));
    setCustomAppDirectory(tempRootDir);
    return tempRootDir;
}

function cleanupTempAppDirectory(): void {
    if (tempRootDir && fs.existsSync(tempRootDir)) {
        fs.rmSync(tempRootDir, { recursive: true, force: true });
    }
    tempRootDir = undefined;
}

function createCompactableChatContext(): ChatContext {
    const chatContext = new ChatContext();
    for (let index = 1; index <= 5; index++) {
        chatContext.appendMessage(new UserMessage(`user ${index}`));
        const assistantMessage = new AssistantMessage();
        assistantMessage.appendText(`assistant ${index}`);
        chatContext.appendMessage(assistantMessage);
    }
    return chatContext;
}

function appendAssistantRound(message: AssistantMessage, roundLabel: string, result: string): void {
    message.appendReasoningContent(`reasoning ${roundLabel}`);
    message.appendText(`assistant ${roundLabel}`);

    const toolCall = new ToolCall(0, `tool-${roundLabel}`, 'executePowerShell', `{"round":"${roundLabel}"}`);
    toolCall.status = 'success';
    toolCall.result = result;

    const part = new ToolCallMessagePart();
    part.push(toolCall);
    message.appendToolCallPart(part);
}

function createLargeAssistantForSessionMemory(): AssistantMessage {
    const message = new AssistantMessage();
    appendAssistantRound(message, 'old-round-1', 'old round 1 '.repeat(80));
    appendAssistantRound(message, 'old-round-2', 'old round 2 '.repeat(80));
    appendAssistantRound(message, 'recent-round-3', 'recent round 3 should stay visible');
    return message;
}

function validMemory(): string {
    return `# Session Title
trace test memory

# Current State
trace test current state

# Task Specification
trace test specification

# Files and Functions
trace test files

# Workflow
trace test workflow

# Errors & Corrections
trace test corrections

# Key Results
trace test results

# Worklog
- trace test worklog
`;
}

function readTraceRecords(taskId: string): CompactTraceRecord[] {
    const tracePath = path.join(getTaskArtifactDirectory(taskId, false), 'compact.ndjson');
    expect(fs.existsSync(tracePath)).toBe(true);
    return fs
        .readFileSync(tracePath, 'utf8')
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as CompactTraceRecord);
}

describe('compact trace artifact', () => {
    afterEach(() => {
        jest.restoreAllMocks();
        cleanupTempAppDirectory();
    });

    test('prepareContextForModel writes compact-related trace lines to artifacts/<taskId>/compact.ndjson', async () => {
        createTempAppDirectory();
        const taskId = 'task-compact-trace-pipeline';
        const askSpy = jest
            .spyOn(LLM, 'ask')
            .mockResolvedValue('<state_snapshot><overall_goal>trace</overall_goal></state_snapshot>');

        const result = await prepareContextForModel(createCompactableChatContext(), 'demo-model', {
            taskId,
            enableSessionMemoryCompact: true,
            autoCompactState: AutoCompactStates.create(),
            autoCompactDecisionOverride: createAutoCompactDecision({
                contextWindow: 1000,
                promptTokens: 720,
                reservedSummaryOutput: 100
            })
        });

        expect(result.compacted).toBe(true);
        expect(askSpy).toHaveBeenCalledTimes(1);

        const records = readTraceRecords(taskId);
        expect(records.length).toBeGreaterThanOrEqual(4);
        expect(records.every((record) => record.taskId === taskId)).toBe(true);
        expect(records.every((record) => record.level === 'info')).toBe(true);
        expect(records.map((record) => record.event)).toEqual(
            expect.arrayContaining([
                'compaction_path_defaults',
                'session_memory_compact_noop',
                'assistant_round_boundary_default',
                'full_compact_started',
                'full_compact_completed',
                'keep_anchor_selected'
            ])
        );
        expect(records.some((record) => record.source === 'pipeline')).toBe(true);
        expect(records.some((record) => record.source === 'compact')).toBe(true);

        const defaultsRecord = records.find((record) => record.event === 'compaction_path_defaults');
        expect(defaultsRecord?.data).toMatchObject({
            defaultCompactionPath: 'session_memory_then_full_compact',
            enableAssistantRoundBoundary: true,
            enableSessionMemoryCompact: true
        });

        const completedRecord = records.find((record) => record.event === 'full_compact_completed');
        expect(completedRecord?.data).toMatchObject({
            compactVariant: 'message_tail',
            keepAnchorKind: 'message_start',
            recentUserPreserved: false
        });
        expect(completedRecord?.data?.physicalKeepStartIndex).toEqual(expect.any(Number));

        const anchorRecord = records.find((record) => record.event === 'keep_anchor_selected');
        expect(anchorRecord?.data).toMatchObject({
            compactVariant: 'message_tail',
            keepAnchorKind: 'message_start',
            recentUserPreserved: false
        });
    });

    test('task-local compact info logs also append to compact.ndjson', async () => {
        createTempAppDirectory();
        const task = new TaskState(new TaskManagerState());
        task.task_id = 'task-compact-trace-task-state';
        task.chat_context.appendMessage(new UserMessage('hello compact trace'));

        const result = await task.maybeUpdateSessionMemoryAfterCompletion();

        expect(result.skipped).toBe(true);

        const records = readTraceRecords(task.task_id);
        expect(records.map((record) => record.event)).toContain('session_memory_update_skipped');
        expect(records.some((record) => record.source === 'tasks')).toBe(true);
    });

    test('session memory compact trace records include compact variant and anchor fields', async () => {
        createTempAppDirectory();
        const taskId = 'task-compact-trace-session-memory';
        writeTaskSessionMemory(taskId, validMemory());
        const chatContext = new ChatContext();
        const recentUser = new UserMessage('keep watching the build output');
        const bigAssistant = createLargeAssistantForSessionMemory();
        chatContext.appendMessage(recentUser);
        chatContext.appendMessage(bigAssistant);

        const askSpy = jest.spyOn(LLM, 'ask').mockResolvedValue('full compact should not run');

        const result = await prepareContextForModel(chatContext, 'demo-model', {
            taskId,
            enableSessionMemoryCompact: true,
            sessionMemoryState: SessionMemoryStates.create(),
            autoCompactState: AutoCompactStates.create(),
            autoCompactDecisionOverride: createAutoCompactDecision({
                contextWindow: 1000,
                promptTokens: 720,
                reservedSummaryOutput: 100
            }),
            sessionMemoryCompactOptions: {
                minTokens: 1,
                minTextMessages: 1,
                maxTokens: 300,
                boundaryId: 'boundary-trace-session-memory',
                createdAt: '2026-04-27T00:00:00.000Z'
            }
        });

        expect(result.compacted).toBe(true);
        expect(result.sessionMemoryCompacted).toBe(true);
        expect(askSpy).not.toHaveBeenCalled();

        const records = readTraceRecords(taskId);
        expect(records.map((record) => record.event)).toEqual(
            expect.arrayContaining(['compaction_path_defaults', 'session_memory_compact_applied'])
        );

        const defaultsRecord = records.find((record) => record.event === 'compaction_path_defaults');
        expect(defaultsRecord?.data).toMatchObject({
            defaultCompactionPath: 'session_memory_then_full_compact',
            enableAssistantRoundBoundary: true,
            enableSessionMemoryCompact: true
        });

        const appliedRecord = records.find((record) => record.event === 'session_memory_compact_applied');
        expect(appliedRecord?.data).toMatchObject({
            compactVariant: 'boundary_user_partial_assistant',
            physicalKeepStartIndex: 0,
            keepAnchorKind: 'assistant_round',
            kept_anchor_round_index: 2,
            kept_anchor_start_part_index: 6,
            recentUserPreserved: true
        });
    });
});
