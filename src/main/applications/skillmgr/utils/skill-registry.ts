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
 * SkillRegistry：本地 Agent Skills 注册表（对齐 Anthropic Agent Skills 标准 agentskills.io）
 * 负责从各技能来源目录扫描加载 SKILL.md、注册工具、提供技能查询与详情。
 * 技能安装 / 卸载由 SkillInstallManager 负责，见 skill-installer.ts。
 */

import path from 'path';
import fs from 'fs';
import { pathToFileURL } from 'url';
import { spawn } from 'child_process';
import { getOpendeskDirectory, Setting } from '../../../utils/setting.js';
import { BaseTool, BaseToolset } from '../../../aikernel/tool.js';
import { parseAndValidateSkillMd, synthesizeSkillMdFromMetadata } from '../skill-schema.js';
import { isSkillEntryFilename, findSkillEntryFile, CANONICAL_SKILL_FILENAME } from '../skill-entry.js';
import { logger } from '../../../utils/logger.js';
import { getPlatform } from '../../../../platforms/base.js';

const SKILLS_DIR_NAME = 'skills';
const REFERENCES_DIR = 'references';
const SCRIPTS_DIR = 'scripts';
const ASSETS_DIR = 'assets';
const SKILLMGR_BUNDLE_NAME = 'skillmgr';

/**
 * 技能来源分类：
 * - installed：用户安装的技能（apps/skills/resources），唯一会落盘的分类
 * - config：external_paths 配置目录（只加载，不覆盖已安装的技能）
 * - mounted：--skillmgr-mount-skill 挂载目录（只加载，不覆盖已安装的技能）
 * - plugin：插件中的技能（预留，未来使用）
 * 注：随安装包分发的内置技能（resources/skills）由 builtin 应用独立加载，
 * 不进入本注册表，避免在技能中心「已安装」与输入自动补全中出现重复条目。
 */
export type SkillSource = 'installed' | 'config' | 'mounted' | 'plugin';

interface SkillCacheEntry {
    frontmatter: Record<string, unknown>;
    body: string;
    skillDir: string;
    source: SkillSource;
}

/** 模块私有：递归删除目录或文件；优先使用 fs.rmSync 以兼容鸿蒙 HarmonyOS */
function rmRecursive(p: string): void {
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
 * 模块私有：从指定目录读取参考文档与脚本列表（不修改传入的 arrays，返回合并结果）
 */
function readResourcesFromDir(
    resolvedDir: string,
    intoRefs: Array<{ name: string; content: string }>,
    intoScripts: string[],
    intoAssets: string[]
): void {
    const safeReadFile = (filePath: string) => {
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

/** 模块私有：~ 展开为 home 目录 */
function resolveConfiguredSkillPath(rawPath: string): string | undefined {
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

function uniqueResolvedDirs(dirs: string[]): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const dir of dirs) {
        const resolved = typeof dir === 'string' ? resolveConfiguredSkillPath(dir) : undefined;
        if (!resolved || seen.has(resolved)) continue;
        seen.add(resolved);
        result.push(resolved);
    }
    return result;
}

export class SkillRegistry {
    /** 单例实例 */
    static getInstance(): SkillRegistry {
        if (!SkillRegistry._instance) SkillRegistry._instance = new SkillRegistry();
        return SkillRegistry._instance;
    }

    private static _instance: SkillRegistry | null = null;

    private readonly skillsCache = new Map<string, SkillCacheEntry>();
    /** 所有本地技能共用一个 toolset，工具 ID 为 skill-<name>，避免 skill-pdf-pdf 重复 */
    private singleSkillToolset: BaseToolset | null = null;
    /** 通过 --skillmgr-mount-skill 挂载的额外目录 */
    private readonly mountedSkillDirs = new Set<string>();
    private hasSkillMgrConfigOverride = false;
    private skillMgrConfigOverride: unknown = undefined;

    private readonly __skillsDir = import.meta.dirname;

    // ── 目录 ──────────────────────────────────────────────────────────────

    /** 用户技能目录：与其它应用一致，放在 apps/skills/resources 下 */
    getSkillsDirectory(): string {
        const appDir = getOpendeskDirectory();
        const skillsDir = path.join(appDir, 'apps', SKILLS_DIR_NAME, 'resources');
        if (!fs.existsSync(skillsDir)) {
            fs.mkdirSync(skillsDir, { recursive: true });
        }
        return skillsDir;
    }

    /**
     * 返回内置技能根目录（用于安装到用户目录及渐进式加载回退）
     * 开发时：skillmgr/resources；打包后：main 输出目录下的 applications/skills/resources
     */
    getBundledSkillsDirectory(): string {
        const nextToModule = path.join(this.__skillsDir, '..', 'resources');
        if (fs.existsSync(nextToModule)) return nextToModule;
        return path.join(this.__skillsDir, '..', 'applications', 'skills', 'resources');
    }

    getConfiguredSkillDirectories(): string[] {
        return uniqueResolvedDirs(this._getConfiguredSkillPathValues());
    }

    getSkillSearchDirectories(): string[] {
        return uniqueResolvedDirs([
            this.getSkillsDirectory(),
            ...this.getConfiguredSkillDirectories(),
            ...this.mountedSkillDirs
        ]);
    }

    // ── 配置 ──────────────────────────────────────────────────────────────

    setRuntimeConfig(config: unknown): void {
        this.hasSkillMgrConfigOverride = true;
        this.skillMgrConfigOverride = config;
    }

    clearRuntimeConfig(): void {
        this.hasSkillMgrConfigOverride = false;
        this.skillMgrConfigOverride = undefined;
    }

    /** 模块私有：读取 skillmgr 应用配置中的 external_paths */
    private _getConfiguredSkillPathValues(): string[] {
        let config;
        if (this.hasSkillMgrConfigOverride) {
            config = this.skillMgrConfigOverride;
        } else {
            try {
                config = Setting.getInstance().getApplicationConfig(SKILLMGR_BUNDLE_NAME);
            } catch (e) {
                logger.warn(`SkillRegistry: 读取 skillmgr 配置失败: ${e.message}`);
                return [];
            }
        }

        if (!config || typeof config !== 'object') return [];
        return Array.isArray((config as any).external_paths) ? (config as any).external_paths : [];
    }

    // ── 加载与注册 ────────────────────────────────────────────────────────

    loadAll(): { toolsets: BaseToolset[]; errors: Array<{ id: string; error: string }> } {
        logger.info('load all skills from local directory');
        const skillsDir = this.getSkillsDirectory();
        this.skillsCache.clear();
        this.singleSkillToolset = new BaseToolset('skill');

        const errors: Array<{ id: string; error: string }> = [];
        const seenConfigSkillDirs = new Set<string>();
        const visitedConfigScanDirs = new Set<string>();

        // 从用户 skills 目录加载
        this._loadSkillsFromDir(skillsDir, errors, false);

        // 从配置目录加载（只加载，不覆盖已安装的技能）
        for (const configDir of this.getConfiguredSkillDirectories()) {
            if (path.resolve(configDir) === path.resolve(skillsDir)) continue;
            this._loadConfiguredSkillSourceDir(configDir, errors, seenConfigSkillDirs, visitedConfigScanDirs);
        }

        // 从 mount 目录加载（只加载，不覆盖已安装的技能）
        for (const mountDir of this.mountedSkillDirs) {
            const resolved = path.resolve(mountDir);
            if (!fs.existsSync(resolved)) {
                errors.push({ id: resolved, error: 'mount 目录不存在' });
                logger.warn(`SkillRegistry: mount 目录不存在: ${resolved}`);
                continue;
            }
            const stat = fs.statSync(resolved);
            if (!stat.isDirectory()) {
                errors.push({ id: resolved, error: 'mount 路径不是目录' });
                continue;
            }

            // 检查目录是否直接包含 SKILL.md（单个 skill 目录）
            const skillMdPath = findSkillEntryFile(resolved);
            if (skillMdPath) {
                // 单个 skill 目录
                logger.info(`SkillRegistry: 从 mount 加载单个技能: ${resolved}`);
                const result = this._loadSkillFromDir(resolved);
                this._registerSkill(result, true, 'mounted');
                if (!result.success) {
                    errors.push({ id: resolved, error: result.error });
                }
            } else {
                // skills 目录，扫描子目录
                logger.info(`SkillRegistry: 从 mount 目录加载技能: ${resolved}`);
                this._loadSkillsFromDir(resolved, errors, true, 'mounted');
            }
        }

        return { toolsets: [this.singleSkillToolset], errors };
    }

    getToolsets(): BaseToolset[] {
        if (this.singleSkillToolset === null || this.skillsCache.size === 0) {
            const { toolsets } = this.loadAll();
            return toolsets;
        }
        return [this.singleSkillToolset];
    }

    refresh(): { toolsets: BaseToolset[]; errors: Array<{ id: string; error: string }> } {
        return this.loadAll();
    }

    /**
     * 模块私有：从配置目录递归加载技能。配置目录允许直接是 skill，也允许包含任意层级的 skill。
     * @param dir - 配置的 skill 扫描目录
     * @param errors - 错误数组（会被 push）
     * @param seenSkillDirs - 已发现的配置 skill 目录集合
     * @param visitedScanDirs - 已扫描的配置目录集合
     */
    private _loadConfiguredSkillSourceDir(
        dir: string,
        errors: Array<{ id: string; error: string }>,
        seenSkillDirs: Set<string>,
        visitedScanDirs: Set<string>
    ): void {
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
        const skillDirs = this._collectConfiguredSkillDirectories(resolved, errors, seenSkillDirs, visitedScanDirs);
        for (const skillDir of skillDirs) {
            const result = this._loadSkillFromDir(skillDir);
            if (!result.success) {
                errors.push({ id: skillDir, error: result.error });
                logger.warn(`SkillRegistry: 跳过 ${skillDir} - ${result.error}`);
                continue;
            }
            this._registerSkill(result, true, 'config');
        }
    }

    /**
     * 模块私有：从配置目录递归收集所有包含 SKILL.md 的 skill 目录。
     */
    private _collectConfiguredSkillDirectories(
        dir: string,
        errors: Array<{ id: string; error: string }>,
        seenSkillDirs: Set<string>,
        visitedScanDirs: Set<string>
    ): string[] {
        const resolved = path.resolve(dir);
        if (visitedScanDirs.has(resolved)) return [];
        visitedScanDirs.add(resolved);

        const skillDirs: string[] = [];
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

        let entries: fs.Dirent[] = [];
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
                ...this._collectConfiguredSkillDirectories(
                    path.join(resolved, ent.name),
                    errors,
                    seenSkillDirs,
                    visitedScanDirs
                )
            );
        }

        return skillDirs;
    }

    /**
     * 模块私有：从指定目录加载所有技能。
     * @param dir - 技能目录
     * @param errors - 错误数组（会被 push）
     * @param skipIfExists - 如果技能已存在则跳过（用于 mount 目录）
     * @param source - 来源分类（installed / mounted 等）
     */
    private _loadSkillsFromDir(
        dir: string,
        errors: Array<{ id: string; error: string }>,
        skipIfExists = false,
        source: SkillSource = 'installed'
    ): void {
        let entries: fs.Dirent[] = [];
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
            const result = this._loadSkillFromDir(skillDir);
            if (result.success) {
                this._registerSkill(result, skipIfExists, source);
            } else {
                errors.push({ id: ent.name, error: result.error });
                logger.warn(`SkillRegistry: 跳过 ${ent.name} - ${result.error}`);
            }
        }
    }

    /**
     * 模块私有：将 skill 注册到 cache 和 toolset
     * @param source - 来源分类（installed/config/mounted）
     * @returns 是否成功注册
     */
    private _registerSkill(result: LoadSkillResult, skipIfExists: boolean, source: SkillSource): boolean {
        if (!result.success) return false;
        if (skipIfExists && this.skillsCache.has(result.name)) {
            logger.info(`SkillRegistry: 跳过已存在技能 ${result.name} (${source})`);
            return false;
        }
        if (this.skillsCache.has(result.name)) {
            logger.info(`SkillRegistry: 技能 ${result.name} 已存在，跳过 (${source})`);
            return false;
        }
        this.skillsCache.set(result.name, {
            frontmatter: result.frontmatter,
            body: result.body,
            skillDir: result.skillDir,
            source
        });
        this.singleSkillToolset!.addTool(result.tool);
        logger.info(`SkillRegistry: 已加载技能 ${result.name} (${source})`);
        return true;
    }

    // ── 查询 ──────────────────────────────────────────────────────────────

    listSkills(): Array<Record<string, unknown>> {
        if (this.skillsCache.size === 0) this.loadAll();
        // 目录路径循环外取一次：getSkillsDirectory 含 existsSync 探测，逐 skill 调用会造成无谓 IO
        const skillsDir = this.getSkillsDirectory();
        const list = Array.from(this.skillsCache.entries()).map(([id, s]) => {
            let addedAt = 0;
            try {
                const dirPath = s.skillDir || path.join(skillsDir, id);
                if (fs.existsSync(dirPath)) {
                    const stat = fs.statSync(dirPath);
                    addedAt = (stat.birthtimeMs != null ? stat.birthtimeMs : stat.mtimeMs) || 0;
                }
            } catch {
                // ignore missing filesystem metadata
            }
            return {
                id,
                name: (s.frontmatter as any).name,
                description: (s.frontmatter as any).description ?? '',
                license: (s.frontmatter as any).license,
                compatibility: (s.frontmatter as any).compatibility,
                metadata: (s.frontmatter as any).metadata,
                allowedTools: (s.frontmatter as any)['allowed-tools'],
                skillDir: s.source === 'config' || s.source === 'mounted' ? s.skillDir : undefined,
                source: s.source,
                addedAt
            };
        });
        list.sort((a, b) => (b.addedAt as number) - (a.addedAt as number));
        return list.map((item) => {
            const rest = { ...item };
            delete rest.addedAt;
            return rest;
        });
    }

    /**
     * 获取指定技能的完整 body（老格式）
     */
    getSkillBody(skillId: string): { frontmatter: Record<string, unknown>; body: string; skillDir: string } | null {
        if (this.skillsCache.size === 0) this.loadAll();
        const skill = this.skillsCache.get(skillId);
        return skill || null;
    }

    isMountedSkill(skillId: string): boolean {
        if (this.skillsCache.size === 0) this.loadAll();
        return this.skillsCache.get(skillId)?.source === 'mounted';
    }

    /**
     * 获取技能的完整详情，包括资源列表
     */
    getSkillDetail(skillId: string): {
        id: string;
        name: string;
        description: string;
        body: string;
        skillDir: string;
        bundleName: string;
        source: SkillSource;
        license?: string;
        compatibility?: string;
        metadata?: object;
        allowedTools?: string[];
        resources: { references: Array<{ name: string; content?: string }>; scripts: string[]; assets: string[] };
    } | null {
        if (this.skillsCache.size === 0) this.loadAll();
        const skill = this.skillsCache.get(skillId);
        if (!skill) return null;

        const { frontmatter, body, skillDir } = skill;
        const resources = this._loadSkillResources(skillDir, (frontmatter as any).name);

        return {
            id: skillId,
            name: (frontmatter as any).name,
            description: (frontmatter as any).description ?? '',
            body,
            skillDir,
            bundleName: SKILLMGR_BUNDLE_NAME,
            source: skill.source,
            license: (frontmatter as any).license,
            compatibility: (frontmatter as any).compatibility,
            metadata: (frontmatter as any).metadata,
            allowedTools: (frontmatter as any)['allowed-tools'],
            resources: {
                references: resources.referencesSections,
                scripts: resources.scriptsList,
                assets: resources.assetsList
            }
        };
    }

    /**
     * 检查指定名称的技能是否已安装（先按 skillsDir 目录存在性判断，再回退到 cache）
     */
    skillExists(skillName: string): boolean {
        if (!skillName || typeof skillName !== 'string') return false;
        const safeName = path.basename(skillName).replace(/[/\\]/g, '');
        if (!safeName) return false;
        const skillsDir = this.getSkillsDirectory();
        const targetDir = path.join(skillsDir, safeName);
        if (fs.existsSync(targetDir) && fs.statSync(targetDir).isDirectory()) {
            return true;
        }
        if (this.skillsCache.size === 0) this.loadAll();
        return this.skillsCache.has(safeName);
    }

    // ── mount 目录管理 ────────────────────────────────────────────────────

    /** 添加 mount 目录（--skillmgr-mount-skill 使用） */
    addMountedDir(dir: string): void {
        const resolved = path.resolve(dir);
        this.mountedSkillDirs.add(resolved);
        logger.info(`SkillRegistry: 添加 mount 目录 ${resolved}`);
    }

    /** 清除所有 mount 目录 */
    clearMountedDirs(): void {
        this.mountedSkillDirs.clear();
    }

    /** 获取所有 mount 目录 */
    getMountedDirs(): string[] {
        return Array.from(this.mountedSkillDirs);
    }

    // ── 内部辅助（下划线前缀，供安装管理器等跨类调用） ─────────────────────

    /** 确保缓存已加载（懒加载） */
    _ensureLoaded(): void {
        if (this.skillsCache.size === 0) this.loadAll();
    }

    /** 获取缓存条目（含 skillDir / source），供卸载时定位真实目录 */
    _getCachedSkillEntry(skillId: string): SkillCacheEntry | undefined {
        return this.skillsCache.get(skillId);
    }

    /** 从缓存中移除指定技能（refresh=false 场景下避免重新加载已删除技能） */
    _removeCachedSkill(skillId: string): void {
        this.skillsCache.delete(skillId);
    }

    /**
     * 从目录加载并解析技能（供安装管理器落盘前校验与取名）
     * 兼容仅含 metadata.json 的目录（registry 下载的元数据包）
     */
    _loadSkillFromDir(skillDir: string, fallbackName?: string): LoadSkillResult {
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

        let raw: string;
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

        const paramsSchema: any = { type: 'object', properties: {}, required: [] };
        const handler = (frontmatter as any).opendesk?.handler ?? (frontmatter as any).handler;
        if (handler && ((frontmatter as any).opendesk?.input_schema || (frontmatter as any).input_schema)) {
            const schema = (frontmatter as any).opendesk?.input_schema ?? (frontmatter as any).input_schema;
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
        tool.setExecutor(this._createExecutor(name, skillDir, body, frontmatter, handler));

        return {
            success: true,
            tool,
            name,
            body,
            frontmatter,
            skillDir
        };
    }

    // ── 模块私有：资源加载与执行器 ────────────────────────────────────────

    /**
     * 渐进式加载技能资源：在技能被调用时读取 references、scripts、assets 等
     */
    private _loadSkillResources(
        skillDir: string,
        skillName: string
    ): {
        referencesSections: Array<{ name: string; content: string }>;
        scriptsList: string[];
        assetsList: string[];
    } {
        const referencesSections: Array<{ name: string; content: string }> = [];
        const scriptsList: string[] = [];
        const assetsList: string[] = [];

        const resolvedDir = path.resolve(skillDir);
        readResourcesFromDir(resolvedDir, referencesSections, scriptsList, assetsList);

        const hadAny = referencesSections.length > 0 || scriptsList.length > 0 || assetsList.length > 0;
        if (!hadAny && skillName) {
            const fallbackDir = path.join(this.getBundledSkillsDirectory(), skillName);
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
    private _formatProgressiveSkillContent(
        body: string,
        resources: {
            referencesSections: Array<{ name: string; content: string }>;
            scriptsList: string[];
            assetsList: string[];
        },
        usageContext: { skillName: string; skillDir: string }
    ): string {
        const parts: string[] = [];

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

    private _createExecutor(
        skillName: string,
        skillDir: string,
        body: string,
        frontmatter: Record<string, unknown>,
        handler: unknown
    ): (args: Record<string, unknown>) => Promise<string> {
        return async (args) => {
            const input = (args?.input as string) ?? '';
            const resources = this._loadSkillResources(skillDir, skillName);
            const progressiveContent = this._formatProgressiveSkillContent(body, resources, {
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
            if (!h || !(h as any).type) {
                return progressiveContent || `[技能 ${skillName}] 无正文说明。`;
            }

            let handlerResult = '';

            if ((h as any).type === 'script' && (h as any).path) {
                const scriptPath = path.resolve(skillDir, (h as any).path);
                if (!scriptPath.startsWith(path.resolve(skillDir))) {
                    return `[技能 ${skillName}] handler 路径不允许超出技能目录`;
                }
                if (!fs.existsSync(scriptPath)) {
                    return `[技能 ${skillName}] 脚本不存在: ${(h as any).path}`;
                }
                handlerResult = await this._runScript(scriptPath, skillDir, input);
            } else if ((h as any).type === 'module' && (h as any).path) {
                const modulePath = path.resolve(skillDir, (h as any).path);
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
            } else if ((h as any).type === 'url' && (h as any).url) {
                try {
                    const res = await getPlatform().fetch((h as any).url, {
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

    private _runScript(scriptPath: string, skillDir: string, input: string): Promise<string> {
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
}

/** 单例实例 */
export const skillRegistry = SkillRegistry.getInstance();

/** _loadSkillFromDir 的返回类型 */
export interface LoadSkillResult {
    success: boolean;
    error?: string;
    tool?: any;
    name?: string;
    body?: string;
    frontmatter?: Record<string, unknown>;
    skillDir?: string;
    paramsSchema?: unknown;
    _skillDir?: string;
    _synthesized?: boolean;
    _synthesizedMd?: string;
}
