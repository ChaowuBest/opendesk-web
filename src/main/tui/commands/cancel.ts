import type { OpenDeskTUI } from '../entry.js';
import { t } from '../../../locale/index.js';

export function registerCancelCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'cancel',
        description: t('cancel.description'),
        execute: async () => {
            tui.inputArea.clearMessageQueue();
            if (tui.activeTaskId) {
                const currentTask = tui.taskManagerState.getTask(tui.activeTaskId);
                if (currentTask) {
                    currentTask.message_queue = tui.inputArea.getQueueSnapshot();
                }
            }
        }
    });
}
