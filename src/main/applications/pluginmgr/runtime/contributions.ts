/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { Skill, SkillRegistry, type SkillFrontmatter, type SkillProvider } from '../../../aikernel/skill.js';
import { getLocale } from '../../../../locale/index.js';
import { resolvePluginDisplayName } from '../../../../../packages/plugin-sdk/src/index.js';
import { getPluginHost } from './host.js';

export const PLUGIN_SKILL_BUNDLE = 'pluginMgr';

class PluginSkillProvider implements SkillProvider {
    async getSkills(): Promise<Skill[]> {
        return getPluginHost()
            .listSkills()
            .map(({ pluginId, definition }) => {
                const frontmatter: SkillFrontmatter = {
                    ...(definition.frontmatter ?? {}),
                    name: definition.name,
                    description: definition.description
                };
                if (definition.userInvocable !== undefined) {
                    frontmatter['user-invocable'] = definition.userInvocable;
                }
                if (definition.modelInvocable !== undefined) {
                    frontmatter['disable-model-invocation'] = !definition.modelInvocable;
                }
                const skill = new Skill(frontmatter, definition.body, definition.directory);
                skill.readOnly = true;
                skill.attribution = {
                    sourceId: pluginId,
                    sourceName:
                        resolvePluginDisplayName(getPluginHost().get(pluginId)?.displayName, getLocale()) ?? pluginId
                };
                return skill;
            });
    }
}

let initialized = false;

export function initializePluginContributions(): void {
    if (initialized) return;
    initialized = true;
    SkillRegistry.getInstance().registerSkillProvider(PLUGIN_SKILL_BUNDLE, new PluginSkillProvider());
}

export function disposePluginContributions(): void {
    if (!initialized) return;
    SkillRegistry.getInstance().unregisterSkillProvider(PLUGIN_SKILL_BUNDLE);
    initialized = false;
}
