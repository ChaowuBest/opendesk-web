import { Skill, SkillRegistry } from '../../../main/aikernel/skill';
import { BaseTool, BaseToolset } from '../../../main/aikernel/tool';
import { z } from 'zod';

const TEST_BUNDLE = 'test-call-skill';
const TEST_SKILL = 'manage-skills';

function registerSkillWithTool(tool: BaseTool<any>): BaseTool<any> {
    const toolset = new BaseToolset('test-tools');
    toolset.addTool(tool);

    const skill = new Skill(
        {
            name: TEST_SKILL,
            description: 'Test skill'
        },
        '',
        undefined,
        [toolset]
    );

    const registry = SkillRegistry.getInstance();
    registry.unregisterSkillProvider(TEST_BUNDLE);
    registry.registerSkillProvider(TEST_BUNDLE, {
        getSkills: async () => [skill]
    });

    const callTool = registry.getToolset().getTool('CallSkillTool');
    if (!callTool) {
        throw new Error('CallSkillTool not found');
    }
    return callTool;
}

describe('CallSkillTool', () => {
    afterEach(() => {
        SkillRegistry.getInstance().unregisterSkillProvider(TEST_BUNDLE);
    });

    test('treats blank string toolArgs as an empty object', async () => {
        let receivedArgs: unknown;
        const refreshTool = new BaseTool('refreshSkills', 'Refresh skills', z.object({}));
        refreshTool.setExecutor(async (args) => {
            receivedArgs = args;
            return JSON.stringify({ count: 1, errors: [] });
        });

        const callTool = registerSkillWithTool(refreshTool);
        const result = await callTool.execute({
            bundleName: TEST_BUNDLE,
            skillName: TEST_SKILL,
            toolName: 'refreshSkills',
            toolArgs: ''
        });

        expect(result.status).toBe('success');
        expect(receivedArgs).toEqual({});
        expect(result.result).toBe(JSON.stringify({ count: 1, errors: [] }));
    });

    test('allows omitting toolArgs for no-argument inner tools', async () => {
        let receivedArgs: unknown;
        const refreshTool = new BaseTool('refreshSkills', 'Refresh skills', z.object({}));
        refreshTool.setExecutor(async (args) => {
            receivedArgs = args;
            return JSON.stringify({ count: 1, errors: [] });
        });

        const callTool = registerSkillWithTool(refreshTool);
        const result = await callTool.execute({
            bundleName: TEST_BUNDLE,
            skillName: TEST_SKILL,
            toolName: 'refreshSkills'
        });

        expect(result.status).toBe('success');
        expect(receivedArgs).toEqual({});
        expect(result.result).toBe(JSON.stringify({ count: 1, errors: [] }));
    });

    test('propagates inner tool failures as outer tool errors', async () => {
        const failingTool = new BaseTool('failingTool', 'Failing tool', z.object({}));
        failingTool.setExecutor(async () => {
            throw new Error('inner failure');
        });

        const callTool = registerSkillWithTool(failingTool);
        const result = await callTool.execute({
            bundleName: TEST_BUNDLE,
            skillName: TEST_SKILL,
            toolName: 'failingTool',
            toolArgs: {}
        });

        expect(result.status).toBe('error');
        expect(result.result).toContain('工具调用失败: inner failure');
    });
});
