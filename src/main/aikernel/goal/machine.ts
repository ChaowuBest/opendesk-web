import {
    GoalStates,
    type GoalEvaluationDisplayStatus,
    type GoalEvaluationRecord,
    type GoalEvent,
    type GoalState
} from './state.js';

export type GoalPromptInjectionReason = 'goal_create' | 'goal_edit';

export interface GoalPromptInjectionRequestedEvent {
    id: string;
    type: 'goal.prompt_injection.requested';
    taskId: string;
    goalId: string;
    revision: number;
    occurredAt: string;
    source: GoalEvent['source'];
    payload: {
        objective: string;
        reason: GoalPromptInjectionReason;
    };
}

export function createGoalPromptInjectionRequestedEvent(input: {
    taskId: string;
    goalId: string;
    goalRevision: number;
    objective: string;
    reason: GoalPromptInjectionReason;
    source?: GoalEvent['source'];
}): GoalPromptInjectionRequestedEvent {
    return {
        id: crypto.randomUUID(),
        type: 'goal.prompt_injection.requested',
        taskId: input.taskId,
        goalId: input.goalId,
        revision: input.goalRevision,
        occurredAt: nowIso(),
        source: input.source ?? 'system',
        payload: {
            objective: input.objective,
            reason: input.reason
        }
    };
}

function nowIso(): string {
    return new Date().toISOString();
}

export function recordGoalEvaluationStart(
    goal: GoalState,
    evaluationId: string,
    startedAt: string,
    anchor?: Pick<GoalEvaluationRecord, 'anchorMessageId' | 'anchorMessageIndex'>
): GoalEvaluationRecord {
    return GoalStates.recordEvaluationStart(goal, evaluationId, startedAt, anchor);
}

export function recordGoalEvaluationFinish(
    goal: GoalState,
    input: {
        evaluationId: string;
        status: GoalEvaluationDisplayStatus;
        message?: string;
        evidence?: string[];
        evaluatedAt?: string;
        nextPrompt?: string;
    }
): GoalEvaluationRecord {
    return GoalStates.recordEvaluationEnd(goal, {
        evaluationId: input.evaluationId,
        status: input.status,
        ...(input.message !== undefined ? { message: input.message } : {}),
        ...(input.evidence ? { evidence: input.evidence } : {}),
        ...(input.evaluatedAt ? { evaluatedAt: input.evaluatedAt } : {})
    });
}
