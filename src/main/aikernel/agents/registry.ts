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

import type { AgentDecl } from './common.js';
import { ExploreAgentDecl } from './explore/agent.js';
import { PlanAgentDecl } from './plan/agent.js';
import { logger } from '../../utils/logger.js';

/**
 * AgentRegistry -- 全局 Agent 注册表。
 *
 * 管理除 main agent 以外的所有可用 Agent（如 explore、plan 等）。
 * main agent 不在此注册，因为它是顶层调度者而非被调度者。
 */
export class AgentRegistry {
    private static agents = new Map<string, AgentDecl>();

    /** 已加载的 custom agent 实例，用于 reload 时 dispose */
    private static customAgentInstances: AgentDecl[] = [];

    /**
     * 注册一个 Agent。agentName 不可重复，重复注册将抛出异常。
     */
    static registerAgent(agent: AgentDecl): void {
        if (this.agents.has(agent.agentName)) {
            throw new Error(`AgentRegistry: agent "${agent.agentName}" is already registered`);
        }
        this.agents.set(agent.agentName, agent);
    }

    /**
     * 返回所有已注册的 Agent 列表。
     */
    static getAgents(): AgentDecl[] {
        return Array.from(this.agents.values());
    }

    /**
     * 根据名称查找 Agent，未找到返回 undefined。
     */
    static getAgent(name: string): AgentDecl | undefined {
        return this.agents.get(name);
    }

    /**
     * 注册所有内置 Agent。在应用启动时调用一次。
     */
    static initBuiltinAgents(): void {
        if (!this.agents.has('explore')) {
            this.registerAgent(new ExploreAgentDecl());
        }
        if (!this.agents.has('plan')) {
            this.registerAgent(new PlanAgentDecl());
        }
    }

    /**
     * 替换由应用层提供的自定义 Agent。
     *
     * 文件扫描和外部资源装配由应用层负责，AIKernel 只管理 AgentDecl。
     */
    static async replaceCustomAgents(agents: AgentDecl[]): Promise<void> {
        await this.unloadCustomAgents();

        let loaded = 0;
        for (const agent of agents) {
            if (this.agents.has(agent.agentName)) {
                logger.warn(`AgentRegistry: agent "${agent.agentName}" already registered, skipping custom agent`);
                await agent.dispose();
                continue;
            }
            this.registerAgent(agent);
            this.customAgentInstances.push(agent);
            loaded++;
        }

        if (loaded > 0) {
            logger.info(`AgentRegistry: registered ${loaded} custom agent(s) from applications`);
        }
    }

    /**
     * 卸载所有已加载的 custom agent，释放资源（MCP 连接、SkillProvider 注册等）。
     */
    static async unloadCustomAgents(): Promise<void> {
        for (const agent of this.customAgentInstances) {
            try {
                await agent.dispose();
            } catch (err) {
                logger.warn(`AgentRegistry: error disposing custom agent "${agent.agentName}": ${err}`);
            }
            this.agents.delete(agent.agentName);
        }
        this.customAgentInstances = [];
    }

    /**
     * 生成可被派发的 Agent 的 frontmatter XML，供 system prompt 使用。
     * 只包含单 mode 的 agent，多 mode agent 不可被派发（避免 mode 歧义）。
     */
    static getAgentFrontmatterXml(): string {
        const agents = this.getAgents().filter((a) => a.supportedModes().length === 1);
        if (agents.length === 0) return '';

        const items = agents.map(
            (a) => `<agent name="${a.agentName}" type="${a.agentType}">
  <when_to_use>${a.whenToUse}</when_to_use>
</agent>`
        );
        return '\n' + items.join('\n') + '\n';
    }
}
