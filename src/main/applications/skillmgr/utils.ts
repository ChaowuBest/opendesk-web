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
import AdmZip from 'adm-zip';
import { pathToFileURL } from 'url';
import { spawn } from 'child_process';
import { getOpendeskDirectory } from '../../utils/setting.js';
import { Setting } from '../../utils/setting.js';
import { BaseTool, BaseToolset } from '../../aikernel/tool.js';
import { parseAndValidateSkillMd, synthesizeSkillMdFromMetadata } from './skill-schema.js';
import { isSkillEntryFilename, findSkillEntryFile, CANONICAL_SKILL_FILENAME } from './skill-entry.js';
import { logger } from '../../utils/logger.js';
import { getPlatform } from '../../../platforms/base.js';
import { getTempDir } from '../../utils/temp.js';
import {
    allRegistries,
    getRegistry,
    getRegistriesInfo as getRegistryInfoList,
    searchRegistry as searchSingleRegistry,
    getInstallMethod,
    parseInstallUrl,
    type RegistrySkill,
    type SearchOptions,
    type SkillRegistryBase
} from './registry/index.js';

const SKILLS_DIR_NAME = 'skills';
const REFERENCES_DIR = 'references';
const SCRIPTS_DIR = 'scripts';
const ASSETS_DIR = 'assets';
const ZIP_MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;
const GITHUB_ZIP_TIMEOUT_MS = 60000;
const SKILLHUB_DOWNLOAD_URL = 'https://api.skillhub.tencent.com/api/v1/download';
const CLAWHUB_DOWNLOAD_URL = 'https://wry-manatee-359.convex.site/api/v1/download';
const SKILLMGR_BUNDLE_NAME = 'skillmgr';
/** @type {Map<string, { frontmatter: object, body: string, skillDir: string, source?: string }>} */
const skillsCache = new Map();
/** 所有本地技能共用一个 toolset，工具 ID 为 skill-<name>，避免 skill-pdf-pdf 重复 */
let singleSkillToolset = null;
/** 通过 --skillmgr-mount-skill 挂载的额外目录 */
const mountedSkillDirs = new Set();
let hasSkillMgrConfigOverride = false;
let skillMgrConfigOverride = undefined;

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
            if (isSkillEntryFilename(e.name)) continue;
            const content = safeReadFile(path.join(resolvedDir, e.name));
            if (content) intoRefs.push({ name: e.name, content });
        }
    } catch {
        // ignore unreadable optional resource files
    }

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
        } catch {
            // ignore unreadable optional references
        }
    }

    const scriptsDir = path.join(resolvedDir, SCRIPTS_DIR);
    if (fs.existsSync(scriptsDir) && fs.statSync(scriptsDir).isDirectory()) {
        try {
            const list = fs.readdirSync(scriptsDir);
            intoScripts.push(...list.map((name) => `${SCRIPTS_DIR}/${name}`));
        } catch {
            // ignore unreadable optional scripts
        }
    }

    const assetsDirPath = path.join(resolvedDir, ASSETS_DIR);
    if (fs.existsSync(assetsDirPath) && fs.statSync(assetsDirPath).isDirectory()) {
        try {
            const list = fs.readdirSync(assetsDirPath);
            intoAssets.push(...list.map((name) => `${ASSETS_DIR}/${name}`));
        } catch {
            // ignore unreadable optional assets
        }
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
    const appDir = getOpendeskDirectory();
    const skillsDir = path.join(appDir, 'apps', SKILLS_DIR_NAME, 'resources');
    if (!fs.existsSync(skillsDir)) {
        fs.mkdirSync(skillsDir, { recursive: true });
    }
    return skillsDir;
}

function resolveConfiguredSkillPath(rawPath) {
    const trimmed = rawPath.trim();
    if (!trimmed) return undefined;
    if (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
        const home = process.env.HOME || process.env.USERPROFILE;
        if (home) {
            return path.resolve(home, trimmed === '~' ? '' : trimmed.slice(2));
        }
    }
    return path.resolve(trimmed);
}

function uniqueResolvedDirs(dirs) {
    const result = [];
    const seen = new Set();
    for (const dir of dirs) {
        const resolved = typeof dir === 'string' ? resolveConfiguredSkillPath(dir) : undefined;
        if (!resolved || seen.has(resolved)) continue;
        seen.add(resolved);
        result.push(resolved);
    }
    return result;
}

function getConfiguredSkillPathValues() {
    let config;
    if (hasSkillMgrConfigOverride) {
        config = skillMgrConfigOverride;
    } else {
        try {
            config = Setting.getInstance().getApplicationConfig(SKILLMGR_BUNDLE_NAME);
        } catch (e) {
            logger.warn(`SkillRegistry: 读取 skillmgr 配置失败: ${e.message}`);
            return [];
        }
    }

    if (!config || typeof config !== 'object') return [];
    return Array.isArray(config.external_paths) ? config.external_paths : [];
}

function getConfiguredSkillDirectories() {
    return uniqueResolvedDirs(getConfiguredSkillPathValues());
}

function getSkillSearchDirectories() {
    return uniqueResolvedDirs([getSkillsDirectory(), ...getConfiguredSkillDirectories(), ...mountedSkillDirs]);
}

function loadSkillFromDir(skillDir, fallbackName) {
    const skillMdPath = findSkillEntryFile(skillDir);
    if (!skillMdPath) {
        // 兼容仅含 metadata.json 的目录（registry 下载的元数据包）
        const metaPath = path.join(skillDir, 'metadata.json');
        let meta: Record<string, unknown> | null = null;
        try {
            if (fs.existsSync(metaPath) && fs.statSync(metaPath).isFile()) {
                meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            }
        } catch {
            /* ignore */
        }
        if (meta) {
            const synthesized = synthesizeSkillMdFromMetadata(meta);
            if (synthesized) {
                const dirName = fallbackName || path.basename(skillDir);
                const parsed = parseAndValidateSkillMd(synthesized, dirName);
                if (!parsed.valid) {
                    return { success: false, error: `从 metadata.json 推断失败: ${parsed.error}` };
                }
                return {
                    success: true,
                    ...parsed,
                    paramsSchema: { type: 'object', properties: {}, required: [] },
                    _skillDir: skillDir,
                    _synthesized: true,
                    _synthesizedMd: synthesized
                };
            }
        }
        return { success: false, error: `缺少 ${CANONICAL_SKILL_FILENAME}` };
    }

    let raw;
    try {
        raw = fs.readFileSync(skillMdPath, 'utf8');
    } catch (e) {
        return { success: false, error: `读取 ${CANONICAL_SKILL_FILENAME} 失败: ${e.message}` };
    }

    const dirName = fallbackName || path.basename(skillDir);
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
                const res = await getPlatform().fetch(h.url, {
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

/**
 * 将 skill 注册到 cache 和 toolset
 * @param {{ success: boolean, tool: object, name: string, frontmatter: object, body: string, skillDir: string }} result
 * @param {boolean} skipIfExists - 如果已存在则跳过
 * @param {string} source - 来源标识（用于日志）
 * @returns {boolean} 是否成功注册
 */
function registerSkill(result, skipIfExists, source) {
    if (!result.success) return false;
    if (skipIfExists && skillsCache.has(result.name)) {
        logger.info(`SkillRegistry: 跳过已存在技能 ${result.name} (${source})`);
        return false;
    }
    if (skillsCache.has(result.name)) {
        logger.info(`SkillRegistry: 技能 ${result.name} 已存在，跳过 (${source})`);
        return false;
    }
    skillsCache.set(result.name, {
        frontmatter: result.frontmatter,
        body: result.body,
        skillDir: result.skillDir,
        source
    });
    singleSkillToolset.addTool(result.tool);
    logger.info(`SkillRegistry: 已加载技能 ${result.name} (${source})`);
    return true;
}

function loadAll() {
    logger.info('load all skills from local directory');
    const skillsDir = getSkillsDirectory();
    skillsCache.clear();
    singleSkillToolset = new BaseToolset('skill');

    const errors = [];
    const seenConfigSkillDirs = new Set();
    const visitedConfigScanDirs = new Set();

    // 从用户 skills 目录加载
    loadSkillsFromDir(skillsDir, errors, false);

    // 从配置目录加载（只加载，不覆盖已安装的技能）
    for (const configDir of getConfiguredSkillDirectories()) {
        if (path.resolve(configDir) === path.resolve(skillsDir)) continue;
        loadConfiguredSkillSourceDir(configDir, errors, seenConfigSkillDirs, visitedConfigScanDirs);
    }

    // 从 mount 目录加载（只加载，不覆盖已安装的技能）
    for (const mountDir of mountedSkillDirs) {
        const resolved = path.resolve(mountDir);
        if (!fs.existsSync(resolved)) {
            errors.push({ id: resolved, error: `mount 目录不存在` });
            logger.warn(`SkillRegistry: mount 目录不存在: ${resolved}`);
            continue;
        }
        const stat = fs.statSync(resolved);
        if (!stat.isDirectory()) {
            errors.push({ id: resolved, error: `mount 路径不是目录` });
            continue;
        }

        // 检查目录是否直接包含 SKILL.md（单个 skill 目录）
        const skillMdPath = findSkillEntryFile(resolved);
        if (skillMdPath) {
            // 单个 skill 目录
            logger.info(`SkillRegistry: 从 mount 加载单个技能: ${resolved}`);
            const result = loadSkillFromDir(resolved);
            registerSkill(result, true, 'mount');
            if (!result.success) {
                errors.push({ id: resolved, error: result.error });
            }
        } else {
            // skills 目录，扫描子目录
            logger.info(`SkillRegistry: 从 mount 目录加载技能: ${resolved}`);
            loadSkillsFromDir(resolved, errors, true);
        }
    }

    if (errors.length === 0) {
        return { toolsets: [singleSkillToolset], errors: [] };
    }
    return { toolsets: [singleSkillToolset], errors };
}

/**
 * 从配置目录递归加载技能。配置目录允许直接是 skill，也允许包含任意层级的 skill。
 * @param {string} dir - 配置的 skill 扫描目录
 * @param {Array} errors - 错误数组（会被 push）
 * @param {Set<string>} seenSkillDirs - 已发现的配置 skill 目录集合
 * @param {Set<string>} visitedScanDirs - 已扫描的配置目录集合
 */
function loadConfiguredSkillSourceDir(dir, errors, seenSkillDirs, visitedScanDirs) {
    const resolved = path.resolve(dir);
    if (!fs.existsSync(resolved)) {
        errors.push({ id: resolved, error: 'config 目录不存在' });
        logger.warn(`SkillRegistry: config 目录不存在: ${resolved}`);
        return;
    }
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
        errors.push({ id: resolved, error: 'config 路径不是目录' });
        return;
    }

    logger.info(`SkillRegistry: 从 config 目录递归扫描技能: ${resolved}`);
    const skillDirs = collectConfiguredSkillDirectories(resolved, errors, seenSkillDirs, visitedScanDirs);
    for (const skillDir of skillDirs) {
        const result = loadSkillFromDir(skillDir);
        if (!result.success) {
            errors.push({ id: skillDir, error: result.error });
            logger.warn(`SkillRegistry: 跳过 ${skillDir} - ${result.error}`);
            continue;
        }
        registerSkill(result, true, 'config');
    }
}

/**
 * 从配置目录递归收集所有包含 SKILL.md 的 skill 目录。
 * @param {string} dir - 技能目录
 * @param {Array} errors - 错误数组（会被 push）
 * @param {Set<string>} seenSkillDirs - 已发现的 skill 目录集合
 * @param {Set<string>} visitedScanDirs - 已扫描的目录集合
 * @returns {string[]} skill 目录列表
 */
function collectConfiguredSkillDirectories(dir, errors, seenSkillDirs, visitedScanDirs) {
    const resolved = path.resolve(dir);
    if (visitedScanDirs.has(resolved)) return [];
    visitedScanDirs.add(resolved);

    const skillDirs = [];
    try {
        const skillMdPath = findSkillEntryFile(resolved);
        if (skillMdPath && fs.statSync(skillMdPath).isFile() && !seenSkillDirs.has(resolved)) {
            seenSkillDirs.add(resolved);
            skillDirs.push(resolved);
        }
    } catch (e) {
        logger.warn(`SkillRegistry: 检查 ${resolved} 失败: ${e.message}`);
        errors.push({ id: resolved, error: `检查 ${CANONICAL_SKILL_FILENAME} 失败: ${e.message}` });
    }

    let entries = [];
    try {
        entries = fs.readdirSync(resolved, { withFileTypes: true });
    } catch (e) {
        logger.error(`SkillRegistry: 无法读取目录 ${resolved}: ${e.message}`);
        errors.push({ id: resolved, error: e.message });
        return skillDirs;
    }

    for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        skillDirs.push(
            ...collectConfiguredSkillDirectories(path.join(resolved, ent.name), errors, seenSkillDirs, visitedScanDirs)
        );
    }

    return skillDirs;
}

/**
 * 从指定目录加载所有技能。
 * @param {string} dir - 技能目录
 * @param {Array} errors - 错误数组（会被 push）
 * @param {boolean} skipIfExists - 如果技能已存在则跳过（用于 mount 目录）
 */
function loadSkillsFromDir(dir, errors, skipIfExists = false) {
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        logger.error(`SkillRegistry: 无法读取目录 ${dir}: ${e.message}`);
        errors.push({ id: dir, error: e.message });
        return;
    }

    for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const skillDir = path.join(dir, ent.name);
        const result = loadSkillFromDir(skillDir);
        if (result.success) {
            registerSkill(result, skipIfExists, dir);
        } else {
            errors.push({ id: ent.name, error: result.error });
            logger.warn(`SkillRegistry: 跳过 ${ent.name} - ${result.error}`);
        }
    }
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

function setRuntimeConfig(config) {
    hasSkillMgrConfigOverride = true;
    skillMgrConfigOverride = config;
}

function clearRuntimeConfig() {
    hasSkillMgrConfigOverride = false;
    skillMgrConfigOverride = undefined;
}

function listSkills() {
    if (skillsCache.size === 0) loadAll();
    const list = Array.from(skillsCache.entries()).map(([id, s]) => {
        let addedAt = 0;
        try {
            const dirPath = s.skillDir || path.join(getSkillsDirectory(), id);
            if (fs.existsSync(dirPath)) {
                const stat = fs.statSync(dirPath);
                addedAt = (stat.birthtimeMs != null ? stat.birthtimeMs : stat.mtimeMs) || 0;
            }
        } catch {
            // ignore missing filesystem metadata
        }
        return {
            id,
            name: s.frontmatter.name,
            description: s.frontmatter.description ?? '',
            license: s.frontmatter.license,
            compatibility: s.frontmatter.compatibility,
            metadata: s.frontmatter.metadata,
            allowedTools: s.frontmatter['allowed-tools'],
            skillDir: s.source === 'config' ? s.skillDir : undefined,
            source: s.source === 'config' ? 'config' : undefined,
            addedAt
        };
    });
    list.sort((a, b) => b.addedAt - a.addedAt);
    return list.map((item) => {
        const rest = { ...item };
        delete rest.addedAt;
        return rest;
    });
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
 * @returns {{ id: string, name: string, description: string, body: string, skillDir: string, bundleName: string, source?: string, license?: string, compatibility?: string, metadata?: object, allowedTools?: string[], resources: { references: Array<{name: string, content?: string}>, scripts: string[], assets: string[] } } | null}
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
        bundleName: SKILLMGR_BUNDLE_NAME,
        source: skill.source === 'config' ? 'config' : undefined,
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
            fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
            return;
        }
    } catch {
        // fall back to manual recursive cleanup
    }
    try {
        if (fs.statSync(p).isDirectory()) {
            for (const name of fs.readdirSync(p)) rmRecursive(path.join(p, name));
            fs.rmdirSync(p);
        } else {
            fs.unlinkSync(p);
        }
    } catch {
        // ignore cleanup failures
    }
}

/**
 * 从本地目录添加技能：校验 SKILL.md 后复制到用户技能目录
 * @param {string} sourceDir - 源目录（须含 SKILL.md，目录名可与 name 不一致，以 frontmatter name 为准）
 * @param {boolean} force - 是否强制覆盖已存在的同名技能
 * @param {string} [fallbackName] - 回退名称
 * @param {boolean} [refresh=true] - 是否立即刷新全局缓存与 toolset。批量导入时应设为 false，循环结束后统一 refresh()
 * @returns {{ success: boolean, name?: string, error?: string }}
 */
function addSkillFromDirectory(sourceDir, force = false, fallbackName, refresh = true) {
    const resolved = path.resolve(sourceDir);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        return { success: false, error: '源路径不存在或不是目录' };
    }
    const result = loadSkillFromDir(resolved, fallbackName);
    if (!result.success) return { success: false, error: result.error };
    const skillsDir = getSkillsDirectory();
    const originalName = result.name;
    let destDir = path.join(skillsDir, result.name);
    if (fs.existsSync(destDir)) {
        if (force) {
            try {
                if (typeof fs.rmSync === 'function') {
                    fs.rmSync(destDir, { recursive: true, force: true });
                } else {
                    rmRecursive(destDir);
                }
            } catch (e) {
                return { success: false, error: `删除旧技能失败: ${e.message}` };
            }
        } else {
            // 自动重命名：查找下一个可用的名称
            let counter = 1;
            let newName;
            do {
                newName = `${originalName}-${counter}`;
                counter++;
            } while (fs.existsSync(path.join(skillsDir, newName)));
            result.name = newName;
            destDir = path.join(skillsDir, newName);
            logger.info(`SkillRegistry: 技能名冲突，自动重命名为 ${newName}`);
        }
    }
    try {
        copyDirRecursive(resolved, destDir);
        // 从 metadata.json 合成的技能需要落盘 SKILL.md
        if (result._synthesized && result._synthesizedMd) {
            fs.writeFileSync(path.join(destDir, CANONICAL_SKILL_FILENAME), result._synthesizedMd, 'utf8');
        }
        const installedSkillMdPath = findSkillEntryFile(destDir);
        if (installedSkillMdPath && path.basename(installedSkillMdPath) !== CANONICAL_SKILL_FILENAME) {
            fs.renameSync(installedSkillMdPath, path.join(destDir, CANONICAL_SKILL_FILENAME));
        }
        // 自动重命名后同步更新 SKILL.md 内的 name 字段，确保目录名与缓存 key 一致
        if (result.name !== originalName) {
            const skillMdPath = findSkillEntryFile(destDir);
            if (skillMdPath && fs.existsSync(skillMdPath)) {
                try {
                    let content = fs.readFileSync(skillMdPath, 'utf8');
                    content = content.replace(/^name:\s*.+$/m, `name: ${result.name}`);
                    fs.writeFileSync(skillMdPath, content, 'utf8');
                } catch (e) {
                    logger.warn(`SkillRegistry: 更新 SKILL.md name 失败: ${e.message}`);
                }
            }
        }
        if (refresh) {
            loadAll(); // 全量刷新缓存与 toolset
        }
        return { success: true, name: result.name };
    } catch (e) {
        rmRecursive(destDir);
        return { success: false, error: `复制失败: ${e.message}` };
    }
}

/**
 * 删除指定技能（按 id，即目录名）
 * 使用 fs.rmSync 替代手动 rmRecursive，以兼容鸿蒙 HarmonyOS（unlinkSync 后文件句柄缓存等问题）
 * @param {string} skillId - 技能 id（目录名）
 * @param {boolean} [refresh=true] - 是否立即刷新全局缓存与 toolset。批量删除时应设为 false，循环结束后统一 refresh()
 * @returns {{ success: boolean, error?: string }}
 */
function deleteSkill(skillId, refresh = true) {
    if (!skillId || typeof skillId !== 'string') {
        return { success: false, error: '请指定要删除的技能' };
    }
    const safeName = path.basename(skillId).replace(/[/\\]/g, '');
    if (!safeName) return { success: false, error: '无效的技能 id' };
    const skillsDir = path.resolve(getSkillsDirectory());

    // 优先从缓存中获取真实目录路径，解决 skillId 与实际目录名不一致的问题
    // 例如 SKILL.md 中 name 为 resume-cv-assistant，但目录名为 resume-cv-assistant-1
    let targetDir = null;
    if (skillsCache.size === 0) {
        loadAll();
    }
    if (skillsCache.has(safeName)) {
        targetDir = skillsCache.get(safeName).skillDir;
    }

    // 缓存未命中时，按安全名称拼接路径并验证
    if (!targetDir) {
        targetDir = path.resolve(skillsDir, safeName);
    }

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
        // 从缓存中移除（即使 refresh=false 也移除，保证后续 refresh() 不会重新加载已删除的 skill）
        skillsCache.delete(safeName);
        if (refresh) {
            loadAll(); // 全量刷新缓存与 toolset
        }
        return { success: true };
    } catch (e) {
        return { success: false, error: `删除失败: ${e.message}` };
    }
}

/**
 * 检查指定名称的技能是否已安装（先按 skillsDir 目录存在性判断，再回退到 cache）
 * @param {string} skillName - 技能名称
 * @returns {boolean}
 */
function skillExists(skillName) {
    if (!skillName || typeof skillName !== 'string') return false;
    const safeName = path.basename(skillName).replace(/[/\\]/g, '');
    if (!safeName) return false;
    const skillsDir = getSkillsDirectory();
    const targetDir = path.join(skillsDir, safeName);
    if (fs.existsSync(targetDir) && fs.statSync(targetDir).isDirectory()) {
        return true;
    }
    if (skillsCache.size === 0) loadAll();
    return skillsCache.has(safeName);
}

export const SkillRegistry = {
    getSkillsDirectory,
    getBundledSkillsDirectory,
    loadAll,
    getToolsets,
    refresh,
    setRuntimeConfig,
    clearRuntimeConfig,
    listSkills,
    addSkillFromDirectory,
    deleteSkill,
    getSkillBody,
    getSkillDetail,
    skillExists,
    getConfiguredSkillDirectories,
    getSkillSearchDirectories,
    /** 添加 mount 目录（--skillmgr-mount-skill 使用） */
    addMountedDir(dir) {
        const resolved = path.resolve(dir);
        mountedSkillDirs.add(resolved);
        logger.info(`SkillRegistry: 添加 mount 目录 ${resolved}`);
    },
    /** 清除所有 mount 目录 */
    clearMountedDirs() {
        mountedSkillDirs.clear();
    },
    /** 获取所有 mount 目录 */
    getMountedDirs() {
        return Array.from(mountedSkillDirs);
    }
};

export interface InstallSkillResult {
    success: boolean;
    name?: string;
    error?: string;
}

export interface RegistrySearchSkill {
    fullName: string;
    skillName: string;
    skillId: string;
    registryName: string;
    registryLabel: string;
    description: string;
    installUrl?: string;
    author?: string;
    installCount: number;
    downloads?: number;
    stars?: number;
    score?: number;
    canInstall: boolean;
}

export interface RegistrySearchResult {
    results: RegistrySearchSkill[];
    errors: Array<{ registryName: string; error: string }>;
}

export interface RegistryInstallOptions {
    force?: boolean;
    skillsmpApiKey?: string;
    install?: (installUrl: string, force: boolean) => Promise<InstallSkillResult>;
    skillExists?: (skillName: string) => boolean;
}

export const CLAWHUB_INSTALL_PREFIX = 'clawhub:';
export const MATRIX_INSTALL_PREFIX = 'matrix:';
export const MODELSCOPE_INSTALL_PREFIX = 'modelscope:';
export const SKILLHUB_INSTALL_PREFIX = 'skillhub:';

export { allRegistries, getRegistry, getInstallMethod, parseInstallUrl };

export function getRegistriesInfo() {
    return getRegistryInfoList();
}

export async function searchRegistry(registryId: string, opts: SearchOptions = {}) {
    return searchSingleRegistry(registryId, opts);
}

function getZipUncompressedSize(zip: AdmZip): { total: number; error?: string } {
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

function findSkillRootInDir(rootDir: string, relPath?: string | null): string | null {
    if (findSkillEntryFile(rootDir)) {
        return rootDir;
    }

    if (relPath && typeof relPath === 'string') {
        const parts = relPath.split('/').filter(Boolean);
        if (parts.length > 0) {
            const candidate = path.join(rootDir, ...parts);
            if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
                if (findSkillEntryFile(candidate)) return candidate;
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
    } catch {
        // ignore
    }
    return null;
}

function parseGitHubTreeUrl(githubUrl: string): { owner: string; repo: string; branch: string; path: string } | null {
    if (!githubUrl || typeof githubUrl !== 'string') return null;
    const url = githubUrl.trim();
    const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.*?))?(?:\?.*)?$/i);
    if (!m) return null;
    const [, owner, repo, branch, relPath] = m;
    const pathPart = (relPath || '').replace(/\/+$/, '');
    if (!owner || !repo || !branch) return null;
    return { owner, repo, branch, path: pathPart };
}

async function fetchGitHubZipWithFallback(zipUrl: string): Promise<Response> {
    const opts = () => ({ redirect: 'follow' as const, signal: AbortSignal.timeout(GITHUB_ZIP_TIMEOUT_MS) });
    try {
        return await getPlatform().fetch(zipUrl, opts());
    } catch (e: any) {
        const msg = e?.message || String(e);
        if (
            msg.includes('fetch failed') ||
            msg.includes('ECONNREFUSED') ||
            msg.includes('ENOTFOUND') ||
            msg.includes('ETIMEDOUT') ||
            msg.includes('network')
        ) {
            const mirrorUrl = `https://ghproxy.com/${zipUrl}`;
            try {
                return await getPlatform().fetch(mirrorUrl, opts());
            } catch (e2: any) {
                throw new Error(`直连与镜像均失败。直连: ${msg}；镜像: ${e2?.message || e2}`);
            }
        }
        throw e;
    }
}

export function installSkillFromDirectory(
    sourceDir: string,
    force: boolean = false,
    refresh: boolean = true
): InstallSkillResult {
    return SkillRegistry.addSkillFromDirectory(sourceDir, force, undefined, refresh);
}

export function installSkillFromLocalZip(
    zipPath: string,
    skillRelPath?: string,
    force: boolean = false,
    refresh: boolean = true
): InstallSkillResult {
    if (!zipPath || typeof zipPath !== 'string') {
        return { success: false, error: '请选择有效的 zip 文件' };
    }
    const resolved = path.resolve(zipPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        return { success: false, error: '文件不存在或不是文件' };
    }
    if (path.extname(resolved).toLowerCase() !== '.zip') {
        return { success: false, error: '请选择 .zip 格式的压缩包' };
    }

    const tmpDir = path.join(getTempDir(), `skill-zip-${Date.now()}`);
    const safeRelPath = skillRelPath && typeof skillRelPath === 'string' ? skillRelPath.trim() : '';

    try {
        fs.mkdirSync(tmpDir, { recursive: true });
        const zip = new AdmZip(resolved);
        const sizeResult = getZipUncompressedSize(zip);
        if (sizeResult.error) return { success: false, error: sizeResult.error };

        zip.extractAllTo(tmpDir, true);
        const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
        const extractRoot =
            entries.length === 1 && entries[0].isDirectory() ? path.join(tmpDir, entries[0].name) : tmpDir;
        const skillRoot = safeRelPath
            ? findSkillRootInDir(extractRoot, safeRelPath)
            : findSkillRootInDir(extractRoot, null);
        if (!skillRoot) {
            return { success: false, error: '压缩包内未找到含 SKILL.md 的技能目录' };
        }
        return SkillRegistry.addSkillFromDirectory(skillRoot, force, undefined, refresh);
    } catch (e: any) {
        return { success: false, error: e?.message || '解压或添加失败' };
    } finally {
        rmRecursive(tmpDir);
    }
}

export async function installSkillFromUrl(url: string, force: boolean = false): Promise<InstallSkillResult> {
    if (!url || typeof url !== 'string') {
        return { success: false, error: '请提供有效的 URL' };
    }
    const trimmed = url.trim();
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
        return { success: false, error: 'URL 须以 http:// 或 https:// 开头' };
    }

    const tmpDir = path.join(getTempDir(), `skill-download-${Date.now()}`);
    try {
        fs.mkdirSync(tmpDir, { recursive: true });
        const res = await getPlatform().fetch(trimmed, { redirect: 'follow' });
        if (!res.ok) {
            return { success: false, error: `下载失败: ${res.status} ${res.statusText}` };
        }
        const zipBuffer = Buffer.from(await res.arrayBuffer());
        const zipPath = path.join(tmpDir, 'download.zip');
        fs.writeFileSync(zipPath, zipBuffer);
        return installSkillFromLocalZip(zipPath, undefined, force);
    } catch (e: any) {
        return { success: false, error: e?.message || '下载或安装失败' };
    } finally {
        rmRecursive(tmpDir);
    }
}

async function installSkillFromGitHubUrl(githubUrl: string, force: boolean = false): Promise<InstallSkillResult> {
    let parsed = parseGitHubTreeUrl(githubUrl);
    if (!parsed) {
        const repoMatch = githubUrl.trim().match(/github\.com\/([^/]+)\/([^/?#]+)/i);
        if (repoMatch) {
            parsed = { owner: repoMatch[1], repo: repoMatch[2].replace(/\.git$/, ''), branch: 'main', path: '' };
        }
    }
    if (!parsed) {
        return {
            success: false,
            error: '无效的 GitHub 技能 URL'
        };
    }
    const { owner, repo, branch, path: relPath } = parsed;

    const zipUrl = `https://github.com/${owner}/${repo}/archive/refs/heads/${branch}.zip`;
    const tmpDir = path.join(getTempDir(), `skill-registry-github-${Date.now()}`);

    try {
        fs.mkdirSync(tmpDir, { recursive: true });
        const res = await fetchGitHubZipWithFallback(zipUrl);
        if (!res.ok) {
            return { success: false, error: `下载失败: ${res.status} ${res.statusText}` };
        }
        const zipBuffer = Buffer.from(await res.arrayBuffer());
        const zipPath = path.join(tmpDir, 'repo.zip');
        fs.writeFileSync(zipPath, zipBuffer);
        return installSkillFromLocalZip(zipPath, relPath || undefined, force);
    } catch (e: any) {
        return { success: false, error: e?.message || '下载或安装失败' };
    } finally {
        rmRecursive(tmpDir);
    }
}

export async function installSkillFromClawHubSlug(
    slug: string,
    version?: string,
    force: boolean = false
): Promise<InstallSkillResult> {
    if (!slug || typeof slug !== 'string' || !slug.trim()) {
        return { success: false, error: '请提供 ClawHub 技能 slug（如 my-skill）' };
    }
    const safeSlug = slug.trim();
    const params = new URLSearchParams({ slug: safeSlug });
    if (version && String(version).trim()) {
        params.set('version', String(version).trim());
    }
    const downloadUrl = `${CLAWHUB_DOWNLOAD_URL}?${params}`;
    return installSkillFromUrl(downloadUrl, force);
}

export async function installSkillFromMatrixSlug(slug: string, force: boolean = false): Promise<InstallSkillResult> {
    if (!slug || typeof slug !== 'string' || !slug.trim()) {
        return { success: false, error: '请提供 Matrix Skill 的英文名称（如 test-master）' };
    }
    const safeSlug = slug.trim();
    const downloadUrl = `https://matrix.openharmony.cn/api/registry/skill/${encodeURIComponent(safeSlug)}/install?format=zip`;
    return installSkillFromUrl(downloadUrl, force);
}

export async function installSkillFromSkillHubSlug(slug: string, force: boolean = false): Promise<InstallSkillResult> {
    if (!slug || typeof slug !== 'string' || !slug.trim()) {
        return { success: false, error: '请提供 SkillHub 技能 slug' };
    }
    const downloadUrl = `${SKILLHUB_DOWNLOAD_URL}?slug=${encodeURIComponent(slug.trim())}`;
    return installSkillFromUrl(downloadUrl, force);
}

export async function installSkillFromModelScopeSlug(
    slug: string,
    force: boolean = false
): Promise<InstallSkillResult> {
    if (!slug || typeof slug !== 'string' || !slug.trim()) {
        return { success: false, error: '请提供 ModelScope 技能名称' };
    }
    const safeSlug = slug.trim();

    if (safeSlug.includes('/')) {
        const msUrl = `https://www.modelscope.cn/api/v1/skills/${safeSlug}/archive/zip/master`;
        const result = await installSkillFromUrl(msUrl, force);
        if (result.success) return result;
    }

    const nameOnly = safeSlug.includes('/') ? safeSlug.split('/').pop()! : safeSlug;

    const clawhubUrl = `${CLAWHUB_DOWNLOAD_URL}?slug=${encodeURIComponent(nameOnly)}`;
    let result = await installSkillFromUrl(clawhubUrl, force);
    if (result.success) return result;

    const skillhubUrl = `${SKILLHUB_DOWNLOAD_URL}?slug=${encodeURIComponent(nameOnly)}`;
    result = await installSkillFromUrl(skillhubUrl, force);
    if (result.success) return result;

    return { success: false, error: `ModelScope 技能「${safeSlug}」安装失败：所有下载源均不可用` };
}

export async function installFromRegistryInstallUrl(
    installUrl: string,
    force: boolean = false
): Promise<InstallSkillResult> {
    const method = getInstallMethod(installUrl);
    if (['clawhub', 'matrix', 'modelscope', 'skillhub'].includes(method)) {
        const parsed = parseInstallUrl(installUrl);
        if (!parsed) return { success: false, error: `无效的 ${method} installUrl` };
        if (method === 'clawhub') return installSkillFromClawHubSlug(parsed.slug, parsed.version, force);
        if (method === 'matrix') return installSkillFromMatrixSlug(parsed.slug, force);
        if (method === 'modelscope') return installSkillFromModelScopeSlug(parsed.slug, force);
        return installSkillFromSkillHubSlug(parsed.slug, force);
    }
    if (method === 'github') {
        return installSkillFromGitHubUrl(installUrl, force);
    }
    return installSkillFromUrl(installUrl, force);
}

function normalizeRegistryName(registryName: string): SkillRegistryBase | undefined {
    const expected = String(registryName || '')
        .trim()
        .toLowerCase();
    return allRegistries.find(
        (registry) => registry.id.toLowerCase() === expected || registry.label.toLowerCase() === expected
    );
}

function normalizeRegistryToken(value: string): string {
    return String(value || '')
        .trim()
        .toLowerCase();
}

function getRegistrySkillFullName(registry: SkillRegistryBase, skill: RegistrySkill): string {
    return `${registry.id}/${skill.name || skill.id || ''}`;
}

function mapRegistrySkill(registry: SkillRegistryBase, skill: RegistrySkill): RegistrySearchSkill {
    const skillName = String(skill.name || skill.id || '');
    const skillId = String(skill.id || skill.name || '');
    const installCount = Number(skill.downloads ?? 0) || 0;
    return {
        fullName: `${registry.id}/${skillName}`,
        skillName,
        skillId,
        registryName: registry.id,
        registryLabel: registry.label,
        description: String(skill.description || ''),
        installUrl: skill.installUrl || undefined,
        author: skill.author || undefined,
        installCount,
        downloads: skill.downloads,
        stars: skill.stars,
        score: skill.score,
        canInstall: !!skill.canInstall
    };
}

function normalizeRequestedRegistrySkillName(
    registry: SkillRegistryBase,
    skillName: string
): { query: string; error?: string } {
    const raw = String(skillName || '').trim();
    const slash = raw.indexOf('/');
    if (slash <= 0) {
        return { query: raw };
    }

    const prefix = raw.slice(0, slash);
    const prefixedRegistry = normalizeRegistryName(prefix);
    if (!prefixedRegistry) {
        return { query: raw };
    }
    if (prefixedRegistry.id !== registry.id) {
        return {
            query: raw,
            error: `技能全名 ${raw} 属于 ${prefixedRegistry.id}，但请求安装的 Registry 是 ${registry.id}`
        };
    }
    return { query: raw.slice(slash + 1).trim() };
}

function isExactRegistrySkillMatch(registry: SkillRegistryBase, skill: RegistrySkill, query: string): boolean {
    const normalizedQuery = normalizeRegistryToken(query);
    if (!normalizedQuery) return false;
    return [skill.name, skill.id, getRegistrySkillFullName(registry, skill)].some(
        (value) => normalizeRegistryToken(String(value || '')) === normalizedQuery
    );
}

export async function searchSkillsFromAllRegistries(
    keyword: string,
    options: { limit?: number; skillsmpApiKey?: string } = {}
): Promise<RegistrySearchResult> {
    const query = String(keyword || '').trim();
    if (!query) {
        return { results: [], errors: [{ registryName: 'all', error: '请提供技能名称关键字' }] };
    }

    const limit = Math.max(1, Math.min(Number(options.limit) || 20, 100));
    const settled = await Promise.allSettled(
        allRegistries.map(async (registry) => {
            const result = await searchRegistry(registry.id, {
                query,
                page: 1,
                limit,
                apiKey: registry.id === 'skillsmp' ? options.skillsmpApiKey : undefined
            });
            return {
                registry,
                skills: (result.skills || []).map((skill) => mapRegistrySkill(registry, skill))
            };
        })
    );

    const results: RegistrySearchSkill[] = [];
    const errors: Array<{ registryName: string; error: string }> = [];
    for (let i = 0; i < settled.length; i++) {
        const item = settled[i];
        if (item.status === 'fulfilled') {
            results.push(...item.value.skills);
        } else {
            errors.push({
                registryName: allRegistries[i]?.id || 'unknown',
                error: item.reason?.message || String(item.reason)
            });
        }
    }

    results.sort((a, b) => {
        if (b.installCount !== a.installCount) return b.installCount - a.installCount;
        return a.fullName.localeCompare(b.fullName);
    });

    return { results, errors };
}

function scoreRegistrySkillMatch(registry: SkillRegistryBase, skill: RegistrySkill, query: string): number {
    const normalizedQuery = query.toLowerCase();
    const name = String(skill.name || '').toLowerCase();
    const id = String(skill.id || '').toLowerCase();
    const fullName = getRegistrySkillFullName(registry, skill).toLowerCase();
    if (fullName === normalizedQuery) return 110;
    if (name === normalizedQuery || id === normalizedQuery) return 100;
    if (name.endsWith('/' + normalizedQuery) || id.endsWith('/' + normalizedQuery)) return 90;
    if (name.includes(normalizedQuery) || id.includes(normalizedQuery)) return 50;
    return 0;
}

export async function installSkillFromRegistryByName(
    registryName: string,
    skillName: string,
    options: RegistryInstallOptions = {}
): Promise<InstallSkillResult & { registryName?: string; matchedSkill?: string; candidates?: RegistrySearchSkill[] }> {
    const registry = normalizeRegistryName(registryName);
    if (!registry) {
        return { success: false, error: `未知 Registry: ${registryName}` };
    }
    const normalizedRequest = normalizeRequestedRegistrySkillName(registry, skillName);
    if (normalizedRequest.error) {
        return { success: false, error: normalizedRequest.error, registryName: registry.id };
    }
    const query = normalizedRequest.query;
    if (!query) {
        return { success: false, error: '请提供技能名称' };
    }

    const result = await searchRegistry(registry.id, {
        query,
        page: 1,
        limit: 30,
        apiKey: registry.id === 'skillsmp' ? options.skillsmpApiKey : undefined
    });
    const installable = (result.skills || []).filter((skill) => skill.canInstall && skill.installUrl);
    const exactCandidates = installable.filter((skill) => isExactRegistrySkillMatch(registry, skill, query));
    const scoredCandidates = installable
        .map((skill) => ({ skill, score: scoreRegistrySkillMatch(registry, skill, query) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return (b.skill.downloads ?? 0) - (a.skill.downloads ?? 0);
        });

    let matched: RegistrySkill | null = null;
    if (exactCandidates.length === 1) {
        matched = exactCandidates[0];
    } else if (exactCandidates.length > 1) {
        const candidates = exactCandidates.map((skill) => mapRegistrySkill(registry, skill));
        return {
            success: false,
            error: `在 ${registry.label} 中匹配到多个同名技能，请使用 searchSkillFromRegistry 返回的更精确名称`,
            registryName: registry.id,
            candidates
        };
    } else if (installable.length === 1) {
        matched = installable[0];
    } else if (scoredCandidates.length === 1) {
        matched = scoredCandidates[0].skill;
    } else {
        const candidates = (scoredCandidates.length > 0 ? scoredCandidates.map(({ skill }) => skill) : installable)
            .slice(0, 10)
            .map((skill) => mapRegistrySkill(registry, skill));
        return {
            success: false,
            error:
                candidates.length > 0
                    ? `在 ${registry.label} 中匹配到多个技能，请先用 searchSkillFromRegistry 搜索并传入精确 skillName/fullName`
                    : `在 ${registry.label} 中未找到可安装技能: ${query}`,
            registryName: registry.id,
            candidates
        };
    }

    const existingSkillName = String(matched.id || matched.name || '');
    const skillExists = options.skillExists ?? SkillRegistry.skillExists;
    const force = options.force ?? false;
    if (existingSkillName && skillExists(existingSkillName) && !force) {
        return {
            success: false,
            error: `技能「${existingSkillName}」已存在，请设置 force=true 覆盖安装`,
            registryName: registry.id,
            matchedSkill: matched.name || matched.id
        };
    }

    const install = options.install ?? installFromRegistryInstallUrl;
    const installResult = await install(matched.installUrl, force);
    return {
        ...installResult,
        registryName: registry.id,
        matchedSkill: matched.name || matched.id
    };
}
