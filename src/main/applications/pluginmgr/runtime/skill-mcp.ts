/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { createHash } from 'crypto';
import { BaseToolset } from '../../../aikernel/tool.js';
import { getLocale } from '../../../../locale/index.js';
import { logger } from '../../../utils/logger.js';
import { ApplicationRegistry, onGlobalWorkerRestarted } from '../../registry.js';
import type { McpServerConfig, McpServerState } from '../../mcpmgr/common.js';
import { MCPTool, mcpSafeName } from '../../mcpmgr/mcp-tool.js';
import type { McpMgrApplication } from '../../mcpmgr/app.js';
import type { PluginMcpServerDefinition } from '../../../../../packages/plugin-sdk/src/index.js';
import { resolvePluginDisplayName } from '../../../../../packages/plugin-sdk/src/index.js';
import { getPluginHost } from './host.js';
import type { PluginSourceKind } from '../management/registry.js';
import { sanitizeModelToolName } from './tool-names.js';

function getMcpMgrApplication(): McpMgrApplication | undefined {
    return ApplicationRegistry.getApplication('mcpmgr') as McpMgrApplication | undefined;
}

let resyncListenerRegistered = false;

/**
 * 注册全局 worker 崩溃重启后的内部 MCP server 重同步（bootstrap 初始化时调用，幂等）。
 *
 * 重启出的新 worker 只会从用户配置恢复，运行时注入的内部 server 清单会丢失；
 * 这里重新做一次全量登记（懒加载语义，不触发建连），由技能加载/详情展示按需连接。
 */
export function registerPluginSkillServerResync(): void {
    if (resyncListenerRegistered) return;
    resyncListenerRegistered = true;
    onGlobalWorkerRestarted(() => syncPluginSkillServers());
}

/**
 * 插件技能内部 MCP server 的稳定 id。
 *
 * 与 agent 专属 server（`agent_<sha256>`）同一套构造方式：跨重启稳定、按
 * 插件/技能/server 三元组唯一，且不与用户配置 id（`mcp_*`）空间重叠。
 */
export function pluginSkillServerId(pluginId: string, skillName: string, serverName: string): string {
    return `pluginskill_${createHash('sha256')
        .update(`${pluginId}\0${skillName}\0${serverName}`)
        .digest('hex')
        .slice(0, 24)}`;
}

/**
 * 技能内部 MCP 工具集的名称前缀（buildSkillMcpToolsets 构造）。
 *
 * 加载技能时 resolver 会把这类工具集写回 Skill.toolsets（模型披露用），而技能中心
 * 的工具展示另有 worker 侧原始工具名索引（getPluginSkillServers）——两路来源指向
 * 同一批工具，展示侧据此前缀跳过工具集来源，避免同一工具出现两行。
 */
export const PLUGIN_SKILL_MCP_TOOLSET_PREFIX = 'plugin-mcp-';

export interface PluginSkillMcpDescriptor {
    pluginId: string;
    skillName: string;
    mcps: PluginMcpServerDefinition[];
    /** 插件来源类型（builtin/local），供 MCP 设置页分类展示 */
    pluginSource?: PluginSourceKind;
    /** 插件显示名，写入 server 的 source 字段（UI 来源 pill） */
    sourceName?: string;
}

/**
 * 把插件技能声明的内部 MCP server 转成 MCPMgr 的运行时注入配置。
 *
 * 语义与 agent 专属 server 一致：只存在于运行时，不写入 MCPMgr 的用户配置；
 * 生命周期跟随插件启停（bootstrap 全量同步时移除）。
 */
export function buildPluginSkillServerConfigs(descriptor: PluginSkillMcpDescriptor): McpServerConfig[] {
    const { pluginId, skillName, mcps, pluginSource, sourceName } = descriptor;
    return mcps.map((mcp) => {
        const config: McpServerConfig = {
            id: pluginSkillServerId(pluginId, skillName, mcp.name),
            name: mcp.name,
            transport: mcp.transport,
            enabled: true,
            source: sourceName,
            pluginId,
            pluginSkillName: skillName,
            pluginSource
        };
        // 拷贝结构化字段，保证 worker 侧 JSON diff 看到稳定的对象形状
        if (mcp.transport === 'stdio') {
            config.command = mcp.command;
            if (mcp.args !== undefined) config.args = [...mcp.args];
            if (mcp.cwd !== undefined) config.cwd = mcp.cwd;
            if (mcp.env !== undefined) config.env = { ...mcp.env };
        } else {
            config.url = mcp.url;
            if (mcp.headers !== undefined) config.headers = { ...mcp.headers };
        }
        return config;
    });
}

/**
 * 把当前所有插件技能的内部 MCP server 全量同步给 MCPMgr（replace 语义）。
 *
 * 同步只登记配置、不触发建连：内部 server 的连接是懒加载的，由技能加载
 * （buildSkillMcpToolsets → ensurePluginSkillServers）或技能详情展示
 * （revealPluginSkillServers）按需拉起。
 *
 * 调用时机：插件 bootstrap 初始化完成、插件差量启停/安装/卸载收尾、全局 worker
 * 崩溃重启（registerPluginSkillServerResync 注册的回调），以及 main/cli/serve 完成
 * 全局 worker 初始化之后。全局 worker 未就绪时静默跳过（GUI 启动时插件 bootstrap
 * 早于 initializeRegistryWorker），由 worker 就绪后的补齐同步接管；mcpmgr 应用
 * 不可用时静默跳过，技能加载时的 ensurePluginSkillServers 兜底补齐。
 */
export async function syncPluginSkillServers(): Promise<void> {
    // 全局 worker 未就绪时同步注定失败（GUI 启动时插件 bootstrap 早于 initializeRegistryWorker）：
    // 静默跳过，由 main/cli/serve 在 worker 就绪后的补齐同步接管，避免每次启动都刷一条 warn
    if (!ApplicationRegistry.hasGlobalWorker()) {
        return;
    }
    const app = getMcpMgrApplication();
    if (!app) {
        logger.warn('[pluginmgr] mcpmgr application unavailable, skip syncing skill MCP servers');
        return;
    }
    const host = getPluginHost();
    const servers: McpServerConfig[] = [];
    for (const { pluginId, definition } of host.listSkills()) {
        const mcps = definition.mcps ?? [];
        if (mcps.length === 0) continue;
        const entry = host.get(pluginId);
        servers.push(
            ...buildPluginSkillServerConfigs({
                pluginId,
                skillName: definition.name,
                mcps,
                pluginSource: entry?.source,
                sourceName: resolvePluginDisplayName(entry?.displayName, getLocale()) ?? pluginId
            })
        );
    }
    try {
        await app.replacePluginSkillServers(servers);
    } catch (error) {
        logger.warn('[pluginmgr] Failed to sync skill MCP servers to mcpmgr', error);
    }
}

/**
 * 组装某个技能内部 MCP server 的工具集（Skill.toolsetResolver 的动态部分）。
 *
 * 技能首次加载时经 ensurePluginSkillServers 按需建连（懒加载触发点之一）；
 * 工具集不进入全局任务工具视角，只随 skill 正文披露，由 CallSkillTool 按工具的
 * 模型可见名调用；执行统一走 MCPMgr worker。
 *
 * 模型可见名的命名规则：
 * - 仅声明一个内部 MCP server、且各工具的展平名（工具本名净化后）不与技能静态工具
 *   名冲突时，直接用工具本名（如 `read_file`），不带 `<server>__` 前缀；
 *   工具描述仍保留 `[MCP: <server>]` 前缀说明来源。
 * - 其余情况（多个 server / 名字冲突）回退为 `<server>__<tool>` 的完整形态以消歧
 *   （前缀是 server 名，插件名在 CallSkillTool 的 skillName 维度体现，不进工具名）。
 */
export interface SkillMcpToolsetContext {
    pluginSource?: PluginSourceKind;
    sourceName?: string;
    /** 技能内已被静态工具占用的模型可见名（工具本名净化后），单 server 展平命名时避让 */
    takenToolNames?: ReadonlySet<string>;
}

export async function buildSkillMcpToolsets(
    pluginId: string,
    skillName: string,
    mcps: PluginMcpServerDefinition[],
    context?: SkillMcpToolsetContext
): Promise<BaseToolset[]> {
    if (mcps.length === 0) return [];
    const app = getMcpMgrApplication();
    if (!app) return [];
    const configs = buildPluginSkillServerConfigs({
        pluginId,
        skillName,
        mcps,
        pluginSource: context?.pluginSource,
        sourceName: context?.sourceName
    });
    // 幂等补齐注入：worker 重启或首次同步被跳过时在此自愈；内容未变时不触发重连
    try {
        await app.ensurePluginSkillServers(configs);
    } catch (error) {
        logger.warn(`[pluginmgr] Failed to ensure skill MCP servers for ${pluginId}/${skillName}`, error);
        return [];
    }
    let states: McpServerState[] = [];
    try {
        states = await app.getPluginSkillServers();
    } catch (error) {
        logger.warn(`[pluginmgr] Failed to query skill MCP servers for ${pluginId}/${skillName}`, error);
        return [];
    }
    const ids = new Set(configs.map((config) => config.id));
    const relevantStates = states.filter((state) => ids.has(state.id) && !!state.tools && state.tools.length > 0);
    // 展平判定：多个 server 时前缀承担消歧职责，必须保留；单 server 时只要展平名
    // 不撞静态工具名即可展平（展平名之间由 MCP server 自身的工具名唯一性保证，
    // 净化后撞名的退化行为与带前缀形态一致，不做额外回退）。
    // 静态工具名经同一净化函数归一后再比对：`read-file` 与 `read_file`
    // 这类仅差连字符/下划线的近形名对模型同样易混，按冲突处理回退前缀
    const normalizedTakenNames = context?.takenToolNames
        ? new Set([...context.takenToolNames].map((name) => mcpSafeName(name)))
        : undefined;
    const canFlatten =
        mcps.length === 1 &&
        relevantStates.every((state) =>
            state.tools.every((tool) => !normalizedTakenNames?.has(mcpSafeName(tool.name)))
        );
    const toolsets: BaseToolset[] = [];
    for (const state of relevantStates) {
        const toolset = new BaseToolset(
            `${PLUGIN_SKILL_MCP_TOOLSET_PREFIX}${sanitizeModelToolName(pluginId)}-${sanitizeModelToolName(state.name)}`
        );
        for (const discovered of state.tools) {
            const mcpTool = new MCPTool(
                state.name,
                discovered.name,
                discovered.description,
                discovered.inputSchema ?? {},
                undefined,
                mcpSafeName(state.name),
                mcpSafeName(discovered.name)
            );
            if (canFlatten) {
                // 构造时先按带前缀形态命名，这里再覆写为展平名：CallSkillTool 按
                // toolset 内的最终名解析，描述中的 `[MCP: <server>]` 来源信息不受影响
                mcpTool.name = mcpSafeName(discovered.name);
            }
            const serverId = state.id;
            const toolName = discovered.name;
            mcpTool.setExecutor(async (args) => {
                return await app.callPluginSkillMcpTool(serverId, toolName, args);
            });
            toolset.addTool(mcpTool);
        }
        if (toolset.tools.size > 0) toolsets.push(toolset);
    }
    return toolsets;
}
