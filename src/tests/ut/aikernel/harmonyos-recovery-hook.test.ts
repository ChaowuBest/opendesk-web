import { jest } from '@jest/globals';
import { GlobalHooks } from '../../../main/aikernel/hooks.js';
import { BASH_FRICTION_FAILURE_THRESHOLD } from '../../../main/aikernel/harnesses/platform/harmonyos/constants.js';
import { registerHarmonyosBashFrictionHook } from '../../../main/aikernel/harnesses/platform/harmonyos/harmonyos-recovery/hook.js';
import { ToolCall } from '../../../main/aikernel/messages.js';
import type { TaskState } from '../../../main/aikernel/states/tasks.js';

function makeShellCall(toolName: string, exitCode: number | undefined): ToolCall {
    const toolCall = new ToolCall(0, `call-${toolName}-${Math.random()}`, toolName, '{"command":"false"}');
    toolCall.status = 'success';
    toolCall.result_object = exitCode === undefined ? {} : { exitCode };
    return toolCall;
}

function makeTask(): TaskState {
    return { appendInternalUserMessage: jest.fn() } as unknown as TaskState;
}

function promptedMessages(task: TaskState): string[] {
    const fn = task.appendInternalUserMessage as unknown as jest.Mock;
    return fn.mock.calls.map((call) => String(call[0]));
}

describe('harmonyos-recovery bash friction hook', () => {
    beforeAll(() => {
        registerHarmonyosBashFrictionHook();
    });

    test('executeZsh 失败达到阈值同样触发知识库提示（OpenHarmony 优先注册 zsh 工具）', async () => {
        const task = makeTask();
        for (let i = 0; i < BASH_FRICTION_FAILURE_THRESHOLD; i++) {
            await GlobalHooks.noticeAfterToolCall({ task, toolCall: makeShellCall('executeZsh', 1) });
        }

        const messages = promptedMessages(task);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain('harmonyos-recovery');
    });

    test('executeBash 失败达到阈值仍触发提示（原行为不回归）', async () => {
        const task = makeTask();
        for (let i = 0; i < BASH_FRICTION_FAILURE_THRESHOLD; i++) {
            await GlobalHooks.noticeAfterToolCall({ task, toolCall: makeShellCall('executeBash', 127) });
        }

        expect(promptedMessages(task)).toHaveLength(1);
    });
});
