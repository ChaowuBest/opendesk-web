import { jest } from '@jest/globals';
import type { PluginSkillRegistryDefinition } from '../../../../packages/plugin-sdk/src/index.js';
import {
    ContributedSkillRegistry,
    ProxySkillRegistry,
    isFilterAvailableOnPlatform,
    serializeSkillRegistryInfo
} from '../../../main/applications/skillmgr/registry/contributed.js';
import { registerSkillRegistryProvider } from '../../../main/applications/skillmgr/registry/provider.js';
import {
    allRegistries,
    ensureSkillRegistriesSynced,
    getRegistriesInfo,
    getTuiRegistriesInfo,
    getRegistry,
    searchRegistry,
    parseInstallUrl,
    getInstallMethod
} from '../../../main/applications/skillmgr/registry/index.js';
import { SkillInstallManager } from '../../../main/applications/skillmgr/utils/skill-installer.js';

function createDefinition(overrides: Partial<PluginSkillRegistryDefinition> = {}): PluginSkillRegistryDefinition {
    return {
        id: 'contributed-skills',
        label: 'Contributed Skills',
        icon: '🧩',
        iconClass: 'contributed',
        slogan: 'Contributed slogan',
        search: async () => ({ skills: [], total: 0, hasMore: false }),
        ...overrides
    };
}

describe('skillmgr 贡献注册表', () => {
    const originalRegistries = [...allRegistries];
    const disposers: Array<() => void> = [];

    afterEach(async () => {
        disposers.splice(0).forEach((dispose) => dispose());
        await ensureSkillRegistriesSynced();
        allRegistries.splice(0, allRegistries.length, ...originalRegistries);
    });

    test('provider 贡献的注册表被适配进 allRegistries，行为与内置注册表一致', async () => {
        const searchSpy = jest.fn(async () => ({
            skills: [
                {
                    id: 'demo-skill',
                    name: 'Demo Skill',
                    description: 'A demo skill',
                    source: 'contributed-skills',
                    installUrl: 'contributed-skills:demo-skill',
                    canInstall: true
                }
            ],
            total: 1,
            hasMore: false
        }));
        disposers.push(
            registerSkillRegistryProvider({
                id: 'test',
                getRegistries: async () => [createDefinition({ search: searchSpy })]
            })
        );
        await ensureSkillRegistriesSynced();

        expect(allRegistries.map((registry) => registry.id)).toContain('contributed-skills');
        expect(getRegistry('contributed-skills')).toBeInstanceOf(ContributedSkillRegistry);

        const infos = await getRegistriesInfo();
        const contributed = infos.find((info) => info.id === 'contributed-skills');
        expect(contributed).toMatchObject({
            id: 'contributed-skills',
            label: 'Contributed Skills',
            icon: '🧩',
            slogan: 'Contributed slogan'
        });

        const result = await searchRegistry('contributed-skills', { query: 'demo' });
        expect(result.skills).toHaveLength(1);
        expect(searchSpy).toHaveBeenCalledWith({ query: 'demo' });

        expect(parseInstallUrl('contributed-skills:demo-skill')).toEqual({ slug: 'demo-skill' });
        expect(getInstallMethod('contributed-skills:demo-skill')).toBe('contributed-skills');
    });

    test('guiHidden 的注册表不出现在 GUI 市场信息中，但搜索仍可用', async () => {
        disposers.push(
            registerSkillRegistryProvider({
                id: 'test',
                getRegistries: async () => [
                    createDefinition({ id: 'gui-visible', label: 'GUI Visible' }),
                    createDefinition({ id: 'gui-hidden', label: 'GUI Hidden', guiHidden: true })
                ]
            })
        );
        await ensureSkillRegistriesSynced();

        const infos = await getRegistriesInfo();
        expect(infos.map((info) => info.id)).toContain('gui-visible');
        expect(infos.map((info) => info.id)).not.toContain('gui-hidden');

        const tuiInfos = await getTuiRegistriesInfo();
        expect(tuiInfos).toEqual(
            expect.arrayContaining([
                { id: 'gui-visible', label: 'GUI Visible' },
                { id: 'gui-hidden', label: 'GUI Hidden' }
            ])
        );

        // guiHidden 只影响 GUI tab；agent 工具 / TUI 搜索路径不受影响
        await expect(searchRegistry('gui-hidden', {})).resolves.toMatchObject({ skills: [] });
    });

    test('TUI registry 列表在插件停用后移除其贡献', async () => {
        const dispose = registerSkillRegistryProvider({
            id: 'test',
            getRegistries: async () => [createDefinition({ id: 'temporary', label: 'Temporary' })]
        });
        disposers.push(dispose);
        expect(await getTuiRegistriesInfo()).toContainEqual({ id: 'temporary', label: 'Temporary' });

        dispose();
        expect(await getTuiRegistriesInfo()).not.toContainEqual({ id: 'temporary', label: 'Temporary' });
    });

    test('声明 resolveInstall 的贡献注册表在安装路由中使用其下载地址', async () => {
        disposers.push(
            registerSkillRegistryProvider({
                id: 'test',
                getRegistries: async () => [
                    createDefinition({
                        id: 'installable-registry',
                        label: 'Installable Registry',
                        resolveInstall: async (installUrl, parsed) => ({
                            downloadUrl: `https://dl.example.com/${parsed.slug}.zip?src=${installUrl}`
                        })
                    })
                ]
            })
        );
        await ensureSkillRegistriesSynced();

        const manager = Object.create(SkillInstallManager.prototype) as SkillInstallManager;
        const installFromUrlSpy = jest.fn(async (url: string) => ({ success: true, name: url }));
        (manager as unknown as { installFromUrl: unknown }).installFromUrl = installFromUrlSpy;

        const result = await manager.installFromRegistryInstallUrl('installable-registry:demo-skill');

        expect(result.success).toBe(true);
        expect(installFromUrlSpy).toHaveBeenCalledWith(
            'https://dl.example.com/demo-skill.zip?src=installable-registry:demo-skill',
            expect.anything()
        );
    });

    test('resolveInstall 返回空计划时回退 installFromUrl(installUrl)', async () => {
        disposers.push(
            registerSkillRegistryProvider({
                id: 'test',
                getRegistries: async () => [
                    createDefinition({
                        id: 'null-plan-registry',
                        label: 'Null Plan Registry',
                        resolveInstall: async () => null
                    })
                ]
            })
        );
        await ensureSkillRegistriesSynced();

        const manager = Object.create(SkillInstallManager.prototype) as SkillInstallManager;
        const installFromUrlSpy = jest.fn(async (url: string) => ({ success: true, name: url }));
        (manager as unknown as { installFromUrl: unknown }).installFromUrl = installFromUrlSpy;

        await manager.installFromRegistryInstallUrl('null-plan-registry:demo-skill');

        expect(installFromUrlSpy).toHaveBeenCalledWith('null-plan-registry:demo-skill', expect.anything());
    });

    test('resolveInstall 抛错时错误向调用方传播', async () => {
        disposers.push(
            registerSkillRegistryProvider({
                id: 'test',
                getRegistries: async () => [
                    createDefinition({
                        id: 'throwing-registry',
                        label: 'Throwing Registry',
                        resolveInstall: async () => {
                            throw new Error('plan failed');
                        }
                    })
                ]
            })
        );
        await ensureSkillRegistriesSynced();

        const manager = Object.create(SkillInstallManager.prototype) as SkillInstallManager;
        (manager as unknown as { installFromUrl: unknown }).installFromUrl = jest.fn(async (url: string) => ({
            success: true,
            name: url
        }));

        await expect(manager.installFromRegistryInstallUrl('throwing-registry:demo-skill')).rejects.toThrow(
            'plan failed'
        );
    });

    test('searchSkillsFromAllRegistries 覆盖贡献注册表（agent 工具路径）', async () => {
        disposers.push(
            registerSkillRegistryProvider({
                id: 'test',
                getRegistries: async () => [
                    createDefinition({
                        id: 'contributed-skills',
                        label: 'Contributed Skills',
                        search: async () => ({
                            skills: [
                                {
                                    id: 'agent-demo',
                                    name: 'Agent Demo',
                                    description: 'found via all-registries search',
                                    source: 'contributed-skills',
                                    installUrl: 'contributed-skills:agent-demo',
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
        await ensureSkillRegistriesSynced();

        const manager = Object.create(SkillInstallManager.prototype) as SkillInstallManager;
        const result = await manager.searchSkillsFromAllRegistries('agent demo');

        expect(result.errors).toEqual([]);
        const hit = result.results.find((skill) => skill.registryName === 'contributed-skills');
        expect(hit).toMatchObject({ skillId: 'agent-demo', installUrl: 'contributed-skills:agent-demo' });
    });

    test('installSkillFromRegistryByName 支持贡献注册表（按 id 与 label 匹配）', async () => {
        disposers.push(
            registerSkillRegistryProvider({
                id: 'test',
                getRegistries: async () => [
                    createDefinition({
                        id: 'named-registry',
                        label: 'Named Registry',
                        search: async () => ({
                            skills: [
                                {
                                    id: 'target-skill',
                                    name: 'target-skill',
                                    description: 'installable by name',
                                    source: 'named-registry',
                                    installUrl: 'named-registry:target-skill',
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
        await ensureSkillRegistriesSynced();

        const manager = Object.create(SkillInstallManager.prototype) as SkillInstallManager;
        const installStub = jest.fn(async (installUrl: string, force: boolean) => ({
            success: true,
            name: `${installUrl}#${force}`
        }));
        const installOptions = { install: installStub, skillExists: () => false };

        const byId = await manager.installSkillFromRegistryByName('named-registry', 'target-skill', installOptions);
        expect(byId.success).toBe(true);
        expect(byId.registryName).toBe('named-registry');
        expect(byId.matchedSkill).toBe('target-skill');
        expect(installStub).toHaveBeenCalledWith('named-registry:target-skill', false);

        const byLabel = await manager.installSkillFromRegistryByName('Named Registry', 'target-skill', installOptions);
        expect(byLabel.success).toBe(true);
        expect(byLabel.registryName).toBe('named-registry');
    });

    test('同步幂等：provider 返回新定义时替换旧实例，不产生重复（插件重载模拟）', async () => {
        let version = 0;
        disposers.push(
            registerSkillRegistryProvider({
                id: 'test',
                getRegistries: async () => [createDefinition({ id: 'versioned-skills', label: `V${version}` })]
            })
        );

        await ensureSkillRegistriesSynced();
        expect(allRegistries.filter((registry) => registry.id === 'versioned-skills')).toHaveLength(1);

        version = 1;
        await ensureSkillRegistriesSynced();
        const instances = allRegistries.filter((registry) => registry.id === 'versioned-skills');
        expect(instances).toHaveLength(1);
        expect(instances[0].label).toBe('V1');
    });

    test('跨 provider 重复 id 合并时去重保留首个', async () => {
        disposers.push(
            registerSkillRegistryProvider({
                id: 'test-first',
                getRegistries: async () => [createDefinition({ id: 'clashing-skills', label: 'First' })]
            })
        );
        disposers.push(
            registerSkillRegistryProvider({
                id: 'test-second',
                getRegistries: async () => [createDefinition({ id: 'clashing-skills', label: 'Second' })]
            })
        );
        await ensureSkillRegistriesSynced();

        const instances = allRegistries.filter((registry) => registry.id === 'clashing-skills');
        expect(instances).toHaveLength(1);
        expect(instances[0].label).toBe('First');
    });

    test('provider 抛错时其余 provider 的注册表仍被合并，且失败不毒化后续同步', async () => {
        let healthy = false;
        disposers.push(
            registerSkillRegistryProvider({
                id: 'test-broken',
                getRegistries: async () => {
                    throw new Error('provider exploded');
                }
            })
        );
        disposers.push(
            registerSkillRegistryProvider({
                id: 'test',
                getRegistries: async () => {
                    if (!healthy) throw new Error('not ready');
                    return [createDefinition({ id: 'late-skills' })];
                }
            })
        );

        await ensureSkillRegistriesSynced();
        expect(allRegistries.map((registry) => registry.id)).not.toContain('late-skills');

        healthy = true;
        await ensureSkillRegistriesSynced();
        expect(allRegistries.map((registry) => registry.id)).toContain('late-skills');
    });

    test('并发 ensure 调用串行化，不产生重复实例', async () => {
        disposers.push(
            registerSkillRegistryProvider({
                id: 'test',
                getRegistries: async () => [createDefinition({ id: 'concurrent-skills' })]
            })
        );

        await Promise.all([
            ensureSkillRegistriesSynced(),
            ensureSkillRegistriesSynced(),
            ensureSkillRegistriesSynced()
        ]);

        expect(allRegistries.filter((registry) => registry.id === 'concurrent-skills')).toHaveLength(1);
    });

    test('安装路由契约：内置前缀/贡献前缀/GitHub/zip 各归其位', async () => {
        await ensureSkillRegistriesSynced();

        const cases: Array<[string, string]> = [
            // 内置前缀固定有效（BUILTIN_INSTALL_REGISTRY_IDS 回退，不依赖插件加载）
            ['matrix:foo', 'matrix'],
            ['clawhub:foo', 'clawhub'],
            ['modelscope:owner/name', 'modelscope'],
            ['skillhub:foo', 'skillhub'],
            // GitHub 仓库地址优先于前缀猜测
            ['https://github.com/o/r/tree/main', 'github'],
            ['https://github.com/o/r', 'github'],
            // 普通 zip URL；带冒号的 query 不干扰判定
            ['https://example.com/a.zip', 'zip'],
            ['https://example.com/a?x=y:z', 'zip'],
            // 非法输入
            ['', 'zip']
        ];
        for (const [installUrl, expected] of cases) {
            expect(getInstallMethod(installUrl)).toBe(expected);
        }

        // slug@version 解析（内置前缀回退路径）
        expect(parseInstallUrl('matrix:foo@1.2')).toEqual({ slug: 'foo', version: '1.2' });
        expect(parseInstallUrl('modelscope:owner/name')).toEqual({ slug: 'owner/name' });
        // 非 builtin 前缀在无贡献注册表时不解析
        expect(parseInstallUrl('unknown-registry:foo')).toBeNull();
    });

    test('未声明 slogan 的贡献注册表回退到基类默认标语', async () => {
        disposers.push(
            registerSkillRegistryProvider({
                id: 'test',
                getRegistries: async () => [createDefinition({ id: 'no-slogan-skills', slogan: undefined })]
            })
        );
        await ensureSkillRegistriesSynced();

        const registry = getRegistry('no-slogan-skills')!;
        expect(registry.slogan).toBe('技能，让智能体无所不能');
    });

    test('searchSkillsFromAllRegistries 聚合失败注册表的错误且不影响健康注册表', async () => {
        disposers.push(
            registerSkillRegistryProvider({
                id: 'test',
                getRegistries: async () => [
                    createDefinition({
                        id: 'healthy-aggregate',
                        label: 'Healthy Aggregate',
                        search: async () => ({
                            skills: [
                                {
                                    id: 'agg-hit',
                                    name: 'agg-hit',
                                    description: 'healthy hit',
                                    source: 'healthy-aggregate',
                                    installUrl: 'healthy-aggregate:agg-hit',
                                    canInstall: true
                                }
                            ],
                            total: 1,
                            hasMore: false
                        })
                    }),
                    createDefinition({
                        id: 'broken-aggregate',
                        label: 'Broken Aggregate',
                        search: async () => {
                            throw new Error('upstream 500');
                        }
                    })
                ]
            })
        );
        await ensureSkillRegistriesSynced();

        const manager = Object.create(SkillInstallManager.prototype) as SkillInstallManager;
        const result = await manager.searchSkillsFromAllRegistries('agg');

        expect(result.results.map((skill) => skill.registryName)).toContain('healthy-aggregate');
        const brokenError = result.errors.find((error) => error.registryName === 'broken-aggregate');
        expect(brokenError?.error).toContain('upstream 500');
    });

    test('未声明 resolveInstall 的贡献注册表保持原 zip 回退行为', async () => {
        disposers.push(
            registerSkillRegistryProvider({
                id: 'test',
                getRegistries: async () => [createDefinition({ id: 'plain-registry', label: 'Plain Registry' })]
            })
        );
        await ensureSkillRegistriesSynced();

        const manager = Object.create(SkillInstallManager.prototype) as SkillInstallManager;
        const installFromUrlSpy = jest.fn(async (url: string) => ({ success: true, name: url }));
        (manager as unknown as { installFromUrl: unknown }).installFromUrl = installFromUrlSpy;

        await manager.installFromRegistryInstallUrl('plain-registry:demo-skill');

        expect(installFromUrlSpy).toHaveBeenCalledWith('plain-registry:demo-skill', expect.anything());
    });

    test('serializeSkillRegistryInfo 输出可结构化克隆的元数据', () => {
        const info = serializeSkillRegistryInfo(
            createDefinition({
                guiHidden: true,
                filters: [{ id: 'f', labelOn: 'on', labelOff: 'off', categoryValue: 'cat' }],
                resolveInstall: async () => ({ downloadUrl: 'https://dl.example.com/x.zip' })
            })
        );

        expect(info).toEqual({
            id: 'contributed-skills',
            label: 'Contributed Skills',
            icon: '🧩',
            iconClass: 'contributed',
            slogan: 'Contributed slogan',
            guiHidden: true,
            filters: [{ id: 'f', labelOn: 'on', labelOff: 'off', categoryValue: 'cat' }],
            supportsResolveInstall: true
        });
        expect(serializeSkillRegistryInfo(createDefinition())).toMatchObject({
            guiHidden: undefined,
            supportsResolveInstall: false
        });
    });

    test('平台专属筛选器只在声明平台下发，未声明 platforms 的全平台可用', async () => {
        const harmonyOnly = {
            id: 'harmony_pc',
            labelOn: '鸿蒙PC兼容技能',
            labelOff: '所有技能',
            categoryValue: '鸿蒙PC',
            platforms: ['openharmony' as const]
        };
        const always = { id: 'always', labelOn: 'on', labelOff: 'off', categoryValue: 'all' };

        expect(isFilterAvailableOnPlatform(always, 'linux')).toBe(true);
        expect(isFilterAvailableOnPlatform(always, 'openharmony')).toBe(true);
        expect(isFilterAvailableOnPlatform(harmonyOnly, 'openharmony')).toBe(true);
        expect(isFilterAvailableOnPlatform(harmonyOnly, 'linux')).toBe(false);

        disposers.push(
            registerSkillRegistryProvider({
                id: 'test',
                getRegistries: async () => [
                    createDefinition({
                        id: 'platform-filters',
                        label: 'Platform Filters',
                        filters: [harmonyOnly, always]
                    })
                ]
            })
        );
        await ensureSkillRegistriesSynced();

        const expectedIds = process.platform === 'openharmony' ? ['harmony_pc', 'always'] : ['always'];
        expect(getRegistry('platform-filters')!.filters.map((filter) => filter.id)).toEqual(expectedIds);

        const infos = await getRegistriesInfo();
        const registryInfo = infos.find((info) => info.id === 'platform-filters')!;
        expect(registryInfo.filters.map((filter) => filter.id)).toEqual(expectedIds);

        // 切换到鸿蒙平台：专属筛选器下发（filters 出口按当前 platform 动态裁剪）
        const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.defineProperty(process, 'platform', { value: 'openharmony', configurable: true });
        try {
            expect(getRegistry('platform-filters')!.filters.map((filter) => filter.id)).toEqual([
                'harmony_pc',
                'always'
            ]);
        } finally {
            if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
        }

        // worker 线程侧适配器（元数据来自插件定义序列化）走同一裁剪出口
        const proxy = new ProxySkillRegistry(
            {
                id: 'proxy-platform',
                label: 'Proxy Platform',
                filters: [harmonyOnly, always],
                supportsResolveInstall: false
            },
            async () => ({ skills: [], total: 0, hasMore: false }) as never
        );
        expect(proxy.filters.map((filter) => filter.id)).toEqual(expectedIds);
    });

    test('ProxySkillRegistry 经注入的 RPC 通道回代 search 与 resolveInstall', async () => {
        const invoke = jest.fn(async <R>(method: string, ...args: unknown[]): Promise<R> => {
            if (method === 'searchPluginSkillRegistry') {
                expect(args).toEqual(['proxy-registry', { query: 'demo' }]);
                return { skills: [], total: 0, hasMore: false } as R;
            }
            if (method === 'resolvePluginSkillInstall') {
                expect(args).toEqual(['proxy-registry', 'proxy-registry:x', { slug: 'x' }]);
                return { downloadUrl: 'https://dl.example.com/x.zip' } as R;
            }
            throw new Error(`unexpected method: ${method}`);
        });
        const proxy = new ProxySkillRegistry(
            {
                id: 'proxy-registry',
                label: 'Proxy Registry',
                icon: '📡',
                guiHidden: true,
                supportsResolveInstall: true
            },
            invoke
        );

        expect(proxy.icon).toBe('📡');
        expect(proxy.guiHidden).toBe(true);
        await expect(proxy.search({ query: 'demo' })).resolves.toMatchObject({ skills: [] });
        await expect(proxy.resolveInstall('proxy-registry:x', { slug: 'x' })).resolves.toMatchObject({
            downloadUrl: 'https://dl.example.com/x.zip'
        });

        // supportsResolveInstall=false 时不发起 resolveInstall RPC
        const lazyInvoke = jest.fn(async () => null);
        const lazy = new ProxySkillRegistry(
            { id: 'lazy-registry', label: 'Lazy', supportsResolveInstall: false },
            lazyInvoke as unknown as typeof invoke
        );
        await expect(lazy.resolveInstall('lazy-registry:x', { slug: 'x' })).resolves.toBeNull();
        expect(lazyInvoke).not.toHaveBeenCalled();
    });
});
