import type { TaskState } from '../states/tasks.js';
import { GoalEvents, GoalStates, createGoalEvent, type GoalCommandResult, type GoalSchedulerLease } from './state.js';

const LEASE_TTL_MS = 30_000;

function buildStartPrompt(task: TaskState): string {
    const goal = task.goal_state!;
    const parts = ['<system-reminder>', '开始推进当前 goal。', '', 'Goal objective:', goal.objective];
    if (goal.successCriteria.length > 0) {
        parts.push('', 'Success criteria:', ...goal.successCriteria.map((criterion) => `- ${criterion}`));
    }
    parts.push(
        '',
        '请基于当前 task 上下文执行必要步骤，直到 goal 满足、遇到需要用户介入的 blocker，或达到预算边界。不要把本提醒作为普通用户消息回复。',
        '</system-reminder>'
    );
    return parts.join('\n');
}

function buildResumePrompt(task: TaskState): string {
    const goal = task.goal_state!;
    const parts = ['<system-reminder>', '继续推进当前 goal。', '', 'Goal objective:', goal.objective];
    if (goal.successCriteria.length > 0) {
        parts.push('', 'Success criteria:', ...goal.successCriteria.map((criterion) => `- ${criterion}`));
    }
    parts.push('', '请根据当前上下文继续执行，直到满足 goal 或遇到需要用户介入的 blocker。', '</system-reminder>');
    return parts.join('\n');
}

function appendResumeNote(prompt: string, note?: string): string {
    if (typeof note !== 'string' || note.length === 0) return prompt;
    return [prompt, '', '<system-reminder>', '本次 /goal resume 补充信息:', note, '</system-reminder>'].join('\n');
}

function acquireLease(task: TaskState, reason: GoalSchedulerLease['reason']): GoalSchedulerLease | undefined {
    const goal = task.goal_state;
    if (!goal) return undefined;
    if (GoalStates.isLeaseValid(goal.schedulerLease)) {
        return undefined;
    }
    const acquiredAt = new Date();
    const lease = {
        id: crypto.randomUUID(),
        acquiredAt: acquiredAt.toISOString(),
        expiresAt: new Date(acquiredAt.getTime() + LEASE_TTL_MS).toISOString(),
        reason
    };
    goal.schedulerLease = lease;
    goal.updatedAt = lease.acquiredAt;
    task.persistLater();
    return lease;
}

export class GoalScheduler {
    static async startExecution(
        task: TaskState,
        reason: GoalSchedulerLease['reason'] = 'resume',
        promptOverride?: string,
        options: { note?: string } = {}
    ): Promise<GoalCommandResult> {
        const goal = task.goal_state;
        if (!goal) {
            return { ok: false, messageKey: 'goal.error.none', errorCode: 'no_goal' };
        }
        if (goal.status !== 'active') {
            return {
                ok: false,
                status: goal.status,
                messageKey: 'goal.scheduler.inactive',
                messageArgs: { status: goal.status },
                errorCode: 'inactive_goal'
            };
        }
        if (task.task_status === 'running') {
            return {
                ok: false,
                status: goal.status,
                messageKey: 'goal.scheduler.running',
                errorCode: 'task_running'
            };
        }
        if (task.runtimeInterrupt?.requested && !task.runtimeInterrupt.handledAt) {
            return {
                ok: false,
                status: goal.status,
                messageKey: 'goal.scheduler.interrupt_pending',
                errorCode: 'interrupt_pending'
            };
        }

        const leaseReason = reason;
        const lease = acquireLease(task, leaseReason);
        if (!lease) {
            return {
                ok: false,
                status: goal.status,
                messageKey: 'goal.scheduler.lease_active',
                errorCode: 'lease_active'
            };
        }

        let prompt = promptOverride;
        let continuationId: string | undefined;
        if (!prompt && goal.pendingContinuation && !goal.pendingContinuation.consumedAt) {
            prompt = goal.pendingContinuation.prompt;
            continuationId = goal.pendingContinuation.id;
            const consumedAt = new Date().toISOString();
            goal.pendingContinuation.consumedAt = consumedAt;
            goal.pendingContinuation.consumedByTurnGeneration = task.getNextTurnGeneration();
            GoalEvents.appendToTask(
                task,
                createGoalEvent(goal, 'continuation_consumed', 'scheduler', { continuationId })
            );
        }
        if (!prompt) {
            prompt = leaseReason === 'create' ? buildStartPrompt(task) : buildResumePrompt(task);
        }
        if (leaseReason === 'resume') {
            prompt = appendResumeNote(prompt, options.note);
        }

        task.persistLater();
        await task.startInternalTurn({
            prompt,
            source:
                leaseReason === 'create'
                    ? 'goal_create'
                    : continuationId
                      ? 'goal_continuation'
                      : leaseReason === 'hook'
                        ? 'goal_hook'
                        : 'goal_resume',
            metadata: {
                scope: 'goal',
                origin: { source: 'scheduler', reason: leaseReason },
                execution: {
                    controller: 'goal',
                    controllerId: goal.id,
                    controllerRevision: goal.revision,
                    continuationId
                }
            }
        });

        return {
            ok: true,
            status: goal.status,
            startedScheduler: true,
            summary: GoalStates.renderSummary(goal)
        };
    }
}
