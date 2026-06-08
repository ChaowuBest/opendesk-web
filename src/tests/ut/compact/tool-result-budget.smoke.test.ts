import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildActiveContextView } from '../../../main/aikernel/compaction/context-view';
import {
    ToolResultReplacementStates,
    buildToolResultBudgetProjectionForChatContext,
    getToolResultArtifactPath,
    isToolResultCompressionExcluded
} from '../../../main/aikernel/compaction/tool-results';
import {
    AssistantMessage,
    ChatContext,
    ToolCall,
    ToolCallMessagePart,
    UserMessage
} from '../../../main/aikernel/messages';
import { setCustomOpendeskDirectory } from '../../../main/utils/setting';

let tempRootDir: string | undefined;

function createTempAppDirectory(): string {
    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-tool-budget-smoke-'));
    setCustomOpendeskDirectory(tempRootDir);
    return tempRootDir;
}

function cleanupTempAppDirectory(): void {
    if (tempRootDir && fs.existsSync(tempRootDir)) {
        fs.rmSync(tempRootDir, { recursive: true, force: true });
    }
    tempRootDir = undefined;
}

function createAssistantWithToolResult(
    result: string,
    toolName: string = 'executePowerShell',
    toolCallId: string = 'tool-budget-call'
): { message: AssistantMessage; toolCall: ToolCall } {
    const message = new AssistantMessage();
    message.appendText('assistant produced a large shell result');

    const toolCall = new ToolCall(0, toolCallId, toolName, '{"command":"Get-Content large.log"}');
    toolCall.status = 'success';
    toolCall.result = result;

    const part = new ToolCallMessagePart();
    part.push(toolCall);
    message.appendToolCallPart(part);

    return { message, toolCall };
}

describe('compact smoke: tool result budget', () => {
    afterEach(() => {
        cleanupTempAppDirectory();
    });

    test('readFile 仍默认排除在 Step 4 tool result budget 之外，并兼容带 toolset 前缀的工具名', () => {
        createTempAppDirectory();
        const chatContext = new ChatContext();
        chatContext.appendMessage(new UserMessage('inspect the file contents'));

        const directReadFile = createAssistantWithToolResult(
            `HEAD\n${'a'.repeat(12_000)}\nTAIL`,
            'readFile',
            'tool-budget-read-file'
        );
        const prefixedReadFile = createAssistantWithToolResult(
            `HEAD\n${'b'.repeat(12_000)}\nTAIL`,
            'filemgr-readFile',
            'tool-budget-prefixed-read-file'
        );
        chatContext.appendMessage(directReadFile.message);
        chatContext.appendMessage(prefixedReadFile.message);

        expect(isToolResultCompressionExcluded('readFile')).toBe(true);
        expect(isToolResultCompressionExcluded('filemgr-readFile')).toBe(true);
        expect(isToolResultCompressionExcluded('executePowerShell')).toBe(false);

        const projection = buildToolResultBudgetProjectionForChatContext(
            chatContext,
            'task-tool-budget-read-file-excluded',
            ToolResultReplacementStates.create(),
            {
                groupBudgetChars: 1_000
            }
        );

        expect(projection.overrides.size).toBe(0);
        expect(projection.stats.candidateCount).toBe(0);
        expect(projection.stats.skippedCount).toBe(2);
        expect(projection.stats.skippedByReason.excluded_tool).toBe(2);
        expect(directReadFile.toolCall.result_storage).toBeUndefined();
        expect(prefixedReadFile.toolCall.result_storage).toBeUndefined();
    });

    test('query 前预算会为超大工具结果生成稳定 override、artifact 和 replacement state', () => {
        createTempAppDirectory();
        const chatContext = new ChatContext();
        chatContext.appendMessage(new UserMessage('please inspect the command output'));
        const largeResult = `HEAD\n${'x'.repeat(12_000)}\nTAIL`;
        const { message, toolCall } = createAssistantWithToolResult(largeResult);
        chatContext.appendMessage(message);

        const replacementState = ToolResultReplacementStates.create();
        const projection = buildToolResultBudgetProjectionForChatContext(
            chatContext,
            'task-tool-budget-smoke',
            replacementState,
            {
                groupBudgetChars: 1_000,
                previewOptions: {
                    headChars: 80,
                    tailChars: 80
                }
            }
        );

        const resultId = toolCall.result_storage?.result_id;
        expect(resultId).toBeDefined();
        expect(toolCall.result).toBe(largeResult);
        expect(toolCall.result_storage?.replacement_text).toContain('完整输出已保存至');
        expect(projection.overrides.get(resultId!)).toBe(toolCall.result_storage?.replacement_text);
        expect(projection.replacementState.replacements.get(resultId!)?.replacement_text).toBe(
            toolCall.result_storage?.replacement_text
        );
        expect(projection.stats.newlySelectedCount).toBe(1);
        expect(projection.stats.persistedCount).toBe(1);
        expect(projection.stats.overBudgetGroupCount).toBe(0);
        expect(fs.readFileSync(getToolResultArtifactPath('task-tool-budget-smoke', resultId!, false), 'utf8')).toBe(
            largeResult
        );
        expect(buildActiveContextView(chatContext).messages).toHaveLength(2);

        const rerun = buildToolResultBudgetProjectionForChatContext(
            chatContext,
            'task-tool-budget-smoke',
            projection.replacementState,
            { groupBudgetChars: 1_000 }
        );
        expect(rerun.overrides.get(resultId!)).toBe(toolCall.result_storage?.replacement_text);
        expect(rerun.stats.reappliedCount).toBe(1);
    });
});
