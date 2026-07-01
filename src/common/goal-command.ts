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
}

export interface GoalCommandMessage {
    messageKey: string;
    messageArgs?: Record<string, unknown>;
}

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
