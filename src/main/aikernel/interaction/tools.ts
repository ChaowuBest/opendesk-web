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
import { t } from '../../../locale/index.js';
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
    workspace?: string;
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * LLMs sometimes pass `questions` as a single object instead of an array,
 * as a JSON string instead of parsed objects, or omit required string fields.
 * Normalize defensively so downstream code always sees well-formed data.
 */
function normalizeQuestions(args: any): any {
    if (args == null) return args;

    // args itself might be a JSON string
    if (typeof args === 'string') {
        try {
            args = JSON.parse(args);
        } catch {
            return { questions: [] };
        }
    }
    if (!args?.questions) return args;

    // questions field might be a JSON string
    if (typeof args.questions === 'string') {
        try {
            args.questions = JSON.parse(args.questions);
        } catch {
            args.questions = [];
        }
    }

    if (!Array.isArray(args.questions)) {
        args.questions = [args.questions];
    }
    args.questions = args.questions.map((q: any) => {
        if (!q || typeof q === 'string') {
            try {
                q = typeof q === 'string' ? JSON.parse(q) : q;
            } catch {
                return { question: '', header: '', options: [], multiple: false };
            }
        }
        if (!q || typeof q !== 'object') return { question: '', header: '', options: [], multiple: false };
        return {
            question: typeof q.question === 'string' ? q.question : String(q.question ?? ''),
            header: typeof q.header === 'string' ? q.header : String(q.header ?? q.question ?? '').slice(0, 30),
            options: (Array.isArray(q.options) ? q.options : []).map((opt: any) => {
                if (!opt || typeof opt !== 'object') return { label: '', description: '' };
                return {
                    label: typeof opt.label === 'string' ? opt.label : String(opt.label ?? ''),
                    description: typeof opt.description === 'string' ? opt.description : String(opt.description ?? '')
                };
            }),
            multiple: !!q.multiple
        };
    });
    return args;
}

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

    /**
     * 消息渠道（飞书/微信等）和自动触发任务（定时任务等）没有交互 UI，禁用 askUser。
     */
    isAvailable(taskState?: TaskState): boolean {
        const originType = taskState?.origin?.type;
        if (originType === 'channel' || originType === 'automation') {
            return false;
        }
        return true;
    }

    setProvider(provider: AskUserProvider) {
        this.provider = provider;
    }

    private isProviderPrompting(): boolean {
        return this.provider?.isPrompting?.() ?? false;
    }

    // ── CLI 渲染 ──────────────────────────────────────────────────────────────

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = normalizeQuestions(toolcall.args_object as any) as z.output<typeof AskUserArgsSchema> | undefined;

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
        const args = normalizeQuestions(toolcall.args_object as any) as z.output<typeof AskUserArgsSchema> | undefined;
        const isRunning = toolcall.status === 'running';
        const isError = toolcall.status === 'error';

        const toolName = t('tools.askUser.name');
        const borderColor = isError ? 'border-red-200' : 'border-gray-200';
        const iconBg = isError
            ? 'bg-red-50 text-red-400'
            : isRunning
              ? 'bg-amber-50 text-amber-500'
              : 'bg-emerald-50 text-emerald-500';

        const firstQuestion = args?.questions?.[0]?.question ?? '';
        const headerQuestion = escapeHtml(firstQuestion.length > 60 ? firstQuestion.slice(0, 57) + '…' : firstQuestion);

        let statusBadge = '';
        if (isRunning) {
            statusBadge = `<span class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-50 text-amber-600"><i class="fa-solid fa-circle-notch fa-spin text-[8px]"></i>等待回答</span>`;
        } else if (isError) {
            statusBadge = `<span class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-50 text-red-500"><i class="fa-solid fa-circle-xmark text-[8px]"></i>失败</span>`;
        } else if (toolcall.status === 'success') {
            statusBadge = `<span class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-50 text-emerald-600"><i class="fa-solid fa-circle-check text-[8px]"></i>已回答</span>`;
        }

        let bodyContent = '';
        if (isRunning && args?.questions) {
            const questionsHtml = args.questions
                .map(
                    (q) => `
                <div class="mb-2.5 last:mb-0">
                    <div class="text-gray-600 font-medium text-[12px] mb-1.5">${escapeHtml(q.question)}</div>
                    <div class="flex flex-wrap gap-1.5">
                        ${q.options.map((o) => `<span class="px-2 py-0.5 rounded bg-gray-100 text-gray-500 text-[11px]" title="${escapeHtml(o.description)}">${escapeHtml(o.label)}</span>`).join('')}
                    </div>
                </div>`
                )
                .join('');
            bodyContent = `<div class="px-3.5 py-2.5">${questionsHtml}</div>`;
        } else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const parsed = JSON.parse(toolcall.result) as {
                    answers: Record<string, string[]>;
                    cancelled?: boolean;
                };
                if (parsed.cancelled) {
                    bodyContent = `<div class="px-3.5 py-2.5 text-[12px] text-gray-400">用户取消了本次询问</div>`;
                } else if (parsed.answers && args?.questions) {
                    const answersHtml = Object.entries(parsed.answers)
                        .map(([idx, selected]) => {
                            const q = args.questions[Number(idx)];
                            if (!q) return '';
                            const selectedBadges = selected
                                .map(
                                    (s) =>
                                        `<span class="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 text-[11px] font-medium">${escapeHtml(s)}</span>`
                                )
                                .join('');
                            return `<div class="mb-2 last:mb-0">
                                <div class="text-gray-500 text-[11px] mb-1">${escapeHtml(q.header || q.question)}</div>
                                <div class="flex flex-wrap gap-1.5">${selectedBadges}</div>
                            </div>`;
                        })
                        .filter(Boolean)
                        .join('');
                    bodyContent = `<div class="px-3.5 py-2.5">${answersHtml}</div>`;
                }
            } catch {
                /* ignore parse errors in render */
            }
        } else if (isError && toolcall.result) {
            bodyContent = `<div class="px-3.5 py-2.5 text-[12px] text-red-600">${escapeHtml(String(toolcall.result).slice(0, 200))}</div>`;
        }

        return `
        <details class="od-card-shadow my-2 rounded-[14px] border ${borderColor} bg-white overflow-hidden w-full" open>
            <summary class="flex items-center gap-2 px-3.5 py-2.5 cursor-pointer select-none hover:bg-gray-50/60 transition-colors duration-150 font-medium">
                <span class="inline-flex items-center justify-center w-5 h-5 rounded ${iconBg}">
                    <i class="fa-solid fa-circle-question text-[10px]"></i>
                </span>
                <span class="text-[12px] text-gray-500 shrink-0">${escapeHtml(toolName)}</span>
                <span class="text-[12px] text-gray-600 truncate flex-1">${headerQuestion}</span>
                ${statusBadge}
                <svg class="w-3 h-3 text-gray-400 shrink-0 transition-transform duration-200" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path d="M6 9l6 6 6-6"/>
                </svg>
            </summary>
            ${bodyContent ? `<div class="border-t border-gray-200 bg-gray-50/40">${bodyContent}</div>` : ''}
        </details>`;
    }

    // ── 执行 ──────────────────────────────────────────────────────────────────

    private async handleExecute(
        rawArgs: z.output<typeof AskUserArgsSchema>,
        toolResult: ToolResult,
        taskState?: TaskState
    ): Promise<void> {
        const args = normalizeQuestions(rawArgs) as z.output<typeof AskUserArgsSchema>;

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
            taskName: taskState?.task_name ?? null,
            workspace: taskState?.getWorkspace()
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

import { ExitPlanModeTool, type ExitPlanModeProvider } from './exitPlanMode.js';

/**
 * 创建 interaction 工具集（仅主任务使用）。
 * provider 由调用方注入（TUI 或 Electron）。
 *
 * @param askUserProvider askUser 交互提供者
 * @param exitPlanModeProvider exitPlanMode 交互提供者（可选）
 */
export function createInteractionToolset(
    askUserProvider: AskUserProvider,
    exitPlanModeProvider?: ExitPlanModeProvider
): BaseToolset {
    const toolset = new BaseToolset('interaction');

    const askUserTool = new AskUserTool();
    askUserTool.setProvider(askUserProvider);
    toolset.addTool(askUserTool);

    const exitPlanModeTool = new ExitPlanModeTool();
    if (exitPlanModeProvider) {
        exitPlanModeTool.setProvider(exitPlanModeProvider);
    }
    toolset.addTool(exitPlanModeTool);

    return toolset;
}

export function createAskUserToolset(askUserProvider: AskUserProvider): BaseToolset {
    const toolset = new BaseToolset('interaction');
    const askUserTool = new AskUserTool();
    askUserTool.setProvider(askUserProvider);
    toolset.addTool(askUserTool);
    return toolset;
}

import { escapeHtml } from '../../../common/utils/escape.js';
