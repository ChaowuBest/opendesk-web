import { logger } from '../../utils/logger.js';
import type { ToolCall } from '../messages.js';
import type { GoalState } from './state.js';

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

export function markStaleGoalToolCallSkipped(toolCall: ToolCall, goal: GoalState | undefined, taskId: string): boolean {
    const result = getStaleGoalRevisionResult(toolCall, goal);
    if (!result) return false;
    toolCall.status = 'error';
    toolCall.result_object = result;
    toolCall.result = JSON.stringify(result);
    toolCall.rendered = undefined;
    logger.warn(
        `task ${taskId}: skipped stale goal tool call ${toolCall.tool_name} ` +
            `(goal revision ${result.goalRevision}, current ${result.currentGoalRevision})`
    );
    return true;
}
