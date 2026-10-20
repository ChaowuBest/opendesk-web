import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { Skill, SkillRegistry } from '../../../main/aikernel/skill';

const BUNDLE_A = 'test-provider-cache-a';
const BUNDLE_B = 'test-provider-cache-b';

function makeSkill(name: string): Skill {
    return new Skill({ name, description: `${name} description` }, '', undefined, []);
}

function makeProvider(skills: Skill[]) {
    return { getSkills: jest.fn(async () => skills) };
}

describe('SkillRegistry per-provider result cache', () => {
    const registry = SkillRegistry.getInstance();

    afterEach(() => {
        registry.unregisterSkillProvider(BUNDLE_A);
        registry.unregisterSkillProvider(BUNDLE_B);
        registry.clearCache();
    });

    test('caches the provider result across repeated listings', async () => {
        const provider = makeProvider([makeSkill('skill-a1')]);
        registry.registerSkillProvider(BUNDLE_A, provider);

        await registry.getUserInvocableSkills();
        await registry.getUserInvocableSkills();
        await registry.getAllSkillsRaw();

        expect(provider.getSkills).toHaveBeenCalledTimes(1);
    });

    test('rebuilds after clearCache(bundleName)', async () => {
        const provider = makeProvider([makeSkill('skill-a1')]);
        registry.registerSkillProvider(BUNDLE_A, provider);

        await registry.getUserInvocableSkills();
        registry.clearCache(BUNDLE_A);
        await registry.getUserInvocableSkills();

        expect(provider.getSkills).toHaveBeenCalledTimes(2);
    });

    test('rebuilds after the provider is replaced', async () => {
        const first = makeProvider([makeSkill('skill-old')]);
        registry.registerSkillProvider(BUNDLE_A, first);
        await registry.getUserInvocableSkills();

        const second = makeProvider([makeSkill('skill-new')]);
        registry.registerSkillProvider(BUNDLE_A, second);
        const raw = await registry.getAllSkillsRaw();

        expect(second.getSkills).toHaveBeenCalledTimes(1);
        expect(raw.get(BUNDLE_A)!.map((skill) => skill.frontmatter.name)).toEqual(['skill-new']);
    });

    test('clearCache() without a bundle clears every provider', async () => {
        const pa = makeProvider([makeSkill('skill-a1')]);
        const pb = makeProvider([makeSkill('skill-b1')]);
        registry.registerSkillProvider(BUNDLE_A, pa);
        registry.registerSkillProvider(BUNDLE_B, pb);

        await registry.getUserInvocableSkills();
        registry.clearCache();
        await registry.getUserInvocableSkills();

        expect(pa.getSkills).toHaveBeenCalledTimes(2);
        expect(pb.getSkills).toHaveBeenCalledTimes(2);
    });

    test('a failing provider load is not cached and retries', async () => {
        // 与现状一致：provider 抛错由 registry 捕获记录，该 bundle 在本次结果中缺席；
        // 缓存层不得缓存失败结果，否则后续调用将永久缺席
        const provider = {
            getSkills: jest.fn(async () => {
                throw new Error('transient failure');
            })
        };
        registry.registerSkillProvider(BUNDLE_A, provider);

        await registry.getUserInvocableSkills();
        await registry.getUserInvocableSkills();

        expect(provider.getSkills).toHaveBeenCalledTimes(2);
    });

    test('unregistering a provider drops its cached result', async () => {
        const provider = makeProvider([makeSkill('skill-a1')]);
        registry.registerSkillProvider(BUNDLE_A, provider);
        await registry.getUserInvocableSkills();
        registry.unregisterSkillProvider(BUNDLE_A);

        const replacement = makeProvider([]);
        registry.registerSkillProvider(BUNDLE_A, replacement);
        const skills = await registry.getUserInvocableSkills();

        expect(skills.filter((entry) => entry.bundleName === BUNDLE_A)).toHaveLength(0);
    });
});
