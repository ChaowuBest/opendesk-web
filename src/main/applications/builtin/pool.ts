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

import { z } from 'zod';
import { BaseTool, BaseToolset, ToolResult } from '../../aikernel/tool.js';
import { Skill } from '../../aikernel/skill.js';
import { Card } from '../../tui/components/card.js';
import { statusDisplay, truncText } from '../../tui/components/toolcall.js';
import { startSubTask } from '../../aikernel/planning/tools.js';
import type { SubTaskResult, SubTaskConfig } from '../../aikernel/planning/common.js';
import type { TaskState } from '../../aikernel/states/tasks.js';
import type { ToolCall } from '../../aikernel/messages.js';
import { logger } from '../../utils/logger.js';
import chalk from 'chalk';

// ─── Skill Definition ──────────────────────────────────────────────────────────

export const POOL_SKILL = `
---
name: pool
description: >
  子任务池：用于批量执行大量结构相似的任务。适用于批量分析、批量构建、批量转换等场景。
  通过共享公共 Prompt 和独立参数 Prompt 的组合，高效地并发执行子任务，并自动管理重试和状态追踪。
user-invocable: true
disable-model-invocation: true
argument-hint: <描述批量任务需求>
---

# 子任务池（SubTask Pool）

本技能用于批量执行大量结构相似的子任务。当你需要对一组对象执行相同或相似的操作时，使用子任务池可以高效地并发处理。

## 适用场景

- **批量分析**：分析大量文件、Skill、代码模块的兼容性或质量
- **批量构建**：构建多个软件包、编译多个项目
- **批量转换**：格式转换、数据迁移、文件处理
- **批量测试**：运行多组测试用例、验证多个配置

## 使用 CreateSubTaskPool 工具

\`CreateSubTaskPool\` 工具接受以下参数：

- **commonPrompt**（必填）：所有子任务共享的公共 Prompt，包含完整的任务描述、操作步骤、输出格式要求等
- **taskItems**（必填）：子任务参数数组，每个元素包含该子任务的唯一参数（如文件路径、名称等）
- **concurrency**（可选，默认 3）：最大并发执行数
- **maxRetries**（可选，默认 5）：单个子任务最大重试次数

### 工作原理

1. 工具会为每个 taskItem 创建一个子任务
2. 每个子任务的 Prompt = commonPrompt + taskItem（参数 Prompt）
3. 工具按照指定的并发数同时执行多个子任务
4. 失败的子任务会自动重试（不超过最大重试次数）
5. 所有子任务完成后，工具同步返回汇总结果

### 编写高质量的 commonPrompt

commonPrompt 是所有子任务共享的指令，应当包含：
1. **任务目标**：清晰描述每个子任务需要完成什么
2. **操作步骤**：详细的执行步骤（子任务是独立的 Agent，需要完整的上下文）
3. **输出格式**：明确期望的输出格式和内容
4. **注意事项**：边界情况处理、错误处理等

### 编写 taskItems

taskItems 中的每个元素会拼接在 commonPrompt 之后，作为该子任务的专有参数。通常包含：
- 待处理的文件路径或名称
- 特定的配置参数
- 子任务的唯一标识信息

## 使用示例

### 示例1：批量分析 Skill 兼容性

\`\`\`
用户：这个目录下有500个zip文件，每个都是一个skill，帮我分析它们的兼容性

Agent思路：
1. 先列出目录下所有zip文件
2. 构造 commonPrompt 描述分析任务的完整流程
3. 每个zip文件路径作为一个 taskItem
4. 调用 CreateSubTaskPool 批量执行

调用 CreateSubTaskPool：
- commonPrompt: "请分析以下 Skill 的兼容性。步骤：1. 解压zip文件 2. 读取SKILL.md 3. 检查依赖项 4. 验证格式规范 5. 将分析报告保存到 results/{skill名称}/ 目录。输出格式：JSON，包含 name、compatible（布尔值）、issues（问题列表）。"
- taskItems: [
    "待分析的Skill文件：/path/to/skills/skill-001.zip",
    "待分析的Skill文件：/path/to/skills/skill-002.zip",
    ...
  ]
- concurrency: 5
\`\`\`

### 示例2：批量构建软件包

\`\`\`
用户：把这50个软件包都构建一遍

Agent思路：
1. 识别所有待构建的软件包目录
2. 构造 commonPrompt 描述构建流程
3. 每个软件包路径作为一个 taskItem

调用 CreateSubTaskPool：
- commonPrompt: "请构建指定的软件包。步骤：1. 进入软件包目录 2. 安装依赖(npm install) 3. 执行构建(npm run build) 4. 验证构建产物存在。如果构建失败，分析错误原因并报告。"
- taskItems: [
    "待构建的软件包目录：/workspace/packages/package-a",
    "待构建的软件包目录：/workspace/packages/package-b",
    ...
  ]
- concurrency: 3
\`\`\`

## 重要注意事项

1. **commonPrompt 要完整**：子任务是独立执行的 Agent，无法访问父任务的上下文，所有必要信息必须包含在 Prompt 中
2. **合理设置并发数**：并发过高可能导致资源竞争（如 CPU、内存、网络带宽），根据任务类型选择合适的并发数
3. **taskItem 要有区分度**：确保每个 taskItem 能唯一标识一个子任务的目标
4. **考虑幂等性**：由于可能重试，子任务应当设计为幂等操作
`;

export function loadPoolSkill(): Skill {
    const skill = Skill.parseMd(POOL_SKILL);
    const toolset = new BaseToolset('pool');
    toolset.addTool(new CreateSubTaskPoolTool());
    skill.toolsets = [toolset];
    return skill;
}

// ─── SubTask Pool State ────────────────────────────────────────────────────────

type PoolTaskStatus = 'pending' | 'running' | 'success' | 'fail' | 'retrying';

interface PoolTaskEntry {
    index: number;
    itemPrompt: string;
    status: PoolTaskStatus;
    retryCount: number;
    subtaskId?: string;
    result?: SubTaskResult;
    error?: string;
}

interface PoolState {
    totalCount: number;
    completedCount: number;
    successCount: number;
    failCount: number;
    runningCount: number;
    tasks: PoolTaskEntry[];
}

// ─── CreateSubTaskPool Tool ────────────────────────────────────────────────────

const CreateSubTaskPoolArgsSchema = z.object({
    commonPrompt: z.string().describe('所有子任务共享的公共Prompt，包含完整的任务描述、操作步骤和输出格式要求'),
    taskItems: z
        .array(z.string())
        .min(1)
        .describe('子任务参数数组，每个元素是该子任务专有的参数Prompt（如文件路径、名称等），会拼接在commonPrompt之后'),
    concurrency: z.number().int().min(1).max(20).default(3).describe('最大并发执行数，默认3'),
    maxRetries: z.number().int().min(0).max(10).default(5).describe('单个子任务最大重试次数，默认5')
});

export class CreateSubTaskPoolTool extends BaseTool<typeof CreateSubTaskPoolArgsSchema> {
    constructor() {
        super(
            'CreateSubTaskPool',
            '创建子任务池，批量并发执行结构相似的子任务，支持自动重试和进度追踪',
            CreateSubTaskPoolArgsSchema
        );
        this.setUniversalExecutor(this.handleExecute.bind(this));
    }

    // ─── TUI Rendering ─────────────────────────────────────────────────────

    private static getPoolState(toolcall: ToolCall): PoolState | undefined {
        return (toolcall.result_object as any)?.pool_state as PoolState | undefined;
    }

    private static renderProgressBar(completed: number, total: number, barWidth: number): string {
        const ratio = total > 0 ? completed / total : 0;
        const filled = Math.round(ratio * barWidth);
        const empty = barWidth - filled;
        const percent = Math.round(ratio * 100);
        return chalk.greenBright('█'.repeat(filled)) + chalk.dim('░'.repeat(empty)) + chalk.white(` ${percent}%`);
    }

    private static renderPoolBody(state: PoolState, width: number): string[] {
        const body: string[] = [];
        const innerWidth = Math.max(20, width - 8);

        const barWidth = Math.min(20, innerWidth - 20);
        body.push(
            chalk.dim('进度: ') +
                CreateSubTaskPoolTool.renderProgressBar(state.completedCount, state.totalCount, barWidth) +
                chalk.dim(` (${state.completedCount}/${state.totalCount})`)
        );

        const stats: string[] = [];
        if (state.successCount > 0) stats.push(chalk.greenBright(`✔ ${state.successCount}`));
        if (state.failCount > 0) stats.push(chalk.redBright(`✘ ${state.failCount}`));
        if (state.runningCount > 0) stats.push(chalk.blueBright(`● ${state.runningCount}`));
        const pendingCount = state.totalCount - state.completedCount - state.runningCount;
        if (pendingCount > 0) stats.push(chalk.dim(`○ ${pendingCount}`));
        body.push(chalk.dim('状态: ') + stats.join(chalk.dim(' │ ')));

        const runningTasks = state.tasks.filter((t) => t.status === 'running' || t.status === 'retrying');
        if (runningTasks.length > 0) {
            body.push(chalk.dim('─'.repeat(Math.min(innerWidth, 30))));
            const maxShow = 5;
            for (let i = 0; i < Math.min(runningTasks.length, maxShow); i++) {
                const t = runningTasks[i];
                const icon = t.status === 'retrying' ? chalk.yellowBright('↻') : chalk.blueBright('▸');
                const retryTag = t.retryCount > 0 ? chalk.dim(` (重试 ${t.retryCount})`) : '';
                const label = truncText(t.itemPrompt, innerWidth - 12);
                body.push(`  ${icon} #${t.index + 1} ${chalk.dim(label)}${retryTag}`);
            }
            if (runningTasks.length > maxShow) {
                body.push(chalk.dim(`  … 还有 ${runningTasks.length - maxShow} 个任务执行中`));
            }
        }

        return body;
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof CreateSubTaskPoolArgsSchema> | undefined;
        const body: string[] = [];

        if (args) {
            body.push(
                chalk.dim('任务数: ') +
                    chalk.white(String(args.taskItems?.length ?? 0)) +
                    chalk.dim(' │ 并发: ') +
                    chalk.white(String(args.concurrency ?? 3)) +
                    chalk.dim(' │ 重试: ') +
                    chalk.white(String(args.maxRetries ?? 5))
            );
            if (args.commonPrompt) {
                body.push(chalk.dim('公共Prompt: ') + truncText(args.commonPrompt, width - 18));
            }
        }

        const poolState = CreateSubTaskPoolTool.getPoolState(toolcall);

        if (toolcall.status === 'running' && poolState) {
            body.push('');
            body.push(...CreateSubTaskPoolTool.renderPoolBody(poolState, width));
        }

        if (toolcall.status === 'success' && poolState) {
            body.push('');
            const barWidth = Math.min(20, Math.max(10, width - 30));
            body.push(
                chalk.dim('进度: ') +
                    CreateSubTaskPoolTool.renderProgressBar(poolState.completedCount, poolState.totalCount, barWidth) +
                    chalk.dim(` (${poolState.completedCount}/${poolState.totalCount})`)
            );
            if (poolState.successCount > 0) {
                body.push(chalk.greenBright(`  ✔ ${poolState.successCount} 个任务成功`));
            }
            if (poolState.failCount > 0) {
                body.push(chalk.redBright(`  ✘ ${poolState.failCount} 个任务失败`));
                const failedTasks = poolState.tasks.filter((t) => t.status === 'fail');
                for (const t of failedTasks.slice(0, 3)) {
                    body.push(
                        chalk.redBright('    ') + chalk.dim(`#${t.index + 1} `) + truncText(t.itemPrompt, width - 16)
                    );
                }
                if (failedTasks.length > 3) {
                    body.push(chalk.dim(`    … 还有 ${failedTasks.length - 3} 个失败任务`));
                }
            }
        }

        if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '🔄',
            title: '子任务池',
            status: statusDisplay(toolcall.status),
            body,
            maxLines: 20,
            truncateStrategy: 'tail'
        }).render(width);
    }

    // ─── GUI Rendering ────────────────────────────────────────────────────

    private static escapeHtml(text: string): string {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    private static renderTaskRow(task: PoolTaskEntry): string {
        const statusMap: Record<PoolTaskStatus, { label: string; color: string; dot: string }> = {
            pending: { label: '待执行', color: '#94a3b8', dot: '#cbd5e1' },
            running: { label: '执行中', color: '#64748b', dot: '#64748b' },
            retrying: { label: '重试中', color: '#92400e', dot: '#d97706' },
            success: { label: '已完成', color: '#166534', dot: '#4ade80' },
            fail: { label: '失败', color: '#b91c1c', dot: '#f87171' }
        };
        const s = statusMap[task.status] || statusMap.pending;
        const label = task.itemPrompt.length > 50 ? task.itemPrompt.slice(0, 47) + '…' : task.itemPrompt;
        const retryBadge =
            task.retryCount > 0
                ? `<span class="text-[9px]" style="color:#92400e;margin-left:4px;">(×${task.retryCount})</span>`
                : '';
        const runningAnim = task.status === 'running' || task.status === 'retrying' ? ' animate-pulse' : '';

        return `
        <div class="flex items-center px-3.5 py-[5px] border-b border-[#f8fafc] last:border-b-0 hover:bg-[#f8fafc] transition-colors" data-pool-task-idx="${task.index}" data-pool-task-status="${task.status}">
            <span class="w-1.5 h-1.5 rounded-full shrink-0 mr-2.5${runningAnim}" style="background:${s.dot}"></span>
            <div class="flex-1 min-w-0">
                <span class="text-[11px] text-[#334155] truncate block">#${task.index + 1} ${CreateSubTaskPoolTool.escapeHtml(label)}</span>
            </div>
            <span class="text-[10px] shrink-0 ml-2" style="color:${s.color}">${s.label}</span>${retryBadge}
        </div>`;
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as z.output<typeof CreateSubTaskPoolArgsSchema> | undefined;
        const poolState = CreateSubTaskPoolTool.getPoolState(toolcall);
        const totalCount = poolState?.totalCount ?? args?.taskItems?.length ?? 0;
        const completedCount = poolState?.completedCount ?? 0;
        const successCount = poolState?.successCount ?? 0;
        const failCount = poolState?.failCount ?? 0;
        const runningCount = poolState?.runningCount ?? 0;
        const pendingCount = totalCount - completedCount - runningCount;
        const progressPercent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

        const isRunning = toolcall.status === 'running';
        const isComplete = toolcall.status === 'success' || toolcall.status === 'error';

        // Segmented control 标签（macOS 风格滑块）
        const tabs = [
            { id: 'all', label: '全部', count: totalCount },
            { id: 'running', label: '执行中', count: runningCount },
            { id: 'success', label: '已完成', count: successCount },
            { id: 'fail', label: '失败', count: failCount }
        ];

        const tabsHtml = tabs
            .map(
                (tab) =>
                    `<button class="pool-seg-btn ${tab.id === 'all' ? 'active' : ''}${tab.count === 0 && tab.id !== 'all' ? ' disabled' : ''}" data-pool-filter="${tab.id}">${tab.label} ${tab.count}</button>`
            )
            .join('');

        // 进度指示 — 紧凑的在 header 右侧
        let progressHtml: string;
        if (isRunning) {
            progressHtml = `
                <div class="flex items-center gap-2">
                    <i class="fa-solid fa-circle-notch fa-spin text-[#94a3b8] text-[10px]"></i>
                    <span class="text-[11px] text-[#64748b] font-medium">${completedCount}/${totalCount}</span>
                    <div class="w-16 h-1 rounded-full bg-[#f1f5f9] overflow-hidden">
                        <div class="h-full rounded-full bg-[#94a3b8] transition-all duration-300" style="width:${progressPercent}%"></div>
                    </div>
                </div>`;
        } else if (isComplete && failCount === 0) {
            progressHtml = `
                <div class="flex items-center gap-1 text-[#166534]">
                    <i class="fa-solid fa-circle-check text-[10px]"></i>
                    <span class="text-[10px] font-medium">全部完成</span>
                </div>`;
        } else if (isComplete && failCount > 0) {
            progressHtml = `
                <div class="flex items-center gap-1 text-[#b91c1c]">
                    <i class="fa-solid fa-triangle-exclamation text-[10px]"></i>
                    <span class="text-[10px] font-medium">${successCount} 成功 · ${failCount} 失败</span>
                </div>`;
        } else {
            progressHtml = `<span class="text-[10px] text-[#94a3b8]">等待启动</span>`;
        }

        // 任务列表
        const tasks = poolState?.tasks ?? [];
        const maxDisplay = 8;
        const displayTasks = tasks.slice(0, maxDisplay);
        const taskRowsHtml = displayTasks.map((t) => CreateSubTaskPoolTool.renderTaskRow(t)).join('');
        const moreHtml =
            tasks.length > maxDisplay
                ? `<div class="text-center text-[10px] text-[#94a3b8] py-1.5">… 还有 ${tasks.length - maxDisplay} 个任务</div>`
                : '';

        return `
        <div class="subtask-pool-card my-1.5 w-full rounded-lg border border-[#e2e8f0] bg-white overflow-hidden" data-pool-toolcall-id="${toolcall.id}">
            <!-- Header -->
            <div class="flex items-center justify-between px-3.5 py-1.5 border-b border-[#f1f5f9] bg-[#f8fafc]">
                <div class="flex items-center gap-2">
                    <svg class="w-3.5 h-3.5 text-[#64748b] shrink-0" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
                        <path d="M4 6h16M4 12h16M4 18h16"/>
                    </svg>
                    <span class="text-[11px] font-semibold text-[#475569]">子任务池</span>
                    <span class="text-[10px] text-[#94a3b8]">${totalCount} 个 · 并发 ${args?.concurrency ?? 3}</span>
                </div>
                ${progressHtml}
            </div>

            <!-- Segmented Control -->
            <div class="flex items-center px-3.5 py-1.5 border-b border-[#f1f5f9]">
                <div class="pool-seg">
                    <div class="pool-seg-indicator"></div>
                    ${tabsHtml}
                </div>
            </div>

            <!-- Task List -->
            <div class="pool-task-list max-h-[220px] overflow-y-auto">
                ${taskRowsHtml}
                ${moreHtml}
                ${tasks.length === 0 ? '<div class="text-center text-[11px] text-[#94a3b8] py-3">等待任务启动…</div>' : ''}
            </div>
        </div>`;
    }

    // ─── Execution ──────────────────────────────────────────────────────────

    private async handleExecute(
        args: z.output<typeof CreateSubTaskPoolArgsSchema>,
        toolResult: ToolResult,
        taskState?: TaskState
    ): Promise<void> {
        if (!taskState) {
            throw new Error('CreateSubTaskPool requires task state');
        }

        const { commonPrompt, taskItems, concurrency, maxRetries } = args;

        const poolState: PoolState = {
            totalCount: taskItems.length,
            completedCount: 0,
            successCount: 0,
            failCount: 0,
            runningCount: 0,
            tasks: taskItems.map((item, i) => ({
                index: i,
                itemPrompt: item,
                status: 'pending' as PoolTaskStatus,
                retryCount: 0
            }))
        };

        const PROGRESS_THROTTLE_MS = 1000;
        let lastProgressPushMs = 0;
        let lastProgressSignature = '';
        let progressPending = false;
        let progressTimer: ReturnType<typeof setTimeout> | undefined;

        const makeProgressSignature = () =>
            JSON.stringify({
                completedCount: poolState.completedCount,
                successCount: poolState.successCount,
                failCount: poolState.failCount,
                runningCount: poolState.runningCount,
                tasks: poolState.tasks.map((task) => ({
                    status: task.status,
                    retryCount: task.retryCount,
                    subtaskId: task.subtaskId,
                    error: task.error
                }))
            });

        const pushProgress = (force = false) => {
            const signature = makeProgressSignature();
            if (!force && signature === lastProgressSignature) {
                progressPending = false;
                return;
            }
            lastProgressSignature = signature;
            toolResult.updateResultObject({ pool_state: { ...poolState, tasks: [...poolState.tasks] } });
            lastProgressPushMs = Date.now();
            progressPending = false;
        };

        const updateProgress = (force = false) => {
            if (force) {
                if (progressTimer) {
                    clearTimeout(progressTimer);
                    progressTimer = undefined;
                }
                pushProgress(true);
                return;
            }
            const elapsed = Date.now() - lastProgressPushMs;
            if (elapsed >= PROGRESS_THROTTLE_MS) {
                pushProgress();
            } else if (!progressPending) {
                progressPending = true;
                progressTimer = setTimeout(() => {
                    progressTimer = undefined;
                    pushProgress();
                }, PROGRESS_THROTTLE_MS - elapsed);
            }
        };

        updateProgress(true);

        logger.info(
            `[pool] starting pool: total=${taskItems.length} concurrency=${concurrency} maxRetries=${maxRetries}`
        );

        const executeTask = async (entry: PoolTaskEntry): Promise<void> => {
            if (taskState.task_status === 'stopped') {
                entry.status = 'fail';
                entry.error = '父任务已停止';
                poolState.completedCount++;
                poolState.failCount++;
                updateProgress();
                return;
            }

            entry.status = entry.retryCount > 0 ? 'retrying' : 'running';
            poolState.runningCount++;
            updateProgress();

            const fullObjective = `${commonPrompt}\n\n---\n\n## 本次子任务的参数\n\n${entry.itemPrompt}`;

            const config: SubTaskConfig = {
                title: `池任务 #${entry.index + 1}`,
                objective: fullObjective,
                criteria:
                    '请根据公共Prompt中的要求完成任务，并通过 planning-attemptCompletion 提交结果。如果任务成功，type 设为 success；如果失败，type 设为 fail 并说明原因。',
                isAsync: false
            };

            try {
                const result = await startSubTask({
                    parentTask: taskState,
                    config
                });

                poolState.runningCount--;
                entry.subtaskId = result.subtask_id;
                entry.result = result;

                if (result.success) {
                    entry.status = 'success';
                    poolState.successCount++;
                    poolState.completedCount++;
                    updateProgress();
                } else {
                    if (entry.retryCount < maxRetries) {
                        entry.retryCount++;
                        entry.status = 'pending';
                        updateProgress();
                        logger.info(
                            `[pool] task #${entry.index + 1} failed, retrying (${entry.retryCount}/${maxRetries}): ${result.result?.slice(0, 100)}`
                        );
                        await executeTask(entry);
                    } else {
                        entry.status = 'fail';
                        entry.error = result.result;
                        poolState.failCount++;
                        poolState.completedCount++;
                        updateProgress();
                        logger.warn(
                            `[pool] task #${entry.index + 1} exhausted retries: ${result.result?.slice(0, 100)}`
                        );
                    }
                }
            } catch (err: any) {
                poolState.runningCount--;
                const errMsg = err?.message ?? String(err);

                if (entry.retryCount < maxRetries) {
                    entry.retryCount++;
                    entry.status = 'pending';
                    updateProgress();
                    logger.info(
                        `[pool] task #${entry.index + 1} threw error, retrying (${entry.retryCount}/${maxRetries}): ${errMsg.slice(0, 100)}`
                    );
                    await executeTask(entry);
                } else {
                    entry.status = 'fail';
                    entry.error = errMsg;
                    poolState.failCount++;
                    poolState.completedCount++;
                    updateProgress();
                    logger.warn(
                        `[pool] task #${entry.index + 1} exhausted retries after error: ${errMsg.slice(0, 100)}`
                    );
                }
            }
        };

        // Concurrency control via a simple semaphore
        let activeCount = 0;
        let taskIndex = 0;
        const allDone = new Promise<void>((resolve) => {
            const tryStartNext = () => {
                while (activeCount < concurrency && taskIndex < poolState.tasks.length) {
                    if (taskState.task_status === 'stopped') {
                        // Mark remaining tasks as failed
                        for (let i = taskIndex; i < poolState.tasks.length; i++) {
                            const t = poolState.tasks[i];
                            if (t.status === 'pending') {
                                t.status = 'fail';
                                t.error = '父任务已停止';
                                poolState.completedCount++;
                                poolState.failCount++;
                            }
                        }
                        updateProgress();
                        if (activeCount === 0) resolve();
                        return;
                    }

                    const entry = poolState.tasks[taskIndex];
                    taskIndex++;
                    activeCount++;

                    executeTask(entry).finally(() => {
                        activeCount--;
                        if (poolState.completedCount >= poolState.totalCount) {
                            resolve();
                        } else {
                            tryStartNext();
                        }
                    });
                }

                if (activeCount === 0 && poolState.completedCount >= poolState.totalCount) {
                    resolve();
                }
            };

            tryStartNext();
        });

        await allDone;

        updateProgress(true);

        const summaryResults = poolState.tasks.map((t) => ({
            index: t.index,
            itemPrompt: t.itemPrompt.length > 200 ? t.itemPrompt.slice(0, 200) + '…' : t.itemPrompt,
            status: t.status,
            subtaskId: t.subtaskId ?? 'n/a',
            retryCount: t.retryCount,
            success: t.status === 'success',
            result: t.result?.result ?? t.error ?? '未知'
        }));

        const summary = {
            totalCount: poolState.totalCount,
            successCount: poolState.successCount,
            failCount: poolState.failCount,
            tasks: summaryResults
        };

        toolResult.result = JSON.stringify(summary);

        logger.info(
            `[pool] completed: total=${poolState.totalCount} success=${poolState.successCount} fail=${poolState.failCount}`
        );
    }
}
