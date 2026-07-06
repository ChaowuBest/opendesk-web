import type { OpenDeskTUI } from '../entry.js';
import { logger } from '../../utils/logger.js';
import { t } from '../../../locale/index.js';

export function registerRenameCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'rename',
        description: t('rename.usage'),
        execute: async (args: string) => {
            const newName = args.trim();
            if (!newName) {
                logger.warn(t('rename.usage'));
                return;
            }

            // 无活跃任务时，预设任务名称（新任务创建时会自动使用）
            if (!tui.activeTaskId) {
                tui.pendingTaskName = newName;
                logger.info(`${t('rename.preset')}${newName}`);
                tui.syncTaskName();
                tui.tui.requestRender();
                return;
            }

            const currentTask = tui.taskManagerState.getTask(tui.activeTaskId);
            if (!currentTask) {
                logger.warn(t('rename.task.not.found'));
                return;
            }

            currentTask.rename(newName);
            logger.info(`${t('rename.success')}${newName}`);
            tui.syncTaskName();
            tui.tui.requestRender();
        }
    });
}
