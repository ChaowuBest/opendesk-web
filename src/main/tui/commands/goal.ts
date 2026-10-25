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
    decideGoalObjectiveAction,
    getGoalSubcommandCompletions,
    goalResultToMessageKey,
    parseGoalCommandArgs,
    validateGoalSubcommandArgs,
    type GoalCommandResultLike,
    type GoalCommandSnapshotLike,
    type GoalEditIfMatch
} from '../../../common/goal/command.js';

type GoalResultWithDisplayEvents = GoalCommandResultLike & {
    summary?: {
        // 与 aikernel GoalRenderSummary 的事件结构对齐，仅声明展示所需字段
        objectiveEvents?: Array<{ type?: string; revision?: number; displayMessageId?: string }>;
        recentEvents?: Array<{ type?: string; revision?: number; displayMessageId?: string }>;
    };
};

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

function confirmEditGoal(
    tui: OpenDeskTUI,
    currentGoal: GoalCommandSnapshotLike,
    nextObjective: string
): Promise<boolean> {
    return new Promise((resolve) => {
        const confirm = new ConfirmOverlay(tui, {
            title: t('goal.edit.title'),
            message: t('goal.edit.message', {
                objective: currentGoal.objective,
                nextObjective
            }),
            confirmLabel: t('goal.edit.confirm'),
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
    if (!result.ok || !task) return;
    if (result.startedScheduler) {
        tui.followRunningTask(task);
    } else {
        tui.syncInputStatusFromTask(task.task_id);
    }
}

type GoalDisplayEvent = {
    type?: string;
    revision?: number;
    displayMessageId?: string;
};

function getLatestGoalDisplayMessageEvent(
    result: GoalResultWithDisplayEvents,
    type: 'create' | 'edit'
): GoalDisplayEvent | undefined {
    const events =
        result.summary?.objectiveEvents && result.summary.objectiveEvents.length > 0
            ? result.summary.objectiveEvents
            : (result.summary?.recentEvents ?? []);
    const expectedType = type === 'create' ? 'created' : 'edited';

    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (!event || event.type !== expectedType) {
            continue;
        }
        const messageId = event.displayMessageId;
        if (typeof messageId === 'string' && messageId.length > 0 && typeof event.revision === 'number') {
            return { type: event.type, revision: event.revision, displayMessageId: messageId };
        }
    }
    return undefined;
}

function syncGoalDisplayMessage(tui: OpenDeskTUI, result: GoalResultWithDisplayEvents, type: 'create' | 'edit'): void {
    if (result.ok === false) return;
    const event = getLatestGoalDisplayMessageEvent(result, type);
    const messageId = event?.displayMessageId ?? '';
    if (messageId) {
        tui.taskView.syncUserMessageFromHistory(messageId);
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
    const result = await GoalService.create(task, createGoalInput(objective), { projectDisplayMessage: true });
    showResult(tui, result);
    syncGoalDisplayMessage(tui, result, 'create');
    followStartedGoalTask(tui, task, result);
}

async function editGoalAfterConfirmation(
    tui: OpenDeskTUI,
    task: NonNullable<ReturnType<typeof getCurrentTask>>,
    objective: string,
    currentGoal: GoalCommandSnapshotLike,
    ifMatch: GoalEditIfMatch
): Promise<void> {
    const confirmed = await confirmEditGoal(tui, currentGoal, objective);
    if (!confirmed) return;
    if (tui.activeTaskId !== task.task_id) {
        showInfo(tui, 'goal.edit.title', t('goal.edit.task_changed'));
        return;
    }

    const result = await GoalService.edit(task, objective, 'tui', {
        projectDisplayMessage: true,
        ifMatch
    });
    showResult(tui, result);
    syncGoalDisplayMessage(tui, result, 'edit');
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
                if (validation.ok === false) {
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
                    if (task.goal_state?.status === 'complete') {
                        showResult(tui, {
                            ok: false,
                            status: task.goal_state.status,
                            messageKey: 'goal.clear.complete',
                            errorCode: 'goal_complete'
                        } as GoalCommandResultLike);
                        return;
                    }
                    const result = await GoalService.clear(task, 'tui');
                    showResult(tui, result);
                    if (result.ok && result.clearedActiveGoal === true) {
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

            const action = decideGoalObjectiveAction(task.goal_state, objective);
            if (action.kind === 'create') {
                await createGoal(tui, task, objective);
            } else if (action.kind === 'edit') {
                await editGoalAfterConfirmation(tui, task, objective, action.currentGoal, action.ifMatch);
            }
        }
    });
}
