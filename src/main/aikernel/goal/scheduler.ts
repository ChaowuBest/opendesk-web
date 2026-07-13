import type { TaskState } from '../states/tasks.js';
import { GoalEvents, GoalStates, createGoalEvent, type GoalCommandResult, type GoalSchedulerLease } from './state.js';
import { buildGoalResumePrompt, buildGoalStartPrompt } from './prompts.js';

const LEASE_TTL_MS = 30_000;

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
        promptOverride?: string
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
        let continuationTurnGeneration: number | undefined;
        if (!prompt && goal.pendingContinuation && !goal.pendingContinuation.consumedAt) {
            prompt = goal.pendingContinuation.prompt;
            continuationId = goal.pendingContinuation.id;
            continuationTurnGeneration = task.getNextTurnGeneration();
        }
        if (!prompt) {
            prompt = leaseReason === 'create' ? buildGoalStartPrompt(goal) : buildGoalResumePrompt(goal);
        }
        try {
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
        } catch {
            goal.schedulerLease = undefined;
            task.persistLater();
            if (task.task_status !== 'stopped') {
                task.stop('system');
            }
            return {
                ok: false,
                status: goal.status,
                messageKey: 'goal.scheduler.start_failed',
                errorCode: 'scheduler_start_failed',
                summary: GoalStates.renderSummary(goal)
            };
        }

        if (continuationId && goal.pendingContinuation?.id === continuationId) {
            const consumedAt = new Date().toISOString();
            goal.pendingContinuation.consumedAt = consumedAt;
            if (typeof continuationTurnGeneration === 'number') {
                goal.pendingContinuation.consumedByTurnGeneration = continuationTurnGeneration;
            }
            GoalEvents.appendToTask(
                task,
                createGoalEvent(goal, 'continuation_consumed', 'scheduler', { continuationId })
            );
            task.persistLater();
        }

        return {
            ok: true,
            status: goal.status,
            startedScheduler: true,
            summary: GoalStates.renderSummary(goal)
        };
    }
}
