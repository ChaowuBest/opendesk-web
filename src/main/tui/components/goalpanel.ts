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

import { Component, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

import { GoalStates, type GoalState, type GoalStatus } from '../../aikernel/goal/state.js';
import chalk from 'chalk';
import { Card } from './card.js';
import { t } from '../../../locale/index.js';
import {
    formatClockDuration,
    formatTokens,
    getGoalEvaluationStatusLabelKey,
    getGoalStatusMeta
} from '../../../common/goal/format.js';
import { getLatestGoalEvaluationDisplay } from '../../../common/goal/evaluation-display.js';

function getGoalStatusLabel(status: GoalStatus): string {
    const meta = getGoalStatusMeta(status);
    const label = t(meta.labelKey);
    return label === meta.labelKey ? meta.fallbackLabel : label;
}

function getGoalEvaluationStatusLabel(status: string): string {
    const key = getGoalEvaluationStatusLabelKey(status);
    const label = t(key);
    return label === key ? status : label;
}

function getGoalStatusColor(status: GoalStatus): string {
    return getGoalStatusMeta(status).color;
}

function getGoalStatusIcon(status: GoalStatus): string {
    return getGoalStatusMeta(status).icon;
}

function visibleLabelWidth(label: string): number {
    return visibleWidth(`${label}: `);
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
    /** 消息列表中的 GoalPanel 用 goal.id 作为身份标识，用于去重和更新。 */
    id?: string;
}

/**
 * GoalPanel：展示 goal 的目标、状态、token 用量、执行时间、评估结果等信息。
 *
 * 可用于持久面板（常驻于 TUI 布局中）和消息列表中的 per-goal 面板。
 * 通过 id 字段标识，支持在消息列表中原地更新。
 */
export class GoalPanel implements Component {
    readonly id?: string;
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
        this.id = options.id;
        this.showCleared = options.showCleared === true;
        this.showTerminal = options.showTerminal === true || this.showCleared;
    }

    /**
     * 更新面板数据。由外部驱动（TaskView 的 token update + 定时器/GoalService 事件）。
     */
    update(data: Partial<GoalPanelData>): void {
        const previousGoalId = this.data.goalState?.id;
        const nextGoalState = data.goalState ?? this.data.goalState;
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
            if (
                nextGoalState &&
                previousGoalId !== undefined &&
                nextGoalState.id === previousGoalId &&
                GoalStates.isTerminal(nextGoalState.status) &&
                data.elapsedMs < this.data.elapsedMs
            ) {
                // 避免未完成的终态快照把已知更大的耗时覆盖为 0 或回退。
            } else {
                this.data.elapsedMs = data.elapsedMs;
            }
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
     * - complete/cleared → 默认隐藏，可通过 showTerminal/showCleared 配置显示
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
        const elapsed = formatClockDuration(this.data.elapsedMs);

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

        const evaluationLines = this.buildEvaluationLines(goal, contentWidth);
        lines.push(...evaluationLines);

        // Token 用量
        const usedTokens = this.data.totalTokens;
        const usedStr = formatTokens(usedTokens);
        lines.push(`${chalk.dim(`${t('goal.renderer.tokens')}:`)} ${usedStr}`);

        return lines;
    }

    private buildEvaluationLines(goal: GoalState, contentWidth: number): string[] {
        const evaluation = getLatestGoalEvaluationDisplay(goal);
        if (!evaluation) {
            return [];
        }

        const status = getGoalEvaluationStatusLabel(evaluation.status);
        const reason = evaluation.message;
        const summary = reason ? `${status} - ${reason}` : status;
        const summaryWidth = Math.max(1, contentWidth - visibleLabelWidth(t('goal.panel.latest_evaluation')));
        const lines = [
            `${chalk.dim(`${t('goal.panel.latest_evaluation')}:`)} ${truncateToWidth(summary, summaryWidth, '…', true)}`
        ];

        const evidence = evaluation.evidence[0];
        if (evidence) {
            const evidenceWidth = Math.max(1, contentWidth - visibleLabelWidth(t('goal.panel.evidence')));
            lines.push(
                `${chalk.dim(`${t('goal.panel.evidence')}:`)} ${truncateToWidth(evidence, evidenceWidth, '…', true)}`
            );
        }

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
            return `${chalk.dim(`${t('goal.panel.blocked_reason')}:`)} ${chalk.hex(getGoalStatusMeta('blocked').color)(truncated)}`;
        }
        if (status === 'paused' && goal.pauseReason) {
            const truncated = truncateToWidth(goal.pauseReason, Math.max(1, contentWidth - 10), '…', true);
            return `${chalk.dim(`${t('goal.panel.paused_reason')}:`)} ${chalk.hex(getGoalStatusMeta('paused').color)(truncated)}`;
        }
        return null;
    }
}
