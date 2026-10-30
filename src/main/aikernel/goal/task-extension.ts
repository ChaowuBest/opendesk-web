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
import { type RuntimeMetadata, type ToolCall } from '../messages.js';
import {
    registerTaskExtension,
    type TaskExtension,
    type TaskExtensionCheckpoint,
    type TaskExtensionCheckpointOptions,
    type TaskExtensionInputResult
} from '../task-extension.js';
import { TaskState, type TaskUpdateGoalEvalChunk } from '../states/tasks.js';
import { GoalController } from './controller.js';
import { buildGoalRecoveryPrompt, buildGoalSupplementPrompt } from './prompts.js';
import { GoalRuntimeAdapter } from './runtime-adapter.js';
import {
    GoalEvents,
    GoalStates,
    createGoalEvent,
    type GoalEvent,
    type GoalEventLogStorage,
    type GoalFinalSnapshot,
    type GoalState,
    type GoalSupplement
} from './state.js';

export const GOAL_EXTENSION_KEY = 'goal';

export class GoalTaskExtension implements TaskExtension {
    readonly key = GOAL_EXTENSION_KEY;
    state?: GoalState;
    finalSnapshots: GoalFinalSnapshot[] = [];
    eventLog?: GoalEventLogStorage;
    readonly runtime: GoalRuntimeAdapter;
    /** 补充消息投递（准备并启动回合）是否正在进行，用于同步隔离并发投递。 */
    private supplementTurnStarting = false;

    constructor(readonly task: TaskState) {
        this.runtime = new GoalRuntimeAdapter(
            {
                getTask: () => this.task,
                getTurnGeneration: () => this.task.getTurnGeneration(),
                materializePromptTurn: async (prompt, metadata) => {
                    await this.task.materializeExtensionPromptTurn(prompt, metadata);
                }
            },
            () => this.materializePendingSupplements()
        );
    }

    restore(raw: Record<string, unknown>, wasRunningAtShutdown: boolean): void {
        this.state = GoalStates.deserialize(raw.goal_state, this.task.task_id);
        this.finalSnapshots = GoalStates.deserializeFinalSnapshots(raw.goal_final_snapshots, this.task.task_id);
        if (Array.isArray(raw.goal_event_log_tail) || typeof raw.goal_event_log_artifact === 'string') {
            this.eventLog = {
                mode: 'artifact',
                tail: GoalEvents.deserializeEvents(raw.goal_event_log_tail),
                artifactPath: typeof raw.goal_event_log_artifact === 'string' ? raw.goal_event_log_artifact : ''
            };
        } else {
            this.eventLog = GoalEvents.deserialize(raw.goal_event_log);
        }
        this.normalizeLoadedState(wasRunningAtShutdown);
    }

    serialize(): Record<string, unknown> {
        return {
            goal_state: GoalStates.serialize(this.state),
            goal_final_snapshots: this.finalSnapshots,
            goal_event_log: GoalEvents.serialize(this.eventLog),
            goal_event_log_tail: undefined,
            goal_event_log_artifact: undefined
        };
    }

    /**
     * 释放目标状态（评估历史、事件日志等）。这些快照存于扩展实例，
     * 不随 chat_context 清空而释放，必须在 TaskState.unload() 时显式重置；
     * 数据已先经 serialize() 落盘，重新加载时会由 restore() 还原。
     */
    unload(): void {
        this.state = undefined;
        this.finalSnapshots = [];
        this.eventLog = undefined;
    }

    toSimplifiedJSON(): Record<string, unknown> {
        return {
            goal: GoalStates.renderSummary(this.state, undefined, {
                includeEvaluationHistory: false,
                includeCleared: true
            })
        };
    }

    toRenderJSON(): Record<string, unknown> {
        return {
            goal: GoalStates.renderSummary(this.state, this.eventLog, { includeCleared: true }),
            goal_final_snapshots: this.finalSnapshots.map((snapshot) => ({
                ...snapshot,
                ...(snapshot.lastEvaluation
                    ? {
                          lastEvaluation: {
                              ...snapshot.lastEvaluation,
                              evidence: [...snapshot.lastEvaluation.evidence]
                          }
                      }
                    : {})
            }))
        };
    }

    async handleUserMessage(message: string, imageDataUris?: string[]): Promise<TaskExtensionInputResult | undefined> {
        if (this.state?.status !== 'active' || this.task.task_status !== 'running') return undefined;
        if (imageDataUris && imageDataUris.length > 0) {
            return { status: 'error', messageKey: 'goal.supplement.images_unsupported' };
        }
        const supplement = GoalController.addSupplement(this.task, { content: message, source: 'user_message' });
        if (!supplement.ok) {
            return {
                status: 'error',
                messageKey: supplement.messageKey ?? 'goal.error.unknown',
                messageArgs: supplement.messageArgs
            };
        }
        return { status: 'ok', supplementId: supplement.supplementId };
    }

    getAssistantMetadata(userMetadata?: RuntimeMetadata): RuntimeMetadata | undefined {
        if (userMetadata?.scope !== 'interlude') return undefined;
        return {
            scope: 'interlude',
            origin: { source: 'user', reason: 'goal_paused_interlude' }
        };
    }

    onHistoryMutation(source: string): void {
        GoalController.blockForHistoryMutation(this.task, source as GoalEvent['source']);
    }

    prepareFork(target: TaskState): void {
        GoalController.prepareForkedGoal(this.task, target);
    }

    beforeToolCall(toolCall: ToolCall): boolean {
        return this.runtime.beforeToolCall(toolCall);
    }

    checkpoint(checkpoint: TaskExtensionCheckpoint, options: TaskExtensionCheckpointOptions = {}): Promise<boolean> {
        return this.runtime.checkpoint(checkpoint, options);
    }

    onTurnIterationFailed(reason: string, skipIfRuntimeInterrupted: boolean): void {
        if (!skipIfRuntimeInterrupted || !this.isRuntimeInterrupted()) {
            GoalController.blockActiveGoal(this.task, reason, 'system');
        }
    }

    onTurnSettled(): void {
        if (this.state?.schedulerLease && this.state.status === 'active') {
            this.state.schedulerLease = undefined;
        }
    }

    afterTurnFinished(): void {
        this.runtime.afterTurnFinished();
        // pendingContinuation 由 runtime 起新回合，该回合的 checkpoint 会消费补充消息。
        // 没有 continuation 时补充消息就没人消费了：回合已经收尾，前端却还在等回复，
        // 消息会一直停在待消费状态（用户看不到任何 agent 反馈），这里补开一轮投递。
        const goal = this.state;
        if (!goal || goal.status !== 'active' || GoalStates.hasPendingContinuation(goal)) return;
        // 用户刚主动停掉回合（GUI/TUI 走暂停目标，这里兜住 ACP 等直接 stop 的入口）：
        // 不能为了投递补充消息把任务重新拉起来，留到用户下一次发消息时再投递
        if (this.task.stop_requested_by_user) return;
        if (!goal.pendingSupplements.some((supplement) => !supplement.consumedAt)) return;
        void this.startTurnWithPendingSupplements().catch((error) => {
            logger.warn(
                `task ${this.task.task_id}: failed to deliver pending goal supplements after turn: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        });
    }

    isRuntimeInterrupted(): boolean {
        return (
            this.task.runtimeInterrupt?.requested === true &&
            !this.task.runtimeInterrupt.handledAt &&
            (this.task.runtimeInterrupt.reason === 'goal_pause' || this.task.runtimeInterrupt.reason === 'goal_clear')
        );
    }

    publishEvaluationUpdate(chunk: TaskUpdateGoalEvalChunk): void {
        this.task.publishTaskUpdate(chunk, 'goal_eval');
    }

    async materializePendingSupplements(): Promise<boolean> {
        const goal = this.state;
        if (!goal || goal.status !== 'active') return false;

        const turnGeneration = this.task.getTurnGeneration();
        const supplements = GoalController.consumePendingSupplements(this.task, turnGeneration);
        if (supplements.length === 0) return false;

        const { prompt, rawText, metadata } = this.buildSupplementTurn(goal, supplements, turnGeneration);
        await this.task.materializeExtensionPromptTurn(prompt, metadata, rawText);
        this.recordSupplementDelivery(goal, supplements, turnGeneration);
        return true;
    }

    /**
     * 没有运行中的回合时，用待消费的补充消息开启一个新的目标回合。
     *
     * 补充消息只在回合执行的 checkpoint 被消费，因此回合已经收尾（或后台压根没有
     * 回合在跑）时它不会被任何人消费：前端会一直显示等待中的回显，用户看不到任何
     * agent 反馈，之后还可能在目标被清除时连同消息一起消失。这里直接开工投递。
     */
    async startTurnWithPendingSupplements(): Promise<boolean> {
        const goal = this.state;
        if (!goal || goal.status !== 'active') return false;
        // 已有回合在跑：它会在下一个 checkpoint 消费补充消息，无需再开一轮
        if (this.task.task_status === 'running') return false;
        // 目标的暂停/清除正在中断回合，等状态落定后再投递
        if (this.task.runtimeInterrupt?.requested && !this.task.runtimeInterrupt.handledAt) return false;
        // startInternalTurn 在把 task_status 置为 running 之前有多个 await，期间并发的
        // 第二次调用看不到 running 状态会重复起轮；这里同步置位，保证同一时刻只有一次投递
        if (this.supplementTurnStarting) return false;

        this.supplementTurnStarting = true;
        try {
            const turnGeneration = this.task.getNextTurnGeneration();
            const supplements = GoalController.consumePendingSupplements(this.task, turnGeneration);
            if (supplements.length === 0) return false;

            const { prompt, rawText, metadata } = this.buildSupplementTurn(goal, supplements, turnGeneration);
            await this.task.startInternalTurn({ prompt, rawText, source: 'goal_supplement', metadata });
            this.recordSupplementDelivery(goal, supplements, turnGeneration);
            return true;
        } finally {
            this.supplementTurnStarting = false;
        }
    }

    private recordSupplementDelivery(goal: GoalState, supplements: GoalSupplement[], turnGeneration: number): void {
        GoalEvents.appendToTask(
            this.task,
            createGoalEvent(goal, 'supplement_materialized', 'system', {
                stateEventType: 'goal.supplement.materialized',
                supplementIds: supplements.map((supplement) => supplement.id),
                turnGeneration
            })
        );
        this.task.persistLater();
    }

    private buildSupplementTurn(
        goal: GoalState,
        supplements: GoalSupplement[],
        turnGeneration: number
    ): { prompt: string; rawText: string; metadata: RuntimeMetadata } {
        const metadata: RuntimeMetadata = {
            scope: 'goal',
            origin: { source: 'internal', reason: 'goal_supplement' },
            execution: {
                generation: turnGeneration,
                controller: 'goal',
                controllerId: goal.id,
                controllerRevision: goal.revision,
                supplementIds: supplements.map((supplement) => supplement.id)
            }
        };
        const prompt = buildGoalSupplementPrompt(
            supplements.map((supplement) => ({
                source: supplement.source,
                content: supplement.content
            }))
        );
        const rawText = supplements.map((supplement) => supplement.content).join('\n\n');
        return { prompt, rawText, metadata };
    }

    private normalizeLoadedState(wasRunningAtShutdown: boolean): void {
        const goal = this.state;
        if (!goal) return;
        let changed = false;
        const at = new Date().toISOString();

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
                goal.pendingContinuation = this.createRecoveryContinuation(goal, 'crash_recovery');
            }
            GoalEvents.appendToTask(
                this.task,
                createGoalEvent(goal, 'paused', 'system', {
                    reason: goal.pauseReason,
                    wasTaskStatus: 'running'
                })
            );
            changed = true;
        } else if (goal.status === 'active' && this.task.task_status === 'waiting') {
            goal.status = 'paused';
            goal.pauseReason = 'active_goal_loaded_without_runner';
            goal.pausedAt = at;
            goal.updatedAt = at;
            if (!goal.pendingContinuation) {
                goal.pendingContinuation = this.createRecoveryContinuation(goal, 'load_recovery');
            }
            GoalEvents.appendToTask(
                this.task,
                createGoalEvent(goal, 'paused', 'system', {
                    reason: goal.pauseReason,
                    wasTaskStatus: 'waiting'
                })
            );
            this.task.task_status = 'stopped';
            changed = true;
        } else if ((goal.status === 'paused' || goal.status === 'blocked') && this.task.task_status === 'waiting') {
            this.task.task_status = 'stopped';
            changed = true;
        }

        if (changed) this.task._dirty = true;
    }

    private createRecoveryContinuation(goal: GoalState, continuationReason: 'crash_recovery' | 'load_recovery') {
        const prompt = buildGoalRecoveryPrompt(goal, continuationReason);
        return GoalStates.createContinuation(goal, prompt, continuationReason);
    }
}

registerTaskExtension(GOAL_EXTENSION_KEY, (task) => new GoalTaskExtension(task));

export function getGoalExtension(task: TaskState): GoalTaskExtension {
    return task.extensions.require<GoalTaskExtension>(GOAL_EXTENSION_KEY);
}

declare module '../states/tasks.js' {
    interface TaskState {
        goal_state?: GoalState;
        goal_final_snapshots: GoalFinalSnapshot[];
        goal_event_log?: GoalEventLogStorage;
        readonly goalRuntime: GoalRuntimeAdapter;
        isGoalRuntimeInterrupted(): boolean;
        publishGoalEvalUpdate(chunk: TaskUpdateGoalEvalChunk): void;
        materializePendingGoalSupplements(): Promise<boolean>;
    }
}

Object.defineProperties(TaskState.prototype, {
    goal_state: {
        configurable: true,
        get(this: TaskState): GoalState | undefined {
            return getGoalExtension(this).state;
        },
        set(this: TaskState, value: GoalState | undefined) {
            getGoalExtension(this).state = value;
        }
    },
    goal_final_snapshots: {
        configurable: true,
        get(this: TaskState): GoalFinalSnapshot[] {
            return getGoalExtension(this).finalSnapshots;
        },
        set(this: TaskState, value: GoalFinalSnapshot[]) {
            getGoalExtension(this).finalSnapshots = value;
        }
    },
    goal_event_log: {
        configurable: true,
        get(this: TaskState): GoalEventLogStorage | undefined {
            return getGoalExtension(this).eventLog;
        },
        set(this: TaskState, value: GoalEventLogStorage | undefined) {
            getGoalExtension(this).eventLog = value;
        }
    },
    goalRuntime: {
        configurable: true,
        get(this: TaskState): GoalRuntimeAdapter {
            return getGoalExtension(this).runtime;
        }
    },
    isGoalRuntimeInterrupted: {
        configurable: true,
        value(this: TaskState): boolean {
            return getGoalExtension(this).isRuntimeInterrupted();
        }
    },
    publishGoalEvalUpdate: {
        configurable: true,
        value(this: TaskState, chunk: TaskUpdateGoalEvalChunk): void {
            getGoalExtension(this).publishEvaluationUpdate(chunk);
        }
    },
    materializePendingGoalSupplements: {
        configurable: true,
        value(this: TaskState): Promise<boolean> {
            return getGoalExtension(this).materializePendingSupplements();
        }
    }
});
