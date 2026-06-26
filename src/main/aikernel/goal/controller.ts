import type { TaskState } from '../states/tasks.js';
import {
    GoalEvents,
    GoalStates,
    createGoalEvent,
    sanitizeErrorSummary,
    type CreateGoalInput,
    type GoalBudgetUpdate,
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
    return enrichSummaryTokenUsage(task, GoalStates.renderSummary(task.goal_state, task.goal_event_log));
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

/**
 * 给 GoalRenderSummary 补上实时 token 用量。
 * renderSummary 直接 clone goal_state.tokenBudget，其中 usedTotalTokens 从未被写入；
 * 所有对外暴露 summary 的出口（toRenderJSON / getStatus）都应调用此函数补全。
 */
export function enrichSummaryTokenUsage(
    task: TaskState,
    summary: GoalRenderSummary | undefined
): GoalRenderSummary | undefined {
    if (!summary?.tokenBudget?.maxTotalTokens || !task.goal_state) return summary;
    const usedTotalTokens = getGoalTokenUsage(task);
    return {
        ...summary,
        tokenBudget: { ...summary.tokenBudget, usedTotalTokens }
    };
}

function getBudgetLimitReason(goal: GoalState): string | undefined {
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
}

export class GoalController {
    static getStatus(task: TaskState): GoalStatusView {
        const view = GoalStates.statusView(task.goal_state, task.goal_event_log);
        if (view.summary) {
            view.summary = enrichSummaryTokenUsage(task, view.summary);
        }
        return view;
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
        // 快照创建时 chat_context 已累计的 token 总量，作为本 goal 独立计量的基准线，
        // 使新 goal 的 token 预算不受同 task 内旧 goal 消耗的影响。
        goal.tokenUsageBaseline = computeTotalTokenUsage(task);
        task.goal_state = goal;
        if (shouldDeriveTaskNameFromGoal(task)) {
            task.task_name = deriveTaskNameFromGoalObjective(objective);
        }
        appendEvent(task, goal, 'created', input.source ?? 'api', { objective });
        persistGoalChange(task);
        return { ok: true, status: goal.status, summary: summary(task) };
    }

    static editObjective(
        task: TaskState,
        objective: string,
        source: GoalEvent['source'] = 'api',
        budgetUpdate?: GoalBudgetUpdate
    ): GoalCommandResult {
        const trimmed = objective.trim();
        if (!trimmed) {
            return { ok: false, messageKey: 'goal.help', errorCode: 'empty_objective' };
        }

        const goal = ensureExistingGoal(task);
        if (!goal) {
            return { ok: false, messageKey: 'goal.error.none', errorCode: 'no_goal' };
        }

        const previousObjective = goal.objective;
        const previousMaxAttempts = goal.maxAttempts;
        const previousTokenBudget = goal.tokenBudget ? { ...goal.tokenBudget } : undefined;
        const previousTimeBudgetMs = goal.timeBudgetMs;
        const objectiveChanged = previousObjective !== trimmed;
        let budgetChanged = false;

        if (budgetUpdate) {
            if ('maxAttempts' in budgetUpdate) {
                if (budgetUpdate.maxAttempts === null) {
                    if (goal.maxAttempts !== undefined) {
                        goal.maxAttempts = undefined;
                        budgetChanged = true;
                    }
                } else if (
                    typeof budgetUpdate.maxAttempts === 'number' &&
                    goal.maxAttempts !== budgetUpdate.maxAttempts
                ) {
                    goal.maxAttempts = budgetUpdate.maxAttempts;
                    budgetChanged = true;
                }
            }
            if ('tokenBudget' in budgetUpdate) {
                if (budgetUpdate.tokenBudget === null) {
                    if (goal.tokenBudget !== undefined) {
                        goal.tokenBudget = undefined;
                        budgetChanged = true;
                    }
                } else if (budgetUpdate.tokenBudget) {
                    const nextTokenBudget = { ...budgetUpdate.tokenBudget };
                    if (
                        goal.tokenBudget?.maxTotalTokens !== nextTokenBudget.maxTotalTokens ||
                        goal.tokenBudget?.usedTotalTokens !== nextTokenBudget.usedTotalTokens
                    ) {
                        goal.tokenBudget = nextTokenBudget;
                        budgetChanged = true;
                    }
                }
            }
            if ('timeBudgetMs' in budgetUpdate) {
                if (budgetUpdate.timeBudgetMs === null) {
                    if (goal.timeBudgetMs !== undefined) {
                        goal.timeBudgetMs = undefined;
                        budgetChanged = true;
                    }
                } else if (
                    typeof budgetUpdate.timeBudgetMs === 'number' &&
                    goal.timeBudgetMs !== budgetUpdate.timeBudgetMs
                ) {
                    goal.timeBudgetMs = budgetUpdate.timeBudgetMs;
                    budgetChanged = true;
                }
            }
        }

        if (!objectiveChanged && !budgetChanged) {
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
        appendEvent(task, goal, 'edited', source, {
            previousObjective,
            objective: trimmed,
            ...(budgetChanged
                ? {
                      previousBudget: {
                          maxAttempts: previousMaxAttempts,
                          tokenBudget: previousTokenBudget,
                          timeBudgetMs: previousTimeBudgetMs
                      },
                      budget: {
                          maxAttempts: goal.maxAttempts,
                          tokenBudget: goal.tokenBudget,
                          timeBudgetMs: goal.timeBudgetMs
                      }
                  }
                : {})
        });
        persistGoalChange(task);
        return { ok: true, status: goal.status, summary: summary(task) };
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
        const eventPayload: Record<string, unknown> = {};
        if (typeof options.note === 'string' && options.note.length > 0) {
            eventPayload.note = options.note;
        }
        if (options.budgetOverride) {
            eventPayload.budgetOverride = { ...options.budgetOverride };
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

        // 在评估前，统计当前 goal 生命周期内新增的 token 用量，
        // 确保 tokenBudget 检查使用的是实时数据
        goal.tokenBudget = goal.tokenBudget
            ? { ...goal.tokenBudget, usedTotalTokens: computeGoalTokenUsage(task, goal) }
            : undefined;

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

        // 执行前预算检查：本轮尚未开始，如果已超限则拦截或消耗 one-shot
        const budgetReason = getBudgetLimitReason(goal);
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

        // 执行后预算检查：本轮执行结束后如果达到预算上限，创建 continuation 供以后 resume，
        // 但返回 finish 让 beforeFinishTurn hook 停止当前 task
        const postBudgetReason = getBudgetLimitReason(goal);
        if (postBudgetReason) {
            goal.status = 'budget_limited';
            goal.budgetLimitedReason = postBudgetReason;
            goal.pendingContinuation = createContinuation(goal, continuationPrompt, postBudgetReason);
            goal.schedulerLease = undefined;
            appendEvent(task, goal, 'continuation_created', 'evaluator', {
                continuationId: goal.pendingContinuation.id
            });
            appendEvent(task, goal, 'budget_limited', 'evaluator', { reason: postBudgetReason });
            persistGoalChange(task);
            return { action: 'finish', status: goal.status };
        }

        goal.pendingContinuation = createContinuation(goal, continuationPrompt, 'not_met');
        appendEvent(task, goal, 'continuation_created', 'evaluator', { continuationId: goal.pendingContinuation.id });
        persistGoalChange(task);
        return {
            action: 'continue',
            continuationPrompt,
            continuationId: goal.pendingContinuation.id
        };
    }

    /**
     * 本轮内的预算边界检查。
     * 在 processTaskTurn 的 processToolCalls → continue（回到 LLM 调用）之间调用，
     * 如果预算已超限则提前结束本轮，避免浪费下一次 LLM 调用的 token。
     *
     * 返回 true 表示预算超限，调用方应终止当前 turn。
     */
    static checkBudgetBoundary(task: TaskState): boolean {
        const goal = task.goal_state;
        if (!goal || goal.status !== 'active') return false;

        // 用当前 goal 生命周期内新增的 token 用量更新 tokenBudget
        goal.tokenBudget = goal.tokenBudget
            ? { ...goal.tokenBudget, usedTotalTokens: computeGoalTokenUsage(task, goal) }
            : undefined;

        const reason = getBudgetLimitReason(goal);
        if (!reason) return false;

        // 尝试消耗 one-shot 覆盖（用户授权的单次续期允许本轮完成）
        if (consumeOneShotBudgetOverride(goal, reason)) {
            appendEvent(task, goal, 'evaluated', 'system', {
                oneShotBudgetOverrideConsumed: true,
                budgetReason: reason
            });
            return false;
        }

        // 预算超限且无 one-shot 覆盖 → 设置 budget_limited，创建 continuation
        const continuationPrompt = defaultContinuationPrompt(
            goal,
            'Goal 在执行过程中触发了预算限制（mid-turn check），当前工具执行结果已保留。'
        );
        goal.status = 'budget_limited';
        goal.budgetLimitedReason = reason;
        goal.pendingContinuation = createContinuation(goal, continuationPrompt, reason);
        goal.schedulerLease = undefined;
        goal.updatedAt = nowIso();
        appendEvent(task, goal, 'continuation_created', 'system', {
            continuationId: goal.pendingContinuation.id,
            midTurn: true
        });
        appendEvent(task, goal, 'budget_limited', 'system', { reason, midTurn: true });
        persistGoalChange(task);
        return true;
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
        // fork 后 chat_context 是源 task 的快照副本，以当前累计 token 作为新基准线，
        // 让 forked goal 重新独立计量 token 消耗
        goal.tokenUsageBaseline = computeTotalTokenUsage(forkedTask);
        if (GoalStates.isUnfinished(goal.status)) {
            goal.status = 'blocked';
            goal.blockedReason = 'forked_history_requires_goal_review';
            goal.pauseReason = undefined;
            goal.budgetLimitedReason = undefined;
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
