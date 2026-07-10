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
import { createUserGoalDataBlock } from './prompt-data.js';
import { GoalRuntimeAdapter } from './runtime-adapter.js';
import {
    GoalEvents,
    GoalStates,
    createGoalEvent,
    type GoalEvent,
    type GoalEventLogStorage,
    type GoalFinalSnapshot,
    type GoalState
} from './state.js';
import { markStaleGoalToolCallSkipped } from './tool-call-guard.js';

export const GOAL_EXTENSION_KEY = 'goal';

export class TaskGoalContext implements TaskExtension {
    readonly key = GOAL_EXTENSION_KEY;
    state?: GoalState;
    finalSnapshots: GoalFinalSnapshot[] = [];
    eventLog?: GoalEventLogStorage;
    readonly runtime: GoalRuntimeAdapter;

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
        return markStaleGoalToolCallSkipped(toolCall, this.state, this.task.task_id);
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
        const prompt = [
            '<system-reminder>',
            '用户在当前 goal 执行期间提供了补充信息。请把这些内容作为当前 goal 的补充上下文使用。',
            '',
            ...createUserGoalDataBlock(
                'Supplemental context:',
                supplements.map((supplement) => ({
                    source: supplement.source,
                    content: supplement.content
                }))
            ),
            '</system-reminder>'
        ].join('\n');
        const rawText = supplements.map((supplement) => supplement.content).join('\n\n');

        await this.task.materializeExtensionPromptTurn(prompt, metadata, rawText);
        GoalEvents.appendToTask(
            this.task,
            createGoalEvent(goal, 'supplement_materialized', 'system', {
                stateEventType: 'goal.supplement.materialized',
                supplementIds: supplements.map((supplement) => supplement.id),
                turnGeneration
            })
        );
        this.task.persistLater();
        return true;
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
                goal.pendingContinuation = this.createRecoveryContinuation(
                    goal,
                    'OpenDesk 上次在执行当前 goal 时异常退出或重启，旧的执行栈已经不可恢复。',
                    'crash_recovery'
                );
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
                goal.pendingContinuation = this.createRecoveryContinuation(
                    goal,
                    '加载时发现 active goal 没有可恢复的 runner，请重新继续。',
                    'load_recovery'
                );
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

    private createRecoveryContinuation(
        goal: GoalState,
        reason: string,
        continuationReason: 'crash_recovery' | 'load_recovery'
    ) {
        const prompt = [
            '<system-reminder>',
            reason,
            '',
            ...createUserGoalDataBlock('Goal data:', {
                objective: goal.objective,
                successCriteria: goal.successCriteria
            }),
            '',
            '请根据当前 transcript、文件状态和 goal state 继续推进。',
            '</system-reminder>'
        ].join('\n');
        return GoalStates.createContinuation(goal, prompt, continuationReason);
    }
}

registerTaskExtension(GOAL_EXTENSION_KEY, (task) => new TaskGoalContext(task));

export function getGoalContext(task: TaskState): TaskGoalContext {
    return task.extensions.require<TaskGoalContext>(GOAL_EXTENSION_KEY);
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
            return getGoalContext(this).state;
        },
        set(this: TaskState, value: GoalState | undefined) {
            getGoalContext(this).state = value;
        }
    },
    goal_final_snapshots: {
        configurable: true,
        get(this: TaskState): GoalFinalSnapshot[] {
            return getGoalContext(this).finalSnapshots;
        },
        set(this: TaskState, value: GoalFinalSnapshot[]) {
            getGoalContext(this).finalSnapshots = value;
        }
    },
    goal_event_log: {
        configurable: true,
        get(this: TaskState): GoalEventLogStorage | undefined {
            return getGoalContext(this).eventLog;
        },
        set(this: TaskState, value: GoalEventLogStorage | undefined) {
            getGoalContext(this).eventLog = value;
        }
    },
    goalRuntime: {
        configurable: true,
        get(this: TaskState): GoalRuntimeAdapter {
            return getGoalContext(this).runtime;
        }
    },
    isGoalRuntimeInterrupted: {
        configurable: true,
        value(this: TaskState): boolean {
            return getGoalContext(this).isRuntimeInterrupted();
        }
    },
    publishGoalEvalUpdate: {
        configurable: true,
        value(this: TaskState, chunk: TaskUpdateGoalEvalChunk): void {
            getGoalContext(this).publishEvaluationUpdate(chunk);
        }
    },
    materializePendingGoalSupplements: {
        configurable: true,
        value(this: TaskState): Promise<boolean> {
            return getGoalContext(this).materializePendingSupplements();
        }
    }
});
