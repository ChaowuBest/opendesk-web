import type { OpenDeskTUI } from '../entry.js';
import { InfoOverlay } from '../components/notice.js';
import { getUserMessageDraftText } from '../components/undo.js';
import { logger } from '../../utils/logger.js';
import { t } from '../../../locale/index.js';

export function registerRedoCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'redo',
        description: t('redo.description'),
        getArgumentCompletions: () => [],
        execute: async () => {
            if (!tui.activeTaskId) {
                const info = new InfoOverlay(tui, {
                    title: t('redo.fail'),
                    message: t('redo.error.no.session')
                });
                info.show();
                return;
            }

            const task = tui.taskManagerState.getTask(tui.activeTaskId);
            if (!task) {
                const info = new InfoOverlay(tui, {
                    title: t('redo.fail'),
                    message: t('redo.error.task.notfound')
                });
                info.show();
                return;
            }

            const stack = tui.undoStacks.get(tui.activeTaskId);
            if (!stack || stack.length === 0) {
                const info = new InfoOverlay(tui, {
                    title: t('redo.fail'),
                    message: t('redo.error.no.records')
                });
                info.show();
                return;
            }

            const restored = stack.pop()!;
            task.redoMessages(restored, 'tui');

            const restoredUserMessage = restored.find((message) => message.role === 'user');
            const restoredInputText = restoredUserMessage ? getUserMessageDraftText(restoredUserMessage) : undefined;
            const input = tui.inputArea.input;
            if (restoredInputText !== undefined && input.getText() === restoredInputText) {
                input.setText('');
            }

            tui.taskView.clearMessages();
            tui.taskView.rebuildFromHistory();
            tui.tui.requestRender();

            logger.info(`/redo: Restored ${restored.length} messages`);
        }
    });
}
