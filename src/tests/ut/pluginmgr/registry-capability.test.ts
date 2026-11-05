import { jest } from '@jest/globals';
import { PluginHost } from '../../../main/applications/pluginmgr/runtime/host.js';
import { setPlatform } from '../../../platforms/base.js';
import { definePlugin } from '../../../../packages/plugin-sdk/src/index.js';
import type {
    PluginMcpRegistryDefinition,
    PluginSkillRegistryDefinition
} from '../../../../packages/plugin-sdk/src/index.js';

function createSkillRegistryDefinition(
    overrides: Partial<PluginSkillRegistryDefinition> = {}
): PluginSkillRegistryDefinition {
    return {
        id: 'demo-skill-registry',
        label: 'Demo Skill Registry',
        icon: '🧪',
        iconClass: 'demo',
        slogan: 'Demo slogan',
        search: (async () => ({ skills: [], total: 0, hasMore: false })) as PluginSkillRegistryDefinition['search'],
        ...overrides
    };
}

function createMcpRegistryDefinition(
    overrides: Partial<PluginMcpRegistryDefinition> = {}
): PluginMcpRegistryDefinition {
    return {
        id: 'demo-mcp-registry',
        label: 'Demo MCP Registry',
        icon: '◇',
        iconClass: 'demo-mcp',
        slogan: 'Demo MCP slogan',
        search: (async () => ({ mcps: [], total: 0, hasMore: false })) as PluginMcpRegistryDefinition['search'],
        getDetail: (async () => null) as PluginMcpRegistryDefinition['getDetail'],
        ...overrides
    };
}

describe('PluginHost registry capability', () => {
    test('注册技能/MCP 注册表需要 registry capability 并被 host 收集', async () => {
        const host = new PluginHost();
        const skillDefinition = createSkillRegistryDefinition();
        const mcpDefinition = createMcpRegistryDefinition();
        const entry = await host.activate(
            definePlugin({
                id: 'registry-plugin',
                capabilities: ['registry'],
                setup(ctx) {
                    ctx.registry.registerSkillRegistry(skillDefinition);
                    ctx.registry.registerMcpRegistry(mcpDefinition);
                }
            }),
            { origin: 'test:registry-plugin' }
        );

        expect(entry.status).toBe('active');
        expect(entry.capabilities).toContain('registry');
        expect(host.listSkillRegistries().map((item) => item.definition)).toEqual([skillDefinition]);
        expect(host.listMcpRegistries().map((item) => item.definition)).toEqual([mcpDefinition]);
        expect(host.listSkillRegistries()[0].pluginId).toBe('registry-plugin');
    });

    test('未声明 registry capability 时注册被拒绝', async () => {
        const host = new PluginHost();
        const entry = await host.activate(
            definePlugin({
                id: 'registry-missing-capability',
                capabilities: [],
                setup(ctx) {
                    ctx.registry.registerSkillRegistry(createSkillRegistryDefinition());
                }
            }),
            { origin: 'test:registry-missing-capability' }
        );

        expect(entry.status).toBe('error');
        expect(entry.diagnostics[0]?.code).toBe('plugin.setup_failed');
        expect(entry.diagnostics[0]?.detail).toBe('plugin.capability_not_declared:registry');
        expect(host.listSkillRegistries()).toEqual([]);
    });

    test('registry id 跨插件全局唯一（同时是 installUrl 前缀）', async () => {
        const host = new PluginHost();
        await host.activate(
            definePlugin({
                id: 'first-registry-plugin',
                capabilities: ['registry'],
                setup(ctx) {
                    ctx.registry.registerSkillRegistry(createSkillRegistryDefinition());
                }
            }),
            { origin: 'test:first-registry-plugin' }
        );
        const second = await host.activate(
            definePlugin({
                id: 'second-registry-plugin',
                capabilities: ['registry'],
                setup(ctx) {
                    ctx.registry.registerSkillRegistry(createSkillRegistryDefinition());
                }
            }),
            { origin: 'test:second-registry-plugin' }
        );

        expect(second.status).toBe('error');
        expect(second.diagnostics[0]?.detail).toContain('already registered');
        expect(host.listSkillRegistries()).toHaveLength(1);
    });

    test('非法定义（缺 search / 非法 id）在注册时报错', async () => {
        const host = new PluginHost();
        const entry = await host.activate(
            definePlugin({
                id: 'registry-invalid-definitions',
                capabilities: ['registry'],
                setup(ctx) {
                    const { search: _search, ...invalid } = createSkillRegistryDefinition();
                    void _search;
                    ctx.registry.registerSkillRegistry(invalid as PluginSkillRegistryDefinition);
                }
            }),
            { origin: 'test:registry-invalid-definitions' }
        );

        expect(entry.status).toBe('error');
        expect(entry.diagnostics[0]?.detail).toBe('plugin.registry_search_invalid:demo-skill-registry');

        const idEntry = await host.activate(
            definePlugin({
                id: 'registry-invalid-id',
                capabilities: ['registry'],
                setup(ctx) {
                    ctx.registry.registerSkillRegistry(createSkillRegistryDefinition({ id: 'bad id!' }));
                }
            }),
            { origin: 'test:registry-invalid-id' }
        );

        expect(idEntry.status).toBe('error');
        expect(idEntry.diagnostics[0]?.detail).toBe('plugin.registry_id_invalid:bad id!');
    });

    test('筛选项定义校验：字段缺失与未知 platforms 被拒绝，已知平台可用', async () => {
        const host = new PluginHost();
        const invalidFilterCases: Array<{ id: string; filters: unknown[] }> = [
            // labelOn 空白
            [{ id: 'f', labelOn: '  ', labelOff: 'off', categoryValue: 'cat' }],
            // platforms 不是已知平台值（平台专属筛选器只允许 manifest 认可的平台）
            [{ id: 'f', labelOn: 'on', labelOff: 'off', categoryValue: 'cat', platforms: ['harmonyos'] }],
            // platforms 不是数组
            [{ id: 'f', labelOn: 'on', labelOff: 'off', categoryValue: 'cat', platforms: 'openharmony' }]
        ].map((filters, index) => ({ id: `registry-invalid-filters-${index}`, filters }));

        for (const { id, filters } of invalidFilterCases) {
            const entry = await host.activate(
                definePlugin({
                    id,
                    capabilities: ['registry'],
                    setup(ctx) {
                        ctx.registry.registerSkillRegistry(
                            createSkillRegistryDefinition({
                                filters: filters as PluginSkillRegistryDefinition['filters']
                            })
                        );
                    }
                }),
                { origin: `test:${id}` }
            );

            expect(entry.status).toBe('error');
            expect(entry.diagnostics[0]?.detail).toBe('plugin.registry_filters_invalid:demo-skill-registry');
        }

        const validEntry = await host.activate(
            definePlugin({
                id: 'registry-valid-platform-filters',
                capabilities: ['registry'],
                setup(ctx) {
                    ctx.registry.registerSkillRegistry(
                        createSkillRegistryDefinition({
                            filters: [
                                {
                                    id: 'harmony_pc',
                                    labelOn: '鸿蒙PC兼容技能',
                                    labelOff: '所有技能',
                                    categoryValue: '鸿蒙PC',
                                    platforms: ['openharmony']
                                }
                            ]
                        })
                    );
                }
            }),
            { origin: 'test:registry-valid-platform-filters' }
        );

        expect(validEntry.status).toBe('active');
    });

    test('MCP 注册表必须提供 getDetail（安装流程依赖）', async () => {
        const host = new PluginHost();
        const { getDetail: _getDetail, ...invalid } = createMcpRegistryDefinition();
        void _getDetail;
        const entry = await host.activate(
            definePlugin({
                id: 'registry-mcp-missing-detail',
                capabilities: ['registry'],
                setup(ctx) {
                    ctx.registry.registerMcpRegistry(invalid as PluginMcpRegistryDefinition);
                }
            }),
            { origin: 'test:registry-mcp-missing-detail' }
        );

        expect(entry.status).toBe('error');
        expect(entry.diagnostics[0]?.detail).toBe('plugin.registry_detail_invalid:demo-mcp-registry');
    });

    test('deactivate 后注册表被移除', async () => {
        const host = new PluginHost();
        await host.activate(
            definePlugin({
                id: 'registry-dispose-plugin',
                capabilities: ['registry'],
                setup(ctx) {
                    ctx.registry.registerSkillRegistry(createSkillRegistryDefinition());
                    ctx.registry.registerMcpRegistry(createMcpRegistryDefinition());
                }
            }),
            { origin: 'test:registry-dispose-plugin' }
        );

        expect(host.listSkillRegistries()).toHaveLength(1);
        expect(host.listMcpRegistries()).toHaveLength(1);

        await host.deactivate('registry-dispose-plugin');

        expect(host.listSkillRegistries()).toEqual([]);
        expect(host.listMcpRegistries()).toEqual([]);
    });

    test('ctx.registry.fetch 走宿主平台 fetch', async () => {
        const fetchMock = jest.fn(async () => new Response('{}'));
        setPlatform({ fetch: fetchMock } as unknown as Parameters<typeof setPlatform>[0]);
        try {
            const host = new PluginHost();
            await host.activate(
                definePlugin({
                    id: 'registry-fetch-plugin',
                    capabilities: ['registry'],
                    setup(ctx) {
                        void ctx.registry.fetch('https://example.com/api');
                    }
                }),
                { origin: 'test:registry-fetch-plugin' }
            );
        } finally {
            setPlatform(null as unknown as Parameters<typeof setPlatform>[0]);
        }

        expect(fetchMock).toHaveBeenCalledWith('https://example.com/api', undefined);
    });

    test('fetch 与注册一样受 registry capability 检查约束', async () => {
        const host = new PluginHost();
        const entry = await host.activate(
            definePlugin({
                id: 'registry-fetch-unauthorized',
                capabilities: [],
                setup(ctx) {
                    void ctx.registry.fetch('https://example.com/api');
                }
            }),
            { origin: 'test:registry-fetch-unauthorized' }
        );

        expect(entry.status).toBe('error');
        expect(entry.diagnostics[0]?.detail).toBe('plugin.capability_not_declared:registry');
    });

    test('注册失败具备原子性：同插件后续注册失败时，已注册的注册表被回滚', async () => {
        const host = new PluginHost();
        const entry = await host.activate(
            definePlugin({
                id: 'registry-atomic-plugin',
                capabilities: ['registry'],
                setup(ctx) {
                    ctx.registry.registerSkillRegistry(createSkillRegistryDefinition({ id: 'atomic-a' }));
                    // 同 id 二次注册必然冲突，使 setup 整体失败
                    ctx.registry.registerSkillRegistry(createSkillRegistryDefinition({ id: 'atomic-a' }));
                }
            }),
            { origin: 'test:registry-atomic-plugin' }
        );

        expect(entry.status).toBe('error');
        expect(host.listSkillRegistries()).toEqual([]);
    });

    test('deactivate 后同 id 可重新注册（插件重载场景）', async () => {
        const host = new PluginHost();
        const buildPlugin = () =>
            definePlugin({
                id: 'registry-reload-plugin',
                capabilities: ['registry'],
                setup(ctx) {
                    ctx.registry.registerSkillRegistry(createSkillRegistryDefinition());
                }
            });
        await host.activate(buildPlugin(), { origin: 'test:registry-reload-plugin' });
        expect(host.listSkillRegistries()).toHaveLength(1);

        await host.deactivate('registry-reload-plugin');
        const reactivated = await host.activate(buildPlugin(), { origin: 'test:registry-reload-plugin' });

        expect(reactivated.status).toBe('active');
        expect(host.listSkillRegistries()).toHaveLength(1);
    });

    test('manifest 解析接受 registry capability，未知能力仍被拒绝', async () => {
        const { parsePluginManifest } = await import('../../../main/applications/pluginmgr/discovery/manifest.js');
        const base = {
            id: 'manifest-registry-plugin',
            apiVersion: 1
        };
        const accepted = parsePluginManifest({ ...base, capabilities: ['registry'] });
        expect(accepted.capabilities).toEqual(['registry']);

        expect(() => parsePluginManifest({ ...base, capabilities: ['registryx'] })).toThrow(
            'plugin.manifest_unknown_capability'
        );
    });

    test('空白 label 与非 ASCII id 的注册表定义被拒绝', async () => {
        const host = new PluginHost();
        const whitespaceLabelEntry = await host.activate(
            definePlugin({
                id: 'registry-whitespace-label',
                capabilities: ['registry'],
                setup(ctx) {
                    ctx.registry.registerSkillRegistry(createSkillRegistryDefinition({ label: '   ' }));
                }
            }),
            { origin: 'test:registry-whitespace-label' }
        );
        expect(whitespaceLabelEntry.status).toBe('error');
        expect(whitespaceLabelEntry.diagnostics[0]?.detail).toBe('plugin.registry_label_invalid:demo-skill-registry');

        const unicodeIdEntry = await host.activate(
            definePlugin({
                id: 'registry-unicode-id',
                capabilities: ['registry'],
                setup(ctx) {
                    ctx.registry.registerSkillRegistry(createSkillRegistryDefinition({ id: '矩阵' }));
                }
            }),
            { origin: 'test:registry-unicode-id' }
        );
        expect(unicodeIdEntry.status).toBe('error');
        expect(unicodeIdEntry.diagnostics[0]?.detail).toBe('plugin.registry_id_invalid:矩阵');
        expect(host.listSkillRegistries()).toEqual([]);
    });

    test('search 运行期拒绝向调用方传播（适配器不吞错）', async () => {
        const host = new PluginHost();
        await host.activate(
            definePlugin({
                id: 'registry-throws-plugin',
                capabilities: ['registry'],
                setup(ctx) {
                    ctx.registry.registerSkillRegistry(
                        createSkillRegistryDefinition({
                            id: 'throwing-registry',
                            search: async () => {
                                throw new Error('registry backend down');
                            }
                        })
                    );
                }
            }),
            { origin: 'test:registry-throws-plugin' }
        );

        const { registerSkillRegistryProvider } =
            await import('../../../main/applications/skillmgr/registry/provider.js');
        const { allRegistries, ensureSkillRegistriesSynced, searchRegistry } =
            await import('../../../main/applications/skillmgr/registry/index.js');
        const original = [...allRegistries];
        const dispose = registerSkillRegistryProvider({
            id: 'test',
            getRegistries: async () => host.listSkillRegistries().map((item) => item.definition)
        });
        try {
            await ensureSkillRegistriesSynced();
            await expect(searchRegistry('throwing-registry', {})).rejects.toThrow('registry backend down');
        } finally {
            dispose();
            await ensureSkillRegistriesSynced();
            allRegistries.splice(0, allRegistries.length, ...original);
        }
    });
});
