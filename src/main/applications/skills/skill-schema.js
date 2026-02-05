/**
 * Agent Skills 格式：对齐 Anthropic 发布的行业标准（agentskills.io）
 *
 * 规范要点：
 * - 每个技能为一个目录；拷贝到用户目录时以 SKILL.md 中的 name 作为目录名
 * - 必含文件：SKILL.md（YAML frontmatter + Markdown 正文）
 * - 必填字段：name（1-64 字符，小写字母/数字/连字符，不可首尾或连续连字符）, description（1-1024 字符）
 * - 可选字段：license, compatibility（≤500 字符）, metadata, allowed-tools（实验性）
 * - 可选子目录：scripts/, references/, assets/
 *
 * 参考：https://agentskills.io/specification
 */

import { parse as parseYaml } from 'yaml';

/** SKILL.md 文件名（规范要求） */
export const SKILL_MD_FILENAME = 'SKILL.md';

/** name 合法格式：小写字母、数字、连字符，1-64 字符，不可首尾或连续连字符 */
const NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NAME_MAX_LEN = 64;
const DESCRIPTION_MAX_LEN = 1024;
const COMPATIBILITY_MAX_LEN = 500;

/**
 * 解析 SKILL.md 内容：分离 YAML frontmatter 与 Markdown body
 * @param {string} raw - 文件全文
 * @returns {{ frontmatter: object, body: string } | { error: string }}
 */
export function parseSkillMd(raw) {
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
  let frontmatter;
  try {
    frontmatter = parseYaml(frontmatterRaw);
  } catch (e) {
    return { error: `YAML frontmatter 解析失败: ${e.message}` };
  }
  if (!frontmatter || typeof frontmatter !== 'object') {
    return { error: 'frontmatter 必须为非空对象' };
  }
  return { frontmatter, body };
}

/**
 * 校验 name 字段（规范：1-64 字符，小写字母/数字/连字符，不可首尾或连续连字符）
 * @param {string} name
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateSkillName(name) {
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
  if (!NAME_REGEX.test(trimmed)) {
    return { valid: false, error: 'name 仅允许小写字母、数字与连字符，且不可以连字符开头/结尾或包含连续连字符' };
  }
  return { valid: true };
}

/**
 * 校验 description 字段（1-1024 字符）
 * @param {string} description
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateSkillDescription(description) {
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
 * @param {object} frontmatter - 解析后的 YAML 对象
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateSkillFrontmatter(frontmatter) {
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
 * @param {string} raw - SKILL.md 文件内容
 * @returns {{ valid: boolean, name?: string, description?: string, body?: string, frontmatter?: object, error?: string }}
 */
export function parseAndValidateSkillMd(raw) {
  const parsed = parseSkillMd(raw);
  if (parsed.error) {
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
