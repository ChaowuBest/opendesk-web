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
    return cleanFrontmatterYaml(raw)
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

function cleanFrontmatterYaml(raw: string): string {
    return raw
        .split('\n')
        .filter((line) => {
            const trimmed = line.trim();
            if (/^(<<<<<<<|>>>>>>>)/.test(trimmed)) return false;
            if (trimmed === '=======') return false;
            if (/^`+$/.test(trimmed)) return false;
            return true;
        })
        .join('\n');
}

function parseLooseFrontmatter(raw: string): Record<string, unknown> | null {
    const result: Record<string, unknown> = {};
    for (const line of cleanFrontmatterYaml(raw).split('\n')) {
        const match = line.match(/^([A-Za-z_][\w-]*):(?:\s*(.*))?$/);
        if (!match) continue;
        const [, key, rawValue = ''] = match;
        const value = rawValue.trim();
        if (!value || value === '|' || value === '>') continue;
        result[key] = stripYamlScalarQuotes(value);
    }
    return Object.keys(result).length > 0 ? result : null;
}

function stripYamlScalarQuotes(value: string): string {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }
    return value;
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
        if (patched === raw) {
            const loose = parseLooseFrontmatter(raw);
            if (loose) return loose;
            return firstErr instanceof Error ? firstErr : new Error(String(firstErr));
        }
        try {
            return parseYaml(patched) as Record<string, unknown>;
        } catch (_) {
            const loose = parseLooseFrontmatter(raw);
            if (loose) return loose;
            return firstErr instanceof Error ? firstErr : new Error(String(firstErr));
        }
    }
}

/**
 * 将标题或展示名转换为更适合作为 skill id 的名称。
 */
export function slugifyName(raw: string): string {
    return raw
        .toLowerCase()
        .replace(/[^\w\u4e00-\u9fff\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

/**
 * 从 Markdown body 中推断技能名称：取第一个 # 标题，slugify
 */
function inferNameFromBody(body: string): string {
    const headingMatch = body.match(/^#\s+(.+)$/m);
    if (headingMatch) {
        const raw = headingMatch[1].trim();
        const slug = slugifyName(raw);
        if (slug.length > 0 && slug.length <= 64) return slug;
    }
    return '';
}

function normalizeNameCandidate(candidate: unknown, shouldSlugify: boolean = false): string {
    if (candidate === null || candidate === undefined) return '';
    const raw = String(candidate).trim();
    if (!raw) return '';
    const normalized = shouldSlugify ? slugifyName(raw) || raw : raw;
    const validation = validateSkillName(normalized);
    return validation.valid ? validation.normalized! : '';
}

function inferNameFromFrontmatter(frontmatter: Record<string, unknown>, body: string, fallbackName?: string): string {
    for (const key of ['name', 'slug']) {
        const name = normalizeNameCandidate(frontmatter[key]);
        if (name) return name;
    }
    return (
        normalizeNameCandidate(fallbackName) ||
        normalizeNameCandidate(frontmatter.display_name, true) ||
        normalizeNameCandidate(frontmatter.displayName, true) ||
        normalizeNameCandidate(inferNameFromBody(body)) ||
        'unnamed-skill'
    );
}

/**
 * 从 Markdown body 中推断描述：取第一个段落（非标题、非空行）
 */
function inferDescriptionFromBody(body: string): string {
    const paragraphs = body.split(/\n\n+/);
    for (const p of paragraphs) {
        const text = p.replace(/^#.*$/gm, '').trim();
        if (text.length > 0) {
            const desc = text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
            if (desc.length > 1024) return desc.slice(0, 1021) + '...';
            return desc;
        }
    }
    return '';
}

function normalizeDescriptionCandidate(candidate: unknown): string {
    const validation = validateSkillDescription(candidate);
    return validation.valid ? validation.normalized! : '';
}

function inferDescriptionFromFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
    return (
        normalizeDescriptionCandidate(frontmatter.description) ||
        normalizeDescriptionCandidate(frontmatter.summary) ||
        inferDescriptionFromBody(body) ||
        'A skill imported into OpenDesk'
    );
}

function findFrontmatterEnd(markdown: string, fromIndex: number = 3): number {
    const match = markdown.slice(fromIndex).match(/\n---[ \t]*(?:\n|$)/);
    return match?.index === undefined ? -1 : fromIndex + match.index;
}

function splitFrontmatterBlock(markdown: string): { frontmatterRaw: string; body: string } | null {
    const secondDash = findFrontmatterEnd(markdown, 3);
    if (secondDash === -1) return null;
    return {
        frontmatterRaw: markdown.slice(3, secondDash).trim(),
        body: markdown.slice(secondDash + 4).trim()
    };
}

/**
 * 解析 SKILL.md 内容：分离 YAML frontmatter 与 Markdown body。
 * 提升了对不规范格式的兼容性：
 * - 无 frontmatter 时自动从正文推断 name/description
 * - 缺少结束 --- 时尝试容错恢复
 * - YAML 解析失败时回退到自动推断
 *
 * @param raw - 文件全文
 * @param fallbackName - 当无法从内容推断名称时的兜底值（如目录名）
 * @returns 解析成功返回 frontmatter 和 body，失败返回 error
 */
export function parseSkillMd(raw: string, fallbackName?: string): ParseSkillMdResult {
    if (typeof raw !== 'string' || !raw.trim()) {
        return { error: 'SKILL.md 内容为空' };
    }
    const trimmed = raw.trim();

    // 无 frontmatter：从正文推断
    if (!trimmed.startsWith('---')) {
        const inferredName = normalizeNameCandidate(fallbackName) || inferNameFromBody(trimmed) || 'unnamed-skill';
        const inferredDesc = inferDescriptionFromBody(trimmed) || 'A skill imported without YAML frontmatter';
        return {
            frontmatter: { name: inferredName, description: inferredDesc },
            body: trimmed
        };
    }

    let frontmatterRaw: string;
    let body: string;
    const block = splitFrontmatterBlock(trimmed);

    if (!block) {
        // 整个内容只有开头的 --- 没有结束 ---，容错处理
        // 尝试找第一个空行后的内容作为 body
        const firstBlankLine = trimmed.indexOf('\n\n', 3);
        if (firstBlankLine > 0) {
            frontmatterRaw = trimmed.slice(3, firstBlankLine).trim();
            body = trimmed.slice(firstBlankLine).trim();
        } else {
            // 尝试把第一段作为 frontmatter（可能只有 name: xxx 这样一行）
            const firstNewline = trimmed.indexOf('\n', 3);
            if (firstNewline > 0) {
                frontmatterRaw = trimmed.slice(3, firstNewline).trim();
                body = trimmed.slice(firstNewline).trim();
            } else {
                // 实在没办法，整段当 body
                frontmatterRaw = trimmed.slice(3).trim();
                body = '';
            }
        }
    } else {
        frontmatterRaw = block.frontmatterRaw;
        body = block.body;
        if (!frontmatterRaw) {
            const nextEnd = findFrontmatterEnd(body, 0);
            if (nextEnd !== -1) {
                frontmatterRaw = body.slice(0, nextEnd).trim();
                body = body.slice(nextEnd + 4).trim();
            }
        }
    }

    const frontmatter = tryParseYamlWithPatch(frontmatterRaw);
    if (frontmatter instanceof Error) {
        // YAML 解析失败，从 body 推断
        const inferredName = inferNameFromBody(body || trimmed) || fallbackName || 'unnamed-skill';
        const inferredDesc = inferDescriptionFromBody(body || trimmed) || 'A skill with unparseable YAML frontmatter';
        return {
            frontmatter: { name: inferredName, description: inferredDesc },
            body: body || trimmed
        };
    }
    if (!frontmatter || typeof frontmatter !== 'object') {
        const inferredName = inferNameFromBody(body || trimmed) || fallbackName || 'unnamed-skill';
        const inferredDesc = inferDescriptionFromBody(body || trimmed) || 'A skill with empty frontmatter';
        return { frontmatter: { name: inferredName, description: inferredDesc }, body: body || trimmed };
    }
    return { frontmatter: frontmatter as SkillFrontmatter, body };
}

/**
 * 校验 name 字段（1-64 字符，非空即可）
 */
/**
 * 校验并规范化 name 字段。自动将非字符串类型转为字符串。
 */
export function validateSkillName(name: unknown): ValidationResult & { normalized?: string } {
    let normalized: string;
    if (typeof name !== 'string') {
        if (name === null || name === undefined) {
            return { valid: false, error: 'name 不能为空' };
        }
        normalized = String(name).trim();
    } else {
        normalized = name.trim();
    }
    if (normalized.length === 0) {
        return { valid: false, error: 'name 不能为空' };
    }
    if (normalized.length > NAME_MAX_LEN) {
        normalized = normalized.slice(0, NAME_MAX_LEN);
    }
    return { valid: true, normalized };
}

/**
 * 校验 description 字段（1-1024 字符）
 */
/**
 * 校验并规范化 description 字段。自动截断超长内容，缺失时提供默认值。
 */
export function validateSkillDescription(description: unknown): ValidationResult & { normalized?: string } {
    if (description == null || description === '') {
        return { valid: false, error: 'description 必填' };
    }
    let normalized = typeof description === 'string' ? description : String(description);
    if (normalized.length === 0) {
        return { valid: false, error: 'description 必填' };
    }
    if (normalized.length > DESCRIPTION_MAX_LEN) {
        normalized = normalized.slice(0, DESCRIPTION_MAX_LEN - 3) + '...';
    }
    return { valid: true, normalized };
}

/**
 * 校验完整 frontmatter（必填 name、description；可选 license、compatibility、metadata、allowed-tools）
 * @param frontmatter - 解析后的 YAML 对象
 */
export function validateSkillFrontmatter(
    frontmatter: unknown
): ValidationResult & { normalizedName?: string; normalizedDescription?: string } {
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
    return { valid: true, normalizedName: nameResult.normalized, normalizedDescription: descResult.normalized };
}

/**
 * 解析并校验 SKILL.md，返回可用于注册的 skill 元数据
 * @param raw - SKILL.md 文件内容
 */
/**
 * 解析并校验 SKILL.md，返回可用于注册的 skill 元数据。
 * 对格式不规范的文件自动兼容处理：
 * - 无 frontmatter 时从正文和文件名自动推断
 * - YAML 解析失败时回退到自动推断
 * - name 非字符串自动转换
 * - description 超长自动截断、缺失自动补全
 *
 * @param raw - SKILL.md 文件内容
 * @param fallbackName - 当无法从内容推断名称时的兜底值（如目录名）
 */
export function parseAndValidateSkillMd(raw: string, fallbackName?: string): ParseAndValidateResult {
    const parsed = parseSkillMd(raw, fallbackName);
    if (parsed.error) {
        return { valid: false, error: parsed.error };
    }
    const { frontmatter, body } = parsed;
    const fm = frontmatter as Record<string, unknown>;
    const name = inferNameFromFrontmatter(fm, body, fallbackName);

    let description = inferDescriptionFromFrontmatter(fm, body);
    if (fm.compatibility != null) {
        const comp = String(fm.compatibility);
        if (comp.length > COMPATIBILITY_MAX_LEN) {
            return {
                valid: false,
                error: `compatibility 长度不能超过 ${COMPATIBILITY_MAX_LEN} 字符`
            };
        }
    }

    // 最后兜底
    if (description.length === 0) {
        description = 'A skill imported into OpenDesk';
    }

    return {
        valid: true,
        name,
        description,
        body,
        frontmatter: {
            ...frontmatter,
            name,
            description
        }
    };
}

/**
 * 从 registry metadata.json 合成符合 SKILL.md 格式的内容。
 * 用于兼容 market 中仅含元数据、无 SKILL.md 的技能包。
 *
 * @param meta - metadata.json 的解析结果
 * @returns 合成的 Markdown 文本，或 null（字段不足）
 */
export function synthesizeSkillMdFromMetadata(meta: Record<string, unknown>): string | null {
    if (!meta.slug && !meta.name) return null;
    const skillName = String(meta.slug || slugifyName(String(meta.name)));
    const skillDesc = String(meta.description || meta.name || '');
    return [
        '---',
        `name: ${skillName}`,
        `description: ${skillDesc}`,
        meta.version ? `version: ${String(meta.version)}` : '',
        meta.license ? `license: ${String(meta.license)}` : '',
        '---',
        '',
        `# ${meta.name || meta.slug}`,
        '',
        skillDesc
    ]
        .filter(Boolean)
        .join('\n');
}
