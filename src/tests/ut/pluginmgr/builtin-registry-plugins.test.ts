import path from 'path';
import { pathToFileURL } from 'url';
import { jest } from '@jest/globals';

/**
 * 内置注册表插件（按品牌划分）的验收测试：每个品牌一个插件，ModelScope/Matrix
 * 同时贡献 MCP 与技能注册表。各插件提供的注册表集合、展示元数据必须与迁移前
 * （mcpmgr/skillmgr 内置注册表类）完全一致，注册表 id 与迁移前相同。
 */

interface FakePluginRegistration {
    dispose: jest.Mock<() => Promise<void>>;
}

interface CapturedRegistryContext {
    registeredSkillRegistries: Record<string, unknown>[];
    registeredMcpRegistries: Record<string, unknown>[];
    fetch: () => Promise<unknown>;
    registry: {
        fetch: () => Promise<unknown>;
        registerSkillRegistry: (definition: Record<string, unknown>) => FakePluginRegistration;
        registerMcpRegistry: (definition: Record<string, unknown>) => FakePluginRegistration;
    };
}

function createContext(): CapturedRegistryContext {
    const context = {
        registeredSkillRegistries: [],
        registeredMcpRegistries: [],
        fetch: async () => {
            throw new Error('fetch should be delegated to the host registry capability');
        },
        registry: {} as CapturedRegistryContext['registry']
    };
    context.registry = {
        fetch: context.fetch,
        registerSkillRegistry: (definition) => {
            context.registeredSkillRegistries.push(definition);
            return { dispose: async () => undefined };
        },
        registerMcpRegistry: (definition) => {
            context.registeredMcpRegistries.push(definition);
            return { dispose: async () => undefined };
        }
    };
    return context;
}

const PLUGINS_DIRECTORY = path.resolve(process.cwd(), 'resources/plugins');

async function loadPlugin(directoryName: string): Promise<{ id: string; setup: (ctx: unknown) => Promise<unknown> }> {
    const entryPath = path.join(PLUGINS_DIRECTORY, directoryName, 'index.mjs');
    const module = (await import(`${pathToFileURL(entryPath).href}?spec=${Date.now()}-${Math.random()}`)) as {
        default: { id: string; setup: (ctx: unknown) => Promise<unknown> };
    };
    return module.default;
}

/** 按品牌的注册表验收表：插件目录 → 期望注册的注册表（与迁移前内置注册表类一一对应） */
const BRAND_EXPECTATIONS = [
    {
        dir: 'matrix',
        mcp: [{ id: 'matrix', label: 'Matrix MCPs', icon: '◇', slogan: '探索 OpenHarmony Matrix MCP 广场' }],
        skill: [
            {
                id: 'matrix',
                label: 'Matrix Skill',
                icon: '🔷',
                slogan: '用技能，让你的Agent无所不能',
                filters: [
                    {
                        id: 'harmony_pc',
                        labelOn: '鸿蒙PC兼容技能',
                        labelOff: '所有技能',
                        categoryValue: '鸿蒙PC',
                        apiTagIds: ['69cbb330d91c6e543991815d']
                    }
                ]
            }
        ]
    },
    {
        dir: 'modelscope',
        mcp: [{ id: 'modelscope-mcp', label: 'ModelScope', icon: '🔮', slogan: '魔搭社区 MCP 广场' }],
        skill: [{ id: 'modelscope', label: 'ModelScope', icon: '🔮', slogan: '汇聚社区技能组件，定义模型无限可能' }]
    },
    {
        dir: 'clawhub',
        mcp: [],
        skill: [{ id: 'clawhub', label: 'ClawHub', icon: '🐾', slogan: '社区驱动，探索无限技能' }]
    },
    {
        dir: 'skillhub',
        mcp: [],
        skill: [{ id: 'skillhub', label: 'SkillHub', icon: '💎', slogan: '专为中国用户优化的Skills社区' }]
    },
    {
        dir: 'skill0',
        mcp: [],
        skill: [{ id: 'skill0', label: 'skill0.io', icon: '📦', guiHidden: true }]
    },
    {
        dir: 'skillsmp',
        mcp: [],
        skill: [{ id: 'skillsmp', label: 'SkillsMP', icon: '🏪', guiHidden: true }]
    }
] as const;

describe('内置注册表插件（按品牌）', () => {
    test.each(BRAND_EXPECTATIONS.map((brand) => [brand.dir, brand] as const))(
        '%s 提供的注册表与迁移前一致',
        async (dir, brand) => {
            const plugin = await loadPlugin(dir);
            const context = createContext();
            await plugin.setup(context);

            expect(plugin.id).toBe(dir);
            expect(context.registeredMcpRegistries.map((registry) => registry.id)).toEqual(
                brand.mcp.map((registry) => registry.id)
            );
            expect(context.registeredSkillRegistries.map((registry) => registry.id)).toEqual(
                brand.skill.map((registry) => registry.id)
            );

            for (const expected of brand.mcp) {
                const registry = context.registeredMcpRegistries.find((item) => item.id === expected.id)!;
                expect(registry).toMatchObject(expected);
                expect(typeof registry.search).toBe('function');
                expect(typeof registry.getDetail).toBe('function');
            }
            for (const expected of brand.skill) {
                const registry = context.registeredSkillRegistries.find((item) => item.id === expected.id)!;
                expect(registry).toMatchObject(expected);
                expect(typeof registry.search).toBe('function');
            }
        }
    );

    test('guiHidden 仅存在于 skill0 与 skillsmp 的注册表上', async () => {
        for (const dir of ['skill0', 'skillsmp']) {
            const context = createContext();
            await (await loadPlugin(dir)).setup(context);
            expect(context.registeredSkillRegistries[0].guiHidden).toBe(true);
        }
        for (const dir of ['matrix', 'modelscope', 'clawhub', 'skillhub']) {
            const context = createContext();
            await (await loadPlugin(dir)).setup(context);
            for (const registry of [...context.registeredSkillRegistries, ...context.registeredMcpRegistries]) {
                expect(registry.guiHidden).toBeUndefined();
            }
        }
    });

    test('setup 返回的 dispose 释放全部注册', async () => {
        for (const brand of BRAND_EXPECTATIONS) {
            const plugin = await loadPlugin(brand.dir);
            const context = createContext();
            const teardown = (await plugin.setup(context)) as { dispose: () => Promise<void> };
            expect(typeof teardown?.dispose).toBe('function');
            await teardown.dispose();
        }
    });

    test('clawhub 搜索结果的 installUrl 携带发布者 handle', async () => {
        const plugin = await loadPlugin('clawhub');
        const context = createContext();
        context.registry.fetch = (async () =>
            new Response(
                JSON.stringify({
                    results: [
                        {
                            slug: 'self-improving',
                            name: 'self-improving',
                            displayName: 'Self-Improving + Proactive Agent',
                            ownerHandle: 'ivangdavila',
                            summary: 'self reflection skill',
                            stats: {}
                        },
                        {
                            slug: 'no-owner',
                            name: 'no-owner',
                            displayName: 'No Owner',
                            summary: 'skill without ownerHandle',
                            stats: {}
                        }
                    ]
                })
            )) as unknown as CapturedRegistryContext['fetch'];
        await plugin.setup(context);

        const registry = context.registeredSkillRegistries.find((item) => item.id === 'clawhub') as unknown as {
            search: (opts: { query: string }) => Promise<{ skills: Array<{ id: string; installUrl: string }> }>;
        };
        const result = await registry.search({ query: 'self-improving' });

        // slug 可能被多个发布者占用（下载接口裸 slug 返回 409），installUrl 必须带作者前缀
        expect(result.skills[0].installUrl).toBe('clawhub:ivangdavila/self-improving');
        expect(result.skills[1].installUrl).toBe('clawhub:no-owner');
    });

    test('matrix MCP 条目 mcpServerConfiguration 为空对象时不可安装', async () => {
        const plugin = await loadPlugin('matrix');
        const context = createContext();
        const mcpList = [
            { id: 'empty', name: 'empty-mcp', enName: 'empty-mcp', mcpServerConfiguration: '{}' },
            { id: 'blank', name: 'blank-mcp', enName: 'blank-mcp', mcpServerConfiguration: '' },
            {
                id: 'valid',
                name: 'valid-mcp',
                enName: 'valid-mcp',
                mcpServerConfiguration: JSON.stringify({
                    mcpServers: { weather: { command: 'npx', args: ['weather-mcp'] } }
                })
            },
            {
                id: 'text',
                name: 'text-mcp',
                enName: 'text-mcp',
                mcpServerConfiguration: '配置如下 {"mcpServers":{"a":{"url":"https://example.com/sse"}}} 请参考'
            }
        ];
        context.registry.fetch = (async () =>
            new Response(
                JSON.stringify({ code: '20000', data: { count: mcpList.length, list: mcpList } })
            )) as unknown as CapturedRegistryContext['fetch'];
        await plugin.setup(context);

        const registry = context.registeredMcpRegistries.find((item) => item.id === 'matrix') as unknown as {
            search: (opts: { query: string }) => Promise<{ mcps: Array<{ id: string; canInstall: boolean }> }>;
        };
        const result = await registry.search({ query: '' });

        const canInstallById: Record<string, boolean> = {};
        for (const mcp of result.mcps) canInstallById[mcp.id] = mcp.canInstall;
        expect(canInstallById).toEqual({ empty: false, blank: false, valid: true, text: true });
    });

    test('集合不变量：全部品牌插件的注册表并集 == 迁移前内置集合', async () => {
        // 迁移前 skillmgr/mcpmgr 内置注册表的完整集合（含 MCP 侧 modelscope 的 'modelscope-mcp' id）
        const LEGACY_MCP_IDS = ['matrix', 'modelscope-mcp'];
        const LEGACY_SKILL_IDS = ['matrix', 'clawhub', 'modelscope', 'skillhub', 'skill0', 'skillsmp'];

        const mcpIds = new Set<string>();
        const skillIds = new Set<string>();
        for (const brand of BRAND_EXPECTATIONS) {
            const context = createContext();
            await (await loadPlugin(brand.dir)).setup(context);
            for (const registry of context.registeredMcpRegistries) mcpIds.add(registry.id as string);
            for (const registry of context.registeredSkillRegistries) skillIds.add(registry.id as string);
        }

        // 并集恰好相等：品牌插件增删/改名导致注册表缺失或引入未预期 id 时在此失败
        expect([...skillIds].sort()).toEqual([...LEGACY_SKILL_IDS].sort());
        expect([...mcpIds].sort()).toEqual([...LEGACY_MCP_IDS].sort());
    });
});
