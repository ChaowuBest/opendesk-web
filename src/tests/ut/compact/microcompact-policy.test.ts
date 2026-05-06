import {
    analyzeMicrocompactCandidatesForChatContext,
    createMicrocompactDecision
} from '../../../main/aikernel/compaction/microcompact';
import {
    AssistantMessage,
    ChatContext,
    ToolCall,
    ToolCallMessagePart,
    UserMessage
} from '../../../main/aikernel/messages';

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

function createMicrocompactableAnalysis() {
    return createMicrocompactableAnalysisWithOldResultCount(2);
}

function createMicrocompactableAnalysisWithOldResultCount(oldResultCount: number) {
    const chatContext = new ChatContext();
    chatContext.appendMessage(new UserMessage('run several tools'));

    for (let index = 1; index <= oldResultCount; index++) {
        const old = createToolAssistant(`old-${index}`, `old result ${index} `.repeat(80));
        chatContext.appendMessage(old.message);
    }

    const recent = createToolAssistant('recent', 'recent result should stay visible');
    chatContext.appendMessage(recent.message);

    return analyzeMicrocompactCandidatesForChatContext(chatContext, {
        tailAssistantMessages: 1
    });
}

describe('microcompact policy', () => {
    test('disabled 和 no_candidates 会返回 noop decision', () => {
        const analysis = createMicrocompactableAnalysis();

        expect(
            createMicrocompactDecision(analysis, {
                enabled: false,
                requestKind: 'task_turn',
                taskRole: 'main',
                taskId: 'task-microcompact-policy'
            })
        ).toMatchObject({
            mode: 'noop',
            reason: 'disabled',
            selectedResultIds: []
        });

        expect(
            createMicrocompactDecision(
                analyzeMicrocompactCandidatesForChatContext(new ChatContext(), {
                    tailAssistantMessages: 1
                }),
                {
                    enabled: true,
                    requestKind: 'task_turn',
                    taskRole: 'main',
                    taskId: 'task-microcompact-policy'
                }
            )
        ).toMatchObject({
            mode: 'noop',
            reason: 'no_candidates',
            selectedResultIds: []
        });
    });

    test('view_only、pre_submit_check、manual_compact 和 subtask 默认返回 noop', () => {
        const analysis = createMicrocompactableAnalysis();

        expect(
            createMicrocompactDecision(analysis, {
                enabled: true,
                requestKind: 'view_only',
                taskRole: 'main',
                taskId: 'task-microcompact-policy'
            })
        ).toMatchObject({
            mode: 'noop',
            reason: 'view_only'
        });

        expect(
            createMicrocompactDecision(analysis, {
                enabled: true,
                requestKind: 'pre_submit_check',
                taskRole: 'main',
                taskId: 'task-microcompact-policy'
            })
        ).toMatchObject({
            mode: 'noop',
            reason: 'pre_submit_check'
        });

        expect(
            createMicrocompactDecision(analysis, {
                enabled: true,
                requestKind: 'manual_compact',
                taskRole: 'main',
                taskId: 'task-microcompact-policy'
            })
        ).toMatchObject({
            mode: 'noop',
            reason: 'manual_compact'
        });

        expect(
            createMicrocompactDecision(analysis, {
                enabled: true,
                requestKind: 'task_turn',
                taskRole: 'subtask',
                taskId: 'task-microcompact-policy'
            })
        ).toMatchObject({
            mode: 'noop',
            reason: 'subtask_skipped'
        });
    });

    test('main task_turn 在暖路径下会给出 request_override decision', () => {
        const analysis = createMicrocompactableAnalysis();

        const decision = createMicrocompactDecision(analysis, {
            enabled: true,
            requestKind: 'task_turn',
            taskRole: 'main',
            taskId: 'task-microcompact-policy',
            state: {
                version: 1,
                lastAssistantCompletedAt: '2026-05-05T00:30:00.000Z'
            },
            now: new Date('2026-05-05T01:00:00.000Z')
        });

        expect(decision.mode).toBe('request_override');
        expect(decision.reason).toBe('warm_path_request_override');
        expect(decision.selectedResultIds).toHaveLength(2);
        expect(decision.keptRecentResultIds).toHaveLength(0);
        expect(decision.idleGapMinutes).toBe(30);
        expect(decision.estimatedCharsBefore).toBeGreaterThan(decision.estimatedCharsAfter);
        expect(decision.estimatedCharsSaved).toBeGreaterThan(0);
    });

    test('main task_turn 在冷路径下会给出 local_clear decision，并保留最近 5 个结果', () => {
        const analysis = createMicrocompactableAnalysisWithOldResultCount(7);

        const decision = createMicrocompactDecision(analysis, {
            enabled: true,
            requestKind: 'task_turn',
            taskRole: 'main',
            taskId: 'task-microcompact-policy',
            state: {
                version: 1,
                lastAssistantCompletedAt: '2026-05-04T23:00:00.000Z'
            },
            now: new Date('2026-05-05T00:01:00.000Z'),
            keepRecentResults: 5
        });

        expect(decision.mode).toBe('local_clear');
        expect(decision.reason).toBe('cold_path_local_clear');
        expect(decision.idleGapMinutes).toBe(61);
        expect(decision.selectedResultIds).toHaveLength(2);
        expect(decision.keptRecentResultIds).toHaveLength(5);
        expect(new Set(decision.selectedResultIds).size).toBe(2);
        expect(new Set(decision.keptRecentResultIds).size).toBe(5);
        for (const resultId of decision.keptRecentResultIds) {
            expect(decision.selectedResultIds).not.toContain(resultId);
        }
    });

    test('mode override 和缺少 taskId 的情况会返回对应 decision', () => {
        const analysis = createMicrocompactableAnalysis();

        expect(
            createMicrocompactDecision(analysis, {
                enabled: true,
                requestKind: 'task_turn',
                taskRole: 'main',
                taskId: 'task-microcompact-policy',
                modeOverride: 'request_override'
            })
        ).toMatchObject({
            mode: 'request_override',
            reason: 'mode_override'
        });

        expect(
            createMicrocompactDecision(analysis, {
                enabled: true,
                requestKind: 'task_turn',
                taskRole: 'main',
                taskId: 'task-microcompact-policy',
                modeOverride: 'local_clear'
            })
        ).toMatchObject({
            mode: 'local_clear',
            reason: 'mode_override'
        });

        expect(
            createMicrocompactDecision(analysis, {
                enabled: true,
                requestKind: 'task_turn',
                taskRole: 'main'
            })
        ).toMatchObject({
            mode: 'noop',
            reason: 'missing_task_id'
        });
    });
});
