import assert from 'node:assert/strict';
import test from 'node:test';
import { GlobalHooks } from '../../../main/aikernel/hooks.js';
import { Skill, SkillLoadBlockedError, SkillRegistry } from '../../../main/aikernel/skill.js';

test('Hooks.checkBeforeSkillLoad preserves allow messages and metadata', async () => {
    const hooks = GlobalHooks.createChildHooks();
    hooks.registerBeforeSkillLoad(() => ({
        operation: 'allow',
        message: 'allowed by policy',
        metadata: { policy: 'test' }
    }));

    const decision = await hooks.checkBeforeSkillLoad({
        bundleName: 'bundle',
        skillName: 'review',
        frontmatter: { name: 'review' }
    });

    assert.deepEqual(decision, {
        operation: 'allow',
        message: 'allowed by policy',
        metadata: { policy: 'test' }
    });
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
    hooks.registerBeforeSkillLoad((context) => {
        assert.deepEqual(Object.keys(context).sort(), [
            'bundleName',
            'frontmatter',
            'skillDirectory',
            'skillName',
            'source'
        ]);
        events.push(`before:${context.bundleName}/${context.skillName}`);
        return { operation: 'allow', message: 'allowed' };
    });
    hooks.registerAfterSkillLoad((context) => {
        events.push(`after:${context.bundleName}/${context.skillName}`);
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
    hooks.registerBeforeSkillLoad(() => ({ operation: 'deny', message: 'policy denied' }));
    hooks.registerAfterSkillLoad(() => {
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
