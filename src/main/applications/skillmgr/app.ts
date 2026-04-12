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
import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import { SkillRegistry } from './skillregistry.js';
import { Skill, SkillRegistry as AISkillRegistry } from '../../aikernel/skill.js';
import { BaseToolset } from '../../aikernel/tool.js';
import SkillsWorker from './service/worker.js';
import { MANAGE_SKILLS_SKILL } from './skills.js';
import {
    AddSkillFromPathTool,
    AddSkillFromUrlTool,
    AddSkillFromGitHubUrlTool,
    ListSkillsTool,
    DeleteSkillsTool,
    RefreshSkillsTool,
    GetSkillsDirectoryTool
} from './tools.js';
import type { SlashCommandHandler } from '../../tui/commands/index.js';
import type { Command } from 'commander';
import { useCliTransport, useConsoleTransport } from '../../utils/logger.js';
import path from 'path';
import fs from 'fs';
import { RegistryAdapters } from './registry-adapters.js';

export class SkillMgrApplication extends BaseApplication {
    /** 静态回调列表：refresh 后通知订阅方（如 TUI 自动补全）*/
    private static refreshListeners: Array<() => void> = [];

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

    constructor() {
        super('skillmgr', 'Skills');
    }

    /**
     * 注册 `skill` CLI 子命令：install / uninstall / list
     */
    static registerCliSubcommands(prog: Command): void {
        const skillCmd = prog.command('skill').description('技能管理');

        skillCmd
            .command('install <source>')
            .description('安装技能（本地目录、本地 zip 文件或远程 zip URL）')
            .action(async (source: string) => {
                useCliTransport();
                useConsoleTransport();
                const resolved = path.resolve(source);
                let result: { success: boolean; name?: string; error?: string };

                if (fs.existsSync(resolved)) {
                    const stat = fs.statSync(resolved);
                    if (stat.isDirectory()) {
                        console.log(`正在从本地目录安装技能: ${resolved}`);
                        result = SkillRegistry.addSkillFromPath(resolved);
                    } else if (stat.isFile() && resolved.toLowerCase().endsWith('.zip')) {
                        console.log(`正在从本地 zip 文件安装技能: ${resolved}`);
                        result = SkillRegistry.addSkillFromZipPath(resolved);
                    } else {
                        console.error('✗ 本地文件必须是目录或 .zip 格式');
                        process.exit(1);
                        return;
                    }
                } else if (source.startsWith('http://') || source.startsWith('https://')) {
                    if (source.includes('github.com') && source.includes('/tree/')) {
                        console.log(`正在从 GitHub URL 安装技能: ${source}`);
                        result = await SkillRegistry.addSkillFromGitHubUrl(source);
                    } else {
                        console.log(`正在从 URL 下载并安装技能: ${source}`);
                        result = await SkillRegistry.addSkillFromUrl(source);
                    }
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
                    const dirPath = path.join(skillsDir, s.name ?? s.id);
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
            skillsmp_api_key: z.string().optional().describe('SkillsMP API Key（可选，用于从 skillsmp.com 搜索技能）')
        });
    }

    async getSkills(): Promise<Skill[]> {
        const skills: Skill[] = [];

        // 已安装的技能始终对 Agent 可见，便于 LoadSkill/CallSkill 能正确解析并调用（与「Skills 应用是否启用」无关）
        // 传递完整 frontmatter 以保留 user-invocable / disable-model-invocation 等扩展字段
        skills.push(
            ...SkillRegistry.listSkills().map((skill) => {
                const skillBody = SkillRegistry.getSkillBody(skill.id);
                const fullFrontmatter = skillBody?.frontmatter ?? {};
                return new Skill(
                    {
                        name: String(skill.name),
                        description: String(skill.description),
                        ...fullFrontmatter
                    },
                    skillBody?.body || '',
                    this.getSkillsDirectory() + '/' + skill.name
                );
            })
        );

        const manageSkillsSkill = Skill.parseMd(MANAGE_SKILLS_SKILL);
        const manageSkillsToolset = new BaseToolset('manage-skills');

        manageSkillsToolset.addTool(new AddSkillFromPathTool(this));
        manageSkillsToolset.addTool(new AddSkillFromUrlTool(this));
        manageSkillsToolset.addTool(new AddSkillFromGitHubUrlTool(this));
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
        if (this.getConfig()?.enabled === true) {
            SkillRegistry.refresh();
            SkillMgrApplication.notifyRefreshListeners();
        }
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
     * 从 zip 文件路径安装技能，供渲染进程调用
     */
    installSkillFromZip(zipPath: string) {
        const result = SkillRegistry.addSkillFromZipPath(zipPath);
        if (result.success) {
            SkillRegistry.refresh();
            AISkillRegistry.getInstance().clearCache(this.bundleName);
            SkillMgrApplication.notifyRefreshListeners();
        }
        return result;
    }

    addSkillFromPath(sourcePath: string) {
        return SkillRegistry.addSkillFromPath(sourcePath);
    }

    addSkillFromUrl(url: string) {
        return SkillRegistry.addSkillFromUrl(url);
    }

    addSkillFromGitHubUrl(githubUrl: string) {
        return SkillRegistry.addSkillFromGitHubUrl(githubUrl);
    }

    async installFromRegistry(installUrl: string) {
        const method = RegistryAdapters.getInstallMethod(installUrl);
        let result;
        if (method === 'clawhub') {
            const parsed = RegistryAdapters.parseClawHubInstallUrl(installUrl);
            if (!parsed) {
                throw new Error('无效的 ClawHub installUrl');
            }
            result = await SkillRegistry.addSkillFromClawHubSlug(parsed.slug, parsed.version);
        } else if (method === 'github') {
            result = await SkillRegistry.addSkillFromGitHubUrl(installUrl);
        } else {
            result = await SkillRegistry.addSkillFromUrl(installUrl);
        }
        if (!result.success) {
            throw new Error(result.error);
        }
        return { name: result.name };
    }

    deleteSkill(skillId: string) {
        return SkillRegistry.deleteSkill(skillId);
    }

    clearSkills() {}

    refresh() {
        const { toolsets, errors } = SkillRegistry.refresh();
        // 清除 AI SkillRegistry 的缓存，确保后续读取拿到最新数据
        AISkillRegistry.getInstance().clearCache(this.bundleName);
        SkillMgrApplication.notifyRefreshListeners();
        return { count: toolsets.length, errors };
    }

    getCliSlashCommands(tui: any): SlashCommandHandler[] {
        return [
            {
                name: 'skills',
                description: '技能管理 (子命令: test <技能名> - 测试技能)',
                execute: async (args: string) => {
                    const trimmedArgs = args.trim();
                    const parts = trimmedArgs.split(/\s+/);
                    const subCommand = parts[0]?.toLowerCase();
                    const subArgs = parts.slice(1).join(' ').trim();

                    if (subCommand === 'test') {
                        try {
                            const { SkillTestOverlay } = await import('./skill-test-tui.js');
                            const skillId = subArgs || undefined;
                            const testOverlay = new SkillTestOverlay(tui);
                            testOverlay.show(skillId);
                        } catch (err) {
                            logger.error(`打开技能测试失败: ${err}`);
                        }
                    } else {
                        try {
                            const { SkillsOverlay } = await import('./skills-tui.js');
                            const skillsOverlay = new SkillsOverlay(tui);
                            skillsOverlay.show();
                        } catch (err) {
                            logger.error(`打开技能管理失败: ${err}`);
                        }
                    }
                }
            }
        ];
    }
}
