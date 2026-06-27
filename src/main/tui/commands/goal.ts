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

import type { OpenDeskTUI } from '../entry.js';
import { ConfirmOverlay, InfoOverlay } from '../components/notice.js';
import { GoalService } from '../../aikernel/goal/service.js';
import { GoalStates } from '../../aikernel/goal/state.js';
import { t } from '../../../locale/index.js';

const GOAL_SUBCOMMANDS = ['help', 'pause', 'resume', 'clear'];
const GOAL_FLAG_DEFS = [
    {
        name: '--token-budget',
        descriptionKey: 'goal.completion.token_budget'
    },
    {
        name: '--max-attempts',
        descriptionKey: 'goal.completion.max_attempts'
    }
];

interface GoalFlags {
    tokenBudget?: number | null;
    maxAttempts?: number | null;
}

/**
 * 从输入中解析 --flags 并返回提取的标志和剩余文本。
 * 支持：--token-budget <N>、--max-attempts <N>。
 * 标志可出现在任何位置。
 */
function parseGoalFlags(input: string): { flags: GoalFlags; rest: string } {
    const flags: GoalFlags = {};
    let remaining = input;

    // --token-budget <N> (也支持 --token-budget=<N>)
    const tokenRe = /--token-budget[= ](\d+)/;
    const tokenMatch = remaining.match(tokenRe);
    if (tokenMatch) {
        const value = parseInt(tokenMatch[1], 10);
        flags.tokenBudget = value > 0 ? value : null;
        // 移除匹配到的 flag + value（可能前后有空格，但保留一个空格防连词）
        remaining = remaining
            .replace(tokenRe, '')
            .replace(/\s{2,}/g, ' ')
            .trim();
    }

    // --max-attempts <N> (也支持 --max-attempts=<N>)
    const attemptsRe = /--max-attempts[= ](\d+)/;
    const attemptsMatch = remaining.match(attemptsRe);
    if (attemptsMatch) {
        const value = parseInt(attemptsMatch[1], 10);
        flags.maxAttempts = value > 0 ? value : null;
        remaining = remaining
            .replace(attemptsRe, '')
            .replace(/\s{2,}/g, ' ')
            .trim();
    }

    return { flags, rest: remaining };
}

function getGoalFlagCompletions(argPrefix: string) {
    const usedFlags = new Set(
        Array.from(argPrefix.matchAll(/--(?:token-budget|max-attempts)\b/g)).map((match) => match[0])
    );
    const flagTokenMatch = argPrefix.match(/(?:^|\s)(--[a-z-]*)$/);
    if (!argPrefix.endsWith(' ') && !flagTokenMatch) return [];
    const currentFlagPrefix = flagTokenMatch?.[1] ?? '';
    const replacementPrefix =
        currentFlagPrefix.length > 0 ? argPrefix.slice(0, argPrefix.length - currentFlagPrefix.length) : argPrefix;
    return GOAL_FLAG_DEFS.filter((flag) => !usedFlags.has(flag.name) || currentFlagPrefix === flag.name)
        .filter((flag) => currentFlagPrefix.length === 0 || flag.name.startsWith(currentFlagPrefix))
        .map((flag) => ({
            value: `${replacementPrefix}${flag.name} `,
            label: flag.name,
            description: t(flag.descriptionKey)
        }));
}

/** 检查 goal 是否有未终结状态，用于新 goal 的替换确认。 */
function hasNonTerminalGoal(task: ReturnType<typeof getCurrentTask>): boolean {
    return !!task?.goal_state && !GoalStates.isTerminal(task.goal_state.status);
}

function showInfo(tui: OpenDeskTUI, titleKey: string, message: string): void {
    const info = new InfoOverlay(tui, {
        title: t(titleKey),
        message,
        closeLabel: t('common.close'),
        fullWidth: true
    });
    info.show();
}

function showHelp(tui: OpenDeskTUI): void {
    showInfo(tui, 'goal.help.title', t('goal.help'));
}

function getCurrentTask(tui: OpenDeskTUI) {
    if (!tui.activeTaskId) return undefined;
    return tui.taskManagerState.getTask(tui.activeTaskId);
}

function showResult(
    tui: OpenDeskTUI,
    result: { ok: boolean; messageKey?: string; messageArgs?: Record<string, unknown>; errorCode?: string }
): void {
    if (result.ok) return;
    if (result.messageKey === 'goal.help') {
        showHelp(tui);
        return;
    }
    showInfo(
        tui,
        'goal.error.title',
        t(result.messageKey ?? 'goal.error.unknown', result.messageArgs as Record<string, string | number> | undefined)
    );
}

function createGoalInput(objective: string, flags: GoalFlags) {
    return {
        objective,
        source: 'tui' as const,
        tokenBudget:
            typeof flags.tokenBudget === 'number'
                ? { maxTotalTokens: flags.tokenBudget, usedTotalTokens: 0 }
                : undefined,
        maxAttempts: typeof flags.maxAttempts === 'number' ? flags.maxAttempts : undefined
    };
}

function confirmReplaceGoal(tui: OpenDeskTUI, task: NonNullable<ReturnType<typeof getCurrentTask>>): Promise<boolean> {
    return new Promise((resolve) => {
        const confirm = new ConfirmOverlay(tui, {
            title: t('goal.replace.title'),
            message: t('goal.replace.message', { objective: task.goal_state?.objective ?? '' }),
            confirmLabel: t('goal.replace.confirm'),
            cancelLabel: t('common.cancel')
        });
        confirm.show(
            () => resolve(true),
            () => resolve(false)
        );
    });
}

function followStartedGoalTask(
    tui: OpenDeskTUI,
    task: ReturnType<typeof getCurrentTask>,
    result: { ok: boolean; startedScheduler?: boolean }
): void {
    if (result.ok && result.startedScheduler && task) {
        tui.followRunningTask(task);
    }
}

async function createGoal(
    tui: OpenDeskTUI,
    task: NonNullable<ReturnType<typeof getCurrentTask>>,
    objective: string,
    flags: GoalFlags
): Promise<void> {
    const result = await GoalService.create(task, createGoalInput(objective, flags));
    showResult(tui, result);
    followStartedGoalTask(tui, task, result);
}

async function replaceGoalAfterConfirmation(
    tui: OpenDeskTUI,
    task: NonNullable<ReturnType<typeof getCurrentTask>>,
    objective: string,
    flags: GoalFlags
): Promise<void> {
    const confirmed = await confirmReplaceGoal(tui, task);
    if (!confirmed) return;

    const clearResult = await GoalService.clear(task, 'tui');
    showResult(tui, clearResult);
    if (!clearResult.ok) return;

    await createGoal(tui, task, objective, flags);
}

export function registerGoalCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'goal',
        description: t('goal.description'),
        getArgumentCompletions: (argPrefix: string) => {
            const trimmed = argPrefix.trim();
            if (trimmed.length === 0) return [];
            const firstToken = trimmed.split(/\s+/, 1)[0] ?? '';
            const hasArgumentSeparator = /\s/.test(argPrefix);
            const isCreatingObjective =
                trimmed.length > 0 && !GOAL_SUBCOMMANDS.includes(firstToken) && hasArgumentSeparator;
            if (isCreatingObjective) {
                return getGoalFlagCompletions(argPrefix);
            }
            if (argPrefix.includes(' ') && !argPrefix.endsWith(' ')) return [];
            return GOAL_SUBCOMMANDS.filter((cmd) => cmd.startsWith(trimmed)).map((cmd) => ({
                value: cmd,
                label: cmd,
                description: t(`goal.completion.${cmd}`)
            }));
        },
        execute: async (args: string) => {
            const trimmed = args.trim();

            if (trimmed.length === 0) {
                showHelp(tui);
                return;
            }

            const firstSpace = trimmed.indexOf(' ');
            const subcommand = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
            const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1);
            const isGoalSubcommand = GOAL_SUBCOMMANDS.includes(subcommand);

            if (subcommand === 'help' || subcommand === 'status') {
                showHelp(tui);
                return;
            }

            let task = getCurrentTask(tui);
            if (!task && !isGoalSubcommand) {
                await tui.createNewTask();
                task = getCurrentTask(tui);
            }
            if (!task) {
                showInfo(tui, 'goal.error.title', t('goal.error.no_task'));
                return;
            }

            if (subcommand === 'pause') {
                if (rest.trim().length > 0) {
                    showResult(tui, { ok: false, messageKey: 'goal.pause.unexpected_args' });
                    return;
                }
                const result = await GoalService.pause(task, 'tui');
                showResult(tui, result);
                return;
            }
            if (subcommand === 'resume') {
                if (rest.trim().length > 0) {
                    showResult(tui, { ok: false, messageKey: 'goal.resume.unexpected_args' });
                    return;
                }
                const result = await GoalService.resume(task, { source: 'tui' });
                showResult(tui, result);
                followStartedGoalTask(tui, task, result);
                return;
            }
            if (subcommand === 'clear') {
                const result = await GoalService.clear(task, 'tui');
                showResult(tui, result);
                return;
            }

            // ── 非子命令：create 或确认 replace ─────────────
            const { flags, rest: objective } = parseGoalFlags(trimmed);
            if (objective.trim().length === 0) {
                showHelp(tui);
                return;
            }

            if (hasNonTerminalGoal(task)) {
                await replaceGoalAfterConfirmation(tui, task, objective, flags);
            } else {
                await createGoal(tui, task, objective, flags);
            }
        }
    });
}
