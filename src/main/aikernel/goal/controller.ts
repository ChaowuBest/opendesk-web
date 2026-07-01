import type { TaskState } from '../states/tasks.js';
import { UserMessage } from '../messages.js';
import {
    GoalEvents,
    GoalStates,
    createGoalEvent,
    sanitizeErrorSummary,
    type AddGoalSupplementInput,
    type CreateGoalInput,
    type GoalCommandResult,
    type GoalContinuation,
    type GoalEvaluation,
    type GoalEvaluationApplyResult,
    type GoalEvent,
    type GoalMaybeResumeResult,
    type GoalRenderSummary,
    type GoalState,
    type GoalStatusView,
    type GoalSupplement,
    type ResumeGoalOptions
} from './state.js';

function nowIso(): string {
    return new Date().toISOString();
}

function summary(task: TaskState): GoalRenderSummary | undefined {
    return GoalStates.renderSummary(task.goal_state, task.goal_event_log);
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

function appendGoalDisplayMessage(task: TaskState, goal: GoalState, objective: string, reason: string): string {
    const message = new UserMessage(`/goal ${objective}`);
    message.displayOnly = true;
    message.rawText = `/goal ${objective}`;
    message.metadata = {
        scope: 'goal',
        origin: { source: 'internal', reason },
        execution: {
            controller: 'goal',
            controllerId: goal.id,
            controllerRevision: goal.revision
        }
    };
    task.chat_context.appendMessage(message);
    void task.sendSubscriptionFeedback(0);
    return message.message_id;
}

function ensureExistingGoal(task: TaskState): GoalState | undefined {
    const goal = task.goal_state;
    if (!goal || goal.status === 'cleared') return undefined;
    return goal;
}

function createContinuation(goal: GoalState, prompt: string, reason: string): GoalContinuation {
    return GoalStates.createContinuation(goal, prompt, reason);
}

function defaultContinuationPrompt(goal: GoalState, reason: string): string {
    return [
        '<system-reminder>',
        reason,
        '',
        'Goal objective:',
        goal.objective,
        '',
        '请根据当前 transcript、文件状态和 goal state 继续推进。',
        '</system-reminder>'
    ].join('\n');
}

/**
 * 累计 chat_context 中所有 assistant 消息的 token 用量，
 * 排除包含 goal 调度器注入的 system-reminder 的边界消息。
 */
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
        const displayMessageId =
            (input.source ?? 'api') === 'gui'
                ? appendGoalDisplayMessage(task, goal, objective, 'goal_create_display')
                : undefined;
        appendEvent(task, goal, 'created', input.source ?? 'api', {
            objective,
            ...(displayMessageId ? { displayMessageId } : {})
        });
        persistGoalChange(task);
        return { ok: true, status: goal.status, summary: summary(task) };
    }

    static editObjective(task: TaskState, objective: string, source: GoalEvent['source'] = 'api'): GoalCommandResult {
        const trimmed = objective.trim();
        if (!trimmed) {
            return { ok: false, messageKey: 'goal.help', errorCode: 'empty_objective' };
        }

        const goal = ensureExistingGoal(task);
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
        goal.pendingContinuation = undefined;
        goal.schedulerLease = undefined;
        goal.editHistory.push({
            revision: goal.revision,
            previousObjective,
            objective: trimmed,
            editedAt,
            source
        });
        const displayMessageId =
            source === 'gui' ? appendGoalDisplayMessage(task, goal, trimmed, 'goal_edit_display') : undefined;
        appendEvent(task, goal, 'edited', source, {
            previousObjective,
            objective: trimmed,
            ...(displayMessageId ? { displayMessageId } : {})
        });
        persistGoalChange(task);
        return { ok: true, status: goal.status, summary: summary(task) };
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
        const eventPayload: Record<string, unknown> = {};
        if (typeof options.note === 'string' && options.note.length > 0) {
            eventPayload.note = options.note;
        }
        appendEvent(
            task,
            goal,
            'resumed',
            options.source ?? 'api',
            Object.keys(eventPayload).length > 0 ? eventPayload : undefined
        );
        persistGoalChange(task);
        return { ok: true, status: goal.status, summary: summary(task) };
    }

    static clear(task: TaskState, source: GoalEvent['source'] = 'api'): GoalCommandResult {
        const goal = ensureExistingGoal(task);
        if (!goal) {
            return { ok: true, status: 'cleared', messageKey: 'goal.clear.none' };
        }
        const at = nowIso();
        goal.status = 'cleared';
        goal.pendingContinuation = undefined;
        goal.pendingSupplements = [];
        goal.schedulerLease = undefined;
        goal.clearedAt = at;
        goal.updatedAt = at;
        appendEvent(task, goal, 'cleared', source);
        persistGoalChange(task);
        return { ok: true, status: goal.status, summary: summary(task) };
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

        goal.lastEvaluation = evaluation;
        goal.updatedAt = nowIso();
        appendEvent(task, goal, 'evaluated', 'evaluator', {
            status: evaluation.status,
            reason: evaluation.reason,
            evidenceCount: evaluation.evidence.length
        });

        if (evaluation.status === 'met') {
            goal.status = 'complete';
            goal.completedAt = goal.updatedAt;
            goal.pendingContinuation = undefined;
            goal.pendingSupplements = [];
            goal.schedulerLease = undefined;
            resetCompletedGoalTurnCounters(goal);
            appendEvent(task, goal, 'completed', 'evaluator', { reason: evaluation.reason });
            persistGoalChange(task);
            return { action: 'finish', status: goal.status };
        }

        if (evaluation.status === 'blocked') {
            goal.status = 'blocked';
            goal.blockedReason = evaluation.reason || 'goal_blocked';
            goal.schedulerLease = undefined;
            appendEvent(task, goal, 'blocked', 'evaluator', { reason: goal.blockedReason });
            persistGoalChange(task);
            return { action: 'finish', status: goal.status };
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
            continuationId: goal.pendingContinuation.id
        };
    }

    static recordEvaluatorFailure(task: TaskState, staleGoal: GoalState, error: unknown): GoalEvaluationApplyResult {
        const goal = task.goal_state;
        if (!goal || goal.id !== staleGoal.id || goal.revision !== staleGoal.revision || goal.status !== 'active') {
            return { action: 'finish', status: goal?.status ?? 'cleared' };
        }

        const reason = `goal_evaluator_failed: ${sanitizeErrorSummary(error)}`;
        goal.status = 'blocked';
        goal.blockedReason = 'goal_evaluator_failed';
        goal.schedulerLease = undefined;
        goal.lastEvaluation = {
            goalId: goal.id,
            goalRevision: goal.revision,
            status: 'blocked',
            reason,
            evidence: ['Evaluator failed before producing a valid structured result'],
            evaluatedAt: nowIso()
        };
        goal.updatedAt = goal.lastEvaluation.evaluatedAt;
        appendEvent(task, goal, 'evaluated', 'evaluator', { status: 'blocked', reason, evaluatorFailure: true });
        appendEvent(task, goal, 'blocked', 'evaluator', { reason: goal.blockedReason });
        persistGoalChange(task);
        return { action: 'finish', status: goal.status };
    }

    static maybeResumeGoalFromUserMessage(task: TaskState, message: string): GoalMaybeResumeResult {
        const goal = task.goal_state;
        if (!goal || (goal.status !== 'blocked' && goal.status !== 'paused')) {
            return { action: 'none' };
        }
        const normalized = message.trim().toLowerCase();
        const shortResume = new Set(['继续', '恢复', '重试', '再试一次', 'retry', 'continue', 'resume']);
        if (shortResume.has(normalized)) {
            return {
                action: 'resume_via_scheduler_only',
                promptSource: goal.pendingContinuation ? 'pending_continuation' : 'default_resume'
            };
        }
        if (goal.status === 'paused') {
            return { action: 'none' };
        }
        return { action: 'ignore_and_reject', messageKey: 'goal.blocked.unrelated_message' };
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
