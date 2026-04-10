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

/** SKILL.md 文件名（规范要求） */
export const SKILL_MD_FILENAME = 'SKILL.md';

const NAME_MAX_LEN = 64;
const DESCRIPTION_MAX_LEN = 1024;
const COMPATIBILITY_MAX_LEN = 500;

/** SKILL.md frontmatter 的类型定义 */
export interface SkillFrontmatter {
    name: string;
    description: string;
    license?: string;
    compatibility?: string;
    metadata?: Record<string, unknown>;
    'allowed-tools'?: string[];
    [key: string]: unknown;
}

/** parseSkillMd 成功时的返回类型 */
export interface ParseSkillMdSuccess {
    frontmatter: SkillFrontmatter;
    body: string;
    error?: undefined;
}

/** parseSkillMd 失败时的返回类型 */
export interface ParseSkillMdError {
    frontmatter?: undefined;
    body?: undefined;
    error: string;
}

export type ParseSkillMdResult = ParseSkillMdSuccess | ParseSkillMdError;

/** 校验结果类型 */
export interface ValidationResult {
    valid: boolean;
    error?: string;
}

/** parseAndValidateSkillMd 成功时的返回类型 */
export interface ParseAndValidateSuccess {
    valid: true;
    name: string;
    description: string;
    body: string;
    frontmatter: SkillFrontmatter;
    error?: undefined;
}

/** parseAndValidateSkillMd 失败时的返回类型 */
export interface ParseAndValidateError {
    valid: false;
    error: string;
    name?: undefined;
    description?: undefined;
    body?: undefined;
    frontmatter?: undefined;
}

export type ParseAndValidateResult = ParseAndValidateSuccess | ParseAndValidateError;

/**
 * 尝试修补常见的 YAML frontmatter 格式错误，使其可被严格解析器接受。
 *
 * 已知的技能作者常犯错误：
 *  1. 未加引号的冒号值 — `description: 支持 http://xxx 的访问`
 *     YAML 将第二个冒号视为嵌套映射，导致解析失败。
 *     修补：用 JSON.stringify 包裹整个值。
 *
 *  2. 未闭合的双引号 — `description: "很长的描述但忘了关引号`
 *     YAML 期望匹配的关闭引号，遇到 EOF 报错。
 *     修补：在行尾补上对应的闭合引号。
 *
 *  3. 未闭合的单引号 — 同上，单引号版本。
 *
 * @param raw - frontmatter 部分的原始文本（不含 --- 分隔符）
 * @returns 修补后的文本；如果无需修补则返回原文
 */
function patchFrontmatterYaml(raw: string): string {
    return raw
        .split('\n')
        .map((line) => {
            const m = line.match(/^(\w[\w-]*):(\s+)(.+)$/);
            if (!m) return line;
            const [, key, spacing, value] = m;
            if (value.includes(':') && !value.startsWith('"') && !value.startsWith("'")) {
                return key + ':' + spacing + JSON.stringify(value);
            }
            if (value.startsWith('"') && !value.endsWith('"')) {
                return key + ':' + spacing + value + '"';
            }
            if (value.startsWith("'") && !value.endsWith("'")) {
                return key + ':' + spacing + value + "'";
            }
            return line;
        })
        .join('\n');
}

/**
 * 先用严格解析尝试；失败后自动 patch 再重试一次。
 * @param raw - frontmatter 原始文本
 * @returns 解析成功返回对象，失败返回 Error
 */
function tryParseYamlWithPatch(raw: string): Record<string, unknown> | Error {
    try {
        return parseYaml(raw) as Record<string, unknown>;
    } catch (firstErr) {
        const patched = patchFrontmatterYaml(raw);
        if (patched === raw) return firstErr instanceof Error ? firstErr : new Error(String(firstErr));
        try {
            return parseYaml(patched) as Record<string, unknown>;
        } catch (_) {
            return firstErr instanceof Error ? firstErr : new Error(String(firstErr));
        }
    }
}

/**
 * 解析 SKILL.md 内容：分离 YAML frontmatter 与 Markdown body
 * @param raw - 文件全文
 * @returns 解析成功返回 frontmatter 和 body，失败返回 error
 */
export function parseSkillMd(raw: string): ParseSkillMdResult {
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
    const frontmatter = tryParseYamlWithPatch(frontmatterRaw);
    if (frontmatter instanceof Error) {
        return { error: `YAML frontmatter 解析失败: ${frontmatter.message}` };
    }
    if (!frontmatter || typeof frontmatter !== 'object') {
        return { error: 'frontmatter 必须为非空对象' };
    }
    return { frontmatter: frontmatter as SkillFrontmatter, body };
}

/**
 * 校验 name 字段（1-64 字符，非空即可）
 */
export function validateSkillName(name: unknown): ValidationResult {
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
 */
export function validateSkillDescription(description: unknown): ValidationResult {
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
 */
export function validateSkillFrontmatter(frontmatter: unknown): ValidationResult {
    if (!frontmatter || typeof frontmatter !== 'object') {
        return { valid: false, error: 'frontmatter 必须为非空对象' };
    }
    const fm = frontmatter as Record<string, unknown>;
    const nameResult = validateSkillName(fm.name);
    if (!nameResult.valid) return nameResult;
    const descResult = validateSkillDescription(fm.description);
    if (!descResult.valid) return descResult;
    if (fm.compatibility != null) {
        const comp = String(fm.compatibility);
        if (comp.length > COMPATIBILITY_MAX_LEN) {
            return {
                valid: false,
                error: `compatibility 长度不能超过 ${COMPATIBILITY_MAX_LEN} 字符`
            };
        }
    }
    return { valid: true };
}

/**
 * 解析并校验 SKILL.md，返回可用于注册的 skill 元数据
 * @param raw - SKILL.md 文件内容
 */
export function parseAndValidateSkillMd(raw: string): ParseAndValidateResult {
    const parsed = parseSkillMd(raw);
    if (parsed.error) {
        return { valid: false, error: parsed.error };
    }
    const { frontmatter, body } = parsed;
    const validation = validateSkillFrontmatter(frontmatter);
    if (!validation.valid) {
        return { valid: false, error: validation.error! };
    }
    const name = String(frontmatter.name).trim();
    const description =
        frontmatter.description != null
            ? (typeof frontmatter.description === 'string'
                  ? frontmatter.description
                  : String(frontmatter.description)
              ).trim()
            : '';
    return {
        valid: true,
        name,
        description,
        body,
        frontmatter
    };
}
