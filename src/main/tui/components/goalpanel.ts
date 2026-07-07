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

import { Component, truncateToWidth } from '@earendil-works/pi-tui';
import type { GoalEvaluation, GoalState, GoalStatus } from '../../aikernel/goal/state.js';
import chalk from 'chalk';
import { Card } from './card.js';
import { t } from '../../../locale/index.js';

// ── 颜色常量 ──────────────────────────────────────────────────────────────

const GOAL_ACTIVE_COLOR = '#00E676';
const GOAL_PAUSED_COLOR = '#FFA726';
const GOAL_BLOCKED_COLOR = '#EF5350';
const GOAL_COMPLETE_COLOR = '#66BB6A';
const GOAL_CLEARED_COLOR = '#9E9E9E';

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
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
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
        case 'complete':
            return GOAL_COMPLETE_COLOR;
        case 'cleared':
            return GOAL_CLEARED_COLOR;
    }
}

function getGoalStatusLabel(status: GoalStatus): string {
    const key = `goal.label.status.${status}`;
    const label = t(key);
    return label === key ? status : label;
}

function getGoalStatusIcon(status: GoalStatus): string {
    switch (status) {
        case 'active':
            return '◉';
        case 'paused':
            return '⏸';
        case 'blocked':
            return '⊗';
        case 'complete':
            return '✓';
        case 'cleared':
            return '✕';
    }
}

// ── GoalPanel 组件 ─────────────────────────────────────────────────────

export interface GoalPanelData {
    /** 当前活跃的 GoalState，null 表示无 goal */
    goalState: GoalState | null;
    /** 累计 token 用量（task 级别，实时） */
    totalTokens: number;
    /** 累计执行时间（ms） */
    elapsedMs: number;
    /** 目标评估进行中（true 表示 LLM 正在评估） */
    evaluating?: boolean;
}

export interface GoalPanelOptions {
    /** 历史快照需要继续展示 cleared 状态；实时底部面板默认隐藏 cleared。 */
    showCleared?: boolean;
    /** 历史快照需要继续展示 complete/cleared；实时底部面板默认只展示未终结 goal。 */
    showTerminal?: boolean;
}

/**
 * GoalPanel：常驻的 Goal 信息面板，在 VerticalLayout 中插在 TaskView 与 TodoList 之间。
 *
 * 当前活跃任务有未终结 goal 时即显示。终态 goal 默认只作为历史快照展示，
 * 避免已结束 goal 干扰后续普通对话。
 * 展示 goal 的目标、状态、token 用量、执行时间、评估结果等。
 */
export class GoalPanel implements Component {
    private readonly showCleared: boolean;
    private readonly showTerminal: boolean;
    private data: GoalPanelData = {
        goalState: null,
        totalTokens: 0,
        elapsedMs: 0
    };
    private _visible = false;
    private invalidated = true;
    private lastWidth?: number;
    private cachedOutput?: string[];

    constructor(options: GoalPanelOptions = {}) {
        this.showCleared = options.showCleared === true;
        this.showTerminal = options.showTerminal === true || this.showCleared;
    }

    /**
     * 更新面板数据。由外部驱动（TaskView 的 token update + 定时器/GoalService 事件）。
     */
    update(data: Partial<GoalPanelData>): void {
        const previousGoalId = this.data.goalState?.id;
        if (data.goalState !== undefined) {
            this.data.goalState = data.goalState;
            if (!data.goalState || data.goalState.id !== previousGoalId) {
                this.data.evaluating = false;
            }
        }
        if (data.totalTokens !== undefined) {
            this.data.totalTokens = data.totalTokens;
        }
        if (data.elapsedMs !== undefined) {
            this.data.elapsedMs = data.elapsedMs;
        }
        if (data.evaluating !== undefined) {
            this.data.evaluating = data.evaluating;
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
     * - complete/cleared → 默认隐藏，历史快照可通过 showTerminal/showCleared 展示
     * - 其他状态 → 显示
     */
    private updateVisibility(): void {
        const goal = this.data.goalState;
        if (!goal) {
            this._visible = false;
            return;
        }
        if (goal.status === 'complete' || goal.status === 'cleared') {
            this._visible = this.showTerminal && (goal.status !== 'cleared' || this.showCleared);
            return;
        }
        this._visible = true;
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
        const statusColor = getGoalStatusColor(goal.status);

        // 使用 Card 组件渲染
        const statusIndicator = this.buildStatusIndicator(goal);

        const card = new Card({
            icon: chalk.hex(statusColor)('🎯'),
            title: t('goal.panel.title'),
            status: statusIndicator,
            body: bodyLines,
            border: {
                style: 'rounded',
                colorFn: chalk.hex(statusColor)
            }
        });

        this.cachedOutput = card.render(width);
        this.invalidated = false;
        return this.cachedOutput;
    }

    private buildStatusIndicator(goal: GoalState): { icon: string; text: string } {
        const statusColor = getGoalStatusColor(goal.status);
        const statusIcon = chalk.hex(statusColor)(getGoalStatusIcon(goal.status));
        const statusLabel = chalk.hex(statusColor)(getGoalStatusLabel(goal.status));
        const elapsed = formatDuration(this.data.elapsedMs);

        return {
            icon: '',
            text: `${statusIcon} ${statusLabel}(${elapsed})`
        };
    }

    // ── Body 行构建 ──────────────────────────────────────────────

    private buildBodyLines(goal: GoalState, width: number): string[] {
        const contentWidth = Math.max(1, width - 4);
        const lines: string[] = [];

        // 行 1: Goal 目标（截断）
        const objective = truncateToWidth(goal.objective, contentWidth, '…', true);
        lines.push(`${chalk.dim(`${t('goal.panel.objective')}:`)} ${objective}`);

        // 异常原因（blocked / paused）
        const reasonLine = this.buildReasonLines(goal, contentWidth);
        if (reasonLine) {
            lines.push(reasonLine);
        }

        // 评估进行中
        if (this.data.evaluating) {
            lines.push(`${chalk.yellow('⟳')} ${chalk.italic(chalk.yellow(t('goal.panel.evaluating')))}`);
        }

        // Token 用量
        const usedTokens = this.data.totalTokens;
        const usedStr = formatTokens(usedTokens);
        lines.push(`${chalk.dim(`${t('goal.renderer.tokens')}:`)} ${usedStr}`);

        return lines;
    }

    /**
     * 构建异常原因行（当 goal 处于 blocked / paused 时）。
     * 返回 null 表示无异常原因。
     */
    private buildReasonLines(goal: GoalState, contentWidth: number): string | null {
        const status = goal.status;
        if (status === 'blocked' && goal.blockedReason) {
            const truncated = truncateToWidth(goal.blockedReason, Math.max(1, contentWidth - 10), '…', true);
            return `${chalk.dim(`${t('goal.panel.blocked_reason')}:`)} ${chalk.hex(GOAL_BLOCKED_COLOR)(truncated)}`;
        }
        if (status === 'paused' && goal.pauseReason) {
            const truncated = truncateToWidth(goal.pauseReason, Math.max(1, contentWidth - 10), '…', true);
            return `${chalk.dim(`${t('goal.panel.paused_reason')}:`)} ${chalk.hex(GOAL_PAUSED_COLOR)(truncated)}`;
        }
        return null;
    }
}
