/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { logger } from '../../utils/logger.js';
import type { RuntimeMetadata, ToolCall } from '../messages.js';
import type { TaskState } from '../states/tasks.js';
import { GoalController } from './controller.js';
import { buildGoalEditReminderPrompt } from './prompts.js';
import { GoalScheduler } from './scheduler.js';
import { GoalEvents, GoalStates, createGoalEvent, type GoalEvent, type GoalState } from './state.js';

export type GoalPromptInjectionReason = 'goal_create' | 'goal_edit';

export interface GoalPromptInjectionRequestedEvent {
    id: string;
    type: 'goal.prompt_injection.requested';
    taskId: string;
    goalId: string;
    revision: number;
    occurredAt: string;
    source: GoalEvent['source'];
    payload: {
        objective: string;
        reason: GoalPromptInjectionReason;
    };
}

export function createGoalPromptInjectionRequestedEvent(input: {
    taskId: string;
    goalId: string;
    goalRevision: number;
    objective: string;
    reason: GoalPromptInjectionReason;
    source?: GoalEvent['source'];
}): GoalPromptInjectionRequestedEvent {
    return {
        id: crypto.randomUUID(),
        type: 'goal.prompt_injection.requested',
        taskId: input.taskId,
        goalId: input.goalId,
        revision: input.goalRevision,
        occurredAt: new Date().toISOString(),
        source: input.source ?? 'system',
        payload: {
            objective: input.objective,
            reason: input.reason
        }
    };
}

export interface StaleGoalRevisionResult {
    skipped: true;
    reason: 'stale_goal_revision';
    goalRevision: number;
    currentGoalRevision: number;
}

function getStaleGoalRevisionResult(
    toolCall: ToolCall,
    goal: GoalState | undefined
): StaleGoalRevisionResult | undefined {
    const execution = toolCall.metadata?.execution;
    if (
        execution?.controller !== 'goal' ||
        !goal ||
        execution.controllerId !== goal.id ||
        typeof execution.controllerRevision !== 'number' ||
        execution.controllerRevision === goal.revision
    ) {
        return undefined;
    }
    return {
        skipped: true,
        reason: 'stale_goal_revision',
        goalRevision: execution.controllerRevision,
        currentGoalRevision: goal.revision
    };
}

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
    reason: GoalPromptInjectionReason;
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

    beforeToolCall(toolCall: ToolCall): boolean {
        const task = this.host.getTask();
        const result = getStaleGoalRevisionResult(toolCall, task.goal_state);
        if (!result) return false;
        toolCall.status = 'error';
        toolCall.result_object = result;
        toolCall.result = JSON.stringify(result);
        toolCall.rendered = undefined;
        logger.warn(
            `task ${task.task_id}: skipped stale goal tool call ${toolCall.tool_name} ` +
                `(goal revision ${result.goalRevision}, current ${result.currentGoalRevision})`
        );
        return true;
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
            const prompt = buildGoalEditReminderPrompt(
                {
                    revision: event.revision,
                    objective
                },
                reason
            );
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
