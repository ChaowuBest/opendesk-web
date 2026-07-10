import fs from 'fs';
import path from 'path';
import type { GoalEditConflict } from '../../../common/goal-command.js';
import { getTaskArtifactDirectory } from '../../utils/setting.js';

// GoalStatus 是持久化状态，不等同于 task runner 的瞬时执行状态。
// active 表示 goal 控制仍接管后续执行；paused/blocked 需要显式 resume；complete/cleared 是终态。
export type GoalStatus = 'active' | 'paused' | 'blocked' | 'complete' | 'cleared';

export interface GoalEditRecord {
    revision: number;
    previousObjective: string;
    objective: string;
    editedAt: string;
    source: GoalEvent['source'];
}

// 防止同一个 goal 被多个 scheduler turn 重复启动。lease 过期后可重新抢占。
export interface GoalSchedulerLease {
    id: string;
    acquiredAt: string;
    expiresAt: string;
    reason: 'create' | 'resume' | 'hook';
}

// Evaluator 的输出必须带 goalId/revision，Controller 据此丢弃过期评估结果。
export interface GoalEvaluation {
    evaluationId?: string;
    goalId: string;
    goalRevision: number;
    status: 'met' | 'not_met' | 'blocked';
    reason: string;
    evidence: string[];
    nextPrompt?: string;
    evaluatedAt: string;
}

export type GoalEvaluationDisplayStatus = GoalEvaluation['status'] | 'error' | 'superseded' | 'cancelled';

export interface GoalEvaluationRecord {
    evaluationId: string;
    goalId: string;
    goalRevision: number;
    /** Related chat message used by renderers to place the evaluation card in context. */
    anchorMessageId?: string;
    anchorMessageIndex?: number;
    phase: 'start' | 'end';
    status?: GoalEvaluationDisplayStatus;
    message?: string;
    evidence?: string[];
    startedAt: string;
    evaluatedAt?: string;
    updatedAt: string;
}

export type GoalContinuationReason =
    | 'not_met'
    | 'edit'
    | 'crash_recovery'
    | 'load_recovery'
    | 'manual_pause'
    | 'unspecified';

// evaluator/recovery 生成的下一轮内部 prompt；消费后保留 consumed* 字段用于审计。
export interface GoalContinuation {
    id: string;
    goalId: string;
    goalRevision: number;
    prompt: string;
    reason: GoalContinuationReason;
    createdAt: string;
    consumedAt?: string;
    consumedByTurnGeneration?: number;
}

// goal 运行中收到的普通用户输入会先作为 supplement 挂起，在工具边界后注入当前 turn。
export interface GoalSupplement {
    id: string;
    goalId: string;
    goalRevision: number;
    content: string;
    source: GoalEvent['source'];
    createdAt: string;
    consumedAt?: string;
    consumedByTurnGeneration?: number;
}

// 挂在 TaskState 上的持久化 goal 快照。执行循环、runner 中断等运行态只存引用信息，
// 真正的任务执行状态仍由 TaskState.task_status 和 runtimeInterrupt 管理。
export interface GoalState {
    version: 1;
    id: string;
    taskId: string;
    objective: string;
    successCriteria: string[];
    status: GoalStatus;
    revision: number;
    attempts: number;
    // goal 创建时 chat_context 中已累计的 token 总量快照，
    // 用于让每个 goal 独立计量 token 消耗（当前累计 − baseline）
    tokenUsageBaseline?: number;
    startedAt?: string;
    lastEvaluation?: GoalEvaluation;
    evaluationHistory?: GoalEvaluationRecord[];
    pendingContinuation?: GoalContinuation;
    pendingSupplements: GoalSupplement[];
    editHistory: GoalEditRecord[];
    pauseReason?: string;
    blockedReason?: string;
    schedulerLease?: GoalSchedulerLease;
    createdAt: string;
    updatedAt: string;
    pausedAt?: string;
    resumedAt?: string;
    completedAt?: string;
    clearedAt?: string;
}

export interface GoalFinalSnapshot {
    id: string;
    taskId: string;
    goalId: string;
    goalRevision: number;
    objective: string;
    status: Extract<GoalStatus, 'complete' | 'cleared'>;
    lastEvaluation?: GoalEvaluation;
    totalTokens: number;
    elapsedMs: number;
    createdAt: string;
    finalizedAt: string;
    completedAt?: string;
    clearedAt?: string;
    anchorMessageId?: string;
    anchorMessageIndex?: number;
}

// 事件日志用于 UI timeline、调试和审计；payload 可以包含内部细节，渲染层只能拿过滤后的字段。
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
        | 'continuation_superseded'
        | 'supplement_added'
        | 'supplement_consumed'
        | 'blocked'
        | 'completed'
        | 'forked'
        | 'cleared'
        | 'prompt_injection_materialized'
        | 'supplement_materialized'
        | 'display_projected';
    revision: number;
    timestamp: string;
    source: 'tui' | 'chat' | 'gui' | 'api' | 'scheduler' | 'hook' | 'evaluator' | 'user_message' | 'system';
    payload?: Record<string, unknown>;
}

export type GoalEventLogStorage = GoalEventLogInlineStorage | GoalEventLogArtifactStorage;

// 小日志直接内联进 task json，避免额外 artifact 读写。
export interface GoalEventLogInlineStorage {
    mode: 'inline';
    events: GoalEvent[];
}

// 日志超过内联阈值后写入 artifact，task json 只保留最近 tail 供 UI 快速渲染。
export interface GoalEventLogArtifactStorage {
    mode: 'artifact';
    tail: GoalEvent[];
    artifactPath: string;
}

export interface CreateGoalInput {
    objective: string;
    successCriteria?: string[];
    source?: GoalEvent['source'];
}

export interface ResumeGoalOptions {
    source?: GoalEvent['source'];
    promptOverride?: string;
    rawText?: string;
    displayReason?: string;
}

export interface AddGoalSupplementInput {
    content: string;
    source?: GoalEvent['source'];
}

// UI/TUI 可直接消费的安全摘要。这里不暴露原始 event payload，也不暴露 artifactPath。
export interface GoalRenderSummary {
    id: string;
    status: GoalStatus;
    revision: number;
    objective: string;
    pendingContinuation: boolean;
    pendingSupplements?: number;
    updatedAt: string;
    completedAt?: string;
    successCriteria?: string[];
    attempts?: number;
    lastEvaluation?: {
        evaluationId?: string;
        goalId: string;
        goalRevision: number;
        status: GoalEvaluation['status'];
        reason: string;
        evidence?: string[];
        evaluatedAt: string;
    };
    evaluations?: GoalEvaluationRecord[];
    recentEvents?: Array<{
        type: GoalEvent['type'];
        revision: number;
        timestamp: string;
        source: GoalEvent['source'];
        objective?: string;
        previousObjective?: string;
        displayMessageId?: string;
    }>;
    objectiveEvents?: Array<{
        type: GoalEvent['type'];
        revision: number;
        timestamp: string;
        source: GoalEvent['source'];
        objective?: string;
        previousObjective?: string;
        displayMessageId?: string;
    }>;
}

export interface GoalStatusView {
    summary?: GoalRenderSummary;
    lastEvaluationStatus?: GoalEvaluation['status'];
    lastEvaluationAt?: string;
    attempts?: number;
}

// command/service 层共享的返回结构；messageKey 交给各入口按自己的本地化方式展示。
export interface GoalCommandResult {
    ok: boolean;
    status?: GoalStatus;
    messageKey?: string;
    messageArgs?: Record<string, unknown>;
    supplementId?: string;
    startedScheduler?: boolean;
    interruptedRunner?: boolean;
    clearedTaskTodos?: boolean;
    summary?: GoalRenderSummary;
    errorCode?: string;
    conflict?: GoalEditConflict;
}

export type GoalEvaluationApplyResult =
    | { action: 'finish'; status: GoalStatus; evaluationRecord?: GoalEvaluationRecord }
    | {
          action: 'continue';
          continuationPrompt: string;
          continuationId: string;
          evaluationRecord?: GoalEvaluationRecord;
      };

export type GoalMaybeResumeResult = { action: 'none' } | { action: 'resume_with_message'; userMessage: string };

export interface GoalRenderSummaryOptions {
    includeCleared?: boolean;
    terminalRetentionMs?: number;
    includeEvaluationHistory?: boolean;
}

// 运行中 pause/clear/stop 使用的协作式中断标记，由 task loop 负责最终消费并写 handledAt。
export interface TaskRuntimeInterrupt {
    requested: boolean;
    reason: 'goal_pause' | 'goal_clear' | 'user_stop' | 'system_shutdown' | 'failure_recovery';
    requestedAt: string;
    turnGeneration?: number;
    handledAt?: string;
}

// inline limit 控制 task json 大小；supplement 限制防止运行中用户输入无限堆积。
const GOAL_EVENT_LOG_INLINE_LIMIT = 200;
const GOAL_SUPPLEMENT_CONTENT_LIMIT = 4_000;
const GOAL_SUPPLEMENT_PENDING_LIMIT = 20;
const GOAL_EVALUATION_HISTORY_LIMIT = 50;

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

// 下面的 normalize* 只做宽松反序列化：坏字段丢弃或降级，不让旧/损坏数据阻断任务加载。
function normalizeStatus(raw: unknown): GoalStatus | undefined {
    if (raw === 'active' || raw === 'paused' || raw === 'blocked' || raw === 'complete' || raw === 'cleared') {
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

function normalizeEventType(raw: unknown): GoalEvent['type'] {
    if (
        raw === 'created' ||
        raw === 'edited' ||
        raw === 'paused' ||
        raw === 'resumed' ||
        raw === 'evaluated' ||
        raw === 'continuation_created' ||
        raw === 'continuation_consumed' ||
        raw === 'continuation_superseded' ||
        raw === 'supplement_added' ||
        raw === 'supplement_consumed' ||
        raw === 'blocked' ||
        raw === 'completed' ||
        raw === 'forked' ||
        raw === 'cleared' ||
        raw === 'prompt_injection_materialized' ||
        raw === 'supplement_materialized' ||
        raw === 'display_projected'
    ) {
        return raw;
    }
    return 'created';
}

function normalizeStringArray(raw: unknown): string[] {
    return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
}

function normalizeEvaluation(raw: unknown): GoalEvaluation | undefined {
    if (!isObject(raw)) return undefined;
    const status = raw.status;
    if (status !== 'met' && status !== 'not_met' && status !== 'blocked') {
        return undefined;
    }
    if (typeof raw.goalId !== 'string' || typeof raw.goalRevision !== 'number') return undefined;
    return {
        ...(typeof raw.evaluationId === 'string' ? { evaluationId: raw.evaluationId } : {}),
        goalId: raw.goalId,
        goalRevision: raw.goalRevision,
        status,
        reason: typeof raw.reason === 'string' ? raw.reason : '',
        evidence: normalizeStringArray(raw.evidence),
        ...(typeof raw.nextPrompt === 'string' ? { nextPrompt: raw.nextPrompt } : {}),
        evaluatedAt: typeof raw.evaluatedAt === 'string' ? raw.evaluatedAt : isoNow()
    };
}

function normalizeEvaluationDisplayStatus(raw: unknown): GoalEvaluationDisplayStatus | undefined {
    if (
        raw === 'met' ||
        raw === 'not_met' ||
        raw === 'blocked' ||
        raw === 'error' ||
        raw === 'superseded' ||
        raw === 'cancelled'
    ) {
        return raw;
    }
    return undefined;
}

function normalizeEvaluationRecord(raw: unknown): GoalEvaluationRecord | undefined {
    if (!isObject(raw)) return undefined;
    if (typeof raw.goalId !== 'string' || typeof raw.goalRevision !== 'number') return undefined;
    const phase = raw.phase === 'end' ? 'end' : raw.phase === 'start' ? 'start' : undefined;
    if (!phase) return undefined;
    const startedAt =
        typeof raw.startedAt === 'string'
            ? raw.startedAt
            : typeof raw.evaluatedAt === 'string'
              ? raw.evaluatedAt
              : isoNow();
    const evaluatedAt = typeof raw.evaluatedAt === 'string' ? raw.evaluatedAt : undefined;
    const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : (evaluatedAt ?? startedAt);
    const status = normalizeEvaluationDisplayStatus(raw.status);
    return {
        evaluationId: typeof raw.evaluationId === 'string' ? raw.evaluationId : crypto.randomUUID(),
        goalId: raw.goalId,
        goalRevision: raw.goalRevision,
        ...(typeof raw.anchorMessageId === 'string' ? { anchorMessageId: raw.anchorMessageId } : {}),
        ...(typeof raw.anchorMessageIndex === 'number' && Number.isInteger(raw.anchorMessageIndex)
            ? { anchorMessageIndex: raw.anchorMessageIndex }
            : {}),
        phase,
        ...(status ? { status } : {}),
        ...(typeof raw.message === 'string' ? { message: raw.message } : {}),
        ...(Array.isArray(raw.evidence) ? { evidence: normalizeStringArray(raw.evidence) } : {}),
        startedAt,
        ...(evaluatedAt ? { evaluatedAt } : {}),
        updatedAt
    };
}

function normalizeContinuationReason(raw: unknown): GoalContinuationReason {
    if (
        raw === 'not_met' ||
        raw === 'edit' ||
        raw === 'crash_recovery' ||
        raw === 'load_recovery' ||
        raw === 'manual_pause'
    ) {
        return raw;
    }
    return 'unspecified';
}

function evaluationRecordFromEvaluation(evaluation: GoalEvaluation): GoalEvaluationRecord {
    return {
        evaluationId: evaluation.evaluationId ?? crypto.randomUUID(),
        goalId: evaluation.goalId,
        goalRevision: evaluation.goalRevision,
        phase: 'end',
        status: evaluation.status,
        message: evaluation.reason,
        evidence: [...evaluation.evidence],
        startedAt: evaluation.evaluatedAt,
        evaluatedAt: evaluation.evaluatedAt,
        updatedAt: evaluation.evaluatedAt
    };
}

function normalizeEvaluationHistory(raw: unknown, lastEvaluation?: GoalEvaluation): GoalEvaluationRecord[] {
    const records = Array.isArray(raw)
        ? raw.map(normalizeEvaluationRecord).filter((item): item is GoalEvaluationRecord => item !== undefined)
        : [];
    if (records.length === 0 && lastEvaluation) {
        records.push(evaluationRecordFromEvaluation(lastEvaluation));
    }
    return records.slice(-GOAL_EVALUATION_HISTORY_LIMIT);
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
        reason: normalizeContinuationReason(raw.reason),
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : isoNow(),
        ...(typeof raw.consumedAt === 'string' ? { consumedAt: raw.consumedAt } : {}),
        ...(typeof raw.consumedByTurnGeneration === 'number'
            ? { consumedByTurnGeneration: raw.consumedByTurnGeneration }
            : {})
    };
}

function normalizeSupplement(raw: unknown): GoalSupplement | undefined {
    if (!isObject(raw)) return undefined;
    if (
        typeof raw.id !== 'string' ||
        typeof raw.goalId !== 'string' ||
        typeof raw.goalRevision !== 'number' ||
        typeof raw.content !== 'string'
    ) {
        return undefined;
    }
    const content = raw.content.trim().slice(0, GOAL_SUPPLEMENT_CONTENT_LIMIT);
    if (!content) return undefined;
    return {
        id: raw.id,
        goalId: raw.goalId,
        goalRevision: raw.goalRevision,
        content,
        source: normalizeSource(raw.source),
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : isoNow(),
        ...(typeof raw.consumedAt === 'string' ? { consumedAt: raw.consumedAt } : {}),
        ...(typeof raw.consumedByTurnGeneration === 'number'
            ? { consumedByTurnGeneration: raw.consumedByTurnGeneration }
            : {})
    };
}

function normalizeSupplements(raw: unknown): GoalSupplement[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .map(normalizeSupplement)
        .filter((item): item is GoalSupplement => item !== undefined)
        .slice(-GOAL_SUPPLEMENT_PENDING_LIMIT);
}

function normalizeLease(raw: unknown): GoalSchedulerLease | undefined {
    if (!isObject(raw)) return undefined;
    const reason = raw.reason;
    if (reason !== 'create' && reason !== 'resume' && reason !== 'hook') {
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

function normalizeTokenUsageBaseline(raw: unknown): number | undefined {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return undefined;
    return raw;
}

export const GoalStates = {
    // 创建新 goal 只生成状态对象，不启动 runner；启动由 GoalService/GoalScheduler 决定。
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
            startedAt: now,
            evaluationHistory: [],
            pendingSupplements: [],
            editHistory: [],
            createdAt: now,
            updatedAt: now
        };
    },

    // 反序列化要兼容旧 task json，因此缺失字段会补默认值，非法嵌套对象会被忽略。
    deserialize(raw: unknown, taskId?: string): GoalState | undefined {
        if (!isObject(raw)) return undefined;
        const status = normalizeStatus(raw.status);
        if (!status || typeof raw.objective !== 'string') return undefined;
        const id = typeof raw.id === 'string' && raw.id.trim().length > 0 ? raw.id : crypto.randomUUID();
        const now = isoNow();
        const tokenUsageBaseline = normalizeTokenUsageBaseline(raw.tokenUsageBaseline);
        const lastEvaluation = normalizeEvaluation(raw.lastEvaluation);
        const pendingContinuation = normalizeContinuation(raw.pendingContinuation);
        return {
            version: 1,
            id,
            taskId: typeof raw.taskId === 'string' ? raw.taskId : (taskId ?? ''),
            objective: raw.objective,
            successCriteria: normalizeStringArray(raw.successCriteria),
            status,
            revision: typeof raw.revision === 'number' && raw.revision > 0 ? raw.revision : 1,
            attempts: typeof raw.attempts === 'number' && raw.attempts >= 0 ? raw.attempts : 0,
            ...(tokenUsageBaseline !== undefined ? { tokenUsageBaseline } : {}),
            ...(typeof raw.startedAt === 'string' ? { startedAt: raw.startedAt } : {}),
            ...(lastEvaluation ? { lastEvaluation } : {}),
            evaluationHistory: normalizeEvaluationHistory(raw.evaluationHistory, lastEvaluation),
            ...(pendingContinuation ? { pendingContinuation } : {}),
            pendingSupplements: normalizeSupplements(raw.pendingSupplements),
            editHistory: normalizeEditHistory(raw.editHistory),
            ...(typeof raw.pauseReason === 'string' ? { pauseReason: raw.pauseReason } : {}),
            ...(typeof raw.blockedReason === 'string' ? { blockedReason: raw.blockedReason } : {}),
            ...(normalizeLease(raw.schedulerLease) ? { schedulerLease: normalizeLease(raw.schedulerLease) } : {}),
            createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
            updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
            ...(typeof raw.pausedAt === 'string' ? { pausedAt: raw.pausedAt } : {}),
            ...(typeof raw.resumedAt === 'string' ? { resumedAt: raw.resumedAt } : {}),
            ...(typeof raw.completedAt === 'string' ? { completedAt: raw.completedAt } : {}),
            ...(typeof raw.clearedAt === 'string' ? { clearedAt: raw.clearedAt } : {})
        };
    },

    // 对外返回深拷贝，避免 UI/API 层无意修改 TaskState 上的持久化对象。
    serialize(state?: GoalState): GoalState | undefined {
        return state ? cloneJson(state) : undefined;
    },

    clone(state: GoalState): GoalState {
        return cloneJson(state);
    },

    // terminal/unfinished 的划分用于决定是否允许创建新 goal，以及 fork/load 时如何恢复。
    isTerminal(status?: GoalStatus): boolean {
        return status === 'complete' || status === 'cleared';
    },

    isUnfinished(status?: GoalStatus): boolean {
        return status === 'active' || status === 'paused' || status === 'blocked';
    },

    renderSummary(
        state?: GoalState,
        events?: GoalEventLogStorage,
        options: GoalRenderSummaryOptions = {}
    ): GoalRenderSummary | undefined {
        if (!state) return undefined;
        // cleared 默认不展示；complete/cleared 可按 terminalRetentionMs 做短暂保留。
        if (state.status === 'cleared' && options.includeCleared !== true) return undefined;
        if (typeof options.terminalRetentionMs === 'number' && GoalStates.isTerminal(state.status)) {
            const terminalAt = state.status === 'complete' ? state.completedAt : state.clearedAt;
            const terminalTime = terminalAt ? Date.parse(terminalAt) : Number.NaN;
            if (!Number.isNaN(terminalTime) && Date.now() - terminalTime > options.terminalRetentionMs) {
                return undefined;
            }
        }
        const tailEvents = events ? getGoalEventTail(events).filter((event) => event.goalId === state.id) : [];
        const displayMessageIdsByEventId = new Map<string, string>();
        const displayMessageIdsByRevisionType = new Map<string, string>();
        for (const event of tailEvents) {
            if (event.type !== 'display_projected' || !isObject(event.payload)) continue;
            const displayMessageId =
                typeof event.payload.displayMessageId === 'string' ? event.payload.displayMessageId : undefined;
            const targetEventId =
                typeof event.payload.targetEventId === 'string' ? event.payload.targetEventId : undefined;
            const targetEventType =
                event.payload.targetEventType === 'created' || event.payload.targetEventType === 'edited'
                    ? event.payload.targetEventType
                    : undefined;
            const targetRevision =
                typeof event.payload.targetRevision === 'number' ? event.payload.targetRevision : event.revision;
            if (!displayMessageId) continue;
            if (targetEventId) {
                displayMessageIdsByEventId.set(targetEventId, displayMessageId);
            }
            if (targetEventType) {
                displayMessageIdsByRevisionType.set(`${targetEventType}:${targetRevision}`, displayMessageId);
            }
        }
        const internalTimelineEventTypes = new Set<GoalEvent['type']>([
            'display_projected',
            'prompt_injection_materialized',
            'supplement_materialized'
        ]);
        const renderableEvents = tailEvents.filter((event) => !internalTimelineEventTypes.has(event.type));
        const toRenderEvent = (event: GoalEvent) => {
            const base = {
                type: event.type,
                revision: event.revision,
                timestamp: event.timestamp,
                source: event.source
            };
            const payload = event.payload;
            const objective =
                isObject(payload) && typeof payload.objective === 'string' ? payload.objective : undefined;
            const previousObjective =
                isObject(payload) && typeof payload.previousObjective === 'string'
                    ? payload.previousObjective
                    : undefined;
            const inlineDisplayMessageId =
                isObject(payload) && typeof payload.displayMessageId === 'string'
                    ? payload.displayMessageId
                    : undefined;
            const displayMessageId =
                inlineDisplayMessageId ??
                displayMessageIdsByEventId.get(event.id) ??
                displayMessageIdsByRevisionType.get(`${event.type}:${event.revision}`);
            if (objective === undefined && previousObjective === undefined && displayMessageId === undefined) {
                return base;
            }
            return {
                ...base,
                ...(objective !== undefined ? { objective } : {}),
                ...(previousObjective !== undefined ? { previousObjective } : {}),
                ...(displayMessageId !== undefined ? { displayMessageId } : {})
            };
        };
        const hasTimelineDetails = (event: GoalEvent): boolean => {
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
            pendingSupplements: state.pendingSupplements.filter((supplement) => !supplement.consumedAt).length,
            updatedAt: state.updatedAt,
            ...(state.completedAt ? { completedAt: state.completedAt } : {}),
            successCriteria: [...state.successCriteria],
            attempts: state.attempts,
            ...(state.lastEvaluation
                ? {
                      lastEvaluation: {
                          ...(state.lastEvaluation.evaluationId
                              ? { evaluationId: state.lastEvaluation.evaluationId }
                              : {}),
                          goalId: state.lastEvaluation.goalId,
                          goalRevision: state.lastEvaluation.goalRevision,
                          status: state.lastEvaluation.status,
                          reason: state.lastEvaluation.reason,
                          evidence: [...state.lastEvaluation.evidence],
                          evaluatedAt: state.lastEvaluation.evaluatedAt
                      }
                  }
                : {}),
            ...(options.includeEvaluationHistory === false
                ? {}
                : {
                      evaluations: (state.evaluationHistory ?? [])
                          .slice(-GOAL_EVALUATION_HISTORY_LIMIT)
                          .map((evaluation) => ({
                              ...evaluation,
                              ...(evaluation.evidence ? { evidence: [...evaluation.evidence] } : {})
                          }))
                  }),
            ...(events
                ? {
                      recentEvents: renderableEvents.slice(-8).map(toRenderEvent),
                      objectiveEvents: renderableEvents.filter(hasTimelineDetails).slice(-8).map(toRenderEvent)
                  }
                : {})
        };
    },

    // statusView 是 Controller 暴露给入口层的稳定读模型，避免各 UI 自己拼 state/event。
    statusView(state?: GoalState, events?: GoalEventLogStorage): GoalStatusView {
        const summary = GoalStates.renderSummary(state, events);
        if (!state || !summary) return {};
        return {
            summary,
            lastEvaluationStatus: state.lastEvaluation?.status,
            lastEvaluationAt: state.lastEvaluation?.evaluatedAt,
            attempts: state.attempts
        };
    },

    // continuation 与 supplement 都绑定 goal revision，后续消费时可识别过期上下文。
    createContinuation(goal: GoalState, prompt: string, reason: GoalContinuationReason): GoalContinuation {
        return {
            id: crypto.randomUUID(),
            goalId: goal.id,
            goalRevision: goal.revision,
            prompt,
            reason,
            createdAt: isoNow()
        };
    },

    createSupplement(goal: GoalState, input: AddGoalSupplementInput): GoalSupplement {
        return {
            id: crypto.randomUUID(),
            goalId: goal.id,
            goalRevision: goal.revision,
            content: input.content.trim().slice(0, GOAL_SUPPLEMENT_CONTENT_LIMIT),
            source: input.source ?? 'api',
            createdAt: isoNow()
        };
    },

    recordEvaluationStart(
        goal: GoalState,
        evaluationId: string = crypto.randomUUID(),
        startedAt: string = isoNow(),
        anchor?: Pick<GoalEvaluationRecord, 'anchorMessageId' | 'anchorMessageIndex'>
    ) {
        const record: GoalEvaluationRecord = {
            evaluationId,
            goalId: goal.id,
            goalRevision: goal.revision,
            ...(anchor?.anchorMessageId ? { anchorMessageId: anchor.anchorMessageId } : {}),
            ...(typeof anchor?.anchorMessageIndex === 'number'
                ? { anchorMessageIndex: anchor.anchorMessageIndex }
                : {}),
            phase: 'start',
            startedAt,
            updatedAt: startedAt
        };
        goal.evaluationHistory = GoalStates.upsertEvaluationRecord(goal.evaluationHistory, record);
        goal.updatedAt = startedAt;
        return record;
    },

    recordEvaluationEnd(
        goal: GoalState,
        input: {
            evaluationId: string;
            status: GoalEvaluationDisplayStatus;
            message?: string;
            evidence?: string[];
            evaluatedAt?: string;
            anchor?: Pick<GoalEvaluationRecord, 'anchorMessageId' | 'anchorMessageIndex'>;
        }
    ) {
        const evaluatedAt = input.evaluatedAt ?? isoNow();
        const existing = (goal.evaluationHistory ?? []).find((item) => item.evaluationId === input.evaluationId);
        const anchorMessageId = input.anchor?.anchorMessageId ?? existing?.anchorMessageId;
        const anchorMessageIndex = input.anchor?.anchorMessageIndex ?? existing?.anchorMessageIndex;
        const record: GoalEvaluationRecord = {
            evaluationId: input.evaluationId,
            goalId: existing?.goalId ?? goal.id,
            goalRevision: existing?.goalRevision ?? goal.revision,
            ...(anchorMessageId ? { anchorMessageId } : {}),
            ...(typeof anchorMessageIndex === 'number' ? { anchorMessageIndex } : {}),
            phase: 'end',
            status: input.status,
            ...(input.message !== undefined ? { message: input.message } : {}),
            ...(input.evidence ? { evidence: [...input.evidence] } : {}),
            startedAt: existing?.startedAt ?? evaluatedAt,
            evaluatedAt,
            updatedAt: evaluatedAt
        };
        goal.evaluationHistory = GoalStates.upsertEvaluationRecord(goal.evaluationHistory, record);
        goal.updatedAt = evaluatedAt;
        return record;
    },

    upsertEvaluationRecord(records: GoalEvaluationRecord[] | undefined, record: GoalEvaluationRecord) {
        const next = (records ?? []).filter((item) => item.evaluationId !== record.evaluationId);
        next.push({
            ...record,
            ...(record.evidence ? { evidence: [...record.evidence] } : {})
        });
        return next.slice(-GOAL_EVALUATION_HISTORY_LIMIT);
    },

    limitPendingSupplements(supplements: GoalSupplement[]): GoalSupplement[] {
        return supplements.slice(-GOAL_SUPPLEMENT_PENDING_LIMIT);
    },

    isLeaseValid(lease: GoalSchedulerLease | undefined, at: Date = new Date()): boolean {
        if (!lease) return false;
        const expiresAt = Date.parse(lease.expiresAt);
        return Number.isFinite(expiresAt) && expiresAt > at.getTime();
    }
};

export const GoalEvents = {
    // 事件反序列化比 state 更宽松；单条坏 payload 不应导致整条 timeline 不可用。
    deserializeEvents(raw: unknown): GoalEvent[] {
        if (!Array.isArray(raw)) return [];
        return raw.filter(isObject).map((event) => ({
            id: typeof event.id === 'string' ? event.id : crypto.randomUUID(),
            goalId: typeof event.goalId === 'string' ? event.goalId : '',
            taskId: typeof event.taskId === 'string' ? event.taskId : '',
            type: normalizeEventType(event.type),
            revision: typeof event.revision === 'number' ? event.revision : 1,
            timestamp: typeof event.timestamp === 'string' ? event.timestamp : isoNow(),
            source: normalizeSource(event.source),
            ...(isObject(event.payload) ? { payload: event.payload } : {})
        }));
    },

    // 兼容早期数组形态，也支持当前 inline/artifact 两种存储形态。
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
            // 进入 artifact 模式后只追加新事件，避免每次 append 都重写完整 jsonl。
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

// 错误摘要会进入 goal blocked reason 相关上下文，压平成短文本避免污染 prompt/UI。
export function sanitizeErrorSummary(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return raw.replace(/\s+/g, ' ').slice(0, 500);
}
