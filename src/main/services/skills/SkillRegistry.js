/**
 * 本地 Agent Skills 注册表：对齐 Anthropic Agent Skills 标准（agentskills.io）
 * 扫描端侧 skills 目录下的 SKILL.md，解析 YAML frontmatter，每个技能暴露为一个 tool 供主进程对话调用
 */

import path from 'path';
import fs from 'fs';
import { pathToFileURL } from 'url';
import { spawn } from 'child_process';
import { getAppDirectory } from '../../utils/setting.js';
import { BaseTool, BaseToolset } from '../../agents/tool.js';
import { parseAndValidateSkillMd, SKILL_MD_FILENAME } from './skill-schema.js';
import { logger } from '../../utils/logger.js';

const SKILLS_DIR_NAME = 'skills';

/** @type {Map<string, { frontmatter: object, body: string, toolset: BaseToolset, skillDir: string }>} */
const skillsCache = new Map();

/**
 * 获取本地 skills 根目录（userData/skills）
 * @returns {string}
 */
function getSkillsDirectory() {
  const appDir = getAppDirectory();
  const skillsDir = path.join(appDir, SKILLS_DIR_NAME);
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }
  return skillsDir;
}

/**
 * 加载单个技能目录：读取 SKILL.md，解析并校验，创建单技能单 tool
 * @param {string} skillDir - 技能目录绝对路径
 * @param {string} dirName - 目录名（须与 SKILL.md 的 name 一致）
 * @returns {{ success: boolean, toolset?: BaseToolset, error?: string, name?: string, body?: string, frontmatter?: object }}
 */
function loadSkillFromDir(skillDir, dirName) {
  const skillMdPath = path.join(skillDir, SKILL_MD_FILENAME);
  if (!fs.existsSync(skillMdPath)) {
    return { success: false, error: `缺少 ${SKILL_MD_FILENAME}` };
  }

  let raw;
  try {
    raw = fs.readFileSync(skillMdPath, 'utf8');
  } catch (e) {
    return { success: false, error: `读取 ${SKILL_MD_FILENAME} 失败: ${e.message}` };
  }

  const parsed = parseAndValidateSkillMd(raw, dirName);
  if (!parsed.valid) {
    return { success: false, error: parsed.error };
  }

  const { name, description, body, frontmatter } = parsed;
  const toolsetName = `skill-${name}`;
  const toolset = new BaseToolset(toolsetName);

  // 单技能单 tool：与 Anthropic 规范一致，一个 skill 对应一个可调用的能力
  const paramsSchema = { type: 'object', properties: {}, required: [] };
  const handler = frontmatter.fillipdesk?.handler ?? frontmatter.handler;
  if (handler && (frontmatter.fillipdesk?.input_schema || frontmatter.input_schema)) {
    const schema = frontmatter.fillipdesk?.input_schema ?? frontmatter.input_schema;
    if (schema && typeof schema === 'object' && schema.properties) {
      paramsSchema.properties = { ...schema.properties };
      paramsSchema.required = Array.isArray(schema.required) ? schema.required : [];
    }
  } else {
    paramsSchema.properties = {
      input: { type: 'string', description: '可选：当前任务或用户输入摘要，供技能执行时参考' }
    };
    paramsSchema.required = [];
  }

  const tool = BaseTool.fromJSON({
    name,
    description,
    params: paramsSchema
  });
  tool.setExecutor(createExecutor(name, skillDir, body, frontmatter, handler));
  toolset.addTool(tool);

  return {
    success: true,
    toolset,
    name,
    body,
    frontmatter,
    skillDir
  };
}

/**
 * 创建技能执行器：默认返回 SKILL.md body（指令正文）；若配置 handler 则执行脚本/模块并返回结果
 * @param {string} skillName
 * @param {string} skillDir
 * @param {string} body - SKILL.md 正文
 * @param {object} frontmatter
 * @param {string | object} handler - fillipdesk 扩展：脚本路径或 { type, path } / { type, url }
 * @returns {(args: object) => Promise<string>}
 */
function createExecutor(skillName, skillDir, body, frontmatter, handler) {
  return async (args) => {
    const input = args?.input ?? '';
    if (!handler) {
      return body || `[技能 ${skillName}] 无正文说明。`;
    }

    const h = typeof handler === 'string' ? { type: 'script', path: handler } : handler;
    if (!h || !h.type) {
      return body || `[技能 ${skillName}] 无正文说明。`;
    }

    if (h.type === 'script' && h.path) {
      const scriptPath = path.resolve(skillDir, h.path);
      if (!scriptPath.startsWith(path.resolve(skillDir))) {
        return `[技能 ${skillName}] handler 路径不允许超出技能目录`;
      }
      if (!fs.existsSync(scriptPath)) {
        return `[技能 ${skillName}] 脚本不存在: ${h.path}`;
      }
      return runScript(scriptPath, skillDir, input);
    }

    if (h.type === 'module' && h.path) {
      const modulePath = path.resolve(skillDir, h.path);
      if (!modulePath.startsWith(path.resolve(skillDir))) {
        return `[技能 ${skillName}] handler 路径不允许超出技能目录`;
      }
      try {
        const moduleUrl = pathToFileURL(modulePath).href;
        const mod = await import(moduleUrl);
        const execute = mod.execute ?? mod.default?.execute ?? mod.default;
        if (typeof execute !== 'function') {
          return `[技能 ${skillName}] handler 模块需导出 execute(input, args) => Promise<string>`;
        }
        const result = await execute(input, args);
        return typeof result === 'string' ? result : JSON.stringify(result);
      } catch (err) {
        logger.error(`Skill ${skillName} module error: ${err.message}`);
        return `执行失败: ${err.message}`;
      }
    }

    if (h.type === 'url' && h.url) {
      try {
        const res = await fetch(h.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ skill: skillName, input, arguments: args })
        });
        const text = await res.text();
        if (!res.ok) return `远程调用失败 (${res.status}): ${text}`;
        return text;
      } catch (err) {
        logger.error(`Skill ${skillName} url error: ${err.message}`);
        return `请求失败: ${err.message}`;
      }
    }

    return body || `[技能 ${skillName}] 未配置可执行 handler。`;
  };
}

/**
 * 在 skillDir 下执行脚本，传入 input 为 stdin，返回 stdout
 * @param {string} scriptPath - 脚本绝对路径
 * @param {string} skillDir - 技能目录（cwd）
 * @param {string} input
 * @returns {Promise<string>}
 */
function runScript(scriptPath, skillDir, input) {
  return new Promise((resolve, reject) => {
    const ext = path.extname(scriptPath).toLowerCase();
    const isJs = ext === '.js' || ext === '.mjs' || ext === '.cjs';
    const cmd = isJs ? process.execPath : scriptPath;
    const argv = isJs ? [scriptPath] : [];
    const child = spawn(cmd, argv, {
      cwd: skillDir,
      shell: !isJs,
      env: { ...process.env, SKILL_INPUT: input }
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (ch) => { stdout += ch; });
    child.stderr?.on('data', (ch) => { stderr += ch; });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code !== 0) {
        resolve(`[脚本退出码 ${code}]\n${stderr || stdout}`.trim());
      } else {
        resolve(stdout.trim() || '(无输出)');
      }
    });
    if (input && child.stdin) {
      child.stdin.write(input, 'utf8');
      child.stdin.end();
    }
  });
}

/**
 * 扫描 skills 目录下所有子目录，加载 SKILL.md 并缓存
 * @returns {{ toolsets: BaseToolset[], errors: Array<{ id: string, error: string }> }}
 */
function loadAll() {
  const skillsDir = getSkillsDirectory();
  skillsCache.clear();

  const toolsets = [];
  const errors = [];

  let entries = [];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch (e) {
    logger.error(`SkillRegistry: 无法读取目录 ${skillsDir}: ${e.message}`);
    return { toolsets, errors: [{ id: '', error: e.message }] };
  }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const skillDir = path.join(skillsDir, ent.name);
    const result = loadSkillFromDir(skillDir, ent.name);
    if (result.success) {
      skillsCache.set(result.name, {
        frontmatter: result.frontmatter,
        body: result.body,
        toolset: result.toolset,
        skillDir: result.skillDir
      });
      toolsets.push(result.toolset);
      logger.info(`SkillRegistry: 已加载技能 ${result.name} (Anthropic Agent Skills)`);
    } else {
      errors.push({ id: ent.name, error: result.error });
      logger.warn(`SkillRegistry: 跳过 ${ent.name} - ${result.error}`);
    }
  }

  return { toolsets, errors };
}

/**
 * 获取当前已加载的所有技能对应的 BaseToolset 列表，供主进程对话挂载
 * @returns {BaseToolset[]}
 */
function getToolsets() {
  if (skillsCache.size === 0) {
    const { toolsets } = loadAll();
    return toolsets;
  }
  return Array.from(skillsCache.values()).map((s) => s.toolset);
}

/**
 * 刷新技能列表（重新扫描磁盘），返回新 toolsets
 * @returns {{ toolsets: BaseToolset[], errors: Array<{ id: string, error: string }> }}
 */
function refresh() {
  return loadAll();
}

/**
 * 列出已加载技能的元信息（供 UI / IPC），对齐 Anthropic 规范字段
 * @returns {Array<{ id: string, name: string, description: string, license?: string, compatibility?: string, metadata?: object }>}
 */
function listSkills() {
  if (skillsCache.size === 0) loadAll();
  return Array.from(skillsCache.entries()).map(([id, s]) => ({
    id,
    name: s.frontmatter.name,
    description: s.frontmatter.description ?? '',
    license: s.frontmatter.license,
    compatibility: s.frontmatter.compatibility,
    metadata: s.frontmatter.metadata,
    allowedTools: s.frontmatter['allowed-tools']
  }));
}

export const SkillRegistry = {
  getSkillsDirectory,
  loadAll,
  getToolsets,
  refresh,
  listSkills
};
