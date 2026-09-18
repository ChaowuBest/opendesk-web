import { jest } from '@jest/globals';
import type { PluginMcpRegistryDefinition } from '../../../../packages/plugin-sdk/src/index.js';
import {
    registerMcpRegistryProvider,
    getProvidedMcpRegistryDefinitions
} from '../../../main/applications/mcpmgr/registry/provider.js';
import {
    allRegistries,
    ensureMcpRegistriesSynced,
    getRegistriesInfo,
    getRegistry,
    searchRegistry,
    parseInstallUrl
} from '../../../main/applications/mcpmgr/registry/index.js';
import { ContributedMCPRegistry } from '../../../main/applications/mcpmgr/registry/contributed.js';

function createDefinition(overrides: Partial<PluginMcpRegistryDefinition> = {}): PluginMcpRegistryDefinition {
    return {
        id: 'contributed-mcp',
        label: 'Contributed MCP',
        icon: '🧩',
        iconClass: 'contributed',
        slogan: 'Contributed slogan',
        search: async () => ({ mcps: [], total: 0, hasMore: false }),
        getDetail: async () => null,
        ...overrides
    };
}

describe('mcpmgr 贡献注册表', () => {
    const originalRegistries = [...allRegistries];
    const disposers: Array<() => void> = [];

    afterEach(async () => {
        disposers.splice(0).forEach((dispose) => dispose());
        await ensureMcpRegistriesSynced();
        allRegistries.splice(0, allRegistries.length, ...originalRegistries);
    });

    test('provider 贡献的注册表被适配进 allRegistries，行为与内置注册表一致', async () => {
        const searchSpy = jest.fn(async () => ({
            mcps: [
                {
                    id: 'demo-mcp',
                    name: 'Demo MCP',
                    description: 'A demo entry',
                    source: 'contributed-mcp',
                    installUrl: 'contributed-mcp:demo-mcp',
                    canInstall: true
                }
            ],
            total: 1,
            hasMore: false
        }));
        disposers.push(
            registerMcpRegistryProvider({
                id: 'test',
                getRegistries: async () => [createDefinition({ search: searchSpy })]
            })
        );
        await ensureMcpRegistriesSynced();

        expect(allRegistries.map((registry) => registry.id)).toContain('contributed-mcp');
        expect(getRegistry('contributed-mcp')).toBeInstanceOf(ContributedMCPRegistry);

        const infos = await getRegistriesInfo();
        const contributed = infos.find((info) => info.id === 'contributed-mcp');
        expect(contributed).toMatchObject({
            id: 'contributed-mcp',
            label: 'Contributed MCP',
            icon: '🧩',
            slogan: 'Contributed slogan'
        });

        const result = await searchRegistry('contributed-mcp', { query: 'demo' });
        expect(result.mcps).toHaveLength(1);
        expect(searchSpy).toHaveBeenCalledWith({ query: 'demo' });

        expect(parseInstallUrl('contributed-mcp:demo-mcp')).toEqual({ registryId: 'contributed-mcp', id: 'demo-mcp' });
    });

    test('provider 注销并重新同步后，贡献注册表从 allRegistries 移除', async () => {
        const dispose = registerMcpRegistryProvider({
            id: 'test',
            getRegistries: async () => [createDefinition()]
        });
        await ensureMcpRegistriesSynced();
        expect(allRegistries.map((registry) => registry.id)).toContain('contributed-mcp');

        dispose();
        await ensureMcpRegistriesSynced();

        expect(allRegistries.map((registry) => registry.id)).not.toContain('contributed-mcp');
    });

    test('未知的注册表 id 抛错', async () => {
        await expect(searchRegistry('nonexistent-registry', {})).rejects.toThrow('nonexistent-registry');
    });

    test('getProvidedMcpRegistryDefinitions 聚合多个 provider', async () => {
        const disposeA = registerMcpRegistryProvider({
            id: 'test-a',
            getRegistries: async () => [createDefinition({ id: 'a-registry' })]
        });
        const disposeB = registerMcpRegistryProvider({
            id: 'test-b',
            getRegistries: async () => [createDefinition({ id: 'b-registry' })]
        });
        try {
            const definitions = await getProvidedMcpRegistryDefinitions();
            expect(definitions.map((definition) => definition.id)).toEqual(['a-registry', 'b-registry']);
        } finally {
            disposeA();
            disposeB();
        }
    });

    test('provider 抛错时其余 provider 的注册表仍被合并', async () => {
        disposers.push(
            registerMcpRegistryProvider({
                id: 'test-broken',
                getRegistries: async () => {
                    throw new Error('provider exploded');
                }
            })
        );
        disposers.push(
            registerMcpRegistryProvider({
                id: 'test-healthy',
                getRegistries: async () => [createDefinition({ id: 'healthy-registry' })]
            })
        );
        await ensureMcpRegistriesSynced();

        expect(allRegistries.map((registry) => registry.id)).toContain('healthy-registry');
    });

    test('同步幂等：provider 返回新定义时替换旧实例，不产生重复（插件重载模拟）', async () => {
        let version = 0;
        disposers.push(
            registerMcpRegistryProvider({
                id: 'test',
                getRegistries: async () => [createDefinition({ id: 'versioned-registry', label: `V${version}` })]
            })
        );

        await ensureMcpRegistriesSynced();
        expect(allRegistries.filter((registry) => registry.id === 'versioned-registry')).toHaveLength(1);

        version = 1;
        await ensureMcpRegistriesSynced();
        const instances = allRegistries.filter((registry) => registry.id === 'versioned-registry');
        expect(instances).toHaveLength(1);
        expect(instances[0].label).toBe('V1');
    });

    test('跨 provider 重复 id 合并时去重保留首个', async () => {
        disposers.push(
            registerMcpRegistryProvider({
                id: 'test-first',
                getRegistries: async () => [createDefinition({ id: 'clashing-id', label: 'First' })]
            })
        );
        disposers.push(
            registerMcpRegistryProvider({
                id: 'test-second',
                getRegistries: async () => [createDefinition({ id: 'clashing-id', label: 'Second' })]
            })
        );
        await ensureMcpRegistriesSynced();

        const instances = allRegistries.filter((registry) => registry.id === 'clashing-id');
        expect(instances).toHaveLength(1);
        expect(instances[0].label).toBe('First');
    });

    test('同步失败不毒化后续调用：失败后 provider 恢复仍能合并成功', async () => {
        let healthy = false;
        disposers.push(
            registerMcpRegistryProvider({
                id: 'test',
                getRegistries: async () => {
                    if (!healthy) throw new Error('not ready');
                    return [createDefinition({ id: 'late-registry' })];
                }
            })
        );

        await ensureMcpRegistriesSynced();
        expect(allRegistries.map((registry) => registry.id)).not.toContain('late-registry');

        healthy = true;
        await ensureMcpRegistriesSynced();
        expect(allRegistries.map((registry) => registry.id)).toContain('late-registry');
    });

    test('并发 ensure 调用串行化，不产生重复实例', async () => {
        disposers.push(
            registerMcpRegistryProvider({
                id: 'test',
                getRegistries: async () => [createDefinition({ id: 'concurrent-mcp' })]
            })
        );

        await Promise.all([ensureMcpRegistriesSynced(), ensureMcpRegistriesSynced(), ensureMcpRegistriesSynced()]);

        expect(allRegistries.filter((registry) => registry.id === 'concurrent-mcp')).toHaveLength(1);
    });

    test('app 方法经 provider 感知贡献注册表（市场 tab / 搜索全链路，无需手工注入）', async () => {
        disposers.push(
            registerMcpRegistryProvider({
                id: 'test',
                getRegistries: async () => [
                    createDefinition({
                        id: 'wired-mcp',
                        label: 'Wired MCP',
                        search: async () => ({
                            mcps: [
                                {
                                    id: 'wired-server',
                                    name: 'wired-server',
                                    description: 'through app-level wiring',
                                    source: 'wired-mcp',
                                    installUrl: 'wired-mcp:wired-server',
                                    canInstall: true
                                }
                            ],
                            total: 1,
                            hasMore: false
                        })
                    })
                ]
            })
        );

        const { McpMgrApplication } = await import('../../../main/applications/mcpmgr/app');
        const app = Object.create(McpMgrApplication.prototype) as McpMgrApplication;

        // 市场 tab 数据源：getMcpRegistries（渲染端 callMainWorld 消费的同一方法）
        const registries = await (
            app as unknown as { getMcpRegistries(): Promise<Array<{ id: string }>> }
        ).getMcpRegistries();
        expect(registries.map((registry) => registry.id)).toContain('wired-mcp');

        // 渲染端/agent 工具共用的搜索入口
        const result = await (
            app as unknown as {
                searchMcpRegistry(
                    id: string,
                    query: string,
                    page: number,
                    limit: number
                ): Promise<{
                    mcps: Array<{ id: string }>;
                }>;
            }
        ).searchMcpRegistry('wired-mcp', 'demo', 1, 30);
        expect(result.mcps[0]).toMatchObject({ id: 'wired-server', source: 'wired-mcp' });
    });

    test('未声明 slogan/icon 的贡献注册表回退到基类默认值', async () => {
        disposers.push(
            registerMcpRegistryProvider({
                id: 'test',
                getRegistries: async () => [
                    createDefinition({ id: 'bare-mcp', slogan: undefined, icon: undefined, iconClass: undefined })
                ]
            })
        );
        await ensureMcpRegistriesSynced();

        const registry = getRegistry('bare-mcp')!;
        expect(registry.slogan).toBe('连接上下文，让智能体调用更多工具');
        expect(registry.icon).toBe('🔗');
        expect(registry.iconClass).toBe('bare-mcp');
    });
});
