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

import { BaseApplication, BaseWorker } from '../base.js';
import type { CliOption, EventDecl } from '../base.js';
import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import { SkillRegistry } from './utils.js';
import { Skill, SkillRegistry as AISkillRegistry } from '../../aikernel/skill.js';
import { BaseToolset } from '../../aikernel/tool.js';
import { ReadableDirectoryRegistry } from '../../aikernel/security/enforcer.js';
import SkillsWorker from './service/worker.js';
import { MANAGE_SKILLS_SKILL } from './skills.js';
import {
    AddSkillFromDirectoryTool,
    AddSkillFromUrlTool,
    SearchSkillFromRegistryTool,
    AddSkillFromRegistryTool,
    ListSkillsTool,
    DeleteSkillsTool,
    RefreshSkillsTool,
    GetSkillsDirectoryTool
} from './tools.js';
import { getSkillStatus } from './status.js';
import { SkillAnalyzer, type ExportMetaOptions } from './analyzer/analyze.js';
import { readAnalysisPrompts, writeAnalysisPrompts, type AnalysisPrompts } from './analyzer/prompts.js';
import type { SlashCommandHandler } from '../../tui/commands/index.js';
import type { Command } from 'commander';
import { useCliTransport, useConsoleTransport } from '../../utils/logger.js';
import path from 'path';
import fs from 'fs';
import {
    installSkillFromDirectory,
    installSkillFromLocalZip,
    installSkillFromUrl,
    installFromRegistryInstallUrl,
    searchSkillsFromAllRegistries,
    installSkillFromRegistryByName
} from './utils.js';
import { SkillExternalPathsConfigSchema } from './skill-schema.js';

export class SkillMgrApplication extends BaseApplication {
    /** 静态回调列表：refresh 后通知订阅方（如 TUI 自动补全）*/
    private static refreshListeners: Array<() => void> = [];

    /** 应用标识（静态属性，供 CLI 参数注册使用） */
    static bundleName: string = 'skillmgr';

    /** 技能分析器：依赖分析、测试用例生成、元数据导入导出 */
    private analyzer: SkillAnalyzer;

    static onSkillsRefreshed(listener: () => void): void {
        SkillMgrApplication.refreshListeners.push(listener);
    }

    private static notifyRefreshListeners(): void {
        for (const listener of SkillMgrApplication.refreshListeners) {
            try {
                listener();
            } catch {
                /* 静默忽略 */
            }
        }
    }

    /**
     * 技能安装/删除后触发运行时热更新：
     * - 清理 AI SkillRegistry 缓存（影响 system prompt 的 skills 段）
     * - 通知订阅者（自动补全、当前任务 prompt 刷新等）
     */
    static notifySkillsChanged(bundleName: string = 'skillmgr'): void {
        AISkillRegistry.getInstance().clearCache(bundleName);
        SkillMgrApplication.notifyRefreshListeners();
    }

    constructor() {
        super('skillmgr', '技能中心');

        this.analyzer = new SkillAnalyzer((status) => {
            this.emitEvent('analysisStatusChanged', status).catch(() => {});
        });

        // 将 skill 目录注册为全局可读，确保所有模式下 agent 都能读取 skill 文件
        this.registerReadableSkillDirectories();
    }

    private registerReadableSkillDirectories(): void {
        const readableRegistry = ReadableDirectoryRegistry.getInstance();
        readableRegistry.register(SkillRegistry.getBundledSkillsDirectory());
        for (const dir of SkillRegistry.getSkillSearchDirectories()) {
            readableRegistry.register(dir);
        }

        // 注册 skill filter，按 status.json 过滤禁用的技能
        AISkillRegistry.registerSkillFilter((bundleName: string, skillName: string) =>
            getSkillStatus(`${bundleName}/${skillName}`)
        );
    }

    /**
     * 定义 CLI 参数选项（不含前缀）
     */
    static getCliOptions(): CliOption[] {
        return [
            {
                name: 'mount-skill',
                description: '从指定目录加载 skill，可多次指定',
                parse: (v) => v
            }
        ];
    }

    /**
     * 注册 `skill` CLI 子命令：install / uninstall / list
     */
    static registerCliSubcommands(prog: Command): void {
        const skillCmd = prog.command('skill').description('技能中心');

        skillCmd
            .command('install <source>')
            .description('安装技能（本地目录、本地 zip 文件或远程 zip URL）')
            .option('--force', '强制覆盖已存在的同名技能')
            .action(async (source: string, opts: { force?: boolean }) => {
                useCliTransport();
                useConsoleTransport();
                const resolved = path.resolve(source);
                const force = opts.force ?? false;
                let result: { success: boolean; name?: string; error?: string };

                if (fs.existsSync(resolved)) {
                    const stat = fs.statSync(resolved);
                    if (stat.isDirectory()) {
                        console.log(`正在从本地目录安装技能: ${resolved}`);
                        result = installSkillFromDirectory(resolved, force);
                    } else if (stat.isFile() && resolved.toLowerCase().endsWith('.zip')) {
                        console.log(`正在从本地 zip 文件安装技能: ${resolved}`);
                        result = installSkillFromLocalZip(resolved, undefined, force);
                    } else {
                        console.error('✗ 本地文件必须是目录或 .zip 格式');
                        process.exit(1);
                        return;
                    }
                } else if (source.startsWith('http://') || source.startsWith('https://')) {
                    console.log(`正在从 URL 下载并安装技能: ${source}`);
                    result = await installSkillFromUrl(source, force);
                } else {
                    console.error(`✗ 无法识别来源: ${source}`);
                    console.error('  支持: 本地目录、本地 .zip 文件、http(s):// URL');
                    process.exit(1);
                    return;
                }

                if (result.success) {
                    console.log(`✓ 技能安装成功: ${result.name}`);
                } else {
                    console.error(`✗ 技能安装失败: ${result.error}`);
                    process.exit(1);
                }
                process.exit(0);
            });

        skillCmd
            .command('uninstall <skillName>')
            .description('卸载指定名称的技能')
            .action((skillName: string) => {
                useCliTransport();
                useConsoleTransport();
                console.log(`正在卸载技能: ${skillName}`);
                const result = SkillRegistry.deleteSkill(skillName);
                if (result.success) {
                    console.log(`✓ 技能已卸载: ${skillName}`);
                } else {
                    console.error(`✗ 卸载失败: ${result.error}`);
                    process.exit(1);
                }
                process.exit(0);
            });

        skillCmd
            .command('list')
            .description('列出所有已安装的技能')
            .option('--json', '以 JSON 格式输出')
            .action((opts: { json?: boolean }) => {
                useCliTransport();
                useConsoleTransport();
                const skills = SkillRegistry.listSkills();
                const skillsDir = SkillRegistry.getSkillsDirectory();

                const enriched = skills.map((s: any) => {
                    const skillBody = SkillRegistry.getSkillBody(String(s.id ?? s.name));
                    const dirPath = skillBody?.skillDir ?? path.join(skillsDir, String(s.name ?? s.id));
                    let fileCount = 0;
                    let totalSize = 0;
                    try {
                        const countFiles = (dir: string) => {
                            const entries = fs.readdirSync(dir, { withFileTypes: true });
                            for (const e of entries) {
                                const full = path.join(dir, e.name);
                                if (e.isDirectory()) {
                                    countFiles(full);
                                } else {
                                    fileCount++;
                                    totalSize += fs.statSync(full).size;
                                }
                            }
                        };
                        if (fs.existsSync(dirPath)) countFiles(dirPath);
                    } catch {
                        /* ignore */
                    }
                    return { ...s, fileCount, totalSize };
                });

                if (opts.json) {
                    console.log(JSON.stringify(enriched, null, 2));
                } else {
                    if (enriched.length === 0) {
                        console.log('暂无已安装的技能');
                    } else {
                        console.log(`已安装的技能 (共 ${enriched.length} 个):\n`);
                        for (const s of enriched) {
                            const sizeStr =
                                s.totalSize < 1024
                                    ? `${s.totalSize} B`
                                    : s.totalSize < 1024 * 1024
                                      ? `${(s.totalSize / 1024).toFixed(1)} KB`
                                      : `${(s.totalSize / (1024 * 1024)).toFixed(1)} MB`;
                            console.log(`  📦 ${s.name ?? s.id}`);
                            console.log(`     ${s.description || '(无描述)'}`);
                            if (s.license) console.log(`     许可证: ${s.license}`);
                            if (s.compatibility) console.log(`     兼容性: ${s.compatibility}`);
                            console.log(`     文件数: ${s.fileCount}  目录大小: ${sizeStr}`);
                            console.log('');
                        }
                    }
                }
                process.exit(0);
            });
    }

    static getWorkerClass(): typeof BaseWorker | undefined {
        return SkillsWorker;
    }

    static getConfigSchema(): z.ZodObject<any> {
        return z.object({
            enabled: z.boolean().describe('是否启用技能').default(false),
            external_paths: SkillExternalPathsConfigSchema.optional().describe(
                '额外 Skill 扫描目录路径列表；未配置或为空时不添加额外扫描路径'
            ),
            skillsmp_api_key: z.string().optional().describe('SkillsMP API Key（可选，用于从 skillsmp.com 搜索技能）')
        });
    }

    async getSupportedEvents(): Promise<EventDecl[]> {
        return [{ eventName: 'analysisStatusChanged', eventDescription: '技能分析状态变更通知' }];
    }

    // ── 技能分析（委托给 SkillAnalyzer） ──

    async getAnalyzeStatus() {
        return this.analyzer.getStatus();
    }

    async getExistingSkillMetadatas() {
        return this.analyzer.getExistingSkillMetadatas();
    }

    async analyzeSkillDependencies(skillIds: string[], concurrency: number = 5) {
        return this.analyzer.analyzeDependencies(skillIds, concurrency);
    }

    async generateSkillTests(skillIds: string[], concurrency: number = 5) {
        return this.analyzer.generateTests(skillIds, concurrency);
    }

    async runSkillTests(skillIds: string[], concurrency: number = 5) {
        return this.analyzer.runTests(skillIds, concurrency);
    }

    async runUnpassedSkillTests(skillIds: string[], concurrency: number = 5) {
        return this.analyzer.runUnpassedTests(skillIds, concurrency);
    }

    async runSingleSkillTest(skillId: string, testCaseIndex: number) {
        return this.analyzer.runSingleTest(skillId, testCaseIndex);
    }

    async stopAnalysis() {
        return this.analyzer.stop();
    }

    async exportSkillMetadatas(skillIds: string[], zipFilePath: string, options?: ExportMetaOptions) {
        return this.analyzer.exportMetadatas(skillIds, zipFilePath, options);
    }

    async importSkillMetadatas(zipFilePath: string) {
        return this.analyzer.importMetadatas(zipFilePath);
    }

    async deleteSkillMetadatas(skillIds: string[]) {
        return this.analyzer.deleteMetadatas(skillIds);
    }

    async getAnalysisPrompts() {
        return readAnalysisPrompts();
    }

    async saveAnalysisPrompts(prompts: Partial<AnalysisPrompts>) {
        return writeAnalysisPrompts(prompts);
    }

    async getSkills(): Promise<Skill[]> {
        this.registerReadableSkillDirectories();

        const skills: Skill[] = [];

        // 已安装的技能始终对 Agent 可见，便于 LoadSkill/CallSkill 能正确解析并调用（与「Skills 应用是否启用」无关）
        // 传递完整 frontmatter 以保留 user-invocable / disable-model-invocation 等扩展字段
        // 过滤掉已禁用的技能
        skills.push(
            ...SkillRegistry.listSkills()
                .filter((skill) => getSkillStatus(skill.id))
                .map((skill) => {
                    const skillBody = SkillRegistry.getSkillBody(skill.id);
                    const fullFrontmatter = skillBody?.frontmatter ?? {};
                    const skillDir = skillBody?.skillDir ?? path.join(this.getSkillsDirectory(), String(skill.name));
                    return new Skill(
                        {
                            name: String(skill.name),
                            description: String(skill.description),
                            ...fullFrontmatter
                        },
                        skillBody?.body || '',
                        skillDir
                    );
                })
        );

        const manageSkillsSkill = Skill.parseMd(MANAGE_SKILLS_SKILL);
        const manageSkillsToolset = new BaseToolset('manage-skills');

        manageSkillsToolset.addTool(new AddSkillFromDirectoryTool(this));
        manageSkillsToolset.addTool(new AddSkillFromUrlTool(this));
        manageSkillsToolset.addTool(new SearchSkillFromRegistryTool(this));
        manageSkillsToolset.addTool(new AddSkillFromRegistryTool(this));
        manageSkillsToolset.addTool(new ListSkillsTool(this));
        manageSkillsToolset.addTool(new DeleteSkillsTool(this));
        manageSkillsToolset.addTool(new RefreshSkillsTool(this));
        manageSkillsToolset.addTool(new GetSkillsDirectoryTool(this));

        manageSkillsSkill.toolsets = [manageSkillsToolset];
        skills.push(manageSkillsSkill);

        return skills;
    }

    onConfigChanged(): void {
        super.onConfigChanged();
        logger.info('[skillmgr] config changed, refreshing skills...');
        this.registerReadableSkillDirectories();
        SkillRegistry.refresh();
        SkillMgrApplication.notifySkillsChanged(this.bundleName);
    }

    getSkillsDirectory(): string {
        return SkillRegistry.getSkillsDirectory();
    }

    getBundledSkillsDirectory(): string {
        return SkillRegistry.getBundledSkillsDirectory();
    }

    listSkills() {
        return SkillRegistry.listSkills();
    }

    /**
     * 获取所有 user-invocable 的技能（包含系统内置 + 已安装），供渲染进程技能选择器使用
     */
    async getAllUserInvocableSkills() {
        const registry = AISkillRegistry.getInstance();
        const skills = await registry.getUserInvocableSkills();
        return skills.map(({ bundleName, skill }) => ({
            name: skill.frontmatter.name,
            description: skill.frontmatter.description || '',
            bundleName
        }));
    }

    /**
     * 获取所有系统内置技能（排除 skillmgr bundle），供技能中心的"内置技能"Tab 使用
     */
    async getBuiltinSkills() {
        const registry = AISkillRegistry.getInstance();
        const allSkills = await registry.getAllSkillsRaw();
        const result: Array<{
            id: string;
            name: string;
            description: string;
            bundleName: string;
            tools: Array<{
                name: string;
                description: string;
                params: Array<{ name: string; type: string; description: string; required: boolean }>;
            }>;
            directory?: string;
            license?: string;
            compatibility?: string;
        }> = [];
        for (const [bundleName, skills] of allSkills) {
            // 排除 skillmgr bundle（其技能已在"已安装"Tab 中显示）
            if (bundleName === 'skillmgr') continue;
            for (const skill of skills) {
                const tools: Array<{
                    name: string;
                    description: string;
                    params: Array<{ name: string; type: string; description: string; required: boolean }>;
                }> = [];
                if (skill.toolsets) {
                    for (const toolset of skill.toolsets) {
                        for (const [, tool] of toolset.tools) {
                            const jsonSchema = tool.params.toJSONSchema();
                            const required: string[] = Array.isArray(jsonSchema['required'])
                                ? jsonSchema['required']
                                : [];
                            const properties = jsonSchema['properties'] || {};
                            const paramsList: Array<{
                                name: string;
                                type: string;
                                description: string;
                                required: boolean;
                            }> = [];
                            for (const [paramName, paramSchema] of Object.entries(properties)) {
                                const ps = paramSchema as Record<string, unknown>;
                                const paramType = Array.isArray(ps['type'])
                                    ? (ps['type'] as string[]).join(' | ')
                                    : typeof ps['type'] === 'string'
                                      ? ps['type']
                                      : 'any';
                                paramsList.push({
                                    name: paramName,
                                    type: paramType,
                                    description: typeof ps['description'] === 'string' ? ps['description'] : '',
                                    required: required.includes(paramName)
                                });
                            }
                            tools.push({
                                name: tool.name,
                                description: tool.description,
                                params: paramsList
                            });
                        }
                    }
                }
                const skillId = `${bundleName}/${skill.frontmatter.name}`;
                result.push({
                    id: skillId,
                    name: skill.frontmatter.name,
                    description: skill.frontmatter.description || '',
                    bundleName,
                    tools,
                    directory: skill.directory || undefined,
                    license: skill.frontmatter.license || undefined,
                    compatibility: skill.frontmatter.compatibility || undefined,
                    enabled: getSkillStatus(skillId)
                });
            }
        }
        return result;
    }

    /**
     * 从 zip 文件路径安装技能，供渲染进程调用
     */
    installSkillFromZip(zipPath: string) {
        const result = installSkillFromLocalZip(zipPath);
        if (result.success) {
            SkillRegistry.refresh();
            SkillMgrApplication.notifySkillsChanged(this.bundleName);
        }
        return result;
    }

    addSkillFromDirectory(sourceDirectory: string) {
        const result = installSkillFromDirectory(sourceDirectory);
        if (result.success) {
            SkillMgrApplication.notifySkillsChanged(this.bundleName);
        }
        return result;
    }

    addSkillFromUrl(url: string) {
        return installSkillFromUrl(url).then((result) => {
            if (result.success) {
                SkillMgrApplication.notifySkillsChanged(this.bundleName);
            }
            return result;
        });
    }

    async searchSkillFromRegistry(keyword: string) {
        const config = this.getConfig() as { skillsmp_api_key?: string } | undefined;
        return searchSkillsFromAllRegistries(keyword, {
            limit: 20,
            skillsmpApiKey: config?.skillsmp_api_key
        });
    }

    async addSkillFromRegistry(skillName: string, registryName: string, force: boolean = false) {
        const config = this.getConfig() as { skillsmp_api_key?: string } | undefined;
        const result = await installSkillFromRegistryByName(registryName, skillName, {
            force,
            skillsmpApiKey: config?.skillsmp_api_key
        });
        if (result.success) {
            SkillMgrApplication.notifySkillsChanged(this.bundleName);
        }
        return result;
    }

    async installFromRegistry(installUrl: string, force: boolean = false) {
        const result = await installFromRegistryInstallUrl(installUrl, force);
        if (!result.success) {
            throw new Error(result.error);
        }
        SkillMgrApplication.notifySkillsChanged(this.bundleName);
        return { name: result.name ?? '' };
    }

    deleteSkill(skillId: string) {
        const result = SkillRegistry.deleteSkill(skillId);
        if (result.success) {
            SkillMgrApplication.notifySkillsChanged(this.bundleName);
        }
        return result;
    }

    clearSkills() {}

    refresh() {
        const { toolsets, errors } = SkillRegistry.refresh();
        SkillMgrApplication.notifySkillsChanged(this.bundleName);
        return { count: toolsets.length, errors };
    }

    getCliSlashCommands(tui: any): SlashCommandHandler[] {
        return [
            {
                name: 'skills',
                description: '技能中心',
                execute: async (_args: string) => {
                    try {
                        const { SkillsOverlay } = await import('./skills-tui.js');
                        const skillsOverlay = new SkillsOverlay(tui);
                        skillsOverlay.show();
                    } catch (err) {
                        logger.error(`打开技能中心失败: ${err}`);
                    }
                }
            }
        ];
    }
}
