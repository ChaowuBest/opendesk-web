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
import { SkillRegistry } from './skillregistry.js';
import { Skill, SkillRegistry as AISkillRegistry } from '../../aikernel/skill.js';
import { BaseToolset } from '../../aikernel/tool.js';
import { ReadableDirectoryRegistry } from '../../aikernel/security/enforcer.js';
import { GlobalState } from '../../aikernel/states/global.js';
import { MainAgentDecl } from '../../aikernel/agents/main/agent.js';
import { getPlatform } from '../../../platforms/base.js';
import SkillsWorker from './service/worker.js';
import { MANAGE_SKILLS_SKILL } from './skills.js';
import {
    AddSkillFromDirectoryTool,
    AddSkillFromUrlTool,
    AddSkillFromGitHubUrlTool,
    ListSkillsTool,
    DeleteSkillsTool,
    RefreshSkillsTool,
    GetSkillsDirectoryTool
} from './tools.js';
import { getSkillStatus, getAllStatuses } from './status.js';
import { loadAndValidateOpendeskMeta, OPENDESK_META_FILENAME } from './analyzer/metadata.js';
import type { SlashCommandHandler } from '../../tui/commands/index.js';
import type { Command } from 'commander';
import { useCliTransport, useConsoleTransport } from '../../utils/logger.js';
import path from 'path';
import fs from 'fs';
import os from 'os';
import AdmZip from 'adm-zip';
import {
    installSkillFromDirectory,
    installSkillFromLocalZip,
    installSkillFromUrl,
    installSkillFromGitHubUrl,
    installFromRegistryInstallUrl
} from './util.js';

export class SkillMgrApplication extends BaseApplication {
    /** 静态回调列表：refresh 后通知订阅方（如 TUI 自动补全）*/
    private static refreshListeners: Array<() => void> = [];

    /** 应用标识（静态属性，供 CLI 参数注册使用） */
    static bundleName: string = 'skillmgr';

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

        // 将 skill 目录注册为全局可读，确保所有模式下 agent 都能读取 skill 文件
        const readableRegistry = ReadableDirectoryRegistry.getInstance();
        readableRegistry.register(SkillRegistry.getSkillsDirectory());
        readableRegistry.register(SkillRegistry.getBundledSkillsDirectory());
        for (const dir of SkillRegistry.getMountedDirs()) {
            readableRegistry.register(dir);
        }
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
                    if (source.includes('github.com') && source.includes('/tree/')) {
                        console.log(`正在从 GitHub URL 安装技能: ${source}`);
                        result = await installSkillFromGitHubUrl(source, force);
                    } else {
                        console.log(`正在从 URL 下载并安装技能: ${source}`);
                        result = await installSkillFromUrl(source, force);
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

    async getSupportedEvents(): Promise<EventDecl[]> {
        return [{ eventName: 'analysisStatusChanged', eventDescription: '技能分析状态变更通知' }];
    }

    // ── 技能依赖分析 & 测试用例生成 ──

    private _analyzeState: {
        running: boolean;
        taskType: 'deps' | 'testgen' | null;
        total: number;
        completed: number;
        currentSkill: string | null;
        runningTaskIds: Set<string>;
        results: Record<
            string,
            { dependencies?: Record<string, unknown>; testCases?: unknown[]; error?: string; analyzedAt?: number }
        >;
    } = {
        running: false,
        taskType: null,
        total: 0,
        completed: 0,
        currentSkill: null,
        runningTaskIds: new Set(),
        results: {}
    };

    async getAnalyzeStatus() {
        return {
            running: this._analyzeState.running,
            taskType: this._analyzeState.taskType,
            total: this._analyzeState.total,
            completed: this._analyzeState.completed,
            currentSkill: this._analyzeState.currentSkill,
            results: this._analyzeState.results
        };
    }

    async getExistingSkillMetadatas() {
        const results: Record<string, { dependencies?: Record<string, unknown>; testCases?: unknown[] }> = {};
        for (const skill of SkillRegistry.listSkills()) {
            try {
                const detail = SkillRegistry.getSkillDetail(skill.id);
                if (!detail?.skillDir) continue;
                const meta = loadAndValidateOpendeskMeta(detail.skillDir);
                if (meta) {
                    const entry: { dependencies?: Record<string, unknown>; testCases?: unknown[] } = {};
                    if (meta.dependencies) entry.dependencies = meta.dependencies as Record<string, unknown>;
                    if (meta.testCases?.length) entry.testCases = meta.testCases as unknown[];
                    if (entry.dependencies || entry.testCases) results[skill.id] = entry;
                }
            } catch {
                /* ignore */
            }
        }
        return results;
    }

    async analyzeSkillDependencies(skillIds: string[], concurrency: number = 5) {
        return this._startAnalysis(skillIds, concurrency, 'deps');
    }

    async generateSkillTests(skillIds: string[], concurrency: number = 5) {
        return this._startAnalysis(skillIds, concurrency, 'testgen');
    }

    private async _startAnalysis(skillIds: string[], concurrency: number, taskType: 'deps' | 'testgen') {
        if (!Array.isArray(skillIds) || skillIds.length === 0) throw new Error('请至少选择一个技能');
        if (this._analyzeState.running) throw new Error('分析正在进行中，请等待完成后再发起');
        const targetIds = [...new Set(skillIds)];
        const maxConcurrency = Math.max(1, Math.min(concurrency, 10));
        this._analyzeState = {
            running: true,
            taskType,
            total: targetIds.length,
            completed: 0,
            currentSkill: null,
            runningTaskIds: new Set(),
            results: { ...this._analyzeState.results }
        };
        this.emitEvent('analysisStatusChanged', this._analyzeState).catch(() => {});
        this._runAnalysisInBackground(targetIds, maxConcurrency, taskType);
        return this._analyzeState;
    }

    async stopAnalysis() {
        if (!this._analyzeState.running) return;
        const taskManager = GlobalState.getInstance().taskManagerState;
        for (const taskId of this._analyzeState.runningTaskIds) {
            try {
                const t = taskManager.getTask(taskId);
                if (t) t.stop('system');
            } catch {
                /* ignore */
            }
        }
        this._analyzeState.running = false;
        this._analyzeState.runningTaskIds.clear();
        this._analyzeState.currentSkill = null;
        this.emitEvent('analysisStatusChanged', this._analyzeState).catch(() => {});
    }

    /**
     * 导出技能元数据到 zip 文件。
     * @param skillIds - 要导出的技能 ID 列表
     * @param zipFilePath - 目标 zip 文件路径
     * @returns 导出结果，包含成功数量和错误信息
     */
    async exportSkillMetadatas(skillIds: string[], zipFilePath: string) {
        const zip = new AdmZip();
        let successCount = 0;
        const errors: string[] = [];

        for (const skillId of skillIds) {
            try {
                const detail = SkillRegistry.getSkillDetail(skillId);
                if (!detail?.skillDir) {
                    errors.push(`${skillId}: 技能目录不存在`);
                    continue;
                }
                const metaPath = path.join(detail.skillDir, OPENDESK_META_FILENAME);
                if (!fs.existsSync(metaPath)) {
                    errors.push(`${skillId}: ${OPENDESK_META_FILENAME} 不存在`);
                    continue;
                }
                const metaContent = fs.readFileSync(metaPath, 'utf-8');
                const entryName = `${detail.name}_meta.json`;
                zip.addFile(entryName, Buffer.from(metaContent, 'utf-8'));
                successCount++;
            } catch (e) {
                errors.push(`${skillId}: ${(e as Error).message}`);
            }
        }

        if (successCount === 0) {
            return { success: false, successCount: 0, errorCount: errors.length, errors };
        }

        try {
            zip.writeZip(zipFilePath);
            return { success: true, successCount, errorCount: errors.length, errors };
        } catch (e) {
            return {
                success: false,
                successCount: 0,
                errorCount: errors.length,
                errors: [...errors, `写入 zip 失败: ${(e as Error).message}`]
            };
        }
    }

    /**
     * 从 zip 文件导入技能元数据。
     * 解压 zip，遍历所有 *_meta.json 文件，对于已存在的技能覆盖其 opendesk_meta.json。
     * @param zipFilePath - 源 zip 文件路径
     * @returns 导入结果：successCount, failedCount, skippedCount, details
     */
    async importSkillMetadatas(zipFilePath: string) {
        let successCount = 0;
        let failedCount = 0;
        let skippedCount = 0;
        const details: Array<{ skillName: string; status: 'success' | 'failed' | 'skipped'; message: string }> = [];

        let zip: AdmZip;
        try {
            zip = new AdmZip(zipFilePath);
        } catch (e) {
            return {
                success: false,
                successCount: 0,
                failedCount: 0,
                skippedCount: 0,
                details: [],
                error: `无法读取 zip 文件: ${(e as Error).message}`
            };
        }

        const tempDir = path.join(os.tmpdir(), `opendesk-skill-import-${Date.now()}`);
        try {
            fs.mkdirSync(tempDir, { recursive: true });
            zip.extractAllTo(tempDir, true);

            const entries = zip.getEntries();
            const metaEntries = entries.filter((e) => e.entryName.match(/_(meta|metadata)\.json$/i) && !e.isDirectory);

            for (const entry of metaEntries) {
                // 从文件名提取技能名称，如 "manage-souls_meta.json" -> "manage-souls"
                const skillName = entry.entryName.replace(/_(meta|metadata)\.json$/i, '');

                try {
                    // 检查技能是否存在
                    const skillExists = SkillRegistry.skillExists(skillName);
                    if (!skillExists) {
                        skippedCount++;
                        details.push({ skillName, status: 'skipped', message: '技能不存在，已跳过' });
                        continue;
                    }

                    const detail = SkillRegistry.getSkillDetail(skillName);
                    if (!detail?.skillDir) {
                        skippedCount++;
                        details.push({ skillName, status: 'skipped', message: '技能目录不存在，已跳过' });
                        continue;
                    }

                    const metaPath = path.join(detail.skillDir, OPENDESK_META_FILENAME);
                    const extractedPath = path.join(tempDir, entry.entryName);
                    const content = fs.readFileSync(extractedPath, 'utf-8');

                    // 简单验证是否为有效 JSON
                    try {
                        JSON.parse(content);
                    } catch {
                        failedCount++;
                        details.push({ skillName, status: 'failed', message: '元数据文件不是有效的 JSON' });
                        continue;
                    }

                    // 覆盖写入
                    fs.writeFileSync(metaPath, content, 'utf-8');
                    successCount++;
                    details.push({ skillName, status: 'success', message: '导入成功' });
                } catch (e) {
                    failedCount++;
                    details.push({ skillName, status: 'failed', message: (e as Error).message });
                }
            }
        } finally {
            // 清理临时目录
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch {
                /* ignore */
            }
        }

        return { success: true, successCount, failedCount, skippedCount, details };
    }

    private async _runAnalysisInBackground(skillIds: string[], concurrency: number, taskType: 'deps' | 'testgen') {
        const queue = [...skillIds];
        const worker = async () => {
            while (queue.length > 0) {
                const sid = queue.shift();
                if (!sid) break;
                if (taskType === 'deps') await this._analyzeDepsForSkill(sid);
                else await this._generateTestsForSkill(sid);
            }
        };
        try {
            await Promise.all(Array.from({ length: concurrency }, () => worker()));
        } catch (err) {
            logger.error(`分析出错: ${(err as Error)?.message || String(err)}`);
        } finally {
            for (const taskId of this._analyzeState.runningTaskIds) {
                try {
                    const t = GlobalState.getInstance().taskManagerState.getTask(taskId);
                    if (t) t.stop('system');
                } catch {
                    /* ignore */
                }
            }
            this._analyzeState.running = false;
            this._analyzeState.runningTaskIds.clear();
            this._analyzeState.currentSkill = null;
            this.emitEvent('analysisStatusChanged', this._analyzeState).catch(() => {});
        }
    }

    private async _analyzeDepsForSkill(skillId: string) {
        await this._createSkillAgentTask(
            skillId,
            '依赖',
            (d, n) => this._buildDepsPrompt(d, n),
            (d, meta) => {
                this._analyzeState.results[skillId] = meta?.dependencies
                    ? {
                          dependencies: meta.dependencies as Record<string, unknown>,
                          testCases: meta.testCases as unknown[] | undefined,
                          analyzedAt: Date.now()
                      }
                    : { error: 'opendesk_meta.json 未包含有效的依赖项', analyzedAt: Date.now() };
            }
        );
    }

    private async _generateTestsForSkill(skillId: string) {
        await this._createSkillAgentTask(
            skillId,
            '测试用例',
            (d, n) => this._buildTestsPrompt(d, n),
            (d, meta) => {
                this._analyzeState.results[skillId] = meta?.testCases?.length
                    ? {
                          dependencies: meta.dependencies as Record<string, unknown> | undefined,
                          testCases: meta.testCases as unknown[],
                          analyzedAt: Date.now()
                      }
                    : { error: 'opendesk_meta.json 未包含有效的测试用例', analyzedAt: Date.now() };
            }
        );
    }

    private async _createSkillAgentTask(
        skillId: string,
        taskLabel: string,
        buildPrompt: (d: string, n: string) => string,
        handleResult: (
            d: string,
            meta: { dependencies?: Record<string, unknown>; testCases?: unknown[] } | undefined
        ) => void
    ) {
        this._analyzeState.currentSkill = skillId;
        this.emitEvent('analysisStatusChanged', this._analyzeState).catch(() => {});
        const detail = SkillRegistry.getSkillDetail(skillId);
        if (!detail?.skillDir) {
            this._analyzeState.results[skillId] = { error: '无法获取技能目录', analyzedAt: Date.now() };
            this._analyzeState.completed++;
            this.emitEvent('analysisStatusChanged', this._analyzeState).catch(() => {});
            return;
        }
        const skillDir = detail.skillDir;
        const skillName = detail.name || skillId;
        try {
            const tm = GlobalState.getInstance().taskManagerState;
            const agent = new MainAgentDecl();
            const mode = agent.supportedModes().find((m) => m.id === 'solo') ?? agent.supportedModes()[0];
            const task = tm.createTask();
            task.task_name = `[分析技能${taskLabel}] ${skillName}`;
            this._analyzeState.runningTaskIds.add(task.task_id);
            await tm.initHarness(task, getPlatform().getEffectiveWorkspace(), mode);
            task.setSystemPrompt(await agent.createSystemPrompt(mode, task));
            await task.hooks.noticeBeforeTaskStart(task);
            await task.submitUserMessage(buildPrompt(skillDir, skillName));
            await task.waitUntilFinished();
            this._analyzeState.runningTaskIds.delete(task.task_id);
            try {
                handleResult(skillDir, loadAndValidateOpendeskMeta(skillDir));
            } catch (err) {
                this._analyzeState.results[skillId] = {
                    error: `读取结果失败: ${(err as Error)?.message}`,
                    analyzedAt: Date.now()
                };
            }
        } catch (err) {
            this._analyzeState.results[skillId] = {
                error: `Agent 失败: ${(err as Error)?.message}`,
                analyzedAt: Date.now()
            };
        }
        this._analyzeState.completed++;
        this.emitEvent('analysisStatusChanged', this._analyzeState).catch(() => {});
    }

    private _buildDepsPrompt(skillDir: string, skillName: string): string {
        return `请分析以下技能目录的依赖项，写入 ${skillDir}/${OPENDESK_META_FILENAME}。

技能: ${skillName}
目录: ${skillDir}

步骤：
1. 读取 SKILL.md 了解功能
2. 检查所有文件（handler.js、scripts/ 等），识别环境变量、Python 三方库、npm 包、系统命令
3. 写入 JSON（保留已有 testCases）：

{"dependencies":{"envVars":[{"name":"KEY","required":true,"description":"用途"}],"pythonPackages":[{"name":"requests","version":">=2.28","description":"用途"}],"npmPackages":[{"name":"axios","version":"^1.0","description":"用途"}],"binaries":[{"name":"git","description":"用途","installHint":"brew install git"}]}}

不存在的不写空数组，required 默认 false。`;
    }

    private _buildTestsPrompt(skillDir: string, skillName: string): string {
        return `请为以下技能生成测试用例，写入 ${skillDir}/${OPENDESK_META_FILENAME}。

技能: ${skillName}
目录: ${skillDir}

步骤：
1. 读取 ${skillDir}/SKILL.md 和所有实现文件，全面理解技能功能、参数、返回值和使用场景
2. 尽可能覆盖所有场景：正常流程、边界条件、异常输入、错误处理、多参数组合、网络异常、权限不足等
3. 将测试用例写入 ${skillDir}/${OPENDESK_META_FILENAME}，JSON 格式如下：

{
  "testCases": [
    {
      "index": 1,
      "title": "基本功能测试 - 输入有效参数应返回正确结果",
      "scenario": "当用户输入参数 A=1、B=2 时，...",
      "expectedResult": "返回 { result: 3 }，状态码 200",
      "status": "pending"
    },
    {
      "index": 2,
      "title": "边界条件 - 空输入应返回错误提示",
      "scenario": "当用户不传入必填参数时调用技能...",
      "expectedResult": "返回明确的错误信息，不崩溃",
      "status": "pending"
    }
  ]
}

注意：
- index 必须为正整数，从 1 开始递增，每个测试用例唯一
- title 要简洁描述测试的核心目标和条件
- scenario 用自然语言描述前置条件、输入数据和操作步骤，要详细到可复现
- expectedResult 明确描述期望的输出、行为变化或副作用
- status 统一设为 "pending"
- 覆盖全面：基本功能、边界条件、错误处理、异常输入、性能退化等
- 已有 dependencies 保留不动，只更新或添加 testCases 字段
完成后请确认文件已正确写入。`;
    }

    async getSkills(): Promise<Skill[]> {
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

        manageSkillsToolset.addTool(new AddSkillFromDirectoryTool(this));
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
            SkillMgrApplication.notifySkillsChanged(this.bundleName);
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
     * 获取所有系统内置技能（排除 skillmgr bundle），供技能中心的"内置技能"Tab 使用
     */
    async getBuiltinSkills() {
        const registry = AISkillRegistry.getInstance();
        const allSkills = await registry.getAvailableSkills();
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
                result.push({
                    id: `${bundleName}/${skill.frontmatter.name}`,
                    name: skill.frontmatter.name,
                    description: skill.frontmatter.description || '',
                    bundleName,
                    tools,
                    directory: skill.directory || undefined,
                    license: skill.frontmatter.license || undefined,
                    compatibility: skill.frontmatter.compatibility || undefined
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

    addSkillFromGitHubUrl(githubUrl: string) {
        return installSkillFromGitHubUrl(githubUrl).then((result) => {
            if (result.success) {
                SkillMgrApplication.notifySkillsChanged(this.bundleName);
            }
            return result;
        });
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
                description: '技能中心 (子命令: test <技能名> - 测试技能)',
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
                            logger.error(`打开技能中心失败: ${err}`);
                        }
                    }
                }
            }
        ];
    }
}
