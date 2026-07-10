import type { TaskState } from '../states/tasks.js';
import { getGoalElapsedMs } from '../../../common/goal/format.js';
import type { GoalCommandSnapshotLike, GoalEditConflict, GoalEditIfMatch } from '../../../common/goal-command.js';
import {
    GoalEvents,
    GoalStates,
    createGoalEvent,
    sanitizeErrorSummary,
    type AddGoalSupplementInput,
    type CreateGoalInput,
    type GoalCommandResult,
    type GoalContinuation,
    type GoalContinuationReason,
    type GoalEvaluation,
    type GoalEvaluationApplyResult,
    type GoalEvent,
    type GoalFinalSnapshot,
    type GoalMaybeResumeResult,
    type GoalRenderSummary,
    type GoalState,
    type GoalStatusView,
    type GoalSupplement,
    type ResumeGoalOptions
} from './state.js';
import { createUserGoalDataBlock } from './prompt-data.js';

function nowIso(): string {
    return new Date().toISOString();
}

function summary(task: TaskState): GoalRenderSummary | undefined {
    return GoalStates.renderSummary(task.goal_state, task.goal_event_log);
}

export interface GoalObjectiveEditOptions {
    ifMatch?: GoalEditIfMatch;
}

function goalCommandSnapshot(goal: GoalState): GoalCommandSnapshotLike {
    return {
        id: goal.id,
        revision: goal.revision,
        status: goal.status,
        objective: goal.objective
    };
}

function getGoalEditConflict(goal: GoalState | undefined, expected: GoalEditIfMatch): GoalEditConflict | undefined {
    if (!goal) {
        return { reason: 'goal_missing', expected };
    }
    const current = goalCommandSnapshot(goal);
    if (goal.id !== expected.id) {
        return { reason: 'goal_replaced', expected, current };
    }
    if (goal.revision !== expected.revision) {
        return { reason: 'revision_changed', expected, current };
    }
    if (goal.status !== expected.status) {
        return { reason: 'status_changed', expected, current };
    }
    return undefined;
}

function shouldDeriveTaskNameFromGoal(task: TaskState): boolean {
    const name = task.task_name?.trim();
    return !name || name === '未命名任务' || name === 'Unnamed Task';
}

function deriveTaskNameFromGoalObjective(objective: string): string {
    const compact = objective.replace(/\s+/g, ' ').trim();
    return compact.length > 60 ? `${compact.slice(0, 57).trimEnd()}...` : compact;
}

function appendEvent(
    task: TaskState,
    goal: GoalState,
    type: GoalEvent['type'],
    source: GoalEvent['source'],
    payload?: Record<string, unknown>
) {
    GoalEvents.appendToTask(task, createGoalEvent(goal, type, source, payload));
}

function persistGoalChange(task: TaskState): void {
    task.persistLater();
    task.task_manager_state.publishTaskListUpdate();
}

function normalizeGoalTerminalTimestamp(goal: GoalState, candidate?: string): string {
    const now = nowIso();
    const startedAt = Date.parse(goal.createdAt);
    const candidateAt = typeof candidate === 'string' ? Date.parse(candidate) : NaN;
    if (!Number.isFinite(candidateAt)) {
        return now;
    }
    if (Number.isFinite(startedAt) && candidateAt < startedAt) {
        return now;
    }
    return candidate!;
}

function getGoalFinalSnapshotAnchor(
    task: TaskState,
    goal: GoalState
): Pick<GoalFinalSnapshot, 'anchorMessageId' | 'anchorMessageIndex'> {
    const records = goal.evaluationHistory ?? [];
    for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index];
        if (
            record.phase === 'end' &&
            record.goalId === goal.id &&
            record.goalRevision === goal.revision &&
            record.anchorMessageId
        ) {
            return {
                anchorMessageId: record.anchorMessageId,
                ...(typeof record.anchorMessageIndex === 'number'
                    ? { anchorMessageIndex: record.anchorMessageIndex }
                    : {})
            };
        }
    }

    const messages = Array.isArray(task.chat_context?.messages) ? task.chat_context.messages : [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index] as { message_id?: unknown } | undefined;
        if (typeof message?.message_id === 'string' && message.message_id.length > 0) {
            return { anchorMessageId: message.message_id, anchorMessageIndex: index };
        }
    }
    return {};
}

function upsertGoalFinalSnapshot(task: TaskState, goal: GoalState): GoalFinalSnapshot | undefined {
    if (goal.status !== 'complete' && goal.status !== 'cleared') return undefined;
    const finalizedAt =
        goal.status === 'complete' ? (goal.completedAt ?? goal.updatedAt) : (goal.clearedAt ?? goal.updatedAt);
    const snapshot: GoalFinalSnapshot = {
        id: `goal-final:${goal.id}`,
        taskId: task.task_id,
        goalId: goal.id,
        goalRevision: goal.revision,
        objective: goal.objective,
        status: goal.status,
        ...(goal.lastEvaluation
            ? {
                  lastEvaluation: {
                      ...goal.lastEvaluation,
                      evidence: [...goal.lastEvaluation.evidence]
                  }
              }
            : {}),
        totalTokens: computeGoalTokenUsage(task, goal),
        elapsedMs: getGoalElapsedMs(goal),
        createdAt: goal.createdAt,
        finalizedAt,
        ...(goal.completedAt ? { completedAt: goal.completedAt } : {}),
        ...(goal.clearedAt ? { clearedAt: goal.clearedAt } : {}),
        ...getGoalFinalSnapshotAnchor(task, goal)
    };
    const existing = Array.isArray(task.goal_final_snapshots) ? task.goal_final_snapshots : [];
    task.goal_final_snapshots = [...existing.filter((item) => item.goalId !== goal.id), snapshot];
    return snapshot;
}

const USER_RESUMABLE_BLOCKED_REASONS = new Set([
    'needs_user_input',
    'needs_credentials',
    'needs_permission',
    'needs_external_state',
    'user_input_required',
    'credentials_required',
    'permission_required',
    'external_state_required'
]);

function isUserResolvableBlockedReason(reason: string | undefined): boolean {
    if (!reason) return false;
    const normalized = reason.trim().toLowerCase();
    return (
        USER_RESUMABLE_BLOCKED_REASONS.has(normalized) ||
        normalized.startsWith('needs_user_') ||
        normalized.startsWith('requires_user_')
    );
}

function ensureExistingGoal(task: TaskState): GoalState | undefined {
    const goal = task.goal_state;
    if (!goal || goal.status === 'cleared') return undefined;
    return goal;
}

function createContinuation(goal: GoalState, prompt: string, reason: GoalContinuationReason): GoalContinuation {
    return GoalStates.createContinuation(goal, prompt, reason);
}

function defaultContinuationPrompt(goal: GoalState, reason: string): string {
    return [
        '<system-reminder>',
        reason,
        '',
        ...createUserGoalDataBlock('Goal data:', {
            objective: goal.objective,
            successCriteria: goal.successCriteria
        }),
        '',
        '请根据当前 transcript、文件状态和 goal state 继续推进。',
        '</system-reminder>'
    ].join('\n');
}

/** 累计 chat_context 中所有 assistant 消息的 token 用量。 */
function computeTotalTokenUsage(task: TaskState): number {
    let total = 0;
    for (const msg of task.chat_context.messages) {
        if ((msg as any).role === 'assistant' && (msg as any).usage?.total_tokens) {
            total += (msg as any).usage.total_tokens;
        }
    }
    return total;
}

/**
 * 计算当前 goal 生命周期内新增的 token 消耗。
 * 以 goal 创建时快照的 tokenUsageBaseline 为基准，统计增量；
 * compaction 等导致累计回退时，Math.max(0, ...) 兜底为 0。
 * 旧数据无 baseline 时退化为全量统计（保持向后兼容）。
 */
function computeGoalTokenUsage(task: TaskState, goal: GoalState): number {
    const total = computeTotalTokenUsage(task);
    const baseline = goal.tokenUsageBaseline ?? 0;
    return Math.max(0, total - baseline);
}

function resetCompletedGoalTurnCounters(goal: GoalState): void {
    const completedAt = goal.completedAt ?? nowIso();
    goal.attempts = 0;
    goal.startedAt = completedAt;
}

export interface GoalPausedOrBlockedSnapshot {
    status: 'paused' | 'blocked';
    pauseReason?: string;
    blockedReason?: string;
    pausedAt?: string;
    resumedAt?: string;
}

/**
 * 计算当前 task 的总 token 用量（所有 assistant 消息的 usage.total_tokens 之和）。
 * 供 toRenderJSON 等需要实时 token 数据的场景使用。
 */
export function getTotalTokenUsage(task: TaskState): number {
    return computeTotalTokenUsage(task);
}

/**
 * 计算 goal 生命周期内新增的 token 消耗（实时值）。
 * 供 toRenderJSON 等需要实时 token 数据的场景使用。
 */
export function getGoalTokenUsage(task: TaskState): number {
    const goal = task.goal_state;
    if (!goal) return 0;
    return computeGoalTokenUsage(task, goal);
}

export class GoalController {
    static getStatus(task: TaskState): GoalStatusView {
        return GoalStates.statusView(task.goal_state, task.goal_event_log);
    }

    static create(task: TaskState, input: CreateGoalInput): GoalCommandResult {
        const objective = input.objective.trim();
        if (!objective) {
            return { ok: false, messageKey: 'goal.help', errorCode: 'empty_objective' };
        }

        const current = task.goal_state;
        if (current && !GoalStates.isTerminal(current.status)) {
            return {
                ok: false,
                status: current.status,
                messageKey: 'goal.create.exists',
                summary: summary(task),
                errorCode: 'goal_exists'
            };
        }

        const goal = GoalStates.create(task.task_id, { ...input, objective });
        // 快照创建时 chat_context 已累计的 token 总量，作为本 goal 独立计量的基准线。
        goal.tokenUsageBaseline = computeTotalTokenUsage(task);
        task.goal_state = goal;
        if (shouldDeriveTaskNameFromGoal(task)) {
            task.task_name = deriveTaskNameFromGoalObjective(objective);
        }
        const source = input.source ?? 'api';
        appendEvent(task, goal, 'created', source, {
            objective
        });
        persistGoalChange(task);
        return { ok: true, status: goal.status, summary: summary(task) };
    }

    static editObjective(
        task: TaskState,
        objective: string,
        source: GoalEvent['source'] = 'api',
        options: GoalObjectiveEditOptions = {}
    ): GoalCommandResult {
        const trimmed = objective.trim();
        if (!trimmed) {
            return { ok: false, messageKey: 'goal.help', errorCode: 'empty_objective' };
        }

        const goal = ensureExistingGoal(task);
        if (options.ifMatch) {
            const conflict = getGoalEditConflict(goal, options.ifMatch);
            if (conflict) {
                return {
                    ok: false,
                    status: goal?.status,
                    messageKey: 'goal.edit.conflict',
                    messageArgs: { reason: conflict.reason },
                    summary: summary(task),
                    errorCode: 'goal_conflict',
                    conflict
                };
            }
        }
        if (!goal) {
            return { ok: false, messageKey: 'goal.error.none', errorCode: 'no_goal' };
        }

        const previousObjective = goal.objective;
        const objectiveChanged = previousObjective !== trimmed;

        if (!objectiveChanged) {
            return { ok: true, status: goal.status, summary: summary(task) };
        }

        const editedAt = nowIso();
        goal.revision += 1;
        goal.objective = trimmed;
        goal.updatedAt = editedAt;
        goal.lastEvaluation = undefined;
        // 清理已结束的旧 revision 评估记录，防止 GUI 显示过期评估。
        // 注意：in-flight（phase === 'start'）的记录必须保留，否则后续 finishGoalEvaluation
        // 找不到 start record，会以当前 revision 创建 end record，污染评估历史。
        goal.evaluationHistory = (goal.evaluationHistory ?? []).filter((record) =>
            record.phase === 'end' ? record.goalRevision === goal.revision : true
        );
        goal.pendingContinuation =
            goal.status === 'active'
                ? createContinuation(
                      goal,
                      defaultContinuationPrompt(
                          goal,
                          '当前 goal objective 已被用户修改，请按新的 objective 继续推进。'
                      ),
                      'edit'
                  )
                : undefined;
        goal.schedulerLease = undefined;
        goal.editHistory.push({
            revision: goal.revision,
            previousObjective,
            objective: trimmed,
            editedAt,
            source
        });
        appendEvent(task, goal, 'edited', source, {
            previousObjective,
            objective: trimmed
        });
        persistGoalChange(task);
        return { ok: true, status: goal.status, summary: summary(task) };
    }

    static consumePendingEditContinuation(task: TaskState, goalId: string, goalRevision: number): void {
        const goal = task.goal_state;
        if (
            !goal ||
            goal.id !== goalId ||
            goal.revision !== goalRevision ||
            goal.pendingContinuation?.reason !== 'edit' ||
            goal.pendingContinuation.goalRevision !== goalRevision ||
            goal.pendingContinuation.consumedAt
        ) {
            return;
        }
        goal.pendingContinuation = undefined;
        goal.updatedAt = nowIso();
        persistGoalChange(task);
    }

    static addSupplement(task: TaskState, input: AddGoalSupplementInput): GoalCommandResult {
        const content = input.content.trim();
        if (!content) {
            return { ok: false, messageKey: 'goal.supplement.empty', errorCode: 'empty_supplement' };
        }

        const goal = ensureExistingGoal(task);
        if (!goal) {
            return { ok: false, messageKey: 'goal.error.none', errorCode: 'no_goal' };
        }
        if (!GoalStates.isUnfinished(goal.status)) {
            return {
                ok: false,
                status: goal.status,
                messageKey: 'goal.supplement.inactive',
                messageArgs: { status: goal.status },
                errorCode: 'inactive_goal'
            };
        }

        const supplement = GoalStates.createSupplement(goal, input);
        goal.pendingSupplements = GoalStates.limitPendingSupplements([...goal.pendingSupplements, supplement]);
        goal.updatedAt = supplement.createdAt;
        appendEvent(task, goal, 'supplement_added', supplement.source, {
            supplementId: supplement.id,
            contentLength: supplement.content.length,
            goalRevision: supplement.goalRevision
        });
        persistGoalChange(task);
        return {
            ok: true,
            status: goal.status,
            messageKey: 'goal.supplement.added',
            supplementId: supplement.id,
            summary: summary(task)
        };
    }

    static consumePendingSupplements(task: TaskState, turnGeneration: number): GoalSupplement[] {
        const goal = task.goal_state;
        if (!goal || goal.status !== 'active') return [];
        const pending = goal.pendingSupplements.filter((supplement) => !supplement.consumedAt);
        if (pending.length === 0) return [];

        const consumedAt = nowIso();
        const consumedIds = new Set(pending.map((supplement) => supplement.id));
        goal.pendingSupplements = goal.pendingSupplements.filter((supplement) => !consumedIds.has(supplement.id));
        if (
            goal.pendingContinuation &&
            !goal.pendingContinuation.consumedAt &&
            goal.pendingContinuation.reason === 'not_met'
        ) {
            const continuation = goal.pendingContinuation;
            goal.pendingContinuation = undefined;
            appendEvent(task, goal, 'continuation_superseded', 'user_message', {
                continuationId: continuation.id,
                reason: continuation.reason,
                supersededBy: 'goal_supplement',
                supplementIds: [...consumedIds]
            });
        }
        goal.updatedAt = consumedAt;

        for (const supplement of pending) {
            appendEvent(task, goal, 'supplement_consumed', supplement.source, {
                supplementId: supplement.id,
                contentLength: supplement.content.length,
                goalRevision: supplement.goalRevision,
                consumedByTurnGeneration: turnGeneration
            });
        }
        persistGoalChange(task);
        return pending.map((supplement) => ({
            ...supplement,
            consumedAt,
            consumedByTurnGeneration: turnGeneration
        }));
    }

    static pause(task: TaskState, source: GoalEvent['source'] = 'api', reason?: string): GoalCommandResult {
        const goal = ensureExistingGoal(task);
        if (!goal) {
            return { ok: false, messageKey: 'goal.error.none', errorCode: 'no_goal' };
        }
        if (goal.status === 'complete') {
            return { ok: false, status: goal.status, messageKey: 'goal.pause.complete', errorCode: 'goal_complete' };
        }

        const at = nowIso();
        goal.status = 'paused';
        const normalizedReason = reason?.trim();
        goal.pauseReason = normalizedReason || undefined;
        goal.pausedAt = at;
        goal.updatedAt = at;
        goal.schedulerLease = undefined;
        appendEvent(task, goal, 'paused', source, normalizedReason ? { reason: normalizedReason } : undefined);
        persistGoalChange(task);
        return { ok: true, status: goal.status, summary: summary(task) };
    }

    static resumeStateOnly(task: TaskState, options: ResumeGoalOptions = {}): GoalCommandResult {
        const goal = ensureExistingGoal(task);
        if (!goal) {
            return { ok: false, messageKey: 'goal.error.none', errorCode: 'no_goal' };
        }

        if (goal.status !== 'paused' && goal.status !== 'blocked') {
            return {
                ok: false,
                status: goal.status,
                messageKey: 'goal.resume.invalid_status',
                messageArgs: { status: goal.status },
                errorCode: 'invalid_status'
            };
        }

        const at = nowIso();
        goal.status = 'active';
        goal.pauseReason = undefined;
        goal.blockedReason = undefined;
        goal.resumedAt = at;
        goal.updatedAt = at;
        goal.schedulerLease = undefined;
        appendEvent(task, goal, 'resumed', options.source ?? 'api');
        persistGoalChange(task);
        return { ok: true, status: goal.status, summary: summary(task) };
    }

    static restorePausedOrBlockedAfterSchedulerFailure(
        task: TaskState,
        previous: GoalPausedOrBlockedSnapshot,
        failure: GoalCommandResult
    ): GoalCommandResult {
        const goal = ensureExistingGoal(task);
        if (!goal || goal.status !== 'active') {
            return { ...failure, summary: summary(task) };
        }

        const at = nowIso();
        goal.status = previous.status;
        goal.pauseReason = previous.pauseReason;
        goal.blockedReason = previous.blockedReason;
        goal.pausedAt = previous.pausedAt;
        goal.resumedAt = previous.resumedAt;
        goal.schedulerLease = undefined;
        goal.updatedAt = at;
        appendEvent(task, goal, previous.status === 'blocked' ? 'blocked' : 'paused', 'system', {
            reason: 'scheduler_start_failed',
            errorCode: failure.errorCode ?? 'unknown'
        });
        persistGoalChange(task);
        return { ...failure, status: goal.status, summary: summary(task) };
    }

    static clear(task: TaskState, source: GoalEvent['source'] = 'api'): GoalCommandResult {
        const goal = ensureExistingGoal(task);
        if (!goal) {
            return { ok: true, status: 'cleared', messageKey: 'goal.clear.none' };
        }
        const at = nowIso();
        goal.status = 'cleared';
        task.clearPendingGoalEditReminders();
        goal.pendingContinuation = undefined;
        goal.pendingSupplements = [];
        goal.schedulerLease = undefined;
        goal.clearedAt = at;
        goal.updatedAt = at;
        appendEvent(task, goal, 'cleared', source);
        upsertGoalFinalSnapshot(task, goal);
        persistGoalChange(task);
        return {
            ok: true,
            status: goal.status,
            summary: GoalStates.renderSummary(task.goal_state, task.goal_event_log, { includeCleared: true })
        };
    }

    static recordEvaluation(task: TaskState, evaluation: GoalEvaluation): GoalEvaluationApplyResult {
        const goal = task.goal_state;
        if (
            !goal ||
            goal.id !== evaluation.goalId ||
            goal.revision !== evaluation.goalRevision ||
            goal.status !== 'active'
        ) {
            return { action: 'finish', status: goal?.status ?? 'cleared' };
        }

        const evaluationId = evaluation.evaluationId ?? crypto.randomUUID();
        evaluation.evaluationId = evaluationId;
        goal.lastEvaluation = evaluation;
        const evaluationRecord = GoalStates.recordEvaluationEnd(goal, {
            evaluationId,
            status: evaluation.status,
            message: evaluation.reason,
            evidence: evaluation.evidence,
            evaluatedAt: evaluation.evaluatedAt
        });
        appendEvent(task, goal, 'evaluated', 'evaluator', {
            evaluationId,
            status: evaluation.status,
            reason: evaluation.reason,
            evidenceCount: evaluation.evidence.length
        });

        if (evaluation.status === 'met') {
            goal.status = 'complete';
            goal.completedAt = normalizeGoalTerminalTimestamp(goal, evaluation.evaluatedAt);
            goal.pendingContinuation = undefined;
            goal.pendingSupplements = [];
            goal.schedulerLease = undefined;
            resetCompletedGoalTurnCounters(goal);
            appendEvent(task, goal, 'completed', 'evaluator', { reason: evaluation.reason });
            upsertGoalFinalSnapshot(task, goal);
            persistGoalChange(task);
            return { action: 'finish', status: goal.status, evaluationRecord };
        }

        if (evaluation.status === 'blocked') {
            goal.status = 'blocked';
            goal.blockedReason = evaluation.reason || 'goal_blocked';
            goal.schedulerLease = undefined;
            appendEvent(task, goal, 'blocked', 'evaluator', { reason: goal.blockedReason });
            persistGoalChange(task);
            return { action: 'finish', status: goal.status, evaluationRecord };
        }

        const continuationPrompt =
            evaluation.nextPrompt ||
            defaultContinuationPrompt(goal, 'Goal evaluator 判断当前 goal 尚未完成，请继续推进。');

        goal.attempts += 1;

        goal.pendingContinuation = createContinuation(goal, continuationPrompt, 'not_met');
        appendEvent(task, goal, 'continuation_created', 'evaluator', { continuationId: goal.pendingContinuation.id });
        persistGoalChange(task);
        return {
            action: 'continue',
            continuationPrompt,
            continuationId: goal.pendingContinuation.id,
            evaluationRecord
        };
    }

    static recordEvaluatorFailure(
        task: TaskState,
        staleGoal: GoalState,
        error: unknown,
        evaluationId: string = crypto.randomUUID(),
        evaluatedAt: string = nowIso()
    ): GoalEvaluationApplyResult {
        const goal = task.goal_state;
        if (!goal || goal.id !== staleGoal.id || goal.revision !== staleGoal.revision || goal.status !== 'active') {
            return { action: 'finish', status: goal?.status ?? 'cleared' };
        }

        const reason = `goal_evaluator_failed: ${sanitizeErrorSummary(error)}`;
        const evidence = ['Evaluator failed before producing a valid structured result'];
        goal.status = 'blocked';
        goal.blockedReason = 'goal_evaluator_failed';
        goal.schedulerLease = undefined;
        goal.lastEvaluation = {
            evaluationId,
            goalId: goal.id,
            goalRevision: goal.revision,
            status: 'blocked',
            reason,
            evidence,
            evaluatedAt
        };
        const evaluationRecord = GoalStates.recordEvaluationEnd(goal, {
            evaluationId,
            status: 'error',
            message: reason,
            evidence,
            evaluatedAt
        });
        goal.updatedAt = goal.lastEvaluation.evaluatedAt;
        appendEvent(task, goal, 'evaluated', 'evaluator', {
            evaluationId,
            status: 'blocked',
            reason,
            evaluatorFailure: true
        });
        appendEvent(task, goal, 'blocked', 'evaluator', { reason: goal.blockedReason });
        persistGoalChange(task);
        return { action: 'finish', status: goal.status, evaluationRecord };
    }

    static maybeResumeGoalFromUserMessage(task: TaskState, message: string): GoalMaybeResumeResult {
        const goal = task.goal_state;
        if (!goal || goal.status !== 'blocked') {
            return { action: 'none' };
        }
        if (!isUserResolvableBlockedReason(goal.blockedReason)) {
            return { action: 'none' };
        }
        const trimmed = message.trim();
        if (!trimmed) {
            return { action: 'none' };
        }
        return { action: 'resume_with_message', userMessage: trimmed };
    }

    static blockForHistoryMutation(task: TaskState, source: GoalEvent['source'] = 'system'): void {
        const goal = task.goal_state;
        if (!goal || !GoalStates.isUnfinished(goal.status)) return;
        const at = nowIso();
        goal.status = 'blocked';
        goal.blockedReason = 'history_rewound_requires_goal_review';
        goal.pendingContinuation = undefined;
        goal.schedulerLease = undefined;
        goal.updatedAt = at;
        appendEvent(task, goal, 'blocked', source, { reason: goal.blockedReason });
        persistGoalChange(task);
    }

    static blockActiveGoal(task: TaskState, reason: string, source: GoalEvent['source'] = 'system'): void {
        const goal = task.goal_state;
        if (!goal || goal.status !== 'active') return;
        const at = nowIso();
        goal.status = 'blocked';
        goal.blockedReason = reason;
        goal.pendingContinuation = undefined;
        goal.schedulerLease = undefined;
        goal.updatedAt = at;
        appendEvent(task, goal, 'blocked', source, { reason });
        persistGoalChange(task);
    }

    static normalizeLoadedTask(task: TaskState, wasRunningAtShutdown: boolean): void {
        const goal = task.goal_state;
        if (!goal) return;
        let changed = false;
        const at = nowIso();

        if (goal.schedulerLease) {
            goal.schedulerLease = undefined;
            changed = true;
        }

        if (wasRunningAtShutdown && goal.status === 'active') {
            goal.status = 'paused';
            goal.pauseReason = 'task_restarted_after_running_interruption';
            goal.pausedAt = at;
            goal.updatedAt = at;
            if (!goal.pendingContinuation) {
                goal.pendingContinuation = createContinuation(
                    goal,
                    defaultContinuationPrompt(
                        goal,
                        'OpenDesk 上次在执行当前 goal 时异常退出或重启，旧的执行栈已经不可恢复。'
                    ),
                    'crash_recovery'
                );
            }
            appendEvent(task, goal, 'paused', 'system', {
                reason: goal.pauseReason,
                wasTaskStatus: 'running'
            });
            changed = true;
        } else if (goal.status === 'active' && task.task_status === 'waiting') {
            goal.status = 'paused';
            goal.pauseReason = 'active_goal_loaded_without_runner';
            goal.pausedAt = at;
            goal.updatedAt = at;
            if (!goal.pendingContinuation) {
                goal.pendingContinuation = createContinuation(
                    goal,
                    defaultContinuationPrompt(goal, '加载时发现 active goal 没有可恢复的 runner，请重新继续。'),
                    'load_recovery'
                );
            }
            appendEvent(task, goal, 'paused', 'system', { reason: goal.pauseReason, wasTaskStatus: 'waiting' });
            task.task_status = 'stopped';
            changed = true;
        } else if ((goal.status === 'paused' || goal.status === 'blocked') && task.task_status === 'waiting') {
            task.task_status = 'stopped';
            changed = true;
        }

        if (changed) {
            task._dirty = true;
        }
    }

    static prepareForkedGoal(sourceTask: TaskState, forkedTask: TaskState): void {
        const sourceGoal = sourceTask.goal_state;
        if (!sourceGoal || sourceGoal.status === 'cleared') return;
        const goal = GoalStates.clone(sourceGoal);
        const previousGoalId = goal.id;
        const forkedAt = nowIso();
        goal.id = crypto.randomUUID();
        goal.taskId = forkedTask.task_id;
        goal.schedulerLease = undefined;
        goal.pendingSupplements = [];
        goal.updatedAt = forkedAt;
        // fork 后 chat_context 是源 task 的快照副本，以当前累计 token 作为新基准线，
        // 让 forked goal 重新独立计量 token 消耗
        goal.tokenUsageBaseline = computeTotalTokenUsage(forkedTask);
        if (GoalStates.isUnfinished(goal.status)) {
            goal.status = 'blocked';
            goal.blockedReason = 'forked_history_requires_goal_review';
            goal.pauseReason = undefined;
            goal.pendingContinuation = undefined;
        }
        forkedTask.goal_state = goal;
        forkedTask.goal_event_log = {
            mode: 'inline',
            events: GoalEvents.getTail(sourceTask.goal_event_log).slice(-50)
        };
        appendEvent(forkedTask, goal, 'forked', 'system', {
            forkedFromGoalId: previousGoalId,
            sourceTaskId: sourceTask.task_id
        });
    }
}
