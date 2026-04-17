import type { OpenDeskTUI } from '../entry.js';
import { InfoOverlay } from '../components/notice.js';
import { logger } from '../../utils/logger.js';
import { t } from '../../../locale/index.js';

export function registerCompactCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'compact',
        description: t('compact.description'),
        execute: async () => {
            if (tui.taskView.isCompacting) {
                return;
            }

            if (!tui.activeTaskId) {
                logger.warn(t('compact.no.task'));
                return;
            }

            const currentTask = tui.taskManagerState.getTask(tui.activeTaskId);
            if (!currentTask) {
                logger.warn(t('compact.task.not.found'));
                return;
            }

            try {
                await tui.taskView.performCompactWithAnimation();
                tui.taskManagerState.save();

                tui.taskView.clearMessages();
                tui.taskView.rebuildFromHistory();
                tui.tui.requestRender();

                const info = new InfoOverlay(tui, {
                    title: t('compact.title'),
                    message: t('compact.success'),
                    closeLabel: t('common.close')
                });
                info.show();
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.error(`Compact failed: ${msg}`);
                const info = new InfoOverlay(tui, {
                    title: t('compact.fail'),
                    message: `${t('compact.fail.detail')}${msg}`,
                    closeLabel: t('common.close')
                });
                info.show();
            }
        }
    });
}
