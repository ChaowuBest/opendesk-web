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

export type GoalEvaluationDisplayPhase = 'start' | 'end';

export type GoalEvaluationDisplayStatus =
    | 'met'
    | 'not_met'
    | 'blocked'
    | 'error'
    | 'superseded'
    | 'cancelled'
    | 'running'
    | string;

export interface GoalEvaluationDisplayInput {
    evaluationId?: unknown;
    goalId?: unknown;
    goalRevision?: unknown;
    anchorMessageId?: unknown;
    anchorMessageIndex?: unknown;
    phase?: unknown;
    status?: unknown;
    message?: unknown;
    reason?: unknown;
    evidence?: unknown;
    startedAt?: unknown;
    evaluatedAt?: unknown;
    updatedAt?: unknown;
    /** Internal continuation prompt. Accepted in raw input but intentionally excluded from display output. */
    nextPrompt?: unknown;
}

export interface GoalEvaluationDisplayModel {
    evaluationId?: string;
    goalId?: string;
    goalRevision?: number;
    anchorMessageId?: string;
    anchorMessageIndex?: number;
    phase: GoalEvaluationDisplayPhase;
    status: GoalEvaluationDisplayStatus;
    message: string;
    evidence: string[];
    startedAt?: string;
    evaluatedAt?: string;
    updatedAt?: string;
    timestamp?: string;
}

export type GoalEvaluationDisplayKind = 'running' | 'success' | 'warning' | 'danger' | 'neutral';

export interface GoalEvaluationSourceLike {
    evaluations?: unknown;
    lastEvaluation?: unknown;
}

function trimString(value: unknown): string | undefined {
    return typeof value === 'string' ? value.trim() : undefined;
}

function stringField(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function evidenceList(value: unknown): string[] {
    return Array.isArray(value)
        ? value
              .filter((item): item is string => typeof item === 'string')
              .map((item) => item.trim())
              .filter((item) => item.length > 0)
        : [];
}

export function normalizeGoalEvaluationDisplay(
    input: GoalEvaluationDisplayInput | null | undefined
): GoalEvaluationDisplayModel {
    const value = input ?? {};
    const phase: GoalEvaluationDisplayPhase = value.phase === 'end' ? 'end' : 'start';
    const timestamp = stringField(value.updatedAt) ?? stringField(value.evaluatedAt) ?? stringField(value.startedAt);
    const message = trimString(value.message) ?? trimString(value.reason) ?? '';

    return {
        ...(stringField(value.evaluationId) ? { evaluationId: value.evaluationId as string } : {}),
        ...(stringField(value.goalId) ? { goalId: value.goalId as string } : {}),
        ...(numberField(value.goalRevision) !== undefined ? { goalRevision: value.goalRevision as number } : {}),
        ...(stringField(value.anchorMessageId) ? { anchorMessageId: value.anchorMessageId as string } : {}),
        ...(numberField(value.anchorMessageIndex) !== undefined
            ? { anchorMessageIndex: value.anchorMessageIndex as number }
            : {}),
        phase,
        status: typeof value.status === 'string' ? value.status : phase === 'start' ? 'running' : '',
        message,
        evidence: evidenceList(value.evidence),
        ...(stringField(value.startedAt) ? { startedAt: value.startedAt as string } : {}),
        ...(stringField(value.evaluatedAt) ? { evaluatedAt: value.evaluatedAt as string } : {}),
        ...(stringField(value.updatedAt) ? { updatedAt: value.updatedAt as string } : {}),
        ...(timestamp ? { timestamp } : {})
    };
}

export function normalizeGoalEvaluationDisplayList(records: unknown): GoalEvaluationDisplayModel[] {
    return Array.isArray(records) ? records.map((record) => normalizeGoalEvaluationDisplay(record)) : [];
}

export function getLatestGoalEvaluationDisplay(
    goal: GoalEvaluationSourceLike | null | undefined
): GoalEvaluationDisplayModel | undefined {
    const evaluations = normalizeGoalEvaluationDisplayList(goal?.evaluations);
    if (evaluations.length > 0) return evaluations[evaluations.length - 1];
    if (!goal?.lastEvaluation || typeof goal.lastEvaluation !== 'object') return undefined;
    return normalizeGoalEvaluationDisplay({
        ...(goal.lastEvaluation as Record<string, unknown>),
        phase: 'end'
    });
}

export function getGoalEvaluationDisplayKind(
    evaluation: Pick<GoalEvaluationDisplayModel, 'phase' | 'status'>
): GoalEvaluationDisplayKind {
    if (evaluation.phase === 'start') return 'running';
    if (evaluation.status === 'met') return 'success';
    if (evaluation.status === 'not_met') return 'warning';
    if (evaluation.status === 'blocked' || evaluation.status === 'error') return 'danger';
    return 'neutral';
}
