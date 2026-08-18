import assert from 'node:assert/strict';
import test from 'node:test';
import { GlobalHooks } from '../../../main/aikernel/hooks.js';
import { Skill, SkillLoadBlockedError, SkillRegistry } from '../../../main/aikernel/skill.js';

test('Hooks.checkBeforeSkillLoad returns allow when every callback allows', async () => {
    const hooks = GlobalHooks.createChildHooks();
    hooks.beforeSkillLoad(() => ({ operation: 'allow' }));
    hooks.beforeSkillLoad(() => ({ operation: 'allow' }));

    const decision = await hooks.checkBeforeSkillLoad({
        bundleName: 'bundle',
        skillName: 'review',
        frontmatter: { name: 'review' }
    });

    assert.deepEqual(decision, { operation: 'allow' });
});

test('SkillRegistry.loadSkillForAgent runs before and after hooks for an explicit load', async () => {
    const registry = SkillRegistry.getInstance();
    const bundleName = `skill-load-test-${crypto.randomUUID()}`;
    const provider = {
        async getSkills() {
            return [new Skill({ name: 'review', description: 'Review files' }, '# Review', '/skills/review')];
        }
    };
    const hooks = GlobalHooks.createChildHooks();
    const events: string[] = [];
    hooks.beforeSkillLoad((ctx) => {
        assert.deepEqual(Object.keys(ctx).sort(), [
            'bundleName',
            'frontmatter',
            'skillDirectory',
            'skillName',
            'source'
        ]);
        events.push(`before:${ctx.bundleName}/${ctx.skillName}`);
        return { operation: 'allow', message: 'allowed' };
    });
    hooks.afterSkillLoad((ctx) => {
        events.push(`after:${ctx.bundleName}/${ctx.skillName}`);
    });

    registry.registerSkillProvider(bundleName, provider);
    try {
        const loaded = await registry.loadSkillForAgent(bundleName, 'review', 'agent-1', hooks);
        assert.equal(loaded?.skill.frontmatter.name, 'review');
        assert.match(loaded?.content ?? '', /# Review$/);
        assert.deepEqual(events, [`before:${bundleName}/review`, `after:${bundleName}/review`]);
    } finally {
        registry.unregisterSkillProvider(bundleName, provider);
    }
});

test('SkillRegistry.loadSkillForAgent does not run after hooks when before denies', async () => {
    const registry = SkillRegistry.getInstance();
    const bundleName = `skill-load-deny-test-${crypto.randomUUID()}`;
    const provider = {
        async getSkills() {
            return [new Skill({ name: 'restricted', description: 'Restricted' }, '# Restricted')];
        }
    };
    const hooks = GlobalHooks.createChildHooks();
    let afterCalled = false;
    hooks.beforeSkillLoad(() => ({ operation: 'deny', message: 'policy denied' }));
    hooks.afterSkillLoad(() => {
        afterCalled = true;
    });

    registry.registerSkillProvider(bundleName, provider);
    try {
        await assert.rejects(
            registry.loadSkillForAgent(bundleName, 'restricted', undefined, hooks),
            (error: unknown) => error instanceof SkillLoadBlockedError && error.message === 'policy denied'
        );
        assert.equal(afterCalled, false);
    } finally {
        registry.unregisterSkillProvider(bundleName, provider);
    }
});
