import fs from 'fs';
import os from 'os';
import path from 'path';
import { SkillRegistry } from '../../../main/aikernel/skill.js';
import { SkillMgrApplication } from '../../../main/applications/skillmgr/app.js';
import {
    disposePluginContributions,
    initializePluginContributions,
    PLUGIN_SKILL_BUNDLE
} from '../../../main/applications/pluginmgr/runtime/contributions.js';
import { getPluginHost } from '../../../main/applications/pluginmgr/runtime/host.js';
import { definePlugin } from '../../../../packages/plugin/src/index.js';

describe('plugin contributions', () => {
    afterEach(async () => {
        await getPluginHost().dispose();
        disposePluginContributions();
    });

    test('把插件 Skill 全局投影到内核注册表', async () => {
        initializePluginContributions();
        await getPluginHost().activate(
            definePlugin({
                id: 'global-contributions',
                displayName: 'Global Contributions',
                setup(ctx) {
                    ctx.skills.register({
                        name: 'review-code',
                        description: 'Review current code',
                        body: 'Inspect correctness and regressions.'
                    });
                }
            }),
            { origin: 'test:contributions' }
        );

        const skill = await SkillRegistry.getInstance().getSkill(PLUGIN_SKILL_BUNDLE, 'review-code');
        expect(PLUGIN_SKILL_BUNDLE).toBe('pluginMgr');
        expect(skill?.getFullContent()).toBe('Inspect correctness and regressions.');
        expect(skill?.readOnly).toBe(true);
        expect(skill?.attribution).toEqual({
            sourceId: 'global-contributions',
            sourceName: 'Global Contributions'
        });
        const skillCenterEntries = await SkillMgrApplication.prototype.getBuiltinSkills.call({});
        expect(skillCenterEntries.find((entry) => entry.id === `${PLUGIN_SKILL_BUNDLE}/review-code`)).toMatchObject({
            bundleName: 'pluginMgr',
            pluginId: 'global-contributions',
            pluginName: 'Global Contributions',
            readOnly: true
        });
    });

    test('保留插件 Skill 的资源目录和完整 frontmatter', async () => {
        const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-plugin-skill-'));
        const skillDirectory = path.join(pluginDir, 'skills', 'review-code');
        fs.mkdirSync(skillDirectory, { recursive: true });
        try {
            initializePluginContributions();
            await getPluginHost().activate(
                definePlugin({
                    id: 'resource-skill',
                    capabilities: ['skill'],
                    setup(ctx) {
                        ctx.skills.register({
                            name: 'review-code',
                            description: 'Review current code',
                            body: 'Read references/checklist.md.',
                            directory: './skills/review-code',
                            frontmatter: {
                                metadata: { source: 'plugin' },
                                'allowed-tools': ['readFile']
                            },
                            userInvocable: false
                        });
                    }
                }),
                { origin: 'test:resource-skill', pluginDir }
            );

            const skill = await SkillRegistry.getInstance().getSkill(PLUGIN_SKILL_BUNDLE, 'review-code');
            expect(skill?.directory).toBe(fs.realpathSync(skillDirectory));
            expect(skill?.frontmatter.metadata).toEqual({ source: 'plugin' });
            expect(skill?.attribution).toEqual({
                sourceId: 'resource-skill',
                sourceName: 'resource-skill'
            });
            expect(skill?.frontmatter['allowed-tools']).toEqual(['readFile']);
            expect(skill?.isUserInvocable).toBe(false);
            expect(skill?.getFullContent()).toContain(fs.realpathSync(skillDirectory));
        } finally {
            fs.rmSync(pluginDir, { recursive: true, force: true });
        }
    });
});
