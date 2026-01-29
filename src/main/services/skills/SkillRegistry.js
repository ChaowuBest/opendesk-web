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
const REFERENCES_DIR = 'references';
const SCRIPTS_DIR = 'scripts';
const ASSETS_DIR = 'assets';

/** @type {Map<string, { frontmatter: object, body: string, toolset: BaseToolset, skillDir: string }>} */
const skillsCache = new Map();

/** 内置 skills 根目录（main 进程设置），用于渐进式加载时回退读取 resources/skills */
let bundledSkillsRoot = '';

/**
 * 设置内置 skills 根目录（app.getAppPath()），用于在 userData 目录无参考文档/脚本时回退加载
 * @param {string} appPath
 */
function setBundledSkillsRoot(appPath) {
  if (typeof appPath === 'string' && appPath) bundledSkillsRoot = path.resolve(appPath);
}

/**
 * 从指定目录读取参考文档与脚本列表（不修改传入的 arrays，返回合并结果）
 */
function readResourcesFromDir(resolvedDir, intoRefs, intoScripts, intoAssets) {
  const safeReadFile = (filePath) => {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return '';
    }
  };

  // 技能根目录下除 SKILL.md 外的 .md 文件（如 reference.md, forms.md）
  try {
    const entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || path.extname(e.name).toLowerCase() !== '.md') continue;
      if (e.name === SKILL_MD_FILENAME) continue;
      const content = safeReadFile(path.join(resolvedDir, e.name));
      if (content) intoRefs.push({ name: e.name, content });
    }
  } catch (_) {}

  const refDir = path.join(resolvedDir, REFERENCES_DIR);
  if (fs.existsSync(refDir) && fs.statSync(refDir).isDirectory()) {
    try {
      const refEntries = fs.readdirSync(refDir, { withFileTypes: true });
      for (const e of refEntries) {
        const full = path.join(refDir, e.name);
        if (e.isFile()) {
          const content = safeReadFile(full);
          if (content) intoRefs.push({ name: `${REFERENCES_DIR}/${e.name}`, content });
        }
      }
    } catch (_) {}
  }

  const scriptsDir = path.join(resolvedDir, SCRIPTS_DIR);
  if (fs.existsSync(scriptsDir) && fs.statSync(scriptsDir).isDirectory()) {
    try {
      const list = fs.readdirSync(scriptsDir);
      intoScripts.push(...list.map((name) => `${SCRIPTS_DIR}/${name}`));
    } catch (_) {}
  }

  const assetsDirPath = path.join(resolvedDir, ASSETS_DIR);
  if (fs.existsSync(assetsDirPath) && fs.statSync(assetsDirPath).isDirectory()) {
    try {
      const list = fs.readdirSync(assetsDirPath);
      intoAssets.push(...list.map((name) => `${ASSETS_DIR}/${name}`));
    } catch (_) {}
  }
}

/**
 * 渐进式加载技能资源：在技能被调用时读取 references、scripts、assets 等（Anthropic 规范子目录）
 * 先读 userData/skills/<name>，若参考文档与脚本均为空则回退读 bundled resources/skills/<name>（调试/未拷贝完整时）
 * @param {string} skillDir - 技能目录绝对路径（通常为 userData/skills/<name>）
 * @param {string} skillName - 技能 name（用于回退路径 basename）
 * @returns {{ referencesSections: Array<{ name: string, content: string }>, scriptsList: string[], assetsList: string[] }}
 */
function loadSkillResources(skillDir, skillName) {
  const referencesSections = [];
  const scriptsList = [];
  const assetsList = [];

  const resolvedDir = path.resolve(skillDir);
  readResourcesFromDir(resolvedDir, referencesSections, scriptsList, assetsList);

  const hadAny = referencesSections.length > 0 || scriptsList.length > 0 || assetsList.length > 0;
  if (!hadAny && bundledSkillsRoot && skillName) {
    const fallbackDir = path.join(bundledSkillsRoot, 'resources', SKILLS_DIR_NAME, skillName);
    if (fs.existsSync(fallbackDir) && fs.statSync(fallbackDir).isDirectory()) {
      logger.info(`SkillRegistry: 渐进式加载回退到内置目录 ${fallbackDir}`);
      readResourcesFromDir(path.resolve(fallbackDir), referencesSections, scriptsList, assetsList);
    }
  }

  logger.info(`SkillRegistry: 渐进式加载 [${skillName}] 参考文档=${referencesSections.length} 脚本=${scriptsList.length} 资源=${assetsList.length}`);
  return { referencesSections, scriptsList, assetsList };
}

/**
 * 将 SKILL.md body 与渐进式加载的资源格式化为返回给模型的完整技能内容
 * 先输出资源摘要与“如何实际使用”的说明，再输出技能说明与参考文档全文
 * @param {string} body - SKILL.md 正文
 * @param {object} resources - { referencesSections, scriptsList, assetsList }
 * @param {{ skillName: string, skillDir: string }} [usageContext] - 用于生成“如何实际使用”说明
 */
function formatProgressiveSkillContent(body, resources, usageContext) {
  const parts = [];

  const refNames = resources.referencesSections.map((r) => r.name);
  const hasRefs = refNames.length > 0;
  const hasScripts = resources.scriptsList.length > 0;
  const hasAssets = resources.assetsList.length > 0;
  if (hasRefs || hasScripts || hasAssets) {
    parts.push('## 本技能已加载的资源与能力\n');
    if (hasRefs) parts.push('- **参考文档**: ' + refNames.join(', '));
    if (hasScripts) parts.push('- **可用脚本**: ' + resources.scriptsList.map((s) => `\`${s}\``).join(', '));
    if (hasAssets) parts.push('- **资源文件**: ' + resources.assetsList.map((s) => `\`${s}\``).join(', '));
    parts.push('');
  }

  if (usageContext && (hasScripts || hasRefs)) {
    parts.push(
      '## 如何实际使用本技能\n\n' +
      '上述参考文档与脚本为**可执行能力**，请根据本技能的说明与参考文档，在用户提出相关需求时：\n' +
      '1. **执行脚本**：以本技能目录为工作目录（cwd）运行 `scripts/` 中对应脚本，按脚本约定传入参数或 stdin。\n' +
      '2. **或按说明执行代码/命令**：根据技能说明与参考文档，在终端中编写并执行相应代码或命令，完成用户任务并返回结果。\n' +
      (usageContext.skillDir ? `\n**技能目录（执行脚本或命令时请设为此 cwd）**: \`${usageContext.skillDir}\`\n` : '')
    );
    parts.push('');
  }

  if (body && body.trim()) {
    parts.push('## 技能说明 (SKILL.md)\n\n' + body.trim());
  }
  if (resources.referencesSections.length > 0) {
    parts.push('## 参考文档全文\n');
    for (const { name, content } of resources.referencesSections) {
      parts.push(`### ${name}\n\n${content.trim()}\n`);
    }
  }
  if (resources.scriptsList.length > 0) {
    parts.push('## 可用脚本\n\n' + resources.scriptsList.map((s) => `- \`${s}\``).join('\n'));
  }
  if (resources.assetsList.length > 0) {
    parts.push('## 资源文件\n\n' + resources.assetsList.map((s) => `- \`${s}\``).join('\n'));
  }
  return parts.length ? parts.join('\n\n') : '[无额外资源]';
}

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
    const resources = loadSkillResources(skillDir, skillName);
    const progressiveContent = formatProgressiveSkillContent(body, resources, {
      skillName,
      skillDir
    });
    const skillContext = {
      skillDir,
      body,
      frontmatter,
      resources: {
        referencesSections: resources.referencesSections,
        scriptsList: resources.scriptsList,
        assetsList: resources.assetsList
      }
    };

    if (!handler) {
      return progressiveContent || `[技能 ${skillName}] 无正文说明。`;
    }

    const h = typeof handler === 'string' ? { type: 'script', path: handler } : handler;
    if (!h || !h.type) {
      return progressiveContent || `[技能 ${skillName}] 无正文说明。`;
    }

    let handlerResult = '';

    if (h.type === 'script' && h.path) {
      const scriptPath = path.resolve(skillDir, h.path);
      if (!scriptPath.startsWith(path.resolve(skillDir))) {
        return `[技能 ${skillName}] handler 路径不允许超出技能目录`;
      }
      if (!fs.existsSync(scriptPath)) {
        return `[技能 ${skillName}] 脚本不存在: ${h.path}`;
      }
      handlerResult = await runScript(scriptPath, skillDir, input);
    } else if (h.type === 'module' && h.path) {
      const modulePath = path.resolve(skillDir, h.path);
      if (!modulePath.startsWith(path.resolve(skillDir))) {
        return `[技能 ${skillName}] handler 路径不允许超出技能目录`;
      }
      try {
        const moduleUrl = pathToFileURL(modulePath).href;
        const mod = await import(moduleUrl);
        const execute = mod.execute ?? mod.default?.execute ?? mod.default;
        if (typeof execute !== 'function') {
          return `[技能 ${skillName}] handler 模块需导出 execute(input, args, skillContext?) => Promise<string>`;
        }
        handlerResult = await execute(input, args, skillContext);
        handlerResult = typeof handlerResult === 'string' ? handlerResult : JSON.stringify(handlerResult);
      } catch (err) {
        logger.error(`Skill ${skillName} module error: ${err.message}`);
        return `执行失败: ${err.message}`;
      }
    } else if (h.type === 'url' && h.url) {
      try {
        const res = await fetch(h.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ skill: skillName, input, arguments: args, skillContext })
        });
        const text = await res.text();
        if (!res.ok) return `远程调用失败 (${res.status}): ${text}`;
        handlerResult = text;
      } catch (err) {
        logger.error(`Skill ${skillName} url error: ${err.message}`);
        return `请求失败: ${err.message}`;
      }
    } else {
      return progressiveContent || `[技能 ${skillName}] 未配置可执行 handler。`;
    }

    return progressiveContent + '\n\n---\n\n## 执行结果\n\n' + handlerResult;
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
  setBundledSkillsRoot,
  loadAll,
  getToolsets,
  refresh,
  listSkills
};
