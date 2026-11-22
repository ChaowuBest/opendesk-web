import { afterEach, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { Skill, SkillRegistry } from '../../../main/aikernel/skill.js';
import { AgentDecl, type ModeDecl } from '../../../main/aikernel/agents/common.js';
import { AgentRegistry } from '../../../main/aikernel/agents/registry.js';
import { getFeatureManager, resetFeatureManagerForTests } from '../../../common/features/manager.js';

/**
 * disableApplication 要停掉应用的全部贡献，而不只是 UI 入口：
 * Skill（技能列表、LoadSkill/CallSkill 查找、prompt 暴露）与 Agent（提示词、派发、解析）
 * 都必须随应用禁用一起不可见，hideApplication 则只收起入口、不改变任何注册项。
 *
 * 过滤函数由 applications 层注入（SkillRegistry.registerProviderFilter /
 * AgentRegistry.registerVisibilityFilter），这里模拟同样的注入验证底层行为。
 */

const BUNDLE = 'contribution-test-app';
const AGENT_ID = `${BUNDLE}:stub-agent`;

function makeSkill(name: string): Skill {
    return new Skill({ name, description: `${name} description` }, '', undefined, []);
}

class StubAgent extends AgentDecl {
    readonly agentName = 'stub-agent';
    readonly dispatchable = true;
    readonly agentType = 'custom';
    readonly whenToUse = 'test agent';

    supportedModes(): ModeDecl[] {
        return [];
    }

    protected defaultModeId(): string {
        return 'standard';
    }

    async createSystemPrompt(): Promise<string> {
        return '';
    }
}

describe('disableApplication 停用应用的 Skill / Agent 贡献', () => {
    const skillRegistry = SkillRegistry.getInstance();

    beforeAll(() => {
        // applications 层（src/main/applications/registry.ts 的 ensureApplicationFeatureFilters）注入的同一套判断
        SkillRegistry.registerProviderFilter((bundleName) => !getFeatureManager().isApplicationDisabled(bundleName));
        AgentRegistry.registerVisibilityFilter((agent) => {
            const scope = agent.applicationScope;
            return scope === undefined || !getFeatureManager().isApplicationDisabled(scope);
        });
        AgentRegistry.initBuiltinAgents();
    });

    beforeEach(() => {
        resetFeatureManagerForTests();
        skillRegistry.registerSkillProvider(BUNDLE, { getSkills: async () => [makeSkill('manage-contribution')] });
    });

    afterEach(async () => {
        skillRegistry.unregisterSkillProvider(BUNDLE);
        skillRegistry.unregisterSkillProvider('staff:test-staff');
        skillRegistry.clearCache();
        await AgentRegistry.unloadApplicationAgents();
        resetFeatureManagerForTests();
    });

    test('禁用后技能整组不可见：列表、provider、缓存查找都查不到', async () => {
        // 先跑一次列表，让技能进入缓存（LoadSkill 等路径会命中缓存）
        const before = await skillRegistry.getAvailableSkills();
        expect(before.get(BUNDLE)?.map((skill) => skill.frontmatter.name)).toEqual(['manage-contribution']);
        expect(skillRegistry.getCachedSkill(BUNDLE, 'manage-contribution')).toBeDefined();

        getFeatureManager().setApplicationDisabled(BUNDLE, 'plugin-a', true);

        const disabled = await skillRegistry.getAvailableSkills();
        expect(disabled.get(BUNDLE)).toBeUndefined();
        expect(skillRegistry.getSkillProvider(BUNDLE)).toBeUndefined();
        expect(skillRegistry.getCachedSkill(BUNDLE, 'manage-contribution')).toBeUndefined();
        const raw = await skillRegistry.getAllSkillsRaw();
        expect(raw.get(BUNDLE)).toBeUndefined();
    });

    test('禁用解除后技能恢复可见', async () => {
        getFeatureManager().setApplicationDisabled(BUNDLE, 'plugin-a', true);
        expect((await skillRegistry.getAvailableSkills()).get(BUNDLE)).toBeUndefined();

        getFeatureManager().setApplicationDisabled(BUNDLE, 'plugin-a', false);
        const restored = await skillRegistry.getAvailableSkills();
        expect(restored.get(BUNDLE)?.map((skill) => skill.frontmatter.name)).toEqual(['manage-contribution']);
    });

    test('禁用后应用 Agent 不可见，内置 Agent 不受影响', async () => {
        await AgentRegistry.replaceApplicationAgent(BUNDLE, new StubAgent());
        expect(AgentRegistry.getAgent(AGENT_ID)).toBeDefined();
        expect(AgentRegistry.getAgent('main')).toBeDefined();

        getFeatureManager().setApplicationDisabled(BUNDLE, 'plugin-a', true);

        expect(AgentRegistry.getAgent(AGENT_ID)).toBeUndefined();
        expect(AgentRegistry.getAgents().some((agent) => agent.agentId === AGENT_ID)).toBe(false);
        // 内置 Agent 没有应用作用域，不受应用级禁用影响
        expect(AgentRegistry.getAgent('main')).toBeDefined();
        // 注册表本体仍持有它：已绑定的任务据此判断「被禁用」而非「已失效」，不会永久改写绑定
        expect(AgentRegistry.hasRegisteredAgent(AGENT_ID)).toBe(true);

        getFeatureManager().setApplicationDisabled(BUNDLE, 'plugin-a', false);
        expect(AgentRegistry.getAgent(AGENT_ID)).toBeDefined();
    });

    test('插件 Agent 不会因为同名的应用被禁用而被过滤', async () => {
        class PluginAgent extends AgentDecl {
            readonly agentName = 'plugin-stub';
            readonly dispatchable = true;
            readonly agentType = 'custom';
            readonly whenToUse = 'plugin agent';

            supportedModes(): ModeDecl[] {
                return [];
            }

            protected defaultModeId(): string {
                return 'standard';
            }

            async createSystemPrompt(): Promise<string> {
                return '';
            }
        }

        await AgentRegistry.replacePluginAgents([{ bundleName: BUNDLE, agents: [new PluginAgent()] }]);
        getFeatureManager().setApplicationDisabled(BUNDLE, 'plugin-a', true);

        // 插件 Agent 的生命周期归插件宿主，不参与应用级禁用过滤
        expect(AgentRegistry.getAgent(`${BUNDLE}:plugin-stub`)).toBeDefined();
        await AgentRegistry.unloadPluginAgents();
    });

    test('hideApplication 只隐藏入口，不影响 Skill / Agent 可见性', async () => {
        await AgentRegistry.replaceApplicationAgent(BUNDLE, new StubAgent());
        getFeatureManager().setApplicationHidden(BUNDLE, 'plugin-a', true);

        expect(getFeatureManager().isApplicationDisabled(BUNDLE)).toBe(false);
        expect(skillRegistry.getSkillProvider(BUNDLE)).toBeDefined();
        expect(AgentRegistry.getAgent(AGENT_ID)).toBeDefined();
    });

    test('应用内 agent 的技能 provider 通过 owner 跟随应用一起停用', async () => {
        // 应用内 agent 的技能 provider key（staff:xxx）与应用名无关，靠 ownerBundleName 声明归属
        const scopedKey = 'staff:test-staff';
        skillRegistry.registerSkillProvider(scopedKey, {
            ownerBundleName: BUNDLE,
            getSkills: async () => [makeSkill('staff-skill')]
        });
        expect((await skillRegistry.getAvailableSkills()).get(scopedKey)).toHaveLength(1);

        getFeatureManager().setApplicationDisabled(BUNDLE, 'plugin-a', true);
        expect((await skillRegistry.getAvailableSkills()).get(scopedKey)).toBeUndefined();
        expect(skillRegistry.getSkillProvider(scopedKey)).toBeUndefined();

        getFeatureManager().setApplicationDisabled(BUNDLE, 'plugin-a', false);
        expect((await skillRegistry.getAvailableSkills()).get(scopedKey)).toHaveLength(1);
        skillRegistry.unregisterSkillProvider(scopedKey);
    });
});

describe('应用贡献门控的接线位置', () => {
    test('applications 层把「应用被禁用」注入 Skill / Agent 注册表', () => {
        const registrySource = readFileSync(new URL('../../../main/applications/registry.ts', import.meta.url), 'utf8');
        expect(registrySource).toContain('SkillRegistry.registerProviderFilter');
        expect(registrySource).toContain('AgentRegistry.registerVisibilityFilter');
        expect(registrySource).toContain('ensureApplicationFeatureFilters();');
    });

    test('TUI 不注册被禁用应用的斜杠命令，并在执行前再校验', () => {
        const entrySource = readFileSync(new URL('../../../main/tui/entry.ts', import.meta.url), 'utf8');
        const registerSource = entrySource.slice(
            entrySource.indexOf('private registerApplicationCommands()'),
            entrySource.indexOf('private async refreshActiveTaskSystemPrompt()')
        );
        expect(registerSource).toContain('isApplicationDisabled(bundleName)');
        expect(registerSource).toContain("t('feature.application.disabled'");
    });
});
