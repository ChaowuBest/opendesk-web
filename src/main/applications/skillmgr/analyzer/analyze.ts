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
import { loadAndValidateOpendeskMeta, OPENDESK_META_FILENAME } from './metadata.js';
import { logger } from '../../../utils/logger.js';
import path from 'path';
import fs from 'fs';
import os from 'os';
import AdmZip from 'adm-zip';
import type { OpendeskMeta } from './metadata.js';

// ── 分析状态类型 ──

export interface AnalyzeState {
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
}

export interface AnalyzeStatus {
    running: boolean;
    taskType: 'deps' | 'testgen' | null;
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

    // ── 停止分析 ──

    async stop(): Promise<void> {
        if (!this.state.running) return;
        const taskManager = GlobalState.getInstance().taskManagerState;
        for (const taskId of this.state.runningTaskIds) {
            try {
                const t = taskManager.getTask(taskId);
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
        const maxConcurrency = Math.max(1, Math.min(concurrency, 10));

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
                this.state.results[skillId] = meta?.dependencies
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
                this.state.results[skillId] = meta?.testCases?.length
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
    ): Promise<void> {
        this.state.currentSkill = skillId;
        this._notifyStatusChange();

        const detail = SkillRegistry.getSkillDetail(skillId);
        if (!detail?.skillDir) {
            this.state.results[skillId] = { error: '无法获取技能目录', analyzedAt: Date.now() };
            this.state.completed++;
            this._notifyStatusChange();
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
            this.state.runningTaskIds.add(task.task_id);
            await tm.initHarness(task, getPlatform().getEffectiveWorkspace(), mode);
            task.setSystemPrompt(await agent.createSystemPrompt(mode, task));
            await task.hooks.noticeBeforeTaskStart(task);
            await task.submitUserMessage(buildPrompt(skillDir, skillName));
            await task.waitUntilFinished();
            this.state.runningTaskIds.delete(task.task_id);

            try {
                handleResult(skillDir, loadAndValidateOpendeskMeta(skillDir));
            } catch (err) {
                this.state.results[skillId] = {
                    error: `读取结果失败: ${(err as Error)?.message}`,
                    analyzedAt: Date.now()
                };
            }
        } catch (err) {
            this.state.results[skillId] = {
                error: `Agent 失败: ${(err as Error)?.message}`,
                analyzedAt: Date.now()
            };
        }

        this.state.completed++;
        this._notifyStatusChange();
    }

    // ── Prompt 构建 ──

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
}
