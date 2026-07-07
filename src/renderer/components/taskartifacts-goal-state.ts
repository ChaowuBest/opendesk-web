export type GoalRenderStatus = 'active' | 'paused' | 'blocked' | 'complete' | 'cleared';

export type GoalActionId = 'edit-start' | 'pause' | 'resume' | 'create-new' | 'clear';

export interface GoalTodoSnapshotItem {
    id?: unknown;
    title?: unknown;
    content?: unknown;
    status?: unknown;
    updated_at?: unknown;
    completed_at?: unknown;
}

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

export function getTaskTodoSnapshotKey(todos: GoalTodoSnapshotItem[] | null | undefined): string {
    if (!Array.isArray(todos) || todos.length === 0) return '[]';
    return JSON.stringify(
        todos.map((todo) => ({
            id: typeof todo.id === 'string' ? todo.id : '',
            title: typeof todo.title === 'string' ? todo.title : '',
            content: typeof todo.content === 'string' ? todo.content : '',
            status: typeof todo.status === 'string' ? todo.status : '',
            updated_at: typeof todo.updated_at === 'string' ? todo.updated_at : '',
            completed_at: typeof todo.completed_at === 'string' ? todo.completed_at : ''
        }))
    );
}

export function shouldAutoCollapseTerminalGoalDetails(input: {
    goalId?: string | null;
    goalStatus?: GoalRenderStatus | null;
    previousTodoSnapshotKey?: string | null;
    nextTodoSnapshotKey: string;
    collapseAlreadyApplied: boolean;
    source?: 'initial' | 'refresh' | 'live-update';
}): boolean {
    return (
        input.source === 'live-update' &&
        typeof input.goalId === 'string' &&
        input.goalId.length > 0 &&
        isTerminalGoalStatus(input.goalStatus) &&
        !input.collapseAlreadyApplied &&
        typeof input.previousTodoSnapshotKey === 'string' &&
        input.previousTodoSnapshotKey !== input.nextTodoSnapshotKey
    );
}
