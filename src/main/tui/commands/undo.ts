import type { OpenDeskTUI } from '../entry.js';
import { InfoOverlay } from '../components/notice.js';
import { logger } from '../../utils/logger.js';
import { t } from '../../../locale/index.js';

export function registerUndoCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'undo',
        description: t('undo.description'),
        getArgumentCompletions: (argPrefix: string) => {
            const prefix = argPrefix.trim();
            if (!prefix) {
                return [
                    { value: '1', label: '1', description: t('undo.undomsg', { count: 1 }) },
                    { value: '2', label: '2', description: t('undo.undomsg', { count: 2 }) },
                    { value: '3', label: '3', description: t('undo.undomsg', { count: 3 }) }
                ];
            }
            return null;
        },
        execute: async (args: string) => {
            const trimmed = args.trim();
            const count = trimmed === '' ? 1 : Number(trimmed);

            if (isNaN(count) || !Number.isInteger(count)) {
                const info = new InfoOverlay(tui, {
                    title: t('undo.fail'),
                    message: t('undo.error.not.integer')
                });
                info.show();
                return;
            }

            if (count < 1) {
                const info = new InfoOverlay(tui, {
                    title: t('undo.fail'),
                    message: t('undo.error.count.zero')
                });
                info.show();
                return;
            }

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

            const messages = task.chat_context.messages;
            if (messages.length === 0) {
                const info = new InfoOverlay(tui, {
                    title: t('undo.fail'),
                    message: t('undo.error.no.messages')
                });
                info.show();
                return;
            }

            // 如果请求的回退数量超过可用消息数，则只回退可用的消息数
            const actualCount = Math.min(count, messages.length);
            const requestedCount = count;

            // 执行回退操作
            const removed = messages.splice(messages.length - actualCount, actualCount);
            tui.taskView.taskState!._dirty = true;
            tui.taskManagerState.save();

            // 将被移除的消息推入当前任务的 undo stack，以便 /redo 恢复
            const taskId = tui.activeTaskId;
            if (!tui.undoStacks.has(taskId)) {
                tui.undoStacks.set(taskId, []);
            }
            tui.undoStacks.get(taskId)!.push(removed);

            tui.taskView.clearMessages();
            tui.taskView.rebuildFromHistory();
            tui.tui.requestRender();

            const roles = removed.map((m) => ((m as any).role === 'user' ? 'User' : 'Assistant'));
            logger.info(`/undo: Undone ${removed.length} messages (${roles.join(', ')})`);

            // 如果请求的数量超过可用，显示警告
            if (requestedCount > actualCount) {
                const info = new InfoOverlay(tui, {
                    title: t('undo.partial'),
                    message: t('undo.error.partial', { requested: requestedCount, actual: actualCount }),
                    type: 'warning'
                });
                info.show();
            }
        }
    });
}
