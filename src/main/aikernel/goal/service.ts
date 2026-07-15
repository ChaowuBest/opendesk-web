import { UserMessage } from '../messages.js';
import type { TaskState } from '../states/tasks.js';
import { deleteTaskTodos, resetInProgressTaskTodos } from '../todos/task-todos.js';
import { GoalController, type GoalObjectiveEditOptions, type GoalPausedOrBlockedSnapshot } from './controller.js';
import { GoalScheduler } from './scheduler.js';
import {
    GoalEvents,
    GoalStates,
    createGoalEvent,
    type AddGoalSupplementInput,
    type CreateGoalInput,
    type GoalCommandResult,
    type GoalEvent,
    type ResumeGoalOptions
} from './state.js';

export type GoalDisplayProjectionType = 'create' | 'edit';

function displayEventType(type: GoalDisplayProjectionType): GoalEvent['type'] {
    return type === 'create' ? 'created' : 'edited';
}

function displayReason(type: GoalDisplayProjectionType): string {
    return type === 'create' ? 'goal_create_display' : 'goal_edit_display';
}

function appendGoalDisplayMessage(
    task: TaskState,
    input: {
        objective: string;
        goalId: string;
        goalRevision: number;
        reason: string;
    }
): string {
    const message = new UserMessage(`/goal ${input.objective}`);
    message.rawText = `/goal ${input.objective}`;
    message.metadata = {
        scope: 'goal',
        origin: { source: 'internal', reason: input.reason },
        execution: {
            controller: 'goal',
            controllerId: input.goalId,
            controllerRevision: input.goalRevision
        }
    };
    task.chat_context.appendMessage(message);
    void task.sendSubscriptionFeedback(0);
    return message.message_id;
}

function findLatestGoalEvent(
    task: TaskState,
    input: {
        eventType: GoalEvent['type'];
        goalId: string;
        goalRevision: number;
    }
): GoalEvent | undefined {
    const events = GoalEvents.getTail(task.goal_event_log);
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.goalId !== input.goalId || event.revision !== input.goalRevision || event.type !== input.eventType) {
            continue;
        }
        return event;
    }
    return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasDisplayProjection(task: TaskState, targetEvent: GoalEvent): boolean {
    const events = GoalEvents.getTail(task.goal_event_log);
    return events.some((event) => {
        if (event.goalId !== targetEvent.goalId || event.type !== 'display_projected' || !isObject(event.payload)) {
            return false;
        }
        return event.payload.targetEventId === targetEvent.id && typeof event.payload.displayMessageId === 'string';
    });
}

export function projectGoalDisplayMessage(
    task: TaskState,
    result: GoalCommandResult,
    type: GoalDisplayProjectionType,
    objective: string
): GoalCommandResult {
    if (!result.ok) return result;

    const goal = task.goal_state;
    if (!goal) return result;
    const event = findLatestGoalEvent(task, {
        eventType: displayEventType(type),
        goalId: goal.id,
        goalRevision: goal.revision
    });
    if (!event) return result;
    if (hasDisplayProjection(task, event)) {
        return {
            ...result,
            summary: GoalStates.renderSummary(task.goal_state, task.goal_event_log)
        };
    }

    const displayMessageId = appendGoalDisplayMessage(task, {
        objective,
        goalId: goal.id,
        goalRevision: goal.revision,
        reason: displayReason(type)
    });
    GoalEvents.appendToTask(
        task,
        createGoalEvent(goal, 'display_projected', 'system', {
            targetEventId: event.id,
            targetEventType: event.type,
            targetRevision: event.revision,
            displayMessageId
        })
    );
    task.persistLater();

    return {
        ...result,
        summary: GoalStates.renderSummary(task.goal_state, task.goal_event_log)
    };
}

const RESUME_INTERRUPT_SETTLE_TIMEOUT_MS = 2_000;
const RESUME_INTERRUPT_POLL_MS = 50;

export interface GoalServiceDisplayOptions {
    projectDisplayMessage?: boolean;
}

export interface GoalServiceEditOptions extends GoalServiceDisplayOptions, GoalObjectiveEditOptions {}

function hasPendingRuntimeInterrupt(task: TaskState): boolean {
    return task.runtimeInterrupt?.requested === true && !task.runtimeInterrupt.handledAt;
}

async function waitForPendingRuntimeInterrupt(task: TaskState): Promise<boolean> {
    const deadline = Date.now() + RESUME_INTERRUPT_SETTLE_TIMEOUT_MS;
    while (hasPendingRuntimeInterrupt(task)) {
        if (task.settleRuntimeInterruptIfTaskStopped()) return true;
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
        task.goalRuntime.injectGoalEditReminder({
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
    static async create(
        task: TaskState,
        input: CreateGoalInput,
        options: GoalServiceDisplayOptions = {}
    ): Promise<GoalCommandResult> {
        const readinessError = await waitForGoalCreateReadiness(task);
        if (readinessError) return readinessError;

        const wasRunningAtCreate = task.task_status === 'running';
        let created = GoalController.create(task, input);
        if (!created.ok) return created;
        if (options.projectDisplayMessage === true) {
            created = projectGoalDisplayMessage(task, created, 'create', input.objective);
        }

        if (wasRunningAtCreate) {
            return attachCreatedGoalToRunningTurn(task, created);
        }

        return startCreatedGoal(task, created, { attachToRunningTurn: true });
    }

    static async edit(
        task: TaskState,
        objective: string,
        source: GoalEvent['source'] = 'api',
        options: GoalServiceEditOptions = {}
    ): Promise<GoalCommandResult> {
        const wasBlockedBeforeEdit = task.goal_state?.status === 'blocked';
        let result = GoalController.editObjective(task, objective, source, { ifMatch: options.ifMatch });
        if (!result.ok) return result;
        if (options.projectDisplayMessage === true) {
            result = projectGoalDisplayMessage(task, result, 'edit', objective);
        }
        const goal = task.goal_state;
        if (!goal) {
            return result;
        }
        if (wasBlockedBeforeEdit && goal.status === 'blocked') {
            return this.resumeBlockedGoalAfterEdit(task, result, source);
        }
        if (goal.status !== 'active') {
            return result;
        }
        if (task.task_status === 'running') {
            task.goalRuntime.injectGoalEditReminder({
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
                task.goalRuntime.injectGoalEditReminder({
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

    private static async resumeBlockedGoalAfterEdit(
        task: TaskState,
        editResult: GoalCommandResult,
        source: GoalEvent['source']
    ): Promise<GoalCommandResult> {
        if (task.task_status === 'running') {
            return {
                ...editResult,
                startedScheduler: false,
                summary: GoalController.getStatus(task).summary
            };
        }

        const goal = task.goal_state;
        const previous: GoalPausedOrBlockedSnapshot | undefined =
            goal?.status === 'blocked'
                ? {
                      status: 'blocked',
                      pauseReason: goal.pauseReason,
                      blockedReason: goal.blockedReason,
                      pausedAt: goal.pausedAt,
                      resumedAt: goal.resumedAt
                  }
                : undefined;
        const resumed = GoalController.resumeStateOnly(task, { source });
        if (!resumed.ok) return resumed;

        let started: GoalCommandResult;
        try {
            started = await GoalScheduler.startExecution(task, 'resume');
        } catch {
            started = schedulerStartFailedResult(task);
        }
        if (!started.ok) {
            if (previous) {
                return GoalController.restorePausedOrBlockedAfterSchedulerFailure(task, previous, started);
            }
            return { ...started, summary: GoalController.getStatus(task).summary };
        }
        return {
            ...editResult,
            status: task.goal_state?.status,
            startedScheduler: started.startedScheduler === true,
            summary: GoalController.getStatus(task).summary
        };
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
                cancelPermissionPrompts: true,
                skipFinishHooks: true
            });
            interruptedRunner = true;
        }
        return { ...result, interruptedRunner };
    }

    static async stopActiveGoal(task: TaskState, source: GoalEvent['source'] = 'api'): Promise<GoalCommandResult> {
        if (task.goal_state?.status !== 'active') {
            return {
                ok: false,
                status: task.goal_state?.status,
                messageKey: 'goal.resume.invalid_status',
                messageArgs: { status: task.goal_state?.status ?? 'none' },
                errorCode: 'invalid_status'
            };
        }

        const result = GoalController.pause(task, source);
        if (!result.ok) return result;
        let interruptedRunner = false;
        if (task.task_status === 'running') {
            await task.interruptRunningTurn({
                reason: 'goal_pause',
                stopRunningTools: true,
                cancelPermissionPrompts: true,
                userInitiated: true,
                skipFinishHooks: true
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
            started = await GoalScheduler.startExecution(task, 'resume', options.promptOverride);
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
                cancelPermissionPrompts: true,
                skipFinishHooks: true
            });
            interruptedRunner = true;
        }
        return { ...result, interruptedRunner };
    }
}
