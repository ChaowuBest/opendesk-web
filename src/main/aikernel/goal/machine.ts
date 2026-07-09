import {
    GoalStates,
    type GoalEvaluationDisplayStatus,
    type GoalEvaluationRecord,
    type GoalEvent,
    type GoalState
} from './state.js';

export type GoalStateEventType =
    | 'goal.prompt_injection.requested'
    | 'goal.prompt_injection.materialized'
    | 'goal.supplement.materialized'
    | 'goal.evaluation.started'
    | 'goal.evaluation.finished'
    | 'goal.continuation.materialized';

export interface GoalStateEvent<T extends GoalStateEventType = GoalStateEventType, P = Record<string, unknown>> {
    id: string;
    type: T;
    taskId: string;
    goalId: string;
    revision: number;
    occurredAt: string;
    source: GoalEvent['source'];
    correlationId?: string;
    causationId?: string;
    payload: P;
}

export type GoalPromptInjectionReason = 'goal_create' | 'goal_edit';

export type GoalPromptInjectionRequestedEvent = GoalStateEvent<
    'goal.prompt_injection.requested',
    {
        objective: string;
        reason: GoalPromptInjectionReason;
    }
>;

export type GoalPromptInjectionMaterializedEvent = GoalStateEvent<
    'goal.prompt_injection.materialized',
    {
        reason: GoalPromptInjectionReason;
        turnGeneration: number;
    }
>;

export type GoalSupplementMaterializedEvent = GoalStateEvent<
    'goal.supplement.materialized',
    {
        supplementIds: string[];
        turnGeneration: number;
    }
>;

export type GoalEvaluationStartedEvent = GoalStateEvent<
    'goal.evaluation.started',
    {
        evaluationId: string;
        anchorMessageId?: string;
        anchorMessageIndex?: number;
    }
>;

export type GoalEvaluationFinishedEvent = GoalStateEvent<
    'goal.evaluation.finished',
    {
        evaluationId: string;
        status: GoalEvaluationDisplayStatus;
        message?: string;
        evidence?: string[];
        evaluatedAt?: string;
        nextPrompt?: string;
        supersededBy?: 'edit' | 'supplement' | 'status_change' | 'clear';
    }
>;

export type GoalEffect =
    | { type: 'persist' }
    | { type: 'publish_task_list' }
    | { type: 'publish_evaluation_chunk'; record: GoalEvaluationRecord; nextPrompt?: string }
    | { type: 'append_internal_user_message'; prompt: string; rawText?: string };

export interface GoalTransitionResult {
    events: GoalStateEvent[];
    effects: GoalEffect[];
}

function nowIso(): string {
    return new Date().toISOString();
}

export function createGoalStateEvent<T extends GoalStateEventType, P>(
    goal: GoalState,
    type: T,
    source: GoalEvent['source'],
    payload: P,
    options: {
        id?: string;
        occurredAt?: string;
        correlationId?: string;
        causationId?: string;
    } = {}
): GoalStateEvent<T, P> {
    return {
        id: options.id ?? crypto.randomUUID(),
        type,
        taskId: goal.taskId,
        goalId: goal.id,
        revision: goal.revision,
        occurredAt: options.occurredAt ?? nowIso(),
        source,
        ...(options.correlationId ? { correlationId: options.correlationId } : {}),
        ...(options.causationId ? { causationId: options.causationId } : {}),
        payload
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

export function recordGoalEvaluationStart(
    goal: GoalState,
    evaluationId: string,
    startedAt: string,
    anchor?: Pick<GoalEvaluationRecord, 'anchorMessageId' | 'anchorMessageIndex'>
): { event: GoalEvaluationStartedEvent; record: GoalEvaluationRecord; effects: GoalEffect[] } {
    const record = GoalStates.recordEvaluationStart(goal, evaluationId, startedAt, anchor);
    const event = createGoalStateEvent(
        goal,
        'goal.evaluation.started',
        'hook',
        {
            evaluationId,
            ...(anchor?.anchorMessageId ? { anchorMessageId: anchor.anchorMessageId } : {}),
            ...(typeof anchor?.anchorMessageIndex === 'number' ? { anchorMessageIndex: anchor.anchorMessageIndex } : {})
        },
        { occurredAt: startedAt, correlationId: evaluationId }
    );
    return {
        event,
        record,
        effects: [{ type: 'persist' }, { type: 'publish_evaluation_chunk', record }]
    };
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
        supersededBy?: GoalEvaluationFinishedEvent['payload']['supersededBy'];
    }
): { event: GoalEvaluationFinishedEvent; record: GoalEvaluationRecord; effects: GoalEffect[] } {
    const record = GoalStates.recordEvaluationEnd(goal, {
        evaluationId: input.evaluationId,
        status: input.status,
        ...(input.message !== undefined ? { message: input.message } : {}),
        ...(input.evidence ? { evidence: input.evidence } : {}),
        ...(input.evaluatedAt ? { evaluatedAt: input.evaluatedAt } : {})
    });
    const event = createGoalStateEvent(
        goal,
        'goal.evaluation.finished',
        'hook',
        {
            evaluationId: input.evaluationId,
            status: input.status,
            ...(input.message !== undefined ? { message: input.message } : {}),
            ...(input.evidence ? { evidence: [...input.evidence] } : {}),
            ...(input.evaluatedAt ? { evaluatedAt: input.evaluatedAt } : {}),
            ...(input.nextPrompt ? { nextPrompt: input.nextPrompt } : {}),
            ...(input.supersededBy ? { supersededBy: input.supersededBy } : {})
        },
        { occurredAt: input.evaluatedAt, correlationId: input.evaluationId }
    );
    return {
        event,
        record,
        effects: [{ type: 'persist' }, { type: 'publish_evaluation_chunk', record, nextPrompt: input.nextPrompt }]
    };
}
