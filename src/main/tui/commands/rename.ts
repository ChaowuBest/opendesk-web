import type { OpenDeskTUI } from '../entry.js';
import { logger } from '../../utils/logger.js';
import { t } from '../../../locale/index.js';

export function registerRenameCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'rename',
        description: t('rename.usage'),
        execute: async (args: string) => {
            if (!tui.activeTaskId) {
                logger.warn(t('rename.no.task'));
                return;
            }

            const currentTask = tui.taskManagerState.getTask(tui.activeTaskId);
            if (!currentTask) {
                logger.warn(t('rename.task.not.found'));
                return;
            }

            const newName = args.trim();
            if (!newName) {
                logger.warn(t('rename.usage'));
                return;
            }

            currentTask.rename(newName);
            logger.info(`${t('rename.success')}${newName}`);
            tui.tui.requestRender();
        }
    });
}
