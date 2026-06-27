import type { TaskState } from '../states/tasks.js';
import { resetInProgressTaskTodos } from '../todos/task-todos.js';
import { GoalController } from './controller.js';
import { GoalScheduler } from './scheduler.js';
import type { CreateGoalInput, GoalBudgetUpdate, GoalCommandResult, GoalEvent, ResumeGoalOptions } from './state.js';

const RESUME_INTERRUPT_SETTLE_TIMEOUT_MS = 2_000;
const RESUME_INTERRUPT_POLL_MS = 50;

function hasPendingRuntimeInterrupt(task: TaskState): boolean {
    return task.runtimeInterrupt?.requested === true && !task.runtimeInterrupt.handledAt;
}

async function waitForPendingRuntimeInterrupt(task: TaskState): Promise<boolean> {
    const deadline = Date.now() + RESUME_INTERRUPT_SETTLE_TIMEOUT_MS;
    while (hasPendingRuntimeInterrupt(task)) {
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, RESUME_INTERRUPT_POLL_MS));
    }
    return true;
}

async function waitForGoalStartReadiness(task: TaskState): Promise<GoalCommandResult | undefined> {
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
    if (task.task_status === 'running') {
        return {
            ok: false,
            status: task.goal_state?.status,
            messageKey: 'goal.scheduler.running',
            errorCode: 'task_running'
        };
    }
    return undefined;
}

export class GoalService {
    static async create(task: TaskState, input: CreateGoalInput): Promise<GoalCommandResult> {
        const readinessError = await waitForGoalStartReadiness(task);
        if (readinessError) return readinessError;

        const created = GoalController.create(task, input);
        if (!created.ok) return created;
        const started = await GoalScheduler.startExecution(task, 'create');
        if (!started.ok) {
            return { ...started, summary: GoalController.getStatus(task).summary };
        }
        return { ...created, startedScheduler: started.startedScheduler === true };
    }

    static async edit(
        task: TaskState,
        objective: string,
        source: GoalEvent['source'] = 'api',
        budgetUpdate?: GoalBudgetUpdate
    ): Promise<GoalCommandResult> {
        const result = GoalController.editObjective(task, objective, source, budgetUpdate);
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
        if (task.task_status !== 'running') {
            const started = await GoalScheduler.startExecution(task, 'resume');
            return { ...result, startedScheduler: started.startedScheduler === true };
        }
        return result;
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
        const resumed = GoalController.resumeStateOnly(task, options);
        if (!resumed.ok) return resumed;
        const started = await GoalScheduler.startExecution(
            task,
            'resume',
            options.promptOverride,
            options.note ? { note: options.note } : {}
        );
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
