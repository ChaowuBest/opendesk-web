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
import { spawn } from 'child_process';
import { GlobalState } from '../../aikernel/states/global.js';
import { AgentRegistry } from '../../aikernel/agents/registry.js';
import { extractAttemptCompletionResult } from '../../aikernel/planning/harness.js';
import type { TaskState } from '../../aikernel/states/tasks.js';
import type { ReasoningEffort } from '../../aikernel/types/reasoning.js';
import { logger } from '../../utils/logger.js';
import { t } from './locale/index.js';
import { toErrorMessage } from '../../../common/utils/error.js';
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
    taskId: string;
    resultText: string;
    timedOut: boolean;
}

interface ScriptExecutionResult {
    ok: boolean;
    code: number | null;
    error: string;
}

const RESULT_FILE_NAME = 'result.json';
const RESULT_DIR_NAME = '.benchmark';

export class BenchmarkRunner {
    private readonly activeTasks = new Map<string, Set<TaskState>>();
    private readonly stoppedRuns = new Set<string>();

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
        callbacks.finishRun(run.id, resolveRunStatus(outcomes, stopped, plan.length));
    }

    stop(runId: string): void {
        this.stoppedRuns.add(runId);
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

        const baseEnv = {
            ...process.env,
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
        } as NodeJS.ProcessEnv;

        try {
            if (item.spec.runPrepareFile) {
                const result = await this.runScript({
                    scriptPath: path.join(item.dir, item.spec.runPrepareFile),
                    cwd: item.dir,
                    env: { ...baseEnv, BENCH_PHASE: 'run-prepare' },
                    logPath: path.join(logDir, 'run-prepare.log'),
                    timeoutSec: item.spec.prepareTimeoutSec
                });
                if (!result.ok) {
                    throw new Error(t('error.caseRunPrepareFailed', { reason: result.error }));
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
                timeoutSec: run.runTimeoutSec ?? item.spec.runTimeoutSec
            });
            callbacks.updateCase(run.id, item.key, {
                runTaskId: runResult.taskId,
                ...(runResult.timedOut ? { error: t('error.runTimedOut') } : {})
            });

            if (this.stoppedRuns.has(run.id)) {
                callbacks.updateCase(run.id, item.key, { status: 'stopped', finishedAt: Date.now() });
                return 'stopped';
            }

            callbacks.updateCase(run.id, item.key, { status: 'verifying' });
            if (item.spec.verifyPrepareFile) {
                const prepared = await this.runScript({
                    scriptPath: path.join(item.dir, item.spec.verifyPrepareFile),
                    cwd: item.dir,
                    env: { ...baseEnv, BENCH_PHASE: 'verify-prepare' },
                    logPath: path.join(logDir, 'verify-prepare.log'),
                    timeoutSec: item.spec.prepareTimeoutSec
                });
                if (!prepared.ok) {
                    throw new Error(t('error.caseVerifyPrepareFailed', { reason: prepared.error }));
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
                timeoutSec: run.verifyTimeoutSec ?? item.spec.verifyTimeoutSec
            });

            const judge = this.readJudgeResult(resultFile) ?? parseJudgeScore(verifyResult.resultText);
            if (!judge) {
                throw new Error(t('error.noJudgeScore'));
            }
            callbacks.updateCase(run.id, item.key, {
                status: 'done',
                ratio: judge.ratio,
                score: Math.round(judge.ratio * item.spec.weight * 10000) / 10000,
                reason: judge.reason,
                verifyTaskId: verifyResult.taskId,
                finishedAt: Date.now()
            });
            return 'done';
        } catch (error) {
            const message = toErrorMessage(error);
            logger.warn(`[benchmark] case ${item.key} failed: ${message}`);
            callbacks.updateCase(run.id, item.key, {
                status: 'failed',
                error: message,
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

    private runScript(options: {
        scriptPath: string;
        cwd: string;
        env: NodeJS.ProcessEnv;
        logPath: string;
        timeoutSec: number;
    }): Promise<ScriptExecutionResult> {
        return new Promise((resolve) => {
            let output: fs.WriteStream | null = null;
            try {
                output = fs.createWriteStream(options.logPath, { flags: 'a' });
                // 日志目录不可写时 createWriteStream 不会同步抛错，而是后来抛 error 事件；
                // 没有监听器的话这个 error 会变成未捕获异常，把整个 worker 带崩。
                output.on('error', (error) => {
                    logger.warn(`[benchmark] failed to write script log ${options.logPath}: ${toErrorMessage(error)}`);
                    output = null;
                });
                output.write(`\n$ bash ${options.scriptPath}\n`);
            } catch (error) {
                logger.warn(`[benchmark] failed to open script log ${options.logPath}: ${toErrorMessage(error)}`);
                output = null;
            }

            let settled = false;
            let child: ReturnType<typeof spawn> | null = null;

            /** 脚本超时被杀掉后仍可能有残留输出，写已 end 的流会抛 write after end */
            const writeChunk = (chunk: Buffer | string) => {
                if (!output || output.writableEnded || output.destroyed) return;
                output.write(chunk);
            };

            const finish = (result: ScriptExecutionResult) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                output?.end();
                resolve(result);
            };

            const timer = setTimeout(
                () => {
                    killTree(child);
                    finish({ ok: false, code: null, error: t('error.scriptTimeout', { seconds: options.timeoutSec }) });
                },
                Math.max(1, options.timeoutSec) * 1000
            );

            try {
                child = spawn('/bin/bash', [options.scriptPath], {
                    cwd: options.cwd,
                    env: options.env,
                    detached: process.platform !== 'win32',
                    stdio: ['ignore', 'pipe', 'pipe']
                });
            } catch (error) {
                finish({ ok: false, code: null, error: toErrorMessage(error) });
                return;
            }

            child.stdout?.on('data', (chunk: Buffer) => writeChunk(chunk));
            child.stderr?.on('data', (chunk: Buffer) => writeChunk(chunk));
            child.on('error', (error) => finish({ ok: false, code: null, error: toErrorMessage(error) }));
            child.on('close', (code) => {
                finish({
                    ok: code === 0,
                    code,
                    error: code === 0 ? '' : t('error.scriptExitCode', { code: code ?? '' })
                });
            });
        });
    }

    /** 空字符串表示使用模型默认推理强度 */
    private effortOf(value: string | undefined): ReasoningEffort | undefined {
        return value ? (value as ReasoningEffort) : undefined;
    }

    private async executeTask(options: {
        runId: string;
        workspace: string;
        prompt: string;
        model: string;
        effort?: ReasoningEffort;
        title: string;
        timeoutSec: number;
    }): Promise<TaskExecutionResult> {
        const taskManager = GlobalState.getInstance().taskManagerState;
        const agent = AgentRegistry.getMainAgent();
        const modes = agent.supportedModes();
        const mode = modes.find((item) => item.id === 'unlimited') ?? modes[0];
        if (!mode) {
            throw new Error(t('error.agentModeMissing'));
        }

        const task = taskManager.createTask(options.model, { internal: true, taskName: options.title });
        let activeSet = this.activeTasks.get(options.runId);
        if (!activeSet) {
            activeSet = new Set<TaskState>();
            this.activeTasks.set(options.runId, activeSet);
        }
        activeSet.add(task);

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
                await task.waitUntilFinished();
            } finally {
                clearTimeout(timer);
            }

            const completion = extractAttemptCompletionResult(task);
            return {
                taskId: task.task_id,
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

function killTree(child: ReturnType<typeof spawn> | null): void {
    if (!child || child.pid === undefined) return;
    try {
        if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
        } else {
            process.kill(-child.pid, 'SIGKILL');
        }
    } catch {
        try {
            child.kill('SIGKILL');
        } catch {
            /* 进程已退出 */
        }
    }
}
