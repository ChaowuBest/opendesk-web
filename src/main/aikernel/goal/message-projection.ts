import type { TaskState } from '../states/tasks.js';
import { UserMessage } from '../messages.js';
import { GoalEvents, GoalStates, createGoalEvent, type GoalCommandResult, type GoalEvent } from './state.js';

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
