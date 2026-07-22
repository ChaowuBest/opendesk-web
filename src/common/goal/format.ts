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

export type GoalFormatStatus = 'active' | 'paused' | 'blocked' | 'complete' | 'cleared';

export interface GoalStatusMeta {
    labelKey: string;
    fallbackLabel: string;
    icon: string;
    color: string;
}

export interface GoalEvaluationTimestampLike {
    phase?: string;
    startedAt?: string;
    evaluatedAt?: string;
    updatedAt?: string;
}

export type GoalElapsedStatus = GoalFormatStatus | string;

export interface GoalElapsedLike {
    status?: GoalElapsedStatus;
    awaitingContextEntry?: boolean;
    executionStarted?: boolean;
    startedAt?: string;
    createdAt?: string;
    completedAt?: string;
    clearedAt?: string;
}

export interface GoalElapsedOptions {
    now?: number | Date;
}

const GOAL_STATUS_META: Record<GoalFormatStatus, GoalStatusMeta> = {
    active: {
        labelKey: 'goal.label.status.active',
        fallbackLabel: 'active',
        icon: '◉',
        color: '#00E676'
    },
    paused: {
        labelKey: 'goal.label.status.paused',
        fallbackLabel: 'paused',
        icon: '⏸',
        color: '#FFA726'
    },
    blocked: {
        labelKey: 'goal.label.status.blocked',
        fallbackLabel: 'blocked',
        icon: '⊗',
        color: '#EF5350'
    },
    complete: {
        labelKey: 'goal.label.status.complete',
        fallbackLabel: 'complete',
        icon: '✓',
        color: '#66BB6A'
    },
    cleared: {
        labelKey: 'goal.label.status.cleared',
        fallbackLabel: 'cleared',
        icon: '✕',
        color: '#9E9E9E'
    }
};

function padDatePart(value: number): string {
    return String(value).padStart(2, '0');
}

export function formatLocalDateTime(value: unknown): string {
    if (value === null || value === undefined || value === '') {
        return '';
    }

    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime())) {
        return String(value);
    }

    return [
        `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`,
        `${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}:${padDatePart(date.getSeconds())}`
    ].join(' ');
}

export function getGoalEvaluationDisplayTimestamp(evaluation: GoalEvaluationTimestampLike | null | undefined): string {
    if (!evaluation) return '';
    if (evaluation.phase === 'start') {
        return evaluation.startedAt || evaluation.updatedAt || evaluation.evaluatedAt || '';
    }
    return evaluation.evaluatedAt || evaluation.updatedAt || evaluation.startedAt || '';
}

export function getGoalElapsedMs(goal: GoalElapsedLike | null | undefined, options: GoalElapsedOptions = {}): number {
    if (!goal || goal.executionStarted === false) return 0;
    const timerOrigin = goal.startedAt ?? (goal.awaitingContextEntry === true ? undefined : goal.createdAt);
    if (!timerOrigin) return 0;
    const startedAt = Date.parse(timerOrigin);
    if (!Number.isFinite(startedAt)) return 0;

    const nowMs = options.now instanceof Date ? options.now.getTime() : (options.now ?? Date.now());
    const endedAt =
        goal.status === 'complete' && goal.completedAt
            ? Date.parse(goal.completedAt)
            : goal.status === 'cleared' && goal.clearedAt
              ? Date.parse(goal.clearedAt)
              : nowMs;

    if (!Number.isFinite(endedAt)) return 0;
    return Math.max(0, endedAt - startedAt);
}

export function formatClockDuration(ms: number): string {
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

export function formatCompactDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '';
    const totalSec = Math.floor(ms / 1000);
    if (totalSec < 1) {
        return `${Math.max(0, ms)}ms`;
    }
    if (totalSec < 60) {
        return `${totalSec}s`;
    }
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (min < 60) {
        return sec === 0 ? `${min}m` : `${min}m${String(sec).padStart(2, '0')}s`;
    }
    const hour = Math.floor(min / 60);
    const remMin = min % 60;
    return remMin === 0 ? `${hour}h` : `${hour}h${String(remMin).padStart(2, '0')}m`;
}

export function formatTokens(n: number): string {
    if (n <= 0) return '0';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
    return String(n);
}

export function getGoalStatusMeta(status: GoalFormatStatus): GoalStatusMeta {
    return GOAL_STATUS_META[status];
}

export function getGoalEvaluationStatusLabelKey(status: string): string {
    return `goal.label.evaluation.${status}`;
}
