import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildActiveContextView } from '../../../main/aikernel/compaction/context-view';
import {
    ToolResultReplacementStates,
    buildToolResultBudgetProjectionForChatContext,
    getToolResultArtifactPath
} from '../../../main/aikernel/compaction/tool-results';
import {
    AssistantMessage,
    ChatContext,
    ToolCall,
    ToolCallMessagePart,
    UserMessage
} from '../../../main/aikernel/messages';
import { setCustomAppDirectory } from '../../../main/utils/setting';

let tempRootDir: string | undefined;

function createTempAppDirectory(): string {
    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-tool-budget-smoke-'));
    setCustomAppDirectory(tempRootDir);
    return tempRootDir;
}

function cleanupTempAppDirectory(): void {
    if (tempRootDir && fs.existsSync(tempRootDir)) {
        fs.rmSync(tempRootDir, { recursive: true, force: true });
    }
    tempRootDir = undefined;
}

function createAssistantWithToolResult(result: string): { message: AssistantMessage; toolCall: ToolCall } {
    const message = new AssistantMessage();
    message.appendText('assistant produced a large shell result');

    const toolCall = new ToolCall(0, 'tool-budget-call', 'executePowerShell', '{"command":"Get-Content large.log"}');
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
