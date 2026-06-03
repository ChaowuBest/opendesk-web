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
 * 技能分析器：依赖分析、测试用例生成、元数据导入导出
 *
 * 从 SkillMgrApplication 中抽离，保持分析逻辑的独立性和可测试性。
 */

import { SkillRegistry } from '../skillregistry.js';
import { GlobalState } from '../../../aikernel/states/global.js';
import { MainAgentDecl } from '../../../aikernel/agents/main/agent.js';
import { getPlatform } from '../../../../platforms/base.js';
import {
    loadAndValidateOpendeskMeta,
    tryLoadOpendeskMeta,
    formatValidationErrors,
    parseTestResult,
    OPENDESK_META_FILENAME,
    MAX_VALIDATION_RETRIES,
    MAX_TESTRESULT_RETRIES
} from './metadata.js';
import { logger } from '../../../utils/logger.js';
import { getTempDir } from '../../../utils/temp.js';
import path from 'path';
import fs from 'fs';
import os from 'os';
import AdmZip from 'adm-zip';
import type { OpendeskMeta, ValidationError, TestCase } from './metadata.js';

// ── 单条测试用例执行计划 ──

interface TestCasePlan {
    skillId: string;
    skillDir: string;
    skillName: string;
    testCase: TestCase;
}

// ── 分析状态类型 ──

export interface AnalyzeState {
    running: boolean;
    taskType: 'deps' | 'testgen' | 'testrun' | null;
    total: number;
    completed: number;
    currentSkill: string | null;
    runningTaskIds: Set<string>;
    results: Record<
        string,
        { dependencies?: Record<string, unknown>; testCases?: unknown[]; error?: string; analyzedAt?: number }
    >;
}

export interface AnalyzeStatus {
    running: boolean;
    taskType: 'deps' | 'testgen' | 'testrun' | null;
    total: number;
    completed: number;
    currentSkill: string | null;
    results: Record<
        string,
        { dependencies?: Record<string, unknown>; testCases?: unknown[]; error?: string; analyzedAt?: number }
    >;
}

/** 状态变更回调 */
export type StatusChangeCallback = (status: AnalyzeStatus) => void;

// ── SkillAnalyzer 类 ──

export class SkillAnalyzer {
    private state: AnalyzeState;
    private onStatusChange?: StatusChangeCallback;
    /** 当前正在执行的分析队列引用，用于 stop() 时清空 */
    private _currentQueue?: string[];

    constructor(onStatusChange?: StatusChangeCallback) {
        this.state = this._createInitialState();
        this.onStatusChange = onStatusChange;
    }

    // ── 状态查询 ──

    getStatus(): AnalyzeStatus {
        return {
            running: this.state.running,
            taskType: this.state.taskType,
            total: this.state.total,
            completed: this.state.completed,
            currentSkill: this.state.currentSkill,
            results: this.state.results
        };
    }

    // ── 获取已有技能元数据 ──

    getExistingSkillMetadatas(): Record<string, { dependencies?: Record<string, unknown>; testCases?: unknown[] }> {
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

    // ── 分析入口 ──

    async analyzeDependencies(skillIds: string[], concurrency: number = 5): Promise<AnalyzeStatus> {
        return this._startAnalysis(skillIds, concurrency, 'deps');
    }

    async generateTests(skillIds: string[], concurrency: number = 5): Promise<AnalyzeStatus> {
        return this._startAnalysis(skillIds, concurrency, 'testgen');
    }

    // ── 运行测试 ──

    async runTests(skillIds: string[], concurrency: number = 5): Promise<AnalyzeStatus> {
        if (!Array.isArray(skillIds) || skillIds.length === 0) throw new Error('请至少选择一个技能');
        if (this.state.running) throw new Error('分析或测试正在进行中，请等待完成后再发起');

        // 收集所有技能的测试用例
        const testPlan: TestCasePlan[] = [];
        for (const skillId of [...new Set(skillIds)]) {
            const detail = SkillRegistry.getSkillDetail(skillId);
            if (!detail?.skillDir) continue;
            const loadResult = tryLoadOpendeskMeta(detail.skillDir);
            if (!loadResult.success || !loadResult.data.testCases?.length) continue;
            const skillName = detail.name || skillId;
            for (const tc of loadResult.data.testCases) {
                testPlan.push({ skillId, skillDir: detail.skillDir, skillName, testCase: tc });
            }
        }

        if (testPlan.length === 0) throw new Error('所选技能没有可运行的测试用例');

        // 初始化状态，total = 测试用例数
        this.state = {
            running: true,
            taskType: 'testrun',
            total: testPlan.length,
            completed: 0,
            currentSkill: null,
            runningTaskIds: new Set(),
            results: { ...this.state.results }
        };

        // 预加载各技能的 testCases 到 results 中，供前端展示
        const skillTestCasesMap = new Map<string, TestCase[]>();
        for (const plan of testPlan) {
            if (!skillTestCasesMap.has(plan.skillId)) {
                skillTestCasesMap.set(plan.skillId, []);
            }
            skillTestCasesMap.get(plan.skillId)!.push({ ...plan.testCase });
        }
        for (const [skillId, testCases] of skillTestCasesMap) {
            if (!this.state.results[skillId]) {
                const detail = SkillRegistry.getSkillDetail(skillId);
                if (detail?.skillDir) {
                    const meta = tryLoadOpendeskMeta(detail.skillDir);
                    if (meta.success) {
                        this.state.results[skillId] = {
                            dependencies: meta.data.dependencies as Record<string, unknown> | undefined,
                            testCases: testCases as unknown[]
                        };
                    } else {
                        this.state.results[skillId] = { testCases: testCases as unknown[] };
                    }
                } else {
                    this.state.results[skillId] = { testCases: testCases as unknown[] };
                }
            } else if (!this.state.results[skillId].testCases) {
                this.state.results[skillId].testCases = testCases as unknown[];
            }
        }

        this._notifyStatusChange();
        this._runTestsInBackground(testPlan, concurrency);
        return this.getStatus();
    }

    // ── 单条测试执行 ──

    async runSingleTest(skillId: string, testCaseIndex: number): Promise<AnalyzeStatus> {
        if (this.state.running) throw new Error('分析或测试正在进行中，请等待完成后再发起');

        const detail = SkillRegistry.getSkillDetail(skillId);
        if (!detail?.skillDir) throw new Error(`技能 ${skillId} 不存在`);

        const skillName = detail.name || skillId;
        const loadResult = tryLoadOpendeskMeta(detail.skillDir);
        if (!loadResult.success || !loadResult.data.testCases?.length) {
            throw new Error(`技能「${skillName}」没有测试用例`);
        }

        const testCase = loadResult.data.testCases.find((tc) => tc.index === testCaseIndex);
        if (!testCase) throw new Error(`技能「${skillName}」中未找到编号为 ${testCaseIndex} 的测试用例`);

        const plan: TestCasePlan = {
            skillId,
            skillDir: detail.skillDir,
            skillName,
            testCase
        };

        // 初始化状态，total = 1（单条测试）
        this.state = {
            running: true,
            taskType: 'testrun',
            total: 1,
            completed: 0,
            currentSkill: skillId,
            runningTaskIds: new Set(),
            results: { ...this.state.results }
        };

        // 确保 results 中包含当前技能的 testCases，供前端展示
        if (!this.state.results[skillId]) {
            this.state.results[skillId] = {
                dependencies: loadResult.data.dependencies as Record<string, unknown> | undefined,
                testCases: loadResult.data.testCases as unknown[]
            };
        } else if (!this.state.results[skillId].testCases) {
            this.state.results[skillId].testCases = loadResult.data.testCases as unknown[];
        }

        this._notifyStatusChange();

        try {
            await this._runTestForCase(plan);
        } finally {
            this.state.running = false;
            this.state.runningTaskIds.clear();
            this.state.currentSkill = null;
            this._notifyStatusChange();
        }

        return this.getStatus();
    }

    // ── 停止分析 ──

    async stop(): Promise<void> {
        if (!this.state.running) return;
        const taskManager = GlobalState.getInstance().taskManagerState;
        for (const taskId of this.state.runningTaskIds) {
            try {
                // 1) 立即关闭运行标志，阻止 worker 循环取新任务
                this.state.running = false;

                // 2) 清空队列，防止已经 shift 出队列的 worker 继续提交新任务
                if (this._currentQueue) {
                    this._currentQueue.length = 0;
                    this._currentQueue = undefined;
                }

                // 3) 停止所有正在运行的 Agent 任务
                const t = taskManager.getTask(taskId);
                if (t) t.stop('system');
            } catch {
                /* ignore */
            }
        }
        this.state.runningTaskIds.clear();
        this.state.currentSkill = null;
        this._notifyStatusChange();
    }

    // ── 元数据导出 ──

    async exportMetadatas(
        skillIds: string[],
        zipFilePath: string
    ): Promise<{ success: boolean; successCount: number; errorCount: number; errors: string[] }> {
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

    // ── 元数据删除 ──

    deleteMetadatas(skillIds: string[]): { success: boolean; deleted: number; notFound: number; errors: string[] } {
        const errors: string[] = [];
        let deleted = 0;
        let notFound = 0;

        for (const skillId of skillIds) {
            try {
                const detail = SkillRegistry.getSkillDetail(skillId);
                if (!detail?.skillDir) {
                    notFound++;
                    continue;
                }
                const metaPath = path.join(detail.skillDir, OPENDESK_META_FILENAME);
                if (!fs.existsSync(metaPath)) {
                    notFound++;
                    continue;
                }
                fs.unlinkSync(metaPath);
                deleted++;
            } catch (e) {
                errors.push(`${skillId}: ${(e as Error).message}`);
            }
        }

        return { success: errors.length === 0, deleted, notFound, errors };
    }

    // ── 元数据导入 ──

    async importMetadatas(zipFilePath: string): Promise<{
        success: boolean;
        successCount: number;
        failedCount: number;
        skippedCount: number;
        details: Array<{ skillName: string; status: 'success' | 'failed' | 'skipped'; message: string }>;
        error?: string;
    }> {
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
                const skillName = entry.entryName.replace(/_(meta|metadata)\.json$/i, '');

                try {
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

                    try {
                        JSON.parse(content);
                    } catch {
                        failedCount++;
                        details.push({ skillName, status: 'failed', message: '元数据文件不是有效的 JSON' });
                        continue;
                    }

                    fs.writeFileSync(metaPath, content, 'utf-8');
                    successCount++;
                    details.push({ skillName, status: 'success', message: '导入成功' });
                } catch (e) {
                    failedCount++;
                    details.push({ skillName, status: 'failed', message: (e as Error).message });
                }
            }
        } finally {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch {
                /* ignore */
            }
        }

        return { success: true, successCount, failedCount, skippedCount, details };
    }

    // ── 内部实现 ──

    private _createInitialState(): AnalyzeState {
        return {
            running: false,
            taskType: null,
            total: 0,
            completed: 0,
            currentSkill: null,
            runningTaskIds: new Set(),
            results: {}
        };
    }

    private _notifyStatusChange(): void {
        if (this.onStatusChange) {
            try {
                this.onStatusChange(this.getStatus());
            } catch {
                /* ignore */
            }
        }
    }

    private async _startAnalysis(
        skillIds: string[],
        concurrency: number,
        taskType: 'deps' | 'testgen'
    ): Promise<AnalyzeStatus> {
        if (!Array.isArray(skillIds) || skillIds.length === 0) throw new Error('请至少选择一个技能');
        if (this.state.running) throw new Error('分析正在进行中，请等待完成后再发起');

        const targetIds = [...new Set(skillIds)];
        const maxConcurrency = Math.max(1, concurrency);

        this.state = {
            running: true,
            taskType,
            total: targetIds.length,
            completed: 0,
            currentSkill: null,
            runningTaskIds: new Set(),
            results: { ...this.state.results }
        };
        this._notifyStatusChange();

        this._runAnalysisInBackground(targetIds, maxConcurrency, taskType);
        return this.getStatus();
    }

    private async _runAnalysisInBackground(
        skillIds: string[],
        concurrency: number,
        taskType: 'deps' | 'testgen'
    ): Promise<void> {
        const queue = [...skillIds];
        this._currentQueue = queue;
        const worker = async () => {
            while (queue.length > 0 && this.state.running) {
                const sid = queue.shift();
                if (!sid || !this.state.running) break;
                if (taskType === 'deps') await this._analyzeDepsForSkill(sid);
                else await this._generateTestsForSkill(sid);
            }
        };
        try {
            await Promise.all(Array.from({ length: concurrency }, () => worker()));
        } catch (err) {
            logger.error(`分析出错: ${(err as Error)?.message || String(err)}`);
        } finally {
            this._currentQueue = undefined;
            for (const taskId of this.state.runningTaskIds) {
                try {
                    const t = GlobalState.getInstance().taskManagerState.getTask(taskId);
                    if (t) t.stop('system');
                } catch {
                    /* ignore */
                }
            }
            this.state.running = false;
            this.state.runningTaskIds.clear();
            this.state.currentSkill = null;
            this._notifyStatusChange();
        }
    }

    private async _analyzeDepsForSkill(skillId: string): Promise<void> {
        await this._createSkillAgentTask(
            skillId,
            '依赖',
            (d, n) => this._buildDepsPrompt(d, n),
            (d, meta) => {
                this.state.results[skillId] = meta.dependencies
                    ? {
                          dependencies: meta.dependencies as Record<string, unknown>,
                          testCases: meta.testCases as unknown[] | undefined,
                          analyzedAt: Date.now()
                      }
                    : { error: 'opendesk_meta.json 未包含有效的依赖项', analyzedAt: Date.now() };
            }
        );
    }

    private async _generateTestsForSkill(skillId: string): Promise<void> {
        await this._createSkillAgentTask(
            skillId,
            '测试用例',
            (d, n) => this._buildTestsPrompt(d, n),
            (d, meta) => {
                this.state.results[skillId] = meta.testCases?.length
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
        handleResult: (d: string, meta: OpendeskMeta) => void
    ): Promise<void> {
        // 已被停止则不再创建新任务
        if (!this.state.running) return;

        this.state.currentSkill = skillId;
        this._notifyStatusChange();

        const detail = SkillRegistry.getSkillDetail(skillId);
        if (!detail?.skillDir) {
            this.state.results[skillId] = { error: '无法获取技能目录', analyzedAt: Date.now() };
            // completed++ 由 finally 块统一处理，此处不重复递增
            return;
        }

        const skillDir = detail.skillDir;
        const skillName = detail.name || skillId;

        // ── 创建 Agent 任务（只创建一次，重试时复用同一 task）──
        const tm = GlobalState.getInstance().taskManagerState;
        const agent = new MainAgentDecl();
        const mode = agent.supportedModes().find((m) => m.id === 'solo') ?? agent.supportedModes()[0];
        const task = tm.createTask();
        task.task_name = `[分析技能${taskLabel}] ${skillName}`;
        this.state.runningTaskIds.add(task.task_id);

        try {
            await tm.initHarness(task, getPlatform().getEffectiveWorkspace(), mode);
            task.setSystemPrompt(await agent.createSystemPrompt(mode, task));
            await task.hooks.noticeBeforeTaskStart(task);

            // 提交初始提示词
            await task.submitUserMessage(buildPrompt(skillDir, skillName));
            await task.waitUntilFinished();

            // ── 校验重试循环（同一 task 内追加消息）──
            for (let attempt = 0; attempt < MAX_VALIDATION_RETRIES; attempt++) {
                if (!this.state.running) {
                    this.state.runningTaskIds.delete(task.task_id);
                    return;
                }

                const loadResult = tryLoadOpendeskMeta(skillDir);
                if (loadResult.success) {
                    this.state.runningTaskIds.delete(task.task_id);
                    handleResult(skillDir, loadResult.data);
                    // completed++ 由 finally 块统一处理，此处不重复递增
                    return;
                }

                // 校验失败 — 在同一 task 中追加修正消息
                logger.warn(
                    `[SkillAnalyzer] ${skillName} ${taskLabel}分析结果校验失败（第${attempt + 1}次），` +
                        `错误: ${loadResult.error}，将发起第${attempt + 1}次修正重试`
                );

                const fixPrompt = this._buildFixPrompt(
                    skillDir,
                    skillName,
                    taskLabel,
                    loadResult.error,
                    loadResult.validationErrors
                );
                await task.submitUserMessage(fixPrompt);
                await task.waitUntilFinished();
            }

            // 已达最大重试次数
            const finalResult = tryLoadOpendeskMeta(skillDir);
            const errorDetail = finalResult.validationErrors?.length
                ? `\n校验错误详情：\n${formatValidationErrors(finalResult.validationErrors)}`
                : '';
            this.state.results[skillId] = {
                error: `${taskLabel}分析结果校验失败（已重试${MAX_VALIDATION_RETRIES}次）: ${finalResult.error}${errorDetail}`,
                analyzedAt: Date.now()
            };
        } catch (err) {
            // Agent 执行异常
            this.state.results[skillId] = {
                error: `Agent 失败: ${(err as Error)?.message}`,
                analyzedAt: Date.now()
            };
        } finally {
            this.state.runningTaskIds.delete(task.task_id);
            this.state.completed++;
            this._notifyStatusChange();
        }
    }

    /**
     * 构建修正提示词，将校验错误发回 agent 要求修正。
     */
    private _buildFixPrompt(
        skillDir: string,
        skillName: string,
        taskLabel: string,
        error: string,
        validationErrors?: ValidationError[]
    ): string {
        const errorDetail =
            validationErrors && validationErrors.length > 0
                ? `\n具体校验错误如下：\n${formatValidationErrors(validationErrors)}`
                : `\n错误原因：${error}`;

        return `上一次生成的 ${OPENDESK_META_FILENAME} 未通过校验，请修正以下问题后重新写入。

技能: ${skillName}
目录: ${skillDir}
任务类型: ${taskLabel}分析
目标文件: ${skillDir}/${OPENDESK_META_FILENAME}
${errorDetail}

请修正以上所有错误，确保 JSON 格式正确、所有必填字段完整、数据类型符合要求。
完成后请确认文件已正确写入。`;
    }

    // ── Prompt 构建 ──

    private _buildDepsPrompt(skillDir: string, skillName: string): string {
        return `请分析以下技能目录的依赖项，写入 ${skillDir}/${OPENDESK_META_FILENAME}。

技能: ${skillName}
目录: ${skillDir}

重要说明：技能分析的入口文件是 SKILL.md（位于 ${skillDir}/SKILL.md），请首先阅读它来了解技能的功能。

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

重要说明：
- 技能分析的入口文件是 SKILL.md（位于 ${skillDir}/SKILL.md），请首先阅读它来了解技能的功能、参数和使用方式
- **测试 Prompt** 的定义：测试 Prompt 是发送给大模型的任务描述，让大模型通过调用被测试的 skill 来完成指定任务。它本质上是一个自然语言指令，大模型收到后会调用该 skill 的工具来执行操作
- 每个测试用例的 prompt 字段应描述一个具体的用户请求场景，大模型可据此调用 skill 完成验证

步骤：
1. 读取 ${skillDir}/SKILL.md 和所有实现文件，全面理解技能功能、参数、返回值和使用场景
2. 尽可能覆盖所有场景：正常流程、边界条件、异常输入、错误处理、多参数组合、网络异常、权限不足等
3. 将测试用例写入 ${skillDir}/${OPENDESK_META_FILENAME}，JSON 格式如下：

{
  "testCases": [
    {
      "index": 1,
      "title": "基本功能测试 - 输入有效参数应返回正确结果",
      "prompt": "请使用 ${skillName} 技能，帮我完成 XXX 任务（具体参数为...）",
      "expectedResult": "返回 { result: 3 }，状态码 200",
      "status": "pending"
    },
    {
      "index": 2,
      "title": "边界条件 - 空输入应返回错误提示",
      "prompt": "请使用 ${skillName} 技能，但不提供任何必填参数",
      "expectedResult": "返回明确的错误信息，不崩溃",
      "status": "pending"
    }
  ]
}

注意：
- index 必须为正整数，从 1 开始递增，每个测试用例唯一
- title 要简洁描述测试的核心目标和条件
- prompt 是发送给大模型的具体任务描述，让大模型调用被测 skill 来完成任务，要详细到可执行
- expectedResult 明确描述期望的输出、行为变化或副作用
- status 统一设为 "pending"
- 覆盖全面：基本功能、边界条件、错误处理、异常输入、性能退化等
- 已有 dependencies 保留不动，只更新或添加 testCases 字段
- 生成测试用例时，从 SKILL.md 开始阅读技能文档，了解技能的工具定义和调用方式后再设计 prompt
完成后请确认文件已正确写入。`;
    }

    // ── 测试运行（内部） ──

    private async _runTestsInBackground(testPlan: TestCasePlan[], concurrency: number): Promise<void> {
        const queue = [...testPlan];
        this._currentQueue = []; // 仅用于 stop() 检测

        const worker = async () => {
            while (queue.length > 0 && this.state.running) {
                const plan = queue.shift();
                if (!plan || !this.state.running) break;
                await this._runTestForCase(plan);
            }
        };

        try {
            await Promise.all(Array.from({ length: concurrency }, () => worker()));
        } catch (err) {
            logger.error(`测试运行出错: ${(err as Error)?.message || String(err)}`);
        } finally {
            this._currentQueue = undefined;
            for (const taskId of this.state.runningTaskIds) {
                try {
                    const t = GlobalState.getInstance().taskManagerState.getTask(taskId);
                    if (t) t.stop('system');
                } catch {
                    /* ignore */
                }
            }
            this.state.running = false;
            this.state.runningTaskIds.clear();
            this.state.currentSkill = null;
            this._notifyStatusChange();
        }
    }

    /**
     * 执行单个测试用例：创建 Agent 任务 → 发送测试 Prompt → 等待完成 →
     * 追加验证消息 → 解析 JSON → 更新状态
     */
    private async _runTestForCase(plan: TestCasePlan): Promise<void> {
        if (!this.state.running) return;

        this.state.currentSkill = plan.skillId;
        this._notifyStatusChange();

        const { skillId, skillDir, skillName, testCase } = plan;
        const tcIndex = testCase.index;

        const tm = GlobalState.getInstance().taskManagerState;
        const agent = new MainAgentDecl();
        const mode = agent.supportedModes().find((m) => m.id === 'solo') ?? agent.supportedModes()[0];
        const task = tm.createTask();
        task.task_name = `[测试] ${skillName} #${tcIndex}: ${testCase.title}`;
        this.state.runningTaskIds.add(task.task_id);

        // 为每个测试用例创建独立的临时工作空间，避免并行任务之间的文件冲突
        const tempWorkspace = fs.mkdtempSync(path.join(getTempDir(), 'skill-test-'));

        try {
            await tm.initHarness(task, tempWorkspace, mode);
            task.setSystemPrompt(await agent.createSystemPrompt(mode, task));
            await task.hooks.noticeBeforeTaskStart(task);

            // 第一步：发送测试执行 Prompt
            await task.submitUserMessage(this._buildTestRunPrompt(skillDir, skillName, testCase));
            await task.waitUntilFinished();

            if (!this.state.running) {
                this.state.runningTaskIds.delete(task.task_id);
                return;
            }

            // 第二步：追加验证消息，要求 agent 输出 JSON 结果
            for (let attempt = 0; attempt < MAX_TESTRESULT_RETRIES; attempt++) {
                if (!this.state.running) {
                    this.state.runningTaskIds.delete(task.task_id);
                    return;
                }

                await task.submitUserMessage(this._buildTestVerifyPrompt(skillName, testCase, attempt > 0));
                await task.waitUntilFinished();

                if (!this.state.running) {
                    this.state.runningTaskIds.delete(task.task_id);
                    return;
                }

                // 从 agent 最后一条回复中提取 TestResult JSON
                const lastMsg = this._getLastAssistantMessage(task);
                const parseResult = parseTestResult(lastMsg);

                if (parseResult.success) {
                    // 更新状态
                    this._updateTestCaseStatus(skillId, skillDir, tcIndex, parseResult.data, task.task_id);
                    break;
                }

                // 解析/校验失败
                if (attempt >= MAX_TESTRESULT_RETRIES - 1) {
                    // 达到最大重试次数，标记为失败
                    this._updateTestCaseStatus(
                        skillId,
                        skillDir,
                        tcIndex,
                        {
                            result: 'failed',
                            message: `Agent 未返回有效的测试结果 JSON（已重试${MAX_TESTRESULT_RETRIES}次）: ${parseResult.error}`
                        },
                        task.task_id
                    );
                }
            }
        } catch (err) {
            this._updateTestCaseStatus(
                skillId,
                skillDir,
                tcIndex,
                {
                    result: 'failed',
                    message: `Agent 执行异常: ${(err as Error)?.message}`
                },
                task.task_id
            );
        } finally {
            // 清理临时工作空间
            try {
                fs.rmSync(tempWorkspace, { recursive: true, force: true });
            } catch {
                /* 清理失败不影响主流程 */
            }
            this.state.runningTaskIds.delete(task.task_id);
            this.state.completed++;
            this._notifyStatusChange();
        }
    }

    /**
     * 获取 Agent 任务最后一条 assistant 消息的文本内容
     */
    private _getLastAssistantMessage(
        task: ReturnType<typeof GlobalState.getInstance>['taskManagerState']['tasks'][number]
    ): string {
        try {
            const messages = task.chat_context?.messages;
            if (!messages || messages.length === 0) return '';
            // 从后往前找最后一条 assistant 消息
            for (let i = messages.length - 1; i >= 0; i--) {
                const msg = messages[i] as Record<string, unknown>;
                if (msg['role'] === 'assistant') {
                    const content = msg['content'];
                    if (typeof content === 'string') return content;
                    if (Array.isArray(content)) {
                        // 处理多 part 内容
                        const textParts = (content as Array<Record<string, unknown>>)
                            .filter((p) => p['type'] === 'text')
                            .map((p) => String(p['text'] ?? ''));
                        return textParts.join('\n');
                    }
                }
            }
            return '';
        } catch {
            return '';
        }
    }

    /**
     * 更新测试用例状态：内存中的 results + 持久化到 opendesk_meta.json
     */
    private _updateTestCaseStatus(
        skillId: string,
        skillDir: string,
        testCaseIndex: number,
        testResult: { result: 'succeeded' | 'failed'; message: string },
        taskId?: string
    ): void {
        // 更新内存中的 results
        const resultEntry = this.state.results[skillId];
        if (resultEntry?.testCases) {
            const tcs = resultEntry.testCases as Array<Record<string, unknown>>;
            for (const tc of tcs) {
                if (tc['index'] === testCaseIndex) {
                    tc['status'] = testResult.result === 'succeeded' ? 'passed' : 'failed';
                    if (testResult.result === 'succeeded') {
                        tc['actualResult'] = testResult.message;
                        delete tc['error'];
                    } else {
                        tc['error'] = testResult.message;
                    }
                    if (taskId) {
                        tc['taskId'] = taskId;
                    }
                    break;
                }
            }
        }

        // 持久化到 opendesk_meta.json
        try {
            const metaPath = path.join(skillDir, OPENDESK_META_FILENAME);
            if (fs.existsSync(metaPath)) {
                const raw = fs.readFileSync(metaPath, 'utf-8');
                const meta = JSON.parse(raw);
                if (meta?.testCases && Array.isArray(meta.testCases)) {
                    for (const tc of meta.testCases) {
                        if (tc['index'] === testCaseIndex) {
                            tc['status'] = testResult.result === 'succeeded' ? 'passed' : 'failed';
                            if (testResult.result === 'succeeded') {
                                tc['actualResult'] = testResult.message;
                                delete tc['error'];
                            } else {
                                tc['error'] = testResult.message;
                            }
                            if (taskId) {
                                tc['taskId'] = taskId;
                            }
                            break;
                        }
                    }
                    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
                }
            }
        } catch (e) {
            logger.warn(`[SkillAnalyzer] 持久化测试结果失败: ${(e as Error).message}`);
        }
    }

    /**
     * 构建测试执行 Prompt：让 agent 阅读 SKILL.md 并执行测试用例中的任务
     */
    private _buildTestRunPrompt(skillDir: string, skillName: string, testCase: TestCase): string {
        return `你正在执行技能"${skillName}"的测试用例。

**技能 SKILL.md 路径**: ${skillDir}/SKILL.md
**技能目录**: ${skillDir}

**测试用例 #${testCase.index}**: ${testCase.title}

请按以下步骤操作：
1. 读取 ${skillDir}/SKILL.md，了解该技能的完整功能、参数和使用方式
2. 根据测试用例的 Prompt 执行任务：

> ${testCase.prompt}

请务必调用该技能提供的工具来完成上述任务，不要仅做文字分析。如果技能所需要的二进制命令或者Python包，NPM包等
三方依赖找不到，请尽量尝试自主安装。如果技能所需要的环境变量不存在则直接报错。

测试完成后，请简要描述你的执行过程和结果。`;
    }

    /**
     * 构建测试验证 Prompt：让 agent 对比执行结果和预期结果，输出 JSON
     */
    private _buildTestVerifyPrompt(skillName: string, testCase: TestCase, isRetry: boolean): string {
        const retryNote = isRetry
            ? '\n**注意：** 上一次你的回复中未能提取到有效的 JSON 结果。请确保本次回复**仅包含**一个 JSON 对象，不要包含任何其他解释。\n'
            : '';

        return `测试执行已完成。现在请对照预期结果进行验证，并**仅输出**以下格式的 JSON（不要包含 markdown 代码块或其他文字）：

{
  "result": "succeeded",
  "message": "简要描述执行过程和成功的关键结果"
}

或

{
  "result": "failed",
  "message": "详细说明失败原因，包括实际结果与预期的差异"
}

**技能**: ${skillName}
**测试用例 #${testCase.index}**: ${testCase.title}
**预期结果**: ${testCase.expectedResult}

评判标准：
- result 为 "succeeded"：执行结果与预期一致
- result 为 "failed"：执行结果不符合预期，或执行过程中出现错误
- message 字段必须填写：成功时简要描述执行过程和关键结果，失败时说明具体失败原因
${retryNote}
请现在输出你的验证结果（仅 JSON）。`;
    }
}
