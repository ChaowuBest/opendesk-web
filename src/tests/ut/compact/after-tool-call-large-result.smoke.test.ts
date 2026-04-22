import fs from 'fs';
import os from 'os';
import path from 'path';
import '../../../main/aikernel/compact';
import { getToolResultArtifactPath } from '../../../main/aikernel/compaction/tool-results';
import { HookRegistry } from '../../../main/aikernel/hooks';
import { ToolCall } from '../../../main/aikernel/messages';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks';
import { setCustomAppDirectory } from '../../../main/utils/setting';

let tempRootDir: string | undefined;

function createTempAppDirectory(): void {
    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-after-tool-smoke-'));
    setCustomAppDirectory(tempRootDir);
}

function cleanupTempAppDirectory(): void {
    if (tempRootDir && fs.existsSync(tempRootDir)) {
        fs.rmSync(tempRootDir, { recursive: true, force: true });
    }
    tempRootDir = undefined;
}

describe('compact smoke: afterToolCall large result storage', () => {
    afterEach(() => {
        cleanupTempAppDirectory();
    });

    test('全局 afterToolCall hook 会把超大工具结果落盘并替换为 preview', async () => {
        createTempAppDirectory();
        const task = new TaskState(new TaskManagerState(), null);
        task.task_id = 'task-after-tool-smoke';
        const toolCall = new ToolCall(0, 'large-tool-call', 'executePowerShell', '{"command":"type huge.log"}');
        const originalResult = `HEAD\n${'x'.repeat(120_000)}\nTAIL`;
        toolCall.status = 'success';
        toolCall.result = originalResult;

        await HookRegistry.noticeAfterToolCall(task, toolCall);

        const resultId = toolCall.result_storage?.result_id;
        expect(resultId).toBeDefined();
        expect(toolCall.result).not.toBe(originalResult);
        expect(toolCall.result).toContain('完整输出已保存至');
        expect(toolCall.result_storage?.replacement_text).toBe(toolCall.result);
        expect(toolCall.result_storage?.original_chars).toBe(originalResult.length);
        expect(fs.readFileSync(getToolResultArtifactPath(task.task_id, resultId!, false), 'utf8')).toBe(originalResult);
    });
});
