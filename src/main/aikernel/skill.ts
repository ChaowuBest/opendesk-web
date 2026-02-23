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

// Constants
const NAME_MAX_LEN = 64;
const DESCRIPTION_MAX_LEN = 1024;
const COMPATIBILITY_MAX_LEN = 500;

/** SKILL.md 文件名（规范要求） */
export const SKILL_MD_FILENAME = 'SKILL.md';

export type SkillLocation =
    | { 'type': 'directory', path: string }
    | { 'type': ''}
    ;

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
}

export interface SkillMd {
    frontmatter: SkillFrontmatter;
    body: string;
}

export interface ValidationResult {
    valid: boolean;
    error?: string;
}

export interface ParsedAndValidatedSkill extends ValidationResult {
    name?: string;
    description?: string;
    body?: string;
    frontmatter?: SkillFrontmatter;
}

/**
 * 解析 SKILL.md 内容：分离 YAML frontmatter 与 Markdown body
 * @param raw - 文件全文
 * @returns 解析结果或错误信息
 */
export function parseSkillMd(raw: string): SkillMd | { error: string } {
    if (typeof raw !== 'string' || !raw.trim()) {
        return { error: 'SKILL.md 内容为空' };
    }
    const trimmed = raw.trim();
    if (!trimmed.startsWith('---')) {
        return { error: 'SKILL.md 必须以 YAML frontmatter（---）开头' };
    }
    const secondDash = trimmed.indexOf('\n---', 3);
    if (secondDash === -1) {
        return { error: 'SKILL.md 未找到 frontmatter 结束标记（---）' };
    }
    const frontmatterRaw = trimmed.slice(3, secondDash).trim();
    const body = trimmed.slice(secondDash + 4).trim();
    let frontmatter: SkillFrontmatter;
    try {
        frontmatter = parseYaml(frontmatterRaw) as SkillFrontmatter;
    } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        return { error: `YAML frontmatter 解析失败: ${errorMessage}` };
    }
    if (!frontmatter || typeof frontmatter !== 'object') {
        return { error: 'frontmatter 必须为非空对象' };
    }
    return { frontmatter, body };
}

/**
 * 校验 name 字段（1-64 字符，非空即可）
 * @param name - 技能名称
 * @returns 校验结果
 */
export function validateSkillName(name: any): ValidationResult {
    if (typeof name !== 'string') {
        return { valid: false, error: 'name 必须为字符串' };
    }
    const trimmed = name.trim();
    if (trimmed.length === 0) {
        return { valid: false, error: 'name 不能为空' };
    }
    if (trimmed.length > NAME_MAX_LEN) {
        return { valid: false, error: `name 长度不能超过 ${NAME_MAX_LEN} 字符` };
    }
    return { valid: true };
}

/**
 * 校验 description 字段（1-1024 字符）
 * @param description - 技能描述
 * @returns 校验结果
 */
export function validateSkillDescription(description: any): ValidationResult {
    if (description == null) {
        return { valid: false, error: 'description 必填' };
    }
    const str = typeof description === 'string' ? description : String(description);
    if (str.length === 0) {
        return { valid: false, error: 'description 不能为空' };
    }
    if (str.length > DESCRIPTION_MAX_LEN) {
        return { valid: false, error: `description 长度不能超过 ${DESCRIPTION_MAX_LEN} 字符` };
    }
    return { valid: true };
}

/**
 * 校验完整 frontmatter（必填 name、description；可选 license、compatibility、metadata、allowed-tools）
 * @param frontmatter - 解析后的 YAML 对象
 * @returns 校验结果
 */
export function validateSkillFrontmatter(frontmatter: any): ValidationResult {
    if (!frontmatter || typeof frontmatter !== 'object') {
        return { valid: false, error: 'frontmatter 必须为非空对象' };
    }
    const nameResult = validateSkillName(frontmatter.name);
    if (!nameResult.valid) return nameResult;
    const descResult = validateSkillDescription(frontmatter.description);
    if (!descResult.valid) return descResult;
    if (frontmatter.compatibility != null) {
        const comp = String(frontmatter.compatibility);
        if (comp.length > COMPATIBILITY_MAX_LEN) {
            return { valid: false, error: `compatibility 长度不能超过 ${COMPATIBILITY_MAX_LEN} 字符` };
        }
    }
    return { valid: true };
}

/**
 * 解析并校验 SKILL.md，返回可用于注册的 skill 元数据
 * @param raw - SKILL.md 文件内容
 * @returns 解析和校验结果
 */
export function parseAndValidateSkillMd(raw: string): ParsedAndValidatedSkill {
    const parsed = parseSkillMd(raw);
    if ('error' in parsed) {
        return { valid: false, error: parsed.error };
    }
    const { frontmatter, body } = parsed;
    const validation = validateSkillFrontmatter(frontmatter);
    if (!validation.valid) {
        return { valid: false, error: validation.error };
    }
    const name = String(frontmatter.name).trim();
    const description = frontmatter.description != null
        ? (typeof frontmatter.description === 'string' ? frontmatter.description : String(frontmatter.description)).trim()
        : '';
    return {
        valid: true,
        name,
        description,
        body,
        frontmatter
    };
}

export class SkillRegistry {
    availableSkills: SkillMd[] = [];

    getFrontmatters(): string {
        return '';
    }
}