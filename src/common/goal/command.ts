export const GOAL_SUBCOMMANDS = ['help', 'pause', 'resume', 'clear'] as const;

export type GoalSubcommand = (typeof GOAL_SUBCOMMANDS)[number];

export type ParsedGoalCommand =
    | { kind: 'help' }
    | { kind: 'subcommand'; subcommand: Exclude<GoalSubcommand, 'help'>; rest: string }
    | { kind: 'objective'; objective: string };

export interface GoalCommandResultLike {
    ok?: boolean;
    messageKey?: string;
    messageArgs?: Record<string, unknown>;
    clearedActiveGoal?: boolean;
}

export interface GoalCommandMessage {
    messageKey: string;
    messageArgs?: Record<string, unknown>;
}

export type GoalCommandStatus = 'active' | 'paused' | 'blocked' | 'complete' | 'cleared';

export interface GoalCommandSnapshotLike {
    id: string;
    revision: number;
    status: GoalCommandStatus;
    objective: string;
}

export interface GoalEditIfMatch {
    id: string;
    revision: number;
    status: GoalCommandStatus;
}

const GOAL_COMMAND_STATUSES = new Set<GoalCommandStatus>(['active', 'paused', 'blocked', 'complete', 'cleared']);

export function parseGoalEditIfMatch(raw: unknown): GoalEditIfMatch | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const value = raw as Record<string, unknown>;
    if (
        typeof value.id !== 'string' ||
        value.id.trim().length === 0 ||
        typeof value.revision !== 'number' ||
        !Number.isInteger(value.revision) ||
        value.revision <= 0 ||
        typeof value.status !== 'string' ||
        !GOAL_COMMAND_STATUSES.has(value.status as GoalCommandStatus)
    ) {
        return undefined;
    }
    return {
        id: value.id,
        revision: value.revision,
        status: value.status as GoalCommandStatus
    };
}

export type GoalEditConflictReason = 'goal_missing' | 'goal_replaced' | 'revision_changed' | 'status_changed';

export interface GoalEditConflict {
    reason: GoalEditConflictReason;
    expected: GoalEditIfMatch;
    current?: GoalCommandSnapshotLike;
}

export type GoalObjectiveAction =
    | { kind: 'create' }
    | { kind: 'noop' }
    | {
          kind: 'edit';
          currentGoal: GoalCommandSnapshotLike;
          ifMatch: GoalEditIfMatch;
      };

export function isGoalSubcommand(value: string): value is GoalSubcommand {
    return GOAL_SUBCOMMANDS.includes(value as GoalSubcommand);
}

export function parseGoalCommandArgs(args: string): ParsedGoalCommand {
    const trimmed = args.trim();
    if (trimmed.length === 0) {
        return { kind: 'help' };
    }

    const firstSpace = trimmed.indexOf(' ');
    const head = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
    const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1);

    if (head === 'help') {
        return { kind: 'help' };
    }
    if (isGoalSubcommand(head)) {
        return { kind: 'subcommand', subcommand: head, rest };
    }
    return { kind: 'objective', objective: trimmed };
}

export function validateGoalSubcommandArgs(
    subcommand: Exclude<GoalSubcommand, 'help'>,
    rest: string
): { ok: true } | { ok: false; messageKey: string } {
    if (subcommand === 'pause' && rest.trim().length > 0) {
        return { ok: false, messageKey: 'goal.pause.unexpected_args' };
    }
    if (subcommand === 'resume' && rest.trim().length > 0) {
        return { ok: false, messageKey: 'goal.resume.unexpected_args' };
    }
    if (subcommand === 'clear' && rest.trim().length > 0) {
        return { ok: false, messageKey: 'goal.clear.unexpected_args' };
    }
    return { ok: true };
}

export function goalResultToMessageKey(result: GoalCommandResultLike | undefined): GoalCommandMessage | undefined {
    if (!result || result.ok !== false) {
        return undefined;
    }
    return {
        messageKey: result.messageKey ?? 'goal.error.unknown',
        messageArgs: result.messageArgs
    };
}

export function getGoalSubcommandCompletions(argPrefix: string): GoalSubcommand[] {
    const trimmed = argPrefix.trim();
    if (trimmed.length === 0) {
        return [];
    }
    if (argPrefix.includes(' ') && !argPrefix.endsWith(' ')) {
        return [];
    }
    return GOAL_SUBCOMMANDS.filter((cmd) => cmd.startsWith(trimmed));
}

export function isTerminalGoalStatus(status: unknown): boolean {
    return status === 'complete' || status === 'cleared';
}

export function decideGoalObjectiveAction(
    goal: GoalCommandSnapshotLike | null | undefined,
    objective: string
): GoalObjectiveAction {
    if (!goal || isTerminalGoalStatus(goal.status)) {
        return { kind: 'create' };
    }
    if (goal.objective === objective.trim()) {
        return { kind: 'noop' };
    }
    const currentGoal = {
        id: goal.id,
        revision: goal.revision,
        status: goal.status,
        objective: goal.objective
    };
    return {
        kind: 'edit',
        currentGoal,
        ifMatch: {
            id: currentGoal.id,
            revision: currentGoal.revision,
            status: currentGoal.status
        }
    };
}
