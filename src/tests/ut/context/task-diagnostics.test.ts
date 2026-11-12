import fs from 'fs';
import os from 'os';
import path from 'path';
import { createAutoCompactDecision } from '../../../main/aikernel/compaction/auto-compact';
import {
    AssistantMessage,
    ChatContext,
    SystemMessage,
    ToolCall,
    ToolCallMessagePart,
    Usage,
    UserMessage
} from '../../../main/aikernel/messages';
import { buildTaskContextDiagnostics } from '../../../main/aikernel/context/task-diagnostics';
import { setCustomOpendeskDirectory } from '../../../main/utils/setting';

let tempRootDir: string | undefined;

function createTempAppDirectory(): string {
    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-task-diagnostics-'));
    setCustomOpendeskDirectory(tempRootDir);
    return tempRootDir;
}

function cleanupTempAppDirectory(): void {
    if (tempRootDir && fs.existsSync(tempRootDir)) {
        fs.rmSync(tempRootDir, { recursive: true, force: true });
    }
    tempRootDir = undefined;
}

function createTaskChatContext(): ChatContext {
    const chatContext = new ChatContext();
    chatContext.system_prompt = new SystemMessage('you are a helpful assistant');
    chatContext.appendMessage(new UserMessage('hello'));

    const message = new AssistantMessage();
    message.appendText('hi there');
    const toolCall = new ToolCall(0, 'tool-1', 'readFile', '{"path":"a.txt"}');
    toolCall.status = 'success';
    toolCall.result = 'file content';
    const part = new ToolCallMessagePart();
    part.push(toolCall);
    message.appendToolCallPart(part);
    message.usage = new Usage(100, 50, 150);
    chatContext.appendMessage(message);

    return chatContext;
}

function createTask(chatContext: ChatContext, resolvedModel: string | undefined) {
    return {
        task_id: 'task-context-gui',
        parent_id: null as string | null,
        chat_context: chatContext,
        ensureValidModelOrFallback: () => resolvedModel
    };
}

describe('buildTaskContextDiagnostics', () => {
    beforeEach(() => {
        createTempAppDirectory();
    });

    afterEach(() => {
        cleanupTempAppDirectory();
    });

    test('returns a serializable report with the four fixed categories and suggestions', async () => {
        const chatContext = createTaskChatContext();
        const { report, suggestions } = await buildTaskContextDiagnostics(
            createTask(chatContext, undefined),
            'default-model',
            {
                autoCompactDecisionOverride: createAutoCompactDecision({
                    contextWindow: 100_000,
                    estimatedContextTokens: 40_000,
                    reservedSummaryOutput: 1_000,
                    buffer: 0
                })
            }
        );

        expect(report.modelName).toBe('default-model');
        expect(report.contextWindow).toBe(100_000);
        expect(report.totalEstimatedTokens).toBeGreaterThan(0);
        expect(report.usageRatio).toBeCloseTo(0.4, 5);
        expect(report.categories.map((category) => category.name)).toEqual([
            'System prompt',
            'Tools',
            'Messages',
            'Free space'
        ]);
        const categoryTokens = report.categories.reduce((sum, category) => sum + category.tokens, 0);
        expect(categoryTokens).toBeGreaterThan(0);
        expect(report.messageBreakdown.userTextTokens).toBeGreaterThan(0);
        expect(report.messageBreakdown.assistantToolResultTokens).toBeGreaterThan(0);
        expect(Array.isArray(suggestions)).toBe(true);
        // 报告会跨 IPC 传输给 renderer，必须是可结构化克隆的纯数据
        expect(() => JSON.stringify({ report, suggestions })).not.toThrow();
    });

    test('prefers the model resolved by the task over the fallback model', async () => {
        const chatContext = createTaskChatContext();
        const { report } = await buildTaskContextDiagnostics(createTask(chatContext, 'task-model'), 'fallback-model', {
            autoCompactDecisionOverride: createAutoCompactDecision({
                contextWindow: 100_000,
                estimatedContextTokens: 10_000,
                reservedSummaryOutput: 1_000,
                buffer: 0
            })
        });

        expect(report.modelName).toBe('task-model');
    });

    test('flags the near auto-compact threshold suggestion when usage is high', async () => {
        const chatContext = createTaskChatContext();
        const { report, suggestions } = await buildTaskContextDiagnostics(
            createTask(chatContext, undefined),
            'default-model',
            {
                autoCompactDecisionOverride: createAutoCompactDecision({
                    contextWindow: 1_000,
                    estimatedContextTokens: 950,
                    reservedSummaryOutput: 100,
                    buffer: 0
                })
            }
        );

        expect(report.usageRatio).toBeCloseTo(0.95, 5);
        expect(suggestions.some((suggestion) => suggestion.id === 'near-auto-compact-threshold')).toBe(true);
    });
});
