import { jest } from '@jest/globals';
import type { PluginSkillRegistryDefinition } from '../../../../../packages/plugin-sdk/src/index.js';
import { registerSkillRegistryProvider } from '../../../main/applications/skillmgr/registry/provider.js';

/**
 * skillmgr 应用上插件注册表回代入口的测试：这三个方法是 worker 线程
 * （registry/worker-bridge.ts 经 callAppWithResponse）的调用目标，
 * 必须只依赖主进程本地 provider 状态、可序列化返回。
 */

function createDefinition(overrides: Partial<PluginSkillRegistryDefinition> = {}): PluginSkillRegistryDefinition {
    return {
        id: 'rpc-registry',
        label: 'RPC Registry',
        search: async () => ({
            skills: [
                {
                    id: 'rpc-skill',
                    name: 'RPC Skill',
                    description: 'from rpc registry',
                    source: 'rpc-registry',
                    installUrl: 'rpc-registry:rpc-skill',
                    canInstall: true
                }
            ],
            total: 1,
            hasMore: false
        }),
        ...overrides
    };
}

describe('skillmgr app 插件注册表回代入口', () => {
    const disposers: Array<() => void> = [];

    afterEach(() => {
        disposers.splice(0).forEach((dispose) => dispose());
    });

    test('getPluginSkillRegistries 返回可序列化元数据，searchPluginSkillRegistry 代理执行搜索', async () => {
        const searchSpy = jest.fn(async () => ({ skills: [], total: 0, hasMore: false }));
        disposers.push(
            registerSkillRegistryProvider({
                id: 'test',
                getRegistries: async () => [createDefinition({ search: searchSpy, guiHidden: true })]
            })
        );

        const { SkillMgrApplication } = await import('../../../main/applications/skillmgr/app.js');
        const app = Object.create(SkillMgrApplication.prototype) as SkillMgrApplication;

        const infos = await (
            app as unknown as { getPluginSkillRegistries(): Promise<Array<Record<string, unknown>>> }
        ).getPluginSkillRegistries();
        expect(infos).toHaveLength(1);
        expect(infos[0]).toMatchObject({ id: 'rpc-registry', label: 'RPC Registry', guiHidden: true });
        // 返回值必须可结构化克隆（跨线程 postMessage 的前置条件）
        expect(() => structuredClone(infos)).not.toThrow();

        const result = await (
            app as unknown as {
                searchPluginSkillRegistry(id: string, opts: unknown): Promise<{ total: number }>;
            }
        ).searchPluginSkillRegistry('rpc-registry', { query: 'rpc', limit: 5 });
        expect(result).toMatchObject({ total: 0, skills: [] });
        expect(searchSpy).toHaveBeenCalledWith({ query: 'rpc', limit: 5 });
    });

    test('searchPluginSkillRegistry 对未知注册表抛「未知 Registry」', async () => {
        const { SkillMgrApplication } = await import('../../../main/applications/skillmgr/app.js');
        const app = Object.create(SkillMgrApplication.prototype) as SkillMgrApplication;

        await expect(
            (app as unknown as { searchPluginSkillRegistry(id: string): Promise<unknown> }).searchPluginSkillRegistry(
                'nonexistent'
            )
        ).rejects.toThrow('未知 Registry: nonexistent');
    });

    test('resolvePluginSkillInstall：有 resolveInstall 返回计划，无则返回 null', async () => {
        disposers.push(
            registerSkillRegistryProvider({
                id: 'test',
                getRegistries: async () => [
                    createDefinition({
                        resolveInstall: async (installUrl) => ({
                            downloadUrl: `https://dl.example.com/?from=${installUrl}`
                        })
                    })
                ]
            })
        );
        disposers.push(
            registerSkillRegistryProvider({
                id: 'test-plain',
                getRegistries: async () => [createDefinition({ id: 'plain-rpc-registry' })]
            })
        );

        const { SkillMgrApplication } = await import('../../../main/applications/skillmgr/app.js');
        const app = Object.create(SkillMgrApplication.prototype) as SkillMgrApplication;
        const resolver = app as unknown as {
            resolvePluginSkillInstall(
                registryId: string,
                installUrl: string,
                parsed: { slug: string }
            ): Promise<{ downloadUrl: string } | null>;
        };

        const plan = await resolver.resolvePluginSkillInstall('rpc-registry', 'rpc-registry:x', { slug: 'x' });
        expect(plan).toEqual({ downloadUrl: 'https://dl.example.com/?from=rpc-registry:x' });

        const none = await resolver.resolvePluginSkillInstall('plain-rpc-registry', 'plain-rpc-registry:x', {
            slug: 'x'
        });
        expect(none).toBeNull();

        const unknown = await resolver.resolvePluginSkillInstall('missing-registry', 'missing-registry:x', {
            slug: 'x'
        });
        expect(unknown).toBeNull();
    });
});
