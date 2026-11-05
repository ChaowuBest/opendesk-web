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
 * 测评执行引擎：按并发数依次为每个用例
 *   1) 跑「运行任务准备脚本」；
 *   2) 用测试模型在独立工作空间启动 OpenDesk 任务；
 *   3) 跑「验证任务准备脚本」把结果搬到验证工作空间；
 *   4) 用验证模型在验证工作空间给出得分。
 */

import fs from 'fs';
import path from 'path';
import { GlobalState } from '../../aikernel/states/global.js';
import { AgentRegistry } from '../../aikernel/agents/registry.js';
import { extractAttemptCompletionResult } from '../../aikernel/planning/harness.js';
import type { TaskState } from '../../aikernel/states/tasks.js';
import type { ReasoningEffort } from '../../aikernel/types/reasoning.js';
import { logger } from '../../utils/logger.js';
import { t } from './locale/index.js';
import { toErrorMessage } from '../../../common/utils/error.js';
import { buildChildProcessEnv } from '../../utils/shellExec.js';
import { runScript, ScriptExecutionError } from './script-runtime.js';
import { getDiskUsage } from '../../utils/shell-helper.js';
import {
    buildVerifyPrompt,
    parseJudgeScore,
    resolveRunStatus,
    toSafeDirName,
    type CaseRunState,
    type CaseRunStatus,
    type CaseSpec,
    type RunRecord,
    type RunStatus
} from './common.js';
import type { ScriptHandle } from './script-runtime.js';

export interface CasePlanItem {
    spec: CaseSpec;
    /** 用例目录（测评集内）绝对路径 */
    dir: string;
    trackId: string;
    trackName: string;
    key: string;
}

export interface RunnerCallbacks {
    updateCase(runId: string, key: string, patch: Partial<CaseRunState>): void;
    finishRun(runId: string, status: RunStatus): void;
    notify(): void;
}

export interface RunnerContext {
    run: RunRecord;
    plan: CasePlanItem[];
    runDir: string;
    callbacks: RunnerCallbacks;
}

interface TaskExecutionResult {
    resultText: string;
    timedOut: boolean;
}

const RESULT_FILE_NAME = 'result.json';
const RESULT_DIR_NAME = '.benchmark';

export class BenchmarkRunner {
    private readonly activeTasks = new Map<string, Set<TaskState>>();
    private readonly stoppedRuns = new Set<string>();
    /** 每轮运行当前正在执行的脚本句柄；stop() 时随时杀掉，不用等脚本自然结束 */
    private readonly activeScripts = new Map<string, Set<ScriptHandle>>();

    async execute(context: RunnerContext): Promise<void> {
        const { run, plan, callbacks } = context;
        run.startedAt = run.startedAt ?? Date.now();
        callbacks.notify();

        const queue = [...plan];
        // 用例的最终结果只能由执行过程本身记录：run.cases 是落盘快照，
        // 不会随 case 状态更新回填（每次更新都是读盘 → 改 → 写盘的新对象）
        const outcomes: CaseRunStatus[] = [];
        const concurrency = Math.max(1, Math.min(20, run.concurrency || 1));
        const workerCount = Math.min(concurrency, Math.max(1, queue.length));
        try {
            await Promise.all(Array.from({ length: workerCount }, () => this.worker(context, queue, outcomes)));
        } catch (error) {
            logger.error(`[benchmark] run ${run.id} failed: ${toErrorMessage(error)}`);
        }

        // 未执行到的用例统一标记为已停止
        for (const item of queue) {
            callbacks.updateCase(run.id, item.key, { status: 'stopped', finishedAt: Date.now() });
        }

        const stopped = this.stoppedRuns.delete(run.id);
        this.activeScripts.delete(run.id);
        callbacks.finishRun(run.id, resolveRunStatus(outcomes, stopped, plan.length));
    }

    stop(runId: string): void {
        this.stoppedRuns.add(runId);
        for (const script of this.activeScripts.get(runId) ?? []) {
            try {
                script.abort();
            } catch (error) {
                logger.warn(`[benchmark] failed to abort script for run ${runId}: ${toErrorMessage(error)}`);
            }
        }
        const tasks = this.activeTasks.get(runId);
        if (!tasks) return;
        for (const task of tasks) {
            try {
                task.stop('system');
            } catch (error) {
                logger.warn(`[benchmark] failed to stop task ${task.task_id}: ${toErrorMessage(error)}`);
            }
        }
    }

    isRunning(runId: string): boolean {
        return this.activeTasks.has(runId);
    }

    private async worker(context: RunnerContext, queue: CasePlanItem[], outcomes: CaseRunStatus[]): Promise<void> {
        for (;;) {
            const item = queue.shift();
            if (!item) return;
            if (this.stoppedRuns.has(context.run.id)) {
                context.callbacks.updateCase(context.run.id, item.key, {
                    status: 'stopped',
                    finishedAt: Date.now()
                });
                outcomes.push('stopped');
                continue;
            }
            outcomes.push(await this.runCase(context, item));
            await this.recordCaseUsage(context, item);
        }
    }

    /**
     * 用例收尾时量一次它自己的目录并记账。
     *
     * 埋在这里而不是 runCase 内部：runCase 有六个 return 出口（done / stopped 若干 / failed），
     * 逐个埋必然漏。worker 循环是所有正常出口的唯一汇聚点。
     *
     * 必须 await：跑完整轮后 execute 会立刻 finishRun 收尾，记账还没写完就收尾会丢掉最后几个用例的份额。
     */
    private async recordCaseUsage(context: RunnerContext, item: CasePlanItem): Promise<void> {
        const { run, runDir, callbacks } = context;
        const caseDir = path.join(runDir, 'cases', toSafeDirName(item.key));
        try {
            const { bytes } = await getDiskUsage(caseDir);
            callbacks.updateCase(run.id, item.key, { usageBytes: bytes });
        } catch (error) {
            // 占用只是辅助信息，系统命令失败不能中断后续用例或覆盖测评结果。
            logger.warn(`[benchmark] failed to measure case ${item.key}: ${toErrorMessage(error)}`);
        }
    }

    private async runCase(context: RunnerContext, item: CasePlanItem): Promise<CaseRunStatus> {
        const { run, runDir, callbacks } = context;
        const caseDir = path.join(runDir, 'cases', toSafeDirName(item.key));
        const runWorkspace = path.join(caseDir, 'run-workspace');
        const verifyWorkspace = path.join(caseDir, 'verify-workspace');
        const logDir = path.join(caseDir, 'logs');

        fs.mkdirSync(runWorkspace, { recursive: true });
        fs.mkdirSync(verifyWorkspace, { recursive: true });
        fs.mkdirSync(logDir, { recursive: true });

        const startedAt = Date.now();
        callbacks.updateCase(run.id, item.key, {
            status: 'preparing',
            startedAt,
            finishedAt: null,
            ratio: null,
            score: null,
            reason: '',
            error: ''
        });

        // 准备脚本与任务终端/Agent 工具共用同一套子进程环境：设置里的全局环境变量、
        // 解释器隔离策略和代理配置都对脚本生效，避免「Agent 里跑通的 python 在脚本里
        // 定位到另一个」。BENCH_* 作为显式 env 传入，优先级高于上层所有来源。
        //
        // BENCH_* 契约（脚本里直接可用，改动要同步 dataset 规范）：
        //   BENCH_RUN_ID / BENCH_CONCURRENCY / BENCH_RUN_MODEL / BENCH_VERIFY_MODEL
        //   BENCH_DATASET_NAME / BENCH_TRACK_ID / BENCH_CASE_ID / BENCH_CASE_NAME  标识类
        //   BENCH_RUN_DIR           本轮运行里该用例的目录（runs/<runId>/cases/<key>），
        //                           日志与两个 workspace 都在它下面
        //   BENCH_CASE_DIR          测评集里的用例目录（只读素材来源）
        //   BENCH_WORKSPACE         测试任务的工作空间（= BENCH_RUN_WORKSPACE）
        //   BENCH_VERIFY_WORKSPACE  验证任务的工作空间
        //   BENCH_LOG_DIR           准备脚本日志目录
        //   BENCH_PHASE             run-prepare / verify-prepare，由调用方按阶段覆盖
        const baseEnv = buildChildProcessEnv({
            BENCH_RUN_ID: run.id,
            BENCH_RUN_DIR: caseDir,
            BENCH_DATASET_NAME: run.datasetName,
            BENCH_TRACK_ID: item.trackId,
            BENCH_CASE_ID: item.spec.caseId,
            BENCH_CASE_DIR: item.dir,
            BENCH_CASE_NAME: item.spec.name,
            BENCH_WORKSPACE: runWorkspace,
            BENCH_RUN_WORKSPACE: runWorkspace,
            BENCH_VERIFY_WORKSPACE: verifyWorkspace,
            BENCH_LOG_DIR: logDir,
            BENCH_RUN_MODEL: run.runModel,
            BENCH_VERIFY_MODEL: run.verifyModel,
            BENCH_CONCURRENCY: String(run.concurrency)
        });

        try {
            if (item.spec.runPrepareFile) {
                const result = await runScript({
                    scriptPath: path.join(item.dir, item.spec.runPrepareFile),
                    cwd: item.dir,
                    env: { ...baseEnv, BENCH_PHASE: 'run-prepare' },
                    logPath: path.join(logDir, 'run-prepare.log'),
                    timeoutSec: item.spec.prepareTimeoutSec,
                    handle: (script) => this.trackScript(run.id, script)
                });
                if (!result.ok) {
                    throw new ScriptExecutionError(
                        t('error.caseRunPrepareFailed', { reason: result.error }),
                        result.logError
                    );
                }
            }

            if (this.stoppedRuns.has(run.id)) {
                callbacks.updateCase(run.id, item.key, { status: 'stopped', finishedAt: Date.now() });
                return 'stopped';
            }

            callbacks.updateCase(run.id, item.key, { status: 'running' });
            const runPrompt = fs.readFileSync(path.join(item.dir, item.spec.runPromptFile), 'utf8');
            const runResult = await this.executeTask({
                runId: run.id,
                workspace: runWorkspace,
                prompt: runPrompt,
                model: run.runModel,
                effort: this.effortOf(run.runModelEffort),
                title: t('benchmark.taskName.run', {
                    dataset: run.datasetName,
                    track: item.trackName,
                    case: item.spec.name
                }),
                timeoutSec: run.runTimeoutSec ?? item.spec.runTimeoutSec,
                // taskId 一拿到就落盘：测评界面对「正在运行」的用例也要能跳转到任务
                onTaskCreated: (taskId) => {
                    callbacks.updateCase(run.id, item.key, { runTaskId: taskId });
                }
            });
            // runTaskId 已由 onTaskCreated 在任务创建时写入，这里只补超时标记
            if (runResult.timedOut) {
                callbacks.updateCase(run.id, item.key, { error: t('error.runTimedOut') });
            }

            if (this.stoppedRuns.has(run.id)) {
                callbacks.updateCase(run.id, item.key, { status: 'stopped', finishedAt: Date.now() });
                return 'stopped';
            }

            callbacks.updateCase(run.id, item.key, { status: 'verifying' });
            if (item.spec.verifyPrepareFile) {
                const prepared = await runScript({
                    scriptPath: path.join(item.dir, item.spec.verifyPrepareFile),
                    cwd: item.dir,
                    env: { ...baseEnv, BENCH_PHASE: 'verify-prepare' },
                    logPath: path.join(logDir, 'verify-prepare.log'),
                    timeoutSec: item.spec.prepareTimeoutSec,
                    handle: (script) => this.trackScript(run.id, script)
                });
                if (!prepared.ok) {
                    throw new ScriptExecutionError(
                        t('error.caseVerifyPrepareFailed', { reason: prepared.error }),
                        prepared.logError
                    );
                }
            }

            const resultDir = path.join(verifyWorkspace, RESULT_DIR_NAME);
            fs.mkdirSync(resultDir, { recursive: true });
            const resultFile = path.join(resultDir, RESULT_FILE_NAME);
            const verifyPrompt = buildVerifyPrompt(
                fs.readFileSync(path.join(item.dir, item.spec.verifyPromptFile), 'utf8'),
                resultFile
            );
            const verifyResult = await this.executeTask({
                runId: run.id,
                workspace: verifyWorkspace,
                prompt: verifyPrompt,
                model: run.verifyModel,
                effort: this.effortOf(run.verifyModelEffort),
                title: t('benchmark.taskName.verify', {
                    dataset: run.datasetName,
                    track: item.trackName,
                    case: item.spec.name
                }),
                timeoutSec: run.verifyTimeoutSec ?? item.spec.verifyTimeoutSec,
                onTaskCreated: (taskId) => {
                    callbacks.updateCase(run.id, item.key, { verifyTaskId: taskId });
                }
            });

            const judge = this.readJudgeResult(resultFile) ?? parseJudgeScore(verifyResult.resultText);
            if (!judge) {
                throw new Error(t('error.noJudgeScore'));
            }
            // 评分刚落盘、还没记分时到达的停止请求：手动停止优先，不把结果记成得分
            if (this.stoppedRuns.has(run.id)) {
                callbacks.updateCase(run.id, item.key, { status: 'stopped', finishedAt: Date.now() });
                return 'stopped';
            }
            callbacks.updateCase(run.id, item.key, {
                status: 'done',
                ratio: judge.ratio,
                score: Math.round(judge.ratio * item.spec.weight * 10000) / 10000,
                reason: judge.reason,
                // verifyTaskId 已由 onTaskCreated 在任务创建时写入
                finishedAt: Date.now()
            });
            return 'done';
        } catch (error) {
            // 验证任务执行到一半被停止时，验证评分拿不到是预期内的，按已停止收尾
            // 而不是失败（此时用例可能已有部分产出，但整轮都会被标记停止）
            if (this.stoppedRuns.has(run.id)) {
                callbacks.updateCase(run.id, item.key, { status: 'stopped', finishedAt: Date.now() });
                return 'stopped';
            }
            const message = toErrorMessage(error);
            logger.warn(`[benchmark] case ${item.key} failed: ${message}`);
            callbacks.updateCase(run.id, item.key, {
                status: 'failed',
                error: message,
                // 脚本失败时附带 stdout/stderr 合并输出，供详情面板「错误信息」栏展示
                logError: error instanceof ScriptExecutionError ? error.logError : '',
                finishedAt: Date.now()
            });
            return 'failed';
        }
    }

    private readJudgeResult(resultFile: string): { ratio: number; reason: string } | null {
        try {
            if (!fs.existsSync(resultFile)) return null;
            return parseJudgeScore(fs.readFileSync(resultFile, 'utf8'));
        } catch (error) {
            logger.warn(`[benchmark] failed to read judge result ${resultFile}: ${toErrorMessage(error)}`);
            return null;
        }
    }

    /** 空字符串表示使用模型默认推理强度 */
    private effortOf(value: string | undefined): ReasoningEffort | undefined {
        return value ? (value as ReasoningEffort) : undefined;
    }

    /** 登记当前用例正在执行的脚本句柄，stop() 时统一中止；顺带清掉已结束的句柄 */
    private trackScript(runId: string, script: ScriptHandle): void {
        let scripts = this.activeScripts.get(runId);
        if (!scripts) {
            scripts = new Set<ScriptHandle>();
            this.activeScripts.set(runId, scripts);
        }
        for (const existing of scripts) {
            if (existing.settled) scripts.delete(existing);
        }
        scripts.add(script);
    }

    private async executeTask(options: {
        runId: string;
        workspace: string;
        prompt: string;
        model: string;
        effort?: ReasoningEffort;
        title: string;
        timeoutSec: number;
        /** 任务对象创建后立即回调：让 taskId 先于执行结果落盘，运行中也可跳转 */
        onTaskCreated?: (taskId: string) => void;
    }): Promise<TaskExecutionResult> {
        const taskManager = GlobalState.getInstance().taskManagerState;
        const agent = AgentRegistry.getMainAgent();
        const modes = agent.supportedModes();
        const mode = modes.find((item) => item.id === 'unlimited') ?? modes[0];
        if (!mode) {
            throw new Error(t('error.agentModeMissing'));
        }

        const task = taskManager.createTask(options.model, { internal: true, taskName: options.title });
        options.onTaskCreated?.(task.task_id);
        let activeSet = this.activeTasks.get(options.runId);
        if (!activeSet) {
            activeSet = new Set<TaskState>();
            this.activeTasks.set(options.runId, activeSet);
        }
        activeSet.add(task);
        // 任务先挂进 activeTasks 再提交，stop() 不会因提交尚未完成而漏掉本任务；
        // 提交完成后若停止请求已先行，这里补一刀，避免停止信号落在 submitUserMessage 前被吞掉
        if (this.stoppedRuns.has(options.runId)) {
            try {
                task.stop('system');
            } catch {
                /* 任务可能已自行结束 */
            }
        }

        try {
            fs.mkdirSync(options.workspace, { recursive: true });
            await taskManager.initHarness(task, options.workspace, mode);
            await task.rebuildSystemPrompt();
            await task.hooks.noticeBeforeTaskStart({ task });

            const submitted = await task.submitUserMessage(
                options.prompt,
                options.effort ? { modelRequestOptions: { reasoningEffort: options.effort } } : {}
            );
            if (submitted.status === 'error') {
                throw new Error(t('error.caseSubmitFailed', { reason: submitted.messageKey }));
            }
            // 提交会把任务状态无条件置回 running 并起一个新 turn：停止请求落在提交前或提交
            // 过程中的话，上面那次 stop 会被提交"复活"，整轮停止就要等这个 turn 自己跑完。
            // 提交返回后再补一刀，turn 在下一个 await 点即可退出。
            if (this.stoppedRuns.has(options.runId)) {
                try {
                    task.stop('system');
                } catch {
                    /* 任务可能已自行结束 */
                }
            }

            let timedOut = false;
            const timer = setTimeout(
                () => {
                    timedOut = true;
                    try {
                        task.stop('system');
                    } catch {
                        /* 任务可能已结束，忽略 */
                    }
                },
                Math.max(1, options.timeoutSec) * 1000
            );
            try {
                // resolveOnStop：stop() 即使没能正常走完 turn 收尾（turn 卡在外部
                // 资源上），等待方也要立即返回，保证测评整轮可以收尾落盘
                await task.waitUntilFinished(undefined, true);
            } finally {
                clearTimeout(timer);
            }

            const completion = extractAttemptCompletionResult(task);
            return {
                resultText: completion?.result ?? '',
                timedOut
            };
        } finally {
            activeSet.delete(task);
            if (activeSet.size === 0) this.activeTasks.delete(options.runId);
            try {
                task.unload();
            } catch {
                /* 卸载失败不影响测评结果 */
            }
        }
    }
}
