import { resetFeatureManagerForTests, getFeatureManager } from '../../../common/features/manager.js';
import { getLongTermMemorySection, getUserPortraitSection } from '../../../main/aikernel/agents/main/agent.js';
import { BaseToolset } from '../../../main/aikernel/tool.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';

describe('memory 特性禁用联动', () => {
    afterEach(() => {
        resetFeatureManagerForTests();
    });

    test('禁用后主 Agent 不注入用户画像与长期记忆段落', async () => {
        // 未禁用时段落存在
        expect(getLongTermMemorySection()).toContain('# 长期记忆');

        getFeatureManager().setFeatureDisabled('memory', 'plugin-a', true);

        expect(getLongTermMemorySection()).toBeNull();
        await expect(getUserPortraitSection()).resolves.toBeNull();
    });

    test('禁用后任务工具集不包含记忆工具集，恢复后重新注入', async () => {
        const manager = new TaskManagerState();
        manager.toolsetProvider = {
            listAvailableToolsets: async () => [] as BaseToolset[]
        };

        const enabledTask = new TaskState(manager);
        const enabledToolsets = await enabledTask.buildToolsets();
        expect(enabledToolsets.some((toolset) => toolset.name === 'memory')).toBe(true);

        getFeatureManager().setFeatureDisabled('memory', 'plugin-a', true);

        const disabledTask = new TaskState(manager);
        const disabledToolsets = await disabledTask.buildToolsets();
        expect(disabledToolsets.some((toolset) => toolset.name === 'memory')).toBe(false);
    });
});
