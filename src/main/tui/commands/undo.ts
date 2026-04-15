import type { OpenDeskTUI } from '../entry.js';
import { InfoOverlay } from '../components/notice.js';
import { logger } from '../../utils/logger.js';

export function registerUndoCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'undo',
        description: '回退当前会话中的最近 N 条消息，默认 1 条（可用 /redo 恢复）',
        getArgumentCompletions: (argPrefix: string) => {
            const prefix = argPrefix.trim();
            if (!prefix) {
                return [
                    { value: '1', label: '1', description: '回退最近 1 条消息' },
                    { value: '2', label: '2', description: '回退最近 2 条消息' },
                    { value: '3', label: '3', description: '回退最近 3 条消息' }
                ];
            }
            return null;
        },
        execute: async (args: string) => {
            const trimmed = args.trim();
            const count = trimmed === '' ? 1 : Number(trimmed);

            if (isNaN(count) || !Number.isInteger(count)) {
                const info = new InfoOverlay(tui, {
                    title: '回退失败',
                    message: `参数必须是一个整数，例如：/undo 2`
                });
                info.show();
                return;
            }

            if (count < 1) {
                const info = new InfoOverlay(tui, {
                    title: '回退失败',
                    message: `回退数量必须大于 0，当前输入：${count}`
                });
                info.show();
                return;
            }

            if (!tui.activeTaskId) {
                const info = new InfoOverlay(tui, {
                    title: '回退失败',
                    message: '当前没有活跃的会话，请先开始一个对话。'
                });
                info.show();
                return;
            }

            const task = tui.taskManagerState.getTask(tui.activeTaskId);
            if (!task) {
                const info = new InfoOverlay(tui, {
                    title: '回退失败',
                    message: '未找到当前任务。'
                });
                info.show();
                return;
            }

            const messages = task.chat_context.messages;
            if (messages.length === 0) {
                const info = new InfoOverlay(tui, {
                    title: '回退失败',
                    message: '当前会话中没有可回退的消息。'
                });
                info.show();
                return;
            }

            // 如果请求的回退数量超过可用消息数，则只回退可用的消息数
            const actualCount = Math.min(count, messages.length);
            const requestedCount = count;

            // 执行回退操作
            const removed = messages.splice(messages.length - actualCount, actualCount);
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

            const roles = removed.map((m) => ((m as any).role === 'user' ? '用户' : '助手'));
            logger.info(`/undo: 已回退 ${removed.length} 条消息 (${roles.join(', ')})`);

            // 如果请求的数量超过可用，显示警告
            if (requestedCount > actualCount) {
                const info = new InfoOverlay(tui, {
                    title: '回退数量不足',
                    message: `请求回退 ${requestedCount} 条，但实际只有 ${actualCount} 条消息可供回退。已回退 ${actualCount} 条。`,
                    type: 'warning'
                });
                info.show();
            }
        }
    });
}
