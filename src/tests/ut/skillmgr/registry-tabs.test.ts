import {
    mergeRegistryTabState,
    mergeRegistryTabs
} from '../../../main/applications/skillmgr/renderer/registry-tabs.js';

const BUILTIN_TABS = [
    { id: 'matrix', label: 'OpenHarmony Matrix', icon: '🔷', sloganKey: 'renderer.skill.slogan.matrix' },
    { id: 'clawhub', label: 'ClawHub', icon: '🐾', sloganKey: 'renderer.skill.slogan.clawhub' },
    { id: 'skillhub', label: 'SkillHub', icon: '💎', sloganKey: 'renderer.skill.slogan.skillhub' },
    { id: 'modelscope', label: 'ModelScope', icon: '🔮', sloganKey: 'renderer.skill.slogan.modelscope' }
];

/** 生产形态：getRegistriesInfo 返回全部已启用（非 guiHidden）注册表 */
const ALL_BUILTIN_INFOS = BUILTIN_TABS.map((tab) => ({ id: tab.id, label: tab.label, icon: tab.icon }));

describe('skillmgr 渲染端注册表 tab 合并', () => {
    test('全部注册表在列时仅更新元数据，顺序与 sloganKey 保持不变', () => {
        const tabs = BUILTIN_TABS.map((tab) => ({ ...tab }));
        const removed = mergeRegistryTabs(
            tabs,
            ALL_BUILTIN_INFOS.map((info) => (info.id === 'matrix' ? { ...info, label: 'Matrix Skill' } : info))
        );

        expect(removed).toEqual([]);
        expect(tabs.map((tab) => tab.id)).toEqual(['matrix', 'clawhub', 'skillhub', 'modelscope']);
        expect(tabs[0].label).toBe('Matrix Skill');
        expect(tabs[0].sloganKey).toBe('renderer.skill.slogan.matrix');
    });

    test('插件贡献的新注册表追加到末尾并打 contributed 标记', () => {
        const tabs = BUILTIN_TABS.map((tab) => ({ ...tab }));
        const removed = mergeRegistryTabs(tabs, [
            ...ALL_BUILTIN_INFOS,
            { id: 'acme', label: 'Acme', icon: '🧪', filters: [{ id: 'f' }] }
        ]);

        expect(removed).toEqual([]);
        expect(tabs).toHaveLength(5);
        expect(tabs[4]).toMatchObject({
            id: 'acme',
            label: 'Acme',
            icon: '🧪',
            sloganKey: null,
            filters: [{ id: 'f' }],
            contributed: true
        });
    });

    test('注册表消失（插件禁用/卸载）时对应 tab 被清除，含内置品牌 tab', () => {
        const tabs = BUILTIN_TABS.map((tab) => ({ ...tab }));
        mergeRegistryTabs(tabs, [...ALL_BUILTIN_INFOS, { id: 'acme', label: 'Acme' }, { id: 'beta', label: 'Beta' }]);
        expect(tabs.map((tab) => tab.id)).toEqual(['matrix', 'clawhub', 'skillhub', 'modelscope', 'acme', 'beta']);

        // 第三方插件禁用：acme 消失、beta 与四个内置 tab 仍在
        const removedFirst = mergeRegistryTabs(tabs, [...ALL_BUILTIN_INFOS, { id: 'beta', label: 'Beta' }]);
        expect(removedFirst).toEqual(['acme']);
        expect(tabs.map((tab) => tab.id)).toEqual(['matrix', 'clawhub', 'skillhub', 'modelscope', 'beta']);

        // 内置品牌被禁用（infos 成功拉取但缺失对应注册表）→ 对应默认 tab 同样清除，
        // 避免「死 tab」点击报未知 Registry；infos 拉取失败走调用方 catch，不会到这里
        const removedSecond = mergeRegistryTabs(tabs, [{ id: 'beta', label: 'Beta' }]);
        expect(removedSecond.sort()).toEqual(['clawhub', 'matrix', 'modelscope', 'skillhub']);
        expect(tabs.map((tab) => tab.id)).toEqual(['beta']);
    });

    test('贡献注册表与内置 tab 同 id 时就地更新，不追加不标记', () => {
        const tabs = BUILTIN_TABS.map((tab) => ({ ...tab }));
        const removed = mergeRegistryTabs(tabs, [
            ...ALL_BUILTIN_INFOS.map((info) =>
                info.id === 'matrix' ? { ...info, label: 'Third-party Matrix' } : info
            ),
            { id: 'acme', label: 'Acme' }
        ]);

        expect(removed).toEqual([]);
        expect(tabs).toHaveLength(5);
        const matrix = tabs.find((tab) => tab.id === 'matrix')!;
        expect(matrix.label).toBe('Third-party Matrix');
        expect(matrix.sloganKey).toBe('renderer.skill.slogan.matrix');
        expect(matrix.contributed).toBeUndefined();
        // 同名贡献不会产生第二个 matrix tab
        expect(tabs.filter((tab) => tab.id === 'matrix')).toHaveLength(1);
    });

    test('重复刷新幂等：同一批 infos 多次合并不产生重复 tab', () => {
        const tabs = BUILTIN_TABS.map((tab) => ({ ...tab }));
        const infos = [...ALL_BUILTIN_INFOS, { id: 'acme', label: 'Acme' }];
        mergeRegistryTabs(tabs, infos);
        mergeRegistryTabs(tabs, infos);
        mergeRegistryTabs(tabs, infos);

        expect(tabs.map((tab) => tab.id)).toEqual(['matrix', 'clawhub', 'skillhub', 'modelscope', 'acme']);
    });

    test('刷新注册表快照时清理停用 tab 的页面状态并回退当前 tab', () => {
        const tabs = BUILTIN_TABS.map((tab) => ({ ...tab }));
        const states = {
            matrix: { results: ['matrix-skill'] },
            clawhub: { results: ['stale-clawhub-skill'] }
        };

        const result = mergeRegistryTabState(tabs, states, 'clawhub', [{ id: 'matrix', label: 'Matrix' }]);

        expect(result).toEqual({ removedIds: ['modelscope', 'skillhub', 'clawhub'], activeTab: 'installed' });
        expect(tabs.map((tab) => tab.id)).toEqual(['matrix']);
        expect(states).toEqual({ matrix: { results: ['matrix-skill'] } });
    });
});
