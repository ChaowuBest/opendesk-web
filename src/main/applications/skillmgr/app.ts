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
import { t } from './locale/index.js';
import type { CliOption, EventDecl } from '../base.js';
import { z } from 'zod';
import { logger, useCliTransport, useConsoleTransport } from '../../utils/logger.js';
import { Skill, SkillRegistry as AISkillRegistry, type PluginSourceKind } from '../../aikernel/skill.js';
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
import {
    isBlacklisted,
    getAllBlacklisted,
    addToBlacklist,
    clearInterceptionRecords,
    clearAllInterceptionRecords as clearAllInterceptionRecordsImpl,
    isUserInstalledSkill
} from './blacklist.js';
import { NotificationManager } from '../../utils/notificationmgr.js';
import { SkillAnalyzer, type ExportMetaOptions, type RunTestOptions } from './analyzer/analyze.js';
import { readAnalysisPrompts, writeAnalysisPrompts, type AnalysisPrompts } from './analyzer/prompts.js';
import { registerSkillTestCliSubcommands } from './skill-test-cli.js';
import type { SlashCommandHandler } from '../../tui/commands/index.js';
import type { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import { skillRegistry } from './utils/skill-registry.js';
import { skillInstallManager } from './utils/skill-installer.js';
import { SkillExternalPathsConfigSchema } from './skill-schema.js';
import {
    runPluginAfterSkillInstall,
    runPluginAfterSkillList,
    runPluginBeforeSkillInstall
} from '../pluginmgr/runtime/hooks.js';
import type { PluginSkillInstallContext, PluginSkillListItem } from '../../../../packages/plugin-sdk/src/index.js';
import { getProvidedSkillRegistryDefinitions } from './registry/provider.js';
import { serializeSkillRegistryInfo, type PluginSkillRegistryInfo } from './registry/contributed.js';
import type { SearchOptions, SearchResult } from './registry/base.js';
import { ApplicationRegistry } from '../registry.js';
import type { McpMgrApplication } from '../mcpmgr/app.js';
import { flattenSchemaParams } from '../../../common/utils/schema-params.js';
import { PLUGIN_SKILL_MCP_TOOLSET_PREFIX } from '../pluginmgr/runtime/skill-mcp.js';
import { getHarmonyLocalRuntimeState } from '../../../platforms/bridges/harmonyos/local-runtime.js';

const isHarmonyosRuntime = (process.platform as string) === 'openharmony';

interface SkillWorkerResponse<T> {
    status: 'ok' | 'error';
    data?: T;
    message?: string;
}

export interface SkillInstallResult {
    success: boolean;
    name?: string;
    error?: string;
}

/** 插件技能内部 MCP 已发现工具的展平形态（技能中心工具列表用） */
interface McpPluginSkillTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

/**
 * agentoffice staff 智能体的技能 bundle 前缀（CustomAgent 的 skillBundleName: `staff:<staffId>`，
 * 见 agentoffice/app.ts createStaffAgent）。这类技能只服务于对应 staff 智能体自身，
 * 技能中心（GUI/TUI）不展示。
 */
export function isStaffSkillBundle(bundleName: string): boolean {
    return bundleName.startsWith('staff:');
}

/**
 * 从 MCPMgr 查询插件技能内部 MCP server 已发现的工具，按 `pluginId/技能名` 分组。
 * 仅包含当前已连接 server 的工具快照（连接是懒加载的，技能加载/详情展示后才产生条目）。
 */
async function getPluginSkillMcpToolIndex(): Promise<Map<string, McpPluginSkillTool[]>> {
    const index = new Map<string, McpPluginSkillTool[]>();
    try {
        const mcpMgr = ApplicationRegistry.getApplication('mcpmgr') as McpMgrApplication | undefined;
        if (!mcpMgr) return index;
        for (const server of await mcpMgr.getPluginSkillServers()) {
            if (!server.pluginId || !server.pluginSkillName) continue;
            const key = `${server.pluginId}/${server.pluginSkillName}`;
            const tools = index.get(key) ?? [];
            for (const tool of server.tools ?? []) {
                tools.push({
                    name: tool.name,
                    description: tool.description,
                    inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>
                });
            }
            index.set(key, tools);
        }
    } catch (error) {
        logger.warn('[skillmgr] Failed to query plugin skill MCP tools', error);
    }
    return index;
}

/**
 * 技能中心「内置技能」Tab 的条目契约（桌面端渲染层与 CLI TUI 共用）。
 * 与 getBuiltinSkills 返回的数组元素结构一致。
 */
export interface BuiltinSkillInfo {
    id: string;
    name: string;
    description: string;
    bundleName: string;
    pluginId?: string;
    pluginName?: string;
    /** 插件来源类型（builtin=内置插件 / local=后装插件）；内置应用池等宿主技能无此字段 */
    pluginSource?: PluginSourceKind;
    tools: Array<{
        name: string;
        description: string;
        params: Array<{ name: string; type: string; description: string; required: boolean }>;
    }>;
    directory?: string;
    license?: string;
    compatibility?: string;
    readOnly: boolean;
    enabled: boolean;
    blacklisted: boolean;
    blacklistEvidence: string;
    blacklistReason: string;
    blockedAt: string;
}

export async function installSkillInMain<T extends SkillInstallResult>(
    context: PluginSkillInstallContext,
    install: () => Promise<T>
): Promise<T> {
    const decision = await runPluginBeforeSkillInstall(context);
    if (decision.operation === 'deny') {
        throw new Error(decision.message || t('skill.install.denied'));
    }

    const result = await install();
    if (result.success) {
        await runPluginAfterSkillInstall({ ...context, skillName: result.name ?? '' });
    }
    return result;
}

async function installSkillThroughWorker(
    application: Pick<BaseApplication, 'callWorker'>,
    context: PluginSkillInstallContext,
    methodName: string,
    ...args: unknown[]
): Promise<{ name: string }> {
    const decision = await runPluginBeforeSkillInstall(context);
    if (decision.operation === 'deny') {
        throw new Error(decision.message || t('skill.install.denied'));
    }

    const response = (await application.callWorker(methodName, ...args)) as SkillWorkerResponse<{ name?: string }>;
    if (response.status !== 'ok') {
        throw new Error(response.message || t('skill.install.failed'));
    }

    const name = response.data?.name ?? '';
    await runPluginAfterSkillInstall({ ...context, skillName: name });
    return { name };
}

function shouldRegisterHarmonyLocalRuntimeSkills(): boolean {
    return isHarmonyosRuntime && getHarmonyLocalRuntimeState()?.variant === 'pc';
}

function buildSkillListHookSnapshot(): PluginSkillListItem[] {
    return skillRegistry.listSkills().flatMap((skill) => {
        const source = skill.source;
        if (source !== 'installed' && source !== 'config' && source !== 'mounted') {
            return [];
        }

        const id = typeof skill.id === 'string' ? skill.id : '';
        if (!id) return [];

        const cached = skillRegistry.getSkillBody(id);
        if (!cached?.skillDir) return [];

        const name = typeof skill.name === 'string' && skill.name ? skill.name : id;

        return [
            {
                name,
                directory: cached.skillDir,
                source,
                enabled: getSkillStatus(id) && !isBlacklisted('skillmgr', name)
            }
        ];
    });
}

export class SkillMgrApplication extends BaseApplication {
    /** 静态回调列表：refresh 后通知订阅方（如 TUI 自动补全）*/
    private static refreshListeners: Array<() => void> = [];
    private skillListInitialization?: Promise<void>;

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
        if (bundleName === 'skillmgr') {
            void runPluginAfterSkillList(buildSkillListHookSnapshot());
        }
    }

    notifyExternalSkillsChanged(bundleName: string): void {
        SkillMgrApplication.notifySkillsChanged(bundleName);
        this.sendEventToSubscribers('skillsChanged');
    }

    constructor() {
        super('skillmgr');

        this.analyzer = new SkillAnalyzer((status) => {
            this.emitEvent('analysisStatusChanged', status).catch(() => {});
        });

        // 将 skill 目录注册为全局可读，确保所有模式下 agent 都能读取 skill 文件
        this.registerReadableSkillDirectories();
    }

    getName(): string {
        return t('app.name');
    }

    private registerReadableSkillDirectories(): void {
        const readableRegistry = ReadableDirectoryRegistry.getInstance();
        // 内置技能与用户技能目录是框架自管的固定根（体积可控、语义上就是“技能区”），
        // 保留整根只读放行：未加载技能前直接探查 SKILL.md 也不需要额外确认。
        readableRegistry.register(skillRegistry.getBundledSkillsDirectory());
        readableRegistry.register(skillRegistry.getSkillsDirectory());
        // external_paths / --mount-skill 目录不再整根放行：
        // - 它们可以是任意大的用户目录（配置目录按递归扫描，用户可能直接指向 D:/work 甚至家目录），
        //   整根设为全局可读属于过度授权；
        // - 它们运行期可变，而本方法只在应用构造时执行一次，改了配置也不会重新注册，
        //   注册结果与实际情况不一致。
        // 其中的技能在被 LoadSkill 加载时会按 skill.directory 精确开放自身目录，
        // 见 aikernel/skill.ts 的 makeSkillDirectoryReadable。

        // 注册 skill filter，按 status.json 过滤禁用的技能
        AISkillRegistry.registerSkillFilter((bundleName: string, skillName: string) =>
            getSkillStatus(`${bundleName}/${skillName}`)
        );

        // 注册黑名单 filter：被用户加入黑名单的 skill 也被禁用（优先级高于 status.json）
        AISkillRegistry.registerSkillFilter(
            (bundleName: string, skillName: string) => !isBlacklisted(bundleName, skillName)
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
                repeated: true,
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
                        result = await installSkillInMain(
                            { source: 'directory', path: resolved, force },
                            async () => await skillInstallManager.installFromDirectory(resolved, { force })
                        );
                    } else if (stat.isFile() && resolved.toLowerCase().endsWith('.zip')) {
                        console.log(`正在从本地 zip 文件安装技能: ${resolved}`);
                        result = await installSkillInMain(
                            { source: 'zip', path: resolved, force },
                            async () => await skillInstallManager.installFromLocalZip(resolved, undefined, { force })
                        );
                    } else {
                        console.error('✗ 本地文件必须是目录或 .zip 格式');
                        process.exit(1);
                        return;
                    }
                } else if (source.startsWith('http://') || source.startsWith('https://')) {
                    console.log(`正在从 URL 下载并安装技能: ${source}`);
                    result = await installSkillInMain(
                        { source: 'url', url: source, force },
                        async () => await skillInstallManager.installFromUrl(source, { force })
                    );
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
                const result = skillInstallManager.deleteSkill(skillName);
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
            .action((opts: { json?: boolean }, command: Command) => {
                useCliTransport();
                useConsoleTransport();
                const globalOpts = command.optsWithGlobals() as Record<string, unknown>;
                const mounted = globalOpts.skillmgrMountSkill;
                const mountedDirs = Array.isArray(mounted) ? mounted : mounted ? [mounted] : [];
                for (const dir of mountedDirs) {
                    if (typeof dir === 'string') skillRegistry.addMountedDir(dir);
                }
                if (mountedDirs.length > 0) skillRegistry.refresh();
                const skills = skillRegistry.listSkills();
                const skillsDir = skillRegistry.getSkillsDirectory();

                const enriched = skills.map((s: any) => {
                    const skillBody = skillRegistry.getSkillBody(String(s.id ?? s.name));
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

        registerSkillTestCliSubcommands(skillCmd);
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
        return [
            { eventName: 'analysisStatusChanged', eventDescription: '技能分析状态变更通知' },
            { eventName: 'skillsChanged', eventDescription: '技能列表变更通知（黑名单增删、启用/禁用等）' }
        ];
    }

    // ── 黑名单管理（安全网关归因后由 main.ts 转发调用） ──

    /**
     * 将若干 skill 加入黑名单，并通知所有订阅者（skillmgr iframe、AI SkillRegistry）刷新。
     * 恶意技能检测开关的判定由调用方（main.ts IPC handler）负责，此处只做纯写入 + 通知。
     */
    addSkillsToBlacklist(
        items: Array<{ bundleName: string; skillName: string; reason: string; evidence: string }>
    ): void {
        let added = 0;
        let skipped = 0;
        for (const item of items) {
            // 内置技能忽略拉黑（addToBlacklist 内部也会再判一次，这里提前过滤避免误导通知）
            if (!isUserInstalledSkill(item.skillName)) {
                skipped++;
                continue;
            }
            addToBlacklist(item.bundleName, item.skillName, item.reason, item.evidence);
            added++;
            NotificationManager.getInstance().info(
                '黑名单',
                '技能已加入黑名单',
                `已将 ${item.bundleName}/${item.skillName} 加入黑名单，该技能将无法再被加载。`
            );
        }
        if (skipped > 0) {
            NotificationManager.getInstance().info(
                '黑名单',
                '已忽略内置技能',
                `${skipped} 个内置技能未被加入黑名单（内置技能不参与恶意检测拉黑）。`
            );
        }
        if (added === 0) return; // 全是内置/外部，无需刷新
        // 清理 AI SkillRegistry 缓存，使黑名单 filter 立即生效
        SkillMgrApplication.notifySkillsChanged();
        // 通过 application 事件通道推送 skillsChanged 到订阅的渲染帧（skillmgr iframe 已订阅）
        this.sendEventToSubscribers('skillsChanged');
    }

    /**
     * 清除指定任务的拦截记录（用户在黑名单弹窗选择忽略时调用）。
     */
    dismissInterceptions(taskId: string): void {
        clearInterceptionRecords(taskId);
    }

    /**
     * 清除全部拦截记录（存储超限清理时与 AgentGate tool_calls 联动）。
     * 返回清除的文件数，供调用方展示。
     */
    clearAllInterceptionRecords(): number {
        return clearAllInterceptionRecordsImpl();
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

    async runSkillTests(skillIds: string[], concurrency: number = 5, options: RunTestOptions = {}) {
        return this.analyzer.runTests(skillIds, concurrency, options);
    }

    async runUnpassedSkillTests(skillIds: string[], concurrency: number = 5, options: RunTestOptions = {}) {
        return this.analyzer.runUnpassedTests(skillIds, concurrency, options);
    }

    async runSingleSkillTest(skillId: string, testCaseIndex: number, options: RunTestOptions = {}) {
        return this.analyzer.runSingleTest(skillId, testCaseIndex, options);
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

    async exportAnalyzePage(filePath: string, skillIds?: string[]) {
        return this.analyzer.exportAnalyzePage(filePath, skillIds);
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
            ...skillRegistry
                .listSkills()
                .filter((skill) => getSkillStatus(skill.id))
                .map((skill) => {
                    const skillBody = skillRegistry.getSkillBody(skill.id);
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
        skillRegistry.refresh();
        SkillMgrApplication.notifySkillsChanged(this.bundleName);
    }

    getSkillsDirectory(): string {
        return skillRegistry.getSkillsDirectory();
    }

    getBundledSkillsDirectory(): string {
        return skillRegistry.getBundledSkillsDirectory();
    }

    listSkills() {
        return skillRegistry.listSkills();
    }

    async ensureLoaded(): Promise<void> {
        this.skillListInitialization ??= Promise.resolve().then(async () => {
            await runPluginAfterSkillList(buildSkillListHookSnapshot());
        });
        await this.skillListInitialization;
    }

    async getSkillDetailForReference(bundleName: string, skillName: string) {
        const skill = await AISkillRegistry.getInstance().getSkill(bundleName, skillName);
        if (!skill) return null;
        return {
            id: `${bundleName}/${skillName}`,
            name: skill.frontmatter.name,
            description: skill.frontmatter.description || '',
            body: skill.body,
            directory: skill.directory || ''
        };
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
     * 获取所有系统内置技能，供技能中心的"内置技能"Tab 使用。
     * 对于 skillmgr bundle，排除用户安装的技能和 manage-skills；
     * agentoffice staff 智能体的技能（staff:<id> bundle）只服务于该智能体自己，不在技能中心展示。
     */
    async getBuiltinSkills(): Promise<BuiltinSkillInfo[]> {
        const registry = AISkillRegistry.getInstance();
        const allSkills = await registry.getAllSkillsRaw();
        const mcpToolIndex = await getPluginSkillMcpToolIndex();
        const result: BuiltinSkillInfo[] = [];
        for (const [bundleName, skills] of allSkills) {
            if (isStaffSkillBundle(bundleName)) continue;
            for (const skill of skills) {
                if (bundleName === 'skillmgr') continue;
                const tools: Array<{
                    name: string;
                    description: string;
                    params: Array<{ name: string; type: string; description: string; required: boolean }>;
                }> = [];
                if (skill.toolsets) {
                    for (const toolset of skill.toolsets) {
                        // 插件技能的内部 MCP 工具集：模型加载技能时 resolver 会把它写回
                        // Skill.toolsets，而下方索引来源已按原始工具名展示同一批工具，
                        // 跳过避免同一工具出现两行（索引取自 worker 实时状态，比加载时快照更新）
                        if (skill.attribution && toolset.name.startsWith(PLUGIN_SKILL_MCP_TOOLSET_PREFIX)) {
                            continue;
                        }
                        for (const [, tool] of toolset.tools) {
                            tools.push({
                                name: tool.name,
                                description: tool.description,
                                params: flattenSchemaParams(tool.getJsonSchema())
                            });
                        }
                    }
                }
                // 插件技能：把内部挂载的 MCP 工具展平为普通工具展示（仅已连接 server 的已发现工具）。
                // 按名去重：与静态工具同名的 MCP 工具在模型侧会带 server 前缀消歧
                // （如静态 `echo` + MCP `echo` -> `fs__echo`），这里跳过已列出的名字，
                // 避免两行同名工具
                if (skill.attribution) {
                    const mcpTools = mcpToolIndex.get(`${skill.attribution.sourceId}/${skill.frontmatter.name}`) ?? [];
                    const listedNames = new Set(tools.map((tool) => tool.name));
                    for (const mcpTool of mcpTools) {
                        if (listedNames.has(mcpTool.name)) continue;
                        listedNames.add(mcpTool.name);
                        tools.push({
                            name: mcpTool.name,
                            description: mcpTool.description,
                            params: flattenSchemaParams(mcpTool.inputSchema)
                        });
                    }
                }
                const skillId = `${bundleName}/${skill.frontmatter.name}`;
                const blacklisted = isBlacklisted(bundleName, skill.frontmatter.name);
                const blacklistData = blacklisted
                    ? getAllBlacklisted()[`${bundleName}/${skill.frontmatter.name}`]
                    : null;
                result.push({
                    id: skillId,
                    name: skill.frontmatter.name,
                    description: skill.frontmatter.description || '',
                    bundleName,
                    pluginId: skill.attribution?.sourceId,
                    pluginName: skill.attribution?.sourceName,
                    pluginSource: skill.attribution?.sourceKind,
                    tools,
                    directory: skill.directory || undefined,
                    license: skill.frontmatter.license || undefined,
                    compatibility: skill.frontmatter.compatibility || undefined,
                    readOnly: skill.readOnly,
                    enabled: getSkillStatus(skillId) && !blacklisted,
                    blacklisted,
                    blacklistEvidence: blacklistData?.evidence || '',
                    blacklistReason: blacklistData?.reason || '',
                    blockedAt: blacklistData?.blockedAt || ''
                });
            }
        }
        return result;
    }

    /**
     * 技能详情展示前的懒加载触发点：确保指定插件技能的内部 MCP server 已连接，
     * 返回其已发现工具（展平为技能中心工具列表形态）。server 未配置或连接失败时返回空数组。
     */
    async revealPluginSkillTools(pluginId: string, skillName: string): Promise<BuiltinSkillInfo['tools']> {
        const mcpMgr = ApplicationRegistry.getApplication('mcpmgr') as McpMgrApplication | undefined;
        if (!mcpMgr) return [];
        try {
            const servers = await mcpMgr.revealPluginSkillServers(pluginId, skillName);
            const tools: BuiltinSkillInfo['tools'] = [];
            for (const server of servers) {
                for (const tool of server.tools ?? []) {
                    tools.push({
                        name: tool.name,
                        description: tool.description,
                        params: flattenSchemaParams((tool.inputSchema ?? {}) as Record<string, unknown>)
                    });
                }
            }
            return tools;
        } catch (error) {
            logger.warn(`[skillmgr] Failed to reveal plugin skill MCP tools for ${pluginId}/${skillName}`, error);
            return [];
        }
    }

    /**
     * 从 zip 文件路径安装技能，供渲染进程调用
     */
    async installSkillFromZip(zipPath: string, skillRelPath?: string) {
        const result = await installSkillInMain(
            { source: 'zip', path: zipPath, skillRelPath },
            async () => await skillInstallManager.installFromLocalZip(zipPath, skillRelPath)
        );
        if (result.success) {
            skillRegistry.refresh();
            SkillMgrApplication.notifySkillsChanged(this.bundleName);
        }
        return result;
    }

    async addFromZip(zipPath: string, skillRelPath?: string) {
        return await installSkillThroughWorker(
            this,
            { source: 'zip', path: zipPath, skillRelPath },
            'addFromZip',
            zipPath,
            skillRelPath
        );
    }

    async addSkillFromDirectory(sourceDirectory: string) {
        const result = await installSkillInMain(
            { source: 'directory', path: sourceDirectory },
            async () => await skillInstallManager.installFromDirectory(sourceDirectory)
        );
        if (result.success) {
            SkillMgrApplication.notifySkillsChanged(this.bundleName);
        }
        return result;
    }

    async addFromDirectory(sourceDirectory: string) {
        return await installSkillThroughWorker(
            this,
            { source: 'directory', path: sourceDirectory },
            'addFromDirectory',
            sourceDirectory
        );
    }

    async addSkillFromUrl(url: string) {
        const result = await installSkillInMain(
            { source: 'url', url },
            async () => await skillInstallManager.installFromUrl(url)
        );
        if (result.success) {
            SkillMgrApplication.notifySkillsChanged(this.bundleName);
        }
        return result;
    }

    async addFromUrl(url: string) {
        return await installSkillThroughWorker(this, { source: 'url', url }, 'addFromUrl', url);
    }

    async searchSkillFromRegistry(keyword: string) {
        const config = this.getConfig() as { skillsmp_api_key?: string } | undefined;
        return skillInstallManager.searchSkillsFromAllRegistries(keyword, {
            limit: 20,
            skillsmpApiKey: config?.skillsmp_api_key
        });
    }

    async addSkillFromRegistry(skillName: string, registryName: string, force: boolean = false) {
        const config = this.getConfig() as { skillsmp_api_key?: string } | undefined;
        const result = await installSkillInMain(
            { source: 'registry', url: `${registryName}:${skillName}`, force },
            async () =>
                await skillInstallManager.installSkillFromRegistryByName(registryName, skillName, {
                    force,
                    skillsmpApiKey: config?.skillsmp_api_key
                })
        );
        if (result.success) {
            SkillMgrApplication.notifySkillsChanged(this.bundleName);
        }
        return result;
    }

    async installFromRegistry(installUrl: string, force: boolean = false, customName?: string) {
        return await installSkillThroughWorker(
            this,
            { source: 'registry', url: installUrl, force, customName },
            'installFromRegistry',
            installUrl,
            force,
            customName
        );
    }

    // ── 插件贡献注册表的 worker 回代入口 ─────────────────────────────────
    // 插件注册表定义（含闭包）只在主进程存活；worker 线程的技能市场通过
    // registry/worker-bridge.ts 经 callAppWithResponse 调用以下三个方法。

    /** 列出插件贡献注册表的可序列化元数据（worker 侧据此渲染 tab 与路由安装） */
    async getPluginSkillRegistries(): Promise<PluginSkillRegistryInfo[]> {
        const definitions = await getProvidedSkillRegistryDefinitions();
        return definitions.map(serializeSkillRegistryInfo);
    }

    /** 代理执行插件注册表搜索（在主进程调用定义的 search） */
    async searchPluginSkillRegistry(registryId: string, opts: SearchOptions = {}): Promise<SearchResult> {
        const definitions = await getProvidedSkillRegistryDefinitions();
        const definition = definitions.find((candidate) => candidate.id === registryId);
        if (!definition) throw new Error(`未知 Registry: ${registryId}`);
        return definition.search(opts);
    }

    /** 解析插件注册表 installUrl 的下载地址；未声明 resolveInstall 时返回 null */
    async resolvePluginSkillInstall(
        registryId: string,
        installUrl: string,
        parsed: { slug: string; version?: string }
    ): Promise<{ downloadUrl: string } | null> {
        const definitions = await getProvidedSkillRegistryDefinitions();
        const definition = definitions.find((candidate) => candidate.id === registryId);
        if (!definition?.resolveInstall) return null;
        return definition.resolveInstall(installUrl, parsed);
    }

    deleteSkill(skillId: string) {
        const result = skillInstallManager.deleteSkill(skillId);
        if (result.success) {
            SkillMgrApplication.notifySkillsChanged(this.bundleName);
        }
        return result;
    }

    clearSkills() {}

    refresh() {
        const { toolsets, errors } = skillRegistry.refresh();
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
