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
import { t } from '../../../locale/index.js';
import {
    getGoalSubcommandCompletions,
    goalResultToMessageKey,
    isTerminalGoalStatus,
    parseGoalCommandArgs,
    validateGoalSubcommandArgs,
    type GoalCommandResultLike
} from '../../../common/goal-command.js';

/** 检查 goal 是否有未终结状态，用于新 goal 的替换确认。 */
function hasNonTerminalGoal(task: ReturnType<typeof getCurrentTask>): boolean {
    return !!task?.goal_state && !isTerminalGoalStatus(task.goal_state.status);
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

function showResult(tui: OpenDeskTUI, result: GoalCommandResultLike): void {
    const message = goalResultToMessageKey(result);
    if (!message) return;
    if (message.messageKey === 'goal.help') {
        showHelp(tui);
        return;
    }
    showInfo(
        tui,
        'goal.error.title',
        t(message.messageKey, message.messageArgs as Record<string, string | number> | undefined)
    );
}

function createGoalInput(objective: string) {
    return {
        objective,
        source: 'tui' as const
    };
}

function confirmEditGoal(tui: OpenDeskTUI, task: NonNullable<ReturnType<typeof getCurrentTask>>): Promise<boolean> {
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

function clearInputQueueForTask(tui: OpenDeskTUI, task: NonNullable<ReturnType<typeof getCurrentTask>>): void {
    task.message_queue = [];
    if (tui.activeTaskId === task.task_id) {
        tui.inputArea.clearMessageQueue();
    }
}

async function createGoal(
    tui: OpenDeskTUI,
    task: NonNullable<ReturnType<typeof getCurrentTask>>,
    objective: string
): Promise<void> {
    const result = await GoalService.create(task, createGoalInput(objective));
    showResult(tui, result);
    followStartedGoalTask(tui, task, result);
}

async function editGoalAfterConfirmation(
    tui: OpenDeskTUI,
    task: NonNullable<ReturnType<typeof getCurrentTask>>,
    objective: string
): Promise<void> {
    const confirmed = await confirmEditGoal(tui, task);
    if (!confirmed) return;

    const result = await GoalService.edit(task, objective, 'tui');
    showResult(tui, result);
    followStartedGoalTask(tui, task, result);
}

export function registerGoalCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'goal',
        description: t('goal.description'),
        getArgumentCompletions: (argPrefix: string) => {
            return getGoalSubcommandCompletions(argPrefix).map((cmd) => ({
                value: cmd,
                label: cmd,
                description: t(`goal.completion.${cmd}`)
            }));
        },
        execute: async (args: string) => {
            const command = parseGoalCommandArgs(args);

            if (command.kind === 'help') {
                showHelp(tui);
                return;
            }

            let task = getCurrentTask(tui);
            if (!task && command.kind === 'objective') {
                await tui.createNewTask();
                task = getCurrentTask(tui);
            }
            if (!task) {
                showInfo(tui, 'goal.error.title', t('goal.error.no_task'));
                return;
            }

            if (command.kind === 'subcommand') {
                const validation = validateGoalSubcommandArgs(command.subcommand, command.rest);
                if (!validation.ok) {
                    showResult(tui, { ok: false, messageKey: validation.messageKey });
                    return;
                }

                if (command.subcommand === 'pause') {
                    const result = await GoalService.pause(task, 'tui');
                    showResult(tui, result);
                    return;
                }
                if (command.subcommand === 'resume') {
                    const result = await GoalService.resume(task, { source: 'tui' });
                    showResult(tui, result);
                    followStartedGoalTask(tui, task, result);
                    return;
                }
                if (command.subcommand === 'clear') {
                    const result = await GoalService.clear(task, 'tui');
                    showResult(tui, result);
                    if (result.ok) {
                        clearInputQueueForTask(tui, task);
                    }
                    return;
                }
                return;
            }

            // ── 非子命令：create 或确认 edit ─────────────
            const objective = command.objective;
            if (objective.trim().length === 0) {
                showHelp(tui);
                return;
            }

            if (hasNonTerminalGoal(task)) {
                await editGoalAfterConfirmation(tui, task, objective);
            } else {
                await createGoal(tui, task, objective);
            }
        }
    });
}
