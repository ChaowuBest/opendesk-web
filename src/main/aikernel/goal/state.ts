import fs from 'fs';
import path from 'path';
import { getTaskArtifactDirectory } from '../../utils/setting.js';

export type GoalStatus = 'active' | 'paused' | 'blocked' | 'budget_limited' | 'complete' | 'cleared';

export interface GoalTokenBudget {
    maxTotalTokens?: number;
    usedTotalTokens?: number;
}

export interface GoalEditRecord {
    revision: number;
    previousObjective: string;
    objective: string;
    editedAt: string;
    source: GoalEvent['source'];
}

export interface GoalSchedulerLease {
    id: string;
    acquiredAt: string;
    expiresAt: string;
    reason: 'create' | 'resume' | 'continuation' | 'hook';
}

export interface GoalEvaluation {
    goalId: string;
    goalRevision: number;
    status: 'met' | 'not_met' | 'blocked' | 'budget_limited';
    reason: string;
    evidence: string[];
    nextPrompt?: string;
    evaluatedAt: string;
}

export interface GoalContinuation {
    id: string;
    goalId: string;
    goalRevision: number;
    prompt: string;
    reason: string;
    createdAt: string;
    consumedAt?: string;
    consumedByTurnGeneration?: number;
}

export interface GoalState {
    version: 1;
    id: string;
    taskId: string;
    objective: string;
    successCriteria: string[];
    status: GoalStatus;
    revision: number;
    attempts: number;
    maxAttempts?: number;
    tokenBudget?: GoalTokenBudget;
    // goal 创建时 chat_context 中已累计的 token 总量快照，
    // 用于让每个 goal 独立计量 token 消耗（usedTotalTokens = 当前累计 − baseline）
    tokenUsageBaseline?: number;
    timeBudgetMs?: number;
    startedAt?: string;
    lastEvaluation?: GoalEvaluation;
    pendingContinuation?: GoalContinuation;
    editHistory: GoalEditRecord[];
    pauseReason?: string;
    blockedReason?: string;
    budgetLimitedReason?: string;
    oneShotBudgetOverride?: GoalOneShotBudgetOverride;
    schedulerLease?: GoalSchedulerLease;
    createdAt: string;
    updatedAt: string;
    pausedAt?: string;
    resumedAt?: string;
    completedAt?: string;
    clearedAt?: string;
}

export interface GoalEvent {
    id: string;
    goalId: string;
    taskId: string;
    type:
        | 'created'
        | 'edited'
        | 'paused'
        | 'resumed'
        | 'evaluated'
        | 'continuation_created'
        | 'continuation_consumed'
        | 'blocked'
        | 'budget_limited'
        | 'completed'
        | 'forked'
        | 'cleared';
    revision: number;
    timestamp: string;
    source: 'tui' | 'chat' | 'gui' | 'api' | 'scheduler' | 'hook' | 'evaluator' | 'user_message' | 'system';
    payload?: Record<string, unknown>;
}

export type GoalEventLogStorage = GoalEventLogInlineStorage | GoalEventLogArtifactStorage;

export interface GoalEventLogInlineStorage {
    mode: 'inline';
    events: GoalEvent[];
}

export interface GoalEventLogArtifactStorage {
    mode: 'artifact';
    tail: GoalEvent[];
    artifactPath: string;
}

export interface GoalBudgetOverride {
    maxAttemptsIncrement?: number;
    timeBudgetMsIncrement?: number;
    tokenBudgetIncrement?: number;
    oneShot?: boolean;
    reason?: string;
}

export interface GoalOneShotBudgetOverride {
    id: string;
    grantedAt: string;
    reason?: string;
    consumedAt?: string;
    consumedReason?: string;
}

export interface CreateGoalInput {
    objective: string;
    successCriteria?: string[];
    maxAttempts?: number;
    tokenBudget?: GoalTokenBudget;
    timeBudgetMs?: number;
    source?: GoalEvent['source'];
}

export interface GoalBudgetUpdate {
    maxAttempts?: number | null;
    tokenBudget?: GoalTokenBudget | null;
    timeBudgetMs?: number | null;
}

export interface ResumeGoalOptions {
    source?: GoalEvent['source'];
    promptOverride?: string;
    note?: string;
    budgetOverride?: GoalBudgetOverride;
}

export interface GoalRenderSummary {
    id: string;
    status: GoalStatus;
    revision: number;
    objective: string;
    pendingContinuation: boolean;
    updatedAt: string;
    completedAt?: string;
    successCriteria?: string[];
    attempts?: number;
    maxAttempts?: number;
    tokenBudget?: GoalTokenBudget;
    lastEvaluation?: {
        status: GoalEvaluation['status'];
        reason: string;
        evaluatedAt: string;
    };
    recentEvents?: Array<{
        type: GoalEvent['type'];
        revision: number;
        timestamp: string;
        source: GoalEvent['source'];
        objective?: string;
        previousObjective?: string;
    }>;
    objectiveEvents?: Array<{
        type: GoalEvent['type'];
        revision: number;
        timestamp: string;
        source: GoalEvent['source'];
        objective?: string;
        previousObjective?: string;
    }>;
}

export interface GoalStatusView {
    summary?: GoalRenderSummary;
    lastEvaluationStatus?: GoalEvaluation['status'];
    lastEvaluationAt?: string;
    attempts?: number;
    maxAttempts?: number;
}

export interface GoalCommandResult {
    ok: boolean;
    status?: GoalStatus;
    messageKey?: string;
    messageArgs?: Record<string, unknown>;
    startedScheduler?: boolean;
    interruptedRunner?: boolean;
    summary?: GoalRenderSummary;
    errorCode?: string;
}

export type GoalEvaluationApplyResult =
    | { action: 'finish'; status: GoalStatus }
    | { action: 'continue'; continuationPrompt: string; continuationId: string };

export type GoalMaybeResumeResult =
    | { action: 'none' }
    | { action: 'resume_via_scheduler_only'; promptSource: 'pending_continuation' | 'default_resume' }
    | { action: 'resume_with_user_message' }
    | { action: 'ignore_and_reject'; messageKey: 'goal.blocked.unrelated_message' };

export interface GoalRenderSummaryOptions {
    includeCleared?: boolean;
    terminalRetentionMs?: number;
}

export interface TaskRuntimeInterrupt {
    requested: boolean;
    reason: 'goal_pause' | 'goal_clear' | 'user_stop' | 'system_shutdown' | 'failure_recovery';
    requestedAt: string;
    turnGeneration?: number;
    handledAt?: string;
}

const GOAL_EVENT_LOG_INLINE_LIMIT = 200;

function isoNow(): string {
    return new Date().toISOString();
}

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function getGoalEventTail(storage?: GoalEventLogStorage): GoalEvent[] {
    if (!storage) return [];
    return storage.mode === 'inline' ? storage.events : storage.tail;
}

function normalizeStatus(raw: unknown): GoalStatus | undefined {
    if (
        raw === 'active' ||
        raw === 'paused' ||
        raw === 'blocked' ||
        raw === 'budget_limited' ||
        raw === 'complete' ||
        raw === 'cleared'
    ) {
        return raw;
    }
    return undefined;
}

function normalizeSource(raw: unknown): GoalEvent['source'] {
    if (
        raw === 'tui' ||
        raw === 'chat' ||
        raw === 'gui' ||
        raw === 'api' ||
        raw === 'scheduler' ||
        raw === 'hook' ||
        raw === 'evaluator' ||
        raw === 'user_message' ||
        raw === 'system'
    ) {
        return raw;
    }
    return 'system';
}

function normalizeStringArray(raw: unknown): string[] {
    return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
}

function normalizeEvaluation(raw: unknown): GoalEvaluation | undefined {
    if (!isObject(raw)) return undefined;
    const status = raw.status;
    if (status !== 'met' && status !== 'not_met' && status !== 'blocked' && status !== 'budget_limited') {
        return undefined;
    }
    if (typeof raw.goalId !== 'string' || typeof raw.goalRevision !== 'number') return undefined;
    return {
        goalId: raw.goalId,
        goalRevision: raw.goalRevision,
        status,
        reason: typeof raw.reason === 'string' ? raw.reason : '',
        evidence: normalizeStringArray(raw.evidence),
        ...(typeof raw.nextPrompt === 'string' ? { nextPrompt: raw.nextPrompt } : {}),
        evaluatedAt: typeof raw.evaluatedAt === 'string' ? raw.evaluatedAt : isoNow()
    };
}

function normalizeContinuation(raw: unknown): GoalContinuation | undefined {
    if (!isObject(raw)) return undefined;
    if (
        typeof raw.id !== 'string' ||
        typeof raw.goalId !== 'string' ||
        typeof raw.goalRevision !== 'number' ||
        typeof raw.prompt !== 'string'
    ) {
        return undefined;
    }
    return {
        id: raw.id,
        goalId: raw.goalId,
        goalRevision: raw.goalRevision,
        prompt: raw.prompt,
        reason: typeof raw.reason === 'string' ? raw.reason : 'unspecified',
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : isoNow(),
        ...(typeof raw.consumedAt === 'string' ? { consumedAt: raw.consumedAt } : {}),
        ...(typeof raw.consumedByTurnGeneration === 'number'
            ? { consumedByTurnGeneration: raw.consumedByTurnGeneration }
            : {})
    };
}

function normalizeLease(raw: unknown): GoalSchedulerLease | undefined {
    if (!isObject(raw)) return undefined;
    const reason = raw.reason;
    if (reason !== 'create' && reason !== 'resume' && reason !== 'continuation' && reason !== 'hook') {
        return undefined;
    }
    if (typeof raw.id !== 'string') return undefined;
    return {
        id: raw.id,
        acquiredAt: typeof raw.acquiredAt === 'string' ? raw.acquiredAt : isoNow(),
        expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : isoNow(),
        reason
    };
}

function normalizeEditHistory(raw: unknown): GoalEditRecord[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter(isObject)
        .filter((entry) => typeof entry.revision === 'number' && typeof entry.objective === 'string')
        .map((entry) => ({
            revision: entry.revision as number,
            previousObjective: typeof entry.previousObjective === 'string' ? entry.previousObjective : '',
            objective: entry.objective as string,
            editedAt: typeof entry.editedAt === 'string' ? entry.editedAt : isoNow(),
            source: normalizeSource(entry.source)
        }));
}

function normalizeTokenBudget(raw: unknown): GoalTokenBudget | undefined {
    if (!isObject(raw)) return undefined;
    const budget: GoalTokenBudget = {};
    if (typeof raw.maxTotalTokens === 'number') budget.maxTotalTokens = raw.maxTotalTokens;
    if (typeof raw.usedTotalTokens === 'number') budget.usedTotalTokens = raw.usedTotalTokens;
    return Object.keys(budget).length > 0 ? budget : undefined;
}

function normalizeTokenUsageBaseline(raw: unknown): number | undefined {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return undefined;
    return raw;
}

function normalizeOneShotBudgetOverride(raw: unknown): GoalOneShotBudgetOverride | undefined {
    if (!isObject(raw) || typeof raw.id !== 'string') return undefined;
    return {
        id: raw.id,
        grantedAt: typeof raw.grantedAt === 'string' ? raw.grantedAt : isoNow(),
        ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
        ...(typeof raw.consumedAt === 'string' ? { consumedAt: raw.consumedAt } : {}),
        ...(typeof raw.consumedReason === 'string' ? { consumedReason: raw.consumedReason } : {})
    };
}

export const GoalStates = {
    create(taskId: string, input: CreateGoalInput): GoalState {
        const now = isoNow();
        return {
            version: 1,
            id: crypto.randomUUID(),
            taskId,
            objective: input.objective.trim(),
            successCriteria: input.successCriteria ?? [],
            status: 'active',
            revision: 1,
            attempts: 0,
            ...(typeof input.maxAttempts === 'number' ? { maxAttempts: input.maxAttempts } : {}),
            ...(input.tokenBudget ? { tokenBudget: cloneJson(input.tokenBudget) } : {}),
            ...(typeof input.timeBudgetMs === 'number' ? { timeBudgetMs: input.timeBudgetMs } : {}),
            startedAt: now,
            editHistory: [],
            createdAt: now,
            updatedAt: now
        };
    },

    deserialize(raw: unknown, taskId?: string): GoalState | undefined {
        if (!isObject(raw)) return undefined;
        const status = normalizeStatus(raw.status);
        if (!status || typeof raw.objective !== 'string') return undefined;
        const id = typeof raw.id === 'string' && raw.id.trim().length > 0 ? raw.id : crypto.randomUUID();
        const now = isoNow();
        return {
            version: 1,
            id,
            taskId: typeof raw.taskId === 'string' ? raw.taskId : (taskId ?? ''),
            objective: raw.objective,
            successCriteria: normalizeStringArray(raw.successCriteria),
            status,
            revision: typeof raw.revision === 'number' && raw.revision > 0 ? raw.revision : 1,
            attempts: typeof raw.attempts === 'number' && raw.attempts >= 0 ? raw.attempts : 0,
            ...(typeof raw.maxAttempts === 'number' ? { maxAttempts: raw.maxAttempts } : {}),
            ...(normalizeTokenBudget(raw.tokenBudget) ? { tokenBudget: normalizeTokenBudget(raw.tokenBudget) } : {}),
            ...(normalizeTokenUsageBaseline(raw.tokenUsageBaseline)
                ? { tokenUsageBaseline: normalizeTokenUsageBaseline(raw.tokenUsageBaseline) }
                : {}),
            ...(typeof raw.timeBudgetMs === 'number' ? { timeBudgetMs: raw.timeBudgetMs } : {}),
            ...(typeof raw.startedAt === 'string' ? { startedAt: raw.startedAt } : {}),
            ...(normalizeEvaluation(raw.lastEvaluation)
                ? { lastEvaluation: normalizeEvaluation(raw.lastEvaluation) }
                : {}),
            ...(normalizeContinuation(raw.pendingContinuation)
                ? { pendingContinuation: normalizeContinuation(raw.pendingContinuation) }
                : {}),
            editHistory: normalizeEditHistory(raw.editHistory),
            ...(typeof raw.pauseReason === 'string' ? { pauseReason: raw.pauseReason } : {}),
            ...(typeof raw.blockedReason === 'string' ? { blockedReason: raw.blockedReason } : {}),
            ...(typeof raw.budgetLimitedReason === 'string' ? { budgetLimitedReason: raw.budgetLimitedReason } : {}),
            ...(normalizeOneShotBudgetOverride(raw.oneShotBudgetOverride)
                ? { oneShotBudgetOverride: normalizeOneShotBudgetOverride(raw.oneShotBudgetOverride) }
                : {}),
            ...(normalizeLease(raw.schedulerLease) ? { schedulerLease: normalizeLease(raw.schedulerLease) } : {}),
            createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
            updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
            ...(typeof raw.pausedAt === 'string' ? { pausedAt: raw.pausedAt } : {}),
            ...(typeof raw.resumedAt === 'string' ? { resumedAt: raw.resumedAt } : {}),
            ...(typeof raw.completedAt === 'string' ? { completedAt: raw.completedAt } : {}),
            ...(typeof raw.clearedAt === 'string' ? { clearedAt: raw.clearedAt } : {})
        };
    },

    serialize(state?: GoalState): GoalState | undefined {
        return state ? cloneJson(state) : undefined;
    },

    clone(state: GoalState): GoalState {
        return cloneJson(state);
    },

    isTerminal(status?: GoalStatus): boolean {
        return status === 'complete' || status === 'cleared';
    },

    isUnfinished(status?: GoalStatus): boolean {
        return status === 'active' || status === 'paused' || status === 'blocked' || status === 'budget_limited';
    },

    renderSummary(
        state?: GoalState,
        events?: GoalEventLogStorage,
        options: GoalRenderSummaryOptions = {}
    ): GoalRenderSummary | undefined {
        if (!state) return undefined;
        if (state.status === 'cleared' && options.includeCleared !== true) return undefined;
        if (typeof options.terminalRetentionMs === 'number' && GoalStates.isTerminal(state.status)) {
            const terminalAt = state.status === 'complete' ? state.completedAt : state.clearedAt;
            const terminalTime = terminalAt ? Date.parse(terminalAt) : Number.NaN;
            if (!Number.isNaN(terminalTime) && Date.now() - terminalTime > options.terminalRetentionMs) {
                return undefined;
            }
        }
        const tailEvents = events ? getGoalEventTail(events) : [];
        const toRenderEvent = (event: GoalEvent) => {
            const base = {
                type: event.type,
                revision: event.revision,
                timestamp: event.timestamp,
                source: event.source
            };
            const payload = event.payload;
            if (!payload) return base;
            const objective = typeof payload.objective === 'string' ? payload.objective : undefined;
            const previousObjective =
                typeof payload.previousObjective === 'string' ? payload.previousObjective : undefined;
            if (objective === undefined && previousObjective === undefined) {
                return base;
            }
            return { ...base, objective, previousObjective };
        };
        const hasObjectiveChange = (event: GoalEvent): boolean => {
            if (event.type === 'created' || event.type === 'edited') return true;
            const payload = event.payload;
            return (
                isObject(payload) &&
                (typeof payload.objective === 'string' || typeof payload.previousObjective === 'string')
            );
        };

        return {
            id: state.id,
            status: state.status,
            revision: state.revision,
            objective: state.objective,
            pendingContinuation: !!state.pendingContinuation && !state.pendingContinuation.consumedAt,
            updatedAt: state.updatedAt,
            ...(state.completedAt ? { completedAt: state.completedAt } : {}),
            successCriteria: [...state.successCriteria],
            attempts: state.attempts,
            ...(typeof state.maxAttempts === 'number' ? { maxAttempts: state.maxAttempts } : {}),
            ...(state.tokenBudget ? { tokenBudget: cloneJson(state.tokenBudget) } : {}),
            ...(state.lastEvaluation
                ? {
                      lastEvaluation: {
                          status: state.lastEvaluation.status,
                          reason: state.lastEvaluation.reason,
                          evaluatedAt: state.lastEvaluation.evaluatedAt
                      }
                  }
                : {}),
            ...(events
                ? {
                      recentEvents: tailEvents.slice(-8).map(toRenderEvent),
                      objectiveEvents: tailEvents.filter(hasObjectiveChange).slice(-8).map(toRenderEvent)
                  }
                : {})
        };
    },

    statusView(state?: GoalState, events?: GoalEventLogStorage): GoalStatusView {
        const summary = GoalStates.renderSummary(state, events);
        if (!state || !summary) return {};
        return {
            summary,
            lastEvaluationStatus: state.lastEvaluation?.status,
            lastEvaluationAt: state.lastEvaluation?.evaluatedAt,
            attempts: state.attempts,
            maxAttempts: state.maxAttempts
        };
    },

    createContinuation(goal: GoalState, prompt: string, reason: string): GoalContinuation {
        return {
            id: crypto.randomUUID(),
            goalId: goal.id,
            goalRevision: goal.revision,
            prompt,
            reason,
            createdAt: isoNow()
        };
    },

    isLeaseValid(lease: GoalSchedulerLease | undefined, at: Date = new Date()): boolean {
        if (!lease) return false;
        const expiresAt = Date.parse(lease.expiresAt);
        return Number.isFinite(expiresAt) && expiresAt > at.getTime();
    }
};

export const GoalEvents = {
    deserializeEvents(raw: unknown): GoalEvent[] {
        if (!Array.isArray(raw)) return [];
        return raw.filter(isObject).map((event) => ({
            id: typeof event.id === 'string' ? event.id : crypto.randomUUID(),
            goalId: typeof event.goalId === 'string' ? event.goalId : '',
            taskId: typeof event.taskId === 'string' ? event.taskId : '',
            type: typeof event.type === 'string' ? (event.type as GoalEvent['type']) : 'created',
            revision: typeof event.revision === 'number' ? event.revision : 1,
            timestamp: typeof event.timestamp === 'string' ? event.timestamp : isoNow(),
            source: normalizeSource(event.source),
            ...(isObject(event.payload) ? { payload: event.payload } : {})
        }));
    },

    deserialize(raw: unknown): GoalEventLogStorage | undefined {
        if (Array.isArray(raw)) {
            return { mode: 'inline', events: GoalEvents.deserializeEvents(raw) };
        }
        if (!isObject(raw)) return undefined;
        if (raw.mode === 'inline') {
            return { mode: 'inline', events: GoalEvents.deserializeEvents(raw.events) };
        }
        if (raw.mode === 'artifact') {
            const artifactPath = typeof raw.artifactPath === 'string' ? raw.artifactPath : '';
            return {
                mode: 'artifact',
                tail: GoalEvents.deserializeEvents(raw.tail),
                artifactPath
            };
        }
        return undefined;
    },

    serialize(storage?: GoalEventLogStorage): GoalEventLogStorage | undefined {
        return storage ? cloneJson(storage) : undefined;
    },

    getTail(storage?: GoalEventLogStorage): GoalEvent[] {
        return getGoalEventTail(storage);
    },

    appendToTask(
        task: {
            task_id: string;
            goal_event_log?: GoalEventLogStorage;
        },
        event: GoalEvent
    ): void {
        const storage = task.goal_event_log;
        const existing = GoalEvents.getTail(storage);
        const next = [...existing, event];
        if (next.length <= GOAL_EVENT_LOG_INLINE_LIMIT && storage?.mode !== 'artifact') {
            task.goal_event_log = { mode: 'inline', events: next };
            return;
        }

        const tail = next.slice(-GOAL_EVENT_LOG_INLINE_LIMIT);
        try {
            const goalDir = path.join(getTaskArtifactDirectory(task.task_id), 'goal');
            fs.mkdirSync(goalDir, { recursive: true });
            const artifactPath = path.join(goalDir, 'events.jsonl');
            const artifactEvents = storage?.mode === 'artifact' ? [event] : next;
            fs.appendFileSync(
                artifactPath,
                artifactEvents.map((item) => JSON.stringify(item)).join('\n') + '\n',
                'utf8'
            );
            task.goal_event_log = {
                mode: 'artifact',
                tail,
                artifactPath: `artifacts/${task.task_id}/goal/events.jsonl`
            };
        } catch {
            task.goal_event_log = { mode: 'inline', events: tail };
        }
    }
};

export function createGoalEvent(
    goal: GoalState,
    type: GoalEvent['type'],
    source: GoalEvent['source'],
    payload?: Record<string, unknown>
): GoalEvent {
    return {
        id: crypto.randomUUID(),
        goalId: goal.id,
        taskId: goal.taskId,
        type,
        revision: goal.revision,
        timestamp: isoNow(),
        source,
        ...(payload ? { payload } : {})
    };
}

export function sanitizeErrorSummary(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return raw.replace(/\s+/g, ' ').slice(0, 500);
}
