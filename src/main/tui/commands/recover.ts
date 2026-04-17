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
                    tui.taskManagerState.save();
                    tui.taskManagerState.publishTaskListUpdate();

                    tui.clearActiveTask();

                    logger.info(`/recover tasks: ${recovered.tasks.length} task(s) recovered`);
                    const info = new InfoOverlay(tui, {
                        title: 'Rebuild Complete',
                        message: `Recovered ${recovered.tasks.length} tasks.`,
                        closeLabel: t('common.close')
                    });
                    info.show();
                } else {
                    const info = new InfoOverlay(tui, {
                        title: 'Rebuild Result',
                        message: 'No recoverable task files found.',
                        closeLabel: t('common.close')
                    });
                    info.show();
                }
            } catch (err) {
                progress.hide();
                const msg = err instanceof Error ? err.message : String(err);
                logger.error(`/recover tasks failed: ${msg}`);
                const info = new InfoOverlay(tui, {
                    title: 'Rebuild Failed',
                    message: `Error during task list rebuild: ${msg}`,
                    closeLabel: t('common.close')
                });
                info.show();
            }
        }, 50);
    });
}
