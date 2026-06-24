import { ChatContext, CompactSeparatorMessage, isCompactBoundaryMessage, type ChatMessage } from '../messages.js';
import type { TaskState } from '../states/tasks.js';

export interface GoalProjectionOptions {
    includeInterlude?: boolean;
}

export function buildGoalContextProjection(task: TaskState, options: GoalProjectionOptions = {}): ChatContext {
    const goal = task.goal_state;
    const projected = new ChatContext();
    projected.system_prompt = task.chat_context.system_prompt;
    if (!goal) {
        projected.messages = [...task.chat_context.messages];
        return projected;
    }

    const messages: ChatMessage[] = [];
    for (const message of task.chat_context.messages) {
        const projectedMessage = projectMessage(message, goal.id, options);
        if (projectedMessage) messages.push(projectedMessage);
    }
    projected.messages = messages;
    return projected;
}

function projectMessage(message: ChatMessage, goalId: string, options: GoalProjectionOptions): ChatMessage | undefined {
    if (isCompactBoundaryMessage(message)) {
        return projectCompactBoundary(message, goalId, options);
    }

    const scope = message.metadata?.scope;
    if (scope === 'interlude') return options.includeInterlude === true ? message : undefined;
    if (scope === 'goal') {
        const controllerId = message.metadata?.execution?.controllerId;
        return !controllerId || controllerId === goalId ? message : undefined;
    }
    return message;
}

function projectCompactBoundary(
    message: CompactSeparatorMessage,
    goalId: string,
    options: GoalProjectionOptions
): CompactSeparatorMessage | undefined {
    if (options.includeInterlude === true) return message;

    const segments = message.metadata.summarySegments;
    if (segments && segments.length > 0) {
        const keptSegments = segments.filter((segment) => {
            if (segment.scope === 'global') return true;
            return segment.scope === 'goal' && segment.goalId === goalId;
        });

        if (keptSegments.length === 0) return undefined;
        return new CompactSeparatorMessage(keptSegments.map((segment) => segment.text).join('\n\n'), {
            ...message.metadata,
            projection: {
                projectionPolicy: 'goal_only',
                summarizedScopes: Array.from(new Set(keptSegments.map((segment) => segment.scope))),
                summarizedGoalIds: Array.from(
                    new Set(keptSegments.map((segment) => segment.goalId).filter((id): id is string => !!id))
                ),
                containsInterlude: false,
                includedScopes: ['goal', 'global'],
                excludedScopes: ['interlude']
            },
            summarySegments: keptSegments
        });
    }

    const projection = message.metadata.projection;
    if (!projection) return undefined;
    if (projection.containsInterlude === true || projection.summarizedScopes.includes('interlude')) return undefined;
    if (
        projection.summarizedGoalIds &&
        projection.summarizedGoalIds.length > 0 &&
        !projection.summarizedGoalIds.includes(goalId)
    ) {
        return undefined;
    }
    return message;
}
