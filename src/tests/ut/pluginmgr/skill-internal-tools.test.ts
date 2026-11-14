import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { z } from 'zod';
import { ApplicationRegistry, notifyGlobalWorkerRestarted } from '../../../main/applications/registry.js';
import { SkillRegistry } from '../../../main/aikernel/skill.js';
import type { BaseTool } from '../../../main/aikernel/tool.js';
import type { McpServerConfig, McpServerState } from '../../../main/applications/mcpmgr/common.js';
import {
    disposePluginContributions,
    initializePluginContributions,
    PLUGIN_SKILL_BUNDLE
} from '../../../main/applications/pluginmgr/runtime/contributions.js';
import { getPluginHost } from '../../../main/applications/pluginmgr/runtime/host.js';
import {
    buildSkillMcpToolsets,
    pluginSkillServerId,
    registerPluginSkillServerResync,
    syncPluginSkillServers
} from '../../../main/applications/pluginmgr/runtime/skill-mcp.js';
import { PluginToolsetProvider } from '../../../main/applications/pluginmgr/runtime/tool-provider.js';
import { definePlugin } from '../../../../packages/plugin-sdk/src/index.js';

/** 与 MCPMgr 应用交互的 fake（只需 skill-mcp.ts 用到的公开方法） */
function createFakeMcpMgrApp() {
    const replaced: McpServerConfig[][] = [];
    const ensured: McpServerConfig[][] = [];
    let states: McpServerState[] = [];
    const app = {
        bundleName: 'mcpmgr',
        replacePluginSkillServers: jest.fn(async (servers: McpServerConfig[]) => {
            replaced.push(servers);
        }),
        ensurePluginSkillServers: jest.fn(async (servers: McpServerConfig[]) => {
            ensured.push(servers);
        }),
        getPluginSkillServers: jest.fn(async () => states),
        callPluginSkillMcpTool: jest.fn(
            async (serverId: string, toolName: string, args: Record<string, unknown>) =>
                `${serverId}#${toolName}#${JSON.stringify(args)}`
        )
    };
    return {
        app,
        replaced,
        ensured,
        setStates(next: McpServerState[]) {
            states = next;
        }
    };
}

function registerFakeMcpMgrApp(fake: ReturnType<typeof createFakeMcpMgrApp>): void {
    ApplicationRegistry.applications.set('mcpmgr', fake.app as any);
}

/** syncPluginSkillServers 带 worker 就绪守卫；需要验证同步下发的用例用 stub 模拟 worker 已启动 */
function stubGlobalWorkerReady(): void {
    jest.spyOn(ApplicationRegistry, 'hasGlobalWorker').mockReturnValue(true);
}

const echoTool = {
    name: 'echo',
    description: 'Echo the input text',
    parameters: z.object({ text: z.string().describe('text to echo') }),
    execute: async (args: { text: string }) => `echo:${args.text}`
};

describe('plugin skill internal tools', () => {
    afterEach(async () => {
        await getPluginHost().dispose();
        disposePluginContributions();
        SkillRegistry.getInstance().clearCache(PLUGIN_SKILL_BUNDLE);
        ApplicationRegistry.applications.delete('mcpmgr');
        jest.restoreAllMocks();
    });

    test('tools 字段组装成 skill 内部工具集，使用 pluginId 限定名且不进入全局工具视角', async () => {
        initializePluginContributions();
        await getPluginHost().activate(
            definePlugin({
                id: 'skill-tools',
                capabilities: ['skill'],
                setup(ctx) {
                    ctx.skills.register({
                        name: 'reporter',
                        description: 'Generate reports',
                        body: 'Use the bundled tools.',
                        tools: [
                            echoTool,
                            {
                                name: 'safe tool',
                                description: 'name needs sanitizing',
                                parameters: z.object({}),
                                execute: async () => 'ok'
                            }
                        ]
                    });
                }
            }),
            { origin: 'test:skill-tools' }
        );

        const skill = await SkillRegistry.getInstance().getSkill(PLUGIN_SKILL_BUNDLE, 'reporter');
        expect(skill?.toolsets).toHaveLength(1);
        const tools = [...skill!.toolsets![0].tools.values()];
        // 工具模型可见名即工具本名：bundleName/skillName 已承担命名空间，不叠插件前缀
        expect(tools.map((tool) => tool.name)).toEqual(['echo', 'safe-tool']);

        const content = skill!.getFullContent();
        expect(content).toContain('<tools>');
        expect(content).toContain('echo');
        expect(content).toContain('safe-tool');
        expect(content).not.toContain('skill-tools-');

        // CallSkillTool 的执行通路：skill.getTool(本名) 直接执行
        const tool = skill!.getTool('echo');
        const result = await tool!.execute({ text: 'hi' });
        expect(result.result).toBe('echo:hi');

        // 全局工具视角不包含 skill 内部工具
        const globalToolsets = await new PluginToolsetProvider().listAvailableToolsets();
        for (const toolset of globalToolsets) {
            expect(toolset.getTool('echo')).toBeUndefined();
        }
    });

    test('插件 source 决定 attribution.sourceKind（builtin/local）', async () => {
        initializePluginContributions();
        await getPluginHost().activate(
            definePlugin({
                id: 'source-kind-builtin',
                capabilities: ['skill'],
                setup(ctx) {
                    ctx.skills.register({ name: 's-builtin', description: 'd', body: 'b' });
                }
            }),
            { origin: 'test:source-kind-builtin', source: 'builtin' }
        );
        await getPluginHost().activate(
            definePlugin({
                id: 'source-kind-local',
                capabilities: ['skill'],
                setup(ctx) {
                    ctx.skills.register({ name: 's-local', description: 'd', body: 'b' });
                }
            }),
            { origin: 'test:source-kind-local', source: 'local' }
        );

        const builtinSkill = await SkillRegistry.getInstance().getSkill(PLUGIN_SKILL_BUNDLE, 's-builtin');
        expect(builtinSkill?.attribution).toEqual({
            sourceId: 'source-kind-builtin',
            sourceName: 'source-kind-builtin',
            sourceKind: 'builtin'
        });
        const localSkill = await SkillRegistry.getInstance().getSkill(PLUGIN_SKILL_BUNDLE, 's-local');
        expect(localSkill?.attribution).toEqual({
            sourceId: 'source-kind-local',
            sourceName: 'source-kind-local',
            sourceKind: 'local'
        });
    });

    test('mcps 字段：注册技能时同步给 MCPMgr（全量 replace），resolver 惰性组装内部工具集', async () => {
        const fake = createFakeMcpMgrApp();
        registerFakeMcpMgrApp(fake);
        initializePluginContributions();
        await getPluginHost().activate(
            definePlugin({
                id: 'skill-mcp',
                capabilities: ['skill'],
                setup(ctx) {
                    ctx.skills.register({
                        name: 'mcp-skill',
                        description: 'Skill with internal MCP',
                        body: 'Body of mcp-skill.',
                        mcps: [{ name: 'fs', transport: 'stdio', command: 'node', args: ['server.js'] }]
                    });
                }
            }),
            { origin: 'test:skill-mcp', source: 'local' }
        );

        const skill = await SkillRegistry.getInstance().getSkill(PLUGIN_SKILL_BUNDLE, 'mcp-skill');
        expect(typeof skill?.toolsetResolver).toBe('function');
        // 列表态不触发 MCP 连接：getSkill 后正文不含内部工具
        expect(skill!.getFullContent()).not.toContain('<tools>');

        stubGlobalWorkerReady();
        await syncPluginSkillServers();
        expect(fake.replaced).toHaveLength(1);
        const configs = fake.replaced[0];
        expect(configs).toHaveLength(1);
        expect(configs[0]).toMatchObject({
            name: 'fs',
            transport: 'stdio',
            command: 'node',
            enabled: true,
            pluginId: 'skill-mcp',
            pluginSkillName: 'mcp-skill',
            pluginSource: 'local',
            source: 'skill-mcp'
        });
        expect(configs[0].id).toBe(pluginSkillServerId('skill-mcp', 'mcp-skill', 'fs'));
        // id 跨调用稳定
        expect(pluginSkillServerId('skill-mcp', 'mcp-skill', 'fs')).toBe(configs[0].id);

        // resolver：worker 已发现工具时组装成普通独立工具集
        fake.setStates([
            {
                id: configs[0].id,
                name: 'fs',
                transport: 'stdio',
                enabled: true,
                status: 'connected',
                tools: [
                    {
                        name: 'read_file',
                        description: 'Read a file',
                        inputSchema: {
                            type: 'object',
                            properties: { path: { type: 'string', description: 'file path' } },
                            required: ['path']
                        }
                    }
                ]
            } as McpServerState
        ]);
        const toolsets = await skill!.toolsetResolver!();
        expect(toolsets).toHaveLength(1);
        const mcpTools = [...toolsets[0].tools.values()];
        // 单 MCP 且无重名：展平为工具本名，不体现 server 名；描述保留来源信息
        expect(mcpTools.map((tool) => tool.name)).toEqual(['read_file']);
        expect(mcpTools[0].description).toContain('[MCP: fs]');

        // 解析后正文披露工具，且执行统一走 MCPMgr worker
        skill!.toolsets = toolsets;
        expect(skill!.getFullContent()).toContain('read_file');
        expect(skill!.getFullContent()).not.toContain('__');
        const result = await mcpTools[0].execute({ path: '/tmp/a.txt' });
        expect(result.result).toBe(`${configs[0].id}#read_file#{"path":"/tmp/a.txt"}`);

        // loadSkillForAgent 端到端：resolver 结果随正文披露
        SkillRegistry.getInstance().clearCache(PLUGIN_SKILL_BUNDLE);
        const loaded = await SkillRegistry.getInstance().loadSkillForAgent(PLUGIN_SKILL_BUNDLE, 'mcp-skill');
        expect(loaded?.content).toContain('Body of mcp-skill.');
        expect(loaded?.content).toContain('read_file');
    });

    test('多 MCP server 时不展平：模型可见名保留 server 前缀消歧', async () => {
        const fake = createFakeMcpMgrApp();
        registerFakeMcpMgrApp(fake);
        initializePluginContributions();
        await getPluginHost().activate(
            definePlugin({
                id: 'skill-mcp-multi',
                capabilities: ['skill'],
                setup(ctx) {
                    ctx.skills.register({
                        name: 'multi-mcp-skill',
                        description: 'Skill with two internal MCP servers',
                        body: 'Body.',
                        mcps: [
                            { name: 'fs', transport: 'stdio', command: 'node' },
                            { name: 'git', transport: 'stdio', command: 'node' }
                        ]
                    });
                }
            }),
            { origin: 'test:skill-mcp-multi' }
        );
        const skill = await SkillRegistry.getInstance().getSkill(PLUGIN_SKILL_BUNDLE, 'multi-mcp-skill');
        fake.setStates([
            {
                id: pluginSkillServerId('skill-mcp-multi', 'multi-mcp-skill', 'fs'),
                name: 'fs',
                transport: 'stdio',
                enabled: true,
                status: 'connected',
                tools: [{ name: 'read', description: 'd', inputSchema: {} }]
            } as McpServerState,
            {
                id: pluginSkillServerId('skill-mcp-multi', 'multi-mcp-skill', 'git'),
                name: 'git',
                transport: 'stdio',
                enabled: true,
                status: 'connected',
                tools: [{ name: 'commit', description: 'd', inputSchema: {} }]
            } as McpServerState
        ]);
        const toolsets = await skill!.toolsetResolver!();
        expect(toolsets).toHaveLength(2);
        const names = toolsets.flatMap((toolset) => [...toolset.tools.values()].map((tool) => tool.name));
        expect(names).toEqual(['fs__read', 'git__commit']);
    });

    test('展平名与静态工具限定名冲突时回退为带前缀形态', async () => {
        const fake = createFakeMcpMgrApp();
        registerFakeMcpMgrApp(fake);
        initializePluginContributions();
        await getPluginHost().activate(
            definePlugin({
                id: 'flat-clash',
                capabilities: ['skill'],
                setup(ctx) {
                    ctx.skills.register({
                        name: 'clash-skill',
                        description: 'd',
                        body: 'b',
                        tools: [echoTool],
                        mcps: [{ name: 'fs', transport: 'stdio', command: 'node' }]
                    });
                }
            }),
            { origin: 'test:flat-clash' }
        );
        const skill = await SkillRegistry.getInstance().getSkill(PLUGIN_SKILL_BUNDLE, 'clash-skill');
        // 静态工具与本名展平的 MCP 工具撞名（都是 `echo`）时不得展平，回退带 server 前缀消歧
        fake.setStates([
            {
                id: pluginSkillServerId('flat-clash', 'clash-skill', 'fs'),
                name: 'fs',
                transport: 'stdio',
                enabled: true,
                status: 'connected',
                tools: [{ name: 'echo', description: 'd', inputSchema: {} }]
            } as McpServerState
        ]);
        const toolsets = await skill!.toolsetResolver!();
        // 静态工具集 + MCP 工具集
        expect(toolsets).toHaveLength(2);
        const mcpNames = [...toolsets[1].tools.values()].map((tool) => tool.name);
        expect(mcpNames).toEqual(['fs__echo']);
    });

    test('resolver 失败不阻断技能加载：正文可见但不出现内部工具', async () => {
        const fake = createFakeMcpMgrApp();
        fake.app.ensurePluginSkillServers = jest.fn(async () => {
            throw new Error('worker down');
        });
        registerFakeMcpMgrApp(fake);
        initializePluginContributions();
        await getPluginHost().activate(
            definePlugin({
                id: 'skill-mcp-down',
                capabilities: ['skill'],
                setup(ctx) {
                    ctx.skills.register({
                        name: 'down-skill',
                        description: 'Skill with broken MCP',
                        body: 'Body of down-skill.',
                        mcps: [{ name: 'fs', transport: 'stdio', command: 'node' }]
                    });
                }
            }),
            { origin: 'test:skill-mcp-down' }
        );

        const loaded = await SkillRegistry.getInstance().loadSkillForAgent(PLUGIN_SKILL_BUNDLE, 'down-skill');
        expect(loaded?.content).toContain('Body of down-skill.');
        expect(loaded?.content).not.toContain('<tools>');
    });

    test('mcpmgr 应用不可用时 sync 静默跳过，buildSkillMcpToolsets 返回空', async () => {
        initializePluginContributions();
        await getPluginHost().activate(
            definePlugin({
                id: 'skill-mcp-noapp',
                capabilities: ['skill'],
                setup(ctx) {
                    ctx.skills.register({
                        name: 'noapp-skill',
                        description: 'd',
                        body: 'b',
                        mcps: [{ name: 'fs', transport: 'stdio', command: 'node' }]
                    });
                }
            }),
            { origin: 'test:skill-mcp-noapp' }
        );

        await expect(syncPluginSkillServers()).resolves.toBeUndefined();
        await expect(
            buildSkillMcpToolsets('skill-mcp-noapp', 'noapp-skill', [
                { name: 'fs', transport: 'stdio', command: 'node' }
            ])
        ).resolves.toEqual([]);
    });

    test('mcps.registerInternalServer：追加到已注册技能、dispose 可撤销、不出现在全局视角', async () => {
        const fake = createFakeMcpMgrApp();
        registerFakeMcpMgrApp(fake);
        initializePluginContributions();
        let registration: { dispose: () => Promise<void> } | undefined;
        await getPluginHost().activate(
            definePlugin({
                id: 'internal-mcp-owner',
                capabilities: ['skill', 'mcp'],
                setup(ctx) {
                    ctx.skills.register({ name: 'host-skill', description: 'd', body: 'b' });
                    registration = ctx.mcps.registerInternalServer(
                        { name: 'db', transport: 'stdio', command: 'node' },
                        'host-skill'
                    ) as unknown as { dispose: () => Promise<void> };
                }
            }),
            { origin: 'test:internal-mcp-owner' }
        );

        const skill = await SkillRegistry.getInstance().getSkill(PLUGIN_SKILL_BUNDLE, 'host-skill');
        expect(typeof skill?.toolsetResolver).toBe('function');

        stubGlobalWorkerReady();
        await syncPluginSkillServers();
        expect(fake.replaced[0]).toHaveLength(1);
        expect(fake.replaced[0][0]).toMatchObject({ name: 'db', pluginSkillName: 'host-skill' });

        // 内部 server 不在全局工具视角：全局 registerServer 贡献为空
        const globalToolsets = await new PluginToolsetProvider().listAvailableToolsets();
        expect(globalToolsets.find((toolset) => toolset.name === 'plugin-mcp-internal-mcp-owner')).toBeUndefined();

        // 释放注册后重新同步：内部 server 随之移除
        await registration!.dispose();
        await syncPluginSkillServers();
        expect(fake.replaced[1]).toHaveLength(0);
    });

    test('global worker 未就绪时 sync 静默跳过（bootstrap 期不刷 warn），就绪后正常下发', async () => {
        const fake = createFakeMcpMgrApp();
        registerFakeMcpMgrApp(fake);
        initializePluginContributions();
        await getPluginHost().activate(
            definePlugin({
                id: 'sync-readiness',
                capabilities: ['skill'],
                setup(ctx) {
                    ctx.skills.register({
                        name: 'ready-skill',
                        description: 'd',
                        body: 'b',
                        mcps: [{ name: 'fs', transport: 'stdio', command: 'node' }]
                    });
                }
            }),
            { origin: 'test:sync-readiness' }
        );

        // 测试环境没有全局 worker（GUI 启动时 bootstrap 也早于 worker）：不尝试 replace
        await syncPluginSkillServers();
        expect(fake.replaced).toHaveLength(0);

        // worker 就绪后的补齐同步正常下发
        stubGlobalWorkerReady();
        await syncPluginSkillServers();
        expect(fake.replaced).toHaveLength(1);
        expect(fake.replaced[0]).toHaveLength(1);
    });

    test('全局 worker 崩溃重启通知触发内部 MCP server 重同步（只登记配置，不建连）', async () => {
        const fake = createFakeMcpMgrApp();
        registerFakeMcpMgrApp(fake);
        initializePluginContributions();
        registerPluginSkillServerResync();
        await getPluginHost().activate(
            definePlugin({
                id: 'resync-on-restart',
                capabilities: ['skill'],
                setup(ctx) {
                    ctx.skills.register({
                        name: 'resync-skill',
                        description: 'd',
                        body: 'b',
                        mcps: [{ name: 'fs', transport: 'stdio', command: 'node' }]
                    });
                }
            }),
            { origin: 'test:resync-on-restart' }
        );

        // 重启通知的回调同样经 worker 就绪守卫下发
        stubGlobalWorkerReady();
        await notifyGlobalWorkerRestarted();
        expect(fake.replaced).toHaveLength(1);
        expect(fake.replaced[0]).toHaveLength(1);
        expect(fake.replaced[0][0]).toMatchObject({
            pluginId: 'resync-on-restart',
            pluginSkillName: 'resync-skill',
            name: 'fs'
        });
    });

    test('非法注册被拒绝：未知技能报错；skill 内部 MCP 与本插件全局 server 重名报错', async () => {
        initializePluginContributions();
        let capturedError: Error | undefined;
        await getPluginHost().activate(
            definePlugin({
                id: 'internal-mcp-unknown-skill',
                capabilities: ['skill', 'mcp'],
                setup(ctx) {
                    ctx.skills.register({ name: 'host-skill', description: 'd', body: 'b' });
                    try {
                        ctx.mcps.registerInternalServer({ name: 'x', transport: 'stdio', command: 'node' }, 'missing');
                    } catch (error) {
                        capturedError = error as Error;
                    }
                }
            }),
            { origin: 'test:internal-mcp-unknown-skill' }
        );
        expect(capturedError?.message).toBe('plugin.internal_mcp_skill_not_found:missing');
    });

    test('skill 内部 MCP 与本插件全局 server 重名是允许的：两个视图相互隔离', async () => {
        const fake = createFakeMcpMgrApp();
        registerFakeMcpMgrApp(fake);
        initializePluginContributions();
        await getPluginHost().activate(
            definePlugin({
                id: 'internal-mcp-name-clash',
                capabilities: ['skill', 'mcp'],
                setup(ctx) {
                    ctx.mcps.registerServer({ name: 'fs', transport: 'stdio', command: 'node' });
                    ctx.skills.register({
                        name: 'host-skill',
                        description: 'd',
                        body: 'b',
                        mcps: [{ name: 'fs', transport: 'stdio', command: 'node', args: ['skill-server.js'] }]
                    });
                }
            }),
            { origin: 'test:internal-mcp-name-clash' }
        );
        const entry = getPluginHost().get('internal-mcp-name-clash');
        expect(entry?.status).toBe('active');

        stubGlobalWorkerReady();
        await syncPluginSkillServers();
        // 同步只包含技能内部 server（global-fs 由 pluginmgr 自己的 MCP 运行时管理，不经 mcpmgr replace）
        expect(fake.replaced[0]).toHaveLength(1);
        expect(fake.replaced[0][0]).toMatchObject({
            name: 'fs',
            pluginSkillName: 'host-skill',
            id: pluginSkillServerId('internal-mcp-name-clash', 'host-skill', 'fs')
        });
        // 全局视角仍是插件的全局 server，与技能内部 server 互不混入
        const globalServers = getPluginHost()
            .listMcpServers()
            .filter((contribution) => contribution.pluginId === 'internal-mcp-name-clash');
        expect(globalServers.map((contribution) => contribution.definition.name)).toEqual(['fs']);
    });

    test('tools 字段限定名冲突（净化后同名）被拒绝', async () => {
        initializePluginContributions();
        await getPluginHost().activate(
            definePlugin({
                id: 'skill-tools-dup',
                capabilities: ['skill'],
                setup(ctx) {
                    ctx.skills.register({
                        name: 'dup-skill',
                        description: 'd',
                        body: 'b',
                        tools: [
                            { name: 'a-b', description: 'first', parameters: z.object({}), execute: async () => '1' },
                            { name: 'a.b', description: 'second', parameters: z.object({}), execute: async () => '2' }
                        ]
                    });
                }
            }),
            { origin: 'test:skill-tools-dup' }
        );
        const entry = getPluginHost().get('skill-tools-dup');
        expect(entry?.status).toBe('error');
        expect(entry?.diagnostics[0]?.code).toBe('plugin.setup_failed');
    });

    test('mcps 字段净化后同名（my-server / my.server）被拒绝：模型可见工具名会冲突', async () => {
        initializePluginContributions();
        await getPluginHost().activate(
            definePlugin({
                id: 'skill-mcp-safe-dup',
                capabilities: ['skill'],
                setup(ctx) {
                    ctx.skills.register({
                        name: 'dup-mcp-skill',
                        description: 'd',
                        body: 'b',
                        mcps: [
                            { name: 'my-server', transport: 'stdio', command: 'node' },
                            { name: 'my.server', transport: 'stdio', command: 'node' }
                        ]
                    });
                }
            }),
            { origin: 'test:skill-mcp-safe-dup' }
        );
        const entry = getPluginHost().get('skill-mcp-safe-dup');
        expect(entry?.status).toBe('error');
        expect(entry?.diagnostics[0]?.detail).toContain('plugin.skill_mcp_name_conflict');
    });

    test('mcps.registerInternalServer 净化后同名也被拒绝', async () => {
        initializePluginContributions();
        await getPluginHost().activate(
            definePlugin({
                id: 'internal-mcp-safe-dup',
                capabilities: ['skill', 'mcp'],
                setup(ctx) {
                    ctx.skills.register({
                        name: 'dup-host',
                        description: 'd',
                        body: 'b',
                        mcps: [{ name: 'my-server', transport: 'stdio', command: 'node' }]
                    });
                    ctx.mcps.registerInternalServer(
                        { name: 'my.server', transport: 'stdio', command: 'node' },
                        'dup-host'
                    );
                }
            }),
            { origin: 'test:internal-mcp-safe-dup' }
        );
        const entry = getPluginHost().get('internal-mcp-safe-dup');
        expect(entry?.status).toBe('error');
        expect(entry?.diagnostics[0]?.detail).toContain('plugin.skill_mcp_name_conflict');
    });
});

describe('skill internal toolset resolver (aikernel 语义)', () => {
    afterEach(async () => {
        await getPluginHost().dispose();
        disposePluginContributions();
        SkillRegistry.getInstance().clearCache(PLUGIN_SKILL_BUNDLE);
        ApplicationRegistry.applications.delete('mcpmgr');
    });

    test('resolver 失败时保留静态 toolsets（tools 字段的工具仍可用）', async () => {
        const fake = createFakeMcpMgrApp();
        fake.app.ensurePluginSkillServers = jest.fn(async () => {
            throw new Error('worker down');
        });
        registerFakeMcpMgrApp(fake);
        initializePluginContributions();
        await getPluginHost().activate(
            definePlugin({
                id: 'mixed-skill',
                capabilities: ['skill'],
                setup(ctx) {
                    ctx.skills.register({
                        name: 'mixed',
                        description: 'Static tools + broken MCP',
                        body: 'Body of mixed.',
                        tools: [echoTool],
                        mcps: [{ name: 'fs', transport: 'stdio', command: 'node' }]
                    });
                }
            }),
            { origin: 'test:mixed-skill' }
        );

        const loaded = await SkillRegistry.getInstance().loadSkillForAgent(PLUGIN_SKILL_BUNDLE, 'mixed');
        expect(loaded?.content).toContain('Body of mixed.');
        // 静态工具仍在（本名），MCP 工具缺失
        expect(loaded?.content).toContain('echo');
        expect(loaded?.content).not.toContain('fs__');
        const tool: BaseTool<any> | undefined = loaded?.skill.getTool('echo');
        const result = await tool!.execute({ text: 'yo' });
        expect(result.result).toBe('echo:yo');
    });
});
