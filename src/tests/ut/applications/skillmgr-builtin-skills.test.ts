import { afterEach, describe, expect, test } from '@jest/globals';
import { BaseTool, BaseToolset } from '../../../main/aikernel/tool.js';
import { Skill, SkillRegistry as AISkillRegistry } from '../../../main/aikernel/skill.js';
import { SkillMgrApplication, isStaffSkillBundle } from '../../../main/applications/skillmgr/app.js';
import { ApplicationRegistry } from '../../../main/applications/registry.js';
import type { McpServerState } from '../../../main/applications/mcpmgr/common.js';

function registerBundle(bundleName: string, skillName: string): void {
    const provider = {
        getSkills: async () => [new Skill({ name: skillName, description: 'd' }, 'body')]
    };
    AISkillRegistry.getInstance().registerSkillProvider(bundleName, provider);
}

/** getBuiltinSkills 只消费 name/description/getJsonSchema，最小桩即可 */
function makeFakeTool(name: string, description: string): BaseTool<any> {
    return {
        name,
        description,
        getJsonSchema: () => ({})
    } as unknown as BaseTool<any>;
}

describe('技能中心 builtin 技能列表', () => {
    afterEach(() => {
        AISkillRegistry.getInstance().unregisterSkillProvider('builtin-demo');
        AISkillRegistry.getInstance().unregisterSkillProvider('staff:staff-1');
        AISkillRegistry.getInstance().unregisterSkillProvider('pluginMgr');
        ApplicationRegistry.applications.delete('mcpmgr');
    });

    test('isStaffSkillBundle 识别 agentoffice staff 技能 bundle', () => {
        expect(isStaffSkillBundle('staff:staff-1')).toBe(true);
        expect(isStaffSkillBundle('staff:')).toBe(true);
        expect(isStaffSkillBundle('builtin-demo')).toBe(false);
        expect(isStaffSkillBundle('pluginMgr')).toBe(false);
    });

    test('getBuiltinSkills 不展示 agentoffice staff 的技能，正常 bundle 不受影响', async () => {
        registerBundle('builtin-demo', 'demo-skill');
        registerBundle('staff:staff-1', 'staff-only-skill');

        const skills = await SkillMgrApplication.prototype.getBuiltinSkills.call({});
        const ids = skills.map((skill) => skill.id);
        expect(ids).toContain('builtin-demo/demo-skill');
        expect(ids.some((id) => id.startsWith('staff:'))).toBe(false);
    });

    test('getBuiltinSkills：技能加载后（resolver 写回 toolsets）不重复展示内部 MCP 工具', async () => {
        // worker 侧实时状态：内部 server 已连接、发现原始名 read 工具
        const fakeMcpMgr = {
            bundleName: 'mcpmgr',
            getPluginSkillServers: async (): Promise<McpServerState[]> => [
                {
                    id: 'pluginskill_x',
                    name: 'fs',
                    transport: 'stdio',
                    enabled: true,
                    status: 'connected',
                    pluginId: 'p1',
                    pluginSkillName: 'mcp-skill',
                    tools: [
                        { name: 'read', description: 'Read a file', inputSchema: { type: 'object' } },
                        // 与静态工具同名：模型侧会带 server 前缀消歧，展示层按名去重不重复出现
                        { name: 'p1-t', description: 'dup of static tool name', inputSchema: {} }
                    ]
                } as McpServerState
            ]
        };
        ApplicationRegistry.applications.set('mcpmgr', fakeMcpMgr as any);

        // 模拟 loadSkillForAgent 之后的状态：resolver 把静态与内部 MCP 工具集写回 Skill.toolsets
        const skill = new Skill({ name: 'mcp-skill', description: 'd' }, 'body');
        skill.attribution = { sourceId: 'p1', sourceName: 'P1' };
        const staticToolset = new BaseToolset('plugin-skill-p1-mcp-skill');
        staticToolset.addTool(makeFakeTool('p1-t', 'static tool'));
        const mcpToolset = new BaseToolset('plugin-mcp-p1-fs');
        mcpToolset.addTool(makeFakeTool('fs__read', 'Read a file'));
        skill.toolsets = [staticToolset, mcpToolset];
        AISkillRegistry.getInstance().registerSkillProvider('pluginMgr', { getSkills: async () => [skill] });

        const skills = await SkillMgrApplication.prototype.getBuiltinSkills.call({});
        const target = skills.find((item) => item.id === 'pluginMgr/mcp-skill');
        // 内部 MCP 工具只按 worker 原始名（read）出现一次；模型可见名（fs__read）不重复展示
        expect(target?.tools.map((tool) => tool.name)).toEqual(['p1-t', 'read']);
    });
});
