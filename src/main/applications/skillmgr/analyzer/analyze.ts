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

import { skillRegistry } from '../utils/skill-registry.js';
import { setSkillStatus } from '../status.js';
import { GlobalState } from '../../../aikernel/states/global.js';
import { AgentRegistry } from '../../../aikernel/agents/registry.js';
import { getPlatform } from '../../../../platforms/base.js';
import {
    loadAndValidateOpendeskMeta,
    tryLoadOpendeskMeta,
    formatValidationErrors,
    parseTestResult,
    TestFailureReasonCategory,
    OPENDESK_META_FILENAME,
    MAX_VALIDATION_RETRIES,
    MAX_TESTRESULT_RETRIES
} from './metadata.js';
import { appendAdditionalPrompt, readAnalysisPrompts } from './prompts.js';
import { generateAnalyzeExportPage, generateAnalyzeExportDataJs, type AnalyzeSkillExport } from './analyze-export.js';
import { extractPythonTopLevelImports, extractSubprocessCommands, extractShellCommands } from './dep-prescan.js';
import { logger } from '../../../utils/logger.js';
import { getTempDir } from '../../../utils/temp.js';
import { Mutex } from 'async-mutex';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';
import AdmZip from 'adm-zip';
import type { OpendeskMeta, ValidationError, TestCase, TestResult } from './metadata.js';

// ── 导出选项 ──

/** 导出元数据时的裁剪选项 */
export interface ExportMetaOptions {
    /** 是否包含依赖信息 */
    includeDependencies: boolean;
    /** 测试用例包含策略：'all' - 所有，'passed' - 仅通过的，'none' - 不包含 */
    includeTestCases: 'all' | 'passed' | 'none';
    /** 是否包含测试用例的运行结果（actualResult、error、failureReasonCategory、taskId） */
    includeTestResults: boolean;
}

/** 默认导出选项 */
export const DEFAULT_EXPORT_OPTIONS: ExportMetaOptions = {
    includeDependencies: true,
    includeTestCases: 'all',
    includeTestResults: true
};

/** 未配置时不限制单个测试用例的执行时间。 */
export const DEFAULT_TEST_CASE_TIMEOUT_MS: number | undefined = undefined;
const TEST_CASE_TIMEOUT_STOP_GRACE_MS = 5_000;

type TestCasePhase = 'initialization' | 'execution' | 'verification';

class SkillTestTimeoutError extends Error {
    constructor(
        readonly timeoutMs: number,
        readonly phase: TestCasePhase
    ) {
        super(`测试用例执行超时（${timeoutMs}ms，阶段：${phase}）`);
        this.name = 'SkillTestTimeoutError';
    }
}

// ── 单条测试用例执行计划 ──

interface TestCasePlan {
    skillId: string;
    skillDir: string;
    skillName: string;
    bundleName: string;
    testCase: TestCase;
}

export interface RunTestOptions {
    timeoutMs?: number;
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
    private _currentQueue?: Array<string | TestCasePlan>;
    private readonly _testResultWriteMutexes = new Map<string, Mutex>();

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
        for (const skill of skillRegistry.listSkills()) {
            try {
                const detail = skillRegistry.getSkillDetail(skill.id);
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

    async runTests(skillIds: string[], concurrency: number = 5, options: RunTestOptions = {}): Promise<AnalyzeStatus> {
        return this._startTestRun(
            skillIds,
            concurrency,
            () => true,
            '所选技能没有可运行的测试用例',
            this._resolveTestCaseTimeout(options)
        );
    }

    async runUnpassedTests(
        skillIds: string[],
        concurrency: number = 5,
        options: RunTestOptions = {}
    ): Promise<AnalyzeStatus> {
        return this._startTestRun(
            skillIds,
            concurrency,
            (testCase) => testCase.status !== 'passed',
            '所选技能没有未通过的测试用例',
            this._resolveTestCaseTimeout(options)
        );
    }

    async runSelectedTests(
        skillId: string,
        testCaseIndices: number[],
        concurrency: number = 5,
        options: RunTestOptions = {}
    ): Promise<AnalyzeStatus> {
        const selected = new Set(testCaseIndices);
        if (selected.size === 0) throw new Error('请至少指定一个测试用例');
        return this._startTestRun(
            [skillId],
            concurrency,
            (testCase) => selected.has(testCase.index),
            '指定技能没有匹配的测试用例',
            this._resolveTestCaseTimeout(options)
        );
    }

    private async _startTestRun(
        skillIds: string[],
        concurrency: number,
        shouldRunTestCase: (testCase: TestCase) => boolean,
        emptyMessage: string,
        timeoutMs: number | undefined
    ): Promise<AnalyzeStatus> {
        if (!Array.isArray(skillIds) || skillIds.length === 0) throw new Error('请至少选择一个技能');
        if (this.state.running) throw new Error('分析或测试正在进行中，请等待完成后再发起');

        // 收集所有技能的测试用例
        const testPlan: TestCasePlan[] = [];
        const skillMetaMap = new Map<string, OpendeskMeta>();
        for (const skillId of [...new Set(skillIds)]) {
            const detail = skillRegistry.getSkillDetail(skillId);
            if (!detail?.skillDir) continue;
            const loadResult = tryLoadOpendeskMeta(detail.skillDir);
            if (!loadResult.success || !loadResult.data.testCases?.length) continue;
            skillMetaMap.set(skillId, loadResult.data);
            const skillName = detail.name || skillId;
            const bundleName = detail.bundleName || 'skillmgr';
            for (const tc of loadResult.data.testCases) {
                if (shouldRunTestCase(tc)) {
                    testPlan.push({ skillId, skillDir: detail.skillDir, skillName, bundleName, testCase: tc });
                }
            }
        }

        if (testPlan.length === 0) throw new Error(emptyMessage);

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

        // 预加载各技能的完整 testCases 到 results 中，供前端展示未运行和已通过项的状态。
        for (const [skillId, meta] of skillMetaMap) {
            const existing = this.state.results[skillId] || {};
            this.state.results[skillId] = {
                ...existing,
                dependencies: (meta.dependencies as Record<string, unknown> | undefined) ?? existing.dependencies,
                testCases: meta.testCases as unknown[]
            };
        }

        const maxConcurrency = Math.max(1, concurrency);

        this._notifyStatusChange();
        void this._runTestsInBackground(testPlan, maxConcurrency, timeoutMs).catch((err) =>
            this._handleBackgroundFailure('测试运行', err)
        );
        return this.getStatus();
    }

    // ── 单条测试执行 ──

    async runSingleTest(skillId: string, testCaseIndex: number, options: RunTestOptions = {}): Promise<AnalyzeStatus> {
        if (this.state.running) throw new Error('分析或测试正在进行中，请等待完成后再发起');

        const detail = skillRegistry.getSkillDetail(skillId);
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
            bundleName: detail.bundleName || 'skillmgr',
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
            await this._runTestForCase(plan, this._resolveTestCaseTimeout(options));
            const latestMeta = tryLoadOpendeskMeta(detail.skillDir);
            if (latestMeta.success) {
                const existing = this.state.results[skillId] || {};
                this.state.results[skillId] = {
                    ...existing,
                    dependencies:
                        (latestMeta.data.dependencies as Record<string, unknown> | undefined) ?? existing.dependencies,
                    testCases: latestMeta.data.testCases as unknown[]
                };
            }
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
        this._finishRun({ cancelPendingQueue: true });
    }

    // ── 元数据导出 ──

    async exportMetadatas(
        skillIds: string[],
        zipFilePath: string,
        options: ExportMetaOptions = DEFAULT_EXPORT_OPTIONS
    ): Promise<{ success: boolean; successCount: number; errorCount: number; errors: string[] }> {
        const zip = new AdmZip();
        let successCount = 0;
        const errors: string[] = [];

        for (const skillId of skillIds) {
            try {
                const detail = skillRegistry.getSkillDetail(skillId);
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

                // 根据导出选项裁剪元数据
                const finalContent = this._cropMetaContent(metaContent, options);
                zip.addFile(entryName, Buffer.from(finalContent, 'utf-8'));
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
     * 根据导出选项裁剪元数据 JSON 内容。
     */
    private _cropMetaContent(metaContent: string, options: ExportMetaOptions): string {
        let meta: Record<string, unknown>;
        try {
            meta = JSON.parse(metaContent);
        } catch {
            // 如果 JSON 解析失败，返回原始内容
            return metaContent;
        }

        // 是否包含依赖信息
        if (!options.includeDependencies && meta.dependencies) {
            delete meta.dependencies;
        }

        // 测试用例处理
        const testCases = meta.testCases as Record<string, unknown>[] | undefined;
        if (options.includeTestCases === 'none') {
            delete meta.testCases;
        } else if (options.includeTestCases === 'passed' && Array.isArray(testCases)) {
            meta.testCases = testCases.filter((tc) => tc.status === 'passed');
        }

        // 是否包含测试结果
        if (!options.includeTestResults && Array.isArray(meta.testCases)) {
            meta.testCases = (meta.testCases as Record<string, unknown>[]).map((tc) => {
                const cropped = { ...tc };
                delete cropped.actualResult;
                delete cropped.error;
                delete cropped.failureReasonCategory;
                delete cropped.taskId;
                return cropped;
            });
        }

        return JSON.stringify(meta, null, 2);
    }

    // ── 元数据删除 ──

    deleteMetadatas(skillIds: string[]): { success: boolean; deleted: number; notFound: number; errors: string[] } {
        const errors: string[] = [];
        let deleted = 0;
        let notFound = 0;

        for (const skillId of skillIds) {
            try {
                const detail = skillRegistry.getSkillDetail(skillId);
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
                    const skillExists = skillRegistry.skillExists(skillName);
                    if (!skillExists) {
                        skippedCount++;
                        details.push({ skillName, status: 'skipped', message: '技能不存在，已跳过' });
                        continue;
                    }

                    const detail = skillRegistry.getSkillDetail(skillName);
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

    private _formatError(err: unknown): string {
        return err instanceof Error ? err.stack || err.message : String(err);
    }

    private _formatErrorMessage(err: unknown): string {
        return err instanceof Error ? err.message : String(err);
    }

    private _markOneCompleted(): void {
        this.state.completed = Math.min(this.state.total, this.state.completed + 1);
    }

    private _clearCurrentQueue(cancelPending: boolean = false): void {
        if (cancelPending && this._currentQueue) {
            this._currentQueue.length = 0;
        }
        this._currentQueue = undefined;
    }

    private _stopRunningTasksBestEffort(): void {
        try {
            const taskManager = GlobalState.getInstance().taskManagerState;
            for (const taskId of this.state.runningTaskIds) {
                try {
                    const t = taskManager.getTask(taskId);
                    if (t) t.stop('system');
                } catch {
                    /* ignore */
                }
            }
        } catch {
            /* ignore */
        }
    }

    private _finishRun(options: { cancelPendingQueue?: boolean; stopRunningTasks?: boolean } = {}): void {
        const { cancelPendingQueue = false, stopRunningTasks = true } = options;
        this._clearCurrentQueue(cancelPendingQueue);
        if (stopRunningTasks) {
            this._stopRunningTasksBestEffort();
        }
        this.state.running = false;
        this.state.runningTaskIds.clear();
        this.state.currentSkill = null;
        this._notifyStatusChange();
    }

    private _handleBackgroundFailure(label: string, err: unknown): void {
        logger.error(`[SkillAnalyzer] ${label} 后台任务未捕获异常: ${this._formatError(err)}`);
        this._finishRun({ cancelPendingQueue: true });
    }

    private async _failTestCase(plan: TestCasePlan, message: string, taskId?: string): Promise<void> {
        try {
            await this._updateTestCaseStatus(
                plan.skillId,
                plan.skillDir,
                plan.testCase.index,
                {
                    result: 'failed',
                    message,
                    failureReasonCategory: TestFailureReasonCategory.ExternalService
                },
                taskId
            );
        } catch (err) {
            logger.warn(`[SkillAnalyzer] 标记测试失败状态失败: ${this._formatError(err)}`);
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

        void this._runAnalysisInBackground(targetIds, maxConcurrency, taskType).catch((err) =>
            this._handleBackgroundFailure(taskType === 'deps' ? '依赖分析' : '测试用例生成', err)
        );
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
                try {
                    if (taskType === 'deps') await this._analyzeDepsForSkill(sid);
                    else await this._generateTestsForSkill(sid);
                } catch (err) {
                    logger.error(`[SkillAnalyzer] ${sid} 分析任务异常: ${this._formatError(err)}`);
                    this.state.results[sid] = {
                        error: `后台任务异常: ${this._formatErrorMessage(err)}`,
                        analyzedAt: Date.now()
                    };
                    this._markOneCompleted();
                    this._notifyStatusChange();
                }
            }
        };
        try {
            await Promise.all(Array.from({ length: concurrency }, () => worker()));
        } finally {
            this._finishRun();
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

        let task: any = null;

        try {
            const detail = skillRegistry.getSkillDetail(skillId);
            if (!detail?.skillDir) {
                this.state.results[skillId] = { error: '无法获取技能目录', analyzedAt: Date.now() };
                return;
            }

            const skillDir = detail.skillDir;
            const skillName = detail.name || skillId;

            // ── 创建 Agent 任务（只创建一次，重试时复用同一 task）──
            const tm = GlobalState.getInstance().taskManagerState;
            const agent = AgentRegistry.getMainAgent();
            const modes = agent.supportedModes();
            const mode = modes.find((m) => m.id === 'solo') ?? modes[0];
            if (!mode) throw new Error('未找到可用 Agent 模式');

            task = tm.createTask();
            task.task_name = `[分析技能${taskLabel}] ${skillName}`;
            task.skillExposure = {
                skillNames: Array.from(new Set([skillName, skillId].map((name) => name.trim()).filter(Boolean))),
                skillDirectories: [skillDir]
            };
            this.state.runningTaskIds.add(task.task_id);

            await tm.initHarness(task, getPlatform().getEffectiveWorkspace(), mode);
            await task.rebuildSystemPrompt();
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
                error: `Agent 失败: ${this._formatErrorMessage(err)}`,
                analyzedAt: Date.now()
            };
        } finally {
            if (task?.task_id) {
                this.state.runningTaskIds.delete(task.task_id);
            }
            this._markOneCompleted();
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

    // ── 预扫描 ──

    /** 预扫描技能目录，提取 Python 模块引用和 Shell 命令引用，供 Agent 汇总使用 */
    private _preScanDeps(skillDir: string): { pythonImports: string[]; shellCommands: string[] } {
        const pythonImports = new Set<string>();
        const shellCommands = new Set<string>();
        const visited = new Set<string>();

        const scanDir = (dir: string): void => {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
                    // 防御符号链接循环
                    let realPath: string;
                    try {
                        realPath = fs.realpathSync(fullPath);
                    } catch {
                        continue;
                    }
                    if (visited.has(realPath)) continue;
                    visited.add(realPath);
                    scanDir(fullPath);
                } else if (entry.isFile()) {
                    try {
                        const content = fs.readFileSync(fullPath, 'utf-8');
                        const ext = path.extname(fullPath).toLowerCase();
                        if (ext === '.py') {
                            for (const mod of extractPythonTopLevelImports(content)) {
                                pythonImports.add(mod);
                            }
                            for (const cmd of extractSubprocessCommands(content)) {
                                shellCommands.add(cmd);
                            }
                        }
                        if (ext === '.sh') {
                            for (const cmd of extractShellCommands(content)) {
                                shellCommands.add(cmd);
                            }
                        }
                    } catch {
                        /* 跳过无法读取的文件 */
                    }
                }
            }
        };

        try {
            visited.add(fs.realpathSync(skillDir));
        } catch {
            /* 目录不可达则跳过扫描 */
        }
        scanDir(skillDir);
        return {
            pythonImports: [...pythonImports].sort(),
            shellCommands: [...shellCommands].sort()
        };
    }

    // ── Prompt 构建 ──

    private _buildDepsPrompt(skillDir: string, skillName: string): string {
        const scanResult = this._preScanDeps(skillDir);

        // 构建预扫描提示
        let preScanSection = '';
        if (scanResult.pythonImports.length > 0 || scanResult.shellCommands.length > 0) {
            const parts: string[] = [];
            if (scanResult.pythonImports.length > 0) {
                parts.push(
                    ` - 脚本已扫描到 Python 模块引用：${scanResult.pythonImports.join('、')}。` +
                        '请补充进 dependencies.pythonPackages，将其中属于 Python 标准库的模块对应的 version 填 "stdlib"，description 注明 "Python 标准库"。'
                );
            }
            if (scanResult.shellCommands.length > 0) {
                parts.push(
                    ` - 脚本已扫描到 Shell 命令引用：${scanResult.shellCommands.join('、')}。` +
                        '请补充进 dependencies.binaries，将其中属于 Shell 内置命令/系统工具的命令对应的 installHint 填 "系统内置"。'
                );
            }
            preScanSection = `${parts.join('\n')}\n`;
        }

        const prompt = `请分析以下技能目录的依赖项，写入 ${skillDir}/${OPENDESK_META_FILENAME}。

技能: ${skillName}
目录: ${skillDir}

重要说明：技能分析的入口文件是 SKILL.md（位于 ${skillDir}/SKILL.md），请首先阅读它来了解技能的功能。

步骤：
1. 读取 SKILL.md 了解功能
2. 检查所有文件（handler.js、scripts/ 等），识别所有环境变量、Python 库、npm 包、系统命令
3. 写入 JSON（保留已有 testCases）：

{"dependencies":{"envVars":[{"name":"KEY","required":true,"description":"用途"}],"pythonPackages":[{"name":"requests","version":">=2.28","description":"用途"}],"npmPackages":[{"name":"axios","version":"^1.0","description":"用途"}],"binaries":[{"name":"git","description":"用途","installHint":"brew install git"}]}}

不存在的不写空数组，required 默认 false。

作为补充，脚本预扫描结果如下：
${preScanSection}`;
        return appendAdditionalPrompt(prompt, readAnalysisPrompts().dependencyAnalysis);
    }

    private _buildTestsPrompt(skillDir: string, skillName: string): string {
        const prompt = `请为以下技能生成测试用例，写入 ${skillDir}/${OPENDESK_META_FILENAME}。

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
        return appendAdditionalPrompt(prompt, readAnalysisPrompts().testGeneration);
    }

    // ── 测试运行（内部） ──

    private _resolveTestCaseTimeout(options: RunTestOptions): number | undefined {
        const timeoutMs = options.timeoutMs ?? DEFAULT_TEST_CASE_TIMEOUT_MS;
        if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
            throw new Error('timeoutMs 必须是大于 0 的有限数值');
        }
        return timeoutMs;
    }

    private async _awaitTestPhase<T>(
        operation: Promise<T>,
        deadline: number | undefined,
        phase: TestCasePhase,
        timeoutMs: number | undefined
    ): Promise<T> {
        if (deadline === undefined || timeoutMs === undefined) return operation;

        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) throw new SkillTestTimeoutError(timeoutMs, phase);

        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                operation,
                new Promise<T>((_, reject) => {
                    timer = setTimeout(() => reject(new SkillTestTimeoutError(timeoutMs, phase)), remainingMs);
                })
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    private async _runTestsInBackground(
        testPlan: TestCasePlan[],
        concurrency: number,
        timeoutMs: number | undefined
    ): Promise<void> {
        const queue = [...testPlan];
        this._currentQueue = queue;

        const worker = async () => {
            while (queue.length > 0 && this.state.running) {
                const plan = queue.shift();
                if (!plan || !this.state.running) break;
                try {
                    await this._runTestForCase(plan, timeoutMs);
                } catch (err) {
                    logger.error(
                        `[SkillAnalyzer] 测试用例 ${plan.skillName} #${plan.testCase.index} 异常: ${this._formatError(err)}`
                    );
                    await this._failTestCase(plan, `测试运行内部异常: ${this._formatErrorMessage(err)}`);
                    this._markOneCompleted();
                    this._notifyStatusChange();
                }
            }
        };

        try {
            await Promise.all(Array.from({ length: concurrency }, () => worker()));
        } finally {
            this._finishRun();
        }
    }

    /**
     * 执行单个测试用例：创建 Agent 任务 → 发送测试 Prompt → 等待完成 →
     * 追加验证消息 → 解析 JSON → 更新状态
     */
    private async _runTestForCase(plan: TestCasePlan, timeoutMs: number | undefined): Promise<void> {
        if (!this.state.running) return;

        this.state.currentSkill = plan.skillId;
        this._notifyStatusChange();

        const { skillId, skillDir, skillName, bundleName, testCase } = plan;
        const tcIndex = testCase.index;
        const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
        let task: any = null;
        let tempWorkspace: string | null = null;

        try {
            // 确保被测 skill 在 status.json 中为启用状态，避免 LoadSkill 调用时被拒绝
            setSkillStatus(skillId, true);

            const tm = GlobalState.getInstance().taskManagerState;
            const agent = AgentRegistry.getMainAgent();
            const modes = agent.supportedModes();
            const mode = modes.find((m) => m.id === 'solo') ?? modes[0];
            if (!mode) throw new Error('未找到可用 Agent 模式');

            task = tm.createTask();
            task.task_name = `[测试] ${skillName} #${tcIndex}: ${testCase.title}`;
            task.skillExposure = {
                skillNames: Array.from(new Set([skillName, skillId].map((name) => name.trim()).filter(Boolean))),
                skillDirectories: [skillDir]
            };
            this.state.runningTaskIds.add(task.task_id);

            // 为每个测试用例创建独立的临时工作空间，避免并行任务之间的文件冲突
            tempWorkspace = fs.mkdtempSync(path.join(getTempDir(), 'skill-test-'));

            await this._awaitTestPhase(
                tm.initHarness(task, tempWorkspace, mode),
                deadline,
                'initialization',
                timeoutMs
            );
            await this._awaitTestPhase(task.rebuildSystemPrompt(), deadline, 'initialization', timeoutMs);
            await this._awaitTestPhase(task.hooks.noticeBeforeTaskStart(task), deadline, 'initialization', timeoutMs);

            // 第一步：发送测试执行 Prompt
            await this._awaitTestPhase(
                task.submitUserMessage(this._buildTestRunPrompt(skillDir, skillName, bundleName, testCase)),
                deadline,
                'execution',
                timeoutMs
            );
            await this._awaitTestPhase(task.waitUntilFinished(), deadline, 'execution', timeoutMs);

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

                await this._awaitTestPhase(
                    task.submitUserMessage(this._buildTestVerifyPrompt(skillName, testCase, attempt > 0)),
                    deadline,
                    'verification',
                    timeoutMs
                );
                await this._awaitTestPhase(task.waitUntilFinished(), deadline, 'verification', timeoutMs);

                if (!this.state.running) {
                    this.state.runningTaskIds.delete(task.task_id);
                    return;
                }

                // 从 agent 最后一条回复中提取 TestResult JSON
                const lastMsg = this._getLastAssistantMessage(task);
                const parseResult = parseTestResult(lastMsg);

                if (parseResult.success) {
                    // 更新状态
                    await this._updateTestCaseStatus(skillId, skillDir, tcIndex, parseResult.data, task.task_id);
                    break;
                }

                // 解析/校验失败
                if (attempt >= MAX_TESTRESULT_RETRIES - 1) {
                    // 达到最大重试次数，标记为失败
                    await this._updateTestCaseStatus(
                        skillId,
                        skillDir,
                        tcIndex,
                        {
                            result: 'failed',
                            message: `Agent 未返回有效的测试结果 JSON（已重试${MAX_TESTRESULT_RETRIES}次）: ${parseResult.error}`,
                            failureReasonCategory: TestFailureReasonCategory.ExternalService
                        },
                        task.task_id
                    );
                }
            }
        } catch (err) {
            if (err instanceof SkillTestTimeoutError) {
                if (task) {
                    try {
                        const interrupted = await Promise.race([
                            task
                                .interruptRunningTurn({
                                    reason: 'skill_test_timeout',
                                    stopRunningTools: true,
                                    cancelPermissionPrompts: true,
                                    skipFinishHooks: true
                                })
                                .then(() => true),
                            new Promise<boolean>((resolve) =>
                                setTimeout(() => resolve(false), TEST_CASE_TIMEOUT_STOP_GRACE_MS)
                            )
                        ]);
                        if (!interrupted && typeof task.stop === 'function') {
                            task.stop('skill_test_timeout');
                        }
                    } catch (interruptError) {
                        logger.warn(`[SkillAnalyzer] 超时中断测试任务失败: ${this._formatError(interruptError)}`);
                    }
                }
                await this._updateTestCaseStatus(
                    skillId,
                    skillDir,
                    tcIndex,
                    {
                        result: 'failed',
                        message: err.message,
                        failureReasonCategory: TestFailureReasonCategory.ExternalService
                    },
                    task?.task_id
                );
            } else {
                await this._failTestCase(plan, `Agent 执行异常: ${this._formatErrorMessage(err)}`, task?.task_id);
            }
        } finally {
            // 清理临时工作空间
            if (tempWorkspace) {
                try {
                    fs.rmSync(tempWorkspace, { recursive: true, force: true });
                } catch {
                    /* 清理失败不影响主流程 */
                }
            }
            try {
                GlobalState.getInstance().taskManagerState.saveSync();
            } catch (e) {
                logger.warn(`[SkillAnalyzer] 持久化测试任务失败: ${(e as Error).message}`);
            }
            if (task?.task_id) {
                this.state.runningTaskIds.delete(task.task_id);
            }
            this._markOneCompleted();
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

    private _getTestResultWriteMutex(skillDir: string): Mutex {
        const key = path.resolve(skillDir);
        let mutex = this._testResultWriteMutexes.get(key);
        if (!mutex) {
            mutex = new Mutex();
            this._testResultWriteMutexes.set(key, mutex);
        }
        return mutex;
    }

    /**
     * 串行且原子地提交单条测试结果；磁盘提交成功后才更新内存状态。
     */
    private async _updateTestCaseStatus(
        skillId: string,
        skillDir: string,
        testCaseIndex: number,
        testResult: TestResult,
        taskId?: string
    ): Promise<void> {
        const mutex = this._getTestResultWriteMutex(skillDir);

        await mutex.runExclusive(async () => {
            const metaPath = path.join(skillDir, OPENDESK_META_FILENAME);
            const tempPath = path.join(skillDir, `.${OPENDESK_META_FILENAME}.${process.pid}.${randomUUID()}.tmp`);

            try {
                const [raw, stat] = await Promise.all([
                    fs.promises.readFile(metaPath, 'utf-8'),
                    fs.promises.stat(metaPath)
                ]);
                const meta = JSON.parse(raw);
                if (!Array.isArray(meta?.testCases)) {
                    throw new Error(`${OPENDESK_META_FILENAME} 未包含测试用例`);
                }

                const testCase = meta.testCases.find(
                    (candidate: Record<string, unknown>) => candidate['index'] === testCaseIndex
                );
                if (!testCase) throw new Error(`未找到测试用例 #${testCaseIndex}`);
                this._applyTestCaseResult(testCase, testResult, taskId);

                const file = await fs.promises.open(tempPath, 'wx', stat.mode);
                try {
                    await file.writeFile(`${JSON.stringify(meta, null, 2)}\n`, 'utf-8');
                    await file.sync();
                } finally {
                    await file.close();
                }
                await fs.promises.rename(tempPath, metaPath);

                const memoryTestCase = (
                    this.state.results[skillId]?.testCases as Array<Record<string, unknown>> | undefined
                )?.find((candidate) => candidate['index'] === testCaseIndex);
                if (memoryTestCase) this._applyTestCaseResult(memoryTestCase, testResult, taskId);
            } catch (e) {
                await fs.promises.rm(tempPath, { force: true }).catch(() => {});
                throw e;
            }
        });
    }

    private _applyTestCaseResult(testCase: Record<string, unknown>, testResult: TestResult, taskId?: string): void {
        testCase['status'] = testResult.result === 'succeeded' ? 'passed' : 'failed';
        if (testResult.result === 'succeeded') {
            testCase['actualResult'] = testResult.message;
            delete testCase['error'];
            delete testCase['failureReasonCategory'];
        } else {
            delete testCase['actualResult'];
            testCase['error'] = testResult.message;
            testCase['failureReasonCategory'] = testResult.failureReasonCategory;
        }
        if (taskId) testCase['taskId'] = taskId;
        else delete testCase['taskId'];
    }

    /**
     * 构建测试执行 Prompt：让 agent 阅读 SKILL.md 并执行测试用例中的任务
     */
    private _buildTestRunPrompt(skillDir: string, skillName: string, bundleName: string, testCase: TestCase): string {
        const prompt = `你正在执行技能"${skillName}"的测试用例。

**技能 SKILL.md 路径**: ${skillDir}/SKILL.md
**技能目录**: ${skillDir}

**测试用例 #${testCase.index}**: ${testCase.title}

请按以下步骤操作：
1. 调用 LoadSkill 工具加载技能，参数：bundleName="${bundleName}", skillName="${skillName}"
2. 读取 ${skillDir}/SKILL.md，了解该技能的完整功能、参数和使用方式
3. 根据测试用例的 Prompt 执行任务：

> ${testCase.prompt}

请务必调用该技能提供的工具来完成上述任务，不要仅做文字分析。
如果技能所需要的二进制命令或者Python包，NPM包等三方依赖找不到，请尽量尝试自主安装。
如果技能所需要的环境变量不存在则直接报错。

测试完成后，请简要描述你的执行过程和结果。`;
        return appendAdditionalPrompt(prompt, readAnalysisPrompts().testRun);
    }

    /**
     * 构建测试验证 Prompt：让 agent 对比执行结果和预期结果，输出 JSON
     */
    private _buildTestVerifyPrompt(skillName: string, testCase: TestCase, isRetry: boolean): string {
        const retryNote = isRetry
            ? '\n**注意：** 上一次你的回复中未能提取到符合格式的 JSON 结果。请确保本次回复**仅包含**一个 JSON 对象；如果 result 为 "failed"，必须包含合法的 failureReasonCategory 枚举值。\n'
            : '';

        return `测试执行已完成。现在请对照预期结果进行验证，并**仅输出**以下格式的 JSON（不要包含 markdown 代码块或其他文字）：

{
  "result": "succeeded",
  "message": "简要描述执行过程和成功的关键结果"
}

或

{
  "result": "failed",
  "message": "详细说明失败原因，包括实际结果与预期的差异",
  "failureReasonCategory": "dependency_runtime"
}

**技能**: ${skillName}
**测试用例 #${testCase.index}**: ${testCase.title}
**预期结果**: ${testCase.expectedResult}

评判标准：
- result 为 "succeeded"：执行结果与预期一致
- result 为 "failed"：执行结果不符合预期，或执行过程中出现错误
- message 字段必须填写：成功时简要描述执行过程和关键结果，失败时说明具体失败原因
- 当 result 为 "failed" 时，failureReasonCategory 字段必须填写，且只能使用以下枚举值之一：
  - "misconfigured"：未正确配置。环境变量、配置文件、权限、sandbox、系统路径、可执行权限、平台差异等问题。标准：运行环境不满足前置条件
  - "dependency_runtime"：依赖与运行时问题。Python/Node/CLI/二进制工具缺失，依赖安装失败，版本不兼容，native 包编译失败。标准：需要的库、命令或运行时不可用
  - "input_data"：输入数据问题。给的文件、参数、数据、路径、格式、编码、大小等不符合 skill 预期。标准：当前测试拿到的输入无法处理
  - "external_service"：外部服务问题。网络、API 超时、认证阻塞、远端服务异常。标准：失败点在本机之外
  - "skill_implementation"：skill 实现问题。SKILL.md 指令不清楚，流程缺步骤，脚本有 bug，模板/assets 缺失，边界情况没处理。标准：前置条件都满足，但 skill 自己的设计或代码有问题
${retryNote}
请现在输出你的验证结果（仅 JSON）。`;
    }

    /**
     * 构建运行时依赖元数据 Prompt：让 agent 回顾测试执行过程，分析依赖项并写入 JSON
     */
    private _buildRuntimeDependencyAnalysisPrompt(skillDir: string, skillName: string, testCase: TestCase): string {
        const metaPath = path.join(skillDir, 'testrun', `opendesk_meta_test_${testCase.index}.json`);
        const prompt = `测试执行已完成。请分析技能执行过程的依赖项，写入 ${metaPath}。

步骤：
1. 回顾测试执行过程中创建的可执行文件、执行的 command
2. 识别所有环境变量、Python 库、npm 包、系统命令
3. 写入 JSON（仅写入文件，不要用 markdown 代码块包裹回复内容）：

{
  "dependencies": {
    "envVars": [
      { "name": "KEY", "required": true, "description": "用途" }
    ],
    "pythonPackages": [
      { "name": "requests", "version": ">=2.28", "description": "用途" }
    ],
    "npmPackages": [
      { "name": "axios", "version": "^1.0", "description": "用途" }
    ],
    "binaries": [
      { "name": "git", "description": "用途", "installHint": "brew install git" }
    ]
  }
}

不存在的不写空数组，required 默认 false。
确保 ${path.dirname(metaPath)} 目录已存在再写入。`;
        return appendAdditionalPrompt(prompt, readAnalysisPrompts().runtimeDependencyAnalysis);
    }

    // ── 导出独立 HTML 页面 ──

    async exportAnalyzePage(
        filePath: string,
        skillIds?: string[]
    ): Promise<{ success: boolean; skillCount: number; error?: string }> {
        try {
            const exportedSkills = this._collectAnalyzeSkillExports(skillIds);

            const html = generateAnalyzeExportPage();

            // 去掉 .html 后缀作为文件夹名，将 HTML 和 data.js 放入其中
            const dirPath = filePath.replace(/\.html$/, '');
            fs.mkdirSync(dirPath, { recursive: true });
            const htmlPath = path.join(dirPath, 'index.html');
            const dataJsPath = path.join(dirPath, 'data.js');
            const dataJs = generateAnalyzeExportDataJs(exportedSkills);

            fs.writeFileSync(htmlPath, html, 'utf-8');
            fs.writeFileSync(dataJsPath, dataJs, 'utf-8');

            return { success: true, skillCount: exportedSkills.length };
        } catch (e) {
            return { success: false, skillCount: 0, error: (e as Error).message };
        }
    }

    private _collectAnalyzeSkillExports(skillIds?: string[]): AnalyzeSkillExport[] {
        const exportedSkills: AnalyzeSkillExport[] = [];
        const selectedIds = new Set((skillIds ?? []).map(String));
        for (const skill of skillRegistry.listSkills()) {
            const skillId = String(skill.id);
            if (selectedIds.size > 0 && !selectedIds.has(skillId)) continue;
            try {
                const detail = skillRegistry.getSkillDetail(skillId);
                if (!detail) {
                    exportedSkills.push({
                        skill: {
                            id: skillId,
                            name: String(skill.name || skillId),
                            description: String(skill.description || '')
                        },
                        error: '技能详情不可用'
                    });
                    continue;
                }

                const meta = this._buildAnalyzeMeta(detail.skillDir);
                exportedSkills.push({
                    skill: {
                        id: skillId,
                        name: String(detail.name || skill.name || skillId),
                        description: String(detail.description || ''),
                        body: typeof detail.body === 'string' ? detail.body : '',
                        source: detail.source,
                        license: detail.license,
                        compatibility: detail.compatibility,
                        metadata: detail.metadata,
                        allowedTools: detail.allowedTools,
                        resources: {
                            references: (detail.resources?.references ?? [])
                                .map((ref: unknown) =>
                                    typeof ref === 'string' ? ref : String((ref as Record<string, unknown>)?.name ?? '')
                                )
                                .filter(Boolean),
                            scripts: (detail.resources?.scripts ?? []).map(String),
                            assets: (detail.resources?.assets ?? []).map(String)
                        }
                    },
                    meta
                });
            } catch (e) {
                exportedSkills.push({
                    skill: {
                        id: skillId,
                        name: String(skill.name || skillId),
                        description: String(skill.description || '')
                    },
                    error: (e as Error).message
                });
            }
        }
        return exportedSkills;
    }

    private _buildAnalyzeMeta(skillDir: string | undefined): AnalyzeSkillExport['meta'] | undefined {
        let meta: Record<string, unknown> | undefined;
        if (skillDir) {
            try {
                const loaded = loadAndValidateOpendeskMeta(skillDir);
                if (loaded) meta = loaded as Record<string, unknown>;
            } catch {
                meta = undefined;
            }
        }

        const result: AnalyzeSkillExport['meta'] = {};
        if (meta?.dependencies) {
            result.dependencies = meta.dependencies;
        }
        if (Array.isArray(meta?.testCases)) {
            result.testCases = meta.testCases as unknown[];
        }

        return result.dependencies || result.testCases ? result : undefined;
    }
}
