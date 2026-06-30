export type GoalRenderStatus = 'active' | 'paused' | 'blocked' | 'complete' | 'cleared';

export type GoalActionId = 'edit-start' | 'pause' | 'resume' | 'create-new' | 'clear';

export function isTerminalGoalStatus(status: GoalRenderStatus | null | undefined): boolean {
    return status === 'complete' || status === 'cleared';
}

export function hasUnfinishedGoalStatus(status: GoalRenderStatus | null | undefined): boolean {
    return status !== null && status !== undefined && !isTerminalGoalStatus(status);
}

export function shouldShowGoalSuggestion(input: {
    todoCount: number;
    goalStatus?: GoalRenderStatus | null;
    goalCreating: boolean;
    dismissed: boolean;
}): boolean {
    return input.todoCount > 0 && !input.goalCreating && !input.dismissed && input.goalStatus == null;
}

export function isAttachedRunningGoalCreateResult(
    input:
        | {
              ok?: boolean;
              errorCode?: string;
              summary?: { status?: string } | null;
          }
        | null
        | undefined
): boolean {
    return input?.ok === false && input.errorCode === 'task_running' && input.summary?.status === 'active';
}

export function getGoalSectionActionIds(status: GoalRenderStatus): GoalActionId[] {
    if (status === 'cleared') {
        return ['create-new'];
    }
    if (status === 'complete') {
        return ['create-new', 'clear'];
    }

    const actions: GoalActionId[] = ['edit-start'];
    if (status === 'active') {
        actions.push('pause');
    } else if (status === 'paused' || status === 'blocked') {
        actions.push('resume');
    }
    actions.push('clear');
    return actions;
}
