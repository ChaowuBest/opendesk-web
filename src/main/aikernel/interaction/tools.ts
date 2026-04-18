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
 * Interaction toolset — 仅挂载到主任务，子任务不可用。
 *
 * 目前包含：
 *   - AskUserTool: 向用户提出多选问题，阻塞直到用户回答。
 */

import { z } from 'zod';
import { BaseTool, BaseToolset, ToolResult } from '../tool.js';
import { Card } from '../../tui/components/card.js';
import { statusDisplay, truncText } from '../../tui/components/toolcall.js';
import type { ToolCall } from '../messages.js';
import type { TaskState } from '../states/tasks.js';
import chalk from 'chalk';

// ─── Provider 接口 ────────────────────────────────────────────────────────────

export interface AskUserOption {
    label: string;
    description: string;
}

export interface AskUserQuestion {
    question: string;
    /** 简短标签，最多 30 字符，显示为 chip */
    header: string;
    options: AskUserOption[];
    /** 是否允许多选，默认 false */
    multiple?: boolean;
}

export interface AskUserRequest {
    requestId: string;
    questions: AskUserQuestion[];
    taskId: string;
    taskName: string | null;
}

export interface AskUserResponse {
    /** question index → 选中的 label 数组（单选时长度为 1） */
    answers: Record<number, string[]>;
    /** 用户是否取消（Escape） */
    cancelled?: boolean;
}

/**
 * AskUser 交互提供者接口。
 * TUI 和 Electron 各自实现此接口。
 */
export interface AskUserProvider {
    prompt(request: AskUserRequest): Promise<AskUserResponse>;
    /** 当前是否正在显示用户交互界面（TUI 专用，避免 taskview 重复渲染） */
    isPrompting?(): boolean;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const OptionSchema = z.object({
    label: z.string().describe('选项显示文本（1-5个词），清晰描述选择'),
    description: z.string().describe('选项说明，解释选择的意义或后果')
});

const QuestionSchema = z.object({
    question: z.string().describe('问题文本，应清晰、具体，以问号结尾'),
    header: z.string().max(30).describe('简短标签（最多30字符），显示为 chip/tag'),
    options: z.array(OptionSchema).min(2).max(8).describe('2-8个选项'),
    multiple: z.boolean().default(false).describe('是否允许多选，默认 false')
});

const AskUserArgsSchema = z.object({
    questions: z.array(QuestionSchema).min(1).max(4).describe('1-4个问题')
});

// ─── Tool ─────────────────────────────────────────────────────────────────────

export class AskUserTool extends BaseTool<typeof AskUserArgsSchema> {
    private provider: AskUserProvider | null = null;

    constructor() {
        super(
            'askUser',
            '向用户提出多选问题以收集信息、澄清需求或让用户在多个方案中做出选择。' +
                '工具会阻塞直到用户回答。仅在主任务中可用，子任务不可调用此工具。',
            AskUserArgsSchema
        );
        this.setUniversalExecutor(this.handleExecute.bind(this));
    }

    setProvider(provider: AskUserProvider) {
        this.provider = provider;
    }

    private isProviderPrompting(): boolean {
        return this.provider?.isPrompting?.() ?? false;
    }

    // ── CLI 渲染 ──────────────────────────────────────────────────────────────

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof AskUserArgsSchema> | undefined;

        // TUI 正在显示选择面板时，不在 taskview 重复渲染问题卡片
        if (this.isProviderPrompting()) {
            return [];
        }

        const body: string[] = [];

        if (args?.questions) {
            for (const q of args.questions) {
                body.push(chalk.dim('问题: ') + truncText(q.question, width - 12));
                for (const opt of q.options) {
                    body.push(
                        chalk.dim('  • ') +
                            chalk.cyan(opt.label) +
                            chalk.dim(' — ' + truncText(opt.description, width - 20))
                    );
                }
            }
        }

        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const parsed = JSON.parse(toolcall.result) as { answers: Record<string, string[]> };
                if (parsed.answers) {
                    body.push(chalk.dim('─'.repeat(Math.min(width - 8, 30))));
                    for (const [idx, selected] of Object.entries(parsed.answers)) {
                        const q = args?.questions[Number(idx)];
                        if (q) {
                            body.push(chalk.dim(`Q${Number(idx) + 1}: `) + chalk.greenBright(selected.join(', ')));
                        }
                    }
                }
            } catch {
                // ignore
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright(truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '❓',
            title: '询问用户',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    // ── GUI 渲染 ──────────────────────────────────────────────────────────────

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as z.output<typeof AskUserArgsSchema> | undefined;

        if (toolcall.status === 'running') {
            const questionsHtml =
                args?.questions
                    .map(
                        (q) => `
                <div class="mb-2">
                    <div class="text-slate-600 font-medium text-[12px] mb-1">${escapeHtml(q.question)}</div>
                    <div class="flex flex-wrap gap-1">
                        ${q.options.map((o) => `<span class="px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[11px]">${escapeHtml(o.label)}</span>`).join('')}
                    </div>
                </div>`
                    )
                    .join('') ?? '';

            return `
            <div class="flex flex-col mt-3 mb-3 text-sm bg-white/80 backdrop-blur-md border border-slate-200 py-3 px-4 rounded-2xl shadow-sm w-fit min-w-[280px] max-w-md">
                <div class="flex items-center space-x-3 mb-2">
                    <span class="text-base">❓</span>
                    <span class="font-semibold text-slate-600">询问用户</span>
                    <div class="h-2 w-2 rounded-full bg-amber-400 animate-pulse ring-4 ring-amber-100/50"></div>
                </div>
                ${questionsHtml}
            </div>`;
        }

        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const parsed = JSON.parse(toolcall.result) as {
                    answers: Record<string, string[]>;
                    cancelled?: boolean;
                };
                if (parsed.cancelled) {
                    return `
                    <div class="flex items-center space-x-3 mt-3 mb-3 text-sm bg-slate-50/80 backdrop-blur-md border border-slate-200 py-2 px-4 rounded-full shadow-sm w-fit">
                        <span class="text-base">❓</span>
                        <span class="font-semibold text-slate-500">询问用户</span>
                        <span class="text-slate-400 text-xs">已取消</span>
                    </div>`;
                }
                const answersHtml = Object.entries(parsed.answers)
                    .map(([idx, selected]) => {
                        const q = args?.questions[Number(idx)];
                        return q
                            ? `<span class="text-slate-500 text-xs">${escapeHtml(q.header || q.question.slice(0, 20))}: </span><span class="font-medium text-slate-700 text-xs">${escapeHtml(selected.join(', '))}</span>`
                            : '';
                    })
                    .filter(Boolean)
                    .join('<span class="text-slate-300 mx-1">·</span>');

                return `
                <div class="flex items-center space-x-3 mt-3 mb-3 text-sm bg-white/80 backdrop-blur-md border border-slate-200 py-2 px-4 rounded-full shadow-sm w-fit max-w-md">
                    <span class="text-base">❓</span>
                    <span class="font-semibold text-slate-600">询问用户</span>
                    <span class="text-emerald-500">✓</span>
                    <span class="truncate">${answersHtml}</span>
                </div>`;
            } catch {
                return `
                <div class="flex items-center space-x-3 mt-3 mb-3 text-sm bg-white/80 backdrop-blur-md border border-slate-200 py-2 px-4 rounded-full shadow-sm w-fit">
                    <span class="text-base">❓</span>
                    <span class="font-semibold text-slate-600">询问用户</span>
                    <span class="text-emerald-500">✓</span>
                </div>`;
            }
        }

        if (toolcall.status === 'error') {
            return `
            <div class="flex items-center space-x-3 mt-3 mb-3 text-sm bg-rose-50/80 backdrop-blur-md border border-rose-200 py-2 px-4 rounded-full shadow-sm w-fit">
                <span class="text-base">❓</span>
                <span class="font-semibold text-rose-600">询问用户</span>
                <span class="text-rose-500 text-xs">失败</span>
            </div>`;
        }

        return undefined;
    }

    // ── 执行 ──────────────────────────────────────────────────────────────────

    private async handleExecute(
        args: z.output<typeof AskUserArgsSchema>,
        toolResult: ToolResult,
        taskState?: TaskState
    ): Promise<void> {
        if (!this.provider) {
            toolResult.result = JSON.stringify({
                error: 'no_provider',
                message: '没有可用的用户交互界面，无法提问'
            });
            throw new Error('AskUserTool: no provider configured');
        }

        const request: AskUserRequest = {
            requestId: `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            questions: args.questions.map((q) => ({
                question: q.question,
                header: q.header,
                options: q.options,
                multiple: q.multiple
            })),
            taskId: taskState?.task_id ?? 'unknown',
            taskName: taskState?.task_name ?? null
        };

        const response = await this.provider.prompt(request);

        if (response.cancelled) {
            toolResult.result = JSON.stringify({ cancelled: true, answers: {} });
            return;
        }

        // 将答案格式化为可读文本，方便 LLM 理解
        const answerLines: string[] = [];
        for (const [idxStr, selected] of Object.entries(response.answers)) {
            const idx = Number(idxStr);
            const q = args.questions[idx];
            if (q) {
                answerLines.push(`问题: ${q.question}`);
                answerLines.push(`回答: ${selected.join(', ')}`);
            }
        }

        toolResult.result = JSON.stringify({
            answers: response.answers,
            summary: answerLines.join('\n')
        });
    }
}

// ─── Toolset Factory ──────────────────────────────────────────────────────────

/**
 * 创建 interaction 工具集（仅主任务使用）。
 * provider 由调用方注入（TUI 或 Electron）。
 */
export function createInteractionToolset(provider: AskUserProvider): BaseToolset {
    const toolset = new BaseToolset('interaction');
    const tool = new AskUserTool();
    tool.setProvider(provider);
    toolset.addTool(tool);
    return toolset;
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
