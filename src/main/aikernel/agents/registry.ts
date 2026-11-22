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
import { MainAgentDecl } from './main/agent.js';
import { ExploreAgentDecl } from './explore/agent.js';
import { PlanAgentDecl } from './plan/agent.js';
import { logger } from '../../utils/logger.js';

export interface ApplicationAgents {
    bundleName: string;
    agents: readonly AgentDecl[];
}

/**
 * AgentRegistry -- 全局 Agent 注册表。
 *
 * 管理系统内所有 Agent。注册表始终以完整 agentId 为键。
 */
export class AgentRegistry {
    private static readonly MAIN_AGENT_ID = 'main';
    private static agents = new Map<string, AgentDecl>();

    /** 已加载的应用 Agent 实例，用于 reload 时 dispose */
    private static applicationAgentInstances: AgentDecl[] = [];

    /** 已加载的插件 Agent 实例，用于 reload 时 dispose */
    private static pluginAgentInstances: AgentDecl[] = [];

    /**
     * 由 applications 层注入的可见性过滤：应用被插件禁用（disableApplication）时，
     * 该作用域下注册的 Agent 一律不可见（不出现在系统提示、不能被派发或解析）。
     * hideApplication 不注入过滤——只收起入口，Agent 照常可用。
     */
    private static visibilityFilters: Array<(agent: AgentDecl) => boolean> = [];

    static registerVisibilityFilter(filter: (agent: AgentDecl) => boolean): void {
        this.visibilityFilters.push(filter);
    }

    private static isVisible(agent: AgentDecl): boolean {
        // 只过滤应用 Agent：插件 Agent 的生命周期由插件宿主管理，作用域名可能与某个应用
        // bundleName 同形，不能因为那个应用被禁用就误伤插件贡献的 Agent
        if (!this.applicationAgentInstances.includes(agent)) return true;
        return this.visibilityFilters.every((filter) => filter(agent));
    }

    /**
     * 注册一个 Agent。agentId 不可重复，重复注册将抛出异常。
     */
    static registerAgent(agent: AgentDecl): void {
        if (this.agents.has(agent.agentId)) {
            throw new Error(`AgentRegistry: agent "${agent.agentId}" is already registered`);
        }
        this.agents.set(agent.agentId, agent);
    }

    /**
     * 返回所有已注册的 Agent 列表（隐藏被插件禁用的应用所提供的 Agent）。
     */
    static getAgents(): AgentDecl[] {
        return Array.from(this.agents.values()).filter((agent) => this.isVisible(agent));
    }

    /**
     * 根据完整 agentId 查找 Agent，未找到（或所属应用被插件禁用）返回 undefined。
     */
    static getAgent(agentId: string): AgentDecl | undefined {
        const agent = this.agents.get(agentId);
        if (!agent || !this.isVisible(agent)) return undefined;
        return agent;
    }

    static getBuiltinAgent(agentName: string): AgentDecl | undefined {
        this.initBuiltinAgents();
        return this.getAgent(agentName);
    }

    /**
     * 返回系统主 Agent。OpenDesk 始终注册主 Agent，因此调用方无需处理 undefined。
     */
    static getMainAgent(): MainAgentDecl {
        this.initBuiltinAgents();
        return this.agents.get(this.MAIN_AGENT_ID) as MainAgentDecl;
    }

    static getApplicationAgent(bundleName: string, agentName: string): AgentDecl | undefined {
        return this.getAgent(`${bundleName}:${agentName}`);
    }

    /**
     * 解析外部边界传入的 Agent 引用。
     * 仅接受规范 agentId：内置 Agent 使用 agentName，应用 Agent 使用完整作用域 ID。
     */
    static resolveAgentReference(reference: string): AgentDecl | undefined {
        this.initBuiltinAgents();
        return this.getAgent(reference);
    }

    /**
     * 注册表里是否真的存在该 agentId，忽略插件禁用带来的可见性过滤。
     *
     * 供「已绑定该 Agent 的任务」与任务迁移这类内部场景使用：应用临时被插件禁用时
     * Agent 仍注册着，调用方据此保留绑定（而不是当成失效 Agent 永久改写/清空），
     * 插件停用后能回到原来的 Agent。对外派发与列表仍走 getAgent / getAgents 的过滤版本。
     */
    static hasRegisteredAgent(reference: string): boolean {
        return this.agents.has(reference);
    }

    static resolveDispatchableAgent(reference: string): AgentDecl | undefined {
        const agent = this.resolveAgentReference(reference);
        return agent?.dispatchable ? agent : undefined;
    }

    /**
     * 注册所有内置 Agent。在应用启动时调用一次。
     */
    static initBuiltinAgents(): void {
        if (!this.agents.has(this.MAIN_AGENT_ID)) {
            this.registerAgent(new MainAgentDecl());
        }
        if (!this.agents.has('explore')) {
            this.registerAgent(new ExploreAgentDecl());
        }
        if (!this.agents.has('plan')) {
            this.registerAgent(new PlanAgentDecl());
        }
    }

    /**
     * 替换由应用层提供的 Agent。
     *
     * 文件扫描和外部资源装配由应用层负责，AIKernel 只管理 AgentDecl。
     */
    static async replaceApplicationAgents(applications: readonly ApplicationAgents[]): Promise<void> {
        await this.unloadApplicationAgents();
        await this.replaceScopedAgents(applications, this.applicationAgentInstances);
    }

    static async replaceApplicationAgent(bundleName: string, agent: AgentDecl): Promise<void> {
        agent.bindApplicationScope(bundleName);
        const existing = this.agents.get(agent.agentId);
        if (existing && existing !== agent) {
            await existing.dispose();
            this.applicationAgentInstances = this.applicationAgentInstances.filter((item) => item !== existing);
            this.agents.delete(existing.agentId);
        }
        if (!this.agents.has(agent.agentId)) {
            this.registerAgent(agent);
            this.applicationAgentInstances.push(agent);
        }
    }

    static async removeApplicationAgent(bundleName: string, agentName: string): Promise<void> {
        // 卸载走注册表本体而不是 getApplicationAgent：可见性过滤不能挡住资源释放，
        // 否则应用被插件禁用后残留的 Agent 就再也清理不掉了
        const agent = this.agents.get(`${bundleName}:${agentName}`);
        if (!agent) return;
        await agent.dispose();
        this.agents.delete(agent.agentId);
        this.applicationAgentInstances = this.applicationAgentInstances.filter((item) => item !== agent);
    }

    /**
     * 替换由插件提供的 Agent。
     *
     * 与应用 Agent 共用同一注册表但维护独立的实例列表，
     * 因此插件 reload / 卸载不会影响应用 Agent，反之亦然。
     */
    static async replacePluginAgents(plugins: readonly ApplicationAgents[]): Promise<void> {
        await this.unloadPluginAgents();
        await this.replaceScopedAgents(plugins, this.pluginAgentInstances);
    }

    static async unloadPluginAgents(): Promise<void> {
        await this.unloadScopedAgents(this.pluginAgentInstances);
        this.pluginAgentInstances = [];
    }

    /**
     * 卸载所有已加载的应用 Agent，释放资源（MCP 连接、SkillProvider 注册等）。
     */
    static async unloadApplicationAgents(): Promise<void> {
        await this.unloadScopedAgents(this.applicationAgentInstances);
        this.applicationAgentInstances = [];
    }

    private static async replaceScopedAgents(
        sources: readonly ApplicationAgents[],
        instances: AgentDecl[]
    ): Promise<void> {
        let loaded = 0;
        for (const source of sources) {
            for (const agent of source.agents) {
                agent.bindApplicationScope(source.bundleName);
                if (this.agents.has(agent.agentId)) {
                    logger.warn(`AgentRegistry: agent "${agent.agentId}" already registered, skipping scoped agent`);
                    await agent.dispose();
                    continue;
                }
                this.registerAgent(agent);
                instances.push(agent);
                loaded++;
            }
        }

        if (loaded > 0) {
            logger.info(`AgentRegistry: registered ${loaded} scoped agent(s)`);
        }
    }

    private static async unloadScopedAgents(instances: AgentDecl[]): Promise<void> {
        for (const agent of instances) {
            try {
                await agent.dispose();
            } catch (err) {
                logger.warn(`AgentRegistry: error disposing scoped agent "${agent.agentId}": ${err}`);
            }
            this.agents.delete(agent.agentId);
        }
    }

    /**
     * 生成可被派发的 Agent 的 frontmatter XML，供 system prompt 使用。
     */
    static getAgentFrontmatterXml(): string {
        const agents = this.getAgents().filter((agent) => agent.dispatchable);
        if (agents.length === 0) return '';

        const items = agents.map(
            (a) => `<agent name="${a.agentId}" type="${a.agentType}">
  <when_to_use>${a.whenToUse}</when_to_use>
</agent>`
        );
        return '\n' + items.join('\n') + '\n';
    }
}
