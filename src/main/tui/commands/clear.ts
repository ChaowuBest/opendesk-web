import type { OpenDeskTUI } from '../entry.js';
import { ConfirmOverlay } from '../components/notice.js';
import { t } from '../../../locale/index.js';

export function registerClearCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'clear',
        description: t('clear.description'),
        execute: async () => {
            const confirm = new ConfirmOverlay(tui, {
                title: t('confirm.delete.title'),
                message: t('confirm.delete.message'),
                confirmLabel: t('common.delete.all'),
                cancelLabel: t('common.cancel')
            });
            confirm.show(() => {
                tui.taskManagerState.clearAllTasks();
                tui.clearActiveTask();
            });
        }
    });
}
