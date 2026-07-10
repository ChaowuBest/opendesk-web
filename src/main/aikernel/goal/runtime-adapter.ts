import { logger } from '../../utils/logger.js';
import type { RuntimeMetadata } from '../messages.js';
import type { TaskState } from '../states/tasks.js';
import { GoalController } from './controller.js';
import { createGoalPromptInjectionRequestedEvent, type GoalPromptInjectionRequestedEvent } from './machine.js';
import { createUserGoalDataBlock } from './prompt-data.js';
import { GoalScheduler } from './scheduler.js';
import { GoalEvents, GoalStates, createGoalEvent } from './state.js';

export type GoalRuntimeCheckpoint =
    | 'after_completion'
    | 'after_tools'
    | 'after_tool_turn'
    | 'before_finish'
    | 'after_finish_hooks'
    | 'after_hook_backoff';

export interface GoalRuntimeCheckpointOptions {
    includeSupplements?: boolean;
}

export type GoalRuntimeMaterialize = (options?: GoalRuntimeCheckpointOptions) => Promise<boolean>;

export interface GoalEditReminderInput {
    goalId: string;
    goalRevision: number;
    objective: string;
    reason: 'goal_create' | 'goal_edit';
}

export interface GoalRuntimeHost {
    getTask(): TaskState;
    getTurnGeneration(): number;
    materializePromptTurn(prompt: string, metadata: RuntimeMetadata): Promise<void>;
}

export class GoalRuntimeAdapter {
    private pendingGoalEditReminders: GoalPromptInjectionRequestedEvent[] = [];

    constructor(
        private readonly host: GoalRuntimeHost,
        private readonly materializeSupplements: GoalRuntimeMaterialize
    ) {}

    injectGoalEditReminder(input: GoalEditReminderInput): void {
        this.pendingGoalEditReminders.push(
            createGoalPromptInjectionRequestedEvent({
                taskId: this.host.getTask().task_id,
                goalId: input.goalId,
                goalRevision: input.goalRevision,
                objective: input.objective,
                reason: input.reason,
                source: 'system'
            })
        );
    }

    /** 清除所有悬空的 goal edit reminder。当 hook 已通过 reject 机制处理了编辑通知时使用，避免重复注入。 */
    clearPendingGoalEditReminders(): void {
        this.pendingGoalEditReminders = [];
    }

    private async materializePendingGoalEditReminders(): Promise<boolean> {
        if (this.pendingGoalEditReminders.length === 0) return false;
        const promptInjections = this.pendingGoalEditReminders.splice(0);
        let materialized = false;
        for (const event of promptInjections) {
            const task = this.host.getTask();
            const { reason, objective } = event.payload;
            const currentGoal = task.goal_state;
            if (
                !currentGoal ||
                currentGoal.id !== event.goalId ||
                currentGoal.revision !== event.revision ||
                currentGoal.status !== 'active'
            ) {
                continue;
            }
            const turnGeneration = this.host.getTurnGeneration();
            const metadata: RuntimeMetadata = {
                scope: 'goal',
                origin: { source: 'internal', reason },
                execution: {
                    generation: turnGeneration,
                    controller: 'goal',
                    controllerId: event.goalId,
                    controllerRevision: event.revision
                }
            };
            const prompt =
                reason === 'goal_create'
                    ? [
                          '<system-reminder>',
                          '用户在当前任务运行中创建新的 goal。继续利用当前上下文和已有 TodoWrite，但后续推进必须围绕这个 goal objective 展开。',
                          '',
                          ...createUserGoalDataBlock('Goal data:', {
                              revision: event.revision,
                              objective
                          }),
                          '</system-reminder>'
                      ].join('\n')
                    : [
                          '<system-reminder>',
                          '当前 goal objective 已被用户修改。必须停止按旧 objective 推进，改为按新 revision 继续。',
                          '',
                          ...createUserGoalDataBlock('Goal data:', {
                              revision: event.revision,
                              objective
                          }),
                          '</system-reminder>'
                      ].join('\n');
            await this.host.materializePromptTurn(prompt, metadata);
            materialized = true;
            if (reason === 'goal_edit') {
                GoalController.consumePendingEditContinuation(task, event.goalId, event.revision);
            }
            const goal = task.goal_state;
            if (goal && goal.id === event.goalId && goal.revision === event.revision) {
                GoalEvents.appendToTask(
                    task,
                    createGoalEvent(goal, 'prompt_injection_materialized', 'system', {
                        stateEventType: 'goal.prompt_injection.materialized',
                        reason,
                        turnGeneration
                    })
                );
                task.persistLater();
            }
        }
        return materialized;
    }

    async checkpoint(_checkpoint: GoalRuntimeCheckpoint, options: GoalRuntimeCheckpointOptions = {}): Promise<boolean> {
        const materializedPromptInjections = await this.materializePendingGoalEditReminders();
        if (materializedPromptInjections) return true;
        if (options.includeSupplements === false) return false;
        return this.materializeSupplements(options);
    }

    afterTurnFinished(): void {
        const task = this.host.getTask();
        if (!GoalStates.hasPendingContinuation(task.goal_state)) return;
        void GoalScheduler.startExecution(task, 'resume').catch((error) => {
            logger.warn(
                `task ${task.task_id}: failed to resume pending goal continuation after turn: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        });
    }
}
