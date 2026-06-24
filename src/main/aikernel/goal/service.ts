import type { TaskState } from '../states/tasks.js';
import { GoalController } from './controller.js';
import { GoalScheduler } from './scheduler.js';
import type { CreateGoalInput, GoalCommandResult, GoalEvent, ResumeGoalOptions } from './state.js';

export class GoalService {
    static async create(task: TaskState, input: CreateGoalInput): Promise<GoalCommandResult> {
        const created = GoalController.create(task, input);
        if (!created.ok) return created;
        const started = await GoalScheduler.startExecution(task, 'create');
        return { ...created, startedScheduler: started.startedScheduler === true };
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
        if (task.task_status !== 'running') {
            const started = await GoalScheduler.startExecution(task, 'resume');
            return { ...result, startedScheduler: started.startedScheduler === true };
        }
        return result;
    }

    static async pause(
        task: TaskState,
        reason?: string,
        source: GoalEvent['source'] = 'api'
    ): Promise<GoalCommandResult> {
        const result = GoalController.pause(task, reason, source);
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
        const started = await GoalScheduler.startExecution(task, 'resume', options.promptOverride);
        return { ...resumed, startedScheduler: started.startedScheduler === true };
    }

    static async clear(task: TaskState, source: GoalEvent['source'] = 'api'): Promise<GoalCommandResult> {
        const result = GoalController.clear(task, source);
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
