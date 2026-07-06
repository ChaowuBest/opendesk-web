import type { OpenDeskTUI } from '../entry.js';
import { InfoOverlay } from '../components/notice.js';
import { UndoOverlay, getUndoableUserMessages } from '../components/undo.js';
import { t } from '../../../locale/index.js';

export function registerUndoCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'undo',
        description: t('undo.description'),
        getArgumentCompletions: () => [],
        execute: async () => {
            if (!tui.activeTaskId) {
                const info = new InfoOverlay(tui, {
                    title: t('undo.fail'),
                    message: t('undo.error.no.session')
                });
                info.show();
                return;
            }

            const task = tui.taskManagerState.getTask(tui.activeTaskId);
            if (!task) {
                const info = new InfoOverlay(tui, {
                    title: t('undo.fail'),
                    message: t('undo.error.task.notfound')
                });
                info.show();
                return;
            }

            const userMessages = getUndoableUserMessages(task);
            if (userMessages.length === 0) {
                const info = new InfoOverlay(tui, {
                    title: t('undo.fail'),
                    message: t('undo.error.no.messages')
                });
                info.show();
                return;
            }

            new UndoOverlay(tui, task).show();
        }
    });
}
