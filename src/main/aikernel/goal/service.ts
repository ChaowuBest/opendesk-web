import type { TaskState } from '../states/tasks.js';
import { deleteTaskTodos, resetInProgressTaskTodos } from '../todos/task-todos.js';
import { GoalController, type GoalPausedOrBlockedSnapshot } from './controller.js';
import { GoalScheduler } from './scheduler.js';
import type {
    AddGoalSupplementInput,
    CreateGoalInput,
    GoalCommandResult,
    GoalEvent,
    ResumeGoalOptions
} from './state.js';

const RESUME_INTERRUPT_SETTLE_TIMEOUT_MS = 2_000;
const RESUME_INTERRUPT_POLL_MS = 50;

function hasPendingRuntimeInterrupt(task: TaskState): boolean {
    return task.runtimeInterrupt?.requested === true && !task.runtimeInterrupt.handledAt;
}

async function waitForRuntimeInterruptSettled(task: TaskState): Promise<void> {
    if (hasPendingRuntimeInterrupt(task)) {
        await task.waitForRuntimeInterruptSettled();
    }
}

async function waitForPendingRuntimeInterrupt(task: TaskState): Promise<boolean> {
    const deadline = Date.now() + RESUME_INTERRUPT_SETTLE_TIMEOUT_MS;
    while (hasPendingRuntimeInterrupt(task)) {
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, RESUME_INTERRUPT_POLL_MS));
    }
    return true;
}

async function waitForGoalCreateReadiness(task: TaskState): Promise<GoalCommandResult | undefined> {
    if (hasPendingRuntimeInterrupt(task)) {
        const settled = await waitForPendingRuntimeInterrupt(task);
        if (!settled) {
            return {
                ok: false,
                status: task.goal_state?.status,
                messageKey: 'goal.scheduler.interrupt_pending',
                errorCode: 'interrupt_pending'
            };
        }
    }
    return undefined;
}

function attachCreatedGoalToRunningTurn(task: TaskState, created: GoalCommandResult): GoalCommandResult {
    const goal = task.goal_state;
    if (goal?.status === 'active') {
        task.injectGoalEditReminder({
            goalId: goal.id,
            goalRevision: goal.revision,
            objective: goal.objective,
            reason: 'goal_create'
        });
    }
    return { ...created, startedScheduler: false };
}

function schedulerStartFailedResult(task: TaskState): GoalCommandResult {
    return {
        ok: false,
        status: task.goal_state?.status,
        messageKey: 'goal.scheduler.start_failed',
        errorCode: 'scheduler_start_failed',
        summary: GoalController.getStatus(task).summary
    };
}

async function startCreatedGoal(
    task: TaskState,
    created: GoalCommandResult,
    options: { attachToRunningTurn?: boolean } = {}
): Promise<GoalCommandResult> {
    const started = await GoalScheduler.startExecution(task, 'create');
    if (!started.ok) {
        if (options.attachToRunningTurn === true && started.errorCode === 'task_running') {
            return attachCreatedGoalToRunningTurn(task, created);
        }
        GoalController.blockActiveGoal(task, 'scheduler_start_failed', 'system');
        return {
            ...started,
            status: task.goal_state?.status,
            summary: GoalController.getStatus(task).summary
        };
    }
    deleteTaskTodos(task.task_id);
    return { ...created, startedScheduler: started.startedScheduler === true, clearedTaskTodos: true };
}

export class GoalService {
    static async create(task: TaskState, input: CreateGoalInput): Promise<GoalCommandResult> {
        const readinessError = await waitForGoalCreateReadiness(task);
        if (readinessError) return readinessError;

        const shouldAttachToRunningTurn = task.task_status === 'running';
        const created = GoalController.create(task, input);
        if (!created.ok) return created;

        if (shouldAttachToRunningTurn || task.task_status === 'running') {
            return attachCreatedGoalToRunningTurn(task, created);
        }

        return startCreatedGoal(task, created, { attachToRunningTurn: true });
    }

    static async replace(task: TaskState, input: CreateGoalInput): Promise<GoalCommandResult> {
        if (input.objective.trim().length === 0) {
            return { ok: false, messageKey: 'goal.help', errorCode: 'empty_objective' };
        }

        const source = input.source ?? 'api';
        const clearResult = GoalController.clear(task, source);
        resetInProgressTaskTodos(task.task_id);
        if (!clearResult.ok) return clearResult;

        let interruptedRunner = false;
        if (task.task_status === 'running') {
            await task.interruptRunningTurn({
                reason: 'goal_clear',
                stopRunningTools: true,
                cancelPermissionPrompts: true
            });
            interruptedRunner = true;
        }

        await waitForRuntimeInterruptSettled(task);
        if (task.task_status === 'running') {
            return {
                ok: false,
                status: task.goal_state?.status,
                messageKey: 'goal.scheduler.running',
                errorCode: 'task_running',
                interruptedRunner
            };
        }

        const created = GoalController.create(task, input);
        if (!created.ok) return { ...created, interruptedRunner };
        deleteTaskTodos(task.task_id);
        created.clearedTaskTodos = true;
        const started = await startCreatedGoal(task, created);
        return { ...started, interruptedRunner };
    }

    static async edit(
        task: TaskState,
        objective: string,
        source: GoalEvent['source'] = 'api'
    ): Promise<GoalCommandResult> {
        const result = GoalController.editObjective(task, objective, source);
        if (!result.ok) return result;
        const goal = task.goal_state;
        if (!goal || goal.status !== 'active') {
            return result;
        }
        if (task.task_status === 'running') {
            task.injectGoalEditReminder({
                goalId: goal.id,
                goalRevision: goal.revision,
                objective: goal.objective,
                reason: 'goal_edit'
            });
            return result;
        }
        let started: GoalCommandResult;
        try {
            started = await GoalScheduler.startExecution(task, 'resume');
        } catch {
            started = schedulerStartFailedResult(task);
        }
        if (!started.ok) {
            if (started.errorCode === 'task_running' && task.task_status === 'running') {
                task.injectGoalEditReminder({
                    goalId: goal.id,
                    goalRevision: goal.revision,
                    objective: goal.objective,
                    reason: 'goal_edit'
                });
                return { ...result, startedScheduler: false };
            }
            GoalController.blockActiveGoal(task, 'scheduler_start_failed', 'system');
            return {
                ...started,
                status: task.goal_state?.status,
                summary: GoalController.getStatus(task).summary
            };
        }
        return { ...result, startedScheduler: started.startedScheduler === true };
    }

    static addSupplement(task: TaskState, input: AddGoalSupplementInput): GoalCommandResult {
        return GoalController.addSupplement(task, input);
    }

    static async pause(
        task: TaskState,
        source: GoalEvent['source'] = 'api',
        reason?: string
    ): Promise<GoalCommandResult> {
        const result = GoalController.pause(task, source, reason);
        if (!result.ok) return result;
        let interruptedRunner = false;
        if (task.task_status === 'running') {
            await task.interruptRunningTurn({
                reason: 'goal_pause',
                stopRunningTools: true,
                cancelPermissionPrompts: true
            });
            interruptedRunner = true;
        }
        return { ...result, interruptedRunner };
    }

    static async resume(task: TaskState, options: ResumeGoalOptions = {}): Promise<GoalCommandResult> {
        if (hasPendingRuntimeInterrupt(task)) {
            const settled = await waitForPendingRuntimeInterrupt(task);
            if (!settled) {
                return {
                    ok: false,
                    status: task.goal_state?.status,
                    messageKey: 'goal.resume.runner_stopping',
                    errorCode: 'task_running'
                };
            }
        }
        if (task.task_status === 'running') {
            return {
                ok: false,
                status: task.goal_state?.status,
                messageKey: 'goal.resume.runner_stopping',
                errorCode: 'task_running'
            };
        }
        const goal = task.goal_state;
        const previous: GoalPausedOrBlockedSnapshot | undefined =
            goal?.status === 'paused' || goal?.status === 'blocked'
                ? {
                      status: goal.status,
                      pauseReason: goal.pauseReason,
                      blockedReason: goal.blockedReason,
                      pausedAt: goal.pausedAt,
                      resumedAt: goal.resumedAt
                  }
                : undefined;
        const resumed = GoalController.resumeStateOnly(task, options);
        if (!resumed.ok) return resumed;
        let started: GoalCommandResult;
        try {
            started = await GoalScheduler.startExecution(
                task,
                'resume',
                options.promptOverride,
                options.note ? { note: options.note } : {}
            );
        } catch {
            started = schedulerStartFailedResult(task);
        }
        if (!started.ok) {
            if (previous) {
                return GoalController.restorePausedOrBlockedAfterSchedulerFailure(task, previous, started);
            }
            return { ...started, summary: GoalController.getStatus(task).summary };
        }
        return { ...resumed, startedScheduler: started.startedScheduler === true };
    }

    static async clear(task: TaskState, source: GoalEvent['source'] = 'api'): Promise<GoalCommandResult> {
        const result = GoalController.clear(task, source);
        resetInProgressTaskTodos(task.task_id);
        let interruptedRunner = false;
        if (task.task_status === 'running') {
            await task.interruptRunningTurn({
                reason: 'goal_clear',
                stopRunningTools: true,
                cancelPermissionPrompts: true
            });
            interruptedRunner = true;
        }
        return { ...result, interruptedRunner };
    }
}
