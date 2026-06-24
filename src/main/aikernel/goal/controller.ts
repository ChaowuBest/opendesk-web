import type { TaskState } from '../states/tasks.js';
import {
    GoalEvents,
    GoalStates,
    createGoalEvent,
    sanitizeErrorSummary,
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
    type ResumeGoalOptions
} from './state.js';

function nowIso(): string {
    return new Date().toISOString();
}

function summary(task: TaskState): GoalRenderSummary | undefined {
    return GoalStates.renderSummary(task.goal_state);
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

function ensureExistingGoal(task: TaskState): GoalState | undefined {
    const goal = task.goal_state;
    if (!goal || goal.status === 'cleared') return undefined;
    return goal;
}

function createContinuation(goal: GoalState, prompt: string, reason: string): GoalContinuation {
    return GoalStates.createContinuation(goal, prompt, reason);
}

function consumeOneShotBudgetOverride(goal: GoalState, budgetReason: string): boolean {
    const override = goal.oneShotBudgetOverride;
    if (!override || override.consumedAt) return false;
    override.consumedAt = nowIso();
    override.consumedReason = budgetReason;
    return true;
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

export class GoalController {
    static getStatus(task: TaskState): GoalStatusView {
        return GoalStates.statusView(task.goal_state);
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
        task.goal_state = goal;
        appendEvent(task, goal, 'created', input.source ?? 'api', { objective });
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
        appendEvent(task, goal, 'edited', source, { previousObjective, objective: trimmed });
        persistGoalChange(task);
        return { ok: true, status: goal.status, summary: summary(task) };
    }

    static pause(task: TaskState, reason?: string, source: GoalEvent['source'] = 'api'): GoalCommandResult {
        const goal = ensureExistingGoal(task);
        if (!goal) {
            return { ok: false, messageKey: 'goal.error.none', errorCode: 'no_goal' };
        }
        if (goal.status === 'complete') {
            return { ok: false, status: goal.status, messageKey: 'goal.pause.complete', errorCode: 'goal_complete' };
        }

        const at = nowIso();
        goal.status = 'paused';
        goal.pauseReason = reason?.trim() || 'user_paused_goal';
        goal.pausedAt = at;
        goal.updatedAt = at;
        goal.schedulerLease = undefined;
        appendEvent(task, goal, 'paused', source, { reason: goal.pauseReason });
        persistGoalChange(task);
        return { ok: true, status: goal.status, summary: summary(task) };
    }

    static resumeStateOnly(task: TaskState, options: ResumeGoalOptions = {}): GoalCommandResult {
        const goal = ensureExistingGoal(task);
        if (!goal) {
            return { ok: false, messageKey: 'goal.error.none', errorCode: 'no_goal' };
        }

        if (goal.status === 'budget_limited' && !options.budgetOverride) {
            return {
                ok: false,
                status: goal.status,
                messageKey: 'goal.resume.requires_budget_authorization',
                errorCode: 'budget_authorization_required'
            };
        }

        if (goal.status !== 'paused' && goal.status !== 'blocked' && goal.status !== 'budget_limited') {
            return {
                ok: false,
                status: goal.status,
                messageKey: 'goal.resume.invalid_status',
                messageArgs: { status: goal.status },
                errorCode: 'invalid_status'
            };
        }

        if (options.budgetOverride?.oneShot) {
            goal.oneShotBudgetOverride = {
                id: crypto.randomUUID(),
                grantedAt: nowIso(),
                ...(options.budgetOverride.reason ? { reason: options.budgetOverride.reason } : {})
            };
        } else if (options.budgetOverride) {
            goal.oneShotBudgetOverride = undefined;
            if (typeof options.budgetOverride.maxAttemptsIncrement === 'number') {
                goal.maxAttempts = (goal.maxAttempts ?? goal.attempts) + options.budgetOverride.maxAttemptsIncrement;
            }
            if (typeof options.budgetOverride.timeBudgetMsIncrement === 'number') {
                goal.timeBudgetMs = (goal.timeBudgetMs ?? 0) + options.budgetOverride.timeBudgetMsIncrement;
            }
            if (typeof options.budgetOverride.tokenBudgetIncrement === 'number') {
                goal.tokenBudget = {
                    ...goal.tokenBudget,
                    maxTotalTokens:
                        (goal.tokenBudget?.maxTotalTokens ?? 0) + options.budgetOverride.tokenBudgetIncrement
                };
            }
        }

        const at = nowIso();
        goal.status = 'active';
        goal.pauseReason = undefined;
        goal.blockedReason = undefined;
        goal.budgetLimitedReason = undefined;
        goal.resumedAt = at;
        goal.updatedAt = at;
        goal.schedulerLease = undefined;
        appendEvent(task, goal, 'resumed', options.source ?? 'api', {
            budgetOverride: options.budgetOverride ? { ...options.budgetOverride } : undefined
        });
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
            goal.schedulerLease = undefined;
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

        if (evaluation.status === 'budget_limited') {
            goal.status = 'budget_limited';
            goal.budgetLimitedReason = evaluation.reason || 'goal_budget_limited';
            goal.schedulerLease = undefined;
            if (evaluation.nextPrompt) {
                goal.pendingContinuation = createContinuation(goal, evaluation.nextPrompt, 'budget_limited');
                appendEvent(task, goal, 'continuation_created', 'evaluator', {
                    continuationId: goal.pendingContinuation.id
                });
            }
            appendEvent(task, goal, 'budget_limited', 'evaluator', { reason: goal.budgetLimitedReason });
            persistGoalChange(task);
            return { action: 'finish', status: goal.status };
        }

        const continuationPrompt =
            evaluation.nextPrompt ||
            defaultContinuationPrompt(goal, 'Goal evaluator 判断当前 goal 尚未完成，请继续推进。');

        const budgetReason = (() => {
            if (typeof goal.timeBudgetMs === 'number' && goal.startedAt) {
                const startedAt = Date.parse(goal.startedAt);
                if (Number.isFinite(startedAt) && Date.now() - startedAt >= goal.timeBudgetMs) {
                    return 'time_budget_exceeded';
                }
            }
            if (
                typeof goal.tokenBudget?.maxTotalTokens === 'number' &&
                typeof goal.tokenBudget?.usedTotalTokens === 'number' &&
                goal.tokenBudget.usedTotalTokens >= goal.tokenBudget.maxTotalTokens
            ) {
                return 'token_budget_exceeded';
            }
            if (typeof goal.maxAttempts === 'number' && goal.attempts >= goal.maxAttempts) {
                return 'max_attempts_exceeded';
            }
            return undefined;
        })();
        if (budgetReason) {
            if (consumeOneShotBudgetOverride(goal, budgetReason)) {
                appendEvent(task, goal, 'evaluated', 'evaluator', {
                    status: evaluation.status,
                    oneShotBudgetOverrideConsumed: true,
                    budgetReason
                });
            } else {
                goal.status = 'budget_limited';
                goal.budgetLimitedReason = budgetReason;
                goal.pendingContinuation = createContinuation(goal, continuationPrompt, budgetReason);
                goal.schedulerLease = undefined;
                appendEvent(task, goal, 'continuation_created', 'evaluator', {
                    continuationId: goal.pendingContinuation.id
                });
                appendEvent(task, goal, 'budget_limited', 'evaluator', { reason: budgetReason });
                persistGoalChange(task);
                return { action: 'finish', status: goal.status };
            }
        }

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

    static maybeResumeBlockedGoalFromUserMessage(task: TaskState, message: string): GoalMaybeResumeResult {
        const goal = task.goal_state;
        if (!goal || goal.status !== 'blocked') {
            return { action: 'none' };
        }
        const normalized = message.trim().toLowerCase();
        const shortResume = new Set(['继续', '重试', '再试一次', 'retry', 'continue']);
        if (shortResume.has(normalized)) {
            return {
                action: 'resume_via_scheduler_only',
                promptSource: goal.pendingContinuation ? 'pending_continuation' : 'default_resume'
            };
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
        } else if (
            (goal.status === 'paused' || goal.status === 'blocked' || goal.status === 'budget_limited') &&
            task.task_status === 'waiting'
        ) {
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
        goal.updatedAt = forkedAt;
        if (GoalStates.isUnfinished(goal.status)) {
            goal.status = 'blocked';
            goal.blockedReason = 'forked_history_requires_goal_review';
            goal.pauseReason = undefined;
            goal.budgetLimitedReason = undefined;
            goal.pendingContinuation = undefined;
        }
        forkedTask.goal_state = goal;
        forkedTask.goal_event_log = GoalEvents.deserialize(
            sourceTask.goal_event_log_tail ?? sourceTask.goal_event_log
        ).slice(-50);
        appendEvent(forkedTask, goal, 'forked', 'system', {
            forkedFromGoalId: previousGoalId,
            sourceTaskId: sourceTask.task_id
        });
    }
}
