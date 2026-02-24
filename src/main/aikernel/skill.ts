/**
 * Copyright (c) 2026 The OpenDesk Team
 *
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

/**
 * Agent Skills 格式：对齐 Anthropic 发布的行业标准（agentskills.io）
 *
 * 规范要点：
 * - 每个技能为一个目录；拷贝到用户目录时以 SKILL.md 中的 name 作为目录名
 * - 必含文件：SKILL.md（YAML frontmatter + Markdown 正文）
 * - 必填字段：name（1-64 字符）, description（1-1024 字符）
 * - 可选字段：license, compatibility（≤500 字符）, metadata, allowed-tools（实验性）
 * - 可选子目录：scripts/, references/, assets/
 *
 * 参考：https://agentskills.io/specification
 */

import { parse as parseYaml } from 'yaml';
import { BaseToolset, BaseTool } from './tool';
import { object, z } from 'zod';
import { logger } from '../utils/logger';
import { jsonrepair } from 'jsonrepair';
import format from "string-template";


const NAME_MAX_LEN = 64;
const DESCRIPTION_MAX_LEN = 1024;
const COMPATIBILITY_MAX_LEN = 500;

const SKILL_FRONTMATTER_XML = `
<skill>
    <bundleName>{bundleName}</bundleName>
    <name>{skillName}</name>
    <description>{description}</description>
</skill>
`;

const TOOL_XML = `
<tool>
    <name>{name}</name>
    <description>{description}</description>
    <paramSchema>{parameters}</paramSchema>
</tool>
`

/** SKILL.md 文件名（规范要求） */
export const SKILL_MD_FILENAME = 'SKILL.md';

export interface SkillFrontmatter {
    // Anthropic Agent Skills 标准字段
    /** 技能名称（1-64 字符） */
    name: string;
    /** 技能描述（1-1024 字符） */
    description: string;
    /** 许可证信息 */
    license?: string;
    /** 兼容性说明（≤500 字符） */
    compatibility?: string;
    /** 元数据 */
    metadata?: Record<string, any>;
    /** 预先被允许使用的工具（即调用这些工具无需用户手动确认）列表 -- 实验性特性 */
    'allowed-tools'?: string[];
    /** 允许扩展字段 */
    [key: string]: any;
}

/**
 * Skill 类表示一个 Agent Skill
 */
export class Skill {
    frontmatter: SkillFrontmatter;
    body: string;
    directory?: string;
    toolsets?: BaseToolset[];

    constructor(frontmatter: SkillFrontmatter, body: string, directory?: string, toolsets?: BaseToolset[]) {
        this.frontmatter = frontmatter;
        this.body = body;
        this.directory = directory;
        this.toolsets = toolsets;
    }

    getFullContent() {
        let result = this.body;
        if (!this.toolsets) {
            return result;
        }

        result += "\n\n";
        result += "# 该Skill自带的可以被CallSkillTool调用的内部工具\n\n"
        result += "<tools>\n"
        for (const toolset of this.toolsets) {
            for (const [toolName, tool] of toolset.tools) {
                result += format(TOOL_XML, {
                    name: tool.name,
                    description: tool.description,
                    parameters: JSON.stringify(tool.params.toJSONSchema())
                })
            }
        }
        result += "</tools>";

        return result;
    }

    /**
     * 根据工具名称获取工具
     * @param toolName - 工具名称
     * @returns 找到的工具，未找到返回 undefined
     */
    getTool(toolName: string): BaseTool<any> | undefined {
        if (!this.toolsets) {
            return undefined;
        }
        for (const toolset of this.toolsets) {
            const tool = toolset.getTool(toolName);
            if (tool) {
                return tool;
            }
        }
        return undefined;
    }

    /**
     * 解析并验证 SKILL.md 内容
     * @param raw - 文件全文
     * @returns 解析后的 Skill 对象
     * @throws 如果解析或验证失败
     */
    static parseMd(raw: string): Skill {
        if (typeof raw !== 'string' || !raw.trim()) {
            throw new Error('SKILL.md 内容为空');
        }
        const trimmed = raw.trim();
        if (!trimmed.startsWith('---')) {
            throw new Error('SKILL.md 必须以 YAML frontmatter（---）开头');
        }
        const secondDash = trimmed.indexOf('\n---', 3);
        if (secondDash === -1) {
            throw new Error('SKILL.md 未找到 frontmatter 结束标记（---）');
        }
        const frontmatterRaw = trimmed.slice(3, secondDash).trim();
        const body = trimmed.slice(secondDash + 4).trim();
        let frontmatter: SkillFrontmatter;
        try {
            frontmatter = parseYaml(frontmatterRaw) as SkillFrontmatter;
        } catch (e) {
            const errorMessage = e instanceof Error ? e.message : String(e);
            throw new Error(`YAML frontmatter 解析失败: ${errorMessage}`);
        }
        if (!frontmatter || typeof frontmatter !== 'object') {
            throw new Error('frontmatter 必须为非空对象');
        }

        // 验证 frontmatter
        Skill.validateFrontmatter(frontmatter);

        return new Skill(frontmatter, body);
    }

    /**
     * 校验 name 字段（1-64 字符，非空即可）
     * @param name - 技能名称
     * @throws 如果验证失败
     */
    static validateName(name: any): void {
        if (typeof name !== 'string') {
            throw new Error('name 必须为字符串');
        }
        const trimmed = name.trim();
        if (trimmed.length === 0) {
            throw new Error('name 不能为空');
        }
        if (trimmed.length > NAME_MAX_LEN) {
            throw new Error(`name 长度不能超过 ${NAME_MAX_LEN} 字符`);
        }
    }

    /**
     * 校验 description 字段（1-1024 字符）
     * @param description - 技能描述
     * @throws 如果验证失败
     */
    static validateDescription(description: any): void {
        if (description == null) {
            throw new Error('description 必填');
        }
        const str = typeof description === 'string' ? description : String(description);
        if (str.length === 0) {
            throw new Error('description 不能为空');
        }
        if (str.length > DESCRIPTION_MAX_LEN) {
            throw new Error(`description 长度不能超过 ${DESCRIPTION_MAX_LEN} 字符`);
        }
    }

    /**
     * 校验完整 frontmatter（必填 name、description；可选 license、compatibility、metadata、allowed-tools）
     * @param frontmatter - 解析后的 YAML 对象
     * @throws 如果验证失败
     */
    static validateFrontmatter(frontmatter: any): void {
        if (!frontmatter || typeof frontmatter !== 'object') {
            throw new Error('frontmatter 必须为非空对象');
        }
        Skill.validateName(frontmatter.name);
        Skill.validateDescription(frontmatter.description);
        if (frontmatter.compatibility != null) {
            const comp = String(frontmatter.compatibility);
            if (comp.length > COMPATIBILITY_MAX_LEN) {
                throw new Error(`compatibility 长度不能超过 ${COMPATIBILITY_MAX_LEN} 字符`);
            }
        }
    }
}

const LoadSkillSchema = z.object({
    'bundleName': z.string().describe('要读取的Skill所属的应用名(bundleName)'),
    'skillName': z.string().describe('要读取的Skill的名称(name)')
})

class LoadSkillTool extends BaseTool<typeof LoadSkillSchema> {
    constructor() {
        super("LoadSkill", "读取指定技能(Skill)的内容", LoadSkillSchema);
        this.setExecutor(this.loadSkill)
    }

    private async loadSkill(args: z.output<typeof LoadSkillSchema>): Promise<string> {
        const skill = SkillRegistry.getInstance().getSkill(
            args.bundleName,
            args.skillName
        );
        if (!skill) {
            return "未找到该Skill"
        } else {
            const fullContent = skill.getFullContent();
            logger.info(`skill ${args.bundleName} ${args.skillName} 的完整内容是:\n` + fullContent);
            return fullContent;
        }
    }
}

const CallSkillToolSchema = z.object({
    'bundleName': z.string().describe('要调用的Skill内置工具所属的应用名(bundleName)'),
    'skillName': z.string().describe('要调用的Skill的名称'),
    'toolName': z.string().describe('要调用的工具名称'),
    'toolArgs': z.any().describe('要传递给工具的参数, 该参数是一个object, 应该遵循被调用的工具给出的Schema')
})

class CallSkillTool extends BaseTool<typeof CallSkillToolSchema> {
    constructor() {
        super("CallSkillTool", "调用Skill提供的内部工具", CallSkillToolSchema);
        this.setExecutor(this.callSkillTool);
    }

    private async callSkillTool(args: z.output<typeof CallSkillToolSchema>) {
        const skill = SkillRegistry.getInstance().getSkill(
            args.bundleName,
            args.skillName
        );
        if (!skill) {
            return "未找到该Skill";
        }

        const tool = skill.getTool(args.toolName);
        if (!tool) {
            return `未找到工具 ${args.toolName}`;
        }

        try {
            let toolArgs: object;
            if (typeof args.toolArgs == 'object') {
                toolArgs = args.toolArgs;
            } else if (typeof args.toolArgs == 'string') {
                toolArgs = JSON.parse(jsonrepair(args.toolArgs));
            } else {
                return "错误: toolArgs的类型无法解析";
            }

            logger.info(`call skill tool ${args.toolName} with ${JSON.stringify(args.toolArgs)}`)
            const result = await tool.execute(toolArgs);
            return result.result;
        } catch (err) {
            logger.error(`skill tool call failed: ${err}`)
            const errorMessage = err instanceof Error ? err.message : String(err);
            return `工具调用失败: ${errorMessage}`;
        }
    }
}

export class SkillRegistry {
    static instance: SkillRegistry | null = null;

    skills: Map<string, Map<string, Skill>> = new Map();

    static getInstance(): SkillRegistry {
        if (SkillRegistry.instance === null) {
            SkillRegistry.instance = new SkillRegistry();
        }
        return SkillRegistry.instance;
    }

    registerSkills(bundleName: string, ...skills: Skill[]) {
        if (!this.skills.has(bundleName)) {
            this.skills.set(bundleName, new Map());
        }

        let bundleSkills = this.skills.get(bundleName);
        for (const skill of skills) {
            bundleSkills?.set(skill.frontmatter.name, skill);
        }
    }

    getSkillFrontmatterXml(): string {
        let result = "<available_skills>\n";
        for (const [bundleName, skills] of this.skills) {
            for (const [skillName, skill] of skills) {
                result += format(SKILL_FRONTMATTER_XML, {
                    bundleName: bundleName,
                    skillName: skillName,
                    description: skill.frontmatter.description
                })
            }
        }
        result += "</available_skills>"
        return result;
    }

    getSkill(bundleName: string, skillName: string): Skill | undefined {
        const bundleSkills = this.skills.get(bundleName);
        return bundleSkills?.get(skillName);
    }

    clearSkills(bundleName: string) {
        this.skills.delete(bundleName);
    }

    getToolset(): BaseToolset {
        let toolset = new BaseToolset('skill-manager');
        toolset.addTool(new LoadSkillTool());
        toolset.addTool(new CallSkillTool());
        return toolset;
    }
}