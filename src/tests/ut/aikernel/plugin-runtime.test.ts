import { z } from 'zod';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { BaseTool, BaseToolset } from '../../../main/aikernel/tool.js';

describe('AI kernel plugin runtime', () => {
    test('refreshToolsets 会移除旧工具集并挂载 provider 的最新结果', async () => {
        const manager = new TaskManagerState();
        let version = 'before';
        manager.toolsetProvider = {
            async listAvailableToolsets() {
                const toolset = new BaseToolset(`plugin:${version}`);
                toolset.addTool(new BaseTool(`demo.${version}`, version, z.object({})));
                return [toolset];
            }
        };
        const task = new TaskState(manager);

        await task.refreshToolsets();
        expect(task.chat_context.toolsets.has('plugin:before')).toBe(true);

        version = 'after';
        await task.refreshToolsets();

        expect(task.chat_context.toolsets.has('plugin:before')).toBe(false);
        expect(task.chat_context.toolsets.get('plugin:after')?.getTool('demo.after')).toBeDefined();
    });

    test('停止任务会取消插件工具收到的 signal', () => {
        const manager = new TaskManagerState();
        manager.save = () => {};
        manager.publishTaskListUpdate = () => {};
        const task = new TaskState(manager);
        const signal = task.getAbortSignal();

        task.stop();

        expect(signal.aborted).toBe(true);
    });
});
