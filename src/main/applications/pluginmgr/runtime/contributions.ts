/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { Skill, SkillRegistry, type SkillFrontmatter, type SkillProvider } from '../../../aikernel/skill.js';
import { BaseToolset } from '../../../aikernel/tool.js';
import type { PluginSkillDefinition } from '../../../../../packages/plugin-sdk/src/index.js';
import { resolvePluginDisplayName } from '../../../../../packages/plugin-sdk/src/index.js';
import { getLocale } from '../../../../locale/index.js';
import { getPluginHost } from './host.js';
import { createSkillScopedPluginTool } from './tool-provider.js';
import { buildSkillMcpToolsets } from './skill-mcp.js';
import { sanitizeModelToolName } from './tool-names.js';

export const PLUGIN_SKILL_BUNDLE = 'pluginMgr';

/**
 * 把 skill 自带的 tools 字段组装成静态内部工具集。
 *
 * 这些工具不经全局 tools.register，不占任务顶层工具位；skill 被加载后
 * 随正文渐进式披露，由 CallSkillTool 以工具本名调用（bundleName + skillName
 * 已承担命名空间，工具名无需再叠加插件前缀）。
 */
function buildSkillStaticToolsets(pluginId: string, definition: PluginSkillDefinition): BaseToolset[] | undefined {
    const tools = definition.tools ?? [];
    if (tools.length === 0) return undefined;
    const toolset = new BaseToolset(
        `plugin-skill-${sanitizeModelToolName(pluginId)}-${sanitizeModelToolName(definition.name)}`
    );
    for (const tool of tools) {
        toolset.addTool(createSkillScopedPluginTool(pluginId, tool));
    }
    return [toolset];
}

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
                const host = getPluginHost();
                const entry = host.get(pluginId);
                const staticToolsets = buildSkillStaticToolsets(pluginId, definition);
                const skill = new Skill(frontmatter, definition.body, definition.directory, staticToolsets);
                const mcps = definition.mcps ?? [];
                if (mcps.length > 0) {
                    // 内部 MCP 工具集惰性解析：连接也是懒加载的——worker 侧全量同步只登记配置，
                    // 真正建连发生在技能加载（ensurePluginSkillServers）或技能详情展示
                    // （revealPluginSkillServers）时；列表态不触发连接，保持渐进式披露语义。
                    // takenToolNames 供单 server 展平命名时避让静态工具名
                    const pluginSource = entry?.source;
                    const sourceName = resolvePluginDisplayName(entry?.displayName, getLocale()) ?? pluginId;
                    skill.toolsetResolver = async () => {
                        const takenToolNames = new Set<string>();
                        for (const toolset of staticToolsets ?? []) {
                            for (const [, tool] of toolset.tools) {
                                takenToolNames.add(tool.name);
                            }
                        }
                        const mcpToolsets = await buildSkillMcpToolsets(pluginId, definition.name, mcps, {
                            pluginSource,
                            sourceName,
                            takenToolNames
                        });
                        return [...(staticToolsets ?? []), ...mcpToolsets];
                    };
                }
                skill.readOnly = true;
                skill.attribution = {
                    sourceId: pluginId,
                    sourceName: resolvePluginDisplayName(entry?.displayName, getLocale()) ?? pluginId,
                    sourceKind: entry?.source
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
