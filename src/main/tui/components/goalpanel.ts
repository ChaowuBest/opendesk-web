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

import { Component, truncateToWidth } from '@mariozechner/pi-tui';
import type { GoalState, GoalStatus } from '../../aikernel/goal/state.js';
import chalk from 'chalk';
import { Card } from './card.js';
import type { Chalk } from 'chalk';
import { t } from '../../../locale/index.js';

// ── 颜色常量 ──────────────────────────────────────────────────────────────

const GOAL_ACTIVE_COLOR = '#00E676';
const GOAL_PAUSED_COLOR = '#FFA726';
const GOAL_BLOCKED_COLOR = '#EF5350';
const GOAL_BUDGET_LIMITED_COLOR = '#FF7043';
const GOAL_COMPLETE_COLOR = '#66BB6A';
const GOAL_CLEARED_COLOR = '#9E9E9E';
const GOAL_ACCENT_COLOR = '#7C4DFF';

// ── 工具函数 ──────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
    if (ms <= 0) return '00:00';
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    const hours = Math.floor(min / 60);
    if (hours > 0) {
        return `${String(hours).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    }
    return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function formatTokens(n: number): string {
    if (n <= 0) return '0';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + 'K';
    return String(n);
}

function getGoalStatusColor(status: GoalStatus): string {
    switch (status) {
        case 'active':
            return GOAL_ACTIVE_COLOR;
        case 'paused':
            return GOAL_PAUSED_COLOR;
        case 'blocked':
            return GOAL_BLOCKED_COLOR;
        case 'budget_limited':
            return GOAL_BUDGET_LIMITED_COLOR;
        case 'complete':
            return GOAL_COMPLETE_COLOR;
        case 'cleared':
            return GOAL_CLEARED_COLOR;
    }
}

function getGoalStatusIcon(status: GoalStatus): string {
    switch (status) {
        case 'active':
            return '◉';
        case 'paused':
            return '⏸';
        case 'blocked':
            return '⊗';
        case 'budget_limited':
            return '₿';
        case 'complete':
            return '✓';
        case 'cleared':
            return '✕';
    }
}

function getGoalStatusLabel(status: GoalStatus): string {
    const key = `goal.label.status.${status}`;
    const label = t(key);
    return label === key ? status : label;
}

function getEvaluationIcon(status: string): string {
    switch (status) {
        case 'met':
            return '✅';
        case 'not_met':
            return '⏳';
        case 'blocked':
            return '🚫';
        case 'budget_limited':
            return '💰';
        default:
            return '❓';
    }
}

/** 构建进度条字符串，如 "████░░░░" */
function buildProgressBar(fraction: number, width: number): string {
    if (width <= 0) return '';
    const filled = Math.round(fraction * width);
    const empty = width - filled;
    const fillChar = '█';
    const emptyChar = '░';
    return fillChar.repeat(Math.max(0, filled)) + emptyChar.repeat(Math.max(0, empty));
}

// ── GoalPanel 组件 ─────────────────────────────────────────────────────

export interface GoalPanelData {
    /** 当前活跃的 GoalState，null 表示无 goal */
    goalState: GoalState | null;
    /** 累计 token 用量（task 级别，实时） */
    totalTokens: number;
    /** 累计执行时间（ms） */
    elapsedMs: number;
}

/**
 * GoalPanel：常驻的 Goal 信息面板，在 VerticalLayout 中插在 TaskView 与 TodoList 之间。
 *
 * 当前活跃任务有未清除 goal 时即显示。goal 完成后面板继续保留，
 * 清除后默认隐藏，避免已清除 goal 干扰后续普通对话。
 * 展示 goal 的目标、状态、token 用量、执行时间、评估结果等。
 */
export class GoalPanel implements Component {
    private data: GoalPanelData = {
        goalState: null,
        totalTokens: 0,
        elapsedMs: 0
    };
    private _visible = false;
    private invalidated = true;
    private lastWidth?: number;
    private cachedOutput?: string[];
    /** 边框颜色函数 */
    private borderColorFn: Chalk;

    constructor() {
        this.borderColorFn = chalk.hex(GOAL_ACCENT_COLOR);
    }

    /**
     * 更新面板数据。由外部驱动（TaskView 的 token update + 定时器/GoalService 事件）。
     */
    update(data: Partial<GoalPanelData>): void {
        if (data.goalState !== undefined) {
            this.data.goalState = data.goalState;
        }
        if (data.totalTokens !== undefined) {
            this.data.totalTokens = data.totalTokens;
        }
        if (data.elapsedMs !== undefined) {
            this.data.elapsedMs = data.elapsedMs;
        }
        this.updateVisibility();
        this.invalidated = true;
    }

    /**
     * 获取当前 goalState（供外部读取，如 /goal 命令优化显示）
     */
    getGoalState(): GoalState | null {
        return this.data.goalState;
    }

    /**
     * 面板是否可见
     */
    isVisible(): boolean {
        return this._visible;
    }

    /** 强制重绘 */
    invalidate(): void {
        this.invalidated = true;
    }

    // ── 可见性判断 ────────────────────────────────────────────────

    /**
     * 根据当前 goalState 更新可见性：
     * - goal 为 null → 隐藏
     * - cleared → 隐藏
     * - 其他状态（含 complete）→ 显示，便于查看最终评估结果
     */
    private updateVisibility(): void {
        this._visible = this.data.goalState !== null && this.data.goalState.status !== 'cleared';
    }

    // ── 渲染 ─────────────────────────────────────────────────────

    render(width: number): string[] {
        if (!this._visible || !this.data.goalState) {
            return [];
        }

        if (!this.invalidated && this.lastWidth === width && this.cachedOutput) {
            return this.cachedOutput;
        }

        this.lastWidth = width;
        const goal = this.data.goalState;

        // 构建卡片 body 行
        const bodyLines = this.buildBodyLines(goal, width);

        // 使用 Card 组件渲染
        const statusIndicator = {
            icon: getGoalStatusIcon(goal.status),
            text: chalk.hex(getGoalStatusColor(goal.status))(getGoalStatusLabel(goal.status))
        };

        const card = new Card({
            icon: chalk.hex(GOAL_ACCENT_COLOR)('🎯'),
            title: chalk.bold('Goal'),
            status: statusIndicator,
            body: bodyLines,
            border: {
                style: 'rounded',
                colorFn: this.borderColorFn
            }
        });

        this.cachedOutput = card.render(width);
        this.invalidated = false;
        return this.cachedOutput;
    }

    // ── Body 行构建 ──────────────────────────────────────────────

    private buildBodyLines(goal: GoalState, width: number): string[] {
        const contentWidth = Math.max(1, width - 4);
        const lines: string[] = [];

        // 行 1: Goal 目标（截断）
        const objective = truncateToWidth(goal.objective, contentWidth, '…', true);
        lines.push(`${chalk.dim(`${t('goal.panel.objective')}:`)} ${objective}`);

        // 行 2: 状态行（包含 status + 尝试次数 + 异常原因）
        const statusIcon = getGoalStatusIcon(goal.status);
        const statusLabel = getGoalStatusLabel(goal.status);
        const statusColor = getGoalStatusColor(goal.status);
        const attrs =
            goal.maxAttempts !== undefined
                ? `${t('goal.renderer.attempts')} ${goal.attempts}/${goal.maxAttempts}`
                : `${t('goal.renderer.attempts')} ${goal.attempts}${chalk.dim(` (${t('goal.renderer.unlimited')})`)}`;
        const statusText = `${statusIcon} ${statusLabel}`;
        lines.push(
            `${chalk.dim(`${t('goal.panel.status')}:`)} ${chalk.hex(statusColor)(statusText)}  ${chalk.dim(attrs)}`
        );

        // 异常原因（blocked / paused / budget_limited）
        const reasonLine = this.buildReasonLines(goal, contentWidth);
        if (reasonLine) {
            lines.push(reasonLine);
        }

        // 行 3: 评估状态
        if (goal.lastEvaluation) {
            const evalIcon = getEvaluationIcon(goal.lastEvaluation.status);
            const evalText = truncateToWidth(goal.lastEvaluation.reason, contentWidth - 12, '…', true);
            lines.push(`${chalk.dim(`${t('goal.panel.evaluation')}:`)} ${evalIcon} ${chalk.italic(evalText)}`);
        } else {
            lines.push(
                `${chalk.dim(`${t('goal.panel.evaluation')}:`)} ${chalk.dim.italic(t('goal.panel.evaluation.pending'))}`
            );
        }

        // 行 4: Token 用量 + 预算信息
        const usedTokens = this.data.totalTokens;
        const maxTokens = goal.tokenBudget?.maxTotalTokens;
        const usedStr = formatTokens(usedTokens);
        if (maxTokens && maxTokens > 0) {
            const maxStr = formatTokens(maxTokens);
            const pct = Math.min(1, usedTokens / maxTokens);
            const barWidth = Math.min(20, Math.max(5, contentWidth - 30));
            const bar = buildProgressBar(pct, barWidth);
            const pctLabel = (pct * 100).toFixed(0);
            lines.push(
                `${chalk.dim(`${t('goal.renderer.tokens')}:`)} ${usedStr} / ${maxStr}  ${chalk.hex(this.getTokenColor(pct))(bar)}  ${chalk.dim(`${pctLabel}%`)}`
            );
        } else {
            lines.push(
                `${chalk.dim(`${t('goal.renderer.tokens')}:`)} ${usedStr}${chalk.dim(` (${t('goal.renderer.unlimited')})`)}`
            );
        }

        // 行 5: 执行时间 + 预算信息
        const elapsed = formatDuration(this.data.elapsedMs);
        if (goal.timeBudgetMs && goal.timeBudgetMs > 0) {
            const budget = formatDuration(goal.timeBudgetMs);
            const pct = Math.min(1, this.data.elapsedMs / goal.timeBudgetMs);
            const barWidth = Math.min(20, Math.max(5, contentWidth - 30));
            const bar = buildProgressBar(pct, barWidth);
            const pctLabel = (pct * 100).toFixed(0);
            lines.push(
                `${chalk.dim(`${t('goal.panel.elapsed')}:`)} ${elapsed} / ${budget}  ${chalk.hex(this.getTimeColor(pct))(bar)}  ${chalk.dim(`${pctLabel}%`)}`
            );
        } else {
            lines.push(`${chalk.dim(`${t('goal.panel.elapsed')}:`)} ${elapsed}`);
        }

        return lines;
    }

    /**
     * 构建异常原因行（当 goal 处于 blocked / paused / budget_limited 时）。
     * 返回 null 表示无异常原因。
     */
    private buildReasonLines(goal: GoalState, contentWidth: number): string | null {
        const status = goal.status;
        if (status === 'blocked' && goal.blockedReason) {
            const truncated = truncateToWidth(goal.blockedReason, contentWidth - 10, '…', true);
            return `${chalk.dim(`${t('goal.panel.blocked_reason')}:`)} ${chalk.hex(GOAL_BLOCKED_COLOR)(truncated)}`;
        }
        if (status === 'paused' && goal.pauseReason) {
            const truncated = truncateToWidth(goal.pauseReason, contentWidth - 10, '…', true);
            return `${chalk.dim(`${t('goal.panel.paused_reason')}:`)} ${chalk.hex(GOAL_PAUSED_COLOR)(truncated)}`;
        }
        if (status === 'budget_limited' && goal.budgetLimitedReason) {
            const truncated = truncateToWidth(goal.budgetLimitedReason, contentWidth - 10, '…', true);
            return `${chalk.dim(`${t('goal.panel.budget_limited_reason')}:`)} ${chalk.hex(GOAL_BUDGET_LIMITED_COLOR)(truncated)}`;
        }
        return null;
    }

    /** Token 进度条颜色：绿 → 黄 → 红 */
    private getTokenColor(pct: number): string {
        if (pct < 0.5) return '#66BB6A';
        if (pct < 0.8) return '#FFA726';
        return '#EF5350';
    }

    /** 时间进度条颜色：绿 → 黄 → 红 */
    private getTimeColor(pct: number): string {
        if (pct < 0.6) return '#66BB6A';
        if (pct < 0.85) return '#FFA726';
        return '#EF5350';
    }
}
