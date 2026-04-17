import type { OpenDeskTUI } from '../entry.js';
import { InfoOverlay } from '../components/notice.js';
import { t } from '../../../locale/index.js';

export function registerForkCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'fork',
        description: t('fork.description'),
        execute: async () => {
            if (!tui.activeTaskId) {
                const info = new InfoOverlay(tui, {
                    title: t('fork.fail'),
                    message: t('fork.fail.no.task'),
                    closeLabel: t('common.close')
                });
                info.show();
                return;
            }

            const currentTask = tui.taskManagerState.getTask(tui.activeTaskId);
            if (!currentTask) {
                const info = new InfoOverlay(tui, {
                    title: t('fork.fail'),
                    message: t('fork.fail.not.found'),
                    closeLabel: t('common.close')
                });
                info.show();
                return;
            }

            const forkedTask = currentTask.fork();
            tui.switchToTask(forkedTask);

            const info = new InfoOverlay(tui, {
                title: t('fork.success'),
                message: t('fork.success.detail'),
                closeLabel: t('common.close')
            });
            info.show();
        }
    });
}
