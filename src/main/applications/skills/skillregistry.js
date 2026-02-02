/**
 * 本地 Agent Skills 注册表：对齐 Anthropic Agent Skills 标准（agentskills.io）
 * 扫描端侧 skills 目录下的 SKILL.md，解析 YAML frontmatter，每个技能暴露为一个 tool 供主进程对话调用
 */

import path from 'path';
import fs from 'fs';
import { pathToFileURL } from 'url';
import { spawn } from 'child_process';
import os from 'os';
import AdmZip from 'adm-zip';
import { getAppDirectory } from '../../utils/setting.js';
import { BaseTool, BaseToolset } from '../../agents/tool.js';
import { parseAndValidateSkillMd, SKILL_MD_FILENAME } from './skill-schema.js';
import { logger } from '../../utils/logger.js';

const SKILLS_DIR_NAME = 'skills';
const REFERENCES_DIR = 'references';
const SCRIPTS_DIR = 'scripts';
const ASSETS_DIR = 'assets';

/** @type {Map<string, { frontmatter: object, body: string, skillDir: string }>} */
const skillsCache = new Map();
/** 所有本地技能共用一个 toolset，工具 ID 为 skill-<name>，避免 skill-pdf-pdf 重复 */
let singleSkillToolset = null;

const __skillsDir = import.meta.dirname;

/**
 * 返回内置技能根目录（用于安装到用户目录及渐进式加载回退）
 * 开发时：与 skillregistry 同级的 resources；打包后：main 输出目录下的 applications/skills/resources
 * @returns {string}
 */
function getBundledSkillsDirectory() {
  const nextToModule = path.join(__skillsDir, 'resources');
  if (fs.existsSync(nextToModule)) return nextToModule;
  return path.join(__skillsDir, 'applications', 'skills', 'resources');
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
 * 渐进式加载技能资源：在技能被调用时读取 references、scripts、assets 等
 */
function loadSkillResources(skillDir, skillName) {
  const referencesSections = [];
  const scriptsList = [];
  const assetsList = [];

  const resolvedDir = path.resolve(skillDir);
  readResourcesFromDir(resolvedDir, referencesSections, scriptsList, assetsList);

  const hadAny = referencesSections.length > 0 || scriptsList.length > 0 || assetsList.length > 0;
  if (!hadAny && skillName) {
    const fallbackDir = path.join(getBundledSkillsDirectory(), skillName);
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

/** 用户技能目录：与其它应用一致，放在 apps/skills/resources 下 */
function getSkillsDirectory() {
  const appDir = getAppDirectory();
  const skillsDir = path.join(appDir, 'apps', SKILLS_DIR_NAME, 'resources');
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }
  return skillsDir;
}

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

  return {
    success: true,
    tool,
    name,
    body,
    frontmatter,
    skillDir
  };
}

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

function loadAll() {
  const skillsDir = getSkillsDirectory();
  skillsCache.clear();
  singleSkillToolset = new BaseToolset('skill');

  const errors = [];

  let entries = [];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch (e) {
    logger.error(`SkillRegistry: 无法读取目录 ${skillsDir}: ${e.message}`);
    return { toolsets: [], errors: [{ id: '', error: e.message }] };
  }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const skillDir = path.join(skillsDir, ent.name);
    const result = loadSkillFromDir(skillDir, ent.name);
    if (result.success) {
      skillsCache.set(result.name, {
        frontmatter: result.frontmatter,
        body: result.body,
        skillDir: result.skillDir
      });
      singleSkillToolset.addTool(result.tool);
      logger.info(`SkillRegistry: 已加载技能 ${result.name} (Anthropic Agent Skills)`);
    } else {
      errors.push({ id: ent.name, error: result.error });
      logger.warn(`SkillRegistry: 跳过 ${ent.name} - ${result.error}`);
    }
  }

  return { toolsets: [singleSkillToolset], errors };
}

function getToolsets() {
  if (singleSkillToolset === null || skillsCache.size === 0) {
    const { toolsets } = loadAll();
    return toolsets;
  }
  return [singleSkillToolset];
}

function refresh() {
  return loadAll();
}

function listSkills() {
  if (skillsCache.size === 0) loadAll();
  const skillsDir = getSkillsDirectory();
  const list = Array.from(skillsCache.entries()).map(([id, s]) => {
    let addedAt = 0;
    try {
      const dirPath = path.join(skillsDir, id);
      if (fs.existsSync(dirPath)) {
        const stat = fs.statSync(dirPath);
        addedAt = (stat.birthtimeMs != null ? stat.birthtimeMs : stat.mtimeMs) || 0;
      }
    } catch (_) {}
    return {
      id,
      name: s.frontmatter.name,
      description: s.frontmatter.description ?? '',
      license: s.frontmatter.license,
      compatibility: s.frontmatter.compatibility,
      metadata: s.frontmatter.metadata,
      allowedTools: s.frontmatter['allowed-tools'],
      addedAt
    };
  });
  list.sort((a, b) => (b.addedAt - a.addedAt));
  return list.map(({ addedAt, ...rest }) => rest);
}

/** 递归复制目录 */
function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** 递归删除目录或文件 */
function rmRecursive(p) {
  if (!fs.existsSync(p)) return;
  if (fs.statSync(p).isDirectory()) {
    for (const name of fs.readdirSync(p)) rmRecursive(path.join(p, name));
    fs.rmdirSync(p);
  } else fs.unlinkSync(p);
}

/**
 * 从本地目录添加技能：校验 SKILL.md 后复制到用户技能目录
 * @param {string} sourceDir - 源目录（须含 SKILL.md，目录名可与 name 不一致，以 frontmatter name 为准）
 * @returns {{ success: boolean, name?: string, error?: string }}
 */
function addSkillFromPath(sourceDir) {
  const resolved = path.resolve(sourceDir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return { success: false, error: '源路径不存在或不是目录' };
  }
  const result = loadSkillFromDir(resolved, path.basename(resolved));
  if (!result.success) return { success: false, error: result.error };
  const skillsDir = getSkillsDirectory();
  const destDir = path.join(skillsDir, result.name);
  if (fs.existsSync(destDir)) {
    return { success: false, error: `技能 "${result.name}" 已存在，请先删除或改用其它名称` };
  }
  try {
    copyDirRecursive(resolved, destDir);
    loadAll();
    return { success: true, name: result.name };
  } catch (e) {
    rmRecursive(destDir);
    return { success: false, error: `复制失败: ${e.message}` };
  }
}

/**
 * 从 URL 添加技能：下载 zip 并解压，查找含 SKILL.md 的根后复制到用户技能目录
 * @param {string} url - 技能包 zip 的 URL（如 GitHub archive）
 * @returns {Promise<{ success: boolean, name?: string, error?: string }>}
 */
async function addSkillFromUrl(url) {
  if (!url || typeof url !== 'string') {
    return { success: false, error: '请提供有效的 URL' };
  }
  const trimmed = url.trim();
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return { success: false, error: 'URL 须以 http:// 或 https:// 开头' };
  }
  const tmpDir = path.join(os.tmpdir(), `skill-download-${Date.now()}`);
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const res = await fetch(trimmed, { redirect: 'follow' });
    if (!res.ok) {
      return { success: false, error: `下载失败: ${res.status} ${res.statusText}` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const zip = new AdmZip(buf);
    zip.extractAllTo(tmpDir, true);
    const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
    let skillRoot = null;
    if (entries.length === 1 && entries[0].isDirectory()) {
      const sub = path.join(tmpDir, entries[0].name);
      if (fs.existsSync(path.join(sub, SKILL_MD_FILENAME))) skillRoot = sub;
    }
    if (!skillRoot && fs.existsSync(path.join(tmpDir, SKILL_MD_FILENAME))) {
      skillRoot = tmpDir;
    }
    if (!skillRoot) {
      return { success: false, error: '压缩包内未找到含 SKILL.md 的技能目录' };
    }
    const addResult = addSkillFromPath(skillRoot);
    return addResult;
  } catch (e) {
    return { success: false, error: e.message || '下载或解压失败' };
  } finally {
    if (fs.existsSync(tmpDir)) rmRecursive(tmpDir);
  }
}

/**
 * 删除指定技能（按 id，即目录名）
 * @param {string} skillId - 技能 id（目录名）
 * @returns {{ success: boolean, error?: string }}
 */
function deleteSkill(skillId) {
  if (!skillId || typeof skillId !== 'string') {
    return { success: false, error: '请指定要删除的技能' };
  }
  const safeName = path.basename(skillId).replace(/[/\\]/g, '');
  if (!safeName) return { success: false, error: '无效的技能 id' };
  const skillsDir = getSkillsDirectory();
  const targetDir = path.join(skillsDir, safeName);
  if (!fs.existsSync(targetDir)) {
    return { success: false, error: `技能 "${safeName}" 不存在` };
  }
  try {
    rmRecursive(targetDir);
    loadAll();
    return { success: true };
  } catch (e) {
    return { success: false, error: `删除失败: ${e.message}` };
  }
}

export const SkillRegistry = {
  getSkillsDirectory,
  getBundledSkillsDirectory,
  loadAll,
  getToolsets,
  refresh,
  listSkills,
  addSkillFromPath,
  addSkillFromUrl,
  deleteSkill
};
