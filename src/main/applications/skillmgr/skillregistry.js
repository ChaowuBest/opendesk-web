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
import { BaseTool, BaseToolset } from '../../aikernel/tool.js';
import { parseAndValidateSkillMd, SKILL_MD_FILENAME } from './skill-schema.js';
import { logger } from '../../utils/logger.js';

const SKILLS_DIR_NAME = 'skills';
const REFERENCES_DIR = 'references';
const SCRIPTS_DIR = 'scripts';
const ASSETS_DIR = 'assets';

/** zip 解压体积上限：500MB，防止 zip 炸弹或过大技能包 */
const ZIP_MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;

/**
 * 计算 zip 内所有文件的解压后体积之和（不含目录条目），超限或无法解析时返回 error
 * @param {InstanceType<typeof AdmZip>} zip - AdmZip 实例
 * @returns {{ total: number, error?: string }}
 */
function getZipUncompressedSize(zip) {
    const entries = zip.getEntries();
    let total = 0;
    for (const e of entries) {
        if (e.isDirectory) continue;
        const size = e.header && typeof e.header.size === 'number' ? e.header.size : null;
        if (size == null || size < 0) {
            return { total: 0, error: '压缩包包含无法解析体积的条目，拒绝解压' };
        }
        total += size;
        if (total > ZIP_MAX_UNCOMPRESSED_BYTES) {
            return {
                total,
                error: `解压后体积超过限制（${(ZIP_MAX_UNCOMPRESSED_BYTES / 1024 / 1024).toFixed(0)}MB），当前约 ${(total / 1024 / 1024).toFixed(1)}MB`
            };
        }
    }
    return { total };
}

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

    logger.info(
        `SkillRegistry: 渐进式加载 [${skillName}] 参考文档=${referencesSections.length} 脚本=${scriptsList.length} 资源=${assetsList.length}`
    );
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
                (usageContext.skillDir
                    ? `\n**技能目录（执行脚本或命令时请设为此 cwd）**: \`${usageContext.skillDir}\`\n`
                    : '')
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

function loadSkillFromDir(skillDir) {
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

    const parsed = parseAndValidateSkillMd(raw);
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
            input: {
                type: 'string',
                description: '可选：当前任务或用户输入摘要，供技能执行时参考'
            }
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
                    body: JSON.stringify({
                        skill: skillName,
                        input,
                        arguments: args,
                        skillContext
                    })
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
        child.stdout?.on('data', (ch) => {
            stdout += ch;
        });
        child.stderr?.on('data', (ch) => {
            stderr += ch;
        });
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
    logger.info('load all skills from local directory');
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
        const result = loadSkillFromDir(skillDir);
        if (result.success) {
            skillsCache.set(result.name, {
                frontmatter: result.frontmatter,
                body: result.body,
                skillDir: result.skillDir
            });
            singleSkillToolset.addTool(result.tool);
            logger.info(`SkillRegistry: 已加载技能 ${result.name} (Anthropic Agent Skills) 并注册到 aikernel`);
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
    list.sort((a, b) => b.addedAt - a.addedAt);
    return list.map(({ addedAt, ...rest }) => rest);
}

/**
 * 获取指定技能的完整 body（老格式）
 * @param {string} skillId - 技能 id
 * @returns {{ frontmatter: object, body: string, skillDir: string } | null}
 */
function getSkillBody(skillId) {
    if (skillsCache.size === 0) loadAll();
    const skill = skillsCache.get(skillId);
    return skill || null;
}

/**
 * 获取技能的完整详情，包括资源列表
 * @param {string} skillId - 技能 id
 * @returns {{ id: string, name: string, description: string, body: string, skillDir: string, license?: string, compatibility?: string, metadata?: object, allowedTools?: string[], resources: { references: Array<{name: string, content?: string}>, scripts: string[], assets: string[] } } | null}
 */
function getSkillDetail(skillId) {
    if (skillsCache.size === 0) loadAll();
    const skill = skillsCache.get(skillId);
    if (!skill) return null;

    const { frontmatter, body, skillDir } = skill;
    const resources = loadSkillResources(skillDir, frontmatter.name);

    return {
        id: skillId,
        name: frontmatter.name,
        description: frontmatter.description ?? '',
        body,
        skillDir,
        license: frontmatter.license,
        compatibility: frontmatter.compatibility,
        metadata: frontmatter.metadata,
        allowedTools: frontmatter['allowed-tools'],
        resources: {
            references: resources.referencesSections,
            scripts: resources.scriptsList,
            assets: resources.assetsList
        }
    };
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

/** 递归删除目录或文件；优先使用 fs.rmSync 以兼容鸿蒙 HarmonyOS */
function rmRecursive(p) {
    if (!fs.existsSync(p)) return;
    try {
        if (typeof fs.rmSync === 'function') {
            fs.rmSync(p, { recursive: true, force: true });
            return;
        }
    } catch (_) {}
    if (fs.statSync(p).isDirectory()) {
        for (const name of fs.readdirSync(p)) rmRecursive(path.join(p, name));
        fs.rmdirSync(p);
    } else {
        fs.unlinkSync(p);
    }
}

/**
 * 在目录内递归查找包含 SKILL.md 的子目录（优先匹配 relPath 相对路径）
 * @param {string} rootDir - 解压根目录（如 skills-main）
 * @param {string} [relPath] - 可选，GitHub 中的相对路径（如 skills/pdf）
 * @returns {string|null}
 */
function findSkillRootInDir(rootDir, relPath) {
    const skillMdAt = path.join(rootDir, SKILL_MD_FILENAME);
    if (fs.existsSync(skillMdAt) && fs.statSync(skillMdAt).isFile()) {
        return rootDir;
    }
    if (relPath && typeof relPath === 'string') {
        const parts = relPath.split('/').filter(Boolean);
        if (parts.length > 0) {
            const candidate = path.join(rootDir, ...parts);
            if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
                const md = path.join(candidate, SKILL_MD_FILENAME);
                if (fs.existsSync(md)) return candidate;
            }
        }
    }
    try {
        const entries = fs.readdirSync(rootDir, { withFileTypes: true });
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            const sub = path.join(rootDir, e.name);
            const found = findSkillRootInDir(sub, null);
            if (found) return found;
        }
    } catch (_) {}
    return null;
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
    const result = loadSkillFromDir(resolved);
    if (!result.success) return { success: false, error: result.error };
    const skillsDir = getSkillsDirectory();
    const destDir = path.join(skillsDir, result.name);
    if (fs.existsSync(destDir)) {
        return { success: false, error: `技能 "${result.name}" 已存在，请先删除或改用其它名称` };
    }
    try {
        copyDirRecursive(resolved, destDir);
        loadAll(); // loadAll 会处理注册到 aikernel
        return { success: true, name: result.name };
    } catch (e) {
        rmRecursive(destDir);
        return { success: false, error: `复制失败: ${e.message}` };
    }
}

/**
 * 从本地 zip 文件添加技能：解压到临时目录，查找含 SKILL.md 的根后复制到用户技能目录
 * @param {string} zipPath - 本地 .zip 文件路径
 * @param {{ skillRelPath?: string }} [opts] - 可选，GitHub 安装时传入技能相对路径（如 skills/canvas-design），用于在整仓 zip 中定位
 * @returns {{ success: boolean, name?: string, error?: string }}
 */
function addSkillFromZipPath(zipPath, opts = {}) {
    if (!zipPath || typeof zipPath !== 'string') {
        return { success: false, error: '请选择有效的 zip 文件' };
    }
    const resolved = path.resolve(zipPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        return { success: false, error: '文件不存在或不是文件' };
    }
    const ext = path.extname(resolved).toLowerCase();
    if (ext !== '.zip') {
        return { success: false, error: '请选择 .zip 格式的压缩包' };
    }
    const tmpDir = path.join(os.tmpdir(), `skill-zip-${Date.now()}`);
    const skillRelPath = opts.skillRelPath && typeof opts.skillRelPath === 'string' ? opts.skillRelPath.trim() : null;
    try {
        fs.mkdirSync(tmpDir, { recursive: true });
        const zip = new AdmZip(resolved);
        const uncompressedSize = getZipUncompressedSize(zip);
        if (uncompressedSize.error) {
            return { success: false, error: uncompressedSize.error };
        }
        zip.extractAllTo(tmpDir, true);
        const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
        const extractRoot =
            entries.length === 1 && entries[0].isDirectory() ? path.join(tmpDir, entries[0].name) : tmpDir;
        const skillRoot = skillRelPath
            ? findSkillRootInDir(extractRoot, skillRelPath)
            : fs.existsSync(path.join(tmpDir, SKILL_MD_FILENAME))
              ? tmpDir
              : findSkillRootInDir(tmpDir, null);
        if (!skillRoot && skillRelPath) {
            const anySkill = findSkillRootInDir(extractRoot, null);
            if (anySkill) {
                return {
                    success: false,
                    error: `压缩包内路径 "${skillRelPath}" 未找到技能，但发现其它技能目录。请检查 URL`
                };
            }
        }
        if (!skillRoot) {
            return { success: false, error: '压缩包内未找到含 SKILL.md 的技能目录' };
        }
        return addSkillFromPath(skillRoot);
    } catch (e) {
        return { success: false, error: e.message || '解压或添加失败' };
    } finally {
        if (fs.existsSync(tmpDir)) rmRecursive(tmpDir);
    }
}

/**
 * 解析 GitHub 树形 URL 为 { owner, repo, branch, path }
 * 如 https://github.com/anthropics/skills/tree/main/skills/pdf -> { owner, repo, branch, path: 'skills/pdf' }
 * @param {string} githubUrl - GitHub tree 或 blob URL
 * @returns {{ owner: string, repo: string, branch: string, path: string } | null}
 */
function parseGitHubTreeUrl(githubUrl) {
    if (!githubUrl || typeof githubUrl !== 'string') return null;
    const m = githubUrl.trim().match(/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.*)/i);
    if (!m) return null;
    const [, owner, repo, branch, relPath] = m;
    const pathPart = (relPath || '').replace(/\/+$/, '');
    if (!owner || !repo || !branch) return null;
    return { owner, repo, branch, path: pathPart };
}

/**
 * 从 GitHub 树形 URL 添加技能：下载仓库 zip，解压后定位到技能目录并安装
 * @param {string} githubUrl - 如 https://github.com/anthropics/skills/tree/main/skills/pdf
 * @returns {Promise<{ success: boolean, name?: string, error?: string }>}
 */
const GITHUB_ZIP_TIMEOUT_MS = 60000;

async function fetchWithFallback(zipUrl) {
    const opts = () => ({ redirect: 'follow', signal: AbortSignal.timeout(GITHUB_ZIP_TIMEOUT_MS) });
    try {
        return await fetch(zipUrl, opts());
    } catch (e) {
        const msg = e?.message || String(e);
        if (
            msg.includes('fetch failed') ||
            msg.includes('ECONNREFUSED') ||
            msg.includes('ENOTFOUND') ||
            msg.includes('ETIMEDOUT') ||
            msg.includes('network')
        ) {
            const mirrorUrl = `https://ghproxy.com/${zipUrl}`;
            logger.info(`SkillRegistry: 直连 GitHub 失败，尝试镜像 ${mirrorUrl}`);
            try {
                return await fetch(mirrorUrl, opts());
            } catch (e2) {
                throw new Error(`直连与镜像均失败。直连: ${msg}；镜像: ${e2?.message || e2}`);
            }
        }
        throw e;
    }
}

async function addSkillFromGitHubUrl(githubUrl) {
    const parsed = parseGitHubTreeUrl(githubUrl);
    if (!parsed) {
        return {
            success: false,
            error: '无效的 GitHub 技能 URL，需为 tree 格式：https://github.com/owner/repo/tree/branch/path'
        };
    }
    const { owner, repo, branch, path: relPath } = parsed;
    if (!relPath || !relPath.trim()) {
        return {
            success: false,
            error: 'GitHub URL 须包含技能路径，如 .../tree/main/skills/pdf。当前 URL 可能缺少路径：' + githubUrl
        };
    }
    const zipUrl = `https://github.com/${owner}/${repo}/archive/refs/heads/${branch}.zip`;
    const tmpDir = path.join(os.tmpdir(), `skill-github-${Date.now()}`);
    try {
        fs.mkdirSync(tmpDir, { recursive: true });
        const res = await fetchWithFallback(zipUrl);
        if (!res.ok) {
            return { success: false, error: `下载失败: ${res.status} ${res.statusText}` };
        }
        const buf = Buffer.from(await res.arrayBuffer());
        const zip = new AdmZip(buf);
        const uncompressedSize = getZipUncompressedSize(zip);
        if (uncompressedSize.error) {
            return { success: false, error: uncompressedSize.error };
        }
        zip.extractAllTo(tmpDir, true);
        const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
        const extractRoot =
            entries.length === 1 && entries[0].isDirectory() ? path.join(tmpDir, entries[0].name) : tmpDir;
        let skillRoot = findSkillRootInDir(extractRoot, relPath);
        if (!skillRoot && relPath) {
            const anySkill = findSkillRootInDir(extractRoot, null);
            if (anySkill) {
                return {
                    success: false,
                    error: `仓库内路径 "${relPath}" 未找到技能，但发现其它技能目录。请检查 skill0 返回的 URL 是否正确：${githubUrl}`
                };
            }
        }
        if (!skillRoot && !relPath) {
            skillRoot = findSkillRootInDir(extractRoot, null);
        }
        if (!skillRoot) {
            return { success: false, error: '仓库内未找到含 SKILL.md 的技能目录' };
        }
        return addSkillFromPath(skillRoot);
    } catch (e) {
        return { success: false, error: e.message || '下载或解压失败' };
    } finally {
        if (fs.existsSync(tmpDir)) rmRecursive(tmpDir);
    }
}

/**
 * 从 URL 添加技能：下载 zip 并解压，查找含 SKILL.md 的根后复制到用户技能目录
 * @param {string} url - 技能包 zip 的 URL
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
        const uncompressedSize = getZipUncompressedSize(zip);
        if (uncompressedSize.error) {
            return { success: false, error: uncompressedSize.error };
        }
        zip.extractAllTo(tmpDir, true);
        const skillRoot = fs.existsSync(path.join(tmpDir, SKILL_MD_FILENAME))
            ? tmpDir
            : findSkillRootInDir(tmpDir, null);
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
 * 通过 ClawHub CLI 按 slug（及可选版本）安装技能，参考 clawhub install my-skill [--version 1.2.3]
 * 需已安装 clawhub：npm i -g clawhub。在临时目录执行 npx clawhub install，再从输出目录查找 SKILL.md 并复制到用户技能目录。
 * @param {string} slug - 技能 slug（如 my-skill）
 * @param {string} [version] - 可选版本号
 * @returns {Promise<{ success: boolean, name?: string, error?: string }>}
 */
async function addSkillFromClawHubSlug(slug, version) {
    if (!slug || typeof slug !== 'string' || !slug.trim()) {
        return { success: false, error: '请提供 ClawHub 技能 slug（如 my-skill）' };
    }
    const safeSlug = slug.trim();
    const tmpDir = path.join(os.tmpdir(), `skill-clawhub-${Date.now()}`);
    try {
        fs.mkdirSync(tmpDir, { recursive: true });
        const args = ['clawhub', 'install', safeSlug];
        if (version && String(version).trim()) args.push('--version', String(version).trim());
        const run = () =>
            new Promise((resolve, reject) => {
                const child = spawn('npx', args, {
                    cwd: tmpDir,
                    shell: process.platform === 'win32',
                    stdio: ['ignore', 'pipe', 'pipe']
                });
                let stdout = '';
                let stderr = '';
                child.stdout?.on('data', (ch) => {
                    stdout += ch;
                });
                child.stderr?.on('data', (ch) => {
                    stderr += ch;
                });
                child.on('error', (err) => reject(err));
                child.on('close', (code) => resolve({ code, stdout, stderr }));
            });
        const timeoutMs = 120000;
        const race = Promise.race([
            run(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('ClawHub 安装超时（2 分钟）')), timeoutMs))
        ]);
        const { code, stderr } = await race;
        if (code !== 0) {
            const msg = (stderr || '').trim() || `退出码 ${code}`;
            return { success: false, error: `ClawHub 安装失败: ${msg}` };
        }
        const skillRoot = findSkillRootInDir(tmpDir, null);
        if (!skillRoot) {
            return {
                success: false,
                error: 'ClawHub 安装后未在输出目录中找到 SKILL.md，请确认 slug 正确且已安装 clawhub（npm i -g clawhub）'
            };
        }
        const addResult = addSkillFromPath(skillRoot);
        return addResult;
    } catch (e) {
        return { success: false, error: e.message || 'ClawHub 安装异常' };
    } finally {
        if (fs.existsSync(tmpDir)) rmRecursive(tmpDir);
    }
}

/**
 * 删除指定技能（按 id，即目录名）
 * 使用 fs.rmSync 替代手动 rmRecursive，以兼容鸿蒙 HarmonyOS（unlinkSync 后文件句柄缓存等问题）
 * @param {string} skillId - 技能 id（目录名）
 * @returns {{ success: boolean, error?: string }}
 */
function deleteSkill(skillId) {
    if (!skillId || typeof skillId !== 'string') {
        return { success: false, error: '请指定要删除的技能' };
    }
    const safeName = path.basename(skillId).replace(/[/\\]/g, '');
    if (!safeName) return { success: false, error: '无效的技能 id' };
    const skillsDir = path.resolve(getSkillsDirectory());
    const targetDir = path.resolve(skillsDir, safeName);
    const relative = path.relative(skillsDir, targetDir);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return { success: false, error: '无效的技能路径' };
    }
    if (!fs.existsSync(targetDir)) {
        return { success: false, error: `技能 "${safeName}" 不存在` };
    }
    try {
        if (typeof fs.rmSync === 'function') {
            fs.rmSync(targetDir, { recursive: true, force: true });
        } else {
            rmRecursive(targetDir);
        }
        loadAll(); // loadAll 会重新加载并处理 aikernel 注册
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
    addSkillFromZipPath,
    addSkillFromUrl,
    addSkillFromGitHubUrl,
    addSkillFromClawHubSlug,
    parseGitHubTreeUrl,
    deleteSkill,
    getSkillBody,
    getSkillDetail
};
