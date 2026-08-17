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

import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { AgentDecl, type AgentType, type ModeDecl, type TaskContext } from '../../aikernel/agents/common.js';
import { createDefaultPermissionRules } from '../../aikernel/security/enforcer.js';
import { getAgentsMdSection } from '../../aikernel/agents_md.js';
import { getLocalISODate } from '../../utils/date.js';
import { formatEnvironmentSection, getTaskExecutionHost } from '../../aikernel/agents/environment.js';
import { listExecutionNodes } from '../../aikernel/security/harness.js';
import { logger } from '../../utils/logger.js';
import { Skill, SkillRegistry, type SkillProvider } from '../../aikernel/skill.js';
import { getSkillsSection } from '../../aikernel/agents/main/agent.js';

// ─── 配置 Schema ──────────────────────────────────────────────

export const CustomAgentMetaSchema = z.object({
    name: z.string().trim().min(1),
    when_to_use: z.string().trim().min(1)
});

export type CustomAgentMeta = z.output<typeof CustomAgentMetaSchema>;

export interface CustomAgentLoadOptions {
    purpose?: 'subtask' | 'staff';
    agentName?: string;
    whenToUse?: string;
    skillBundleName?: string;
    additionalSystemPrompt?: (taskCtx: TaskContext) => string | null;
}

// ─── Mode ─────────────────────────────────────────────────────

const CUSTOM_AGENT_DEFAULT_MODE: ModeDecl = {
    id: 'default',
    name: 'default',
    description: '自定义 agent 默认模式，继承父任务权限级别',
    icon: '🤖',
    color: '#7E57C2',
    permissionFactory: (workspace) => createDefaultPermissionRules(workspace)
};

// ─── CustomAgentSkillProvider ─────────────────────────────────

class CustomAgentSkillProvider implements SkillProvider {
    private skills: Skill[] = [];

    setSkills(skills: Skill[]): void {
        this.skills = skills;
    }

    async getSkills(): Promise<Skill[]> {
        return this.skills;
    }
}

// ─── CustomAgent ──────────────────────────────────────────────

export class CustomAgent extends AgentDecl {
    readonly agentType: AgentType = 'custom';
    readonly agentName: string;
    readonly whenToUse: string;
    readonly dispatchable: boolean;
    readonly mcpConfig: unknown;

    private readonly agentsMd: string;
    private readonly skillProvider: CustomAgentSkillProvider;
    private readonly skillBundleName: string;
    private readonly purpose: 'subtask' | 'staff';
    private readonly additionalSystemPrompt?: (taskCtx: TaskContext) => string | null;

    private skillsRegistered = false;

    private constructor(
        meta: CustomAgentMeta,
        configDir: string,
        agentsMd: string,
        mcpConfig: unknown,
        skills: Skill[],
        options: CustomAgentLoadOptions
    ) {
        super('agentoffice');
        this.agentName = options.agentName ?? meta.name;
        this.whenToUse = options.whenToUse ?? meta.when_to_use;
        this.agentsMd = agentsMd;
        this.mcpConfig = mcpConfig;
        this.purpose = options.purpose ?? 'subtask';
        this.dispatchable = this.purpose === 'subtask';
        this.additionalSystemPrompt = options.additionalSystemPrompt;
        this.skillBundleName = options.skillBundleName ?? `custom:${configDir}`;
        this.skillProvider = new CustomAgentSkillProvider();
        for (const skill of skills) {
            skill.agentIds = [this.agentId];
        }
        this.skillProvider.setSkills(skills);

        // 注册 SkillProvider，使 agent 专属技能出现在 system prompt 的技能列表中
        if (skills.length > 0) {
            SkillRegistry.getInstance().registerSkillProvider(this.skillBundleName, this.skillProvider);
            this.skillsRegistered = true;
            logger.info(
                `CustomAgent "${meta.name}": registered ${skills.length} skills as provider "${this.skillBundleName}"`
            );
        }
    }

    /**
     * 从指定目录加载 CustomAgent。
     *
     * 目录格式（对齐 AgentOffice staff 的 agent/ 子目录）：
     * - agents.md   - system prompt 指令体（必需）
     * - agent.json  - 元数据：name, when_to_use（可选，缺失时从目录名和 agents.md 推断）
     * - mcp.json    - MCP 服务器配置（可选）
     * - skills/     - 私有技能目录（可选）
     */
    static async loadFromPath(dir: string, options: CustomAgentLoadOptions = {}): Promise<CustomAgent> {
        const resolvedDir = path.resolve(dir);

        // 读取 agents.md（必需）
        const agentsMdPath = path.join(resolvedDir, 'agents.md');
        if (!fs.existsSync(agentsMdPath)) {
            throw new Error(`CustomAgent: agents.md not found in ${resolvedDir}`);
        }
        const agentsMd = fs.readFileSync(agentsMdPath, 'utf-8').trim();
        if (agentsMd.length === 0) {
            throw new Error(`CustomAgent: agents.md is empty in ${resolvedDir}`);
        }

        // 读取 agent.json（可选，缺失时从目录名和 agents.md 推断）
        let meta: CustomAgentMeta;
        const agentJsonPath = path.join(resolvedDir, 'agent.json');
        if (fs.existsSync(agentJsonPath)) {
            try {
                const raw = JSON.parse(fs.readFileSync(agentJsonPath, 'utf-8'));
                meta = CustomAgentMetaSchema.parse(raw);
            } catch (err) {
                throw new Error(`CustomAgent: failed to parse agent.json: ${err}`);
            }
        } else {
            // 从目录名推断 agent name，从 agents.md 第一行推断 when_to_use
            const dirName = path.basename(resolvedDir);
            const firstLine =
                agentsMd
                    .split('\n')[0]
                    .replace(/^#+\s*/, '')
                    .trim() || dirName;
            meta = {
                name: dirName,
                when_to_use: firstLine
            };
            logger.info(
                `CustomAgent: agent.json not found, derived name="${meta.name}" when_to_use="${meta.when_to_use}"`
            );
        }

        // 读取 mcp.json（可选）
        let mcpConfig: unknown = { servers: [] };
        const mcpJsonPath = path.join(resolvedDir, 'mcp.json');
        if (fs.existsSync(mcpJsonPath)) {
            try {
                mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
            } catch (err) {
                logger.warn(`CustomAgent: failed to parse mcp.json, skipping MCP: ${err}`);
            }
        }

        // 扫描 skills/ 目录（可选）
        const skills = CustomAgent.loadSkills(path.join(resolvedDir, 'skills'));

        logger.info(`CustomAgent loaded: name="${meta.name}" from ${resolvedDir} (skills=${skills.length})`);
        return new CustomAgent(meta, resolvedDir, agentsMd, mcpConfig, skills, options);
    }

    private static loadSkills(skillsDir: string): Skill[] {
        if (!fs.existsSync(skillsDir)) return [];

        const skills: Skill[] = [];
        const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const skillDir = path.join(skillsDir, entry.name);
            const skillMdPath = path.join(skillDir, 'SKILL.md');
            if (!fs.existsSync(skillMdPath)) continue;

            try {
                const raw = fs.readFileSync(skillMdPath, 'utf-8');
                const skill = Skill.parseMd(raw);
                skill.directory = skillDir;
                skills.push(skill);
                logger.info(`CustomAgent: loaded skill "${skill.frontmatter.name}" from ${skillDir}`);
            } catch (err) {
                logger.warn(`CustomAgent: failed to parse SKILL.md in ${skillDir}: ${err}`);
            }
        }
        return skills;
    }

    supportedModes(): ModeDecl[] {
        return [CUSTOM_AGENT_DEFAULT_MODE];
    }

    protected defaultModeId(): string {
        return 'default';
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
            this.agentsMd,
            '',
            `当前日期：${currentDate}`,
            `重要提示：现在是 ${year} 年。当用户询问"最近"、"今年"、"最新"等时间相关问题时，请搜索 ${year} 年的相关内容。`,
            '',
            envSection,
            '',
            getSkillsSection(skillFrontmatters)
        ];
        if (this.purpose === 'subtask') {
            parts.push(
                '',
                '注意：你是一个子任务执行者。完成后通过 planning-attemptCompletion 工具提交结果。',
                '无论任务成功、失败还是因缺少信息无法继续，都必须调用 planning-attemptCompletion 结束任务。'
            );
        }
        const base = parts.join('\n');
        const agentsMd = getAgentsMdSection(workspace);
        const promptWithWorkspaceInstructions = agentsMd ? `${base}\n\n${agentsMd}` : base;
        const additionalSystemPrompt = this.additionalSystemPrompt?.(taskCtx);
        return additionalSystemPrompt
            ? `${promptWithWorkspaceInstructions}\n\n${additionalSystemPrompt}`
            : promptWithWorkspaceInstructions;
    }

    async dispose(): Promise<void> {
        // 注销 SkillProvider
        if (this.skillsRegistered) {
            SkillRegistry.getInstance().unregisterSkillProvider(this.skillBundleName, this.skillProvider);
            this.skillsRegistered = false;
        }
    }
}
