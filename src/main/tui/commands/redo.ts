import type { OpenDeskTUI } from '../entry.js';
import { InfoOverlay } from '../components/notice.js';
import { logger } from '../../utils/logger.js';
import { t } from '../../../locale/index.js';

export function registerRedoCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'redo',
        description: t('redo.description'),
        getArgumentCompletions: (argPrefix: string) => {
            const prefix = argPrefix.trim();
            if (!prefix) {
                return [
                    { value: '1', label: '1', description: t('redo.redomsg', { count: 1 }) },
                    { value: '2', label: '2', description: t('redo.redomsg', { count: 2 }) },
                    { value: '3', label: '3', description: t('redo.redomsg', { count: 3 }) }
                ];
            }
            return null;
        },
        execute: async (args: string) => {
            const trimmed = args.trim();
            const count = trimmed === '' ? 1 : Number(trimmed);

            if (isNaN(count) || !Number.isInteger(count)) {
                const info = new InfoOverlay(tui, {
                    title: t('redo.fail'),
                    message: t('redo.error.not.integer')
                });
                info.show();
                return;
            }

            if (count < 1) {
                const info = new InfoOverlay(tui, {
                    title: t('redo.fail'),
                    message: t('redo.error.count.zero')
                });
                info.show();
                return;
            }

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

            // 实际可恢复的次数
            const actualCount = Math.min(count, stack.length);
            const requestedCount = count;
            let totalRestored = 0;

            // 恢复指定次数的消息
            for (let i = 0; i < actualCount; i++) {
                const restored = stack.pop()!;
                task.redoMessages(restored, 'tui');
                totalRestored += restored.length;
            }

            tui.taskView.clearMessages();
            tui.taskView.rebuildFromHistory();
            tui.tui.requestRender();

            logger.info(`/redo: Restored ${actualCount} times, total ${totalRestored} messages`);

            // 如果请求的次数超过可用，显示警告
            if (requestedCount > actualCount) {
                const info = new InfoOverlay(tui, {
                    title: t('redo.partial'),
                    message: t('redo.error.partial', { requested: requestedCount, actual: actualCount }),
                    type: 'warning'
                });
                info.show();
            }
        }
    });
}
