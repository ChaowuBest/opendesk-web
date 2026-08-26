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

import { AgentDecl, type AgentType, type ModeDecl, type TaskContext } from '../../../aikernel/agents/common.js';
import type { AgentDefinition } from '../../../aikernel/types/agent.js';
import { createDefaultPermissionRules } from '../../../aikernel/security/enforcer.js';
import { getAgentsMdSection } from '../../../aikernel/agents_md.js';
import { getLocalISODate } from '../../../utils/date.js';
import { formatEnvironmentSection, getTaskExecutionHost } from '../../../aikernel/agents/environment.js';
import { listExecutionNodes } from '../../../aikernel/security/harness.js';
import { SkillRegistry } from '../../../aikernel/skill.js';
import { getSkillsSection } from '../../../aikernel/agents/main/agent.js';

const PLUGIN_AGENT_DEFAULT_MODE: ModeDecl = {
    id: 'default',
    name: 'default',
    description: '插件 agent 默认模式，继承父任务权限级别',
    icon: '🧩',
    color: '#0088FF',
    permissionFactory: (workspace) => createDefaultPermissionRules(workspace)
};

/**
 * 插件贡献的子 Agent 运行时实例。
 *
 * 数据来源为插件目录中的 agents.md（经 manifest 装配成 AgentDefinition），
 * 完整 agentId 由 AgentRegistry 在注册时通过 bindApplicationScope 绑定插件 id 形成。
 */
export class PluginAgent extends AgentDecl {
    readonly agentType: AgentType = 'custom';
    readonly agentName: string;
    readonly whenToUse: string;
    readonly dispatchable: boolean;

    private readonly body: string;
    private readonly location?: string;

    constructor(definition: AgentDefinition, location?: string) {
        super();
        this.agentName = definition.name;
        this.whenToUse = definition.whenToUse;
        this.body = definition.body;
        this.location = location;
        this.dispatchable = definition.dispatchable ?? true;
    }

    supportedModes(): ModeDecl[] {
        return [PLUGIN_AGENT_DEFAULT_MODE];
    }

    protected defaultModeId(): string {
        return PLUGIN_AGENT_DEFAULT_MODE.id;
    }

    async createSystemPrompt(_activeMode: ModeDecl | undefined, taskCtx: TaskContext): Promise<string> {
        const workspace = taskCtx.getWorkspace();
        const currentDate = getLocalISODate();
        const year = currentDate.split('-')[0];

        const envSection = formatEnvironmentSection(workspace, getTaskExecutionHost(taskCtx), {
            includeHomeTemp: true,
            includeExecutionRule: true,
            availableNodes: listExecutionNodes()
        });

        const skillFrontmatters = await SkillRegistry.getInstance().getSkillFrontmatterXml(
            taskCtx.skillExposure,
            taskCtx.agentId
        );

        const parts = [
            this.body,
            // 声明 agent 实际安装目录：随 agent 分发的脚本等文件可确定性定位
            ...(this.location
                ? ['', `本 agent 的路径：\`${this.location}\`。引用随本 agent 分发的文件时，以该目录为基准。`]
                : []),
            '',
            `当前日期：${currentDate}`,
            `重要提示：现在是 ${year} 年。当用户询问"最近"、"今年"、"最新"等时间相关问题时，请搜索 ${year} 年的相关内容。`,
            '',
            envSection,
            '',
            getSkillsSection(skillFrontmatters)
        ];
        if (this.dispatchable) {
            parts.push(
                '',
                '注意：你是一个子任务执行者。完成后通过 planning-attemptCompletion 工具提交结果。',
                '无论任务成功、失败还是因缺少信息无法继续，都必须调用 planning-attemptCompletion 结束任务。'
            );
        }
        const base = parts.join('\n');
        const workspaceAgentsMd = getAgentsMdSection(workspace);
        return workspaceAgentsMd ? `${base}\n\n${workspaceAgentsMd}` : base;
    }
}
