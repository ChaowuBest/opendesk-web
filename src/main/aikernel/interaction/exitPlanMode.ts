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
 * ExitPlanMode 工具 —— 仅在 Plan Mode 中可用。
 *
 * 当 agent 完成规划后调用此工具，向用户展示完整计划并请求审批。
 * 用户可选择切换到 Standard 或 Solo 模式执行计划，或继续编辑。
 */

import { z } from 'zod';
import { InteractiveTool, ToolResult } from '../tool.js';
import { Card } from '../../tui/components/card.js';
import { statusDisplay, truncText } from '../../tui/components/toolcall.js';
import type { ToolCall } from '../messages.js';
import { cleanPathInput } from '../../../utils/path.js';
import path from 'path';
import fs from 'fs';
import type { TaskState } from '../states/tasks.js';
import chalk from 'chalk';

// ─── Provider 接口 ────────────────────────────────────────────────────────────

export type ExitPlanModeAction = 'execute-standard' | 'execute-solo' | 'continue-editing';

export interface ExitPlanModeResponse {
    action: ExitPlanModeAction;
}

/**
 * ExitPlanMode 交互提供者接口。
 * TUI 和 Electron 各自实现此接口。
 *
 * 实现方需负责：
 * 1. 向用户展示计划内容
 * 2. 让用户选择动作（执行 Standard/Solo 或继续编辑）
 * 3. 如果用户选择执行，切换到对应模式
 */
export interface ExitPlanModeProvider {
    promptAndSwitch(
        planContent: string,
        planFilePath: string,
        taskId?: string,
        taskName?: string
    ): Promise<ExitPlanModeResponse>;
    isPrompting?(): boolean;
    /** 主动取消当前等待中的审批（模式切换为不交互模式时调用），resolve 为 continue-editing。 */
    cancelCurrent?(): void;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const ExitPlanModeArgsSchema = z.object({
    planFilePath: z.string().describe('计划文件的路径（即你之前使用 writeFile 写入的 .plan/ 目录下的文件路径）'),
    planSummary: z.string().optional().describe('计划摘要，简要描述计划的主要内容（可选）')
});

// ─── Tool ─────────────────────────────────────────────────────────────────────

export class ExitPlanModeTool extends InteractiveTool<typeof ExitPlanModeArgsSchema> {
    private provider: ExitPlanModeProvider | null = null;

    constructor() {
        super(
            'exitPlanMode',
            '提交计划供用户审批并退出 Plan Mode。调用时必须传入 planFilePath 参数指向之前写入的计划文件。' +
                '系统将向用户展示该文件内容，用户可以选择切换到 Standard 模式（需确认操作）或 Solo 模式（全自动）来执行计划，' +
                '也可以选择继续编辑计划。此工具仅在 Plan Mode 中可用。',
            ExitPlanModeArgsSchema,
            undefined,
            { 'zh-CN': '退出规划模式', 'en-US': 'Exit Plan Mode' }
        );
        this.setUniversalExecutor(this.handleExecute.bind(this));
    }

    setProvider(provider: ExitPlanModeProvider): void {
        this.provider = provider;
    }

    cancelCurrent(): void {
        this.provider?.cancelCurrent?.();
    }

    isAvailable(taskState?: TaskState): boolean {
        if (!taskState) return false;
        return taskState.getAgent().agentId === 'main' && taskState.getAgentMode().id === 'plan';
    }

    private isProviderPrompting(): boolean {
        return this.provider?.isPrompting?.() ?? false;
    }

    // ── CLI 渲染 ──────────────────────────────────────────────────────────────

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        if (this.isProviderPrompting()) {
            return [];
        }

        const body: string[] = [];

        if (toolcall.status === 'running') {
            body.push(chalk.dim('正在等待用户审批计划…'));
        }

        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const parsed = JSON.parse(toolcall.result);
                if (parsed.action === 'continue-editing') {
                    body.push(chalk.yellowBright('用户选择继续编辑计划'));
                } else if (parsed.action === 'execute-standard') {
                    body.push(chalk.greenBright('计划已审批 → 切换到 Standard 模式'));
                } else if (parsed.action === 'execute-solo') {
                    body.push(chalk.greenBright('计划已审批 → 切换到 Solo 模式'));
                }
                if (parsed.planFile) {
                    body.push(chalk.dim('计划文件: ') + chalk.cyan(truncText(parsed.planFile, width - 16)));
                }
            } catch {
                /* ignore */
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright(truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '📋',
            title: '退出计划模式',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    // ── GUI 渲染 ──────────────────────────────────────────────────────────────

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const isRunning = toolcall.status === 'running';
        const isError = toolcall.status === 'error';

        const borderColor = isError ? 'border-red-200' : 'border-amber-200';
        const iconBg = isError
            ? 'bg-red-50 text-red-400'
            : isRunning
              ? 'bg-amber-50 text-amber-500'
              : 'bg-emerald-50 text-emerald-500';

        let statusBadge = '';
        let bodyContent = '';

        if (isRunning) {
            statusBadge = `<span class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-50 text-amber-600"><i class="fa-solid fa-circle-notch fa-spin text-[8px]"></i>等待审批</span>`;
            bodyContent = `<div class="px-3.5 py-2.5 flex items-center gap-2 text-[12px] text-gray-400"><i class="fa-solid fa-circle-notch fa-spin text-amber-400"></i>请在下方面板中审批计划…</div>`;
        } else if (isError) {
            statusBadge = `<span class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-50 text-red-500"><i class="fa-solid fa-circle-xmark text-[8px]"></i>失败</span>`;
            if (toolcall.result) {
                bodyContent = `<div class="px-3.5 py-2.5 text-[12px] text-red-600">${escapeHtml(String(toolcall.result).slice(0, 200))}</div>`;
            }
        } else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const parsed = JSON.parse(toolcall.result);
                if (parsed.action === 'continue-editing') {
                    statusBadge = `<span class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-yellow-50 text-yellow-600"><i class="fa-solid fa-pen text-[8px]"></i>继续编辑</span>`;
                    bodyContent = `<div class="px-3.5 py-2.5 text-[12px] text-gray-500">用户选择继续编辑计划</div>`;
                } else {
                    const modeName = parsed.action === 'execute-standard' ? '标准' : '效率';
                    statusBadge = `<span class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-50 text-emerald-600"><i class="fa-solid fa-circle-check text-[8px]"></i>已审批</span>`;
                    bodyContent = `<div class="px-3.5 py-2.5 text-[12px] text-emerald-600">计划已审批，已切换到${escapeHtml(modeName)}模式</div>`;
                }
                if (parsed.planFile) {
                    const planFilePath = escapeHtml(parsed.planFile);
                    bodyContent += `<div class="px-3.5 pb-2 text-[11px] text-gray-400 font-mono truncate flex items-center gap-1.5"><i class="fa-solid fa-file-lines text-[9px] text-gray-300"></i><a class="text-blue-600 hover:text-blue-800 hover:underline cursor-pointer" data-open-preview="${planFilePath}" title="点击预览计划文件">${planFilePath}</a></div>`;
                }
            } catch {
                statusBadge = `<span class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-50 text-emerald-600"><i class="fa-solid fa-circle-check text-[8px]"></i>完成</span>`;
            }
        }

        return `
        <details class="my-1.5 rounded-lg border ${borderColor} bg-white overflow-hidden w-full" open>
            <summary class="flex items-center gap-2 px-3 py-2 cursor-pointer select-none hover:bg-gray-50/60 transition-colors duration-150">
                <span class="inline-flex items-center justify-center w-5 h-5 rounded ${iconBg}">
                    <i class="fa-solid fa-clipboard-check text-[10px]"></i>
                </span>
                <span class="text-[12px] text-gray-500 shrink-0">退出计划模式</span>
                <span class="text-[12px] text-gray-600 truncate flex-1">提交计划供审批</span>
                ${statusBadge}
                <svg class="w-3 h-3 text-gray-400 shrink-0 transition-transform duration-200" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path d="M6 9l6 6 6-6"/>
                </svg>
            </summary>
            ${bodyContent ? `<div class="border-t border-gray-100 bg-gray-50/40">${bodyContent}</div>` : ''}
        </details>`;
    }

    // ── 执行 ──────────────────────────────────────────────────────────────────

    private async handleExecute(
        _args: z.output<typeof ExitPlanModeArgsSchema>,
        toolResult: ToolResult,
        taskState?: TaskState
    ): Promise<void> {
        if (!this.provider) {
            toolResult.result = JSON.stringify({
                error: 'no_provider',
                message: '没有可用的用户交互界面，无法提交计划审批'
            });
            throw new Error('ExitPlanModeTool: no provider configured');
        }

        // 读取 agent 指定的计划文件
        const workspace = taskState?.harnessContext?.workspace || '';
        const rawPath = _args.planFilePath;
        const cleanedPath = cleanPathInput(rawPath);
        const planFilePath = path.isAbsolute(cleanedPath) ? cleanedPath : path.resolve(workspace, cleanedPath);

        // 安全校验：计划文件必须在工作空间的 .plan 目录内
        const planDir = path.join(workspace, '.plan');
        const normalizedPlanFile = path.normalize(planFilePath);
        const normalizedPlanDir = path.normalize(planDir);
        if (!normalizedPlanFile.startsWith(normalizedPlanDir + path.sep) && normalizedPlanFile !== normalizedPlanDir) {
            toolResult.result = JSON.stringify({
                error: 'invalid_path',
                message: `计划文件路径必须位于 .plan/ 目录内，当前路径: ${planFilePath}`
            });
            throw new Error(`exitPlanMode: 计划文件路径不在 .plan/ 目录内: ${planFilePath}`);
        }

        let planContent = '';
        try {
            if (fs.existsSync(planFilePath)) {
                planContent = fs.readFileSync(planFilePath, 'utf-8');
            }
        } catch {
            /* 读取失败不阻塞流程 */
        }

        if (!planContent) {
            toolResult.result = JSON.stringify({
                error: 'no_plan',
                message: `未找到计划文件 ${planFilePath}。请先将计划写入该路径后再调用此工具。`
            });
            throw new Error(`exitPlanMode: 计划文件不存在 ${planFilePath}`);
        }

        // 向用户展示计划并获取决定
        const response = await this.provider.promptAndSwitch(
            planContent,
            planFilePath,
            taskState?.task_id,
            taskState?.task_name ?? undefined
        );

        if (response.action === 'continue-editing') {
            toolResult.result = JSON.stringify({
                action: 'continue-editing',
                planFile: planFilePath,
                message:
                    '用户选择继续编辑计划。请立即使用 askUser 工具询问用户希望如何修改计划（例如：哪些步骤需要调整、是否遗漏了某些需求、是否需要更改实现策略等），然后根据用户反馈修改计划并再次提交审批。'
            });
        } else {
            const modeName = response.action === 'execute-standard' ? 'Standard' : 'Solo';
            toolResult.result = JSON.stringify({
                action: response.action,
                planFile: planFilePath,
                plan: planContent,
                message: `计划已获得用户审批。已切换到 ${modeName} 模式。请立即开始按照计划执行实施。`
            });
        }
    }
}

import { escapeHtml } from '../../../common/utils/escape.js';
