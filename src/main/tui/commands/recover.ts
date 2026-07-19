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
import { ConfirmOverlay, InfoOverlay, ProgressOverlay } from '../components/notice.js';
import { TaskManagerState } from '../../aikernel/states/tasks.js';
import { logger } from '../../utils/logger.js';
import { t } from '../../../locale/index.js';

export function registerRecoverCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'recover',
        description: t('recover.description'),
        execute: async (args: string) => {
            const subCommand = args.trim().toLowerCase();
            if (subCommand === 'tasks') {
                executeRecoverTasks(tui);
            } else {
                const info = new InfoOverlay(tui, {
                    title: t('recover.usage.title'),
                    message: t('recover.usage.message'),
                    closeLabel: t('common.close')
                });
                info.show();
            }
        },
        getArgumentCompletions: (argPrefix: string) => {
            const subCommands = [{ value: 'tasks', label: 'tasks', description: t('recover.tasks.description') }];
            return subCommands
                .filter((sc) => sc.value.startsWith(argPrefix))
                .map((sc) => ({
                    value: sc.value,
                    label: sc.label,
                    description: sc.description
                }));
        }
    });
}

function executeRecoverTasks(tui: OpenDeskTUI): void {
    const confirm = new ConfirmOverlay(tui, {
        title: t('recover.task.title'),
        message: t('recover.task.message'),
        confirmLabel: t('common.rebuild'),
        cancelLabel: t('common.cancel')
    });

    confirm.show(() => {
        const progress = new ProgressOverlay(tui, {
            title: t('recover.task.title'),
            message: t('recover.task.scanning')
        });
        progress.show();

        setTimeout(() => {
            try {
                const recovered = TaskManagerState.rebuildTaskListFromDirectory();
                progress.hide();

                if (recovered && recovered.tasks.length > 0) {
                    tui.taskManagerState.tasks = recovered.tasks;
                    for (const task of tui.taskManagerState.tasks) {
                        task.task_manager_state = tui.taskManagerState;
                    }
                    tui.taskManagerState.publishTaskListUpdate();

                    tui.clearActiveTask();

                    logger.info(`/recover tasks: ${recovered.tasks.length} task(s) recovered`);
                    const info = new InfoOverlay(tui, {
                        title: t('recover.task.complete.title'),
                        message: t('recover.task.complete.message', { count: recovered.tasks.length }),
                        closeLabel: t('common.close')
                    });
                    info.show();
                } else {
                    tui.taskManagerState.tasks = [];
                    tui.clearActiveTask();
                    tui.taskManagerState.publishTaskListUpdate();

                    const info = new InfoOverlay(tui, {
                        title: t('recover.task.empty.title'),
                        message: t('recover.task.empty.message'),
                        closeLabel: t('common.close')
                    });
                    info.show();
                }
            } catch (err) {
                progress.hide();
                const msg = err instanceof Error ? err.message : String(err);
                logger.error(`/recover tasks failed: ${msg}`);
                const info = new InfoOverlay(tui, {
                    title: t('recover.task.failed.title'),
                    message: t('recover.task.failed.message', { message: msg }),
                    closeLabel: t('common.close')
                });
                info.show();
            }
        }, 50);
    });
}
