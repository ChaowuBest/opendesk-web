/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { BaseTool, ToolResult } from '../../../aikernel/tool.js';
import { ToolCall } from '../../../aikernel/messages.js';
import { escapeHtml } from '../../../../common/utils/escape.js';
import stripAnsi from 'strip-ansi';
import chalk from 'chalk';
import { Card } from '../../../tui/components/card.js';
import { statusDisplay } from '../../../tui/components/toolcall.js';
import { z } from 'zod';
import {
    BackgroundProcessManager,
    SILENT_OUTPUT_HINT_ELAPSED_MS,
    silentBackgroundHint,
    type BackgroundProcessStatus
} from '../background.js';
import { t as terminalT } from '../locale/index.js';
import type { TaskState } from '../../../aikernel/states/tasks.js';
import type { SupportedShellKind } from '../../../../common/shells.js';
import { appendSandboxPathDiagnostic } from '../sandboxes/path-diagnostic.js';

/** checkShellStatus 允许请求的最大等待时间（毫秒）。参数 schema 与工具描述都引用此常量。 */
export const MAX_STATUS_WAIT_MS = 30 * 1000;

const createCheckShellStatusArgsSchema = () =>
    z.object({
        pid: z.number().describe('要检查的后台 shell 进程的 PID'),
        waitMs: z
            .number()
            .int()
            .min(0)
            .max(MAX_STATUS_WAIT_MS)
            .optional()
            .describe(terminalT('status.waitMs', { max: String(MAX_STATUS_WAIT_MS) })),
        kill: z.boolean().optional().describe('如果设为 true，则强制终止该后台进程').default(false)
    });
type CheckShellStatusArgsSchema = ReturnType<typeof createCheckShellStatusArgsSchema>;

export class CheckShellStatusTool extends BaseTool<CheckShellStatusArgsSchema> {
    constructor(
        private readonly shellKind: SupportedShellKind = 'powershell',
        private readonly sandboxed = false
    ) {
        super(
            'checkShellStatus',
            terminalT('status.description', { max: String(MAX_STATUS_WAIT_MS) }),
            createCheckShellStatusArgsSchema(),
            undefined,
            { 'zh-CN': '检查命令执行状态', 'en-US': 'Check Shell Status' }
        );
        this.serialExecution = sandboxed;

        this.setUniversalExecutor(this.executeCheck.bind(this));
    }

    async executeCheck(
        args: z.output<CheckShellStatusArgsSchema>,
        result: ToolResult,
        taskState?: TaskState
    ): Promise<void> {
        const { pid, kill, waitMs = 0 } = args;
        const mgr = BackgroundProcessManager.getInstance();
        const abortSignal = taskState?.getAbortSignal?.();

        if (kill) {
            const killed = mgr.killProcess(pid);
            if (!killed) {
                result.updateResult(`PID ${pid} 对应的进程未找到或已经结束，无法终止。`);
                return;
            }
            await mgr.waitForFinish(pid, 3000, abortSignal);
            if (abortSignal?.aborted) throw new Error('任务已停止');
        }

        let status: BackgroundProcessStatus = mgr.getStatus(pid);

        if (!kill && status.found && !status.finished && waitMs > 0) {
            await mgr.waitForFinish(pid, waitMs, abortSignal);
            if (abortSignal?.aborted) throw new Error('任务已停止');
            status = mgr.getStatus(pid);
        }

        if (!status.found) {
            result.updateResult(
                `未找到 PID ${pid} 对应的后台进程。可能该进程不是因超时被放到后台的，或者 PID 输入有误。`
            );
            return;
        }

        const elapsedSec = (status.elapsedMs / 1000).toFixed(1);
        const output = appendSandboxPathDiagnostic(status.output.trim(), this.sandboxed);

        if (status.finished) {
            const lines = [
                `进程状态: 已完成`,
                `PID: ${pid}`,
                `命令: ${status.command}`,
                `返回码: ${status.exitCode ?? 'unknown'}`,
                `总耗时: ${elapsedSec}s`,
                '---',
                output || '(无输出)'
            ];
            result.updateResult(lines.join('\n'));
        } else {
            const lines = [
                `进程状态: 仍在执行中`,
                `PID: ${pid}`,
                `命令: ${status.command}`,
                `已运行: ${elapsedSec}s`,
                '提示: waitMs 的单位是毫秒。仅在确实需要即时状态、且查询后可继续其他独立工作时使用 waitMs=0；确实需要很快再次观察进度时可用 waitMs=1000-5000；若下一步依赖完成结果，优先使用 waitMs=10000-30000。进程完成时会提前返回，无需等满 waitMs。避免对同一运行中 PID 连续零等待查询；只有判断进程卡住时才使用 kill=true。',
                // 长时间运行且零输出：区分缓冲管道的正常静默与真实卡死，给出决策指引
                ...(!output && status.elapsedMs >= SILENT_OUTPUT_HINT_ELAPSED_MS
                    ? [silentBackgroundHint(status.command)]
                    : []),
                '---',
                output || '(暂无输出)'
            ];
            result.updateResult(lines.join('\n'));
        }
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const pid = toolcall.args_object?.['pid'];
        const kill = toolcall.args_object?.['kill'];
        const isRunning = toolcall.result === undefined && toolcall.status !== 'error';
        const isError = toolcall.status === 'error';

        const statusIcon = isRunning
            ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>'
            : isError
              ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-red-500"></span>'
              : '';

        let detail = '';
        if (pid !== undefined) {
            const pidStr = `PID ${escapeHtml(String(pid))}`;
            if (kill) {
                detail = `终止 ${pidStr}`;
            } else {
                detail = pidStr;
            }
        }

        // 如果是已完成状态，从 result 中提取进程状态摘要
        if (!isRunning && !isError && toolcall.result) {
            const firstLine = toolcall.result.split('\n')[0] || '';
            if (firstLine.includes('进程状态:')) {
                detail += ` · ${escapeHtml(firstLine.replace('进程状态:', '').trim())}`;
            } else if (firstLine.includes('未找到')) {
                detail += ` · 未找到`;
            }
        } else if (isRunning) {
            detail += ' · 查询中…';
        }

        const shellTag = `<span class="terminal-shell-tag terminal-shell-tag-${this.shellKind}">${this.shellKind}</span>${this.sandboxed ? `<span class="terminal-shell-tag terminal-shell-tag-sandbox">${escapeHtml(terminalT('shell.sandboxTag'))}</span>` : ''}`;
        return `<div class="od-inline-toolcall-container">
            <div class="flex items-center gap-1.5 min-w-0">
                <i class="fas fa-circle-check shrink-0 text-slate-400 text-xs"></i>
                <span class="shrink-0 text-slate-500 text-xs">${escapeHtml(terminalT('checkShellStatus.name'))}</span>
                ${shellTag}
                ${statusIcon}
                <span class="truncate text-xs text-slate-600">${detail}</span>
            </div>
        </div>`;
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const pid = toolcall.args_object?.['pid'];
        const body: string[] = [];

        if (pid) {
            body.push(chalk.blueBright('PID: ') + chalk.white(String(pid)));
        }

        if (toolcall.result) {
            body.push(chalk.dim('─'.repeat(Math.min(40, Math.max(4, width - 8)))));
            const rawLines = toolcall.result.replace(/\r/g, '').split('\n');
            if (rawLines.length > MAX_CLI_OUTPUT_LINES) {
                body.push(chalk.dim.italic(`  … 共 ${rawLines.length} 行，显示最后 ${MAX_CLI_OUTPUT_LINES} 行`));
            }
            const displayLines = rawLines.slice(-MAX_CLI_OUTPUT_LINES);
            for (const line of displayLines) {
                const visibleLen = stripAnsi(line).length;
                if (visibleLen > width - 10) {
                    body.push('  ' + chalk.dim(stripAnsi(line).slice(0, width - 10)));
                } else {
                    body.push('  ' + line);
                }
            }
        } else if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 正在查询…'));
        }

        return new Card({
            icon: '🔍',
            title: `Shell 状态检查 · ${this.shellKind}${this.sandboxed ? ' [沙箱]' : ''}`,
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }
}
