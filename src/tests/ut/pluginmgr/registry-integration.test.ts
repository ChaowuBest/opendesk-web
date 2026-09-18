import path from 'path';

/**
 * registry capability 全链路集成测试：真实的内置插件（resources/plugins/，按品牌
 * 一插件）→ PluginHost 激活（capability 检查/记录）→ registry-providers
 * （pluginmgr provider）→ mcpmgr / skillmgr 应用侧同步 → allRegistries。
 * 覆盖激活、查询、重载（重复激活）与停用（移除）四个生命周期阶段，且不 mock 插件本身。
 */

const PLUGINS_DIRECTORY = path.resolve(process.cwd(), 'resources/plugins');

/** 内置品牌注册表插件目录（按名称字母序 = 真实 bootstrap 的发现顺序） */
const BRAND_PLUGIN_DIRECTORIES = ['clawhub', 'matrix', 'modelscope', 'skill0', 'skillhub', 'skillsmp'];

async function loadPluginEntry(directoryName: string) {
    const module = (await import(
        `${path.resolve(PLUGINS_DIRECTORY, directoryName, 'index.mjs')}?it=${Date.now()}-${Math.random()}`
    )) as { default: { id: string; setup: (ctx: unknown) => Promise<unknown> } };
    return module.default;
}

describe('registry capability 全链路（真实内置插件）', () => {
    test('provider 重初始化周期（模拟 reloadPluginHost）：dispose 后 initialize 仍可拉取贡献', async () => {
        const globalHostModule = await import('../../../main/applications/pluginmgr/runtime/host.js');
        const { initializePluginRegistryProvider, disposePluginRegistryProvider } =
            await import('../../../main/applications/pluginmgr/runtime/registry-providers.js');
        const skillRegistryIndex = await import('../../../main/applications/skillmgr/registry/index.js');
        const { getProvidedSkillRegistryDefinitions } =
            await import('../../../main/applications/skillmgr/registry/provider.js');

        const globalHost = globalHostModule.getPluginHost();
        const originalSkillRegistries = [...skillRegistryIndex.allRegistries];

        try {
            // 首次初始化（对应 bootstrap.initialize）：激活全部 6 个品牌插件
            initializePluginRegistryProvider();
            for (const dir of BRAND_PLUGIN_DIRECTORIES) {
                const plugin = await loadPluginEntry(dir);
                const entry = await globalHost.activate(plugin as never, { origin: `builtin:${dir}` });
                expect(entry.status).toBe('active');
            }
            expect((await getProvidedSkillRegistryDefinitions()).map((item) => item.id)).toHaveLength(6);

            // 卸载周期（对应 disposePluginHost）：provider 注销后拉取为空
            disposePluginRegistryProvider();
            expect(await getProvidedSkillRegistryDefinitions()).toEqual([]);

            // 重新初始化（对应 reloadPluginHost 的 initializePluginHost）：provider 重新注册，
            // 插件仍处于激活态（disposePluginHost 中 host.dispose 在 provider 注销之后才执行，
            // 这里保持激活以单独验证 provider 层的重入性），拉取恢复
            initializePluginRegistryProvider();
            expect((await getProvidedSkillRegistryDefinitions()).map((item) => item.id)).toHaveLength(6);
            await skillRegistryIndex.ensureSkillRegistriesSynced();
            expect(skillRegistryIndex.getRegistry('clawhub')).toBeDefined();
        } finally {
            disposePluginRegistryProvider();
            await globalHost.dispose().catch(() => undefined);
            skillRegistryIndex.allRegistries.splice(
                0,
                skillRegistryIndex.allRegistries.length,
                ...originalSkillRegistries
            );
        }
    });

    test('激活内置插件后注册表经 provider 进入两侧 allRegistries，停用后移除，重复激活不重复', async () => {
        const globalHostModule = await import('../../../main/applications/pluginmgr/runtime/host.js');
        const { initializePluginRegistryProvider, disposePluginRegistryProvider } =
            await import('../../../main/applications/pluginmgr/runtime/registry-providers.js');
        const mcpRegistry = await import('../../../main/applications/mcpmgr/registry/index.js');
        const skillRegistryIndex = await import('../../../main/applications/skillmgr/registry/index.js');

        // registry-providers 从全局单例 host 拉取贡献，激活/停用都作用于该单例
        const globalHost = globalHostModule.getPluginHost();
        initializePluginRegistryProvider();
        const originalRegistries = {
            mcp: [...mcpRegistry.allRegistries],
            skill: [...skillRegistryIndex.allRegistries]
        };

        try {
            // 按真实 bootstrap 顺序（目录字母序）激活全部品牌插件
            const entries = [];
            for (const dir of BRAND_PLUGIN_DIRECTORIES) {
                const plugin = await loadPluginEntry(dir);
                entries.push({
                    dir,
                    entry: await globalHost.activate(plugin as never, { origin: `builtin:${dir}` })
                });
            }
            for (const { dir, entry } of entries) {
                expect(entry.status).toBe('active');
                expect(entry.capabilities).toContain('registry');
            }

            await mcpRegistry.ensureMcpRegistriesSynced();
            await skillRegistryIndex.ensureSkillRegistriesSynced();

            // MCP 侧：两个注册表可用，GUI 信息与内置时期一致（字母序恰好保持 matrix 在前）
            expect(mcpRegistry.getRegistry('matrix')).toBeDefined();
            expect(mcpRegistry.getRegistry('modelscope-mcp')).toBeDefined();
            const mcpInfos = await mcpRegistry.getRegistriesInfo();
            expect(mcpInfos.map((info) => info.id)).toEqual(['matrix', 'modelscope-mcp']);
            expect(mcpInfos[0]).toMatchObject({ label: 'Matrix MCPs', icon: '◇' });

            // 技能侧：6 个注册表齐备（顺序随品牌插件目录字母序；主进程侧顺序不影响
            // 用户可见展示——GUI tab 顺序由渲染端 REGISTRY_TABS 决定，TUI/agent 不依赖顺序）
            expect([...skillRegistryIndex.allRegistries.map((registry) => registry.id)].sort()).toEqual([
                'clawhub',
                'matrix',
                'modelscope',
                'skill0',
                'skillhub',
                'skillsmp'
            ]);
            const skillInfos = await skillRegistryIndex.getRegistriesInfo();
            // guiHidden（skill0/skillsmp）过滤后 GUI 信息剩 4 个
            expect([...skillInfos.map((info) => info.id)].sort()).toEqual([
                'clawhub',
                'matrix',
                'modelscope',
                'skillhub'
            ]);
            const matrixInfo = skillInfos.find((info) => info.id === 'matrix')!;
            expect(matrixInfo.filters.length).toBeGreaterThan(0);

            // 安装路由：内置前缀仍由 skill-installer 的既有分支接管；MCP 安装 URL 支持编码 id
            expect(skillRegistryIndex.getInstallMethod('matrix:some-skill')).toBe('matrix');
            expect(skillRegistryIndex.parseInstallUrl('clawhub:some-skill')).toEqual({ slug: 'some-skill' });
            // 通用适配器不在此处解码：插件定义拿到与它发出的 installUrl 完全一致的 id，
            // 由插件 getDetail 内部自行解码（modelscope 安装链路的端到端测试已覆盖等价性）
            expect(mcpRegistry.parseInstallUrl('modelscope-mcp:%40modelcontextprotocol%2Ffetch')).toEqual({
                registryId: 'modelscope-mcp',
                id: '%40modelcontextprotocol%2Ffetch'
            });

            // 重载模拟：停用后重新激活同一品牌插件，同步替换而非追加重复
            await globalHost.deactivate('modelscope');
            const modelscopePlugin = await loadPluginEntry('modelscope');
            await globalHost.activate(modelscopePlugin as never, { origin: 'builtin:modelscope' });
            await skillRegistryIndex.ensureSkillRegistriesSynced();
            await mcpRegistry.ensureMcpRegistriesSynced();
            expect(skillRegistryIndex.allRegistries.filter((registry) => registry.id === 'modelscope')).toHaveLength(1);
            expect(mcpRegistry.allRegistries.filter((registry) => registry.id === 'modelscope-mcp')).toHaveLength(1);

            // 停用全部品牌插件后从两侧列表移除
            for (const dir of BRAND_PLUGIN_DIRECTORIES) {
                await globalHost.deactivate(dir);
            }
            await mcpRegistry.ensureMcpRegistriesSynced();
            await skillRegistryIndex.ensureSkillRegistriesSynced();

            expect(mcpRegistry.getRegistry('matrix')).toBeUndefined();
            expect(mcpRegistry.getRegistry('modelscope-mcp')).toBeUndefined();
            expect(skillRegistryIndex.getRegistry('clawhub')).toBeUndefined();
            expect(skillRegistryIndex.getRegistry('skillsmp')).toBeUndefined();
        } finally {
            disposePluginRegistryProvider();
            await globalHost.dispose().catch(() => undefined);
            // 恢复测试前的 allRegistries 快照，避免污染同进程其他测试
            mcpRegistry.allRegistries.splice(0, mcpRegistry.allRegistries.length, ...originalRegistries.mcp);
            skillRegistryIndex.allRegistries.splice(
                0,
                skillRegistryIndex.allRegistries.length,
                ...originalRegistries.skill
            );
        }
    });
});
